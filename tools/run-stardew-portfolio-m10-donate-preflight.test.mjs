import assert from "node:assert/strict";
import test from "node:test";
import {
  readM10MuseumDonateGiven,
  replayM10MuseumDonateResult,
  runM10MuseumDonatePreflight,
} from "./run-stardew-portfolio-m10-donate-preflight.mjs";

const scope = Object.freeze({ integrationId: "stardew_portfolio", topology: "single_player_native_companion", saveId: "save", worldId: "world", localPlayerId: "player", companionId: "companion", bindingGeneration: 1, bindingHash: "binding_hash" });
const identity = Object.freeze({ requestId: "request", traceId: "trace", executionId: "execution" });
function facts(overrides = {}) {
  return { scope, revision: 7, worldReady: true, singlePlayer: true, localPlayerMatches: true, actionAuthorized: true, mutexAvailable: true, cancellationRequested: false, inventoryItem: "museum_piece", inventoryStack: 2, collectionContainsPiece: false, collectionPiece: "unselected_piece", collectionPlacement: "unselected_placement", rewardEligible: false, rewardAlreadyClaimed: false, rewardIdentity: "museum_reward", rewardDeliveryCount: 0, ...overrides };
}
function target(kind, value, revision = 7) { return { kind, source: "fresh_observation", value, selectorId: "portfolio_m10_museum_piece_domain_v1", observationId: "observation", observedRevision: revision }; }
function request(overrides = {}) {
  return { action: "donate_museum_item", requestId: identity.requestId, traceId: identity.traceId, idempotencyKey: "idempotency", expectedRevision: 7, deadlineMs: Date.now() + 60_000, cancellationToken: "cancellation", scope, piece: target("opaque_runtime_museum_piece", "museum_piece"), placement: target("opaque_runtime_museum_placement", "museum_placement"), selector: { domainId: "portfolio_m10_museum_piece_domain_v1", minCount: 1, maxCount: 40 }, exactStack: 1, ...overrides };
}
function observation(overrides = {}) {
  return { source: "target_version_native_museum_reader", fresh: true, readOnly: true, saveMutationObserved: false, gameplayMutationObserved: false, terminalOutcomePresent: false, topology: scope.topology, scope, facts: facts(), piece: target("opaque_runtime_museum_piece", "museum_piece"), placement: target("opaque_runtime_museum_placement", "museum_placement"), selectedEligible: true, ...overrides };
}
function receipt(overrides = {}) {
  const before = facts();
  const after = facts({ revision: 8, inventoryStack: 1, collectionContainsPiece: true, collectionPiece: "museum_piece", collectionPlacement: "museum_placement" });
  const phase = (phase, revision, reasonCode) => ({ action: "donate_museum_item", ...identity, phase, revision, reasonCode });
  const base = { action: "donate_museum_item", ...identity, state: "succeeded", revision: 8, reasonCode: "accepted", evidence: { action: "donate_museum_item", scope, target: target("opaque_runtime_museum_piece", "museum_piece"), phaseTrace: [phase("fresh_observed", 7, "fresh_observed"), phase("donation", 8, "accepted"), phase("terminal", 8, "accepted")], before, after, mutexObserved: true, collectionConditionObserved: true, rewardConditionObserved: false, freshObservation: true, actionSpecific: true }, postcondition: { beforeRevision: 7, afterRevision: 8, targetIdentity: "museum_piece", placementIdentity: "museum_placement", inventoryItemBefore: "museum_piece", inventoryItemAfter: "museum_piece", exactStack: 1, inventoryStackBefore: 2, inventoryStackAfter: 1, collectionChanged: true, rewardEligibilityConsumed: false, rewardDeliveryDelta: 0, freshObservation: true } };
  return { ...base, ...overrides, evidence: { ...base.evidence, ...overrides.evidence }, postcondition: { ...base.postcondition, ...overrides.postcondition } };
}
function accepted(overrides = {}) { return { action: "donate_museum_item", ...identity, phase: "accepted", revision: 7, reasonCode: "accepted", ...overrides }; }
function fresh(overrides = {}) { return { source: "target_version_native_museum_reader", fresh: true, readOnly: true, saveMutationObserved: false, gameplayMutationObserved: false, terminalOutcomePresent: false, scope, ...identity, facts: facts({ revision: 8, inventoryStack: 1, collectionContainsPiece: true, collectionPiece: "museum_piece", collectionPlacement: "museum_placement" }), ...overrides }; }

