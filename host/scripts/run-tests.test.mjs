import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import {
  chunkTestFiles,
  discoverTestFiles,
  exclusiveGroupsFor,
  isEnvironmentalFailure,
  machineDefaultConcurrency,
  preflightTestArtifact,
  runCompiledTests,
  runDiscoveredTests,
  runTestBatches,
} from "./run-tests.mjs";
import { assertTestArtifactFreshness, assertTestArtifactInventory, writeTestArtifactInventory } from "./test-artifact-inventory.mjs";

// A real file path, under the Host root, shaped like the ones `discoverTestFiles` hands the
// runner - so the message under test carries the same `dist-test/...` spelling production does.
// (These two cases used to pass a bare "slow.test.js", which the runner could only render as
// `..\slow.test.js`; the assertion then failed on a fixture that no real run produces.)
const staleFile = fileURLToPath(new URL("../dist-test/slow.test.js", import.meta.url));
const brokenFile = fileURLToPath(new URL("../dist-test/broken.test.js", import.meta.url));

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-test-runner-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A fixture artifact with a fixture source tree, because the inventory now describes both: the
 * test files it emitted and the sources it was built from. A fixed build stamp is used
 * throughout so no assertion depends on how fast this machine writes files.
 */
const BUILD_STARTED_AT_MS = 1_800_000_000_000;

