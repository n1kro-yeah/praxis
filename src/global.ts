/**
 * Global, process-wide constants and filesystem locations.
 *
 * Praxis follows the XDG Base Directory specification on Linux/BSD, uses
 * `~/Library/Application Support` on macOS and `%APPDATA%` on Windows. Every
 * path in the application is derived from this module so that relocating state
 * is a one-line change.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const APP_NAME = "praxis"
export const APP_DISPLAY_NAME = "Praxis"
export const APP_TAGLINE = "the terminal coding agent"

/** Environment variable prefix for every knob the app exposes. */
export const ENV_PREFIX = "PRAXIS_"

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Repository/installation root (the directory containing `package.json`). */
export const INSTALL_ROOT = (() => {
  let dir = MODULE_DIR
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(MODULE_DIR, "..")
})()

export const VERSION = (() => {
  if (process.env[`${ENV_PREFIX}VERSION`]) return process.env[`${ENV_PREFIX}VERSION`] as string
  try {
    const raw = fs.readFileSync(path.join(INSTALL_ROOT, "package.json"), "utf8")
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? "0.0.0-dev"
  } catch {
    return "0.0.0-dev"
  }
})()

export const USER_AGENT = `${APP_NAME}/${VERSION} (node ${process.versions.node}; ${process.platform}-${process.arch})`

export type Platform = "linux" | "darwin" | "win32" | "other"

export const PLATFORM: Platform =
  process.platform === "linux"
    ? "linux"
    : process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "win32"
        : "other"

export const IS_WINDOWS = PLATFORM === "win32"
export const HOME = os.homedir()

function envDir(name: string): string | undefined {
  const value = process.env[name]
  if (!value) return undefined
  return path.isAbsolute(value) ? value : undefined
}

function resolveConfigHome(): string {
  const override = envDir(`${ENV_PREFIX}CONFIG_HOME`)
  if (override) return override
  if (PLATFORM === "win32") {
    return path.join(process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming"), APP_NAME)
  }
  if (PLATFORM === "darwin") {
    // Respect XDG when the user has explicitly opted in, otherwise be a good
    // macOS citizen.
    const xdg = envDir("XDG_CONFIG_HOME")
    if (xdg) return path.join(xdg, APP_NAME)
    return path.join(HOME, "Library", "Application Support", APP_DISPLAY_NAME)
  }
  return path.join(envDir("XDG_CONFIG_HOME") ?? path.join(HOME, ".config"), APP_NAME)
}

function resolveDataHome(): string {
  const override = envDir(`${ENV_PREFIX}DATA_HOME`)
  if (override) return override
  if (PLATFORM === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local"), APP_NAME)
  }
  if (PLATFORM === "darwin") {
    const xdg = envDir("XDG_DATA_HOME")
    if (xdg) return path.join(xdg, APP_NAME)
    return path.join(HOME, "Library", "Application Support", APP_DISPLAY_NAME)
  }
  return path.join(envDir("XDG_DATA_HOME") ?? path.join(HOME, ".local", "share"), APP_NAME)
}

function resolveCacheHome(): string {
  const override = envDir(`${ENV_PREFIX}CACHE_HOME`)
  if (override) return override
  if (PLATFORM === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local"),
      APP_NAME,
      "Cache",
    )
  }
  if (PLATFORM === "darwin") {
    const xdg = envDir("XDG_CACHE_HOME")
    if (xdg) return path.join(xdg, APP_NAME)
    return path.join(HOME, "Library", "Caches", APP_DISPLAY_NAME)
  }
  return path.join(envDir("XDG_CACHE_HOME") ?? path.join(HOME, ".cache"), APP_NAME)
}

function resolveStateHome(): string {
  const override = envDir(`${ENV_PREFIX}STATE_HOME`)
  if (override) return override
  if (PLATFORM === "linux") {
    return path.join(envDir("XDG_STATE_HOME") ?? path.join(HOME, ".local", "state"), APP_NAME)
  }
  return resolveDataHome()
}

/**
 * All well-known directories. Created lazily by {@link ensureDirectories} so
 * that read-only commands (`--version`, `--help`) never touch the disk.
 */
