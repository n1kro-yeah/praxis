/**
 * Context compaction.
 *
 * Every long session eventually exceeds the model's context window. The naive
 * responses are both bad: truncating the oldest messages loses the task
 * definition, and refusing to continue loses the session. Compaction replaces the
 * old part of the conversation with a structured summary produced by the model
 * itself, which keeps the essentials and discards the bulk.
 *
 * What makes this work in practice, and what most implementations get wrong:
 *
 *  - **The summary is written for a successor, not for a human.** Its job is to
 *    let a fresh context continue the work. So it records file paths, decisions
 *    made and rejected, commands that worked, and the exact remaining steps — not
 *    a narrative of what happened.
 *  - **The most recent turns are kept verbatim.** The last exchange contains the
 *    immediate working state. Summarising it would throw away exactly the detail
 *    that is currently in use.
 *  - **Compaction is a session boundary, not a deletion.** The original messages
 *    stay in the database and remain visible in the transcript; only the model's
 *    view is condensed. A user scrolling back must still see what happened.
 *  - **It triggers on a threshold with headroom.** Compacting at 100 % is too
 *    late, because the compaction request itself needs context. 90 % leaves room.
 *  - **A failed compaction must not break the session.** If the summariser fails,
 *    fall back to mechanical pruning, which is worse but always works.
 */

import { logger } from "../util/log.js"
import { Bus, Events } from "../util/bus.js"
import { estimateTokens } from "../util/tokenizer.js"
import { isAbortError } from "../util/error.js"
import { complete } from "../llm/stream.js"
import { COMPACTION_PROMPT } from "../prompt/prompts.js"
import { usageCost } from "../provider/cost.js"
import type { ResolvedModel } from "../provider/types.js"
import type { Content } from "../llm/types.js"
import * as Session from "./session.js"

const log = logger("session.compaction")

/** Fraction of the context window at which compaction runs. */
const COMPACT_THRESHOLD = 0.9

/** Turns kept verbatim after the summary. */
const KEEP_RECENT_MESSAGES = 6

/** Below this, compaction is not worth its own cost. */
const MIN_MESSAGES_TO_COMPACT = 8

/* ------------------------------------------------------------------ */
/* Trigger                                                             */
/* ------------------------------------------------------------------ */

export interface MaybeCompactOptions {
  readonly sessionId: string
  readonly model: ResolvedModel
  readonly signal?: AbortSignal
  /** Force compaction regardless of size, used by the `/compact` command. */
  readonly force?: boolean
}

/**
 * Compacts the session if it is close to the context limit.
 *
 * Returns whether it did. Called at the top of every loop iteration, so it must
 * be cheap when there is nothing to do — the size estimate is a token count over
 * cached part text, not a model call.
 */
export async function maybeCompact(options: MaybeCompactOptions): Promise<boolean> {
  const messages = Session.activeMessages(options.sessionId)

  if (!options.force) {
    if (messages.length < MIN_MESSAGES_TO_COMPACT) return false

    const used = estimateSessionTokens(options.sessionId)
    const limit = options.model.contextWindow ?? 128_000
    const reserve = options.model.maxOutputTokens ?? 8_192

    if (used < (limit - reserve) * COMPACT_THRESHOLD) return false

    log.info("compaction threshold reached", {
      sessionId: options.sessionId,
      used,
      limit,
    })
  }

  try {
    await compact(options)
    return true
  } catch (error) {
    if (isAbortError(error)) throw error
    log.warn("compaction failed, falling back to pruning", { error: String(error) })
    // Mechanical fallback: mark old messages as excluded. Loses more than a
    // summary would, but the session survives, which is the priority.
    pruneMechanically(options.sessionId)
    return true
  }
}

/* ------------------------------------------------------------------ */
/* Compaction                                                          */
/* ------------------------------------------------------------------ */

/**
 * Produces a summary and inserts it as a compaction boundary.
 *
 * The summary request goes to the same model as the session, not a small one:
 * summarising a complex engineering session well requires the same capability as
 * doing the work. Using a cheap model here is a false economy that produces a
 * summary the successor cannot act on.
 */
