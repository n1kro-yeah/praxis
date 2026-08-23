/**
 * Glob matching and filesystem walking.
 *
 * Implements the subset of the glob language developers actually use:
 * `*`, `?`, `**`, `[...]`, `{a,b}`, `!` negation, and leading `**\/` implicit
 * matching. Patterns compile to anchored regular expressions and are cached.
 */

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { LruCache } from "./async.js"

export interface GlobOptions {
  /** Match paths case-insensitively (default on darwin/win32). */
  readonly caseInsensitive?: boolean
  /** Treat `*` as also matching path separators. */
  readonly globstar?: boolean
  /** Match dotfiles with `*` (default false, like shells). */
  readonly dot?: boolean
}

const REGEX_CACHE = new LruCache<string, RegExp>(2048)

function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

/** Expands `{a,b}` alternations into a list of concrete patterns. */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{")
  if (open < 0) return [pattern]

  let depth = 0
  let close = -1
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close < 0) return [pattern]

  const prefix = pattern.slice(0, open)
  const body = pattern.slice(open + 1, close)
  const suffix = pattern.slice(close + 1)

  // Numeric ranges: {1..5}
  const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body)
  if (range) {
    const from = Number(range[1])
    const to = Number(range[2])
    const step = from <= to ? 1 : -1
    const out: string[] = []
    for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
      out.push(...expandBraces(`${prefix}${v}${suffix}`))
    }
    return out
  }

  const parts: string[] = []
  let current = ""
  let nested = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string
    if (ch === "\\") {
      current += ch + (body[i + 1] ?? "")
      i++
      continue
    }
    if (ch === "{") nested++
    if (ch === "}") nested--
    if (ch === "," && nested === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  parts.push(current)

  const out: string[] = []
  for (const part of parts) out.push(...expandBraces(`${prefix}${part}${suffix}`))
  return out
}

/** Compiles a single glob (no braces) to an anchored regular expression. */
export function globToRegExp(pattern: string, options: GlobOptions = {}): RegExp {
  const key = `${pattern}\u0000${options.caseInsensitive ? 1 : 0}${options.dot ? 1 : 0}${options.globstar === false ? 0 : 1}`
  const cached = REGEX_CACHE.get(key)
  if (cached) return cached

  const dot = options.dot ?? false
  let source = ""
  let i = 0
  const segmentStart = () => source === "" || source.endsWith("/") || source.endsWith(")?")

  while (i < pattern.length) {
    const char = pattern[i] as string

    if (char === "\\") {
      source += escapeLiteral(pattern[i + 1] ?? "\\")
      i += 2
      continue
    }

    if (char === "/") {
      source += "/"
      i++
      continue
    }

    if (char === "*") {
      const isGlobstar = pattern[i + 1] === "*"
      if (isGlobstar) {
        const next = pattern[i + 2]
        // `**/` matches zero or more directories.
        if (next === "/") {
          source += "(?:(?:[^/]*(?:/|$))*)"
          i += 3
          continue
        }
        if (next === undefined) {
          source += "(?:.*)"
          i += 2
          continue
        }
        source += "(?:.*)"
        i += 2
        continue
      }
      // A leading `*` should not match a dotfile unless `dot` is set.
      source += segmentStart() && !dot ? "(?!\\.)[^/]*" : "[^/]*"
      i++
      continue
    }

    if (char === "?") {
      source += segmentStart() && !dot ? "(?!\\.)[^/]" : "[^/]"
      i++
      continue
    }

    if (char === "[") {
      let end = i + 1
      if (pattern[end] === "!" || pattern[end] === "^") end++
      if (pattern[end] === "]") end++
      while (end < pattern.length && pattern[end] !== "]") end++
      if (end >= pattern.length) {
        source += "\\["
        i++
        continue
      }
      let body = pattern.slice(i + 1, end)
      const negated = body.startsWith("!") || body.startsWith("^")
      if (negated) body = body.slice(1)
      body = body.replace(/\[:alpha:\]/g, "a-zA-Z").replace(/\[:digit:\]/g, "0-9")
      source += `[${negated ? "^/" : ""}${body.replace(/\\/g, "\\\\")}]`
      i = end + 1
      continue
    }

    source += escapeLiteral(char)
    i++
  }

  const regex = new RegExp(`^${source}$`, options.caseInsensitive ? "i" : "")
  REGEX_CACHE.set(key, regex)
  return regex
}

