/**
 * Terminal renderer for the markdown block tree.
 *
 * Turns parsed markdown into styled, wrapped lines that fit a given width.
 *
 * Two things make terminal markdown rendering harder than it looks. The first
 * is that the visible width of a string is not its length: colour sequences take
 * bytes but no columns, CJK characters take two columns each, and emoji can take
 * two or more. Every wrap and alignment decision here goes through a width
 * function that accounts for those, because using `.length` produces tables that
 * are visibly crooked and paragraphs that wrap one character early on every line.
 *
 * The second is that styling must not leak. A colour opened on one line and left
 * open bleeds into everything after it when the terminal scrolls or the pane is
 * redrawn, which produces the characteristic "everything went blue" corruption.
 * Every style here is closed on the same line it opens.
 */

import { stringWidth } from "../util/wcwidth.js"
import { highlightBlock, detectLanguage } from "../syntax/highlight.js"
import type { TokenKind } from "../syntax/grammar.js"
import {
  inlineText,
  type Alignment,
  type BlockNode,
  type InlineNode,
  type TableRow,
} from "./parse.js"

/* ------------------------------------------------------------------ */
/* Styling                                                             */
/* ------------------------------------------------------------------ */

/**
 * The styles the renderer needs.
 *
 * Supplied by the theme rather than hardcoded, so that a light terminal gets
 * readable output and a monochrome one gets none of this at all. Each value is a
 * complete escape sequence; the renderer never composes them itself.
 */
export interface MarkdownStyle {
  readonly heading: (level: number) => string
  readonly strong: string
  readonly emphasis: string
  readonly strike: string
  readonly code: string
  readonly codeBlock: string
  readonly link: string
  readonly quote: string
  readonly bullet: string
  readonly rule: string
  readonly tableBorder: string
  readonly tableHeader: string
  readonly reset: string
  readonly syntax?: (kind: TokenKind) => string | undefined
}

/** A style set that emits nothing, for pipes and files. */
export const PLAIN_STYLE: MarkdownStyle = {
  heading: () => "",
  strong: "",
  emphasis: "",
  strike: "",
  code: "",
  codeBlock: "",
  link: "",
  quote: "",
  bullet: "",
  rule: "",
  tableBorder: "",
  tableHeader: "",
  reset: "",
}

export interface RenderOptions {
  readonly width: number
  readonly style: MarkdownStyle
  /** Prefix applied to every line, used for quote and list indentation. */
  readonly prefix?: string
  /** Whether the terminal can show box-drawing characters. */
  readonly unicode?: boolean
  /** Show link targets rather than only their text. */
  readonly showLinks?: boolean
}

/* ------------------------------------------------------------------ */
/* Glyphs                                                              */
/* ------------------------------------------------------------------ */

const UNICODE_GLYPHS = {
  bullet: ["\u2022", "\u25e6", "\u2023"],
  quote: "\u2502 ",
  rule: "\u2500",
  checked: "\u2611",
  unchecked: "\u2610",
  horizontal: "\u2500",
  vertical: "\u2502",
  cross: "\u253c",
  topLeft: "\u250c",
  topRight: "\u2510",
  bottomLeft: "\u2514",
  bottomRight: "\u2518",
  teeDown: "\u252c",
  teeUp: "\u2534",
  teeRight: "\u251c",
  teeLeft: "\u2524",
}

