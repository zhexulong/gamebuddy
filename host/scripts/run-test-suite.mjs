import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { withTestArtifactLock } from "./test-artifact-lock.mjs";
import { runCompiledTests, runScriptTests } from "./run-tests.mjs";

const execFileAsync = promisify(execFile);
const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");
const vendorPluginRootPath = resolve(repositoryRoot, "vendor", "magic-context", "packages", "pi-plugin");
const cmdMetacharacter = /[&|<>^()%!\r\n]/;

// These are the only commands this suite is permitted to invoke through cmd.
// They stay as argv-like fixed data so no caller-controlled shell text exists.
// `vendorRebuild` marks the steps whose only product is the vendored pi-plugin
// build output, so they are the steps the presence of that output makes
// redundant.
const testDependencyCommands = Object.freeze([
  Object.freeze({ step: "voice_protocol_build", command: "pnpm", args: Object.freeze(["--filter", "@gamebuddy/voice-protocol", "build"]), cwd: repositoryRoot, vendorRebuild: false }),
  Object.freeze({ step: "magic_context_vendor_install", command: "bun", args: Object.freeze(["install", "--cwd", "../vendor/magic-context", "--frozen-lockfile"]), cwd: hostRoot, vendorRebuild: true }),
  Object.freeze({ step: "magic_context_vendor_build", command: "bun", args: Object.freeze(["run", "--cwd", "../vendor/magic-context/packages/pi-plugin", "build"]), cwd: hostRoot, vendorRebuild: true }),
]);
const vendorRebuildCommands = testDependencyCommands.filter((entry) => entry.vendorRebuild);

/**
 * The vendor build output the compiled suite resolves: the vendored pi-plugin
 * package's declared `.` import entry (the file `resolveMagicContextExtensionEntry`
 * loads) and its `tavern`/`memory` subpath exports, each as the runtime bundle
 * and the declaration the Host typechecks against. `dist/index.d.ts` is absent
 * on purpose: the package declares no `types` for its `.` export and no source
 * imports that entry, so a successful build never emits it.
 */
const vendorBuildEntries = Object.freeze([
  "dist/index.js",
  "dist/tavern/index.js",
  "dist/tavern/index.d.ts",
  "dist/memory/index.js",
  "dist/memory/index.d.ts",
]);

/**
 * Named, bounded skip reason for the vendored pi-plugin rebuild.
 *
 * It is a condition on the artifact the step produces, never an operator
 * switch: a checkout that lacks that output - a fresh clone, or a CI job whose
 * own vendor build has not run - still runs the rebuild, so no path can skip
 * work that was never done.
 */
export const vendorRebuildSkipReason =
  "the vendored pi-plugin build output this suite resolves is already present, so the fixed bun install and pi-plugin build would only reproduce it";

function isRegularFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function vendorBuildPresent(vendorPluginRoot) {
  return vendorBuildEntries.every((entry) => isRegularFile(resolve(vendorPluginRoot, entry)));
}

function fixedWindowsCommandToken(token) {
  // The dependency manifest contains only fixed argv tokens. cmd's `call`
  // treats a quoted first argument differently, so do not quote these tokens.
  if (typeof token !== "string" || !/^[A-Za-z0-9@._/:=-]+$/.test(token))
    throw new Error("invalid_test_dependency_command_token");
  return token;
}

function windowsCommandProcessor(comSpec) {
  if (typeof comSpec !== "string" || !/^[A-Za-z]:\\.+\.exe$/i.test(comSpec) || comSpec.includes("\0") || cmdMetacharacter.test(comSpec))
    throw new Error("test_dependency_command_processor_invalid");
  return comSpec;
}

const bunExecutableRemedy =
  "set GAMEBUDDY_BUN_EXECUTABLE to the absolute path of an existing bun.exe (the file oven-sh/setup-bun installs, or %APPDATA%\\npm\\node_modules\\bun\\bin\\bun.exe); the npm bun.ps1 shim on PATH is deliberately rejected because this runner invokes fixed argv and cannot execute it";

