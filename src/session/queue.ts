/**
 * Prompt queueing.
 *
 * The agent is busy for tens of seconds at a time. During that window the user
 * keeps thinking, and forcing them to wait before typing the next instruction
 * wastes the one resource the system cannot generate more of.
 *
 * So prompts queue. Type while the agent works; each queued prompt runs when the
 * one before it finishes.
 *
 * The interesting decisions are about what happens to the queue when things go
 * wrong, because that is where a naive implementation does real damage:
 *
 *  - **An error clears the queue by default.** If step three failed, steps four
 *    through eight were written on assumptions that no longer hold. Running them
 *    anyway produces confident work on a broken foundation. The queue is preserved
 *    and shown so nothing typed is lost, but it does not run unattended.
 *  - **Cancelling cancels everything.** Ctrl+C means stop, not "stop this one and
 *    start the next", which would be indistinguishable from the key not working.
 *  - **The queue is not persisted.** A prompt written for a state of the world
 *    that existed before a restart is usually wrong afterwards.
 */

import { Bus } from "../util/bus.js"
import { logger } from "../util/log.js"
import { newId } from "../util/id.js"
import { truncate } from "../util/string.js"

const log = logger("session.queue")

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface QueuedPrompt {
  readonly id: string
  readonly text: string
  /** Attachments resolved at enqueue time, not at run time. */
  readonly attachments: string[]
  /** Agent override for this prompt only. */
  readonly agent?: string
  /** Model override for this prompt only. */
  readonly model?: string
  readonly queuedAt: number
}

/** What to do with the rest of the queue after a prompt ends badly. */
export type FailurePolicy = "clear" | "continue" | "pause"

export interface QueueOptions {
  readonly maxLength?: number
  readonly onFailure?: FailurePolicy
}

/** A queue's state, for display. */
export type QueueState = "idle" | "running" | "paused"

const DEFAULT_MAX_LENGTH = 50

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

/**
 * One session's prompt queue.
 *
 * Deliberately not a generic task queue. It knows about sessions, publishes
 * session events, and has opinions about failure that a general-purpose queue
 * should not.
 */
export class PromptQueue {
  private readonly items: QueuedPrompt[] = []
  private state: QueueState = "idle"
  private current: QueuedPrompt | undefined
  private readonly maxLength: number
  private failurePolicy: FailurePolicy

  /** Set while a prompt is running, so the queue can abort it. */
  private controller: AbortController | undefined

  constructor(
    readonly sessionId: string,
    options: QueueOptions = {},
  ) {
    this.maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
    this.failurePolicy = options.onFailure ?? "clear"
  }

  /* ---------------------------------------------------------------- */
  /* Inspection                                                        */
  /* ---------------------------------------------------------------- */

  get length(): number {
    return this.items.length
  }

  get isEmpty(): boolean {
    return this.items.length === 0
  }

  get isRunning(): boolean {
    return this.state === "running"
  }

  get isPaused(): boolean {
    return this.state === "paused"
  }

  get running(): QueuedPrompt | undefined {
    return this.current
  }

  /** A copy, so callers cannot mutate the queue by accident. */
  list(): QueuedPrompt[] {
    return [...this.items]
  }

  peek(): QueuedPrompt | undefined {
    return this.items[0]
  }

  /* ---------------------------------------------------------------- */
  /* Mutation                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Adds a prompt.
   *
   * Returns the queued item so the interface can render it immediately with a
   * stable id, rather than waiting for a round trip.
   *
   * The length cap exists because an unbounded queue is a way to spend a lot of
   * money by accident \u2014 paste fifty lines into a terminal where each line becomes
   * a prompt and every one of them is a model call.
   */
  push(input: {
    text: string
    attachments?: string[]
    agent?: string
    model?: string
  }): QueuedPrompt {
    if (this.items.length >= this.maxLength) {
      throw new Error(
        `The queue already holds ${this.maxLength} prompts. Let some of them run, or clear the queue with /queue clear.`,
      )
    }

    const item: QueuedPrompt = {
      id: newId("prompt"),
      text: input.text,
      attachments: input.attachments ?? [],
      agent: input.agent,
      model: input.model,
      queuedAt: Date.now(),
    }

    this.items.push(item)

    log.debug("prompt queued", {
      sessionId: this.sessionId,
      id: item.id,
      depth: this.items.length,
    })

    Bus.publish("promptQueued", {
      sessionId: this.sessionId,
      id: item.id,
      text: truncate(item.text, 200),
      depth: this.items.length,
    })

    return item
  }

