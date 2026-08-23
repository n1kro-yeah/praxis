/**
 * Small self-contained utilities: lazy values, results, time formatting,
 * semantic versions, rate limiting, MIME detection and table rendering.
 * Individually too small to deserve a module; collectively used everywhere.
 */

import { padToWidth, stringWidth } from "./wcwidth.js"

/* ------------------------------------------------------------------ */
/* Lazy values                                                         */
/* ------------------------------------------------------------------ */

export interface Lazy<T> {
  (): T
  readonly resolved: boolean
  reset(): void
}

/** Memoises a synchronous factory, with an explicit reset for config reloads. */
export function lazy<T>(factory: () => T): Lazy<T> {
  let value: T
  let resolved = false
  const get = (() => {
    if (!resolved) {
      value = factory()
      resolved = true
    }
    return value
  }) as Lazy<T>
  Object.defineProperty(get, "resolved", { get: () => resolved })
  ;(get as { reset: () => void }).reset = () => {
    resolved = false
    value = undefined as T
  }
  return get
}

export interface AsyncLazy<T> {
  (): Promise<T>
  readonly resolved: boolean
  reset(): void
  peek(): T | undefined
}

/** Memoises an async factory; concurrent callers share one in-flight promise. */
export function asyncLazy<T>(factory: () => Promise<T>): AsyncLazy<T> {
  let promise: Promise<T> | undefined
  let value: T | undefined
  let resolved = false
  const get = (() => {
    if (!promise) {
      promise = factory().then(
        (result) => {
          value = result
          resolved = true
          return result
        },
        (error) => {
          promise = undefined
          throw error
        },
      )
    }
    return promise
  }) as AsyncLazy<T>
  Object.defineProperty(get, "resolved", { get: () => resolved })
  ;(get as { reset: () => void }).reset = () => {
    promise = undefined
    value = undefined
    resolved = false
  }
  ;(get as { peek: () => T | undefined }).peek = () => value
  return get
}

/* ------------------------------------------------------------------ */
/* Result type                                                         */
/* ------------------------------------------------------------------ */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

/** Wraps a throwing function into a Result. */
export function attempt<T>(fn: () => T): Result<T, unknown> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T, unknown>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback
}

/* ------------------------------------------------------------------ */
/* Time formatting                                                     */
/* ------------------------------------------------------------------ */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "\u2014"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) {
    const seconds = ms / 1_000
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  }
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1_000)
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.round((ms % 3_600_000) / 60_000)
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

export function formatRelativeTime(at: number, now = Date.now()): string {
  const delta = now - at
  if (delta < 0) return "in the future"
  if (delta < 45_000) return "just now"
  if (delta < 90_000) return "a minute ago"
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} minutes ago`
  if (delta < 7_200_000) return "an hour ago"
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} hours ago`
  if (delta < 172_800_000) return "yesterday"
  if (delta < 2_592_000_000) return `${Math.round(delta / 86_400_000)} days ago`
  if (delta < 5_184_000_000) return "last month"
  if (delta < 31_536_000_000) return `${Math.round(delta / 2_592_000_000)} months ago`
  return `${Math.round(delta / 31_536_000_000)} years ago`
}

export function formatClock(at: number): string {
  const date = new Date(at)
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}

export function formatDate(at: number): string {
  const date = new Date(at)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) return formatClock(at)
  const sameYear = date.getFullYear() === today.getFullYear()
  const month = date.toLocaleString("en-US", { month: "short" })
  return sameYear
    ? `${month} ${date.getDate()}`
    : `${month} ${date.getDate()}, ${date.getFullYear()}`
}

export function formatTimestamp(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19)
}

/** Groups timestamps into Today / Yesterday / This week / Older buckets. */
export function timeBucket(at: number, now = Date.now()): string {
  const date = new Date(at)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (at >= startOfToday) return "Today"
  if (at >= startOfToday - 86_400_000) return "Yesterday"
  if (at >= startOfToday - 7 * 86_400_000) return "This week"
  if (at >= startOfToday - 30 * 86_400_000) return "This month"
  return date.toLocaleString("en-US", { month: "long", year: "numeric" })
}

