import assert from "node:assert/strict";
import { link, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupTestArtifactLock,
  readTestArtifactLock,
  serializeRecord,
  withTestArtifactLock,
} from "./test-artifact-lock.mjs";

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
    (error) => error.message === "host_test_artifact_already_in_use",
  );
  assert.deepEqual(await readTestArtifactLock(path), owner);
});

test("an unknown owner is not reclaimed, while a proven dead owner is reclaimed", async () => {
  const unknownPath = await temporaryLock();
  const unknownOwner = await writeLock(unknownPath);
  await assert.rejects(
    withTestArtifactLock(async () => {}, { lockPath: unknownPath, processProbe: async () => "unknown" }),
    (error) => error.message === "host_test_artifact_already_in_use",
  );
  assert.deepEqual(await readTestArtifactLock(unknownPath), unknownOwner);

  const deadPath = await temporaryLock();
  await writeLock(deadPath);
  let ran = false;
  await withTestArtifactLock(async () => { ran = true; }, { lockPath: deadPath, processProbe: async () => "dead" });
  assert.equal(ran, true);
  assert.equal(await readTestArtifactLock(deadPath), undefined);
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
