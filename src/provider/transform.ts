/**
 * Provider-specific request transforms.
 *
 * These are applied after the session engine has assembled a provider-agnostic
 * request and before the transport serialises it. Keeping them here rather than
 * inside each transport means the rules are visible in one place and testable
 * without a network call.
 *
 * Every rule below exists because a real provider rejects, mangles, or silently
 * degrades the request without it.
 */

import type { Content, LlmMessage, LlmRequest, TransportContext } from "../llm/types.js"
import { conformToolCallId } from "../llm/types.js"
import { logger } from "../util/log.js"
import { estimateTokens } from "../util/tokenizer.js"
import type { ResolvedModel, ResolvedProvider } from "./types.js"
import { defaultTemperature, modelFamily, rejectsTemperature } from "./types.js"

const log = logger("transform")

export interface TransformInput {
  readonly request: LlmRequest
  readonly provider: ResolvedProvider
  readonly model: ResolvedModel
}

export type Transform = (input: TransformInput) => LlmRequest

/* ------------------------------------------------------------------ */
/* Individual transforms                                               */
/* ------------------------------------------------------------------ */

/**
 * Removes content the provider will reject: empty text blocks, reasoning
 * without a signature (Anthropic), and messages that end up with no content.
 */
export const dropEmptyContent: Transform = ({ request, provider }) => {
  const isAnthropic = provider.transport.startsWith("anthropic")
  const messages: LlmMessage[] = []

  for (const message of request.messages) {
    const content: Content[] = []
    for (const item of message.content) {
      if (item.type === "text") {
        if (item.text.trim() === "") continue
        content.push(item)
        continue
      }
      if (item.type === "reasoning") {
        // An unsigned thinking block is rejected outright by Anthropic.
        if (isAnthropic && !item.signature && !item.encrypted) continue
        if (item.text.trim() === "" && !item.encrypted) continue
        content.push(item)
        continue
      }
      content.push(item)
    }
    if (content.length === 0) continue
    messages.push({ ...message, content })
  }

  if (messages.length === request.messages.length) return request
  return { ...request, messages }
}

/** Applies the provider's tool call id constraints. */
export const conformToolIds: Transform = ({ request, provider }) => {
  if (provider.toolCallIdStyle === "any") return request
  const mapping = new Map<string, string>()
  const used = new Set<string>()
  const remap = (id: string): string => {
    const existing = mapping.get(id)
    if (existing) return existing
    let candidate = conformToolCallId(id, provider.toolCallIdStyle)
    let salt = 0
    while (used.has(candidate)) {
      salt++
      candidate = conformToolCallId(`${id}_${salt}`, provider.toolCallIdStyle)
    }
    used.add(candidate)
    mapping.set(id, candidate)
    return candidate
  }

  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: message.content.map((item): Content => {
        if (item.type === "tool-call") return { ...item, toolCallId: remap(item.toolCallId) }
        if (item.type === "tool-result") return { ...item, toolCallId: remap(item.toolCallId) }
        return item
      }),
    })),
  }
}

/**
 * Resolves the temperature.
 *
 * Reasoning models reject the field entirely; Gemini defaults to 1.0 and
 * degrades noticeably at 0.2; Qwen's recommended coding temperature is 0.55.
 * Sending the wrong value is not an error, it just makes the agent worse, which
 * is harder to notice and therefore worth encoding explicitly.
 */
export const resolveTemperature: Transform = ({ request, provider, model }) => {
  const family = modelFamily(model.providerId, model.modelId)

  if (!model.capabilities.temperature || rejectsTemperature(family, model.modelId)) {
    if (request.temperature === undefined) return request
    const next = { ...request }
    delete (next as { temperature?: number }).temperature
    return next
  }

  if (request.temperature !== undefined) return request
  const resolved = provider.defaultTemperature ?? defaultTemperature(family)
  if (resolved === undefined) return request
  return { ...request, temperature: resolved }
}

/** Clamps max output tokens to what the model actually supports. */
export const clampOutputTokens: Transform = ({ request, model }) => {
  const ceiling = model.limit.output
  if (ceiling <= 0) return request
  const requested = request.maxOutputTokens ?? ceiling
  const clamped = Math.max(256, Math.min(requested, ceiling))
  if (clamped === request.maxOutputTokens) return request
  return { ...request, maxOutputTokens: clamped }
}

/**
 * Marks prompt-cache breakpoints.
 *
 * We only enable caching when the stable prefix is long enough to pay for the
 * cache-write surcharge (25% on Anthropic). Below roughly 2k tokens caching is
 * a net loss.
 */
