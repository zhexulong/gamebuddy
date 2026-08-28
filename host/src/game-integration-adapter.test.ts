import assert from "node:assert/strict";
import test from "node:test";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertIntegrationAdapter,
  assertIntegrationAdapterConformance,
  createIntegrationActionCatalog,
  type GameIntegrationAdapter,
  type IntegrationToolContext,
} from "./game-integration-adapter.js";
import type { GameConnection } from "./game-connection.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

const scope = { integrationId: "test-arcade" } as const;

const fakeRegistrations = Object.freeze([
  {
    actionId: "inspect_zone",
    familyId: "observation",
    identityVersion: 1,
    lifecycle: "published" as const,
    kind: "read_only" as const,
  },
  {
    actionId: "activate_console",
    familyId: "interaction",
    identityVersion: 1,
    lifecycle: "published" as const,
    kind: "execution" as const,
  },
  {
    actionId: "planned_action",
    familyId: "future",
    identityVersion: 1,
    lifecycle: "planned" as const,
    kind: "execution" as const,
  }
]);

const fakeCatalog = createIntegrationActionCatalog(
  fakeRegistrations,
  (actionId, receipt) =>
    actionId === "activate_console" &&
    receipt.state === "succeeded" &&
    receipt.reasonCode === "console_activated" &&
    receipt.evidence?.postcondition === "active",
);

function fakeModule(): GameIntegrationAdapter {
  const inspectZone = defineTool({
    name: "arcade_inspect_zone",
    label: "Inspect arcade zone",
    description: "Receipt-backed fixture observation.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text" as const, text: "zone" }],
      details: { zone: "alpha" },
    }),
  });
  const activateConsole = defineTool({
    name: "arcade_activate_console",
    label: "Activate arcade console",
    description:
      "Receipt-backed fixture action used only to verify the Host module seam.",
    parameters: Type.Object({
      consoleId: Type.String({ minLength: 1, maxLength: 32 }),
    }),
    execute: async (_toolCallId, params) => {
      const receipt = {
        requestId: "arcade_request_01",
        executionId: "arcade_execution_01",
        state: "succeeded",
        reasonCode: "console_activated",
        revision: 1,
        evidence: { postcondition: "active", consoleId: params.consoleId },
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(receipt) }],
        details: { receiptJson: JSON.stringify(receipt) },
      };
    },
  });
  return Object.freeze({
    descriptor: Object.freeze({
      integrationId: "test-arcade",
      version: "fixture-v1",
      toolNamePrefix: "arcade_",
    }),
    actionCatalog: fakeCatalog,
    defaultPolicy: Object.freeze({
      policyVersion: 1 as const,
      deniedActions: Object.freeze([]),
      deniedFamilies: Object.freeze([]),
    }),
    parsePolicy: (value: unknown) => {
      if (typeof value !== "object" || value === null)
        throw new Error("invalid_test_arcade_policy");
      return value as never;
    },
    assertIdentityBinding: (connection, identity) => {
      if (
        connection.scope.integrationId !== "test-arcade" ||
        identity.playerId.length === 0 ||
        identity.companionId.length === 0
      )
        throw new Error("integration_identity_binding_mismatch");
    },
    worldScope: () => null,
    createToolSet: (context: IntegrationToolContext) => {
      const state = context.connection.state as {
        capabilities?: readonly string[];
        registrations?: typeof fakeRegistrations;
      };
      const visible = fakeCatalog.visibleActions(
        state.registrations ?? fakeRegistrations,
        state.capabilities ?? [],
        context.policy,
      );
      return {
        observation: [inspectZone],
        actions: visible.some((entry) => entry.actionId === "activate_console")
          ? [activateConsole]
          : [],
        knowledge: [],
      };
    },
    knowledgeMetadata: () => ({
      mounted: false,
      gameVersion: null,
      bundleVersion: null,
    }),
    status: (connection) => {
      const state = connection.state as {
        connected?: boolean;
        capabilities?: readonly string[];
      };
      return {
        connected: state.connected === true,
        capabilities: state.capabilities ?? [],
        capabilityRevision: null,
        snapshotRevision: null,
        latestReceiptState: null,
        latestReasonCode: null,
      };
    },
    readState: (connection) => {
      const state = connection.state as {
        connected?: boolean;
        capabilities?: readonly string[];
        registrations?: typeof fakeRegistrations;
      };
      return {
        connected: state.connected === true,
        sessionId: null,
        capabilities: state.capabilities ?? [],
        capabilityRevision: null,
        registrations: state.registrations ?? fakeRegistrations,
        snapshotRevision: null,
        activeExecution: null,
        latestReceipt: null,
        latestReasonCode: null,
      };
    },
    cancelExecution: () => "not_supported",
    parseReceipt: (details: unknown) => {
      if (
        typeof details !== "object" ||
        details === null ||
        typeof (details as { receiptJson?: unknown }).receiptJson !== "string"
      )
        return null;
      try {
        const receipt = JSON.parse(
          (details as { receiptJson: string }).receiptJson,
        ) as Record<string, unknown>;
        return typeof receipt.requestId === "string" &&
          typeof receipt.executionId === "string" &&
          typeof receipt.state === "string" &&
          typeof receipt.reasonCode === "string"
          ? {
              requestId: receipt.requestId,
              executionId: receipt.executionId,
              actionId: "activate_console",
              state: receipt.state,
              reasonCode: receipt.reasonCode,
              revision:
                typeof receipt.revision === "number" ? receipt.revision : null,
              evidence:
                typeof receipt.evidence === "object" &&
                receipt.evidence !== null &&
                !Array.isArray(receipt.evidence)
                  ? (receipt.evidence as Record<string, unknown>)
                  : null,
            }
          : null;
      } catch {
        return null;
      }
    },
    actionIdForToolName: (toolName: string) =>
      toolName === "arcade_activate_console" ? "activate_console" : null,
    isCancellationTool: (toolName: string) =>
      toolName === "arcade_cancel_execution",
  });
}

