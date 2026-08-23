/**
 * A markdown parser for terminal rendering.
 *
 * Not a general-purpose markdown implementation. It handles the constructs that
 * language models actually emit \u2014 headings, lists, fenced code, tables,
 * blockquotes, inline emphasis and code \u2014 and ignores the rest of CommonMark.
 * Reference links, HTML blocks, setext headings, and link definitions are all
 * absent because they essentially never appear in assistant output, and supporting
 * them would double the size of this file for no benefit anyone would see.
 *
 * The parser is line-oriented and single-pass. Blocks are recognised by their
 * opening line, consume until their terminator, and produce a node. Inline content
 * is parsed separately, after block structure is settled, because the two levels
 * have different rules and mixing them is where hand-written markdown parsers
 * usually go wrong.
 *
 * Streaming is the constraint that shapes everything here. Model output arrives
 * a token at a time and is re-rendered on each chunk, which means this parser runs
 * hundreds of times on progressively longer text. It has to be fast, and it has to
 * produce something sensible from input that is cut off mid-construct: an unclosed
 * fence, a half-written table, a heading with no text yet.
 */

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

export type BlockNode =
  | { type: "paragraph"; content: InlineNode[] }
  | { type: "heading"; level: number; content: InlineNode[] }
  | { type: "code"; language?: string; text: string; closed: boolean }
  | { type: "quote"; children: BlockNode[] }
  | { type: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { type: "table"; header: TableRow; align: Alignment[]; rows: TableRow[] }
  | { type: "rule" }
  | { type: "html"; text: string }
  | { type: "blank" }

export interface ListItem {
  readonly checked?: boolean
  readonly children: BlockNode[]
}

export type TableRow = InlineNode[][]

export type Alignment = "left" | "center" | "right" | "none"

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "emphasis"; children: InlineNode[] }
  | { type: "strike"; children: InlineNode[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "image"; src: string; alt: string }
  | { type: "break" }

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/** Deepest nesting followed before giving up and treating content as text. */
const MAX_DEPTH = 8

/**
 * Longest line the inline parser will process.
 *
 * The emphasis matching is quadratic in pathological cases \u2014 a line of nothing
 * but asterisks is the classic example \u2014 and a very long line is almost always
 * data rather than prose.
 */
const MAX_INLINE_LENGTH = 20_000

/* ------------------------------------------------------------------ */
/* Block parsing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Parses markdown into a block tree.
 *
 * Tabs are expanded first. Markdown's indentation rules are defined in terms of
 * columns, and a mix of tabs and spaces otherwise produces list nesting that looks
 * correct in the source and wrong in the output.
 */
export function parse(source: string, depth = 0): BlockNode[] {
  if (depth > MAX_DEPTH) {
    return [{ type: "paragraph", content: [{ type: "text", text: source }] }]
  }

  const lines = source.replace(/\t/g, "    ").split("\n")
  const nodes: BlockNode[] = []

  let index = 0

  while (index < lines.length) {
    const line = lines[index]!

    if (line.trim() === "") {
      // Blank lines are recorded rather than dropped. The renderer needs them
      // to decide spacing between blocks, and a list is tight or loose
      // depending on whether its items are separated by one.
      nodes.push({ type: "blank" })
      index++

      continue
    }

    // Fenced code first. Everything inside a fence is literal, so no other rule
    // may run until the fence closes.
    const fence = matchFence(line)

    if (fence) {
      const result = readFence(lines, index, fence)

      nodes.push(result.node)
      index = result.next

      continue
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line)

    if (heading) {
      nodes.push({
        type: "heading",
        level: heading[1]!.length,
        // Closing hashes are decorative and are stripped.
        content: parseInline(heading[2]!.replace(/\s+#+\s*$/, "")),
      })

      index++

      continue
    }

    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      nodes.push({ type: "rule" })
      index++

      continue
    }

    if (/^ {0,3}>/.test(line)) {
      const result = readQuote(lines, index, depth)

      nodes.push(result.node)
      index = result.next

      continue
    }

    if (matchListMarker(line)) {
      const result = readList(lines, index, depth)

      nodes.push(result.node)
      index = result.next

      continue
    }

    // A table needs its delimiter row to be recognised, so the check looks one
    // line ahead. Without that lookahead the header would be parsed as a
    // paragraph and the table would never form.
    if (line.includes("|") && index + 1 < lines.length && isDelimiterRow(lines[index + 1]!)) {
      const result = readTable(lines, index)

      if (result) {
        nodes.push(result.node)
        index = result.next

        continue
      }
    }

    const result = readParagraph(lines, index)

    nodes.push(result.node)
    index = result.next
  }

  return nodes
}

/* ------------------------------------------------------------------ */
/* Fenced code                                                         */
/* ------------------------------------------------------------------ */

interface Fence {
  readonly marker: string
  readonly length: number
  readonly indent: number
  readonly language?: string
}

function matchFence(line: string): Fence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})\s*(\S*)/.exec(line)

  if (!match) return undefined

  // A backtick fence cannot have backticks in its info string, or an inline
  // code span containing three backticks would open a block.
  if (match[2]!.startsWith("`") && match[3]!.includes("`")) return undefined

  return {
    marker: match[2]![0]!,
    length: match[2]!.length,
    indent: match[1]!.length,
    language: match[3] === "" ? undefined : match[3],
  }
}

