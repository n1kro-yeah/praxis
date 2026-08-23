/**
 * Keybindings.
 *
 * Every action in the interface has a name, and a keybinding maps a key sequence
 * to one of those names. The default set is defined here, the user's overrides are
 * merged on top, and the result is compiled into a lookup structure the input loop
 * can query on every keypress without allocating.
 *
 * Two design points that follow from how terminals work:
 *
 *  - **A leader key.** Terminals reserve most control combinations for themselves,
 *    and the ones that survive are already spoken for by the shell. There are not
 *    thirty free chords available. So the common actions get direct bindings and
 *    everything else lives behind `ctrl+x`, which is free in every terminal worth
 *    supporting and gives an entire second keyspace.
 *  - **Sequences, not just chords.** `<leader>n` is two keystrokes, and the second
 *    is meaningless without the first. Matching therefore needs to know that a
 *    prefix has been entered and that the next key completes it \u2014 a flat map cannot
 *    express that, hence the trie.
 *
 * Multiple bindings per action are allowed, because muscle memory differs: some
 * people expect `ctrl+c` to interrupt, others `esc`, and both can be right.
 */

import { logger } from "../util/log.js"
import { parseKeyBinding, type KeyEvent, matchesBinding, displayKey } from "../tui/keys.js"

const log = logger("config.keybinds")

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/**
 * Every bindable action.
 *
 * Grouped by area, which is also how the help dialog renders them. A closed set
 * rather than free strings, so a typo in a configuration file is caught at load
 * time rather than producing a binding that silently never fires.
 */
export const ACTIONS = [
  // Application
  "app.exit",
  "app.help",
  "app.interrupt",
  "app.suspend",
  "app.redraw",
  "app.commandPalette",

  // Session
  "session.new",
  "session.list",
  "session.rename",
  "session.delete",
  "session.compact",
  "session.share",
  "session.unshare",
  "session.export",
  "session.undo",
  "session.redo",
  "session.child",
  "session.parent",

  // Editor
  "editor.submit",
  "editor.newline",
  "editor.clear",
  "editor.paste",
  "editor.openExternal",
  "editor.historyPrevious",
  "editor.historyNext",
  "editor.deleteWord",
  "editor.deleteToStart",
  "editor.deleteToEnd",
  "editor.wordLeft",
  "editor.wordRight",
  "editor.lineStart",
  "editor.lineEnd",
  "editor.transpose",
  "editor.undo",
  "editor.redo",

  // Messages
  "messages.scrollUp",
  "messages.scrollDown",
  "messages.pageUp",
  "messages.pageDown",
  "messages.top",
  "messages.bottom",
  "messages.previous",
  "messages.next",
  "messages.copy",
  "messages.copyLast",
  "messages.toggleDetails",
  "messages.toggleReasoning",
  "messages.toggleDiff",
  "messages.expand",
  "messages.collapse",

  // Selection
  "select.model",
  "select.agent",
  "select.theme",
  "select.file",
  "select.settings",

  // Tools and permissions
  "permission.allow",
  "permission.allowAlways",
  "permission.deny",
  "permission.denyAlways",

  // Queue
  "queue.show",
  "queue.clear",

  // Misc
  "thinking.toggle",
  "tools.toggle",
  "mouse.toggle",
] as const

export type Action = (typeof ACTIONS)[number]

const ACTION_SET = new Set<string>(ACTIONS)

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

/**
 * The leader key.
 *
 * `ctrl+x` because it is not claimed by readline, not claimed by the common
 * terminal emulators, and not claimed by tmux's default prefix. `ctrl+b` and
 * `ctrl+a` are both taken by multiplexers and would be a daily annoyance.
 */
export const DEFAULT_LEADER = "ctrl+x"

/**
 * The default bindings.
 *
 * Comma-separated alternatives where two conventions are equally common. The
 * ordering within a value does not matter; all alternatives are equal.
 *
 * `<leader>` is expanded at compile time so that changing the leader key does not
 * require rewriting every binding.
 */
