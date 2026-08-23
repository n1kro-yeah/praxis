/**
 * The `diagnostics` and `symbols` tools.
 *
 * These expose the language server layer to the model directly, in addition to
 * the automatic post-edit feedback. Both are worth having as explicit tools:
 *
 *  - `diagnostics` lets the model check its work on demand, which is exactly what
 *    a competent engineer does before saying "done". It also lets it check a file
 *    it did not edit, to find out whether a failure is pre-existing.
 *  - `symbols` answers "where is this defined" and "what calls this" with the
 *    compiler's own index, which is both faster and dramatically more accurate
 *    than grep. Grep finds the string `handleAuth` in a comment; the language
 *    server finds the declaration.
 *
 * Both degrade silently and usefully when no language server is available: they
 * say so and suggest grep, rather than failing.
 */

import { existsSync } from "node:fs"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { s } from "../util/schema.js"
import { displayPath } from "../edit/apply.js"
import { suggestPattern } from "../permission/rules.js"
import {
  buildEditFeedback,
  diagnosticStore,
  groupByCode,
  hasSyntaxError,
  renderFileDiagnostics,
} from "../lsp/diagnostics.js"
import { lspRegistry } from "../lsp/registry.js"
import { SYMBOL_KINDS, Severity, type DocumentSymbol, type SymbolInformation } from "../lsp/client.js"
import { formatPosition, offsetToPosition, uriToPath, type Position } from "../lsp/jsonrpc.js"
import { defineTool, fail, ok, type ToolContext, type ToolResult } from "./types.js"

/* ------------------------------------------------------------------ */
/* diagnostics                                                         */
/* ------------------------------------------------------------------ */

const diagnosticsParameters = s.object({
  path: s
    .string()
    .optional()
    .describe("File to check. Omit to see every file with a current problem."),
  severity: s
    .enum(["error", "warning", "all"])
    .optional()
    .describe('Minimum severity to report. Defaults to "warning".'),
})

type DiagnosticsInput = { path?: string; severity?: "error" | "warning" | "all" }

const DIAGNOSTICS_DESCRIPTION = `Get compiler and linter errors from the language server.

This is the ground truth about whether the code compiles. Use it:
- After a non-trivial edit, to confirm you did not break anything. You usually get this automatically, but ask explicitly when you have made several changes.
- Before telling the user you are finished. "It compiles" is a claim you can actually verify.
- On a file you did not edit, to find out whether an error was already there. Distinguishing your bug from a pre-existing one saves a lot of wasted effort.

Omit path to see every file that currently has a problem, which is the fastest way to check the health of the whole project.

If no language server is available for the file, this says so rather than pretending the code is clean.`

export const diagnosticsTool = defineTool<DiagnosticsInput>({
  id: "diagnostics",
  action: "read",
  readOnly: true,
  concurrent: true,
  init: () => ({
    description: DIAGNOSTICS_DESCRIPTION,
    parameters: diagnosticsParameters as never,
    execute: async (input, context) => executeDiagnostics(input, context),
  }),
})