/** Parses human durations like `30s`, `5m`, `2h30m`, `1d`. */
export function parseDuration(input: string): number | undefined {
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g
  let total = 0
  let matched = false
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input.toLowerCase())) !== null) {
    matched = true
    const value = Number(match[1])
    switch (match[2]) {
      case "ms":
        total += value
        break
      case "s":
        total += value * 1_000
        break
      case "m":
        total += value * 60_000
        break
      case "h":
        total += value * 3_600_000
        break
      case "d":
        total += value * 86_400_000
        break
      case "w":
        total += value * 604_800_000
        break
      default:
        break
    }
  }
  if (matched) return total
  const plain = Number(input)
  return Number.isFinite(plain) ? plain : undefined
}

/* ------------------------------------------------------------------ */
/* Semantic versions                                                   */
/* ------------------------------------------------------------------ */

export interface SemVer {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: string[]
  readonly build?: string
}

export function parseSemver(input: string): SemVer | undefined {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(input.trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? (match[4] as string).split(".") : [],
    build: match[5],
  }
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return a.localeCompare(b)
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < length; i++) {
    const x = left.prerelease[i]
    const y = right.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const diff = Number(x) - Number(y)
      if (diff) return diff
      continue
    }
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function satisfiesMinimum(version: string, minimum: string): boolean {
  return compareSemver(version, minimum) >= 0
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * Token bucket. Providers publish requests-per-minute and tokens-per-minute
 * limits; we shape traffic locally to avoid burning retries on 429s.
 */
export class TokenBucket {
  private tokens: number
  private lastRefill = Date.now()

  constructor(
    readonly capacity: number,
    /** Tokens added per second. */
    readonly refillRate: number,
  ) {
    this.tokens = capacity
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1_000
    if (elapsed <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate)
    this.lastRefill = now
  }

  tryTake(count = 1): boolean {
    this.refill()
    if (this.tokens < count) return false
    this.tokens -= count
    return true
  }

  /** Milliseconds until `count` tokens become available. */
  delayFor(count = 1): number {
    this.refill()
    if (this.tokens >= count) return 0
    return Math.ceil(((count - this.tokens) / this.refillRate) * 1_000)
  }

  async take(count = 1, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (this.tryTake(count)) return
      const delay = Math.max(10, this.delayFor(count))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay)
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            reject(new Error("aborted"))
          },
          { once: true },
        )
      })
    }
  }

  get available(): number {
    this.refill()
    return Math.floor(this.tokens)
  }
}

/** Sliding-window counter, used for per-session tool-call budgets. */
export class SlidingWindow {
  private readonly events: number[] = []

  constructor(
    readonly windowMs: number,
    readonly limit: number,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    while (this.events.length && (this.events[0] as number) < cutoff) this.events.shift()
  }

  tryAdd(now = Date.now()): boolean {
    this.prune(now)
    if (this.events.length >= this.limit) return false
    this.events.push(now)
    return true
  }

  count(now = Date.now()): number {
    this.prune(now)
    return this.events.length
  }
}

/* ------------------------------------------------------------------ */
/* MIME types                                                          */
/* ------------------------------------------------------------------ */

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonc: "application/json",
  json5: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/x-scss",
  sass: "text/x-sass",
  less: "text/x-less",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/jsx",
  ts: "text/typescript",
  tsx: "text/tsx",
  mts: "text/typescript",
  cts: "text/typescript",
  py: "text/x-python",
  pyi: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  kt: "text/x-kotlin",
  kts: "text/x-kotlin",
  swift: "text/x-swift",
  c: "text/x-c",
  h: "text/x-c",
  cc: "text/x-c++",
  cpp: "text/x-c++",
  cxx: "text/x-c++",
  hpp: "text/x-c++",
  cs: "text/x-csharp",
  php: "text/x-php",
  pl: "text/x-perl",
  lua: "text/x-lua",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  fish: "text/x-shellscript",
  ps1: "text/x-powershell",
  sql: "text/x-sql",
  graphql: "application/graphql",
  gql: "application/graphql",
  proto: "text/x-protobuf",
  dockerfile: "text/x-dockerfile",
  makefile: "text/x-makefile",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  heic: "image/heic",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
}

export function mimeType(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const lower = base.toLowerCase()
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "text/x-dockerfile"
  if (lower === "makefile" || lower === "gnumakefile") return "text/x-makefile"
  if (lower.startsWith(".env")) return "text/plain"
  const extension = lower.includes(".") ? (lower.split(".").pop() as string) : ""
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream"
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/")
}

