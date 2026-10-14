import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chunkTestFiles, discoverTestFiles, runCompiledTests, runDiscoveredTests, runTestBatches } from "./run-tests.mjs";

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
  assert.deepEqual(calls, [{ command: "node-under-test", args: ["--import", pathToFileURL(resolve(import.meta.dirname, "compiled-test-bootstrap.mjs")).href, "--test", "--test-concurrency=1", ...tests], cwd: resolve(import.meta.dirname, "..") }]);
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
    { batch: ["a.test.js"], timeoutMs: 1_000 },
    { batch: ["b.test.js"], timeoutMs: 999 },
    { batch: ["c.test.js"], timeoutMs: 998 },
    { batch: ["d.test.js"], timeoutMs: 997 },
    { batch: ["e.test.js"], timeoutMs: 996 },
  ]);
  assert.deepEqual(chunkTestFiles(paths, 3), [["a.test.js", "b.test.js", "c.test.js"], ["d.test.js", "e.test.js"]]);
});

  test("uses a bounded 25-minute shared deadline when no suite timeout is supplied", async () => {
    const calls = [];
    await runTestBatches(["a.test.js"], {
      suite: "fixture",
      now: () => 0,
      run: async (batch, options) => {
        calls.push({ batch, timeoutMs: options.timeoutMs });
      },
    });
    // The suite deadline still bounds the run, but a file no longer receives it: a single
    // file gets its own (smaller) budget, because a file that never resolves must be named
    // and bounded instead of consuming the suite's remaining minutes in silence.
    assert.deepEqual(calls, [{ batch: ["a.test.js"], timeoutMs: 180_000 }]);
  });

  test("names the file whose own budget expired, and keeps the suite deadline as its bound", async () => {
    const seen = [];
    await assert.rejects(
      runTestBatches(["slow.test.js"], {
        suite: "fixture",
        timeoutMs: 900_000,
        perFileMs: 5_000,
        now: () => 0,
        run: async (batch, options) => {
          seen.push({ batch, timeoutMs: options.timeoutMs });
          throw new Error("child was killed");
        },
      }),
      /test_file_timeout:slow\.test\.js:budget_ms=5000/,
    );
    assert.deepEqual(seen, [{ batch: ["slow.test.js"], timeoutMs: 5_000 }]);

    // When the suite deadline is nearer than a file's own budget, the suite keeps owning the
    // failure - the per-file bound must not mask a suite that ran out of time.
    const nearDeadline = [];
    let clockMs = 0;
    await assert.rejects(
      runTestBatches(["first.test.js", "second.test.js"], {
        suite: "fixture",
        batchSize: 1,
        timeoutMs: 500,
        perFileMs: 900_000,
        now: () => clockMs,
        run: async (batch, options) => {
          nearDeadline.push({ batch, timeoutMs: options.timeoutMs });
          clockMs = 600;
        },
      }),
      /test_suite_timeout:fixture/,
    );
    assert.deepEqual(nearDeadline, [{ batch: ["first.test.js"], timeoutMs: 500 }]);
  });

  test("uses only a positive integer compiled per-file budget override", async () => {
    await assert.rejects(runCompiledTests({ perFileMs: 0 }), /invalid_test_file_timeout/);
    await assert.rejects(runCompiledTests({ perFileMs: 1.5 }), /invalid_test_file_timeout/);
    await assert.rejects(runTestBatches(["a.test.js"], { suite: "fixture", perFileMs: 99 }), /invalid_test_file_timeout/);
  });

