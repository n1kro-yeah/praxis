/**
 * The tool registry.
 *
 * Every tool is registered here, in a fixed order, and the order is not arbitrary.
 * It is the order tools appear in the request sent to the model, and models weight
 * position: a tool listed first is reached for more readily than one listed
 * twentieth. So the ordering runs from the tools that should be used constantly
 * (read, edit, search) down to the ones that should be used rarely (web fetch,
 * subagent spawning).
 *
 * Registration is centralised rather than distributed \u2014 each tool module exporting
 * a self-registering side effect \u2014 because side-effect registration makes the set
 * of available tools depend on import order, and import order is not something
 * anyone should have to reason about to answer "why is this tool missing".
 */

import { registerTool, type ToolDefinition } from "./types.js"

import { bashTool, bashOutputTool, killBashTool } from "./bash.js"
import { readTool, applyPatchTool, patchTool } from "./read.js"
import { editTool, multieditTool, writeTool } from "./edit.js"
import { globTool, grepTool, listTool } from "./search.js"
import { todoReadTool, todoWriteTool } from "./todo.js"
import { taskTool, batchTool } from "./task.js"
import { webFetchTool, webSearchTool } from "./web.js"
import { diagnosticsTool, hoverTool, referencesTool, symbolsTool } from "./lsp.js"
import { notebookTool } from "./notebook.js"
import { memoryTool } from "./memory.js"
import { planTool } from "./plan.js"
import { skillTool } from "./skill.js"

import { logger } from "../util/log.js"

const log = logger("tool.index")

/* ------------------------------------------------------------------ */
/* Order                                                               */
/* ------------------------------------------------------------------ */

/**
 * Presentation order.
 *
 * Grouped by how often a tool should be reached for, most frequent first. Within
 * a group the order is by how destructive the operation is, least first, so that a
 * model scanning the list encounters `read` before `write` and `grep` before
 * `bash`.
 */
export const TOOL_ORDER = [
  // Reading and searching: the majority of all calls, and the ones a model
  // should make before anything else.
  "read",
  "grep",
  "glob",
  "list",

  // Editing, in ascending order of scope.
  "edit",
  "multiedit",
  "write",
  "patch",
  "apply_patch",

  // Execution.
  "bash",
  "bash_output",
  "kill_bash",

  // Task tracking, which the model is expected to use continuously on any task
  // of more than trivial size.
  "todoread",
  "todowrite",

  // Language intelligence, useful but only where a server is running.
  "diagnostics",
  "hover",
  "references",
  "symbols",

  // Specialised editors.
  "notebook",

  // Knowledge and planning.
  "skill",
  "memory",
  "plan",

  // Delegation. Last of the local tools because spawning a subagent is expensive
  // and should be a considered choice.
  "task",
  "batch",

  // Network access, which is slow, sometimes unavailable, and should be a last
  // resort after looking in the repository.
  "webfetch",
  "websearch",
] as const

export type ToolId = (typeof TOOL_ORDER)[number]

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

let registered = false

/**
 * Registers every built-in tool.
 *
 * Idempotent, because the CLI, the server, and the test harness each want to be
 * sure registration has happened without coordinating about who does it.
 */
export function registerBuiltinTools(): void {
  if (registered) return

  const all: ToolDefinition[] = [
    readTool,
    grepTool,
    globTool,
    listTool,

    editTool,
    multieditTool,
    writeTool,
    patchTool,
    applyPatchTool,

    bashTool,
    bashOutputTool,
    killBashTool,

    todoReadTool,
    todoWriteTool,

    diagnosticsTool,
    hoverTool,
    referencesTool,
    symbolsTool,

    notebookTool,

    skillTool,
    memoryTool,
    planTool,

    taskTool,
    batchTool,

    webFetchTool,
    webSearchTool,
  ]

  for (const tool of all) {
    registerTool(tool)
  }

  registered = true

  verifyOrder(all)

  log.info("built-in tools registered", { count: all.length })
}

/**
 * Checks that registration and the presentation order agree.
 *
 * A tool registered but missing from `TOOL_ORDER` would be sorted to the end
 * silently, and one listed but never registered would be a phantom entry. Neither
 * is visible at runtime without this check, and both have happened.
 */
function verifyOrder(tools: ToolDefinition[]): void {
  const registeredIds = new Set(tools.map((tool) => tool.id))
  const orderedIds = new Set<string>(TOOL_ORDER)

  for (const id of registeredIds) {
    if (!orderedIds.has(id)) {
      log.warn("tool is registered but has no place in TOOL_ORDER", { id })
    }
  }

  for (const id of orderedIds) {
    if (!registeredIds.has(id)) {
      log.warn("TOOL_ORDER lists a tool that was never registered", { id })
    }
  }
}

/**
 * Sorts tools into presentation order.
 *
 * Anything unrecognised \u2014 a plugin tool, an MCP tool \u2014 goes after the built-ins,
 * alphabetically. Interleaving them with the built-ins would put a third-party
 * tool ahead of `read` on the strength of its name, which is not a decision the
 * alphabet should be making.
 */
