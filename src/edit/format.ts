/**
 * Formatter integration.
 *
 * Every write goes through here. The reason is simple and empirical: an agent
 * that produces unformatted code generates a diff full of whitespace noise, and
 * the user then cannot tell what actually changed. Running the project's own
 * formatter after each edit keeps the diff honest.
 *
 * Design points:
 *
 *  - **The project's formatter, not ours.** If the repository has a Prettier
 *    config, we run that Prettier, from that node_modules, with that config.
 *    Imposing our own would fight the repository's CI.
 *  - **Detection is by config file, not by extension.** A `.ts` file in a repo
 *    that uses Biome must not be run through Prettier.
 *  - **Failure is non-fatal.** A formatter that errors (syntax error mid-edit,
 *    missing binary) must never fail the edit. The unformatted file is still
 *    correct.
 *  - **Debounced per file.** A multi-edit sequence touching one file ten times
 *    should format once.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"

import { logger } from "../util/log.js"
import { findUp, which } from "../util/fs-extra.js"
import { IS_WINDOWS } from "../global.js"

const log = logger("edit.format")

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

export interface FormatterDefinition {
  readonly id: string
  /** Command and arguments. `{file}` is replaced with the absolute path. */
  readonly command: readonly string[]
  /** Glob-ish extensions this formatter handles. */
  readonly extensions: readonly string[]
  /**
   * Files whose presence enables this formatter. When empty the formatter is
   * enabled whenever its binary is present.
   */
  readonly requires?: readonly string[]
  /** When true the file content is piped on stdin and read back from stdout. */
  readonly stdin?: boolean
  /** Environment variables to set. */
  readonly env?: Readonly<Record<string, string>>
  /** Higher wins when several formatters match. */
  readonly priority?: number
}

/**
 * Built-in formatter catalogue.
 *
 * Ordered so that repository-specific tools outrank generic ones: Biome and
 * oxfmt beat Prettier when their config is present, Ruff beats Black, and
 * `cargo fmt` is preferred over a bare `rustfmt` because it respects the
 * workspace's edition.
 */
