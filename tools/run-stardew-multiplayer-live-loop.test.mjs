import assert from "node:assert/strict";
import test from "node:test";

import { deriveLoopVerdict, parseLoopArgs, parseLoopResult } from "./run-stardew-multiplayer-live-loop.mjs";

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
