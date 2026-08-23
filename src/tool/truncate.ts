/**
 * Tool output truncation.
 *
 * Every tool result passes through here before it reaches the model. The reason
 * is arithmetic: a `grep` across a large repository can return several megabytes,
 * which is more than most context windows hold, and pasting it in costs the entire
 * remaining budget for a session to produce output the model cannot use anyway.
 *
 * The naive fix \u2014 cut at N characters \u2014 is worse than it looks. It truncates
 * mid-line, it discards the end of the output where a summary or an error usually
 * sits, and it leaves the model with no way to see the rest, so it re-runs the same
 * command with a slightly different argument and gets truncated again.
 *
 * What happens instead: the full output is written to a file, the model receives a
 * preview plus the path, and the message tells it to delegate processing to a
 * subagent rather than reading the file back itself. That last part is the whole
 * point. A subagent has its own context window; whatever it burns reading a
 * hundred thousand lines does not come out of the main conversation, and what
 * comes back is a paragraph rather than a megabyte.
 */

import { mkdir, writeFile, readFile, readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"

import { Paths } from "../global.js"
import { logger } from "../util/log.js"
import { newId } from "../util/id.js"

const log = logger("tool.truncate")

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * Lines returned before truncating.
 *
 * Two thousand is roughly twenty to thirty thousand tokens of typical source \u2014
 * large enough that ordinary output passes through untouched, small enough that a
 * runaway result cannot consume the window.
 */
export const MAX_LINES = 2_000

/**
 * Bytes returned before truncating.
 *
 * The line limit alone is not enough. A minified bundle is one line and fifty
 * megabytes; a log file with long JSON lines hits the byte cap at a few hundred
 * lines. Both limits are needed because either can be hit first.
 */
export const MAX_BYTES = 50 * 1024

/**
 * Characters kept from the end of truncated output.
 *
 * Output is not uniformly interesting. A failing build prints thousands of lines
 * of progress and then the error; a test run prints every test and then the
 * summary. Keeping only the head throws away the part that answers the question,
 * so a slice of the tail is preserved as well.
 */
const TAIL_CHARS = 4_000

/** Age at which a stored output is eligible for cleanup. */
const STORE_TTL_MS = 24 * 60 * 60 * 1000

/** Stored outputs kept before the oldest are removed. */
const STORE_MAX_FILES = 200

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface TruncateLimits {
  readonly maxLines: number
  readonly maxBytes: number
}

let limits: TruncateLimits = { maxLines: MAX_LINES, maxBytes: MAX_BYTES }

/**
 * Overrides the limits from configuration.
 *
 * Worth exposing because the right value depends on the model. A million-token
 * context can afford far more than a thirty-two-thousand-token one, and forcing
 * both to the same limit wastes the former.
 */
export function configureTruncation(overrides: Partial<TruncateLimits>): void {
  limits = {
    maxLines: Math.max(50, overrides.maxLines ?? limits.maxLines),
    maxBytes: Math.max(4096, overrides.maxBytes ?? limits.maxBytes),
  }

  log.debug("truncation limits changed", limits)
}

export function currentLimits(): TruncateLimits {
  return limits
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface TruncationResult {
  /** What the model sees. */
  readonly output: string
  /** Whether anything was removed. */
  readonly truncated: boolean
  /** Lines in the original. */
  readonly totalLines: number
  /** Bytes in the original. */
  readonly totalBytes: number
  /** Lines shown. */
  readonly shownLines: number
  /** Where the full output was written, when it was. */
  readonly outputPath?: string
  /** Which limit was hit. */
  readonly reason?: "lines" | "bytes"
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

function storeDirectory(): string {
  return join(Paths.dataDir, "tool-output")
}

/**
 * Writes full output to disk and returns its path.
 *
 * On failure the caller falls back to a plain truncation notice. A tool that
 * produced too much output should not also fail because the disk was full.
 */
async function store(toolName: string, content: string): Promise<string | undefined> {
  try {
    const directory = storeDirectory()

    await mkdir(directory, { recursive: true })

    // The tool name is in the filename so the model can tell several stored
    // outputs apart when it has produced more than one.
    const safe = toolName.replace(/[^a-z0-9_-]/gi, "") || "tool"
    const path = join(directory, `${safe}-${newId("tul")}.txt`)

    await writeFile(path, content, "utf8")

    // Opportunistic and unawaited; cleanup failing must not delay the result.
    void cleanup()

    return path
  } catch (error) {
    log.warn("could not store the full tool output", { error: String(error) })

    return undefined
  }
}

/**
 * Removes stored outputs that are old or surplus.
 *
 * These files are only useful within the session that produced them, and
 * nothing else deletes them, so without this the directory grows without bound.
 */
export async function cleanup(): Promise<void> {
  try {
    const directory = storeDirectory()
    const names = await readdir(directory)

    const files: Array<{ path: string; at: number }> = []
    const now = Date.now()

    for (const name of names) {
      const path = join(directory, name)

      try {
        const info = await stat(path)

        if (now - info.mtimeMs > STORE_TTL_MS) {
          await unlink(path)
          continue
        }

        files.push({ path, at: info.mtimeMs })
      } catch {
        // Removed by something else between the listing and the stat.
      }
    }

    if (files.length <= STORE_MAX_FILES) return

    files.sort((a, b) => a.at - b.at)

    for (const file of files.slice(0, files.length - STORE_MAX_FILES)) {
      await unlink(file.path).catch(() => {})
    }
  } catch {
    // The directory does not exist yet. Nothing to clean.
  }
}

/** Reads a stored output back, for the `/details` view. */
export async function readStored(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* Truncation                                                          */
/* ------------------------------------------------------------------ */

export interface TruncateOptions {
  /** Tool that produced the output, used in the filename and the message. */
  readonly toolName: string
  /** Skip writing to disk. Used where the full output is already available. */
  readonly noStore?: boolean
  /** Per-call override. */
  readonly maxLines?: number
  readonly maxBytes?: number
  /** Keep a slice of the tail. On by default. */
  readonly keepTail?: boolean
}

/**
 * Truncates tool output if it exceeds the limits.
 *
 * The byte check runs first and is cheap: most output is well under the limit,
 * and `Buffer.byteLength` on a short string costs nothing, whereas splitting a
 * fifty-megabyte string into lines to count them allocates fifty megabytes of
 * array before discovering it was too long.
 */
export async function truncateOutput(
  content: string,
  options: TruncateOptions,
): Promise<TruncationResult> {
  const maxLines = options.maxLines ?? limits.maxLines
  const maxBytes = options.maxBytes ?? limits.maxBytes

  const totalBytes = Buffer.byteLength(content, "utf8")

  // The common case, and it must stay fast.
  if (totalBytes <= maxBytes) {
    const lineCount = countLines(content)

    if (lineCount <= maxLines) {
      return {
        output: content,
        truncated: false,
        totalLines: lineCount,
        totalBytes,
        shownLines: lineCount,
      }
    }

    return finish(content, lineCount, totalBytes, maxLines, "lines", options)
  }

  const lineCount = countLines(content)

  // Both limits may be exceeded. Report whichever forces the smaller output,
  // because that is the one the model needs to work around.
  const byBytes = estimateLinesForBytes(content, maxBytes)
  const effective = Math.min(maxLines, byBytes)

  return finish(content, lineCount, totalBytes, effective, byBytes < maxLines ? "bytes" : "lines", options)
}

async function finish(
  content: string,
  totalLines: number,
  totalBytes: number,
  keepLines: number,
  reason: "lines" | "bytes",
  options: TruncateOptions,
): Promise<TruncationResult> {
  const lines = content.split("\n")
  const head = lines.slice(0, keepLines).join("\n")

  const outputPath = options.noStore ? undefined : await store(options.toolName, content)

  const parts = [head]

  if (options.keepTail !== false && content.length > head.length + TAIL_CHARS) {
    const tail = content.slice(-TAIL_CHARS)

    // Start at a line boundary; a fragment beginning mid-token reads as
    // corruption rather than as a continuation.
    const boundary = tail.indexOf("\n")
    const cleanTail = boundary >= 0 ? tail.slice(boundary + 1) : tail

    const omitted = totalLines - keepLines - countLines(cleanTail)

    if (omitted > 0) {
      parts.push("", `[... ${omitted.toLocaleString("en-US")} lines omitted ...]`, "", cleanTail)
    }
  }

  parts.push("", notice({ totalLines, totalBytes, shownLines: keepLines, reason, outputPath, toolName: options.toolName }))

  log.debug("truncated tool output", {
    tool: options.toolName,
    totalLines,
    totalBytes,
    shownLines: keepLines,
    reason,
    stored: outputPath !== undefined,
  })

  return {
    output: parts.join("\n"),
    truncated: true,
    totalLines,
    totalBytes,
    shownLines: keepLines,
    outputPath,
    reason,
  }
}

/* ------------------------------------------------------------------ */
/* The notice                                                          */
/* ------------------------------------------------------------------ */

interface NoticeInput {
  readonly totalLines: number
  readonly totalBytes: number
  readonly shownLines: number
  readonly reason: "lines" | "bytes"
  readonly outputPath?: string
  readonly toolName: string
}

/**
 * The message appended to truncated output.
 *
 * Wording matters here more than anywhere else in the file. Told only that the
 * output was truncated, a model reads the next chunk, and the next, and consumes
 * the context window doing by hand exactly what it was truncated to prevent. It
 * has to be told what to do instead, and told not to do the obvious thing.
 *
 * The suggestions are tool-specific because the right alternative differs: for
 * `grep` it is a narrower pattern, for `read` it is an offset, for `bash` it is
 * piping through something that reduces the output at the source.
 */
function notice(input: NoticeInput): string {
  const shown = input.shownLines.toLocaleString("en-US")
  const total = input.totalLines.toLocaleString("en-US")
  const size = formatBytes(input.totalBytes)

  const lines = [
    `[Truncated: showing ${shown} of ${total} lines (${size}). ` +
      `Hit the ${input.reason === "bytes" ? "size" : "line"} limit.]`,
  ]

  if (input.outputPath) {
    lines.push(
      "",
      `The full output is at ${input.outputPath}`,
      "",
      "Use the task tool to have a subagent process that file with grep and read " +
        "(with offset and limit), and report back what matters. " +
        "Do NOT read the whole file yourself \u2014 delegating keeps it out of this conversation.",
    )
  }

  const hint = suggestion(input.toolName)

  if (hint) lines.push("", hint)

  return lines.join("\n")
}

function suggestion(toolName: string): string | undefined {
  switch (toolName) {
    case "grep":
      return "To narrow this down: use a more specific pattern, restrict it with the path or include argument, or set head_limit."

    case "glob":
      return "To narrow this down: use a more specific pattern, or start from a subdirectory rather than the project root."

    case "read":
      return "To continue: call read again with an offset past where this stopped. To find something specific in the file, use grep instead."

    case "bash":
      return "To reduce this at the source: pipe through head, tail, grep, or wc, or redirect to a file and search it."

    case "list":
      return "To narrow this down: list a subdirectory, or use glob with a pattern."

    case "webfetch":
      return "To continue: fetch again with an offset past where this stopped."

    default:
      return undefined
  }
}

/* ------------------------------------------------------------------ */
/* Counting                                                            */
/* ------------------------------------------------------------------ */

/**
 * Counts lines without allocating an array.
 *
 * `content.split("\n").length` is the obvious version and allocates a copy of
 * the entire string as separate line strings. On the inputs this function exists
 * to handle, that is the difference between a scan and a fifty-megabyte
 * allocation.
 */
function countLines(content: string): number {
  if (content === "") return 0

  let count = 1

  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) count++
  }

  return count
}

/**
 * Estimates how many lines fit in a byte budget.
 *
 * Walks lines accumulating their byte length, and stops at the budget. Exact
 * rather than estimated, and cheap enough because it stops as soon as the budget
 * is reached rather than scanning the whole input.
 */
function estimateLinesForBytes(content: string, maxBytes: number): number {
  let bytes = 0
  let lines = 0
  let start = 0

  while (start < content.length) {
    const end = content.indexOf("\n", start)
    const stop = end === -1 ? content.length : end

    bytes += Buffer.byteLength(content.slice(start, stop), "utf8") + 1

    if (bytes > maxBytes) break

    lines++

    if (end === -1) break

    start = end + 1
  }

  // Always return at least something. A single line longer than the entire
  // budget would otherwise produce empty output.
  return Math.max(1, lines)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/* ------------------------------------------------------------------ */
/* Synchronous variant                                                 */
/* ------------------------------------------------------------------ */

/**
 * Truncates without touching the disk.
 *
 * For places that cannot await \u2014 a stream handler, a render pass \u2014 and for output
 * where the full text is already reachable, so storing a second copy would be
 * pointless.
 */
export function truncateSync(content: string, maxLines = limits.maxLines, maxBytes = limits.maxBytes): TruncationResult {
  const totalBytes = Buffer.byteLength(content, "utf8")
  const totalLines = countLines(content)

  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return { output: content, truncated: false, totalLines, totalBytes, shownLines: totalLines }
  }

  const keep = Math.min(maxLines, estimateLinesForBytes(content, maxBytes))
  const head = content.split("\n", keep).join("\n")

  const output = [
    head,
    "",
    `[Truncated: showing ${keep.toLocaleString("en-US")} of ${totalLines.toLocaleString("en-US")} lines (${formatBytes(totalBytes)}).]`,
  ].join("\n")

  return {
    output,
    truncated: true,
    totalLines,
    totalBytes,
    shownLines: keep,
    reason: totalBytes > maxBytes ? "bytes" : "lines",
  }
}

/**
 * Truncates a string to a character budget, cutting at a word boundary.
 *
 * For short fields \u2014 a title, a preview, a label \u2014 rather than tool output. The
 * word-boundary search is limited to the last fifth of the budget so that a string
 * with no spaces is not cut back to nothing.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  const slice = text.slice(0, maxChars)
  const space = slice.lastIndexOf(" ")

  const cut = space > maxChars * 0.8 ? slice.slice(0, space) : slice

  return `${cut}\u2026`
}

/**
 * Truncates the middle, keeping both ends.
 *
 * For paths and identifiers, where the start says what kind of thing it is and
 * the end says which one, and the middle is the part nobody reads.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars < 8) return text.slice(0, maxChars)

  const half = Math.floor((maxChars - 1) / 2)

  return `${text.slice(0, half)}\u2026${text.slice(-(maxChars - half - 1))}`
}
