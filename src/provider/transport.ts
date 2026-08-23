/**
 * Transport registry and shared helpers.
 *
 * Transports are registered lazily so that starting the CLI does not parse
 * every provider adapter. Each transport is a small module exporting a single
 * object implementing `Transport`.
 */

import type { LlmRequest, LlmStreamEvent, Transport, TransportContext } from "../llm/types.js"
import { UnsupportedError } from "../util/error.js"
import { newId } from "../util/id.js"
import { AnthropicTransport } from "./transport/anthropic.js"
import { AzureOpenAITransport } from "./transport/azure.js"
import { BedrockTransport } from "./transport/bedrock.js"
import { CohereTransport } from "./transport/cohere.js"
import { CopilotTransport } from "./transport/copilot.js"
import { GoogleTransport, GoogleVertexTransport } from "./transport/google.js"
import { MistralTransport } from "./transport/mistral.js"
import { OllamaTransport } from "./transport/ollama.js"
import { OpenAIChatTransport } from "./transport/openai-chat.js"
import { OpenAIResponsesTransport } from "./transport/openai-responses.js"
import type { TransportKind } from "./types.js"

const REGISTRY = new Map<TransportKind, Transport>()

function register(kind: TransportKind, transport: Transport): void {
  REGISTRY.set(kind, transport)
}

register("openai-chat", OpenAIChatTransport)
register("generic", OpenAIChatTransport)
register("openai-responses", OpenAIResponsesTransport)
register("anthropic", AnthropicTransport)
register("anthropic-bedrock", BedrockTransport)
register("anthropic-vertex", AnthropicTransport)
register("bedrock", BedrockTransport)
register("google", GoogleTransport)
register("google-vertex", GoogleVertexTransport)
register("ollama", OllamaTransport)
register("mistral", MistralTransport)
register("cohere", CohereTransport)
register("azure-openai", AzureOpenAITransport)
register("github-copilot", CopilotTransport)

export function transportFor(kind: TransportKind): Transport {
  const transport = REGISTRY.get(kind)
  if (!transport) throw new UnsupportedError(`No transport implementation for "${kind}"`, { kind })
  return transport
}

export function registerTransport(kind: TransportKind, transport: Transport): void {
  register(kind, transport)
}

export function transportKinds(): TransportKind[] {
  return [...REGISTRY.keys()]
}

/* ------------------------------------------------------------------ */
/* Shared helpers used by transport implementations                    */
/* ------------------------------------------------------------------ */

/** Builds the standard header set: auth, content type, provider extras. */
export function baseHeaders(
  context: TransportContext,
  request: LlmRequest,
  auth: "bearer" | "x-api-key" | "api-key" | "none" = "bearer",
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...context.headers,
    ...(request.headers ?? {}),
  }
  if (context.apiKey && auth !== "none") {
    if (auth === "bearer") headers["authorization"] = `Bearer ${context.apiKey}`
    if (auth === "x-api-key") headers["x-api-key"] = context.apiKey
    if (auth === "api-key") headers["api-key"] = context.apiKey
  }
  return headers
}

/** Wraps a generator so it always emits `start` first and `finish` exactly once. */
export async function* framed(
  request: LlmRequest,
  inner: () => AsyncGenerator<LlmStreamEvent>,
): AsyncGenerator<LlmStreamEvent> {
  const requestId = request.requestId ?? newId("request")
  yield { type: "start", requestId, modelId: request.modelId }

  let sawFinish = false
  try {
    for await (const event of inner()) {
      if (event.type === "finish") sawFinish = true
      yield event
    }
  } catch (error) {
    const err = error as Error & { status?: number; retryable?: boolean }
    yield {
      type: "error",
      error: {
        name: err.name || "Error",
        message: err.message || String(error),
        retryable: err.retryable === true,
        status: err.status,
      },
    }
    if (!sawFinish) {
      yield {
        type: "finish",
        finishReason: err.name === "AbortedError" ? "aborted" : "error",
        usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }
      sawFinish = true
    }
    return
  }

  if (!sawFinish) {
    yield {
      type: "finish",
      finishReason: "unknown",
      usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    }
  }
}

/**
 * Accumulates streamed tool-call fragments.
 *
 * Providers differ wildly here: OpenAI streams an index-keyed array of partial
 * deltas, Anthropic streams named `input_json_delta` events per content block,
 * Google sends complete calls. This buffer normalises all three.
 */
export class ToolCallBuffer {
  private readonly byKey = new Map<
    string,
    { id: string; name: string; text: string; emitted: boolean }
  >()
  private readonly order: string[] = []

  /** Registers or updates a call slot. Returns true if it is newly created. */
  open(key: string, id: string, name: string): boolean {
    const existing = this.byKey.get(key)
    if (existing) {
      if (id && existing.id !== id) existing.id = id
      if (name && existing.name !== name) existing.name = name
      return false
    }
    this.byKey.set(key, { id: id || key, name, text: "", emitted: false })
    this.order.push(key)
    return true
  }

  append(key: string, delta: string): void {
    const slot = this.byKey.get(key)
    if (!slot) {
      this.open(key, key, "")
      const created = this.byKey.get(key)
      if (created) created.text += delta
      return
    }
    slot.text += delta
  }

