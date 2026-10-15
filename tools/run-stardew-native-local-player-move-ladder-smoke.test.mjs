import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRefusal,
  ladderTargets,
  parseMoveFacts,
  runMoveLadderSmoke,
} from "./run-stardew-native-local-player-move-ladder-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile"];

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
 * Fake bridge for the ladder probe.
 *
 * The actor starts at (50,20); every target succeeds unless `refusalFor`
 * answers with a Mod refusal evidence string for that exact tile, which is what
 * lets one run exercise all three refusal classes at once.
 */
function createFake({ scenario = "native_move_ladder_v1", anchor = { x: 50, y: 20 }, refusalFor = () => null } = {}) {
  const listeners = new Set();
  let revision = 10;
  let tile = { ...anchor };
  const snapshotOf = () => ({
    revision,
    location: "Farm",
    tile: { ...tile },
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
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
      const executionId = `exec-${requestId}`;
      revision += 1;
      const refusal = refusalFor(args);
      if (refusal !== null) {
        const terminal = {
          requestId,
          executionId,
          state: "rejected",
          reasonCode: "no_native_path",
          revision,
          evidence: refusal,
        };
        publish(terminal);
        return terminal;
      }
      const accepted = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      publish(accepted);
      revision += 1;
      tile = { x: args.x, y: args.y };
      publish({
        requestId,
        executionId,
        state: "succeeded",
        reasonCode: "target_reached",
        revision,
        evidence: `tile=${args.x},${args.y};target=${args.x},${args.y};arrival=exact;path=stardew_native`,
      });
      return accepted;
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

const DOOR_REFUSAL =
  "from=63,15;to=64,14;location=Farm;target_standable=false;target_walkable=false;blocked_by=building:Farmhouse@64,14;" +
  "target_enclosed=true;derived=true;probe=cardinal_flood;probe_says_reachable=false;route_exists_cardinal=false;" +
  "component_tiles=120;approaches=north:open,south:blocked,east:open,west:blocked;closest=63,15;closest_distance=1;" +
  "measurement=cardinal_flood;path_search=no_cardinal_route;budget=undecided";

const ENCLOSED_FREE_TILE_REFUSAL =
  "from=60,15;to=79,15;location=Farm;target_standable=true;target_walkable=true;blocked_by=none;" +
  "target_enclosed=true;derived=true;probe=cardinal_flood;probe_says_reachable=false;route_exists_cardinal=false;" +
  "component_tiles=0;approaches=north:open,south:open,east:off_map,west:open;closest=none;" +
  "measurement=cardinal_flood;path_search=no_cardinal_route;budget=undecided";

const OFF_MAP_REFUSAL =
  "from=60,15;to=80,15;location=Farm;target_standable=false;target_walkable=false;blocked_by=none;target_enclosed=false;" +
  "derived=true;probe=cardinal_flood;probe_says_reachable=true;route_exists_cardinal=false;component_tiles=200;" +
  "measurement=cardinal_flood;path_search=no_cardinal_route;budget=undecided";

test("the ladder spans near steps, the Farm's edge landmark, a building, and off-map tiles", () => {
  const ladder = ladderTargets({ x: 52, y: 16 });
  assert.deepEqual(
    ladder.map((entry) => entry.label),
    [
      "short_east",
      "short_south",
      "long_west",
      "far_west",
      "last_in_map_column",
      "farmhouse_entry_tile",
      "farmhouse_door_tile",
      "beside_farmhouse",
      "off_map_east",
      "off_map_corner",
    ],
  );
  assert.deepEqual(
    ladder.find((entry) => entry.label === "short_east"),
    { label: "short_east", x: 54, y: 16, shape: "in_map" },
  );
  assert.deepEqual(
    ladder.find((entry) => entry.label === "far_west"),
    { label: "far_west", x: 28, y: 16, shape: "in_map" },
  );
  assert.deepEqual(
    ladder.find((entry) => entry.label === "last_in_map_column"),
    { label: "last_in_map_column", x: 79, y: 15, shape: "in_map" },
  );
  assert.deepEqual(
    ladder.find((entry) => entry.label === "farmhouse_entry_tile"),
    { label: "farmhouse_entry_tile", x: 64, y: 15, shape: "in_map" },
  );
  assert.deepEqual(
    ladder.find((entry) => entry.label === "farmhouse_door_tile"),
    { label: "farmhouse_door_tile", x: 64, y: 14, shape: "in_map" },
  );
  assert.deepEqual(
    ladder.find((entry) => entry.label === "off_map_east"),
    { label: "off_map_east", x: 80, y: 15, shape: "off_map" },
  );
});

test("the refusal facts are read verbatim by name, including the comma-bearing approaches", () => {
  const facts = parseMoveFacts(DOOR_REFUSAL);
  assert.equal(facts.to, "64,14");
  assert.equal(facts.target_walkable, "false");
  assert.equal(facts.target_standable, "false");
  assert.equal(facts.blocked_by, "building:Farmhouse@64,14");
  assert.equal(facts.approaches, "north:open,south:blocked,east:open,west:blocked");
  assert.equal(facts.path_search, "no_cardinal_route");
  assert.equal(parseMoveFacts("").blocked_by, undefined);
  assert.equal(parseMoveFacts(undefined).blocked_by, undefined);
});

test("a refusal is classified by its own facts, never explained away", () => {
  assert.equal(
    classifyRefusal({
      terminal: { state: "rejected" },
      shape: "in_map",
      facts: { blocked_by: "building:Farmhouse@64,14" },
    }),
    "building_or_obstacle_footprint",
  );
  assert.equal(
    classifyRefusal({ terminal: { state: "rejected" }, shape: "in_map", facts: { blocked_by: "none" } }),
    "unexplained",
  );
  assert.equal(
    classifyRefusal({ terminal: { state: "rejected" }, shape: "off_map", facts: { blocked_by: "none" } }),
    "off_map",
  );
  assert.equal(classifyRefusal({ terminal: { state: "succeeded" }, shape: "in_map", facts: {} }), null);
});

test("one run records every target's own receipt and Mod facts", async () => {
  const client = createFake({
    refusalFor: (args) => {
      if (args.x === 64 && args.y === 14) return DOOR_REFUSAL;
      if (args.x === 79 && args.y === 15) return ENCLOSED_FREE_TILE_REFUSAL;
      if (args.x === 80) return OFF_MAP_REFUSAL;
      return null;
    },
  });
  const result = await runMoveLadderSmoke(client, client.receipts, fixtureConfig("native_move_ladder_v1"));
  assert.equal(result.state, "measured");
  assert.equal(result.location, "Farm");
  assert.deepEqual(result.anchor, { x: 50, y: 20 });
  assert.equal(result.summary.attempted, 10);
  assert.equal(result.summary.succeeded, 6);
  assert.equal(result.summary.rejected, 4);

  const door = result.attempts.find((attempt) => attempt.label === "farmhouse_door_tile");
  assert.equal(door.terminal.state, "rejected");
  assert.equal(door.terminal.reasonCode, "no_native_path");
  assert.equal(door.facts.blocked_by, "building:Farmhouse@64,14");
  assert.equal(door.facts.approaches, "north:open,south:blocked,east:open,west:blocked");
  assert.equal(door.classification, "building_or_obstacle_footprint");

  const edge = result.attempts.find((attempt) => attempt.label === "last_in_map_column");
  assert.equal(edge.facts.target_walkable, "true");
  assert.equal(edge.facts.blocked_by, "none");
  assert.equal(
    edge.classification,
    "unexplained",
    "a free in-map tile the planner refuses is the question this probe exists for",
  );

  const offMap = result.attempts.find((attempt) => attempt.label === "off_map_east");
  assert.equal(offMap.classification, "off_map");

  const nearStep = result.attempts.find((attempt) => attempt.label === "short_east");
  assert.equal(nearStep.terminal.state, "succeeded");
  assert.equal(nearStep.terminal.reasonCode, "target_reached");
  assert.deepEqual(nearStep.after.tile, { x: 52, y: 20 });
});

test("a wrong scenario is refused before any execution", async () => {
  const client = createFake();
  await assert.rejects(
    () => runMoveLadderSmoke(client, client.receipts, fixtureConfig("native_unknown_v1")),
    /native_local_fixture_invalid_scenario/,
  );
});
