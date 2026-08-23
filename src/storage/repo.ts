/**
 * Repositories.
 *
 * All SQL lives here so the domain layer never touches the database directly.
 * Row shapes are mapped to the domain types in `session/types.ts`; part payloads
 * are stored as JSON in a single column because their shape varies per type and
 * we never query inside them.
 */

import type {
  CompactionPart,
  FinishReason,
  Message,
  MessageError,
  MessageRole,
  Part,
  PartType,
  Session,
  SessionStats,
  Task,
  TaskStatus,
  Todo,
  TodoStatus,
  TokenUsage,
} from "../session/types.js"
import { emptyUsage } from "../session/types.js"
import { newId } from "../util/id.js"
import type { Database } from "./db.js"
import { database, fromBool, fromJson, toBool, toJson } from "./db.js"

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export interface Project {
  readonly id: string
  readonly root: string
  readonly name: string
  readonly vcs?: string
  readonly createdAt: number
  lastOpenedAt: number
}

export class ProjectRepo {
  constructor(private readonly db: Database = database()) {}

  /** Finds or creates the project row for a repository root. */
  ensure(root: string, name: string, vcs?: string): Project {
    const existing = this.byRoot(root)
    if (existing) {
      this.db.run("UPDATE project SET last_opened_at = ? WHERE id = ?", Date.now(), existing.id)
      return { ...existing, lastOpenedAt: Date.now() }
    }
    const project: Project = {
      id: newId("file"),
      root,
      name,
      vcs,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    }
    this.db.run(
      "INSERT INTO project (id, root, name, vcs, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)",
      project.id,
      project.root,
      project.name,
      project.vcs ?? null,
      project.createdAt,
      project.lastOpenedAt,
    )
    return project
  }

  byRoot(root: string): Project | undefined {
    const row = this.db.get<Record<string, any>>("SELECT * FROM project WHERE root = ?", root)
    return row ? mapProject(row) : undefined
  }

  byId(id: string): Project | undefined {
    const row = this.db.get<Record<string, any>>("SELECT * FROM project WHERE id = ?", id)
    return row ? mapProject(row) : undefined
  }

  list(): Project[] {
    return this.db
      .all<Record<string, any>>("SELECT * FROM project ORDER BY last_opened_at DESC")
      .map(mapProject)
  }
}

