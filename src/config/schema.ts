/**
 * Configuration schema.
 *
 * This is the single source of truth for `praxis.json`. It doubles as the
 * generator for the published JSON Schema (`praxis config schema`), so editor
 * autocomplete and validation always match the runtime.
 */

import type { Infer, JsonSchema } from "../util/schema.js"
import { s } from "../util/schema.js"

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

export const PermissionEffect = s.enum(["allow", "deny", "ask"] as const)

/**
 * Permission actions. `shell` covers command execution, `edit` covers any
 * mutation of a file, `read` covers reading outside the project, `subagent`
 * covers delegation, `external_directory` covers escaping the project root.
 */
export const PermissionAction = s.enum([
  "shell",
  "read",
  "edit",
  "write",
  "patch",
  "delete",
  "subagent",
  "external_directory",
  "webfetch",
  "websearch",
  "mcp",
  "lsp",
  "format",
  "git",
  "network",
] as const)

/** Ordered rule form: first match wins, so specific rules go first. */
export const PermissionRuleSchema = s.object({
  action: PermissionAction,
  resource: s.string().default("*").describe("Glob pattern matched against the resource"),
  effect: PermissionEffect.default("ask"),
  reason: s.string().optional().describe("Shown to the user when this rule fires"),
})

export type PermissionRule = Infer<typeof PermissionRuleSchema>

/**
 * Map form: `{ "bash": { "git *": "allow", "*": "ask" } }`. Converted into
 * ordered rules at load time, sorted by pattern specificity.
 */
const PermissionMapSchema = s.record(
  s.union(PermissionEffect, s.record(PermissionEffect)),
)

export const PermissionConfigSchema = s.union(
  s.array(PermissionRuleSchema),
  PermissionMapSchema,
  PermissionEffect,
)

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

export const AgentModeSchema = s.enum(["primary", "subagent", "all", "internal"] as const)

export const ReasoningEffortSchema = s.enum(["minimal", "low", "medium", "high"] as const)

export const AgentConfigSchema = s.object({
  description: s.string().optional().describe("Shown in the agent picker and to delegating agents"),
  mode: AgentModeSchema.default("all"),
  model: s.string().optional().describe("provider/model override for this agent"),
  smallModel: s.string().optional(),
  temperature: s.number().min(0).max(2).optional(),
  topP: s.number().min(0).max(1).optional(),
  maxOutputTokens: s.int().min(1).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  /** Appended to the base system prompt. */
  prompt: s.string().optional(),
  /** Replaces the base system prompt entirely. */
  system: s.string().optional(),
  /** Path to a markdown file used as the prompt. */
  promptFile: s.string().optional(),
  /** Tool allow/deny map: `{ "bash": false, "edit": true }`. */
  tools: s.record(s.boolean()).optional(),
  permission: PermissionConfigSchema.optional(),
  /** Extra instruction files loaded only for this agent. */
  instructions: s.array(s.string()).optional(),
  /** Restrict this agent to a subdirectory of the project. */
  scope: s.string().optional(),
  disable: s.boolean().default(false),
  color: s.string().optional(),
  icon: s.string().optional(),
  /** Maximum agentic iterations before the agent must yield. */
  maxIterations: s.int().min(1).optional(),
  /** Run this agent's turns without asking for any permission. */
  autoApprove: s.boolean().default(false),
})

export type AgentConfig = Infer<typeof AgentConfigSchema>

/* ------------------------------------------------------------------ */
/* Providers and models                                                */
/* ------------------------------------------------------------------ */

export const ModelCostSchema = s.object({
  input: s.number().nonNegative().describe("USD per million input tokens"),
  output: s.number().nonNegative().describe("USD per million output tokens"),
  cacheRead: s.number().nonNegative().optional(),
  cacheWrite: s.number().nonNegative().optional(),
  reasoning: s.number().nonNegative().optional(),
})

export const ModelLimitSchema = s.object({
  context: s.int().min(1).describe("Total context window in tokens"),
  output: s.int().min(1).describe("Maximum tokens the model can emit"),
})

export const ModelConfigSchema = s.object({
  id: s.string().optional(),
  name: s.string().optional(),
  cost: ModelCostSchema.optional(),
  limit: ModelLimitSchema.optional(),
  /** Capability flags; drive tool selection and request shaping. */
  attachment: s.boolean().optional(),
  reasoning: s.boolean().optional(),
  toolCall: s.boolean().optional(),
  temperature: s.boolean().optional(),
  structuredOutput: s.boolean().optional(),
  promptCache: s.boolean().optional(),
  parallelToolCalls: s.boolean().optional(),
  knowledgeCutoff: s.string().optional(),
  releaseDate: s.string().optional(),
  /** Extra body fields merged into every request for this model. */
  options: s.record(s.any()).optional(),
  headers: s.record(s.string()).optional(),
})

