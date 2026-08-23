/**
 * Mistral transport.
 *
 * Mistral speaks a near-OpenAI dialect with three hard requirements that cause
 * opaque 422 errors when violated:
 *
 *   1. tool call ids must be exactly 9 characters, `[a-zA-Z0-9]` only
 *   2. the last message must be `user`, `tool`, or an assistant with
 *      `prefix: true`; a trailing assistant text message is rejected
 *   3. every `tool` message must directly follow the assistant message that
 *      requested it, in the same order as the `tool_calls` array
 *
 * The reordering logic below enforces (3) explicitly rather than trusting the
 * session transcript, because reverts and compaction can legitimately produce
 * out-of-order histories.
 */

import type {
  Content,
  LlmMessage,
  LlmRequest,
  LlmStreamEvent,
  Transport,
  TransportContext,
} from "../../llm/types.js"
import { conformToolCallId, pruneEmptyContent } from "../../llm/types.js"
import { logger } from "../../util/log.js"
import { framed, joinUrl } from "../transport.js"
import { streamOpenAiChat } from "./openai-chat.js"

const log = logger("transport.mistral")

/**
 * Rewrites tool call ids to Mistral's 9-character alphanumeric format,
 * consistently across the call and its result so the link survives.
 */
export function conformMistralIds(messages: readonly LlmMessage[]): LlmMessage[] {
  const mapping = new Map<string, string>()
  const used = new Set<string>()

  const remap = (id: string): string => {
    const existing = mapping.get(id)
    if (existing) return existing
    let candidate = conformToolCallId(id, "mistral")
    // Guarantee uniqueness after truncation.
    let salt = 0
    while (used.has(candidate)) {
      salt++
      candidate = conformToolCallId(`${id}${salt}`, "mistral")
    }
    used.add(candidate)
    mapping.set(id, candidate)
    return candidate
  }

  return messages.map((message) => ({
    ...message,
    content: message.content.map((item): Content => {
      if (item.type === "tool-call") return { ...item, toolCallId: remap(item.toolCallId) }
      if (item.type === "tool-result") return { ...item, toolCallId: remap(item.toolCallId) }
      return item
    }),
  }))
}

/**
 * Reorders the transcript so tool results immediately follow their calls,
 * dropping orphans that Mistral would reject.
 */
export function orderForMistral(messages: readonly LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = []
  const resultsByCall = new Map<string, { message: LlmMessage; content: Content }>()

  for (const message of messages) {
    if (message.role !== "tool") continue
    for (const item of message.content) {
      if (item.type === "tool-result") resultsByCall.set(item.toolCallId, { message, content: item })
    }
  }

  const consumed = new Set<string>()

  for (const message of messages) {
    if (message.role === "tool") continue

    if (message.role === "assistant") {
      const calls = message.content.filter(
        (item): item is Extract<Content, { type: "tool-call" }> => item.type === "tool-call",
      )
      // Drop calls with no matching result: an unanswered call makes the whole
      // request invalid.
      const answered = calls.filter((call) => resultsByCall.has(call.toolCallId))
      const others = message.content.filter((item) => item.type !== "tool-call")
      const content = [...others, ...answered]
      if (content.length === 0) continue
      out.push({ ...message, content })

      for (const call of answered) {
        const result = resultsByCall.get(call.toolCallId)
        if (!result || consumed.has(call.toolCallId)) continue
        consumed.add(call.toolCallId)
        out.push({ role: "tool", content: [result.content] })
      }
      continue
    }

    out.push(message)
  }

  // Requirement (2): the final message may not be plain assistant text.
  const last = out[out.length - 1]
  if (last && last.role === "assistant") {
    const hasCalls = last.content.some((item) => item.type === "tool-call")
    if (!hasCalls) {
      log.debug("appending continuation turn for Mistral ordering rule")
      out.push({ role: "user", content: [{ type: "text", text: "Continue." }] })
    }
  }

  return out
}

export const MistralTransport: Transport = {
  id: "mistral",
  stream(request, context) {
    const prepared: LlmRequest = {
      ...request,
      messages: orderForMistral(conformMistralIds(pruneEmptyContent(request.messages))),
    }
    const url = joinUrl(
      context.baseUrl === "" ? "https://api.mistral.ai/v1" : context.baseUrl,
      "/chat/completions",
    )
    return framed(prepared, () => streamOpenAiChat(prepared, context, url))
  },
  async listModels(context) {
    const { getJson } = await import("../../util/http.js")
    const base = context.baseUrl === "" ? "https://api.mistral.ai/v1" : context.baseUrl
    const response = await getJson<{ data?: Array<{ id?: string }> }>(joinUrl(base, "/models"), {
      headers: context.apiKey ? { authorization: `Bearer ${context.apiKey}` } : {},
      timeoutMs: 10_000,
    })
    return (response.data?.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort()
  },
}
