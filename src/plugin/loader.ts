/**
 * Plugin discovery, loading, and dispatch.
 *
 * Plugins are arbitrary user code running inside the agent process. That is a
 * deliberate choice \u2014 a sandboxed plugin could not do the useful things people
 * actually want, like reading the repository or shelling out to a linter \u2014 but it
 * means everything here is written defensively:
 *
 *  - A plugin that fails to load is reported and skipped. One broken file must not
 *    prevent the agent from starting.
 *  - A hook that throws is caught. For `before` hooks the throw is meaningful (a
 *    veto), so it is converted to a block with a reason; everywhere else it is a
 *    bug, logged and swallowed.
 *  - A hook that hangs is timed out. A plugin awaiting a network call that never
 *    returns would otherwise freeze every tool call in the session.
 *  - Hook timings are recorded, so `praxis plugin list` can point at the plugin
 *    adding two seconds to every edit.
 *
 * Load order is lowest to highest precedence: built-in, global config, project
 * config, project directory. Later plugins see the mutations of earlier ones,
 * which makes a project-local plugin able to override a global one's rewrite.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { logger } from "../util/log.js"
import { Paths } from "../global.js"
import { Bus } from "../util/bus.js"
import { shell } from "../util/shell.js"
import type {
  HookOutcome,
  LoadedPlugin,
  Plugin,
  PluginClient,
  PluginEvent,
  PluginHooks,
  PluginInput,
  PluginManifest,
  PluginShell,
  PluginUsage,
  ToolAfterInput,
  ToolAfterOutput,
  ToolBeforeInput,
  ToolBeforeOutput,
} from "./types.js"

const log = logger("plugin")

/** A hook that takes longer than this is treated as hung. */
const HOOK_TIMEOUT_MS = 30_000

/** Extensions we will attempt to import. */
const PLUGIN_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts"]

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

let plugins: LoadedPlugin[] = []
let loaded = false
const usage = new Map<string, PluginUsage>()

export function loadedPlugins(): readonly LoadedPlugin[] {
  return plugins
}

export function pluginUsage(): PluginUsage[] {
  return [...usage.values()].sort((a, b) => b.totalMs - a.totalMs)
}

export function resetPlugins(): void {
  plugins = []
  loaded = false
  usage.clear()
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

export interface DiscoverOptions {
  readonly cwd: string
  /** Entries from the `plugin` config array: paths or npm names. */
  readonly configured?: string[]
  /** Per-plugin config blocks, keyed by plugin name. */
  readonly settings?: Record<string, Record<string, unknown>>
}

interface Candidate {
  readonly path: string
  readonly source: "local" | "npm" | "builtin"
  readonly name: string
}

/**
 * Finds every plugin that should be loaded.
 *
 * Convention-over-configuration for the directory scan: dropping a file in
 * `.praxis/plugin/` is enough. Requiring registration in config as well would add
 * a step that is forgotten every time.
 */
export function discoverPlugins(options: DiscoverOptions): Candidate[] {
  const candidates: Candidate[] = []
  const seen = new Set<string>()

  const add = (path: string, source: Candidate["source"]) => {
    const absolute = resolve(path)
    if (seen.has(absolute)) return
    seen.add(absolute)
    candidates.push({ path: absolute, source, name: basename(absolute) })
  }

  // Global directory, then project directory. Project wins by loading last.
  for (const directory of [
    join(Paths.configDir, "plugin"),
    join(Paths.configDir, "plugins"),
    join(options.cwd, ".praxis", "plugin"),
    join(options.cwd, ".praxis", "plugins"),
  ]) {
    for (const file of scanDirectory(directory)) add(file, "local")
  }

  // Explicit entries last so config can force load order for a plugin that
  // depends on another's rewrite.
  for (const entry of options.configured ?? []) {
    if (entry.startsWith(".") || isAbsolute(entry)) {
      const path = isAbsolute(entry) ? entry : resolve(options.cwd, entry)
      const resolved = resolveEntry(path)
      if (resolved) add(resolved, "local")
      else log.warn("configured plugin not found", { entry, path })
      continue
    }

    const fromModules = resolveNodeModule(entry, options.cwd)
    if (fromModules) add(fromModules, "npm")
    else log.warn("plugin package not installed", { entry })
  }

  return candidates
}

function scanDirectory(directory: string): string[] {
  if (!existsSync(directory)) return []

  const results: string[] = []

  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue

    const full = join(directory, entry)

    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }

    if (stats.isDirectory()) {
      // A directory is a plugin if it has an entry point.
      const resolved = resolveEntry(full)
      if (resolved) results.push(resolved)
      continue
    }

    // Type declarations and test files are not plugins.
    if (entry.endsWith(".d.ts")) continue
    if (/\.(test|spec)\.[cm]?[jt]s$/.test(entry)) continue

    if (PLUGIN_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      results.push(full)
    }
  }

  return results
}

