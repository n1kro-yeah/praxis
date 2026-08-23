/**
 * The modal dialog framework.
 *
 * Every dialog in the interface \u2014 model picker, theme picker, session list,
 * permission prompt, agent switcher, and the rest \u2014 is a list with a filter box
 * on top. That uniformity is deliberate: one set of keys works everywhere, one
 * implementation handles the scrolling and filtering, and adding a dialog means
 * supplying items rather than writing a new widget.
 *
 * Dialogs form a stack rather than a single slot. Opening the model picker from
 * inside the session list should return to the session list when dismissed, not to
 * the main view, and a stack is the only structure that gets that right without
 * special cases.
 *
 * The filter runs on every keystroke over the full item list. That is fine for
 * the sizes involved \u2014 a few hundred models, a few dozen sessions \u2014 and avoids an
 * incremental index that would have to be invalidated whenever the items change.
 */

import { fuzzyMatch } from "../util/fuzzy.js"
import { stringWidth } from "../util/wcwidth.js"

/* ------------------------------------------------------------------ */
/* Kinds                                                               */
/* ------------------------------------------------------------------ */

/**
 * Every dialog the interface can show.
 *
 * Enumerated rather than open-ended so that a command referring to a dialog
 * that does not exist is a compile error rather than a silent no-op.
 */
export type DialogKind =
  | "commands"
  | "models"
  | "providers"
  | "agents"
  | "sessions"
  | "themes"
  | "skills"
  | "tools"
  | "permissions"
  | "mcp"
  | "plugins"
  | "keybinds"
  | "files"
  | "help"
  | "status"
  | "timeline"
  | "export"
  | "share"
  | "confirm"
  | "question"
  | "input"

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

export interface DialogItem {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly icon?: string
  readonly group?: string
  readonly disabled?: boolean
  /** Marks the current value, shown with a check. */
  readonly current?: boolean
  /** Extra text matched by the filter but not displayed. */
  readonly keywords?: string
  /** Arbitrary payload returned to the caller on selection. */
  readonly value?: unknown
}

interface RankedItem {
  readonly item: DialogItem
  readonly score: number
  readonly positions: readonly number[]
}

/* ------------------------------------------------------------------ */
/* Definition                                                          */
/* ------------------------------------------------------------------ */

export interface DialogDefinition {
  readonly kind: DialogKind
  readonly title: string
  /** Placeholder shown in the empty filter box. */
  readonly placeholder?: string
  readonly items: DialogItem[]
  /** Shown when the filter matches nothing. */
  readonly emptyMessage?: string
  /** Allow selecting several items before confirming. */
  readonly multiple?: boolean
  /** Hide the filter box for short, fixed lists. */
  readonly noFilter?: boolean
  /** Free text is accepted, for the input dialog. */
  readonly freeText?: boolean
  /** Preferred width in columns, clamped to the terminal. */
  readonly width?: number
  /** Preferred height in rows. */
  readonly height?: number
  /** Key hints shown along the bottom. */
  readonly hints?: ReadonlyArray<{ key: string; label: string }>
}

export interface DialogResult {
  readonly kind: DialogKind
  /** Undefined when dismissed rather than confirmed. */
  readonly selected?: DialogItem | DialogItem[]
  /** The filter text, for dialogs that accept free input. */
  readonly text?: string
  readonly cancelled: boolean
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/**
 * A dialog's live state.
 *
 * Mutable and owned by the stack. Copying it on every keystroke would be
 * cleaner in principle and would allocate a new object per character typed, which
 * is a real cost in a render loop.
 */
export class Dialog {
  readonly definition: DialogDefinition

  filter = ""
  selected = 0
  offset = 0
  chosen = new Set<string>()

  private ranked: RankedItem[] = []
  private lastFilter: string | undefined
  private lastItemCount = -1

