/**
 * V4A patch format.
 *
 * The format used by `apply_patch`. It exists because reasoning-tuned OpenAI
 * models produce far more reliable edits when they write a patch than when they
 * write a search/replace pair: a patch carries context lines, so the model must
 * demonstrate that it knows the surrounding code, and multiple hunks across
 * multiple files arrive as one atomic operation.
 *
 * It is deliberately *not* unified diff. Unified diff requires exact line
 * numbers and exact leading whitespace on every line, and models get both wrong
 * constantly. V4A drops line numbers entirely and matches hunks by context,
 * with the same whitespace tolerance ladder used by the `edit` tool.
 *
 * Grammar:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.ts
 *   +line one
 *   +line two
 *   *** Delete File: path/to/old.ts
 *   *** Update File: path/to/existing.ts
 *   *** Move to: path/to/renamed.ts
 *   @@ optional context header
 *    unchanged line
 *   -removed line
 *   +added line
 *   *** End Patch
 *
 * Rules that matter:
 *  - Context lines start with a single space. A completely empty line is also
 *    accepted as a context line, because trailing whitespace gets stripped by
 *    every tool in the chain.
 *  - `@@` sections locate the hunk. A bare `@@` means "continue searching from
 *    the previous hunk"; `@@ text` means "find this text first".
 *  - Multiple `@@` lines nest, which is how the format disambiguates a change
 *    inside a specific class or function.
 */

import { relative, resolve } from "node:path"

import { ValidationError } from "../util/error.js"
import { replace, ReplaceError, explainFailure } from "./replacers.js"

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

const BEGIN_PATCH = "*** Begin Patch"
const END_PATCH = "*** End Patch"
const ADD_FILE = "*** Add File: "
const DELETE_FILE = "*** Delete File: "
const UPDATE_FILE = "*** Update File: "
const MOVE_TO = "*** Move to: "
const END_OF_FILE = "*** End of File"
const HUNK_MARKER = "@@"

/* ------------------------------------------------------------------ */
/* Parsed shape                                                        */
/* ------------------------------------------------------------------ */

export type PatchOperation = AddFileOperation | DeleteFileOperation | UpdateFileOperation

export interface AddFileOperation {
  readonly kind: "add"
  readonly path: string
  readonly content: string
}

export interface DeleteFileOperation {
  readonly kind: "delete"
  readonly path: string
}

export interface UpdateFileOperation {
  readonly kind: "update"
  readonly path: string
  /** Set when the file is also renamed. */
  readonly moveTo?: string
  readonly hunks: readonly Hunk[]
}

export interface Hunk {
  /** Context strings from `@@` lines, outermost first. */
  readonly locators: readonly string[]
  readonly lines: readonly HunkLine[]
  /** True when the hunk is anchored to the end of the file. */
  readonly atEndOfFile: boolean
}

export type HunkLine =
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "remove"; readonly text: string }
  | { readonly kind: "add"; readonly text: string }

export interface Patch {
  readonly operations: readonly PatchOperation[]
}

/* ------------------------------------------------------------------ */
/* Parser                                                             */
/* ------------------------------------------------------------------ */

export class PatchParseError extends ValidationError {
  readonly line: number

  constructor(message: string, line: number) {
    super(`Patch parse error on line ${line}: ${message}`)
    this.name = "PatchParseError"
    this.line = line
  }
}

/**
 * Parses a V4A patch.
 *
 * Tolerant in three specific ways, each earned from real model output:
 *  - The `*** Begin Patch` / `*** End Patch` envelope is optional. Models often
 *    omit it when they are only editing one file.
 *  - Markdown fences around the patch are stripped. Models wrap patches in
 *    ```patch fences roughly half the time.
 *  - A line that is exactly empty inside a hunk is treated as a context line,
 *    because trailing-whitespace stripping is universal.
 */
