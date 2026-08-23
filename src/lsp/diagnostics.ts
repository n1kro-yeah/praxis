/**
 * Diagnostic store and rendering.
 *
 * Diagnostics arrive as unsolicited push notifications, in bursts, with no
 * ordering guarantee and no indication of when a file's set is complete. This
 * module turns that stream into something a coding agent can act on.
 *
 * Two design decisions carry most of the value:
 *
 *  1. **Only report what changed.** After an edit the model needs to know what it
 *     broke, not the 200 pre-existing warnings in files it never touched. The
 *     store keeps a per-file baseline and can diff against it, which is what
 *     turns diagnostics from noise into a feedback loop.
 *  2. **Render with source lines.** "error TS2345 at 42:17" is nearly useless
 *     without the line. Including the offending line and a caret makes the
 *     majority of type errors fixable without reading the file again, which saves
 *     a whole tool round trip per error.
 *
 * The severity policy is deliberate: errors always surface, warnings surface only
 * for files the model edited in this turn, and hints never surface. A model that
 * is shown every lint hint will spend its turn appeasing the linter instead of
 * doing the task.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { logger } from "../util/log.js"
import { Bus, Events } from "../util/bus.js"
import { displayPath } from "../edit/apply.js"
import { Severity, type Diagnostic, type DiagnosticSeverity } from "./client.js"
import { formatRange } from "./jsonrpc.js"

const log = logger("lsp.diagnostics")

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

interface Entry {
  readonly path: string
  /** Keyed by server id, because two servers report on the same file. */
  readonly bySource: Map<string, readonly Diagnostic[]>
  updatedAt: number
}

export interface DiagnosticCount {
  readonly errors: number
  readonly warnings: number
  readonly infos: number
  readonly hints: number
}

/**
 * Holds the current diagnostics for every file any server has reported on.
 *
 * Keyed by server so a later publication from `tsserver` does not erase the
 * `eslint` results for the same file. Merging happens at read time.
 */
export class DiagnosticStore {
  private readonly entries = new Map<string, Entry>()
  /** Snapshot used to compute "what changed", keyed by path. */
  private baseline = new Map<string, string>()

  /** Records a publication from one server. */
  set(source: string, path: string, diagnostics: readonly Diagnostic[]): void {
    const absolute = resolve(path)
    let entry = this.entries.get(absolute)

    if (!entry) {
      entry = { path: absolute, bySource: new Map(), updatedAt: Date.now() }
      this.entries.set(absolute, entry)
    }

    if (diagnostics.length === 0) {
      entry.bySource.delete(source)
      if (entry.bySource.size === 0) this.entries.delete(absolute)
    } else {
      entry.bySource.set(source, dedupe(diagnostics))
    }

    entry.updatedAt = Date.now()

    Bus.publish(Events.diagnosticsPublished, {
      path: absolute,
      source,
      errors: diagnostics.filter((entry_) => (entry_.severity ?? 1) === Severity.error).length,
      total: diagnostics.length,
    })
  }

  /** All diagnostics for one file, merged across servers and sorted by position. */
  forFile(path: string): Diagnostic[] {
    const entry = this.entries.get(resolve(path))
    if (!entry) return []

    const merged: Diagnostic[] = []
    for (const list of entry.bySource.values()) merged.push(...list)

    return merged.sort((left, right) => {
      if (left.range.start.line !== right.range.start.line) {
        return left.range.start.line - right.range.start.line
      }
      if (left.range.start.character !== right.range.start.character) {
        return left.range.start.character - right.range.start.character
      }
      return (left.severity ?? 4) - (right.severity ?? 4)
    })
  }

  /** Every file with at least one diagnostic. */
  files(): string[] {
    return [...this.entries.keys()]
  }

  /** Counts by severity, either for one file or across everything. */
  count(path?: string): DiagnosticCount {
    const lists = path ? [this.forFile(path)] : [...this.entries.keys()].map((file) => this.forFile(file))
    let errors = 0
    let warnings = 0
    let infos = 0
    let hints = 0

    for (const list of lists) {
      for (const diagnostic of list) {
        switch (diagnostic.severity ?? Severity.error) {
          case Severity.error:
            errors++
            break
          case Severity.warning:
            warnings++
            break
          case Severity.information:
            infos++
            break
          default:
            hints++
        }
      }
    }

    return { errors, warnings, infos, hints }
  }

