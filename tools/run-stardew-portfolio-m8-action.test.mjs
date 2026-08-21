import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("M8 action runner preserves preflight and gates mutation on the exact fresh probe", async () => {
  const source = await readFile(new URL("./run-stardew-portfolio-m8-action.mjs", import.meta.url), "utf8");
  const probeIndex = source.indexOf("client.probeMineElevator(request)");
  const actionIndex = source.indexOf("client.startMineElevator(actionRequest)");
  assert.notEqual(probeIndex, -1);
  assert.notEqual(actionIndex, -1);
  assert.ok(probeIndex < actionIndex, "--action must probe before starting the action");
  assert.match(source, /hasAction = process\.argv\.includes\("--action"\)/);
  assert.match(source, /probe\.fresh !== true/);
  assert.match(source, /probe\.entryObserved !== true/);
  assert.match(source, /probe\.currentFloor === selectedCheckpoint/);
  assert.match(source, /probe\.targetUnlocked !== true/);
  assert.match(source, /probe\.selectedCheckpoint !== selectedCheckpoint/);
  assert.match(source, /probe\.revision !== snapshot\.revision/);
  assert.match(source, /!sameScope\(probe\.scope, scope\)/);
  assert.match(source, /M8_GIVEN_READY/);
  assert.match(source, /M8_ACTION_TERMINAL/);
  assert.match(source, /terminal\.state !== "succeeded"/);
  assert.match(source, /terminal\.postcondition\?\.actualCurrentFloor !== selectedCheckpoint/);
  assert.match(source, /terminal\.postcondition\?\.freshObservation !== true/);
  assert.match(source, /terminal\.postcondition\?\.sameExecution !== true/);
  assert.match(source, /client\.readMineElevatorFreshFloor/);
  assert.match(source, /freshFloor\.requestId !== actionRequest\.requestId/);
  assert.match(source, /freshFloor\.traceId !== actionRequest\.traceId/);
  assert.match(source, /freshFloor\.executionId !== started\.executionId/);
  assert.match(source, /freshFloor\.revision <= terminal\.revision/);
  assert.match(source, /freshFloor\.currentFloor !== selectedCheckpoint/);
  assert.match(source, /freshFloor,\n {4}\}\);/);
  assert.match(source, /terminal: actionTerminal/);
  assert.doesNotMatch(
    source,
    /m8_native_save_reopen_observation_required|externally_player_confirmed_native_save_close_reopen|M8_ACTION_CLOSED/,
  );
  assert.doesNotMatch(source, /readNativeSaveReopen|SaveGame\.Save|drive-stardew-ui|P0bLifecycle/);
  assert.match(source, /m8_action_(?:trace|idem|cancel)/);
  assert.doesNotMatch(source, /Game1\.enterMine/);
  assert.doesNotMatch(source, /runM8ElevatorPreflight|drive-stardew-ui|P0bLifecycle/);
  assert.doesNotMatch(source, /keyboard|mouse|XInput|dispatcher|reflection/i);
  assert.match(source, /m8_execute_mode_not_available/);
});
