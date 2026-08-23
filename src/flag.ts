/**
 * Environment flag registry.
 *
 * Every environment variable the application reads is declared here with a
 * type, default and description. `praxis doctor --env` prints this table, so
 * documentation cannot drift away from the implementation.
 */

import { ENV_PREFIX } from "./global.js"

export type FlagKind = "boolean" | "number" | "string" | "list" | "json"

export interface FlagDefinition {
  readonly key: string
  readonly env: string
  readonly kind: FlagKind
  readonly description: string
  readonly experimental: boolean
  readonly secret: boolean
}

const DEFINITIONS: FlagDefinition[] = []

function register(def: FlagDefinition): FlagDefinition {
  DEFINITIONS.push(def)
  return def
}

export function flagDefinitions(): readonly FlagDefinition[] {
  return DEFINITIONS.slice().sort((a, b) => a.env.localeCompare(b.env))
}

function envName(key: string, experimental: boolean): string {
  return `${ENV_PREFIX}${experimental ? "EXPERIMENTAL_" : ""}${key}`
}

interface Options {
  readonly experimental?: boolean
  readonly secret?: boolean
  readonly aliases?: readonly string[]
}

function read(env: string, aliases: readonly string[] = []): string | undefined {
  const direct = process.env[env]
  if (direct !== undefined && direct !== "") return direct
  for (const alias of aliases) {
    const value = process.env[alias]
    if (value !== undefined && value !== "") return value
  }
  return undefined
}

function truthy(raw: string): boolean {
  const v = raw.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on" || v === "enabled"
}

function falsy(raw: string): boolean {
  const v = raw.trim().toLowerCase()
  return v === "0" || v === "false" || v === "no" || v === "off" || v === "disabled"
}

function boolFlag(key: string, description: string, fallback = false, options: Options = {}) {
  const env = envName(key, options.experimental ?? false)
  register({
    key,
    env,
    kind: "boolean",
    description,
    experimental: options.experimental ?? false,
    secret: false,
  })
  return () => {
    const raw = read(env, options.aliases)
    if (raw === undefined) return fallback
    if (truthy(raw)) return true
    if (falsy(raw)) return false
    return fallback
  }
}

function numberFlag(
  key: string,
  description: string,
  fallback: number | undefined,
  options: Options = {},
) {
  const env = envName(key, options.experimental ?? false)
  register({
    key,
    env,
    kind: "number",
    description,
    experimental: options.experimental ?? false,
    secret: false,
  })
  return () => {
    const raw = read(env, options.aliases)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }
}

function stringFlag(
  key: string,
  description: string,
  fallback: string | undefined,
  options: Options = {},
) {
  const env = envName(key, options.experimental ?? false)
  register({
    key,
    env,
    kind: "string",
    description,
    experimental: options.experimental ?? false,
    secret: options.secret ?? false,
  })
  return () => read(env, options.aliases) ?? fallback
}

