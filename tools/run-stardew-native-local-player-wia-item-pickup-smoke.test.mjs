import assert from "node:assert/strict";
import test from "node:test";
import { runWiaItemPickupInterruptSmoke } from "./run-stardew-native-local-player-wia-item-pickup-smoke.mjs";

const SCENARIO = "native_wia_item_pickup_interrupt_v1";
const TARGET = { x: 23, y: 20, targetId: "item_wia_pickup", qualifiedItemId: "(O)388", stack: 1 };
const CAPABILITIES = ["dismiss_modal", "pickup_item"];
const TIMEOUTS = { terminalTimeoutMs: 500, postconditionTimeoutMs: 500 };

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

const INTERRUPT_EVIDENCE =
  "location=Farm;target=item_wia_pickup;tile=23,20;native_auto_collect_pending=false;" +
  "body_evidence=interrupted_by=DialogueBox;target_tile=23,20;interrupted_at=20,20;remaining_distance=3;revision=1";

const PICKED_UP_EVIDENCE =
  "location=Farm;target=item_wia_pickup;tile=23,20;item=(O)388;stack=1;native_auto_collect=true;" +
  "chunk_removed=true;inventory_before=0;inventory_after=1";

function snapshot(revision, { actionable, delivery, extra = {} }) {
  return {
    revision,
    location: "Farm",
    tile: { x: 20, y: 20 },
    actionable,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    itemTargets: delivery ? [] : [{ ...TARGET }],
    ...extra,
  };
}

/**
 * The Mod's own shapes are modelled faithfully where they carry the proof:
 * `pickup_item` is a two-lifecycle action (an accepted approach now, the durable
 * journal terminal on a later game update), while `dismiss_modal` is a
 * synchronous modal call whose bridge response IS the terminal.
 */
function makeClient({
  interruptState = "invalidated",
  interruptReason = "modal_interrupted",
  retryState = "succeeded",
  retryReason = "item_picked_up",
} = {}) {
  let current = snapshot(5, { actionable: true, delivery: false });
  let pickupCalls = 0;
  let dismissCalls = 0;
  const receipts = [];
  const client = {
    state: { snapshot: current },
    observe: async () => current,
    execute: async (request) => {
      if (request.action === "pickup_item") {
        pickupCalls += 1;
        assert.deepEqual(
          request.args,
          {
            x: TARGET.x,
            y: TARGET.y,
            expectedQualifiedItemId: TARGET.qualifiedItemId,
            expectedTargetId: TARGET.targetId,
          },
          "pickup_item args must carry exactly { x, y, expectedQualifiedItemId, expectedTargetId } (exact-shape contract)",
        );
        const executionId = `pickup-exec-${pickupCalls}`;
        const interruptLeg = pickupCalls === 1;
        const state = interruptLeg ? interruptState : retryState;
        const reasonCode = interruptLeg ? interruptReason : retryReason;
        const delivered = state === "succeeded" && reasonCode === "item_picked_up";
        // The terminal is journaled on a later game update, exactly like the
        // Mod's body loop: the accepted response never carries it.
        setTimeout(() => {
          current = snapshot(interruptLeg ? 10 : 20, {
            actionable: !interruptLeg,
            delivery: delivered,
          });
          client.state.snapshot = current;
          receipts.push({
            requestId: request.requestId,
            executionId,
            state,
            reasonCode,
            revision: current.revision,
            evidence: { detail: delivered ? PICKED_UP_EVIDENCE : INTERRUPT_EVIDENCE },
          });
        }, 0);
        return {
          requestId: request.requestId,
          executionId,
          state: "accepted",
          reasonCode: "accepted",
          revision: request.expectedRevision + 1,
          evidence: {
            detail:
              "location=Farm;target=item_wia_pickup;tile=23,20;item=(O)388;stack=1;" +
              "inventory_before=0;native_auto_collect=true",
          },
        };
      }
      if (request.action === "dismiss_modal") {
        dismissCalls += 1;
        assert.equal(dismissCalls, 1);
        assert.deepEqual(request.args, {});
        current = snapshot(15, { actionable: true, delivery: false });
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
  return { client, receipts, counters: () => ({ pickupCalls, dismissCalls }) };
}

test("wia item pickup passes: approach interrupted, slot released, retry delivers the chunk", async () => {
  const { client, receipts, counters } = makeClient();
  const result = await runWiaItemPickupInterruptSmoke(client, receipts, config, TIMEOUTS);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "wia_item_pickup_interrupt_retry_complete");
  assert.equal(result.phases.interrupt.reasonCode, "modal_interrupted");
  assert.equal(result.phases.dismiss.reasonCode, "modal_dismissed");
  assert.equal(result.phases.retry.reasonCode, "item_picked_up");
  assert.deepEqual(result.interruptShape, {
    interruptedBy: true,
    targetIdentity: true,
    targetTile: true,
    breakpointTile: true,
    nativeCollectNotPending: true,
  });
  assert.equal(result.releaseOk, true);
  assert.equal(result.retryPostcondition, true);
  assert.equal(result.inventoryDelta, 1);
  assert.equal(result.targetGone, true);
  assert.equal(result.released.activeExecution, null);
  assert.equal(result.after.activeExecution, null);
  assert.equal(result.before.itemTargets.length, 1);
  assert.equal(result.after.itemTargets.length, 0);
  // interrupt + retry drive two distinct requests through the same action; the
  // released slot is what makes the second one acceptable at all.
  assert.deepEqual(counters(), { pickupCalls: 2, dismissCalls: 1 });
  assert.notEqual(result.phases.interrupt.revision, result.phases.retry.revision);
});

test("wia item pickup fails closed when the interruption is not modal_interrupted", async () => {
  const { client, receipts } = makeClient({ interruptReason: "event_started" });
  const result = await runWiaItemPickupInterruptSmoke(client, receipts, config, TIMEOUTS);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "interrupt_missing:state=invalidated;reason=event_started");
});

test("wia item pickup reports blocked (never passed) when magnetism wins the race", async () => {
  // The world finished the pickup before the modal could cut the walk: this is
  // NOT an interruption proof, so it must be reported as an explicit race.
  const { client, receipts } = makeClient({
    interruptState: "succeeded",
    interruptReason: "item_picked_up",
  });
  const result = await runWiaItemPickupInterruptSmoke(client, receipts, config, TIMEOUTS);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^interrupt_magnet_race_won:state=succeeded;reason=item_picked_up/);
  assert.equal(result.phases, undefined);
});

test("wia item pickup fails closed when the re-issued pickup does not deliver", async () => {
  const { client, receipts } = makeClient({
    retryState: "uncertain",
    retryReason: "item_pickup_postcondition_unavailable",
  });
  const result = await runWiaItemPickupInterruptSmoke(client, receipts, config, TIMEOUTS);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "retry_failed:state=uncertain;reason=item_pickup_postcondition_unavailable");
});