/**
 * Reads a fenced block.
 *
 * An unterminated fence runs to the end of input and is marked open. This is
 * the normal case while streaming \u2014 the model is still writing the code \u2014 and
 * rendering it as a code block rather than as literal backticks is what makes
 * streamed output look right.
 */
function readFence(lines: string[], start: number, fence: Fence): { node: BlockNode; next: number } {
  const body: string[] = []

  let index = start + 1
  let closed = false

  while (index < lines.length) {
    const line = lines[index]!

    const closing = new RegExp("^ {0,3}" + fence.marker + "{" + String(fence.length) + ",}\\s*$")

    if (closing.test(line)) {
      closed = true
      index++

      break
    }

    // The opening fence's indentation is removed from each line, which is what
    // keeps a code block inside a list item from being rendered with the list's
    // indentation baked into the code.
    body.push(fence.indent > 0 ? removeIndent(line, fence.indent) : line)
    index++
  }

  return {
    node: {
      type: "code",
      language: fence.language,
      text: body.join("\n"),
      closed,
    },
    next: index,
  }
}

function removeIndent(line: string, amount: number): string {
  let removed = 0

  while (removed < amount && line[removed] === " ") removed++

  return line.slice(removed)
}

/* ------------------------------------------------------------------ */
/* Block quotes                                                        */
/* ------------------------------------------------------------------ */

function readQuote(lines: string[], start: number, depth: number): { node: BlockNode; next: number } {
  const body: string[] = []

  let index = start

  while (index < lines.length) {
    const line = lines[index]!

    const match = /^ {0,3}>\s?(.*)$/.exec(line)

    if (match) {
      body.push(match[1]!)
      index++

      continue
    }

    // Lazy continuation: a non-blank line after a quote line stays in the
    // quote. Common in model output, which often wraps a quoted paragraph
    // without repeating the marker.
    if (line.trim() !== "" && body.length > 0 && !matchListMarker(line) && !matchFence(line)) {
      body.push(line)
      index++

      continue
    }

    break
  }

  return {
    node: { type: "quote", children: parse(body.join("\n"), depth + 1) },
    next: index,
  }
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

interface ListMarker {
  readonly indent: number
  readonly ordered: boolean
  readonly start: number
  readonly width: number
  readonly checked?: boolean
}

function matchListMarker(line: string): ListMarker | undefined {
  const bullet = /^( {0,7})([-*+])(\s+)(\[[ xX]\]\s+)?/.exec(line)

  if (bullet) {
    const task = bullet[4]

    return {
      indent: bullet[1]!.length,
      ordered: false,
      start: 1,
      width: bullet[0]!.length,
      checked: task === undefined ? undefined : /[xX]/.test(task),
    }
  }

  const ordered = /^( {0,7})(\d{1,9})([.)])(\s+)(\[[ xX]\]\s+)?/.exec(line)

  if (ordered) {
    const task = ordered[5]

    return {
      indent: ordered[1]!.length,
      ordered: true,
      start: Number.parseInt(ordered[2]!, 10),
      width: ordered[0]!.length,
      checked: task === undefined ? undefined : /[xX]/.test(task),
    }
  }

  return undefined
}

/**
 * Reads a list and its items.
 *
 * Continuation lines belong to an item when they are indented past the item's
 * marker. That rule is what makes nested lists and multi-paragraph items work, and
 * it is applied by recursing on the item's dedented content rather than trying to
 * track nesting in this loop.
 */
