/**
 * Session sharing and export.
 *
 * Two ways to get a conversation out of the tool: a link, and a file.
 *
 * The link uploads the session to a share service and returns a URL. Useful for
 * "look at what it did", for bug reports, and for showing a colleague a transcript
 * without asking them to install anything.
 *
 * The file is Markdown or JSON written locally. Useful when the conversation must
 * not leave the machine, which is most of the time in most organisations.
 *
 * Sharing is off unless asked for. A coding session contains file paths, source
 * code, environment details, and occasionally a secret that made it into a diff.
 * Uploading that by default would be indefensible, so the default is `manual`,
 * every upload is explicit, and the redaction pass below runs on everything that
 * leaves the machine.
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { Bus } from "../util/bus.js"
import { logger } from "../util/log.js"
import { newId } from "../util/id.js"
import { request } from "../util/http.js"
import { messageRepo, partRepo, sessionRepo } from "../storage/repo.js"
import type { MessageRecord, PartRecord, SessionRecord } from "./types.js"

const log = logger("session.share")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_SHARE_ENDPOINT = "https://share.praxis.dev"

const UPLOAD_TIMEOUT_MS = 30_000

/** Beyond this the upload is refused rather than truncated silently. */
const MAX_SHARE_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

/**
 * Patterns for things that must never be uploaded.
 *
 * This is a safety net, not a guarantee. It catches the shapes that are
 * recognisable \u2014 provider key prefixes, bearer tokens, private key headers \u2014 and
 * cannot catch a password that looks like an ordinary word. The interface says so
 * before uploading, because a redaction pass that people trust completely is worse
 * than none at all.
 */
const REDACTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /sk-[A-Za-z0-9]{20,}/g, label: "api-key" },
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, label: "api-key" },
  { pattern: /ghp_[A-Za-z0-9]{30,}/g, label: "github-token" },
  { pattern: /gho_[A-Za-z0-9]{30,}/g, label: "github-token" },
  { pattern: /github_pat_[A-Za-z0-9_]{50,}/g, label: "github-token" },
  { pattern: /glpat-[A-Za-z0-9_-]{20,}/g, label: "gitlab-token" },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, label: "slack-token" },
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "aws-key" },
  { pattern: /AIza[0-9A-Za-z_-]{35}/g, label: "google-key" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: "private-key" },
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: "jwt" },
  { pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, label: "bearer-token" },
  { pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*["']?([^\s"'&]{8,})["']?/gi, label: "credential" },
]

export interface RedactionResult {
  readonly text: string
  readonly redactions: Array<{ label: string; count: number }>
}

/**
 * Removes recognisable secrets from text.
 *
 * Reports what it found, so the interface can say "4 credentials were removed"
 * rather than silently changing the content. Someone who sees that count knows to
 * rotate something.
 */
export function redact(text: string): RedactionResult {
  const counts = new Map<string, number>()

  let result = text

  for (const { pattern, label } of REDACTION_PATTERNS) {
    result = result.replace(pattern, (match) => {
      counts.set(label, (counts.get(label) ?? 0) + 1)

      // Keeping a prefix makes the transcript readable \u2014 it is obvious what kind
      // of thing was there \u2014 without being useful to anyone.
      const prefix = match.slice(0, Math.min(6, Math.floor(match.length / 4)))

      return `${prefix}\u2026[redacted ${label}]`
    })
  }

  return {
    text: result,
    redactions: [...counts.entries()].map(([label, count]) => ({ label, count })),
  }
}

/**
 * Replaces the user's home directory with a placeholder.
 *
 * A transcript full of `/Users/firstname.lastname/` identifies the author to
 * anyone who reads it, which is not something people think about when they paste a
 * link into a public issue.
 */
