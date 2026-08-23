/**
 * Custom providers.
 *
 * The built-in catalogue covers the providers most people use, but the long tail
 * is enormous and moves weekly: a company's internal gateway, a LiteLLM proxy, a
 * vLLM box on the LAN, a brand-new API that launched yesterday, a fine-tune
 * served from someone's GPU under a desk. Waiting for a release to support any of
 * those would make the tool useless exactly when it matters.
 *
 * So a provider is data, not code. Anything reachable over an HTTP API that
 * speaks one of the known wire protocols can be declared in config and becomes a
 * first-class provider: it appears in the model picker, participates in cost
 * accounting, honours the same retry policy, and can be set as the default or the
 * small model.
 *
 * Three levels of use, in increasing order of effort:
 *
 *  1. **Point an existing provider somewhere else.** Override `baseURL` on
 *    `anthropic` and every Anthropic model now goes through your proxy, keeping
 *    its catalogue entry, pricing, and quirks.
 *  2. **Declare a new OpenAI-compatible provider.** A base URL, a key, and a list
 *    of model ids. Ninety percent of cases.
 *  3. **Declare a provider with full control.** Pick the transport, set headers
 *    and body fields, describe each model's context window, pricing, and
 *    capabilities.
 *
 * The design principle throughout: a partial declaration must work. If you give
 * only a base URL and a model id, sensible defaults fill in everything else, and
 * anything genuinely unknowable (pricing, exact context window) degrades to
 * "unknown" rather than to a wrong number that quietly corrupts cost reporting.
 */

import { logger } from "../util/log.js"
import { expandTemplate } from "../config/load.js"
import type {
  ModelCapabilities,
  ModelCost,
  ModelFamily,
  ModelLimits,
  ResolvedModel,
  ResolvedProvider,
  TransportKind,
} from "./types.js"

const log = logger("provider.custom")

/* ------------------------------------------------------------------ */
/* Config shape                                                        */
/* ------------------------------------------------------------------ */

/**
 * A provider entry as written in config.
 *
 * Every field is optional. This is a merge patch: applied to a known provider it
 * overrides individual fields; applied to an unknown id it declares a new one.
 * The same shape serving both cases is what makes "just change the base URL" a
 * three-line edit instead of a full re-declaration.
 */
export interface CustomProviderConfig {
  /** Human-readable name for the picker. Defaults to a title-cased id. */
  name?: string

  /**
   * Wire protocol.
   *
   * Usually inferable, so usually omitted. Set it when the URL gives no hint \u2014 a
   * gateway at `https://ai.corp.internal/v1` could be speaking anything.
   */
  transport?: TransportKind

  /**
   * The npm package name, as used by other tools' configs.
   *
   * Not loaded \u2014 transports are built in \u2014 but accepted and mapped to a transport,
   * because configs get copied between tools and silently ignoring a field that
   * clearly states the protocol would be perverse.
   */
  npm?: string

  /** Alias for `npm`, matching the newer config style. */
  package?: string

  /** Transport options: `baseURL`, `apiKey`, `headers`, and protocol extras. */
  options?: Record<string, unknown>

  /** Alias for `options`. */
  settings?: Record<string, unknown>

  /** Extra HTTP headers on every request. */
  headers?: Record<string, string>

  /**
   * Fields merged into every request body.
   *
   * The escape hatch for gateway-specific parameters: routing hints, tenant ids,
   * `safe_mode` flags. Without it, any API with one unusual field is unusable.
   */
  body?: Record<string, unknown>

  /** Environment variables checked, in order, for an API key. */
  env?: string | string[]

  /** Models offered. Keys are the ids sent to the API. */
  models?: Record<string, CustomModelConfig>

  /** Hide from the picker without deleting the entry. */
  disabled?: boolean

  /** Sort order in the picker. Higher floats to the top. */
  priority?: number

  /** Documentation link, shown in `praxis models --verbose`. */
  docs?: string
}

/**
 * A model within a custom provider.
 *
 * All optional. A bare `{}` still produces a working model; the fields only
 * improve display, cost accounting, and context management.
 */
export interface CustomModelConfig {
  name?: string

  /** Context and output limits. */
  limit?: { context?: number; output?: number }

  /** Alias for `limit`. */
  limits?: { context?: number; output?: number }

