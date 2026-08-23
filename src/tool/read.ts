/**
 * The `read`, `write`, `edit`, `multiedit`, and `apply_patch` tools.
 *
 * Grouped in one module because they share the read-registry and formatter
 * plumbing, and because their descriptions have to be written against each other
 * — the model's choice between `edit` and `write` is driven almost entirely by
 * what these strings say.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, resolve } from "node:path"

import { s } from "../util/schema.js"
import { logger } from "../util/log.js"
import { truncate } from "../util/string.js"
import { suggestPattern } from "../permission/rules.js"
import {
  applyEdit,
  applyMultiEdit,
  displayPath,
  formatBytes,
  IMAGE_EXTENSIONS,
  readFileForModel,
  recordRead,
  writeFile,
} from "../edit/apply.js"
import { formatFile, formatFiles, formatterRegistry } from "../edit/format.js"
import {
  applyPatch,
  describeChanges,
  parsePatch,
  patchPaths,
  summarizePatch,
  validatePatchPaths,
} from "../edit/v4a.js"
import { defineTool, fail, ok, type ToolContext, type ToolResult } from "./types.js"

const log = logger("tool.file")

/* ------------------------------------------------------------------ */
/* read                                                                */
/* ------------------------------------------------------------------ */

const readParameters = s.object({
  filePath: s.string().describe("Path to the file. Relative paths resolve against the working directory."),
  offset: s.number().optional().describe("1-based line number to start from. Use with limit for large files."),
  limit: s.number().optional().describe("Maximum number of lines to return. Defaults to 2000."),
})

type ReadInput = { filePath: string; offset?: number; limit?: number }

export const readTool = defineTool<ReadInput>({
  id: "read",
  action: "read",
  readOnly: true,
  concurrent: true,
  init: () => ({
    description: `Read a file from the filesystem.

Output is line-numbered, so you can refer to specific lines afterwards and match them against diagnostics.

Read a file before you edit it. Edits to files you have not read in this session are rejected, because they are guesses.

For a file larger than 2000 lines, use offset and limit, or use grep first to find the region you need. Reading a whole large file wastes context you will need later.

Images are returned as attachments you can look at. Binary files are refused.

Prefer this over \`cat\` in bash: it is faster, it numbers lines, and it records that you have seen the file.`,
    parameters: readParameters as never,
    execute: async (input, context) => {
      const absolute = resolve(context.cwd, input.filePath)

      await context.requestPermission({
        action: "read",
        resource: absolute,
        title: `Read ${displayPath(absolute, context.cwd)}`,
        pattern: suggestPattern("read", absolute, context.cwd),
      })

      if (!existsSync(absolute)) {
        return fail(
          `read ${displayPath(absolute, context.cwd)}`,
          `${input.filePath} does not exist. Use glob to find the right path rather than guessing at variations.`,
        )
      }

      const stats = statSync(absolute)
      if (stats.isDirectory()) {
        return fail(
          `read ${displayPath(absolute, context.cwd)}`,
          `${input.filePath} is a directory. Use the list tool to see what is in it.`,
        )
      }

      const extension = extname(absolute).toLowerCase()
      if (IMAGE_EXTENSIONS.has(extension)) {
        // Images are useful to the model but only as attachments; sending the
        // bytes as text would be nonsense and enormous.
        if (stats.size > 5 * 1024 * 1024) {
          return fail(
            `read ${displayPath(absolute, context.cwd)}`,
            `The image is ${formatBytes(stats.size)}, which is too large to attach.`,
          )
        }
        const data = readFileSync(absolute).toString("base64")
        recordRead(context.sessionId, absolute)
        return ok(
          `${displayPath(absolute, context.cwd)} (${formatBytes(stats.size)} image)`,
          `Attached ${displayPath(absolute, context.cwd)}.`,
          { bytes: stats.size, image: true },
          [{ type: "image", mime: mimeForExtension(extension), data, filename: input.filePath }],
        )
      }

      try {
        const result = readFileForModel(absolute, {
          offset: input.offset,
          limit: input.limit,
          numbered: true,
        })

        if (result.binary) {
          return fail(
            `read ${displayPath(absolute, context.cwd)}`,
            `${input.filePath} is a binary file (${formatBytes(result.bytes)}) and cannot be read as text.`,
          )
        }

        recordRead(context.sessionId, absolute)

        const header: string[] = []
        if (result.truncated) {
          header.push(
            `Showing lines ${result.startLine}-${result.startLine + result.returnedLines - 1} of ${result.totalLines}. Use offset to continue.`,
          )
        }
        if (result.returnedLines === 0) {
          header.push("The file is empty.")
        }

        context.metadata({
          lines: result.totalLines,
          bytes: result.bytes,
          truncated: result.truncated,
        })

        return ok(
          `${displayPath(absolute, context.cwd)} (${result.totalLines} lines)`,
          header.length > 0 ? `${header.join("\n")}\n\n${result.content}` : result.content,
          { lines: result.totalLines, bytes: result.bytes, truncated: result.truncated },
        )
      } catch (error) {
        return fail(`read ${displayPath(absolute, context.cwd)}`, String((error as Error).message))
      }
    },
  }),
})

