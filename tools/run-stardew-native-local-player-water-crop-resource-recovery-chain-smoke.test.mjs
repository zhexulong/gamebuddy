import assert from "node:assert/strict";
import test from "node:test";
import { runWaterCropResourceRecoveryChainSmoke } from "./run-stardew-native-local-player-water-crop-resource-recovery-chain-smoke.mjs";

const SCENARIO = "native_water_crop_empty_can_recovery_v1";
const CAN = { slot: 3, label: "Watering Can", qualifiedItemId: "(T)WateringCan" };
const CROP = { targetId: "crop_0000000000000001", x: 62, y: 18, cropId: "(O)472", displayName: "Parsnip" };
const REFILL = { targetId: "watering_can_refill_0000000000000001", x: 61, y: 18 };

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
    LogicalSaveName: "GameBuddyFixtureEmptyCan",
    ObservedSaveSlot: "GameBuddyFixtureEmptyCan_1",
  },
};

const CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "refill_watering_can",
  "travel",
  "water_crop",
];

const WATER_EVIDENCE =
  "after_watered=true;before_watered=false;expected_stamina_cost=2;location=Farm;stamina_after=98;stamina_before=100;stamina_delta=-2;target=crop_0000000000000001;tile=62,18;water_after=39;water_before=40;water_consumed=true";
const REFILL_EVIDENCE =
  "expected_stamina_cost=0;slot=3;stamina_after=100;stamina_before=100;stamina_delta=0;target=watering_can_refill_0000000000000001;water_after=40;water_before=0;water_max=40";
const EQUIP_EVIDENCE = "after=Watering Can;before=Watering Can;expected=Watering Can;tool=watering_can";

/**
 * Mock bridge whose observable snapshot revision tracks every terminal revision.
 * A mock that advanced the receipt revision without advancing the observation
 * would deadlock the runner's `minRevision` reread waits rather than exercise
 * them, which is exactly the failure this harness must not hide.
 */
