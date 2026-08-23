/**
 * LLM streaming orchestration.
 *
 * This is the layer between the session engine and the transports. It owns:
 *   - applying provider transforms and building the transport context
 *   - rate limiting and cost accounting
 *   - retrying with the policy in `retry.ts`, including mid-stream failures
 *   - accumulating the event stream into a complete `LlmResult`
 *   - emitting bus events so the TUI can render tokens as they arrive
 *
 * The critical invariant: a retry is only safe while nothing has been committed
 * downstream. Once a text delta has been forwarded to the caller, retrying would
 * duplicate output, so the stream fails instead and lets the session engine
 * decide (usually by inserting an error part and letting the user continue).
 */

import type {
  LlmRequest,
  LlmResult,
  LlmStreamEvent,
  LlmUsage,
  Transport,
} from "./types.js"
import { mergeUsage, normalizeFinishReason, zeroUsage } from "./types.js"
import { Bus, Events } from "../util/bus.js"
import { ProviderError } from "../util/error.js"
import { newId } from "../util/id.js"
import { logger } from "../util/log.js"
import { estimateTokens } from "../util/tokenizer.js"
import { rateLimiter, usageCost } from "../provider/cost.js"
import { applyTransforms, buildTransportContext } from "../provider/transform.js"
import type { ResolvedModel, ResolvedProvider } from "../provider/types.js"
import {
  DEFAULT_RETRY_POLICY,
  classify,
  explain,
  withRetry,
  type RetryPolicy,
} from "./retry.js"

const log = logger("llm.stream")

export interface StreamOptions {
  readonly request: LlmRequest
  readonly provider: ResolvedProvider
  readonly model: ResolvedModel
  readonly transport: Transport
  readonly policy?: RetryPolicy
  /** Session id for bus events and usage attribution. */
  readonly sessionId?: string
  readonly messageId?: string
}

/**
 * Streams a completion, yielding normalised events.
 *
 * Retries are transparent while no content has been emitted; after that a
 * failure surfaces as an `error` event followed by a `finish`.
 */
