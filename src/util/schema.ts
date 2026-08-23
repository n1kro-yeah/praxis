/**
 * A compact runtime schema library.
 *
 * Praxis needs schema validation in three places: configuration files, tool
 * parameters (which must also be expressible as JSON Schema for the LLM), and
 * RPC payloads. Rather than depending on an external validator we implement a
 * focused subset with the two features that actually matter: precise error
 * paths and faithful JSON Schema emission.
 */

import { ValidationError } from "./error.js"

export interface Issue {
  readonly path: string
  readonly message: string
}

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: Issue[] }

export interface JsonSchema {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  const?: unknown
  default?: unknown
  examples?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema | JsonSchema[]
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  nullable?: boolean
  title?: string
  $ref?: string
  $defs?: Record<string, JsonSchema>
  [key: string]: unknown
}

class Context {
  readonly issues: Issue[] = []
  private readonly stack: Array<string | number> = []

  push(key: string | number): void {
    this.stack.push(key)
  }

  pop(): void {
    this.stack.pop()
  }

  get path(): string {
    let out = ""
    for (const segment of this.stack) {
      if (typeof segment === "number") out += `[${segment}]`
      else out += out ? `.${segment}` : segment
    }
    return out
  }

  fail(message: string): typeof INVALID {
    this.issues.push({ path: this.path, message })
    return INVALID
  }
}

const INVALID = Symbol("invalid")
type Invalid = typeof INVALID

export abstract class Schema<T> {
  abstract readonly typeName: string
  protected descriptionText?: string
  protected defaultValue?: () => T
  protected hasDefault = false
  protected examplesList?: unknown[]
  protected checks: Array<{ fn: (value: T) => boolean | string; message: string }> = []

  /** @internal */
  abstract decode(input: unknown, ctx: Context): T | Invalid

  /** @internal */
  abstract emit(): JsonSchema

  describe(text: string): this {
    const clone = this.clone()
    clone.descriptionText = text
    return clone
  }

  get description(): string | undefined {
    return this.descriptionText
  }

  examples(...values: unknown[]): this {
    const clone = this.clone()
    clone.examplesList = values
    return clone
  }

  default(value: T | (() => T)): Schema<T> {
    const clone = this.clone()
    clone.hasDefault = true
    clone.defaultValue = typeof value === "function" ? (value as () => T) : () => value
    return clone
  }

  optional(): Schema<T | undefined> {
    return new OptionalSchema(this)
  }

  nullable(): Schema<T | null> {
    return new NullableSchema(this)
  }

  nullish(): Schema<T | null | undefined> {
    return new OptionalSchema(new NullableSchema(this))
  }

  refine(fn: (value: T) => boolean | string, message = "failed refinement"): this {
    const clone = this.clone()
    clone.checks = [...this.checks, { fn, message }]
    return clone
  }

  transform<R>(fn: (value: T) => R): Schema<R> {
    return new TransformSchema(this, fn)
  }

  /** Duplicates the schema so modifiers stay immutable. */
  protected clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this
    Object.assign(copy, this)
    return copy
  }

  protected runChecks(value: T, ctx: Context): T | Invalid {
    for (const check of this.checks) {
      const result = check.fn(value)
      if (result === true) continue
      return ctx.fail(typeof result === "string" ? result : check.message)
    }
    return value
  }

  /** @internal */
  applyDefault(): { present: boolean; value?: T } {
    if (!this.hasDefault || !this.defaultValue) return { present: false }
    return { present: true, value: this.defaultValue() }
  }

  safeParse(input: unknown): ParseResult<T> {
    const ctx = new Context()
    if (input === undefined && this.hasDefault && this.defaultValue) {
      return { ok: true, value: this.defaultValue() }
    }
    const value = this.decode(input, ctx)
    if (value === INVALID || ctx.issues.length) {
      return { ok: false, issues: ctx.issues.length ? ctx.issues : [{ path: "", message: "invalid" }] }
    }
    return { ok: true, value: value as T }
  }

  parse(input: unknown, source?: string): T {
    const result = this.safeParse(input)
    if (result.ok) return result.value
    throw new ValidationError({ issues: result.issues, source })
  }

  is(input: unknown): input is T {
    return this.safeParse(input).ok
  }

  jsonSchema(): JsonSchema {
    const base = this.emit()
    if (this.descriptionText) base.description = this.descriptionText
    if (this.examplesList) base.examples = this.examplesList
    if (this.hasDefault && this.defaultValue) {
      try {
        base.default = this.defaultValue() as unknown
      } catch {
        /* defaults that throw are simply omitted */
      }
    }
    return base
  }
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export interface StringOptions {
  readonly min?: number
  readonly max?: number
  readonly pattern?: RegExp
  readonly format?: string
  readonly trim?: boolean
  readonly nonEmpty?: boolean
}

