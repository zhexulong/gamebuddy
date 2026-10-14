import assert from "node:assert/strict";
import test from "node:test";

import { parseLoopArgs, parseLoopResult } from "./run-stardew-multiplayer-live-loop.mjs";

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

test("defaults are the chat scenario and the loop runner itself", () => {
  const request = parseLoopArgs(BASE);
  assert.equal(request.scenario, "native_farmhand_chat_v1");
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
