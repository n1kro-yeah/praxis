/**
 * Built-in provider and model catalog.
 *
 * This is the compile-time snapshot: the CLI is fully usable offline with no
 * network fetch and no config file. `models.ts` layers a refreshable remote
 * catalog and user overrides on top of this.
 *
 * Costs are USD per million tokens. Limits are token counts. Capability flags
 * drive request shaping (which tools to expose, whether to send `temperature`,
 * whether to attach images, whether prompt caching is available).
 */

import type { TransportKind } from "./types.js"

export interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly cost: {
    readonly input: number
    readonly output: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
  }
  readonly limit: { readonly context: number; readonly output: number }
  readonly attachment?: boolean
  readonly reasoning?: boolean
  readonly toolCall?: boolean
  readonly temperature?: boolean
  readonly structuredOutput?: boolean
  readonly promptCache?: boolean
  readonly parallelToolCalls?: boolean
  readonly knowledgeCutoff?: string
  readonly releaseDate?: string
  /** Ranking hint: higher wins when auto-selecting a default model. */
  readonly rank?: number
  /** Sibling ids cycled by the "model variant" keybind. */
  readonly variants?: readonly string[]
}

export interface CatalogProvider {
  readonly id: string
  readonly name: string
  readonly transport: TransportKind
  readonly baseUrl: string
  /** Environment variables checked in order for the API key. */
  readonly apiKeyEnv: readonly string[]
  /** OAuth is available instead of, or in addition to, an API key. */
  readonly oauth?: boolean
  readonly docsUrl?: string
  readonly models: readonly CatalogModel[]
  /** Default temperature when the user has not set one. */
  readonly defaultTemperature?: number
  readonly headers?: Readonly<Record<string, string>>
  /** Tool-call id style required by this provider. */
  readonly toolCallIdStyle?: "any" | "mistral" | "alphanumeric"
}

