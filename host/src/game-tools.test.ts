import assert from "node:assert/strict";
import test from "node:test";

import { createDeterministicBridgePair } from "./bridge.js";
import { createStardewObservationTools } from "./game-tools.js";
import { CompanionIntegrationClient } from "./integration.js";
import { newEnvelope, type Scope } from "./protocol.js";

const scope: Scope = { integrationId: "stardew", saveId: "save_01", worldId: "world_01", playerId: "player_01", companionId: "companion_01" };
const now = 1_700_000_000_000;

test("Stardew Host tools expose only factual observation and receipt surfaces", async () => {
  const [host, mod] = createDeterministicBridgePair(scope);
  const client = new CompanionIntegrationClient(scope, host);
  const [observe, execution] = createStardewObservationTools(client);
  assert.deepEqual([observe.name, execution.name], ["stardew_observe", "stardew_execution_status"]);
  const unavailable = await observe.execute("test", {}, new AbortController().signal, () => {}, {} as never);
  assert.match(unavailable.content[0]?.type === "text" ? unavailable.content[0].text : "", /No authoritative/);

  mod.onMessage((message) => {
    if (message.type === "hello") mod.send(newEnvelope("hello_ack", scope, { sessionId: "session_01", capabilities: ["move_to_tile"] }, message.correlationId, now), now);
    if (message.type === "observe_request") mod.send(newEnvelope("snapshot", scope, { revision: 1, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: ["move_to_tile"], activeExecution: null }, message.correlationId, now), now);
  });
  client.hello("a".repeat(16), now);
  client.observe(now);
  const observed = await observe.execute("test", {}, new AbortController().signal, () => {}, {} as never);
  assert.match(observed.content[0]?.type === "text" ? observed.content[0].text : "", /"location":"Farm"/);
  const noReceipt = await execution.execute("test", {}, new AbortController().signal, () => {}, {} as never);
  assert.match(noReceipt.content[0]?.type === "text" ? noReceipt.content[0].text : "", /No authoritative/);
  client.dispose();
});
