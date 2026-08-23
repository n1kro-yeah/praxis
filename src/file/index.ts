/**
 * The file index.
 *
 * Backs the `@` file picker, and exists because the obvious implementation \u2014
 * shell out to `find` on every keystroke \u2014 is unusable on a large repository. The
 * index is built once in the background, then queried in memory.
 *
 * Two things make the build tolerable on a repository with a hundred thousand
 * files. It yields to the event loop every couple of thousand entries, so the
 * interface stays responsive while it runs; and it never enters the directories
 * that hold the overwhelming majority of files in a typical project \u2014 `node_modules`,
 * `.git`, build output \u2014 which usually cuts the tree by an order of magnitude before
 * anything is read.
 *
 * Ranking is where the picker succeeds or fails. Fuzzy matching a path is easy;
 * ranking so that typing `index` surfaces `src/index.ts` rather than
 * `vendor/legacy/util/helpers/index.test.ts` takes several signals working
 * together, and getting the weights right matters more than the matcher itself.
 */

import { readdir, stat } from "node:fs/promises"
import { join, relative, sep, extname, basename, dirname } from "node:path"

import { logger } from "../util/log.js"
import { Bus } from "../util/bus.js"
import { fuzzyMatch } from "../util/fuzzy.js"
import { isIgnored, loadIgnores } from "./ignore.js"

const log = logger("file.index")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Entries held before the walk stops.
 *
 * A hundred thousand paths is roughly twenty megabytes of strings, which is
 * acceptable. Beyond that the picker stops being useful anyway \u2014 nobody finds a
 * file by scrolling through a hundred thousand of them.
 */
const MAX_ENTRIES = 100_000

/**
 * Directory depth limit.
 *
 * Guards against symlink cycles that the visited-inode check misses, and
 * against genuinely pathological trees. Real source lives well above this.
 */
const MAX_DEPTH = 24

/**
 * Entries walked between yields.
 *
 * Without this the walk blocks the event loop for seconds on a large tree and
 * the terminal stops responding to input. Two thousand is short enough that the
 * pause is imperceptible and long enough that the yielding overhead does not
 * dominate the walk.
 */
const YIELD_INTERVAL = 2_000

/** Results returned by default. */
const DEFAULT_LIMIT = 30

/** Recently opened paths remembered. */
const MAX_RECENT = 50

/**
 * Directories never entered.
 *
 * The single largest factor in how long a build takes. `node_modules` alone is
 * frequently more files than the entire rest of the repository.
 */
const SKIP_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".bzr",
  "node_modules", "bower_components", "jspm_packages", ".pnpm-store", ".yarn",
  "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "target", "vendor", "Pods", ".gradle", ".m2",
  "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".astro", ".output",
  ".turbo", ".cache", ".parcel-cache", ".vite",
  "coverage", ".nyc_output",
  ".terraform", ".serverless",
  ".idea", ".vscode-test", ".DS_Store",
])

/**
 * Extensions demoted in ranking.
 *
 * Not hidden \u2014 a lock file is occasionally what someone wants \u2014 but they should
 * never outrank source. These are files that match queries by accident: minified
 * bundles contain every identifier in the project, source maps are enormous, lock
 * files list every dependency name.
 */
const LOW_PRIORITY_EXTENSIONS = new Set([
  ".map", ".min.js", ".min.css", ".lock", ".sum",
  ".log", ".tmp", ".bak", ".swp", ".orig", ".rej",
  ".pyc", ".pyo", ".class", ".o", ".obj", ".a", ".so", ".dylib", ".dll",
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp4", ".mp3", ".wav", ".mov", ".avi", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
])

/** Filenames demoted for the same reason. */
const LOW_PRIORITY_NAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "Cargo.lock", "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock",
  "go.sum", "packages.lock.json", "pubspec.lock",
  ".DS_Store", "Thumbs.db", "desktop.ini",
])

