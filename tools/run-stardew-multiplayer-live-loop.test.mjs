import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deriveLoopVerdict,
  derivePairedVerdict,
  isPairedRunner,
  parseLoopArgs,
  parseLoopResult,
  readRunnerReport,
} from "./run-stardew-multiplayer-live-loop.mjs";

const GAME = "D:\\Steam\\steamapps\\common\\Stardew Valley";
const BASE = [
  "--game-path",
  GAME,
  "--expected-farmhand-id",
  "1791707645062",
  "--save-name",
  "GameBuddyFixtureRebuild_451055244",
];

test("the required triple is enforced, and every refusal is a stable code", () => {
  assert.throws(() => parseLoopArgs([]), /missing_multiplayer_loop_argument:game-path/u);
  assert.throws(() => parseLoopArgs(["--game-path", GAME]), /missing_multiplayer_loop_argument:expected-farmhand-id/u);
  assert.throws(() => parseLoopArgs([...BASE, "--unknown", "x"]), /invalid_multiplayer_loop_argument:--unknown/u);
  assert.throws(
    () => parseLoopArgs(["--game-path", GAME, "--expected-farmhand-id", "abc", "--save-name", "GameBuddyFixture_X"]),
    /invalid_multiplayer_loop_expected_farmhand_id/u,
  );
  assert.throws(
    () => parseLoopArgs(["--game-path", GAME, "--expected-farmhand-id", "1791707645062", "--save-name", "NotAFixture"]),
    /invalid_multiplayer_loop_save_name/u,
  );
});

test("a duration outside the bound is refused rather than clamped", () => {
  assert.throws(
    () => parseLoopArgs([...BASE, "--duration-seconds", "-1"]),
    /invalid_multiplayer_loop_duration_seconds/u,
  );
  assert.throws(
    () => parseLoopArgs([...BASE, "--duration-seconds", "99999"]),
    /invalid_multiplayer_loop_duration_seconds/u,
  );
  assert.equal(parseLoopArgs([...BASE, "--duration-seconds", "900"]).durationSeconds, 900);
});

test("defaults are an EMPTY Host scenario and the loop runner itself", () => {
  const request = parseLoopArgs(BASE);
  // Empty is the correct default, not a placeholder: `HostAutomationConfig.IsValid` accepts an empty `FixtureScenario`
  // or one of 25 hard-coded values, and a loop needs no world precondition beyond the farmhand's own cabin. A named
  // scenario outside that list makes the Host reject its fixture configuration and never load the world (measured).
  assert.equal(request.scenario, "");
  assert.equal(request.runner, "run-stardew-native-local-player-multiplayer-live-loop-smoke.mjs");
  // An absent plan is legal: it means "observe only".
  assert.equal(request.plan, null);
  assert.equal(request.durationSeconds, 0);
});

test("a plan path that does not exist is refused, not silently ignored", () => {
  assert.throws(() => parseLoopArgs([...BASE, "--plan", "E:\\nope\\plan.json"]), /multiplayer_loop_plan_missing/u);
});

test("the loop's own JSON line is found even behind other output, and a foreign line is not", () => {
  const stdout = [
    "[stardew-fixture-roots] profileRoot=…",
    'SMAPI_LAUNCHED {"pid":1}',
    'LOOP_RESULT {"state":"passed","rubric":{"passed":false},"spoken":3}',
  ].join("\n");
  const parsed = parseLoopResult(stdout);
  assert.equal(parsed.state, "passed");
  assert.equal(parsed.spoken, 3);
  assert.deepEqual(parsed.rubric, { passed: false });
  // A driver record has `state` but no rubric: it must not be mistaken for the loop's.
  assert.equal(parseLoopResult('{"state":"action_passed","actionExitCode":0}'), null);
  assert.equal(parseLoopResult(""), null);
});

test("a gapped session cannot be reported as passed, in either report shape", () => {
  // The audit that found this derived the gate by hand: the agent path published the tail under the nested runReport key,
  // the gate read a top-level one, the value fell back to 0, and a 36 s gap produced `passed`. Both shapes must work, and
  // neither may be assumed gap-free.
  const base = { timedOut: false, exitCode: 0, driverState: "action_passed" };
  const topLevel = deriveLoopVerdict({ ...base, loopResult: { unobservedTailMs: 36_058 } });
  assert.equal(topLevel.state, "degraded");
  assert.equal(topLevel.reasonCode, "multiplayer_loop_observed_gap:36s");
  const nested = deriveLoopVerdict({ ...base, loopResult: { runReport: { unobservedTailMs: 36_058 } } });
  assert.equal(nested.state, "degraded");
  const clean = deriveLoopVerdict({ ...base, loopResult: { unobservedTailMs: 2_000 } });
  assert.equal(clean.state, "passed");
  assert.equal(clean.reasonCode, "multiplayer_loop_completed");
});