export function parsePatch(input: string): Patch {
  const lines = stripFences(input).split("\n")
  const operations: PatchOperation[] = []

  let cursor = 0

  // Skip anything before the envelope, and the envelope itself if present.
  while (cursor < lines.length && lines[cursor]!.trim() === "") cursor++
  if (cursor < lines.length && lines[cursor]!.trim() === BEGIN_PATCH) cursor++

  while (cursor < lines.length) {
    const raw = lines[cursor]!
    const line = raw.trimEnd()

    if (line.trim() === "") {
      cursor++
      continue
    }

    if (line.trim() === END_PATCH) break

    if (line.startsWith(ADD_FILE)) {
      const path = normalizePatchPath(line.slice(ADD_FILE.length))
      cursor++
      const contentLines: string[] = []
      while (cursor < lines.length) {
        const current = lines[cursor]!
        if (isOperationHeader(current) || current.trimEnd() === END_PATCH) break
        if (current.startsWith("+")) {
          contentLines.push(current.slice(1))
        } else if (current.trim() === "") {
          contentLines.push("")
        } else {
          throw new PatchParseError(
            `Every line of an added file must start with "+". Found: ${JSON.stringify(current.slice(0, 40))}`,
            cursor + 1,
          )
        }
        cursor++
      }
      operations.push({ kind: "add", path, content: `${contentLines.join("\n")}\n` })
      continue
    }

    if (line.startsWith(DELETE_FILE)) {
      operations.push({ kind: "delete", path: normalizePatchPath(line.slice(DELETE_FILE.length)) })
      cursor++
      continue
    }

    if (line.startsWith(UPDATE_FILE)) {
      const path = normalizePatchPath(line.slice(UPDATE_FILE.length))
      cursor++

      let moveTo: string | undefined
      if (cursor < lines.length && lines[cursor]!.trimEnd().startsWith(MOVE_TO)) {
        moveTo = normalizePatchPath(lines[cursor]!.trimEnd().slice(MOVE_TO.length))
        cursor++
      }

      const parsed = parseHunks(lines, cursor)
      if (parsed.hunks.length === 0) {
        throw new PatchParseError(`"Update File" for ${path} has no changes.`, cursor + 1)
      }
      operations.push({ kind: "update", path, moveTo, hunks: parsed.hunks })
      cursor = parsed.cursor
      continue
    }

    throw new PatchParseError(
      `Expected a file header ("*** Add File:", "*** Update File:", or "*** Delete File:"). Found: ${JSON.stringify(line.slice(0, 60))}`,
      cursor + 1,
    )
  }

  if (operations.length === 0) {
    throw new PatchParseError("The patch contains no operations.", 1)
  }

  return { operations }
}

function parseHunks(lines: readonly string[], start: number): { hunks: Hunk[]; cursor: number } {
  const hunks: Hunk[] = []
  let cursor = start
  let locators: string[] = []
  let current: HunkLine[] = []
  let atEndOfFile = false

  const flush = (): void => {
    if (current.length === 0) {
      // A lone `@@` with no body is a locator for the next hunk, not a hunk.
      return
    }
    hunks.push({ locators: [...locators], lines: current, atEndOfFile })
    current = []
    locators = []
    atEndOfFile = false
  }

  while (cursor < lines.length) {
    const raw = lines[cursor]!
    const trimmedEnd = raw.trimEnd()

    if (trimmedEnd === END_PATCH || isOperationHeader(raw)) break

    if (trimmedEnd === END_OF_FILE) {
      atEndOfFile = true
      cursor++
      continue
    }

    if (trimmedEnd.startsWith(HUNK_MARKER)) {
      flush()
      const locator = trimmedEnd.slice(HUNK_MARKER.length).trim()
      if (locator !== "") locators.push(locator)
      cursor++
      continue
    }

    if (raw.startsWith("+")) {
      current.push({ kind: "add", text: raw.slice(1) })
      cursor++
      continue
    }

    if (raw.startsWith("-")) {
      current.push({ kind: "remove", text: raw.slice(1) })
      cursor++
      continue
    }

    if (raw.startsWith(" ")) {
      current.push({ kind: "context", text: raw.slice(1) })
      cursor++
      continue
    }

    if (raw.trim() === "") {
      // Blank line: context, but only once a hunk has started. Before that it is
      // just separation between sections.
      if (current.length > 0) current.push({ kind: "context", text: "" })
      cursor++
      continue
    }

    // A bare line with no prefix. Models do this when they forget the leading
    // space on context lines. Accepting it is far better than failing the patch,
    // and the context matcher tolerates whitespace anyway.
    current.push({ kind: "context", text: raw })
    cursor++
  }

  flush()
  return { hunks, cursor }
}

