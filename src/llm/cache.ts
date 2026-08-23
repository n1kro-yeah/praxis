/**
 * Response caching.
 *
 * Two distinct caches live here, both important for a coding agent:
 *
 * 1. **Prompt-prefix bookkeeping.** Providers with server-side prompt caching
 *    only give a discount when the prefix is byte-identical to a previous
 *    request. Reordering tools or regenerating a timestamp in the system prompt
 *    silently destroys the cache and multiplies cost. This module tracks the
 *    prefix fingerprint per session and warns when it changes unexpectedly.
 *
 * 2. **Local result memoisation.** Deterministic internal calls (title
 *    generation, classification, small deterministic completions with
 *    temperature 0) are cached on disk so repeated runs over the same content
 *    cost nothing. Never used for the main agent loop, where caching would be
 *    both wrong and confusing.
 */

import type { LlmRequest, LlmResult, LlmUsage } from "./types.js"
import { database } from "../storage/db.js"
import { xxhash32 } from "../util/hash.js"
import { logger } from "../util/log.js"
import { LruCache } from "../util/async.js"

const log = logger("llm.cache")

/* ------------------------------------------------------------------ */
/* Prompt prefix stability                                             */
/* ------------------------------------------------------------------ */

export interface PrefixReport {
  readonly fingerprint: string
  readonly stable: boolean
  /** Which component changed, when the fingerprint differs. */
  readonly changed?: "system" | "tools" | "both"
}

interface PrefixState {
  system: string
  tools: string
}

const prefixes = new Map<string, PrefixState>()

/**
 * Computes and records the cacheable prefix fingerprint for a session.
 *
 * The prefix is the system prompt plus the tool definitions: everything a
 * provider can cache before the first user message. Any change invalidates the
 * server-side cache for the whole conversation, so an unexpected change is a
 * cost bug worth surfacing in the log.
 */
export function trackPrefix(sessionId: string, request: LlmRequest): PrefixReport {
  const system = xxhash32((request.system ?? []).join("\u0000")).toString(16)
  const tools = xxhash32(
    (request.tools ?? [])
      .map((tool) => `${tool.name}\u0000${tool.description}\u0000${JSON.stringify(tool.parameters)}`)
      .join("\u0001"),
  ).toString(16)
  const fingerprint = `${system}:${tools}`

  const previous = prefixes.get(sessionId)
  prefixes.set(sessionId, { system, tools })

  if (!previous) return { fingerprint, stable: true }
  const systemChanged = previous.system !== system
  const toolsChanged = previous.tools !== tools
  if (!systemChanged && !toolsChanged) return { fingerprint, stable: true }

  const changed = systemChanged && toolsChanged ? "both" : systemChanged ? "system" : "tools"
  log.warn("prompt cache prefix changed mid-session", { sessionId, changed })
  return { fingerprint, stable: false, changed }
}

export function forgetPrefix(sessionId: string): void {
  prefixes.delete(sessionId)
}

/**
 * Estimates the savings realised by prompt caching for a request.
 * Used by the `/cost` view to show whether caching is working.
 */
export function cacheEfficiency(usage: LlmUsage): {
  hitRate: number
  cachedTokens: number
} {
  const total = usage.input + usage.cacheRead
  if (total === 0) return { hitRate: 0, cachedTokens: 0 }
  return { hitRate: usage.cacheRead / total, cachedTokens: usage.cacheRead }
}

/* ------------------------------------------------------------------ */
/* Result memoisation                                                  */
/* ------------------------------------------------------------------ */

export interface CachedResult {
  readonly text: string
  readonly usage: LlmUsage
  readonly createdAt: number
}

const memory = new LruCache<string, CachedResult>(256)

/**
 * Builds the cache key. Only deterministic requests are cacheable, so the key
 * deliberately includes every field that can change the output.
 */
export function cacheKey(request: LlmRequest): string {
  const parts: string[] = [
    request.modelId,
    String(request.temperature ?? ""),
    String(request.topP ?? ""),
    String(request.seed ?? ""),
    (request.system ?? []).join("\u0000"),
  ]
  for (const message of request.messages) {
    parts.push(message.role)
    for (const item of message.content) {
      if (item.type === "text") parts.push(item.text)
      else if (item.type === "tool-result") parts.push(item.output)
      else if (item.type === "tool-call") parts.push(item.toolName, item.inputText ?? "")
      else parts.push(item.type)
    }
  }
  return xxhash32(parts.join("\u0001")).toString(16)
}

/** True when a request's output is stable enough to cache. */
export function isCacheable(request: LlmRequest): boolean {
  if (request.tools?.length) return false
  if ((request.temperature ?? 0) > 0) return false
  for (const message of request.messages) {
    for (const item of message.content) {
      // Binary content makes keys huge and is rarely repeated verbatim.
      if (item.type === "image" || item.type === "file") return false
    }
  }
  return true
}

export function lookup(request: LlmRequest, maxAgeMs = 7 * 24 * 3_600_000): CachedResult | undefined {
  if (!isCacheable(request)) return undefined
  const key = cacheKey(request)

  const hot = memory.get(key)
  if (hot && Date.now() - hot.createdAt <= maxAgeMs) return hot

  try {
    const row = database().get<{ value: string; created_at: number }>(
      "SELECT value, created_at FROM kv WHERE key = ?",
      `llm.cache.${key}`,
    )
    if (!row) return undefined
    if (Date.now() - row.created_at > maxAgeMs) return undefined
    const parsed = JSON.parse(row.value) as CachedResult
    memory.set(key, parsed)
    return parsed
  } catch {
    return undefined
  }
}

export function store(request: LlmRequest, result: LlmResult): void {
  if (!isCacheable(request)) return
  const key = cacheKey(request)
  const entry: CachedResult = {
    text: result.text,
    usage: result.usage,
    createdAt: Date.now(),
  }
  memory.set(key, entry)
  try {
    database().run(
      "INSERT INTO kv (key, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      `llm.cache.${key}`,
      JSON.stringify(entry),
      entry.createdAt,
      entry.createdAt,
    )
  } catch (error) {
    log.debug("failed to persist cache entry", { error: String(error) })
  }
}

export function clearCache(): void {
  memory.clear()
  try {
    database().run("DELETE FROM kv WHERE key LIKE 'llm.cache.%'")
  } catch {
    // Non-fatal.
  }
}

/* ------------------------------------------------------------------ */
/* Deduplication of in-flight requests                                 */
/* ------------------------------------------------------------------ */

const inflight = new Map<string, Promise<LlmResult>>()

/**
 * Collapses identical concurrent requests into one.
 *
 * Parallel subagents frequently ask the same small question at the same moment
 * (for example generating a title for the same file set), and paying twice for
 * a byte-identical request is pure waste.
 */
export async function dedupe(
  request: LlmRequest,
  operation: () => Promise<LlmResult>,
): Promise<LlmResult> {
  if (!isCacheable(request)) return operation()
  const key = cacheKey(request)

  const existing = inflight.get(key)
  if (existing) {
    log.debug("joined in-flight identical request", { key })
    return existing
  }

  const promise = operation()
  inflight.set(key, promise)
  try {
    const result = await promise
    store(request, result)
    return result
  } finally {
    inflight.delete(key)
  }
}
