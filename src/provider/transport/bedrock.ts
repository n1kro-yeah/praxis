/**
 * AWS Bedrock transport (Converse Stream API).
 *
 * Bedrock is the most involved transport because AWS does not accept a bearer
 * token: every request must be signed with SigV4, and the streaming response is
 * not SSE but the AWS `application/vnd.amazon.eventstream` binary framing
 * format. Both are implemented here from scratch using only `node:crypto`.
 *
 * Event stream framing (big-endian):
 *   4  total byte length
 *   4  headers byte length
 *   4  CRC32 of the first 8 bytes (prelude)
 *   n  headers
 *   m  payload
 *   4  CRC32 of everything except the trailing checksum
 *
 * Each header is:
 *   1  name length
 *   n  name bytes
 *   1  value type (7 = string, used for :event-type / :message-type)
 *   2  value length (for string type)
 *   m  value bytes
 */

import { createHash, createHmac } from "node:crypto"

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
import { rawStream } from "../../util/http.js"
import { logger } from "../../util/log.js"
import { ProviderError } from "../../util/error.js"
import { framed, normalizeImage, pickArray, pickNumber, pickObject, pickString } from "../transport.js"

const log = logger("transport.bedrock")

/* ------------------------------------------------------------------ */
/* SigV4                                                              */
/* ------------------------------------------------------------------ */

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex")
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest()
}

function amzDate(now: Date): { amz: string; date: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  return { amz: iso, date: iso.slice(0, 8) }
}

/**
 * Produces the Authorization header for an AWS request.
 *
 * Only the subset of SigV4 that Bedrock needs is implemented: single-chunk
 * signed payloads over HTTPS with no query signing.
 */
export function signRequest(input: {
  method: string
  url: string
  headers: Record<string, string>
  body: string
  region: string
  service: string
  credentials: AwsCredentials
  now?: Date
}): Record<string, string> {
  const url = new URL(input.url)
  const { amz, date } = amzDate(input.now ?? new Date())

  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    "x-amz-date": amz,
  }
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken
  }

  const payloadHash = sha256Hex(input.body)
  headers["x-amz-content-sha256"] = payloadHash

  const canonicalHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  const canonicalHeaders = canonicalHeaderNames
    .map((name) => {
      const value = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === name,
      )?.[1]
      return `${name}:${String(value ?? "").trim().replace(/\s+/g, " ")}\n`
    })
    .join("")
  const signedHeaders = canonicalHeaderNames.join(";")

  // Bedrock paths contain colons (model ids), which must stay unencoded except
  // for the path separators; encodeURI matches the AWS canonicalisation here.
  const canonicalUri = url.pathname
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)).replace(/%3A/g, ":"))
    .join("/")

  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&")

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri === "" ? "/" : canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n")

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, date)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, input.service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex")

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return headers
}

function resolveCredentials(context: TransportContext): AwsCredentials {
  const options = context.options
  const accessKeyId =
    (typeof options["accessKeyId"] === "string" ? (options["accessKeyId"] as string) : "") ||
    process.env["AWS_ACCESS_KEY_ID"] ||
    ""
  const secretAccessKey =
    (typeof options["secretAccessKey"] === "string" ? (options["secretAccessKey"] as string) : "") ||
    process.env["AWS_SECRET_ACCESS_KEY"] ||
    ""
  const sessionToken =
    (typeof options["sessionToken"] === "string" ? (options["sessionToken"] as string) : "") ||
    process.env["AWS_SESSION_TOKEN"] ||
    undefined

  if (accessKeyId === "" || secretAccessKey === "") {
    throw new ProviderError(
      "AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or configure them under provider.amazon-bedrock.options.",
      { providerId: context.providerId },
    )
  }
  return { accessKeyId, secretAccessKey, sessionToken }
}

function resolveRegion(context: TransportContext): string {
  const configured = context.options["region"]
  if (typeof configured === "string" && configured !== "") return configured
  return process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1"
}

/* ------------------------------------------------------------------ */
/* Event stream decoding                                               */
/* ------------------------------------------------------------------ */

export interface EventStreamMessage {
  headers: Record<string, string>
  payload: Buffer
}

/**
 * Incremental decoder for the AWS event stream framing.
 * Feed it chunks; it yields complete messages as they become available.
 */
