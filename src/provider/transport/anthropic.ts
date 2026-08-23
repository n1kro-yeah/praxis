/**
 * Anthropic Messages transport.
 *
 * Notable differences from the OpenAI dialect, all of which this module hides:
 *   - the system prompt is a top-level field, not a message
 *   - content blocks are streamed with explicit index-addressed start/delta/stop
 *     events rather than a single delta object
 *   - tool arguments arrive as `input_json_delta` fragments
 *   - extended thinking produces `thinking_delta` plus a `signature_delta` that
 *     must be replayed verbatim on the next turn or the API rejects the request
 *   - prompt caching is opt-in per content block via `cache_control`, with a
 *     hard limit of four breakpoints per request
 *   - empty text blocks are rejected outright
 */

import type {
  Content,
  LlmMessage,
  LlmRequest,
  LlmStreamEvent,
  LlmUsage,
  Transport,
  TransportContext,
} from "../../llm/types.js"
import {
  mergeAdjacentRoles,
  normalizeFinishReason,
  parseToolInput,
  pruneEmptyContent,
  reconcileToolCalls,
} from "../../llm/types.js"
import { streamSse } from "../../util/http.js"
import { logger } from "../../util/log.js"
import {
  baseHeaders,
  framed,
  joinUrl,
  normalizeImage,
  pickArray,
  pickNumber,
  pickObject,
  pickString,
  sanitizeSchema,
} from "../transport.js"
import { newId } from "../../util/id.js"

const log = logger("transport.anthropic")

const API_VERSION = "2023-06-01"
/** Anthropic allows at most four cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4

/* ------------------------------------------------------------------ */
/* Request construction                                                */
/* ------------------------------------------------------------------ */

type WireBlock = Record<string, unknown>

function textBlock(text: string, cache = false): WireBlock {
  const block: WireBlock = { type: "text", text }
  if (cache) block["cache_control"] = { type: "ephemeral" }
  return block
}

function contentToBlocks(
  content: readonly Content[],
  context: TransportContext,
): WireBlock[] {
  const blocks: WireBlock[] = []
  for (const item of content) {
    switch (item.type) {
      case "text": {
        // Empty text blocks are a hard 400.
        if (item.text === "") break
        blocks.push(textBlock(item.text))
        break
      }
      case "reasoning": {
        if (item.redacted) {
          blocks.push({ type: "redacted_thinking", data: item.encrypted ?? "" })
          break
        }
        if (item.text === "") break
        // Without the original signature the block must be dropped, not sent.
        if (!item.signature) break
        blocks.push({ type: "thinking", thinking: item.text, signature: item.signature })
        break
      }
      case "image": {
        if (!context.capabilities.attachment) break
        const { mime, base64 } = normalizeImage(item.data, item.mime)
        if (base64.startsWith("http")) {
          blocks.push({ type: "image", source: { type: "url", url: base64 } })
          break
        }
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mime, data: base64 },
        })
        break
      }
      case "file": {
        if (item.mime === "application/pdf" && context.capabilities.attachment) {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: item.mime, data: item.data },
          })
          break
        }
        if (item.text) blocks.push(textBlock(item.text))
        break
      }
      case "tool-call": {
        blocks.push({
          type: "tool_use",
          id: item.toolCallId,
          name: item.toolName,
          input: item.input ?? {},
        })
        break
      }
      case "tool-result": {
        const resultContent: WireBlock[] = []
        if (item.output !== "") resultContent.push(textBlock(item.output))
        for (const image of item.attachments ?? []) {
          if (!context.capabilities.attachment) continue
          const { mime, base64 } = normalizeImage(image.data, image.mime)
          resultContent.push({
            type: "image",
            source: { type: "base64", media_type: mime, data: base64 },
          })
        }
        if (resultContent.length === 0) resultContent.push(textBlock("(no output)"))
        blocks.push({
          type: "tool_result",
          tool_use_id: item.toolCallId,
          content: resultContent,
          ...(item.isError ? { is_error: true } : {}),
        })
        break
      }
    }
  }
  return blocks
}

