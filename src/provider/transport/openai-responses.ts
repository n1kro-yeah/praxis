/**
 * OpenAI Responses API transport.
 *
 * The Responses API is required for the newest reasoning models because it is
 * the only endpoint that returns encrypted reasoning items, which must be
 * replayed on subsequent turns to preserve the chain of thought across tool
 * calls. Without that replay, reasoning models restart their thinking on every
 * step and both quality and cost degrade sharply.
 *
 * Structural differences from Chat Completions:
 *   - `input` is a flat array of typed items, not messages with content arrays
 *   - function calls and their outputs are separate top-level items linked by
 *     `call_id`
 *   - reasoning is its own item type carrying an opaque `encrypted_content`
 *   - streaming is a rich typed event feed (`response.output_text.delta`, …)
 *   - `store: false` plus `include: ["reasoning.encrypted_content"]` is needed
 *     for stateless operation
 */

import type {
  Content,
  LlmRequest,
  LlmStreamEvent,
  LlmUsage,
  Transport,
  TransportContext,
} from "../../llm/types.js"
import {
  normalizeFinishReason,
  parseToolInput,
  pruneEmptyContent,
  reconcileToolCalls,
} from "../../llm/types.js"
import { newId } from "../../util/id.js"
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

const log = logger("transport.openai-responses")

/* ------------------------------------------------------------------ */
/* Request construction                                                */
/* ------------------------------------------------------------------ */

type InputItem = Record<string, unknown>

function userContent(content: readonly Content[], context: TransportContext): InputItem[] {
  const parts: InputItem[] = []
  for (const item of content) {
    if (item.type === "text") {
      if (item.text !== "") parts.push({ type: "input_text", text: item.text })
      continue
    }
    if (item.type === "image" && context.capabilities.attachment) {
      const { mime, base64 } = normalizeImage(item.data, item.mime)
      const url = base64.startsWith("http") ? base64 : `data:${mime};base64,${base64}`
      parts.push({ type: "input_image", image_url: url, detail: "auto" })
      continue
    }
    if (item.type === "file") {
      if (item.mime === "application/pdf") {
        parts.push({
          type: "input_file",
          filename: item.filename ?? "document.pdf",
          file_data: `data:${item.mime};base64,${item.data}`,
        })
        continue
      }
      if (item.text) parts.push({ type: "input_text", text: item.text })
      continue
    }
  }
  return parts
}

export function buildResponsesInput(
  request: LlmRequest,
  context: TransportContext,
): InputItem[] {
  const items: InputItem[] = []
  const prepared = reconcileToolCalls(pruneEmptyContent(request.messages))

  for (const message of prepared) {
    if (message.role === "tool") {
      for (const item of message.content) {
        if (item.type !== "tool-result") continue
        items.push({
          type: "function_call_output",
          call_id: item.toolCallId,
          output: item.output === "" ? "(no output)" : item.output,
        })
        // Images from a tool must be re-sent as a user message.
        if (item.attachments?.length && context.capabilities.attachment) {
          items.push({
            type: "message",
            role: "user",
            content: item.attachments.map((image) => {
              const { mime, base64 } = normalizeImage(image.data, image.mime)
              return {
                type: "input_image",
                image_url: `data:${mime};base64,${base64}`,
                detail: "auto",
              }
            }),
          })
        }
      }
      continue
    }

    if (message.role === "assistant") {
      // Reasoning items must come before the calls they produced.
      for (const item of message.content) {
        if (item.type !== "reasoning") continue
        if (!item.encrypted && !item.text) continue
        items.push({
          type: "reasoning",
          id: item.id ?? newId("part"),
          ...(item.encrypted ? { encrypted_content: item.encrypted } : {}),
          summary: item.text ? [{ type: "summary_text", text: item.text }] : [],
        })
      }
      const text = message.content
        .filter((item): item is Extract<Content, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("")
      if (text !== "") {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        })
      }
      for (const item of message.content) {
        if (item.type !== "tool-call") continue
        items.push({
          type: "function_call",
          call_id: item.toolCallId,
          name: item.toolName,
          arguments: item.inputText ?? JSON.stringify(item.input ?? {}),
        })
      }
      continue
    }

    const content = userContent(message.content, context)
    if (content.length === 0) continue
    items.push({ type: "message", role: message.role, content })
  }

  return items
}

