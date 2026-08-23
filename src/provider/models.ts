/**
 * Model catalog resolution.
 *
 * Three tiers, merged lowest to highest priority:
 *   1. the compile-time snapshot in `catalog.ts` (always available, offline)
 *   2. a refreshable remote catalog cached in SQLite (or a local JSON file
 *      pointed at by PRAXIS_MODELS_PATH / --models-path)
 *   3. user config `provider` blocks
 *
 * The remote fetch is opportunistic: it happens at most once an hour, in the
 * background, and a failure is never fatal. A coding agent that cannot start
 * because a metadata endpoint is down is a broken coding agent.
 */

import { readFile } from "node:fs/promises"

import type { Config, ModelConfig, ProviderConfig } from "../config/schema.js"
import { Flag } from "../flag.js"
import { defaultCapabilities, type ModelCapabilities } from "../llm/types.js"
import { database } from "../storage/db.js"
import { kv, KvKeys } from "../storage/kv.js"
import { getJson } from "../util/http.js"
import { logger } from "../util/log.js"
import { CATALOG, type CatalogModel, type CatalogProvider } from "./catalog.js"
import type { ModelCost, ModelLimit, ResolvedModel, TransportKind } from "./types.js"
import { defaultTemperature, formatModelRef, modelFamily, rejectsTemperature } from "./types.js"

const log = logger("models")

const REMOTE_CATALOG_URL = "https://models.dev/api.json"
const REFRESH_INTERVAL_MS = 3_600_000

/* ------------------------------------------------------------------ */
/* Remote catalog shape                                                */
/* ------------------------------------------------------------------ */

interface RemoteModel {
  id?: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  toolCall?: boolean
  temperature?: boolean
  knowledge?: string
  release_date?: string
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
    reasoning?: number
  }
  limit?: { context?: number; output?: number }
  options?: Record<string, unknown>
}

interface RemoteProvider {
  id?: string
  name?: string
  npm?: string
  api?: string
  env?: string[]
  doc?: string
  models?: Record<string, RemoteModel>
}

type RemoteCatalog = Record<string, RemoteProvider>

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

function readCachedCatalog(): RemoteCatalog | undefined {
  try {
    const db = database()
    const rows = db.all<{ provider_id: string; model_id: string; payload: string }>(
      "SELECT provider_id, model_id, payload FROM model_catalog",
    )
    if (rows.length === 0) return undefined
    const out: RemoteCatalog = {}
    for (const row of rows) {
      const provider = (out[row.provider_id] ??= { id: row.provider_id, models: {} })
      provider.models ??= {}
      provider.models[row.model_id] = JSON.parse(row.payload) as RemoteModel
    }
    // Provider-level metadata is stored under the sentinel model id "".
    for (const [providerId, provider] of Object.entries(out)) {
      const meta = provider.models?.[""]
      if (meta) {
        delete provider.models?.[""]
        Object.assign(provider, meta)
        provider.id = providerId
      }
    }
    return out
  } catch (error) {
    log.debug("failed to read cached catalog", { error: String(error) })
    return undefined
  }
}

function writeCachedCatalog(catalog: RemoteCatalog): void {
  try {
    const db = database()
    db.transaction(() => {
      db.run("DELETE FROM model_catalog")
      for (const [providerId, provider] of Object.entries(catalog)) {
        const { models, ...meta } = provider
        db.run(
          "INSERT INTO model_catalog (provider_id, model_id, payload, source, updated_at) VALUES (?, ?, ?, 'remote', ?)",
          providerId,
          "",
          JSON.stringify(meta),
          Date.now(),
        )
        for (const [modelId, model] of Object.entries(models ?? {})) {
          db.run(
            "INSERT INTO model_catalog (provider_id, model_id, payload, source, updated_at) VALUES (?, ?, ?, 'remote', ?)",
            providerId,
            modelId,
            JSON.stringify(model),
            Date.now(),
          )
        }
      }
      db.run(
        "INSERT INTO catalog_meta (key, value, updated_at) VALUES ('fetched_at', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        String(Date.now()),
        Date.now(),
      )
    })
  } catch (error) {
    log.warn("failed to cache catalog", { error: String(error) })
  }
}

