import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { main, PHASE_BLOCKED, PHASE_FAIL, PHASE_NOT_MEASURED, PHASE_PASS, PHASE_STATES, phaseState, runTestPhases, testDependencyInvocations, testSuiteTotalsLine, vendorRebuildSkipReason, vendorRebuildSkipReport } from "./run-test-suite.mjs";
import { suiteTotalsLine } from "./run-tests.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");
const windowsComSpec = "C:\\Windows\\System32\\cmd.exe";
// Spelled out rather than imported from the runner, so a runner list that grows
// makes the "already present" fixture incomplete and fails the skip assertion
// instead of silently following it.
const vendorBuildEntries = Object.freeze([
  "dist/index.js",
  "dist/tavern/index.js",
  "dist/tavern/index.d.ts",
  "dist/memory/index.js",
  "dist/memory/index.d.ts",
]);

/** Materialize a vendored pi-plugin root carrying exactly `entries`. */
async function withVendorPluginRoot(entries, run) {
  const vendorPluginRoot = await mkdtemp(join(tmpdir(), "run-test-suite-vendor-"));
  try {
    for (const entry of entries) {
      const file = join(vendorPluginRoot, entry);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "");
    }
    return await run(vendorPluginRoot);
  } finally {
    await rm(vendorPluginRoot, { recursive: true, force: true });
  }
}

test("the skip report names the reason and the two commands it dropped", () => {
  const report = vendorRebuildSkipReport();
  assert.match(report, /^host_test_dependency_step_skipped:reason=/);
  assert.ok(report.includes(vendorRebuildSkipReason));
  assert.ok(report.includes("magic_context_vendor_install (bun install --cwd ../vendor/magic-context --frozen-lockfile)"));
  assert.ok(report.includes("magic_context_vendor_build (bun run --cwd ../vendor/magic-context/packages/pi-plugin build)"));
});

test("Windows dependency preparation invokes fixed pnpm through ComSpec and a CI-provided Bun executable", async () => {
  await withVendorPluginRoot([], (vendorPluginRoot) => {
    const { skipReason, invocations } = testDependencyInvocations({
      platform: "win32",
      comSpec: windowsComSpec,
      bunExecutable: process.execPath,
      vendorPluginRoot,
    });
    assert.equal(skipReason, null);
    assert.deepEqual({ command: invocations[0].command, args: invocations[0].args.slice(0, 3), cwd: invocations[0].cwd }, {
      command: windowsComSpec,
      args: ["/d", "/s", "/c"],
      cwd: repositoryRoot,
    });
    assert.equal(invocations[1].cwd, hostRoot);
    assert.equal(invocations[2].cwd, hostRoot);
    assert.equal(invocations[0].args[3], "call pnpm.cmd --filter @gamebuddy/voice-protocol build");
    assert.equal(invocations[1].command, process.execPath);
    assert.equal(invocations[2].command, process.execPath);
    assert.deepEqual(invocations[1].args, ["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"]);
    assert.deepEqual(invocations[2].args, ["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"]);
  });
});

test("a checkout already carrying the vendor build output skips the rebuild under the named reason", async () => {
  await withVendorPluginRoot(vendorBuildEntries, (vendorPluginRoot) => {
    // No bunExecutable override: the skipped rebuild is Bun's only consumer, so
    // the developer-machine path must not fail on an executable it never uses.
    const { skipReason, invocations } = testDependencyInvocations({ platform: "win32", comSpec: windowsComSpec, vendorPluginRoot });
    assert.equal(skipReason, vendorRebuildSkipReason);
    assert.deepEqual(invocations.map((entry) => entry.command), [windowsComSpec]);
    assert.equal(invocations[0].args[3], "call pnpm.cmd --filter @gamebuddy/voice-protocol build");
  });
});