  /** USD per million tokens. */
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
  }

  /** Capability overrides. Detection is guesswork; this is the override. */
  toolCall?: boolean
  reasoning?: boolean
  attachment?: boolean
  temperature?: boolean
  caching?: boolean

  /** Prompt family, which selects the system prompt. */
  family?: ModelFamily

  /** Per-model transport override, for a provider mixing protocols. */
  transport?: TransportKind
  npm?: string

  /** Per-model options merged over the provider's. */
  options?: Record<string, unknown>

  /** Per-model body fields merged over the provider's. */
  body?: Record<string, unknown>

  /** Release date, used only for sorting. */
  releaseDate?: string

  disabled?: boolean

  /** Default reasoning effort for a reasoning model. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high"

  /** Free-form tags shown in the picker: "fast", "local", "preview". */
  tags?: string[]
}

/* ------------------------------------------------------------------ */
/* Package name to transport                                           */
/* ------------------------------------------------------------------ */

/**
 * Maps npm package names to transports.
 *
 * Configs written for other tools name a package. Since the protocol is what
 * actually matters and the package name identifies it unambiguously, honouring
 * the field costs a lookup table and makes those configs work verbatim.
 */
const PACKAGE_TRANSPORTS: Record<string, TransportKind> = {
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-chat",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "google",
  "@ai-sdk/google-vertex": "google-vertex",
  "@ai-sdk/mistral": "mistral",
  "@ai-sdk/cohere": "cohere",
  "@ai-sdk/amazon-bedrock": "bedrock",
  "@ai-sdk/azure": "azure",
  "@ai-sdk/groq": "openai-chat",
  "@ai-sdk/cerebras": "openai-chat",
  "@ai-sdk/deepseek": "openai-chat",
  "@ai-sdk/xai": "openai-chat",
  "@ai-sdk/togetherai": "openai-chat",
  "@ai-sdk/fireworks": "openai-chat",
  "@ai-sdk/deepinfra": "openai-chat",
  "@ai-sdk/perplexity": "openai-chat",
  "@openrouter/ai-sdk-provider": "openai-chat",
  "ollama-ai-provider": "ollama",
  "ollama-ai-provider-v2": "ollama",
}

/**
 * Guesses the transport when it was not stated.
 *
 * Ordered from strongest to weakest signal. Falls back to OpenAI chat
 * completions, which is right far more often than anything else because it is the
 * de facto standard every gateway implements.
 */
export function inferTransport(options: {
  providerId: string
  npm?: string
  baseURL?: string
}): TransportKind {
  if (options.npm) {
    const mapped = PACKAGE_TRANSPORTS[options.npm]
    if (mapped) return mapped
  }

  const id = options.providerId.toLowerCase()
  if (id.includes("anthropic") || id.includes("claude")) return "anthropic"
  if (id.includes("ollama")) return "ollama"
  if (id.includes("gemini") || id.includes("google")) return "google"
  if (id.includes("mistral")) return "mistral"
  if (id.includes("cohere")) return "cohere"
  if (id.includes("bedrock")) return "bedrock"
  if (id.includes("azure")) return "azure"
  if (id.includes("copilot")) return "copilot"

  const url = (options.baseURL ?? "").toLowerCase()
  if (url.includes("anthropic.com")) return "anthropic"
  if (url.includes("generativelanguage.googleapis")) return "google"
  if (url.includes("api.mistral.ai")) return "mistral"
  if (url.includes("api.cohere")) return "cohere"
  if (url.includes("bedrock") && url.includes("amazonaws")) return "bedrock"
  if (url.includes("openai.azure.com")) return "azure"
  if (url.includes(":11434")) return "ollama"
  if (url.includes("/v1/responses")) return "openai-responses"

  return "openai-chat"
}

/* ------------------------------------------------------------------ */
/* Capability inference                                                */
/* ------------------------------------------------------------------ */

/**
 * Guesses what a model can do from its id.
 *
 * Pure heuristics over naming conventions, and wrong sometimes. It is still worth
 * doing: without it, every custom model would default to "no tool calling" and be
 * unusable for an agent, so the user would have to spell out five booleans for
 * every model. Any wrong guess is one config line away from being corrected.
 */