  has(key: string): boolean {
    return this.byKey.has(key)
  }

  id(key: string): string | undefined {
    return this.byKey.get(key)?.id
  }

  name(key: string): string | undefined {
    return this.byKey.get(key)?.name
  }

  text(key: string): string {
    return this.byKey.get(key)?.text ?? ""
  }

  /** Marks a slot emitted and returns its contents. */
  take(key: string): { id: string; name: string; text: string } | undefined {
    const slot = this.byKey.get(key)
    if (!slot || slot.emitted) return undefined
    slot.emitted = true
    return { id: slot.id, name: slot.name, text: slot.text }
  }

  /** Every slot not yet emitted, in arrival order. */
  drain(): Array<{ id: string; name: string; text: string }> {
    const out: Array<{ id: string; name: string; text: string }> = []
    for (const key of this.order) {
      const taken = this.take(key)
      if (taken && taken.name !== "") out.push(taken)
    }
    return out
  }

  get size(): number {
    return this.byKey.size
  }
}

/**
 * Tracks whether we have opened a text or reasoning block so transports can
 * emit correct start/end pairs without duplicating bookkeeping.
 */
export class BlockTracker {
  private textId?: string
  private reasoningId?: string

  *openText(): Generator<LlmStreamEvent> {
    if (this.textId) return
    this.textId = newId("part")
    yield { type: "text-start", id: this.textId }
  }

  *text(delta: string): Generator<LlmStreamEvent> {
    if (delta === "") return
    yield* this.closeReasoning()
    yield* this.openText()
    yield { type: "text-delta", id: this.textId as string, delta }
  }

  *closeText(): Generator<LlmStreamEvent> {
    if (!this.textId) return
    const id = this.textId
    this.textId = undefined
    yield { type: "text-end", id }
  }

  *openReasoning(): Generator<LlmStreamEvent> {
    if (this.reasoningId) return
    this.reasoningId = newId("part")
    yield { type: "reasoning-start", id: this.reasoningId }
  }

  *reasoning(delta: string): Generator<LlmStreamEvent> {
    if (delta === "") return
    yield* this.closeText()
    yield* this.openReasoning()
    yield { type: "reasoning-delta", id: this.reasoningId as string, delta }
  }

  *closeReasoning(signature?: string, encrypted?: string): Generator<LlmStreamEvent> {
    if (!this.reasoningId) return
    const id = this.reasoningId
    this.reasoningId = undefined
    yield { type: "reasoning-end", id, signature, encrypted }
  }

  *closeAll(): Generator<LlmStreamEvent> {
    yield* this.closeText()
    yield* this.closeReasoning()
  }
}

/** Reads a nested numeric field, tolerating snake_case and camelCase. */
export function pickNumber(source: unknown, ...keys: string[]): number {
  if (!source || typeof source !== "object") return 0
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return 0
}

export function pickString(source: unknown, ...keys: string[]): string | undefined {
  if (!source || typeof source !== "object") return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value !== "") return value
  }
  return undefined
}

export function pickObject(source: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  if (!source || typeof source !== "object") return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return undefined
}

export function pickArray(source: unknown, ...keys: string[]): unknown[] | undefined {
  if (!source || typeof source !== "object") return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return undefined
}

/**
 * Strips fields that break strict JSON Schema validators. OpenAI's strict mode
 * rejects `default`, `examples`, `$schema` and unknown keywords, while some
 * providers reject `additionalProperties: false` on nested objects.
 */
export function sanitizeSchema(
  schema: Record<string, unknown>,
  options: { strict?: boolean; dropFormats?: boolean } = {},
): Record<string, unknown> {
  const drop = new Set(["$schema", "$id", "examples", "default", "deprecated", "readOnly", "writeOnly"])
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== "object") return node
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (drop.has(key)) continue
      if (options.dropFormats && key === "format") continue
      out[key] = walk(value)
    }
    if (options.strict && out["type"] === "object") {
      out["additionalProperties"] = false
      // Strict mode requires every property listed in `required`.
      const properties = out["properties"]
      if (properties && typeof properties === "object") {
        out["required"] = Object.keys(properties as Record<string, unknown>)
      }
    }
    return out
  }
  return walk(schema) as Record<string, unknown>
}

/** Joins a base URL and a path without producing a double slash. */
export function joinUrl(base: string, path: string): string {
  if (base === "") return path
  const left = base.endsWith("/") ? base.slice(0, -1) : base
  const right = path.startsWith("/") ? path : `/${path}`
  return `${left}${right}`
}

/** Splits a data URL into mime and base64 payload. */
export function parseDataUrl(input: string): { mime: string; data: string } | undefined {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(input)
  if (!match) return undefined
  return { mime: match[1] ?? "application/octet-stream", data: match[3] ?? "" }
}

/** Normalises image content into a bare base64 payload plus mime type. */
export function normalizeImage(data: string, mime: string): { mime: string; base64: string } {
  const parsed = parseDataUrl(data)
  if (parsed) return { mime: parsed.mime, base64: parsed.data }
  return { mime, base64: data }
}
