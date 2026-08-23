/**
 * Language server catalogue.
 *
 * Maps file extensions to the language servers that can handle them, how to
 * start each one, and how to find the workspace root it should be initialised
 * with. Getting the root right is the single most important field: a server
 * rooted at the wrong directory silently produces no diagnostics, or produces
 * thousands of spurious ones because it cannot see `tsconfig.json`.
 *
 * Servers are only started when both conditions hold:
 *  - a file of a matching language was opened, and
 *  - the server's binary is actually available.
 *
 * Nothing is installed automatically. An agent that shells out to `npm install
 * -g` behind the user's back is unacceptable, and a missing language server
 * degrades gracefully into "no diagnostics" rather than a failure.
 */

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { IS_WINDOWS } from "../global.js"
import { which } from "../util/fs-extra.js"

/* ------------------------------------------------------------------ */
/* Definition                                                          */
/* ------------------------------------------------------------------ */

export interface ServerDefinition {
  readonly id: string
  readonly label: string
  /** Extensions this server handles, including the dot. */
  readonly extensions: readonly string[]
  /**
   * How to start it. The first entry is the binary; it is resolved through PATH
   * and through the project's `node_modules/.bin`.
   */
  readonly command: readonly string[]
  /**
   * Files whose presence marks the workspace root, most specific first. The
   * server is rooted at the nearest ancestor containing one of these.
   */
  readonly rootMarkers: readonly string[]
  /**
   * Files that must exist somewhere above the opened file for this server to be
   * relevant at all. Prevents starting `rust-analyzer` in a directory that
   * happens to contain one stray `.rs` file.
   */
  readonly requires?: readonly string[]
  /** Initialization options passed in the `initialize` request. */
  readonly initializationOptions?: Readonly<Record<string, unknown>>
  /** Extra environment for the child process. */
  readonly env?: Readonly<Record<string, string>>
  /** Higher wins when two servers claim the same extension. */
  readonly priority?: number
  /**
   * Some servers need longer than the default to become useful.
   * `rust-analyzer` runs `cargo metadata` first; `gopls` builds a module graph.
   */
  readonly startupTimeoutMs?: number
  /** Only enable when this feature flag is set. */
  readonly flag?: string
  /** Local package name to look for in node_modules/.bin. */
  readonly localPackage?: string
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

export const SERVERS: readonly ServerDefinition[] = [
  {
    id: "typescript",
    label: "TypeScript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    command: ["typescript-language-server", "--stdio"],
    localPackage: "typescript-language-server",
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    priority: 80,
    startupTimeoutMs: 30_000,
    initializationOptions: {
      // Without an explicit tsserver path the language server can pick a
      // globally installed TypeScript that differs from the project's, and the
      // resulting diagnostics are wrong in confusing ways.
      preferences: {
        includeInlayParameterNameHints: "none",
        includeCompletionsForModuleExports: true,
        allowIncompleteCompletions: true,
      },
      maxTsServerMemory: 4_096,
    },
  },
  {
    id: "vtsls",
    label: "TypeScript (vtsls)",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    command: ["vtsls", "--stdio"],
    localPackage: "vtsls",
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    priority: 85,
    startupTimeoutMs: 30_000,
  },
  {
    id: "deno",
    label: "Deno",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    command: ["deno", "lsp"],
    rootMarkers: ["deno.json", "deno.jsonc"],
    requires: ["deno.json", "deno.jsonc"],
    priority: 95,
    initializationOptions: { enable: true, lint: true, unstable: false },
  },
  {
    id: "eslint",
    label: "ESLint",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"],
    command: ["vscode-eslint-language-server", "--stdio"],
    localPackage: "vscode-eslint-language-server",
    rootMarkers: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.ts",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      ".eslintrc",
      "package.json",
    ],
    requires: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.ts",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
    ],
    priority: 40,
    initializationOptions: { validate: "on", useESLintClass: true, experimental: {} },
  },
  {
    id: "python",
    label: "Python (Pyright)",
    extensions: [".py", ".pyi"],
    command: ["pyright-langserver", "--stdio"],
    localPackage: "pyright-langserver",
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", ".git"],
    priority: 80,
    startupTimeoutMs: 25_000,
    initializationOptions: {
      python: { analysis: { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: "openFilesOnly" } },
    },
  },
  {
    id: "basedpyright",
    label: "Python (basedpyright)",
    extensions: [".py", ".pyi"],
    command: ["basedpyright-langserver", "--stdio"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", ".git"],
    priority: 82,
  },
  {
    id: "ruff",
    label: "Ruff",
    extensions: [".py", ".pyi"],
    command: ["ruff", "server"],
    rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml", ".git"],
    priority: 50,
  },
  {
    id: "ty",
    label: "Python (ty)",
    extensions: [".py", ".pyi"],
    command: ["ty", "server"],
    rootMarkers: ["pyproject.toml", ".git"],
    priority: 60,
    flag: "PRAXIS_EXPERIMENTAL_LSP_TY",
  },
  {
    id: "gopls",
    label: "Go",
    extensions: [".go", ".mod", ".sum", ".work"],
    command: ["gopls", "serve"],
    rootMarkers: ["go.work", "go.mod", ".git"],
    requires: ["go.mod", "go.work"],
    priority: 80,
    startupTimeoutMs: 45_000,
    initializationOptions: {
      // Staticcheck adds genuinely useful diagnostics; the cost is a slower
      // first analysis, which is acceptable because we never block on it.
      staticcheck: true,
      analyses: { unusedparams: true, unusedwrite: true, nilness: true },
      hints: {},
    },
  },
  {
    id: "rust-analyzer",
    label: "Rust",
    extensions: [".rs"],
    command: ["rust-analyzer"],
    rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
    requires: ["Cargo.toml", "rust-project.json"],
    priority: 80,
    startupTimeoutMs: 90_000,
    initializationOptions: {
      cargo: { buildScripts: { enable: true }, features: "all" },
      procMacro: { enable: true },
      checkOnSave: { command: "clippy" },
      diagnostics: { enable: true, experimental: { enable: false } },
    },
  },
  {
    id: "clangd",
    label: "C/C++",
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".hh", ".m", ".mm", ".cu"],
    command: ["clangd", "--background-index", "--clang-tidy", "--header-insertion=never"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt", ".clangd", ".git"],
    priority: 80,
    startupTimeoutMs: 40_000,
  },
  {
    id: "jdtls",
    label: "Java",
    extensions: [".java"],
    command: ["jdtls"],
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".git"],
    requires: ["pom.xml", "build.gradle", "build.gradle.kts"],
    priority: 80,
    startupTimeoutMs: 120_000,
  },
  {
    id: "kotlin",
    label: "Kotlin",
    extensions: [".kt", ".kts"],
    command: ["kotlin-language-server"],
    rootMarkers: ["settings.gradle", "settings.gradle.kts", "build.gradle.kts", ".git"],
    priority: 70,
    startupTimeoutMs: 90_000,
  },
  {
    id: "ruby-lsp",
    label: "Ruby",
    extensions: [".rb", ".rake", ".gemspec", ".ru"],
    command: ["ruby-lsp"],
    rootMarkers: ["Gemfile", ".git"],
    requires: ["Gemfile"],
    priority: 80,
  },
  {
    id: "solargraph",
    label: "Ruby (Solargraph)",
    extensions: [".rb", ".rake"],
    command: ["solargraph", "stdio"],
    rootMarkers: ["Gemfile", ".solargraph.yml", ".git"],
    priority: 60,
  },
  {
    id: "intelephense",
    label: "PHP",
    extensions: [".php"],
    command: ["intelephense", "--stdio"],
    localPackage: "intelephense",
    rootMarkers: ["composer.json", ".git"],
    priority: 70,
  },
  {
    id: "csharp",
    label: "C#",
    extensions: [".cs"],
    command: ["csharp-ls"],
    rootMarkers: ["*.sln", "*.csproj", ".git"],
    priority: 70,
    startupTimeoutMs: 60_000,
  },
  {
    id: "elixir-ls",
    label: "Elixir",
    extensions: [".ex", ".exs", ".heex", ".eex"],
    command: ["elixir-ls"],
    rootMarkers: ["mix.exs", ".git"],
    requires: ["mix.exs"],
    priority: 80,
    startupTimeoutMs: 90_000,
  },
  {
    id: "zls",
    label: "Zig",
    extensions: [".zig", ".zon"],
    command: ["zls"],
    rootMarkers: ["build.zig", ".git"],
    priority: 80,
  },
  {
    id: "dart",
    label: "Dart",
    extensions: [".dart"],
    command: ["dart", "language-server", "--protocol=lsp"],
    rootMarkers: ["pubspec.yaml", ".git"],
    requires: ["pubspec.yaml"],
    priority: 80,
  },
  {
    id: "sourcekit",
    label: "Swift",
    extensions: [".swift"],
    command: ["sourcekit-lsp"],
    rootMarkers: ["Package.swift", ".git"],
    priority: 80,
    startupTimeoutMs: 60_000,
  },
  {
    id: "lua",
    label: "Lua",
    extensions: [".lua"],
    command: ["lua-language-server"],
    rootMarkers: [".luarc.json", ".luacheckrc", ".git"],
    priority: 70,
  },
  {
    id: "terraform",
    label: "Terraform",
    extensions: [".tf", ".tfvars"],
    command: ["terraform-ls", "serve"],
    rootMarkers: [".terraform", "main.tf", ".git"],
    priority: 70,
  },
  {
    id: "yaml",
    label: "YAML",
    extensions: [".yaml", ".yml"],
    command: ["yaml-language-server", "--stdio"],
    localPackage: "yaml-language-server",
    rootMarkers: [".git"],
    priority: 40,
    initializationOptions: {
      yaml: { validate: true, completion: true, schemaStore: { enable: true } },
    },
  },
  {
    id: "json",
    label: "JSON",
    extensions: [".json", ".jsonc", ".json5"],
    command: ["vscode-json-language-server", "--stdio"],
    localPackage: "vscode-json-language-server",
    rootMarkers: [".git"],
    priority: 40,
    initializationOptions: { provideFormatter: false },
  },
  {
    id: "html",
    label: "HTML",
    extensions: [".html", ".htm"],
    command: ["vscode-html-language-server", "--stdio"],
    localPackage: "vscode-html-language-server",
    rootMarkers: [".git"],
    priority: 40,
  },
  {
    id: "css",
    label: "CSS",
    extensions: [".css", ".scss", ".less"],
    command: ["vscode-css-language-server", "--stdio"],
    localPackage: "vscode-css-language-server",
    rootMarkers: [".git"],
    priority: 40,
  },
  {
    id: "tailwind",
    label: "Tailwind CSS",
    extensions: [".css", ".html", ".tsx", ".jsx", ".vue", ".svelte"],
    command: ["tailwindcss-language-server", "--stdio"],
    localPackage: "tailwindcss-language-server",
    rootMarkers: ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs"],
    requires: ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs"],
    priority: 30,
  },
  {
    id: "svelte",
    label: "Svelte",
    extensions: [".svelte"],
    command: ["svelteserver", "--stdio"],
    localPackage: "svelteserver",
    rootMarkers: ["svelte.config.js", "package.json", ".git"],
    priority: 80,
  },
  {
    id: "vue",
    label: "Vue",
    extensions: [".vue"],
    command: ["vue-language-server", "--stdio"],
    localPackage: "vue-language-server",
    rootMarkers: ["vite.config.ts", "package.json", ".git"],
    priority: 80,
  },
  {
    id: "bash",
    label: "Bash",
    extensions: [".sh", ".bash", ".zsh"],
    command: ["bash-language-server", "start"],
    localPackage: "bash-language-server",
    rootMarkers: [".git"],
    priority: 40,
  },
  {
    id: "docker",
    label: "Dockerfile",
    extensions: [".dockerfile"],
    command: ["docker-langserver", "--stdio"],
    localPackage: "docker-langserver",
    rootMarkers: [".git"],
    priority: 40,
  },
  {
    id: "nix",
    label: "Nix",
    extensions: [".nix"],
    command: ["nil"],
    rootMarkers: ["flake.nix", ".git"],
    priority: 70,
  },
  {
    id: "ocaml",
    label: "OCaml",
    extensions: [".ml", ".mli"],
    command: ["ocamllsp"],
    rootMarkers: ["dune-project", ".git"],
    priority: 70,
  },
  {
    id: "haskell",
    label: "Haskell",
    extensions: [".hs", ".lhs"],
    command: ["haskell-language-server-wrapper", "--lsp"],
    rootMarkers: ["stack.yaml", "cabal.project", "*.cabal", ".git"],
    priority: 70,
    startupTimeoutMs: 120_000,
  },
  {
    id: "scala",
    label: "Scala",
    extensions: [".scala", ".sbt", ".sc"],
    command: ["metals"],
    rootMarkers: ["build.sbt", "build.sc", ".git"],
    priority: 70,
    startupTimeoutMs: 120_000,
  },
  {
    id: "gleam",
    label: "Gleam",
    extensions: [".gleam"],
    command: ["gleam", "lsp"],
    rootMarkers: ["gleam.toml", ".git"],
    requires: ["gleam.toml"],
    priority: 80,
  },
  {
    id: "toml",
    label: "TOML",
    extensions: [".toml"],
    command: ["taplo", "lsp", "stdio"],
    rootMarkers: [".git"],
    priority: 40,
  },
  {
    id: "protobuf",
    label: "Protocol Buffers",
    extensions: [".proto"],
    command: ["buf", "beta", "lsp"],
    rootMarkers: ["buf.yaml", "buf.work.yaml", ".git"],
    priority: 60,
  },
  {
    id: "graphql",
    label: "GraphQL",
    extensions: [".graphql", ".gql"],
    command: ["graphql-lsp", "server", "-m", "stream"],
    localPackage: "graphql-lsp",
    rootMarkers: [".graphqlrc", ".graphqlrc.yml", "graphql.config.js", ".git"],
    priority: 50,
  },
  {
    id: "markdown",
    label: "Markdown",
    extensions: [".md", ".mdx"],
    command: ["marksman", "server"],
    rootMarkers: [".git"],
    priority: 30,
  },
  {
    id: "sql",
    label: "SQL",
    extensions: [".sql"],
    command: ["sqls"],
    rootMarkers: [".sqls.yml", ".git"],
    priority: 40,
  },
]

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