function isOperationHeader(line: string): boolean {
  const trimmed = line.trimEnd()
  return (
    trimmed.startsWith(ADD_FILE) ||
    trimmed.startsWith(DELETE_FILE) ||
    trimmed.startsWith(UPDATE_FILE) ||
    trimmed.startsWith(MOVE_TO) ||
    trimmed === BEGIN_PATCH
  )
}

/** Removes markdown fences the model may have wrapped the patch in. */
function stripFences(input: string): string {
  const trimmed = input.trim()
  if (!trimmed.startsWith("```")) return input
  const lines = trimmed.split("\n")
  const fence = /^`{3,}/.exec(lines[0]!)?.[0] ?? "```"
  let end = lines.length - 1
  while (end > 0 && !lines[end]!.trimEnd().startsWith(fence)) end--
  return lines.slice(1, end > 0 ? end : undefined).join("\n")
}

function normalizePatchPath(raw: string): string {
  const path = raw.trim().replace(/^["']|["']$/g, "")
  if (path === "") throw new PatchParseError("A file header is missing its path.", 0)
  // Reject absolute paths and traversal outright; the tool layer resolves
  // everything relative to the working directory.
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return path
  }
  return path.replace(/\\/g, "/")
}

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

export interface FileSnapshot {
  readonly path: string
  readonly content: string
}

export interface PatchChange {
  readonly kind: "add" | "delete" | "update" | "move"
  readonly path: string
  readonly newPath?: string
  readonly before?: string
  readonly after?: string
  readonly additions: number
  readonly deletions: number
  /** Which matching strategy each hunk needed; useful for warning the user. */
  readonly strategies: readonly string[]
}

export interface ApplyPatchResult {
  readonly changes: readonly PatchChange[]
  readonly warnings: readonly string[]
}

export class PatchApplyError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(message)
    this.name = "PatchApplyError"
    this.path = path
  }
}

/**
 * Applies a patch against a set of file contents.
 *
 * Pure: it takes the current contents and returns the new ones. The tool layer
 * is responsible for reading and writing, which keeps this testable and makes
 * the "all or nothing" guarantee easy — if any hunk fails, nothing was written
 * because nothing has been written yet.
 */
export function applyPatch(
  patch: Patch,
  files: ReadonlyMap<string, string>,
): ApplyPatchResult {
  const changes: PatchChange[] = []
  const warnings: string[] = []

  for (const operation of patch.operations) {
    switch (operation.kind) {
      case "add": {
        if (files.has(operation.path)) {
          throw new PatchApplyError(
            operation.path,
            `Cannot add ${operation.path}: the file already exists. Use "*** Update File:" instead.`,
          )
        }
        changes.push({
          kind: "add",
          path: operation.path,
          after: operation.content,
          additions: countLines(operation.content),
          deletions: 0,
          strategies: [],
        })
        break
      }

      case "delete": {
        const existing = files.get(operation.path)
        if (existing === undefined) {
          throw new PatchApplyError(
            operation.path,
            `Cannot delete ${operation.path}: the file does not exist.`,
          )
        }
        changes.push({
          kind: "delete",
          path: operation.path,
          before: existing,
          additions: 0,
          deletions: countLines(existing),
          strategies: [],
        })
        break
      }

      case "update": {
        const existing = files.get(operation.path)
        if (existing === undefined) {
          throw new PatchApplyError(
            operation.path,
            `Cannot update ${operation.path}: the file does not exist. Use "*** Add File:" to create it.`,
          )
        }
        const applied = applyHunks(operation, existing)
        warnings.push(...applied.warnings)
        changes.push({
          kind: operation.moveTo ? "move" : "update",
          path: operation.path,
          newPath: operation.moveTo,
          before: existing,
          after: applied.content,
          additions: applied.additions,
          deletions: applied.deletions,
          strategies: applied.strategies,
        })
        break
      }
    }
  }

  return { changes, warnings }
}

