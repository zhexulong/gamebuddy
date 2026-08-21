import assert from "node:assert/strict";
import test from "node:test";

import { createDeterministicBridgePair } from "./bridge.js";
import { CompanionIntegrationClient } from "./integration.js";
import {
  type BridgeMessage,
  type CancelRequestPayload,
  newEnvelope,
  type Scope,
  validateBridgeMessage,
} from "./protocol.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const now = 1_700_000_000_000;
const token = "a".repeat(16);

function snapshot(revision = 3) {
  return {
    revision,
    location: "Farm",
    tile: { x: 10, y: 11 },
    stamina: 270,
    health: 100,
    actionable: true,
    capabilities: ["move_to_tile", "inspect_self"],
    presentationLocale: "en-US",
    activeExecution: null,
  } as const;
}

test("integration client exposes only Mod-originated state and receipts", () => {
  const [hostEndpoint, modEndpoint] = createDeterministicBridgePair(scope);
  const client = new CompanionIntegrationClient(scope, hostEndpoint, STARDEW_INTEGRATION_MODULE);
  const modInbound: string[] = [];
  modEndpoint.onMessage((message) => {
    modInbound.push(message.type);
    if (message.type === "hello")
      modEndpoint.send(
        newEnvelope(
          "hello_ack",
          scope,
          { sessionId: "session_01", capabilities: ["move_to_tile", "inspect_self"], presentationLocale: "en-US" },
          message.correlationId,
          now,
        ),
        now,
      );
    if (message.type === "observe_request")
      modEndpoint.send(newEnvelope("snapshot", scope, snapshot(), message.correlationId, now), now);
    if (message.type === "execution_request") {
      const receipt: BridgeMessage = newEnvelope(
        "execution_receipt",
        scope,
        {
          executionId: "execution_01",
          requestId: message.payload.requestId,
          state: "accepted" as const,
          reasonCode: "accepted",
          revision: 4,
          evidence: { target: "11,12" },
        },
        message.correlationId,
        now,
      );
      modEndpoint.send(receipt, now);
    }
  });

  assert.equal(client.hello(token, now), null);
  assert.equal(client.state.connected, true);
  assert.equal(client.observe(now), null);
  assert.equal(client.state.snapshot?.revision, 3);
  const request = {
    requestId: "request_01",
    idempotencyKey: "idempotency_01",
    action: "move_to_tile" as const,
    args: { x: 11, y: 12 },
    expectedRevision: 3,
    deadlineMs: now + 10_000,
  };
  assert.equal(client.execute(request, now), null);
  assert.equal(client.state.latestReceipt?.state, "accepted");
  assert.deepEqual(modInbound, ["hello", "observe_request", "execution_request"]);
  client.dispose();
});

test("integration client keeps the newest Mod snapshot when a delayed older snapshot arrives", () => {
  const [hostEndpoint, modEndpoint] = createDeterministicBridgePair(scope);
  const client = new CompanionIntegrationClient(scope, hostEndpoint, STARDEW_INTEGRATION_MODULE);
  modEndpoint.send(
    newEnvelope(
      "hello_ack",
      scope,
      { sessionId: "session_01", capabilities: ["inspect_self"], presentationLocale: "en-US" },
      "hello_01",
      now,
    ),
    now,
  );
  modEndpoint.send(newEnvelope("snapshot", scope, snapshot(8), "snapshot_new", now), now);
  modEndpoint.send(newEnvelope("snapshot", scope, snapshot(7), "snapshot_old", now), now);
  assert.equal(client.state.snapshot?.revision, 8);
  client.dispose();
});

test("integration client fails closed before hello/snapshot and on disconnect", () => {
  const [hostEndpoint, modEndpoint] = createDeterministicBridgePair(scope);
  const client = new CompanionIntegrationClient(scope, hostEndpoint, STARDEW_INTEGRATION_MODULE);
  const request = {
    requestId: "request_01",
    idempotencyKey: "idempotency_01",
    action: "move_to_tile" as const,
    args: { x: 11, y: 12 },
    expectedRevision: 0,
    deadlineMs: now + 10_000,
  };
  assert.equal(client.execute(request, now), "not_ready");
  modEndpoint.disconnect("bridge_lost");
  assert.equal(client.state.connected, false);
  assert.equal(client.state.latestReasonCode, "bridge_lost");
  assert.equal(client.observe(now), "disconnected");
  client.dispose();
});

test("integration client binds a typed cancel identity per request and validates it before sending", () => {
  const [hostEndpoint, modEndpoint] = createDeterministicBridgePair(scope);
  const client = new CompanionIntegrationClient(scope, hostEndpoint, STARDEW_INTEGRATION_MODULE);
  const cancelPayloads: CancelRequestPayload[] = [];
  modEndpoint.onMessage((message) => {
    if (message.type === "hello")
      modEndpoint.send(
        newEnvelope(
          "hello_ack",
          scope,
          { sessionId: "session_01", capabilities: ["move_to_tile"], presentationLocale: "en-US" },
          message.correlationId,
          now,
        ),
        now,
      );
    if (message.type === "cancel_request") {
      cancelPayloads.push(message.payload);
      modEndpoint.send(
        newEnvelope(
          "execution_receipt",
          scope,
          {
            executionId: message.payload.executionId,
            requestId: message.payload.requestId,
            state: "cancelled" as const,
            reasonCode: "stop_requested",
            revision: 4,
            evidence: null,
          },
          message.correlationId,
          now,
        ),
        now,
      );
    }
  });

  assert.equal(client.hello(token, now), null);
  assert.equal(client.cancel("request_01", "execution_01", "stop_requested", now), null);
  assert.equal(client.cancel("request_01", "execution_01", "stop_requested", now), null);
  assert.equal(client.cancel("request_02", "execution_02", "stop_requested", now), null);
  assert.equal(cancelPayloads.length, 3);
  // One stable cancelId per request; cancelEpoch strictly increases per attempt.
  assert.equal(cancelPayloads[0].cancelId, cancelPayloads[1].cancelId);
  assert.equal(cancelPayloads[0].cancelEpoch, 1);
  assert.equal(cancelPayloads[1].cancelEpoch, 2);
  assert.notEqual(cancelPayloads[2].cancelId, cancelPayloads[0].cancelId);
  assert.equal(cancelPayloads[2].cancelEpoch, 1);
  // Every cancel envelope carries the full typed identity and passes the
  // Host-side validator (the deterministic endpoint also rejects it on send).
  for (const payload of cancelPayloads) {
    assert.equal(
      validateBridgeMessage(newEnvelope("cancel_request", scope, payload, undefined, now), scope, now),
      null,
    );
    assert.match(payload.cancelId, /^[A-Za-z0-9_-]{1,128}$/);
  }
  assert.equal(client.state.latestReceipt?.state, "cancelled");
  client.dispose();
});
