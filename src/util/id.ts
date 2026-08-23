/**
 * Identifier generation.
 *
 * Praxis identifiers are prefixed, lexicographically sortable and
 * monotonically increasing within a process. Sessions and messages rely on the
 * sort order for cheap "latest first" queries without an extra timestamp index.
 *
 * Layout: `<prefix>_<48-bit millis, base32><random/counter tail, base32>`.
 */

import crypto from "node:crypto"

/** Crockford base32 without I, L, O, U to stay copy/paste friendly. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const TIME_LEN = 10
const RAND_LEN = 14

export const IdPrefix = {
  session: "ses",
  message: "msg",
  part: "prt",
  permission: "per",
  todo: "tdo",
  snapshot: "snp",
  task: "tsk",
  tool: "tul",
  file: "fil",
  request: "req",
  share: "shr",
  plugin: "plg",
  attachment: "att",
  diagnostic: "dgn",
  event: "evt",
} as const

export type IdKind = keyof typeof IdPrefix
export type Id<K extends IdKind = IdKind> = string & { readonly __idKind?: K }

let lastTime = 0
let lastRandom: number[] = []

function encodeTime(now: number, length: number): string {
  let out = ""
  let value = now
  for (let i = length - 1; i >= 0; i--) {
    const mod = value % 32
    out = ALPHABET[mod] + out
    value = (value - mod) / 32
  }
  return out
}

function randomChars(length: number): number[] {
  const bytes = crypto.randomBytes(length)
  const out: number[] = []
  for (let i = 0; i < length; i++) out.push((bytes[i] as number) % 32)
  return out
}

/** Increments the random tail in place so ids stay ordered inside a millisecond. */
function bumpRandom(chars: number[]): number[] {
  const out = chars.slice()
  for (let i = out.length - 1; i >= 0; i--) {
    if ((out[i] as number) < 31) {
      out[i] = (out[i] as number) + 1
      return out
    }
    out[i] = 0
  }
  return randomChars(out.length)
}

function monotonicTail(now: number): string {
  if (now === lastTime) {
    lastRandom = bumpRandom(lastRandom)
  } else {
    lastTime = now
    lastRandom = randomChars(RAND_LEN)
  }
  return lastRandom.map((c) => ALPHABET[c]).join("")
}

/** Ascending, sortable identifier. */
export function newId<K extends IdKind>(kind: K, at = Date.now()): Id<K> {
  return `${IdPrefix[kind]}_${encodeTime(at, TIME_LEN)}${monotonicTail(at)}` as Id<K>
}

/**
 * Descending identifier: the timestamp is bitwise-inverted so that newer ids
 * sort *first* in a plain string index. Used for session listings.
 */
export function newDescendingId<K extends IdKind>(kind: K, at = Date.now()): Id<K> {
  const inverted = 0xffffffffffff - at
  return `${IdPrefix[kind]}_${encodeTime(inverted, TIME_LEN)}${monotonicTail(at)}` as Id<K>
}

export function idKind(id: string): IdKind | undefined {
  const prefix = id.split("_", 1)[0]
  for (const [kind, value] of Object.entries(IdPrefix)) {
    if (value === prefix) return kind as IdKind
  }
  return undefined
}

export function isId(id: unknown, kind?: IdKind): boolean {
  if (typeof id !== "string") return false
  const match = /^([a-z]{3})_([0-9A-HJKMNP-TV-Z]{24})$/.exec(id)
  if (!match) return false
  if (!kind) return idKind(id) !== undefined
  return match[1] === IdPrefix[kind]
}

function decodeBase32(input: string): number {
  let value = 0
  for (const ch of input) {
    const index = ALPHABET.indexOf(ch)
    if (index < 0) return Number.NaN
    value = value * 32 + index
  }
  return value
}

/** Recovers the creation timestamp from an ascending id. */
export function idTimestamp(id: string): number | undefined {
  const body = id.slice(id.indexOf("_") + 1, id.indexOf("_") + 1 + TIME_LEN)
  const value = decodeBase32(body)
  return Number.isFinite(value) ? value : undefined
}

/** Recovers the creation timestamp from a descending id. */
export function descendingIdTimestamp(id: string): number | undefined {
  const raw = idTimestamp(id)
  if (raw === undefined) return undefined
  return 0xffffffffffff - raw
}

/** Short, human-typable identifier used for share links and log correlation. */
export function shortId(length = 8): string {
  const chars = randomChars(length)
  return chars.map((c) => ALPHABET[c]).join("").toLowerCase()
}

/** Stable identifier derived from content, used for dedupe keys. */
export function contentId(input: string, length = 12): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length)
}

export function uuid(): string {
  return crypto.randomUUID()
}

/** Opaque tool-call ids some providers require to be short and alphanumeric. */
export function toolCallId(length = 9): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  const bytes = crypto.randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) out += alphabet[(bytes[i] as number) % alphabet.length]
  return out
}
