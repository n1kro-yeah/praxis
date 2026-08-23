/**
 * Configuration loading and layering.
 *
 * Seven sources are merged, lowest priority first:
 *
 *   1. built-in defaults
 *   2. global user config      (`~/.config/praxis/praxis.jsonc`)
 *   3. `PRAXIS_CONFIG` file
 *   4. project config          (`./praxis.json`, `.praxis/config.json`)
 *   5. `.praxis/` directory scan (agents, commands, skills, plugins)
 *   6. `PRAXIS_CONFIG_CONTENT` inline JSON
 *   7. system policy           (`/etc/praxis/praxis.json`) — highest, so an
 *      administrator can enforce restrictions a user cannot override
 *
 * Values support `{env:VAR}` and `{file:path}` substitution, resolved after
 * merging so a project can reference secrets without committing them.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { Flag } from "../flag.js"
import {
  APP_NAME,
  INSTRUCTION_FILES,
  PROJECT_CONFIG_FILES,
  PROJECT_DIR_NAME,
  Paths,
  expandHome,
} from "../global.js"
import { ConfigError } from "../util/error.js"
import { exists, readFileSafe } from "../util/fs-extra.js"
import { parseJsonc } from "../util/jsonc.js"
import type { JsonValue } from "../util/jsonc.js"
import { logger } from "../util/log.js"
import { deepMerge, deepMergeConcat, unique } from "../util/misc.js"
import { formatIssues } from "../util/schema.js"
import { ConfigSchema, DEFAULT_KEYBINDS, EMPTY_CONFIG } from "./schema.js"
import type { Config } from "./schema.js"

const log = logger("config")

export interface ConfigSource {
  readonly kind:
    | "defaults"
    | "global"
    | "env-file"
    | "project"
    | "project-dir"
    | "env-inline"
    | "system"
  readonly path?: string
  readonly value: Record<string, unknown>
}

export interface LoadedConfig {
  readonly config: Config
  readonly sources: readonly ConfigSource[]
  /** Absolute paths of instruction files discovered in the project. */
  readonly instructionFiles: readonly string[]
  /** Markdown agent definitions found under `.praxis/agent`. */
  readonly agentFiles: readonly string[]
  readonly commandFiles: readonly string[]
  readonly skillFiles: readonly string[]
  readonly pluginFiles: readonly string[]
  readonly themeFiles: readonly string[]
  readonly projectRoot: string
  readonly keybinds: Record<string, string>
  /** Non-fatal problems: unknown keys, unreadable files, failed substitutions. */
  readonly warnings: readonly string[]
}

/* ------------------------------------------------------------------ */
/* Variable substitution                                               */
/* ------------------------------------------------------------------ */

const ENV_PATTERN = /\{env:([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g
const FILE_PATTERN = /\{file:([^}]+)\}/g
const SELF_PATTERN = /\{(cwd|home|config|data|projectRoot)\}/g

interface SubstitutionContext {
  readonly cwd: string
  readonly projectRoot: string
  readonly warnings: string[]
}

async function substituteString(value: string, ctx: SubstitutionContext): Promise<string> {
  let out = value.replace(SELF_PATTERN, (_match, key: string) => {
    switch (key) {
      case "cwd":
        return ctx.cwd
      case "home":
        return expandHome("~")
      case "config":
        return Paths.config
      case "data":
        return Paths.data
      case "projectRoot":
        return ctx.projectRoot
      default:
        return _match
    }
  })

  out = out.replace(ENV_PATTERN, (match, name: string, fallback?: string) => {
    const env = process.env[name]
    if (env !== undefined && env !== "") return env
    if (fallback !== undefined) return fallback
    ctx.warnings.push(`environment variable ${name} referenced by config is not set`)
    return ""
  })

  // File substitution is async, so collect then replace.
  const fileMatches = [...out.matchAll(FILE_PATTERN)]
  for (const match of fileMatches) {
    const target = path.isAbsolute(match[1] as string)
      ? (match[1] as string)
      : path.resolve(ctx.projectRoot, expandHome(match[1] as string))
    const content = await readFileSafe(target)
    if (content === undefined) {
      ctx.warnings.push(`config referenced unreadable file ${target}`)
      out = out.replace(match[0], "")
      continue
    }
    out = out.replace(match[0], content.trim())
  }

  return out
}

async function substitute(value: unknown, ctx: SubstitutionContext): Promise<unknown> {
  if (typeof value === "string") return substituteString(value, ctx)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await substitute(item, ctx))
    return out
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = await substitute(item, ctx)
    }
    return out
  }
  return value
}