  clear(path?: string): void {
    if (path) {
      this.entries.delete(resolve(path))
      return
    }
    this.entries.clear()
  }

  /**
   * Captures the current state as a baseline.
   *
   * Called before an edit so that afterwards we can report only the diagnostics
   * the edit introduced. The fingerprint deliberately excludes line numbers:
   * inserting a line above an existing error shifts it, and reporting a shifted
   * pre-existing error as "new" is exactly the noise this mechanism exists to
   * avoid.
   */
  snapshot(paths?: readonly string[]): void {
    const targets = paths?.map((path) => resolve(path)) ?? [...this.entries.keys()]
    for (const path of targets) {
      this.baseline.set(path, fingerprint(this.forFile(path)))
    }
  }

  /** Whether a file's diagnostics differ from the baseline. */
  changedSince(path: string): boolean {
    const absolute = resolve(path)
    const previous = this.baseline.get(absolute)
    if (previous === undefined) return this.forFile(absolute).length > 0
    return previous !== fingerprint(this.forFile(absolute))
  }

  /**
   * Diagnostics that were not present in the baseline.
   *
   * Matched on message plus severity plus code rather than position, for the
   * line-shift reason above.
   */
  newSince(path: string): Diagnostic[] {
    const absolute = resolve(path)
    const previous = this.baseline.get(absolute)
    if (previous === undefined) return this.forFile(absolute)

    const known = new Set(previous.split("\u0000").filter(Boolean))
    return this.forFile(absolute).filter((diagnostic) => !known.has(signature(diagnostic)))
  }

  resetBaseline(): void {
    this.baseline = new Map()
  }

  /** Age of the newest publication, used to decide whether to wait longer. */
  lastUpdate(): number {
    let newest = 0
    for (const entry of this.entries.values()) newest = Math.max(newest, entry.updatedAt)
    return newest
  }
}

/** Fingerprint of a file's diagnostics, position-independent. */
function fingerprint(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map(signature).sort().join("\u0000")
}

function signature(diagnostic: Diagnostic): string {
  return `${diagnostic.severity ?? 1}|${diagnostic.code ?? ""}|${diagnostic.message.trim()}`
}

/**
 * Removes duplicates within one publication.
 *
 * Servers do emit the same diagnostic twice — `tsserver` in particular reports
 * some errors once for the file and once for the project — and a duplicated error
 * makes a model believe there are two distinct problems.
 */
function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>()
  const result: Diagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${signature(diagnostic)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(diagnostic)
  }
  return result
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export interface RenderDiagnosticsOptions {
  readonly cwd: string
  /** Minimum severity to include. Defaults to warning. */
  readonly minSeverity?: DiagnosticSeverity
  /** Include the source line and a caret under the range. */
  readonly showSource?: boolean
  /** Maximum diagnostics to render per file. */
  readonly maxPerFile?: number
  /** Maximum total diagnostics. */
  readonly max?: number
}

const SEVERITY_LABEL: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
}

/**
 * Renders diagnostics for one file in a compiler-like format.
 *
 * The format mirrors what a compiler prints, because that is what the model has
 * seen most of during training and therefore parses most reliably:
 *
 *   src/app.ts:42:17 error TS2345: Argument of type 'string' is not assignable
 *      42 |   handle(value)
 *         |          ^^^^^
 */
