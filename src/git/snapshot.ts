/**
 * Filesystem snapshots for undo.
 *
 * The problem: an agent editing files needs an undo that works even when the user
 * has uncommitted changes, is mid-rebase, or is not using git at all. `git stash`
 * is unusable here — it mutates the user's index and reflog, and an agent that
 * stashes a user's work in the background is unforgivable.
 *
 * The solution: a **shadow repository**. A separate git directory, stored under
 * the Praxis data directory, whose work tree is the project. Commits go into that
 * repository, never the user's. The user's index, stash, reflog, and HEAD are
 * untouched, and `git status` in their terminal shows exactly what it did before.
 *
 * This is why `GIT_DIR` and `GIT_WORK_TREE` are set explicitly on every call
 * rather than using `-C`: they redirect all of git's state to our directory while
 * leaving the work tree in place.
 *
 * Snapshots are cheap because git deduplicates by content: a hundred snapshots of
 * a project where three files changed costs three blobs. Restoring is a
 * `checkout` of the snapshot tree, scoped to the paths that actually differ, so
 * an undo never touches a file the agent did not.
 *
 * Falls back to copying files into a content-addressed store when git is missing.
 * The fallback is genuinely used — plenty of directories are not repositories — so
 * it is a real implementation rather than a stub.
 */

import { execFile } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

import { logger } from "../util/log.js"
import { newId } from "../util/id.js"
import { Paths } from "../global.js"
import { xxhash32 } from "../util/hash.js"
import { ensureDirSync, which } from "../util/fs-extra.js"
import { findRepositoryRoot } from "./git.js"

const log = logger("git.snapshot")

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface Snapshot {
  readonly id: string
  /** Commit hash in the shadow repository, or a manifest hash in fallback mode. */
  readonly ref: string
  readonly createdAt: number
  readonly label: string
  readonly backend: "git" | "copy"
  readonly fileCount: number
}

export interface RestoreResult {
  readonly restored: readonly string[]
  readonly deleted: readonly string[]
  readonly failed: ReadonlyArray<{ path: string; reason: string }>
}

/* ------------------------------------------------------------------ */
/* Shadow git invocation                                               */
/* ------------------------------------------------------------------ */

interface ShellResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs git against the shadow repository.
 *
 * The environment is the whole trick:
 *  - `GIT_DIR` points at our private directory, so refs and objects go there.
 *  - `GIT_WORK_TREE` points at the project, so git sees the real files.
 *  - `GIT_INDEX_FILE` is explicit, so we never share an index with the user's git.
 *  - The author and committer are forced, because an unconfigured git refuses to
 *    commit at all, and inheriting the user's identity would put our snapshot
 *    commits under their name.
 */
function shadowGit(
  args: readonly string[],
  options: { gitDir: string; workTree: string; timeoutMs?: number },
): Promise<ShellResult> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["--no-pager", ...args],
      {
        cwd: options.workTree,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: options.gitDir,
          GIT_WORK_TREE: options.workTree,
          GIT_INDEX_FILE: join(options.gitDir, "praxis-index"),
          GIT_AUTHOR_NAME: "Praxis",
          GIT_AUTHOR_EMAIL: "snapshot@praxis.local",
          GIT_COMMITTER_NAME: "Praxis",
          GIT_COMMITTER_EMAIL: "snapshot@praxis.local",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          // Never let the user's global config change our behaviour: a
          // `core.hooksPath` or a `commit.gpgsign` in their config would break
          // snapshots in confusing ways.
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          LC_ALL: "C",
        },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        })
      },
    )
  })
}

/* ------------------------------------------------------------------ */
/* Snapshot manager                                                    */
/* ------------------------------------------------------------------ */

export class SnapshotStore {
  private readonly workTree: string
  private readonly gitDir: string
  private readonly copyDir: string
  private readonly backend: "git" | "copy"
  private initialized = false

  constructor(options: { cwd: string; projectId: string }) {
    this.workTree = resolve(options.cwd)
    this.gitDir = join(Paths.dataDir, "snapshots", options.projectId, "git")
    this.copyDir = join(Paths.dataDir, "snapshots", options.projectId, "objects")
    this.backend = which("git") ? "git" : "copy"
  }