interface AppliedHunks {
  content: string
  additions: number
  deletions: number
  strategies: string[]
  warnings: string[]
}

/**
 * Applies every hunk of one file update.
 *
 * Each hunk is turned into a search/replace pair and pushed through the same
 * replacer ladder the `edit` tool uses. That reuse is the point: the tolerance
 * for whitespace drift, escape mangling, and re-indentation is identical, so a
 * model does not have to learn two different sets of formatting rules.
 */
function applyHunks(operation: UpdateFileOperation, original: string): AppliedHunks {
  let content = original
  let additions = 0
  let deletions = 0
  const strategies: string[] = []
  const warnings: string[] = []

  for (const [position, hunk] of operation.hunks.entries()) {
    const search = hunkSearch(hunk)
    const replacement = hunkReplacement(hunk)

    for (const line of hunk.lines) {
      if (line.kind === "add") additions++
      if (line.kind === "remove") deletions++
    }

    if (search === "" && replacement === "") continue

    // Pure insertion at end of file.
    if (search === "" && hunk.atEndOfFile) {
      content = content.endsWith("\n") ? content + replacement : `${content}\n${replacement}`
      strategies.push("append")
      continue
    }

    // Narrow the search window using the `@@` locators. This is what lets a
    // patch change `return null` inside one specific method when the file has
    // twenty of them.
    const scope = resolveScope(content, hunk.locators)
    if (scope.warning) warnings.push(`${operation.path}: ${scope.warning}`)

    const region = content.slice(scope.start, scope.end)

    try {
      const result = replace(region, search, replacement, { maxStrategy: "context-aware" })
      content = content.slice(0, scope.start) + result.content + content.slice(scope.end)
      strategies.push(result.strategy)
      if (result.strategy !== "simple") {
        warnings.push(
          `${operation.path}: hunk ${position + 1} ${result.note ?? `matched using the ${result.strategy} strategy`}.`,
        )
      }
    } catch (error) {
      if (!(error instanceof ReplaceError)) throw error
      throw new PatchApplyError(
        operation.path,
        `Hunk ${position + 1} of ${operation.path} could not be applied.\n\n${explainFailure(region, search, error)}\n\nContext lines must match the file exactly apart from whitespace. Read the file and re-issue the patch.`,
      )
    }
  }

  return { content, additions, deletions, strategies, warnings }
}

/** The text a hunk expects to find: context plus removed lines. */
function hunkSearch(hunk: Hunk): string {
  const lines = hunk.lines
    .filter((line) => line.kind === "context" || line.kind === "remove")
    .map((line) => line.text)
  return trimEdges(lines).join("\n")
}

/** The text a hunk produces: context plus added lines. */
function hunkReplacement(hunk: Hunk): string {
  const lines = hunk.lines
    .filter((line) => line.kind === "context" || line.kind === "add")
    .map((line) => line.text)
  return trimEdges(lines).join("\n")
}

/**
 * Drops leading and trailing blank lines from a hunk body.
 *
 * Models add them freely, and including them in the search makes matching
 * needlessly brittle. They carry no information: a blank context line at the
 * edge of a hunk constrains nothing.
 */
function trimEdges(lines: readonly string[]): string[] {
  const result = [...lines]
  while (result.length > 0 && result[0]!.trim() === "") result.shift()
  while (result.length > 0 && result[result.length - 1]!.trim() === "") result.pop()
  return result
}

