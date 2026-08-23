/**
 * Typed event bus.
 *
 * Everything that happens in Praxis is an event: a message part streams in, a
 * permission is requested, a file changes on disk, a session is compacted. The
 * TUI never polls — it subscribes. Events cross the worker boundary as JSON, so
 * every payload is validated by a schema on definition.
 */

import { logger } from "./log.js"
import type { Schema } from "./schema.js"
import { s } from "./schema.js"

const log = logger("bus")

export interface EventDefinition<T> {
  readonly type: string
  readonly schema: Schema<T>
  /** Phantom field carrying the payload type. */
  readonly __payload?: T
}

export interface Envelope<T = unknown> {
  readonly type: string
  readonly payload: T
  readonly at: number
  /** Session the event belongs to, when applicable. Enables cheap filtering. */
  readonly sessionId?: string
  /** Monotonic sequence number for replay/resume over SSE. */
  readonly seq: number
}

export type Listener<T> = (payload: T, envelope: Envelope<T>) => void | Promise<void>
export type WildcardListener = (envelope: Envelope) => void | Promise<void>

const REGISTRY = new Map<string, EventDefinition<any>>()

/** Declares an event type. Duplicate declarations return the existing one. */
export function defineEvent<T>(type: string, schema: Schema<T>): EventDefinition<T> {
  const existing = REGISTRY.get(type)
  if (existing) return existing as EventDefinition<T>
  const definition: EventDefinition<T> = { type, schema }
  REGISTRY.set(type, definition)
  return definition
}

export function eventDefinitions(): readonly EventDefinition<any>[] {
  return [...REGISTRY.values()]
}

export function lookupEvent(type: string): EventDefinition<any> | undefined {
  return REGISTRY.get(type)
}

interface Subscription {
  readonly type: string
  readonly listener: Listener<any>
  readonly once: boolean
  readonly sessionId?: string
}

/**
 * A bus instance. There is one per project instance plus a process-global bus
 * that mirrors everything for the worker bridge.
 */
export class EventBus {
  private readonly subscriptions = new Map<string, Set<Subscription>>()
  private readonly wildcards = new Set<WildcardListener>()
  private readonly history: Envelope[] = []
  private sequence = 0
  private closed = false

  constructor(
    readonly name: string,
    /** How many envelopes to retain for late subscribers / SSE resume. */
    private readonly historyLimit = 512,
  ) {}

  publish<T>(definition: EventDefinition<T>, payload: T, sessionId?: string): Envelope<T> {
    const envelope: Envelope<T> = {
      type: definition.type,
      payload,
      at: Date.now(),
      sessionId,
      seq: ++this.sequence,
    }
    if (this.closed) return envelope

    this.history.push(envelope as Envelope)
    if (this.history.length > this.historyLimit) this.history.shift()

    const listeners = this.subscriptions.get(definition.type)
    if (listeners) {
      for (const subscription of [...listeners]) {
        if (subscription.sessionId && subscription.sessionId !== sessionId) continue
        if (subscription.once) listeners.delete(subscription)
        this.invoke(subscription.listener, payload, envelope)
      }
    }
    for (const wildcard of [...this.wildcards]) {
      this.invokeWildcard(wildcard, envelope as Envelope)
    }
    return envelope
  }

  private invoke<T>(listener: Listener<T>, payload: T, envelope: Envelope<T>): void {
    try {
      const result = listener(payload, envelope)
      if (result && typeof (result as Promise<void>).catch === "function") {
        ;(result as Promise<void>).catch((err) =>
          log.error("event listener rejected", { type: envelope.type, err }),
        )
      }
    } catch (err) {
      log.error("event listener threw", { type: envelope.type, err })
    }
  }

  private invokeWildcard(listener: WildcardListener, envelope: Envelope): void {
    try {
      const result = listener(envelope)
      if (result && typeof (result as Promise<void>).catch === "function") {
        ;(result as Promise<void>).catch((err) =>
          log.error("wildcard listener rejected", { type: envelope.type, err }),
        )
      }
    } catch (err) {
      log.error("wildcard listener threw", { type: envelope.type, err })
    }
  }

  subscribe<T>(
    definition: EventDefinition<T>,
    listener: Listener<T>,
    options: { readonly sessionId?: string } = {},
  ): () => void {
    const set = this.subscriptions.get(definition.type) ?? new Set<Subscription>()
    this.subscriptions.set(definition.type, set)
    const subscription: Subscription = {
      type: definition.type,
      listener,
      once: false,
      sessionId: options.sessionId,
    }
    set.add(subscription)
    return () => set.delete(subscription)
  }

  once<T>(definition: EventDefinition<T>, listener: Listener<T>): () => void {
    const set = this.subscriptions.get(definition.type) ?? new Set<Subscription>()
    this.subscriptions.set(definition.type, set)
    const subscription: Subscription = { type: definition.type, listener, once: true }
    set.add(subscription)
    return () => set.delete(subscription)
  }