export const DEFAULT_KEYBINDS: Record<Action, string> = {
  "app.exit": "ctrl+c,ctrl+d",
  "app.help": "<leader>h,f1",
  "app.interrupt": "escape",
  "app.suspend": "ctrl+z",
  "app.redraw": "ctrl+l",
  "app.commandPalette": "ctrl+k,<leader>p",

  "session.new": "<leader>n",
  "session.list": "<leader>l",
  "session.rename": "<leader>R",
  "session.delete": "<leader>D",
  "session.compact": "<leader>c",
  "session.share": "<leader>s",
  "session.unshare": "<leader>S",
  "session.export": "<leader>x",
  "session.undo": "<leader>u",
  "session.redo": "<leader>r",
  "session.child": "<leader>]",
  "session.parent": "<leader>[",

  "editor.submit": "enter",
  "editor.newline": "shift+enter,alt+enter,ctrl+j",
  "editor.clear": "ctrl+u",
  "editor.paste": "ctrl+v",
  "editor.openExternal": "<leader>e,ctrl+g",
  "editor.historyPrevious": "up",
  "editor.historyNext": "down",
  "editor.deleteWord": "ctrl+w,alt+backspace",
  "editor.deleteToStart": "ctrl+u",
  "editor.deleteToEnd": "ctrl+k",
  "editor.wordLeft": "alt+left,alt+b",
  "editor.wordRight": "alt+right,alt+f",
  "editor.lineStart": "ctrl+a,home",
  "editor.lineEnd": "ctrl+e,end",
  "editor.transpose": "ctrl+t",
  "editor.undo": "ctrl+_",
  "editor.redo": "ctrl+y",

  "messages.scrollUp": "ctrl+up",
  "messages.scrollDown": "ctrl+down",
  "messages.pageUp": "pageup",
  "messages.pageDown": "pagedown",
  "messages.top": "ctrl+home",
  "messages.bottom": "ctrl+end",
  "messages.previous": "<leader>k",
  "messages.next": "<leader>j",
  "messages.copy": "<leader>y",
  "messages.copyLast": "<leader>Y",
  "messages.toggleDetails": "<leader>d",
  "messages.toggleReasoning": "<leader>T",
  "messages.toggleDiff": "<leader>v",
  "messages.expand": "<leader>+",
  "messages.collapse": "<leader>-",

  "select.model": "<leader>m",
  "select.agent": "<leader>a,tab",
  "select.theme": "<leader>t",
  "select.file": "<leader>f",
  "select.settings": "<leader>,",

  "permission.allow": "y",
  "permission.allowAlways": "a",
  "permission.deny": "n",
  "permission.denyAlways": "d",

  "queue.show": "<leader>q",
  "queue.clear": "<leader>Q",

  "thinking.toggle": "<leader>i",
  "tools.toggle": "<leader>o",
  "mouse.toggle": "<leader>M",
}

/* ------------------------------------------------------------------ */
/* Compilation                                                         */
/* ------------------------------------------------------------------ */

export interface CompiledBinding {
  readonly action: Action
  /** The parsed key sequence. Length above one means a leader sequence. */
  readonly sequence: ReturnType<typeof parseKeyBinding>[]
  /** The original text, for the help display. */
  readonly source: string
}

interface TrieNode {
  /** Actions completed at this node. */
  readonly actions: CompiledBinding[]
  /** Continuations, keyed by a normalised key description. */
  readonly children: Map<string, TrieNode>
}

export interface Keymap {
  readonly root: TrieNode
  readonly bindings: CompiledBinding[]
  readonly leader: string
  readonly issues: string[]
}

function emptyNode(): TrieNode {
  return { actions: [], children: new Map() }
}

/**
 * A stable string for one parsed key, used as the trie edge.
 *
 * Modifiers are ordered rather than taken as written, so `ctrl+shift+a` and
 * `shift+ctrl+a` land on the same edge.
 */
function edgeKey(key: ReturnType<typeof parseKeyBinding>): string {
  const parts: string[] = []

  if (key.ctrl) parts.push("ctrl")
  if (key.alt) parts.push("alt")
  if (key.shift) parts.push("shift")
  if (key.meta) parts.push("meta")

  parts.push(key.name.toLowerCase())

  return parts.join("+")
}

/**
 * Compiles bindings into a lookup trie.
 *
 * Issues are collected rather than thrown, because one unparseable binding in a
 * configuration file should not leave the user with no keyboard at all.
 */
