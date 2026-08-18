import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { readStrictJsonFile } from "./strict-json-reader.js";
import {
  reclaimStaleLock as nativeReclaimStaleLock,
  releaseOwnedLock as nativeReleaseOwnedLock,
  requestWindowsStaleLockReclaimer,
  type WindowsStaleLockReclaimerCapability,
  type WindowsStaleLockReclaimCategory,
  type WindowsStaleLockReclaimPolicy,
  type WindowsStaleLockReleaseCategory,
} from "./windows-stale-lock-reclaimer/index.js";

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
 *
 * Lock deletion is handle-bound: both stale reclaim and ordinary owner release
 * run fixed operations in the Windows-only `GameBuddy.WindowsStaleLockReclaimer`
 * helper through an opaque capability. This module never pathname-deletes a
 * lock file, never falls back to `rm`, and fails closed whenever the capability
 * is unavailable (including every non-Windows runtime).
 */
const tails = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 20;
const STALE_LOCK_MS = 5 * 60_000;

type LockOwner = Readonly<{ token: string; pid: number; createdAtMs: number }>;
export type PathLockOptions = Readonly<{ containmentRoot?: string; timeoutMs?: number }>;

/**
 * Explicit binding for the opaque Windows stale-lock reclaimer capability.
 * Production does not call this: the default fixed request policy lazily mints
 * the capability from the verified published/build helper pair. Tests bind a
 * test-only fake capability here, and pass `undefined` to force the
 * fail-closed unavailable behavior regardless of the runtime platform.
 */
export function bindWindowsStaleLockReclaimer(capability: WindowsStaleLockReclaimerCapability | undefined): void {
  windowsReclaimerBinding = capability === undefined ? { kind: "disabled" } : { kind: "capability", capability };
  defaultWindowsReclaimerRequest = undefined;
}

type WindowsReclaimerBinding = Readonly<
  | { kind: "unbound" }
  | { kind: "capability"; capability: WindowsStaleLockReclaimerCapability }
  | { kind: "disabled" }
>;
let windowsReclaimerBinding: WindowsReclaimerBinding = { kind: "unbound" };
let defaultWindowsReclaimerRequest: Promise<WindowsStaleLockReclaimerCapability | undefined> | undefined;

async function requestWindowsReclaimer(): Promise<WindowsStaleLockReclaimerCapability | undefined> {
  if (windowsReclaimerBinding.kind === "capability") return windowsReclaimerBinding.capability;
  if (windowsReclaimerBinding.kind === "disabled") return undefined;
  defaultWindowsReclaimerRequest ??= requestWindowsStaleLockReclaimer();
  return await defaultWindowsReclaimerRequest;
}

/**
 * Typed result of one stale-lock recovery attempt. The reclaim decision is
 * evidence-based: `reclaimed` only ever reports that the fixed Windows helper
 * deleted exactly the object it opened (a regular non-reparse file whose
 * identity, size, mtime and ctime stayed stable across a bounded observation
 * window on the same retained HANDLE), for a locally-dead valid owner or stale
 * malformed crash residue. `unsafe` means a link/reparse or non-regular entry
 * was observed and must never be deleted; the caller fails closed.
 */
export type PathLockRecoveryResult = Readonly<{
  outcome: "reclaimed" | "kept" | "unsafe";
  reason:
    | "valid_owner_stale_and_dead"
    | "malformed_stale_identity_stable"
    | "valid_owner_fresh"
    | "valid_owner_live"
    | "malformed_fresh"
    | "identity_changed_during_observation"
    | "reparse_or_link"
    | "lock_disappeared"
    | "windows_reclaimer_unavailable";
}>;

/**
 * Typed result of one normal owner release. Release is handle-bound too: the
 * helper re-reads the owner bytes through its own opened HANDLE and deletes
 * only when the exact UUID token is still proven there.
 */
