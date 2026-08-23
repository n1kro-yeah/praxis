/**
 * Token estimation.
 *
 * Exact BPE tokenisation would require shipping vocabulary files for every
 * model family. Instead we implement a calibrated estimator that is accurate to
 * within a few percent for source code and prose — enough to drive compaction
 * decisions, context budgeting and cost projection. Providers return exact
 * counts in their usage payloads, which we then use to correct our estimate
 * for the remainder of the session.
 */

export type TokenizerFamily =
  | "cl100k" // GPT-4 / GPT-3.5
  | "o200k" // GPT-4o / o-series
  | "claude" // Anthropic
  | "gemini" // Google
  | "llama" // Llama / Mistral / Qwen sentencepiece
  | "generic"

/** Average characters per token, measured over mixed code+prose corpora. */
const DENSITY: Record<TokenizerFamily, number> = {
  cl100k: 3.85,
  o200k: 4.05,
  claude: 3.6,
  gemini: 4.1,
  llama: 3.5,
  generic: 3.8,
}

export function familyForModel(modelId: string): TokenizerFamily {
  const id = modelId.toLowerCase()
  if (/gpt-4o|gpt-5|gpt-4\.1|o1|o3|o4|codex/.test(id)) return "o200k"
  if (/gpt-4|gpt-3\.5|davinci|turbo/.test(id)) return "cl100k"
  if (/claude|sonnet|opus|haiku/.test(id)) return "claude"
  if (/gemini|palm|gemma/.test(id)) return "gemini"
  if (/llama|mistral|mixtral|qwen|deepseek|codestral|phi|yi-/.test(id)) return "llama"
  return "generic"
}

/**
 * Segments text the way BPE does: runs of letters, runs of digits, individual
 * punctuation, and whitespace attached to the following word. Counting segments
 * and adjusting for long words gives a far better estimate than `length / 4`.
 */
const SEGMENT_PATTERN =
  /[ \t]*(?:[A-Za-z]+|\d+|[\u0080-\uffff]+|[^\sA-Za-z0-9\u0080-\uffff])|\n|\r|[ \t]+/g

export interface EstimateOptions {
  readonly family?: TokenizerFamily
  /** Correction factor learned from provider-reported usage. */
  readonly calibration?: number
}

export function estimateTokens(text: string, options: EstimateOptions = {}): number {
  if (!text) return 0
  const family = options.family ?? "generic"
  const calibration = options.calibration ?? 1

  let tokens = 0
  SEGMENT_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  let matched = 0

  while ((match = SEGMENT_PATTERN.exec(text)) !== null) {
    const segment = match[0]
    matched += segment.length
    const body = segment.replace(/^[ \t]+/, "")

    if (body === "") {
      // Pure whitespace run: long runs of indentation compress well.
      tokens += Math.max(1, Math.ceil(segment.length / 8))
      continue
    }
    if (body === "\n" || body === "\r") {
      tokens += 1
      continue
    }
    if (/^\d+$/.test(body)) {
      // Digits are split into groups of up to three by most vocabularies.
      tokens += Math.ceil(body.length / 3)
      continue
    }
    if (/^[A-Za-z]+$/.test(body)) {
      // Short words are single tokens; longer words split on subword boundaries.
      if (body.length <= 5) tokens += 1
      else if (body.length <= 10) tokens += 2
      else tokens += Math.ceil(body.length / 4.5)
      // camelCase and snake_case boundaries add extra splits in practice.
      const humps = (body.match(/[a-z][A-Z]/g) ?? []).length
      tokens += Math.floor(humps / 2)
      continue
    }
    if (/^[\u0080-\uffff]+$/.test(body)) {
      // CJK: roughly one token per character; other scripts closer to 1.5 chars.
      const cjk = (body.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length
      tokens += cjk + Math.ceil((body.length - cjk) / 1.5)
      continue
    }
    tokens += 1
  }

  // Anything the regex missed (control characters, lone surrogates).
  if (matched < text.length) tokens += Math.ceil((text.length - matched) / 4)

  // Family-specific density correction relative to the generic baseline.
  const factor = DENSITY.generic / DENSITY[family]
  return Math.max(1, Math.round(tokens * factor * calibration))
}

/** Token count for a JSON payload (tool schemas, tool results). */
export function estimateJsonTokens(value: unknown, options?: EstimateOptions): number {
  try {
    return estimateTokens(JSON.stringify(value) ?? "", options)
  } catch {
    return 0
  }
}

/**
 * Message overhead: providers add role markers, separators and, for tool calls,
 * JSON envelopes. These constants come from published token-counting guidance.
 */
export const MESSAGE_OVERHEAD = 4
export const TOOL_CALL_OVERHEAD = 12
export const TOOL_RESULT_OVERHEAD = 8
export const IMAGE_BASE_TOKENS = 85
export const IMAGE_TILE_TOKENS = 170

/** Approximate token cost of an image at a given resolution. */
export function estimateImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 1_000
  // Scale to fit a 2048x2048 box, then to 768 on the shortest side.
  let w = width
  let h = height
  if (w > 2048 || h > 2048) {
    const scale = 2048 / Math.max(w, h)
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }
  const shortest = Math.min(w, h)
  if (shortest > 768) {
    const scale = 768 / shortest
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512)
  return IMAGE_BASE_TOKENS + tiles * IMAGE_TILE_TOKENS
}

