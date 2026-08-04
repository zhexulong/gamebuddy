import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Serializes small durable artifacts both within this Host process and across
 * local Host processes that share the same runtime root. The `.lock` file is
 * advisory ownership, never player-visible state. A process that cannot
 * acquire it fails closed rather than running an unlocked read-modify-write.
 */
const tails = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 20;
const STALE_LOCK_MS = 5 * 60_000;

type LockOwner = Readonly<{ token: string; pid: number; createdAtMs: number }>;

export function pathLockPath(path: string): string {
  return `${path}.lock`;
}

export async function withPathLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(path) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const current = new Promise<void>((resolve) => { releaseLocal = resolve; });
  const tail = previous.then(() => current);
  tails.set(path, tail);
  await previous;
  let releaseFile: (() => Promise<void>) | undefined;
  try {
    releaseFile = await acquireFileLock(path);
    return await work();
  } finally {
    try { await releaseFile?.(); }
    finally {
      releaseLocal();
      if (tails.get(path) === tail) tails.delete(path);
    }
  }
}

async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const lockPath = pathLockPath(path);
  const owner: LockOwner = Object.freeze({ token: randomUUID(), pid: process.pid, createdAtMs: Date.now() });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try { await handle.writeFile(JSON.stringify(owner), "utf8"); }
      finally { await handle.close(); }
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
      await reclaimStaleLock(lockPath);
      if (Date.now() >= deadline) throw new Error("durable_path_lock_timeout");
      await delay(LOCK_POLL_MS);
    }
  }
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
  try { process.kill(pid, 0); return true; }
  catch (error) { return isNodeError(error) && error.code === "EPERM"; }
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return typeof record.token === "string" && /^[0-9a-f-]{36}$/i.test(record.token)
      && typeof record.pid === "number" && Number.isSafeInteger(record.pid)
      && typeof record.createdAtMs === "number" && Number.isSafeInteger(record.createdAtMs)
      ? Object.freeze({ token: record.token, pid: record.pid, createdAtMs: record.createdAtMs })
      : null;
  } catch { return null; }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && typeof error.code === "string"; }
