import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runStaminaRecoveryChainSmoke } from "./run-stardew-native-local-player-stamina-recovery-chain-smoke.mjs";

const SCENARIO = "native_stamina_recovery_v1";
const SOIL_BREAKPOINT = { x: 62, y: 18 };
const SOIL_RESUME = { x: 64, y: 18 };
const FOOD = { slot: 5, qualifiedItemId: "(O)216" };

// The mock must emit the terminals the Mod ACTUALLY produces, not copies of the
// runner's own constants — otherwise a tandem-but-wrong pair stays green (the bug
// class that shipped an invented `harvest_` target prefix once). Extract the three
// terminal reason codes from the Mod source directly.
function terminalFromSource(file, anchor, re) {
  const src = readFileSync(file, "utf8");
  const idx = src.indexOf(anchor);
  assert.ok(idx >= 0, `anchor ${JSON.stringify(anchor)} not found in ${file}`);
  const m = src.slice(idx, idx + 400).match(re);
  assert.ok(m, `terminal not matched near ${JSON.stringify(anchor)} in ${file}`);
  return m[1];
}

const TILL_SOURCE = fileURLToPath(new URL("../integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs", import.meta.url));
const ITEM_SOURCE = fileURLToPath(new URL("../integrations/stardew/farmhandexecutioncontroller.cs", import.meta.url));

/** The Mod's till_soil success terminal (unique in source). */
const SOURCE_TILL_REASON = terminalFromSource(
  TILL_SOURCE,
  "tilled ? \"",
  /tilled \? "([a-z_]+)" : "soil_postcondition_unavailable"/,
);
/** The Mod's use_item success terminal (unique in source). */
const SOURCE_ITEM_REASON = terminalFromSource(
  ITEM_SOURCE,
  "ExecutionState.Succeeded, \"item_used\"",
  /ExecutionState\.Succeeded, "(item_used)"/,
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
    LogicalSaveName: "GameBuddyFixtureStamina",
    ObservedSaveSlot: "GameBuddyFixtureStamina_1",
  },
};

const CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "till_soil",
  "travel",
  "use_item",
];

// Field spellings follow the Mod's evidence strings exactly:
//   till_soil -> location/target/before/after/stamina_before/after/delta/expected_stamina_cost
//   use_item  -> slot/item/stack_before/stack_after/edibility/drink/stamina_before/after/animation_complete
const TILL_EVIDENCE = (x, y, before, after) =>
  `location=Farm;target=${x},${y};before=none;after=HoeDirt;stamina_before=${before};stamina_after=${after};stamina_delta=${after - before};expected_stamina_cost=2`;
const EAT_EVIDENCE = (before, after) =>
  `slot=${FOOD.slot};item=${FOOD.qualifiedItemId};stack_before=1;stack_after=0;edibility=25;drink=false;stamina_before=${before};stamina_after=${after};animation_complete=true`;