test("a checkout without the complete vendor build output plans the rebuild", async () => {
  for (const entries of [[], vendorBuildEntries.slice(0, -1)]) {
    await withVendorPluginRoot(entries, (vendorPluginRoot) => {
      const { skipReason, invocations } = testDependencyInvocations({
        platform: "win32",
        comSpec: windowsComSpec,
        bunExecutable: process.execPath,
        vendorPluginRoot,
      });
      assert.equal(skipReason, null);
      assert.deepEqual(invocations.map((entry) => entry.command), [windowsComSpec, process.execPath, process.execPath]);
      assert.deepEqual(invocations[1].args, ["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"]);
      assert.deepEqual(invocations[2].args, ["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"]);
    });
  }
});

test("Windows dependency preparation rejects an unsafe command processor", async () => {
  await withVendorPluginRoot([], (vendorPluginRoot) => {
    assert.throws(
      () => testDependencyInvocations({
        platform: "win32",
        comSpec: "C:\\Windows\\System32\\cmd.exe & whoami",
        bunExecutable: process.execPath,
        vendorPluginRoot,
      }),
      /test_dependency_command_processor_invalid/,
    );
  });
});

test("a missing or unusable Bun names GAMEBUDDY_BUN_EXECUTABLE and what it must point at", async () => {
  await withVendorPluginRoot([], (vendorPluginRoot) => {
    assert.throws(
      () => testDependencyInvocations({ platform: "win32", comSpec: windowsComSpec, bunExecutable: "", vendorPluginRoot }),
      /test_dependency_bun_executable_unset: set GAMEBUDDY_BUN_EXECUTABLE to the absolute path of an existing bun\.exe/,
    );
    assert.throws(
      () => testDependencyInvocations({ platform: "win32", comSpec: windowsComSpec, bunExecutable: "bun.ps1", vendorPluginRoot }),
      /test_dependency_bun_executable_invalid: set GAMEBUDDY_BUN_EXECUTABLE to the absolute path of an existing bun\.exe/,
    );
    assert.throws(
      () => testDependencyInvocations({
        platform: "win32",
        comSpec: windowsComSpec,
        bunExecutable: "C:\\missing\\bun.exe",
        vendorPluginRoot,
      }),
      /test_dependency_bun_executable_missing: C:\\missing\\bun\.exe is not an existing file; set GAMEBUDDY_BUN_EXECUTABLE/,
    );
  });
});

test("non-Windows dependency preparation retains direct fixed executable invocations", async () => {
  await withVendorPluginRoot([], (vendorPluginRoot) => {
    const { skipReason, invocations } = testDependencyInvocations({ platform: "linux", vendorPluginRoot });
    assert.equal(skipReason, null);
    assert.deepEqual(invocations, [
      { command: "pnpm", args: ["--filter", "@gamebuddy/voice-protocol", "build"], cwd: repositoryRoot },
      { command: "bun", args: ["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"], cwd: hostRoot },
      { command: "bun", args: ["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"], cwd: hostRoot },
    ]);
  });
});
/** Run `body` with console.error captured, so a summary line can be asserted byte for byte. */
async function withCapturedErrorLines(body) {
  const lines = [];
  const originalError = console.error;
  console.error = (line) => lines.push(line);
  try {
    return { lines, outcome: await body().then(() => null, (error) => error) };
  } finally {
    console.error = originalError;
  }
}

/** A suite reading: what the batch runner hands this layer for one suite. */
function counted(files, tests, { fail = 0, skipped = 0, batchesWithoutSummary = 0 } = {}) {
  return { files, tests, pass: tests - fail - skipped, fail, skipped, batchesWithoutSummary };
}

/**
 * A phase with a counted suite behind it, and either a pass or its own named failure.
 *
 * The reading is what a real phase returns. A fixture that returned NOTHING is the `a suite published no counts` case,
 * which is asserted on purpose below rather than by every other test in this file.
 */
function fixturePhase(suite, { fails = false, ran, reading = counted(1, 2) } = {}) {
  return {
    suite,
    run: async () => {
      ran?.push(suite);
      if (!fails) return reading;
      const error = new Error(`fixture_phase_failed:${suite}`);
      if (reading !== undefined) error.reading = reading;
      throw error;
    },
  };
}

