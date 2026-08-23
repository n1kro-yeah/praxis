/**
 * System prompt assembly.
 *
 * The system prompt is built from five layers, in a deliberate order:
 *
 *   1. base       — the family-specific prompt from `prompts.ts`
 *   2. agent      — the active agent's own instructions (built-in or user)
 *   3. tools      — notes about the specific tool set this model received
 *   4. environment— cwd, platform, toolchain, tree (stable for the session)
 *   5. project    — AGENTS.md and friends, verbatim
 *
 * Order matters for two reasons. Models weight early instructions as identity
 * and late instructions as task detail, so behaviour rules go first and facts go
 * last. And prompt caching requires a byte-stable prefix, so anything volatile
 * is excluded entirely and handled by `reminders.ts` instead.
 */

import type { ModelFamily } from "../provider/types.js"
import { modelFamily } from "../provider/types.js"
import { estimateTokens } from "../util/tokenizer.js"
import { logger } from "../util/log.js"
import {
  collectEnvironment,
  renderEnvironment,
  renderInstructions,
  type EnvironmentFacts,
  type EnvironmentOptions,
} from "./environment.js"
import { INTERNAL_PROMPTS, promptForFamily } from "./prompts.js"

const log = logger("prompt.system")

export interface SystemPromptInput {
  readonly providerId: string
  readonly modelId: string
  readonly contextWindow: number
  /** Agent instructions, appended after the base prompt. */
  readonly agentPrompt?: string
  /** Agent name, used in the header so the model knows its role. */
  readonly agentName?: string
  readonly toolNames?: readonly string[]
  readonly environment?: EnvironmentOptions
  /** Precomputed facts, when the caller already has them. */
  readonly facts?: EnvironmentFacts
  /** Skip the environment block (subagents that inherit context). */
  readonly includeEnvironment?: boolean
  readonly includeInstructions?: boolean
  /** Extra blocks appended last, used by plugins. */
  readonly extra?: readonly string[]
}

export interface SystemPrompt {
  /** Blocks in order; transports join or send them separately as needed. */
  readonly blocks: string[]
  readonly estimatedTokens: number
  readonly family: ModelFamily
}

/* ------------------------------------------------------------------ */
/* Tool notes                                                          */
/* ------------------------------------------------------------------ */

/**
 * Per-tool usage notes.
 *
 * A tool's own description tells the model what the tool does; these notes tell
 * it when to prefer one tool over another, which is where models actually go
 * wrong. Only notes for tools the model actually received are emitted, so this
 * never wastes tokens describing an unavailable tool.
 */
const TOOL_NOTES: Record<string, string> = {
  bash: "Use for commands, not for file operations. Reading with `cat`, editing with `sed`, searching with `grep`, or listing with `ls` is worse than the dedicated tools: no truncation handling, no diagnostics, no permission granularity. Never run an interactive command or a foreground server.",
  read: "Reads with line numbers. Read before every edit, and re-read after anything external may have touched the file. Prefer a whole small file over guessing an offset.",
  write: "Creates or fully replaces a file. Use it for new files. Replacing an existing file wholesale destroys anything you did not know was there — use `edit` instead unless replacement is the intent.",
  edit: "The primary way to change code. `oldString` must appear exactly once and must be copied verbatim from what you read, including indentation. Include a line or two of surrounding context to make it unique rather than reaching for `replaceAll`.",
  multiedit: "Several edits to one file in one atomic operation. Edits apply in order, each seeing the result of the previous. Preferable to a chain of single edits: fewer round trips and no half-applied state.",
  apply_patch: "Applies a multi-file patch in one operation. Context lines must match the file exactly. Prefer it when a change spans several files coherently.",
  glob: "Finds files by path pattern. Fast on large trees. Use it when you know roughly where something is but not its exact name.",
  grep: "Searches file contents by regular expression. This is your primary discovery tool. Search before asking and before assuming. Use `-A`/`-B` context when you need to see the surrounding code.",
  list: "Lists a directory. Use it to orient in an unfamiliar area; use `glob` or `grep` when you already know what you are looking for.",
  task: "Delegates a self-contained piece of work to a subagent. Worth it for genuinely parallel or well-isolated work, and for exploration whose intermediate output would otherwise flood your context. Not worth it for anything you could do in two tool calls: the subagent starts with no context and must rediscover everything.",
  todowrite: "Tracks multi-step work so the user can see progress. Use it for three or more steps. One item in progress at a time. Mark complete only when actually done.",
  todoread: "Re-reads the todo list. Rarely needed; the current list is already in your context.",
  webfetch: "Fetches a URL and converts it to text. Use it for documentation, changelogs, and issue threads. Do not use it to fetch code you could read locally.",
  websearch: "Searches the web. Use it for library documentation, error messages you do not recognise, and anything version-specific. Do not use it for questions about this repository.",
  lsp: "Queries the language server: diagnostics, definitions, references, symbols, hover. Far more reliable than text search for 'where is this used' and 'what is this type'.",
  diagnostics: "Current compiler and linter errors. Check after editing. Fix what you introduced.",
  batch: "Runs several independent tool calls concurrently. Use it whenever your next steps do not depend on each other; sequential exploration of independent questions is the most common source of wasted time.",
  question: "Asks the user a multiple-choice question. Only for genuine preference decisions that change the implementation. Never for something you could determine by reading the code.",
  skill: "Loads a skill: a stored procedure for a recurring task in this project. Check the available skills before improvising a workflow the project already has one for.",
  patch: "Applies a unified diff. Context must match exactly.",
  notebook: "Reads and edits Jupyter notebooks cell by cell. Editing the raw `.ipynb` JSON with `edit` corrupts the file; use this instead.",
  symbols: "Lists symbols in a file or across the workspace. Faster than reading a file to find out what is in it.",
  memory: "Reads and writes durable project notes. Use it for facts that are expensive to rediscover and stable across sessions, not for the current task's state.",
  git: "Inspects repository state: status, diff, log, blame. Read-only. Committing requires an explicit instruction from the user in this turn.",
  kill: "Terminates a background process you started. Clean up anything long-running before you finish.",
  output: "Reads accumulated output from a background process.",
  plan: "Writes the plan file in plan mode. The only mutating tool available there.",
}

