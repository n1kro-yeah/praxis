/**
 * The multi-line prompt editor.
 *
 * A text buffer with a cursor, selection, undo history, and the readline motions
 * people expect in a terminal input. This is the widget the user spends most of
 * their time in, so it gets the detail: word-wise motion that matches what other
 * terminal programs do, an undo history that groups related edits instead of
 * undoing character by character, and bracketed-paste handling that inserts a
 * multi-line paste as one operation.
 *
 * The buffer is stored as an array of lines rather than one string with newlines.
 * Rendering needs per-line access on every frame, and splitting a large string on
 * every keystroke to get it is the difference between an editor that feels instant
 * and one that lags on a long prompt.
 *
 * Column positions are in code points, not grapheme clusters. A cursor placed
 * inside a family emoji will therefore split it. Fixing that properly needs full
 * grapheme segmentation, which is a large amount of table data for a case that
 * arises rarely in a coding prompt.
 */

import { stringWidth } from "../util/wcwidth.js"

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/** Undo states retained. Beyond this the oldest are dropped. */
const MAX_UNDO_DEPTH = 200

/**
 * How long edits may be apart and still merge into one undo step.
 *
 * Typing a word then pausing then typing another should undo as two steps, not
 * one giant one and not twenty single characters. Half a second matches the pause
 * people naturally take between thoughts.
 */
const UNDO_MERGE_WINDOW_MS = 500

/** Cap on buffer size, to keep a runaway paste from exhausting memory. */
const MAX_BUFFER_LENGTH = 4 * 1024 * 1024

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface Position {
  readonly line: number
  readonly column: number
}

export interface Selection {
  readonly anchor: Position
  readonly head: Position
}