function configuredBunExecutable(bunExecutable) {
  if (bunExecutable === undefined || bunExecutable === "")
    throw new Error(`test_dependency_bun_executable_unset: ${bunExecutableRemedy}`);
  if (typeof bunExecutable !== "string" || !/^[A-Za-z]:\\.+\.exe$/i.test(bunExecutable) || bunExecutable.includes("\0") || cmdMetacharacter.test(bunExecutable))
    throw new Error(`test_dependency_bun_executable_invalid: ${bunExecutableRemedy}`);
  if (!isRegularFile(bunExecutable))
    throw new Error(`test_dependency_bun_executable_missing: ${bunExecutable} is not an existing file; ${bunExecutableRemedy}`);
  return bunExecutable;
}

function plannedInvocation(entry, { platform, comSpec, bunExecutable }) {
  if (platform !== "win32") return Object.freeze({ command: entry.command, args: entry.args, cwd: entry.cwd });
  if (entry.command === "bun") {
    return Object.freeze({
      command: configuredBunExecutable(bunExecutable),
      args: entry.args,
      cwd: entry.cwd,
    });
  }
  // cmd parses a quoted token after `call` as a literal executable name.
  // The manifest is strictly validated to fixed, whitespace-free tokens, so
  // unquoted concatenation preserves its argv semantics without shell input.
  const command = `${fixedWindowsCommandToken(entry.command)}.cmd`;
  const commandText = `call ${command} ${entry.args.map(fixedWindowsCommandToken).join(" ")}`;
  return Object.freeze({
    command: windowsCommandProcessor(comSpec),
    args: Object.freeze(["/d", "/s", "/c", commandText]),
    cwd: entry.cwd,
  });
}

/**
 * Return the fixed dependency-preparation plan for this machine: the
 * invocations to run, and the named reason the vendored pi-plugin rebuild was
 * dropped when its build output is already on disk.
 *
 * Windows requires an absolute CI-provided Bun executable. The vendored
 * rebuild is Bun's only consumer here, so Bun is validated exactly when that
 * rebuild is planned - a checkout that already carries the output does not fail
 * on an executable it would never invoke.
 */
export function testDependencyInvocations({
  platform = process.platform,
  comSpec = process.env.ComSpec,
  bunExecutable = process.env.GAMEBUDDY_BUN_EXECUTABLE,
  vendorPluginRoot = vendorPluginRootPath,
} = {}) {
  const vendorRebuildNeeded = !vendorBuildPresent(vendorPluginRoot);
  return Object.freeze({
    skipReason: vendorRebuildNeeded ? null : vendorRebuildSkipReason,
    invocations: Object.freeze(
      testDependencyCommands
        .filter((entry) => vendorRebuildNeeded || !entry.vendorRebuild)
        .map((entry) => plannedInvocation(entry, { platform, comSpec, bunExecutable })),
    ),
  });
}

/**
 * The one line a skipped rebuild prints: name the reason and the fixed commands
 * the skip dropped, because a silent skip reads as a step that ran.
 */
export function vendorRebuildSkipReport() {
  const skipped = vendorRebuildCommands
    .map((entry) => `${entry.step} (${[entry.command, ...entry.args].join(" ")})`)
    .join("; ");
  return `host_test_dependency_step_skipped:reason=${vendorRebuildSkipReason}:skipped=${skipped}`;
}

async function prepareTestDependencies() {
  const { skipReason, invocations } = testDependencyInvocations();
  if (skipReason !== null) console.error(vendorRebuildSkipReport());
  for (const invocation of invocations) {
    await execFileAsync(invocation.command, invocation.args, { cwd: invocation.cwd, windowsHide: true });
  }
  const declaredArtifact = resolve(hostRoot, "node_modules", "@cortexkit", "pi-magic-context", "dist");
  if (!existsSync(declaredArtifact)) throw new Error("magic_context_declared_artifact_missing_after_build");
  await import("./sync-declared-magic-context-artifact.mjs");
}

/**
 * The Windows test preflight, run as a prerequisite rather than as a phase.
 *
 * It is the gate that says a host test could even pass on the machine this product ships to, so a red
 * one means no phase can be trusted: nothing runs, and the summary says what was missing instead of
 * turning a missing capability into a pile of confusing phase failures.
 */
async function runTestPreflight() {
  await execFileAsync(process.execPath, [resolve(repositoryRoot, "tools", "check-host-windows-test-preflight.mjs")], {
    cwd: repositoryRoot,
    windowsHide: true,
  });
}

