import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  type AtomicWriteFileDependencies,
  bindWindowsStaleLockReclaimer,
  captureSafeFileIdentity,
  createAtomicWriteFile,
  type PathLockRecoveryResult,
  pathLockPath,
  readSafeDirectory,
  reclaimStaleLock,
  releaseOwnedPathLock,
  removeOwnedSafeFile,
  verifySafePathBoundary,
  withPathLock,
} from "./path-lock.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";
import type { WindowsStaleLockReclaimerCapability } from "./windows-stale-lock-reclaimer/internal.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const STALE_LOCK_MS = 5 * 60_000;
const staleAgo = () => new Date(Date.now() - 6 * 60_000);
const staleOwner = (pid: number, createdAtMs = Date.now() - 6 * 60_000) =>
  JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", pid, createdAtMs });

async function makeStale(path: string) {
  await utimes(path, staleAgo(), staleAgo());
}

function atomicWriterWithFilesystemFaults(
  overrides: Partial<AtomicWriteFileDependencies>,
  randomUUID = () => "00000000-0000-4000-8000-000000000000",
) {
  return createAtomicWriteFile({
    randomUUID,
    writeFile,
    rename,
    verifySafePathBoundary,
    captureSafeFileIdentity,
    removeOwnedSafeFile,
    ...overrides,
  });
}

type SimulatedReclaimerRequest = Readonly<{
  schemaVersion: 1;
  operation: "reclaim_stale_lock" | "release_owned_lock";
  policy?: "stale_malformed" | "stale_valid_dead";
  token?: string;
  root: string;
  segments: readonly string[];
}>;
type SimulatedOwner = Readonly<{ token: string; pid: number; createdAtMs: number }>;
type SimulatedObservation = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isRegularFile: boolean;
}>;

/**
 * Test-only simulated native reclaimer. It mirrors the frozen helper behavior
 * closely enough to exercise the Host lock policy end to end: open-time
 * classification through the current path bytes, a bounded retained-handle
 * observation window with a deterministic hook, a final identity re-check, and
 * a delete only when everything still proves the opened object. Real
 * handle-bound evidence comes exclusively from the emitted Windows live gate.
 */
const SIMULATED_OBSERVATION_MS = 30;
let simulatedBeforeRecheck: ((request: SimulatedReclaimerRequest) => Promise<void> | void) | undefined;

async function simulateNativeReclaimer(request: SimulatedReclaimerRequest): Promise<string> {
  // The frozen root/segments request carries no pathname; the simulated
  // helper reconstructs the exact absolute fixture path from the tuple, the
  // same way the native helper resolves it from its retained root HANDLE.
  const absolute = resolve(request.root, ...request.segments);
  if (request.operation === "release_owned_lock") {
    const current = await readSimulatedOwner(absolute);
    if (current === "missing") return "missing";
    if (current !== null && current.token === request.token) {
      await rm(absolute, { force: true });
      return "released";
    }
    return "kept_token_mismatch";
  }
  let opened: SimulatedObservation;
  try {
    opened = await observeSimulated(absolute);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    return "indeterminate";
  }
  if (!opened.isRegularFile) return "kept_not_regular";
  const bytes = await readFile(absolute);
  const classified = classifySimulatedOwner(bytes);
  if (request.policy === "stale_malformed") {
    if (classified.kind !== "malformed" && classified.kind !== "zero") return "kept_policy_mismatch";
    if (Date.now() - Number(opened.mtimeNs / 1_000_000n) < STALE_LOCK_MS) return "kept_malformed_fresh";
  } else {
    if (classified.kind !== "valid") return "kept_policy_mismatch";
    if (Date.now() - classified.owner!.createdAtMs < STALE_LOCK_MS) return "kept_valid_fresh";
    if (Date.now() - Number(opened.mtimeNs / 1_000_000n) < STALE_LOCK_MS) return "kept_valid_fresh";
  }
  await delay(SIMULATED_OBSERVATION_MS);
  await simulatedBeforeRecheck?.(request);
  let current: SimulatedObservation;
  try {
    current = await observeSimulated(absolute);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "kept_path_replaced";
    return "indeterminate";
  }
  if (!current.isRegularFile) return "kept_not_regular";
  if (!sameSimulatedFacts(opened, current)) return "kept_identity_changed";
  if (!(await readFile(absolute)).equals(bytes)) return "kept_identity_changed";
  await rm(absolute, { force: true });
  return "reclaimed";
}

