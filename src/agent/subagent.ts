/**
 * Subagent execution.
 *
 * The `task` tool hands work to a fresh agent with its own context window. This
 * is the mechanism that makes large codebases tractable: a search that would
 * otherwise dump forty files into the main conversation instead runs in a child
 * session and comes back as three paragraphs.
 *
 * What makes it worth the complexity:
 *
 *  - **Context isolation.** The child's exploration never touches the parent's
 *    window. The parent pays for the summary, not the search.
 *  - **Model choice per job.** Enumerating files does not need the expensive
 *    model. Subagents can be pinned to the small one, which is often ten times
 *    cheaper and faster for the same result.
 *  - **Permission narrowing.** A child can be strictly less privileged than its
 *    parent, never more. A read-only explorer cannot be talked into writing files
 *    no matter what it finds in them.
 *  - **Parallelism.** Independent investigations run concurrently, which is the
 *    single biggest wall-clock win available to an agent.
 *
 * The hard-won constraints, each from a real failure:
 *
 *  - **Depth is capped.** Without a cap, a subagent that has the `task` tool
 *    spawns subagents forever. The cap is enforced here, not by prompting.
 *  - **A child cannot outlive its parent.** Aborting the parent must abort every
 *    descendant, or a cancelled request leaves work running and billing.
 *  - **A failed child returns a result, not an exception.** The parent asked a
 *    question; "I could not answer, here is why" is a valid answer and keeps the
 *    conversation coherent. A thrown error would break the tool-call protocol.
 *  - **Children are reported even when abandoned.** Cost and token usage roll up
 *    regardless of outcome, because otherwise a session's reported cost is wrong.
 */

import { newId } from "../util/id.js"
import { logger } from "../util/log.js"
import { Bus } from "../util/bus.js"
import { isAbortError } from "../util/error.js"
import { Session } from "../session/session.js"
import { prompt as runPrompt } from "../session/loop.js"
import { agentByName, canDelegate, type Agent } from "./agent.js"
import { setSubagentRunner, type SubagentRequest, type SubagentResult } from "../tool/task.js"

const log = logger("agent.subagent")

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * Hard ceiling on nesting.
 *
 * Two levels: the main agent delegates, and its child may delegate once more.
 * Deeper than that has never produced a better answer in practice \u2014 the context
 * needed to state the sub-sub-problem well is exactly the context that was
 * supposed to be saved.
 */
const MAX_DEPTH = 2

/**
 * Ceiling on steps inside a child.
 *
 * Lower than the parent's. A subagent has one question to answer; if it has taken
 * eighty tool calls it is lost, and letting it continue burns money without
 * converging.
 */
const MAX_CHILD_STEPS = 80

/** Wall-clock cap. Prevents one stuck child from hanging the whole turn. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000

/** Concurrent children per parent. Beyond this, providers start rate-limiting. */
const MAX_CONCURRENCY = 6

/* ------------------------------------------------------------------ */
/* Active registry                                                     */
/* ------------------------------------------------------------------ */

interface ActiveChild {
  readonly id: string
  readonly sessionId: string
  readonly parentSessionId: string
  readonly agent: string
  readonly description: string
  readonly startedAt: number
  readonly controller: AbortController
}

const active = new Map<string, ActiveChild>()

/** Children currently running, for the status line and for `praxis session tree`. */
export function activeSubagents(parentSessionId?: string): ActiveChild[] {
  const all = [...active.values()]
  if (!parentSessionId) return all
  return all.filter((child) => child.parentSessionId === parentSessionId)
}

/**
 * Aborts every descendant of a session.
 *
 * Called when the parent is interrupted. Recursive through the session tree, so
 * cancelling the top-level turn reliably stops grandchildren too \u2014 the case that
 * leaks money when it is missed.
 */