interface Scope {
  readonly start: number
  readonly end: number
  readonly warning?: string
}

/**
 * Narrows the search region using nested `@@` locators.
 *
 * Each locator is matched inside the region established by the previous one, so
 * `@@ class Foo` followed by `@@ def bar` finds `bar` within `Foo`. The region
 * extends from the locator to the end of the current region rather than to the
 * next sibling, because computing structural boundaries without a parser is
 * unreliable and an over-wide region is harmless — the hunk body still has to
 * match.
 */
function resolveScope(content: string, locators: readonly string[]): Scope {
  let start = 0
  let end = content.length
  let warning: string | undefined

  for (const locator of locators) {
    const region = content.slice(start, end)
    let found = region.indexOf(locator)

    if (found === -1) {
      // Try a whitespace-insensitive line match before giving up.
      const lines = region.split("\n")
      const target = locator.trim()
      let offset = 0
      let matched = -1
      for (const line of lines) {
        if (line.trim() === target || line.trim().includes(target)) {
          matched = offset
          break
        }
        offset += line.length + 1
      }
      if (matched === -1) {
        warning = `the context marker "@@ ${locator}" was not found; the hunk was matched against the whole file`
        continue
      }
      found = matched
    }

    start = start + found
  }

  return { start, end, warning }
}

function countLines(content: string): number {
  if (content === "") return 0
  const lines = content.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines.length
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Renders a patch back to V4A text.
 *
 * Used by the `plan` flow, where a change is shown to the user before it is
 * applied, and by the session export.
 */
export function renderPatch(patch: Patch): string {
  const lines: string[] = [BEGIN_PATCH]

  for (const operation of patch.operations) {
    switch (operation.kind) {
      case "add":
        lines.push(`${ADD_FILE}${operation.path}`)
        for (const line of operation.content.replace(/\n$/, "").split("\n")) {
          lines.push(`+${line}`)
        }
        break
      case "delete":
        lines.push(`${DELETE_FILE}${operation.path}`)
        break
      case "update":
        lines.push(`${UPDATE_FILE}${operation.path}`)
        if (operation.moveTo) lines.push(`${MOVE_TO}${operation.moveTo}`)
        for (const hunk of operation.hunks) {
          for (const locator of hunk.locators) lines.push(`${HUNK_MARKER} ${locator}`)
          if (hunk.locators.length === 0) lines.push(HUNK_MARKER)
          for (const line of hunk.lines) {
            const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "
            lines.push(`${prefix}${line.text}`)
          }
          if (hunk.atEndOfFile) lines.push(END_OF_FILE)
        }
        break
    }
  }

  lines.push(END_PATCH)
  return lines.join("\n")
}

/**
 * Builds a patch from before/after contents.
 *
 * Produces one hunk per changed region with three lines of context on each side,
 * which is the amount that reliably disambiguates without bloating the patch.
 */
export function patchFromDiff(path: string, before: string, after: string, context = 3): Patch {
  if (before === after) return { operations: [] }
  if (before === "") return { operations: [{ kind: "add", path, content: after }] }
  if (after === "") return { operations: [{ kind: "delete", path }] }

  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  const script = lineDiff(beforeLines, afterLines)

  const hunks: Hunk[] = []
  let index = 0

  while (index < script.length) {
    if (script[index]!.kind === "context") {
      index++
      continue
    }

    // Expand backwards for leading context.
    let start = index
    let leading = 0
    while (start > 0 && script[start - 1]!.kind === "context" && leading < context) {
      start--
      leading++
    }

    // Consume the change run, absorbing short context gaps so nearby edits share
    // a hunk instead of producing two hunks that overlap in context.
    let end = index
    let gap = 0
    while (end < script.length) {
      if (script[end]!.kind === "context") {
        gap++
        if (gap > context * 2) break
      } else {
        gap = 0
      }
      end++
    }

    // Trim trailing context back to the configured amount.
    let trailing = 0
    let stop = end
    while (stop > index && script[stop - 1]!.kind === "context") {
      stop--
      trailing++
    }
    stop += Math.min(trailing, context)

    hunks.push({
      locators: [],
      lines: script.slice(start, stop).map((entry) => ({ kind: entry.kind, text: entry.text }) as HunkLine),
      atEndOfFile: stop >= script.length,
    })

    index = stop
  }

  return { operations: [{ kind: "update", path, hunks }] }
}

interface DiffEntry {
  kind: "context" | "add" | "remove"
  text: string
}

/**
 * Minimal line diff via the longest common subsequence.
 *
 * A full Myers implementation lives in `util/diff.ts` for display purposes; this
 * one only needs to be correct, and patches are generated rarely, so the simpler
 * dynamic-programming version is the right trade. It falls back to a
 * whole-file replacement when the inputs are large enough that the O(n²) table
 * would be a problem.
 */
function lineDiff(before: readonly string[], after: readonly string[]): DiffEntry[] {
  const limit = 4_000
  if (before.length > limit || after.length > limit) {
    return [
      ...before.map((text): DiffEntry => ({ kind: "remove", text })),
      ...after.map((text): DiffEntry => ({ kind: "add", text })),
    ]
  }

  const rows = before.length
  const columns = after.length
  const table: Uint32Array[] = []
  for (let row = 0; row <= rows; row++) table.push(new Uint32Array(columns + 1))

  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      table[row]![column] =
        before[row] === after[column]
          ? table[row + 1]![column + 1]! + 1
          : Math.max(table[row + 1]![column]!, table[row]![column + 1]!)
    }
  }

  const script: DiffEntry[] = []
  let row = 0
  let column = 0
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      script.push({ kind: "context", text: before[row]! })
      row++
      column++
    } else if (table[row + 1]![column]! >= table[row]![column + 1]!) {
      script.push({ kind: "remove", text: before[row]! })
      row++
    } else {
      script.push({ kind: "add", text: after[column]! })
      column++
    }
  }
  while (row < rows) script.push({ kind: "remove", text: before[row++]! })
  while (column < columns) script.push({ kind: "add", text: after[column++]! })

  return script
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