  constructor(definition: DialogDefinition) {
    this.definition = definition

    // Start on the current value rather than the first item. Opening the model
    // picker and immediately pressing enter should be a no-op, not a change to
    // whatever happens to sort first.
    const currentIndex = definition.items.findIndex((item) => item.current)

    if (currentIndex >= 0) this.selected = currentIndex
  }

  /**
   * The filtered, ranked items.
   *
   * Cached against the filter text and item count, because this is called
   * several times per frame \u2014 for the visible rows, for the scrollbar, and for
   * the count in the footer \u2014 and re-ranking each time is wasteful.
   */
  visible(): RankedItem[] {
    if (this.lastFilter === this.filter && this.lastItemCount === this.definition.items.length) {
      return this.ranked
    }

    this.ranked = rankItems(this.definition.items, this.filter)
    this.lastFilter = this.filter
    this.lastItemCount = this.definition.items.length

    // The selection may now point past the end of a shortened list.
    if (this.selected >= this.ranked.length) {
      this.selected = Math.max(0, this.ranked.length - 1)
    }

    return this.ranked
  }

  current(): DialogItem | undefined {
    return this.visible()[this.selected]?.item
  }

  /**
   * Moves the selection, skipping disabled entries.
   *
   * The guard on total iterations prevents an infinite loop when every item is
   * disabled, which happens with an empty provider list.
   */
  move(delta: number): void {
    const items = this.visible()

    if (items.length === 0) return

    let index = this.selected

    for (let attempts = 0; attempts < items.length; attempts++) {
      index = (((index + delta) % items.length) + items.length) % items.length

      if (!items[index]!.item.disabled) break
    }

    this.selected = index
  }

  moveTo(index: number): void {
    const items = this.visible()

    this.selected = Math.max(0, Math.min(index, items.length - 1))
  }

  /** Toggles the current item in a multi-select dialog. */
  toggle(): void {
    if (!this.definition.multiple) return

    const item = this.current()

    if (!item) return

    if (this.chosen.has(item.id)) {
      this.chosen.delete(item.id)
    } else {
      this.chosen.add(item.id)
    }
  }

  setFilter(value: string): void {
    this.filter = value

    // Filtering resets the selection to the top. Preserving the index would
    // land on an unrelated item, since the list has changed underneath it.
    this.selected = 0
    this.offset = 0
  }

  /** The result of confirming this dialog. */
  confirm(): DialogResult {
    if (this.definition.multiple) {
      const selected = this.definition.items.filter((item) => this.chosen.has(item.id))

      return { kind: this.definition.kind, selected, text: this.filter, cancelled: false }
    }

    const item = this.current()

    // A free-text dialog with no match still returns the typed text, which is
    // the whole point of accepting free text.
    if (!item && !this.definition.freeText) {
      return { kind: this.definition.kind, cancelled: true }
    }

    return { kind: this.definition.kind, selected: item, text: this.filter, cancelled: false }
  }

  cancel(): DialogResult {
    return { kind: this.definition.kind, cancelled: true }
  }
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

/**
 * Filters and orders items.
 *
 * With no filter, the original order is preserved and groups stay intact.
 * With a filter, grouping is dropped and everything is ordered by score, because
 * maintaining groups while filtering produces a list where the best match is
 * buried under a group heading three screens down.
 */
function rankItems(items: readonly DialogItem[], filter: string): RankedItem[] {
  if (filter === "") {
    return items.map((item) => ({ item, score: 0, positions: [] }))
  }

  const results: RankedItem[] = []

  for (const item of items) {
    const match = fuzzyMatch(filter, item.label)

    if (match) {
      results.push({ item, score: match.score, positions: match.positions })

      continue
    }

    // Fall back to matching the detail and keywords, with a penalty so that a
    // label match always outranks a description match.
    const secondary = item.keywords ?? item.detail

    if (secondary) {
      const secondaryMatch = fuzzyMatch(filter, secondary)

      if (secondaryMatch) {
        results.push({ item, score: secondaryMatch.score - 100, positions: [] })
      }
    }
  }

  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score

    return left.item.label.length - right.item.label.length
  })

