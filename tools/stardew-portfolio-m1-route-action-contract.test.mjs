import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkM1RouteBlockerFixture, validateM1RouteBlocker, validateM1RouteBlockerFixture } from "./stardew-portfolio-m1-route-action-contract.mjs";

const scope = Object.freeze({ integrationId: "stardew_portfolio", topology: "single_player_native_companion", saveId: "save", worldId: "world", localPlayerId: "player", companionId: "companion", bindingGeneration: 1, bindingHash: "a".repeat(64) });
const request = Object.freeze({ action: "m1_leave_and_return_route", requestId: "request", traceId: "trace", idempotencyKey: "idem", expectedRevision: 7, deadlineMs: Date.now() + 60_000, cancellationToken: "c".repeat(16), composition: ["move_to_tile", "travel", "enter_exit", "move_to_tile"], scope });
const checkpoint = Object.freeze({ observationId: "observation", opaqueCheckpoint: "checkpoint", revision: 7, scope, fresh: true, playerAvailable: true, worldReady: true, policyAllowed: true });
const receipt = Object.freeze({ requestId: "request", traceId: "trace", executionId: "execution", state: "blocked", revision: 7, reasonCode: "m1_route_source_projection_blocked", sourceAuditId: "portfolio_m1_route_source_audit_v1", opaqueCheckpoint: "checkpoint" });

test("M1 Given → When → Then preserves the source-bound blocker producer, typed composition consumer, and exact verifier handoff", () => {
  const result = validateM1RouteBlocker({ request, checkpoint, receipt, expectedScope: scope });
  assert.deepEqual(result, { state: "BLOCKED", code: "m1_route_source_projection_blocked", producer: "portfolio_m1_route_source_audit_v1", consumer: "m1_leave_and_return_route", verifier: "m1_route_static_preflight", requestId: "request", traceId: "trace", executionId: "execution" });
});
test("M1 rejects generic travel/warp widening, stale Given facts, and synthetic success", () => {
  assert.equal(validateM1RouteBlocker({ request: { ...request, composition: ["travel"] }, checkpoint, receipt, expectedScope: scope }).code, "m1_route_request_invalid");
  assert.equal(validateM1RouteBlocker({ request, checkpoint: { ...checkpoint, fresh: false }, receipt, expectedScope: scope }).code, "m1_route_given_invalid");
  assert.equal(validateM1RouteBlocker({ request, checkpoint, receipt: { ...receipt, state: "succeeded" }, expectedScope: scope }).code, "m1_route_blocker_handoff_invalid");
});
test("M1 fixture is non-mutating and cannot provide an outcome, checkpoint, receipt, or native evidence", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/stardew/portfolio-m1-route-contract.unprovisioned.json", import.meta.url), "utf8"));
  assert.deepEqual(validateM1RouteBlockerFixture(fixture), []);
  assert.equal((await checkM1RouteBlockerFixture()).state, "BLOCKED");
  fixture.mutation = true;
  assert.deepEqual(validateM1RouteBlockerFixture(fixture), ["m1_route_fixture_invalid"]);
});