/**
 * The preload every child of this suite runs (`runDiscoveredTests`), verified ONCE in the parent before a single child is
 * spawned.
 *
 * MEASURED: importing it per child is what turned one absent Windows helper pair into `files 501 · tests 501 · fail 501`
 * in the compiled phase and `files 43 · fail 43` in the script phase - 544 identical import failures in 70 ms each, and
 * a reading nobody could use. Verified here, the same failure is one named blocker for the phase. The requirement is
 * unchanged (the bootstrap still verifies the complete pair, and a child imported directly still refuses), and the error
 * carries `.blocker`, which is what makes the phase `blocked` rather than `fail`.
 */
async function assertBoundTestChildPreload() {
  await import("./compiled-test-bootstrap.mjs");
}

/**
 * The phases this suite runs, in order. `GAMEBUDDY_HOST_TEST_COMPILED_ONLY=1` drops the script phase; that
 * is the only thing that can narrow the suite, and the phase summary carries the count it produced.
 */
function testPhases({ env, failFast }) {
  const phases = [
    {
      suite: "compiled",
      run: () =>
        withTestArtifactLock(async () => {
          await prepareTestDependencies();
          // Use the internal implementation: the public build:test wrapper acquires
          // this same lock for standalone callers and would otherwise self-deadlock.
          await import("./build-test-artifact-locked.mjs");
          // After the build, because the preload resolves the built tree it binds into.
          await assertBoundTestChildPreload();
          // The reading is RETURNED rather than only printed: the phase runner is the only layer that can publish one
          // total for the whole suite, and it cannot add up what it never received.
          return await runCompiledTests({ keepGoing: !failFast });
        }),
    },
    // Script-level tests include lock protocol tests that intentionally invoke
    // public package scripts. They must run after the outer artifact lock closes.
    {
      suite: "scripts",
      // Their children take the same preload, so they share the same prerequisite: a phase that cannot bind it cannot
      // measure, and saying so here is the difference between one named blocker and one import failure per file.
      run: async () => {
        await assertBoundTestChildPreload();
        return await runScriptTests({ keepGoing: !failFast });
      },
    },
  ];
  return env.GAMEBUDDY_HOST_TEST_COMPILED_ONLY === "1" ? phases.filter((phase) => phase.suite === "compiled") : phases;
}

/**
 * The states a phase may report, declared once: every count below is derived from this vocabulary rather than from a
 * second hand-written list of the same words, so a state added here cannot be missing from the line that prints them.
 *
 * The four are the answer to "did this phase measure anything", and they are not interchangeable:
 *
 * - `pass` - the phase ran and its reading holds tests that did not fail.
 * - `fail` - the phase ran and something in it went red. This is the only state that is a defect in the code the
 *   phase covers.
 * - `blocked` - the phase was asked to measure and could not. Its own prerequisite could not be verified (the error
 *   carries `.blocker`, and its `code` is the name), or the population that should exist produced no test at all.
 * - `not_measured` - nothing asked. The phase ran and handed back no reading, or the run's preflight stopped before
 *   any phase started.
 *
 * A `blocked` phase is named for what would have to change, never reported as one failure per test file it would have
 * run: measured on this machine, a missing helper pair printed `files 501 · tests 501 · fail 501` in 33 s.
 */
export const PHASE_PASS = "pass";
export const PHASE_FAIL = "fail";
export const PHASE_BLOCKED = "blocked";
export const PHASE_NOT_MEASURED = "not_measured";
export const PHASE_STATES = Object.freeze([PHASE_PASS, PHASE_FAIL, PHASE_BLOCKED, PHASE_NOT_MEASURED]);

/** One phase's state, from the two things a phase can hand back: a reading, or the error that ended it. */
export function phaseState({ error, reading } = {}) {
  if (error?.blocker !== undefined) return PHASE_BLOCKED;
  if (error !== undefined) return PHASE_FAIL;
  // A reading that says tests failed is a failure even when the phase returned instead of throwing: the gate exists so
  // that a phase can never be counted as a pass over its own reading.
  if ((reading?.fail ?? 0) > 0) return PHASE_FAIL;
  if (reading === undefined) return PHASE_NOT_MEASURED;
  return reading.tests === 0 ? PHASE_BLOCKED : PHASE_PASS;
}

