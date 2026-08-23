/**
 * HTTP client with retries, streaming and Server-Sent Events.
 *
 * Every provider transport goes through this module. It handles the things that
 * separate a demo from production: bounded retries with jittered backoff,
 * `Retry-After` compliance, idle-timeout detection on streams (a hung TLS
 * connection is the most common provider failure), proxy support, and request
 * dumping for debugging.
 */

import fs from "node:fs"
import path from "node:path"
import { Flag } from "../flag.js"
import { Limits, USER_AGENT } from "../global.js"
import { sleep } from "./async.js"
import {
  AbortedError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  isRetryable,
} from "./error.js"
import { logger } from "./log.js"
import { shortId } from "./id.js"

const log = logger("http")

export interface RequestOptions {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string | Uint8Array | Record<string, unknown>
  readonly query?: Record<string, string | number | boolean | undefined>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** Idle timeout between chunks while streaming. */
  readonly idleTimeoutMs?: number
  readonly retries?: number
  /** Status codes worth retrying beyond the defaults. */
  readonly retryOn?: readonly number[]
  /** Label used in logs and error messages. */
  readonly label?: string
  /** Skip JSON content-type inference. */
  readonly raw?: boolean
}

export interface HttpResponse<T = unknown> {
  readonly status: number
  readonly ok: boolean
  readonly headers: Record<string, string>
  readonly body: T
  readonly requestId: string
  readonly durationMs: number
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524, 529])

function buildUrl(url: string, query?: RequestOptions["query"]): string {
  if (!query) return url
  const target = new URL(url)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    target.searchParams.set(key, String(value))
  }
  return target.toString()
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

function dumpDirectory(): string | undefined {
  const dir = Flag.dumpRequests()
  if (!dir) return undefined
  try {
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return undefined
  }
}

function dump(name: string, payload: unknown): void {
  const dir = dumpDirectory()
  if (!dir) return
  try {
    fs.writeFileSync(
      path.join(dir, `${Date.now()}-${name}.json`),
      typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    )
  } catch {
    /* debugging aid only */
  }
}

/** Normalises the body and content-type header. */
function prepareBody(options: RequestOptions): {
  body: string | Uint8Array | undefined
  headers: Record<string, string>
} {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    ...(options.headers ?? {}),
  }
  if (options.body === undefined) return { body: undefined, headers }
  if (typeof options.body === "string" || options.body instanceof Uint8Array) {
    return { body: options.body, headers }
  }
  if (!headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json"
  }
  return { body: JSON.stringify(options.body), headers }
}

/**
 * Performs a request with retries. Only idempotent-safe failures are retried:
 * network errors, 429s and 5xx responses.
 */
export async function request<T = unknown>(
  url: string,
  options: RequestOptions = {},
): Promise<HttpResponse<T>> {
  const attempts = (options.retries ?? Flag.providerRetries() ?? Limits.providerRetries) + 1
  const timeoutMs = options.timeoutMs ?? Flag.providerTimeout() ?? Limits.httpTimeoutMs
  const target = buildUrl(url, options.query)
  const { body, headers } = prepareBody(options)
  const requestId = shortId(10)
  const label = options.label ?? new URL(target).host

  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now()
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new TimeoutError({ operation: label, timeoutMs })), timeoutMs)

    try {
      if (attempt === 1) dump(`${label}-request-${requestId}`, { url: target, headers, body })

      const response = await fetch(target, {
        method: options.method ?? "GET",
        headers,
        body: body as BodyInit | undefined,
        signal: controller.signal,
        // Providers stream; never let the runtime buffer the whole response.
        redirect: "follow",
      })

      const responseHeaders = headersToObject(response.headers)
      const durationMs = Date.now() - started

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        dump(`${label}-error-${requestId}`, { status: response.status, text })

        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(responseHeaders["retry-after"])
          const error = new RateLimitError({
            provider: label,
            retryAfterMs,
            detail: text.slice(0, 2_000),
          })
          if (attempt < attempts) {
            const delay = retryAfterMs ?? backoff(attempt)
            log.warn("rate limited, retrying", { label, attempt, delay })
            await sleep(Math.min(delay, 60_000), options.signal)
            lastError = error
            continue
          }
          throw error
        }

        const retryable =
          RETRYABLE_STATUS.has(response.status) || (options.retryOn ?? []).includes(response.status)
        const error = new ProviderError({
          provider: label,
          status: response.status,
          detail: text.slice(0, 4_000),
          retryable,
        })
        if (retryable && attempt < attempts) {
          const delay = parseRetryAfter(responseHeaders["retry-after"]) ?? backoff(attempt)
          log.warn("retryable http error", { label, status: response.status, attempt, delay })
          await sleep(delay, options.signal)
          lastError = error
          continue
        }
        throw error
      }

      const contentType = responseHeaders["content-type"] ?? ""
      let parsed: unknown
      if (options.raw) {
        parsed = await response.arrayBuffer()
      } else if (contentType.includes("application/json") || contentType.includes("+json")) {
        const text = await response.text()
        parsed = text === "" ? undefined : safeJson(text)
      } else {
        parsed = await response.text()
      }

      dump(`${label}-response-${requestId}`, parsed)
      return {
        status: response.status,
        ok: true,
        headers: responseHeaders,
        body: parsed as T,
        requestId,
        durationMs,
      }
    } catch (err) {
      lastError = err
      if (options.signal?.aborted) throw new AbortedError({ reason: "caller aborted" })
      if (err instanceof TimeoutError || controller.signal.reason instanceof TimeoutError) {
        const timeout = new TimeoutError({ operation: label, timeoutMs })
        if (attempt >= attempts) throw timeout
        lastError = timeout
      } else if (!isRetryable(err) || attempt >= attempts) {
        throw err
      }
      const delay = backoff(attempt)
      log.warn("request failed, retrying", { label, attempt, delay, err })
      await sleep(delay, options.signal)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
    }
  }

  throw lastError ?? new ProviderError({ provider: label, detail: "request failed" })
}

