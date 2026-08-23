/**
 * Gitignore-compatible path filtering.
 *
 * Every search, watch, and tree walk in the agent goes through this. Getting it
 * right matters more than it looks: a search that walks `node_modules` is not
 * merely slow, it drowns the real results, and an agent that reads a `.env` file
 * into a model prompt is a security incident.
 *
 * Implements the parts of the gitignore specification that actually occur in
 * real repositories:
 *  - Comments (`#`) and blank lines.
 *  - Negation (`!pattern`), including re-inclusion after a broad exclude.
 *  - Anchoring: a pattern containing a mid-string slash is anchored to the
 *    directory containing the ignore file; otherwise it matches at any depth.
 *  - Directory-only patterns (`build/`).
 *  - `**` for arbitrary depth, `*` within a segment, `?`, and `[a-z]` classes.
 *  - Precedence: the last matching pattern wins, and patterns from a deeper
 *    ignore file override shallower ones.
 *
 * Deliberately not implemented: `core.excludesFile` beyond the global
 * `~/.config/git/ignore`, and the `.git/info/exclude` file's rare interactions
 * with sparse checkouts.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

/**
 * Directories skipped unconditionally, even when not gitignored.
 *
 * These are either enormous (dependency trees, build caches) or actively harmful
 * to walk (`.git` contains loose objects that look like text files). Ignoring
 * them by default is what makes a cold search fast in a repository that has no
 * `.gitignore` at all — a surprisingly common case in the directories agents get
 * pointed at.
 */
export const ALWAYS_IGNORED_DIRECTORIES: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  ".bzr",
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".yarn",
  "vendor/bundle",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".venv",
  "venv",
  ".eggs",
  "target",
  ".gradle",
  ".m2",
  "Pods",
  ".dart_tool",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".output",
  ".vercel",
  ".netlify",
  ".turbo",
  ".nx",
  ".parcel-cache",
  ".cache",
  ".rollup.cache",
  ".vite",
  "dist",
  "build",
  "out",
  "coverage",
  ".nyc_output",
  ".terraform",
  ".serverless",
  ".idea",
  ".vscode-test",
  ".DS_Store",
  "tmp",
  ".tmp",
  ".sass-cache",
  "bin/Debug",
  "obj/Debug",
  ".stack-work",
  ".ccls-cache",
  ".clangd",
  "zig-cache",
  "zig-out",
  ".elixir_ls",
  "_build",
  "deps",
]

/**
 * Files never shown to a model without an explicit request.
 *
 * Not a security boundary — the permission engine is — but a strong default. An
 * agent grepping for "password" should not casually surface the contents of
 * `.env.production`.
 */
export const SENSITIVE_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "service-account*.json",
  ".aws/credentials",
  "secrets.yaml",
  "secrets.yml",
  "secrets.json",
  "*.secret",
]

/** Files that are technically text but never worth searching. */
export const NOISE_PATTERNS: readonly string[] = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "pubspec.lock",
  "packages.lock.json",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.tsbuildinfo",
  "*.log",
  "*.pid",
  "*.snap",
]

/* ------------------------------------------------------------------ */
/* Pattern compilation                                                 */
/* ------------------------------------------------------------------ */

interface CompiledPattern {
  readonly source: string
  readonly regex: RegExp
  readonly negated: boolean
  readonly directoryOnly: boolean
  /** Directory the pattern is relative to, as a posix-style prefix. */
  readonly base: string
}

/**
 * Translates one gitignore line into a regular expression.
 *
 * The subtleties, all of which have bitten real implementations:
 *  - A trailing slash means "directory only", and the slash is not part of the
 *    match.
 *  - A leading slash anchors to the base directory and is not part of the match.
 *  - A slash anywhere else also anchors the pattern, which is why `doc/frotz`
 *    matches only at the top level but `frotz` matches anywhere.
 *  - `**` between slashes matches zero or more directories, so `a/**\/b` must
 *    match `a/b`.
 *  - A trailing `**` matches everything below.
 *  - Escaped characters (`\#`, `\!`, `\ `) are literals.
 */
