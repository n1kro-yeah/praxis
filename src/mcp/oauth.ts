/**
 * OAuth for remote MCP servers.
 *
 * A remote MCP server is an arbitrary URL the user names in a configuration
 * file. There is no chance to pre-register a client with it, no known set of
 * endpoints, and no shared secret. Everything has to be discovered at first
 * contact, which is what this module does.
 *
 * The sequence is:
 *
 * 1. Call the server. If it answers, no authentication is needed and there is
 *    nothing more to do.
 * 2. On a 401, read the `WWW-Authenticate` challenge for a pointer to the
 *    authorization server. Fall back to probing well-known paths when absent.
 * 3. Register a client, if the server offers dynamic registration.
 * 4. Run the browser flow and store the tokens.
 *
 * Steps two and three routinely fail against real servers, and the failures are
 * handled rather than propagated, because a server that gets one of them wrong is
 * often still usable through the others.
 */

import { logger } from "../util/log.js"
import {
  authorize,
  discover,
  isExpired,
  parseChallenge,
  refresh,
  register,
  revoke,
  OAuthError,
  type AuthorizationServerMetadata,
  type ClientRegistration,
  type TokenSet,
} from "../auth/oauth.js"
import { openBrowser } from "../auth/pkce.js"

const log = logger("mcp.oauth")

/** Timeout for the probe request that discovers whether auth is needed. */
const PROBE_TIMEOUT_MS = 15_000

/** Client name sent during dynamic registration. */
const CLIENT_NAME = "Praxis"

/**
 * Scope requested when the server does not advertise its own.
 *
 * Deliberately absent rather than guessed. A scope the server does not
 * recognise is rejected outright by some implementations, and an empty request
 * usually yields the default scope, which is what is wanted.
 */
const DEFAULT_SCOPE: string | undefined = undefined

/* ------------------------------------------------------------------ */
/* Stored state                                                        */
/* ------------------------------------------------------------------ */

/**
 * Everything persisted for one server.
 *
 * The metadata and registration are stored alongside the tokens because
 * refreshing needs both, and rediscovering on every refresh would turn a
 * background token renewal into three network round trips.
 */
export interface McpAuthRecord {
  readonly server: string
  readonly url: string
  readonly metadata: AuthorizationServerMetadata
  readonly registration: ClientRegistration
  readonly tokens: TokenSet
  readonly updatedAt: number
}

export interface AuthStore {
  read(server: string): Promise<McpAuthRecord | undefined>
  write(record: McpAuthRecord): Promise<void>
  remove(server: string): Promise<void>
  list(): Promise<string[]>
}

/* ------------------------------------------------------------------ */
/* Probing                                                             */
/* ------------------------------------------------------------------ */

export interface ProbeResult {
  /** Whether the server demands authentication. */
  readonly required: boolean
  /** Metadata, when it could be found. */
  readonly metadata?: AuthorizationServerMetadata
  /** The resource metadata URL from the challenge, when the server sent one. */
  readonly resourceMetadata?: string
}

/**
 * Determines whether a server needs authentication, and where to authenticate.
 *
 * The probe is a real initialize request rather than a bare GET, because some
 * servers accept any GET and only enforce authentication on the protocol
 * endpoint. A GET against those would report no authentication needed, and the
 * failure would then surface much later as a confusing error during startup.
 */
export async function probe(url: string, headers?: Record<string, string>): Promise<ProbeResult> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "praxis", version: "1.0.0" },
    },
  }

  let response: Response

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    // A network failure is not an authentication problem, and reporting it as
    // one would send the user through a sign-in flow that cannot succeed.
    throw new OAuthError("could not reach the server: " + String(error))
  }

  if (response.status !== 401 && response.status !== 403) {
    return { required: false }
  }

  const challenge = parseChallenge(response.headers.get("www-authenticate"))

  // The challenge may point at a protected resource document, which in turn
  // names the authorization server. One extra request, but it is the only
  // reliable route when the resource and authorization server differ in origin.
  if (challenge.resourceMetadata) {
    const metadata = await followResourceMetadata(challenge.resourceMetadata)

    if (metadata) {
      return { required: true, metadata, resourceMetadata: challenge.resourceMetadata }
    }
  }

  const metadata = await discover(url)

  return { required: true, metadata, resourceMetadata: challenge.resourceMetadata }
}

/**
 * Follows a protected resource metadata URL to its authorization server.
 *
 * The document lists authorization servers rather than naming one, so the first
 * is taken. Servers publishing several are rare, and choosing between them would
 * need a policy this has no basis to form.
 */
