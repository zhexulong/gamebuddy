import assert from "node:assert/strict";
import test from "node:test";
import {
  readM9AcceptGiven,
  replayM9AcceptResult,
  runM9AcceptPreflight,
  verifyM9AcceptFailClosedTerminal,
  verifyM9AcceptWhen,
} from "./run-stardew-portfolio-m9-accept-preflight.mjs";

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
const request = Object.freeze({
  action: "accept_special_order_offer",
  requestId: "req",
  traceId: "trace",
  idempotencyKey: "idem",
  expectedRevision: 7,
  deadlineMs: Date.now() + 60_000,
  cancellationToken: "cancel",
  scope,
  offerTarget: "offer",
  generation: "generation",
});
const identity = Object.freeze({ requestId: "req", traceId: "trace", executionId: "exec" });
const acceptedPhase = Object.freeze({
  ...identity,
  action: request.action,
  phase: "accepted",
  revision: request.expectedRevision,
  reasonCode: "accepted",
});
function given(overrides = {}) {
  return {
    source: "target_version_native_special_order_offer_reader",
    fresh: true,
    readOnly: true,
    saveMutationObserved: false,
    gameplayMutationObserved: false,
    terminalOutcomePresent: false,
    topology: scope.topology,
    scope,
    requestId: request.requestId,
    traceId: request.traceId,
    offerTarget: request.offerTarget,
    generation: request.generation,
    alreadyAccepted: false,
    playerEligible: true,
    revision: request.expectedRevision,
    ...overrides,
  };
}
function receipt(overrides = {}) {
  const phase = (phase, revision, reasonCode) => ({ ...identity, action: request.action, phase, revision, reasonCode });
  const base = {
    action: request.action,
    ...identity,
    state: "succeeded",
    revision: 8,
    reasonCode: "special_order_offer_accepted",
    evidence: {
      identity: scope,
      phaseTrace: [
        phase("fresh_observed", 7, "fresh_observed"),
        phase("accepted", 7, "accepted"),
        phase("offer_committed", 8, "offer_committed"),
        phase("terminal", 8, "special_order_offer_accepted"),
      ],
      offerTarget: request.offerTarget,
      orderKey: "order",
      generation: request.generation,
      reward: "reward",
      freshOfferObserved: true,
      objectiveSpecificCompletionObserved: false,
      rewardEntitlementObserved: false,
      entitlementConsumed: false,
      rewardGranted: false,
    },
    postcondition: {
      beforeRevision: 7,
      afterRevision: 8,
      state: "accepted_in_progress",
      offerAccepted: true,
      allSelectedObjectivesComplete: false,
      rewardEntitlementAvailable: false,
      rewardEntitlementConsumed: false,
      rewardGranted: false,
      orderKey: "order",
      generation: request.generation,
    },
  };
  return {
    ...base,
    ...overrides,
    evidence: { ...base.evidence, ...overrides.evidence },
    postcondition: { ...base.postcondition, ...overrides.postcondition },
  };
}
function fresh(overrides = {}) {
  return {
    ...identity,
    source: "target_version_native_special_order_reader",
    fresh: true,
    readOnly: true,
    saveMutationObserved: false,
    gameplayMutationObserved: false,
    terminalOutcomePresent: false,
    scope,
    offerTarget: request.offerTarget,
    orderKey: "order",
    generation: request.generation,
    accepted: true,
    nativeAcceptedInProgress: true,
    ...overrides,
  };
}
function rejected(kind) {
  const [state, reasonCode] = {
    cancellation: ["cancelled", "cancelled"],
    deadline: ["expired", "deadline_expired"],
    replay: ["rejected", "idempotency_key_reused_with_different_request"],
  }[kind];
  return {
    action: request.action,
    ...identity,
    state,
    reasonCode,
    evidence: { identity: scope, freshOfferObserved: false },
    postcondition: { offerAccepted: false, state: "unselected_domain_no_claim" },
  };
}