  /**
   * Adds a prompt at the front.
   *
   * For the interruption case: something needs to happen before the five things
   * already queued.
   */
  unshift(input: {
    text: string
    attachments?: string[]
    agent?: string
    model?: string
  }): QueuedPrompt {
    const item = this.push(input)

    this.items.pop()
    this.items.unshift(item)

    return item
  }

  /** Removes a queued prompt. Returns false if it already ran. */
  remove(id: string): boolean {
    const index = this.items.findIndex((item) => item.id === id)

    if (index === -1) return false

    const [removed] = this.items.splice(index, 1)

    Bus.publish("promptDequeued", {
      sessionId: this.sessionId,
      id: removed!.id,
      depth: this.items.length,
    })

    return true
  }

  /**
   * Moves a queued prompt.
   *
   * People reorder after realising the third thing should have been the first.
   * Out-of-range indices clamp rather than throw, since a drag past the end of a
   * list means "put it last".
   */
  move(id: string, to: number): boolean {
    const index = this.items.findIndex((item) => item.id === id)

    if (index === -1) return false

    const target = Math.max(0, Math.min(this.items.length - 1, to))

    if (target === index) return true

    const [item] = this.items.splice(index, 1)
    this.items.splice(target, 0, item!)

    Bus.publish("promptQueueReordered", {
      sessionId: this.sessionId,
      order: this.items.map((entry) => entry.id),
    })

    return true
  }

  /**
   * Replaces the text of a queued prompt.
   *
   * Editing beats deleting and retyping, particularly for the long prompt with
   * one wrong path in it.
   */
  edit(id: string, text: string): boolean {
    const index = this.items.findIndex((item) => item.id === id)

    if (index === -1) return false

    this.items[index] = { ...this.items[index]!, text }

    Bus.publish("promptQueueEdited", { sessionId: this.sessionId, id, text: truncate(text, 200) })

    return true
  }

  /**
   * Empties the queue.
   *
   * Returns what was removed so the interface can offer to restore it. Discarding
   * ten prompts on a mistyped command with no way back is the kind of thing people
   * remember.
   */
  clear(): QueuedPrompt[] {
    const removed = [...this.items]

    this.items.length = 0

    if (removed.length > 0) {
      log.info("prompt queue cleared", { sessionId: this.sessionId, count: removed.length })

      Bus.publish("promptQueueCleared", {
        sessionId: this.sessionId,
        count: removed.length,
      })
    }

    return removed
  }

  /** Restores previously cleared prompts, for undo. */
  restore(items: QueuedPrompt[]): void {
    this.items.unshift(...items)

    Bus.publish("promptQueueRestored", {
      sessionId: this.sessionId,
      count: items.length,
    })
  }

  /* ---------------------------------------------------------------- */
  /* Running                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Runs queued prompts until the queue is empty.
   *
   * The runner is passed in rather than imported, which keeps this module free of
   * a dependency on the session engine and makes the drain logic testable without
   * a model.
   *
   * Reentrancy matters here. Two concurrent drains would run the same prompt
   * twice, and the interface calls `drain` on every enqueue precisely because it
   * does not want to track whether one is already going.
   */
  async drain(
    runner: (prompt: QueuedPrompt, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.state === "running") return
    if (this.state === "paused") return

    this.state = "running"

    Bus.publish("promptQueueStarted", { sessionId: this.sessionId, depth: this.items.length })

    try {
      while (this.items.length > 0) {
        // Paused between prompts, which is the only safe place to stop.
        if ((this.state as QueueState) === "paused") break

        const item = this.items.shift()!
        this.current = item
        this.controller = new AbortController()

        Bus.publish("promptStarted", {
          sessionId: this.sessionId,
          id: item.id,
          remaining: this.items.length,
        })

        try {
          await runner(item, this.controller.signal)

          Bus.publish("promptCompleted", {
            sessionId: this.sessionId,
            id: item.id,
            remaining: this.items.length,
          })
        } catch (error) {
          const aborted = this.controller.signal.aborted

          log.warn("a queued prompt did not complete", {
            sessionId: this.sessionId,
            id: item.id,
            aborted,
            error: String(error),
          })

          Bus.publish("promptFailed", {
            sessionId: this.sessionId,
            id: item.id,
            error: error instanceof Error ? error.message : String(error),
            aborted,
          })

          // Cancellation stops everything. Anything else follows the policy.
          if (aborted) {
            this.handleAbort()
            break
          }

          if (this.handleFailure()) break
        } finally {
          this.current = undefined
          this.controller = undefined
        }
      }
    } finally {
      if (this.state === "running") this.state = "idle"

      Bus.publish("promptQueueDrained", {
        sessionId: this.sessionId,
        remaining: this.items.length,
        state: this.state,
      })
    }
  }

