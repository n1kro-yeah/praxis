/**
 * The agentic loop.
 *
 * This is the centre of the program. Everything else exists to serve it: the
 * providers give it a model, the tools give it hands, the permission engine gives
 * it boundaries, the storage layer gives it memory. The loop itself is small in
 * concept and unavoidably detailed in practice.
 *
 * The shape:
 *
 *   1. Persist the user's message.
 *   2. Snapshot the filesystem so the turn can be undone.
 *   3. Build the conversation, fitting it into the context window.
 *   4. Resolve the tool set for this agent and model.
 *   5. Stream a completion.
 *   6. Execute every tool call the model made, in parallel where safe.
 *   7. If the model stopped because it wanted tools, go to 3. Otherwise finish.
 *
 * Almost all the difficulty is in the details that keep step 5–6 from going wrong:
 *
 *  - **Abort must be immediate and clean.** A user pressing Escape expects the
 *    stream to stop now, running tools to be cancelled, and the partial response
 *    to be kept rather than discarded. Every await in here is abort-aware.
 *  - **A tool failure is data, not an exception.** A model that gets "file not
 *    found" learns and adapts; a model whose turn is aborted learns nothing. So
 *    tool errors are returned to the model as tool results.
 *  - **Parallelism is opt-in per tool.** Two reads can run together. Two edits to
 *    the same file cannot. The registry declares which tools are concurrent-safe
 *    and this loop respects it.
 *  - **Loop protection is mandatory.** Models get stuck calling the same tool with
 *    the same arguments. Without detection this burns money until the user notices.
 *  - **Every turn has a step budget.** A runaway agent must terminate on its own.
 */

import { logger } from "../util/log.js"
import { Bus, Events } from "../util/bus.js"
import { AbortedError, isAbortError } from "../util/error.js"
import { newId } from "../util/id.js"
import { estimateTokens } from "../util/tokenizer.js"
import { stream as streamCompletion } from "../llm/stream.js"
import { resolveModel } from "../provider/registry.js"
import { usageCost } from "../provider/cost.js"
import { buildSystemPrompt } from "../prompt/system.js"
import { buildConversation } from "../prompt/context.js"
import { collectReminders, renderReminders } from "../prompt/reminders.js"
import { resolveTools, executeTool, recordCall, resetLoop, toolSchemas } from "../tool/registry.js"
import { permissionEngine } from "../permission/engine.js"
import { diagnosticsAfterEdit } from "../tool/lsp.js"
import { lspRegistry } from "../lsp/registry.js"
import { agentByName } from "../agent/agent.js"
import type { Content, StreamEvent, ToolSchema } from "../llm/types.js"
import type { MessageRecord, TokenUsage } from "./types.js"
import * as Session from "./session.js"
import { maybeCompact } from "./compaction.js"
import { generateTitle } from "./title.js"

const log = logger("session.loop")

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface PromptInput {
  readonly sessionId: string
  /** The user's text. */
  readonly text: string
  /** Files the user attached, already read. */
  readonly attachments?: ReadonlyArray<{
    readonly kind: "file" | "image"
    readonly path?: string
    readonly filename?: string
    readonly mediaType?: string
    readonly text?: string
    readonly data?: string
  }>
  /** Override the session's agent for this turn only, e.g. plan mode. */
  readonly agent?: string
  /** Override the session's model for this turn only. */
  readonly model?: string
  readonly signal?: AbortSignal
  /** Set for subagent runs so nested delegation can be capped. */
  readonly depth?: number
  readonly onEvent?: (event: LoopEvent) => void
}

export type LoopEvent =
  | { type: "step-start"; step: number }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool-start"; toolCallId: string; tool: string; input: unknown }
  | { type: "tool-progress"; toolCallId: string; metadata: Record<string, unknown> }
  | { type: "tool-end"; toolCallId: string; tool: string; title: string; isError: boolean }
  | { type: "usage"; usage: TokenUsage; cost: number }
  | { type: "finish"; reason: string }
  | { type: "error"; message: string }

export interface PromptResult {
  readonly sessionId: string
  readonly messageId: string
  readonly text: string
  readonly steps: number
  readonly toolCalls: number
  readonly usage: TokenUsage
  readonly cost: number
  readonly aborted: boolean
  readonly finishReason: string
  readonly error?: string
  readonly filesChanged: readonly string[]
}

/** Hard cap on iterations within one user turn. */
const MAX_STEPS = 200