/* ------------------------------------------------------------------ */
/* Project root discovery                                              */
/* ------------------------------------------------------------------ */

const ROOT_MARKERS = [
  ".git",
  PROJECT_DIR_NAME,
  `${APP_NAME}.json`,
  `${APP_NAME}.jsonc`,
  "package.json",
  "pnpm-workspace.yaml",
  "deno.json",
  "deno.jsonc",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "mix.exs",
  "Package.swift",
  "CMakeLists.txt",
  "Makefile",
  ".hg",
  ".svn",
]

/**
 * Finds the project root by walking up for a marker. `.git` wins over other
 * markers so monorepo packages resolve to the repository root, which is what
 * users expect for git snapshots and ripgrep scope.
 */
export async function findProjectRoot(start = process.cwd()): Promise<string> {
  let dir = path.resolve(start)
  let fallback: string | undefined

  for (let depth = 0; depth < 128; depth++) {
    if (await exists(path.join(dir, ".git"))) return dir
    if (!fallback) {
      for (const marker of ROOT_MARKERS) {
        if (marker === ".git") continue
        if (await exists(path.join(dir, marker))) {
          fallback = dir
          break
        }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return fallback ?? path.resolve(start)
}

/* ------------------------------------------------------------------ */
/* Directory scanning                                                  */
/* ------------------------------------------------------------------ */

async function listFiles(dir: string, extensions: readonly string[]): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const out: string[] = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // One level of nesting supports `agent/backend/reviewer.md`.
        try {
          for (const nested of await fsp.readdir(full, { withFileTypes: true })) {
            if (!nested.isFile()) continue
            if (extensions.some((ext) => nested.name.endsWith(ext))) {
              out.push(path.join(full, nested.name))
            }
          }
        } catch {
          /* unreadable */
        }
        continue
      }
      if (!entry.isFile()) continue
      if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full)
    }
    return out.sort()
  } catch {
    return []
  }
}