/**
 * Applies cache breakpoints.
 *
 * The optimal placement is at the end of the longest stable prefix: the system
 * prompt, then the tool definitions, then the last few turns before the current
 * one. We mark the system prompt and up to three message boundaries, walking
 * backwards from the second-to-last user message so the current turn stays
 * uncached (it changes every request anyway).
 */
function applyCacheControl(messages: Array<{ role: string; content: WireBlock[] }>): void {
  let remaining = MAX_CACHE_BREAKPOINTS - 1 // one reserved for the system prompt
  for (let i = messages.length - 2; i >= 0 && remaining > 0; i--) {
    const message = messages[i]
    if (!message || message.role !== "user") continue
    const last = message.content[message.content.length - 1]
    if (!last) continue
    if (last["type"] === "tool_result" || last["type"] === "text") {
      last["cache_control"] = { type: "ephemeral" }
      remaining--
      // Space breakpoints out; adjacent ones waste the budget.
      i -= 3
    }
  }
}

export function buildAnthropicBody(
  request: LlmRequest,
  context: TransportContext,
): Record<string, unknown> {
  const prepared = mergeAdjacentRoles(reconcileToolCalls(pruneEmptyContent(request.messages)))

  const messages: Array<{ role: string; content: WireBlock[] }> = []
  for (const message of prepared) {
    // The tool role does not exist here; results are user-role blocks.
    const role = message.role === "tool" ? "user" : message.role
    if (role === "system") continue
    const content = contentToBlocks(message.content, context)
    if (content.length === 0) continue
    const previous = messages[messages.length - 1]
    if (previous && previous.role === role) {
      previous.content.push(...content)
      continue
    }
    messages.push({ role, content })
  }

  // The API requires at least one message and requires it to be from the user.
  if (messages.length === 0) messages.push({ role: "user", content: [textBlock("Continue.")] })
  if (messages[0]?.role !== "user") {
    messages.unshift({ role: "user", content: [textBlock("Continue.")] })
  }

  const cacheEnabled = request.promptCache !== false && context.capabilities.promptCache
  if (cacheEnabled) applyCacheControl(messages)

  const system: WireBlock[] = []
  const systemLines = (request.system ?? []).filter((line) => line.trim() !== "")
  systemLines.forEach((line, index) => {
    system.push(textBlock(line, cacheEnabled && index === systemLines.length - 1))
  })

  const body: Record<string, unknown> = {
    model: request.modelId,
    messages,
    stream: true,
    max_tokens: request.maxOutputTokens ?? context.capabilities.maxOutputTokens,
  }
  if (system.length) body["system"] = system
  if (context.capabilities.temperature && request.temperature !== undefined) {
    body["temperature"] = request.temperature
  }
  if (request.topP !== undefined) body["top_p"] = request.topP
  if (request.topK !== undefined) body["top_k"] = request.topK
  if (request.stopSequences?.length) body["stop_sequences"] = request.stopSequences

  if (request.reasoning && context.capabilities.reasoning) {
    const budget = request.reasoning.maxTokens ?? effortToBudget(request.reasoning.effort)
    if (budget > 0) {
      body["thinking"] = { type: "enabled", budget_tokens: budget }
      // max_tokens must exceed the thinking budget.
      const maxTokens = Number(body["max_tokens"] ?? 0)
      if (maxTokens <= budget) body["max_tokens"] = budget + 4_096
      // Temperature is not allowed together with extended thinking.
      delete body["temperature"]
      delete body["top_p"]
      delete body["top_k"]
    }
  }

  if (request.tools?.length && context.capabilities.toolCall) {
    const tools = request.tools.map((tool, index) => {
      const definition: WireBlock = {
        name: tool.name,
        description: tool.description,
        input_schema: sanitizeSchema(tool.parameters, { dropFormats: true }),
      }
      // Cache the tool definitions: they are large and never change.
      if (cacheEnabled && index === (request.tools?.length ?? 0) - 1) {
        definition["cache_control"] = { type: "ephemeral" }
      }
      return definition
    })
    body["tools"] = tools
    const choice = request.toolChoice
    if (choice && choice.type !== "auto") {
      if (choice.type === "none") body["tool_choice"] = { type: "none" }
      else if (choice.type === "required") body["tool_choice"] = { type: "any" }
      else body["tool_choice"] = { type: "tool", name: choice.name }
    }
    if (request.parallelToolCalls === false) {
      body["tool_choice"] = {
        ...(body["tool_choice"] as object | undefined),
        type: (body["tool_choice"] as { type?: string } | undefined)?.type ?? "auto",
        disable_parallel_tool_use: true,
      }
    }
  }

  return { ...body, ...(request.providerOptions ?? {}) }
}