  return results
}

/* ------------------------------------------------------------------ */
/* Stack                                                               */
/* ------------------------------------------------------------------ */

/**
 * The dialog stack.
 *
 * Only the topmost dialog receives input; the rest stay in place beneath it.
 */
export class DialogStack {
  private stack: Dialog[] = []
  private resolvers: Array<(result: DialogResult) => void> = []

  /**
   * Opens a dialog and resolves when it closes.
   *
   * The promise resolves rather than rejecting on cancel, because cancelling a
   * dialog is an ordinary outcome and forcing every caller into a try/catch to
   * handle the escape key would be tedious and easy to forget.
   */
  open(definition: DialogDefinition): Promise<DialogResult> {
    const dialog = new Dialog(definition)

    this.stack.push(dialog)

    return new Promise((resolve) => {
      this.resolvers.push(resolve)
    })
  }

  top(): Dialog | undefined {
    return this.stack[this.stack.length - 1]
  }

  depth(): number {
    return this.stack.length
  }

  isOpen(): boolean {
    return this.stack.length > 0
  }

  /** Closes the top dialog with a result. */
  close(result: DialogResult): void {
    this.stack.pop()

    const resolve = this.resolvers.pop()

    resolve?.(result)
  }

  /** Closes every dialog, cancelling each. */
  closeAll(): void {
    while (this.stack.length > 0) {
      const dialog = this.stack.pop()!
      const resolve = this.resolvers.pop()

      resolve?.(dialog.cancel())
    }
  }