function createMock({ revision, water, cropPresent, refillPresent = true }) {
  const state = {
    revision,
    water,
    cropPresent,
    refillPresent,
    client: null,
  };
  const snapshot = () => ({
    revision: state.revision,
    location: "Farm",
    tile: { x: 62, y: 19 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    warps: [],
    toolSlots: [{ slot: CAN.slot, label: CAN.label }],
    currentTool: CAN.label,
    wateringCanFacts: [
      {
        slot: CAN.slot,
        qualifiedItemId: CAN.qualifiedItemId,
        displayName: CAN.label,
        label: CAN.label,
        water: state.water,
        max: 40,
      },
    ],
    refillWateringCanTargets: state.refillPresent ? [{ ...REFILL }] : [],
    cropTargets: state.cropPresent ? [{ ...CROP }] : [],
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

test("resource-depletion chain: reject -> refill -> same-target retry succeeds", async () => {
  const mock = createMock({ revision: 5, water: 0, cropPresent: true });
  const calls = [];
  const client = {
    state: { snapshot: mock.snapshot() },
    observe: async () => mock.snapshot(),
    execute: async (request) => {
      calls.push({ action: request.action, args: request.args });
      if (request.action === "equip_tool") {
        // The fixture supplies the can already equipped, but the runner equips
        // explicitly; that equip is its own receipt, not part of the triplet.
        const revision = mock.advance({}).revision;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "already_equipped",
          revision,
          evidence: { detail: EQUIP_EVIDENCE },
        };
      }
      if (request.action === "water_crop") {
        if (mock.state.water === 0) {
          // Breakpoint: deterministic rejection, no mutation.
          const revision = mock.advance({}).revision;
          return {
            requestId: request.requestId,
            executionId: "bp-execution",
            state: "rejected",
            reasonCode: "watering_can_empty",
            revision,
            evidence: { detail: "reason=watering_can_empty" },
          };
        }
        // Retry after recovery -> success, crop leaves discovery.
        const revision = mock.advance({ water: mock.state.water - 1, cropPresent: false }).revision;
        return {
          requestId: request.requestId,
          executionId: "retry-execution",
          state: "succeeded",
          reasonCode: "crop_watered",
          revision,
          evidence: { detail: WATER_EVIDENCE },
        };
      }
      if (request.action === "refill_watering_can") {
        assert.deepEqual(request.args, {
          slot: CAN.slot,
          x: REFILL.x,
          y: REFILL.y,
          expectedTargetId: REFILL.targetId,
        });
        const revision = mock.advance({ water: 40 }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: "watering_can_refilled",
          revision,
          evidence: { detail: REFILL_EVIDENCE },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  mock.state.client = client;

  const result = await runWaterCropResourceRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "passed", `unexpected reason: ${result.reasonCode}`);
  assert.equal(result.reasonCode, "crop_watered");
  assert.equal(result.chain.breakpointReceipt.reasonCode, "watering_can_empty");
  assert.equal(result.chain.recoveryReceipt.reasonCode, "watering_can_refilled");
  assert.equal(result.chain.retryReceipt.reasonCode, "crop_watered");
  assert.equal(result.chain.breakpointReceipt.revision < result.chain.recoveryReceipt.revision, true);
  assert.equal(result.chain.recoveryReceipt.revision < result.chain.retryReceipt.revision, true);
  assert.equal(result.sameJournalLineage, true);
  assert.equal(result.freshTargetGone, true);
  assert.equal(result.refillRefilled, true);
  // The chain must actually submit water_crop twice (breakpoint + retry).
  assert.equal(calls.filter((entry) => entry.action === "water_crop").length, 2);
  assert.equal(calls.filter((entry) => entry.action === "refill_watering_can").length, 1);
});

test("resource-depletion chain fails closed when the supplied can is not empty", async () => {
  // Without an empty can there is no breakpoint, and a "recovery" with no
  // rejection proves nothing. The runner must refuse before submitting anything.
  const mock = createMock({ revision: 5, water: 40, cropPresent: true });
  const submitted = [];
  const client = {
    state: { snapshot: mock.snapshot() },
    observe: async () => mock.snapshot(),
    execute: async (request) => {
      submitted.push(request.action);
      throw new Error("no_request_may_be_submitted_without_an_empty_can");
    },
  };

  const result = await runWaterCropResourceRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "recovery_chain_breakpoint_unavailable_can_not_empty");
  assert.deepEqual(submitted, []);
});

test("resource-depletion chain does not claim success when the retry postcondition is absent", async () => {
  const mock = createMock({ revision: 5, water: 0, cropPresent: true });
  const client = {
    state: { snapshot: mock.snapshot() },
    observe: async () => mock.snapshot(),
    execute: async (request) => {
      if (request.action === "equip_tool") {
        const revision = mock.advance({}).revision;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "already_equipped",
          revision,
          evidence: { detail: EQUIP_EVIDENCE },
        };
      }
      if (request.action === "water_crop") {
        if (mock.state.water === 0) {
          const revision = mock.advance({}).revision;
          return {
            requestId: request.requestId,
            executionId: "bp-execution",
            state: "rejected",
            reasonCode: "watering_can_empty",
            revision,
            evidence: { detail: "reason=watering_can_empty" },
          };
        }
        // The native call ran but the crop did not flip and the target stays
        // advertised, so the fresh postcondition cannot hold.
        const revision = mock.advance({ water: mock.state.water - 1 }).revision;
        return {
          requestId: request.requestId,
          executionId: "retry-execution",
          state: "uncertain",
          reasonCode: "crop_water_postcondition_unavailable",
          revision,
          evidence: { detail: WATER_EVIDENCE.replace("after_watered=true", "after_watered=false") },
        };
      }
      if (request.action === "refill_watering_can") {
        const revision = mock.advance({ water: 40 }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: "watering_can_refilled",
          revision,
          evidence: { detail: REFILL_EVIDENCE },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  mock.state.client = client;

  const result = await runWaterCropResourceRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /retry_water_failed/);
});

test("resource-depletion chain refuses a recovery that reports no refill", async () => {
  // The refill terminal claims success but the can never reached its max. The
  // chain must not accept a recovery receipt whose own evidence contradicts it.
  const mock = createMock({ revision: 5, water: 0, cropPresent: true });
  const client = {
    state: { snapshot: mock.snapshot() },
    observe: async () => mock.snapshot(),
    execute: async (request) => {
      if (request.action === "equip_tool") {
        const revision = mock.advance({}).revision;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "already_equipped",
          revision,
          evidence: { detail: EQUIP_EVIDENCE },
        };
      }
      if (request.action === "water_crop") {
        const revision = mock.advance({}).revision;
        return {
          requestId: request.requestId,
          executionId: "bp-execution",
          state: "rejected",
          reasonCode: "watering_can_empty",
          revision,
          evidence: { detail: "reason=watering_can_empty" },
        };
      }
      if (request.action === "refill_watering_can") {
        // Still empty: water_before == water_after == 0, max 40.
        const revision = mock.advance({}).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: "watering_can_refilled",
          revision,
          evidence: { detail: REFILL_EVIDENCE.replace("water_before=0", "water_before=0").replace("water_after=40", "water_after=0") },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  mock.state.client = client;

  const result = await runWaterCropResourceRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "recovery_refill_postcondition_mismatch");
});

test("resource-depletion chain rejects a scenario it is not authorized for", async () => {
  const mock = createMock({ revision: 5, water: 0, cropPresent: true });
  const client = { state: { snapshot: mock.snapshot() }, observe: async () => mock.snapshot() };
  const wrongScenario = {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_water_crop_v1" },
  };
  await assert.rejects(
    () => runWaterCropResourceRecoveryChainSmoke(client, [], wrongScenario),
    /native_local_fixture_config_invalid/,
  );

  const wrongActions = { ...config, DeniedActions: ["refill_watering_can"] };
  await assert.rejects(
    () => runWaterCropResourceRecoveryChainSmoke(client, [], wrongActions),
    /native_fixture_policy_denies_required/,
  );
});
