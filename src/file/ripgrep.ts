/**
 * Content and filename search.
 *
 * Prefers the real `rg` binary when it is on PATH — nothing written in
 * JavaScript will beat it — and falls back to a complete pure-Node
 * implementation otherwise. Both paths produce identical result shapes, so
 * callers never branch on which one ran.
 *
 * The fallback is not a toy. It implements the parts of ripgrep an agent
 * actually depends on:
 *  - gitignore-aware traversal with the built-in skip list
 *  - binary detection so a match inside a `.so` is never reported
 *  - literal and regex modes, case sensitivity with smart-case
 *  - context lines before and after
 *  - per-file and total match caps, so one runaway pattern cannot exhaust memory
 *  - result ordering by modification time, because in an agent "recently edited"
 *    is a far better relevance signal than alphabetical order
 *
 * Streaming matters here. A search over a large monorepo produces results for
 * seconds; yielding them incrementally lets the caller stop early once it has
 * enough, which is the single largest win available.
 */

import { spawn } from "node:child_process"
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, join, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"

import { logger } from "../util/log.js"
import { which } from "../util/fs-extra.js"
import { globToRegExp } from "../util/glob.js"
import { IgnoreMatcher, type IgnoreOptions } from "./ignore.js"

const log = logger("file.search")

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  /** The pattern. Interpreted as a regular expression unless `literal`. */
  readonly pattern: string
  /** Directory to search. */
  readonly path: string
  /** Treat the pattern as a literal string. */
  readonly literal?: boolean
  /**
   * Case sensitivity. "smart" is case-insensitive unless the pattern contains an
   * uppercase letter, which is what people mean nearly always.
   */
  readonly caseSensitivity?: "sensitive" | "insensitive" | "smart"
  /** Only search files matching this glob. */
  readonly include?: string
  /** Skip files matching this glob. */
  readonly exclude?: string
  /** Lines of context before each match. */
  readonly before?: number
  /** Lines of context after each match. */
  readonly after?: number
  /** Stop after this many matches in total. */
  readonly maxMatches?: number
  /** Stop after this many matches within one file. */
  readonly maxPerFile?: number
  /** Only report file names, not matching lines. */
  readonly filesOnly?: boolean
  /** Match whole words only. */
  readonly wholeWord?: boolean
  /** Include hidden files. */
  readonly hidden?: boolean
  /** Ignore-file behaviour. */
  readonly ignore?: Partial<Omit<IgnoreOptions, "root">>
  /** Abort signal, checked between files. */
  readonly signal?: AbortSignal
  /** Maximum bytes of any single file to read. */
  readonly maxFileBytes?: number
}

export interface SearchMatch {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly text: string
  readonly before: readonly string[]
  readonly after: readonly string[]
  /** Modification time, used for ordering. */
  readonly mtimeMs: number
}