export type PathLockReleaseResult = Readonly<{
  outcome: "released" | "kept" | "unavailable";
  reason: "exact_token_released" | "lock_already_missing" | "token_mismatch" | "not_regular" | "windows_reclaimer_unavailable";
}>;

export type SafeFileIdentity = Readonly<{ dev: number; ino: number }>;
type OwnedFile = SafeFileIdentity;

/** Dependencies of the atomic-write algorithm. Kept explicit so the durable
 * ownership protocol can be exercised against deterministic filesystem faults
 * without changing Node's module loader or production process flags. */
export type AtomicWriteFileDependencies = Readonly<{
  randomUUID: () => string;
  writeFile: typeof writeFile;
  rename: typeof rename;
  verifySafePathBoundary: typeof verifySafePathBoundary;
  captureSafeFileIdentity: typeof captureSafeFileIdentity;
  removeOwnedSafeFile: typeof removeOwnedSafeFile;
}>;

/**
 * Creates a single-file atomic writer through a caller-held path lock. The
 * temporary is created exclusively and removed only when its captured identity
 * still proves ownership. Callers must hold withPathLock for the target.
 */
export function createAtomicWriteFile(dependencies: AtomicWriteFileDependencies) {
  return async (path: string, content: string, containmentRoot?: string): Promise<void> => {
    const target = resolve(path);
    const temporary = `${target}.${process.pid}.${dependencies.randomUUID()}.tmp`;
    let owner: OwnedFile | undefined;
    let primaryError: unknown;
    try {
      await dependencies.verifySafePathBoundary(target, containmentRoot);
      try {
        await dependencies.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        // An exclusive-create collision proves this invocation never owned the
        // pre-existing temporary. Other write failures may occur after creation,
        // so capture that regular file before cleanup while preserving the
        // original write failure.
        if (!isNodeError(error) || error.code !== "EEXIST") {
          owner = await identifyOwnedFileAfterWriteFailure(
            temporary,
            containmentRoot,
            dependencies.captureSafeFileIdentity,
          );
        }
        throw error;
      }
      owner = await dependencies.captureSafeFileIdentity(temporary, containmentRoot);
      if (owner === undefined) throw new Error("unsafe_path_boundary");
      await dependencies.verifySafePathBoundary(temporary, containmentRoot);
      await dependencies.verifySafePathBoundary(target, containmentRoot);
      await dependencies.rename(temporary, target);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (owner !== undefined) {
        try {
          await dependencies.removeOwnedSafeFile(temporary, owner, containmentRoot);
        } catch (cleanupError) {
          if (primaryError === undefined) throw cleanupError;
        }
      }
    }
  };
}

export const atomicWriteFile = createAtomicWriteFile({
  randomUUID,
  writeFile,
  rename,
  verifySafePathBoundary,
  captureSafeFileIdentity,
  removeOwnedSafeFile,
});

async function identifyOwnedFileAfterWriteFailure(
  path: string,
  containmentRoot: string | undefined,
  captureIdentity: typeof captureSafeFileIdentity,
): Promise<OwnedFile | undefined> {
  try {
    return await captureIdentity(path, containmentRoot);
  } catch {
    return undefined;
  }
}