export function compileKeymap(
  overrides: Partial<Record<string, string>> = {},
  leader: string = DEFAULT_LEADER,
): Keymap {
  const issues: string[] = []
  const bindings: CompiledBinding[] = []
  const root = emptyNode()

  const merged: Record<string, string> = { ...DEFAULT_KEYBINDS }

  for (const [action, value] of Object.entries(overrides)) {
    if (value === undefined) continue

    if (!ACTION_SET.has(action)) {
      issues.push(`"${action}" is not an action, so its binding was ignored.`)
      continue
    }

    merged[action] = value
  }

  for (const [action, spec] of Object.entries(merged)) {
    // "none" removes a default binding, which is the only way to free a key that
    // conflicts with something the terminal or the user's multiplexer wants.
    if (spec === "none" || spec === "") continue

    for (const alternative of spec.split(",")) {
      const text = alternative.trim()

      if (text === "") continue

      const expanded = text.replace(/<leader>/g, `${leader}+`).replace(/\+\+/g, "+")

      // `<leader>n` becomes `ctrl+x+n`, which is a sequence of two keys rather
      // than one four-modifier chord. Split on the leader boundary explicitly.
      const sequence = text.includes("<leader>")
        ? [leader, text.replace(/<leader>/g, "")]
        : [expanded]

      const parsed: ReturnType<typeof parseKeyBinding>[] = []
      let failed = false

      for (const step of sequence) {
        try {
          parsed.push(parseKeyBinding(step))
        } catch (error) {
          issues.push(`Could not understand the binding "${text}" for ${action}: ${String(error)}`)
          failed = true
          break
        }
      }

      if (failed || parsed.length === 0) continue

      const binding: CompiledBinding = {
        action: action as Action,
        sequence: parsed,
        source: text,
      }

      bindings.push(binding)
      insert(root, binding)
    }
  }

  detectConflicts(bindings, issues)

  log.debug("keymap compiled", { bindings: bindings.length, issues: issues.length })

  return { root, bindings, leader, issues }
}

function insert(root: TrieNode, binding: CompiledBinding): void {
  let node = root

  for (const key of binding.sequence) {
    const edge = edgeKey(key)

    let next = node.children.get(edge)

    if (!next) {
      next = emptyNode()
      node.children.set(edge, next)
    }

    node = next
  }

  node.actions.push(binding)
}

/**
 * Reports bindings that shadow each other.
 *
 * Two actions on one key is the obvious case. The subtler one is a single key
 * that is also the prefix of a sequence: binding `ctrl+x` directly while
 * `ctrl+x n` exists means the direct binding can only fire after a timeout, which
 * feels like lag rather than a conflict and is very hard to diagnose from the
 * outside.
 */
