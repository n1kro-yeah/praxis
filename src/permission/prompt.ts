/**
 * Permission prompting.
 *
 * When a tool needs approval, something has to ask. In the interface that is a
 * dialog; over the HTTP API it is an event the client answers; in a non-interactive
 * run there is nobody to ask, so the configured default applies.
 *
 * This module is the part between the permission engine and whoever answers. It
 * owns the pending requests, routes them to the current asker, and applies the
 * answer \u2014 including the "always" answers, which write a rule so the same question
 * is not asked again.
 *
 * Two things here are worth being careful about:
 *
 *  - **A pending request must not outlive its session.** An abandoned prompt holds
 *    a promise that never settles, and the agent loop waiting on it never
 *    finishes. Every request is cancellable and every session teardown cancels
 *    what it owns.
 *  - **Identical concurrent requests are coalesced.** Three parallel edits to the
 *    same file should ask once, not three times. Without this, approving a batch
 *    operation means answering the same question repeatedly while more copies of
 *    it queue up behind.
 */

import { Bus } from "../util/bus.js"
import { logger } from "../util/log.js"
import { newId } from "../util/id.js"
import { truncate } from "../util/string.js"
import type { PermissionDecision, PermissionRequest, PermissionRisk } from "./types.js"

const log = logger("permission.prompt")

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * How a request was answered.
 *
 * The "always" variants are distinct from the plain ones because they have a side
 * effect \u2014 writing a rule \u2014 and the engine needs to know which happened.
 */
export type PromptAnswer =
  | "allow"
  | "allow_always"
  | "allow_session"
  | "deny"
  | "deny_always"
  | "cancel"

export interface PendingPrompt {
  readonly id: string
  readonly sessionId: string
  readonly request: PermissionRequest
  readonly createdAt: number
  /** Resolves when answered. */
  readonly answer: Promise<PromptAnswer>
  /** Number of callers waiting on this same question. */
  waiters: number
  resolve(answer: PromptAnswer): void
}

/**
 * Something that can answer a permission request.
 *
 * The interface installs one when it starts, the server installs one per
 * connected client, and the CLI installs a non-interactive one. Only one is
 * active at a time, so a request cannot be shown twice.
 */
export type PermissionAsker = (prompt: PendingPrompt) => void

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const pending = new Map<string, PendingPrompt>()

/** Coalescing index: a fingerprint of the question to the prompt asking it. */
const byFingerprint = new Map<string, PendingPrompt>()

let asker: PermissionAsker | undefined

/**
 * Rules granted for the current process only.
 *
 * "Allow for this session" should not survive a restart. Writing it to the
 * configuration file would make a one-off approval permanent, which is not what
 * the words mean.
 */
const sessionGrants = new Set<string>()

/** What to do when there is nobody to ask. */
let noninteractiveDefault: "allow" | "deny" = "deny"

export function setAsker(next: PermissionAsker | undefined): void {
  asker = next

  // A change of asker while requests are outstanding means the previous
  // interface has gone. Hand them to the new one rather than leaving them
  // stranded.
  if (next) {
    for (const prompt of pending.values()) next(prompt)
  }
}

export function setNoninteractiveDefault(value: "allow" | "deny"): void {
  noninteractiveDefault = value
}

export function hasAsker(): boolean {
  return asker !== undefined
}

export function pendingPrompts(sessionId?: string): PendingPrompt[] {
  const all = [...pending.values()]

  return sessionId ? all.filter((prompt) => prompt.sessionId === sessionId) : all
}

/* ------------------------------------------------------------------ */
/* Fingerprinting                                                      */
/* ------------------------------------------------------------------ */

/**
 * A key identifying "the same question".
 *
 * Session, action, and resource. Not the title or detail, which vary in wording
 * for the same underlying operation and would defeat the coalescing they are
 * supposed to enable.
 */
function fingerprint(sessionId: string, request: PermissionRequest): string {
  return `${sessionId}\u0000${request.action}\u0000${request.resource}`
}

/* ------------------------------------------------------------------ */
/* Asking                                                              */
/* ------------------------------------------------------------------ */

export interface AskInput {
  readonly sessionId: string
  readonly request: PermissionRequest
  /** Aborts the request when the caller goes away. */
  readonly signal?: AbortSignal
}

/**
 * Asks for permission and waits for an answer.
 *
 * Returns a decision rather than a raw answer, since the caller does not care
 * whether approval was one-off or permanent \u2014 only whether to proceed. The rule
 * writing happens here.
 */
