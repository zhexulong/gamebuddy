import assert from "node:assert/strict";
import test from "node:test";

import { createDeterministicBridgePair } from "./bridge.js";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import { createStardewActionTools, createStardewObservationTools, type MoveCapableIntegration } from "./game-tools.js";
import { GameConnectionTestClient } from "./test-support/game-connection-test-client.js";
import { newEnvelope, validateExecutionRequest, type ActionRegistration, type Scope } from "./protocol.js";
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

function moveIntegration(execute: MoveCapableIntegration["execute"]): MoveCapableIntegration {
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
        exhausted: false,
        health: 100,
        actionable: true,
        capabilities: ["move_to_tile"],
        catalogRevision: 1,
        enabledActionIds: ["move_to_tile"],
        presentationLocale: "en-US",
        timeOfDay: 600,
        dayOfMonth: 1,
        seasonIndex: 0,
        year: 1,
        weather: "sunny",
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
  // GameConnectionTestClient is a GameConnection: its observe(nowMs) is the transport DRIVER that solicits a
  // snapshot over the deterministic bridge. createStardewObservationTools needs a StardewBridgeConnection, whose
  // optional observe() is the adapter refresh. Bind the connection to the client's live state and let the test
  // drive the transport itself, so the tool reads the same admitted state the driver produced.
  const connection: StardewBridgeConnection = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return client.state;
    },
  };
  const [observe, execution, catalog, search] = createStardewObservationTools(connection);
  assert.ok(
    observe !== undefined && execution !== undefined && catalog !== undefined && search !== undefined,
    "the four leading observation tools must be mounted",
  );
  assert.deepEqual(
    [observe.name, execution.name, catalog.name, search.name],
    ["stardew_observe", "stardew_execution_status", "stardew_interaction_catalog", "stardew_search_interactions"],
  );
  const unavailable = await observe.execute("test", {}, new AbortController().signal, () => {}, {} as never);
  // The failure text must name the cause and what to do; a constant sentence
  // left the Agent polling a dead bridge (S7).
  assert.match(
    unavailable.content[0]?.type === "text" ? unavailable.content[0].text : "",
    /No live Stardew connection: integration_not_ready\..*do not keep retrying/s,
  );

  mod.onMessage((message) => {
    if (message.type === "hello")
      mod.send(
        newEnvelope(
          "hello_ack",
          scope,
          {
            sessionId: "session_01",
            capabilities: ["move_to_tile"],
            catalogRevision: 1,
            policyIdentity: { value: "0123456789abcdef0123456789abcdef", capabilityRevision: 1 },
            enabledActionIds: ["move_to_tile"],
            presentationLocale: "en-US",
            registrations: [
              {
                actionId: "move_to_tile",
                familyId: "movement_navigation",
                identityVersion: 1,
                lifecycle: "published",
                kind: "execution",
              },
            ],
            runtimeRole: "native_local_fixture",
            launchGeneration: null,
          },
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
            exhausted: false,
            health: 100,
            actionable: true,
            capabilities: ["move_to_tile"],
            catalogRevision: 1,
            enabledActionIds: ["move_to_tile"],
            presentationLocale: "en-US",
            timeOfDay: 600,
            dayOfMonth: 1,
            seasonIndex: 0,
            year: 1,
            weather: "sunny",
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
        enabledActionIds: enabled ? ["move_to_tile"] : [],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: enabled ? ["move_to_tile"] : [],
          catalogRevision: 1,
          enabledActionIds: enabled ? ["move_to_tile"] : [],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const move = createStardewActionTools(integration, undefined, () => testAdmission(integration)).find(
    (candidate) => candidate.name === "stardew_move_to_tile",
  )!;
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
        enabledActionIds: ["move_to_tile"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["move_to_tile"],
          catalogRevision: 1,
          enabledActionIds: ["move_to_tile"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const move = createStardewActionTools(integration, mutablePolicy, () => testAdmission(integration)).find(
    (candidate) => candidate.name === "stardew_move_to_tile",
  )!;
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
        enabledActionIds: ["move_to_tile"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["move_to_tile"],
          catalogRevision: 1,
          enabledActionIds: ["move_to_tile"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const move = createStardewActionTools(integration, undefined, () => ({
    owner: { ownerId: "test_owner", epoch: 1 },
    observer: {
      beforeWrite: () => undefined,
      bindReceipt: () => undefined,
      markUncertain: () => undefined,
      markAuthoritativelyRejected: () => undefined,
    },
    cancelExact: async () => {
      throw new Error("unused");
    },
  })).find((candidate) => candidate.name === "stardew_move_to_tile")!;
  assert.ok(move);
  const result = await move.execute("test", { x: 3, y: 4 }, new AbortController().signal, () => {}, {} as never);
  assert.equal(executeCalls, 1);
  assert.equal((result.details as { reasonCode?: string | null }).reasonCode, "native_denied");
  assert.equal((result.details as { receiptJson?: string | null }).receiptJson, null);
  // A Mod refusal is authoritative proof that no write happened, and the text
  // must say so - the caller has to know the world is unchanged.
  assert.equal((result.details as { writePhase?: string }).writePhase, "not_written");
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /Game action was not created: native_denied\. Nothing was written/,
  );
});

test("equip_tool mounts only from a live capability and forwards the selected tool", async () => {
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
        enabledActionIds: ["equip_tool"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["equip_tool"],
          catalogRevision: 1,
          enabledActionIds: ["equip_tool"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
        actionId: "equip_tool",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "tool_equipped",
        revision: 4,
        evidence: { before: "(W) Axe", expected: "(W) Axe", after: "(W) Axe" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_equip_tool");
  assert.ok(mountedTool);
  const result = await mountedTool!.execute(
    "test",
    { tool: "axe", requestId: "request_tool_01", idempotencyKey: "idempotency_tool_01" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.equal((received as { action: string; args: { tool: string } }).action, "equip_tool");
  assert.equal((received as { args: { tool: string } }).args.tool, "axe");
  // Wire consistency: the tool-emitted request must pass the wire validator unchanged.
  assert.equal(validateExecutionRequest(received, integration.state.snapshot!), null);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /tool_equipped/);
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
        enabledActionIds: ["enter_exit"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["enter_exit"],
          catalogRevision: 1,
          enabledActionIds: ["enter_exit"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_enter_exit");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
        enabledActionIds: ["pickup_item"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 25, y: 33 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["pickup_item"],
          catalogRevision: 1,
          enabledActionIds: ["pickup_item"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_pickup_item");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
        enabledActionIds: ["refill_watering_can"],
        snapshot: {
          revision: 3,
          location: "FarmHouse",
          tile: { x: 9, y: 8 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["refill_watering_can"],
          catalogRevision: 1,
          enabledActionIds: ["refill_watering_can"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
          detail:
            "target=watering_can_refill_01;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40;stamina_before=100;stamina_after=100;stamina_delta=0;expected_stamina_cost=0",
        },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_refill_watering_can");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
  const stillMounted = createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
    (tool) => tool.name === "stardew_refill_watering_can",
  );
  // Constant mount: the tool stays declared; execution-time admission rejects it.
  assert.equal(stillMounted, true);
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
        enabledActionIds: ["plant_seed"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["plant_seed"],
          catalogRevision: 1,
          enabledActionIds: ["plant_seed"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_plant_seed");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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

test("a dispatch deadline comes from the action's own published watchdog, not one number for every action", () => {
  // Measured 2026-10-17: `advance_day` was dispatched with a hard-coded 30s deadline against the Mod's 600s
  // watchdog, so it timed out by construction and the failure read as the companion being unable to sleep. The
  // Mod publishes the watchdog on its descriptor, and the Host sizes the deadline from it.
  const registrations: readonly ActionRegistration[] = [
    {
      actionId: "advance_day",
      familyId: "world_lifecycle",
      identityVersion: 1,
      lifecycle: "live_verified",
      kind: "execution",
      descriptor: { watchdogMs: 600_000 },
    },
    { actionId: "till_soil", familyId: "farming_crops", identityVersion: 1, lifecycle: "published", kind: "execution" },
  ];
  const deadlines: Record<string, number> = {};
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected: true,
        sessionId: "session_01",
        capabilities: ["advance_day", "till_soil"],
        catalogRevision: 1,
        enabledActionIds: ["advance_day", "till_soil"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["advance_day", "till_soil"],
          catalogRevision: 1,
          enabledActionIds: ["advance_day", "till_soil"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: registrations,
      };
    },
    async execute(request) {
      deadlines[request.action] = request.deadlineMs - Date.now();
      return {
        executionId: `execution_${request.action}`,
        actionId: request.action,
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: request.action === "advance_day" ? "day_advanced" : "soil_tilled",
        revision: 4,
        evidence: { detail: "ok=true" },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  assert.ok(tools.find((candidate) => candidate.name === "stardew_advance_day"));
  assert.ok(tools.find((candidate) => candidate.name === "stardew_till_soil"));
  return (async () => {
    await tools
      .find((candidate) => candidate.name === "stardew_advance_day")!
      .execute(
        "test",
        { requestId: "request_night_01", idempotencyKey: "idempotency_night_01" },
        new AbortController().signal,
        () => {},
        {} as never,
      );
    await tools
      .find((candidate) => candidate.name === "stardew_till_soil")!
      .execute(
        "test",
        {
          requestId: "request_till_01",
          idempotencyKey: "idempotency_till_01",
          x: 2,
          y: 3,
          expectedTargetId: "target_01",
        },
        new AbortController().signal,
        () => {},
        {} as never,
      );
    // The published watchdog is honoured (within the scheduling slop of the call itself)...
    assert.ok((deadlines.advance_day ?? 0) > 590_000, String(deadlines.advance_day));
    // ...and an action that publishes none keeps the historical default.
    assert.ok((deadlines.till_soil ?? 0) > 25_000 && (deadlines.till_soil ?? 0) < 31_000, String(deadlines.till_soil));
  })();
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
        enabledActionIds: ["clear_hoedirt"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["clear_hoedirt"],
          catalogRevision: 1,
          enabledActionIds: ["clear_hoedirt"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
            "location=Farm;target=hoedirt_01;tile=2,3;tool=pickaxe;slot=4;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=false;removed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2",
        },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_clear_hoedirt");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
        enabledActionIds: ["use_item"],
        snapshot: {
          revision: 3,
          location: "FarmHouse",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["use_item"],
          catalogRevision: 1,
          enabledActionIds: ["use_item"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_use_item");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
        enabledActionIds: ["harvest_crop"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 38, y: 19 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["harvest_crop"],
          catalogRevision: 1,
          enabledActionIds: ["harvest_crop"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_harvest_crop");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
        enabledActionIds: ["chop_tree_source"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 38, y: 19 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["chop_tree_source"],
          catalogRevision: 1,
          enabledActionIds: ["chop_tree_source"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
            "target=tree_chop_01;tool=axe;slot=4;tree=Oak;health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2",
        },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_chop_tree_source");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
  const stillMounted = createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
    (tool) => tool.name === "stardew_chop_tree_source",
  );
  // Constant mount: the tool stays declared; execution-time admission rejects it.
  assert.equal(stillMounted, true);
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
        enabledActionIds: ["break_rock_source"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 38, y: 19 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["break_rock_source"],
          catalogRevision: 1,
          enabledActionIds: ["break_rock_source"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
            "target=rock_source_01;tool=pickaxe;slot=4;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2",
        },
      };
    },
    async cancel() {
      throw new Error("must_not_cancel");
    },
  };
  const tools = createStardewActionTools(integration, undefined, () => testAdmission(integration));
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_break_rock_source");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
  const stillMounted = createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
    (tool) => tool.name === "stardew_break_rock_source",
  );
  // Constant mount: the tool stays declared; execution-time admission rejects it.
  assert.equal(stillMounted, true);
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
        enabledActionIds: ["machine_inspect"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["machine_inspect"],
          catalogRevision: 1,
          enabledActionIds: ["machine_inspect"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_machine_inspect");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
        enabledActionIds: ["machine_load"],
        snapshot: {
          revision: 3,
          location: "FarmHouse",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["machine_load"],
          catalogRevision: 1,
          enabledActionIds: ["machine_load"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_machine_load");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
        enabledActionIds: ["machine_collect_output"],
        snapshot: {
          revision: 3,
          location: "FarmHouse",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["machine_collect_output"],
          catalogRevision: 1,
          enabledActionIds: ["machine_collect_output"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_machine_collect_output");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
  const stillMounted = createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
    (tool) => tool.name === "stardew_machine_collect_output",
  );
  // Constant mount: the tool stays declared; execution-time admission rejects it.
  assert.equal(stillMounted, true);
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
        enabledActionIds: ["bait_crab_pot"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["bait_crab_pot"],
          catalogRevision: 1,
          enabledActionIds: ["bait_crab_pot"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const mountedTool = tools.find((candidate) => candidate.name === "stardew_bait_crab_pot");
  assert.ok(mountedTool);
  await mountedTool!.execute(
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
  const stillMounted = createStardewActionTools(unavailable, undefined, () => testAdmission(unavailable)).some(
    (tool) => tool.name === "stardew_bait_crab_pot",
  );
  // Constant mount: the tool stays declared; execution-time admission rejects it.
  assert.equal(stillMounted, true);
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
        enabledActionIds: ["move_to_tile", "cancel_active_execution"],
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          exhausted: false,
          health: 100,
          actionable: true,
          capabilities: ["move_to_tile", "cancel_active_execution"],
          catalogRevision: 1,
          enabledActionIds: ["move_to_tile", "cancel_active_execution"],
          presentationLocale: "en-US",
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
          weather: "sunny",
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
  const move = createStardewActionTools(integration, undefined, () => admission).find(
    (candidate) => candidate.name === "stardew_move_to_tile",
  )!;
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
        exhausted: false,
        health: 1,
        actionable: true,
        capabilities: ["move_to_tile"],
        catalogRevision: 1,
        enabledActionIds: ["move_to_tile"],
        presentationLocale: "en-US",
        timeOfDay: 600,
        dayOfMonth: 1,
        seasonIndex: 0,
        year: 1,
        weather: "sunny",
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
        markAuthoritativelyRejected: () => undefined,
      },
      cancelExact: async () => {
        throw new Error("unused");
      },
    };
  });
  const moveTool = tools.find((candidate) => candidate.name === "stardew_move_to_tile");
  assert.ok(moveTool);
  await moveTool!.execute("one", { x: 1, y: 1 }, new AbortController().signal, () => undefined, {} as never);
  await moveTool!.execute("two", { x: 2, y: 2 }, new AbortController().signal, () => undefined, {} as never);
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
  const move = createStardewActionTools(integration, undefined, () => ({
    owner: { ownerId: "test_owner", epoch: 1 },
    observer: {
      beforeWrite: () => beforeWrite.promise,
      bindReceipt: () => undefined,
      markUncertain: () => undefined,
      markAuthoritativelyRejected: () => undefined,
    },
    cancelExact: async () => {
      throw new Error("unused");
    },
  })).find((candidate) => candidate.name === "stardew_move_to_tile")!;
  assert.ok(move);

  const invocation = move.execute("test", { x: 3, y: 4 }, new AbortController().signal, () => undefined, {} as never);
  await Promise.resolve();
  assert.equal(executeCalls, 0);
  beforeWrite.resolve();
  await invocation;
  assert.equal(executeCalls, 1);
});

test("game action awaits markUncertain after a bridge execute failure", async () => {
  // A failure that is NOT an authoritative Mod refusal leaves the write outcome
  // unknown, so the dispatch must be settled as uncertain before the caller is
  // told anything. (A `bridge_rejected:*` refusal takes the other path: it proves
  // no write happened, so it is settled authoritatively instead - see the
  // native_denied case above.)
  let executeCalls = 0;
  let markUncertainCalls = 0;
  let invocationSettled = false;
  const markUncertain = deferred();
  const markUncertainStarted = deferred();
  const integration = moveIntegration(async () => {
    executeCalls++;
    throw new Error("bridge_disconnected:pipe_closed");
  });
  const move = createStardewActionTools(integration, undefined, () => ({
    owner: { ownerId: "test_owner", epoch: 1 },
    observer: {
      beforeWrite: () => undefined,
      bindReceipt: () => undefined,
      markUncertain: () => {
        markUncertainCalls++;
        markUncertainStarted.resolve();
        return markUncertain.promise;
      },
      markAuthoritativelyRejected: () => undefined,
    },
    cancelExact: async () => {
      throw new Error("unused");
    },
  })).find((candidate) => candidate.name === "stardew_move_to_tile")!;
  assert.ok(move);

  const invocation = move
    .execute("test", { x: 3, y: 4 }, new AbortController().signal, () => undefined, {} as never)
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
  // The caller must be told the outcome is unknown, not that nothing happened.
  assert.equal((result.details as { reasonCode?: string }).reasonCode, "write_unknown:bridge_disconnected:pipe_closed");
  assert.equal((result.details as { writePhase?: string }).writePhase, "write_unknown");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Game action outcome is unknown/);
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
      enabledActionIds: ["cancel_active_execution"],
      snapshot: null,
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

test("the narrowed stop primitive refuses past the cancel point, and stops inside it", async () => {
  // The owner's ruling: a generic cancel stays refused, and the model gets ONE narrowed control that is bound to
  // the execution the latest observation named and to the phase that observation reported.
  const withActive = (activeExecution: Readonly<Record<string, unknown>> | null, cancellations: string[]) => ({
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session",
      capabilities: ["cancel_active_execution", "move_to_tile"],
      catalogRevision: 1,
      enabledActionIds: ["cancel_active_execution", "move_to_tile"],
      snapshot: {
        revision: 7,
        location: "Farm",
        tile: { x: 1, y: 2 },
        stamina: 100,
        exhausted: false,
        health: 100,
        actionable: activeExecution === null,
        capabilities: ["cancel_active_execution", "move_to_tile"],
        catalogRevision: 1,
        enabledActionIds: ["cancel_active_execution", "move_to_tile"],
        presentationLocale: "en-US",
        timeOfDay: 600,
        dayOfMonth: 1,
        seasonIndex: 0,
        year: 1,
        activeExecution,
      },
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: TEST_MOD_REGISTRATIONS,
    },
    async execute() {
      throw new Error("unused");
    },
    async cancel(requestId: string, executionId: string, reasonCode: string) {
      cancellations.push(`${requestId}|${executionId}|${reasonCode}`);
      return {
        executionId,
        requestId,
        actionId: "move_to_tile",
        state: "cancelled",
        reasonCode,
        revision: 8,
        evidence: null,
      };
    },
  });

  const stopOf = (integration: ReturnType<typeof withActive>) => {
    const tools = createStardewActionTools(
      integration as never,
      undefined,
      () =>
        ({
          state: () => "admitted",
        }) as never,
    );
    const tool = tools.find((candidate) => candidate.name === "stardew_stop_action");
    assert.ok(tool, "the narrowed control must be mounted");
    return tool!;
  };

  // INSIDE the approach: the stop is sent, with the identity the observation carried and the model's reason code.
  {
    const cancellations: string[] = [];
    const tool = stopOf(
      withActive(
        {
          executionId: "exec_1",
          requestId: "req_1",
          action: "move_to_tile",
          state: "accepted",
          reasonCode: "accepted",
          evidence: null,
          ownerKind: "body_owned_by_movement",
          interruptible: true,
          phase: "approaching",
          cancelSafe: true,
        },
        cancellations,
      ),
    );
    await tool.execute("t", {}, new AbortController().signal, () => undefined, {} as never);
    assert.deepEqual(cancellations, ["req_1|exec_1|model_stop_requested"]);
  }

  // PAST the cancel point: refused by name and NOTHING is sent - a doomed request would be a vague failure.
  {
    const cancellations: string[] = [];
    const tool = stopOf(
      withActive(
        {
          executionId: "exec_2",
          requestId: "req_2",
          action: "navigate_to_destination",
          state: "accepted",
          reasonCode: "accepted",
          evidence: null,
          ownerKind: "body_owned_by_navigation",
          interruptible: false,
          phase: "committed",
          cancelSafe: false,
        },
        cancellations,
      ),
    );
    const result = await tool.execute("t", {}, new AbortController().signal, () => undefined, {} as never);
    assert.deepEqual(cancellations, [], "the request must not be sent at all");
    assert.match(String((result.details as { reasonCode?: string }).reasonCode), /^action_past_cancel_point/);
    // The diagnosis travels with the refusal, so the Agent is told WHICH phase made it unsafe.
    assert.match(String((result.details as { reasonCode?: string }).reasonCode), /phase=committed;cancel_safe=false/);
  }

  // A Mod that does not report the phase at all is treated as not-stoppable rather than assumed stoppable.
  {
    const cancellations: string[] = [];
    const tool = stopOf(
      withActive(
        {
          executionId: "exec_3",
          requestId: "req_3",
          action: "move_to_tile",
          state: "accepted",
          reasonCode: "accepted",
          evidence: null,
        },
        cancellations,
      ),
    );
    const result = await tool.execute("t", {}, new AbortController().signal, () => undefined, {} as never);
    assert.deepEqual(cancellations, []);
    assert.match(String((result.details as { reasonCode?: string }).reasonCode), /phase=unknown/);
  }

  // Nothing to stop is its own named refusal, not a silent success.
  {
    const cancellations: string[] = [];
    const tool = stopOf(withActive(null, cancellations));
    const result = await tool.execute("t", {}, new AbortController().signal, () => undefined, {} as never);
    assert.equal((result.details as { reasonCode?: string }).reasonCode, "no_active_execution");
  }
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
      enabledActionIds: ["move_to_tile"],
      snapshot: null,
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