function backoff(attempt: number): number {
  const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000)
  return Math.round(base * (0.7 + Math.random() * 0.6))
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await request<T>(url, { ...options, method: "GET" })
  return response.body
}

export async function postJson<T>(
  url: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const response = await request<T>(url, {
    ...options,
    method: "POST",
    body: body as Record<string, unknown>,
  })
  return response.body
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

export interface StreamOptions extends RequestOptions {
  /** Called once with response metadata before the first chunk. */
  readonly onResponse?: (info: { status: number; headers: Record<string, string> }) => void
}

/**
 * Opens a streaming request and yields raw text chunks. An idle timeout guards
 * against providers that accept a connection and then stall forever.
 */
export async function* streamText(
  url: string,
  options: StreamOptions = {},
): AsyncGenerator<string> {
  const target = buildUrl(url, options.query)
  const { body, headers } = prepareBody(options)
  const idleTimeoutMs = options.idleTimeoutMs ?? Limits.streamIdleTimeoutMs
  const label = options.label ?? new URL(target).host
  const attempts = (options.retries ?? 2) + 1

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", onAbort, { once: true })

    let response: Response
    try {
      response = await fetch(target, {
        method: options.method ?? "POST",
        headers,
        body: body as BodyInit | undefined,
        signal: controller.signal,
      })
    } catch (err) {
      options.signal?.removeEventListener("abort", onAbort)
      if (options.signal?.aborted) throw new AbortedError({ reason: "caller aborted" })
      if (isRetryable(err) && attempt < attempts) {
        await sleep(backoff(attempt), options.signal)
        continue
      }
      throw err
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      options.signal?.removeEventListener("abort", onAbort)
      dump(`${label}-stream-error`, { status: response.status, text })
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(headersToObject(response.headers)["retry-after"])
        if (attempt < attempts) {
          await sleep(Math.min(retryAfterMs ?? backoff(attempt), 60_000), options.signal)
          continue
        }
        throw new RateLimitError({ provider: label, retryAfterMs, detail: text.slice(0, 2_000) })
      }
      const retryable = RETRYABLE_STATUS.has(response.status)
      if (retryable && attempt < attempts) {
        await sleep(backoff(attempt), options.signal)
        continue
      }
      throw new ProviderError({
        provider: label,
        status: response.status,
        detail: text.slice(0, 4_000),
        retryable,
      })
    }

    options.onResponse?.({ status: response.status, headers: headersToObject(response.headers) })

    if (!response.body) {
      options.signal?.removeEventListener("abort", onAbort)
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let idleTimer: NodeJS.Timeout | undefined
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        controller.abort(new TimeoutError({ operation: `${label} stream`, timeoutMs: idleTimeoutMs }))
      }, idleTimeoutMs)
    }

    try {
      resetIdle()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        resetIdle()
        if (value) yield decoder.decode(value, { stream: true })
      }
      const tail = decoder.decode()
      if (tail) yield tail
      return
    } catch (err) {
      if (options.signal?.aborted) throw new AbortedError({ reason: "caller aborted" })
      if (controller.signal.reason instanceof TimeoutError) throw controller.signal.reason
      throw err
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      options.signal?.removeEventListener("abort", onAbort)
      reader.releaseLock()
    }
  }
}

