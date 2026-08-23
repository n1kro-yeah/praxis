/**
 * Session title generation.
 *
 * A session list full of "Fix the thing in the file" is unusable. Good titles are
 * what make session history navigable a week later, and they are cheap enough to
 * be worth generating properly.
 *
 * Three properties matter, in order:
 *
 *  1. **Never block the response.** The title is generated after the first
 *     exchange, in the background, on a small model. The user must never wait for
 *     it. A failure is silently ignored and the heuristic title stands.
 *  2. **Distinguish, don't summarise.** "Auth" is a bad title in a project where
 *     every session is about auth. "Refresh token expiry off by one" is a good
 *     one. The prompt pushes hard for the specific detail.
 *  3. **Never regenerate.** A title that changes as the session grows makes the
 *     list unstable and unrecognisable. It is set once.
 *
 * A rules-based fallback covers the case where no small model is configured, and
 * it is a real implementation rather than a placeholder: many users run a single
 * local model and would otherwise get no titles at all.
 */

import { logger } from "../util/log.js"
import { Bus, Events } from "../util/bus.js"
import { isAbortError } from "../util/error.js"
import { complete } from "../llm/stream.js"
import { resolveSmallModel } from "../provider/registry.js"
import { TITLE_PROMPT } from "../prompt/prompts.js"
import { usageCost } from "../provider/cost.js"
import * as Session from "./session.js"

const log = logger("session.title")

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export interface GenerateTitleOptions {
  readonly sessionId: string
  /** The first user message; used when the session is too new to read back. */
  readonly firstMessage?: string
  readonly signal?: AbortSignal
  /** Regenerate even if a title already looks generated. */
  readonly force?: boolean
}

/**
 * Generates and stores a title.
 *
 * Fire-and-forget from the caller's perspective: the loop calls this without
 * awaiting it. Everything inside is therefore defensive — an unhandled rejection
 * here would take down the process for a cosmetic feature.
 */
export async function generateTitle(options: GenerateTitleOptions): Promise<string | undefined> {
  const session = Session.find(options.sessionId)
  if (!session) return undefined
  if (session.internal) return undefined

  // Already has a good title and not forced.
  if (!options.force && looksGenerated(session.title)) return session.title

  const source = options.firstMessage ?? firstUserText(options.sessionId)
  if (!source || source.trim().length < 8) return undefined

  const model = await resolveSmallModel().catch(() => undefined)

  if (!model) {
    // No cheap model configured. The heuristic is genuinely useful, so use it
    // rather than leaving the session untitled.
    const heuristic = heuristicTitle(source)
    if (heuristic) {
      Session.rename(options.sessionId, heuristic)
      Bus.publish(Events.sessionTitled, { sessionId: options.sessionId, title: heuristic })
    }
    return heuristic
  }

  try {
    const response = await complete({
      model,
      system: [TITLE_PROMPT],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildTitleRequest(options.sessionId, source) }],
        },
      ],
      signal: options.signal,
      maxOutputTokens: 48,
      temperature: 0.3,
    })

    const title = sanitize(response.text)

    if (!title) {
      const heuristic = heuristicTitle(source)
      if (heuristic) Session.rename(options.sessionId, heuristic)
      return heuristic
    }

    Session.rename(options.sessionId, title)

    Bus.publish(Events.sessionTitled, {
      sessionId: options.sessionId,
      title,
      cost: usageCost(model, response.usage),
    })

    log.debug("title generated", { sessionId: options.sessionId, title })
    return title
  } catch (error) {
    if (isAbortError(error)) return undefined
    log.debug("title generation failed", { error: String(error) })
    const heuristic = heuristicTitle(source)
    if (heuristic) Session.rename(options.sessionId, heuristic)
    return heuristic
  }
}

/**
 * Builds the request, including a little of the assistant's response.
 *
 * The user's message alone is often ambiguous — "why is this failing?" says
 * nothing. The first part of the answer usually names the actual subject, which is
 * what makes the title distinctive.
 */
function buildTitleRequest(sessionId: string, userText: string): string {
  const parts: string[] = [`User request:\n${userText.slice(0, 1_200)}`]

  const messages = Session.activeMessages(sessionId)
  const assistant = messages.find((message) => message.role === "assistant" && !message.hidden)

  if (assistant) {
    const text = Session.parts(assistant.id)
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!)
      .join("\n")
      .trim()

    if (text.length > 40) {
      parts.push(`Start of the response:\n${text.slice(0, 600)}`)
    }

    // Tool names are a strong signal of the kind of work: a session full of
    // `edit` calls is implementation, one full of `grep` is investigation.
    const tools = Session.parts(assistant.id)
      .filter((part) => part.type === "tool-call" && part.toolName)
      .map((part) => part.toolName!)

    if (tools.length > 0) {
      parts.push(`Tools used: ${[...new Set(tools)].join(", ")}`)
    }
  }

  return parts.join("\n\n")
}

/* ------------------------------------------------------------------ */
/* Sanitising                                                          */
/* ------------------------------------------------------------------ */

/**
 * Cleans up a model-generated title.
 *
 * Small models add exactly the same decorations every time: surrounding quotes, a
 * "Title:" prefix, a trailing period, and a markdown heading marker. Stripping
 * them is more reliable than prompting them away.
 */
