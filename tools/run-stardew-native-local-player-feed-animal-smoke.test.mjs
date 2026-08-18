import assert from "node:assert/strict";
import test from "node:test";
import { runFeedAnimalSmoke } from "./run-stardew-native-local-player-feed-animal-smoke.mjs";

const BARN_LOCATION = "Barn3aaaaaaaa-0000-0000-0000-000000000000";
const CAPABILITIES = [
  "cancel_active_execution",
  "inspect_self",
  "move_to_tile",
  "travel",
  "enter_exit",
  "feed_animal",
];
const FARM_WARP = { sourceX: 1, sourceY: 2, targetLocation: "Farm", targetX: 3, targetY: 4 };
const BARN_DOOR = { sourceX: 17, sourceY: 12, targetX: 0, targetY: 0, targetLocation: BARN_LOCATION };
const TARGET = { targetId: "trough_0123456789abcdef", slot: 1, x: 20, y: 19, hayStack: 5 };

function fixtureConfig(overrides = {}) {
  return {
    SaveId: "save",
    WorldId: "world",
    PlayerId: "player",
    CompanionId: "companion",
    PipeName: "pipe",
    BridgeToken: "token",
    ActionPolicyVersion: 0,
    EnabledActions: ["move_to_tile", "travel", "enter_exit", "feed_animal"],
    NativeLocalPlayerFixture: { Enable: true, Bootstrap: { Enable: false }, FixtureScenario: "native_feed_animal_v1" },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

function evidenceDetail(troughFilled = true) {
  return [
    `target=${TARGET.targetId}`,
    `tile=${TARGET.x},${TARGET.y}`,
    `slot=${TARGET.slot}`,
    "native_handled=true",
    `trough_filled=${troughFilled ? "true" : "false"}`,
    "hay_consumed=true",
    `hay_before=${TARGET.hayStack}`,
    `hay_after=${TARGET.hayStack - 1}`,
  ].join(";");
}

function createFake({ startLocation = BARN_LOCATION, capabilities = CAPABILITIES, troughFilled = true } = {}) {
  const listeners = new Set();
  let revision = 1;
  let location = startLocation;
  let tile = { x: 20, y: 20 };
  let warps = startLocation === "FarmHouse" ? [FARM_WARP] : [];
  let doorTargets = location === "Farm" ? [BARN_DOOR] : [];
  let feedTroughTargets = location === BARN_LOCATION ? [TARGET] : [];
  const snapshotOf = () => ({
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities,
    warps,
    doorTargets,
    feedTroughTargets,
  });
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}`;
      const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      if (action === "move_to_tile") {
        if (args.x === 17 && args.y === 13) {
          return {
            requestId,
            executionId: `execution-${action}-rejected`,
            state: "rejected",
            reasonCode: "no_native_path",
            revision,
          };
        }
        revision += 1;
        publish({ ...receipt, state: "succeeded", reasonCode: "target_reached", revision });
        tile = { x: args.x, y: args.y };
        return receipt;
      }
      if (action === "travel") {
        revision += 1;
        publish({ ...receipt, state: "succeeded", reasonCode: "travel_completed", revision });
        location = "Farm";
        tile = { x: 3, y: 4 };
        doorTargets = [BARN_DOOR];
        return receipt;
      }
      if (action === "enter_exit") {
        revision += 1;
        // A stale fact with the wrong executionId must never satisfy the wait.
        publish({ ...receipt, executionId: "stale-execution", state: "succeeded", reasonCode: "enter_exit_completed", revision });
        publish({ ...receipt, state: "succeeded", reasonCode: "enter_exit_completed", revision });
        location = BARN_LOCATION;
        tile = { x: 20, y: 20 };
        doorTargets = [];
        feedTroughTargets = [TARGET];
        return receipt;
      }
      if (action === "feed_animal") {
        revision += 1;
        feedTroughTargets = [];
        return {
          ...receipt,
          state: "succeeded",
          reasonCode: "hay_placed_in_trough",
          revision,
          evidence: { detail: evidenceDetail(troughFilled) },
        };
      }
      throw new Error(`unexpected_action:${action}`);
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return client;
}

function collectReceipts(client) {
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  return receipts;
}

test("feed-animal runner passes when the fixture pre-positions the player inside the AnimalHouse", async () => {
  const client = createFake({ startLocation: BARN_LOCATION });
  const receipts = collectReceipts(client);
  const result = await runFeedAnimalSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "hay_placed_in_trough");
  assert.equal(result.receipt.reasonCode, "hay_placed_in_trough");
  assert.equal(result.enterReceipt, null);
  assert.equal(result.target.targetId, TARGET.targetId);
  assert.equal(result.evidence.trough_filled, "true");
  assert.equal(result.evidence.hay_before, "5");
  assert.equal(result.evidence.hay_after, "4");
  assert.equal(result.after.feedTroughTargets, 0);
  assert.deepEqual(result.trace.map((entry) => entry.phase), ["feed"]);
});

test("feed-animal runner navigates Farm to the SetupBigFarm Deluxe Barn door, enters, and feeds", async () => {
  const client = createFake({ startLocation: "FarmHouse" });
  const receipts = collectReceipts(client);
  const result = await runFeedAnimalSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "hay_placed_in_trough");
  assert.equal(result.enterReceipt.reasonCode, "enter_exit_completed");
  assert.equal(result.after.location, BARN_LOCATION);
  assert.deepEqual(
    result.trace
      .filter((entry) => !entry.phase.endsWith("_terminal") && !entry.phase.endsWith("_rejected"))
      .map((entry) => entry.phase),
    [
      "move_to_farm_warp",
      "travel_to_farm",
      "move_to_animal_house_entry_17_13",
      "move_to_animal_house_entry_16_12",
      "enter_animal_house",
      "feed",
    ],
  );
  assert.deepEqual(
    result.trace.filter((entry) => entry.phase.endsWith("_rejected")).map((entry) => entry.phase),
    ["move_to_animal_house_entry_17_13_rejected"],
  );
});

test("feed-animal runner blocks on a non-isolated capability surface", async () => {
  const client = createFake({ capabilities: ["cancel_active_execution", "inspect_self", "move_to_tile", "enter_exit", "feed_animal"] });
  const receipts = collectReceipts(client);
  const result = await runFeedAnimalSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_capability_surface_mismatch");
  assert.equal(result.trace.length, 0);
});

test("feed-animal runner blocks when native evidence contradicts the postcondition", async () => {
  const client = createFake({ startLocation: BARN_LOCATION, troughFilled: false });
  const receipts = collectReceipts(client);
  const result = await runFeedAnimalSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "feed_animal_postcondition_mismatch");
  assert.equal(result.evidence.trough_filled, "false");
});

test("feed-animal runner rejects a non-isolated topology", async () => {
  const client = createFake();
  await assert.rejects(
    runFeedAnimalSmoke(client, [], fixtureConfig({ Portfolio: { Enable: true } })),
    (error) => error?.message === "native_local_feed_animal_topology_invalid",
  );
});
