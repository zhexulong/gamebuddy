import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chunkTestFiles, discoverTestFiles, runCompiledTests, runDiscoveredTests, runReleaseScriptTests, runScriptTests, runTestBatches, selectScriptTests } from "./run-tests.mjs";

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
  await runDiscoveredTests(tests, { node: "node-under-test", strictDisposition: false, runChild: async (options) => { calls.push(options); } });
  assert.deepEqual(calls, [{ command: "node-under-test", args: ["--import", pathToFileURL(resolve(import.meta.dirname, "compiled-test-bootstrap.mjs")).href, "--test", "--test-concurrency=1", ...tests], cwd: resolve(import.meta.dirname, "..") }]);
}));

test("keeps the isolated Portfolio test suite outside the release test artifact", async () => {
  const config = JSON.parse(await readFile(resolve(import.meta.dirname, "..", "tsconfig.test.json"), "utf8"));
  assert.deepEqual(
    config.exclude.filter((entry) => entry.startsWith("src/portfolio-") && entry.endsWith(".test.ts")),
    [
      "src/portfolio-protocol.test.ts",
      "src/portfolio-transport.test.ts",
      "src/portfolio-stardew-bridge.test.ts",
      "src/portfolio-stardew-interop.test.ts",
    ],
  );
});

test("discovers script-level ESM tests when explicitly requested", async () => withFixture(async (root) => {
  await writeFile(join(root, "script.test.mjs"), "");
  await writeFile(join(root, "compiled.test.js"), "");
  assert.deepEqual(await discoverTestFiles(root, ".test.mjs"), [resolve(root, "script.test.mjs")]);
}));

test("separates release-only script tests by the explicit release suffix", async () => {
  const paths = ["ordinary.test.mjs", "build-production-artifact.release.test.mjs", "other.release.test.mjs"];
  assert.deepEqual(selectScriptTests(paths), ["ordinary.test.mjs"]);
  assert.deepEqual(selectScriptTests(paths, { releaseOnly: true }), ["build-production-artifact.release.test.mjs", "other.release.test.mjs"]);
  assert.equal(typeof runScriptTests, "function");
  assert.equal(typeof runReleaseScriptTests, "function");
});

test("fails closed when the test root is missing, invalid, or contains no tests", async () => withFixture(async (root) => {
  await assert.rejects(discoverTestFiles(join(root, "missing")), /test_root_missing/);
  await writeFile(join(root, "not-a-directory"), "");
  await assert.rejects(discoverTestFiles(join(root, "not-a-directory")), /test_root_not_directory/);
  await assert.rejects(discoverTestFiles(root), /test_files_missing/);
}));

