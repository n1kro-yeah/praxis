/**
 * The question tool.
 *
 * Lets the model ask the user something and wait for an answer. It exists
 * because the alternative behaviours are both bad: a model that guesses when it is
 * genuinely uncertain produces work that has to be thrown away, and a model that
 * stops mid-task to write \u201cwhich would you prefer?\u201d into its response has ended its
 * turn, so the user has to answer and then say \u201ccarry on\u201d.
 *
 * A tool call solves this cleanly. The turn stays open, the user picks an option,
 * the answer arrives as the tool result, and the model continues with the context
 * it was missing.
 *
 * The design pressure is entirely in the other direction, though. A model with a
 * way to ask questions asks too many, and being interrupted four times to confirm
 * things that were already obvious is worse than a wrong guess that can be
 * corrected in one sentence. So the description spends most of its length on when
 * *not* to use this, and the implementation enforces a per-session budget.
 */

import { defineTool, ok, fail, type ToolContext } from "./types.js"
import { s } from "../util/schema.js"
import { logger } from "../util/log.js"
import { Bus } from "../util/bus.js"
import { newId } from "../util/id.js"

const log = logger("tool.question")

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * Questions allowed per session.
 *
 * Beyond this the tool refuses and tells the model to proceed on its best
 * judgement. Six is generous for a genuinely ambiguous task and restrictive enough
 * to stop a model that has settled into asking rather than deciding.
 */
const MAX_PER_SESSION = 6

/** Options per question. */
const MAX_OPTIONS = 5

/** Questions in one call. */
const MAX_QUESTIONS = 3

/** Characters in a question. */
const MAX_QUESTION_LENGTH = 400

/** Characters in an option label. */
const MAX_LABEL_LENGTH = 120

/**
 * How long to wait for an answer.
 *
 * Fifteen minutes. Long enough that stepping away from the terminal does not
 * lose the work; short enough that an unattended run eventually finishes rather
 * than holding a process open forever.
 */
const ANSWER_TIMEOUT_MS = 15 * 60 * 1000

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface QuestionOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
}

export interface PendingQuestion {
  readonly id: string
  readonly sessionId: string
  readonly header?: string
  readonly question: string
  readonly options: readonly QuestionOption[]
  readonly allowMultiple: boolean
  readonly allowFreeform: boolean
  readonly askedAt: number
}

export interface QuestionAnswer {
  readonly questionId: string
  /** Ids of chosen options. */
  readonly selected: readonly string[]
  /** Text the user typed instead of, or in addition to, choosing. */
  readonly freeform?: string
  /** True when the user dismissed rather than answered. */
  readonly cancelled?: boolean
}

/** How the host collects an answer. */
export type QuestionAsker = (question: PendingQuestion) => Promise<QuestionAnswer>

/* ------------------------------------------------------------------ */
/* Host wiring                                                         */
/* ------------------------------------------------------------------ */

let asker: QuestionAsker | undefined

/**
 * Installs the answer collector.
 *
 * The TUI installs a dialog; the HTTP server installs something that suspends
 * the run and waits for a client to post an answer. Without one, the tool refuses
 * rather than hanging \u2014 in a non-interactive run there is nobody to answer, and a
 * process blocked forever on a question is much worse than one that reports it
 * could not ask.
 */
export function setQuestionAsker(next: QuestionAsker | undefined): void {
  asker = next
}