export function inferCapabilities(modelId: string, transport: TransportKind): ModelCapabilities {
  const id = modelId.toLowerCase()

  // Reasoning models announce themselves fairly reliably in their names.
  const reasoning =
    /(^|[-_/])(o1|o3|o4)([-_]|$)/.test(id) ||
    id.includes("reasoner") ||
    id.includes("thinking") ||
    id.includes("deepseek-r") ||
    id.includes("qwq") ||
    /gpt-5/.test(id) ||
    /magistral/.test(id)

  // Vision is signalled by an explicit marker or by belonging to a family that is
  // multimodal throughout.
  const attachment =
    id.includes("vision") ||
    id.includes("-vl") ||
    id.includes("llava") ||
    id.includes("claude-3") ||
    id.includes("claude-4") ||
    id.includes("claude-sonnet") ||
    id.includes("claude-opus") ||
    id.includes("claude-haiku") ||
    id.includes("gpt-4o") ||
    id.includes("gpt-4.1") ||
    id.includes("gpt-5") ||
    id.includes("gemini") ||
    id.includes("pixtral")

  // Assume tool calling. Every serious model has supported it for years, and the
  // failure mode of assuming yes (a clear API error) is far better than the
  // failure mode of assuming no (silently no agent).
  const toolCall = !isEmbeddingOrCompletionOnly(id)

  // Reasoning models mostly reject a temperature parameter outright.
  const temperature = !reasoning

  // Prompt caching is provider-level, not model-level.
  const caching = transport === "anthropic" || transport === "openai-chat" || transport === "openai-responses"

  return { toolCall, reasoning, attachment, temperature, caching }
}

function isEmbeddingOrCompletionOnly(id: string): boolean {
  return (
    id.includes("embed") ||
    id.includes("rerank") ||
    id.includes("whisper") ||
    id.includes("tts") ||
    id.includes("dall-e") ||
    id.includes("stable-diffusion") ||
    id.endsWith("-base")
  )
}

/**
 * Guesses the prompt family from a model id.
 *
 * Determines which system prompt is used, which matters more than it sounds: the
 * same instructions produce visibly different behaviour across model families,
 * and a Qwen model given the Anthropic prompt is noticeably worse at tool use.
 */
export function inferFamily(modelId: string): ModelFamily {
  const id = modelId.toLowerCase()

  if (id.includes("claude")) return "anthropic"
  if (/(^|[-_/])(o1|o3|o4)([-_]|$)/.test(id) || id.includes("gpt-5")) return "openai-reasoning"
  if (id.includes("gpt") || id.includes("chatgpt")) return "openai"
  if (id.includes("gemini") || id.includes("gemma")) return "gemini"
  if (id.includes("qwen") || id.includes("qwq")) return "qwen"
  if (id.includes("deepseek")) return "deepseek"
  if (id.includes("llama")) return "llama"
  if (id.includes("mistral") || id.includes("mixtral") || id.includes("codestral") || id.includes("magistral")) {
    return "mistral"
  }
  if (id.includes("grok")) return "grok"
  if (id.includes("glm")) return "glm"
  if (id.includes("kimi") || id.includes("moonshot")) return "kimi"

  return "generic"
}

/**
 * Guesses a context window.
 *
 * Only ever a fallback, and deliberately conservative. Guessing too high causes
 * requests that fail after the model has already been paid for; guessing too low
 * causes premature compaction, which is annoying but cheap. So: prefer low.
 */
export function inferContextWindow(modelId: string): number {
  const id = modelId.toLowerCase()

  // An explicit size in the name is the strongest signal available.
  const explicit = id.match(/(\d+)k(?![a-z])/)
  if (explicit) {
    const thousands = Number.parseInt(explicit[1]!, 10)
    if (thousands >= 4 && thousands <= 10_000) return thousands * 1_000
  }

  const million = id.match(/(\d+)m(?![a-z])/)
  if (million) {
    const millions = Number.parseInt(million[1]!, 10)
    if (millions >= 1 && millions <= 10) return millions * 1_000_000
  }

  if (id.includes("claude")) return 200_000
  if (id.includes("gpt-4.1") || id.includes("gpt-5")) return 1_000_000
  if (id.includes("gpt-4o")) return 128_000
  if (id.includes("gemini-1.5-pro") || id.includes("gemini-2")) return 1_000_000
  if (id.includes("deepseek")) return 128_000
  if (id.includes("qwen")) return 128_000
  if (id.includes("llama-3.1") || id.includes("llama-3.2") || id.includes("llama-3.3")) return 128_000
  if (id.includes("mistral-large") || id.includes("codestral")) return 128_000

  // Unknown model: assume the smallest window that is still workable.
  return 32_768
}