/** Consecutive identical tool calls before intervening. */
const DOOM_THRESHOLD = 3

/* ------------------------------------------------------------------ */
/* Active run registry                                                 */
/* ------------------------------------------------------------------ */

interface ActiveRun {
  readonly sessionId: string
  readonly controller: AbortController
  readonly startedAt: number
}

const active = new Map<string, ActiveRun>()

/** Whether a session is mid-turn, used to queue input rather than interleave it. */
export function isRunning(sessionId: string): boolean {
  return active.has(sessionId)
}

/**
 * Interrupts a running turn.
 *
 * Returns whether anything was running. The partial response is preserved: a
 * user who interrupts to correct course still wants to see what was said.
 */
export function abort(sessionId: string): boolean {
  const run = active.get(sessionId)
  if (!run) return false
  run.controller.abort(new AbortedError("Interrupted by the user."))
  return true
}

export function abortAll(): void {
  for (const run of active.values()) {
    run.controller.abort(new AbortedError("Shutting down."))
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Runs one user turn to completion.
 *
 * "One turn" means one user message and everything the assistant does in
 * response, which may be dozens of model calls and hundreds of tool calls. It
 * returns when the model produces a response without tool calls, when the step
 * budget is exhausted, or when it is aborted.
 */
export async function prompt(input: PromptInput): Promise<PromptResult> {
  const session = Session.get(input.sessionId)

  if (active.has(input.sessionId)) {
    throw new Error("That session is already generating a response.")
  }

  const controller = new AbortController()
  // Chain the caller's signal so both the caller and `abort()` can stop the run.
  if (input.signal) {
    if (input.signal.aborted) throw new AbortedError("Aborted before starting.")
    input.signal.addEventListener("abort", () => controller.abort(input.signal!.reason), {
      once: true,
    })
  }

  active.set(input.sessionId, {
    sessionId: input.sessionId,
    controller,
    startedAt: Date.now(),
  })

  resetLoop(input.sessionId)

  try {
    return await run(input, session, controller)
  } finally {
    active.delete(input.sessionId)
  }
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

async function run(
  input: PromptInput,
  session: ReturnType<typeof Session.get>,
  controller: AbortController,
): Promise<PromptResult> {
  const emit = input.onEvent ?? (() => undefined)
  const agentName = input.agent ?? session.agent
  const agent = agentByName(agentName)
  const depth = input.depth ?? session.depth

  /* ---- Persist the user's message ---- */

  const userMessage = Session.beginMessage({
    sessionId: session.id,
    role: "user",
    agent: agentName,
  })

  Session.appendPart({
    sessionId: session.id,
    messageId: userMessage.id,
    type: "text",
    text: input.text,
  })

  for (const attachment of input.attachments ?? []) {
    Session.appendPart({
      sessionId: session.id,
      messageId: userMessage.id,
      type: attachment.kind === "image" ? "image" : "file",
      text: attachment.text,
      metadata: {
        path: attachment.path,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        data: attachment.data,
      },
    })
  }

  Session.completeMessage(userMessage.id, {})

  // A provisional title immediately, a generated one later. The session list must
  // never show a blank row.
  if (session.title === "") {
    Session.rename(session.id, Session.provisionalTitle(input.text))
  }

  /* ---- Snapshot for undo ---- */

  // Deliberately not awaited before the first model call: snapshotting a large
  // repository takes a moment and the user should not wait for it. The promise is
  // awaited before the first edit instead, which is the only point where it
  // matters.
  const snapshotPromise = Session.snapshot(
    session.id,
    userMessage.id,
    Session.provisionalTitle(input.text),
  )

  /* ---- Resolve the model ---- */

  const modelId = input.model ?? session.model ?? agent.model
  const model = await resolveModel(modelId)

  if (!model) {
    const message = modelId
      ? `No provider is configured for ${modelId}. Run \`praxis auth login\` or set a model in the configuration.`
      : "No model is configured. Run `praxis auth login` to add a provider."
    emit({ type: "error", message })
    return errorResult(session.id, userMessage.id, message)
  }

  /* ---- Turn state ---- */

  const assistantMessage = Session.beginMessage({
    sessionId: session.id,
    role: "assistant",
    model: model.id,
    agent: agentName,
  })

  let step = 0
  let toolCallCount = 0
  let finishReason = "stop"
  let aborted = false
  let errorMessage: string | undefined
  let assembledText = ""
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let cost = 0
  const filesChanged = new Set<string>()
  /** Tool results produced in the previous step, fed back on the next. */
  let pendingResults: Content[] = []
  /** Reminders queued by tools or the loop, injected once and cleared. */
  const pendingReminders: string[] = []
  let snapshotResolved = false

  const tools = await resolveTools({
    model,
    agent,
    cwd: session.cwd,
    sessionId: session.id,
    depth,
  })

  const schemas: ToolSchema[] = toolSchemas(tools)

  log.info("turn started", {
    sessionId: session.id,
    model: model.id,
    agent: agentName,
    tools: schemas.length,
  })

  /* ---- Step loop ---- */

  while (step < MAX_STEPS) {
    if (controller.signal.aborted) {
      aborted = true
      finishReason = "abort"
      break
    }

    step++
    emit({ type: "step-start", step })

    /* Compaction check. Done before building the conversation so the summary is
     * what gets built, not the thing that overflows. */
    const compacted = await maybeCompact({
      sessionId: session.id,
      model,
      signal: controller.signal,
    })
    if (compacted) {
      pendingReminders.push(
        "The conversation was summarised because it exceeded the context window. Earlier details are condensed; re-read files if you need their exact contents.",
      )
    }

    /* Build the request. */
    const reminders = [
      ...collectReminders({
        sessionId: session.id,
        cwd: session.cwd,
        agent: agentName,
        step,
      }),
      ...pendingReminders.splice(0).map((text) => ({ priority: 90, text })),
    ]

    const conversation = await buildConversation({
      sessionId: session.id,
      model,
      reminders: renderReminders(reminders),
      extraResults: pendingResults,
    })

    pendingResults = []

    const system = await buildSystemPrompt({
      model,
      agent,
      cwd: session.cwd,
      sessionId: session.id,
      tools: tools.map((tool) => tool.id),
    })

    /* Stream. */
    const assistantParts = new Map<string, string>()
    let textPartId: string | undefined
    let reasoningPartId: string | undefined
    const calls: Array<{ id: string; name: string; input: unknown }> = []
    let stepFinish = "stop"

    try {
      const events = streamCompletion({
        model,
        system,
        messages: conversation.messages,
        tools: schemas,
        signal: controller.signal,
        sessionId: session.id,
        messageId: assistantMessage.id,
        temperature: agent.temperature,
        topP: agent.topP,
        maxOutputTokens: agent.maxOutputTokens,
        reasoningEffort: agent.reasoningEffort,
      })

      for await (const event of events) {
        if (controller.signal.aborted) break
        handleStreamEvent(event)
      }
    } catch (error) {
      if (isAbortError(error)) {
        aborted = true
        finishReason = "abort"
        break
      }

      errorMessage = error instanceof Error ? error.message : String(error)
      log.error("stream failed", { error: errorMessage })
      emit({ type: "error", message: errorMessage })
      finishReason = "error"
      break
    }

    function handleStreamEvent(event: StreamEvent): void {
      switch (event.type) {
        case "text-delta": {
          if (!textPartId) {
            const part = Session.appendPart({
              sessionId: session.id,
              messageId: assistantMessage.id,
              type: "text",
              text: "",
            })
            textPartId = part.id
            assistantParts.set(part.id, "")
          }
          const next = (assistantParts.get(textPartId) ?? "") + event.text
          assistantParts.set(textPartId, next)
          assembledText += event.text
          Session.appendText(textPartId, event.text)
          emit({ type: "text", delta: event.text })
          break
        }

        case "reasoning-delta": {
          // Reasoning is stored separately and never fed back verbatim to a
          // different provider: encrypted reasoning blocks are provider-specific
          // and sending one to the wrong endpoint is an error.
          if (!reasoningPartId) {
            const part = Session.appendPart({
              sessionId: session.id,
              messageId: assistantMessage.id,
              type: "reasoning",
              text: "",
            })
            reasoningPartId = part.id
          }
          Session.appendText(reasoningPartId, event.text)
          emit({ type: "reasoning", delta: event.text })
          break
        }

        case "tool-call": {
          calls.push({ id: event.toolCallId, name: event.toolName, input: event.input })
          break
        }

        case "usage": {
          usage.input += event.usage.input ?? 0
          usage.output += event.usage.output ?? 0
          usage.cacheRead = (usage.cacheRead ?? 0) + (event.usage.cacheRead ?? 0)
          usage.cacheWrite = (usage.cacheWrite ?? 0) + (event.usage.cacheWrite ?? 0)
          usage.reasoning = (usage.reasoning ?? 0) + (event.usage.reasoning ?? 0)
          const stepCost = usageCost(model, event.usage)
          cost += stepCost
          emit({ type: "usage", usage: event.usage, cost: stepCost })
          break
        }

        case "finish": {
          stepFinish = event.reason
          break
        }

        case "error": {
          errorMessage = event.message
          break
        }

        default:
          break
      }
    }

    // Close the streamed text parts so the UI stops showing a cursor.
    if (textPartId) Session.completePart(textPartId)
    if (reasoningPartId) Session.completePart(reasoningPartId)

    if (controller.signal.aborted) {
      aborted = true
      finishReason = "abort"
      break
    }

    /* No tool calls: the turn is over. */
    if (calls.length === 0) {
      finishReason = stepFinish
      break
    }

    /* Ensure the snapshot completed before the first mutation. */
    if (!snapshotResolved && calls.some((call) => MUTATING_TOOLS.has(call.name))) {
      await snapshotPromise
      snapshotResolved = true
    }

    /* Execute tool calls. */
    toolCallCount += calls.length

    const results = await executeCalls({
      calls,
      tools,
      session,
      agentName,
      messageId: assistantMessage.id,
      depth,
      model,
      controller,
      emit,
      filesChanged,
      reminders: pendingReminders,
    })

    pendingResults = results

    /* Post-edit diagnostics. */
    const editedPaths = [...filesChanged].filter((path) => recentlyEdited(path, results))
    if (editedPaths.length > 0) {
      const feedback = await diagnosticsAfterEdit(editedPaths, session.cwd).catch(() => undefined)
      if (feedback) pendingReminders.push(feedback)
    }

    finishReason = "tool-calls"
  }

  if (step >= MAX_STEPS) {
    finishReason = "step-limit"
    pendingReminders.length = 0
    Session.appendPart({
      sessionId: session.id,
      messageId: assistantMessage.id,
      type: "text",
      text: `\n\n[Stopped after ${MAX_STEPS} steps. The task may be incomplete — send another message to continue.]`,
    })
  }

  Session.completeMessage(assistantMessage.id, {
    usage,
    cost,
    finishReason,
    error: errorMessage,
  })

  emit({ type: "finish", reason: finishReason })

  /* Generate a real title once there is something to summarise. */
  if (!session.internal && Session.get(session.id).messageCount <= 3) {
    void generateTitle({ sessionId: session.id, firstMessage: input.text }).catch(() => undefined)
  }

  log.info("turn finished", {
    sessionId: session.id,
    steps: step,
    toolCalls: toolCallCount,
    cost: cost.toFixed(4),
    reason: finishReason,
  })

  return {
    sessionId: session.id,
    messageId: assistantMessage.id,
    text: assembledText,
    steps: step,
    toolCalls: toolCallCount,
    usage,
    cost,
    aborted,
    finishReason,
    error: errorMessage,
    filesChanged: [...filesChanged],
  }
}

/* ------------------------------------------------------------------ */
/* Tool execution                                                      */
/* ------------------------------------------------------------------ */

const MUTATING_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "apply_patch",
  "patch",
  "notebook",
  "bash",
])

interface ExecuteCallsOptions {
  readonly calls: ReadonlyArray<{ id: string; name: string; input: unknown }>
  readonly tools: Awaited<ReturnType<typeof resolveTools>>
  readonly session: ReturnType<typeof Session.get>
  readonly agentName: string
  readonly messageId: string
  readonly depth: number
  readonly model: NonNullable<Awaited<ReturnType<typeof resolveModel>>>
  readonly controller: AbortController
  readonly emit: (event: LoopEvent) => void
  readonly filesChanged: Set<string>
  readonly reminders: string[]
}

/**
 * Runs the tool calls from one step.
 *
 * Grouping is the subtle part. Models routinely emit five reads in one step, and
 * running those serially triples the wall-clock time of a turn. But they also
 * emit two edits to the same file, and running those in parallel corrupts it. So
 * calls are partitioned into runs of consecutive concurrency-safe calls, each run
 * executed in parallel, runs executed in order. Order within the results is
 * restored afterwards because providers require tool results in call order.
 */
async function executeCalls(options: ExecuteCallsOptions): Promise<Content[]> {
  const { calls, tools, session, controller, emit } = options
  const byId = new Map(tools.map((tool) => [tool.id, tool]))
  const results = new Array<Content | undefined>(calls.length)

  const groups: number[][] = []
  let current: number[] = []

  for (let index = 0; index < calls.length; index++) {
    const definition = byId.get(calls[index]!.name)
    const concurrent = definition?.concurrent === true

    if (concurrent) {
      current.push(index)
      continue
    }

    if (current.length > 0) {
      groups.push(current)
      current = []
    }
    groups.push([index])
  }

  if (current.length > 0) groups.push(current)

  for (const group of groups) {
    if (controller.signal.aborted) break

    await Promise.all(
      group.map(async (index) => {
        const call = calls[index]!
        results[index] = await executeOne(call, options)
      }),
    )
  }

  // Any call we did not reach (because of an abort) still needs a result, or the
  // provider will reject the next request for having an unanswered tool call.
  for (let index = 0; index < calls.length; index++) {
    if (results[index]) continue
    results[index] = {
      type: "tool-result",
      toolCallId: calls[index]!.id,
      toolName: calls[index]!.name,
      output: "Cancelled: the user interrupted this turn.",
      isError: true,
    }
    emit({
      type: "tool-end",
      toolCallId: calls[index]!.id,
      tool: calls[index]!.name,
      title: "cancelled",
      isError: true,
    })
  }

  void session
  return results as Content[]
}

/**
 * Executes a single tool call and persists both sides of it.
 *
 * Errors are converted into tool results rather than thrown. This is the single
 * most important decision in the loop: a model that receives "permission denied,
 * the user declined" adjusts its approach, whereas an exception ends the turn and
 * teaches it nothing.
 */
async function executeOne(
  call: { id: string; name: string; input: unknown },
  options: ExecuteCallsOptions,
): Promise<Content> {
  const { session, controller, emit, filesChanged, reminders } = options

  emit({ type: "tool-start", toolCallId: call.id, tool: call.name, input: call.input })

  const part = Session.appendPart({
    sessionId: session.id,
    messageId: options.messageId,
    type: "tool-call",
    toolName: call.name,
    toolCallId: call.id,
    input: call.input,
  })

  Bus.publish(Events.toolCallStarted, {
    sessionId: session.id,
    toolCallId: call.id,
    tool: call.name,
  })

  /* Loop protection. */
  const repeats = recordCall(session.id, call.name, call.input)
  if (repeats >= DOOM_THRESHOLD) {
    const warning = `You have now called \`${call.name}\` ${repeats} times in a row with identical arguments and got the same result each time. Repeating it again will not help. Change your approach: try a different tool, re-read the relevant file, or explain to the user what is blocking you.`
    reminders.push(warning)
    Bus.publish(Events.doomLoopDetected, {
      sessionId: session.id,
      tool: call.name,
      count: repeats,
    })
  }

  const started = Date.now()

  try {
    const result = await executeTool({
      toolId: call.name,
      input: call.input,
      context: {
        sessionId: session.id,
        messageId: options.messageId,
        toolCallId: call.id,
        cwd: session.cwd,
        agent: options.agentName,
        depth: options.depth,
        signal: controller.signal,
        model: options.model,
        metadata: (metadata) => {
          emit({ type: "tool-progress", toolCallId: call.id, metadata })
          Session.completePart(part.id, { metadata })
        },
        requestPermission: async (request) =>
          permissionEngine().request({
            ...request,
            sessionId: session.id,
            cwd: session.cwd,
            agent: options.agentName,
            toolCallId: call.id,
          }),
      },
    })

    /* Track edited files so diagnostics and the diff view know what changed. */
    const changed = extractChangedPaths(call.name, call.input, result.metadata)
    for (const path of changed) {
      filesChanged.add(path)
      void lspRegistry({ cwd: session.cwd }).didSave(path).catch(() => undefined)
      Bus.publish(Events.fileEdited, { sessionId: session.id, path, tool: call.name })
    }

    Session.completePart(part.id, {
      output: result.output,
      metadata: { ...result.metadata, title: result.title, durationMs: Date.now() - started },
      isError: result.isError ?? false,
    })

    Bus.publish(Events.toolCallCompleted, {
      sessionId: session.id,
      toolCallId: call.id,
      tool: call.name,
      durationMs: Date.now() - started,
      isError: result.isError ?? false,
    })

    emit({
      type: "tool-end",
      toolCallId: call.id,
      tool: call.name,
      title: result.title,
      isError: result.isError ?? false,
    })

    return {
      type: "tool-result",
      toolCallId: call.id,
      toolName: call.name,
      output: result.output,
      isError: result.isError ?? false,
      attachments: result.attachments,
    }
  } catch (error) {
    if (isAbortError(error)) {
      Session.completePart(part.id, {
        output: "Cancelled.",
        isError: true,
      })
      return {
        type: "tool-result",
        toolCallId: call.id,
        toolName: call.name,
        output: "Cancelled: the user interrupted this turn.",
        isError: true,
      }
    }

    const message = error instanceof Error ? error.message : String(error)

    log.debug("tool failed", { tool: call.name, error: message })

    Session.completePart(part.id, {
      output: message,
      isError: true,
      metadata: { durationMs: Date.now() - started },
    })

    emit({
      type: "tool-end",
      toolCallId: call.id,
      tool: call.name,
      title: "failed",
      isError: true,
    })

    return {
      type: "tool-result",
      toolCallId: call.id,
      toolName: call.name,
      output: message,
      isError: true,
    }
  }
}

/**
 * Works out which files a tool call modified.
 *
 * Read from metadata when the tool reports it, inferred from the arguments
 * otherwise. Imperfect for `bash` — a shell command can touch anything — which is
 * why the file watcher exists as a second source of truth.
 */
function extractChangedPaths(
  tool: string,
  input: unknown,
  metadata: Record<string, unknown> | undefined,
): string[] {
  const reported = metadata?.["changedPaths"]
  if (Array.isArray(reported)) return reported.filter((entry): entry is string => typeof entry === "string")

  if (!MUTATING_TOOLS.has(tool)) return []

  const record = input as { path?: unknown; paths?: unknown; files?: unknown } | undefined
  const paths: string[] = []

  if (typeof record?.path === "string") paths.push(record.path)
  if (Array.isArray(record?.paths)) {
    for (const entry of record.paths) if (typeof entry === "string") paths.push(entry)
  }
  if (Array.isArray(record?.files)) {
    for (const entry of record.files) {
      const filePath = (entry as { path?: unknown }).path
      if (typeof filePath === "string") paths.push(filePath)
    }
  }

  return paths
}

/** Whether a path was touched by the results of the current step. */
function recentlyEdited(path: string, results: readonly Content[]): boolean {
  return results.some(
    (result) =>
      result.type === "tool-result" &&
      !result.isError &&
      MUTATING_TOOLS.has(result.toolName ?? "") &&
      (result.output ?? "").includes(path.split(/[\\/]/).pop() ?? path),
  )
}

function errorResult(sessionId: string, messageId: string, message: string): PromptResult {
  return {
    sessionId,
    messageId,
    text: "",
    steps: 0,
    toolCalls: 0,
    usage: { input: 0, output: 0 },
    cost: 0,
    aborted: false,
    finishReason: "error",
    error: message,
    filesChanged: [],
  }
}

/* ------------------------------------------------------------------ */
/* Estimation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Estimates the token cost of a turn before running it.
 *
 * Used by the TUI to warn before an expensive request — pasting a 200 000-token
 * file into a frontier model is a real and expensive mistake, and a warning
 * beforehand is worth far more than an accurate bill afterwards.
 */
export function estimateTurn(input: {
  sessionId: string
  text: string
  attachments?: ReadonlyArray<{ text?: string }>
}): { tokens: number; messages: number } {
  const messages = Session.activeMessages(input.sessionId)
  let tokens = estimateTokens(input.text)

  for (const attachment of input.attachments ?? []) {
    if (attachment.text) tokens += estimateTokens(attachment.text)
  }

  for (const message of messages) {
    for (const part of Session.parts(message.id)) {
      if (part.text) tokens += estimateTokens(part.text)
      if (part.output) tokens += estimateTokens(part.output)
    }
  }

  return { tokens, messages: messages.length }
}

/** Messages in a session that produced an error, for the `doctor` command. */
export function failedMessages(sessionId: string): MessageRecord[] {
  return Session.messages(sessionId, { includeHidden: true }).filter((message) => message.error)
}

/** Unique id for a queued prompt, exported for the queue implementation. */
export function queueId(): string {
  return newId("request")
}