test("a plan-mode report that measured nothing is blocked, never passed", () => {
  const verdict = deriveLoopVerdict({
    timedOut: false,
    exitCode: 0,
    driverState: "action_passed",
    // `agentTurns` absent: this is a plan-mode report, so there is no agent liveness signal to accept in place of a
    // sampling measurement, and an unmeasured plan run must not read as gap-free.
    loopResult: { steps: 5 },
  });
  assert.equal(verdict.state, "blocked");
  assert.equal(verdict.reasonCode, "multiplayer_loop_observation_unmeasured");
  assert.equal(verdict.measuredTail, false);
  // A driver failure is still a failure, not a blocked-for-measurement.
  const failed = deriveLoopVerdict({ timedOut: false, exitCode: 1, driverState: "action_failed", loopResult: {} });
  assert.equal(failed.state, "failed");
  assert.match(failed.reasonCode, /^multiplayer_loop_failed:action_failed$/u);
  const timedOut = deriveLoopVerdict({ timedOut: true, exitCode: null, driverState: null, loopResult: null });
  assert.equal(timedOut.state, "blocked");
  assert.equal(timedOut.reasonCode, "multiplayer_loop_timeout");
});

test("agent mode proves liveness by its own signals, not by a latency tail", () => {
  // The audit called the tail a latency proxy: it is model generation plus the harness quiet window, so it must not
  // decide a healthy session's verdict. What decides it: the Agent spoke, and the pipe never dropped.
  const base = { timedOut: false, exitCode: 0, driverState: "action_passed" };
  const spoke = deriveLoopVerdict({ ...base, loopResult: { agentTurns: 4, connectionDropped: false } });
  assert.equal(spoke.state, "passed");
  assert.equal(spoke.reasonCode, "multiplayer_loop_agent_turn_completed");
  const silent = deriveLoopVerdict({ ...base, loopResult: { agentTurns: 0, connectionDropped: false } });
  assert.equal(silent.state, "blocked");
  assert.equal(silent.reasonCode, "multiplayer_loop_agent_spoke_nothing");
  const dropped = deriveLoopVerdict({ ...base, loopResult: { agentTurns: 4, connectionDropped: true } });
  assert.equal(dropped.state, "degraded");
  assert.equal(dropped.reasonCode, "multiplayer_loop_bridge_dropped");
  // A plan-mode report still uses its own sampling measurement, because there it IS a measurement.
  const planGap = deriveLoopVerdict({ ...base, loopResult: { unobservedTailMs: 36_058 } });
  assert.equal(planGap.state, "degraded");
});

/**
 * THE PAIRED RUN'S ROW IS IN THE DRIVER'S OWN TABLE, and that is where its WORLD is named.
 *
 * The entry passes `-Action paired_companion` for that runner, so the row it names must exist in
 * `tools/run-stardew-shared-world-action.ps1`'s `$ACTION_SETUP` and must carry the paired scenario; a name the table does
 * not have is refused by the driver (`shared_world_action_not_wired`) after both games have been materialized, which is
 * the most expensive place to learn about a typo.
 *
 * The row must NOT be `experimental`: `ActionPolicyEngine.ValidateActionPolicy` rejects an `ExperimentalActions` entry
 * that names a published or live-verified action, so a `$true` here would make the AI profile's policy invalid and the
 * companion would never act at all.
 */
test("the paired run names a driver-table row that exists, and that row opts nothing experimental in", () => {
  const script = readFileSync(new URL("./run-stardew-shared-world-action.ps1", import.meta.url), "utf8");
  const start = script.indexOf("$ACTION_SETUP = @{");
  assert.ok(start >= 0, "the driver declares its action table");
  const table = script.slice(start, script.indexOf("\n}", start));
  const rows = new Map(
    [
      ...table.matchAll(
        /^\s{4}(\w+)\s*=\s*@\{\s*scenario\s*=\s*"([^"]*)";\s*experimental\s*=\s*(\$(?:true|false))\s*\}/gmu,
      ),
    ].map((match) => [match[1], { scenario: match[2], experimental: match[3] }]),
  );
  const paired = rows.get("paired_companion");
  assert.ok(paired !== undefined, `the driver table has no paired_companion row: ${JSON.stringify([...rows.keys()])}`);
  assert.equal(paired.scenario, "native_paired_companion_v1");
  assert.equal(
    paired.experimental,
    "$false",
    "a published/live-verified action listed as experimental invalidates the policy",
  );
});

/**
 * ONE READER, TWO SHAPES - and the paired shape's verdict is its own.
 *
 * The entry used to read `loop-report.json` and nothing else, so a paired launch (whose runner writes
 * `paired-report.json` with `slices`) was `blocked/observation_unmeasured` however the four slices went. The record is
 * read from its FILE first: a real session's Chinese text reached stdout as replacement characters, and `JSON.parse`
 * refused the line.
 */
