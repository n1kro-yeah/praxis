/**
 * Permission model.
 *
 * The problem this solves: an agent with a shell is an agent that can delete the
 * repository. Asking the user to confirm every call makes the tool useless;
 * confirming nothing makes it dangerous. So permissions are declarative,
 * pattern-based, and layered, and the user's answer to a prompt can be recorded
 * as a rule so they are never asked the same thing twice.
 *
 * Design decisions worth stating:
 *
 *  - **Actions are coarse, resources are fine.** There are a dozen actions
 *    (`shell`, `edit`, `read`, `subagent`, …) and the resource is a pattern.
 *    This is far easier to reason about than a permission per tool.
 *  - **Later layers override earlier ones.** default → agent → config → session
 *    → stored approvals. A user's in-session "always allow" therefore beats the
 *    built-in default without editing any file.
 *  - **Specificity beats order within a layer.** `git commit *` deny wins over
 *    `git *` allow regardless of declaration order, because a user writing both
 *    obviously means the specific one.
 *  - **Deny is absolute.** A deny anywhere in the resolved set blocks the
 *    operation. There is no "allow overrides deny", because that makes a safety
 *    rule depend on ordering subtleties.
 */

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/**
 * The complete set of gated actions.
 *
 * Kept deliberately small. Every new action is a new thing users must configure,
 * so a tool only gets its own action when the risk profile genuinely differs.
 */