export function sortTools<T extends { id: string }>(tools: T[]): T[] {
  const rank = new Map<string, number>()
  TOOL_ORDER.forEach((id, index) => rank.set(id, index))

  return [...tools].sort((a, b) => {
    const rankA = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const rankB = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER

    if (rankA !== rankB) return rankA - rankB

    return a.id.localeCompare(b.id)
  })
}

/* ------------------------------------------------------------------ */
/* Aliases                                                             */
/* ------------------------------------------------------------------ */

/**
 * Alternative names models use for tools.
 *
 * Models trained on other agents reach for the names those agents used. Rejecting
 * `str_replace_editor` because the tool here is called `edit` wastes a turn on a
 * naming difference the user does not care about, so the aliases are accepted and
 * mapped.
 *
 * This is a compatibility shim, not a feature. Aliases are resolved silently and
 * never advertised: adding them to the tool list would double its size and teach
 * the model that both names are equally correct.
 */
export const TOOL_ALIASES: Record<string, ToolId> = {
  // Anthropic's text editor tool, in its several versions.
  str_replace_editor: "edit",
  str_replace_based_edit_tool: "edit",
  text_editor: "edit",
  create_file: "write",

  // Naming variants that differ only in punctuation.
  multi_edit: "multiedit",
  "multi-edit": "multiedit",
  todo_read: "todoread",
  todo_write: "todowrite",
  "todo-read": "todoread",
  "todo-write": "todowrite",
  web_fetch: "webfetch",
  web_search: "websearch",
  "web-fetch": "webfetch",
  "web-search": "websearch",
  bash_tool: "bash",
  run_command: "bash",
  execute_command: "bash",
  shell: "bash",

  // Reading and searching.
  read_file: "read",
  view_file: "read",
  cat: "read",
  search_files: "grep",
  ripgrep: "grep",
  rg: "grep",
  find_files: "glob",
  list_files: "list",
  ls: "list",

  // Delegation.
  spawn_agent: "task",
  subagent: "task",
  dispatch_agent: "task",
}

/**
 * Resolves a possibly-aliased tool name.
 *
 * Case-insensitive, because models are inconsistent about capitalisation and the
 * difference is never meaningful.
 */
export function resolveToolId(name: string): string {
  const direct = TOOL_ORDER.find((id) => id === name)
  if (direct) return direct

  const alias = TOOL_ALIASES[name]
  if (alias) return alias

  const lowered = name.toLowerCase()

  const insensitive = TOOL_ORDER.find((id) => id === lowered)
  if (insensitive) return insensitive

  const insensitiveAlias = TOOL_ALIASES[lowered]
  if (insensitiveAlias) return insensitiveAlias

  return name
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

/**
 * Named groups, for configuration.
 *
 * `tools: { "group:edit": false }` is far more maintainable than listing five
 * tool ids and forgetting one when a sixth is added.
 */
export const TOOL_GROUPS: Record<string, ToolId[]> = {
  read: ["read", "grep", "glob", "list"],
  edit: ["edit", "multiedit", "write", "patch", "apply_patch"],
  execute: ["bash", "bash_output", "kill_bash"],
  todo: ["todoread", "todowrite"],
  lsp: ["diagnostics", "hover", "references", "symbols"],
  web: ["webfetch", "websearch"],
  delegate: ["task", "batch"],
  knowledge: ["skill", "memory", "plan"],
  notebook: ["notebook"],
}

/** Expands a group reference into its tool ids. */
export function expandGroup(name: string): ToolId[] | undefined {
  const match = name.match(/^group:(.+)$/)
  if (!match) return undefined

  return TOOL_GROUPS[match[1]!]
}

/**
 * Tools that never change anything.
 *
 * The read-only agents are built from this list, and plan mode denies everything
 * outside it. Kept explicit rather than derived from each tool's `readOnly` flag,
 * so that adding a tool does not quietly widen what a read-only agent can do: a
 * new tool is excluded until someone adds it here deliberately.
 */
export const READ_ONLY_TOOLS: ToolId[] = [
  "read",
  "grep",
  "glob",
  "list",
  "todoread",
  "todowrite",
  "diagnostics",
  "hover",
  "references",
  "symbols",
  "skill",
  "plan",
  "webfetch",
  "websearch",
  "task",
  "batch",
]

export function isReadOnlyTool(id: string): boolean {
  return (READ_ONLY_TOOLS as string[]).includes(id)
}

/* ------------------------------------------------------------------ */
/* Re-exports                                                          */
/* ------------------------------------------------------------------ */

export {
  bashTool,
  bashOutputTool,
  killBashTool,
  readTool,
  applyPatchTool,
  patchTool,
  editTool,
  multieditTool,
  writeTool,
  globTool,
  grepTool,
  listTool,
  todoReadTool,
  todoWriteTool,
  taskTool,
  batchTool,
  webFetchTool,
  webSearchTool,
  diagnosticsTool,
  hoverTool,
  referencesTool,
  symbolsTool,
  notebookTool,
  memoryTool,
  planTool,
  skillTool,
}