async function executeDiagnostics(
  input: DiagnosticsInput,
  context: ToolContext,
): Promise<ToolResult> {
  const registry = lspRegistry({ cwd: context.cwd })
  const store = diagnosticStore()

  const minSeverity =
    input.severity === "error"
      ? Severity.error
      : input.severity === "all"
        ? Severity.hint
        : Severity.warning

  /* Whole-project view. */
  if (!input.path) {
    const files = store.files()
    if (files.length === 0) {
      return ok(
        "no diagnostics",
        registry.enabled
          ? "No errors or warnings are currently reported. Note that only files opened during this session are analysed — to check a specific file, pass its path."
          : "The language server integration is disabled, so no diagnostics are available. Run the project's build or test command with bash to check for errors.",
        { files: 0 },
      )
    }

    const sections: string[] = []
    let total = 0

    for (const file of files.slice(0, 40)) {
      const rendered = renderFileDiagnostics(file, store.forFile(file), {
        cwd: context.cwd,
        minSeverity,
        showSource: false,
        maxPerFile: 8,
      })
      if (rendered === "") continue
      total += store.forFile(file).filter((entry) => (entry.severity ?? 1) <= minSeverity).length
      sections.push(rendered)
    }

    if (sections.length === 0) {
      return ok("no diagnostics at that severity", `Nothing at ${input.severity ?? "warning"} level or above.`, {
        files: 0,
      })
    }

    const counts = store.count()
    context.metadata({ errors: counts.errors, warnings: counts.warnings, files: sections.length })

    return ok(
      `${counts.errors} error${counts.errors === 1 ? "" : "s"}, ${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`,
      `${total} problem${total === 1 ? "" : "s"} across ${sections.length} file${sections.length === 1 ? "" : "s"}:\n\n${sections.join("\n\n")}`,
      { errors: counts.errors, warnings: counts.warnings },
    )
  }

  /* Single file. */
  const absolute = resolve(context.cwd, input.path)

  if (!existsSync(absolute)) {
    return fail("diagnostics", `${input.path} does not exist.`)
  }

  await context.requestPermission({
    action: "read",
    resource: absolute,
    title: `Check ${displayPath(absolute, context.cwd)} for errors`,
    pattern: suggestPattern("read", absolute, context.cwd),
  })

  if (!registry.enabled) {
    return ok(
      "language server disabled",
      "The language server integration is disabled. Run the project's type checker or linter with bash instead.",
      { available: false },
    )
  }

  if (!registry.handles(absolute)) {
    return ok(
      "no language server for this file type",
      `No language server handles ${displayPath(absolute, context.cwd)}. Nothing can be checked automatically for this file type.`,
      { available: false },
    )
  }

  const diagnostics = await registry.diagnostics(absolute, { timeoutMs: 6_000 })

  if (diagnostics.length === 0) {
    return ok(`${displayPath(absolute, context.cwd)}: clean`, "No errors or warnings.", { total: 0 })
  }

  const filtered = diagnostics.filter((entry) => (entry.severity ?? 1) <= minSeverity)
  if (filtered.length === 0) {
    return ok(
      `${displayPath(absolute, context.cwd)}: clean at that severity`,
      `No problems at ${input.severity ?? "warning"} level or above (${diagnostics.length} lower-severity item${diagnostics.length === 1 ? "" : "s"} suppressed).`,
      { total: 0 },
    )
  }

  const errors = filtered.filter((entry) => (entry.severity ?? 1) === Severity.error).length
  context.metadata({ errors, total: filtered.length })

  const body = renderFileDiagnostics(absolute, filtered, {
    cwd: context.cwd,
    minSeverity,
    showSource: true,
    maxPerFile: 25,
  })

  // A syntax error invalidates every other diagnostic in the file, so say so
  // rather than letting the model chase downstream phantoms.
  const advice: string[] = []
  if (hasSyntaxError(filtered)) {
    advice.push(
      "There is a syntax error. Fix it first — the other diagnostics in this file are unreliable until the file parses.",
    )
  } else {
    const groups = groupByCode(filtered).filter((group) => group.count >= 3)
    if (groups.length > 0) {
      advice.push(
        `${groups[0]!.count} problems share the same cause (${groups[0]!.code}). Fixing it once will likely resolve all of them.`,
      )
    }
  }

  return ok(
    `${displayPath(absolute, context.cwd)}: ${errors} error${errors === 1 ? "" : "s"}`,
    advice.length > 0 ? `${body}\n\n${advice.join("\n")}` : body,
    { errors, total: filtered.length },
  )
}

/* ------------------------------------------------------------------ */
/* symbols                                                             */
/* ------------------------------------------------------------------ */

const symbolsParameters = s.object({
  operation: s
    .enum(["outline", "search", "definition", "references", "hover"])
    .describe("What to look up."),
  path: s.string().optional().describe("File to operate on. Required for everything except search."),
  symbol: s
    .string()
    .optional()
    .describe("Symbol name. For search this is the query; for definition/references/hover it locates the symbol in the file."),
  line: s.number().optional().describe("One-based line number, as an alternative to symbol."),
  column: s.number().optional().describe("One-based column number, used with line."),
})