async function withArtifactFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-test-artifact-"));
  try {
    const sourceRoot = join(root, "src");
    const outputRoot = join(root, "dist-test");
    await mkdir(join(sourceRoot, "tavern"), { recursive: true });
    await mkdir(join(outputRoot, "tavern"), { recursive: true });
    await run({ root, sourceRoot, outputRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A source file with an explicit write time; the stamp is compared against it. */
async function writeSource(path, mtimeMs) {
  await writeFile(path, "");
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
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
      runTestBatches([staleFile], {
        suite: "fixture",
        timeoutMs: 900_000,
        perFileMs: 5_000,
        now: () => 0,
        run: async (batch, options) => {
          seen.push({ batch, timeoutMs: options.timeoutMs });
          throw new Error("test_supervisor_timeout:pid=1:timeout_ms=5000");
        },
      }),
      /test_file_timeout:dist-test\/slow\.test\.js:budget_ms=5000/,
    );
    assert.deepEqual(seen, [{ batch: [staleFile], timeoutMs: 5_000 }]);

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
      runTestBatches([staleFile], {
        suite: "fixture",
        perFileMs: 5_000,
        now: () => 0,
        run: async () => {
          throw new Error("test_supervisor_timeout:pid=1:timeout_ms=5000\npartial output");
        },
      }),
      /test_file_timeout:dist-test\/slow\.test\.js:budget_ms=5000/,
    );

    await assert.rejects(
      runTestBatches([brokenFile], {
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

    // The named-pipe coordinator is exclusive for a different reason: it is fine alone (2s here,
    // and passing alone on the CI runner) but depends on real syscall round trips, so a loaded
    // machine turns it into a stall-budget expiry. An exclusive file runs after the concurrent
    // pool has drained, which is the property the test below asserts.
    assert.equal(
      exclusiveGroupsFor("dist-test/gameplay-task-subagent.test.js").length,
      1,
      "the named-pipe coordinator must be declared exclusive",
    );

    let inFlight = 0;
    let mostConcurrent = 0;
    const exclusiveOverlap = [];
    const exclusiveOverlappedOrdinary = [];
    const exclusiveRunning = new Set();
    await runTestBatches(
      [
        "dist-test/ordinary-a.test.js",
        "dist-test/stardew-execution-request-wire-parity.test.js",
        "dist-test/ordinary-b.test.js",
        "dist-test/gameplay-task-subagent.test.js",
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
            // Two members must never overlap, and an exclusive file must not overlap an ORDINARY
            // one either: that is what running after the pool drained means.
            if (exclusiveRunning.size > 0) exclusiveOverlap.push(path);
            if (inFlight > 1) exclusiveOverlappedOrdinary.push(path);
            exclusiveRunning.add(path);
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (exclusive) exclusiveRunning.delete(path);
          inFlight -= 1;
        },
      },
    );
    assert.deepEqual(exclusiveOverlap, [], "two members of one exclusive group must never overlap");
    assert.deepEqual(
      exclusiveOverlappedOrdinary,
      [],
      "an exclusive file runs after the concurrent pool has drained, never beside an ordinary file",
    );
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

test("records and verifies the artifact's own test-file inventory and source stamp", async () => withArtifactFixture(async ({ sourceRoot, outputRoot }) => {
  await writeSource(join(sourceRoot, "runtime.ts"), BUILD_STARTED_AT_MS - 20_000);
  await writeSource(join(sourceRoot, "tavern", "chat-pipeline-service.test.ts"), BUILD_STARTED_AT_MS - 10_000);
  await writeFile(join(outputRoot, "runtime.test.js"), "");
  await writeFile(join(outputRoot, "tavern", "chat.test.js"), "");
  await writeFile(join(outputRoot, "runtime.js"), "");

  const inventory = await writeTestArtifactInventory({ outputRoot, sourceRoot, buildStartedAtMs: BUILD_STARTED_AT_MS });
  assert.deepEqual(inventory, {
    schema: "gamebuddy-host-test-artifact-inventory/v2",
    buildStartedAtMs: BUILD_STARTED_AT_MS,
    sourceFileCount: 2,
    newestSourcePath: "tavern/chat-pipeline-service.test.ts",
    newestSourceMtimeMs: BUILD_STARTED_AT_MS - 10_000,
    testFileCount: 2,
    testFiles: ["runtime.test.js", "tavern/chat.test.js"],
  });
  assert.deepEqual(await assertTestArtifactInventory({ outputRoot }), { status: "complete", present: 2, expected: 2 });
  assert.deepEqual(await assertTestArtifactFreshness({ outputRoot, sourceRoot }), { status: "fresh", sourceFileCount: 2 });

  // An extra test file is not an incomplete artifact, and it does not make the sources look older.
  await writeFile(join(outputRoot, "extra.test.js"), "");
  assert.equal((await assertTestArtifactInventory({ outputRoot })).status, "complete");
  assert.equal((await assertTestArtifactFreshness({ outputRoot, sourceRoot })).status, "fresh");
}));

test("names a source newer than the artifact and the command that fixes it", async () => withArtifactFixture(async ({ sourceRoot, outputRoot }) => {
  await writeSource(join(sourceRoot, "runtime.ts"), BUILD_STARTED_AT_MS - 20_000);
  await writeSource(join(sourceRoot, "tavern", "chat-pipeline-service.test.ts"), BUILD_STARTED_AT_MS - 10_000);
  await writeFile(join(outputRoot, "runtime.test.js"), "");
  await writeTestArtifactInventory({ outputRoot, sourceRoot, buildStartedAtMs: BUILD_STARTED_AT_MS });

  // The fix lands after the artifact was built: the artifact is still complete, and now wrong.
  await writeSource(join(sourceRoot, "tavern", "chat-pipeline-service.test.ts"), BUILD_STARTED_AT_MS + 1_000);
  await assert.rejects(
    assertTestArtifactFreshness({ outputRoot, sourceRoot }),
    /^Error: test_artifact_stale:newest_source=tavern\/chat-pipeline-service\.test\.ts:artifact_built=\d{4}-\d{2}-\d{2}T[\d:.]+Z:run=`pnpm build:test`$/,
  );

  // Rebuilding after that edit is what makes it true again.
  await writeTestArtifactInventory({ outputRoot, sourceRoot, buildStartedAtMs: BUILD_STARTED_AT_MS + 2_000 });
  assert.deepEqual(await assertTestArtifactFreshness({ outputRoot, sourceRoot }), { status: "fresh", sourceFileCount: 2 });
}));

test("names a source tree that changed size even when no write is newer than the build", async () => withArtifactFixture(async ({ root, sourceRoot, outputRoot }) => {
  await writeSource(join(sourceRoot, "runtime.ts"), BUILD_STARTED_AT_MS - 20_000);
  await writeSource(join(sourceRoot, "tavern", "chat.test.ts"), BUILD_STARTED_AT_MS - 10_000);
  await writeFile(join(outputRoot, "runtime.test.js"), "");
  await writeTestArtifactInventory({ outputRoot, sourceRoot, buildStartedAtMs: BUILD_STARTED_AT_MS });

  // A source deleted after the build: no write time moved, but the artifact still runs the
  // compiled test of a file that no longer exists.
  await rm(join(sourceRoot, "runtime.ts"));
  await assert.rejects(
    assertTestArtifactFreshness({ outputRoot, sourceRoot }),
    /^Error: test_artifact_stale:source_files=2->1:artifact_built=\d{4}-\d{2}-\d{2}T[\d:.]+Z:run=`pnpm build:test`$/,
  );

  // A source added with an older write time than the build.
  await writeSource(join(sourceRoot, "runtime.ts"), BUILD_STARTED_AT_MS - 30_000);
  await writeSource(join(sourceRoot, "tavern", "another.test.ts"), BUILD_STARTED_AT_MS - 30_000);
  await assert.rejects(assertTestArtifactFreshness({ outputRoot, sourceRoot }), /test_artifact_stale:source_files=2->3:artifact_built=/);

  // The same holds for a source tree that is empty: that is a size change, not an error about
  // reading one.
  await mkdir(join(root, "empty-src"), { recursive: true });
  await assert.rejects(assertTestArtifactFreshness({ outputRoot, sourceRoot: join(root, "empty-src") }), /test_artifact_stale:source_files=2->0:/);
}));

test("fails a stale artifact at preflight, before it can produce a verdict", async () => withArtifactFixture(async ({ root, sourceRoot, outputRoot }) => {
  await writeSource(join(sourceRoot, "runtime.ts"), BUILD_STARTED_AT_MS - 20_000);
  await writeFile(join(outputRoot, "runtime.test.js"), "");
  await writeTestArtifactInventory({ outputRoot, sourceRoot, buildStartedAtMs: BUILD_STARTED_AT_MS });
  assert.deepEqual(await assertTestArtifactInventory({ outputRoot }), { status: "complete", present: 1, expected: 1 });

  await writeSource(join(sourceRoot, "runtime.ts"), BUILD_STARTED_AT_MS + 1_000);
  await assert.rejects(preflightTestArtifact({ root, outputRoot, sourceRoot }), /test_artifact_stale:newest_source=runtime\.ts:artifact_built=/);

  // Rebuilt, the same fixture no longer stops at the staleness gate: the preflight continues to
  // the verification manifest, which is the next gate and this fixture has none to read. That is
  // the ordering being asserted, not a passing preflight.
  await writeTestArtifactInventory({ outputRoot, sourceRoot, buildStartedAtMs: BUILD_STARTED_AT_MS + 2_000 });
  await assert.rejects(preflightTestArtifact({ root, outputRoot, sourceRoot }), /host_verification_artifact_manifest_missing/);
}));

test("degrades honestly when the artifact cannot say how old it is", async () => withArtifactFixture(async ({ sourceRoot, outputRoot }) => {
  await writeSource(join(sourceRoot, "runtime.ts"), BUILD_STARTED_AT_MS - 20_000);
  await writeFile(join(outputRoot, "runtime.test.js"), "");
  await writeFile(
    join(outputRoot, "test-artifact-inventory.json"),
    `${JSON.stringify({ schema: "gamebuddy-host-test-artifact-inventory/v1", testFileCount: 1, testFiles: ["runtime.test.js"] }, null, 2)}\n`,
  );

  // A v1 inventory is still a complete inventory; it simply cannot be compared against sources.
  assert.deepEqual(await assertTestArtifactInventory({ outputRoot }), { status: "complete", present: 1, expected: 1 });
  assert.deepEqual(await assertTestArtifactFreshness({ outputRoot, sourceRoot }), { status: "unrecorded" });
  // So is an artifact that carries no inventory at all.
  assert.deepEqual(await assertTestArtifactFreshness({ outputRoot: join(outputRoot, "absent"), sourceRoot }), { status: "unrecorded" });
}));

test("refuses to write an inventory that cannot say when the build froze its inputs", async () => withArtifactFixture(async ({ root, sourceRoot, outputRoot }) => {
  await writeSource(join(sourceRoot, "runtime.ts"), BUILD_STARTED_AT_MS - 20_000);
  await writeFile(join(outputRoot, "runtime.test.js"), "");

  // Refused rather than defaulted to "now": a publish-time stamp cannot see an edit made while
  // the compile was running, which is the edit the stamp exists to catch.
  await assert.rejects(writeTestArtifactInventory({ outputRoot, sourceRoot }), /test_artifact_inventory_build_time_invalid/);
  await assert.rejects(writeTestArtifactInventory({ outputRoot, sourceRoot, buildStartedAtMs: 0 }), /test_artifact_inventory_build_time_invalid/);
  await assert.rejects(writeTestArtifactInventory({ outputRoot, sourceRoot, buildStartedAtMs: 1.5 }), /test_artifact_inventory_build_time_invalid/);

  await mkdir(join(root, "empty-src"), { recursive: true });
  await assert.rejects(
    writeTestArtifactInventory({ outputRoot, sourceRoot: join(root, "empty-src"), buildStartedAtMs: BUILD_STARTED_AT_MS }),
    /test_artifact_source_tree_empty/,
  );
}));

test("names a shortfall as test_artifact_incomplete instead of running a partial tree", async () => withArtifactFixture(async ({ sourceRoot, outputRoot }) => {
  await writeSource(join(sourceRoot, "runtime.ts"), BUILD_STARTED_AT_MS - 20_000);
  await writeFile(join(outputRoot, "first.test.js"), "");
  await writeFile(join(outputRoot, "second.test.js"), "");
  await writeTestArtifactInventory({ outputRoot, sourceRoot, buildStartedAtMs: BUILD_STARTED_AT_MS });
  await rm(join(outputRoot, "second.test.js"));

  await assert.rejects(assertTestArtifactInventory({ outputRoot }), /test_artifact_incomplete:present=1:expected=2:missing=second\.test\.js/);
}));

test("degrades honestly when an artifact predates the inventory", async () => withFixture(async (root) => {
  await writeFile(join(root, "runtime.test.js"), "");
  assert.deepEqual(await assertTestArtifactInventory({ outputRoot: root }), { status: "absent" });
}));

/**
 * `--keep-going` and the one bounded retry, both because this machine's environmental failures were
 * costing whole batches of information: the suite stops at the first failing batch, and a file that
 * failed a batch with `read ECONNRESET` passed 10/10 on its own. The injected `run` is what makes
 * these deterministic - waiting for a real socket reset would be a flaky test of a flaky cause.
 */
test("keep-going reports every failing file instead of the first batch's", async () => {
  const paths = ["a.test.js", "b.test.js", "c.test.js"];
  const calls = [];
  await assert.rejects(
    runTestBatches(paths, {
      suite: "fixture",
      batchSize: 1,
      timeoutMs: 10_000,
      retryEnvironmental: false,
      run: async (batch) => {
        calls.push(batch[0]);
        if (batch[0] !== "b.test.js") throw new Error(`test_runner_failed:code=1:signal=none\nAssertionError: ${batch[0]}`);
      },
    }),
    /test_runner_failed/u,
  );
  assert.deepEqual(calls, ["a.test.js"], "without keep-going the run ends at the first failing batch");

  const keptCalls = [];
  await assert.rejects(
    runTestBatches(paths, {
      suite: "fixture",
      batchSize: 1,
      timeoutMs: 10_000,
      keepGoing: true,
      retryEnvironmental: false,
      run: async (batch) => {
        keptCalls.push(batch[0]);
        if (batch[0] !== "b.test.js") throw new Error(`test_runner_failed:code=1:signal=none\nAssertionError: ${batch[0]}`);
      },
    }),
    /test_suite_failed:2 file\(s\): a\.test\.js, c\.test\.js/u,
  );
  assert.deepEqual(keptCalls, ["a.test.js", "b.test.js", "c.test.js"], "keep-going runs the later batches too");
});

test("an environmental failure is retried once, alone, and a second failure still fails", async () => {
  const calls = [];
  await runTestBatches(["flaky.test.js"], {
    suite: "fixture",
    batchSize: 1,
    timeoutMs: 10_000,
    run: async () => {
      calls.push(1);
      if (calls.length === 1)
        throw new Error("test_runner_failed:code=1:signal=none\n[cause]: Error: read ECONNRESET");
    },
  });
  assert.equal(calls.length, 2, "the retry runs the file a second time");

  const persistent = [];
  await assert.rejects(
    runTestBatches(["always-reset.test.js"], {
      suite: "fixture",
      batchSize: 1,
      timeoutMs: 10_000,
      run: async () => {
        persistent.push(1);
        throw new Error("test_runner_failed:code=1:signal=none\n[cause]: Error: read ECONNRESET");
      },
    }),
    /test_runner_failed/u,
  );
  assert.equal(persistent.length, 2, "exactly one retry, never a loop");
});

test("a child that asserted is never retried and never called environmental", async () => {
  const calls = [];
  await assert.rejects(
    runTestBatches(["asserted.test.js"], {
      suite: "fixture",
      batchSize: 1,
      timeoutMs: 10_000,
      run: async () => {
        calls.push(1);
        // The same transport cause in the same output, beside an assertion: the assertion wins.
        throw new Error(
          "test_runner_failed:code=1:signal=none\nAssertionError [ERR_ASSERTION]: expected 1\n[cause]: Error: read ECONNRESET",
        );
      },
    }),
    /AssertionError/u,
  );
  assert.equal(calls.length, 1, "an assertion failure is the code's, and is reported as it arrived");
  assert.equal(isEnvironmentalFailure(new Error("AssertionError: x\nECONNRESET")), false);
  assert.equal(isEnvironmentalFailure(new Error("test_runner_failed:code=1\n[cause]: read ECONNRESET")), true);
  // Two publisher fixtures contend on one lock file in a temp root: the loser reports EPERM in a
  // batch and passes alone, which is the same class as the socket reset.
  assert.equal(
    isEnvironmentalFailure(
      new Error("test_runner_failed:code=1:signal=none\nError: EPERM: operation not permitted, open 'x\\.test-publisher.lock'"),
    ),
    true,
  );
});