async function observeSimulated(path: string): Promise<SimulatedObservation> {
  const stat = await lstat(path, { bigint: true });
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    isRegularFile: stat.isFile() && !stat.isSymbolicLink(),
  });
}

function sameSimulatedFacts(left: SimulatedObservation, right: SimulatedObservation): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readSimulatedOwner(path: string): Promise<SimulatedOwner | "missing" | null> {
  try {
    return classifySimulatedOwner(await readFile(path)).owner;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    return null;
  }
}

function classifySimulatedOwner(bytes: Buffer): { kind: "valid" | "malformed" | "zero"; owner: SimulatedOwner | null } {
  if (bytes.length === 0) return { kind: "zero", owner: null };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { kind: "malformed", owner: null };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "malformed", owner: null };
  const record = value as Record<string, unknown>;
  const valid =
    typeof record.token === "string" &&
    /^[0-9a-f-]{36}$/i.test(record.token) &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    typeof record.createdAtMs === "number" &&
    Number.isSafeInteger(record.createdAtMs);
  return valid
    ? {
        kind: "valid",
        owner: Object.freeze({
          token: record.token as string,
          pid: record.pid as number,
          createdAtMs: record.createdAtMs as number,
        }),
      }
    : { kind: "malformed", owner: null };
}

function simulatedReclaimerSpawn(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString("utf8")) as SimulatedReclaimerRequest;
    void (async () => {
      let result: string;
      try {
        result = await simulateNativeReclaimer(request);
      } catch {
        result = "indeterminate";
      }
      child.stdout.end(`{"schemaVersion":1,"result":"${result}"}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })();
  });
  return child as unknown as ChildProcess;
}

function bindSimulated(): void {
  simulatedBeforeRecheck = undefined;
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedReclaimerSpawn));
}

/** Scripted capability: every request answers with one fixed category and may
 * observe the exact request bytes (for release token and policy assertions). */
function scriptedReclaimer(
  category: string,
  onRequest?: (request: SimulatedReclaimerRequest) => Promise<void> | void,
): WindowsStaleLockReclaimerCapability {
  return createTestWindowsStaleLockReclaimer(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as SimulatedReclaimerRequest;
      void (async () => {
        try {
          await onRequest?.(request);
        } catch {
          // A scripting error must fail closed, never synthesize a reclaim.
          child.stdout.end('{"schemaVersion":1,"result":"indeterminate"}\n');
          child.stderr.end();
          queueMicrotask(() => child.emit("close", 0, null));
          return;
        }
        child.stdout.end(`{"schemaVersion":1,"result":"${category}"}\n`);
        child.stderr.end();
        queueMicrotask(() => child.emit("close", 0, null));
      })();
    });
    return child as unknown as ChildProcess;
  });
}

test("atomic writer refuses a pre-existing temporary and leaves it owned by its creator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-atomic-write-"));
  const path = join(directory, "artifact.json");
  const uuid = "00000000-0000-4000-8000-000000000001";
  const temporary = `${path}.${process.pid}.${uuid}.tmp`;
  try {
    await writeFile(temporary, "other writer", "utf8");
    await assert.rejects(atomicWriterWithFilesystemFaults({}, () => uuid)(path, "ours", directory), { code: "EEXIST" });
    assert.equal(await readFile(temporary, "utf8"), "other writer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic writer preserves a substituted temporary identity after rename failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-atomic-write-"));
  const path = join(directory, "artifact.json");
  const uuid = "00000000-0000-4000-8000-000000000002";
  const temporary = `${path}.${process.pid}.${uuid}.tmp`;
  const renameFailure = new Error("rename failed");
  try {
    await assert.rejects(
      atomicWriterWithFilesystemFaults(
        {
          rename: async () => {
            await rm(temporary);
            await writeFile(temporary, "substituted writer", "utf8");
            throw renameFailure;
          },
        },
        () => uuid,
      )(path, "ours", directory),
      (error) => error === renameFailure,
    );
    assert.equal(await readFile(temporary, "utf8"), "substituted writer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic writer cleans its original temporary when rename fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-atomic-write-"));
  const path = join(directory, "artifact.json");
  const uuid = "00000000-0000-4000-8000-000000000003";
  const temporary = `${path}.${process.pid}.${uuid}.tmp`;
  const renameFailure = new Error("rename failed");
  try {
    await assert.rejects(
      atomicWriterWithFilesystemFaults(
        {
          rename: async () => {
            throw renameFailure;
          },
        },
        () => uuid,
      )(path, "ours", directory),
      (error) => error === renameFailure,
    );
    await assert.rejects(lstat(temporary), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic writer preserves a primary write failure when temporary cleanup fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-atomic-write-"));
  const path = join(directory, "artifact.json");
  const _uuid = "00000000-0000-4000-8000-000000000004";
  const writeFailure = new Error("write failed");
  const cleanupFailure = new Error("cleanup failed");
  try {
    await assert.rejects(
      atomicWriterWithFilesystemFaults({
        writeFile: async (...args: Parameters<typeof writeFile>) => {
          await writeFile(...args);
          throw writeFailure;
        },
        removeOwnedSafeFile: async () => {
          throw cleanupFailure;
        },
      })(path, "ours", directory),
      (error) => error === writeFailure,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic writer preserves a primary rename failure when temporary cleanup fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-atomic-write-"));
  const path = join(directory, "artifact.json");
  const renameFailure = new Error("rename failed");
  const cleanupFailure = new Error("cleanup failed");
  try {
    await assert.rejects(
      atomicWriterWithFilesystemFaults({
        rename: async () => {
          throw renameFailure;
        },
        removeOwnedSafeFile: async () => {
          throw cleanupFailure;
        },
      })(path, "ours", directory),
      (error) => error === renameFailure,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic writer preserves a substituted temporary after its captured identity changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-safe-remove-"));
  const path = join(directory, "journal.json");
  const temporary = `${path}.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`;
  try {
    await assert.rejects(
      atomicWriterWithFilesystemFaults({
        rename: async () => {
          throw new Error("rename failed");
        },
        captureSafeFileIdentity: async (candidate, root) => {
          const identity = await captureSafeFileIdentity(candidate, root);
          if (candidate === temporary && identity !== undefined) {
            await rm(candidate);
            await writeFile(candidate, "substituted", "utf8");
          }
          return identity;
        },
      })(path, "ours", directory),
      /rename failed/,
    );
    assert.equal(await readFile(temporary, "utf8"), "substituted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock serializes local callers and removes its ownership file", async () => {
  bindSimulated();
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-"));
  const path = join(directory, "artifact.json");
  const order: string[] = [];
  const first = withPathLock(path, async () => {
    order.push("first-start");
    await delay(15);
    order.push("first-end");
  });
  await delay(1);
  const second = withPathLock(path, async () => {
    order.push("second");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  await assert.rejects(readFile(pathLockPath(path), "utf8"), { code: "ENOENT" });
});

test("path lock rejects a symlink parent before creating its lock directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-symlink-"));
  const realParent = join(directory, "real");
  const linkedParent = join(directory, "linked");
  const path = join(linkedParent, "nested", "artifact.json");
  await mkdir(realParent);
  try {
    try {
      await symlink(realParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(
      withPathLock(path, async () => undefined),
      /unsafe_path_boundary/,
    );
    await assert.rejects(lstat(join(realParent, "nested")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock rejects a parent replaced with a symlink before acquisition", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-replaced-"));
  const parent = join(directory, "parent");
  const moved = join(directory, "moved");
  const path = join(parent, "artifact.json");
  await mkdir(parent);
  await rename(parent, moved);
  try {
    try {
      await symlink(moved, parent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(
      withPathLock(path, async () => undefined),
      /unsafe_path_boundary/,
    );
    await assert.rejects(lstat(pathLockPath(path)), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock refuses a malformed existing cross-process owner instead of writing unlocked", async () => {
  bindSimulated();
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-"));
  try {
    const path = join(directory, "artifact.json");
    await writeFile(pathLockPath(path), "not-json", "utf8");
    await assert.rejects(
      withPathLock(path, async () => undefined, { timeoutMs: 25 }),
      /durable_path_lock_timeout/,
    );
    assert.equal(await readFile(pathLockPath(path), "utf8"), "not-json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock treats duplicate decoded owner keys as an unrecoverable barrier", async () => {
  bindSimulated();
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-duplicate-owner-"));
  const staleOwner = '"token":"00000000-0000-4000-8000-000000000000","pid":999999999,"createdAtMs":0';
  const cases = [`{${staleOwner},"cr\\u0065atedAtMs":0}`, `{${staleOwner},"ignored":{"key":1,"k\\u0065y":2}}`];
  try {
    for (const contents of cases) {
      const path = join(directory, `${cases.indexOf(contents)}.json`);
      const lockPath = pathLockPath(path);
      await writeFile(lockPath, contents, "utf8");
      await assert.rejects(
        withPathLock(path, async () => undefined, { timeoutMs: 25 }),
        { message: "durable_path_lock_timeout" },
      );
      assert.equal(await readFile(lockPath, "utf8"), contents);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock keeps a fresh zero-byte crash residue as a barrier until timeout", async () => {
  bindSimulated();
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-zero-fresh-"));
  const path = join(directory, "artifact.json");
  const lockPath = pathLockPath(path);
  try {
    await writeFile(lockPath, Buffer.alloc(0));
    await assert.rejects(
      withPathLock(path, async () => undefined, { timeoutMs: 25 }),
      { message: "durable_path_lock_timeout" },
    );
    assert.equal((await readFile(lockPath)).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock reclaims a stale zero-byte crash residue through the shared recovery rule", async () => {
  bindSimulated();
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-zero-stale-"));
  const path = join(directory, "artifact.json");
  const lockPath = pathLockPath(path);
  let ran = false;
  try {
    await writeFile(lockPath, Buffer.alloc(0));
    await makeStale(lockPath);
    await withPathLock(path, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock reclaims stale malformed crash residue but never a fresh one", async () => {
  bindSimulated();
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-malformed-stale-"));
  const freshPath = join(directory, "fresh.json");
  const stalePath = join(directory, "stale.json");
  const swappedPath = join(directory, "swapped.json");
  try {
    await writeFile(pathLockPath(freshPath), "partial write", "utf8");
    const fresh = await reclaimStaleLock(pathLockPath(freshPath));
    assert.deepEqual(fresh, { outcome: "kept", reason: "malformed_fresh" });

    await writeFile(pathLockPath(stalePath), "partial write", "utf8");
    await makeStale(pathLockPath(stalePath));
    const stale = await reclaimStaleLock(pathLockPath(stalePath));
    assert.deepEqual(stale, { outcome: "reclaimed", reason: "malformed_stale_identity_stable" });
    await assert.rejects(lstat(pathLockPath(stalePath)), { code: "ENOENT" });

    // A swap during the simulated retained-handle observation window is never
    // reclaimed and the replacement survives byte-identically.
    await writeFile(pathLockPath(swappedPath), "partial write", "utf8");
    await makeStale(pathLockPath(swappedPath));
    simulatedBeforeRecheck = async (request) => {
      if (resolve(request.root, ...request.segments) === pathLockPath(swappedPath)) {
        await writeFile(pathLockPath(swappedPath), "a different-length replacement", "utf8");
      }
    };
    const swapped = await reclaimStaleLock(pathLockPath(swappedPath));
    assert.deepEqual(swapped, { outcome: "kept", reason: "identity_changed_during_observation" });
    assert.equal(await readFile(pathLockPath(swappedPath), "utf8"), "a different-length replacement");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock reclaims only a stale locally-dead valid owner and keeps live or fresh ones", async () => {
  bindSimulated();
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-owner-rule-"));
  try {
    const dead = join(directory, "dead.json");
    const live = join(directory, "live.json");
    const fresh = join(directory, "fresh.json");
    await writeFile(pathLockPath(dead), staleOwner(999_999_999), "utf8");
    await makeStale(pathLockPath(dead));
    assert.deepEqual(await reclaimStaleLock(pathLockPath(dead)), {
      outcome: "reclaimed",
      reason: "valid_owner_stale_and_dead",
    });
    await assert.rejects(lstat(pathLockPath(dead)), { code: "ENOENT" });

    // A stale owner whose PID is locally alive stays a barrier and never even
    // reaches the capability: the Host dead-proof gates the selector.
    const liveOwner = staleOwner(process.pid);
    await writeFile(pathLockPath(live), liveOwner, "utf8");
    await makeStale(pathLockPath(live));
    assert.deepEqual(await reclaimStaleLock(pathLockPath(live)), { outcome: "kept", reason: "valid_owner_live" });
    assert.equal(await readFile(pathLockPath(live), "utf8"), liveOwner);

    // A fresh owner stays a barrier regardless of the pid it names.
    await writeFile(pathLockPath(fresh), staleOwner(999_999_999, Date.now()), "utf8");
    assert.deepEqual(await reclaimStaleLock(pathLockPath(fresh)), { outcome: "kept", reason: "valid_owner_fresh" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock refuses to reclaim an active writer and never deletes a reparse lock entry", async (t) => {
  bindSimulated();
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-reparse-"));
  const outside = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-reparse-outside-"));
  const path = join(directory, "artifact.json");
  const lockPath = pathLockPath(path);
  try {
    // An active writer touches its lock file during the write: a fresh mtime
    // keeps the malformed residue a barrier even after a stale interval.
    await writeFile(lockPath, "partial", "utf8");
    await makeStale(lockPath);
    await writeFile(lockPath, "partial", "utf8");
    assert.deepEqual(await reclaimStaleLock(lockPath), { outcome: "kept", reason: "malformed_fresh" });

    // A reparse point at the lock path fails closed and is never unlinked.
    await rm(lockPath, { force: true });
    try {
      await symlink(outside, lockPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    assert.deepEqual(await reclaimStaleLock(lockPath), { outcome: "unsafe", reason: "reparse_or_link" });
    await assert.rejects(
      withPathLock(path, async () => undefined),
      /unsafe_path_boundary/,
    );
    const stat = await lstat(lockPath);
    assert.equal(stat.isSymbolicLink() || !stat.isFile(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("path lock keeps a stale candidate and never deletes when the reclaimer capability is unavailable", async () => {
  bindWindowsStaleLockReclaimer(undefined);
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-unavailable-"));
  const path = join(directory, "artifact.json");
  const lockPath = pathLockPath(path);
  try {
    await writeFile(lockPath, "partial write", "utf8");
    await makeStale(lockPath);
    assert.deepEqual(await reclaimStaleLock(lockPath), { outcome: "kept", reason: "windows_reclaimer_unavailable" });
    assert.equal(await readFile(lockPath, "utf8"), "partial write");
    await assert.rejects(
      withPathLock(path, async () => undefined, { timeoutMs: 25 }),
      { message: "durable_path_lock_timeout" },
    );
    assert.equal(await readFile(lockPath, "utf8"), "partial write");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal owner release fails closed without a reclaimer capability", async () => {
  bindWindowsStaleLockReclaimer(undefined);
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-release-unavailable-"));
  const path = join(directory, "artifact.json");
  try {
    await assert.rejects(
      withPathLock(path, async () => "work-completed"),
      /durable_path_lock_release_failed:windows_reclaimer_unavailable/,
    );
    const owner = await readFile(pathLockPath(path), "utf8");
    assert.match(owner, /"token":"[0-9a-f-]{36}"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal withPathLock use fails closed at release on non-Windows without any capability binding", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows production locking mints the fixed helper pair; this documents the non-Windows default");
    return;
  }
  // No fake and no explicit binding: on non-Windows the fixed default request
  // can never mint a capability, which is exactly the fail-closed outcome an
  // explicit disable reproduces deterministically.
  bindWindowsStaleLockReclaimer(undefined);
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-posix-default-"));
  const path = join(directory, "artifact.json");
  try {
    let workRan = false;
    await assert.rejects(
      withPathLock(path, async () => {
        workRan = true;
      }),
      /durable_path_lock_release_failed:windows_reclaimer_unavailable/,
    );
    // The caller's work did run; only the handle-bound release is unavailable.
    assert.equal(workRan, true);
    const lockPath = pathLockPath(path);
    const owner = await readFile(lockPath, "utf8");
    assert.match(owner, /"token":"[0-9a-f-]{36}"/);
    // The owner lock is never deleted on non-Windows (no POSIX deletion
    // fallback exists) and therefore becomes the design-mandated stale-lock
    // barrier for every later acquisition.
    await assert.rejects(
      withPathLock(path, async () => undefined, { timeoutMs: 25 }),
      { message: "durable_path_lock_timeout" },
    );
    assert.equal(await readFile(lockPath, "utf8"), owner);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock maps every native reclaim category to the typed recovery result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-mapping-"));
  const malformedPath = join(directory, "malformed.json");
  const validPath = join(directory, "valid.json");
  try {
    const cases: ReadonlyArray<{
      category: string;
      policy: "stale_malformed" | "stale_valid_dead";
      path: string;
      expected: PathLockRecoveryResult;
    }> = [
      {
        category: "reclaimed",
        policy: "stale_malformed",
        path: malformedPath,
        expected: { outcome: "reclaimed", reason: "malformed_stale_identity_stable" },
      },
      {
        category: "reclaimed",
        policy: "stale_valid_dead",
        path: validPath,
        expected: { outcome: "reclaimed", reason: "valid_owner_stale_and_dead" },
      },
      {
        category: "missing",
        policy: "stale_malformed",
        path: malformedPath,
        expected: { outcome: "kept", reason: "lock_disappeared" },
      },
      {
        category: "kept_malformed_fresh",
        policy: "stale_malformed",
        path: malformedPath,
        expected: { outcome: "kept", reason: "malformed_fresh" },
      },
      {
        category: "kept_valid_fresh",
        policy: "stale_valid_dead",
        path: validPath,
        expected: { outcome: "kept", reason: "valid_owner_fresh" },
      },
      {
        category: "kept_policy_mismatch",
        policy: "stale_malformed",
        path: malformedPath,
        expected: { outcome: "kept", reason: "identity_changed_during_observation" },
      },
      {
        category: "kept_identity_changed",
        policy: "stale_malformed",
        path: malformedPath,
        expected: { outcome: "kept", reason: "identity_changed_during_observation" },
      },
      {
        category: "kept_path_replaced",
        policy: "stale_malformed",
        path: malformedPath,
        expected: { outcome: "kept", reason: "identity_changed_during_observation" },
      },
      {
        category: "kept_not_regular",
        policy: "stale_malformed",
        path: malformedPath,
        expected: { outcome: "unsafe", reason: "reparse_or_link" },
      },
      {
        category: "indeterminate",
        policy: "stale_malformed",
        path: malformedPath,
        expected: { outcome: "kept", reason: "windows_reclaimer_unavailable" },
      },
    ];
    for (const entry of cases) {
      bindWindowsStaleLockReclaimer(scriptedReclaimer(entry.category));
      await writeFile(
        pathLockPath(entry.path),
        entry.policy === "stale_malformed" ? "partial write" : staleOwner(999_999_999),
        "utf8",
      );
      await makeStale(pathLockPath(entry.path));
      assert.deepEqual(await reclaimStaleLock(pathLockPath(entry.path)), entry.expected, entry.category);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release requires the exact owner token through the capability and fails closed on mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-release-token-"));
  const path = join(directory, "artifact.json");
  const lockPath = pathLockPath(path);
  const token = "00000000-0000-4000-8000-000000000000";
  const ownerRecord = JSON.stringify({ token, pid: 1234, createdAtMs: Date.now() });
  try {
    // The capability observes the request token and the current bytes; only an
    // exact match may produce "released".
    const seen: SimulatedReclaimerRequest[] = [];
    bindWindowsStaleLockReclaimer(
      scriptedReclaimer("released", async (request) => {
        seen.push(request);
      }),
    );
    await writeFile(lockPath, ownerRecord, "utf8");
    assert.deepEqual(await releaseOwnedPathLock(lockPath, token), {
      outcome: "released",
      reason: "exact_token_released",
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.token, token);
    assert.equal(resolve(seen[0]!.root, ...seen[0]!.segments), resolve(lockPath));
    assert.equal(seen[0]!.root, process.platform === "win32" ? `${resolve(lockPath).slice(0, 2)}\\` : "/");

    // A mismatched token keeps the lock and the caller fails closed.
    bindWindowsStaleLockReclaimer(scriptedReclaimer("kept_token_mismatch"));
    assert.deepEqual(await releaseOwnedPathLock(lockPath, "11111111-1111-4111-8111-111111111111"), {
      outcome: "kept",
      reason: "token_mismatch",
    });
    assert.equal(await readFile(lockPath, "utf8"), ownerRecord);

    // A disappeared lock is a vacuous release success, never a barrier.
    bindWindowsStaleLockReclaimer(scriptedReclaimer("missing"));
    assert.deepEqual(await releaseOwnedPathLock(lockPath, token), {
      outcome: "released",
      reason: "lock_already_missing",
    });
    assert.equal(await readFile(lockPath, "utf8"), ownerRecord);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock recovery result type is a frozen named tuple and reports disappearance", async () => {
  bindSimulated();
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-result-"));
  const path = join(directory, "artifact.json");
  try {
    await writeFile(pathLockPath(path), "partial", "utf8");
    await makeStale(pathLockPath(path));
    const result: PathLockRecoveryResult = await reclaimStaleLock(pathLockPath(path));
    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.outcome, "reclaimed");
    const missing: PathLockRecoveryResult = await reclaimStaleLock(pathLockPath(join(directory, "absent.json")));
    assert.deepEqual(missing, { outcome: "kept", reason: "lock_disappeared" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe directory enumeration rejects linked entries before returning them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-safe-directory-"));
  const outside = await mkdtemp(join(tmpdir(), "gamebuddy-safe-directory-outside-"));
  try {
    await writeFile(join(directory, "valid.json"), "ok", "utf8");
    try {
      await symlink(outside, join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(readSafeDirectory(directory, directory), /unsafe_path_boundary/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
