#!/usr/bin/env node
/**
 * Read-only M9 `accept_special_order_offer` preflight verifier.
 *
 * It proves only that the action-owned Given → When → Then correlation can be
 * parsed from live-shaped facts. It cannot establish an acceptance route: the
 * current M9 source audit deliberately records the only identified commit in
 * SpecialOrdersBoard.receiveLeftClick/receiveRightClick, which is UI-owned and
 * prohibited for this bridge. Consequently every complete callback rehearsal
 * remains BLOCKED until a target-version, Mod-owned semantic edge and the
 * shared Portfolio request/receipt route are integrated.
 */
const ACTION = "accept_special_order_offer";
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
const REQUEST_KEYS = Object.freeze([
  "action",
  "requestId",
  "traceId",
  "idempotencyKey",
  "expectedRevision",
  "deadlineMs",
  "cancellationToken",
  "scope",
  "offerTarget",
  "generation",
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
const GIVEN_KEYS = Object.freeze([
  "source",
  "fresh",
  "readOnly",
  "saveMutationObserved",
  "gameplayMutationObserved",
  "terminalOutcomePresent",
  "topology",
  "scope",
  "requestId",
  "traceId",
  "offerTarget",
  "generation",
  "alreadyAccepted",
  "playerEligible",
  "revision",
]);
const ACCEPTED_PHASE_KEYS = Object.freeze([
  "requestId",
  "traceId",
  "executionId",
  "action",
  "phase",
  "revision",
  "reasonCode",
]);
const FRESH_ACCEPTED_ORDER_KEYS = Object.freeze([
  "source",
  "fresh",
  "readOnly",
  "saveMutationObserved",
  "gameplayMutationObserved",
  "terminalOutcomePresent",
  "scope",
  "requestId",
  "traceId",
  "executionId",
  "offerTarget",
  "orderKey",
  "generation",
  "accepted",
  "nativeAcceptedInProgress",
]);
const PHASES = Object.freeze(["fresh_observed", "accepted", "offer_committed", "terminal"]);
const REASONS = Object.freeze(["fresh_observed", "accepted", "offer_committed", "special_order_offer_accepted"]);

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
function blocked(code, details = {}) {
  return Object.freeze({ state: "BLOCKED", code, ...details });
}
function validId(value) {
  return typeof value === "string" && ID.test(value);
}
function validRequest(request, scope, nowMs) {
  return (
    exact(request, REQUEST_KEYS) &&
    request.action === ACTION &&
    validId(request.requestId) &&
    validId(request.traceId) &&
    validId(request.idempotencyKey) &&
    validId(request.cancellationToken) &&
    validId(request.offerTarget) &&
    validId(request.generation) &&
    Number.isSafeInteger(request.expectedRevision) &&
    request.expectedRevision >= 0 &&
    Number.isSafeInteger(request.deadlineMs) &&
    request.deadlineMs > nowMs &&
    request.deadlineMs <= nowMs + 30 * 60_000 &&
    sameScope(request.scope, scope)
  );
}
function validGiven(given, expectedScope) {
  return (
    exact(given, GIVEN_KEYS) &&
    given.source === "target_version_native_special_order_offer_reader" &&
    given.fresh === true &&
    given.readOnly === true &&
    given.saveMutationObserved === false &&
    given.gameplayMutationObserved === false &&
    given.terminalOutcomePresent === false &&
    given.topology === TOPOLOGY &&
    sameScope(given.scope, expectedScope) &&
    validId(given.requestId) &&
    validId(given.traceId) &&
    validId(given.offerTarget) &&
    validId(given.generation) &&
    given.alreadyAccepted === false &&
    given.playerEligible === true &&
    Number.isSafeInteger(given.revision) &&
    given.revision >= 0
  );
}
function validPhase(phase, receipt, index) {
  return (
    exact(phase, ACCEPTED_PHASE_KEYS) &&
    phase.requestId === receipt.requestId &&
    phase.traceId === receipt.traceId &&
    phase.executionId === receipt.executionId &&
    phase.action === ACTION &&
    phase.phase === PHASES[index] &&
    phase.reasonCode === REASONS[index] &&
    Number.isSafeInteger(phase.revision) &&
    phase.revision >= 0
  );
}
function validReceipt(receipt, request, scope) {
  if (
    !exact(receipt, RECEIPT_KEYS) ||
    receipt.action !== ACTION ||
    receipt.requestId !== request.requestId ||
    receipt.traceId !== request.traceId ||
    !validId(receipt.executionId) ||
    receipt.state !== "succeeded" ||
    receipt.reasonCode !== "special_order_offer_accepted" ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision <= request.expectedRevision ||
    !record(receipt.evidence) ||
    !record(receipt.postcondition)
  )
    return false;
  const evidence = receipt.evidence;
  const postcondition = receipt.postcondition;
  if (
    !exact(evidence, [
      "identity",
      "phaseTrace",
      "offerTarget",
      "orderKey",
      "generation",
      "reward",
      "freshOfferObserved",
      "objectiveSpecificCompletionObserved",
      "rewardEntitlementObserved",
      "entitlementConsumed",
      "rewardGranted",
    ]) ||
    !exact(evidence.identity, [
      "integrationId",
      "topology",
      "saveId",
      "worldId",
      "localPlayerId",
      "companionId",
      "bindingGeneration",
      "bindingHash",
    ]) ||
    !sameScope(evidence.identity, scope) ||
    !Array.isArray(evidence.phaseTrace) ||
    evidence.phaseTrace.length !== PHASES.length ||
    evidence.offerTarget !== request.offerTarget ||
    evidence.generation !== request.generation ||
    !validId(evidence.orderKey) ||
    !validId(evidence.reward) ||
    evidence.freshOfferObserved !== true ||
    evidence.objectiveSpecificCompletionObserved !== false ||
    evidence.rewardEntitlementObserved !== false ||
    evidence.entitlementConsumed !== false ||
    evidence.rewardGranted !== false ||
    !exact(postcondition, [
      "beforeRevision",
      "afterRevision",
      "state",
      "offerAccepted",
      "allSelectedObjectivesComplete",
      "rewardEntitlementAvailable",
      "rewardEntitlementConsumed",
      "rewardGranted",
      "orderKey",
      "generation",
    ]) ||
    postcondition.beforeRevision !== request.expectedRevision ||
    postcondition.afterRevision !== receipt.revision ||
    postcondition.state !== "accepted_in_progress" ||
    postcondition.offerAccepted !== true ||
    postcondition.allSelectedObjectivesComplete !== false ||
    postcondition.rewardEntitlementAvailable !== false ||
    postcondition.rewardEntitlementConsumed !== false ||
    postcondition.rewardGranted !== false ||
    postcondition.orderKey !== evidence.orderKey ||
    postcondition.generation !== request.generation
  )
    return false;
  return (
    evidence.phaseTrace.every(
      (phase, index) =>
        validPhase(phase, receipt, index) && (index === 0 || phase.revision >= evidence.phaseTrace[index - 1].revision),
    ) &&
    evidence.phaseTrace[0].revision === request.expectedRevision &&
    evidence.phaseTrace[1].revision === request.expectedRevision &&
    evidence.phaseTrace[2].revision === receipt.revision &&
    evidence.phaseTrace[3].revision === receipt.revision
  );
}

/** Given: consume a fresh, read-only offer observation correlated to the request. */
export async function readM9AcceptGiven({ observeNative, expectedScope } = {}) {
  if (typeof observeNative !== "function") return blocked("m9_accept_native_offer_reader_required");
  try {
    const given = await observeNative();
    if (!validGiven(given, expectedScope)) return blocked("m9_accept_fresh_offer_observation_invalid");
    return Object.freeze({ state: "READY", kind: "m9_accept_given", given: Object.freeze({ ...given }) });
  } catch {
    return blocked("m9_accept_native_offer_reader_failed");
  }
}

/** When: consume the exact game-thread acceptance phase for this request. */
export function verifyM9AcceptWhen({ request, acceptedPhase, expectedScope } = {}) {
  const scope = expectedScope ?? request?.scope;
  if (
    !validRequest(request, scope, Date.now()) ||
    !exact(acceptedPhase, ACCEPTED_PHASE_KEYS) ||
    acceptedPhase.requestId !== request.requestId ||
    acceptedPhase.traceId !== request.traceId ||
    acceptedPhase.action !== ACTION ||
    acceptedPhase.phase !== "accepted" ||
    acceptedPhase.reasonCode !== "accepted" ||
    !validId(acceptedPhase.executionId) ||
    acceptedPhase.revision !== request.expectedRevision
  )
    return blocked("m9_accept_exact_acceptance_invalid");
  return Object.freeze({
    state: "READY",
    kind: "m9_accept_when",
    requestId: request.requestId,
    traceId: request.traceId,
    executionId: acceptedPhase.executionId,
  });
}

/** Then: require the exact accepted-order receipt and a same-execution fresh reread. */
export async function replayM9AcceptResult({
  request,
  acceptedPhase,
  receipt,
  readFreshAcceptedOrder,
  expectedScope,
} = {}) {
  const scope = expectedScope ?? request?.scope;
  const when = verifyM9AcceptWhen({ request, acceptedPhase, expectedScope: scope });
  if (when.state !== "READY") return when;
  if (!validReceipt(receipt, request, scope)) return blocked("m9_accept_receipt_invalid");
  if (receipt.executionId !== when.executionId) return blocked("m9_accept_receipt_execution_mismatch");
  if (typeof readFreshAcceptedOrder !== "function") return blocked("m9_accept_fresh_order_reader_required");
  const identity = Object.freeze({
    requestId: request.requestId,
    traceId: request.traceId,
    executionId: when.executionId,
  });
  try {
    const fresh = await readFreshAcceptedOrder(identity);
    if (
      !exact(fresh, FRESH_ACCEPTED_ORDER_KEYS) ||
      fresh.source !== "target_version_native_special_order_reader" ||
      fresh.fresh !== true ||
      fresh.readOnly !== true ||
      fresh.saveMutationObserved !== false ||
      fresh.gameplayMutationObserved !== false ||
      fresh.terminalOutcomePresent !== false ||
      !sameScope(fresh.scope, scope) ||
      fresh.requestId !== identity.requestId ||
      fresh.traceId !== identity.traceId ||
      fresh.executionId !== identity.executionId ||
      fresh.offerTarget !== request.offerTarget ||
      fresh.orderKey !== receipt.evidence.orderKey ||
      fresh.generation !== request.generation ||
      fresh.accepted !== true ||
      fresh.nativeAcceptedInProgress !== true
    )
      return blocked("m9_accept_fresh_order_observation_invalid");
    return Object.freeze({
      state: "READY",
      kind: "m9_accept_then",
      ...identity,
      receipt: Object.freeze(receipt),
      fresh: Object.freeze({ ...fresh }),
    });
  } catch {
    return blocked("m9_accept_fresh_order_reader_failed");
  }
}

/**
 * Checks cancellation/deadline/replay witnesses as fail-closed terminal facts.
 * They cannot be substituted for an accepted receipt.
 */
export function verifyM9AcceptFailClosedTerminal({ request, terminal, kind, expectedScope } = {}) {
  const scope = expectedScope ?? request?.scope;
  if (
    !validRequest(request, scope, Date.now()) ||
    !record(terminal) ||
    terminal.action !== ACTION ||
    terminal.requestId !== request.requestId ||
    terminal.traceId !== request.traceId ||
    !validId(terminal.executionId) ||
    !sameScope(terminal.evidence?.identity, scope)
  )
    return blocked("m9_accept_fail_closed_witness_invalid");
  const expected = {
    cancellation: ["cancelled", "cancelled"],
    deadline: ["expired", "deadline_expired"],
    replay: ["rejected", "idempotency_key_reused_with_different_request"],
  }[kind];
  if (
    !expected ||
    terminal.state !== expected[0] ||
    terminal.reasonCode !== expected[1] ||
    terminal.evidence?.freshOfferObserved !== false ||
    terminal.postcondition?.offerAccepted !== false ||
    terminal.postcondition?.state !== "unselected_domain_no_claim"
  )
    return blocked("m9_accept_fail_closed_terminal_invalid");
  return Object.freeze({ state: "READY", kind: `m9_accept_${kind}_fail_closed` });
}

export async function runM9AcceptPreflight(args = {}) {
  const given = await readM9AcceptGiven(args);
  if (given.state !== "READY") return Object.freeze({ state: "BLOCKED", given });
  if (
    given.given.requestId !== args.request?.requestId ||
    given.given.traceId !== args.request?.traceId ||
    given.given.offerTarget !== args.request?.offerTarget ||
    given.given.generation !== args.request?.generation ||
    given.given.revision !== args.request?.expectedRevision
  )
    return Object.freeze({ state: "BLOCKED", given, then: blocked("m9_accept_given_request_correlation_invalid") });
  const when = verifyM9AcceptWhen({
    request: args.request,
    acceptedPhase: args.acceptedPhase,
    expectedScope: args.expectedScope,
  });
  if (when.state !== "READY") return Object.freeze({ state: "BLOCKED", given, when });
  if (when.requestId !== given.given.requestId || when.traceId !== given.given.traceId)
    return Object.freeze({ state: "BLOCKED", given, when, then: blocked("m9_accept_given_when_correlation_invalid") });
  const then = await replayM9AcceptResult(args);
  if (then.state !== "READY") return Object.freeze({ state: "BLOCKED", given, when, then });
  // Source audit records that the discovered acceptance commit is UI-owned.
  // Do not report a preflight/live success until the required semantic edge is
  // supplied by the serial shared integration without UI dispatch or reflection.
  return Object.freeze({ state: "BLOCKED", code: "m9_accept_source_semantic_edge_unestablished", given, when, then });
}

export const M9_ACCEPT_PREFLIGHT_ACTION = ACTION;
export const M9_ACCEPT_PREFLIGHT_TOPOLOGY = TOPOLOGY;
