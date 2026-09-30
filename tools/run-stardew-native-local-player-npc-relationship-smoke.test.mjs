import assert from "node:assert/strict";
import test from "node:test";
import { runNpcRelationshipSmoke } from "./run-stardew-native-local-player-npc-relationship-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", "npc_relationship"];

const WARP = { sourceX: 4, sourceY: 3, targetX: 24, targetY: 17, targetLocation: "Farm" };

const ROBIN = {
  targetId: "npc_relationship_0123456789abcdef",
  x: 24,
  y: 16,
  npcName: "Robin",
  friendshipPoints: 250,
  friendshipStatus: "Friendly",
  talkedToToday: false,
  giftsToday: 0,
  giftsThisWeek: 0,
};

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: "native_npc_relationship_v1",
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
    ExperimentalActions: ["npc_relationship"],
    SaveId: "save",
    WorldId: "world",
    PlayerId: "player",
    CompanionId: "companion",
    PipeName: "pipe",
    BridgeToken: "token",
    ...overrides,
  };
}

/** Deterministic bridge: FarmHouse player adjacent to the Farm warp, one live
 * Robin fixture target adjacent to the arrival tile, travel and inspect only.
 *
 * `movedTo` makes the villager a moving entity: the pre-execution snapshot and
 * the request carry its discovery coordinate, then it walks to `movedTo` while
 * the inspect is being admitted, so the receipt reports its execution-time tile
 * and the postcondition reread sees the new coordinate. This is the case
 * 7bbc762's identity-bound admission exists for. */
function createFake({ movedTo = null } = {}) {
  const listeners = new Set();
  let revision = 10;
  let location = "FarmHouse";
  let tile = { x: WARP.sourceX, y: WARP.sourceY };
  let live = ROBIN;
  const snapshotOf = () => ({
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    warps: [WARP],
    npcRelationshipTargets: [live],
  });
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action }) => {
      const executionId = `execution-${action}`;
      revision += 1;
      const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      publish(receipt);
      if (action === "travel") {
        location = "Farm";
        tile = { x: WARP.targetX, y: WARP.targetY };
        publish({ ...receipt, state: "succeeded", reasonCode: "travel_completed", revision });
      } else if (action === "npc_relationship") {
        // The villager walks between the request snapshot and admission.
        if (movedTo !== null) live = { ...live, ...movedTo };
        publish({
          ...receipt,
          state: "succeeded",
          reasonCode: "npc_relationship_inspected",
          revision,
          evidence: {
            detail: `location=Farm;target=npc_relationship_0123456789abcdef;tile=${live.x},${live.y};npc=Robin;points=250;status=Friendly;talked_to_today=false;gifts_today=0;gifts_this_week=0`,
          },
        });
      } else {
        throw new Error(`unexpected_action:${action}`);
      }
      return receipt;
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  return client;
}

test("npc-relationship runner passes a travel-hop inspected fixture with unchanged opaque target", async () => {
  const client = createFake();
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runNpcRelationshipSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "npc_relationship_inspected");
  assert.equal(result.receipt.state, "succeeded");
  assert.equal(result.receipt.reasonCode, "npc_relationship_inspected");
  assert.equal(result.unchangedRelationshipFacts, true);
  assert.equal(result.evidence.npc, "Robin");
  assert.equal(result.evidence.points, "250");
  assert.equal(result.evidence.location, "Farm");
  assert.equal(result.after.location, "Farm");
  assert.equal(result.after.revision >= result.receipt.revision, true);
  assert.deepEqual(
    result.trace.map((entry) => entry.action),
    ["travel", "npc_relationship"],
  );
});

test("npc-relationship runner accepts a villager that walks between request and execution", async () => {
  // 7bbc762 binds admission to identity (location, name), not coordinates. The
  // pre-execution snapshot and the request carry Robin's discovery coordinate
  // (24,16); she walks to (25,16) before the inspect is admitted, so the receipt
  // reports the execution-time tile. Comparing that to the stale snapshot
  // coordinate - or requiring the postcondition reread to keep it - would fail a
  // correct receipt. This is the decisive regression for that bound.
  const client = createFake({ movedTo: { x: 25, y: 16 } });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runNpcRelationshipSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "npc_relationship_inspected");
  assert.equal(result.target.x, ROBIN.x);
  assert.equal(result.target.y, ROBIN.y);
  assert.equal(result.evidence.tile, "25,16");
  assert.equal(result.reread.x, 25);
  assert.equal(result.reread.y, 16);
  assert.equal(result.unchangedRelationshipFacts, true);
});

test("npc-relationship runner fails closed on a capability superset", async () => {
  const client = createFake();
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  client.observe = async () => ({
    ...(await createFake().observe()),
    capabilities: [...CAPABILITIES, "fetch_inventory"],
  });
  const result = await runNpcRelationshipSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /native_capability_surface_mismatch/);
});

test("npc-relationship runner rejects a non-isolated action policy", async () => {
  const client = createFake();
  await assert.rejects(
    runNpcRelationshipSmoke(client, [], fixtureConfig({ DeniedActions: ["move_to_tile"] })),
    (error) => error?.message?.startsWith("native_fixture_policy_denies_required"),
  );
});