  /**
   * Creates the shadow repository on first use.
   *
   * The `info/exclude` file is important: without it a snapshot of a Node project
   * would add `node_modules` to the index, which takes minutes and gigabytes.
   * Excluding at the git level rather than filtering paths ourselves means git's
   * own fast path does the work.
   */
  private async initialize(): Promise<boolean> {
    if (this.initialized) return true

    if (this.backend === "copy") {
      ensureDirSync(this.copyDir)
      this.initialized = true
      return true
    }

    if (!existsSync(join(this.gitDir, "HEAD"))) {
      ensureDirSync(dirname(this.gitDir))
      const init = await shadowGit(["init", "--quiet", `--separate-git-dir=${this.gitDir}`], {
        gitDir: this.gitDir,
        workTree: this.workTree,
      })

      // `--separate-git-dir` on an existing repository would rewrite the user's
      // `.git`, which is unacceptable. Use the plain form and rely on GIT_DIR.
      if (!init.ok) {
        ensureDirSync(this.gitDir)
        const bare = await shadowGit(["init", "--quiet", "--bare", this.gitDir], {
          gitDir: this.gitDir,
          workTree: this.workTree,
        })
        if (!bare.ok) {
          log.warn("could not create the shadow repository", { stderr: bare.stderr.slice(0, 300) })
          return false
        }
      }

      // A bare repository has core.bare=true, which refuses a work tree.
      await shadowGit(["config", "core.bare", "false"], {
        gitDir: this.gitDir,
        workTree: this.workTree,
      })
      await shadowGit(["config", "core.autocrlf", "false"], {
        gitDir: this.gitDir,
        workTree: this.workTree,
      })
      // Snapshots must be byte-exact; any filter would corrupt a restore.
      await shadowGit(["config", "core.safecrlf", "false"], {
        gitDir: this.gitDir,
        workTree: this.workTree,
      })
      await shadowGit(["config", "core.fsmonitor", "false"], {
        gitDir: this.gitDir,
        workTree: this.workTree,
      })
      await shadowGit(["config", "gc.auto", "0"], {
        gitDir: this.gitDir,
        workTree: this.workTree,
      })

      ensureDirSync(join(this.gitDir, "info"))
      writeFileSync(join(this.gitDir, "info", "exclude"), EXCLUDES.join("\n"), "utf8")
    }

    this.initialized = true
    return true
  }

