/**
 * Structured logging.
 *
 * The TUI owns the terminal, so logs never go to stdout while it is running.
 * Instead every record is written as newline-delimited JSON into a rotating
 * file under the state directory, and optionally mirrored to stderr in a
 * human-friendly format for `praxis run` / CI usage.
 */

import fs from "node:fs"
import path from "node:path"
import { Flag } from "../flag.js"
import { Paths, VERSION, ensureDirectories } from "../global.js"
import { describeError, serializeError } from "./error.js"

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent"

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
}

export type LogFields = Record<string, unknown>

export interface LogRecord {
  readonly time: string
  readonly level: Exclude<LogLevel, "silent">
  readonly service: string
  readonly message: string
  readonly fields?: LogFields
  readonly pid: number
}

export type LogSink = (record: LogRecord) => void

interface LoggerState {
  level: LogLevel
  format: "pretty" | "json"
  sinks: LogSink[]
  fileStream?: fs.WriteStream
  filePath?: string
  mirrorStderr: boolean
  redactKeys: Set<string>
}

const state: LoggerState = {
  level: "info",
  format: "pretty",
  sinks: [],
  mirrorStderr: false,
  redactKeys: new Set([
    "apiKey",
    "api_key",
    "authorization",
    "Authorization",
    "token",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "password",
    "secret",
    "clientSecret",
    "client_secret",
    "cookie",
    "Cookie",
    "set-cookie",
  ]),
}

function parseLevel(input: string | undefined, fallback: LogLevel): LogLevel {
  if (!input) return fallback
  const normalized = input.trim().toLowerCase()
  if (normalized in LEVEL_WEIGHT) return normalized as LogLevel
  if (normalized === "verbose") return "debug"
  if (normalized === "warning") return "warn"
  if (normalized === "off" || normalized === "none") return "silent"
  return fallback
}

export interface LogInitOptions {
  readonly level?: LogLevel | string
  readonly format?: "pretty" | "json"
  /** Write records to a rotating file under the state directory. */
  readonly file?: boolean
  /** Also mirror records to stderr (disabled while the TUI is active). */
  readonly stderr?: boolean
  /** Tag used in the log filename, e.g. `tui`, `run`, `serve`. */
  readonly tag?: string
}

let initialized = false

export function initLogging(options: LogInitOptions = {}): void {
  state.level = parseLevel(options.level as string | undefined, parseLevel(Flag.logLevel(), "info"))
  state.format =
    options.format ?? (Flag.logFormat() === "json" ? "json" : ("pretty" as "pretty" | "json"))
  state.mirrorStderr = options.stderr ?? false

  if (options.file !== false && state.level !== "silent") {
    try {
      ensureDirectories()
      const explicit = Flag.logFile()
      const target =
        explicit ??
        path.join(
          Paths.logDir,
          `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.tag ?? "praxis"}-${process.pid}.log`,
        )
      fs.mkdirSync(path.dirname(target), { recursive: true })
      state.filePath = target
      state.fileStream = fs.createWriteStream(target, { flags: "a" })
      state.fileStream.on("error", () => {
        state.fileStream = undefined
      })
      pruneOldLogs()
    } catch {
      state.fileStream = undefined
    }
  }

  initialized = true
  root.info("logging initialised", {
    version: VERSION,
    level: state.level,
    file: state.filePath,
  })
}

/** Keeps the 40 most recent log files, deleting anything older. */
function pruneOldLogs(keep = 40): void {
  try {
    const entries = fs
      .readdirSync(Paths.logDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, full: path.join(Paths.logDir, f) }))
      .map((e) => ({ ...e, mtime: fs.statSync(e.full).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const stale of entries.slice(keep)) {
      try {
        fs.unlinkSync(stale.full)
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* log dir may not exist yet */
  }
}

export function setLogLevel(level: LogLevel): void {
  state.level = level
}

export function logLevel(): LogLevel {
  return state.level
}

export function logFilePath(): string | undefined {
  return state.filePath
}

export function addLogSink(sink: LogSink): () => void {
  state.sinks.push(sink)
  return () => {
    const index = state.sinks.indexOf(sink)
    if (index >= 0) state.sinks.splice(index, 1)
  }
}

/** Silences stderr mirroring; the TUI calls this before taking over the screen. */
export function suspendStderr(): void {
  state.mirrorStderr = false
}

export function resumeStderr(): void {
  state.mirrorStderr = true
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]"
  if (value === null || value === undefined) return value
  if (value instanceof Error) return serializeError(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (state.redactKeys.has(k)) {
        out[k] = typeof v === "string" && v.length > 8 ? `***${v.slice(-4)}` : "***"
        continue
      }
      out[k] = redact(v, depth + 1)
    }
    return out
  }
  if (typeof value === "bigint") return String(value)
  return value
}

