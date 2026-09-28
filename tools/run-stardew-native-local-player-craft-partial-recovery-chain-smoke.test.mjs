import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCraftPartialRecoveryChainSmoke } from "./run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs";

const SCENARIO = "native_craft_item_partial_v1";
const PRODUCT_ITEM_ID = "(O)685";
const INGREDIENT_ITEM_ID = "(O)684";
const EXISTING_STACK = 998;
const PRODUCED_STACK = 5;
const GAINED_STACK = 1;
const DROPPED_STACK = 4;

// The mock must emit the terminals the Mod ACTUALLY produces, not copies of the
// runner's own constants — otherwise a tandem-but-wrong pair stays green. This is
// the bug class that once shipped an invented `harvest_` target prefix while the
// Mod emitted `crop_<hex16>`, so every real target failed validation and the actor
// circled the map for 152 waypoints. Extract the terminals from the Mod source.
function terminalFromSource(file, anchor, re) {
  const src = readFileSync(file, "utf8");
  const idx = src.indexOf(anchor);
  assert.ok(idx >= 0, `anchor ${JSON.stringify(anchor)} not found in ${file}`);
  const m = src.slice(idx, idx + 600).match(re);
  assert.ok(m, `terminal not matched near ${JSON.stringify(anchor)} in ${file}`);
  return m[1];
}

const CRAFT_SOURCE = fileURLToPath(
  new URL("../integrations/stardew/farmhandexecutioncontroller.craftingactions.cs", import.meta.url),
);
const CONTAINER_SOURCE = fileURLToPath(
  new URL("../integrations/stardew/farmhandexecutioncontroller.containeractions.cs", import.meta.url),
);
const CONTROLLER_SOURCE = fileURLToPath(new URL("../integrations/stardew/farmhandexecutioncontroller.cs", import.meta.url));

/** The Mod's partial-completion terminal pair for craft_item. */
const SOURCE_CRAFT_PARTIAL_STATE = "partially_succeeded";
const SOURCE_CRAFT_REASON = terminalFromSource(
  CRAFT_SOURCE,
  "return this.RememberTerminal(requestId, executionId, ExecutionState.PartiallySucceeded, \"crafted_item_created\"",
  /ExecutionState\.PartiallySucceeded, "(crafted_item_created)"/,
);
/** The partial disposition the breakpoint must show (a ternary literal in source). */
const SOURCE_PARTIAL_DISPOSITION = terminalFromSource(
  CRAFT_SOURCE,
  '"partially_dropped_on_ground"',
  /"(partially_dropped_on_ground)"/,
);
/** The container-store success terminal. */
const SOURCE_STORE_REASON = terminalFromSource(
  CONTAINER_SOURCE,
  "ExecutionState.Succeeded, \"chest_stored\"",
  /ExecutionState\.Succeeded, "(chest_stored)"/,
);
/** The item-pickup success terminal. */
const SOURCE_PICKUP_REASON = terminalFromSource(
  CONTROLLER_SOURCE,
  "ExecutionState.Succeeded, \"item_picked_up\"",
  /ExecutionState\.Succeeded, "(item_picked_up)"/,
);

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  ActionPolicyVersion: 0,
  EnabledActions: ["move_to_tile", "travel", "craft_item", "chest_store", "pickup_item"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: SCENARIO,
    LogicalSaveName: "GameBuddyFixtureCraftPartial",
    ObservedSaveSlot: "GameBuddyFixtureCraftPartial_1",
  },
};

const CAPABILITIES = [
  "cancel_active_execution",
  "chest_store",
  "craft_item",
  "inspect_self",
  "move_to_tile",
  "pickup_item",
  "travel",
];

const CHEST_TARGET_ID = "chest_0123456789abcdef";
const DROP_TARGET_ID = "debris_fedcba9876543210";

