/**
 * A language server client.
 *
 * One instance wraps one running server process, tracks which documents it has
 * been told about, and exposes the handful of LSP requests that are actually
 * useful to a coding agent: diagnostics, hover, definition, references, and
 * symbols.
 *
 * The design is shaped entirely by one requirement: **the agent must never be
 * blocked or broken by a language server.** Language servers crash, hang, index
 * for two minutes on start-up, and occasionally return garbage. So:
 *
 *  - Start-up is asynchronous and non-blocking. A tool that wants diagnostics
 *    waits with a deadline and proceeds without them if the deadline passes.
 *  - Every operation is best-effort. Failures are logged and swallowed, never
 *    propagated into a tool result as an error.
 *  - Documents are tracked by content hash, so re-opening an unchanged file is
 *    free and a changed file is always re-synchronised.
 *  - Diagnostics are collected as they arrive (they are push notifications, not
 *    responses) and read from a store, with a settle window because servers emit
 *    them in several batches.
 *
 * The payoff is the single most valuable feedback loop in the system: after every
 * edit, the compiler's own opinion of the code goes straight back to the model,
 * so a type error introduced in one turn is fixed in the next without the user
 * having to run a build.
 */

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { logger } from "../util/log.js"
import { xxhash32 } from "../util/hash.js"
import { sleep } from "../util/async.js"
import { Bus, Events } from "../util/bus.js"
import {
  JsonRpcConnection,
  JsonRpcTimeoutError,
  languageIdOf,
  pathToUri,
  uriToPath,
  type Position,
  type Range,
} from "./jsonrpc.js"
import { languageIdFor, type ResolvedServer } from "./servers.js"

const log = logger("lsp.client")

/* ------------------------------------------------------------------ */
/* Protocol shapes                                                     */
/* ------------------------------------------------------------------ */

export type DiagnosticSeverity = 1 | 2 | 3 | 4

export const Severity = {
  error: 1 as const,
  warning: 2 as const,
  information: 3 as const,
  hint: 4 as const,
}

export interface Diagnostic {
  readonly range: Range
  readonly severity?: DiagnosticSeverity
  readonly code?: string | number
  readonly source?: string
  readonly message: string
  readonly tags?: readonly number[]
  readonly relatedInformation?: ReadonlyArray<{
    readonly location: { readonly uri: string; readonly range: Range }
    readonly message: string
  }>
}

export interface Location {
  readonly uri: string
  readonly range: Range
}

export interface DocumentSymbol {
  readonly name: string
  readonly detail?: string
  readonly kind: number
  readonly range: Range
  readonly selectionRange: Range
  readonly children?: readonly DocumentSymbol[]
}

export interface SymbolInformation {
  readonly name: string
  readonly kind: number
  readonly location: Location
  readonly containerName?: string
}

/** LSP `SymbolKind`, needed to render symbols usefully. */
export const SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type parameter",
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

type ClientState = "starting" | "ready" | "failed" | "stopped"

interface OpenDocument {
  readonly uri: string
  readonly languageId: string
  version: number
  hash: number
}

export interface ClientOptions {
  readonly server: ResolvedServer
  /** Called whenever the server publishes diagnostics. */
  readonly onDiagnostics?: (path: string, diagnostics: readonly Diagnostic[]) => void
  readonly onStateChange?: (state: ClientState, detail?: string) => void
}

export class LspClient {
  readonly id: string
  readonly label: string
  readonly root: string

  private connection?: JsonRpcConnection
  private state: ClientState = "starting"
  private failure?: string
  private readonly documents = new Map<string, OpenDocument>()
  private readonly options: ClientOptions
  private readyPromise?: Promise<boolean>
  /** Capabilities the server reported; used to skip unsupported requests. */
  private capabilities: Record<string, unknown> = {}
  /**
   * Servers that report progress tell us when indexing is done. Tracking the
   * outstanding tokens lets `waitForIdle` avoid asking for diagnostics while the
   * server is still building its index and would answer with nothing.
   */
  private readonly progressTokens = new Set<string>()
  private lastActivity = Date.now()

