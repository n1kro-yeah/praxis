/**
 * String replacement strategies for the `edit` tool.
 *
 * The hard problem in agentic editing is that models reproduce the text they
 * want to replace *approximately*. They normalise tabs to spaces, drop a
 * trailing comma, re-indent a block, unescape a quote, or paraphrase whitespace
 * inside a JSX attribute. A naive `indexOf` fails on all of these, and every
 * failure costs a round trip and often derails the whole task.
 *
 * The answer is a ladder of replacers, from exact to increasingly forgiving.
 * Each one is tried in order and the first that produces exactly one
 * unambiguous match wins. Ordering is the entire safety argument: a looser
 * strategy is only ever consulted when every stricter one has failed, so a
 * fuzzy match can never override an exact one.
 *
 * Every replacer is a generator. Yielding candidates lazily rather than
 * returning the first one lets the caller enforce the uniqueness rule ("if a
 * strategy finds two matches, that strategy is ambiguous and we move on")
 * without each strategy having to implement it.
 */

import { levenshtein } from "../util/string.js"

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface Candidate {
  /** Character offset where the match begins. */
  readonly index: number
  /** Exact substring of the original content that will be replaced. */
  readonly text: string
  /** 0..1, where 1 is an exact match. Used for reporting, not for selection. */
  readonly confidence: number
}

export type Replacer = (content: string, search: string) => Generator<Candidate>

export interface NamedReplacer {
  readonly name: string
  readonly replace: Replacer
  /** Human-readable note used in error messages when this strategy matched. */
  readonly note?: string
}

/* ------------------------------------------------------------------ */
/* 1. Simple                                                           */
/* ------------------------------------------------------------------ */

/**
 * Exact substring match.
 *
 * Handles the overwhelming majority of edits. Everything below exists for the
 * cases where this fails.
 */
export function* simpleReplacer(content: string, search: string): Generator<Candidate> {
  if (search === "") return
  let index = content.indexOf(search)
  while (index !== -1) {
    yield { index, text: search, confidence: 1 }
    index = content.indexOf(search, index + 1)
  }
}

/* ------------------------------------------------------------------ */
/* 2. Line-trimmed                                                     */
/* ------------------------------------------------------------------ */

/**
 * Matches line by line, ignoring leading and trailing whitespace on each line.
 *
 * The single most valuable fallback. Models routinely reproduce a block with
 * different indentation than the file (especially after they have mentally
 * re-indented it), and trailing whitespace differences are invisible in their
 * context. The match still has to align on line boundaries, so this is
 * structurally safe.
 */
