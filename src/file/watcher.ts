/**
 * File watching.
 *
 * The agent needs to know when files change underneath it. Two reasons, and they
 * pull in different directions.
 *
 * The first is correctness. The model read a file at step three and wants to edit
 * it at step nine. If the user changed it in between, the edit is being applied to
 * a version that no longer exists, and applying it silently corrupts their work.
 * The staleness check in the edit layer needs to know.
 *
 * The second is context. When the user saves a file the agent is working on, that
 * is a signal \u2014 often they have fixed something by hand, or moved the goalposts.
 * Mentioning it in the conversation is usually helpful.
 *
 * The tension is volume. A `git checkout` touches thousands of files in a second.
 * A build writes a whole `dist/` directory. Reporting all of that would flood the
 * conversation with noise and cost real money in tokens. So the watcher is
 * aggressive about filtering: ignored paths never reach the event layer, bursts
 * are coalesced, and a burst above a threshold is reported as a single summary
 * rather than as individual files.
 *
 * Recursive watching is not available everywhere. macOS and Windows support it
 * natively; Linux does not, and the fallback \u2014 one inotify watch per directory \u2014
 * exhausts the default watch limit on any large repository. So on Linux the
 * watcher is scoped to directories that have actually been read, which covers the
 * staleness case exactly and gives up on noticing changes to files nobody has
 * looked at.
 */

import { watch, type FSWatcher, existsSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { platform } from "node:os"

import { Bus } from "../util/bus.js"
import { logger } from "../util/log.js"
import { isIgnored } from "./ignore.js"

const log = logger("file.watcher")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Events within this window are coalesced. */
const DEBOUNCE_MS = 100

/**
 * Above this many files in one burst, a summary is emitted instead of
 * individual events.
 *
 * Twenty. A refactor across fifteen files is worth listing; a checkout across
 * eight hundred is not, and the distinction is roughly here.
 */
const BURST_THRESHOLD = 20

/** Directories watched at once, on platforms without recursive watching. */
const MAX_WATCHED_DIRECTORIES = 256

/**
 * Directories never watched, whatever the ignore rules say.
 *
 * These generate continuous churn during normal work and never contain anything
 * the agent should react to.
 */
const NEVER_WATCH = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".gradle",
  ".idea",
  ".vscode",
  "vendor",
  ".terraform",
])

/**
 * Filename patterns that are editor noise.
 *
 * A save from vim produces `.file.swp`, `4913`, and `file~` before it produces
 * `file`. Reporting those as changes is wrong on its face.
 */
const NOISE_PATTERNS = [
  /^\.#/, // emacs lock files
  /~$/, // backup files
  /\.swp$/,
  /\.swx$/,
  /^\d{4}$/, // vim's write-test file
  /^\.goutputstream/,
  /\.tmp$/,
  /\.crdownload$/,
  /^\.DS_Store$/,
]

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type FileChangeKind = "created" | "modified" | "deleted"

export interface FileChange {
  readonly path: string
  readonly kind: FileChangeKind
  readonly at: number
}

export interface WatcherOptions {
  readonly cwd: string
  /** Called with a coalesced batch of changes. */
  readonly onChange?: (changes: FileChange[]) => void
  /** Called when a burst exceeds the threshold. */
  readonly onBurst?: (count: number, sample: string[]) => void
  readonly debounceMs?: number
  /** Forces the per-directory strategy, for testing. */
  readonly forceNonRecursive?: boolean
}

/* ------------------------------------------------------------------ */
/* Watcher                                                             */
/* ------------------------------------------------------------------ */

