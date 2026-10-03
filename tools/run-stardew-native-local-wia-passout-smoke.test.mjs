import assert from "node:assert/strict";
import test from "node:test";
import { runWiaPassOutSmoke } from "./run-stardew-native-local-wia-passout-smoke.mjs";

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
    FixtureScenario: "native_wia_pass_out_v1",
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

function makeClient(terminalState, terminalReason) {
  let snapshot = baseSnapshot(5);
  const receipts = [];
  let moveCalls = 0;
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "move_to_tile") {
        moveCalls++;
        const executionId = `passout-exec-${moveCalls}`;
        // The immediate bridge response is the accepted (async) receipt; the
        // terminal lands on the journal through the normal receipt buffer.
        receipts.push({
          requestId: request.requestId,
          executionId,
          state: terminalState,
          reasonCode: terminalReason,
          revision: 10,
          evidence: { detail: "stamina=-20;time_of_day=1200;tile=30,30;revision=10" },
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

test("wia pass-out runner passes on invalidated/pass_out with body facts", async () => {
  const { client, receipts } = makeClient("invalidated", "pass_out");
  const result = await runWiaPassOutSmoke(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "pass_out");
  assert.equal(result.receipt.reasonCode, "pass_out");
  assert.equal(result.evidenceOk, true);
  assert.equal(result.evidence.stamina, "-20");
  assert.equal(result.evidence.time_of_day, "1200");
  assert.equal(result.evidence.tile, "30,30");
  assert.deepEqual(result.target, { x: 35, y: 35, distance: 15 });
});

test("wia pass-out runner fails closed when the terminal is an action fault", async () => {
  const { client, receipts } = makeClient("succeeded", "target_reached");
  const result = await runWiaPassOutSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "wia_pass_out_missing:state=succeeded;reason=target_reached");
});

test("wia pass-out runner fails closed on wrong reasonCode", async () => {
  const { client, receipts } = makeClient("invalidated", "modal_interrupted");
  const result = await runWiaPassOutSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "wia_pass_out_missing:state=invalidated;reason=modal_interrupted");
});