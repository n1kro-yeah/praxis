/**
 * The `task` tool: delegation to a subagent.
 *
 * The single most important tool for long tasks, because it is the only mechanism
 * that trades a *bounded* amount of the parent's context for an *unbounded*
 * amount of work.
 *
 * The economics: exploring an unfamiliar codebase costs tens of thousands of
 * tokens of file reads and search results, almost all of which are irrelevant
 * once the answer is found. Delegating that exploration to a subagent means the
 * parent pays only for the subagent's final summary. A parent that greps and
 * reads its way through a monorepo will exhaust its window before it writes a
 * line of code; a parent that delegates will not.
 *
 * The constraints, which are what make it safe:
 *  - Depth is capped. A subagent that can spawn subagents recursively is an
 *    excellent way to spend an unlimited amount of money.
 *  - Each agent has its own permission ruleset. The `explore` agent literally
 *    cannot write files, so delegating exploration is also a sandbox.
 *  - The subagent gets no conversation history, only its prompt. That is a
 *    feature: it forces the parent to state the task precisely, and it means the
 *    subagent cannot be confused by irrelevant earlier context.
 *  - Only the final assistant message comes back. Intermediate tool calls are
 *    shown to the user in the UI but never enter the parent's context.
 */

import { s } from "../util/schema.js"
import { logger } from "../util/log.js"
import { newId } from "../util/id.js"
import { Bus, Events } from "../util/bus.js"
import { AbortedError, NotFoundError } from "../util/error.js"
import { truncate } from "../util/string.js"
import { defineTool, fail, ok, type ToolContext, type ToolResult } from "./types.js"

const log = logger("tool.task")

/* ------------------------------------------------------------------ */
/* Runner contract                                                     */
/* ------------------------------------------------------------------ */

export interface SubagentRequest {
  /** Parent session, used to inherit the project and the permission engine. */
  readonly parentSessionId: string
  readonly parentMessageId: string
  readonly agent: string
  readonly prompt: string
  readonly description: string
  readonly cwd: string
  /** Depth of the parent; the child runs at depth + 1. */
  readonly depth: number
  /** Model override; defaults to the agent's configured model. */
  readonly model?: string
  readonly signal: AbortSignal
  /** Called as the subagent works, for live UI updates. */
  readonly onProgress?: (update: SubagentProgress) => void
}

export interface SubagentProgress {
  readonly kind: "tool" | "text" | "step"
  readonly detail: string
  readonly toolCalls: number
  readonly tokens: number
}

export interface SubagentResult {
  readonly sessionId: string
  /** The subagent's final assistant text. This is what the parent sees. */
  readonly text: string
  readonly toolCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cost: number
  readonly durationMs: number
  /** Files the subagent modified, so the parent knows what changed. */
  readonly filesChanged: readonly string[]
  readonly aborted: boolean
  readonly error?: string
}

export type SubagentRunner = (request: SubagentRequest) => Promise<SubagentResult>

/**
 * Injected by the session layer at start-up.
 *
 * Indirection rather than a direct import because the session module imports the
 * tool registry, and a direct dependency the other way would be circular. This
 * also makes the tool trivially testable with a fake runner.
 */
let runner: SubagentRunner | undefined

export function setSubagentRunner(next: SubagentRunner): void {
  runner = next
}

export function subagentRunner(): SubagentRunner {
  if (!runner) {
    throw new Error("No subagent runner has been registered.")
  }
  return runner
}

/* ------------------------------------------------------------------ */
/* Agent descriptions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Registry of subagents the model may delegate to.
 *
 * Populated from the built-in agents plus anything the user defined in
 * configuration or as a markdown file. The descriptions are written for the
 * *model*, not the user: each one has to make clear when to pick this agent over
 * the others, because a wrong choice wastes a whole subagent run.
 */
const available = new Map<string, { description: string; readOnly: boolean }>()

export function registerSubagent(name: string, description: string, readOnly: boolean): void {
  available.set(name, { description, readOnly })
}

export function unregisterSubagent(name: string): void {
  available.delete(name)
}

export function availableSubagents(): Array<{ name: string; description: string; readOnly: boolean }> {
  return [...available.entries()].map(([name, value]) => ({ name, ...value }))
}

export function clearSubagents(): void {
  available.clear()
}

/* ------------------------------------------------------------------ */
/* Description                                                         */
/* ------------------------------------------------------------------ */

/**
 * Builds the tool description from the registered agents.
 *
 * Generated rather than static because the set of agents depends on
 * configuration, and a description that lists agents that do not exist is worse
 * than useless — the model will try to use them.
 */