export function hasQuestionAsker(): boolean {
  return asker !== undefined
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

const asked = new Map<string, number>()

function count(sessionId: string): number {
  return asked.get(sessionId) ?? 0
}

function record(sessionId: string): void {
  asked.set(sessionId, count(sessionId) + 1)
}

export function resetQuestionBudget(sessionId?: string): void {
  if (sessionId) asked.delete(sessionId)
  else asked.clear()
}

/* ------------------------------------------------------------------ */
/* Pending registry                                                    */
/* ------------------------------------------------------------------ */

const pending = new Map<string, PendingQuestion>()

/** Questions currently waiting, for a client that connects mid-question. */
export function pendingQuestions(sessionId?: string): PendingQuestion[] {
  const all = [...pending.values()]

  return sessionId ? all.filter((question) => question.sessionId === sessionId) : all
}

/* ------------------------------------------------------------------ */
/* Description                                                         */
/* ------------------------------------------------------------------ */

const DESCRIPTION = `Ask the user a question and wait for the answer.

Use this when you genuinely cannot proceed without a decision only the user can make, and the choices are concrete enough to list.

Worth asking about:
- Which of several valid approaches to take, when they lead somewhere different and undoing the wrong one is expensive
- Ambiguity in the request that changes what you build, not just how
- Missing information you cannot find in the codebase \u2014 a value, a name, an external constraint
- Confirmation before something with consequences the user may not have considered

Do not use this for:
- Anything you can determine by reading the code. Read it.
- Permission to run a tool. Permissions are handled separately; just make the call.
- Style, naming, and formatting. Follow what the codebase already does.
- Confirming you understood the request. Start working; being wrong is cheap to correct.
- Reporting progress or asking whether to continue. Continue.

One question is nearly always enough. Ask several only when they are genuinely independent \u2014 answering one should not change the others.

Write options the user can choose between without further explanation. "Option A" and "Option B" are not choices; "Store it in SQLite" and "Keep it in memory and lose it on restart" are.

If you can proceed on a sensible default and mention the assumption afterwards, do that instead. It is faster for the user and easier to correct.`

/* ------------------------------------------------------------------ */
/* Tool                                                                */
/* ------------------------------------------------------------------ */

export const questionTool = defineTool({
  id: "question",
  action: "question",
  readOnly: true,
  // Never run alongside anything else. Two dialogs competing for the terminal
  // is a mess, and a question asked while a build is running gets answered
  // against a state that has already changed.
  concurrent: false,

  init: () => ({
    description: DESCRIPTION,

    parameters: s.object({
      header: s
        .string()
        .optional()
        .describe("Short label shown above the question, naming what the decision is about"),

      questions: s
        .array(
          s.object({
            question: s.string().describe("The question, as one clear sentence"),
            options: s
              .array(
                s.object({
                  label: s.string().describe("A concrete choice the user can act on directly"),
                  detail: s.string().optional().describe("One line of consequence or trade-off"),
                }),
              )
              .describe(`Between 2 and ${MAX_OPTIONS} options`),
            allowMultiple: s.boolean().optional().describe("Allow choosing more than one option"),
            allowFreeform: s
              .boolean()
              .optional()
              .describe("Allow typing an answer instead of choosing. Defaults to true."),
          }),
        )
        .describe(`Between 1 and ${MAX_QUESTIONS} questions`),
    }),

    async execute(
      input: {
        header?: string
        questions: Array<{
          question: string
          options: Array<{ label: string; detail?: string }>
          allowMultiple?: boolean
          allowFreeform?: boolean
        }>
      },
      context: ToolContext,
    ) {
      if (!asker) {
        return fail(
          "There is nobody to answer \u2014 this session is not interactive. Choose the most reasonable option, proceed, and state the assumption you made.",
        )
      }

      const sessionId = context.sessionId ?? "default"

      if (count(sessionId) >= MAX_PER_SESSION) {
        return fail(
          `You have already asked ${MAX_PER_SESSION} questions in this session, which is the limit. Decide on your best judgement, proceed, and say what you assumed.`,
        )
      }

      const questions = input.questions ?? []

      if (questions.length === 0) return fail("No questions were provided.")

      if (questions.length > MAX_QUESTIONS) {
        return fail(
          `${questions.length} questions is too many. Ask at most ${MAX_QUESTIONS}, and prefer one. Work out what the single blocking decision is.`,
        )
      }

      // Validate everything before asking anything. Presenting the first
      // question and then failing on the second leaves the user having answered
      // something that is about to be discarded.
      const prepared: PendingQuestion[] = []

      for (const item of questions) {
        const text = (item.question ?? "").trim()

        if (text === "") return fail("A question is empty.")

        if (text.length > MAX_QUESTION_LENGTH) {
          return fail(`A question is ${text.length} characters. Keep it under ${MAX_QUESTION_LENGTH}.`)
        }

        const options = item.options ?? []

        if (options.length < 2) {
          return fail(
            `"${truncateLabel(text)}" has ${options.length} option${options.length === 1 ? "" : "s"}. A question with fewer than two choices is not a question \u2014 if there is only one way forward, take it.`,
          )
        }

        if (options.length > MAX_OPTIONS) {
          return fail(
            `"${truncateLabel(text)}" has ${options.length} options; the limit is ${MAX_OPTIONS}. Narrow it to the choices that actually differ.`,
          )
        }

        const labels = new Set<string>()
        const resolved: QuestionOption[] = []

        for (const option of options) {
          const label = (option.label ?? "").trim()

          if (label === "") return fail("An option has no label.")

          if (label.length > MAX_LABEL_LENGTH) {
            return fail(`The option "${truncateLabel(label)}" is too long. Keep labels under ${MAX_LABEL_LENGTH} characters.`)
          }

          const key = label.toLowerCase()

          if (labels.has(key)) return fail(`"${label}" appears twice as an option.`)

          labels.add(key)

          // Catch-all options duplicate the free-text box, which is always
          // available unless explicitly disabled.
          if (/^(other|custom|something else|none of (these|the above)|let me (specify|describe))$/i.test(label)) {
            return fail(
              `Drop the "${label}" option \u2014 the user can always type an answer instead of choosing one. List only concrete alternatives.`,
            )
          }

          resolved.push({
            id: newId("prompt"),
            label,
            detail: option.detail?.trim() || undefined,
          })
        }

        prepared.push({
          id: newId("prompt"),
          sessionId,
          header: input.header?.trim() || undefined,
          question: text,
          options: resolved,
          allowMultiple: item.allowMultiple ?? false,
          allowFreeform: item.allowFreeform ?? true,
          askedAt: Date.now(),
        })
      }

      record(sessionId)

      const answers: Array<{ question: PendingQuestion; answer: QuestionAnswer }> = []

      for (const question of prepared) {
        pending.set(question.id, question)

        Bus.publish("questionAsked", {
          sessionId,
          questionId: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
        })

        log.info("asking the user a question", { sessionId, question: question.question })

        try {
          const answer = await withTimeout(asker(question), ANSWER_TIMEOUT_MS, question)

          if (answer.cancelled) {
            // Dismissal is a real signal: the user does not want to engage with
            // this. Continuing to ask the remaining questions would be rude and
            // is almost certainly not wanted.
            Bus.publish("questionAnswered", { sessionId, questionId: question.id, cancelled: true })

            return ok(
              "The user dismissed the question without answering. Proceed on your best judgement and say what you decided.",
              { title: "Dismissed", metadata: { cancelled: true } },
            )
          }

          answers.push({ question, answer })

          Bus.publish("questionAnswered", {
            sessionId,
            questionId: question.id,
            selected: answer.selected,
            freeform: answer.freeform,
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)

          log.warn("the question was not answered", { questionId: question.id, error: detail })

          return fail(`No answer came back: ${detail}. Proceed on your best judgement.`)
        } finally {
          pending.delete(question.id)
        }
      }

      return ok(render(answers), {
        title: prepared.length === 1 ? truncateLabel(prepared[0]!.question, 60) : `${prepared.length} questions`,
        metadata: {
          questions: prepared.length,
          remaining: MAX_PER_SESSION - count(sessionId),
        },
      })
    },
  }),
})

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Formats answers as the tool result.
 *
 * The question is repeated alongside its answer. It costs a few tokens and it
 * removes an entire class of failure where a model, several turns later, remembers
 * that the user said \u201cSQLite\u201d but not what was being asked.
 */
function render(answers: Array<{ question: PendingQuestion; answer: QuestionAnswer }>): string {
  const lines: string[] = []

  for (const { question, answer } of answers) {
    lines.push(`Q: ${question.question}`)

    const chosen = question.options
      .filter((option) => answer.selected.includes(option.id))
      .map((option) => option.label)

    if (chosen.length > 0) lines.push(`A: ${chosen.join(", ")}`)

    if (answer.freeform?.trim()) {
      // Marked separately: text the user typed is a stronger and more specific
      // signal than a chosen option, and should not be flattened into one.
      lines.push(chosen.length > 0 ? `   The user added: ${answer.freeform.trim()}` : `A: ${answer.freeform.trim()}`)
    }

    if (chosen.length === 0 && !answer.freeform?.trim()) {
      lines.push("A: (no answer)")
    }

    lines.push("")
  }

  lines.push("Continue with this. Do not ask again about the same thing.")

  return lines.join("\n")
}

function truncateLabel(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`
}

/**
 * Races a promise against a timeout.
 *
 * The timer is unreferenced so a pending question never holds the process open
 * on its own \u2014 relevant when the run is otherwise finished and only this is
 * outstanding.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, question: PendingQuestion): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no answer within ${Math.round(ms / 60000)} minutes`))
    }, ms)

    timer.unref?.()

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        log.debug("the asker rejected", { questionId: question.id })
        reject(error)
      },
    )
  })
}

/* ------------------------------------------------------------------ */
/* Convenience                                                         */
/* ------------------------------------------------------------------ */

/**
 * Asks a yes-or-no question directly.
 *
 * For internal callers \u2014 a migration, a destructive operation \u2014 rather than the
 * model. Returns the default when nothing can ask, which keeps non-interactive
 * runs working instead of failing at the first confirmation.
 */
export async function confirm(
  sessionId: string,
  question: string,
  options: { yes?: string; no?: string; fallback?: boolean } = {},
): Promise<boolean> {
  if (!asker) return options.fallback ?? false

  const yesId = newId("prompt")
  const noId = newId("prompt")

  const prompt: PendingQuestion = {
    id: newId("prompt"),
    sessionId,
    question,
    options: [
      { id: yesId, label: options.yes ?? "Yes" },
      { id: noId, label: options.no ?? "No" },
    ],
    allowMultiple: false,
    allowFreeform: false,
    askedAt: Date.now(),
  }

  try {
    const answer = await withTimeout(asker(prompt), ANSWER_TIMEOUT_MS, prompt)

    if (answer.cancelled) return options.fallback ?? false

    return answer.selected.includes(yesId)
  } catch {
    return options.fallback ?? false
  }
}