export const Paths = {
  installRoot: INSTALL_ROOT,
  config: resolveConfigHome(),
  data: resolveDataHome(),
  cache: resolveCacheHome(),
  state: resolveStateHome(),

  get configFile(): string {
    return path.join(Paths.config, `${APP_NAME}.jsonc`)
  },
  get configFileJson(): string {
    return path.join(Paths.config, `${APP_NAME}.json`)
  },
  get tuiConfigFile(): string {
    return path.join(Paths.config, "tui.json")
  },
  get authFile(): string {
    return path.join(Paths.data, "auth.json")
  },
  get database(): string {
    return path.join(Paths.data, "praxis.db")
  },
  get logDir(): string {
    return path.join(Paths.state, "log")
  },
  get snapshotDir(): string {
    return path.join(Paths.data, "snapshot")
  },
  get projectDir(): string {
    return path.join(Paths.data, "project")
  },
  get agentDir(): string {
    return path.join(Paths.config, "agent")
  },
  get commandDir(): string {
    return path.join(Paths.config, "command")
  },
  get skillDir(): string {
    return path.join(Paths.config, "skill")
  },
  get pluginDir(): string {
    return path.join(Paths.config, "plugin")
  },
  get themeDir(): string {
    return path.join(Paths.config, "theme")
  },
  get modelCache(): string {
    return path.join(Paths.cache, "models.json")
  },
  get lspCache(): string {
    return path.join(Paths.cache, "lsp")
  },
  get binCache(): string {
    return path.join(Paths.cache, "bin")
  },
  get assets(): string {
    return path.join(INSTALL_ROOT, "assets")
  },
} as const

/** Per-project directory name checked in alongside the user's source. */
export const PROJECT_DIR_NAME = `.${APP_NAME}`

/** Config filenames searched in the project root, in priority order. */
export const PROJECT_CONFIG_FILES = [
  `${APP_NAME}.jsonc`,
  `${APP_NAME}.json`,
  path.join(PROJECT_DIR_NAME, "config.jsonc"),
  path.join(PROJECT_DIR_NAME, "config.json"),
] as const

/** Instruction files auto-discovered and appended to the system prompt. */
export const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "PRAXIS.md",
  path.join(PROJECT_DIR_NAME, "AGENTS.md"),
  ".cursorrules",
  path.join(".github", "copilot-instructions.md"),
] as const

let directoriesReady = false

export function ensureDirectories(): void {
  if (directoriesReady) return
  for (const dir of [
    Paths.config,
    Paths.data,
    Paths.cache,
    Paths.state,
    Paths.logDir,
    Paths.snapshotDir,
    Paths.projectDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  directoriesReady = true
}

/** Replaces a leading `~` with the user's home directory. */
export function expandHome(input: string): string {
  if (input === "~") return HOME
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(HOME, input.slice(2))
  if (input.startsWith("$HOME/")) return path.join(HOME, input.slice(6))
  if (input === "$HOME") return HOME
  return input
}

/** Inverse of {@link expandHome}; used when printing paths to humans. */
export function contractHome(input: string): string {
  if (!input.startsWith(HOME)) return input
  const rest = input.slice(HOME.length)
  if (rest === "") return "~"
  if (rest.startsWith(path.sep)) return "~" + rest
  return input
}

export const Limits = {
  /** Largest file we will hand to the model verbatim. */
  maxReadBytes: 512 * 1024,
  /** Largest single tool output before truncation kicks in. */
  maxToolOutputChars: 60_000,
  /** Default lines returned by the `read` tool. */
  defaultReadLines: 2_000,
  /** Truncation width for very long lines in tool output. */
  maxLineWidth: 2_000,
  /** Maximum matches returned from grep/glob. */
  maxSearchResults: 400,
  /** Maximum parallel tool executions inside one assistant turn. */
  maxParallelTools: 12,
  /** Maximum tools a single `batch` call can fan out to. */
  maxBatchTools: 25,
  /** Hard cap on agentic iterations to avoid runaway spend. */
  maxLoopIterations: 512,
  /** Consecutive identical tool calls that trigger doom-loop intervention. */
  doomLoopThreshold: 3,
  /** Default bash timeout. */
  bashTimeoutMs: 120_000,
  /** Absolute bash timeout ceiling. */
  bashMaxTimeoutMs: 30 * 60_000,
  /** Bash output cap before head/tail truncation. */
  bashMaxOutputBytes: 256 * 1024,
  /** Fraction of the context window that triggers auto-compaction. */
  compactionThreshold: 0.9,
  /** Tokens reserved for the response when computing the compaction budget. */
  compactionReserveTokens: 24_000,
  /** Maximum depth of subagent delegation. */
  maxSubagentDepth: 4,
  /** Maximum concurrent subagents per session. */
  maxSubagentConcurrency: 4,
  /** File watcher debounce. */
  watcherDebounceMs: 120,
  /** Default HTTP timeout for provider calls (streaming uses idle timeout). */
  httpTimeoutMs: 600_000,
  /** Idle timeout between stream chunks. */
  streamIdleTimeoutMs: 120_000,
  /** Provider request retry attempts. */
  providerRetries: 5,
} as const

export const ExitCode = {
  ok: 0,
  failure: 1,
  usage: 64,
  dataError: 65,
  unavailable: 69,
  internal: 70,
  configError: 78,
  interrupted: 130,
} as const

export type ExitCodeName = keyof typeof ExitCode
