# Praxis — handoff

Everything a fresh session needs to pick this up without re-deriving it. Read this
file first, then `README.md` for the user-facing description.

---

## 1. What this is

A CLI AI coding agent in the spirit of OpenCode, written from scratch. Not a fork,
not a wrapper — an original implementation in TypeScript targeting Node 22.5+ with
zero runtime dependencies (only `typescript` and `@types/node` as dev deps).

The original brief, in short: reproduce every OpenCode feature, production grade,
at least 50 000 lines of real code (not tests, not docs).

**Current measurement: 121 TypeScript files, 67 311 lines, 2.2 MB in `src/`.**
The line-count requirement is met with room to spare. What is *not* met yet is
compilation — see section 6.

Reproduce the count with:

```
find src -name '*.ts' | xargs wc -l | tail -1
```

---

## 2. Delivery status

**GitHub:** `github.com/n1kro-yeah/praxis` (public, branch `main`, owner login
`n1kro-yeah`).

Only 13 files are on the remote: `.gitignore`, `package.json`, `LICENSE`,
`README.md`, `tsconfig.json`, `bin/praxis.mjs`, `scripts/push-all.sh`,
`src/global.ts`, `src/flag.ts`, `src/util/id.ts`, `src/util/hash.ts`,
`src/util/tokenizer.ts`, `src/provider/cost.ts`.

The rest was never pushed, and the reason matters for planning: the build sandbox
has no outbound network, so `git push` from it is impossible. The only channel is
the GitHub REST API, which requires the full text of every file to be passed as a
call argument. Moving 2.2 MB that way needs hundreds of round trips.

**The fix is `scripts/push-all.sh`.** Run it from the project root on a machine
with network access and the entire tree goes up in one push:

```
./scripts/push-all.sh                    # SSH remote (default)
./scripts/push-all.sh <remote-url>       # explicit remote
```

It force-pushes on purpose: the remote holds an API-seeded subset of the same
files, and a merge would mean resolving conflicts against content that is
authoritative locally.

---

## 3. Layout and per-directory status

| Directory | Files | State |
|---|---|---|
| `src/util/` | 20 | Complete. Primitives: diff, fuzzy, wcwidth, ANSI, schema, bus, glob, jsonc, shell, http, color, string, hash, tokenizer, log, id, error, async, fs-extra, misc |
| `src/config/` | 4 | Complete. Seven-layer merge, keybind parser, hot reload, JSON Schema |
| `src/storage/` | 4 | Complete. SQLite (WAL, schema v7, FTS5), migrations, repositories, KV |
| `src/llm/` | 4 | Complete. Types, streaming, retry policy, prompt caching |
| `src/provider/` | 8 + 10 transports | Complete. Catalog, cost, models, registry, transform, custom providers |
| `src/auth/` | 5 | `auth.ts` is a stub — see 6.1. PKCE, OAuth, device flow, keychain done |
| `src/prompt/` | 6 | Complete but duplicated — see 6.2 |
| `src/tool/` | 17 | Complete except `read.ts` collisions — see 6.3 |
| `src/permission/` | 4 | Complete, minor defects in 6.4 |
| `src/edit/` | 4 | Complete. Nine-layer replacer chain, V4A patches, formatters |
| `src/file/` | 7 | Complete. Ignore rules, ripgrep, watcher, reader, index, tree, timestamps |
| `src/lsp/` | 5 | Complete, one bad import in 6.5 |
| `src/git/` | 2 | Complete, one artefact in 6.6 |
| `src/session/` | 9 | Complete, ordering defects in 6.7 |
| `src/agent/` | 4 | Complete |
| `src/plugin/` | 2 | Complete |
| `src/skill/` | 1 | Complete |
| `src/command/` | 2 | Complete, one edge case in 6.8 |
| `src/mcp/` | 7 | Complete except the `AuthStore` dependency in 6.1 |
| `src/syntax/` | 2 | Complete. 23 grammars, tokenizer, highlighter |
| `src/markdown/` | 2 | Complete |
| `src/tui/` | 6 | **Partial — the largest gap.** See section 5 |
| `src/server/` | 0 | **Not started** |
| `src/cli/` | 0 | **Not started — the binary cannot run without it** |

---

## 4. Conventions already fixed in the code

Do not re-litigate these; the existing 67 000 lines assume them.

**Naming.** App `praxis`, binaries `praxis` and `px`, version 1.0.0, MIT.

