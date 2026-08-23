/**
 * Tool registry.
 *
 * Owns which tools exist, which ones a given model and agent may see, and how a
 * call is executed end to end: schema validation, permission check, execution,
 * abort handling, doom-loop detection, and result recording.
 *
 * Two filtering axes, both necessary:
 *
 *  - **Model.** GPT models handle `apply_patch` far more reliably than a
 *    string-replacement `edit`, while Claude models are the reverse. Offering
 *    both to either wastes schema tokens and produces worse edits.
 *  - **Agent.** A read-only agent must not receive `write`, and not merely be
 *    told not to use it. Removing the tool is the only reliable enforcement.
 */

import { AbortedError, NotFoundError, ValidationError } from "../util/error.js"
import { Bus, Events } from "../util/bus.js"
import { newId } from "../util/id.js"
import { logger } from "../util/log.js"
import { truncate } from "../util/string.js"
import { prefersApplyPatch, modelFamily } from "../provider/types.js"
import { PermissionDeniedError } from "../permission/types.js"
import type { ToolSchema } from "../llm/types.js"
import {
  callKey,
  describeError,
  fail,
  type AnyToolDefinition,
  type ToolContext,
  type ToolDefinition,
  type ToolInit,
  type ToolInitContext,
  type ToolResult,
} from "./types.js"

const log = logger("tool.registry")

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

const definitions = new Map<string, AnyToolDefinition>()

export function registerTool<Params>(definition: ToolDefinition<Params>): void {
  if (definitions.has(definition.id)) {
    log.debug("replacing tool definition", { id: definition.id })
  }
  definitions.set(definition.id, definition as unknown as AnyToolDefinition)
}

export function unregisterTool(id: string): boolean {
  return definitions.delete(id)
}

export function toolDefinition(id: string): AnyToolDefinition | undefined {
  return definitions.get(id)
}