export function abortSubagents(parentSessionId: string): number {
  let aborted = 0

  for (const child of active.values()) {
    if (child.parentSessionId !== parentSessionId) continue
    child.controller.abort()
    aborted++
    // Recurse: this child may itself have children.
    aborted += abortSubagents(child.sessionId)
  }

  if (aborted > 0) log.debug("aborted subagents", { parentSessionId, aborted })
  return aborted
}

/* ------------------------------------------------------------------ */
/* Concurrency gate                                                    */
/* ------------------------------------------------------------------ */

/**
 * A small semaphore.
 *
 * A model asked to investigate ten things will happily request ten subagents at
 * once, and ten simultaneous streams reliably trip provider rate limits. Queueing
 * the excess is slower than the model hoped but much faster than the retry storm
 * that follows a 429.
 */
class Gate {
  private running = 0
  private queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.running < this.limit) {
      this.running++
      return () => this.release()
    }

    await new Promise<void>((resolve, reject) => {
      const entry = () => {
        cleanup()
        this.running++
        resolve()
      }

      const onAbort = () => {
        cleanup()
        this.queue = this.queue.filter((item) => item !== entry)
        reject(new DOMException("Aborted", "AbortError"))
      }

      const cleanup = () => signal?.removeEventListener("abort", onAbort)

      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"))
        return
      }

      signal?.addEventListener("abort", onAbort, { once: true })
      this.queue.push(entry)
    })

    return () => this.release()
  }

  private release(): void {
    this.running--
    const next = this.queue.shift()
    if (next) next()
  }
}

const gate = new Gate(MAX_CONCURRENCY)

/* ------------------------------------------------------------------ */
/* Running a subagent                                                  */
/* ------------------------------------------------------------------ */

/**
 * Runs one subagent to completion.
 *
 * Never throws for a task-level failure. Every outcome \u2014 success, refusal,
 * timeout, abort, crash \u2014 comes back as a `SubagentResult` the parent can put in a
 * tool result. Throwing would leave a tool call unanswered, which most providers
 * reject on the next request, turning a recoverable subagent failure into a
 * broken conversation.
 */
