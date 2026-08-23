/**
 * Configuration reloading.
 *
 * Configuration lives in seven places, and editing any of them should take effect
 * without a restart. Restarting means losing the conversation, which is a
 * disproportionate cost for changing a theme.
 *
 * The parts that are not obvious:
 *
 *  - **Editors do not modify files, they replace them.** A save from vim is a
 *    write to a temporary file followed by a rename. Watching the inode misses the
 *    change entirely, so the watch is on the directory and the filename is
 *    filtered there.
 *  - **One save fires several events.** Write, chmod, rename \u2014 three notifications
 *    for one logical change. Reloading three times is wasteful and, worse, can
 *    read the file mid-write. Everything is debounced.
 *  - **A broken file must not take the running one down.** Someone editing JSON
 *    will pass through invalid states on the way to a valid one. Reload validates
 *    first and keeps the last good configuration if parsing fails, reporting the
 *    error rather than applying it.
 *  - **Not every change can be applied live.** A theme can. A different storage
 *    directory cannot, because the database is already open against the old one.
 *    Changes are classified and the ones needing a restart are reported instead of
 *    half-applied.
 */

import { watch, type FSWatcher, existsSync } from "node:fs"
import { dirname, basename, resolve } from "node:path"

import { Bus } from "../util/bus.js"
import { logger } from "../util/log.js"

const log = logger("config.watch")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Debounce window.
 *
 * 120 ms. Long enough to coalesce the burst an editor produces, short enough that
 * a deliberate save feels immediate.
 */
const DEBOUNCE_MS = 120

/**
 * Delay before reading after the last event.
 *
 * A rename can be observed before the new file is fully flushed, and reading in
 * that window gives a truncated file that fails to parse. The extra pause is
 * cheaper than a spurious error message.
 */
const SETTLE_MS = 40

/** How long to keep retrying a watch on a directory that does not exist yet. */
const RETRY_INTERVAL_MS = 5_000

/* ------------------------------------------------------------------ */
/* Change classification                                               */
/* ------------------------------------------------------------------ */

/**
 * Settings that cannot change without a restart.
 *
 * Each of these is captured by something at startup: a database handle, a
 * directory path, a server socket. Changing the value in the file does not change
 * the thing already holding it, and pretending otherwise produces a process whose
 * behaviour does not match its configuration.
 */
const RESTART_REQUIRED = new Set([
  "storage.path",
  "storage.directory",
  "server.port",
  "server.hostname",
  "experimental.worker",
  "data.directory",
])

/**
 * Settings that need a component restarted but not the process.
 *
 * Reported separately so the reload can restart just that component. Restarting
 * every language server because someone changed a theme colour would be absurd.
 */
const RELOAD_COMPONENT: Record<string, string> = {
  "lsp": "lsp",
  "mcp": "mcp",
  "plugin": "plugin",
  "provider": "provider",
  "agent": "agent",
  "command": "command",
  "permission": "permission",
}

export interface ConfigChange {
  /** Dotted path of the setting. */
  readonly path: string
  readonly before: unknown
  readonly after: unknown
}

export interface ChangeAnalysis {
  readonly changes: ConfigChange[]
  /** Settings that were changed but cannot be applied without a restart. */
  readonly restartRequired: string[]
  /** Components that need reloading. */
  readonly components: string[]
  /** Whether anything changed at all. */
  readonly changed: boolean
}

/**
 * Compares two configurations and classifies what changed.
 *
 * Recursive, producing dotted paths, because "the configuration changed" is not
 * actionable and "theme changed from nord to gruvbox" is.
 */
export function analyseChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChangeAnalysis {
  const changes: ConfigChange[] = []

  collectChanges(before, after, "", changes)

  const restartRequired: string[] = []
  const components = new Set<string>()

  for (const change of changes) {
    if (RESTART_REQUIRED.has(change.path)) {
      restartRequired.push(change.path)
      continue
    }

    const root = change.path.split(".")[0]!
    const component = RELOAD_COMPONENT[root]

    if (component) components.add(component)
  }

  return {
    changes,
    restartRequired,
    components: [...components],
    changed: changes.length > 0,
  }
}

