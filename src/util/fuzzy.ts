/**
 * Fuzzy matching.
 *
 * Powers `@file` completion, the command palette, model/agent pickers and the
 * `/session` switcher. The algorithm is a Smith-Waterman variant in the spirit
 * of fzf's v2 scorer: it finds the optimal alignment (not just the first greedy
 * one), rewards consecutive matches, word boundaries and camelCase humps, and
 * penalises gaps. It returns the matched character positions so the UI can
 * highlight them.
 */

export interface FuzzyMatch {
  readonly score: number
  readonly positions: number[]
}

export interface FuzzyOptions {
  /** Treat the pattern as case-sensitive when it contains an uppercase letter. */
  readonly smartCase?: boolean
  readonly caseSensitive?: boolean
  /** Bonus applied when the match starts at the beginning of the candidate. */
  readonly prefixBonus?: number
  /** Extra weight for matches inside the basename of a path. */
  readonly filenameBonus?: number
}

const SCORE_MATCH = 16
const SCORE_GAP_START = -3
const SCORE_GAP_EXTENSION = -1
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 7
const BONUS_CONSECUTIVE = 8
const BONUS_FIRST_CHAR_MULTIPLIER = 2

type CharClass = "lower" | "upper" | "digit" | "delimiter" | "other"

function classify(char: string): CharClass {
  if (char >= "a" && char <= "z") return "lower"
  if (char >= "A" && char <= "Z") return "upper"
  if (char >= "0" && char <= "9") return "digit"
  if (char === "/" || char === "\\" || char === "_" || char === "-" || char === " " || char === ".")
    return "delimiter"
  return "other"
}

/** Positional bonus for matching at `index` given the preceding character. */
function bonusAt(candidate: string, index: number): number {
  if (index === 0) return BONUS_BOUNDARY * BONUS_FIRST_CHAR_MULTIPLIER
  const previous = classify(candidate[index - 1] as string)
  const current = classify(candidate[index] as string)
  if (previous === "delimiter") return BONUS_BOUNDARY
  if (previous === "lower" && current === "upper") return BONUS_CAMEL
  if (previous !== "digit" && current === "digit") return BONUS_CAMEL
  return 0
}

/**
 * Full dynamic-programming match. O(pattern * candidate) time and memory,
 * bounded by a candidate-length cap so pathological inputs stay cheap.
 */
export function fuzzyMatch(
  candidate: string,
  pattern: string,
  options: FuzzyOptions = {},
): FuzzyMatch | undefined {
  if (pattern === "") return { score: 1, positions: [] }
  if (candidate === "") return undefined
  if (pattern.length > candidate.length) return undefined
  if (candidate.length > 4096) candidate = candidate.slice(0, 4096)

  const caseSensitive =
    options.caseSensitive ??
    (options.smartCase !== false && /[A-Z]/.test(pattern))
  const haystack = caseSensitive ? candidate : candidate.toLowerCase()
  const needle = caseSensitive ? pattern : pattern.toLowerCase()

  // Fast reject: every pattern character must appear in order.
  let cursor = 0
  for (const char of needle) {
    cursor = haystack.indexOf(char, cursor)
    if (cursor < 0) return undefined
    cursor++
  }

  const n = haystack.length
  const m = needle.length

  // score[i][j]: best score for needle[0..i] ending exactly at haystack[j].
  const width = n
  const score = new Int32Array(m * width).fill(-1_000_000)
  const consecutive = new Int32Array(m * width)
  const parent = new Int32Array(m * width).fill(-1)

  for (let j = 0; j < n; j++) {
    if (haystack[j] !== needle[0]) continue
    let value = SCORE_MATCH + bonusAt(candidate, j)
    if (j > 0) value += SCORE_GAP_START + SCORE_GAP_EXTENSION * (j - 1)
    score[j] = value
    consecutive[j] = 1
  }

  for (let i = 1; i < m; i++) {
    const rowOffset = i * width
    const previousOffset = (i - 1) * width
    for (let j = i; j < n; j++) {
      if (haystack[j] !== needle[i]) continue
      let best = -1_000_000
      let bestParent = -1
      let bestConsecutive = 1
      for (let k = i - 1; k < j; k++) {
        const previous = score[previousOffset + k] as number
        if (previous <= -1_000_000) continue
        const gap = j - k - 1
        let value = previous + SCORE_MATCH
        if (gap === 0) {
          const run = (consecutive[previousOffset + k] as number) + 1
          value += BONUS_CONSECUTIVE + Math.min(run, 6)
          if (value > best) {
            best = value
            bestParent = k
            bestConsecutive = run
          }
          continue
        }
        value += SCORE_GAP_START + SCORE_GAP_EXTENSION * (gap - 1) + bonusAt(candidate, j)
        if (value > best) {
          best = value
          bestParent = k
          bestConsecutive = 1
        }
      }
      if (bestParent < 0) continue
      score[rowOffset + j] = best
      parent[rowOffset + j] = bestParent
      consecutive[rowOffset + j] = bestConsecutive
    }
  }

  // Find the best endpoint on the last row.
  const lastOffset = (m - 1) * width
  let bestScore = -1_000_000
  let bestEnd = -1
  for (let j = m - 1; j < n; j++) {
    const value = score[lastOffset + j] as number
    if (value > bestScore) {
      bestScore = value
      bestEnd = j
    }
  }
  if (bestEnd < 0) return undefined

  const positions: number[] = []
  let row = m - 1
  let column = bestEnd
  while (row >= 0 && column >= 0) {
    positions.push(column)
    const previous = parent[row * width + column] as number
    row--
    column = previous
  }
  positions.reverse()

  let total = bestScore
  if (options.prefixBonus && positions[0] === 0) total += options.prefixBonus

  // Reward matches concentrated in the basename of a path.
  if (options.filenameBonus) {
    const slash = candidate.lastIndexOf("/")
    if (slash >= 0) {
      const inName = positions.filter((p) => p > slash).length
      total += Math.round((inName / positions.length) * options.filenameBonus)
    }
  }

  // Shorter candidates with the same alignment quality should win.
  total -= Math.floor(candidate.length / 40)

  return { score: total, positions }
}

