/**
 * Cohere v2 Chat transport.
 *
 * Cohere's v2 API is close to the OpenAI dialect but with its own naming and a
 * fully typed streaming event feed:
 *   - `messages` with `content` as either a string or a list of typed blocks
 *   - tool results use role `tool` with `tool_call_id` and a `content` list of
 *     `{ type: "document", document: { data } }` objects
 *   - streaming events are `content-start`, `content-delta`, `content-end`,
 *     `tool-plan-delta`, `tool-call-start`, `tool-call-delta`, `tool-call-end`,
 *     `message-end`
 *   - the model's pre-call planning text arrives as `tool-plan-delta`, which we
 *     surface as reasoning because that is exactly what it is
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
  BlockTracker,
  baseHeaders,
  framed,
  joinUrl,
  pickArray,
  pickNumber,
  pickObject,
  pickString,
  sanitizeSchema,
} from "../transport.js"

const log = logger("transport.cohere")

/* ------------------------------------------------------------------ */
/* Request construction                                                */
/* ------------------------------------------------------------------ */

interface CohereMessage {
  role: string
  content?: unknown
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  tool_plan?: string
}

function toCohereMessages(request: LlmRequest, context: TransportContext): CohereMessage[] {
  const out: CohereMessage[] = []

  for (const line of request.system ?? []) {
    if (line.trim() === "") continue
    out.push({ role: "system", content: line })
  }

  const prepared = reconcileToolCalls(pruneEmptyContent(request.messages))

  for (const message of prepared) {
    if (message.role === "tool") {
      for (const item of message.content) {
        if (item.type !== "tool-result") continue
        out.push({
          role: "tool",
          tool_call_id: item.toolCallId,
          content: [
            {
              type: "document",
              document: {
                data: item.output === "" ? "(no output)" : item.output,
              },
            },
          ],
        })
      }
      continue
    }

    if (message.role === "assistant") {
      const wire: CohereMessage = { role: "assistant" }
      const text = message.content
        .filter((item): item is Extract<Content, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("")
      const plan = message.content
        .filter((item): item is Extract<Content, { type: "reasoning" }> => item.type === "reasoning")
        .map((item) => item.text)
        .join("")
      if (text !== "") wire.content = text
      if (plan !== "") wire.tool_plan = plan
      const calls = message.content.filter(
        (item): item is Extract<Content, { type: "tool-call" }> => item.type === "tool-call",
      )
      if (calls.length) {
        wire.tool_calls = calls.map((call) => ({
          id: call.toolCallId,
          type: "function" as const,
          function: {
            name: call.toolName,
            arguments: call.inputText ?? JSON.stringify(call.input ?? {}),
          },
        }))
      }
      if (wire.content === undefined && !wire.tool_calls && wire.tool_plan === undefined) continue
      out.push(wire)
      continue
    }

    const blocks: unknown[] = []
    for (const item of message.content) {
      if (item.type === "text" && item.text !== "") blocks.push({ type: "text", text: item.text })
      else if (item.type === "image" && context.capabilities.attachment) {
        const url = item.data.startsWith("http")
          ? item.data
          : `data:${item.mime};base64,${item.data}`
        blocks.push({ type: "image_url", image_url: { url } })
      } else if (item.type === "file" && item.text) {
        blocks.push({ type: "text", text: item.text })
      }
    }
    if (blocks.length === 0) continue
    out.push({
      role: message.role,
      content: blocks.length === 1 && (blocks[0] as { type?: string }).type === "text"
        ? (blocks[0] as { text: string }).text
        : blocks,
    })
  }

  return out
}

export function buildCohereBody(
  request: LlmRequest,
  context: TransportContext,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: toCohereMessages(request, context),
    stream: true,
  }
  if (request.maxOutputTokens) body["max_tokens"] = request.maxOutputTokens
  if (context.capabilities.temperature && request.temperature !== undefined) {
    body["temperature"] = request.temperature
  }
  if (request.topP !== undefined) body["p"] = request.topP
  if (request.topK !== undefined) body["k"] = request.topK
  if (request.stopSequences?.length) body["stop_sequences"] = request.stopSequences
  if (request.seed !== undefined) body["seed"] = request.seed
  if (request.frequencyPenalty !== undefined) body["frequency_penalty"] = request.frequencyPenalty
  if (request.presencePenalty !== undefined) body["presence_penalty"] = request.presencePenalty

  if (request.tools?.length && context.capabilities.toolCall) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitizeSchema(tool.parameters, { dropFormats: true }),
      },
    }))
    const choice = request.toolChoice
    if (choice?.type === "required") body["tool_choice"] = "REQUIRED"
    if (choice?.type === "none") body["tool_choice"] = "NONE"
  }

  if (request.responseFormat?.type === "json") body["response_format"] = { type: "json_object" }
  if (request.responseFormat?.type === "json-schema") {
    body["response_format"] = {
      type: "json_object",
      json_schema: sanitizeSchema(request.responseFormat.schema, { dropFormats: true }),
    }
  }

  return { ...body, ...(request.providerOptions ?? {}) }
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