function mimeForExtension(extension: string): string {
  switch (extension) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".bmp":
      return "image/bmp"
    case ".avif":
      return "image/avif"
    default:
      return "application/octet-stream"
  }
}

/* ------------------------------------------------------------------ */
/* write                                                               */
/* ------------------------------------------------------------------ */

const writeParameters = s.object({
  filePath: s.string().describe("Path to write. Parent directories are created as needed."),
  content: s.string().describe("The complete contents of the file."),
})

type WriteInput = { filePath: string; content: string }

export const writeTool = defineTool<WriteInput>({
  id: "write",
  action: "edit",
  init: () => ({
    description: `Write a complete file, creating it or replacing its entire contents.

Use this for new files. For an existing file, prefer edit: write replaces everything, so it is easy to lose code you did not intend to touch, and the diff the user sees is the whole file instead of your actual change.

If the file already exists you must read it first.

Do not add comments explaining that the file was generated, and do not include a preamble or explanation in the content — the content is written verbatim.`,
    parameters: writeParameters as never,
    execute: async (input, context) => {
      const absolute = resolve(context.cwd, input.filePath)
      const existed = existsSync(absolute)

      await context.requestPermission({
        action: "edit",
        resource: absolute,
        title: `${existed ? "Overwrite" : "Create"} ${displayPath(absolute, context.cwd)}`,
        detail: existed
          ? `Replacing the entire contents of a ${formatBytes(statSync(absolute).size)} file.`
          : `${input.content.split("\n").length} lines.`,
        pattern: suggestPattern("edit", absolute, context.cwd),
        risk: existed ? "medium" : "low",
      })

      try {
        const result = writeFile(absolute, input.content, { sessionId: context.sessionId })

        const formatted = formatFile(formatterRegistry(context.cwd), absolute, { cwd: context.cwd })
        if (formatted.formatted) {
          log.debug("formatted after write", { path: absolute, formatter: formatted.formatter })
        }

        context.metadata({
          created: result.created,
          additions: result.additions,
          deletions: result.deletions,
          diff: result.diff,
          formatter: formatted.formatter,
        })

        const lines = input.content.split("\n").length
        return ok(
          `${result.created ? "created" : "wrote"} ${displayPath(absolute, context.cwd)} (${lines} lines)`,
          [
            `${result.created ? "Created" : "Replaced"} ${displayPath(absolute, context.cwd)}.`,
            formatted.formatted ? `Formatted with ${formatted.formatter}.` : "",
            result.diff ? `\n+${result.additions} -${result.deletions}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          { created: result.created, additions: result.additions, deletions: result.deletions },
        )
      } catch (error) {
        return fail(`write ${displayPath(absolute, context.cwd)}`, String((error as Error).message))
      }
    },
  }),
})

/* ------------------------------------------------------------------ */
/* edit                                                                */
/* ------------------------------------------------------------------ */

const editParameters = s.object({
  filePath: s.string().describe("Path to the file to modify."),
  oldString: s
    .string()
    .describe(
      "The exact text to replace, copied from the file including its indentation. Include enough surrounding lines to make it unique.",
    ),
  newString: s.string().describe("The replacement text."),
  replaceAll: s
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring exactly one. Use for renaming."),
})

type EditInput = {
  filePath: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

export const editTool = defineTool<EditInput>({
  id: "edit",
  action: "edit",
  init: () => ({
    description: `Replace a piece of text in a file.

This is the tool to reach for when changing existing code. It shows the user a precise diff and it cannot accidentally delete the rest of the file.

How to use it well:
- Copy oldString exactly from the file, including indentation. Do not retype it from memory.
- Include enough context that oldString appears exactly once. Two or three surrounding lines is usually enough. If it is not unique the edit is rejected.
- Set replaceAll to true when renaming something that appears many times.
- To delete code, pass an empty newString.

You must read the file first. Small whitespace differences are tolerated, but the text has to genuinely be there.`,
    parameters: editParameters as never,
    execute: async (input, context) => {
      const absolute = resolve(context.cwd, input.filePath)

      await context.requestPermission({
        action: "edit",
        resource: absolute,
        title: `Edit ${displayPath(absolute, context.cwd)}`,
        detail: buildEditPreview(input.oldString, input.newString),
        pattern: suggestPattern("edit", absolute, context.cwd),
      })

      try {
        const result = applyEdit(
          {
            path: absolute,
            oldString: input.oldString,
            newString: input.newString,
            replaceAll: input.replaceAll,
          },
          { sessionId: context.sessionId },
        )

        const formatted = formatFile(formatterRegistry(context.cwd), absolute, { cwd: context.cwd })

        context.metadata({
          additions: result.additions,
          deletions: result.deletions,
          diff: result.diff,
          line: result.line,
          strategy: result.strategy,
        })

        const notes: string[] = []
        if (result.strategy !== "simple" && result.note) {
          notes.push(`Note: ${result.note}. Verify the change is where you intended.`)
        }
        if (result.replacements > 1) notes.push(`Replaced ${result.replacements} occurrences.`)
        if (formatted.formatted) notes.push(`Formatted with ${formatted.formatter}.`)

        return ok(
          `${displayPath(absolute, context.cwd)}:${result.line} (+${result.additions} -${result.deletions})`,
          [
            `Edited ${displayPath(absolute, context.cwd)} at line ${result.line}.`,
            ...notes,
            "",
            result.diff,
          ].join("\n"),
          {
            additions: result.additions,
            deletions: result.deletions,
            line: result.line,
            strategy: result.strategy,
          },
        )
      } catch (error) {
        return fail(`edit ${displayPath(absolute, context.cwd)}`, String((error as Error).message))
      }
    },
  }),
})

function buildEditPreview(oldString: string, newString: string): string {
  const removed = oldString.split("\n").slice(0, 8)
  const added = newString.split("\n").slice(0, 8)
  const lines: string[] = []
  for (const line of removed) lines.push(`- ${line}`)
  if (oldString.split("\n").length > 8) lines.push("- \u2026")
  for (const line of added) lines.push(`+ ${line}`)
  if (newString.split("\n").length > 8) lines.push("+ \u2026")
  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* multiedit                                                           */
/* ------------------------------------------------------------------ */

const multiEditParameters = s.object({
  filePath: s.string().describe("Path to the file to modify."),
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

type MultiEditInput = {
  filePath: string
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>
}

export const multiEditTool = defineTool<MultiEditInput>({
  id: "multiedit",
  action: "edit",
  init: () => ({
    description: `Make several edits to one file in a single atomic operation.

Use this instead of calling edit repeatedly on the same file: it is one permission prompt, one write, one formatter run, and one diff for the user.

Edits apply in order and each sees the result of the previous one, so you can rename a symbol and then change a line that uses the new name.

If any edit fails, none are written. Fix the failing edit and re-send the whole list.`,
    parameters: multiEditParameters as never,
    execute: async (input, context) => {
      const absolute = resolve(context.cwd, input.filePath)

      if (input.edits.length === 0) {
        return fail("multiedit", "The edits list was empty.")
      }

      await context.requestPermission({
        action: "edit",
        resource: absolute,
        title: `Apply ${input.edits.length} edits to ${displayPath(absolute, context.cwd)}`,
        detail: input.edits
          .slice(0, 4)
          .map((edit, index) => `${index + 1}. ${truncate(edit.oldString.split("\n")[0] ?? "", 80)}`)
          .join("\n"),
        pattern: suggestPattern("edit", absolute, context.cwd),
      })

      try {
        const result = applyMultiEdit({ path: absolute, edits: input.edits }, { sessionId: context.sessionId })
        const formatted = formatFile(formatterRegistry(context.cwd), absolute, { cwd: context.cwd })

        context.metadata({
          additions: result.additions,
          deletions: result.deletions,
          diff: result.diff,
          applied: result.applied,
        })

        return ok(
          `${displayPath(absolute, context.cwd)} (${result.applied} edits, +${result.additions} -${result.deletions})`,
          [
            `Applied ${result.applied} edits to ${displayPath(absolute, context.cwd)}.`,
            ...result.notes,
            formatted.formatted ? `Formatted with ${formatted.formatter}.` : "",
            "",
            result.diff,
          ]
            .filter(Boolean)
            .join("\n"),
          { additions: result.additions, deletions: result.deletions, applied: result.applied },
        )
      } catch (error) {
        return fail(`multiedit ${displayPath(absolute, context.cwd)}`, String((error as Error).message))
      }
    },
  }),
})

/* ------------------------------------------------------------------ */
/* apply_patch                                                         */
/* ------------------------------------------------------------------ */

const patchParameters = s.object({
  patch: s.string().describe("The patch in V4A format, beginning with *** Begin Patch."),
})

export const applyPatchTool = defineTool<{ patch: string }>({
  id: "apply_patch",
  action: "edit",
  init: () => ({
    description: `Apply a patch that can create, update, delete, and rename files in one atomic operation.

Format:

*** Begin Patch
*** Update File: src/app.ts
@@ class Server
   const port = 3000
-  listen(port)
+  listen(port, host)
*** Add File: src/host.ts
+export const host = "0.0.0.0"
*** Delete File: src/legacy.ts
*** End Patch

Rules:
- Context lines start with a single space, removed lines with -, added lines with +.
- Include three lines of context above and below each change so the hunk can be located. There are no line numbers.
- Use @@ followed by a class or function signature to disambiguate when the same code appears more than once.
- Every line of an added file starts with +.
- Paths are relative to the working directory.

Read the files you are updating first. If any hunk fails to apply, nothing is written and you get an explanation.`,
    parameters: patchParameters as never,
    execute: async (input, context) => executePatch(input.patch, context),
  }),
})

async function executePatch(raw: string, context: ToolContext): Promise<ToolResult> {
  let patch
  try {
    patch = parsePatch(raw)
  } catch (error) {
    return fail("apply_patch", `${(error as Error).message}\n\nRe-send the patch with the exact format shown in the tool description.`)
  }

  try {
    validatePatchPaths(patch, context.cwd)
  } catch (error) {
    return fail("apply_patch", String((error as Error).message))
  }

  const paths = patchPaths(patch)
  for (const path of paths) {
    const absolute = resolve(context.cwd, path)
    await context.requestPermission({
      action: "edit",
      resource: absolute,
      title: `Patch ${displayPath(absolute, context.cwd)}`,
      pattern: suggestPattern("edit", absolute, context.cwd),
    })
  }

  // Read every file the patch touches before applying anything, so the whole
  // operation is atomic in the sense that matters: either every hunk applies or
  // no file is modified.
  const files = new Map<string, string>()
  for (const path of paths) {
    const absolute = resolve(context.cwd, path)
    if (existsSync(absolute) && statSync(absolute).isFile()) {
      files.set(path, readFileSync(absolute, "utf8"))
    }
  }

  let applied
  try {
    applied = applyPatch(patch, files)
  } catch (error) {
    return fail("apply_patch", String((error as Error).message))
  }

  const written: string[] = []
  try {
    for (const change of applied.changes) {
      const absolute = resolve(context.cwd, change.path)
      switch (change.kind) {
        case "add":
          writeFile(absolute, change.after ?? "", { sessionId: context.sessionId, create: true })
          written.push(absolute)
          break
        case "delete": {
          const { deleteFile } = await import("../edit/apply.js")
          deleteFile(absolute, context.sessionId)
          break
        }
        case "move": {
          const target = resolve(context.cwd, change.newPath ?? change.path)
          writeFile(target, change.after ?? "", { sessionId: context.sessionId, create: true })
          const { deleteFile } = await import("../edit/apply.js")
          if (absolute !== target) deleteFile(absolute, context.sessionId)
          written.push(target)
          break
        }
        case "update":
          writeFile(absolute, change.after ?? "", { sessionId: context.sessionId, force: true })
          written.push(absolute)
          break
      }
    }
  } catch (error) {
    return fail(
      "apply_patch",
      `The patch was valid but a write failed: ${(error as Error).message}. Some files may have been written; check with git diff.`,
    )
  }

  const formatted = formatFiles(formatterRegistry(context.cwd), written, { cwd: context.cwd })
  const formatterNames = [...formatted.values()]
    .filter((entry) => entry.formatted && entry.formatter)
    .map((entry) => entry.formatter!)

  context.metadata({
    changes: applied.changes.length,
    additions: applied.changes.reduce((sum, change) => sum + change.additions, 0),
    deletions: applied.changes.reduce((sum, change) => sum + change.deletions, 0),
  })

  const lines = [
    summarizePatch(applied),
    "",
    ...describeChanges(applied),
  ]
  if (applied.warnings.length > 0) {
    lines.push("", "Warnings:", ...applied.warnings.map((warning) => `- ${warning}`))
  }
  if (formatterNames.length > 0) {
    lines.push("", `Formatted with ${[...new Set(formatterNames)].join(", ")}.`)
  }

  return ok(summarizePatch(applied), lines.join("\n"), {
    changes: applied.changes.length,
  })
}

/** Alias so configurations that reference `patch` keep working. */
export const patchTool = defineTool<{ patch: string }>({
  id: "patch",
  action: "edit",
  internal: true,
  init: () => ({
    description: "Alias for apply_patch.",
    parameters: patchParameters as never,
    execute: async (input, context) => executePatch(input.patch, context),
  }),
})