export const FORMATTERS: readonly FormatterDefinition[] = [
  {
    id: "biome",
    command: ["biome", "format", "--write", "{file}"],
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".jsonc", ".css", ".graphql"],
    requires: ["biome.json", "biome.jsonc"],
    priority: 90,
  },
  {
    id: "oxfmt",
    command: ["oxfmt", "{file}"],
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
    requires: [".oxfmtrc.json", ".oxlintrc.json"],
    priority: 85,
  },
  {
    id: "dprint",
    command: ["dprint", "fmt", "{file}"],
    extensions: [".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".toml"],
    requires: ["dprint.json", ".dprint.json", "dprint.jsonc"],
    priority: 85,
  },
  {
    id: "prettier",
    command: ["prettier", "--write", "{file}"],
    extensions: [
      ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
      ".json", ".jsonc", ".json5", ".css", ".scss", ".less", ".html", ".vue",
      ".svelte", ".md", ".mdx", ".yaml", ".yml", ".graphql", ".gql",
    ],
    requires: [
      ".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.cjs",
      ".prettierrc.mjs", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml",
      "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
      "prettier.config.ts",
    ],
    priority: 70,
  },
  {
    id: "ruff",
    command: ["ruff", "format", "{file}"],
    extensions: [".py", ".pyi"],
    requires: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
    priority: 80,
  },
  {
    id: "black",
    command: ["black", "--quiet", "{file}"],
    extensions: [".py", ".pyi"],
    priority: 60,
  },
  {
    id: "rustfmt",
    command: ["rustfmt", "--edition", "2021", "{file}"],
    extensions: [".rs"],
    priority: 70,
  },
  {
    id: "gofmt",
    command: ["gofmt", "-w", "{file}"],
    extensions: [".go"],
    priority: 70,
  },
  {
    id: "goimports",
    command: ["goimports", "-w", "{file}"],
    extensions: [".go"],
    priority: 75,
  },
  {
    id: "zig",
    command: ["zig", "fmt", "{file}"],
    extensions: [".zig"],
    priority: 70,
  },
  {
    id: "mix",
    command: ["mix", "format", "{file}"],
    extensions: [".ex", ".exs"],
    requires: ["mix.exs"],
    priority: 70,
  },
  {
    id: "gleam",
    command: ["gleam", "format", "{file}"],
    extensions: [".gleam"],
    priority: 70,
  },
  {
    id: "swiftformat",
    command: ["swiftformat", "{file}"],
    extensions: [".swift"],
    priority: 70,
  },
  {
    id: "ktlint",
    command: ["ktlint", "-F", "{file}"],
    extensions: [".kt", ".kts"],
    priority: 70,
  },
  {
    id: "clang-format",
    command: ["clang-format", "-i", "{file}"],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".m", ".mm", ".proto"],
    priority: 70,
  },
  {
    id: "shfmt",
    command: ["shfmt", "-w", "{file}"],
    extensions: [".sh", ".bash", ".zsh"],
    priority: 70,
  },
  {
    id: "terraform",
    command: ["terraform", "fmt", "{file}"],
    extensions: [".tf", ".tfvars"],
    priority: 70,
  },
  {
    id: "nixfmt",
    command: ["nixfmt", "{file}"],
    extensions: [".nix"],
    priority: 70,
  },
  {
    id: "taplo",
    command: ["taplo", "fmt", "{file}"],
    extensions: [".toml"],
    priority: 70,
  },
  {
    id: "rubocop",
    command: ["rubocop", "-A", "--stderr", "{file}"],
    extensions: [".rb", ".rake", ".gemspec"],
    requires: [".rubocop.yml"],
    priority: 70,
  },
  {
    id: "php-cs-fixer",
    command: ["php-cs-fixer", "fix", "{file}"],
    extensions: [".php"],
    requires: [".php-cs-fixer.php", ".php-cs-fixer.dist.php"],
    priority: 70,
  },
  {
    id: "dart",
    command: ["dart", "format", "{file}"],
    extensions: [".dart"],
    priority: 70,
  },
  {
    id: "csharpier",
    command: ["dotnet", "csharpier", "{file}"],
    extensions: [".cs"],
    priority: 70,
  },
  {
    id: "sql-formatter",
    command: ["sql-formatter", "--fix", "{file}"],
    extensions: [".sql"],
    priority: 60,
  },
  {
    id: "deno",
    command: ["deno", "fmt", "{file}"],
    extensions: [".js", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".md"],
    requires: ["deno.json", "deno.jsonc"],
    priority: 88,
  },
]

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export interface FormatterOverride {
  /** Glob pattern such as `*.py` or `**\/*.ts`. */
  readonly pattern: string
  /** Shell command; `{file}` is substituted. */
  readonly command: string
  readonly stdin?: boolean
}

export class FormatterRegistry {
  private readonly overrides: FormatterOverride[] = []
  private readonly disabled = new Set<string>()
  private readonly resolved = new Map<string, FormatterDefinition | null>()
  private readonly binaries = new Map<string, string | undefined>()
  private readonly cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  /** Registers a user-configured formatter, which outranks every built-in. */
  addOverride(override: FormatterOverride): void {
    this.overrides.push(override)
  }

  disable(id: string): void {
    this.disabled.add(id)
    this.resolved.clear()
  }

  /** Clears cached detection, e.g. after the configuration changed. */
  reset(): void {
    this.resolved.clear()
    this.binaries.clear()
  }

