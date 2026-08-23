/**
 * Session lifecycle: creation, listing, mutation, and message persistence.
 *
 * A session is the unit of work. It owns a conversation, a working directory, a
 * model selection, an agent, a todo list, a permission scope, and a chain of
 * snapshots. Everything is persisted immediately rather than at the end, because
 * the process can be killed at any moment — a user pressing Ctrl+C mid-stream is
 * the normal way to interrupt an agent, not an error case — and a session that
 * loses the last exchange on interrupt would be useless.
 *
 * The interesting design decisions:
 *
 *  - **Parts, not messages, are the unit of streaming.** A single assistant
 *    message contains text parts, reasoning parts, and tool-call parts, each
 *    appearing incrementally. Storing them separately means the UI can render a
 *    partial message and a resumed session can show exactly where it stopped.
 *  - **Sessions form a tree.** A subagent's session has the parent's id, so the
 *    full trace of a delegated task is inspectable and its cost rolls up.
 *  - **Titles are generated lazily** by a small model after the first exchange.
 *    Doing it eagerly would delay the first response; not doing it at all leaves
 *    the session list unusable.
 *  - **Revert points are per-message.** Undo means "put the files back as they
 *    were before message N and drop everything after", which requires a snapshot
 *    per user turn, not per tool call.
 */

import { resolve } from "node:path"

import { logger } from "../util/log.js"
import { newId } from "../util/id.js"
import { Bus, Events } from "../util/bus.js"
import { NotFoundError } from "../util/error.js"
import { truncate } from "../util/string.js"
import {
  messageRepo,
  partRepo,
  projectRepo,
  sessionRepo,
  todoRepo,
  usageRepo,
} from "../storage/repo.js"
import { snapshotStore, snapshotsAdvisable, type Snapshot } from "../git/snapshot.js"
import type {
  MessageRecord,
  MessageRole,
  PartRecord,
  PartType,
  SessionRecord,
  TokenUsage,
} from "./types.js"

const log = logger("session")

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

export interface CreateSessionOptions {
  readonly cwd: string
  readonly title?: string
  readonly agent?: string
  readonly model?: string
  /** Parent session, set when this is a subagent run. */
  readonly parentId?: string
  /** Depth in the delegation tree. */
  readonly depth?: number
  /** Marks internal sessions (title generation, compaction) so they are hidden. */
  readonly internal?: boolean
}

/**
 * Creates a session and its project row.
 *
 * The project row exists so that permissions, snapshots, and session history are
 * scoped per directory: approving `rm -rf build` in one project must not approve
 * it everywhere.
 */
export function create(options: CreateSessionOptions): SessionRecord {
  const cwd = resolve(options.cwd)
  const project = projectRepo().ensure(cwd)

  const record: SessionRecord = {
    id: newId("session"),
    projectId: project.id,
    parentId: options.parentId,
    title: options.title ?? "",
    cwd,
    agent: options.agent ?? "build",
    model: options.model,
    depth: options.depth ?? 0,
    internal: options.internal ?? false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    archived: false,
    shareId: undefined,
    revertMessageId: undefined,
  }

  sessionRepo().insert(record)

  if (!record.internal) {
    Bus.publish(Events.sessionCreated, { sessionId: record.id, cwd, agent: record.agent })
    log.info("session created", { id: record.id, agent: record.agent })
  }

  return record
}

export function get(sessionId: string): SessionRecord {
  const record = sessionRepo().get(sessionId)
  if (!record) throw new NotFoundError(`Session ${sessionId} does not exist.`)
  return record
}

export function find(sessionId: string): SessionRecord | undefined {
  return sessionRepo().get(sessionId)
}

/**
 * Lists sessions for a directory, newest first.
 *
 * Internal sessions are excluded by default: a user opening the session picker
 * wants their conversations, not the twenty title-generation calls that produced
 * their names.
 */
export function list(options: {
  cwd?: string
  limit?: number
  includeArchived?: boolean
  includeInternal?: boolean
  includeChildren?: boolean
} = {}): SessionRecord[] {
  const projectId = options.cwd ? projectRepo().ensure(resolve(options.cwd)).id : undefined
  return sessionRepo().list({
    projectId,
    limit: options.limit ?? 50,
    includeArchived: options.includeArchived ?? false,
    includeInternal: options.includeInternal ?? false,
    includeChildren: options.includeChildren ?? false,
  })
}