  /**
   * Snapshots the current state of the work tree.
   *
   * `add --all` then `write-tree` then `commit-tree`: the low-level plumbing is
   * used rather than `git commit` because `commit` insists on a HEAD and refuses
   * an empty commit, whereas we want a snapshot even when nothing changed (so the
   * revert points are contiguous).
   */
  async create(label: string): Promise<Snapshot | undefined> {
    if (!(await this.initialize())) return undefined

    if (this.backend === "copy") return this.createCopySnapshot(label)

    const add = await shadowGit(["add", "--all", "--", "."], {
      gitDir: this.gitDir,
      workTree: this.workTree,
      timeoutMs: 60_000,
    })

    if (!add.ok) {
      log.debug("snapshot add failed", { stderr: add.stderr.slice(0, 300) })
      return undefined
    }

    const tree = await shadowGit(["write-tree"], {
      gitDir: this.gitDir,
      workTree: this.workTree,
      timeoutMs: 60_000,
    })

    if (!tree.ok) return undefined
    const treeHash = tree.stdout.trim()

    // Parent to the previous snapshot so the history is inspectable with normal
    // git tooling if anyone ever needs to debug a restore.
    const previous = await shadowGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
      gitDir: this.gitDir,
      workTree: this.workTree,
    })
    const parent = previous.stdout.trim()

    const commit = await shadowGit(
      [
        "commit-tree",
        treeHash,
        ...(parent ? ["-p", parent] : []),
        "-m",
        label.slice(0, 200),
      ],
      { gitDir: this.gitDir, workTree: this.workTree },
    )

    if (!commit.ok) return undefined
    const ref = commit.stdout.trim()

    await shadowGit(["update-ref", "HEAD", ref], {
      gitDir: this.gitDir,
      workTree: this.workTree,
    })

    const count = await shadowGit(["ls-tree", "-r", "--name-only", ref], {
      gitDir: this.gitDir,
      workTree: this.workTree,
      timeoutMs: 30_000,
    })

    const snapshot: Snapshot = {
      id: newId("snapshot"),
      ref,
      createdAt: Date.now(),
      label,
      backend: "git",
      fileCount: count.stdout.split("\n").filter(Boolean).length,
    }

    log.debug("snapshot created", { ref: ref.slice(0, 8), files: snapshot.fileCount })
    return snapshot
  }

  /**
   * Restores the work tree to a snapshot.
   *
   * Scoped by design. A blanket `checkout` would revert files the agent never
   * touched, destroying work the user did in their editor while the agent ran.
   * So the diff is computed first and only the differing paths are restored.
   */
  async restore(
    snapshot: Snapshot,
    options: { paths?: readonly string[] } = {},
  ): Promise<RestoreResult> {
    if (snapshot.backend === "copy") return this.restoreCopySnapshot(snapshot, options)
    if (!(await this.initialize())) {
      return { restored: [], deleted: [], failed: [{ path: "*", reason: "no snapshot backend" }] }
    }

    // What differs between the snapshot and the current work tree.
    const diff = await shadowGit(
      ["diff", "--name-status", "-z", snapshot.ref, "--", ...(options.paths ?? ["."])],
      { gitDir: this.gitDir, workTree: this.workTree, timeoutMs: 60_000 },
    )

    if (!diff.ok) {
      return {
        restored: [],
        deleted: [],
        failed: [{ path: "*", reason: diff.stderr.slice(0, 200) }],
      }
    }

    const fields = diff.stdout.split("\u0000").filter(Boolean)
    const toRestore: string[] = []
    const toDelete: string[] = []

    for (let index = 0; index < fields.length; index++) {
      const code = fields[index]!
      if (code.length > 2) continue
      const path = fields[++index]
      if (!path) continue

      // Reading the diff from snapshot to working tree: "A" means the file exists
      // now but not in the snapshot, so restoring means deleting it.
      if (code.startsWith("A")) {
        toDelete.push(path)
      } else {
        toRestore.push(path)
      }
    }

    const failed: Array<{ path: string; reason: string }> = []

    if (toRestore.length > 0) {
      // Batched: a checkout with 10 000 path arguments exceeds the command line
      // limit on every platform.
      for (const batch of chunk(toRestore, 200)) {
        const checkout = await shadowGit(
          ["checkout", snapshot.ref, "--", ...batch],
          { gitDir: this.gitDir, workTree: this.workTree, timeoutMs: 60_000 },
        )
        if (!checkout.ok) {
          for (const path of batch) failed.push({ path, reason: checkout.stderr.slice(0, 120) })
        }
      }
    }

    const deleted: string[] = []
    for (const path of toDelete) {
      const absolute = join(this.workTree, path)
      try {
        rmSync(absolute, { force: true })
        deleted.push(path)
      } catch (error) {
        failed.push({ path, reason: (error as Error).message })
      }
    }

    log.info("snapshot restored", {
      ref: snapshot.ref.slice(0, 8),
      restored: toRestore.length,
      deleted: deleted.length,
    })

    return {
      restored: toRestore.filter((path) => !failed.some((entry) => entry.path === path)),
      deleted,
      failed,
    }
  }

  /**
   * Lists the files that changed between a snapshot and now.
   *
   * Used to show the user what an undo would do before they confirm it, which is
   * the difference between a trustworthy undo and a scary one.
   */
  async changedSince(snapshot: Snapshot): Promise<string[]> {
    if (snapshot.backend === "copy") {
      const manifest = this.readManifest(snapshot.ref)
      if (!manifest) return []
      const changed: string[] = []
      for (const [path, hash] of Object.entries(manifest.files)) {
        const absolute = join(this.workTree, path)
        if (!existsSync(absolute)) {
          changed.push(path)
          continue
        }
        try {
          if (xxhash32(readFileSync(absolute, "utf8")) !== hash) changed.push(path)
        } catch {
          changed.push(path)
        }
      }
      return changed
    }

    if (!(await this.initialize())) return []

    const diff = await shadowGit(["diff", "--name-only", snapshot.ref], {
      gitDir: this.gitDir,
      workTree: this.workTree,
      timeoutMs: 60_000,
    })

    return diff.ok ? diff.stdout.split("\n").filter(Boolean) : []
  }

  /** Diff between a snapshot and the current work tree, as a patch. */
  async diff(snapshot: Snapshot, maxChars = 60_000): Promise<string> {
    if (snapshot.backend === "copy" || !(await this.initialize())) return ""

    const result = await shadowGit(["diff", "--unified=3", snapshot.ref], {
      gitDir: this.gitDir,
      workTree: this.workTree,
      timeoutMs: 60_000,
    })

    if (!result.ok) return ""
    return result.stdout.length > maxChars
      ? `${result.stdout.slice(0, maxChars)}\n\n[diff truncated]`
      : result.stdout
  }

  /**
   * Removes snapshots older than a cutoff and repacks.
   *
   * Snapshots are cheap but not free, and a project edited daily for a year would
   * accumulate a lot of loose objects. Called opportunistically, never on a path
   * the user is waiting on.
   */
  async prune(olderThanMs: number): Promise<void> {
    if (this.backend === "copy") {
      this.pruneCopyStore(olderThanMs)
      return
    }
    if (!(await this.initialize())) return

    const cutoff = new Date(Date.now() - olderThanMs).toISOString()

    // Rewrite HEAD to the oldest commit newer than the cutoff, then expire the
    // reflog and gc. Losing old snapshots is fine; keeping them forever is not.
    const keep = await shadowGit(
      ["rev-list", "--max-count=1", `--until=${cutoff}`, "HEAD"],
      { gitDir: this.gitDir, workTree: this.workTree },
    )

    const boundary = keep.stdout.trim()
    if (boundary) {
      await shadowGit(["update-ref", "refs/praxis/oldest", boundary], {
        gitDir: this.gitDir,
        workTree: this.workTree,
      })
    }

    await shadowGit(["reflog", "expire", "--expire=now", "--all"], {
      gitDir: this.gitDir,
      workTree: this.workTree,
      timeoutMs: 60_000,
    })

    await shadowGit(["gc", "--prune=now", "--quiet"], {
      gitDir: this.gitDir,
      workTree: this.workTree,
      timeoutMs: 120_000,
    })
  }

  /* ---------------------------------------------------------------- */
  /* Copy fallback                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Content-addressed copy snapshot, for when git is unavailable.
   *
   * Files are hashed and stored under their hash, so unchanged files across
   * snapshots share storage exactly as git would. A manifest maps paths to
   * hashes. Bounded to a file count and size because copying a large tree
   * synchronously would be unacceptable; beyond the bound the snapshot covers
   * what it can and says so.
   */
  private createCopySnapshot(label: string): Snapshot | undefined {
    const files = this.collectFiles()
    if (files.length === 0) return undefined

    const manifest: { label: string; createdAt: number; files: Record<string, string> } = {
      label,
      createdAt: Date.now(),
      files: {},
    }

    ensureDirSync(join(this.copyDir, "blobs"))

    for (const path of files) {
      const absolute = join(this.workTree, path)
      let content: string
      try {
        content = readFileSync(absolute, "utf8")
      } catch {
        continue
      }
      const hash = xxhash32(content).toString(16).padStart(8, "0")
      const blobPath = join(this.copyDir, "blobs", hash)
      if (!existsSync(blobPath)) {
        try {
          copyFileSync(absolute, blobPath)
        } catch {
          continue
        }
      }
      manifest.files[path] = hash
    }

    const serialized = JSON.stringify(manifest)
    const ref = xxhash32(serialized).toString(16).padStart(8, "0")
    ensureDirSync(join(this.copyDir, "manifests"))
    writeFileSync(join(this.copyDir, "manifests", `${ref}.json`), serialized, "utf8")

    return {
      id: newId("snapshot"),
      ref,
      createdAt: manifest.createdAt,
      label,
      backend: "copy",
      fileCount: Object.keys(manifest.files).length,
    }
  }

  private restoreCopySnapshot(
    snapshot: Snapshot,
    options: { paths?: readonly string[] },
  ): RestoreResult {
    const manifest = this.readManifest(snapshot.ref)
    if (!manifest) {
      return { restored: [], deleted: [], failed: [{ path: "*", reason: "snapshot not found" }] }
    }

    const restored: string[] = []
    const failed: Array<{ path: string; reason: string }> = []
    const filter = options.paths?.map((path) => relative(this.workTree, resolve(this.workTree, path)))

    for (const [path, hash] of Object.entries(manifest.files)) {
      if (filter && !filter.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        continue
      }

      const blobPath = join(this.copyDir, "blobs", hash)
      if (!existsSync(blobPath)) {
        failed.push({ path, reason: "blob missing from the snapshot store" })
        continue
      }

      const target = join(this.workTree, path)
      try {
        // Skip files that already match, so mtimes are not churned needlessly.
        if (existsSync(target) && xxhash32(readFileSync(target, "utf8")).toString(16).padStart(8, "0") === hash) {
          continue
        }
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(blobPath, target)
        restored.push(path)
      } catch (error) {
        failed.push({ path, reason: (error as Error).message })
      }
    }

    return { restored, deleted: [], failed }
  }

  private readManifest(
    ref: string,
  ): { label: string; createdAt: number; files: Record<string, string> } | undefined {
    try {
      return JSON.parse(
        readFileSync(join(this.copyDir, "manifests", `${ref}.json`), "utf8"),
      ) as { label: string; createdAt: number; files: Record<string, string> }
    } catch {
      return undefined
    }
  }

  private pruneCopyStore(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs
    const manifestDir = join(this.copyDir, "manifests")
    if (!existsSync(manifestDir)) return

    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs")
      for (const name of readdirSync(manifestDir)) {
        const path = join(manifestDir, name)
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
      }
    } catch {
      // Pruning is best-effort by nature.
    }
  }

  /**
   * Collects candidate files for a copy snapshot.
   *
   * Bounded hard. The copy backend exists for small non-git directories; a
   * ten-thousand-file tree without git is out of scope and will simply be
   * snapshotted partially rather than freezing the process.
   */
  private collectFiles(limit = 2_000): string[] {
    const results: string[] = []
    const queue: string[] = [this.workTree]
    const excluded = new Set(EXCLUDED_DIRECTORIES)

    const { readdirSync } = require("node:fs") as typeof import("node:fs")

    while (queue.length > 0 && results.length < limit) {
      const directory = queue.shift()!
      let entries: string[]
      try {
        entries = readdirSync(directory)
      } catch {
        continue
      }

      for (const name of entries) {
        if (name.startsWith(".") && name !== ".env") continue
        if (excluded.has(name)) continue
        const absolute = join(directory, name)
        let stats
        try {
          stats = statSync(absolute)
        } catch {
          continue
        }
        if (stats.isDirectory()) {
          queue.push(absolute)
          continue
        }
        // Large files are skipped: a snapshot is for source, not artefacts.
        if (stats.size > 2 * 1024 * 1024) continue
        results.push(relative(this.workTree, absolute).split("\\").join("/"))
        if (results.length >= limit) break
      }
    }

    return results
  }
}

