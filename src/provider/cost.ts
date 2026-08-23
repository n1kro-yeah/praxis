/**
 * Cost accounting and rate limiting.
 *
 * Everything here is deliberately synchronous and allocation-light: it runs on
 * every streamed step and must not show up in a profile.
 */

import { SlidingWindow, TokenBucket } from "../util/misc.js"
import type { LlmUsage } from "../llm/types.js"
import type { ModelCost, ResolvedModel } from "./types.js"
import { computeCost } from "./types.js"

export interface CostBreakdown {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly total: number
}

export function costBreakdown(cost: ModelCost, usage: LlmUsage): CostBreakdown {
  const million = 1_000_000
  const input = (usage.input * cost.input) / million
  const output = (usage.output * cost.output) / million
  const reasoning = (usage.reasoning * (cost.reasoning ?? cost.output)) / million
  const cacheRead = (usage.cacheRead * (cost.cacheRead ?? cost.input)) / million
  const cacheWrite = (usage.cacheWrite * (cost.cacheWrite ?? cost.input * 1.25)) / million
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  }
}

export function usageCost(model: ResolvedModel, usage: LlmUsage): number {
  return computeCost(model.cost, usage)
}

/**
 * Estimates the cost of a request before sending it. Used by the `--dry-run`
 * path and by the TUI's context meter.
 */
export function estimateCost(model: ResolvedModel, inputTokens: number, outputTokens: number): number {
  return computeCost(model.cost, { input: inputTokens, output: outputTokens })
}

/** Cumulative cost tracker for a session or the whole process. */
export class CostTracker {
  private totalUsd = 0
  private readonly perModel = new Map<string, { usd: number; usage: LlmUsage }>()

  add(model: ResolvedModel, usage: LlmUsage): number {
    const cost = usageCost(model, usage)
    this.totalUsd += cost
    const existing = this.perModel.get(model.ref)
    if (existing) {
      existing.usd += cost
      existing.usage = {
        input: existing.usage.input + usage.input,
        output: existing.usage.output + usage.output,
        reasoning: existing.usage.reasoning + usage.reasoning,
        cacheRead: existing.usage.cacheRead + usage.cacheRead,
        cacheWrite: existing.usage.cacheWrite + usage.cacheWrite,
      }
    } else {
      this.perModel.set(model.ref, { usd: cost, usage: { ...usage } })
    }
    return cost
  }

  get total(): number {
    return this.totalUsd
  }

  breakdown(): Array<{ ref: string; usd: number; usage: LlmUsage }> {
    return [...this.perModel.entries()]
      .map(([ref, value]) => ({ ref, usd: value.usd, usage: value.usage }))
      .sort((a, b) => b.usd - a.usd)
  }

  reset(): void {
    this.totalUsd = 0
    this.perModel.clear()
  }
}

/**
 * Per-provider rate limiting.
 *
 * Two independent constraints matter in practice: requests per minute (hit
 * constantly by parallel subagents) and tokens per minute (hit by long
 * contexts). We model RPM with a token bucket for burst tolerance and TPM with
 * a sliding window because token cost is only known per request.
 */
export class ProviderRateLimiter {
  private readonly requests?: TokenBucket
  private readonly tokens?: SlidingWindow

  constructor(
    readonly providerId: string,
    requestsPerMinute?: number,
    private readonly tokensPerMinute?: number,
  ) {
    if (requestsPerMinute && requestsPerMinute > 0) {
      this.requests = new TokenBucket(requestsPerMinute, requestsPerMinute / 60)
    }
    if (tokensPerMinute && tokensPerMinute > 0) {
      this.tokens = new SlidingWindow(60_000)
    }
  }

  /** Waits until the request is allowed to proceed. */
  async acquire(estimatedTokens: number, signal?: AbortSignal): Promise<void> {
    if (this.requests) await this.requests.take(1, signal)
    if (this.tokens && this.tokensPerMinute) {
      // Spin with backoff until the window has room. Requests are coarse
      // enough (hundreds of ms at minimum) that a 250ms poll is fine.
      while (this.tokens.sum() + estimatedTokens > this.tokensPerMinute) {
        if (signal?.aborted) throw new Error("aborted")
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }

  /** Records actual consumption after the response is known. */
  record(tokens: number): void {
    this.tokens?.add(tokens)
  }

  /** Applies a provider-supplied Retry-After hint. */
  penalize(ms: number): void {
    this.requests?.drain()
    this.retryAfterUntil = Date.now() + ms
  }

  private retryAfterUntil = 0

  get penaltyRemainingMs(): number {
    return Math.max(0, this.retryAfterUntil - Date.now())
  }
}

const limiters = new Map<string, ProviderRateLimiter>()

export function rateLimiter(
  providerId: string,
  requestsPerMinute?: number,
  tokensPerMinute?: number,
): ProviderRateLimiter {
  const existing = limiters.get(providerId)
  if (existing) return existing
  const limiter = new ProviderRateLimiter(providerId, requestsPerMinute, tokensPerMinute)
  limiters.set(providerId, limiter)
  return limiter
}

export function resetRateLimiters(): void {
  limiters.clear()
}

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

export interface BudgetOptions {
  /** Hard stop: abort the session once exceeded. */
  readonly maxSessionUsd?: number
  /** Soft warning threshold. */
  readonly warnSessionUsd?: number
  readonly maxDailyUsd?: number
}

export type BudgetVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "warn"; readonly message: string }
  | { readonly kind: "exceeded"; readonly message: string }

export class BudgetGuard {
  private warned = false

  constructor(
    private readonly options: BudgetOptions,
    private readonly dailySpend: () => number,
  ) {}

  check(sessionUsd: number): BudgetVerdict {
    if (this.options.maxSessionUsd && sessionUsd >= this.options.maxSessionUsd) {
      return {
        kind: "exceeded",
        message: `Session cost $${sessionUsd.toFixed(2)} reached the configured limit of $${this.options.maxSessionUsd.toFixed(2)}.`,
      }
    }
    if (this.options.maxDailyUsd) {
      const today = this.dailySpend()
      if (today >= this.options.maxDailyUsd) {
        return {
          kind: "exceeded",
          message: `Daily spend $${today.toFixed(2)} reached the configured limit of $${this.options.maxDailyUsd.toFixed(2)}.`,
        }
      }
    }
    if (
      !this.warned &&
      this.options.warnSessionUsd &&
      sessionUsd >= this.options.warnSessionUsd
    ) {
      this.warned = true
      return {
        kind: "warn",
        message: `Session cost has reached $${sessionUsd.toFixed(2)}.`,
      }
    }
    return { kind: "ok" }
  }
}
