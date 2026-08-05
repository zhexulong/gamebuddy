import assert from "node:assert/strict";
import test from "node:test";

import { createDeterministicBridgePair } from "./bridge.js";
import { createStardewActionTools, createStardewObservationTools, type MoveCapableIntegration } from "./game-tools.js";
import { CompanionIntegrationClient } from "./integration.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";
import { newEnvelope, type Scope } from "./protocol.js";

const scope: Scope = { integrationId: "stardew", saveId: "save_01", worldId: "world_01", playerId: "player_01", companionId: "companion_01" };
const now = 1_700_000_000_000;

test("Stardew Host tools expose only factual observation and receipt surfaces", async () => {
  const [host, mod] = createDeterministicBridgePair(scope);
  const client = new CompanionIntegrationClient(scope, host, STARDEW_INTEGRATION_MODULE);
  const [observe, execution, catalog, search] = createStardewObservationTools(client);
  assert.deepEqual([observe.name, execution.name, catalog.name, search.name], ["stardew_observe", "stardew_execution_status", "stardew_interaction_catalog", "stardew_search_interactions"]);
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
    module: STARDEW_INTEGRATION_MODULE,
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
    module: STARDEW_INTEGRATION_MODULE,
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

test("enter_exit mounts from a live capability and forwards the door tile", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() { return { connected: true, sessionId: "session_01", capabilities: ["enter_exit"], snapshot: { revision: 3, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: ["enter_exit"], activeExecution: null }, latestReceipt: null, latestReasonCode: null }; },
    async execute(request) { received = request; return { executionId: "execution_door_01", requestId: request.requestId, state: "accepted", reasonCode: "accepted", revision: 4, evidence: null }; },
    async cancel() { throw new Error("must_not_cancel"); },
  };
  const tools = createStardewActionTools(integration);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_enter_exit");
  await tools[0]!.execute("test", { x: 10, y: 11, requestId: "request_door_01", idempotencyKey: "idempotency_door_01" }, new AbortController().signal, () => {}, {} as never);
  assert.equal((received as { action: string }).action, "enter_exit");
  assert.deepEqual((received as { args: { x: number; y: number } }).args, { x: 10, y: 11 });
});

test("published pickup_item mounts only from a live capability and forwards the opaque live target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() { return { connected: true, sessionId: "session_01", capabilities: ["pickup_item"], snapshot: { revision: 3, location: "Farm", tile: { x: 25, y: 33 }, stamina: 100, health: 100, actionable: true, capabilities: ["pickup_item"], activeExecution: null }, latestReceipt: null, latestReasonCode: null }; },
    async execute(request) { received = request; return { executionId: "execution_item_01", requestId: request.requestId, state: "succeeded", reasonCode: "item_picked_up", revision: 4, evidence: { detail: "target=item_target_01;native_auto_collect=true;chunk_removed=true;inventory_before=0;inventory_after=1" } }; },
    async cancel() { throw new Error("must_not_cancel"); },
  };
  const tools = createStardewActionTools(integration);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_pickup_item");
  await tools[0]!.execute("test", { x: 21, y: 29, expectedQualifiedItemId: "(O)388", expectedTargetId: "item_target_01", requestId: "request_item_01", idempotencyKey: "idempotency_item_01" }, new AbortController().signal, () => {}, {} as never);
  assert.deepEqual(received, { requestId: "request_item_01", idempotencyKey: "idempotency_item_01", action: "pickup_item", args: { x: 21, y: 29, expectedQualifiedItemId: "(O)388", expectedTargetId: "item_target_01" }, expectedRevision: 3, deadlineMs: (received as { deadlineMs: number }).deadlineMs });
});

test("published plant_seed mounts only from a live capability and forwards the opaque live target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() { return { connected: true, sessionId: "session_01", capabilities: ["plant_seed"], snapshot: { revision: 3, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: ["plant_seed"], activeExecution: null }, latestReceipt: null, latestReasonCode: null }; },
    async execute(request) { received = request; return { executionId: "execution_seed_01", requestId: request.requestId, state: "succeeded", reasonCode: "seed_planted", revision: 4, evidence: { detail: "crop=479" } }; },
    async cancel() { throw new Error("must_not_cancel"); },
  };
  const tools = createStardewActionTools(integration);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_plant_seed");
  await tools[0]!.execute("test", { slot: 5, x: 2, y: 3, expectedQualifiedItemId: "(O)479", expectedTargetId: "seed_target_01", requestId: "request_seed_01", idempotencyKey: "idempotency_seed_01" }, new AbortController().signal, () => {}, {} as never);
  assert.deepEqual(received, { requestId: "request_seed_01", idempotencyKey: "idempotency_seed_01", action: "plant_seed", args: { slot: 5, x: 2, y: 3, expectedQualifiedItemId: "(O)479", expectedTargetId: "seed_target_01" }, expectedRevision: 3, deadlineMs: (received as { deadlineMs: number }).deadlineMs });
  assert.ok((received as { deadlineMs: number }).deadlineMs >= Date.now() - 1_000);
});