test("integration action catalog is deterministic, capability gated, and fail closed", () => {
  assert.equal(fakeCatalog.entries.length, 3);
  assert.equal(
    fakeCatalog.revision,
    createIntegrationActionCatalog(
      fakeCatalog.entries,
      fakeCatalog.hasCompletionEvidence,
    ).revision,
  );
  assert.deepEqual(
    fakeCatalog
      .visibleActions(fakeRegistrations, ["inspect_zone", "planned_action"])
      .map((entry) => entry.actionId),
    [],
  );
  assert.deepEqual(
    fakeCatalog.searchVisibleActions(
      fakeRegistrations,
      ["inspect_zone"],
      "console",
    ),
    [],
  );
  assert.deepEqual(
    fakeCatalog
      .visibleActions(fakeRegistrations, ["inspect_zone", "activate_console"], {
        policyVersion: 1,
        deniedActions: ["activate_console"],
        deniedFamilies: [],
      })
      .map((entry) => entry.actionId),
    [],
  );
  assert.equal(
    fakeCatalog.hasCompletionEvidence("activate_console", {
      state: "succeeded",
      reasonCode: "console_activated",
      evidence: { postcondition: "active" },
    }),
    true,
  );
  assert.equal(
    fakeCatalog.hasCompletionEvidence("activate_console", {
      state: "succeeded",
      reasonCode: "console_activated",
      evidence: null,
    }),
    false,
  );
});

test("catalog rejects duplicate and malformed action descriptors", () => {
  const descriptor = {
    actionId: "same",
  };
  assert.throws(
    () => createIntegrationActionCatalog([descriptor, descriptor]),
    /duplicate_integration_action/,
  );
  assert.throws(
    () =>
      createIntegrationActionCatalog([{ ...descriptor, actionId: "bad id" }]),
    /invalid_integration_action_catalog/,
  );
});

test("module descriptor must match the connection integration identity", () => {
  const module = fakeModule();
  assert.doesNotThrow(() => assertIntegrationAdapter(module, "test-arcade"));
  assert.throws(
    () => assertIntegrationAdapter(module, "stardew"),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () =>
      assertIntegrationAdapter(
        { ...module, parsePolicy: undefined } as never,
        "test-arcade",
      ),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () =>
      assertIntegrationAdapter(
        { ...module, knowledgeMetadata: undefined } as never,
        "test-arcade",
      ),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () =>
      assertIntegrationAdapter(
        { ...module, status: undefined } as never,
        "test-arcade",
      ),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () =>
      assertIntegrationAdapter(
        { ...module, assertIdentityBinding: undefined } as never,
        "test-arcade",
      ),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () =>
      assertIntegrationAdapter(
        {
          ...module,
          descriptor: { ...module.descriptor, toolNamePrefix: "invalid" },
        } as never,
        "test-arcade",
      ),
    /integration_adapter_scope_mismatch/,
  );
});

