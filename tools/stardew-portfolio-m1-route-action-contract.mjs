import { readFile } from "node:fs/promises";

const ACTION = "m1_leave_and_return_route";
const SOURCE_AUDIT = "portfolio_m1_route_source_audit_v1";
const BLOCKER = "m1_route_source_projection_blocked";
const COMPOSITION = Object.freeze(["move_to_tile", "travel", "enter_exit", "move_to_tile"]);
const FIXTURE = "fixtures/stardew/portfolio-m1-route-contract.unprovisioned.json";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SCOPE_KEYS = Object.freeze(["integrationId", "topology", "saveId", "worldId", "localPlayerId", "companionId", "bindingGeneration", "bindingHash"]);

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function sameScope(left, right) { return exact(left, SCOPE_KEYS) && exact(right, SCOPE_KEYS) && SCOPE_KEYS.every((key) => left[key] === right[key]); }
function blocked(code, details = {}) { return Object.freeze({ state: "BLOCKED", code, ...details }); }

/** Static producer/consumer/verifier contract for M1's source-proven blocker. */
export function validateM1RouteBlockerFixture(fixture) {
  if (!exact(fixture, ["schemaVersion", "artifactKind", "fixtureId", "topology", "state", "mutation", "terminalOutcome", "checkpoint", "receipt", "nativeEvidence", "notes"]) ||
      fixture.schemaVersion !== 1 || fixture.artifactKind !== "portfolio_route_blocker_fixture" ||
      fixture.fixtureId !== "portfolio_m1_leave_and_return_route_unprovisioned_v1" || fixture.topology !== "single_player_native_companion" ||
      fixture.state !== "unprovisioned" || fixture.mutation !== false || fixture.terminalOutcome !== false ||
      fixture.checkpoint !== null || fixture.receipt !== null || fixture.nativeEvidence !== null)
    return ["m1_route_fixture_invalid"];
  return [];
}
export function validateM1RouteBlocker({ request, checkpoint, receipt, expectedScope, nowMs = Date.now() } = {}) {
  if (!exact(request, ["action", "requestId", "traceId", "idempotencyKey", "expectedRevision", "deadlineMs", "cancellationToken", "composition", "scope"]) ||
      request.action !== ACTION || !ID.test(request.requestId ?? "") || !ID.test(request.traceId ?? "") || !ID.test(request.idempotencyKey ?? "") ||
      !ID.test(request.cancellationToken ?? "") || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= nowMs || JSON.stringify(request.composition) !== JSON.stringify(COMPOSITION) || !sameScope(request.scope, expectedScope))
    return blocked("m1_route_request_invalid");
  if (!exact(checkpoint, ["observationId", "opaqueCheckpoint", "revision", "scope", "fresh", "playerAvailable", "worldReady", "policyAllowed"]) ||
      !ID.test(checkpoint.observationId ?? "") || !ID.test(checkpoint.opaqueCheckpoint ?? "") || checkpoint.revision !== request.expectedRevision ||
      !sameScope(checkpoint.scope, expectedScope) || checkpoint.fresh !== true || checkpoint.playerAvailable !== true || checkpoint.worldReady !== true || checkpoint.policyAllowed !== true)
    return blocked("m1_route_given_invalid");
  if (!exact(receipt, ["requestId", "traceId", "executionId", "state", "revision", "reasonCode", "sourceAuditId", "opaqueCheckpoint"]) ||
      receipt.requestId !== request.requestId || receipt.traceId !== request.traceId || !ID.test(receipt.executionId ?? "") || receipt.state !== "blocked" ||
      receipt.revision !== checkpoint.revision || receipt.reasonCode !== BLOCKER || receipt.sourceAuditId !== SOURCE_AUDIT || receipt.opaqueCheckpoint !== checkpoint.opaqueCheckpoint)
    return blocked("m1_route_blocker_handoff_invalid");
  return Object.freeze({ state: "BLOCKED", code: BLOCKER, producer: SOURCE_AUDIT, consumer: ACTION, verifier: "m1_route_static_preflight", requestId: request.requestId, traceId: request.traceId, executionId: receipt.executionId });
}
export async function checkM1RouteBlockerFixture(path = FIXTURE) {
  const fixture = JSON.parse(await readFile(path, "utf8"));
  const errors = validateM1RouteBlockerFixture(fixture);
  if (errors.length) throw new Error(errors.join(", "));
  return Object.freeze({ state: "BLOCKED", code: BLOCKER, fixtureState: fixture.state, mutation: fixture.mutation, liveClosure: "not_performed" });
}
