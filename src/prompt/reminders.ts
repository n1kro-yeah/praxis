/**
 * System reminders.
 *
 * A reminder is a short synthetic message injected *after* the last real user
 * message, carrying volatile state the model must know right now: the current
 * todo list, files changed outside the session, fresh diagnostics, remaining
 * context budget, permission denials.
 *
 * They deliberately do not live in the system prompt. The system prompt must be
 * byte-stable for prompt caching, and volatile facts placed at the front are
 * also the most likely to be ignored — recency dominates attention in practice.
 * Putting them last is both cheaper and more effective.
 *
 * Reminders are never persisted as conversation content: they are rebuilt from
 * live state on every request, so a resumed session never carries stale ones.
 */

import type { Content } from "../llm/types.js"
import type { TodoItem } from "../session/types.js"
import { relative } from "node:path"
import { truncate } from "../util/string.js"

export type ReminderKind =
  | "todo"
  | "file-changed"
  | "diagnostics"
  | "context-budget"
  | "permission"
  | "doom-loop"
  | "plan-mode"
  | "queued-input"
  | "custom"

export interface Reminder {
  readonly kind: ReminderKind
  readonly text: string
  /** Higher priority reminders are emitted first and survive truncation. */
  readonly priority: number
}

function reminder(kind: ReminderKind, priority: number, text: string): Reminder {
  return { kind, priority, text }
}

/* ------------------------------------------------------------------ */
/* Individual reminders                                                */
/* ------------------------------------------------------------------ */

/**
 * The todo list.
 *
 * Repeating it every turn is what keeps a long task on track: without it the
 * model drifts after five or six tool calls and starts re-solving finished
 * steps. The empty-list variant is equally important — it stops the model from
 * inventing a list for a one-line change.
 */
