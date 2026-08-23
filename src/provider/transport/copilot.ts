/**
 * GitHub Copilot transport.
 *
 * Copilot is not a public API: it is the same backend used by the editor
 * extensions, reached through a two-stage credential exchange:
 *
 *   1. a long-lived GitHub OAuth token (device flow, stored by `auth login`)
 *   2. exchanged at `https://api.github.com/copilot_internal/v2/token` for a
 *      short-lived (about 30 minute) bearer token plus an endpoint map
 *
 * The short-lived token is cached in memory and refreshed a minute before it
 * expires. Requests additionally require editor-identity headers; without them
 * the API returns 403 with no useful message.
 *
 * The payload itself is the OpenAI chat dialect, with two quirks:
 *   - vision requires an explicit `Copilot-Vision-Request: true` header
 *   - some models are gated behind an per-account policy and return 403 with
 *     `"model_not_supported"`, which we translate into a clear message
 */

import type { LlmRequest, LlmStreamEvent, Transport, TransportContext } from "../../llm/types.js"
import { authStore } from "../../auth/auth.js"
import { AuthError } from "../../util/error.js"
import { getJson } from "../../util/http.js"
import { logger } from "../../util/log.js"
import { framed, joinUrl, pickObject, pickString } from "../transport.js"
import { streamOpenAiChat } from "./openai-chat.js"

const log = logger("transport.copilot")

const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
const DEFAULT_ENDPOINT = "https://api.githubcopilot.com"

/** Identity headers the backend requires. */
export const COPILOT_HEADERS: Record<string, string> = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.99.0",
  "editor-plugin-version": "copilot-chat/0.26.0",
  "user-agent": "GitHubCopilotChat/0.26.0",
  "openai-intent": "conversation-edits",
  "x-github-api-version": "2025-04-01",
}

interface CopilotSession {
  token: string
  expiresAt: number
  endpoint: string
  vision: boolean
}

let cached: CopilotSession | undefined
let inflight: Promise<CopilotSession> | undefined

/**
 * Exchanges the stored GitHub token for a Copilot session token.
 * Concurrent callers share a single in-flight exchange.
 */
export async function copilotSession(githubToken?: string): Promise<CopilotSession> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached
  if (inflight) return inflight

  inflight = (async (): Promise<CopilotSession> => {
    const token = githubToken ?? (await resolveGithubToken())
    const response = await getJson<{
      token?: string
      expires_at?: number
      endpoints?: { api?: string }
      vision_enabled?: boolean
 data?: unknown
    }>(TOKEN_URL, {
      headers: {
        authorization: `token ${token}`,
        accept: "application/json",
        ...COPILOT_HEADERS,
      },
      timeoutMs: 15_000,
      retries: 1,
    })

    const data = response.data
    if (!data?.token) {
      throw new AuthError(
        "GitHub Copilot rejected the stored credential. Run `praxis auth login github-copilot` again.",
      )
    }

    const session: CopilotSession = {
      token: data.token,
      // `expires_at` is in seconds since the epoch.
      expiresAt: (data.expires_at ?? Math.floor(Date.now() / 1000) + 1_500) * 1000,
      endpoint: data.endpoints?.api ?? DEFAULT_ENDPOINT,
      vision: data.vision_enabled === true,
    }
    cached = session
    log.debug("copilot session refreshed", {
      endpoint: session.endpoint,
      expiresInMs: session.expiresAt - Date.now(),
    })
    return session
  })()

  try {
    return await inflight
  } finally {
    inflight = undefined
  }
}

async function resolveGithubToken(): Promise<string> {
  const credential = authStore().get("github-copilot")
  if (credential?.type === "oauth") return credential.access
  if (credential?.type === "api") return credential.key
  const env =
    process.env["GITHUB_COPILOT_TOKEN"] ??
    process.env["GH_COPILOT_TOKEN"] ??
    process.env["GITHUB_TOKEN"]
  if (env && env !== "") return env
  throw new AuthError(
    "No GitHub Copilot credential found. Run `praxis auth login github-copilot`.",
    { providerId: "github-copilot" },
  )
}

export function resetCopilotSession(): void {
  cached = undefined
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function needsVision(request: LlmRequest): boolean {
  for (const message of request.messages) {
    for (const item of message.content) {
      if (item.type === "image") return true
      if (item.type === "tool-result" && (item.attachments?.length ?? 0) > 0) return true
    }
  }
  return false
}

async function* streamCopilot(
  request: LlmRequest,
  context: TransportContext,
): AsyncGenerator<LlmStreamEvent> {
  const session = await copilotSession()

  const headers: Record<string, string> = {
    ...COPILOT_HEADERS,
    ...context.headers,
    ...(request.headers ?? {}),
  }
  if (needsVision(request) && session.vision) headers["copilot-vision-request"] = "true"

  const prepared: TransportContext = {
    ...context,
    apiKey: session.token,
    baseUrl: context.baseUrl === "" ? session.endpoint : context.baseUrl,
    headers,
  }

  const url = joinUrl(prepared.baseUrl, "/chat/completions")

  try {
    for await (const event of streamOpenAiChat(request, prepared, url)) {
      yield event
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Translate the two failure modes users actually hit.
    if (/model_not_supported|model not supported/i.test(message)) {
      throw new AuthError(
        `Model "${request.modelId}" is not enabled for this Copilot subscription. Enable it in GitHub settings or pick another model.`,
        { modelId: request.modelId },
      )
    }
    if (/\b401\b|\b403\b/.test(message)) {
      resetCopilotSession()
      throw new AuthError(
        "GitHub Copilot rejected the request. Run `praxis auth login github-copilot` to re-authenticate.",
      )
    }
    throw error
  }
}

export const CopilotTransport: Transport = {
  id: "github-copilot",
  stream(request, context) {
    return framed(request, () => streamCopilot(request, context))
  },
  async listModels() {
    const session = await copilotSession()
    const response = await getJson<{ data?: Array<{ id?: string; capabilities?: unknown }> }>(
      joinUrl(session.endpoint, "/models"),
      {
        headers: { authorization: `Bearer ${session.token}`, ...COPILOT_HEADERS },
        timeoutMs: 10_000,
      },
    )
    return (response.data?.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort()
  },
}
