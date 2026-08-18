import assert from "node:assert/strict";
import test from "node:test";
import { runEquipToolSmoke } from "./run-stardew-native-local-player-equip-tool-smoke.mjs";

test("equip-tool runner uses shared dispatch and fresh tool reread", async () => {
  let snapshot = {
    revision: 4,
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "equip_tool"],
    currentTool: "Axe",
    toolSlots: [
      { slot: 0, label: "Axe" },
      { slot: 1, label: "Hoe" },
    ],
  };
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      assert.equal(request.action, "equip_tool");
      assert.equal(request.expectedRevision, 4);
      assert.deepEqual(request.args, { slot: 1 });
      snapshot = { ...snapshot, revision: 5, currentTool: "Hoe" };
      client.state.snapshot = snapshot;
      return {
        requestId: request.requestId,
        executionId: "equip-execution",
        state: "succeeded",
        reasonCode: "tool_selected",
        revision: 5,
        evidence: { detail: "expected=Hoe;after=Hoe" },
      };
    },
  };

  const result = await runEquipToolSmoke(client, {});
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "tool_selected");
  assert.equal(result.after.currentTool, "Hoe");
});
