import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MESSAGE_BYTES,
  newEnvelope,
  serializeBounded,
  validateBridgeMessage,
  validateEnvelope,
  validateExecutionRequest,
  type Scope,
  type Snapshot,
} from "./protocol.js";

const scope: Scope = { integrationId: "stardew", saveId: "save_01", worldId: "world_01", playerId: "player_01", companionId: "companion_01" };
const snapshot: Snapshot = {
  revision: 4, location: "Farm", tile: { x: 10, y: 11 }, stamina: 270, health: 100,
  actionable: true, capabilities: ["move_to_tile", "inspect_self"], activeExecution: null,
};
const now = 1_700_000_000_000;

test("hello acknowledgement carries only Mod-declared player-enabled capabilities", () => {
  const valid = newEnvelope("hello_ack", scope, { sessionId: "session_01", capabilities: ["move_to_tile"] }, "hello_01", now);
  assert.equal(validateBridgeMessage(valid, scope, now), null);
  assert.equal(validateBridgeMessage(newEnvelope("hello_ack", scope, { sessionId: "invalid session", capabilities: [] }, "hello_02", now), scope, now), "invalid_hello_ack");
  assert.equal(validateBridgeMessage(newEnvelope("hello_ack", scope, { sessionId: "session_01", capabilities: [1] }, "hello_03", now), scope, now), "invalid_hello_ack");
});

test("protocol envelope rejects mismatched identity, version, stale timestamps, and unknown types", () => {
  const valid = newEnvelope("observe_request", scope, {}, "correlation_01", now);
  assert.equal(validateEnvelope(valid, scope, now), null);
  assert.equal(validateEnvelope({ ...valid, protocolVersion: 2 }, scope, now), "unsupported_protocol_version");
  assert.equal(validateEnvelope({ ...valid, scope: { ...scope, saveId: "other_save" } }, scope, now), "scope_mismatch:saveId");
  assert.equal(validateEnvelope({ ...valid, timestampMs: now - 300_001 }, scope, now), "stale_or_invalid_timestamp");
  assert.equal(validateEnvelope({ ...valid, type: "teleport" }, scope, now), "unknown_message_type");
  assert.equal(validateBridgeMessage(valid, scope, now), null);
  assert.equal(validateBridgeMessage({ ...valid, payload: { extra: true } }, scope, now), "invalid_observe_request");
});

test("bridge message payloads fail closed", () => {
  const hello = newEnvelope("hello", scope, { token: "a".repeat(16) }, "hello_01", now);
  assert.equal(validateBridgeMessage(hello, scope, now), null);
  assert.equal(validateBridgeMessage({ ...hello, payload: { token: "short" } }, scope, now), "invalid_hello_token");
  const receipt = newEnvelope("execution_receipt", scope, {
    executionId: "execution_01", requestId: "request_01", state: "succeeded", reasonCode: "target_reached", revision: 5, evidence: { tile: "11,12" },
  }, "receipt_01", now);
  assert.equal(validateBridgeMessage(receipt, scope, now), null);
  assert.equal(validateBridgeMessage({ ...receipt, payload: { ...receipt.payload, state: "made_up" } }, scope, now), "invalid_receipt");
  const malformedSnapshot = newEnvelope("snapshot", scope, { revision: 1, location: "Farm", tile: { x: Number.NaN, y: 1 }, stamina: 1, health: 1, actionable: true, capabilities: [], activeExecution: null }, "snapshot_01", now);
  assert.equal(validateBridgeMessage(malformedSnapshot, scope, now), "invalid_snapshot");
  const badActive = newEnvelope("snapshot", scope, { ...snapshot, activeExecution: { executionId: "execution_01", requestId: "request_01", action: "move_to_tile", state: "made_up", reasonCode: "bad", evidence: null } }, "snapshot_02", now);
  assert.equal(validateBridgeMessage(badActive, scope, now), "invalid_snapshot");
  assert.equal(validateBridgeMessage(newEnvelope("error", scope, { reasonCode: "authentication_failed" }, "error_01", now), scope, now), null);
});

test("execution validation fails closed for stale, unknown, malformed, and unactionable requests", () => {
  const valid = { requestId: "request_01", idempotencyKey: "idempotency_01", action: "move_to_tile", args: { x: 11, y: 12 }, expectedRevision: 4, deadlineMs: now + 10_000 };
  assert.equal(validateExecutionRequest(valid, snapshot, now), null);
  assert.equal(validateExecutionRequest({ ...valid, expectedRevision: 3 }, snapshot, now), "stale_snapshot");
  assert.equal(validateExecutionRequest({ ...valid, action: "sell_item" }, snapshot, now), "unknown_action");
  assert.equal(validateExecutionRequest({ ...valid, args: { x: -1, y: 12 } }, snapshot, now), "invalid_target_tile");
  assert.equal(validateExecutionRequest({ ...valid, args: { x: 11.5, y: 12 } }, snapshot, now), "invalid_target_tile");
  assert.equal(validateExecutionRequest(valid, { ...snapshot, actionable: false }, now), "player_not_actionable");
});

test("protocol serialization rejects oversized, undefined, and circular values", () => {
  assert.throws(() => serializeBounded({ payload: "x".repeat(MAX_MESSAGE_BYTES + 1) }), /message_too_large/);
  assert.throws(() => serializeBounded(undefined), /message_not_serializable/);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => serializeBounded(circular), /message_not_serializable/);
});
