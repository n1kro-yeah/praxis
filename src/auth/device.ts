/**
 * The device authorization grant (RFC 8628).
 *
 * The fallback when a browser cannot be opened on the machine running the
 * agent: over SSH, inside a container, on a headless server. Instead of
 * redirecting, the server issues a short code that the user types into a browser
 * somewhere else, while the CLI polls for the result.
 *
 * The polling rules are the whole difficulty. A server can ask the client to
 * slow down, and a client that ignores it gets rate limited into failure. The
 * loop below honours `slow_down`, respects the interval the server names, and
 * gives up at the expiry the server sets rather than at a locally chosen one.
 */

import { logger } from "../util/log.js"
import { OAuthError, type AuthorizationServerMetadata, type TokenSet } from "./oauth.js"

const log = logger("auth.device")

/** Timeout for a single request in the flow. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Polling interval when the server does not name one.
 *
 * Five seconds is the value the specification suggests. Faster is not better:
 * the user is typing a code into a browser, and no amount of polling makes that
 * happen sooner.
 */
const DEFAULT_INTERVAL_SECONDS = 5

/** Extra delay added each time the server says to slow down. */
const SLOW_DOWN_INCREMENT_SECONDS = 5

/** Upper bound on the interval, so a hostile server cannot stall the flow forever. */
const MAX_INTERVAL_SECONDS = 60

/** Fallback expiry when the server does not send one. */
const DEFAULT_EXPIRY_SECONDS = 900

export interface DeviceCode {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  /** A URI with the code already embedded, when the server provides one. */
  readonly verificationUriComplete?: string
  readonly expiresAt: number
  readonly intervalSeconds: number
}

/**
 * Requests a device code.
 *
 * The endpoint is not part of the standard discovery document in every
 * deployment, so it may need to be supplied explicitly. When absent from both,
 * the flow is unavailable and saying so plainly is better than probing paths that
 * will not exist.
 */
export async function requestDeviceCode(
  metadata: AuthorizationServerMetadata & { device_authorization_endpoint?: string },
  clientId: string,
  options: { scope?: string; endpoint?: string } = {},
): Promise<DeviceCode> {
  const endpoint = options.endpoint ?? metadata.device_authorization_endpoint

  if (!endpoint) {
    throw new OAuthError(
      "the authorization server does not advertise a device authorization endpoint, so sign-in without a browser is not possible here",
    )
  }

  const body = new URLSearchParams({ client_id: clientId })

  if (options.scope) body.set("scope", options.scope)

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const text = await response.text()

  if (!response.ok) {
    throw new OAuthError("the device code request failed: " + condense(text), undefined, response.status)
  }

  let parsed: Record<string, unknown>

  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new OAuthError("the device code response was not valid JSON")
  }

  if (typeof parsed.device_code !== "string" || typeof parsed.user_code !== "string") {
    throw new OAuthError("the device code response was missing the code")
  }

  if (typeof parsed.verification_uri !== "string") {
    throw new OAuthError("the device code response was missing the verification address")
  }

  const expiresIn =
    typeof parsed.expires_in === "number" ? parsed.expires_in : DEFAULT_EXPIRY_SECONDS

  const interval =
    typeof parsed.interval === "number" && parsed.interval > 0
      ? parsed.interval
      : DEFAULT_INTERVAL_SECONDS

  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    verificationUri: parsed.verification_uri,
    verificationUriComplete:
      typeof parsed.verification_uri_complete === "string"
        ? parsed.verification_uri_complete
        : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    intervalSeconds: Math.min(interval, MAX_INTERVAL_SECONDS),
  }
}

export interface PollOptions {
  /** Called before each attempt, for a countdown or spinner. */
  readonly onTick?: (secondsRemaining: number) => void
  /** Aborts the wait. */
  readonly signal?: AbortSignal
}

/**
 * Polls until the user approves, the code expires, or the attempt is refused.
 *
 * The five documented outcomes are handled distinctly, because they mean very
 * different things:
 *
 * - `authorization_pending` \u2014 keep waiting, this is the normal case
 * - `slow_down` \u2014 keep waiting, but less often
 * - `access_denied` \u2014 the user refused; stop immediately rather than waiting out
 *   the expiry on a decision that will not change
 * - `expired_token` \u2014 the code is dead; a new one is needed
 * - anything else \u2014 a real error
 *
 * Collapsing these into a generic failure produces the common and infuriating
 * behaviour of a CLI that sits at "waiting for approval" for fifteen minutes
 * after the user already clicked Deny.
 */
