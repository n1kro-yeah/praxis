/**
 * Built-in rules, pattern matching, and configuration parsing.
 *
 * The built-in ruleset is the most security-relevant code in the project. Its
 * job is to be safe by default without being annoying: read anything inside the
 * repository freely, ask before writing, and refuse outright the small set of
 * commands that are catastrophic and never a legitimate part of an agent task.
 */

import { isAbsolute, normalize, relative, resolve, sep } from "node:path"
import { homedir } from "node:os"

import { globToRegExp } from "../util/glob.js"
import { commandTokens, splitCommandChain } from "../util/shell.js"
import type {
  PermissionAction,
  PermissionConfig,
  PermissionEffect,
  PermissionRule,
  PermissionSource,
  RiskLevel,
} from "./types.js"
import { PERMISSION_ACTIONS, isPermissionAction } from "./types.js"

/* ------------------------------------------------------------------ */
/* Built-in rules                                                      */
/* ------------------------------------------------------------------ */

function rule(
  action: PermissionAction,
  resource: string,
  effect: PermissionEffect,
  reason?: string,
): PermissionRule {
  return { action, resource, effect, effect2: undefined, source: "builtin", reason } as PermissionRule
}

/**
 * Commands that are denied unconditionally.
 *
 * The bar for this list is: no legitimate agent task requires it, and running it
 * by accident is unrecoverable. Anything merely risky belongs in `ASK_COMMANDS`
 * so the user can approve it in context.
 */
export const FORBIDDEN_COMMANDS: ReadonlyArray<{ pattern: string; reason: string }> = [
  { pattern: "rm -rf /*", reason: "Recursive delete of the filesystem root." },
  { pattern: "rm -rf /", reason: "Recursive delete of the filesystem root." },
  { pattern: "rm -rf ~", reason: "Recursive delete of the home directory." },
  { pattern: "rm -rf ~/*", reason: "Recursive delete of the home directory." },
  { pattern: "rm -fr /*", reason: "Recursive delete of the filesystem root." },
  { pattern: "rm -rf --no-preserve-root*", reason: "Explicitly bypasses the root guard." },
  { pattern: "mkfs*", reason: "Formats a filesystem." },
  { pattern: "dd if=* of=/dev/*", reason: "Writes directly to a block device." },
  { pattern: "> /dev/sd*", reason: "Writes directly to a block device." },
  { pattern: "chmod -R 777 /*", reason: "Removes all filesystem protection." },
  { pattern: "chown -R * /", reason: "Reassigns ownership of the whole filesystem." },
  { pattern: ":(){ :|:& };:", reason: "Fork bomb." },
  { pattern: "shutdown*", reason: "Shuts the machine down." },
  { pattern: "reboot*", reason: "Reboots the machine." },
  { pattern: "halt*", reason: "Halts the machine." },
  { pattern: "init 0*", reason: "Halts the machine." },
  { pattern: "git push --force*", reason: "Force push rewrites shared history; ask the user to run it." },
  { pattern: "git push -f*", reason: "Force push rewrites shared history; ask the user to run it." },
  { pattern: "history -c*", reason: "Destroys the user's shell history." },
  { pattern: "* | sh", reason: "Pipes downloaded content straight into a shell." },
  { pattern: "* | bash", reason: "Pipes downloaded content straight into a shell." },
  { pattern: "curl * | *sh*", reason: "Pipes downloaded content straight into a shell." },
  { pattern: "wget * | *sh*", reason: "Pipes downloaded content straight into a shell." },
]

/**
 * Commands that always prompt, even when a broader allow rule matches.
 *
 * These are recoverable but consequential, and the user almost always wants to
 * see them before they happen.
 */