/**
 * Directory names that mark test or generated code.
 *
 * A small demotion, not an exclusion. Tests are legitimate destinations; they
 * are simply less often what someone means when they type a bare module name.
 */
const DEMOTED_SEGMENTS = new Set([
  "test", "tests", "__tests__", "spec", "__mocks__", "fixtures", "testdata",
  "generated", "gen", "__generated__", "migrations", "snapshots", "__snapshots__",
  "examples", "example", "samples", "docs", "doc",
])

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface IndexEntry {
  /** Path relative to the root, always with forward slashes. */
  readonly path: string
  /** Filename with extension. */
  readonly name: string
  /** Filename without extension, which is what people usually type. */
  readonly stem: string
  /** Extension including the dot, or an empty string. */
  readonly extension: string
  /** Directory separators in the path. Used as a proximity signal. */
  readonly depth: number
  /** True for a directory. */
  readonly directory: boolean
  /** Precomputed lowercase path, so matching does not re-lowercase per query. */
  readonly lower: string
  /** Whether this entry is demoted for ranking. */
  readonly demoted: boolean
}

export interface QueryOptions {
  readonly limit?: number
  /** Restrict to directories, or to files. */
  readonly only?: "files" | "directories"
  /** Include entries git ignores. Off by default. */
  readonly includeIgnored?: boolean
  /** Restrict to these extensions, with the dot. */
  readonly extensions?: readonly string[]
}

export interface QueryResult {
  readonly entry: IndexEntry
  readonly score: number
  /** Character positions in the path that matched, for highlighting. */
  readonly positions: readonly number[]
}

export type IndexStatus = "empty" | "building" | "ready" | "truncated" | "failed"

/* ------------------------------------------------------------------ */
/* Index                                                               */
/* ------------------------------------------------------------------ */

/**
 * An in-memory index of one project tree.
 *
 * One instance per root. The generation counter guards against a stale build
 * overwriting a newer one: if the tree is invalidated while a walk is in progress,
 * that walk's results are discarded when it finishes rather than replacing what
 * the newer walk has already produced.
 */
export class FileIndex {
  private entries: IndexEntry[] = []
  private status: IndexStatus = "empty"
  private generation = 0
  private building?: Promise<void>
  private recent: string[] = []
  private builtAt = 0
  private walked = 0

  constructor(private readonly root: string) {}

  /* ---------------------------------------------------------------- */
  /* Building                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Builds or rebuilds the index.
   *
   * Concurrent calls share one walk rather than starting a second. Without
   * that, a burst of file-change events at startup would launch a dozen
   * simultaneous walks of the same tree.
   */
  async build(): Promise<void> {
    if (this.building) return this.building

    const generation = ++this.generation

    this.status = "building"
    this.building = this.walk(generation).finally(() => {
      this.building = undefined
    })

    return this.building
  }

  /** Discards the index and rebuilds in the background. */
  invalidate(): void {
    this.generation++
    this.status = "empty"

    void this.build()
  }

  /** Builds if there is nothing usable, otherwise returns immediately. */
  async ensure(): Promise<void> {
    if (this.status === "ready" || this.status === "truncated") return

    await this.build()
  }

  private async walk(generation: number): Promise<void> {
    const started = Date.now()
    const collected: IndexEntry[] = []

    // Inode identity rather than path, so a symlink pointing at an ancestor is
    // caught even when the paths look unrelated.
    const visited = new Set<string>()

    let walked = 0
    let truncated = false

    try {
      await loadIgnores(this.root)
    } catch (error) {
      // A missing or malformed .gitignore should not stop the walk; it just
      // means more entries get indexed than strictly wanted.
      log.debug("could not load ignore rules", { error: String(error) })
    }

    const descend = async (directory: string, depth: number): Promise<void> => {
      if (truncated) return
      if (depth > MAX_DEPTH) return
      if (generation !== this.generation) return

      let listing: Awaited<ReturnType<typeof readdir>>

      try {
        listing = await readdir(directory, { withFileTypes: true })
      } catch {
        // Permission denied, or the directory vanished mid-walk. Both are
        // routine on a live filesystem.
        return
      }

      // Files before directories, so a shallow file is indexed before the walk
      // descends. This matters when the entry cap is hit: what survives is the
      // top of the tree, which is what people search for.
      const files = listing.filter((item) => !item.isDirectory())
      const directories = listing.filter((item) => item.isDirectory())

      for (const item of files) {
        if (collected.length >= MAX_ENTRIES) {
          truncated = true
          return
        }

        if (++walked % YIELD_INTERVAL === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve))

          if (generation !== this.generation) return
        }

        const full = join(directory, item.name)
        const rel = toPosix(relative(this.root, full))

        if (rel === "" || rel.startsWith("..")) continue
        if (isIgnored(rel, false)) continue

        collected.push(makeEntry(rel, false))
      }

