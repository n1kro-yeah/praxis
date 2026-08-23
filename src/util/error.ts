/**
 * Structured, named error hierarchy.
 *
 * Every failure mode in Praxis is represented by a named error class created
 * through {@link defineError}. Named errors carry a machine readable `name`, a
 * typed `data` payload, an optional `cause`, and a severity that the UI layer
 * uses to decide whether something is a user mistake, a transient failure, or a
 * genuine bug worth reporting.
 *
 * The design goals are:
 *  - errors survive JSON round-trips (worker RPC, HTTP API, log files)
 *  - errors can be matched without string sniffing (`MyError.is(err)`)
 *  - errors can be rendered for humans without leaking stack noise
 */

export type ErrorSeverity = "user" | "transient" | "internal"

export interface SerializedError {
  readonly name: string
  readonly message: string
  readonly severity: ErrorSeverity
  readonly data: Record<string, unknown>
  readonly stack?: string
  readonly cause?: SerializedError
  readonly retryable: boolean
}

const REGISTRY = new Map<string, NamedErrorConstructor<string, any>>()

export interface NamedErrorInstance<Name extends string, Data> extends Error {
  readonly name: Name
  readonly data: Data
  readonly severity: ErrorSeverity
  readonly retryable: boolean
  readonly praxisError: true
  toJSON(): SerializedError
}

export interface NamedErrorOptions {
  readonly cause?: unknown
  readonly severity?: ErrorSeverity
  readonly retryable?: boolean
  readonly message?: string
}

export interface NamedErrorConstructor<Name extends string, Data> {
  new (data: Data, options?: NamedErrorOptions): NamedErrorInstance<Name, Data>
  readonly errorName: Name
  is(input: unknown): input is NamedErrorInstance<Name, Data>
}

export interface DefineErrorConfig<Data> {
  /** Human readable message. Receives the typed payload. */
  readonly message?: (data: Data) => string
  readonly severity?: ErrorSeverity
  readonly retryable?: boolean
}

/**
 * Declares a new named error class.
 *
 * ```ts
 * const NotFound = defineError("FileNotFound", {
 *   message: (d: { path: string }) => `no such file: ${d.path}`,
 * })
 * throw new NotFound({ path: "/tmp/x" })
 * ```
 */
export function defineError<Name extends string, Data = Record<string, never>>(
  name: Name,
  config: DefineErrorConfig<Data> = {},
): NamedErrorConstructor<Name, Data> {
  const severityDefault = config.severity ?? "internal"
  const retryableDefault = config.retryable ?? false

  class Named extends Error implements NamedErrorInstance<Name, Data> {
    static readonly errorName = name
    override readonly name = name
    readonly data: Data
    readonly severity: ErrorSeverity
    readonly retryable: boolean
    readonly praxisError = true as const

    constructor(data: Data, options: NamedErrorOptions = {}) {
      const message =
        options.message ?? (config.message ? safeMessage(config.message, data) : name)
      super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
      this.data = data
      this.severity = options.severity ?? severityDefault
      this.retryable = options.retryable ?? retryableDefault
      Object.setPrototypeOf(this, new.target.prototype)
      if (Error.captureStackTrace) Error.captureStackTrace(this, new.target)
    }

    static is(input: unknown): input is NamedErrorInstance<Name, Data> {
      return isNamedError(input) && input.name === name
    }

    toJSON(): SerializedError {
      return serializeError(this)
    }
  }

  Object.defineProperty(Named, "name", { value: name })
  REGISTRY.set(name, Named as unknown as NamedErrorConstructor<string, any>)
  return Named as unknown as NamedErrorConstructor<Name, Data>
}

function safeMessage<Data>(fn: (data: Data) => string, data: Data): string {
  try {
    return fn(data)
  } catch {
    return "error message formatter threw"
  }
}

export function isNamedError(input: unknown): input is NamedErrorInstance<string, unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { praxisError?: unknown }).praxisError === true
  )
}

