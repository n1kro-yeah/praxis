/**
 * Read tracking.
 *
 * The single most destructive thing an agent can do is overwrite work it never
 * saw. The scenario is mundane: the model reads a file at step three, the user
 * fixes a bug in it by hand at step five, and the model writes its edited version
 * at step nine. The user's fix is gone, there is no diff showing it left, and
 * nobody notices for a week.
 *
 * The defence is a rule with no exceptions: **a file must be read before it is
 * written, and it must not have changed since that read.** This module holds the
 * evidence for both halves.
 *
 * Modification time alone is not enough to decide whether a file changed.
 * Filesystems vary in resolution \u2014 HFS+ stores whole seconds, and two writes inside
 * the same second are indistinguishable by time. Size catches most of what time
 * misses, and a content hash catches the rest. Hashing every file on every check
 * would be wasteful, so it is computed once at read time and only compared when
 * time and size are ambiguous.
 *
 * State is per-session. Two sessions editing the same repository must not satisfy
 * each other's read requirements, because the whole point is that *this*
 * conversation has seen the current contents.
 */

import { statSync } from "node:fs"
import { resolve } from "node:path"

import { hash } from "../util/hash.js"
import { logger } from "../util/log.js"

const log = logger("file.timestamps")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Tolerance when comparing modification times.
 *
 * Two milliseconds. Some filesystems and network mounts round or drift slightly,
 * and treating a one-millisecond difference as a change would make writes fail on
 * NFS for no reason.
 */
const TIME_TOLERANCE_MS = 2

/**
 * Entries kept per session.
 *
 * A long session touching thousands of files should not hold all of them.
 * Eviction is by least recent use, which is right here: the file read forty steps
 * ago is unlikely to be the one about to be written.
 */
const MAX_ENTRIES = 4_000

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface ReadEntry {
  readonly path: string
  /** Modification time at the moment of reading. */
  readonly mtimeMs: number
  readonly size: number
  /** Hash of the content that was read. */
  readonly contentHash: string
  /** When the read happened, for eviction. */
  at: number
  /** Whether this session has also written the file. */
  written: boolean
}

const sessions = new Map<string, Map<string, ReadEntry>>()

function entriesFor(sessionId: string): Map<string, ReadEntry> {
  let entries = sessions.get(sessionId)

  if (!entries) {
    entries = new Map()
    sessions.set(sessionId, entries)
  }

  return entries
}