  constructor(options: ClientOptions) {
    this.options = options
    this.id = options.server.definition.id
    this.label = options.server.definition.label
    this.root = options.server.root
  }

  get status(): ClientState {
    return this.state
  }

  get error(): string | undefined {
    return this.failure
  }

  get idleMs(): number {
    return Date.now() - this.lastActivity
  }

  /**
   * Starts the server and performs the initialize handshake.
   *
   * Idempotent and shared: several files opening at once must not start several
   * processes, so the promise is cached.
   */
  async start(): Promise<boolean> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this.doStart()
    return this.readyPromise
  }

  private async doStart(): Promise<boolean> {
    const { server } = this.options
    log.info("starting language server", { id: this.id, root: this.root })

    let child
    try {
      child = spawn(server.binary, [...server.args], {
        cwd: this.root,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...server.definition.env,
          // Servers that colour their stderr make the logs unreadable.
          NO_COLOR: "1",
          TERM: "dumb",
        },
        windowsHide: true,
      })
    } catch (error) {
      this.fail(`could not start ${server.binary}: ${(error as Error).message}`)
      return false
    }

    this.connection = new JsonRpcConnection(child, {
      name: this.id,
      timeoutMs: 15_000,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleRequest(method, params),
      onClose: (reason) => {
        if (this.state !== "stopped") this.fail(reason)
      },
    })

    const timeoutMs = server.definition.startupTimeoutMs ?? 20_000

    try {
      const result = await this.connection.request<{ capabilities?: Record<string, unknown> }>(
        "initialize",
        this.initializeParams(),
        { timeoutMs },
      )
      this.capabilities = result?.capabilities ?? {}
    } catch (error) {
      const detail =
        error instanceof JsonRpcTimeoutError
          ? `${this.id} did not finish initialising within ${timeoutMs}ms`
          : (error as Error).message
      this.fail(detail)
      return false
    }

    this.connection.notify("initialized", {})

    // Several servers need their configuration pushed after initialization or
    // they analyse nothing. Sending it unconditionally is harmless.
    this.connection.notify("workspace/didChangeConfiguration", {
      settings: server.definition.initializationOptions ?? {},
    })

    this.state = "ready"
    this.options.onStateChange?.("ready")
    Bus.publish(Events.lspServerStarted, { id: this.id, root: this.root })
    log.info("language server ready", { id: this.id })
    return true
  }

  /**
   * The capabilities we advertise.
   *
   * Deliberately minimal but not *too* minimal. Declaring `publishDiagnostics`
   * support is mandatory. Declaring `workspace/configuration` support matters
   * because servers that see it will ask instead of assuming defaults. Declaring
   * `workDoneProgress` lets us know when indexing finishes, which is the
   * difference between reading real diagnostics and reading an empty list.
   */
  private initializeParams(): Record<string, unknown> {
    return {
      processId: process.pid,
      clientInfo: { name: "praxis", version: "1.0.0" },
      locale: "en",
      rootPath: this.root,
      rootUri: pathToUri(this.root),
      workspaceFolders: [{ uri: pathToUri(this.root), name: this.root.split(/[\\/]/).pop() ?? "root" }],
      initializationOptions: this.options.server.definition.initializationOptions ?? {},
      capabilities: {
        workspace: {
          applyEdit: false,
          configuration: true,
          didChangeConfiguration: { dynamicRegistration: false },
          didChangeWatchedFiles: { dynamicRegistration: true },
          workspaceFolders: true,
          symbol: {
            dynamicRegistration: false,
            symbolKind: { valueSet: Array.from({ length: 26 }, (_value, index) => index + 1) },
          },
          executeCommand: { dynamicRegistration: false },
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: true,
          },
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] },
            versionSupport: true,
            codeDescriptionSupport: true,
            dataSupport: true,
          },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: true },
          typeDefinition: { dynamicRegistration: false, linkSupport: true },
          implementation: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: Array.from({ length: 26 }, (_value, index) => index + 1) },
          },
          signatureHelp: { dynamicRegistration: false },
          // Completion is not requested: an agent does not type, and advertising
          // it makes some servers do substantially more work per keystroke-like
          // event.
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        },
        window: {
          workDoneProgress: true,
          showMessage: { messageActionItem: { additionalPropertiesSupport: false } },
        },
        general: {
          positionEncodings: ["utf-16"],
          markdown: { parser: "praxis", version: "1.0.0" },
        },
      },
    }
  }

  private fail(reason: string): void {
    if (this.state === "failed" || this.state === "stopped") return
    this.state = "failed"
    this.failure = reason
    this.documents.clear()
    this.options.onStateChange?.("failed", reason)
    Bus.publish(Events.lspServerFailed, { id: this.id, reason })
    log.warn("language server failed", { id: this.id, reason })
  }

  /* ---------------------------------------------------------------- */
  /* Notifications from the server                                    */
  /* ---------------------------------------------------------------- */

  private handleNotification(method: string, params: unknown): void {
    this.lastActivity = Date.now()

    switch (method) {
      case "textDocument/publishDiagnostics": {
        const payload = params as { uri?: string; diagnostics?: Diagnostic[] }
        if (!payload?.uri) return
        const path = uriToPath(payload.uri)
        this.options.onDiagnostics?.(path, payload.diagnostics ?? [])
        return
      }

      case "$/progress": {
        const payload = params as {
          token?: string | number
          value?: { kind?: string; title?: string }
        }
        const token = String(payload?.token ?? "")
        if (token === "") return
        if (payload.value?.kind === "begin") this.progressTokens.add(token)
        if (payload.value?.kind === "end") this.progressTokens.delete(token)
        return
      }

      case "window/logMessage": {
        const payload = params as { type?: number; message?: string }
        // Only errors are worth surfacing; servers log volumes of trivia.
        if (payload?.type === 1) {
          log.debug(`${this.id}: ${payload.message ?? ""}`)
        }
        return
      }

      case "window/showMessage": {
        const payload = params as { type?: number; message?: string }
        if (payload?.type === 1 && payload.message) {
          log.warn(`${this.id}: ${payload.message}`)
        }
        return
      }

      default:
        return
    }
  }

  /**
   * Answers server-initiated requests.
   *
   * `workspace/configuration` is the one that matters: several servers block
   * their first analysis on it. Returning an array of the initialization options
   * (one entry per requested section) satisfies all of them.
   */
  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    this.lastActivity = Date.now()

    switch (method) {
      case "workspace/configuration": {
        const payload = params as { items?: Array<{ section?: string }> }
        const options = (this.options.server.definition.initializationOptions ?? {}) as Record<
          string,
          unknown
        >
        return (payload.items ?? [{}]).map((item) => {
          if (!item.section) return options
          // Resolve dotted sections such as "python.analysis".
          let cursor: unknown = options
          for (const part of item.section.split(".")) {
            if (typeof cursor !== "object" || cursor === null) return {}
            cursor = (cursor as Record<string, unknown>)[part]
          }
          return cursor ?? {}
        })
      }

      case "window/workDoneProgress/create": {
        const payload = params as { token?: string | number }
        if (payload?.token !== undefined) this.progressTokens.add(String(payload.token))
        return null
      }

      case "client/registerCapability":
      case "client/unregisterCapability":
        return null

      case "workspace/applyEdit":
        // Refused: edits must go through the edit tools so they are reviewed,
        // permission-checked, and recorded in the session.
        return { applied: false, failureReason: "Praxis applies edits through its own tools." }

      default:
        return null
    }
  }

  /* ---------------------------------------------------------------- */
  /* Document synchronisation                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Tells the server about a file, or updates it if the content changed.
   *
   * Content-hash comparison rather than mtime: an editor writing the same bytes
   * changes the mtime, and re-sending an unchanged document makes servers throw
   * away their analysis and start over.
   */
  async open(path: string, content?: string): Promise<void> {
    if (!(await this.start())) return
    if (!this.connection || this.connection.isClosed) return

    const absolute = resolve(path)
    const uri = pathToUri(absolute)

    let text = content
    if (text === undefined) {
      try {
        text = readFileSync(absolute, "utf8")
      } catch {
        return
      }
    }

    const hash = xxhash32(text)
    const existing = this.documents.get(uri)

    if (existing) {
      if (existing.hash === hash) return
      existing.version++
      existing.hash = hash
      this.connection.notify("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        // Full-document sync. Incremental sync would be more efficient but the
        // agent replaces whole regions rather than typing, so the saving is
        // negligible and the bug surface is not.
        contentChanges: [{ text }],
      })
      this.lastActivity = Date.now()
      return
    }

    const languageId = languageIdFor(absolute)
    this.documents.set(uri, { uri, languageId, version: 1, hash })
    this.connection.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    })
    this.lastActivity = Date.now()
  }

  /** Notifies the server that a file was saved, which triggers checks such as clippy. */
  save(path: string): void {
    const uri = pathToUri(resolve(path))
    if (!this.documents.has(uri) || !this.connection) return
    this.connection.notify("textDocument/didSave", { textDocument: { uri } })
  }

  close(path: string): void {
    const uri = pathToUri(resolve(path))
    if (!this.documents.delete(uri) || !this.connection) return
    this.connection.notify("textDocument/didClose", { textDocument: { uri } })
  }

  /** Whether this server has been told about a file. */
  tracks(path: string): boolean {
    return this.documents.has(pathToUri(resolve(path)))
  }

  /**
   * Waits until the server appears to have finished working.
   *
   * Two signals: no outstanding progress tokens, and a quiet period with no
   * notifications. The quiet period is what makes diagnostics reliable — servers
   * publish in bursts, and reading immediately after an edit reliably returns the
   * previous state.
   */
  async waitForIdle(options: { timeoutMs?: number; quietMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 4_000
    const quietMs = options.quietMs ?? 350
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.progressTokens.size === 0 && Date.now() - this.lastActivity >= quietMs) return
      await sleep(80)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Requests                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Pull-model diagnostics, for servers that support them.
   *
   * Newer servers prefer `textDocument/diagnostic` over pushing, and for those
   * the push notification may never arrive. Trying both is the only reliable
   * approach.
   */
  async pullDiagnostics(path: string): Promise<Diagnostic[] | undefined> {
    if (!this.supports("diagnosticProvider")) return undefined
    const uri = pathToUri(resolve(path))
    try {
      const result = await this.request<{ items?: Diagnostic[]; kind?: string }>(
        "textDocument/diagnostic",
        { textDocument: { uri } },
        6_000,
      )
      return result?.items ?? []
    } catch {
      return undefined
    }
  }

  async hover(path: string, position: Position): Promise<string | undefined> {
    if (!this.supports("hoverProvider")) return undefined
    const result = await this.request<{ contents?: unknown }>(
      "textDocument/hover",
      { textDocument: { uri: pathToUri(resolve(path)) }, position },
      5_000,
    )
    return result ? renderHover(result.contents) : undefined
  }

  async definition(path: string, position: Position): Promise<Location[]> {
    if (!this.supports("definitionProvider")) return []
    const result = await this.request<unknown>(
      "textDocument/definition",
      { textDocument: { uri: pathToUri(resolve(path)) }, position },
      6_000,
    )
    return normalizeLocations(result)
  }

  async typeDefinition(path: string, position: Position): Promise<Location[]> {
    if (!this.supports("typeDefinitionProvider")) return []
    const result = await this.request<unknown>(
      "textDocument/typeDefinition",
      { textDocument: { uri: pathToUri(resolve(path)) }, position },
      6_000,
    )
    return normalizeLocations(result)
  }

  async implementation(path: string, position: Position): Promise<Location[]> {
    if (!this.supports("implementationProvider")) return []
    const result = await this.request<unknown>(
      "textDocument/implementation",
      { textDocument: { uri: pathToUri(resolve(path)) }, position },
      6_000,
    )
    return normalizeLocations(result)
  }

  async references(
    path: string,
    position: Position,
    includeDeclaration = false,
  ): Promise<Location[]> {
    if (!this.supports("referencesProvider")) return []
    const result = await this.request<unknown>(
      "textDocument/references",
      {
        textDocument: { uri: pathToUri(resolve(path)) },
        position,
        context: { includeDeclaration },
      },
      // References can be genuinely slow in a large repository, and the result is
      // valuable enough to wait for.
      15_000,
    )
    return normalizeLocations(result)
  }

  async documentSymbols(path: string): Promise<DocumentSymbol[] | SymbolInformation[]> {
    if (!this.supports("documentSymbolProvider")) return []
    const result = await this.request<DocumentSymbol[] | SymbolInformation[]>(
      "textDocument/documentSymbol",
      { textDocument: { uri: pathToUri(resolve(path)) } },
      8_000,
    )
    return result ?? []
  }

  async workspaceSymbols(query: string): Promise<SymbolInformation[]> {
    if (!this.supports("workspaceSymbolProvider")) return []
    const result = await this.request<SymbolInformation[]>(
      "workspace/symbol",
      { query },
      12_000,
    )
    return result ?? []
  }

  /** Whether the server declared a capability. */
  private supports(capability: string): boolean {
    const value = this.capabilities[capability]
    return value !== undefined && value !== false && value !== null
  }

  /**
   * Issues a request, swallowing every failure.
   *
   * Returning `undefined` on error is intentional: no caller of this class can do
   * anything useful with a language server failure, and turning one into a thrown
   * exception would surface an infrastructure problem as a tool error the model
   * would then try to "fix".
   */
  private async request<T>(method: string, params: unknown, timeoutMs: number): Promise<T | undefined> {
    if (this.state !== "ready" || !this.connection || this.connection.isClosed) return undefined
    this.lastActivity = Date.now()
    try {
      return await this.connection.request<T>(method, params, { timeoutMs })
    } catch (error) {
      log.debug(`${this.id}: ${method} failed`, { error: String((error as Error).message) })
      return undefined
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return
    this.state = "stopped"
    this.documents.clear()
    this.progressTokens.clear()
    await this.connection?.dispose()
    this.connection = undefined
    Bus.publish(Events.lspServerStopped, { id: this.id })
  }

  info(): {
    id: string
    label: string
    root: string
    state: ClientState
    documents: number
    error?: string
  } {
    return {
      id: this.id,
      label: this.label,
      root: this.root,
      state: this.state,
      documents: this.documents.size,
      error: this.failure,
    }
  }
}

/* ------------------------------------------------------------------ */
/* Result normalisation                                                */
/* ------------------------------------------------------------------ */

/**
 * Normalises the three shapes LSP allows for location results.
 *
 * `Location`, `Location[]`, and `LocationLink[]` are all legal responses and
 * different servers pick different ones. Handling all three here means callers
 * never have to.
 */
function normalizeLocations(value: unknown): Location[] {
  if (!value) return []

  const entries = Array.isArray(value) ? value : [value]
  const result: Location[] = []

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>

    if (typeof record["uri"] === "string" && record["range"]) {
      result.push({ uri: record["uri"] as string, range: record["range"] as Range })
      continue
    }

    // LocationLink
    if (typeof record["targetUri"] === "string") {
      const range = (record["targetSelectionRange"] ?? record["targetRange"]) as Range | undefined
      if (range) result.push({ uri: record["targetUri"] as string, range })
    }
  }

  return result
}

/**
 * Flattens hover contents to plain text.
 *
 * Hover results are the least consistently shaped part of LSP: a string, a
 * `MarkupContent`, a `MarkedString`, or an array of any of those. This is where
 * the type signature of a symbol comes from, which is worth the tedium.
 */
function renderHover(contents: unknown): string | undefined {
  if (contents === undefined || contents === null) return undefined

  if (typeof contents === "string") return clean(contents)

  if (Array.isArray(contents)) {
    const parts = contents.map((entry) => renderHover(entry)).filter(Boolean)
    return parts.length > 0 ? parts.join("\n\n") : undefined
  }

  const record = contents as Record<string, unknown>
  if (typeof record["value"] === "string") return clean(record["value"] as string)
  if (typeof record["language"] === "string" && typeof record["value"] === "string") {
    return clean(record["value"] as string)
  }

  return undefined
}

/** Strips markdown code fences that carry no information in a plain-text context. */
function clean(value: string): string {
  return value
    .replace(/^```[a-zA-Z0-9]*\n/gm, "")
    .replace(/\n```$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Re-exported so callers do not need the jsonrpc module for a language id. */
export { languageIdOf }
