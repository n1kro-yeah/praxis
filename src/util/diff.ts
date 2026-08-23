/**
 * Diffing.
 *
 * Praxis renders diffs constantly: after every edit, in the review panel, in
 * snapshot comparisons, and in the `apply_patch` verifier. We implement Myers'
 * O((N+M)D) algorithm with a linear-space refinement, plus a word-level diff
 * for intra-line highlighting and a unified-diff serialiser/parser.
 */

export type ChangeKind = "equal" | "insert" | "delete"

export interface Change<T> {
  readonly kind: ChangeKind
  readonly values: T[]
  /** Index into the original sequence (for equal/delete). */
  readonly oldStart: number
  /** Index into the modified sequence (for equal/insert). */
  readonly newStart: number
}

interface Snake {
  readonly x: number
  readonly y: number
  readonly u: number
  readonly v: number
}

/**
 * Myers diff, divide-and-conquer variant. Returns a compact change list.
 * `equals` lets callers ignore whitespace or case.
 */
export function diffSequences<T>(
  a: readonly T[],
  b: readonly T[],
  equals: (x: T, y: T) => boolean = (x, y) => x === y,
): Change<T>[] {
  const changes: Change<T>[] = []

  // Trim the common prefix/suffix first: real edits are usually local, and this
  // turns most diffs into a tiny sub-problem.
  let prefix = 0
  while (prefix < a.length && prefix < b.length && equals(a[prefix] as T, b[prefix] as T)) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    equals(a[a.length - 1 - suffix] as T, b[b.length - 1 - suffix] as T)
  )
    suffix++

  if (prefix > 0) {
    changes.push({ kind: "equal", values: a.slice(0, prefix), oldStart: 0, newStart: 0 })
  }

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)

  const middle: Change<T>[] = []
  compute(midA, midB, 0, 0, equals, middle, prefix, prefix)
  changes.push(...coalesce(middle))

  if (suffix > 0) {
    changes.push({
      kind: "equal",
      values: a.slice(a.length - suffix),
      oldStart: a.length - suffix,
      newStart: b.length - suffix,
    })
  }

  return coalesce(changes)
}

function compute<T>(
  a: readonly T[],
  b: readonly T[],
  offsetA: number,
  offsetB: number,
  equals: (x: T, y: T) => boolean,
  out: Change<T>[],
  baseA: number,
  baseB: number,
): void {
  if (a.length === 0 && b.length === 0) return
  if (a.length === 0) {
    out.push({
      kind: "insert",
      values: b.slice(),
      oldStart: baseA + offsetA,
      newStart: baseB + offsetB,
    })
    return
  }
  if (b.length === 0) {
    out.push({
      kind: "delete",
      values: a.slice(),
      oldStart: baseA + offsetA,
      newStart: baseB + offsetB,
    })
    return
  }

  // Guard against pathological inputs: fall back to a line-block replacement.
  if (a.length * b.length > 24_000_000) {
    out.push({
      kind: "delete",
      values: a.slice(),
      oldStart: baseA + offsetA,
      newStart: baseB + offsetB,
    })
    out.push({
      kind: "insert",
      values: b.slice(),
      oldStart: baseA + offsetA + a.length,
      newStart: baseB + offsetB,
    })
    return
  }

  const snake = findMiddleSnake(a, b, equals)
  if (!snake) {
    out.push({
      kind: "delete",
      values: a.slice(),
      oldStart: baseA + offsetA,
      newStart: baseB + offsetB,
    })
    out.push({
      kind: "insert",
      values: b.slice(),
      oldStart: baseA + offsetA + a.length,
      newStart: baseB + offsetB,
    })
    return
  }

  compute(
    a.slice(0, snake.x),
    b.slice(0, snake.y),
    offsetA,
    offsetB,
    equals,
    out,
    baseA,
    baseB,
  )
  if (snake.u > snake.x) {
    out.push({
      kind: "equal",
      values: a.slice(snake.x, snake.u),
      oldStart: baseA + offsetA + snake.x,
      newStart: baseB + offsetB + snake.y,
    })
  }
  compute(
    a.slice(snake.u),
    b.slice(snake.v),
    offsetA + snake.u,
    offsetB + snake.v,
    equals,
    out,
    baseA,
    baseB,
  )
}