async function followResourceMetadata(url: string): Promise<AuthorizationServerMetadata | undefined> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })

    if (!response.ok) return undefined

    const body = (await response.json()) as Record<string, unknown>

    const servers = body.authorization_servers

    if (!Array.isArray(servers) || servers.length === 0) return undefined

    const issuer = servers[0]

    if (typeof issuer !== "string") return undefined

    return await discover(issuer)
  } catch (error) {
    log.debug("could not read the protected resource metadata", { url, error: String(error) })

    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* Sign-in                                                             */
/* ------------------------------------------------------------------ */

export interface SignInOptions {
  readonly server: string
  readonly url: string
  readonly store: AuthStore
  readonly headers?: Record<string, string>
  /** Prints the URL when the browser could not be opened. */
  readonly prompt?: (url: string) => void
}

/**
 * Signs in to a remote MCP server, storing the result.
 *
 * Registration is attempted only when the server advertises an endpoint for it.
 * Servers without one expect a client id to have been arranged out of band, and
 * there is nothing useful to do about that beyond saying so clearly.
 */
export async function signIn(options: SignInOptions): Promise<McpAuthRecord> {
  const result = await probe(options.url, options.headers)

  if (!result.required) {
    throw new OAuthError(options.server + " does not require authentication.")
  }

  if (!result.metadata) {
    throw new OAuthError(
      options.server +
        " requires authentication but publishes no OAuth metadata, so there is no way to discover how to sign in. Its documentation should say which credentials to configure by hand.",
    )
  }

  const metadata = result.metadata

  if (!metadata.registration_endpoint) {
    throw new OAuthError(
      options.server +
        " requires authentication but does not support dynamic client registration. A client id has to be obtained from the provider and set in the configuration.",
    )
  }

  // The redirect URI has to be registered before the listener binds a port, so
  // every candidate port is registered up front. Providers accept a list, and
  // this avoids a second registration when the first port is taken.
  const redirectUris = [8976, 8977, 8978, 4589, 4590, 60123, 60124].map(
    (port) => "http://127.0.0.1:" + String(port) + "/callback",
  )

  const scope = pickScope(metadata)

  const registration = await register(metadata.registration_endpoint, {
    clientName: CLIENT_NAME,
    redirectUris,
    scope,
  })

  const tokens = await authorize({
    metadata,
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
    scope,
    // Audience restriction. Without it, a token issued for this server is valid
    // at every other server sharing the same authorization server.
    resource: options.url,
    open: openBrowser,
    prompt: options.prompt,
  })

  const record: McpAuthRecord = {
    server: options.server,
    url: options.url,
    metadata,
    registration,
    tokens,
    updatedAt: Date.now(),
  }

  await options.store.write(record)

  log.info("signed in to an MCP server", { server: options.server })

  return record
}

/**
 * Chooses which scopes to request.
 *
 * Everything the server advertises, because a CLI agent genuinely may need any
 * of it and a second consent prompt mid-session is worse than a longer one at
 * sign-in. When nothing is advertised, nothing is sent.
 */
function pickScope(metadata: AuthorizationServerMetadata): string | undefined {
  const supported = metadata.scopes_supported

  if (!supported || supported.length === 0) return DEFAULT_SCOPE

  return supported.join(" ")
}

/* ------------------------------------------------------------------ */
/* Token access                                                        */
/* ------------------------------------------------------------------ */

/**
 * Returns a usable access token, refreshing if needed.
 *
 * Called before every request to an authenticated server, so the fast path \u2014 a
 * valid token already in hand \u2014 does no work beyond an expiry comparison.
 *
 * A failed refresh deletes the stored record. The alternative is retrying a
 * dead credential on every request for the rest of the session, which produces a
 * stream of failures that never resolves and never explains itself.
 */
export async function accessToken(server: string, store: AuthStore): Promise<string | undefined> {
  const record = await store.read(server)

  if (!record) return undefined

  if (!isExpired(record.tokens)) return record.tokens.accessToken

  if (!record.tokens.refreshToken) {
    log.info("a stored token expired and cannot be refreshed", { server })

    await store.remove(server)

    return undefined
  }

  try {
    const tokens = await refresh(
      record.metadata,
      record.registration.client_id,
      record.tokens.refreshToken,
      {
        clientSecret: record.registration.client_secret,
        resource: record.url,
      },
    )

    await store.write({ ...record, tokens, updatedAt: Date.now() })

    log.debug("refreshed an MCP access token", { server })

    return tokens.accessToken
  } catch (error) {
    log.warn("could not refresh an MCP token; the stored credential has been removed", {
      server,
      error: String(error),
    })

    await store.remove(server)

    return undefined
  }
}

/**
 * Signs out, revoking the token where possible.
 *
 * Revocation is attempted first but its result is ignored, because the local
 * record is being deleted either way and a server error should not leave the user
 * apparently still signed in.
 */
export async function signOut(server: string, store: AuthStore): Promise<boolean> {
  const record = await store.read(server)

  if (!record) return false

  const token = record.tokens.refreshToken ?? record.tokens.accessToken

  await revoke(
    record.metadata,
    record.registration.client_id,
    token,
    record.tokens.refreshToken ? "refresh_token" : "access_token",
  )

  await store.remove(server)

  log.info("signed out of an MCP server", { server })

  return true
}

/** Summary of a stored credential, for `praxis mcp auth`. */
export interface AuthSummary {
  readonly server: string
  readonly url: string
  readonly issuer?: string
  readonly expiresAt?: number
  readonly expired: boolean
  readonly refreshable: boolean
}

export async function summarise(store: AuthStore): Promise<AuthSummary[]> {
  const names = await store.list()
  const result: AuthSummary[] = []

  for (const name of names) {
    const record = await store.read(name)

    if (!record) continue

    result.push({
      server: record.server,
      url: record.url,
      issuer: record.metadata.issuer,
      expiresAt: record.tokens.expiresAt,
      expired: isExpired(record.tokens),
      refreshable: record.tokens.refreshToken !== undefined,
    })
  }

  return result.sort((left, right) => left.server.localeCompare(right.server))
}
