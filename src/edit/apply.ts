/**
 * File-level edit application.
 *
 * Sits between the tools and the filesystem, and owns everything that must
 * happen around a write regardless of which tool requested it:
 *
 *  - **Read-before-write enforcement.** A model that writes a file it has not
 *    read is guessing, and the result is usually a truncated file. The timestamp
 *    registry makes that a hard error rather than a silent data loss.
 *  - **Staleness detection.** If the file changed on disk since the model read
 *    it (the user edited it, a formatter ran, a branch was switched), the edit
 *    is refused with an explanation instead of clobbering the change.
 *  - **Atomic writes.** Write to a temporary file in the same directory and
 *    rename. A crash mid-write must never leave a half-written source file.
 *  - **Line-ending and final-newline preservation.** Nothing produces a noisier
 *    diff than an agent that converts a CRLF file to LF.
 *  - **Formatter and diagnostics hooks.** After a successful write the file is
 *    formatted with the project's own formatter and the language server is asked
 *    for diagnostics, which are fed back to the model.
 */

import { constants } from "node:fs"
import {
  accessSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, extname, relative, resolve, sep } from "node:path"

import { Bus, Events } from "../util/bus.js"
import { logger } from "../util/log.js"
import { NotFoundError, ValidationError } from "../util/error.js"
import { unifiedDiff, diffStat } from "../util/diff.js"
import {
  detectIndent,
  normalizeForEdit,
  replace,
  restoreLineEnding,
  ReplaceError,
  explainFailure,
  type ReplaceResult,
} from "./replacers.js"

const log = logger("edit.apply")

/* ------------------------------------------------------------------ */
/* Read registry                                                       */
/* ------------------------------------------------------------------ */

interface ReadRecord {
  /** Modification time in milliseconds when the file was read. */
  mtimeMs: number
  size: number
  /** When the agent read it, for diagnostics. */
  readAt: number
}

/**
 * Per-session record of which files the agent has read.
 *
 * Keyed by session so two concurrent sessions cannot satisfy each other's
 * read-before-write requirement. That would be a real hazard: session A reads a
 * file, session B rewrites it, session A's stale edit would then be accepted.
 */
const readRegistry = new Map<string, Map<string, ReadRecord>>()

function registryFor(sessionId: string): Map<string, ReadRecord> {
  let map = readRegistry.get(sessionId)
  if (!map) {
    map = new Map()
    readRegistry.set(sessionId, map)
  }
  return map
}

/** Records that a file was read. Called by the `read` tool. */
export function recordRead(sessionId: string, path: string): void {
  const absolute = resolve(path)
  try {
    const stats = statSync(absolute)
    registryFor(sessionId).set(absolute, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      readAt: Date.now(),
    })
  } catch {
    // A read that failed does not establish a baseline.
  }
}

/** Records that we wrote a file, so a subsequent edit is not considered stale. */
export function recordWrite(sessionId: string, path: string): void {
  recordRead(sessionId, path)
}

export function hasRead(sessionId: string, path: string): boolean {
  return registryFor(sessionId).has(resolve(path))
}

export function forgetSession(sessionId: string): void {
  readRegistry.delete(sessionId)
}

/** Files this session has touched, used by the file-change reminder. */
export function readFiles(sessionId: string): string[] {
  return [...registryFor(sessionId).keys()]
}

/**
 * Detects files that changed on disk since the agent last saw them.
 *
 * Drives the `file-changed` system reminder. Telling the model that the user
 * edited a file under it is the difference between a graceful re-read and a
 * confused overwrite.
 */