function effortToBudget(effort: string | undefined): number {
  switch (effort) {
    case "minimal":
      return 1_024
    case "low":
      return 4_096
    case "medium":
      return 10_240
    case "high":
      return 24_576
    default:
      return 0
  }
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

interface OpenBlock {
  kind: "text" | "thinking" | "tool" | "other"
  id: string
  toolId?: string
  toolName?: string
  buffer: string
  signature?: string
}

function anthropicUsage(payload: unknown): LlmUsage {
  const usage = pickObject(payload, "usage") ?? {}
  return {
    input: pickNumber(usage, "input_tokens"),
    output: pickNumber(usage, "output_tokens"),
    reasoning: 0,
    cacheRead: pickNumber(usage, "cache_read_input_tokens"),
    cacheWrite: pickNumber(usage, "cache_creation_input_tokens"),
  }
}

async function* streamAnthropic(
  request: LlmRequest,
  context: TransportContext,
): AsyncGenerator<LlmStreamEvent> {
  const url = joinUrl(context.baseUrl, "/v1/messages")
  const headers = baseHeaders(context, request, "x-api-key")
  headers["anthropic-version"] = String(context.options["apiVersion"] ?? API_VERSION)
  const beta: string[] = []
  if (context.capabilities.promptCache) beta.push("prompt-caching-2024-07-31")
  if (context.capabilities.contextWindow > 200_000) beta.push("context-1m-2025-08-07")
  if (beta.length) headers["anthropic-beta"] = beta.join(",")
  // OAuth credentials use a bearer token instead of the API key header.
  if (context.options["oauth"] === true && context.apiKey) {
    delete headers["x-api-key"]
    headers["authorization"] = `Bearer ${context.apiKey}`
  }

  const body = buildAnthropicBody(request, context)
  const blocks = new Map<number, OpenBlock>()
  let usage: LlmUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let stopReason = "unknown"

  const events = streamSse(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    query: context.query,
    timeoutMs: context.timeoutMs,
    retries: context.retries,
    signal: request.signal,
  })

  for await (const event of events) {
    if (event.data === "" || event.data === "[DONE]") continue
    let payload: unknown
    try {
      payload = JSON.parse(event.data)
    } catch {
      log.debug("unparseable chunk", { data: event.data.slice(0, 200) })
      continue
    }

    const type = pickString(payload, "type") ?? event.event ?? ""

    switch (type) {
      case "message_start": {
        const message = pickObject(payload, "message")
        if (message) usage = anthropicUsage(message)
        break
      }

      case "content_block_start": {
        const index = pickNumber(payload, "index")
        const block = pickObject(payload, "content_block") ?? {}
        const blockType = pickString(block, "type") ?? ""
        if (blockType === "text") {
          const id = newId("part")
          blocks.set(index, { kind: "text", id, buffer: "" })
          yield { type: "text-start", id }
          const initial = pickString(block, "text")
          if (initial) yield { type: "text-delta", id, delta: initial }
          break
        }
        if (blockType === "thinking" || blockType === "redacted_thinking") {
          const id = newId("part")
          blocks.set(index, { kind: "thinking", id, buffer: "" })
          yield { type: "reasoning-start", id }
          break
        }
        if (blockType === "tool_use" || blockType === "server_tool_use") {
          const toolId = pickString(block, "id") ?? newId("tool")
          const toolName = pickString(block, "name") ?? ""
          blocks.set(index, {
            kind: "tool",
            id: newId("part"),
            toolId,
            toolName,
            buffer: "",
          })
          yield { type: "tool-call-start", toolCallId: toolId, toolName }
          break
        }
        blocks.set(index, { kind: "other", id: newId("part"), buffer: "" })
        break
      }

      case "content_block_delta": {
        const index = pickNumber(payload, "index")
        const open = blocks.get(index)
        if (!open) break
        const delta = pickObject(payload, "delta") ?? {}
        const deltaType = pickString(delta, "type") ?? ""

        if (deltaType === "text_delta") {
          const text = pickString(delta, "text") ?? ""
          if (text !== "") yield { type: "text-delta", id: open.id, delta: text }
          break
        }
        if (deltaType === "thinking_delta") {
          const text = pickString(delta, "thinking") ?? ""
          if (text !== "") yield { type: "reasoning-delta", id: open.id, delta: text }
          break
        }
        if (deltaType === "signature_delta") {
          open.signature = (open.signature ?? "") + (pickString(delta, "signature") ?? "")
          break
        }
        if (deltaType === "input_json_delta") {
          const fragment = pickString(delta, "partial_json") ?? ""
          if (fragment !== "") {
            open.buffer += fragment
            yield {
              type: "tool-call-delta",
              toolCallId: open.toolId ?? open.id,
              delta: fragment,
            }
          }
          break
        }
        break
      }

      case "content_block_stop": {
        const index = pickNumber(payload, "index")
        const open = blocks.get(index)
        if (!open) break
        blocks.delete(index)
        if (open.kind === "text") {
          yield { type: "text-end", id: open.id }
          break
        }
        if (open.kind === "thinking") {
          yield { type: "reasoning-end", id: open.id, signature: open.signature }
          break
        }
        if (open.kind === "tool") {
          yield {
            type: "tool-call",
            toolCallId: open.toolId ?? open.id,
            toolName: open.toolName ?? "",
            input: parseToolInput(open.buffer),
            inputText: open.buffer,
          }
          break
        }
        break
      }

      case "message_delta": {
        const delta = pickObject(payload, "delta")
        const reason = pickString(delta, "stop_reason")
        if (reason) stopReason = reason
        const deltaUsage = anthropicUsage(payload)
        // message_delta reports cumulative output tokens.
        if (deltaUsage.output > 0) usage = { ...usage, output: deltaUsage.output }
        break
      }

      case "message_stop":
        break

      case "error": {
        const error = pickObject(payload, "error") ?? {}
        const message = pickString(error, "message") ?? "provider error"
        const kind = pickString(error, "type") ?? "ProviderError"
        yield {
          type: "error",
          error: {
            name: kind,
            message,
            retryable: kind === "overloaded_error" || kind === "rate_limit_error",
          },
        }
        break
      }

      case "ping":
      default:
        break
    }
  }

  // Close anything the server left open (interrupted stream).
  for (const open of blocks.values()) {
    if (open.kind === "text") yield { type: "text-end", id: open.id }
    if (open.kind === "thinking") yield { type: "reasoning-end", id: open.id, signature: open.signature }
    if (open.kind === "tool") {
      yield {
        type: "tool-call",
        toolCallId: open.toolId ?? open.id,
        toolName: open.toolName ?? "",
        input: parseToolInput(open.buffer),
        inputText: open.buffer,
      }
    }
  }

  yield {
    type: "finish",
    finishReason: normalizeFinishReason(stopReason),
    usage,
  }
}

export const AnthropicTransport: Transport = {
  id: "anthropic",
  stream(request, context) {
    return framed(request, () => streamAnthropic(request, context))
  },
}

export { streamAnthropic }
