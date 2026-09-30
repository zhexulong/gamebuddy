import assert from "node:assert/strict";
import test from "node:test";
import { runPetAnimalSmoke } from "./run-stardew-native-local-player-pet-animal-smoke.mjs";

const target = {
  targetId: "pet_0123456789abcdef",
  x: 2,
  y: 1,
  petType: "Dog",
  friendship: 0,
  pettedToday: false,
};

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  // The fixture writes the derived deny-by-exception block. `pet_animal` is
  // live-verified, so it needs no opt-in.
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: [],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_pet_animal_v1",
    LogicalSaveName: "GameBuddyFixturePet",
    ObservedSaveSlot: "GameBuddyFixturePet_1",
  },
};

test("pet-animal runner uses shared dispatch, exact terminal correlation, and fresh target disappearance", async () => {
  let snapshot = {
    revision: 1,
    location: "Farm",
    tile: { x: 1, y: 1 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "inspect_self", "pet_animal"],
    petTargets: [target],
  };
  const receipts = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      assert.equal(request.action, "pet_animal");
      assert.equal(request.expectedRevision, 1);
      assert.deepEqual(request.args, { x: 2, y: 1, expectedTargetId: "pet_0123456789abcdef" });
      snapshot = {
        ...snapshot,
        revision: 2,
        petTargets: [],
      };
      client.state.snapshot = snapshot;
      const accepted = {
        requestId: request.requestId,
        executionId: "pet-execution",
        state: "accepted",
        reasonCode: "accepted",
        revision: 2,
      };
      receipts.push({
        ...accepted,
        state: "succeeded",
        reasonCode: "pet_completed",
        evidence: {
          detail:
            "day_recorded=true;friendship_after=12;friendship_before=0;friendship_callback=true;location=Farm;pet_day=1;target=pet_0123456789abcdef;tile=2,1",
        },
      });
      return accepted;
    },
  };
  const result = await runPetAnimalSmoke(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "pet_completed");
  assert.equal(result.receipt.reasonCode, "pet_completed");
  assert.equal(result.freshPostcondition.targetGone, true);
});

test("pet-animal runner rejects an incomplete native-local capability surface", async () => {
  const client = {
    state: { snapshot: null },
    observe: async () => ({
      revision: 1,
      location: "Farm",
      tile: { x: 1, y: 1 },
      actionable: true,
      activeExecution: null,
      capabilities: ["cancel_active_execution", "pet_animal"],
      petTargets: [],
    }),
  };
  const result = await runPetAnimalSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.equal(result.topology, "native_local_player_fixture");
  assert.match(result.reasonCode, /native_capability_surface_mismatch/);
});

/**
 * The shared world publishes the whole consented surface and the runner cannot
 * narrow it, so this topology proves the action and its preconditions are
 * advertised as a required subset instead of demanding exact equality.
 */
test("pet-animal runner accepts the shared-world surface as a required subset", async () => {
  const sharedConfig = {
    ...config,
    // Shared-world profile: same derived block, no opt-in needed.
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
    NativeLocalPlayerFixture: { Enable: false },
    FarmhandProvisioner: { Enable: true },
  };
  let snapshot = {
    revision: 1,
    location: "Farm",
    tile: { x: 1, y: 1 },
    actionable: true,
    activeExecution: null,
    capabilities: [
      "cancel_active_execution",
      "inspect_self",
      "pet_animal",
      "move_to_tile",
      "machine_inspect",
    ],
    petTargets: [target],
  };
  const receipts = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      assert.equal(request.action, "pet_animal");
      snapshot = { ...snapshot, revision: 2, petTargets: [] };
      client.state.snapshot = snapshot;
      const accepted = {
        requestId: request.requestId,
        executionId: "pet-execution",
        state: "accepted",
        reasonCode: "accepted",
        revision: 2,
      };
      receipts.push({
        ...accepted,
        state: "succeeded",
        reasonCode: "pet_completed",
        evidence: {
          detail:
            "day_recorded=true;friendship_after=12;friendship_before=0;friendship_callback=true;location=Farm;pet_day=1;target=pet_0123456789abcdef;tile=2,1",
        },
      });
      return accepted;
    },
  };
  const result = await runPetAnimalSmoke(client, receipts, sharedConfig);
  assert.equal(result.state, "passed");
  assert.equal(result.topology, "shared_world_farmhand");
  assert.equal(result.reasonCode, "pet_completed");
});
