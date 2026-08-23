/**
 * The `todowrite` and `todoread` tools.
 *
 * A shared, structured task list between the model and the user. It looks like a
 * convenience feature and is in fact one of the highest-leverage things in the
 * whole system, for three reasons:
 *
 *  1. **It survives compaction.** When the conversation is summarised, prose
 *     plans are lossy but the todo list is re-injected verbatim as a system
 *     reminder. A model that wrote down its plan can resume after compaction; one
 *     that kept the plan in its reasoning cannot.
 *  2. **It stops premature completion.** Requiring an explicit status transition
 *     makes "I have finished" a claim about specific items rather than a vibe.
 *     The completion reminder catches the very common failure where a model
 *     declares victory with three items still in progress.
 *  3. **It gives the user a progress bar.** On a task with twelve steps, seeing
 *     4/12 done is the difference between trusting the agent and killing it.
 *
 * The list is stored per session in SQLite so it is visible in the TUI, survives
 * a restart, and can be exported.
 */

import { s } from "../util/schema.js"
import { newId } from "../util/id.js"
import { Bus, Events } from "../util/bus.js"
import { todoRepo } from "../storage/repo.js"
import type { TodoItem, TodoStatus } from "../session/types.js"
import { defineTool, fail, ok } from "./types.js"

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const todoItemSchema = s.object({
  id: s
    .string()
    .optional()
    .describe("Stable identifier. Reuse the id from a previous call to update an item; omit it to create one."),
  content: s.string().describe("What needs to be done, as an imperative phrase."),
  status: s
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Current state of this item."),
  priority: s.enum(["high", "medium", "low"]).optional().describe("Relative importance."),
  note: s
    .string()
    .optional()
    .describe("Short detail: why it was cancelled, what is blocking it, or what was actually done."),
})

const todoWriteParameters = s.object({
  todos: s.array(todoItemSchema).describe("The complete list. Items you omit are removed."),
})

type TodoWriteInput = {
  todos: Array<{
    id?: string
    content: string
    status: TodoStatus
    priority?: "high" | "medium" | "low"
    note?: string
  }>
}

/* ------------------------------------------------------------------ */
/* Descriptions                                                        */
/* ------------------------------------------------------------------ */

const WRITE_DESCRIPTION = `Create and update your task list for this session.

Use this for any task that takes more than a couple of steps. It keeps you oriented, it survives context compaction, and the user can see your progress.

When to use it:
- The user asked for something with multiple distinct parts.
- You are about to start a task where you will need to remember what comes next.
- You discovered additional work while doing something else — add it rather than trying to hold it in mind.
- You just finished a step. Mark it completed immediately; do not batch updates.

When not to use it:
- A single, obvious, one-step change. Writing a one-item list is noise.
- Purely informational questions.

Rules that matter:
- Send the complete list every time. Items you leave out are deleted.
- Exactly one item should be in_progress at a time. Finish or park an item before starting another.
- Mark an item completed only when it is genuinely done — tests pass, the code compiles, the change is written. If you hit a blocker, keep it in_progress and add a note, or cancel it with a reason.
- Break work down to steps you can actually finish. "Fix the app" is not a task; "add the validation to the signup handler" is.
- Reuse the ids you were given so the user sees items update rather than being replaced.

Example of a good list for "add rate limiting to the API":
1. Read the existing middleware setup — completed
2. Implement the token bucket limiter — in_progress
3. Wire it into the router — pending
4. Add configuration for the limits — pending
5. Run the test suite — pending`

const READ_DESCRIPTION = `Read your current task list.

Use this when you are unsure what you were doing — after a long detour, after context was compacted, or when resuming a session. It returns the same list you wrote with todowrite, including which item is in progress.`

/* ------------------------------------------------------------------ */
/* todowrite                                                           */
/* ------------------------------------------------------------------ */

