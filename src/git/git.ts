/**
 * Git integration.
 *
 * Git is the most important context source that is not a file. The branch name
 * tells the model what the task is about, the diff tells it what has already been
 * done, and the recent log tells it the conventions of the project it is editing.
 * Injecting that into the system prompt measurably improves the first response of
 * a session.
 *
 * Everything here shells out to `git` rather than reimplementing the object
 * format. Reading `.git` directly would mean handling packfiles, alternates,
 * worktrees, submodules, and `core.fsmonitor`, and would still be wrong for
 * anything configured unusually. The `git` binary is present on every machine
 * that has a repository worth reading.
 *
 * Three rules are observed throughout:
 *  - `--no-pager` and a plumbing-friendly format on every invocation, because a
 *    pager blocks forever on a pipe and porcelain output changes between versions.
 *  - Every call has a timeout. `git status` in a huge repository on a cold cache
 *    can take a long time, and a hung git blocks a tool call.
 *  - Output is bounded. A diff can be a hundred megabytes; sending that to a model
 *    is both useless and expensive.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { logger } from "../util/log.js"
import { truncate } from "../util/string.js"

const log = logger("git")

/* ------------------------------------------------------------------ */
/* Invocation                                                          */
/* ------------------------------------------------------------------ */

export interface GitResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Runs a git command.
 *
 * `-c core.pager=cat` and `--no-pager` are both set because different git
 * versions honour different ones, and a git that decides to page will hang until
 * the timeout fires. The environment overrides suppress the credential helper and
 * any interactive prompt, so a repository with an expired token fails fast
 * instead of blocking on a password prompt no one can answer.
 */
export function git(
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number; input?: string } = { cwd: process.cwd() },
): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "git",
      ["--no-pager", "-c", "core.pager=cat", "-c", "color.ui=false", ...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "echo",
          GIT_OPTIONAL_LOCKS: "0",
          GCM_INTERACTIVE: "never",
          LC_ALL: "C",
        },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0
        resolvePromise({
          ok: !error,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code,
        })
      },
    )

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

/* ------------------------------------------------------------------ */
/* Repository discovery                                                */
/* ------------------------------------------------------------------ */

/**
 * Finds the repository root by walking up for a `.git` entry.
 *
 * Synchronous and filesystem-based rather than `git rev-parse` because this is
 * called during start-up, on a path that must stay fast, and spawning a process
 * to answer "is this a repository" is wasteful. `.git` may be a file rather than
 * a directory in a worktree or submodule, which is why `existsSync` is used
 * rather than a directory check.
 */
export function findRepositoryRoot(start: string): string | undefined {
  let directory = resolve(start)

  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(join(directory, ".git"))) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }

  return undefined
}

