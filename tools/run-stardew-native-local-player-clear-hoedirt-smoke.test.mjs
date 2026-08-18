import assert from "node:assert/strict";
import test from "node:test";
import { runClearHoeDirtSmoke } from "./run-stardew-native-local-player-clear-hoedirt-smoke.mjs";

const CAPABILITIES = [
  "cancel_active_execution",
  "clear_hoedirt",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
];

const target = {
  targetId: "hoedirt_target_01",
  location: "Farm",
  x: 53,
  y: 54,
  crop: false,
  ground: true,
};

const config = {
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_clear_hoedirt_v1",
  },
  ActionPolicyVersion: 0,
  EnabledActions: ["move_to_tile", "travel", "equip_tool", "clear_hoedirt"],
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
};

const EVIDENCE =
  "location=Farm;target=hoedirt_target_01;tile=53,54;tool=pickaxe;slot=14;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=false;removed=true";

function createFake({ evidenceDetail = EVIDENCE } = {}) {
  const listeners = new Set();
  let revision = 7;
  let cleared = false;
  const snapshotOf = () => ({
    revision,
    location: "Farm",
    tile: { x: 53, y: 54 },
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    toolSlots: [{ label: "(T)Pickaxe", slot: 14 }],
    clearHoeDirtTargets: cleared ? [] : [target],
  });
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}`;
      if (action === "equip_tool") {
        revision += 1;
        return { requestId, executionId, state: "succeeded", reasonCode: "tool_selected", revision };
      }
      if (action === "clear_hoedirt") {
        revision += 1;
        cleared = true;
        const receipt = {
          requestId,
          executionId,
          state: "succeeded",
          reasonCode: "hoedirt_cleared",
          revision,
          evidence: { detail: evidenceDetail },
        };
        for (const listener of listeners) listener({ type: "execution_receipt", payload: receipt });
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

function subscribeReceipts(client) {
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  return receipts;
}

test("clear-hoedirt runner passes with one live hoe-dirt target and a pickaxe", async () => {
  const client = createFake();
  const receipts = subscribeReceipts(client);
  const result = await runClearHoeDirtSmoke(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "hoedirt_cleared");
  assert.equal(result.topology, "native_local_player_fixture");
  assert.deepEqual(result.target, target);
  assert.equal(result.receipt.executionId, "execution-clear_hoedirt");
  assert.equal(result.evidence.target, "hoedirt_target_01");
  assert.equal(result.evidence.tile, "53,54");
  assert.equal(result.evidence.tool, "pickaxe");
  assert.equal(result.evidence.slot, "14");
  assert.equal(result.evidence.crop_before, "false");
  assert.equal(result.evidence.hoedirt_present_before, "true");
  assert.equal(result.evidence.hoedirt_present_after, "false");
  assert.equal(result.evidence.removed, "true");
  assert.equal(result.before.clearHoeDirtTargets, 1);
  assert.equal(result.after.clearHoeDirtTargets, 0);
});

test("clear-hoedirt runner blocks on mismatched native evidence", async () => {
  const client = createFake({
    evidenceDetail:
      "location=Farm;target=hoedirt_target_01;tile=53,54;tool=pickaxe;slot=14;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=true;removed=true",
  });
  const receipts = subscribeReceipts(client);
  const result = await runClearHoeDirtSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "clear_hoedirt_postcondition_mismatch");
});

test("clear-hoedirt runner rejects a non-isolated action policy", async () => {
  const client = createFake();
  await assert.rejects(
    runClearHoeDirtSmoke(client, [], { ...config, EnabledActions: ["clear_hoedirt"] }),
    (error) => error?.message === "native_local_clear_hoedirt_fixture_config_invalid",
  );
});

test("clear-hoedirt runner rejects a non-isolated topology", async () => {
  const client = createFake();
  await assert.rejects(
    runClearHoeDirtSmoke(client, [], { ...config, Portfolio: { Enable: true } }),
    (error) => error?.message === "native_local_clear_hoedirt_topology_invalid",
  );
});
