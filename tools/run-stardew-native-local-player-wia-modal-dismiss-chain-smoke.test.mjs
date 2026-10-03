import assert from "node:assert/strict";
import test from "node:test";
import { runWiaModalDismissChain } from "./run-stardew-native-local-player-wia-modal-dismiss-chain-smoke.mjs";

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: ["dismiss_modal"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_wia_modal_dismiss_chain_v1",
  },
};

const CAPABILITIES = ["cancel_active_execution", "move_to_tile", "observe_scene", "travel", "dismiss_modal"];

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

function makeClient(overrides = {}) {
  let snapshot = baseSnapshot(5);
  const receipts = [];
  let moveCalls = 0;
  let dismissCalls = 0;
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "move_to_tile") {
        moveCalls++;
        const executionId = `move-exec-${moveCalls}`;
        if (moveCalls === 1) {
          // phase 1: interrupted by the fixture modal.
          receipts.push({
            requestId: request.requestId,
            executionId,
            state: "invalidated",
            reasonCode: "modal_interrupted",
            revision: 10,
            evidence: { detail: "interrupted_by=DialogueBox;target_tile=35,35;interrupted_at=20,20;remaining_distance=15;revision=7" },
          });
          snapshot = baseSnapshot(10, { actionable: false, activeExecution: null });
        } else {
          // phase 3: resumed success.
          receipts.push({
            requestId: request.requestId,
            executionId,
            state: "succeeded",
            reasonCode: "target_reached",
            revision: 20,
            evidence: { detail: "location=Farm;tile=35,35" },
          });
          snapshot = baseSnapshot(20, {
            tile: { x: 35, y: 35 },
            soilTiles: [],
          });
        }
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId,
          state: "accepted",
          reasonCode: "accepted",
          revision: request.expectedRevision + 1,
          evidence: { detail: "target=35,35" },
        };
      }
      if (request.action === "dismiss_modal") {
        dismissCalls++;
        const executionId = `dismiss-exec-${dismissCalls}`;
        assert.deepEqual(request.args, {}, "dismiss_modal carries no arguments (exact-shape contract)");
        // The Mod treats dismiss_modal as instantaneous: the immediate bridge
        // response IS the terminal, exactly as the live gate observed.
        snapshot = baseSnapshot(15, { actionable: true, activeExecution: null });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId,
          state: "succeeded",
          reasonCode: "modal_dismissed",
          revision: 15,
          evidence: { detail: "modal_type=DialogueBox;dismissed=true" },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  return { client, receipts, counters: { moveCalls, dismissCalls } };
}

test("wia dismiss chain passes the full interrupt → dismiss → resume loop", async () => {
  const { client, receipts, counters } = makeClient();
  const result = await runWiaModalDismissChain(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "modal_dismiss_chain_complete");
  assert.equal(result.breakpointOk, true);
  assert.equal(result.dismissOk, true);
  assert.equal(result.phases.interrupt.reasonCode, "modal_interrupted");
  assert.equal(result.phases.dismiss.reasonCode, "modal_dismissed");
  assert.equal(result.phases.resume.reasonCode, "target_reached");
  assert.equal(result.after.hasTile, true);
  assert.equal(result.after.activeExecution, null);
});

test("wia dismiss chain fails closed when the interrupt is not classified", async () => {
  const { client, receipts } = makeClient();
  // 篡改 phase-1 收据为 succeeded/target_reached → 不可能是 modal_interrupted
  const originalExecute = client.execute;
  client.execute = async (request) => {
    if (request.action === "move_to_tile" && receipts.length === 0) {
      const r = await originalExecute(request);
      receipts[receipts.length - 1] = {
        ...receipts[receipts.length - 1],
        state: "succeeded",
        reasonCode: "target_reached",
      };
      return r;
    }
    return originalExecute(request);
  };
  const result = await runWiaModalDismissChain(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "interrupt_missing:state=succeeded;reason=target_reached");
});

test("wia dismiss chain fails closed when the dismiss is not admitted", async () => {
  const { client, receipts } = makeClient();
  const originalExecute = client.execute;
  client.execute = async (request) => {
    if (request.action === "dismiss_modal") {
      // The Modal profile refuses: no modal present (already gone / world race).
      return {
        requestId: request.requestId,
        executionId: "dismiss-rejected",
        state: "rejected",
        reasonCode: "no_modal_present",
        revision: request.expectedRevision + 1,
        evidence: { detail: "no_modal_present" },
      };
    }
    return originalExecute(request);
  };
  const result = await runWiaModalDismissChain(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "dismiss_missing:state=rejected;reason=no_modal_present");
});