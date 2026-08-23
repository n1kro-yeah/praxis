/**
 * The syntax highlighting engine.
 *
 * Takes source text and a grammar, produces coloured terminal output.
 *
 * The scanner is a longest-prefix matcher: at each position it tries every rule
 * in order and takes the first that matches at exactly that offset. That ordering
 * dependency is why the grammars put comments and strings first \u2014 a keyword rule
 * that ran earlier would colour the word `return` inside a comment.
 *
 * Performance matters more than it might appear. Highlighting runs on every
 * render of every visible code block, and a fast scroll through a long file
 * re-highlights continuously. The two decisions that make this fast enough are
 * anchoring every pattern with the sticky flag, so no rule can scan forward past
 * the current position looking for a match elsewhere, and caching compiled
 * patterns so the regex engine is not asked to recompile the same source on every
 * call.
 */

import { grammarForLanguage, grammarForPath, type Grammar, type Rule, type TokenKind } from "./grammar.js"
import { logger } from "../util/log.js"

const log = logger("syntax")

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * Longest input that will be highlighted.
 *
 * Beyond this the text is returned unchanged. A regex-based scanner over a
 * megabyte of minified JavaScript can take seconds, and it would take them while
 * the interface is blocked. Plain text arrives instantly and is far better than a
 * frozen terminal.
 */
const MAX_INPUT_BYTES = 256 * 1024

/**
 * Longest single line that will be highlighted.
 *
 * Minified files are one enormous line, and the backtracking behaviour of some
 * patterns is superlinear in line length. Skipping the pathological lines keeps
 * the rest of the file readable.
 */
const MAX_LINE_LENGTH = 4_000

/**
 * Cap on tokens produced.
 *
 * A defensive bound. A grammar bug that matches empty strings would otherwise
 * loop forever; the position guard below catches that directly, but the cap means
 * even an unforeseen case terminates.
 */
const MAX_TOKENS = 200_000

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export interface Token {
  readonly kind: TokenKind
  readonly text: string
  readonly start: number
  readonly end: number
}

/* ------------------------------------------------------------------ */
/* Pattern compilation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Sticky copies of each grammar's patterns.
 *
 * Compiled once per grammar and reused. The sticky flag is what makes the
 * scanner correct as well as fast: without it, `pattern.exec(text)` finds a match
 * anywhere ahead of the cursor, and the scanner would happily jump over
 * uncoloured text to reach it.
 */
const compiled = new WeakMap<Grammar, CompiledRule[]>()

interface CompiledRule {
  readonly kind: TokenKind
  readonly pattern: RegExp
  readonly group: number
}

function compile(grammar: Grammar): CompiledRule[] {
  const existing = compiled.get(grammar)

  if (existing) return existing

  const rules = grammar.rules.map((rule) => ({
    kind: rule.kind,
    pattern: sticky(rule.pattern),
    group: rule.group ?? 0,
  }))

  compiled.set(grammar, rules)

  return rules
}

/**
 * Rebuilds a pattern with the sticky flag.
 *
 * The multiline flag is preserved where the grammar set it, because rules that
 * anchor to the start of a line depend on it. Global is dropped: sticky and global
 * together behave surprisingly, and only sticky is wanted here.
 */
function sticky(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/[gy]/g, "") + "y"

  return new RegExp(pattern.source, flags)
}

/* ------------------------------------------------------------------ */
/* Scanning                                                            */
/* ------------------------------------------------------------------ */

/**
 * Splits text into tokens.
 *
 * Anything no rule matches becomes a `text` token rather than being dropped, so
 * the concatenation of every token's text is exactly the input. That property is
 * what lets the renderer reconstruct the source with colour added and nothing
 * lost, and it is worth preserving even at the cost of a few single-character
 * tokens.
 */
