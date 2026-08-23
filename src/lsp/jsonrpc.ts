/**
 * JSON-RPC 2.0 over a child process's stdio, with LSP's framing.
 *
 * The Language Server Protocol uses HTTP-style headers followed by a JSON body:
 *
 *   Content-Length: 123\r\n
 *   \r\n
 *   {"jsonrpc":"2.0",...}
 *
 * Two details cause most bugs in naive implementations:
 *
 *  1. **Content-Length is in bytes, not characters.** A server sending a message
 *     containing any non-ASCII character (a symbol name with an accent, a
 *     diagnostic with a typographic quote) will desynchronise a reader that
 *     counts string length. Everything here operates on Buffers for exactly this
 *     reason.
 *  2. **Messages arrive split arbitrarily across chunks.** A single `data` event
 *     may contain half a header, three whole messages, or the tail of one and the
 *     start of another. The parser must be a resumable state machine, not a
 *     per-chunk parse.
 *
 * Beyond framing this module owns request/response correlation, cancellation
 * (`$/cancelRequest`), and the timeout policy. Language servers hang: `gopls`
 * indexing a large module, `rust-analyzer` running `cargo metadata`, `tsserver`
 * loading a project with a broken tsconfig. Every request therefore has a
 * deadline, and a timeout is reported rather than thrown, because a missing
 * diagnostic must never fail an edit.
 */

import type { ChildProcess } from "node:child_process"

import { logger } from "../util/log.js"
import { deferred, type Deferred } from "../util/async.js"

const log = logger("lsp.jsonrpc")

/* ------------------------------------------------------------------ */
/* Wire types                                                          */
/* ------------------------------------------------------------------ */

export type JsonRpcId = number | string

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId | null
  readonly result?: unknown
  readonly error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** Standard JSON-RPC and LSP error codes worth naming. */
export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  serverNotInitialized: -32002,
  unknownErrorCode: -32001,
  requestFailed: -32803,
  serverCancelled: -32802,
  contentModified: -32801,
  requestCancelled: -32800,
} as const

export class JsonRpcRemoteError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(error: JsonRpcError, method: string) {
    super(`${method} failed: ${error.message} (${error.code})`)
    this.name = "JsonRpcRemoteError"
    this.code = error.code
    this.data = error.data
  }
}

export class JsonRpcTimeoutError extends Error {
  readonly method: string

  constructor(method: string, timeoutMs: number) {
    super(`${method} did not respond within ${timeoutMs}ms`)
    this.name = "JsonRpcTimeoutError"
    this.method = method
  }
}

/* ------------------------------------------------------------------ */
/* Framing                                                             */
/* ------------------------------------------------------------------ */

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii")
const SEPARATOR_LENGTH = HEADER_SEPARATOR.length

/**
 * Incremental message framer.
 *
 * Accumulates bytes and emits complete messages. Buffer concatenation is done
 * once per chunk and the buffer is sliced forward rather than copied per message,
 * which keeps the cost linear even when a server dumps thousands of diagnostics
 * in a single burst.
 */
export class MessageFramer {
  private buffer = Buffer.alloc(0)
  private readonly onMessage: (message: JsonRpcMessage) => void
  private readonly onError: (error: Error) => void

