import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCraftPartialRecoveryChainSmoke } from "./run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs";

const SCENARIO = "native_craft_item_partial_v1";
const PRODUCT_ITEM_ID = "(O)685";
const EXISTING_STACK = 998;
const PRODUCED_STACK = 5;
const BREAKPOINT_GAINED = 1;
const BREAKPOINT_DROPPED = 4;

// The mock must emit the terminals the Mod ACTUALLY produces, not copies of the
// runner's own constants — otherwise a tandem-but-wrong pair stays green. This is
// the bug class that once shipped an invented `harvest_` target prefix while the
// Mod emitted `crop_<hex16>`, so every real target failed validation and the actor
// circled the map for 152 waypoints. Extract the terminals from the Mod source.
function terminalFromSource(file, anchor, re) {
  const src = readFileSync(file, "utf8");
  const idx = src.indexOf(anchor);
  assert.ok(idx >= 0, `anchor ${JSON.stringify(anchor)} not found in ${file}`);
  const m = src.slice(idx, idx + 700).match(re);
  assert.ok(m, `terminal not matched near ${JSON.stringify(anchor)} in ${file}`);
  return m[1];
}

const CRAFT_SOURCE = fileURLToPath(
  new URL("../integrations/stardew/farmhandexecutioncontroller.craftingactions.cs", import.meta.url),
);
const CONTAINER_SOURCE = fileURLToPath(
  new URL("../integrations/stardew/farmhandexecutioncontroller.containeractions.cs", import.meta.url),
);
const CONTROLLER_SOURCE = fileURLToPath(
  new URL("../integrations/stardew/farmhandexecutioncontroller.cs", import.meta.url),
);

const SOURCE_CRAFT_PARTIAL_STATE = "partially_succeeded";
const SOURCE_CRAFT_REASON = terminalFromSource(
  CRAFT_SOURCE,
  'ExecutionState.PartiallySucceeded, "crafted_item_created"',
  /ExecutionState\.PartiallySucceeded, "(crafted_item_created)"/,
);
const SOURCE_PARTIAL_DISPOSITION = terminalFromSource(
  CRAFT_SOURCE,
  '"partially_dropped_on_ground"',
  /"(partially_dropped_on_ground)"/,
);
const SOURCE_FULL_DISPOSITION = terminalFromSource(CRAFT_SOURCE, '"added_to_inventory"', /"(added_to_inventory)"/);
const SOURCE_STORE_REASON = terminalFromSource(
  CONTAINER_SOURCE,
  'ExecutionState.Succeeded, "chest_stored"',
  /ExecutionState\.Succeeded, "(chest_stored)"/,
);

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: [],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: SCENARIO,
    LogicalSaveName: "GameBuddyFixtureCraftPartial",
    ObservedSaveSlot: "GameBuddyFixtureCraftPartial_1",
  },
};

const CAPABILITIES = ["cancel_active_execution", "chest_store", "craft_item", "inspect_self", "move_to_tile", "travel"];
const CHEST_TARGET_ID = "chest_0123456789abcdef";

// Evidence spellings follow the Mod's format strings exactly.
const CRAFT_EVIDENCE = (disposition, gained, dropped, countBefore, countAfter) =>
  `location=Farm;recipe=Bait;output=${PRODUCT_ITEM_ID};produced_stack=${PRODUCED_STACK};produced_per_craft=${PRODUCED_STACK}` +
  `;disposition=${disposition};inventory_gained_stack=${gained};dropped_stack=${dropped};inventory_accepting_before=false` +
  `;materials_consumed_exactly=true;inventory_postcondition=true;count_before=${countBefore};count_after=${countAfter}` +
  `;count_postcondition=true;ingredients=684=-1;dropped_debris=${dropped > 0 ? 1 : 0};native_menu_opened=false`;
const STORE_EVIDENCE = (chestBefore, chestAfter) =>
  `location=Farm;target=${CHEST_TARGET_ID};tile=5,5;container=chest;item=${PRODUCT_ITEM_ID}` +
  `;player_stack_before=${chestAfter};player_stack_after=0;source_consumed=true` +
  `;chest_stack_before=${chestBefore};chest_stack_after=${chestAfter};native_menu_opened=false`;