/** Every path a patch touches, for the permission check. */
export function patchPaths(patch: Patch): string[] {
  const paths = new Set<string>()
  for (const operation of patch.operations) {
    paths.add(operation.path)
    if (operation.kind === "update" && operation.moveTo) paths.add(operation.moveTo)
  }
  return [...paths]
}

/**
 * Rejects paths that escape the working directory.
 *
 * Checked before anything is read, so a malicious or confused patch cannot even
 * learn whether a file outside the project exists.
 */
export function validatePatchPaths(patch: Patch, cwd: string): void {
  for (const path of patchPaths(patch)) {
    const absolute = resolve(cwd, path)
    const relativePath = relative(cwd, absolute)
    if (relativePath.startsWith("..")) {
      throw new PatchApplyError(
        path,
        `The path ${path} is outside the working directory. Patches may only touch files inside ${cwd}.`,
      )
    }
  }
}

/** Short human summary, e.g. `3 files changed, +42 -17`. */
export function summarizePatch(result: ApplyPatchResult): string {
  const additions = result.changes.reduce((sum, change) => sum + change.additions, 0)
  const deletions = result.changes.reduce((sum, change) => sum + change.deletions, 0)
  const count = result.changes.length
  return `${count} file${count === 1 ? "" : "s"} changed, +${additions} -${deletions}`
}

/** Per-file detail lines for the tool result. */
export function describeChanges(result: ApplyPatchResult): string[] {
  return result.changes.map((change) => {
    const verb =
      change.kind === "add"
        ? "created"
        : change.kind === "delete"
          ? "deleted"
          : change.kind === "move"
            ? `moved to ${change.newPath}`
            : "updated"
    return `${change.path}: ${verb} (+${change.additions} -${change.deletions})`
  })
}