/** Guesses a max-output cap. Kept low; being wrong here truncates answers. */
export function inferMaxOutput(modelId: string, contextWindow: number): number {
  const id = modelId.toLowerCase()

  if (id.includes("claude-3-5-sonnet")) return 8_192
  if (id.includes("claude")) return 32_000
  if (id.includes("gpt-5") || /(^|[-_/])(o1|o3|o4)([-_]|$)/.test(id)) return 100_000
  if (id.includes("gpt-4o") || id.includes("gpt-4.1")) return 16_384
  if (id.includes("gemini")) return 65_536

  return Math.min(8_192, Math.floor(contextWindow / 4))
}

/* ------------------------------------------------------------------ */
/* Building a provider                                                 */
/* ------------------------------------------------------------------ */

export interface BuildContext {
  /** Environment for `{env:VAR}` expansion. */
  readonly env: Record<string, string | undefined>
  /** Base directory for `{file:path}` expansion. */
  readonly cwd: string
  /** An existing provider being patched, if any. */
  readonly base?: ResolvedProvider
}

/**
 * Turns a config entry into a usable provider.
 *
 * Merges over `base` when patching a known provider, and synthesises everything
 * from defaults and heuristics when declaring a new one. The merge is per-field
 * rather than wholesale, so overriding one option leaves the rest intact \u2014
 * otherwise "change the base URL" would silently drop the API key.
 */
export function buildProvider(
  id: string,
  config: CustomProviderConfig,
  context: BuildContext,
): ResolvedProvider | undefined {
  if (config.disabled) {
    log.debug("provider disabled by config", { id })
    return undefined
  }

  const rawOptions = { ...(config.settings ?? {}), ...(config.options ?? {}) }
  const options = expandValues(rawOptions, context)

  const baseURL =
    typeof options["baseURL"] === "string"
      ? (options["baseURL"] as string)
      : typeof options["base_url"] === "string"
        ? (options["base_url"] as string)
        : config.base?.baseURL ?? context.base?.baseURL

  const npm = config.npm ?? config.package

  const transport =
    config.transport ?? context.base?.transport ?? inferTransport({ providerId: id, npm, baseURL })

  if (!baseURL && !context.base) {
    log.warn("custom provider has no baseURL and is not a known provider; skipping", { id })
    return undefined
  }

  const apiKey = resolveApiKey(config, options, context)

  const headers = {
    ...(context.base?.headers ?? {}),
    ...expandStringMap((options["headers"] as Record<string, string>) ?? {}, context),
    ...expandStringMap(config.headers ?? {}, context),
  }

  const body = {
    ...(context.base?.body ?? {}),
    ...(config.body ?? {}),
  }

  const models = new Map<string, ResolvedModel>(context.base?.models ?? [])

  for (const [modelId, modelConfig] of Object.entries(config.models ?? {})) {
    if (modelConfig.disabled) {
      models.delete(modelId)
      continue
    }

    const existing = models.get(modelId)
    const built = buildModel({
      providerId: id,
      modelId,
      config: modelConfig,
      providerTransport: transport,
      base: existing,
    })
    models.set(modelId, built)
  }

  return {
    id,
    name: config.name ?? context.base?.name ?? titleCase(id),
    transport,
    baseURL: baseURL ?? context.base!.baseURL,
    apiKey,
    headers,
    body,
    models,
    source: context.base ? "config-override" : "config",
    priority: config.priority ?? context.base?.priority ?? 0,
    docs: config.docs ?? context.base?.docs,
    envKeys: normaliseEnv(config.env) ?? context.base?.envKeys ?? [],
    toolCallIdStyle: context.base?.toolCallIdStyle ?? defaultToolCallIdStyle(transport),
    defaultTemperature: context.base?.defaultTemperature,
  }
}

/**
 * Finds the API key.
 *
 * Ordered by explicitness. Notably, an empty string counts as "set": local
 * servers frequently want an `Authorization` header present but ignore the value,
 * and falling through to the next source would send the wrong key.
 */
