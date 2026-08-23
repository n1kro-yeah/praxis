/**
 * File reading.
 *
 * Reading a file for a language model is not the same as reading it for a
 * program. The model needs line numbers so it can refer to a location; it needs
 * the file to fit in the context window; it needs to be told when what it is
 * looking at is not the whole file. And it must never be handed binary data,
 * because a megabyte of decoded JPEG bytes is a megabyte of tokens spent on noise.
 *
 * So this module does five things the filesystem does not:
 *
 *  1. **Detects binary content** and refuses it with an explanation rather than
 *     returning mojibake.
 *  2. **Detects the encoding.** UTF-16 files are common on Windows and decode to
 *     interleaved nulls if read as UTF-8.
 *  3. **Numbers the lines**, because "change line 47" needs line 47 to be
 *     identifiable.
 *  4. **Truncates predictably** and says so, so the model knows there is more.
 *  5. **Normalises line endings** for display while remembering the original, so
 *     an edit does not silently convert a CRLF file to LF and produce a diff
 *     touching every line.
 */

import { openSync, readSync, closeSync, statSync, readFileSync } from "node:fs"
import { extname } from "node:path"

import { logger } from "../util/log.js"

const log = logger("file.reader")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Default line limit for a read. */
export const DEFAULT_LINE_LIMIT = 2_000

/** Characters per line before the line itself is truncated. */
export const MAX_LINE_LENGTH = 2_000

/** Bytes above which a file is refused outright. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/** Bytes sampled when sniffing for binary content. */
const SNIFF_BYTES = 8192

/**
 * Proportion of non-text bytes that marks a file as binary.
 *
 * Thirty per cent. A text file with a few control characters \u2014 a terminal capture
 * with escape sequences, say \u2014 is still worth reading. A file that is a third
 * unprintable is not text in any useful sense.
 */
const BINARY_RATIO = 0.3

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type LineEnding = "lf" | "crlf" | "cr" | "mixed"

export type Encoding = "utf8" | "utf16le" | "utf16be" | "latin1"

export interface FileInfo {
  readonly path: string
  readonly bytes: number
  readonly binary: boolean
  readonly encoding: Encoding
  readonly lineEnding: LineEnding
  /** Whether the file ends with a newline. */
  readonly trailingNewline: boolean
  readonly lines: number
  readonly mtimeMs: number
}

export interface ReadResult {
  readonly content: string
  readonly info: FileInfo
  /** Line numbers actually returned, one-based and inclusive. */
  readonly range: { start: number; end: number }
  readonly truncated: boolean
  /** Lines beyond the returned range. */
  readonly remaining: number
  /** Lines that were themselves cut short. */
  readonly truncatedLines: number[]
}

export interface ReadOptions {
  /** One-based first line. Defaults to 1. */
  readonly offset?: number
  /** Maximum lines to return. */
  readonly limit?: number
  /** Suppresses line numbers, for content being fed to a tool. */
  readonly raw?: boolean
  /** Overrides the per-line truncation width. */
  readonly maxLineLength?: number
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extensions known to be binary.
 *
 * Checked before sniffing, because sniffing costs a read and the extension is
 * right almost always. The sniff still runs for anything not on the list, since
 * plenty of binary files have no extension at all.
 */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif", ".tiff", ".heic",
  ".mp3", ".mp4", ".wav", ".flac", ".ogg", ".avi", ".mov", ".mkv", ".webm", ".m4a",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".lz4",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".lib", ".bin", ".dat",
  ".class", ".jar", ".war", ".pyc", ".pyo", ".wasm", ".node",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".db", ".sqlite", ".sqlite3", ".mdb",
  ".iso", ".dmg", ".img", ".pak", ".bundle",
])

/**
 * Extensions that look binary but are not.
 *
 * `.ts` is TypeScript far more often than it is an MPEG transport stream, and
 * refusing to read it would be a daily annoyance. Explicit exceptions beat a
 * cleverer heuristic here.
 */
