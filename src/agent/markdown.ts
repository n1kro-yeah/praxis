/**
 * Markdown agent definitions.
 *
 * An agent is a frontmatter block plus a prompt. The frontmatter says which model
 * to use, what tools are permitted, and whether it can be invoked directly or only
 * as a subagent; the body is the system prompt.
 *
 * Files rather than configuration entries because a system prompt is prose, often
 * several hundred words, and prose in JSON is unreadable and unreviewable. A
 * markdown file gets syntax highlighting, a sensible diff, and can be commented on
 * in a pull request.
 *
 * Parsing is deliberately forgiving in one direction and strict in the other:
 * unknown frontmatter keys are preserved (the format will grow), but a key with the
 * wrong *type* is an error, because silently ignoring `tools: "read"` when an array
 * was expected gives an agent with no tools and no explanation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"

import { parseFrontmatter } from "../skill/skill.js"
import { Paths } from "../global.js"
import { logger } from "../util/log.js"
import type { PermissionEffect } from "../permission/types.js"

const log = logger("agent.markdown")

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type AgentMode = "agent" | "subagent" | "all"

export type ReasoningEffort = "low" | "medium" | "high" | "max"

export interface MarkdownAgent {
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly mode: AgentMode
  readonly model?: string
  readonly smallModel?: string
  readonly temperature?: number
  readonly topP?: number
  readonly maxTokens?: number
  readonly reasoningEffort?: ReasoningEffort
  /** Tool availability by id or glob. `true` enables, `false` disables. */
  readonly tools?: Record<string, boolean>
  /** Permission rules, keyed by action then pattern. */
  readonly permission?: Record<string, PermissionEffect | Record<string, PermissionEffect>>
  /** Display colour for the interface. */
  readonly color?: string
  readonly disabled: boolean
  readonly source: "user" | "project" | "builtin" | "plugin" | "config"
  readonly path?: string
  /** Unrecognised frontmatter, kept so a newer file does not lose data. */
  readonly metadata: Record<string, unknown>
}

export interface ParseIssue {
  readonly key: string
  readonly message: string
}

export interface ParseResult {
  readonly agent?: MarkdownAgent
  readonly issues: ParseIssue[]
}

/**
 * Frontmatter keys the parser understands.
 *
 * Anything else lands in `metadata`. Listing them explicitly is what lets the
 * parser warn about a near-miss like `temprature` instead of silently ignoring it,
 * which is the single most common way an agent file does not do what its author
 * intended.
 */
const KNOWN_KEYS = new Set([
  "name",
  "description",
  "mode",
  "model",
  "small_model",
  "smallModel",
  "temperature",
  "top_p",
  "topP",
  "max_tokens",
  "maxTokens",
  "reasoning_effort",
  "reasoningEffort",
  "tools",
  "permission",
  "color",
  "disable",
  "disabled",
  "prompt",
])

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parses an agent definition.
 *
 * Returns issues alongside the agent rather than throwing, because one bad key
 * should not discard an otherwise working definition. The caller decides whether
 * to surface the warnings.
 */