function evict(entries: Map<string, ReadEntry>): void {
  if (entries.size <= MAX_ENTRIES) return

  const sorted = [...entries.entries()].sort((a, b) => a[1].at - b[1].at)
  const excess = entries.size - MAX_ENTRIES

  for (let index = 0; index < excess; index++) {
    entries.delete(sorted[index]![0])
  }
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

/**
 * Records that a file was read.
 *
 * The stat is taken here rather than passed in, so that the recorded time is the
 * one the filesystem reports at this instant. Taking it from the caller invites a
 * subtle bug where the time predates the content.
 */
export function recordRead(sessionId: string, path: string, content: string): void {
  const absolute = resolve(path)

  let mtimeMs = 0
  let size = content.length

  try {
    const stats = statSync(absolute)
    mtimeMs = stats.mtimeMs
    size = stats.size
  } catch {
    // The file may have been deleted between reading and stating. Recording the
    // read anyway is right: the content was seen, and the staleness check will
    // notice the file is gone.
  }

  const entries = entriesFor(sessionId)

  entries.set(absolute, {
    path: absolute,
    mtimeMs,
    size,
    contentHash: hash(content),
    at: Date.now(),
    written: entries.get(absolute)?.written ?? false,
  })

  evict(entries)
}

/**
 * Records that a file was written.
 *
 * Updates the recorded state to the just-written content, so consecutive edits
 * to the same file do not each require a fresh read. Without this, a three-step
 * refactor of one file would fail on the second step, having been invalidated by
 * its own first step.
 */
export function recordWrite(sessionId: string, path: string, content: string): void {
  const absolute = resolve(path)

  let mtimeMs = Date.now()
  let size = Buffer.byteLength(content, "utf8")

  try {
    const stats = statSync(absolute)
    mtimeMs = stats.mtimeMs
    size = stats.size
  } catch {
    // Nothing useful to do; the write itself already succeeded or threw.
  }

  const entries = entriesFor(sessionId)

  entries.set(absolute, {
    path: absolute,
    mtimeMs,
    size,
    contentHash: hash(content),
    at: Date.now(),
    written: true,
  })

  evict(entries)
}

/* ------------------------------------------------------------------ */
/* Checking                                                            */
/* ------------------------------------------------------------------ */

export type StalenessReason =
  | "never-read"
  | "modified"
  | "deleted"
  | "replaced"

export interface StalenessResult {
  readonly stale: boolean
  readonly reason?: StalenessReason
  readonly message?: string
  /** When the file was read in this session. */
  readonly readAt?: number
}

/**
 * Whether a file has been read in this session.
 *
 * The first half of the rule. Separate from the staleness check because the two
 * failures need different messages: "read it first" versus "it changed since you
 * read it" lead to different next actions.
 */
export function hasRead(sessionId: string, path: string): boolean {
  return entriesFor(sessionId).has(resolve(path))
}

/**
 * Whether the file on disk still matches what was read.
 *
 * The comparison is layered by cost. Modification time is free and settles the
 * overwhelming majority of cases. Size is nearly free and catches same-second
 * writes of different length. The hash is only computed when the caller supplies
 * the current content, since reading the file purely to check would defeat the
 * purpose.
 */
export function checkStale(
  sessionId: string,
  path: string,
  currentContent?: string,
): StalenessResult {
  const absolute = resolve(path)
  const entry = entriesFor(sessionId).get(absolute)

  if (!entry) {
    return {
      stale: true,
      reason: "never-read",
      message: `You have not read ${path} in this session. Read it before editing it, so the edit is applied to what is actually there.`,
    }
  }

  let stats: ReturnType<typeof statSync>

  try {
    stats = statSync(absolute)
  } catch {
    return {
      stale: true,
      reason: "deleted",
      readAt: entry.at,
      message: `${path} no longer exists. It was deleted or moved after you read it.`,
    }
  }

  const timeChanged = Math.abs(stats.mtimeMs - entry.mtimeMs) > TIME_TOLERANCE_MS
  const sizeChanged = stats.size !== entry.size

  // Neither moved: the file is almost certainly untouched. The remaining
  // possibility \u2014 a same-second edit preserving byte count exactly \u2014 is rare
  // enough that paying for a hash on every check is not worth avoiding it.
  if (!timeChanged && !sizeChanged) {
    return { stale: false, readAt: entry.at }
  }

  // The time moved but the content may not have. Touching a file, or a build
  // step rewriting it identically, both do this, and failing the edit in that
  // case would be an obstruction with no upside.
  if (currentContent !== undefined) {
    if (hash(currentContent) === entry.contentHash) {
      return { stale: false, readAt: entry.at }
    }

    return {
      stale: true,
      reason: "modified",
      readAt: entry.at,
      message: staleMessage(path, entry.at, stats.mtimeMs),
    }
  }

  if (sizeChanged) {
    return {
      stale: true,
      reason: "modified",
      readAt: entry.at,
      message: staleMessage(path, entry.at, stats.mtimeMs),
    }
  }

  return {
    stale: true,
    reason: "replaced",
    readAt: entry.at,
    message: staleMessage(path, entry.at, stats.mtimeMs),
  }
}

/**
 * The message shown when an edit is refused for staleness.
 *
 * Says what happened, when, and what to do. The instinctive response to a
 * refusal is to try again, which will fail identically; naming the fix avoids a
 * pointless round trip.
 */
function staleMessage(path: string, readAt: number, modifiedAt: number): string {
  const gap = Math.max(0, modifiedAt - readAt)

  return [
    `${path} changed after you read it${gap > 0 ? ` (about ${describeGap(gap)} later)` : ""}.`,
    "Editing it now would overwrite whatever changed, so the edit was not applied.",
    "Read the file again to see its current contents, then redo the edit against those.",
  ].join(" ")
}

function describeGap(ms: number): string {
  if (ms < 1000) return "a moment"
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} minutes`

  return `${Math.round(ms / 3_600_000)} hours`
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/** Every path read in a session. */
export function readPaths(sessionId: string): string[] {
  return [...entriesFor(sessionId).keys()]
}

/** Every path written in a session. */
export function writtenPaths(sessionId: string): string[] {
  const result: string[] = []

  for (const entry of entriesFor(sessionId).values()) {
    if (entry.written) result.push(entry.path)
  }

  return result
}

/**
 * Paths that changed on disk since they were read.
 *
 * Used to build the note injected before a turn, so the model learns about
 * external edits before it acts on stale information rather than after.
 */
export function staleFiles(sessionId: string): Array<{ path: string; reason: StalenessReason }> {
  const result: Array<{ path: string; reason: StalenessReason }> = []

  for (const entry of entriesFor(sessionId).values()) {
    const check = checkStale(sessionId, entry.path)

    if (check.stale && check.reason && check.reason !== "never-read") {
      result.push({ path: entry.path, reason: check.reason })
    }
  }

  return result
}

/** When a file was read, if it was. */
export function readTime(sessionId: string, path: string): number | undefined {
  return entriesFor(sessionId).get(resolve(path))?.at
}

/**
 * Forgets a file.
 *
 * Called after an external change is reported to the model, so the next
 * interaction starts from a clean state rather than repeating the warning.
 */
export function forget(sessionId: string, path: string): void {
  entriesFor(sessionId).delete(resolve(path))
}

/** Discards a session's tracking. */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId)
}

/** Discards everything. Used at shutdown and in tests. */
export function clearAll(): void {
  sessions.clear()
}

/** Counts, for the doctor command. */
export function stats(): { sessions: number; entries: number } {
  let entries = 0

  for (const map of sessions.values()) entries += map.size

  return { sessions: sessions.size, entries }
}

/**
 * Copies tracking to a child session.
 *
 * A subagent inherits what its parent has read. Making it re-read the same files
 * would be a straightforward waste of context and money, and the parent's reads
 * are as current as the child's would be.
 */
export function inherit(parentSessionId: string, childSessionId: string): void {
  const parent = sessions.get(parentSessionId)

  if (!parent) return

  const child = entriesFor(childSessionId)

  for (const [path, entry] of parent) {
    // Written state is not inherited. The child has not written anything, and
    // pretending otherwise would let it skip a check it has not earned.
    child.set(path, { ...entry, written: false })
  }

  log.debug("child session inherited read state", {
    parent: parentSessionId,
    child: childSessionId,
    files: parent.size,
  })
}

/**
 * Merges a child session's reads back into its parent.
 *
 * After a subagent finishes, the parent may want to edit files the child read.
 * Requiring a re-read would be correct but wasteful \u2014 the content is as fresh as
 * the child left it, and the staleness check still guards the actual write.
 */
export function merge(childSessionId: string, parentSessionId: string): void {
  const child = sessions.get(childSessionId)

  if (!child) return

  const parent = entriesFor(parentSessionId)

  for (const [path, entry] of child) {
    const existing = parent.get(path)

    // Keep whichever read is more recent. An older entry would reintroduce
    // staleness the parent has already resolved.
    if (existing && existing.at >= entry.at) continue

    parent.set(path, { ...entry, written: existing?.written ?? entry.written })
  }

  evict(parent)
}
