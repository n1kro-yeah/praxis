/**
 * JSON with Comments (JSONC) parser and surgical editor.
 *
 * Configuration files support `//` and block comments, trailing commas and
 * single-quoted strings. The editor half lets `praxis auth login` and
 * `praxis config set` modify a user's config file without destroying their
 * comments or formatting.
 */

import { ConfigError } from "./error.js"

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

interface Token {
  readonly type:
    | "{"
    | "}"
    | "["
    | "]"
    | ":"
    | ","
    | "string"
    | "number"
    | "true"
    | "false"
    | "null"
    | "eof"
  readonly value?: string | number | boolean | null
  readonly start: number
  readonly end: number
  readonly line: number
  readonly column: number
}

class Lexer {
  private index = 0
  private line = 1
  private lineStart = 0

  constructor(private readonly source: string) {}

  private get char(): string {
    return this.source[this.index] ?? ""
  }

  private advance(count = 1): void {
    for (let i = 0; i < count; i++) {
      if (this.source[this.index] === "\n") {
        this.line++
        this.lineStart = this.index + 1
      }
      this.index++
    }
  }

  private skipTrivia(): void {
    for (;;) {
      const char = this.char
      if (char === "" ) return
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\ufeff") {
        this.advance()
        continue
      }
      if (char === "/" && this.source[this.index + 1] === "/") {
        while (this.char !== "" && this.char !== "\n") this.advance()
        continue
      }
      if (char === "/" && this.source[this.index + 1] === "*") {
        this.advance(2)
        while (this.char !== "" && !(this.char === "*" && this.source[this.index + 1] === "/")) {
          this.advance()
        }
        this.advance(2)
        continue
      }
      return
    }
  }

  private fail(message: string): never {
    throw new ConfigError({
      detail: `${message} at line ${this.line}, column ${this.index - this.lineStart + 1}`,
    })
  }

  private readString(quote: string): Token {
    const start = this.index
    const startLine = this.line
    const startColumn = this.index - this.lineStart
    this.advance() // opening quote
    let out = ""
    for (;;) {
      const char = this.char
      if (char === "") this.fail("unterminated string")
      if (char === quote) {
        this.advance()
        break
      }
      if (char === "\\") {
        this.advance()
        const escape = this.char
        this.advance()
        switch (escape) {
          case "n":
            out += "\n"
            break
          case "t":
            out += "\t"
            break
          case "r":
            out += "\r"
            break
          case "b":
            out += "\b"
            break
          case "f":
            out += "\f"
            break
          case "v":
            out += "\v"
            break
          case "0":
            out += "\0"
            break
          case "/":
            out += "/"
            break
          case "\\":
            out += "\\"
            break
          case "'":
            out += "'"
            break
          case '"':
            out += '"'
            break
          case "\n":
            break // line continuation
          case "u": {
            const hex = this.source.slice(this.index, this.index + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid unicode escape")
            out += String.fromCharCode(parseInt(hex, 16))
            this.advance(4)
            break
          }
          case "x": {
            const hex = this.source.slice(this.index, this.index + 2)
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail("invalid hex escape")
            out += String.fromCharCode(parseInt(hex, 16))
            this.advance(2)
            break
          }
          default:
            out += escape
        }
        continue
      }
      out += char
      this.advance()
    }
    return {
      type: "string",
      value: out,
      start,
      end: this.index,
      line: startLine,
      column: startColumn,
    }
  }

  next(): Token {
    this.skipTrivia()
    const start = this.index
    const line = this.line
    const column = this.index - this.lineStart
    const char = this.char

    if (char === "") return { type: "eof", start, end: start, line, column }

    if (char === '"' || char === "'") return this.readString(char)

    if ("{}[]:,".includes(char)) {
      this.advance()
      return { type: char as Token["type"], start, end: this.index, line, column }
    }

    const word = /^(true|false|null|Infinity|-Infinity|NaN)/.exec(this.source.slice(this.index))
    if (word) {
      const text = word[0]
      this.advance(text.length)
      if (text === "true") return { type: "true", value: true, start, end: this.index, line, column }
      if (text === "false")
        return { type: "false", value: false, start, end: this.index, line, column }
      if (text === "null") return { type: "null", value: null, start, end: this.index, line, column }
      const numeric = text === "NaN" ? Number.NaN : text.startsWith("-") ? -Infinity : Infinity
      return { type: "number", value: numeric, start, end: this.index, line, column }
    }

    const number = /^-?(?:0[xX][0-9a-fA-F]+|(?:0|[1-9]\d*|\.\d+|\d+\.\d*)(?:[eE][+-]?\d+)?)/.exec(
      this.source.slice(this.index),
    )
    if (number) {
      const text = number[0]
      this.advance(text.length)
      return { type: "number", value: Number(text), start, end: this.index, line, column }
    }

    // Unquoted object keys (relaxed JSON5 behaviour).
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(this.source.slice(this.index))
    if (identifier) {
      const text = identifier[0]
      this.advance(text.length)
      return { type: "string", value: text, start, end: this.index, line, column }
    }

    this.fail(`unexpected character ${JSON.stringify(char)}`)
  }
}

