/**
 * Agent resolution.
 *
 * Agents come from four places: seven built-ins, markdown files in the user and
 * project directories, entries in the configuration file, and plugins. This module
 * merges them into one list and resolves a name to a fully-specified agent.
 *
 * The merge rules are the ones that surprise people, so they are stated plainly:
 *
 *  - **Precedence ascends**: built-in, then user files, then configuration, then
 *    project files, then plugins. Something closer to the project wins.
 *  - **Override is per field, not per agent.** Redefining `build` to change its
 *    model should not silently discard its permission rules. Anything the override
 *    does not mention is inherited.
 *  - **Tool and permission maps merge, they do not replace.** `tools: { web: false
 *    }` on top of the built-in `build` disables the web tool and leaves the rest
 *    alone; replacing the map would leave the agent with one entry and no others.
 *  - **A subagent cannot spawn subagents.** Enforced here rather than left to the
 *    prompt, because unbounded recursion in an agent that costs money per step is
 *    not a failure mode worth trusting instructions to prevent.
 */

import {
  BUILTIN_AGENTS,
  type Agent,
  type AgentPermissionRules,
  type AgentToolRules,
} from "./agent.js"
import { discoverMarkdownAgents, type MarkdownAgent, type ParseIssue } from "./markdown.js"
import { pluginAgents } from "../plugin/loader.js"
import { logger } from "../util/log.js"
import { closest } from "../util/fuzzy.js"
import type { PermissionEffect } from "../permission/types.js"

const log = logger("agent.loader")

/* ------------------------------------------------------------------ */
/* Config shape                                                        */
/* ------------------------------------------------------------------ */

/**
 * An agent defined in the configuration file.
 *
 * The same fields as the markdown frontmatter, since having two schemas for one
 * concept guarantees they drift.
 */
export interface ConfigAgent {
  description?: string
  prompt?: string
  mode?: "agent" | "subagent" | "all"
  model?: string
  smallModel?: string
  temperature?: number
  topP?: number
  maxTokens?: number
  reasoningEffort?: "low" | "medium" | "high" | "max"
  tools?: Record<string, boolean>
  permission?: Record<string, PermissionEffect | Record<string, PermissionEffect>>
  color?: string
  disable?: boolean
}

export interface LoadAgentsInput {
  readonly cwd: string
  readonly config?: Record<string, ConfigAgent>
  /** Suppresses discovery, for tests and for `--no-agents`. */
  readonly builtinOnly?: boolean
}

export interface LoadAgentsResult {
  readonly agents: Agent[]
  readonly issues: Array<{ path: string; issues: ParseIssue[] }>
}

/* ------------------------------------------------------------------ */
/* Conversion                                                          */
/* ------------------------------------------------------------------ */

/**
 * Converts a markdown definition into an agent.
 *
 * The permission map is flattened here: markdown allows both `bash: ask` and
 * `bash: { "git *": allow }`, and everything downstream expects the nested form.
 * Normalising once at the boundary is better than every consumer handling both.
 */
function fromMarkdown(definition: MarkdownAgent): Agent {
  return {
    name: definition.name,
    description: definition.description,
    prompt: definition.prompt,
    mode: definition.mode,
    model: definition.model,
    smallModel: definition.smallModel,
    temperature: definition.temperature,
    topP: definition.topP,
    maxTokens: definition.maxTokens,
    reasoningEffort: definition.reasoningEffort,
    tools: definition.tools ?? {},
    permission: normalisePermission(definition.permission),
    color: definition.color,
    disabled: definition.disabled,
    source: definition.source,
    path: definition.path,
    builtin: false,
  }
}

function fromConfig(name: string, definition: ConfigAgent): Agent {
  return {
    name,
    description: definition.description ?? "",
    prompt: definition.prompt ?? "",
    mode: definition.mode ?? "all",
    model: definition.model,
    smallModel: definition.smallModel,
    temperature: definition.temperature,
    topP: definition.topP,
    maxTokens: definition.maxTokens,
    reasoningEffort: definition.reasoningEffort,
    tools: definition.tools ?? {},
    permission: normalisePermission(definition.permission),
    color: definition.color,
    disabled: definition.disable === true,
    source: "config",
    builtin: false,
  }
}

/** Expands the flat permission form into the nested one. */
function normalisePermission(
  input: Record<string, PermissionEffect | Record<string, PermissionEffect>> | undefined,
): AgentPermissionRules {
  if (!input) return {}

  const result: AgentPermissionRules = {}

  for (const [action, value] of Object.entries(input)) {
    result[action] = typeof value === "string" ? { "*": value } : value
  }

  return result
}

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