const ASCII_GLYPHS = {
  bullet: ["*", "-", "+"],
  quote: "| ",
  rule: "-",
  checked: "[x]",
  unchecked: "[ ]",
  horizontal: "-",
  vertical: "|",
  cross: "+",
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  teeDown: "+",
  teeUp: "+",
  teeRight: "+",
  teeLeft: "+",
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Renders a block tree to terminal lines.
 *
 * Returns an array rather than a joined string, because the caller usually needs
 * to know the line count for scrolling and to slice a visible window out of a long
 * document without measuring it again.
 */
export function render(nodes: readonly BlockNode[], options: RenderOptions): string[] {
  const lines: string[] = []

  let previous: BlockNode | undefined

  for (const node of nodes) {
    if (node.type === "blank") continue

    // Blocks are separated by one blank line, inserted here rather than
    // trailing each block. Trailing blanks accumulate at the end of the
    // document and produce a scroll region that is mostly empty.
    if (previous && needsSeparator(previous, node)) lines.push("")

    lines.push(...renderBlock(node, options))

    previous = node
  }

  return lines
}

/**
 * Whether two adjacent blocks need a blank line between them.
 *
 * Consecutive list items do not, which is what makes a tight list look like a
 * list rather than a series of paragraphs.
 */
function needsSeparator(previous: BlockNode, next: BlockNode): boolean {
  if (previous.type === "list" && next.type === "list") return false

  return true
}

function renderBlock(node: BlockNode, options: RenderOptions): string[] {
  switch (node.type) {
    case "heading":
      return renderHeading(node, options)

    case "paragraph":
      return renderParagraph(node.content, options)

    case "code":
      return renderCode(node, options)

    case "quote":
      return renderQuote(node, options)

    case "list":
      return renderList(node, options)

    case "table":
      return renderTable(node, options)

    case "rule":
      return renderRule(options)

    case "html":
      // Raw HTML is shown verbatim. Rendering it would need a second parser,
      // and dropping it silently loses content the user wrote.
      return node.text.split("\n")

    default:
      return []
  }
}

/* ------------------------------------------------------------------ */
/* Headings                                                            */
/* ------------------------------------------------------------------ */

function renderHeading(
  node: Extract<BlockNode, { type: "heading" }>,
  options: RenderOptions,
): string[] {
  const style = options.style.heading(node.level)
  const prefix = options.prefix ?? ""

  const text = renderInline(node.content, options)

  const lines = wrap(text, options.width - stringWidth(prefix))

  const result = lines.map((line) => prefix + style + line + (style ? options.style.reset : ""))

  // Only the top two levels get an underline. Underlining every level turns a
  // document with many subheadings into mostly rules.
  if (node.level <= 2) {
    const glyphs = options.unicode === false ? ASCII_GLYPHS : UNICODE_GLYPHS
    const width = Math.min(
      options.width - stringWidth(prefix),
      Math.max(...lines.map((line) => stringWidth(line))),
    )

    if (width > 0) {
      result.push(prefix + options.style.rule + glyphs.rule.repeat(width) + options.style.reset)
    }
  }

  return result
}

/* ------------------------------------------------------------------ */
/* Paragraphs                                                          */
/* ------------------------------------------------------------------ */

function renderParagraph(content: readonly InlineNode[], options: RenderOptions): string[] {
  const prefix = options.prefix ?? ""
  const text = renderInline(content, options)

  return wrap(text, options.width - stringWidth(prefix)).map((line) => prefix + line)
}

/* ------------------------------------------------------------------ */
/* Code blocks                                                         */
/* ------------------------------------------------------------------ */

/**
 * Renders a fenced code block.
 *
 * Code is never wrapped. Wrapping code changes its indentation and makes it
 * impossible to copy, so long lines are allowed to overflow and the terminal's own
 * horizontal handling takes over. That is the lesser evil by a wide margin.
 */
function renderCode(
  node: Extract<BlockNode, { type: "code" }>,
  options: RenderOptions,
): string[] {
  const prefix = (options.prefix ?? "") + "  "

  const language = node.language ?? detectLanguage(node.text)

  const highlighted = options.style.syntax
    ? highlightBlock(node.text, {
        language,
        palette: options.style.syntax,
        reset: options.style.reset,
      })
    : node.text

  const lines = highlighted.split("\n")

  // A trailing empty line from the final newline before the closing fence is
  // noise, not content.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  const body = lines.map((line) => prefix + line)

  // The language label helps when scanning a long response for the right block.
  // Omitted when unknown rather than showing an empty label.
  if (language) {
    body.unshift(
      (options.prefix ?? "") + options.style.codeBlock + "  " + language + options.style.reset,
    )
  }

  return body
}

/* ------------------------------------------------------------------ */
/* Quotes                                                              */
/* ------------------------------------------------------------------ */

function renderQuote(
  node: Extract<BlockNode, { type: "quote" }>,
  options: RenderOptions,
): string[] {
  const glyphs = options.unicode === false ? ASCII_GLYPHS : UNICODE_GLYPHS

  const marker = options.style.quote + glyphs.quote + options.style.reset

  // The children are rendered at a reduced width and then prefixed, rather than
  // rendered with the prefix already applied. Doing it the other way makes the
  // wrap width wrong for anything nested more than one level deep.
  const inner = render(node.children, {
    ...options,
    width: options.width - stringWidth(glyphs.quote) - stringWidth(options.prefix ?? ""),
    prefix: "",
  })

  return inner.map((line) => (options.prefix ?? "") + marker + line)
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

function renderList(
  node: Extract<BlockNode, { type: "list" }>,
  options: RenderOptions,
  depth = 0,
): string[] {
  const glyphs = options.unicode === false ? ASCII_GLYPHS : UNICODE_GLYPHS
  const basePrefix = options.prefix ?? ""

  const lines: string[] = []

  // Ordered lists are aligned on the widest marker so the text of every item
  // starts in the same column. Without this, item 9 and item 10 are offset by
  // one and the list looks ragged.
  const widest = node.ordered
    ? String(node.start + node.items.length - 1).length + 2
    : 2

  let counter = node.start

  for (let index = 0; index < node.items.length; index++) {
    const item = node.items[index]!

    let marker: string

    if (item.checked !== undefined) {
      marker = (item.checked ? glyphs.checked : glyphs.unchecked) + " "
    } else if (node.ordered) {
      marker = String(counter) + "."
      marker = marker + " ".repeat(Math.max(1, widest - marker.length))
      counter++
    } else {
      marker = glyphs.bullet[depth % glyphs.bullet.length]! + " "
    }

    const styled = options.style.bullet + marker + options.style.reset
    const continuation = " ".repeat(stringWidth(marker))

    const rendered = render(item.children, {
      ...options,
      width: options.width - stringWidth(basePrefix) - stringWidth(marker),
      prefix: "",
    })

    // Loose lists keep the blank lines between items; tight ones drop them.
    const body = node.tight ? rendered.filter((line, position) => line !== "" || position === 0) : rendered

    for (let position = 0; position < body.length; position++) {
      lines.push(basePrefix + (position === 0 ? styled : continuation) + body[position]!)
    }

    // An empty item still occupies a line, or the markers would collapse
    // together and the list would lose its shape.
    if (body.length === 0) lines.push(basePrefix + styled)
  }

  return lines
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

/**
 * Renders a table with box-drawing borders.
 *
 * Column widths are computed from the content and then reduced proportionally
 * if the total exceeds the available width. Reducing proportionally rather than
 * truncating the last column keeps a wide table readable instead of turning its
 * final column into ellipses.
 */
function renderTable(
  node: Extract<BlockNode, { type: "table" }>,
  options: RenderOptions,
): string[] {
  const glyphs = options.unicode === false ? ASCII_GLYPHS : UNICODE_GLYPHS
  const prefix = options.prefix ?? ""

  const columns = node.header.length

  if (columns === 0) return []

  const headerText = node.header.map((cell) => renderInline(cell, options))
  const rowText = node.rows.map((row) => row.map((cell) => renderInline(cell, options)))

  const widths: number[] = []

  for (let column = 0; column < columns; column++) {
    let widest = visibleWidth(headerText[column] ?? "")

    for (const row of rowText) {
      widest = Math.max(widest, visibleWidth(row[column] ?? ""))
    }

    widths.push(widest)
  }

  // Borders and padding: one vertical per column boundary, two spaces of
  // padding per cell.
  const overhead = columns * 3 + 1
  const available = options.width - stringWidth(prefix) - overhead

  let total = widths.reduce((sum, width) => sum + width, 0)

  if (total > available && available > columns) {
    // Shrink the widest columns first. Narrow columns are usually identifiers
    // or numbers where every character matters; wide ones are prose that
    // survives truncation.
    while (total > available) {
      let widest = 0

      for (let column = 1; column < columns; column++) {
        if (widths[column]! > widths[widest]!) widest = column
      }

      if (widths[widest]! <= 3) break

      widths[widest]!--
      total--
    }
  }

  const border = options.style.tableBorder
  const reset = options.style.reset

  const line = (left: string, middle: string, right: string) =>
    prefix +
    border +
    left +
    widths.map((width) => glyphs.horizontal.repeat(width + 2)).join(middle) +
    right +
    reset

  const lines: string[] = []

  lines.push(line(glyphs.topLeft, glyphs.teeDown, glyphs.topRight))

  lines.push(
    renderRow(headerText, widths, node.align, glyphs, options, prefix, options.style.tableHeader),
  )

  lines.push(line(glyphs.teeRight, glyphs.cross, glyphs.teeLeft))

  for (const row of rowText) {
    lines.push(renderRow(row, widths, node.align, glyphs, options, prefix, ""))
  }

  lines.push(line(glyphs.bottomLeft, glyphs.teeUp, glyphs.bottomRight))

  return lines
}

function renderRow(
  cells: string[],
  widths: number[],
  align: Alignment[],
  glyphs: typeof UNICODE_GLYPHS,
  options: RenderOptions,
  prefix: string,
  cellStyle: string,
): string {
  const border = options.style.tableBorder + glyphs.vertical + options.style.reset

  const parts = widths.map((width, column) => {
    const content = truncateVisible(cells[column] ?? "", width)
    const padded = pad(content, width, align[column] ?? "none")

    return " " + (cellStyle ? cellStyle + padded + options.style.reset : padded) + " "
  })

  return prefix + border + parts.join(border) + border
}

function pad(text: string, width: number, alignment: Alignment): string {
  const gap = width - visibleWidth(text)

  if (gap <= 0) return text

  if (alignment === "right") return " ".repeat(gap) + text

  if (alignment === "center") {
    const left = Math.floor(gap / 2)

    return " ".repeat(left) + text + " ".repeat(gap - left)
  }

  return text + " ".repeat(gap)
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

function renderRule(options: RenderOptions): string[] {
  const glyphs = options.unicode === false ? ASCII_GLYPHS : UNICODE_GLYPHS
  const prefix = options.prefix ?? ""
  const width = Math.max(0, options.width - stringWidth(prefix))

  return [prefix + options.style.rule + glyphs.rule.repeat(width) + options.style.reset]
}

/* ------------------------------------------------------------------ */
/* Inline rendering                                                    */
/* ------------------------------------------------------------------ */

/**
 * Renders inline nodes to a styled string.
 *
 * Each style is closed immediately, which produces slightly longer output than
 * tracking open styles across nodes but makes it impossible for a style to escape
 * its node. Given how visible that failure is, the extra bytes are worth it.
 */
export function renderInline(nodes: readonly InlineNode[], options: RenderOptions): string {
  const style = options.style

  let result = ""

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result += node.text
        break

      case "strong":
        result += style.strong + renderInline(node.children, options) + style.reset
        break

      case "emphasis":
        result += style.emphasis + renderInline(node.children, options) + style.reset
        break

      case "strike":
        result += style.strike + renderInline(node.children, options) + style.reset
        break

      case "code":
        result += style.code + node.text + style.reset
        break

      case "link": {
        const label = renderInline(node.children, options)

        result += style.link + label + style.reset

        // The target is appended only when it adds information. A link whose
        // text is already the URL would otherwise be printed twice, which is
        // extremely common in model output.
        if (options.showLinks !== false && node.href && inlineText(node.children) !== node.href) {
          result += " (" + node.href + ")"
        }

        break
      }

      case "image":
        // Terminals cannot show images. The alt text plus a marker is the most
        // useful thing available.
        result += style.link + "[image: " + (node.alt || node.src) + "]" + style.reset
        break

      case "break":
        result += "\n"
        break
    }
  }

  return result
}

/* ------------------------------------------------------------------ */
/* Width-aware text handling                                           */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g

/** Visible width, ignoring escape sequences. */
function visibleWidth(text: string): number {
  return stringWidth(text.replace(ANSI, ""))
}

/**
 * Wraps text to a width, preserving escape sequences.
 *
 * Breaks on spaces where possible and mid-word only when a single word is wider
 * than the line. Escape sequences are carried through without being counted, which
 * is the whole reason this cannot use a generic word-wrap.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text]

  const lines: string[] = []

  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("")
      continue
    }

    if (visibleWidth(paragraph) <= width) {
      lines.push(paragraph)
      continue
    }

    let current = ""
    let currentWidth = 0

    for (const word of paragraph.split(" ")) {
      const wordWidth = visibleWidth(word)

      if (currentWidth > 0 && currentWidth + 1 + wordWidth > width) {
        lines.push(current)
        current = ""
        currentWidth = 0
      }

      // A word too wide for a whole line is split. Rare in prose, common in
      // output containing long paths or URLs.
      if (wordWidth > width) {
        if (current !== "") {
          lines.push(current)
          current = ""
          currentWidth = 0
        }

        for (const chunk of splitWide(word, width)) {
          lines.push(chunk)
        }

        continue
      }

      if (currentWidth > 0) {
        current += " "
        currentWidth += 1
      }

      current += word
      currentWidth += wordWidth
    }

    if (current !== "") lines.push(current)
  }

  return lines
}

function splitWide(word: string, width: number): string[] {
  const chunks: string[] = []

  let current = ""
  let currentWidth = 0
  let index = 0

  while (index < word.length) {
    // Escape sequences are copied whole and cost no width.
    ANSI.lastIndex = index

    const match = ANSI.exec(word)

    if (match && match.index === index) {
      current += match[0]
      index += match[0].length

      continue
    }

    const character = word[index]!
    const characterWidth = stringWidth(character)

    if (currentWidth + characterWidth > width) {
      chunks.push(current)
      current = ""
      currentWidth = 0
    }

    current += character
    currentWidth += characterWidth
    index++
  }

  if (current !== "") chunks.push(current)

  return chunks
}

/**
 * Truncates to a visible width, appending an ellipsis.
 *
 * Escape sequences pass through without consuming width, and a reset is
 * appended if any style was opened, so a truncated cell cannot leak colour into
 * the rest of the row.
 */
export function truncateVisible(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text
  if (width <= 1) return "\u2026"

  let result = ""
  let used = 0
  let index = 0
  let styled = false

  while (index < text.length) {
    ANSI.lastIndex = index

    const match = ANSI.exec(text)

    if (match && match.index === index) {
      result += match[0]
      styled = true
      index += match[0].length

      continue
    }

    const character = text[index]!
    const characterWidth = stringWidth(character)

    if (used + characterWidth > width - 1) break

    result += character
    used += characterWidth
    index++
  }

  return result + "\u2026" + (styled ? "\u001b[0m" : "")
}
