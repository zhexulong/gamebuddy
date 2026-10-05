import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMineElevatorPostconditions,
  runMineElevatorSmoke,
} from "./run-stardew-native-local-player-mine-elevator-smoke.mjs";

const SCENARIO = "native_mine_elevator_v1";
const CAPABILITIES = ["cancel_active_execution", "inspect_self", "select_mine_elevator_floor"];

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
  NativeLocalPlayerFixture: { Enable: true, Bootstrap: { Enable: false }, FixtureScenario: SCENARIO },
};

/** What the accepted receipt carries: the dispatch facts (the warp has only started). */
const DISPATCH_EVIDENCE =
  "origin=UndergroundMine5;origin_floor=5;floor=10;is_entrance=false;target=UndergroundMine10;" +
  "lowest_level_reached=10;elevator_tile=8,3;riding_mine_elevator=true";

/**
 * What the terminal carries once the Warped edge arrives. The native MineShaft layout
 * repositions the actor (measured live: level 10 arrives near 10,4, not the requested
 * 6,6), so the honest postcondition is the LEVEL — a fixed-tile expectation here would
 * encode a contract the game does not honour.
 */
const TERMINAL_EVIDENCE = "expected=UndergroundMine10:6,6;actual=UndergroundMine10:10,4;level=10";

function floors(currentFloor) {
  return [0, 5, 10].map((floor) => ({
    targetId: `mine_elevator_floor_${floor}`,
    floor,
    isCurrentFloor: floor === currentFloor,
    isMineEntrance: floor === 0,
  }));
}

function snapshot(revision, location, tile, currentFloor) {
  return {
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    mineElevatorFloorTargets: floors(currentFloor),
  };
}

/**
 * The Mod's real shape: the immediate response is Accepted (the warp has started), and
 * the single terminal lands later on the same journal. A fake that returned the
 * terminal immediately would let this runner pass on a contract the Mod does not have —
 * which is exactly how the first live attempt failed.
 */
function makeClient({ terminalEvidence = TERMINAL_EVIDENCE, arrival = null, afterFloorsCurrent = 10 } = {}) {
  let current = snapshot(4, "UndergroundMine5", { x: 8, y: 3 }, 5);
  const receipts = [];
  const client = {
    state: { snapshot: current },
    observe: async () => current,
    execute: async (request) => {
      assert.equal(request.action, "select_mine_elevator_floor");
      assert.equal(request.args.expectedTargetId, "mine_elevator_floor_10");
      const accepted = {
        requestId: request.requestId,
        executionId: "exec_mine_elevator",
        state: "accepted",
        reasonCode: "accepted",
        revision: 4,
        evidence: { detail: DISPATCH_EVIDENCE },
      };
      const terminal = {
        requestId: request.requestId,
        executionId: "exec_mine_elevator",
        state: "succeeded",
        reasonCode: "mine_elevator_floor_selected",
        revision: 5,
        evidence: { detail: terminalEvidence },
      };
      receipts.push(accepted, terminal);
      current = snapshot(5, arrival ?? "UndergroundMine10", { x: 10, y: 4 }, afterFloorsCurrent);
      return accepted;
    },
  };
  return { client, receipts };
}

test("passes when the world really moves to the requested floor", async () => {
  const { client, receipts } = makeClient();
  const result = await runMineElevatorSmoke(client, receipts, config, { floorsTimeoutMs: 500 });

  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "mine_elevator_floor_selected");
  assert.equal(result.requested.floor, 10);
  assert.equal(result.originFloor, 5);
  assert.equal(result.afterLocation, "UndergroundMine10");
  assert.equal(result.terminalLevel, 10);
  assert.equal(result.elevatorTile, "8,3");
  assert.equal(result.ridingMineElevatorObserved, "true");
  assert.equal(result.arrivedCurrentFloorAdvertised, true);
  assert.equal(result.trace.filter((entry) => entry.action === "select_mine_elevator_floor").length, 1);
});