  /**
   * Chooses a formatter for a file.
   *
   * Cached per extension+directory: detection walks the tree looking for config
   * files and probes the PATH, both of which are far too slow to repeat on every
   * edit in a loop.
   */
  formatterFor(path: string): FormatterDefinition | FormatterOverride | undefined {
    for (const override of this.overrides) {
      if (matchesPattern(override.pattern, path)) return override
    }

    const extension = extname(path).toLowerCase()
    if (extension === "") return undefined

    const key = `${extension}|${dirname(resolve(this.cwd, path))}`
    const cached = this.resolved.get(key)
    if (cached !== undefined) return cached ?? undefined

    const candidates = FORMATTERS.filter(
      (formatter) => !this.disabled.has(formatter.id) && formatter.extensions.includes(extension),
    ).sort((left, right) => (right.priority ?? 50) - (left.priority ?? 50))

    for (const candidate of candidates) {
      if (candidate.requires && !this.hasConfig(path, candidate.requires)) continue
      if (!this.hasBinary(candidate.command[0]!)) continue
      this.resolved.set(key, candidate)
      return candidate
    }

    // Second pass: allow a formatter without its config file if the binary is
    // local to the project. A repository with prettier in devDependencies but no
    // explicit config still wants prettier.
    for (const candidate of candidates) {
      if (!candidate.requires) continue
      if (!this.hasLocalBinary(candidate.command[0]!)) continue
      this.resolved.set(key, candidate)
      return candidate
    }

    this.resolved.set(key, null)
    return undefined
  }

  private hasConfig(path: string, names: readonly string[]): boolean {
    const start = dirname(resolve(this.cwd, path))
    for (const name of names) {
      const found = findUp(name, start, this.cwd)
      if (found) {
        // `pyproject.toml` only counts for ruff when it actually mentions ruff.
        if (name === "pyproject.toml") {
          try {
            if (!readFileSync(found, "utf8").includes("ruff")) continue
          } catch {
            continue
          }
        }
        return true
      }
    }
    // package.json with a `prettier` key also counts as configuration.
    const packageJson = findUp("package.json", start, this.cwd)
    if (packageJson && names.some((name) => name.includes("prettier"))) {
      try {
        const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as Record<string, unknown>
        if (parsed["prettier"] !== undefined) return true
      } catch {
        // Malformed package.json: not our problem here.
      }
    }
    return false
  }

  private hasBinary(name: string): boolean {
    return this.resolveBinary(name) !== undefined
  }

  private hasLocalBinary(name: string): boolean {
    const local = this.localBinary(name)
    return local !== undefined
  }

  private resolveBinary(name: string): string | undefined {
    if (this.binaries.has(name)) return this.binaries.get(name)
    const local = this.localBinary(name)
    const found = local ?? which(name)
    this.binaries.set(name, found)
    return found
  }