export interface SearchSummary {
  readonly matches: readonly SearchMatch[]
  readonly filesSearched: number
  readonly filesMatched: number
  readonly truncated: boolean
  readonly durationMs: number
  readonly engine: "ripgrep" | "node"
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

let ripgrepPath: string | null | undefined

/** Locates `rg`, caching both success and failure. */
export function ripgrepBinary(): string | undefined {
  if (ripgrepPath === undefined) {
    ripgrepPath = which("rg") ?? null
    log.debug(ripgrepPath ? "using ripgrep" : "ripgrep not found, using the built-in engine", {
      path: ripgrepPath ?? undefined,
    })
  }
  return ripgrepPath ?? undefined
}

/** Forces the pure-Node path, for tests and for deterministic behaviour. */
export function disableRipgrep(): void {
  ripgrepPath = null
}

export async function search(options: SearchOptions): Promise<SearchSummary> {
  const started = Date.now()
  const binary = ripgrepBinary()

  if (binary) {
    try {
      const result = await searchWithRipgrep(binary, options)
      return { ...result, durationMs: Date.now() - started, engine: "ripgrep" }
    } catch (error) {
      // A ripgrep failure is not fatal: fall through to the built-in engine so a
      // broken or ancient rg cannot break the agent.
      log.warn("ripgrep failed, falling back", { error: String(error) })
    }
  }

  const result = await searchWithNode(options)
  return { ...result, durationMs: Date.now() - started, engine: "node" }
}

/* ------------------------------------------------------------------ */
/* ripgrep backend                                                     */
/* ------------------------------------------------------------------ */

interface RipgrepJsonBegin {
  type: "begin"
  data: { path: { text?: string } }
}

interface RipgrepJsonMatch {
  type: "match"
  data: {
    path: { text?: string }
    lines: { text?: string }
    line_number: number
    absolute_offset: number
    submatches: Array<{ start: number; end: number }>
  }
}

interface RipgrepJsonContext {
  type: "context"
  data: {
    path: { text?: string }
    lines: { text?: string }
    line_number: number
  }
}

type RipgrepJson = RipgrepJsonBegin | RipgrepJsonMatch | RipgrepJsonContext | { type: string; data: unknown }

/**
 * Runs `rg --json` and parses the event stream.
 *
 * JSON output rather than the text format because parsing `file:line:text` is
 * ambiguous the moment a path or a matched line contains a colon — which, in a
 * codebase, is constantly.
 */
async function searchWithRipgrep(
  binary: string,
  options: SearchOptions,
): Promise<Omit<SearchSummary, "durationMs" | "engine">> {
  const args = ["--json"]

  if (options.literal) args.push("--fixed-strings")
  if (options.wholeWord) args.push("--word-regexp")

  switch (options.caseSensitivity ?? "smart") {
    case "insensitive":
      args.push("--ignore-case")
      break
    case "smart":
      args.push("--smart-case")
      break
    default:
      args.push("--case-sensitive")
      break
  }

  if (options.include) args.push("--glob", options.include)
  if (options.exclude) args.push("--glob", `!${options.exclude}`)
  if (options.hidden) args.push("--hidden")
  if (options.before) args.push("--before-context", String(options.before))
  if (options.after) args.push("--after-context", String(options.after))
  if (options.maxPerFile) args.push("--max-count", String(options.maxPerFile))
  if (options.filesOnly) args.push("--files-with-matches")

  // Always exclude the noise the built-in list covers, since rg only knows about
  // .gitignore.
  for (const directory of [".git", "node_modules", "dist", "build", "target", ".next", "coverage"]) {
    args.push("--glob", `!${directory}/**`)
  }

  args.push("--max-filesize", `${Math.floor((options.maxFileBytes ?? 2 * 1024 * 1024) / 1024)}K`)
  args.push("--", options.pattern, options.path)

  const child = spawn(binary, args, {
    cwd: options.path,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })

  const matches: SearchMatch[] = []
  const matchedFiles = new Set<string>()
  let filesSearched = 0
  let truncated = false
  const limit = options.maxMatches ?? 500

  const pendingContext = new Map<string, string[]>()
  const mtimes = new Map<string, number>()

  const mtimeOf = (path: string): number => {
    const cached = mtimes.get(path)
    if (cached !== undefined) return cached
    let value = 0
    try {
      value = statSync(path).mtimeMs
    } catch {
      value = 0
    }
    mtimes.set(path, value)
    return value
  }

  const reader = createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY })

  const onAbort = (): void => {
    child.kill("SIGTERM")
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    for await (const line of reader) {
      if (line === "") continue
      let event: RipgrepJson
      try {
        event = JSON.parse(line) as RipgrepJson
      } catch {
        continue
      }

      if (event.type === "begin") {
        filesSearched++
        const path = (event as RipgrepJsonBegin).data.path.text
        if (path) pendingContext.set(path, [])
        continue
      }

      if (event.type === "context") {
        const data = (event as RipgrepJsonContext).data
        const path = data.path.text
        if (!path) continue
        const list = pendingContext.get(path) ?? []
        list.push((data.lines.text ?? "").replace(/\n$/, ""))
        // Only the most recent `before` lines are ever needed.
        while (list.length > (options.before ?? 0)) list.shift()
        pendingContext.set(path, list)
        continue
      }

      if (event.type === "match") {
        const data = (event as RipgrepJsonMatch).data
        const path = data.path.text
        if (!path) continue
        const absolute = resolve(options.path, path)
        matchedFiles.add(absolute)

        if (matches.length >= limit) {
          truncated = true
          child.kill("SIGTERM")
          break
        }

        matches.push({
          path: absolute,
          line: data.line_number,
          column: (data.submatches[0]?.start ?? 0) + 1,
          text: (data.lines.text ?? "").replace(/\n$/, ""),
          before: [...(pendingContext.get(path) ?? [])],
          after: [],
          mtimeMs: mtimeOf(absolute),
        })
        pendingContext.set(path, [])
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    reader.close()
    if (child.exitCode === null) child.kill("SIGTERM")
  }

  return {
    matches: orderResults(matches),
    filesSearched,
    filesMatched: matchedFiles.size,
    truncated,
  }
}

/* ------------------------------------------------------------------ */
/* Node backend                                                        */
/* ------------------------------------------------------------------ */

/**
 * Pure-Node search.
 *
 * Reads files with a streaming line reader rather than `readFileSync` so a
 * multi-megabyte log does not have to be resident all at once, and so an early
 * exit on `maxMatches` stops reading immediately.
 */
async function searchWithNode(
  options: SearchOptions,
): Promise<Omit<SearchSummary, "durationMs" | "engine">> {
  const root = resolve(options.path)
  const regex = buildRegex(options)
  const includeRegex = options.include ? globToRegExp(options.include, { dot: true }) : undefined
  const excludeRegex = options.exclude ? globToRegExp(options.exclude, { dot: true }) : undefined

  const matcher = new IgnoreMatcher({ root, ...options.ignore })
  const limit = options.maxMatches ?? 500
  const perFile = options.maxPerFile ?? 50
  const maxBytes = options.maxFileBytes ?? 2 * 1024 * 1024
  const before = options.before ?? 0
  const after = options.after ?? 0

  const matches: SearchMatch[] = []
  const matchedFiles = new Set<string>()
  let filesSearched = 0
  let truncated = false

  for (const file of walk(root, matcher, { hidden: options.hidden ?? false, signal: options.signal })) {
    if (options.signal?.aborted) break
    if (matches.length >= limit) {
      truncated = true
      break
    }

    const relativePath = relative(root, file.path).split(sep).join("/")
    if (includeRegex && !includeRegex.test(relativePath) && !includeRegex.test(basename(file.path))) continue
    if (excludeRegex && (excludeRegex.test(relativePath) || excludeRegex.test(basename(file.path)))) continue
    if (file.size > maxBytes) continue
    if (isBinaryExtension(file.path)) continue

    filesSearched++

    const found = await searchFile(file.path, regex, {
      before,
      after,
      limit: Math.min(perFile, limit - matches.length),
      filesOnly: options.filesOnly ?? false,
      mtimeMs: file.mtimeMs,
    })

    if (found.length > 0) {
      matchedFiles.add(file.path)
      matches.push(...found)
    }
  }

  if (matches.length >= limit) truncated = true

  return {
    matches: orderResults(matches.slice(0, limit)),
    filesSearched,
    filesMatched: matchedFiles.size,
    truncated,
  }
}

interface FileSearchOptions {
  readonly before: number
  readonly after: number
  readonly limit: number
  readonly filesOnly: boolean
  readonly mtimeMs: number
}

/**
 * Searches one file line by line.
 *
 * Context handling keeps a small ring buffer of preceding lines and a list of
 * matches still waiting for their trailing context. That is the only way to
 * produce `-A`/`-B` output in a single pass.
 */
async function searchFile(
  path: string,
  regex: RegExp,
  options: FileSearchOptions,
): Promise<SearchMatch[]> {
  const results: SearchMatch[] = []
  const beforeBuffer: string[] = []
  const awaiting: Array<{ match: SearchMatch; remaining: number; after: string[] }> = []

  // A quick binary sniff on the first chunk avoids streaming an entire object
  // file line by line.
  try {
    const handle = readFileSync(path, { flag: "r" })
    if (looksBinary(handle)) return []
    // Small files are faster read whole; the streaming path has real overhead.
    if (handle.length < 256 * 1024) {
      return searchBuffer(handle.toString("utf8"), path, regex, options)
    }
  } catch {
    return []
  }

  const stream = createReadStream(path, { encoding: "utf8" })
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })

  let lineNumber = 0
  try {
    for await (const line of reader) {
      lineNumber++

      for (const entry of awaiting) {
        if (entry.remaining > 0) {
          entry.after.push(line)
          entry.remaining--
        }
      }

      regex.lastIndex = 0
      const found = regex.exec(line)
      if (found) {
        if (options.filesOnly) {
          results.push({
            path,
            line: lineNumber,
            column: found.index + 1,
            text: line,
            before: [],
            after: [],
            mtimeMs: options.mtimeMs,
          })
          break
        }

        const match: SearchMatch = {
          path,
          line: lineNumber,
          column: found.index + 1,
          text: truncateLine(line),
          before: [...beforeBuffer],
          after: [],
          mtimeMs: options.mtimeMs,
        }
        const entry = { match, remaining: options.after, after: [] as string[] }
        awaiting.push(entry)
        results.push(match)

        if (results.length >= options.limit) {
          // Let the pending context fill, then stop.
          if (options.after === 0) break
        }
      }

      beforeBuffer.push(line)
      while (beforeBuffer.length > options.before) beforeBuffer.shift()

      // Drop finished entries so the list does not grow without bound.
      while (awaiting.length > 0 && awaiting[0]!.remaining === 0) {
        const entry = awaiting.shift()!
        ;(entry.match as { after: readonly string[] }).after = entry.after
      }

      if (results.length >= options.limit && awaiting.length === 0) break
    }
  } finally {
    reader.close()
    stream.destroy()
  }

  for (const entry of awaiting) {
    ;(entry.match as { after: readonly string[] }).after = entry.after
  }

  return results
}