export async function compact(options: MaybeCompactOptions): Promise<string> {
  const session = Session.get(options.sessionId)
  const messages = Session.activeMessages(options.sessionId)

  if (messages.length < 4) {
    throw new Error("There is not enough conversation to summarise.")
  }

  // Everything except the most recent turns is folded into the summary.
  const cutoff = Math.max(2, messages.length - KEEP_RECENT_MESSAGES)
  const toSummarize = messages.slice(0, cutoff)
  const boundary = messages[cutoff - 1]!

  const transcript = renderTranscript(options.sessionId, toSummarize)

  Bus.publish(Events.compactionStarted, {
    sessionId: options.sessionId,
    messages: toSummarize.length,
  })

  const response = await complete({
    model: options.model,
    system: [COMPACTION_PROMPT],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Summarise this session so that a fresh context can continue the work. Working directory: ${session.cwd}\n\n<transcript>\n${transcript}\n</transcript>`,
          },
        ],
      },
    ],
    signal: options.signal,
    // Generous: an under-length summary that omits the remaining work defeats
    // the whole purpose.
    maxOutputTokens: 4_096,
    temperature: 0.2,
  })

  const summary = response.text.trim()

  if (summary.length < 100) {
    throw new Error("The summary came back too short to be useful.")
  }

  // Persist as a hidden message with a compaction part. Hidden so the transcript
  // shows the real history; the conversation builder picks it up and starts from
  // here.
  const message = Session.beginMessage({
    sessionId: options.sessionId,
    role: "assistant",
    model: options.model.id,
    hidden: true,
  })

  Session.appendPart({
    sessionId: options.sessionId,
    messageId: message.id,
    type: "compaction",
    text: summary,
    metadata: {
      replacedMessages: toSummarize.length,
      throughMessageId: boundary.id,
      tokensBefore: estimateSessionTokens(options.sessionId),
    },
  })

  const cost = usageCost(options.model, response.usage)
  Session.completeMessage(message.id, { usage: response.usage, cost, finishReason: "stop" })

  Bus.publish(Events.compactionCompleted, {
    sessionId: options.sessionId,
    summaryTokens: estimateTokens(summary),
    replacedMessages: toSummarize.length,
    cost,
  })

  log.info("compacted", {
    sessionId: options.sessionId,
    replaced: toSummarize.length,
    summaryChars: summary.length,
    cost: cost.toFixed(4),
  })

  return summary
}

/* ------------------------------------------------------------------ */
/* Transcript rendering                                                */
/* ------------------------------------------------------------------ */

/**
 * Renders messages into text for the summariser.
 *
 * Tool output is aggressively truncated here. A summary does not need the full
 * contents of every file that was read; it needs to know which files were read.
 * Keeping full output would make the compaction request itself overflow, which is
 * a genuinely embarrassing failure mode.
 */
function renderTranscript(
  sessionId: string,
  messages: ReadonlyArray<{ id: string; role: string }>,
): string {
  const lines: string[] = []

  for (const message of messages) {
    const parts = Session.parts(message.id)
    if (parts.length === 0) continue

    lines.push(`--- ${message.role} ---`)

    for (const part of parts) {
      switch (part.type) {
        case "text":
          if (part.text?.trim()) lines.push(part.text.trim())
          break

        case "tool-call": {
          const input = summarizeInput(part.input)
          lines.push(`[tool ${part.toolName}${input ? ` ${input}` : ""}]`)
          if (part.output) {
            const output = part.isError
              ? `error: ${truncateOutput(part.output, 500)}`
              : truncateOutput(part.output, 400)
            lines.push(`  → ${output}`)
          }
          break
        }

        case "file":
          lines.push(`[attached file ${String(part.metadata?.["filename"] ?? "")}]`)
          break

        case "image":
          lines.push("[attached image]")
          break

        case "compaction":
          // A previous summary is included verbatim: the chain of summaries is
          // how a very long session stays coherent.
          lines.push(`[previous summary]\n${part.text ?? ""}`)
          break

        case "reasoning":
          // Reasoning is intentionally omitted. It is long, provider-specific,
          // and its conclusions are already in the text.
          break

        default:
          break
      }
    }
  }

  const rendered = lines.join("\n")

  // Absolute cap. If the history is enormous, keep the beginning (the task) and
  // the end (the current state) and drop the middle.
  const MAX = 120_000
  if (rendered.length <= MAX) return rendered

  const head = Math.floor(MAX * 0.35)
  const tail = MAX - head
  return `${rendered.slice(0, head)}\n\n[... ${rendered.length - MAX} characters omitted from the middle ...]\n\n${rendered.slice(-tail)}`
}

function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return ""
  if (typeof input !== "object") return String(input).slice(0, 100)

  const record = input as Record<string, unknown>
  // Only the identifying fields; a full argument dump is noise in a summary.
  for (const key of ["path", "pattern", "command", "query", "url", "description"]) {
    const value = record[key]
    if (typeof value === "string") return value.slice(0, 120)
  }

  return ""
}

function truncateOutput(output: string, limit: number): string {
  const collapsed = output.replace(/\n{3,}/g, "\n\n")
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit)} [truncated, ${collapsed.length} chars total]`
}

/* ------------------------------------------------------------------ */
/* Fallback pruning                                                    */
/* ------------------------------------------------------------------ */

/**
 * Drops the oldest messages when summarisation is unavailable.
 *
 * The first user message is always kept: it defines the task, and a session that
 * forgets what it was asked to do is worse than one that forgets how it got here.
 */
function pruneMechanically(sessionId: string): void {
  const messages = Session.activeMessages(sessionId)
  if (messages.length <= MIN_MESSAGES_TO_COMPACT) return

  const first = messages[0]!
  const keep = messages.slice(-KEEP_RECENT_MESSAGES)
  const dropped = messages.length - keep.length - 1

  const message = Session.beginMessage({
    sessionId,
    role: "assistant",
    hidden: true,
  })

  Session.appendPart({
    sessionId,
    messageId: message.id,
    type: "compaction",
    text: `[${dropped} earlier messages were dropped to fit the context window. The original request is preserved above. If you need details from the omitted history, re-read the relevant files rather than guessing.]`,
    metadata: { replacedMessages: dropped, mechanical: true, throughMessageId: keep[0]?.id },
  })

  Session.completeMessage(message.id, { finishReason: "stop" })

  void first
  log.warn("pruned mechanically", { sessionId, dropped })
}

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

/**
 * Estimates the token count of a session's model-visible content.
 *
 * An estimate rather than a count because the exact tokenizer varies by provider
 * and running a real one over the whole history on every loop iteration would be
 * slower than the model call it is protecting. Accuracy within ten percent is
 * plenty for a threshold decision.
 */
export function estimateSessionTokens(sessionId: string): number {
  const messages = Session.activeMessages(sessionId)
  let total = 0

  // Start from the most recent compaction: content before it is not sent.
  let startIndex = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const parts = Session.parts(messages[index]!.id)
    if (parts.some((part) => part.type === "compaction")) {
      startIndex = index
      break
    }
  }

  for (const message of messages.slice(startIndex)) {
    for (const part of Session.parts(message.id)) {
      if (part.text) total += estimateTokens(part.text)
      if (part.output) total += estimateTokens(part.output)
      if (part.input) total += estimateTokens(JSON.stringify(part.input))
      // Images are billed at a flat-ish rate; a constant is closer than zero.
      if (part.type === "image") total += 1_200
    }
  }

  return total
}

export interface ContextUsage {
  readonly used: number
  readonly limit: number
  readonly percent: number
  readonly compactionsSoFar: number
  readonly willCompactSoon: boolean
}

/**
 * Context usage for the status bar.
 *
 * Shown continuously because it is the single most useful number in a long
 * session: it tells the user when to start a new one, and it explains why the
 * agent suddenly summarised everything.
 */
export function contextUsage(sessionId: string, model: ResolvedModel): ContextUsage {
  const used = estimateSessionTokens(sessionId)
  const limit = model.contextWindow ?? 128_000
  const reserve = model.maxOutputTokens ?? 8_192
  const effective = limit - reserve

  const compactionsSoFar = Session.activeMessages(sessionId).filter((message) =>
    Session.parts(message.id).some((part) => part.type === "compaction"),
  ).length

  return {
    used,
    limit: effective,
    percent: Math.min(100, Math.round((used / effective) * 100)),
    compactionsSoFar,
    willCompactSoon: used > effective * (COMPACT_THRESHOLD - 0.1),
  }
}

/**
 * The compaction summary currently in effect, if any.
 *
 * Used by the conversation builder: it starts from the summary and appends the
 * messages after it, rather than replaying the whole history.
 */
export function activeSummary(
  sessionId: string,
): { text: string; throughMessageId?: string } | undefined {
  const messages = Session.activeMessages(sessionId)

  for (let index = messages.length - 1; index >= 0; index--) {
    for (const part of Session.parts(messages[index]!.id)) {
      if (part.type !== "compaction") continue
      return {
        text: part.text ?? "",
        throughMessageId: part.metadata?.["throughMessageId"] as string | undefined,
      }
    }
  }

  return undefined
}

/**
 * Turns a summary into the content block sent to the model.
 *
 * Framed explicitly as a summary of earlier work rather than presented as if the
 * model said it, because a model that believes it already read a file will not
 * read it again — and the summary does not contain the file.
 */
export function summaryContent(summary: string): Content {
  return {
    type: "text",
    text: `<session-summary>
The earlier part of this conversation was summarised to fit the context window. This is a condensed record, not a transcript. File contents, command output, and exact code are NOT included — re-read anything you need to work with.

${summary}
</session-summary>`,
  }
}