function mapProject(row: Record<string, any>): Project {
  return {
    id: String(row["id"]),
    root: String(row["root"]),
    name: String(row["name"]),
    vcs: row["vcs"] ?? undefined,
    createdAt: Number(row["created_at"]),
    lastOpenedAt: Number(row["last_opened_at"]),
  }
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export interface SessionListOptions {
  readonly projectId?: string
  readonly parentId?: string | null
  readonly includeArchived?: boolean
  readonly limit?: number
  readonly offset?: number
  readonly search?: string
}

export class SessionRepo {
  constructor(private readonly db: Database = database()) {}

  create(input: {
    projectId: string
    directory: string
    title?: string
    parentId?: string
    agent?: string
    model?: string
    metadata?: Record<string, unknown>
  }): Session {
    const now = Date.now()
    const session: Session = {
      id: newId("session"),
      projectId: input.projectId,
      parentId: input.parentId,
      title: input.title ?? "",
      directory: input.directory,
      agent: input.agent,
      model: input.model,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    }
    this.db.run(
      `INSERT INTO session
         (id, project_id, parent_id, title, directory, agent, model, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.projectId,
      session.parentId ?? null,
      session.title,
      session.directory,
      session.agent ?? null,
      session.model ?? null,
      session.createdAt,
      session.updatedAt,
      toJson(session.metadata),
    )
    return session
  }

  byId(id: string): Session | undefined {
    const row = this.db.get<Record<string, any>>("SELECT * FROM session WHERE id = ?", id)
    return row ? mapSession(row) : undefined
  }

  list(options: SessionListOptions = {}): Session[] {
    const clauses: string[] = []
    const params: Array<string | number | null> = []

    if (options.projectId) {
      clauses.push("project_id = ?")
      params.push(options.projectId)
    }
    if (options.parentId === null) clauses.push("parent_id IS NULL")
    else if (options.parentId !== undefined) {
      clauses.push("parent_id = ?")
      params.push(options.parentId)
    }
    if (!options.includeArchived) clauses.push("archived_at IS NULL")
    if (options.search) {
      clauses.push("title LIKE ?")
      params.push(`%${options.search}%`)
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    params.push(options.limit ?? 200, options.offset ?? 0)
    return this.db
      .all<Record<string, any>>(
        `SELECT * FROM session ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ...params,
      )
      .map(mapSession)
  }

  children(parentId: string): Session[] {
    return this.db
      .all<Record<string, any>>(
        "SELECT * FROM session WHERE parent_id = ? ORDER BY created_at",
        parentId,
      )
      .map(mapSession)
  }

  update(id: string, changes: Partial<Session>): void {
    const assignments: string[] = []
    const params: Array<string | number | null> = []

    const set = (column: string, value: string | number | null) => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }

    if (changes.title !== undefined) set("title", changes.title)
    if (changes.agent !== undefined) set("agent", changes.agent ?? null)
    if (changes.model !== undefined) set("model", changes.model ?? null)
    if (changes.archivedAt !== undefined) set("archived_at", changes.archivedAt ?? null)
    if (changes.shareUrl !== undefined) set("share_url", changes.shareUrl ?? null)
    if (changes.shareSecret !== undefined) set("share_secret", changes.shareSecret ?? null)
    if (changes.summary !== undefined) set("summary", changes.summary ?? null)
    if (changes.metadata !== undefined) set("metadata", toJson(changes.metadata))
    if (changes.revert !== undefined) {
      set("revert_message_id", changes.revert?.messageId ?? null)
      set("revert_part_id", changes.revert?.partId ?? null)
      set("revert_snapshot", changes.revert?.snapshotId ?? null)
      set("revert_diff", changes.revert?.diff ?? null)
    }

    set("updated_at", changes.updatedAt ?? Date.now())
    if (assignments.length === 0) return
    params.push(id)
    this.db.run(`UPDATE session SET ${assignments.join(", ")} WHERE id = ?`, ...params)
  }

  touch(id: string): void {
    this.db.run("UPDATE session SET updated_at = ? WHERE id = ?", Date.now(), id)
  }

  delete(id: string): void {
    // CASCADE removes messages, parts, todos, permissions and snapshots.
    this.db.run("DELETE FROM session WHERE id = ?", id)
  }

  stats(id: string): SessionStats {
    const row = this.db.get<Record<string, any>>(
      `SELECT
         COUNT(*) AS message_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(MIN(created_at), 0) AS first_at,
         COALESCE(MAX(COALESCE(completed_at, created_at)), 0) AS last_at
       FROM message WHERE session_id = ?`,
      id,
    )
    const toolCount =
      this.db.scalar<number>(
        "SELECT COUNT(*) FROM part WHERE session_id = ? AND type = 'tool'",
        id,
      ) ?? 0
    const files =
      this.db.scalar<number>("SELECT COUNT(*) FROM file_state WHERE session_id = ?", id) ?? 0

    return {
      messageCount: Number(row?.["message_count"] ?? 0),
      toolCallCount: Number(toolCount),
      inputTokens: Number(row?.["input_tokens"] ?? 0),
      outputTokens: Number(row?.["output_tokens"] ?? 0),
      reasoningTokens: Number(row?.["reasoning_tokens"] ?? 0),
      cacheReadTokens: Number(row?.["cache_read_tokens"] ?? 0),
      cacheWriteTokens: Number(row?.["cache_write_tokens"] ?? 0),
      costUsd: Number(row?.["cost_usd"] ?? 0),
      filesTouched: Number(files),
      durationMs: Math.max(0, Number(row?.["last_at"] ?? 0) - Number(row?.["first_at"] ?? 0)),
    }
  }

  /** Full-text search across message content. */
  search(query: string, limit = 40): Array<{ sessionId: string; messageId: string; snippet: string }> {
    if (query.trim() === "") return []
    const rows = this.db.all<Record<string, any>>(
      `SELECT session_id, message_id, snippet(part_fts, 0, '[', ']', '...', 12) AS snippet
       FROM part_fts WHERE part_fts MATCH ? ORDER BY rank LIMIT ?`,
      escapeFts(query),
      limit,
    )
    return rows.map((row) => ({
      sessionId: String(row["session_id"]),
      messageId: String(row["message_id"]),
      snippet: String(row["snippet"]),
    }))
  }
}

