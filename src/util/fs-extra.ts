/**
 * Filesystem helpers.
 *
 * Every write the agent performs goes through here so we get atomic renames,
 * mode preservation, BOM/line-ending round-tripping and consistent error
 * mapping. Losing a user's file because a process died mid-write is not an
 * acceptable failure mode for a coding agent.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NotFoundError, PermissionDeniedError, ValidationError } from "./error.js"
import { detectLineEnding, looksBinary, normalizeLineEndings, splitBom } from "./string.js"

export async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

export function existsSync(target: string): boolean {
  try {
    fs.accessSync(target)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory()
  } catch {
    return false
  }
}

export async function isFile(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isFile()
  } catch {
    return false
  }
}

export async function statSafe(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.stat(target)
  } catch {
    return undefined
  }
}

export async function ensureDir(target: string): Promise<void> {
  await fsp.mkdir(target, { recursive: true })
}

export function ensureDirSync(target: string): void {
  fs.mkdirSync(target, { recursive: true })
}

export interface TextFile {
  readonly path: string
  readonly content: string
  readonly bom: string
  readonly lineEnding: "lf" | "crlf"
  readonly mode: number
  readonly size: number
  readonly mtimeMs: number
}

/**
 * Reads a text file, normalising line endings to LF for internal processing
 * while remembering the original style so writes can restore it.
 */
export async function readTextFile(target: string): Promise<TextFile> {
  let stat: fs.Stats
  try {
    stat = await fsp.stat(target)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") throw new NotFoundError({ kind: "file", identifier: target })
    if (code === "EACCES" || code === "EPERM")
      throw new PermissionDeniedError({ action: "read", resource: target })
    throw err
  }
  if (stat.isDirectory()) {
    throw new ValidationError({
      issues: [{ path: target, message: "is a directory, not a file" }],
    })
  }

  const buffer = await fsp.readFile(target)
  if (looksBinary(buffer)) {
    throw new ValidationError({
      issues: [{ path: target, message: "appears to be a binary file" }],
    })
  }
  const raw = buffer.toString("utf8")
  const { bom, body } = splitBom(raw)
  const lineEnding = detectLineEnding(body)
  return {
    path: target,
    content: normalizeLineEndings(body, "lf"),
    bom,
    lineEnding,
    mode: stat.mode & 0o777,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

export async function readTextFileSafe(target: string): Promise<TextFile | undefined> {
  try {
    return await readTextFile(target)
  } catch {
    return undefined
  }
}

/**
 * Atomic write: content lands in a sibling temp file, is fsync'd, then renamed
 * over the target. Renames within a directory are atomic on POSIX and NTFS.
 */
export async function writeFileAtomic(
  target: string,
  content: string | Buffer,
  options: { readonly mode?: number; readonly fsync?: boolean } = {},
): Promise<void> {
  const directory = path.dirname(target)
  await ensureDir(directory)
  const temp = path.join(directory, `.${path.basename(target)}.${crypto.randomBytes(6).toString("hex")}.tmp`)
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(temp, "w", options.mode ?? 0o644)
    await handle.writeFile(content)
    if (options.fsync !== false) await handle.sync()
    await handle.close()
    handle = undefined
    if (options.mode !== undefined) await fsp.chmod(temp, options.mode)
    await fsp.rename(temp, target)
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined)
    await fsp.unlink(temp).catch(() => undefined)
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EACCES" || code === "EPERM")
      throw new PermissionDeniedError({ action: "write", resource: target })
    throw err
  }
}

/**
 * Writes text back to a file, restoring the original BOM, line endings and
 * permission bits. When the file is new, sane defaults are used.
 */
export async function writeTextFile(
  target: string,
  content: string,
  original?: Pick<TextFile, "bom" | "lineEnding" | "mode">,
): Promise<void> {
  const bom = original?.bom ?? ""
  const lineEnding = original?.lineEnding ?? "lf"
  const body = normalizeLineEndings(content, lineEnding)
  await writeFileAtomic(target, bom + body, { mode: original?.mode })
}

/** Reads a file as UTF-8, returning undefined when it does not exist. */
export async function readFileSafe(target: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(target, "utf8")
  } catch {
    return undefined
  }
}

export function readFileSafeSync(target: string): string | undefined {
  try {
    return fs.readFileSync(target, "utf8")
  } catch {
    return undefined
  }
}

export async function readJsonSafe<T>(target: string): Promise<T | undefined> {
  const text = await readFileSafe(target)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export async function writeJson(
  target: string,
  value: unknown,
  options: { readonly mode?: number; readonly indent?: number } = {},
): Promise<void> {
  await writeFileAtomic(target, JSON.stringify(value, null, options.indent ?? 2) + "\n", {
    mode: options.mode,
  })
}

/** Recursive copy preserving modes; used by snapshot restore. */
export async function copyTree(from: string, to: string): Promise<void> {
  const stat = await fsp.lstat(from)
  if (stat.isDirectory()) {
    await ensureDir(to)
    for (const entry of await fsp.readdir(from)) {
      await copyTree(path.join(from, entry), path.join(to, entry))
    }
    await fsp.chmod(to, stat.mode & 0o777).catch(() => undefined)
    return
  }
  if (stat.isSymbolicLink()) {
    const link = await fsp.readlink(from)
    await fsp.unlink(to).catch(() => undefined)
    await fsp.symlink(link, to)
    return
  }
  await ensureDir(path.dirname(to))
  await fsp.copyFile(from, to)
  await fsp.chmod(to, stat.mode & 0o777).catch(() => undefined)
}

export async function removeTree(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true })
}