/** Recovers a registered error constructor by name (used when rehydrating RPC payloads). */
export function lookupError(name: string): NamedErrorConstructor<string, any> | undefined {
  return REGISTRY.get(name)
}

export function serializeError(input: unknown, depth = 0): SerializedError {
  if (depth > 8) {
    return {
      name: "ErrorChainTooDeep",
      message: "error cause chain truncated",
      severity: "internal",
      data: {},
      retryable: false,
    }
  }

  if (isNamedError(input)) {
    return {
      name: input.name,
      message: input.message,
      severity: input.severity,
      data: sanitize(input.data) as Record<string, unknown>,
      stack: input.stack,
      retryable: input.retryable,
      cause: input.cause !== undefined ? serializeError(input.cause, depth + 1) : undefined,
    }
  }

  if (input instanceof Error) {
    const anyErr = input as Error & { code?: string; errno?: number; syscall?: string }
    const data: Record<string, unknown> = {}
    if (anyErr.code !== undefined) data.code = anyErr.code
    if (anyErr.errno !== undefined) data.errno = anyErr.errno
    if (anyErr.syscall !== undefined) data.syscall = anyErr.syscall
    return {
      name: input.name || "Error",
      message: input.message,
      severity: "internal",
      data,
      stack: input.stack,
      retryable: false,
      cause: input.cause !== undefined ? serializeError(input.cause, depth + 1) : undefined,
    }
  }

  if (typeof input === "string") {
    return {
      name: "Error",
      message: input,
      severity: "internal",
      data: {},
      retryable: false,
    }
  }

  return {
    name: "Error",
    message: safeStringify(input),
    severity: "internal",
    data: {},
    retryable: false,
  }
}

export function deserializeError(input: SerializedError): Error {
  const ctor = REGISTRY.get(input.name)
  const cause = input.cause ? deserializeError(input.cause) : undefined
  if (ctor) {
    const err = new ctor(input.data as never, {
      cause,
      severity: input.severity,
      retryable: input.retryable,
      message: input.message,
    })
    if (input.stack) err.stack = input.stack
    return err
  }
  const err = new Error(input.message, cause ? { cause } : undefined)
  err.name = input.name
  if (input.stack) err.stack = input.stack
  return err
}

/** Strips functions/symbols and cycles so payloads can always be JSON encoded. */
function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === "string" || t === "number" || t === "boolean") return value
  if (t === "bigint") return String(value)
  if (t === "function" || t === "symbol") return undefined
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return serializeError(value)
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), sanitize(v, seen)]))
  }
  if (value instanceof Set) return [...value].map((v) => sanitize(v, seen))
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[circular]"
    seen.add(value as object)
    if (Array.isArray(value)) return value.map((v) => sanitize(v, seen))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = sanitize(v, seen)
      if (s !== undefined) out[k] = s
    }
    return out
  }
  return String(value)
}

export function safeStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(sanitize(value), null, space) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Flattens an error chain into `a: b: c` form for single-line display. */
export function describeError(input: unknown): string {
  const parts: string[] = []
  let current: unknown = input
  let guard = 0
  while (current !== undefined && current !== null && guard++ < 8) {
    if (current instanceof Error) {
      parts.push(current.message || current.name)
      current = current.cause
      continue
    }
    parts.push(typeof current === "string" ? current : safeStringify(current))
    break
  }
  const deduped: string[] = []
  for (const part of parts) {
    if (deduped[deduped.length - 1] === part) continue
    deduped.push(part)
  }
  return deduped.join(": ")
}

export function errorSeverity(input: unknown): ErrorSeverity {
  return isNamedError(input) ? input.severity : "internal"
}

export function isRetryable(input: unknown): boolean {
  if (isNamedError(input)) return input.retryable
  const code = (input as { code?: string } | undefined)?.code
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  )
}

/* ------------------------------------------------------------------ */
/* Shared error vocabulary                                             */
/* ------------------------------------------------------------------ */