const TEXT_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".rs", ".ps1", ".sh", ".bat"])

/**
 * Byte-order marks.
 *
 * Order matters: UTF-32 marks begin with the UTF-16 marks, so the longer ones
 * must be tested first.
 */
const BOMS: Array<{ bytes: number[]; encoding: Encoding; length: number }> = [
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: "utf16le", length: 4 },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: "utf16be", length: 4 },
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf8", length: 3 },
  { bytes: [0xff, 0xfe], encoding: "utf16le", length: 2 },
  { bytes: [0xfe, 0xff], encoding: "utf16be", length: 2 },
]

function detectBom(buffer: Buffer): { encoding: Encoding; length: number } | undefined {
  for (const bom of BOMS) {
    if (buffer.length < bom.length) continue

    let matches = true

    for (let index = 0; index < bom.bytes.length; index++) {
      if (buffer[index] !== bom.bytes[index]) {
        matches = false
        break
      }
    }

    if (matches) return { encoding: bom.encoding, length: bom.length }
  }

  return undefined
}

/**
 * Guesses whether a sample is binary.
 *
 * A null byte is conclusive for anything claiming to be UTF-8; no valid encoding
 * of text contains one. Beyond that, the proportion of bytes outside the printable
 * and common-whitespace ranges decides it.
 */
function sniffBinary(buffer: Buffer, encoding: Encoding): boolean {
  if (buffer.length === 0) return false

  // UTF-16 text is half nulls by construction, so the null-byte test does not
  // apply and the ratio test would reject every UTF-16 file.
  if (encoding === "utf16le" || encoding === "utf16be") return false

  let suspicious = 0

  for (const byte of buffer) {
    if (byte === 0) return true

    // Tab, newline, carriage return, form feed, escape.
    if (byte === 9 || byte === 10 || byte === 13 || byte === 12 || byte === 27) continue

    if (byte < 32 || byte === 127) suspicious++
  }

  return suspicious / buffer.length > BINARY_RATIO
}

/**
 * Detects line endings.
 *
 * Reported rather than normalised away, because writing a file back with
 * different endings than it had produces a diff where every line has changed, and
 * that is a genuinely destructive thing to do to someone's repository.
 */
function detectLineEnding(text: string): LineEnding {
  let crlf = 0
  let lf = 0
  let cr = 0

  for (let index = 0; index < text.length; index++) {
    const character = text[index]

    if (character === "\r") {
      if (text[index + 1] === "\n") {
        crlf++
        index++
      } else {
        cr++
      }

      continue
    }

    if (character === "\n") lf++
  }

  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length

  if (kinds > 1) return "mixed"
  if (crlf > 0) return "crlf"
  if (cr > 0) return "cr"

  return "lf"
}

/* ------------------------------------------------------------------ */
/* Inspection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Examines a file without reading all of it.
 *
 * The sniff reads at most eight kilobytes regardless of file size, so calling
 * this on a large file to find out whether it is worth reading costs almost
 * nothing.
 */
export function inspect(path: string): FileInfo {
  const stats = statSync(path)

  if (!stats.isFile()) {
    throw new Error(`${path} is not a file.`)
  }

  const extension = extname(path).toLowerCase()

  if (BINARY_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) {
    return {
      path,
      bytes: stats.size,
      binary: true,
      encoding: "utf8",
      lineEnding: "lf",
      trailingNewline: false,
      lines: 0,
      mtimeMs: stats.mtimeMs,
    }
  }

  const sample = readSample(path, SNIFF_BYTES)
  const bom = detectBom(sample)
  const encoding = bom?.encoding ?? "utf8"
  const binary = sniffBinary(bom ? sample.subarray(bom.length) : sample, encoding)

  if (binary) {
    return {
      path,
      bytes: stats.size,
      binary: true,
      encoding,
      lineEnding: "lf",
      trailingNewline: false,
      lines: 0,
      mtimeMs: stats.mtimeMs,
    }
  }

  // Line count needs the whole file, so it is only computed for files small
  // enough that reading them twice is acceptable.
  let lines = 0
  let trailingNewline = false
  let lineEnding: LineEnding = "lf"

  if (stats.size <= MAX_FILE_BYTES) {
    const text = decode(readFileSync(path), encoding, bom?.length ?? 0)

    lineEnding = detectLineEnding(text)
    trailingNewline = text.endsWith("\n")
    lines = countLines(text)
  }

  return {
    path,
    bytes: stats.size,
    binary: false,
    encoding,
    lineEnding,
    trailingNewline,
    lines,
    mtimeMs: stats.mtimeMs,
  }
}