export const todoWriteTool = defineTool<TodoWriteInput>({
  id: "todowrite",
  readOnly: false,
  concurrent: false,
  init: () => ({
    description: WRITE_DESCRIPTION,
    parameters: todoWriteParameters as never,
    execute: async (input, context) => {
      if (!Array.isArray(input.todos)) {
        return fail("todowrite", "The todos field must be an array.")
      }

      const validation = validate(input.todos)
      if (validation) return fail("todowrite", validation)

      const repo = todoRepo()
      const existing = repo.list(context.sessionId)
      const existingById = new Map(existing.map((item) => [item.id, item]))

      const items: TodoItem[] = input.todos.map((entry, index) => {
        const previous = entry.id ? existingById.get(entry.id) : undefined
        return {
          id: entry.id ?? newId("todo"),
          sessionId: context.sessionId,
          content: entry.content.trim(),
          status: entry.status,
          priority: entry.priority ?? previous?.priority ?? "medium",
          note: entry.note ?? undefined,
          order: index,
          createdAt: previous?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          completedAt:
            entry.status === "completed"
              ? (previous?.status === "completed" ? previous.completedAt : Date.now())
              : undefined,
        }
      })

      repo.replace(context.sessionId, items)

      const transitions = describeTransitions(existing, items)
      Bus.publish(Events.todosUpdated, {
        sessionId: context.sessionId,
        total: items.length,
        completed: items.filter((item) => item.status === "completed").length,
      })

      const counts = tally(items)
      context.metadata({
        total: items.length,
        completed: counts.completed,
        inProgress: counts.in_progress,
        pending: counts.pending,
      })

      const body = [render(items), "", ...transitions].filter(Boolean).join("\n")
      const warning = warn(items)

      return ok(
        `${counts.completed}/${items.length} done`,
        warning ? `${body}\n\n${warning}` : body,
        {
          total: items.length,
          completed: counts.completed,
          inProgress: counts.in_progress,
        },
      )
    },
  }),
})

/* ------------------------------------------------------------------ */
/* todoread                                                            */
/* ------------------------------------------------------------------ */

export const todoReadTool = defineTool<Record<string, never>>({
  id: "todoread",
  readOnly: true,
  concurrent: true,
  init: () => ({
    description: READ_DESCRIPTION,
    parameters: s.object({}) as never,
    execute: async (_input, context) => {
      const items = todoRepo().list(context.sessionId)
      if (items.length === 0) {
        return ok(
          "no tasks",
          "Your task list is empty. If the current work has more than a couple of steps, write one with todowrite.",
          { total: 0 },
        )
      }
      const counts = tally(items)
      return ok(`${counts.completed}/${items.length} done`, render(items), {
        total: items.length,
        completed: counts.completed,
      })
    },
  }),
})

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Rejects lists that would make the feature useless.
 *
 * These are not pedantic checks. Two items in progress means the model has lost
 * track of what it is doing, and an empty content string produces a list the user
 * cannot read. Failing loudly here is much cheaper than letting the state drift.
 */
function validate(
  todos: TodoWriteInput["todos"],
): string | undefined {
  if (todos.length > 60) {
    return "That is too many items to be useful. Group the work into at most 20 meaningful steps."
  }

  const seen = new Set<string>()
  let inProgress = 0

  for (const [index, entry] of todos.entries()) {
    if (typeof entry.content !== "string" || entry.content.trim() === "") {
      return `Item ${index + 1} has no content.`
    }
    if (entry.content.length > 400) {
      return `Item ${index + 1} is too long. Keep each item to a short imperative phrase and put detail in note.`
    }
    if (!STATUSES.has(entry.status)) {
      return `Item ${index + 1} has an unknown status "${String(entry.status)}". Use pending, in_progress, completed, or cancelled.`
    }
    if (entry.id) {
      if (seen.has(entry.id)) return `Two items share the id ${entry.id}.`
      seen.add(entry.id)
    }
    if (entry.status === "in_progress") inProgress++
  }

  if (inProgress > 1) {
    return `${inProgress} items are marked in_progress. Exactly one task should be in progress at a time — finish or park the others first.`
  }

  return undefined
}

const STATUSES = new Set<string>(["pending", "in_progress", "completed", "cancelled"])

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
}

/**
 * Renders the list for the model.
 *
 * Plain text with stable markers rather than a table: the model reads this back
 * on every turn via the reminder system, and a compact form costs fewer tokens
 * for the same information.
 */
export function render(items: readonly TodoItem[]): string {
  const lines: string[] = []
  for (const item of items) {
    const priority = item.priority === "high" ? " (high)" : item.priority === "low" ? " (low)" : ""
    lines.push(`${MARKERS[item.status]} ${item.content}${priority}`)
    if (item.note) lines.push(`      → ${item.note}`)
  }
  return lines.join("\n")
}

