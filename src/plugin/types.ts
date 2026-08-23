/**
 * The plugin contract.
 *
 * Every agent has an opinionated default behaviour, and every team wants a
 * different one. Rather than accumulate config flags forever, plugins let people
 * run their own code at the points that matter: before a tool runs, after a file
 * changes, when a session goes idle, when the model asks for permission.
 *
 * Design decisions worth stating:
 *
 *  - **Hooks are named by event, flat.** `"tool.execute.before"` as a string key
 *    rather than a nested object. It reads worse but it is unambiguous, it is
 *    trivially serialisable for the plugin list command, and the nested form
 *    collides with tool registration.
 *  - **Throwing from a hook blocks the action.** That is the whole point of a
 *    `before` hook. The thrown message goes to the model as the reason, so a guard
 *    can explain itself and the model can adapt rather than retry blindly.
 *  - **Hooks may mutate their arguments.** A `before` hook receiving the tool's
 *    arguments can rewrite them. This is powerful and slightly dangerous, and it
 *    is the difference between "plugin can veto" and "plugin can fix".
 *  - **Every hook is optional and every hook is async.** A plugin implementing one
 *    hook should be four lines long.
 *  - **A failing plugin degrades, never crashes.** A hook that throws
 *    unexpectedly, a plugin that fails to load, a module with a syntax error \u2014 all
 *    are reported and skipped. Someone's half-finished plugin must not make the
 *    agent unusable.
 */

import type { TokenUsage } from "../session/types.js"
import type { PermissionDecision, PermissionRequest } from "../permission/types.js"
import type { ToolDefinition, ToolResult } from "../tool/types.js"

/* ------------------------------------------------------------------ */
/* Plugin entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * What a plugin module exports.
 *
 * A function rather than an object so the plugin can do setup \u2014 read its own
 * config, open a connection, register a tool \u2014 and capture state in a closure. The
 * returned hooks then share that state without any framework-provided store.
 */
export type Plugin = (input: PluginInput) => Promise<PluginHooks> | PluginHooks

/**
 * What a plugin gets at load time.
 *
 * Deliberately broad. A plugin that can only observe is not much use; one that
 * can run a command, read config, and call back into the agent can do almost
 * anything the built-in code can.
 */
export interface PluginInput {
  /** Absolute path to the project root. */
  readonly directory: string

  /** Git worktree root, which differs from `directory` inside a worktree. */
  readonly worktree: string

  /** Project identity and metadata. */
  readonly project: PluginProject

  /** Client for driving the agent: create sessions, send prompts, show toasts. */
  readonly client: PluginClient

  /**
   * Shell helper.
   *
   * Tagged-template shell execution, because the alternative is every plugin
   * hand-rolling `spawn` with subtly different quoting.
   */
  readonly $: PluginShell

  /** This plugin's own config block, from the `plugin` map. */
  readonly config: Record<string, unknown>

  /** Environment variables, already merged with the project's `.env`. */
  readonly env: Record<string, string | undefined>

  /** Structured logging under the plugin's name. */
  readonly log: PluginLogger
}

export interface PluginProject {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly vcs?: "git" | undefined
  readonly branch?: string
}

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/* ------------------------------------------------------------------ */
/* Shell helper                                                        */
/* ------------------------------------------------------------------ */

export interface ShellResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/**
 * Tagged-template shell execution.
 *
 * Interpolated values are quoted automatically, which is not a nicety: a plugin
 * building a command by string concatenation from a file path is a shell
 * injection waiting for the first filename with a space in it.
 */