class StringSchema extends Schema<string> {
  readonly typeName = "string"
  constructor(private readonly options: StringOptions = {}) {
    super()
  }

  min(n: number): StringSchema {
    return this.with({ min: n })
  }
  max(n: number): StringSchema {
    return this.with({ max: n })
  }
  regex(pattern: RegExp): StringSchema {
    return this.with({ pattern })
  }
  nonEmpty(): StringSchema {
    return this.with({ nonEmpty: true })
  }
  trimmed(): StringSchema {
    return this.with({ trim: true })
  }
  format(name: string): StringSchema {
    return this.with({ format: name })
  }
  url(): StringSchema {
    return this.with({ format: "uri" }).refine((value) => {
      try {
        new URL(value)
        return true
      } catch {
        return "must be a valid URL"
      }
    })
  }
  email(): StringSchema {
    return this.with({ format: "email", pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ })
  }

  private with(extra: StringOptions): StringSchema {
    const next = new StringSchema({ ...this.options, ...extra })
    next.descriptionText = this.descriptionText
    next.checks = this.checks
    next.hasDefault = this.hasDefault
    next.defaultValue = this.defaultValue
    next.examplesList = this.examplesList
    return next
  }

  decode(input: unknown, ctx: Context): string | Invalid {
    if (typeof input !== "string") return ctx.fail(`expected string, received ${typeName(input)}`)
    const value = this.options.trim ? input.trim() : input
    if (this.options.nonEmpty && value.length === 0) return ctx.fail("must not be empty")
    if (this.options.min !== undefined && value.length < this.options.min)
      return ctx.fail(`must be at least ${this.options.min} characters`)
    if (this.options.max !== undefined && value.length > this.options.max)
      return ctx.fail(`must be at most ${this.options.max} characters`)
    if (this.options.pattern && !this.options.pattern.test(value))
      return ctx.fail(`must match ${this.options.pattern}`)
    return this.runChecks(value, ctx)
  }

  emit(): JsonSchema {
    const out: JsonSchema = { type: "string" }
    if (this.options.min !== undefined) out.minLength = this.options.min
    if (this.options.nonEmpty && out.minLength === undefined) out.minLength = 1
    if (this.options.max !== undefined) out.maxLength = this.options.max
    if (this.options.pattern) out.pattern = this.options.pattern.source
    if (this.options.format) out.format = this.options.format
    return out
  }
}

interface NumberOptions {
  readonly int?: boolean
  readonly min?: number
  readonly max?: number
  readonly exclusiveMin?: number
  readonly exclusiveMax?: number
  readonly multipleOf?: number
}

class NumberSchema extends Schema<number> {
  readonly typeName = "number"
  constructor(private readonly options: NumberOptions = {}) {
    super()
  }

  int(): NumberSchema {
    return this.with({ int: true })
  }
  min(n: number): NumberSchema {
    return this.with({ min: n })
  }
  max(n: number): NumberSchema {
    return this.with({ max: n })
  }
  positive(): NumberSchema {
    return this.with({ exclusiveMin: 0 })
  }
  nonNegative(): NumberSchema {
    return this.with({ min: 0 })
  }
  multipleOf(n: number): NumberSchema {
    return this.with({ multipleOf: n })
  }