export function parseAgentMarkdown(
  content: string,
  name: string,
  source: MarkdownAgent["source"],
  path?: string,
): ParseResult {
  const issues: ParseIssue[] = []
  const { data, body } = parseFrontmatter(content)

  const stringValue = (key: string, alternate?: string): string | undefined => {
    const value = data[key] ?? (alternate ? data[alternate] : undefined)
    if (value === undefined) return undefined

    if (typeof value !== "string") {
      issues.push({ key, message: `expected a string, got ${typeof value}` })
      return undefined
    }

    return value
  }

  const numberValue = (key: string, alternate?: string): number | undefined => {
    const value = data[key] ?? (alternate ? data[alternate] : undefined)
    if (value === undefined) return undefined

    if (typeof value !== "number") {
      // A quoted number is a common mistake and unambiguous, so it is accepted
      // rather than rejected.
      if (typeof value === "string" && !Number.isNaN(Number(value))) return Number(value)

      issues.push({ key, message: `expected a number, got ${typeof value}` })
      return undefined
    }

    return value
  }

  const mode = parseMode(data["mode"], issues)
  const reasoningEffort = parseReasoningEffort(
    data["reasoning_effort"] ?? data["reasoningEffort"],
    issues,
  )

  const tools = parseTools(data["tools"], issues)
  const permission = parsePermission(data["permission"], issues)

  const temperature = numberValue("temperature")

  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    issues.push({
      key: "temperature",
      message: `${temperature} is outside the usable range of 0 to 2`,
    })
  }

  const topP = numberValue("top_p", "topP")

  if (topP !== undefined && (topP <= 0 || topP > 1)) {
    issues.push({ key: "top_p", message: `${topP} is outside the usable range of 0 to 1` })
  }

  const maxTokens = numberValue("max_tokens", "maxTokens")

  if (maxTokens !== undefined && maxTokens < 1) {
    issues.push({ key: "max_tokens", message: "must be at least 1" })
  }

  // The prompt is the body, but a short one can live in frontmatter.
  const inlinePrompt = stringValue("prompt")
  const prompt = body.trim() !== "" ? body.trim() : (inlinePrompt ?? "")

  if (prompt === "") {
    issues.push({
      key: "prompt",
      message: "the file has no body and no prompt key, so the agent has no instructions",
    })
  }

  for (const key of Object.keys(data)) {
    if (KNOWN_KEYS.has(key)) continue

    const suggestion = suggestKey(key)
    issues.push({
      key,
      message: suggestion
        ? `unrecognised key; did you mean "${suggestion}"?`
        : "unrecognised key, kept but ignored",
    })
  }

  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_KEYS.has(key)) metadata[key] = value
  }

  const agent: MarkdownAgent = {
    name: stringValue("name") ?? name,
    description: stringValue("description") ?? "",
    prompt,
    mode,
    model: stringValue("model"),
    smallModel: stringValue("small_model", "smallModel"),
    temperature,
    topP,
    maxTokens,
    reasoningEffort,
    tools,
    permission,
    color: stringValue("color"),
    disabled: data["disable"] === true || data["disabled"] === true,
    source,
    path,
    metadata,
  }

  return { agent, issues }
}

function parseMode(value: unknown, issues: ParseIssue[]): AgentMode {
  if (value === undefined) return "all"

  if (typeof value !== "string") {
    issues.push({ key: "mode", message: `expected a string, got ${typeof value}` })
    return "all"
  }

  const lowered = value.toLowerCase()

  if (lowered === "agent" || lowered === "primary") return "agent"
  if (lowered === "subagent" || lowered === "sub") return "subagent"
  if (lowered === "all" || lowered === "both") return "all"

  issues.push({
    key: "mode",
    message: `"${value}" is not a mode; expected agent, subagent, or all`,
  })

  return "all"
}

function parseReasoningEffort(value: unknown, issues: ParseIssue[]): ReasoningEffort | undefined {
  if (value === undefined) return undefined

  if (typeof value !== "string") {
    issues.push({ key: "reasoning_effort", message: `expected a string, got ${typeof value}` })
    return undefined
  }

  const lowered = value.toLowerCase()

  if (lowered === "low" || lowered === "medium" || lowered === "high" || lowered === "max") {
    return lowered
  }

  issues.push({
    key: "reasoning_effort",
    message: `"${value}" is not a level; expected low, medium, high, or max`,
  })

  return undefined
}

/**
 * Parses the tools field.
 *
 * Two forms are accepted because both are natural to write: a map of id to
 * boolean, and a plain list meaning "only these". The list form is expanded into
 * a map with an explicit wildcard denial, so downstream code has one shape to
 * handle.
 */