/** Child sessions, i.e. subagent runs spawned from this one. */
export function children(sessionId: string): SessionRecord[] {
  return sessionRepo().children(sessionId)
}

export function update(sessionId: string, changes: Partial<SessionRecord>): SessionRecord {
  const updated = sessionRepo().update(sessionId, { ...changes, updatedAt: Date.now() })
  Bus.publish(Events.sessionUpdated, { sessionId, changes: Object.keys(changes) })
  return updated
}

export function rename(sessionId: string, title: string): void {
  update(sessionId, { title: title.slice(0, 200) })
}

export function archive(sessionId: string): void {
  update(sessionId, { archived: true })
}

export function unarchive(sessionId: string): void {
  update(sessionId, { archived: false })
}

/**
 * Deletes a session and everything under it.
 *
 * Child sessions are deleted too, because an orphaned subagent trace is noise.
 * The cascade is enforced by foreign keys in the schema; this call exists to also
 * clear the in-memory caches that key off the session id.
 */
export function remove(sessionId: string): void {
  for (const child of sessionRepo().children(sessionId)) remove(child.id)
  sessionRepo().remove(sessionId)
  Bus.publish(Events.sessionDeleted, { sessionId })
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export interface AppendMessageOptions {
  readonly sessionId: string
  readonly role: MessageRole
  readonly model?: string
  readonly agent?: string
  /** Whether this message should be hidden from the transcript view. */
  readonly hidden?: boolean
}

/**
 * Starts a new message.
 *
 * Created empty and filled by appending parts as the stream arrives, which is
 * what allows the UI to render a response while it is still being produced.
 */
export function beginMessage(options: AppendMessageOptions): MessageRecord {
  const session = get(options.sessionId)

  const record: MessageRecord = {
    id: newId("message"),
    sessionId: options.sessionId,
    role: options.role,
    model: options.model ?? session.model,
    agent: options.agent ?? session.agent,
    createdAt: Date.now(),
    completedAt: undefined,
    hidden: options.hidden ?? false,
    error: undefined,
    finishReason: undefined,
    usage: undefined,
    cost: 0,
    snapshotRef: undefined,
  }

  messageRepo().insert(record)
  sessionRepo().update(options.sessionId, {
    messageCount: session.messageCount + 1,
    updatedAt: Date.now(),
  })

  Bus.publish(Events.messageStarted, {
    sessionId: options.sessionId,
    messageId: record.id,
    role: record.role,
  })

  return record
}

/**
 * Marks a message complete and records its cost.
 *
 * Usage is stored on the message rather than only aggregated on the session so
 * that per-message cost is inspectable — which is how a user discovers that one
 * runaway tool loop cost them a dollar.
 */
export function completeMessage(
  messageId: string,
  options: {
    usage?: TokenUsage
    cost?: number
    finishReason?: string
    error?: string
  } = {},
): void {
  const message = messageRepo().get(messageId)
  if (!message) return

  messageRepo().update(messageId, {
    completedAt: Date.now(),
    usage: options.usage,
    cost: options.cost ?? 0,
    finishReason: options.finishReason,
    error: options.error,
  })

  if (options.usage) {
    const session = sessionRepo().get(message.sessionId)
    if (session) {
      sessionRepo().update(message.sessionId, {
        inputTokens: session.inputTokens + (options.usage.input ?? 0),
        outputTokens: session.outputTokens + (options.usage.output ?? 0),
        cacheReadTokens: session.cacheReadTokens + (options.usage.cacheRead ?? 0),
        cacheWriteTokens: session.cacheWriteTokens + (options.usage.cacheWrite ?? 0),
        cost: session.cost + (options.cost ?? 0),
        updatedAt: Date.now(),
      })
    }

    usageRepo().record({
      sessionId: message.sessionId,
      messageId,
      model: message.model ?? "unknown",
      usage: options.usage,
      cost: options.cost ?? 0,
      at: Date.now(),
    })
  }

  Bus.publish(Events.messageCompleted, {
    sessionId: message.sessionId,
    messageId,
    cost: options.cost ?? 0,
    finishReason: options.finishReason,
  })
}

export function messages(
  sessionId: string,
  options: { limit?: number; includeHidden?: boolean } = {},
): MessageRecord[] {
  return messageRepo().list(sessionId, options)
}

export function lastMessage(sessionId: string): MessageRecord | undefined {
  return messageRepo().last(sessionId)
}

/* ------------------------------------------------------------------ */
/* Parts                                                               */
/* ------------------------------------------------------------------ */

export interface AppendPartOptions {
  readonly sessionId: string
  readonly messageId: string
  readonly type: PartType
  readonly text?: string
  readonly toolName?: string
  readonly toolCallId?: string
  readonly input?: unknown
  readonly output?: string
  readonly metadata?: Record<string, unknown>
  readonly isError?: boolean
}

export function appendPart(options: AppendPartOptions): PartRecord {
  const record: PartRecord = {
    id: newId("part"),
    sessionId: options.sessionId,
    messageId: options.messageId,
    type: options.type,
    text: options.text,
    toolName: options.toolName,
    toolCallId: options.toolCallId,
    input: options.input,
    output: options.output,
    metadata: options.metadata,
    isError: options.isError ?? false,
    createdAt: Date.now(),
    completedAt: options.type === "text" || options.type === "reasoning" ? undefined : Date.now(),
  }

  partRepo().insert(record)

  Bus.publish(Events.partAppended, {
    sessionId: options.sessionId,
    messageId: options.messageId,
    partId: record.id,
    type: record.type,
  })

  return record
}

/**
 * Appends text to an existing part, or creates one.
 *
 * Streaming text arrives as many small deltas. Writing a row per delta would
 * produce thousands of rows per message; instead the delta is appended to the
 * open part. The database write is debounced by the caller, so a fast stream
 * produces a handful of writes rather than one per token.
 */
export function appendText(
  partId: string,
  delta: string,
): void {
  partRepo().appendText(partId, delta)
}

export function completePart(
  partId: string,
  changes: {
    text?: string
    output?: string
    metadata?: Record<string, unknown>
    isError?: boolean
  } = {},
): void {
  partRepo().update(partId, { ...changes, completedAt: Date.now() })

  const part = partRepo().get(partId)
  if (part) {
    Bus.publish(Events.partCompleted, {
      sessionId: part.sessionId,
      messageId: part.messageId,
      partId,
      type: part.type,
    })
  }
}

export function parts(messageId: string): PartRecord[] {
  return partRepo().list(messageId)
}

/** Every part in a session, used to rebuild the LLM conversation. */
export function allParts(sessionId: string): PartRecord[] {
  return partRepo().listBySession(sessionId)
}

/* ------------------------------------------------------------------ */
/* Snapshots and revert                                                */
/* ------------------------------------------------------------------ */

/**
 * Takes a snapshot before a user turn, so the turn can be undone.
 *
 * Best-effort and never blocking: a snapshot failure must not prevent the user
 * from getting a response. If snapshots are not advisable for this directory
 * (a home directory, an enormous non-git tree) none is taken and undo will report
 * that honestly rather than restoring the wrong thing.
 */
export async function snapshot(
  sessionId: string,
  messageId: string,
  label: string,
): Promise<Snapshot | undefined> {
  const session = get(sessionId)
  if (!snapshotsAdvisable(session.cwd)) return undefined

  try {
    const store = snapshotStore({ cwd: session.cwd, projectId: session.projectId })
    const created = await store.create(label)
    if (created) {
      messageRepo().update(messageId, { snapshotRef: created.ref })
      log.debug("snapshot taken", { sessionId, ref: created.ref.slice(0, 8) })
    }
    return created
  } catch (error) {
    log.debug("snapshot failed", { error: String(error) })
    return undefined
  }
}

export interface RevertPreview {
  readonly messageId: string
  readonly messagesRemoved: number
  readonly filesChanged: readonly string[]
  readonly available: boolean
  readonly reason?: string
}

/**
 * Describes what an undo would do, without doing it.
 *
 * Shown to the user before they confirm. An undo that silently reverts files
 * they edited by hand would be a disaster, so the file list is explicit.
 */
export async function previewRevert(
  sessionId: string,
  messageId?: string,
): Promise<RevertPreview> {
  const session = get(sessionId)
  const all = messageRepo().list(sessionId, { includeHidden: true })

  // Default target: the most recent user message that has a snapshot.
  const target = messageId
    ? all.find((message) => message.id === messageId)
    : [...all].reverse().find((message) => message.role === "user" && message.snapshotRef)

  if (!target) {
    return {
      messageId: "",
      messagesRemoved: 0,
      filesChanged: [],
      available: false,
      reason: "There is no earlier turn to revert to.",
    }
  }

  const index = all.findIndex((message) => message.id === target.id)
  const messagesRemoved = all.length - index

  if (!target.snapshotRef) {
    return {
      messageId: target.id,
      messagesRemoved,
      filesChanged: [],
      available: true,
      reason: "No file snapshot exists for that turn, so only the conversation will be reverted.",
    }
  }

  const store = snapshotStore({ cwd: session.cwd, projectId: session.projectId })
  const changed = await store.changedSince({
    id: "",
    ref: target.snapshotRef,
    createdAt: target.createdAt,
    label: "",
    backend: "git",
    fileCount: 0,
  })

  return {
    messageId: target.id,
    messagesRemoved,
    filesChanged: changed,
    available: true,
  }
}

export interface RevertResult {
  readonly messageId: string
  readonly messagesRemoved: number
  readonly filesRestored: readonly string[]
  readonly filesDeleted: readonly string[]
  readonly failed: ReadonlyArray<{ path: string; reason: string }>
}

/**
 * Reverts the session and the filesystem to before a message.
 *
 * Messages are marked reverted rather than deleted so a redo is possible: an
 * accidental undo of twenty minutes of work would otherwise be unrecoverable.
 * The session's `revertMessageId` records the boundary, and everything at or
 * after it is excluded when building the conversation for the model.
 */
export async function revert(sessionId: string, messageId?: string): Promise<RevertResult> {
  const session = get(sessionId)
  const preview = await previewRevert(sessionId, messageId)

  if (!preview.available) {
    return {
      messageId: "",
      messagesRemoved: 0,
      filesRestored: [],
      filesDeleted: [],
      failed: [{ path: "*", reason: preview.reason ?? "nothing to revert" }],
    }
  }

  const target = messageRepo().get(preview.messageId)!

  let restored: readonly string[] = []
  let deleted: readonly string[] = []
  let failed: ReadonlyArray<{ path: string; reason: string }> = []

  if (target.snapshotRef) {
    const store = snapshotStore({ cwd: session.cwd, projectId: session.projectId })
    const result = await store.restore({
      id: "",
      ref: target.snapshotRef,
      createdAt: target.createdAt,
      label: "",
      backend: "git",
      fileCount: 0,
    })
    restored = result.restored
    deleted = result.deleted
    failed = result.failed
  }

  sessionRepo().update(sessionId, { revertMessageId: target.id, updatedAt: Date.now() })

  Bus.publish(Events.sessionReverted, {
    sessionId,
    messageId: target.id,
    filesRestored: restored.length,
  })

  log.info("session reverted", {
    sessionId,
    messageId: target.id,
    files: restored.length + deleted.length,
  })

  return {
    messageId: target.id,
    messagesRemoved: preview.messagesRemoved,
    filesRestored: restored,
    filesDeleted: deleted,
    failed,
  }
}

/**
 * Undoes an undo.
 *
 * Only the conversation is restored, not the files: re-applying the file changes
 * would require snapshotting the reverted state, and the messages contain enough
 * information for the agent to redo the work if asked. Being explicit about this
 * is better than pretending to a fidelity we do not have.
 */
export function unrevert(sessionId: string): boolean {
  const session = get(sessionId)
  if (!session.revertMessageId) return false
  sessionRepo().update(sessionId, { revertMessageId: undefined, updatedAt: Date.now() })
  Bus.publish(Events.sessionUnreverted, { sessionId })
  return true
}

/** Messages that are live, i.e. before the revert boundary. */
export function activeMessages(sessionId: string): MessageRecord[] {
  const session = get(sessionId)
  const all = messageRepo().list(sessionId, { includeHidden: true })
  if (!session.revertMessageId) return all

  const boundary = all.findIndex((message) => message.id === session.revertMessageId)
  return boundary === -1 ? all : all.slice(0, boundary)
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

export interface SessionStats {
  readonly messages: number
  readonly toolCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cost: number
  readonly durationMs: number
  readonly filesEdited: number
  readonly childSessions: number
  /** Cost including every subagent run, which is what the user actually pays. */
  readonly totalCost: number
}

/**
 * Aggregates the numbers shown in the status bar and the `stats` command.
 *
 * Rolling up child sessions matters: a task that delegated ten subagents shows a
 * misleadingly small cost otherwise, and the discrepancy between the displayed
 * cost and the provider's bill destroys trust.
 */
export function stats(sessionId: string): SessionStats {
  const session = get(sessionId)
  const childSessions = sessionRepo().children(sessionId)

  let totalCost = session.cost
  for (const child of childSessions) {
    totalCost += stats(child.id).totalCost
  }

  const allParts = partRepo().listBySession(sessionId)
  const toolCalls = allParts.filter((part) => part.type === "tool-call").length
  const filesEdited = new Set(
    allParts
      .filter((part) => part.toolName === "edit" || part.toolName === "write" || part.toolName === "multiedit")
      .map((part) => String((part.input as { path?: string } | undefined)?.path ?? ""))
      .filter(Boolean),
  ).size

  return {
    messages: session.messageCount,
    toolCalls,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheReadTokens: session.cacheReadTokens,
    cost: session.cost,
    durationMs: session.updatedAt - session.createdAt,
    filesEdited,
    childSessions: childSessions.length,
    totalCost,
  }
}

/* ------------------------------------------------------------------ */
/* Titles                                                              */
/* ------------------------------------------------------------------ */

/**
 * A placeholder title derived from the first user message.
 *
 * Used immediately so the session list is never full of blanks, and replaced by
 * the generated title when the small model answers. Heuristic rather than clever:
 * the first line, trimmed of politeness, capped at a readable length.
 */
export function provisionalTitle(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#")) ?? text

  const cleaned = firstLine
    .replace(/^(please|could you|can you|hey|hi|help me|i need to|i want to|let's)\s+/i, "")
    .replace(/[.?!]+$/, "")
    .trim()

  const capped = truncate(cleaned, 60)
  return capped.charAt(0).toUpperCase() + capped.slice(1)
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

/**
 * Deletes sessions that contain nothing.
 *
 * Opening the TUI creates a session; quitting without typing leaves an empty one
 * behind. Without this, the session list fills with blanks and becomes useless.
 */
export function pruneEmpty(cwd?: string): number {
  const candidates = list({ cwd, limit: 500, includeInternal: true })
  let removed = 0

  for (const session of candidates) {
    if (session.messageCount > 0) continue
    // Keep very recent ones: the user may be about to type in them.
    if (Date.now() - session.createdAt < 60_000) continue
    remove(session.id)
    removed++
  }

  if (removed > 0) log.debug("pruned empty sessions", { count: removed })
  return removed
}

/** Clears the todo list, used when a session is reused for a new task. */
export function clearTodos(sessionId: string): void {
  todoRepo().replace(sessionId, [])
}

/**
 * Duplicates a session's conversation into a new one.
 *
 * Used by "fork": exploring an alternative approach without losing the original
 * thread. Parts are copied rather than referenced so the two sessions diverge
 * cleanly.
 */
export function fork(sessionId: string, options: { title?: string } = {}): SessionRecord {
  const source = get(sessionId)

  const created = create({
    cwd: source.cwd,
    title: options.title ?? `${source.title} (fork)`,
    agent: source.agent,
    model: source.model,
  })

  for (const message of activeMessages(sessionId)) {
    const copied = beginMessage({
      sessionId: created.id,
      role: message.role,
      model: message.model,
      agent: message.agent,
      hidden: message.hidden,
    })

    for (const part of partRepo().list(message.id)) {
      appendPart({
        sessionId: created.id,
        messageId: copied.id,
        type: part.type,
        text: part.text,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        input: part.input,
        output: part.output,
        metadata: part.metadata,
        isError: part.isError,
      })
    }

    completeMessage(copied.id, {
      usage: message.usage,
      cost: message.cost,
      finishReason: message.finishReason,
    })
  }

  log.info("session forked", { from: sessionId, to: created.id })
  return get(created.id)
}