function resolveApiKey(
  config: CustomProviderConfig,
  options: Record<string, unknown>,
  context: BuildContext,
): string | undefined {
  const direct = options["apiKey"] ?? options["api_key"]
  if (typeof direct === "string") return direct

  for (const name of normaliseEnv(config.env) ?? []) {
    const value = context.env[name]
    if (value !== undefined) return value
  }

  return context.base?.apiKey
}

function normaliseEnv(env: string | string[] | undefined): string[] | undefined {
  if (env === undefined) return undefined
  return Array.isArray(env) ? env : [env]
}

/**
 * Builds a single model.
 *
 * Every unset field falls back to inference rather than to an error, because the
 * common case is a user pasting three model ids from a gateway's docs and
 * expecting them to work.
 */
function buildModel(input: {
  providerId: string
  modelId: string
  config: CustomModelConfig
  providerTransport: TransportKind
  base?: ResolvedModel
}): ResolvedModel {
  const { providerId, modelId, config, providerTransport, base } = input

  const transport =
    config.transport ??
    (config.npm ? PACKAGE_TRANSPORTS[config.npm] : undefined) ??
    base?.transport ??
    providerTransport

  const inferred = inferCapabilities(modelId, transport)

  const limitSource = config.limit ?? config.limits
  const contextWindow =
    limitSource?.context ?? base?.contextWindow ?? inferContextWindow(modelId)
  const maxOutputTokens =
    limitSource?.output ?? base?.maxOutputTokens ?? inferMaxOutput(modelId, contextWindow)

  const limits: ModelLimits = { context: contextWindow, output: maxOutputTokens }

  // Cost is left undefined rather than zeroed when unknown. A zero would show a
  // confident "$0.00" for a session that actually cost money, which is worse than
  // showing nothing.
  const cost: ModelCost | undefined = config.cost
    ? {
        input: config.cost.input ?? base?.cost?.input ?? 0,
        output: config.cost.output ?? base?.cost?.output ?? 0,
        cacheRead: config.cost.cacheRead ?? base?.cost?.cacheRead,
        cacheWrite: config.cost.cacheWrite ?? base?.cost?.cacheWrite,
        reasoning: config.cost.reasoning ?? base?.cost?.reasoning,
      }
    : base?.cost

  const capabilities: ModelCapabilities = {
    toolCall: config.toolCall ?? base?.capabilities.toolCall ?? inferred.toolCall,
    reasoning: config.reasoning ?? base?.capabilities.reasoning ?? inferred.reasoning,
    attachment: config.attachment ?? base?.capabilities.attachment ?? inferred.attachment,
    temperature: config.temperature ?? base?.capabilities.temperature ?? inferred.temperature,
    caching: config.caching ?? base?.capabilities.caching ?? inferred.caching,
  }

  return {
    id: `${providerId}/${modelId}`,
    providerId,
    modelId,
    name: config.name ?? base?.name ?? modelId,
    transport,
    family: config.family ?? base?.family ?? inferFamily(modelId),
    contextWindow,
    maxOutputTokens,
    limits,
    cost,
    capabilities,
    releaseDate: config.releaseDate ?? base?.releaseDate,
    reasoningEffort: config.reasoningEffort ?? base?.reasoningEffort,
    options: { ...(base?.options ?? {}), ...(config.options ?? {}) },
    body: { ...(base?.body ?? {}), ...(config.body ?? {}) },
    tags: config.tags ?? base?.tags ?? [],
    source: base ? "config-override" : "config",
  }
}

/** Tool-call id conventions differ per protocol and some APIs validate them. */
function defaultToolCallIdStyle(transport: TransportKind): "openai" | "anthropic" | "free" {
  switch (transport) {
    case "anthropic":
      return "anthropic"
    case "openai-chat":
    case "openai-responses":
    case "azure":
    case "copilot":
      return "openai"
    default:
      return "free"
  }
}

/* ------------------------------------------------------------------ */
/* Template expansion                                                  */
/* ------------------------------------------------------------------ */

/**
 * Expands `{env:VAR}` and `{file:path}` throughout a value tree.
 *
 * Recursive because these appear at arbitrary depth \u2014 inside `headers`, inside
 * nested transport options. Keys are never expanded; a header name coming from an
 * environment variable would be bizarre and would make configs unreadable.
 */
function expandValues(value: Record<string, unknown>, context: BuildContext): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(value)) {
    result[key] = expandValue(item, context)
  }

  return result
}

