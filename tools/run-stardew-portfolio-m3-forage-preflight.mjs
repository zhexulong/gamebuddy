#!/usr/bin/env node
/**
 * Read-only M3 spawned-forage preflight verifier. It neither starts Stardew
 * nor manufactures a receipt. `pickup_item` owns Debris; this batch refuses
 * every non-spawned-forage target until target-version review supplies a
 * bounded semantic edge instead of GameLocation.checkAction dispatch.
 */
const ACTION = "pickup_forage";
const TOPOLOGY = "single_player_native_companion";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SCOPE = Object.freeze([
  "integrationId",
  "topology",
  "saveId",
  "worldId",
  "localPlayerId",
  "companionId",
  "bindingGeneration",
  "bindingHash",
]);
const TARGET = Object.freeze(["targetId", "selectorId", "observationId", "kind", "source", "observedRevision"]);
const REQUEST = Object.freeze([
  "action",
  "requestId",
  "traceId",
  "idempotencyKey",
  "expectedRevision",
  "deadlineMs",
  "cancellationToken",
  "scope",
  "target",
]);
const GIVEN = Object.freeze([
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
  "revision",
  "target",
  "inRange",
  "inventoryCapacityAvailable",
  "spawnedForagePresent",
]);
const RECEIPT = Object.freeze([
  "requestId",
  "traceId",
  "executionId",
  "state",
  "revision",
  "reasonCode",
  "phaseTrace",
  "scope",
  "targetId",
  "targetRemovedObserved",
  "inventoryDelta",
]);
const FIXTURE = Object.freeze([
  "schemaVersion",
  "fixtureId",
  "topology",
  "action",
  "fixtureBoundary",
  "provides",
  "forbids",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, fields) {
  return (
    record(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field))
  );
}
function sameScope(actual, expected) {
  return exact(actual, SCOPE) && exact(expected, SCOPE) && SCOPE.every((key) => actual[key] === expected[key]);
}
function blocked(code, details = {}) {
  return Object.freeze({ state: "BLOCKED", code, ...details });
}
function id(value) {
  return typeof value === "string" && ID.test(value);
}
function target(value, revision) {
  return (
    exact(value, TARGET) &&
    id(value.targetId) &&
    id(value.selectorId) &&
    id(value.observationId) &&
    value.kind === "spawned_forage_object" &&
    value.source === "fresh_native_observation" &&
    value.observedRevision === revision
  );
}
function requestValid(value, scope, now = Date.now()) {
  return (
    exact(value, REQUEST) &&
    value.action === ACTION &&
    id(value.requestId) &&
    id(value.traceId) &&
    id(value.idempotencyKey) &&
    id(value.cancellationToken) &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    Number.isSafeInteger(value.deadlineMs) &&
    value.deadlineMs > now &&
    value.deadlineMs <= now + 30 * 60_000 &&
    sameScope(value.scope, scope) &&
    target(value.target, value.expectedRevision)
  );
}

/** Non-mutation fixture verifier; it cannot produce target, receipt, or result facts. */
export function verifyM3ForageFixture(fixture) {
  const required = [
    "lawful_nonterminal_single_player_scope",
    "empty_terminal_outcome",
    "fresh_reader_required_for_opaque_spawned_forage_target",
    "range_and_inventory_capacity_must_be_rechecked_on_game_thread",
  ];
  const forbidden = [
    "prebound_target",
    "debris_target",
    "pickup_item_substitution",
    "target_removal",
    "inventory_delivery",
    "receipt_generation",
    "save_mutation",
    "gameplay_mutation",
    "ui_input",
    "raw_dispatch",
  ];
  return (
    exact(fixture, FIXTURE) &&
    fixture.schemaVersion === 1 &&
    fixture.fixtureId === "portfolio_m3_spawned_forage_preflight_fixture_v1" &&
    fixture.topology === TOPOLOGY &&
    fixture.action === ACTION &&
    fixture.fixtureBoundary === "non_mutating_preflight_only" &&
    Array.isArray(fixture.provides) &&
    Array.isArray(fixture.forbids) &&
    required.every((value) => fixture.provides.includes(value)) &&
    forbidden.every((value) => fixture.forbids.includes(value))
  );
}