/** Resolves a path that may be a file, a directory with an index, or a package. */
function resolveEntry(path: string): string | undefined {
  if (existsSync(path) && statSync(path).isFile()) return path

  for (const extension of PLUGIN_EXTENSIONS) {
    const withExtension = `${path}${extension}`
    if (existsSync(withExtension)) return withExtension
  }

  if (!existsSync(path) || !statSync(path).isDirectory()) return undefined

  const manifestPath = join(path, "package.json")
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest
      if (manifest.main) {
        const main = join(path, manifest.main)
        if (existsSync(main)) return main
        const resolvedMain = resolveEntry(main)
        if (resolvedMain) return resolvedMain
      }
    } catch {
      // Malformed package.json falls through to the index scan.
    }
  }

  for (const extension of PLUGIN_EXTENSIONS) {
    const index = join(path, `index${extension}`)
    if (existsSync(index)) return index
  }

  return undefined
}

/** Walks up looking for the package in `node_modules`. */
function resolveNodeModule(name: string, from: string): string | undefined {
  let directory = resolve(from)

  for (let depth = 0; depth < 24; depth++) {
    const candidate = join(directory, "node_modules", name)
    if (existsSync(candidate)) {
      const resolved = resolveEntry(candidate)
      if (resolved) return resolved
    }

    const parent = resolve(directory, "..")
    if (parent === directory) break
    directory = parent
  }

  // Also check the global plugin install location.
  const global = join(Paths.dataDir, "plugin", "node_modules", name)
  if (existsSync(global)) return resolveEntry(global)

  return undefined
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  const file = parts[parts.length - 1] ?? path
  return file.replace(/\.[cm]?[jt]s$/, "")
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export interface LoadOptions extends DiscoverOptions {
  readonly client: PluginClient
  readonly project: PluginInput["project"]
  readonly env: Record<string, string | undefined>
  readonly worktree?: string
}

/**
 * Loads every discovered plugin.
 *
 * Sequential rather than parallel: plugins commonly register tools and commands
 * into shared maps, and deterministic ordering makes conflicts reproducible
 * rather than dependent on which file system call returned first.
 */
export async function loadPlugins(options: LoadOptions): Promise<LoadedPlugin[]> {
  const candidates = discoverPlugins(options)
  const result: LoadedPlugin[] = []

  for (const candidate of candidates) {
    const startedAt = Date.now()
    try {
      const plugin = await loadOne(candidate, options)
      if (plugin) {
        result.push(plugin)
        log.info("plugin loaded", {
          name: plugin.name,
          source: plugin.source,
          hooks: Object.keys(plugin.hooks).length,
          ms: Date.now() - startedAt,
        })
      }
    } catch (error) {
      // Reported as a loaded-but-broken plugin rather than dropped, so the user
      // sees it in the list with its error instead of wondering why nothing
      // happens.
      log.error("plugin failed to load", { path: candidate.path, error: String(error) })
      result.push({
        id: candidate.name,
        name: candidate.name,
        source: candidate.source,
        path: candidate.path,
        hooks: {},
        tools: [],
        errors: [formatLoadError(error)],
      })
    }
  }

  plugins = result
  loaded = true

  return result
}

async function loadOne(candidate: Candidate, options: LoadOptions): Promise<LoadedPlugin | undefined> {
  // A cache-busting query is essential for `praxis plugin reload` to pick up
  // edits; ESM module caching is otherwise permanent for the process lifetime.
  const url = `${pathToFileURL(candidate.path).href}?t=${Date.now()}`
  const module = (await import(url)) as Record<string, unknown>

  const factory = pickFactory(module)
  if (!factory) {
    throw new Error(
      "No plugin export found. A plugin module must export a function \u2014 as `default`, or as a named export \u2014 that returns an object of hooks.",
    )
  }

  const name = candidate.name
  const settings = options.settings?.[name] ?? {}

  const input: PluginInput = {
    directory: options.cwd,
    worktree: options.worktree ?? options.cwd,
    project: options.project,
    client: options.client,
    $: makeShell(options.cwd, options.env),
    config: settings,
    env: options.env,
    log: scopedLogger(name),
  }

  const hooks = await withTimeout(
    Promise.resolve(factory(input)),
    HOOK_TIMEOUT_MS,
    `Plugin "${name}" did not finish initialising within ${HOOK_TIMEOUT_MS / 1_000}s.`,
  )

  if (!hooks || typeof hooks !== "object") {
    throw new Error("The plugin function must return an object of hooks.")
  }

  return {
    id: name,
    name,
    source: candidate.source,
    path: candidate.path,
    hooks: hooks as PluginHooks,
    tools: [],
    errors: [],
  }
}

/**
 * Finds the exported plugin function.
 *
 * Several shapes are accepted because plugins are written by hand and the exact
 * export style is not worth being strict about: `export default`, a single named
 * export, or a named export matching the file name all work.
 */
function pickFactory(module: Record<string, unknown>): Plugin | undefined {
  if (typeof module["default"] === "function") return module["default"] as Plugin

  const functions = Object.entries(module).filter(
    ([key, value]) => typeof value === "function" && key !== "default",
  )

  if (functions.length === 1) return functions[0]![1] as Plugin

  // Several exports: prefer one that looks like a plugin by name.
  for (const [key, value] of functions) {
    if (/plugin$/i.test(key)) return value as Plugin
  }

  return undefined
}

function formatLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  // The bare ESM resolution error is famously unhelpful; say what to do.
  if (message.includes("Cannot find module")) {
    return `${message}\n\nIf the plugin imports a package, install it in the project or next to the plugin.`
  }
  if (message.includes("Unexpected token") || message.includes("SyntaxError")) {
    return `${message}\n\nPlugins are ES modules. Use \`import\`/\`export\`, not \`require\`/\`module.exports\`, unless the file is named .cjs.`
  }

  return message
}