export type ModelConfig = Infer<typeof ModelConfigSchema>

export const TransportSchema = s.enum([
  "openai-chat",
  "openai-responses",
  "anthropic",
  "anthropic-bedrock",
  "anthropic-vertex",
  "google",
  "google-vertex",
  "bedrock",
  "ollama",
  "mistral",
  "cohere",
  "azure-openai",
  "github-copilot",
  "generic",
] as const)

export const ProviderConfigSchema = s.object({
  name: s.string().optional(),
  transport: TransportSchema.optional(),
  baseUrl: s.string().optional(),
  apiKey: s.string().optional().describe("Prefer `{env:VAR}` over a literal key"),
  /** Environment variables checked for the API key, in order. */
  apiKeyEnv: s.array(s.string()).optional(),
  headers: s.record(s.string()).optional(),
  query: s.record(s.string()).optional(),
  organization: s.string().optional(),
  project: s.string().optional(),
  region: s.string().optional(),
  apiVersion: s.string().optional(),
  timeoutMs: s.int().min(1_000).optional(),
  retries: s.int().min(0).max(10).optional(),
  /** Requests per minute; shapes traffic locally to avoid 429s. */
  requestsPerMinute: s.int().min(1).optional(),
  tokensPerMinute: s.int().min(1).optional(),
  models: s.record(ModelConfigSchema).optional(),
  /** Extra body fields merged into every request. */
  options: s.record(s.any()).optional(),
  disable: s.boolean().default(false),
})

export type ProviderConfig = Infer<typeof ProviderConfigSchema>

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

export const McpLocalSchema = s.object({
  type: s.literal("local"),
  command: s.array(s.string()).nonEmpty(),
  environment: s.record(s.string()).optional(),
  cwd: s.string().optional(),
  enabled: s.boolean().default(true),
  timeoutMs: s.int().min(1_000).optional(),
  /** Restrict which of the server's tools are exposed. */
  tools: s.array(s.string()).optional(),
  excludeTools: s.array(s.string()).optional(),
  /** Prefix applied to tool names to avoid collisions. */
  prefix: s.string().optional(),
})

export const McpRemoteSchema = s.object({
  type: s.literal("remote"),
  url: s.string().nonEmpty(),
  headers: s.record(s.string()).optional(),
  enabled: s.boolean().default(true),
  timeoutMs: s.int().min(1_000).optional(),
  tools: s.array(s.string()).optional(),
  excludeTools: s.array(s.string()).optional(),
  prefix: s.string().optional(),
  /** Force a transport instead of negotiating streamable-HTTP then SSE. */
  transport: s.enum(["http", "sse", "auto"] as const).default("auto"),
  oauth: s.boolean().default(false),
})

export const McpServerSchema = s.discriminated<
  Infer<typeof McpLocalSchema> | Infer<typeof McpRemoteSchema>
>("type", {
  local: McpLocalSchema,
  remote: McpRemoteSchema,
})

export type McpServerConfig = Infer<typeof McpLocalSchema> | Infer<typeof McpRemoteSchema>

/* ------------------------------------------------------------------ */
/* LSP, formatters, commands, skills                                   */
/* ------------------------------------------------------------------ */

export const LspConfigSchema = s.object({
  command: s.array(s.string()).nonEmpty(),
  extensions: s.array(s.string()).optional(),
  /** Files whose presence activates this server. */
  rootMarkers: s.array(s.string()).optional(),
  environment: s.record(s.string()).optional(),
  initialization: s.record(s.any()).optional(),
  settings: s.record(s.any()).optional(),
  disabled: s.boolean().default(false),
  timeoutMs: s.int().min(1_000).optional(),
})

export type LspConfig = Infer<typeof LspConfigSchema>

export const FormatterConfigSchema = s.object({
  command: s.array(s.string()).nonEmpty().describe("Use {file} for the path, or pipe via stdin"),
  extensions: s.array(s.string()).optional(),
  environment: s.record(s.string()).optional(),
  /** Feed the file through stdin instead of passing a path. */
  stdin: s.boolean().default(false),
  disabled: s.boolean().default(false),
  timeoutMs: s.int().min(1_000).optional(),
})

