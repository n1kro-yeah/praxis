/**
 * Environment block injected into the system prompt.
 *
 * Models cannot see the terminal, so every fact they would otherwise guess must
 * be stated: the working directory, the platform, today's date, the shell, the
 * git state, the project's toolchain, and the shape of the tree. Getting this
 * block right eliminates an entire class of failure where the model invents a
 * plausible-but-wrong path or runs a command for the wrong package manager.
 *
 * Everything here is cheap to collect and cached for the session, because the
 * system prompt must stay byte-identical across turns for prompt caching to pay
 * off. Volatile facts (git status, open diagnostics) go into the *reminders*
 * appended after the last user message instead, never into this block.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir, platform, release, totalmem, userInfo } from "node:os"
import { basename, join, relative, resolve } from "node:path"

import { INSTRUCTION_FILES, PLATFORM } from "../global.js"
import { logger } from "../util/log.js"
import { findUp } from "../util/fs-extra.js"
import { defaultShell } from "../util/shell.js"
import { truncate } from "../util/string.js"

const log = logger("prompt.environment")

export interface EnvironmentFacts {
  readonly cwd: string
  readonly home: string
  readonly platform: string
  readonly osRelease: string
  readonly arch: string
  readonly shell: string
  readonly user: string
  readonly date: string
  readonly isGitRepo: boolean
  readonly gitBranch?: string
  readonly gitRemote?: string
  readonly projectName: string
  readonly toolchain: ToolchainFacts
  readonly tree: string
  readonly instructions: InstructionFile[]
}

export interface InstructionFile {
  readonly path: string
  readonly content: string
}

export interface ToolchainFacts {
  readonly languages: string[]
  readonly packageManager?: string
  readonly runtime?: string
  readonly testCommand?: string
  readonly buildCommand?: string
  readonly lintCommand?: string
  readonly typecheckCommand?: string
  readonly formatCommand?: string
  readonly scripts: Record<string, string>
  readonly markers: string[]
}

/* ------------------------------------------------------------------ */
/* Toolchain detection                                                 */
/* ------------------------------------------------------------------ */

interface MarkerRule {
  readonly file: string
  readonly language: string
  readonly packageManager?: string
}

const MARKERS: MarkerRule[] = [
  { file: "package.json", language: "JavaScript/TypeScript" },
  { file: "bun.lockb", language: "TypeScript", packageManager: "bun" },
  { file: "bun.lock", language: "TypeScript", packageManager: "bun" },
  { file: "pnpm-lock.yaml", language: "TypeScript", packageManager: "pnpm" },
  { file: "yarn.lock", language: "TypeScript", packageManager: "yarn" },
  { file: "package-lock.json", language: "TypeScript", packageManager: "npm" },
  { file: "deno.json", language: "TypeScript", packageManager: "deno" },
  { file: "deno.jsonc", language: "TypeScript", packageManager: "deno" },
  { file: "tsconfig.json", language: "TypeScript" },
  { file: "Cargo.toml", language: "Rust", packageManager: "cargo" },
  { file: "go.mod", language: "Go", packageManager: "go" },
  { file: "pyproject.toml", language: "Python" },
  { file: "uv.lock", language: "Python", packageManager: "uv" },
  { file: "poetry.lock", language: "Python", packageManager: "poetry" },
  { file: "Pipfile", language: "Python", packageManager: "pipenv" },
  { file: "requirements.txt", language: "Python", packageManager: "pip" },
  { file: "setup.py", language: "Python", packageManager: "pip" },
  { file: "Gemfile", language: "Ruby", packageManager: "bundler" },
  { file: "composer.json", language: "PHP", packageManager: "composer" },
  { file: "pom.xml", language: "Java", packageManager: "maven" },
  { file: "build.gradle", language: "Java/Kotlin", packageManager: "gradle" },
  { file: "build.gradle.kts", language: "Kotlin", packageManager: "gradle" },
  { file: "mix.exs", language: "Elixir", packageManager: "mix" },
  { file: "Package.swift", language: "Swift", packageManager: "swift" },
  { file: "pubspec.yaml", language: "Dart", packageManager: "pub" },
  { file: "CMakeLists.txt", language: "C/C++", packageManager: "cmake" },
  { file: "Makefile", language: "Make", packageManager: "make" },
  { file: "meson.build", language: "C/C++", packageManager: "meson" },
  { file: "stack.yaml", language: "Haskell", packageManager: "stack" },
  { file: "cabal.project", language: "Haskell", packageManager: "cabal" },
  { file: "dune-project", language: "OCaml", packageManager: "dune" },
  { file: "Dockerfile", language: "Docker" },
  { file: "docker-compose.yml", language: "Docker" },
  { file: "flake.nix", language: "Nix" },
  { file: "terraform.tf", language: "Terraform" },
  { file: ".csproj", language: "C#", packageManager: "dotnet" },
  { file: ".sln", language: "C#", packageManager: "dotnet" },
]