export async function runSubagent(request: SubagentRequest): Promise<SubagentResult> {
  const startedAt = Date.now()
  const childId = newId("task")

  const parent = await Session.get(request.parentSessionId)
  if (!parent) {
    return {
      ok: false,
      summary: "The parent session no longer exists.",
      error: "parent-missing",
      durationMs: 0,
    }
  }

  const depth = (parent.depth ?? 0) + 1

  if (depth > MAX_DEPTH) {
    // Explained rather than merely refused, so the model changes strategy instead
    // of retrying the same call.
    return {
      ok: false,
      summary: `Delegation depth limit reached (${MAX_DEPTH}). You are already running inside a subagent, so you cannot spawn another. Do this work directly with the tools you have.`,
      error: "depth-exceeded",
      durationMs: 0,
    }
  }

  const agent = resolveSubagent(request.agent)
  if (!agent) {
    return {
      ok: false,
      summary: `There is no subagent named "${request.agent}".`,
      error: "unknown-agent",
      durationMs: 0,
    }
  }

  if (!canDelegate(agent, depth)) {
    return {
      ok: false,
      summary: `The "${agent.name}" agent cannot run at depth ${depth}.`,
      error: "depth-exceeded",
      durationMs: 0,
    }
  }

  const controller = new AbortController()

  // Parent abort propagates immediately, including to a child still queued.
  const onParentAbort = () => controller.abort()
  request.signal?.addEventListener("abort", onParentAbort, { once: true })

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let release: (() => void) | undefined
  let childSessionId: string | undefined

  try {
    release = await gate.acquire(controller.signal)

    const child = await Session.create({
      projectId: parent.projectId,
      parentId: parent.id,
      depth,
      internal: true,
      title: truncate(request.description, 60),
      agent: agent.name,
      model: request.model ?? agent.model ?? parent.model,
      cwd: request.cwd ?? parent.cwd,
    })

    childSessionId = child.id

    const entry: ActiveChild = {
      id: childId,
      sessionId: child.id,
      parentSessionId: parent.id,
      agent: agent.name,
      description: request.description,
      startedAt,
      controller,
    }
    active.set(childId, entry)

    Bus.publish("subagentStarted", {
      id: childId,
      sessionId: child.id,
      parentSessionId: parent.id,
      agent: agent.name,
      description: request.description,
    })

    log.info("subagent started", {
      agent: agent.name,
      depth,
      sessionId: child.id,
      description: truncate(request.description, 80),
    })

    const result = await runPrompt({
      sessionId: child.id,
      agent: agent.name,
      model: request.model ?? agent.model,
      cwd: request.cwd ?? parent.cwd,
      parts: [{ type: "text", text: buildChildPrompt(request, agent) }],
      signal: controller.signal,
      maxSteps: MAX_CHILD_STEPS,
      // Titles are for sessions a human will browse. A child lives for ninety
      // seconds and is named after its task already.
      generateTitle: false,
      // A subagent producing its own subagent summary is noise; the parent's
      // summary already covers it.
      quiet: true,
    })

    const durationMs = Date.now() - startedAt
    const text = extractText(result)

    if (!text.trim()) {
      return {
        ok: false,
        summary:
          "The subagent finished without producing an answer. This usually means the task was too vague to act on \u2014 restate it with a specific question and the files or symbols to look at.",
        error: "empty-result",
        sessionId: child.id,
        durationMs,
        usage: result.usage,
        cost: result.cost,
      }
    }

    Bus.publish("subagentCompleted", {
      id: childId,
      sessionId: child.id,
      parentSessionId: parent.id,
      agent: agent.name,
      durationMs,
      cost: result.cost,
    })

    log.info("subagent finished", {
      agent: agent.name,
      sessionId: child.id,
      durationMs,
      steps: result.steps,
      cost: result.cost,
    })

    return {
      ok: true,
      summary: text,
      sessionId: child.id,
      durationMs,
      steps: result.steps,
      usage: result.usage,
      cost: result.cost,
      changedPaths: result.changedPaths,
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt

    if (isAbortError(error)) {
      // Distinguish the two abort causes. "Timed out" and "you cancelled" call for
      // completely different follow-up from the parent.
      const timedOut = durationMs >= timeoutMs - 50

      Bus.publish("subagentAborted", {
        id: childId,
        sessionId: childSessionId,
        parentSessionId: parent.id,
        agent: agent.name,
        timedOut,
      })

      return {
        ok: false,
        summary: timedOut
          ? `The subagent hit its ${Math.round(timeoutMs / 1_000)}s time limit without finishing. Narrow the task \u2014 name specific files or a specific question \u2014 and try again, or do it directly.`
          : "The subagent was cancelled.",
        error: timedOut ? "timeout" : "aborted",
        sessionId: childSessionId,
        durationMs,
      }
    }

    log.error("subagent crashed", {
      agent: agent.name,
      sessionId: childSessionId,
      error: String(error),
    })

    return {
      ok: false,
      summary: `The subagent failed: ${(error as Error).message ?? String(error)}`,
      error: "failed",
      sessionId: childSessionId,
      durationMs,
    }
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener("abort", onParentAbort)
    active.delete(childId)
    release?.()
  }
}

/* ------------------------------------------------------------------ */
/* Prompt construction                                                 */
/* ------------------------------------------------------------------ */

/**
 * Builds the child's opening message.
 *
 * The framing matters more than it looks. A subagent that does not know it is a
 * subagent behaves like an assistant: it asks clarifying questions nobody will
 * answer, and it writes conversational preamble the parent then has to read past.
 * Stating the situation plainly fixes both.
 */
function buildChildPrompt(request: SubagentRequest, agent: Agent): string {
  const sections: string[] = []

  sections.push(request.prompt)

  const constraints: string[] = []

  constraints.push(
    "You are running as a subagent. Another agent delegated this task to you and is waiting for your answer; there is no human in this conversation. Nobody will respond to a clarifying question, so make a reasonable assumption, state it, and continue.",
  )

  constraints.push(
    "Your final message is the entire result. Everything else you do \u2014 every file you read, every command you run \u2014 is discarded. Put the actual findings in the last message rather than referring back to work the caller cannot see.",
  )

  if (agent.mode === "subagent" && isReadOnly(agent)) {
    constraints.push(
      "You cannot modify files. If the task needs changes, describe precisely what should change and where, and let the caller make them.",
    )
  }

  constraints.push(
    "Include concrete references \u2014 file paths with line numbers, exact symbol names, verbatim snippets of the relevant code. A summary the caller cannot verify is worth much less than one it can.",
  )

  constraints.push(
    "Be complete but not padded. No preamble, no offers of further help, no restating the task back.",
  )

  sections.push("---\n\n" + constraints.map((line) => `- ${line}`).join("\n"))

  if (request.context) {
    sections.push(`---\n\nContext from the caller:\n\n${request.context}`)
  }

  return sections.join("\n\n")
}

function isReadOnly(agent: Agent): boolean {
  if (agent.disabledTools?.includes("edit")) return true
  if (agent.tools && !agent.tools.includes("edit") && !agent.tools.includes("write")) return true
  return false
}

/* ------------------------------------------------------------------ */
/* Result extraction                                                   */
/* ------------------------------------------------------------------ */

/**
 * Pulls the answer out of a finished run.
 *
 * Only the final assistant text. Intermediate messages are the child's working,
 * and including them would defeat the entire purpose of delegating.
 */
function extractText(result: { text?: string; messages?: Array<{ role: string; text?: string }> }): string {
  if (typeof result.text === "string" && result.text.trim()) return result.text.trim()

  const messages = result.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === "assistant" && message.text && message.text.trim()) {
      return message.text.trim()
    }
  }

  return ""
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}\u2026`
}

function resolveSubagent(name: string): Agent | undefined {
  const agent = agentByName(name)
  // `agentByName` falls back to the default agent so the main loop always has
  // something to run. Here a wrong name must be an error: silently running a
  // build agent when the caller asked for a read-only explorer would hand it
  // write access it was never meant to have.
  if (agent.name !== name) return undefined
  if (agent.mode === "primary") {
    // Primary agents can serve as subagents; there is nothing unsafe about it and
    // it is occasionally what the user configured.
    return agent
  }
  if (agent.mode === "internal") return undefined
  return agent
}

/* ------------------------------------------------------------------ */
/* Batch execution                                                     */
/* ------------------------------------------------------------------ */

/**
 * Runs several subagents at once.
 *
 * The concurrency win is real: four independent searches finish in the time of
 * the slowest rather than the sum. `allSettled` semantics are essential \u2014 one
 * child failing must not discard three good answers, which is exactly what
 * `Promise.all` would do.
 */
export async function runSubagentBatch(
  requests: SubagentRequest[],
): Promise<SubagentResult[]> {
  if (requests.length === 0) return []
  if (requests.length === 1) return [await runSubagent(requests[0]!)]

  log.info("subagent batch", { count: requests.length })

  const settled = await Promise.allSettled(requests.map((request) => runSubagent(request)))

  return settled.map((entry, index) => {
    if (entry.status === "fulfilled") return entry.value
    return {
      ok: false as const,
      summary: `Subagent ${index + 1} failed to start: ${String(entry.reason)}`,
      error: "failed",
      durationMs: 0,
    }
  })
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/**
 * Wires the runner into the `task` tool.
 *
 * Late binding through a setter rather than a direct import, because the tool
 * layer and the session layer would otherwise form an import cycle: the loop
 * needs tools, tools need the loop. The cycle is real in the dependency graph but
 * not at any single moment in time, and a setter is the smallest way to say that.
 */
export function installSubagentRunner(): void {
  setSubagentRunner({
    run: runSubagent,
    runBatch: runSubagentBatch,
    abort: abortSubagents,
    active: activeSubagents,
  })

  log.debug("subagent runner installed")
}