export type FormatterConfig = Infer<typeof FormatterConfigSchema>

export const CommandConfigSchema = s.object({
  description: s.string().optional(),
  template: s.string().describe("Prompt template; $ARGUMENTS and $1..$9 are substituted"),
  agent: s.string().optional(),
  model: s.string().optional(),
  /** Shell commands run before the prompt, with output injected as context. */
  prerun: s.array(s.string()).optional(),
  aliases: s.array(s.string()).optional(),
  hidden: s.boolean().default(false),
})

export type CommandConfig = Infer<typeof CommandConfigSchema>

export const SkillConfigSchema = s.object({
  description: s.string(),
  path: s.string().optional(),
  content: s.string().optional(),
  /** Extra files loaded alongside the skill body. */
  resources: s.array(s.string()).optional(),
  disable: s.boolean().default(false),
})

/* ------------------------------------------------------------------ */
/* Keybinds and TUI                                                    */
/* ------------------------------------------------------------------ */

export const KeybindSchema = s.record(s.string())

export const TuiConfigSchema = s.object({
  theme: s.string().optional(),
  /** Layout: `auto` shows a sidebar on wide terminals. */
  layout: s.enum(["auto", "stacked", "sidebar"] as const).default("auto"),
  mouse: s.boolean().default(true),
  copyOnSelect: s.boolean().default(true),
  scrollSpeed: s.number().min(0.1).max(10).default(1),
  smoothScroll: s.boolean().default(true),
  showLineNumbers: s.boolean().default(true),
  showThinking: s.boolean().default(true),
  showTokenCount: s.boolean().default(true),
  showCost: s.boolean().default(true),
  compactDiffs: s.boolean().default(false),
  diffStyle: s.enum(["unified", "split", "auto"] as const).default("auto"),
  wrapCode: s.boolean().default(false),
  sound: s.boolean().default(false),
  notifications: s.boolean().default(true),
  /** Terminal bell / OSC 9 notification when a long turn completes. */
  notifyAfterMs: s.int().min(0).default(20_000),
  cursorShape: s.enum(["block", "underline", "bar"] as const).default("bar"),
  fontLigatures: s.boolean().default(true),
  editorCommand: s.string().optional(),
  keybinds: KeybindSchema.optional(),
  /** Named roots for `@alias/path` file references. */
  referenceRoots: s.record(s.string()).optional(),
})

export type TuiConfig = Infer<typeof TuiConfigSchema>

/* ------------------------------------------------------------------ */
/* Watcher, share, experimental                                        */
/* ------------------------------------------------------------------ */

export const WatcherConfigSchema = s.object({
  enabled: s.boolean().default(true),
  ignore: s.array(s.string()).optional(),
  debounceMs: s.int().min(0).default(120),
})

export const ShareConfigSchema = s.enum(["manual", "auto", "disabled"] as const)

export const CompactionConfigSchema = s.object({
  enabled: s.boolean().default(true),
  /** Fraction of the context window that triggers compaction. */
  threshold: s.number().min(0.1).max(0.99).default(0.9),
  /** Tokens reserved for the model's reply. */
  reserve: s.int().min(0).default(24_000),
  /** Messages always kept verbatim at the tail. */
  keepRecent: s.int().min(0).default(4),
  model: s.string().optional(),
})

export const SnapshotConfigSchema = s.object({
  enabled: s.boolean().default(true),
  /** Maximum snapshots retained per session. */
  keep: s.int().min(1).default(50),
  /** Skip files larger than this (bytes). */
  maxFileSize: s.int().min(1024).default(2 * 1024 * 1024),
})

export const ToolsConfigSchema = s.object({
  bashTimeoutMs: s.int().min(1_000).optional(),
  bashMaxOutputBytes: s.int().min(1024).optional(),
  readMaxLines: s.int().min(1).optional(),
  grepMaxResults: s.int().min(1).optional(),
  parallel: s.boolean().default(true),
  maxParallel: s.int().min(1).max(64).optional(),
  /** Tools disabled globally, e.g. `["websearch"]`. */
  disable: s.array(s.string()).optional(),
  /** Environment variables injected into every bash invocation. */
  environment: s.record(s.string()).optional(),
  /** Run formatters automatically after each edit. */
  formatOnEdit: s.boolean().default(true),
  /** Report LSP diagnostics back to the model after each edit. */
  diagnosticsOnEdit: s.boolean().default(true),
})

/* ------------------------------------------------------------------ */
/* Root                                                               */
/* ------------------------------------------------------------------ */

