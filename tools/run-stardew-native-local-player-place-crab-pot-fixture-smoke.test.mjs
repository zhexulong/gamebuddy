import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectNativeLocalClient } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { runPlaceCrabPotFixtureSmoke } from "./run-stardew-native-local-player-place-crab-pot-fixture-smoke.mjs";

const target = {
  targetId: "crab-target",
  x: 2,
  y: 3,
  slot: 7,
  location: "Farm",
  qualifiedItemId: "(O)710",
  ownerId: 42,
};

const config = {
  EnabledActions: ["move_to_tile", "travel", "place_crab_pot"],
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
};

function liveSnapshot() {
  return {
    revision: 1,
    location: "Farm",
    tile: { x: 3, y: 3 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "move_to_tile", "travel", "place_crab_pot"],
    crabPotTargets: [target],
    crabPotResultTargets: [],
    latestReceipt: { state: "accepted", executionId: "e1" },
  };
}

test("fixture runner prepares the crab-pot fixture without any production request", async () => {
  const snapshot = liveSnapshot();
  let dispatched = false;
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async () => {
      dispatched = true;
      throw new Error("fixture must not dispatch");
    },
  };
  const result = await runPlaceCrabPotFixtureSmoke(client, config);
  assert.equal(result.state, "fixture_prepared");
  assert.equal(result.productionRequestSent, false);
  assert.equal(dispatched, false);
  assert.equal(result.target.targetId, "crab-target");
  assert.equal(result.target.qualifiedItemId, "(O)710");
  assert.deepEqual(result.latestReceipt, { state: "accepted", executionId: "e1" });
});

test("fixture runner fails closed on capability profile and capability surface", async () => {
  const snapshot = liveSnapshot();
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async () => {
      throw new Error("must not dispatch");
    },
  };
  await assert.rejects(
    runPlaceCrabPotFixtureSmoke(client, { ...config, EnabledActions: ["move_to_tile"] }),
    /fixture_capability_profile_invalid/,
  );
  const missingCapability = { ...snapshot, capabilities: ["cancel_active_execution", "move_to_tile", "travel"] };
  const client2 = {
    state: { snapshot: missingCapability },
    observe: async () => missingCapability,
    execute: async () => {
      throw new Error("must not dispatch");
    },
  };
  await assert.rejects(runPlaceCrabPotFixtureSmoke(client2, config), /native_local_place_crab_pot_capability_missing/);
});

test("fixture runner fails closed on actionability, item, and target misses", async () => {
  const snapshot = liveSnapshot();
  const notActionable = { ...snapshot, actionable: false };
  const client = {
    state: { snapshot: notActionable },
    observe: async () => notActionable,
    execute: async () => {
      throw new Error("must not dispatch");
    },
  };
  await assert.rejects(runPlaceCrabPotFixtureSmoke(client, config), /native_snapshot_not_actionable/);

  const wrongItem = { ...snapshot, crabPotTargets: [{ ...target, qualifiedItemId: "(O)685" }] };
  const client2 = {
    state: { snapshot: wrongItem },
    observe: async () => wrongItem,
    execute: async () => {
      throw new Error("must not dispatch");
    },
  };
  await assert.rejects(runPlaceCrabPotFixtureSmoke(client2, config), /fixture_crab_pot_target_item_mismatch/);

  const noTarget = { ...snapshot, crabPotTargets: [] };
  const client3 = {
    state: { snapshot: noTarget },
    observe: async () => noTarget,
    execute: async () => {
      throw new Error("must not dispatch");
    },
  };
  await assert.rejects(runPlaceCrabPotFixtureSmoke(client3, config), /no_adjacent_live_crab_pot_target/);
});

test("fixture session uses the shared harness and tears down exactly once", async () => {
  const snapshot = liveSnapshot();
  const instance = {
    listeners: new Set(),
    closed: 0,
    observe: async () => snapshot,
    execute: async () => {
      throw new Error("fixture must not dispatch");
    },
    onFact: (listener) => {
      instance.listeners.add(listener);
      return () => instance.listeners.delete(listener);
    },
    close: () => {
      instance.closed += 1;
    },
  };
  const fakeClient = {
    connect: async (scope, pipeName, bridgeToken) => {
      assert.deepEqual(scope, {
        integrationId: "stardew",
        saveId: "save",
        worldId: "world",
        playerId: "player",
        companionId: "companion",
      });
      assert.equal(pipeName, "pipe");
      assert.equal(bridgeToken, "token");
      return instance;
    },
  };
  const session = await connectNativeLocalClient(config, {
    loadModule: async () => ({ LocalStardewBridgeClient: fakeClient }),
  });
  const result = await runPlaceCrabPotFixtureSmoke(session.client, config);
  assert.equal(result.state, "fixture_prepared");
  assert.equal(result.productionRequestSent, false);
  session.close();
  assert.equal(instance.closed, 1);
  assert.equal(instance.listeners.size, 0);

  const source = await readFile(
    new URL("./run-stardew-native-local-player-place-crab-pot-fixture-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /connectNativeLocalClient\(config\)/);
  assert.match(source, /finally \{\s+session\.close\(\);\s+\}/);
  assert.doesNotMatch(source, /LocalStardewBridgeClient\.connect/);
  assert.doesNotMatch(source, /host-production-module/);
});