export async function ask(input: AskInput): Promise<PermissionDecision> {
  const key = fingerprint(input.sessionId, input.request)

  // Already granted for this session.
  if (sessionGrants.has(key)) {
    log.debug("permission already granted for session", { key })
    return "allow"
  }

  // An identical question is already on screen; wait for the same answer rather
  // than stacking a second dialog on top of the first.
  const existing = byFingerprint.get(key)

  if (existing) {
    existing.waiters++
    log.debug("coalescing onto an identical pending request", {
      key,
      waiters: existing.waiters,
    })

    return applyAnswer(await existing.answer, key, input.request)
  }

  if (!asker) {
    // Nobody to ask. This is the non-interactive path: a piped run, a CI job, a
    // background trigger.
    log.info("no asker available, applying the non-interactive default", {
      action: input.request.action,
      resource: truncate(input.request.resource, 120),
      decision: noninteractiveDefault,
    })

    Bus.publish("permissionAutoDecided", {
      sessionId: input.sessionId,
      action: input.request.action,
      resource: input.request.resource,
      decision: noninteractiveDefault,
    })

    return noninteractiveDefault
  }

  let resolve!: (answer: PromptAnswer) => void

  const answer = new Promise<PromptAnswer>((settle) => {
    resolve = settle
  })

  const prompt: PendingPrompt = {
    id: newId("permission"),
    sessionId: input.sessionId,
    request: input.request,
    createdAt: Date.now(),
    answer,
    waiters: 1,
    resolve: (value) => {
      // Guard against a double answer, which happens when a client retries.
      if (!pending.has(prompt.id)) return

      pending.delete(prompt.id)
      byFingerprint.delete(key)

      resolve(value)
    },
  }

  pending.set(prompt.id, prompt)
  byFingerprint.set(key, prompt)

  // An aborted caller should not leave a dialog on screen.
  const onAbort = () => prompt.resolve("cancel")
  input.signal?.addEventListener("abort", onAbort, { once: true })

  Bus.publish("permissionAsked", {
    id: prompt.id,
    sessionId: input.sessionId,
    action: input.request.action,
    resource: input.request.resource,
    title: input.request.title,
    detail: input.request.detail,
    risk: input.request.risk,
    pattern: input.request.pattern,
  })

  log.info("asking for permission", {
    action: input.request.action,
    resource: truncate(input.request.resource, 120),
    risk: input.request.risk,
  })

  try {
    asker(prompt)
  } catch (error) {
    // An asker that throws would otherwise hang the agent loop forever.
    log.error("the permission asker threw", { error: String(error) })
    prompt.resolve("cancel")
  }

  const result = await answer

  input.signal?.removeEventListener("abort", onAbort)

  Bus.publish("permissionReplied", {
    id: prompt.id,
    sessionId: input.sessionId,
    action: input.request.action,
    resource: input.request.resource,
    answer: result,
  })

  return applyAnswer(result, key, input.request)
}

/**
 * Turns an answer into a decision, recording any rule it implies.
 *
 * "Always" persists to configuration; "session" stays in memory. Both are
 * recorded before returning, so a second request racing behind the first sees the
 * grant rather than asking again.
 */
function applyAnswer(
  answer: PromptAnswer,
  key: string,
  request: PermissionRequest,
): PermissionDecision {
  switch (answer) {
    case "allow":
      return "allow"

    case "allow_session":
      sessionGrants.add(key)
      return "allow"

    case "allow_always":
      sessionGrants.add(key)
      persistRule(request, "allow")
      return "allow"

    case "deny_always":
      persistRule(request, "deny")
      return "deny"

    case "deny":
    case "cancel":
    default:
      return "deny"
  }
}

/**
 * Records a rule for future runs.
 *
 * Published rather than written directly: the configuration layer owns the file,
 * and writing to it from here would mean two components with an opinion about its
 * format. The listener that writes it lives with the rest of the configuration
 * code.
 */
function persistRule(request: PermissionRequest, effect: "allow" | "deny"): void {
  const pattern = request.pattern ?? request.resource

  log.info("recording a permanent permission rule", {
    action: request.action,
    pattern,
    effect,
  })

  Bus.publish("permissionRuleAdded", {
    action: request.action,
    pattern,
    effect,
  })
}

/* ------------------------------------------------------------------ */
/* Answering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Answers a pending prompt by id.
 *
 * Used by the interface's dialog and by the HTTP endpoint. An unknown id is not
 * an error: the prompt may have been cancelled between the client rendering it and
 * the user clicking.
 */
export function respond(id: string, answer: PromptAnswer): boolean {
  const prompt = pending.get(id)

  if (!prompt) {
    log.debug("answer for an unknown or already-settled prompt", { id })
    return false
  }

  prompt.resolve(answer)

  return true
}

/**
 * Cancels every prompt for a session.
 *
 * Called when a session is aborted or deleted. Without it, an aborted run leaves
 * a dialog on screen for work that will never happen, and the promise behind it
 * keeps the loop alive.
 */
export function cancelSession(sessionId: string): number {
  let count = 0

  for (const prompt of [...pending.values()]) {
    if (prompt.sessionId !== sessionId) continue

    prompt.resolve("cancel")
    count++
  }

  if (count > 0) {
    log.info("cancelled pending permission prompts", { sessionId, count })
  }

  return count
}