export async function captureSafeFileIdentity(
  path: string,
  containmentRoot?: string,
): Promise<SafeFileIdentity | undefined> {
  try {
    return await identifyOwnedFile(resolve(path), containmentRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function removeOwnedSafeFile(
  path: string,
  identity: SafeFileIdentity,
  containmentRoot?: string,
): Promise<void> {
  await cleanupOwnedFile(resolve(path), containmentRoot, identity);
}

export async function removeSafeFile(path: string, containmentRoot?: string): Promise<void> {
  const identity = await captureSafeFileIdentity(path, containmentRoot);
  if (identity !== undefined) await removeOwnedSafeFile(path, identity, containmentRoot);
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

export async function withPathLock<T>(path: string, work: () => Promise<T>, options: PathLockOptions = {}): Promise<T> {
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

async function acquireFileLock(
  path: string,
  root: string | undefined,
  timeoutMs?: number,
): Promise<() => Promise<void>> {
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
        // Normal owner release is handle-bound: the helper opens the leaf
        // once, re-reads its owner bytes through that same HANDLE, and deletes
        // only when the exact token is still proven there. There is no
        // token-read -> pathname rm path anywhere in this module.
        const release = await releaseOwnedPathLock(lockPath, owner.token);
        if (release.outcome !== "released") throw new Error(`durable_path_lock_release_failed:${release.reason}`);
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      // Never parse or reclaim a lock through a link/reparse point. A
      // malformed regular owner remains a barrier while fresh; only a stale,
      // identity-stable regular file or an old locally-dead valid owner can be
      // reclaimed, and only by reclaimStaleLock's evidence-based decision.
      await verifyLeaf(lockPath);
      const recovery = await reclaimStaleLock(lockPath);
      if (recovery.outcome === "unsafe") throw new Error("unsafe_path_boundary");
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

/**
 * Reclaims a stale lock file only through the fixed handle-bound Windows
 * helper, and only when the Host-side evidence proves it is a candidate. This
 * is a deep-module behavior, not a per-store cleanup: no durable Chat mutation
 * may rm a lock path itself.
 *
 * - A malformed/zero-byte owner record is a barrier while the file is fresh.
 * - After the frozen stale interval, the helper receives only the frozen
 *   `stale_malformed` selector; it independently opens the leaf no-follow,
 *   classifies the owner bytes through its retained HANDLE, waits the bounded
 *   frozen observation interval on that same HANDLE, re-queries file ID, size,
 *   mtime and ctime, re-reads the owner bytes, re-checks that the path still
 *   names the opened object, and only then applies a handle-bound disposition.
 * - A valid owner record keeps the existing rule: only old plus locally dead
 *   owners are candidates, selected as `stale_valid_dead`. The local dead-proof
 *   is only a policy predicate for choosing that selector, never identity
 *   evidence; the helper's opened-handle facts must agree with the selector.
 * - On non-Windows, when no capability is bound, or on any unavailable,
 *   unsupported or ambiguous helper outcome, the lock is kept and the caller
 *   fails closed. There is no POSIX stale reclaim.
 */
export async function reclaimStaleLock(lockPath: string): Promise<PathLockRecoveryResult> {
  const first = await observeLockFile(lockPath);
  if (first === undefined) return recoveryResult("kept", "lock_disappeared");
  if (!first.isRegularFile) return recoveryResult("unsafe", "reparse_or_link");
  const owner = await readLockOwnerIfPresent(lockPath);
  if (owner === "disappeared") return recoveryResult("kept", "lock_disappeared");
  let policy: WindowsStaleLockReclaimPolicy;
  if (owner !== null) {
    if (Date.now() - owner.createdAtMs < STALE_LOCK_MS) return recoveryResult("kept", "valid_owner_fresh");
    if (processAlive(owner.pid)) return recoveryResult("kept", "valid_owner_live");
    if (!staleByMtime(first)) return recoveryResult("kept", "valid_owner_fresh");
    policy = "stale_valid_dead";
  } else {
    // Malformed or zero-byte ownership: never infer an owner PID from the
    // bytes. Only a stale, unchanged regular file may even be presented to the
    // helper; a fresh residue stays a barrier.
    if (!staleByMtime(first)) return recoveryResult("kept", "malformed_fresh");
    policy = "stale_malformed";
  }
  const capability = await requestWindowsReclaimer();
  if (capability === undefined) return recoveryResult("kept", "windows_reclaimer_unavailable");
  let category: WindowsStaleLockReclaimCategory;
  try {
    category = await nativeReclaimStaleLock(capability, resolve(lockPath), policy);
  } catch {
    return recoveryResult("kept", "windows_reclaimer_unavailable");
  }
  return mapReclaimCategory(category, policy);
}

/**
 * Releases the current successful owner record through the fixed handle-bound
 * helper with exact token validation. `missing` is a vacuous success (there is
 * no lock left to release); every other non-released outcome fails closed so
 * the caller never believes a lock was released when it was not.
 */
export async function releaseOwnedPathLock(lockPath: string, token: string): Promise<PathLockReleaseResult> {
  const capability = await requestWindowsReclaimer();
  if (capability === undefined) return releaseResult("unavailable", "windows_reclaimer_unavailable");
  let category: WindowsStaleLockReleaseCategory;
  try {
    category = await nativeReleaseOwnedLock(capability, resolve(lockPath), token);
  } catch {
    return releaseResult("unavailable", "windows_reclaimer_unavailable");
  }
  switch (category) {
    case "released": return releaseResult("released", "exact_token_released");
    case "missing": return releaseResult("released", "lock_already_missing");
    case "kept_token_mismatch": return releaseResult("kept", "token_mismatch");
    case "kept_not_regular": return releaseResult("kept", "not_regular");
    case "indeterminate": return releaseResult("unavailable", "windows_reclaimer_unavailable");
  }
}

function mapReclaimCategory(category: WindowsStaleLockReclaimCategory, policy: WindowsStaleLockReclaimPolicy): PathLockRecoveryResult {
  switch (category) {
    case "reclaimed":
      return recoveryResult("reclaimed", policy === "stale_valid_dead" ? "valid_owner_stale_and_dead" : "malformed_stale_identity_stable");
    case "missing": return recoveryResult("kept", "lock_disappeared");
    case "kept_malformed_fresh": return recoveryResult("kept", "malformed_fresh");
    case "kept_valid_fresh": return recoveryResult("kept", "valid_owner_fresh");
    case "kept_policy_mismatch": return recoveryResult("kept", "identity_changed_during_observation");
    case "kept_identity_changed": return recoveryResult("kept", "identity_changed_during_observation");
    case "kept_path_replaced": return recoveryResult("kept", "identity_changed_during_observation");
    case "kept_not_regular": return recoveryResult("unsafe", "reparse_or_link");
    case "indeterminate": return recoveryResult("kept", "windows_reclaimer_unavailable");
  }
}

type LockFileObservation = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isRegularFile: boolean;
}>;

async function observeLockFile(lockPath: string): Promise<LockFileObservation | undefined> {
  try {
    const stat = await lstat(lockPath, { bigint: true });
    return Object.freeze({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      isRegularFile: stat.isFile() && !stat.isSymbolicLink(),
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function staleByMtime(observation: LockFileObservation): boolean {
  return Date.now() - Number(observation.mtimeNs / 1_000_000n) >= STALE_LOCK_MS;
}

function recoveryResult(outcome: PathLockRecoveryResult["outcome"], reason: PathLockRecoveryResult["reason"]): PathLockRecoveryResult {
  return Object.freeze({ outcome, reason });
}

function releaseResult(outcome: PathLockReleaseResult["outcome"], reason: PathLockReleaseResult["reason"]): PathLockReleaseResult {
  return Object.freeze({ outcome, reason });
}

/** ENOENT is a retryable disappearance, not malformed ownership. */
async function readLockOwnerIfPresent(lockPath: string): Promise<LockOwner | "disappeared" | null> {
  try {
    return await readLockOwner(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "disappeared";
    throw error;
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

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    return parseOwner(await readStrictJsonFile(lockPath));
  } catch (error) {
    // Lock-owner contents are untrusted coordination state. A malformed,
    // duplicate-key, or unstable read is a barrier rather than a parser error
    // exposed to the caller; only disappearance permits another retry.
    if (isNodeError(error) && error.code === "ENOENT") throw error;
    return null;
  }
}

function parseOwner(value: unknown): LockOwner | null {
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
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
