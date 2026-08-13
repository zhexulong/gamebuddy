import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

/**
 * Serializes small durable artifacts both within this Host process and across
 * local Host processes that share the same runtime root. The `.lock` file is
 * advisory ownership, never player-visible state. A process that cannot
 * acquire it fails closed rather than running an unlocked read-modify-write.
 *
 * The optional containment root is deliberately part of this API rather than
 * being checked by callers before entering the lock. Parent creation,
 * boundary verification, lock acquisition, and the final verification are one
 * operation. This narrows (but cannot eliminate without openat-style handles)
 * the filesystem replacement window around a durable write.
 */
const tails = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 20;
const STALE_LOCK_MS = 5 * 60_000;

type LockOwner = Readonly<{ token: string; pid: number; createdAtMs: number }>;
export type PathLockOptions = Readonly<{ containmentRoot?: string; timeoutMs?: number }>;

type OwnedFile = Readonly<{ dev: number; ino: number }>;

/**
 * Writes a single file through a caller-held path lock. The temporary is
 * created exclusively and is removed only while it still has the inode that
 * this invocation created. Callers must hold withPathLock for the target.
 */
export async function atomicWriteFile(path: string, content: string, containmentRoot?: string): Promise<void> {
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let owner: OwnedFile | undefined;
  let primaryError: unknown;
  try {
    await verifySafePathBoundary(target, containmentRoot);
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    owner = await identifyOwnedFile(temporary, containmentRoot);
    await verifySafePathBoundary(temporary, containmentRoot);
    await verifySafePathBoundary(target, containmentRoot);
    await rename(temporary, target);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (owner !== undefined) {
      try {
        await cleanupOwnedFile(temporary, containmentRoot, owner);
      } catch (cleanupError) {
        if (primaryError === undefined) throw cleanupError;
      }
    }
  }
}

export async function removeSafeFile(path: string, containmentRoot?: string): Promise<void> {
  const target = resolve(path);
  await verifySafePathBoundary(target, containmentRoot);
  try {
    await rm(target, { force: true });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function identifyOwnedFile(path: string, containmentRoot?: string): Promise<OwnedFile> {
  await verifySafePathBoundary(path, containmentRoot);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe_path_boundary");
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

async function cleanupOwnedFile(path: string, containmentRoot: string | undefined, owner: OwnedFile): Promise<void> {
  await verifySafePathBoundary(path, containmentRoot);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== owner.dev || stat.ino !== owner.ino) return;
  await verifySafePathBoundary(path, containmentRoot);
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) return;
  await rm(path, { force: true });
}


export function pathLockPath(path: string): string {
  return `${path}.lock`;
}

/**
 * Verifies an existing artifact boundary without creating anything. The leaf
 * may be absent, but its parent and every existing ancestor must be a real
 * directory (not a symlink, junction, or other path that resolves elsewhere).
 */
export async function verifySafePathBoundary(path: string, containmentRoot?: string): Promise<void> {
  const target = resolve(path);
  const root = containmentRoot === undefined ? undefined : resolve(containmentRoot);
  assertContained(target, root);
  if (root !== undefined && target === root) throw new Error("unsafe_tavern_artifact_path");
  if (root !== undefined) await verifyDirectory(root);
  await verifyExistingDirectoryAncestors(dirname(target), root);
  await verifyLeaf(target);
}

/**
 * Enumerates a Tavern directory only after checking its directory chain and
 * then checking each returned entry. This is a best-effort lexical/lstat
 * boundary; descriptor-relative enumeration is intentionally not claimed.
 */
export async function readSafeDirectory(path: string, containmentRoot?: string): Promise<readonly string[]> {
  const target = resolve(path);
  const root = containmentRoot === undefined ? undefined : resolve(containmentRoot);
  assertContained(target, root);
  if (root !== undefined) await verifyDirectory(root);
  await verifyDirectory(target);
  await verifyExistingDirectoryAncestors(target, root);
  const entries = await readdir(target);
  for (const entry of entries) {
    const entryPath = resolve(target, entry);
    assertContained(entryPath, root);
    const stat = await lstat(entryPath);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("unsafe_path_boundary");
    await verifyPhysicalPath(entryPath);
  }
  return Object.freeze(entries);
}

export async function withPathLock<T>(
  path: string,
  work: () => Promise<T>,
  options: PathLockOptions = {},
): Promise<T> {
  const target = resolve(path);
  const root = options.containmentRoot === undefined ? undefined : resolve(options.containmentRoot);
  assertContained(target, root);
  if (root !== undefined && target === root) throw new Error("unsafe_tavern_artifact_path");
  const previous = tails.get(target) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    releaseLocal = resolvePromise;
  });
  const tail = previous.then(() => current);
  tails.set(target, tail);
  await previous;
  let releaseFile: (() => Promise<void>) | undefined;
  try {
    // Verify the existing chain before every mkdir. mkdir({ recursive: true })
    // would otherwise follow a swapped symlink/junction before we can inspect
    // the parent. The target may not exist yet, but its boundary is checked.
    await ensureSafeParent(target, root);
    releaseFile = await acquireFileLock(target, root, options.timeoutMs);
    // A parent can change while the lock file is being acquired. Recheck
    // immediately before handing control to code that can read or write.
    await verifyBoundary(target, root);
    return await work();
  } finally {
    try {
      await releaseFile?.();
    } finally {
      releaseLocal();
      if (tails.get(target) === tail) tails.delete(target);
    }
  }
}