  constructor(onMessage: (message: JsonRpcMessage) => void, onError: (error: Error) => void) {
    this.onMessage = onMessage
    this.onError = onError
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  private drain(): void {
    // Loop rather than recurse: a chunk can contain many messages, and a deep
    // recursion here would blow the stack on a busy server.
    for (;;) {
      const separator = this.buffer.indexOf(HEADER_SEPARATOR)
      if (separator === -1) {
        // Guard against a server that never sends a valid header. Without this a
        // misbehaving process can grow the buffer without bound.
        if (this.buffer.length > 1024 * 1024) {
          this.onError(new Error("No JSON-RPC header found in the first megabyte of output."))
          this.buffer = Buffer.alloc(0)
        }
        return
      }

      const headerText = this.buffer.subarray(0, separator).toString("ascii")
      const length = parseContentLength(headerText)

      if (length === undefined) {
        // Unparseable header: skip past it and resynchronise rather than giving
        // up on the connection. Servers occasionally emit stray output on stdout
        // before their first real message.
        this.onError(new Error(`Malformed JSON-RPC header: ${JSON.stringify(headerText.slice(0, 200))}`))
        this.buffer = this.buffer.subarray(separator + SEPARATOR_LENGTH)
        continue
      }

      const bodyStart = separator + SEPARATOR_LENGTH
      if (this.buffer.length < bodyStart + length) {
        // The body has not fully arrived yet.
        return
      }

      const body = this.buffer.subarray(bodyStart, bodyStart + length)
      this.buffer = this.buffer.subarray(bodyStart + length)

      let parsed: JsonRpcMessage
      try {
        parsed = JSON.parse(body.toString("utf8")) as JsonRpcMessage
      } catch (error) {
        this.onError(new Error(`Invalid JSON in a JSON-RPC message: ${(error as Error).message}`))
        continue
      }

      this.onMessage(parsed)
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }
}

function parseContentLength(headerText: string): number | undefined {
  for (const line of headerText.split("\r\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (name !== "content-length") continue
    const value = Number.parseInt(line.slice(colon + 1).trim(), 10)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/** Serialises a message with the LSP framing. */
export function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii")
  return Buffer.concat([header, body])
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown
export type NotificationHandler = (method: string, params: unknown) => void

export interface ConnectionOptions {
  /** Label used in logs. */
  readonly name: string
  /** Default request timeout. */
  readonly timeoutMs?: number
  /** Handles requests *from* the server, such as `workspace/configuration`. */
  readonly onRequest?: RequestHandler
  /** Handles notifications from the server, such as `textDocument/publishDiagnostics`. */
  readonly onNotification?: NotificationHandler
  /** Called when the transport fails irrecoverably. */
  readonly onClose?: (reason: string) => void
}

interface Pending {
  readonly method: string
  readonly deferred: Deferred<unknown>
  readonly timer: NodeJS.Timeout
  readonly startedAt: number
}

/**
 * A JSON-RPC connection over a child process.
 *
 * Owns the id counter, the pending-request table, and the lifecycle. Deliberately
 * transport-specific rather than abstract: LSP over stdio is the only transport
 * that matters here, and an abstraction layer would add indirection without
 * removing any real complexity.
 */
export class JsonRpcConnection {
  private readonly child: ChildProcess
  private readonly options: ConnectionOptions
  private readonly framer: MessageFramer
  private readonly pending = new Map<JsonRpcId, Pending>()
  private nextId = 1
  private closed = false
  private closeReason?: string
  /** Buffered stderr, surfaced when a server dies during start-up. */
  private readonly stderrLines: string[] = []

  constructor(child: ChildProcess, options: ConnectionOptions) {
    this.child = child
    this.options = options
    this.framer = new MessageFramer(
      (message) => this.handleMessage(message),
      (error) => log.warn(`${options.name}: ${error.message}`),
    )

    child.stdout?.on("data", (chunk: Buffer) => this.framer.push(chunk))

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue
        this.stderrLines.push(line)
        // Keep only a recent window; some servers are extremely chatty.
        if (this.stderrLines.length > 200) this.stderrLines.shift()
      }
      log.debug(`${options.name} stderr`, { text: text.slice(0, 500) })
    })

    child.on("exit", (code, signal) => {
      this.shutdown(
        `the ${options.name} language server exited${
          code === null ? ` on ${signal}` : ` with code ${code}`
        }`,
      )
    })

    child.on("error", (error) => {
      this.shutdown(`the ${options.name} language server failed: ${error.message}`)
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Recent stderr output, for diagnosing a server that will not start. */
  stderr(): string {
    return this.stderrLines.join("\n")
  }

  /**
   * Sends a request and waits for the response.
   *
   * On timeout the request is cancelled server-side via `$/cancelRequest` so the
   * server can stop the work, and the caller receives a `JsonRpcTimeoutError`.
   * Callers are expected to treat that as "no data available" rather than as a
   * failure, which is why it is a distinct error type.
   */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) {
      throw new Error(this.closeReason ?? `The ${this.options.name} connection is closed.`)
    }

    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 15_000
    const result = deferred<unknown>()

    const timer = setTimeout(() => {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      this.notify("$/cancelRequest", { id })
      entry.deferred.reject(new JsonRpcTimeoutError(method, timeoutMs))
    }, timeoutMs)
    if (typeof timer.unref === "function") timer.unref()

    this.pending.set(id, { method, deferred: result, timer, startedAt: Date.now() })

    const onAbort = (): void => {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      clearTimeout(entry.timer)
      this.notify("$/cancelRequest", { id })
      entry.deferred.reject(new Error(`${method} was cancelled.`))
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      this.write({ jsonrpc: "2.0", id, method, params })
    } catch (error) {
      this.pending.delete(id)
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      throw error
    }

    try {
      return (await result.promise) as T
    } finally {
      options.signal?.removeEventListener("abort", onAbort)
    }
  }

  /** Sends a notification. Fire and forget by definition. */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    try {
      this.write({ jsonrpc: "2.0", method, params })
    } catch (error) {
      log.debug(`${this.options.name}: failed to send ${method}`, { error: String(error) })
    }
  }

  private write(message: JsonRpcMessage): void {
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed) {
      throw new Error(`The ${this.options.name} language server's input stream is closed.`)
    }
    stdin.write(encodeMessage(message))
  }

  private handleMessage(message: JsonRpcMessage): void {
    // Response to one of our requests.
    if ("id" in message && message.id !== null && !("method" in message)) {
      const response = message as JsonRpcResponse
      const entry = this.pending.get(response.id!)
      if (!entry) {
        // A late response to a request we already timed out. Expected, not worth
        // a warning at info level.
        log.debug(`${this.options.name}: response for unknown id`, { id: response.id })
        return
      }
      this.pending.delete(response.id!)
      clearTimeout(entry.timer)

      if (response.error) {
        // `ContentModified` and `RequestCancelled` are normal in an editor-like
        // client: they mean the document changed while the server was working.
        if (
          response.error.code === ErrorCodes.contentModified ||
          response.error.code === ErrorCodes.requestCancelled
        ) {
          entry.deferred.resolve(undefined)
          return
        }
        entry.deferred.reject(new JsonRpcRemoteError(response.error, entry.method))
        return
      }

      entry.deferred.resolve(response.result)
      return
    }

    // Request from the server.
    if ("method" in message && "id" in message && message.id !== null && message.id !== undefined) {
      const requestMessage = message as JsonRpcRequest
      void this.handleServerRequest(requestMessage)
      return
    }

    // Notification from the server.
    if ("method" in message) {
      const notification = message as JsonRpcNotification
      try {
        this.options.onNotification?.(notification.method, notification.params)
      } catch (error) {
        log.warn(`${this.options.name}: notification handler failed`, {
          method: notification.method,
          error: String(error),
        })
      }
    }
  }

  /**
   * Answers a server-initiated request.
   *
   * Answering is not optional: a server that asks for `workspace/configuration`
   * and receives nothing will block, and several servers will not produce
   * diagnostics until the request is answered. Unhandled methods get a
   * `MethodNotFound` reply, which is the correct protocol behaviour and lets the
   * server proceed.
   */
  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    if (!this.options.onRequest) {
      this.reply(message.id, undefined, {
        code: ErrorCodes.methodNotFound,
        message: `${message.method} is not handled by this client.`,
      })
      return
    }

    try {
      const result = await this.options.onRequest(message.method, message.params)
      this.reply(message.id, result)
    } catch (error) {
      this.reply(message.id, undefined, {
        code: ErrorCodes.internalError,
        message: (error as Error).message,
      })
    }
  }