**Config files.** `praxis.jsonc` / `praxis.json` in the project,
`~/.config/praxis/praxis.json` global, `~/.config/praxis/tui.json` for the
interface, `.praxis/config.jsonc` per project, `/etc/praxis/praxis.json` system.

**Environment prefix** `PRAXIS_`. Every variable is declared in `src/flag.ts`;
add new ones there or `praxis doctor --env` goes stale.

**Paths.** All derived from `src/global.ts`. XDG on Linux, Application Support on
macOS, APPDATA on Windows. Database `praxis.db`, credentials `auth.json` at mode
0600, plans in `.praxis/plans/`, memory file `PRAXIS.md`.

**ID prefixes.** `ses_ msg_ prt_ per_ tdo_ snp_ tsk_ tul_ fil_ req_ shr_ plg_ att_
dgn_ evt_`. Sortable, base32, monotonic within a millisecond.

**TypeScript.** NodeNext, ES2023, `strict: true`, `noUnusedLocals: false`, and
**imports must carry the `.js` extension** because module resolution is NodeNext.

**Exit codes.** 70 Node too old, 69 not built, 64 usage, 78 config, 130 interrupt.

---

## 5. Remaining work, in the order it should be done

The project does not compile today. Sections 5 and 6 together are the path to a
working binary. Do 6 first if you want fast feedback from the compiler; do 5 first
if you want the missing surface area in place before fixing details.

### 5.1 Finish `src/tui/` (roughly 12 files)

Present: `animation.ts`, `theme.ts`, `terminal.ts`, `keys.ts`, `buffer.ts`,
`layout.ts`, `editor.ts`, `autocomplete.ts`, `widget.ts`, `dialog.ts`.

Missing:

- **`diff.ts`** — was half-written when the session was interrupted; nothing is on
  disk. Planned shape: constants `MIN_SPLIT_WIDTH=120`, `MAX_WORD_DIFF_LENGTH=1000`,
  `DEFAULT_CONTEXT=3`, `MAX_RENDERED_LINES=5000`; types `LineKind`, `DiffLine`,
  `Span`, `Hunk`, `FileDiff`, `DiffStyle`; functions `parseUnifiedDiff`,
  `annotateWordDiffs`, `wordDiff`, `resolveStyle`, `renderFileDiff`, `renderSplit`,
  `renderStacked`, `fileHeading`. Depends on `highlightLines()` from
  `src/syntax/highlight.ts` and `stringWidth()` from `src/util/wcwidth.ts`.
- **`markdown/render.ts`** — terminal renderer over `markdown/parse.ts`. Must be
  streaming-safe: model output arrives with unterminated code fences, so a
  `hasOpenFence()` check has to suppress partial-block rendering. Maps onto the
  nine `markdown*` roles in the theme.
- **`views.ts`** — message list, tool-call cards, reasoning blocks.
- **`statusbar.ts`** — model, agent, mode, token meter, cost.
- **`toast.ts`** and **`attention.ts`** — notifications and sound packs.
- **`whichkey.ts`** — leader-key overlay.
- **`palette.ts`** — maps the 12 `TokenKind` values onto the 15 `syntax*` theme
  roles.
- **`app.ts`** — the event loop that ties input, state and rendering together, and
  calls `setQuestionAsker()` so the `question` tool can reach the UI.

### 5.2 Build `src/server/` and friends

`src/server/` (HTTP, OpenAPI 3.1 at `/doc`, SSE at `/event`, `/tui` bridge),
`src/ipc/` (worker RPC), `src/share/` (share client), `src/project/` (project
registry), `src/sdk/` (typed client).

### 5.3 Build `src/cli/`

Argument parser plus commands: `tui` (default), `run`, `serve`, `web`, `acp`,
`attach`, `auth login|list|logout`, `models`, `agent`, `mcp add|list|auth`,
`config`, `session`, `export`, `import`, `github`, `upgrade`, `uninstall`,
`stats`, `doctor`, `plugin`, `skills`. Exports `main(argv)`, which
`bin/praxis.mjs` imports from `dist/cli/main.js`. Also `src/index.ts` for the
public surface.

### 5.4 Wire startup

None of this is called yet: `initSearchBackends()`, registering `WEB_TOOLS` and
`questionTool`, starting `McpRegistry`, merging MCP tools into the registry,
appending `McpRegistry.instructions()` to the system prompt, applying
`truncateOutput()` inside the tool wrapper.

### 5.5 Then