async function acquireFileLock(path: string, root: string | undefined, timeoutMs?: number): Promise<() => Promise<void>> {
  const lockPath = pathLockPath(path);
  const owner: LockOwner = Object.freeze({ token: randomUUID(), pid: process.pid, createdAtMs: Date.now() });
  const deadline = Date.now() + (timeoutMs ?? LOCK_TIMEOUT_MS);
  // ensureSafeParent has already validated and created this directory. Keep a
  // second check here so this function cannot become an unsafe mkdir sink if
  // it is refactored or called from another path in the future.
  await verifyBoundary(path, root);
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(owner), "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        // Do not unlink a lock replaced by another owner after a crash/stale
        // recovery race. The owner token is the minimum local proof.
        try {
          const current = parseOwner(await readFile(lockPath, "utf8"));
          if (current?.token === owner.token) await rm(lockPath, { force: true });
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      // Never parse or reclaim a lock through a link/reparse point. A
      // malformed regular owner remains a barrier; only an owned stale file
      // can reach reclaimStaleLock.
      await verifyLeaf(lockPath);
      await reclaimStaleLock(lockPath);
      if (Date.now() >= deadline) throw new Error("durable_path_lock_timeout");
      await delay(LOCK_POLL_MS);
    }
  }
}

async function ensureSafeParent(path: string, root: string | undefined): Promise<void> {
  if (root !== undefined) {
    assertContained(path, root);
    await ensureSafeDirectory(root);
    await ensureSafeDirectory(dirname(path), root);
    await verifyLeaf(path);
    await verifyLeaf(pathLockPath(path));
    return;
  }
  await ensureSafeDirectory(dirname(path));
  await verifyLeaf(path);
  await verifyLeaf(pathLockPath(path));
}

async function ensureSafeDirectory(path: string, root?: string): Promise<void> {
  const target = resolve(path);
  assertContained(target, root);
  try {
    await verifyDirectory(target);
    await verifyExistingDirectoryAncestors(target, root);
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const parent = dirname(target);
  // The parent is verified before mkdir, and the newly-created component is
  // verified immediately afterward. This is intentionally not recursive mkdir.
  await ensureSafeDirectory(parent, root);
  try {
    await mkdir(target);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  await verifyDirectory(target);
  await verifyExistingDirectoryAncestors(target, root);
}

async function verifyExistingDirectoryAncestors(path: string, root?: string): Promise<void> {
  let current = resolve(path);
  const boundary = root === undefined ? undefined : resolve(root);
  while (true) {
    assertContained(current, boundary);
    try {
      await verifyDirectory(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (boundary !== undefined && current === boundary) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function verifyBoundary(path: string, root: string | undefined): Promise<void> {
  assertContained(path, root);
  if (root !== undefined) await verifyDirectory(root);
  await verifyDirectory(dirname(path));
  await verifyLeaf(path);
  await verifyLeaf(pathLockPath(path));
}

async function verifyDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_path_boundary");
  await verifyPhysicalPath(path);
}

async function verifyLeaf(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe_path_boundary");
    await verifyPhysicalPath(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function verifyPhysicalPath(path: string): Promise<void> {
  // lstat rejects ordinary symlinks. realpath adds the Windows junction/
  // reparse-point check: a path whose directory entry resolves elsewhere is
  // not accepted, even when Node reports it as a directory.
  const physical = await realpath(path);
  if (!samePhysicalPath(path, physical)) throw new Error("unsafe_path_boundary");
}

function samePhysicalPath(left: string, right: string): boolean {
  const a = resolve(left).replaceAll("\\", "/");
  const b = resolve(right).replaceAll("\\", "/");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertContained(path: string, root: string | undefined): void {
  if (root === undefined) return;
  const relativePath = relative(root, path);
  const outside = relativePath === ".." || relativePath.startsWith(`..${sep}`);
  if (outside) throw new Error("unsafe_tavern_artifact_path");
}

async function reclaimStaleLock(lockPath: string): Promise<void> {
  try {
    const owner = parseOwner(await readFile(lockPath, "utf8"));
    if (owner === null || Date.now() - owner.createdAtMs < STALE_LOCK_MS || processAlive(owner.pid)) return;
    // A stale owner can only be reclaimed after it is both old and locally
    // dead; malformed/ambiguous ownership stays fail-closed until timeout.
    const current = parseOwner(await readFile(lockPath, "utf8"));
    if (current?.token === owner.token) await rm(lockPath, { force: true });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return typeof record.token === "string" &&
      /^[0-9a-f-]{36}$/i.test(record.token) &&
      typeof record.pid === "number" &&
      Number.isSafeInteger(record.pid) &&
      typeof record.createdAtMs === "number" &&
      Number.isSafeInteger(record.createdAtMs)
      ? Object.freeze({ token: record.token, pid: record.pid, createdAtMs: record.createdAtMs })
      : null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