export interface CompiledGlob {
  readonly patterns: readonly string[]
  match(candidate: string): boolean
}

function defaultCaseInsensitive(): boolean {
  return process.platform === "darwin" || process.platform === "win32"
}

/**
 * Compiles one or more globs (with `!` negation support) into a matcher.
 * Later negations override earlier positives, matching `.gitignore` semantics.
 */
export function compileGlobs(
  patterns: readonly string[],
  options: GlobOptions = {},
): CompiledGlob {
  const caseInsensitive = options.caseInsensitive ?? defaultCaseInsensitive()
  const positive: RegExp[] = []
  const negative: RegExp[] = []

  for (const raw of patterns) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const negated = trimmed.startsWith("!")
    const body = negated ? trimmed.slice(1) : trimmed
    for (const expanded of expandBraces(body)) {
      // A bare filename like `*.ts` should match at any depth.
      const normalized =
        expanded.includes("/") || expanded.startsWith("**") ? expanded : `**/${expanded}`
      const regex = globToRegExp(normalized, { ...options, caseInsensitive })
      ;(negated ? negative : positive).push(regex)
      // Also allow matching the exact relative path without the implicit prefix.
      if (normalized !== expanded) {
        ;(negated ? negative : positive).push(
          globToRegExp(expanded, { ...options, caseInsensitive }),
        )
      }
    }
  }

  return {
    patterns,
    match(candidate: string): boolean {
      const normalized = candidate.split(path.sep).join("/")
      if (negative.some((r) => r.test(normalized))) return false
      if (positive.length === 0) return true
      return positive.some((r) => r.test(normalized))
    },
  }
}

export function matchGlob(candidate: string, pattern: string, options?: GlobOptions): boolean {
  return compileGlobs([pattern], options).match(candidate)
}

/* ------------------------------------------------------------------ */
/* Directory walking                                                   */
/* ------------------------------------------------------------------ */

export const DEFAULT_IGNORE = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.svn/**",
  "**/.hg/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/.ruff_cache/**",
  "**/.gradle/**",
  "**/vendor/**",
  "**/.terraform/**",
  "**/.idea/**",
  "**/.vscode-test/**",
  "**/coverage/**",
  "**/.cache/**",
  "**/.parcel-cache/**",
  "**/.pnpm-store/**",
  "**/tmp/**",
  "**/.DS_Store",
] as const

export interface WalkOptions {
  readonly cwd: string
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly maxDepth?: number
  readonly limit?: number
  readonly followSymlinks?: boolean
  readonly includeDirectories?: boolean
  readonly signal?: AbortSignal
  /** Extra per-directory filter, used to plug in .gitignore handling. */
  readonly shouldEnter?: (relativeDir: string) => boolean
}

export interface WalkEntry {
  readonly absolute: string
  readonly relative: string
  readonly isDirectory: boolean
  readonly size: number
  readonly mtimeMs: number
}

/**
 * Breadth-first directory walk. Breadth-first ordering means shallow (usually
 * more relevant) files come first when a result limit truncates the walk.
 */