async function readLocalCatalogFile(path: string): Promise<RemoteCatalog | undefined> {
  try {
    const text = await readFile(path, "utf8")
    return JSON.parse(text) as RemoteCatalog
  } catch (error) {
    log.warn("failed to read local models file", { path, error: String(error) })
    return undefined
  }
}

async function fetchRemoteCatalog(url: string): Promise<RemoteCatalog | undefined> {
  try {
    const response = await getJson<RemoteCatalog>(url, { timeoutMs: 15_000, retries: 1 })
    if (!response.data || typeof response.data !== "object") return undefined
    return response.data
  } catch (error) {
    log.debug("remote catalog fetch failed", { error: String(error) })
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

let remoteCatalog: RemoteCatalog | undefined
let remoteLoaded = false

/**
 * Loads the remote catalog tier. Never throws; returns undefined when nothing
 * is available, in which case the built-in snapshot is used alone.
 */
export async function loadRemoteCatalog(force = false): Promise<RemoteCatalog | undefined> {
  if (remoteLoaded && !force) return remoteCatalog
  remoteLoaded = true

  const localPath = Flag.modelsPath()
  if (localPath) {
    remoteCatalog = await readLocalCatalogFile(localPath)
    if (remoteCatalog) {
      log.info("loaded model catalog from file", { path: localPath })
      return remoteCatalog
    }
  }

  const cached = readCachedCatalog()
  const fetchedAt = kv().get<number>(KvKeys.catalogFetchedAt, 0)
  const stale = Date.now() - fetchedAt > REFRESH_INTERVAL_MS

  if (cached && !stale && !force) {
    remoteCatalog = cached
    return remoteCatalog
  }

  if (Flag.offline()) {
    remoteCatalog = cached
    return remoteCatalog
  }

  const fetched = await fetchRemoteCatalog(Flag.modelsUrl() ?? REMOTE_CATALOG_URL)
  if (fetched) {
    writeCachedCatalog(fetched)
    kv().set(KvKeys.catalogFetchedAt, Date.now())
    remoteCatalog = fetched
    log.info("refreshed model catalog", { providers: Object.keys(fetched).length })
    return remoteCatalog
  }

  remoteCatalog = cached
  return remoteCatalog
}

/** Synchronous accessor for the already-loaded catalog. */
export function cachedRemoteCatalog(): RemoteCatalog | undefined {
  if (!remoteLoaded) {
    remoteCatalog = readCachedCatalog()
    remoteLoaded = true
  }
  return remoteCatalog
}

export function resetCatalogCache(): void {
  remoteCatalog = undefined
  remoteLoaded = false
}

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

function capabilitiesFrom(
  providerId: string,
  modelId: string,
  builtin: CatalogModel | undefined,
  remote: RemoteModel | undefined,
  override: ModelConfig | undefined,
  limit: ModelLimit,
): ModelCapabilities {
  const base = defaultCapabilities()
  const family = modelFamily(providerId, modelId)

  const toolCall =
    override?.toolCall ??
    builtin?.toolCall ??
    remote?.tool_call ??
    remote?.toolCall ??
    base.toolCall
  const attachment = override?.attachment ?? builtin?.attachment ?? remote?.attachment ?? false
  const reasoning = override?.reasoning ?? builtin?.reasoning ?? remote?.reasoning ?? false
  const temperatureAllowed =
    override?.temperature ??
    builtin?.temperature ??
    remote?.temperature ??
    !rejectsTemperature(family, modelId)

  return {
    toolCall,
    attachment,
    reasoning,
    temperature: temperatureAllowed,
    structuredOutput: override?.structuredOutput ?? builtin?.structuredOutput ?? false,
    promptCache: override?.promptCache ?? builtin?.promptCache ?? false,
    parallelToolCalls: override?.parallelToolCalls ?? builtin?.parallelToolCalls ?? true,
    contextWindow: limit.context,
    maxOutputTokens: limit.output,
  }
}

function costFrom(
  builtin: CatalogModel | undefined,
  remote: RemoteModel | undefined,
  override: ModelConfig | undefined,
): ModelCost {
  return {
    input: override?.cost?.input ?? builtin?.cost.input ?? remote?.cost?.input ?? 0,
    output: override?.cost?.output ?? builtin?.cost.output ?? remote?.cost?.output ?? 0,
    cacheRead:
      override?.cost?.cacheRead ?? builtin?.cost.cacheRead ?? remote?.cost?.cache_read ?? undefined,
    cacheWrite:
      override?.cost?.cacheWrite ??
      builtin?.cost.cacheWrite ??
      remote?.cost?.cache_write ??
      undefined,
    reasoning: override?.cost?.reasoning ?? remote?.cost?.reasoning ?? undefined,
  }
}

function limitFrom(
  builtin: CatalogModel | undefined,
  remote: RemoteModel | undefined,
  override: ModelConfig | undefined,
): ModelLimit {
  return {
    context: override?.limit?.context ?? builtin?.limit.context ?? remote?.limit?.context ?? 128_000,
    output: override?.limit?.output ?? builtin?.limit.output ?? remote?.limit?.output ?? 8_192,
  }
}

function resolveModel(input: {
  providerId: string
  modelId: string
  builtin?: CatalogModel
  remote?: RemoteModel
  override?: ModelConfig
  source: ResolvedModel["source"]
}): ResolvedModel {
  const limit = limitFrom(input.builtin, input.remote, input.override)
  const cost = costFrom(input.builtin, input.remote, input.override)
  const capabilities = capabilitiesFrom(
    input.providerId,
    input.modelId,
    input.builtin,
    input.remote,
    input.override,
    limit,
  )
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    ref: formatModelRef(input.providerId, input.modelId),
    name: input.override?.name ?? input.builtin?.name ?? input.remote?.name ?? input.modelId,
    cost,
    limit,
    capabilities,
    knowledgeCutoff:
      input.override?.knowledgeCutoff ?? input.builtin?.knowledgeCutoff ?? input.remote?.knowledge,
    releaseDate:
      input.override?.releaseDate ?? input.builtin?.releaseDate ?? input.remote?.release_date,
    rank: input.builtin?.rank ?? 0,
    variants: input.builtin?.variants ?? [],
    options: {
      ...(input.remote?.options ?? {}),
      ...(input.override?.options ?? {}),
    },
    headers: input.override?.headers ?? {},
    source: input.source,
  }
}

/**
 * Produces the model list for one provider by unioning the three tiers.
 * A model present only in config is still returned: users routinely point at
 * newly released ids before any catalog knows about them.
 */
export function modelsForProvider(
  providerId: string,
  builtin: CatalogProvider | undefined,
  remote: RemoteProvider | undefined,
  config: ProviderConfig | undefined,
): ResolvedModel[] {
  const ids = new Set<string>()
  const builtinById = new Map<string, CatalogModel>()
  for (const model of builtin?.models ?? []) {
    ids.add(model.id)
    builtinById.set(model.id, model)
  }
  const remoteById = new Map<string, RemoteModel>()
  for (const [id, model] of Object.entries(remote?.models ?? {})) {
    ids.add(id)
    remoteById.set(id, model)
  }
  const overrideById = new Map<string, ModelConfig>()
  for (const [id, model] of Object.entries(config?.models ?? {})) {
    ids.add(id)
    overrideById.set(id, model)
  }

  const out: ResolvedModel[] = []
  for (const id of ids) {
    const override = overrideById.get(id)
    if (override?.disable) continue
    const source: ResolvedModel["source"] = override
      ? "config"
      : remoteById.has(id) && !builtinById.has(id)
        ? "remote"
        : "builtin"
    out.push(
      resolveModel({
        providerId,
        modelId: id,
        builtin: builtinById.get(id),
        remote: remoteById.get(id),
        override,
        source,
      }),
    )
  }
  return out.sort((a, b) => b.rank - a.rank || a.modelId.localeCompare(b.modelId))
}

/**
 * Builds a model definition for an id nobody has heard of, using family
 * heuristics for the capability flags. This keeps `--model foo/bar-9000`
 * working on release day.
 */
export function synthesizeModel(providerId: string, modelId: string): ResolvedModel {
  const family = modelFamily(providerId, modelId)
  const context = family === "gemini" ? 1_048_576 : family === "openai" ? 400_000 : 200_000
  const limit: ModelLimit = { context, output: 32_768 }
  return {
    providerId,
    modelId,
    ref: formatModelRef(providerId, modelId),
    name: modelId,
    cost: { input: 0, output: 0 },
    limit,
    capabilities: {
      toolCall: true,
      attachment: family !== "generic",
      reasoning: family === "openai-reasoning" || family === "anthropic",
      temperature: !rejectsTemperature(family, modelId),
      structuredOutput: false,
      promptCache: family === "anthropic",
      parallelToolCalls: true,
      contextWindow: limit.context,
      maxOutputTokens: limit.output,
    },
    rank: 0,
    variants: [],
    options: {},
    headers: {},
    source: "discovered",
  }
}

/* ------------------------------------------------------------------ */
/* Provider metadata                                                   */
/* ------------------------------------------------------------------ */

export interface ProviderMetadata {
  readonly id: string
  readonly name: string
  readonly transport: TransportKind
  readonly baseUrl: string
  readonly apiKeyEnv: readonly string[]
  readonly oauth: boolean
  readonly defaultTemperature?: number
  readonly headers: Readonly<Record<string, string>>
  readonly toolCallIdStyle: "any" | "mistral" | "alphanumeric"
  readonly docsUrl?: string
}

/**
 * Merges provider metadata across tiers. Config wins; the remote catalog only
 * contributes environment-variable hints and base URLs for providers we do not
 * ship in the snapshot.
 */
export function providerMetadata(
  providerId: string,
  builtin: CatalogProvider | undefined,
  remote: RemoteProvider | undefined,
  config: ProviderConfig | undefined,
): ProviderMetadata {
  const transport: TransportKind =
    (config?.transport as TransportKind | undefined) ?? builtin?.transport ?? "openai-chat"
  const family = modelFamily(providerId, "")
  return {
    id: providerId,
    name: config?.name ?? builtin?.name ?? remote?.name ?? providerId,
    transport,
    baseUrl: config?.baseUrl ?? builtin?.baseUrl ?? remote?.api ?? "",
    apiKeyEnv: config?.apiKeyEnv ?? builtin?.apiKeyEnv ?? remote?.env ?? [],
    oauth: builtin?.oauth ?? false,
    defaultTemperature: builtin?.defaultTemperature ?? defaultTemperature(family),
    headers: { ...(builtin?.headers ?? {}), ...(config?.headers ?? {}) },
    toolCallIdStyle: builtin?.toolCallIdStyle ?? "any",
    docsUrl: builtin?.docsUrl ?? remote?.doc,
  }
}

/** Union of every provider id known from any tier. */
export function knownProviderIds(config: Config | undefined): string[] {
  const ids = new Set<string>()
  for (const provider of CATALOG) ids.add(provider.id)
  for (const id of Object.keys(cachedRemoteCatalog() ?? {})) ids.add(id)
  for (const id of Object.keys(config?.provider ?? {})) ids.add(id)
  return [...ids].sort()
}

/** Looks up a provider in the remote tier. */
export function remoteProvider(providerId: string): RemoteProvider | undefined {
  return cachedRemoteCatalog()?.[providerId]
}