function collectChanges(
  before: unknown,
  after: unknown,
  path: string,
  out: ConfigChange[],
): void {
  if (before === after) return

  const bothObjects =
    typeof before === "object" &&
    typeof after === "object" &&
    before !== null &&
    after !== null &&
    !Array.isArray(before) &&
    !Array.isArray(after)

  if (!bothObjects) {
    // Arrays are compared whole. Reporting "element 3 changed" for a reordered
    // list is noise; what matters is that the list is different.
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      out.push({ path: path || "(root)", before, after })
    }

    return
  }

  const keys = new Set([
    ...Object.keys(before as Record<string, unknown>),
    ...Object.keys(after as Record<string, unknown>),
  ])

  for (const key of keys) {
    collectChanges(
      (before as Record<string, unknown>)[key],
      (after as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
      out,
    )
  }
}

/* ------------------------------------------------------------------ */
/* Watching                                                            */
/* ------------------------------------------------------------------ */

interface WatchEntry {
  readonly path: string
  watcher?: FSWatcher
  retry?: NodeJS.Timeout
}

export interface WatcherOptions {
  /** Files to watch. Missing files are watched for creation. */
  readonly paths: string[]
  /** Called after the debounce, with the paths that changed. */
  readonly onChange: (paths: string[]) => void | Promise<void>
  readonly debounceMs?: number
}

/**
 * Watches configuration files.
 *
 * Watching a file that does not exist is supported and matters: someone creating
 * `praxis.json` for the first time should not have to restart for it to be noticed.
 * The directory is watched and the filename filtered, which handles creation,
 * deletion, and atomic replacement with the same mechanism.
 */
export class ConfigWatcher {
  private readonly entries: WatchEntry[] = []
  private readonly pending = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private readonly debounceMs: number

  constructor(private readonly options: WatcherOptions) {
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS

    for (const path of options.paths) {
      this.entries.push({ path: resolve(path) })
    }
  }

  start(): void {
    for (const entry of this.entries) this.watchEntry(entry)

    log.debug("watching configuration", { count: this.entries.length })
  }

  private watchEntry(entry: WatchEntry): void {
    if (this.closed) return

    const directory = dirname(entry.path)
    const filename = basename(entry.path)

    if (!existsSync(directory)) {
      // The directory may appear later \u2014 `.praxis/` is created on first use.
      // Retry rather than giving up, so configuration added after startup is
      // still picked up.
      entry.retry = setTimeout(() => this.watchEntry(entry), RETRY_INTERVAL_MS)
      entry.retry.unref?.()
      return
    }

    try {
      entry.watcher = watch(directory, { persistent: false }, (_event, changed) => {
        // A null filename happens on some platforms. Assume the worst and treat
        // it as a change to the watched file rather than missing an edit.
        if (changed !== null && changed !== filename) return

        this.schedule(entry.path)
      })

      entry.watcher.on("error", (error) => {
        log.warn("configuration watch failed", { path: entry.path, error: String(error) })

        entry.watcher?.close()
        entry.watcher = undefined

        entry.retry = setTimeout(() => this.watchEntry(entry), RETRY_INTERVAL_MS)
        entry.retry.unref?.()
      })
    } catch (error) {
      log.warn("could not watch configuration directory", {
        directory,
        error: String(error),
      })
    }
  }

  private schedule(path: string): void {
    this.pending.add(path)

    if (this.timer) clearTimeout(this.timer)

    this.timer = setTimeout(() => {
      this.timer = undefined

      // The settle delay is inside the debounce rather than replacing it: the
      // debounce coalesces the burst, the settle waits for the last write to
      // land.
      setTimeout(() => {
        const paths = [...this.pending]
        this.pending.clear()

        if (paths.length === 0) return

        log.info("configuration changed", { paths })

        void Promise.resolve(this.options.onChange(paths)).catch((error: unknown) => {
          log.error("the configuration reload handler threw", { error: String(error) })
        })
      }, SETTLE_MS)
    }, this.debounceMs)

    this.timer.unref?.()
  }