export interface ParseOptions {
  /** Path used in error messages. */
  readonly source?: string
  /** Reject duplicate object keys instead of last-wins. */
  readonly strictKeys?: boolean
}

/** Parses JSONC/JSON5-ish text into a JavaScript value. */
export function parseJsonc(text: string, options: ParseOptions = {}): JsonValue {
  const lexer = new Lexer(text)
  let token = lexer.next()

  const advance = () => {
    token = lexer.next()
  }

  const fail = (message: string): never => {
    throw new ConfigError({
      path: options.source,
      detail: `${message} at line ${token.line}, column ${token.column + 1}`,
    })
  }

  const parseValue = (depth: number): JsonValue => {
    if (depth > 200) fail("nesting too deep")
    switch (token.type) {
      case "{": {
        advance()
        const out: Record<string, JsonValue> = {}
        if (token.type === "}") {
          advance()
          return out
        }
        for (;;) {
          if (token.type === "}") {
            advance()
            return out
          }
          if (token.type !== "string") fail("expected object key")
          const key = token.value as string
          if (options.strictKeys && key in out) fail(`duplicate key "${key}"`)
          advance()
          if (token.type !== ":") fail('expected ":"')
          advance()
          out[key] = parseValue(depth + 1)
          if (token.type === ",") {
            advance()
            continue
          }
          if (token.type === "}") {
            advance()
            return out
          }
          fail('expected "," or "}"')
        }
      }
      case "[": {
        advance()
        const out: JsonValue[] = []
        if (token.type === "]") {
          advance()
          return out
        }
        for (;;) {
          if (token.type === "]") {
            advance()
            return out
          }
          out.push(parseValue(depth + 1))
          if (token.type === ",") {
            advance()
            continue
          }
          if (token.type === "]") {
            advance()
            return out
          }
          fail('expected "," or "]"')
        }
      }
      case "string":
      case "number":
      case "true":
      case "false":
      case "null": {
        const value = token.value as JsonValue
        advance()
        return value
      }
      default:
        return fail(`unexpected token ${token.type}`)
    }
  }

  const result = parseValue(0)
  if (token.type !== "eof") fail("unexpected trailing content")
  return result
}