export class EventStreamDecoder {
  private buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): EventStreamMessage[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    const out: EventStreamMessage[] = []

    while (this.buffer.length >= 16) {
      const totalLength = this.buffer.readUInt32BE(0)
      if (totalLength > 64 * 1024 * 1024) {
        // Corrupt framing; drop the buffer rather than allocate wildly.
        log.warn("event stream frame length implausible; resetting", { totalLength })
        this.buffer = Buffer.alloc(0)
        break
      }
      if (this.buffer.length < totalLength) break

      const headersLength = this.buffer.readUInt32BE(4)
      const frame = this.buffer.subarray(0, totalLength)
      this.buffer = this.buffer.subarray(totalLength)

      const headers: Record<string, string> = {}
      let cursor = 12
      const headersEnd = 12 + headersLength
      while (cursor < headersEnd) {
        const nameLength = frame.readUInt8(cursor)
        cursor += 1
        const name = frame.subarray(cursor, cursor + nameLength).toString("utf8")
        cursor += nameLength
        const valueType = frame.readUInt8(cursor)
        cursor += 1
        if (valueType === 7) {
          const valueLength = frame.readUInt16BE(cursor)
          cursor += 2
          headers[name] = frame.subarray(cursor, cursor + valueLength).toString("utf8")
          cursor += valueLength
          continue
        }
        // Non-string header types are not used by Bedrock; skip by size.
        const skip =
          valueType === 0 || valueType === 1
            ? 0
            : valueType === 2
              ? 1
              : valueType === 3
                ? 2
                : valueType === 4
                  ? 4
                  : valueType === 5 || valueType === 8
                    ? 8
                    : 16
        cursor += skip
      }

      const payload = frame.subarray(headersEnd, totalLength - 4)
      out.push({ headers, payload })
    }

    return out
  }
}

/* ------------------------------------------------------------------ */
/* Converse request construction                                       */
/* ------------------------------------------------------------------ */

type ConverseBlock = Record<string, unknown>

function contentToConverse(
  content: readonly Content[],
  context: TransportContext,
): ConverseBlock[] {
  const blocks: ConverseBlock[] = []
  for (const item of content) {
    switch (item.type) {
      case "text":
        if (item.text !== "") blocks.push({ text: item.text })
        break
      case "reasoning": {
        if (item.text === "" && !item.encrypted) break
        blocks.push({
          reasoningContent: item.encrypted
            ? { redactedContent: item.encrypted }
            : {
                reasoningText: {
                  text: item.text,
                  ...(item.signature ? { signature: item.signature } : {}),
                },
              },
        })
        break
      }
      case "image": {
        if (!context.capabilities.attachment) break
        const { mime, base64 } = normalizeImage(item.data, item.mime)
        const format = mime.split("/")[1] ?? "png"
        blocks.push({ image: { format, source: { bytes: base64 } } })
        break
      }
      case "file": {
        if (item.text) {
          blocks.push({ text: item.text })
          break
        }
        const name = (item.filename ?? "document").replace(/[^a-zA-Z0-9\s\-()\[\]]/g, "_")
        blocks.push({
          document: {
            name,
            format: item.mime === "application/pdf" ? "pdf" : "txt",
            source: { bytes: item.data },
          },
        })
        break
      }
      case "tool-call":
        blocks.push({
          toolUse: {
            toolUseId: item.toolCallId,
            name: item.toolName,
            input: item.input ?? {},
          },
        })
        break
      case "tool-result": {
        const resultBlocks: ConverseBlock[] = []
        if (item.output !== "") resultBlocks.push({ text: item.output })
        for (const image of item.attachments ?? []) {
          if (!context.capabilities.attachment) continue
          const { mime, base64 } = normalizeImage(image.data, image.mime)
          resultBlocks.push({
            image: { format: mime.split("/")[1] ?? "png", source: { bytes: base64 } },
          })
        }
        if (resultBlocks.length === 0) resultBlocks.push({ text: "(no output)" })
        blocks.push({
          toolResult: {
            toolUseId: item.toolCallId,
            content: resultBlocks,
            ...(item.isError ? { status: "error" } : {}),
          },
        })
        break
      }
    }
  }
  return blocks
}