/**
 * Mock bridge whose observable revision tracks every terminal revision. Mirrors
 * the measured live sequence: the breakpoint leaves a full backpack, and the
 * native debris homing only delivers the dropped remainder AFTER chest_store
 * frees a slot.
 */
function createMock({ revision, retainedStack, carriedStack, count, chestStack }) {
  const state = { revision, retainedStack, carriedStack, count, chestStack, client: null };
  const snapshot = () => ({
    revision: state.revision,
    location: "Farm",
    tile: { x: 5, y: 6 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    warps: [],
    craftingRecipeTargets: [
      {
        targetId: "Bait",
        // The live Mod publishes the LOCALIZED display name, never the key.
        displayName: "[LocalizedText Strings\\Objects:Bait_Name]",
        ingredientsAvailable: true,
      },
    ],
    chestStoreTargets: [
      {
        targetId: CHEST_TARGET_ID,
        x: 5,
        y: 5,
        slot: state.retainedStack > 0 ? 0 : -1,
        qualifiedItemId: PRODUCT_ITEM_ID,
        displayName: "Bait",
        stack: state.retainedStack + state.carriedStack,
      },
    ],
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

test("craft partial chain: partial craft -> store retained -> same recipe now completes", async () => {
  const mock = createMock({
    revision: 7,
    retainedStack: EXISTING_STACK,
    carriedStack: 0,
    count: 0,
    chestStack: 0,
  });
  const calls = [];
  const client = createClient(mock, {
    execute: async (request) => {
      calls.push({ action: request.action, args: request.args });
      if (request.action === "craft_item") {
        assert.deepEqual(request.args, { expectedTargetId: "Bait" });
        if (calls.filter((entry) => entry.action === "craft_item").length === 1) {
          // Breakpoint: the 999 cap retains one, four leave the backpack, and the
          // backpack stays full so the native debris homing cannot deliver them.
          const revision = mock.advance({ retainedStack: EXISTING_STACK + BREAKPOINT_GAINED, count: PRODUCED_STACK })
            .revision;
          return {
            requestId: request.requestId,
            executionId: "breakpoint-execution",
            state: SOURCE_CRAFT_PARTIAL_STATE,
            reasonCode: SOURCE_CRAFT_REASON,
            revision,
            evidence: {
              detail: CRAFT_EVIDENCE(SOURCE_PARTIAL_DISPOSITION, BREAKPOINT_GAINED, BREAKPOINT_DROPPED, 0, PRODUCED_STACK),
            },
          };
        }
        // Retry: the freed slot lets the product fit completely.
        const revision = mock.advance({ carriedStack: BREAKPOINT_DROPPED + PRODUCED_STACK, count: PRODUCED_STACK * 2 })
          .revision;
        return {
          requestId: request.requestId,
          executionId: "retry-execution",
          state: "succeeded",
          reasonCode: SOURCE_CRAFT_REASON,
          revision,
          evidence: {
            detail: CRAFT_EVIDENCE(
              SOURCE_FULL_DISPOSITION,
              PRODUCED_STACK,
              0,
              PRODUCED_STACK,
              PRODUCED_STACK * 2,
            ),
          },
        };
      }
      if (request.action === "chest_store") {
        assert.equal(request.args.expectedQualifiedItemId, PRODUCT_ITEM_ID);
        // Storing frees the slot; the native homing then delivers the four.
        const revision = mock.advance({
          retainedStack: 0,
          carriedStack: BREAKPOINT_DROPPED,
          chestStack: EXISTING_STACK + BREAKPOINT_GAINED,
        }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: SOURCE_STORE_REASON,
          revision,
          evidence: { detail: STORE_EVIDENCE(0, EXISTING_STACK + BREAKPOINT_GAINED) },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  });

  const result = await runCraftPartialRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "passed", `unexpected reason: ${result.reasonCode}`);
  assert.equal(result.reasonCode, SOURCE_CRAFT_REASON);
  assert.equal(result.chain.breakpointReceipt.state, SOURCE_CRAFT_PARTIAL_STATE);
  assert.equal(result.chain.breakpointReceipt.reasonCode, SOURCE_CRAFT_REASON);
  assert.equal(result.chain.recoveryReceipt.reasonCode, SOURCE_STORE_REASON);
  assert.equal(result.chain.retryReceipt.state, "succeeded");
  assert.equal(result.chain.breakpointReceipt.revision < result.chain.recoveryReceipt.revision, true);
  assert.equal(result.chain.recoveryReceipt.revision < result.chain.retryReceipt.revision, true);
  assert.equal(result.partialDisposition, true);
  assert.equal(result.partialConservation, true);
  assert.equal(result.breakpointHonest, true);
  assert.equal(result.storeConsumed, true);
  assert.equal(result.storeConserved, true);
  assert.equal(result.fullDisposition, true);
  assert.equal(result.retryComplete, true);
  assert.equal(result.conserved, true);
  assert.equal(result.sameJournalLineage, true);
  assert.equal(calls.filter((entry) => entry.action === "craft_item").length, 2);
  assert.equal(calls.filter((entry) => entry.action === "chest_store").length, 1);
});

test("craft partial chain refuses to claim a partial completion that was never partial", async () => {
  // If the native path reports a FULL success at the breakpoint there is no partial
  // disposition to recover from, so the chain must refuse rather than treat it as
  // one. The declared Given still holds (998 retained) — only the outcome differs.
  const mock = createMock({
    revision: 7,
    retainedStack: EXISTING_STACK,
    carriedStack: 0,
    count: 0,
    chestStack: 0,
  });
  const submitted = [];
  const client = createClient(mock, {
    execute: async (request) => {
      submitted.push(request.action);
      const revision = mock.advance({ retainedStack: EXISTING_STACK + PRODUCED_STACK, count: PRODUCED_STACK }).revision;
      return {
        requestId: request.requestId,
        executionId: "breakpoint-execution",
        state: "succeeded",
        reasonCode: SOURCE_CRAFT_REASON,
        revision,
        evidence: { detail: CRAFT_EVIDENCE(SOURCE_FULL_DISPOSITION, PRODUCED_STACK, 0, 0, PRODUCED_STACK) },
      };
    },
  });

  const result = await runCraftPartialRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_chain_breakpoint_missing:expected=partially_succeeded/);
  assert.equal(submitted.length, 1);
});

test("craft partial chain fails closed when the drop has no debris chunk behind it", async () => {
  // The Mod's own guard is droppedToGround = droppedStack == 0 || debrisAfter ==
  // debrisBefore + 1 (craftingactions.cs). A receipt that reports a partial drop
  // while no debris chunk appeared would have been Uncertain in the Mod, so the
  // chain must refuse to treat its numbers as an honest partial completion.
  const mock = createMock({
    revision: 7,
    retainedStack: EXISTING_STACK,
    carriedStack: 0,
    count: 0,
    chestStack: 0,
  });
  const client = createClient(mock, {
    execute: async (request) => {
      const revision = mock.advance({}).revision;
      return {
        requestId: request.requestId,
        executionId: "breakpoint-execution",
        state: SOURCE_CRAFT_PARTIAL_STATE,
        reasonCode: SOURCE_CRAFT_REASON,
        revision,
        evidence: {
          detail: CRAFT_EVIDENCE(SOURCE_PARTIAL_DISPOSITION, BREAKPOINT_GAINED, PRODUCED_STACK - BREAKPOINT_GAINED, 0, PRODUCED_STACK).replace(
            ";dropped_debris=1",
            ";dropped_debris=0",
          ),
        },
      };
    },
  });

  const result = await runCraftPartialRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_chain_breakpoint_postcondition_mismatch/);
});

test("craft partial chain fails closed when the retained stack does not add up", async () => {
  // The receipt claims a partial drop but its own numbers contradict it. A chain
  // that accepted this would report a completion the Mod never established.
  const mock = createMock({
    revision: 7,
    retainedStack: EXISTING_STACK,
    carriedStack: 0,
    count: 0,
    chestStack: 0,
  });
  const client = createClient(mock, {
    execute: async (request) => {
      const revision = mock.advance({}).revision;
      return {
        requestId: request.requestId,
        executionId: "breakpoint-execution",
        state: SOURCE_CRAFT_PARTIAL_STATE,
        reasonCode: SOURCE_CRAFT_REASON,
        revision,
        // gained 1 + dropped 4 != produced 5
        evidence: { detail: CRAFT_EVIDENCE(SOURCE_PARTIAL_DISPOSITION, BREAKPOINT_GAINED, 9, 0, PRODUCED_STACK) },
      };
    },
  });

  const result = await runCraftPartialRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_chain_breakpoint_conservation_mismatch/);
});

test("craft partial chain fails closed when the chest did not receive the retained stack", async () => {
  const mock = createMock({
    revision: 7,
    retainedStack: EXISTING_STACK,
    carriedStack: 0,
    count: 0,
    chestStack: 0,
  });
  const client = createClient(mock, {
    execute: async (request) => {
      if (request.action === "craft_item") {
        const revision = mock.advance({ retainedStack: EXISTING_STACK + BREAKPOINT_GAINED, count: PRODUCED_STACK })
          .revision;
        return {
          requestId: request.requestId,
          executionId: "breakpoint-execution",
          state: SOURCE_CRAFT_PARTIAL_STATE,
          reasonCode: SOURCE_CRAFT_REASON,
          revision,
          evidence: {
            detail: CRAFT_EVIDENCE(SOURCE_PARTIAL_DISPOSITION, BREAKPOINT_GAINED, BREAKPOINT_DROPPED, 0, PRODUCED_STACK),
          },
        };
      }
      if (request.action === "chest_store") {
        // Claims success but the chest only got part of the stack.
        const revision = mock.advance({ retainedStack: 0, chestStack: 100 }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: SOURCE_STORE_REASON,
          revision,
          evidence: { detail: STORE_EVIDENCE(0, 100) },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  });

  const result = await runCraftPartialRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_store_conservation_mismatch/);
});

test("craft partial chain refuses a scenario it is not authorized for", async () => {
  const mock = createMock({
    revision: 7,
    retainedStack: EXISTING_STACK,
    carriedStack: 0,
    count: 0,
    chestStack: 0,
  });
  const client = createClient(mock);
  const wrongScenario = {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_craft_item_v1" },
  };
  await assert.rejects(
    () => runCraftPartialRecoveryChainSmoke(client, [], wrongScenario),
    /native_local_fixture_config_invalid/,
  );

  const wrongActions = { ...config, DeniedActions: ["craft_item"] };
  await assert.rejects(
    () => runCraftPartialRecoveryChainSmoke(client, [], wrongActions),
    /native_fixture_policy_denies_required/,
  );
});

test("craft partial chain declares every module-scope constant the main path uses before it runs", () => {
  // The live gate caught this: the `if (import.meta.main)` block executes during
  // module evaluation, so a `const` referenced by the chain but declared BELOW it is
  // still in its temporal dead zone and throws "Cannot access before initialization".
  // Importing the module (which every other test here does) cannot catch that, because
  // the functions only run after the whole module has evaluated.
  const source = readFileSync(
    new URL("./run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );
  const mainIndex = source.indexOf("if (import.meta.main)");
  assert.ok(mainIndex > 0, "runner must expose an import.meta.main entrypoint");
  for (const name of ["CRAFT_EVIDENCE_KEYS", "RECIPE_ALIAS", "PRODUCT_ITEM_ID", "SCENARIO", "PARTIAL_DISPOSITION"]) {
    const declIndex = source.search(new RegExp(`const ${name}\\b`));
    assert.ok(declIndex > 0, `${name} must be a module-scope const`);
    assert.ok(declIndex < mainIndex, `${name} must be declared before the import.meta.main block executes`);
  }
});

test("craft partial chain's terminals and dispositions exist in the Mod source", () => {
  const craft = readFileSync(CRAFT_SOURCE, "utf8");
  const container = readFileSync(CONTAINER_SOURCE, "utf8");
  const runner = readFileSync(
    new URL("./run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );

  // The partial terminal is real and distinct from the full-success one.
  assert.match(craft, /ExecutionState\.PartiallySucceeded, "crafted_item_created"/);
  assert.match(craft, /ExecutionState\.Succeeded, "crafted_item_created"/);
  // It is reached only after the Mod's own postconditions held.
  assert.match(craft, /never report a full success/);
  // The disposition vocabulary the runner asserts.
  assert.match(craft, /"partially_dropped_on_ground"/);
  assert.match(craft, /"added_to_inventory"/);
  // The recovery terminal.
  assert.match(container, /ExecutionState\.Succeeded, "chest_stored"/);

  // The runner must assert those exact codes, that partial disposition, and the
  // full-success disposition the retry must reach.
  assert.match(runner, /const BREAKPOINT_REASON = "crafted_item_created"/);
  assert.match(runner, /const RECOVERY_REASON = "chest_stored"/);
  assert.match(runner, /const RETRY_REASON = "crafted_item_created"/);
  assert.match(runner, /const PARTIAL_DISPOSITION = "partially_dropped_on_ground"/);
  assert.match(runner, /const FULL_DISPOSITION = "added_to_inventory"/);
  assert.match(runner, /breakpoint\.state !== "partially_succeeded"/);
});

test("craft partial chain selects the recipe by its WIRE IDENTITY, not its localized display name", () => {
  // The live gate caught this: the Mod publishes `BridgeRecipeTarget(wireIdentity,
  // recipe.DisplayName, …)`, and the display name is LOCALIZED (the content data row
  // for Bait carries "[LocalizedText Strings\\Objects:Bait_Name]"). A runner matching
  // on displayName found nothing even though the recipe was advertised.
  const craft = readFileSync(CRAFT_SOURCE, "utf8");
  const runner = readFileSync(
    new URL("./run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    craft,
    /new BridgeRecipeTarget\(wireIdentity, recipe\.DisplayName, recipe\.doesFarmerHaveIngredientsInInventory\(\)\)/,
  );
  // The wire identity is what the action itself resolves back to the live key.
  assert.match(craft, /TryBuildWireRecipeIdentity\(table\.Keys, recipeKey\)/);
  assert.match(runner, /target\.targetId === RECIPE_ALIAS/);
  assert.doesNotMatch(runner, /displayName\.toLowerCase\(\) === RECIPE_ALIAS/);
});

test("craft partial chain reads the retained stack from the Mod's own storable target", () => {
  const controller = readFileSync(CONTROLLER_SOURCE, "utf8");
  const runner = readFileSync(
    new URL("./run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );

  // The Mod advertises the storable slot through chestStoreTargets
  // (BridgeChestStoreTarget). inventoryItemFacts is deliberately NOT used: it is
  // published only for animal-product/inventory-offer capabilities, so it is absent
  // here and would silently read zero.
  assert.match(
    controller,
    /advertisedCapabilities\.Contains\("chest_store", StringComparer\.Ordinal\) \? DiscoverChestStoreTargets\(player\)/,
  );
  assert.match(runner, /snapshot\.chestStoreTargets/);
  assert.doesNotMatch(runner, /snapshot\.inventoryItemFacts/);
});

test("craft partial chain does not claim the native debris homing as its own pickup", () => {
  // Measured live: after chest_store frees a slot, `Debris.updateChunks` homes the
  // dropped remainder onto the farmer and collects it (`Debris.cs` gates the homing
  // on `farmer.couldInventoryAcceptThisItem(this.item)`), so an explicit `pickup_item`
  // either loses the race (no_native_path mid-bounce) or finds no target at all.
  // The runner must therefore NOT submit a pickup and must prove completion by
  // conservation instead.
  const runner = readFileSync(
    new URL("./run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(runner, /"pickup_item"/);
  assert.doesNotMatch(runner, /itemTargets/);
  assert.match(runner, /recovery_chain_conservation_mismatch/);
});