/**
 * A phase that could not measure: the one prerequisite it declares is absent, and the record names it and its remedy.
 *
 * The shape is the one `compiled-test-bootstrap.mjs` throws, spelled here rather than imported: importing that module
 * binds the real helper pair, which is the state under test - a fixture that needed it could only run on a machine where
 * there is nothing to block.
 */
const fixtureBlocker = Object.freeze({
  code: "windows_stale_lock_reclaimer_unavailable",
  requirement:
    "the verified build helper pair host/native/windows-stale-lock-reclaimer/.dist/win-x64 (GameBuddy.WindowsStaleLockReclaimer.exe and windows-stale-lock-reclaimer.manifest.json)",
  publish: "node host/scripts/build-windows-stale-lock-reclaimer.mjs (on Windows, with the .NET SDK pinned by global.json)",
  cause: "fixture: the pair is absent",
});

function blockedPhase(suite, blocker = fixtureBlocker) {
  return {
    suite,
    run: async () => {
      const error = new Error(`${blocker.code}: ${blocker.requirement}`);
      error.blocker = blocker;
      throw error;
    },
  };
}

/** The one gate line a run printed, so a test can read a field out of it instead of matching the whole line twice. */
function gateLineOf(lines) {
  return lines.find((line) => line.startsWith("host_test_suite_phase_states:"));
}

test("every phase runs by default and the summary says so", async () => {
  const { lines, outcome } = await withCapturedErrorLines(() => runTestPhases([fixturePhase("compiled"), fixturePhase("scripts")], { now: () => 0 }));
  assert.equal(outcome, null);
  assert.deepEqual(lines, [
    "host_test_phase_state:suite=compiled:state=pass:files=1:tests=2:pass=2:fail=0:skipped=0",
    "host_test_phase_state:suite=scripts:state=pass:files=1:tests=2:pass=2:fail=0:skipped=0",
    "host_test_suite_phase_states:a_phase_that_cannot_measure_is_not_a_failure:phases examined 2 of 2 · pass 2 · fail 0 · blocked 0 · not_measured 0 · compiled=pass(files 1, tests 2) · scripts=pass(files 1, tests 2)",
    "host_test_suite_total:files 2 · tests 4 · pass 4 · fail 0 · skipped 0 · batches_without_a_summary: 0 · suites_read 2 of 2",
    "host_test_suite_phases:phases_total 2 · wall_ms 0",
  ]);
});

test("a failing phase does not hide the phase after it", async () => {
  const ran = [];
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases([fixturePhase("compiled", { fails: true, ran }), fixturePhase("scripts", { fails: true, ran })], { now: () => 0 }),
  );
  assert.deepEqual(ran, ["compiled", "scripts"], "the phase after a failing one still runs");
  assert.match(outcome.message, /test_suite_failed:2 phase\(s\): compiled, scripts/u);
  assert.match(outcome.message, /compiled: fixture_phase_failed:compiled/u);
  assert.match(outcome.message, /scripts: fixture_phase_failed:scripts/u);
  assert.match(
    outcome.message,
    /phases examined 2 of 2 · pass 0 · fail 2 · blocked 0 · not_measured 0/u,
    "the error carries the gate line too, so the exit code and the line say the same thing",
  );
  assert.deepEqual(lines, [
    "host_test_phase_state:suite=compiled:state=fail:files=1:tests=2:pass=2:fail=0:skipped=0",
    "host_test_phase_state:suite=scripts:state=fail:files=1:tests=2:pass=2:fail=0:skipped=0",
    "host_test_suite_phase_states:a_phase_that_cannot_measure_is_not_a_failure:phases examined 2 of 2 · pass 0 · fail 2 · blocked 0 · not_measured 0 · compiled=fail(files 1, tests 2) · scripts=fail(files 1, tests 2)",
    "host_test_suite_total:files 2 · tests 4 · pass 4 · fail 0 · skipped 0 · batches_without_a_summary: 0 · suites_read 2 of 2",
    "host_test_suite_phases:phases_total 2 · wall_ms 0",
  ]);
});

