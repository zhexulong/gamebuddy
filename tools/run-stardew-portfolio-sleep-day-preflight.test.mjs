import assert from "node:assert/strict";
import test from "node:test";
import {
  readSleepDayGiven,
  runSleepDayPreflight,
  SLEEP_DAY_SOURCE_BLOCKER,
} from "./run-stardew-portfolio-sleep-day-preflight.mjs";

const scope = Object.freeze({
  integrationId: "stardew_portfolio",
  topology: "single_player_native_companion",
  saveId: "save",
  worldId: "world",
  localPlayerId: "player",
  companionId: "companion",
  bindingGeneration: 1,
  bindingHash: "hash",
});
function lawfulGiven(overrides = {}) {
  return {
    source: "target_version_native_sleep_probe",
    readOnly: true,
    saveMutationObserved: false,
    gameplayMutationObserved: false,
    topology: "single_player_native_companion",
    singlePlayer: true,
    currentNativeLocalPlayer: true,
    sleepEligible: true,
    activeMenu: false,
    activeEvent: false,
    activeMinigame: false,
    terminalOutcomePresent: false,
    scope,
    ...overrides,
  };
}

test("Given accepts only a fresh read-only lawful native sleep observation", async () => {
  const result = await readSleepDayGiven({ expectedScope: scope, observeNative: async () => lawfulGiven() });
  assert.equal(result.state, "READY");
  for (const invalid of [
    lawfulGiven({ sleepEligible: false }),
    lawfulGiven({ gameplayMutationObserved: true }),
    lawfulGiven({ terminalOutcomePresent: true }),
    lawfulGiven({ scope: { ...scope, forged: true } }),
  ]) {
    assert.equal(
      (await readSleepDayGiven({ expectedScope: scope, observeNative: async () => invalid })).state,
      "BLOCKED",
    );
  }
});

test("the full Given/When/Then/And pipeline remains explicitly blocked without a lawful native ingress", async () => {
  const result = await runSleepDayPreflight({ expectedScope: scope, observeNative: async () => lawfulGiven() });
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.code, "native_sleep_ingress_unavailable");
  assert.equal(result.given.state, "READY");
  assert.equal(result.sourceBlocker, SLEEP_DAY_SOURCE_BLOCKER);
  assert.match(result.sourceBlocker.sourceFact, /private GameLocation\.startSleep\/doSleep/);
  assert.deepEqual(result.sourceBlocker.prohibitedAlternatives, [
    "Game1.NewDay",
    "SaveGame.Save",
    "GameLocation.startSleep",
    "GameLocation.doSleep",
    "answerDialogueAction",
    "UI/input",
    "reflection",
    "generic dispatcher",
    "save edit",
  ]);
});

test("no unavailable or malformed native probe can be mistaken for a runnable preflight", async () => {
  assert.equal((await runSleepDayPreflight({ expectedScope: scope })).code, "sleep_day_native_probe_required");
  assert.equal(
    (
      await runSleepDayPreflight({
        expectedScope: scope,
        observeNative: async () => {
          throw new Error("unavailable");
        },
      })
    ).code,
    "sleep_day_native_probe_failed",
  );
  assert.equal(
    (await runSleepDayPreflight({ expectedScope: scope, observeNative: async () => lawfulGiven({ readOnly: false }) }))
      .code,
    "sleep_day_given_invalid",
  );
});