function scopedLogger(name: string): PluginInput["log"] {
  const inner = logger(`plugin.${name}`)
  return {
    debug: (message, data) => inner.debug(message, data),
    info: (message, data) => inner.info(message, data),
    warn: (message, data) => inner.warn(message, data),
    error: (message, data) => inner.error(message, data),
  }
}

/* ------------------------------------------------------------------ */
/* Shell helper                                                        */
/* ------------------------------------------------------------------ */

/**
 * Builds the tagged-template shell.
 *
 * Interpolated values are single-quoted with embedded quotes escaped. Not
 * optional: without it the first path containing a space silently runs the wrong
 * command, and the first containing a semicolon runs an attacker's.
 */
function makeShell(cwd: string, env: Record<string, string | undefined>): PluginShell {
  const build = (directory: string, environment: Record<string, string | undefined>): PluginShell => {
    const run = async (
      strings: TemplateStringsArray,
      values: unknown[],
      throwOnError: boolean,
    ) => {
      const command = strings.reduce((accumulator, part, index) => {
        const value = index < values.length ? quote(values[index]) : ""
        return accumulator + part + value
      }, "")

      const result = await shell(command, {
        cwd: directory,
        env: environment,
        timeoutMs: 120_000,
      })

      if (throwOnError && result.exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${result.exitCode}: ${command}\n${result.stderr || result.stdout}`,
        )
      }

      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
    }

    const helper = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      run(strings, values, true)) as PluginShell

    Object.defineProperty(helper, "nothrow", {
      value: (strings: TemplateStringsArray, ...values: unknown[]) => run(strings, values, false),
    })
    Object.defineProperty(helper, "cwd", {
      value: (next: string) => build(resolve(directory, next), environment),
    })
    Object.defineProperty(helper, "env", {
      value: (extra: Record<string, string>) => build(directory, { ...environment, ...extra }),
    })

    return helper
  }

  return build(cwd, env)
}

function quote(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (Array.isArray(value)) return value.map(quote).join(" ")

  const text = String(value)
  if (text === "") return "''"
  if (/^[A-Za-z0-9_./:=-]+$/.test(text)) return text

  return `'${text.replace(/'/g, `'\\''`)}'`
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

function record(pluginId: string, hook: string, ms: number, failed: boolean): void {
  const key = `${pluginId}:${hook}`
  const existing = usage.get(key)

  usage.set(key, {
    pluginId,
    hook,
    calls: (existing?.calls ?? 0) + 1,
    totalMs: (existing?.totalMs ?? 0) + ms,
    errors: (existing?.errors ?? 0) + (failed ? 1 : 0),
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Runs the `before` hooks for a tool call.
 *
 * A throw here is a veto, not a bug: the message becomes the tool's error and
 * goes straight to the model, which is how a plugin explains itself. Execution
 * stops at the first block, since running later hooks on an action that is not
 * happening wastes time and can confuse stateful plugins.
 */
export async function dispatchToolBefore(
  input: ToolBeforeInput,
  output: ToolBeforeOutput,
): Promise<HookOutcome> {
  const failures: HookOutcome["failures"] = []

  for (const plugin of plugins) {
    const hook = plugin.hooks["tool.execute.before"]
    if (!hook) continue

    const startedAt = Date.now()

    try {
      await withTimeout(
        Promise.resolve(hook(input, output)),
        HOOK_TIMEOUT_MS,
        `Plugin "${plugin.name}" hung in tool.execute.before.`,
      )
      record(plugin.id, "tool.execute.before", Date.now() - startedAt, false)
    } catch (error) {
      record(plugin.id, "tool.execute.before", Date.now() - startedAt, true)

      const message = error instanceof Error ? error.message : String(error)

      // A timeout is a bug in the plugin, not a considered veto. Distinguishing
      // them stops a hung plugin from silently disabling a tool.
      if (message.includes("hung in tool.execute.before")) {
        failures.push({ pluginId: plugin.id, error: message })
        continue
      }

      log.info("tool blocked by plugin", { plugin: plugin.name, tool: input.tool, reason: message })

      return { blocked: true, reason: message, pluginId: plugin.id, failures }
    }
  }

  return { blocked: false, failures }
}

/**
 * Runs the `after` hooks.
 *
 * Never blocks \u2014 the tool has already run and its effects have already happened,
 * so pretending otherwise would be a lie. A throw here is logged and ignored.
 */
export async function dispatchToolAfter(
  input: ToolAfterInput,
  output: ToolAfterOutput,
): Promise<HookOutcome> {
  const failures: HookOutcome["failures"] = []

  for (const plugin of plugins) {
    const hook = plugin.hooks["tool.execute.after"]
    if (!hook) continue

    const startedAt = Date.now()

    try {
      await withTimeout(
        Promise.resolve(hook(input, output)),
        HOOK_TIMEOUT_MS,
        `Plugin "${plugin.name}" hung in tool.execute.after.`,
      )
      record(plugin.id, "tool.execute.after", Date.now() - startedAt, false)
    } catch (error) {
      record(plugin.id, "tool.execute.after", Date.now() - startedAt, true)
      failures.push({ pluginId: plugin.id, error: String(error) })
      log.warn("after hook failed", { plugin: plugin.name, error: String(error) })
    }
  }

  return { blocked: false, failures }
}

/**
 * Dispatches a named hook to every plugin that implements it.
 *
 * The generic path for the fire-and-forget hooks. Failures are logged, never
 * propagated: a notification plugin failing must not fail the session it is
 * reporting on.
 */
export async function dispatch<K extends keyof PluginHooks>(
  name: K,
  ...args: PluginHooks[K] extends ((...rest: infer A) => unknown) | undefined ? A : never
): Promise<void> {
  if (!loaded || plugins.length === 0) return

  for (const plugin of plugins) {
    const hook = plugin.hooks[name] as ((...rest: unknown[]) => unknown) | undefined
    if (typeof hook !== "function") continue

    const startedAt = Date.now()

    try {
      await withTimeout(
        Promise.resolve(hook(...(args as unknown[]))),
        HOOK_TIMEOUT_MS,
        `Plugin "${plugin.name}" hung in ${String(name)}.`,
      )
      record(plugin.id, String(name), Date.now() - startedAt, false)
    } catch (error) {
      record(plugin.id, String(name), Date.now() - startedAt, true)
      log.warn("hook failed", { plugin: plugin.name, hook: String(name), error: String(error) })
    }
  }
}

/**
 * Asks plugins to decide a permission request.
 *
 * First decisive answer wins, and load order therefore encodes precedence: a
 * project plugin can override a global policy because it loads later. A plugin
 * returning nothing abstains, which is the common case.
 */
export async function dispatchPermission(input: {
  request: Parameters<NonNullable<PluginHooks["permission.asked"]>>[0]["request"]
  sessionId: string
}): Promise<{ decision?: "allow" | "deny"; pluginId?: string }> {
  for (const plugin of plugins) {
    const hook = plugin.hooks["permission.asked"]
    if (!hook) continue

    const startedAt = Date.now()

    try {
      const decision = await withTimeout(
        Promise.resolve(hook(input)),
        HOOK_TIMEOUT_MS,
        `Plugin "${plugin.name}" hung in permission.asked.`,
      )
      record(plugin.id, "permission.asked", Date.now() - startedAt, false)

      if (decision === "allow" || decision === "deny") {
        log.debug("permission decided by plugin", { plugin: plugin.name, decision })
        return { decision, pluginId: plugin.id }
      }
    } catch (error) {
      record(plugin.id, "permission.asked", Date.now() - startedAt, true)
      log.warn("permission hook failed", { plugin: plugin.name, error: String(error) })
    }
  }

  return {}
}

/**
 * Lets plugins contribute environment variables to shell commands.
 *
 * Mutating an object rather than merging return values, so two plugins each
 * adding one variable both take effect instead of the second replacing the first.
 */
export async function dispatchShellEnv(cwd: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}

  for (const plugin of plugins) {
    const hook = plugin.hooks["shell.env"]
    if (!hook) continue

    try {
      await withTimeout(
        Promise.resolve(hook({ cwd }, { env })),
        5_000,
        `Plugin "${plugin.name}" hung in shell.env.`,
      )
    } catch (error) {
      log.warn("shell.env hook failed", { plugin: plugin.name, error: String(error) })
    }
  }

  return env
}

/* ------------------------------------------------------------------ */
/* Bus bridge                                                          */
/* ------------------------------------------------------------------ */

/**
 * Forwards internal events to plugins' catch-all `event` hook.
 *
 * Everything already flows through the bus, so bridging it is what makes the
 * generic hook forward-compatible: an event added next year reaches plugins
 * written today without touching this file.
 */
export function bridgeBusToPlugins(): () => void {
  const unsubscribe = Bus.subscribeAll((type, properties) => {
    if (plugins.length === 0) return

    const event: PluginEvent = { type, properties, at: Date.now() }

    void (async () => {
      for (const plugin of plugins) {
        const hook = plugin.hooks.event
        if (!hook) continue
        try {
          await hook({ event })
        } catch (error) {
          log.debug("event hook failed", { plugin: plugin.name, error: String(error) })
        }
      }
    })()
  })

  return unsubscribe
}

/* ------------------------------------------------------------------ */
/* Contributions                                                       */
/* ------------------------------------------------------------------ */

/** Tools contributed by plugins, with their owning plugin recorded. */
export function pluginTools(): Array<{ pluginId: string; id: string; tool: NonNullable<PluginHooks["tool"]>[string] }> {
  const result: Array<{ pluginId: string; id: string; tool: NonNullable<PluginHooks["tool"]>[string] }> = []

  for (const plugin of plugins) {
    for (const [id, tool] of Object.entries(plugin.hooks.tool ?? {})) {
      result.push({ pluginId: plugin.id, id, tool })
    }
  }

  return result
}

export function pluginAgents(): Array<{ pluginId: string; name: string; definition: NonNullable<PluginHooks["agent"]>[string] }> {
  const result: Array<{ pluginId: string; name: string; definition: NonNullable<PluginHooks["agent"]>[string] }> = []

  for (const plugin of plugins) {
    for (const [name, definition] of Object.entries(plugin.hooks.agent ?? {})) {
      result.push({ pluginId: plugin.id, name, definition })
    }
  }

  return result
}

export function pluginCommands(): Array<{ pluginId: string; name: string; command: NonNullable<PluginHooks["command"]>[string] }> {
  const result: Array<{ pluginId: string; name: string; command: NonNullable<PluginHooks["command"]>[string] }> = []

  for (const plugin of plugins) {
    for (const [name, command] of Object.entries(plugin.hooks.command ?? {})) {
      result.push({ pluginId: plugin.id, name, command })
    }
  }

  return result
}

export function pluginAuth(providerId: string): NonNullable<PluginHooks["auth"]>[string] | undefined {
  for (const plugin of plugins) {
    const auth = plugin.hooks.auth?.[providerId]
    if (auth) return auth
  }
  return undefined
}