function readSample(path: string, bytes: number): Buffer {
  const handle = openSync(path, "r")

  try {
    const buffer = Buffer.allocUnsafe(bytes)
    const read = readSync(handle, buffer, 0, bytes, 0)

    return buffer.subarray(0, read)
  } finally {
    closeSync(handle)
  }
}

/**
 * Decodes a buffer.
 *
 * UTF-16 big-endian has no direct support in Node, so the bytes are swapped and
 * decoded as little-endian. The alternative is a hand-written decoder, which is
 * more code and more ways to be wrong for a case that is already rare.
 */
function decode(buffer: Buffer, encoding: Encoding, skip: number): string {
  const body = skip > 0 ? buffer.subarray(skip) : buffer

  switch (encoding) {
    case "utf16le":
      return body.toString("utf16le")

    case "utf16be": {
      const swapped = Buffer.from(body)

      // swap16 requires an even length; an odd trailing byte is truncated
      // rather than throwing, since a malformed file should still be readable.
      if (swapped.length % 2 !== 0) {
        return swapped.subarray(0, swapped.length - 1).swap16().toString("utf16le")
      }

      return swapped.swap16().toString("utf16le")
    }

    case "latin1":
      return body.toString("latin1")

    case "utf8":
    default:
      return body.toString("utf8")
  }
}

function countLines(text: string): number {
  if (text === "") return 0

  let count = 1

  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") count++
  }

  // A trailing newline terminates the last line rather than starting a new one.
  return text.endsWith("\n") ? count - 1 : count
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export class BinaryFileError extends Error {
  constructor(readonly path: string) {
    super(
      `${path} contains binary data, so there is nothing useful to read. If you need to know about it, check its size and type instead.`,
    )

    this.name = "BinaryFileError"
  }
}

export class FileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
  ) {
    super(
      `${path} is ${(bytes / 1024 / 1024).toFixed(1)} MB, above the ${MAX_FILE_BYTES / 1024 / 1024} MB limit. Read a specific range of lines, or search it instead of reading it whole.`,
    )

    this.name = "FileTooLargeError"
  }
}

/**
 * Reads a file for presentation to a model.
 *
 * Line numbers are right-aligned in a fixed-width gutter followed by a tab. The
 * tab matters: it gives the model an unambiguous separator between the number and
 * the content, so a line that itself begins with digits is not misread.
 */