  private with(extra: NumberOptions): NumberSchema {
    const next = new NumberSchema({ ...this.options, ...extra })
    next.descriptionText = this.descriptionText
    next.checks = this.checks
    next.hasDefault = this.hasDefault
    next.defaultValue = this.defaultValue
    return next
  }

  decode(input: unknown, ctx: Context): number | Invalid {
    const value = typeof input === "string" && input.trim() !== "" ? Number(input) : input
    if (typeof value !== "number" || !Number.isFinite(value))
      return ctx.fail(`expected number, received ${typeName(input)}`)
    if (this.options.int && !Number.isInteger(value)) return ctx.fail("must be an integer")
    if (this.options.min !== undefined && value < this.options.min)
      return ctx.fail(`must be >= ${this.options.min}`)
    if (this.options.max !== undefined && value > this.options.max)
      return ctx.fail(`must be <= ${this.options.max}`)
    if (this.options.exclusiveMin !== undefined && value <= this.options.exclusiveMin)
      return ctx.fail(`must be > ${this.options.exclusiveMin}`)
    if (this.options.exclusiveMax !== undefined && value >= this.options.exclusiveMax)
      return ctx.fail(`must be < ${this.options.exclusiveMax}`)
    if (this.options.multipleOf !== undefined && value % this.options.multipleOf !== 0)
      return ctx.fail(`must be a multiple of ${this.options.multipleOf}`)
    return this.runChecks(value, ctx)
  }

  emit(): JsonSchema {
    const out: JsonSchema = { type: this.options.int ? "integer" : "number" }
    if (this.options.min !== undefined) out.minimum = this.options.min
    if (this.options.max !== undefined) out.maximum = this.options.max
    if (this.options.exclusiveMin !== undefined) out.exclusiveMinimum = this.options.exclusiveMin
    if (this.options.exclusiveMax !== undefined) out.exclusiveMaximum = this.options.exclusiveMax
    if (this.options.multipleOf !== undefined) out.multipleOf = this.options.multipleOf
    return out
  }
}

class BooleanSchema extends Schema<boolean> {
  readonly typeName = "boolean"
  decode(input: unknown, ctx: Context): boolean | Invalid {
    if (typeof input === "boolean") return this.runChecks(input, ctx)
    if (input === "true") return true
    if (input === "false") return false
    return ctx.fail(`expected boolean, received ${typeName(input)}`)
  }
  emit(): JsonSchema {
    return { type: "boolean" }
  }
}

class LiteralSchema<T extends string | number | boolean | null> extends Schema<T> {
  readonly typeName = "literal"
  constructor(private readonly value: T) {
    super()
  }
  decode(input: unknown, ctx: Context): T | Invalid {
    if (input !== this.value) return ctx.fail(`expected ${JSON.stringify(this.value)}`)
    return this.value
  }
  emit(): JsonSchema {
    return { const: this.value, type: literalType(this.value) }
  }
}

class EnumSchema<T extends string> extends Schema<T> {
  readonly typeName = "enum"
  constructor(private readonly values: readonly T[]) {
    super()
  }
  get options(): readonly T[] {
    return this.values
  }
  decode(input: unknown, ctx: Context): T | Invalid {
    if (typeof input !== "string" || !this.values.includes(input as T))
      return ctx.fail(`expected one of ${this.values.join(" | ")}`)
    return input as T
  }
  emit(): JsonSchema {
    return { type: "string", enum: [...this.values] }
  }
}

class AnySchema extends Schema<unknown> {
  readonly typeName = "any"
  decode(input: unknown): unknown {
    return input
  }
  emit(): JsonSchema {
    return {}
  }
}

class NullSchema extends Schema<null> {
  readonly typeName = "null"
  decode(input: unknown, ctx: Context): null | Invalid {
    if (input !== null) return ctx.fail(`expected null, received ${typeName(input)}`)
    return null
  }
  emit(): JsonSchema {
    return { type: "null" }
  }
}

/* ------------------------------------------------------------------ */
/* Wrappers                                                            */
/* ------------------------------------------------------------------ */