export function anonymisePaths(text: string, home: string): string {
  if (!home) return text

  return text.split(home).join("~")
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface ExportOptions {
  readonly sessionId: string
  readonly format: "markdown" | "json" | "html"
  /** Excludes tool calls, leaving only the conversation. */
  readonly conversationOnly?: boolean
  /** Runs the redaction pass. On by default for uploads, off for local files. */
  readonly redactSecrets?: boolean
  readonly home?: string
}

export interface ExportResult {
  readonly content: string
  readonly format: string
  readonly redactions: Array<{ label: string; count: number }>
  readonly bytes: number
}

/**
 * Renders a session.
 *
 * Reverted messages are excluded. They are not part of the conversation any more,
 * and including them would show work that was explicitly undone as though it had
 * happened.
 */
export function exportSession(options: ExportOptions): ExportResult {
  const session = sessionRepo.get(options.sessionId)

  if (!session) {
    throw new Error(`There is no session with id ${options.sessionId}.`)
  }

  const messages = messageRepo.list(options.sessionId).filter((message) => !message.reverted)

  let content: string

  switch (options.format) {
    case "json":
      content = exportJson(session, messages)
      break
    case "html":
      content = exportHtml(session, messages, options.conversationOnly === true)
      break
    case "markdown":
    default:
      content = exportMarkdown(session, messages, options.conversationOnly === true)
      break
  }

  if (options.home) content = anonymisePaths(content, options.home)

  if (options.redactSecrets) {
    const redacted = redact(content)

    return {
      content: redacted.text,
      format: options.format,
      redactions: redacted.redactions,
      bytes: Buffer.byteLength(redacted.text, "utf8"),
    }
  }

  return {
    content,
    format: options.format,
    redactions: [],
    bytes: Buffer.byteLength(content, "utf8"),
  }
}

/**
 * Markdown export.
 *
 * Structured for reading rather than for round-tripping: headings per turn, tool
 * calls in collapsible blocks so a long transcript is skimmable, and a metadata
 * header giving model and cost, which is the first thing anyone asks about a
 * shared session.
 */
function exportMarkdown(
  session: SessionRecord,
  messages: MessageRecord[],
  conversationOnly: boolean,
): string {
  const lines: string[] = []

  lines.push(`# ${session.title || "Untitled session"}`, "")
  lines.push(`- **Created**: ${new Date(session.createdAt).toISOString()}`)
  lines.push(`- **Messages**: ${messages.length}`)

  if (session.model) lines.push(`- **Model**: ${session.model}`)
  if (session.agent) lines.push(`- **Agent**: ${session.agent}`)
  if (session.cost) lines.push(`- **Cost**: $${session.cost.toFixed(4)}`)

  lines.push("", "---", "")

  for (const message of messages) {
    const parts = partRepo.list(message.id)

    if (message.role === "user") {
      lines.push("## User", "")

      for (const part of parts) {
        if (part.type === "text") lines.push(part.text ?? "", "")
      }

      continue
    }

    if (message.role !== "assistant") continue

    lines.push("## Assistant", "")

    for (const part of parts) {
      renderPartMarkdown(part, lines, conversationOnly)
    }

    lines.push("")
  }

  return lines.join("\n")
}

function renderPartMarkdown(part: PartRecord, lines: string[], conversationOnly: boolean): void {
  switch (part.type) {
    case "text":
      if (part.text) lines.push(part.text, "")
      break

    case "reasoning":
      if (conversationOnly) break
      if (!part.text) break

      lines.push("<details><summary>Reasoning</summary>", "")
      lines.push(part.text, "")
      lines.push("</details>", "")
      break

    case "tool": {
      if (conversationOnly) break

      const metadata = (part.metadata ?? {}) as Record<string, unknown>
      const title = typeof metadata["title"] === "string" ? metadata["title"] : part.toolName

      lines.push(`<details><summary>\u{1F527} ${part.toolName}: ${title}</summary>`, "")

      if (part.input) {
        lines.push("```json", JSON.stringify(part.input, null, 2), "```", "")
      }

      if (part.output) {
        lines.push("```", String(part.output).slice(0, 20_000), "```", "")
      }

      lines.push("</details>", "")
      break
    }

    case "compaction":
      lines.push("> _The conversation was summarised at this point._", "")
      break

    default:
      break
  }
}

/**
 * JSON export.
 *
 * The complete record, for tooling. Everything the storage layer holds, with no
 * filtering beyond reverted messages, because a machine-readable export that has
 * quietly dropped fields is worse than useless for reconstructing what happened.
 */
function exportJson(session: SessionRecord, messages: MessageRecord[]): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        model: session.model,
        agent: session.agent,
        cost: session.cost,
        tokens: {
          input: session.inputTokens,
          output: session.outputTokens,
          cacheRead: session.cacheReadTokens,
          cacheWrite: session.cacheWriteTokens,
        },
      },
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        createdAt: message.createdAt,
        model: message.model,
        parts: partRepo.list(message.id).map((part) => ({
          id: part.id,
          type: part.type,
          text: part.text,
          toolName: part.toolName,
          input: part.input,
          output: part.output,
          metadata: part.metadata,
        })),
      })),
    },
    null,
    2,
  )
}