export class FileWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly pending = new Map<string, FileChangeKind>()
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private readonly recursive: boolean
  private readonly debounceMs: number

  /**
   * Last known modification times.
   *
   * Used to distinguish creation from modification, and to drop events where the
   * time has not moved \u2014 which happens constantly, because a rename fires an
   * event for both the old and the new name.
   */
  private readonly times = new Map<string, number>()

  constructor(private readonly options: WatcherOptions) {
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS

    const os = platform()
    this.recursive = !options.forceNonRecursive && (os === "darwin" || os === "win32")
  }

  /**
   * Starts watching.
   *
   * On a platform with recursive watching this is one watch on the project root.
   * Elsewhere it is nothing until directories are registered by the read path,
   * because watching a whole repository directory by directory is how you exhaust
   * the inotify limit and break watching for every other program on the machine.
   */
  start(): void {
    if (this.closed) return

    if (this.recursive) {
      this.watchDirectory(this.options.cwd, true)
      log.info("watching recursively", { cwd: this.options.cwd })
      return
    }

    log.info("recursive watching is unavailable; watching directories as they are read", {
      cwd: this.options.cwd,
    })
  }

  /**
   * Registers interest in a path.
   *
   * Called by the read path. On a recursive platform this is free; elsewhere it
   * adds a watch on the containing directory, which is precisely the set of
   * directories where staleness matters.
   */
  track(path: string): void {
    if (this.closed) return

    const absolute = resolve(this.options.cwd, path)

    try {
      const stats = statSync(absolute)
      this.times.set(absolute, stats.mtimeMs)
    } catch {
      // A file that does not exist yet is still worth tracking: the model may be
      // about to create it, and the creation event matters.
    }

    if (this.recursive) return

    this.watchDirectory(dirname(absolute), false)
  }

  private watchDirectory(directory: string, recursive: boolean): void {
    if (this.watchers.has(directory)) return
    if (!existsSync(directory)) return

    if (this.watchers.size >= MAX_WATCHED_DIRECTORIES) {
      // Rather than failing, the oldest watch is dropped. Recency is a good
      // proxy for relevance here: the directory read forty files ago matters
      // less than the one read just now.
      const oldest = this.watchers.keys().next().value

      if (oldest) {
        this.watchers.get(oldest)?.close()
        this.watchers.delete(oldest)
      }
    }

    try {
      const watcher = watch(directory, { persistent: false, recursive }, (event, filename) => {
        if (filename === null) return

        // On a recursive watch the filename is relative to the watched root.
        const path = join(directory, filename.toString())

        this.handle(path, event === "rename" ? undefined : "modified")
      })

      watcher.on("error", (error) => {
        log.debug("a directory watch failed", { directory, error: String(error) })

        watcher.close()
        this.watchers.delete(directory)
      })

      this.watchers.set(directory, watcher)
    } catch (error) {
      log.debug("could not watch a directory", { directory, error: String(error) })
    }
  }

  /**
   * Processes one raw event.
   *
   * Filtering happens here, before anything is queued, so that a noisy build does
   * not fill the pending map with entries that will be discarded later.
   */
  private handle(path: string, kind: FileChangeKind | undefined): void {
    if (this.closed) return

    const absolute = resolve(path)

    if (this.shouldIgnore(absolute)) return

    // `rename` covers creation, deletion, and atomic replacement. Which one it
    // was can only be determined by looking.
    let resolved: FileChangeKind

    if (kind) {
      resolved = kind
    } else if (existsSync(absolute)) {
      resolved = this.times.has(absolute) ? "modified" : "created"
    } else {
      resolved = "deleted"
    }

    if (resolved === "deleted") {
      this.times.delete(absolute)
    } else {
      try {
        const stats = statSync(absolute)

        // Directories are not reported. Their contents are, which is what
        // anybody actually cares about.
        if (stats.isDirectory()) {
          if (!this.recursive) this.watchDirectory(absolute, false)
          return
        }

        const previous = this.times.get(absolute)

        // The same modification time means nothing changed. This drops the
        // duplicate event from a rename and the chmod that follows a write.
        if (previous !== undefined && previous === stats.mtimeMs) return

        this.times.set(absolute, stats.mtimeMs)
      } catch {
        return
      }
    }

    this.pending.set(absolute, resolved)
    this.schedule()
  }

  private shouldIgnore(absolute: string): boolean {
    const relativePath = relative(this.options.cwd, absolute)

    // Outside the project entirely.
    if (relativePath.startsWith("..")) return true

    const segments = relativePath.split(sep)

    for (const segment of segments) {
      if (NEVER_WATCH.has(segment)) return true
    }

    const filename = segments[segments.length - 1] ?? ""

    for (const pattern of NOISE_PATTERNS) {
      if (pattern.test(filename)) return true
    }

    return isIgnored(this.options.cwd, relativePath)
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)

    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.debounceMs)

    this.timer.unref?.()
  }

  /**
   * Emits the coalesced batch.
   *
   * A batch above the burst threshold is reported as a count with a sample. The
   * caller decides what to do with that \u2014 typically a short note rather than a
   * list, because a hundred file paths in the conversation is a hundred file paths
   * the model has to read past.
   */
  private flush(): void {
    if (this.pending.size === 0) return

    const changes: FileChange[] = []
    const at = Date.now()

    for (const [path, kind] of this.pending) {
      changes.push({ path, kind, at })
    }

    this.pending.clear()

    if (changes.length >= BURST_THRESHOLD) {
      const sample = changes.slice(0, 5).map((change) => change.path)

      log.info("a large number of files changed at once", {
        count: changes.length,
        sample,
      })

      this.options.onBurst?.(changes.length, sample)

      Bus.publish("filesBurstChanged", { count: changes.length, sample })

      return
    }

    for (const change of changes) {
      Bus.publish("fileChanged", {
        path: change.path,
        kind: change.kind,
      })
    }

    this.options.onChange?.(changes)
  }

  /** The recorded modification time for a path, if any. */
  timeOf(path: string): number | undefined {
    return this.times.get(resolve(this.options.cwd, path))
  }

  /** Number of active directory watches, for diagnostics. */
  get watchCount(): number {
    return this.watchers.size
  }

  get isRecursive(): boolean {
    return this.recursive
  }

  close(): void {
    this.closed = true

    if (this.timer) clearTimeout(this.timer)

    for (const watcher of this.watchers.values()) {
      try {
        watcher.close()
      } catch {
        // Closing a watcher whose directory has been deleted throws on some
        // platforms. Nothing useful to do about it at shutdown.
      }
    }

    this.watchers.clear()
    this.pending.clear()
    this.times.clear()
  }
}

