/**
 * Ollama transport.
 *
 * Ollama exposes two APIs: its own `/api/chat` (NDJSON, no SSE) and an
 * OpenAI-compatible `/v1/chat/completions`. We prefer the native one because it
 * reports real token counts, exposes `keep_alive`, `num_ctx` and the other
 * options that matter for local inference, and streams tool calls as complete
 * objects instead of fragments.
 *
 * Local models frequently emit tool calls as raw text when the template is
 * imperfect, so this transport also sniffs for the common inline formats and
 * recovers them. Without that recovery, small local models are unusable as
 * coding agents.
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
import { streamNdjson } from "../../util/http.js"
import { logger } from "../../util/log.js"
import {
  BlockTracker,
  framed,
  joinUrl,
  normalizeImage,
  pickArray,
  pickNumber,
  pickObject,
  pickString,
  sanitizeSchema,
} from "../transport.js"

const log = logger("transport.ollama")

/* ------------------------------------------------------------------ */
/* Inline tool-call recovery                                           */
/* ------------------------------------------------------------------ */

interface RecoveredCall {
  name: string
  input: Record<string, unknown>
  raw: string
}

/**
 * Patterns emitted by popular local model templates when the server fails to
 * parse tool calls itself. Each is tried in order against the accumulated text.
 */
const INLINE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  // Qwen / Hermes style
  { label: "tool_call-xml", regex: /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g },
  // Llama 3.1 style
  { label: "python-tag", regex: /<\|python_tag\|>\s*([\s\S]*?)(?:<\|eom_id\|>|$)/g },
  // Mistral / Nemo style
  { label: "tool-calls-token", regex: /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/g },
  // Generic fenced JSON block declaring a tool
  {
    label: "fenced-json",
    regex: /```(?:json|tool_code)?\s*(\{[\s\S]*?"(?:name|tool|function)"[\s\S]*?\})\s*```/g,
  },
  // Functionary style
  { label: "function-token", regex: /<function=([\w.-]+)>\s*([\s\S]*?)\s*<\/function>/g },
]

function normalizeRecovered(value: unknown): RecoveredCall[] {
  const out: RecoveredCall[] = []
  const push = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return
    const record = candidate as Record<string, unknown>
    const name =
      pickString(record, "name", "tool", "tool_name", "function") ??
      pickString(pickObject(record, "function"), "name")
    if (!name) return
    const argsSource =
      pickObject(record, "arguments", "args", "parameters", "input") ??
      pickObject(pickObject(record, "function"), "arguments")
    let input: Record<string, unknown> = argsSource ?? {}
    const argsText =
      pickString(record, "arguments", "args") ??
      pickString(pickObject(record, "function"), "arguments")
    if (argsText) input = parseToolInput(argsText)
    out.push({ name, input, raw: JSON.stringify({ name, arguments: input }) })
  }

  if (Array.isArray(value)) {
    for (const item of value) push(item)
    return out
  }
  push(value)
  return out
}

/**
 * Extracts inline tool calls from model text, returning the calls plus the text
 * with the call syntax removed so it is not shown to the user.
 */
export function recoverInlineToolCalls(
  text: string,
  known: ReadonlySet<string>,
): { calls: RecoveredCall[]; cleaned: string } {
  if (text === "" || known.size === 0) return { calls: [], cleaned: text }
  let cleaned = text
  const calls: RecoveredCall[] = []

  for (const pattern of INLINE_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags)
    let match: RegExpExecArray | null
    const consumed: Array<[number, number]> = []
    while ((match = regex.exec(cleaned)) !== null) {
      if (pattern.label === "function-token") {
        const name = match[1] ?? ""
        if (!known.has(name)) continue
        calls.push({ name, input: parseToolInput(match[2] ?? "{}"), raw: match[0] })
        consumed.push([match.index, match.index + match[0].length])
        continue
      }
      const body = match[1] ?? ""
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = parseToolInput(body)
      }
      const recovered = normalizeRecovered(parsed).filter((call) => known.has(call.name))
      if (recovered.length === 0) continue
      calls.push(...recovered)
      consumed.push([match.index, match.index + match[0].length])
    }
    // Remove consumed spans from the end so indices stay valid.
    for (const [start, end] of consumed.reverse()) {
      cleaned = cleaned.slice(0, start) + cleaned.slice(end)
    }
    if (calls.length) break
  }

  return { calls, cleaned: cleaned.trim() }
}

/* ------------------------------------------------------------------ */
/* Request construction                                                */
/* ------------------------------------------------------------------ */

interface OllamaMessage {
  role: string
  content: string
  images?: string[]
  thinking?: string
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
  tool_name?: string
}

function toOllamaMessages(request: LlmRequest, context: TransportContext): OllamaMessage[] {
  const out: OllamaMessage[] = []
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
          content: item.output === "" ? "(no output)" : item.output,
          tool_name: item.toolName,
        })
      }
      continue
    }

    const text: string[] = []
    const images: string[] = []
    const thinking: string[] = []
    const toolCalls: OllamaMessage["tool_calls"] = []

    for (const item of message.content) {
      if (item.type === "text") text.push(item.text)
      else if (item.type === "reasoning") thinking.push(item.text)
      else if (item.type === "image" && context.capabilities.attachment) {
        images.push(normalizeImage(item.data, item.mime).base64)
      } else if (item.type === "file" && item.text) text.push(item.text)
      else if (item.type === "tool-call") {
        toolCalls.push({
          function: { name: item.toolName, arguments: (item.input ?? {}) as Record<string, unknown> },
        })
      }
    }

    const wire: OllamaMessage = {
      role: message.role === "assistant" ? "assistant" : "user",
      content: text.join(""),
    }
    if (images.length) wire.images = images
    if (thinking.length) wire.thinking = thinking.join("")
    if (toolCalls.length) wire.tool_calls = toolCalls
    if (wire.content === "" && !wire.images && !wire.tool_calls) continue
    out.push(wire)
  }

  return out
}