export const PERMISSION_ACTIONS = [
  /** Running a shell command. Resource is the command line. */
  "shell",
  /** Reading a file. Resource is the path. */
  "read",
  /** Creating or modifying a file. Resource is the path. */
  "edit",
  /** Deleting a file or directory. Resource is the path. */
  "delete",
  /** Touching anything outside the working directory. Resource is the path. */
  "external_directory",
  /** Spawning a subagent. Resource is the agent name. */
  "subagent",
  /** Fetching a URL. Resource is the URL. */
  "webfetch",
  /** Searching the web. Resource is the query. */
  "websearch",
  /** Calling an MCP tool. Resource is `server/tool`. */
  "mcp",
  /** Mutating git state: commit, push, reset, rebase. Resource is the command. */
  "git_write",
  /** Installing or removing packages. Resource is the command. */
  "package_install",
  /** Starting a long-lived background process. Resource is the command. */
  "background_process",
  /** Writing outside the repository, e.g. to the home directory. */
  "global_write",
  /** Reading environment variables or credential files. */
  "secrets",
  /** Sharing a session publicly. Resource is the session id. */
  "share",
] as const

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export function isPermissionAction(value: string): value is PermissionAction {
  return (PERMISSION_ACTIONS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ */
/* Effects                                                             */
/* ------------------------------------------------------------------ */

export type PermissionEffect = "allow" | "deny" | "ask"

export interface PermissionRule {
  readonly action: PermissionAction
  /**
   * Glob-style resource pattern. `*` matches within a path segment or command
   * token, `**` matches across separators, `?` matches one character.
   */
  readonly resource: string
  readonly effect: PermissionEffect
  /** Where the rule came from; shown when explaining a decision. */
  readonly source: PermissionSource
  /** Optional human explanation shown in the prompt or the denial message. */
  readonly reason?: string
}

export type PermissionSource =
  | "builtin"
  | "agent"
  | "config"
  | "env"
  | "session"
  | "stored"
  | "cli"
  | "plugin"

/** Layer precedence, low to high. Higher layers override lower ones. */
export const SOURCE_PRECEDENCE: Record<PermissionSource, number> = {
  builtin: 0,
  plugin: 1,
  agent: 2,
  config: 3,
  env: 4,
  cli: 5,
  stored: 6,
  session: 7,
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

export interface PermissionDecision {
  readonly effect: PermissionEffect
  /** The rule that decided, when one did. */
  readonly rule?: PermissionRule
  /** Explanation suitable for showing the user or the model. */
  readonly reason: string
  /** Pattern to offer for "always allow", derived from the resource. */
  readonly suggestedPattern?: string
  readonly risk: RiskLevel
}

export type RiskLevel = "low" | "medium" | "high" | "critical"

export interface PermissionQuery {
  readonly action: PermissionAction
  readonly resource: string
  readonly agent?: string
  readonly sessionId?: string
  /** Overrides the computed risk, when the caller knows better. */
  readonly risk?: RiskLevel
}

/* ------------------------------------------------------------------ */
/* Stored approvals                                                    */
/* ------------------------------------------------------------------ */

export type ApprovalScope = "once" | "session" | "project" | "global"

export interface ApprovalRecord {
  readonly id: string
  readonly action: PermissionAction
  readonly pattern: string
  readonly effect: "allow" | "deny"
  readonly scope: ApprovalScope
  readonly sessionId?: string
  readonly projectId?: string
  readonly createdAt: number
  readonly expiresAt?: number
}

/* ------------------------------------------------------------------ */
/* Prompt shape                                                        */
/* ------------------------------------------------------------------ */

export interface PermissionPrompt {
  readonly id: string
  readonly sessionId: string
  readonly action: PermissionAction
  readonly resource: string
  readonly title: string
  readonly detail?: string
  readonly risk: RiskLevel
  readonly options: readonly PermissionOption[]
}

export interface PermissionOption {
  readonly id: string
  readonly label: string
  readonly effect: "allow" | "deny"
  readonly scope: ApprovalScope
  /** Pattern stored when this option is chosen. */
  readonly pattern?: string
  /** Rendered as the default action when the user just presses Enter. */
  readonly primary?: boolean
}

export type PermissionResponse = {
  readonly promptId: string
  readonly optionId: string
}

/* ------------------------------------------------------------------ */
/* Configuration shapes accepted from the user                          */
/* ------------------------------------------------------------------ */

/**
 * Three configuration forms are accepted, because they suit different needs and
 * all three appear in real configuration files.
 *
 * Object form, concise for the common case:
 *   { "shell": { "*": "ask", "git *": "allow", "git push *": "deny" } }
 *
 * Shorthand, when one effect covers the whole action:
 *   { "read": "allow" }
 *
 * Array form, when order and reasons matter:
 *   [ { "action": "shell", "resource": "rm -rf *", "effect": "deny",
 *       "reason": "never" } ]
 */
export type PermissionConfigValue =
  | PermissionEffect
  | Record<string, PermissionEffect>

export type PermissionConfig =
  | Partial<Record<string, PermissionConfigValue>>
  | ReadonlyArray<{
      action: string
      resource: string
      effect: PermissionEffect
      reason?: string
    }>

/* ------------------------------------------------------------------ */
/* Legacy tool-level configuration                                     */
/* ------------------------------------------------------------------ */

/**
 * Older configurations enabled or disabled individual tools:
 *   { "tools": { "bash": false, "webfetch": true } }
 *
 * Mapping tools onto actions keeps those configurations working without a
 * second permission system.
 */
export const TOOL_ACTION_MAP: Record<string, PermissionAction> = {
  bash: "shell",
  read: "read",
  list: "read",
  glob: "read",
  grep: "read",
  symbols: "read",
  notebook: "edit",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  patch: "edit",
  apply_patch: "edit",
  task: "subagent",
  webfetch: "webfetch",
  websearch: "websearch",
  git: "read",
  kill: "shell",
  output: "read",
  skill: "read",
  memory: "edit",
  plan: "edit",
  todowrite: "read",
  todoread: "read",
  question: "read",
  lsp: "read",
  diagnostics: "read",
  batch: "read",
}

export function actionForTool(tool: string): PermissionAction {
  return TOOL_ACTION_MAP[tool] ?? "shell"
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class PermissionDeniedError extends Error {
  readonly action: PermissionAction
  readonly resource: string
  readonly rule?: PermissionRule

  constructor(action: PermissionAction, resource: string, reason: string, rule?: PermissionRule) {
    super(reason)
    this.name = "PermissionDeniedError"
    this.action = action
    this.resource = resource
    this.rule = rule
  }
}

export class PermissionTimeoutError extends Error {
  constructor(action: PermissionAction, resource: string) {
    super(`No response to the permission request for ${action} on ${resource}.`)
    this.name = "PermissionTimeoutError"
  }
}