export function* lineTrimmedReplacer(content: string, search: string): Generator<Candidate> {
  if (search.trim() === "") return

  const contentLines = content.split("\n")
  const searchLines = trimTrailingEmpty(search.split("\n"))
  if (searchLines.length === 0) return

  const offsets = lineOffsets(contentLines)

  for (let start = 0; start <= contentLines.length - searchLines.length; start++) {
    let matches = true
    for (let offset = 0; offset < searchLines.length; offset++) {
      if (contentLines[start + offset]!.trim() !== searchLines[offset]!.trim()) {
        matches = false
        break
      }
    }
    if (!matches) continue

    const beginIndex = offsets[start]!
    const lastLine = start + searchLines.length - 1
    const endIndex = offsets[lastLine]! + contentLines[lastLine]!.length
    yield {
      index: beginIndex,
      text: content.slice(beginIndex, endIndex),
      confidence: 0.95,
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Block anchor                                                     */
/* ------------------------------------------------------------------ */

/**
 * Anchors on the first and last lines of the search block and tolerates drift
 * in the middle, verified by similarity.
 *
 * This is what rescues edits to long functions. A model asked to change one
 * line inside a forty-line function will often reproduce the whole function
 * with a comment reworded or a blank line moved. The braces and the signature —
 * the anchors — are almost always exact.
 *
 * Requires at least three lines, because with two lines the "anchors" are the
 * entire block and there is nothing left to verify.
 */
export function* blockAnchorReplacer(content: string, search: string): Generator<Candidate> {
  const contentLines = content.split("\n")
  const searchLines = trimTrailingEmpty(search.split("\n"))
  if (searchLines.length < 3) return

  const firstAnchor = searchLines[0]!.trim()
  const lastAnchor = searchLines[searchLines.length - 1]!.trim()
  if (firstAnchor === "" || lastAnchor === "") return

  const offsets = lineOffsets(contentLines)
  const expectedSize = searchLines.length
  const results: Candidate[] = []

  for (let start = 0; start < contentLines.length; start++) {
    if (contentLines[start]!.trim() !== firstAnchor) continue

    // Search for the closing anchor within a window proportional to the block
    // size. An unbounded search would happily match a closing brace hundreds of
    // lines away and replace half the file.
    const maxDrift = Math.max(6, Math.floor(expectedSize * 0.5))
    const lowerBound = Math.max(start + 2, start + expectedSize - maxDrift)
    const upperBound = Math.min(contentLines.length - 1, start + expectedSize + maxDrift)

    for (let end = lowerBound; end <= upperBound; end++) {
      if (contentLines[end]!.trim() !== lastAnchor) continue

      const beginIndex = offsets[start]!
      const endIndex = offsets[end]! + contentLines[end]!.length
      const actual = content.slice(beginIndex, endIndex)

      // Verify the interior actually resembles what the model sent. Without
      // this, two identical `}` anchors would match unrelated blocks.
      const similarity = blockSimilarity(searchLines, contentLines.slice(start, end + 1))
      if (similarity < 0.6) continue

      results.push({ index: beginIndex, text: actual, confidence: 0.5 + similarity * 0.4 })
      break
    }
  }

  // Yield the best candidate first so an unambiguous winner emerges when two
  // regions share anchors but one is a much better interior match.
  results.sort((left, right) => right.confidence - left.confidence)
  if (results.length > 1 && results[0]!.confidence - results[1]!.confidence > 0.15) {
    yield results[0]!
    return
  }
  for (const candidate of results) yield candidate
}

function blockSimilarity(searchLines: readonly string[], actualLines: readonly string[]): number {
  const searchInner = searchLines.slice(1, -1).map((line) => line.trim()).filter((line) => line !== "")
  const actualInner = actualLines.slice(1, -1).map((line) => line.trim()).filter((line) => line !== "")
  if (searchInner.length === 0 && actualInner.length === 0) return 1
  if (searchInner.length === 0 || actualInner.length === 0) return 0.5

  // Line-level alignment: for each search line, find its best match nearby.
  let total = 0
  for (let index = 0; index < searchInner.length; index++) {
    const target = searchInner[index]!
    const window = actualInner.slice(Math.max(0, index - 3), index + 4)
    let best = 0
    for (const candidate of window) {
      const distance = levenshtein(target, candidate)
      const score = 1 - distance / Math.max(target.length, candidate.length, 1)
      if (score > best) best = score
    }
    total += best
  }
  const forward = total / searchInner.length
  const lengthPenalty =
    1 - Math.abs(searchInner.length - actualInner.length) / Math.max(searchInner.length, actualInner.length)
  return forward * 0.75 + Math.max(0, lengthPenalty) * 0.25
}

/* ------------------------------------------------------------------ */
/* 4. Whitespace-normalised                                            */
/* ------------------------------------------------------------------ */

/**
 * Collapses every whitespace run to a single space before comparing.
 *
 * Catches tab/space mixtures, doubled spaces inside expressions, and line
 * breaks the model inserted or removed inside a long expression. Because it
 * ignores line structure entirely it is riskier than the line-trimmed replacer,
 * hence its lower position.
 */
export function* whitespaceNormalizedReplacer(content: string, search: string): Generator<Candidate> {
  const normalizedSearch = normalizeWhitespace(search)
  if (normalizedSearch === "") return

  const map = buildNormalizedMap(content)
  let cursor = 0
  while (cursor <= map.normalized.length - normalizedSearch.length) {
    const found = map.normalized.indexOf(normalizedSearch, cursor)
    if (found === -1) break
    const startIndex = map.indices[found]!
    const endNormalized = found + normalizedSearch.length - 1
    const endIndex = map.indices[endNormalized]! + 1
    yield {
      index: startIndex,
      text: content.slice(startIndex, endIndex),
      confidence: 0.85,
    }
    cursor = found + 1
  }
}

interface NormalizedMap {
  readonly normalized: string
  /** For each normalised character, its index in the original content. */
  readonly indices: number[]
}

/**
 * Builds a normalised projection of the content along with an index map back to
 * the original. The map is what makes it possible to report the exact original
 * substring, which is required so the replacement preserves the file's real
 * whitespace outside the edited region.
 */
function buildNormalizedMap(content: string): NormalizedMap {
  let normalized = ""
  const indices: number[] = []
  let inWhitespace = false

  for (let index = 0; index < content.length; index++) {
    const char = content[index]!
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (inWhitespace) continue
      inWhitespace = true
      normalized += " "
      indices.push(index)
      continue
    }
    inWhitespace = false
    normalized += char
    indices.push(index)
  }

  return { normalized, indices }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/[\s]+/g, " ").trim()
}

/* ------------------------------------------------------------------ */
/* 5. Indentation-flexible                                             */
/* ------------------------------------------------------------------ */

/**
 * Matches when the block differs only by a uniform indentation shift.
 *
 * Distinct from the line-trimmed replacer: this one *requires* the relative
 * indentation inside the block to be preserved, only allowing the whole block to
 * sit at a different depth. That makes it safe for Python and YAML, where the
 * line-trimmed replacer would happily match a block at the wrong nesting level.
 */
export function* indentationFlexibleReplacer(content: string, search: string): Generator<Candidate> {
  const searchLines = trimTrailingEmpty(search.split("\n"))
  if (searchLines.length === 0) return

  const searchBase = commonIndent(searchLines)
  const stripped = searchLines.map((line) => (line.trim() === "" ? "" : line.slice(searchBase.length)))

  const contentLines = content.split("\n")
  const offsets = lineOffsets(contentLines)

  for (let start = 0; start <= contentLines.length - stripped.length; start++) {
    const window = contentLines.slice(start, start + stripped.length)
    const windowBase = commonIndent(window)
    let matches = true
    for (let offset = 0; offset < stripped.length; offset++) {
      const line = window[offset]!
      const expected = stripped[offset]!
      if (expected === "") {
        if (line.trim() !== "") {
          matches = false
          break
        }
        continue
      }
      if (!line.startsWith(windowBase)) {
        matches = false
        break
      }
      if (line.slice(windowBase.length) !== expected) {
        matches = false
        break
      }
    }
    if (!matches) continue

    const beginIndex = offsets[start]!
    const lastLine = start + stripped.length - 1
    const endIndex = offsets[lastLine]! + contentLines[lastLine]!.length
    yield {
      index: beginIndex,
      text: content.slice(beginIndex, endIndex),
      confidence: 0.9,
    }
  }
}

function commonIndent(lines: readonly string[]): string {
  let indent: string | undefined
  for (const line of lines) {
    if (line.trim() === "") continue
    const match = /^[ \t]*/.exec(line)
    const current = match ? match[0] : ""
    if (indent === undefined) {
      indent = current
      continue
    }
    let shared = 0
    while (shared < indent.length && shared < current.length && indent[shared] === current[shared]) shared++
    indent = indent.slice(0, shared)
  }
  return indent ?? ""
}

/* ------------------------------------------------------------------ */
/* 6. Escape-normalised                                               */
/* ------------------------------------------------------------------ */

/**
 * Compares after resolving escape sequences and unifying quote characters.
 *
 * Models pass edit strings through JSON, and the round trip mangles escapes:
 * `\\n` becomes a real newline, `\\t` becomes a tab, `\\\\` collapses, and
 * smart quotes appear from nowhere. This replacer sees through all of that.
 */
export function* escapeNormalizedReplacer(content: string, search: string): Generator<Candidate> {
  const normalizedSearch = normalizeEscapes(search)
  if (normalizedSearch.trim() === "") return
  if (normalizedSearch === search) {
    // Nothing to gain over the simple replacer; also try the reverse direction,
    // where the *file* contains literal escapes and the model sent real ones.
    const literalised = literaliseEscapes(search)
    if (literalised === search) return
    yield* simpleReplacer(content, literalised)
    return
  }

  const map = buildEscapeMap(content)
  let cursor = 0
  while (true) {
    const found = map.normalized.indexOf(normalizedSearch, cursor)
    if (found === -1) break
    const startIndex = map.indices[found]!
    const endNormalized = found + normalizedSearch.length - 1
    const endIndex = (map.indices[endNormalized] ?? startIndex) + (map.widths[endNormalized] ?? 1)
    yield {
      index: startIndex,
      text: content.slice(startIndex, endIndex),
      confidence: 0.8,
    }
    cursor = found + 1
  }
}

interface EscapeMap {
  readonly normalized: string
  readonly indices: number[]
  /** Original width of each normalised character (2 for a resolved escape). */
  readonly widths: number[]
}

function buildEscapeMap(content: string): EscapeMap {
  let normalized = ""
  const indices: number[] = []
  const widths: number[] = []

  for (let index = 0; index < content.length; index++) {
    const char = content[index]!
    if (char === "\\" && index + 1 < content.length) {
      const next = content[index + 1]!
      const resolved = ESCAPES[next]
      if (resolved !== undefined) {
        normalized += resolved
        indices.push(index)
        widths.push(2)
        index++
        continue
      }
    }
    normalized += unifyQuote(char)
    indices.push(index)
    widths.push(1)
  }

  return { normalized, indices, widths }
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  "'": "'",
  '"': '"',
  "`": "`",
  "\\": "\\",
  "/": "/",
}

function normalizeEscapes(text: string): string {
  let result = ""
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === "\\" && index + 1 < text.length) {
      const resolved = ESCAPES[text[index + 1]!]
      if (resolved !== undefined) {
        result += resolved
        index++
        continue
      }
    }
    result += unifyQuote(char)
  }
  return result
}

