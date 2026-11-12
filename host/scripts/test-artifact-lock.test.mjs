import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cleanupTestArtifactLock,
  probeTestArtifactLockOwner,
  readTestArtifactLock,
  serializeRecord,
  withTestArtifactLock,
} from "./test-artifact-lock.mjs";

const lockProtocolWorker = resolve(dirname(fileURLToPath(import.meta.url)), "test-artifact-protocol-worker.mjs");
/**
 * The Node a child of this suite must run under. `process.execPath` is bun when the suite itself is launched by
 * bun, and a bun child cannot run this worker's module graph; the coordinator publishes the resolved Node as
 * `GAMEBUDDY_HOST_TEST_NODE` for exactly that reason.
 */
const testNode = process.env.GAMEBUDDY_HOST_TEST_NODE ?? process.execPath;

async function temporaryLock() {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-artifact-lock-"));
  return join(directory, "lock");
}

function record(overrides = {}) {
  return {
    version: 1,
    pid: 987654,
    processStartIdentity: "test:owner-start",
    ownerToken: "0123456789abcdef0123456789abcdef",
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

async function writeLock(path, value = record()) {
  await writeFile(path, serializeRecord(value), { mode: 0o600 });
  return value;
}

async function untilFileExists(path) {
  for (const deadline = Date.now() + 10_000; ; ) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (Date.now() > deadline) throw new Error(`test_fixture_never_appeared:${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

/**
 * A record whose owner has provably exited. The shared probe is polled instead of trusting the child's exit
 * event: the reclaim rule acts on the probe's answer, so the fixture waits for the answer the rule will read
 * rather than for the event that usually precedes it.
 */
async function deadOwnerRecord() {
  const child = spawn(testNode, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "exit");
  const owner = record({ pid, processStartIdentity: `unverified:${process.platform}` });
  for (const deadline = Date.now() + 5_000; ; ) {
    if (await probeTestArtifactLockOwner(owner) === "dead") return owner;
    if (Date.now() > deadline) throw new Error(`test_fixture_owner_still_reachable:pid=${pid}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

/**
 * A genuinely live owner: the protocol worker acquires this lock through the production path and holds it until
 * `releasePath` appears, so the contender below meets a real live pid rather than a probe answer injected to
 * say so.
 */
async function holdLockWithLiveChild(lockPath) {
  const readyPath = `${lockPath}.ready`;
  const releasePath = `${lockPath}.release`;
  const child = spawn(testNode, [lockProtocolWorker, "holder", lockPath, readyPath, releasePath], { stdio: "ignore" });
  try {
    await untilFileExists(readyPath);
  } catch (error) {
    child.kill();
    throw error;
  }
  return Object.freeze({
    pid: child.pid,
    async release() {
      await writeFile(releasePath, "release", "utf8");
      await once(child, "exit");
    },
  });
}

test("normal ownership writes an owner record and cleans up only its lock", async () => {
  const path = await temporaryLock();
  await withTestArtifactLock(async () => {
    const owner = await readTestArtifactLock(path);
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.ownerToken, undefined);
    assert.equal((await stat(path)).isFile(), true);
  }, { lockPath: path });
  assert.equal(await readTestArtifactLock(path), undefined);
});

test("a live lock is rejected and preserved", async () => {
  const path = await temporaryLock();
  const owner = await writeLock(path);
  await assert.rejects(
    withTestArtifactLock(async () => {}, { lockPath: path, processProbe: async () => "alive" }),
    (error) => error.message === `host_test_artifact_already_in_use:${path}:pid=${owner.pid}:owner_state=alive`,
  );
  assert.deepEqual(await readTestArtifactLock(path), owner);
});

/**
 * The two refusals a readable record can produce are different situations with different next steps, so the
 * message carries which one it is. This is the branch a bare `host_test_artifact_already_in_use` left a reader
 * to guess at, and guessing "stranded lock" is what invites deleting a file whose owner is building.
 */
test("an unknown owner is not reclaimed, while a proven dead owner is reclaimed", async () => {
  const unknownPath = await temporaryLock();
  const unknownOwner = await writeLock(unknownPath);
  await assert.rejects(
    withTestArtifactLock(async () => {}, { lockPath: unknownPath, processProbe: async () => "unknown" }),
    (error) =>
      error.message ===
      `host_test_artifact_already_in_use:${unknownPath}:pid=${unknownOwner.pid}:owner_state=unknown`,
  );
  assert.deepEqual(await readTestArtifactLock(unknownPath), unknownOwner);

  const deadPath = await temporaryLock();
  await writeLock(deadPath);
  let ran = false;
  await withTestArtifactLock(async () => { ran = true; }, { lockPath: deadPath, processProbe: async () => "dead" });
  assert.equal(ran, true);
  assert.equal(await readTestArtifactLock(deadPath), undefined);
});

/**
 * The rule above was only ever exercised through a probe injected to answer "dead", which proves the wiring and
 * says nothing about whether a real exit is provable on this platform - the question a developer asks when a
 * lock outlives its process. This drives the module's own probe, unmocked.
 */
test("a record whose owner is provably dead is reclaimed by a fresh acquisition", async () => {
  const path = await temporaryLock();
  const owner = await writeLock(path, await deadOwnerRecord());
  let acquired = false;
  await withTestArtifactLock(async () => { acquired = true; }, { lockPath: path });
  assert.equal(acquired, true, `the lock naming dead pid ${owner.pid} was not reclaimed`);
  assert.equal(await readTestArtifactLock(path), undefined);
});

test("a lock held by a live child is refused, and the refusal names that owner", async () => {
  const path = await temporaryLock();
  const holder = await holdLockWithLiveChild(path);
  try {
    const owner = await readTestArtifactLock(path);
    assert.equal(owner.pid, holder.pid);
    await assert.rejects(
      withTestArtifactLock(async () => assert.fail("a live owner's lock must not be taken"), { lockPath: path }),
      (error) =>
        error.message === `host_test_artifact_already_in_use:${path}:pid=${holder.pid}:owner_state=alive`,
    );
    assert.deepEqual(await readTestArtifactLock(path), owner);
  } finally {
    await holder.release();
  }
});

test("malformed lock data fails closed and is not removed", async () => {
  const path = await temporaryLock();
  await writeFile(path, "", { mode: 0o600 });
  await assert.rejects(
    withTestArtifactLock(async () => {}, { lockPath: path, processProbe: async () => "dead" }),
    (error) => error.message === "host_test_artifact_already_in_use",
  );
  assert.equal(await readFile(path, "utf8"), "");
});

test("cleanup cannot delete a replacement lock installed during quarantine", async () => {
  const path = await temporaryLock();
  const original = record();
  await writeLock(path, original);
  const replacement = record({ ownerToken: "fedcba9876543210fedcba9876543210" });
  let renamed = false;
  const removed = await cleanupTestArtifactLock(path, original, {
    processProbe: async () => "dead",
    renameFile: async (from, to) => {
      await (await import("node:fs/promises")).rename(from, to);
      renamed = true;
      await writeLock(path, replacement);
    },
  });
  assert.equal(removed, true);
  assert.equal(renamed, true);
  assert.deepEqual(await readTestArtifactLock(path), replacement);
});

test("a publication error after a zero-byte candidate is cleaned by exact inode and never persists", async () => {
  const path = await temporaryLock();
  let injected = true;
  await withTestArtifactLock(async () => {
    const owner = await readTestArtifactLock(path);
    assert.equal(owner.version, 1);
    assert.notEqual((await stat(path)).size, 0);
  }, {
    lockPath: path,
    linkFile: async (from, to) => {
      await link(from, to);
      if (!injected) return;
      injected = false;
      // Simulate the Windows publication race: the destination has become
      // visible, but the failed contender observes malformed bytes.
      await writeFile(to, "", "utf8");
      const error = new Error("simulated_link_race");
      error.code = "EEXIST";
      throw error;
    },
  });
  assert.equal(injected, false);
  assert.equal(await readTestArtifactLock(path), undefined);
});