class OptionalSchema<T> extends Schema<T | undefined> {
  readonly typeName = "optional"
  constructor(readonly inner: Schema<T>) {
    super()
  }
  decode(input: unknown, ctx: Context): T | undefined | Invalid {
    if (input === undefined) return undefined
    return this.inner.decode(input, ctx)
  }
  emit(): JsonSchema {
    return this.inner.jsonSchema()
  }
}

class NullableSchema<T> extends Schema<T | null> {
  readonly typeName = "nullable"
  constructor(readonly inner: Schema<T>) {
    super()
  }
  decode(input: unknown, ctx: Context): T | null | Invalid {
    if (input === null) return null
    return this.inner.decode(input, ctx)
  }
  emit(): JsonSchema {
    const base = this.inner.jsonSchema()
    if (typeof base.type === "string") return { ...base, type: [base.type, "null"] }
    return { anyOf: [base, { type: "null" }] }
  }
}

class TransformSchema<T, R> extends Schema<R> {
  readonly typeName = "transform"
  constructor(
    private readonly inner: Schema<T>,
    private readonly fn: (value: T) => R,
  ) {
    super()
  }
  decode(input: unknown, ctx: Context): R | Invalid {
    const value = this.inner.decode(input, ctx)
    if (value === INVALID) return INVALID
    try {
      return this.fn(value as T)
    } catch (err) {
      return ctx.fail(err instanceof Error ? err.message : "transform failed")
    }
  }
  emit(): JsonSchema {
    return this.inner.jsonSchema()
  }
}

class LazySchema<T> extends Schema<T> {
  readonly typeName = "lazy"
  private cached?: Schema<T>
  constructor(private readonly factory: () => Schema<T>) {
    super()
  }
  private get inner(): Schema<T> {
    return (this.cached ??= this.factory())
  }
  decode(input: unknown, ctx: Context): T | Invalid {
    return this.inner.decode(input, ctx)
  }
  emit(): JsonSchema {
    return this.inner.jsonSchema()
  }
}

/* ------------------------------------------------------------------ */
/* Containers                                                          */
/* ------------------------------------------------------------------ */

class ArraySchema<T> extends Schema<T[]> {
  readonly typeName = "array"
  private minItems?: number
  private maxItems?: number
  private unique = false

  constructor(private readonly element: Schema<T>) {
    super()
  }

  min(n: number): ArraySchema<T> {
    const c = this.clone()
    c.minItems = n
    return c
  }
  max(n: number): ArraySchema<T> {
    const c = this.clone()
    c.maxItems = n
    return c
  }
  nonEmpty(): ArraySchema<T> {
    return this.min(1)
  }
  uniqueItems(): ArraySchema<T> {
    const c = this.clone()
    c.unique = true
    return c
  }

  decode(input: unknown, ctx: Context): T[] | Invalid {
    if (!Array.isArray(input)) return ctx.fail(`expected array, received ${typeName(input)}`)
    if (this.minItems !== undefined && input.length < this.minItems)
      return ctx.fail(`must contain at least ${this.minItems} item(s)`)
    if (this.maxItems !== undefined && input.length > this.maxItems)
      return ctx.fail(`must contain at most ${this.maxItems} item(s)`)
    const out: T[] = []
    let failed = false
    for (let i = 0; i < input.length; i++) {
      ctx.push(i)
      const value = this.element.decode(input[i], ctx)
      ctx.pop()
      if (value === INVALID) {
        failed = true
        continue
      }
      out.push(value as T)
    }
    if (failed) return INVALID
    if (this.unique && new Set(out.map((v) => JSON.stringify(v))).size !== out.length)
      return ctx.fail("items must be unique")
    return this.runChecks(out, ctx)
  }

  emit(): JsonSchema {
    const out: JsonSchema = { type: "array", items: this.element.jsonSchema() }
    if (this.minItems !== undefined) out.minItems = this.minItems
    if (this.maxItems !== undefined) out.maxItems = this.maxItems
    if (this.unique) out.uniqueItems = true
    return out
  }
}