/** FTS5 treats several characters as operators; quote each term instead. */
function escapeFts(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" ")
}

function mapSession(row: Record<string, any>): Session {
  const revertMessageId = row["revert_message_id"]
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    parentId: row["parent_id"] ?? undefined,
    title: String(row["title"] ?? ""),
    directory: String(row["directory"]),
    agent: row["agent"] ?? undefined,
    model: row["model"] ?? undefined,
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
    archivedAt: row["archived_at"] === null ? undefined : Number(row["archived_at"]),
    shareUrl: row["share_url"] ?? undefined,
    shareSecret: row["share_secret"] ?? undefined,
    summary: row["summary"] ?? undefined,
    metadata: fromJson<Record<string, unknown> | undefined>(row["metadata"], undefined),
    revert: revertMessageId
      ? {
          messageId: String(revertMessageId),
          partId: row["revert_part_id"] ?? undefined,
          snapshotId: row["revert_snapshot"] ?? undefined,
          diff: row["revert_diff"] ?? undefined,
        }
      : undefined,
  }
}

/* ------------------------------------------------------------------ */
/* Messages and parts                                                  */
/* ------------------------------------------------------------------ */

export class MessageRepo {
  constructor(private readonly db: Database = database()) {}

  create(input: {
    sessionId: string
    role: MessageRole
    agent?: string
    providerId?: string
    modelId?: string
    systemPrompt?: string
    metadata?: Record<string, unknown>
  }): Message {
    const seq =
      (this.db.scalar<number>(
        "SELECT COALESCE(MAX(seq), 0) FROM message WHERE session_id = ?",
        input.sessionId,
      ) ?? 0) + 1
    const message: Message = {
      id: newId("message"),
      sessionId: input.sessionId,
      role: input.role,
      seq,
      createdAt: Date.now(),
      agent: input.agent,
      providerId: input.providerId,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      usage: emptyUsage(),
      costUsd: 0,
      metadata: input.metadata,
      parts: [],
    }
    this.db.run(
      `INSERT INTO message
         (id, session_id, role, seq, created_at, agent, provider_id, model_id, system_prompt, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id,
      message.sessionId,
      message.role,
      message.seq,
      message.createdAt,
      message.agent ?? null,
      message.providerId ?? null,
      message.modelId ?? null,
      message.systemPrompt ?? null,
      toJson(message.metadata),
    )
    return message
  }

  byId(id: string, withParts = true): Message | undefined {
    const row = this.db.get<Record<string, any>>("SELECT * FROM message WHERE id = ?", id)
    if (!row) return undefined
    const message = mapMessage(row)
    if (withParts) message.parts = new PartRepo(this.db).byMessage(id)
    return message
  }

  /**
   * Loads a session transcript. Parts are fetched in a single query and
   * bucketed in memory, which keeps this O(n) instead of N+1.
   */
  bySession(
    sessionId: string,
    options: { limit?: number; beforeSeq?: number; withParts?: boolean } = {},
  ): Message[] {
    const params: Array<string | number> = [sessionId]
    let where = "session_id = ?"
    if (options.beforeSeq !== undefined) {
      where += " AND seq < ?"
      params.push(options.beforeSeq)
    }
    const limit = options.limit ?? 10_000
    params.push(limit)

    const rows = this.db.all<Record<string, any>>(
      `SELECT * FROM message WHERE ${where} ORDER BY seq DESC LIMIT ?`,
      ...params,
    )
    const messages = rows.reverse().map(mapMessage)
    if (options.withParts === false || messages.length === 0) return messages

    const parts = new PartRepo(this.db).bySession(sessionId)
    const byMessage = new Map<string, Part[]>()
    for (const part of parts) {
      const bucket = byMessage.get(part.messageId)
      if (bucket) bucket.push(part)
      else byMessage.set(part.messageId, [part])
    }
    for (const message of messages) {
      message.parts = (byMessage.get(message.id) ?? []).sort((a, b) => a.seq - b.seq)
    }
    return messages
  }

  last(sessionId: string, role?: MessageRole): Message | undefined {
    const row = role
      ? this.db.get<Record<string, any>>(
          "SELECT * FROM message WHERE session_id = ? AND role = ? ORDER BY seq DESC LIMIT 1",
          sessionId,
          role,
        )
      : this.db.get<Record<string, any>>(
          "SELECT * FROM message WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
          sessionId,
        )
    if (!row) return undefined
    const message = mapMessage(row)
    message.parts = new PartRepo(this.db).byMessage(message.id)
    return message
  }

  count(sessionId: string): number {
    return Number(
      this.db.scalar<number>("SELECT COUNT(*) FROM message WHERE session_id = ?", sessionId) ?? 0,
    )
  }

  finish(
    id: string,
    input: {
      finishReason?: FinishReason
      usage?: TokenUsage
      costUsd?: number
      error?: MessageError
    },
  ): void {
    this.db.run(
      `UPDATE message SET
         completed_at = ?,
         finish_reason = ?,
         error = ?,
         input_tokens = ?,
         output_tokens = ?,
         reasoning_tokens = ?,
         cache_read_tokens = ?,
         cache_write_tokens = ?,
         cost_usd = ?
       WHERE id = ?`,
      Date.now(),
      input.finishReason ?? null,
      toJson(input.error),
      input.usage?.input ?? 0,
      input.usage?.output ?? 0,
      input.usage?.reasoning ?? 0,
      input.usage?.cacheRead ?? 0,
      input.usage?.cacheWrite ?? 0,
      input.costUsd ?? 0,
      id,
    )
  }

  /** Adds usage incrementally as steps complete within one message. */
  addUsage(id: string, usage: TokenUsage, costUsd: number): void {
    this.db.run(
      `UPDATE message SET
         input_tokens = input_tokens + ?,
         output_tokens = output_tokens + ?,
         reasoning_tokens = reasoning_tokens + ?,
         cache_read_tokens = cache_read_tokens + ?,
         cache_write_tokens = cache_write_tokens + ?,
         cost_usd = cost_usd + ?
       WHERE id = ?`,
      usage.input,
      usage.output,
      usage.reasoning,
      usage.cacheRead,
      usage.cacheWrite,
      costUsd,
      id,
    )
  }

  setModel(id: string, providerId: string, modelId: string): void {
    this.db.run(
      "UPDATE message SET provider_id = ?, model_id = ? WHERE id = ?",
      providerId,
      modelId,
      id,
    )
  }

  delete(id: string): void {
    this.db.run("DELETE FROM message WHERE id = ?", id)
  }

  /** Removes every message at or after `seq`; used by revert. */
  deleteFrom(sessionId: string, seq: number): string[] {
    const rows = this.db.all<{ id: string }>(
      "SELECT id FROM message WHERE session_id = ? AND seq >= ?",
      sessionId,
      seq,
    )
    this.db.run("DELETE FROM message WHERE session_id = ? AND seq >= ?", sessionId, seq)
    return rows.map((row) => row.id)
  }
}

function mapMessage(row: Record<string, any>): Message {
  return {
    id: String(row["id"]),
    sessionId: String(row["session_id"]),
    role: String(row["role"]) as MessageRole,
    seq: Number(row["seq"]),
    createdAt: Number(row["created_at"]),
    completedAt: row["completed_at"] === null ? undefined : Number(row["completed_at"]),
    agent: row["agent"] ?? undefined,
    providerId: row["provider_id"] ?? undefined,
    modelId: row["model_id"] ?? undefined,
    systemPrompt: row["system_prompt"] ?? undefined,
    finishReason: (row["finish_reason"] ?? undefined) as FinishReason | undefined,
    error: fromJson<MessageError | undefined>(row["error"], undefined),
    usage: {
      input: Number(row["input_tokens"] ?? 0),
      output: Number(row["output_tokens"] ?? 0),
      reasoning: Number(row["reasoning_tokens"] ?? 0),
      cacheRead: Number(row["cache_read_tokens"] ?? 0),
      cacheWrite: Number(row["cache_write_tokens"] ?? 0),
    },
    costUsd: Number(row["cost_usd"] ?? 0),
    metadata: fromJson<Record<string, unknown> | undefined>(row["metadata"], undefined),
    parts: [],
  }
}

export class PartRepo {
  constructor(private readonly db: Database = database()) {}

  /**
   * Inserts or replaces a part. Streaming deltas call this on every chunk, so
   * it must stay a single indexed upsert.
   */
  save(part: Part): void {
    const { text, payload } = splitPart(part)
    this.db.run(
      `INSERT INTO part
         (id, message_id, session_id, seq, type, text, payload, created_at, updated_at, state, tool_name, tool_call_id, synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         seq = excluded.seq,
         text = excluded.text,
         payload = excluded.payload,
         updated_at = excluded.updated_at,
         state = excluded.state,
         tool_name = excluded.tool_name,
         tool_call_id = excluded.tool_call_id`,
      part.id,
      part.messageId,
      part.sessionId,
      part.seq,
      part.type,
      text,
      payload,
      part.createdAt,
      part.updatedAt,
      partState(part),
      "toolName" in part ? (part.toolName as string) : null,
      "toolCallId" in part ? (part.toolCallId as string) : null,
      toBool(part.synthetic),
    )
  }

  byId(id: string): Part | undefined {
    const row = this.db.get<Record<string, any>>("SELECT * FROM part WHERE id = ?", id)
    return row ? mapPart(row) : undefined
  }

  byMessage(messageId: string): Part[] {
    return this.db
      .all<Record<string, any>>("SELECT * FROM part WHERE message_id = ? ORDER BY seq", messageId)
      .map(mapPart)
  }

  bySession(sessionId: string): Part[] {
    return this.db
      .all<Record<string, any>>(
        "SELECT * FROM part WHERE session_id = ? ORDER BY created_at, seq",
        sessionId,
      )
      .map(mapPart)
  }

  byToolCallId(toolCallId: string): Part | undefined {
    const row = this.db.get<Record<string, any>>(
      "SELECT * FROM part WHERE tool_call_id = ? ORDER BY created_at DESC LIMIT 1",
      toolCallId,
    )
    return row ? mapPart(row) : undefined
  }

  nextSeq(messageId: string): number {
    return (
      Number(
        this.db.scalar<number>(
          "SELECT COALESCE(MAX(seq), 0) FROM part WHERE message_id = ?",
          messageId,
        ) ?? 0,
      ) + 1
    )
  }

  delete(id: string): void {
    this.db.run("DELETE FROM part WHERE id = ?", id)
  }

  /** Every patch part in a session, used to build the cumulative diff. */
  patches(sessionId: string): Part[] {
    return this.db
      .all<Record<string, any>>(
        "SELECT * FROM part WHERE session_id = ? AND type = 'patch' ORDER BY created_at",
        sessionId,
      )
      .map(mapPart)
  }

  compactions(sessionId: string): CompactionPart[] {
    return this.db
      .all<Record<string, any>>(
        "SELECT * FROM part WHERE session_id = ? AND type = 'compaction' ORDER BY created_at",
        sessionId,
      )
      .map(mapPart) as CompactionPart[]
  }
}

/**
 * Text is stored in its own column so FTS triggers can index it without
 * parsing JSON; everything else goes into `payload`.
 */
function splitPart(part: Part): { text: string | null; payload: string | null } {
  const rest: Record<string, unknown> = {}
  let text: string | null = null
  for (const [key, value] of Object.entries(part)) {
    if (
      key === "id" ||
      key === "messageId" ||
      key === "sessionId" ||
      key === "seq" ||
      key === "type" ||
      key === "createdAt" ||
      key === "updatedAt" ||
      key === "synthetic"
    ) {
      continue
    }
    if (key === "text" && typeof value === "string") {
      text = value
      continue
    }
    rest[key] = value
  }
  return { text, payload: Object.keys(rest).length ? JSON.stringify(rest) : null }
}

function partState(part: Part): string | null {
  if (part.type === "tool") return part.state.status
  if (part.type === "text" || part.type === "reasoning") return part.state
  if (part.type === "agent") return part.status
  return null
}

function mapPart(row: Record<string, any>): Part {
  const payload = fromJson<Record<string, unknown>>(row["payload"], {})
  const base = {
    id: String(row["id"]),
    messageId: String(row["message_id"]),
    sessionId: String(row["session_id"]),
    type: String(row["type"]) as PartType,
    seq: Number(row["seq"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
    synthetic: fromBool(row["synthetic"]),
  }
  const text = row["text"] === null ? undefined : String(row["text"])
  return { ...base, ...payload, ...(text !== undefined ? { text } : {}) } as Part
}

/* ------------------------------------------------------------------ */
/* Todos                                                               */
/* ------------------------------------------------------------------ */

export class TodoRepo {
  constructor(private readonly db: Database = database()) {}

  list(sessionId: string): Todo[] {
    return this.db
      .all<Record<string, any>>("SELECT * FROM todo WHERE session_id = ? ORDER BY seq", sessionId)
      .map((row) => ({
        id: String(row["id"]),
        sessionId: String(row["session_id"]),
        seq: Number(row["seq"]),
        content: String(row["content"]),
        status: String(row["status"]) as TodoStatus,
        priority: row["priority"] ?? undefined,
        createdAt: Number(row["created_at"]),
        updatedAt: Number(row["updated_at"]),
        metadata: fromJson<Record<string, unknown> | undefined>(row["metadata"], undefined),
      }))
  }

  /**
   * Replaces the whole list. The `todowrite` tool always sends the complete
   * set, which makes reconciliation trivial and idempotent.
   */
  replace(
    sessionId: string,
    items: ReadonlyArray<{ id?: string; content: string; status: TodoStatus; priority?: string }>,
  ): Todo[] {
    return this.db.transaction(() => {
      this.db.run("DELETE FROM todo WHERE session_id = ?", sessionId)
      const now = Date.now()
      const out: Todo[] = []
      items.forEach((item, index) => {
        const todo: Todo = {
          id: item.id ?? newId("todo"),
          sessionId,
          seq: index + 1,
          content: item.content,
          status: item.status,
          priority: item.priority as Todo["priority"],
          createdAt: now,
          updatedAt: now,
        }
        this.db.run(
          `INSERT INTO todo (id, session_id, seq, content, status, priority, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          todo.id,
          sessionId,
          todo.seq,
          todo.content,
          todo.status,
          todo.priority ?? null,
          todo.createdAt,
          todo.updatedAt,
        )
        out.push(todo)
      })
      return out
    })
  }

  clear(sessionId: string): void {
    this.db.run("DELETE FROM todo WHERE session_id = ?", sessionId)
  }
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

