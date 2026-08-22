import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ACTION_POLICY } from "./action-registry.js";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";
import {
  createStardewActionTools,
  createStardewObservationTools,
  type MoveCapableIntegration,
} from "./game-tools.js";
import type { ExecutionReceipt, ExecutionRequest, Scope } from "./protocol.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_projection_01",
  worldId: "world_projection_01",
  playerId: "player_projection_01",
  companionId: "companion_projection_01",
};

function integrationWithCapabilities(
  capabilities: readonly string[],
  execute: MoveCapableIntegration["execute"] = async () => {
    throw new Error("unexpected_execute");
  },
): MoveCapableIntegration {
  return {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() {
      return {
        connected: true,
        sessionId: "session_projection_01",
        capabilities,
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities,
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    execute,
    async cancel() {
      throw new Error("unexpected_cancel");
    },
  };
}

function integrationWithReadiness(
  stateCapabilities: readonly string[],
  snapshotCapabilities: readonly string[] | null,
  connected: boolean,
  execute: MoveCapableIntegration["execute"],
): MoveCapableIntegration {
  return {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() {
      return {
        connected,
        sessionId: connected ? "session_projection_01" : null,
        capabilities: stateCapabilities,
        snapshot:
          snapshotCapabilities === null
            ? null
            : {
                revision: 3,
                location: "Farm",
                tile: { x: 1, y: 2 },
                stamina: 100,
                health: 100,
                actionable: true,
                capabilities: snapshotCapabilities,
                presentationLocale: "en-US",
                activeExecution: null,
              },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    execute,
    async cancel() {
      throw new Error("unexpected_cancel");
    },
  };
}

function admission() {
  return {
    owner: { ownerId: "projection_test", epoch: 1 },
    observer: {
      beforeWrite: () => undefined,
      bindReceipt: () => undefined,
      markUncertain: () => undefined,
    },
    async cancelExact() {
      throw new Error("unexpected_cancel");
    },
  };
}

function actionToolNames(
  integration: MoveCapableIntegration,
  policy = DEFAULT_ACTION_POLICY,
): string[] {
  return createStardewActionTools(integration, policy, () => admission()).map(
    (tool) => tool.name,
  );
}

async function catalogActionIds(
  integration: MoveCapableIntegration,
  policy = DEFAULT_ACTION_POLICY,
): Promise<string[]> {
  const [, , catalog] = createStardewObservationTools(integration, policy);
  const result = await catalog.execute(
    "projection",
    {},
    new AbortController().signal,
    () => undefined,
    {} as never,
  );
  return (
    result.details as { actions: Array<{ actionId: string }> }
  ).actions.map((entry) => entry.actionId);
}

async function searchActionIds(
  integration: MoveCapableIntegration,
  query: string,
): Promise<string[]> {
  const [, , , search] = createStardewObservationTools(
    integration,
    DEFAULT_ACTION_POLICY,
  );
  const result = await search.execute(
    "projection",
    { query },
    new AbortController().signal,
    () => undefined,
    {} as never,
  );
  return (
    result.details as { actions: Array<{ actionId: string }> }
  ).actions.map((entry) => entry.actionId);
}

test("every authenticated published Mod registration with a local adapter has exact live-capability, typed-tool, and catalog parity", async () => {
  const publishedActionIds = TEST_MOD_REGISTRATIONS.map(
    (entry) => entry.actionId,
  );
  const publishedCapabilities = TEST_MOD_REGISTRATIONS.map(
    (entry) => entry.actionId,
  );
  const integration = integrationWithCapabilities(publishedCapabilities);

  assert.equal(
    new Set(publishedActionIds).size,
    publishedActionIds.length,
    "published action IDs must be unique",
  );
  assert.equal(
    new Set(publishedCapabilities).size,
    publishedCapabilities.length,
    "published capabilities must be unique",
  );
  assert.deepEqual(
    [...actionToolNames(integration)].sort(),
    publishedActionIds.map((actionId) => `stardew_${actionId}`).sort(),
  );
  assert.deepEqual(await catalogActionIds(integration), publishedActionIds);
});

test("every materialized published Farmhand tool routes its exact action-specific fixture through executeAction", async () => {
  const fixtures: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
    {
      move_to_tile: { x: 11, y: 12 },
      equip_tool: { slot: 1 },
      travel: { x: 13, y: 14 },
      enter_exit: { x: 15, y: 16 },
      till_soil: { x: 17, y: 18 },
      pickup_forage: {
        x: 19,
        y: 20,
        expectedQualifiedItemId: "(O)16",
        expectedTargetId: "forage_target_01",
      },
      pickup_item: {
        x: 21,
        y: 22,
        expectedQualifiedItemId: "(O)390",
        expectedTargetId: "item_target_01",
      },
      refill_watering_can: {
        slot: 2,
        x: 23,
        y: 24,
        expectedTargetId: "water_source_01",
      },
      water_crop: { x: 25, y: 26, expectedTargetId: "crop_target_01" },
      plant_seed: {
        slot: 3,
        x: 27,
        y: 28,
        expectedQualifiedItemId: "(O)472",
        expectedTargetId: "seed_target_01",
      },
      fertilize_tile: {
        slot: 4,
        x: 29,
        y: 30,
        expectedQualifiedItemId: "(O)368",
        expectedTargetId: "fertilizer_target_01",
      },
      place_wood_fence: {
        slot: 5,
        x: 31,
        y: 32,
        expectedQualifiedItemId: "(O)322",
        expectedTargetId: "fence_target_01",
      },
      place_crab_pot: {
        slot: 6,
        x: 33,
        y: 34,
        expectedQualifiedItemId: "(O)710",
        expectedTargetId: "crab_pot_target_01",
      },
      bait_crab_pot: {
        slot: 7,
        x: 35,
        y: 36,
        expectedQualifiedItemId: "(O)685",
        expectedTargetId: "bait_crab_pot_target_01",
      },
      machine_inspect: { x: 37, y: 38, expectedTargetId: "machine_target_01" },
      machine_load: {
        slot: 8,
        x: 39,
        y: 40,
        expectedQualifiedItemId: "(O)433",
        expectedTargetId: "machine_load_target_01",
      },
      machine_collect_output: {
        x: 41,
        y: 42,
        expectedTargetId: "machine_output_target_01",
      },
      collect_animal_product: {
        slot: 9,
        x: 43,
        y: 44,
        expectedTargetId: "animal_target_01",
      },
      feed_animal: {
        slot: 10,
        x: 45,
        y: 46,
        expectedTargetId: "trough_target_01",
      },
      use_item: { slot: 11, expectedQualifiedItemId: "(O)194" },
      harvest_crop: {
        x: 47,
        y: 48,
        expectedQualifiedItemId: "(O)24",
        expectedTargetId: "harvest_target_01",
      },
      chop_tree_source: {
        slot: 12,
        x: 49,
        y: 50,
        expectedTargetId: "tree_target_01",
      },
      dig_artifact_spot: {
        slot: 13,
        x: 51,
        y: 52,
        expectedTargetId: "artifact_spot_target_01",
      },
      clear_hoedirt: {
        slot: 14,
        x: 53,
        y: 54,
        expectedTargetId: "hoedirt_target_01",
      },
      break_rock_source: {
        slot: 15,
        x: 55,
        y: 56,
        expectedTargetId: "rock_target_01",
      },
    };
  const requests: ExecutionRequest[] = [];
  const integration = integrationWithCapabilities(
    TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId),
    async (request) => {
      requests.push(request);
      return {
        executionId: `execution_${request.action}`,
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "completed",
        revision: 3,
        evidence: { route: request.action },
      } satisfies ExecutionReceipt;
    },
  );
  const tools = new Map(
    createStardewActionTools(integration, DEFAULT_ACTION_POLICY, () =>
      admission(),
    ).map((tool) => [tool.name, tool]),
  );
  const expectedToolNames = TEST_MOD_REGISTRATIONS.map(
    (entry) => `stardew_${entry.actionId}`,
  ).sort();

  assert.deepEqual(
    Object.keys(fixtures).sort(),
    TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId).sort(),
  );
  assert.deepEqual(
    [...tools.keys()].sort(),
    expectedToolNames,
    "materialized tool names must exactly match published actions",
  );
  for (const [toolName, tool] of tools) {
    assert.ok(toolName.startsWith("stardew_"));
    assert.ok(
      tool.label.trim().length > 0,
      `${toolName} must expose a nonempty label`,
    );
    assert.ok(
      tool.description.trim().length > 0,
      `${toolName} must expose a nonempty description`,
    );
    assert.equal(
      typeof tool.parameters,
      "object",
      `${toolName} must expose an object parameter schema`,
    );
    assert.notEqual(
      tool.parameters,
      null,
      `${toolName} must expose a parameter schema`,
    );
  }
  for (const { actionId } of TEST_MOD_REGISTRATIONS) {
    const args = fixtures[actionId];
    assert.ok(args, `missing explicit fixture for ${actionId}`);
    const tool = tools.get(`stardew_${actionId}`);
    assert.ok(tool, `missing materialized tool for ${actionId}`);
    const result = await tool.execute(
      `tool_call_${actionId}`,
      {
        ...args,
        requestId: `request_${actionId}`,
        idempotencyKey: `idempotency_${actionId}`,
      },
      new AbortController().signal,
      () => undefined,
      {} as never,
    );
    const request = requests.at(-1);
    assert.ok(request, `missing execute request for ${actionId}`);
    assert.equal(request.action, actionId);
    assert.deepEqual(request.args, args);
    assert.equal(
      (result.details as { reasonCode: string | null }).reasonCode,
      null,
    );
    assert.equal(
      JSON.parse((result.details as { receiptJson: string }).receiptJson).state,
      "succeeded",
    );
  }
  assert.deepEqual(
    [...new Set(requests.map((request) => request.action))].sort(),
    TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId).sort(),
  );
});

test("Farmhand action projection materializes only stable registry actions present in the live Mod capability set", async () => {
  const unknownOnly = integrationWithCapabilities(["unknown_mod_capability"]);
  assert.deepEqual(actionToolNames(unknownOnly), []);
  assert.deepEqual(await catalogActionIds(unknownOnly), []);

  const stableButNotLive = integrationWithCapabilities(["move_to_tile"]);
  assert.deepEqual(actionToolNames(stableButNotLive), ["stardew_move_to_tile"]);
  assert.deepEqual(await catalogActionIds(stableButNotLive), ["move_to_tile"]);
  assert.equal(
    actionToolNames(stableButNotLive).includes("stardew_till_soil"),
    false,
  );
});

test("hello-only capabilities absent from the fresh snapshot are neither mounted, listed, nor searchable", async () => {
  const integration = integrationWithReadiness(
    ["move_to_tile", "till_soil"],
    ["move_to_tile"],
    true,
    async () => {
      throw new Error("must_not_execute");
    },
  );
  assert.deepEqual(actionToolNames(integration), ["stardew_move_to_tile"]);
  assert.deepEqual(await catalogActionIds(integration), ["move_to_tile"]);
  assert.deepEqual(await searchActionIds(integration, "soil"), []);
});

test("Farmhand projection does not revive legacy or experimental Mod capabilities", async () => {
  const integration = integrationWithCapabilities([
    "clear_debris",
    "npc_relationship",
    "end_day",
    "collect_resource",
  ]);

  assert.deepEqual(actionToolNames(integration), []);
  assert.deepEqual(await catalogActionIds(integration), []);
});

test("one omitted live capability leaves its published registry action unmounted and unlisted", async () => {
  const omitted = TEST_MOD_REGISTRATIONS.find(
    (entry) => entry.actionId === "till_soil",
  );
  assert.ok(
    omitted,
    "characterization requires a Mod-published action when omitted live",
  );
  const integration = integrationWithCapabilities(
    TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId).filter(
      (actionId) => actionId !== omitted.actionId,
    ),
  );

  assert.equal(
    actionToolNames(integration).includes(`stardew_${omitted.actionId}`),
    false,
  );
  assert.equal(
    (await catalogActionIds(integration)).includes(omitted.actionId),
    false,
  );
  assert.ok(TEST_MOD_REGISTRATIONS.includes(omitted));
});

