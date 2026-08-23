/**
 * Session domain model.
 *
 * A session is an ordered list of messages; each message is an ordered list of
 * parts. Parts are the atom of the UI: a text chunk, a reasoning block, a tool
 * invocation with live-updating state, a file attachment, a compaction summary.
 * Streaming updates mutate a part in place and republish it, so the renderer
 * only ever needs to diff parts.
 */

import type { Infer } from "../util/schema.js"
import { s } from "../util/schema.js"

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export interface Session {
  readonly id: string
  readonly projectId: string
  /** Set when this session was spawned by the `task` tool. */
  readonly parentId?: string
  title: string
  /** Working directory the session was created in. */
  readonly directory: string
  agent?: string
  model?: string
  readonly createdAt: number
  updatedAt: number
  archivedAt?: number
  shareUrl?: string
  shareSecret?: string
  /** Revert cursor: messages after this point are hidden but not deleted. */
  revert?: SessionRevert
  /** Rolling summary produced by compaction. */
  summary?: string
  metadata?: Record<string, unknown>
}

export interface SessionRevert {
  readonly messageId: string
  readonly partId?: string
  readonly snapshotId?: string
  /** Unified diff of everything the reverted turns changed. */
  readonly diff?: string
}

export interface SessionStats {
  readonly messageCount: number
  readonly toolCallCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costUsd: number
  readonly filesTouched: number
  readonly durationMs: number
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export type MessageRole = "user" | "assistant" | "system" | "tool"

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addUsage(target: TokenUsage, source: Partial<TokenUsage>): TokenUsage {
  target.input += source.input ?? 0
  target.output += source.output ?? 0
  target.reasoning += source.reasoning ?? 0
  target.cacheRead += source.cacheRead ?? 0
  target.cacheWrite += source.cacheWrite ?? 0
  return target
}

export function totalTokens(usage: TokenUsage): number {
  // Cache reads count toward the context window even though they are cheap.
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "aborted"
  | "unknown"

export interface Message {
  readonly id: string
  readonly sessionId: string
  readonly role: MessageRole
  readonly seq: number
  readonly createdAt: number
  completedAt?: number
  agent?: string
  providerId?: string
  modelId?: string
  /** Snapshot of the system prompt used, for reproducibility. */
  systemPrompt?: string
  finishReason?: FinishReason
  error?: MessageError
  usage: TokenUsage
  costUsd: number
  metadata?: Record<string, unknown>
  parts: Part[]
}

export interface MessageError {
  readonly name: string
  readonly message: string
  readonly retryable?: boolean
  readonly data?: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/* Parts                                                               */
/* ------------------------------------------------------------------ */

export type PartType =
  | "text"
  | "reasoning"
  | "tool"
  | "file"
  | "image"
  | "snapshot"
  | "compaction"
  | "step-start"
  | "step-finish"
  | "patch"
  | "agent"
  | "error"
  | "summary"

export interface PartBase {
  readonly id: string
  readonly messageId: string
  readonly sessionId: string
  readonly type: PartType
  seq: number
  readonly createdAt: number
  updatedAt: number
  /** Injected by the runtime rather than the model or the user. */
  synthetic?: boolean
}

export interface TextPart extends PartBase {
  readonly type: "text"
  text: string
  /** Streaming state: `streaming` parts are still receiving deltas. */
  state: "streaming" | "complete"
  /** Set when the text came from a slash command expansion. */
  source?: "user" | "model" | "command" | "reminder"
}

export interface ReasoningPart extends PartBase {
  readonly type: "reasoning"
  text: string
  state: "streaming" | "complete"
  /** Opaque provider signature required to replay reasoning back. */
  signature?: string
  /** Encrypted reasoning payload (OpenAI Responses API). */
  encrypted?: string
  durationMs?: number
}

export type ToolState =
  | { readonly status: "pending" }
  | { readonly status: "awaiting-permission"; readonly permissionId: string }
  | {
      readonly status: "running"
      readonly startedAt: number
      readonly title?: string
      readonly progress?: string
      readonly metadata?: Record<string, unknown>
    }
  | {
      readonly status: "completed"
      readonly startedAt: number
      readonly finishedAt: number
      readonly title: string
      readonly output: string
      readonly metadata?: Record<string, unknown>
    }
  | {
      readonly status: "error"
      readonly startedAt: number
      readonly finishedAt: number
      readonly error: string
      readonly metadata?: Record<string, unknown>
    }
  | {
      readonly status: "denied"
      readonly reason: string
    }
  | { readonly status: "aborted" }

export interface ToolPart extends PartBase {
  readonly type: "tool"
  readonly toolName: string
  readonly toolCallId: string
  /** Raw arguments as produced by the model. */
  input: Record<string, unknown>
  /** Partial JSON while the model is still streaming arguments. */
  inputText?: string
  state: ToolState
}

export interface FilePart extends PartBase {
  readonly type: "file"
  readonly filename: string
  readonly mime: string
  /** Inline text content, for text files. */
  text?: string
  /** `file://`, `data:` or a storage path for binaries. */
  url?: string
  byteSize?: number
  /** Line range when only part of the file was attached. */
  range?: { start: number; end: number }
}

export interface ImagePart extends PartBase {
  readonly type: "image"
  readonly mime: string
  /** Base64 payload or a `file://` URL. */
  readonly data: string
  width?: number
  height?: number
  filename?: string
}

export interface SnapshotPart extends PartBase {
  readonly type: "snapshot"
  readonly snapshotId: string
  readonly commitHash?: string
  fileCount: number
}

export interface CompactionPart extends PartBase {
  readonly type: "compaction"
  readonly summary: string
  readonly fromMessageId: string
  readonly toMessageId: string
  tokensBefore: number
  tokensAfter: number
}

export interface StepStartPart extends PartBase {
  readonly type: "step-start"
  readonly step: number
}

export interface StepFinishPart extends PartBase {
  readonly type: "step-finish"
  readonly step: number
  usage: TokenUsage
  costUsd: number
  finishReason: FinishReason
  durationMs: number
}

export interface PatchPart extends PartBase {
  readonly type: "patch"
  readonly path: string
  readonly diff: string
  additions: number
  deletions: number
}

export interface AgentPart extends PartBase {
  readonly type: "agent"
  readonly agent: string
  readonly taskId: string
  readonly childSessionId?: string
  description: string
  status: "running" | "completed" | "error" | "aborted"
  result?: string
  error?: string
}

export interface ErrorPart extends PartBase {
  readonly type: "error"
  readonly error: MessageError
}

export interface SummaryPart extends PartBase {
  readonly type: "summary"
  text: string
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | ImagePart
  | SnapshotPart
  | CompactionPart
  | StepStartPart
  | StepFinishPart
  | PatchPart
  | AgentPart
  | ErrorPart
  | SummaryPart

/* ------------------------------------------------------------------ */
/* Narrowing helpers                                                   */
/* ------------------------------------------------------------------ */

export function isTextPart(part: Part): part is TextPart {
  return part.type === "text"
}

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === "reasoning"
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool"
}

export function isFilePart(part: Part): part is FilePart {
  return part.type === "file"
}

export function isImagePart(part: Part): part is ImagePart {
  return part.type === "image"
}

export function isCompactionPart(part: Part): part is CompactionPart {
  return part.type === "compaction"
}

export function isPatchPart(part: Part): part is PatchPart {
  return part.type === "patch"
}

export function isAgentPart(part: Part): part is AgentPart {
  return part.type === "agent"
}

/** Parts that carry content the model should see on the next turn. */
export function isModelVisible(part: Part): boolean {
  switch (part.type) {
    case "text":
    case "reasoning":
    case "tool":
    case "file":
    case "image":
    case "compaction":
      return true
    default:
      return false
  }
}

/** True when a tool part has reached a terminal state. */
export function isToolFinished(part: ToolPart): boolean {
  return (
    part.state.status === "completed" ||
    part.state.status === "error" ||
    part.state.status === "denied" ||
    part.state.status === "aborted"
  )
}

/** Concatenates all assistant text in a message. */
export function messageText(message: Message): string {
  return message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("")
}

/** The last text part, used for streaming appends. */
export function lastTextPart(message: Message): TextPart | undefined {
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i] as Part
    if (isTextPart(part)) return part
    // A tool call ends the current text block.
    if (isToolPart(part)) return undefined
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Wire schemas                                                        */
/* ------------------------------------------------------------------ */

/**
 * Schemas for the HTTP API and the worker RPC bridge. Kept deliberately loose
 * on payload internals: the transport only needs to know enough to route and
 * validate, and duplicating the full part union here would guarantee drift.
 */
export const PartWireSchema = s.object({
  id: s.string(),
  messageId: s.string(),
  sessionId: s.string(),
  type: s.string(),
  seq: s.number(),
  createdAt: s.number(),
  updatedAt: s.number(),
  synthetic: s.boolean().optional(),
  text: s.string().optional(),
  payload: s.record(s.any()).optional(),
})

export const MessageWireSchema = s.object({
  id: s.string(),
  sessionId: s.string(),
  role: s.enum(["user", "assistant", "system", "tool"] as const),
  seq: s.number(),
  createdAt: s.number(),
  completedAt: s.number().optional(),
  agent: s.string().optional(),
  providerId: s.string().optional(),
  modelId: s.string().optional(),
  finishReason: s.string().optional(),
  costUsd: s.number().default(0),
  parts: s.array(PartWireSchema).optional(),
})

export const SessionWireSchema = s.object({
  id: s.string(),
  projectId: s.string(),
  parentId: s.string().optional(),
  title: s.string(),
  directory: s.string(),
  agent: s.string().optional(),
  model: s.string().optional(),
  createdAt: s.number(),
  updatedAt: s.number(),
  archivedAt: s.number().optional(),
  shareUrl: s.string().optional(),
  summary: s.string().optional(),
})

export type SessionWire = Infer<typeof SessionWireSchema>
export type MessageWire = Infer<typeof MessageWireSchema>
export type PartWire = Infer<typeof PartWireSchema>

/* ------------------------------------------------------------------ */
/* Todos                                                               */
/* ------------------------------------------------------------------ */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"
export type TodoPriority = "low" | "medium" | "high"

export interface Todo {
  readonly id: string
  readonly sessionId: string
  seq: number
  content: string
  status: TodoStatus
  priority?: TodoPriority
  readonly createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown>
}

export const TodoInputSchema = s.object({
  content: s.string().nonEmpty().describe("What needs to be done"),
  status: s.enum(["pending", "in_progress", "completed", "cancelled"] as const),
  priority: s.enum(["low", "medium", "high"] as const).optional(),
  id: s.string().optional().describe("Omit to create a new item"),
})

export type TodoInput = Infer<typeof TodoInputSchema>

/** Renders the todo list the way the model should see it. */
export function formatTodos(todos: readonly Todo[]): string {
  if (todos.length === 0) return "(no todos)"
  const glyph: Record<TodoStatus, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
    cancelled: "[-]",
  }
  return todos
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((todo) => `${glyph[todo.status]} ${todo.content}`)
    .join("\n")
}

/* ------------------------------------------------------------------ */
/* Tasks (subagents)                                                   */
/* ------------------------------------------------------------------ */

export type TaskStatus = "pending" | "running" | "completed" | "error" | "aborted"

export interface Task {
  readonly id: string
  readonly sessionId: string
  childSessionId?: string
  parentPartId?: string
  readonly agent: string
  readonly description: string
  status: TaskStatus
  readonly createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: string
  error?: string
  readonly depth: number
}