export const ASK_COMMANDS: ReadonlyArray<{ pattern: string; reason: string }> = [
  { pattern: "rm -rf *", reason: "Recursive delete." },
  { pattern: "rm -r *", reason: "Recursive delete." },
  { pattern: "git commit*", reason: "Creates a commit." },
  { pattern: "git push*", reason: "Publishes commits." },
  { pattern: "git reset --hard*", reason: "Discards uncommitted work." },
  { pattern: "git clean -*", reason: "Deletes untracked files." },
  { pattern: "git rebase*", reason: "Rewrites local history." },
  { pattern: "git checkout -- *", reason: "Discards uncommitted changes." },
  { pattern: "git stash drop*", reason: "Deletes stashed work." },
  { pattern: "git filter-branch*", reason: "Rewrites history." },
  { pattern: "npm publish*", reason: "Publishes a package." },
  { pattern: "pnpm publish*", reason: "Publishes a package." },
  { pattern: "yarn publish*", reason: "Publishes a package." },
  { pattern: "cargo publish*", reason: "Publishes a crate." },
  { pattern: "npm install*", reason: "Modifies dependencies." },
  { pattern: "npm i *", reason: "Modifies dependencies." },
  { pattern: "pnpm add*", reason: "Modifies dependencies." },
  { pattern: "yarn add*", reason: "Modifies dependencies." },
  { pattern: "bun add*", reason: "Modifies dependencies." },
  { pattern: "pip install*", reason: "Modifies the Python environment." },
  { pattern: "uv add*", reason: "Modifies dependencies." },
  { pattern: "cargo add*", reason: "Modifies dependencies." },
  { pattern: "go get*", reason: "Modifies dependencies." },
  { pattern: "brew install*", reason: "Installs system software." },
  { pattern: "apt*", reason: "Installs system software." },
  { pattern: "apt-get*", reason: "Installs system software." },
  { pattern: "yum*", reason: "Installs system software." },
  { pattern: "dnf*", reason: "Installs system software." },
  { pattern: "pacman*", reason: "Installs system software." },
  { pattern: "docker run*", reason: "Starts a container." },
  { pattern: "docker rm*", reason: "Removes a container." },
  { pattern: "docker system prune*", reason: "Deletes Docker data." },
  { pattern: "kubectl delete*", reason: "Deletes cluster resources." },
  { pattern: "kubectl apply*", reason: "Changes cluster state." },
  { pattern: "terraform apply*", reason: "Changes infrastructure." },
  { pattern: "terraform destroy*", reason: "Destroys infrastructure." },
  { pattern: "aws *", reason: "Cloud operation." },
  { pattern: "gcloud *", reason: "Cloud operation." },
  { pattern: "az *", reason: "Cloud operation." },
  { pattern: "gh pr merge*", reason: "Merges a pull request." },
  { pattern: "gh release create*", reason: "Publishes a release." },
  { pattern: "systemctl*", reason: "Changes system services." },
  { pattern: "launchctl*", reason: "Changes system services." },
  { pattern: "sudo *", reason: "Runs with elevated privileges." },
  { pattern: "doas *", reason: "Runs with elevated privileges." },
  { pattern: "su *", reason: "Switches user." },
  { pattern: "ssh *", reason: "Connects to a remote host." },
  { pattern: "scp *", reason: "Copies to or from a remote host." },
  { pattern: "rsync *", reason: "Synchronises directories." },
  { pattern: "crontab*", reason: "Schedules recurring jobs." },
  { pattern: "killall*", reason: "Kills processes by name." },
  { pattern: "pkill*", reason: "Kills processes by name." },
]

/**
 * Commands allowed without a prompt.
 *
 * All read-only. The list is long on purpose: every entry here is a prompt the
 * user does not see, and an agent that has to ask permission to run `git status`
 * is exhausting to use.
 */