function expandValue(value: unknown, context: BuildContext): unknown {
  if (typeof value === "string") {
    return expandTemplate(value, { env: context.env, cwd: context.cwd })
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandValue(item, context))
  }
  if (value && typeof value === "object") {
    return expandValues(value as Record<string, unknown>, context)
  }
  return value
}

function expandStringMap(
  value: Record<string, string>,
  context: BuildContext,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") continue
    result[key] = expandTemplate(item, { env: context.env, cwd: context.cwd })
  }
  return result
}

function titleCase(id: string): string {
  return id
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

/**
 * Asks an OpenAI-compatible endpoint what it serves.
 *
 * Declaring models by hand is tedious and goes stale; a local server's model list
 * changes every time something is pulled. Most compatible servers implement
 * `GET /models`, so when a provider declares no models we ask.
 *
 * Failure is silent by design. Discovery is a convenience, and a gateway that
 * does not implement the endpoint must not produce a scary error at startup.
 */
export async function discoverModels(options: {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
}): Promise<string[]> {
  const url = joinUrl(options.baseURL, "models")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)

  try {
    const headers: Record<string, string> = { accept: "application/json", ...(options.headers ?? {}) }
    if (options.apiKey) headers["authorization"] = `Bearer ${options.apiKey}`

    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) return []

    const payload = (await response.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> }

    // Two shapes in the wild: OpenAI's `{data: [{id}]}` and Ollama's
    // `{models: [{name}]}`. Accept both.
    const ids: string[] = []

    for (const entry of payload.data ?? []) {
      if (typeof entry.id === "string") ids.push(entry.id)
    }
    for (const entry of payload.models ?? []) {
      const id = entry.id ?? entry.name
      if (typeof id === "string") ids.push(id)
    }

    return [...new Set(ids)].filter((id) => !isEmbeddingOrCompletionOnly(id.toLowerCase())).sort()
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base
  return `${trimmed}/${path}`
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  readonly providerId: string
  readonly severity: "error" | "warning"
  readonly message: string
}

/**
 * Checks a provider declaration and explains what is wrong.
 *
 * Run by `praxis config validate` and at startup for anything malformed. The
 * messages name the fix, not just the problem: a config error the user cannot act
 * on is barely better than silence.
 */
export function validateProvider(id: string, config: CustomProviderConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const options = { ...(config.settings ?? {}), ...(config.options ?? {}) }
  const baseURL = options["baseURL"] ?? options["base_url"]

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    issues.push({
      providerId: id,
      severity: "error",
      message: `Provider id "${id}" is not usable. Ids appear in model references like "${id}/model-name", so they must be alphanumeric with dashes, dots, or underscores.`,
    })
  }

  if (baseURL !== undefined && typeof baseURL !== "string") {
    issues.push({
      providerId: id,
      severity: "error",
      message: "options.baseURL must be a string.",
    })
  }

  if (typeof baseURL === "string") {
    try {
      const parsed = new URL(baseURL)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        issues.push({
          providerId: id,
          severity: "error",
          message: `options.baseURL uses the "${parsed.protocol}" scheme; only http and https work.`,
        })
      }
      // A trailing `/chat/completions` is the single most common mistake: the
      // base URL is the prefix, and the transport appends the path.
      if (parsed.pathname.includes("/chat/completions") || parsed.pathname.includes("/messages")) {
        issues.push({
          providerId: id,
          severity: "warning",
          message: `options.baseURL points at a specific endpoint ("${parsed.pathname}"). It should be the API root, such as "https://host/v1" \u2014 the endpoint path is appended automatically.`,
        })
      }
    } catch {
      issues.push({
        providerId: id,
        severity: "error",
        message: `options.baseURL is not a valid URL: ${String(baseURL)}`,
      })
    }
  }

  if (config.transport && !isKnownTransport(config.transport)) {
    issues.push({
      providerId: id,
      severity: "error",
      message: `Unknown transport "${config.transport}".`,
    })
  }

  if (config.npm && !PACKAGE_TRANSPORTS[config.npm]) {
    issues.push({
      providerId: id,
      severity: "warning",
      message: `Package "${config.npm}" is not recognised, so the protocol was guessed. Set "transport" explicitly if the guess is wrong.`,
    })
  }

  for (const [modelId, model] of Object.entries(config.models ?? {})) {
    const limits = model.limit ?? model.limits
    if (limits?.context !== undefined && limits.context < 1_000) {
      issues.push({
        providerId: id,
        severity: "warning",
        message: `Model "${modelId}" declares a context of ${limits.context} tokens. That is almost certainly meant to be ${limits.context}000.`,
      })
    }
    if (limits?.output !== undefined && limits?.context !== undefined && limits.output > limits.context) {
      issues.push({
        providerId: id,
        severity: "warning",
        message: `Model "${modelId}" has an output limit larger than its context window.`,
      })
    }
  }

  if (Object.keys(config.models ?? {}).length === 0 && !config.disabled) {
    issues.push({
      providerId: id,
      severity: "warning",
      message: `Provider "${id}" declares no models. Model discovery will be attempted at startup; add a "models" map to skip it.`,
    })
  }

  return issues
}

