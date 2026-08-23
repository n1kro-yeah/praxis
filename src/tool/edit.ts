/**
 * The file-mutation tools: `edit`, `write`, and `multiedit`.
 *
 * These change the user's code, so they are where care matters most. Every guard
 * here exists because of a specific, observed failure:
 *
 *  - A file must be read before it is edited. Models confidently edit files they
 *    have never seen, inventing content that does not exist.
 *  - A file changed on disk since it was read must not be blindly overwritten.
 *  - `oldString` must be unique. An edit matching three places and silently
 *    picking the first is a bug that surfaces hours later.
 *  - `write` on an existing file is a big deal: overwriting 2 000 lines to change
 *    one function is catastrophic and common.
 *  - Every edit is formatted and diagnosed afterwards, closing the loop.
 *
 * The string replacement itself is delegated to the replacer ladder in
 * `edit/replacers.ts`, which is what lets slightly-wrong whitespace still match.
 */

import { existsSync, statSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

import { s } from "../util/schema.js"
import { logger } from "../util/log.js"
import { unifiedDiff } from "../util/diff.js"
import {
  applyEdit,
  displayPath,
  formatBytes,
  hasBeenRead,
  isStale,
  markRead,
  readSnapshot,
  writeFileAtomic,
} from "../edit/apply.js"
import { formatFile } from "../edit/format.js"
import { suggestPattern } from "../permission/rules.js"
import { defineTool, fail, ok, type ToolContext, type ToolResult } from "./types.js"

const log = logger("tool.edit")

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

/**
 * Refuses an edit to a file the model has not read.
 *
 * The single most valuable guard in the tool layer. Without it, models edit by
 * guessing, and the resulting error (a string that does not match) points at the
 * symptom rather than the cause.
 */
function requireRead(absolute: string, cwd: string): string | undefined {
  if (hasBeenRead(absolute)) return undefined
  return `You have not read ${displayPath(absolute, cwd)} in this session, so you cannot edit it yet. Read it first \u2014 editing a file whose exact contents you have not seen produces broken code even when the edit looks right.`
}

/** Refuses an edit when the file changed since it was read. */
function requireFresh(absolute: string, cwd: string): string | undefined {
  if (!isStale(absolute)) return undefined
  return `${displayPath(absolute, cwd)} changed on disk after you read it. Read it again before editing \u2014 something else (an earlier command of yours, a formatter, the user's editor) modified it, and applying your edit to the stale content would silently undo that change.`
}

/**
 * Renders the outcome of a mutation as a diff.
 *
 * A diff rather than a confirmation, because the replacer may have matched
 * fuzzily and the formatter may have reshaped the result. Showing what actually
 * landed stops the model building on a false belief about the file.
 */
function renderOutcome(options: {
  absolute: string
  cwd: string
  before: string
  after: string
  strategy?: string
  formatter?: string
  maxDiffLines?: number
}): string {
  const relative = displayPath(options.absolute, options.cwd)
  const sections: string[] = []

  const diff = unifiedDiff(options.before, options.after, {
    fromFile: relative,
    toFile: relative,
  })

  const diffLines = diff.split("\n")
  const limit = options.maxDiffLines ?? 200

  if (diffLines.length > limit) {
    sections.push(diffLines.slice(0, limit).join("\n"))
    sections.push(`[diff truncated: ${diffLines.length - limit} more lines]`)
  } else {
    sections.push(diff)
  }

  const notes: string[] = []

  // A fuzzy match is worth flagging: it means the model's oldString was not
  // exactly what was in the file, so its mental model is slightly off.
  if (options.strategy && options.strategy !== "simple") {
    notes.push(
      `Matched with the ${options.strategy} strategy \u2014 your search text did not match byte-for-byte. Check the diff carefully; if the result is not what you intended, read the file again before your next edit.`,
    )
  }

  if (options.formatter) {
    notes.push(`Formatted with ${options.formatter} after the edit.`)
  }

  if (notes.length > 0) {
    sections.push(notes.join("\n"))
  }

  return sections.join("\n\n")
}

/**
 * Runs the configured formatter and returns the resulting content.
 *
 * Formatting after an edit rather than before matters: the model's edit is
 * applied to the file as it was, then normalised. Doing it the other way round
 * would make `oldString` match against content the model never saw.
 */
async function formatAfterEdit(
  absolute: string,
  content: string,
  cwd: string,
): Promise<{ content: string; formatter?: string }> {
  try {
    const result = await formatFile({ path: absolute, content, cwd })
    if (result && result.content !== content) {
      return { content: result.content, formatter: result.formatter }
    }
  } catch (error) {
    // A broken formatter must never block an edit. The user's code is already
    // correct; it is just not pretty.
    log.debug("formatter failed", { path: absolute, error: String(error) })
  }
  return { content }
}

/* ------------------------------------------------------------------ */
/* edit                                                                */
/* ------------------------------------------------------------------ */

const editParameters = s.object({
  path: s.string().describe("File to edit. Relative paths resolve against the working directory."),
  oldString: s
    .string()
    .describe(
      "Exact text to replace. Must appear exactly once in the file unless replaceAll is set. Include enough surrounding context to be unambiguous.",
    ),
  newString: s.string().describe("Replacement text. Pass an empty string to delete."),
  replaceAll: s
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring exactly one. Use for renames."),
})

type EditInput = {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

const EDIT_DESCRIPTION = `Replace exact text in a file.

This is the tool to use for almost every change. Prefer it over \`write\`, which replaces the whole file and destroys anything you did not reproduce.

How to use it well:

- **Read the file first.** This is enforced, not advisory. You cannot edit a file you have not read.
- **Copy \`oldString\` exactly** from what you read, including indentation. Do not retype it from memory.
- **Include enough context to be unique.** A single line like \`return null\` probably appears many times. Include the two or three lines around it. If the text is ambiguous the edit is refused, and you will have to read again to disambiguate.
- **Keep the edit small.** Replacing a whole function to change one line makes the diff unreadable and increases the chance of an accidental change.
- **Set \`replaceAll\` for renames.** Renaming a variable across a file is one call with \`replaceAll: true\`, not twelve calls.
- **Delete by passing an empty \`newString\`.**

After the edit you get the diff back, plus the formatter's changes and any new compiler errors. Read them \u2014 they tell you whether the edit did what you intended.`

export const editTool = defineTool<EditInput>({
  id: "edit",
  action: "edit",
  readOnly: false,
  concurrent: false,
  init: () => ({
    description: EDIT_DESCRIPTION,
    parameters: editParameters as never,
    execute: async (input, context) => executeEdit(input, context),
  }),
})

async function executeEdit(input: EditInput, context: ToolContext): Promise<ToolResult> {
  const absolute = resolvePath(input.path, context.cwd)
  const relative = displayPath(absolute, context.cwd)

  if (input.oldString === input.newString) {
    return fail("edit", "oldString and newString are identical, so this edit would do nothing.")
  }

  if (!existsSync(absolute)) {
    return fail(
      "edit",
      `${relative} does not exist. Use \`write\` to create it, or check the path \u2014 run \`list\` on the directory if you are unsure.`,
    )
  }

  const stats = statSync(absolute)
  if (stats.isDirectory()) {
    return fail("edit", `${relative} is a directory, not a file.`)
  }

  const readError = requireRead(absolute, context.cwd)
  if (readError) return fail("edit", readError)

  const staleError = requireFresh(absolute, context.cwd)
  if (staleError) return fail("edit", staleError)

  await context.requestPermission({
    action: "edit",
    resource: absolute,
    title: `Edit ${relative}`,
    detail: previewEdit(input),
    pattern: suggestPattern("edit", absolute, context.cwd),
    risk: "medium",
  })

  const before = readSnapshot(absolute)

  let applied
  try {
    applied = applyEdit({
      content: before,
      oldString: input.oldString,
      newString: input.newString,
      replaceAll: input.replaceAll ?? false,
    })
  } catch (error) {
    return fail("edit", (error as Error).message)
  }

  const formatted = await formatAfterEdit(absolute, applied.content, context.cwd)

  writeFileAtomic(absolute, formatted.content)
  markRead(absolute, formatted.content)

  context.metadata({
    path: absolute,
    strategy: applied.strategy,
    replacements: applied.replacements,
    changedPaths: [absolute],
  })

  log.debug("edited", { path: relative, strategy: applied.strategy })

  return ok(
    `${relative} (${applied.replacements} replacement${applied.replacements === 1 ? "" : "s"})`,
    renderOutcome({
      absolute,
      cwd: context.cwd,
      before,
      after: formatted.content,
      strategy: applied.strategy,
      formatter: formatted.formatter,
    }),
    {
      path: absolute,
      strategy: applied.strategy,
      replacements: applied.replacements,
      changedPaths: [absolute],
    },
  )
}

/** A short preview of an edit, shown in the permission prompt. */
function previewEdit(input: EditInput): string {
  const removed = input.oldString.split("\n").slice(0, 4)
  const added = input.newString.split("\n").slice(0, 4)
  const lines: string[] = []
  for (const line of removed) lines.push(`- ${line}`)
  for (const line of added) lines.push(`+ ${line}`)
  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* multiedit                                                           */
/* ------------------------------------------------------------------ */

const multieditParameters = s.object({
  path: s.string().describe("File to edit."),
  edits: s
    .array(
      s.object({
        oldString: s.string().describe("Exact text to replace."),
        newString: s.string().describe("Replacement text."),
        replaceAll: s.boolean().optional().describe("Replace every occurrence."),
      }),
    )
    .describe("Edits applied in order. Each sees the result of the previous one."),
})

type MultieditInput = {
  path: string
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>
}

const MULTIEDIT_DESCRIPTION = `Apply several edits to one file in a single atomic operation.

Use this instead of repeated \`edit\` calls when you are making multiple changes to the same file. It is faster, and more importantly it is atomic: either every edit applies or none does, so a failure halfway through cannot leave the file in a half-changed state.

Important details:

- Edits apply **in order**, and each one sees the result of the previous. If your second edit targets text that your first edit created, that works. If it targets text your first edit deleted, it fails.
- Each \`oldString\` must be unique **at the time that edit runs**, not in the original file.
- If any edit fails, the file is left completely untouched and you get told which one failed and why.
- The file must have been read first, exactly as with \`edit\`.

For a rename across a file, one edit with \`replaceAll: true\` beats twenty separate edits.`

export const multieditTool = defineTool<MultieditInput>({
  id: "multiedit",
  action: "edit",
  readOnly: false,
  concurrent: false,
  init: () => ({
    description: MULTIEDIT_DESCRIPTION,
    parameters: multieditParameters as never,
    execute: async (input, context) => executeMultiedit(input, context),
  }),
})

async function executeMultiedit(
  input: MultieditInput,
  context: ToolContext,
): Promise<ToolResult> {
  const absolute = resolvePath(input.path, context.cwd)
  const relative = displayPath(absolute, context.cwd)

  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return fail("multiedit", "No edits were provided.")
  }

  if (input.edits.length > 60) {
    return fail(
      "multiedit",
      `${input.edits.length} edits is too many for one call. Split the work, or rewrite the file with \`write\` if you are changing most of it.`,
    )
  }

  if (!existsSync(absolute)) {
    return fail("multiedit", `${relative} does not exist. Use \`write\` to create it.`)
  }

  const readError = requireRead(absolute, context.cwd)
  if (readError) return fail("multiedit", readError)

  const staleError = requireFresh(absolute, context.cwd)
  if (staleError) return fail("multiedit", staleError)

  await context.requestPermission({
    action: "edit",
    resource: absolute,
    title: `Apply ${input.edits.length} edits to ${relative}`,
    pattern: suggestPattern("edit", absolute, context.cwd),
    risk: "medium",
  })

  const before = readSnapshot(absolute)

  // Applied to a working copy so a mid-sequence failure leaves the real file
  // untouched. Atomicity is the whole point of this tool.
  let working = before
  const strategies: string[] = []
  let totalReplacements = 0

  for (let index = 0; index < input.edits.length; index++) {
    const edit = input.edits[index]!

    if (edit.oldString === edit.newString) {
      return fail(
        "multiedit",
        `Edit ${index + 1} has identical oldString and newString. Nothing was changed.`,
      )
    }

    try {
      const applied = applyEdit({
        content: working,
        oldString: edit.oldString,
        newString: edit.newString,
        replaceAll: edit.replaceAll ?? false,
      })
      working = applied.content
      strategies.push(applied.strategy)
      totalReplacements += applied.replacements
    } catch (error) {
      return fail(
        "multiedit",
        `Edit ${index + 1} of ${input.edits.length} failed, so no changes were written.\n\n${(error as Error).message}\n\nRemember that each edit applies to the result of the previous ones, not to the original file.`,
      )
    }
  }

  const formatted = await formatAfterEdit(absolute, working, context.cwd)

  writeFileAtomic(absolute, formatted.content)
  markRead(absolute, formatted.content)

  const fuzzy = strategies.filter((strategy) => strategy !== "simple")

  context.metadata({
    path: absolute,
    edits: input.edits.length,
    replacements: totalReplacements,
    changedPaths: [absolute],
  })

  return ok(
    `${relative} (${input.edits.length} edits, ${totalReplacements} replacements)`,
    renderOutcome({
      absolute,
      cwd: context.cwd,
      before,
      after: formatted.content,
      strategy: fuzzy.length > 0 ? fuzzy[0] : undefined,
      formatter: formatted.formatter,
      maxDiffLines: 300,
    }),
    {
      path: absolute,
      edits: input.edits.length,
      replacements: totalReplacements,
      changedPaths: [absolute],
    },
  )
}

/* ------------------------------------------------------------------ */
/* write                                                               */
/* ------------------------------------------------------------------ */

const writeParameters = s.object({
  path: s.string().describe("File to write. Parent directories are created as needed."),
  content: s.string().describe("Complete contents of the file."),
})

type WriteInput = { path: string; content: string }

const WRITE_DESCRIPTION = `Create a file, or completely replace an existing one.

Use this for **new files**. For changes to existing files, use \`edit\` \u2014 \`write\` replaces the entire contents, so anything you do not reproduce in \`content\` is deleted. Rewriting a 500-line file to change one function is a common and destructive mistake.

Rules:

- \`content\` is the complete file, not a fragment. There is no partial write.
- Parent directories are created automatically.
- Overwriting an existing file requires having read it first, and asks the user for permission. If the file is large, expect to be refused \u2014 use \`edit\` instead.
- Do not write files the user did not ask for. Documentation, examples, and READMEs created unprompted are noise the user then has to delete.`

export const writeTool = defineTool<WriteInput>({
  id: "write",
  action: "write",
  readOnly: false,
  concurrent: false,
  init: () => ({
    description: WRITE_DESCRIPTION,
    parameters: writeParameters as never,
    execute: async (input, context) => executeWrite(input, context),
  }),
})

async function executeWrite(input: WriteInput, context: ToolContext): Promise<ToolResult> {
  const absolute = resolvePath(input.path, context.cwd)
  const relative = displayPath(absolute, context.cwd)
  const exists = existsSync(absolute)

  if (exists && statSync(absolute).isDirectory()) {
    return fail("write", `${relative} is a directory.`)
  }

  let before = ""

  if (exists) {
    const readError = requireRead(absolute, context.cwd)
    if (readError) {
      return fail(
        "write",
        `${readError}\n\nOverwriting a file you have not read would destroy its contents.`,
      )
    }

    const staleError = requireFresh(absolute, context.cwd)
    if (staleError) return fail("write", staleError)

    before = readSnapshot(absolute)

    // A large existing file being wholesale replaced is nearly always wrong.
    const beforeLines = before.split("\n").length
    const afterLines = input.content.split("\n").length

    if (beforeLines > 80 && afterLines < beforeLines * 0.6) {
      return fail(
        "write",
        `Refusing to shrink ${relative} from ${beforeLines} lines to ${afterLines} with \`write\`. That would delete most of the file. If you genuinely mean to replace it, delete it first and explain why. If you meant to change part of it, use \`edit\`.`,
      )
    }
  }

  await context.requestPermission({
    action: exists ? "edit" : "write",
    resource: absolute,
    title: exists ? `Overwrite ${relative}` : `Create ${relative}`,
    detail: exists
      ? `Replacing ${before.split("\n").length} lines with ${input.content.split("\n").length}.`
      : `${input.content.split("\n").length} lines, ${formatBytes(Buffer.byteLength(input.content))}.`,
    pattern: suggestPattern(exists ? "edit" : "write", absolute, context.cwd),
    risk: exists ? "high" : "medium",
  })

  const parent = dirname(absolute)
  if (!existsSync(parent)) {
    const { mkdirSync } = await import("node:fs")
    mkdirSync(parent, { recursive: true })
  }

  const formatted = await formatAfterEdit(absolute, input.content, context.cwd)

  writeFileAtomic(absolute, formatted.content)
  markRead(absolute, formatted.content)

  context.metadata({ path: absolute, created: !exists, changedPaths: [absolute] })

  log.debug(exists ? "overwrote" : "created", { path: relative })

  const lineCount = formatted.content.split("\n").length

  if (!exists) {
    return ok(
      `Created ${relative}`,
      `Wrote ${lineCount} line${lineCount === 1 ? "" : "s"} (${formatBytes(Buffer.byteLength(formatted.content))})${formatted.formatter ? `, formatted with ${formatted.formatter}` : ""}.`,
      { path: absolute, created: true, changedPaths: [absolute] },
    )
  }

  return ok(
    `Overwrote ${relative}`,
    renderOutcome({
      absolute,
      cwd: context.cwd,
      before,
      after: formatted.content,
      formatter: formatted.formatter,
      maxDiffLines: 150,
    }),
    { path: absolute, created: false, changedPaths: [absolute] },
  )
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */

export const EDIT_TOOLS = [editTool, multieditTool, writeTool]