/** One phase's own line: its state, and the reading or the blocker code that state was derived from. */
function phaseStateLine({ suite, state, error, reading }) {
  const detail =
    error?.blocker !== undefined
      ? `:blocker=${error.blocker.code}`
      : reading === undefined
        ? ""
        : `:files=${reading.files}:tests=${reading.tests}:pass=${reading.pass}:fail=${reading.fail}:skipped=${reading.skipped ?? 0}`;
  return `host_test_phase_state:suite=${suite}:state=${state}${detail}`;
}

/**
 * The blocked phase's own reason: the code, the requirement it names, and the command that publishes it.
 *
 * A blocker that named nothing would be indistinguishable from a crash, so the missing thing and its remedy are both
 * on this one line - the same record the gate line then summarises across phases.
 */
export function phaseBlockedLine(suite, blocker) {
  const field = (value) => String(value).replaceAll(/\s+/gu, " ").trim();
  return [
    `host_test_phase_blocked:suite=${suite}`,
    `code=${blocker.code}`,
    `requirement=${field(blocker.requirement)}`,
    `publish=${field(blocker.publish)}`,
    `cause=${field(blocker.cause ?? "unspecified")}`,
  ].join(" · ");
}

/** The code a blocked phase is named by, whether its blocker is a prerequisite or an empty population. */
const ZERO_TESTS_BLOCKED = "zero_tests_blocked";
function blockerCodeOf({ error }) {
  return error?.blocker?.code ?? ZERO_TESTS_BLOCKED;
}

/** A failed phase's own message, or - for a phase that returned instead of throwing - the reading that made it a failure. */
function failureMessageOf({ error, reading }) {
  if (error instanceof Error) return error.message;
  if (error !== undefined) return String(error);
  return `a reading with ${reading?.fail ?? "unreadable"} failing test(s) and no error`;
}

/** One line per blocked phase: the blocker it names and its remedy, or the empty population it measured. */
function blockedReasonLine({ suite, error }) {
  return error?.blocker === undefined
    ? `host_test_phase_blocked:suite=${suite} · code=${ZERO_TESTS_BLOCKED} · cause=the phase counted no test, so its population is empty`
    : phaseBlockedLine(suite, error.blocker);
}

/**
 * THE GATE `a_phase_that_cannot_measure_is_not_a_failure`: the phases this runner declared, how many of them measured
 * something, and what each one reported.
 *
 * <p>
 * WHY ONE LINE. A phase is not the run, and a run's verdict is not a phase's. The measured defect: one absent helper
 * pair printed `phases examined 2 of 2 · failed 1` beside `suites_read 1 of 2`, so the phase that never measured
 * anything and the phase that ran 43 files were both folded into one "failed", and neither line said which state the
 * other phase was in. So the counts come first, then every phase's own state and reading on the same line: a blocked
 * phase cannot be read as the suite's verdict, and one phase's reading cannot stand for the other's.
 * </p>
 * <p>
 * The invariant this line publishes is `pass + fail + blocked + not_measured === phases examined`: a phase that
 * reported nothing is `not_measured`, not absent from the arithmetic. `not_run` is the fifth reading and is printed
 * only when `--fail-fast` left a declared phase without any state at all.
 * </p>
 */
export function phaseStatesLine({ states, phasesTotal, notRun = [] }) {
  const countOf = (state) => states.filter((record) => record.state === state).length;
  const counts = PHASE_STATES.map((state) => `${state} ${countOf(state)}`);
  const readings = states.map((record) => {
    const detail =
      record.error?.blocker !== undefined
        ? `(${record.error.blocker.code})`
        : record.reading === undefined
          ? ""
          : `(files ${record.reading.files}, tests ${record.reading.tests})`;
    return `${record.suite}=${record.state}${detail}`;
  });
  const parts = [
    `host_test_suite_phase_states:a_phase_that_cannot_measure_is_not_a_failure:phases examined ${states.length} of ${phasesTotal}`,
    ...counts,
  ];
  if (notRun.length > 0) parts.push(`not_run ${notRun.length}`);
  if (states.length === 0) parts.push("no_phase_reported_a_state");
  parts.push(...readings);
  return parts.join(" · ");
}