async function readConfigFile(
  target: string,
  warnings: string[],
): Promise<Record<string, unknown> | undefined> {
  const content = await readFileSafe(target)
  if (content === undefined) return undefined
  if (content.trim() === "") return {}
  try {
    const parsed = parseJsonc(content, { source: target })
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`${target}: expected a JSON object at the top level`)
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new ConfigError({
      path: target,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/* ------------------------------------------------------------------ */
/* Legacy migration                                                    */
/* ------------------------------------------------------------------ */

/**
 * Older configs used a flat `tools` allow-map (`{"bash": false}`) and a
 * `mode` key for agents. Rewrite them into the current shape so upgrading is
 * seamless, and warn so the user can clean up.
 */
function migrate(raw: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const out = { ...raw }

  // `tools: { bash: false }` → `permission: [{ action, resource: "*", effect: "deny" }]`
  const tools = out["tools"]
  if (tools && typeof tools === "object" && !Array.isArray(tools)) {
    const entries = Object.entries(tools as Record<string, unknown>)
    const booleanEntries = entries.filter(([, value]) => typeof value === "boolean")
    if (booleanEntries.length && booleanEntries.length === entries.length) {
      warnings.push(
        "config: the flat `tools` allow-map is deprecated; migrated into `permission`",
      )
      const rules: Array<Record<string, unknown>> = []
      const disabled: string[] = []
      for (const [name, allowed] of booleanEntries) {
        const action = TOOL_TO_ACTION[name] ?? "shell"
        if (allowed === false) {
          disabled.push(name)
          rules.push({ action, resource: "*", effect: "deny" })
          continue
        }
        rules.push({ action, resource: "*", effect: "allow" })
      }
      delete out["tools"]
      if (disabled.length) out["disabledTools"] = disabled
      const existing = out["permission"]
      out["permission"] = Array.isArray(existing) ? [...rules, ...existing] : rules
    }
  }

  // `agent` used to be the agent map; it is now a string naming the default.
  const agent = out["agent"]
  if (agent && typeof agent === "object" && !Array.isArray(agent)) {
    warnings.push("config: `agent` as a map is deprecated; use `agents`")
    out["agents"] = deepMerge(out["agents"] ?? {}, agent)
    delete out["agent"]
  }

  // `autoshare: true` → `share: "auto"`.
  if (out["autoshare"] !== undefined) {
    warnings.push("config: `autoshare` is deprecated; use `share`")
    if (out["share"] === undefined) out["share"] = out["autoshare"] ? "auto" : "manual"
    delete out["autoshare"]
  }

  // `keybinds` used to live at the root; it belongs under `tui`.
  if (out["keybinds"] !== undefined) {
    const tui = (out["tui"] ?? {}) as Record<string, unknown>
    out["tui"] = { ...tui, keybinds: deepMerge(tui["keybinds"] ?? {}, out["keybinds"]) }
    delete out["keybinds"]
  }

  // `theme` at the root moves under `tui`.
  if (typeof out["theme"] === "string") {
    const tui = (out["tui"] ?? {}) as Record<string, unknown>
    if (tui["theme"] === undefined) out["tui"] = { ...tui, theme: out["theme"] }
    delete out["theme"]
  }

  return out
}

/** Maps legacy tool names to permission actions. */
const TOOL_TO_ACTION: Record<string, string> = {
  bash: "shell",
  edit: "edit",
  write: "edit",
  patch: "edit",
  apply_patch: "edit",
  multiedit: "edit",
  read: "read",
  glob: "read",
  grep: "read",
  list: "read",
  task: "subagent",
  webfetch: "webfetch",
  websearch: "websearch",
  lsp: "lsp",
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export interface LoadOptions {
  readonly cwd?: string
  /** Skip the global and system layers; used by tests and `--isolated`. */
  readonly isolated?: boolean
  /** Extra config objects applied last (CLI flags). */
  readonly overrides?: readonly Record<string, unknown>[]
}

export async function loadConfig(options: LoadOptions = {}): Promise<LoadedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const projectRoot = await findProjectRoot(cwd)
  const warnings: string[] = []
  const sources: ConfigSource[] = []

  sources.push({ kind: "defaults", value: {} })

  /* 2. Global user config. */
  if (!options.isolated) {
    for (const candidate of [Paths.configFile, Paths.configFileJson]) {
      const value = await readConfigFile(candidate, warnings)
      if (value) {
        sources.push({ kind: "global", path: candidate, value })
        break
      }
    }
  }

  /* 3. PRAXIS_CONFIG. */
  const envConfigPath = Flag.config()
  if (envConfigPath) {
    const resolved = path.resolve(cwd, expandHome(envConfigPath))
    const value = await readConfigFile(resolved, warnings)
    if (value) sources.push({ kind: "env-file", path: resolved, value })
    else warnings.push(`PRAXIS_CONFIG points at unreadable file ${resolved}`)
  }

  /* 4. Project config. Walk from the root down to cwd so nested packages can
        refine the repository-level configuration. */
  const chain: string[] = []
  let dir = cwd
  for (let depth = 0; depth < 64; depth++) {
    chain.unshift(dir)
    if (dir === projectRoot || path.dirname(dir) === dir) break
    dir = path.dirname(dir)
  }
  for (const directory of chain) {
    for (const name of PROJECT_CONFIG_FILES) {
      const candidate = path.join(directory, name)
      const value = await readConfigFile(candidate, warnings)
      if (value) {
        sources.push({ kind: "project", path: candidate, value })
        break
      }
    }
  }

  /* 5. Directory scan. */
  const projectPraxisDir = path.join(projectRoot, PROJECT_DIR_NAME)
  const agentFiles = [
    ...(await listFiles(Paths.agentDir, [".md", ".markdown"])),
    ...(await listFiles(path.join(projectPraxisDir, "agent"), [".md", ".markdown"])),
    ...(await listFiles(path.join(projectPraxisDir, "agents"), [".md", ".markdown"])),
  ]
  const commandFiles = [
    ...(await listFiles(Paths.commandDir, [".md", ".markdown"])),
    ...(await listFiles(path.join(projectPraxisDir, "command"), [".md", ".markdown"])),
    ...(await listFiles(path.join(projectPraxisDir, "commands"), [".md", ".markdown"])),
  ]
  const skillFiles = [
    ...(await listFiles(Paths.skillDir, [".md", ".markdown"])),
    ...(await listFiles(path.join(projectPraxisDir, "skill"), [".md", ".markdown"])),
    ...(await listFiles(path.join(projectPraxisDir, "skills"), [".md", ".markdown"])),
  ]
  const pluginFiles = [
    ...(await listFiles(Paths.pluginDir, [".js", ".mjs", ".cjs"])),
    ...(await listFiles(path.join(projectPraxisDir, "plugin"), [".js", ".mjs", ".cjs"])),
    ...(await listFiles(path.join(projectPraxisDir, "plugins"), [".js", ".mjs", ".cjs"])),
  ]
  const themeFiles = [
    ...(await listFiles(Paths.themeDir, [".json"])),
    ...(await listFiles(path.join(projectPraxisDir, "theme"), [".json"])),
    ...(await listFiles(path.join(projectPraxisDir, "themes"), [".json"])),
  ]

  /* 6. PRAXIS_CONFIG_CONTENT. */
  const inline = Flag.configContent()
  if (inline) {
    try {
      const parsed = parseJsonc(inline, { source: "PRAXIS_CONFIG_CONTENT" })
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        sources.push({ kind: "env-inline", value: parsed as Record<string, unknown> })
      }
    } catch (error) {
      warnings.push(
        `PRAXIS_CONFIG_CONTENT is not valid JSON: ${error instanceof Error ? error.message : error}`,
      )
    }
  }

  /* 7. System policy. */
  if (!options.isolated) {
    const systemPath =
      process.platform === "win32"
        ? path.join(process.env.PROGRAMDATA ?? "C:\\ProgramData", APP_NAME, `${APP_NAME}.json`)
        : path.join("/etc", APP_NAME, `${APP_NAME}.json`)
    const value = await readConfigFile(systemPath, warnings)
    if (value) sources.push({ kind: "system", path: systemPath, value })
  }

  for (const override of options.overrides ?? []) {
    sources.push({ kind: "env-inline", value: override })
  }

  /* Merge. Arrays concatenate for additive keys (instructions, plugin,
     additionalDirectories, permission) and replace elsewhere. */
  let merged: Record<string, unknown> = {}
  for (const source of sources) {
    const migrated = migrate(source.value, warnings)
    merged = mergeLayer(merged, migrated)
  }

  const substituted = (await substitute(merged, {
    cwd,
    projectRoot,
    warnings,
  })) as Record<string, unknown>

  /* Environment flags win over files for a handful of settings. */
  applyFlagOverrides(substituted)

  const parsed = ConfigSchema.safeParse(substituted)
  if (!parsed.ok) {
    // Unknown or malformed keys should not brick the CLI: warn and fall back to
    // the subset that does validate.
    warnings.push(`config validation failed:\n${formatIssues(parsed.issues)}`)
    log.warn("config validation failed", { issues: parsed.issues })
    const salvaged = salvage(substituted, parsed.issues.map((i) => i.path))
    const retry = ConfigSchema.safeParse(salvaged)
    if (!retry.ok) {
      throw new ConfigError({ detail: formatIssues(parsed.issues) })
    }
    return finalize(retry.value, sources, projectRoot, {
      agentFiles,
      commandFiles,
      skillFiles,
      pluginFiles,
      themeFiles,
      warnings,
      projectRoot,
      cwd,
    })
  }

  return finalize(parsed.value, sources, projectRoot, {
    agentFiles,
    commandFiles,
    skillFiles,
    pluginFiles,
    themeFiles,
    warnings,
    projectRoot,
    cwd,
  })
}

const ADDITIVE_KEYS = new Set([
  "instructions",
  "plugin",
  "additionalDirectories",
  "permission",
  "disabledTools",
])

function mergeLayer(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    if (ADDITIVE_KEYS.has(key) && Array.isArray(value) && Array.isArray(out[key])) {
      out[key] = unique([...(out[key] as unknown[]), ...value], (item) =>
        typeof item === "string" ? item : JSON.stringify(item),
      )
      continue
    }
    out[key] = deepMergeConcat(out[key], value)
  }
  return out
}

function applyFlagOverrides(config: Record<string, unknown>): void {
  const model = Flag.model()
  if (model) config["model"] = model
  const smallModel = Flag.smallModel()
  if (smallModel) config["smallModel"] = smallModel
  const agent = Flag.agent()
  if (agent) config["agent"] = agent
  const theme = Flag.theme()
  if (theme) {
    const tui = (config["tui"] ?? {}) as Record<string, unknown>
    config["tui"] = { ...tui, theme }
  }
  if (Flag.disableAutoupdate()) config["autoupdate"] = false
  const permission = Flag.permission()
  if (permission) {
    config["permission"] = permission
  }
  if (Flag.disableFileWatcher()) {
    const watcher = (config["watcher"] ?? {}) as Record<string, unknown>
    config["watcher"] = { ...watcher, enabled: false }
  }
  const bashTimeout = Flag.bashDefaultTimeout()
  if (bashTimeout) {
    const tools = (config["tools"] ?? {}) as Record<string, unknown>
    config["tools"] = { ...tools, bashTimeoutMs: bashTimeout }
  }
  if (Flag.disableCopyOnSelect()) {
    const tui = (config["tui"] ?? {}) as Record<string, unknown>
    config["tui"] = { ...tui, copyOnSelect: false }
  }
}

/** Deletes the offending paths so a single bad key cannot break startup. */
function salvage(
  config: Record<string, unknown>,
  badPaths: readonly string[],
): Record<string, unknown> {
  const out = structuredClone(config)
  for (const badPath of badPaths) {
    if (!badPath) continue
    const segments = badPath.split(/\.|\[/).map((s) => s.replace(/\]$/, ""))
    let cursor: any = out
    for (let i = 0; i < segments.length - 1; i++) {
      cursor = cursor?.[segments[i] as string]
      if (cursor === undefined) break
    }
    if (cursor && typeof cursor === "object") {
      delete cursor[segments[segments.length - 1] as string]
    }
  }
  return out
}

async function discoverInstructionFiles(projectRoot: string, cwd: string): Promise<string[]> {
  const out: string[] = []
  const directories = new Set<string>([projectRoot, cwd])
  // Include intermediate directories so nested packages contribute their rules.
  let dir = cwd
  for (let depth = 0; depth < 32; depth++) {
    directories.add(dir)
    if (dir === projectRoot || path.dirname(dir) === dir) break
    dir = path.dirname(dir)
  }
  for (const directory of directories) {
    for (const name of INSTRUCTION_FILES) {
      const candidate = path.join(directory, name)
      if (await exists(candidate)) out.push(candidate)
    }
  }
  // Global instructions apply everywhere.
  for (const name of ["AGENTS.md", "PRAXIS.md"]) {
    const candidate = path.join(Paths.config, name)
    if (await exists(candidate)) out.unshift(candidate)
  }
  return unique(out)
}

async function finalize(
  config: Config,
  sources: readonly ConfigSource[],
  projectRoot: string,
  extra: {
    agentFiles: string[]
    commandFiles: string[]
    skillFiles: string[]
    pluginFiles: string[]
    themeFiles: string[]
    warnings: string[]
    projectRoot: string
    cwd: string
  },
): Promise<LoadedConfig> {
  const discovered = await discoverInstructionFiles(extra.projectRoot, extra.cwd)
  const configured = (config.instructions ?? []).map((entry) =>
    path.isAbsolute(entry) ? entry : path.resolve(projectRoot, expandHome(entry)),
  )

  const keybinds = { ...DEFAULT_KEYBINDS, ...(config.tui?.keybinds ?? {}) }
  for (const [action, binding] of Object.entries(keybinds)) {
    if (binding === "none" || binding === "") delete keybinds[action]
  }

  return {
    config: { ...EMPTY_CONFIG, ...config },
    sources,
    instructionFiles: unique([...discovered, ...configured]),
    agentFiles: extra.agentFiles,
    commandFiles: extra.commandFiles,
    skillFiles: extra.skillFiles,
    pluginFiles: extra.pluginFiles,
    themeFiles: extra.themeFiles,
    projectRoot,
    keybinds,
    warnings: extra.warnings,
  }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/** Where `praxis config set` writes by default. */
export function writableConfigPath(scope: "global" | "project", projectRoot: string): string {
  if (scope === "global") return Paths.configFile
  return path.join(projectRoot, `${APP_NAME}.json`)
}

/** Reads a config file's raw text so edits can preserve comments. */
export async function readRawConfig(target: string): Promise<string> {
  const content = await readFileSafe(target)
  if (content !== undefined) return content
  return `{\n  "$schema": "https://praxis.dev/config.json"\n}\n`
}

/** Flattens a config into dotted key/value pairs for `praxis config list`. */
export function flattenConfig(config: unknown, prefix = ""): Array<[string, JsonValue]> {
  const out: Array<[string, JsonValue]> = []
  if (config === null || typeof config !== "object") {
    if (prefix) out.push([prefix, config as JsonValue])
    return out
  }
  if (Array.isArray(config)) {
    out.push([prefix, config as JsonValue])
    return out
  }
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenConfig(value, next))
      continue
    }
    out.push([next, value as JsonValue])
  }
  return out
}

/** Parses a dotted path into segments, converting numeric ones into indices. */
export function parseConfigPath(input: string): Array<string | number> {
  return input
    .split(".")
    .filter(Boolean)
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment))
}

/** Coerces a CLI string into the most likely JSON type. */
export function coerceConfigValue(input: string): JsonValue {
  const trimmed = input.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return parseJsonc(trimmed) as JsonValue
    } catch {
      return trimmed
    }
  }
  return trimmed
}