export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/yaml" ||
    mime === "application/toml" ||
    mime === "application/graphql"
  )
}

/** Sniffs an image format from its magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif"
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp"
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp"
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/avif"
  return undefined
}

/* ------------------------------------------------------------------ */
/* Table rendering                                                     */
/* ------------------------------------------------------------------ */

export interface TableColumn {
  readonly header: string
  readonly align?: "left" | "right" | "center"
  readonly maxWidth?: number
  readonly minWidth?: number
}

export interface TableOptions {
  readonly columns: readonly TableColumn[]
  readonly rows: readonly (readonly string[])[]
  readonly maxTotalWidth?: number
  readonly border?: "none" | "ascii" | "rounded"
  readonly padding?: number
}

const BORDERS = {
  ascii: {
    tl: "+",
    tr: "+",
    bl: "+",
    br: "+",
    h: "-",
    v: "|",
    cross: "+",
    tDown: "+",
    tUp: "+",
    tRight: "+",
    tLeft: "+",
  },
  rounded: {
    tl: "\u256d",
    tr: "\u256e",
    bl: "\u2570",
    br: "\u256f",
    h: "\u2500",
    v: "\u2502",
    cross: "\u253c",
    tDown: "\u252c",
    tUp: "\u2534",
    tRight: "\u251c",
    tLeft: "\u2524",
  },
} as const

/** Renders an aligned text table, shrinking columns to fit the terminal. */
export function renderTable(options: TableOptions): string {
  const padding = options.padding ?? 1
  const columnCount = options.columns.length
  const widths: number[] = options.columns.map((column, index) => {
    let width = stringWidth(column.header)
    for (const row of options.rows) width = Math.max(width, stringWidth(row[index] ?? ""))
    if (column.maxWidth) width = Math.min(width, column.maxWidth)
    if (column.minWidth) width = Math.max(width, column.minWidth)
    return width
  })

  const border = options.border ?? "none"
  const chrome =
    border === "none"
      ? (columnCount - 1) * padding * 2
      : columnCount * (padding * 2 + 1) + 1
  const maxTotal = options.maxTotalWidth ?? Infinity
  let total = widths.reduce((a, b) => a + b, 0) + chrome
  let guard = 0
  while (total > maxTotal && guard++ < 500) {
    const widest = widths.indexOf(Math.max(...widths))
    if ((widths[widest] as number) <= 4) break
    widths[widest] = (widths[widest] as number) - 1
    total--
  }

  const pad = " ".repeat(padding)
  const lines: string[] = []
  const chars = BORDERS[border === "ascii" ? "ascii" : "rounded"]

  const renderRow = (cells: readonly string[]): string => {
    const rendered = cells.map((cell, index) =>
      padToWidth(cell ?? "", widths[index] as number, options.columns[index]?.align ?? "left"),
    )
    if (border === "none") return rendered.join(pad + pad).trimEnd()
    return chars.v + rendered.map((c) => pad + c + pad).join(chars.v) + chars.v
  }

  const renderDivider = (kind: "top" | "middle" | "bottom"): string | undefined => {
    if (border === "none") {
      return kind === "middle"
        ? widths.map((w) => "\u2500".repeat(w)).join(pad + pad)
        : undefined
    }
    const left = kind === "top" ? chars.tl : kind === "bottom" ? chars.bl : chars.tRight
    const right = kind === "top" ? chars.tr : kind === "bottom" ? chars.br : chars.tLeft
    const joint = kind === "top" ? chars.tDown : kind === "bottom" ? chars.tUp : chars.cross
    return left + widths.map((w) => chars.h.repeat(w + padding * 2)).join(joint) + right
  }

  const top = renderDivider("top")
  if (top) lines.push(top)
  lines.push(renderRow(options.columns.map((c) => c.header)))
  const middle = renderDivider("middle")
  if (middle) lines.push(middle)
  for (const row of options.rows) lines.push(renderRow(row))
  const bottom = renderDivider("bottom")
  if (bottom) lines.push(bottom)

  return lines.join("\n")
}

/** Renders a horizontal bar for progress and usage displays. */
export function renderBar(fraction: number, width: number, filled = "\u2588", empty = "\u2591"): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  const count = Math.round(clamped * width)
  return filled.repeat(count) + empty.repeat(Math.max(0, width - count))
}