export type ObjectShape = Record<string, Schema<any>>
type InferShape<S extends ObjectShape> = {
  [K in keyof S]: S[K] extends Schema<infer T> ? T : never
}

class ObjectSchema<S extends ObjectShape> extends Schema<InferShape<S>> {
  readonly typeName = "object"
  private unknownKeys: "strip" | "passthrough" | "strict" = "strip"

  constructor(readonly shape: S) {
    super()
  }

  strict(): ObjectSchema<S> {
    const c = this.clone()
    c.unknownKeys = "strict"
    return c
  }
  passthrough(): ObjectSchema<S> {
    const c = this.clone()
    c.unknownKeys = "passthrough"
    return c
  }

  extend<E extends ObjectShape>(extra: E): ObjectSchema<S & E> {
    const next = new ObjectSchema({ ...this.shape, ...extra } as S & E)
    next.descriptionText = this.descriptionText
    return next
  }

  pick<K extends keyof S & string>(...keys: K[]): ObjectSchema<Pick<S, K>> {
    const shape = {} as Pick<S, K>
    for (const key of keys) shape[key] = this.shape[key]
    return new ObjectSchema(shape)
  }

  omit<K extends keyof S & string>(...keys: K[]): ObjectSchema<Omit<S, K>> {
    const shape = { ...this.shape } as Record<string, Schema<any>>
    for (const key of keys) delete shape[key]
    return new ObjectSchema(shape as Omit<S, K>)
  }

  partial(): ObjectSchema<S> {
    const shape = {} as Record<string, Schema<any>>
    for (const [key, value] of Object.entries(this.shape)) shape[key] = value.optional()
    const next = new ObjectSchema(shape as S)
    next.unknownKeys = this.unknownKeys
    return next
  }

  decode(input: unknown, ctx: Context): InferShape<S> | Invalid {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return ctx.fail(`expected object, received ${typeName(input)}`)
    const source = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    let failed = false

    for (const [key, schema] of Object.entries(this.shape)) {
      const raw = source[key]
      if (raw === undefined) {
        const fallback = schema.applyDefault()
        if (fallback.present) {
          out[key] = fallback.value
          continue
        }
        if (schema instanceof OptionalSchema) continue
        ctx.push(key)
        ctx.fail("is required")
        ctx.pop()
        failed = true
        continue
      }
      ctx.push(key)
      const value = schema.decode(raw, ctx)
      ctx.pop()
      if (value === INVALID) {
        failed = true
        continue
      }
      if (value !== undefined) out[key] = value
    }

    if (this.unknownKeys !== "strip") {
      for (const key of Object.keys(source)) {
        if (key in this.shape) continue
        if (this.unknownKeys === "passthrough") {
          out[key] = source[key]
          continue
        }
        ctx.push(key)
        ctx.fail("is not a recognised key")
        ctx.pop()
        failed = true
      }
    }

    if (failed) return INVALID
    return this.runChecks(out as InferShape<S>, ctx)
  }

  emit(): JsonSchema {
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const [key, schema] of Object.entries(this.shape)) {
      properties[key] = schema.jsonSchema()
      const isOptional = schema instanceof OptionalSchema || schema.applyDefault().present
      if (!isOptional) required.push(key)
    }
    const out: JsonSchema = { type: "object", properties }
    if (required.length) out.required = required
    out.additionalProperties = this.unknownKeys === "passthrough"
    return out
  }
}

class RecordSchema<T> extends Schema<Record<string, T>> {
  readonly typeName = "record"
  constructor(
    private readonly value: Schema<T>,
    private readonly keyPattern?: RegExp,
  ) {
    super()
  }
  decode(input: unknown, ctx: Context): Record<string, T> | Invalid {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return ctx.fail(`expected object, received ${typeName(input)}`)
    const out: Record<string, T> = {}
    let failed = false
    for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
      if (this.keyPattern && !this.keyPattern.test(key)) {
        ctx.push(key)
        ctx.fail(`key must match ${this.keyPattern}`)
        ctx.pop()
        failed = true
        continue
      }
      ctx.push(key)
      const value = this.value.decode(raw, ctx)
      ctx.pop()
      if (value === INVALID) {
        failed = true
        continue
      }
      out[key] = value as T
    }
    if (failed) return INVALID
    return this.runChecks(out, ctx)
  }
  emit(): JsonSchema {
    return { type: "object", additionalProperties: this.value.jsonSchema() }
  }
}

