import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listPackageTests, runPackageTests } from "../src/run-tests.mjs";

test("lists only explicit package test modules, and names the ones that declare a prerequisite", async () => {
  const { tests, blocked } = await listPackageTests();
  assert.ok(tests.length > 0);
  assert.ok(tests.every((entry) => /^tests\/[a-z0-9][a-z0-9-]*\.test\.mjs$/.test(entry)));
  assert.ok(blocked.every((entry) => entry.reason.length > 20), "a blocked test must say why, not just that it was blocked");
  assert.deepEqual(
    [...tests, ...blocked.map((entry) => entry.entry)].sort(),
    [...tests, ...blocked.map((entry) => entry.entry)].sort(),
  );
  /*
   * Nothing may disappear from both lists. The population is the directory, so a test that is in neither
   * list is a test that silently stopped being run - which is the failure this runner exists to prevent.
   */
  const onDisk = (await readdir(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests")))
    .filter((name) => /^[a-z0-9][a-z0-9-]*\.test\.mjs$/.test(name))
    .map((name) => `tests/${name}`)
    .sort();
  assert.deepEqual([...tests, ...blocked.map((entry) => entry.entry)].sort(), onDisk);
});

test("a declared prerequisite blocks only when it is absent, and never silently", async () => {
  const absent = await listPackageTests({ environment: {} });
  const present = await listPackageTests({
    environment: { GAMEBUDDY_STARDEW_GAME_PATH: path.resolve("test-support", "a-game-folder") },
  });
  /* Without a readable Stardew Valley.dll the declaring test is blocked; the count cannot grow. */
  assert.ok(absent.blocked.length >= 1);
  assert.ok(absent.blocked.every((entry) => entry.reason.length > 20));
  /* A path that does not hold the assembly is not a satisfied prerequisite. */
  assert.equal(present.blocked.length, absent.blocked.length);
});

test("launches Node tests with explicit files and no shell", async () => {
  const calls = [];
  const fake = {
    once(event, callback) {
      if (event === "close") queueMicrotask(() => callback(0, null));
      return fake;
    },
  };
  const tests = await runPackageTests({ spawnProcess: (...args) => { calls.push(args); return fake; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ["--test", "--test-concurrency=1", ...tests.tests]);
  assert.equal(calls[0][2].shell, false);
});