function readList(lines: string[], start: number, depth: number): { node: BlockNode; next: number } {
  const first = matchListMarker(lines[start]!)!

  const items: ListItem[] = []

  let index = start
  let tight = true
  let pendingBlank = false

  while (index < lines.length) {
    const line = lines[index]!

    if (line.trim() === "") {
      pendingBlank = true
      index++

      continue
    }

    const marker = matchListMarker(line)

    // A marker at a deeper indent belongs to a nested list inside the current
    // item, and is picked up by the recursion below rather than here.
    if (marker && marker.indent <= first.indent + 1) {
      // Different marker type means a new list, not a continuation of this one.
      if (marker.ordered !== first.ordered) break

      if (pendingBlank && items.length > 0) tight = false

      pendingBlank = false

      const body: string[] = [line.slice(marker.width)]

      index++

      // Consume the item's continuation lines.
      while (index < lines.length) {
        const next = lines[index]!

        if (next.trim() === "") {
          // A blank line may end the item or separate its paragraphs. Look
          // ahead: if what follows is indented, the item continues.
          const following = lines[index + 1]

          if (following !== undefined && following.trim() !== "" && indentOf(following) > first.indent) {
            body.push("")
            index++

            continue
          }

          break
        }

        const nextMarker = matchListMarker(next)

        if (nextMarker && nextMarker.indent <= first.indent + 1) break

        if (indentOf(next) > first.indent) {
          body.push(removeIndent(next, marker.width))
          index++

          continue
        }

        // Lazy continuation of the item's paragraph.
        if (!nextMarker && !matchFence(next) && !/^ {0,3}>/.test(next)) {
          body.push(next.trim())
          index++

          continue
        }

        break
      }

      items.push({
        checked: marker.checked,
        children: parse(body.join("\n"), depth + 1),
      })

      continue
    }

    break
  }

  return {
    node: {
      type: "list",
      ordered: first.ordered,
      start: first.start,
      tight,
      items,
    },
    next: index,
  }
}

function indentOf(line: string): number {
  let count = 0

  while (line[count] === " ") count++

  return count
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

function isDelimiterRow(line: string): boolean {
  const trimmed = line.trim()

  if (!trimmed.includes("-")) return false

  return /^\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed)
}

function readTable(lines: string[], start: number): { node: BlockNode; next: number } | undefined {
  const header = splitRow(lines[start]!)
  const align = parseAlignment(lines[start + 1]!)

  // A mismatched column count means this is not really a table, and forcing it
  // into one produces worse output than leaving it as a paragraph.
  if (header.length === 0 || align.length === 0) return undefined

  const rows: TableRow[] = []

  let index = start + 2

  while (index < lines.length) {
    const line = lines[index]!

    if (line.trim() === "" || !line.includes("|")) break

    const cells = splitRow(line)

    // Rows are padded or truncated to the header's width. Ragged tables are
    // common in model output and rendering them ragged looks broken.
    while (cells.length < header.length) cells.push("")

    rows.push(cells.slice(0, header.length).map((cell) => parseInline(cell)))
    index++
  }

  return {
    node: {
      type: "table",
      header: header.map((cell) => parseInline(cell)),
      align,
      rows,
    },
    next: index,
  }
}

/**
 * Splits a table row into cells.
 *
 * Escaped pipes are honoured, because a table cell containing a pipe is common
 * in documentation about shell commands and splitting on it would corrupt the row.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")

  const cells: string[] = []

  let current = ""
  let escaped = false

  for (const character of trimmed) {
    if (escaped) {
      // The backslash is kept so the inline parser sees the escape and does not
      // treat the pipe as markup.
      current += "\\" + character
      escaped = false

      continue
    }

    if (character === "\\") {
      escaped = true
      continue
    }

    if (character === "|") {
      cells.push(current.trim())
      current = ""

      continue
    }

    current += character
  }

  cells.push(current.trim())

  return cells
}

function parseAlignment(line: string): Alignment[] {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")

    if (left && right) return "center"
    if (right) return "right"
    if (left) return "left"

    return "none"
  })
}

/* ------------------------------------------------------------------ */
/* Paragraphs                                                          */
/* ------------------------------------------------------------------ */