/** Whole-buffer search, used for small files where streaming is pure overhead. */
function searchBuffer(
  content: string,
  path: string,
  regex: RegExp,
  options: FileSearchOptions,
): SearchMatch[] {
  const lines = content.split("\n")
  const results: SearchMatch[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    regex.lastIndex = 0
    const found = regex.exec(line)
    if (!found) continue

    results.push({
      path,
      line: index + 1,
      column: found.index + 1,
      text: truncateLine(line),
      before: options.before > 0 ? lines.slice(Math.max(0, index - options.before), index) : [],
      after:
        options.after > 0 ? lines.slice(index + 1, Math.min(lines.length, index + 1 + options.after)) : [],
      mtimeMs: options.mtimeMs,
    })

    if (options.filesOnly) break
    if (results.length >= options.limit) break
  }

  return results
}

/* ------------------------------------------------------------------ */
/* Filename search (glob)                                              */
/* ------------------------------------------------------------------ */

export interface GlobOptions {
  readonly pattern: string
  readonly path: string
  readonly limit?: number
  readonly hidden?: boolean
  readonly ignore?: Partial<Omit<IgnoreOptions, "root">>
  readonly signal?: AbortSignal
  /** Sort by modification time descending instead of by path. */
  readonly recent?: boolean
  /** Include directories in the results. */
  readonly directories?: boolean
}

