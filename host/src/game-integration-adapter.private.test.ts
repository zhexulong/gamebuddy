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
  },
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
    description: "Receipt-backed fixture action used only to verify the Host module seam.",
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
      if (typeof value !== "object" || value === null) throw new Error("invalid_test_arcade_policy");
      return value as never;
    },
    actorId: (connection) => {
      if (connection.scope.integrationId !== "test-arcade") throw new Error("integration_identity_binding_mismatch");
      return "arcade_actor_01";
    },
    assertIdentityBinding: (connection, identity) => {
      if (connection.scope.integrationId !== "test-arcade" || identity.companionId.length === 0)
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
        actions: visible.some((entry) => entry.actionId === "activate_console") ? [activateConsole] : [],
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
        const receipt = JSON.parse((details as { receiptJson: string }).receiptJson) as Record<string, unknown>;
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
              revision: typeof receipt.revision === "number" ? receipt.revision : null,
              evidence:
                typeof receipt.evidence === "object" && receipt.evidence !== null && !Array.isArray(receipt.evidence)
                  ? (receipt.evidence as Record<string, unknown>)
                  : null,
            }
          : null;
      } catch {
        return null;
      }
    },
    actionIdForToolName: (toolName: string) => (toolName === "arcade_activate_console" ? "activate_console" : null),
    isCancellationTool: (toolName: string) => toolName === "arcade_cancel_execution",
  });
}

test("integration action catalog is deterministic, capability gated, and fail closed", () => {
  assert.equal(fakeCatalog.entries.length, 3);
  assert.equal(
    fakeCatalog.revision,
    createIntegrationActionCatalog(fakeCatalog.entries, fakeCatalog.hasCompletionEvidence).revision,
  );
  assert.deepEqual(
    fakeCatalog.visibleActions(fakeRegistrations, ["inspect_zone", "planned_action"]).map((entry) => entry.actionId),
    [],
  );
  assert.deepEqual(fakeCatalog.searchVisibleActions(fakeRegistrations, ["inspect_zone"], "console"), []);
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
  assert.throws(() => createIntegrationActionCatalog([descriptor, descriptor]), /duplicate_integration_action/);
  assert.throws(
    () => createIntegrationActionCatalog([{ ...descriptor, actionId: "bad id" }]),
    /invalid_integration_action_catalog/,
  );
});

