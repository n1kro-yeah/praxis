/**
 * Google Gemini transport (both the public Generative Language API and Vertex).
 *
 * Gemini's shape differs from everyone else's in ways that matter:
 *   - roles are `user` and `model`; there is no assistant or tool role
 *   - tool results are `functionResponse` parts inside a *user* turn
 *   - the system prompt is `systemInstruction`, a single Content object
 *   - tool declarations sit under `tools[0].functionDeclarations`
 *   - JSON Schema support is a restricted subset: `additionalProperties`,
 *     `$schema`, `oneOf` and `format` values other than a small allowlist cause
 *     a 400, so schemas need aggressive pruning
 *   - streaming uses `?alt=sse` and emits whole candidate objects per chunk,
 *     with function calls arriving complete rather than as fragments
 *   - thinking is exposed via `thought: true` parts and configured through
 *     `thinkingConfig.thinkingBudget`
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
  pruneEmptyContent,
  reconcileToolCalls,
} from "../../llm/types.js"
import { newId } from "../../util/id.js"
import { streamSse } from "../../util/http.js"
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
} from "../transport.js"

const log = logger("transport.google")

/** Formats Gemini accepts on string properties. Everything else 400s. */
const ALLOWED_FORMATS = new Set(["date-time", "enum"])

/**
 * Rewrites a JSON Schema into Gemini's restricted dialect.
 *
 * This is not cosmetic: leaving `additionalProperties` in place causes every
 * tool call to fail, and an unsupported `format` silently disables the tool.
 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== "object") return node
    const source = node as Record<string, unknown>
    const out: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(source)) {
      if (
        key === "additionalProperties" ||
        key === "$schema" ||
        key === "$id" ||
        key === "examples" ||
        key === "default" ||
        key === "const" ||
        key === "exclusiveMinimum" ||
        key === "exclusiveMaximum" ||
        key === "patternProperties" ||
        key === "deprecated"
      ) {
        continue
      }
      if (key === "format") {
        if (typeof value === "string" && ALLOWED_FORMATS.has(value)) out[key] = value
        continue
      }
      // Gemini does not support oneOf/allOf; collapse to the first branch,
      // which in practice is the intended shape for tool parameters.
      if (key === "oneOf" || key === "allOf") {
        const branches = Array.isArray(value) ? value : []
        const first = branches[0]
        if (first && typeof first === "object") {
          Object.assign(out, walk(first) as Record<string, unknown>)
        }
        continue
      }
      if (key === "anyOf") {
        out["anyOf"] = (Array.isArray(value) ? value : []).map(walk)
        continue
      }
      out[key] = walk(value)
    }

    // A `type: object` with no properties is rejected; give it a dummy.
    if (out["type"] === "object" && !out["properties"]) {
      out["properties"] = {}
    }
    // Empty enum arrays also 400.
    if (Array.isArray(out["enum"]) && (out["enum"] as unknown[]).length === 0) {
      delete out["enum"]
    }
    return out
  }
  return walk(schema) as Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/* Request construction                                                */
/* ------------------------------------------------------------------ */

type GeminiPart = Record<string, unknown>

interface GeminiContent {
  role: "user" | "model"
  parts: GeminiPart[]
}

function contentToParts(
  content: readonly Content[],
  context: TransportContext,
): { parts: GeminiPart[]; role: "user" | "model" | undefined } {
  const parts: GeminiPart[] = []
  let role: "user" | "model" | undefined

  for (const item of content) {
    switch (item.type) {
      case "text": {
        if (item.text === "") break
        parts.push({ text: item.text })
        break
      }
      case "reasoning": {
        if (item.text === "") break
        // Replaying thoughts is allowed but must be flagged.
        parts.push({ text: item.text, thought: true })
        break
      }
      case "image": {
        if (!context.capabilities.attachment) break
        const { mime, base64 } = normalizeImage(item.data, item.mime)
        if (base64.startsWith("http")) {
          parts.push({ fileData: { mimeType: mime, fileUri: base64 } })
          break
        }
        parts.push({ inlineData: { mimeType: mime, data: base64 } })
        break
      }
      case "file": {
        if (item.text) {
          parts.push({ text: item.text })
          break
        }
        parts.push({ inlineData: { mimeType: item.mime, data: item.data } })
        break
      }
      case "tool-call": {
        role = "model"
        parts.push({
          functionCall: { name: item.toolName, args: item.input ?? {} },
        })
        break
      }
      case "tool-result": {
        role = "user"
        // Gemini wants a structured response object, not a string.
        parts.push({
          functionResponse: {
            name: item.toolName,
            response: item.isError
              ? { error: item.output }
              : { output: item.output === "" ? "(no output)" : item.output },
          },
        })
        for (const image of item.attachments ?? []) {
          if (!context.capabilities.attachment) continue
          const { mime, base64 } = normalizeImage(image.data, image.mime)
          parts.push({ inlineData: { mimeType: mime, data: base64 } })
        }
        break
      }
    }
  }

  return { parts, role }
}

