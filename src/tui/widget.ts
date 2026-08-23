/**
 * Composable terminal widgets.
 *
 * Each widget takes a region of the screen buffer and draws into it. Widgets do
 * not own state beyond what they are given; the caller holds the state and passes
 * it in on each frame. That makes redrawing idempotent, which is what allows the
 * whole interface to be re-rendered from scratch on every frame without keeping
 * track of what changed.
 *
 * Redrawing everything sounds wasteful and is not, because the buffer layer
 * diffs the result against the previous frame and emits only the cells that
 * differ. The alternative \u2014 widgets that track their own dirty regions \u2014 is where
 * terminal interfaces accumulate rendering bugs that only appear after a specific
 * sequence of resizes and scrolls.
 */

import { stringWidth } from "../util/wcwidth.js"
import type { Buffer, Cell } from "./buffer.js"
import type { Rect } from "./layout.js"

/* ------------------------------------------------------------------ */
/* Style                                                               */
/* ------------------------------------------------------------------ */

export interface Style {
  readonly fg?: string
  readonly bg?: string
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly reverse?: boolean
  readonly strike?: boolean
}

export const EMPTY_STYLE: Style = {}

/* ------------------------------------------------------------------ */
/* Borders                                                             */
/* ------------------------------------------------------------------ */

export interface BorderSet {
  readonly topLeft: string
  readonly topRight: string
  readonly bottomLeft: string
  readonly bottomRight: string
  readonly horizontal: string
  readonly vertical: string
  readonly teeLeft: string
  readonly teeRight: string
  readonly teeUp: string
  readonly teeDown: string
  readonly cross: string
}

export const BORDERS: Record<string, BorderSet> = {
  single: {
    topLeft: "\u250c", topRight: "\u2510", bottomLeft: "\u2514", bottomRight: "\u2518",
    horizontal: "\u2500", vertical: "\u2502",
    teeLeft: "\u2524", teeRight: "\u251c", teeUp: "\u2534", teeDown: "\u252c", cross: "\u253c",
  },
  rounded: {
    topLeft: "\u256d", topRight: "\u256e", bottomLeft: "\u2570", bottomRight: "\u256f",
    horizontal: "\u2500", vertical: "\u2502",
    teeLeft: "\u2524", teeRight: "\u251c", teeUp: "\u2534", teeDown: "\u252c", cross: "\u253c",
  },
  double: {
    topLeft: "\u2554", topRight: "\u2557", bottomLeft: "\u255a", bottomRight: "\u255d",
    horizontal: "\u2550", vertical: "\u2551",
    teeLeft: "\u2563", teeRight: "\u2560", teeUp: "\u2569", teeDown: "\u2566", cross: "\u256c",
  },
  heavy: {
    topLeft: "\u250f", topRight: "\u2513", bottomLeft: "\u2517", bottomRight: "\u251b",
    horizontal: "\u2501", vertical: "\u2503",
    teeLeft: "\u252b", teeRight: "\u2523", teeUp: "\u253b", teeDown: "\u2533", cross: "\u254b",
  },
  ascii: {
    topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+",
    horizontal: "-", vertical: "|",
    teeLeft: "+", teeRight: "+", teeUp: "+", teeDown: "+", cross: "+",
  },
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/**
 * Draws a single line of text, clipped to the region.
 *
 * Characters that would overflow are dropped rather than wrapped. A widget that
 * silently wraps text it was told to fit on one line breaks every layout
 * calculation around it.
 *
 * Double-width characters are handled by writing the glyph in the first cell and
 * a continuation marker in the second. Without that, a CJK character occupies one
 * buffer cell but two terminal columns, and every subsequent cell on the line is
 * drawn one column to the right of where the buffer thinks it is.
 */
export function drawText(
  buffer: Buffer,
  x: number,
  y: number,
  text: string,
  style: Style = EMPTY_STYLE,
  maxWidth?: number,
): number {
  const limit = maxWidth ?? buffer.width - x

  if (limit <= 0) return 0

  let column = 0

  for (const character of text) {
    const width = stringWidth(character)

    if (column + width > limit) break

    // Control characters would corrupt the terminal state. Replacing rather
    // than dropping keeps column arithmetic honest.
    const glyph = character.codePointAt(0)! < 0x20 ? "\ufffd" : character

    buffer.set(x + column, y, { char: glyph, ...style })

    if (width === 2) {
      buffer.set(x + column + 1, y, { char: "", ...style, continuation: true })
    }

    column += width
  }

  return column
}

/**
 * Draws text centred within a width.
 *
 * Rounds the leading pad down, so an odd remainder puts the extra space on the
 * right. Consistency matters more than which side gets it; alternating would make
 * a title jitter as its length changes during streaming.
 */
export function drawCentered(
  buffer: Buffer,
  rect: Rect,
  y: number,
  text: string,
  style: Style = EMPTY_STYLE,
): void {
  const width = stringWidth(text)
  const offset = Math.max(0, Math.floor((rect.width - width) / 2))

  drawText(buffer, rect.x + offset, y, text, style, rect.width - offset)
}

/** Draws text right-aligned within a width. */
export function drawRight(
  buffer: Buffer,
  rect: Rect,
  y: number,
  text: string,
  style: Style = EMPTY_STYLE,
): void {
  const width = stringWidth(text)
  const offset = Math.max(0, rect.width - width)

  drawText(buffer, rect.x + offset, y, text, style, rect.width - offset)
}

/* ------------------------------------------------------------------ */
/* Fill                                                                */
/* ------------------------------------------------------------------ */

/** Fills a region with a character. */
export function fill(buffer: Buffer, rect: Rect, char = " ", style: Style = EMPTY_STYLE): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      buffer.set(x, y, { char, ...style })
    }
  }
}