test("Host v1 denied farming family narrows the live tool and catalog surface without hiding unrelated actions", async () => {
  const allCapabilities = TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId);
  const integration = integrationWithCapabilities(allCapabilities);
  const denyFarming = {
    policyVersion: 1 as const,
    deniedActions: [],
    deniedFamilies: ["farming_crops"],
  };
  const deniedFarming = TEST_MOD_REGISTRATIONS.filter(
    (entry) => entry.familyId === "farming_crops",
  );
  const remaining = TEST_MOD_REGISTRATIONS.filter(
    (entry) => entry.familyId !== "farming_crops",
  );

  assert.ok(
    deniedFarming.length > 1,
    "farming characterization requires a multi-action family",
  );
  assert.ok(
    remaining.some((entry) => entry.actionId === "move_to_tile"),
    "unrelated action must remain published",
  );
  assert.deepEqual(
    [...actionToolNames(integration, denyFarming)].sort(),
    remaining.map((entry) => `stardew_${entry.actionId}`).sort(),
  );
  assert.deepEqual(
    await catalogActionIds(integration, denyFarming),
    remaining.map((entry) => entry.actionId),
  );
  for (const action of deniedFarming) {
    assert.equal(
      actionToolNames(integration, denyFarming).includes(
        `stardew_${action.actionId}`,
      ),
      false,
    );
    assert.equal(
      (await catalogActionIds(integration, denyFarming)).includes(
        action.actionId,
      ),
      false,
    );
  }
  assert.equal(
    actionToolNames(integration, denyFarming).includes("stardew_move_to_tile"),
    true,
  );
  assert.equal(
    (await catalogActionIds(integration, denyFarming)).includes("move_to_tile"),
    true,
  );
});