      for (const item of directories) {
        if (truncated) return
        if (SKIP_DIRECTORIES.has(item.name)) continue

        const full = join(directory, item.name)
        const rel = toPosix(relative(this.root, full))

        if (rel === "" || rel.startsWith("..")) continue
        if (isIgnored(rel, true)) continue

        // Symlinked directories are the one place a walk can loop forever.
        // Resolving identity costs a stat per directory, which is affordable
        // because directories are a small fraction of the entries.
        if (item.isSymbolicLink()) {
          try {
            const info = await stat(full)

            if (!info.isDirectory()) continue

            const identity = `${info.dev}:${info.ino}`

            if (visited.has(identity)) continue

            visited.add(identity)
          } catch {
            continue
          }
        }

        if (collected.length < MAX_ENTRIES) collected.push(makeEntry(rel, true))

        await descend(full, depth + 1)
      }
    }

    try {
      await descend(this.root, 0)
    } catch (error) {
      log.error("the file walk failed", { root: this.root, error: String(error) })

      if (generation === this.generation) this.status = "failed"

      return
    }

    // A newer build started while this one ran. Its results are more current,
    // so throw these away rather than overwriting.
    if (generation !== this.generation) {
      log.debug("discarding a superseded index build", { generation })
      return
    }

    this.entries = collected
    this.walked = walked
    this.builtAt = Date.now()
    this.status = truncated ? "truncated" : "ready"

    const elapsed = Date.now() - started

    log.info("built the file index", {
      root: this.root,
      entries: collected.length,
      walked,
      ms: elapsed,
      truncated,
    })

    Bus.publish("fileIndexBuilt", {
      root: this.root,
      entries: collected.length,
      truncated,
      durationMs: elapsed,
    })
  }

  /* ---------------------------------------------------------------- */
  /* Querying                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Finds entries matching a query.
   *
   * An empty query returns recently used paths rather than nothing, because the
   * picker opens before anything is typed and an empty list at that moment is
   * both unhelpful and slightly alarming.
   */
  query(query: string, options: QueryOptions = {}): QueryResult[] {
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT)
    const trimmed = query.trim()

    if (trimmed === "") return this.recentResults(limit, options)

    const results: QueryResult[] = []

    for (const entry of this.entries) {
      if (options.only === "files" && entry.directory) continue
      if (options.only === "directories" && !entry.directory) continue

      if (options.extensions && !options.extensions.includes(entry.extension)) continue

      const scored = this.rank(entry, trimmed)

      if (scored) results.push(scored)
    }

    // Sort by score, then shortest path, then alphabetically. The tiebreakers
    // matter more than they look: without them, results reorder between
    // keystrokes that do not change the ranking, which reads as flicker.
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length

      return a.entry.path < b.entry.path ? -1 : 1
    })

    return results.slice(0, limit)
  }

  /**
   * Scores one entry against a query.
   *
   * The filename is matched separately from the full path and weighted far more
   * heavily. This single decision is most of what makes the picker usable: people
   * type filenames, not paths, and a raw path match ranks
   * `packages/index-utils/src/thing.ts` above `src/index.ts` for the query
   * `index` because the path happens to contain the letters more times.
   */
  private rank(entry: IndexEntry, query: string): QueryResult | undefined {
    const lowered = query.toLowerCase()

    // A query containing a slash is a path fragment, so match the path directly
    // and skip the filename weighting entirely.
    if (lowered.includes("/")) {
      const match = fuzzyMatch(lowered, entry.lower)

      if (!match) return undefined

      return {
        entry,
        score: match.score + this.contextBonus(entry),
        positions: match.positions,
      }
    }

    const nameMatch = fuzzyMatch(lowered, entry.name.toLowerCase())
    const pathMatch = fuzzyMatch(lowered, entry.lower)

    if (!nameMatch && !pathMatch) return undefined

    let score = 0
    let positions: readonly number[] = []

    if (nameMatch) {
      // Weighted heavily, and the positions are shifted into path coordinates
      // so the highlighting lines up with what is displayed.
      score = nameMatch.score * 60

      const offset = entry.path.length - entry.name.length

      positions = nameMatch.positions.map((position) => position + offset)

      const stem = entry.stem.toLowerCase()
      const name = entry.name.toLowerCase()

      // Exact matches are almost always the intent, and deserve a bonus large
      // enough that no amount of fuzzy scoring elsewhere overtakes them.
      if (stem === lowered) score += 200
      else if (name === lowered) score += 180
      else if (stem.startsWith(lowered)) score += 80
      else if (name.startsWith(lowered)) score += 60
    } else if (pathMatch) {
      score = pathMatch.score
      positions = pathMatch.positions
    }

    return { entry, score: score + this.contextBonus(entry), positions }
  }

  /**
   * Adjustments independent of the query.
   *
   * Shallow beats deep, source beats generated, and anything opened recently
   * beats everything \u2014 the strongest predictor of the next file someone wants is
   * the last one they wanted.
   */
  private contextBonus(entry: IndexEntry): number {
    let bonus = 0

    // Four points per level. Enough to separate `src/index.ts` from
    // `src/a/b/c/index.ts`, not enough to override an exact filename match.
    bonus -= entry.depth * 4

    if (entry.demoted) bonus -= 40
    if (entry.directory) bonus -= 10

    const recentIndex = this.recent.indexOf(entry.path)

    // Decays with position, so the last file opened outranks the one before it.
    if (recentIndex >= 0) bonus += 150 - recentIndex * 3

    return bonus
  }

  /** Recently used entries, for an empty query. */
  private recentResults(limit: number, options: QueryOptions): QueryResult[] {
    const results: QueryResult[] = []
    const byPath = new Map(this.entries.map((entry) => [entry.path, entry]))

    for (const path of this.recent) {
      if (results.length >= limit) break

      const entry = byPath.get(path)

      if (!entry) continue
      if (options.only === "files" && entry.directory) continue
      if (options.only === "directories" && !entry.directory) continue

      results.push({ entry, score: 1000 - results.length, positions: [] })
    }

    // Pad with shallow source files so the picker is never empty on a fresh
    // session, where nothing has been opened yet.
    if (results.length < limit) {
      const seen = new Set(results.map((result) => result.entry.path))

      const filler = this.entries
        .filter((entry) => !entry.directory && !entry.demoted && !seen.has(entry.path))
        .sort((a, b) => a.depth - b.depth || a.path.length - b.path.length)
        .slice(0, limit - results.length)

      for (const entry of filler) {
        results.push({ entry, score: 0, positions: [] })
      }
    }

    return results
  }

  /* ---------------------------------------------------------------- */
  /* Recency                                                           */
  /* ---------------------------------------------------------------- */

  /** Records that a path was used, moving it to the front of the recency list. */
  touch(path: string): void {
    const normalised = toPosix(path.startsWith(this.root) ? relative(this.root, path) : path)

    if (normalised === "" || normalised.startsWith("..")) return

    const existing = this.recent.indexOf(normalised)

    if (existing >= 0) this.recent.splice(existing, 1)

    this.recent.unshift(normalised)

    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT
  }

  /** The recency list, most recent first. */
  recentPaths(): readonly string[] {
    return this.recent
  }

  /* ---------------------------------------------------------------- */
  /* Access                                                            */
  /* ---------------------------------------------------------------- */

  /** Exact lookup by relative path. */
  get(path: string): IndexEntry | undefined {
    const normalised = toPosix(path)

    return this.entries.find((entry) => entry.path === normalised)
  }

  /** Whether a path is in the index. */
  has(path: string): boolean {
    return this.get(path) !== undefined
  }

  /** Everything indexed. */
  all(): readonly IndexEntry[] {
    return this.entries
  }

  /** Entries directly inside a directory. */
  children(directory: string): IndexEntry[] {
    const prefix = directory === "" || directory === "." ? "" : `${toPosix(directory)}/`

    return this.entries.filter((entry) => {
      if (!entry.path.startsWith(prefix)) return false

      // Direct children only: nothing after the prefix may contain a slash.
      return !entry.path.slice(prefix.length).includes("/")
    })
  }

  /** Files with a given extension. */
  byExtension(extension: string): IndexEntry[] {
    const normalised = extension.startsWith(".") ? extension : `.${extension}`

    return this.entries.filter((entry) => entry.extension === normalised)
  }

  /**
   * Adds a path discovered after the build.
   *
   * Called by the file watcher. Cheaper than rebuilding, and keeps a
   * just-created file findable immediately, which is what someone expects after
   * the agent has written it.
   */
  add(path: string, directory = false): void {
    const normalised = toPosix(path)

    if (normalised === "" || this.has(normalised)) return
    if (this.entries.length >= MAX_ENTRIES) return

    this.entries.push(makeEntry(normalised, directory))
  }

  /** Removes a deleted path. */
  remove(path: string): void {
    const normalised = toPosix(path)
    const index = this.entries.findIndex((entry) => entry.path === normalised)

    if (index >= 0) this.entries.splice(index, 1)

    const recentIndex = this.recent.indexOf(normalised)

    if (recentIndex >= 0) this.recent.splice(recentIndex, 1)
  }

  /* ---------------------------------------------------------------- */
  /* Introspection                                                     */
  /* ---------------------------------------------------------------- */

  get state(): IndexStatus {
    return this.status
  }

  get size(): number {
    return this.entries.length
  }

  stats(): {
    root: string
    status: IndexStatus
    entries: number
    files: number
    directories: number
    walked: number
    ageMs: number
  } {
    let directories = 0

    for (const entry of this.entries) {
      if (entry.directory) directories++
    }

    return {
      root: this.root,
      status: this.status,
      entries: this.entries.length,
      files: this.entries.length - directories,
      directories,
      walked: this.walked,
      ageMs: this.builtAt === 0 ? 0 : Date.now() - this.builtAt,
    }
  }
}