/** Cancels everything. Used at shutdown. */
export function cancelAll(): void {
  for (const prompt of [...pending.values()]) prompt.resolve("cancel")
}

/** Clears the in-memory session grants. */
export function clearSessionGrants(): void {
  sessionGrants.clear()
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

export interface PromptOption {
  readonly answer: PromptAnswer
  readonly label: string
  readonly key: string
  readonly description: string
}

/**
 * The options offered for a request.
 *
 * Varies with risk. A high-risk operation \u2014 deleting files, running something
 * matched as destructive \u2014 does not offer "always allow", because a permanent rule
 * for that class of action is almost never what someone wants and is easy to click
 * through by reflex.
 */
export function promptOptions(risk: PermissionRisk): PromptOption[] {
  const options: PromptOption[] = [
    {
      answer: "allow",
      label: "Allow once",
      key: "y",
      description: "Permit this one operation.",
    },
  ]

  if (risk !== "high") {
    options.push({
      answer: "allow_session",
      label: "Allow for this session",
      key: "s",
      description: "Stop asking until praxis restarts.",
    })

    options.push({
      answer: "allow_always",
      label: "Always allow",
      key: "a",
      description: "Record a permanent rule in the project configuration.",
    })
  }

  options.push({
    answer: "deny",
    label: "Deny",
    key: "n",
    description: "Refuse this operation and tell the agent why.",
  })

  options.push({
    answer: "deny_always",
    label: "Always deny",
    key: "d",
    description: "Record a permanent rule refusing this.",
  })

  return options
}

/**
 * A human-readable description of what is being asked.
 *
 * The resource is shown in full when it is short and truncated in the middle when
 * it is not: for a path, the beginning and the end are both informative and the
 * middle rarely is.
 */
export function describeRequest(request: PermissionRequest): string {
  const resource =
    request.resource.length <= 80
      ? request.resource
      : `${request.resource.slice(0, 40)}\u2026${request.resource.slice(-36)}`

  return request.title || `${request.action}: ${resource}`
}

/**
 * A one-line warning for a high-risk request.
 *
 * Shown above the options in red. Deliberately concrete about what will happen
 * rather than generically cautionary; "this cannot be undone" is information,
 * "are you sure?" is not.
 */
export function riskWarning(request: PermissionRequest): string | undefined {
  if (request.risk !== "high") return undefined

  switch (request.action) {
    case "bash":
      return "This command matches a pattern that can destroy data or affect systems outside this project."
    case "write":
      return "This will overwrite an existing file. There is no snapshot of its current contents."
    case "delete":
      return "This deletes files. Recovery depends on version control."
    case "network":
      return "This sends data to an external service."
    default:
      return "This operation cannot be undone."
  }
}

/**
 * How long a prompt has been waiting, for display.
 *
 * The interface shows this after a few seconds, so an unattended session makes it
 * obvious that the agent is blocked rather than thinking.
 */
export function waitingFor(prompt: PendingPrompt): number {
  return Date.now() - prompt.createdAt
}

/* ------------------------------------------------------------------ */
/* Non-interactive asker                                               */
/* ------------------------------------------------------------------ */

/**
 * An asker that answers immediately from a fixed policy.
 *
 * Used by `praxis run` with `--yes` or `--no`, and by triggers. Separate from
 * simply having no asker, because it logs each decision: an unattended run that
 * approved forty operations should say so.
 */
export function automaticAsker(policy: "allow" | "deny"): PermissionAsker {
  return (prompt) => {
    log.info("answering automatically", {
      action: prompt.request.action,
      resource: truncate(prompt.request.resource, 120),
      policy,
    })

    prompt.resolve(policy)
  }
}

/**
 * An asker that reads from the terminal without the full interface.
 *
 * For `praxis run` in a terminal, where there is a user but no rendering loop.
 * Deliberately minimal: one line of question, one character of answer.
 */
export function readlineAsker(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): PermissionAsker {
  return (prompt) => {
    const options = promptOptions(prompt.request.risk)
    const warning = riskWarning(prompt.request)

    const lines: string[] = ["", describeRequest(prompt.request)]

    if (prompt.request.detail) lines.push(`  ${prompt.request.detail}`)
    if (warning) lines.push(`  ! ${warning}`)

    lines.push(`  ${options.map((option) => `[${option.key}] ${option.label}`).join("  ")}`)
    lines.push("  > ")

    output.write(lines.join("\n"))

    const onData = (chunk: Buffer | string) => {
      const character = chunk.toString().trim().toLowerCase().charAt(0)
      const option = options.find((entry) => entry.key === character)

      // An unrecognised key is treated as a denial rather than re-prompting.
      // Being asked the same question repeatedly because of a stray keypress is
      // worse than a refusal the agent can report and continue from.
      input.off("data", onData)
      output.write("\n")

      prompt.resolve(option?.answer ?? "deny")
    }

    input.on("data", onData)
  }
}