function literaliseEscapes(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
}

/** Folds typographic quotes onto their ASCII equivalents. */
function unifyQuote(char: string): string {
  switch (char) {
    case "\u2018":
    case "\u2019":
    case "\u201B":
      return "'"
    case "\u201C":
    case "\u201D":
    case "\u201F":
      return '"'
    case "\u2013":
    case "\u2014":
      return "-"
    case "\u00A0":
      return " "
    default:
      return char
  }
}

/* ------------------------------------------------------------------ */
/* 7. Trimmed boundary                                                 */
/* ------------------------------------------------------------------ */

/**
 * Retries with leading and trailing whitespace stripped from the search string.
 *
 * Models frequently include a leading newline (from a markdown fence) or a
 * trailing one. Trimming the boundary while keeping the interior byte-exact is a
 * very low-risk transformation, but it is placed after the structural replacers
 * because those preserve more information about intent.
 */
export function* trimmedBoundaryReplacer(content: string, search: string): Generator<Candidate> {
  const trimmed = search.trim()
  if (trimmed === "" || trimmed === search) return
  yield* mapConfidence(simpleReplacer(content, trimmed), 0.9)

  // Also try preserving the interior but dropping only the newlines.
  const stripped = search.replace(/^\n+/, "").replace(/\n+$/, "")
  if (stripped !== trimmed && stripped !== search) {
    yield* mapConfidence(simpleReplacer(content, stripped), 0.88)
  }
}

