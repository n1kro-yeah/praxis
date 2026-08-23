/**
 * Agents.
 *
 * An agent is a named configuration of *capability*, not of personality. That
 * distinction is the whole design. It would be easy to make agents differ by
 * prompt — "you are a careful planner" — but a prompt is a suggestion and a model
 * under pressure will ignore it. An agent that must not write files should be
 * unable to write files.
 *
 * So an agent is defined by:
 *  - its **tool set** (which tools even exist for it),
 *  - its **permission rules** (what those tools may touch),
 *  - its **model and sampling** parameters,
 *  - and only then, its prompt additions.
 *
 * Plan mode is the clearest example. The `plan` agent has no `write` and no
 * `edit`, and its `bash` permission denies anything mutating. It cannot modify
 * the repository because the capability is absent, not because it was asked
 * nicely. That is what makes plan mode trustworthy enough to use.
 *
 * Six agents ship built in:
 *  - `build`   — the default; everything enabled.
 *  - `plan`    — read and analyse, propose a plan, touch nothing.
 *  - `general` — the default subagent; full tools, no further delegation.
 *  - `explore` — search only; cheap, fast, for "where is X".
 *  - `review`  — read plus git history; for critique.
 *  - `compact` — internal, used by compaction.
 *  - `title`   — internal, used for session titles.
 *
 * Users add their own as markdown files with frontmatter, which the loader turns
 * into exactly this shape.
 */

import { logger } from "../util/log.js"
import { NotFoundError } from "../util/error.js"
import type { PermissionRule } from "../permission/types.js"

const log = logger("agent")

/* ------------------------------------------------------------------ */
/* Definition                                                          */
/* ------------------------------------------------------------------ */

export type ReasoningEffort = "minimal" | "low" | "medium" | "high"

export interface Agent {
  readonly name: string
  readonly description: string
  /**
   * Whether this agent may be delegated to by the `task` tool.
   *
   * The primary agents are driven by the user; subagents are driven by another
   * agent. Keeping them separate stops `build` from delegating to itself, which
   * is a recursion that costs money and achieves nothing.
   */
  readonly mode: "primary" | "subagent" | "internal"
  /** Model override. Falls back to the session's model. */
  readonly model?: string
  /** Prefer the small/cheap model. Used by internal agents. */
  readonly useSmallModel?: boolean
  readonly temperature?: number
  readonly topP?: number
  readonly maxOutputTokens?: number
  readonly reasoningEffort?: ReasoningEffort
  /**
   * Explicit tool allow-list. When absent, every registered tool is available
   * subject to `disabledTools`.
   */
  readonly tools?: readonly string[]
  readonly disabledTools?: readonly string[]
  /** Rules layered on top of the built-in permission set. */
  readonly permissions?: readonly PermissionRule[]
  /** Appended to the system prompt. */
  readonly instructions?: string
  /** Replaces the system prompt entirely. Rare; used by internal agents. */
  readonly systemPromptOverride?: string
  /** Maximum delegation depth this agent may create. */
  readonly maxDepth?: number
  /** Where this definition came from, for `agent list`. */
  readonly source: "builtin" | "config" | "file" | "plugin"
  readonly filePath?: string
  /** Hidden from the agent picker. */
  readonly hidden?: boolean
  /** Colour used in the TUI. */
  readonly color?: string
}

/* ------------------------------------------------------------------ */
/* Built-in agents                                                     */
/* ------------------------------------------------------------------ */

/**
 * Tools available to every read-only agent.
 *
 * `bash` is included deliberately: a huge amount of investigation is done with
 * shell commands (`git log`, `npm ls`, `wc -l`), and removing it would cripple
 * exploration. It is constrained by permission rules instead, which is the right
 * layer — `git log` is read-only, `git push` is not, and only the permission
 * engine can tell the difference.
 */
const READ_TOOLS = [
  "read",
  "grep",
  "glob",
  "list",
  "bash",
  "symbols",
  "diagnostics",
  "webfetch",
  "websearch",
  "todoread",
  "question",
] as const

const WRITE_TOOLS = [
  "write",
  "edit",
  "multiedit",
  "apply_patch",
  "patch",
  "notebook",
] as const

/**
 * Deny rules for read-only agents.
 *
 * Shell commands are the leak in every read-only mode: an agent that cannot use
 * `write` will happily use `bash` with a heredoc. These rules close that, and the
 * list is exhaustive about the ways a shell can mutate state rather than trying to
 * be clever.
 */