  close(): void {
    this.closed = true

    if (this.timer) clearTimeout(this.timer)

    for (const entry of this.entries) {
      entry.watcher?.close()
      if (entry.retry) clearTimeout(entry.retry)
    }

    this.entries.length = 0
  }
}

/* ------------------------------------------------------------------ */
/* Reload orchestration                                                */
/* ------------------------------------------------------------------ */

export interface ReloadInput {
  /** Reads and merges configuration afresh. */
  readonly load: () => Promise<Record<string, unknown>> | Record<string, unknown>
  /** The configuration currently in effect. */
  readonly current: () => Record<string, unknown>
  /** Installs the new configuration. Only called when parsing succeeded. */
  readonly apply: (config: Record<string, unknown>) => void | Promise<void>
}

export interface ReloadResult {
  readonly ok: boolean
  readonly analysis?: ChangeAnalysis
  readonly error?: string
}

/**
 * Reloads configuration.
 *
 * Load, compare, apply. The load can throw \u2014 a half-saved file, a syntax error \u2014
 * and when it does the previous configuration stays in effect and the error is
 * reported. This is the whole reason reloading is safe to have on by default: the
 * worst case is a message saying the file is broken, not a process running on
 * nothing.
 */
export async function reload(input: ReloadInput): Promise<ReloadResult> {
  let next: Record<string, unknown>

  try {
    next = await input.load()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    log.warn("configuration could not be reloaded; keeping the previous one", {
      error: message,
    })

    Bus.publish("configReloadFailed", { error: message })

    return { ok: false, error: message }
  }

  const analysis = analyseChanges(input.current(), next)

  if (!analysis.changed) {
    log.debug("configuration file changed but its contents did not")
    return { ok: true, analysis }
  }

  try {
    await input.apply(next)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    log.error("applying the new configuration failed", { error: message })

    Bus.publish("configReloadFailed", { error: message })

    return { ok: false, analysis, error: message }
  }

  log.info("configuration reloaded", {
    changes: analysis.changes.length,
    components: analysis.components,
    restartRequired: analysis.restartRequired,
  })

  Bus.publish("configReloaded", {
    changes: analysis.changes.map((change) => change.path),
    components: analysis.components,
    restartRequired: analysis.restartRequired,
  })

  for (const component of analysis.components) {
    Bus.publish("componentReloadRequested", { component })
  }

  return { ok: true, analysis }
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/**
 * A short summary of a reload, for a toast.
 *
 * Names the settings when there are few and counts them when there are many. A
 * toast listing forty paths is not readable and not useful.
 */
export function summariseReload(analysis: ChangeAnalysis): string {
  if (!analysis.changed) return "Configuration is unchanged."

  const parts: string[] = []

  if (analysis.changes.length <= 3) {
    parts.push(analysis.changes.map((change) => change.path).join(", "))
  } else {
    parts.push(`${analysis.changes.length} settings`)
  }

  if (analysis.restartRequired.length > 0) {
    parts.push(
      `${analysis.restartRequired.join(", ")} ${analysis.restartRequired.length === 1 ? "needs" : "need"} a restart`,
    )
  }

  return `Reloaded: ${parts.join("; ")}.`
}

/**
 * A readable line for one changed setting.
 *
 * Values are truncated hard. Showing a whole object diff in a notification is not
 * something anyone reads, and the full detail is available in the file.
 */
export function describeChange(change: ConfigChange): string {
  const format = (value: unknown): string => {
    if (value === undefined) return "unset"
    if (value === null) return "null"
    if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 37)}\u2026` : value
    if (typeof value === "object") return Array.isArray(value) ? `[${value.length} items]` : "{\u2026}"

    return String(value)
  }

  return `${change.path}: ${format(change.before)} \u2192 ${format(change.after)}`
}
