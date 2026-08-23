/**
 * Prompt autocomplete.
 *
 * Three trigger characters, each with different semantics:
 *
 * - `@` completes file paths from the project index
 * - `/` completes slash commands, but only at the very start of the prompt
 * - `!` marks the whole line as a shell command, and completes executables
 *
 * The `/` restriction matters. A slash appears constantly inside file paths and
 * inside prose, and popping a command menu every time someone types `src/foo`
 * would make the editor unusable. Only a slash in the first column, with nothing
 * before it, opens the command list.
 *
 * Completion is asynchronous because the file index may still be building on a
 * large repository. The request carries a sequence number and results from a stale
 * request are discarded, so a slow lookup for `@src` cannot overwrite the results
 * for `@src/tui` that the user has already typed.
 */

import { fuzzyMatch } from "../util/fuzzy.js"
import { logger } from "../util/log.js"

const log = logger("tui.autocomplete")

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/** Suggestions shown at once. */
const MAX_SUGGESTIONS = 10

/**
 * Candidates scored before giving up on ranking.
 *
 * Fuzzy scoring every path in a repository with two hundred thousand files
 * would take long enough to be felt on each keystroke. Scoring a bounded prefix
 * gives results that are almost always the same and are always fast.
 */
const MAX_CANDIDATES = 5_000

/**
 * Delay before an asynchronous lookup runs.
 *
 * Short enough to feel immediate, long enough that typing a ten-character path
 * issues one lookup rather than ten.
 */
const DEBOUNCE_MS = 40

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type TriggerKind = "file" | "command" | "shell" | "agent" | "model"

export interface Suggestion {
  /** Text inserted when accepted. */
  readonly value: string
  /** Text shown in the list. */
  readonly label: string
  /** Secondary text shown dimmed to the right. */
  readonly detail?: string
  /** Character shown before the label. */
  readonly icon?: string
  /** Positions in the label that matched the query, for highlighting. */
  readonly positions?: readonly number[]
  readonly score: number
}

export interface Trigger {
  readonly kind: TriggerKind
  /** Column where the trigger character sits. */
  readonly start: number
  /** The text typed after the trigger. */
  readonly query: string
}

/** Supplies candidates for a trigger kind. */
export type Provider = (query: string) => Promise<Suggestion[]> | Suggestion[]

/* ------------------------------------------------------------------ */
/* Trigger detection                                                   */
/* ------------------------------------------------------------------ */

/**
 * Finds an active trigger in a line at a cursor position.
 *
 * Scans backwards from the cursor for a trigger character. Stops at whitespace,
 * because a trigger must begin a token: `foo@bar` is an email address, not a file
 * reference, and completing it would be wrong.
 */
