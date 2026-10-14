import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chunkTestFiles, discoverTestFiles, exclusiveGroupsFor, machineDefaultConcurrency, runCompiledTests, runDiscoveredTests, runTestBatches } from "./run-tests.mjs";
import { assertTestArtifactInventory, writeTestArtifactInventory } from "./test-artifact-inventory.mjs";

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
    // file gets its own (smaller) stall budget, because a file that never resolves must be named
    // and bounded instead of consuming the suite's remaining minutes in silence. It is sized for
    // a loaded machine (600s) - the point is to catch a hang, not to race a slow file.
    assert.deepEqual(calls, [{ batch: ["a.test.js"], timeoutMs: 600_000 }]);
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
          throw new Error("test_supervisor_timeout:pid=1:timeout_ms=5000");
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

  test("reports a killed child as a budget expiry and lets a real failure keep its own reason", async () => {
    // A child the supervisor killed is a budget expiry; a child that exited non-zero is its own
    // failure and must keep its message and output. Getting this backwards reports real failures
    // as timeouts and hides why they failed.
    await assert.rejects(
      runTestBatches(["slow.test.js"], {
        suite: "fixture",
        perFileMs: 5_000,
        now: () => 0,
        run: async () => {
          throw new Error("test_supervisor_timeout:pid=1:timeout_ms=5000\npartial output");
        },
      }),
      /test_file_timeout:slow\.test\.js:budget_ms=5000/,
    );

    await assert.rejects(
      runTestBatches(["broken.test.js"], {
        suite: "fixture",
        perFileMs: 900_000,
        timeoutMs: 900_000,
        now: () => 0,
        run: async () => {
          throw new Error("test_runner_failed:code=1:signal=none\n✖ a test failed\nAssertionError: nope");
        },
      }),
      (error) => {
        assert.match(error.message, /test_runner_failed:code=1:signal=none/);
        assert.match(error.message, /AssertionError: nope/, "the child's own output must survive");
        assert.doesNotMatch(error.message, /test_file_timeout/);
        return true;
      },
    );
  });

  test("keeps the files that contend on one machine-global build out of concurrent execution", async () => {
    // The four Stardew wire-parity files each spawn a real `dotnet test` against one shared
    // csproj; four simultaneous cold builds kill three of them. They must never overlap, while
    // everything else in the same batch still does.
    const members = [
      "dist-test/stardew-execution-request-wire-parity.test.js",
      "dist-test/stardew-snapshot-wire-parity.test.js",
    ];
    for (const member of members)
      assert.equal(exclusiveGroupsFor(member).length, 1, `${member} must be declared exclusive`);
    assert.equal(exclusiveGroupsFor("dist-test/runtime.test.js").length, 0, "an ordinary file stays concurrent");
    assert.equal(exclusiveGroupsFor("dist-test/tavern\\chat-lifecycle\\chat-lifecycle.test.js").length, 0);

    let inFlight = 0;
    let mostConcurrent = 0;
    const exclusiveOverlap = [];
    const exclusiveRunning = new Set();
    await runTestBatches(
      [
        "dist-test/ordinary-a.test.js",
        "dist-test/stardew-execution-request-wire-parity.test.js",
        "dist-test/ordinary-b.test.js",
        "dist-test/stardew-snapshot-wire-parity.test.js",
      ],
      {
        suite: "fixture",
        batchSize: 4,
        perFileMs: 900_000,
        timeoutMs: 900_000,
        run: async ([path]) => {
          const exclusive = exclusiveGroupsFor(path).length > 0;
          inFlight += 1;
          mostConcurrent = Math.max(mostConcurrent, inFlight);
          if (exclusive) {
            if (exclusiveRunning.size > 0) exclusiveOverlap.push(path);
            exclusiveRunning.add(path);
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (exclusive) exclusiveRunning.delete(path);
          inFlight -= 1;
        },
      },
    );
    assert.deepEqual(exclusiveOverlap, [], "two members of one exclusive group must never overlap");
    // The two ordinary files still overlapped each other: the exclusion is per file, not a
    // switch that serializes the whole suite.
    assert.equal(mostConcurrent, 2, "the ordinary files keep their concurrency");
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

  test("derives the default concurrency from the machine's own capacity, capped at two", () => {
    // Two overlapping Node startups is the ceiling; below it the machine decides. A process
    // restricted to one effective CPU must never be handed a second child, because the extra
    // parallelism surfaces as a stall-budget expiry or a loopback reset on a file that is fine.
    assert.equal(machineDefaultConcurrency(1), 1, "one effective CPU gets one child");
    assert.equal(machineDefaultConcurrency(0), 1, "a machine reporting nothing still gets one child");
    assert.equal(machineDefaultConcurrency(2), 2);
    assert.equal(machineDefaultConcurrency(32), 2, "the ceiling is two, however wide the machine is");
  });

  test("defaults to the machine-derived concurrency within a batch", async () => {
  const paths = ["a", "b", "c", "d", "e"].map((name) => `${name}.test.js`);
  const releases = [];
  let inFlight = 0;
  let peak = 0;
  const expected = machineDefaultConcurrency();
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
    assert.equal(peak, expected);
    while (releases.length > 0) {
      releases.shift()();
      await nextTurn();
    }
    await suite;
    assert.equal(peak, expected);
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

test("records and verifies the artifact's own test-file inventory", async () => withFixture(async (root) => {
  await mkdir(join(root, "tavern"), { recursive: true });
  await writeFile(join(root, "runtime.test.js"), "");
  await writeFile(join(root, "tavern", "chat.test.js"), "");
  await writeFile(join(root, "runtime.js"), "");

  const inventory = await writeTestArtifactInventory({ outputRoot: root });
  assert.deepEqual(inventory, {
    schema: "gamebuddy-host-test-artifact-inventory/v1",
    testFileCount: 2,
    testFiles: ["runtime.test.js", "tavern/chat.test.js"],
  });
  assert.deepEqual(await assertTestArtifactInventory({ outputRoot: root }), { status: "complete", present: 2, expected: 2 });

  // An extra test file is not an incomplete artifact.
  await writeFile(join(root, "extra.test.js"), "");
  assert.equal((await assertTestArtifactInventory({ outputRoot: root })).status, "complete");
}));

test("names a shortfall as test_artifact_incomplete instead of running a partial tree", async () => withFixture(async (root) => {
  await writeFile(join(root, "first.test.js"), "");
  await writeFile(join(root, "second.test.js"), "");
  await writeTestArtifactInventory({ outputRoot: root });
  await rm(join(root, "second.test.js"));

  await assert.rejects(assertTestArtifactInventory({ outputRoot: root }), /test_artifact_incomplete:present=1:expected=2:missing=second\.test\.js/);
}));

test("degrades honestly when an artifact predates the inventory", async () => withFixture(async (root) => {
  await writeFile(join(root, "runtime.test.js"), "");
  assert.deepEqual(await assertTestArtifactInventory({ outputRoot: root }), { status: "absent" });
}));