  /** Subscribes to every event; used by the worker bridge and the SSE stream. */
  subscribeAll(listener: WildcardListener): () => void {
    this.wildcards.add(listener)
    return () => this.wildcards.delete(listener)
  }

  /** Waits for the next matching event, with an optional predicate and timeout. */
  wait<T>(
    definition: EventDefinition<T>,
    options: {
      readonly predicate?: (payload: T) => boolean
      readonly timeoutMs?: number
      readonly signal?: AbortSignal
    } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const unsubscribe = this.subscribe(definition, (payload) => {
        if (options.predicate && !options.predicate(payload)) return
        cleanup()
        resolve(payload)
      })
      const cleanup = () => {
        unsubscribe()
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new Error("aborted"))
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })
      if (options.timeoutMs) {
        timer = setTimeout(() => {
          cleanup()
          reject(new Error(`timed out waiting for ${definition.type}`))
        }, options.timeoutMs)
      }
    })
  }

  /** Async iterator over events; the backbone of the HTTP event stream. */
  async *stream(options: {
    readonly types?: readonly string[]
    readonly sessionId?: string
    readonly sinceSeq?: number
    readonly signal?: AbortSignal
  } = {}): AsyncGenerator<Envelope> {
    const queue: Envelope[] = []
    let notify: (() => void) | undefined
    let done = false

    if (options.sinceSeq !== undefined) {
      for (const envelope of this.history) {
        if (envelope.seq > options.sinceSeq) queue.push(envelope)
      }
    }

    const typeFilter = options.types ? new Set(options.types) : undefined
    const unsubscribe = this.subscribeAll((envelope) => {
      if (typeFilter && !typeFilter.has(envelope.type)) return
      if (options.sessionId && envelope.sessionId && envelope.sessionId !== options.sessionId) return
      queue.push(envelope)
      notify?.()
    })

    const onAbort = () => {
      done = true
      notify?.()
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      for (;;) {
        if (queue.length) {
          yield queue.shift() as Envelope
          continue
        }
        if (done || options.signal?.aborted) return
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = undefined
            resolve()
          }
        })
      }
    } finally {
      unsubscribe()
      options.signal?.removeEventListener("abort", onAbort)
    }
  }

  replay(sinceSeq: number): Envelope[] {
    return this.history.filter((e) => e.seq > sinceSeq)
  }

  get currentSeq(): number {
    return this.sequence
  }

  listenerCount(type?: string): number {
    if (type) return this.subscriptions.get(type)?.size ?? 0
    let total = this.wildcards.size
    for (const set of this.subscriptions.values()) total += set.size
    return total
  }

  close(): void {
    this.closed = true
    this.subscriptions.clear()
    this.wildcards.clear()
    this.history.length = 0
  }
}

/**
 * Process-global bus. Instance buses forward into it so the worker bridge only
 * needs one subscription regardless of how many project instances exist.
 */
export const GlobalBus = new EventBus("global", 1024)

/** Creates an instance bus that mirrors every publish into {@link GlobalBus}. */
export function createInstanceBus(name: string): EventBus {
  const bus = new EventBus(name)
  bus.subscribeAll((envelope) => {
    const definition = REGISTRY.get(envelope.type)
    if (!definition) return
    GlobalBus.publish(definition, envelope.payload, envelope.sessionId)
  })
  return bus
}

/** Re-publishes envelopes received from another thread/process into a bus. */
export function injectEnvelope(bus: EventBus, envelope: Envelope): boolean {
  const definition = REGISTRY.get(envelope.type)
  if (!definition) {
    log.debug("dropping unknown event", { type: envelope.type })
    return false
  }
  const parsed = definition.schema.safeParse(envelope.payload)
  if (!parsed.ok) {
    log.warn("dropping malformed event", { type: envelope.type, issues: parsed.issues })
    return false
  }
  bus.publish(definition, parsed.value, envelope.sessionId)
  return true
}

/* ------------------------------------------------------------------ */
/* Shared event catalogue                                             */
/* ------------------------------------------------------------------ */

const idField = s.string().nonEmpty()