class UnionSchema<T> extends Schema<T> {
  readonly typeName = "union"
  constructor(private readonly options: Array<Schema<any>>) {
    super()
  }
  decode(input: unknown, ctx: Context): T | Invalid {
    const collected: Issue[][] = []
    for (const option of this.options) {
      const local = new Context()
      const value = option.decode(input, local)
      if (value !== INVALID && local.issues.length === 0) return value as T
      collected.push(local.issues)
    }
    // Report the branch that got furthest (fewest issues) for a useful message.
    const best = collected.sort((a, b) => a.length - b.length)[0] ?? []
    if (best.length) {
      for (const issue of best) {
        ctx.issues.push({
          path: issue.path ? `${ctx.path}${ctx.path ? "." : ""}${issue.path}` : ctx.path,
          message: issue.message,
        })
      }
      return INVALID
    }
    return ctx.fail("did not match any allowed variant")
  }
  emit(): JsonSchema {
    return { anyOf: this.options.map((o) => o.jsonSchema()) }
  }
}

class DiscriminatedUnionSchema<T> extends Schema<T> {
  readonly typeName = "discriminatedUnion"
  constructor(
    private readonly key: string,
    private readonly variants: Record<string, Schema<any>>,
  ) {
    super()
  }
  decode(input: unknown, ctx: Context): T | Invalid {
    if (typeof input !== "object" || input === null)
      return ctx.fail(`expected object, received ${typeName(input)}`)
    const tag = (input as Record<string, unknown>)[this.key]
    if (typeof tag !== "string") return ctx.fail(`missing discriminator "${this.key}"`)
    const variant = this.variants[tag]
    if (!variant)
      return ctx.fail(
        `unknown ${this.key} "${tag}"; expected one of ${Object.keys(this.variants).join(" | ")}`,
      )
    return variant.decode(input, ctx) as T | Invalid
  }
  emit(): JsonSchema {
    return {
      oneOf: Object.values(this.variants).map((v) => v.jsonSchema()),
      discriminator: { propertyName: this.key },
    }
  }
}