test("Farmhand materialization requires a connected fresh snapshot capability", () => {
  for (const [connected, snapshotCapabilities] of [
    [false, ["move_to_tile"]],
    [true, null],
    [true, []],
  ] as const) {
    const integration = integrationWithReadiness(
      ["move_to_tile"],
      snapshotCapabilities,
      connected,
      async () => {
        throw new Error("must_not_execute");
      },
    );
    assert.deepEqual(
      createStardewActionTools(integration, DEFAULT_ACTION_POLICY, () =>
        admission(),
      ),
      [],
    );
  }
});

test("a materialized Farmhand tool rereads the latest live revision at invocation", async () => {
  let revision = 3;
  const capabilities = ["move_to_tile"];
  const requests: ExecutionRequest[] = [];
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() {
      return {
        connected: true,
        sessionId: "session_projection_01",
        capabilities,
        snapshot: {
          revision,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities,
          presentationLocale: "en-US",
          activeExecution: null,
        },
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: TEST_MOD_REGISTRATIONS,
      };
    },
    async execute(request) {
      requests.push(request);
      return {
        executionId: "execution_move_to_tile",
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "completed",
        revision,
        evidence: { route: request.action },
      };
    },
    async cancel() {
      throw new Error("unexpected_cancel");
    },
  };

  const [move] = createStardewActionTools(
    integration,
    DEFAULT_ACTION_POLICY,
    () => admission(),
  );
  assert.ok(move);
  revision = 4;
  await move.execute(
    "projection",
    {
      x: 3,
      y: 4,
      requestId: "request_revision_04",
      idempotencyKey: "idempotency_revision_04",
    },
    new AbortController().signal,
    () => undefined,
    {} as never,
  );

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request);
  assert.equal(request.action, "move_to_tile");
  assert.deepEqual(request.args, { x: 3, y: 4 });
  assert.equal(request.requestId, "request_revision_04");
  assert.equal(request.idempotencyKey, "idempotency_revision_04");
  assert.equal(request.expectedRevision, 4);
});