export function isRepository(cwd: string): boolean {
  return findRepositoryRoot(cwd) !== undefined
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export type FileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "typechange"

export interface StatusEntry {
  readonly path: string
  readonly from?: string
  readonly status: FileStatus
  readonly staged: boolean
  readonly unstaged: boolean
}

export interface RepositoryStatus {
  readonly root: string
  readonly branch?: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  readonly detached: boolean
  readonly entries: readonly StatusEntry[]
  readonly clean: boolean
  readonly conflicted: boolean
  /** Present during a rebase, merge, or cherry-pick. */
  readonly operation?: "rebase" | "merge" | "cherry-pick" | "revert" | "bisect"
}

/**
 * Reads the working tree status.
 *
 * Uses `--porcelain=v2` rather than v1: v2 includes the branch, the upstream, and
 * the ahead/behind counts in the same call, which saves three extra invocations,
 * and its format is explicitly stable across versions. The parsing is fiddlier
 * but it is parsed once here and never again.
 */
export async function status(cwd: string): Promise<RepositoryStatus | undefined> {
  const root = findRepositoryRoot(cwd)
  if (!root) return undefined

  const result = await git(
    ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--no-renames"],
    { cwd: root, timeoutMs: 15_000 },
  )

  if (!result.ok) {
    log.debug("git status failed", { stderr: truncate(result.stderr, 200) })
    return undefined
  }

  let branch: string | undefined
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  let detached = false
  const entries: StatusEntry[] = []

  for (const line of result.stdout.split("\n")) {
    if (line === "") continue

    // Header lines: "# branch.head main"
    if (line.startsWith("# ")) {
      const [, key, ...rest] = line.split(" ")
      const value = rest.join(" ")
      switch (key) {
        case "branch.head":
          if (value === "(detached)") {
            detached = true
          } else {
            branch = value
          }
          break
        case "branch.upstream":
          upstream = value
          break
        case "branch.ab": {
          // "+2 -1"
          const match = /\+(\d+) -(\d+)/.exec(value)
          if (match) {
            ahead = Number(match[1])
            behind = Number(match[2])
          }
          break
        }
        default:
          break
      }
      continue
    }

    // Ordinary changed entry: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
    if (line.startsWith("1 ")) {
      const parts = line.split(" ")
      const xy = parts[1] ?? ".."
      const path = parts.slice(8).join(" ")
      entries.push({
        path,
        status: mapStatus(xy),
        staged: xy[0] !== ".",
        unstaged: xy[1] !== ".",
      })
      continue
    }

    // Renamed or copied: "2 <XY> ... <path>\t<origPath>"
    if (line.startsWith("2 ")) {
      const parts = line.split(" ")
      const xy = parts[1] ?? ".."
      const paths = parts.slice(9).join(" ").split("\t")
      entries.push({
        path: paths[0] ?? "",
        from: paths[1],
        status: xy.includes("C") ? "copied" : "renamed",
        staged: xy[0] !== ".",
        unstaged: xy[1] !== ".",
      })
      continue
    }

    // Unmerged: "u <XY> ..."
    if (line.startsWith("u ")) {
      const parts = line.split(" ")
      entries.push({
        path: parts.slice(10).join(" "),
        status: "conflicted",
        staged: false,
        unstaged: true,
      })
      continue
    }

    // Untracked: "? path"
    if (line.startsWith("? ")) {
      entries.push({
        path: line.slice(2),
        status: "untracked",
        staged: false,
        unstaged: true,
      })
      continue
    }

    // Ignored: "! path"
    if (line.startsWith("! ")) {
      entries.push({ path: line.slice(2), status: "ignored", staged: false, unstaged: false })
    }
  }

  return {
    root,
    branch,
    upstream,
    ahead,
    behind,
    detached,
    entries,
    clean: entries.filter((entry) => entry.status !== "ignored").length === 0,
    conflicted: entries.some((entry) => entry.status === "conflicted"),
    operation: detectOperation(root),
  }
}

function mapStatus(xy: string): FileStatus {
  const combined = xy.replace(/\./g, "")
  if (combined.includes("A")) return "added"
  if (combined.includes("D")) return "deleted"
  if (combined.includes("R")) return "renamed"
  if (combined.includes("C")) return "copied"
  if (combined.includes("T")) return "typechange"
  if (combined.includes("U")) return "conflicted"
  return "modified"
}

/**
 * Detects an in-progress operation from marker files in `.git`.
 *
 * Worth knowing: an agent that runs `git commit` in the middle of a rebase makes
 * a mess that is tedious to undo, so the system prompt says so when one of these
 * is present.
 */
function detectOperation(root: string): RepositoryStatus["operation"] {
  const gitDir = join(root, ".git")
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return "rebase"
  }
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge"
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick"
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert"
  if (existsSync(join(gitDir, "BISECT_LOG"))) return "bisect"
  return undefined
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

export interface DiffOptions {
  readonly cwd: string
  /** Compare against the index rather than the working tree. */
  readonly staged?: boolean
  /** Restrict to these paths. */
  readonly paths?: readonly string[]
  /** Compare against a specific ref. */
  readonly ref?: string
  /** Lines of context. Defaults to 3. */
  readonly context?: number
  /** Truncate the output at this many characters. */
  readonly maxChars?: number
  /** Return only the summary, not the patch. */
  readonly statOnly?: boolean
}

export interface DiffResult {
  readonly patch: string
  readonly files: number
  readonly additions: number
  readonly deletions: number
  readonly truncated: boolean
}

/**
 * Produces a diff, with the stat summary computed separately.
 *
 * The stat comes from `--numstat` rather than being parsed out of the patch,
 * because the patch may be truncated and a wrong line count is worse than none.
 * `-M` enables rename detection, which turns a delete-plus-add pair into one
 * rename and makes a refactoring diff comprehensible.
 */
export async function diff(options: DiffOptions): Promise<DiffResult> {
  const root = findRepositoryRoot(options.cwd) ?? options.cwd
  const scope: string[] = []

  if (options.ref) scope.push(options.ref)
  if (options.staged) scope.push("--cached")

  const pathArgs = options.paths && options.paths.length > 0 ? ["--", ...options.paths] : []

  const numstat = await git(
    ["diff", "--numstat", "-M", ...scope, ...pathArgs],
    { cwd: root, timeoutMs: 20_000 },
  )

  let additions = 0
  let deletions = 0
  let files = 0

  for (const line of numstat.stdout.split("\n")) {
    if (line.trim() === "") continue
    const [added, removed] = line.split("\t")
    files++
    // Binary files report "-" rather than a count.
    if (added !== "-") additions += Number(added) || 0
    if (removed !== "-") deletions += Number(removed) || 0
  }

  if (options.statOnly) {
    const stat = await git(["diff", "--stat", "-M", ...scope, ...pathArgs], {
      cwd: root,
      timeoutMs: 20_000,
    })
    return { patch: stat.stdout, files, additions, deletions, truncated: false }
  }

  const patch = await git(
    [
      "diff",
      "-M",
      `--unified=${options.context ?? 3}"`.replace('"', ""),
      // Binary patches are unreadable and enormous; the stat line is enough.
      "--no-textconv",
      ...scope,
      ...pathArgs,
    ],
    { cwd: root, timeoutMs: 30_000 },
  )

  const maxChars = options.maxChars ?? 60_000
  const truncated = patch.stdout.length > maxChars

  return {
    patch: truncated ? `${patch.stdout.slice(0, maxChars)}\n\n[diff truncated]` : patch.stdout,
    files,
    additions,
    deletions,
    truncated,
  }
}

/* ------------------------------------------------------------------ */
/* Log                                                                 */
/* ------------------------------------------------------------------ */

export interface Commit {
  readonly hash: string
  readonly shortHash: string
  readonly author: string
  readonly email: string
  readonly date: string
  readonly subject: string
  readonly body?: string
}

/**
 * Reads recent commits.
 *
 * A unit-separator delimited format is used rather than a JSON-ish one because
 * commit messages contain every character a naive format would break on —
 * quotation marks, newlines, and backslashes are all routine. `%x1f` and `%x1e`
 * cannot appear in a commit message, so the parse is unambiguous.
 */
export async function log2(options: {
  cwd: string
  limit?: number
  paths?: readonly string[]
  author?: string
  since?: string
  includeBody?: boolean
}): Promise<Commit[]> {
  const root = findRepositoryRoot(options.cwd) ?? options.cwd
  const format = options.includeBody
    ? "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e"
    : "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e"

  const args = ["log", `--format=${format}`, `--max-count=${options.limit ?? 20}`]
  if (options.author) args.push(`--author=${options.author}`)
  if (options.since) args.push(`--since=${options.since}`)
  if (options.paths && options.paths.length > 0) args.push("--", ...options.paths)

  const result = await git(args, { cwd: root, timeoutMs: 20_000 })
  if (!result.ok) return []

  const commits: Commit[] = []

  for (const record of result.stdout.split("\u001e")) {
    const trimmed = record.replace(/^\n/, "")
    if (trimmed.trim() === "") continue
    const fields = trimmed.split("\u001f")
    if (fields.length < 6) continue
    commits.push({
      hash: fields[0]!,
      shortHash: fields[1]!,
      author: fields[2]!,
      email: fields[3]!,
      date: fields[4]!,
      subject: fields[5]!,
      body: fields[6]?.trim() || undefined,
    })
  }

  return commits
}

/* ------------------------------------------------------------------ */
/* Context for the system prompt                                       */
/* ------------------------------------------------------------------ */

export interface GitContext {
  readonly root: string
  readonly branch: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  readonly changed: readonly string[]
  readonly untracked: readonly string[]
  readonly staged: readonly string[]
  readonly recentCommits: readonly string[]
  readonly operation?: string
  readonly conflicted: readonly string[]
  /** Convention inferred from recent subjects, e.g. "conventional commits". */
  readonly commitStyle?: string
}

/**
 * Gathers the git information injected into the system prompt.
 *
 * Deliberately compact. The full status of a repository with 400 modified files
 * would consume the context window, so lists are capped and only the parts that
 * change model behaviour are included:
 *
 *  - Branch name: often states the task (`fix/login-timeout`).
 *  - Changed files: what is already in flight, so the model does not redo it.
 *  - Recent commit subjects: teaches the project's message convention, which is
 *    what makes a generated commit message fit in.
 *  - In-progress operation: stops the model from committing mid-rebase.
 */
export async function context(cwd: string): Promise<GitContext | undefined> {
  const state = await status(cwd)
  if (!state) return undefined

  const commits = await log2({ cwd: state.root, limit: 10 })

  const changed = state.entries
    .filter((entry) => entry.unstaged && entry.status !== "untracked" && entry.status !== "ignored")
    .map((entry) => entry.path)

  const staged = state.entries.filter((entry) => entry.staged).map((entry) => entry.path)

  const untracked = state.entries
    .filter((entry) => entry.status === "untracked")
    .map((entry) => entry.path)

  return {
    root: state.root,
    branch: state.detached ? "(detached HEAD)" : (state.branch ?? "(unknown)"),
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    changed: changed.slice(0, 30),
    untracked: untracked.slice(0, 20),
    staged: staged.slice(0, 30),
    conflicted: state.entries.filter((entry) => entry.status === "conflicted").map((entry) => entry.path),
    recentCommits: commits.map((commit) => commit.subject),
    operation: state.operation,
    commitStyle: inferCommitStyle(commits.map((commit) => commit.subject)),
  }
}

/**
 * Infers the commit message convention from recent subjects.
 *
 * Cheap and effective: telling the model "this project uses conventional
 * commits" produces a fitting message, whereas leaving it to guess produces a
 * different style every time.
 */
export function inferCommitStyle(subjects: readonly string[]): string | undefined {
  if (subjects.length < 3) return undefined

  const conventional = subjects.filter((subject) =>
    /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?:\s/.test(subject),
  ).length

  if (conventional / subjects.length >= 0.5) {
    return "conventional commits (type(scope): summary)"
  }

  const ticketPrefixed = subjects.filter((subject) => /^[A-Z][A-Z0-9]+-\d+[: ]/.test(subject)).length
  if (ticketPrefixed / subjects.length >= 0.5) {
    return "ticket-prefixed (ABC-123: summary)"
  }

  const imperativeLower = subjects.filter((subject) => /^[a-z]/.test(subject)).length
  if (imperativeLower / subjects.length >= 0.7) {
    return "lowercase imperative summaries"
  }

  const capitalised = subjects.filter((subject) => /^[A-Z][a-z]/.test(subject)).length
  if (capitalised / subjects.length >= 0.7) {
    return "capitalised imperative summaries"
  }

  return undefined
}

/** Renders the git context for the prompt. */
export function renderContext(value: GitContext): string {
  const lines: string[] = [`Git branch: ${value.branch}`]

  if (value.upstream && (value.ahead > 0 || value.behind > 0)) {
    const parts: string[] = []
    if (value.ahead > 0) parts.push(`${value.ahead} ahead`)
    if (value.behind > 0) parts.push(`${value.behind} behind`)
    lines.push(`Relative to ${value.upstream}: ${parts.join(", ")}`)
  }

  if (value.operation) {
    lines.push(
      `A ${value.operation} is in progress. Do not commit, merge, or switch branches until it is resolved.`,
    )
  }

  if (value.conflicted.length > 0) {
    lines.push(`Conflicted files: ${value.conflicted.join(", ")}`)
  }

  if (value.staged.length > 0) {
    lines.push(`Staged: ${value.staged.slice(0, 15).join(", ")}`)
  }

  if (value.changed.length > 0) {
    lines.push(
      `Modified but not staged: ${value.changed.slice(0, 15).join(", ")}${
        value.changed.length > 15 ? ` and ${value.changed.length - 15} more` : ""
      }`,
    )
  }

  if (value.untracked.length > 0) {
    lines.push(
      `Untracked: ${value.untracked.slice(0, 10).join(", ")}${
        value.untracked.length > 10 ? ` and ${value.untracked.length - 10} more` : ""
      }`,
    )
  }

  if (value.recentCommits.length > 0) {
    lines.push(
      "Recent commits:",
      ...value.recentCommits.slice(0, 5).map((subject) => `  ${truncate(subject, 90)}`),
    )
  }

  if (value.commitStyle) {
    lines.push(`Commit message convention: ${value.commitStyle}`)
  }

  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* Blame and file history                                              */
/* ------------------------------------------------------------------ */

export interface BlameLine {
  readonly line: number
  readonly hash: string
  readonly author: string
  readonly date: string
  readonly summary: string
}

/**
 * Blames a range of lines.
 *
 * Restricted to a range on purpose: blaming a whole file produces one record per
 * line and is almost never what is wanted. The useful question is "who last
 * touched these ten lines and why", which is answered by the commit summaries.
 */
export async function blame(options: {
  cwd: string
  path: string
  startLine: number
  endLine: number
}): Promise<BlameLine[]> {
  const root = findRepositoryRoot(options.cwd) ?? options.cwd
  const result = await git(
    [
      "blame",
      "--line-porcelain",
      "-L",
      `${options.startLine},${options.endLine}`,
      "--",
      options.path,
    ],
    { cwd: root, timeoutMs: 20_000 },
  )

  if (!result.ok) return []

  const lines: BlameLine[] = []
  let current: Partial<BlameLine> = {}

  for (const line of result.stdout.split("\n")) {
    const headerMatch = /^([0-9a-f]{40})\s+\d+\s+(\d+)/.exec(line)
    if (headerMatch) {
      current = { hash: headerMatch[1]!.slice(0, 8), line: Number(headerMatch[2]) }
      continue
    }
    if (line.startsWith("author ")) current.author = line.slice(7)
    else if (line.startsWith("author-time ")) {
      current.date = new Date(Number(line.slice(12)) * 1000).toISOString().slice(0, 10)
    } else if (line.startsWith("summary ")) {
      current.summary = line.slice(8)
    } else if (line.startsWith("\t")) {
      // The content line ends a record.
      if (current.hash && current.line !== undefined) {
        lines.push({
          line: current.line,
          hash: current.hash,
          author: current.author ?? "unknown",
          date: current.date ?? "",
          summary: current.summary ?? "",
        })
      }
      current = {}
    }
  }

  return lines
}

/** Files most frequently changed together with the given file. */
export async function relatedFiles(options: {
  cwd: string
  path: string
  limit?: number
}): Promise<Array<{ path: string; count: number }>> {
  const root = findRepositoryRoot(options.cwd) ?? options.cwd

  // Commits that touched this file, then every file those commits touched. The
  // co-change signal is a surprisingly good proxy for "you probably also need to
  // edit this" — a schema and its migration, a component and its test.
  const result = await git(
    ["log", "--format=%H", "--max-count=40", "--name-only", "--", options.path],
    { cwd: root, timeoutMs: 20_000 },
  )

  if (!result.ok) return []

  const counts = new Map<string, number>()
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || /^[0-9a-f]{40}$/.test(trimmed)) continue
    if (trimmed === options.path) continue
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .filter((entry) => entry.count >= 2)
    .sort((left, right) => right.count - left.count)
    .slice(0, options.limit ?? 8)
}

/* ------------------------------------------------------------------ */
/* Convenience queries                                                 */
/* ------------------------------------------------------------------ */

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 5_000 })
  const value = result.stdout.trim()
  return result.ok && value !== "" && value !== "HEAD" ? value : undefined
}

