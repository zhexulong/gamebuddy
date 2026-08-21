import assert from "node:assert/strict";
import test from "node:test";
import { runClearDebrisSmoke } from "./run-stardew-native-local-player-clear-debris-smoke.mjs";

const CAPABILITIES = [
  "cancel_active_execution",
  "clear_debris",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
];
const FIXTURE_TARGET = {
  targetId: "debris-clump-target",
  slot: 0,
  x: 62,
  y: 17,
  parentSheetIndex: 752,
  toolKind: "pickaxe",
  requiredUpgradeLevel: 0,
  health: 8,
};
const PICKAXE = { slot: 1, label: "(T)Pickaxe" };
const WARP = { targetLocation: "Farm", sourceX: 63, sourceY: 16, targetX: 62, targetY: 15 };
const FARMHOUSE_TILE = { x: 63, y: 15 };
const FIRST_APPROACH = { x: 61, y: 17 };

function validConfig() {
  return {
    ActionPolicyVersion: 0,
    EnabledActions: ["move_to_tile", "travel", "equip_tool", "clear_debris"],
    NativeLocalPlayerFixture: {
      Enable: true,
      Bootstrap: { Enable: false },
      FixtureScenario: "native_clear_debris_resource_clump_v1",
    },
  };
}

function createFakeClient({ landingTile = FIRST_APPROACH, removeOnLastHit = true } = {}) {
  const receipts = [];
  let sequence = 0;
  const snapshot = {
    revision: 1,
    location: "FarmHouse",
    tile: FARMHOUSE_TILE,
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    warps: [WARP],
    debrisTargets: [FIXTURE_TARGET],
    toolSlots: [PICKAXE],
  };
  const client = {
    state: { snapshot },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      assert.equal(request.idempotencyKey, `${request.requestId}_idem`);
      assert.ok(request.deadlineMs > Date.now() && request.deadlineMs <= Date.now() + 60_000);
      const current = client.state.snapshot;
      assert.equal(request.expectedRevision, current.revision);
      const accepted = {
        requestId: request.requestId,
        executionId: `clear-debris-execution-${sequence}`,
        state: "accepted",
        reasonCode: "accepted",
        revision: current.revision,
      };
      if (request.action === "travel") {
        assert.deepEqual(request.args, { x: WARP.sourceX, y: WARP.sourceY });
        client.state.snapshot = {
          ...current,
          revision: current.revision + 1,
          location: "Farm",
          tile: landingTile,
        };
        receipts.push({
          ...accepted,
          state: "succeeded",
          reasonCode: "travel_completed",
          revision: client.state.snapshot.revision,
        });
        return accepted;
      }
      if (request.action === "equip_tool") {
        assert.deepEqual(request.args, { slot: PICKAXE.slot });
        sequence += 1;
        return { ...accepted, state: "succeeded", reasonCode: "tool_selected" };
      }
      if (request.action === "move_to_tile") {
        assert.deepEqual(request.args, FIRST_APPROACH);
        client.state.snapshot = {
          ...current,
          revision: current.revision + 1,
          tile: FIRST_APPROACH,
        };
        receipts.push({
          ...accepted,
          state: "succeeded",
          reasonCode: "target_reached",
          revision: client.state.snapshot.revision,
        });
        return accepted;
      }
      if (request.action === "clear_debris") {
        sequence += 1;
        const target = current.debrisTargets?.[0];
        assert.ok(target, "expected a live debris target for the hit");
        assert.deepEqual(request.args, {
          slot: PICKAXE.slot,
          x: FIXTURE_TARGET.x,
          y: FIXTURE_TARGET.y,
          expectedTargetId: FIXTURE_TARGET.targetId,
        });
        const terminalHit = target.health === 1;
        const healthAfter = terminalHit ? 0 : target.health - 1;
        client.state.snapshot = {
          ...current,
          revision: current.revision + 1,
          debrisTargets: terminalHit && removeOnLastHit ? [] : [{ ...target, health: healthAfter }],
        };
        const receipt = {
          ...accepted,
          revision: client.state.snapshot.revision,
          state: terminalHit ? "succeeded" : "partially_succeeded",
          reasonCode: terminalHit ? "debris_cleared" : "debris_hit",
          evidence: {
            detail:
              `location=${client.state.snapshot.location};target=${target.targetId};tile=${target.x},${target.y};` +
              `parent=752;tool=pickaxe;required_upgrade=0;health_before=${target.health};health_after=${healthAfter};` +
              `clump_removed=${terminalHit}`,
          },
        };
        receipts.push(receipt);
        return receipt;
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  return { client, receipts };
}

test("clear-debris runner clears the frozen 8-health fixture clump through shared dispatch and terminal correlation", async () => {
  const { client, receipts } = createFakeClient();
  const result = await runClearDebrisSmoke(client, receipts, validConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "debris_cleared");
  assert.equal(result.receipt.state, "succeeded");
  assert.equal(result.receipt.reasonCode, "debris_cleared");
  assert.match(result.receipt.evidence.detail, /clump_removed=true/);
  assert.equal(result.target.targetId, FIXTURE_TARGET.targetId);
  assert.equal(result.freshPostcondition.targetGone, true);
  assert.equal(result.after.debrisTargets, 0);
  assert.equal(result.trace.length, 11);
  assert.equal(result.trace[0].phase, "travel");
  assert.equal(result.trace[1].phase, "travel_terminal");
  assert.equal(result.trace[2].phase, "equip_pickaxe");
  for (let hit = 1; hit <= 8; hit += 1) {
    const entry = result.trace[2 + hit];
    assert.equal(entry.phase, `clear_debris_hit_${hit}`);
    assert.equal(entry.receipt.state, hit === 8 ? "succeeded" : "partially_succeeded");
    assert.equal(entry.receipt.reasonCode, hit === 8 ? "debris_cleared" : "debris_hit");
    assert.match(entry.receipt.evidence.detail, new RegExp(`health_before=${9 - hit}`));
    assert.match(entry.receipt.evidence.detail, new RegExp(`health_after=${hit === 8 ? 0 : 8 - hit}`));
    assert.match(entry.receipt.evidence.detail, new RegExp(`clump_removed=${hit === 8}`));
  }
});

test("clear-debris runner moves to the bounded fixture approach when travel lands off-approach", async () => {
  const { client, receipts } = createFakeClient({ landingTile: { x: 63, y: 16 } });
  const result = await runClearDebrisSmoke(client, receipts, validConfig());
  assert.equal(result.state, "passed");
  const phases = result.trace.map((entry) => entry.phase);
  assert.ok(phases.includes("move_to_clear_debris_fixture_anchor"));
  assert.ok(phases.includes("move_to_clear_debris_fixture_anchor_terminal"));
  assert.equal(result.trace.length, 13);
});

test("clear-debris runner reports blocked when the postcondition target persists", async () => {
  const { client, receipts } = createFakeClient({ removeOnLastHit: false });
  const result = await runClearDebrisSmoke(client, receipts, validConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "clear_debris_postcondition_mismatch");
  assert.equal(result.freshPostcondition.targetGone, false);
});

test("clear-debris runner rejects a non-frozen action policy before any request", async () => {
  const bad = validConfig();
  bad.EnabledActions = ["move_to_tile", "travel", "equip_tool"];
  await assert.rejects(runClearDebrisSmoke({}, [], bad), /native_local_clear_debris_action_policy_invalid/);
});