export interface RankedItem<T> {
  readonly item: T
  readonly score: number
  readonly positions: number[]
}

export interface RankOptions<T> extends FuzzyOptions {
  readonly key?: (item: T) => string
  /** Secondary key blended in at a lower weight (e.g. a description). */
  readonly secondaryKey?: (item: T) => string | undefined
  readonly limit?: number
  /** Static bias, e.g. recency or frecency, added to the match score. */
  readonly bias?: (item: T) => number
}

/** Ranks and filters a list. Items that do not match are dropped. */
export function rank<T>(
  items: readonly T[],
  pattern: string,
  options: RankOptions<T> = {},
): RankedItem<T>[] {
  const key = options.key ?? ((item: T) => String(item))
  const out: RankedItem<T>[] = []

  for (const item of items) {
    const primary = key(item)
    let match = fuzzyMatch(primary, pattern, options)
    let positions = match?.positions ?? []
    let score = match?.score ?? Number.NEGATIVE_INFINITY

    if (!match && options.secondaryKey) {
      const secondary = options.secondaryKey(item)
      if (secondary) {
        const secondaryMatch = fuzzyMatch(secondary, pattern, options)
        if (secondaryMatch) {
          score = secondaryMatch.score * 0.5
          positions = []
          match = secondaryMatch
        }
      }
    }

    if (!match) continue
    if (options.bias) score += options.bias(item)
    out.push({ item, score, positions })
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return key(a.item).length - key(b.item).length
  })
  return options.limit ? out.slice(0, options.limit) : out
}

/**
 * Multi-term matching: whitespace splits the query into terms that must all
 * match (AND semantics), like fzf's extended search.
 */
export function fuzzyMatchAll(
  candidate: string,
  query: string,
  options: FuzzyOptions = {},
): FuzzyMatch | undefined {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return { score: 1, positions: [] }
  if (terms.length === 1) return fuzzyMatch(candidate, terms[0] as string, options)

  let total = 0
  const positions = new Set<number>()
  for (const term of terms) {
    // Support fzf-style operators.
    if (term.startsWith("!")) {
      const body = term.slice(1)
      if (body && candidate.toLowerCase().includes(body.toLowerCase())) return undefined
      continue
    }
    if (term.startsWith("'")) {
      const body = term.slice(1)
      const index = candidate.toLowerCase().indexOf(body.toLowerCase())
      if (index < 0) return undefined
      total += SCORE_MATCH * body.length
      for (let i = 0; i < body.length; i++) positions.add(index + i)
      continue
    }
    if (term.startsWith("^")) {
      const body = term.slice(1)
      if (!candidate.toLowerCase().startsWith(body.toLowerCase())) return undefined
      total += SCORE_MATCH * body.length + BONUS_BOUNDARY
      for (let i = 0; i < body.length; i++) positions.add(i)
      continue
    }
    if (term.endsWith("$") && term.length > 1) {
      const body = term.slice(0, -1)
      if (!candidate.toLowerCase().endsWith(body.toLowerCase())) return undefined
      total += SCORE_MATCH * body.length
      for (let i = 0; i < body.length; i++) positions.add(candidate.length - body.length + i)
      continue
    }
    const match = fuzzyMatch(candidate, term, options)
    if (!match) return undefined
    total += match.score
    for (const position of match.positions) positions.add(position)
  }
  return { score: total, positions: [...positions].sort((a, b) => a - b) }
}

/**
 * Frecency score: recent *and* frequent items rank highest. Used to order file
 * completions and model choices by what the user actually uses.
 */
export function frecency(visits: readonly number[], now = Date.now()): number {
  let score = 0
  for (const at of visits) {
    const ageHours = (now - at) / 3_600_000
    if (ageHours < 1) score += 100
    else if (ageHours < 24) score += 60
    else if (ageHours < 24 * 7) score += 30
    else if (ageHours < 24 * 30) score += 10
    else score += 2
  }
  return score
}

/** Highlights matched positions by wrapping them with the given markers. */
export function highlight(
  candidate: string,
  positions: readonly number[],
  open: string,
  close: string,
): string {
  if (positions.length === 0) return candidate
  const set = new Set(positions)
  let out = ""
  let inside = false
  for (let i = 0; i < candidate.length; i++) {
    const isMatch = set.has(i)
    if (isMatch && !inside) {
      out += open
      inside = true
    } else if (!isMatch && inside) {
      out += close
      inside = false
    }
    out += candidate[i]
  }
  if (inside) out += close
  return out
}

/** Simple substring-based scorer for very large candidate sets. */
export function quickScore(candidate: string, pattern: string): number {
  if (pattern === "") return 1
  const haystack = candidate.toLowerCase()
  const needle = pattern.toLowerCase()
  const index = haystack.indexOf(needle)
  if (index < 0) return 0
  let score = 100 - index
  if (index === 0) score += 50
  const slash = candidate.lastIndexOf("/")
  if (slash >= 0 && index > slash) score += 30
  score -= Math.floor(candidate.length / 20)
  return Math.max(1, score)
}