interface Snapshot {
  readonly lines: string[]
  readonly cursor: Position
  readonly at: number
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export class Editor {
  private lines: string[] = [""]
  private cursorLine = 0
  private cursorColumn = 0
  private anchor: Position | undefined
  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private lastEditAt = 0

  /**
   * The column the cursor wants to be in during vertical motion.
   *
   * Moving down from a long line onto a short one and back should return to the
   * original column. Without remembering the desired column, the cursor gets
   * clamped by the short line and the position is lost permanently, which is one
   * of those small things that makes an editor feel wrong.
   */
  private desiredColumn: number | undefined

  constructor(initial = "") {
    if (initial !== "") this.setText(initial)
  }

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  text(): string {
    return this.lines.join("\n")
  }

  lineAt(index: number): string {
    return this.lines[index] ?? ""
  }

  lineCount(): number {
    return this.lines.length
  }

  allLines(): readonly string[] {
    return this.lines
  }

  cursor(): Position {
    return { line: this.cursorLine, column: this.cursorColumn }
  }

  isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0] === ""
  }

  selection(): Selection | undefined {
    if (!this.anchor) return undefined

    const head = this.cursor()

    // A selection collapsed onto itself is not a selection. Reporting one would
    // make copy and delete operate on nothing while appearing to be active.
    if (this.anchor.line === head.line && this.anchor.column === head.column) return undefined

    return { anchor: this.anchor, head }
  }

  /** The selected text, or an empty string when nothing is selected. */
  selectedText(): string {
    const selection = this.selection()

    if (!selection) return ""

    const [from, to] = order(selection.anchor, selection.head)

    if (from.line === to.line) {
      return this.lineAt(from.line).slice(from.column, to.column)
    }

    const parts: string[] = [this.lineAt(from.line).slice(from.column)]

    for (let index = from.line + 1; index < to.line; index++) {
      parts.push(this.lineAt(index))
    }

    parts.push(this.lineAt(to.line).slice(0, to.column))

    return parts.join("\n")
  }

  /* ---------------------------------------------------------------- */
  /* Writing                                                           */
  /* ---------------------------------------------------------------- */

  setText(value: string): void {
    this.pushUndo(true)

    const clipped = value.length > MAX_BUFFER_LENGTH ? value.slice(0, MAX_BUFFER_LENGTH) : value

    // Carriage returns are stripped rather than preserved. They come from
    // pasting Windows-formatted text and would otherwise render as stray
    // characters and corrupt column arithmetic.
    this.lines = clipped.replace(/\r\n?/g, "\n").split("\n")

    this.cursorLine = this.lines.length - 1
    this.cursorColumn = this.lineAt(this.cursorLine).length
    this.anchor = undefined
    this.desiredColumn = undefined
  }

  clear(): void {
    this.pushUndo(true)

    this.lines = [""]
    this.cursorLine = 0
    this.cursorColumn = 0
    this.anchor = undefined
    this.desiredColumn = undefined
  }

  /**
   * Inserts text at the cursor, replacing any selection.
   *
   * Handles multi-line input in one operation, which is what makes a paste a
   * single undo step rather than one per line.
   */
  insert(value: string): void {
    if (value === "") return

    this.pushUndo()
    this.deleteSelectionInternal()

    const normalised = value.replace(/\r\n?/g, "\n")

    if (this.text().length + normalised.length > MAX_BUFFER_LENGTH) return

    const line = this.lineAt(this.cursorLine)
    const before = line.slice(0, this.cursorColumn)
    const after = line.slice(this.cursorColumn)

    if (!normalised.includes("\n")) {
      this.lines[this.cursorLine] = before + normalised + after
      this.cursorColumn += normalised.length
      this.desiredColumn = undefined

      return
    }

    const inserted = normalised.split("\n")

    const first = before + inserted[0]!
    const last = inserted[inserted.length - 1]! + after

    const middle = inserted.slice(1, -1)

    this.lines.splice(this.cursorLine, 1, first, ...middle, last)

    this.cursorLine += inserted.length - 1
    this.cursorColumn = inserted[inserted.length - 1]!.length
    this.desiredColumn = undefined
  }

  /** Inserts a newline, preserving the current line's leading whitespace. */
  newline(preserveIndent = true): void {
    this.pushUndo()
    this.deleteSelectionInternal()

    const line = this.lineAt(this.cursorLine)

    // Carrying the indentation forward is what makes typing a code block in the
    // prompt bearable. Only whitespace up to the cursor is carried, so splitting
    // a line in the middle does not indent the remainder unexpectedly.
    const indent = preserveIndent ? (/^[ \t]*/.exec(line.slice(0, this.cursorColumn))?.[0] ?? "") : ""

    const before = line.slice(0, this.cursorColumn)
    const after = indent + line.slice(this.cursorColumn)

    this.lines.splice(this.cursorLine, 1, before, after)

    this.cursorLine++
    this.cursorColumn = indent.length
    this.desiredColumn = undefined
  }

  /** Deletes the character before the cursor, or the selection. */
  backspace(): void {
    if (this.selection()) {
      this.deleteSelection()

      return
    }

    if (this.cursorColumn === 0 && this.cursorLine === 0) return

    this.pushUndo()

    if (this.cursorColumn === 0) {
      const previous = this.lineAt(this.cursorLine - 1)

      this.cursorColumn = previous.length
      this.lines[this.cursorLine - 1] = previous + this.lineAt(this.cursorLine)
      this.lines.splice(this.cursorLine, 1)
      this.cursorLine--
    } else {
      const line = this.lineAt(this.cursorLine)

      this.lines[this.cursorLine] =
        line.slice(0, this.cursorColumn - 1) + line.slice(this.cursorColumn)

      this.cursorColumn--
    }

    this.desiredColumn = undefined
  }

  /** Deletes the character at the cursor, or the selection. */
  delete(): void {
    if (this.selection()) {
      this.deleteSelection()

      return
    }

    const line = this.lineAt(this.cursorLine)

    if (this.cursorColumn >= line.length && this.cursorLine >= this.lines.length - 1) return

    this.pushUndo()

    if (this.cursorColumn >= line.length) {
      this.lines[this.cursorLine] = line + this.lineAt(this.cursorLine + 1)
      this.lines.splice(this.cursorLine + 1, 1)
    } else {
      this.lines[this.cursorLine] =
        line.slice(0, this.cursorColumn) + line.slice(this.cursorColumn + 1)
    }

    this.desiredColumn = undefined
  }

  /** Deletes the word before the cursor. */
  deleteWordBackward(): void {
    if (this.selection()) {
      this.deleteSelection()

      return
    }

    this.pushUndo()

    if (this.cursorColumn === 0) {
      this.backspaceRaw()

      return
    }

    const line = this.lineAt(this.cursorLine)
    const target = wordStart(line, this.cursorColumn)

    this.lines[this.cursorLine] = line.slice(0, target) + line.slice(this.cursorColumn)
    this.cursorColumn = target
    this.desiredColumn = undefined
  }

  /** Deletes the word after the cursor. */
  deleteWordForward(): void {
    if (this.selection()) {
      this.deleteSelection()

      return
    }

    this.pushUndo()

    const line = this.lineAt(this.cursorLine)

    if (this.cursorColumn >= line.length) {
      this.delete()

      return
    }

    const target = wordEnd(line, this.cursorColumn)

    this.lines[this.cursorLine] = line.slice(0, this.cursorColumn) + line.slice(target)
    this.desiredColumn = undefined
  }

  /** Deletes from the cursor to the end of the line. */
  deleteToLineEnd(): void {
    this.pushUndo()

    const line = this.lineAt(this.cursorLine)

    // At the end of a line this joins with the next, matching readline. Doing
    // nothing instead makes repeated presses appear broken.
    if (this.cursorColumn >= line.length) {
      if (this.cursorLine < this.lines.length - 1) {
        this.lines[this.cursorLine] = line + this.lineAt(this.cursorLine + 1)
        this.lines.splice(this.cursorLine + 1, 1)
      }

      return
    }

    this.lines[this.cursorLine] = line.slice(0, this.cursorColumn)
    this.desiredColumn = undefined
  }

  /** Deletes from the start of the line to the cursor. */
  deleteToLineStart(): void {
    this.pushUndo()

    const line = this.lineAt(this.cursorLine)

    this.lines[this.cursorLine] = line.slice(this.cursorColumn)
    this.cursorColumn = 0
    this.desiredColumn = undefined
  }

  deleteSelection(): void {
    if (!this.selection()) return

    this.pushUndo()
    this.deleteSelectionInternal()
  }

  private deleteSelectionInternal(): void {
    const selection = this.selection()

    if (!selection) return

    const [from, to] = order(selection.anchor, selection.head)

    const head = this.lineAt(from.line).slice(0, from.column)
    const tail = this.lineAt(to.line).slice(to.column)

    this.lines.splice(from.line, to.line - from.line + 1, head + tail)

    this.cursorLine = from.line
    this.cursorColumn = from.column
    this.anchor = undefined
    this.desiredColumn = undefined
  }

  private backspaceRaw(): void {
    if (this.cursorLine === 0) return

    const previous = this.lineAt(this.cursorLine - 1)

    this.cursorColumn = previous.length
    this.lines[this.cursorLine - 1] = previous + this.lineAt(this.cursorLine)
    this.lines.splice(this.cursorLine, 1)
    this.cursorLine--
  }

  /* ---------------------------------------------------------------- */
  /* Motion                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Moves the cursor.
   *
   * `extend` controls whether the selection grows. Every motion supports it,
   * which is what makes shift-arrow selection work without a separate code path
   * per direction.
   */
  moveLeft(extend = false): void {
    this.beforeMove(extend)

    if (this.cursorColumn > 0) {
      this.cursorColumn--
    } else if (this.cursorLine > 0) {
      this.cursorLine--
      this.cursorColumn = this.lineAt(this.cursorLine).length
    }

    this.desiredColumn = undefined
  }

  moveRight(extend = false): void {
    this.beforeMove(extend)

    const line = this.lineAt(this.cursorLine)

    if (this.cursorColumn < line.length) {
      this.cursorColumn++
    } else if (this.cursorLine < this.lines.length - 1) {
      this.cursorLine++
      this.cursorColumn = 0
    }

    this.desiredColumn = undefined
  }

  moveUp(extend = false): boolean {
    this.beforeMove(extend)

    // Returns false at the top so the caller can fall through to history
    // navigation. Swallowing the key instead makes the up arrow feel dead.
    if (this.cursorLine === 0) return false

    this.desiredColumn ??= this.cursorColumn
    this.cursorLine--
    this.cursorColumn = Math.min(this.desiredColumn, this.lineAt(this.cursorLine).length)

    return true
  }

  moveDown(extend = false): boolean {
    this.beforeMove(extend)

    if (this.cursorLine >= this.lines.length - 1) return false

    this.desiredColumn ??= this.cursorColumn
    this.cursorLine++
    this.cursorColumn = Math.min(this.desiredColumn, this.lineAt(this.cursorLine).length)

    return true
  }

  moveWordLeft(extend = false): void {
    this.beforeMove(extend)

    if (this.cursorColumn === 0) {
      if (this.cursorLine === 0) return

      this.cursorLine--
      this.cursorColumn = this.lineAt(this.cursorLine).length

      return
    }

    this.cursorColumn = wordStart(this.lineAt(this.cursorLine), this.cursorColumn)
    this.desiredColumn = undefined
  }

  moveWordRight(extend = false): void {
    this.beforeMove(extend)

    const line = this.lineAt(this.cursorLine)

    if (this.cursorColumn >= line.length) {
      if (this.cursorLine >= this.lines.length - 1) return

      this.cursorLine++
      this.cursorColumn = 0

      return
    }

    this.cursorColumn = wordEnd(line, this.cursorColumn)
    this.desiredColumn = undefined
  }

  /**
   * Moves to the start of the line.
   *
   * First press goes to the first non-whitespace character, second to column
   * zero. Matches what most editors do and is more useful than either alone when
   * working with indented text.
   */
  moveLineStart(extend = false): void {
    this.beforeMove(extend)

    const line = this.lineAt(this.cursorLine)
    const indent = (/^[ \t]*/.exec(line)?.[0] ?? "").length

    this.cursorColumn = this.cursorColumn === indent ? 0 : indent
    this.desiredColumn = undefined
  }

  moveLineEnd(extend = false): void {
    this.beforeMove(extend)

    this.cursorColumn = this.lineAt(this.cursorLine).length
    this.desiredColumn = undefined
  }

  moveBufferStart(extend = false): void {
    this.beforeMove(extend)

    this.cursorLine = 0
    this.cursorColumn = 0
    this.desiredColumn = undefined
  }

  moveBufferEnd(extend = false): void {
    this.beforeMove(extend)

    this.cursorLine = this.lines.length - 1
    this.cursorColumn = this.lineAt(this.cursorLine).length
    this.desiredColumn = undefined
  }

  moveTo(position: Position, extend = false): void {
    this.beforeMove(extend)

    this.cursorLine = clamp(position.line, 0, this.lines.length - 1)
    this.cursorColumn = clamp(position.column, 0, this.lineAt(this.cursorLine).length)
    this.desiredColumn = undefined
  }

  selectAll(): void {
    this.anchor = { line: 0, column: 0 }
    this.cursorLine = this.lines.length - 1
    this.cursorColumn = this.lineAt(this.cursorLine).length
  }

  clearSelection(): void {
    this.anchor = undefined
  }

  private beforeMove(extend: boolean): void {
    if (extend) {
      this.anchor ??= this.cursor()
    } else {
      this.anchor = undefined
    }
  }

  /* ---------------------------------------------------------------- */
  /* Undo                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Records a snapshot for undo.
   *
   * Consecutive edits within the merge window reuse the existing snapshot, so a
   * burst of typing undoes as one step. `force` bypasses that for operations like
   * a paste or a full replacement, which should always be their own step.
   *
   * Snapshots are full copies. That is wasteful in principle, and irrelevant in
   * practice: prompts are a few kilobytes and the depth is bounded, so the whole
   * history costs less than a single rendered frame.
   */
  private pushUndo(force = false): void {
    const now = Date.now()

    if (!force && now - this.lastEditAt < UNDO_MERGE_WINDOW_MS && this.undoStack.length > 0) {
      this.lastEditAt = now

      return
    }

    this.undoStack.push({
      lines: [...this.lines],
      cursor: this.cursor(),
      at: now,
    })

    if (this.undoStack.length > MAX_UNDO_DEPTH) this.undoStack.shift()

    // Any new edit invalidates the redo history. Keeping it would let a redo
    // jump to a state that no longer follows from the current text.
    this.redoStack = []
    this.lastEditAt = now
  }

  undo(): boolean {
    const snapshot = this.undoStack.pop()

    if (!snapshot) return false

    this.redoStack.push({
      lines: [...this.lines],
      cursor: this.cursor(),
      at: Date.now(),
    })

    this.lines = snapshot.lines
    this.cursorLine = clamp(snapshot.cursor.line, 0, this.lines.length - 1)
    this.cursorColumn = clamp(snapshot.cursor.column, 0, this.lineAt(this.cursorLine).length)
    this.anchor = undefined
    this.lastEditAt = 0

    return true
  }

  redo(): boolean {
    const snapshot = this.redoStack.pop()

    if (!snapshot) return false

    this.undoStack.push({
      lines: [...this.lines],
      cursor: this.cursor(),
      at: Date.now(),
    })

    this.lines = snapshot.lines
    this.cursorLine = clamp(snapshot.cursor.line, 0, this.lines.length - 1)
    this.cursorColumn = clamp(snapshot.cursor.column, 0, this.lineAt(this.cursorLine).length)
    this.anchor = undefined
    this.lastEditAt = 0

    return true
  }

  /* ---------------------------------------------------------------- */
  /* Layout                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Wraps the buffer to a width and reports where the cursor lands.
   *
   * The renderer needs both together: the wrapped lines to draw, and the visual
   * cursor position to place the terminal cursor. Computing them separately means
   * two passes over the same text and a real risk of them disagreeing.
   */
  layout(width: number): { rows: string[]; cursorRow: number; cursorColumn: number } {
    if (width <= 0) {
      return { rows: [...this.lines], cursorRow: this.cursorLine, cursorColumn: this.cursorColumn }
    }

    const rows: string[] = []

    let cursorRow = 0
    let cursorColumn = 0

    for (let index = 0; index < this.lines.length; index++) {
      const line = this.lines[index]!
      const wrapped = wrapLine(line, width)

      if (index === this.cursorLine) {
        // Find which wrapped segment holds the cursor by walking the segments
        // and accumulating their source lengths.
        let consumed = 0

        for (let segment = 0; segment < wrapped.length; segment++) {
          const text = wrapped[segment]!

          if (this.cursorColumn <= consumed + text.length) {
            cursorRow = rows.length + segment
            cursorColumn = stringWidth(text.slice(0, this.cursorColumn - consumed))

            break
          }

          consumed += text.length

          // The cursor past the end of the last segment sits at its end.
          if (segment === wrapped.length - 1) {
            cursorRow = rows.length + segment
            cursorColumn = stringWidth(text)
          }
        }
      }

      rows.push(...wrapped)
    }

    return { rows, cursorRow, cursorColumn }
  }

  /** The word immediately before the cursor, for autocomplete triggers. */
  wordBeforeCursor(): { text: string; start: number } {
    const line = this.lineAt(this.cursorLine)

    let start = this.cursorColumn

    while (start > 0 && !/\s/.test(line[start - 1]!)) start--

    return { text: line.slice(start, this.cursorColumn), start }
  }

  /** Replaces the word before the cursor, used when accepting a completion. */
  replaceWordBeforeCursor(replacement: string): void {
    const { start } = this.wordBeforeCursor()

    this.pushUndo(true)

    const line = this.lineAt(this.cursorLine)

    this.lines[this.cursorLine] = line.slice(0, start) + replacement + line.slice(this.cursorColumn)
    this.cursorColumn = start + replacement.length
    this.desiredColumn = undefined
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function order(a: Position, b: Position): [Position, Position] {
  if (a.line < b.line || (a.line === b.line && a.column <= b.column)) return [a, b]

  return [b, a]
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

/**
 * Finds the start of the word before a column.
 *
 * Whitespace immediately before the cursor is skipped first, so pressing
 * delete-word at the end of "foo   " removes the spaces and the word together
 * rather than needing two presses.
 */
function wordStart(line: string, column: number): number {
  let index = column

  while (index > 0 && /\s/.test(line[index - 1]!)) index--

  if (index === 0) return 0

  // Punctuation and word characters form separate runs, which is what makes
  // word motion useful in code: `foo.bar` is three motions, not one.
  const isWord = /[\w$]/.test(line[index - 1]!)

  while (index > 0) {
    const character = line[index - 1]!

    if (/\s/.test(character)) break
    if (/[\w$]/.test(character) !== isWord) break

    index--
  }

  return index
}

function wordEnd(line: string, column: number): number {
  let index = column

  while (index < line.length && /\s/.test(line[index]!)) index++

  if (index >= line.length) return line.length

  const isWord = /[\w$]/.test(line[index]!)

  while (index < line.length) {
    const character = line[index]!

    if (/\s/.test(character)) break
    if (/[\w$]/.test(character) !== isWord) break

    index++
  }

  return index
}

/**
 * Wraps one logical line to a display width.
 *
 * Always returns at least one segment, including for an empty line. Returning
 * an empty array would make an empty line vanish from the layout and shift every
 * row below it.
 */
function wrapLine(line: string, width: number): string[] {
  if (line === "") return [""]
  if (stringWidth(line) <= width) return [line]

  const segments: string[] = []

  let current = ""
  let currentWidth = 0

  for (const character of line) {
    const characterWidth = stringWidth(character)

    if (currentWidth + characterWidth > width) {
      segments.push(current)
      current = ""
      currentWidth = 0
    }

    current += character
    currentWidth += characterWidth
  }

  if (current !== "") segments.push(current)

  return segments
}