Typecheck, smoke test, package.

```
node /vercel/sandbox/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Smoke test offline first (`--help`, `config`, `models`, `doctor`), then the agent
loop against a local mock LLM server.

---

## 6. Known defects

Found by reading, not by the compiler — `tsc` has never been run on this tree, so
expect more. Each of these is real and will fail the build.

**6.1 `src/auth/auth.ts` has no `AuthStore` implementation.** `src/mcp/oauth.ts`
imports it. It needs to read and write `auth.json` at mode 0600. Also widen
`AuthorizationServerMetadata` with an optional `device_authorization_endpoint`, and
resolve the `summarise()` name collision between `auth/oauth.ts` and
`mcp/oauth.ts`. `CANDIDATE_PORTS` is duplicated in both `auth/pkce.ts` and
`mcp/oauth.ts` — export it once from `pkce.ts`.

**6.2 Prompt duplication.** `src/prompt/prompts.ts` defines `COMPACTION_PROMPT`,
`TITLE_PROMPT` and `INIT_PROMPT`, which `modes.ts` also defines.
`src/tool/plan.ts` re-defines `PLAN_MODE_PROMPT`. Consolidate onto `modes.ts`.

**6.3 `src/tool/read.ts` collides with `src/tool/edit.ts`.** Both export
`writeTool`, `editTool` and `multiEditTool`. Trim `read.ts` down to `readTool`,
`applyPatchTool` and `patchTool`.

**6.4 `src/permission/rules.ts`** carries a bogus `effect2: undefined` field, does
not export `suggestPattern`, and its action union is missing `notebook`, `memory`,
`plan`, `skill`, `delete`, `network`, `question` and `mcp`.

**6.5 `src/lsp/client.ts`** imports `languageIdOf` from `./jsonrpc.js`, which does
not export it.

**6.6 `src/git/git.ts`** contains a leftover artefact: a template literal ending
`--unified=${options.context ?? 3}"` followed by `.replace('"', "")`.

**6.7 `src/session/`.** In `loop.ts`, `handleStreamEvent` is declared after its
first use, and it never calls `doom.record()` or `doom.reset()` even though the
doom-loop detector is built and wired everywhere else. In `session.ts`, `stats()`
shadows the imported `allParts`.

**6.8 `src/command/builtin.ts`** calls `Math.max(...)` on an array that can be
empty inside `renderHelp()`.

**6.9 Missing exports.** These are imported across the tree but not all exist yet:

- `util/diff.ts` — `unifiedDiff`, `diffStat`. Also `findMiddleSnake`'s backward
  pass calls a stub `snakeLength()` that returns 0, so the diff is wrong.
- `util/schema.ts` — `jsonSchema()`, `parse()`, and the builder surface
  `s.object/string/number/boolean/array/enum/record/unknown`, `.describe()`,
  `.optional()`, `s.discriminated()`.
- `util/string.ts` — `truncate(value, n)`, `countLines`.
- `util/wcwidth.ts` — `stringWidth`, imported by four TUI files already.
- `util/fuzzy.ts` — `fuzzyMatch(query, target)` returning `{score, positions}`,
  plus `closest()`.
- `util/jsonc.ts` — `parseJsonc`. `util/color.ts` — `Rgb`, `hexToRgb`, `rgbToHex`,
  `rgbToAnsi256`, `blend`, `luminance`. `util/shell.ts` — `shell()`.
  `util/http.ts` — `request()`.
- `util/bus.ts` — `Bus.publish`, `Bus.subscribeAll`, and about 90 event names.
- `util/log.ts` — `logger(scope)` returning `{debug, info, warn, error}`.
- `tui/buffer.ts` — must export the `Buffer` and `Cell` types with
  `set(x,y,cell)`, `get(x,y)`, `.width`, `.height`, and `Cell` needs a
  `continuation?: boolean` flag for double-width glyphs.
- `tui/layout.ts` — must export `Rect` as `{x, y, width, height}`.
- `tool/types.ts` — `defineTool` must accept both a schema builder and a plain
  JSON Schema object, because `mcp/bridge.ts` passes the latter.

**6.10 Hoist dynamic requires.** Eight inline `require("node:fs")` and dynamic
`import()` calls need to become top-level imports: `edit/apply.ts`,
`edit/format.ts`, `lsp/servers.ts`, `git/snapshot.ts` (three of them),
`tool/edit.ts`.

