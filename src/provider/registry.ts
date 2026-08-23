/**
 * Provider registry: the single place that answers "which models can I use
 * right now, and how do I call them".
 *
 * Resolution order for a model reference, highest priority first:
 *   1. explicit `--model provider/id`
 *   2. session's stored model
 *   3. agent config `model`
 *   4. root config `model`
 *   5. last used model (KV)
 *   6. highest-ranked model on an authenticated provider
 */

import { AuthStore } from "../auth/auth.js"
import type { Config } from "../config/schema.js"
import { Flag } from "../flag.js"
import { Limits } from "../global.js"
import type { Transport } from "../llm/types.js"
import { kv, KvKeys } from "../storage/kv.js"
import { ConfigError, NotFoundError } from "../util/error.js"
import { logger } from "../util/log.js"
import { CATALOG, catalogProvider, SMALL_MODEL_PREFERENCES } from "./catalog.js"
import {
  knownProviderIds,
  loadRemoteCatalog,
  modelsForProvider,
  providerMetadata,
  remoteProvider,
  synthesizeModel,
} from "./models.js"
import { transportFor } from "./transport.js"
import type { ResolvedModel, ResolvedProvider } from "./types.js"
import { parseModelRef } from "./types.js"

const log = logger("provider")

export interface RegistryOptions {
  readonly config: Config
  readonly auth?: AuthStore
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ResolvedProvider>()
  private readonly auth: AuthStore
  private readonly config: Config
  private built = false

  constructor(options: RegistryOptions) {
    this.config = options.config
    this.auth = options.auth ?? new AuthStore()
  }

  /** Loads the remote catalog tier and materialises every provider. */
  async init(): Promise<void> {
    if (this.built) return
    await loadRemoteCatalog().catch(() => undefined)
    this.rebuild()
    this.built = true
  }

  rebuild(): void {
    this.providers.clear()
    for (const providerId of knownProviderIds(this.config)) {
      const provider = this.buildProvider(providerId)
      if (provider) this.providers.set(providerId, provider)
    }
    log.debug("registry built", {
      providers: this.providers.size,
      authenticated: this.authenticated().length,
    })
  }

  private buildProvider(providerId: string): ResolvedProvider | undefined {
    const providerConfig = this.config.provider?.[providerId]
    if (providerConfig?.disable) return undefined

    const builtin = catalogProvider(providerId)
    const remote = remoteProvider(providerId)
    const meta = providerMetadata(providerId, builtin, remote, providerConfig)

    const credential = this.resolveCredential(providerId, meta.apiKeyEnv, providerConfig?.apiKey)
    const models = modelsForProvider(providerId, builtin, remote, providerConfig)

    const baseUrl = normalizeBaseUrl(providerConfig?.baseUrl ?? meta.baseUrl)
    // A provider with no base URL and no way to derive one is unusable.
    const usable = baseUrl !== "" || meta.transport === "bedrock" || meta.transport === "google-vertex"
    if (!usable && !providerConfig) return undefined

    return {
      id: providerId,
      name: meta.name,
      transport: meta.transport,
      baseUrl,
      apiKey: credential.value,
      authSource: credential.source,
      headers: { ...meta.headers, ...(providerConfig?.headers ?? {}) },
      query: providerConfig?.query ?? {},
      timeoutMs: providerConfig?.timeoutMs ?? Flag.providerTimeout() ?? Limits.httpTimeoutMs,
      retries: providerConfig?.retries ?? Flag.providerRetries() ?? Limits.providerRetries,
      options: {
        ...(providerConfig?.options ?? {}),
        ...(providerConfig?.region ? { region: providerConfig.region } : {}),
        ...(providerConfig?.project ? { project: providerConfig.project } : {}),
        ...(providerConfig?.apiVersion ? { apiVersion: providerConfig.apiVersion } : {}),
        ...(providerConfig?.organization ? { organization: providerConfig.organization } : {}),
      },
      defaultTemperature: meta.defaultTemperature,
      toolCallIdStyle: meta.toolCallIdStyle,
      models,
      requestsPerMinute: providerConfig?.requestsPerMinute,
      tokensPerMinute: providerConfig?.tokensPerMinute,
      authenticated: credential.source !== "none" || isLocalProvider(providerId, baseUrl),
    }
  }

  /**
   * Credential lookup order: config (may reference {env:...} already
   * substituted), the auth file, then environment variables. `--api-key-env-only`
   * suppresses the auth file for CI use.
   */
  private resolveCredential(
    providerId: string,
    envNames: readonly string[],
    configured?: string,
  ): { value?: string; source: ResolvedProvider["authSource"] } {
    if (configured && configured !== "") return { value: configured, source: "config" }

    if (!Flag.apiKeyEnvOnly()) {
      const stored = this.auth.get(providerId)
      if (stored) {
        if (stored.type === "api") return { value: stored.key, source: "auth-file" }
        if (stored.type === "oauth") return { value: stored.access, source: "oauth" }
      }
    }

    for (const name of envNames) {
      const value = process.env[name]
      if (value && value !== "") return { value, source: "env" }
    }
    return { source: "none" }
  }

  /* -------------------------------------------------------------- */
  /* Queries                                                         */
  /* -------------------------------------------------------------- */

