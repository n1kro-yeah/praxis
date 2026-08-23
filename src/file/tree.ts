/**
 * Directory listing.
 *
 * A model that has just arrived in a repository has no idea what is in it. The
 * fastest way to orient it is a tree, but a naive tree of a real project is
 * useless: `node_modules` alone can be two hundred thousand entries, and printing
 * it would consume the entire context window before reaching any source code.
 *
 * So the tree is budgeted. There is a hard cap on entries, a depth limit, and
 * ignore rules applied before descending rather than after. When the budget runs
 * out the listing says so, with counts, rather than stopping silently \u2014 a truncated
 * tree that does not admit it is truncated leads the model to conclude a file does
 * not exist when it simply was not shown.
 *
 * Ordering is deliberate: directories before files, then alphabetical. This is
 * what every file manager does, and matching it means the output reads the way
 * people expect without anyone having to think about it.
 */

import { readdirSync, statSync, type Dirent } from "node:fs"
import { join, relative, resolve, basename, sep } from "node:path"

import { logger } from "../util/log.js"
import { isIgnored } from "./ignore.js"

const log = logger("file.tree")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Entries included before the listing is cut short. */
export const DEFAULT_ENTRY_LIMIT = 400

/** How deep the walk goes. */
export const DEFAULT_MAX_DEPTH = 6

/** Children shown per directory before the rest are summarised. */
const MAX_CHILDREN_PER_DIRECTORY = 60

/**
 * Directories never descended into.
 *
 * The ignore rules would catch most of these, but only after reading the
 * directory. Skipping them by name avoids the read entirely, which on
 * `node_modules` is the difference between instant and several seconds.
 */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  ".gradle",
  ".m2",
  "Pods",
  ".terraform",
  ".serverless",
  "vendor",
  "bower_components",
  ".idea",
  ".vs",
  ".sass-cache",
])

/**
 * Directories that usually hold build output.
 *
 * Skipped, but reported in the summary, because their absence would otherwise
 * look like the project has no build. Distinct from the list above, which is
 * genuinely never interesting.
 */
const BUILD_DIRECTORIES = new Set(["dist", "build", "out", "coverage", "bin", "obj", "_build"])

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface TreeEntry {
  readonly name: string
  /** Relative to the tree root, with forward slashes. */
  readonly path: string
  readonly directory: boolean
  readonly depth: number
  readonly size?: number
  /** Entries not shown, for a directory that was cut short. */
  readonly hidden?: number
  /** Set when the directory was skipped rather than walked. */
  readonly skipped?: "ignored" | "build" | "depth" | "budget"
}

export interface TreeResult {
  readonly root: string
  readonly entries: TreeEntry[]
  readonly truncated: boolean
  readonly totalFiles: number
  readonly totalDirectories: number
  /** Directories skipped without being walked. */
  readonly skipped: string[]
}

export interface TreeOptions {
  readonly maxDepth?: number
  readonly entryLimit?: number
  /** Includes dotfiles. Off by default; they are rarely what is being looked for. */
  readonly hidden?: boolean
  /** Ignores gitignore rules. */
  readonly all?: boolean
  /** Only files matching this predicate are listed. Directories still recursed. */
  readonly filter?: (path: string, entry: Dirent) => boolean
  /** Includes file sizes. Costs one stat per file. */
  readonly sizes?: boolean
}

/* ------------------------------------------------------------------ */
/* Walking                                                             */
/* ------------------------------------------------------------------ */

/**
 * Walks a directory tree.
 *
 * Breadth-first within each directory but depth-first overall, which is what
 * produces the familiar indented shape. A pure breadth-first walk would list every
 * top-level file before any nested one, and the structure would be unreadable.
 *
 * The budget is checked between entries rather than at the end, so a tree that
 * would have been enormous costs the same as one that fits.
 */