/** Given producer: dynamic native read-only observation, never fixture success. */
export async function readM3ForageGiven({ observeNative, expectedScope } = {}) {
  if (typeof observeNative !== "function") return blocked("m3_forage_native_reader_required");
  try {
    const facts = await observeNative();
    if (
      !exact(facts, GIVEN) ||
      facts.source !== "target_version_native_spawned_forage_reader" ||
      facts.fresh !== true ||
      facts.readOnly !== true ||
      facts.saveMutationObserved !== false ||
      facts.gameplayMutationObserved !== false ||
      facts.terminalOutcomePresent !== false ||
      facts.topology !== TOPOLOGY ||
      !sameScope(facts.scope, expectedScope) ||
      !id(facts.requestId) ||
      !id(facts.traceId) ||
      !Number.isSafeInteger(facts.revision) ||
      facts.revision < 0 ||
      !target(facts.target, facts.revision) ||
      facts.inRange !== true ||
      facts.inventoryCapacityAvailable !== true ||
      facts.spawnedForagePresent !== true
    )
      return blocked("m3_forage_given_invalid");
    return Object.freeze({ state: "READY", kind: "m3_forage_given", facts: Object.freeze({ ...facts }) });
  } catch {
    return blocked("m3_forage_native_reader_failed");
  }
}

/** When consumer: bind exact fresh opaque target and all range/capacity guards. */
export function verifyM3ForageWhen({ request, given, expectedScope } = {}) {
  const scope = expectedScope ?? request?.scope;
  if (
    !requestValid(request, scope) ||
    given?.state !== "READY" ||
    request.requestId !== given.facts.requestId ||
    request.traceId !== given.facts.traceId ||
    request.expectedRevision !== given.facts.revision ||
    request.target.targetId !== given.facts.target.targetId ||
    request.target.selectorId !== given.facts.target.selectorId ||
    request.target.observationId !== given.facts.target.observationId
  )
    return blocked("m3_forage_exact_request_guard_invalid");
  return Object.freeze({
    state: "READY",
    kind: "m3_forage_when",
    requestId: request.requestId,
    traceId: request.traceId,
  });
}

/** Then verifier: static receipts cannot prove closure; currently demand the exact blocker handoff. */
export function verifyM3ForageBlockedHandoff({ request, receipt, expectedScope } = {}) {
  const scope = expectedScope ?? request?.scope;
  if (
    !requestValid(request, scope) ||
    !exact(receipt, RECEIPT) ||
    receipt.requestId !== request.requestId ||
    receipt.traceId !== request.traceId ||
    !id(receipt.executionId) ||
    receipt.state !== "blocked" ||
    receipt.reasonCode !== "forage_source_semantic_edge_unestablished" ||
    receipt.revision !== request.expectedRevision ||
    !sameScope(receipt.scope, scope) ||
    receipt.targetId !== request.target.targetId ||
    receipt.targetRemovedObserved !== false ||
    receipt.inventoryDelta !== 0 ||
    !Array.isArray(receipt.phaseTrace) ||
    receipt.phaseTrace.length !== 2
  )
    return blocked("m3_forage_blocked_handoff_invalid");
  return Object.freeze({
    state: "READY",
    kind: "m3_forage_then_blocked",
    requestId: request.requestId,
    traceId: request.traceId,
    executionId: receipt.executionId,
  });
}

export async function runM3ForagePreflight(args = {}) {
  const given = await readM3ForageGiven(args);
  if (given.state !== "READY") return Object.freeze({ state: "BLOCKED", given });
  const when = verifyM3ForageWhen({ ...args, given });
  if (when.state !== "READY") return Object.freeze({ state: "BLOCKED", given, when });
  const then = verifyM3ForageBlockedHandoff(args);
  if (then.state !== "READY") return Object.freeze({ state: "BLOCKED", given, when, then });
  return Object.freeze({ state: "BLOCKED", code: "m3_forage_source_semantic_edge_unestablished", given, when, then });
}

export const M3_FORAGE_PREFLIGHT_ACTION = ACTION;
export const M3_FORAGE_PREFLIGHT_TOPOLOGY = TOPOLOGY;