export const Events = {
  sessionCreated: defineEvent(
    "session.created",
    s.object({ sessionId: idField, title: s.string(), parentId: s.string().optional() }),
  ),
  sessionUpdated: defineEvent(
    "session.updated",
    s.object({ sessionId: idField, title: s.string().optional() }),
  ),
  sessionDeleted: defineEvent("session.deleted", s.object({ sessionId: idField })),
  sessionIdle: defineEvent("session.idle", s.object({ sessionId: idField })),
  sessionBusy: defineEvent("session.busy", s.object({ sessionId: idField })),
  sessionError: defineEvent(
    "session.error",
    s.object({
      sessionId: s.string().optional(),
      name: s.string(),
      message: s.string(),
      data: s.any().optional(),
    }),
  ),
  sessionCompacted: defineEvent(
    "session.compacted",
    s.object({ sessionId: idField, removedMessages: s.number(), summaryTokens: s.number() }),
  ),
  sessionReverted: defineEvent(
    "session.reverted",
    s.object({ sessionId: idField, messageId: s.string(), restoredFiles: s.number() }),
  ),
  sessionShared: defineEvent(
    "session.shared",
    s.object({ sessionId: idField, url: s.string() }),
  ),

  messageUpdated: defineEvent(
    "message.updated",
    s.object({ sessionId: idField, messageId: idField, role: s.string() }),
  ),
  messageRemoved: defineEvent(
    "message.removed",
    s.object({ sessionId: idField, messageId: idField }),
  ),
  partUpdated: defineEvent(
    "part.updated",
    s.object({
      sessionId: idField,
      messageId: idField,
      partId: idField,
      partType: s.string(),
    }),
  ),
  partDelta: defineEvent(
    "part.delta",
    s.object({
      sessionId: idField,
      messageId: idField,
      partId: idField,
      field: s.enum(["text", "reasoning"] as const),
      delta: s.string(),
    }),
  ),

  permissionRequested: defineEvent(
    "permission.requested",
    s.object({
      sessionId: idField,
      permissionId: idField,
      action: s.string(),
      resource: s.string(),
      title: s.string(),
      detail: s.string().optional(),
      patterns: s.array(s.string()).optional(),
    }),
  ),
  permissionResolved: defineEvent(
    "permission.resolved",
    s.object({
      sessionId: idField,
      permissionId: idField,
      decision: s.enum(["once", "always", "reject", "reject_always"] as const),
    }),
  ),

  toolStarted: defineEvent(
    "tool.started",
    s.object({
      sessionId: idField,
      callId: s.string(),
      tool: s.string(),
      title: s.string().optional(),
    }),
  ),
  toolProgress: defineEvent(
    "tool.progress",
    s.object({
      sessionId: idField,
      callId: s.string(),
      title: s.string().optional(),
      metadata: s.any().optional(),
    }),
  ),
  toolFinished: defineEvent(
    "tool.finished",
    s.object({
      sessionId: idField,
      callId: s.string(),
      tool: s.string(),
      ok: s.boolean(),
      durationMs: s.number(),
    }),
  ),

  fileChanged: defineEvent(
    "file.changed",
    s.object({
      path: s.string(),
      kind: s.enum(["create", "modify", "delete", "rename"] as const),
    }),
  ),
  fileEdited: defineEvent(
    "file.edited",
    s.object({
      sessionId: s.string().optional(),
      path: s.string(),
      added: s.number(),
      removed: s.number(),
    }),
  ),
  diagnosticsUpdated: defineEvent(
    "lsp.diagnostics",
    s.object({ path: s.string(), errors: s.number(), warnings: s.number() }),
  ),

  todoUpdated: defineEvent(
    "todo.updated",
    s.object({ sessionId: idField, total: s.number(), completed: s.number() }),
  ),

  providerRequest: defineEvent(
    "provider.request",
    s.object({
      sessionId: s.string().optional(),
      provider: s.string(),
      model: s.string(),
      attempt: s.number(),
    }),
  ),
  providerUsage: defineEvent(
    "provider.usage",
    s.object({
      sessionId: s.string().optional(),
      provider: s.string(),
      model: s.string(),
      inputTokens: s.number(),
      outputTokens: s.number(),
      reasoningTokens: s.number().optional(),
      cacheReadTokens: s.number().optional(),
      cacheWriteTokens: s.number().optional(),
      costUsd: s.number(),
    }),
  ),
  providerRateLimited: defineEvent(
    "provider.rate_limited",
    s.object({ provider: s.string(), retryAfterMs: s.number(), attempt: s.number() }),
  ),

  mcpConnected: defineEvent(
    "mcp.connected",
    s.object({ server: s.string(), tools: s.number(), transport: s.string() }),
  ),
  mcpDisconnected: defineEvent(
    "mcp.disconnected",
    s.object({ server: s.string(), reason: s.string().optional() }),
  ),

  configChanged: defineEvent("config.changed", s.object({ path: s.string().optional() })),
  installationUpdated: defineEvent(
    "installation.updated",
    s.object({ version: s.string(), latest: s.string() }),
  ),
  notification: defineEvent(
    "ui.notification",
    s.object({
      level: s.enum(["info", "success", "warn", "error"] as const),
      message: s.string(),
      detail: s.string().optional(),
      timeoutMs: s.number().optional(),
    }),
  ),
  logRecord: defineEvent(
    "log.record",
    s.object({
      level: s.string(),
      service: s.string(),
      message: s.string(),
      time: s.string(),
    }),
  ),
} as const