test("module tools require their owning module and scope identity", () => {
  const module = STARDEW_GAME_INTEGRATION_ADAPTER;
  const stardewScope = {
    integrationId: "stardew",
    saveId: "save_01",
    worldId: "world_01",
    playerId: "player_01",
    companionId: "companion_01",
  } as const;
  const connection = {
    scope: stardewScope,
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["move_to_tile"],
      catalogRegistrations: [
        {
          actionId: "move_to_tile",
          familyId: "movement_navigation",
          identityVersion: 1,
          lifecycle: "published",
          kind: "execution",
        }
      ],
      snapshot: null,
      latestReceipt: null,
      latestReasonCode: null,
    },
    module,
  };
  assert.throws(
    () =>
      assertIntegrationAdapterConformance(module, {
        ...connection,
        scope: { ...connection.scope, integrationId: "test-arcade" },
      } as GameConnection),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () =>
      assertIntegrationAdapterConformance(module, {
        ...connection,
        module: fakeModule(),
      }),
    /integration_adapter_scope_mismatch/,
  );
  assert.doesNotThrow(() =>
    module.assertIdentityBinding(connection, {
      playerId: "player_01",
      companionId: "companion_01",
      saveId: "save_01",
      worldId: "world_01",
    }),
  );
  assert.throws(
    () =>
      module.assertIdentityBinding(connection, {
        playerId: "player_01",
        companionId: "companion_01",
        saveId: "other_save",
        worldId: "world_01",
      }),
    /integration_identity_binding_mismatch/,
  );
});

test("fake second-game module owns its tools and does not expose Stardew tools", () => {
  const module = fakeModule();
  const connection: GameConnection = {
    scope,
    state: {
      capabilities: ["activate_console"],
      registrations: fakeRegistrations,
    },
    module,
  };
  const conformance = assertIntegrationAdapterConformance(module, connection);
  assert.deepEqual(conformance.toolNames, [
    "arcade_activate_console",
    "arcade_inspect_zone",
  ]);
  const tools = module.createToolSet({ connection });
  assert.deepEqual(
    tools.observation.map((tool) => tool.name),
    ["arcade_inspect_zone"],
  );
  assert.deepEqual(
    tools.actions.map((tool) => tool.name),
    ["arcade_activate_console"],
  );
  assert.deepEqual(
    module.createToolSet({
      connection,
      policy: {
        policyVersion: 1,
        deniedActions: ["activate_console"],
        deniedFamilies: [],
      },
    }).actions,
    [],
  );
  assert.equal(
    tools.observation.some((tool) => tool.name.startsWith("stardew_")),
    false,
  );
  assert.equal(
    tools.actions.some((tool) => tool.name.startsWith("stardew_")),
    false,
  );
});

test("conformance rejects a module status projection with malformed capabilities", () => {
  const module = fakeModule();
  const connection: GameConnection = {
    scope,
    state: { opaque: true },
    module: {
      ...module,
      status: () => ({
        connected: true,
        capabilities: ["not valid"],
        capabilityRevision: null,
        snapshotRevision: null,
        latestReceiptState: null,
        latestReasonCode: null,
      }),
    },
  };
  assert.throws(
    () => assertIntegrationAdapterConformance(connection.module, connection),
    /integration_status_view_invalid/,
  );
});