const READ_ONLY_RULES: readonly PermissionRule[] = [
  { action: "edit", resource: "*", effect: "deny", source: "agent" },
  { action: "write", resource: "*", effect: "deny", source: "agent" },
  { action: "delete", resource: "*", effect: "deny", source: "agent" },
  // Anything that writes through a shell.
  { action: "shell", resource: "rm *", effect: "deny", source: "agent" },
  { action: "shell", resource: "mv *", effect: "deny", source: "agent" },
  { action: "shell", resource: "cp *", effect: "deny", source: "agent" },
  { action: "shell", resource: "mkdir *", effect: "deny", source: "agent" },
  { action: "shell", resource: "touch *", effect: "deny", source: "agent" },
  { action: "shell", resource: "tee *", effect: "deny", source: "agent" },
  { action: "shell", resource: "dd *", effect: "deny", source: "agent" },
  { action: "shell", resource: "chmod *", effect: "deny", source: "agent" },
  { action: "shell", resource: "chown *", effect: "deny", source: "agent" },
  { action: "shell", resource: "ln *", effect: "deny", source: "agent" },
  { action: "shell", resource: "truncate *", effect: "deny", source: "agent" },
  { action: "shell", resource: "sed -i *", effect: "deny", source: "agent" },
  { action: "shell", resource: "perl -i *", effect: "deny", source: "agent" },
  // Git commands that change state.
  { action: "shell", resource: "git commit *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git push *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git checkout *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git switch *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git reset *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git revert *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git merge *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git rebase *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git stash *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git clean *", effect: "deny", source: "agent" },
  { action: "shell", resource: "git apply *", effect: "deny", source: "agent" },
  // Package managers install, which writes.
  { action: "shell", resource: "npm install *", effect: "deny", source: "agent" },
  { action: "shell", resource: "npm i *", effect: "deny", source: "agent" },
  { action: "shell", resource: "pnpm add *", effect: "deny", source: "agent" },
  { action: "shell", resource: "yarn add *", effect: "deny", source: "agent" },
  { action: "shell", resource: "pip install *", effect: "deny", source: "agent" },
  { action: "shell", resource: "cargo add *", effect: "deny", source: "agent" },
  { action: "shell", resource: "go get *", effect: "deny", source: "agent" },
  { action: "shell", resource: "brew install *", effect: "deny", source: "agent" },
  { action: "shell", resource: "apt *", effect: "deny", source: "agent" },
]

