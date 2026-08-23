/**
 * SQLite storage layer.
 *
 * Built on Node's native `node:sqlite`, which gives us a synchronous,
 * dependency-free embedded database. Synchronous access is a feature here: the
 * agent loop reads and writes the conversation constantly, and avoiding the
 * async boundary removes a whole class of interleaving bugs.
 *
 * Design decisions worth calling out:
 *
 *  - WAL journaling so the TUI thread can read while the worker writes.
 *  - A 64 MB page cache; sessions with thousands of parts stay entirely in RAM.
 *  - Post-commit side effects: event publication is deferred until a
 *    transaction actually commits, so a rollback never emits a phantom event.
 *  - Prepared-statement caching keyed by SQL text.
 */

import { DatabaseSync } from "node:sqlite"
import type { StatementSync } from "node:sqlite"
import path from "node:path"
import { Paths, ensureDirectories } from "../global.js"
import { ConflictError } from "../util/error.js"
import { ensureDirSync } from "../util/fs-extra.js"
import { logger } from "../util/log.js"
import { MIGRATIONS } from "./migration.js"

const log = logger("storage")

export type SqlValue = string | number | bigint | null | Uint8Array
export type Row = Record<string, SqlValue>

export interface DatabaseOptions {
  readonly path?: string
  /** Open in-memory; used by tests and `--ephemeral`. */
  readonly memory?: boolean
  readonly readOnly?: boolean
  /** Skip migrations (for read-only inspection of an older database). */
  readonly skipMigrations?: boolean
}

type SideEffect = () => void

/**
 * Thin, opinionated wrapper around `DatabaseSync`.
 */
export class Database {
  private readonly handle: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private transactionDepth = 0
  private pendingEffects: SideEffect[] = []
  private closed = false

  readonly location: string

  constructor(options: DatabaseOptions = {}) {
    if (options.memory) {
      this.location = ":memory:"
    } else {
      this.location = options.path ?? Paths.database
      ensureDirectories()
      ensureDirSync(path.dirname(this.location))
    }

    this.handle = new DatabaseSync(this.location, {
      readOnly: options.readOnly ?? false,
      // Foreign keys are off by default in SQLite; our schema relies on them.
      enableForeignKeyConstraints: true,
      allowExtension: false,
    })

    if (!options.readOnly) this.configure()
    if (!options.skipMigrations && !options.readOnly) this.migrate()
  }