test("the paired runner's report is read from its own file, and its four slices decide the verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-loop-"));
  try {
    writeFileSync(
      join(dir, "paired-report.json"),
      JSON.stringify({
        state: "passed",
        reasonCode: "all_four_slices_passed",
        slices: [
          { slice: "s1_attention", state: "passed", reasonCode: "went_to_the_other_farmer" },
          { slice: "s2_claim", state: "passed", reasonCode: "one_took_it_one_refused_by_name:host" },
          { slice: "s3_night", state: "passed", reasonCode: "both_farmers_slept_in_the_same_night" },
          { slice: "s4_memory", state: "passed", reasonCode: "covenant_recalled" },
        ],
        rubric: { passed: true },
      }),
    );
    const read = readRunnerReport({ traceRoot: dir, stdout: "" });
    assert.equal(read.kind, "paired");
    assert.equal(read.source, "file");
    const verdict = derivePairedVerdict({
      timedOut: false,
      exitCode: 0,
      driverState: "action_passed",
      pairedReport: read.report,
    });
    assert.equal(verdict.state, "passed");
    assert.equal(verdict.reasonCode, "paired_slices_passed");

    // A report whose own state disagrees with its slices is not accepted: that is the "a verdict that ignores a third of
    // the session" defect this entry already had to fix once.
    const lying = {
      state: "passed",
      reasonCode: "all_four_slices_passed",
      slices: [
        {
          slice: "s1_attention",
          state: "not_measured",
          reasonCode: "paired_companion_placement_unconfirmed:33,16:180000",
        },
      ],
    };
    assert.equal(
      derivePairedVerdict({ timedOut: false, exitCode: 0, driverState: "action_passed", pairedReport: lying })
        .reasonCode,
      "paired_runner_report_ignores_a_slice:s1_attention:paired_companion_placement_unconfirmed:33,16:180000",
    );
    // A failed slice fails the run, and the code names WHICH slice and WHY.
    const failed = derivePairedVerdict({
      timedOut: false,
      exitCode: 0,
      driverState: "action_passed",
      pairedReport: {
        state: "failed",
        reasonCode: "actor_acted_away",
        slices: [{ slice: "s1_attention", state: "failed", reasonCode: "acted_away_from_the_other_farmer" }],
      },
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.reasonCode, "paired_slice_failed:s1_attention:acted_away_from_the_other_farmer");
    // A missing report and a timed-out driver are both blocked, and both say which one they are.
    assert.equal(
      derivePairedVerdict({ timedOut: false, exitCode: 0, driverState: "action_passed", pairedReport: null })
        .reasonCode,
      "paired_runner_report_missing",
    );
    assert.equal(
      derivePairedVerdict({ timedOut: true, exitCode: null, driverState: null, pairedReport: null }).reasonCode,
      "multiplayer_loop_timeout",
    );
    // The loop's own shape still reads, and still uses the loop's verdict. It is read from ITS OWN trace, because a run
    // writes exactly one of the two records and two in one directory is not a shape any launch produces.
    const loopDir = mkdtempSync(join(tmpdir(), "gb-loop-only-"));
    try {
      writeFileSync(
        join(loopDir, "loop-report.json"),
        JSON.stringify({ state: "passed", unobservedTailMs: 1_500, rubric: {} }),
      );
      const loop = readRunnerReport({ traceRoot: loopDir, stdout: "" });
      assert.equal(loop.kind, "loop");
      assert.equal(
        deriveLoopVerdict({ timedOut: false, exitCode: 0, driverState: "action_passed", loopResult: loop.report })
          .state,
        "passed",
      );
    } finally {
      rmSync(loopDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the paired runner is recognised by file name, and its world is refused from the command line", () => {
  assert.equal(isPairedRunner("run-stardew-native-local-player-paired-companion-live-run.mjs"), true);
  assert.equal(isPairedRunner("C:\\tools\\run-stardew-native-local-player-paired-companion-live-run.mjs"), true);
  assert.equal(isPairedRunner("run-stardew-native-local-player-multiplayer-live-loop-smoke.mjs"), false);
  // The driver's own table names this run's scenario, so a second spelling of it on the command line is refused rather
  // than silently overridden by the driver.
  assert.throws(
    () =>
      parseLoopArgs([
        ...BASE,
        "--runner",
        "run-stardew-native-local-player-paired-companion-live-run.mjs",
        "--scenario",
        "native_harvest_crop_v1",
      ]),
    /multiplayer_loop_paired_scenario_comes_from_the_driver_table/u,
  );
  const paired = parseLoopArgs([...BASE, "--runner", "run-stardew-native-local-player-paired-companion-live-run.mjs"]);
  assert.equal(paired.scenario, "");
  // The loop's own runner still takes a scenario, because it has no driver-table row.
  assert.equal(parseLoopArgs([...BASE, "--scenario", "native_harvest_crop_v1"]).scenario, "native_harvest_crop_v1");
});