/**
 * Chooses the package manager from lockfiles, falling back to the manifest.
 * Running `npm install` in a pnpm repo is a real and annoying failure mode.
 */
function detectPackageManager(cwd: string, packageJson?: Record<string, unknown>): string | undefined {
  const declared = packageJson?.["packageManager"]
  if (typeof declared === "string") return declared.split("@")[0]
  for (const rule of MARKERS) {
    if (!rule.packageManager) continue
    if (existsSync(join(cwd, rule.file))) return rule.packageManager
  }
  return undefined
}

function pickScript(
  scripts: Record<string, string>,
  candidates: string[],
): string | undefined {
  for (const name of candidates) {
    if (scripts[name]) return name
  }
  return undefined
}

function runnerPrefix(packageManager: string | undefined): string {
  switch (packageManager) {
    case "bun":
      return "bun run"
    case "pnpm":
      return "pnpm"
    case "yarn":
      return "yarn"
    case "deno":
      return "deno task"
    default:
      return "npm run"
  }
}

export function detectToolchain(cwd: string): ToolchainFacts {
  const languages = new Set<string>()
  const markers: string[] = []

  for (const rule of MARKERS) {
    const target = rule.file.startsWith(".")
      ? findExtension(cwd, rule.file)
      : existsSync(join(cwd, rule.file))
        ? rule.file
        : undefined
    if (!target) continue
    markers.push(target)
    languages.add(rule.language)
  }

  let packageJson: Record<string, unknown> | undefined
  const manifestPath = join(cwd, "package.json")
  if (existsSync(manifestPath)) {
    try {
      packageJson = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    } catch (error) {
      log.debug("unparsable package.json", { error: String(error) })
    }
  }

  const scripts =
    packageJson && typeof packageJson["scripts"] === "object" && packageJson["scripts"] !== null
      ? (packageJson["scripts"] as Record<string, string>)
      : {}

  const packageManager = detectPackageManager(cwd, packageJson)
  const prefix = runnerPrefix(packageManager)

  const testScript = pickScript(scripts, ["test", "tests", "test:unit", "vitest", "jest", "spec"])
  const buildScript = pickScript(scripts, ["build", "compile", "bundle"])
  const lintScript = pickScript(scripts, ["lint", "lint:fix", "eslint", "check"])
  const typecheckScript = pickScript(scripts, [
    "typecheck",
    "type-check",
    "tsc",
    "types",
    "check:types",
  ])
  const formatScript = pickScript(scripts, ["format", "fmt", "prettier", "format:write"])

  // Non-JS ecosystems have canonical commands; prefer those over scripts.
  const nonJs = ((): Partial<ToolchainFacts> => {
    if (markers.includes("Cargo.toml")) {
      return {
        testCommand: "cargo test",
        buildCommand: "cargo build",
        lintCommand: "cargo clippy",
        typecheckCommand: "cargo check",
        formatCommand: "cargo fmt",
      }
    }
    if (markers.includes("go.mod")) {
      return {
        testCommand: "go test ./...",
        buildCommand: "go build ./...",
        lintCommand: "go vet ./...",
        typecheckCommand: "go build ./...",
        formatCommand: "gofmt -w .",
      }
    }
    if (markers.includes("pyproject.toml") || markers.includes("requirements.txt")) {
      const runner = packageManager === "uv" ? "uv run " : packageManager === "poetry" ? "poetry run " : ""
      return {
        testCommand: `${runner}pytest`,
        lintCommand: `${runner}ruff check .`,
        formatCommand: `${runner}ruff format .`,
        typecheckCommand: `${runner}mypy .`,
      }
    }
    if (markers.includes("mix.exs")) {
      return { testCommand: "mix test", buildCommand: "mix compile", formatCommand: "mix format" }
    }
    if (markers.includes("Gemfile")) {
      return { testCommand: "bundle exec rspec", lintCommand: "bundle exec rubocop" }
    }
    if (markers.includes("Package.swift")) {
      return { testCommand: "swift test", buildCommand: "swift build" }
    }
    if (markers.includes("pubspec.yaml")) {
      return { testCommand: "dart test", formatCommand: "dart format .", typecheckCommand: "dart analyze" }
    }
    return {}
  })()

  return {
    languages: [...languages],
    packageManager,
    runtime: detectRuntime(markers),
    testCommand: testScript ? `${prefix} ${testScript}` : nonJs.testCommand,
    buildCommand: buildScript ? `${prefix} ${buildScript}` : nonJs.buildCommand,
    lintCommand: lintScript ? `${prefix} ${lintScript}` : nonJs.lintCommand,
    typecheckCommand: typecheckScript ? `${prefix} ${typecheckScript}` : nonJs.typecheckCommand,
    formatCommand: formatScript ? `${prefix} ${formatScript}` : nonJs.formatCommand,
    scripts,
    markers,
  }
}