  private configure(): void {
    const pragmas = [
      // WAL lets readers proceed during writes — essential for the TUI/worker split.
      "PRAGMA journal_mode = WAL",
      // NORMAL is the right durability/throughput tradeoff for a local tool.
      "PRAGMA synchronous = NORMAL",
      // 64 MB page cache (negative = kibibytes).
      "PRAGMA cache_size = -65536",
      "PRAGMA temp_store = MEMORY",
      "PRAGMA mmap_size = 268435456",
      "PRAGMA busy_timeout = 5000",
      "PRAGMA foreign_keys = ON",
      "PRAGMA recursive_triggers = ON",
      "PRAGMA auto_vacuum = INCREMENTAL",
      "PRAGMA wal_autocheckpoint = 1000",
    ]
    for (const pragma of pragmas) {
      try {
        this.handle.exec(pragma)
      } catch (error) {
        log.debug("pragma failed", { pragma, error })
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Migrations                                                       */
  /* ---------------------------------------------------------------- */

  private migrate(): void {
    this.handle.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version    INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `)

    const applied = new Set<number>()
    for (const row of this.handle.prepare("SELECT version FROM schema_migration").all() as Row[]) {
      applied.add(Number(row["version"]))
    }

    const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
      (a, b) => a.version - b.version,
    )
    if (pending.length === 0) return

    log.info("applying migrations", { count: pending.length })
    for (const migration of pending) {
      const done = log.time(`migration ${migration.version}`, { name: migration.name })
      this.handle.exec("BEGIN")
      try {
        for (const statement of migration.up) this.handle.exec(statement)
        this.handle
          .prepare(
            "INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, Date.now())
        this.handle.exec("COMMIT")
        done()
      } catch (error) {
        this.handle.exec("ROLLBACK")
        log.error(`migration ${migration.version} failed`, error)
        throw error
      }
    }
  }

  get schemaVersion(): number {
    const row = this.handle
      .prepare("SELECT MAX(version) AS version FROM schema_migration")
      .get() as Row | undefined
    return row?.["version"] === null || row?.["version"] === undefined
      ? 0
      : Number(row["version"])
  }

  /* ---------------------------------------------------------------- */
  /* Statements                                                        */
  /* ---------------------------------------------------------------- */

  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.handle.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  /** Executes a statement, returning row-change metadata. */
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.prepare(sql).run(...params)
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    }
  }

  /** Returns every matching row. */
  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...params) as T[]
  }

  /** Returns the first matching row, or undefined. */
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined
  }

  /** Returns a single scalar value from the first column of the first row. */
  scalar<T extends SqlValue>(sql: string, ...params: SqlValue[]): T | undefined {
    const row = this.get<Row>(sql, ...params)
    if (!row) return undefined
    const first = Object.values(row)[0]
    return first as T | undefined
  }

  /** Multi-statement DDL. */
  exec(sql: string): void {
    this.handle.exec(sql)
  }

  /* ---------------------------------------------------------------- */
  /* Transactions                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Runs `fn` inside a transaction. Nested calls reuse the outer transaction
   * via savepoints. Side effects registered with `afterCommit` fire only once
   * the outermost transaction commits.
   */
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++
    const savepoint = `sp_${depth}`
    if (depth === 0) this.handle.exec("BEGIN IMMEDIATE")
    else this.handle.exec(`SAVEPOINT ${savepoint}`)

    try {
      const result = fn()
      if (depth === 0) {
        this.handle.exec("COMMIT")
        this.transactionDepth--
        this.flushEffects()
        return result
      }
      this.handle.exec(`RELEASE ${savepoint}`)
      this.transactionDepth--
      return result
    } catch (error) {
      try {
        if (depth === 0) this.handle.exec("ROLLBACK")
        else this.handle.exec(`ROLLBACK TO ${savepoint}`)
      } catch (rollbackError) {
        log.error("rollback failed", rollbackError)
      }
      this.transactionDepth--
      if (depth === 0) this.pendingEffects = []
      throw error
    }
  }

  /**
   * Registers work to run after the current transaction commits. Outside a
   * transaction the effect runs immediately.
   */
  afterCommit(effect: SideEffect): void {
    if (this.transactionDepth === 0) {
      try {
        effect()
      } catch (error) {
        log.error("post-commit effect threw", error)
      }
      return
    }
    this.pendingEffects.push(effect)
  }

  private flushEffects(): void {
    const effects = this.pendingEffects
    this.pendingEffects = []
    for (const effect of effects) {
      try {
        effect()
      } catch (error) {
        log.error("post-commit effect threw", error)
      }
    }
  }

  get inTransaction(): boolean {
    return this.transactionDepth > 0
  }

  /* ---------------------------------------------------------------- */
  /* Maintenance                                                       */
  /* ---------------------------------------------------------------- */

  /** Reclaims space and rebuilds indices. Safe to run at startup. */
  maintain(): void {
    try {
      this.handle.exec("PRAGMA incremental_vacuum")
      this.handle.exec("PRAGMA optimize")
    } catch (error) {
      log.debug("maintenance skipped", { error })
    }
  }

  vacuum(): void {
    this.handle.exec("VACUUM")
  }

  /** Consistency check; surfaced by `praxis doctor`. */
  integrityCheck(): string[] {
    const rows = this.all<Row>("PRAGMA integrity_check")
    return rows.map((row) => String(Object.values(row)[0]))
  }

  /** Row counts per table, for the stats view. */
  tableStats(): Array<{ table: string; rows: number }> {
    const tables = this.all<Row>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    return tables.map((row) => {
      const name = String(row["name"])
      const count = this.scalar<number>(`SELECT COUNT(*) FROM "${name}"`) ?? 0
      return { table: name, rows: Number(count) }
    })
  }

  sizeBytes(): number {
    const pageCount = Number(this.scalar<number>("PRAGMA page_count") ?? 0)
    const pageSize = Number(this.scalar<number>("PRAGMA page_size") ?? 0)
    return pageCount * pageSize
  }

  /** Copies the database to `target` using SQLite's online backup API. */
  async backup(target: string): Promise<void> {
    ensureDirSync(path.dirname(target))
    const module = (await import("node:sqlite")) as {
      backup?: (source: DatabaseSync, target: string) => Promise<void>
    }
    if (typeof module.backup === "function") {
      await module.backup(this.handle, target)
      return
    }
    // Fallback: VACUUM INTO produces a compact, consistent copy.
    this.handle.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.handle.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch {
      /* best effort */
    }
    this.statements.clear()
    this.handle.close()
  }
}

/* ------------------------------------------------------------------ */
/* Process-wide instance                                               */
/* ------------------------------------------------------------------ */

let instance: Database | undefined

export function database(options?: DatabaseOptions): Database {
  if (!instance) instance = new Database(options)
  return instance
}

export function setDatabase(db: Database): void {
  instance = db
}

export function closeDatabase(): void {
  instance?.close()
  instance = undefined
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Serialises a value for a TEXT column, keeping NULL semantics. */
export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

/** Parses a JSON TEXT column with a typed fallback. */
export function fromJson<T>(value: SqlValue | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value !== "string") return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** SQLite has no boolean type; we store 0/1. */
export function toBool(value: boolean | undefined): number {
  return value ? 1 : 0
}

export function fromBool(value: SqlValue | undefined): boolean {
  return value === 1 || value === "1" || value === true
}

export function toNumberOrNull(value: number | undefined): number | null {
  return value === undefined ? null : value
}

/** Builds a parameter placeholder list: `(?, ?, ?)`. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ")
}

/**
 * Guards an insert that must be unique, translating SQLite's constraint error
 * into a domain error the CLI can present nicely.
 */
export function uniqueInsert<T>(fn: () => T, kind: string, identifier: string): T {
  try {
    return fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("UNIQUE constraint failed")) {
      throw new ConflictError({ kind, identifier, detail: message })
    }
    throw error
  }
}
