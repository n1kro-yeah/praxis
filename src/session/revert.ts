/**
 * Undo and redo.
 *
 * The agent writes files. Sometimes it writes the wrong ones, and the user notices
 * three messages later. Without a way back, the recovery is `git checkout` \u2014 which
 * discards the user's own uncommitted work along with the agent's.
 *
 * So every assistant turn that touches the filesystem takes a snapshot first, and
 * a revert restores that snapshot and truncates the conversation to match.
 *
 * The conversation truncation is the part that is easy to get wrong. Restoring the
 * files but leaving the messages produces a transcript claiming edits that are no
 * longer there, and the model will then read a file, find it different from what
 * the transcript says it wrote, and start reasoning about a filesystem that is
 * lying to it. Files and messages move together or the session is incoherent.
 *
 * Redo exists because undo is often exploratory: revert, look, decide the original
 * was right after all. Reverted messages are marked rather than deleted until
 * something new is said, at which point the branch is unreachable and is dropped.
 */

import { Bus } from "../util/bus.js"
import { logger } from "../util/log.js"
import { messageRepo, partRepo, sessionRepo } from "../storage/repo.js"
import { restoreSnapshot, snapshotDiff, takeSnapshot } from "../git/snapshot.js"
import type { MessageRecord } from "./types.js"

const log = logger("session.revert")

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface RevertPoint {
  /** The message the session returns to. Everything after it is undone. */
  readonly messageId: string
  /** Snapshot taken before that message ran. */
  readonly snapshotId?: string
  /** How many messages would be undone. */
  readonly messageCount: number
  /** Files the undo would change. */
  readonly files: string[]
  readonly createdAt: number
}

export interface RevertResult {
  readonly reverted: number
  readonly files: string[]
  readonly snapshotId?: string
  /** Set when files could not be restored but messages were. */
  readonly warning?: string
}

/**
 * Redo state, held in memory only.
 *
 * A redo stack that survives a restart would offer to reapply changes to a
 * working tree that has moved on, which is worse than not offering at all.
 */
interface RedoEntry {
  readonly sessionId: string
  readonly messageIds: string[]
  readonly snapshotId?: string
  readonly at: number
}

const redoStacks = new Map<string, RedoEntry[]>()

/** Bounded, because each entry pins a snapshot. */
const MAX_REDO_DEPTH = 20

/* ------------------------------------------------------------------ */
/* Finding revert points                                               */
/* ------------------------------------------------------------------ */

/**
 * The points a session can be reverted to.
 *
 * One per user message, since "undo" means "undo what happened after I asked for
 * this", not "undo one message". Reverting to an assistant message mid-turn would
 * leave a half-finished exchange that the next request has to make sense of.
 *
 * Newest first, which is the order the picker shows them in.
 */
export function revertPoints(sessionId: string): RevertPoint[] {
  const messages = messageRepo.list(sessionId)
  const points: RevertPoint[] = []

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!

    if (message.role !== "user") continue
    if (message.reverted) continue

    const after = messages.slice(index).filter((entry) => !entry.reverted)

    points.push({
      messageId: message.id,
      snapshotId: message.snapshotId ?? undefined,
      messageCount: after.length,
      files: filesTouchedBy(after),
      createdAt: message.createdAt,
    })
  }

  return points
}

/**
 * The files a run of messages changed.
 *
 * Read from the recorded tool calls rather than from a diff, because the point of
 * showing this before an undo is to say what *will* change, and a diff of the
 * current tree against the snapshot also includes the user's own edits.
 */
function filesTouchedBy(messages: MessageRecord[]): string[] {
  const files = new Set<string>()

  for (const message of messages) {
    for (const part of partRepo.list(message.id)) {
      if (part.type !== "tool") continue

      const metadata = part.metadata as Record<string, unknown> | undefined
      const path = metadata?.["path"]

      if (typeof path === "string") files.add(path)

      const paths = metadata?.["paths"]

      if (Array.isArray(paths)) {
        for (const entry of paths) {
          if (typeof entry === "string") files.add(entry)
        }
      }
    }
  }

  return [...files].sort()
}

/**
 * The most recent revert point.
 *
 * What `/undo` uses. Undefined when the session has nothing to undo, which the
 * caller reports rather than treating as an error.
 */