test("M9 accept Given requires fresh, read-only, unaccepted selected-offer facts", async () => {
  assert.equal((await readM9AcceptGiven({ expectedScope: scope, observeNative: async () => given() })).state, "READY");
  for (const invalid of [
    given({ alreadyAccepted: true }),
    given({ gameplayMutationObserved: true }),
    given({ fresh: false }),
    given({ scope: { ...scope, extra: true } }),
  ])
    assert.equal(
      (await readM9AcceptGiven({ expectedScope: scope, observeNative: async () => invalid })).state,
      "BLOCKED",
    );
});

test("M9 accept When requires the exact accepted phase and Then requires its same-execution receipt plus fresh reader", async () => {
  assert.equal(verifyM9AcceptWhen({ request, acceptedPhase, expectedScope: scope }).state, "READY");
  assert.equal(
    verifyM9AcceptWhen({ request, acceptedPhase: { ...acceptedPhase, executionId: "" }, expectedScope: scope }).state,
    "BLOCKED",
  );
  assert.equal(
    verifyM9AcceptWhen({ request, acceptedPhase: { ...acceptedPhase, revision: 8 }, expectedScope: scope }).state,
    "BLOCKED",
  );
  const calls = [];
  const result = await replayM9AcceptResult({
    request,
    acceptedPhase,
    receipt: receipt(),
    expectedScope: scope,
    readFreshAcceptedOrder: async (value) => {
      calls.push(value);
      return fresh();
    },
  });
  assert.equal(result.state, "READY");
  assert.deepEqual(calls, [identity]);
  for (const invalid of [
    receipt({ state: "accepted" }),
    receipt({ evidence: { freshOfferObserved: false } }),
    receipt({ postcondition: { state: "completed_reward_unclaimed" } }),
  ])
    assert.equal(
      (
        await replayM9AcceptResult({
          request,
          acceptedPhase,
          receipt: invalid,
          expectedScope: scope,
          readFreshAcceptedOrder: async () => fresh(),
        })
      ).state,
      "BLOCKED",
    );
  assert.equal(
    (
      await replayM9AcceptResult({
        request,
        acceptedPhase: { ...acceptedPhase, executionId: "other" },
        receipt: receipt(),
        expectedScope: scope,
        readFreshAcceptedOrder: async () => fresh(),
      })
    ).state,
    "BLOCKED",
  );
  assert.equal(
    (
      await replayM9AcceptResult({
        request,
        acceptedPhase,
        receipt: receipt(),
        expectedScope: scope,
        readFreshAcceptedOrder: async () => fresh({ executionId: "other" }),
      })
    ).state,
    "BLOCKED",
  );
});

test("M9 accept cancellation, deadline, and mismatched replay witnesses remain fail-closed", () => {
  for (const kind of ["cancellation", "deadline", "replay"])
    assert.equal(
      verifyM9AcceptFailClosedTerminal({ request, terminal: rejected(kind), kind, expectedScope: scope }).state,
      "READY",
    );
  assert.equal(
    verifyM9AcceptFailClosedTerminal({
      request,
      terminal: rejected("cancellation"),
      kind: "deadline",
      expectedScope: scope,
    }).state,
    "BLOCKED",
  );
  assert.equal(
    verifyM9AcceptFailClosedTerminal({
      request,
      terminal: { ...rejected("replay"), postcondition: { offerAccepted: true, state: "unselected_domain_no_claim" } },
      kind: "replay",
      expectedScope: scope,
    }).state,
    "BLOCKED",
  );
});

test("M9 accept preflight proves callback correlation but remains source-edge BLOCKED, never live closure", async () => {
  const result = await runM9AcceptPreflight({
    expectedScope: scope,
    observeNative: async () => given(),
    request,
    acceptedPhase,
    receipt: receipt(),
    readFreshAcceptedOrder: async () => fresh(),
  });
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.code, "m9_accept_source_semantic_edge_unestablished");
  assert.equal(result.given.state, "READY");
  assert.equal(result.when.state, "READY");
  assert.equal(result.then.state, "READY");
  assert.equal(Object.hasOwn(result, "liveClosure"), false);
});