test("uses only a positive decimal compiled batch size override", async () => {
  await assert.rejects(runCompiledTests({ batchSize: 0 }), /invalid_test_batch_size/);
  await assert.rejects(runCompiledTests({ batchSize: 1.5 }), /invalid_test_batch_size/);
  await assert.rejects(runCompiledTests({ batchSize: Number.MAX_SAFE_INTEGER + 1 }), /invalid_test_batch_size/);
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


test("uses only a positive integer compiled concurrency override", async () => {
  await assert.rejects(runCompiledTests({ concurrency: 0 }), /invalid_test_concurrency/);
  await assert.rejects(runCompiledTests({ concurrency: 1.5 }), /invalid_test_concurrency/);
  await assert.rejects(runCompiledTests({ concurrency: Number.MAX_SAFE_INTEGER + 1 }), /invalid_test_concurrency/);
  await assert.rejects(runTestBatches(["a.test.js"], { suite: "fixture", concurrency: 0 }), /invalid_test_concurrency/);
});

test("keeps the batch-start line and per-file heartbeat CI parses", async () => {
  const hostRoot = resolve(import.meta.dirname, "..");
  const lines = [];
  const originalError = console.error;
  console.error = (line) => lines.push(line);
  try {
    await runTestBatches([join(hostRoot, "a.test.js")], {
      suite: "fixture",
      timeoutMs: 1_000,
      now: () => 0,
      run: async (batch, options) => {
        options.onHeartbeat({ pid: 42, elapsedMs: 7 });
      },
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(lines, [
    "host_test_suite_batch_start:suite=fixture:batch=1/1:files=1:paths=a.test.js:remaining_ms=1000",
    "host_test_suite_heartbeat:suite=fixture:batch=1/1:file=a.test.js:pid=42:elapsed_ms=7",
  ]);
});

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("bounds a batch's concurrent file children and still runs every file", async () => {
  const paths = ["a", "b", "c", "d", "e", "f"].map((name) => `${name}.test.js`);
  const releases = [];
  const started = [];
  let inFlight = 0;
  let peak = 0;
  const suite = runTestBatches(paths, {
    suite: "fixture",
    batchSize: 6,
    concurrency: 2,
    timeoutMs: 60_000,
    run: async (batch) => {
      started.push(batch[0]);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => releases.push(resolve));
      inFlight -= 1;
    },
  });
  await nextTurn();
  assert.deepEqual(started, ["a.test.js", "b.test.js"]);
  assert.equal(peak, 2);
  while (releases.length > 0) {
    releases.shift()();
    await nextTurn();
  }
  await suite;
  assert.equal(peak, 2);
  assert.deepEqual(started, paths);
});

test("defaults to four concurrent file children within a batch", async () => {
  const paths = ["a", "b", "c", "d", "e"].map((name) => `${name}.test.js`);
  const releases = [];
  let inFlight = 0;
  let peak = 0;
  const suite = runTestBatches(paths, {
    suite: "fixture",
    batchSize: 5,
    timeoutMs: 60_000,
    run: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => releases.push(resolve));
      inFlight -= 1;
    },
  });
  await nextTurn();
  assert.equal(peak, 4);
  while (releases.length > 0) {
    releases.shift()();
    await nextTurn();
  }
  await suite;
  assert.equal(peak, 4);
});

test("a failed file fails the run and still awaits its in-flight siblings", async () => {
  const paths = ["a", "b", "c", "d"].map((name) => `${name}.test.js`);
  const finished = [];
  let releaseSibling;
  const suite = runTestBatches(paths, {
    suite: "fixture",
    batchSize: 4,
    concurrency: 2,
    timeoutMs: 60_000,
    run: async (batch) => {
      if (batch[0] === "a.test.js") throw new Error("fixture_child_failed");
      if (batch[0] === "b.test.js") await new Promise((resolve) => { releaseSibling = resolve; });
      finished.push(batch[0]);
    },
  });
  await nextTurn();
  assert.equal(typeof releaseSibling, "function");
  releaseSibling();
  await assert.rejects(suite, /fixture_child_failed/);
  // "b" was already running when "a" failed, so it is awaited; "c" and "d"
  // never started, and nothing reported success while a child was alive.
  assert.deepEqual(finished, ["b.test.js"]);
});

test("fails closed at the shared suite deadline with concurrent file children", async () => {
  let clock = 0;
  const calls = [];
  await assert.rejects(
    runTestBatches(["a.test.js", "b.test.js", "c.test.js", "d.test.js"], {
      suite: "fixture",
      batchSize: 4,
      concurrency: 3,
      timeoutMs: 200,
      now: () => clock,
      run: async (batch, options) => {
        calls.push({ file: batch[0], timeoutMs: options.timeoutMs });
        clock += 100;
      },
    }),
    /test_suite_timeout:fixture/,
  );
  assert.deepEqual(calls, [
    { file: "a.test.js", timeoutMs: 200 },
    { file: "b.test.js", timeoutMs: 100 },
  ]);
});