export const markPromptCache: Transform = ({ request, model }) => {
  if (!model.capabilities.promptCache) return request
  if (request.promptCache === false) return request

  const systemTokens = estimateTokens((request.system ?? []).join("\n"))
  const toolTokens = (request.tools ?? []).reduce(
    (sum, tool) => sum + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.parameters)),
    0,
  )
  if (systemTokens + toolTokens < 2_000) {
    log.debug("prompt cache skipped: prefix too small", { systemTokens, toolTokens })
    return { ...request, promptCache: false }
  }

  // Mark the trailing system block so transports know where the prefix ends.
  return { ...request, promptCache: true }
}

/**
 * Drops reasoning configuration for models that do not support it, and supplies
 * a sensible default effort for models that do but were not configured.
 */
export const resolveReasoning: Transform = ({ request, model }) => {
  if (!model.capabilities.reasoning) {
    if (!request.reasoning) return request
    const next = { ...request }
    delete (next as { reasoning?: unknown }).reasoning
    return next
  }
  if (request.reasoning) return request
  return { ...request, reasoning: { effort: "medium", include: true } }
}

/**
 * Removes tool definitions when the model cannot call tools, replacing them
 * with a textual description so the model can at least explain what it would
 * have done rather than hallucinating a call.
 */
export const stripTools: Transform = ({ request, model }) => {
  if (model.capabilities.toolCall) return request
  if (!request.tools?.length) return request
  log.warn("model does not support tool calls; stripping tools", { model: model.ref })
  const summary = request.tools
    .map((tool) => `- ${tool.name}: ${tool.description.split("\n")[0] ?? ""}`)
    .join("\n")
  const next: LlmRequest = {
    ...request,
    tools: undefined,
    toolChoice: undefined,
    system: [
      ...(request.system ?? []),
      `The following capabilities exist but cannot be invoked directly. Describe what you would do instead:\n${summary}`,
    ],
  }
  return next
}

/** Removes image content for models without vision. */
export const stripAttachments: Transform = ({ request, model }) => {
  if (model.capabilities.attachment) return request
  let changed = false
  const messages = request.messages.map((message) => {
    const content: Content[] = []
    for (const item of message.content) {
      if (item.type === "image") {
        changed = true
        content.push({ type: "text", text: "[image attachment omitted: model has no vision support]" })
        continue
      }
      if (item.type === "tool-result" && item.attachments?.length) {
        changed = true
        content.push({ ...item, attachments: undefined })
        continue
      }
      content.push(item)
    }
    return changed ? { ...message, content } : message
  })
  return changed ? { ...request, messages } : request
}

/**
 * Some OpenAI-compatible gateways choke on a `system` role appearing anywhere
 * other than first. Merge all system lines into one leading block.
 */
export const mergeSystem: Transform = ({ request }) => {
  const lines = request.system ?? []
  if (lines.length <= 1) return request
  return { ...request, system: [lines.join("\n\n")] }
}

/**
 * Applies provider-specific header requirements that depend on request content
 * rather than static configuration.
 */
export const contentHeaders: Transform = ({ request, provider }) => {
  if (provider.transport !== "github-copilot") return request
  const hasImage = request.messages.some((message) =>
    message.content.some((item) => item.type === "image"),
  )
  if (!hasImage) return request
  return {
    ...request,
    headers: { ...(request.headers ?? {}), "copilot-vision-request": "true" },
  }
}

/**
 * Caps parallel tool calls for providers whose implementations are unreliable
 * with more than a handful in flight.
 */
export const limitParallelTools: Transform = ({ request, provider }) => {
  if (request.parallelToolCalls !== undefined) return request
  // Local inference servers serialise anyway and often mis-handle arrays.
  if (provider.transport === "ollama") return { ...request, parallelToolCalls: false }
  return request
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

const PIPELINE: Transform[] = [
  dropEmptyContent,
  stripTools,
  stripAttachments,
  conformToolIds,
  resolveTemperature,
  resolveReasoning,
  clampOutputTokens,
  markPromptCache,
  limitParallelTools,
  contentHeaders,
]

/** Applies every transform in order. */
export function applyTransforms(input: TransformInput): LlmRequest {
  let request = input.request
  for (const transform of PIPELINE) {
    request = transform({ ...input, request })
  }
  return request
}

/** Adds a custom transform, used by plugins. */
export function registerTransform(transform: Transform, position: "start" | "end" = "end"): void {
  if (position === "start") PIPELINE.unshift(transform)
  else PIPELINE.push(transform)
}

/* ------------------------------------------------------------------ */
/* Transport context assembly                                          */
/* ------------------------------------------------------------------ */

export function buildTransportContext(
  provider: ResolvedProvider,
  model: ResolvedModel,
): TransportContext {
  return {
    providerId: provider.id,
    modelId: model.modelId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    headers: { ...provider.headers, ...model.headers },
    query: provider.query,
    timeoutMs: provider.timeoutMs,
    retries: provider.retries,
    options: { ...provider.options, ...model.options },
    capabilities: model.capabilities,
  }
}