export function buildResponsesBody(
  request: LlmRequest,
  context: TransportContext,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    input: buildResponsesInput(request, context),
    stream: true,
    // Stateless operation: we keep the transcript, not OpenAI.
    store: false,
  }

  const systemLines = (request.system ?? []).filter((line) => line.trim() !== "")
  if (systemLines.length) body["instructions"] = systemLines.join("\n\n")

  if (request.maxOutputTokens) body["max_output_tokens"] = request.maxOutputTokens
  if (context.capabilities.temperature && request.temperature !== undefined) {
    body["temperature"] = request.temperature
  }
  if (request.topP !== undefined) body["top_p"] = request.topP

  if (context.capabilities.reasoning) {
    body["reasoning"] = {
      effort: request.reasoning?.effort ?? "medium",
      summary: "auto",
    }
    // Required for the encrypted reasoning replay described above.
    body["include"] = ["reasoning.encrypted_content"]
  }

  if (request.tools?.length && context.capabilities.toolCall) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: sanitizeSchema(tool.parameters, { strict: tool.strict === true }),
      strict: tool.strict === true,
    }))
    const choice = request.toolChoice
    if (!choice || choice.type === "auto") body["tool_choice"] = "auto"
    else if (choice.type === "none") body["tool_choice"] = "none"
    else if (choice.type === "required") body["tool_choice"] = "required"
    else body["tool_choice"] = { type: "function", name: choice.name }
    if (request.parallelToolCalls === false) body["parallel_tool_calls"] = false
  }

  if (request.responseFormat?.type === "json") {
    body["text"] = { format: { type: "json_object" } }
  }
  if (request.responseFormat?.type === "json-schema") {
    body["text"] = {
      format: {
        type: "json_schema",
        name: request.responseFormat.name,
        schema: sanitizeSchema(request.responseFormat.schema, { strict: true }),
        strict: request.responseFormat.strict === true,
      },
    }
  }

  return { ...body, ...(request.providerOptions ?? {}) }
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

function responsesUsage(payload: unknown): LlmUsage | undefined {
  const response = pickObject(payload, "response")
  const usage = pickObject(response ?? payload, "usage")
  if (!usage) return undefined
  const inputDetails = pickObject(usage, "input_tokens_details")
  const outputDetails = pickObject(usage, "output_tokens_details")
  const cached = pickNumber(inputDetails, "cached_tokens")
  return {
    input: Math.max(0, pickNumber(usage, "input_tokens") - cached),
    output: pickNumber(usage, "output_tokens"),
    reasoning: pickNumber(outputDetails, "reasoning_tokens"),
    cacheRead: cached,
    cacheWrite: 0,
    total: pickNumber(usage, "total_tokens") || undefined,
  }
}

interface OutputSlot {
  kind: "message" | "reasoning" | "function" | "other"
  partId: string
  callId?: string
  name?: string
  buffer: string
  encrypted?: string
  opened: boolean
}