const LEVEL_COLOR: Record<Exclude<LogLevel, "silent">, string> = {
  trace: "\u001b[90m",
  debug: "\u001b[36m",
  info: "\u001b[32m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
}

function formatPretty(record: LogRecord): string {
  const color = process.stderr.isTTY && !Flag.noColor()
  const c = color ? LEVEL_COLOR[record.level] : ""
  const reset = color ? "\u001b[0m" : ""
  const dim = color ? "\u001b[90m" : ""
  const time = record.time.slice(11, 23)
  let line = `${dim}${time}${reset} ${c}${record.level.toUpperCase().padEnd(5)}${reset} ${dim}${record.service}${reset} ${record.message}`
  if (record.fields && Object.keys(record.fields).length) {
    const pairs = Object.entries(record.fields)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ")
    line += ` ${dim}${pairs}${reset}`
  }
  return line
}

function emit(record: LogRecord): void {
  if (state.fileStream) {
    try {
      state.fileStream.write(JSON.stringify(record) + "\n")
    } catch {
      /* ignore */
    }
  }
  if (state.mirrorStderr) {
    const text = state.format === "json" ? JSON.stringify(record) : formatPretty(record)
    try {
      process.stderr.write(text + "\n")
    } catch {
      /* ignore */
    }
  }
  for (const sink of state.sinks) {
    try {
      sink(record)
    } catch {
      /* a broken sink must not break the app */
    }
  }
}

export interface Logger {
  readonly service: string
  child(service: string, fields?: LogFields): Logger
  trace(message: string, fields?: LogFields): void
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fieldsOrError?: LogFields | unknown): void
  /** Starts a timer; call the returned function to log the elapsed duration. */
  time(message: string, fields?: LogFields): (extra?: LogFields) => void
  enabled(level: LogLevel): boolean
}

function createLogger(service: string, base: LogFields = {}): Logger {
  const write = (level: Exclude<LogLevel, "silent">, message: string, fields?: LogFields) => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[state.level]) return
    const merged = { ...base, ...(fields ?? {}) }
    emit({
      time: new Date().toISOString(),
      level,
      service,
      message,
      fields: Object.keys(merged).length
        ? (redact(merged) as LogFields)
        : undefined,
      pid: process.pid,
    })
  }

  return {
    service,
    child(childService, fields) {
      return createLogger(`${service}.${childService}`, { ...base, ...(fields ?? {}) })
    },
    trace: (m, f) => write("trace", m, f),
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => {
      if (f instanceof Error) {
        write("error", m, { error: describeError(f), detail: serializeError(f) })
        return
      }
      write("error", m, f as LogFields | undefined)
    },
    time(message, fields) {
      const start = performance.now()
      write("debug", `${message} \u2192 start`, fields)
      return (extra) => {
        const ms = Math.round((performance.now() - start) * 100) / 100
        write("debug", `${message} \u2192 done`, { ...fields, ...extra, ms })
      }
    },
    enabled(level) {
      return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[state.level]
    },
  }
}

export const root: Logger = createLogger("praxis")

export function logger(service: string, fields?: LogFields): Logger {
  if (!initialized) {
    // Cheap lazy init so library-style usage still records to disk.
    initialized = true
    state.level = parseLevel(Flag.logLevel(), "info")
  }
  return createLogger(service, fields)
}

export async function flushLogs(): Promise<void> {
  const stream = state.fileStream
  if (!stream) return
  await new Promise<void>((resolve) => {
    stream.end(() => resolve())
  })
  state.fileStream = undefined
}