test("blocks when the receipt claims a floor the world did not reach", async () => {
  const { client, receipts } = makeClient({ arrival: "UndergroundMine5" });
  const result = await runMineElevatorSmoke(client, receipts, config, { floorsTimeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /mine_elevator_arrival_not_observed/);
});

test("blocks when the terminal names a different level than requested", async () => {
  const { client, receipts } = makeClient({
    terminalEvidence: "expected=UndergroundMine10:6,6;actual=UndergroundMine5:10,4;level=5",
  });
  const result = await runMineElevatorSmoke(client, receipts, config, { floorsTimeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /mine_elevator_terminal_level_mismatch/);
});

test("blocks when the floor bookkeeping did not follow the arrival", async () => {
  // The location moved but the freshly observed set still calls the OLD floor
  // current: that means the projection is stale, not that the ride worked.
  const { client, receipts } = makeClient({ afterFloorsCurrent: 5 });
  const result = await runMineElevatorSmoke(client, receipts, config, { floorsTimeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /mine_elevator_current_floor_not_reprojected/);
});

test("blocks when the elevator reports no floors at all", async () => {
  const client = {
    state: { snapshot: snapshot(4, "FarmHouse", { x: 3, y: 12 }, 0) },
    observe: async () => ({ ...snapshot(4, "FarmHouse", { x: 3, y: 12 }, 0), mineElevatorFloorTargets: [] }),
    execute: async () => {
      throw new Error("must not execute without an advertised floor");
    },
  };
  const result = await runMineElevatorSmoke(client, [], config, { floorsTimeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /mine_elevator_no_floors_advertised/);
});

test("blocks when every advertised floor is the entrance or the current one", async () => {
  // With no progress beyond the current floor, there is nothing to change to.
  const onlyEntrance = [0, 5].map((floor) => ({
    targetId: `mine_elevator_floor_${floor}`,
    floor,
    isCurrentFloor: floor === 5,
    isMineEntrance: floor === 0,
  }));
  const client = {
    state: { snapshot: snapshot(4, "UndergroundMine5", { x: 8, y: 3 }, 5) },
    observe: async () => ({
      ...snapshot(4, "UndergroundMine5", { x: 8, y: 3 }, 5),
      mineElevatorFloorTargets: onlyEntrance,
    }),
    execute: async () => {
      throw new Error("must not execute without a selectable floor");
    },
  };
  const result = await runMineElevatorSmoke(client, [], config, { floorsTimeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /mine_elevator_no_selectable_floor/);
});

test("refuses a config that is not this scenario or is not topology-isolated", async () => {
  const { client, receipts } = makeClient();

  const wrongScenario = await runMineElevatorSmoke(client, receipts, {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_ride_bus_v1" },
  });
  assert.equal(wrongScenario.state, "blocked");
  assert.match(wrongScenario.reasonCode, /native_local_fixture_scenario_mismatch/);

  const notIsolated = await runMineElevatorSmoke(client, receipts, { ...config, Portfolio: { Enable: true } });
  assert.equal(notIsolated.state, "blocked");
  assert.match(notIsolated.reasonCode, /native_local_fixture_topology_not_isolated/);
});

test("the pass contract rejects each clause it claims", () => {
  const detail = {
    reasonCode: "mine_elevator_floor_selected",
    requested: { floor: 10, targetId: "mine_elevator_floor_10" },
    floorsBefore: "0/5*/10",
    floorsAfter: "0/5/10*",
    originLocation: "UndergroundMine5",
    originFloor: 5,
    elevatorTile: "8,3",
    ridingMineElevatorObserved: "true",
    terminalLevel: 10,
    terminalActual: "UndergroundMine10:10,4",
    afterLocation: "UndergroundMine10",
    arrivedCurrentFloorAdvertised: true,
    trace: [{ action: "select_mine_elevator_floor" }],
  };
  assert.doesNotThrow(() => assertMineElevatorPostconditions({ ...detail }));

  assert.throws(
    () => assertMineElevatorPostconditions({ ...detail, afterLocation: "UndergroundMine5" }),
    /mine_elevator_arrival_not_observed/,
  );
  assert.throws(
    () => assertMineElevatorPostconditions({ ...detail, terminalLevel: 5 }),
    /mine_elevator_terminal_level_mismatch/,
  );
  assert.throws(
    () => assertMineElevatorPostconditions({ ...detail, originFloor: 10 }),
    /mine_elevator_did_not_change_floor/,
  );
  assert.throws(
    () => assertMineElevatorPostconditions({ ...detail, arrivedCurrentFloorAdvertised: false }),
    /mine_elevator_current_floor_not_reprojected/,
  );
  assert.throws(() => assertMineElevatorPostconditions({ ...detail, trace: [] }), /mine_elevator_trace/);
});
