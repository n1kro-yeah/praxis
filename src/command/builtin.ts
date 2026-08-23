/**
 * Built-in slash commands.
 *
 * Everything reachable by typing `/` in the prompt. The set is deliberately
 * close to what a person coming from another terminal agent would expect \u2014 command
 * names are a user interface, and inventing new ones for the same operations
 * costs the user relearning for no benefit.
 *
 * The important structural decision: a command does not *do* anything here. It
 * returns a description of what should happen, and the TUI carries it out. That
 * separation is what lets the same command run from the TUI, from the HTTP server,
 * from a script, and from a plugin, without each entry point re-implementing it \u2014
 * and it is why `/export` can open an editor in one context and write to stdout in
 * another without the command knowing which.
 *
 * Aliases exist because muscle memory is real: `/clear` and `/new` do the same
 * thing, and people arrive expecting one or the other.
 */

import { logger } from "../util/log.js"
import { closest } from "../util/fuzzy.js"

const log = logger("command.builtin")

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * What a command asks the host to do.
 *
 * A discriminated union rather than a callback, so that a command's effect can
 * be inspected, logged, queued, tested, and sent over a wire. A callback could do
 * none of those.
 */
export type CommandEffect =
  /** Nothing to do. Used by commands that only produce a message. */
  | { readonly kind: "none" }
  /** Show text in the transcript, without involving the model. */
  | { readonly kind: "message"; readonly text: string; readonly level?: "info" | "warn" | "error" }
  /** Send text to the model as if the user had typed it. */
  | { readonly kind: "prompt"; readonly text: string; readonly agent?: string; readonly model?: string }
  /** Open a dialog. */
  | { readonly kind: "dialog"; readonly dialog: DialogKind; readonly argument?: string }
  /** Start a new session. */
  | { readonly kind: "newSession" }
  /** Switch to an existing session. */
  | { readonly kind: "switchSession"; readonly sessionId: string }
  /** Summarise the conversation to reclaim context. */
  | { readonly kind: "compact" }
  /** Step the conversation backwards or forwards. */
  | { readonly kind: "revert"; readonly direction: "undo" | "redo" }
  /** Change a boolean setting. */
  | { readonly kind: "toggle"; readonly setting: ToggleSetting; readonly value?: boolean }
  /** Put text on the system clipboard. */
  | { readonly kind: "clipboard"; readonly text: string; readonly label?: string }
  /** Hand off to an external editor. */
  | { readonly kind: "editor"; readonly content?: string; readonly extension?: string }
  /** Export the transcript. */
  | { readonly kind: "export"; readonly format: "markdown" | "json" | "html"; readonly destination: "editor" | "clipboard" | "file"; readonly path?: string }
  /** Publish or unpublish the session. */
  | { readonly kind: "share"; readonly enable: boolean }
  /** Change the active model. */
  | { readonly kind: "setModel"; readonly model: string }
  /** Change the active agent or mode. */
  | { readonly kind: "setAgent"; readonly agent: string }
  /** Change the theme. */
  | { readonly kind: "setTheme"; readonly theme: string }
  /** Run a shell command and put its output in the transcript. */
  | { readonly kind: "shell"; readonly command: string }
  /** Leave. */
  | { readonly kind: "exit"; readonly code?: number }

export type DialogKind =
  | "help"
  | "models"
  | "providers"
  | "sessions"
  | "agents"
  | "themes"
  | "skills"
  | "commands"
  | "settings"
  | "keybinds"
  | "context"
  | "status"
  | "tools"
  | "permissions"
  | "mcp"
  | "plugins"
  | "timeline"
  | "connect"
  | "rename"
  | "delete"
  | "debug"

export type ToggleSetting =
  | "details"
  | "thinking"
  | "animations"
  | "diffwrap"
  | "fileContext"
  | "sidebar"
  | "tips"
  | "conceal"
  | "pasteSummary"
  | "sessionDirectoryFilter"
  | "mouse"

/** Everything a command can look at when deciding what to return. */
export interface CommandContext {
  readonly sessionId?: string
  readonly cwd: string
  readonly agent?: string
  readonly model?: string
  readonly theme?: string
  readonly shared?: boolean
  readonly shareUrl?: string
  readonly messageCount?: number
  readonly canUndo?: boolean
  readonly canRedo?: boolean
  readonly settings?: Partial<Record<ToggleSetting, boolean>>
  readonly transcript?: () => Promise<string>
  readonly lastResponse?: () => string | undefined
}