function detectRuntime(markers: string[]): string | undefined {
  if (markers.includes("bun.lockb") || markers.includes("bun.lock")) return "bun"
  if (markers.includes("deno.json") || markers.includes("deno.jsonc")) return "deno"
  if (markers.includes("package.json")) return "node"
  return undefined
}

function findExtension(cwd: string, extension: string): string | undefined {
  try {
    for (const entry of readdirSync(cwd)) {
      if (entry.endsWith(extension)) return entry
    }
  } catch {
    // Unreadable directory: not fatal.
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Directory tree                                                      */
/* ------------------------------------------------------------------ */

const TREE_SKIP = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".turbo",
  ".cache",
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  ".terraform",
  ".svelte-kit",
  "Pods",
  ".dart_tool",
  ".praxis",
])

/**
 * Renders a bounded tree of the project.
 *
 * Bounded deliberately: a full listing of a large monorepo would consume the
 * context window and bury the useful signal. Two levels plus the direct
 * children of source directories is enough for the model to orient itself and
 * form correct search queries.
 */
export function renderTree(cwd: string, maxEntries = 220, maxDepth = 3): string {
  const lines: string[] = []
  let count = 0
  let truncated = false

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > maxDepth || truncated) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    const dirs: string[] = []
    const files: string[] = []
    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".github" && entry !== ".praxis") continue
      if (TREE_SKIP.has(entry)) continue
      let isDir = false
      try {
        isDir = statSync(join(dir, entry)).isDirectory()
      } catch {
        continue
      }
      if (isDir) dirs.push(entry)
      else files.push(entry)
    }
    dirs.sort()
    files.sort()

    const combined = [...dirs.map((name) => ({ name, isDir: true })), ...files.map((name) => ({ name, isDir: false }))]
    for (let index = 0; index < combined.length; index++) {
      if (count >= maxEntries) {
        truncated = true
        return
      }
      const item = combined[index]!
      const isLast = index === combined.length - 1
      const branch = isLast ? "└── " : "├── "
      lines.push(`${prefix}${branch}${item.name}${item.isDir ? "/" : ""}`)
      count++
      if (item.isDir) {
        walk(join(dir, item.name), prefix + (isLast ? "    " : "│   "), depth + 1)
      }
    }
  }

  lines.push(`${basename(cwd)}/`)
  walk(cwd, "", 1)
  if (truncated) lines.push("… (listing truncated; use the search tools to explore further)")
  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* Instruction files                                                   */
/* ------------------------------------------------------------------ */

/**
 * Collects project instruction files (AGENTS.md and friends).
 *
 * Walks up from the working directory so a file at the repository root applies
 * to work in a subdirectory, and reads the global one from the config dir.
 * Nearest file wins when the same name appears twice, matching how developers
 * expect layered configuration to behave.
 */
