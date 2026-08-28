import assert from "node:assert/strict";
import test from "node:test";
import { listPackageTests, runPackageTests } from "../src/run-tests.mjs";

test("lists only explicit package test modules", async () => {
  const tests = await listPackageTests();
  assert.ok(tests.length > 0);
  assert.ok(tests.every((entry) => /^tests\/[a-z0-9][a-z0-9-]*\.test\.mjs$/.test(entry)));
  assert.ok(!tests.includes("tests/root-ci-disposition-audit.test.mjs"));
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
  assert.deepEqual(calls[0][1], ["--test", "--test-concurrency=1", ...tests]);
  assert.equal(calls[0][2].shell, false);
});
