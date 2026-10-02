import assert from "node:assert/strict";
import test from "node:test";
import { runMoveStallProbe } from "./run-stardew-native-local-player-move-stall-probe-smoke.mjs";

// The pet scenario advertises `pet_animal` so the Pet projection is published
// and the blocker position is observable; the runner never invokes it. The npc
// scenario has no Pet projection, so its capability set omits it.
const CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "pet_animal"];
const CAPABILITIES_WITHOUT_PET = ["cancel_active_execution", "inspect_self", "move_to_tile"];

function fixtureConfig(scenario, overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: scenario,
      LogicalSaveName: "GameBuddyFixture",
      ObservedSaveSlot: "GameBuddyFixture_445094166",
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
    ...overrides,
  };
}

/**
 * Fake bridge for the move-stall probe.
 *
 * Fixture geometry: actor at (10,10), blocker at (10,11), target (10,12).
 * Three outcomes the probe must distinguish:
 *   nativeSelfResolved -- phase 1 succeeds (native pushing/pass-through won).
 *   retryResolved      -- phase 1 fails with `native_path_ended`, phase 2 succeeds.
 *   neither            -- both fail; re-issuing the same move is NOT the answer.
 */
function createFake({ scenario, phase1Succeeds = true, phase2Succeeds = true, phase1ReasonCode = "native_path_ended" } = {}) {
  const listeners = new Set();
  let revision = 21;
  let tile = { x: 10, y: 10 };
  let attemptNumber = 0;
  const target = { x: 10, y: 12 };
  const snapshotOf = () => ({
    revision,
    location: "Farm",
    tile,
    actionable: true,
    activeExecution: null,
    capabilities: scenario === "native_move_stall_probe_pet_v1" ? CAPABILITIES : CAPABILITIES_WITHOUT_PET,
    // The Pet projection is how the probe reads the blocker back; a parked
    // Horse has no equivalent, so npc scenarios simply get an empty list.
    petTargets:
      scenario === "native_move_stall_probe_pet_v1"
        ? [{ targetId: "pet-1", x: 10, y: 11, petType: "Dog", friendship: 0, pettedToday: true, stationary: true }]
        : [],
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
      assert.equal(action, "move_to_tile");
      assert.deepEqual(args, target, "the probe must target A+(0,2)");
      attemptNumber += 1;
      const succeeds = attemptNumber === 1 ? phase1Succeeds : phase2Succeeds;
      revision += 1;
      const receipt = {
        requestId,
        executionId: `execution-${scenario}-${revision}`,
        state: "accepted",
        reasonCode: "accepted",
        revision,
      };
      publish(receipt);
      revision += 1;
      if (succeeds) {
        tile = { ...target };
        publish({ ...receipt, state: "succeeded", reasonCode: "target_reached", revision, evidence: "tile=10,12;target=10,12;arrival=exact;path=stardew_native" });
      } else {
        // The actor advances one tile (pushing worked) but stops short.
        tile = { x: 10, y: 11 };
        const reasonCode = attemptNumber === 1 ? phase1ReasonCode : "native_path_ended";
        publish({ ...receipt, state: "failed", reasonCode, revision, evidence: "tile=10,11;target=10,12" });
      }
      return receipt;
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  client.receipts = receipts;
  return client;
}

test("pet blocker resolves natively: one phase, nativeSelfResolved", async () => {
  const client = createFake({ scenario: "native_move_stall_probe_pet_v1" });
  const result = await runMoveStallProbe(client, client.receipts, fixtureConfig("native_move_stall_probe_pet_v1"));
  assert.equal(result.state, "measured");
  assert.equal(result.conclusion, "native_self_resolved");
  assert.equal(result.blockerKind, "pet");
  assert.equal(result.nativeSelfResolved, true);
  assert.equal(result.retryResolved, false);
  assert.equal(result.phase2, null, "a self-resolved move must not spend a retry phase");
  assert.equal(result.phase1.terminal.reasonCode, "target_reached");
});

test("blocked once then resolved on retry: retry_resolved carries the finding", async () => {
  // This is the decisive reading: the native block did NOT resolve in one pass,
  // but re-observing and re-issuing did. That is direct evidence the 5.3
  // increment (bounded re-plan) has a real job to do.
  const client = createFake({ scenario: "native_move_stall_probe_npc_v1", phase1Succeeds: false, phase2Succeeds: true });
  const result = await runMoveStallProbe(client, client.receipts, fixtureConfig("native_move_stall_probe_npc_v1"));
  assert.equal(result.state, "measured");
  assert.equal(result.conclusion, "retry_resolved");
  assert.equal(result.nativeSelfResolved, false);
  assert.equal(result.retryResolved, true);
  assert.equal(result.phase1.terminal.reasonCode, "native_path_ended");
  assert.equal(result.phase2.terminal.reasonCode, "target_reached");
});

test("blocker survives the retry: the finding is recorded, not papered over", async () => {
  // The counter-case. If re-issuing never helps, building 5.3 on "retry the same
  // move" would be wrong, and the probe has to say so instead of reporting
  // success. Note this is still a MEASURED result, not an invalid one: the probe
  // answered its question.
  const client = createFake({ scenario: "native_move_stall_probe_pet_v1", phase1Succeeds: false, phase2Succeeds: false });
  const result = await runMoveStallProbe(client, client.receipts, fixtureConfig("native_move_stall_probe_pet_v1"));
  assert.equal(result.state, "measured");
  assert.equal(result.conclusion, "blocker_survived");
  assert.equal(result.nativeSelfResolved, false);
  assert.equal(result.retryResolved, false);
  assert.equal(result.blockerStillOnRoute, true, "the pet projection must show the blocker back on the route");
  assert.deepEqual(result.phase2.finalTile, { x: 10, y: 11 }, "a stalled actor must not be reported on the target");
});

test("a move that fails for another reason is an invalid measurement, not a finding", async () => {
  // Phase 1 fails with something other than native_path_ended: the probe cannot
  // attribute it to the blocker, so it must not report a blocker conclusion.
  const client = createFake({
    scenario: "native_move_stall_probe_pet_v1",
    phase1Succeeds: false,
    phase2Succeeds: true,
    phase1ReasonCode: "no_native_path",
  });
  const result = await runMoveStallProbe(client, client.receipts, fixtureConfig("native_move_stall_probe_pet_v1"));
  assert.equal(result.state, "invalid");
  assert.match(result.conclusion, /^unexpected_terminal:/);
  // Even though phase 2 reached the target, an unattributable phase-1 failure
  // must not be recycled into a "retry works" finding.
  assert.equal(result.conclusion.includes("retry"), false);
});

test("unknown scenario is refused before any execution", async () => {
  const client = createFake({ scenario: "native_move_stall_probe_npc_v1" });
  await assert.rejects(
    () => runMoveStallProbe(client, client.receipts, fixtureConfig("native_unknown_v1")),
    /native_local_fixture_invalid_scenario/,
  );
});