export const SAFE_COMMANDS: readonly string[] = [
  "ls", "ls *", "pwd", "cd *", "echo *", "cat *", "head *", "tail *", "wc *",
  "file *", "stat *", "du *", "df *", "which *", "whereis *", "type *",
  "basename *", "dirname *", "realpath *", "readlink *", "env", "printenv",
  "date", "uname *", "uname", "hostname", "whoami", "id", "uptime",
  "tree *", "tree", "find *", "grep *", "rg *", "ag *", "ack *", "fd *",
  "sort *", "uniq *", "cut *", "tr *", "jq *", "yq *", "xxd *", "hexdump *",
  "diff *", "cmp *", "comm *", "md5sum *", "sha256sum *", "shasum *",
  "git status*", "git diff*", "git log*", "git show*", "git branch",
  "git branch -*", "git remote*", "git blame*", "git ls-files*",
  "git rev-parse*", "git describe*", "git config --get*", "git shortlog*",
  "git stash list*", "git tag", "git tag -l*", "git worktree list*",
  "git cat-file*", "git merge-base*", "git count-objects*", "git fetch*",
  "npm ls*", "npm list*", "npm view*", "npm outdated*", "npm run", "npm test*",
  "npm why*", "npm exec tsc*", "pnpm list*", "pnpm why*", "pnpm test*",
  "yarn list*", "yarn why*", "bun pm ls*", "bunx tsc*", "npx tsc*",
  "tsc*", "eslint *", "prettier *", "biome *", "oxlint *",
  "cargo check*", "cargo test*", "cargo clippy*", "cargo tree*", "cargo fmt*",
  "cargo metadata*", "go test*", "go vet*", "go build*", "go list*", "go fmt*",
  "gofmt *", "go doc*", "go env*",
  "python -V", "python --version", "python -c *", "python -m pytest*",
  "pytest*", "ruff *", "mypy *", "black --check*", "pyright*", "tox*",
  "node -v", "node --version", "node -e *", "deno check*", "deno lint*",
  "deno test*", "deno fmt --check*",
  "make -n*", "make --dry-run*", "make check*", "make test*", "make lint*",
  "mix test*", "mix format --check*", "mix compile*",
  "bundle exec rspec*", "bundle exec rubocop*", "rake test*",
  "swift test*", "swift build*", "dotnet build*", "dotnet test*",
  "gradle test*", "./gradlew test*", "mvn test*", "mvn compile*",
  "dart analyze*", "dart test*", "flutter analyze*", "flutter test*",
  "docker ps*", "docker images*", "docker logs*", "docker inspect*",
  "kubectl get*", "kubectl describe*", "kubectl logs*",
  "terraform plan*", "terraform validate*", "terraform fmt -check*",
  "gh pr list*", "gh pr view*", "gh issue list*", "gh issue view*",
  "gh run list*", "gh run view*", "gh repo view*", "gh api *",
  "curl -s *", "curl -I *", "ps *", "ps", "top -b*", "lsof *",
  "true", "false", "sleep *", "printf *", "seq *", "tee *", "xargs *",
]

/** Paths never read, even when a broad read rule allows it. */
export const SECRET_PATHS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "**/.npmrc",
  "**/.netrc",
  "**/.pgpass",
  "**/id_rsa",
  "**/id_ed25519",
  "**/id_ecdsa",
  "**/id_dsa",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.keystore",
  "**/.ssh/**",
  "**/.aws/credentials",
  "**/.aws/config",
  "**/.gnupg/**",
  "**/.kube/config",
  "**/.docker/config.json",
  "**/credentials.json",
  "**/service-account*.json",
  "**/secrets.y*ml",
  "**/.config/gh/hosts.yml",
  "**/.praxis/auth.json",
]

/** Paths never written, because they are generated or belong to the tooling. */
export const PROTECTED_PATHS: readonly string[] = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.venv/**",
  "**/venv/**",
  "**/target/debug/**",
  "**/target/release/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
]