// Evidence spellings follow the Mod's format strings exactly.
const CRAFT_EVIDENCE = (disposition, gained, dropped) =>
  `location=Farm;recipe=Bait;output=${PRODUCT_ITEM_ID};produced_stack=${PRODUCED_STACK};produced_per_craft=${PRODUCED_STACK}` +
  `;disposition=${disposition};inventory_gained_stack=${gained};dropped_stack=${dropped};inventory_accepting_before=false` +
  `;materials_consumed_exactly=true;inventory_postcondition=true;count_before=0;count_after=1;count_postcondition=true` +
  `;ingredients=684=-1;dropped_debris=1;native_menu_opened=false`;
const STORE_EVIDENCE = (chestBefore, chestAfter) =>
  `location=Farm;target=${CHEST_TARGET_ID};tile=5,5;container=chest;item=${PRODUCT_ITEM_ID}` +
  `;player_stack_before=${EXISTING_STACK + GAINED_STACK};player_stack_after=0;source_consumed=true` +
  `;chest_stack_before=${chestBefore};chest_stack_after=${chestAfter};native_menu_opened=false`;
const PICKUP_EVIDENCE = (before, after) =>
  `location=Farm;target=${DROP_TARGET_ID};tile=6,5;item=${PRODUCT_ITEM_ID};stack=${DROPPED_STACK}` +
  `;native_auto_collect=true;chunk_removed=true;inventory_before=${before};inventory_after=${after}`;