const ANTHROPIC_MODELS: readonly CatalogModel[] = [
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    limit: { context: 200_000, output: 64_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    promptCache: true,
    structuredOutput: true,
    knowledgeCutoff: "2025-01",
    rank: 100,
    variants: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  },
  {
    id: "claude-opus-4-1",
    name: "Claude Opus 4.1",
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    limit: { context: 200_000, output: 32_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    promptCache: true,
    structuredOutput: true,
    rank: 95,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    limit: { context: 200_000, output: 64_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    promptCache: true,
    rank: 70,
  },
  {
    id: "claude-3-7-sonnet-latest",
    name: "Claude 3.7 Sonnet",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    limit: { context: 200_000, output: 64_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    promptCache: true,
    rank: 80,
  },
  {
    id: "claude-3-5-haiku-latest",
    name: "Claude 3.5 Haiku",
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    limit: { context: 200_000, output: 8_192 },
    attachment: true,
    toolCall: true,
    promptCache: true,
    rank: 50,
  },
]

const OPENAI_MODELS: readonly CatalogModel[] = [
  {
    id: "gpt-5",
    name: "GPT-5",
    cost: { input: 1.25, output: 10, cacheRead: 0.125 },
    limit: { context: 400_000, output: 128_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    // Reasoning models reject an explicit temperature.
    temperature: false,
    structuredOutput: true,
    promptCache: true,
    rank: 99,
    variants: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    cost: { input: 0.25, output: 2, cacheRead: 0.025 },
    limit: { context: 400_000, output: 128_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    temperature: false,
    structuredOutput: true,
    promptCache: true,
    rank: 75,
  },
  {
    id: "gpt-5-nano",
    name: "GPT-5 nano",
    cost: { input: 0.05, output: 0.4, cacheRead: 0.005 },
    limit: { context: 400_000, output: 128_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    temperature: false,
    structuredOutput: true,
    promptCache: true,
    rank: 45,
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    cost: { input: 2, output: 8, cacheRead: 0.5 },
    limit: { context: 1_047_576, output: 32_768 },
    attachment: true,
    toolCall: true,
    structuredOutput: true,
    promptCache: true,
    rank: 85,
  },
  {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 mini",
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1 },
    limit: { context: 1_047_576, output: 32_768 },
    attachment: true,
    toolCall: true,
    structuredOutput: true,
    promptCache: true,
    rank: 60,
  },
  {
    id: "o4-mini",
    name: "o4-mini",
    cost: { input: 1.1, output: 4.4, cacheRead: 0.275 },
    limit: { context: 200_000, output: 100_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    temperature: false,
    structuredOutput: true,
    rank: 72,
  },
  {
    id: "o3",
    name: "o3",
    cost: { input: 2, output: 8, cacheRead: 0.5 },
    limit: { context: 200_000, output: 100_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    temperature: false,
    structuredOutput: true,
    rank: 88,
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    cost: { input: 2.5, output: 10, cacheRead: 1.25 },
    limit: { context: 128_000, output: 16_384 },
    attachment: true,
    toolCall: true,
    structuredOutput: true,
    rank: 65,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075 },
    limit: { context: 128_000, output: 16_384 },
    attachment: true,
    toolCall: true,
    structuredOutput: true,
    rank: 40,
  },
]

const GOOGLE_MODELS: readonly CatalogModel[] = [
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    cost: { input: 1.25, output: 10, cacheRead: 0.31 },
    limit: { context: 1_048_576, output: 65_536 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    promptCache: true,
    rank: 92,
    variants: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    cost: { input: 0.3, output: 2.5, cacheRead: 0.075 },
    limit: { context: 1_048_576, output: 65_536 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    promptCache: true,
    rank: 74,
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    cost: { input: 0.1, output: 0.4 },
    limit: { context: 1_048_576, output: 65_536 },
    attachment: true,
    toolCall: true,
    rank: 42,
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    cost: { input: 0.1, output: 0.4 },
    limit: { context: 1_048_576, output: 8_192 },
    attachment: true,
    toolCall: true,
    rank: 48,
  },
]

const DEEPSEEK_MODELS: readonly CatalogModel[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek V3",
    cost: { input: 0.27, output: 1.1, cacheRead: 0.07 },
    limit: { context: 128_000, output: 8_192 },
    toolCall: true,
    promptCache: true,
    rank: 68,
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek R1",
    cost: { input: 0.55, output: 2.19, cacheRead: 0.14 },
    limit: { context: 128_000, output: 65_536 },
    reasoning: true,
    toolCall: true,
    promptCache: true,
    rank: 78,
  },
]

const XAI_MODELS: readonly CatalogModel[] = [
  {
    id: "grok-4",
    name: "Grok 4",
    cost: { input: 3, output: 15, cacheRead: 0.75 },
    limit: { context: 256_000, output: 64_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    rank: 86,
  },
  {
    id: "grok-3",
    name: "Grok 3",
    cost: { input: 3, output: 15 },
    limit: { context: 131_072, output: 16_384 },
    toolCall: true,
    rank: 66,
  },
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast",
    cost: { input: 0.2, output: 1.5, cacheRead: 0.02 },
    limit: { context: 256_000, output: 32_768 },
    toolCall: true,
    promptCache: true,
    rank: 71,
  },
]

const MISTRAL_MODELS: readonly CatalogModel[] = [
  {
    id: "mistral-large-latest",
    name: "Mistral Large",
    cost: { input: 2, output: 6 },
    limit: { context: 131_072, output: 32_768 },
    toolCall: true,
    structuredOutput: true,
    rank: 64,
  },
  {
    id: "mistral-medium-latest",
    name: "Mistral Medium",
    cost: { input: 0.4, output: 2 },
    limit: { context: 131_072, output: 32_768 },
    toolCall: true,
    rank: 52,
  },
  {
    id: "codestral-latest",
    name: "Codestral",
    cost: { input: 0.3, output: 0.9 },
    limit: { context: 262_144, output: 32_768 },
    toolCall: true,
    rank: 56,
  },
  {
    id: "devstral-medium-latest",
    name: "Devstral Medium",
    cost: { input: 0.4, output: 2 },
    limit: { context: 131_072, output: 32_768 },
    toolCall: true,
    rank: 58,
  },
]

const GROQ_MODELS: readonly CatalogModel[] = [
  {
    id: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B",
    cost: { input: 0.59, output: 0.79 },
    limit: { context: 131_072, output: 32_768 },
    toolCall: true,
    rank: 54,
  },
  {
    id: "moonshotai/kimi-k2-instruct",
    name: "Kimi K2",
    cost: { input: 1, output: 3 },
    limit: { context: 131_072, output: 16_384 },
    toolCall: true,
    rank: 62,
  },
  {
    id: "qwen/qwen3-32b",
    name: "Qwen3 32B",
    cost: { input: 0.29, output: 0.59 },
    limit: { context: 131_072, output: 40_960 },
    toolCall: true,
    rank: 46,
  },
]

const OPENROUTER_MODELS: readonly CatalogModel[] = [
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (OpenRouter)",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    limit: { context: 200_000, output: 64_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    promptCache: true,
    rank: 90,
  },
  {
    id: "openai/gpt-5",
    name: "GPT-5 (OpenRouter)",
    cost: { input: 1.25, output: 10 },
    limit: { context: 400_000, output: 128_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    temperature: false,
    rank: 89,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro (OpenRouter)",
    cost: { input: 1.25, output: 10 },
    limit: { context: 1_048_576, output: 65_536 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    rank: 87,
  },
  {
    id: "qwen/qwen3-coder",
    name: "Qwen3 Coder",
    cost: { input: 0.3, output: 1.2 },
    limit: { context: 262_144, output: 32_768 },
    toolCall: true,
    rank: 63,
  },
  {
    id: "z-ai/glm-4.6",
    name: "GLM 4.6",
    cost: { input: 0.4, output: 1.75 },
    limit: { context: 200_000, output: 32_768 },
    toolCall: true,
    rank: 61,
  },
]

const COPILOT_MODELS: readonly CatalogModel[] = [
  {
    id: "gpt-5",
    name: "GPT-5 (Copilot)",
    cost: { input: 0, output: 0 },
    limit: { context: 264_000, output: 64_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    temperature: false,
    rank: 82,
  },
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (Copilot)",
    cost: { input: 0, output: 0 },
    limit: { context: 200_000, output: 64_000 },
    attachment: true,
    reasoning: true,
    toolCall: true,
    rank: 84,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro (Copilot)",
    cost: { input: 0, output: 0 },
    limit: { context: 1_000_000, output: 64_000 },
    attachment: true,
    toolCall: true,
    rank: 79,
  },
]

const OLLAMA_MODELS: readonly CatalogModel[] = [
  {
    id: "qwen3-coder:30b",
    name: "Qwen3 Coder 30B (local)",
    cost: { input: 0, output: 0 },
    limit: { context: 262_144, output: 32_768 },
    toolCall: true,
    rank: 35,
  },
  {
    id: "llama3.3:70b",
    name: "Llama 3.3 70B (local)",
    cost: { input: 0, output: 0 },
    limit: { context: 131_072, output: 8_192 },
    toolCall: true,
    rank: 30,
  },
  {
    id: "devstral:24b",
    name: "Devstral 24B (local)",
    cost: { input: 0, output: 0 },
    limit: { context: 131_072, output: 16_384 },
    toolCall: true,
    rank: 32,
  },
]

/**
 * The provider registry. Providers reachable with an OpenAI-compatible API use
 * the `openai-chat` transport with a different base URL, which is why the list
 * is long but the transport count is small.
 */
export const CATALOG: readonly CatalogProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    transport: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    oauth: true,
    docsUrl: "https://docs.anthropic.com",
    models: ANTHROPIC_MODELS,
  },
  {
    id: "openai",
    name: "OpenAI",
    transport: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    docsUrl: "https://platform.openai.com/docs",
    models: OPENAI_MODELS,
  },
  {
    id: "google",
    name: "Google Gemini",
    transport: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    // Gemini's own default is 1.0; anything lower makes it terse and literal.
    defaultTemperature: 1,
    models: GOOGLE_MODELS,
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    transport: "github-copilot",
    baseUrl: "https://api.githubcopilot.com",
    apiKeyEnv: ["GITHUB_COPILOT_TOKEN"],
    oauth: true,
    docsUrl: "https://docs.github.com/copilot",
    models: COPILOT_MODELS,
    headers: {
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.99.0",
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    transport: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    docsUrl: "https://openrouter.ai/docs",
    models: OPENROUTER_MODELS,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    transport: "openai-chat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    models: DEEPSEEK_MODELS,
  },
  {
    id: "xai",
    name: "xAI",
    transport: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: ["XAI_API_KEY", "GROK_API_KEY"],
    models: XAI_MODELS,
  },
  {
    id: "mistral",
    name: "Mistral",
    transport: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: ["MISTRAL_API_KEY"],
    models: MISTRAL_MODELS,
    // Mistral validates tool-call ids as exactly nine alphanumeric characters.
    toolCallIdStyle: "mistral",
  },
  {
    id: "groq",
    name: "Groq",
    transport: "openai-chat",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    models: GROQ_MODELS,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    transport: "openai-chat",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: ["CEREBRAS_API_KEY"],
    models: [
      {
        id: "qwen-3-coder-480b",
        name: "Qwen3 Coder 480B",
        cost: { input: 2, output: 2 },
        limit: { context: 131_072, output: 32_768 },
        toolCall: true,
        rank: 67,
      },
      {
        id: "llama-3.3-70b",
        name: "Llama 3.3 70B",
        cost: { input: 0.85, output: 1.2 },
        limit: { context: 65_536, output: 8_192 },
        toolCall: true,
        rank: 44,
      },
    ],
  },
  {
    id: "together",
    name: "Together AI",
    transport: "openai-chat",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: ["TOGETHER_API_KEY"],
    models: [
      {
        id: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        name: "Qwen3 Coder 480B",
        cost: { input: 2, output: 2 },
        limit: { context: 262_144, output: 32_768 },
        toolCall: true,
        rank: 59,
      },
      {
        id: "deepseek-ai/DeepSeek-V3",
        name: "DeepSeek V3",
        cost: { input: 1.25, output: 1.25 },
        limit: { context: 131_072, output: 8_192 },
        toolCall: true,
        rank: 51,
      },
    ],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    transport: "openai-chat",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: ["FIREWORKS_API_KEY"],
    models: [
      {
        id: "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
        name: "Qwen3 Coder 480B",
        cost: { input: 0.45, output: 1.8 },
        limit: { context: 262_144, output: 32_768 },
        toolCall: true,
        rank: 57,
      },
    ],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    transport: "openai-chat",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnv: ["DEEPINFRA_API_KEY"],
    models: [
      {
        id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        name: "Qwen3 Coder 480B",
        cost: { input: 0.4, output: 1.6 },
        limit: { context: 262_144, output: 32_768 },
        toolCall: true,
        rank: 55,
      },
    ],
  },
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    transport: "bedrock",
    baseUrl: "",
    apiKeyEnv: ["AWS_BEARER_TOKEN_BEDROCK"],
    models: [
      {
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        name: "Claude Sonnet 4.5 (Bedrock)",
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        limit: { context: 200_000, output: 64_000 },
        attachment: true,
        reasoning: true,
        toolCall: true,
        promptCache: true,
        rank: 83,
      },
      {
        id: "anthropic.claude-3-5-haiku-20241022-v1:0",
        name: "Claude 3.5 Haiku (Bedrock)",
        cost: { input: 0.8, output: 4 },
        limit: { context: 200_000, output: 8_192 },
        attachment: true,
        toolCall: true,
        rank: 43,
      },
    ],
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    transport: "azure-openai",
    baseUrl: "",
    apiKeyEnv: ["AZURE_OPENAI_API_KEY", "AZURE_API_KEY"],
    models: OPENAI_MODELS.map((model) => ({ ...model, rank: (model.rank ?? 0) - 10 })),
  },
  {
    id: "ollama",
    name: "Ollama",
    transport: "ollama",
    baseUrl: "http://localhost:11434",
    apiKeyEnv: [],
    models: OLLAMA_MODELS,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    transport: "openai-chat",
    baseUrl: "http://localhost:1234/v1",
    apiKeyEnv: [],
    models: [
      {
        id: "local-model",
        name: "Local model",
        cost: { input: 0, output: 0 },
        limit: { context: 32_768, output: 8_192 },
        toolCall: true,
        rank: 20,
      },
    ],
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    transport: "openai-chat",
    baseUrl: "http://localhost:8080/v1",
    apiKeyEnv: [],
    models: [
      {
        id: "default",
        name: "llama.cpp model",
        cost: { input: 0, output: 0 },
        limit: { context: 32_768, output: 4_096 },
        toolCall: true,
        rank: 18,
      },
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    transport: "cohere",
    baseUrl: "https://api.cohere.com/v2",
    apiKeyEnv: ["COHERE_API_KEY", "CO_API_KEY"],
    models: [
      {
        id: "command-a-03-2025",
        name: "Command A",
        cost: { input: 2.5, output: 10 },
        limit: { context: 256_000, output: 8_192 },
        toolCall: true,
        rank: 49,
      },
    ],
  },
  {
    id: "vertex",
    name: "Google Vertex AI",
    transport: "google-vertex",
    baseUrl: "",
    apiKeyEnv: ["GOOGLE_VERTEX_API_KEY"],
    models: GOOGLE_MODELS.map((model) => ({ ...model, rank: (model.rank ?? 0) - 8 })),
  },
  {
    id: "zhipuai",
    name: "Z.ai",
    transport: "openai-chat",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: ["ZHIPUAI_API_KEY", "ZAI_API_KEY"],
    models: [
      {
        id: "glm-4.6",
        name: "GLM 4.6",
        cost: { input: 0.6, output: 2.2 },
        limit: { context: 200_000, output: 32_768 },
        toolCall: true,
        rank: 60,
      },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot AI",
    transport: "openai-chat",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    models: [
      {
        id: "kimi-k2-0905-preview",
        name: "Kimi K2",
        cost: { input: 0.6, output: 2.5, cacheRead: 0.15 },
        limit: { context: 262_144, output: 32_768 },
        toolCall: true,
        promptCache: true,
        rank: 69,
      },
    ],
  },
  {
    id: "alibaba",
    name: "Alibaba Qwen",
    transport: "openai-chat",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY"],
    // Qwen degenerates into repetition at the OpenAI default of 1.0.
    defaultTemperature: 0.55,
    models: [
      {
        id: "qwen3-coder-plus",
        name: "Qwen3 Coder Plus",
        cost: { input: 1, output: 5 },
        limit: { context: 1_000_000, output: 65_536 },
        toolCall: true,
        rank: 73,
      },
      {
        id: "qwen3-max",
        name: "Qwen3 Max",
        cost: { input: 1.2, output: 6 },
        limit: { context: 262_144, output: 32_768 },
        toolCall: true,
        rank: 66,
      },
    ],
  },
  {
    id: "venice",
    name: "Venice AI",
    transport: "openai-chat",
    baseUrl: "https://api.venice.ai/api/v1",
    apiKeyEnv: ["VENICE_API_KEY"],
    models: [
      {
        id: "qwen3-235b",
        name: "Qwen3 235B",
        cost: { input: 0.7, output: 2.8 },
        limit: { context: 131_072, output: 16_384 },
        toolCall: true,
        rank: 41,
      },
    ],
  },
  {
    id: "nebius",
    name: "Nebius AI Studio",
    transport: "openai-chat",
    baseUrl: "https://api.studio.nebius.ai/v1",
    apiKeyEnv: ["NEBIUS_API_KEY"],
    models: [
      {
        id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        name: "Qwen3 Coder 480B",
        cost: { input: 0.4, output: 1.8 },
        limit: { context: 262_144, output: 32_768 },
        toolCall: true,
        rank: 47,
      },
    ],
  },
  {
    id: "hyperbolic",
    name: "Hyperbolic",
    transport: "openai-chat",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    apiKeyEnv: ["HYPERBOLIC_API_KEY"],
    models: [
      {
        id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        name: "Qwen3 Coder 480B",
        cost: { input: 2, output: 2 },
        limit: { context: 131_072, output: 16_384 },
        toolCall: true,
        rank: 39,
      },
    ],
  },
  {
    id: "opencompatible",
    name: "OpenAI-compatible",
    transport: "openai-chat",
    baseUrl: "",
    apiKeyEnv: ["OPENAI_COMPATIBLE_API_KEY", "CUSTOM_API_KEY"],
    models: [
      {
        id: "default",
        name: "Custom model",
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 8_192 },
        toolCall: true,
        rank: 10,
      },
    ],
  },
]

/** Index for O(1) lookup. */
export const CATALOG_BY_ID: ReadonlyMap<string, CatalogProvider> = new Map(
  CATALOG.map((provider) => [provider.id, provider]),
)

export function catalogProvider(id: string): CatalogProvider | undefined {
  return CATALOG_BY_ID.get(id)
}

export function catalogModel(providerId: string, modelId: string): CatalogModel | undefined {
  return catalogProvider(providerId)?.models.find((model) => model.id === modelId)
}

/**
 * Default model ordering when the user has not chosen one. We prefer models
 * whose provider is actually authenticated; the caller filters first and then
 * takes the highest rank.
 */
export function rankedModels(): Array<{ providerId: string; model: CatalogModel }> {
  const out: Array<{ providerId: string; model: CatalogModel }> = []
  for (const provider of CATALOG) {
    for (const model of provider.models) out.push({ providerId: provider.id, model })
  }
  return out.sort((a, b) => (b.model.rank ?? 0) - (a.model.rank ?? 0))
}

/** Providers that can authenticate purely from the current environment. */
export function providersFromEnvironment(): string[] {
  const out: string[] = []
  for (const provider of CATALOG) {
    if (provider.apiKeyEnv.some((name) => (process.env[name] ?? "") !== "")) out.push(provider.id)
  }
  return out
}

/** A small, cheap model suitable for titles and compaction. */
export const SMALL_MODEL_PREFERENCES: readonly string[] = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-3-5-haiku-latest",
  "openai/gpt-5-nano",
  "openai/gpt-4.1-mini",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-flash",
  "groq/llama-3.3-70b-versatile",
  "mistral/mistral-medium-latest",
  "deepseek/deepseek-chat",
]