export function collectInstructions(cwd: string, extra: string[] = []): InstructionFile[] {
  const found: InstructionFile[] = []
  const seen = new Set<string>()
  const stop = resolve(homedir())

  let dir = resolve(cwd)
  for (let depth = 0; depth < 12; depth++) {
    for (const name of INSTRUCTION_FILES) {
      const candidate = join(dir, name)
      const key = resolve(candidate)
      if (seen.has(key)) continue
      if (!existsSync(candidate)) continue
      try {
        const content = readFileSync(candidate, "utf8").trim()
        if (content === "") continue
        seen.add(key)
        found.push({ path: relative(cwd, candidate) || name, content: truncate(content, 24_000) })
      } catch (error) {
        log.debug("unreadable instruction file", { candidate, error: String(error) })
      }
    }
    if (dir === stop) break
    const parent = resolve(dir, "..")
    if (parent === dir) break
    // Stop at the repository root: instructions above it are not ours.
    if (existsSync(join(dir, ".git"))) break
    dir = parent
  }

  for (const candidate of extra) {
    const key = resolve(candidate)
    if (seen.has(key) || !existsSync(candidate)) continue
    try {
      const content = readFileSync(candidate, "utf8").trim()
      if (content === "") continue
      seen.add(key)
      found.push({ path: candidate, content: truncate(content, 24_000) })
    } catch {
      // Ignore.
    }
  }

  return found
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

let cached: { key: string; facts: EnvironmentFacts } | undefined

export interface EnvironmentOptions {
  readonly cwd: string
  readonly gitBranch?: string
  readonly gitRemote?: string
  readonly isGitRepo?: boolean
  readonly extraInstructions?: string[]
  readonly includeTree?: boolean
}

export function collectEnvironment(options: EnvironmentOptions): EnvironmentFacts {
  const key = `${options.cwd}|${options.gitBranch ?? ""}|${options.includeTree !== false}`
  if (cached && cached.key === key) return cached.facts

  const cwd = resolve(options.cwd)
  const facts: EnvironmentFacts = {
    cwd,
    home: homedir(),
    platform: PLATFORM,
    osRelease: release(),
    arch: process.arch,
    shell: defaultShell(),
    user: safeUser(),
    // Date only, never time: a changing timestamp destroys prompt caching.
    date: new Date().toISOString().slice(0, 10),
    isGitRepo: options.isGitRepo ?? existsSync(join(cwd, ".git")) || findUp(".git", cwd) !== undefined,
    gitBranch: options.gitBranch,
    gitRemote: options.gitRemote,
    projectName: basename(cwd),
    toolchain: detectToolchain(cwd),
    tree: options.includeTree === false ? "" : renderTree(cwd),
    instructions: collectInstructions(cwd, options.extraInstructions),
  }

  cached = { key, facts }
  return facts
}

export function resetEnvironmentCache(): void {
  cached = undefined
}

function safeUser(): string {
  try {
    return userInfo().username
  } catch {
    return "unknown"
  }
}

/** Renders the facts as the `<environment>` block for the system prompt. */
export function renderEnvironment(facts: EnvironmentFacts): string {
  const lines: string[] = ["<environment>"]
  lines.push(`Working directory: ${facts.cwd}`)
  lines.push(`Project: ${facts.projectName}`)
  lines.push(`Platform: ${facts.platform} (${facts.arch})`)
  lines.push(`Shell: ${facts.shell}`)
  lines.push(`Date: ${facts.date}`)
  lines.push(`Git repository: ${facts.isGitRepo ? "yes" : "no"}`)
  if (facts.gitBranch) lines.push(`Current branch: ${facts.gitBranch}`)

  const tool = facts.toolchain
  if (tool.languages.length) lines.push(`Languages: ${tool.languages.join(", ")}`)
  if (tool.packageManager) lines.push(`Package manager: ${tool.packageManager}`)
  if (tool.runtime) lines.push(`Runtime: ${tool.runtime}`)

  const commands: string[] = []
  if (tool.typecheckCommand) commands.push(`typecheck: ${tool.typecheckCommand}`)
  if (tool.testCommand) commands.push(`test: ${tool.testCommand}`)
  if (tool.lintCommand) commands.push(`lint: ${tool.lintCommand}`)
  if (tool.buildCommand) commands.push(`build: ${tool.buildCommand}`)
  if (tool.formatCommand) commands.push(`format: ${tool.formatCommand}`)
  if (commands.length) {
    lines.push("")
    lines.push("Project commands (detected; prefer these over inventing your own):")
    for (const command of commands) lines.push(`  ${command}`)
  }

  const otherScripts = Object.entries(tool.scripts).filter(
    ([name]) =>
      !["test", "build", "lint", "typecheck", "format", "fmt", "tsc"].some((known) =>
        name.startsWith(known),
      ),
  )
  if (otherScripts.length) {
    lines.push("")
    lines.push(
      `Other scripts: ${otherScripts
        .slice(0, 16)
        .map(([name]) => name)
        .join(", ")}`,
    )
  }

  if (facts.tree !== "") {
    lines.push("")
    lines.push("Project structure:")
    lines.push(facts.tree)
  }

  lines.push("</environment>")
  return lines.join("\n")
}

/** Renders instruction files as their own block, clearly attributed. */
export function renderInstructions(files: InstructionFile[]): string {
  if (files.length === 0) return ""
  const blocks = files.map(
    (file) =>
      `<instructions source="${file.path}">\n${file.content}\n</instructions>`,
  )
  return [
    "The following instructions come from the project itself. They describe how this codebase expects to be worked on, and they take precedence over your general defaults where they conflict. Treat them as requirements from the maintainers, not as content to summarise.",
    "",
    ...blocks,
  ].join("\n")
}

/** Compact machine summary, used for the `praxis doctor` command. */
export function environmentSummary(facts: EnvironmentFacts): Record<string, unknown> {
  return {
    cwd: facts.cwd,
    platform: `${facts.platform} ${facts.osRelease} ${facts.arch}`,
    shell: facts.shell,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    git: facts.isGitRepo ? (facts.gitBranch ?? "detached") : false,
    languages: facts.toolchain.languages,
    packageManager: facts.toolchain.packageManager ?? null,
    instructionFiles: facts.instructions.map((file) => file.path),
  }
}
