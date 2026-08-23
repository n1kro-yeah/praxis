/**
 * Retry policy for LLM requests.
 *
 * Getting this right matters more than it looks. Provider failures during a
 * long agentic run are routine: rate limits, transient 5xx, overloaded upstream
 * capacity, and connection resets mid-stream. A naive retry loses the partial
 * stream and re-bills the input tokens; no retry aborts a task the user has
 * already paid for. The policy below distinguishes:
 *
 *   - retryable before any output   -> full retry, cheap and safe
 *   - retryable after partial output -> retry only if nothing was committed
 *   - non-retryable (400, auth, content filter) -> fail immediately
 *   - context overflow -> signal the caller to compact rather than retry
 */

import { AbortedError, ProviderError, RateLimitError, isRetryable } from "../util/error.js"
import { sleep } from "../util/async.js"
import { logger } from "../util/log.js"

const log = logger("llm.retry")

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly multiplier: number
  /** Random fraction added to each delay to avoid thundering herds. */
  readonly jitter: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: 0.25,
}

/** Aggressive policy for internal, low-value calls such as title generation. */
export const FAST_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  initialDelayMs: 500,
  maxDelayMs: 2_000,
  multiplier: 2,
  jitter: 0.2,
}

export type FailureKind =
  | "rate-limit"
  | "overloaded"
  | "timeout"
  | "network"
  | "server"
  | "context-overflow"
  | "auth"
  | "invalid-request"
  | "content-filter"
  | "aborted"
  | "unknown"

export interface Classified {
  readonly kind: FailureKind
  readonly retryable: boolean
  /** Provider-supplied wait hint, in milliseconds. */
  readonly retryAfterMs?: number
  readonly message: string
  readonly status?: number
}

const CONTEXT_PATTERNS = [
  /context[_\s-]?length/i,
  /maximum context/i,
  /too many tokens/i,
  /prompt is too long/i,
  /reduce the length/i,
  /input length and `max_tokens` exceed/i,
  /string too long/i,
  /exceeds the maximum/i,
]

const AUTH_PATTERNS = [
  /invalid[_\s-]?api[_\s-]?key/i,
  /incorrect api key/i,
  /unauthorized/i,
  /authentication/i,
  /permission denied/i,
  /expired/i,
  /no credentials/i,
]

const FILTER_PATTERNS = [
  /content[_\s-]?filter/i,
  /content policy/i,
  /safety/i,
  /responsible ai/i,
  /blocked by/i,
]

const OVERLOAD_PATTERNS = [
  /overloaded/i,
  /capacity/i,
  /try again later/i,
  /service unavailable/i,
  /model is currently loading/i,
  /server is busy/i,
]

const NETWORK_PATTERNS = [
  /ECONNRESET/,
  /ECONNREFUSED/,
  /EPIPE/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /ENOTFOUND/,
  /socket hang up/i,
  /network|fetch failed/i,
  /terminated/i,
  /other side closed/i,
]

/**
 * Classifies an error into an actionable failure kind.
 *
 * Message sniffing is unavoidable: providers use overlapping status codes for
 * very different problems (400 for both a malformed request and a context
 * overflow; 429 for both a rate limit and a hard quota exhaustion).
 */
export function classify(error: unknown): Classified {
  if (error instanceof AbortedError) {
    return { kind: "aborted", retryable: false, message: error.message }
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error)
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status) || undefined
      : undefined
  const retryAfterMs =
    error && typeof error === "object" && "retryAfterMs" in error
      ? Number((error as { retryAfterMs?: unknown }).retryAfterMs) || undefined
      : undefined

  // Context overflow must be detected before the generic 400 handling.
  if (CONTEXT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "context-overflow", retryable: false, message, status }
  }

  if (status === 429 || error instanceof RateLimitError) {
    // A quota exhaustion is not worth retrying; a rate limit is.
    const isQuota = /quota|billing|credit|insufficient/i.test(message)
    return {
      kind: "rate-limit",
      retryable: !isQuota,
      retryAfterMs,
      message,
      status: status ?? 429,
    }
  }

  if (status === 401 || status === 403 || AUTH_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "auth", retryable: false, message, status }
  }

  if (FILTER_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "content-filter", retryable: false, message, status }
  }

  if (status === 529 || OVERLOAD_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "overloaded", retryable: true, retryAfterMs, message, status }
  }

  if (status !== undefined && status >= 500) {
    return { kind: "server", retryable: true, retryAfterMs, message, status }
  }

  if (/timeout|timed out|AbortError/i.test(message)) {
    return { kind: "timeout", retryable: true, message, status }
  }

  if (NETWORK_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "network", retryable: true, message, status }
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: "invalid-request", retryable: false, message, status }
  }

  return { kind: "unknown", retryable: isRetryable(error), message, status }
}