export function buildGeminiBody(
  request: LlmRequest,
  context: TransportContext,
): Record<string, unknown> {
  const contents: GeminiContent[] = []
  const prepared = reconcileToolCalls(pruneEmptyContent(request.messages))

  for (const message of prepared) {
    const { parts, role: forced } = contentToParts(message.content, context)
    if (parts.length === 0) continue
    const role: "user" | "model" =
      forced ?? (message.role === "assistant" ? "model" : "user")
    const previous = contents[contents.length - 1]
    // Consecutive same-role turns are rejected; merge them.
    if (previous && previous.role === role) {
      previous.parts.push(...parts)
      continue
    }
    contents.push({ role, parts })
  }

  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "Continue." }] })

  const generationConfig: Record<string, unknown> = {}
  if (context.capabilities.temperature && request.temperature !== undefined) {
    generationConfig["temperature"] = request.temperature
  }
  if (request.topP !== undefined) generationConfig["topP"] = request.topP
  if (request.topK !== undefined) generationConfig["topK"] = request.topK
  if (request.maxOutputTokens) generationConfig["maxOutputTokens"] = request.maxOutputTokens
  if (request.stopSequences?.length) generationConfig["stopSequences"] = request.stopSequences
  if (request.seed !== undefined) generationConfig["seed"] = request.seed
  if (request.responseFormat?.type === "json") {
    generationConfig["responseMimeType"] = "application/json"
  }
  if (request.responseFormat?.type === "json-schema") {
    generationConfig["responseMimeType"] = "application/json"
    generationConfig["responseSchema"] = toGeminiSchema(request.responseFormat.schema)
  }
  if (request.reasoning && context.capabilities.reasoning) {
    const budget = request.reasoning.maxTokens ?? effortToBudget(request.reasoning.effort)
    generationConfig["thinkingConfig"] = {
      includeThoughts: request.reasoning.include !== false,
      ...(budget > 0 ? { thinkingBudget: budget } : {}),
    }
  }

  const body: Record<string, unknown> = { contents }
  if (Object.keys(generationConfig).length) body["generationConfig"] = generationConfig

  const systemLines = (request.system ?? []).filter((line) => line.trim() !== "")
  if (systemLines.length) {
    body["systemInstruction"] = { role: "user", parts: systemLines.map((text) => ({ text })) }
  }

  if (request.tools?.length && context.capabilities.toolCall) {
    body["tools"] = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: toGeminiSchema(tool.parameters),
        })),
      },
    ]
    const choice = request.toolChoice
    if (choice && choice.type !== "auto") {
      const mode =
        choice.type === "none" ? "NONE" : choice.type === "required" ? "ANY" : "ANY"
      body["toolConfig"] = {
        functionCallingConfig: {
          mode,
          ...(choice.type === "tool" ? { allowedFunctionNames: [choice.name] } : {}),
        },
      }
    }
  }

  // Coding agents need the safety filters off or the model refuses to read
  // files that merely mention violence in a string literal.
  body["safetySettings"] = [
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
  ].map((category) => ({ category, threshold: "BLOCK_NONE" }))

  return { ...body, ...(request.providerOptions ?? {}) }
}