/* ------------------------------------------------------------------ */
/* Entry construction                                                  */
/* ------------------------------------------------------------------ */

function makeEntry(path: string, directory: boolean): IndexEntry {
  const name = basename(path)
  const extension = directory ? "" : extname(name)
  const stem = extension === "" ? name : name.slice(0, -extension.length)

  return {
    path,
    name,
    stem,
    extension,
    depth: countSlashes(path),
    directory,
    lower: path.toLowerCase(),
    demoted: isDemoted(path, name, extension),
  }
}

function isDemoted(path: string, name: string, extension: string): boolean {
  if (LOW_PRIORITY_NAMES.has(name)) return true
  if (LOW_PRIORITY_EXTENSIONS.has(extension)) return true

  // Compound extensions such as `.min.js` are not what extname returns, so
  // check the tail of the name separately.
  if (name.endsWith(".min.js") || name.endsWith(".min.css") || name.endsWith(".d.ts")) return true

  for (const segment of path.split("/")) {
    if (DEMOTED_SEGMENTS.has(segment)) return true
  }

  return false
}

function countSlashes(path: string): number {
  let count = 0

  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 47) count++
  }

  return count
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const indexes = new Map<string, FileIndex>()

/**
 * The index for a root, created on first use.
 *
 * The build is started but not awaited. Callers that need results immediately
 * await `ensure()`; the picker does not, because showing an empty list that fills
 * in is better than blocking the interface until the walk finishes.
 */