export interface StoredPermission {
  readonly id: string
  readonly sessionId?: string
  readonly projectId?: string
  readonly action: string
  readonly pattern: string
  readonly effect: "allow" | "deny"
  readonly scope: "session" | "project" | "once"
  readonly createdAt: number
  readonly expiresAt?: number
}

export class PermissionRepo {
  constructor(private readonly db: Database = database()) {}

  grant(input: Omit<StoredPermission, "id" | "createdAt">): StoredPermission {
    const record: StoredPermission = { ...input, id: newId("permission"), createdAt: Date.now() }
    this.db.run(
      `INSERT INTO permission (id, session_id, project_id, action, pattern, effect, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET effect = excluded.effect, created_at = excluded.created_at`,
      record.id,
      record.sessionId ?? null,
      record.projectId ?? null,
      record.action,
      record.pattern,
      record.effect,
      record.scope,
      record.createdAt,
      record.expiresAt ?? null,
    )
    return record
  }

  list(sessionId?: string, projectId?: string): StoredPermission[] {
    const rows = this.db.all<Record<string, any>>(
      `SELECT * FROM permission
       WHERE (session_id IS ? OR project_id IS ?)
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
      sessionId ?? null,
      projectId ?? null,
      Date.now(),
    )
    return rows.map((row) => ({
      id: String(row["id"]),
      sessionId: row["session_id"] ?? undefined,
      projectId: row["project_id"] ?? undefined,
      action: String(row["action"]),
      pattern: String(row["pattern"]),
      effect: String(row["effect"]) as "allow" | "deny",
      scope: String(row["scope"]) as StoredPermission["scope"],
      createdAt: Number(row["created_at"]),
      expiresAt: row["expires_at"] === null ? undefined : Number(row["expires_at"]),
    }))
  }

  revoke(id: string): void {
    this.db.run("DELETE FROM permission WHERE id = ?", id)
  }

  revokeAll(sessionId?: string, projectId?: string): void {
    this.db.run(
      "DELETE FROM permission WHERE session_id IS ? OR project_id IS ?",
      sessionId ?? null,
      projectId ?? null,
    )
  }
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export class TaskRepo {
  constructor(private readonly db: Database = database()) {}

  create(input: {
    sessionId: string
    agent: string
    description: string
    parentPartId?: string
    depth: number
  }): Task {
    const task: Task = {
      id: newId("task"),
      sessionId: input.sessionId,
      agent: input.agent,
      description: input.description,
      parentPartId: input.parentPartId,
      status: "pending",
      createdAt: Date.now(),
      depth: input.depth,
    }
    this.db.run(
      `INSERT INTO task (id, session_id, parent_part_id, agent, description, status, created_at, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.sessionId,
      task.parentPartId ?? null,
      task.agent,
      task.description,
      task.status,
      task.createdAt,
      task.depth,
    )
    return task
  }

  update(id: string, changes: Partial<Task>): void {
    const assignments: string[] = []
    const params: Array<string | number | null> = []
    const set = (column: string, value: string | number | null) => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }
    if (changes.status !== undefined) set("status", changes.status)
    if (changes.childSessionId !== undefined) set("child_session_id", changes.childSessionId ?? null)
    if (changes.startedAt !== undefined) set("started_at", changes.startedAt ?? null)
    if (changes.finishedAt !== undefined) set("finished_at", changes.finishedAt ?? null)
    if (changes.result !== undefined) set("result", changes.result ?? null)
    if (changes.error !== undefined) set("error", changes.error ?? null)
    if (assignments.length === 0) return
    params.push(id)
    this.db.run(`UPDATE task SET ${assignments.join(", ")} WHERE id = ?`, ...params)
  }

