/**
 * Async primitives used across the agent runtime.
 *
 * Praxis runs a lot of concurrent work: LLM streams, tool executions, LSP
 * servers, MCP handshakes, file watchers. Rather than reaching for a library we
 * keep a small, well-understood toolbox here.
 */

import { AbortedError, TimeoutError, isRetryable } from "./error.js"

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new AbortedError({ reason: "sleep aborted" }))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

export class Deferred<T> {
  readonly promise: Promise<T>
  private resolveFn!: (value: T | PromiseLike<T>) => void
  private rejectFn!: (reason?: unknown) => void
  private state: "pending" | "resolved" | "rejected" = "pending"

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve
      this.rejectFn = reject
    })
    // Prevent unhandled rejection warnings for deferreds nobody awaits yet.
    this.promise.catch(() => {})
  }

  get settled(): boolean {
    return this.state !== "pending"
  }

  resolve(value: T | PromiseLike<T>): void {
    if (this.state !== "pending") return
    this.state = "resolved"
    this.resolveFn(value)
  }

  reject(reason?: unknown): void {
    if (this.state !== "pending") return
    this.state = "rejected"
    this.rejectFn(reason)
  }
}

export function withTimeout<T>(
  input: Promise<T> | (() => Promise<T>),
  ms: number,
  label?: string,
): Promise<T> {
  const promise = typeof input === "function" ? input() : input
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError({ ms, label })), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Rejects as soon as the signal aborts, otherwise mirrors the promise. */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new AbortedError({}))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new AbortedError({}))
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (v) => {
        cleanup()
        resolve(v)
      },
      (e) => {
        cleanup()
        reject(e)
      },
    )
  })
}

export interface RetryOptions {
  readonly attempts?: number
  readonly baseMs?: number
  readonly maxMs?: number
  readonly factor?: number
  readonly jitter?: boolean
  readonly signal?: AbortSignal
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}) {
  const attempts = options.attempts ?? 3
  const baseMs = options.baseMs ?? 250
  const maxMs = options.maxMs ?? 20_000
  const factor = options.factor ?? 2
  const jitter = options.jitter ?? true
  const shouldRetry = options.shouldRetry ?? ((e) => isRetryable(e))

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw new AbortedError({})
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err
      if (AbortedError.is(err)) throw err
      if (attempt === attempts || !shouldRetry(err, attempt)) throw err
      const pure = Math.min(maxMs, baseMs * Math.pow(factor, attempt - 1))
      const delay = jitter ? Math.round(pure * (0.5 + Math.random() * 0.5)) : pure
      options.onRetry?.(err, attempt, delay)
      await sleep(delay, options.signal)
    }
  }
  throw lastError
}

/** Counting semaphore with FIFO fairness. */
export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    this.available = Math.max(1, permits)
  }

  get free(): number {
    return this.available
  }

  get pending(): number {
    return this.waiters.length
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--
      return this.release.bind(this)
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    return this.release.bind(this)
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.available++
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** Serialises access to a resource. Equivalent to `new Semaphore(1)`. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.catch(() => {})
    return result
  }
}

/** Named mutexes; useful for per-file or per-session serialisation. */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>()

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    let mutex = this.locks.get(key)
    if (!mutex) {
      mutex = new Mutex()
      this.locks.set(key, mutex)
    }
    return mutex.run(fn)
  }

  forget(key: string): void {
    this.locks.delete(key)
  }
}

export interface PoolOptions {
  readonly concurrency?: number
  readonly signal?: AbortSignal
  readonly stopOnError?: boolean
}

