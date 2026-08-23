/**
 * Language server lifecycle manager.
 *
 * Owns the set of running servers, decides when to start one, routes documents to
 * the servers that can handle them, and shuts idle ones down. It is the only part
 * of the LSP layer the rest of the application talks to.
 *
 * The policies here exist because language servers are expensive and unreliable:
 *
 *  - **Lazy start.** Nothing runs until a file of that language is touched.
 *    Starting `rust-analyzer` in a project with no Rust would burn a gigabyte for
 *    nothing.
 *  - **One server per (definition, root).** A monorepo with three TypeScript
 *    packages gets three `tsserver` instances if they have separate tsconfigs,
 *    because one instance rooted at the top would report wrong diagnostics for
 *    all three.
 *  - **A start-up failure is remembered.** Retrying a server that is not
 *    installed on every single file open would add a process spawn to every edit.
 *  - **Idle servers are reaped.** A session that touched a Java file two hours ago
 *    should not still be paying for `jdtls`.
 *  - **Everything is best-effort with a deadline.** `diagnostics(path)` returns
 *    what it has when the deadline passes. An edit must never wait on a language
 *    server, and must never fail because of one.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { logger } from "../util/log.js"
import { sleep } from "../util/async.js"
import { Flag } from "../flag.js"
import { LspClient, type Diagnostic } from "./client.js"
import { diagnosticStore, type DiagnosticStore } from "./diagnostics.js"
import { serversFor, supportedExtensions, type ResolvedServer } from "./servers.js"

const log = logger("lsp.registry")

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface LspConfig {
  /** Turn the whole subsystem off. */
  readonly disabled?: boolean
  /** Server ids to skip. */
  readonly disabledServers?: readonly string[]
  /** Extra or overriding server definitions from user configuration. */
  readonly servers?: ReadonlyArray<{
    readonly id: string
    readonly extensions: readonly string[]
    readonly command: readonly string[]
    readonly rootMarkers?: readonly string[]
    readonly initializationOptions?: Record<string, unknown>
    readonly env?: Record<string, string>
    readonly disabled?: boolean
  }>
  /** How long a server may sit unused before being stopped. */
  readonly idleTimeoutMs?: number
  /** Maximum concurrent servers. */
  readonly maxServers?: number
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

interface Slot {
  readonly key: string
  readonly client: LspClient
  /** Files routed to this server, for shutdown accounting. */
  readonly paths: Set<string>
  lastUsed: number
}

export class LspRegistry {
  private readonly slots = new Map<string, Slot>()
  /** Servers that failed to start, so we do not retry them constantly. */
  private readonly broken = new Map<string, { reason: string; at: number }>()
  private readonly store: DiagnosticStore
  private readonly config: LspConfig
  private readonly cwd: string
  private reaper?: NodeJS.Timeout
  private stopped = false

  constructor(options: { cwd: string; config?: LspConfig; store?: DiagnosticStore }) {
    this.cwd = resolve(options.cwd)
    this.config = options.config ?? {}
    this.store = options.store ?? diagnosticStore()

    if (!this.config.disabled) this.startReaper()
  }

  get enabled(): boolean {
    return !this.config.disabled && !this.stopped
  }

  /* ---------------------------------------------------------------- */
  /* Routing                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Whether any server could handle this file.
   *
   * Checked before doing anything else so that touching a `.txt` file costs
   * nothing.
   */
  handles(path: string): boolean {
    if (!this.enabled) return false
    const extensions = supportedExtensions()
    const name = path.split(/[\\/]/).pop() ?? ""
    const dot = name.lastIndexOf(".")
    if (dot > 0 && extensions.has(name.slice(dot).toLowerCase())) return true
    return /^(Dockerfile|Makefile|Gemfile|Rakefile|go\.(mod|sum|work))/.test(name)
  }

  /**
   * Ensures the right servers are running for a file and told about its content.
   *
   * Returns the clients that accepted it. Callers do not usually need the return
   * value; they call this and then ask for diagnostics.
   */
  async touch(path: string, content?: string): Promise<LspClient[]> {
    if (!this.enabled) return []

    const absolute = resolve(this.cwd, path)
    if (!existsSync(absolute)) return []
    if (!this.handles(absolute)) return []

    const resolved = serversFor(absolute, {
      cwd: this.cwd,
      flags: Flag.experimentalFlags(),
      disabled: new Set(this.config.disabledServers ?? []),
    })

    if (resolved.length === 0) return []

    const clients: LspClient[] = []

    for (const server of resolved) {
      const client = await this.ensure(server)
      if (!client) continue
      const slot = this.slots.get(slotKey(server))
      if (slot) {
        slot.paths.add(absolute)
        slot.lastUsed = Date.now()
      }
      await client.open(absolute, content)
      clients.push(client)
    }

    return clients
  }

