/**
 * Loop detection.
 *
 * A model that gets stuck does not stop. It reads the same file, gets the same
 * content, draws the same conclusion, and reads it again. Each iteration costs
 * money and none of them make progress. Left alone this runs until the step limit,
 * which on a large context window can be a hundred model calls and a real amount
 * of money for nothing.
 *
 * The detector watches for repetition and intervenes. The design constraint that
 * shapes everything here is the false positive: legitimate work is repetitive too.
 * Editing forty files means forty near-identical write calls. Running the test
 * suite after each fix means the same command a dozen times, and that is the
 * correct behaviour, not a loop.
 *
 * So the signal is not repetition. It is **repetition without change**: the same
 * call, with the same arguments, producing the same result. A test command run
 * twelve times with twelve different outputs is progress. The same command twice
 * with byte-identical output means nothing happened in between.
 *
 * Intervention escalates rather than aborting. The first response is a note to the
 * model, which usually breaks the pattern because the model can see what it is
 * doing once told. Aborting immediately would kill sessions that would have
 * recovered on their own.
 */

import { Bus } from "../util/bus.js"
import { logger } from "../util/log.js"
import { hash } from "../util/hash.js"

const log = logger("session.doom")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Identical calls before the model is warned.
 *
 * Three. Two is common and often legitimate \u2014 read a file, edit it, read it back
 * to confirm. Three identical calls with identical results is not something that
 * happens during productive work.
 */
export const WARN_THRESHOLD = 3

/** Identical calls before the loop is broken by force. */
export const ABORT_THRESHOLD = 6

/** How many recent calls are examined. */
const WINDOW_SIZE = 24

/**
 * How many recent calls are checked for an alternating pattern.
 *
 * The A-B-A-B loop \u2014 edit a file, run a test, the test fails, edit it back \u2014 is
 * common and invisible to a detector that only compares consecutive calls.
 */
const CYCLE_WINDOW = 12

/** Longest repeating cycle looked for. */
const MAX_CYCLE_LENGTH = 4

/** Cycle repetitions before it counts as a loop. */
const CYCLE_THRESHOLD = 3

/**
 * How much output is hashed.
 *
 * A whole file read is large, and hashing all of it for every call is wasteful.
 * The first few kilobytes are enough to distinguish two results in practice; a
 * change confined to byte 50 000 of a file the model keeps re-reading is not the
 * case worth optimising for.
 */
const OUTPUT_SAMPLE_BYTES = 4096

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface CallRecord {
  readonly toolId: string
  readonly inputHash: string
  readonly outputHash: string
  readonly at: number
  /** Whether the call reported failure. */
  readonly failed: boolean
}

export type DoomVerdict =
  | { kind: "ok" }
  | { kind: "warn"; reason: string; repetitions: number; message: string }
  | { kind: "abort"; reason: string; repetitions: number; message: string }

interface SessionState {
  readonly calls: CallRecord[]
  /** Warnings already issued, so the same one is not repeated every step. */
  warned: Set<string>
  aborted: boolean
}

const states = new Map<string, SessionState>()