async function* streamResponses(
  request: LlmRequest,
  context: TransportContext,
): AsyncGenerator<LlmStreamEvent> {
  const url = joinUrl(context.baseUrl, "/responses")
  const body = buildResponsesBody(request, context)
  const slots = new Map<number, OutputSlot>()

  let usage: LlmUsage | undefined
  let status = "unknown"
  let sawToolCall = false

  const events = streamSse(url, {
    method: "POST",
    headers: baseHeaders(context, request),
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
    const index = pickNumber(payload, "output_index")

    switch (type) {
      case "response.created":
      case "response.in_progress":
        break

      case "response.output_item.added": {
        const item = pickObject(payload, "item") ?? {}
        const itemType = pickString(item, "type") ?? ""
        if (itemType === "message") {
          slots.set(index, { kind: "message", partId: newId("part"), buffer: "", opened: false })
          break
        }
        if (itemType === "reasoning") {
          slots.set(index, {
            kind: "reasoning",
            partId: pickString(item, "id") ?? newId("part"),
            buffer: "",
            opened: false,
          })
          break
        }
        if (itemType === "function_call") {
          const callId = pickString(item, "call_id") ?? pickString(item, "id") ?? newId("tool")
          const name = pickString(item, "name") ?? ""
          slots.set(index, {
            kind: "function",
            partId: newId("part"),
            callId,
            name,
            buffer: "",
            opened: true,
          })
          yield { type: "tool-call-start", toolCallId: callId, toolName: name }
          break
        }
        slots.set(index, { kind: "other", partId: newId("part"), buffer: "", opened: false })
        break
      }

      case "response.output_text.delta": {
        const slot = slots.get(index) ?? {
          kind: "message" as const,
          partId: newId("part"),
          buffer: "",
          opened: false,
        }
        slots.set(index, slot)
        if (!slot.opened) {
          slot.opened = true
          yield { type: "text-start", id: slot.partId }
        }
        const delta = pickString(payload, "delta") ?? ""
        if (delta !== "") yield { type: "text-delta", id: slot.partId, delta }
        break
      }

      case "response.output_text.done": {
        const slot = slots.get(index)
        if (slot?.opened && slot.kind === "message") {
          slot.opened = false
          yield { type: "text-end", id: slot.partId }
        }
        break
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const slot = slots.get(index) ?? {
          kind: "reasoning" as const,
          partId: newId("part"),
          buffer: "",
          opened: false,
        }
        slots.set(index, slot)
        if (!slot.opened) {
          slot.opened = true
          yield { type: "reasoning-start", id: slot.partId }
        }
        const delta = pickString(payload, "delta") ?? ""
        if (delta !== "") yield { type: "reasoning-delta", id: slot.partId, delta }
        break
      }

      case "response.reasoning_summary_text.done":
      case "response.reasoning_text.done":
        break

      case "response.function_call_arguments.delta": {
        const slot = slots.get(index)
        if (!slot) break
        const delta = pickString(payload, "delta") ?? ""
        if (delta === "") break
        slot.buffer += delta
        yield {
          type: "tool-call-delta",
          toolCallId: slot.callId ?? slot.partId,
          delta,
        }
        break
      }

      case "response.function_call_arguments.done": {
        const slot = slots.get(index)
        if (!slot) break
        const complete = pickString(payload, "arguments") ?? slot.buffer
        slot.buffer = complete
        break
      }

      case "response.output_item.done": {
        const slot = slots.get(index)
        const item = pickObject(payload, "item") ?? {}
        if (!slot) break
        slots.delete(index)

        if (slot.kind === "message" && slot.opened) {
          yield { type: "text-end", id: slot.partId }
          break
        }
        if (slot.kind === "reasoning") {
          const encrypted = pickString(item, "encrypted_content")
          if (slot.opened) {
            yield { type: "reasoning-end", id: slot.partId, encrypted }
          } else if (encrypted) {
            // Reasoning with no visible summary still has to be replayed.
            yield { type: "reasoning-start", id: slot.partId }
            yield { type: "reasoning-end", id: slot.partId, encrypted }
          }
          break
        }
        if (slot.kind === "function") {
          const args = pickString(item, "arguments") ?? slot.buffer
          yield {
            type: "tool-call",
            toolCallId: slot.callId ?? slot.partId,
            toolName: slot.name ?? pickString(item, "name") ?? "",
            input: parseToolInput(args),
            inputText: args,
          }
          sawToolCall = true
          break
        }
        break
      }

      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const response = pickObject(payload, "response")
        status = pickString(response, "status") ?? type.replace("response.", "")
        const parsed = responsesUsage(payload)
        if (parsed) usage = parsed
        const incomplete = pickObject(response, "incomplete_details")
        const reason = pickString(incomplete, "reason")
        if (reason === "max_output_tokens") status = "length"
        if (reason === "content_filter") status = "content_filter"
        break
      }

      case "error":
      case "response.error": {
        const error = pickObject(payload, "error") ?? payload
        const code = pickNumber(error, "code", "status")
        yield {
          type: "error",
          error: {
            name: pickString(error, "type", "code") ?? "ProviderError",
            message: pickString(error, "message") ?? "provider error",
            retryable: code === 429 || code >= 500,
            status: code || undefined,
          },
        }
        break
      }

      default:
        break
    }
  }

  // Clean up anything left open.
  for (const slot of slots.values()) {
    if (slot.kind === "message" && slot.opened) yield { type: "text-end", id: slot.partId }
    if (slot.kind === "reasoning" && slot.opened) yield { type: "reasoning-end", id: slot.partId }
    if (slot.kind === "function") {
      yield {
        type: "tool-call",
        toolCallId: slot.callId ?? slot.partId,
        toolName: slot.name ?? "",
        input: parseToolInput(slot.buffer),
        inputText: slot.buffer,
      }
      sawToolCall = true
    }
  }

  const normalized = normalizeFinishReason(status)
  yield {
    type: "finish",
    finishReason:
      sawToolCall && (normalized === "stop" || normalized === "unknown")
        ? "tool-calls"
        : normalized,
    usage: usage ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

export const OpenAIResponsesTransport: Transport = {
  id: "openai-responses",
  stream(request, context) {
    return framed(request, () => streamResponses(request, context))
  },
}