/** Unicode sparkline from a numeric series; used in the stats view. */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return ""
  const glyphs = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588"
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  return values
    .map((value) => {
      const index = Math.min(glyphs.length - 1, Math.floor(((value - min) / range) * glyphs.length))
      return glyphs[index]
    })
    .join("")
}

/** Spinner frames, indexed by elapsed time. */
export const SPINNER_FRAMES = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
] as const

export function spinnerFrame(at = Date.now(), intervalMs = 80): string {
  return SPINNER_FRAMES[Math.floor(at / intervalMs) % SPINNER_FRAMES.length] as string
}

/* ------------------------------------------------------------------ */
/* Collections                                                         */
/* ------------------------------------------------------------------ */

export function groupBy<T, K extends string | number>(
  items: readonly T[],
  key: (item: T) => K,
): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const group = key(item)
    const existing = out.get(group)
    if (existing) existing.push(item)
    else out.set(group, [item])
  }
  return out
}

export function unique<T>(items: readonly T[], key?: (item: T) => unknown): T[] {
  if (!key) return [...new Set(items)]
  const seen = new Set<unknown>()
  const out: T[] = []
  for (const item of items) {
    const id = key(item)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(item)
  }
  return out
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function partition<T>(items: readonly T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = []
  const no: T[] = []
  for (const item of items) (predicate(item) ? yes : no).push(item)
  return [yes, no]
}

/** Deep merge where arrays are replaced, not concatenated. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base
  if (override === null) return null as T
  if (Array.isArray(override)) return override as unknown as T
  if (typeof override !== "object") return override as T
  if (typeof base !== "object" || base === null || Array.isArray(base)) return override as T

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === undefined) continue
    out[key] = deepMerge((base as Record<string, unknown>)[key], value)
  }
  return out as T
}

/** Deep merge where arrays are concatenated and de-duplicated. */
export function deepMergeConcat<T>(base: T, override: unknown): T {
  if (override === undefined) return base
  if (Array.isArray(override) && Array.isArray(base)) {
    return unique([...(base as unknown[]), ...override]) as unknown as T
  }
  if (
    override !== null &&
    typeof override === "object" &&
    !Array.isArray(override) &&
    typeof base === "object" &&
    base !== null &&
    !Array.isArray(base)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      if (value === undefined) continue
      out[key] = deepMergeConcat((base as Record<string, unknown>)[key], value)
    }
    return out as T
  }
  return deepMerge(base, override)
}

export function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const key of keys) if (key in source) out[key] = source[key]
  return out
}

export function omit<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Omit<T, K> {
  const out = { ...source } as Record<string, unknown>
  for (const key of keys) delete out[key as string]
  return out as Omit<T, K>
}

export function clampNumber(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Stable multi-key sort. */
export function sortBy<T>(
  items: readonly T[],
  ...selectors: Array<(item: T) => string | number | boolean | undefined>
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      for (const selector of selectors) {
        const left = selector(a.item)
        const right = selector(b.item)
        if (left === right) continue
        if (left === undefined) return 1
        if (right === undefined) return -1
        if (typeof left === "number" && typeof right === "number") return left - right
        if (typeof left === "boolean" && typeof right === "boolean") {
          return left === right ? 0 : left ? -1 : 1
        }
        return String(left).localeCompare(String(right))
      }
      return a.index - b.index
    })
    .map((entry) => entry.item)
}

/** Removes undefined values so objects serialise cleanly. */
export function compact<T extends object>(source: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    out[key] = value
  }
  return out as T
}

/** Returns the first defined value. */
export function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) if (value !== undefined) return value
  return undefined
}

/** Sums a numeric projection. */
export function sumBy<T>(items: readonly T[], selector: (item: T) => number): number {
  let total = 0
  for (const item of items) total += selector(item)
  return total
}

/** Splits an array by a predicate on adjacent elements. */
export function runs<T>(items: readonly T[], sameRun: (a: T, b: T) => boolean): T[][] {
  const out: T[][] = []
  let current: T[] = []
  for (const item of items) {
    const previous = current[current.length - 1]
    if (previous !== undefined && !sameRun(previous, item)) {
      out.push(current)
      current = []
    }
    current.push(item)
  }
  if (current.length) out.push(current)
  return out
}