test("published use_item mounts only from a live capability and forwards the food slot", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() { return { connected: true, sessionId: "session_01", capabilities: ["use_item"], snapshot: { revision: 3, location: "FarmHouse", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: ["use_item"], activeExecution: null }, latestReceipt: null, latestReasonCode: null }; },
    async execute(request) { received = request; return { executionId: "execution_food_01", requestId: request.requestId, state: "succeeded", reasonCode: "item_used", revision: 4, evidence: { detail: "slot=5;item=(O)216;stack_before=3;stack_after=2;animation_complete=true" } }; },
    async cancel() { throw new Error("must_not_cancel"); },
  };
  const tools = createStardewActionTools(integration);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_use_item");
  await tools[0]!.execute("test", { slot: 5, expectedQualifiedItemId: "(O)216", requestId: "request_food_01", idempotencyKey: "idempotency_food_01" }, new AbortController().signal, () => {}, {} as never);
  assert.deepEqual(received, { requestId: "request_food_01", idempotencyKey: "idempotency_food_01", action: "use_item", args: { slot: 5, expectedQualifiedItemId: "(O)216" }, expectedRevision: 3, deadlineMs: (received as { deadlineMs: number }).deadlineMs });
});

test("published harvest_crop mounts only from a live capability and forwards the opaque target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() { return { connected: true, sessionId: "session_01", capabilities: ["harvest_crop"], snapshot: { revision: 3, location: "Farm", tile: { x: 38, y: 19 }, stamina: 100, health: 100, actionable: true, capabilities: ["harvest_crop"], activeExecution: null }, latestReceipt: null, latestReasonCode: null }; },
    async execute(request) { received = request; return { executionId: "execution_harvest_01", requestId: request.requestId, state: "succeeded", reasonCode: "crop_harvested", revision: 4, evidence: { detail: "crop=480;item=(O)256;inventory_before=0;inventory_after=1;regrows=true" } }; },
    async cancel() { throw new Error("must_not_cancel"); },
  };
  const tools = createStardewActionTools(integration);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_harvest_crop");
  await tools[0]!.execute("test", { x: 39, y: 19, expectedQualifiedItemId: "(O)256", expectedTargetId: "crop_target_01", requestId: "request_harvest_01", idempotencyKey: "idempotency_harvest_01" }, new AbortController().signal, () => {}, {} as never);
  assert.deepEqual(received, { requestId: "request_harvest_01", idempotencyKey: "idempotency_harvest_01", action: "harvest_crop", args: { x: 39, y: 19, expectedQualifiedItemId: "(O)256", expectedTargetId: "crop_target_01" }, expectedRevision: 3, deadlineMs: (received as { deadlineMs: number }).deadlineMs });
});

test("published machine_inspect mounts only from a live capability and forwards the opaque target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() { return { connected: true, sessionId: "session_01", capabilities: ["machine_inspect"], snapshot: { revision: 3, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: ["machine_inspect"], activeExecution: null }, latestReceipt: null, latestReasonCode: null }; },
    async execute(request) { received = request; return { executionId: "execution_machine_01", requestId: request.requestId, state: "succeeded", reasonCode: "machine_inspected", revision: 4, evidence: { detail: "machine=(BC)12" } }; },
    async cancel() { throw new Error("must_not_cancel"); },
  };
  const tools = createStardewActionTools(integration);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_machine_inspect");
  await tools[0]!.execute("test", { x: 14, y: 37, expectedTargetId: "machine_target_01", requestId: "request_machine_01", idempotencyKey: "idempotency_machine_01" }, new AbortController().signal, () => {}, {} as never);
  assert.deepEqual(received, { requestId: "request_machine_01", idempotencyKey: "idempotency_machine_01", action: "machine_inspect", args: { x: 14, y: 37, expectedTargetId: "machine_target_01" }, expectedRevision: 3, deadlineMs: (received as { deadlineMs: number }).deadlineMs });
});

test("mounted Game Actions return authoritative Mod receipts without inventing completion", async () => {
  const receipt = { executionId: "execution_01", requestId: "request_01", state: "accepted" as const, reasonCode: "accepted", revision: 3, evidence: { target: "3,4" } };
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
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