export interface SseEvent {
  readonly event: string
  readonly data: string
  readonly id?: string
  readonly retry?: number
}

/**
 * Parses a Server-Sent Events stream. Correctly handles multi-line `data:`
 * fields, comments, `event:` names and CRLF line endings — all of which appear
 * in the wild across providers.
 */
export async function* streamSse(
  url: string,
  options: StreamOptions = {},
): AsyncGenerator<SseEvent> {
  const headers = {
    accept: "text/event-stream",
    ...(options.headers ?? {}),
  }
  let buffer = ""
  for await (const chunk of streamText(url, { ...options, headers })) {
    buffer += chunk
    for (;;) {
      const boundary = findEventBoundary(buffer)
      if (boundary < 0) break
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary).replace(/^(?:\r\n\r\n|\n\n|\r\r)/, "")
      const event = parseSseBlock(raw)
      if (event) yield event
    }
  }
  if (buffer.trim()) {
    const event = parseSseBlock(buffer)
    if (event) yield event
  }
}

function findEventBoundary(buffer: string): number {
  const candidates = [buffer.indexOf("\n\n"), buffer.indexOf("\r\n\r\n"), buffer.indexOf("\r\r")]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
  return candidates[0] ?? -1
}

function parseSseBlock(block: string): SseEvent | undefined {
  let event = "message"
  const dataLines: string[] = []
  let id: string | undefined
  let retry: number | undefined

  for (const rawLine of block.split(/\r\n|\n|\r/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue
    const colon = rawLine.indexOf(":")
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon)
    let value = colon < 0 ? "" : rawLine.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    switch (field) {
      case "event":
        event = value
        break
      case "data":
        dataLines.push(value)
        break
      case "id":
        id = value
        break
      case "retry": {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) retry = parsed
        break
      }
      default:
        break
    }
  }
  if (dataLines.length === 0 && event === "message") return undefined
  return { event, data: dataLines.join("\n"), id, retry }
}

/** Parses newline-delimited JSON, used by Ollama and some local servers. */
export async function* streamNdjson<T = unknown>(
  url: string,
  options: StreamOptions = {},
): AsyncGenerator<T> {
  let buffer = ""
  for await (const chunk of streamText(url, options)) {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === "") continue
      try {
        yield JSON.parse(line) as T
      } catch {
        log.debug("skipping malformed ndjson line", { line: line.slice(0, 200) })
      }
    }
  }
  const tail = buffer.trim()
  if (tail) {
    try {
      yield JSON.parse(tail) as T
    } catch {
      /* ignore trailing garbage */
    }
  }
}

/** Downloads a URL to disk with progress reporting. */
export async function download(
  url: string,
  target: string,
  options: RequestOptions & { readonly onProgress?: (received: number, total?: number) => void } = {},
): Promise<void> {
  const response = await fetch(buildUrl(url, options.query), {
    method: options.method ?? "GET",
    headers: { "user-agent": USER_AGENT, ...(options.headers ?? {}) },
    signal: options.signal,
  })
  if (!response.ok || !response.body) {
    throw new ProviderError({
      provider: new URL(url).host,
      status: response.status,
      detail: "download failed",
    })
  }
  const total = Number(response.headers.get("content-length") ?? "") || undefined
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  const handle = await fs.promises.open(target, "w")
  try {
    const reader = response.body.getReader()
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      await handle.write(value)
      received += value.byteLength
      options.onProgress?.(received, total)
    }
  } finally {
    await handle.close()
  }
}

/** True when the URL points at a loopback address (used to relax TLS checks). */
export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".localhost")
    )
  } catch {
    return false
  }
}

/** Redacts credentials from a URL for safe logging. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) parsed.username = "***"
    if (parsed.password) parsed.password = "***"
    for (const key of ["key", "api_key", "apikey", "token", "access_token"]) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "***")
    }
    return parsed.toString()
  } catch {
    return url
  }
}