export async function* streamCompletion(
  options: StreamOptions,
): AsyncGenerator<LlmStreamEvent> {
  const { provider, model, transport } = options
  const requestId = options.request.requestId ?? newId("request")
  const context = buildTransportContext(provider, model)
  const request = applyTransforms({
    request: { ...options.request, requestId },
    provider,
    model,
  })

  const limiter = rateLimiter(provider.id, provider.requestsPerMinute, provider.tokensPerMinute)
  const estimatedInput = estimateRequestTokens(request)

  let committed = false
  let attempts = 0

  const policy = options.policy ?? DEFAULT_RETRY_POLICY
  let lastError: unknown

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    attempts = attempt
    if (request.signal?.aborted) {
      yield { type: "finish", finishReason: "aborted", usage: zeroUsage() }
      return
    }

    try {
      await limiter.acquire(estimatedInput, request.signal)
    } catch {
      yield { type: "finish", finishReason: "aborted", usage: zeroUsage() }
      return
    }

    const started = Date.now()
    let usage: LlmUsage = zeroUsage()
    let failed: unknown

    try {
      for await (const event of transport.stream(request, context)) {
        // Mark the point of no return.
        if (
          event.type === "text-delta" ||
          event.type === "reasoning-delta" ||
          event.type === "tool-call" ||
          event.type === "tool-call-delta"
        ) {
          committed = true
        }

        if (event.type === "finish") usage = event.usage

        if (event.type === "error") {
          const classified = classify({
            message: event.error.message,
            name: event.error.name,
            status: event.error.status,
          })
          // A retryable error before commit is handled by the retry loop.
          if (classified.retryable && !committed && attempt < policy.maxAttempts) {
            failed = Object.assign(new ProviderError(event.error.message), {
              status: event.error.status,
            })
            break
          }
        }

        yield event
      }
    } catch (error) {
      failed = error
    }

    if (!failed) {
      limiter.record(usage.input + usage.output)
      const cost = usageCost(model, usage)
      log.info("request complete", {
        provider: provider.id,
        model: model.modelId,
        durationMs: Date.now() - started,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cost: Number(cost.toFixed(6)),
        attempts,
      })
      Bus.publish(Events.llmRequestCompleted, {
        requestId,
        sessionId: options.sessionId,
        provider: provider.id,
        model: model.modelId,
        usage,
        cost,
        durationMs: Date.now() - started,
      })
      return
    }

    lastError = failed
    const classified = classify(failed)

    if (classified.kind === "aborted") {
      yield { type: "finish", finishReason: "aborted", usage: zeroUsage() }
      return
    }

    if (classified.retryAfterMs) limiter.penalize(classified.retryAfterMs)

    const canRetry = classified.retryable && !committed && attempt < policy.maxAttempts
    if (!canRetry) {
      log.error("request failed", {
        provider: provider.id,
        model: model.modelId,
        kind: classified.kind,
        status: classified.status,
        committed,
        attempts,
      })
      Bus.publish(Events.llmRequestFailed, {
        requestId,
        sessionId: options.sessionId,
        provider: provider.id,
        model: model.modelId,
        kind: classified.kind,
        message: classified.message,
      })
      yield {
        type: "error",
        error: {
          name: classified.kind,
          message: explain(classified, model.ref),
          retryable: classified.retryable,
          status: classified.status,
        },
      }
      yield {
        type: "finish",
        finishReason: classified.kind === "content-filter" ? "content-filter" : "error",
        usage: zeroUsage(),
      }
      return
    }

    const { backoffDelay } = await import("./retry.js")
    const delayMs = backoffDelay(attempt, policy, classified.retryAfterMs)
    yield {
      type: "warning",
      message: `${classified.kind}: retrying in ${Math.round(delayMs / 100) / 10}s (attempt ${attempt + 1}/${policy.maxAttempts})`,
    }
    Bus.publish(Events.llmRequestRetried, {
      requestId,
      sessionId: options.sessionId,
      attempt,
      kind: classified.kind,
      delayMs,
    })
    const { sleep } = await import("../util/async.js")
    await sleep(delayMs, request.signal)
  }

  yield {
    type: "error",
    error: {
      name: "ProviderError",
      message: explain(classify(lastError), model.ref),
      retryable: false,
    },
  }
  yield { type: "finish", finishReason: "error", usage: zeroUsage() }
}

/* ------------------------------------------------------------------ */
/* Accumulation                                                        */
/* ------------------------------------------------------------------ */

export interface AccumulatedStream {
  readonly text: string
  readonly reasoning: string
  readonly reasoningSignature?: string
  readonly reasoningEncrypted?: string
  readonly toolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    inputText: string
  }>
  readonly usage: LlmUsage
  readonly finishReason: string
  readonly warnings: string[]
  readonly errors: Array<{ name: string; message: string }>
}

/**
 * Consumes a stream into a complete result. Used by non-interactive callers
 * (title generation, compaction, `praxis run --json`) that do not need deltas.
 */
export async function collectCompletion(
  events: AsyncIterable<LlmStreamEvent>,
): Promise<AccumulatedStream> {
  let text = ""
  let reasoning = ""
  let reasoningSignature: string | undefined
  let reasoningEncrypted: string | undefined
  const toolCalls: AccumulatedStream["toolCalls"] = []
  const warnings: string[] = []
  const errors: Array<{ name: string; message: string }> = []
  let usage: LlmUsage = zeroUsage()
  let finishReason = "unknown"

  for await (const event of events) {
    switch (event.type) {
      case "text-delta":
        text += event.delta
        break
      case "reasoning-delta":
        reasoning += event.delta
        break
      case "reasoning-end":
        if (event.signature) reasoningSignature = event.signature
        if (event.encrypted) reasoningEncrypted = event.encrypted
        break
      case "tool-call":
        toolCalls.push({
          id: event.toolCallId,
          name: event.toolName,
          input: event.input,
          inputText: event.inputText ?? JSON.stringify(event.input),
        })
        break
      case "step-finish":
        usage = mergeUsage(usage, event.usage)
        break
      case "finish":
        // The finish usage is authoritative and already cumulative.
        usage = event.usage.input > 0 || event.usage.output > 0 ? event.usage : usage
        finishReason = event.finishReason
        break
      case "warning":
        warnings.push(event.message)
        break
      case "error":
        errors.push({ name: event.error.name, message: event.error.message })
        break
      default:
        break
    }
  }

  return {
    text,
    reasoning,
    reasoningSignature,
    reasoningEncrypted,
    toolCalls,
    usage,
    finishReason: normalizeFinishReason(finishReason),
    warnings,
    errors,
  }
}