  byId(id: string): Task | undefined {
    const row = this.db.get<Record<string, any>>("SELECT * FROM task WHERE id = ?", id)
    return row ? mapTask(row) : undefined
  }

  bySession(sessionId: string): Task[] {
    return this.db
      .all<Record<string, any>>(
        "SELECT * FROM task WHERE session_id = ? ORDER BY created_at",
        sessionId,
      )
      .map(mapTask)
  }

  running(): Task[] {
    return this.db
      .all<Record<string, any>>("SELECT * FROM task WHERE status IN ('pending', 'running')")
      .map(mapTask)
  }
}

function mapTask(row: Record<string, any>): Task {
  return {
    id: String(row["id"]),
    sessionId: String(row["session_id"]),
    childSessionId: row["child_session_id"] ?? undefined,
    parentPartId: row["parent_part_id"] ?? undefined,
    agent: String(row["agent"]),
    description: String(row["description"]),
    status: String(row["status"]) as TaskStatus,
    createdAt: Number(row["created_at"]),
    startedAt: row["started_at"] === null ? undefined : Number(row["started_at"]),
    finishedAt: row["finished_at"] === null ? undefined : Number(row["finished_at"]),
    result: row["result"] ?? undefined,
    error: row["error"] ?? undefined,
    depth: Number(row["depth"] ?? 1),
  }
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

export interface UsageRecord {
  readonly sessionId?: string
  readonly projectId?: string
  readonly providerId: string
  readonly modelId: string
  readonly usage: TokenUsage
  readonly costUsd: number
  readonly durationMs: number
}

export class UsageRepo {
  constructor(private readonly db: Database = database()) {}

  record(input: UsageRecord): void {
    this.db.run(
      `INSERT INTO usage
         (id, session_id, project_id, provider_id, model_id, created_at,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, duration_ms, request_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      newId("request"),
      input.sessionId ?? null,
      input.projectId ?? null,
      input.providerId,
      input.modelId,
      Date.now(),
      input.usage.input,
      input.usage.output,
      input.usage.reasoning,
      input.usage.cacheRead,
      input.usage.cacheWrite,
      input.costUsd,
      input.durationMs,
    )
  }

  summary(sinceMs?: number): Array<{
    providerId: string
    modelId: string
    requests: number
    inputTokens: number
    outputTokens: number
    costUsd: number
  }> {
    const since = sinceMs ?? 0
    return this.db
      .all<Record<string, any>>(
        `SELECT provider_id, model_id,
                SUM(request_count) AS requests,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd
         FROM usage WHERE created_at >= ?
         GROUP BY provider_id, model_id
         ORDER BY cost_usd DESC`,
        since,
      )
      .map((row) => ({
        providerId: String(row["provider_id"]),
        modelId: String(row["model_id"]),
        requests: Number(row["requests"]),
        inputTokens: Number(row["input_tokens"]),
        outputTokens: Number(row["output_tokens"]),
        costUsd: Number(row["cost_usd"]),
      }))
  }

  dailyCost(days = 30): Array<{ day: string; costUsd: number }> {
    return this.db
      .all<Record<string, any>>(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, SUM(cost_usd) AS cost_usd
         FROM usage WHERE created_at >= ?
         GROUP BY day ORDER BY day`,
        Date.now() - days * 86_400_000,
      )
      .map((row) => ({ day: String(row["day"]), costUsd: Number(row["cost_usd"]) }))
  }

  totalCost(): number {
    return Number(this.db.scalar<number>("SELECT COALESCE(SUM(cost_usd), 0) FROM usage") ?? 0)
  }
}

/* ------------------------------------------------------------------ */
/* Tool call log                                                       */
/* ------------------------------------------------------------------ */

export class ToolCallRepo {
  constructor(private readonly db: Database = database()) {}

  start(input: {
    sessionId: string
    messageId?: string
    partId?: string
    tool: string
    inputHash: string
  }): string {
    const id = newId("tool")
    this.db.run(
      `INSERT INTO tool_call (id, session_id, message_id, part_id, tool, input_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      id,
      input.sessionId,
      input.messageId ?? null,
      input.partId ?? null,
      input.tool,
      input.inputHash,
      Date.now(),
    )
    return id
  }

  finish(id: string, status: string, outputBytes: number, error?: string): void {
    this.db.run(
      `UPDATE tool_call SET status = ?, finished_at = ?,
         duration_ms = ? - created_at, output_bytes = ?, error = ?
       WHERE id = ?`,
      status,
      Date.now(),
      Date.now(),
      outputBytes,
      error ?? null,
      id,
    )
  }

  /**
   * Counts identical consecutive calls. The agent loop uses this to detect a
   * "doom loop" where the model repeats the same failing action forever.
   */
  consecutiveRepeats(sessionId: string, tool: string, inputHash: string): number {
    const rows = this.db.all<{ tool: string; input_hash: string }>(
      "SELECT tool, input_hash FROM tool_call WHERE session_id = ? ORDER BY created_at DESC LIMIT 8",
      sessionId,
    )
    let count = 0
    for (const row of rows) {
      if (row.tool === tool && row.input_hash === inputHash) count++
      else break
    }
    return count
  }

  stats(sinceMs?: number): Array<{ tool: string; calls: number; errors: number; avgMs: number }> {
    return this.db
      .all<Record<string, any>>(
        `SELECT tool,
                COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                AVG(COALESCE(duration_ms, 0)) AS avg_ms
         FROM tool_call WHERE created_at >= ?
         GROUP BY tool ORDER BY calls DESC`,
        sinceMs ?? 0,
      )
      .map((row) => ({
        tool: String(row["tool"]),
        calls: Number(row["calls"]),
        errors: Number(row["errors"]),
        avgMs: Math.round(Number(row["avg_ms"] ?? 0)),
      }))
  }
}
