/**
 * Provider-agnostic LLM types.
 *
 * Every transport (OpenAI chat completions, OpenAI responses, Anthropic
 * messages, Google generateContent, Bedrock, Ollama, Mistral, Cohere, Azure,
 * Copilot) converts to and from these shapes. The rest of the codebase never
 * sees a provider-specific payload.
 *
 * The event stream is modelled on the union that every modern provider
 * converges on: text deltas, reasoning deltas, incremental tool-call argument
 * deltas, then a per-step finish carrying usage.
 */

/* ------------------------------------------------------------------ */
/* Content                                                             */
/* ------------------------------------------------------------------ */

export interface TextContent {
  readonly type: "text"
  readonly text: string
  /** Provider cache marker; set on the last stable prefix boundary. */
  readonly cacheControl?: "ephemeral"
}

export interface ImageContent {
  readonly type: "image"
  /** Base64 data without a data-URL prefix, or an https URL. */
  readonly data: string
  readonly mime: string
}

export interface FileContent {
  readonly type: "file"
  readonly data: string
  readonly mime: string
  readonly filename?: string
}

export interface ReasoningContent {
  readonly type: "reasoning"
  readonly text: string
  /** Anthropic requires the original signature when replaying thinking blocks. */
  readonly signature?: string
  /** OpenAI Responses returns opaque encrypted reasoning to replay. */
  readonly encrypted?: string
  readonly redacted?: boolean
}

export interface ToolCallContent {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
  /** Raw JSON text, preserved so we can replay byte-identical arguments. */
  readonly inputText?: string
}

export interface ToolResultContent {
  readonly type: "tool-result"
  readonly toolCallId: string
  readonly toolName: string
  readonly output: string
  readonly isError?: boolean
  /** Images returned by a tool, e.g. a screenshot. */
  readonly attachments?: ImageContent[]
}

export type Content =
  | TextContent
  | ImageContent
  | FileContent
  | ReasoningContent
  | ToolCallContent
  | ToolResultContent

export type LlmRole = "system" | "user" | "assistant" | "tool"

export interface LlmMessage {
  readonly role: LlmRole
  readonly content: Content[]
  /** Optional provider-visible participant name. */
  readonly name?: string
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  /** JSON Schema for the arguments object. */
  readonly parameters: Record<string, unknown>
  /** Require the provider to emit arguments matching the schema exactly. */
  readonly strict?: boolean
}

export type ToolChoice =
  | { readonly type: "auto" }
  | { readonly type: "none" }
  | { readonly type: "required" }
  | { readonly type: "tool"; readonly name: string }

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export interface LlmRequest {
  readonly modelId: string
  readonly messages: LlmMessage[]
  readonly system?: string[]
  readonly tools?: ToolDefinition[]
  readonly toolChoice?: ToolChoice
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly stopSequences?: string[]
  readonly seed?: number
  readonly frequencyPenalty?: number
  readonly presencePenalty?: number
  /** Reasoning budget for thinking models. */
  readonly reasoning?: {
    readonly effort?: "minimal" | "low" | "medium" | "high"
    readonly maxTokens?: number
    /** Ask the provider to return the reasoning text. */
    readonly include?: boolean
  }
  /** Enable provider prompt caching where supported. */
  readonly promptCache?: boolean
  /** Allow the model to emit multiple tool calls per step. */
  readonly parallelToolCalls?: boolean
  /** JSON-schema-constrained output. */
  readonly responseFormat?:
    | { readonly type: "text" }
    | { readonly type: "json" }
    | {
        readonly type: "json-schema"
        readonly name: string
        readonly schema: Record<string, unknown>
        readonly strict?: boolean
      }
  /** Extra body fields merged verbatim; escape hatch for provider quirks. */
  readonly providerOptions?: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
  /** Correlation id echoed into logs and events. */
  readonly requestId?: string
  readonly sessionId?: string
}

/* ------------------------------------------------------------------ */
/* Stream events                                                       */
/* ------------------------------------------------------------------ */

export interface StreamStart {
  readonly type: "start"
  readonly requestId: string
  readonly modelId: string
}

export interface StepStart {
  readonly type: "step-start"
  readonly step: number
}

export interface TextStart {
  readonly type: "text-start"
  readonly id: string
}

export interface TextDelta {
  readonly type: "text-delta"
  readonly id: string
  readonly delta: string
}

export interface TextEnd {
  readonly type: "text-end"
  readonly id: string
}

export interface ReasoningStart {
  readonly type: "reasoning-start"
  readonly id: string
}

export interface ReasoningDelta {
  readonly type: "reasoning-delta"
  readonly id: string
  readonly delta: string
}

export interface ReasoningEnd {
  readonly type: "reasoning-end"
  readonly id: string
  readonly signature?: string
  readonly encrypted?: string
}

export interface ToolCallStart {
  readonly type: "tool-call-start"
  readonly toolCallId: string
  readonly toolName: string
}

export interface ToolCallDelta {
  readonly type: "tool-call-delta"
  readonly toolCallId: string
  /** Partial JSON text; concatenate to reconstruct the arguments. */
  readonly delta: string
}

