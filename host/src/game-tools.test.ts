import assert from "node:assert/strict";
import test from "node:test";

import { createDeterministicBridgePair } from "./bridge.js";
import { createStardewActionTools, createStardewObservationTools, type MoveCapableIntegration } from "./game-tools.js";
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

test("mounted Game Action fails closed when the live Mod capability is withdrawn", async () => {
  let executeCalls = 0; let enabled = true;
  const integration: MoveCapableIntegration = {
    scope,
    get state() { return { connected: true, sessionId: "session_01", capabilities: enabled ? ["move_to_tile"] : [], snapshot: { revision: 3, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: enabled ? ["move_to_tile"] : [], activeExecution: null }, latestReceipt: null, latestReasonCode: null }; },
    async execute() { executeCalls++; throw new Error("must_not_execute"); },
    async cancel() { throw new Error("must_not_cancel"); },
  };
  const [move] = createStardewActionTools(integration);
  assert.ok(move);
  enabled = false;
  const result = await move.execute("test", { x: 3, y: 4 }, new AbortController().signal, () => {}, {} as never);
  assert.equal(executeCalls, 0);
  assert.equal((result.details as { reasonCode?: string }).reasonCode, "capability_not_declared");
});

test("equip_tool mounts only from a live capability and forwards the selected slot", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    get state() { return { connected: true, sessionId: "session_01", capabilities: ["equip_tool"], snapshot: { revision: 3, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: ["equip_tool"], activeExecution: null }, latestReceipt: null, latestReasonCode: null }; },
    async execute(request) { received = request; return { executionId: "execution_tool_01", requestId: request.requestId, state: "succeeded", reasonCode: "tool_selected", revision: 4, evidence: { before: "(W) Axe", expected: "(W) Pickaxe", after: "(W) Pickaxe" } }; },
    async cancel() { throw new Error("must_not_cancel"); },
  };
  const tools = createStardewActionTools(integration);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_equip_tool");
  const result = await tools[0]!.execute("test", { slot: 2, requestId: "request_tool_01", idempotencyKey: "idempotency_tool_01" }, new AbortController().signal, () => {}, {} as never);
  assert.equal((received as { action: string; args: { slot: number } }).action, "equip_tool");
  assert.equal((received as { args: { slot: number } }).args.slot, 2);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /tool_selected/);
});

test("mounted Game Actions return authoritative Mod receipts without inventing completion", async () => {
  const receipt = { executionId: "execution_01", requestId: "request_01", state: "accepted" as const, reasonCode: "accepted", revision: 3, evidence: { target: "3,4" } };
  const integration: MoveCapableIntegration = {
    scope,
    get state() { return { connected: true, sessionId: "session_01", capabilities: ["move_to_tile", "cancel_active_execution"], snapshot: { revision: 3, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: ["move_to_tile", "cancel_active_execution"], activeExecution: null }, latestReceipt: null, latestReasonCode: null }; },
    async execute(request) { assert.equal(request.expectedRevision, 3); assert.equal(request.action, "move_to_tile"); return receipt; },
    async cancel() { return receipt; },
  };
  const [move, cancel] = createStardewActionTools(integration);
  assert.ok(move);
  assert.ok(cancel);
  const result = await move.execute("test", { x: 3, y: 4, requestId: "request_01", idempotencyKey: "idempotency_01" }, new AbortController().signal, () => {}, {} as never);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /"state":"accepted"/);
  assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /succeeded/);
  const cancelled = await cancel.execute("test", { requestId: "request_01", executionId: "execution_01" }, new AbortController().signal, () => {}, {} as never);
  assert.match(cancelled.content[0]?.type === "text" ? cancelled.content[0].text : "", /"state":"accepted"/);
});
