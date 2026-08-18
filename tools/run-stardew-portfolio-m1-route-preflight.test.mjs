import assert from "node:assert/strict";
import test from "node:test";
import { runM1RoutePreflight } from "./run-stardew-portfolio-m1-route-preflight.mjs";

const scope = {
  integrationId: "stardew_portfolio",
  topology: "single_player_native_companion",
  saveId: "save",
  worldId: "world",
  localPlayerId: "player",
  companionId: "companion",
  bindingGeneration: 1,
  bindingHash: "a".repeat(64),
};
const request = {
  action: "m1_leave_and_return_route",
  requestId: "request",
  traceId: "trace",
  idempotencyKey: "idem",
  expectedRevision: 7,
  deadlineMs: Date.now() + 60_000,
  cancellationToken: "c".repeat(16),
  composition: ["move_to_tile", "travel", "enter_exit", "move_to_tile"],
  scope,
};
const checkpoint = {
  observationId: "observation",
  opaqueCheckpoint: "checkpoint",
  revision: 7,
  scope,
  fresh: true,
  playerAvailable: true,
  worldReady: true,
  policyAllowed: true,
};
const receipt = {
  requestId: "request",
  traceId: "trace",
  executionId: "execution",
  state: "blocked",
  revision: 7,
  reasonCode: "m1_route_source_projection_blocked",
  sourceAuditId: "portfolio_m1_route_source_audit_v1",
  opaqueCheckpoint: "checkpoint",
};

test("M1 preflight remains a non-mutating blocker handoff rather than a synthetic route result", async () => {
  const result = await runM1RoutePreflight({ request, checkpoint, receipt, expectedScope: scope });
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.code, "m1_route_source_projection_blocked");
  assert.equal(result.nativeMutation, false);
  assert.equal(result.liveClosure, "not_performed");
});