/* ------------------------------------------------------------------ */
/* 8. Context-aware                                                    */
/* ------------------------------------------------------------------ */

/**
 * Uses the first and last *non-empty* lines as context and requires every
 * interior line of the search block to appear, in order, within the candidate
 * region.
 *
 * This handles the case where a model omits lines it considers irrelevant —
 * comments, logging, blank lines — from the middle of a block. The subsequence
 * requirement keeps it honest: the lines it did send must all be present and in
 * the right order.
 */
export function* contextAwareReplacer(content: string, search: string): Generator<Candidate> {
  const searchLines = trimTrailingEmpty(search.split("\n")).filter((line) => line.trim() !== "")
  if (searchLines.length < 2) return

  const contentLines = content.split("\n")
  const offsets = lineOffsets(contentLines)
  const first = searchLines[0]!.trim()
  const last = searchLines[searchLines.length - 1]!.trim()

  for (let start = 0; start < contentLines.length; start++) {
    if (contentLines[start]!.trim() !== first) continue

    const limit = Math.min(contentLines.length, start + searchLines.length * 3 + 10)
    for (let end = start + 1; end < limit; end++) {
      if (contentLines[end]!.trim() !== last) continue

      const region = contentLines.slice(start, end + 1).map((line) => line.trim())
      if (!isSubsequence(searchLines.map((line) => line.trim()), region)) continue

      // Reject regions that are mostly unrelated content.
      const coverage = searchLines.length / region.filter((line) => line !== "").length
      if (coverage < 0.5) continue

      const beginIndex = offsets[start]!
      const endIndex = offsets[end]! + contentLines[end]!.length
      yield {
        index: beginIndex,
        text: content.slice(beginIndex, endIndex),
        confidence: 0.6 + coverage * 0.2,
      }
      break
    }
  }
}