export function detectExternalChanges(sessionId: string): string[] {
  const changed: string[] = []
  const registry = registryFor(sessionId)
  for (const [path, record] of registry) {
    try {
      const stats = statSync(path)
      if (stats.mtimeMs > record.mtimeMs) {
        changed.push(path)
        record.mtimeMs = stats.mtimeMs
        record.size = stats.size
      }
    } catch {
      changed.push(path)
      registry.delete(path)
    }
  }
  return changed
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class StaleFileError extends Error {
  readonly path: string

  constructor(path: string, detail: string) {
    super(detail)
    this.name = "StaleFileError"
    this.path = path
  }
}

export class UnreadFileError extends Error {
  readonly path: string

  constructor(path: string) {
    super(
      `You have not read ${path} in this session. Read it first so your edit is based on its current contents.`,
    )
    this.name = "UnreadFileError"
    this.path = path
  }
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export interface ReadOptions {
  /** 1-based first line to return. */
  readonly offset?: number
  /** Maximum number of lines to return. */
  readonly limit?: number
  /** Include line numbers in the output. */
  readonly numbered?: boolean
  /** Maximum bytes to read before refusing. */
  readonly maxBytes?: number
}

export interface ReadResult {
  readonly path: string
  readonly content: string
  readonly totalLines: number
  readonly returnedLines: number
  readonly startLine: number
  readonly truncated: boolean
  readonly bytes: number
  readonly binary: boolean
}

/** Extensions we refuse to send to a model, with a reason it can act on. */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".avif",
  ".mp3", ".mp4", ".wav", ".flac", ".ogg", ".avi", ".mov", ".mkv", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".obj", ".lib",
  ".pyc", ".pyo", ".class", ".wasm", ".node",
  ".db", ".sqlite", ".sqlite3", ".mdb",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".psd", ".ai", ".sketch", ".fig", ".blend",
])

/** Images may be attached rather than read as text. */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"])

export function isProbablyBinary(path: string, sample?: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true
  if (!sample) return false
  // A NUL byte in the first few kilobytes is the classic heuristic and is right
  // essentially always for source trees.
  const limit = Math.min(sample.length, 8_000)
  for (let index = 0; index < limit; index++) {
    if (sample[index] === 0) return true
  }
  return false
}

/**
 * Reads a file for the model.
 *
 * Line numbers are on by default, and that is not cosmetic: numbered output is
 * what lets a model refer to "line 42" in its reasoning and what makes
 * diagnostics line up with what it saw.
 */
export function readFileForModel(path: string, options: ReadOptions = {}): ReadResult {
  const absolute = resolve(path)

  if (!existsSync(absolute)) {
    throw new NotFoundError(
      `${path} does not exist. Use glob or list to find the correct path; do not guess.`,
    )
  }

  const stats = statSync(absolute)
  if (stats.isDirectory()) {
    throw new ValidationError(`${path} is a directory. Use the list tool to see its contents.`)
  }

  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  if (stats.size > maxBytes) {
    throw new ValidationError(
      `${path} is ${formatBytes(stats.size)}, which is too large to read in full. Use grep to find the relevant part, then read with offset and limit.`,
    )
  }

  const buffer = readFileSync(absolute)
  if (isProbablyBinary(absolute, buffer)) {
    return {
      path: absolute,
      content: "",
      totalLines: 0,
      returnedLines: 0,
      startLine: 1,
      truncated: false,
      bytes: stats.size,
      binary: true,
    }
  }

  const text = buffer.toString("utf8").replace(/^\uFEFF/, "")
  const lines = text.split("\n")
  // A trailing newline produces a final empty element that is not a real line.
  const hasTrailingNewline = lines.length > 1 && lines[lines.length - 1] === ""
  const totalLines = hasTrailingNewline ? lines.length - 1 : lines.length

  const startLine = Math.max(1, options.offset ?? 1)
  const limit = options.limit ?? 2_000
  const slice = lines.slice(startLine - 1, startLine - 1 + limit)
  const truncated = startLine - 1 + slice.length < totalLines

  const numbered = options.numbered !== false
  const width = String(startLine + slice.length).length
  const content = numbered
    ? slice
        .map((line, index) => `${String(startLine + index).padStart(width, " ")}\u2502${line}`)
        .join("\n")
    : slice.join("\n")

  return {
    path: absolute,
    content,
    totalLines,
    returnedLines: slice.length,
    startLine,
    truncated,
    bytes: stats.size,
    binary: false,
  }
}

