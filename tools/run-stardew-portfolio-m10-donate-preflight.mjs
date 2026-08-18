#!/usr/bin/env node
/**
 * Read-only preflight verifier for one M10 `donate_museum_item` execution.
 *
 * It accepts callback-produced target-version observations and a recorded
 * protocol-shaped receipt, but never opens Stardew, sends a bridge request,
 * creates an inventory item, or calls a Museum menu/callback. The current
 * source audit blocks the native semantic adapter, so this verifier is a
 * fail-closed consumer seam rather than a live runner or a closure claim.
 */
const ACTION = "donate_museum_item";
const TOPOLOGY = "single_player_native_companion";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SCOPE_KEYS = Object.freeze([
  "integrationId",
  "topology",
  "saveId",
  "worldId",
  "localPlayerId",
  "companionId",
  "bindingGeneration",
  "bindingHash",
]);
const RECEIPT_KEYS = Object.freeze([
  "action",
  "requestId",
  "traceId",
  "executionId",
  "state",
  "revision",
  "reasonCode",
  "evidence",
  "postcondition",
]);
const EVIDENCE_KEYS = Object.freeze([
  "action",
  "scope",
  "target",
  "phaseTrace",
  "before",
  "after",
  "mutexObserved",
  "collectionConditionObserved",
  "rewardConditionObserved",
  "freshObservation",
  "actionSpecific",
]);
const POSTCONDITION_KEYS = Object.freeze([
  "beforeRevision",
  "afterRevision",
  "targetIdentity",
  "placementIdentity",
  "inventoryItemBefore",
  "inventoryItemAfter",
  "exactStack",
  "inventoryStackBefore",
  "inventoryStackAfter",
  "collectionChanged",
  "rewardEligibilityConsumed",
  "rewardDeliveryDelta",
  "freshObservation",
]);
const FACT_KEYS = Object.freeze([
  "scope",
  "revision",
  "worldReady",
  "singlePlayer",
  "localPlayerMatches",
  "actionAuthorized",
  "mutexAvailable",
  "cancellationRequested",
  "inventoryItem",
  "inventoryStack",
  "collectionContainsPiece",
  "collectionPiece",
  "collectionPlacement",
  "rewardEligible",
  "rewardAlreadyClaimed",
  "rewardIdentity",
  "rewardDeliveryCount",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function sameScope(actual, expected) {
  return (
    exact(actual, SCOPE_KEYS) && exact(expected, SCOPE_KEYS) && SCOPE_KEYS.every((key) => actual[key] === expected[key])
  );
}
function validId(value) {
  return typeof value === "string" && ID.test(value);
}
function blocked(code, details = {}) {
  return Object.freeze({ state: "BLOCKED", code, ...details });
}
function validFacts(value, scope) {
  return (
    exact(value, FACT_KEYS) &&
    sameScope(value.scope, scope) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    value.worldReady === true &&
    value.singlePlayer === true &&
    value.localPlayerMatches === true &&
    value.actionAuthorized === true &&
    value.mutexAvailable === true &&
    value.cancellationRequested === false &&
    validId(value.inventoryItem) &&
    Number.isSafeInteger(value.inventoryStack) &&
    value.inventoryStack >= 0 &&
    typeof value.collectionContainsPiece === "boolean" &&
    validId(value.collectionPiece) &&
    validId(value.collectionPlacement) &&
    typeof value.rewardEligible === "boolean" &&
    typeof value.rewardAlreadyClaimed === "boolean" &&
    validId(value.rewardIdentity) &&
    Number.isSafeInteger(value.rewardDeliveryCount) &&
    value.rewardDeliveryCount >= 0
  );
}
function validTarget(value, kind, revision) {
  return (
    exact(value, ["kind", "source", "value", "selectorId", "observationId", "observedRevision"]) &&
    value.kind === kind &&
    value.source === "fresh_observation" &&
    validId(value.value) &&
    validId(value.selectorId) &&
    validId(value.observationId) &&
    value.observedRevision === revision
  );
}
function validRequest(request, scope, nowMs) {
  return (
    exact(request, [
      "action",
      "requestId",
      "traceId",
      "idempotencyKey",
      "expectedRevision",
      "deadlineMs",
      "cancellationToken",
      "scope",
      "piece",
      "placement",
      "selector",
      "exactStack",
    ]) &&
    request.action === ACTION &&
    validId(request.requestId) &&
    validId(request.traceId) &&
    validId(request.idempotencyKey) &&
    Number.isSafeInteger(request.expectedRevision) &&
    request.expectedRevision >= 0 &&
    Number.isSafeInteger(request.deadlineMs) &&
    request.deadlineMs > nowMs &&
    request.deadlineMs <= nowMs + 30 * 60_000 &&
    validId(request.cancellationToken) &&
    sameScope(request.scope, scope) &&
    validTarget(request.piece, "opaque_runtime_museum_piece", request.expectedRevision) &&
    validTarget(request.placement, "opaque_runtime_museum_placement", request.expectedRevision) &&
    request.piece.selectorId === request.placement.selectorId &&
    request.piece.observationId === request.placement.observationId &&
    exact(request.selector, ["domainId", "minCount", "maxCount"]) &&
    request.selector.domainId === "portfolio_m10_museum_piece_domain_v1" &&
    request.selector.minCount === 1 &&
    request.selector.maxCount === 40 &&
    request.piece.selectorId === request.selector.domainId &&
    request.exactStack === 1
  );
}

/** Given: a target-version, read-only Museum observation selects one eligible piece and placement. */
export async function readM10MuseumDonateGiven({ observeNative, expectedScope = null } = {}) {
  if (typeof observeNative !== "function") return blocked("m10_donate_native_observation_required");
  let observation;
  try {
    observation = await observeNative();
  } catch {
    return blocked("m10_donate_native_observation_failed");
  }
  if (
    !record(observation) ||
    observation.source !== "target_version_native_museum_reader" ||
    observation.fresh !== true ||
    observation.readOnly !== true ||
    observation.saveMutationObserved !== false ||
    observation.gameplayMutationObserved !== false ||
    observation.terminalOutcomePresent !== false ||
    observation.topology !== TOPOLOGY ||
    !sameScope(observation.scope, expectedScope ?? observation.scope) ||
    !validFacts(observation.facts, observation.scope) ||
    !validTarget(observation.piece, "opaque_runtime_museum_piece", observation.facts.revision) ||
    !validTarget(observation.placement, "opaque_runtime_museum_placement", observation.facts.revision) ||
    observation.piece.selectorId !== observation.placement.selectorId ||
    observation.piece.observationId !== observation.placement.observationId ||
    observation.piece.value !== observation.facts.inventoryItem ||
    observation.facts.inventoryStack < 1 ||
    observation.facts.collectionContainsPiece !== false ||
    observation.selectedEligible !== true
  )
    return blocked("m10_donate_given_invalid");
  return Object.freeze({ state: "READY", kind: "m10_donate_given", observation: Object.freeze({ ...observation }) });
}

/** Then: consume only an exact succeeded receipt and a correlated fresh native reread. */
export async function replayM10MuseumDonateResult({
  request,
  acceptedPhase,
  receipt,
  readFreshMuseum,
  expectedScope,
} = {}) {
  const scope = expectedScope ?? request?.scope;
  const now = Date.now();
  if (!validRequest(request, scope, now)) return blocked("m10_donate_request_invalid");
  if (
    !exact(acceptedPhase, ["action", "requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) ||
    acceptedPhase.action !== ACTION ||
    acceptedPhase.requestId !== request.requestId ||
    acceptedPhase.traceId !== request.traceId ||
    !validId(acceptedPhase.executionId) ||
    acceptedPhase.phase !== "accepted" ||
    acceptedPhase.revision !== request.expectedRevision ||
    acceptedPhase.reasonCode !== "accepted"
  )
    return blocked("m10_donate_accepted_correlation_invalid");
  if (
    !exact(receipt, RECEIPT_KEYS) ||
    receipt.action !== ACTION ||
    receipt.requestId !== request.requestId ||
    receipt.traceId !== request.traceId ||
    receipt.executionId !== acceptedPhase.executionId ||
    receipt.state !== "succeeded" ||
    receipt.reasonCode !== "accepted" ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision <= request.expectedRevision ||
    !exact(receipt.evidence, EVIDENCE_KEYS) ||
    !exact(receipt.postcondition, POSTCONDITION_KEYS)
  )
    return blocked("m10_donate_receipt_invalid");
  const { evidence, postcondition } = receipt;
  if (
    evidence.action !== ACTION ||
    !sameScope(evidence.scope, scope) ||
    !validTarget(evidence.target, "opaque_runtime_museum_piece", request.expectedRevision) ||
    evidence.target.value !== request.piece.value ||
    evidence.target.selectorId !== request.piece.selectorId ||
    evidence.target.observationId !== request.piece.observationId ||
    !Array.isArray(evidence.phaseTrace) ||
    evidence.phaseTrace.length !== 3 ||
    !validFacts(evidence.before, scope) ||
    !validFacts(evidence.after, scope) ||
    evidence.before.revision !== request.expectedRevision ||
    evidence.after.revision !== receipt.revision ||
    evidence.mutexObserved !== true ||
    evidence.collectionConditionObserved !== true ||
    evidence.rewardConditionObserved !== false ||
    evidence.freshObservation !== true ||
    evidence.actionSpecific !== true ||
    evidence.after.inventoryItem !== request.piece.value ||
    evidence.after.inventoryStack !== evidence.before.inventoryStack - 1 ||
    evidence.after.collectionContainsPiece !== true ||
    evidence.after.collectionPiece !== request.piece.value ||
    evidence.after.collectionPlacement !== request.placement.value ||
    evidence.after.rewardEligible !== evidence.before.rewardEligible ||
    evidence.after.rewardDeliveryCount !== evidence.before.rewardDeliveryCount ||
    postcondition.beforeRevision !== request.expectedRevision ||
    postcondition.afterRevision !== receipt.revision ||
    postcondition.targetIdentity !== request.piece.value ||
    postcondition.placementIdentity !== request.placement.value ||
    postcondition.inventoryItemBefore !== request.piece.value ||
    postcondition.inventoryItemAfter !== request.piece.value ||
    postcondition.exactStack !== 1 ||
    postcondition.inventoryStackBefore !== evidence.before.inventoryStack ||
    postcondition.inventoryStackAfter !== evidence.after.inventoryStack ||
    postcondition.inventoryStackAfter !== postcondition.inventoryStackBefore - 1 ||
    postcondition.collectionChanged !== true ||
    postcondition.rewardEligibilityConsumed !== false ||
    postcondition.rewardDeliveryDelta !== 0 ||
    postcondition.freshObservation !== true
  )
    return blocked("m10_donate_terminal_correlation_invalid");
  for (const [index, phase] of evidence.phaseTrace.entries()) {
    if (
      !exact(phase, ["action", "requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) ||
      phase.action !== ACTION ||
      phase.requestId !== request.requestId ||
      phase.traceId !== request.traceId ||
      phase.executionId !== acceptedPhase.executionId ||
      phase.phase !== ["fresh_observed", "donation", "terminal"][index] ||
      !Number.isSafeInteger(phase.revision) ||
      phase.revision < request.expectedRevision ||
      (index > 0 && phase.revision < evidence.phaseTrace[index - 1].revision)
    )
      return blocked("m10_donate_phase_trace_invalid");
  }
  if (typeof readFreshMuseum !== "function") return blocked("m10_donate_fresh_reader_required");
  let fresh;
  try {
    fresh = await readFreshMuseum(
      Object.freeze({ requestId: request.requestId, traceId: request.traceId, executionId: acceptedPhase.executionId }),
    );
  } catch {
    return blocked("m10_donate_fresh_reader_failed");
  }
  if (
    !record(fresh) ||
    fresh.source !== "target_version_native_museum_reader" ||
    fresh.fresh !== true ||
    fresh.readOnly !== true ||
    fresh.saveMutationObserved !== false ||
    fresh.gameplayMutationObserved !== false ||
    fresh.terminalOutcomePresent !== false ||
    !sameScope(fresh.scope, scope) ||
    fresh.requestId !== request.requestId ||
    fresh.traceId !== request.traceId ||
    fresh.executionId !== acceptedPhase.executionId ||
    !validFacts(fresh.facts, scope) ||
    fresh.facts.revision !== receipt.revision ||
    fresh.facts.inventoryItem !== request.piece.value ||
    fresh.facts.inventoryStack !== evidence.after.inventoryStack ||
    fresh.facts.collectionContainsPiece !== true ||
    fresh.facts.collectionPiece !== request.piece.value ||
    fresh.facts.collectionPlacement !== request.placement.value ||
    fresh.facts.rewardEligible !== evidence.before.rewardEligible ||
    fresh.facts.rewardDeliveryCount !== evidence.before.rewardDeliveryCount
  )
    return blocked("m10_donate_fresh_observation_invalid");
  return Object.freeze({
    state: "READY",
    kind: "m10_donate_then",
    requestId: request.requestId,
    traceId: request.traceId,
    executionId: acceptedPhase.executionId,
    receipt: Object.freeze(receipt),
    fresh: Object.freeze({ ...fresh }),
  });
}

export async function runM10MuseumDonatePreflight(args = {}) {
  const given = await readM10MuseumDonateGiven(args);
  if (given.state !== "READY") return Object.freeze({ state: "BLOCKED", given });
  const request = args.request;
  if (
    !validRequest(request, given.observation.scope, Date.now()) ||
    request.piece.value !== given.observation.piece.value ||
    request.placement.value !== given.observation.placement.value
  )
    return Object.freeze({ state: "BLOCKED", given, then: blocked("m10_donate_given_request_binding_invalid") });
  const then = await replayM10MuseumDonateResult({ ...args, expectedScope: given.observation.scope });
  if (then.state !== "READY") return Object.freeze({ state: "BLOCKED", given, then });
  return Object.freeze({
    state: "PREFLIGHT_READY",
    given,
    then,
    liveClosure: "none",
    blocker: "m10_target_version_live_donate_claim_reopen",
  });
}

export const M10_MUSEUM_DONATE_PREFLIGHT_ACTION = ACTION;