function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let cursor = 0
  for (const line of haystack) {
    if (cursor < needle.length && line === needle[cursor]) cursor++
  }
  return cursor === needle.length
}

/* ------------------------------------------------------------------ */
/* 9. Multi-occurrence                                                 */
/* ------------------------------------------------------------------ */

/**
 * Yields every exact occurrence, for callers that explicitly asked to replace
 * all of them.
 *
 * Kept as a separate strategy rather than a flag on `simpleReplacer` so that the
 * ladder's uniqueness rule stays intact: the loose strategies must never be
 * reachable when the caller wants a single replacement.
 */
export function* multiOccurrenceReplacer(content: string, search: string): Generator<Candidate> {
  yield* simpleReplacer(content, search)
}

/* ------------------------------------------------------------------ */
/* 10. Fuzzy line (last resort)                                        */
/* ------------------------------------------------------------------ */

/**
 * Similarity search over sliding windows of lines.
 *
 * The only strategy that can match text the model did not reproduce faithfully
 * anywhere. It demands a high similarity threshold and a clear margin over the
 * runner-up, because a wrong match here silently corrupts a file. It exists
 * because the alternative — failing the edit — costs the model a round trip and
 * it will usually retry with an even worse approximation.
 */
export function* fuzzyLineReplacer(content: string, search: string): Generator<Candidate> {
  const searchLines = trimTrailingEmpty(search.split("\n"))
  if (searchLines.length === 0) return
  const searchText = searchLines.map((line) => line.trim()).join("\n")
  if (searchText.length < 12) return

  const contentLines = content.split("\n")
  const offsets = lineOffsets(contentLines)
  const size = searchLines.length
  const scored: Array<Candidate & { score: number }> = []

  // Allow the window to be a little larger or smaller than the search block.
  for (let windowSize = Math.max(1, size - 2); windowSize <= size + 2; windowSize++) {
    for (let start = 0; start + windowSize <= contentLines.length; start++) {
      const window = contentLines.slice(start, start + windowSize)
      const windowText = window.map((line) => line.trim()).join("\n")
      if (Math.abs(windowText.length - searchText.length) > searchText.length * 0.4) continue

      const distance = levenshtein(searchText, windowText)
      const score = 1 - distance / Math.max(searchText.length, windowText.length, 1)
      if (score < 0.85) continue

      const beginIndex = offsets[start]!
      const lastLine = start + windowSize - 1
      const endIndex = offsets[lastLine]! + contentLines[lastLine]!.length
      scored.push({
        index: beginIndex,
        text: content.slice(beginIndex, endIndex),
        confidence: score * 0.7,
        score,
      })
    }
  }

  if (scored.length === 0) return
  scored.sort((left, right) => right.score - left.score)

  // Overlapping windows around the same region are the same match; deduplicate
  // by keeping the best window per starting neighbourhood.
  const deduped: Array<Candidate & { score: number }> = []
  for (const candidate of scored) {
    if (deduped.some((existing) => Math.abs(existing.index - candidate.index) < 40)) continue
    deduped.push(candidate)
  }

  // Require a decisive winner. Two similar regions mean we cannot tell which one
  // the model meant, and guessing is worse than failing.
  if (deduped.length > 1 && deduped[0]!.score - deduped[1]!.score < 0.05) return
  yield { index: deduped[0]!.index, text: deduped[0]!.text, confidence: deduped[0]!.confidence }
}