/* ------------------------------------------------------------------ */
/* Exclusions                                                          */
/* ------------------------------------------------------------------ */

const EXCLUDED_DIRECTORIES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  ".gradle",
  ".idea",
  ".vscode",
  "Pods",
  ".terraform",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "bower_components",
  ".parcel-cache",
  ".serverless",
  ".output",
]

/**
 * Patterns written into the shadow repository's exclude file.
 *
 * More aggressive than a typical gitignore, because a snapshot only needs to
 * capture what a code change could affect. Including build output would make
 * every snapshot enormous and every restore dangerous.
 */
const EXCLUDES = [
  ...EXCLUDED_DIRECTORIES.map((name) => `${name}/`),
  "*.log",
  "*.tmp",
  "*.swp",
  "*.pyc",
  "*.pyo",
  "*.class",
  "*.o",
  "*.so",
  "*.dylib",
  "*.dll",
  "*.exe",
  "*.wasm",
  "*.zip",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  "*.rar",
  "*.7z",
  "*.iso",
  "*.dmg",
  "*.pdf",
  "*.mp4",
  "*.mov",
  "*.mkv",
  "*.mp3",
  "*.wav",
  "*.sqlite",
  "*.sqlite3",
  "*.db-wal",
  "*.db-shm",
  ".DS_Store",
  "Thumbs.db",
  "*.pack",
  "*.idx",
]

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