type SymbolsInput = {
  operation: "outline" | "search" | "definition" | "references" | "hover"
  path?: string
  symbol?: string
  line?: number
  column?: number
}

const SYMBOLS_DESCRIPTION = `Query the language server's symbol index.

This is semantic, not textual. It knows the difference between a declaration and a mention in a comment, and it follows imports and re-exports correctly. When it is available, prefer it over grep for these questions.

Operations:
- \`outline\`: every top-level symbol in a file, with line numbers. The cheapest way to understand a large file — far cheaper than reading it.
- \`search\`: find a symbol by name anywhere in the project. Use this when you know what something is called but not where it lives.
- \`definition\`: jump to where a symbol is declared. Give the symbol name and the file where you saw it used.
- \`references\`: find every use of a symbol. Essential before renaming or changing a signature — this is how you find out what you are about to break.
- \`hover\`: the type signature and documentation of a symbol. Faster than reading the file it is declared in.

Identify the symbol either by name (the first occurrence in the file is used) or by line and column.

If no language server is running for the language, this reports that and you should fall back to grep.`

export const symbolsTool = defineTool<SymbolsInput>({
  id: "symbols",
  action: "read",
  readOnly: true,
  concurrent: true,
  init: () => ({
    description: SYMBOLS_DESCRIPTION,
    parameters: symbolsParameters as never,
    execute: async (input, context) => executeSymbols(input, context),
  }),
})

