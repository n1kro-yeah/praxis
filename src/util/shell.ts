/**
 * Shell command parsing, quoting and analysis.
 *
 * The permission engine must understand what a command *does* before it runs:
 * which binary is invoked, whether the invocation is chained with `&&` or `;`,
 * whether it redirects to a file, and how many tokens are significant for
 * pattern matching (`git status` is safe, `git push` is not). Getting this
 * wrong is a security hole, so the parser is deliberately conservative: any
 * construct it cannot fully understand is reported as opaque and the caller
 * escalates to an interactive prompt.
 */

export type TokenType =
  | "word"
  | "operator"
  | "redirect"
  | "subshell"
  | "assignment"
  | "comment"

export interface ShellToken {
  readonly type: TokenType
  readonly value: string
  readonly quoted: boolean
  readonly start: number
  readonly end: number
}

const OPERATORS = ["&&", "||", "|&", ";;", "|", ";", "&", "\n"] as const
const REDIRECTS = [">>", "<<<", "<<", "2>&1", "&>>", "&>", ">|", ">", "<"] as const

/**
 * Tokenises a shell command. Handles single/double quotes, escapes,
 * `$(...)`/backtick substitution and `${...}` expansion as opaque units.
 */
export function tokenize(input: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let index = 0

  const pushWord = (value: string, quoted: boolean, start: number, end: number) => {
    if (value === "") return
    const type: TokenType = /^[A-Za-z_][A-Za-z0-9_]*=/.test(value) && !quoted ? "assignment" : "word"
    tokens.push({ type, value, quoted, start, end })
  }

  while (index < input.length) {
    const char = input[index] as string

    if (char === " " || char === "\t" || char === "\r") {
      index++
      continue
    }

    if (char === "#" && (index === 0 || /\s/.test(input[index - 1] as string))) {
      const start = index
      while (index < input.length && input[index] !== "\n") index++
      tokens.push({
        type: "comment",
        value: input.slice(start, index),
        quoted: false,
        start,
        end: index,
      })
      continue
    }

    // Operators.
    let matchedOperator: string | undefined
    for (const operator of OPERATORS) {
      if (input.startsWith(operator, index)) {
        matchedOperator = operator
        break
      }
    }
    if (matchedOperator) {
      tokens.push({
        type: "operator",
        value: matchedOperator,
        quoted: false,
        start: index,
        end: index + matchedOperator.length,
      })
      index += matchedOperator.length
      continue
    }

    // Redirections.
    let matchedRedirect: string | undefined
    for (const redirect of REDIRECTS) {
      if (input.startsWith(redirect, index)) {
        matchedRedirect = redirect
        break
      }
    }
    // Numeric file descriptors: 2>, 1>>
    const fdMatch = /^\d+(?:>>|>&|>|<)/.exec(input.slice(index))
    if (fdMatch) matchedRedirect = fdMatch[0]
    if (matchedRedirect) {
      tokens.push({
        type: "redirect",
        value: matchedRedirect,
        quoted: false,
        start: index,
        end: index + matchedRedirect.length,
      })
      index += matchedRedirect.length
      continue
    }

    // Command substitution and grouping are opaque.
    if (
      char === "`" ||
      (char === "$" && input[index + 1] === "(") ||
      char === "(" ||
      (char === "$" && input[index + 1] === "{")
    ) {
      const start = index
      const open = char === "`" ? "`" : char === "(" ? "(" : (input[index + 1] as string)
      const close = open === "`" ? "`" : open === "(" ? ")" : "}"
      if (open === "`") {
        index++
        while (index < input.length && input[index] !== "`") {
          if (input[index] === "\\") index++
          index++
        }
        index++
      } else {
        index += char === "(" ? 1 : 2
        let depth = 1
        while (index < input.length && depth > 0) {
          const current = input[index]
          if (current === "\\") {
            index += 2
            continue
          }
          if (current === open) depth++
          else if (current === close) depth--
          index++
        }
      }
      tokens.push({
        type: "subshell",
        value: input.slice(start, index),
        quoted: false,
        start,
        end: index,
      })
      continue
    }

    // A regular word, possibly containing quoted segments.
    const start = index
    let value = ""
    let quoted = false
    while (index < input.length) {
      const current = input[index] as string
      if (current === "\\") {
        value += input[index + 1] ?? ""
        index += 2
        continue
      }
      if (current === "'") {
        quoted = true
        index++
        while (index < input.length && input[index] !== "'") {
          value += input[index]
          index++
        }
        index++
        continue
      }
      if (current === '"') {
        quoted = true
        index++
        while (index < input.length && input[index] !== '"') {
          if (input[index] === "\\") {
            value += input[index + 1] ?? ""
            index += 2
            continue
          }
          value += input[index]
          index++
        }
        index++
        continue
      }
      if (/[\s;|&<>()`]/.test(current)) break
      if (current === "$" && (input[index + 1] === "(" || input[index + 1] === "{")) break
      value += current
      index++
    }
    pushWord(value, quoted, start, index)
  }

  return tokens
}

export interface SimpleCommand {
  /** Argv after stripping assignments and redirections. */
  readonly argv: string[]
  /** Leading `FOO=bar` assignments. */
  readonly assignments: Record<string, string>
  /** Redirection targets, e.g. `> out.txt`. */
  readonly redirections: Array<{ operator: string; target: string }>
  /** True when the command contains constructs we cannot fully analyse. */
  readonly opaque: boolean
  /** Original text of this segment. */
  readonly text: string
}

export interface ParsedCommand {
  readonly commands: SimpleCommand[]
  /** Operators joining the commands, one fewer than `commands.length`. */
  readonly operators: string[]
  readonly opaque: boolean
  readonly backgrounded: boolean
}

/** Splits a command line into simple commands joined by control operators. */
export function parseCommand(input: string): ParsedCommand {
  const tokens = tokenize(input)
  const commands: SimpleCommand[] = []
  const operators: string[] = []

  let argv: string[] = []
  let assignments: Record<string, string> = {}
  let redirections: Array<{ operator: string; target: string }> = []
  let opaque = false
  let segmentStart = 0
  let backgrounded = false

  const flush = (end: number) => {
    if (argv.length === 0 && Object.keys(assignments).length === 0 && redirections.length === 0) {
      return
    }
    commands.push({
      argv,
      assignments,
      redirections,
      opaque,
      text: input.slice(segmentStart, end).trim(),
    })
    argv = []
    assignments = {}
    redirections = []
    opaque = false
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as ShellToken
    if (token.type === "comment") continue

    if (token.type === "operator") {
      if (token.value === "&") backgrounded = true
      flush(token.start)
      operators.push(token.value)
      segmentStart = token.end
      continue
    }
    if (token.type === "redirect") {
      const target = tokens[i + 1]
      redirections.push({ operator: token.value, target: target?.value ?? "" })
      if (target && target.type === "word") i++
      continue
    }
    if (token.type === "subshell") {
      opaque = true
      argv.push(token.value)
      continue
    }
    if (token.type === "assignment" && argv.length === 0) {
      const eq = token.value.indexOf("=")
      assignments[token.value.slice(0, eq)] = token.value.slice(eq + 1)
      continue
    }
    argv.push(token.value)
  }
  flush(input.length)

  return {
    commands,
    operators,
    opaque: commands.some((c) => c.opaque),
    backgrounded,
  }
}

/**
 * Number of leading argv tokens that determine what a command actually does.
 * `git` needs two (`git push`), `npm run` needs three (`npm run deploy`), and
 * most commands need one. Used to build permission patterns automatically.
 */
const ARITY: Record<string, number> = {
  git: 2,
  gh: 2,
  docker: 2,
  "docker-compose": 2,
  kubectl: 2,
  helm: 2,
  terraform: 2,
  aws: 2,
  gcloud: 2,
  az: 2,
  cargo: 2,
  go: 2,
  npm: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  deno: 2,
  pip: 2,
  pip3: 2,
  poetry: 2,
  uv: 2,
  brew: 2,
  apt: 2,
  "apt-get": 2,
  dnf: 2,
  yum: 2,
  pacman: 2,
  systemctl: 2,
  service: 2,
  make: 2,
  gradle: 2,
  mvn: 2,
  dotnet: 2,
  composer: 2,
  bundle: 2,
  rails: 2,
  flutter: 2,
  supabase: 2,
  vercel: 2,
  wrangler: 2,
  fly: 2,
  railway: 2,
  heroku: 2,
  tsc: 1,
  node: 1,
  python: 1,
  python3: 1,
}

/** Sub-commands that themselves take a meaningful argument. */
const NESTED_ARITY: Record<string, number> = {
  "npm run": 3,
  "pnpm run": 3,
  "yarn run": 3,
  "bun run": 3,
  "deno task": 3,
  "cargo run": 3,
  "go run": 3,
  "git remote": 3,
  "git submodule": 3,
  "git config": 3,
  "docker compose": 3,
  "gh pr": 3,
  "gh repo": 3,
  "gh issue": 3,
  "kubectl get": 3,
  "aws s3": 3,
  "systemctl start": 3,
  "make -j": 2,
}

export function commandArity(argv: readonly string[]): number {
  if (argv.length === 0) return 0
  const binary = baseName(argv[0] as string)
  const two = `${binary} ${argv[1] ?? ""}`.trim()
  if (NESTED_ARITY[two]) return Math.min(NESTED_ARITY[two] as number, argv.length)
  const base = ARITY[binary] ?? 1
  return Math.min(base, argv.length)
}

function baseName(command: string): string {
  const normalized = command.split(/[\\/]/).pop() ?? command
  return normalized.replace(/\.(exe|cmd|bat)$/i, "")
}

/**
 * Builds the permission pattern for a command: the significant prefix plus a
 * trailing wildcard. `git push origin main` becomes `git push *`.
 */
export function permissionPattern(argv: readonly string[]): string {
  if (argv.length === 0) return "*"
  const arity = commandArity(argv)
  const prefix = argv.slice(0, arity).join(" ")
  return argv.length > arity ? `${prefix} *` : prefix
}

/** Every distinct binary a command line will invoke. */
export function invokedBinaries(input: string): string[] {
  const parsed = parseCommand(input)
  const out = new Set<string>()
  for (const command of parsed.commands) {
    const first = command.argv[0]
    if (!first) continue
    out.add(baseName(first))
    // `sudo`, `env`, `xargs`, `time` and friends wrap another command.
    if (WRAPPERS.has(baseName(first))) {
      const inner = command.argv.slice(1).find((arg) => !arg.startsWith("-") && !arg.includes("="))
      if (inner) out.add(baseName(inner))
    }
  }
  return [...out]
}

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "xargs",
  "time",
  "nice",
  "nohup",
  "timeout",
  "stdbuf",
  "watch",
  "command",
  "exec",
])

export interface CommandRisk {
  readonly level: "safe" | "caution" | "dangerous"
  readonly reasons: string[]
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/(?:\s|$)/, reason: "recursive delete of /" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, reason: "forced recursive delete" },
  { pattern: /\b(mkfs|fdisk|parted|dd)\b/, reason: "disk-level operation" },
  { pattern: />\s*\/dev\/(sd|nvme|disk)/, reason: "writing to a block device" },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, reason: "world-writable permissions" },
  { pattern: /\bchown\s+-R\s+/, reason: "recursive ownership change" },
  { pattern: /:\(\)\s*\{.*\|.*&.*\}\s*;/, reason: "fork bomb" },
  { pattern: /\bcurl\b[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh/, reason: "piping a download into a shell" },
  { pattern: /\bwget\b[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh/, reason: "piping a download into a shell" },
  { pattern: /\bgit\s+push\b.*(--force|-f)\b/, reason: "force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "discards local changes" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: "deletes untracked files" },
  { pattern: /\bhistory\s+-c\b/, reason: "clears shell history" },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, reason: "system power state" },
  { pattern: /\bkill\s+-9\s+1\b/, reason: "killing init" },
  { pattern: /\bnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, reason: "publishes a package" },
  { pattern: /\b(aws|gcloud|az)\b.*\b(delete|destroy|terminate|rm)\b/, reason: "cloud resource deletion" },
  { pattern: /\bterraform\s+(destroy|apply)\b/, reason: "infrastructure mutation" },
  { pattern: /\bkubectl\s+delete\b/, reason: "deletes cluster resources" },
  { pattern: /\bdrop\s+(database|table)\b/i, reason: "destructive SQL" },
]

const CAUTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b|\bdoas\b/, reason: "elevated privileges" },
  { pattern: /\bgit\s+push\b/, reason: "publishes commits" },
  { pattern: /\bgit\s+commit\b/, reason: "creates a commit" },
  { pattern: /\b(npm|pnpm|yarn|bun|pip|cargo|go)\s+(install|add|get)\b/, reason: "installs dependencies" },
  { pattern: /\bmv\b|\bcp\s+-r\b/, reason: "moves or copies files" },
  { pattern: /\brm\b/, reason: "deletes files" },
  { pattern: /\b(curl|wget|http|nc|ssh|scp|rsync)\b/, reason: "network access" },
  { pattern: /\bdocker\s+(run|exec|rm|rmi)\b/, reason: "container lifecycle" },
  { pattern: />|>>/, reason: "redirects output to a file" },
  { pattern: /\beval\b|\bsource\b|^\s*\./, reason: "evaluates arbitrary code" },
]

/** Heuristic risk classification used to pick a default permission action. */
export function assessRisk(input: string): CommandRisk {
  const reasons: string[] = []
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(input)) reasons.push(reason)
  }
  if (reasons.length) return { level: "dangerous", reasons }
  for (const { pattern, reason } of CAUTION_PATTERNS) {
    if (pattern.test(input)) reasons.push(reason)
  }
  if (reasons.length) return { level: "caution", reasons }
  return { level: "safe", reasons: [] }
}

/** Commands that only read state and are safe to auto-approve. */
const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "whoami",
  "hostname",
  "date",
  "echo",
  "printf",
  "which",
  "type",
  "file",
  "stat",
  "du",
  "df",
  "env",
  "printenv",
  "uname",
  "id",
  "groups",
  "tree",
  "find",
  "grep",
  "rg",
  "ag",
  "ack",
  "fd",
  "jq",
  "yq",
  "sort",
  "uniq",
  "cut",
  "awk",
  "sed",
  "diff",
  "comm",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "true",
  "false",
  "sleep",
  "seq",
  "tr",
  "column",
  "less",
  "more",
  "man",
  "help",
  "ps",
  "top",
  "uptime",
  "free",
  "nproc",
])

const READ_ONLY_SUBCOMMANDS = new Set([
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git remote",
  "git blame",
  "git describe",
  "git rev-parse",
  "git ls-files",
  "git stash list",
  "git config --get",
  "npm ls",
  "npm view",
  "npm outdated",
  "pnpm ls",
  "yarn list",
  "cargo tree",
  "cargo check",
  "go list",
  "go vet",
  "docker ps",
  "docker images",
  "docker logs",
  "kubectl get",
  "kubectl describe",
  "kubectl logs",
  "gh pr list",
  "gh pr view",
  "gh issue list",
])

/** True when every command in the line is known read-only. */
export function isReadOnlyCommand(input: string): boolean {
  const parsed = parseCommand(input)
  if (parsed.opaque) return false
  if (parsed.commands.length === 0) return false
  for (const command of parsed.commands) {
    if (command.redirections.some((r) => r.operator.includes(">"))) return false
    const first = command.argv[0]
    if (!first) return false
    const binary = baseName(first)
    if (READ_ONLY.has(binary)) continue
    const two = `${binary} ${command.argv[1] ?? ""}`.trim()
    const three = `${two} ${command.argv[2] ?? ""}`.trim()
    if (READ_ONLY_SUBCOMMANDS.has(two) || READ_ONLY_SUBCOMMANDS.has(three)) continue
    return false
  }
  return true
}

/* ------------------------------------------------------------------ */
/* Quoting                                                             */
/* ------------------------------------------------------------------ */

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

/** POSIX single-quote escaping. */
export function quote(value: string): string {
  if (value === "") return "''"
  if (SAFE_WORD.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function quoteArgv(argv: readonly string[]): string {
  return argv.map(quote).join(" ")
}

/** Windows `cmd.exe` quoting, which follows entirely different rules. */
export function quoteWindows(value: string): string {
  if (value === "") return '""'
  if (!/[\s"^&|<>()]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`
}

/** Splits a command string into argv without invoking a shell. */
export function splitArgv(input: string): string[] {
  return tokenize(input)
    .filter((t) => t.type === "word" || t.type === "assignment")
    .map((t) => t.value)
}

/** Expands `~` and `$VAR` references using the provided environment. */
export function expandVariables(
  input: string,
  env: Record<string, string | undefined> = process.env,
  home = env.HOME ?? "",
): string {
  let out = input
  if (home) {
    out = out.replace(/(^|\s)~(?=\/|\s|$)/g, `$1${home}`)
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) =>
    env[name] ?? fallback ?? "",
  )
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => env[name] ?? match)
  return out
}

/** Detects whether a command reads from stdin, so we know to close the pipe. */
export function readsStdin(input: string): boolean {
  const parsed = parseCommand(input)
  return parsed.commands.some((command) => {
    if (command.redirections.some((r) => r.operator.includes("<"))) return true
    const binary = baseName(command.argv[0] ?? "")
    if (STDIN_READERS.has(binary) && command.argv.length === 1) return true
    return command.argv.includes("-") || command.argv.includes("--stdin")
  })
}

const STDIN_READERS = new Set(["cat", "grep", "sed", "awk", "sort", "wc", "jq", "head", "tail", "tr"])

/** Extracts filesystem paths a command will write to, when determinable. */
export function writeTargets(input: string): string[] {
  const parsed = parseCommand(input)
  const out: string[] = []
  for (const command of parsed.commands) {
    for (const redirect of command.redirections) {
      if (redirect.operator.includes(">") && redirect.target) out.push(redirect.target)
    }
    const binary = baseName(command.argv[0] ?? "")
    if (binary === "tee") out.push(...command.argv.slice(1).filter((a) => !a.startsWith("-")))
    if ((binary === "cp" || binary === "mv") && command.argv.length >= 3) {
      out.push(command.argv[command.argv.length - 1] as string)
    }
    if (binary === "rm") out.push(...command.argv.slice(1).filter((a) => !a.startsWith("-")))
    if (binary === "mkdir" || binary === "touch") {
      out.push(...command.argv.slice(1).filter((a) => !a.startsWith("-")))
    }
  }
  return out
}

/** Rewrites a command so it runs inside a specific directory. */
export function withCwd(command: string, cwd: string): string {
  return `cd ${quote(cwd)} && ${command}`
}

/** Picks the user's login shell, with sensible platform fallbacks. */
export function defaultShell(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const powershell = process.env.PRAXIS_SHELL ?? "powershell.exe"
    return { command: powershell, args: ["-NoLogo", "-NonInteractive", "-Command"] }
  }
  const shell = process.env.PRAXIS_SHELL ?? process.env.SHELL ?? "/bin/bash"
  // `-l` would source login files and slow every invocation; `-c` is enough.
  return { command: shell, args: ["-c"] }
}