export async function pollForToken(
  metadata: AuthorizationServerMetadata,
  clientId: string,
  device: DeviceCode,
  options: PollOptions = {},
): Promise<TokenSet> {
  let intervalSeconds = device.intervalSeconds

  while (true) {
    if (options.signal?.aborted) {
      throw new OAuthError("the sign-in was cancelled")
    }

    if (Date.now() >= device.expiresAt) {
      throw new OAuthError("the device code expired before it was approved", "expired_token")
    }

    options.onTick?.(Math.max(0, Math.round((device.expiresAt - Date.now()) / 1000)))

    await sleep(intervalSeconds * 1000, options.signal)

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
      client_id: clientId,
    })

    let response: Response

    try {
      response = await fetch(metadata.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      // A transient network failure mid-poll should not end the flow. The user
      // may still be typing the code, and the next attempt will likely succeed.
      log.debug("a poll attempt failed to reach the server", { error: String(error) })

      continue
    }

    const text = await response.text()

    let parsed: Record<string, unknown> = {}

    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      // Handled by the status check below.
    }

    if (response.ok && typeof parsed.access_token === "string") {
      const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : undefined

      log.info("the device flow completed")

      return {
        accessToken: parsed.access_token,
        refreshToken:
          typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
        tokenType: typeof parsed.token_type === "string" ? parsed.token_type : "Bearer",
        expiresAt: expiresIn === undefined ? undefined : Date.now() + expiresIn * 1000,
        scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      }
    }

    const code = typeof parsed.error === "string" ? parsed.error : "unknown"

    if (code === "authorization_pending") continue

    if (code === "slow_down") {
      intervalSeconds = Math.min(intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS, MAX_INTERVAL_SECONDS)

      log.debug("the server asked us to poll less often", { intervalSeconds })

      continue
    }

    if (code === "access_denied") {
      throw new OAuthError("the sign-in was declined", code)
    }

    if (code === "expired_token") {
      throw new OAuthError("the device code expired before it was approved", code)
    }

    const description =
      typeof parsed.error_description === "string" ? parsed.error_description : condense(text)

    throw new OAuthError("the device flow failed: " + description, code, response.status)
  }
}

/**
 * Formats the instructions shown to the user.
 *
 * The code is spaced out because it has to be read off a screen and typed by
 * hand, often on a phone, and an unbroken run of eight characters is measurably
 * harder to transcribe than two groups of four. Servers that already format their
 * codes are left alone.
 */
export function describeDeviceCode(device: DeviceCode): string {
  const code = device.userCode.includes("-") || device.userCode.includes(" ")
    ? device.userCode
    : group(device.userCode)

  const lines = [
    "To sign in, open:",
    "",
    "  " + device.verificationUri,
    "",
    "and enter the code:",
    "",
    "  " + code,
  ]

  if (device.verificationUriComplete) {
    lines.push("", "Or open this address, which has the code filled in:", "", "  " + device.verificationUriComplete)
  }

  const minutes = Math.max(1, Math.round((device.expiresAt - Date.now()) / 60000))

  lines.push("", "The code expires in " + String(minutes) + " minute" + (minutes === 1 ? "" : "s") + ".")

  return lines.join("\n")
}

function group(code: string): string {
  if (code.length < 6 || code.length > 12) return code

  const half = Math.ceil(code.length / 2)

  return code.slice(0, half) + "-" + code.slice(half)
}

/**
 * Sleeps, waking early if the signal aborts.
 *
 * A plain timer would keep the process alive for the full interval after the
 * user pressed ctrl-c, which is the kind of small unresponsiveness that makes a
 * tool feel broken.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)

    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }

    timer.unref?.()

    signal?.addEventListener("abort", finish, { once: true })
  })
}

function condense(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ")

  return trimmed.length > 200 ? trimmed.slice(0, 200) + "\u2026" : trimmed
}
