import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectFixtureTransaction } from "./lib/stardew-fixture-profile.mjs";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("transaction inspector is read-only and reports ambiguous recoverable backups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-fixture-inspector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const backupName of ["one-fixture-backup", "two-fixture-backup"]) {
    await mkdir(join(root, backupName), { recursive: true });
    await writeJson(join(root, backupName, "manifest.json"), { version: 1, entries: [] });
  }
  const result = await inspectFixtureTransaction({ root, profiles: join(root, "profiles"), processNames: [] });
  assert.equal(result.state, "inspection");
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.transactionState, "ambiguous_backups");
  assert.deepEqual(result.discoveredBackups, ["one-fixture-backup", "two-fixture-backup"]);
  assert.match(result.recommendation, /Do not prepare or delete files/);
});

test("transaction inspector detects an invalid lock without mutating it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-fixture-inspector-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".stardew-fixture-profile.lock"), { recursive: true });
  await writeFile(join(root, ".stardew-fixture-profile.lock", "transaction.json"), "not-json");
  const result = await inspectFixtureTransaction({ root, profiles: join(root, "profiles"), processNames: [] });
  assert.equal(result.transactionState, "lock_invalid");
  assert.equal(result.transactionLock.state, "invalid");
  assert.equal(result.mutationPerformed, false);
  assert.equal(await readFile(join(root, ".stardew-fixture-profile.lock", "transaction.json"), "utf8"), "not-json");
});