/** The default ruleset, in ascending specificity. */
export function builtinRules(): PermissionRule[] {
  const rules: PermissionRule[] = []

  // Reads inside the project are free.
  rules.push(rule("read", "**", "allow"))
  for (const pattern of SECRET_PATHS) {
    if (pattern.startsWith("!")) continue
    rules.push(
      rule(
        "read",
        pattern,
        "ask",
        "This file usually contains credentials. Confirm before it enters the model's context.",
      ),
    )
  }

  // Writes prompt by default; the prompt offers a per-directory allow.
  rules.push(rule("edit", "**", "ask"))
  for (const pattern of PROTECTED_PATHS) {
    rules.push(rule("edit", pattern, "deny", "Generated, vendored, or version-control internal."))
  }

  rules.push(rule("delete", "**", "ask"))
  rules.push(rule("external_directory", "**", "ask", "Outside the working directory."))
  rules.push(rule("global_write", "**", "deny", "Writes outside the project require an explicit instruction."))
  rules.push(rule("secrets", "**", "ask"))

  // Shell: deny the catastrophic, ask for the consequential, allow the rest.
  rules.push(rule("shell", "**", "ask"))
  for (const command of SAFE_COMMANDS) rules.push(rule("shell", command, "allow"))
  for (const entry of ASK_COMMANDS) rules.push(rule("shell", entry.pattern, "ask", entry.reason))
  for (const entry of FORBIDDEN_COMMANDS) rules.push(rule("shell", entry.pattern, "deny", entry.reason))

  rules.push(rule("git_write", "**", "ask"))
  rules.push(rule("package_install", "**", "ask"))
  rules.push(rule("background_process", "**", "ask"))
  rules.push(rule("subagent", "**", "allow"))
  rules.push(rule("webfetch", "**", "allow"))
  rules.push(rule("websearch", "**", "allow"))
  rules.push(rule("mcp", "**", "ask"))
  rules.push(rule("share", "**", "ask", "Sharing makes the session readable by anyone with the link."))

  return rules
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

const regexCache = new Map<string, RegExp>()

/**
 * Matches a shell command against a pattern.
 *
 * Command matching is *not* path matching: `*` must be allowed to span spaces
 * (so `git commit *` matches `git commit -m "a b"`), and the comparison must be
 * token-aware so `gitx status` does not match `git status*`.
 */
export function matchCommand(pattern: string, command: string): boolean {
  const normalizedCommand = command.trim().replace(/\s+/g, " ")
  const normalizedPattern = pattern.trim().replace(/\s+/g, " ")
  if (normalizedPattern === "**" || normalizedPattern === "*") return true
  if (normalizedPattern === normalizedCommand) return true

  const key = `cmd:${normalizedPattern}`
  let regex = regexCache.get(key)
  if (!regex) {
    const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    const body = escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, ".*").replace(/\u0000/g, ".*").replace(/\?/g, ".")
    regex = new RegExp(`^${body}$`, "s")
    regexCache.set(key, regex)
  }
  if (regex.test(normalizedCommand)) return true

  // A pattern without a trailing wildcard still matches the bare command:
  // `git status` should match the pattern `git status*`.
  if (!normalizedPattern.includes("*")) {
    return normalizedCommand === normalizedPattern
  }
  return false
}

/**
 * Matches a path against a pattern, after expanding `~` and resolving relative
 * segments. Paths are compared with forward slashes on every platform so a
 * single configuration works everywhere.
 */
export function matchPath(pattern: string, path: string, cwd: string): boolean {
  const expandedPattern = expandHome(pattern)
  const absolute = isAbsolute(path) ? normalize(path) : resolve(cwd, path)
  const posixPath = absolute.split(sep).join("/")
  const relativePath = relative(cwd, absolute).split(sep).join("/")

  const key = `path:${expandedPattern}`
  let regex = regexCache.get(key)
  if (!regex) {
    regex = globToRegExp(expandedPattern, { dot: true })
    regexCache.set(key, regex)
  }

  if (regex.test(posixPath)) return true
  if (relativePath !== "" && !relativePath.startsWith("..") && regex.test(relativePath)) return true
  // Bare `**` matches everything, including the cwd itself.
  if (expandedPattern === "**" || expandedPattern === "*") return true
  return false
}

export function expandHome(pattern: string): string {
  if (pattern === "~") return homedir()
  if (pattern.startsWith("~/")) return `${homedir()}/${pattern.slice(2)}`
  if (pattern.startsWith("$HOME/")) return `${homedir()}/${pattern.slice(6)}`
  if (pattern === "$HOME") return homedir()
  return pattern
}

/** Actions whose resource is a filesystem path. */
const PATH_ACTIONS = new Set<PermissionAction>([
  "read",
  "edit",
  "delete",
  "external_directory",
  "global_write",
  "secrets",
])

export function isPathAction(action: PermissionAction): boolean {
  return PATH_ACTIONS.has(action)
}

export function matchResource(
  action: PermissionAction,
  pattern: string,
  resource: string,
  cwd: string,
): boolean {
  if (isPathAction(action)) return matchPath(pattern, resource, cwd)
  return matchCommand(pattern, resource)
}

/**
 * Specificity score for a pattern. Used to order rules within a layer so the
 * most specific match wins regardless of declaration order.
 */
export function specificity(pattern: string): number {
  if (pattern === "**" || pattern === "*") return 0
  let score = pattern.length
  score -= (pattern.match(/\*\*/g)?.length ?? 0) * 12
  score -= (pattern.match(/(?<!\*)\*(?!\*)/g)?.length ?? 0) * 6
  score -= (pattern.match(/\?/g)?.length ?? 0) * 2
  // A pattern with more literal path or token separators is more specific.
  score += (pattern.match(/[/ ]/g)?.length ?? 0) * 3
  return score
}