export interface ResolvedServer {
  readonly definition: ServerDefinition
  /** Absolute path to the binary. */
  readonly binary: string
  /** Arguments after the binary. */
  readonly args: readonly string[]
  /** Workspace root to initialise with. */
  readonly root: string
}

/**
 * Finds the servers that should handle a file.
 *
 * Returns several because that is genuinely useful: a TypeScript file benefits
 * from both `tsserver` (type errors) and `eslint` (lint errors), and they report
 * different things. Ordered by priority so the most authoritative comes first.
 */
export function serversFor(
  filePath: string,
  options: { cwd: string; flags?: ReadonlySet<string>; disabled?: ReadonlySet<string> } = {
    cwd: process.cwd(),
  },
): ResolvedServer[] {
  const extension = extensionOf(filePath)
  if (extension === "") return []

  const candidates = SERVERS.filter((server) => server.extensions.includes(extension))
    .filter((server) => !options.disabled?.has(server.id))
    .filter((server) => !server.flag || options.flags?.has(server.flag))
    .sort((left, right) => (right.priority ?? 50) - (left.priority ?? 50))

  const resolved: ResolvedServer[] = []
  const seenLanguages = new Set<string>()

  for (const definition of candidates) {
    // Only one primary server per language; extras such as eslint have a low
    // priority and are additive.
    const primary = (definition.priority ?? 50) >= 70
    if (primary && seenLanguages.has(extension)) continue

    if (definition.requires && !findMarker(filePath, definition.requires, options.cwd)) continue

    const binary = resolveBinary(definition, filePath, options.cwd)
    if (!binary) continue

    const root = findRoot(filePath, definition.rootMarkers, options.cwd)

    resolved.push({
      definition,
      binary,
      args: definition.command.slice(1),
      root,
    })

    if (primary) seenLanguages.add(extension)
  }

  return resolved
}