test("a materialized session A tool cannot pre-write after session B withdraws its capability", async () => {
  let session = "session_generation_a";
  let revision = 3;
  let capabilities: readonly string[] = ["move_to_tile"];
  let executeCalls = 0;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() {
      return {
        connected: true,
        sessionId: session,
        capabilities,
        snapshot: {
          revision,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities,
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
  const [oldMove] = createStardewActionTools(
    integration,
    DEFAULT_ACTION_POLICY,
    () => admission(),
  );
  assert.ok(oldMove);
  session = "session_generation_b";
  revision = 4;
  capabilities = [];
  const result = await oldMove.execute(
    "projection",
    { x: 3, y: 4 },
    new AbortController().signal,
    () => undefined,
    {} as never,
  );
  assert.equal(executeCalls, 0);
  assert.equal(
    (result.details as { reasonCode: string }).reasonCode,
    "capability_not_declared",
  );
  assert.deepEqual(actionToolNames(integration), []);
  assert.deepEqual(await catalogActionIds(integration), []);
  assert.deepEqual(await searchActionIds(integration, "move"), []);
});

test("a mounted Farmhand action fails closed when its live Mod capability is withdrawn", async () => {
  let enabled = true;
  let executeCalls = 0;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() {
      const capabilities = enabled ? ["move_to_tile"] : [];
      return {
        connected: true,
        sessionId: "session_projection_01",
        capabilities,
        snapshot: {
          revision: 3,
          location: "Farm",
          tile: { x: 1, y: 2 },
          stamina: 100,
          health: 100,
          actionable: true,
          capabilities,
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

  const [move] = createStardewActionTools(
    integration,
    DEFAULT_ACTION_POLICY,
    () => admission(),
  );
  assert.ok(move);
  enabled = false;
  const result = await move.execute(
    "projection",
    { x: 3, y: 4 },
    new AbortController().signal,
    () => undefined,
    {} as never,
  );

  assert.equal(executeCalls, 0);
  assert.equal(
    (result.details as { reasonCode: string }).reasonCode,
    "capability_not_declared",
  );
});
