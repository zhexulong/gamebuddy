import assert from "node:assert/strict";
import test from "node:test";

import { createDeterministicBridgePair } from "./bridge.js";
import { type BridgeMessage, type Envelope, MAX_EVENTS_PER_WINDOW, newEnvelope, type Scope } from "./protocol.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const now = 1_700_000_000_000;
const hello = (): Envelope<"hello", { token: string }> =>
  newEnvelope("hello", scope, { token: "a".repeat(16) }, "hello_01", now);
const event = (id: string): BridgeMessage =>
  newEnvelope(
    "semantic_event",
    scope,
    { kind: "connection_state" as const, revision: 1, activeExecution: null, reasonCode: "fixture_event" },
    id,
    now,
  );

test("deterministic bridge preserves an exact ordered replay", () => {
  const [host, integration] = createDeterministicBridgePair(scope);
  const delivered: BridgeMessage[] = [];
  integration.onMessage((message) => delivered.push(message));

  assert.equal(host.send(hello(), now), null);
  const lifecycle: BridgeMessage = newEnvelope(
    "lifecycle",
    scope,
    { state: "connected" as const, reasonCode: "fixture_connected" },
    "life_01",
    now,
  );
  assert.equal(host.send(lifecycle, now), null);
  assert.deepEqual(
    delivered.map((message) => message.type),
    ["hello", "lifecycle"],
  );
  assert.notEqual(delivered[0], hello());
});

test("deterministic bridge fails closed for scope/version/payload violations", () => {
  const [host, integration] = createDeterministicBridgePair(scope);
  let received = 0;
  integration.onMessage(() => received++);
  const validHello = hello();
  assert.equal(host.send({ ...validHello, scope: { ...scope, saveId: "other_save" } }, now), "invalid_message");
  assert.equal(host.send({ ...validHello, protocolVersion: 999 }, now), "invalid_message");
  assert.equal(host.send({ ...validHello, payload: { token: "short" } }, now), "invalid_message");
  assert.equal(received, 0);
  const [differentScopeHost] = createDeterministicBridgePair({ ...scope, playerId: "other_player" });
  assert.equal(differentScopeHost.send(hello(), now), "invalid_message");
});

test("deterministic bridge rate limits semantic events and supports explicit reconnection", () => {
  const [host, integration] = createDeterministicBridgePair(scope);
  for (let index = 0; index < MAX_EVENTS_PER_WINDOW; index++)
    assert.equal(host.send(event(`event_${index}`), now), null);
  assert.equal(host.send(event("event_over"), now), "rate_limited");
  assert.equal(host.send(event("event_next_window"), now + 1_000), null);

  let hostReason = "";
  let integrationReason = "";
  host.onDisconnect((reason) => {
    hostReason = reason;
  });
  integration.onDisconnect((reason) => {
    integrationReason = reason;
  });
  host.disconnect("fixture_disconnect");
  assert.equal(hostReason, "fixture_disconnect");
  assert.equal(integrationReason, "fixture_disconnect");
  assert.equal(integration.send(hello(), now), "disconnected");
  host.connect(integration);
  integration.connect(host);
  assert.equal(integration.send(hello(), now), null);
});