function parseTools(value: unknown, issues: ParseIssue[]): Record<string, boolean> | undefined {
  if (value === undefined) return undefined

  if (Array.isArray(value)) {
    const map: Record<string, boolean> = { "*": false }

    for (const entry of value) {
      if (typeof entry !== "string") {
        issues.push({ key: "tools", message: "list entries must be tool names" })
        continue
      }
      map[entry] = true
    }

    return map
  }

  if (typeof value === "object" && value !== null) {
    const map: Record<string, boolean> = {}

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "boolean") {
        map[key] = entry
        continue
      }

      // `read: allow` reads naturally and is what people write, so it is
      // accepted alongside the boolean form.
      if (entry === "allow" || entry === "true") {
        map[key] = true
        continue
      }

      if (entry === "deny" || entry === "false") {
        map[key] = false
        continue
      }

      issues.push({ key: `tools.${key}`, message: "expected true or false" })
    }

    return map
  }

  issues.push({ key: "tools", message: `expected a list or a map, got ${typeof value}` })

  return undefined
}

/**
 * Parses the permission field.
 *
 * Both the flat form (`bash: ask`) and the nested form (`bash: { "git *": allow,
 * "*": ask }`) are valid, and both appear in real configurations.
 */
function parsePermission(
  value: unknown,
  issues: ParseIssue[],
): Record<string, PermissionEffect | Record<string, PermissionEffect>> | undefined {
  if (value === undefined) return undefined

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push({ key: "permission", message: `expected a map, got ${typeof value}` })
    return undefined
  }

  const result: Record<string, PermissionEffect | Record<string, PermissionEffect>> = {}

  for (const [action, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      const effect = toEffect(entry)

      if (!effect) {
        issues.push({
          key: `permission.${action}`,
          message: `"${entry}" is not an effect; expected allow, ask, or deny`,
        })
        continue
      }

      result[action] = effect
      continue
    }

    if (typeof entry === "object" && entry !== null) {
      const nested: Record<string, PermissionEffect> = {}

      for (const [pattern, nestedValue] of Object.entries(entry as Record<string, unknown>)) {
        const effect = typeof nestedValue === "string" ? toEffect(nestedValue) : undefined

        if (!effect) {
          issues.push({
            key: `permission.${action}.${pattern}`,
            message: "expected allow, ask, or deny",
          })
          continue
        }

        nested[pattern] = effect
      }

      result[action] = nested
      continue
    }

    issues.push({ key: `permission.${action}`, message: "expected a string or a map" })
  }

  return result
}

function toEffect(value: string): PermissionEffect | undefined {
  const lowered = value.toLowerCase()

  if (lowered === "allow" || lowered === "ask" || lowered === "deny") return lowered

  return undefined
}

/**
 * Suggests the intended key for a misspelling.
 *
 * Edit distance of two or less, which catches transpositions and single dropped
 * letters without producing nonsense suggestions for genuinely new keys.
 */
function suggestKey(key: string): string | undefined {
  let best: string | undefined
  let bestDistance = 3

  for (const candidate of KNOWN_KEYS) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase())

    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }

  return best
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i++) {
    const current = [i]

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost)
    }

    previous = current
  }

  return previous[b.length]!
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

/**
 * Directories searched for agent definitions, lowest priority first.
 *
 * Two conventions per level, because both `agents/` and `agent/` get used and
 * neither is worth an error message.
 */
function agentDirectories(cwd: string): Array<{ path: string; source: MarkdownAgent["source"] }> {
  return [
    { path: join(Paths.configDir, "agents"), source: "user" as const },
    { path: join(Paths.configDir, "agent"), source: "user" as const },
    { path: join(cwd, ".praxis", "agents"), source: "project" as const },
    { path: join(cwd, ".praxis", "agent"), source: "project" as const },
    { path: join(cwd, ".agents", "types"), source: "project" as const },
  ]
}