/** Renders with ids, for the tool result where the model needs them to update. */
export function renderWithIds(items: readonly TodoItem[]): string {
  return items
    .map((item) => `${MARKERS[item.status]} ${item.content}  [id: ${item.id}]`)
    .join("\n")
}

export function tally(items: readonly TodoItem[]): Record<TodoStatus, number> & { total: number } {
  const counts: Record<TodoStatus, number> & { total: number } = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
    total: items.length,
  }
  for (const item of items) counts[item.status]++
  return counts
}

/**
 * Describes what changed, so the tool result is informative rather than a
 * repetition of the input.
 *
 * A model that sees "marked X completed, started Y" gets confirmation that its
 * intent was recorded. A model that sees its own list echoed back learns nothing.
 */
function describeTransitions(before: readonly TodoItem[], after: readonly TodoItem[]): string[] {
  const previous = new Map(before.map((item) => [item.id, item]))
  const lines: string[] = []

  for (const item of after) {
    const old = previous.get(item.id)
    if (!old) {
      if (item.status !== "pending") lines.push(`Added "${item.content}" as ${item.status}.`)
      continue
    }
    if (old.status === item.status) continue
    switch (item.status) {
      case "completed":
        lines.push(`Completed "${item.content}".`)
        break
      case "in_progress":
        lines.push(`Started "${item.content}".`)
        break
      case "cancelled":
        lines.push(`Cancelled "${item.content}"${item.note ? `: ${item.note}` : "."}`)
        break
      case "pending":
        lines.push(`Moved "${item.content}" back to pending.`)
        break
    }
  }

  const removed = before.filter((item) => !after.some((entry) => entry.id === item.id))
  for (const item of removed) {
    lines.push(`Removed "${item.content}".`)
  }

  return lines
}

/**
 * Nudges the model when the list is in a state that predicts a mistake.
 *
 * The two patterns worth catching:
 *  - Everything pending and nothing in progress: the model wrote a plan and did
 *    not start it, which usually means it is about to answer instead of act.
 *  - Work remaining but nothing in progress: the model finished a step and did
 *    not pick up the next one, which is the moment it tends to stop early.
 */
function warn(items: readonly TodoItem[]): string | undefined {
  const counts = tally(items)
  const outstanding = counts.pending + counts.in_progress

  if (outstanding === 0) {
    return counts.total > 0
      ? "All items are done. Verify the work actually holds up — run the build or the tests — before telling the user it is finished."
      : undefined
  }

  if (counts.in_progress === 0 && counts.pending > 0) {
    const next = items.find((item) => item.status === "pending")
    return `Nothing is in progress. Continue with "${next?.content ?? "the next item"}" — do not stop until the list is done or you need input from the user.`
  }

  return undefined
}

/* ------------------------------------------------------------------ */
/* Reminder support                                                    */
/* ------------------------------------------------------------------ */

/**
 * Builds the text injected as a system reminder on later turns.
 *
 * Only emitted when there is outstanding work, and deliberately terse: the point
 * is to keep the plan in front of the model without spending real context on it.
 */
export function todoReminder(sessionId: string): string | undefined {
  const items = todoRepo().list(sessionId)
  if (items.length === 0) return undefined

  const counts = tally(items)
  if (counts.pending === 0 && counts.in_progress === 0) {
    return `All ${counts.total} tasks are complete. Confirm the work is verified before reporting back.`
  }

  const lines = [
    `Task list (${counts.completed}/${counts.total} complete):`,
    render(items.filter((item) => item.status !== "cancelled")),
  ]

  if (counts.in_progress === 0) {
    lines.push("", "Nothing is currently in progress. Pick up the next item.")
  }

  return lines.join("\n")
}

/** Whether the session has unfinished work, used to block premature completion. */
export function hasOutstandingTodos(sessionId: string): boolean {
  const items = todoRepo().list(sessionId)
  return items.some((item) => item.status === "pending" || item.status === "in_progress")
}

/** Progress fraction for the status bar. */
export function todoProgress(sessionId: string): { completed: number; total: number } | undefined {
  const items = todoRepo().list(sessionId)
  if (items.length === 0) return undefined
  const active = items.filter((item) => item.status !== "cancelled")
  return {
    completed: active.filter((item) => item.status === "completed").length,
    total: active.length,
  }
}