/** Moves a file, falling back to copy+unlink across devices. */
export async function move(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to))
  try {
    await fsp.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
    await copyTree(from, to)
    await removeTree(from)
  }
}

/** Creates a unique temporary directory that the caller must clean up. */
export async function makeTempDir(prefix = "praxis-"): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>, prefix?: string): Promise<T> {
  const dir = await makeTempDir(prefix)
  try {
    return await fn(dir)
  } finally {
    await removeTree(dir)
  }
}

/** Walks up from `start` looking for any of `names`. */
export async function findUp(
  names: readonly string[],
  start: string,
  stop?: string,
): Promise<string | undefined> {
  let dir = path.resolve(start)
  const boundary = stop ? path.resolve(stop) : undefined
  for (let depth = 0; depth < 128; depth++) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (await exists(candidate)) return candidate
    }
    if (boundary && dir === boundary) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function findUpSync(
  names: readonly string[],
  start: string,
  stop?: string,
): string | undefined {
  let dir = path.resolve(start)
  const boundary = stop ? path.resolve(stop) : undefined
  for (let depth = 0; depth < 128; depth++) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    if (boundary && dir === boundary) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Directory of every ancestor from `start` up to (and including) `root`. */
export function ancestors(start: string, root?: string): string[] {
  const out: string[] = []
  let dir = path.resolve(start)
  const boundary = root ? path.resolve(root) : undefined
  for (let depth = 0; depth < 128; depth++) {
    out.push(dir)
    if (boundary && dir === boundary) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

/** True when `child` is inside `parent` (after symlink resolution). */
export async function isInside(parent: string, child: string): Promise<boolean> {
  const resolvedParent = await realpathSafe(path.resolve(parent))
  const resolvedChild = await realpathSafe(path.resolve(child))
  const relative = path.relative(resolvedParent, resolvedChild)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function isInsideSync(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export async function realpathSafe(target: string): Promise<string> {
  try {
    return await fsp.realpath(target)
  } catch {
    return path.resolve(target)
  }
}

/** Human-friendly relative path, falling back to absolute when far away. */
export function displayPath(target: string, base = process.cwd()): string {
  const relative = path.relative(base, target)
  if (relative === "") return "."
  if (relative.startsWith("..") || path.isAbsolute(relative)) return target
  return relative.split(path.sep).join("/")
}

/** Reads the first `limit` bytes; used to sniff file types cheaply. */
export async function readHead(target: string, limit = 4096): Promise<Buffer> {
  const handle = await fsp.open(target, "r")
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function isBinaryFile(target: string): Promise<boolean> {
  try {
    return looksBinary(await readHead(target, 8000))
  } catch {
    return false
  }
}

export async function fileHash(target: string, algorithm = "sha256"): Promise<string> {
  const hash = crypto.createHash(algorithm)
  const stream = fs.createReadStream(target)
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve())
    stream.on("error", reject)
  })
  return hash.digest("hex")
}

/** Appends a line to a file, creating it if needed. */
export async function appendLine(target: string, line: string): Promise<void> {
  await ensureDir(path.dirname(target))
  await fsp.appendFile(target, line.endsWith("\n") ? line : line + "\n", "utf8")
}

/** Best-effort executable discovery, mirroring `which`. */
export async function which(command: string): Promise<string | undefined> {
  if (command.includes(path.sep)) {
    return (await isExecutable(command)) ? path.resolve(command) : undefined
  }
  const pathEnv = process.env.PATH ?? ""
  const separator = process.platform === "win32" ? ";" : ":"
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""]
  for (const dir of pathEnv.split(separator)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension.toLowerCase())
      if (await isExecutable(candidate)) return candidate
      const upper = path.join(dir, command + extension)
      if (extension && (await isExecutable(upper))) return upper
    }
  }
  return undefined
}

async function isExecutable(target: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(target)
    if (!stat.isFile()) return false
    if (process.platform === "win32") return true
    await fsp.access(target, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Total size of a directory tree, capped to avoid pathological walks. */
export async function treeSize(target: string, limit = 200_000): Promise<number> {
  let total = 0
  let count = 0
  const queue = [target]
  while (queue.length) {
    const dir = queue.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (count++ > limit) return total
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await statSafe(full)
      if (stat) total += stat.size
    }
  }
  return total
}

/** Normalises a user-supplied path: expands `~`, resolves against cwd. */
export function resolveUserPath(input: string, cwd = process.cwd()): string {
  let value = input.trim()
  if (value.startsWith("~")) {
    value = path.join(os.homedir(), value.slice(1))
  }
  return path.resolve(cwd, value)
}

/** Extension without the dot, lowercased. */
export function extname(target: string): string {
  const ext = path.extname(target)
  return ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase()
}

/** Basename without extension. */
export function stem(target: string): string {
  return path.basename(target, path.extname(target))
}
