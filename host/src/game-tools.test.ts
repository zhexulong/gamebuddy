import assert from "node:assert/strict";
import test from "node:test";

import { createDeterministicBridgePair } from "./bridge.js";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import { createStardewActionTools, createStardewObservationTools, type MoveCapableIntegration } from "./game-tools.js";
import { GameConnectionTestClient } from "./test-support/game-connection-test-client.js";
import { newEnvelope, type Scope } from "./protocol.js";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const now = 1_700_000_000_000;

function testAdmission(integration: MoveCapableIntegration) {
  const ledger = new ExecutionCorrelationLedger((requestId, executionId, reasonCode) =>
    integration.cancel(requestId, executionId, reasonCode),
  );
  const owner = { ownerId: "test_owner", epoch: 1 };
  return {
    observer: ledger,
    owner,
    cancelExact: (requestId: string, executionId: string, reasonCode: string) =>
      ledger.requestCancelExact(owner, requestId, executionId, reasonCode),
  };
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function moveIntegration(
  execute: MoveCapableIntegration["execute"],
): MoveCapableIntegration {
  return {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["move_to_tile"],
      catalogRevision: 1,
      enabledActionIds: ["move_to_tile"],
      snapshot: {
        revision: 3,
        location: "Farm",
        tile: { x: 1, y: 2 },
        stamina: 100,
        health: 100,
        actionable: true,
        capabilities: ["move_to_tile"],
        catalogRevision: 1,
        enabledActionIds: ["move_to_tile"],
        presentationLocale: "en-US",
        activeExecution: null,
      },
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: TEST_MOD_REGISTRATIONS,
    },
    execute,
    async cancel() {
      throw new Error("unused");
    },
  };
}