/**
 * Merges an override onto a base agent.
 *
 * Field by field, because whole-object replacement is the behaviour people
 * complain about: they set one property and lose six others they never mentioned.
 *
 * A subtlety with the prompt. An override with no prompt inherits the base one,
 * which is what makes "same agent, different model" a one-line file. But an
 * override with a prompt *replaces* rather than appends, because concatenating two
 * system prompts produces contradictory instructions far more often than it
 * produces a useful combination.
 */
export function mergeAgents(base: Agent, override: Agent): Agent {
  return {
    name: base.name,
    description: override.description || base.description,
    prompt: override.prompt || base.prompt,
    mode: override.mode !== "all" ? override.mode : base.mode,
    model: override.model ?? base.model,
    smallModel: override.smallModel ?? base.smallModel,
    temperature: override.temperature ?? base.temperature,
    topP: override.topP ?? base.topP,
    maxTokens: override.maxTokens ?? base.maxTokens,
    reasoningEffort: override.reasoningEffort ?? base.reasoningEffort,
    tools: mergeTools(base.tools, override.tools),
    permission: mergePermission(base.permission, override.permission),
    color: override.color ?? base.color,
    disabled: override.disabled,
    source: override.source,
    path: override.path ?? base.path,
    builtin: base.builtin,
  }
}

function mergeTools(base: AgentToolRules, override: AgentToolRules): AgentToolRules {
  return { ...base, ...override }
}

/**
 * Merges permission rules per action.
 *
 * Per action rather than wholesale, so overriding the `bash` rules leaves the
 * `edit` rules intact. Within an action the patterns merge too, so adding one
 * exception does not discard the others.
 */