  /** Notifies servers that a file was written, which triggers on-save checks. */
  async didSave(path: string, content?: string): Promise<void> {
    const clients = await this.touch(path, content)
    for (const client of clients) client.save(path)
  }

  /**
   * Starts a server if it is not already running.
   *
   * The `broken` map is the important detail: a server that is not installed must
   * be attempted once per session, not once per file.
   */
  private async ensure(server: ResolvedServer): Promise<LspClient | undefined> {
    const key = slotKey(server)

    const existing = this.slots.get(key)
    if (existing) {
      if (existing.client.status === "failed") {
        this.slots.delete(key)
        this.broken.set(key, { reason: existing.client.error ?? "unknown", at: Date.now() })
        return undefined
      }
      return existing.client
    }

    const failure = this.broken.get(key)
    if (failure) {
      // Retry after five minutes: the user may have installed the server.
      if (Date.now() - failure.at < 5 * 60_000) return undefined
      this.broken.delete(key)
    }

    const max = this.config.maxServers ?? 8
    if (this.slots.size >= max) {
      // Evict the least recently used rather than refusing: the file the user is
      // working on now matters more than one they touched an hour ago.
      const victim = [...this.slots.values()].sort((left, right) => left.lastUsed - right.lastUsed)[0]
      if (victim) {
        log.debug("evicting idle language server", { id: victim.client.id })
        this.slots.delete(victim.key)
        void victim.client.stop()
      }
    }

    const client = new LspClient({
      server,
      onDiagnostics: (path, diagnostics) => {
        this.store.set(server.definition.id, path, diagnostics)
      },
      onStateChange: (state, detail) => {
        if (state === "failed") {
          this.slots.delete(key)
          this.broken.set(key, { reason: detail ?? "unknown", at: Date.now() })
        }
      },
    })

    this.slots.set(key, { key, client, paths: new Set(), lastUsed: Date.now() })

    const started = await client.start()
    if (!started) {
      this.slots.delete(key)
      this.broken.set(key, { reason: client.error ?? "failed to start", at: Date.now() })
      return undefined
    }

    return client
  }

  /* ---------------------------------------------------------------- */
  /* Diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Gets diagnostics for a file, waiting a bounded time for them to arrive.
   *
   * The wait is the crux of making this useful. Diagnostics are push
   * notifications, so asking immediately after an edit returns the *previous*
   * state. But waiting too long makes every edit feel slow. The compromise:
   *
   *  1. Open or update the document.
   *  2. Try the pull API, which some servers answer immediately.
   *  3. Otherwise wait for the server to go quiet, up to the deadline.
   *  4. Return whatever is in the store.
   *
   * A deadline expiring is normal and produces no error.
   */
  async diagnostics(
    path: string,
    options: { content?: string; timeoutMs?: number } = {},
  ): Promise<Diagnostic[]> {
    if (!this.enabled) return []

    const absolute = resolve(this.cwd, path)
    const clients = await this.touch(absolute, options.content)
    if (clients.length === 0) return []

    const timeoutMs = options.timeoutMs ?? 3_500

    // Pull-model servers can answer directly, which is both faster and more
    // accurate than waiting for a push.
    for (const client of clients) {
      const pulled = await client.pullDiagnostics(absolute)
      if (pulled) this.store.set(client.id, absolute, pulled)
    }

    await Promise.all(
      clients.map((client) =>
        client.waitForIdle({ timeoutMs, quietMs: 300 }).catch(() => undefined),
      ),
    )

    return this.store.forFile(absolute)
  }

