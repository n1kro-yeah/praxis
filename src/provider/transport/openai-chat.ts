/**
 * OpenAI Chat Completions transport.
 *
 * This is the workhorse: roughly two thirds of the providers in the catalog
 * speak this dialect, so the implementation has to be tolerant of every
 * near-compatible variation observed in the wild:
 *
 *   - `delta.reasoning_content` (DeepSeek), `delta.reasoning` (OpenRouter),
 *     `delta.thinking` (some proxies)
 *   - tool calls streamed with or without an `index`, with ids arriving late
 *   - usage reported only when `stream_options.include_usage` is set, or
 *     reported on every chunk, or never
 *   - `finish_reason` on the choice or on the chunk
 *   - servers that emit a single non-streaming JSON body despite `stream: true`
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
  BlockTracker,
  baseHeaders,
  framed,
  joinUrl,
  normalizeImage,
  pickArray,
  pickNumber,
  pickObject,
  pickString,
  sanitizeSchema,
  ToolCallBuffer,
} from "../transport.js"

const log = logger("transport.openai-chat")

/* ------------------------------------------------------------------ */
/* Request construction                                                */
/* ------------------------------------------------------------------ */

interface WireMessage {
  role: string
  content?: string | unknown[] | null
  name?: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  reasoning_content?: string
}

function contentToWire(content: readonly Content[], allowImages: boolean): string | unknown[] {
  // A single text block is sent as a bare string: some servers reject arrays.
  if (content.length === 1 && content[0]?.type === "text") {
    return (content[0] as { text: string }).text
  }
  const parts: unknown[] = []
  for (const item of content) {
    if (item.type === "text") {
      parts.push({ type: "text", text: item.text })
      continue
    }
    if (item.type === "image" && allowImages) {
      const { mime, base64 } = normalizeImage(item.data, item.mime)
      const url = base64.startsWith("http") ? base64 : `data:${mime};base64,${base64}`
      parts.push({ type: "image_url", image_url: { url } })
      continue
    }
    if (item.type === "file") {
      // Text files are inlined; binaries are described rather than dropped.
      parts.push({
        type: "text",
        text: `[attached file: ${item.filename ?? "unnamed"} (${item.mime})]`,
      })
      continue
    }
  }
  if (parts.length === 0) return ""
  return parts
}

export function toWireMessages(
  request: LlmRequest,
  context: TransportContext,
): WireMessage[] {
  const out: WireMessage[] = []

  for (const line of request.system ?? []) {
    if (line.trim() === "") continue
    // Reasoning models want `developer` rather than `system`.
    const role = context.capabilities.reasoning && isOpenAiNative(context) ? "developer" : "system"
    out.push({ role, content: line })
  }

  const prepared = mergeAdjacentRoles(reconcileToolCalls(pruneEmptyContent(request.messages)))

  for (const message of prepared) {
    if (message.role === "tool") {
      for (const item of message.content) {
        if (item.type !== "tool-result") continue
        out.push({
          role: "tool",
          tool_call_id: item.toolCallId,
          content: item.output === "" ? "(no output)" : item.output,
        })
        // Tool images have to be re-sent as a user message; the tool role does
        // not support multimodal content in this API.
        if (item.attachments?.length && context.capabilities.attachment) {
          out.push({
            role: "user",
            content: item.attachments.map((image) => {
              const { mime, base64 } = normalizeImage(image.data, image.mime)
              return { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } }
            }),
          })
        }
      }
      continue
    }

    if (message.role === "assistant") {
      const toolCalls = message.content.filter((item) => item.type === "tool-call")
      const wire: WireMessage = { role: "assistant" }
      const text = message.content
        .filter((item): item is Extract<Content, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("")
      wire.content = text === "" ? null : text
      const reasoning = message.content
        .filter((item): item is Extract<Content, { type: "reasoning" }> => item.type === "reasoning")
        .map((item) => item.text)
        .join("")
      if (reasoning !== "" && context.capabilities.reasoning) wire.reasoning_content = reasoning
      if (toolCalls.length) {
        wire.tool_calls = toolCalls.map((item) => {
          const call = item as Extract<Content, { type: "tool-call" }>
          return {
            id: call.toolCallId,
            type: "function" as const,
            function: {
              name: call.toolName,
              arguments: call.inputText ?? JSON.stringify(call.input ?? {}),
            },
          }
        })
      }
      out.push(wire)
      continue
    }

    out.push({
      role: message.role,
      content: contentToWire(message.content, context.capabilities.attachment),
      ...(message.name ? { name: message.name } : {}),
    })
  }

  return out
}