const KNOWN_TRANSPORTS: readonly string[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "google",
  "google-vertex",
  "ollama",
  "mistral",
  "cohere",
  "azure",
  "bedrock",
  "copilot",
  "llamacpp",
  "lmstudio",
  "custom",
]

function isKnownTransport(value: string): boolean {
  return KNOWN_TRANSPORTS.includes(value)
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Ready-made declarations for common setups.
 *
 * Surfaced by `praxis auth login --custom` so the answer to "how do I point this
 * at my vLLM box" is a menu choice rather than a documentation hunt. Each is a
 * complete, working config with the endpoint conventions already right.
 */
export const PROVIDER_TEMPLATES: Record<string, { label: string; hint: string; config: CustomProviderConfig }> = {
  "openai-compatible": {
    label: "OpenAI-compatible endpoint",
    hint: "Any gateway or server implementing /v1/chat/completions",
    config: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://api.example.com/v1", apiKey: "{env:EXAMPLE_API_KEY}" },
      models: {},
    },
  },
  vllm: {
    label: "vLLM server",
    hint: "Self-hosted vLLM, OpenAI-compatible on port 8000",
    config: {
      name: "vLLM",
      transport: "openai-chat",
      options: { baseURL: "http://localhost:8000/v1", apiKey: "EMPTY" },
      models: {},
    },
  },
  lmstudio: {
    label: "LM Studio",
    hint: "Local models served by LM Studio on port 1234",
    config: {
      name: "LM Studio",
      transport: "openai-chat",
      options: { baseURL: "http://localhost:1234/v1", apiKey: "lm-studio" },
      models: {},
    },
  },
  llamacpp: {
    label: "llama.cpp server",
    hint: "llama-server with its OpenAI-compatible endpoint",
    config: {
      name: "llama.cpp",
      transport: "openai-chat",
      options: { baseURL: "http://localhost:8080/v1" },
      models: {},
    },
  },
  litellm: {
    label: "LiteLLM proxy",
    hint: "A LiteLLM gateway fronting several upstream providers",
    config: {
      name: "LiteLLM",
      transport: "openai-chat",
      options: { baseURL: "http://localhost:4000/v1", apiKey: "{env:LITELLM_API_KEY}" },
      models: {},
    },
  },
  "anthropic-proxy": {
    label: "Anthropic through a proxy",
    hint: "Keeps Anthropic pricing and quirks, changes only the host",
    config: {
      options: { baseURL: "https://proxy.example.com/anthropic" },
    },
  },
  "azure-openai": {
    label: "Azure OpenAI",
    hint: "An Azure deployment with its own resource name",
    config: {
      name: "Azure OpenAI",
      transport: "azure",
      options: {
        baseURL: "https://RESOURCE.openai.azure.com",
        apiKey: "{env:AZURE_OPENAI_API_KEY}",
        apiVersion: "2025-04-01-preview",
      },
      models: {},
    },
  },
}

/**
 * Emits a pasteable config snippet for a template.
 *
 * Returns JSONC with comments intact, because the comments are where the
 * per-field guidance lives and a user pasting this into their config keeps them.
 */
export function renderTemplate(key: string, providerId: string): string {
  const template = PROVIDER_TEMPLATES[key]
  if (!template) return ""

  const body = JSON.stringify({ provider: { [providerId]: template.config } }, null, 2)

  return [
    "// " + template.label,
    "// " + template.hint,
    "//",
    "// Add the model ids your endpoint serves under \"models\". Leave the map",
    "// empty to have them discovered from GET /models at startup.",
    body,
  ].join("\n")
}