test("a compiled failure still runs the script phase", async () => {
  const ran = [];
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases([fixturePhase("compiled", { fails: true, ran }), fixturePhase("scripts", { ran })], { now: () => 0 }),
  );
  assert.deepEqual(ran, ["compiled", "scripts"]);
  assert.match(outcome.message, /test_suite_failed:1 phase\(s\): compiled/u);
  assert.deepEqual(lines, [
    "host_test_phase_state:suite=compiled:state=fail:files=1:tests=2:pass=2:fail=0:skipped=0",
    "host_test_phase_state:suite=scripts:state=pass:files=1:tests=2:pass=2:fail=0:skipped=0",
    "host_test_suite_phase_states:a_phase_that_cannot_measure_is_not_a_failure:phases examined 2 of 2 · pass 1 · fail 1 · blocked 0 · not_measured 0 · compiled=fail(files 1, tests 2) · scripts=pass(files 1, tests 2)",
    "host_test_suite_total:files 2 · tests 4 · pass 4 · fail 0 · skipped 0 · batches_without_a_summary: 0 · suites_read 2 of 2",
    "host_test_suite_phases:phases_total 2 · wall_ms 0",
  ]);
});

test("--fail-fast ends at the first failing phase and names the phase it did not run", async () => {
  const ran = [];
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases([fixturePhase("compiled", { fails: true, ran }), fixturePhase("scripts", { ran })], {
      failFast: true,
      now: () => 0,
    }),
  );
  assert.deepEqual(ran, ["compiled"]);
  assert.match(outcome.message, /host_test_suite_phase_not_run:suite=scripts:reason=fail_fast/u);
  assert.deepEqual(lines, [
    "host_test_phase_state:suite=compiled:state=fail:files=1:tests=2:pass=2:fail=0:skipped=0",
    "host_test_suite_phase_not_run:suite=scripts:reason=fail_fast",
    "host_test_suite_phase_states:a_phase_that_cannot_measure_is_not_a_failure:phases examined 1 of 2 · pass 0 · fail 1 · blocked 0 · not_measured 0 · not_run 1 · compiled=fail(files 1, tests 2)",
    "host_test_suite_total:files 1 · tests 2 · pass 2 · fail 0 · skipped 0 · batches_without_a_summary: 0 · suites_read 1 of 2",
    "host_test_suite_phases:phases_total 2 · remaining 1 not run · phases_not_run 1 · wall_ms 0",
  ]);
});

test("a red preflight blocks every phase and keeps the preflight's own reason", async () => {
  const ran = [];
  const { lines, outcome } = await withCapturedErrorLines(() =>
    main({
      argv: [],
      preflight: async () => {
        throw new Error("host_windows_test_preflight:blocked");
      },
      phases: [fixturePhase("compiled", { ran }), fixturePhase("scripts", { ran })],
    }),
  );
  assert.match(outcome.message, /host_windows_test_preflight:blocked/u, "the preflight's own reason survives");
  assert.deepEqual(ran, [], "no phase runs behind a red preflight");
  assert.deepEqual(lines, [
    "host_test_phase_state:suite=compiled:state=not_measured:cause=preflight_failed",
    "host_test_phase_state:suite=scripts:state=not_measured:cause=preflight_failed",
    "host_test_suite_phase_states:a_phase_that_cannot_measure_is_not_a_failure:phases examined 2 of 2 · pass 0 · fail 0 · blocked 0 · not_measured 2 · compiled=not_measured · scripts=not_measured",
  ]);
});

// ---------------------------------------------------------------------------------------------------------------
// `a_phase_that_cannot_measure_is_not_a_failure`
//
// MEASURED (the run this unit answers): one absent helper pair turned the whole compiled phase into
// `files 501 · tests 501 · pass 0 · fail 501` in about 70 ms per file, because every child died at load on the same
// prerequisite. The component itself is `32 pass / 0 fail / 1 skipped`, and its one skip already says the word
// `BLOCKED`. The suite now has that word too, and `fail 501` is unreachable for this state.
// ---------------------------------------------------------------------------------------------------------------

