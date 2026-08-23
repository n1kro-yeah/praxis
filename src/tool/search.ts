/**
 * The `grep`, `glob`, and `list` tools.
 *
 * These three are how the agent builds a mental model of a codebase it has never
 * seen. Their quality determines whether the first five turns of a session are
 * productive or wasted, so they get more attention than their size suggests:
 *
 *  - Results are ordered by modification time, not alphabetically. In a coding
 *    session the recently touched file is nearly always the relevant one.
 *  - Output is capped and the cap is *announced*, with advice on how to narrow
 *    the search. A silent truncation makes a model believe it has seen
 *    everything.
 *  - Empty results explain why they are empty and suggest the next move, because
 *    the most expensive failure mode is a model that concludes a symbol does not
 *    exist when it merely mistyped the pattern.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, extname, join, relative, resolve, sep } from "node:path"

import { s } from "../util/schema.js"
import { suggestPattern } from "../permission/rules.js"
import { displayPath, formatBytes } from "../edit/apply.js"
import { glob as globSearch, renderMatches, search } from "../file/ripgrep.js"
import { IgnoreMatcher } from "../file/ignore.js"
import { defineTool, fail, ok, type ToolContext, type ToolResult } from "./types.js"

/* ------------------------------------------------------------------ */
/* grep                                                                */
/* ------------------------------------------------------------------ */

const grepParameters = s.object({
  pattern: s
    .string()
    .describe("Regular expression to search for. Use \\b for word boundaries and escape regex metacharacters."),
  path: s.string().optional().describe("Directory to search. Defaults to the working directory."),
  include: s
    .string()
    .optional()
    .describe('Only search files matching this glob, for example "*.ts" or "src/**/*.py".'),
  exclude: s.string().optional().describe("Skip files matching this glob."),
  literal: s.boolean().optional().describe("Treat the pattern as a literal string rather than a regex."),
  caseSensitive: s
    .boolean()
    .optional()
    .describe("Force case sensitivity. By default the search is case-insensitive unless the pattern has uppercase letters."),
  wholeWord: s.boolean().optional().describe("Match whole words only."),
  context: s.number().optional().describe("Lines of context to show around each match. Defaults to 0."),
  limit: s.number().optional().describe("Maximum matches to return. Defaults to 100."),
  filesOnly: s.boolean().optional().describe("Return only the list of matching file paths."),
})

type GrepInput = {
  pattern: string
  path?: string
  include?: string
  exclude?: string
  literal?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  context?: number
  limit?: number
  filesOnly?: boolean
}

const GREP_DESCRIPTION = `Search file contents with a regular expression.

This is the fastest way to find where something is defined or used. Reach for it before reading files: one grep usually replaces five reads.

Guidance:
- Search for the most distinctive part of what you are looking for. "function handleAuth" beats "handleAuth" which beats "auth".
- Narrow with include when you know the language: include "*.ts" cuts the noise dramatically in a mixed repository.
- Set context to 2 or 3 when you need to see what surrounds a match; leave it at 0 when you only need locations.
- Set filesOnly to true when you only care which files are involved, for example before deciding what to read.
- The pattern is a regular expression. To search for a literal string containing dots, parentheses, or brackets, set literal to true instead of escaping by hand.

Results are ordered with recently modified files first, and are capped. If the output says it was truncated, make the pattern more specific rather than raising the limit.

Ignored directories (node_modules, build output, .git) and binary files are skipped automatically.`