/**
 * Adaptive calibrator. After each provider response we compare the reported
 * input token count against our estimate and nudge the correction factor. The
 * factor is clamped so a single anomalous response cannot skew budgeting.
 */
export class TokenCalibrator {
  private factor = 1
  private samples = 0

  constructor(readonly family: TokenizerFamily) {}

  get calibration(): number {
    return this.factor
  }

  estimate(text: string): number {
    return estimateTokens(text, { family: this.family, calibration: this.factor })
  }

  /** Feeds an authoritative count back in to improve future estimates. */
  observe(estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return
    const ratio = actual / estimated
    if (!Number.isFinite(ratio) || ratio < 0.3 || ratio > 3) return
    this.samples++
    // Exponential moving average with a decaying learning rate.
    const weight = Math.max(0.05, 1 / Math.min(this.samples, 20))
    this.factor = this.factor * (1 - weight) + this.factor * ratio * weight
    this.factor = Math.min(2, Math.max(0.5, this.factor))
  }

  reset(): void {
    this.factor = 1
    this.samples = 0
  }
}

const CALIBRATORS = new Map<TokenizerFamily, TokenCalibrator>()

export function calibratorFor(modelId: string): TokenCalibrator {
  const family = familyForModel(modelId)
  const existing = CALIBRATORS.get(family)
  if (existing) return existing
  const created = new TokenCalibrator(family)
  CALIBRATORS.set(family, created)
  return created
}

/**
 * Truncates text to fit a token budget, cutting on a line boundary so code
 * stays syntactically recognisable.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  options: EstimateOptions = {},
): { text: string; truncated: boolean; tokens: number } {
  const total = estimateTokens(text, options)
  if (total <= maxTokens) return { text, truncated: false, tokens: total }

  const lines = text.split("\n")
  const kept: string[] = []
  let tokens = 0
  for (const line of lines) {
    const lineTokens = estimateTokens(line + "\n", options)
    if (tokens + lineTokens > maxTokens) break
    kept.push(line)
    tokens += lineTokens
  }
  return { text: kept.join("\n"), truncated: true, tokens }
}

/** Splits text into chunks that each fit inside a token budget. */
export function chunkByTokens(
  text: string,
  maxTokens: number,
  options: EstimateOptions = {},
): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let tokens = 0
  for (const line of text.split("\n")) {
    const lineTokens = estimateTokens(line + "\n", options)
    if (tokens + lineTokens > maxTokens && current.length) {
      chunks.push(current.join("\n"))
      current = []
      tokens = 0
    }
    current.push(line)
    tokens += lineTokens
  }
  if (current.length) chunks.push(current.join("\n"))
  return chunks
}
