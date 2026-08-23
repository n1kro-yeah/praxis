/**
 * Key-value store and small bookkeeping tables.
 *
 * Used for the things that are not conversation data but must survive restarts:
 * the last selected model, recently used agents, prompt history, per-file read
 * timestamps (which the edit tool checks to prevent clobbering external
 * changes), and frecency counters that drive picker ordering.
 */

import { newId } from "../util/id.js"
import { logger } from "../util/log.js"
import type { Database } from "./db.js"
import { database, fromJson, toJson } from "./db.js"

const log = logger("kv")

export class KeyValueStore {
  constructor(
    private readonly db: Database = database(),
    private readonly namespace = "default",
  ) {}

  scoped(namespace: string): KeyValueStore {
    return new KeyValueStore(this.db, namespace)
  }

  get<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value: string; expires_at: number | null }>(
      "SELECT value, expires_at FROM kv WHERE namespace = ? AND key = ?",
      this.namespace,
      key,
    )
    if (!row) return fallback
    if (row.expires_at !== null && row.expires_at < Date.now()) {
      this.delete(key)
      return fallback
    }
    return fromJson<T>(row.value, fallback)
  }

  has(key: string): boolean {
    return (
      this.db.scalar<number>(
        "SELECT 1 FROM kv WHERE namespace = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
        this.namespace,
        key,
        Date.now(),
      ) === 1
    )
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    const serialized = toJson(value)
    if (serialized === null) {
      this.delete(key)
      return
    }
    this.db.run(
      `INSERT INTO kv (namespace, key, value, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      this.namespace,
      key,
      serialized,
      Date.now(),
      ttlMs ? Date.now() + ttlMs : null,
    )
  }

  delete(key: string): void {
    this.db.run("DELETE FROM kv WHERE namespace = ? AND key = ?", this.namespace, key)
  }

  keys(prefix = ""): string[] {
    const rows = this.db.all<{ key: string }>(
      "SELECT key FROM kv WHERE namespace = ? AND key LIKE ? ORDER BY key",
      this.namespace,
      `${prefix}%`,
    )
    return rows.map((row) => row.key)
  }

  entries<T>(prefix = ""): Array<[string, T]> {
    const rows = this.db.all<{ key: string; value: string }>(
      "SELECT key, value FROM kv WHERE namespace = ? AND key LIKE ? ORDER BY key",
      this.namespace,
      `${prefix}%`,
    )
    return rows.map((row) => [row.key, fromJson<T>(row.value, undefined as T)])
  }

  clear(prefix = ""): void {
    this.db.run(
      "DELETE FROM kv WHERE namespace = ? AND key LIKE ?",
      this.namespace,
      `${prefix}%`,
    )
  }

  /** Atomically increments a numeric counter. */
  increment(key: string, delta = 1): number {
    return this.db.transaction(() => {
      const current = this.get<number>(key, 0)
      const next = current + delta
      this.set(key, next)
      return next
    })
  }

  /** Removes expired rows; called opportunistically at startup. */
  pruneExpired(): number {
    const result = this.db.run(
      "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < ?",
      Date.now(),
    )
    if (result.changes) log.debug("pruned expired kv rows", { count: result.changes })
    return result.changes
  }
}

/* ------------------------------------------------------------------ */
/* Well-known keys                                                     */
/* ------------------------------------------------------------------ */

export const KvKeys = {
  lastModel: "model.last",
  recentModels: "model.recent",
  modelVariants: "model.variants",
  lastAgent: "agent.last",
  lastSession: "session.last",
  lastTheme: "tui.theme",
  onboardingComplete: "onboarding.complete",
  autoupdateCheckedAt: "autoupdate.checkedAt",
  autoupdateLatest: "autoupdate.latest",
  catalogFetchedAt: "catalog.fetchedAt",
  installationId: "installation.id",
  tipIndex: "tui.tipIndex",
} as const

/* ------------------------------------------------------------------ */
/* Prompt history                                                      */
/* ------------------------------------------------------------------ */

export interface PromptHistoryEntry {
  readonly id: string
  readonly text: string
  readonly createdAt: number
  readonly sessionId?: string
}

export class PromptHistory {
  constructor(
    private readonly db: Database = database(),
    private readonly projectId?: string,
  ) {}

  add(text: string, sessionId?: string): void {
    const trimmed = text.trim()
    if (trimmed === "") return
    // Skip consecutive duplicates so arrow-up feels natural.
    const last = this.db.get<{ text: string }>(
      "SELECT text FROM prompt_history WHERE project_id IS ? ORDER BY created_at DESC LIMIT 1",
      this.projectId ?? null,
    )
    if (last?.text === trimmed) return
    this.db.run(
      "INSERT INTO prompt_history (id, project_id, session_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
      newId("request"),
      this.projectId ?? null,
      sessionId ?? null,
      trimmed,
      Date.now(),
    )
    this.trim()
  }

  list(limit = 200): PromptHistoryEntry[] {
    const rows = this.db.all<{
      id: string
      text: string
      created_at: number
      session_id: string | null
    }>(
      `SELECT id, text, created_at, session_id FROM prompt_history
       WHERE project_id IS ? ORDER BY created_at DESC LIMIT ?`,
      this.projectId ?? null,
      limit,
    )
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      createdAt: Number(row.created_at),
      sessionId: row.session_id ?? undefined,
    }))
  }

  search(query: string, limit = 50): PromptHistoryEntry[] {
    const rows = this.db.all<{ id: string; text: string; created_at: number }>(
      `SELECT id, text, created_at FROM prompt_history
       WHERE project_id IS ? AND text LIKE ?
       ORDER BY created_at DESC LIMIT ?`,
      this.projectId ?? null,
      `%${query}%`,
      limit,
    )
    return rows.map((row) => ({ id: row.id, text: row.text, createdAt: Number(row.created_at) }))
  }

  private trim(keep = 2_000): void {
    this.db.run(
      `DELETE FROM prompt_history WHERE project_id IS ? AND id NOT IN (
         SELECT id FROM prompt_history WHERE project_id IS ? ORDER BY created_at DESC LIMIT ?
       )`,
      this.projectId ?? null,
      this.projectId ?? null,
      keep,
    )
  }

  clear(): void {
    this.db.run("DELETE FROM prompt_history WHERE project_id IS ?", this.projectId ?? null)
  }
}

/* ------------------------------------------------------------------ */
/* Frecency                                                            */
/* ------------------------------------------------------------------ */

export type AccessKind = "file" | "model" | "agent" | "command" | "session" | "skill"

export interface AccessEntry {
  readonly identifier: string
  readonly count: number
  readonly lastAt: number
  /** Combined recency + frequency score used for picker ordering. */
  readonly score: number
}

export class AccessLog {
  constructor(
    private readonly db: Database = database(),
    private readonly projectId?: string,
  ) {}

  record(kind: AccessKind, identifier: string): void {
    if (identifier === "") return
    this.db.run(
      `INSERT INTO access_log (kind, identifier, project_id, count, last_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (kind, identifier, COALESCE(project_id, '')) DO UPDATE SET
         count = count + 1,
         last_at = excluded.last_at`,
      kind,
      identifier,
      this.projectId ?? null,
      Date.now(),
    )
  }

  top(kind: AccessKind, limit = 50): AccessEntry[] {
    const rows = this.db.all<{ identifier: string; count: number; last_at: number }>(
      `SELECT identifier, count, last_at FROM access_log
       WHERE kind = ? AND (project_id IS ? OR project_id IS NULL)
       ORDER BY last_at DESC LIMIT ?`,
      kind,
      this.projectId ?? null,
      limit * 4,
    )
    const now = Date.now()
    return rows
      .map((row) => ({
        identifier: row.identifier,
        count: Number(row.count),
        lastAt: Number(row.last_at),
        score: frecencyScore(Number(row.count), Number(row.last_at), now),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  scores(kind: AccessKind): Map<string, number> {
    const out = new Map<string, number>()
    for (const entry of this.top(kind, 500)) out.set(entry.identifier, entry.score)
    return out
  }

  forget(kind: AccessKind, identifier: string): void {
    this.db.run(
      "DELETE FROM access_log WHERE kind = ? AND identifier = ? AND (project_id IS ?)",
      kind,
      identifier,
      this.projectId ?? null,
    )
  }

  /** Drops entries not touched in six months. */
  prune(): void {
    this.db.run("DELETE FROM access_log WHERE last_at < ?", Date.now() - 180 * 86_400_000)
  }
}

/**
 * Mozilla-style frecency: a frequency count weighted by how recently each
 * access happened. We only store an aggregate count, so recency is applied as
 * a decay multiplier rather than per-visit bucketing.
 */
function frecencyScore(count: number, lastAt: number, now: number): number {
  const ageHours = Math.max(0, (now - lastAt) / 3_600_000)
  const recency =
    ageHours < 1 ? 100 : ageHours < 24 ? 70 : ageHours < 24 * 7 ? 40 : ageHours < 24 * 30 ? 15 : 4
  return Math.log1p(count) * recency
}

/* ------------------------------------------------------------------ */
/* File read/write state                                               */
/* ------------------------------------------------------------------ */

export interface FileState {
  readonly path: string
  readonly readAt?: number
  readonly writtenAt?: number
  readonly mtime?: number
  readonly size?: number
  readonly hash?: string
}

/**
 * Tracks when the agent last read each file.
 *
 * The edit tool refuses to modify a file it has not read, and refuses to modify
 * one that changed on disk since the read. Without this the model happily
 * overwrites a user's concurrent edits, which is the single most damaging
 * failure mode of a coding agent.
 */
export class FileStateStore {
  constructor(
    private readonly db: Database = database(),
    private readonly sessionId: string,
  ) {}

  markRead(path: string, mtime: number, size: number, hash?: string): void {
    this.db.run(
      `INSERT INTO file_state (path, session_id, read_at, mtime, size, hash)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, path) DO UPDATE SET
         read_at = excluded.read_at,
         mtime = excluded.mtime,
         size = excluded.size,
         hash = excluded.hash`,
      path,
      this.sessionId,
      Date.now(),
      mtime,
      size,
      hash ?? null,
    )
  }

  markWritten(path: string, mtime: number, size: number, hash?: string): void {
    this.db.run(
      `INSERT INTO file_state (path, session_id, read_at, written_at, mtime, size, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, path) DO UPDATE SET
         read_at = COALESCE(file_state.read_at, excluded.read_at),
         written_at = excluded.written_at,
         mtime = excluded.mtime,
         size = excluded.size,
         hash = excluded.hash`,
      path,
      this.sessionId,
      Date.now(),
      Date.now(),
      mtime,
      size,
      hash ?? null,
    )
  }

  get(path: string): FileState | undefined {
    const row = this.db.get<{
      path: string
      read_at: number | null
      written_at: number | null
      mtime: number | null
      size: number | null
      hash: string | null
    }>("SELECT * FROM file_state WHERE session_id = ? AND path = ?", this.sessionId, path)
    if (!row) return undefined
    return {
      path: row.path,
      readAt: row.read_at ?? undefined,
      writtenAt: row.written_at ?? undefined,
      mtime: row.mtime ?? undefined,
      size: row.size ?? undefined,
      hash: row.hash ?? undefined,
    }
  }

  hasRead(path: string): boolean {
    return this.get(path)?.readAt !== undefined
  }

  /** Every file this session has touched, newest first. */
  touched(): FileState[] {
    const rows = this.db.all<{
      path: string
      read_at: number | null
      written_at: number | null
      mtime: number | null
      size: number | null
      hash: string | null
    }>(
      `SELECT * FROM file_state WHERE session_id = ?
       ORDER BY COALESCE(written_at, read_at) DESC`,
      this.sessionId,
    )
    return rows.map((row) => ({
      path: row.path,
      readAt: row.read_at ?? undefined,
      writtenAt: row.written_at ?? undefined,
      mtime: row.mtime ?? undefined,
      size: row.size ?? undefined,
      hash: row.hash ?? undefined,
    }))
  }

  /** Files the agent modified, used to build the session diff. */
  modified(): string[] {
    const rows = this.db.all<{ path: string }>(
      "SELECT path FROM file_state WHERE session_id = ? AND written_at IS NOT NULL ORDER BY written_at",
      this.sessionId,
    )
    return rows.map((row) => row.path)
  }

  forget(path: string): void {
    this.db.run("DELETE FROM file_state WHERE session_id = ? AND path = ?", this.sessionId, path)
  }

  clear(): void {
    this.db.run("DELETE FROM file_state WHERE session_id = ?", this.sessionId)
  }
}

/* ------------------------------------------------------------------ */
/* Plugin state                                                        */
/* ------------------------------------------------------------------ */

export class PluginStore {
  constructor(
    private readonly plugin: string,
    private readonly db: Database = database(),
  ) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value: string }>(
      "SELECT value FROM plugin_state WHERE plugin = ? AND key = ?",
      this.plugin,
      key,
    )
    return row ? fromJson<T>(row.value, fallback) : fallback
  }

  set(key: string, value: unknown): void {
    const serialized = toJson(value)
    if (serialized === null) {
      this.db.run("DELETE FROM plugin_state WHERE plugin = ? AND key = ?", this.plugin, key)
      return
    }
    this.db.run(
      `INSERT INTO plugin_state (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (plugin, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      this.plugin,
      key,
      serialized,
      Date.now(),
    )
  }

  keys(): string[] {
    return this.db
      .all<{ key: string }>("SELECT key FROM plugin_state WHERE plugin = ? ORDER BY key", this.plugin)
      .map((row) => row.key)
  }

  clear(): void {
    this.db.run("DELETE FROM plugin_state WHERE plugin = ?", this.plugin)
  }
}

/* ------------------------------------------------------------------ */
/* Convenience singletons                                              */
/* ------------------------------------------------------------------ */

let globalKv: KeyValueStore | undefined

export function kv(): KeyValueStore {
  if (!globalKv) globalKv = new KeyValueStore()
  return globalKv
}

export function resetKv(): void {
  globalKv = undefined
}