export function renderToolNotes(toolNames: readonly string[]): string {
  const notes = toolNames
    .map((name) => {
      const note = TOOL_NOTES[name]
      return note ? `- \`${name}\`: ${note}` : undefined
    })
    .filter((line): line is string => line !== undefined)

  if (notes.length === 0) return ""

  return [
    "## Tool notes",
    "",
    "Each tool's schema describes what it does. These notes describe when to choose it.",
    "",
    ...notes,
  ].join("\n")
}

/* ------------------------------------------------------------------ */
/* Family-specific addenda                                             */
/* ------------------------------------------------------------------ */

/**
 * Small corrective additions for known per-family behaviours. These are the
 * result of observed failure modes, not stylistic preference.
 */
function familyAddendum(family: ModelFamily, hasApplyPatch: boolean): string {
  const lines: string[] = []

  switch (family) {
    case "openai-reasoning":
      lines.push(
        "Your reasoning is not shown to the user, so anything the user needs to know must appear in your final message. Do not assume they saw how you reached the answer.",
        "Reason before you act, but do not reason instead of acting. If the next step requires reading a file, read it.",
      )
      if (hasApplyPatch) {
        lines.push(
          "Use `apply_patch` for edits. It is the format you handle most reliably; a hand-built `edit` call with mismatched whitespace is the usual cause of failed edits.",
        )
      }
      break

    case "anthropic":
      lines.push(
        "Run independent tool calls in the same step rather than one per turn. Reading three files takes one step.",
        "When a task has several steps, keep the todo list current as you go; it is how the user follows your progress.",
      )
      break

    case "gemini":
      lines.push(
        "Do not restate the file you just read or the diff you just applied. The interface already shows both.",
        "One tool call per distinct operation. Do not emit the same call twice in a step.",
      )
      break

    case "qwen":
    case "glm":
    case "kimi":
    case "deepseek":
      lines.push(
        "Emit tool calls only through the tool-calling interface. Never write a tool call as text, JSON, or a code fence in your reply.",
        "Do not write your reasoning into the reply. Keep the reply to the outcome.",
      )
      break

    case "llama":
    case "mistral":
      lines.push(
        "Use the tool interface for every action. Do not describe an edit you did not make.",
        "Keep replies short. State what changed and stop.",
      )
      break

    case "grok":
      lines.push(
        "No jokes, asides, or personality in a coding session. The user wants the change and the outcome.",
      )
      break

    default:
      break
  }

  if (lines.length === 0) return ""
  return ["## Model-specific notes", "", ...lines.map((line) => `- ${line}`)].join("\n")
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export function buildSystemPrompt(input: SystemPromptInput): SystemPrompt {
  const family = modelFamily(input.providerId, input.modelId)
  const blocks: string[] = []

  blocks.push(promptForFamily(family, input.contextWindow))

  if (input.agentName && input.agentName !== "build") {
    blocks.push(
      `You are running as the \`${input.agentName}\` agent. Your available tools and permissions reflect that role; work within them rather than looking for a way around them.`,
    )
  }

  if (input.agentPrompt && input.agentPrompt.trim() !== "") {
    blocks.push(input.agentPrompt.trim())
  }

  const toolNames = input.toolNames ?? []
  if (toolNames.length) {
    const notes = renderToolNotes(toolNames)
    if (notes !== "") blocks.push(notes)
  }

  const addendum = familyAddendum(family, toolNames.includes("apply_patch"))
  if (addendum !== "") blocks.push(addendum)

  if (input.includeEnvironment !== false) {
    const facts = input.facts ?? (input.environment ? collectEnvironment(input.environment) : undefined)
    if (facts) {
      blocks.push(renderEnvironment(facts))
      if (input.includeInstructions !== false && facts.instructions.length) {
        blocks.push(renderInstructions(facts.instructions))
      }
    }
  }

  for (const block of input.extra ?? []) {
    if (block.trim() !== "") blocks.push(block.trim())
  }

  const estimatedTokens = blocks.reduce((sum, block) => sum + estimateTokens(block), 0)

  // A system prompt above ~15% of the window starts crowding out the work.
  if (input.contextWindow > 0 && estimatedTokens > input.contextWindow * 0.15) {
    log.warn("system prompt is large relative to the context window", {
      estimatedTokens,
      contextWindow: input.contextWindow,
    })
  }

  return { blocks, estimatedTokens, family }
}

/* ------------------------------------------------------------------ */
/* Internal prompts                                                    */
/* ------------------------------------------------------------------ */

export function titlePrompt(): string[] {
  return [INTERNAL_PROMPTS.title]
}

export function compactionPrompt(): string[] {
  return [INTERNAL_PROMPTS.compaction]
}

export function explorePrompt(facts?: EnvironmentFacts): string[] {
  const blocks = [INTERNAL_PROMPTS.explore]
  if (facts) blocks.push(renderEnvironment(facts))
  return blocks
}

export function generalPrompt(facts?: EnvironmentFacts): string[] {
  const blocks = [INTERNAL_PROMPTS.general]
  if (facts) {
    blocks.push(renderEnvironment(facts))
    if (facts.instructions.length) blocks.push(renderInstructions(facts.instructions))
  }
  return blocks
}

export function planPrompt(facts?: EnvironmentFacts): string[] {
  const blocks = [INTERNAL_PROMPTS.plan]
  if (facts) {
    blocks.push(renderEnvironment(facts))
    if (facts.instructions.length) blocks.push(renderInstructions(facts.instructions))
  }
  return blocks
}

/**
 * Prompt for the `/init` command, which writes the project's AGENTS.md.
 *
 * Written as a task description rather than a template because the useful
 * content is entirely project-specific, and a template produces a file full of
 * generic advice that no maintainer would have written.
 */
export function initPrompt(existing: string | undefined): string {
  const base = [
    "Write or update this project's `AGENTS.md`: the file a coding agent reads before working here.",
    "",
    "Investigate first. Read the manifest, the build and CI configuration, the test setup, the linter and formatter configuration, and enough source to see the real conventions. Then write only what you verified.",
    "",
    "The file must contain:",
    "- The exact commands to build, typecheck, lint, format, and run tests, including how to run a single test file. Copy them from the project's own configuration; do not guess.",
    "- The conventions that are actually followed here and would not be obvious: module and import style, error handling, naming, file layout, how state is managed, what is generated and must not be edited by hand.",
    "- Where things live: the entry points, and the directory-level responsibilities.",
    "- The traps: steps that must run in a particular order, generated files, environment variables required for tests, anything that fails confusingly if skipped.",
    "",
    "Do not include: generic software-engineering advice, a description of what the project does for end users, a licence section, a contributor guide, or instructions that apply to every project in the world. If a line would be true of any repository, delete it.",
    "",
    "Aim for 40 to 120 lines. Terse imperative prose and short lists. No filler.",
  ].join("\n")

  if (!existing) return base
  return [
    base,
    "",
    "An `AGENTS.md` already exists. Preserve everything in it that is still accurate, correct what is stale, and add what is missing. Do not rewrite it from scratch, and do not drop project-specific instructions you do not understand — they were put there deliberately.",
    "",
    "Current contents:",
    "",
    existing,
  ].join("\n")
}

/**
 * Prompt for generating a git commit message from a staged diff.
 * Kept here so the format rules live with the other prompts.
 */
export function commitPrompt(): string {
  return [
    "Write a commit message for the staged changes.",
    "",
    "- First line: imperative mood, under 72 characters, no trailing period. Say what the change does, not what you did.",
    "- Follow the repository's existing convention if it has one; check recent history before choosing a format.",
    "- Add a body only when the reason for the change is not obvious from the diff. Explain why, not what.",
    "- No emoji, no attribution, no 'generated by' line, no issue numbers you were not given.",
    "",
    "Output only the commit message.",
  ].join("\n")
}

/** Prompt for summarising a diff into a pull-request description. */
export function pullRequestPrompt(): string {
  return [
    "Write a pull request description for this branch.",
    "",
    "Structure:",
    "- One paragraph on what changes and why. Lead with the user-visible effect if there is one.",
    "- A short list of the substantive changes, grouped by area rather than by file.",
    "- How it was verified: the commands run and what they showed.",
    "- Anything a reviewer should look at closely, or any follow-up left deliberately undone.",
    "",
    "No headings beyond those sections, no checklists of process steps, no restating the diff file by file.",
  ].join("\n")
}