export function buildConverseBody(
  request: LlmRequest,
  context: TransportContext,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: ConverseBlock[] }> = []
  const prepared = reconcileToolCalls(pruneEmptyContent(request.messages))

  for (const message of prepared) {
    const role = message.role === "assistant" ? "assistant" : "user"
    const content = contentToConverse(message.content, context)
    if (content.length === 0) continue
    const previous = messages[messages.length - 1]
    if (previous && previous.role === role) {
      previous.content.push(...content)
      continue
    }
    messages.push({ role, content })
  }

  if (messages.length === 0) messages.push({ role: "user", content: [{ text: "Continue." }] })
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ text: "Continue." }] })

  const inferenceConfig: Record<string, unknown> = {}
  if (request.maxOutputTokens) inferenceConfig["maxTokens"] = request.maxOutputTokens
  if (context.capabilities.temperature && request.temperature !== undefined) {
    inferenceConfig["temperature"] = request.temperature
  }
  if (request.topP !== undefined) inferenceConfig["topP"] = request.topP
  if (request.stopSequences?.length) inferenceConfig["stopSequences"] = request.stopSequences

  const body: Record<string, unknown> = { messages }
  if (Object.keys(inferenceConfig).length) body["inferenceConfig"] = inferenceConfig

  const systemLines = (request.system ?? []).filter((line) => line.trim() !== "")
  if (systemLines.length) body["system"] = systemLines.map((text) => ({ text }))

  if (request.tools?.length && context.capabilities.toolCall) {
    body["toolConfig"] = {
      tools: request.tools.map((tool) => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { json: tool.parameters },
        },
      })),
      ...(request.toolChoice && request.toolChoice.type !== "auto"
        ? {
            toolChoice:
              request.toolChoice.type === "required"
                ? { any: {} }
                : request.toolChoice.type === "tool"
                  ? { tool: { name: request.toolChoice.name } }
                  : { auto: {} },
          }
        : {}),
    }
  }

  if (request.reasoning && context.capabilities.reasoning) {
    const budget = request.reasoning.maxTokens ?? 4_096
    body["additionalModelRequestFields"] = {
      thinking: { type: "enabled", budget_tokens: budget },
    }
    // Thinking and temperature are mutually exclusive on Anthropic models.
    const config = body["inferenceConfig"] as Record<string, unknown> | undefined
    if (config) delete config["temperature"]
  }

  return { ...body, ...(request.providerOptions ?? {}) }
}

/**
 * Maps a model id to a Bedrock model identifier, applying cross-region
 * inference profile prefixes when the id needs one.
 */