function findMiddleSnake<T>(
  a: readonly T[],
  b: readonly T[],
  equals: (x: T, y: T) => boolean,
): Snake | undefined {
  const n = a.length
  const m = b.length
  const max = n + m
  const delta = n - m
  const offset = max + 1
  const forward = new Int32Array(2 * max + 3).fill(-1)
  const backward = new Int32Array(2 * max + 3).fill(-1)
  forward[offset + 1] = 0
  backward[offset + 1] = 0

  const half = Math.ceil(max / 2)

  for (let d = 0; d <= half; d++) {
    // Forward pass.
    for (let k = -d; k <= d; k += 2) {
      const index = offset + k
      let x =
        k === -d || (k !== d && (forward[index - 1] as number) < (forward[index + 1] as number))
          ? (forward[index + 1] as number)
          : (forward[index - 1] as number) + 1
      let y = x - k
      const startX = x
      const startY = y
      while (x < n && y < m && equals(a[x] as T, b[y] as T)) {
        x++
        y++
      }
      forward[index] = x
      const reverseK = delta - k
      if (
        Math.abs(reverseK) <= d - 1 &&
        (backward[offset + reverseK] as number) >= 0 &&
        n - (backward[offset + reverseK] as number) <= x
      ) {
        return { x: startX, y: startY, u: x, v: y }
      }
    }

    // Backward pass.
    for (let k = -d; k <= d; k += 2) {
      const index = offset + k
      let x =
        k === -d || (k !== d && (backward[index - 1] as number) < (backward[index + 1] as number))
          ? (backward[index + 1] as number)
          : (backward[index - 1] as number) + 1
      let y = x - k
      while (x < n && y < m && equals(a[n - x - 1] as T, b[m - y - 1] as T)) {
        x++
        y++
      }
      backward[index] = x
      const forwardK = delta - k
      if (
        Math.abs(forwardK) <= d &&
        (forward[offset + forwardK] as number) >= 0 &&
        (forward[offset + forwardK] as number) >= n - x
      ) {
        const u = n - x
        const v = m - y
        return { x: u, y: v, u: n - (x - snakeLength(a, b, n, m, x, y, equals)), v }
      }
    }
  }
  return undefined
}

function snakeLength<T>(
  _a: readonly T[],
  _b: readonly T[],
  _n: number,
  _m: number,
  _x: number,
  _y: number,
  _equals: (x: T, y: T) => boolean,
): number {
  return 0
}

function coalesce<T>(changes: Change<T>[]): Change<T>[] {
  const out: Change<T>[] = []
  for (const change of changes) {
    if (change.values.length === 0) continue
    const last = out[out.length - 1]
    if (last && last.kind === change.kind) {
      out[out.length - 1] = {
        kind: last.kind,
        values: [...last.values, ...change.values],
        oldStart: last.oldStart,
        newStart: last.newStart,
      }
      continue
    }
    out.push(change)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Line diffs and hunks                                                */
/* ------------------------------------------------------------------ */

export function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  // A trailing newline produces an empty final element that is not a real line.
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

export type DiffLineKind = "context" | "add" | "remove"

export interface DiffLine {
  readonly kind: DiffLineKind
  readonly text: string
  readonly oldLine?: number
  readonly newLine?: number
  /** Character ranges that differ from the paired line, for inline highlight. */
  readonly highlights?: Array<[number, number]>
}

export interface Hunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly header: string
  readonly lines: DiffLine[]
}

export interface DiffStats {
  readonly added: number
  readonly removed: number
  readonly hunks: number
}

export interface DiffOptions {
  readonly context?: number
  readonly ignoreWhitespace?: boolean
  readonly inlineHighlight?: boolean
}

export interface FileDiff {
  readonly oldPath: string
  readonly newPath: string
  readonly hunks: Hunk[]
  readonly stats: DiffStats
  readonly binary: boolean
}

export function diffLines(
  oldText: string,
  newText: string,
  options: DiffOptions = {},
): Change<string>[] {
  const normalize = options.ignoreWhitespace
    ? (line: string) => line.replace(/\s+/g, " ").trim()
    : (line: string) => line
  return diffSequences(
    splitLines(oldText),
    splitLines(newText),
    (x, y) => normalize(x) === normalize(y),
  )
}

/** Builds hunks with N lines of context, the way `git diff` does. */
export function buildHunks(
  oldText: string,
  newText: string,
  options: DiffOptions = {},
): Hunk[] {
  const context = options.context ?? 3
  const changes = diffLines(oldText, newText, options)

  // Flatten into a per-line stream so we can slice context windows.
  const stream: DiffLine[] = []
  let oldLine = 1
  let newLine = 1
  for (const change of changes) {
    for (const text of change.values) {
      if (change.kind === "equal") {
        stream.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ })
      } else if (change.kind === "delete") {
        stream.push({ kind: "remove", text, oldLine: oldLine++ })
      } else {
        stream.push({ kind: "add", text, newLine: newLine++ })
      }
    }
  }

  const changedIndices = stream
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0)
  if (changedIndices.length === 0) return []

  // Group changed lines whose context windows overlap.
  const groups: Array<[number, number]> = []
  let start = Math.max(0, (changedIndices[0] as number) - context)
  let end = Math.min(stream.length - 1, (changedIndices[0] as number) + context)
  for (const index of changedIndices.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(stream.length - 1, index + context)
      continue
    }
    groups.push([start, end])
    start = Math.max(0, index - context)
    end = Math.min(stream.length - 1, index + context)
  }
  groups.push([start, end])

  const hunks: Hunk[] = []
  for (const [from, to] of groups) {
    const lines = stream.slice(from, to + 1)
    if (options.inlineHighlight !== false) annotateInline(lines)
    const oldNumbers = lines.filter((l) => l.oldLine !== undefined).map((l) => l.oldLine as number)
    const newNumbers = lines.filter((l) => l.newLine !== undefined).map((l) => l.newLine as number)
    const oldStart = oldNumbers[0] ?? 0
    const newStart = newNumbers[0] ?? 0
    const oldCount = oldNumbers.length
    const newCount = newNumbers.length
    hunks.push({
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines,
    })
  }
  return hunks
}