function stateFor(sessionId: string): SessionState {
  let state = states.get(sessionId)

  if (!state) {
    state = { calls: [], warned: new Set(), aborted: false }
    states.set(sessionId, state)
  }

  return state
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

export interface RecordInput {
  readonly sessionId: string
  readonly toolId: string
  readonly input: unknown
  readonly output: string
  readonly failed?: boolean
}

/**
 * Records a tool call and reports whether the session is stuck.
 *
 * Called after every tool execution. Cheap: two hashes and a scan of at most
 * twenty-four entries.
 */
export function record(input: RecordInput): DoomVerdict {
  const state = stateFor(input.sessionId)

  if (state.aborted) return { kind: "ok" }

  const record: CallRecord = {
    toolId: input.toolId,
    inputHash: hashInput(input.input),
    outputHash: hashOutput(input.output),
    at: Date.now(),
    failed: input.failed === true,
  }

  state.calls.push(record)

  while (state.calls.length > WINDOW_SIZE) state.calls.shift()

  const verdict = evaluate(state)

  if (verdict.kind === "abort") {
    state.aborted = true

    log.warn("aborting a session that is not making progress", {
      sessionId: input.sessionId,
      reason: verdict.reason,
      repetitions: verdict.repetitions,
    })

    Bus.publish("sessionLooping", {
      sessionId: input.sessionId,
      severity: "abort",
      reason: verdict.reason,
      repetitions: verdict.repetitions,
    })

    return verdict
  }

  if (verdict.kind === "warn") {
    // Only warn once per distinct pattern. Repeating the same note every step
    // fills the context with the warning instead of the work.
    if (state.warned.has(verdict.reason)) return { kind: "ok" }

    state.warned.add(verdict.reason)

    log.info("warning a session about repetition", {
      sessionId: input.sessionId,
      reason: verdict.reason,
      repetitions: verdict.repetitions,
    })

    Bus.publish("sessionLooping", {
      sessionId: input.sessionId,
      severity: "warn",
      reason: verdict.reason,
      repetitions: verdict.repetitions,
    })
  }

  return verdict
}

/**
 * Hashes tool input.
 *
 * Key order is normalised, because two calls that differ only in the order the
 * model happened to serialise the arguments are the same call, and a naive
 * `JSON.stringify` would treat them as different.
 */
function hashInput(input: unknown): string {
  return hash(stableStringify(input))
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`
}

/**
 * Hashes tool output.
 *
 * Timestamps and durations are stripped first. A command whose output differs
 * only in "took 1.3s" versus "took 1.4s" produced the same result, and treating
 * those as different defeats the detector on exactly the case it is meant to catch:
 * the same failing test run over and over.
 */
function hashOutput(output: string): string {
  const sample = output.slice(0, OUTPUT_SAMPLE_BYTES)

  const normalised = sample
    // ISO timestamps.
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<time>")
    // Durations.
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|m|min)\b/gi, "<duration>")
    // Memory addresses and hex ids.
    .replace(/0x[0-9a-f]{6,}/gi, "<addr>")
    // Process ids.
    .replace(/\bpid[=:\s]+\d+/gi, "pid=<pid>")

  return hash(normalised)
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

function evaluate(state: SessionState): DoomVerdict {
  const identical = countTrailingIdentical(state.calls)

  if (identical >= ABORT_THRESHOLD) {
    const last = state.calls[state.calls.length - 1]!

    return {
      kind: "abort",
      reason: `identical:${last.toolId}`,
      repetitions: identical,
      message: abortMessage(last.toolId, identical),
    }
  }

  if (identical >= WARN_THRESHOLD) {
    const last = state.calls[state.calls.length - 1]!

    return {
      kind: "warn",
      reason: `identical:${last.toolId}`,
      repetitions: identical,
      message: warnMessage(last.toolId, identical, last.failed),
    }
  }

  const cycle = detectCycle(state.calls)

  if (cycle) {
    if (cycle.repetitions >= CYCLE_THRESHOLD + 1) {
      return {
        kind: "abort",
        reason: `cycle:${cycle.signature}`,
        repetitions: cycle.repetitions,
        message: cycleAbortMessage(cycle.tools, cycle.repetitions),
      }
    }

    if (cycle.repetitions >= CYCLE_THRESHOLD) {
      return {
        kind: "warn",
        reason: `cycle:${cycle.signature}`,
        repetitions: cycle.repetitions,
        message: cycleWarnMessage(cycle.tools, cycle.repetitions),
      }
    }
  }

  const failures = countTrailingFailures(state.calls)

  if (failures >= ABORT_THRESHOLD) {
    return {
      kind: "abort",
      reason: "consecutive-failures",
      repetitions: failures,
      message: `The last ${failures} tool calls all failed. Stopping so the errors can be looked at rather than accumulating more of them.`,
    }
  }

  if (failures >= WARN_THRESHOLD) {
    return {
      kind: "warn",
      reason: "consecutive-failures",
      repetitions: failures,
      message: `The last ${failures} tool calls failed. Rather than trying more variations of the same approach, work out what the errors have in common. If something fundamental is missing \u2014 a dependency, a file, a permission \u2014 say so instead of continuing to retry.`,
    }
  }

  return { kind: "ok" }
}

/** How many calls at the end of the window are byte-identical. */
function countTrailingIdentical(calls: CallRecord[]): number {
  if (calls.length === 0) return 0

  const last = calls[calls.length - 1]!

  let count = 1

  for (let index = calls.length - 2; index >= 0; index--) {
    const call = calls[index]!

    if (
      call.toolId !== last.toolId ||
      call.inputHash !== last.inputHash ||
      call.outputHash !== last.outputHash
    ) {
      break
    }

    count++
  }

  return count
}

/** How many calls at the end of the window failed. */
function countTrailingFailures(calls: CallRecord[]): number {
  let count = 0

  for (let index = calls.length - 1; index >= 0; index--) {
    if (!calls[index]!.failed) break
    count++
  }

  return count
}

interface CycleInfo {
  readonly signature: string
  readonly tools: string[]
  readonly repetitions: number
}

/**
 * Looks for a repeating sequence at the end of the window.
 *
 * Cycles of length two to four. Longer than that and the calls are far enough
 * apart that the model is probably doing something structured; shorter is covered
 * by the identical-call check.
 *
 * A cycle only counts when the outputs repeat too. Editing five files in rotation
 * and running the tests between each is a length-two cycle by tool id, and it is
 * entirely productive.
 */
function detectCycle(calls: CallRecord[]): CycleInfo | undefined {
  const window = calls.slice(-CYCLE_WINDOW)

  for (let length = 2; length <= MAX_CYCLE_LENGTH; length++) {
    if (window.length < length * CYCLE_THRESHOLD) continue

    const candidate = window.slice(-length)
    let repetitions = 1

    for (let offset = length * 2; offset <= window.length; offset += length) {
      const previous = window.slice(-offset, -offset + length)

      if (previous.length !== length) break

      let matches = true

      for (let index = 0; index < length; index++) {
        const a = candidate[index]!
        const b = previous[index]!

        if (a.toolId !== b.toolId || a.inputHash !== b.inputHash || a.outputHash !== b.outputHash) {
          matches = false
          break
        }
      }

      if (!matches) break

      repetitions++
    }

    if (repetitions >= CYCLE_THRESHOLD) {
      return {
        signature: candidate.map((call) => `${call.toolId}:${call.inputHash.slice(0, 8)}`).join("|"),
        tools: candidate.map((call) => call.toolId),
        repetitions,
      }
    }
  }

  return undefined
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

/**
 * The note injected into the conversation on a warning.
 *
 * Written as an observation with a concrete suggestion, not a scolding. The
 * failure mode being corrected is a model that has lost track of what it already
 * tried, and the useful intervention is to point that out and suggest a different
 * angle.
 *
 * Naming the exact tool matters. "You are repeating yourself" is not actionable;
 * "you have read this file three times and it has not changed" is.
 */
function warnMessage(toolId: string, repetitions: number, failed: boolean): string {
  const base = `You have called ${toolId} ${repetitions} times with the same arguments and received the same result each time.`

  if (failed) {
    return `${base} Repeating it will not change the outcome. Either the operation cannot succeed as written, or something about the situation is different from what you are assuming. State what you expected and what actually happened, then try a different approach \u2014 or tell the user what is blocking you.`
  }

  switch (toolId) {
    case "read":
      return `${base} The file has not changed. You already have its contents; work from what you have rather than reading it again.`

    case "grep":
    case "glob":
      return `${base} The search returns the same results. If it is not finding what you expect, the pattern or the assumption behind it is wrong \u2014 try a different term, or look in a different place.`

    case "bash":
      return `${base} The command produces the same output every time. If you are waiting for something to change, it is not changing on its own.`

    case "edit":
      return `${base} The same edit is being applied repeatedly, which suggests it is not having the effect you expect. Read the file to see its current state before editing it again.`

    default:
      return `${base} Something in your approach is not working. Reconsider it rather than repeating the call.`
  }
}

function abortMessage(toolId: string, repetitions: number): string {
  return [
    `Stopped: ${toolId} was called ${repetitions} times with identical arguments and identical results.`,
    "",
    "The session was not making progress, so it was halted rather than continuing to spend on calls that return the same thing.",
    "",
    "Nothing has been lost \u2014 the conversation is intact and the files are as they were. Adding a message with more context, or a different instruction, will usually get past whatever the model was stuck on.",
  ].join("\n")
}

function cycleWarnMessage(tools: string[], repetitions: number): string {
  return [
    `You have repeated the sequence ${tools.join(" \u2192 ")} ${repetitions} times, and each pass produced the same results as the one before.`,
    "",
    "This is a loop: the actions are undoing or ignoring each other rather than building on each other. Stop and work out what the sequence is supposed to achieve and why it is not achieving it. If you cannot, describe the problem to the user instead of going round again.",
  ].join("\n")
}

function cycleAbortMessage(tools: string[], repetitions: number): string {
  return [
    `Stopped: the sequence ${tools.join(" \u2192 ")} repeated ${repetitions} times with no change in the results.`,
    "",
    "The session was cycling rather than progressing. The conversation and the files are unchanged.",
  ].join("\n")
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * Clears the detector for a session.
 *
 * Called when a new user message arrives. A new instruction is by definition a
 * change in the situation, and holding the previous run's history against it would
 * abort a fresh request for the sins of the last one.
 */
export function reset(sessionId: string): void {
  states.delete(sessionId)
}

/** Whether a session was halted by the detector. */
export function isAborted(sessionId: string): boolean {
  return states.get(sessionId)?.aborted === true
}

/**
 * Clears the abort flag.
 *
 * The user can override the detector \u2014 sometimes the repetition is genuinely
 * intended, such as polling for a build to finish. Refusing to continue after an
 * explicit instruction would be the tool overriding its operator.
 */
export function clearAbort(sessionId: string): void {
  const state = states.get(sessionId)

  if (!state) return

  state.aborted = false
  state.calls.length = 0
  state.warned.clear()
}

/** Diagnostic state, for the doctor command. */
export function inspect(sessionId: string): {
  calls: number
  identical: number
  failures: number
  aborted: boolean
  warnings: string[]
} {
  const state = states.get(sessionId)

  if (!state) {
    return { calls: 0, identical: 0, failures: 0, aborted: false, warnings: [] }
  }

  return {
    calls: state.calls.length,
    identical: countTrailingIdentical(state.calls),
    failures: countTrailingFailures(state.calls),
    aborted: state.aborted,
    warnings: [...state.warned],
  }
}

/** Discards state for every session. Used at shutdown and in tests. */
export function resetAll(): void {
  states.clear()
}