  /**
   * Applies the failure policy. Returns true to stop draining.
   *
   * The default clears, for the reason given at the top of the file: subsequent
   * prompts were written against a world that no longer exists.
   */
  private handleFailure(): boolean {
    switch (this.failurePolicy) {
      case "continue":
        return false

      case "pause":
        this.state = "paused"

        Bus.publish("promptQueuePaused", {
          sessionId: this.sessionId,
          remaining: this.items.length,
          reason: "error",
        })

        return true

      case "clear":
      default: {
        const discarded = this.clear()

        if (discarded.length > 0) {
          Bus.publish("promptQueueDiscarded", {
            sessionId: this.sessionId,
            count: discarded.length,
            reason: "error",
            prompts: discarded.map((entry) => entry.text),
          })
        }

        return true
      }
    }
  }

  /**
   * Handles cancellation.
   *
   * Always clears, whatever the failure policy says. Ctrl+C followed by the next
   * queued prompt starting immediately is the behaviour that makes people hold the
   * key down.
   */
  private handleAbort(): void {
    const discarded = this.clear()

    if (discarded.length > 0) {
      Bus.publish("promptQueueDiscarded", {
        sessionId: this.sessionId,
        count: discarded.length,
        reason: "cancelled",
        prompts: discarded.map((entry) => entry.text),
      })
    }
  }

  /**
   * Cancels whatever is running.
   *
   * Only signals; the runner decides how quickly to stop. A model call in flight
   * cannot be unmade, but the loop will not take another step.
   */
  abort(): boolean {
    if (!this.controller) return false

    this.controller.abort()

    return true
  }

  /** Stops after the current prompt. */
  pause(): void {
    if (this.state === "idle") {
      this.state = "paused"
      return
    }

    if (this.state === "running") this.state = "paused"

    Bus.publish("promptQueuePaused", {
      sessionId: this.sessionId,
      remaining: this.items.length,
      reason: "requested",
    })
  }

  /** Resumes. The caller must call `drain` again. */
  resume(): void {
    if (this.state !== "paused") return

    this.state = "idle"

    Bus.publish("promptQueueResumed", {
      sessionId: this.sessionId,
      remaining: this.items.length,
    })
  }

  setFailurePolicy(policy: FailurePolicy): void {
    this.failurePolicy = policy
  }

  getFailurePolicy(): FailurePolicy {
    return this.failurePolicy
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const queues = new Map<string, PromptQueue>()

/** The queue for a session, created on first use. */
export function queueFor(sessionId: string, options?: QueueOptions): PromptQueue {
  let queue = queues.get(sessionId)

  if (!queue) {
    queue = new PromptQueue(sessionId, options)
    queues.set(sessionId, queue)
  }

  return queue
}

/** Discards a session's queue. Called when a session is deleted. */
export function disposeQueue(sessionId: string): void {
  const queue = queues.get(sessionId)

  if (!queue) return

  queue.abort()
  queue.clear()
  queues.delete(sessionId)
}

/** Every live queue, for the status display. */
export function allQueues(): PromptQueue[] {
  return [...queues.values()]
}

/** Total queued prompts across all sessions. */
export function totalQueued(): number {
  let total = 0

  for (const queue of queues.values()) total += queue.length

  return total
}

/**
 * Aborts everything, everywhere.
 *
 * The shutdown path. Sessions are not stopped in any particular order because
 * they are independent, and waiting for a graceful stop at exit is a good way to
 * make a process that will not die.
 */
export function abortAll(): void {
  for (const queue of queues.values()) {
    queue.abort()
    queue.clear()
  }
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/**
 * A one-line summary of the queue.
 *
 * Shown in the status bar. Empty string when the queue is empty, so the status
 * bar does not permanently carry a "0 queued" that means nothing.
 */
export function queueSummary(queue: PromptQueue): string {
  if (queue.isEmpty && !queue.isPaused) return ""

  const parts: string[] = []

  if (queue.length > 0) {
    parts.push(`${queue.length} queued`)
  }

  if (queue.isPaused) parts.push("paused")

  return parts.join(" \u00b7 ")
}

/**
 * The queue rendered as lines for the panel.
 *
 * Numbered from one, since "remove prompt 0" is not how anyone thinks about a
 * list they can see.
 */
export function queueLines(queue: PromptQueue, width: number): string[] {
  return queue.list().map((item, index) => {
    const prefix = `${index + 1}. `
    const available = Math.max(10, width - prefix.length)
    const text = item.text.replace(/\s+/g, " ").trim()

    return prefix + truncate(text, available)
  })
}
