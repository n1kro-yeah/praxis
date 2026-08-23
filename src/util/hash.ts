/**
 * Non-cryptographic hashes.
 *
 * Used for cache keys (provider SDK instances, compiled schemas, syntax
 * highlight results), content fingerprints and stable colour derivation for
 * session avatars. Node's crypto module is overkill and slow for these.
 */

import crypto from "node:crypto"

/** xxHash32 — fast, well-distributed, excellent for short keys. */
export function xxhash32(input: string | Uint8Array, seed = 0): number {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input
  const PRIME1 = 0x9e3779b1
  const PRIME2 = 0x85ebca77
  const PRIME3 = 0xc2b2ae3d
  const PRIME4 = 0x27d4eb2f
  const PRIME5 = 0x165667b1

  const length = data.length
  let index = 0
  let h32: number

  const rotl = (value: number, shift: number) => (value << shift) | (value >>> (32 - shift))
  const readU32 = (offset: number) =>
    ((data[offset] as number) |
      ((data[offset + 1] as number) << 8) |
      ((data[offset + 2] as number) << 16) |
      ((data[offset + 3] as number) << 24)) >>>
    0

  if (length >= 16) {
    let v1 = (seed + PRIME1 + PRIME2) | 0
    let v2 = (seed + PRIME2) | 0
    let v3 = seed | 0
    let v4 = (seed - PRIME1) | 0
    const limit = length - 16
    while (index <= limit) {
      v1 = Math.imul(rotl((v1 + Math.imul(readU32(index), PRIME2)) | 0, 13), PRIME1)
      index += 4
      v2 = Math.imul(rotl((v2 + Math.imul(readU32(index), PRIME2)) | 0, 13), PRIME1)
      index += 4
      v3 = Math.imul(rotl((v3 + Math.imul(readU32(index), PRIME2)) | 0, 13), PRIME1)
      index += 4
      v4 = Math.imul(rotl((v4 + Math.imul(readU32(index), PRIME2)) | 0, 13), PRIME1)
      index += 4
    }
    h32 = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0
  } else {
    h32 = (seed + PRIME5) | 0
  }

  h32 = (h32 + length) | 0

  while (index + 4 <= length) {
    h32 = Math.imul(rotl((h32 + Math.imul(readU32(index), PRIME3)) | 0, 17), PRIME4)
    index += 4
  }

  while (index < length) {
    h32 = Math.imul(rotl((h32 + Math.imul(data[index] as number, PRIME5)) | 0, 11), PRIME1)
    index++
  }

  h32 ^= h32 >>> 15
  h32 = Math.imul(h32, PRIME2)
  h32 ^= h32 >>> 13
  h32 = Math.imul(h32, PRIME3)
  h32 ^= h32 >>> 16
  return h32 >>> 0
}

/** FNV-1a 64-bit, returned as a hex string. Good for content fingerprints. */
export function fnv1a64(input: string): string {
  const OFFSET = 0xcbf29ce484222325n
  const PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn
  let hash = OFFSET
  const bytes = new TextEncoder().encode(input)
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * PRIME) & MASK
  }
  return hash.toString(16).padStart(16, "0")
}

/** MurmurHash3 (32-bit) — used for bloom-style dedupe of doom-loop signatures. */
export function murmur3(input: string, seed = 0): number {
  const data = new TextEncoder().encode(input)
  const c1 = 0xcc9e2d51
  const c2 = 0x1b873593
  let h1 = seed
  const blocks = Math.floor(data.length / 4)

  for (let i = 0; i < blocks; i++) {
    const offset = i * 4
    let k1 =
      ((data[offset] as number) |
        ((data[offset + 1] as number) << 8) |
        ((data[offset + 2] as number) << 16) |
        ((data[offset + 3] as number) << 24)) >>>
      0
    k1 = Math.imul(k1, c1)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, c2)
    h1 ^= k1
    h1 = (h1 << 13) | (h1 >>> 19)
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0
  }

  let k1 = 0
  const tail = blocks * 4
  switch (data.length & 3) {
    case 3:
      k1 ^= (data[tail + 2] as number) << 16
    // falls through
    case 2:
      k1 ^= (data[tail + 1] as number) << 8
    // falls through
    case 1:
      k1 ^= data[tail] as number
      k1 = Math.imul(k1, c1)
      k1 = (k1 << 15) | (k1 >>> 17)
      k1 = Math.imul(k1, c2)
      h1 ^= k1
      break
    default:
      break
  }

  h1 ^= data.length
  h1 ^= h1 >>> 16
  h1 = Math.imul(h1, 0x85ebca6b)
  h1 ^= h1 >>> 13
  h1 = Math.imul(h1, 0xc2b2ae35)
  h1 ^= h1 >>> 16
  return h1 >>> 0
}

/** Stable cache key from an arbitrary structure (key order independent). */
export function structuralKey(value: unknown): string {
  return fnv1a64(stableStringify(value))
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (input: unknown): string => {
    if (input === null) return "null"
    if (input === undefined) return "undefined"
    const type = typeof input
    if (type === "number" || type === "boolean") return String(input)
    if (type === "bigint") return `${input}n`
    if (type === "string") return JSON.stringify(input)
    if (type === "function") return `"[fn ${(input as { name?: string }).name ?? "anonymous"}]"`
    if (Array.isArray(input)) return `[${input.map(walk).join(",")}]`
    if (input instanceof Date) return `"${input.toISOString()}"`
    if (input instanceof RegExp) return `"${input.source}/${input.flags}"`
    if (type === "object") {
      const object = input as Record<string, unknown>
      if (seen.has(object)) return '"[circular]"'
      seen.add(object)
      const keys = Object.keys(object).sort()
      const body = keys.map((key) => `${JSON.stringify(key)}:${walk(object[key])}`).join(",")
      seen.delete(object)
      return `{${body}}`
    }
    return '"[unknown]"'
  }
  return walk(value)
}

export function sha256(input: string | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export function sha1(input: string | Uint8Array): string {
  return crypto.createHash("sha1").update(input).digest("hex")
}

export function base64url(input: string | Uint8Array): string {
  return Buffer.from(input as Uint8Array).toString("base64url")
}

export function fromBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url")
}

/** Constant-time comparison for token verification. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/** Maps an arbitrary string to a stable hue, used for author colours. */
export function stableHue(input: string): number {
  return xxhash32(input) % 360
}

/** Short, stable, human-readable fingerprint. */
export function fingerprint(input: string, length = 8): string {
  return fnv1a64(input).slice(0, length)
}

/**
 * Rolling hash over lines, used by the snapshot layer to detect whether a file
 * changed without re-reading its whole contents.
 */
export class RollingHash {
  private value = 0

  update(chunk: string): this {
    this.value = xxhash32(chunk, this.value)
    return this
  }

  digest(): string {
    return (this.value >>> 0).toString(16).padStart(8, "0")
  }

  reset(): void {
    this.value = 0
  }
}