export const grepTool = defineTool<GrepInput>({
  id: "grep",
  action: "read",
  readOnly: true,
  concurrent: true,
  init: () => ({
    description: GREP_DESCRIPTION,
    parameters: grepParameters as never,
    execute: async (input, context) => {
      const target = resolve(context.cwd, input.path ?? ".")

      if (!existsSync(target)) {
        return fail("grep", `${input.path} does not exist.`)
      }

      await context.requestPermission({
        action: "read",
        resource: target,
        title: `Search for ${truncatePattern(input.pattern)} in ${displayPath(target, context.cwd)}`,
        pattern: suggestPattern("read", target, context.cwd),
      })

      const contextLines = Math.min(Math.max(input.context ?? 0, 0), 10)

      let summary
      try {
        summary = await search({
          pattern: input.pattern,
          path: target,
          literal: input.literal,
          caseSensitivity: input.caseSensitive ? "sensitive" : "smart",
          include: input.include,
          exclude: input.exclude,
          wholeWord: input.wholeWord,
          before: contextLines,
          after: contextLines,
          maxMatches: Math.min(Math.max(input.limit ?? 100, 1), 1_000),
          filesOnly: input.filesOnly,
          signal: context.signal,
        })
      } catch (error) {
        return fail("grep", String((error as Error).message))
      }

      context.metadata({
        matches: summary.matches.length,
        files: summary.filesMatched,
        searched: summary.filesSearched,
        engine: summary.engine,
        durationMs: summary.durationMs,
      })

      if (summary.matches.length === 0) {
        return ok(
          `no matches for ${truncatePattern(input.pattern)}`,
          emptyGrepAdvice(input, summary.filesSearched),
          { matches: 0, searched: summary.filesSearched },
        )
      }

      if (input.filesOnly) {
        const paths = [...new Set(summary.matches.map((match) => match.path))]
        return ok(
          `${paths.length} file${paths.length === 1 ? "" : "s"} match ${truncatePattern(input.pattern)}`,
          paths.map((path) => displayPath(path, context.cwd)).join("\n"),
          { files: paths.length },
        )
      }

      const rendered = renderMatches(summary, {
        cwd: context.cwd,
        showContext: contextLines > 0,
        maxLines: 500,
      })

      return ok(
        `${summary.matches.length} match${summary.matches.length === 1 ? "" : "es"} for ${truncatePattern(input.pattern)}`,
        rendered,
        { matches: summary.matches.length, files: summary.filesMatched },
      )
    },
  }),
})

/**
 * Explains an empty result and suggests a next step.
 *
 * A bare "no matches" invites the model to conclude the code does not exist. In
 * practice the pattern was usually too specific, or the include filter excluded
 * the right file type.
 */
function emptyGrepAdvice(input: GrepInput, filesSearched: number): string {
  const lines = [`No matches for \`${input.pattern}\` in ${filesSearched} files.`]

  const suggestions: string[] = []
  if (input.include) {
    suggestions.push(`Drop the include filter (\`${input.include}\`) — the code may be in a different file type.`)
  }
  if (input.caseSensitive) {
    suggestions.push("Turn off caseSensitive.")
  }
  if (input.wholeWord) {
    suggestions.push("Turn off wholeWord — the symbol may be part of a longer identifier.")
  }
  if (/[\\^$.[\]|()*+?{}]/.test(input.pattern) && !input.literal) {
    suggestions.push(
      "The pattern contains regex metacharacters. If you meant them literally, set literal to true.",
    )
  }
  const words = input.pattern.split(/[^A-Za-z0-9_]+/).filter((word) => word.length > 3)
  if (words.length > 1) {
    suggestions.push(`Search for just one part, such as \`${words[0]}\`.`)
  }
  if (filesSearched === 0) {
    suggestions.push(
      "No files were searched at all. Check the path, and use list to confirm what is in the directory.",
    )
  }

  if (suggestions.length > 0) {
    lines.push("", "Try:", ...suggestions.map((entry) => `- ${entry}`))
  }

  return lines.join("\n")
}

function truncatePattern(pattern: string): string {
  return pattern.length > 48 ? `${pattern.slice(0, 45)}\u2026` : pattern
}

/* ------------------------------------------------------------------ */
/* glob                                                                */
/* ------------------------------------------------------------------ */

const globParameters = s.object({
  pattern: s
    .string()
    .describe('Glob pattern, for example "**/*.ts", "src/**/test_*.py", or "Dockerfile*".'),
  path: s.string().optional().describe("Directory to search from. Defaults to the working directory."),
  limit: s.number().optional().describe("Maximum paths to return. Defaults to 100."),
  hidden: s.boolean().optional().describe("Include dotfiles and hidden directories."),
})

type GlobInput = { pattern: string; path?: string; limit?: number; hidden?: boolean }