class TupleSchema<T extends Array<Schema<any>>> extends Schema<any[]> {
  readonly typeName = "tuple"
  constructor(private readonly items: T) {
    super()
  }
  decode(input: unknown, ctx: Context): any[] | Invalid {
    if (!Array.isArray(input)) return ctx.fail(`expected array, received ${typeName(input)}`)
    if (input.length !== this.items.length)
      return ctx.fail(`expected exactly ${this.items.length} item(s)`)
    const out: unknown[] = []
    let failed = false
    for (let i = 0; i < this.items.length; i++) {
      ctx.push(i)
      const value = (this.items[i] as Schema<any>).decode(input[i], ctx)
      ctx.pop()
      if (value === INVALID) {
        failed = true
        continue
      }
      out.push(value)
    }
    return failed ? INVALID : out
  }
  emit(): JsonSchema {
    return {
      type: "array",
      items: this.items.map((i) => i.jsonSchema()),
      minItems: this.items.length,
      maxItems: this.items.length,
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function typeName(input: unknown): string {
  if (input === null) return "null"
  if (Array.isArray(input)) return "array"
  return typeof input
}

function literalType(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  return "string"
}

export type Infer<S> = S extends Schema<infer T> ? T : never

/** The public builder surface, deliberately mirroring familiar conventions. */
export const s = {
  string: (options?: StringOptions) => new StringSchema(options),
  number: () => new NumberSchema(),
  int: () => new NumberSchema().int(),
  boolean: () => new BooleanSchema(),
  literal: <T extends string | number | boolean | null>(value: T) => new LiteralSchema(value),
  enum: <T extends string>(values: readonly T[]) => new EnumSchema(values),
  any: () => new AnySchema(),
  unknown: () => new AnySchema(),
  null: () => new NullSchema(),
  array: <T>(element: Schema<T>) => new ArraySchema(element),
  object: <S extends ObjectShape>(shape: S) => new ObjectSchema(shape),
  record: <T>(value: Schema<T>, keyPattern?: RegExp) => new RecordSchema(value, keyPattern),
  union: <T extends Array<Schema<any>>>(...options: T) =>
    new UnionSchema<Infer<T[number]>>(options) as Schema<Infer<T[number]>>,
  discriminated: <T>(key: string, variants: Record<string, Schema<any>>) =>
    new DiscriminatedUnionSchema<T>(key, variants),
  tuple: <T extends Array<Schema<any>>>(...items: T) => new TupleSchema(items),
  lazy: <T>(factory: () => Schema<T>) => new LazySchema(factory),
  /** A value that may be `T` or an array of `T`; normalised to an array. */
  oneOrMany: <T>(element: Schema<T>): Schema<T[]> =>
    new UnionSchema<T[] | T>([new ArraySchema(element), element]).transform((value) =>
      Array.isArray(value) ? value : [value],
    ),
  /** Accepts booleans or the strings "allow"/"deny" for ergonomic configs. */
  flexibleBoolean: (): Schema<boolean> =>
    new UnionSchema<boolean | string>([
      new BooleanSchema(),
      new EnumSchema(["allow", "deny", "on", "off", "true", "false"] as const),
    ]).transform((value) =>
      typeof value === "boolean" ? value : value === "allow" || value === "on" || value === "true",
    ),
} as const

/** Formats issues into a multi-line, human friendly report. */
export function formatIssues(issues: readonly Issue[], indent = "  "): string {
  return issues.map((i) => `${indent}${i.path ? i.path + ": " : ""}${i.message}`).join("\n")
}

/**
 * Rewrites a JSON Schema so it satisfies OpenAI's structured-output rules:
 * every object must list all properties as required and forbid extras.
 */
export function toStrictJsonSchema(schema: JsonSchema): JsonSchema {
  const walk = (node: JsonSchema): JsonSchema => {
    if (!node || typeof node !== "object") return node
    const out: JsonSchema = { ...node }
    if (out.properties) {
      const properties: Record<string, JsonSchema> = {}
      for (const [key, value] of Object.entries(out.properties)) properties[key] = walk(value)
      out.properties = properties
      out.required = Object.keys(properties)
      out.additionalProperties = false
    }
    if (out.items) {
      out.items = Array.isArray(out.items) ? out.items.map(walk) : walk(out.items)
    }
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const list = out[key]
      if (Array.isArray(list)) out[key] = list.map(walk)
    }
    return out
  }
  return walk(schema)
}

/**
 * Some providers reject schema keywords they do not understand. This strips a
 * schema down to the widely supported core.
 */
export function simplifyJsonSchema(schema: JsonSchema): JsonSchema {
  const allowed = new Set([
    "type",
    "description",
    "enum",
    "properties",
    "required",
    "items",
    "additionalProperties",
    "anyOf",
    "default",
  ])
  const walk = (node: JsonSchema): JsonSchema => {
    if (!node || typeof node !== "object") return node
    const out: JsonSchema = {}
    for (const [key, value] of Object.entries(node)) {
      if (!allowed.has(key)) continue
      if (key === "properties" && value && typeof value === "object") {
        const properties: Record<string, JsonSchema> = {}
        for (const [k, v] of Object.entries(value as Record<string, JsonSchema>))
          properties[k] = walk(v)
        out.properties = properties
        continue
      }
      if (key === "items") {
        out.items = Array.isArray(value)
          ? (value as JsonSchema[]).map(walk)
          : walk(value as JsonSchema)
        continue
      }
      if (key === "anyOf" && Array.isArray(value)) {
        out.anyOf = (value as JsonSchema[]).map(walk)
        continue
      }
      out[key] = value
    }
    if (out.const !== undefined && out.enum === undefined) out.enum = [out.const]
    return out
  }
  return walk(schema)
}