export function tokenize(source: string, grammar: Grammar): Token[] {
  const rules = compile(grammar)
  const tokens: Token[] = []

  let position = 0
  let pending = -1

  const flushPending = (end: number) => {
    if (pending < 0) return

    tokens.push({
      kind: "text",
      text: source.slice(pending, end),
      start: pending,
      end,
    })

    pending = -1
  }

  while (position < source.length) {
    if (tokens.length >= MAX_TOKENS) {
      log.warn("stopped highlighting after hitting the token cap", { grammar: grammar.name })

      break
    }

    let matched = false

    for (const rule of rules) {
      rule.pattern.lastIndex = position

      const match = rule.pattern.exec(source)

      if (!match) continue

      // A zero-length match cannot advance the cursor and would spin forever.
      // Treating it as no match is the only safe response.
      if (match[0].length === 0) continue

      const captured = rule.group === 0 ? match[0] : match[rule.group]

      if (captured === undefined || captured.length === 0) continue

      // When the rule captured a subgroup, the text before it was consumed as
      // context and is not part of the token. It still has to be emitted, or
      // the output would be missing characters.
      const offset = rule.group === 0 ? 0 : match[0].indexOf(captured)

      if (offset > 0) {
        if (pending < 0) pending = position

        flushPending(position + offset)
      } else {
        flushPending(position)
      }

      const start = position + Math.max(0, offset)

      tokens.push({
        kind: rule.kind,
        text: captured,
        start,
        end: start + captured.length,
      })

      position = start + captured.length
      matched = true

      break
    }

    if (!matched) {
      // Accumulate unmatched characters rather than emitting one token each.
      // A run of whitespace in a large file would otherwise produce thousands
      // of tokens that all render identically.
      if (pending < 0) pending = position

      position++
    }
  }

  flushPending(position)

  return tokens
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Maps a token kind to a colour, supplied by the active theme. */
export type Palette = (kind: TokenKind) => string | undefined

export interface HighlightOptions {
  /** Language name from a fence, or a file path. */
  readonly language?: string
  readonly path?: string
  /** Colour lookup. When absent, the text is returned unchanged. */
  readonly palette?: Palette
  /** Reset sequence written after each coloured span. */
  readonly reset?: string
  /** Skip highlighting entirely. */
  readonly disabled?: boolean
}

/**
 * Highlights source text, returning a string with colour codes.
 *
 * Every path that cannot highlight returns the input unchanged rather than
 * throwing. A syntax highlighter is a convenience, and there is no failure of it
 * that justifies losing the user's ability to read their code.
 */
export function highlight(source: string, options: HighlightOptions = {}): string {
  if (options.disabled || !options.palette) return source
  if (source.length > MAX_INPUT_BYTES) return source

  const grammar = resolveGrammar(options)

  if (!grammar) return source

  const reset = options.reset ?? "\u001b[0m"

  try {
    // Line by line, so one pathological line can be skipped without abandoning
    // the file, and so line-anchored rules see real line starts.
    const lines = source.split("\n")
    const output: string[] = []

    for (const line of lines) {
      if (line.length === 0) {
        output.push("")
        continue
      }

      if (line.length > MAX_LINE_LENGTH) {
        output.push(line)
        continue
      }

      output.push(renderLine(line, grammar, options.palette, reset))
    }

    return output.join("\n")
  } catch (error) {
    log.debug("highlighting failed; the text is being shown unstyled", {
      grammar: grammar.name,
      error: String(error),
    })

    return source
  }
}

function renderLine(line: string, grammar: Grammar, palette: Palette, reset: string): string {
  const tokens = tokenize(line, grammar)

  let result = ""

  for (const token of tokens) {
    const colour = token.kind === "text" ? undefined : palette(token.kind)

    // Uncoloured tokens are written bare rather than wrapped in an empty
    // sequence, which keeps the output shorter and avoids paying for a reset
    // that changes nothing.
    result += colour ? colour + token.text + reset : token.text
  }

  return result
}

/**
 * Highlights a block spanning multiple lines with correct multi-line constructs.
 *
 * The per-line path above cannot see a block comment that opens on one line and
 * closes on another, so it colours only the first line. This variant tokenises the
 * whole text at once, which handles those correctly at the cost of not being able
 * to skip individual long lines.
 *
 * Used for code blocks in rendered markdown, where block comments are common and
 * the input is bounded. The per-line path is used for file views, where the input
 * may be enormous.
 */
export function highlightBlock(source: string, options: HighlightOptions = {}): string {
  if (options.disabled || !options.palette) return source
  if (source.length > MAX_INPUT_BYTES) return source

  const grammar = resolveGrammar(options)

  if (!grammar) return source

  const reset = options.reset ?? "\u001b[0m"

  try {
    const tokens = tokenize(source, grammar)

    let result = ""

    for (const token of tokens) {
      const colour = token.kind === "text" ? undefined : options.palette(token.kind)

      if (!colour) {
        result += token.text
        continue
      }

      // A colour sequence that spans a newline bleeds into the next line, which
      // corrupts everything when the terminal scrolls or the pane is redrawn.
      // Re-opening on each line costs a few bytes and avoids the whole problem.
      if (token.text.includes("\n")) {
        result += token.text
          .split("\n")
          .map((part) => (part === "" ? "" : colour + part + reset))
          .join("\n")
      } else {
        result += colour + token.text + reset
      }
    }

    return result
  } catch (error) {
    log.debug("block highlighting failed", { grammar: grammar.name, error: String(error) })

    return source
  }
}

function resolveGrammar(options: HighlightOptions): Grammar | undefined {
  if (options.language) {
    const found = grammarForLanguage(options.language)

    if (found) return found
  }

  if (options.path) return grammarForPath(options.path)

  return undefined
}

/* ------------------------------------------------------------------ */
/* Structured output                                                   */
/* ------------------------------------------------------------------ */

export interface HighlightedLine {
  readonly number: number
  readonly tokens: readonly Token[]
}

/**
 * Tokenises into per-line structures without rendering.
 *
 * Needed by the diff viewer, which has to interleave its own colours for added
 * and removed lines with the syntax colours underneath, and cannot do that with a
 * string that already has sequences baked in.
 */
export function highlightLines(
  source: string,
  options: { language?: string; path?: string } = {},
): HighlightedLine[] {
  const grammar = resolveGrammar(options)
  const lines = source.split("\n")

  if (!grammar) {
    return lines.map((line, index) => ({
      number: index + 1,
      tokens: line === "" ? [] : [{ kind: "text" as const, text: line, start: 0, end: line.length }],
    }))
  }

  return lines.map((line, index) => ({
    number: index + 1,
    tokens: line === "" || line.length > MAX_LINE_LENGTH
      ? line === ""
        ? []
        : [{ kind: "text" as const, text: line, start: 0, end: line.length }]
      : tokenize(line, grammar),
  }))
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Guesses a language from content when no name or path is available.
 *
 * Only for fenced blocks with no language tag, which are common in model output.
 * The checks are ordered by how distinctive they are: a shebang is conclusive,
 * a leading brace is only suggestive.
 *
 * Returns undefined rather than guessing badly. Wrong highlighting is worse
 * than none, because it makes the reader distrust the colours everywhere else.
 */
export function detectLanguage(source: string): string | undefined {
  const head = source.slice(0, 2_000)
  const trimmed = head.trim()

  if (trimmed === "") return undefined

  // A shebang names the interpreter outright.
  const shebang = /^#!\s*\S*\b(node|bun|deno|python3?|ruby|bash|sh|zsh|perl|php)\b/.exec(trimmed)

  if (shebang) {
    const interpreter = shebang[1]!

    if (interpreter === "node" || interpreter === "bun" || interpreter === "deno") return "typescript"
    if (interpreter.startsWith("python")) return "python"
    if (interpreter === "bash" || interpreter === "sh" || interpreter === "zsh") return "shell"

    return interpreter
  }

  // A diff has an unmistakable header.
  if (/^(?:diff --git|---\s|\+\+\+\s|@@ -\d)/m.test(trimmed)) return "diff"

  // Balanced JSON, checked by parsing rather than by pattern. Cheap for the
  // sizes involved and far more reliable than a regex.
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && source.length < 100_000) {
    try {
      JSON.parse(source)

      return "json"
    } catch {
      // Not JSON. Fall through to the other checks.
    }
  }

  if (/^\s*<(?:\?xml|!DOCTYPE html|html|svg)\b/i.test(trimmed)) {
    return /^\s*<\?xml/i.test(trimmed) ? "xml" : "html"
  }

  if (/^\s*(?:FROM|RUN|CMD|COPY|WORKDIR|ENTRYPOINT)\s+\S/m.test(trimmed)) return "dockerfile"

  // Language-specific syntax that has no close analogue elsewhere.
  if (/^\s*(?:package|func)\s+\w+|:=/m.test(trimmed)) return "go"
  if (/^\s*(?:fn|impl|pub fn|use )\s|->\s*Result</m.test(trimmed)) return "rust"
  if (/^\s*(?:def|class)\s+\w+.*:\s*$|^\s*(?:from|import)\s+\w+/m.test(trimmed)) return "python"
  if (/^\s*(?:const|let|var|function|import|export)\s|=>/m.test(trimmed)) return "typescript"
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|WITH)\b/im.test(trimmed)) return "sql"
  if (/^\s*(?:#{1,6}\s|\*\s|-\s|\d+\.\s).*$/m.test(trimmed) && /^#{1,6}\s/m.test(trimmed)) return "markdown"

  // YAML is checked late because a key-value line matches too many things.
  if (/^[A-Za-z_][\w.-]*:\s*(?:\S|$)/m.test(trimmed) && !trimmed.includes("{")) return "yaml"

  return undefined
}

/* ------------------------------------------------------------------ */
/* Plain rendering                                                     */
/* ------------------------------------------------------------------ */

/**
 * Strips colour sequences from text.
 *
 * Needed when measuring width for layout, and when writing to a file or a pipe
 * where the sequences would be noise.
 */
export function stripColours(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "")
}

/** Whether a grammar exists for a language name. */
export function isSupported(language: string): boolean {
  return grammarForLanguage(language) !== undefined
}