test("Stardew Host tools expose only factual observation and receipt surfaces", async () => {
  const [host, mod] = createDeterministicBridgePair(scope);
  const client = new GameConnectionTestClient(scope, host, STARDEW_GAME_INTEGRATION_ADAPTER);
  const [observe, execution, catalog, search] = createStardewObservationTools(client);
  assert.deepEqual(
    [observe.name, execution.name, catalog.name, search.name],
    ["stardew_observe", "stardew_execution_status", "stardew_interaction_catalog", "stardew_search_interactions"],
  );
  const unavailable = await observe.execute("test", {}, new AbortController().signal, () => {}, {} as never);
  assert.match(unavailable.content[0]?.type === "text" ? unavailable.content[0].text : "", /No authoritative/);

  mod.onMessage((message) => {
    if (message.type === "hello")
      mod.send(
        newEnvelope(
          "hello_ack",
          scope,
          { sessionId: "session_01", capabilities: ["move_to_tile"], catalogRevision: 1, enabledActionIds: ["move_to_tile"], presentationLocale: "en-US", registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }], runtimeRole: "native_local_fixture", launchGeneration: null },
          message.correlationId,
          now,
        ),
        now,
      );
    if (message.type === "observe_request")
      mod.send(
        newEnvelope(
          "snapshot",
          scope,
          {
            revision: 1,
            location: "Farm",
            tile: { x: 1, y: 2 },
            stamina: 100,
            health: 100,
            actionable: true,
            capabilities: ["move_to_tile"],
catalogRevision: 1,
            enabledActionIds: ["move_to_tile"],
            presentationLocale: "en-US",
            activeExecution: null,
          },
          message.correlationId,
          now,
        ),
        now,
      );
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
  let executeCalls = 0;
  let enabled = true;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: enabled ? ["move_to_tile"] : [],
        catalogRevision: 1,
        enabledActionIds: enabled ? ["move_to_tile"] : [],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: enabled ? ["move_to_tile"] : [],
catalogRevision: 1,
          enabledActionIds: enabled ? ["move_to_tile"] : [],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute() {
      executeCalls++;
      throw new Error("must_not_execute");
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const [move] = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.ok(move);
  enabled = false;
  const result = await move.execute("test", { x: 3, y: 4 }, new AbortController().signal, () => {}, {} as never);
  assert.equal(executeCalls, 0);
  assert.equal((result.details as { reasonCode?: string }).reasonCode, "capability_not_declared");
});

test("a materialized tool does not call integration.execute after subtractive policy denial at execute time", async () => {
  let executeCalls = 0;
  // Mutable policy fixture: the shared wrapper rereads the current restrictive
  // policy at execute time, so a post-mount deny must stop the pre-write gate.
  const mutablePolicy = {
    policyVersion: 1 as const,
    deniedActions: [] as string[],
    deniedFamilies: [] as string[],
  };
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["move_to_tile"],
        catalogRevision: 1,
        enabledActionIds: ["move_to_tile"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["move_to_tile"],
catalogRevision: 1,
          enabledActionIds: ["move_to_tile"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute() {
      executeCalls++;
      throw new Error("must_not_execute");
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const [move] = createStardewActionTools(integration, mutablePolicy, () => testAdmission(integration));
  assert.ok(move);
  mutablePolicy.deniedActions.push("move_to_tile");
  const result = await move.execute("test", { x: 3, y: 4 }, new AbortController().signal, () => {}, {} as never);
  assert.equal(executeCalls, 0);
  assert.equal((result.details as { reasonCode?: string }).reasonCode, "action_policy_denied");
  assert.equal((result.details as { receiptJson?: string | null }).receiptJson, null);
});

test("the shared wrapper surfaces bridge execute errors as fail-closed receipt reasons", async () => {
  let executeCalls = 0;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["move_to_tile"],
        catalogRevision: 1,
        enabledActionIds: ["move_to_tile"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["move_to_tile"],
catalogRevision: 1,
          enabledActionIds: ["move_to_tile"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute() {
      executeCalls++;
      throw new Error("bridge_rejected:native_denied");
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const [move] = createStardewActionTools(integration, undefined, () => ({
    owner: { ownerId: "test_owner", epoch: 1 },
    observer: { beforeWrite: () => undefined, bindReceipt: () => undefined, markUncertain: () => undefined },
    cancelExact: async () => {
      throw new Error("unused");
    },
  }));
  assert.ok(move);
  const result = await move.execute("test", { x: 3, y: 4 }, new AbortController().signal, () => {}, {} as never);
  assert.equal(executeCalls, 1);
  assert.equal((result.details as { reasonCode?: string | null }).reasonCode, "native_denied");
  assert.equal((result.details as { receiptJson?: string | null }).receiptJson, null);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Game action was not created/);
});

test("equip_tool mounts only from a live capability and forwards the selected slot", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["equip_tool"],
        catalogRevision: 1,
        enabledActionIds: ["equip_tool"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["equip_tool"],
catalogRevision: 1,
          enabledActionIds: ["equip_tool"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_tool_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "tool_selected",
        revision: 4,
        evidence: { before: "(W) Axe", expected: "(W) Pickaxe", after: "(W) Pickaxe" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_equip_tool");
  const result = await tools[0]!.execute(
    "test",
    { slot: 2, requestId: "request_tool_01", idempotencyKey: "idempotency_tool_01" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.equal((received as { action: string; args: { slot: number } }).action, "equip_tool");
  assert.equal((received as { args: { slot: number } }).args.slot, 2);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /tool_selected/);
});

test("enter_exit mounts from a live capability and forwards the door tile", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["enter_exit"],
        catalogRevision: 1,
        enabledActionIds: ["enter_exit"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["enter_exit"],
catalogRevision: 1,
          enabledActionIds: ["enter_exit"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_door_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "accepted",
        reasonCode: "accepted",
        revision: 4,
        evidence: null,
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_enter_exit");
  await tools[0]!.execute(
    "test",
    { x: 10, y: 11, requestId: "request_door_01", idempotencyKey: "idempotency_door_01" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.equal((received as { action: string }).action, "enter_exit");
  assert.deepEqual((received as { args: { x: number; y: number } }).args, { x: 10, y: 11 });
});

test("published pickup_item mounts only from a live capability and forwards the opaque live target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["pickup_item"],
        catalogRevision: 1,
        enabledActionIds: ["pickup_item"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 25, y: 33 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["pickup_item"],
catalogRevision: 1,
          enabledActionIds: ["pickup_item"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_item_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "item_picked_up",
        revision: 4,
        evidence: {
          detail:
            "target=item_target_01;native_auto_collect=true;chunk_removed=true;inventory_before=0;inventory_after=1",
        },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_pickup_item");
  await tools[0]!.execute(
    "test",
    {
      x: 21,
      y: 29,
      expectedQualifiedItemId: "(O)388",
      expectedTargetId: "item_target_01",
      requestId: "request_item_01",
      idempotencyKey: "idempotency_item_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_item_01",
    idempotencyKey: "idempotency_item_01",
    action: "pickup_item",
    args: { x: 21, y: 29, expectedQualifiedItemId: "(O)388", expectedTargetId: "item_target_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });
});

test("published refill_watering_can mounts only from a live capability and forwards the exact source and selected can", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["refill_watering_can"],
        catalogRevision: 1,
        enabledActionIds: ["refill_watering_can"],        snapshot: {
          revision: 3,
          location: "FarmHouse",
          tile: { x: 9, y: 8 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["refill_watering_can"],
catalogRevision: 1,
          enabledActionIds: ["refill_watering_can"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_refill_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "watering_can_refilled",
        revision: 4,
        evidence: {
          detail: "target=watering_can_refill_01;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40",
        },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_refill_watering_can");
  await tools[0]!.execute(
    "test",
    {
      slot: 4,
      x: 9,
      y: 9,
      expectedTargetId: "watering_can_refill_01",
      requestId: "request_refill_01",
      idempotencyKey: "idempotency_refill_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_refill_01",
    idempotencyKey: "idempotency_refill_01",
    action: "refill_watering_can",
    args: { slot: 4, x: 9, y: 9, expectedTargetId: "watering_can_refill_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });

  const unavailable: MoveCapableIntegration = {
    ...integration,
    get state() {
      return { ...integration.state, capabilities: [], snapshot: { ...integration.state.snapshot!, capabilities: [] } };
    },
  };
  assert.equal(
    createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
      (tool) => tool.name === "stardew_refill_watering_can",
    ),
    false,
  );
});

test("published plant_seed mounts only from a live capability and forwards the opaque live target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["plant_seed"],
        catalogRevision: 1,
        enabledActionIds: ["plant_seed"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["plant_seed"],
catalogRevision: 1,
          enabledActionIds: ["plant_seed"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_seed_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "seed_planted",
        revision: 4,
        evidence: { detail: "crop=479" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_plant_seed");
  await tools[0]!.execute(
    "test",
    {
      slot: 5,
      x: 2,
      y: 3,
      expectedQualifiedItemId: "(O)479",
      expectedTargetId: "seed_target_01",
      requestId: "request_seed_01",
      idempotencyKey: "idempotency_seed_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_seed_01",
    idempotencyKey: "idempotency_seed_01",
    action: "plant_seed",
    args: { slot: 5, x: 2, y: 3, expectedQualifiedItemId: "(O)479", expectedTargetId: "seed_target_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });
  assert.ok((received as { deadlineMs: number }).deadlineMs >= Date.now() - 1_000);
});

test("published clear_hoedirt mounts only from a live capability and forwards exact arguments", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["clear_hoedirt"],
        catalogRevision: 1,
        enabledActionIds: ["clear_hoedirt"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["clear_hoedirt"],
catalogRevision: 1,
          enabledActionIds: ["clear_hoedirt"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_hoedirt_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "hoedirt_cleared",
        revision: 4,
        evidence: {
          detail:
            "location=Farm;target=hoedirt_01;tile=2,3;tool=pickaxe;slot=4;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=false;removed=true",
        },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_clear_hoedirt");
  await tools[0]!.execute(
    "test",
    {
      slot: 4,
      x: 2,
      y: 3,
      expectedTargetId: "hoedirt_01",
      requestId: "request_hoedirt_01",
      idempotencyKey: "idempotency_hoedirt_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_hoedirt_01",
    idempotencyKey: "idempotency_hoedirt_01",
    action: "clear_hoedirt",
    args: { slot: 4, x: 2, y: 3, expectedTargetId: "hoedirt_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });
});

test("published use_item mounts only from a live capability and forwards the food slot", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["use_item"],
        catalogRevision: 1,
        enabledActionIds: ["use_item"],        snapshot: {
          revision: 3,
          location: "FarmHouse",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["use_item"],
catalogRevision: 1,
          enabledActionIds: ["use_item"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_food_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "item_used",
        revision: 4,
        evidence: { detail: "slot=5;item=(O)216;stack_before=3;stack_after=2;animation_complete=true" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_use_item");
  await tools[0]!.execute(
    "test",
    { slot: 5, expectedQualifiedItemId: "(O)216", requestId: "request_food_01", idempotencyKey: "idempotency_food_01" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_food_01",
    idempotencyKey: "idempotency_food_01",
    action: "use_item",
    args: { slot: 5, expectedQualifiedItemId: "(O)216" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });
});

test("published harvest_crop mounts only from a live capability and forwards the opaque target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["harvest_crop"],
        catalogRevision: 1,
        enabledActionIds: ["harvest_crop"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 38, y: 19 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["harvest_crop"],
catalogRevision: 1,
          enabledActionIds: ["harvest_crop"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_harvest_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "crop_harvested",
        revision: 4,
        evidence: { detail: "crop=480;item=(O)256;inventory_before=0;inventory_after=1;regrows=true" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_harvest_crop");
  await tools[0]!.execute(
    "test",
    {
      x: 39,
      y: 19,
      expectedQualifiedItemId: "(O)256",
      expectedTargetId: "crop_target_01",
      requestId: "request_harvest_01",
      idempotencyKey: "idempotency_harvest_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_harvest_01",
    idempotencyKey: "idempotency_harvest_01",
    action: "harvest_crop",
    args: { x: 39, y: 19, expectedQualifiedItemId: "(O)256", expectedTargetId: "crop_target_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });
});

test("published chop_tree_source mounts only from a live Mod capability and forwards the exact source target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["chop_tree_source"],
        catalogRevision: 1,
        enabledActionIds: ["chop_tree_source"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 38, y: 19 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["chop_tree_source"],
catalogRevision: 1,
          enabledActionIds: ["chop_tree_source"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_tree_chop_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "tree_source_chopped",
        revision: 4,
        evidence: {
          detail:
            "target=tree_chop_01;tool=axe;slot=4;tree=Oak;health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true",
        },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_chop_tree_source");
  await tools[0]!.execute(
    "test",
    {
      slot: 4,
      x: 39,
      y: 19,
      expectedTargetId: "tree_chop_01",
      requestId: "request_tree_chop_01",
      idempotencyKey: "idempotency_tree_chop_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_tree_chop_01",
    idempotencyKey: "idempotency_tree_chop_01",
    action: "chop_tree_source",
    args: { slot: 4, x: 39, y: 19, expectedTargetId: "tree_chop_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });

  const unavailable: MoveCapableIntegration = {
    ...integration,
    get state() {
      return { ...integration.state, capabilities: [], snapshot: { ...integration.state.snapshot!, capabilities: [] } };
    },
  };
  assert.equal(
    createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
      (tool) => tool.name === "stardew_chop_tree_source",
    ),
    false,
  );
});

test("published break_rock_source mounts only from a live Mod capability and forwards the exact source target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["break_rock_source"],
        catalogRevision: 1,
        enabledActionIds: ["break_rock_source"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 38, y: 19 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["break_rock_source"],
catalogRevision: 1,
          enabledActionIds: ["break_rock_source"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_rock_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "rock_source_broken",
        revision: 4,
        evidence: {
          detail:
            "target=rock_source_01;tool=pickaxe;slot=4;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true",
        },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_break_rock_source");
  await tools[0]!.execute(
    "test",
    {
      slot: 4,
      x: 39,
      y: 19,
      expectedTargetId: "rock_source_01",
      requestId: "request_rock_01",
      idempotencyKey: "idempotency_rock_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_rock_01",
    idempotencyKey: "idempotency_rock_01",
    action: "break_rock_source",
    args: { slot: 4, x: 39, y: 19, expectedTargetId: "rock_source_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });

  const unavailable: MoveCapableIntegration = {
    ...integration,
    get state() {
      return { ...integration.state, capabilities: [], snapshot: { ...integration.state.snapshot!, capabilities: [] } };
    },
  };
  assert.equal(
    createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
      (tool) => tool.name === "stardew_break_rock_source",
    ),
    false,
  );
});

test("published machine_inspect mounts only from a live capability and forwards the opaque target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["machine_inspect"],
        catalogRevision: 1,
        enabledActionIds: ["machine_inspect"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["machine_inspect"],
catalogRevision: 1,
          enabledActionIds: ["machine_inspect"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_machine_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "machine_inspected",
        revision: 4,
        evidence: { detail: "machine=(BC)12" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_machine_inspect");
  await tools[0]!.execute(
    "test",
    {
      x: 14,
      y: 37,
      expectedTargetId: "machine_target_01",
      requestId: "request_machine_01",
      idempotencyKey: "idempotency_machine_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_machine_01",
    idempotencyKey: "idempotency_machine_01",
    action: "machine_inspect",
    args: { x: 14, y: 37, expectedTargetId: "machine_target_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });
});

test("published machine_load mounts only from a live capability and forwards the fixed Coffee Bean contract", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["machine_load"],
        catalogRevision: 1,
        enabledActionIds: ["machine_load"],        snapshot: {
          revision: 3,
          location: "FarmHouse",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["machine_load"],
catalogRevision: 1,
          enabledActionIds: ["machine_load"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_machine_load_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "machine_coffee_loaded",
        revision: 4,
        evidence: { detail: "machine=(BC)12" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_machine_load");
  await tools[0]!.execute(
    "test",
    {
      slot: 5,
      x: 14,
      y: 37,
      expectedQualifiedItemId: "(O)433",
      expectedTargetId: "machine_target_01",
      requestId: "request_machine_load_01",
      idempotencyKey: "idempotency_machine_load_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_machine_load_01",
    idempotencyKey: "idempotency_machine_load_01",
    action: "machine_load",
    args: { slot: 5, x: 14, y: 37, expectedQualifiedItemId: "(O)433", expectedTargetId: "machine_target_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });
});

test("published machine_collect_output mounts only from a live capability and forwards the opaque ready Keg target", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["machine_collect_output"],
        catalogRevision: 1,
        enabledActionIds: ["machine_collect_output"],        snapshot: {
          revision: 3,
          location: "FarmHouse",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["machine_collect_output"],
catalogRevision: 1,
          enabledActionIds: ["machine_collect_output"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_machine_collect_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "machine_coffee_collected",
        revision: 4,
        evidence: { detail: "machine=(BC)12" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_machine_collect_output");
  await tools[0]!.execute(
    "test",
    {
      x: 14,
      y: 37,
      expectedTargetId: "machine_target_01",
      requestId: "request_machine_collect_01",
      idempotencyKey: "idempotency_machine_collect_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_machine_collect_01",
    idempotencyKey: "idempotency_machine_collect_01",
    action: "machine_collect_output",
    args: { x: 14, y: 37, expectedTargetId: "machine_target_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });

  const unavailable: MoveCapableIntegration = {
    ...integration,
    get state() {
      return { ...integration.state, capabilities: [], snapshot: { ...integration.state.snapshot!, capabilities: [] } };
    },
  };
  assert.equal(
    createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
      (tool) => tool.name === "stardew_machine_collect_output",
    ),
    false,
  );
});

test("published bait_crab_pot mounts only from a live capability and forwards the fixed Bait contract", async () => {
  let received: unknown = null;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["bait_crab_pot"],
        catalogRevision: 1,
        enabledActionIds: ["bait_crab_pot"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["bait_crab_pot"],
catalogRevision: 1,
          enabledActionIds: ["bait_crab_pot"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_bait_01",
        actionId: "move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "crab_pot_baited",
        revision: 4,
        evidence: { detail: "bait=(O)685" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "stardew_bait_crab_pot");
  await tools[0]!.execute(
    "test",
    {
      slot: 5,
      x: 14,
      y: 37,
      expectedQualifiedItemId: "(O)685",
      expectedTargetId: "bait_crab_pot_01",
      requestId: "request_bait_01",
      idempotencyKey: "idempotency_bait_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual(received, {
    requestId: "request_bait_01",
    idempotencyKey: "idempotency_bait_01",
    action: "bait_crab_pot",
    args: { slot: 5, x: 14, y: 37, expectedQualifiedItemId: "(O)685", expectedTargetId: "bait_crab_pot_01" },
    expectedRevision: 3,
    deadlineMs: (received as { deadlineMs: number }).deadlineMs,
  });
  const unavailable: MoveCapableIntegration = {
    ...integration,
    get state() {
      return { ...integration.state, capabilities: [], snapshot: { ...integration.state.snapshot!, capabilities: [] } };
    },
  };
  assert.equal(
    createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
      (tool) => tool.name === "stardew_bait_crab_pot",
    ),
    false,
  );
});

test("mounted Game Actions return authoritative Mod receipts without inventing completion", async () => {
  const receipt = {
    executionId: "execution_01",
    actionId: "move_to_tile",
    requestId: "request_01",
    state: "accepted" as const,
    reasonCode: "accepted",
    revision: 3,
    evidence: { target: "3,4" },
  };
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["move_to_tile", "cancel_active_execution"],
        catalogRevision: 1,
        enabledActionIds: ["move_to_tile", "cancel_active_execution"],        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities: ["move_to_tile", "cancel_active_execution"],
catalogRevision: 1,
          enabledActionIds: ["move_to_tile", "cancel_active_execution"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      assert.equal(request.expectedRevision, 3);
      assert.equal(request.action, "move_to_tile");
      return receipt;
    },
    async cancel() {
      return receipt;
    },
  };
  const admission = testAdmission(integration);
  const [move] = createStardewActionTools(integration, undefined, () => admission);
  assert.ok(move);
  const result = await move.execute(
    "test",
    { x: 3, y: 4, requestId: "request_01", idempotencyKey: "idempotency_01" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /"state":"accepted"/);
  assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /succeeded/);
});

test("each executable action obtains a fresh runtime admission immediately before the bridge write", async () => {
  const admittedOwners: string[] = [];
  const integration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session",
      capabilities: ["move_to_tile"],
      catalogRevision: 1,
      enabledActionIds: ["move_to_tile"],
      snapshot: {
        revision: 1,
        location: "Farm",
        tile: { x: 0, y: 0 },
        stamina: 1,
        health: 1,
        actionable: true,
        capabilities: ["move_to_tile"],
catalogRevision: 1,
        enabledActionIds: ["move_to_tile"],
        presentationLocale: "en-US",
        activeExecution: null,
      },
      latestReceipt: null,
      latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
    },
    async execute(request: { requestId: string }) {
      return {
        requestId: request.requestId,
        executionId: "execution_01",
        actionId: "move_to_tile",
        state: "accepted",
        reasonCode: "accepted",
        revision: 1,
        evidence: {},
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  } as MoveCapableIntegration;
  let count = 0;
  const tools = createStardewActionTools(integration, undefined, () => {
    const ownerId = `owner_${++count}`;
    return {
      owner: { ownerId, epoch: 0 },
      observer: {
        beforeWrite: () => {
          admittedOwners.push(ownerId);
        },
        bindReceipt: () => undefined,
        markUncertain: () => undefined,
      },
      cancelExact: async () => {
        throw new Error("unused");
      },
    };
  });
  await tools[0]!.execute("one", { x: 1, y: 1 }, new AbortController().signal, () => undefined, {} as never);
  await tools[0]!.execute("two", { x: 2, y: 2 }, new AbortController().signal, () => undefined, {} as never);
  assert.deepEqual(admittedOwners, ["owner_1", "owner_2"]);
});

test("game action awaits admission beforeWrite before calling the bridge", async () => {
  let executeCalls = 0;
  const beforeWrite = deferred();
  const integration = moveIntegration(async (request) => {
    executeCalls++;
    return {
      requestId: request.requestId,
      executionId: "execution_before_write_01",
      actionId: "move_to_tile",
      state: "accepted",
      reasonCode: "accepted",
      revision: 3,
      evidence: null,
    };
  });
  const [move] = createStardewActionTools(integration, undefined, () => ({
    owner: { ownerId: "test_owner", epoch: 1 },
    observer: {
      beforeWrite: () => beforeWrite.promise,
      bindReceipt: () => undefined,
      markUncertain: () => undefined,
    },
    cancelExact: async () => {
      throw new Error("unused");
    },
  }));
  assert.ok(move);

  const invocation = move.execute(
    "test",
    { x: 3, y: 4 },
    new AbortController().signal,
    () => undefined,
    {} as never,
  );
  await Promise.resolve();
  assert.equal(executeCalls, 0);
  beforeWrite.resolve();
  await invocation;
  assert.equal(executeCalls, 1);
});

test("game action awaits markUncertain after a bridge execute failure", async () => {
  let executeCalls = 0;
  let markUncertainCalls = 0;
  let invocationSettled = false;
  const markUncertain = deferred();
  const markUncertainStarted = deferred();
  const integration = moveIntegration(async () => {
    executeCalls++;
    throw new Error("bridge_rejected:native_denied");
  });
  const [move] = createStardewActionTools(integration, undefined, () => ({
    owner: { ownerId: "test_owner", epoch: 1 },
    observer: {
      beforeWrite: () => undefined,
      bindReceipt: () => undefined,
      markUncertain: () => {
        markUncertainCalls++;
        markUncertainStarted.resolve();
        return markUncertain.promise;
      },
    },
    cancelExact: async () => {
      throw new Error("unused");
    },
  }));
  assert.ok(move);

  const invocation = move
    .execute(
      "test",
      { x: 3, y: 4 },
      new AbortController().signal,
      () => undefined,
      {} as never,
    )
    .then((result) => {
      invocationSettled = true;
      return result;
    });
  await markUncertainStarted.promise;
  assert.equal(executeCalls, 1);
  assert.equal(markUncertainCalls, 1);
  assert.equal(invocationSettled, false);
  markUncertain.resolve();
  const result = await invocation;
  assert.equal(invocationSettled, true);
  assert.equal((result.details as { reasonCode?: string }).reasonCode, "native_denied");
});

test("model-facing tools never expose active-execution cancellation", () => {
  const integration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session",
      capabilities: ["cancel_active_execution"],
      catalogRevision: 1,
      enabledActionIds: ["cancel_active_execution"],      snapshot: null,
      latestReceipt: null,
      latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
    },
    async execute() {
      throw new Error("unused");
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  } as MoveCapableIntegration;
  const tools = createStardewActionTools(integration, undefined, () => {
    throw new Error("must_not_admit");
  });
  assert.equal(
    tools.some((tool) => tool.name === "stardew_cancel_active_execution"),
    false,
  );
});

test("action tools fail closed without runtime-owned dispatch admission", () => {
  const integration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session",
      capabilities: ["move_to_tile"],
      catalogRevision: 1,
      enabledActionIds: ["move_to_tile"],      snapshot: null,
      latestReceipt: null,
      latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
    },
    async execute() {
      throw new Error("must_not_execute");
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  } as MoveCapableIntegration;
  assert.deepEqual(createStardewActionTools(integration, undefined), []);
});
