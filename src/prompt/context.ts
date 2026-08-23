/**
 * Context window management.
 *
 * A coding session grows until it no longer fits. Everything here exists to
 * postpone that moment and to make the eventual compaction lossless where it
 * matters.
 *
 * Three mechanisms, applied in this order:
 *
 *  1. **Pruning.** Superseded tool output is replaced with a stub. If the model
 *     read a file four times, only the newest read carries information; the
 *     older ones are pure cost. Same for repeated directory listings, searches
 *     with identical queries, and diffs of files later rewritten.
 *  2. **Truncation.** Individual oversized parts (a 2 MB log, a giant JSON blob)
 *     are cut with an explicit marker so the model knows content is missing
 *     rather than silently reasoning from a fragment.
 *  3. **Compaction.** When neither is enough, the conversation is summarised by
 *     a dedicated agent and replaced by the summary.
 *
 * Pruning is strongly preferred over compaction: it is free, deterministic, and
 * loses nothing that was still true.
 */

import type { Content, LlmMessage } from "../llm/types.js"
import { estimateTokens } from "../util/tokenizer.js"
import { logger } from "../util/log.js"
import { xxhash32 } from "../util/hash.js"

const log = logger("prompt.context")

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

export interface ContextUsage {
  readonly system: number
  readonly tools: number
  readonly messages: number
  readonly total: number
  readonly limit: number
  readonly ratio: number
  readonly reserved: number
  readonly available: number
}

export interface MeasureInput {
  readonly system: readonly string[]
  readonly messages: readonly LlmMessage[]
  readonly toolSchemas?: readonly { name: string; description: string; parameters: unknown }[]
  readonly contextWindow: number
  readonly maxOutputTokens: number
  /** Extra headroom kept free, e.g. for reminders. Defaults to 4k. */
  readonly reserved?: number
}

export function measureContext(input: MeasureInput): ContextUsage {
  const system = input.system.reduce((sum, block) => sum + estimateTokens(block), 0)
  const tools = (input.toolSchemas ?? []).reduce(
    (sum, tool) =>
      sum + estimateTokens(tool.name) + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.parameters)),
    0,
  )
  const messages = input.messages.reduce((sum, message) => sum + messageTokens(message), 0)
  const reserved = (input.reserved ?? 4_000) + input.maxOutputTokens
  const total = system + tools + messages
  const limit = input.contextWindow
  return {
    system,
    tools,
    messages,
    total,
    limit,
    ratio: limit > 0 ? total / Math.max(1, limit - reserved) : 0,
    reserved,
    available: Math.max(0, limit - reserved - total),
  }
}

export function messageTokens(message: LlmMessage): number {
  let total = 4 // role and framing overhead
  for (const item of message.content) total += contentTokens(item)
  return total
}

export function contentTokens(item: Content): number {
  switch (item.type) {
    case "text":
      return estimateTokens(item.text)
    case "reasoning":
      return estimateTokens(item.text) + (item.encrypted ? Math.ceil(item.encrypted.length / 4) : 0)
    case "tool-call":
      return estimateTokens(item.inputText ?? JSON.stringify(item.input)) + estimateTokens(item.toolName) + 8
    case "tool-result":
      return (
        estimateTokens(item.output) +
        (item.attachments?.length ?? 0) * 1_200 +
        8
      )
    case "image":
      return 1_200
    case "file":
      return item.text ? estimateTokens(item.text) : 2_000
    default:
      return 0
  }
}

/* ------------------------------------------------------------------ */
/* Truncation                                                          */
/* ------------------------------------------------------------------ */

export interface TruncateOptions {
  /** Maximum characters kept for a single tool result. */
  readonly maxToolOutput?: number
  /** Keep this fraction from the head; the rest comes from the tail. */
  readonly headRatio?: number
}

/**
 * Truncates a single oversized string, keeping both ends.
 *
 * Keeping the head and the tail is not arbitrary: for command output the head
 * carries the invocation and early errors, and the tail carries the exit status
 * and the summary. The middle of a 50k-line build log is the least useful part.
 */