export function fileIndex(root: string): FileIndex {
  const existing = indexes.get(root)

  if (existing) return existing

  const created = new FileIndex(root)

  indexes.set(root, created)

  void created.build()

  return created
}

export function clearFileIndexes(): void {
  indexes.clear()
}

/* ------------------------------------------------------------------ */
/* Reference resolution                                                */
/* ------------------------------------------------------------------ */

export interface FileReference {
  /** The text as typed, without the leading `@`. */
  readonly raw: string
  /** The resolved relative path, when one was found. */
  readonly path?: string
  /** Where in the message it appeared. */
  readonly start: number
  readonly end: number
}

/**
 * Finds `@path` references in a message.
 *
 * The terminating character set is the awkward part. A path can contain almost
 * anything, but a reference at the end of a sentence should not swallow the full
 * stop \u2014 while `@src/v1.2/thing.ts` legitimately contains dots. The compromise:
 * stop at whitespace, and strip trailing punctuation only when it is the last
 * character.
 */
export function findReferences(message: string): FileReference[] {
  const references: FileReference[] = []
  const pattern = /(^|\s)@([^\s]+)/g

  let match: RegExpExecArray | null

  while ((match = pattern.exec(message)) !== null) {
    let raw = match[2] ?? ""

    const start = match.index + match[1]!.length

    // An email address is not a file reference.
    if (raw.includes("@")) continue

    let trailing = 0

    while (raw.length > 1 && /[.,;:!?)\]}]$/.test(raw)) {
      raw = raw.slice(0, -1)
      trailing++
    }

    if (raw === "") continue

    references.push({ raw, start, end: start + 1 + raw.length + trailing - trailing })
  }

  return references
}