export function lastRevertPoint(sessionId: string): RevertPoint | undefined {
  return revertPoints(sessionId)[0]
}

/* ------------------------------------------------------------------ */
/* Reverting                                                           */
/* ------------------------------------------------------------------ */

export interface RevertInput {
  readonly sessionId: string
  /** Defaults to the most recent point. */
  readonly messageId?: string
  readonly cwd: string
  /** Skips file restoration, undoing only the conversation. */
  readonly messagesOnly?: boolean
}

/**
 * Reverts a session.
 *
 * Files first, then messages. If the file restore fails there is still a
 * consistent state to report \u2014 nothing changed \u2014 whereas truncating the
 * conversation first and then failing to restore leaves a session whose transcript
 * disagrees with the disk, which is the exact failure this whole mechanism exists
 * to prevent.
 */
export async function revert(input: RevertInput): Promise<RevertResult> {
  const point = input.messageId
    ? revertPoints(input.sessionId).find((entry) => entry.messageId === input.messageId)
    : lastRevertPoint(input.sessionId)

  if (!point) {
    throw new Error("There is nothing to undo in this session.")
  }

  log.info("reverting session", {
    sessionId: input.sessionId,
    messageId: point.messageId,
    messages: point.messageCount,
    files: point.files.length,
  })

  let warning: string | undefined

  // Before restoring, snapshot the current state so redo has something to
  // return to. Without this, undo is one-way.
  let redoSnapshot: string | undefined

  if (!input.messagesOnly && point.snapshotId) {
    try {
      redoSnapshot = await takeSnapshot({ cwd: input.cwd, reason: "redo" })
    } catch (error) {
      log.warn("could not snapshot before reverting, so redo will not restore files", {
        error: String(error),
      })
    }

    try {
      await restoreSnapshot({ cwd: input.cwd, snapshotId: point.snapshotId })
    } catch (error) {
      // Reported rather than thrown. The user asked to undo; undoing the
      // conversation is most of what they wanted, and refusing to do any of it
      // because the file restore failed is not an improvement.
      warning = `Files could not be restored: ${error instanceof Error ? error.message : String(error)}. The conversation was rolled back anyway.`
      log.error("snapshot restore failed", { error: String(error) })
    }
  }

  const messages = messageRepo.list(input.sessionId)
  const index = messages.findIndex((entry) => entry.id === point.messageId)

  if (index === -1) {
    throw new Error("That message is no longer part of this session.")
  }

  const affected = messages.slice(index).filter((entry) => !entry.reverted)

  for (const message of affected) {
    messageRepo.markReverted(message.id, true)
  }

  sessionRepo.update(input.sessionId, {
    revertMessageId: point.messageId,
    updatedAt: Date.now(),
  })

  pushRedo(input.sessionId, {
    sessionId: input.sessionId,
    messageIds: affected.map((message) => message.id),
    snapshotId: redoSnapshot,
    at: Date.now(),
  })

  Bus.publish("sessionReverted", {
    sessionId: input.sessionId,
    messageId: point.messageId,
    messages: affected.length,
    files: point.files,
  })

  return {
    reverted: affected.length,
    files: point.files,
    snapshotId: point.snapshotId,
    warning,
  }
}

/* ------------------------------------------------------------------ */
/* Redo                                                                */
/* ------------------------------------------------------------------ */

function pushRedo(sessionId: string, entry: RedoEntry): void {
  const stack = redoStacks.get(sessionId) ?? []

  stack.push(entry)

  while (stack.length > MAX_REDO_DEPTH) stack.shift()

  redoStacks.set(sessionId, stack)
}

export function canRedo(sessionId: string): boolean {
  return (redoStacks.get(sessionId)?.length ?? 0) > 0
}

export interface RedoInput {
  readonly sessionId: string
  readonly cwd: string
}

/**
 * Reapplies the last undo.
 *
 * Only available until something new is said. Once a new message exists, the
 * reverted branch is unreachable \u2014 reapplying it would interleave two
 * conversations that were never one.
 */
