import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runPlaceWoodFenceSmoke } from "./run-stardew-native-local-player-place-wood-fence-smoke.mjs";

const target = {
  targetId: "fence-target",
  location: "Farm",
  slot: 4,
  x: 3,
  y: 2,
  qualifiedItemId: "(O)322",
};

const SUCCEEDED_EVIDENCE = {
  detail:
    "source=(O)322;location=Farm;x=3;y=2;target=fence-target;item=(O)322;slot=4;source_empty_before=true;is_fence=true;is_gate=false;health=100;max_health=100;inventory_before=1;inventory_after=0",
};

function fixtureConfig(overrides = {}) {
  return {
    SaveId: "save",
    WorldId: "world",
    PlayerId: "player",
    CompanionId: "companion",
    PipeName: "pipe",
    BridgeToken: "token",
    NativeLocalPlayerFixture: { Enable: true },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

function createFake({ capabilities, terminalReasonCode = "wood_fence_placed" } = {}) {
  const receipts = [];
  let snapshot = {
    revision: 7,
    location: "Farm",
    tile: { x: 2, y: 2 },
    actionable: true,
    activeExecution: null,
    capabilities: capabilities ?? ["place_wood_fence", "move_to_tile", "travel"],
    woodFenceTargets: [target],
    woodFenceResultTargets: [],
  };
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      assert.equal(request.action, "place_wood_fence");
      assert.equal(request.expectedRevision, 7);
      assert.deepEqual(request.args, {
        slot: 4,
        x: 3,
        y: 2,
        expectedQualifiedItemId: "(O)322",
        expectedTargetId: "fence-target",
      });
      const accepted = {
        requestId: request.requestId,
        executionId: "fence-execution",
        state: "accepted",
        reasonCode: "accepted",
        revision: 8,
      };
      snapshot = {
        ...snapshot,
        revision: 8,
        woodFenceTargets: [],
        woodFenceResultTargets: [
          {
            ...target,
            isFence: true,
            isGate: false,
            health: 100,
            maxHealth: 100,
          },
        ],
      };
      client.state.snapshot = snapshot;
      // Facts sharing only one identity field must never satisfy the exact
      // request/execution pair wait.
      receipts.push({
        ...accepted,
        executionId: "decoy-execution",
        state: "succeeded",
        reasonCode: "decoy_wrong_execution",
        revision: 8,
      });
      receipts.push({
        ...accepted,
        requestId: "decoy-request",
        state: "succeeded",
        reasonCode: "decoy_wrong_request",
        revision: 8,
      });
      receipts.push({
        ...accepted,
        state: "succeeded",
        reasonCode: terminalReasonCode,
        evidence: SUCCEEDED_EVIDENCE,
      });
      return accepted;
    },
  };
  return { client, receipts };
}

test("wood-fence runner passes only on the exact request/execution pair and a fresh postcondition", async () => {
  const { client, receipts } = createFake();
  const result = await runPlaceWoodFenceSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "wood_fence_placed");
  assert.equal(result.receipt.executionId, "fence-execution");
  assert.equal(result.after.revision, 8);
  const terminalLike = receipts.filter(
    (receipt) => receipt.executionId === "fence-execution" && receipt.state === "succeeded",
  );
  assert.equal(terminalLike.length, 2, "the real terminal and one decoy share the executionId");
});

test("wood-fence runner blocks when a required capability is missing", async () => {
  const { client, receipts } = createFake({ capabilities: ["place_wood_fence", "move_to_tile"] });
  const result = await runPlaceWoodFenceSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_local_travel_capability_missing");
  assert.equal(result.trace.length, 0);
});

test("wood-fence runner blocks on a terminal reasonCode other than wood_fence_placed", async () => {
  const { client, receipts } = createFake({ terminalReasonCode: "fence_knocked_over" });
  const result = await runPlaceWoodFenceSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "wood_fence_failed:fence_knocked_over");
});

test("wood-fence runner blocks on a non-isolated fixture topology", async () => {
  const { client, receipts } = createFake();
  const result = await runPlaceWoodFenceSmoke(client, receipts, fixtureConfig({ Portfolio: { Enable: true } }));
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_local_fixture_topology_not_isolated");
});

test("wood-fence runner CLI owns config, connect, and teardown through the shared harness only", async () => {
  const source = await readFile(
    new URL("./run-stardew-native-local-player-place-wood-fence-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /readNativeClientConfig\(\)/);
  assert.match(source, /connectNativeLocalClient\(config\)/);
  assert.match(source, /runPlaceWoodFenceSmoke\(session\.client, session\.receipts, config\)/);
  assert.match(source, /finally \{[\s\S]*?session\.close\(\);/);
  assert.equal((source.match(/session\.close\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(source, /readFile\(/);
  assert.doesNotMatch(source, /process\.argv/);
});
