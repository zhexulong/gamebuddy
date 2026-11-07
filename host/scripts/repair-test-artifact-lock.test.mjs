import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  classifyRepairableLock,
  hostRoot,
  main,
  quarantineMalformedTestArtifactLock,
} from "./repair-test-artifact-lock.mjs";
import { probeTestArtifactLockOwner, serializeRecord } from "./test-artifact-lock.mjs";

async function temporaryDirectory() {
  return await mkdtemp(join(hostRoot, ".test-artifact-lock-repair-test-"));
}

function canonicalOutsideFixtureParent({ platform = process.platform, localAppData = process.env.LOCALAPPDATA, temporaryDirectory = tmpdir() } = {}) {
  const parent = platform === "win32" ? localAppData : temporaryDirectory;
  if (typeof parent !== "string" || parent.length === 0) throw new Error("test_local_app_data_unavailable");
  return parent;
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

/** A pid this machine has already released: the child is reaped by the time spawnSync returns. */
function departedPid() {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(child.status, 0, "the fixture's own child has to exit cleanly for its pid to be a departed one");
  return child.pid;
}

/** A live process that is not this test runner, held only for the length of one assertion. */
async function liveForeignPid() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("test_child_pid_unavailable");
  return child;
}

test("repair rejects the default run without --quarantine-malformed", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "lock");
  await writeFile(path, "");
  await assert.rejects(
    main(["--lock-path", path]),
    (error) => error.message === "host_test_artifact_lock_repair_requires_flag",
  );
  assert.equal(await readFile(path, "utf8"), "");
  await rm(directory, { recursive: true, force: true });
});

test("empty malformed lock is quarantined and reported without deleting quarantine bytes", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "lock");
  await writeFile(path, "");
  const result = await quarantineMalformedTestArtifactLock(path, {
    now: () => new Date("2025-01-02T03:04:05.000Z"),
  });
  assert.equal(await stat(result.quarantinePath).then((value) => value.isFile()), true);
  assert.equal(await readFile(result.quarantinePath, "utf8"), "");
  assert.equal(await stat(result.reportPath).then((value) => value.isFile()), true);
  assert.equal(result.report.original.malformed, undefined);
  assert.equal(result.report.original.reason, "malformed");
  assert.equal(result.report.original.owner, null);
  assert.equal(result.report.original.byteLength, 0);
  await assert.rejects(stat(path), (error) => error.code === "ENOENT");
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.status, "quarantined-malformed");
  assert.equal(report.quarantine.exactBytes, true);
  assert.match(report.reportSha256, /^[0-9a-f]{64}$/u);
  await rm(directory, { recursive: true, force: true });
});

test("malformed JSON is quarantined as well as an empty lock", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "lock");
  await writeFile(path, "{not-json");
  const result = await quarantineMalformedTestArtifactLock(path);
  assert.equal(await readFile(result.quarantinePath, "utf8"), "{not-json");
  assert.equal(result.report.original.reason, "malformed");
  await rm(directory, { recursive: true, force: true });
});

test("valid owner lock is rejected and preserved", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "lock");
  // The incident's shape: Windows records `unverified:win32`, so nothing can prove WHICH process owns the lock, and
  // the only question left is whether the recorded pid still exists. Here it does, so the lock is an owner's.
  const child = await liveForeignPid();
  try {
    assert.equal(await probeTestArtifactLockOwner({ pid: child.pid }), "alive", "the fixture's owner must be running");
    const bytes = serializeRecord(record({ pid: child.pid, processStartIdentity: "unverified:win32" }));
    await writeFile(path, bytes);
    await assert.rejects(
      quarantineMalformedTestArtifactLock(path),
      (error) => error.message === "host_test_artifact_lock_valid",
    );
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.deepEqual(await readdir(directory), ["lock"]);
  } finally {
    child.kill();
    await once(child, "exit");
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lock whose owner pid no longer exists is quarantined, because a departed pid is a fact this machine can check", async () => {
  const pid = departedPid();
  assert.equal(await probeTestArtifactLockOwner({ pid }), "dead", "the fixture's pid must be gone before the repair runs");
  const directory = await temporaryDirectory();
  const path = join(directory, "lock");
  const bytes = serializeRecord(record({ pid, processStartIdentity: "unverified:win32" }));
  await writeFile(path, bytes);
  const result = await quarantineMalformedTestArtifactLock(path);
  assert.equal(await readFile(result.quarantinePath, "utf8"), bytes, "the original bytes stay recoverable");
  assert.equal(result.report.status, "quarantined-owner-absent");
  assert.deepEqual(result.report.original.owner, { pid, processStartIdentity: "unverified:win32", pidState: "dead" });
  await assert.rejects(stat(path), (error) => error.code === "ENOENT");
  await rm(directory, { recursive: true, force: true });
});

test("only a proven-dead owner is repairable: alive and unknown both meet the valid refusal", async () => {
  const bytes = Buffer.from(serializeRecord(record()), "utf8");
  for (const state of ["alive", "unknown"]) {
    await assert.rejects(
      classifyRepairableLock(bytes, { processProbe: async () => state }),
      (error) => error.message === "host_test_artifact_lock_valid",
      `an owner the probe reports as ${state} may still be writing, so the lock stays`,
    );
  }
  assert.deepEqual(await classifyRepairableLock(bytes, { processProbe: async () => "dead" }), {
    reason: "owner-absent",
    record: record(),
    ownerState: "dead",
  });
});

test("replacement installed during the move is preserved and never overwritten", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "lock");
  const replacement = serializeRecord(record({ ownerToken: "fedcba9876543210fedcba9876543210" }));
  await writeFile(path, "");
  const result = await quarantineMalformedTestArtifactLock(path, {
    renameFile: async (from, to) => {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
      await writeFile(path, replacement, { flag: "wx" });
    },
    now: () => new Date("2025-01-02T03:04:05.000Z"),
  });
  assert.equal(await readFile(path, "utf8"), replacement);
  // The quarantined original remains available for recovery; this command
  // never deletes either the original bytes or a replacement lock.
  assert.equal(await readFile(result.quarantinePath, "utf8"), "");
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.replacementAtLockPath.sha256.length, 64);
  assert.equal(report.replacementAtLockPath.byteLength, replacement.length);
  await rm(directory, { recursive: true, force: true });
});

test("selects LOCALAPPDATA for Windows outside fixtures", () => {
  assert.equal(
    canonicalOutsideFixtureParent({ platform: "win32", localAppData: "C:\\Users\\Test\\AppData\\Local", temporaryDirectory: "/tmp" }),
    "C:\\Users\\Test\\AppData\\Local",
  );
  assert.equal(
    canonicalOutsideFixtureParent({ platform: "linux", localAppData: "C:\\Users\\Test\\AppData\\Local", temporaryDirectory: "/tmp" }),
    "/tmp",
  );
  assert.throws(() => canonicalOutsideFixtureParent({ platform: "win32", localAppData: "", temporaryDirectory: "/tmp" }), /test_local_app_data_unavailable/);
});

test("repair refuses paths outside host root", async () => {
  const directory = await mkdtemp(join(canonicalOutsideFixtureParent(), "gamebuddy-artifact-lock-outside-"));
  const path = resolve(directory, "lock");
  await writeFile(path, "");
  await assert.rejects(
    quarantineMalformedTestArtifactLock(path),
    (error) => error.message === "host_test_artifact_lock_path_outside_host_root",
  );
  assert.equal(await readFile(path, "utf8"), "");
  await rm(directory, { recursive: true, force: true });
});