export function truncateMiddle(text: string, max: number, headRatio = 0.6): string {
  if (text.length <= max) return text
  const headSize = Math.floor(max * headRatio)
  const tailSize = max - headSize
  const head = text.slice(0, headSize)
  const tail = text.slice(text.length - tailSize)
  const omittedLines = text.slice(headSize, text.length - tailSize).split("\n").length
  return `${head}\n\n[… ${omittedLines} lines / ${text.length - max} characters omitted …]\n\n${tail}`
}

/** Truncates by whole lines, which reads better for code and logs. */
export function truncateLines(text: string, maxLines: number, headRatio = 0.7): string {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return text
  const head = Math.floor(maxLines * headRatio)
  const tail = maxLines - head
  return [
    ...lines.slice(0, head),
    ``,
    `[… ${lines.length - maxLines} lines omitted …]`,
    ``,
    ...lines.slice(lines.length - tail),
  ].join("\n")
}

export function truncateContent(content: readonly Content[], options: TruncateOptions = {}): Content[] {
  const max = options.maxToolOutput ?? 60_000
  return content.map((item) => {
    if (item.type !== "tool-result") return item
    if (item.output.length <= max) return item
    return { ...item, output: truncateMiddle(item.output, max, options.headRatio) }
  })
}

/* ------------------------------------------------------------------ */
/* Pruning                                                             */
/* ------------------------------------------------------------------ */

/** Tools whose output is fully superseded by a later identical call. */
const IDEMPOTENT_TOOLS = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "symbols",
  "diagnostics",
  "lsp",
  "git",
  "todoread",
])

interface PruneCandidate {
  messageIndex: number
  contentIndex: number
  key: string
  tokens: number
}

export interface PruneResult {
  readonly messages: LlmMessage[]
  readonly prunedCount: number
  readonly savedTokens: number
}

/**
 * Replaces superseded tool results with a short stub.
 *
 * The stub matters: silently deleting a tool result breaks the call/result
 * pairing that every provider validates, and an empty result makes the model
 * think the tool returned nothing. Saying "superseded by a later call" is both
 * valid and informative.
 *
 * `keepRecent` protects the tail of the conversation, because the most recent
 * reads are exactly the ones the model is still working from.
 */
export function pruneSuperseded(
  messages: readonly LlmMessage[],
  options: { keepRecent?: number; callNames?: Map<string, string> } = {},
): PruneResult {
  const keepRecent = options.keepRecent ?? 6
  const callNames = options.callNames ?? collectCallNames(messages)

  // Walk backwards so the newest occurrence of each key wins.
  const seen = new Set<string>()
  const candidates: PruneCandidate[] = []
  const cutoff = Math.max(0, messages.length - keepRecent)

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]!
    for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex--) {
      const item = message.content[contentIndex]!
      if (item.type !== "tool-result") continue
      const toolName = callNames.get(item.toolCallId)
      if (!toolName || !IDEMPOTENT_TOOLS.has(toolName)) continue
      const key = `${toolName}:${item.callKey ?? xxhash32(item.output).toString(16)}`
      if (!seen.has(key)) {
        seen.add(key)
        continue
      }
      if (messageIndex >= cutoff) continue
      candidates.push({
        messageIndex,
        contentIndex,
        key,
        tokens: contentTokens(item),
      })
    }
  }

  if (candidates.length === 0) {
    return { messages: [...messages], prunedCount: 0, savedTokens: 0 }
  }

  const next = messages.map((message) => ({ ...message, content: [...message.content] }))
  let savedTokens = 0
  for (const candidate of candidates) {
    const message = next[candidate.messageIndex]!
    const item = message.content[candidate.contentIndex]!
    if (item.type !== "tool-result") continue
    savedTokens += candidate.tokens
    message.content[candidate.contentIndex] = {
      ...item,
      output: "[output removed: this call was repeated later in the conversation and the newer result is current]",
      attachments: undefined,
    }
  }

  log.debug("pruned superseded tool output", {
    pruned: candidates.length,
    savedTokens,
  })

  return { messages: next, prunedCount: candidates.length, savedTokens }
}

function collectCallNames(messages: readonly LlmMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    for (const item of message.content) {
      if (item.type === "tool-call") map.set(item.toolCallId, item.toolName)
    }
  }
  return map
}