interface CohereToolSlot {
  id: string
  name: string
  buffer: string
}

async function* streamCohere(
  request: LlmRequest,
  context: TransportContext,
): AsyncGenerator<LlmStreamEvent> {
  const base = context.baseUrl === "" ? "https://api.cohere.com/v2" : context.baseUrl
  const url = joinUrl(base, "/chat")
  const body = buildCohereBody(request, context)
  const tracker = new BlockTracker()
  const tools = new Map<number, CohereToolSlot>()

  let usage: LlmUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let finishReason = "unknown"
  let sawTool = false

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
    const index = pickNumber(payload, "index")

    switch (type) {
      case "message-start":
        break

      case "content-start":
        break

      case "content-delta": {
        const delta = pickObject(payload, "delta")
        const message = pickObject(delta, "message")
        const content = pickObject(message, "content")
        const text = pickString(content, "text") ?? ""
        if (text !== "") yield* tracker.text(text)
        break
      }

      case "content-end":
        yield* tracker.closeText()
        break

      case "tool-plan-delta": {
        const delta = pickObject(payload, "delta")
        const message = pickObject(delta, "message")
        const plan = pickString(message, "tool_plan") ?? ""
        if (plan !== "") yield* tracker.reasoning(plan)
        break
      }

      case "tool-call-start": {
        const delta = pickObject(payload, "delta")
        const message = pickObject(delta, "message")
        const call = pickObject(message, "tool_calls")
        const fn = pickObject(call, "function")
        const id = pickString(call, "id") ?? newId("tool")
        const name = pickString(fn, "name") ?? ""
        tools.set(index, { id, name, buffer: "" })
        yield* tracker.closeAll()
        yield { type: "tool-call-start", toolCallId: id, toolName: name }
        break
      }

      case "tool-call-delta": {
        const slot = tools.get(index)
        if (!slot) break
        const delta = pickObject(payload, "delta")
        const message = pickObject(delta, "message")
        const call = pickObject(message, "tool_calls")
        const fn = pickObject(call, "function")
        const args = pickString(fn, "arguments") ?? ""
        if (args === "") break
        slot.buffer += args
        yield { type: "tool-call-delta", toolCallId: slot.id, delta: args }
        break
      }

      case "tool-call-end": {
        const slot = tools.get(index)
        if (!slot) break
        tools.delete(index)
        yield {
          type: "tool-call",
          toolCallId: slot.id,
          toolName: slot.name,
          input: parseToolInput(slot.buffer),
          inputText: slot.buffer,
        }
        sawTool = true
        break
      }

      case "message-end": {
        const delta = pickObject(payload, "delta")
        finishReason = pickString(delta, "finish_reason") ?? finishReason
        const usagePayload = pickObject(delta, "usage")
        const tokens = pickObject(usagePayload, "tokens")
        const billed = pickObject(usagePayload, "billed_units")
        usage = {
          input: pickNumber(tokens ?? billed, "input_tokens"),
          output: pickNumber(tokens ?? billed, "output_tokens"),
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }
        break
      }

      default:
        break
    }
  }

  yield* tracker.closeAll()

  for (const slot of tools.values()) {
    yield {
      type: "tool-call",
      toolCallId: slot.id,
      toolName: slot.name,
      input: parseToolInput(slot.buffer),
      inputText: slot.buffer,
    }
    sawTool = true
  }

  const normalized = normalizeFinishReason(finishReason)
  yield {
    type: "finish",
    finishReason: sawTool && normalized !== "error" ? "tool-calls" : normalized,
    usage,
  }
}

export const CohereTransport: Transport = {
  id: "cohere",
  stream(request, context) {
    return framed(request, () => streamCohere(request, context))
  },
  async listModels(context) {
    const { getJson } = await import("../../util/http.js")
    const base = context.baseUrl === "" ? "https://api.cohere.com/v2" : context.baseUrl
    const response = await getJson<{ models?: Array<{ name?: string }> }>(
      joinUrl(base, "/models"),
      {
        headers: context.apiKey ? { authorization: `Bearer ${context.apiKey}` } : {},
        timeoutMs: 10_000,
      },
    )
    return (response.data?.models ?? [])
      .map((model) => model.name)
      .filter((id): id is string => typeof id === "string")
      .sort()
  },
}