export function tryParseJsonc(text: string, options?: ParseOptions): JsonValue | undefined {
  try {
    return parseJsonc(text, options)
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* Surgical editing                                                    */
/* ------------------------------------------------------------------ */

export type JsonPath = Array<string | number>

interface Located {
  readonly valueStart: number
  readonly valueEnd: number
  /** Start of `"key": value` including the key, for deletions. */
  readonly entryStart?: number
  readonly entryEnd?: number
  readonly container: "object" | "array"
  readonly containerStart: number
  readonly containerEnd: number
  readonly isEmpty: boolean
  readonly lastChildEnd?: number
}

/** Walks the token stream to locate a path, recording byte offsets. */
function locate(text: string, jsonPath: JsonPath): Located | undefined {
  const lexer = new Lexer(text)
  let token = lexer.next()
  const advance = () => {
    token = lexer.next()
  }

  const skipValue = (): void => {
    if (token.type === "{" || token.type === "[") {
      const closer = token.type === "{" ? "}" : "]"
      let depth = 0
      for (;;) {
        if (token.type === "{" || token.type === "[") depth++
        else if (token.type === "}" || token.type === "]") {
          depth--
          if (depth === 0) {
            advance()
            return
          }
        } else if (token.type === "eof") return
        advance()
      }
    }
    advance()
  }

  const descend = (depth: number): Located | undefined => {
    const key = jsonPath[depth]
    const containerStart = token.start

    if (token.type === "{") {
      advance()
      let lastChildEnd: number | undefined
      let isEmpty = true
      for (;;) {
        if (token.type === "}") {
          const containerEnd = token.end
          advance()
          if (typeof key === "string") {
            return {
              valueStart: -1,
              valueEnd: -1,
              container: "object",
              containerStart,
              containerEnd,
              isEmpty,
              lastChildEnd,
            }
          }
          return undefined
        }
        if (token.type === "eof") return undefined
        if (token.type !== "string") {
          advance()
          continue
        }
        isEmpty = false
        const entryStart = token.start
        const name = token.value as string
        advance()
        if (token.type !== ":") return undefined
        advance()
        const valueStart = token.start
        if (name === key) {
          if (depth === jsonPath.length - 1) {
            const start = token.start
            skipValue()
            return {
              valueStart: start,
              valueEnd: previousEnd(text, token.start),
              entryStart,
              entryEnd: previousEnd(text, token.start),
              container: "object",
              containerStart,
              containerEnd: -1,
              isEmpty: false,
            }
          }
          return descend(depth + 1)
        }
        skipValue()
        lastChildEnd = previousEnd(text, token.start)
        if (token.type === ",") advance()
      }
    }

    if (token.type === "[") {
      advance()
      let index = 0
      let lastChildEnd: number | undefined
      let isEmpty = true
      for (;;) {
        if (token.type === "]") {
          const containerEnd = token.end
          advance()
          if (typeof key === "number") {
            return {
              valueStart: -1,
              valueEnd: -1,
              container: "array",
              containerStart,
              containerEnd,
              isEmpty,
              lastChildEnd,
            }
          }
          return undefined
        }
        if (token.type === "eof") return undefined
        isEmpty = false
        const valueStart = token.start
        if (index === key) {
          if (depth === jsonPath.length - 1) {
            skipValue()
            return {
              valueStart,
              valueEnd: previousEnd(text, token.start),
              entryStart: valueStart,
              entryEnd: previousEnd(text, token.start),
              container: "array",
              containerStart,
              containerEnd: -1,
              isEmpty: false,
            }
          }
          return descend(depth + 1)
        }
        skipValue()
        lastChildEnd = previousEnd(text, token.start)
        if (token.type === ",") advance()
        index++
      }
    }

    return undefined
  }

  if (jsonPath.length === 0) return undefined
  return descend(0)
}

/** Trims trailing whitespace/commas so replacements stay tidy. */
function previousEnd(text: string, index: number): number {
  let end = Math.min(index, text.length)
  while (end > 0) {
    const ch = text[end - 1]
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === ",") {
      end--
      continue
    }
    break
  }
  return end
}

function detectIndent(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text)
  return match?.[1] ?? "  "
}