/**
 * Resolves a reference against the index.
 *
 * Tries exact match first, then a unique suffix match, then the best fuzzy
 * result. The suffix step is what makes `@session.ts` work when the file is at
 * `src/session/session.ts`, which is how people naturally refer to it.
 */
export function resolveReference(index: FileIndex, raw: string): string | undefined {
  const normalised = toPosix(raw.replace(/^\.\//, ""))

  if (index.has(normalised)) return normalised

  const suffix = index
    .all()
    .filter((entry) => !entry.directory && (entry.path === normalised || entry.path.endsWith(`/${normalised}`)))

  if (suffix.length === 1) return suffix[0]!.path

  // Several matches: prefer the shallowest, which is nearly always the one
  // meant when a name is ambiguous.
  if (suffix.length > 1) {
    return [...suffix].sort((a, b) => a.depth - b.depth || a.path.length - b.path.length)[0]!.path
  }

  const fuzzy = index.query(normalised, { limit: 1, only: "files" })

  return fuzzy[0]?.entry.path
}

/**
 * Groups paths by directory for display.
 *
 * Used by the picker when results span several directories, where a flat list
 * of full paths is far harder to scan than a grouped one.
 */
export function groupByDirectory(results: readonly QueryResult[]): Array<{ directory: string; entries: QueryResult[] }> {
  const groups = new Map<string, QueryResult[]>()

  for (const result of results) {
    const directory = dirname(result.entry.path)
    const key = directory === "." ? "" : directory

    const existing = groups.get(key)

    if (existing) existing.push(result)
    else groups.set(key, [result])
  }

  // Order groups by their best result, so the strongest match stays at the top
  // regardless of which directory it is in.
  return [...groups.entries()]
    .map(([directory, entries]) => ({ directory, entries }))
    .sort((a, b) => (b.entries[0]?.score ?? 0) - (a.entries[0]?.score ?? 0))
}
