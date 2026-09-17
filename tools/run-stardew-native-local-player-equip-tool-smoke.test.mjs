import assert from "node:assert/strict";
import test from "node:test";
import { runEquipToolSmoke } from "./run-stardew-native-local-player-equip-tool-smoke.mjs";

function fixture({ terminal = {}, evidence = {}, observations } = {}) {
  const receipts = [];
  const before = {
    revision: 4,
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "equip_tool"],
    currentTool: "Axe",
    toolSlots: [{ slot: 0, label: "Axe" }, { slot: 1, label: "Hoe" }],
  };
  const after = { ...before, revision: 5, currentTool: "Hoe" };
  const reads = observations ? [...observations] : [before, after];
  const client = {
    state: { snapshot: before },
    observe: async () => {
      const snapshot = reads.shift() ?? after;
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async (request) => {
      assert.deepEqual({ action: request.action, args: request.args, expectedRevision: request.expectedRevision }, { action: "equip_tool", args: { tool: "hoe" }, expectedRevision: 4 });
      const accepted = { requestId: request.requestId, executionId: "equip-execution", state: "accepted", revision: 4 };
      receipts.push({
        requestId: request.requestId,
        executionId: "equip-execution",
        state: "succeeded",
        reasonCode: "tool_equipped",
        revision: 5,
        evidence: { detail: "tool=hoe;before=Axe;expected=Hoe;after=Hoe", ...evidence },
        ...terminal,
      });
      return accepted;
    },
  };
  return { client, receipts };
}

test("equip-tool v2 runner binds request, accepted/terminal identities, semantic evidence, and stable reread", async () => {
  const { client, receipts } = fixture();
  const result = await runEquipToolSmoke(client, receipts, {}, { toolCategory: "hoe" });
  assert.equal(result.state, "passed");
  assert.deepEqual(result.request.args, { tool: "hoe" });
  assert.equal(result.request.expectedRevision, 4);
  assert.deepEqual(result.accepted, { requestId: result.request.requestId, executionId: "equip-execution" });
  assert.equal(result.terminal.revision, result.postcondition.revision);
  assert.deepEqual(result.evidence, { tool: "hoe", before: "Axe", expected: "Hoe", after: "Hoe" });
});

test("equip-tool v2 accepts already_equipped as a deterministic success", async () => {
  const { client, receipts } = fixture({
    terminal: { reasonCode: "already_equipped", revision: 5 },
    evidence: { detail: "tool=hoe;before=Hoe;expected=Hoe;after=Hoe" },
    observations: [
      { revision: 4, actionable: true, activeExecution: null, capabilities: ["equip_tool"], currentTool: "Hoe", toolSlots: [{ slot: 1, label: "Hoe" }] },
      { revision: 5, actionable: true, activeExecution: null, capabilities: ["equip_tool"], currentTool: "Hoe", toolSlots: [{ slot: 1, label: "Hoe" }] },
    ],
  });
  const result = await runEquipToolSmoke(client, receipts, {}, { toolCategory: "hoe" });
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "already_equipped");
});

test("equip-tool v2 runner fails closed for wrong identity, missing/changed evidence, revision drift, and failed fresh reread", async () => {
  const cases = [
    fixture({ terminal: { requestId: "wrong-request", state: "failed" } }),
    fixture({ terminal: { executionId: "wrong-execution", state: "failed" } }),
    fixture({ terminal: { reasonCode: "tool_selected" } }),
    fixture({ terminal: { state: "failed" } }),
    fixture({ evidence: { detail: "tool=hoe;expected=Hoe;after=Hoe" } }),
    fixture({ evidence: { detail: "tool=hoe;before=Axe;expected=Hoe;after=Axe" } }),
    fixture({ terminal: { revision: 6 } }),
    fixture({ observations: [
      { revision: 4, actionable: true, activeExecution: null, capabilities: ["equip_tool"], currentTool: "Axe", toolSlots: [{ slot: 1, label: "Hoe" }] },
      { revision: 6, actionable: true, activeExecution: null, capabilities: ["equip_tool"], currentTool: "Axe", toolSlots: [{ slot: 1, label: "Hoe" }] },
    ] }),
  ];
  for (const value of cases) {
    const result = await runEquipToolSmoke(value.client, value.receipts, {}, { terminalTimeoutMs: 5, postconditionTimeoutMs: 5, toolCategory: "hoe" });
    assert.equal(result.state, "blocked");
  }
});