/* ------------------------------------------------------------------ */
/* Ladder                                                              */
/* ------------------------------------------------------------------ */

/**
 * The ordered ladder. Strictest first; never reorder without understanding that
 * the ordering *is* the correctness argument.
 */
export const REPLACERS: readonly NamedReplacer[] = [
  { name: "simple", replace: simpleReplacer },
  {
    name: "line-trimmed",
    replace: lineTrimmedReplacer,
    note: "matched ignoring leading and trailing whitespace on each line",
  },
  {
    name: "block-anchor",
    replace: blockAnchorReplacer,
    note: "matched on the first and last lines of the block",
  },
  {
    name: "whitespace-normalized",
    replace: whitespaceNormalizedReplacer,
    note: "matched after collapsing whitespace",
  },
  {
    name: "indentation-flexible",
    replace: indentationFlexibleReplacer,
    note: "matched at a different indentation level",
  },
  {
    name: "escape-normalized",
    replace: escapeNormalizedReplacer,
    note: "matched after resolving escape sequences",
  },
  {
    name: "trimmed-boundary",
    replace: trimmedBoundaryReplacer,
    note: "matched after trimming the boundaries of the search text",
  },
  {
    name: "context-aware",
    replace: contextAwareReplacer,
    note: "matched using the surrounding context lines",
  },
  {
    name: "fuzzy-line",
    replace: fuzzyLineReplacer,
    note: "matched approximately; verify the result",
  },
]

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

export interface ReplaceResult {
  readonly content: string
  readonly strategy: string
  readonly note?: string
  readonly replacements: number
  readonly confidence: number
  /** Character offset of the first replacement, for cursor positioning. */
  readonly index: number
}

export class ReplaceError extends Error {
  readonly kind: "not-found" | "ambiguous" | "no-op"
  readonly attempts: ReadonlyArray<{ strategy: string; matches: number }>

  constructor(
    kind: "not-found" | "ambiguous" | "no-op",
    message: string,
    attempts: ReadonlyArray<{ strategy: string; matches: number }> = [],
  ) {
    super(message)
    this.name = "ReplaceError"
    this.kind = kind
    this.attempts = attempts
  }
}

export interface ReplaceOptions {
  /** Replace every occurrence instead of requiring exactly one. */
  readonly replaceAll?: boolean
  /** Stop after this strategy; used to disable fuzzy matching. */
  readonly maxStrategy?: string
}

/**
 * Runs the ladder and applies the winning replacement.
 *
 * The uniqueness rule is enforced here rather than in each strategy: a strategy
 * that yields two candidates is ambiguous *for this input* and we continue to
 * the next one, which may well disambiguate. Only if every strategy is either
 * empty or ambiguous do we fail — and then the error says which, because
 * "ambiguous" and "not found" require completely different fixes from the model.
 */