/** Mock bridge whose observable revision tracks every terminal revision. */
function createMock({ revision, stamina, breakpointSoil, resumeSoil }) {
  const state = { revision, stamina, breakpointSoil, resumeSoil, client: null };
  const snapshot = () => ({
    revision: state.revision,
    location: "Farm",
    tile: { x: 63, y: 19 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    warps: [],
    currentTool: "Hoe",
    toolSlots: [{ slot: 0, label: "Hoe" }],
    stamina: state.stamina,
    soilTiles: [
      ...(state.breakpointSoil ? [{ ...SOIL_BREAKPOINT }] : []),
      ...(state.resumeSoil ? [{ ...SOIL_RESUME }] : []),
    ],
    foodTargets: [{ slot: FOOD.slot, qualifiedItemId: FOOD.qualifiedItemId, displayName: "Bread", stack: 1, edibility: 25, isDrink: false }],
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

test("stamina chain: low-stamina till -> eat -> resume till succeeds", async () => {
  const mock = createMock({ revision: 5, stamina: 12, breakpointSoil: true, resumeSoil: true });
  const calls = [];
  const client = createClient(mock, {
    execute: async (request) => {
      calls.push({ action: request.action, args: request.args });
      if (request.action === "equip_tool") {
        const revision = mock.advance({}).revision;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "already_equipped",
          revision,
          evidence: { detail: "after=Hoe;before=Hoe;expected=Hoe;tool=hoe" },
        };
      }
      if (request.action === "till_soil") {
        if (request.args.x === SOIL_BREAKPOINT.x && request.args.y === SOIL_BREAKPOINT.y) {
          // Breakpoint: the receipt itself carries the stamina drop.
          const revision = mock.advance({ breakpointSoil: false, stamina: 10 }).revision;
          return {
            requestId: request.requestId,
            executionId: "breakpoint-execution",
            state: "succeeded",
            reasonCode: SOURCE_TILL_REASON,
            revision,
            evidence: { detail: TILL_EVIDENCE(SOIL_BREAKPOINT.x, SOIL_BREAKPOINT.y, 12, 10) },
          };
        }
        const revision = mock.advance({ resumeSoil: false, stamina: 37 }).revision;
        return {
          requestId: request.requestId,
          executionId: "resume-execution",
          state: "succeeded",
          reasonCode: SOURCE_TILL_REASON,
          revision,
          evidence: { detail: TILL_EVIDENCE(SOIL_RESUME.x, SOIL_RESUME.y, 39, 37) },
        };
      }
      if (request.action === "use_item") {
        assert.deepEqual(request.args, { slot: FOOD.slot, expectedQualifiedItemId: FOOD.qualifiedItemId });
        const revision = mock.advance({ stamina: 39 }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: SOURCE_ITEM_REASON,
          revision,
          evidence: { detail: EAT_EVIDENCE(10, 39) },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  });

  const result = await runStaminaRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "passed", `unexpected reason: ${result.reasonCode}`);
  assert.equal(result.reasonCode, SOURCE_TILL_REASON);
  assert.equal(result.chain.breakpointReceipt.reasonCode, SOURCE_TILL_REASON);
  assert.equal(result.chain.recoveryReceipt.reasonCode, SOURCE_ITEM_REASON);
  assert.equal(result.chain.resumeReceipt.reasonCode, SOURCE_TILL_REASON);
  assert.equal(result.chain.breakpointReceipt.revision < result.chain.recoveryReceipt.revision, true);
  assert.equal(result.chain.recoveryReceipt.revision < result.chain.resumeReceipt.revision, true);
  assert.equal(result.staminaDropped, true);
  assert.equal(result.foodConsumed, true);
  assert.equal(result.staminaRestored, true);
  assert.equal(result.resumeTargetGone, true);
  assert.equal(result.sameJournalLineage, true);
  // One till, one eat, one resume till.
  assert.equal(calls.filter((entry) => entry.action === "till_soil").length, 2);
  assert.equal(calls.filter((entry) => entry.action === "use_item").length, 1);
});

test("stamina chain fails closed when the given stamina is not low", async () => {
  // A chain whose breakpoint never happened proves nothing: with full stamina there
  // is nothing to recover from, so the runner must refuse before submitting anything.
  const mock = createMock({ revision: 5, stamina: 270, breakpointSoil: true, resumeSoil: true });
  const submitted = [];
  const client = createClient(mock, {
    execute: async (request) => {
      submitted.push(request.action);
      throw new Error("no_request_may_be_submitted_when_stamina_is_not_low");
    },
  });

  const result = await runStaminaRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_chain_breakpoint_unavailable_stamina_not_low/);
  assert.deepEqual(submitted, []);
});

test("stamina chain refuses to run below the native pass-out floor", async () => {
  // Game1.cs:6452 starts a pass-out at stamina <= -15. A fixture that put the actor
  // there would exercise the pass-out lifecycle, not this recovery chain.
  const mock = createMock({ revision: 5, stamina: -16, breakpointSoil: true, resumeSoil: true });
  const submitted = [];
  const client = createClient(mock, {
    execute: async (request) => {
      submitted.push(request.action);
      throw new Error("no_request_may_be_submitted_below_the_pass_out_floor");
    },
  });

  const result = await runStaminaRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_chain_breakpoint_unavailable_below_pass_out_floor/);
  assert.deepEqual(submitted, []);
});

test("stamina chain does not claim success when the eating restored nothing", async () => {
  const mock = createMock({ revision: 5, stamina: 12, breakpointSoil: true, resumeSoil: true });
  const client = createClient(mock, {
    execute: async (request) => {
      if (request.action === "equip_tool") {
        const revision = mock.advance({}).revision;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "already_equipped",
          revision,
          evidence: { detail: "after=Hoe;before=Hoe;expected=Hoe;tool=hoe" },
        };
      }
      if (request.action === "till_soil") {
        const revision = mock.advance({ breakpointSoil: false, stamina: 10 }).revision;
        return {
          requestId: request.requestId,
          executionId: "breakpoint-execution",
          state: "succeeded",
          reasonCode: SOURCE_TILL_REASON,
          revision,
          evidence: { detail: TILL_EVIDENCE(SOIL_BREAKPOINT.x, SOIL_BREAKPOINT.y, 12, 10) },
        };
      }
      if (request.action === "use_item") {
        // The receipt claims success but the stamina never rose.
        const revision = mock.advance({ stamina: 10 }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: SOURCE_ITEM_REASON,
          revision,
          evidence: { detail: EAT_EVIDENCE(10, 10) },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  });

  const result = await runStaminaRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_use_item_stamina_not_restored/);
});

test("stamina chain refuses a scenario it is not authorized for", async () => {
  const mock = createMock({ revision: 5, stamina: 12, breakpointSoil: true, resumeSoil: true });
  const client = createClient(mock);
  const wrongScenario = {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_till_soil_v1" },
  };
  await assert.rejects(
    () => runStaminaRecoveryChainSmoke(client, [], wrongScenario),
    /native_local_fixture_config_invalid/,
  );

  const wrongActions = { ...config, DeniedActions: ["till_soil"] };
  await assert.rejects(
    () => runStaminaRecoveryChainSmoke(client, [], wrongActions),
    /native_fixture_policy_denies_required/,
  );
});

// A mock shares the runner's own expectations, so it can never catch a drift between
// the runner and the Mod. The previous chain shipped with an invented `harvest_`
// target-id prefix while the Mod emits `crop_<hex16>`; every real target then failed
// validation and the actor circled the map for 152 waypoints. These pins read the Mod
// source itself.
test("stamina chain's evidence keys and reason codes exist in the Mod source", () => {
  const tillSoil = readFileSync(
    new URL("../integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs", import.meta.url),
    "utf8",
  );
  const itemUse = readFileSync(new URL("../integrations/stardew/farmhandexecutioncontroller.cs", import.meta.url), "utf8");
  const runner = readFileSync(
    new URL("./run-stardew-native-local-player-stamina-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );

  // The breakpoint and resume terminals.
  assert.match(tillSoil, /"soil_tilled"/);
  assert.match(tillSoil, /stamina_before=\{staminaBefore/);
  assert.match(tillSoil, /stamina_after=\{staminaAfter/);
  assert.match(tillSoil, /expected_stamina_cost=/);
  assert.match(tillSoil, /before=\{before\};after=\{/);

  // The recovery terminal and the evidence the runner parses.
  assert.match(itemUse, /"item_used"/);
  assert.match(itemUse, /animation_complete=true/);
  assert.match(itemUse, /stack_before=\{specification\.StackBefore\}/);
  assert.match(itemUse, /stack_after=/);
  assert.match(itemUse, /edibility=\{specification\.Edibility\}/);
  assert.match(itemUse, /drink=\{specification\.IsDrink/);

  // The runner must assert those exact reason codes.
  assert.match(runner, /BREAKPOINT_REASON = "soil_tilled"/);
  assert.match(runner, /RECOVERY_REASON = "item_used"/);
  assert.match(runner, /RESUME_REASON = "soil_tilled"/);
});

test("stamina chain reads edibles from the Mod's real food target field", () => {
  const controller = readFileSync(
    new URL("../integrations/stardew/farmhandexecutioncontroller.cs", import.meta.url),
    "utf8",
  );
  const models = readFileSync(
    new URL("../integrations/stardew/src/Core/Models/BridgeProtocolModels.cs", import.meta.url),
    "utf8",
  );
  const runner = readFileSync(
    new URL("./run-stardew-native-local-player-stamina-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );

  // The Mod advertises edibles under FoodTargets (record BridgeFoodTarget), gated on
  // the `use_item` capability. A runner reading a differently-named field would see
  // no food and fail closed for the wrong reason.
  assert.match(controller, /advertisedCapabilities\.Contains\("use_item", StringComparer\.Ordinal\) \? DiscoverFoodTargets\(player\)/);
  assert.match(models, /record BridgeFoodTarget\(int Slot, string QualifiedItemId, string DisplayName, int Stack, int Edibility, bool IsDrink\)/);
  assert.match(runner, /snapshot\.foodTargets/);
  assert.doesNotMatch(runner, /snapshot\.inventoryItemFacts/);
});