const GLOB_DESCRIPTION = `Find files by name pattern.

Use this to discover where things live before reading anything. "**/*.config.ts" finds every config file; "**/test_*.py" finds the tests.

Supported syntax:
- \`*\` matches within one path segment
- \`**\` matches across directories
- \`?\` matches one character
- \`{a,b}\` matches either alternative
- \`[abc]\` matches a character class

Results are ordered with recently modified files first, which is usually the order you want.

This is much faster than running \`find\` in bash and it respects gitignore, so you will not get a thousand hits from node_modules.`

export const globTool = defineTool<GlobInput>({
  id: "glob",
  action: "read",
  readOnly: true,
  concurrent: true,
  init: () => ({
    description: GLOB_DESCRIPTION,
    parameters: globParameters as never,
    execute: async (input, context) => {
      const target = resolve(context.cwd, input.path ?? ".")

      if (!existsSync(target)) {
        return fail("glob", `${input.path} does not exist.`)
      }

      await context.requestPermission({
        action: "read",
        resource: target,
        title: `Find ${input.pattern} in ${displayPath(target, context.cwd)}`,
        pattern: suggestPattern("read", target, context.cwd),
      })

      const result = globSearch({
        pattern: input.pattern,
        path: target,
        limit: Math.min(Math.max(input.limit ?? 100, 1), 1_000),
        hidden: input.hidden,
        signal: context.signal,
      })

      context.metadata({
        found: result.paths.length,
        scanned: result.scanned,
        durationMs: result.durationMs,
      })

      if (result.paths.length === 0) {
        return ok(
          `no files match ${input.pattern}`,
          emptyGlobAdvice(input, result.scanned),
          { found: 0, scanned: result.scanned },
        )
      }

      const lines = result.paths.map((path) => displayPath(path, context.cwd))
      const header = result.truncated
        ? `${result.paths.length} files (truncated; narrow the pattern to see the rest)`
        : `${result.paths.length} file${result.paths.length === 1 ? "" : "s"}`

      return ok(`${result.paths.length} match${result.paths.length === 1 ? "" : "es"} for ${input.pattern}`, `${header}\n\n${lines.join("\n")}`, {
        found: result.paths.length,
        truncated: result.truncated,
      })
    },
  }),
})

