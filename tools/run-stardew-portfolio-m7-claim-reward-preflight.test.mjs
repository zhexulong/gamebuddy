import assert from "node:assert/strict";
import test from "node:test";
import {
  runM7ClaimRewardPreflight,
  validateM7ClaimGiven,
  validateM7ClaimThen,
} from "./run-stardew-portfolio-m7-claim-reward-preflight.mjs";

const scope = Object.freeze({
  integrationId: "stardew_portfolio",
  topology: "single_player_native_companion",
  saveId: "save",
  worldId: "world",
  localPlayerId: "player",
  companionId: "companion",
  bindingGeneration: 1,
  bindingHash: "binding_hash",
});
const request = Object.freeze({
  action: "claim_bundle_reward",
  requestId: "request",
  traceId: "trace",
  idempotencyKey: "idempotency",
  expectedRevision: 7,
  deadlineMs: Date.now() + 60_000,
  cancellationToken: "cancel",
  selector: { selectorId: "selector", acceptedItemIds: ["item"], rewardId: "reward" },
  target: { targetId: "target", observationId: "observation", observedRevision: 7 },
  rewardId: "reward",
  scope,
});
const identity = Object.freeze({ requestId: "request", traceId: "trace", executionId: "execution" });

function given(overrides = {}) {
  return {
    source: "target_version_native_bundle_reward_reader",
    fresh: true,
    readOnly: true,
    gameplayMutationObserved: false,
    saveMutationObserved: false,
    topology: scope.topology,
    scope,
    targetId: request.target.targetId,
    observationId: request.target.observationId,
    rewardId: request.rewardId,
    mutexState: "free",
    slotState: "contributed",
    rewardState: "available",
    revision: request.expectedRevision,
    ...overrides,
  };
}
function phase(name, revision, reasonCode) {
  return { ...identity, phase: name, revision, reasonCode };
}
function receipt(overrides = {}) {
  const base = {
    ...identity,
    action: request.action,
    state: "succeeded",
    revision: 8,
    reasonCode: "bundle_action_completed",
    evidence: {
      identity: scope,
      action: request.action,
      phaseTrace: [phase("fresh_observed", 7, "fresh_observed"), phase("accepted", 7, "accepted"), phase("terminal", 8, "bundle_action_completed")],
      target: request.target,
      itemIdentity: "none",
      stack: 0,
      quality: 0,
      rewardId: request.rewardId,
      rewardInventoryIdentity: request.rewardId,
      rewardInventoryStackBefore: 0,
      rewardInventoryStackAfter: 1,
      mutexBefore: "free",
      mutexAfter: "released",
      slotBefore: "contributed",
      slotAfter: "contributed",
      rewardBefore: "available",
      rewardAfter: "claimed",
      progressChanged: false,
      rewardAvailabilityChanged: false,
      inventoryChanged: true,
    },
    postcondition: {
      beforeRevision: 7,
      afterRevision: 8,
      action: request.action,
      targetId: request.target.targetId,
      progressChanged: false,
      rewardAvailable: false,
      rewardClaimed: true,
      inventoryChanged: true,
    },
  };
  return { ...base, ...overrides, evidence: { ...base.evidence, ...overrides.evidence }, postcondition: { ...base.postcondition, ...overrides.postcondition } };
}
function fresh(overrides = {}) {
  return {
    ...identity,
    source: "target_version_native_bundle_reward_reader",
    fresh: true,
    readOnly: true,
    gameplayMutationObserved: false,
    saveMutationObserved: false,
    scope,
    targetId: request.target.targetId,
    rewardId: request.rewardId,
    slotState: "contributed",
    rewardState: "claimed",
    inventoryChanged: true,
    revision: 8,
    ...overrides,
  };
}

test("M7 claim Given requires a fresh read-only available selected reward", () => {
  assert.equal(validateM7ClaimGiven(given(), scope).state, "READY");
  for (const invalid of [given({ rewardState: "claimed" }), given({ fresh: false }), given({ gameplayMutationObserved: true }), given({ scope: { ...scope, extra: true } })])
    assert.equal(validateM7ClaimGiven(invalid, scope).state, "BLOCKED");
});

test("M7 claim Then requires an exact terminal receipt and fresh same-execution reward reread", () => {
  assert.equal(validateM7ClaimThen({ request, receipt: receipt(), freshReward: fresh(), expectedScope: scope }).state, "READY");
  for (const invalid of [receipt({ state: "blocked" }), receipt({ evidence: { rewardInventoryStackAfter: 0 } }), receipt({ postcondition: { rewardClaimed: false } })])
    assert.equal(validateM7ClaimThen({ request, receipt: invalid, freshReward: fresh(), expectedScope: scope }).state, "BLOCKED");
  assert.equal(validateM7ClaimThen({ request, receipt: receipt(), freshReward: fresh({ executionId: "other" }), expectedScope: scope }).state, "BLOCKED");
});

test("M7 claim preflight proves only the future evidence correlation and remains source-edge BLOCKED", () => {
  const result = runM7ClaimRewardPreflight({ expectedScope: scope, given: given(), request, receipt: receipt(), freshReward: fresh() });
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.code, "m7_reward_claim_native_semantic_edge_unresolved");
  assert.equal(result.given.state, "READY");
  assert.equal(result.then.state, "READY");
  assert.equal(Object.hasOwn(result, "liveClosure"), false);
});
