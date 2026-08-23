/**
 * Tool contract.
 *
 * A tool is defined once and used in three places: as a JSON schema sent to the
 * provider, as an executable with a permission check, and as a rendered widget
 * in the TUI. The shape below serves all three without any of them needing to
 * know about the others.
 *
 * Two design points are load-bearing:
 *
 *  - `init()` is lazy and async. Building the description often requires I/O
 *    (listing available skills, probing which language servers are running,
 *    reading the project's formatter config), and doing that at import time
 *    would make startup slow and untestable.
 *  - `execute()` receives a `metadata` callback rather than returning metadata
 *    only at the end. Long-running tools stream progress through it, which is
 *    what makes the TUI show a live line count while a search runs.
 */

import type { Schema } from "../util/schema.js"
import type { PermissionAction } from "../permission/types.js"

/* ------------------------------------------------------------------ */
/* Execution context                                                   */
/* ------------------------------------------------------------------ */

export interface ToolAttachment {
  readonly type: "image" | "file"
  readonly mime: string
  /** Base64 payload. */
  readonly data: string
  readonly filename?: string
}

export interface ToolContext {
  /** Session this call belongs to. */
  readonly sessionId: string
  /** Message id of the assistant turn that issued the call. */
  readonly messageId: string
  /** The provider's id for this specific call. */
  readonly toolCallId: string
  /** Working directory for the call. Always absolute. */
  readonly cwd: string
  /** Agent that owns this call; determines permissions and tool set. */
  readonly agent: string
  /** Nesting depth: 0 for the main agent, 1+ for subagents. */
  readonly depth: number
  readonly signal: AbortSignal
  /** Model reference (`provider/model`) driving this call. */
  readonly model: string

  /**
   * Streams intermediate state to the UI. Called any number of times; the last
   * value wins. Cheap, so tools should call it liberally.
   */
  metadata(update: ToolMetadataUpdate): void

  /**
   * Requests permission for an operation. Resolves when allowed, throws
   * `PermissionDeniedError` when denied. Tools must call this *before* the side
   * effect, not after.
   */
  requestPermission(request: PermissionRequest): Promise<void>

  /** Emits a line of streaming output (used by bash and long-running tools). */
  stdout?(chunk: string): void

  /** Reads a nested tool by id, used by `batch` and `task`. */
  invoke?(toolName: string, input: Record<string, unknown>): Promise<ToolResult>
}

export interface PermissionRequest {
  readonly action: PermissionAction
  /** The concrete resource: a command line, a path, an agent name, a URL. */
  readonly resource: string
  /** Shown to the user in the prompt. */
  readonly title: string
  /** Optional detail block, e.g. a diff or the full command. */
  readonly detail?: string
  /** Pattern offered for "always allow", e.g. `git status*`. */
  readonly pattern?: string
  readonly risk?: "low" | "medium" | "high"
}

export interface ToolMetadataUpdate {
  /** Replaces the single-line title shown next to the tool name. */
  readonly title?: string
  /** Free-form structured data for the renderer. */
  readonly [key: string]: unknown
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export interface ToolResult {
  /** One-line summary shown in the transcript, e.g. `src/app.ts (140 lines)`. */
  readonly title: string
  /** Text returned to the model. This is the tool's actual output. */
  readonly output: string
  /** Structured data for the renderer; never sent to the model. */
  readonly metadata?: Record<string, unknown>
  /** Images or files returned alongside the text. */
  readonly attachments?: readonly ToolAttachment[]
  /** True when the call failed in a way the model should see as an error. */
  readonly isError?: boolean
}

/* ------------------------------------------------------------------ */
/* Definition                                                          */
/* ------------------------------------------------------------------ */

export interface ToolInit<Params> {
  /**
   * Description sent to the provider. This is the single most important string
   * in the whole system: it decides whether the model reaches for the right
   * tool. Write it as instructions to the model, not as documentation.
   */
  readonly description: string
  readonly parameters: Schema<Params>
  execute(input: Params, context: ToolContext): Promise<ToolResult>
}

export interface ToolInitContext {
  readonly cwd: string
  readonly agent: string
  readonly model: string
  readonly providerId: string
  /** Enabled experimental flags, so a tool can adapt its description. */
  readonly flags: Readonly<Record<string, boolean>>
}

export interface ToolDefinition<Params = Record<string, unknown>> {
  readonly id: string
  /** Display name used in the TUI. Defaults to `id`. */
  readonly label?: string
  /** Permission action requested by default, before the tool refines it. */
  readonly action?: PermissionAction
  /** True when the tool has no side effects; used by read-only agents. */
  readonly readOnly?: boolean
  /** True when this tool may be run concurrently with others by `batch`. */
  readonly concurrent?: boolean
  /** Hidden from the model but callable internally. */
  readonly internal?: boolean
  init(context: ToolInitContext): Promise<ToolInit<Params>> | ToolInit<Params>
}

/** Erased form used by the registry, where the parameter type is unknown. */
export type AnyToolDefinition = ToolDefinition<never> & {
  init(context: ToolInitContext): Promise<ToolInit<never>> | ToolInit<never>
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Declares a tool with full type inference from the schema.
 *
 * Written as a function rather than a class so definitions stay data-like and
 * can be created by loaders (MCP bridge, plugin API) at runtime.
 */
export function defineTool<Params>(
  definition: ToolDefinition<Params>,
): ToolDefinition<Params> {
  return definition
}

/** Standard success result. */
export function ok(
  title: string,
  output: string,
  metadata?: Record<string, unknown>,
  attachments?: readonly ToolAttachment[],
): ToolResult {
  return { title, output, metadata, attachments }
}

/**
 * Standard error result.
 *
 * Tool errors are returned, not thrown, whenever the model can act on them: a
 * missing file, a failed edit, a command that exited non-zero. The model gets
 * the error text and can correct course. Throwing is reserved for conditions
 * the model cannot fix, such as a permission denial or an abort.
 */
export function fail(
  title: string,
  output: string,
  metadata?: Record<string, unknown>,
): ToolResult {
  return { title, output, metadata, isError: true }
}

/**
 * Formats an error for the model.
 *
 * Includes the concrete remedy where one exists. "File not found" is much less
 * useful than "File not found. Use glob to locate it, or list the directory."
 */
export function describeError(error: unknown, hint?: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return hint ? `${message}\n\n${hint}` : message
}

/* ------------------------------------------------------------------ */
/* Call bookkeeping                                                    */
/* ------------------------------------------------------------------ */

export type ToolCallState = "pending" | "running" | "completed" | "error" | "denied" | "aborted"

export interface ToolCallRecord {
  readonly id: string
  readonly sessionId: string
  readonly messageId: string
  readonly toolCallId: string
  readonly tool: string
  readonly input: Record<string, unknown>
  state: ToolCallState
  title?: string
  output?: string
  metadata?: Record<string, unknown>
  startedAt: number
  completedAt?: number
  error?: string
}

/** Key used for doom-loop detection and for pruning superseded results. */
export function callKey(tool: string, input: Record<string, unknown>): string {
  return `${tool}:${stableStringify(input)}`
}

/**
 * Deterministic JSON with sorted keys.
 *
 * `JSON.stringify` preserves insertion order, so two semantically identical
 * tool inputs can produce different strings. Doom-loop detection compares these
 * strings, so the ordering must be canonical.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
}
