import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  hostRoot,
  main,
  quarantineMalformedTestArtifactLock,
} from "./repair-test-artifact-lock.mjs";
import { serializeRecord } from "./test-artifact-lock.mjs";

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
  assert.equal(result.report.original.malformed, true);
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
  assert.equal(result.report.original.malformed, true);
  await rm(directory, { recursive: true, force: true });
});

test("valid owner lock is rejected and preserved", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "lock");
  const bytes = serializeRecord(record());
  await writeFile(path, bytes);
  await assert.rejects(
    quarantineMalformedTestArtifactLock(path),
    (error) => error.message === "host_test_artifact_lock_valid",
  );
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.deepEqual(await readdir(directory), ["lock"]);
  await rm(directory, { recursive: true, force: true });
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