/* ------------------------------------------------------------------ */
/* Risk assessment                                                     */
/* ------------------------------------------------------------------ */

const CRITICAL_MARKERS = [
  /rm\s+-[rf]{2,}/,
  /--no-preserve-root/,
  /mkfs/,
  /dd\s+if=.*of=\/dev/,
  /:\(\)\s*\{.*\}\s*;/,
  /chmod\s+-R\s+777\s+\//,
  /git\s+push\s+.*(--force|-f)\b/,
  />\s*\/dev\/(sd|nvme|disk)/,
]

const HIGH_MARKERS = [
  /\brm\b/,
  /\bsudo\b/,
  /\bdoas\b/,
  /git\s+(reset\s+--hard|clean|filter-branch|rebase)/,
  /(npm|pnpm|yarn|cargo)\s+publish/,
  /terraform\s+(apply|destroy)/,
  /kubectl\s+delete/,
  /docker\s+(system\s+prune|volume\s+rm)/,
  /\bshutdown\b|\breboot\b/,
  /\|\s*(ba)?sh\b/,
  /curl.*\|/,
  /\btruncate\b/,
  /\bshred\b/,
]

const MEDIUM_MARKERS = [
  /git\s+(commit|push|merge|tag|stash)/,
  /(npm|pnpm|yarn|bun|pip|uv|cargo|go)\s+(install|add|get|remove|uninstall)/,
  /docker\s+(run|build|rm|stop)/,
  /kubectl\s+apply/,
  /\b(mv|cp)\b/,
  /\bchmod\b|\bchown\b/,
  /\bmkdir\b|\btouch\b/,
  /\b(ssh|scp|rsync)\b/,
  />/,
  /\bkill\b|\bpkill\b|\bkillall\b/,
]

export function assessRisk(action: PermissionAction, resource: string): RiskLevel {
  if (action === "read") {
    return SECRET_PATHS.some((pattern) => !pattern.startsWith("!") && matchPath(pattern, resource, process.cwd()))
      ? "high"
      : "low"
  }
  if (action === "delete") return "high"
  if (action === "global_write") return "high"
  if (action === "edit") return "medium"
  if (action === "external_directory") return "medium"
  if (action === "secrets") return "high"
  if (action === "subagent" || action === "websearch" || action === "webfetch") return "low"
  if (action === "share") return "medium"

  // Shell and friends: inspect every command in the chain and take the worst.
  let worst: RiskLevel = "low"
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 }
  for (const segment of splitCommandChain(resource)) {
    const level = commandRisk(segment)
    if (rank[level] > rank[worst]) worst = level
  }
  return worst
}

function commandRisk(command: string): RiskLevel {
  if (CRITICAL_MARKERS.some((pattern) => pattern.test(command))) return "critical"
  if (HIGH_MARKERS.some((pattern) => pattern.test(command))) return "high"
  if (MEDIUM_MARKERS.some((pattern) => pattern.test(command))) return "medium"
  return "low"
}

/* ------------------------------------------------------------------ */
/* Suggested patterns                                                  */
/* ------------------------------------------------------------------ */

/**
 * Number of leading tokens that identify a command for permission purposes.
 *
 * `git` alone is useless as a pattern (`git status` and `git push` are wildly
 * different), so git takes two tokens. `npm run` takes three so that
 * `npm run test` and `npm run deploy` stay distinguishable. This is what makes
 * "always allow" useful rather than dangerous.
 */
export const COMMAND_ARITY: Record<string, number> = {
  git: 2,
  gh: 3,
  npm: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  npx: 2,
  bunx: 2,
  cargo: 2,
  go: 2,
  docker: 2,
  kubectl: 2,
  terraform: 2,
  aws: 3,
  gcloud: 3,
  az: 3,
  systemctl: 2,
  brew: 2,
  apt: 2,
  "apt-get": 2,
  pip: 2,
  pip3: 2,
  uv: 2,
  poetry: 2,
  mix: 2,
  swift: 2,
  dotnet: 2,
  gradle: 2,
  mvn: 2,
  make: 2,
  deno: 2,
  dart: 2,
  flutter: 2,
  python: 2,
  python3: 2,
  node: 2,
  ruby: 2,
  bundle: 3,
  rake: 2,
  helm: 2,
  pulumi: 2,
}

