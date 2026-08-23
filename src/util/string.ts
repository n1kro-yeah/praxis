/**
 * String utilities.
 *
 * Text manipulation the agent loop depends on: truncation that preserves the
 * head *and* tail of tool output, indentation analysis for the edit engine,
 * line-number gutters for `read`, and template interpolation for commands.
 */

import { stringWidth, truncateToWidth } from "./wcwidth.js"

export function isBlank(input: string): boolean {
  return input.trim().length === 0
}

export function dedent(input: string): string {
  const lines = input.split("\n")
  let minIndent = Infinity
  for (const line of lines) {
    if (line.trim() === "") continue
    const match = /^[ \t]*/.exec(line)
    minIndent = Math.min(minIndent, (match?.[0] ?? "").length)
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return input
  return lines.map((line) => (line.trim() === "" ? line : line.slice(minIndent))).join("\n")
}

export function indent(input: string, prefix: string): string {
  return input
    .split("\n")
    .map((line) => (line === "" ? line : prefix + line))
    .join("\n")
}

/** Leading whitespace of a line. */
export function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ""
}

export interface IndentInfo {
  readonly kind: "space" | "tab" | "mixed" | "unknown"
  readonly size: number
}

/** Infers a file's indentation style so generated edits match it. */
export function detectIndentation(text: string): IndentInfo {
  const lines = text.split("\n").slice(0, 5_000)
  let tabs = 0
  let spaces = 0
  const histogram = new Map<number, number>()
  let previousIndent = 0

  for (const line of lines) {
    if (line.trim() === "") continue
    const indentText = leadingWhitespace(line)
    if (indentText.includes("\t")) tabs++
    if (indentText.includes(" ")) spaces++
    const width = indentText.replace(/\t/g, "    ").length
    const delta = width - previousIndent
    if (delta > 0 && delta <= 8) histogram.set(delta, (histogram.get(delta) ?? 0) + 1)
    previousIndent = width
  }

  if (tabs === 0 && spaces === 0) return { kind: "unknown", size: 2 }
  if (tabs > 0 && spaces > 0) {
    const size = pickMode(histogram) ?? 4
    return { kind: tabs > spaces * 2 ? "tab" : "mixed", size }
  }
  if (tabs > 0) return { kind: "tab", size: 4 }
  return { kind: "space", size: pickMode(histogram) ?? 2 }
}

function pickMode(histogram: Map<number, number>): number | undefined {
  let best: number | undefined
  let bestCount = 0
  for (const [size, count] of histogram) {
    if (count > bestCount) {
      bestCount = count
      best = size
    }
  }
  return best
}

export type LineEnding = "lf" | "crlf"

export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? "crlf" : "lf"
}

export function normalizeLineEndings(text: string, ending: LineEnding = "lf"): string {
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  return ending === "crlf" ? lf.replace(/\n/g, "\r\n") : lf
}

/**
 * Truncates long output while keeping both ends, which is what a model needs to
 * understand a build failure (the command at the top, the error at the bottom).
 */
export function truncateMiddle(
  input: string,
  maxChars: number,
  marker = "\n\n[... {n} characters elided ...]\n\n",
): string {
  if (input.length <= maxChars) return input
  const note = marker.replace("{n}", String(input.length - maxChars))
  const budget = Math.max(0, maxChars - note.length)
  const head = Math.ceil(budget * 0.6)
  const tail = budget - head
  return input.slice(0, head) + note + input.slice(input.length - tail)
}

export interface TruncateLinesResult {
  readonly text: string
  readonly truncated: boolean
  readonly totalLines: number
  readonly shownLines: number
}

/** Line-aware truncation with a head/tail split. */
export function truncateLines(
  input: string,
  maxLines: number,
  maxChars = Infinity,
): TruncateLinesResult {
  const lines = input.split("\n")
  if (lines.length <= maxLines && input.length <= maxChars) {
    return { text: input, truncated: false, totalLines: lines.length, shownLines: lines.length }
  }
  const head = Math.ceil(maxLines * 0.7)
  const tail = Math.max(0, maxLines - head)
  const kept = [
    ...lines.slice(0, head),
    `[... ${lines.length - head - tail} lines elided ...]`,
    ...(tail ? lines.slice(lines.length - tail) : []),
  ]
  let text = kept.join("\n")
  if (text.length > maxChars) text = truncateMiddle(text, maxChars)
  return {
    text,
    truncated: true,
    totalLines: lines.length,
    shownLines: head + tail,
  }
}

/** `cat -n` style gutter, used by the read tool so edits can cite line numbers. */
export function withLineNumbers(
  text: string,
  startLine = 1,
  options: { readonly width?: number; readonly separator?: string; readonly maxLineWidth?: number } = {},
): string {
  const lines = text.split("\n")
  const separator = options.separator ?? "\u2192"
  const width = options.width ?? String(startLine + lines.length - 1).length
  const maxLineWidth = options.maxLineWidth ?? Infinity
  return lines
    .map((line, index) => {
      const number = String(startLine + index).padStart(width, " ")
      const body = line.length > maxLineWidth ? line.slice(0, maxLineWidth) + "\u2026" : line
      return `${number}${separator}${body}`
    })
    .join("\n")
}

/** Removes a `withLineNumbers` gutter; tolerant of ragged model output. */
export function stripLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+(?:\u2192|\t|\s*\|\s?|:\s?)/, ""))
    .join("\n")
}