export interface PluginShell {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult>
  /** Same, but resolves with a non-zero exit code instead of throwing. */
  readonly nothrow: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<ShellResult>
  readonly cwd: (directory: string) => PluginShell
  readonly env: (variables: Record<string, string>) => PluginShell
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/**
 * The agent's API, as seen by a plugin.
 *
 * Narrower than the internal one on purpose. Plugins get what they need to build
 * useful things and nothing that would let a careless one corrupt state.
 */
export interface PluginClient {
  readonly session: {
    create(input: { title?: string; parentId?: string }): Promise<{ id: string }>
    get(id: string): Promise<PluginSession | undefined>
    list(input?: { limit?: number }): Promise<PluginSession[]>
    prompt(input: { sessionId: string; text: string; agent?: string; model?: string }): Promise<{ text: string }>
    abort(sessionId: string): Promise<void>
    messages(sessionId: string): Promise<PluginMessage[]>
  }

  readonly tui: {
    /** Shows a transient notification. */
    toast(input: { message: string; variant?: "info" | "success" | "warning" | "error"; durationMs?: number }): Promise<void>
    /** Puts text in the composer without sending it. */
    append(text: string): Promise<void>
    /** Runs a slash command as if typed. */
    command(name: string, args?: string): Promise<void>
  }

  readonly config: {
    get(): Promise<Record<string, unknown>>
  }

  readonly file: {
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
    exists(path: string): Promise<boolean>
  }
}

export interface PluginSession {
  readonly id: string
  readonly title: string
  readonly parentId?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly cost: number
}

export interface PluginMessage {
  readonly id: string
  readonly role: "user" | "assistant" | "system"
  readonly text: string
  readonly createdAt: number
}

/* ------------------------------------------------------------------ */
/* Hook payloads                                                       */
/* ------------------------------------------------------------------ */

export interface ToolBeforeInput {
  readonly tool: string
  readonly sessionId: string
  readonly messageId: string
  readonly callId: string
  readonly agent: string
}

/**
 * Mutable half of the `before` hook.
 *
 * Separate from the read-only descriptor so the contract is obvious at the call
 * site: `input` describes the situation, `output` is what you may change.
 */
export interface ToolBeforeOutput {
  args: Record<string, unknown>
}

export interface ToolAfterInput {
  readonly tool: string
  readonly sessionId: string
  readonly messageId: string
  readonly callId: string
  readonly agent: string
  readonly args: Record<string, unknown>
  readonly durationMs: number
}

export interface ToolAfterOutput {
  result: ToolResult
}

export interface PluginEvent<T = unknown> {
  readonly type: string
  readonly properties: T
  readonly at: number
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

/**
 * Everything a plugin may implement.
 *
 * The catalogue is broad because the useful integrations are not predictable in
 * advance: linting gates, audit logging, secret scanning, desktop notifications,
 * ticket updates, CI triggers. Each hook is one line in the dispatcher and buys a
 * whole category of extension.
 */
export interface PluginHooks {
  /* -------------------------------------------------------------- */
  /* Tools                                                           */
  /* -------------------------------------------------------------- */

  /**
   * Before a tool runs. Throw to block; mutate `output.args` to rewrite.
   *
   * The most-used hook by a wide margin: blocking reads of `.env`, forcing
   * `--dry-run`, rejecting commits without tests.
   */
  "tool.execute.before"?: (input: ToolBeforeInput, output: ToolBeforeOutput) => Promise<void> | void

  /**
   * After a tool runs. Mutate `output.result` to change what the model sees.
   *
   * Used to append context (a linter's opinion of a file just written) or to
   * redact secrets from command output before it enters the transcript.
   */
  "tool.execute.after"?: (input: ToolAfterInput, output: ToolAfterOutput) => Promise<void> | void

  /* -------------------------------------------------------------- */
  /* Files                                                           */
  /* -------------------------------------------------------------- */

  "file.edited"?: (input: { path: string; sessionId: string; before?: string; after?: string }) => Promise<void> | void

  "file.watcher.updated"?: (input: { path: string; event: "add" | "change" | "unlink" }) => Promise<void> | void

  /* -------------------------------------------------------------- */
  /* Sessions                                                        */
  /* -------------------------------------------------------------- */

  "session.created"?: (input: { sessionId: string; parentId?: string }) => Promise<void> | void