test("module descriptor must match the connection integration identity", () => {
  const module = fakeModule();
  assert.doesNotThrow(() => assertIntegrationAdapter(module, "test-arcade"));
  assert.throws(() => assertIntegrationAdapter(module, "stardew"), /integration_adapter_scope_mismatch/);
  assert.throws(
    () => assertIntegrationAdapter({ ...module, parsePolicy: undefined } as never, "test-arcade"),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () => assertIntegrationAdapter({ ...module, knowledgeMetadata: undefined } as never, "test-arcade"),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () => assertIntegrationAdapter({ ...module, status: undefined } as never, "test-arcade"),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () => assertIntegrationAdapter({ ...module, actorId: undefined } as never, "test-arcade"),
    /integration_adapter_scope_mismatch/,
  );
  assert.throws(
    () => assertIntegrationAdapter({ ...module, assertIdentityBinding: undefined } as never, "test-arcade"),
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
        },
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
  // Identity binding is reachable only through the connection the authenticated
  // Stardew launch minted: a caller-built connection is refused before any scope
  // is compared, so a hand-built object can no longer claim a matching (or
  // mismatching) save/world identity here. The owning suite asserts that exact
  // match/mismatch set on a real launch connection —
  // local-stardew-bridge-attestation.test.ts, "enforces the exact
  // save/world/companion identity binding".
  assert.throws(
    () =>
      module.assertIdentityBinding(connection, {
        companionId: "companion_01",
        saveId: "save_01",
        worldId: "world_01",
      }),
    /stardew_connection_not_authenticated_or_not_live/,
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
  assert.deepEqual(conformance.toolNames, ["arcade_activate_console", "arcade_inspect_zone"]);
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
        "target=watering_can_refill_1234;can=(T)WateringCan;water_before=39;water_after=40;water_max=40;stamina_before=100;stamina_after=100;stamina_delta=0;expected_stamina_cost=0;tool_selected=watering_can;slot=4;tool_before=none;slot_before=0;tool_restored=none",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", valid),
    true,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", {
      ...valid,
      evidence: {
        detail:
          "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40;water_after=40",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", {
      ...valid,
      evidence: {
        detail:
          "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40;unexpected=value",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", {
      ...valid,
      evidence: {
        detail:
          "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=39;water_after=not_a_number;water_max=40",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", {
      ...valid,
      evidence: {
        detail: "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=40;water_after=40;water_max=40",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", {
      ...valid,
      evidence: {
        detail: "target=watering_can_refill_1234;slot=4;can=(T)WateringCan;water_before=39;water_after=39;water_max=40",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", {
      ...valid,
      evidence: {
        detail: "target=none;slot=-1;can=(T)WateringCan;water_before=39;water_after=40;water_max=40",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", {
      ...valid,
      evidence: {
        detail: "target=watering can refill;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", {
      ...valid,
      evidence: {
        detail: "target=watering.can/refill;slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("refill_watering_can", {
      ...valid,
      evidence: {
        detail: `target=${"a".repeat(129)};slot=4;can=(T)WateringCan;water_before=39;water_after=40;water_max=40`,
      },
    }),
    false,
  );
});

test("Stardew clear-hoedirt completion evidence requires exact removal fields", () => {
  const valid = {
    state: "succeeded",
    reasonCode: "hoedirt_cleared",
    evidence: {
      detail:
        "location=Farm;target=hoedirt_1234;tile=10,12;tool=pickaxe;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=false;removed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_selected=pickaxe;slot=4;tool_before=none;slot_before=0;tool_restored=none",
    },
  } as const;
  assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("clear_hoedirt", valid), true);
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("clear_hoedirt", {
      ...valid,
      evidence: {
        detail:
          "location=Farm;target=hoedirt_1234;tile=10,12;tool=pickaxe;slot=4;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=false;removed=true;extra=true",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("clear_hoedirt", {
      ...valid,
      evidence: {
        detail:
          "location=Farm;target=hoedirt_1234;tile=10,12;tool=pickaxe;slot=4;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=true;removed=true",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("clear_hoedirt", {
      ...valid,
      state: "failed",
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("clear_hoedirt", {
      ...valid,
      reasonCode: "wrong_reason",
    }),
    false,
  );
});

test("Stardew chop-tree-source completion evidence requires the felled tree plus its health pair and swing count", () => {
  const valid = {
    state: "succeeded",
    reasonCode: "tree_source_chopped",
    evidence: {
      detail:
        "target=tree_chop_1234;tool=axe;tree=Oak;health_before=10;health_after=5;stump_before=false;stump_after=true;source_transformed=true;swings=10;stamina_before=100;stamina_after=80;stamina_delta=-20;expected_stamina_cost=20;tool_selected=axe;slot=4;tool_before=none;slot_before=0;tool_restored=none",
    },
  } as const;
  assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("chop_tree", valid), true);
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("chop_tree", {
      ...valid,
      evidence: {
        detail:
          "target=tree_chop_1234;tool=axe;slot=4;tree=Oak;health_before=10;health_after=5;stump_before=false;stump_after=true;source_transformed=true;swings=10;stamina_before=100;stamina_after=80;stamina_delta=-20;expected_stamina_cost=20;drop=(O)388",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("chop_tree", {
      ...valid,
      evidence: {
        detail:
          "target=tree_chop_1234;tool=axe;slot=4;tree=Oak;health_before=10;health_after=4;stump_before=false;stump_after=true;source_transformed=true;swings=10;stamina_before=100;stamina_after=80;stamina_delta=-20;expected_stamina_cost=20",
      },
    }),
    false,
    "a damaged tree is not a felled one: the engine assigns a felled stump health 5",
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("chop_tree", {
      ...valid,
      evidence: {
        detail:
          "target=tree_chop_1234;tool=axe;slot=4;tree=Oak;health_before=10;health_after=5;stump_before=false;stump_after=true;source_transformed=true;swings=0;stamina_before=100;stamina_after=100;stamina_delta=0;expected_stamina_cost=0",
      },
    }),
    false,
    "a chop that reports zero swings has not touched the tree",
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("chop_tree", {
      ...valid,
      evidence: {
        detail:
          "target=tree_chop_1234;tool=axe;slot=4;tree=Oak;health_before=0;health_after=5;stump_before=false;stump_after=true;source_transformed=true;swings=1;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2",
      },
    }),
    false,
    "a tree with no remaining health was never the living target this action admits",
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("chop_tree", {
      ...valid,
      evidence: {
        detail:
          "target=tree_chop_1234;tool=axe;slot=4;tree=Oak;health_before=10;health_after=5;stump_before=false;stump_after=true;source_transformed=true;swings=10;tree=Oak",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("chop_tree", {
      ...valid,
      evidence: {
        detail:
          "target=tree chop;tool=axe;slot=4;tree=Oak;health_before=10;health_after=5;stump_before=false;stump_after=true;source_transformed=true;swings=10;stamina_before=100;stamina_after=80;stamina_delta=-20;expected_stamina_cost=20",
      },
    }),
    false,
  );
});

test("Stardew break-rock-source completion evidence is source transformation at any real durability", () => {
  // WHAT COMPLETES, AND WHAT ONLY PROGRESSES. `Pickaxe.DoFunction` subtracts
  // `Math.Max(1, upgradeLevel + 1) + additionalPower` (Pickaxe.cs:139-140) and returns early while the remainder is
  // positive (Pickaxe.cs:142-146) - so on every mine node the ordinary swing DAMAGES, and the Mod reports that swing
  // as a succeeded `rock_source_damaged`. This rule is the completion boundary, so it asks the question the tree rule
  // asks: the source left the world. What it used to over-constrain was the DURABILITY - `durability_before === "1"`
  // and `qualified_item_id === "(O)2"`, i.e. only the one-swing farm stone. Those are the fields this test moves.
  const broken = {
    state: "succeeded",
    reasonCode: "rock_source_broken",
    evidence: {
      detail:
        "target=rock_source_1234;tool=pickaxe;tool_selected=pickaxe;slot=4;tool_before=axe;slot_before=0;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=axe",
    },
  } as const;
  assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("break_rock", broken), true);
  // A mine copper node (751) at durability 3, broken by the third of three swings: the same completion, from a rock this
  // rule previously refused twice over - for its item id and for its durability.
  const brokenMineNode = {
    ...broken,
    evidence: {
      detail:
        "target=rock_source_1234;tool=pickaxe;tool_selected=pickaxe;slot=4;tool_before=axe;slot_before=0;qualified_item_id=(O)751;durability_before=3;durability_after=removed;removed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=axe",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("break_rock", brokenMineNode),
    true,
    "a mine node's removal is the same completion as a farm stone's",
  );
  // A DAMAGING swing is not this transition. The Mod reports it as `rock_source_damaged` with the rock still present,
  // and that terminal is deliberately not an arm of this rule - a completed task is recorded from source
  // transformation, exactly as it is for the tree (`stump_after === \"true\"`).
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("break_rock", {
      ...brokenMineNode,
      reasonCode: "rock_source_damaged",
      evidence: {
        detail:
          "target=rock_source_1234;tool=pickaxe;tool_selected=pickaxe;slot=4;tool_before=axe;slot_before=0;qualified_item_id=(O)751;durability_before=3;durability_after=2;removed=false;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=axe",
      },
    }),
    false,
    "a damaged rock is progress, not the completion boundary",
  );
  // And the claim cannot be forged: a `broken` code over damage facts is refused by the evidence, not the code.
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("break_rock", {
      ...brokenMineNode,
      evidence: {
        detail:
          "target=rock_source_1234;tool=pickaxe;tool_selected=pickaxe;slot=4;tool_before=axe;slot_before=0;qualified_item_id=(O)751;durability_before=3;durability_after=2;removed=false;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=axe",
      },
    }),
    false,
    "accessibility of the terminal does not stand in for the world fact",
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("break_rock", {
      ...broken,
      evidence: {
        detail:
          "target=rock_source_1234;tool=pickaxe;slot=4;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true;drop=(O)390",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("break_rock", {
      ...broken,
      evidence: {
        detail:
          "target=rock source;tool=pickaxe;slot=4;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true",
      },
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("break_rock", {
      ...broken,
      evidence: {
        detail:
          "target=rock_source_1234;tool=pickaxe;slot=4;qualified_item_id=(O)2;durability_before=0;durability_after=removed;removed=true",
      },
    }),
    false,
    "a rock with no durability left was not a rock this action swung at",
  );
});

test("Stardew and fake adapter inventories remain isolated", () => {
  const module = fakeModule();
  assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.descriptor.integrationId, "stardew");
  assert.equal(module.descriptor.integrationId, "test-arcade");
  assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasAdapter("activate_console"), false);
  assert.equal(module.actionCatalog.hasAdapter("move_to_tile"), false);
});