/** Extracts a window of lines, 1-indexed and inclusive. */
export function sliceLines(text: string, start: number, end: number): string {
  return text
    .split("\n")
    .slice(Math.max(0, start - 1), end)
    .join("\n")
}

export function countLines(text: string): number {
  if (text === "") return 0
  let count = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++
  return count
}

/** Byte offset of the start of a 1-indexed line. */
export function lineOffset(text: string, line: number): number {
  if (line <= 1) return 0
  let seen = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    seen++
    if (seen === line) return i + 1
  }
  return text.length
}

/** 1-indexed line/column of a character offset. */
export function offsetToPosition(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lastNewline = -1
  for (let i = 0; i < Math.min(offset, text.length); i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lastNewline = i
    }
  }
  return { line, column: offset - lastNewline }
}

/* ------------------------------------------------------------------ */
/* Casing and identifiers                                             */
/* ------------------------------------------------------------------ */

export function splitWords(input: string): string[] {
  return (
    input
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_\-./]+/)
      .filter(Boolean) ?? []
  )
}

export function camelCase(input: string): string {
  const words = splitWords(input)
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]?.toUpperCase() + w.slice(1).toLowerCase()))
    .join("")
}

export function pascalCase(input: string): string {
  return splitWords(input)
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1).toLowerCase())
    .join("")
}

export function kebabCase(input: string): string {
  return splitWords(input)
    .map((w) => w.toLowerCase())
    .join("-")
}

export function snakeCase(input: string): string {
  return splitWords(input)
    .map((w) => w.toLowerCase())
    .join("_")
}

export function titleCase(input: string): string {
  return splitWords(input)
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join(" ")
}

/** Filesystem-safe slug. */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.slice(0, maxLength) || "untitled"
}

/* ------------------------------------------------------------------ */
/* Templates                                                          */
/* ------------------------------------------------------------------ */

/**
 * Interpolates `{name}` and `$NAME` placeholders. Unknown placeholders are
 * left untouched so shell snippets survive intact.
 */
export function interpolate(
  template: string,
  values: Record<string, string | number | undefined>,
): string {
  return template
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
      const value = values[key]
      return value === undefined ? match : String(value)
    })
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, key: string) => {
      const value = values[key]
      return value === undefined ? match : String(value)
    })
}

/** Splits `$ARGUMENTS`-style command templates into positional slots. */
export function applyCommandTemplate(template: string, args: string): string {
  const words = args.trim() === "" ? [] : args.trim().split(/\s+/)
  let out = template.replace(/\$ARGUMENTS\b/g, args.trim())
  out = out.replace(/\$(\d)\b/g, (_match, digit: string) => words[Number(digit) - 1] ?? "")
  return out
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes)) return "?"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB", "PB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(decimals)} ${units[unitIndex]}`
}

export function formatNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 10_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString("en-US")
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Common prefix of a list of strings; used by autocomplete. */
export function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return ""
  let prefix = values[0] as string
  for (const value of values.slice(1)) {
    let i = 0
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++
    prefix = prefix.slice(0, i)
    if (prefix === "") break
  }
  return prefix
}

/** Escapes a string for safe inclusion in a regular expression. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Wraps text at a column boundary, respecting existing newlines. */
export function wrapText(input: string, width: number, indentText = ""): string[] {
  const out: string[] = []
  for (const paragraph of input.split("\n")) {
    if (stringWidth(paragraph) <= width) {
      out.push(paragraph)
      continue
    }
    let current = ""
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current === "" ? word : `${current} ${word}`
      if (stringWidth(candidate) > width && current !== "") {
        out.push(current)
        current = indentText + word
        continue
      }
      if (stringWidth(candidate) > width) {
        // Single word longer than the line.
        let rest = candidate
        while (stringWidth(rest) > width) {
          const head = truncateToWidth(rest, width, "")
          out.push(head)
          rest = rest.slice(head.length)
        }
        current = rest
        continue
      }
      current = candidate
    }
    if (current !== "") out.push(current)
  }
  return out
}

/** Heuristic binary sniffing: NUL bytes or a high ratio of control characters. */
export function looksBinary(buffer: Buffer | Uint8Array): boolean {
  const limit = Math.min(buffer.length, 8_000)
  if (limit === 0) return false
  let suspicious = 0
  for (let i = 0; i < limit; i++) {
    const byte = buffer[i] as number
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++
  }
  return suspicious / limit > 0.3
}

/** Ensures a trailing newline, matching POSIX text-file convention. */
export function ensureTrailingNewline(text: string): string {
  if (text === "" || text.endsWith("\n")) return text
  return text + "\n"
}

/** Removes a UTF-8 BOM if present, returning it separately for round-tripping. */
export function splitBom(text: string): { bom: string; body: string } {
  if (text.charCodeAt(0) === 0xfeff) return { bom: "\ufeff", body: text.slice(1) }
  return { bom: "", body: text }
}

/** Compares strings the way a file browser should: numbers sort numerically. */
export function naturalCompare(a: string, b: string): number {
  const chunkPattern = /(\d+|\D+)/g
  const left = a.toLowerCase().match(chunkPattern) ?? []
  const right = b.toLowerCase().match(chunkPattern) ?? []
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const x = left[i] as string
    const y = right[i] as string
    const xNum = /^\d/.test(x)
    const yNum = /^\d/.test(y)
    if (xNum && yNum) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff
      continue
    }
    if (x !== y) return x < y ? -1 : 1
  }
  return left.length - right.length
}