export function todoReminder(todos: readonly TodoItem[]): Reminder | undefined {
  if (todos.length === 0) return undefined

  const pending = todos.filter((todo) => todo.status === "pending")
  const active = todos.filter((todo) => todo.status === "in_progress")
  const done = todos.filter((todo) => todo.status === "completed")
  const cancelled = todos.filter((todo) => todo.status === "cancelled")

  if (pending.length === 0 && active.length === 0) {
    return reminder(
      "todo",
      70,
      `All ${done.length} todo item${done.length === 1 ? "" : "s"} are complete. Do not add new items unless the user asks for more work.`,
    )
  }

  const lines = todos.map((todo) => {
    const marker =
      todo.status === "completed"
        ? "[x]"
        : todo.status === "in_progress"
          ? "[~]"
          : todo.status === "cancelled"
            ? "[-]"
            : "[ ]"
    return `${marker} ${todo.content}`
  })

  const guidance =
    active.length > 1
      ? "More than one item is marked in progress. Finish or re-mark them so exactly one is active."
      : active.length === 0
        ? "Nothing is marked in progress. Mark the item you are working on before continuing."
        : `Currently working on: ${active[0]?.content ?? ""}`

  return reminder(
    "todo",
    90,
    [
      "Current todo list:",
      ...lines,
      "",
      guidance,
      cancelled.length > 0 ? `${cancelled.length} item(s) were cancelled; do not revisit them.` : "",
      "Update the list as you go. Mark an item complete when it is actually done and verified, not before.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  )
}

/**
 * Files that changed on disk since the model last read them.
 *
 * Without this, the model edits from a stale copy and either clobbers the user's
 * work or produces a patch that no longer applies. This is the single most
 * valuable reminder in interactive use.
 */
export function fileChangeReminder(
  changes: ReadonlyArray<{ path: string; kind: "modified" | "deleted" | "created" }>,
  cwd: string,
): Reminder | undefined {
  if (changes.length === 0) return undefined
  const shown = changes.slice(0, 24)
  const lines = shown.map((change) => `${change.kind}: ${relative(cwd, change.path) || change.path}`)
  const extra = changes.length - shown.length
  return reminder(
    "file-changed",
    95,
    [
      "These files changed outside your edits since you last read them:",
      ...lines,
      extra > 0 ? `… and ${extra} more.` : "",
      "Re-read any of these before editing them. Your cached view is stale, and an edit based on it will fail or overwrite someone else's change.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  )
}

/**
 * Diagnostics from the language servers.
 *
 * Fed back after every edit so the model can self-correct in the same turn.
 * Pre-existing errors in untouched files are listed separately and explicitly
 * marked as not-yours, otherwise the model wanders off fixing unrelated code.
 */
export function diagnosticsReminder(
  diagnostics: ReadonlyArray<{
    path: string
    line: number
    column: number
    severity: "error" | "warning" | "info" | "hint"
    message: string
    source?: string
    introduced: boolean
  }>,
  cwd: string,
): Reminder | undefined {
  const errors = diagnostics.filter((item) => item.severity === "error")
  const warnings = diagnostics.filter((item) => item.severity === "warning")
  if (errors.length === 0 && warnings.length === 0) return undefined

  const format = (item: (typeof diagnostics)[number]): string =>
    `${relative(cwd, item.path) || item.path}:${item.line}:${item.column} ${item.severity}: ${truncate(item.message, 300)}${
      item.source ? ` [${item.source}]` : ""
    }`

  const introduced = errors.filter((item) => item.introduced)
  const existing = errors.filter((item) => !item.introduced)
  const sections: string[] = []

  if (introduced.length) {
    sections.push(
      [
        `${introduced.length} error${introduced.length === 1 ? "" : "s"} in code you just changed. Fix these before doing anything else:`,
        ...introduced.slice(0, 20).map(format),
      ].join("\n"),
    )
  }
  if (existing.length) {
    sections.push(
      [
        `${existing.length} pre-existing error${existing.length === 1 ? "" : "s"} in files you did not change. These are not yours; do not fix them unless the task requires it:`,
        ...existing.slice(0, 8).map(format),
      ].join("\n"),
    )
  }
  if (warnings.length && introduced.length === 0 && existing.length === 0) {
    sections.push(
      [`${warnings.length} warning(s):`, ...warnings.slice(0, 10).map(format)].join("\n"),
    )
  }

  return reminder("diagnostics", introduced.length ? 100 : 60, sections.join("\n\n"))
}

/**
 * Context budget warning.
 *
 * Announced before automatic compaction so the model can wrap up cleanly rather
 * than being cut off mid-thought.
 */
export function contextReminder(used: number, limit: number): Reminder | undefined {
  if (limit <= 0) return undefined
  const ratio = used / limit
  if (ratio < 0.7) return undefined

  const percent = Math.round(ratio * 100)
  if (ratio >= 0.92) {
    return reminder(
      "context-budget",
      88,
      `Context is ${percent}% full and will be compacted automatically very soon. Finish the current step, write anything important into files rather than relying on the conversation, and state the remaining work explicitly.`,
    )
  }
  if (ratio >= 0.82) {
    return reminder(
      "context-budget",
      55,
      `Context is ${percent}% full. Prefer targeted reads over whole files, and avoid re-reading what you already have.`,
    )
  }
  return reminder(
    "context-budget",
    35,
    `Context is ${percent}% full. Keep reads focused.`,
  )
}

/**
 * Permission denial.
 *
 * Stating the rule, not just the refusal, prevents the model from retrying the
 * same blocked call in a loop.
 */
export function permissionReminder(
  denials: ReadonlyArray<{ action: string; resource: string; reason?: string }>,
): Reminder | undefined {
  if (denials.length === 0) return undefined
  const lines = denials
    .slice(0, 10)
    .map((denial) => `${denial.action}: ${denial.resource}${denial.reason ? ` — ${denial.reason}` : ""}`)
  return reminder(
    "permission",
    92,
    [
      "These operations were blocked by the permission configuration:",
      ...lines,
      "Do not retry them. Either achieve the goal a different way, or tell the user which permission they need to grant and stop.",
    ].join("\n"),
  )
}

/**
 * Doom-loop breaker.
 *
 * Repeating an identical tool call is the classic failure mode of a stuck
 * agent. Naming the loop explicitly is far more effective than a generic
 * "try something else".
 */
export function doomLoopReminder(tool: string, repeats: number): Reminder {
  return reminder(
    "doom-loop",
    100,
    `You have called \`${tool}\` with identical arguments ${repeats} times in a row. It is not going to succeed on the next attempt either.

Stop and change approach:
- Re-read the error message you actually received, not the one you expected.
- Verify your assumptions about the file's current contents or the command's environment.
- If the operation genuinely cannot work here, say so and explain why rather than retrying.`,
  )
}

/** Plan-mode constraint, restated because it is easy to forget mid-task. */
export function planModeReminder(): Reminder {
  return reminder(
    "plan-mode",
    98,
    "You are in plan mode. Editing tools and mutating shell commands are unavailable. Produce a plan; do not attempt to implement it. If the user wants implementation, they will leave plan mode.",
  )
}

/**
 * Input the user typed while the model was working.
 *
 * Surfacing it immediately is what makes mid-task steering feel responsive
 * instead of the request being silently queued behind a long tool sequence.
 */
export function queuedInputReminder(messages: readonly string[]): Reminder | undefined {
  if (messages.length === 0) return undefined
  return reminder(
    "queued-input",
    100,
    [
      "The user sent this while you were working. It takes precedence over your current plan:",
      ...messages.map((message) => `> ${truncate(message, 2_000)}`),
      "Incorporate it now. If it changes the goal, abandon the old plan and say so.",
    ].join("\n"),
  )
}

export function customReminder(text: string, priority = 50): Reminder {
  return reminder("custom", priority, text)
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export interface ReminderInput {
  readonly todos?: readonly TodoItem[]
  readonly fileChanges?: ReadonlyArray<{ path: string; kind: "modified" | "deleted" | "created" }>
  readonly diagnostics?: Parameters<typeof diagnosticsReminder>[0]
  readonly contextUsed?: number
  readonly contextLimit?: number
  readonly denials?: Parameters<typeof permissionReminder>[0]
  readonly doomLoop?: { tool: string; repeats: number }
  readonly planMode?: boolean
  readonly queuedInput?: readonly string[]
  readonly custom?: readonly string[]
  readonly cwd: string
}

/** Builds the reminder set for one request, highest priority first. */
export function buildReminders(input: ReminderInput): Reminder[] {
  const out: Array<Reminder | undefined> = [
    input.queuedInput ? queuedInputReminder(input.queuedInput) : undefined,
    input.doomLoop ? doomLoopReminder(input.doomLoop.tool, input.doomLoop.repeats) : undefined,
    input.planMode ? planModeReminder() : undefined,
    input.diagnostics ? diagnosticsReminder(input.diagnostics, input.cwd) : undefined,
    input.fileChanges ? fileChangeReminder(input.fileChanges, input.cwd) : undefined,
    input.denials ? permissionReminder(input.denials) : undefined,
    input.todos ? todoReminder(input.todos) : undefined,
    input.contextUsed !== undefined && input.contextLimit !== undefined
      ? contextReminder(input.contextUsed, input.contextLimit)
      : undefined,
    ...(input.custom ?? []).map((text) => customReminder(text)),
  ]

  return out
    .filter((item): item is Reminder => item !== undefined)
    .sort((left, right) => right.priority - left.priority)
}

/**
 * Renders reminders into content parts.
 *
 * They are wrapped in a tag so the model can distinguish them from user text —
 * without it, models occasionally reply to a reminder as though the user had
 * written it.
 */
export function renderReminders(reminders: readonly Reminder[], budget = 6_000): Content[] {
  if (reminders.length === 0) return []
  const kept: string[] = []
  let used = 0
  for (const item of reminders) {
    const rendered = `<system-reminder kind="${item.kind}">\n${item.text}\n</system-reminder>`
    if (used + rendered.length > budget && kept.length > 0) break
    kept.push(rendered)
    used += rendered.length
  }
  return [
    {
      type: "text",
      text: [
        "<system-reminders>",
        "Automatic status notes from the Praxis runtime. The user did not write these and cannot see them. Act on them; do not reply to them or mention them.",
        "",
        ...kept,
        "</system-reminders>",
      ].join("\n"),
    },
  ]
}

/** Convenience: build and render in one call. */
export function reminderContent(input: ReminderInput, budget?: number): Content[] {
  return renderReminders(buildReminders(input), budget)
}