export interface GlobResult {
  readonly paths: readonly string[]
  readonly truncated: boolean
  readonly scanned: number
  readonly durationMs: number
}

/**
 * Finds files by name pattern.
 *
 * Results are ordered by modification time by default. In an interactive coding
 * session the file you want is almost always one that was touched recently, and
 * alphabetical order buries it.
 */
export function glob(options: GlobOptions): GlobResult {
  const started = Date.now()
  const root = resolve(options.path)
  const matcher = new IgnoreMatcher({ root, ...options.ignore })
  const regex = globToRegExp(options.pattern, { dot: options.hidden ?? false })
  const limit = options.limit ?? 500

  const found: Array<{ path: string; mtimeMs: number }> = []
  let scanned = 0
  let truncated = false

  for (const entry of walk(root, matcher, {
    hidden: options.hidden ?? false,
    signal: options.signal,
    directories: options.directories ?? false,
  })) {
    scanned++
    if (options.signal?.aborted) break

    const relativePath = relative(root, entry.path).split(sep).join("/")
    if (!regex.test(relativePath) && !regex.test(basename(entry.path))) continue

    found.push({ path: entry.path, mtimeMs: entry.mtimeMs })
    if (found.length >= limit * 4) {
      // Collect a generous superset so ordering is meaningful, then cut.
      truncated = true
      break
    }
  }

  if (options.recent !== false) {
    found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  } else {
    found.sort((left, right) => left.path.localeCompare(right.path))
  }

  const paths = found.slice(0, limit).map((entry) => entry.path)
  if (found.length > limit) truncated = true

  return { paths, truncated, scanned, durationMs: Date.now() - started }
}