export function registeredToolIds(): string[] {
  return [...definitions.keys()].sort()
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

export interface ToolFilter {
  readonly providerId: string
  readonly modelId: string
  readonly agent: string
  /** Explicit allow list from the agent definition. Empty means "all". */
  readonly allow?: readonly string[]
  /** Explicit deny list from the agent definition. */
  readonly deny?: readonly string[]
  /** Only read-only tools are offered. */
  readonly readOnly?: boolean
  /** Experimental flags that gate optional tools. */
  readonly flags?: Readonly<Record<string, boolean>>
  /** Subagent depth; `task` is withheld beyond the limit. */
  readonly depth?: number
  readonly maxDepth?: number
}

/** Tools that are mutually exclusive depending on the model family. */
const EDIT_TOOLS = ["edit", "write", "multiedit"] as const
const PATCH_TOOLS = ["apply_patch"] as const

/** Tools that only appear when their flag is set. */
const FLAGGED_TOOLS: Record<string, string> = {
  websearch: "websearch",
  lsp: "lsp",
  notebook: "notebook",
  memory: "memory",
}

/**
 * Resolves the tool ids a model should receive.
 *
 * Order is stable and meaningful: the model weights earlier tools slightly more,
 * and a stable order keeps the prompt cache valid across turns.
 */
export function resolveToolIds(filter: ToolFilter): string[] {
  const family = modelFamily(filter.providerId, filter.modelId)
  const usePatch = prefersApplyPatch(family, filter.modelId)
  const flags = filter.flags ?? {}
  const selected: string[] = []

  for (const id of registeredToolIds()) {
    const definition = definitions.get(id)
    if (!definition || definition.internal) continue

    if (filter.readOnly && !definition.readOnly) continue

    if (usePatch && (EDIT_TOOLS as readonly string[]).includes(id) && id !== "write") continue
    if (!usePatch && (PATCH_TOOLS as readonly string[]).includes(id)) continue

    const flag = FLAGGED_TOOLS[id]
    if (flag && flags[flag] === false) continue

    if (id === "task") {
      const depth = filter.depth ?? 0
      const maxDepth = filter.maxDepth ?? 2
      if (depth >= maxDepth) continue
    }

    if (filter.deny?.some((pattern) => matchToolPattern(pattern, id))) continue
    if (filter.allow?.length && !filter.allow.some((pattern) => matchToolPattern(pattern, id))) continue

    selected.push(id)
  }

  return orderTools(selected)
}

function matchToolPattern(pattern: string, id: string): boolean {
  if (pattern === id || pattern === "*") return true
  if (!pattern.includes("*")) return false
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${body}$`).test(id)
}

/**
 * Canonical ordering.
 *
 * Discovery tools first, then reading, then editing, then execution, then the
 * meta tools. This mirrors the order in which a competent engineer uses them and
 * measurably improves tool selection on smaller models.
 */
const TOOL_ORDER = [
  "grep",
  "glob",
  "list",
  "read",
  "symbols",
  "lsp",
  "diagnostics",
  "edit",
  "multiedit",
  "apply_patch",
  "patch",
  "write",
  "notebook",
  "bash",
  "kill",
  "output",
  "git",
  "todowrite",
  "todoread",
  "task",
  "batch",
  "skill",
  "memory",
  "webfetch",
  "websearch",
  "question",
  "plan",
]

function orderTools(ids: readonly string[]): string[] {
  const rank = new Map(TOOL_ORDER.map((id, index) => [id, index]))
  return [...ids].sort((left, right) => {
    const leftRank = rank.get(left) ?? TOOL_ORDER.length + left.charCodeAt(0)
    const rightRank = rank.get(right) ?? TOOL_ORDER.length + right.charCodeAt(0)
    if (leftRank !== rightRank) return leftRank - rightRank
    return left < right ? -1 : 1
  })
}

/* ------------------------------------------------------------------ */
/* Instantiation                                                       */
/* ------------------------------------------------------------------ */

export interface ResolvedTool<Params = never> {
  readonly id: string
  readonly definition: ToolDefinition<Params>
  readonly init: ToolInit<Params>
  readonly schema: ToolSchema
}

const initCache = new Map<string, ResolvedTool<never>>()

/**
 * Instantiates a tool.
 *
 * Cached per (id, cwd, agent, model) because `init()` may do real I/O and is
 * called on every request. The cache key includes the agent because a tool's
 * description can legitimately differ by agent.
 */
export async function resolveTool(
  id: string,
  context: ToolInitContext,
): Promise<ResolvedTool<never>> {
  const key = `${id}|${context.cwd}|${context.agent}|${context.model}`
  const cached = initCache.get(key)
  if (cached) return cached

  const definition = definitions.get(id)
  if (!definition) throw new NotFoundError(`Unknown tool: ${id}`)

  const init = await definition.init(context)
  const resolved: ResolvedTool<never> = {
    id,
    definition,
    init,
    schema: {
      name: id,
      description: init.description,
      parameters: init.parameters.jsonSchema(),
    },
  }
  initCache.set(key, resolved)
  return resolved
}

export function clearToolCache(): void {
  initCache.clear()
}

/** Resolves every tool for a filter, in canonical order. */
export async function resolveTools(
  filter: ToolFilter,
  context: ToolInitContext,
): Promise<Array<ResolvedTool<never>>> {
  const ids = resolveToolIds(filter)
  const resolved = await Promise.all(
    ids.map(async (id) => {
      try {
        return await resolveTool(id, context)
      } catch (error) {
        log.warn("tool failed to initialise; omitting it", { id, error: String(error) })
        return undefined
      }
    }),
  )
  return resolved.filter((tool): tool is ResolvedTool<never> => tool !== undefined)
}

/** JSON schemas for the provider request. */
export function toolSchemas(tools: ReadonlyArray<ResolvedTool<never>>): ToolSchema[] {
  return tools.map((tool) => tool.schema)
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface ExecuteInput {
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly context: ToolContext
  readonly initContext: ToolInitContext
}

export interface ExecuteOutput extends ToolResult {
  readonly durationMs: number
  readonly denied?: boolean
  readonly aborted?: boolean
}

/**
 * Executes one tool call.
 *
 * Never throws for a failure the model can act on: a validation error, an
 * unknown tool, a denied permission, or a thrown exception all come back as an
 * error *result*. The model needs to see them to correct course, and throwing
 * would abort the whole turn.
 *
 * Aborts are the exception: when the user interrupts, the loop must unwind, so
 * `AbortedError` propagates.
 */
export async function executeTool(input: ExecuteInput): Promise<ExecuteOutput> {
  const started = Date.now()
  const { tool: toolName, context } = input

  Bus.publish(Events.toolCallStarted, {
    sessionId: context.sessionId,
    messageId: context.messageId,
    toolCallId: context.toolCallId,
    tool: toolName,
    input: input.input,
  })

  const finish = (result: ToolResult, extra: Partial<ExecuteOutput> = {}): ExecuteOutput => {
    const durationMs = Date.now() - started
    Bus.publish(Events.toolCallCompleted, {
      sessionId: context.sessionId,
      toolCallId: context.toolCallId,
      tool: toolName,
      title: result.title,
      isError: result.isError ?? false,
      durationMs,
    })
    return { ...result, ...extra, durationMs }
  }

  let resolved: ResolvedTool<never>
  try {
    resolved = await resolveTool(toolName, input.initContext)
  } catch {
    const available = resolveToolIds({
      providerId: input.initContext.providerId,
      modelId: input.initContext.model,
      agent: input.initContext.agent,
    })
    return finish(
      fail(
        `Unknown tool: ${toolName}`,
        `There is no tool called \`${toolName}\`. Available tools: ${available.join(", ")}.`,
      ),
    )
  }

  // Validate before the permission check so a malformed call never prompts.
  let parsed: never
  try {
    parsed = resolved.init.parameters.parse(input.input) as never
  } catch (error) {
    const message =
      error instanceof ValidationError
        ? error.message
        : `Invalid arguments: ${describeError(error)}`
    return finish(
      fail(
        `${toolName}: invalid arguments`,
        `${message}\n\nExpected schema:\n${JSON.stringify(resolved.schema.parameters, null, 2)}`,
      ),
    )
  }

  try {
    const result = await resolved.init.execute(parsed, context)
    return finish(result)
  } catch (error) {
    if (error instanceof AbortedError || context.signal.aborted) {
      return finish(
        fail(`${toolName}: interrupted`, "The user interrupted this operation."),
        { aborted: true },
      )
    }

    if (error instanceof PermissionDeniedError) {
      log.info("tool call denied", { tool: toolName, resource: error.resource })
      return finish(
        fail(
          `${toolName}: not permitted`,
          `${error.message}\n\nDo not retry this call. Either take a different approach, or tell the user which permission is needed and stop.`,
        ),
        { denied: true },
      )
    }

    log.error("tool call threw", { tool: toolName, error: String(error) })
    return finish(
      fail(
        `${toolName}: failed`,
        describeError(error, "Read the error and adjust your approach; repeating the identical call will fail the same way."),
      ),
    )
  }
}