const BUILTIN: readonly Agent[] = [
  /* ---------------- build ---------------- */
  {
    name: "build",
    description:
      "The default agent. Full access to read, write, run commands, and delegate. Use it for implementation work.",
    mode: "primary",
    source: "builtin",
    maxDepth: 2,
    color: "green",
    // No tool list: everything registered is available.
  },

  /* ---------------- plan ---------------- */
  {
    name: "plan",
    description:
      "Investigates and proposes a plan without changing anything. Use it when the approach is unclear, when the change is risky, or when you want to review before committing to an implementation.",
    mode: "primary",
    source: "builtin",
    color: "blue",
    tools: [...READ_TOOLS, "todowrite", "task", "plan", "batch", "skill", "memory"],
    permissions: READ_ONLY_RULES,
    maxDepth: 1,
    instructions: `You are in plan mode. You cannot modify files, and any attempt to do so will be refused — this is by design, not an obstacle to work around.

Your job is to produce a plan the user can approve. That means:

1. Investigate properly first. Read the code that will actually change. Do not plan against an imagined structure.
2. Identify the specific files and functions involved, with paths.
3. State the approach, and say what you considered and rejected. A plan without alternatives looks unconsidered.
4. Call out risks: what could break, what is hard to reverse, what you are uncertain about.
5. Break the work into ordered steps small enough to verify individually.

Be concrete. "Update the auth module" is not a plan. "Add a \`refreshToken\` field to \`Session\` in src/auth/types.ts, thread it through \`createSession\`, and add the refresh call to the 401 branch in src/http/client.ts" is a plan.

If the task turns out to be trivial, say so and give the one-line change rather than padding it into a document.

When you have a plan, present it and stop. Do not ask to proceed — the user switches out of plan mode when they are ready.`,
  },

  /* ---------------- general ---------------- */
  {
    name: "general",
    description:
      "General-purpose subagent for delegated work. Has the full tool set but cannot delegate further. Use it for self-contained tasks that would otherwise clutter the main conversation.",
    mode: "subagent",
    source: "builtin",
    color: "cyan",
    // No further delegation: nested subagents multiply cost unpredictably and
    // make the trace impossible to follow.
    disabledTools: ["task"],
    maxDepth: 0,
    instructions: `You are running as a subagent. Another agent delegated a specific task to you and is waiting for your result.

This changes how you should work:

- You have no conversation history and no user to ask. Everything you need is in the task description; if it is genuinely ambiguous, make the most reasonable interpretation and state the assumption in your result.
- Your final message is the entire deliverable. The agent that called you sees nothing else — not your tool calls, not your intermediate reasoning. Put every finding, file path, and conclusion in it.
- Be complete but not padded. Include the specific paths, names, and line numbers the caller will need. Omit the narrative of how you searched.
- If you could not complete the task, say precisely what blocked you. A clear failure is far more useful than a vague success.`,
  },

  /* ---------------- explore ---------------- */
  {
    name: "explore",
    description:
      "Fast, cheap codebase search. Finds where something lives without reading whole files. Use it for locating code, not for understanding or changing it.",
    mode: "subagent",
    source: "builtin",
    color: "yellow",
    useSmallModel: true,
    tools: ["grep", "glob", "list", "read", "symbols"],
    permissions: READ_ONLY_RULES,
    maxDepth: 0,
    maxOutputTokens: 4_096,
    instructions: `You locate things in a codebase. That is your only job.

Be fast and cheap. Prefer grep and glob over reading files; when you must read, read the relevant range rather than the whole file.

Report findings as a list of locations with a one-line note each:

  src/auth/session.ts:142 — createSession, builds the token
  src/http/client.ts:88 — attaches the token to requests

Do not summarise what the code does beyond that one line, do not suggest changes, and do not read files to satisfy your curiosity. If you cannot find something, say so and list what you searched for — that tells the caller how to reformulate.`,
  },

  /* ---------------- review ---------------- */
  {
    name: "review",
    description:
      "Reviews a change critically. Reads the diff and the surrounding code, and reports problems. Cannot modify anything.",
    mode: "subagent",
    source: "builtin",
    color: "magenta",
    tools: [...READ_TOOLS, "batch"],
    permissions: READ_ONLY_RULES,
    maxDepth: 0,
    instructions: `You review code changes. You do not make them.

Read the diff, then read enough of the surrounding code to judge it. A diff in isolation hides most real problems — the bug is usually in the interaction with code that did not change.

Report in order of severity, and be specific:

- **Bugs**: something that will not work. Give the input that breaks it.
- **Risks**: something that will work now and break later. Say when.
- **Inconsistencies**: this code disagrees with how the rest of the project does it. Cite the other place.
- **Nits**: style and naming. Keep these brief and clearly labelled as nits.

Do not pad the review. If the change is fine, say it is fine and stop — inventing objections to appear thorough wastes the reader's time and trains them to ignore you. Never comment on formatting a formatter would fix.`,
  },

  /* ---------------- internal: compaction ---------------- */
  {
    name: "compact",
    description: "Internal. Summarises a conversation to fit the context window.",
    mode: "internal",
    source: "builtin",
    hidden: true,
    tools: [],
    temperature: 0.2,
    maxOutputTokens: 4_096,
    maxDepth: 0,
  },

  /* ---------------- internal: title ---------------- */
  {
    name: "title",
    description: "Internal. Generates a short session title.",
    mode: "internal",
    source: "builtin",
    hidden: true,
    tools: [],
    useSmallModel: true,
    temperature: 0.3,
    maxOutputTokens: 64,
    maxDepth: 0,
  },
]

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const registry = new Map<string, Agent>()

for (const agent of BUILTIN) registry.set(agent.name, agent)

/**
 * Registers or replaces an agent.
 *
 * User definitions deliberately override built-ins by name: a project that wants
 * a stricter `build` should be able to say so without inventing a new name, and
 * the alternative (silently ignoring their definition) would be worse.
 */
export function registerAgent(agent: Agent): void {
  const existing = registry.get(agent.name)
  if (existing && existing.source === "builtin" && agent.source !== "builtin") {
    log.debug("user definition overrides a built-in agent", { name: agent.name })
  }
  registry.set(agent.name, agent)
}

export function unregisterAgent(name: string): void {
  registry.delete(name)
}

/** Restores the built-in set, used by tests and by configuration reload. */
export function resetAgents(): void {
  registry.clear()
  for (const agent of BUILTIN) registry.set(agent.name, agent)
}

export function agentByName(name: string): Agent {
  const agent = registry.get(name)
  if (agent) return agent

  // A misspelled agent name should not kill the session. Fall back to the
  // default and say so loudly in the log.
  log.warn("unknown agent, falling back to build", { name })
  const fallback = registry.get("build")
  if (!fallback) throw new NotFoundError(`No agent named ${name} and no default available.`)
  return fallback
}