  /**
   * Diagnostics for several files at once, used after a multi-file edit.
   *
   * Files are opened together and then awaited together: opening them serially
   * would multiply the settle wait by the number of files.
   */
  async diagnosticsForAll(
    paths: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<Map<string, Diagnostic[]>> {
    if (!this.enabled || paths.length === 0) return new Map()

    const absolutePaths = paths.map((path) => resolve(this.cwd, path))
    const clientSets = await Promise.all(absolutePaths.map((path) => this.touch(path)))
    const clients = new Set(clientSets.flat())

    if (clients.size === 0) return new Map()

    const timeoutMs = options.timeoutMs ?? 5_000

    await Promise.all(
      [...clients].map((client) =>
        client.waitForIdle({ timeoutMs, quietMs: 350 }).catch(() => undefined),
      ),
    )

    const result = new Map<string, Diagnostic[]>()
    for (const path of absolutePaths) {
      const diagnostics = this.store.forFile(path)
      if (diagnostics.length > 0) result.set(path, diagnostics)
    }
    return result
  }

  /** Snapshots the current diagnostics so a later diff shows only new problems. */
  snapshot(paths?: readonly string[]): void {
    this.store.snapshot(paths?.map((path) => resolve(this.cwd, path)))
  }

  /** Diagnostics introduced since the last snapshot. */
  newDiagnostics(path: string): Diagnostic[] {
    return this.store.newSince(resolve(this.cwd, path))
  }

  /* ---------------------------------------------------------------- */
  /* Symbols and navigation                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Searches workspace symbols across every running server.
   *
   * Only running servers are queried: starting every server in the catalogue to
   * answer a symbol search would be absurd. In practice the servers for the
   * languages in play are already running by the time this is called.
   */
  async workspaceSymbols(query: string): Promise<Array<{ server: string; symbols: unknown[] }>> {
    const results = await Promise.all(
      [...this.slots.values()]
        .filter((slot) => slot.client.status === "ready")
        .map(async (slot) => ({
          server: slot.client.id,
          symbols: (await slot.client.workspaceSymbols(query)) as unknown[],
        })),
    )
    return results.filter((entry) => entry.symbols.length > 0)
  }

  /** The first client that can handle a path, for single-server operations. */
  async clientFor(path: string): Promise<LspClient | undefined> {
    const clients = await this.touch(path)
    return clients[0]
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Periodically stops servers nobody is using.
   *
   * `jdtls` and `rust-analyzer` each hold hundreds of megabytes. In a long
   * session that drifts between languages, reaping is the difference between a
   * comfortable footprint and swapping.
   */
  private startReaper(): void {
    const idleTimeoutMs = this.config.idleTimeoutMs ?? 15 * 60_000

    this.reaper = setInterval(() => {
      const now = Date.now()
      for (const [key, slot] of this.slots) {
        if (now - slot.lastUsed < idleTimeoutMs) continue
        if (slot.client.idleMs < idleTimeoutMs) continue
        log.info("stopping idle language server", { id: slot.client.id })
        this.slots.delete(key)
        void slot.client.stop()
      }
    }, 60_000)

    if (typeof this.reaper.unref === "function") this.reaper.unref()
  }

  /** Status for the `doctor` and `lsp` commands. */
  status(): Array<{
    id: string
    label: string
    root: string
    state: string
    documents: number
    error?: string
  }> {
    const running = [...this.slots.values()].map((slot) => slot.client.info())
    const failed = [...this.broken.entries()].map(([key, value]) => ({
      id: key.split("\u0000")[0] ?? key,
      label: key.split("\u0000")[0] ?? key,
      root: key.split("\u0000")[1] ?? "",
      state: "failed",
      documents: 0,
      error: value.reason,
    }))
    return [...running, ...failed]
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reaper) clearInterval(this.reaper)

    const clients = [...this.slots.values()].map((slot) => slot.client)
    this.slots.clear()

    // Bounded: a server that will not exit must not delay the process exit.
    await Promise.race([
      Promise.all(clients.map((client) => client.stop().catch(() => undefined))),
      sleep(3_000),
    ])
  }
}

function slotKey(server: ResolvedServer): string {
  return `${server.definition.id}\u0000${server.root}`
}

/* ------------------------------------------------------------------ */
/* Process-wide instance                                               */
/* ------------------------------------------------------------------ */

let registry: LspRegistry | undefined

export function lspRegistry(options?: { cwd: string; config?: LspConfig }): LspRegistry {
  registry ??= new LspRegistry(options ?? { cwd: process.cwd() })
  return registry
}

export function setLspRegistry(next: LspRegistry): void {
  registry = next
}

export async function disposeLspRegistry(): Promise<void> {
  await registry?.stop()
  registry = undefined
}