export const AbortedError = defineError<"Aborted", { reason?: string }>("Aborted", {
  message: (d) => d.reason ?? "operation aborted",
  severity: "user",
})

export const TimeoutError = defineError<"Timeout", { ms: number; label?: string }>("Timeout", {
  message: (d) => `${d.label ?? "operation"} timed out after ${d.ms}ms`,
  severity: "transient",
  retryable: true,
})

export const ValidationError = defineError<
  "Validation",
  { issues: Array<{ path: string; message: string }>; source?: string }
>("Validation", {
  message: (d) => {
    const head = d.source ? `${d.source}: ` : ""
    const first = d.issues[0]
    const rest = d.issues.length > 1 ? ` (+${d.issues.length - 1} more)` : ""
    if (!first) return `${head}validation failed`
    return `${head}${first.path ? first.path + " " : ""}${first.message}${rest}`
  },
  severity: "user",
})

export const NotFoundError = defineError<"NotFound", { kind: string; id: string }>("NotFound", {
  message: (d) => `${d.kind} not found: ${d.id}`,
  severity: "user",
})

export const ConflictError = defineError<"Conflict", { kind: string; id: string; detail?: string }>(
  "Conflict",
  {
    message: (d) => `${d.kind} conflict for ${d.id}${d.detail ? ": " + d.detail : ""}`,
    severity: "user",
  },
)

export const UnsupportedError = defineError<"Unsupported", { feature: string; detail?: string }>(
  "Unsupported",
  {
    message: (d) => `unsupported: ${d.feature}${d.detail ? " (" + d.detail + ")" : ""}`,
    severity: "user",
  },
)

export const ConfigError = defineError<"Config", { path?: string; detail: string }>("Config", {
  message: (d) => (d.path ? `${d.path}: ${d.detail}` : d.detail),
  severity: "user",
})

export const PermissionDeniedError = defineError<
  "PermissionDenied",
  { action: string; resource: string; rule?: string }
>("PermissionDenied", {
  message: (d) => `permission denied: ${d.action} ${d.resource}`,
  severity: "user",
})

export const AuthError = defineError<"Auth", { provider: string; detail: string }>("Auth", {
  message: (d) => `authentication failed for ${d.provider}: ${d.detail}`,
  severity: "user",
})

export const RateLimitError = defineError<
  "RateLimit",
  { provider: string; retryAfterMs?: number; detail?: string }
>("RateLimit", {
  message: (d) =>
    `${d.provider} rate limited${d.retryAfterMs ? ` (retry in ${Math.ceil(d.retryAfterMs / 1000)}s)` : ""}`,
  severity: "transient",
  retryable: true,
})

export const ProviderError = defineError<
  "Provider",
  {
    provider: string
    model?: string
    status?: number
    code?: string
    detail: string
    body?: string
  }
>("Provider", {
  message: (d) => `${d.provider}${d.model ? "/" + d.model : ""}: ${d.detail}`,
  severity: "transient",
})

export const ToolError = defineError<"Tool", { tool: string; detail: string }>("Tool", {
  message: (d) => `${d.tool}: ${d.detail}`,
  severity: "user",
})

export const ContextOverflowError = defineError<
  "ContextOverflow",
  { tokens: number; limit: number }
>("ContextOverflow", {
  message: (d) => `context window exceeded (${d.tokens} > ${d.limit} tokens)`,
  severity: "transient",
})

export const BusyError = defineError<"Busy", { what: string }>("Busy", {
  message: (d) => `${d.what} is busy`,
  severity: "user",
})

/** Throws if the value is nullish; narrows the type otherwise. */
export function assertPresent<T>(value: T | null | undefined, kind: string, id = ""): T {
  if (value === null || value === undefined) throw new NotFoundError({ kind, id })
  return value
}

export function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new ValidationError({ issues: [{ path: "", message: detail }] })
}

/** `never`-exhaustiveness helper for switch statements. */
export function unreachable(value: never, context = "switch"): never {
  throw new Error(`${context}: unhandled variant ${safeStringify(value)}`)
}
