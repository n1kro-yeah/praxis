/**
 * Provider-layer types.
 *
 * A "provider" is a configured endpoint (base URL + credentials + transport).
 * A "model" is an addressable model on that provider, described by cost limits
 * and capability flags. Everything downstream addresses models by the string
 * `providerId/modelId`.
 */

import type { ModelCapabilities } from "../llm/types.js"

export type TransportKind =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "anthropic-bedrock"
  | "anthropic-vertex"
  | "google"
  | "google-vertex"
  | "bedrock"
  | "ollama"
  | "mistral"
  | "cohere"
  | "azure-openai"
  | "github-copilot"
  | "generic"

export interface ModelCost {
  /** USD per million input tokens. */
  readonly input: number
  /** USD per million output tokens. */
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly reasoning?: number
}

export interface ModelLimit {
  readonly context: number
  readonly output: number
}

/**
 * A fully resolved model: catalog data merged with remote catalog data and user
 * config overrides. This is what the session engine consumes.
 */
export interface ResolvedModel {
  readonly providerId: string
  readonly modelId: string
  /** `providerId/modelId`. */
  readonly ref: string
  readonly name: string
  readonly cost: ModelCost
  readonly limit: ModelLimit
  readonly capabilities: ModelCapabilities
  readonly knowledgeCutoff?: string
  readonly releaseDate?: string
  readonly rank: number
  readonly variants: readonly string[]
  /** Per-model request body overrides. */
  readonly options: Readonly<Record<string, unknown>>
  readonly headers: Readonly<Record<string, string>>
  /** Where this definition came from, for `praxis models --verbose`. */
  readonly source: "builtin" | "remote" | "config" | "discovered"
}

export interface ResolvedProvider {
  readonly id: string
  readonly name: string
  readonly transport: TransportKind
  readonly baseUrl: string
  readonly apiKey?: string
  /** How the credential was obtained; drives the `auth list` output. */
  readonly authSource: "env" | "auth-file" | "config" | "oauth" | "none"
  readonly headers: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly retries: number
  readonly options: Readonly<Record<string, unknown>>
  readonly defaultTemperature?: number
  readonly toolCallIdStyle: "any" | "mistral" | "alphanumeric"
  readonly models: readonly ResolvedModel[]
  readonly requestsPerMinute?: number
  readonly tokensPerMinute?: number
  /** True when the provider has usable credentials. */
  readonly authenticated: boolean
}

/** Parsed `provider/model` reference. */
export interface ModelRef {
  readonly providerId?: string
  readonly modelId: string
}

/**
 * Parses a model reference.
 *
 * Model ids frequently contain slashes (`anthropic/claude-sonnet-4.5` on
 * OpenRouter, `accounts/fireworks/models/...` on Fireworks), so we split on the
 * first slash only and let the registry decide whether the head is a known
 * provider id.
 */
export function parseModelRef(input: string, knownProviders?: ReadonlySet<string>): ModelRef {
  const trimmed = input.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0) return { modelId: trimmed }
  const head = trimmed.slice(0, slash)
  const tail = trimmed.slice(slash + 1)
  if (tail === "") return { modelId: head }
  if (!knownProviders || knownProviders.has(head)) return { providerId: head, modelId: tail }
  return { modelId: trimmed }
}

export function formatModelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/** Cost of a single request, in USD. */
export function computeCost(
  cost: ModelCost,
  usage: {
    input: number
    output: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
  },
): number {
  const million = 1_000_000
  // Cached reads are billed at the discounted rate and are *not* also billed as
  // regular input, so the caller must pass them separately.
  const inputCost = (usage.input * cost.input) / million
  const outputCost = (usage.output * cost.output) / million
  const reasoningCost = ((usage.reasoning ?? 0) * (cost.reasoning ?? cost.output)) / million
  const cacheReadCost = ((usage.cacheRead ?? 0) * (cost.cacheRead ?? cost.input)) / million
  const cacheWriteCost = ((usage.cacheWrite ?? 0) * (cost.cacheWrite ?? cost.input * 1.25)) / million
  return inputCost + outputCost + reasoningCost + cacheReadCost + cacheWriteCost
}

/** How much of the context window a token count consumes, as a ratio. */
export function contextUsage(model: ResolvedModel, tokens: number): number {
  if (model.limit.context <= 0) return 0
  return tokens / model.limit.context
}

/**
 * Usable input budget: the context window minus the reserved output space and a
 * safety margin. Providers count the reservation against the window, so
 * ignoring it produces hard 400s at the worst possible moment.
 */
export function inputBudget(model: ResolvedModel, reserveTokens = 0): number {
  const reserve = Math.max(reserveTokens, model.limit.output)
  return Math.max(1_000, model.limit.context - reserve - 2_000)
}

export interface ProviderAuthInfo {
  readonly providerId: string
  readonly kind: "api-key" | "oauth" | "none"
  readonly label?: string
  readonly expiresAt?: number
}

/** Model families, used to pick the system prompt and tool set. */
export type ModelFamily =
  | "anthropic"
  | "openai-reasoning"
  | "openai"
  | "gemini"
  | "qwen"
  | "deepseek"
  | "llama"
  | "mistral"
  | "grok"
  | "glm"
  | "kimi"
  | "generic"

/**
 * Classifies a model by id. This drives real behavioural differences:
 * GPT-family models get the `apply_patch` tool instead of `edit`, Anthropic
 * models get the todo-oriented prompt, Gemini needs a different default
 * temperature, and reasoning models must not receive a `temperature` field.
 */
export function modelFamily(providerId: string, modelId: string): ModelFamily {
  const id = modelId.toLowerCase()
  const provider = providerId.toLowerCase()

  if (id.includes("claude") || provider === "anthropic") return "anthropic"
  if (/^(o\d|gpt-5|gpt5)/.test(id) || id.includes("/o1") || id.includes("/o3") || id.includes("/o4"))
    return "openai-reasoning"
  if (id.includes("gpt") || provider === "openai" || provider === "azure") return "openai"
  if (id.includes("gemini") || provider === "google" || provider === "vertex") return "gemini"
  if (id.includes("qwen")) return "qwen"
  if (id.includes("deepseek")) return "deepseek"
  if (id.includes("llama")) return "llama"
  if (id.includes("mistral") || id.includes("codestral") || id.includes("devstral"))
    return "mistral"
  if (id.includes("grok")) return "grok"
  if (id.includes("glm")) return "glm"
  if (id.includes("kimi")) return "kimi"
  return "generic"
}

/** True when the family should receive the V4A `apply_patch` tool. */
export function prefersApplyPatch(family: ModelFamily): boolean {
  return family === "openai" || family === "openai-reasoning"
}

/** True when an explicit temperature must be omitted from the request. */
export function rejectsTemperature(family: ModelFamily, modelId: string): boolean {
  if (family === "openai-reasoning") return true
  return /^o\d/.test(modelId.toLowerCase())
}

/** Provider-preferred default temperature for coding work. */
export function defaultTemperature(family: ModelFamily): number | undefined {
  switch (family) {
    // Anthropic recommends leaving temperature unset for tool use.
    case "anthropic":
      return undefined
    case "openai-reasoning":
      return undefined
    case "gemini":
      return 1
    case "qwen":
      return 0.55
    case "deepseek":
      return 0.3
    default:
      return 0.2
  }
}