export function replace(
  content: string,
  search: string,
  replacement: string,
  options: ReplaceOptions = {},
): ReplaceResult {
  if (search === replacement) {
    throw new ReplaceError("no-op", "The search text and the replacement are identical; nothing to do.")
  }

  // Inserting into an empty file is a legitimate operation.
  if (search === "") {
    if (content !== "") {
      throw new ReplaceError(
        "ambiguous",
        "An empty search string is only allowed when the file is empty. Provide the exact text to replace.",
      )
    }
    return {
      content: replacement,
      strategy: "insert",
      replacements: 1,
      confidence: 1,
      index: 0,
    }
  }

  const attempts: Array<{ strategy: string; matches: number }> = []
  let ambiguous = false
  let limit = REPLACERS.length
  if (options.maxStrategy) {
    const found = REPLACERS.findIndex((entry) => entry.name === options.maxStrategy)
    if (found >= 0) limit = found + 1
  }

  for (let position = 0; position < limit; position++) {
    const replacer = REPLACERS[position]!
    const candidates = [...replacer.replace(content, search)]
    attempts.push({ strategy: replacer.name, matches: candidates.length })
    if (candidates.length === 0) continue

    if (options.replaceAll) {
      // Only exact strategies may replace everything. A fuzzy multi-replace is
      // an excellent way to destroy a file.
      if (position > 1) continue
      const applied = applyAll(content, candidates, replacement)
      return {
        content: applied.content,
        strategy: replacer.name,
        note: replacer.note,
        replacements: applied.count,
        confidence: candidates[0]!.confidence,
        index: candidates[0]!.index,
      }
    }

    if (candidates.length > 1) {
      // Identical candidate text at different offsets is genuinely ambiguous;
      // remember that and try a stricter-structured strategy below.
      ambiguous = true
      continue
    }

    const candidate = candidates[0]!
    return {
      content:
        content.slice(0, candidate.index) +
        replacement +
        content.slice(candidate.index + candidate.text.length),
      strategy: replacer.name,
      note: replacer.note,
      replacements: 1,
      confidence: candidate.confidence,
      index: candidate.index,
    }
  }

  if (ambiguous) {
    throw new ReplaceError(
      "ambiguous",
      "The search text appears more than once. Include more surrounding context so the target is unique, or set replaceAll to change every occurrence.",
      attempts,
    )
  }

  throw new ReplaceError(
    "not-found",
    "The search text was not found in the file. Read the file again and copy the exact text, including indentation.",
    attempts,
  )
}