test("a phase whose prerequisite cannot be verified is blocked by name, not one failure per test file", async () => {
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases([blockedPhase("compiled"), fixturePhase("scripts")], { now: () => 0 }),
  );

  const blockedLine = lines.find((line) => line.startsWith("host_test_phase_blocked:"));
  assert.ok(blockedLine.includes("code=windows_stale_lock_reclaimer_unavailable"), blockedLine);
  assert.ok(blockedLine.includes("requirement=the verified build helper pair"), blockedLine);
  assert.ok(blockedLine.includes("publish=node host/scripts/build-windows-stale-lock-reclaimer.mjs"), blockedLine);
  assert.equal(
    lines.find((line) => line.startsWith("host_test_phase_state:suite=compiled:")),
    "host_test_phase_state:suite=compiled:state=blocked:blocker=windows_stale_lock_reclaimer_unavailable",
  );
  assert.equal(
    gateLineOf(lines),
    "host_test_suite_phase_states:a_phase_that_cannot_measure_is_not_a_failure:phases examined 2 of 2 · pass 1 · fail 0 · blocked 1 · not_measured 0 · compiled=blocked(windows_stale_lock_reclaimer_unavailable) · scripts=pass(files 1, tests 2)",
    "the gate line carries the other phase's reading beside the blocked one's name",
  );
  assert.equal(
    lines.find((line) => line.startsWith("host_test_suite_total:")),
    "host_test_suite_total:files 1 · tests 2 · pass 2 · fail 0 · skipped 0 · batches_without_a_summary: 0 · suites_read 1 of 2 · suites_without_a_reading: 1",
    "the blocked phase measured nothing, so it contributes no files and no tests: `files 501 / fail 501` is unreachable for this state",
  );
  assert.match(outcome.message, /test_suite_blocked:1 phase\(s\): compiled=windows_stale_lock_reclaimer_unavailable/u);
  assert.doesNotMatch(outcome.message, /test_suite_failed/u, "a blocked phase is not a failure");
  assert.match(outcome.message, /publish=node host\/scripts\/build-windows-stale-lock-reclaimer\.mjs/u);
});

test("the gate prints one count per declared state, and they add up to the phases it examined", async () => {
  const { lines } = await withCapturedErrorLines(() =>
    runTestPhases([blockedPhase("compiled"), fixturePhase("scripts")], { now: () => 0 }),
  );
  const gate = gateLineOf(lines);
  const counts = PHASE_STATES.map((state) => {
    const match = new RegExp(`(?:^|· )${state} (\\d+)(?: ·|$)`, "u").exec(gate);
    assert.notEqual(match, null, `the gate line states no count for the declared state ${state}: ${gate}`);
    return Number(match[1]);
  });
  assert.equal(
    counts.reduce((total, count) => total + count, 0),
    2,
    "every phase the run examined is counted in exactly one declared state, so no phase can vanish from the arithmetic",
  );
});

test("phaseState keeps the four states apart at their boundaries", () => {
  const withBlocker = Object.assign(new Error("fixture_blocked"), { blocker: fixtureBlocker });
  assert.equal(phaseState({ error: withBlocker }), PHASE_BLOCKED);
  assert.equal(phaseState({ error: new Error("fixture_phase_failed"), reading: counted(1, 2) }), PHASE_FAIL);
  assert.equal(
    phaseState({ reading: counted(1, 2, { fail: 1 }) }),
    PHASE_FAIL,
    "a phase that returned a reading holding failing tests is a failure, never a pass",
  );
  assert.equal(phaseState({}), PHASE_NOT_MEASURED);
  assert.equal(phaseState({ reading: counted(0, 0) }), PHASE_BLOCKED, "a population that produced no test is blocked, not passed");
  assert.equal(phaseState({ reading: counted(1, 2) }), PHASE_PASS);
});