function serialize(value: JsonValue, indent: string, level: number): string {
  const pad = indent.repeat(level)
  const padInner = indent.repeat(level + 1)
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const items = value.map((v) => padInner + serialize(v, indent, level + 1))
    return `[\n${items.join(",\n")}\n${pad}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return "{}"
  const items = entries.map(
    ([k, v]) => `${padInner}${JSON.stringify(k)}: ${serialize(v, indent, level + 1)}`,
  )
  return `{\n${items.join(",\n")}\n${pad}}`
}

function lineIndentAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1
  const match = /^[ \t]*/.exec(text.slice(lineStart, index))
  return match?.[0] ?? ""
}

/**
 * Sets a value at `jsonPath`, preserving surrounding comments and formatting.
 * Missing intermediate objects are created.
 */
export function setJsoncValue(text: string, jsonPath: JsonPath, value: JsonValue): string {
  if (jsonPath.length === 0) return serialize(value, detectIndent(text), 0)
  const indent = detectIndent(text)

  // Create missing ancestors from the deepest existing prefix.
  for (let depth = jsonPath.length; depth > 0; depth--) {
    const prefix = jsonPath.slice(0, depth)
    const found = locate(text, prefix)
    if (!found) continue

    if (found.valueStart >= 0) {
      // Existing leaf: replace in place.
      if (depth === jsonPath.length) {
        const level = countDepth(text, found.valueStart)
        const replacement = serialize(value, indent, level)
        return text.slice(0, found.valueStart) + replacement + text.slice(found.valueEnd)
      }
      // Existing intermediate container: recurse into it.
      const nested = setJsoncValue(
        text.slice(found.valueStart, found.valueEnd),
        jsonPath.slice(depth),
        value,
      )
      return text.slice(0, found.valueStart) + nested + text.slice(found.valueEnd)
    }

    // Container exists but the key is absent: insert a new entry.
    const remaining = jsonPath.slice(depth - 1)
    let payload: JsonValue = value
    for (let i = remaining.length - 1; i >= 1; i--) {
      const key = remaining[i]
      payload = typeof key === "number" ? [payload] : { [String(key)]: payload }
    }
    const key = remaining[0]
    const level = countDepth(text, found.containerStart) + 1
    const entryIndent = indent.repeat(level)
    const serialized = serialize(payload, indent, level)
    const entry =
      found.container === "object"
        ? `${JSON.stringify(String(key))}: ${serialized}`
        : serialized

    if (found.isEmpty) {
      const closerIndent = lineIndentAt(text, found.containerStart)
      return (
        text.slice(0, found.containerStart + 1) +
        `\n${entryIndent}${entry}\n${closerIndent}` +
        text.slice(found.containerEnd - 1)
      )
    }
    const insertAt = found.lastChildEnd ?? found.containerEnd - 1
    return text.slice(0, insertAt) + `,\n${entryIndent}${entry}` + text.slice(insertAt)
  }

  // Nothing existed at all: rebuild from a parsed copy.
  const parsed = (tryParseJsonc(text) ?? {}) as Record<string, JsonValue>
  let cursor: any = parsed
  for (let i = 0; i < jsonPath.length - 1; i++) {
    const key = jsonPath[i] as string | number
    if (cursor[key] === undefined || typeof cursor[key] !== "object") {
      cursor[key] = typeof jsonPath[i + 1] === "number" ? [] : {}
    }
    cursor = cursor[key]
  }
  cursor[jsonPath[jsonPath.length - 1] as string] = value
  return serialize(parsed as JsonValue, indent, 0) + "\n"
}

function countDepth(text: string, index: number): number {
  let depth = 0
  let inString = false
  let quote = ""
  for (let i = 0; i < index; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === "\\") i++
      else if (ch === quote) inString = false
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      continue
    }
    if (ch === "{" || ch === "[") depth++
    else if (ch === "}" || ch === "]") depth--
  }
  return Math.max(0, depth)
}

/** Removes the entry at `jsonPath`, leaving surrounding text untouched. */
export function deleteJsoncValue(text: string, jsonPath: JsonPath): string {
  const found = locate(text, jsonPath)
  if (!found || found.entryStart === undefined || found.entryEnd === undefined) return text
  let start = found.entryStart
  let end = found.entryEnd
  // Swallow a preceding comma and the whitespace before the entry.
  let cursor = start - 1
  while (cursor >= 0 && /[ \t]/.test(text[cursor] as string)) cursor--
  if (text[cursor] === ",") {
    start = cursor
  } else {
    // First entry: swallow the trailing comma instead.
    let after = end
    while (after < text.length && /[ \t\r\n]/.test(text[after] as string)) after++
    if (text[after] === ",") end = after + 1
  }
  // Collapse the now-empty line.
  let lineStart = start
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--
  if (text.slice(lineStart, start).trim() === "") start = lineStart > 0 ? lineStart - 1 : 0
  return text.slice(0, start) + text.slice(end)
}

/** Pretty-prints a value as JSONC with a `$schema` hint first. */
export function formatJsonc(value: JsonValue, indent = "  "): string {
  return serialize(value, indent, 0) + "\n"
}

/** Strips comments so the result can be fed to `JSON.parse`. */
export function stripComments(text: string): string {
  let out = ""
  let i = 0
  let inString = false
  let quote = ""
  while (i < text.length) {
    const ch = text[i] as string
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === quote) inString = false
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}