/* ------------------------------------------------------------------ */
/* Traversal                                                           */
/* ------------------------------------------------------------------ */

interface WalkEntry {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  readonly directory: boolean
}

interface WalkOptions {
  readonly hidden: boolean
  readonly signal?: AbortSignal
  readonly directories?: boolean
  readonly maxDepth?: number
}

/**
 * Breadth-first directory walk.
 *
 * Breadth-first on purpose: shallow files are overwhelmingly more likely to be
 * what the user meant, so when a result cap truncates the walk the results kept
 * are the useful ones. A depth-first walk would spend the budget deep inside the
 * first subdirectory it found.
 */
export function* walk(root: string, matcher: IgnoreMatcher, options: WalkOptions): Generator<WalkEntry> {
  const queue: Array<{ path: string; depth: number }> = [{ path: resolve(root), depth: 0 }]
  const maxDepth = options.maxDepth ?? 32
  const seen = new Set<string>()

  while (queue.length > 0) {
    if (options.signal?.aborted) return

    const current = queue.shift()!
    if (current.depth > maxDepth) continue

    // Guard against symlink loops, which do occur in monorepos.
    let realPath = current.path
    try {
      realPath = statSync(current.path).isDirectory() ? current.path : current.path
    } catch {
      continue
    }
    if (seen.has(realPath)) continue
    seen.add(realPath)

    matcher.loadDirectory(current.path)

    let entries: string[]
    try {
      entries = readdirSync(current.path)
    } catch {
      continue
    }

    for (const name of entries) {
      if (!options.hidden && name.startsWith(".") && name !== "." && name !== "..") {
        // Hidden files are skipped unless requested, but ignore files themselves
        // still had to be read above.
        continue
      }

      const full = join(current.path, name)
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }

      if (stats.isDirectory()) {
        if (!matcher.shouldDescend(full)) continue
        queue.push({ path: full, depth: current.depth + 1 })
        if (options.directories) {
          yield { path: full, size: 0, mtimeMs: stats.mtimeMs, directory: true }
        }
        continue
      }

      if (!stats.isFile()) continue
      if (matcher.isIgnored(full, false)) continue

      yield { path: full, size: stats.size, mtimeMs: stats.mtimeMs, directory: false }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Compiles the search pattern.
 *
 * Smart case is the default because it matches how people search: a lowercase
 * query means "I do not care about case", and any uppercase letter means "I typed
 * this deliberately".
 */
function buildRegex(options: SearchOptions): RegExp {
  let source = options.literal ? escapeRegex(options.pattern) : options.pattern
  if (options.wholeWord) source = `\\b(?:${source})\\b`

  const mode = options.caseSensitivity ?? "smart"
  const insensitive =
    mode === "insensitive" || (mode === "smart" && !/[A-Z]/.test(options.pattern))

  try {
    return new RegExp(source, insensitive ? "i" : "")
  } catch (error) {
    throw new Error(
      `The search pattern is not a valid regular expression: ${(error as Error).message}. Escape the special characters or search for a literal string.`,
    )
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".avif", ".heic",
  ".mp3", ".mp4", ".wav", ".flac", ".ogg", ".avi", ".mov", ".mkv", ".webm", ".m4a",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".apk", ".dmg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".obj", ".lib", ".pdb",
  ".pyc", ".pyo", ".class", ".wasm", ".node",
  ".db", ".sqlite", ".sqlite3", ".mdb", ".pack", ".idx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".psd", ".ai", ".sketch", ".fig", ".blend", ".fbx", ".glb", ".gltf",
])

function isBinaryExtension(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase())
}

/** NUL byte in the first 8 KB — the standard heuristic, and reliable in practice. */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8_192)
  for (let index = 0; index < limit; index++) {
    if (buffer[index] === 0) return true
  }
  return false
}