  /**
   * Replaces the top dialog.
   *
   * Used when one dialog leads directly to another \u2014 picking a provider then
   * picking one of its models \u2014 where pushing would leave a stale dialog to return
   * to.
   */
  replace(definition: DialogDefinition): Promise<DialogResult> {
    if (this.stack.length > 0) {
      this.stack.pop()

      const resolve = this.resolvers.pop()

      resolve?.({ kind: definition.kind, cancelled: true })
    }

    return this.open(definition)
  }
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

export interface DialogGeometry {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Rows available for the item list. */
  readonly listHeight: number
}

/**
 * Sizes and positions a dialog within the terminal.
 *
 * Placed slightly above centre. A dialog at true centre looks low, because the
 * eye treats the optical centre as being above the geometric one; every design
 * system that positions modals accounts for this and it costs one line of
 * arithmetic.
 */
export function layoutDialog(
  dialog: Dialog,
  terminalWidth: number,
  terminalHeight: number,
): DialogGeometry {
  const definition = dialog.definition

  // Width follows the content, bounded by a readable maximum and by the
  // terminal. A dialog that spans a 200-column terminal is harder to scan than
  // one that stays compact.
  let contentWidth = stringWidth(definition.title) + 6

  for (const item of definition.items.slice(0, 200)) {
    const width =
      stringWidth(item.label) + (item.detail ? stringWidth(item.detail) + 4 : 0) + (item.icon ? 2 : 0) + 8

    if (width > contentWidth) contentWidth = width
  }

  const width = Math.min(
    definition.width ?? Math.max(48, Math.min(contentWidth, 100)),
    Math.max(20, terminalWidth - 4),
  )

  const filterRows = definition.noFilter ? 0 : 2
  const chromeRows = 2 + filterRows + (definition.hints && definition.hints.length > 0 ? 1 : 0)

  const itemCount = Math.max(1, dialog.visible().length)

  const desired = definition.height ?? Math.min(itemCount + chromeRows, 20)
  const height = Math.min(desired, Math.max(5, terminalHeight - 4))

  return {
    x: Math.max(0, Math.floor((terminalWidth - width) / 2)),
    y: Math.max(0, Math.floor((terminalHeight - height) / 2) - Math.floor(terminalHeight / 12)),
    width,
    height,
    listHeight: Math.max(1, height - chromeRows),
  }
}

/* ------------------------------------------------------------------ */
/* Standard definitions                                                */
/* ------------------------------------------------------------------ */

const SELECT_HINTS = [
  { key: "\u2191\u2193", label: "navigate" },
  { key: "enter", label: "select" },
  { key: "esc", label: "cancel" },
]

const MULTI_HINTS = [
  { key: "\u2191\u2193", label: "navigate" },
  { key: "space", label: "toggle" },
  { key: "enter", label: "confirm" },
  { key: "esc", label: "cancel" },
]

/** A yes/no confirmation. */
export function confirmDialog(
  title: string,
  message: string,
  options: { confirmLabel?: string; cancelLabel?: string; dangerous?: boolean } = {},
): DialogDefinition {
  return {
    kind: "confirm",
    title,
    noFilter: true,
    width: Math.max(40, Math.min(70, message.length + 8)),
    items: [
      // The safe option is listed first and starts selected, so that reflexively
      // pressing enter on a destructive prompt does not destroy anything.
      { id: "cancel", label: options.cancelLabel ?? "Cancel", current: options.dangerous !== false },
      { id: "confirm", label: options.confirmLabel ?? "Confirm", current: options.dangerous === false },
    ],
    emptyMessage: message,
    hints: [
      { key: "y", label: "yes" },
      { key: "n", label: "no" },
    ],
  }
}

/** A single-line text prompt. */
export function inputDialog(
  title: string,
  options: { placeholder?: string; initial?: string } = {},
): DialogDefinition {
  return {
    kind: "input",
    title,
    placeholder: options.placeholder,
    items: [],
    freeText: true,
    height: 5,
    hints: [
      { key: "enter", label: "accept" },
      { key: "esc", label: "cancel" },
    ],
  }
}

/** A generic picker over a list of items. */
export function selectDialog(
  kind: DialogKind,
  title: string,
  items: DialogItem[],
  options: { placeholder?: string; multiple?: boolean; emptyMessage?: string } = {},
): DialogDefinition {
  return {
    kind,
    title,
    placeholder: options.placeholder ?? "Type to filter",
    items,
    multiple: options.multiple,
    emptyMessage: options.emptyMessage ?? "No matches",
    hints: options.multiple ? MULTI_HINTS : SELECT_HINTS,
  }
}

/**
 * The question dialog, used by the agent's question tool.
 *
 * Numbered so the answer can be given with a single digit. Waiting on a
 * question is a pause in the agent's work, and the faster it can be resolved the
 * better.
 */
export function questionDialog(
  question: string,
  choices: ReadonlyArray<{ label: string; detail?: string }>,
): DialogDefinition {
  return {
    kind: "question",
    title: question,
    noFilter: true,
    width: Math.max(50, Math.min(90, question.length + 10)),
    items: choices.map((choice, index) => ({
      id: String(index),
      label: String(index + 1) + ". " + choice.label,
      detail: choice.detail,
    })),
    hints: [
      { key: "1-9", label: "answer" },
      { key: "enter", label: "select" },
      { key: "esc", label: "skip" },
    ],
  }
}

/**
 * Groups items under headings for display.
 *
 * Only applied when no filter is active. Returns a flat list with heading
 * entries interleaved, so the renderer does not need to understand grouping and
 * the scroll arithmetic stays simple.
 */
export function withGroupHeadings(items: readonly RankedItem[]): Array<RankedItem | { heading: string }> {
  const result: Array<RankedItem | { heading: string }> = []

  let currentGroup: string | undefined

  for (const entry of items) {
    const group = entry.item.group

    if (group && group !== currentGroup) {
      result.push({ heading: group })
      currentGroup = group
    }

    result.push(entry)
  }

  return result
}

/** Whether an entry in a grouped list is a heading. */
export function isHeading(entry: RankedItem | { heading: string }): entry is { heading: string } {
  return "heading" in entry
}