/**
 * Drops reasoning blocks from older assistant turns.
 *
 * Reasoning is valuable for the turn that produced it and nearly worthless two
 * turns later, but on reasoning models it can be 40% of the transcript. The most
 * recent reasoning is always kept because some providers require it to be
 * present alongside the tool calls it produced.
 */
export function pruneOldReasoning(
  messages: readonly LlmMessage[],
  keepRecent = 2,
): PruneResult {
  const assistantIndices = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "assistant")
    .map(({ index }) => index)
  const protectedIndices = new Set(assistantIndices.slice(-keepRecent))

  let prunedCount = 0
  let savedTokens = 0
  const next = messages.map((message, index) => {
    if (message.role !== "assistant" || protectedIndices.has(index)) return message
    const hasReasoning = message.content.some((item) => item.type === "reasoning")
    if (!hasReasoning) return message
    const content = message.content.filter((item) => {
      if (item.type !== "reasoning") return true
      prunedCount++
      savedTokens += contentTokens(item)
      return false
    })
    // Never leave an assistant message empty; providers reject that.
    if (content.length === 0) return message
    return { ...message, content }
  })

  return { messages: next, prunedCount, savedTokens }
}

/**
 * Drops image attachments from older turns.
 *
 * Images are the most expensive content per unit of lasting value: a screenshot
 * from ten turns ago costs over a thousand tokens on every subsequent request.
 */
export function pruneOldImages(messages: readonly LlmMessage[], keepRecent = 4): PruneResult {
  const cutoff = Math.max(0, messages.length - keepRecent)
  let prunedCount = 0
  let savedTokens = 0

  const next = messages.map((message, index) => {
    if (index >= cutoff) return message
    let changed = false
    const content = message.content.map((item): Content => {
      if (item.type === "image") {
        changed = true
        prunedCount++
        savedTokens += 1_200
        return { type: "text", text: "[image removed to save context]" }
      }
      if (item.type === "tool-result" && item.attachments?.length) {
        changed = true
        prunedCount += item.attachments.length
        savedTokens += item.attachments.length * 1_200
        return { ...item, attachments: undefined }
      }
      return item
    })
    return changed ? { ...message, content } : message
  })

  return { messages: next, prunedCount, savedTokens }
}

/* ------------------------------------------------------------------ */
/* Fitting                                                             */
/* ------------------------------------------------------------------ */

export interface FitOptions {
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly reserved?: number
  readonly system: readonly string[]
  readonly toolSchemas?: readonly { name: string; description: string; parameters: unknown }[]
  readonly maxToolOutput?: number
}

export interface FitResult {
  readonly messages: LlmMessage[]
  readonly usage: ContextUsage
  /** True when pruning was not enough and compaction is required. */
  readonly needsCompaction: boolean
  readonly appliedSteps: string[]
}

/**
 * Applies the pruning ladder until the conversation fits, escalating only as
 * far as necessary. Each step is more destructive than the last, so the order
 * is the whole point.
 */