function scanAgentDirectory(
  directory: string,
  source: MarkdownAgent["source"],
): Array<{ agent: MarkdownAgent; issues: ParseIssue[] }> {
  if (!existsSync(directory)) return []

  const found: Array<{ agent: MarkdownAgent; issues: ParseIssue[] }> = []

  let entries: string[]

  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md") && !entry.endsWith(".markdown")) continue

    const path = join(directory, entry)

    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }

    let content: string

    try {
      content = readFileSync(path, "utf8")
    } catch (error) {
      log.warn("could not read agent file", { path, error: String(error) })
      continue
    }

    const name = basename(entry, extname(entry))
    const result = parseAgentMarkdown(content, name, source, path)

    if (result.agent) found.push({ agent: result.agent, issues: result.issues })
  }

  return found
}

export interface DiscoveryResult {
  readonly agents: MarkdownAgent[]
  readonly issues: Array<{ path: string; issues: ParseIssue[] }>
}

/**
 * Discovers every markdown agent.
 *
 * Later directories override earlier ones by name, so a project can replace a
 * user agent. Issues are collected rather than logged so the CLI can present them
 * all at once, which is far more useful than one warning per startup buried in a
 * log file.
 */
export function discoverMarkdownAgents(cwd: string): DiscoveryResult {
  const byName = new Map<string, MarkdownAgent>()
  const issues: Array<{ path: string; issues: ParseIssue[] }> = []

  for (const { path, source } of agentDirectories(cwd)) {
    for (const entry of scanAgentDirectory(path, source)) {
      byName.set(entry.agent.name, entry.agent)

      if (entry.issues.length > 0 && entry.agent.path) {
        issues.push({ path: entry.agent.path, issues: entry.issues })
      }
    }
  }

  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    issues,
  }
}

/**
 * Renders an agent back to markdown.
 *
 * Used by `praxis agent create` and when an agent is edited through the
 * interface. Only non-default fields are written, so a simple agent stays a simple
 * file rather than acquiring twenty lines of explicit defaults.
 */
export function renderAgentMarkdown(agent: MarkdownAgent): string {
  const lines: string[] = ["---"]

  lines.push(`name: ${agent.name}`)

  if (agent.description) lines.push(`description: ${quoteIfNeeded(agent.description)}`)
  if (agent.mode !== "all") lines.push(`mode: ${agent.mode}`)
  if (agent.model) lines.push(`model: ${agent.model}`)
  if (agent.smallModel) lines.push(`small_model: ${agent.smallModel}`)
  if (agent.temperature !== undefined) lines.push(`temperature: ${agent.temperature}`)
  if (agent.topP !== undefined) lines.push(`top_p: ${agent.topP}`)
  if (agent.maxTokens !== undefined) lines.push(`max_tokens: ${agent.maxTokens}`)
  if (agent.reasoningEffort) lines.push(`reasoning_effort: ${agent.reasoningEffort}`)
  if (agent.color) lines.push(`color: ${agent.color}`)
  if (agent.disabled) lines.push("disable: true")

  if (agent.tools && Object.keys(agent.tools).length > 0) {
    lines.push("tools:")
    for (const [key, value] of Object.entries(agent.tools)) {
      lines.push(`  ${key}: ${value}`)
    }
  }

  if (agent.permission && Object.keys(agent.permission).length > 0) {
    lines.push("permission:")

    for (const [action, value] of Object.entries(agent.permission)) {
      if (typeof value === "string") {
        lines.push(`  ${action}: ${value}`)
        continue
      }

      lines.push(`  ${action}:`)
      for (const [pattern, effect] of Object.entries(value)) {
        lines.push(`    ${quoteIfNeeded(pattern)}: ${effect}`)
      }
    }
  }

  for (const [key, value] of Object.entries(agent.metadata)) {
    lines.push(`${key}: ${typeof value === "string" ? quoteIfNeeded(value) : JSON.stringify(value)}`)
  }

  lines.push("---", "", agent.prompt.trim(), "")

  return lines.join("\n")
}

/** Quotes a value when it would otherwise be misparsed. */
function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9 ._/-]+$/.test(value) && !value.includes(": ")) return value

  return `"${value.replace(/"/g, '\\"')}"`
}