  private reply(id: JsonRpcId, result?: unknown, error?: JsonRpcError): void {
    if (this.closed) return
    try {
      this.write(
        error
          ? { jsonrpc: "2.0", id, error }
          : { jsonrpc: "2.0", id, result: result ?? null },
      )
    } catch {
      // The connection died while we were answering; nothing useful to do.
    }
  }

  /**
   * Fails every in-flight request and marks the connection dead.
   *
   * Rejecting rather than leaving promises pending is essential: a hung promise
   * inside a tool execution would hang the whole agent turn.
   */
  private shutdown(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason

    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.deferred.reject(new Error(reason))
      this.pending.delete(id)
    }

    this.framer.reset()
    this.options.onClose?.(reason)
    log.debug("connection closed", { name: this.options.name, reason })
  }

  /** Requests a graceful protocol shutdown, then kills the process. */
  async dispose(): Promise<void> {
    if (this.closed) return

    try {
      // `shutdown` then `exit` is the protocol-defined sequence; skipping it
      // leaves some servers with stale lock files and stray child processes.
      await this.request("shutdown", undefined, { timeoutMs: 2_000 })
      this.notify("exit")
    } catch {
      // A server that will not shut down cleanly gets killed below.
    }

    this.shutdown("the client closed the connection")

    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGKILL")
        } catch {
          // Already gone.
        }
        resolvePromise()
      }, 1_500)
      if (typeof timer.unref === "function") timer.unref()

      this.child.once("exit", () => {
        clearTimeout(timer)
        resolvePromise()
      })

      try {
        this.child.kill("SIGTERM")
      } catch {
        clearTimeout(timer)
        resolvePromise()
      }
    })
  }

  /** Diagnostics for the `doctor` command. */
  stats(): { pending: number; oldestMs: number } {
    let oldest = 0
    const now = Date.now()
    for (const entry of this.pending.values()) {
      oldest = Math.max(oldest, now - entry.startedAt)
    }
    return { pending: this.pending.size, oldestMs: oldest }
  }
}

