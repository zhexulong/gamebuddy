import assert from "node:assert/strict";
import test from "node:test";
import { runWiaAnimalProductInterruptSmoke } from "./run-stardew-native-local-player-wia-animal-product-smoke.mjs";

const SCENARIO = "native_wia_animal_product_interrupt_v1";
const CAPABILITIES = ["collect_animal_product", "dismiss_modal"];
const TARGET = {
  targetId: "animal-target-1",
  slot: 3,
  x: 10,
  y: 12,
  qualifiedProduceItemId: "(O)184",
  produceStack: 1,
  toolKind: "milk_pail",
};
const INTERRUPT_EXECUTION_ID = "collect-interrupt";
const RETRY_EXECUTION_ID = "collect-retry";

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  DeniedActions: [],
  DeniedActionFamilies: [],
  // dismiss_modal is the only experimental action in this fixture's set.
  ExperimentalActions: ["dismiss_modal"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: SCENARIO,
  },
};

function snapshot(revision, { actionable = true, targetPresent = true } = {}) {
  return {
    revision,
    location: "AnimalHouse",
    tile: { x: 11, y: 12 },
    actionable,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    animalProductTargets: targetPresent ? [{ ...TARGET }] : [],
  };
}

function acceptedEvidence(target) {
  return {
    detail: `location=AnimalHouse;target=${target.targetId};animal=7;bound_animal=7;tool=${target.toolKind};tool_tile=${target.x},${target.y};produce=${target.qualifiedProduceItemId};produce_stack=${target.produceStack}`,
  };
}

function successEvidence(target) {
  return {
    detail: `location=AnimalHouse;target=${target.targetId};animal=7;tool=${target.toolKind};produce=${target.qualifiedProduceItemId};produce_stack=${target.produceStack};produce_cleared=true;inventory_before=0;inventory_after=1;inventory_gained=true;animation_complete=true`,
  };
}

/**
 * Faithful native-local fake for the ACTIVE ANIMAL PRODUCT interruption chain:
 *   - collect_animal_product is CROSS-TICK: execute returns the accepted receipt
 *     and the journal terminal (invalidated / succeeded) lands in the receipt
 *     buffer, exactly like the ExecutionManager's deferred completion path.
 *   - dismiss_modal is INSTANTANEOUS: its execute response IS the terminal.
 *   - lateDuplicateTerminal models the double-termination bug this runner must
 *     fail closed on: after the invalidated receipt, the deferred completion path
 *     mints a SECOND terminal for the SAME executionId on a later tick.
 */
function makeClient({ interruptReason = "modal_interrupted", retryFailure = false, lateDuplicateTerminal = false } = {}) {
  let current = snapshot(5);
  let collectCalls = 0;
  let dismissCalls = 0;
  let pendingLateDuplicate = false;
  let interruptRequestId = "";
  const receipts = [];
  const client = {
    state: { snapshot: current },
    observe: async () => {
      if (pendingLateDuplicate) {
        pendingLateDuplicate = false;
        // The deferred native tool animation finished on a later tick; the
        // completion path releases the slot.
        current = snapshot(12, { actionable: false });
        client.state.snapshot = current;
        if (lateDuplicateTerminal) {
          receipts.push({
            requestId: interruptRequestId,
            executionId: INTERRUPT_EXECUTION_ID,
            state: "succeeded",
            reasonCode: "animal_product_collected",
            revision: 12,
            evidence: successEvidence(TARGET),
          });
        }
      }
      return current;
    },
    execute: async (request) => {
      if (request.action === "collect_animal_product") {
        collectCalls++;
        assert.deepEqual(request.args, {
          slot: TARGET.slot,
          x: TARGET.x,
          y: TARGET.y,
          expectedTargetId: TARGET.targetId,
        });
        if (collectCalls === 1) {
          interruptRequestId = request.requestId;
          current = snapshot(10, { actionable: false });
          client.state.snapshot = current;
          receipts.push({
            requestId: request.requestId,
            executionId: INTERRUPT_EXECUTION_ID,
            state: "invalidated",
            reasonCode: interruptReason,
            revision: 10,
            evidence: { detail: "native_animation_pending=true" },
          });
          pendingLateDuplicate = true;
          return {
            requestId: request.requestId,
            executionId: INTERRUPT_EXECUTION_ID,
            state: "accepted",
            reasonCode: "accepted",
            revision: 10,
            evidence: acceptedEvidence(TARGET),
          };
        }
        current = snapshot(20, { actionable: true, targetPresent: false });
        client.state.snapshot = current;
        receipts.push({
          requestId: request.requestId,
          executionId: RETRY_EXECUTION_ID,
          state: retryFailure ? "failed" : "succeeded",
          reasonCode: retryFailure ? "animal_product_postcondition_unavailable" : "animal_product_collected",
          revision: 20,
          evidence: {
            detail: retryFailure
              ? `location=AnimalHouse;target=${TARGET.targetId};animal=7;tool=${TARGET.toolKind};produce=${TARGET.qualifiedProduceItemId};produce_stack=${TARGET.produceStack};produce_cleared=false;inventory_before=0;inventory_after=0;inventory_gained=false;animation_complete=false`
              : successEvidence(TARGET).detail,
          },
        });
        return {
          requestId: request.requestId,
          executionId: RETRY_EXECUTION_ID,
          state: "accepted",
          reasonCode: "accepted",
          revision: 20,
          evidence: acceptedEvidence(TARGET),
        };
      }
      if (request.action === "dismiss_modal") {
        dismissCalls++;
        assert.equal(dismissCalls, 1);
        assert.deepEqual(request.args, {});
        current = snapshot(15, { actionable: true });
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

test("wia animal-product interruption passes: single terminal, clean release, dismiss, retry success", async () => {
  const { client, receipts } = makeClient();
  const result = await runWiaAnimalProductInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "wia_animal_product_interrupt_retry_complete");
  assert.equal(result.phases.interrupt.reasonCode, "modal_interrupted");
  assert.equal(result.phases.dismiss.reasonCode, "modal_dismissed");
  assert.equal(result.phases.retry.reasonCode, "animal_product_collected");
  assert.equal(result.interruptEvidence.native_animation_pending, "true");
  assert.equal(result.interruptTerminalCount, 1);
  assert.equal(result.retryTerminalCount, 1);
  assert.equal(result.releaseOk, true);
  assert.equal(result.retryPostcondition, true);
  assert.equal(result.before.hasTile, true);
  assert.equal(result.released.activeExecution, null);
  assert.equal(result.after.activeExecution, null);
});

test("wia animal-product interruption fails closed when the interrupt is not modal_interrupted", async () => {
  const { client, receipts } = makeClient({ interruptReason: "event_started" });
  const result = await runWiaAnimalProductInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "interrupt_missing:state=invalidated;reason=event_started");
});

test("wia animal-product interruption fails closed when the retry does not succeed", async () => {
  const { client, receipts } = makeClient({ retryFailure: true });
  const result = await runWiaAnimalProductInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "retry_failed:state=failed;reason=animal_product_postcondition_unavailable");
});

test("wia animal-product interruption fails closed when the deferred completion mints a second terminal", async () => {
  const { client, receipts } = makeClient({ lateDuplicateTerminal: true });
  const result = await runWiaAnimalProductInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^interrupt_double_terminal:count=2;execution=collect-interrupt$/);
});