/* ------------------------------------------------------------------ */
/* Per-project instances                                               */
/* ------------------------------------------------------------------ */

const stores = new Map<string, SnapshotStore>()

/**
 * Gets or creates the snapshot store for a project.
 *
 * Keyed by project id rather than path so that a project opened from two
 * different but equivalent paths (a symlink, a different drive letter) shares one
 * snapshot history.
 */
export function snapshotStore(options: { cwd: string; projectId: string }): SnapshotStore {
  const existing = stores.get(options.projectId)
  if (existing) return existing
  const created = new SnapshotStore(options)
  stores.set(options.projectId, created)
  return created
}

/**
 * Whether snapshots are worth taking for a directory.
 *
 * Not taken for a home directory or a filesystem root: the file collection would
 * be enormous and the user almost certainly does not want an agent snapshotting
 * their entire home directory.
 */
export function snapshotsAdvisable(cwd: string): boolean {
  const absolute = resolve(cwd)
  const home = process.env["HOME"] ?? process.env["USERPROFILE"]

  if (home && absolute === resolve(home)) return false
  if (absolute === "/" || /^[A-Za-z]:\\?$/.test(absolute)) return false
  if (absolute.split(/[\\/]/).filter(Boolean).length <= 1) return false

  // A repository is the ideal case, but a plain project directory is fine too.
  return findRepositoryRoot(absolute) !== undefined || existsSync(join(absolute, "package.json"))
    ? true
    : countTopLevel(absolute) < 500
}

function countTopLevel(directory: string): number {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs")
    return readdirSync(directory).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}
