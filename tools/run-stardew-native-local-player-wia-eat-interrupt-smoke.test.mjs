import assert from "node:assert/strict";
import test from "node:test";
import { runWiaEatInterruptSmoke } from "./run-stardew-native-local-player-wia-eat-interrupt-smoke.mjs";

const SCENARIO = "native_wia_eat_interrupt_v1";
const FOOD = { slot: 5, qualifiedItemId: "(O)216", edibility: 25, isDrink: false };
const CAPABILITIES = ["cancel_active_execution", "dismiss_modal", "inspect_self", "use_item"];

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
    FixtureScenario: SCENARIO,
  },
};

function snapshot(revision, stack, extra = {}) {
  return {
    revision,
    location: "FarmHouse",
    tile: { x: 5, y: 5 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    foodTargets: stack > 0 ? [{ ...FOOD, stack }] : [],
    ...extra,
  };
}

function useAccepted(request, executionId, stackBefore) {
  assert.deepEqual(request.args, {
    slot: FOOD.slot,
    expectedQualifiedItemId: FOOD.qualifiedItemId,
  });
  return {
    requestId: request.requestId,
    executionId,
    state: "accepted",
    reasonCode: "accepted",
    revision: request.expectedRevision + 1,
    evidence: {
      detail: `slot=${FOOD.slot};item=${FOOD.qualifiedItemId};stack_before=${stackBefore};edibility=${FOOD.edibility};drink=false`,
    },
  };
}

const ITEM_SUCCESS_EVIDENCE =
  "slot=5;item=(O)216;stack_before=1;stack_after=0;edibility=25;drink=false;stamina_before=100;stamina_after=125;health_before=100;health_after=100;animation_complete=true";

function makeClient({ interruptReason = "modal_interrupted", retryFailure = false } = {}) {
  let current = snapshot(5, 2);
  let useCalls = 0;
  let dismissCalls = 0;
  const receipts = [];
  const client = {
    state: { snapshot: current },
    observe: async () => current,
    execute: async (request) => {
      if (request.action === "use_item") {
        useCalls++;
        if (useCalls === 1) {
          current = snapshot(10, 1, { actionable: false });
          client.state.snapshot = current;
          receipts.push({
            requestId: request.requestId,
            executionId: "use-interrupt",
            state: "invalidated",
            reasonCode: interruptReason,
            revision: 10,
            evidence: { detail: "native_animation_pending=true" },
          });
          return useAccepted(request, "use-interrupt", 2);
        }
        current = snapshot(20, retryFailure ? 1 : 0);
        client.state.snapshot = current;
        receipts.push({
          requestId: request.requestId,
          executionId: "use-retry",
          state: retryFailure ? "failed" : "succeeded",
          reasonCode: retryFailure ? "item_use_postcondition_unavailable" : "item_used",
          revision: 20,
          evidence: { detail: retryFailure ? "native_animation_pending=true" : ITEM_SUCCESS_EVIDENCE },
        });
        return useAccepted(request, "use-retry", 1);
      }
      if (request.action === "dismiss_modal") {
        dismissCalls++;
        assert.equal(dismissCalls, 1);
        assert.deepEqual(request.args, {});
        current = snapshot(15, 1);
        client.state.snapshot = current;
        return {
          requestId: request.requestId,
          executionId: "dismiss-modal",
          state: "succeeded",
          reasonCode: "modal_dismissed",
          revision: 15,
          evidence: { detail: "modal_type=DialogueBox;dismissed=true" },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  return { client, receipts };
}

test("wia eat interruption passes: native consumption, modal invalidation, dismiss, and retry success", async () => {
  const { client, receipts } = makeClient();
  const result = await runWiaEatInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "wia_eat_interrupt_retry_complete");
  assert.equal(result.phases.interrupt.reasonCode, "modal_interrupted");
  assert.equal(result.phases.dismiss.reasonCode, "modal_dismissed");
  assert.equal(result.phases.retry.reasonCode, "item_used");
  assert.equal(result.interruptEvidence.native_animation_pending, "true");
  assert.equal(result.releaseOk, true);
  assert.equal(result.retryPostcondition, true);
  assert.equal(result.before.hasTile, true);
  assert.equal(result.released.activeExecution, null);
  assert.equal(result.after.activeExecution, null);
});

test("wia eat interruption fails closed when the interrupt is not modal_interrupted", async () => {
  const { client, receipts } = makeClient({ interruptReason: "event_started" });
  const result = await runWiaEatInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "interrupt_missing:state=invalidated;reason=event_started");
});

test("wia eat interruption fails closed when the retry does not succeed", async () => {
  const { client, receipts } = makeClient({ retryFailure: true });
  const result = await runWiaEatInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "retry_failed:state=failed;reason=item_use_postcondition_unavailable");
});