export interface ToolCallEnd {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly inputText: string
}

export interface StepFinish {
  readonly type: "step-finish"
  readonly step: number
  readonly finishReason: LlmFinishReason
  readonly usage: LlmUsage
}

export interface StreamFinish {
  readonly type: "finish"
  readonly finishReason: LlmFinishReason
  readonly usage: LlmUsage
}

export interface StreamError {
  readonly type: "error"
  readonly error: {
    readonly name: string
    readonly message: string
    readonly retryable: boolean
    readonly status?: number
  }
}

/** Provider-specific diagnostics surfaced without failing the stream. */
export interface StreamWarning {
  readonly type: "warning"
  readonly message: string
  readonly detail?: Record<string, unknown>
}

export interface RawEvent {
  readonly type: "raw"
  readonly payload: unknown
}

export type LlmStreamEvent =
  | StreamStart
  | StepStart
  | TextStart
  | TextDelta
  | TextEnd
  | ReasoningStart
  | ReasoningDelta
  | ReasoningEnd
  | ToolCallStart
  | ToolCallDelta
  | ToolCallEnd
  | StepFinish
  | StreamFinish
  | StreamError
  | StreamWarning
  | RawEvent

export type LlmFinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "aborted"
  | "unknown"

export interface LlmUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** Total as reported by the provider, when it differs from the sum. */
  readonly total?: number
}

export function zeroUsage(): LlmUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function mergeUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

/* ------------------------------------------------------------------ */
/* Non-streaming result                                                */
/* ------------------------------------------------------------------ */

export interface LlmResult {
  readonly text: string
  readonly reasoning?: string
  readonly toolCalls: ToolCallContent[]
  readonly finishReason: LlmFinishReason
  readonly usage: LlmUsage
  readonly modelId: string
  readonly requestId: string
  readonly durationMs: number
  readonly raw?: unknown
}

/* ------------------------------------------------------------------ */
/* Transport contract                                                  */
/* ------------------------------------------------------------------ */

export interface TransportContext {
  readonly providerId: string
  readonly baseUrl: string
  readonly apiKey?: string
  readonly headers: Record<string, string>
  readonly query: Record<string, string>
  readonly timeoutMs: number
  readonly retries: number
  /** Provider-level extras (region, project, api-version, ...). */
  readonly options: Record<string, unknown>
  /** Model capability flags resolved from the catalog. */
  readonly capabilities: ModelCapabilities
}

export interface ModelCapabilities {
  readonly toolCall: boolean
  readonly attachment: boolean
  readonly reasoning: boolean
  readonly temperature: boolean
  readonly structuredOutput: boolean
  readonly promptCache: boolean
  readonly parallelToolCalls: boolean
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

export function defaultCapabilities(): ModelCapabilities {
  return {
    toolCall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    structuredOutput: false,
    promptCache: false,
    parallelToolCalls: true,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  }
}

/**
 * A transport turns a normalised request into a stream of normalised events.
 * Implementations must:
 *   - never throw after the first event is yielded; emit `error` instead
 *   - always emit exactly one `finish`
 *   - reconstruct complete tool calls before emitting `tool-call`
 */
export interface Transport {
  readonly id: string
  stream(request: LlmRequest, context: TransportContext): AsyncGenerator<LlmStreamEvent>
  /** Optional non-streaming path; defaults to collecting the stream. */
  generate?(request: LlmRequest, context: TransportContext): Promise<LlmResult>
  /** Optional model discovery, e.g. Ollama's `/api/tags`. */
  listModels?(context: TransportContext): Promise<string[]>
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Collects a stream into a single result. Used by `generate` fallbacks. */
export async function collectStream(
  stream: AsyncGenerator<LlmStreamEvent>,
  modelId: string,
  requestId: string,
): Promise<LlmResult> {
  const started = Date.now()
  let text = ""
  let reasoning = ""
  const toolCalls: ToolCallContent[] = []
  let finishReason: LlmFinishReason = "unknown"
  let usage = zeroUsage()
  let error: StreamError["error"] | undefined

  for await (const event of stream) {
    switch (event.type) {
      case "text-delta":
        text += event.delta
        break
      case "reasoning-delta":
        reasoning += event.delta
        break
      case "tool-call":
        toolCalls.push({
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          inputText: event.inputText,
        })
        break
      case "finish":
        finishReason = event.finishReason
        usage = event.usage
        break
      case "step-finish":
        usage = mergeUsage(usage, event.usage)
        break
      case "error":
        error = event.error
        break
      default:
        break
    }
  }

  if (error) {
    const wrapped = new Error(error.message)
    wrapped.name = error.name
    throw wrapped
  }

  return {
    text,
    reasoning: reasoning || undefined,
    toolCalls,
    finishReason,
    usage,
    modelId,
    requestId,
    durationMs: Date.now() - started,
  }
}

/** Extracts plain text from a message's content, ignoring other parts. */
export function contentText(content: readonly Content[]): string {
  return content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("")
}

/** True when the message carries anything the provider can render. */
export function hasRenderableContent(message: LlmMessage): boolean {
  return message.content.some((item) => {
    if (item.type === "text") return item.text.trim() !== ""
    return true
  })
}

/**
 * Normalises a finish reason string from any provider.
 * Providers use wildly different vocabularies for the same states.
 */
export function normalizeFinishReason(raw: string | null | undefined): LlmFinishReason {
  if (!raw) return "unknown"
  const value = raw.toLowerCase().replace(/[_\s]/g, "-")
  switch (value) {
    case "stop":
    case "end-turn":
    case "endturn":
    case "complete":
    case "completed":
    case "finished":
    case "stop-sequence":
    case "eos":
      return "stop"
    case "length":
    case "max-tokens":
    case "maxtokens":
    case "model-length":
    case "token-limit":
    case "max-output-tokens":
      return "length"
    case "tool-calls":
    case "tool-use":
    case "tooluse":
    case "function-call":
    case "tool-call":
      return "tool-calls"
    case "content-filter":
    case "safety":
    case "recitation":
    case "blocklist":
    case "prohibited-content":
    case "refusal":
      return "content-filter"
    case "error":
    case "failed":
      return "error"
    case "aborted":
    case "cancelled":
    case "canceled":
      return "aborted"
    default:
      return "unknown"
  }
}

/**
 * Tool-call ids must satisfy provider-specific constraints. Mistral, for
 * instance, rejects anything that is not exactly nine alphanumeric characters.
 */
export function conformToolCallId(id: string, style: "any" | "mistral" | "alphanumeric"): string {
  if (style === "any") return id
  const cleaned = id.replace(/[^A-Za-z0-9]/g, "")
  if (style === "mistral") {
    if (cleaned.length >= 9) return cleaned.slice(0, 9)
    return cleaned.padEnd(9, "0")
  }
  return cleaned
}

/**
 * Parses tool arguments defensively. Models emit trailing commas, unquoted
 * keys, duplicated braces and truncated JSON often enough that a strict parse
 * would break real conversations.
 */
export function parseToolInput(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (trimmed === "") return {}
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed }
  } catch {
    /* fall through to repair */
  }