export function renderFileDiagnostics(
  path: string,
  diagnostics: readonly Diagnostic[],
  options: RenderDiagnosticsOptions,
): string {
  const minSeverity = options.minSeverity ?? Severity.warning
  const filtered = diagnostics.filter((diagnostic) => (diagnostic.severity ?? 1) <= minSeverity)
  if (filtered.length === 0) return ""

  const relative = displayPath(path, options.cwd)
  const maxPerFile = options.maxPerFile ?? 20
  const shown = filtered.slice(0, maxPerFile)

  let lines: string[] | undefined
  if (options.showSource) {
    try {
      lines = readFileSync(path, "utf8").split("\n")
    } catch {
      lines = undefined
    }
  }

  const output: string[] = []

  for (const diagnostic of shown) {
    const severity = SEVERITY_LABEL[diagnostic.severity ?? 1] ?? "error"
    const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`
    const source = diagnostic.source ? `${diagnostic.source}` : ""
    const prefix = `${relative}:${formatRange(diagnostic.range)}`

    output.push(
      `${prefix} ${severity}${source ? ` [${source}]` : ""}${code}: ${collapse(diagnostic.message)}`,
    )

    if (lines) {
      const rendered = renderSourceExcerpt(lines, diagnostic)
      if (rendered) output.push(rendered)
    }

    // Related information is where a type error's actual cause usually lives
    // ("the expected type comes from property 'x' declared here"), so it is worth
    // the extra tokens.
    for (const related of diagnostic.relatedInformation?.slice(0, 3) ?? []) {
      const relatedPath = displayPath(uriPath(related.location.uri), options.cwd)
      output.push(
        `    \u2192 ${relatedPath}:${formatRange(related.location.range)}: ${collapse(related.message)}`,
      )
    }
  }

  if (filtered.length > shown.length) {
    output.push(`  ... and ${filtered.length - shown.length} more in this file`)
  }

  return output.join("\n")
}

/**
 * Renders the offending source line with a caret underline.
 *
 * Worth the effort: with the line visible, most type errors can be fixed without
 * re-reading the file, which removes a whole round trip from the common case.
 */
function renderSourceExcerpt(lines: readonly string[], diagnostic: Diagnostic): string | undefined {
  const lineIndex = diagnostic.range.start.line
  const text = lines[lineIndex]
  if (text === undefined) return undefined

  const lineNumber = String(lineIndex + 1)
  const gutter = " ".repeat(lineNumber.length)

  // Tabs would misalign the caret; expand them consistently.
  const expanded = text.replace(/\t/g, "    ")
  const startColumn = expandColumn(text, diagnostic.range.start.character)
  const endColumn =
    diagnostic.range.end.line === lineIndex
      ? expandColumn(text, diagnostic.range.end.character)
      : expanded.length

  const width = Math.max(1, Math.min(endColumn - startColumn, 120))
  const caret = `${" ".repeat(Math.max(0, startColumn))}${"^".repeat(width)}`

  // Long lines are trimmed around the error so the caret stays visible.
  if (expanded.length > 160) {
    const from = Math.max(0, startColumn - 40)
    const slice = expanded.slice(from, from + 140)
    const caretSlice = `${" ".repeat(Math.max(0, startColumn - from))}${"^".repeat(width)}`
    return `  ${lineNumber} | ${from > 0 ? "\u2026" : ""}${slice}\n  ${gutter} | ${from > 0 ? " " : ""}${caretSlice}`
  }

  return `  ${lineNumber} | ${expanded}\n  ${gutter} | ${caret}`
}

/** Column position after tab expansion, so carets line up. */
function expandColumn(text: string, character: number): number {
  let column = 0
  for (let index = 0; index < character && index < text.length; index++) {
    column += text.charCodeAt(index) === 9 ? 4 : 1
  }
  return column
}

/** Collapses multi-line messages; Rust and TypeScript both emit them. */
function collapse(message: string): string {
  return message.replace(/\s*\n\s*/g, " ").trim()
}

function uriPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri
}

/* ------------------------------------------------------------------ */
/* Summaries                                                           */
/* ------------------------------------------------------------------ */

/**
 * Builds the text injected after an edit.
 *
 * The policy is what makes this useful rather than annoying:
 *  - Errors in edited files: always, with source excerpts. This is the point.
 *  - Warnings in edited files: yes, without excerpts. Often the same underlying
 *    problem as an error.
 *  - Errors in other files: yes, briefly. An edit that breaks a consumer of the
 *    changed module needs to be visible, and this catches it.
 *  - Anything else: no.
 */
export function buildEditFeedback(
  store: DiagnosticStore,
  editedPaths: readonly string[],
  cwd: string,
): string | undefined {
  const edited = new Set(editedPaths.map((path) => resolve(path)))
  const sections: string[] = []

  let errorTotal = 0
  let warningTotal = 0

  for (const path of edited) {
    const diagnostics = store.forFile(path)
    if (diagnostics.length === 0) continue

    const errors = diagnostics.filter((entry) => (entry.severity ?? 1) === Severity.error)
    const warnings = diagnostics.filter((entry) => (entry.severity ?? 1) === Severity.warning)
    errorTotal += errors.length
    warningTotal += warnings.length

    const rendered = renderFileDiagnostics(path, [...errors, ...warnings], {
      cwd,
      minSeverity: Severity.warning,
      showSource: errors.length > 0,
      maxPerFile: 12,
    })
    if (rendered) sections.push(rendered)
  }

  // Errors elsewhere: the file was fine, its consumers are not.
  const elsewhere: string[] = []
  for (const path of store.files()) {
    if (edited.has(path)) continue
    const errors = store.forFile(path).filter((entry) => (entry.severity ?? 1) === Severity.error)
    if (errors.length === 0) continue
    errorTotal += errors.length
    elsewhere.push(
      renderFileDiagnostics(path, errors.slice(0, 5), {
        cwd,
        minSeverity: Severity.error,
        showSource: false,
        maxPerFile: 5,
      }),
    )
    if (elsewhere.length >= 8) break
  }

  if (sections.length === 0 && elsewhere.length === 0) return undefined

  const header =
    errorTotal > 0
      ? `The language server reports ${errorTotal} error${errorTotal === 1 ? "" : "s"}${
          warningTotal > 0 ? ` and ${warningTotal} warning${warningTotal === 1 ? "" : "s"}` : ""
        } after your change:`
      : `The language server reports ${warningTotal} warning${warningTotal === 1 ? "" : "s"} after your change:`

  const parts = [header, "", ...sections]

  if (elsewhere.length > 0) {
    parts.push("", "Errors in other files that may be related to this change:", "", ...elsewhere)
  }

  if (errorTotal > 0) {
    parts.push(
      "",
      "Fix the errors before moving on. If an error is pre-existing and unrelated to your change, say so and leave it.",
    )
  }

  return parts.join("\n")
}

/**
 * One-line summary for the status bar.
 */
export function summarizeDiagnostics(store: DiagnosticStore): string | undefined {
  const counts = store.count()
  if (counts.errors === 0 && counts.warnings === 0) return undefined
  const parts: string[] = []
  if (counts.errors > 0) parts.push(`${counts.errors}E`)
  if (counts.warnings > 0) parts.push(`${counts.warnings}W`)
  return parts.join(" ")
}

/**
 * Groups diagnostics by their code, to spot a systematic problem.
 *
 * Thirty instances of the same error usually means one mistake repeated, not
 * thirty mistakes, and telling the model that changes how it fixes them.
 */
export function groupByCode(
  diagnostics: readonly Diagnostic[],
): Array<{ code: string; count: number; message: string }> {
  const groups = new Map<string, { count: number; message: string }>()

  for (const diagnostic of diagnostics) {
    const key = String(diagnostic.code ?? collapse(diagnostic.message).slice(0, 40))
    const existing = groups.get(key)
    if (existing) {
      existing.count++
    } else {
      groups.set(key, { count: 1, message: collapse(diagnostic.message) })
    }
  }

  return [...groups.entries()]
    .map(([code, value]) => ({ code, ...value }))
    .sort((left, right) => right.count - left.count)
}

/**
 * Whether a set of diagnostics indicates the file is fundamentally broken.
 *
 * A parse error means every other diagnostic in the file is unreliable, so the
 * right advice is "fix the syntax first" rather than "here are 40 errors".
 */
export function hasSyntaxError(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => {
    if ((diagnostic.severity ?? 1) !== Severity.error) return false
    const message = diagnostic.message.toLowerCase()
    return (
      message.includes("expected") ||
      message.includes("unexpected token") ||
      message.includes("unterminated") ||
      message.includes("syntax error") ||
      message.includes("unclosed") ||
      message.includes("declaration or statement expected")
    )
  })
}

let store: DiagnosticStore | undefined

/** Process-wide store; the registry writes to it and tools read from it. */
export function diagnosticStore(): DiagnosticStore {
  store ??= new DiagnosticStore()
  return store
}

export function resetDiagnosticStore(): void {
  store = new DiagnosticStore()
  log.debug("diagnostic store reset")
}
