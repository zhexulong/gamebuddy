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

test("a report that measured nothing is blocked, never passed", () => {
  const verdict = deriveLoopVerdict({
    timedOut: false,
    exitCode: 0,
    driverState: "action_passed",
    loopResult: { agentTurns: 4 },
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