/** Runs an async mapper over items with bounded concurrency, preserving order. */
export async function mapPool<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  options: PoolOptions = {},
): Promise<R[]> {
  const concurrency = Math.max(1, options.concurrency ?? 8)
  const results = new Array<R>(items.length)
  let cursor = 0
  let failure: unknown

  async function worker(): Promise<void> {
    for (;;) {
      if (failure !== undefined && options.stopOnError !== false) return
      if (options.signal?.aborted) throw new AbortedError({})
      const index = cursor++
      if (index >= items.length) return
      try {
        results[index] = await mapper(items[index] as T, index)
      } catch (err) {
        failure ??= err
        if (options.stopOnError !== false) return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  if (failure !== undefined) throw failure
  return results
}

/**
 * An unbounded async queue that can be consumed as an async iterable. This is
 * the backbone of streaming: producers push chunks, the consumer awaits them.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false
  private error: unknown

  get size(): number {
    return this.buffer.length
  }

  get isClosed(): boolean {
    return this.closed
  }

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    this.buffer.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length) {
      this.waiters.shift()?.({ value: undefined as never, done: true })
    }
  }

  fail(error: unknown): void {
    if (this.closed) return
    this.error = error
    this.closed = true
    while (this.waiters.length) {
      const waiter = this.waiters.shift()
      // Signal termination; the iterator throws on the next pull.
      waiter?.({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        }
        if (this.error !== undefined) return Promise.reject(this.error)
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}

/** Collapses bursts of calls into a single trailing invocation. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel(): void; flush(): void } {
  let timer: NodeJS.Timeout | undefined
  let lastArgs: A | undefined
  const wrapped = (...args: A) => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      const a = lastArgs
      lastArgs = undefined
      if (a) fn(...a)
    }, ms)
  }
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    lastArgs = undefined
  }
  wrapped.flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const a = lastArgs
    lastArgs = undefined
    if (a) fn(...a)
  }
  return wrapped
}

/** Rate-limits to at most one call per interval, keeping the latest arguments. */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel(): void } {
  let last = 0
  let timer: NodeJS.Timeout | undefined
  let pending: A | undefined
  const wrapped = (...args: A) => {
    const now = Date.now()
    const wait = ms - (now - last)
    if (wait <= 0) {
      last = now
      fn(...args)
      return
    }
    pending = args
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      last = Date.now()
      const a = pending
      pending = undefined
      if (a) fn(...a)
    }, wait)
  }
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    pending = undefined
  }
  return wrapped
}

/** Ensures an async factory runs at most once, memoising the result. */
export function once<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined
  return () => (promise ??= factory())
}

/** Deduplicates concurrent calls with the same key. */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>()

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const promise = fn().finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return promise
  }
}

/** Links a parent signal to a fresh controller so children can be cancelled independently. */
export function childAbort(parent?: AbortSignal): AbortController {
  const controller = new AbortController()
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason)
    else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true })
  }
  return controller
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/** Fire-and-forget with logging hook, so we never leak unhandled rejections. */
export function detach(promise: Promise<unknown>, onError?: (err: unknown) => void): void {
  promise.catch((err) => {
    if (onError) onError(err)
  })
}

/** Simple TTL cache with async loader and stale-while-revalidate semantics. */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expires: number; refreshing?: boolean }>()

  constructor(private readonly ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires < Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: K, value: V): void {
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs })
  }

  delete(key: K): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  async load(key: K, loader: () => Promise<V>): Promise<V> {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const value = await loader()
    this.set(key, value)
    return value
  }

  /** Returns cached value immediately and refreshes in the background if stale. */
  async loadStale(key: K, loader: () => Promise<V>): Promise<V> {
    const entry = this.entries.get(key)
    if (entry && !entry.refreshing && entry.expires < Date.now()) {
      entry.refreshing = true
      detach(
        loader().then(
          (value) => this.entries.set(key, { value, expires: Date.now() + this.ttlMs }),
          () => {
            const current = this.entries.get(key)
            if (current) current.refreshing = false
          },
        ),
      )
    }
    if (entry) return entry.value
    return this.load(key, loader)
  }
}

/** Bounded LRU cache. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.map.size
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  keys(): K[] {
    return [...this.map.keys()]
  }
}

/** Awaits the next matching event from an emitter-like object. */
export function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Drives an async generator while allowing the consumer to bail out early
 * without leaking the underlying resource.
 */
export async function* mapStream<T, R>(
  source: AsyncIterable<T>,
  mapper: (value: T) => R | Promise<R>,
): AsyncGenerator<R> {
  for await (const value of source) {
    yield await mapper(value)
  }
}

export async function collect<T>(source: AsyncIterable<T>, limit = Infinity): Promise<T[]> {
  const out: T[] = []
  for await (const value of source) {
    out.push(value)
    if (out.length >= limit) break
  }
  return out
}