export function read(path: string, options: ReadOptions = {}): ReadResult {
  const info = inspect(path)

  if (info.binary) throw new BinaryFileError(path)
  if (info.bytes > MAX_FILE_BYTES) throw new FileTooLargeError(path, info.bytes)

  const bom = detectBom(readSample(path, 4))
  const text = decode(readFileSync(path), info.encoding, bom?.length ?? 0)

  // Split on any line ending, so a CRLF file does not come back with a stray
  // carriage return on every line.
  const all = text.split(/\r\n|\r|\n/)

  // A trailing newline produces a final empty element that is not a line.
  if (all.length > 0 && all[all.length - 1] === "" && text.length > 0) all.pop()

  const offset = Math.max(1, options.offset ?? 1)
  const limit = Math.max(1, options.limit ?? DEFAULT_LINE_LIMIT)
  const maxLineLength = options.maxLineLength ?? MAX_LINE_LENGTH

  const start = Math.min(offset, Math.max(1, all.length))
  const end = Math.min(all.length, start + limit - 1)

  const selected = all.slice(start - 1, end)
  const truncatedLines: number[] = []

  const width = String(end).length
  const rendered: string[] = []

  for (let index = 0; index < selected.length; index++) {
    const number = start + index
    let line = selected[index]!

    if (line.length > maxLineLength) {
      truncatedLines.push(number)
      line = `${line.slice(0, maxLineLength)}\u2026 [${line.length - maxLineLength} more characters]`
    }

    rendered.push(options.raw ? line : `${String(number).padStart(width, " ")}\t${line}`)
  }

  const remaining = Math.max(0, all.length - end)

  if (remaining > 0) {
    log.debug("file read was truncated", { path, returned: selected.length, remaining })
  }

  return {
    content: rendered.join("\n"),
    info,
    range: { start, end },
    truncated: remaining > 0 || truncatedLines.length > 0,
    remaining,
    truncatedLines,
  }
}

/**
 * Reads a file as-is.
 *
 * For the edit path, which needs the exact bytes rather than a presentation of
 * them. Line endings are preserved, the byte-order mark is stripped, and nothing
 * is truncated.
 */
export function readRaw(path: string): { content: string; info: FileInfo } {
  const info = inspect(path)

  if (info.binary) throw new BinaryFileError(path)
  if (info.bytes > MAX_FILE_BYTES) throw new FileTooLargeError(path, info.bytes)

  const bom = detectBom(readSample(path, 4))
  const content = decode(readFileSync(path), info.encoding, bom?.length ?? 0)

  return { content, info }
}

/**
 * A note appended after a truncated read.
 *
 * Explicit about what to do next. "Truncated" alone leads the model to either
 * ignore the rest of the file or read it again from the start; naming the offset
 * makes continuing obvious.
 */
export function truncationNotice(result: ReadResult): string | undefined {
  const notes: string[] = []

  if (result.remaining > 0) {
    notes.push(
      `Showing lines ${result.range.start} to ${result.range.end} of ${result.info.lines}. To continue, read again with offset ${result.range.end + 1}.`,
    )
  }

  if (result.truncatedLines.length > 0) {
    const sample = result.truncatedLines.slice(0, 5).join(", ")
    const more = result.truncatedLines.length > 5 ? ` and ${result.truncatedLines.length - 5} others` : ""

    notes.push(`Lines ${sample}${more} were longer than the display width and were cut short.`)
  }

  if (result.info.lineEnding === "crlf") {
    notes.push("This file uses CRLF line endings; they will be preserved when it is written.")
  }

  if (result.info.lineEnding === "mixed") {
    notes.push("This file has inconsistent line endings.")
  }

  return notes.length > 0 ? notes.join(" ") : undefined
}

/**
 * Restores a file's original line endings.
 *
 * Called before writing. The editing layer works in LF throughout, which keeps
 * every pattern match and offset calculation simple, and the conversion happens
 * once at the boundary.
 */
export function applyLineEnding(content: string, ending: LineEnding): string {
  const normalised = content.replace(/\r\n|\r/g, "\n")

  switch (ending) {
    case "crlf":
      return normalised.replace(/\n/g, "\r\n")

    case "cr":
      return normalised.replace(/\n/g, "\r")

    // A mixed file is left alone rather than being normalised to one style,
    // since picking one would rewrite lines the edit never touched.
    case "mixed":
    case "lf":
    default:
      return normalised
  }
}

/**
 * A human-readable size.
 *
 * Used in error messages and the file picker. Binary units, because file sizes
 * are the one place where decimal megabytes still surprise people.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`

  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