export async function redo(input: RedoInput): Promise<RevertResult> {
  const stack = redoStacks.get(input.sessionId)
  const entry = stack?.pop()

  if (!entry) {
    throw new Error("There is nothing to redo.")
  }

  log.info("redoing", {
    sessionId: input.sessionId,
    messages: entry.messageIds.length,
  })

  let warning: string | undefined

  if (entry.snapshotId) {
    try {
      await restoreSnapshot({ cwd: input.cwd, snapshotId: entry.snapshotId })
    } catch (error) {
      warning = `Files could not be restored: ${error instanceof Error ? error.message : String(error)}.`
      log.error("redo snapshot restore failed", { error: String(error) })
    }
  }

  for (const messageId of entry.messageIds) {
    messageRepo.markReverted(messageId, false)
  }

  // The revert marker moves back to whatever is still reverted, if anything.
  const remaining = messageRepo
    .list(input.sessionId)
    .filter((message) => message.reverted)
    .at(0)

  sessionRepo.update(input.sessionId, {
    revertMessageId: remaining?.id ?? null,
    updatedAt: Date.now(),
  })

  Bus.publish("sessionRedone", {
    sessionId: input.sessionId,
    messages: entry.messageIds.length,
  })

  return {
    reverted: entry.messageIds.length,
    files: [],
    snapshotId: entry.snapshotId,
    warning,
  }
}

/**
 * Discards reverted messages permanently.
 *
 * Called when a new prompt arrives. The reverted branch can no longer be reached
 * from the current conversation, so keeping it costs storage and confuses anything
 * that reads the session without filtering.
 */
export function commitRevert(sessionId: string): number {
  const reverted = messageRepo.list(sessionId).filter((message) => message.reverted)

  if (reverted.length === 0) return 0

  for (const message of reverted) {
    partRepo.deleteForMessage(message.id)
    messageRepo.delete(message.id)
  }

  sessionRepo.update(sessionId, { revertMessageId: null, updatedAt: Date.now() })
  redoStacks.delete(sessionId)

  log.info("discarded reverted messages", { sessionId, count: reverted.length })

  Bus.publish("sessionRevertCommitted", { sessionId, count: reverted.length })

  return reverted.length
}

/** Clears redo state for a session. */
export function clearRedo(sessionId: string): void {
  redoStacks.delete(sessionId)
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

export interface RevertPreview {
  readonly messageCount: number
  readonly files: string[]
  /** Unified diff of what the undo would change. */
  readonly diff?: string
  readonly hasSnapshot: boolean
}

/**
 * What an undo would do, without doing it.
 *
 * The dialog shows this. An undo that silently discards twenty minutes of work is
 * a bad experience even when it is exactly what was asked for, and the diff is
 * what makes the decision informed.
 */
export async function previewRevert(input: RevertInput): Promise<RevertPreview> {
  const point = input.messageId
    ? revertPoints(input.sessionId).find((entry) => entry.messageId === input.messageId)
    : lastRevertPoint(input.sessionId)

  if (!point) {
    return { messageCount: 0, files: [], hasSnapshot: false }
  }

  let diff: string | undefined

  if (point.snapshotId) {
    try {
      diff = await snapshotDiff({ cwd: input.cwd, snapshotId: point.snapshotId })
    } catch (error) {
      log.debug("could not produce a preview diff", { error: String(error) })
    }
  }

  return {
    messageCount: point.messageCount,
    files: point.files,
    diff,
    hasSnapshot: point.snapshotId !== undefined,
  }
}

/**
 * A one-line description of a revert point, for the picker.
 *
 * The user's own words are the only reliable way to identify a point in a
 * conversation; a timestamp is not something anyone remembers.
 */
export function describePoint(point: RevertPoint, text: string): string {
  const summary = text.replace(/\s+/g, " ").trim().slice(0, 60)
  const changed = point.files.length

  const suffix =
    changed === 0 ? "no file changes" : changed === 1 ? "1 file" : `${changed} files`

  return `${summary}\u2026 (${point.messageCount} messages, ${suffix})`
}

/**
 * Whether a session has anything to undo.
 *
 * Used to grey out the menu entry. Cheaper than building the full list, since it
 * stops at the first user message.
 */
export function canRevert(sessionId: string): boolean {
  for (const message of messageRepo.list(sessionId)) {
    if (message.role === "user" && !message.reverted) return true
  }

  return false
}