function effortToBudget(effort: string | undefined): number {
  switch (effort) {
    case "minimal":
      return 512
    case "low":
      return 2_048
    case "medium":
      return 8_192
    case "high":
      return 24_576
    default:
      return 0
  }
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

function geminiUsage(payload: unknown): LlmUsage | undefined {
  const usage = pickObject(payload, "usageMetadata")
  if (!usage) return undefined
  const cached = pickNumber(usage, "cachedContentTokenCount")
  return {
    input: Math.max(0, pickNumber(usage, "promptTokenCount") - cached),
    output: pickNumber(usage, "candidatesTokenCount"),
    reasoning: pickNumber(usage, "thoughtsTokenCount"),
    cacheRead: cached,
    cacheWrite: 0,
    total: pickNumber(usage, "totalTokenCount") || undefined,
  }
}

async function* streamGemini(
  request: LlmRequest,
  context: TransportContext,
  urlBuilder: (context: TransportContext, modelId: string) => string,
  headerBuilder: (context: TransportContext, request: LlmRequest) => Record<string, string>,
): AsyncGenerator<LlmStreamEvent> {
  const url = urlBuilder(context, request.modelId)
  const body = buildGeminiBody(request, context)
  const tracker = new BlockTracker()

  let usage: LlmUsage | undefined
  let finishReason = "unknown"
  let emittedToolCall = false

  const events = streamSse(url, {
    method: "POST",
    headers: headerBuilder(context, request),
    body: JSON.stringify(body),
    query: { alt: "sse", ...context.query },
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

    const error = pickObject(payload, "error")
    if (error) {
      const status = pickNumber(error, "code")
      yield {
        type: "error",
        error: {
          name: pickString(error, "status") ?? "ProviderError",
          message: pickString(error, "message") ?? "provider error",
          retryable: status === 429 || status >= 500,
          status: status || undefined,
        },
      }
      continue
    }

    const parsedUsage = geminiUsage(payload)
    if (parsedUsage) usage = parsedUsage

    const candidates = pickArray(payload, "candidates") ?? []
    for (const candidate of candidates) {
      const reason = pickString(candidate, "finishReason")
      if (reason) finishReason = reason

      const content = pickObject(candidate, "content")
      const parts = pickArray(content, "parts") ?? []
      for (const part of parts) {
        const record = part as Record<string, unknown>
        const text = typeof record["text"] === "string" ? (record["text"] as string) : ""
        const isThought = record["thought"] === true

        if (text !== "") {
          if (isThought) yield* tracker.reasoning(text)
          else yield* tracker.text(text)
        }

        const call = pickObject(record, "functionCall")
        if (call) {
          yield* tracker.closeAll()
          const name = pickString(call, "name") ?? ""
          const args = (pickObject(call, "args") ?? {}) as Record<string, unknown>
          // Gemini does not supply ids; synthesise a stable one.
          const toolCallId = pickString(call, "id") ?? newId("tool")
          yield { type: "tool-call-start", toolCallId, toolName: name }
          yield {
            type: "tool-call",
            toolCallId,
            toolName: name,
            input: args,
            inputText: JSON.stringify(args),
          }
          emittedToolCall = true
        }

        const executable = pickObject(record, "executableCode")
        if (executable) {
          const code = pickString(executable, "code") ?? ""
          if (code !== "") yield* tracker.text(`\n\`\`\`\n${code}\n\`\`\`\n`)
        }
      }
    }

    const feedback = pickObject(payload, "promptFeedback")
    const blockReason = pickString(feedback, "blockReason")
    if (blockReason) {
      yield {
        type: "error",
        error: {
          name: "ContentFilter",
          message: `Request blocked by Gemini safety filters: ${blockReason}`,
          retryable: false,
        },
      }
      finishReason = "SAFETY"
    }
  }

  yield* tracker.closeAll()

  const normalized = normalizeFinishReason(finishReason)
  yield {
    type: "finish",
    finishReason:
      normalized === "stop" && emittedToolCall ? "tool-calls" : normalized,
    usage: usage ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/* ------------------------------------------------------------------ */
/* Public API variant                                                  */
/* ------------------------------------------------------------------ */

function publicUrl(context: TransportContext, modelId: string): string {
  const base = context.baseUrl === "" ? "https://generativelanguage.googleapis.com/v1beta" : context.baseUrl
  return joinUrl(base, `/models/${encodeURIComponent(modelId)}:streamGenerateContent`)
}

function publicHeaders(context: TransportContext, request: LlmRequest): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...context.headers,
    ...(request.headers ?? {}),
  }
  // The public API uses a query-style key header rather than bearer auth.
  if (context.apiKey) headers["x-goog-api-key"] = context.apiKey
  return headers
}

export const GoogleTransport: Transport = {
  id: "google",
  stream(request, context) {
    return framed(request, () => streamGemini(request, context, publicUrl, publicHeaders))
  },
  async listModels(context) {
    const { getJson } = await import("../../util/http.js")
    const base =
      context.baseUrl === "" ? "https://generativelanguage.googleapis.com/v1beta" : context.baseUrl
    const response = await getJson<{ models?: Array<{ name?: string }> }>(
      joinUrl(base, "/models"),
      {
        headers: context.apiKey ? { "x-goog-api-key": context.apiKey } : {},
        timeoutMs: 10_000,
      },
    )
    return (response.data?.models ?? [])
      .map((model) => model.name?.replace(/^models\//, ""))
      .filter((id): id is string => typeof id === "string")
      .sort()
  },
}

/* ------------------------------------------------------------------ */
/* Vertex AI variant                                                   */
/* ------------------------------------------------------------------ */

function vertexUrl(context: TransportContext, modelId: string): string {
  const project = String(context.options["project"] ?? process.env["GOOGLE_CLOUD_PROJECT"] ?? "")
  const location = String(
    context.options["region"] ?? process.env["GOOGLE_CLOUD_LOCATION"] ?? "us-central1",
  )
  const host =
    location === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${location}-aiplatform.googleapis.com`
  const base = context.baseUrl === "" ? host : context.baseUrl
  return joinUrl(
    base,
    `/v1/projects/${project}/locations/${location}/publishers/google/models/${encodeURIComponent(modelId)}:streamGenerateContent`,
  )
}

function vertexHeaders(context: TransportContext, request: LlmRequest): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...context.headers,
    ...(request.headers ?? {}),
  }
  // Vertex uses standard Google OAuth bearer tokens.
  if (context.apiKey) headers["authorization"] = `Bearer ${context.apiKey}`
  return headers
}

export const GoogleVertexTransport: Transport = {
  id: "google-vertex",
  stream(request, context) {
    return framed(request, () => streamGemini(request, context, vertexUrl, vertexHeaders))
  },
}