/** What this run covered, published on every exit path - the coverage the gate line's per-phase counts do not carry. */
function phasesSummaryLine({ phasesTotal, notRun, wallMs }) {
  const remaining = notRun.length;
  const parts = [`host_test_suite_phases:phases_total ${phasesTotal}`];
  if (remaining > 0) parts.push(`remaining ${remaining} not run`, `phases_not_run ${remaining}`);
  parts.push(`wall_ms ${wallMs}`);
  return parts.join(" · ");
}

/**
 * THE ONE TOTAL for the whole run: every suite's own test counts, added up and published as one line.
 *
 * `<p>`
 * WHY. The suite published `452 files, 46 batches, 18 failing files` and nothing that said how many TESTS failed, because
 * only three of its 46 batch summaries printed a count - so every report from that day wrote `tests: not measured`, and
 * "18 files failed" cannot tell one failing assertion from four hundred. Each file's own counts are read where the child
 * prints them (the batch runner), and this is the layer that adds the two suites together, because a phase is not the
 * run.
 * `</p>`
 * `<p>`
 * `suites_read` is in the line because a total built from one of two suites would otherwise read like a total: a phase
 * that threw before it batched anything hands back no reading at all, and that is missing coverage rather than zero
 * tests.
 * `</p>`
 */
export function testSuiteTotalsLine({ readings, phasesTotal, phasesWithoutReading }) {
  const sum = (key) => readings.reduce((total, reading) => total + (reading[key] ?? 0), 0);
  const parts = [
    `host_test_suite_total:files ${sum("files")}`,
    `tests ${sum("tests")}`,
    `pass ${sum("pass")}`,
    `fail ${sum("fail")}`,
    `skipped ${sum("skipped")}`,
    `batches_without_a_summary: ${sum("batchesWithoutSummary")}`,
    `suites_read ${readings.length} of ${phasesTotal}`,
  ];
  if (phasesWithoutReading > 0) parts.push(`suites_without_a_reading: ${phasesWithoutReading}`);
  if (sum("tests") === 0) parts.push("zero_tests_blocked");
  return parts.join(" · ");
}

/**
 * Run every phase and publish what ran.
 *
 * Every phase runs by default; `--fail-fast` is the interactive exception. The old default stopped at the
 * first failing phase, so the exit code answered "did the first failing phase fail" - which cannot be told
 * from "everything passed before we stopped". That is the same defect the batch runner had one level down.
 *
 * Each phase contributes exactly one state (see `PHASE_STATES`), its own line is printed where it happens, and the gate
 * line repeats every phase's state beside every other phase's reading at the end. A blocked phase is never a failure
 * and never consumes another phase's reading: the phase after it still runs, and its counts still reach the total.
 */