/** Raw contents, for tools that need to edit rather than display. */
export function readRaw(path: string): string {
  const absolute = resolve(path)
  if (!existsSync(absolute)) {
    throw new NotFoundError(`${path} does not exist.`)
  }
  return readFileSync(absolute, "utf8").replace(/^\uFEFF/, "")
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export interface WriteOptions {
  readonly sessionId: string
  /** Skip the read-before-write requirement, for genuinely new files. */
  readonly create?: boolean
  /** Skip staleness checking. Used by revert, which intends to overwrite. */
  readonly force?: boolean
  /** Preserve the original file's line endings and trailing newline. */
  readonly preserveFormatting?: boolean
}

export interface WriteResult {
  readonly path: string
  readonly created: boolean
  readonly before?: string
  readonly after: string
  readonly additions: number
  readonly deletions: number
  readonly diff: string
}

/**
 * Writes a file, atomically and with every guard applied.
 *
 * The temporary file is created in the *same directory* as the target, not in
 * the system temp dir, because `rename` is only atomic within a filesystem and
 * `/tmp` is frequently a different one.
 */
export function writeFile(path: string, content: string, options: WriteOptions): WriteResult {
  const absolute = resolve(path)
  const existed = existsSync(absolute)

  if (existed) {
    const stats = statSync(absolute)
    if (stats.isDirectory()) {
      throw new ValidationError(`${path} is a directory.`)
    }
    if (!options.force) {
      assertFresh(options.sessionId, absolute, stats.mtimeMs)
    }
    try {
      accessSync(absolute, constants.W_OK)
    } catch {
      throw new ValidationError(`${path} is not writable.`)
    }
  } else {
    mkdirSync(dirname(absolute), { recursive: true })
  }

  const before = existed ? readFileSync(absolute, "utf8") : undefined
  let output = content

  if (options.preserveFormatting !== false && before !== undefined) {
    const { ending } = normalizeForEdit(before)
    output = restoreLineEnding(output.replace(/\r\n/g, "\n"), ending)
    // Preserve the presence or absence of a final newline.
    const hadTrailing = /\r?\n$/.test(before)
    const hasTrailing = /\r?\n$/.test(output)
    if (hadTrailing && !hasTrailing) output += ending
    if (!hadTrailing && hasTrailing) output = output.replace(/\r?\n$/, "")
  } else if (!existed && output !== "" && !output.endsWith("\n")) {
    // New files get a trailing newline; nearly every linter requires one.
    output += "\n"
  }

  if (before === output) {
    return {
      path: absolute,
      created: false,
      before,
      after: output,
      additions: 0,
      deletions: 0,
      diff: "",
    }
  }

  atomicWrite(absolute, output)
  recordWrite(options.sessionId, absolute)

  const diff = unifiedDiff(before ?? "", output, {
    fromFile: existed ? relative(process.cwd(), absolute) : "/dev/null",
    toFile: relative(process.cwd(), absolute),
  })
  const stat = diffStat(before ?? "", output)

  Bus.publish(Events.fileEdited, {
    sessionId: options.sessionId,
    path: absolute,
    created: !existed,
    additions: stat.additions,
    deletions: stat.deletions,
  })

  log.info(existed ? "updated file" : "created file", {
    path: relative(process.cwd(), absolute),
    additions: stat.additions,
    deletions: stat.deletions,
  })

  return {
    path: absolute,
    created: !existed,
    before,
    after: output,
    additions: stat.additions,
    deletions: stat.deletions,
    diff,
  }
}

/**
 * Verifies the file has not changed since the session last saw it.
 *
 * Uses mtime rather than a hash because it is cheap and because the failure mode
 * we care about — a concurrent editor — always updates mtime. A hash would be
 * more precise but would require reading every file on every edit.
 */
function assertFresh(sessionId: string, absolute: string, mtimeMs: number): void {
  const record = registryFor(sessionId).get(absolute)
  if (!record) {
    throw new UnreadFileError(relative(process.cwd(), absolute))
  }
  // A one-second tolerance: some filesystems have coarse timestamps, and our own
  // formatter pass legitimately touches the file right after we write it.
  if (mtimeMs > record.mtimeMs + 1_000) {
    throw new StaleFileError(
      relative(process.cwd(), absolute),
      `${relative(process.cwd(), absolute)} changed on disk after you read it. Read it again before editing, or your change will discard someone else's work.`,
    )
  }
}

function atomicWrite(absolute: string, content: string): void {
  const temporary = `${absolute}.praxis-${process.pid}-${Date.now()}.tmp`
  try {
    writeFileSync(temporary, content, "utf8")
    renameSync(temporary, absolute)
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // Nothing useful to do; the original file is untouched either way.
    }
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

export interface EditRequest {
  readonly path: string
  readonly oldString: string
  readonly newString: string
  readonly replaceAll?: boolean
}

export interface EditResult extends WriteResult {
  readonly strategy: string
  readonly note?: string
  readonly replacements: number
  /** 1-based line number where the change begins, for the UI. */
  readonly line: number
}

/**
 * Applies one search/replace edit.
 *
 * Normalises line endings before matching and restores them afterwards, so a
 * CRLF file can be edited with LF search text — which is what a model always
 * sends, since it never sees the carriage returns.
 */
export function applyEdit(request: EditRequest, options: WriteOptions): EditResult {
  const absolute = resolve(request.path)

  if (!existsSync(absolute)) {
    if (request.oldString === "") {
      const written = writeFile(absolute, request.newString, { ...options, create: true })
      return { ...written, strategy: "create", replacements: 1, line: 1 }
    }
    throw new NotFoundError(
      `${request.path} does not exist. To create it, use the write tool, or pass an empty oldString.`,
    )
  }

  const original = readFileSync(absolute, "utf8")
  const { text, ending } = normalizeForEdit(original)

  let result: ReplaceResult
  try {
    result = replace(text, request.oldString.replace(/\r\n/g, "\n"), request.newString.replace(/\r\n/g, "\n"), {
      replaceAll: request.replaceAll,
    })
  } catch (error) {
    if (error instanceof ReplaceError) {
      throw new ValidationError(explainFailure(text, request.oldString, error))
    }
    throw error
  }

  const written = writeFile(absolute, restoreLineEnding(result.content, ending), {
    ...options,
    preserveFormatting: true,
  })

  return {
    ...written,
    strategy: result.strategy,
    note: result.note,
    replacements: result.replacements,
    line: lineOf(text, result.index),
  }
}

export interface MultiEditRequest {
  readonly path: string
  readonly edits: ReadonlyArray<{
    readonly oldString: string
    readonly newString: string
    readonly replaceAll?: boolean
  }>
}

export interface MultiEditResult extends WriteResult {
  readonly applied: number
  readonly strategies: readonly string[]
  readonly notes: readonly string[]
}

/**
 * Applies several edits to one file in a single pass.
 *
 * All or nothing: the edits are applied to an in-memory copy and the file is
 * written once at the end. A partial application would leave the file in a state
 * neither the model nor the user asked for, and the model's remaining edits
 * would then be based on stale text.
 *
 * Edits are applied in order, and each one sees the result of the previous, which
 * is what lets a model rename a symbol and then change a line that uses the new
 * name.
 */
export function applyMultiEdit(request: MultiEditRequest, options: WriteOptions): MultiEditResult {
  const absolute = resolve(request.path)
  if (!existsSync(absolute)) {
    throw new NotFoundError(`${request.path} does not exist.`)
  }
  if (request.edits.length === 0) {
    throw new ValidationError("No edits were provided.")
  }

  const original = readFileSync(absolute, "utf8")
  const { text, ending } = normalizeForEdit(original)

  let current = text
  const strategies: string[] = []
  const notes: string[] = []

  for (const [position, edit] of request.edits.entries()) {
    try {
      const result = replace(
        current,
        edit.oldString.replace(/\r\n/g, "\n"),
        edit.newString.replace(/\r\n/g, "\n"),
        { replaceAll: edit.replaceAll },
      )
      current = result.content
      strategies.push(result.strategy)
      if (result.note) notes.push(`edit ${position + 1}: ${result.note}`)
    } catch (error) {
      if (error instanceof ReplaceError) {
        throw new ValidationError(
          `Edit ${position + 1} of ${request.edits.length} failed, so no changes were written.\n\n${explainFailure(current, edit.oldString, error)}`,
        )
      }
      throw error
    }
  }

  const written = writeFile(absolute, restoreLineEnding(current, ending), {
    ...options,
    preserveFormatting: true,
  })

  return { ...written, applied: request.edits.length, strategies, notes }
}

/* ------------------------------------------------------------------ */
/* Deletion and moves                                                  */
/* ------------------------------------------------------------------ */

export function deleteFile(path: string, sessionId: string): { path: string; before: string } {
  const absolute = resolve(path)
  if (!existsSync(absolute)) {
    throw new NotFoundError(`${path} does not exist.`)
  }
  const before = readFileSync(absolute, "utf8")
  unlinkSync(absolute)
  registryFor(sessionId).delete(absolute)
  Bus.publish(Events.fileDeleted, { sessionId, path: absolute })
  return { path: absolute, before }
}

export function moveFile(from: string, to: string, sessionId: string): void {
  const source = resolve(from)
  const target = resolve(to)
  if (!existsSync(source)) throw new NotFoundError(`${from} does not exist.`)
  if (existsSync(target)) throw new ValidationError(`${to} already exists.`)
  mkdirSync(dirname(target), { recursive: true })
  renameSync(source, target)
  const record = registryFor(sessionId).get(source)
  registryFor(sessionId).delete(source)
  if (record) registryFor(sessionId).set(target, record)
  Bus.publish(Events.fileEdited, {
    sessionId,
    path: target,
    created: true,
    additions: 0,
    deletions: 0,
  })
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function lineOf(content: string, index: number): number {
  let line = 1
  for (let position = 0; position < index && position < content.length; position++) {
    if (content[position] === "\n") line++
  }
  return line
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Short relative path for display, falling back to absolute when outside cwd. */
export function displayPath(path: string, cwd = process.cwd()): string {
  const absolute = resolve(path)
  const relativePath = relative(cwd, absolute)
  if (relativePath === "") return "."
  if (relativePath.startsWith("..")) return absolute
  return relativePath.split(sep).join("/")
}

/**
 * Suggests the indentation a newly created file should use, based on its
 * siblings. Matching the surrounding project matters more than any default.
 */
export function inferIndentFromSiblings(path: string): { style: "tab" | "space"; width: number } {
  const directory = dirname(resolve(path))
  const extension = extname(path)
  try {
    const entries = readFileSync(resolve(directory, ".editorconfig"), "utf8")
    const useTabs = /indent_style\s*=\s*tab/i.test(entries)
    const size = /indent_size\s*=\s*(\d+)/i.exec(entries)
    if (useTabs) return { style: "tab", width: 1 }
    if (size) return { style: "space", width: Number(size[1]) }
  } catch {
    // No editorconfig; fall through to sampling a sibling file.
  }

  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs")
    const siblings = readdirSync(directory).filter(
      (name) => extname(name) === extension && name !== path,
    )
    for (const sibling of siblings.slice(0, 5)) {
      const content = readFileSync(resolve(directory, sibling), "utf8")
      if (content.length > 200) return detectIndent(content)
    }
  } catch {
    // Directory unreadable; use the default below.
  }

  return { style: "space", width: 2 }
}