export function bedrockModelId(modelId: string, region: string): string {
  if (modelId.includes(".") && /^(us|eu|apac|us-gov)\./.test(modelId)) return modelId
  // Newer Anthropic and Llama models are only reachable through an inference
  // profile, which is the region group prefixed to the id.
  const needsProfile = /claude-(3-5-haiku|3-7|sonnet-4|opus-4|haiku-4)|llama3-[23]/.test(modelId)
  if (!needsProfile) return modelId
  const group = region.startsWith("eu-")
    ? "eu"
    : region.startsWith("ap-")
      ? "apac"
      : region.startsWith("us-gov-")
        ? "us-gov"
        : "us"
  return `${group}.${modelId}`
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

interface ConverseSlot {
  kind: "text" | "reasoning" | "tool"
  partId: string
  toolId?: string
  toolName?: string
  buffer: string
  signature?: string
}

async function* streamBedrock(
  request: LlmRequest,
  context: TransportContext,
): AsyncGenerator<LlmStreamEvent> {
  const region = resolveRegion(context)
  const credentials = resolveCredentials(context)
  const modelId = bedrockModelId(request.modelId, region)
  const host =
    context.baseUrl === "" ? `https://bedrock-runtime.${region}.amazonaws.com` : context.baseUrl
  const url = `${host}/model/${encodeURIComponent(modelId)}/converse-stream`
  const body = JSON.stringify(buildConverseBody(request, context))

  const headers = signRequest({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      accept: "application/vnd.amazon.eventstream",
      ...context.headers,
      ...(request.headers ?? {}),
    },
    body,
    region,
    service: "bedrock",
    credentials,
  })

  const response = await rawStream(url, {
    method: "POST",
    headers,
    body,
    timeoutMs: context.timeoutMs,
    retries: context.retries,
    signal: request.signal,
  })

  const decoder = new EventStreamDecoder()
  const slots = new Map<number, ConverseSlot>()
  let usage: LlmUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let stopReason = "unknown"

  for await (const chunk of response.body) {
    for (const message of decoder.push(chunk)) {
      const messageType = message.headers[":message-type"] ?? "event"
      const eventType = message.headers[":event-type"] ?? ""

      if (messageType === "exception" || messageType === "error") {
        const text = message.payload.toString("utf8")
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = { message: text }
        }
        const kind = message.headers[":exception-type"] ?? "BedrockException"
        yield {
          type: "error",
          error: {
            name: kind,
            message: pickString(parsed, "message", "Message") ?? text,
            retryable: /Throttling|ServiceUnavailable|ModelTimeout|Internal/i.test(kind),
          },
        }
        continue
      }

      let payload: unknown
      try {
        payload = JSON.parse(message.payload.toString("utf8"))
      } catch {
        continue
      }

      const index = pickNumber(payload, "contentBlockIndex")

      switch (eventType) {
        case "messageStart":
          break

        case "contentBlockStart": {
          const start = pickObject(payload, "start")
          const toolUse = pickObject(start, "toolUse")
          if (toolUse) {
            const toolId = pickString(toolUse, "toolUseId") ?? newId("tool")
            const toolName = pickString(toolUse, "name") ?? ""
            slots.set(index, {
              kind: "tool",
              partId: newId("part"),
              toolId,
              toolName,
              buffer: "",
            })
            yield { type: "tool-call-start", toolCallId: toolId, toolName }
          }
          break
        }

        case "contentBlockDelta": {
          const delta = pickObject(payload, "delta") ?? {}
          const text = pickString(delta, "text")
          if (text) {
            let slot = slots.get(index)
            if (!slot || slot.kind !== "text") {
              slot = { kind: "text", partId: newId("part"), buffer: "" }
              slots.set(index, slot)
              yield { type: "text-start", id: slot.partId }
            }
            yield { type: "text-delta", id: slot.partId, delta: text }
            break
          }

          const reasoning = pickObject(delta, "reasoningContent")
          if (reasoning) {
            const reasoningText = pickString(reasoning, "text")
            const signature = pickString(reasoning, "signature")
            let slot = slots.get(index)
            if (!slot || slot.kind !== "reasoning") {
              slot = { kind: "reasoning", partId: newId("part"), buffer: "" }
              slots.set(index, slot)
              yield { type: "reasoning-start", id: slot.partId }
            }
            if (signature) slot.signature = (slot.signature ?? "") + signature
            if (reasoningText) {
              yield { type: "reasoning-delta", id: slot.partId, delta: reasoningText }
            }
            break
          }

          const toolUse = pickObject(delta, "toolUse")
          if (toolUse) {
            const slot = slots.get(index)
            if (!slot) break
            const fragment = pickString(toolUse, "input") ?? ""
            if (fragment !== "") {
              slot.buffer += fragment
              yield {
                type: "tool-call-delta",
                toolCallId: slot.toolId ?? slot.partId,
                delta: fragment,
              }
            }
          }
          break
        }

        case "contentBlockStop": {
          const slot = slots.get(index)
          if (!slot) break
          slots.delete(index)
          if (slot.kind === "text") yield { type: "text-end", id: slot.partId }
          else if (slot.kind === "reasoning") {
            yield { type: "reasoning-end", id: slot.partId, signature: slot.signature }
          } else {
            yield {
              type: "tool-call",
              toolCallId: slot.toolId ?? slot.partId,
              toolName: slot.toolName ?? "",
              input: parseToolInput(slot.buffer),
              inputText: slot.buffer,
            }
          }
          break
        }

        case "messageStop":
          stopReason = pickString(payload, "stopReason") ?? stopReason
          break

        case "metadata": {
          const usagePayload = pickObject(payload, "usage")
          if (usagePayload) {
            usage = {
              input: pickNumber(usagePayload, "inputTokens"),
              output: pickNumber(usagePayload, "outputTokens"),
              reasoning: 0,
              cacheRead: pickNumber(usagePayload, "cacheReadInputTokens"),
              cacheWrite: pickNumber(usagePayload, "cacheWriteInputTokens"),
              total: pickNumber(usagePayload, "totalTokens") || undefined,
            }
          }
          break
        }

        default:
          break
      }
    }
  }

  for (const slot of slots.values()) {
    if (slot.kind === "text") yield { type: "text-end", id: slot.partId }
    else if (slot.kind === "reasoning") {
      yield { type: "reasoning-end", id: slot.partId, signature: slot.signature }
    } else {
      yield {
        type: "tool-call",
        toolCallId: slot.toolId ?? slot.partId,
        toolName: slot.toolName ?? "",
        input: parseToolInput(slot.buffer),
        inputText: slot.buffer,
      }
    }
  }

  yield { type: "finish", finishReason: normalizeFinishReason(stopReason), usage }
}

export const BedrockTransport: Transport = {
  id: "bedrock",
  stream(request, context) {
    return framed(request, () => streamBedrock(request, context))
  },
}