export function buildOllamaBody(
  request: LlmRequest,
  context: TransportContext,
): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  if (request.temperature !== undefined) options["temperature"] = request.temperature
  if (request.topP !== undefined) options["top_p"] = request.topP
  if (request.topK !== undefined) options["top_k"] = request.topK
  if (request.seed !== undefined) options["seed"] = request.seed
  if (request.stopSequences?.length) options["stop"] = request.stopSequences
  if (request.maxOutputTokens) options["num_predict"] = request.maxOutputTokens
  // The default 2048-token window silently truncates the system prompt, which
  // makes the agent look broken. Ask for the real context window.
  options["num_ctx"] = Math.min(context.capabilities.contextWindow, 131_072)

  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: toOllamaMessages(request, context),
    stream: true,
    options: { ...options, ...(context.options["options"] as object | undefined) },
    // Keep the model resident between turns; reloading a 30B model per tool
    // call dominates latency.
    keep_alive: context.options["keepAlive"] ?? "30m",
  }

  if (context.capabilities.reasoning) body["think"] = request.reasoning !== undefined

  if (request.tools?.length && context.capabilities.toolCall) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitizeSchema(tool.parameters, { dropFormats: true }),
      },
    }))
  }

  if (request.responseFormat?.type === "json") body["format"] = "json"
  if (request.responseFormat?.type === "json-schema") {
    body["format"] = sanitizeSchema(request.responseFormat.schema, { dropFormats: true })
  }

  return { ...body, ...(request.providerOptions ?? {}) }
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

function ollamaUsage(payload: unknown): LlmUsage {
  return {
    input: pickNumber(payload, "prompt_eval_count"),
    output: pickNumber(payload, "eval_count"),
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
}

async function* streamOllama(
  request: LlmRequest,
  context: TransportContext,
): AsyncGenerator<LlmStreamEvent> {
  const base = context.baseUrl === "" ? "http://127.0.0.1:11434" : context.baseUrl
  const url = joinUrl(base, "/api/chat")
  const body = buildOllamaBody(request, context)
  const tracker = new BlockTracker()
  const knownTools = new Set((request.tools ?? []).map((tool) => tool.name))

  let usage: LlmUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let finishReason = "unknown"
  let emittedTool = false
  let textAccumulator = ""

  const chunks = streamNdjson<Record<string, unknown>>(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...context.headers,
      ...(request.headers ?? {}),
      ...(context.apiKey ? { authorization: `Bearer ${context.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    timeoutMs: context.timeoutMs,
    retries: context.retries,
    signal: request.signal,
  })

  for await (const chunk of chunks) {
    const error = pickString(chunk, "error")
    if (error) {
      yield {
        type: "error",
        error: {
          name: "OllamaError",
          message: error,
          // A missing model is fixable by the user, not by retrying.
          retryable: !/not found|pull/i.test(error),
        },
      }
      continue
    }

    const message = pickObject(chunk, "message")
    if (message) {
      const thinking = pickString(message, "thinking")
      if (thinking) yield* tracker.reasoning(thinking)

      const content = pickString(message, "content")
      if (content) {
        textAccumulator += content
        yield* tracker.text(content)
      }

      const toolCalls = pickArray(message, "tool_calls")
      for (const call of toolCalls ?? []) {
        const fn = pickObject(call, "function")
        const name = pickString(fn, "name") ?? ""
        if (name === "") continue
        const args = (pickObject(fn, "arguments") ?? {}) as Record<string, unknown>
        const toolCallId = newId("tool")
        yield* tracker.closeAll()
        yield { type: "tool-call-start", toolCallId, toolName: name }
        yield {
          type: "tool-call",
          toolCallId,
          toolName: name,
          input: args,
          inputText: JSON.stringify(args),
        }
        emittedTool = true
      }
    }

    if (chunk["done"] === true) {
      usage = ollamaUsage(chunk)
      finishReason = pickString(chunk, "done_reason") ?? "stop"
    }
  }

  yield* tracker.closeAll()

  // Recover tool calls the template failed to structure.
  if (!emittedTool && knownTools.size > 0) {
    const recovered = recoverInlineToolCalls(textAccumulator, knownTools)
    if (recovered.calls.length) {
      log.debug("recovered inline tool calls", { count: recovered.calls.length })
      for (const call of recovered.calls) {
        const toolCallId = newId("tool")
        yield { type: "tool-call-start", toolCallId, toolName: call.name }
        yield {
          type: "tool-call",
          toolCallId,
          toolName: call.name,
          input: call.input,
          inputText: JSON.stringify(call.input),
        }
      }
      emittedTool = true
      yield {
        type: "warning",
        message: "Recovered tool calls emitted as plain text by the local model.",
      }
    }
  }

  yield {
    type: "finish",
    finishReason: emittedTool ? "tool-calls" : normalizeFinishReason(finishReason),
    usage,
  }
}

export const OllamaTransport: Transport = {
  id: "ollama",
  stream(request, context) {
    return framed(request, () => streamOllama(request, context))
  },
  async listModels(context) {
    const { getJson } = await import("../../util/http.js")
    const base = context.baseUrl === "" ? "http://127.0.0.1:11434" : context.baseUrl
    const response = await getJson<{ models?: Array<{ name?: string; model?: string }> }>(
      joinUrl(base, "/api/tags"),
      { timeoutMs: 5_000, retries: 0 },
    )
    return (response.data?.models ?? [])
      .map((model) => model.model ?? model.name)
      .filter((id): id is string => typeof id === "string")
      .sort()
  },
}