export function tree(root: string, options: TreeOptions = {}): TreeResult {
  const absoluteRoot = resolve(root)
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const entryLimit = options.entryLimit ?? DEFAULT_ENTRY_LIMIT

  const entries: TreeEntry[] = []
  const skipped: string[] = []

  let totalFiles = 0
  let totalDirectories = 0
  let truncated = false

  const walk = (directory: string, depth: number): void => {
    if (truncated) return

    if (depth > maxDepth) {
      entries.push({
        name: basename(directory),
        path: toPosix(relative(absoluteRoot, directory)),
        directory: true,
        depth,
        skipped: "depth",
      })

      return
    }

    let children: Dirent[]

    try {
      children = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      // Permission denied on a subdirectory is common and not worth failing the
      // whole listing over.
      log.debug("could not read a directory", { directory, error: String(error) })
      return
    }

    const directories: Dirent[] = []
    const files: Dirent[] = []

    for (const child of children) {
      const name = child.name

      if (!options.hidden && name.startsWith(".") && name !== ".github") continue

      const childPath = join(directory, name)
      const relativePath = toPosix(relative(absoluteRoot, childPath))

      if (child.isDirectory()) {
        if (SKIP_DIRECTORIES.has(name)) {
          skipped.push(relativePath)
          continue
        }

        if (BUILD_DIRECTORIES.has(name)) {
          skipped.push(relativePath)

          entries.push({
            name,
            path: relativePath,
            directory: true,
            depth,
            skipped: "build",
          })

          continue
        }

        if (!options.all && isIgnored(absoluteRoot, relativePath)) {
          skipped.push(relativePath)
          continue
        }

        directories.push(child)
        continue
      }

      if (!child.isFile() && !child.isSymbolicLink()) continue

      if (!options.all && isIgnored(absoluteRoot, relativePath)) continue
      if (options.filter && !options.filter(relativePath, child)) continue

      files.push(child)
    }

    directories.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))

    const combined = [...directories, ...files]
    const shown = combined.slice(0, MAX_CHILDREN_PER_DIRECTORY)
    const hiddenCount = combined.length - shown.length

    for (const child of shown) {
      if (entries.length >= entryLimit) {
        truncated = true
        return
      }

      const childPath = join(directory, child.name)
      const relativePath = toPosix(relative(absoluteRoot, childPath))

      if (child.isDirectory()) {
        totalDirectories++

        entries.push({
          name: child.name,
          path: relativePath,
          directory: true,
          depth,
        })

        walk(childPath, depth + 1)
        continue
      }

      totalFiles++

      let size: number | undefined

      if (options.sizes) {
        try {
          size = statSync(childPath).size
        } catch {
          // A symlink to nothing. Listing it without a size is more useful than
          // omitting it, since a broken link is often the thing being looked for.
        }
      }

      entries.push({
        name: child.name,
        path: relativePath,
        directory: false,
        depth,
        size,
      })
    }

    if (hiddenCount > 0 && entries.length > 0) {
      const last = entries[entries.length - 1]!

      entries[entries.length - 1] = { ...last, hidden: hiddenCount }
    }
  }

  walk(absoluteRoot, 0)

  return {
    root: absoluteRoot,
    entries,
    truncated,
    totalFiles,
    totalDirectories,
    skipped,
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Renders a tree with box-drawing connectors.
 *
 * The connectors are what make depth readable at a glance; plain indentation
 * becomes ambiguous past two or three levels. Whether a branch is the last at its
 * depth has to be known to draw the corner, and that is not available while
 * walking, so it is computed here by looking ahead.
 */
export function renderTree(result: TreeResult, options: { ascii?: boolean } = {}): string {
  const glyphs = options.ascii
    ? { branch: "|-- ", last: "`-- ", vertical: "|   ", space: "    " }
    : { branch: "\u251c\u2500\u2500 ", last: "\u2514\u2500\u2500 ", vertical: "\u2502   ", space: "    " }

  const lines: string[] = [result.root]

  // Whether each depth still has siblings below, so the vertical bars continue
  // through nested entries.
  const continues: boolean[] = []

  for (let index = 0; index < result.entries.length; index++) {
    const entry = result.entries[index]!

    const isLast = !result.entries
      .slice(index + 1)
      .some((later) => later.depth === entry.depth && !hasShallowerBetween(result.entries, index, later, entry.depth))

    continues[entry.depth] = !isLast

    let prefix = ""

    for (let depth = 0; depth < entry.depth; depth++) {
      prefix += continues[depth] ? glyphs.vertical : glyphs.space
    }

    prefix += isLast ? glyphs.last : glyphs.branch

    let label = entry.directory ? `${entry.name}/` : entry.name

    if (entry.skipped === "build") label += "  (build output, not listed)"
    if (entry.skipped === "depth") label += "  (deeper than the depth limit)"
    if (entry.size !== undefined) label += `  ${formatSize(entry.size)}`
    if (entry.hidden) label += `\n${prefix.replace(/[^\s|\u2502]/g, " ")}\u2026 and ${entry.hidden} more`

    lines.push(prefix + label)
  }

  const summary: string[] = []

  summary.push(
    `${result.totalFiles} ${result.totalFiles === 1 ? "file" : "files"}, ${result.totalDirectories} ${result.totalDirectories === 1 ? "directory" : "directories"}`,
  )

  if (result.truncated) {
    summary.push("the listing was cut short at the entry limit")
  }

  if (result.skipped.length > 0) {
    const sample = result.skipped.slice(0, 4).join(", ")
    const more = result.skipped.length > 4 ? `, and ${result.skipped.length - 4} others` : ""

    summary.push(`skipped ${sample}${more}`)
  }

  lines.push("", summary.join("; "))

  return lines.join("\n")
}

/**
 * Whether a shallower entry appears between two entries at the same depth.
 *
 * Without this check, the last child of one directory would be drawn as though
 * it had siblings, because a later directory contains an entry at the same depth.
 */
function hasShallowerBetween(
  entries: TreeEntry[],
  from: number,
  target: TreeEntry,
  depth: number,
): boolean {
  const targetIndex = entries.indexOf(target)

  for (let index = from + 1; index < targetIndex; index++) {
    if (entries[index]!.depth < depth) return true
  }

  return false
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`

  return `${(bytes / 1024 / 1024).toFixed(1)}M`
}

/**
 * A flat list of paths.
 *
 * For the file picker and for the model when the shape of the tree does not
 * matter, only what exists. Considerably cheaper in tokens than the rendered form.
 */
export function flatten(result: TreeResult, options: { filesOnly?: boolean } = {}): string[] {
  return result.entries
    .filter((entry) => (options.filesOnly ? !entry.directory : true))
    .filter((entry) => entry.skipped === undefined)
    .map((entry) => (entry.directory ? `${entry.path}/` : entry.path))
}

/* ------------------------------------------------------------------ */
/* Project shape                                                       */
/* ------------------------------------------------------------------ */

/**
 * Files that identify a project's type.
 *
 * Present in the environment prompt so the model does not have to go looking.
 * Knowing there is a `Cargo.toml` immediately rules out half the possible answers
 * to "how do I run the tests".
 */
const MARKER_FILES: Array<{ file: string; label: string }> = [
  { file: "package.json", label: "Node" },
  { file: "deno.json", label: "Deno" },
  { file: "bun.lockb", label: "Bun" },
  { file: "Cargo.toml", label: "Rust" },
  { file: "go.mod", label: "Go" },
  { file: "pyproject.toml", label: "Python" },
  { file: "requirements.txt", label: "Python" },
  { file: "Pipfile", label: "Python" },
  { file: "Gemfile", label: "Ruby" },
  { file: "composer.json", label: "PHP" },
  { file: "pom.xml", label: "Maven" },
  { file: "build.gradle", label: "Gradle" },
  { file: "build.gradle.kts", label: "Gradle" },
  { file: "mix.exs", label: "Elixir" },
  { file: "Package.swift", label: "Swift" },
  { file: "pubspec.yaml", label: "Dart" },
  { file: "CMakeLists.txt", label: "CMake" },
  { file: "Makefile", label: "Make" },
  { file: "justfile", label: "Just" },
  { file: "Taskfile.yml", label: "Task" },
  { file: "Dockerfile", label: "Docker" },
  { file: "docker-compose.yml", label: "Docker Compose" },
  { file: "flake.nix", label: "Nix" },
  { file: "shell.nix", label: "Nix" },
  { file: "terraform.tf", label: "Terraform" },
  { file: ".tool-versions", label: "asdf" },
]

export interface ProjectShape {
  readonly markers: Array<{ file: string; label: string }>
  readonly topLevel: string[]
  readonly hasTests: boolean
  readonly hasSource: boolean
}

/**
 * A quick sketch of a project.
 *
 * One directory read, no recursion. Cheap enough to run at startup for every
 * session, which is the point \u2014 the model should start with this rather than
 * spending its first three tool calls finding out.
 */
export function projectShape(root: string): ProjectShape {
  const markers: Array<{ file: string; label: string }> = []
  const topLevel: string[] = []

  let children: Dirent[]

  try {
    children = readdirSync(resolve(root), { withFileTypes: true })
  } catch {
    return { markers: [], topLevel: [], hasTests: false, hasSource: false }
  }

  const names = new Set(children.map((child) => child.name))

  for (const marker of MARKER_FILES) {
    if (names.has(marker.file)) markers.push(marker)
  }

  for (const child of children) {
    if (child.name.startsWith(".")) continue
    if (SKIP_DIRECTORIES.has(child.name)) continue

    topLevel.push(child.isDirectory() ? `${child.name}/` : child.name)
  }

  topLevel.sort()

  const hasTests = ["test", "tests", "spec", "__tests__", "t"].some((name) => names.has(name))
  const hasSource = ["src", "lib", "app", "source", "pkg", "cmd", "internal"].some((name) =>
    names.has(name),
  )

  return { markers, topLevel, hasTests, hasSource }
}