function sanitize(raw: string): string | undefined {
  let title = raw.trim()

  // Take the first line only; some models add an explanation.
  title = title.split("\n")[0]!.trim()

  title = title
    .replace(/^#+\s*/, "")
    .replace(/^(?:title|session title)\s*[:\-—]\s*/i, "")
    .replace(/^["'“‘`]+/, "")
    .replace(/["'”’`]+$/, "")
    .replace(/[.…]+$/, "")
    .replace(/\s+/g, " ")
    .trim()

  if (title.length < 3) return undefined
  if (title.length > 70) title = `${title.slice(0, 67).trimEnd()}…`

  // Reject the failure modes that produce a useless title.
  const lowered = title.toLowerCase()
  const useless = [
    "untitled",
    "new session",
    "conversation",
    "chat session",
    "user request",
    "coding task",
    "help request",
    "assistance",
    "i cannot",
    "i'm sorry",
    "as an ai",
  ]
  if (useless.some((entry) => lowered === entry || lowered.startsWith(entry))) return undefined

  // A title that is a full sentence is usually the model restating the request.
  if (title.split(" ").length > 12) {
    title = title.split(" ").slice(0, 10).join(" ")
  }

  return title
}

/**
 * Whether a title looks like it was generated rather than derived.
 *
 * The heuristic title is a truncation of the user's first line, so it tends to be
 * long and end mid-thought. Used to decide whether generation is still needed
 * after a restart.
 */
function looksGenerated(title: string): boolean {
  if (title === "") return false
  if (title.endsWith("…")) return false
  if (title.length > 62) return false
  return true
}

/* ------------------------------------------------------------------ */
/* Heuristic fallback                                                  */
/* ------------------------------------------------------------------ */

/** Words that carry no information in a title about a coding task. */
const FILLER = new Set([
  "a",
  "an",
  "the",
  "please",
  "could",
  "would",
  "can",
  "you",
  "i",
  "me",
  "my",
  "we",
  "our",
  "it",
  "this",
  "that",
  "there",
  "here",
  "just",
  "really",
  "very",
  "quite",
  "maybe",
  "perhaps",
  "help",
  "want",
  "need",
  "like",
  "try",
  "trying",
  "let",
  "lets",
  "hey",
  "hi",
  "hello",
  "thanks",
  "thank",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "do",
  "does",
  "did",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "and",
  "or",
  "but",
  "so",
  "if",
  "then",
  "than",
])

/**
 * Derives a title without a model.
 *
 * Strategy: prefer a recognisable subject — a file path, a symbol in backticks, an
 * error code — combined with the leading verb. Those are the parts a human would
 * pick out, and they are mechanically identifiable.
 */
export function heuristicTitle(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length < 5) return undefined

  const firstLine =
    trimmed
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("```") && !line.startsWith("#")) ?? trimmed

  /* A verb from the start of the request. */
  const verbMatch = /^\s*(?:please\s+)?(add|fix|remove|delete|refactor|rename|implement|update|migrate|write|create|debug|investigate|optimise|optimize|test|review|document|explain|convert|upgrade|revert|split|merge|extract|inline|replace|support|handle|improve)\b/i.exec(
    firstLine,
  )
  const verb = verbMatch ? capitalize(verbMatch[1]!.toLowerCase()) : undefined

  /* A subject: backticked identifier, file path, or quoted string. */
  const backtick = /`([^`\n]{2,40})`/.exec(trimmed)
  const path = /\b([\w.-]+\/[\w./-]+\.\w{1,6})\b/.exec(trimmed)
  const file = /\b([\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|kt|swift|sql|yaml|yml|json|toml|md))\b/.exec(
    trimmed,
  )
  const errorCode = /\b((?:TS|E|CS|SA)\d{3,5}|[A-Z][A-Z_]{3,}_ERROR)\b/.exec(trimmed)

  const subject =
    backtick?.[1] ??
    path?.[1] ??
    file?.[1] ??
    errorCode?.[1] ??
    keywordSubject(firstLine)

  if (verb && subject) {
    return truncateTitle(`${verb} ${subject}`)
  }

  if (subject) return truncateTitle(capitalize(subject))

  /* Fall back to the informative words of the first line. */
  const words = firstLine
    .replace(/[^\w\s./-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !FILLER.has(word.toLowerCase()))
    .slice(0, 7)

  if (words.length === 0) return undefined

  return truncateTitle(capitalize(words.join(" ")))
}

/** The most distinctive noun-ish token in a line. */
function keywordSubject(line: string): string | undefined {
  const candidates = line
    .replace(/[^\w\s./-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !FILLER.has(word.toLowerCase()))

  // camelCase or snake_case tokens are almost always identifiers, which make the
  // best subjects.
  const identifier = candidates.find(
    (word) => /[a-z][A-Z]/.test(word) || word.includes("_") || word.includes("-"),
  )
  if (identifier) return identifier

  // Otherwise the longest word, which correlates well with specificity.
  return candidates.sort((left, right) => right.length - left.length)[0]
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function truncateTitle(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 57).trimEnd()}…`
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function firstUserText(sessionId: string): string | undefined {
  for (const message of Session.activeMessages(sessionId)) {
    if (message.role !== "user") continue
    const text = Session.parts(message.id)
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!)
      .join("\n")
      .trim()
    if (text !== "") return text
  }
  return undefined
}

/**
 * Regenerates titles for sessions that never got one.
 *
 * Useful after configuring a small model for the first time: a user with fifty
 * heuristically-titled sessions gets them all named properly. Rate-limited and
 * capped, because fifty concurrent requests would trip a provider limit.
 */
export async function backfillTitles(options: {
  cwd?: string
  limit?: number
  signal?: AbortSignal
}): Promise<number> {
  const sessions = Session.list({ cwd: options.cwd, limit: options.limit ?? 25 }).filter(
    (session) => session.messageCount > 0 && !looksGenerated(session.title),
  )

  let updated = 0

  for (const session of sessions) {
    if (options.signal?.aborted) break
    const title = await generateTitle({ sessionId: session.id, signal: options.signal })
    if (title) updated++
    // Sequential on purpose: this runs in the background and a burst of requests
    // would compete with the user's actual work for rate limit.
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return updated
}