/** Mock bridge whose observable revision tracks every terminal revision. */
function createMock({ revision, retainedStack, dropped, chestStack }) {
  const state = { revision, retainedStack, dropped, chestStack, client: null };
  const snapshot = () => ({
    revision: state.revision,
    location: "Farm",
    tile: { x: 5, y: 6 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    warps: [],
    craftingRecipeTargets: [{ targetId: "Bait", displayName: "Bait", ingredientsAvailable: true }],
    chestStoreTargets: [
      {
        targetId: CHEST_TARGET_ID,
        x: 5,
        y: 5,
        slot: state.retainedStack > 0 ? 0 : -1,
        qualifiedItemId: PRODUCT_ITEM_ID,
        displayName: "Bait",
        stack: state.retainedStack,
      },
    ],
    itemTargets: state.dropped
      ? [
          {
            targetId: DROP_TARGET_ID,
            x: 6,
            y: 5,
            qualifiedItemId: PRODUCT_ITEM_ID,
            displayName: "Bait",
            stack: DROPPED_STACK,
          },
        ]
      : [],
  });
  const advance = (patch) => {
    state.revision += 1;
    Object.assign(state, patch);
    const next = snapshot();
    if (state.client) state.client.state.snapshot = next;
    return next;
  };
  return { state, snapshot, advance };
}

function createClient(mock, overrides = {}) {
  const client = {
    state: { snapshot: mock.snapshot() },
    observe: async () => mock.snapshot(),
    execute: async (request) => {
      if (overrides.execute) return overrides.execute(request, mock, client);
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  mock.state.client = client;
  return client;
}

test("craft partial chain: partial craft -> store retained -> pick dropped remainder", async () => {
  const mock = createMock({ revision: 7, retainedStack: EXISTING_STACK, dropped: false, chestStack: 0 });
  const calls = [];
  const client = createClient(mock, {
    execute: async (request) => {
      calls.push({ action: request.action, args: request.args });
      if (request.action === "craft_item") {
        assert.deepEqual(request.args, { expectedTargetId: "Bait" });
        // The native transaction keeps one (999 cap) and drops four.
        const revision = mock.advance({ retainedStack: EXISTING_STACK + GAINED_STACK, dropped: true }).revision;
        return {
          requestId: request.requestId,
          executionId: "breakpoint-execution",
          state: SOURCE_CRAFT_PARTIAL_STATE,
          reasonCode: SOURCE_CRAFT_REASON,
          revision,
          evidence: { detail: CRAFT_EVIDENCE(SOURCE_PARTIAL_DISPOSITION, GAINED_STACK, DROPPED_STACK) },
        };
      }
      if (request.action === "chest_store") {
        assert.equal(request.args.expectedQualifiedItemId, PRODUCT_ITEM_ID);
        const revision = mock.advance({ retainedStack: 0, chestStack: EXISTING_STACK + GAINED_STACK }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: SOURCE_STORE_REASON,
          revision,
          evidence: { detail: STORE_EVIDENCE(0, EXISTING_STACK + GAINED_STACK) },
        };
      }
      if (request.action === "pickup_item") {
        assert.equal(request.args.expectedQualifiedItemId, PRODUCT_ITEM_ID);
        const revision = mock.advance({ dropped: false }).revision;
        return {
          requestId: request.requestId,
          executionId: "resume-execution",
          state: "succeeded",
          reasonCode: SOURCE_PICKUP_REASON,
          revision,
          evidence: { detail: PICKUP_EVIDENCE(0, DROPPED_STACK) },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  });

  const result = await runCraftPartialRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "passed", `unexpected reason: ${result.reasonCode}`);
  assert.equal(result.reasonCode, SOURCE_PICKUP_REASON);
  assert.equal(result.chain.breakpointReceipt.state, SOURCE_CRAFT_PARTIAL_STATE);
  assert.equal(result.chain.breakpointReceipt.reasonCode, SOURCE_CRAFT_REASON);
  assert.equal(result.chain.recoveryReceipt.reasonCode, SOURCE_STORE_REASON);
  assert.equal(result.chain.resumeReceipt.reasonCode, SOURCE_PICKUP_REASON);
  assert.equal(result.chain.breakpointReceipt.revision < result.chain.recoveryReceipt.revision, true);
  assert.equal(result.chain.recoveryReceipt.revision < result.chain.resumeReceipt.revision, true);
  assert.equal(result.partialDisposition, true);
  assert.equal(result.partialConservation, true);
  assert.equal(result.breakpointHonest, true);
  assert.equal(result.storeConsumed, true);
  assert.equal(result.resumeBound, true);
  assert.equal(result.resumeTargetGone, true);
  assert.equal(result.conserved, true);
  assert.equal(result.sameJournalLineage, true);
  assert.equal(calls.filter((entry) => entry.action === "craft_item").length, 1);
  assert.equal(calls.filter((entry) => entry.action === "chest_store").length, 1);
  assert.equal(calls.filter((entry) => entry.action === "pickup_item").length, 1);
});

test("craft partial chain refuses to claim a partial completion that was never partial", async () => {
  // With room for the whole product the native path reports a FULL success, so the
  // chain has no partial disposition to recover from and must refuse. The declared
  // Given still holds (998 retained) — only the RECIPE OUTCOME is full success.
  const mock = createMock({ revision: 7, retainedStack: EXISTING_STACK, dropped: false, chestStack: 0 });
  const submitted = [];
  const client = createClient(mock, {
    execute: async (request) => {
      submitted.push(request.action);
      const revision = mock.advance({ dropped: true }).revision;
      return {
        requestId: request.requestId,
        executionId: "breakpoint-execution",
        state: "succeeded",
        reasonCode: SOURCE_CRAFT_REASON,
        revision,
        evidence: { detail: CRAFT_EVIDENCE("added_to_inventory", PRODUCED_STACK, 0) },
      };
    },
  });

  const result = await runCraftPartialRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_chain_breakpoint_missing:expected=partially_succeeded/);
  assert.equal(submitted.length, 1);
});

test("craft partial chain fails closed when the dropped remainder was lost", async () => {
  // A chain whose resume leg recovers nothing must never report success: that is
  // exactly the silent-loss failure the partial mode exists to catch.
  const mock = createMock({ revision: 7, retainedStack: EXISTING_STACK, dropped: false, chestStack: 0 });
  const client = createClient(mock, {
    execute: async (request) => {
      if (request.action === "craft_item") {
        const revision = mock.advance({ retainedStack: EXISTING_STACK + GAINED_STACK, dropped: true }).revision;
        return {
          requestId: request.requestId,
          executionId: "breakpoint-execution",
          state: SOURCE_CRAFT_PARTIAL_STATE,
          reasonCode: SOURCE_CRAFT_REASON,
          revision,
          evidence: { detail: CRAFT_EVIDENCE(SOURCE_PARTIAL_DISPOSITION, GAINED_STACK, DROPPED_STACK) },
        };
      }
      if (request.action === "chest_store") {
        const revision = mock.advance({ retainedStack: 0, chestStack: EXISTING_STACK + GAINED_STACK }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: SOURCE_STORE_REASON,
          revision,
          evidence: { detail: STORE_EVIDENCE(0, EXISTING_STACK + GAINED_STACK) },
        };
      }
      if (request.action === "pickup_item") {
        // Claims success but recovered nothing from the ground.
        const revision = mock.advance({ dropped: false }).revision;
        return {
          requestId: request.requestId,
          executionId: "resume-execution",
          state: "succeeded",
          reasonCode: SOURCE_PICKUP_REASON,
          revision,
          evidence: { detail: PICKUP_EVIDENCE(0, 0) },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  });

  const result = await runCraftPartialRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_chain_postcondition_mismatch/);
});

test("craft partial chain refuses a scenario it is not authorized for", async () => {
  const mock = createMock({ revision: 7, retainedStack: EXISTING_STACK, dropped: false, chestStack: 0 });
  const client = createClient(mock);
  const wrongScenario = {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_craft_item_v1" },
  };
  await assert.rejects(
    () => runCraftPartialRecoveryChainSmoke(client, [], wrongScenario),
    /native_local_fixture_config_invalid/,
  );

  const wrongActions = { ...config, EnabledActions: ["move_to_tile", "travel", "craft_item"] };
  await assert.rejects(
    () => runCraftPartialRecoveryChainSmoke(client, [], wrongActions),
    /native_local_craft_partial_action_policy_invalid/,
  );
});

test("craft partial chain's terminals and disposition exist in the Mod source", () => {
  const craft = readFileSync(CRAFT_SOURCE, "utf8");
  const container = readFileSync(CONTAINER_SOURCE, "utf8");
  const controller = readFileSync(CONTROLLER_SOURCE, "utf8");
  const runner = readFileSync(
    new URL("./run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );

  // The partial terminal is real and distinct from the full-success one.
  assert.match(craft, /ExecutionState\.PartiallySucceeded, "crafted_item_created"/);
  assert.match(craft, /ExecutionState\.Succeeded, "crafted_item_created"/);
  // It is reached only after every postcondition held.
  assert.match(craft, /never report a full success/);
  // The disposition vocabulary the runner asserts.
  assert.match(craft, /"partially_dropped_on_ground"/);
  assert.match(craft, /"added_to_inventory"/);
  // The recovery + resume terminals.
  assert.match(container, /ExecutionState\.Succeeded, "chest_stored"/);
  assert.match(controller, /ExecutionState\.Succeeded, "item_picked_up"/);

  // The runner must assert those exact codes and that exact disposition.
  assert.match(runner, /const BREAKPOINT_REASON = "crafted_item_created"/);
  assert.match(runner, /const RECOVERY_REASON = "chest_stored"/);
  assert.match(runner, /const RESUME_REASON = "item_picked_up"/);
  assert.match(runner, /const PARTIAL_DISPOSITION = "partially_dropped_on_ground"/);
  assert.match(runner, /breakpoint\.state !== "partially_succeeded"/);
});

test("craft partial chain reads the recovery slot from the Mod's own storable target", () => {
  const controller = readFileSync(CONTROLLER_SOURCE, "utf8");
  const runner = readFileSync(
    new URL("./run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );

  // The Mod advertises the storable slot through chestStoreTargets (BridgeChestStoreTarget).
  // A runner reading a different field would see no slot and fail closed for the
  // wrong reason. inventoryItemFacts is deliberately NOT used: it is published only
  // for animal-product/inventory-offer capabilities, so it is absent here.
  assert.match(controller, /advertisedCapabilities\.Contains\("chest_store", StringComparer\.Ordinal\) \? DiscoverChestStoreTargets\(player\)/);
  assert.match(runner, /snapshot\.chestStoreTargets/);
  assert.doesNotMatch(runner, /snapshot\.inventoryItemFacts/);
});