async function executeSymbols(input: SymbolsInput, context: ToolContext): Promise<ToolResult> {
  const registry = lspRegistry({ cwd: context.cwd })

  if (!registry.enabled) {
    return ok(
      "language server disabled",
      "Symbol lookup needs a language server, which is disabled. Use grep instead.",
      { available: false },
    )
  }

  /* Workspace-wide search needs no file. */
  if (input.operation === "search") {
    const query = input.symbol?.trim() ?? ""
    if (query === "") return fail("symbols", "A symbol name is required for search.")

    const results = await registry.workspaceSymbols(query)
    const flat = results.flatMap((entry) => entry.symbols as SymbolInformation[])

    if (flat.length === 0) {
      return ok(
        `no symbol named ${query}`,
        `The language server index has no symbol matching "${query}". Either it is not indexed yet, or it does not exist — confirm with grep.`,
        { results: 0 },
      )
    }

    const lines = flat.slice(0, 40).map((symbol) => {
      const path = displayPath(uriToPath(symbol.location.uri), context.cwd)
      const kind = SYMBOL_KINDS[symbol.kind] ?? "symbol"
      const container = symbol.containerName ? ` in ${symbol.containerName}` : ""
      return `${path}:${formatPosition(symbol.location.range.start)}  ${kind} ${symbol.name}${container}`
    })

    context.metadata({ results: flat.length })

    return ok(
      `${flat.length} symbol${flat.length === 1 ? "" : "s"} matching ${query}`,
      lines.join("\n") + (flat.length > lines.length ? `\n... and ${flat.length - lines.length} more` : ""),
      { results: flat.length },
    )
  }

  if (!input.path) {
    return fail("symbols", `The ${input.operation} operation needs a path.`)
  }

  const absolute = resolve(context.cwd, input.path)
  if (!existsSync(absolute)) {
    return fail("symbols", `${input.path} does not exist.`)
  }

  await context.requestPermission({
    action: "read",
    resource: absolute,
    title: `Look up symbols in ${displayPath(absolute, context.cwd)}`,
    pattern: suggestPattern("read", absolute, context.cwd),
  })

  const client = await registry.clientFor(absolute)
  if (!client) {
    return ok(
      "no language server",
      `No language server is available for ${displayPath(absolute, context.cwd)}. Use grep to search textually instead.`,
      { available: false },
    )
  }

  /* Outline. */
  if (input.operation === "outline") {
    const symbols = await client.documentSymbols(absolute)
    if (symbols.length === 0) {
      return ok(
        "no symbols",
        `The language server found no symbols in ${displayPath(absolute, context.cwd)}. It may still be indexing.`,
        { symbols: 0 },
      )
    }

    const rendered = renderOutline(symbols)
    context.metadata({ symbols: countSymbols(symbols) })

    return ok(
      `${displayPath(absolute, context.cwd)} outline`,
      rendered,
      { symbols: countSymbols(symbols) },
    )
  }

  /* Position-based operations. */
  const position = await locate(absolute, input)
  if (!position) {
    return fail(
      "symbols",
      input.symbol
        ? `Could not find "${input.symbol}" in ${displayPath(absolute, context.cwd)}. Check the spelling, or pass line and column instead.`
        : "Provide either symbol, or line and column.",
    )
  }

  switch (input.operation) {
    case "hover": {
      const hover = await client.hover(absolute, position)
      if (!hover) {
        return ok(
          "no hover information",
          `The language server has nothing to say about that position in ${displayPath(absolute, context.cwd)}.`,
        )
      }
      return ok(input.symbol ?? formatPosition(position), hover, {})
    }

    case "definition": {
      const locations = await client.definition(absolute, position)
      if (locations.length === 0) {
        // Type definition is a useful fallback: for a variable, "definition"
        // lands on the declaration but "type definition" lands on the interface,
        // which is usually what the model actually wanted.
        const typeLocations = await client.typeDefinition(absolute, position)
        if (typeLocations.length === 0) {
          return ok(
            "no definition found",
            `The language server could not resolve a definition. The symbol may come from an untyped dependency — try grep.`,
          )
        }
        return ok(
          `${typeLocations.length} type definition${typeLocations.length === 1 ? "" : "s"}`,
          renderLocations(typeLocations, context.cwd),
          { results: typeLocations.length },
        )
      }
      context.metadata({ results: locations.length })
      return ok(
        `${locations.length} definition${locations.length === 1 ? "" : "s"}`,
        renderLocations(locations, context.cwd),
        { results: locations.length },
      )
    }

    case "references": {
      const locations = await client.references(absolute, position, true)
      if (locations.length === 0) {
        return ok(
          "no references found",
          "The language server found no references. If the symbol is exported and used by another package, the index may not cover it — confirm with grep.",
        )
      }
      context.metadata({ results: locations.length })

      // Grouping by file matters here: forty references across four files is a
      // very different change from forty across forty.
      const byFile = new Map<string, number[]>()
      for (const location of locations) {
        const path = displayPath(uriToPath(location.uri), context.cwd)
        const list = byFile.get(path) ?? []
        list.push(location.range.start.line + 1)
        byFile.set(path, list)
      }

      const lines = [...byFile.entries()]
        .sort((left, right) => right[1].length - left[1].length)
        .slice(0, 40)
        .map(([path, occurrences]) => `${path}  (${occurrences.length}): lines ${occurrences.slice(0, 20).join(", ")}`)

      return ok(
        `${locations.length} reference${locations.length === 1 ? "" : "s"} in ${byFile.size} file${byFile.size === 1 ? "" : "s"}`,
        lines.join("\n"),
        { results: locations.length, files: byFile.size },
      )
    }

    default:
      return fail("symbols", `Unknown operation ${String(input.operation)}.`)
  }
}

/**
 * Resolves a symbol name or a line/column pair into an LSP position.
 *
 * Name resolution deliberately prefers a declaration-looking occurrence over the
 * first textual one: asking for the definition of `foo` and getting the position
 * of a call site produces a correct but useless answer (it resolves to itself).
 */