/**
 * Pairs adjacent remove/add runs of equal length and computes word-level
 * highlight ranges so the renderer can emphasise exactly what changed.
 */
function annotateInline(lines: DiffLine[]): void {
  let index = 0
  while (index < lines.length) {
    if ((lines[index] as DiffLine).kind !== "remove") {
      index++
      continue
    }
    let removeEnd = index
    while (removeEnd < lines.length && (lines[removeEnd] as DiffLine).kind === "remove") removeEnd++
    let addEnd = removeEnd
    while (addEnd < lines.length && (lines[addEnd] as DiffLine).kind === "add") addEnd++

    const removes = lines.slice(index, removeEnd)
    const adds = lines.slice(removeEnd, addEnd)
    const pairs = Math.min(removes.length, adds.length)
    for (let i = 0; i < pairs; i++) {
      const before = removes[i] as DiffLine
      const after = adds[i] as DiffLine
      const similarity = lineSimilarity(before.text, after.text)
      if (similarity < 0.35) continue
      const { left, right } = wordHighlights(before.text, after.text)
      ;(before as { highlights?: Array<[number, number]> }).highlights = left
      ;(after as { highlights?: Array<[number, number]> }).highlights = right
    }
    index = addEnd > index ? addEnd : index + 1
  }
}

function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  const distance = boundedLevenshtein(a, b, Math.ceil(max * 0.7))
  if (distance < 0) return 0
  return 1 - distance / max
}

/** Levenshtein with an early-exit band; returns -1 when it exceeds `limit`. */
export function boundedLevenshtein(a: string, b: string, limit: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > limit) return -1
  const previous = new Int32Array(b.length + 1)
  const current = new Int32Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) previous[j] = j
  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      const value = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      )
      current[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > limit) return -1
    previous.set(current)
  }
  return previous[b.length] as number
}

const WORD_SPLIT = /(\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$])/g

function tokenizeWords(input: string): string[] {
  return input.match(WORD_SPLIT) ?? []
}

/** Word-level diff converted into character ranges on each side. */
export function wordHighlights(
  before: string,
  after: string,
): { left: Array<[number, number]>; right: Array<[number, number]> } {
  const a = tokenizeWords(before)
  const b = tokenizeWords(after)
  const changes = diffSequences(a, b)
  const left: Array<[number, number]> = []
  const right: Array<[number, number]> = []
  let leftPos = 0
  let rightPos = 0
  for (const change of changes) {
    const text = change.values.join("")
    if (change.kind === "equal") {
      leftPos += text.length
      rightPos += text.length
      continue
    }
    if (change.kind === "delete") {
      if (text.trim() !== "") left.push([leftPos, leftPos + text.length])
      leftPos += text.length
      continue
    }
    if (text.trim() !== "") right.push([rightPos, rightPos + text.length])
    rightPos += text.length
  }
  return { left: mergeRanges(left), right: mergeRanges(right) }
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length < 2) return ranges
  const sorted = ranges.slice().sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = [sorted[0] as [number, number]]
  for (const range of sorted.slice(1)) {
    const last = out[out.length - 1] as [number, number]
    if (range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1])
      continue
    }
    out.push(range)
  }
  return out
}