export function commandArity(command: string): number {
  const tokens = commandTokens(command)
  const head = tokens[0] ?? ""
  const base = COMMAND_ARITY[head] ?? 1
  // `npm run <script>` needs the script name to be meaningful.
  if ((head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") && tokens[1] === "run") {
    return 3
  }
  if (head === "git" && (tokens[1] === "remote" || tokens[1] === "submodule" || tokens[1] === "worktree")) {
    return 3
  }
  return base
}

/**
 * Builds the pattern offered by the "always allow" option.
 *
 * For a command this is the first `arity` tokens plus a wildcard; for a path it
 * is the containing directory plus `/**`. Both are the granularity a user
 * actually means when they say "stop asking me about this".
 */
export function suggestPattern(action: PermissionAction, resource: string, cwd: string): string {
  if (isPathAction(action)) {
    const absolute = isAbsolute(resource) ? resource : resolve(cwd, resource)
    const relativePath = relative(cwd, absolute).split(sep).join("/")
    if (relativePath === "" || relativePath.startsWith("..")) {
      const parent = absolute.split(sep).slice(0, -1).join("/")
      return `${parent}/**`
    }
    const segments = relativePath.split("/")
    if (segments.length <= 1) return relativePath
    return `${segments.slice(0, -1).join("/")}/**`
  }

  const tokens = commandTokens(resource)
  const arity = Math.min(commandArity(resource), tokens.length)
  const head = tokens.slice(0, arity).join(" ")
  return tokens.length > arity ? `${head} *` : `${head}*`
}

/* ------------------------------------------------------------------ */
/* Configuration parsing                                               */
/* ------------------------------------------------------------------ */

/**
 * Parses any of the accepted configuration forms into rules.
 *
 * Unknown action names are skipped rather than rejected: a configuration
 * written for a newer version should degrade, not break the session.
 */
export function parsePermissionConfig(
  config: PermissionConfig | undefined,
  source: PermissionSource,
): PermissionRule[] {
  if (!config) return []
  const rules: PermissionRule[] = []

  if (Array.isArray(config)) {
    for (const entry of config) {
      if (!isPermissionAction(entry.action)) continue
      rules.push({
        action: entry.action,
        resource: entry.resource,
        effect: entry.effect,
        source,
        reason: entry.reason,
      })
    }
    return rules
  }

  for (const [key, value] of Object.entries(config)) {
    const action = normalizeActionKey(key)
    if (!action) continue
    if (typeof value === "string") {
      rules.push({ action, resource: "**", effect: value, source })
      continue
    }
    if (value && typeof value === "object") {
      for (const [resource, effect] of Object.entries(value)) {
        if (effect !== "allow" && effect !== "deny" && effect !== "ask") continue
        rules.push({ action, resource, effect, source })
      }
    }
  }

  return rules
}

/** Accepts the action name, a tool name, or a legacy alias. */
function normalizeActionKey(key: string): PermissionAction | undefined {
  if (isPermissionAction(key)) return key
  const aliases: Record<string, PermissionAction> = {
    bash: "shell",
    command: "shell",
    write: "edit",
    file: "edit",
    fetch: "webfetch",
    search: "websearch",
    agent: "subagent",
    task: "subagent",
    external: "external_directory",
    install: "package_install",
    git: "git_write",
  }
  return aliases[key]
}

/** Parses the `PRAXIS_PERMISSION` environment variable (JSON). */
export function parseEnvPermissions(): PermissionRule[] {
  const raw = process.env["PRAXIS_PERMISSION"]
  if (!raw) return []
  try {
    return parsePermissionConfig(JSON.parse(raw) as PermissionConfig, "env")
  } catch {
    return []
  }
}

/** Parses legacy `tools: { name: boolean }` configuration. */
export function parseToolToggles(
  tools: Record<string, boolean> | undefined,
  source: PermissionSource,
): PermissionRule[] {
  if (!tools) return []
  const rules: PermissionRule[] = []
  for (const [name, enabled] of Object.entries(tools)) {
    if (enabled) continue
    const action = normalizeActionKey(name)
    if (!action) continue
    rules.push({
      action,
      resource: "**",
      effect: "deny",
      source,
      reason: `The \`${name}\` tool is disabled in configuration.`,
    })
  }
  return rules
}

/** All action names, for CLI help and validation messages. */
export function allActions(): readonly PermissionAction[] {
  return PERMISSION_ACTIONS
}
