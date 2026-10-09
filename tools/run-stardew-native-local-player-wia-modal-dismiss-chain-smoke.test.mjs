import assert from "node:assert/strict";
import test from "node:test";
import { runWiaModalDismissChain } from "./run-stardew-native-local-player-wia-modal-dismiss-chain-smoke.mjs";

const REAL_REMEDY = { action: "stardew_dismiss_modal", guidance: "Call 'stardew_dismiss_modal'" };
/** A host-module loader whose gateway admits, so a guard test can move past phase 2a. */
function hostLoader({ gateway = () => null, remedy = () => REAL_REMEDY } = {}) {
  return async (name) =>
    name === "protocol.js"
      ? { validateExecutionRequest: gateway }
      : { describeBodyHoldRefusal: remedy };
}

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
        } else if (moveCalls === 2) {
          // phase 2a: a FRESH move issued while the modal is still mounted. The Mod names the hold, and the
          // request reaches the Mod at all only because the gateway no longer refuses a held body itself.
          receipts.push({
            requestId: request.requestId,
            executionId,
            state: "rejected",
            reasonCode: "actor_held_by_modal",
            revision: 11,
            evidence: { detail: "modal_type=DialogueBox;action_owned=false;is_question=false;can_move=false" },
          });
          // A TryStart refusal is an IMMEDIATE terminal on the wire, so return it rather than falling
          // through to the accepted shape below.
          return {
            requestId: request.requestId,
            executionId,
            state: "rejected",
            reasonCode: "actor_held_by_modal",
            revision: 11,
            evidence: { detail: "modal_type=DialogueBox;action_owned=false;is_question=false;can_move=false" },
          };
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
  const result = await runWiaModalDismissChain(client, receipts, config, { loadHostModule: hostLoader() });
  assert.equal(
    result.state,
    "passed",
    `blocked: ${result.reasonCode} breakpoint=${result.breakpointOk} held=${result.heldWhileModalOpen} ` +
      `gateway=${String(result.gatewayVerdict)} named=${result.holdNamed} remedy=${result.holdRemedyOk} ` +
      `dismiss=${result.dismissOk}`,
  );
  assert.equal(result.reasonCode, "modal_dismiss_chain_complete");
  assert.equal(result.breakpointOk, true);
  assert.equal(result.heldWhileModalOpen, true, "the actor really is held; this is the state the gateway used to refuse");
  assert.equal(result.gatewayVerdict, null, "the gateway must ADMIT a held body and let the Mod name the hold");
  assert.equal(result.holdNamed, true);
  assert.equal(result.holdRemedyOk, true);
  assert.equal(result.holdRemedy.action, "stardew_dismiss_modal");
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
  const result = await runWiaModalDismissChain(client, receipts, config, { loadHostModule: hostLoader() });
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
  const result = await runWiaModalDismissChain(client, receipts, config, { loadHostModule: hostLoader() });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "dismiss_missing:state=rejected;reason=no_modal_present");
});
test("wia dismiss chain fails closed when the gateway refuses the held body itself", async () => {
  // The regression this phase exists for: a gateway that decides body actionability on its own answer
  // takes the decision away from the Mod, which is the authority that can name the hold.
  const { client, receipts } = makeClient();
  const result = await runWiaModalDismissChain(client, receipts, config, {
    loadHostModule: hostLoader({ gateway: () => "player_not_actionable" }),
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.gatewayVerdict, "player_not_actionable");
});

test("wia dismiss chain fails closed when the hold is not named", async () => {
  // A rejection that does not name the hold leaves the Agent with nothing to act on, which is the defect
  // the whole change removes - so the gate must not pass on it.
  const { client, receipts } = makeClient();
  const originalExecute = client.execute;
  client.execute = async (request) => {
    const receipt = await originalExecute(request);
    if (receipt.reasonCode === "actor_held_by_modal")
      return { ...receipt, reasonCode: "player_not_actionable", evidence: { detail: "can_move=false" } };
    return receipt;
  };
  const result = await runWiaModalDismissChain(client, receipts, config, { loadHostModule: hostLoader() });
  assert.equal(result.state, "blocked");
  assert.equal(result.holdNamed, false);
});

test("wia dismiss chain fails closed when the remedy names the wrong tool", async () => {
  const { client, receipts } = makeClient();
  const result = await runWiaModalDismissChain(client, receipts, config, {
    loadHostModule: hostLoader({
      remedy: () => ({ action: "stardew_move_to_tile", guidance: "Walk somewhere else" }),
    }),
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.holdRemedyOk, false);
});
