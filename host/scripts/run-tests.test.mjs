import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { chunkTestFiles, discoverTestFiles, runDiscoveredTests, runTestBatches } from "./run-tests.mjs";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-test-runner-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("recursively discovers sorted nested regular test files and passes every path explicitly to Node", async () => withFixture(async (root) => {
  await mkdir(join(root, "z", "nested"), { recursive: true });
  await mkdir(join(root, "a"), { recursive: true });
  await writeFile(join(root, "z", "nested", "second.test.js"), "");
  await writeFile(join(root, "a", "first.test.js"), "");
  await writeFile(join(root, "a", "not-a-test.js"), "");

  const tests = await discoverTestFiles(root);
  assert.deepEqual(tests, [resolve(root, "a", "first.test.js"), resolve(root, "z", "nested", "second.test.js")]);
  const calls = [];
  await runDiscoveredTests(tests, { node: "node-under-test", runChild: async (options) => { calls.push(options); } });
  assert.deepEqual(calls, [{ command: "node-under-test", args: ["--test", "--test-concurrency=1", ...tests], cwd: resolve(import.meta.dirname, "..") }]);
}));

test("discovers script-level ESM tests when explicitly requested", async () => withFixture(async (root) => {
  await writeFile(join(root, "script.test.mjs"), "");
  await writeFile(join(root, "compiled.test.js"), "");
  assert.deepEqual(await discoverTestFiles(root, ".test.mjs"), [resolve(root, "script.test.mjs")]);
}));

test("fails closed when the test root is missing, invalid, or contains no tests", async () => withFixture(async (root) => {
  await assert.rejects(discoverTestFiles(join(root, "missing")), /test_root_missing/);
  await writeFile(join(root, "not-a-directory"), "");
  await assert.rejects(discoverTestFiles(join(root, "not-a-directory")), /test_root_not_directory/);
  await assert.rejects(discoverTestFiles(root), /test_files_missing/);
}));

test("fails closed on symlinked test paths", async (t) => withFixture(async (root) => {
  const outside = join(root, "outside.test.js");
  await writeFile(outside, "");
  try {
    await symlink(outside, join(root, "linked.test.js"));
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code}`);
    return;
  }
  await assert.rejects(discoverTestFiles(root), /test_path_symlink_or_reparse/);
}));

test("rejects an empty explicit test invocation", async () => {
  await assert.rejects(runDiscoveredTests([]), /test_files_missing/);
});

test("runs sorted test files in bounded fresh-coordinator batches with one suite deadline", async () => {
  const paths = ["a.test.js", "b.test.js", "c.test.js", "d.test.js", "e.test.js"];
  const calls = [];
  let clock = 0;
  await runTestBatches(paths, {
    suite: "fixture",
    batchSize: 2,
    timeoutMs: 1_000,
    now: () => clock,
    run: async (batch, options) => {
      calls.push({ batch, timeoutMs: options.timeoutMs });
      clock += 1;
    },
  });
  assert.deepEqual(calls, [
    { batch: ["a.test.js", "b.test.js"], timeoutMs: 1_000 },
    { batch: ["c.test.js", "d.test.js"], timeoutMs: 999 },
    { batch: ["e.test.js"], timeoutMs: 998 },
  ]);
  assert.deepEqual(chunkTestFiles(paths, 3), [["a.test.js", "b.test.js", "c.test.js"], ["d.test.js", "e.test.js"]]);
});

test("fails closed before starting a batch after the shared suite deadline", async () => {
  let clock = 0;
  const calls = [];
  await assert.rejects(
    runTestBatches(["a.test.js", "b.test.js"], {
      suite: "fixture",
      batchSize: 1,
      timeoutMs: 100,
      now: () => clock,
      run: async (batch) => {
        calls.push(batch);
        clock = 100;
      },
    }),
    /test_suite_timeout:fixture/,
  );
  assert.deepEqual(calls, [["a.test.js"]]);
  assert.throws(() => chunkTestFiles(["a.test.js"], 0), /invalid_test_batch_size/);
});