export function diffStats(hunks: readonly Hunk[]): DiffStats {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added++
      else if (line.kind === "remove") removed++
    }
  }
  return { added, removed, hunks: hunks.length }
}

/* ------------------------------------------------------------------ */
/* Unified diff serialisation                                          */
/* ------------------------------------------------------------------ */

export function toUnifiedDiff(
  oldPath: string,
  newPath: string,
  oldText: string,
  newText: string,
  options: DiffOptions = {},
): string {
  const hunks = buildHunks(oldText, newText, { ...options, inlineHighlight: false })
  if (hunks.length === 0) return ""
  const out: string[] = [`--- ${oldPath}`, `+++ ${newPath}`]
  for (const hunk of hunks) {
    out.push(hunk.header)
    for (const line of hunk.lines) {
      const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "
      out.push(marker + line.text)
    }
  }
  return out.join("\n") + "\n"
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Parses a unified diff into structured file diffs. */
export function parseUnifiedDiff(input: string): FileDiff[] {
  const files: FileDiff[] = []
  const lines = input.split("\n")
  let index = 0
  let currentOld = ""
  let currentNew = ""
  let hunks: Hunk[] = []
  let binary = false

  const flush = () => {
    if (!currentOld && !currentNew) return
    files.push({
      oldPath: currentOld,
      newPath: currentNew,
      hunks,
      stats: diffStats(hunks),
      binary,
    })
    hunks = []
    binary = false
  }

  while (index < lines.length) {
    const line = lines[index] as string
    if (line.startsWith("diff --git ")) {
      flush()
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      currentOld = match?.[1] ?? ""
      currentNew = match?.[2] ?? ""
      index++
      continue
    }
    if (line.startsWith("--- ")) {
      const value = line.slice(4).trim()
      currentOld = value === "/dev/null" ? "" : value.replace(/^a\//, "")
      index++
      continue
    }
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim()
      currentNew = value === "/dev/null" ? "" : value.replace(/^b\//, "")
      index++
      continue
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true
      index++
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header) {
      const oldStart = Number(header[1])
      const oldLines = header[2] === undefined ? 1 : Number(header[2])
      const newStart = Number(header[3])
      const newLines = header[4] === undefined ? 1 : Number(header[4])
      const hunkLines: DiffLine[] = []
      index++
      let oldCursor = oldStart
      let newCursor = newStart
      while (index < lines.length) {
        const body = lines[index] as string
        if (body.startsWith("@@") || body.startsWith("diff --git ") || body.startsWith("--- ")) break
        if (body.startsWith("\\ No newline")) {
          index++
          continue
        }
        const marker = body[0]
        const text = body.slice(1)
        if (marker === "+") hunkLines.push({ kind: "add", text, newLine: newCursor++ })
        else if (marker === "-") hunkLines.push({ kind: "remove", text, oldLine: oldCursor++ })
        else if (marker === " " || marker === undefined)
          hunkLines.push({
            kind: "context",
            text: text ?? "",
            oldLine: oldCursor++,
            newLine: newCursor++,
          })
        else break
        index++
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, header: line, lines: hunkLines })
      continue
    }
    index++
  }
  flush()
  return files
}

/** Applies a parsed hunk list to text. Returns undefined when context mismatches. */
export function applyHunks(source: string, hunks: readonly Hunk[]): string | undefined {
  const lines = splitLines(source)
  const out: string[] = []
  let cursor = 0
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1
    if (start < cursor || start > lines.length) return undefined
    out.push(...lines.slice(cursor, start))
    cursor = start
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        if (lines[cursor] !== line.text) return undefined
        out.push(line.text)
        cursor++
        continue
      }
      if (line.kind === "remove") {
        if (lines[cursor] !== line.text) return undefined
        cursor++
        continue
      }
      out.push(line.text)
    }
  }
  out.push(...lines.slice(cursor))
  const trailing = source.endsWith("\n") ? "\n" : ""
  return out.join("\n") + trailing
}

/** Compact `+12 -3` style summary. */
export function formatStats(stats: DiffStats): string {
  const parts: string[] = []
  if (stats.added) parts.push(`+${stats.added}`)
  if (stats.removed) parts.push(`-${stats.removed}`)
  return parts.join(" ") || "no changes"
}

/** Character-level diff, used by the inline suggestion renderer. */
export function diffChars(a: string, b: string): Change<string>[] {
  return diffSequences([...a], [...b])
}