export async function headCommit(cwd: string): Promise<string | undefined> {
  const result = await git(["rev-parse", "HEAD"], { cwd, timeoutMs: 5_000 })
  return result.ok ? result.stdout.trim() : undefined
}

/** Whether a path is ignored, using git's own rules. */
export async function isIgnored(cwd: string, path: string): Promise<boolean> {
  const result = await git(["check-ignore", "--quiet", "--", path], { cwd, timeoutMs: 5_000 })
  return result.code === 0
}

/** Tracked files, used to scope searches to what git knows about. */
export async function trackedFiles(cwd: string, limit = 5_000): Promise<string[]> {
  const result = await git(["ls-files", "-z"], { cwd, timeoutMs: 20_000 })
  if (!result.ok) return []
  return result.stdout.split("\u0000").filter(Boolean).slice(0, limit)
}

/** The default branch, resolved from the remote HEAD when possible. */
export async function defaultBranch(cwd: string): Promise<string> {
  const symbolic = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd, timeoutMs: 5_000 })
  if (symbolic.ok) {
    const value = symbolic.stdout.trim().split("/").pop()
    if (value) return value
  }

  for (const candidate of ["main", "master", "trunk", "develop"]) {
    const exists = await git(["rev-parse", "--verify", `refs/heads/${candidate}`], {
      cwd,
      timeoutMs: 5_000,
    })
    if (exists.ok) return candidate
  }

  return "main"
}

/** Remote URL, used for building share links to a commit or file. */
export async function remoteUrl(cwd: string): Promise<string | undefined> {
  const result = await git(["remote", "get-url", "origin"], { cwd, timeoutMs: 5_000 })
  if (!result.ok) return undefined
  return normalizeRemote(result.stdout.trim())
}

/**
 * Normalises a remote URL to an https form.
 *
 * SSH remotes (`git@github.com:owner/repo.git`) are the common case and are not
 * clickable, so they are rewritten. Used for links in exported transcripts.
 */
export function normalizeRemote(url: string): string {
  const ssh = /^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/](.+?)(?:\.git)?$/.exec(url)
  if (ssh && !url.startsWith("http")) {
    return `https://${ssh[1]}/${ssh[2]}`
  }
  return url.replace(/\.git$/, "")
}