function detectConflicts(bindings: CompiledBinding[], issues: string[]): void {
  const byPath = new Map<string, CompiledBinding[]>()

  for (const binding of bindings) {
    const path = binding.sequence.map(edgeKey).join(" ")
    byPath.set(path, [...(byPath.get(path) ?? []), binding])
  }

  for (const [path, list] of byPath) {
    if (list.length <= 1) continue

    const actions = [...new Set(list.map((entry) => entry.action))]

    if (actions.length > 1) {
      issues.push(`${path} is bound to more than one action: ${actions.join(", ")}.`)
    }
  }

  const paths = [...byPath.keys()]

  for (const path of paths) {
    for (const other of paths) {
      if (path === other) continue
      if (!other.startsWith(`${path} `)) continue

      issues.push(
        `${path} is both a binding and the start of ${other}, so it will only fire after a pause.`,
      )
    }
  }
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tracks progress through a multi-key sequence.
 *
 * Held by the input loop across keypresses. Separate from the keymap so that
 * reloading the configuration does not lose a leader key already pressed.
 */
export class KeymapState {
  private node: TrieNode
  private pressed: string[] = []
  private since = 0

  constructor(private keymap: Keymap) {
    this.node = keymap.root
  }

  /** Whether a partial sequence is in progress. */
  get pending(): boolean {
    return this.node !== this.keymap.root
  }

  /** The keys pressed so far, for the status indicator. */
  get prefix(): string {
    return this.pressed.join(" ")
  }

  /** Milliseconds since the sequence started. */
  get elapsed(): number {
    return this.pending ? Date.now() - this.since : 0
  }

  setKeymap(keymap: Keymap): void {
    this.keymap = keymap
    this.reset()
  }

  reset(): void {
    this.node = this.keymap.root
    this.pressed = []
    this.since = 0
  }

  /**
   * Feeds a key and reports the outcome.
   *
   * Three results:
   *
   *  - `action`: a binding fired.
   *  - `pending`: a prefix was matched; more keys are expected.
   *  - `none`: nothing matched, and the key should be handled as text.
   *
   * An unmatched key after a prefix resets rather than being swallowed. Pressing
   * the leader by accident and then typing should produce the typing, not silence.
   */
  press(event: KeyEvent): { kind: "action"; action: Action } | { kind: "pending" } | { kind: "none" } {
    const candidates = [...this.node.children.entries()]

    for (const [edge, child] of candidates) {
      if (!matchesEdge(edge, event)) continue

      this.pressed.push(displayKey(event))

      if (child.actions.length > 0 && child.children.size === 0) {
        const action = child.actions[0]!.action
        this.reset()
        return { kind: "action", action }
      }

      // Both a complete binding and a prefix. Prefer the prefix and let the
      // timeout resolve it, since the alternative fires the short binding and
      // makes the long one unreachable.
      if (child.children.size > 0) {
        this.node = child
        if (this.since === 0) this.since = Date.now()
        return { kind: "pending" }
      }

      if (child.actions.length > 0) {
        const action = child.actions[0]!.action
        this.reset()
        return { kind: "action", action }
      }
    }

    const wasPending = this.pending
    this.reset()

    // A key that broke out of a sequence is not text either \u2014 it was part of an
    // attempted binding. Reporting `none` here would insert the character.
    return wasPending ? { kind: "pending" } : { kind: "none" }
  }

  /**
   * Resolves a pending sequence that has timed out.
   *
   * Returns an action when the prefix was itself a complete binding.
   */
  timeout(): Action | undefined {
    if (!this.pending) return undefined

    const action = this.node.actions[0]?.action

    this.reset()

    return action
  }
}

function matchesEdge(edge: string, event: KeyEvent): boolean {
  return matchesBinding(event, edge)
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/**
 * The bindings for an action, formatted for display.
 *
 * `<leader>` is put back, because the help dialog showing `ctrl+x n` when the
 * documentation says `<leader>n` makes the two impossible to reconcile.
 */
export function bindingsFor(keymap: Keymap, action: Action): string[] {
  return keymap.bindings
    .filter((binding) => binding.action === action)
    .map((binding) => binding.source)
}

/** The first binding for an action, for a hint in the status bar. */
export function primaryBinding(keymap: Keymap, action: Action): string | undefined {
  return bindingsFor(keymap, action)[0]
}

/**
 * Actions grouped by area, for the help dialog.
 *
 * The area is the part of the action name before the dot, which keeps the
 * grouping in step with the naming automatically.
 */
export function groupedActions(): Map<string, Action[]> {
  const groups = new Map<string, Action[]>()

  for (const action of ACTIONS) {
    const area = action.split(".")[0]!
    groups.set(area, [...(groups.get(area) ?? []), action])
  }

  return groups
}

/**
 * A readable label for an action.
 *
 * `session.new` becomes "New session". Derived rather than tabulated, so a new
 * action gets a reasonable label without a second edit \u2014 and a bad automatic label
 * is a prompt to add a real one.
 */
export function actionLabel(action: Action): string {
  const override = ACTION_LABELS[action]
  if (override) return override

  const [area, name] = action.split(".")

  const words = (name ?? "").replace(/([A-Z])/g, " $1").toLowerCase().trim()

  return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${area}`.trim()
}

/** Labels where the derived form reads badly. */
const ACTION_LABELS: Partial<Record<Action, string>> = {
  "app.exit": "Quit",
  "app.help": "Show help",
  "app.interrupt": "Interrupt the agent",
  "app.commandPalette": "Command palette",
  "session.new": "New session",
  "session.list": "Switch session",
  "session.compact": "Summarise the conversation",
  "session.undo": "Undo the last turn",
  "session.redo": "Redo",
  "editor.submit": "Send",
  "editor.newline": "Insert a newline",
  "editor.openExternal": "Edit in $EDITOR",
  "messages.toggleDetails": "Show or hide tool details",
  "messages.toggleReasoning": "Show or hide reasoning",
  "select.model": "Choose a model",
  "select.agent": "Choose an agent",
  "select.theme": "Choose a theme",
  "thinking.toggle": "Toggle extended thinking",
}

/**
 * Validates a binding without compiling the whole keymap.
 *
 * Used by the settings dialog to give feedback as the user types, which is the
 * only point at which "that is not a key" is useful information.
 */
export function validateBinding(spec: string, leader: string = DEFAULT_LEADER): string | undefined {
  if (spec === "none" || spec === "") return undefined

  for (const alternative of spec.split(",")) {
    const text = alternative.trim()
    if (text === "") continue

    const sequence = text.includes("<leader>")
      ? [leader, text.replace(/<leader>/g, "")]
      : [text]

    for (const step of sequence) {
      try {
        parseKeyBinding(step)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
  }

  return undefined
}