/* ------------------------------------------------------------------ */
/* Singleton                                                           */
/* ------------------------------------------------------------------ */

let instance: FileWatcher | undefined

/**
 * The watcher for a project.
 *
 * One per process. A second watcher on the same tree would double the inotify
 * cost for no benefit, and the tracking map is global state anyway.
 */
export function fileWatcher(options?: WatcherOptions): FileWatcher | undefined {
  if (!instance && options) {
    instance = new FileWatcher(options)
    instance.start()
  }

  return instance
}

export function closeFileWatcher(): void {
  instance?.close()
  instance = undefined
}

/**
 * Registers interest in a path with the shared watcher.
 *
 * A no-op when no watcher is running, so the read path can call it
 * unconditionally.
 */
export function trackFile(path: string): void {
  instance?.track(path)
}

/* ------------------------------------------------------------------ */
/* Change reporting                                                    */
/* ------------------------------------------------------------------ */

/**
 * A line describing external changes, for injection into the conversation.
 *
 * Only files the model has already read are mentioned. A change to a file it has
 * never seen is not information it can use, and saying so invites it to go and
 * read the file, which is the opposite of helpful.
 */
export function describeChanges(changes: FileChange[], readPaths: Set<string>): string | undefined {
  const relevant = changes.filter((change) => readPaths.has(change.path))

  if (relevant.length === 0) return undefined

  const lines: string[] = []

  const created = relevant.filter((change) => change.kind === "created")
  const modified = relevant.filter((change) => change.kind === "modified")
  const deleted = relevant.filter((change) => change.kind === "deleted")

  if (modified.length > 0) {
    lines.push(
      `These files were changed outside this session and the copies you read are out of date: ${modified
        .map((change) => change.path)
        .join(", ")}`,
    )
  }

  if (deleted.length > 0) {
    lines.push(`These files were deleted: ${deleted.map((change) => change.path).join(", ")}`)
  }

  if (created.length > 0) {
    lines.push(`These files were created: ${created.map((change) => change.path).join(", ")}`)
  }

  return lines.join("\n")
}