test("Stardew refill completion evidence requires exact, internally consistent semicolon fields", () => {
  const valid = {
    state: "succeeded",
    reasonCode: "watering_can_refilled",
    evidence: {
      detail:
        "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      valid,
    ),
    true,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      {
        ...valid,
        evidence: {
          detail:
            "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40;water_after=40",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      {
        ...valid,
        evidence: {
          detail:
            "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40;unexpected=value",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      {
        ...valid,
        evidence: {
          detail:
            "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=39;water_after=not_a_number;water_max=40",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      {
        ...valid,
        evidence: {
          detail:
            "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=40;water_after=40;water_max=40",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      {
        ...valid,
        evidence: {
          detail:
            "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=39;water_after=39;water_max=40",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      {
        ...valid,
        evidence: {
          detail:
            "target=none;slot=-1;can=(T)WateringCan;water_before=39;water_after=40;water_max=40",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      {
        ...valid,
        evidence: {
          detail:
            "target=watering can refill;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      {
        ...valid,
        evidence: {
          detail:
            "target=watering.can/refill;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "refill_watering_can",
      {
        ...valid,
        evidence: {
          detail: `target=${"a".repeat(129)};slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40`,
        },
      },
    ),
    false,
  );
});

test("Stardew clear-hoedirt completion evidence requires exact removal fields", () => {
  const valid = {
    state: "succeeded",
    reasonCode: "hoedirt_cleared",
    evidence: {
      detail:
        "location=Farm;target=hoedirt_1234;tile=10,12;tool=pickaxe;slot=4;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=false;removed=true",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "clear_hoedirt",
      valid,
    ),
    true,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "clear_hoedirt",
      {
        ...valid,
        evidence: {
          detail:
            "location=Farm;target=hoedirt_1234;tile=10,12;tool=pickaxe;slot=4;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=false;removed=true;extra=true",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "clear_hoedirt",
      {
        ...valid,
        evidence: {
          detail:
            "location=Farm;target=hoedirt_1234;tile=10,12;tool=pickaxe;slot=4;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=true;removed=true",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "clear_hoedirt",
      { ...valid, state: "failed" },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "clear_hoedirt",
      {
        ...valid,
        reasonCode: "wrong_reason",
      },
    ),
    false,
  );
});

test("Stardew chop-tree-source completion evidence requires exact terminal source transformation facts", () => {
  const valid = {
    state: "succeeded",
    reasonCode: "tree_source_chopped",
    evidence: {
      detail:
        "target=tree_chop_1234;tool=axe;slot=4;tree=Oak;health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "chop_tree_source",
      valid,
    ),
    true,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "chop_tree_source",
      {
        ...valid,
        evidence: {
          detail:
            "target=tree_chop_1234;tool=axe;slot=4;tree=Oak;health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true;drop=(O)388",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "chop_tree_source",
      {
        ...valid,
        evidence: {
          detail:
            "target=tree_chop_1234;tool=axe;slot=4;tree=Oak;health_before=1;health_after=4;stump_before=false;stump_after=true;source_transformed=true",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "chop_tree_source",
      {
        ...valid,
        evidence: {
          detail:
            "target=tree_chop_1234;tool=axe;slot=4;tree=Oak;health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true;tree=Oak",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "chop_tree_source",
      {
        ...valid,
        evidence: {
          detail:
            "target=tree chop;tool=axe;slot=4;tree=Oak;health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true",
        },
      },
    ),
    false,
  );
});

test("Stardew break-rock-source completion evidence requires exact source-only removal facts", () => {
  const valid = {
    state: "succeeded",
    reasonCode: "rock_source_broken",
    evidence: {
      detail:
        "target=rock_source_1234;tool=pickaxe;slot=4;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "break_rock_source",
      valid,
    ),
    true,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "break_rock_source",
      {
        ...valid,
        evidence: {
          detail:
            "target=rock_source_1234;tool=pickaxe;slot=4;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true;drop=(O)390",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "break_rock_source",
      {
        ...valid,
        evidence: {
          detail:
            "target=rock source;tool=pickaxe;slot=4;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true",
        },
      },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "break_rock_source",
      {
        ...valid,
        evidence: {
          detail:
            "target=rock_source_1234;tool=pickaxe;slot=4;qualified_item_id=(O)2;durability_before=1;durability_after=1;removed=false",
        },
      },
    ),
    false,
  );
});

test("Stardew and fake adapter inventories remain isolated", () => {
  const module = fakeModule();
  assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.descriptor.integrationId, "stardew");
  assert.equal(module.descriptor.integrationId, "test-arcade");
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasAdapter("activate_console"),
    false,
  );
  assert.equal(module.actionCatalog.hasAdapter("move_to_tile"), false);
});