test("fails closed on reparse-linked test paths", async (t) => withFixture(async (root) => {
  if (process.platform === "win32") {
    const outside = join(root, "outside-tests");
    await mkdir(outside);
    await writeFile(join(outside, "linked.test.js"), "");
    try {
      await symlink(outside, join(root, "linked-tests"), "junction");
    } catch (error) {
      t.skip(`junction unavailable: ${error.code}`);
      return;
    }
  } else {
    const outside = join(root, "outside.test.js");
    await writeFile(outside, "");
    try {
      await symlink(outside, join(root, "linked.test.js"));
    } catch (error) {
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
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
  assert.deepEqual(calls, [{ batch: ["a.test.js"], timeoutMs: 25 * 60_000 }]);
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


test("strict disposition adds the TAP reporter and rejects unclassified skipped tests", async () => {
  const calls = [];
  await assert.rejects(
    runDiscoveredTests(["strict.test.js"], {
      strictDisposition: true,
      runChild: async (options) => {
        calls.push(options);
        return {
          code: 0,
          signal: null,
          stdout: "# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\nok 1 - skipped fixture # SKIP unavailable\n",
          stderr: "",
          output: "",
        };
      },
    }),
    /test_disposition_not_release_green/,
  );
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "--import",
    pathToFileURL(resolve(import.meta.dirname, "compiled-test-bootstrap.mjs")).href,
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
  ]);
});

test("strict disposition allows explicitly classified platform skips", async () => {
  const result = await runDiscoveredTests(["strict.test.js"], {
    strictDisposition: true,
    platform: "win32",
    runChild: async () => ({
      code: 0,
      signal: null,
        stdout: "# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\nok 1 - Windows reparse helper classifies an actual directory symbolic link where permitted # SKIP platform_non_applicable: Windows directory symbolic-link creation requires Developer Mode or SeCreateSymbolicLinkPrivilege; junction and AF_UNIX probes cover this runner's release reparse detection\n",
      stderr: "",
      output: "",
    }),
  });
  assert.equal(result.disposition.skipped, 1);
  assert.deepEqual(result.disposition.skippedReasons, ["platform_non_applicable: Windows directory symbolic-link creation requires Developer Mode or SeCreateSymbolicLinkPrivilege; junction and AF_UNIX probes cover this runner's release reparse detection"]);
});

test("strict disposition allows the fixed production-artifact file-symlink skip", async () => {
  const result = await runDiscoveredTests(["strict.test.js"], {
    strictDisposition: true,
    platform: "win32",
    runChild: async () => ({
      code: 0,
      signal: null,
      stdout: "# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\nok 1 - rejects fixture workers broadly, tampering, orphans, symlinks, and invalid start entry names # SKIP symlink unavailable: EPERM\n",
      stderr: "",
      output: "",
    }),
  });
  assert.deepEqual(result.disposition.skippedTests, [{ testName: "rejects fixture workers broadly, tampering, orphans, symlinks, and invalid start entry names", reason: "symlink unavailable: EPERM" }]);
});

test("strict disposition rejects an allowed platform skip on the wrong platform", async () => {
  await assert.rejects(
    runDiscoveredTests(["strict.test.js"], {
      strictDisposition: true,
      platform: "linux",
      runChild: async () => ({
        code: 0,
        signal: null,
        stdout: "# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\nok 1 - Windows reparse helper classifies an actual directory symbolic link where permitted # SKIP platform_non_applicable: Windows directory symbolic-link creation requires Developer Mode or SeCreateSymbolicLinkPrivilege; junction and AF_UNIX probes cover this runner's release reparse detection\n",
        stderr: "",
        output: "",
      }),
    }),
    /test_disposition_not_release_green/,
  );
});

test("strict disposition rejects an allowed platform prefix on an unknown test or reason", async () => {
  for (const stdout of [
    "# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\nok 1 - unknown test # SKIP platform_non_applicable: Windows directory symbolic-link creation requires Developer Mode or SeCreateSymbolicLinkPrivilege; junction and AF_UNIX probes cover this runner's release reparse detection\n",
    "# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\nok 1 - Windows reparse helper classifies an actual directory symbolic link where permitted # SKIP platform_non_applicable: forged\n",
  ]) {
    await assert.rejects(
      runDiscoveredTests(["strict.test.js"], {
        strictDisposition: true,
        runChild: async () => ({ code: 0, signal: null, stdout, stderr: "", output: "" }),
      }),
      /test_disposition_not_release_green/,
    );
  }
});

test("strict disposition fails closed when the child exits unsuccessfully", async () => {
  await assert.rejects(
    runDiscoveredTests(["strict.test.js"], {
      strictDisposition: true,
      runChild: async () => ({ code: 1, signal: null, stdout: "# tests 1\\n# suites 0\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n", stderr: "", output: "" }),
    }),
    /test_disposition_process_failed/,
  );
});

test("strict disposition fails closed when TODO tests remain", async () => {
  await assert.rejects(
    runDiscoveredTests(["strict.test.js"], {
      strictDisposition: true,
      runChild: async () => ({
        code: 0,
        signal: null,
        stdout: "# tests 1\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 1\n",
        stderr: "",
        output: "",
      }),
    }),
    /test_disposition_not_release_green/,
  );
});

test("strict disposition fails closed when the child emits no summary", async () => {
  await assert.rejects(
    runDiscoveredTests(["strict.test.js"], {
      strictDisposition: true,
      runChild: async () => ({ code: 0, signal: null, stdout: "", stderr: "", output: "" }),
    }),
    /test_disposition_summary_missing/,
  );
});