  // Repair pass: strip trailing commas, close unbalanced braces/brackets.
  let repaired = trimmed.replace(/,\s*([}\]])/g, "$1")
  const openBraces = (repaired.match(/\{/g) ?? []).length
  const closeBraces = (repaired.match(/\}/g) ?? []).length
  const openBrackets = (repaired.match(/\[/g) ?? []).length
  const closeBrackets = (repaired.match(/\]/g) ?? []).length
  // Close an unterminated string first.
  const quotes = (repaired.match(/(?<!\\)"/g) ?? []).length
  if (quotes % 2 === 1) repaired += '"'
  repaired += "]".repeat(Math.max(0, openBrackets - closeBrackets))
  repaired += "}".repeat(Math.max(0, openBraces - closeBraces))

  try {
    const parsed = JSON.parse(repaired)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Some providers reject assistant messages whose text content is empty, and
 * some reject messages with both reasoning and no text. Filter defensively.
 */
export function pruneEmptyContent(messages: readonly LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = []
  for (const message of messages) {
    const content = message.content.filter((item) => {
      if (item.type === "text") return item.text !== ""
      if (item.type === "reasoning") return item.text !== "" || item.redacted === true
      return true
    })
    if (content.length === 0) continue
    out.push({ ...message, content })
  }
  return out
}

/**
 * Ensures every tool call has a matching result and vice versa. A mismatch is
 * a hard 400 on most providers, and it happens whenever a turn is interrupted
 * mid-tool-execution.
 */
export function reconcileToolCalls(messages: readonly LlmMessage[]): LlmMessage[] {
  const results = new Set<string>()
  for (const message of messages) {
    for (const item of message.content) {
      if (item.type === "tool-result") results.add(item.toolCallId)
    }
  }

  const out: LlmMessage[] = []
  for (const message of messages) {
    if (message.role !== "assistant") {
      out.push(message)
      continue
    }
    const content: Content[] = []
    const orphans: ToolCallContent[] = []
    for (const item of message.content) {
      if (item.type === "tool-call" && !results.has(item.toolCallId)) {
        orphans.push(item)
        continue
      }
      content.push(item)
    }
    if (content.length === 0 && orphans.length === 0) continue
    // Keep orphaned calls but synthesise an aborted result right after.
    if (orphans.length) {
      content.push(...orphans)
      out.push({ ...message, content })
      out.push({
        role: "tool",
        content: orphans.map((call) => ({
          type: "tool-result" as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: "Tool execution was interrupted before it produced a result.",
          isError: true,
        })),
      })
      continue
    }
    out.push({ ...message, content })
  }
  return out
}

/**
 * Collapses consecutive same-role messages. Anthropic and Google both reject
 * two user messages in a row.
 */
export function mergeAdjacentRoles(messages: readonly LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = []
  for (const message of messages) {
    const previous = out[out.length - 1]
    if (previous && previous.role === message.role && message.role !== "tool") {
      out[out.length - 1] = {
        ...previous,
        content: [...previous.content, ...message.content],
      }
      continue
    }
    out.push(message)
  }
  return out
}