/** Computes the delay before the given attempt (1-based). */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs?: number,
): number {
  // A provider hint always wins: it reflects the real reset window.
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, policy.maxDelayMs * 4)
  }
  const exponential = policy.initialDelayMs * policy.multiplier ** (attempt - 1)
  const capped = Math.min(exponential, policy.maxDelayMs)
  const jitter = capped * policy.jitter * Math.random()
  return Math.round(capped + jitter)
}

export interface RetryContext {
  readonly attempt: number
  readonly classified: Classified
  readonly delayMs: number
}

export interface RetryOptions {
  readonly policy?: RetryPolicy
  readonly signal?: AbortSignal
  readonly onRetry?: (context: RetryContext) => void
  /** Called for non-retryable failures so callers can react (e.g. compact). */
  readonly onFailure?: (classified: Classified) => void
  /** Extra predicate, e.g. "do not retry once output was committed". */
  readonly canRetry?: (classified: Classified, attempt: number) => boolean
}

/**
 * Runs an operation with the retry policy applied.
 *
 * The operation receives the attempt number so it can adapt, for example by
 * dropping optional request features that a flaky gateway rejects.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY
  let lastError: unknown

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new AbortedError("Request aborted")
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      const classified = classify(error)

      if (classified.kind === "aborted") throw error
      if (!classified.retryable || attempt === policy.maxAttempts) {
        options.onFailure?.(classified)
        throw error
      }
      if (options.canRetry && !options.canRetry(classified, attempt)) {
        options.onFailure?.(classified)
        throw error
      }

      const delayMs = backoffDelay(attempt, policy, classified.retryAfterMs)
      log.warn("retrying provider request", {
        attempt,
        kind: classified.kind,
        status: classified.status,
        delayMs,
      })
      options.onRetry?.({ attempt, classified, delayMs })
      await sleep(delayMs, options.signal)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ProviderError(String(lastError ?? "request failed"))
}

/**
 * Produces a human-readable explanation with a concrete next step. Shown in the
 * TUI when a request finally fails; a bare provider message is rarely actionable.
 */
export function explain(classified: Classified, modelRef: string): string {
  switch (classified.kind) {
    case "rate-limit":
      return /quota|billing|credit/i.test(classified.message)
        ? `${modelRef} reported an exhausted quota. Check billing, or switch model with /models.`
        : `${modelRef} is rate limited. Waiting and retrying usually resolves it; /models switches provider.`
    case "overloaded":
      return `${modelRef} is overloaded upstream. Retry shortly or switch model with /models.`
    case "context-overflow":
      return `The conversation exceeds ${modelRef}'s context window. Run /compact to summarise it, or /new to start fresh.`
    case "auth":
      return `Authentication failed for ${modelRef}. Run \`praxis auth login\` for that provider.`
    case "content-filter":
      return `${modelRef} refused the request through its safety filter. Rephrasing or another model usually works.`
    case "timeout":
      return `${modelRef} timed out. Large contexts and reasoning models can exceed the default timeout; raise provider.timeoutMs.`
    case "network":
      return "Network error reaching the provider. Check connectivity and any proxy settings."
    case "server":
      return `${modelRef} returned a server error (${classified.status ?? "5xx"}). This is upstream; retrying is usually enough.`
    case "invalid-request":
      return `${modelRef} rejected the request: ${classified.message}`
    case "aborted":
      return "Request cancelled."
    default:
      return classified.message
  }
}

/** True when the failure should trigger automatic compaction and one more try. */
export function shouldCompact(classified: Classified): boolean {
  return classified.kind === "context-overflow"
}

/** True when the failure warrants falling back to a different model. */
export function shouldFallback(classified: Classified): boolean {
  return (
    classified.kind === "overloaded" ||
    (classified.kind === "rate-limit" && !classified.retryable) ||
    classified.kind === "content-filter"
  )
}