  "session.updated"?: (input: { sessionId: string }) => Promise<void> | void

  "session.deleted"?: (input: { sessionId: string }) => Promise<void> | void

  /**
   * The agent has stopped and is waiting for input.
   *
   * The natural place for "run the tests now" or "notify me", because it fires
   * exactly once per turn rather than once per tool call.
   */
  "session.idle"?: (input: { sessionId: string; durationMs: number; cost: number }) => Promise<void> | void

  "session.error"?: (input: { sessionId: string; error: string }) => Promise<void> | void

  "session.compacted"?: (input: { sessionId: string; before: number; after: number }) => Promise<void> | void

  "session.status"?: (input: { sessionId: string; status: string }) => Promise<void> | void

  /** Fires with the accumulated diff for a turn. Used for review integrations. */
  "session.diff"?: (input: { sessionId: string; paths: string[]; diff: string }) => Promise<void> | void

  /* -------------------------------------------------------------- */
  /* Messages                                                        */
  /* -------------------------------------------------------------- */

  "message.updated"?: (input: { sessionId: string; messageId: string; role: string }) => Promise<void> | void

  "message.removed"?: (input: { sessionId: string; messageId: string }) => Promise<void> | void

  "message.part.updated"?: (input: { sessionId: string; messageId: string; partId: string; type: string }) => Promise<void> | void

  "message.part.removed"?: (input: { sessionId: string; messageId: string; partId: string }) => Promise<void> | void

  /* -------------------------------------------------------------- */
  /* Permissions                                                     */
  /* -------------------------------------------------------------- */

  /**
   * A permission is about to be asked for.
   *
   * Returning a decision answers it without troubling the user \u2014 the mechanism
   * behind policy plugins that auto-approve reads under `src/` and auto-deny
   * anything touching production config.
   */
  "permission.asked"?: (input: {
    request: PermissionRequest
    sessionId: string
  }) => Promise<PermissionDecision | void> | PermissionDecision | void

  "permission.replied"?: (input: {
    request: PermissionRequest
    decision: PermissionDecision
    sessionId: string
  }) => Promise<void> | void

  /* -------------------------------------------------------------- */
  /* LSP                                                             */
  /* -------------------------------------------------------------- */

  "lsp.client.diagnostics"?: (input: { path: string; count: number; errors: number }) => Promise<void> | void

  "lsp.updated"?: (input: { server: string; state: string }) => Promise<void> | void

  /* -------------------------------------------------------------- */
  /* Commands, todos, shell, server                                  */
  /* -------------------------------------------------------------- */

  "command.executed"?: (input: { name: string; args: string; sessionId: string }) => Promise<void> | void

  "todo.updated"?: (input: { sessionId: string; total: number; completed: number }) => Promise<void> | void

  /**
   * Contribute environment variables to every shell command.
   *
   * Mutating the returned object is how a plugin injects credentials without
   * writing them to disk.
   */
  "shell.env"?: (input: { cwd: string }, output: { env: Record<string, string> }) => Promise<void> | void

  "server.connected"?: (input: { hostname: string; port: number }) => Promise<void> | void

  "installation.updated"?: (input: { from: string; to: string }) => Promise<void> | void

  /* -------------------------------------------------------------- */
  /* TUI                                                             */
  /* -------------------------------------------------------------- */

  "tui.prompt.append"?: (input: { text: string }) => Promise<void> | void

  "tui.command.execute"?: (input: { name: string; args?: string }) => Promise<void> | void

  "tui.toast.show"?: (input: { message: string; variant: string }) => Promise<void> | void

  /* -------------------------------------------------------------- */
  /* Catch-all                                                       */
  /* -------------------------------------------------------------- */

  /**
   * Every event, including ones added after this plugin was written.
   *
   * The forward-compatible escape hatch: a plugin can watch for an event that did
   * not exist when it shipped, which keeps old plugins useful.
   */
  event?: (input: { event: PluginEvent }) => Promise<void> | void