  /** Looks for the binary in the project's own `node_modules/.bin`. */
  private localBinary(name: string): string | undefined {
    const packageJson = findUp("package.json", this.cwd)
    let directory = packageJson ? dirname(packageJson) : this.cwd
    for (let depth = 0; depth < 6; depth++) {
      const candidate = join(directory, "node_modules", ".bin", IS_WINDOWS ? `${name}.cmd` : name)
      if (existsSync(candidate)) return candidate
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    return undefined
  }
}

function matchesPattern(pattern: string, path: string): boolean {
  const normalized = path.replace(/\\/g, "/")
  // Support the common `*.{ts,tsx}` brace form without pulling in the full glob
  // engine, which is overkill for a single-segment extension match.
  const braces = /\{([^}]+)\}/.exec(pattern)
  if (braces) {
    return braces[1]!
      .split(",")
      .some((option) => matchesPattern(pattern.replace(braces[0], option.trim()), path))
  }
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
  return new RegExp(`(^|/)${body}$`).test(normalized)
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface FormatResult {
  readonly formatted: boolean
  readonly formatter?: string
  readonly durationMs: number
  readonly error?: string
}

/**
 * Formats a single file.
 *
 * Synchronous on purpose. Formatting happens immediately after a write and
 * before diagnostics are collected, and the ordering has to be deterministic:
 * running the language server against an unformatted buffer produces column
 * numbers that do not match what the user sees.
 */
export function formatFile(
  registry: FormatterRegistry,
  path: string,
  options: { timeoutMs?: number; cwd?: string } = {},
): FormatResult {
  const started = Date.now()
  const absolute = resolve(options.cwd ?? process.cwd(), path)
  if (!existsSync(absolute)) {
    return { formatted: false, durationMs: 0 }
  }

  const formatter = registry.formatterFor(absolute)
  if (!formatter) return { formatted: false, durationMs: Date.now() - started }

  const before = statSync(absolute).mtimeMs

  try {
    if ("pattern" in formatter) {
      runShell(formatter.command.replace(/\{file\}/g, quote(absolute)), {
        cwd: options.cwd ?? process.cwd(),
        timeoutMs: options.timeoutMs ?? 15_000,
        stdinPath: formatter.stdin ? absolute : undefined,
      })
      const after = statSync(absolute).mtimeMs
      return {
        formatted: after !== before,
        formatter: formatter.command.split(/\s+/)[0],
        durationMs: Date.now() - started,
      }
    }

    const argv = formatter.command.map((part) => part.replace(/\{file\}/g, absolute))
    const result = spawnSync(argv[0]!, argv.slice(1), {
      cwd: options.cwd ?? process.cwd(),
      timeout: options.timeoutMs ?? 15_000,
      encoding: "utf8",
      env: { ...process.env, ...formatter.env },
      windowsHide: true,
    })

    if (result.error) {
      log.debug("formatter failed to start", { formatter: formatter.id, error: String(result.error) })
      return {
        formatted: false,
        formatter: formatter.id,
        durationMs: Date.now() - started,
        error: String(result.error),
      }
    }

    if (result.status !== 0) {
      // A non-zero exit usually means the file has a syntax error, which is
      // expected mid-edit. Log it and move on; the write already succeeded.
      log.debug("formatter reported an error", {
        formatter: formatter.id,
        status: result.status,
        stderr: (result.stderr ?? "").slice(0, 400),
      })
      return {
        formatted: false,
        formatter: formatter.id,
        durationMs: Date.now() - started,
        error: (result.stderr || result.stdout || "").slice(0, 400),
      }
    }

    const after = statSync(absolute).mtimeMs
    return {
      formatted: after !== before,
      formatter: formatter.id,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    return {
      formatted: false,
      formatter: "pattern" in formatter ? undefined : formatter.id,
      durationMs: Date.now() - started,
      error: String(error),
    }
  }
}

function runShell(
  command: string,
  options: { cwd: string; timeoutMs: number; stdinPath?: string },
): void {
  const shell = IS_WINDOWS ? "cmd.exe" : "/bin/sh"
  const args = IS_WINDOWS ? ["/d", "/s", "/c", command] : ["-c", command]
  const input = options.stdinPath ? readFileSync(options.stdinPath) : undefined
  const result = spawnSync(shell, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    input,
    encoding: "buffer",
    windowsHide: true,
  })
  if (options.stdinPath && result.status === 0 && result.stdout && result.stdout.length > 0) {
    // stdin formatters return the formatted text; write it back.
    const { writeFileSync } = require("node:fs") as typeof import("node:fs")
    writeFileSync(options.stdinPath, result.stdout)
  }
}

function quote(value: string): string {
  if (IS_WINDOWS) return `"${value.replace(/"/g, '\\"')}"`
  return `'${value.replace(/'/g, "'\\''")}'`
}

/* ------------------------------------------------------------------ */
/* Batching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Formats several files, deduplicating and skipping ones that no longer exist.
 *
 * Used after `apply_patch` and after a multi-file task, where formatting each
 * file as it was written would run the formatter's start-up cost repeatedly.
 */
export function formatFiles(
  registry: FormatterRegistry,
  paths: readonly string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Map<string, FormatResult> {
  const results = new Map<string, FormatResult>()
  for (const path of new Set(paths)) {
    results.set(path, formatFile(registry, path, options))
  }
  return results
}

/* ------------------------------------------------------------------ */
/* Singleton                                                           */
/* ------------------------------------------------------------------ */

let registry: FormatterRegistry | undefined

export function formatterRegistry(cwd = process.cwd()): FormatterRegistry {
  if (!registry) registry = new FormatterRegistry(cwd)
  return registry
}

export function setFormatterRegistry(next: FormatterRegistry): void {
  registry = next
}