  all(): ResolvedProvider[] {
    return [...this.providers.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  authenticated(): ResolvedProvider[] {
    return this.all().filter((provider) => provider.authenticated)
  }

  provider(id: string): ResolvedProvider | undefined {
    return this.providers.get(id)
  }

  providerIds(): Set<string> {
    return new Set(this.providers.keys())
  }

  /** Every model on every authenticated provider. */
  models(options: { authenticatedOnly?: boolean } = {}): ResolvedModel[] {
    const providers = options.authenticatedOnly === false ? this.all() : this.authenticated()
    return providers
      .flatMap((provider) => provider.models)
      .sort((a, b) => b.rank - a.rank || a.ref.localeCompare(b.ref))
  }

  model(ref: string): ResolvedModel | undefined {
    const parsed = parseModelRef(ref, this.providerIds())
    if (parsed.providerId) {
      const provider = this.providers.get(parsed.providerId)
      if (!provider) return undefined
      const found = provider.models.find((model) => model.modelId === parsed.modelId)
      if (found) return found
      // Unknown id on a known provider: synthesise so new releases work.
      return synthesizeModel(parsed.providerId, parsed.modelId)
    }
    // Bare model id: search authenticated providers by rank.
    for (const provider of this.authenticated()) {
      const found = provider.models.find((model) => model.modelId === parsed.modelId)
      if (found) return found
    }
    for (const provider of this.all()) {
      const found = provider.models.find((model) => model.modelId === parsed.modelId)
      if (found) return found
    }
    return undefined
  }

  /** Throws a helpful error instead of returning undefined. */
  requireModel(ref: string): ResolvedModel {
    const model = this.model(ref)
    if (model) return model
    const parsed = parseModelRef(ref, this.providerIds())
    if (parsed.providerId && !this.providers.has(parsed.providerId)) {
      throw new ConfigError(
        `Unknown provider "${parsed.providerId}". Run \`praxis models\` to list what is available.`,
        { providerId: parsed.providerId },
      )
    }
    throw new NotFoundError(`Unknown model "${ref}". Run \`praxis models\` to list what is available.`, {
      ref,
    })
  }

  /* -------------------------------------------------------------- */
  /* Selection                                                       */
  /* -------------------------------------------------------------- */

  /**
   * Picks the model to use, honouring the documented priority chain.
   * `explicit` is the CLI flag or an agent-level override.
   */
  select(explicit?: string): ResolvedModel {
    const candidates = [explicit, Flag.model(), this.config.model].filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    for (const candidate of candidates) {
      const model = this.model(candidate)
      if (model) return model
      // An explicit request that cannot be honoured must fail loudly.
      if (candidate === explicit || candidate === Flag.model()) this.requireModel(candidate)
    }

    const remembered = kv().get<string>(KvKeys.lastModel, "")
    if (remembered) {
      const model = this.model(remembered)
      if (model && this.provider(model.providerId)?.authenticated) return model
    }

    const best = this.models({ authenticatedOnly: true })[0]
    if (best) return best

    // Nothing is authenticated. Point the user at `praxis auth login`.
    throw new ConfigError(
      "No authenticated provider found. Run `praxis auth login` or set an API key environment variable.",
      { providers: CATALOG.map((provider) => provider.id) },
    )
  }

  /** Small, cheap model for titles, compaction and other internal work. */
  selectSmall(explicit?: string): ResolvedModel {
    const candidates = [explicit, Flag.smallModel(), this.config.smallModel].filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    for (const candidate of candidates) {
      const model = this.model(candidate)
      if (model) return model
    }
    for (const preference of SMALL_MODEL_PREFERENCES) {
      const model = this.model(preference)
      if (model && this.provider(model.providerId)?.authenticated) return model
    }
    // Fall back to the primary model; a small model is an optimisation.
    return this.select()
  }

  /** Remembers a selection so the next launch reuses it. */
  remember(model: ResolvedModel): void {
    kv().set(KvKeys.lastModel, model.ref)
    const recent = kv().get<string[]>(KvKeys.recentModels, [])
    const next = [model.ref, ...recent.filter((ref) => ref !== model.ref)].slice(0, 12)
    kv().set(KvKeys.recentModels, next)
  }

  recent(): ResolvedModel[] {
    return kv()
      .get<string[]>(KvKeys.recentModels, [])
      .map((ref) => this.model(ref))
      .filter((model): model is ResolvedModel => model !== undefined)
  }

  /** Cycles among a model's declared variants (Ctrl+T in the TUI). */
  nextVariant(current: ResolvedModel): ResolvedModel {
    if (current.variants.length === 0) return current
    const index = current.variants.indexOf(current.modelId)
    const nextId = current.variants[(index + 1) % current.variants.length]
    if (!nextId) return current
    return this.model(`${current.providerId}/${nextId}`) ?? current
  }

  /* -------------------------------------------------------------- */
  /* Transports                                                      */
  /* -------------------------------------------------------------- */

  transport(provider: ResolvedProvider): Transport {
    return transportFor(provider.transport)
  }

  /** Refreshes credentials, e.g. after `auth login` in another process. */
  async refreshAuth(): Promise<void> {
    await this.auth.reload()
    this.rebuild()
  }

  authStore(): AuthStore {
    return this.auth
  }
}

function normalizeBaseUrl(url: string): string {
  if (url === "") return ""
  return url.endsWith("/") ? url.slice(0, -1) : url
}

/** Local inference servers need no credentials. */
function isLocalProvider(providerId: string, baseUrl: string): boolean {
  if (providerId === "ollama" || providerId === "lmstudio" || providerId === "llamacpp") return true
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(baseUrl)
}

/* ------------------------------------------------------------------ */
/* Process-wide instance                                               */
/* ------------------------------------------------------------------ */

let instance: ProviderRegistry | undefined

export async function providerRegistry(config?: Config): Promise<ProviderRegistry> {
  if (instance) return instance
  if (!config) throw new ConfigError("Provider registry accessed before initialisation")
  instance = new ProviderRegistry({ config })
  await instance.init()
  return instance
}

export function setProviderRegistry(registry: ProviderRegistry | undefined): void {
  instance = registry
}