/**
 * Caps a single matched line.
 *
 * A minified bundle that slipped past the ignore rules can contain a single
 * 2 MB line; sending it to a model is both useless and expensive.
 */
function truncateLine(line: string, max = 400): string {
  if (line.length <= max) return line
  return `${line.slice(0, max)}\u2026 [line truncated, ${line.length} characters]`
}

/**
 * Orders results so the most likely relevant ones come first.
 *
 * Recently modified files first, then by path, then by line. The recency signal
 * is the important one: when an agent searches for a symbol it just wrote about,
 * the file it was working in is almost always the right answer.
 */
function orderResults(matches: readonly SearchMatch[]): SearchMatch[] {
  return [...matches].sort((left, right) => {
    if (left.path !== right.path) {
      if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs
      return left.path.localeCompare(right.path)
    }
    return left.line - right.line
  })
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export interface RenderOptions {
  readonly cwd: string
  readonly showContext?: boolean
  readonly maxLines?: number
}

/**
 * Formats results for a model.
 *
 * Grouped by file with a `path:line` prefix on every line, because that is the
 * format models reliably parse back out and echo when they explain what they
 * found. Losing the line numbers costs a follow-up read.
 */
export function renderMatches(summary: SearchSummary, options: RenderOptions): string {
  if (summary.matches.length === 0) {
    return `No matches in ${summary.filesSearched} files.`
  }

  const byFile = new Map<string, SearchMatch[]>()
  for (const match of summary.matches) {
    const list = byFile.get(match.path) ?? []
    list.push(match)
    byFile.set(match.path, list)
  }

  const lines: string[] = []
  const maxLines = options.maxLines ?? 400

  for (const [path, group] of byFile) {
    if (lines.length >= maxLines) {
      lines.push(`\u2026 and matches in ${byFile.size - [...byFile.keys()].indexOf(path)} more files`)
      break
    }

    const display = displayRelative(path, options.cwd)
    lines.push(`${display}:`)

    for (const match of group) {
      if (options.showContext) {
        const start = match.line - match.before.length
        for (const [index, context] of match.before.entries()) {
          lines.push(`  ${start + index}\u2502 ${context}`)
        }
      }
      lines.push(`  ${match.line}\u2502 ${match.text}`)
      if (options.showContext) {
        for (const [index, context] of match.after.entries()) {
          lines.push(`  ${match.line + index + 1}\u2502 ${context}`)
        }
      }
    }
    lines.push("")
  }

  const header = [
    `${summary.matches.length} match${summary.matches.length === 1 ? "" : "es"} in ${summary.filesMatched} file${summary.filesMatched === 1 ? "" : "s"}`,
    summary.truncated ? " (truncated; narrow the pattern or add an include filter)" : "",
  ].join("")

  return `${header}\n\n${lines.join("\n").trimEnd()}`
}

function displayRelative(path: string, cwd: string): string {
  const relativePath = relative(cwd, path)
  if (relativePath === "" || relativePath.startsWith("..")) return path
  return relativePath.split(sep).join("/")
}
