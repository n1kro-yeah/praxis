/**
 * Schema migrations.
 *
 * Migrations are append-only: never edit an applied migration, add a new one.
 * Each entry is a list of statements executed inside a single transaction.
 *
 * Schema shape:
 *
 *   project -> session --+-- message ---- part
 *                        +-- todo
 *                        +-- permission
 *                        +-- snapshot
 *                        +-- usage
 *
 * `part` denormalises `session_id` so the hot query ("every part of the last N
 * messages in this session") is a single index scan with no join.
 */

export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: readonly string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core",
    up: [
      `CREATE TABLE project (
        id             TEXT PRIMARY KEY,
        root           TEXT NOT NULL UNIQUE,
        name           TEXT NOT NULL,
        vcs            TEXT,
        created_at     INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      )`,

      `CREATE TABLE session (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        parent_id         TEXT REFERENCES session(id) ON DELETE CASCADE,
        title             TEXT NOT NULL DEFAULT '',
        directory         TEXT NOT NULL,
        agent             TEXT,
        model             TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        archived_at       INTEGER,
        share_url         TEXT,
        share_secret      TEXT,
        revert_message_id TEXT,
        revert_part_id    TEXT,
        revert_snapshot   TEXT,
        revert_diff       TEXT,
        summary           TEXT,
        metadata          TEXT
      )`,
      `CREATE INDEX idx_session_project ON session(project_id, updated_at DESC)`,
      `CREATE INDEX idx_session_parent ON session(parent_id)`,
      `CREATE INDEX idx_session_updated ON session(updated_at DESC)`,

      `CREATE TABLE message (
        id                 TEXT PRIMARY KEY,
        session_id         TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        role               TEXT NOT NULL,
        seq                INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        completed_at       INTEGER,
        agent              TEXT,
        provider_id        TEXT,
        model_id           TEXT,
        system_prompt      TEXT,
        finish_reason      TEXT,
        error              TEXT,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd           REAL NOT NULL DEFAULT 0,
        metadata           TEXT
      )`,
      `CREATE UNIQUE INDEX idx_message_session_seq ON message(session_id, seq)`,
      `CREATE INDEX idx_message_created ON message(created_at DESC)`,

      `CREATE TABLE part (
        id           TEXT PRIMARY KEY,
        message_id   TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
        session_id   TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        type         TEXT NOT NULL,
        text         TEXT,
        payload      TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        state        TEXT,
        tool_name    TEXT,
        tool_call_id TEXT,
        synthetic    INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX idx_part_message ON part(message_id, seq)`,
      `CREATE INDEX idx_part_session ON part(session_id, created_at)`,
      `CREATE INDEX idx_part_tool_call ON part(tool_call_id)`,

      `CREATE TABLE todo (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        content    TEXT NOT NULL,
        status     TEXT NOT NULL,
        priority   TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata   TEXT
      )`,
      `CREATE INDEX idx_todo_session ON todo(session_id, seq)`,

      `CREATE TABLE permission (
        id           TEXT PRIMARY KEY,
        session_id   TEXT REFERENCES session(id) ON DELETE CASCADE,
        project_id   TEXT,
        action       TEXT NOT NULL,
        pattern      TEXT NOT NULL,
        effect       TEXT NOT NULL,
        scope        TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER,
        approved_by  TEXT,
        metadata     TEXT
      )`,
      `CREATE INDEX idx_permission_session ON permission(session_id, action)`,
      `CREATE INDEX idx_permission_project ON permission(project_id, action)`,
      `CREATE UNIQUE INDEX idx_permission_unique
         ON permission(COALESCE(session_id, ''), COALESCE(project_id, ''), action, pattern, scope)`,

      `CREATE TABLE snapshot (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        message_id  TEXT,
        created_at  INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        commit_hash TEXT,
        tree_hash   TEXT,
        file_count  INTEGER NOT NULL DEFAULT 0,
        byte_size   INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        payload     TEXT
      )`,
      `CREATE INDEX idx_snapshot_session ON snapshot(session_id, created_at DESC)`,
      `CREATE INDEX idx_snapshot_message ON snapshot(message_id)`,

      `CREATE TABLE kv (
        namespace  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (namespace, key)
      )`,
      `CREATE INDEX idx_kv_expiry ON kv(expires_at)`,

      `CREATE TABLE file_state (
        path        TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        read_at     INTEGER,
        written_at  INTEGER,
        mtime       INTEGER,
        size        INTEGER,
        hash        TEXT,
        PRIMARY KEY (session_id, path)
      )`,
      `CREATE INDEX idx_file_state_path ON file_state(path)`,

      `CREATE TABLE usage (
        id            TEXT PRIMARY KEY,
        session_id    TEXT,
        project_id    TEXT,
        provider_id   TEXT NOT NULL,
        model_id      TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL NOT NULL DEFAULT 0,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX idx_usage_created ON usage(created_at DESC)`,
      `CREATE INDEX idx_usage_session ON usage(session_id)`,
      `CREATE INDEX idx_usage_model ON usage(provider_id, model_id, created_at DESC)`,
    ],
  },

  {
    version: 2,
    name: "history-and-search",
    up: [
      // Input history for the TUI editor, scoped per project.
      `CREATE TABLE prompt_history (
        id         TEXT PRIMARY KEY,
        project_id TEXT,
        session_id TEXT,
        text       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_prompt_history_project ON prompt_history(project_id, created_at DESC)`,

      // Frecency tracking so pickers surface what the user actually uses.
      `CREATE TABLE access_log (
        kind       TEXT NOT NULL,
        identifier TEXT NOT NULL,
        project_id TEXT,
        count      INTEGER NOT NULL DEFAULT 0,
        last_at    INTEGER NOT NULL,
        PRIMARY KEY (kind, identifier, COALESCE(project_id, ''))
      )`,
      `CREATE INDEX idx_access_log_recent ON access_log(kind, last_at DESC)`,

      // Full-text search over message text so `/search` is instant.
      `CREATE VIRTUAL TABLE part_fts USING fts5(
        text,
        part_id UNINDEXED,
        session_id UNINDEXED,
        message_id UNINDEXED,
        tokenize = 'porter unicode61'
      )`,
      `CREATE TRIGGER part_fts_insert AFTER INSERT ON part
         WHEN new.text IS NOT NULL AND new.type IN ('text', 'reasoning', 'summary')
       BEGIN
         INSERT INTO part_fts (text, part_id, session_id, message_id)
         VALUES (new.text, new.id, new.session_id, new.message_id);
       END`,
      `CREATE TRIGGER part_fts_update AFTER UPDATE OF text ON part
         WHEN new.text IS NOT NULL AND new.type IN ('text', 'reasoning', 'summary')
       BEGIN
         DELETE FROM part_fts WHERE part_id = new.id;
         INSERT INTO part_fts (text, part_id, session_id, message_id)
         VALUES (new.text, new.id, new.session_id, new.message_id);
       END`,
      `CREATE TRIGGER part_fts_delete AFTER DELETE ON part BEGIN
         DELETE FROM part_fts WHERE part_id = old.id;
       END`,
    ],
  },

  {
    version: 3,
    name: "mcp-and-lsp-cache",
    up: [
      // Cached MCP tool descriptors so startup does not block on every server.
      `CREATE TABLE mcp_cache (
        server      TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        tools       TEXT NOT NULL,
        resources   TEXT,
        prompts     TEXT,
        updated_at  INTEGER NOT NULL
      )`,

      // OAuth material for remote MCP servers, keyed by issuer.
      `CREATE TABLE mcp_oauth (
        server        TEXT PRIMARY KEY,
        client_id     TEXT,
        client_secret TEXT,
        access_token  TEXT,
        refresh_token TEXT,
        expires_at    INTEGER,
        scope         TEXT,
        metadata      TEXT,
        updated_at    INTEGER NOT NULL
      )`,

      // Diagnostics survive restarts so the model keeps its error context.
      `CREATE TABLE diagnostic (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path       TEXT NOT NULL,
        server     TEXT NOT NULL,
        severity   TEXT NOT NULL,
        line       INTEGER NOT NULL,
        column_no  INTEGER NOT NULL,
        end_line   INTEGER,
        end_column INTEGER,
        code       TEXT,
        message    TEXT NOT NULL,
        source     TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_diagnostic_path ON diagnostic(project_id, path)`,
      `CREATE INDEX idx_diagnostic_severity ON diagnostic(project_id, severity)`,
    ],
  },

  {
    version: 4,
    name: "session-queue-and-share",
    up: [
      // Queued prompts submitted while the agent was busy.
      `CREATE TABLE session_queue (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        status     TEXT NOT NULL DEFAULT 'pending'
      )`,
      `CREATE INDEX idx_session_queue_pending ON session_queue(session_id, status, seq)`,

      // Share metadata, kept separate so revoking a link is a single delete.
      `CREATE TABLE share (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        url        TEXT NOT NULL,
        secret     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_sync_at INTEGER,
        sync_cursor TEXT
      )`,
      `CREATE UNIQUE INDEX idx_share_session ON share(session_id)`,

      // Background subagent bookkeeping.
      `CREATE TABLE task (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        child_session_id TEXT,
        parent_part_id TEXT,
        agent        TEXT NOT NULL,
        description  TEXT NOT NULL,
        status       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        started_at   INTEGER,
        finished_at  INTEGER,
        result       TEXT,
        error        TEXT,
        depth        INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX idx_task_session ON task(session_id, created_at DESC)`,
      `CREATE INDEX idx_task_status ON task(status)`,
    ],
  },

  {
    version: 5,
    name: "model-catalog-cache",
    up: [
      // Local mirror of the model catalog; lets the CLI work fully offline.
      `CREATE TABLE model_catalog (
        provider_id TEXT NOT NULL,
        model_id    TEXT NOT NULL,
        payload     TEXT NOT NULL,
        source      TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      )`,
      `CREATE INDEX idx_model_catalog_provider ON model_catalog(provider_id)`,

      `CREATE TABLE catalog_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },

  {
    version: 6,
    name: "compaction-and-attachments",
    up: [
      // Compaction records: which messages a summary replaced, so `/undo` can
      // restore the original transcript.
      `CREATE TABLE compaction (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        summary_part_id TEXT,
        from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        tokens_before INTEGER NOT NULL DEFAULT 0,
        tokens_after  INTEGER NOT NULL DEFAULT 0,
        model_id      TEXT,
        payload       TEXT
      )`,
      `CREATE INDEX idx_compaction_session ON compaction(session_id, created_at DESC)`,

      // Binary attachments live on disk; this table tracks them.
      `CREATE TABLE attachment (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        part_id    TEXT,
        filename   TEXT NOT NULL,
        mime       TEXT NOT NULL,
        byte_size  INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        hash       TEXT
      )`,
      `CREATE INDEX idx_attachment_session ON attachment(session_id)`,
      `CREATE INDEX idx_attachment_part ON attachment(part_id)`,
    ],
  },

  {
    version: 7,
    name: "plugin-state",
    up: [
      // Namespaced, persistent scratch space for plugins.
      `CREATE TABLE plugin_state (
        plugin     TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin, key)
      )`,

      // Tool invocation log: powers `praxis stats` and doom-loop analysis.
      `CREATE TABLE tool_call (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        message_id  TEXT,
        part_id     TEXT,
        tool        TEXT NOT NULL,
        input_hash  TEXT NOT NULL,
        status      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        error       TEXT,
        output_bytes INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX idx_tool_call_session ON tool_call(session_id, created_at DESC)`,
      `CREATE INDEX idx_tool_call_tool ON tool_call(tool, created_at DESC)`,
      `CREATE INDEX idx_tool_call_loop ON tool_call(session_id, tool, input_hash)`,
    ],
  },
]

/** Highest migration version known to this build. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
)