test("M10 donate Given consumes one fresh eligible piece and placement without mutation", async () => {
  const result = await readM10MuseumDonateGiven({ expectedScope: scope, observeNative: async () => observation() });
  assert.equal(result.state, "READY");
  for (const invalid of [observation({ readOnly: false }), observation({ selectedEligible: false }), observation({ facts: facts({ collectionContainsPiece: true }) }), observation({ placement: target("opaque_runtime_museum_placement", "museum_placement", 6) })])
    assert.equal((await readM10MuseumDonateGiven({ expectedScope: scope, observeNative: async () => invalid })).state, "BLOCKED");
});

test("M10 donate Then requires exact receipt linkage plus fresh collection and inventory reread", async () => {
  const result = await replayM10MuseumDonateResult({ request: request(), acceptedPhase: accepted(), receipt: receipt(), expectedScope: scope, readFreshMuseum: async (seen) => { assert.deepEqual(seen, identity); return fresh(); } });
  assert.equal(result.state, "READY");
  for (const invalid of [receipt({ state: "uncertain" }), receipt({ postcondition: { collectionChanged: false } }), receipt({ evidence: { actionSpecific: false } }), receipt({ evidence: { after: facts({ revision: 8, inventoryStack: 1, collectionContainsPiece: true, collectionPiece: "other", collectionPlacement: "museum_placement" }) } })])
    assert.equal((await replayM10MuseumDonateResult({ request: request(), acceptedPhase: accepted(), receipt: invalid, expectedScope: scope, readFreshMuseum: async () => fresh() })).state, "BLOCKED");
  assert.equal((await replayM10MuseumDonateResult({ request: request(), acceptedPhase: accepted(), receipt: receipt(), expectedScope: scope, readFreshMuseum: async () => fresh({ facts: facts({ revision: 8, inventoryStack: 1, collectionContainsPiece: true, collectionPiece: "museum_piece", collectionPlacement: "other" }) }) })).state, "BLOCKED");
});

test("M10 donate combined preflight keeps Given target bound to request and remains non-live", async () => {
  const args = { expectedScope: scope, observeNative: async () => observation(), request: request(), acceptedPhase: accepted(), receipt: receipt(), readFreshMuseum: async () => fresh() };
  const result = await runM10MuseumDonatePreflight(args);
  assert.equal(result.state, "PREFLIGHT_READY");
  assert.equal(result.liveClosure, "none");
  assert.equal(result.blocker, "m10_target_version_live_donate_claim_reopen");
  const mismatch = await runM10MuseumDonatePreflight({ ...args, request: request({ placement: target("opaque_runtime_museum_placement", "other_placement") }) });
  assert.equal(mismatch.state, "BLOCKED");
  assert.equal(mismatch.then.code, "m10_donate_given_request_binding_invalid");
});

test("M10 donate cancellation, deadline, and replay-shaped terminal payloads fail closed", async () => {
  assert.equal((await replayM10MuseumDonateResult({ request: request({ deadlineMs: Date.now() - 1 }), acceptedPhase: accepted(), receipt: receipt(), expectedScope: scope, readFreshMuseum: async () => fresh() })).state, "BLOCKED");
  assert.equal((await replayM10MuseumDonateResult({ request: request(), acceptedPhase: accepted(), receipt: receipt({ state: "cancelled", reasonCode: "cancelled" }), expectedScope: scope, readFreshMuseum: async () => fresh() })).state, "BLOCKED");
  assert.equal((await replayM10MuseumDonateResult({ request: request(), acceptedPhase: accepted(), receipt: receipt({ requestId: "replayed_request" }), expectedScope: scope, readFreshMuseum: async () => fresh() })).state, "BLOCKED");
  assert.equal((await replayM10MuseumDonateResult({ request: request(), acceptedPhase: accepted({ executionId: "cancelled_execution" }), receipt: receipt(), expectedScope: scope, readFreshMuseum: async () => fresh() })).state, "BLOCKED");
});