function emptyGlobAdvice(input: GlobInput, scanned: number): string {
  const lines = [`No files match \`${input.pattern}\` (scanned ${scanned} entries).`]
  const suggestions: string[] = []

  if (!input.pattern.includes("**") && input.pattern.includes("/")) {
    suggestions.push(`Use \`**/\` to search at any depth, for example \`**/${input.pattern.split("/").pop()}\`.`)
  }
  if (!input.pattern.includes("*")) {
    suggestions.push(`Add a wildcard: \`**/*${input.pattern}*\`.`)
  }
  if (!input.hidden && input.pattern.startsWith(".")) {
    suggestions.push("Set hidden to true to include dotfiles.")
  }
  if (scanned === 0) {
    suggestions.push("The directory appears to be empty or unreadable. Use list to check.")
  }

  if (suggestions.length > 0) lines.push("", "Try:", ...suggestions.map((entry) => `- ${entry}`))
  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* list                                                                */
/* ------------------------------------------------------------------ */

const listParameters = s.object({
  path: s.string().optional().describe("Directory to list. Defaults to the working directory."),
  depth: s.number().optional().describe("How many levels deep to show. Defaults to 2. Maximum 5."),
  all: s.boolean().optional().describe("Include hidden and ignored entries."),
  limit: s.number().optional().describe("Maximum entries to show. Defaults to 200."),
})

type ListInput = { path?: string; depth?: number; all?: boolean; limit?: number }

const LIST_DESCRIPTION = `Show the contents of a directory as a tree.

Use this at the start of a task to orient yourself, and whenever you need to know what is next to a file you are working on.

By default it shows two levels and skips ignored directories, which keeps the output readable in a real repository. Increase depth when you need more, but be aware that a deep tree in a large project will be truncated.

For finding a specific file, glob is better. For finding code, grep is better. Use this when you want to understand the shape of a directory.`

export const listTool = defineTool<ListInput>({
  id: "list",
  action: "read",
  readOnly: true,
  concurrent: true,
  init: () => ({
    description: LIST_DESCRIPTION,
    parameters: listParameters as never,
    execute: async (input, context) => executeList(input, context),
  }),
})

async function executeList(input: ListInput, context: ToolContext): Promise<ToolResult> {
  const target = resolve(context.cwd, input.path ?? ".")

  if (!existsSync(target)) {
    return fail("list", `${input.path ?? "."} does not exist.`)
  }

  const stats = statSync(target)
  if (!stats.isDirectory()) {
    return fail("list", `${input.path} is a file, not a directory. Use read to see its contents.`)
  }

  await context.requestPermission({
    action: "read",
    resource: target,
    title: `List ${displayPath(target, context.cwd)}`,
    pattern: suggestPattern("read", target, context.cwd),
  })

  const depth = Math.min(Math.max(input.depth ?? 2, 1), 5)
  const limit = Math.min(Math.max(input.limit ?? 200, 10), 1_000)
  const matcher = new IgnoreMatcher({
    root: target,
    useDefaults: !input.all,
    hideSensitive: !input.all,
    useGitignore: !input.all,
  })

  const rendered = renderTree(target, matcher, {
    depth,
    limit,
    all: input.all ?? false,
    signal: context.signal,
  })

  context.metadata({ entries: rendered.count, truncated: rendered.truncated })

  const header = [
    `${displayPath(target, context.cwd) || "."}/`,
    rendered.truncated ? `(showing ${rendered.count} of more entries; increase limit or narrow the path)` : "",
  ]
    .filter(Boolean)
    .join(" ")

  return ok(
    `${displayPath(target, context.cwd) || "."} (${rendered.count} entries)`,
    `${header}\n${rendered.text}`,
    { entries: rendered.count, truncated: rendered.truncated },
  )
}

interface TreeOptions {
  readonly depth: number
  readonly limit: number
  readonly all: boolean
  readonly signal?: AbortSignal
}

interface TreeResult {
  readonly text: string
  readonly count: number
  readonly truncated: boolean
}

/**
 * Renders a directory tree with box-drawing characters.
 *
 * Directories are listed before files and each group is sorted by name, which
 * makes the output stable between calls — important, because an unstable listing
 * looks to a model like the filesystem changed.
 *
 * Entry counts are shown for directories that were not expanded, so the model
 * knows whether descending is worthwhile.
 */
function renderTree(root: string, matcher: IgnoreMatcher, options: TreeOptions): TreeResult {
  const lines: string[] = []
  let count = 0
  let truncated = false

  const walk = (directory: string, prefix: string, level: number): void => {
    if (truncated || options.signal?.aborted) return
    if (level > options.depth) return

    matcher.loadDirectory(directory)

    let entries: string[]
    try {
      entries = readdirSync(directory)
    } catch {
      lines.push(`${prefix}└── (unreadable)`)
      return
    }

    const directories: string[] = []
    const files: Array<{ name: string; size: number }> = []

    for (const name of entries) {
      if (!options.all && name.startsWith(".")) continue
      const full = join(directory, name)
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        if (!options.all && matcher.isIgnored(full, true)) continue
        directories.push(name)
      } else if (stats.isFile()) {
        if (!options.all && matcher.isIgnored(full, false)) continue
        files.push({ name, size: stats.size })
      }
    }

    directories.sort((left, right) => left.localeCompare(right))
    files.sort((left, right) => left.name.localeCompare(right.name))

    const total = directories.length + files.length
    let index = 0

    for (const name of directories) {
      if (count >= options.limit) {
        truncated = true
        return
      }
      index++
      const last = index === total
      const branch = last ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 "
      const full = join(directory, name)

      if (level === options.depth) {
        // Not expanding: report how much is inside so the model can decide.
        const inner = countEntries(full)
        lines.push(`${prefix}${branch}${name}/${inner > 0 ? ` (${inner} entries)` : ""}`)
      } else {
        lines.push(`${prefix}${branch}${name}/`)
      }
      count++

      if (level < options.depth) {
        walk(full, `${prefix}${last ? "    " : "\u2502   "}`, level + 1)
      }
    }

    for (const file of files) {
      if (count >= options.limit) {
        truncated = true
        return
      }
      index++
      const last = index === total
      const branch = last ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 "
      lines.push(`${prefix}${branch}${file.name}${annotate(file.name, file.size)}`)
      count++
    }
  }

  walk(root, "", 1)

  return { text: lines.join("\n"), count, truncated }
}