export interface CommandDefinition {
  /** Canonical name, without the leading slash. */
  readonly name: string
  /** Alternative names. */
  readonly aliases?: readonly string[]
  /** One line, shown in the palette and in `/help`. */
  readonly description: string
  /** Argument hint, shown after the name in the palette. */
  readonly argument?: string
  /** Longer text for `/help <name>`. */
  readonly detail?: string
  /** Keybind action this command corresponds to, if any. */
  readonly keybind?: string
  /** Grouping for `/help`. */
  readonly group: CommandGroup
  /** True when the command needs an active session. */
  readonly needsSession?: boolean
  /** Hidden from the palette but still callable. */
  readonly hidden?: boolean
  /** Produce the effect. */
  run(args: string, context: CommandContext): CommandEffect | Promise<CommandEffect>
}

export type CommandGroup =
  | "session"
  | "context"
  | "model"
  | "agent"
  | "appearance"
  | "sharing"
  | "setup"
  | "app"

export const GROUP_LABELS: Record<CommandGroup, string> = {
  session: "Sessions",
  context: "Context",
  model: "Models",
  agent: "Agents and tools",
  appearance: "Appearance",
  sharing: "Sharing",
  setup: "Setup",
  app: "Application",
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function message(text: string, level: "info" | "warn" | "error" = "info"): CommandEffect {
  return { kind: "message", text, level }
}

function dialog(kind: DialogKind, argument?: string): CommandEffect {
  return { kind: "dialog", dialog: kind, argument }
}

/* ------------------------------------------------------------------ */
/* Session commands                                                    */
/* ------------------------------------------------------------------ */

const newCommand: CommandDefinition = {
  name: "new",
  aliases: ["clear"],
  description: "Start a new session",
  keybind: "session_new",
  group: "session",
  detail:
    "Clears the conversation and starts fresh. The current session is not deleted \u2014 it stays in the session list and can be resumed with /sessions.",
  run: () => ({ kind: "newSession" }),
}

const sessionsCommand: CommandDefinition = {
  name: "sessions",
  aliases: ["resume", "continue"],
  description: "Switch to another session",
  argument: "[query]",
  keybind: "session_list",
  group: "session",
  detail:
    "Lists past sessions for this project, most recent first. Type to filter by title. An argument pre-fills the filter.",
  run: (args) => dialog("sessions", args.trim() || undefined),
}

const renameCommand: CommandDefinition = {
  name: "rename",
  description: "Rename this session",
  argument: "[title]",
  keybind: "session_rename",
  group: "session",
  needsSession: true,
  detail: "Titles are generated automatically from the first exchange. This replaces one that came out wrong.",
  run: (args) => dialog("rename", args.trim() || undefined),
}

const deleteCommand: CommandDefinition = {
  name: "delete",
  description: "Delete this session",
  keybind: "session_delete",
  group: "session",
  needsSession: true,
  detail: "Removes the session and its messages permanently. You will be asked to confirm.",
  run: () => dialog("delete"),
}

const timelineCommand: CommandDefinition = {
  name: "timeline",
  description: "Browse this session's checkpoints",
  keybind: "session_timeline",
  group: "session",
  needsSession: true,
  detail:
    "Every message is a point you can return to. The timeline shows them with the files that changed at each, so you can rewind to before a change went wrong.",
  run: () => dialog("timeline"),
}

const undoCommand: CommandDefinition = {
  name: "undo",
  description: "Undo the last exchange and its file changes",
  keybind: "messages_undo",
  group: "session",
  needsSession: true,
  detail:
    "Steps back one message and restores the files to how they were before it. Backed by a git snapshot taken before each turn, so it recovers edits the agent made \u2014 not edits you made by hand in the meantime.",
  run: (_args, context) => {
    if (context.canUndo === false) return message("Nothing to undo.", "warn")

    return { kind: "revert", direction: "undo" }
  },
}

const redoCommand: CommandDefinition = {
  name: "redo",
  description: "Redo an undone exchange",
  keybind: "messages_redo",
  group: "session",
  needsSession: true,
  detail: "Reapplies what /undo removed. Sending a new message discards the redo stack.",
  run: (_args, context) => {
    if (context.canRedo === false) return message("Nothing to redo.", "warn")

    return { kind: "revert", direction: "redo" }
  },
}

/* ------------------------------------------------------------------ */
/* Context commands                                                    */
/* ------------------------------------------------------------------ */

const compactCommand: CommandDefinition = {
  name: "compact",
  aliases: ["summarize", "summarise"],
  description: "Summarise the conversation to free up context",
  keybind: "session_compact",
  group: "context",
  needsSession: true,
  detail:
    "Replaces the conversation so far with a summary, keeping file paths, errors, decisions, and what is outstanding. This happens automatically as the context window fills; run it by hand when you want to keep going in a long session without waiting for that.",
  run: (_args, context) => {
    if ((context.messageCount ?? 0) < 4) {
      return message("There is not enough here to be worth summarising yet.", "warn")
    }

    return { kind: "compact" }
  },
}

const contextCommand: CommandDefinition = {
  name: "context",
  description: "Show what is using the context window",
  group: "context",
  needsSession: true,
  detail:
    "Breaks the current context down by system prompt, project memory, tool definitions, and conversation, with the cache hit rate and how much room is left. Useful when compaction is triggering more often than seems reasonable.",
  run: () => dialog("context"),
}

const initCommand: CommandDefinition = {
  name: "init",
  description: "Generate a PRAXIS.md for this project",
  group: "context",
  detail:
    "Reads the codebase and writes a memory file covering the build and test commands, the conventions, and the things that are easy to get wrong. It is loaded into every session in this project afterwards, so it is worth reading and correcting what it gets wrong.",
  run: () => ({
    kind: "prompt",
    text: "/init",
    agent: "build",
  }),
}

const detailsCommand: CommandDefinition = {
  name: "details",
  description: "Show or hide tool call details",
  argument: "[on|off]",
  group: "context",
  detail:
    "Collapsed, a tool call is one line. Expanded, it shows the arguments and the full output. Collapsed is the default because a long session is unreadable otherwise.",
  run: (args) => ({ kind: "toggle", setting: "details", value: parseBoolean(args) }),
}

const thinkingCommand: CommandDefinition = {
  name: "thinking",
  description: "Show or hide reasoning blocks",
  argument: "[on|off]",
  group: "context",
  detail:
    "Reasoning models emit their working before the answer. This controls whether it is displayed; it does not change whether the model produces it.",
  run: (args) => ({ kind: "toggle", setting: "thinking", value: parseBoolean(args) }),
}

/* ------------------------------------------------------------------ */
/* Model and agent commands                                            */
/* ------------------------------------------------------------------ */

const modelsCommand: CommandDefinition = {
  name: "models",
  aliases: ["model"],
  description: "Change the model",
  argument: "[provider/model]",
  keybind: "model_list",
  group: "model",
  detail:
    "Opens the model picker, filtered by what you have credentials for. Passing an exact id switches directly without the dialog. Changing model mid-session is fine; the conversation carries over.",
  run: (args) => {
    const id = args.trim()

    // Only bypass the picker on a fully qualified id. A bare name is ambiguous
    // \u2014 several providers serve the same model \u2014 so it seeds the filter instead.
    if (id.includes("/")) return { kind: "setModel", model: id }

    return dialog("models", id || undefined)
  },
}

const providersCommand: CommandDefinition = {
  name: "providers",
  description: "List configured providers",
  keybind: "model_provider_list",
  group: "model",
  detail: "Shows every provider, whether it has credentials, and how many models it offers.",
  run: () => dialog("providers"),
}

const connectCommand: CommandDefinition = {
  name: "connect",
  aliases: ["login", "auth"],
  description: "Connect a provider",
  argument: "[provider]",
  group: "setup",
  detail:
    "Walks through adding credentials for a provider \u2014 an API key, or a browser sign-in where the provider supports it. Credentials go to the system keychain when one is available, and to a permissions-restricted file otherwise.",
  run: (args) => dialog("connect", args.trim() || undefined),
}

const agentsCommand: CommandDefinition = {
  name: "agents",
  description: "Switch agent",
  argument: "[name]",
  keybind: "agent_list",
  group: "agent",
  detail:
    "Agents differ in their prompt, their tools, and their permissions. build can change things; plan can only read. Tab cycles between them without opening the dialog.",
  run: (args) => {
    const name = args.trim()

    return name ? { kind: "setAgent", agent: name } : dialog("agents")
  },
}

const agentCommand: CommandDefinition = {
  name: "agent",
  description: "Switch to a named agent",
  argument: "<name>",
  group: "agent",
  hidden: true,
  run: (args) => {
    const name = args.trim()

    if (!name) return dialog("agents")

    return { kind: "setAgent", agent: name }
  },
}

const skillsCommand: CommandDefinition = {
  name: "skills",
  description: "List available skills",
  group: "agent",
  detail:
    "Skills are folders of instructions the agent loads on demand. Only the name and description sit in the prompt; the body is read when the skill is invoked, which is what keeps them cheap.",
  run: () => dialog("skills"),
}

const toolsCommand: CommandDefinition = {
  name: "tools",
  description: "List the tools available to this agent",
  group: "agent",
  detail: "Shows which tools the current agent can use and which are withheld by its configuration.",
  run: () => dialog("tools"),
}

const permissionsCommand: CommandDefinition = {
  name: "permissions",
  description: "Review permission rules",
  group: "agent",
  detail:
    "Shows the rules deciding what runs without asking, including anything you approved with \u201calways allow\u201d this session, and lets you revoke them.",
  run: () => dialog("permissions"),
}

const mcpCommand: CommandDefinition = {
  name: "mcp",
  description: "Show MCP server status",
  group: "agent",
  detail: "Lists configured MCP servers, whether each connected, and the tools it contributed.",
  run: () => dialog("mcp"),
}

const pluginsCommand: CommandDefinition = {
  name: "plugins",
  description: "Show loaded plugins",
  group: "agent",
  detail: "Lists loaded plugins with the hooks and tools each registered.",
  run: () => dialog("plugins"),
}

const commandsCommand: CommandDefinition = {
  name: "commands",
  description: "List custom commands",
  keybind: "command_list",
  group: "agent",
  detail: "Shows commands defined in this project and in your configuration directory, and where each is defined.",
  run: () => dialog("commands"),
}

/* ------------------------------------------------------------------ */
/* Appearance commands                                                 */
/* ------------------------------------------------------------------ */

const themesCommand: CommandDefinition = {
  name: "themes",
  aliases: ["theme"],
  description: "Change the colour theme",
  argument: "[name]",
  keybind: "theme_list",
  group: "appearance",
  detail:
    "Themes preview as you move through the list, so you can see one before choosing it. The system theme follows your terminal's background.",
  run: (args) => {
    const name = args.trim()

    return name ? { kind: "setTheme", theme: name } : dialog("themes")
  },
}

const settingsCommand: CommandDefinition = {
  name: "settings",
  aliases: ["config"],
  description: "Open settings",
  group: "appearance",
  detail: "Shows the resolved configuration and which file each value came from, which is the quickest way to work out why a setting is not taking effect.",
  run: () => dialog("settings"),
}

const keybindsCommand: CommandDefinition = {
  name: "keybinds",
  aliases: ["keys"],
  description: "Show keyboard shortcuts",
  group: "appearance",
  detail: "Every binding, grouped, with conflicts flagged.",
  run: () => dialog("keybinds"),
}

const editorCommand: CommandDefinition = {
  name: "editor",
  description: "Compose in your editor",
  keybind: "editor_open",
  group: "app",
  detail:
    "Opens $EDITOR with the current prompt. Save and quit to bring it back. For anything longer than a couple of lines this is far better than composing in a terminal input.",
  run: () => ({ kind: "editor", extension: "md" }),
}

/* ------------------------------------------------------------------ */
/* Sharing and export                                                  */
/* ------------------------------------------------------------------ */

const shareCommand: CommandDefinition = {
  name: "share",
  description: "Publish this session to a link",
  group: "sharing",
  needsSession: true,
  detail:
    "Uploads the transcript and returns a URL. Anyone with the link can read it. Obvious secrets are redacted, but that is a safety net rather than a guarantee \u2014 check before sharing anything sensitive.",
  run: (_args, context) => {
    if (context.shared && context.shareUrl) {
      return message(`Already shared: ${context.shareUrl}`)
    }

    return { kind: "share", enable: true }
  },
}

const unshareCommand: CommandDefinition = {
  name: "unshare",
  description: "Withdraw the shared link",
  group: "sharing",
  needsSession: true,
  detail: "Deletes the published copy. The link stops working.",
  run: (_args, context) => {
    if (!context.shared) return message("This session is not shared.", "warn")

    return { kind: "share", enable: false }
  },
}

const exportCommand: CommandDefinition = {
  name: "export",
  description: "Export the transcript",
  argument: "[markdown|json|html]",
  keybind: "session_export",
  group: "sharing",
  needsSession: true,
  detail:
    "Renders the conversation and opens it in $EDITOR. Markdown by default; json keeps the structure including tool calls, html is self-contained and styled.",
  run: (args) => {
    const requested = args.trim().toLowerCase()

    const format =
      requested === "json" || requested === "html" || requested === "markdown"
        ? requested
        : "markdown"

    if (requested && requested !== format) {
      return message(`"${requested}" is not a format. Use markdown, json, or html.`, "error")
    }

    return { kind: "export", format, destination: "editor" }
  },
}

const copyCommand: CommandDefinition = {
  name: "copy",
  aliases: ["yank"],
  description: "Copy the last response",
  keybind: "messages_copy",
  group: "sharing",
  needsSession: true,
  detail: "Puts the most recent assistant message on the clipboard as plain markdown.",
  run: (_args, context) => {
    const text = context.lastResponse?.()

    if (!text) return message("There is no response to copy yet.", "warn")

    return { kind: "clipboard", text, label: "response" }
  },
}

/* ------------------------------------------------------------------ */
/* Application commands                                                */
/* ------------------------------------------------------------------ */

const helpCommand: CommandDefinition = {
  name: "help",
  aliases: ["?"],
  description: "Show help",
  argument: "[command]",
  group: "app",
  detail: "Lists every command. Naming one shows what it does in full.",
  run: (args) => {
    const name = args.trim().replace(/^\//, "")

    if (!name) return dialog("help")

    const command = findCommand(name)

    if (!command) {
      const suggestion = closest(name, commandNames())

      return message(
        suggestion ? `No command \u201c${name}\u201d. Did you mean /${suggestion}?` : `No command \u201c${name}\u201d.`,
        "error",
      )
    }

    return message(describeCommand(command))
  },
}

const statusCommand: CommandDefinition = {
  name: "status",
  description: "Show session status",
  keybind: "status_view",
  group: "app",
  detail: "Model, agent, token usage, cost so far, working directory, and git branch.",
  run: () => dialog("status"),
}

const debugCommand: CommandDefinition = {
  name: "debug",
  description: "Open the debug panel",
  group: "app",
  hidden: true,
  detail: "Recent log lines, event bus traffic, and timings. For diagnosing the agent itself.",
  run: () => dialog("debug"),
}

const versionCommand: CommandDefinition = {
  name: "version",
  description: "Show the version",
  group: "app",
  hidden: true,
  run: () => message(`Praxis ${process.env.PRAXIS_VERSION ?? "1.0.0"} on Node ${process.version}`),
}

const exitCommand: CommandDefinition = {
  name: "exit",
  aliases: ["quit", "q"],
  description: "Exit",
  keybind: "app_exit",
  group: "app",
  detail: "Leaves the application. The session is saved and can be resumed.",
  run: () => ({ kind: "exit", code: 0 }),
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
  // Sessions
  newCommand,
  sessionsCommand,
  renameCommand,
  deleteCommand,
  timelineCommand,
  undoCommand,
  redoCommand,

  // Context
  compactCommand,
  contextCommand,
  initCommand,
  detailsCommand,
  thinkingCommand,

  // Models
  modelsCommand,
  providersCommand,

  // Agents and tools
  agentsCommand,
  agentCommand,
  skillsCommand,
  toolsCommand,
  permissionsCommand,
  mcpCommand,
  pluginsCommand,
  commandsCommand,

  // Appearance
  themesCommand,
  settingsCommand,
  keybindsCommand,

  // Sharing
  shareCommand,
  unshareCommand,
  exportCommand,
  copyCommand,

  // Setup
  connectCommand,

  // Application
  editorCommand,
  helpCommand,
  statusCommand,
  debugCommand,
  versionCommand,
  exitCommand,
]

/**
 * Name and alias lookup.
 *
 * Built once. Aliases share the definition object rather than copying it, so
 * `/q` and `/exit` are the same command by identity, which matters when the
 * palette deduplicates entries.
 */
const byName = new Map<string, CommandDefinition>()

for (const command of BUILTIN_COMMANDS) {
  byName.set(command.name, command)

  for (const alias of command.aliases ?? []) {
    if (byName.has(alias)) {
      log.warn("a command alias collides with an existing name", { alias, command: command.name })
      continue
    }

    byName.set(alias, command)
  }
}

export function findCommand(name: string): CommandDefinition | undefined {
  return byName.get(name.toLowerCase().replace(/^\//, ""))
}

export function commandNames(): string[] {
  return [...byName.keys()]
}

export function visibleCommands(): CommandDefinition[] {
  return BUILTIN_COMMANDS.filter((command) => !command.hidden)
}

export function commandsByGroup(): Array<{ group: CommandGroup; label: string; commands: CommandDefinition[] }> {
  const groups = new Map<CommandGroup, CommandDefinition[]>()

  for (const command of visibleCommands()) {
    const existing = groups.get(command.group)

    if (existing) existing.push(command)
    else groups.set(command.group, [command])
  }

  const order: CommandGroup[] = [
    "session", "context", "model", "agent", "appearance", "sharing", "setup", "app",
  ]

  return order
    .filter((group) => groups.has(group))
    .map((group) => ({ group, label: GROUP_LABELS[group], commands: groups.get(group)! }))
}

/* ------------------------------------------------------------------ */
/* Parsing and dispatch                                                */
/* ------------------------------------------------------------------ */

export interface ParsedCommand {
  readonly name: string
  readonly args: string
}

/**
 * Splits a slash command line into a name and the rest.
 *
 * Arguments are kept as a single string rather than tokenised, because most
 * commands want them verbatim \u2014 a title, a query, a prompt \u2014 and the two that want
 * a single word can trim it themselves. Tokenising here would mean every command
 * that wants the raw text has to reassemble it, losing the original spacing.
 */
export function parseCommandLine(line: string): ParsedCommand | undefined {
  const trimmed = line.trim()

  if (!trimmed.startsWith("/")) return undefined

  // A lone slash is someone about to type, not a command.
  if (trimmed === "/") return undefined

  // Two slashes escape: `//foo` is the literal text `/foo`.
  if (trimmed.startsWith("//")) return undefined

  const match = /^\/([a-z0-9_:?-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed)

  if (!match) return undefined

  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() }
}

export type DispatchResult =
  | { readonly status: "handled"; readonly effect: CommandEffect; readonly command: CommandDefinition }
  | { readonly status: "unknown"; readonly name: string; readonly suggestion?: string }
  | { readonly status: "notCommand" }

/**
 * Runs a line if it is a command.
 *
 * Returns `notCommand` rather than throwing for ordinary text, so the caller can
 * pass every line through this and only then send what is left to the model.
 */
export async function dispatch(line: string, context: CommandContext): Promise<DispatchResult> {
  const parsed = parseCommandLine(line)

  if (!parsed) return { status: "notCommand" }

  const command = findCommand(parsed.name)

  if (!command) {
    return { status: "unknown", name: parsed.name, suggestion: closest(parsed.name, commandNames()) }
  }

  if (command.needsSession && !context.sessionId) {
    return {
      status: "handled",
      command,
      effect: message(`/${command.name} needs an active session.`, "warn"),
    }
  }

  log.debug("running a command", { command: command.name, args: parsed.args })

  try {
    return { status: "handled", command, effect: await command.run(parsed.args, context) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)

    log.error("a command failed", { command: command.name, error: detail })

    return { status: "handled", command, effect: message(`/${command.name} failed: ${detail}`, "error") }
  }
}

/* ------------------------------------------------------------------ */
/* Completion                                                          */
/* ------------------------------------------------------------------ */

export interface CommandCompletion {
  readonly name: string
  readonly description: string
  readonly argument?: string
  readonly alias: boolean
}

/**
 * Completions for a partially typed command.
 *
 * Prefix matches come before substring matches, because someone typing `/co`
 * almost certainly wants `/compact` or `/copy` rather than `/unshare` \u2014 which
 * contains no `co` anyway, but `/context` does contain `nt`, and ranking by
 * position keeps that kind of coincidence out of the way.
 *
 * Aliases appear only when they are what was typed. Listing `/clear`, `/q`, and
 * `/summarize` alongside their canonical names would nearly double the list
 * without adding a single new capability.
 */
export function completeCommand(partial: string): CommandCompletion[] {
  const query = partial.replace(/^\//, "").toLowerCase()

  const exact: CommandCompletion[] = []
  const prefix: CommandCompletion[] = []
  const substring: CommandCompletion[] = []

  for (const command of visibleCommands()) {
    const entry: CommandCompletion = {
      name: command.name,
      description: command.description,
      argument: command.argument,
      alias: false,
    }

    if (command.name === query) exact.push(entry)
    else if (command.name.startsWith(query)) prefix.push(entry)
    else if (query.length >= 2 && command.name.includes(query)) substring.push(entry)
    else {
      // Surface an alias only when the query is heading towards it.
      const alias = command.aliases?.find((candidate) => candidate.startsWith(query))

      if (alias && query.length > 0) {
        prefix.push({ ...entry, name: alias, alias: true })
      }
    }
  }

  return [...exact, ...prefix, ...substring]
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Full help for one command. */
export function describeCommand(command: CommandDefinition): string {
  const lines = [`/${command.name}${command.argument ? ` ${command.argument}` : ""}`, ""]

  lines.push(command.detail ?? command.description)

  if (command.aliases?.length) {
    lines.push("", `Also: ${command.aliases.map((alias) => `/${alias}`).join(", ")}`)
  }

  return lines.join("\n")
}

/** The `/help` listing. */
export function renderHelp(): string {
  const lines: string[] = []

  for (const { label, commands } of commandsByGroup()) {
    lines.push(label, "")

    const width = Math.max(...commands.map((command) => command.name.length + (command.argument?.length ?? 0) + 2))

    for (const command of commands) {
      const signature = `/${command.name}${command.argument ? ` ${command.argument}` : ""}`

      lines.push(`  ${signature.padEnd(width)}  ${command.description}`)
    }

    lines.push("")
  }

  lines.push(
    "Other input:",
    "",
    "  @path      insert a file reference; the agent reads it",
    "  !command   run a shell command and add its output to the conversation",
    "  //text     send text starting with a slash literally",
    "",
    "Press ctrl+p for the command palette, or ctrl+alt+k for the keybind overlay.",
  )

  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

/**
 * Reads an on/off argument.
 *
 * Undefined means toggle, which is what a bare `/details` should do. Anything
 * unrecognised also means toggle, on the grounds that a mistyped argument
 * flipping the setting is a smaller surprise than an error message.
 */
function parseBoolean(args: string): boolean | undefined {
  const value = args.trim().toLowerCase()

  if (value === "") return undefined
  if (["on", "true", "yes", "1", "show", "enable", "enabled"].includes(value)) return true
  if (["off", "false", "no", "0", "hide", "disable", "disabled"].includes(value)) return false

  return undefined
}

/**
 * Whether a line is a shell escape.
 *
 * A message beginning with `!` runs as a shell command and its output joins the
 * conversation as a tool result. `!!` is an escape for a literal exclamation mark.
 */
export function parseShellLine(line: string): string | undefined {
  const trimmed = line.trimStart()

  if (!trimmed.startsWith("!")) return undefined
  if (trimmed.startsWith("!!")) return undefined

  const command = trimmed.slice(1).trim()

  return command === "" ? undefined : command
}

/** Strips the escape from `//text` and `!!text`. */
export function unescapeLine(line: string): string {
  const trimmed = line.trimStart()

  if (trimmed.startsWith("//")) return trimmed.slice(1)
  if (trimmed.startsWith("!!")) return trimmed.slice(1)

  return line
}