export function findAgent(name: string): Agent | undefined {
  return registry.get(name)
}

export function allAgents(): Agent[] {
  return [...registry.values()]
}

/** Agents the user can switch to, in picker order. */
export function primaryAgents(): Agent[] {
  return [...registry.values()]
    .filter((agent) => agent.mode === "primary" && !agent.hidden)
    .sort((left, right) => {
      // `build` first, `plan` second, then alphabetical: these are the two the
      // user cycles between constantly.
      const rank = (name: string): number => (name === "build" ? 0 : name === "plan" ? 1 : 2)
      const difference = rank(left.name) - rank(right.name)
      return difference !== 0 ? difference : left.name.localeCompare(right.name)
    })
}

/** Agents the `task` tool may delegate to. */
export function subagents(): Agent[] {
  return [...registry.values()]
    .filter((agent) => agent.mode === "subagent" && !agent.hidden)
    .sort((left, right) => left.name.localeCompare(right.name))
}

/* ------------------------------------------------------------------ */
/* Resolution helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Works out the tool set for an agent.
 *
 * Allow-list wins over deny-list when both are present, because an explicit list
 * is a stronger statement of intent than an exclusion. Applied before the
 * model-specific filtering in the tool registry, so an agent can never gain a
 * tool the model cannot use.
 */
export function toolFilter(agent: Agent): { allow?: readonly string[]; deny: readonly string[] } {
  if (agent.tools) {
    return { allow: agent.tools, deny: agent.disabledTools ?? [] }
  }
  return { deny: agent.disabledTools ?? [] }
}

/**
 * Whether an agent may delegate at the given depth.
 *
 * Depth is checked here rather than in the `task` tool so that a custom agent can
 * tighten it without reimplementing the check.
 */
export function canDelegate(agent: Agent, currentDepth: number): boolean {
  const max = agent.maxDepth ?? 1
  return currentDepth < max
}

/**
 * Merges a partial definition over an existing agent.
 *
 * Used by configuration: `{"agent": {"build": {"model": "..."}}}` should change
 * only the model. Arrays replace rather than concatenate, because a user
 * specifying a tool list means "exactly these".
 */
export function mergeAgent(base: Agent, overrides: Partial<Agent>): Agent {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
    // Instructions concatenate: a project adding context should not lose the
    // built-in behaviour that makes the agent work.
    instructions:
      overrides.instructions && base.instructions
        ? `${base.instructions}\n\n${overrides.instructions}`
        : (overrides.instructions ?? base.instructions),
    permissions: overrides.permissions
      ? [...(base.permissions ?? []), ...overrides.permissions]
      : base.permissions,
  } as Agent
}

/**
 * Applies agent definitions from configuration.
 *
 * Called after the configuration is loaded and again on reload. Definitions for
 * unknown names create new agents; definitions for known names merge.
 */
export function applyConfigAgents(
  definitions: Record<string, Partial<Agent> & { disable?: boolean }>,
): void {
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.disable) {
      unregisterAgent(name)
      continue
    }

    const existing = registry.get(name)

    if (existing) {
      registerAgent(mergeAgent(existing, { ...definition, source: "config" }))
      continue
    }

    registerAgent({
      name,
      description: definition.description ?? `Custom agent ${name}.`,
      mode: definition.mode ?? "subagent",
      source: "config",
      ...definition,
    } as Agent)
  }
}

/**
 * Renders the agent list for `praxis agent list`.
 *
 * Includes the capability summary rather than only the description, because
 * "which of these can edit my files" is the question users actually have.
 */
export function describeAgents(): string {
  const rows = [...registry.values()]
    .filter((agent) => !agent.hidden)
    .sort((left, right) => left.name.localeCompare(right.name))

  const lines: string[] = []

  for (const agent of rows) {
    const capability = agent.permissions?.some(
      (rule) => rule.action === "edit" && rule.effect === "deny",
    )
      ? "read-only"
      : "read/write"

    const tools = agent.tools ? `${agent.tools.length} tools` : "all tools"
    const model = agent.model ?? (agent.useSmallModel ? "small model" : "session model")

    lines.push(
      `${agent.name.padEnd(10)} ${agent.mode.padEnd(9)} ${capability.padEnd(11)} ${tools.padEnd(10)} ${model}`,
      `           ${agent.description}`,
      "",
    )
  }

  return lines.join("\n").trimEnd()
}

export const BUILTIN_AGENT_NAMES = BUILTIN.map((agent) => agent.name)
export { READ_TOOLS, WRITE_TOOLS, READ_ONLY_RULES }