/* ------------------------------------------------------------------ */
/* Doom-loop detection                                                 */
/* ------------------------------------------------------------------ */

interface LoopState {
  key: string
  count: number
}

const loops = new Map<string, LoopState>()

/**
 * Tracks consecutive identical calls per session.
 *
 * Three is the threshold because two identical calls are a legitimate retry
 * (a file was being written, a server was starting) while three means the model
 * has stopped reading the output.
 */
export function recordCall(
  sessionId: string,
  tool: string,
  input: Record<string, unknown>,
): { repeats: number; looping: boolean } {
  const key = callKey(tool, input)
  const state = loops.get(sessionId)
  if (state && state.key === key) {
    state.count++
    return { repeats: state.count, looping: state.count >= 3 }
  }
  loops.set(sessionId, { key, count: 1 })
  return { repeats: 1, looping: false }
}

export function resetLoop(sessionId: string): void {
  loops.delete(sessionId)
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

/** One-line summary of a call for the transcript. */
export function summarizeCall(tool: string, input: Record<string, unknown>): string {
  const primary =
    (typeof input["filePath"] === "string" && input["filePath"]) ||
    (typeof input["path"] === "string" && input["path"]) ||
    (typeof input["command"] === "string" && input["command"]) ||
    (typeof input["pattern"] === "string" && input["pattern"]) ||
    (typeof input["query"] === "string" && input["query"]) ||
    (typeof input["url"] === "string" && input["url"]) ||
    (typeof input["description"] === "string" && input["description"]) ||
    ""
  return primary ? `${tool}(${truncate(String(primary), 120)})` : tool
}

/** Fresh execution id, used when the provider omits a tool call id. */
export function syntheticCallId(): string {
  return newId("tool")
}
