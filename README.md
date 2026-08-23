# Praxis

A production-grade CLI coding agent for the terminal. Written from scratch in TypeScript, with no runtime dependencies beyond Node.

Praxis talks to language models over their HTTP APIs, runs tools on your machine, and presents the whole thing through a terminal interface that behaves the way a terminal program should: it redraws only what changed, it never blocks on the model, and every action that touches your filesystem or your shell goes through a permission layer you control.

```
npm install -g praxis
praxis
```

## What it does

**Talks to any model.** Ten transports covering the OpenAI chat and responses APIs, Anthropic messages, Google Gemini, Ollama, Mistral, Azure OpenAI, Cohere, GitHub Copilot, and AWS Bedrock. Model metadata comes from a catalog that is refreshed in the background and cached, so a cold start does not wait on a network round trip. Custom providers are a few lines of config: point at a base URL, name the models, and the right transport is inferred from the package you name.

**Runs real tools.** Read, write, edit, multi-edit, apply-patch, bash, glob, grep, list, LSP diagnostics, notebook editing, todo tracking, subagent dispatch, skills, web fetch, web search, and an interactive question tool the model can use to ask you something mid-task rather than guessing.

**Reads large files properly.** The read tool returns 2 000 lines at a time with line-number gutters, detects binaries by sniffing the first 8 KB, handles BOMs and UTF-16, truncates individual lines at 2 000 characters, and refuses files over 20 MB. Oversized tool output is written to a store and replaced with a pointer plus an instruction to delegate the reading to a subagent, so a single large file cannot consume the whole context window.

**Two operating modes with distinct prompts.** Build has the full toolset. Plan is read-only: the write and edit tools are denied outright, with a single exception for files under `.praxis/plans/`, and the system prompt carries a hardcoded read-only reminder that survives compaction. Switching modes is one keystroke.

**Permissions that are actually granular.** Every tool call resolves against a rule set keyed by action and resource, with glob patterns, per-session "always allow" decisions, and a risk classification that hides the always-allow option for destructive operations. Rules come from seven config layers that merge in a defined order.

**Model Context Protocol, fully.** Stdio, streamable HTTP, and SSE transports with automatic probe-and-fallback, OAuth 2.1 with PKCE and dynamic client registration for remote servers, schema sanitisation so a malformed server schema cannot break tool dispatch, name collision handling, and reconnection with backoff.

**Language servers.** Forty-three server definitions with automatic detection, diagnostics surfaced to the model after every edit, and an experimental LSP tool exposing hover, definitions, references, and symbol search.

**Sessions that survive.** SQLite-backed with WAL, full-text search over message parts, git-snapshot checkpoints before every edit, undo and redo across the whole session, automatic compaction when the context fills, and export to Markdown or JSON.

**A terminal interface with care taken.** Fourteen spinner styles, twelve easing curves, sixteen themes with a full override hierarchy, a syntax highlighter covering twenty-three languages, a Markdown renderer that handles streaming output with unterminated code fences, side-by-side and stacked diff views with word-level intra-line highlighting, fuzzy-matched pickers for everything, a which-key overlay, and around a hundred and thirty rebindable keys with leader-key support.

## Slash commands

Thirty-seven of them, grouped: session management (`/new`, `/sessions`, `/rename`, `/delete`, `/timeline`, `/undo`, `/redo`, `/compact`, `/share`, `/unshare`, `/export`), configuration (`/models`, `/providers`, `/agents`, `/themes`, `/keybinds`, `/settings`, `/thinking`), inspection (`/context`, `/status`, `/tools`, `/permissions`, `/mcp`, `/plugins`, `/skills`, `/commands`, `/debug`, `/version`), and the rest.

Type `@` for a fuzzy file picker, `!` to run a shell command and feed its output to the model, `/` for commands, and `ctrl+p` for the command palette.

## Configuration

`praxis.jsonc` in your project, `~/.config/praxis/praxis.json` for global settings, `~/.config/praxis/tui.json` for interface preferences. Environment variables override files; command-line flags override everything. Config is watched and hot-reloaded where a reload is safe, and the components that cannot be reloaded are named explicitly rather than silently ignored.

Custom agents, commands, and skills are Markdown files with YAML frontmatter, discovered from both project and user directories.

## Architecture

```
src/
  util/        primitives: diff, fuzzy matching, wcwidth, ANSI, schema, event bus
  config/      seven-layer config resolution, keybind parsing, hot reload
  storage/     SQLite schema, migrations, repositories, key-value store
  llm/         streaming, retry policy, prompt caching
  provider/    catalog, cost accounting, ten transports, custom providers
  auth/        credential store, keychain integration, OAuth, PKCE, device flow
  prompt/      system prompts, mode prompts, environment context, reminders
  tool/        every built-in tool, the registry, output truncation
  permission/  rule matching, the decision engine, the prompt UI
  edit/        nine-layer replacer chain, V4A patches, formatting
  file/        ignore rules, ripgrep integration, watcher, reader, index
  lsp/         JSON-RPC framing, server definitions, client, diagnostics
  git/         command wrapper, snapshot checkpoints
  session/     the agent loop, compaction, doom-loop detection, queue, revert
  agent/       agent definitions, subagent dispatch, Markdown loading
  mcp/         protocol, transports, tool bridging, registry, OAuth
  syntax/      twenty-three grammars, tokenizer, highlighter
  markdown/    parser and terminal renderer
  tui/         buffer, layout, widgets, dialogs, editor, diff viewer, themes
```

Around sixty-seven thousand lines of TypeScript.

## Why the design is what it is

A few decisions worth explaining, because they are the ones that would otherwise look arbitrary:

**The screen is redrawn from scratch every frame.** Widgets do not track their own dirty regions; the buffer layer diffs the finished frame against the previous one and emits only the cells that differ. Dirty-region tracking is where terminal interfaces accumulate bugs that only appear after a particular sequence of resizes.

**Undo snapshots are full copies.** Wasteful in principle, irrelevant in practice: a prompt is a few kilobytes and the history is bounded, so the entire undo stack costs less than one rendered frame.

**The inline autocomplete does not use the CommonMark delimiter-stack algorithm** for its Markdown, and the Markdown parser deliberately does not either. A single left-to-right scan gets the cases that appear in model output right, and suppresses underscore emphasis inside words so `snake_case_names` survive.

**Doom-loop detection is a first-class component.** Three repeated identical tool calls warns; six aborts. Cycles of up to four calls are detected over a twelve-call window. Models get stuck, and a agent that notices is better than one that burns your quota.

## License

MIT.