function listFlag(key: string, description: string, options: Options = {}) {
  const env = envName(key, options.experimental ?? false)
  register({
    key,
    env,
    kind: "list",
    description,
    experimental: options.experimental ?? false,
    secret: false,
  })
  return (): string[] => {
    const raw = read(env, options.aliases)
    if (!raw) return []
    return raw
      .split(/[,:]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
}

function jsonFlag<T>(key: string, description: string, options: Options = {}) {
  const env = envName(key, options.experimental ?? false)
  register({
    key,
    env,
    kind: "json",
    description,
    experimental: options.experimental ?? false,
    secret: options.secret ?? false,
  })
  return (): T | undefined => {
    const raw = read(env, options.aliases)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }
}

/**
 * Flags are accessor functions rather than values so tests (and the TUI's
 * live-reload) observe changes to `process.env` without re-importing modules.
 */
export const Flag = {
  /* --- core behaviour ------------------------------------------------- */
  config: stringFlag("CONFIG", "Path to an additional config file, loaded last.", undefined),
  configContent: stringFlag(
    "CONFIG_CONTENT",
    "Inline JSON config merged with the highest priority.",
    undefined,
  ),
  model: stringFlag("MODEL", "Default model as provider/model.", undefined),
  smallModel: stringFlag(
    "SMALL_MODEL",
    "Cheap model used for titles, compaction and classification.",
    undefined,
  ),
  agent: stringFlag("AGENT", "Default agent name.", undefined),
  theme: stringFlag("THEME", "TUI theme name.", undefined),
  logLevel: stringFlag("LOG_LEVEL", "trace | debug | info | warn | error | silent.", undefined),
  logFormat: stringFlag("LOG_FORMAT", "pretty | json.", undefined),
  logFile: stringFlag("LOG_FILE", "Override the log file path.", undefined),
  noColor: boolFlag("NO_COLOR", "Disable all ANSI colour output.", false, {
    aliases: ["NO_COLOR"],
  }),
  forceColor: boolFlag("FORCE_COLOR", "Force ANSI colour even when not a TTY.", false, {
    aliases: ["FORCE_COLOR"],
  }),
  dataDir: stringFlag("DATA_HOME", "Override the data directory.", undefined),
  disableAutoupdate: boolFlag("DISABLE_AUTOUPDATE", "Never check for new releases.", false),
  disableTelemetry: boolFlag(
    "DISABLE_TELEMETRY",
    "Disable anonymous usage counters (off by default anyway).",
    true,
  ),
  offline: boolFlag("OFFLINE", "Never make non-provider network calls.", false),

  /* --- provider / model ---------------------------------------------- */
  modelsPath: stringFlag("MODELS_PATH", "Path to a local model catalog JSON file.", undefined),
  modelsUrl: stringFlag("MODELS_URL", "Remote model catalog endpoint.", undefined),
  apiKeyEnvOnly: boolFlag(
    "API_KEY_ENV_ONLY",
    "Ignore stored credentials; use environment variables only.",
    false,
  ),
  providerTimeout: numberFlag("PROVIDER_TIMEOUT_MS", "Provider request timeout.", undefined),
  providerRetries: numberFlag("PROVIDER_RETRIES", "Provider retry attempts.", undefined),
  proxy: stringFlag("PROXY", "HTTP(S) proxy URL for provider traffic.", undefined, {
    aliases: ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"],
  }),
  permission: jsonFlag<unknown>("PERMISSION", "Inline JSON permission overrides."),

  /* --- experimental --------------------------------------------------- */
  bashDefaultTimeout: numberFlag(
    "BASH_DEFAULT_TIMEOUT_MS",
    "Default timeout for bash commands.",
    undefined,
    { experimental: true },
  ),
  outputTokenMax: numberFlag("OUTPUT_TOKEN_MAX", "Hard cap on response tokens.", undefined, {
    experimental: true,
  }),
  fileWatcher: boolFlag("FILEWATCHER", "Watch the whole project tree for changes.", true, {
    experimental: true,
  }),
  disableFileWatcher: boolFlag("DISABLE_FILEWATCHER", "Turn the file watcher off.", false, {
    experimental: true,
  }),
  lspTool: boolFlag("LSP_TOOL", "Expose the full LSP tool (not just diagnostics).", true, {
    experimental: true,
  }),
  planMode: boolFlag("PLAN_MODE", "Enable the read-only plan agent.", true, {
    experimental: true,
  }),
  backgroundSubagents: boolFlag(
    "BACKGROUND_SUBAGENTS",
    "Allow subagents to run detached from the parent turn.",
    true,
    { experimental: true },
  ),
  webSearch: boolFlag("WEBSEARCH", "Enable the websearch tool.", false, { experimental: true }),
  codeSearch: boolFlag("CODESEARCH", "Enable the semantic codesearch tool.", false, {
    experimental: true,
  }),
  disableCopyOnSelect: boolFlag(
    "DISABLE_COPY_ON_SELECT",
    "Do not copy to clipboard when selecting in the TUI.",
    false,
    { experimental: true },
  ),
  iconDiscovery: boolFlag("ICON_DISCOVERY", "Probe the terminal for icon/glyph support.", true, {
    experimental: true,
  }),
  mouse: boolFlag("MOUSE", "Enable mouse reporting in the TUI.", true, { experimental: true }),
  syncedOutput: boolFlag(
    "SYNCED_OUTPUT",
    "Use synchronized update sequences (DEC 2026) when supported.",
    true,
    { experimental: true },
  ),
  truecolor: boolFlag("TRUECOLOR", "Assume 24-bit colour support.", false, {
    experimental: true,
  }),
  promptCache: boolFlag("PROMPT_CACHE", "Mark cache breakpoints for supported providers.", true, {
    experimental: true,
  }),
  parallelTools: boolFlag("PARALLEL_TOOLS", "Execute independent tool calls concurrently.", true, {
    experimental: true,
  }),
  autoCompact: boolFlag("AUTO_COMPACT", "Automatically compact long conversations.", true, {
    experimental: true,
  }),
  strictSchemas: boolFlag(
    "STRICT_SCHEMAS",
    "Emit strict JSON Schema for tools (structured outputs).",
    false,
    { experimental: true },
  ),

  /* --- debugging ------------------------------------------------------ */
  dumpRequests: stringFlag(
    "DUMP_REQUESTS",
    "Directory to write raw provider requests/responses into.",
    undefined,
  ),
  printPrompt: boolFlag("PRINT_PROMPT", "Print the assembled system prompt and exit.", false),
  traceTools: boolFlag("TRACE_TOOLS", "Log every tool call argument and result.", false),
  devServerPort: numberFlag("PORT", "Port for `praxis serve`.", undefined),
} as const

/** Snapshot of every flag's effective value, for `doctor` output. */
export function flagSnapshot(): Array<{ env: string; value: string; source: "env" | "default" }> {
  return flagDefinitions().map((def) => {
    const raw = process.env[def.env]
    const present = raw !== undefined && raw !== ""
    const value = !present ? "" : def.secret ? "***" : raw
    return { env: def.env, value, source: present ? "env" : "default" }
  })
}