function isOpenAiNative(context: TransportContext): boolean {
  return context.providerId === "openai" || context.providerId === "azure"
}

export function buildChatBody(
  request: LlmRequest,
  context: TransportContext,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: toWireMessages(request, context),
    stream: true,
  }

  // Usage is opt-in on the streaming endpoint.
  body["stream_options"] = { include_usage: true }

  if (request.maxOutputTokens) {
    // Reasoning models renamed the field and reject the old one.
    if (context.capabilities.reasoning && isOpenAiNative(context)) {
      body["max_completion_tokens"] = request.maxOutputTokens
    } else {
      body["max_tokens"] = request.maxOutputTokens
    }
  }
  if (context.capabilities.temperature && request.temperature !== undefined) {
    body["temperature"] = request.temperature
  }
  if (request.topP !== undefined) body["top_p"] = request.topP
  if (request.frequencyPenalty !== undefined) body["frequency_penalty"] = request.frequencyPenalty
  if (request.presencePenalty !== undefined) body["presence_penalty"] = request.presencePenalty
  if (request.stopSequences?.length) body["stop"] = request.stopSequences
  if (request.seed !== undefined) body["seed"] = request.seed

  if (request.reasoning?.effort && context.capabilities.reasoning) {
    body["reasoning_effort"] = request.reasoning.effort
  }

  if (request.tools?.length && context.capabilities.toolCall) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitizeSchema(tool.parameters, { strict: tool.strict === true }),
        ...(tool.strict ? { strict: true } : {}),
      },
    }))
    body["tool_choice"] = toolChoiceToWire(request)
    if (request.parallelToolCalls === false) body["parallel_tool_calls"] = false
  }

  if (request.responseFormat) {
    if (request.responseFormat.type === "json") body["response_format"] = { type: "json_object" }
    if (request.responseFormat.type === "json-schema") {
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: request.responseFormat.name,
          schema: sanitizeSchema(request.responseFormat.schema, {
            strict: request.responseFormat.strict === true,
          }),
          strict: request.responseFormat.strict === true,
        },
      }
    }
  }

  return { ...body, ...context.options["body"] as object, ...(request.providerOptions ?? {}) }
}

function toolChoiceToWire(request: LlmRequest): unknown {
  const choice = request.toolChoice
  if (!choice || choice.type === "auto") return "auto"
  if (choice.type === "none") return "none"
  if (choice.type === "required") return "required"
  return { type: "function", function: { name: choice.name } }
}

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

function parseUsage(payload: unknown): LlmUsage | undefined {
  const usage = pickObject(payload, "usage")
  if (!usage) return undefined
  const promptDetails = pickObject(usage, "prompt_tokens_details", "promptTokensDetails")
  const completionDetails = pickObject(
    usage,
    "completion_tokens_details",
    "completionTokensDetails",
  )
  const cachedInput = pickNumber(promptDetails, "cached_tokens", "cachedTokens")
  const promptTokens = pickNumber(usage, "prompt_tokens", "promptTokens", "input_tokens")
  return {
    // Providers include cached tokens in prompt_tokens; subtract to avoid
    // double-billing them at the full input rate.
    input: Math.max(0, promptTokens - cachedInput),
    output: pickNumber(usage, "completion_tokens", "completionTokens", "output_tokens"),
    reasoning: pickNumber(completionDetails, "reasoning_tokens", "reasoningTokens"),
    cacheRead: cachedInput || pickNumber(usage, "cache_read_input_tokens"),
    cacheWrite: pickNumber(usage, "cache_creation_input_tokens"),
    total: pickNumber(usage, "total_tokens", "totalTokens") || undefined,
  }
}