/**
 * A standalone HTML page.
 *
 * Self-contained, with the styles inline, because a shared transcript that
 * depends on a stylesheet somewhere else stops rendering the day that stylesheet
 * moves.
 */
function exportHtml(
  session: SessionRecord,
  messages: MessageRecord[],
  conversationOnly: boolean,
): string {
  const body: string[] = []

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue

    body.push(`<article class="${message.role}">`)
    body.push(`<h2>${message.role === "user" ? "User" : "Assistant"}</h2>`)

    for (const part of partRepo.list(message.id)) {
      if (part.type === "text" && part.text) {
        body.push(`<div class="text">${escapeHtml(part.text)}</div>`)
        continue
      }

      if (part.type === "tool" && !conversationOnly) {
        body.push("<details class=\"tool\">")
        body.push(`<summary>${escapeHtml(part.toolName ?? "tool")}</summary>`)
        body.push(`<pre>${escapeHtml(String(part.output ?? "").slice(0, 20_000))}</pre>`)
        body.push("</details>")
      }
    }

    body.push("</article>")
  }

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(session.title || "praxis session")}</title>`,
    "<style>",
    "body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}",
    "article{margin:0 0 2rem;padding:0 0 1.5rem;border-bottom:1px solid #e5e5e5}",
    "article.user h2{color:#0a58ca}article.assistant h2{color:#146c43}",
    "h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;margin:0 0 .5rem}",
    ".text{white-space:pre-wrap}",
    "details.tool{margin:.75rem 0;background:#f6f8fa;border-radius:6px;padding:.5rem .75rem}",
    "summary{cursor:pointer;font-family:ui-monospace,monospace;font-size:.85rem}",
    "pre{overflow-x:auto;font-size:.8rem}",
    "@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}details.tool{background:#161b22}article{border-color:#30363d}}",
    "</style></head><body>",
    `<h1>${escapeHtml(session.title || "Untitled session")}</h1>`,
    body.join("\n"),
    "</body></html>",
  ].join("\n")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Writes an export to a file.
 *
 * Returns the absolute path, because the message "exported to session.md" is
 * unhelpful when the working directory is not what the user thought it was.
 */
export function exportToFile(options: ExportOptions & { path: string }): string {
  const result = exportSession(options)
  const path = resolve(options.path)

  writeFileSync(path, result.content, "utf8")

  log.info("session exported", { path, bytes: result.bytes, format: result.format })

  Bus.publish("sessionExported", {
    sessionId: options.sessionId,
    path,
    format: result.format,
    bytes: result.bytes,
  })

  return path
}

/* ------------------------------------------------------------------ */
/* Sharing                                                             */
/* ------------------------------------------------------------------ */

export type ShareMode = "manual" | "auto" | "disabled"

export interface ShareOptions {
  readonly sessionId: string
  readonly endpoint?: string
  readonly home?: string
  /** Skips redaction. Requires an explicit opt-in from the caller. */
  readonly raw?: boolean
}

export interface ShareResult {
  readonly url: string
  readonly shareId: string
  readonly secret: string
  readonly redactions: Array<{ label: string; count: number }>
}

/**
 * Uploads a session and returns a link.
 *
 * The secret returned alongside the id is what allows later updates and deletion.
 * It is stored with the session and never shown, so that possession of the link
 * does not confer the ability to change or remove what it points at.
 */
export async function share(options: ShareOptions): Promise<ShareResult> {
  const exported = exportSession({
    sessionId: options.sessionId,
    format: "json",
    redactSecrets: options.raw !== true,
    home: options.home,
  })

  if (exported.bytes > MAX_SHARE_BYTES) {
    throw new Error(
      `This session is ${(exported.bytes / 1024 / 1024).toFixed(1)} MB, which is above the ${MAX_SHARE_BYTES / 1024 / 1024} MB share limit. Export it to a file instead.`,
    )
  }

  const endpoint = options.endpoint ?? DEFAULT_SHARE_ENDPOINT
  const session = sessionRepo.get(options.sessionId)

  // An existing share is updated rather than duplicated, so a link that has
  // already been sent keeps working and reflects the latest state.
  const existing = session?.shareId ?? undefined
  const secret = session?.shareSecret ?? newId("share")

  log.info("uploading session", {
    sessionId: options.sessionId,
    bytes: exported.bytes,
    update: existing !== undefined,
    redactions: exported.redactions.length,
  })

  const response = await request({
    url: existing ? `${endpoint}/api/share/${existing}` : `${endpoint}/api/share`,
    method: existing ? "PUT" : "POST",
    headers: {
      "content-type": "application/json",
      "x-share-secret": secret,
    },
    body: exported.content,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  })

  if (response.status >= 400) {
    throw new Error(
      `The share service refused the upload (${response.status}). ${String(response.body).slice(0, 200)}`,
    )
  }

  let payload: { id?: string; url?: string }

  try {
    payload = JSON.parse(String(response.body)) as { id?: string; url?: string }
  } catch {
    throw new Error("The share service returned a response that could not be understood.")
  }

  const shareId = payload.id ?? existing

  if (!shareId) {
    throw new Error("The share service did not return an identifier.")
  }

  const url = payload.url ?? `${endpoint}/s/${shareId}`

  sessionRepo.update(options.sessionId, {
    shareId,
    shareSecret: secret,
    shareUrl: url,
    updatedAt: Date.now(),
  })

  Bus.publish("sessionShared", { sessionId: options.sessionId, url, shareId })

  return { url, shareId, secret, redactions: exported.redactions }
}

/**
 * Removes a shared session.
 *
 * Best effort. If the service is unreachable the local record is still cleared,
 * because leaving a session marked as shared when the user has asked for it not to
 * be is the more misleading of the two failures.
 */
export async function unshare(sessionId: string, endpoint?: string): Promise<boolean> {
  const session = sessionRepo.get(sessionId)

  if (!session?.shareId) return false

  const base = endpoint ?? DEFAULT_SHARE_ENDPOINT

  try {
    await request({
      url: `${base}/api/share/${session.shareId}`,
      method: "DELETE",
      headers: { "x-share-secret": session.shareSecret ?? "" },
      timeoutMs: UPLOAD_TIMEOUT_MS,
    })
  } catch (error) {
    log.warn("could not reach the share service to delete", { error: String(error) })
  }

  sessionRepo.update(sessionId, {
    shareId: null,
    shareSecret: null,
    shareUrl: null,
    updatedAt: Date.now(),
  })

  Bus.publish("sessionUnshared", { sessionId })

  return true
}

/** The share link for a session, if it has one. */
export function shareUrl(sessionId: string): string | undefined {
  return sessionRepo.get(sessionId)?.shareUrl ?? undefined
}

/**
 * Whether a session should be uploaded automatically.
 *
 * Only in `auto` mode, and never for a subagent session \u2014 those are internal, and
 * uploading each one would produce dozens of links nobody asked for.
 */
export function shouldAutoShare(mode: ShareMode, session: SessionRecord): boolean {
  if (mode !== "auto") return false
  if (session.parentId) return false
  if (session.internal) return false

  return true
}