/** Special-cases files that have no extension but a well-known name. */
function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ""
  if (/^Dockerfile(\..+)?$/i.test(name)) return ".dockerfile"
  if (name === "Makefile" || name === "makefile") return ".make"
  if (name === "go.mod") return ".mod"
  if (name === "go.sum") return ".sum"
  if (name === "go.work") return ".work"
  if (name === "Gemfile" || name === "Rakefile") return ".rb"
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot).toLowerCase()
}

/**
 * Locates the binary, preferring a project-local install.
 *
 * The project's own `typescript-language-server` matches the project's
 * TypeScript version; a globally installed one frequently does not, and the
 * resulting phantom errors are worse than no diagnostics at all.
 */
function resolveBinary(
  definition: ServerDefinition,
  filePath: string,
  cwd: string,
): string | undefined {
  const name = definition.command[0]!

  if (definition.localPackage) {
    let directory = dirname(resolve(cwd, filePath))
    for (let depth = 0; depth < 12; depth++) {
      const candidate = join(
        directory,
        "node_modules",
        ".bin",
        IS_WINDOWS ? `${definition.localPackage}.cmd` : definition.localPackage,
      )
      if (existsSync(candidate)) return candidate
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  return which(name)
}

/**
 * Walks up from the file to find the workspace root.
 *
 * Markers are checked in order at every level, so the *nearest* directory
 * containing *any* marker wins rather than the nearest containing the
 * highest-priority marker. That is what a developer means: the closest
 * `tsconfig.json` defines the project, even if a `package.json` sits above it.
 */
function findRoot(filePath: string, markers: readonly string[], cwd: string): string {
  let directory = dirname(resolve(cwd, filePath))
  const stop = resolve(cwd)
  let fallback: string | undefined

  for (let depth = 0; depth < 32; depth++) {
    for (const marker of markers) {
      if (marker.includes("*")) {
        if (globExists(directory, marker)) return directory
        continue
      }
      if (existsSync(join(directory, marker))) return directory
    }

    if (directory === stop) fallback = directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  return fallback ?? stop
}

/** Whether any marker exists at or above the file. */
function findMarker(filePath: string, markers: readonly string[], cwd: string): boolean {
  let directory = dirname(resolve(cwd, filePath))
  for (let depth = 0; depth < 32; depth++) {
    for (const marker of markers) {
      if (marker.includes("*")) {
        if (globExists(directory, marker)) return true
        continue
      }
      if (existsSync(join(directory, marker))) return true
    }
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
  return false
}

/** Single-segment glob check, for markers such as `*.csproj`. */
function globExists(directory: string, pattern: string): boolean {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs")
    const regex = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
      "i",
    )
    return readdirSync(directory).some((entry) => regex.test(entry))
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Language identifiers                                                */
/* ------------------------------------------------------------------ */

/**
 * Maps an extension to the LSP `languageId`.
 *
 * Servers use this to decide how to parse a document, and several of them refuse
 * to analyse a file whose language id they do not recognise. The values here are
 * the ones from the LSP specification's table, not invented.
 */
const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".mod": "go.mod",
  ".sum": "go.sum",
  ".work": "go.work",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".hh": "cpp",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".cu": "cuda-cpp",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".ex": "elixir",
  ".exs": "elixir",
  ".heex": "heex",
  ".eex": "eex",
  ".zig": "zig",
  ".zon": "zig",
  ".dart": "dart",
  ".swift": "swift",
  ".lua": "lua",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".jsonc": "jsonc",
  ".json5": "json5",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".svelte": "svelte",
  ".vue": "vue",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".dockerfile": "dockerfile",
  ".make": "makefile",
  ".nix": "nix",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".scala": "scala",
  ".sbt": "scala",
  ".sc": "scala",
  ".gleam": "gleam",
  ".toml": "toml",
  ".proto": "proto",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".md": "markdown",
  ".mdx": "mdx",
  ".sql": "sql",
  ".xml": "xml",
  ".vim": "viml",
  ".r": "r",
  ".jl": "julia",
  ".pl": "perl",
  ".clj": "clojure",
  ".erl": "erlang",
  ".fs": "fsharp",
  ".v": "v",
  ".sol": "solidity",
}

export function languageIdFor(filePath: string): string {
  return LANGUAGE_IDS[extensionOf(filePath)] ?? "plaintext"
}

/** Every extension any configured server can handle. */
export function supportedExtensions(): Set<string> {
  const result = new Set<string>()
  for (const server of SERVERS) {
    for (const extension of server.extensions) result.add(extension)
  }
  return result
}

/** Human-readable list for the `doctor` command. */
export function describeAvailability(): Array<{ id: string; label: string; available: boolean }> {
  return SERVERS.map((server) => ({
    id: server.id,
    label: server.label,
    available: which(server.command[0]!) !== undefined,
  }))
}