function mergePermission(
  base: AgentPermissionRules,
  override: AgentPermissionRules,
): AgentPermissionRules {
  const result: AgentPermissionRules = {}

  for (const [action, patterns] of Object.entries(base)) {
    result[action] = { ...patterns }
  }

  for (const [action, patterns] of Object.entries(override)) {
    result[action] = { ...(result[action] ?? {}), ...patterns }
  }

  return result
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

let cache: { key: string; result: LoadAgentsResult } | undefined

/**
 * Loads and merges every agent.
 *
 * Cached by working directory and configuration identity. Discovery touches the
 * filesystem, and the interface asks for the agent list on every keystroke while
 * the picker is open.
 */
export function loadAgents(input: LoadAgentsInput): LoadAgentsResult {
  const key = `${input.cwd}:${input.builtinOnly ? "builtin" : "full"}:${JSON.stringify(input.config ?? {})}`

  if (cache && cache.key === key) return cache.result

  const byName = new Map<string, Agent>()

  for (const agent of BUILTIN_AGENTS) {
    byName.set(agent.name, agent)
  }

  const issues: Array<{ path: string; issues: ParseIssue[] }> = []

  if (!input.builtinOnly) {
    const discovered = discoverMarkdownAgents(input.cwd)
    issues.push(...discovered.issues)

    // User files first, so configuration and project files can still override.
    for (const definition of discovered.agents) {
      if (definition.source !== "user") continue
      apply(byName, fromMarkdown(definition))
    }

    for (const [name, definition] of Object.entries(input.config ?? {})) {
      apply(byName, fromConfig(name, definition))
    }

    for (const definition of discovered.agents) {
      if (definition.source === "user") continue
      apply(byName, fromMarkdown(definition))
    }

    for (const definition of pluginAgents()) {
      apply(
        byName,
        fromConfig(definition.name, {
          description: definition.description,
          prompt: definition.prompt,
          mode: definition.mode,
          model: definition.model,
          temperature: definition.temperature,
          tools: definition.tools,
          permission: definition.permission as ConfigAgent["permission"],
        }),
      )
    }
  } else {
    for (const [name, definition] of Object.entries(input.config ?? {})) {
      apply(byName, fromConfig(name, definition))
    }
  }

  const agents = [...byName.values()]
    .filter((agent) => !agent.disabled)
    .sort((a, b) => {
      // Built-ins first, then alphabetical. The picker reads better that way:
      // the familiar names are at the top where people expect them.
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  const result: LoadAgentsResult = { agents, issues }
  cache = { key, result }

  log.info("agents loaded", {
    count: agents.length,
    builtin: agents.filter((agent) => agent.builtin).length,
    issues: issues.length,
  })

  return result
}

function apply(byName: Map<string, Agent>, agent: Agent): void {
  const existing = byName.get(agent.name)

  if (existing) {
    byName.set(agent.name, mergeAgents(existing, agent))
    log.debug("agent overridden", { name: agent.name, source: agent.source })
    return
  }

  byName.set(agent.name, agent)
}

export function resetAgents(): void {
  cache = undefined
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export interface ResolveAgentInput {
  readonly cwd: string
  readonly name?: string
  readonly config?: Record<string, ConfigAgent>
  /** Restricts the result to agents usable in this position. */
  readonly mode?: "agent" | "subagent"
}

export class UnknownAgentError extends Error {
  constructor(
    readonly requested: string,
    readonly available: string[],
  ) {
    const suggestion = closest(requested, available)

    super(
      [
        `There is no agent named "${requested}".`,
        suggestion ? `Did you mean "${suggestion}"?` : "",
        `Available: ${available.join(", ")}`,
      ]
        .filter(Boolean)
        .join(" "),
    )

    this.name = "UnknownAgentError"
  }
}

/**
 * Resolves a name to an agent.
 *
 * Defaults to `build`, which is the general-purpose one. Throwing on an unknown
 * name rather than falling back, because silently running a different agent than
 * the one asked for produces behaviour the user cannot explain.
 */
export function resolveAgent(input: ResolveAgentInput): Agent {
  const { agents } = loadAgents({ cwd: input.cwd, config: input.config })

  const usable = input.mode
    ? agents.filter((agent) => agent.mode === "all" || agent.mode === input.mode)
    : agents

  const name = input.name ?? "build"
  const found = usable.find((agent) => agent.name === name)

  if (found) return found

  // The agent may exist but be unusable in this position, which needs a
  // different message from "does not exist".
  const wrongMode = agents.find((agent) => agent.name === name)

  if (wrongMode) {
    throw new Error(
      `The agent "${name}" has mode "${wrongMode.mode}", so it cannot be used as a ${input.mode ?? "agent"}.`,
    )
  }

  throw new UnknownAgentError(
    name,
    usable.map((agent) => agent.name),
  )
}

/** The agents that can be invoked directly. */
export function primaryAgents(cwd: string, config?: Record<string, ConfigAgent>): Agent[] {
  return loadAgents({ cwd, config }).agents.filter(
    (agent) => agent.mode === "all" || agent.mode === "agent",
  )
}

/**
 * The agents that can be spawned as subagents.
 *
 * The internal ones \u2014 `compact` and `title` \u2014 are excluded. They exist to serve
 * the system rather than the user, and offering them in a picker invites someone
 * to run a summariser as their main agent and wonder why it will not write code.
 */
export function subagentAgents(cwd: string, config?: Record<string, ConfigAgent>): Agent[] {
  return loadAgents({ cwd, config }).agents.filter(
    (agent) =>
      (agent.mode === "all" || agent.mode === "subagent") &&
      agent.name !== "compact" &&
      agent.name !== "title",
  )
}

/**
 * The description of available subagents, for the task tool.
 *
 * Kept here rather than in the tool because the tool should not know how agents
 * are discovered, and because the same text is wanted by the CLI's `agent list`.
 */
export function describeSubagents(cwd: string, config?: Record<string, ConfigAgent>): string {
  const available = subagentAgents(cwd, config)

  if (available.length === 0) return "No subagents are configured."

  const lines: string[] = []

  for (const agent of available) {
    const description = agent.description || "(no description)"
    lines.push(`  ${agent.name} \u2014 ${description}`)
  }

  return lines.join("\n")
}

/**
 * Whether an agent may spawn subagents.
 *
 * A subagent may not, regardless of what its tool rules say. Recursion here is
 * unbounded in both time and money, and the depth limit in the subagent runner is
 * a second line of defence rather than the only one.
 */
export function canSpawnSubagents(agent: Agent, depth: number): boolean {
  if (depth > 0) return false
  if (agent.mode === "subagent") return false
  if (agent.tools["task"] === false) return false

  return true
}

/**
 * A short description of an agent for the status bar.
 *
 * Includes the model when the agent pins one, since "why is this using a
 * different model" is otherwise an unanswerable question from the interface alone.
 */
export function agentSummary(agent: Agent): string {
  const parts = [agent.name]

  if (agent.model) parts.push(agent.model)
  if (agent.mode === "subagent") parts.push("subagent")

  return parts.join(" \u00b7 ")
}
