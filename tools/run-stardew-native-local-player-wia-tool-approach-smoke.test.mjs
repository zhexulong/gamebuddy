import assert from "node:assert/strict";
import test from "node:test";
import { runWiaToolApproachInterruptSmoke } from "./run-stardew-native-local-player-wia-tool-approach-smoke.mjs";

const SCENARIO = "native_wia_tool_approach_interrupt_v1";
const CAPABILITIES = ["chop_tree_source", "dismiss_modal", "equip_tool"];
const TREE = {
  targetId: "tree_chop_source_0123456789abcdef",
  location: "Farm",
  x: 14,
  y: 12,
  treeType: "1",
  growthStage: 5,
  health: 1,
  stump: false,
  moss: false,
  tapped: false,
};

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "0123456789abcdef0123456789abcdef",
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: ["dismiss_modal"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: SCENARIO,
  },
};

/** The actor stands Chebyshev-2 from the tree, so only the approach leg is possible. */
function snapshot(revision, extra = {}) {
  return {
    revision,
    location: "Farm",
    tile: { x: 12, y: 12 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    toolSlots: [{ slot: 2, label: "(T)Axe" }],
    warps: [],
    treeChopSourceTargets: [{ ...TREE }],
    treeChopResultTargets: [],
    ...extra,
  };
}

const APPROACH_ACCEPTED_EVIDENCE =
  `location=Farm;target=${TREE.targetId};tile=14,12;distance=2;reach=1;approach=adjacent`;
// The live shape for this slot: `RecordControllerTransition` mints the terminal for
// a non-progress controller transition, so the receipt carries the approach slot's
// own vocabulary plus the WIA intent breakpoint forwarded through `body_evidence`
// (farmhandexecutioncontroller.cs:3627-3634). `native_animation_pending` is the
// ITEM-USE slot's field and must not appear here.
const INTERRUPT_EVIDENCE =
  `location=Farm;target=${TREE.targetId};tile=14,12;reach=1;approach=failed;body_evidence=interrupted_by=DialogueBox;target_tile=14,12;interrupted_at=12,12;remaining_distance=2;revision=6`;
const INTERRUPT_EVIDENCE_WITHOUT_BREAKPOINT =
  `location=Farm;target=${TREE.targetId};tile=14,12;reach=1;approach=failed;body_evidence=lifecycle_or_world_change`;
const RETRY_SUCCESS_EVIDENCE =
  `target=${TREE.targetId};tool=axe;slot=2;tree=1;health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true;stamina_before=270;stamina_after=268;stamina_delta=-2;expected_stamina_cost=2`;

function makeClient({ interruptReason = "modal_interrupted", interruptDetail = INTERRUPT_EVIDENCE, retryFailure = false } = {}) {
  let current = snapshot(5);
  let chopCalls = 0;
  const receipts = [];
  const client = {
    state: { snapshot: current, latestReceipt: null },
    observe: async () => current,
    execute: async (request) => {
      if (request.action === "equip_tool") {
        assert.deepEqual(request.args, { tool: "axe" }, "equip_tool args must be exactly { tool } (exact-shape contract)");
        return {
          requestId: request.requestId,
          executionId: "equip-axe",
          state: "succeeded",
          reasonCode: "tool_equipped",
          revision: 5,
          evidence: { detail: "tool=axe;slot=2" },
        };
      }
      if (request.action === "chop_tree_source") {
        chopCalls += 1;
        assert.deepEqual(
          request.args,
          { slot: 2, x: TREE.x, y: TREE.y, expectedTargetId: TREE.targetId },
          "chop_tree_source args must carry exactly { slot, x, y, expectedTargetId }",
        );
        if (chopCalls === 1) {
          // The approach is accepted across ticks; the fixture modal lands two
          // ticks later, so the terminal arrives as a fact, not as the response.
          const executionId = "chop-interrupt";
          current = snapshot(10, { actionable: false });
          client.state.snapshot = current;
          receipts.push({
            requestId: request.requestId,
            executionId,
            state: "invalidated",
            reasonCode: interruptReason,
            revision: 10,
            evidence: { detail: interruptDetail },
          });
          return {
            requestId: request.requestId,
            executionId,
            state: "accepted",
            reasonCode: "accepted",
            revision: 6,
            evidence: { detail: APPROACH_ACCEPTED_EVIDENCE },
          };
        }
        const executionId = retryFailure ? "chop-retry-failed" : "chop-retry";
        receipts.push({
          requestId: request.requestId,
          executionId,
          state: "running",
          reasonCode: "tool_approach_completed",
          revision: 19,
          evidence: { detail: "location=Farm;target=14,12" },
        });
        if (retryFailure) {
          current = snapshot(20);
          client.state.snapshot = current;
          receipts.push({
            requestId: request.requestId,
            executionId,
            state: "failed",
            reasonCode: "tree_source_chop_postcondition_unavailable",
            revision: 20,
            evidence: { detail: `target=${TREE.targetId};tool=axe;health_after=missing` },
          });
        } else {
          current = snapshot(20, {
            treeChopSourceTargets: [],
            treeChopResultTargets: [{ location: "Farm", x: TREE.x, y: TREE.y, treeType: TREE.treeType, health: 5, stump: true, moss: false, tapped: false }],
          });
          client.state.snapshot = current;
          receipts.push({
            requestId: request.requestId,
            executionId,
            state: "succeeded",
            reasonCode: "tree_source_chopped",
            revision: 20,
            evidence: { detail: RETRY_SUCCESS_EVIDENCE },
          });
        }
        return {
          requestId: request.requestId,
          executionId,
          state: "accepted",
          reasonCode: "accepted",
          revision: 13,
          evidence: { detail: APPROACH_ACCEPTED_EVIDENCE },
        };
      }
      if (request.action === "dismiss_modal") {
        assert.deepEqual(request.args, {}, "dismiss_modal args must be exactly {} (exact-shape contract)");
        // dismiss_modal is instantaneous: the bridge response IS the terminal.
        current = snapshot(12);
        client.state.snapshot = current;
        return {
          requestId: request.requestId,
          executionId: "dismiss-modal",
          state: "succeeded",
          reasonCode: "modal_dismissed",
          revision: 12,
          evidence: { detail: "modal_type=DialogueBox;dismissed=true" },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  return { client, receipts };
}

test("wia tool approach passes: interrupted walk, released slot, re-issued intent chops the tree", async () => {
  const { client, receipts } = makeClient();
  const result = await runWiaToolApproachInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "wia_tool_approach_interrupt_retry_complete");
  assert.equal(result.phases.interrupt.state, "invalidated");
  assert.equal(result.phases.interrupt.reasonCode, "modal_interrupted");
  assert.equal(result.phases.dismiss.reasonCode, "modal_dismissed");
  assert.equal(result.phases.retry.reasonCode, "tree_source_chopped");
  // The honest tool-approach shape: the slot's own disposition + reach, the WIA
  // intent breakpoint, and NO item-use `native_animation_pending`.
  assert.equal(result.interruptEvidence.approach, "failed");
  assert.equal(result.interruptEvidence.reach, "1");
  assert.equal(result.interruptEvidence.body_evidence, "interrupted_by=DialogueBox");
  assert.equal(result.interruptEvidence.interrupted_at, "12,12");
  assert.equal(result.interruptEvidence.native_animation_pending, undefined);
  assert.deepEqual(result.interruptSlotShape, {
    approachReported: true,
    reachOne: true,
    targetIdentity: true,
    targetTile: true,
  });
  assert.deepEqual(result.interruptBreakpoint, { modalSource: true, interruptedAtReported: true });
  assert.equal(result.releaseOk, true);
  assert.equal(result.released.activeExecution, null);
  assert.equal(result.retryApproachAnnounced, true);
  assert.equal(result.retryPostcondition, true);
  assert.equal(result.after.activeExecution, null);
  assert.equal(result.after.treeChopResultTargets.length, 1);
  assert.equal(result.before.treeChopSourceTargets.length, 1);
});

test("wia tool approach fails closed when the interruption is not modal_interrupted", async () => {
  const { client, receipts } = makeClient({ interruptReason: "event_started" });
  const result = await runWiaToolApproachInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "interrupt_missing:state=invalidated;reason=event_started");
  assert.equal(result.phases, undefined);
});

test("wia tool approach fails closed when the interrupt evidence drops the intent breakpoint", async () => {
  const { client, receipts } = makeClient({ interruptDetail: INTERRUPT_EVIDENCE_WITHOUT_BREAKPOINT });
  const result = await runWiaToolApproachInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^interrupt_intent_breakpoint_missing:/);
});

test("wia tool approach fails closed when the re-issued intent does not chop", async () => {
  const { client, receipts } = makeClient({ retryFailure: true });
  const result = await runWiaToolApproachInterruptSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "retry_failed:state=failed;reason=tree_source_chop_postcondition_unavailable");
});
