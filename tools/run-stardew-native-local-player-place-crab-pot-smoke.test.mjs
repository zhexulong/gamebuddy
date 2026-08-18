import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectNativeLocalClient } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { runPlaceCrabPotSmoke } from "./run-stardew-native-local-player-place-crab-pot-smoke.mjs";

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

const LIVE_EVIDENCE =
  "source=(O)710;location=Farm;x=2;y=3;target=crab-target;" +
  "item=(O)710;slot=7;is_crab_pot=true;owner=42;inventory_before=1;" +
  "inventory_after=0;overlay_tiles=1,2,1;offset_x=1.5;offset_y=-0.5";

function liveSnapshots() {
  const before = {
    revision: 1,
    location: "Farm",
    tile: { x: 3, y: 3 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "move_to_tile", "travel", "place_crab_pot"],
    crabPotTargets: [target],
    crabPotResultTargets: [],
  };
  const after = {
    ...before,
    revision: 2,
    crabPotTargets: [],
    crabPotResultTargets: [{ ...target, offsetX: 1.5, offsetY: -0.5, overlayTiles: [{ x: 1, y: 2, count: 1 }] }],
  };
  return { before, after };
}

function liveClient({ reads = 0 } = {}) {
  const { before, after } = liveSnapshots();
  let readsDone = 0;
  return {
    client: {
      state: { snapshot: before },
      observe: async () => (++readsDone === 1 ? before : after),
      execute: async (request) => ({
        requestId: request.requestId,
        executionId: "crab-execution",
        state: "succeeded",
        reasonCode: "crab_pot_placed",
        revision: 2,
        evidence: { detail: LIVE_EVIDENCE },
      }),
    },
    snapshots: { before, after },
    get readsDone() {
      return readsDone;
    },
  };
}

test("place-crab-pot runner uses shared dispatch and fresh result reread", async () => {
  const base = liveClient();
  let dispatched;
  const client = {
    ...base.client,
    execute: async (request) => {
      dispatched = request;
      assert.equal(request.action, "place_crab_pot");
      assert.equal(request.expectedRevision, 1);
      assert.deepEqual(request.args, {
        slot: 7,
        x: 2,
        y: 3,
        expectedQualifiedItemId: "(O)710",
        expectedTargetId: "crab-target",
      });
      assert.match(request.requestId, /^native_local_place_crab_pot_/);
      assert.equal(request.idempotencyKey, `${request.requestId}_idem`);
      return base.client.execute(request);
    },
  };

  const result = await runPlaceCrabPotSmoke(client, config);
  assert.equal(result.state, "passed");
  assert.equal(result.receipt.reasonCode, "crab_pot_placed");
  assert.equal(result.receipt.executionId, "crab-execution");
  assert.equal(result.receipt.requestId, dispatched.requestId);
  assert.equal(result.result.targetId, "crab-target");
  assert.equal(result.result.offsetX, 1.5);
  assert.equal(base.readsDone, 2);
});

test("place-crab-pot runner fails closed on capability profile and target misses", async () => {
  const { before } = liveSnapshots();
  const client = {
    state: { snapshot: before },
    observe: async () => before,
    execute: async () => {
      throw new Error("must not dispatch");
    },
  };
  await assert.rejects(
    runPlaceCrabPotSmoke(client, { ...config, EnabledActions: ["move_to_tile"] }),
    /production_capability_profile_invalid/,
  );
  await assert.rejects(
    runPlaceCrabPotSmoke(
      client,
      { ...config, EnabledActions: ["move_to_tile", "travel", "place_crab_pot", "extra"] },
    ),
    /production_capability_profile_invalid/,
  );
  const missingCapability = { ...before, capabilities: ["cancel_active_execution", "move_to_tile", "travel"] };
  const client2 = {
    state: { snapshot: missingCapability },
    observe: async () => missingCapability,
    execute: async () => {
      throw new Error("must not dispatch");
    },
  };
  await assert.rejects(runPlaceCrabPotSmoke(client2, config), /native_local_place_crab_pot_capability_missing/);
});

test("place-crab-pot runner fails closed without an adjacent live target", async () => {
  const { before } = liveSnapshots();
  const noTarget = { ...before, crabPotTargets: [] };
  const client = {
    state: { snapshot: noTarget },
    observe: async () => noTarget,
    execute: async () => {
      throw new Error("must not dispatch");
    },
  };
  await assert.rejects(runPlaceCrabPotSmoke(client, config), /no_adjacent_live_crab_pot_target/);
  const outOfRange = { ...before, tile: { x: 9, y: 9 } };
  const client2 = {
    state: { snapshot: outOfRange },
    observe: async () => outOfRange,
    execute: async () => {
      throw new Error("must not dispatch");
    },
  };
  await assert.rejects(runPlaceCrabPotSmoke(client2, config), /no_adjacent_live_crab_pot_target/);
});

test("place-crab-pot runner reports blocked on evidence or postcondition mismatch", async () => {
  const base = liveClient();
  const client = {
    ...base.client,
    execute: async (request) => {
      const receipt = await base.client.execute(request);
      return {
        ...receipt,
        evidence: { detail: LIVE_EVIDENCE.replace("x=2", "x=9") },
      };
    },
  };
  const result = await runPlaceCrabPotSmoke(client, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.evidenceMatches, false);
  assert.equal(result.resultMatches, true);

  const base2 = liveClient();
  const client2 = {
    ...base2.client,
    execute: async (request) => ({
      ...(await base2.client.execute(request)),
      reasonCode: "invalid_resource",
    }),
  };
  const result2 = await runPlaceCrabPotSmoke(client2, config);
  assert.equal(result2.state, "blocked");
  assert.equal(result2.evidenceMatches, false);
});

test("place-crab-pot session uses the shared harness and tears down exactly once", async () => {
  const base = liveClient();
  const instance = {
    listeners: new Set(),
    closed: 0,
    observe: base.client.observe,
    execute: async (request) => {
      const receipt = await base.client.execute(request);
      assert.deepEqual(request.args, {
        slot: 7,
        x: 2,
        y: 3,
        expectedQualifiedItemId: "(O)710",
        expectedTargetId: "crab-target",
      });
      return receipt;
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
  const result = await runPlaceCrabPotSmoke(session.client, config);
  assert.equal(result.state, "passed");
  session.close();
  assert.equal(instance.closed, 1);
  assert.equal(instance.listeners.size, 0);

  const source = await readFile(new URL("./run-stardew-native-local-player-place-crab-pot-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /connectNativeLocalClient\(config\)/);
  assert.match(source, /finally \{\s+session\.close\(\);\s+\}/);
  assert.match(source, /waitForFreshSnapshot\(client, \{/);
  assert.doesNotMatch(source, /LocalStardewBridgeClient\.connect/);
  assert.doesNotMatch(source, /host-production-module/);
});