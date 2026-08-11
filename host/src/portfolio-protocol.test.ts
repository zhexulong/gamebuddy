import assert from "node:assert/strict";
import test from "node:test";
import { PORTFOLIO_INTEGRATION_ID, PORTFOLIO_TOPOLOGY, newPortfolioEnvelope, validatePortfolioMessage, validatePortfolioSnapshot } from "./portfolio-protocol.js";

const scope = { integrationId: PORTFOLIO_INTEGRATION_ID, topology: PORTFOLIO_TOPOLOGY, saveId: "save_01", worldId: "world_01", localPlayerId: "player_01", companionId: "companion_01", bindingGeneration: 1, bindingHash: "a".repeat(64) } as const;
const snapshot = { protocolVersion: 1, integrationId: PORTFOLIO_INTEGRATION_ID, topology: PORTFOLIO_TOPOLOGY, saveId: scope.saveId, worldId: scope.worldId, localPlayerId: scope.localPlayerId, companionId: scope.companionId, bindingGeneration: 1, bindingHash: scope.bindingHash, revision: 1, worldReady: true, singlePlayer: true, currentLocalPlayerMatches: true, state: "ready", reasonCode: "accepted" } as const;

test("Portfolio protocol accepts only exact topology-scoped hello and observe messages", () => {
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("hello", scope, { token: "portfolio_test_token_1234" }), scope), null);
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("observe_request", scope, {}), scope), null);
  assert.equal(validatePortfolioMessage({ ...newPortfolioEnvelope("observe_request", scope, {}), payload: { extra: true } }, scope), "invalid_portfolio_observe_request");
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("execution_request" as never, scope, {}), scope), "portfolio_message_type_rejected");
  assert.equal(validatePortfolioSnapshot(snapshot), null);
});

test("Portfolio protocol rejects Farmhand scopes and mutation-shaped snapshots", () => {
  const farmhandScope = { ...scope, integrationId: "stardew" as never };
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("observe_request", farmhandScope, {}), scope), "invalid_portfolio_envelope");
  assert.equal(validatePortfolioSnapshot({ ...snapshot, capabilities: [] }), "invalid_portfolio_snapshot");
  assert.equal(validatePortfolioSnapshot({ ...snapshot, activeExecution: null }), "invalid_portfolio_snapshot");
  assert.equal(validatePortfolioSnapshot({ ...snapshot, topology: "native_ai_farmhand_multiplayer" }), "invalid_portfolio_snapshot");
  assert.equal(validatePortfolioMessage({ ...newPortfolioEnvelope("snapshot", scope, snapshot), payload: { ...snapshot, bindingGeneration: 2 } }, scope), "portfolio_snapshot_scope_mismatch");
});