/** Annotates notable files with their size, so large ones stand out. */
function annotate(name: string, size: number): string {
  if (size > 512 * 1024) return `  (${formatBytes(size)})`
  if (size === 0) return "  (empty)"
  return ""
}

function countEntries(directory: string): number {
  try {
    return readdirSync(directory).length
  } catch {
    return 0
  }
}

/* ------------------------------------------------------------------ */
/* Shared: project overview                                            */
/* ------------------------------------------------------------------ */

/**
 * Files whose presence identifies a project type.
 *
 * Used by the environment block in the system prompt and by the `init` command.
 * Ordered so the most specific marker wins: a repository with both `package.json`
 * and `Cargo.toml` is more usefully described as a Rust project with a JS
 * frontend than the reverse.
 */
export const PROJECT_MARKERS: ReadonlyArray<{ file: string; label: string }> = [
  { file: "Cargo.toml", label: "Rust" },
  { file: "go.mod", label: "Go" },
  { file: "pyproject.toml", label: "Python" },
  { file: "requirements.txt", label: "Python" },
  { file: "Pipfile", label: "Python" },
  { file: "pom.xml", label: "Java (Maven)" },
  { file: "build.gradle", label: "Java/Kotlin (Gradle)" },
  { file: "build.gradle.kts", label: "Kotlin (Gradle)" },
  { file: "Gemfile", label: "Ruby" },
  { file: "composer.json", label: "PHP" },
  { file: "mix.exs", label: "Elixir" },
  { file: "pubspec.yaml", label: "Dart/Flutter" },
  { file: "Package.swift", label: "Swift" },
  { file: "build.zig", label: "Zig" },
  { file: "CMakeLists.txt", label: "C/C++ (CMake)" },
  { file: "Makefile", label: "Make" },
  { file: "deno.json", label: "Deno" },
  { file: "bun.lock", label: "Bun" },
  { file: "package.json", label: "Node.js" },
  { file: "Dockerfile", label: "Docker" },
  { file: "docker-compose.yml", label: "Docker Compose" },
  { file: "terraform.tf", label: "Terraform" },
  { file: "flake.nix", label: "Nix" },
]

/** Identifies what kind of project a directory contains. */
export function detectProjectKinds(directory: string): string[] {
  const found: string[] = []
  for (const marker of PROJECT_MARKERS) {
    if (existsSync(join(directory, marker.file))) found.push(marker.label)
  }
  return [...new Set(found)]
}

/**
 * Counts files by extension, to give the model a sense of scale and language mix.
 *
 * Capped at a fixed number of files: on a large monorepo an exact count is both
 * slow and useless, and "more than 5000" conveys the same thing.
 */
export function languageBreakdown(
  directory: string,
  limit = 5_000,
): Array<{ extension: string; count: number }> {
  const matcher = new IgnoreMatcher({ root: directory })
  const counts = new Map<string, number>()
  let seen = 0

  const queue: string[] = [directory]
  while (queue.length > 0 && seen < limit) {
    const current = queue.shift()!
    matcher.loadDirectory(current)
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue
      const full = join(current, name)
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        if (matcher.shouldDescend(full)) queue.push(full)
        continue
      }
      if (!stats.isFile()) continue
      if (matcher.isIgnored(full, false)) continue
      const extension = extname(name).toLowerCase() || basename(name)
      counts.set(extension, (counts.get(extension) ?? 0) + 1)
      seen++
      if (seen >= limit) break
    }
  }

  return [...counts.entries()]
    .map(([extension, count]) => ({ extension, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 12)
}

/** Relative posix path, for consistent display across platforms. */
export function posixRelative(from: string, to: string): string {
  const value = relative(from, to)
  return value === "" ? "." : value.split(sep).join("/")
}
