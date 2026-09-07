import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME_CLOSURE_HARNESS_RESULT_SCHEMA,
  runGameClosure,
} from "../src/game-closure-harness.mjs";

const identity = Object.freeze({
  runIdentity: "other_game_001",
  targetProfile: Object.freeze({ gameId: "other", profileIdentity: "non-stardew" }),
  stagedArtifact: "/staged/other-game-bundle",
  scenario: Object.freeze({ gameId: "other", actionId: "ping" }),
  privateResults: Object.freeze({ actionFile: "/private/action.json", lifecycleFile: "/private/lifecycle.json" }),
  deadline: 60_000,
});

function harnessFactory({ lifecycle = "completed", failure = null, cleanup = "completed" } = {}) {
  return async () => Object.freeze({
    state: lifecycle === "completed" ? "completed" : "incomplete",
    lifecycle,
    failure,
    cleanup: Object.freeze({ state: cleanup }),
    scenarioResult: "/private/action.json",
  });
}

test("game-neutral harness stays incomplete when no action-owned verifier is provided", async () => {
  const result = await runGameClosure({
    ...identity,
    runHarness: harnessFactory({ lifecycle: "completed", cleanup: "completed" }),
  });
  assert.equal(result.schema, GAME_CLOSURE_HARNESS_RESULT_SCHEMA);
  assert.equal(result.state, "incomplete");
  assert.equal(result.lifecycle, "completed");
  assert.equal(result.cleanup.state, "completed");
  assert.equal(result.scenarioResult, null);
  assert.deepEqual(result.failure, { phase: "scenario", code: "scenario_result_missing" });
});

test("game-neutral harness exposes action-owned proof only when a verifier is injected", async () => {
  const proof = Object.freeze({ ok: true, gameId: "other" });
  const result = await runGameClosure({
    ...identity,
    runHarness: harnessFactory({ lifecycle: "completed", cleanup: "completed" }),
    verifyScenarioResult: async () => proof,
  });
  assert.equal(result.state, "completed");
  assert.equal(result.scenarioResult, proof);
});

test("game-neutral harness uses a non-Stardew-shaped phase and a non-Stardew transport", async () => {
  // Fake second game: harness uses a totally different phase vocabulary.
  const calls = [];
  const fakeHarness = async (input) => {
    calls.push(input);
    return Object.freeze({
      state: "completed",
      lifecycle: "completed",
      failure: null,
      cleanup: Object.freeze({ state: "completed" }),
      scenarioResult: "private-result-ref",
    });
  };
  const result = await runGameClosure({
    ...identity,
    runHarness: fakeHarness,
  });
  assert.equal(result.state, "incomplete");
  assert.equal(result.failure.code, "scenario_result_missing");
  assert.equal(calls.length, 1);
  // Verify that the helper does not pre-bake Stardew fields.
  const passed = calls[0];
  assert.equal(passed.runIdentity, "other_game_001");
  assert.equal(passed.targetProfile.gameId, "other");
  assert.equal(passed.scenario.gameId, "other");
});

test("fake non-Stardew phase failure does not produce a scenario proof even when cleanup is completed", async () => {
  const fakeHarness = harnessFactory({
    lifecycle: "failed",
    failure: Object.freeze({ phase: "account_snapshot", code: "harness_failed" }),
    cleanup: "completed",
  });
  let verifierCalls = 0;
  const result = await runGameClosure({
    ...identity,
    runHarness: fakeHarness,
    verifyScenarioResult: async () => { verifierCalls += 1; return Object.freeze({ ok: true }); },
  });
  assert.equal(result.state, "incomplete");
  assert.equal(result.lifecycle, "failed");
  assert.equal(result.failure.phase, "account_snapshot");
  assert.equal(result.failure.code, "harness_failed");
  assert.equal(result.scenarioResult, null);
  assert.equal(verifierCalls, 0);
});

test("harness throws a non-Stardew error and the helper maps it to harness_failed with no scenario proof", async () => {
  const result = await runGameClosure({
    ...identity,
    runHarness: async () => { throw new Error("transient_harness_error"); },
    verifyScenarioResult: async () => Object.freeze({ ok: true }),
  });
  assert.equal(result.state, "incomplete");
  assert.equal(result.lifecycle, "failed");
  assert.equal(result.failure.phase, "harness");
  assert.equal(result.failure.code, "harness_failed");
  assert.equal(result.scenarioResult, null);
});

test("completed lifecycle with uncertain cleanup yields incomplete and no scenario proof", async () => {
  const result = await runGameClosure({
    ...identity,
    runHarness: harnessFactory({ lifecycle: "completed", cleanup: "uncertain" }),
    verifyScenarioResult: async () => Object.freeze({ ok: true }),
  });
  assert.equal(result.state, "incomplete");
  assert.equal(result.lifecycle, "completed");
  assert.equal(result.cleanup.state, "uncertain");
  assert.equal(result.failure.phase, "cleanup");
  assert.equal(result.failure.code, "cleanup_uncertain");
  assert.equal(result.scenarioResult, null);
});

test("verifier returning null is treated as scenario_result_missing without accepting a proof", async () => {
  const result = await runGameClosure({
    ...identity,
    runHarness: harnessFactory({ lifecycle: "completed", cleanup: "completed" }),
    verifyScenarioResult: async () => null,
  });
  assert.equal(result.state, "incomplete");
  assert.equal(result.failure.phase, "scenario");
  assert.equal(result.failure.code, "scenario_result_missing");
  assert.equal(result.scenarioResult, null);
});

test("verifier throwing is treated as scenario_result_invalid without accepting a proof", async () => {
  const result = await runGameClosure({
    ...identity,
    runHarness: harnessFactory({ lifecycle: "completed", cleanup: "completed" }),
    verifyScenarioResult: async () => { throw new Error("scenario_schema_mismatch"); },
  });
  assert.equal(result.state, "incomplete");
  assert.equal(result.failure.phase, "scenario");
  assert.equal(result.failure.code, "harness_failed");
  assert.equal(result.scenarioResult, null);
});

test("helper rejects invalid input and exposes no harness execution", async () => {
  let harnessCalled = false;
  await assert.rejects(
    () => runGameClosure({ runHarness: async () => { harnessCalled = true; return {}; } }),
    /game_closure_harness_invalid_input/,
  );
  await assert.rejects(
    () => runGameClosure({ ...identity, deadline: 0 }),
    /game_closure_harness_invalid_input/,
  );
  await assert.rejects(
    () => runGameClosure({ ...identity, runHarness: "not-a-fn" }),
    /game_closure_harness_invalid_input/,
  );
  assert.equal(harnessCalled, false);
});