/** Convenience wrapper: stream and collect in one call. */
export async function generate(options: StreamOptions): Promise<LlmResult> {
  const accumulated = await collectCompletion(streamCompletion(options))
  if (accumulated.errors.length && accumulated.text === "" && accumulated.toolCalls.length === 0) {
    const first = accumulated.errors[0]
    throw new ProviderError(first?.message ?? "provider request failed")
  }
  return {
    text: accumulated.text,
    reasoning: accumulated.reasoning === "" ? undefined : accumulated.reasoning,
    toolCalls: accumulated.toolCalls.map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.id,
      toolName: call.name,
      input: call.input,
      inputText: call.inputText,
    })),
    usage: accumulated.usage,
    finishReason: normalizeFinishReason(accumulated.finishReason),
    warnings: accumulated.warnings,
  }
}

/* ------------------------------------------------------------------ */
/* Estimation                                                          */
/* ------------------------------------------------------------------ */

/** Rough input token estimate, used for rate limiting before the call. */
export function estimateRequestTokens(request: LlmRequest): number {
  let total = 0
  for (const line of request.system ?? []) total += estimateTokens(line)
  for (const message of request.messages) {
    for (const item of message.content) {
      switch (item.type) {
        case "text":
          total += estimateTokens(item.text)
          break
        case "reasoning":
          total += estimateTokens(item.text)
          break
        case "tool-call":
          total += estimateTokens(item.inputText ?? JSON.stringify(item.input)) + 8
          break
        case "tool-result":
          total += estimateTokens(item.output) + 8
          break
        case "image":
          // Vision models charge roughly this much for a typical screenshot.
          total += 1_200
          break
        case "file":
          total += item.text ? estimateTokens(item.text) : 2_000
          break
      }
    }
    total += 4
  }
  for (const tool of request.tools ?? []) {
    total += estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.parameters))
  }
  return total
}

/**
 * Splits an event stream so both the UI and the persistence layer can consume
 * it without buffering the whole response in memory.
 */
export async function* tee(
  events: AsyncIterable<LlmStreamEvent>,
  observer: (event: LlmStreamEvent) => void | Promise<void>,
): AsyncGenerator<LlmStreamEvent> {
  for await (const event of events) {
    await observer(event)
    yield event
  }
}

/**
 * Coalesces rapid text deltas into larger chunks.
 *
 * Providers can emit one event per token; forwarding each through the worker
 * RPC bridge to the TUI costs more than rendering it. Buffering by time keeps
 * perceived latency low while cutting event volume by an order of magnitude.
 */
export async function* coalesce(
  events: AsyncIterable<LlmStreamEvent>,
  windowMs = 24,
): AsyncGenerator<LlmStreamEvent> {
  let pending: { id: string; delta: string } | undefined
  let lastFlush = Date.now()

  for await (const event of events) {
    if (event.type === "text-delta") {
      if (pending && pending.id === event.id) pending.delta += event.delta
      else {
        if (pending) yield { type: "text-delta", id: pending.id, delta: pending.delta }
        pending = { id: event.id, delta: event.delta }
      }
      if (Date.now() - lastFlush >= windowMs) {
        yield { type: "text-delta", id: pending.id, delta: pending.delta }
        pending = undefined
        lastFlush = Date.now()
      }
      continue
    }
    if (pending) {
      yield { type: "text-delta", id: pending.id, delta: pending.delta }
      pending = undefined
      lastFlush = Date.now()
    }
    yield event
  }

  if (pending) yield { type: "text-delta", id: pending.id, delta: pending.delta }
}
