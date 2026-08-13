import assert from "node:assert/strict";
import test from "node:test";
import {
  readM8ElevatorGiven,
  replayM8ElevatorResult,
  runM8ElevatorPreflight,
} from "./run-stardew-portfolio-m8-preflight.mjs";

const scope = Object.freeze({ integrationId: "portfolio", topology: "single_player_native_companion", saveId: "save", worldId: "world", localPlayerId: "player", companionId: "companion", bindingGeneration: 1, bindingHash: "hash" });
const request = Object.freeze({ action: "select_mine_elevator_floor", requestId: "req", traceId: "trace", idempotencyKey: "idem", selectedCheckpoint: 25, expectedRevision: 7, deadlineMs: Date.now() + 60_000, cancellationToken: "cancel", scope });
const accepted = Object.freeze({ requestId: "req", traceId: "trace", executionId: "exec", phase: "accepted", revision: 7, reasonCode: "accepted" });
function identity(overrides = {}) { return { requestId: "req", traceId: "trace", executionId: "exec", ...overrides }; }
function receipt(overrides = {}) {
  const phase = (name, revision, reasonCode) => ({ ...identity(), phase: name, revision, reasonCode });
  const base = {
    ...identity(), state: "succeeded", revision: 9, reasonCode: "mine_elevator_floor_selected",
    evidence: { scope, phaseTrace: [phase("fresh_observed", 7, "fresh_observed"), phase("accepted", 7, "accepted"), phase("transition_started", 8, "mine_elevator_transition_started"), phase("postcondition", 9, "postcondition_observed"), phase("terminal", 9, "mine_elevator_floor_selected")], entryObserved: true, currentFloorBefore: 20, lowestMineLevelBefore: 25, opaqueElevatorTarget: "target", nativeElevatorTransitionObserved: true, currentFloorAfter: 25, lowestMineLevelAfter: 25, lowestMineLevelObserved: true },
    postcondition: { selectedCheckpoint: 25, actualCurrentFloor: 25, observedLowestMineLevel: 25, opaqueElevatorTarget: "target", freshObservation: true, sameExecution: true },
  };
  return { ...base, ...overrides, evidence: { ...base.evidence, ...overrides.evidence }, postcondition: { ...base.postcondition, ...overrides.postcondition } };
}
function nativeGiven(overrides = {}) {
  return { source: "target_version_native_probe", readOnly: true, saveMutationObserved: false, gameplayMutationObserved: false, terminalOutcomePresent: false, terminalRouteResult: null, topology: scope.topology, scope, locationKind: "MineShaft", worldReady: true, singlePlayer: true, masterGame: true, playerAvailable: true, currentFloor: 20, lowestMineLevel: 25, selectedCheckpoint: 25, ...overrides };
}
function freshFloor(overrides = {}) {
  return { ...identity(), source: "target_version_native_floor_reader", fresh: true, readOnly: true, saveMutationObserved: false, gameplayMutationObserved: false, scope, currentFloor: 25, terminalOutcomePresent: false, ...overrides };
}

test("Given uses only a dynamic native read-only probe and rejects terminal/static fixture facts", async () => {
  const observed = [];
  const ready = await readM8ElevatorGiven({ expectedScope: scope, observeNative: async () => { observed.push("read"); return nativeGiven(); } });
  assert.equal(ready.state, "READY");
  assert.deepEqual(observed, ["read"]);
  assert.equal((await readM8ElevatorGiven({ expectedScope: scope, observeNative: async () => nativeGiven({ terminalOutcomePresent: true }) })).state, "BLOCKED");
  assert.equal((await readM8ElevatorGiven({ expectedScope: scope, observeNative: async () => nativeGiven({ selectedCheckpoint: 0 }) })).state, "BLOCKED");
  assert.equal((await readM8ElevatorGiven({ expectedScope: scope, observeNative: async () => nativeGiven({ scope: { ...scope, forged: true } }) })).state, "BLOCKED");
});

test("Then requires exact receipt semantics and execution-correlated native fresh floor facts", async () => {
  const reads = [];
  const result = await replayM8ElevatorResult({ request, acceptedPhase: accepted, receipt: receipt(), expectedScope: scope, readFreshFloor: async (value) => { reads.push(value); return freshFloor(); } });
  assert.equal(result.state, "READY");
  assert.deepEqual(reads, [identity()]);
  const cases = [
    receipt({ postcondition: { sameExecution: false } }),
    receipt({ postcondition: { selectedCheckpoint: 30 } }),
    receipt({ evidence: { nativeElevatorTransitionObserved: false } }),
    receipt({ evidence: { lowestMineLevelObserved: false } }),
    receipt({ evidence: { scope: { ...scope, forged: true } } }),
  ];
  for (const invalid of cases)
    assert.equal((await replayM8ElevatorResult({ request, acceptedPhase: accepted, receipt: invalid, expectedScope: scope, readFreshFloor: async () => freshFloor() })).state, "BLOCKED");
  assert.equal((await replayM8ElevatorResult({ request, acceptedPhase: accepted, receipt: receipt(), expectedScope: scope, readFreshFloor: async () => freshFloor({ traceId: "other" }) })).state, "BLOCKED");
});

test("composed preflight binds Given to request without an unrelated persistence reader", async () => {
  const args = { expectedScope: scope, observeNative: async () => nativeGiven(), request, acceptedPhase: accepted, receipt: receipt(), readFreshFloor: async () => freshFloor() };
  const ready = await runM8ElevatorPreflight(args);
  assert.equal(ready.state, "PREFLIGHT_READY");
  assert.equal(Object.hasOwn(ready, "and"), false);
  const mismatch = await runM8ElevatorPreflight({ ...args, observeNative: async () => nativeGiven({ selectedCheckpoint: 30, lowestMineLevel: 30 }) });
  assert.equal(mismatch.state, "BLOCKED");
  assert.equal(mismatch.then.code, "m8_preflight_given_request_checkpoint_mismatch");
});

test("PREFLIGHT_READY is only a complete callback-backed BDD pipeline, never live closure", async () => {
  const result = await runM8ElevatorPreflight({ expectedScope: scope, observeNative: async () => nativeGiven(), request, acceptedPhase: accepted, receipt: receipt(), readFreshFloor: async () => freshFloor() });
  assert.equal(result.state, "PREFLIGHT_READY");
  assert.equal(Object.hasOwn(result, "liveClosure"), false);
  assert.equal(Object.hasOwn(result, "receiptEvidence"), false);
});