/* ------------------------------------------------------------------ */
/* URI helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Converts a filesystem path to a `file://` URI.
 *
 * Hand-written rather than using `pathToFileURL` because language servers are
 * inconsistent about Windows drive-letter casing and about which characters they
 * expect percent-encoded, and matching their expectations exactly is what makes
 * diagnostics line up with the right file. In particular the colon after a drive
 * letter must not be encoded, and forward slashes must be preserved.
 */
export function pathToUri(path: string): string {
  let normalized = path.replace(/\\/g, "/")
  if (!normalized.startsWith("/")) normalized = `/${normalized}`

  const encoded = normalized
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment)
        .replace(/%3A/gi, ":")
        .replace(/%40/g, "@")
        .replace(/%2B/gi, "+")
        .replace(/%24/g, "$")
        .replace(/%2C/gi, ",")
        .replace(/%21/g, "!")
        .replace(/%27/g, "'")
        .replace(/%28/g, "(")
        .replace(/%29/g, ")")
        .replace(/%7E/gi, "~"),
    )
    .join("/")

  return `file://${encoded}`
}

/** Converts a `file://` URI back to a filesystem path. */
export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri
  let path = decodeURIComponent(uri.slice("file://".length))
  // Strip the leading slash from Windows paths such as /C:/Users/...
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return path
}

/* ------------------------------------------------------------------ */
/* Position conversion                                                 */
/* ------------------------------------------------------------------ */

export interface Position {
  /** Zero-based. */
  readonly line: number
  /** Zero-based, in UTF-16 code units by default. */
  readonly character: number
}

export interface Range {
  readonly start: Position
  readonly end: Position
}

/**
 * Converts a character offset in a string to an LSP position.
 *
 * LSP columns are UTF-16 code units, which is what JavaScript string indices
 * already are — a convenient coincidence that makes this simple, but only as long
 * as no one "helpfully" converts to code points.
 */
export function offsetToPosition(content: string, offset: number): Position {
  let line = 0
  let lastNewline = -1
  for (let index = 0; index < offset && index < content.length; index++) {
    if (content.charCodeAt(index) === 10) {
      line++
      lastNewline = index
    }
  }
  return { line, character: offset - lastNewline - 1 }
}

/** Converts an LSP position to a character offset. */
export function positionToOffset(content: string, position: Position): number {
  let offset = 0
  let line = 0
  while (line < position.line && offset < content.length) {
    const next = content.indexOf("\n", offset)
    if (next === -1) return content.length
    offset = next + 1
    line++
  }
  return Math.min(offset + position.character, content.length)
}

/** Human-readable `line:column`, one-based for display. */
export function formatPosition(position: Position): string {
  return `${position.line + 1}:${position.character + 1}`
}

/** Formats a range compactly, collapsing single-line ranges. */
export function formatRange(range: Range): string {
  if (range.start.line === range.end.line) {
    return range.start.character === range.end.character
      ? formatPosition(range.start)
      : `${range.start.line + 1}:${range.start.character + 1}-${range.end.character + 1}`
  }
  return `${formatPosition(range.start)}-${formatPosition(range.end)}`
}