// ---------------------------------------------------------------------------------------------------------------
// The one total: how many TESTS failed, not only how many files.
//
// MEASURED (the run this unit answers): `pnpm --dir host test` published 452 files, 46 batches and 18 failing files in
// 21m07s and could NOT say how many tests failed, because only 3 of 46 batch summaries printed a count. Every report
// that day wrote `tests: not measured`. The line below is that reading, and the cases beneath it are the two ways it
// can be hollow: a suite that published no counts, and a total of zero.
// ---------------------------------------------------------------------------------------------------------------

test("the one total is the two suites added up, published before anything can throw", async () => {
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases(
      [
        fixturePhase("compiled", { reading: counted(450, 1_180) }),
        fixturePhase("scripts", { reading: counted(2, 20) }),
      ],
      { now: () => 0 },
    ),
  );

  assert.equal(outcome, null);
  assert.equal(
    lines.filter((line) => line.startsWith("host_test_suite_total:")).length,
    1,
    "one line, not one per suite: a phase is not the run",
  );
  assert.equal(
    lines.at(-2),
    "host_test_suite_total:files 452 · tests 1200 · pass 1200 · fail 0 · skipped 0 · batches_without_a_summary: 0 · suites_read 2 of 2",
  );
});

test("a red suite still contributes its count to the total", async () => {
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases(
      [
        fixturePhase("compiled", { fails: true, reading: counted(10, 40, { fail: 3 }) }),
        fixturePhase("scripts", { reading: counted(1, 5) }),
      ],
      { now: () => 0 },
    ),
  );

  assert.match(outcome.message, /test_suite_failed:1 phase\(s\): compiled/u);
  assert.equal(
    lines.find((line) => line.startsWith("host_test_suite_total:")),
    "host_test_suite_total:files 11 · tests 45 · pass 42 · fail 3 · skipped 0 · batches_without_a_summary: 0 · suites_read 2 of 2",
    "the phase that failed is the one whose count matters most: it must not vanish from the total",
  );
});

test("a suite that published no counts at all is missing coverage, not a green phase", async () => {
  const { lines, outcome } = await withCapturedErrorLines(() =>
    runTestPhases([{ suite: "compiled", run: async () => {} }, fixturePhase("scripts")], { now: () => 0 }),
  );

  assert.notEqual(outcome, null, "a phase with no reading cannot be reported as a pass");
  assert.match(outcome.message, /test_suite_reading_missing:compiled/u);
  assert.equal(
    lines.find((line) => line.startsWith("host_test_suite_total:")),
    "host_test_suite_total:files 1 · tests 2 · pass 2 · fail 0 · skipped 0 · batches_without_a_summary: 0 · suites_read 1 of 2 · suites_without_a_reading: 1",
    "and the line says which suite the total is missing",
  );
});

test("zero counted tests is a blocked reading, never a green suite", async () => {
  const { outcome } = await withCapturedErrorLines(() =>
    runTestPhases(
      [fixturePhase("compiled", { reading: counted(0, 0) }), fixturePhase("scripts", { reading: counted(0, 0) })],
      { now: () => 0 },
    ),
  );

  assert.match(outcome.message, /test_suite_totals_blocked:no test was counted/u);
  assert.match(outcome.message, /host_test_suite_total:files 0 · tests 0/u);
});

test("a suite's own totals line names the tests it read and the batches that reported nothing", async () => {
  // The batch runner's line, derived from the same fields the phase runner adds up: one spelling of a fact, two readers.
  const reading = counted(12, 90, { fail: 1, skipped: 3, batchesWithoutSummary: 2 });
  const totals = suiteTotalsLine({ ...reading, filesWithoutSummary: 2 });
  assert.equal(
    totals,
    "host_test_suite_totals:files 12 · tests 90 · pass 86 · fail 1 · skipped 3 · batches_without_a_summary: 2 · files_without_a_summary: 2",
  );
});
