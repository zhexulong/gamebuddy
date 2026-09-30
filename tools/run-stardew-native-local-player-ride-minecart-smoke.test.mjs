import assert from "node:assert/strict";
import test from "node:test";
import { runRideMinecartSmoke } from "./run-stardew-native-local-player-ride-minecart-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "ride_minecart"];

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: { Enable: true },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

const RIDE = {
  targetId: "minecart_0123456789abcdef",
  networkId: "Default",
  destinationId: "BusStop",
  displayName: "Bus Stop",
  price: 0,
  stationX: 10,
  stationY: 10,
  targetLocation: "BusStop",
  targetTileX: 20,
  targetTileY: 12,
};

function snapshotOf(location, tile, revision, minecartTargets = [RIDE], capabilities = CAPABILITIES) {
  return { revision, location, tile, actionable: true, activeExecution: null, capabilities, minecartTargets };
}

function createFake({
  tile: initialTile = { x: 10, y: 10 },
  location: initialLocation = "Farm",
  minecartTargets = [RIDE],
  capabilities = CAPABILITIES,
  rideState = "succeeded",
  rideReason = "minecart_ride_completed",
  rideEvidence = "expected=BusStop:20,12;actual=BusStop:20,12;network=Default;destination=BusStop",
  rideTarget = { location: "BusStop", tile: { x: 20, y: 12 } },
  reuseStationCheck = false,
  /**
   * How many observes after a successful ride report `actionable=false`.
   *
   * This models a real product fact, not test convenience: `GameLocation.MinecartWarp`
   * sets `Game1.player.freezePause = 700` (GameLocation.cs:10311) and `Farmer.Update`
   * then forces `CanMove = false` for that window (Farmer.cs:7595-7603). Snapshot
   * `actionable` includes `!player.CanMove`, so a correct ride is followed by
   * ~700ms of legitimate non-actionability that the runner must settle through.
   */
  frozenObservesAfterRide = 0,
} = {}) {
  const listeners = new Set();
  let revision = 7;
  let tile = initialTile;
  let location = initialLocation;
  let frozenRemaining = 0;
  const current = () => ({
    ...snapshotOf(location, tile, revision, minecartTargets, capabilities),
    actionable: frozenRemaining <= 0,
  });
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state: { snapshot: current() },
    observe: async () => {
      const snapshot = current();
      if (frozenRemaining > 0) frozenRemaining -= 1;
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}`;
      if (action === "move_to_tile") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        tile = { x: args.x, y: args.y };
        publish({ ...receipt, state: "succeeded", reasonCode: "target_reached", revision });
        return receipt;
      }
      if (action === "ride_minecart") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        if (rideState === "succeeded") {
          location = rideTarget.location;
          tile = { ...rideTarget.tile };
          frozenRemaining = frozenObservesAfterRide;
        }
        if (reuseStationCheck) {
          // The Mod re-derives everything from the live world, so a forged or
          // stale targetId must be refused rather than falling back to a warp.
          publish({ ...receipt, state: "rejected", reasonCode: "minecart_target_changed", revision });
          return receipt;
        }
        publish({
          ...receipt,
          state: rideState,
          reasonCode: rideReason,
          revision,
          evidence: { detail: rideEvidence },
        });
        return receipt;
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

function withReceipts(client) {
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  return receipts;
}

test("minecart runner passes when already adjacent to the station", async () => {
  const client = createFake();
  const result = await runRideMinecartSmoke(client, withReceipts(client), fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "minecart_ride_completed");
  assert.equal(result.receipt.reasonCode, "minecart_ride_completed");
  assert.equal(result.objectiveNamed, true);
  assert.equal(result.after.location, "BusStop");
  assert.deepEqual(result.after.tile, { x: 20, y: 12 });
  assert.deepEqual(
    result.trace.map((entry) => entry.action),
    ["ride_minecart"],
  );
  assert.deepEqual(result.trace[0].args, {
    x: 10,
    y: 10,
    expectedTargetId: "minecart_0123456789abcdef",
  });
});

test("minecart runner moves to the station before riding", async () => {
  const client = createFake({ tile: { x: 3, y: 3 } });
  const result = await runRideMinecartSmoke(client, withReceipts(client), fixtureConfig());
  assert.equal(result.state, "passed");
  assert.deepEqual(
    result.trace.map((entry) => entry.action),
    ["move_to_tile", "ride_minecart"],
  );
});

test("minecart runner blocks when the ride does not arrive at the objective tile", async () => {
  const client = createFake({ rideTarget: { location: "BusStop", tile: { x: 20, y: 13 } } });
  const result = await runRideMinecartSmoke(client, withReceipts(client), fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "minecart_ride_postcondition_mismatch");
});

test("minecart runner blocks when the receipt does not name the objective", async () => {
  const client = createFake({
    rideEvidence: "expected=BusStop:20,12;actual=BusStop:20,12",
  });
  const result = await runRideMinecartSmoke(client, withReceipts(client), fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "minecart_ride_postcondition_mismatch");
  assert.equal(result.objectiveNamed, false);
});

test("minecart runner blocks when the Mod refuses a stale objective", async () => {
  const client = createFake({ reuseStationCheck: true });
  const result = await runRideMinecartSmoke(client, withReceipts(client), fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "minecart_ride_failed:minecart_target_changed");
});

test("minecart runner blocks when no objective is advertised", async () => {
  const client = createFake({ minecartTargets: [] });
  const result = await runRideMinecartSmoke(client, withReceipts(client), fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "no_safe_live_minecart_objective");
});

test("minecart runner blocks when a required capability is missing", async () => {
  // The Mod's surface is deny-by-exception, so the runner asserts the required
  // subset. A surface that has dropped the action under test must still fail.
  const client = createFake({ capabilities: ["cancel_active_execution", "inspect_self", "move_to_tile"] });
  const result = await runRideMinecartSmoke(client, withReceipts(client), fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_required_capability_missing:ride_minecart");
  assert.equal(result.trace.length, 0);
});

test("minecart runner accepts a larger advertised surface than the fixture needs", async () => {
  const client = createFake({
    capabilities: [...CAPABILITIES, "craft_item", "advance_day"],
  });
  const result = await runRideMinecartSmoke(client, withReceipts(client), fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "minecart_ride_completed");
});

test("minecart runner settles through the post-ride freeze window", async () => {
  // MinecartWarp sets freezePause = 700, so the first ~N post-terminal observes are
  // legitimately actionable=false with the receipt ALREADY succeeded. A single-shot
  // strict read fails here on correct product behaviour. This test is load-bearing:
  // reverting the post-terminal read to observeMinecartActionable makes it fail.
  const client = createFake({ frozenObservesAfterRide: 3 });
  const result = await runRideMinecartSmoke(client, withReceipts(client), fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "minecart_ride_completed");
  assert.equal(result.after?.actionable, true, "the settled read must report the freeze lifted");
});

test("minecart runner rejects a non-isolated topology", async () => {
  const client = createFake();
  await assert.rejects(
    runRideMinecartSmoke(client, [], fixtureConfig({ Portfolio: { Enable: true } })),
    (error) => error?.message === "native_local_fixture_topology_not_isolated",
  );
});