function buildDescription(agents: ReadonlyArray<{ name: string; description: string }>): string {
  const lines = [
    "Delegate a self-contained piece of work to a subagent.",
    "",
    "A subagent runs in its own context with its own tools, does the work, and returns a summary. Its intermediate file reads and search results never enter your context, which is the entire point: delegation is how you do a large amount of investigation without exhausting your context window.",
    "",
    "Delegate when:",
    "- You need to understand an unfamiliar part of the codebase and it will take several searches and reads. Ask a subagent to investigate and report back.",
    "- A task is genuinely independent and you only need the outcome, not the steps.",
    "- You are looking for something and do not know where it is. Exploration is expensive in context and cheap to delegate.",
    "",
    "Do not delegate when:",
    "- You already know which file to read. Just read it; a subagent round trip is slower and costs more.",
    "- The task needs the conversation so far. Subagents start fresh and see only the prompt you write.",
    "- You want to make a specific edit you have already worked out. Do it yourself.",
    "",
    "Writing a good prompt is the whole skill. The subagent cannot ask you questions, so state:",
    "- Exactly what you want to know or done, in specific terms.",
    "- Any paths, symbol names, or constraints you already know.",
    "- What the answer should look like: a list of file paths, an explanation, a specific value.",
    "",
    "A vague prompt gets a vague answer and wastes the run. Compare:",
    'Bad: "look into authentication"',
    'Good: "Find where the session token is validated on incoming requests. Report the file path and line number of the validation function, what it checks, and which middleware calls it."',
    "",
    "You can run several subagents at once when the tasks are independent, and you should — they execute in parallel.",
    "",
    "Available agents:",
  ]

  for (const agent of agents) {
    lines.push(`- \`${agent.name}\`: ${agent.description}`)
  }

  if (agents.length === 0) {
    lines.push("- (none configured)")
  }

  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* Tool                                                                */
/* ------------------------------------------------------------------ */

type TaskInput = {
  description: string
  prompt: string
  subagent_type?: string
  model?: string
}

export const taskTool = defineTool<TaskInput>({
  id: "task",
  action: "subagent",
  concurrent: true,
  init: (context) => {
    const agents = availableSubagents().filter((agent) => agent.name !== context.agent)
    const names = agents.map((agent) => agent.name)

    const parameters = s.object({
      description: s
        .string()
        .describe("A three-to-six word summary of the task, shown to the user while it runs."),
      prompt: s
        .string()
        .describe(
          "The full instruction for the subagent. It sees only this, so include every path, name, and constraint it needs, and say what form the answer should take.",
        ),
      subagent_type: (names.length > 0
        ? s.enum(names as [string, ...string[]])
        : s.string()
      ).describe("Which agent to use."),
      model: s
        .string()
        .optional()
        .describe('Optional model override as "provider/model". Defaults to the agent\'s own model.'),
    })

    return {
      description: buildDescription(agents),
      parameters: parameters as never,
      execute: async (input, toolContext) => executeTask(input, toolContext),
    }
  },
})

async function executeTask(input: TaskInput, context: ToolContext): Promise<ToolResult> {
  const agentName = input.subagent_type ?? "general"

  if (available.size > 0 && !available.has(agentName)) {
    return fail(
      "task",
      `There is no agent called "${agentName}". Available: ${[...available.keys()].join(", ")}.`,
    )
  }

  if (agentName === context.agent) {
    return fail(
      "task",
      `An agent cannot delegate to itself. Pick a different agent, or do the work directly.`,
    )
  }

  const prompt = input.prompt?.trim() ?? ""
  if (prompt.length < 20) {
    return fail(
      "task",
      "The prompt is too short to act on. A subagent sees only this text — state what you want found or done, which files or symbols are involved, and what the answer should look like.",
    )
  }

  await context.requestPermission({
    action: "subagent",
    resource: agentName,
    title: `Delegate to ${agentName}: ${input.description}`,
    detail: truncate(prompt, 600),
    risk: available.get(agentName)?.readOnly === false ? "medium" : "low",
  })

  const taskId = newId("task")
  const started = Date.now()

  context.metadata({
    taskId,
    agent: agentName,
    description: input.description,
    status: "running",
  })

  Bus.publish(Events.taskStarted, {
    id: taskId,
    parentSessionId: context.sessionId,
    agent: agentName,
    description: input.description,
  })

  log.info("delegating", { agent: agentName, depth: context.depth, description: input.description })

  let result: SubagentResult
  try {
    result = await subagentRunner()({
      parentSessionId: context.sessionId,
      parentMessageId: context.messageId,
      agent: agentName,
      prompt,
      description: input.description,
      cwd: context.cwd,
      depth: context.depth,
      model: input.model,
      signal: context.signal,
      onProgress: (update) => {
        context.metadata({
          taskId,
          status: "running",
          toolCalls: update.toolCalls,
          tokens: update.tokens,
          detail: update.detail,
        })
      },
    })
  } catch (error) {
    if (error instanceof AbortedError || context.signal.aborted) {
      throw error
    }
    if (error instanceof NotFoundError) {
      return fail("task", String(error.message))
    }
    log.error("subagent failed", { agent: agentName, error: String(error) })
    return fail(
      `${input.description} failed`,
      `The ${agentName} subagent failed: ${(error as Error).message}\n\nYou can retry with a more specific prompt, or do the work directly.`,
    )
  }

  const durationMs = Date.now() - started

  Bus.publish(Events.taskCompleted, {
    id: taskId,
    parentSessionId: context.sessionId,
    agent: agentName,
    toolCalls: result.toolCalls,
    cost: result.cost,
    durationMs,
  })

  context.metadata({
    taskId,
    status: result.aborted ? "aborted" : "done",
    toolCalls: result.toolCalls,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cost: result.cost,
    durationMs,
    sessionId: result.sessionId,
  })

  if (result.aborted) {
    return fail(
      `${input.description} interrupted`,
      [
        "The subagent was interrupted before it finished.",
        result.text ? `\nWhat it had found so far:\n\n${result.text}` : "",
      ].join(""),
      { aborted: true },
    )
  }

  if (result.error) {
    return fail(`${input.description} failed`, result.error, { error: result.error })
  }

  if (result.text.trim() === "") {
    return fail(
      `${input.description} returned nothing`,
      `The ${agentName} subagent finished without producing a summary after ${result.toolCalls} tool calls. Its prompt may have been too open-ended. Retry with a prompt that states exactly what to report.`,
      { toolCalls: result.toolCalls },
    )
  }

  // The footer gives the model a sense of how expensive the delegation was, which
  // measurably shifts its behaviour towards fewer, better-scoped subagent calls.
  const footer: string[] = []
  if (result.filesChanged.length > 0) {
    footer.push(
      `Files changed by the subagent: ${result.filesChanged.slice(0, 12).join(", ")}${result.filesChanged.length > 12 ? `, and ${result.filesChanged.length - 12} more` : ""}.`,
    )
  }
  footer.push(
    `(${agentName} used ${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"} and ${formatTokens(result.inputTokens + result.outputTokens)} tokens in ${(durationMs / 1000).toFixed(1)}s.)`,
  )

  return ok(
    `${input.description} (${agentName})`,
    `${result.text}\n\n${footer.join("\n")}`,
    {
      agent: agentName,
      toolCalls: result.toolCalls,
      cost: result.cost,
      filesChanged: result.filesChanged.length,
    },
  )
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/* ------------------------------------------------------------------ */
/* batch                                                               */
/* ------------------------------------------------------------------ */

const batchParameters = s.object({
  description: s.string().describe("A short summary of what this batch does."),
  invocations: s
    .array(
      s.object({
        tool: s.string().describe("Name of the tool to call."),
        input: s.record(s.unknown()).describe("Arguments for that tool."),
      }),
    )
    .describe("Tool calls to run. Independent calls run in parallel."),
})

type BatchInput = {
  description: string
  invocations: Array<{ tool: string; input: Record<string, unknown> }>
}

/** Maximum calls in one batch. Beyond this the results stop fitting usefully. */
const BATCH_LIMIT = 25

const BATCH_DESCRIPTION = `Run several tool calls in one request.

Use this when you need multiple independent pieces of information and already know exactly what to ask for. Six greps and four reads in one batch is one round trip instead of ten, and the latency difference on a real task is substantial.

Good uses:
- Read several files you have already located.
- Run several different searches at once.
- Combine a glob with the greps that depend on nothing but the pattern.

Do not use it for:
- Calls where one depends on another's output. Batching those does not work; the second call cannot see the first's result.
- Write or edit operations. Those need to be sequenced and reviewed individually.
- A single call. Just make the call.

Each result is labelled with its index so you can match results to requests. A failure in one call does not stop the others.`

export const batchTool = defineTool<BatchInput>({
  id: "batch",
  concurrent: true,
  init: () => ({
    description: BATCH_DESCRIPTION,
    parameters: batchParameters as never,
    execute: async (input, context) => {
      if (!Array.isArray(input.invocations) || input.invocations.length === 0) {
        return fail("batch", "No invocations were provided.")
      }
      if (input.invocations.length > BATCH_LIMIT) {
        return fail(
          "batch",
          `A batch may contain at most ${BATCH_LIMIT} calls; you sent ${input.invocations.length}. Split it.`,
        )
      }
      if (!context.invoke) {
        return fail("batch", "Nested tool invocation is not available in this context.")
      }

      // Batching a batch would let the model build an unbounded tree in one call.
      const nested = input.invocations.find((entry) => entry.tool === "batch")
      if (nested) {
        return fail("batch", "A batch cannot contain another batch.")
      }

      context.metadata({ count: input.invocations.length, description: input.description })

      const settled = await Promise.allSettled(
        input.invocations.map(async (invocation, index) => {
          const result = await context.invoke!(invocation.tool, invocation.input)
          return { index, invocation, result }
        }),
      )

      const sections: string[] = []
      let failures = 0

      for (const [index, entry] of settled.entries()) {
        const invocation = input.invocations[index]!
        if (entry.status === "rejected") {
          failures++
          sections.push(
            `### ${index + 1}. ${invocation.tool} — failed\n${String(
              (entry.reason as Error)?.message ?? entry.reason,
            )}`,
          )
          continue
        }
        const result = entry.value.result
        if (result.isError) failures++
        sections.push(
          `### ${index + 1}. ${invocation.tool} — ${result.title}\n${result.output}`,
        )
      }

      const header = `${input.invocations.length} call${input.invocations.length === 1 ? "" : "s"}, ${input.invocations.length - failures} succeeded${failures > 0 ? `, ${failures} failed` : ""}.`

      return ok(
        `${input.description} (${input.invocations.length} calls)`,
        `${header}\n\n${sections.join("\n\n")}`,
        { count: input.invocations.length, failures },
      )
    },
  }),
})

/* ------------------------------------------------------------------ */
/* question                                                            */
/* ------------------------------------------------------------------ */

const questionParameters = s.object({
  question: s.string().describe("The question, phrased so it can be answered in a sentence."),
  options: s
    .array(s.string())
    .optional()
    .describe("Concrete choices, if the answer is a choice. Two to five options."),
  context: s
    .string()
    .optional()
    .describe("Why you are asking and what you will do with each answer."),
})

type QuestionInput = { question: string; options?: string[]; context?: string }

export type QuestionHandler = (
  request: QuestionInput & { sessionId: string },
  signal: AbortSignal,
) => Promise<string>

let questionHandler: QuestionHandler | undefined

export function setQuestionHandler(handler: QuestionHandler): void {
  questionHandler = handler
}

const QUESTION_DESCRIPTION = `Ask the user a question and wait for the answer.

Use this sparingly. Most of the time you should investigate and decide, then say what you did — an agent that asks about every fork is exhausting to work with.

Ask when:
- The task is genuinely ambiguous in a way that changes the outcome, and guessing wrong means throwing away real work.
- You need a credential, a value, or a decision only the user has.
- You are about to do something destructive and irreversible that they may not have intended.

Do not ask:
- For permission to run a tool. The permission system handles that.
- To confirm something you can verify by reading the code.
- About style or naming when the codebase already answers it.

Provide options when the answer is a choice; it is much faster for the user than free text. Explain in context what you will do with each answer, so the decision is informed.`

export const questionTool = defineTool<QuestionInput>({
  id: "question",
  init: () => ({
    description: QUESTION_DESCRIPTION,
    parameters: questionParameters as never,
    execute: async (input, context) => {
      if (!questionHandler) {
        return fail(
          "question",
          "There is no interactive user in this run, so questions cannot be answered. Make a reasonable decision, state the assumption you made, and continue.",
        )
      }

      context.metadata({ question: input.question, options: input.options })

      Bus.publish(Events.questionAsked, {
        sessionId: context.sessionId,
        question: input.question,
        options: input.options,
      })

      const answer = await questionHandler(
        { ...input, sessionId: context.sessionId },
        context.signal,
      )

      if (answer.trim() === "") {
        return ok(
          "no answer",
          "The user did not answer. Proceed with your best judgement and say which assumption you made.",
        )
      }

      return ok(`answered: ${truncate(answer, 60)}`, `The user answered: ${answer}`, { answer })
    },
  }),
})