export async function runTestPhases(phases, { failFast = false, now = Date.now } = {}) {
  const startedAtMs = now();
  const states = [];
  const notRun = [];
  const readings = [];
  for (const [index, phase] of phases.entries()) {
    let error;
    let reading;
    try {
      reading = await phase.run();
    } catch (caught) {
      error = caught;
      // A suite that failed still counted every test it ran: the reading travels on the failure, so the total for the
      // run is not silently missing the phase that went red.
      if (caught?.reading !== undefined) reading = caught.reading;
    }
    const record = { suite: phase.suite, state: phaseState({ error, reading }), error, reading };
    states.push(record);
    if (reading !== undefined) readings.push({ suite: phase.suite, ...reading });
    // The blocker's own line comes first: it names the missing thing and the command that publishes it.
    if (error?.blocker !== undefined) console.error(phaseBlockedLine(phase.suite, error.blocker));
    console.error(phaseStateLine(record));
    // `--fail-fast` stops at a FAILING phase only. A blocked phase is a state to report, not a reason to stop, and the
    // phase after it is the one whose reading proves the suite can still measure something.
    if (record.state === PHASE_FAIL && failFast) {
      for (let rest = index + 1; rest < phases.length; rest += 1) notRun.push({ suite: phases[rest].suite, reason: "fail_fast" });
      break;
    }
  }
  const notRunLines = notRun.map((entry) => `host_test_suite_phase_not_run:suite=${entry.suite}:reason=${entry.reason}`);
  for (const line of notRunLines) console.error(line);
  const failed = states.filter((record) => record.state === PHASE_FAIL);
  const blocked = states.filter((record) => record.state === PHASE_BLOCKED);
  const notMeasured = states.filter((record) => record.state === PHASE_NOT_MEASURED);
  const gate = phaseStatesLine({ states, phasesTotal: phases.length, notRun });
  // The total is published before anything can throw: a red suite is exactly the run whose test count someone needs.
  const reportedTests = readings.reduce((total, reading) => total + (reading.tests ?? 0), 0);
  const totals = testSuiteTotalsLine({
    readings,
    phasesTotal: phases.length,
    // Every phase that published no count at all, whatever state it landed in: `suites_read N of M` and this field have
    // to account for the same population, or a blocked phase would read as a phase that simply had no tests.
    phasesWithoutReading: states.filter((record) => record.reading === undefined).length,
  });
  const summary = phasesSummaryLine({ phasesTotal: phases.length, notRun, wallMs: now() - startedAtMs });
  console.error(gate);
  console.error(totals);
  console.error(summary);
  // A phase's own message already names its files, and the per-batch lines above carry each file's own reason; this
  // aggregate is what says which phases produced them. It goes first because a real failure outranks a blocked one.
  if (failed.length > 0) {
    throw new Error(
      [
        `test_suite_failed:${failed.length} phase(s): ${failed.map((record) => record.suite).join(", ")}`,
        ...failed.map((record) => `${record.suite}: ${failureMessageOf(record)}`),
        ...notRunLines,
        gate,
        totals,
        summary,
      ].join("\n"),
    );
  }
  // THE THIRD ZERO, kept as it was: a run whose counted tests are zero is not a green suite, whatever state its phases
  // landed in. It stays distinct from `blocked` (a prerequisite or a population) and from `not_measured` (no reading
  // at all) - the totals line names it, and so does this error.
  if (reportedTests === 0) {
    throw new Error([
      "test_suite_totals_blocked:no test was counted in this run, which is not a green suite",
      // ...and when the reason is a named blocker, the reason travels with the verdict rather than only in the line above.
      ...blocked.map(blockedReasonLine),
      gate,
      totals,
      summary,
    ].join("\n"));
  }
  // The second zero that is not a pass: a phase that handed back no count at all.
  if (notMeasured.length > 0) {
    throw new Error([
      `test_suite_reading_missing:${notMeasured.map((record) => record.suite).join(", ")}`,
      "a phase published no test count at all, so the run's total is missing that suite",
      gate,
      totals,
      summary,
    ].join("\n"));
  }
  // A blocked phase is named, with the requirement and the command that publishes it - never as a failure of the code
  // it would have run, and never as a pass.
  if (blocked.length > 0) {
    throw new Error(
      [
        `test_suite_blocked:${blocked.length} phase(s): ${blocked.map((record) => `${record.suite}=${blockerCodeOf(record)}`).join(", ")}`,
        "a phase whose own prerequisite cannot be verified measures nothing; that is not a failure of the tests it would have run, and it is not a pass",
        ...blocked.map(blockedReasonLine),
        gate,
        totals,
        summary,
      ].join("\n"),
    );
  }
  return readings;
}

export async function main({ argv = process.argv, env = process.env, preflight = runTestPreflight, phases = undefined } = {}) {
  const failFast = argv.includes("--fail-fast");
  const planned = phases ?? testPhases({ env, failFast });
  try {
    await preflight();
  } catch (error) {
    // A red preflight is the SUITE's prerequisite, not a phase's: nothing started, so every declared phase reports
    // `not_measured` by name. Before this, the whole run printed `phases 0 of 2` and left the state of each phase for
    // the reader to infer from the absence.
    const states = planned.map((phase) => ({ suite: phase.suite, state: PHASE_NOT_MEASURED, cause: "preflight_failed" }));
    for (const phase of planned) console.error(`host_test_phase_state:suite=${phase.suite}:state=${PHASE_NOT_MEASURED}:cause=preflight_failed`);
    console.error(phaseStatesLine({ states, phasesTotal: planned.length }));
    throw error;
  }
  await runTestPhases(planned, { failFast });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
