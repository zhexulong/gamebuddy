import assert from "node:assert/strict";
import test from "node:test";
import { runWiaModalInterruptSmoke } from "./run-stardew-native-local-wia-modal-interrupt-smoke.mjs";

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
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_wia_modal_interrupt_v1",
  },
};

const CAPABILITIES = ["cancel_active_execution", "move_to_tile", "observe_scene", "travel"];

function baseSnapshot(revision, extra) {
  return {
    revision,
    location: "Farm",
    tile: { x: 20, y: 20 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    warps: [],
    soilTiles: [
      { x: 20, y: 20 },
      { x: 34, y: 34 },
      { x: 35, y: 35 },
    ],
    ...extra,
  };
}

function makeClient(terminalState, terminalReason, evidence) {
  let snapshot = baseSnapshot(5);
  const receipts = [];
  let moveCalls = 0;
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "move_to_tile") {
        moveCalls++;
        const executionId = `modal-exec-${moveCalls}`;
        receipts.push({
          requestId: request.requestId,
          executionId,
          state: terminalState,
          reasonCode: terminalReason,
          revision: 10,
          evidence,
        });
        snapshot = baseSnapshot(10, {
          actionable: false,
          activeExecution: { state: "invalidated", reasonCode: terminalReason, executionId },
        });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId,
          state: "accepted",
          reasonCode: "accepted",
          revision: 9,
          evidence: { detail: "target=34,34" },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  return { client, receipts };
}

const MODAL_EVIDENCE = { detail: "interrupted_by=DialogueBox;target_tile=34,34;interrupted_at=20,20;remaining_distance=14;revision=10" };

test("wia modal-interrupt runner passes on invalidated/modal_interrupted with the intent breakpoint", async () => {
  const { client, receipts } = makeClient("invalidated", "modal_interrupted", MODAL_EVIDENCE);
  const result = await runWiaModalInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "modal_interrupted");
  assert.equal(result.receipt.reasonCode, "modal_interrupted");
  assert.equal(result.evidenceOk, true);
  assert.equal(result.evidence.interrupted_by, "DialogueBox");
  assert.equal(result.evidence.target_tile, "34,34");
  assert.equal(result.evidence.interrupted_at, "20,20");
  assert.equal(result.evidence.remaining_distance, "14");
});

test("wia modal-interrupt runner fails closed when evidence lacks the breakpoint", async () => {
  const { client, receipts } = makeClient("invalidated", "modal_interrupted", {
    detail: "interrupted_by=DialogueBox", // no target_tile / interrupted_at / remaining_distance
  });
  const result = await runWiaModalInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "wia_modal_interrupt_postcondition_mismatch");
});

test("wia modal-interrupt runner fails closed on wrong reasonCode", async () => {
  const { client, receipts } = makeClient("invalidated", "pass_out", MODAL_EVIDENCE);
  const result = await runWiaModalInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "wia_modal_interrupt_missing:state=invalidated;reason=pass_out");
});