export function fitContext(messages: readonly LlmMessage[], options: FitOptions): FitResult {
  const appliedSteps: string[] = []
  let current: LlmMessage[] = messages.map((message) => ({
    ...message,
    content: truncateContent(message.content, { maxToolOutput: options.maxToolOutput }),
  }))

  const measure = (): ContextUsage =>
    measureContext({
      system: options.system,
      messages: current,
      toolSchemas: options.toolSchemas,
      contextWindow: options.contextWindow,
      maxOutputTokens: options.maxOutputTokens,
      reserved: options.reserved,
    })

  let usage = measure()
  if (usage.ratio <= 0.9) {
    return { messages: current, usage, needsCompaction: false, appliedSteps }
  }

  const superseded = pruneSuperseded(current)
  if (superseded.prunedCount > 0) {
    current = superseded.messages
    appliedSteps.push(`pruned ${superseded.prunedCount} superseded tool results (~${superseded.savedTokens} tokens)`)
    usage = measure()
    if (usage.ratio <= 0.9) return { messages: current, usage, needsCompaction: false, appliedSteps }
  }

  const images = pruneOldImages(current)
  if (images.prunedCount > 0) {
    current = images.messages
    appliedSteps.push(`dropped ${images.prunedCount} old attachments (~${images.savedTokens} tokens)`)
    usage = measure()
    if (usage.ratio <= 0.9) return { messages: current, usage, needsCompaction: false, appliedSteps }
  }

  const reasoning = pruneOldReasoning(current)
  if (reasoning.prunedCount > 0) {
    current = reasoning.messages
    appliedSteps.push(`dropped ${reasoning.prunedCount} old reasoning blocks (~${reasoning.savedTokens} tokens)`)
    usage = measure()
    if (usage.ratio <= 0.9) return { messages: current, usage, needsCompaction: false, appliedSteps }
  }

  // Last resort before compaction: harder truncation of remaining tool output.
  const aggressive = current.map((message) => ({
    ...message,
    content: truncateContent(message.content, { maxToolOutput: 8_000, headRatio: 0.5 }),
  }))
  current = aggressive
  appliedSteps.push("aggressively truncated remaining tool output")
  usage = measure()

  return { messages: current, usage, needsCompaction: usage.ratio > 0.95, appliedSteps }
}

/* ------------------------------------------------------------------ */
/* Compaction boundary                                                 */
/* ------------------------------------------------------------------ */

/**
 * Chooses where to cut the conversation for compaction.
 *
 * The boundary must not split a tool call from its result, and must not land
 * inside an assistant turn: both produce a transcript the provider rejects.
 * We keep the most recent complete user/assistant exchanges verbatim so the
 * model retains immediate working context alongside the summary.
 */
export function compactionBoundary(
  messages: readonly LlmMessage[],
  keepRecentTokens: number,
): number {
  if (messages.length <= 2) return 0

  let accumulated = 0
  let boundary = messages.length

  for (let index = messages.length - 1; index >= 0; index--) {
    accumulated += messageTokens(messages[index]!)
    if (accumulated >= keepRecentTokens) {
      boundary = index
      break
    }
    boundary = index
  }

  // Advance forward until the cut is safe: the kept portion must not begin with
  // an orphaned tool result, and must begin with a user message.
  const openCalls = new Set<string>()
  for (let index = 0; index < boundary; index++) {
    for (const item of messages[index]!.content) {
      if (item.type === "tool-call") openCalls.add(item.toolCallId)
      if (item.type === "tool-result") openCalls.delete(item.toolCallId)
    }
  }

  let safe = boundary
  while (safe < messages.length) {
    const message = messages[safe]!
    const hasOrphan = message.content.some(
      (item) => item.type === "tool-result" && openCalls.has(item.toolCallId),
    )
    if (!hasOrphan && message.role === "user") break
    for (const item of message.content) {
      if (item.type === "tool-call") openCalls.add(item.toolCallId)
      if (item.type === "tool-result") openCalls.delete(item.toolCallId)
    }
    safe++
  }

  // If advancing consumed everything, keep the last exchange instead of nothing.
  if (safe >= messages.length) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]!.role === "user") return index
    }
    return 0
  }

  return safe
}

/** Renders a transcript for the compaction agent to summarise. */
export function renderForCompaction(messages: readonly LlmMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user"
    for (const item of message.content) {
      switch (item.type) {
        case "text":
          if (item.text.trim() !== "") lines.push(`<${role}>\n${item.text}\n</${role}>`)
          break
        case "tool-call":
          lines.push(
            `<tool-call name="${item.toolName}">\n${truncateMiddle(item.inputText ?? JSON.stringify(item.input), 2_000)}\n</tool-call>`,
          )
          break
        case "tool-result":
          lines.push(
            `<tool-result${item.isError ? ' error="true"' : ""}>\n${truncateMiddle(item.output, 4_000)}\n</tool-result>`,
          )
          break
        case "image":
          lines.push("<attachment kind=\"image\" />")
          break
        case "file":
          lines.push(`<attachment kind="file" name="${item.filename ?? ""}" />`)
          break
        default:
          break
      }
    }
  }
  return lines.join("\n\n")
}