function readParagraph(lines: string[], start: number): { node: BlockNode; next: number } {
  const body: string[] = []

  let index = start

  while (index < lines.length) {
    const line = lines[index]!

    if (line.trim() === "") break

    // A block-level construct interrupts a paragraph without needing a blank
    // line before it. Models frequently omit that blank line.
    if (index > start) {
      if (matchFence(line)) break
      if (/^ {0,3}#{1,6}\s/.test(line)) break
      if (/^ {0,3}>/.test(line)) break
      if (matchListMarker(line)) break
      if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) break
    }

    body.push(line.trim())
    index++
  }

  return {
    node: { type: "paragraph", content: parseInline(body.join("\n")) },
    next: index,
  }
}

/* ------------------------------------------------------------------ */
/* Inline parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Parses inline markup.
 *
 * A single left-to-right scan with a small set of recognisers, rather than the
 * delimiter-stack algorithm CommonMark specifies. The stack algorithm handles
 * cases like `***bold italic***` and adjacent runs of emphasis correctly; this
 * does not, and gets them slightly wrong in ways that are visible only if you look
 * for them.
 *
 * That is an acceptable trade here. The stack algorithm is several hundred
 * lines, and this runs on every streamed chunk.
 */
export function parseInline(source: string, depth = 0): InlineNode[] {
  if (source === "") return []
  if (depth > MAX_DEPTH || source.length > MAX_INLINE_LENGTH) {
    return [{ type: "text", text: source }]
  }

  const nodes: InlineNode[] = []

  let text = ""
  let index = 0

  const flush = () => {
    if (text !== "") {
      nodes.push({ type: "text", text })
      text = ""
    }
  }

  while (index < source.length) {
    const character = source[index]!

    // A backslash escapes the next punctuation character, which is how a
    // literal asterisk or underscore is written.
    if (character === "\\" && index + 1 < source.length) {
      const next = source[index + 1]!

      if (/[\\`*_{}[\]()#+\-.!|~<>]/.test(next)) {
        text += next
        index += 2

        continue
      }
    }

    // Inline code first. Its contents are literal, so nothing inside may be
    // interpreted as markup.
    if (character === "`") {
      const code = matchCode(source, index)

      if (code) {
        flush()
        nodes.push({ type: "code", text: code.text })
        index = code.next

        continue
      }
    }

    if (character === "!" && source[index + 1] === "[") {
      const image = matchLink(source, index + 1)

      if (image) {
        flush()
        nodes.push({ type: "image", src: image.href, alt: image.label })
        index = image.next

        continue
      }
    }

    if (character === "[") {
      const link = matchLink(source, index)

      if (link) {
        flush()
        nodes.push({
          type: "link",
          href: link.href,
          children: parseInline(link.label, depth + 1),
        })

        index = link.next

        continue
      }
    }

    if (character === "~" && source[index + 1] === "~") {
      const strike = matchDelimited(source, index, "~~")

      if (strike) {
        flush()
        nodes.push({ type: "strike", children: parseInline(strike.text, depth + 1) })
        index = strike.next

        continue
      }
    }

    if (character === "*" || character === "_") {
      // Double before single, or `**bold**` is read as two empty emphases
      // wrapping the word.
      const doubled = source[index + 1] === character

      if (doubled) {
        const strong = matchDelimited(source, index, character + character)

        if (strong) {
          flush()
          nodes.push({ type: "strong", children: parseInline(strong.text, depth + 1) })
          index = strong.next

          continue
        }
      }

      // An underscore inside a word is not emphasis. This is what keeps
      // `snake_case_names` from being mangled, which matters a great deal in
      // output about code.
      const insideWord =
        character === "_" &&
        index > 0 &&
        /\w/.test(source[index - 1]!) &&
        index + 1 < source.length &&
        /\w/.test(source[index + 1]!)

      if (!insideWord) {
        const emphasis = matchDelimited(source, index, character)

        if (emphasis) {
          flush()
          nodes.push({ type: "emphasis", children: parseInline(emphasis.text, depth + 1) })
          index = emphasis.next

          continue
        }
      }
    }

    // Two trailing spaces before a newline is a hard break.
    if (character === "\n") {
      flush()
      nodes.push({ type: "break" })
      index++

      continue
    }

    text += character
    index++
  }

  flush()

  return nodes
}

/**
 * Matches an inline code span.
 *
 * The opening run length determines the closing run length, which is how a span
 * containing backticks is written. Getting this right matters because model output
 * about markdown is full of nested backticks.
 */
function matchCode(source: string, start: number): { text: string; next: number } | undefined {
  let length = 0

  while (source[start + length] === "`") length++

  const fence = "`".repeat(length)
  const close = source.indexOf(fence, start + length)

  if (close < 0) return undefined

  // A run longer than the opening is not a valid close.
  if (source[close + length] === "`") return undefined

  let text = source.slice(start + length, close)

  // One leading and trailing space is stripped, which is how a span that begins
  // or ends with a backtick is written.
  if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ")) {
    text = text.slice(1, -1)
  }

  return { text, next: close + length }
}

/**
 * Matches a delimited run such as emphasis.
 *
 * Refuses to match across a blank line, which prevents a stray asterisk from
 * swallowing the rest of the document looking for a partner. That failure mode is
 * extremely visible when it happens mid-stream.
 */
function matchDelimited(
  source: string,
  start: number,
  delimiter: string,
): { text: string; next: number } | undefined {
  const from = start + delimiter.length

  // A delimiter followed by whitespace does not open a run.
  if (/\s/.test(source[from] ?? " ")) return undefined

  let index = from

  while (index < source.length) {
    const close = source.indexOf(delimiter, index)

    if (close < 0) return undefined

    if (source.slice(from, close).includes("\n\n")) return undefined

    // A delimiter preceded by whitespace does not close a run.
    if (/\s/.test(source[close - 1] ?? " ")) {
      index = close + delimiter.length

      continue
    }

    if (close === from) return undefined

    return { text: source.slice(from, close), next: close + delimiter.length }
  }

  return undefined
}

/**
 * Matches a link or image.
 *
 * Bracket depth is tracked so a link whose text contains brackets is handled,
 * and parenthesis depth likewise for URLs containing them. Both appear often
 * enough in real documentation to be worth the extra few lines.
 */
function matchLink(
  source: string,
  start: number,
): { label: string; href: string; next: number } | undefined {
  let depth = 0
  let index = start

  while (index < source.length) {
    const character = source[index]!

    if (character === "\\") {
      index += 2
      continue
    }

    if (character === "[") depth++

    if (character === "]") {
      depth--

      if (depth === 0) break
    }

    if (character === "\n" && source[index + 1] === "\n") return undefined

    index++
  }

  if (depth !== 0 || source[index + 1] !== "(") return undefined

  const label = source.slice(start + 1, index)

  let parens = 0
  let cursor = index + 1

  while (cursor < source.length) {
    const character = source[cursor]!

    if (character === "\\") {
      cursor += 2
      continue
    }

    if (character === "(") parens++

    if (character === ")") {
      parens--

      if (parens === 0) break
    }

    cursor++
  }

  if (parens !== 0) return undefined

  const target = source.slice(index + 2, cursor).trim()

  // A title after the URL is dropped; terminals have nowhere to show it.
  const href = /^(\S+)(?:\s+["'(].*)?$/.exec(target)?.[1] ?? target

  return { label, href, next: cursor + 1 }
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

/** Flattens inline nodes to plain text, for width measurement and copying. */
export function inlineText(nodes: readonly InlineNode[]): string {
  let result = ""

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result += node.text
        break

      case "code":
        result += node.text
        break

      case "image":
        result += node.alt
        break

      case "break":
        result += "\n"
        break

      default:
        result += inlineText(node.children)
    }
  }

  return result
}

/** Flattens a block tree to plain text. */
export function blockText(nodes: readonly BlockNode[]): string {
  const parts: string[] = []

  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
      case "heading":
        parts.push(inlineText(node.content))
        break

      case "code":
        parts.push(node.text)
        break

      case "quote":
        parts.push(blockText(node.children))
        break

      case "list":
        for (const item of node.items) parts.push(blockText(item.children))
        break

      case "table":
        parts.push(node.header.map((cell) => inlineText(cell)).join(" "))

        for (const row of node.rows) {
          parts.push(row.map((cell) => inlineText(cell)).join(" "))
        }

        break

      default:
        break
    }
  }

  return parts.join("\n")
}

/** Whether the tree ends inside an unterminated code fence. */
export function hasOpenFence(nodes: readonly BlockNode[]): boolean {
  const last = nodes[nodes.length - 1]

  return last?.type === "code" && !last.closed
}