function reasoningDelta(delta: Record<string, unknown>): string {
  const direct = pickString(delta, "reasoning_content", "reasoning", "thinking")
  if (direct) return direct
  // OpenRouter nests reasoning under an array of blocks.
  const blocks = pickArray(delta, "reasoning_details", "reasoningDetails")
  if (blocks) {
    return blocks
      .map((block) => pickString(block, "text", "summary", "content") ?? "")
      .join("")
  }
  return ""
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function* streamChat(
  request: LlmRequest,
  context: TransportContext,
  pathOverride?: string,
): AsyncGenerator<LlmStreamEvent> {
  const url = pathOverride ?? joinUrl(context.baseUrl, "/chat/completions")
  const body = buildChatBody(request, context)
  const tracker = new BlockTracker()
  const tools = new ToolCallBuffer()

  let usage: LlmUsage | undefined
  let finishReason = "unknown"
  let sawContent = false

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
    if (event.data === "[DONE]") break
    if (event.data === "" || event.data.startsWith(":")) continue

    let payload: unknown
    try {
      payload = JSON.parse(event.data)
    } catch {
      log.debug("unparseable chunk", { data: event.data.slice(0, 200) })
      continue
    }

    // Some gateways send an error object mid-stream instead of an HTTP status.
    const error = pickObject(payload, "error")
    if (error) {
      const message = pickString(error, "message") ?? "provider returned an error"
      const status = pickNumber(error, "code", "status")
      yield {
        type: "error",
        error: {
          name: pickString(error, "type", "code") ?? "ProviderError",
          message,
          retryable: status === 429 || status >= 500,
          status: status || undefined,
        },
      }
      continue
    }

    const parsedUsage = parseUsage(payload)
    if (parsedUsage) usage = parsedUsage

    const choices = pickArray(payload, "choices")
    if (!choices || choices.length === 0) continue

    for (const choice of choices) {
      const reason = pickString(choice, "finish_reason", "finishReason")
      if (reason) finishReason = reason

      // Non-streaming body delivered despite stream:true.
      const message = pickObject(choice, "message")
      const delta = pickObject(choice, "delta") ?? message
      if (!delta) continue

      const reasoning = reasoningDelta(delta)
      if (reasoning !== "") {
        sawContent = true
        yield* tracker.reasoning(reasoning)
      }

      const contentValue = delta["content"]
      if (typeof contentValue === "string" && contentValue !== "") {
        sawContent = true
        yield* tracker.text(contentValue)
      } else if (Array.isArray(contentValue)) {
        // Some providers stream content as an array of typed blocks.
        for (const block of contentValue) {
          const text = pickString(block, "text")
          if (text) {
            sawContent = true
            yield* tracker.text(text)
          }
        }
      }

      const toolCalls = pickArray(delta, "tool_calls", "toolCalls")
      if (toolCalls) {
        for (let position = 0; position < toolCalls.length; position++) {
          const call = toolCalls[position]
          const index = pickNumber(call, "index")
          const key = String(
            (call as Record<string, unknown>)["index"] !== undefined ? index : position,
          )
          const id = pickString(call, "id") ?? ""
          const fn = pickObject(call, "function") ?? {}
          const name = pickString(fn, "name") ?? ""
          const args = typeof fn["arguments"] === "string" ? (fn["arguments"] as string) : ""

          const created = tools.open(key, id, name)
          if (created && name !== "") {
            yield* tracker.closeAll()
            yield { type: "tool-call-start", toolCallId: tools.id(key) as string, toolName: name }
          }
          if (args !== "") {
            tools.append(key, args)
            yield { type: "tool-call-delta", toolCallId: tools.id(key) as string, delta: args }
          }
        }
      }

      // Legacy single function_call field.
      const functionCall = pickObject(delta, "function_call")
      if (functionCall) {
        const name = pickString(functionCall, "name") ?? ""
        const args =
          typeof functionCall["arguments"] === "string" ? (functionCall["arguments"] as string) : ""
        const created = tools.open("legacy", "legacy", name)
        if (created && name !== "") {
          yield { type: "tool-call-start", toolCallId: "legacy", toolName: name }
        }
        if (args !== "") tools.append("legacy", args)
      }
    }
  }

  yield* tracker.closeAll()

  for (const call of tools.drain()) {
    yield {
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: parseToolInput(call.text),
      inputText: call.text,
    }
  }

  const normalized = normalizeFinishReason(finishReason)
  const resolved =
    normalized === "unknown" && tools.size > 0
      ? "tool-calls"
      : normalized === "unknown" && sawContent
        ? "stop"
        : normalized

  yield {
    type: "finish",
    finishReason: resolved,
    usage: usage ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

export const OpenAIChatTransport: Transport = {
  id: "openai-chat",
  stream(request, context) {
    return framed(request, () => streamChat(request, context))
  },
  async listModels(context) {
    const { getJson } = await import("../../util/http.js")
    const response = await getJson<{ data?: Array<{ id?: string }> }>(
      joinUrl(context.baseUrl, "/models"),
      {
        headers: context.apiKey ? { authorization: `Bearer ${context.apiKey}` } : {},
        timeoutMs: 10_000,
        retries: 1,
      },
    )
    return (response.data?.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort()
  },
}

/** Exposed so the Azure and Copilot transports can reuse the parser. */
export { streamChat as streamOpenAiChat }