async function locate(path: string, input: SymbolsInput): Promise<Position | undefined> {
  if (input.line !== undefined) {
    return { line: Math.max(0, input.line - 1), character: Math.max(0, (input.column ?? 1) - 1) }
  }

  if (!input.symbol) return undefined

  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return undefined
  }

  const escaped = input.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  // Try declaration-shaped occurrences first.
  const declaration = new RegExp(
    `\\b(?:function|class|interface|type|const|let|var|def|fn|struct|enum|trait|impl|func|public|private|protected|export)\\s+(?:[\\w<>\\[\\]]+\\s+)*?(${escaped})\\b`,
  )
  const declarationMatch = declaration.exec(content)
  if (declarationMatch) {
    const index = declarationMatch.index + declarationMatch[0].lastIndexOf(input.symbol)
    return offsetToPosition(content, index)
  }

  const plain = new RegExp(`\\b${escaped}\\b`)
  const plainMatch = plain.exec(content)
  if (plainMatch) return offsetToPosition(content, plainMatch.index)

  return undefined
}

function renderLocations(
  locations: ReadonlyArray<{ uri: string; range: { start: Position } }>,
  cwd: string,
): string {
  return locations
    .slice(0, 20)
    .map((location) => {
      const path = uriToPath(location.uri)
      const display = `${displayPath(path, cwd)}:${formatPosition(location.range.start)}`
      const excerpt = excerptLine(path, location.range.start.line)
      return excerpt ? `${display}\n    ${excerpt}` : display
    })
    .join("\n")
}

/** Reads one line, to give a definition result some context. */
function excerptLine(path: string, line: number): string | undefined {
  try {
    const lines = readFileSync(path, "utf8").split("\n")
    return lines[line]?.trim().slice(0, 200)
  } catch {
    return undefined
  }
}

/**
 * Renders a symbol outline as an indented tree.
 *
 * Handles both response shapes: hierarchical `DocumentSymbol[]` from modern
 * servers and flat `SymbolInformation[]` from older ones.
 */
function renderOutline(symbols: DocumentSymbol[] | SymbolInformation[]): string {
  if (symbols.length === 0) return ""

  // Flat shape.
  if ("location" in symbols[0]!) {
    return (symbols as SymbolInformation[])
      .slice(0, 300)
      .map((symbol) => {
        const kind = SYMBOL_KINDS[symbol.kind] ?? "symbol"
        const indent = symbol.containerName ? "  " : ""
        return `${indent}${String(symbol.location.range.start.line + 1).padStart(5)}  ${kind} ${symbol.name}`
      })
      .join("\n")
  }

  const lines: string[] = []

  const walk = (list: readonly DocumentSymbol[], depth: number): void => {
    for (const symbol of list) {
      if (lines.length >= 400) return
      const kind = SYMBOL_KINDS[symbol.kind] ?? "symbol"
      const detail = symbol.detail ? ` ${symbol.detail.slice(0, 100)}` : ""
      lines.push(
        `${String(symbol.range.start.line + 1).padStart(5)}  ${"  ".repeat(depth)}${kind} ${symbol.name}${detail}`,
      )
      if (symbol.children && symbol.children.length > 0 && depth < 4) {
        walk(symbol.children, depth + 1)
      }
    }
  }

  walk(symbols as DocumentSymbol[], 0)
  return lines.join("\n")
}

function countSymbols(symbols: DocumentSymbol[] | SymbolInformation[]): number {
  let count = 0
  const walk = (list: readonly unknown[]): void => {
    for (const entry of list) {
      count++
      const children = (entry as DocumentSymbol).children
      if (children) walk(children)
    }
  }
  walk(symbols)
  return count
}

/* ------------------------------------------------------------------ */
/* Post-edit hook                                                      */
/* ------------------------------------------------------------------ */

/**
 * Produces the diagnostics reminder shown after an edit.
 *
 * Called by the session loop rather than by a tool, and bounded aggressively:
 * a slow language server must never make an edit feel slow, so the timeout is
 * short and an empty result is a perfectly acceptable outcome.
 */
export async function diagnosticsAfterEdit(
  paths: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  const registry = lspRegistry({ cwd })
  if (!registry.enabled) return undefined

  const relevant = paths.filter((path) => registry.handles(path))
  if (relevant.length === 0) return undefined

  await registry.diagnosticsForAll(relevant, { timeoutMs: 4_000 })
  return buildEditFeedback(diagnosticStore(), relevant, cwd)
}