  /* -------------------------------------------------------------- */
  /* Contributions                                                   */
  /* -------------------------------------------------------------- */

  /**
   * Tools contributed by this plugin, keyed by id.
   *
   * They appear to the model exactly like built-in tools. This is how a team
   * gives the agent access to their deployment system or their ticket tracker
   * without touching the agent's source.
   */
  tool?: Record<string, PluginTool>

  /**
   * Custom authentication for a provider.
   *
   * Needed for gateways behind SSO, mTLS, or a short-lived token from an internal
   * service, none of which fit a static API key.
   */
  auth?: Record<string, PluginAuth>

  /** Agents contributed by this plugin. */
  agent?: Record<string, PluginAgentDefinition>

  /** Slash commands contributed by this plugin. */
  command?: Record<string, PluginCommand>
}

/* ------------------------------------------------------------------ */
/* Contributions                                                       */
/* ------------------------------------------------------------------ */

/**
 * A tool defined by a plugin.
 *
 * `args` is a plain JSON Schema rather than a validator instance so plugins do
 * not have to depend on the same schema library, and so a plugin can be plain
 * JavaScript.
 */
export interface PluginTool {
  readonly description: string
  readonly args: Record<string, unknown>
  execute(
    args: Record<string, unknown>,
    context: { sessionId: string; cwd: string; signal: AbortSignal },
  ): Promise<string | ToolResult>
  /** Safe to run in parallel with other tools. Defaults to false. */
  readonly concurrent?: boolean
  /** Does not modify anything, so it skips the permission prompt. */
  readonly readOnly?: boolean
}

export interface PluginAuth {
  readonly label: string
  /** Interactive login. Returns credentials to store. */
  authorize?(): Promise<{ type: "api"; key: string } | { type: "oauth"; access: string; refresh?: string; expires?: number }>
  /** Refreshes an expiring credential. */
  refresh?(credentials: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Supplies headers per request, for schemes that cannot be reduced to a key. */
  headers?(credentials: Record<string, unknown>): Promise<Record<string, string>>
}

export interface PluginAgentDefinition {
  readonly description: string
  readonly prompt: string
  readonly mode?: "primary" | "subagent"
  readonly model?: string
  readonly tools?: string[]
  readonly temperature?: number
  readonly color?: string
}

export interface PluginCommand {
  readonly description: string
  readonly template?: string
  readonly agent?: string
  readonly model?: string
  execute?(args: string, context: { sessionId: string; cwd: string }): Promise<string | void>
}

/* ------------------------------------------------------------------ */
/* Loaded plugin                                                       */
/* ------------------------------------------------------------------ */

export interface LoadedPlugin {
  readonly id: string
  readonly name: string
  readonly version?: string
  readonly source: "local" | "npm" | "builtin"
  readonly path: string
  readonly hooks: PluginHooks
  readonly tools: ToolDefinition[]
  /** Errors from load or from hooks, surfaced by `praxis plugin list`. */
  readonly errors: string[]
}

export interface PluginManifest {
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly main?: string
  readonly praxis?: {
    readonly minVersion?: string
    readonly config?: Record<string, unknown>
  }
}

/* ------------------------------------------------------------------ */
/* Dispatch results                                                    */
/* ------------------------------------------------------------------ */

/**
 * What happened when a hook ran.
 *
 * `blocked` is distinct from `failed`: a plugin deliberately vetoing an action is
 * the system working correctly and the reason must reach the model, whereas a
 * plugin crashing is a bug the user should hear about but the model should not.
 */
export interface HookOutcome {
  readonly blocked: boolean
  readonly reason?: string
  readonly pluginId?: string
  readonly failures: Array<{ pluginId: string; error: string }>
}

export interface PluginUsage {
  readonly pluginId: string
  readonly hook: string
  readonly calls: number
  readonly totalMs: number
  readonly errors: number
}

export type { TokenUsage }