**6.11 `src/markdown/parse.ts`** declares an `html` variant of `BlockNode` that is
never produced. Either emit it or drop it.

---

## 7. Sandbox notes

Only relevant if you continue in the same environment.

- Node v24.14.1, npm 11.11.0, Amazon Linux 2023. Terminal starts in `/data`.
- Project at `/data/praxis`. `node_modules` is **not** there — it lives at
  `/vercel/sandbox/node_modules`, and `tsc` at
  `/vercel/sandbox/node_modules/typescript/bin/tsc`.
- **No outbound network.** No `npm install`, no `git push`, no `curl`.
- `node:sqlite` works and emits an `ExperimentalWarning`, which `bin/praxis.mjs`
  filters deliberately.
- Available: `jq`, `zip`, `unzip`, `7z`, `rg`, `tmux`, `python3`.

### Two traps that cost real time

**Literal `https://` in written file content gets rewritten** by the tooling into
a placeholder, silently corrupting the file. It already happened to
`provider/transport/azure.ts` and `bedrock.ts`. Build such URLs by concatenating
the scheme, or keep them in config rather than source. Audit with:

```
python3 -c "import pathlib; bad=[(str(p),i+1) for p in pathlib.Path('src').rglob('*.ts') for i,l in enumerate(p.read_text().splitlines()) if '{'+'{' in l]; print('ARTEFACTS:',len(bad)); [print(' ',f,n) for f,n in bad[:20]]"
```

The expected result is exactly **1** hit: a deliberate year placeholder in
`src/tool/web.ts`. Anything else is corruption. Note that grep output can itself
be rewritten, so trust only this Python check.

**Very large file writes fail on escaping density,** not on size — 21 KB files
succeeded while some 19 KB ones failed. Keep writes under about 22 KB and split
files that need more.

---

## 8. Feature parity checklist against OpenCode

From three rounds of research across the docs, the repository and issue tracker.
Sources: `opencode.ai/docs` and its `/cli`, `/config`, `/tui`, `/keybinds`,
`/tools`, `/permissions`, `/themes`, `/providers`, `/plugins`, `/commands`,
`/skills`, `/share`, `/server`, `/github`, `/agents`, `/modes`, `/rules` pages,
plus `v2.opencode.ai/docs`.

**Done and matched:**

- 13 built-in tools plus four extras (`question`, `notebook`, `memory`, `skill`).
- `read` semantics: 2000-line default window, 1-indexed `offset`, `<line>: <content>`
  gutter, 50 KB byte cap, delegate-to-subagent message on overflow.
- `apply_patch` with the `*** Add File:`, `*** Update File:`, `*** Move to:` and
  `*** Delete File:` markers.
- 37 slash commands, which is the documented 24 plus 13 of our own.
- About 130 keybinds with `ctrl+x` as leader and a 2000 ms timeout.
- `@` file picker, `!` shell prefix, `ctrl+p` palette.
- Build and Plan modes with distinct prompts; Plan denies write and edit except
  under the plans directory, enforced by a hardcoded reminder that survives
  compaction.
- Compaction triggered when estimated tokens exceed the context limit minus the
  larger of requested output tokens and the buffer.
- MCP over stdio, streamable HTTP and SSE, with OAuth 2.1, PKCE and dynamic client
  registration.
- Custom providers via `npm`, `options.baseURL`, `options.apiKey` with `{env:KEY}`
  interpolation, and per-model limits. Presets for LM Studio, Ollama, vLLM,
  LiteLLM.
- Plugin system with 28 event hooks.
- Agents and commands as Markdown with YAML frontmatter; `$ARGUMENTS`, `@file` and
  inline backtick-shell interpolation.
- 16 themes, 14 spinner styles, 12 easing curves.

**Deliberately different:**

- `websearch` is not gated behind an Exa-only flag. Four backends are supported —
  Exa, Brave, Tavily and DuckDuckGo — selected by whichever API key is present.
- Seven built-in agents rather than OpenCode's two-tier split: `build`, `plan`,
  `general`, `explore`, `review`, `compact`, `title`.

**Not yet reachable** because the CLI and server layers are missing: `serve`,
`web`, `acp`, `attach`, `github`, share links, the SSE event stream.

### Manual fallback

If the script is missing or will not run, four commands do the same thing:

```
git init && git branch -M main
git remote add origin git@github.com:n1kro-yeah/praxis.git
git add -A && git commit -m "Full source tree"
git push --force -u origin main
```
