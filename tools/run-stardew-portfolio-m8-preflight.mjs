#!/usr/bin/env node
/**
 * Read-only M8 `select_mine_elevator_floor` preflight components.
 *
 * This is a deterministic verifier for the BDD pipeline, not a game runner.
 * Native callbacks are producer boundaries and must be supplied by an
 * attach-only target-version runner; this module never launches Stardew,
 * invokes the action, writes saves, initiates save/close/reopen, or
 * manufactures a receipt. M8 selection itself does not claim an advancement
 * or persistence effect, so save/reopen proof belongs to a distinct route
 * action that creates the persisted milestone.
 */
const ACTION = "select_mine_elevator_floor";
const TOPOLOGY = "single_player_native_companion";
const MAX_FLOOR = 120;
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
  "scope",
  "phaseTrace",
  "entryObserved",
  "currentFloorBefore",
  "lowestMineLevelBefore",
  "opaqueElevatorTarget",
  "nativeElevatorTransitionObserved",
  "currentFloorAfter",
  "lowestMineLevelAfter",
  "lowestMineLevelObserved",
]);
const POSTCONDITION_KEYS = Object.freeze([
  "selectedCheckpoint",
  "actualCurrentFloor",
  "observedLowestMineLevel",
  "opaqueElevatorTarget",
  "freshObservation",
  "sameExecution",
]);
const PHASE_NAMES = Object.freeze(["fresh_observed", "accepted", "transition_started", "postcondition", "terminal"]);
const PHASE_REASONS = Object.freeze([
  "fresh_observed",
  "accepted",
  "mine_elevator_transition_started",
  "postcondition_observed",
  "mine_elevator_floor_selected",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(code, details = {}) {
  return Object.freeze({ state: "BLOCKED", code, ...details });
}
function validFloor(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_FLOOR;
}
function validCheckpoint(value) {
  return Number.isSafeInteger(value) && value >= 5 && value <= MAX_FLOOR && value % 5 === 0;
}
function hasExactKeys(value, fields) {
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
function sameExactScope(actual, expected) {
  return (
    hasExactKeys(actual, SCOPE_KEYS) &&
    hasExactKeys(expected, SCOPE_KEYS) &&
    SCOPE_KEYS.every((key) => actual[key] === expected[key])
  );
}
function validIdentity(value) {
  return (
    isRecord(value) &&
    ID.test(value.requestId ?? "") &&
    ID.test(value.traceId ?? "") &&
    ID.test(value.executionId ?? "")
  );
}
function validateRequestShape(request, expectedScope, nowMs = Date.now()) {
  if (
    !hasExactKeys(request, [
      "action",
      "requestId",
      "traceId",
      "idempotencyKey",
      "selectedCheckpoint",
      "expectedRevision",
      "deadlineMs",
      "cancellationToken",
      "scope",
    ]) ||
    request.action !== ACTION ||
    !ID.test(request.requestId ?? "") ||
    !ID.test(request.traceId ?? "") ||
    !ID.test(request.idempotencyKey ?? "") ||
    !validCheckpoint(request.selectedCheckpoint) ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0 ||
    !Number.isSafeInteger(request.deadlineMs) ||
    request.deadlineMs <= nowMs ||
    request.deadlineMs > nowMs + 30 * 60_000 ||
    !ID.test(request.cancellationToken ?? "") ||
    !sameExactScope(request.scope, expectedScope)
  )
    return "invalid_portfolio_mine_elevator_request";
  return null;
}
function validateReceiptShape(receipt) {
  if (
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    !validIdentity(receipt) ||
    receipt.state !== "succeeded" ||
    receipt.reasonCode !== "mine_elevator_floor_selected" ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 0 ||
    !hasExactKeys(receipt.evidence, EVIDENCE_KEYS) ||
    !hasExactKeys(receipt.postcondition, POSTCONDITION_KEYS)
  )
    return "invalid_portfolio_mine_elevator_receipt";
  const evidence = receipt.evidence;
  const postcondition = receipt.postcondition;
  if (
    !hasExactKeys(evidence.scope, SCOPE_KEYS) ||
    !Array.isArray(evidence.phaseTrace) ||
    evidence.phaseTrace.length !== PHASE_NAMES.length ||
    evidence.entryObserved !== true ||
    evidence.nativeElevatorTransitionObserved !== true ||
    evidence.lowestMineLevelObserved !== true ||
    !validFloor(evidence.currentFloorBefore) ||
    !validFloor(evidence.lowestMineLevelBefore) ||
    !validFloor(evidence.currentFloorAfter) ||
    !validFloor(evidence.lowestMineLevelAfter) ||
    !ID.test(evidence.opaqueElevatorTarget ?? "") ||
    !validCheckpoint(postcondition.selectedCheckpoint) ||
    !validFloor(postcondition.actualCurrentFloor) ||
    !validFloor(postcondition.observedLowestMineLevel) ||
    !ID.test(postcondition.opaqueElevatorTarget ?? "") ||
    postcondition.freshObservation !== true ||
    postcondition.sameExecution !== true ||
    postcondition.opaqueElevatorTarget !== evidence.opaqueElevatorTarget ||
    postcondition.actualCurrentFloor !== evidence.currentFloorAfter ||
    postcondition.observedLowestMineLevel !== evidence.lowestMineLevelAfter
  )
    return "invalid_portfolio_mine_elevator_receipt";
  for (let index = 0; index < evidence.phaseTrace.length; index += 1) {
    const phase = evidence.phaseTrace[index];
    if (
      !hasExactKeys(phase, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) ||
      phase.requestId !== receipt.requestId ||
      phase.traceId !== receipt.traceId ||
      phase.executionId !== receipt.executionId ||
      phase.phase !== PHASE_NAMES[index] ||
      phase.reasonCode !== PHASE_REASONS[index] ||
      !Number.isSafeInteger(phase.revision) ||
      phase.revision < 0 ||
      (index > 0 && phase.revision < evidence.phaseTrace[index - 1].revision)
    )
      return "invalid_portfolio_mine_elevator_receipt";
  }
  // Terminal delivery does not mint a new native-state revision.
  if (
    evidence.phaseTrace[2].revision <= evidence.phaseTrace[1].revision ||
    evidence.phaseTrace[3].revision <= evidence.phaseTrace[2].revision ||
    evidence.phaseTrace[4].revision !== evidence.phaseTrace[3].revision ||
    evidence.phaseTrace[4].revision !== receipt.revision
  )
    return "invalid_portfolio_mine_elevator_receipt";
  return null;
}
function assertReadOnlyFacts(facts) {
  if (!isRecord(facts)) return "m8_preflight_native_probe_invalid";
  if (facts.source !== "target_version_native_probe" || facts.readOnly !== true)
    return "m8_preflight_native_probe_not_native_read_only";
  if (facts.saveMutationObserved !== false || facts.gameplayMutationObserved !== false)
    return "m8_preflight_probe_mutation_observed";
  if (facts.terminalOutcomePresent !== false || facts.terminalRouteResult !== null)
    return "m8_preflight_terminal_fixture_forbidden";
  if (
    facts.topology !== TOPOLOGY ||
    facts.locationKind !== "MineShaft" ||
    facts.worldReady !== true ||
    facts.singlePlayer !== true ||
    facts.masterGame !== true ||
    facts.playerAvailable !== true ||
    !hasExactKeys(facts.scope, SCOPE_KEYS)
  )
    return "m8_preflight_native_scope_invalid";
  if (
    !validFloor(facts.currentFloor) ||
    !validFloor(facts.lowestMineLevel) ||
    !validCheckpoint(facts.selectedCheckpoint) ||
    facts.selectedCheckpoint > facts.lowestMineLevel ||
    facts.selectedCheckpoint === facts.currentFloor
  )
    return "m8_preflight_checkpoint_observation_invalid";
  return null;
}

/** Given: require a dynamic target-version native read-only probe. */
export async function readM8ElevatorGiven({ observeNative, expectedScope = null } = {}) {
  if (typeof observeNative !== "function") return fail("m8_preflight_native_probe_required");
  let facts;
  try {
    facts = await observeNative();
  } catch {
    return fail("m8_preflight_native_probe_failed");
  }
  const reason = assertReadOnlyFacts(facts);
  if (reason) return fail(reason);
  if (expectedScope !== null && !sameExactScope(facts.scope, expectedScope))
    return fail("m8_preflight_native_scope_mismatch");
  return Object.freeze({ state: "READY", kind: "m8_elevator_given", facts: Object.freeze({ ...facts }) });
}
function validateAcceptedPhase(phase, request) {
  return (
    isRecord(phase) &&
    hasExactKeys(phase, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) &&
    phase.phase === "accepted" &&
    phase.reasonCode === "accepted" &&
    phase.requestId === request.requestId &&
    phase.traceId === request.traceId &&
    ID.test(phase.executionId ?? "") &&
    phase.revision === request.expectedRevision
  );
}

/** Then: correlate the accepted execution, receipt, and a fresh native floor reader. */
export async function replayM8ElevatorResult({ request, acceptedPhase, receipt, readFreshFloor, expectedScope } = {}) {
  const scope = expectedScope ?? request?.scope;
  if (!isRecord(request) || request.action !== ACTION || validateRequestShape(request, scope, Date.now()) !== null)
    return fail("invalid_portfolio_mine_elevator_request");
  if (!validateAcceptedPhase(acceptedPhase, request)) return fail("m8_preflight_accepted_correlation_invalid");
  if (validateReceiptShape(receipt) !== null) return fail("invalid_portfolio_mine_elevator_receipt");
  const evidence = receipt.evidence;
  const postcondition = receipt.postcondition;
  if (
    receipt.requestId !== request.requestId ||
    receipt.traceId !== request.traceId ||
    receipt.executionId !== acceptedPhase.executionId ||
    !sameExactScope(evidence.scope, scope) ||
    postcondition.selectedCheckpoint !== request.selectedCheckpoint ||
    postcondition.actualCurrentFloor !== request.selectedCheckpoint ||
    evidence.currentFloorAfter !== request.selectedCheckpoint ||
    evidence.lowestMineLevelAfter < request.selectedCheckpoint ||
    postcondition.observedLowestMineLevel < request.selectedCheckpoint
  )
    return fail("m8_preflight_terminal_correlation_invalid");
  if (typeof readFreshFloor !== "function") return fail("m8_preflight_fresh_floor_reader_required");
  const identity = Object.freeze({
    requestId: request.requestId,
    traceId: request.traceId,
    executionId: acceptedPhase.executionId,
  });
  let fresh;
  try {
    fresh = await readFreshFloor(identity);
  } catch {
    return fail("m8_preflight_fresh_floor_reader_failed");
  }
  if (
    !isRecord(fresh) ||
    fresh.source !== "target_version_native_floor_reader" ||
    fresh.fresh !== true ||
    fresh.readOnly !== true ||
    fresh.saveMutationObserved !== false ||
    fresh.gameplayMutationObserved !== false ||
    !sameExactScope(fresh.scope, scope) ||
    !validIdentity(fresh) ||
    fresh.requestId !== identity.requestId ||
    fresh.traceId !== identity.traceId ||
    fresh.executionId !== identity.executionId ||
    fresh.currentFloor !== request.selectedCheckpoint ||
    fresh.currentFloor !== postcondition.actualCurrentFloor ||
    fresh.terminalOutcomePresent !== false
  )
    return fail("m8_preflight_fresh_floor_observation_invalid");
  return Object.freeze({
    state: "READY",
    kind: "m8_elevator_then",
    ...identity,
    receipt: Object.freeze(receipt),
    freshFloor: Object.freeze({ ...fresh }),
  });
}

export async function runM8ElevatorPreflight({
  observeNative,
  expectedScope,
  request,
  acceptedPhase,
  receipt,
  readFreshFloor,
} = {}) {
  const given = await readM8ElevatorGiven({ observeNative, expectedScope });
  if (given.state !== "READY") return Object.freeze({ state: "BLOCKED", given });
  if (!isRecord(request) || given.facts.selectedCheckpoint !== request.selectedCheckpoint)
    return Object.freeze({ state: "BLOCKED", given, then: fail("m8_preflight_given_request_checkpoint_mismatch") });
  const then = await replayM8ElevatorResult({ request, acceptedPhase, receipt, readFreshFloor, expectedScope });
  if (then.state !== "READY") return Object.freeze({ state: "BLOCKED", given, then });
  // This only proves the callback-backed Given/When/Then pipeline is
  // executable; actual target-version runtime evidence remains required before
  // any live claim. A later action that advances a persisted route milestone
  // owns its own native save/reopen clause.
  return Object.freeze({ state: "PREFLIGHT_READY", given, then });
}

export const M8_ELEVATOR_PREFLIGHT_ACTION = ACTION;
export const M8_ELEVATOR_PREFLIGHT_TOPOLOGY = TOPOLOGY;