export function detectTrigger(line: string, cursor: number): Trigger | undefined {
  // The command trigger is special-cased first because it is anchored to the
  // start of the line and the general backward scan would not find it after the
  // user has typed a space.
  if (line.startsWith("/") && cursor > 0) {
    const upToCursor = line.slice(1, cursor)

    // Once an argument is being typed the command itself is settled, so the
    // menu closes rather than continuing to filter on the whole line.
    if (!upToCursor.includes(" ")) {
      return { kind: "command", start: 0, query: upToCursor }
    }
  }

  if (line.startsWith("!") && cursor > 0) {
    const upToCursor = line.slice(1, cursor)

    if (!upToCursor.includes(" ")) {
      return { kind: "shell", start: 0, query: upToCursor }
    }
  }

  let index = cursor - 1

  while (index >= 0) {
    const character = line[index]!

    if (/\s/.test(character)) return undefined

    if (character === "@") {
      // A trigger must be at the start of the line or follow whitespace or an
      // opening bracket. Anything else is part of a larger token.
      const before = index === 0 ? " " : line[index - 1]!

      if (!/[\s([{,]/.test(before)) return undefined

      return { kind: "file", start: index, query: line.slice(index + 1, cursor) }
    }

    index--
  }

  return undefined
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

/**
 * Scores and sorts candidates against a query.
 *
 * An empty query returns the candidates in their given order rather than
 * sorting by an all-zero score, which would scramble a list that the provider had
 * already put in a sensible order.
 */
export function rank(candidates: readonly Suggestion[], query: string): Suggestion[] {
  if (query === "") return candidates.slice(0, MAX_SUGGESTIONS)

  const scored: Suggestion[] = []

  const limit = Math.min(candidates.length, MAX_CANDIDATES)

  for (let index = 0; index < limit; index++) {
    const candidate = candidates[index]!

    const match = fuzzyMatch(query, candidate.label)

    if (!match) continue

    scored.push({
      ...candidate,
      score: match.score + candidate.score,
      positions: match.positions,
    })
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score

    // Shorter labels first at equal score. A query that matches both `index.ts`
    // and `some/deep/path/index.ts` should offer the shorter one first.
    return left.label.length - right.label.length
  })

  return scored.slice(0, MAX_SUGGESTIONS)
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

export interface AutocompleteState {
  readonly trigger: Trigger
  readonly suggestions: readonly Suggestion[]
  readonly selected: number
  readonly loading: boolean
}

/**
 * Drives the autocomplete menu.
 *
 * Owns the debounce, the request sequencing, and the selection index. Kept
 * separate from the view so that the same logic serves the inline menu and the
 * full-screen picker, and so it can be exercised without a terminal.
 */
export class Autocomplete {
  private providers = new Map<TriggerKind, Provider>()
  private state: AutocompleteState | undefined
  private sequence = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<(state: AutocompleteState | undefined) => void>()

  register(kind: TriggerKind, provider: Provider): void {
    this.providers.set(kind, provider)
  }

  subscribe(listener: (state: AutocompleteState | undefined) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  current(): AutocompleteState | undefined {
    return this.state
  }

  isOpen(): boolean {
    return this.state !== undefined && this.state.suggestions.length > 0
  }

  /**
   * Updates the menu for the current line and cursor.
   *
   * Called on every keystroke. The early return when no trigger is active is
   * the common case and has to be cheap.
   */
  update(line: string, cursor: number): void {
    const trigger = detectTrigger(line, cursor)

    if (!trigger) {
      this.close()

      return
    }

    const provider = this.providers.get(trigger.kind)

    if (!provider) {
      this.close()

      return
    }

    // Keep the existing suggestions visible while the new ones load. Clearing
    // them first makes the menu flicker on every keystroke.
    this.setState({
      trigger,
      suggestions: this.state?.trigger.kind === trigger.kind ? this.state.suggestions : [],
      selected: 0,
      loading: true,
    })

    if (this.timer) clearTimeout(this.timer)

    const sequence = ++this.sequence

    this.timer = setTimeout(() => {
      void this.load(provider, trigger, sequence)
    }, DEBOUNCE_MS)

    this.timer.unref?.()
  }

  private async load(provider: Provider, trigger: Trigger, sequence: number): Promise<void> {
    let candidates: Suggestion[]

    try {
      candidates = await provider(trigger.query)
    } catch (error) {
      log.debug("a completion provider failed", { kind: trigger.kind, error: String(error) })

      candidates = []
    }

    // A newer request has been issued, so these results are for a query the user
    // has already moved past.
    if (sequence !== this.sequence) return

    this.setState({
      trigger,
      suggestions: rank(candidates, trigger.query),
      selected: 0,
      loading: false,
    })
  }

  /** Moves the selection, wrapping at both ends. */
  move(delta: number): void {
    if (!this.state || this.state.suggestions.length === 0) return

    const count = this.state.suggestions.length

    // Wrapping rather than clamping: with a short list, pressing up from the
    // first item to reach the last is faster than pressing down nine times.
    const selected = (((this.state.selected + delta) % count) + count) % count

    this.setState({ ...this.state, selected })
  }

  /** The currently highlighted suggestion. */
  selected(): Suggestion | undefined {
    if (!this.state) return undefined

    return this.state.suggestions[this.state.selected]
  }

  /**
   * Produces the replacement for accepting the current suggestion.
   *
   * Returns the span to replace along with the text, rather than mutating an
   * editor directly, so the caller keeps control of undo grouping.
   */
  accept(): { start: number; end: number; text: string } | undefined {
    const suggestion = this.selected()

    if (!suggestion || !this.state) return undefined

    const trigger = this.state.trigger

    const start = trigger.start
    const end = trigger.start + 1 + trigger.query.length

    const prefix = trigger.kind === "file" ? "@" : trigger.kind === "command" ? "/" : trigger.kind === "shell" ? "!" : ""

    // A trailing space after a completed file reference is what the user almost
    // always wants next, and typing it themselves is a small constant annoyance.
    const suffix = trigger.kind === "file" ? " " : ""

    this.close()

    return { start, end, text: prefix + suggestion.value + suffix }
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    // Bump the sequence so any in-flight request is discarded when it lands.
    // Without this, a slow lookup can reopen a menu the user just dismissed.
    this.sequence++

    if (this.state !== undefined) this.setState(undefined)
  }

  private setState(state: AutocompleteState | undefined): void {
    this.state = state

    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch (error) {
        log.debug("an autocomplete listener threw", { error: String(error) })
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Built-in providers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Builds a file provider backed by the project index.
 *
 * Directories are offered with a trailing slash so that accepting one continues
 * the completion rather than ending it, which is how path completion behaves
 * everywhere else and is what people expect.
 */
export function fileProvider(
  search: (query: string, limit: number) => Promise<Array<{ path: string; isDirectory: boolean; score: number }>>,
): Provider {
  return async (query: string) => {
    const results = await search(query, MAX_CANDIDATES)

    return results.map((result) => ({
      value: result.isDirectory ? result.path + "/" : result.path,
      label: result.path,
      icon: result.isDirectory ? "\u25b8" : "\u00b7",
      score: result.score,
    }))
  }
}

/** Builds a command provider from a static command list. */
export function commandProvider(
  list: () => Array<{ name: string; description: string; aliases?: readonly string[] }>,
): Provider {
  return () =>
    list().map((command) => ({
      value: command.name,
      label: command.name,
      detail: command.description,
      icon: "/",
      score: 0,
    }))
}

/**
 * Builds a shell provider from the executables on PATH.
 *
 * The list is gathered once and cached. Scanning every PATH directory takes
 * tens of milliseconds and the contents effectively never change during a session.
 */
export function shellProvider(executables: () => Promise<string[]>): Provider {
  let cache: string[] | undefined

  return async () => {
    cache ??= await executables()

    return cache.map((name) => ({
      value: name,
      label: name,
      icon: "$",
      score: 0,
    }))
  }
}

/** Builds a provider over a fixed list of names, for agents and models. */
export function staticProvider(
  kind: TriggerKind,
  items: () => Array<{ value: string; label: string; detail?: string }>,
): Provider {
  const icon = kind === "agent" ? "\u25c6" : "\u25cf"

  return () =>
    items().map((item) => ({
      value: item.value,
      label: item.label,
      detail: item.detail,
      icon,
      score: 0,
    }))
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

export interface MenuLine {
  readonly text: string
  readonly selected: boolean
  readonly positions: readonly number[]
}

/**
 * Lays out the menu for display.
 *
 * The window slides to keep the selection visible without jumping: the
 * selection stays put until it would leave the window, and only then does the
 * window move by the minimum needed. A window that recentres on every move is
 * disorienting to read.
 */
export function menuLines(
  state: AutocompleteState,
  height: number,
  width: number,
): MenuLine[] {
  const visible = Math.min(height, state.suggestions.length)

  if (visible === 0) return []

  let first = 0

  if (state.selected >= visible) first = state.selected - visible + 1

  const lines: MenuLine[] = []

  for (let index = first; index < first + visible; index++) {
    const suggestion = state.suggestions[index]

    if (!suggestion) break

    const icon = suggestion.icon ? suggestion.icon + " " : ""

    let text = icon + suggestion.label

    // The detail is appended only if there is room for a useful amount of it.
    // A detail truncated to three characters is worse than none.
    if (suggestion.detail) {
      const room = width - text.length - 3

      if (room > 8) {
        const detail =
          suggestion.detail.length > room
            ? suggestion.detail.slice(0, room - 1) + "\u2026"
            : suggestion.detail

        text += "  " + detail
      }
    }

    lines.push({
      text: text.length > width ? text.slice(0, width - 1) + "\u2026" : text,
      selected: index === state.selected,
      // Positions shift by the icon prefix, or the highlight would land on the
      // wrong characters.
      positions: (suggestion.positions ?? []).map((position) => position + icon.length),
    })
  }

  return lines
}