export async function walk(options: WalkOptions): Promise<WalkEntry[]> {
  const exclude = compileGlobs([...(options.exclude ?? DEFAULT_IGNORE)])
  const include = options.include?.length ? compileGlobs(options.include) : undefined
  const limit = options.limit ?? Infinity
  const maxDepth = options.maxDepth ?? 64
  const out: WalkEntry[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: options.cwd, depth: 0 }]
  const visited = new Set<string>()

  while (queue.length && out.length < limit) {
    if (options.signal?.aborted) break
    const next = queue.shift()
    if (!next) break
    const { dir, depth } = next
    if (depth > maxDepth) continue

    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (out.length >= limit) break
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(options.cwd, absolute).split(path.sep).join("/")

      let isDirectory = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue
        try {
          const stat = await fsp.stat(absolute)
          isDirectory = stat.isDirectory()
        } catch {
          continue
        }
      }

      if (isDirectory) {
        if (!exclude.match(`${relative}/x`)) continue
        if (options.shouldEnter && !options.shouldEnter(relative)) continue
        const real = options.followSymlinks ? await realpathSafe(absolute) : absolute
        if (visited.has(real)) continue
        visited.add(real)
        queue.push({ dir: absolute, depth: depth + 1 })
        if (options.includeDirectories && (!include || include.match(relative))) {
          out.push({ absolute, relative, isDirectory: true, size: 0, mtimeMs: 0 })
        }
        continue
      }

      if (!entry.isFile()) continue
      if (!exclude.match(relative)) continue
      if (include && !include.match(relative)) continue

      let size = 0
      let mtimeMs = 0
      try {
        const stat = await fsp.stat(absolute)
        size = stat.size
        mtimeMs = stat.mtimeMs
      } catch {
        continue
      }
      out.push({ absolute, relative, isDirectory: false, size, mtimeMs })
    }
  }

  return out
}

async function realpathSafe(target: string): Promise<string> {
  try {
    return await fsp.realpath(target)
  } catch {
    return target
  }
}

/** Convenience wrapper: returns relative paths sorted by mtime, newest first. */
export async function globFiles(
  pattern: string | readonly string[],
  options: Omit<WalkOptions, "include">,
): Promise<string[]> {
  const patterns = typeof pattern === "string" ? [pattern] : pattern
  const entries = await walk({ ...options, include: patterns })
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs).map((e) => e.relative)
}

/**
 * Parses `.gitignore`-style content into glob patterns relative to `base`.
 * Handles negation, directory-only rules and anchored patterns.
 */
export function parseIgnoreFile(content: string, base = ""): string[] {
  const out: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/(?<!\\)#.*$/, "").trim()
    if (!line) continue
    const negated = line.startsWith("!")
    let body = negated ? line.slice(1) : line
    const directoryOnly = body.endsWith("/")
    if (directoryOnly) body = body.slice(0, -1)
    const anchored = body.startsWith("/")
    if (anchored) body = body.slice(1)

    const prefix = base ? `${base}/` : ""
    const pattern = anchored || body.includes("/") ? `${prefix}${body}` : `${prefix}**/${body}`
    out.push(`${negated ? "!" : ""}${pattern}`)
    out.push(`${negated ? "!" : ""}${pattern}/**`)
    if (!directoryOnly) continue
  }
  return out
}

/** Loads and merges every `.gitignore` between `cwd` and the repository root. */
export async function loadIgnorePatterns(cwd: string, root = cwd): Promise<string[]> {
  const patterns: string[] = []
  const chain: string[] = []
  let dir = path.resolve(cwd)
  const stop = path.resolve(root)
  for (let i = 0; i < 64; i++) {
    chain.unshift(dir)
    if (dir === stop || path.dirname(dir) === dir) break
    dir = path.dirname(dir)
  }
  for (const directory of chain) {
    for (const name of [".gitignore", ".praxisignore", ".ignore"]) {
      try {
        const content = await fsp.readFile(path.join(directory, name), "utf8")
        const base = path.relative(stop, directory).split(path.sep).join("/")
        patterns.push(...parseIgnoreFile(content, base))
      } catch {
        /* file absent */
      }
    }
  }
  return patterns
}

/** Splits a glob into its non-magic prefix and the magic remainder. */
export function splitGlobBase(pattern: string): { base: string; rest: string } {
  const segments = pattern.split("/")
  const base: string[] = []
  let index = 0
  for (; index < segments.length; index++) {
    const segment = segments[index] as string
    if (/[*?[\]{}!]/.test(segment)) break
    base.push(segment)
  }
  return { base: base.join("/"), rest: segments.slice(index).join("/") || "**" }
}

export function isGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern)
}