/**
 * Clears a region.
 *
 * Distinct from filling with a space, because a cleared cell carries no
 * background colour and a filled one does. Using fill where clear was meant leaves
 * coloured rectangles behind when a dialog closes.
 */
export function clear(buffer: Buffer, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      buffer.set(x, y, { char: " " })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Boxes                                                               */
/* ------------------------------------------------------------------ */

export interface BoxOptions {
  readonly border?: BorderSet
  readonly style?: Style
  readonly title?: string
  readonly titleStyle?: Style
  readonly footer?: string
  readonly footerStyle?: Style
  /** Fill the interior rather than leaving it untouched. */
  readonly fillInterior?: boolean
}

/**
 * Draws a bordered box and returns its interior region.
 *
 * Returning the interior rather than requiring the caller to compute it is a
 * small thing that prevents a recurring off-by-one: the interior is inset by one
 * on every side, and getting that wrong draws content over the border.
 *
 * A box narrower than three columns cannot hold a border and content, so the
 * border is skipped and the whole region is returned. Drawing a degenerate box
 * looks like a rendering bug; quietly using the space does not.
 */
export function drawBox(buffer: Buffer, rect: Rect, options: BoxOptions = {}): Rect {
  if (rect.width < 3 || rect.height < 3) {
    if (options.fillInterior) fill(buffer, rect, " ", options.style)

    return rect
  }

  const border = options.border ?? BORDERS.single!
  const style = options.style ?? EMPTY_STYLE

  const right = rect.x + rect.width - 1
  const bottom = rect.y + rect.height - 1

  buffer.set(rect.x, rect.y, { char: border.topLeft, ...style })
  buffer.set(right, rect.y, { char: border.topRight, ...style })
  buffer.set(rect.x, bottom, { char: border.bottomLeft, ...style })
  buffer.set(right, bottom, { char: border.bottomRight, ...style })

  for (let x = rect.x + 1; x < right; x++) {
    buffer.set(x, rect.y, { char: border.horizontal, ...style })
    buffer.set(x, bottom, { char: border.horizontal, ...style })
  }

  for (let y = rect.y + 1; y < bottom; y++) {
    buffer.set(rect.x, y, { char: border.vertical, ...style })
    buffer.set(right, y, { char: border.vertical, ...style })
  }

  const interior: Rect = {
    x: rect.x + 1,
    y: rect.y + 1,
    width: rect.width - 2,
    height: rect.height - 2,
  }

  if (options.fillInterior) fill(buffer, interior, " ", style)

  if (options.title) {
    // The title is inset by two and padded with spaces, so the border does not
    // touch the text. Truncated with an ellipsis rather than overflowing into
    // the corner glyph.
    const room = rect.width - 6

    if (room > 0) {
      const text =
        stringWidth(options.title) > room
          ? options.title.slice(0, Math.max(1, room - 1)) + "\u2026"
          : options.title

      drawText(buffer, rect.x + 2, rect.y, " " + text + " ", options.titleStyle ?? style, room + 2)
    }
  }

  if (options.footer) {
    const room = rect.width - 6

    if (room > 0) {
      const text =
        stringWidth(options.footer) > room
          ? options.footer.slice(0, Math.max(1, room - 1)) + "\u2026"
          : options.footer

      const width = stringWidth(text) + 2

      drawText(
        buffer,
        rect.x + rect.width - 2 - width,
        bottom,
        " " + text + " ",
        options.footerStyle ?? style,
        width,
      )
    }
  }

  return interior
}

/**
 * Draws a horizontal separator with an optional label.
 *
 * The label sits at the left rather than centred, because separators are read
 * as section headings and a left-aligned heading is easier to scan down a column.
 */
export function drawSeparator(
  buffer: Buffer,
  rect: Rect,
  y: number,
  style: Style = EMPTY_STYLE,
  label?: string,
  border: BorderSet = BORDERS.single!,
): void {
  for (let x = rect.x; x < rect.x + rect.width; x++) {
    buffer.set(x, y, { char: border.horizontal, ...style })
  }

  if (label && rect.width > stringWidth(label) + 4) {
    drawText(buffer, rect.x + 2, y, " " + label + " ", style)
  }
}

/* ------------------------------------------------------------------ */
/* Scrollbar                                                           */
/* ------------------------------------------------------------------ */

/**
 * Draws a vertical scrollbar.
 *
 * The thumb is at least one cell tall even when the content is enormous, so it
 * never disappears. Its position is computed from the scroll offset rather than
 * from the thumb's own rounded size, which keeps it at the very bottom when the
 * view is scrolled to the end \u2014 a thumb that stops one cell short of the bottom
 * makes people think there is more content below.
 */
export function drawScrollbar(
  buffer: Buffer,
  x: number,
  rect: Rect,
  offset: number,
  total: number,
  style: Style = EMPTY_STYLE,
  thumbStyle: Style = EMPTY_STYLE,
): void {
  const height = rect.height

  if (height <= 0) return

  // No scrollbar when everything fits. Drawing a full-height thumb is visual
  // noise that suggests scrollable content where there is none.
  if (total <= height) return

  const thumbHeight = Math.max(1, Math.floor((height * height) / total))
  const maxOffset = total - height
  const ratio = maxOffset <= 0 ? 0 : Math.min(1, Math.max(0, offset / maxOffset))
  const thumbTop = Math.round(ratio * (height - thumbHeight))

  for (let index = 0; index < height; index++) {
    const inThumb = index >= thumbTop && index < thumbTop + thumbHeight

    buffer.set(x, rect.y + index, {
      char: inThumb ? "\u2588" : "\u2502",
      ...(inThumb ? thumbStyle : style),
    })
  }
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

export interface ListItem {
  readonly text: string
  readonly detail?: string
  readonly icon?: string
  readonly style?: Style
  readonly disabled?: boolean
  /** Character positions to highlight, from a fuzzy match. */
  readonly highlights?: readonly number[]
}

export interface ListOptions {
  readonly selected: number
  readonly offset: number
  readonly selectedStyle?: Style
  readonly normalStyle?: Style
  readonly detailStyle?: Style
  readonly highlightStyle?: Style
  readonly disabledStyle?: Style
  readonly showScrollbar?: boolean
  readonly cursor?: string
}

/**
 * Draws a scrollable list.
 *
 * The selection marker occupies its own column rather than replacing the first
 * character of the item, so items do not shift horizontally as the selection
 * moves. That shift is subtle and makes a list feel unstable to read.
 */
export function drawList(
  buffer: Buffer,
  rect: Rect,
  items: readonly ListItem[],
  options: ListOptions,
): void {
  const cursor = options.cursor ?? "\u276f"
  const scrollbarWidth = options.showScrollbar && items.length > rect.height ? 1 : 0
  const contentWidth = rect.width - 2 - scrollbarWidth

  if (contentWidth <= 0) return

  for (let row = 0; row < rect.height; row++) {
    const index = options.offset + row
    const item = items[index]

    if (!item) break

    const y = rect.y + row
    const isSelected = index === options.selected

    const style = item.disabled
      ? (options.disabledStyle ?? EMPTY_STYLE)
      : isSelected
        ? (options.selectedStyle ?? EMPTY_STYLE)
        : (item.style ?? options.normalStyle ?? EMPTY_STYLE)

    // The whole row is painted with the selection background before the text,
    // so the highlight extends to the right edge rather than stopping at the
    // end of the label.
    if (isSelected && style.bg) {
      fill(buffer, { x: rect.x, y, width: rect.width - scrollbarWidth, height: 1 }, " ", style)
    }

    drawText(buffer, rect.x, y, isSelected ? cursor : " ", style, 1)

    let column = rect.x + 2

    if (item.icon) {
      column += drawText(buffer, column, y, item.icon + " ", style, contentWidth)
    }

    const available = rect.x + 2 + contentWidth - column

    if (item.highlights && item.highlights.length > 0 && options.highlightStyle) {
      drawHighlighted(buffer, column, y, item.text, item.highlights, style, options.highlightStyle, available)
    } else {
      drawText(buffer, column, y, item.text, style, available)
    }

    if (item.detail) {
      const detailWidth = stringWidth(item.detail)
      const detailX = rect.x + rect.width - scrollbarWidth - detailWidth - 1

      // Only drawn when it will not collide with the label. A detail that
      // overlaps the text it describes is worse than no detail at all.
      if (detailX > column + stringWidth(item.text) + 2) {
        drawText(buffer, detailX, y, item.detail, options.detailStyle ?? style, detailWidth)
      }
    }
  }

  if (scrollbarWidth > 0) {
    drawScrollbar(buffer, rect.x + rect.width - 1, rect, options.offset, items.length)
  }
}

/**
 * Draws text with certain character positions emphasised.
 *
 * Used for fuzzy-match highlighting, where showing which characters matched is
 * what makes a non-obvious ranking comprehensible.
 */
export function drawHighlighted(
  buffer: Buffer,
  x: number,
  y: number,
  text: string,
  positions: readonly number[],
  style: Style,
  highlightStyle: Style,
  maxWidth: number,
): void {
  const marked = new Set(positions)

  let column = 0
  let index = 0

  for (const character of text) {
    const width = stringWidth(character)

    if (column + width > maxWidth) break

    const cellStyle = marked.has(index) ? { ...style, ...highlightStyle } : style

    buffer.set(x + column, y, { char: character, ...cellStyle })

    if (width === 2) {
      buffer.set(x + column + 1, y, { char: "", ...cellStyle, continuation: true })
    }

    column += width
    index++
  }
}

/**
 * Computes the scroll offset that keeps a selection visible.
 *
 * Scrolls by the minimum needed rather than recentring, which keeps the
 * surrounding context stable as the selection moves through a long list.
 */
export function scrollToShow(
  selected: number,
  offset: number,
  height: number,
  total: number,
): number {
  if (height <= 0 || total <= height) return 0

  if (selected < offset) return selected

  if (selected >= offset + height) return selected - height + 1

  // Clamp when the list has shrunk beneath the current offset, which happens
  // when a filter removes items.
  return Math.min(offset, Math.max(0, total - height))
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

/**
 * Draws a progress bar using partial block characters.
 *
 * The eighth-block glyphs give eight times the resolution of a plain bar, which
 * is the difference between a bar that appears to move continuously and one that
 * jumps in visible steps on a narrow terminal.
 */
export function drawProgress(
  buffer: Buffer,
  x: number,
  y: number,
  width: number,
  ratio: number,
  style: Style = EMPTY_STYLE,
  trackStyle: Style = EMPTY_STYLE,
): void {
  if (width <= 0) return

  const clamped = Math.max(0, Math.min(1, ratio))
  const exact = clamped * width
  const full = Math.floor(exact)
  const remainder = exact - full

  const partials = ["", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589"]
  const partial = partials[Math.floor(remainder * 8)] ?? ""

  for (let index = 0; index < width; index++) {
    if (index < full) {
      buffer.set(x + index, y, { char: "\u2588", ...style })
    } else if (index === full && partial !== "") {
      buffer.set(x + index, y, { char: partial, ...style })
    } else {
      buffer.set(x + index, y, { char: "\u2591", ...trackStyle })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

/**
 * Draws a small labelled badge.
 *
 * Used for status pills in the header. Returns the width consumed so callers
 * can lay out a row of them without measuring each one again.
 */
export function drawBadge(
  buffer: Buffer,
  x: number,
  y: number,
  label: string,
  style: Style,
  maxWidth: number,
): number {
  const text = " " + label + " "

  if (stringWidth(text) > maxWidth) return 0

  return drawText(buffer, x, y, text, style, maxWidth)
}

/**
 * Draws a key hint such as "^C exit".
 *
 * The key and its description get different styles, which is what makes a row
 * of hints scannable rather than a wall of text.
 */
export function drawKeyHint(
  buffer: Buffer,
  x: number,
  y: number,
  key: string,
  description: string,
  keyStyle: Style,
  descriptionStyle: Style,
  maxWidth: number,
): number {
  const total = stringWidth(key) + 1 + stringWidth(description)

  if (total > maxWidth) return 0

  let column = drawText(buffer, x, y, key, keyStyle, maxWidth)

  column += drawText(buffer, x + column, y, " " + description, descriptionStyle, maxWidth - column)

  return column
}

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

/**
 * Dims a region by applying a style to every cell without changing characters.
 *
 * Used behind modal dialogs. Dimming rather than clearing keeps the context
 * visible, which helps people remember what they were doing when a permission
 * prompt interrupts them.
 */
export function dim(buffer: Buffer, rect: Rect, style: Style): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const cell = buffer.get(x, y)

      if (!cell) continue

      buffer.set(x, y, { ...cell, ...style } as Cell)
    }
  }
}

/**
 * Draws a shadow below and to the right of a region.
 *
 * Purely decorative, and skipped on terminals without colour. It costs two
 * cells of space and makes a floating dialog read as floating rather than as a
 * hole punched in the content.
 */
export function drawShadow(buffer: Buffer, rect: Rect, style: Style): void {
  for (let x = rect.x + 1; x < rect.x + rect.width + 1; x++) {
    const y = rect.y + rect.height
    const cell = buffer.get(x, y)

    if (cell) buffer.set(x, y, { ...cell, ...style } as Cell)
  }

  for (let y = rect.y + 1; y < rect.y + rect.height + 1; y++) {
    const x = rect.x + rect.width
    const cell = buffer.get(x, y)

    if (cell) buffer.set(x, y, { ...cell, ...style } as Cell)
  }
}