function compilePattern(raw: string, base: string): CompiledPattern | undefined {
  let pattern = raw

  // Strip trailing whitespace unless escaped, per the specification.
  pattern = pattern.replace(/(?<!\\)\s+$/, "")
  if (pattern === "") return undefined
  if (pattern.startsWith("#")) return undefined

  let negated = false
  if (pattern.startsWith("!")) {
    negated = true
    pattern = pattern.slice(1)
  }

  // Unescape leading markers.
  pattern = pattern.replace(/^\\([#!])/, "$1")

  let directoryOnly = false
  if (pattern.endsWith("/")) {
    directoryOnly = true
    pattern = pattern.slice(0, -1)
  }
  if (pattern === "") return undefined

  let anchored = false
  if (pattern.startsWith("/")) {
    anchored = true
    pattern = pattern.slice(1)
  } else if (pattern.slice(0, -1).includes("/")) {
    // A slash anywhere but the very end anchors the pattern.
    anchored = true
  }

  const body = translate(pattern)
  const prefix = base === "" ? "" : `${base}/`
  const source = anchored
    ? `^${escapeLiteral(prefix)}${body}(?:/.*)?$`
    : `^${escapeLiteral(prefix)}(?:.*/)?${body}(?:/.*)?$`

  return {
    source: raw,
    regex: new RegExp(source),
    negated,
    directoryOnly,
    base,
  }
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Converts glob syntax to a regular expression body. */
function translate(pattern: string): string {
  let result = ""
  let index = 0

  while (index < pattern.length) {
    const char = pattern[index]!

    if (char === "\\" && index + 1 < pattern.length) {
      result += escapeLiteral(pattern[index + 1]!)
      index += 2
      continue
    }

    if (char === "*") {
      const isDouble = pattern[index + 1] === "*"
      if (isDouble) {
        const before = index === 0 || pattern[index - 1] === "/"
        const afterSlash = pattern[index + 2] === "/"
        if (before && afterSlash) {
          // `**/` matches zero or more directories.
          result += "(?:[^/]+/)*"
          index += 3
          continue
        }
        if (before && index + 2 >= pattern.length) {
          result += ".*"
          index += 2
          continue
        }
        result += ".*"
        index += 2
        continue
      }
      result += "[^/]*"
      index += 1
      continue
    }

    if (char === "?") {
      result += "[^/]"
      index += 1
      continue
    }

    if (char === "[") {
      const close = findClosingBracket(pattern, index)
      if (close === -1) {
        result += "\\["
        index += 1
        continue
      }
      let body = pattern.slice(index + 1, close)
      // gitignore uses `!` for negation inside classes; regex uses `^`.
      if (body.startsWith("!")) body = `^${body.slice(1)}`
      result += `[${body.replace(/\\/g, "\\\\")}]`
      index = close + 1
      continue
    }

    result += escapeLiteral(char)
    index += 1
  }

  return result
}

function findClosingBracket(pattern: string, start: number): number {
  let index = start + 1
  if (pattern[index] === "!") index++
  if (pattern[index] === "]") index++
  while (index < pattern.length) {
    if (pattern[index] === "]") return index
    if (pattern[index] === "\\") index++
    index++
  }
  return -1
}

/* ------------------------------------------------------------------ */
/* Matcher                                                             */
/* ------------------------------------------------------------------ */

export interface IgnoreOptions {
  /** Root of the tree being filtered. All paths are relative to this. */
  readonly root: string
  /** Load `.gitignore` files found while walking. Defaults to true. */
  readonly useGitignore?: boolean
  /** Also honour `.ignore` and `.rgignore`. Defaults to true. */
  readonly useIgnoreFiles?: boolean
  /** Apply the built-in directory skip list. Defaults to true. */
  readonly useDefaults?: boolean
  /** Hide secrets and lock files. Defaults to true. */
  readonly hideSensitive?: boolean
  /** Extra patterns, applied last so they can override everything. */
  readonly extra?: readonly string[]
  /** Read the user's global gitignore. Defaults to true. */
  readonly useGlobal?: boolean
}

/**
 * Incremental gitignore matcher.
 *
 * Ignore files are loaded lazily, as the walker enters each directory, and
 * cached. That ordering is required for correctness — a nested `.gitignore` can
 * re-include a path its parent excluded — and it is also what keeps the cost
 * proportional to the directories actually visited rather than to the size of
 * the repository.
 */
export class IgnoreMatcher {
  private readonly root: string
  private readonly options: Required<Omit<IgnoreOptions, "root" | "extra">> & { extra: readonly string[] }
  /** Patterns keyed by the posix-relative directory they were loaded from. */
  private readonly loaded = new Map<string, CompiledPattern[]>()
  private readonly global: CompiledPattern[] = []
  private readonly builtin: CompiledPattern[] = []
  private readonly extra: CompiledPattern[] = []
  private readonly decisions = new Map<string, boolean>()

  constructor(options: IgnoreOptions) {
    this.root = resolve(options.root)
    this.options = {
      useGitignore: options.useGitignore !== false,
      useIgnoreFiles: options.useIgnoreFiles !== false,
      useDefaults: options.useDefaults !== false,
      hideSensitive: options.hideSensitive !== false,
      useGlobal: options.useGlobal !== false,
      extra: options.extra ?? [],
    }

    if (this.options.useDefaults) {
      for (const directory of ALWAYS_IGNORED_DIRECTORIES) {
        const compiled = compilePattern(directory.includes("/") ? `/${directory}/` : `${directory}/`, "")
        if (compiled) this.builtin.push(compiled)
      }
      for (const noise of NOISE_PATTERNS) {
        const compiled = compilePattern(noise, "")
        if (compiled) this.builtin.push(compiled)
      }
    }

    if (this.options.hideSensitive) {
      for (const pattern of SENSITIVE_PATTERNS) {
        const compiled = compilePattern(pattern, "")
        if (compiled) this.builtin.push(compiled)
      }
    }

    for (const pattern of this.options.extra) {
      const compiled = compilePattern(pattern, "")
      if (compiled) this.extra.push(compiled)
    }

    if (this.options.useGlobal) {
      this.loadGlobal()
    }
  }

  private loadGlobal(): void {
    const candidates = [
      join(homedir(), ".config", "git", "ignore"),
      join(homedir(), ".gitignore_global"),
      join(homedir(), ".gitignore"),
    ]
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      for (const line of readLines(candidate)) {
        const compiled = compilePattern(line, "")
        if (compiled) this.global.push(compiled)
      }
      break
    }
  }

  /**
   * Loads the ignore files in one directory.
   *
   * Called by the walker before it inspects the directory's entries. Idempotent,
   * so a second walk of the same tree costs nothing.
   */
  loadDirectory(absoluteDirectory: string): void {
    const key = this.key(absoluteDirectory)
    if (this.loaded.has(key)) return

    const patterns: CompiledPattern[] = []
    const names: string[] = []
    if (this.options.useGitignore) names.push(".gitignore")
    if (this.options.useIgnoreFiles) names.push(".ignore", ".rgignore", ".praxisignore")

    for (const name of names) {
      const file = join(absoluteDirectory, name)
      if (!existsSync(file)) continue
      for (const line of readLines(file)) {
        const compiled = compilePattern(line, key)
        if (compiled) patterns.push(compiled)
      }
    }

    // `.git/info/exclude` applies at the repository root only.
    if (this.options.useGitignore && existsSync(join(absoluteDirectory, ".git"))) {
      const exclude = join(absoluteDirectory, ".git", "info", "exclude")
      if (existsSync(exclude)) {
        for (const line of readLines(exclude)) {
          const compiled = compilePattern(line, key)
          if (compiled) patterns.push(compiled)
        }
      }
    }

    this.loaded.set(key, patterns)
  }

  /**
   * Decides whether a path is ignored.
   *
   * Precedence, lowest to highest: built-in defaults, the global gitignore,
   * repository ignore files from shallowest to deepest, then explicit extra
   * patterns. Within one source the last matching pattern wins, which is what
   * makes `*.log` followed by `!important.log` behave correctly.
   */
  isIgnored(absolutePath: string, isDirectory: boolean): boolean {
    const key = this.key(absolutePath)
    if (key === "") return false

    const cacheKey = `${isDirectory ? "d" : "f"}:${key}`
    const cached = this.decisions.get(cacheKey)
    if (cached !== undefined) return cached

    let ignored = false

    const consider = (pattern: CompiledPattern): void => {
      if (pattern.directoryOnly && !isDirectory) return
      if (!pattern.regex.test(key)) return
      ignored = !pattern.negated
    }

    for (const pattern of this.builtin) consider(pattern)
    for (const pattern of this.global) consider(pattern)

    // Walk ancestors from the root down so deeper files override shallower ones.
    for (const directory of this.ancestors(key)) {
      const patterns = this.loaded.get(directory)
      if (!patterns) continue
      for (const pattern of patterns) consider(pattern)
    }

    for (const pattern of this.extra) consider(pattern)

    this.decisions.set(cacheKey, ignored)
    return ignored
  }

  /**
   * Quick check for whether a directory should be descended into.
   *
   * Separate from `isIgnored` because git has a rule with real teeth: once a
   * directory is excluded, git does not look inside it at all, so a negation
   * deeper down cannot re-include anything. Respecting that is what keeps the
   * walk from descending into `node_modules` to discover it has a `.gitignore`
   * with a `!` line.
   */
  shouldDescend(absoluteDirectory: string): boolean {
    return !this.isIgnored(absoluteDirectory, true)
  }

  /** Posix-style path relative to the root, used as the matching subject. */
  private key(absolutePath: string): string {
    const relativePath = relative(this.root, resolve(absolutePath))
    if (relativePath === "" || relativePath.startsWith("..")) return ""
    return relativePath.split(sep).join("/")
  }

  /** Every ancestor directory key of a path, root first. */
  private ancestors(key: string): string[] {
    const parts = key.split("/")
    const result: string[] = [""]
    let current = ""
    for (let index = 0; index < parts.length - 1; index++) {
      current = current === "" ? parts[index]! : `${current}/${parts[index]!}`
      result.push(current)
    }
    return result
  }

  /** Drops cached decisions, e.g. after an ignore file changed. */
  invalidate(): void {
    this.decisions.clear()
    this.loaded.clear()
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/)
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* Standalone helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * One-shot check without building a matcher.
 *
 * Convenient for callers that test a single path, such as the read tool deciding
 * whether to warn about a secret file.
 */
export function isSensitivePath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ""
  const matcher = new IgnoreMatcher({
    root: dirname(resolve(path)),
    useGitignore: false,
    useIgnoreFiles: false,
    useDefaults: false,
    useGlobal: false,
    hideSensitive: true,
  })
  return matcher.isIgnored(join(dirname(resolve(path)), name), false)
}

/**
 * Finds the repository root by walking up for a `.git` entry.
 *
 * Used to decide the base for relative paths and to scope ignore loading. Stops
 * at the filesystem root; returns undefined outside a repository, which is a
 * supported case — agents get pointed at plain directories often.
 */
export function findRepositoryRoot(start: string): string | undefined {
  let current = resolve(start)
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}