function applyAll(
  content: string,
  candidates: readonly Candidate[],
  replacement: string,
): { content: string; count: number } {
  // Apply from the end so earlier offsets stay valid.
  const sorted = [...candidates].sort((left, right) => right.index - left.index)
  let result = content
  let count = 0
  let lastIndex = Number.POSITIVE_INFINITY
  for (const candidate of sorted) {
    // Skip overlapping matches, which can occur with self-overlapping searches.
    if (candidate.index + candidate.text.length > lastIndex) continue
    result =
      result.slice(0, candidate.index) + replacement + result.slice(candidate.index + candidate.text.length)
    lastIndex = candidate.index
    count++
  }
  return { content: result, count }
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

/**
 * Explains a failure in terms the model can act on.
 *
 * When a search fails, the most useful information is *where it nearly matched*.
 * Pointing at the closest region turns a blind retry into a targeted one.
 */
export function explainFailure(content: string, search: string, error: ReplaceError): string {
  const lines: string[] = [error.message]

  if (error.kind === "not-found") {
    const near = nearestRegion(content, search)
    if (near) {
      lines.push(
        "",
        `The closest text in the file is at line ${near.line} (about ${Math.round(near.similarity * 100)}% similar):`,
        "",
        near.text,
      )
    }

    const firstLine = search.split("\n").find((line) => line.trim() !== "")
    if (firstLine) {
      const occurrences = countOccurrences(content, firstLine.trim())
      if (occurrences === 0) {
        lines.push(
          "",
          `The first line of your search text (\`${firstLine.trim()}\`) does not appear in the file at all. You may be editing the wrong file.`,
        )
      }
    }
  }

  if (error.kind === "ambiguous") {
    const occurrences = countOccurrences(content, search)
    if (occurrences > 1) {
      lines.push("", `Found ${occurrences} occurrences. Add the preceding or following lines to disambiguate.`)
    }
  }

  return lines.join("\n")
}

function nearestRegion(
  content: string,
  search: string,
): { line: number; text: string; similarity: number } | undefined {
  const searchLines = trimTrailingEmpty(search.split("\n"))
  const searchText = searchLines.map((line) => line.trim()).join("\n")
  if (searchText.length === 0) return undefined

  const contentLines = content.split("\n")
  const size = Math.max(1, searchLines.length)
  let best: { line: number; text: string; similarity: number } | undefined

  for (let start = 0; start + size <= contentLines.length; start++) {
    const window = contentLines.slice(start, start + size)
    const windowText = window.map((line) => line.trim()).join("\n")
    if (Math.abs(windowText.length - searchText.length) > searchText.length) continue
    const distance = levenshtein(searchText, windowText)
    const similarity = 1 - distance / Math.max(searchText.length, windowText.length, 1)
    if (!best || similarity > best.similarity) {
      best = { line: start + 1, text: window.join("\n"), similarity }
    }
  }

  return best && best.similarity > 0.4 ? best : undefined
}

function countOccurrences(content: string, needle: string): number {
  if (needle === "") return 0
  let count = 0
  let index = content.indexOf(needle)
  while (index !== -1) {
    count++
    index = content.indexOf(needle, index + 1)
  }
  return count
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function lineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = []
  let cursor = 0
  for (const line of lines) {
    offsets.push(cursor)
    cursor += line.length + 1
  }
  return offsets
}

function trimTrailingEmpty(lines: readonly string[]): string[] {
  const result = [...lines]
  while (result.length > 0 && result[result.length - 1]!.trim() === "") result.pop()
  return result
}

function* mapConfidence(source: Generator<Candidate>, confidence: number): Generator<Candidate> {
  for (const candidate of source) {
    yield { ...candidate, confidence: Math.min(candidate.confidence, confidence) }
  }
}

/**
 * Detects the line ending used by a file so replacements do not mix them.
 *
 * A single CRLF file edited with LF replacements produces a diff on every line,
 * which is both noisy and, on some toolchains, a broken build.
 */
export function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? "\r\n" : "\n"
}

/** Normalises to LF for matching, remembering whether to restore CRLF. */
export function normalizeForEdit(content: string): { text: string; ending: "\n" | "\r\n" } {
  const ending = detectLineEnding(content)
  return { text: ending === "\r\n" ? content.replace(/\r\n/g, "\n") : content, ending }
}

export function restoreLineEnding(content: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? content.replace(/\n/g, "\r\n") : content
}

/** Detects the indentation style, used when generating new code. */
export function detectIndent(content: string): { style: "tab" | "space"; width: number } {
  const lines = content.split("\n").slice(0, 500)
  let tabs = 0
  const widths = new Map<number, number>()

  for (const line of lines) {
    if (line.trim() === "") continue
    if (line.startsWith("\t")) {
      tabs++
      continue
    }
    const match = /^ +/.exec(line)
    if (!match) continue
    const width = match[0].length
    // Only count plausible indent units.
    if (width % 2 !== 0 && width % 3 !== 0) continue
    widths.set(width, (widths.get(width) ?? 0) + 1)
  }

  if (tabs > [...widths.values()].reduce((sum, value) => sum + value, 0)) {
    return { style: "tab", width: 1 }
  }

  // The most common indent is usually a multiple of the unit; take the GCD of
  // the frequent widths rather than the mode, which over-reports nested code.
  const frequent = [...widths.entries()]
    .filter(([, count]) => count >= 2)
    .map(([width]) => width)
    .sort((left, right) => left - right)
  if (frequent.length === 0) return { style: "space", width: 2 }
  let unit = frequent[0]!
  for (const width of frequent) unit = gcd(unit, width)
  return { style: "space", width: unit >= 2 ? unit : 2 }
}

function gcd(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) {
    const next = a % b
    a = b
    b = next
  }
  return a
}