export const ConfigSchema = s.object({
  $schema: s.string().optional(),

  /** Default model as `provider/model`. */
  model: s.string().optional(),
  /** Cheap model for titles, compaction and classification. */
  smallModel: s.string().optional(),
  /** Default agent for new sessions. */
  agent: s.string().optional(),
  temperature: s.number().min(0).max(2).optional(),
  topP: s.number().min(0).max(1).optional(),
  maxOutputTokens: s.int().min(1).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),

  /** Extra instruction files appended to the system prompt. */
  instructions: s.array(s.string()).optional(),
  /** Text appended verbatim to the system prompt. */
  systemAppend: s.string().optional(),

  provider: s.record(ProviderConfigSchema).optional(),
  agents: s.record(AgentConfigSchema).optional(),
  command: s.record(CommandConfigSchema).optional(),
  skill: s.record(SkillConfigSchema).optional(),
  mcp: s.record(McpServerSchema).optional(),
  lsp: s.record(LspConfigSchema).optional(),
  formatter: s.record(FormatterConfigSchema).optional(),
  permission: PermissionConfigSchema.optional(),
  plugin: s.array(s.string()).optional(),

  tools: ToolsConfigSchema.optional(),
  tui: TuiConfigSchema.optional(),
  watcher: WatcherConfigSchema.optional(),
  compaction: CompactionConfigSchema.optional(),
  snapshot: SnapshotConfigSchema.optional(),
  share: ShareConfigSchema.optional(),
  shareUrl: s.string().optional(),

  /** Autoupdate check for new releases. */
  autoupdate: s.boolean().default(true),
  /** Suppress the startup banner. */
  quiet: s.boolean().default(false),
  /** Additional directories the agent may read/write. */
  additionalDirectories: s.array(s.string()).optional(),
  /** Experimental toggles, mirrored by PRAXIS_EXPERIMENTAL_* env vars. */
  experimental: s.record(s.any()).optional(),

  /** Legacy: a flat tool allow-map, migrated into `permission`. */
  disabledTools: s.array(s.string()).optional(),
})

export type Config = Infer<typeof ConfigSchema>

/** JSON Schema for editor integration. */
export function configJsonSchema(): JsonSchema {
  const schema = ConfigSchema.jsonSchema()
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://praxis.dev/config.json",
    title: "Praxis configuration",
    ...schema,
  }
}

/** Empty configuration used as the merge base. */
export const EMPTY_CONFIG: Config = {
  autoupdate: true,
  quiet: false,
} as Config

/**
 * Default keybinds. `<leader>` chains, `+` combines modifiers, `,` separates
 * alternatives, and `"none"` disables a binding.
 */
export const DEFAULT_KEYBINDS: Record<string, string> = {
  leader: "ctrl+x",

  app_help: "<leader>h",
  app_exit: "<leader>q,ctrl+c",
  app_suspend: "ctrl+z",
  command_palette: "ctrl+p",

  session_new: "<leader>n",
  session_list: "<leader>l",
  session_share: "<leader>s",
  session_unshare: "<leader>S",
  session_export: "<leader>x",
  session_compact: "<leader>c",
  session_rename: "<leader>R",
  session_delete: "<leader>D",
  session_child_cycle: "<leader>right",
  session_child_cycle_reverse: "<leader>left",

  message_undo: "<leader>u",
  message_redo: "<leader>r",
  message_copy: "<leader>y",
  message_revert: "<leader>v",
  messages_first: "ctrl+g,home",
  messages_last: "ctrl+alt+g,end",
  messages_page_up: "pageup",
  messages_page_down: "pagedown",
  messages_half_page_up: "ctrl+u",
  messages_half_page_down: "ctrl+d",
  messages_previous: "ctrl+k",
  messages_next: "ctrl+j",

  agent_cycle: "tab",
  agent_cycle_reverse: "shift+tab",
  agent_list: "<leader>a",
  model_list: "<leader>m",
  model_cycle_recent: "f2",
  model_cycle_variant: "ctrl+t",

  editor_open: "<leader>e",
  file_list: "<leader>f",
  file_diff_toggle: "<leader>d",
  theme_list: "<leader>t",
  tool_details: "<leader>i",
  thinking_toggle: "<leader>T",

  input_submit: "enter",
  input_newline: "shift+enter,ctrl+enter,alt+enter",
  input_clear: "ctrl+c",
  input_paste: "ctrl+v",
  input_history_previous: "up",
  input_history_next: "down",
  interrupt: "escape",
}
