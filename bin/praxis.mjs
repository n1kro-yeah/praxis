#!/usr/bin/env node
/**
 * Praxis launcher.
 *
 * Kept intentionally tiny: it validates the runtime, wires up the crash
 * handler, and then hands control to the compiled CLI entrypoint. Anything
 * more interesting belongs in `src/cli/main.ts`.
 */
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import path from "node:path"
import process from "node:process"

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")

const MIN_NODE = [22, 5, 0]

function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!m) return [0, 0, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

if (compare(parseVersion(process.versions.node), MIN_NODE) < 0) {
  process.stderr.write(
    `praxis requires Node.js >= ${MIN_NODE.join(".")} (found ${process.versions.node}).\n` +
      `The embedded SQLite engine (node:sqlite) is unavailable on older runtimes.\n`,
  )
  process.exit(70)
}

// node:sqlite is behind an ExperimentalWarning until it stabilises. We depend on
// it deliberately, so suppress just that one warning instead of muting all of
// them, which would hide genuinely useful diagnostics.
const emitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === "string" ? warning : String(warning?.message ?? "")
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type
  if (type === "ExperimentalWarning" && /SQLite|WebSocket/i.test(text)) return
  return emitWarning.call(process, warning, ...rest)
}

let entry
try {
  entry = await import(path.join(root, "dist", "cli", "main.js"))
} catch (err) {
  if (err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND")) {
    process.stderr.write(
      "praxis has not been built yet. Run `npm run build` from the repository root.\n",
    )
    process.exit(69)
  }
  throw err
}

await entry.main(process.argv.slice(2))
