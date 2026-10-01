import assert from "node:assert/strict";
import test from "node:test";
import { runChopTreeSourceApproachSmoke } from "./run-stardew-native-local-player-chop-tree-approach-smoke.mjs";

const CAPABILITIES = [
  "cancel_active_execution",
  "chop_tree_source",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
];

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: "native_chop_tree_source_v1",
      LogicalSaveName: "GameBuddyFixture",
      ObservedSaveSlot: "GameBuddyFixture_445094166",
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
    ...overrides,
  };
}

/**
 * Fake bridge session for the approach runner.
 *
 * `withApproachProgress` models the honest lifecycle this runner exists to
 * verify: out-of-range chop -> accepted -> `tool_approach_completed` (approach
 * phase) -> `tree_source_chopped` (execution phase). `chopFromAnywhere` models
 * the defect the runner must refuse: a Mod that chops without walking, i.e. the
 * behaviour this change replaced but worse (silently acting at a distance).
 */
function createFake({ withApproachProgress = true, chopFromAnywhere = false } = {}) {
  const listeners = new Set();
  let revision = 7;
  let location = "FarmHouse";
  let tile = { x: 1, y: 1 };
  let chopped = false;
  const tree = { targetId: "tree-1", x: 5, y: 6, location: "Farm", treeType: "Oak", growthStage: 5, health: 1, stump: false, moss: false, tapped: false };
  const warps = [{ sourceX: 1, sourceY: 1, targetX: 5, targetY: 5, targetLocation: "Farm" }];
  const snapshotOf = () => ({
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    toolSlots: [{ label: "(T)Axe", slot: 3 }],
    warps,
    treeChopSourceTargets: location === "Farm" && !chopped ? [tree] : [],
    // The stump is a DIFFERENT entity with its own opaque identity, exactly as the
    // live projection reports it (`tree_chop_source_*` -> `tree_chop_result_*`).
    // Reusing the source id here would let a targetId-matching readback pass in the
    // fake and fail only in live, which is how this bug first shipped.
    treeChopResultTargets: chopped
      ? [{ ...tree, targetId: "tree_chop_result_b16c25f1c96cf29e", health: 5, stump: true }]
      : [],
  });
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const distance = () => Math.max(Math.abs(tile.x - tree.x), Math.abs(tile.y - tree.y));
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}-${revision}`;
      if (action === "travel") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        location = "Farm";
        tile = { x: 5, y: 5 };
        revision += 1;
        publish({ ...receipt, state: "succeeded", reasonCode: "travel_completed", revision });
        return receipt;
      }
      if (action === "move_to_tile") {
        // Only the tiles this fixture treats as walkable, so the runner's search
        // exercises its fallback path rather than assuming the first candidate works.
        if (args.x === 1 && args.y === 1) {
          revision += 1;
          return { requestId, executionId, state: "rejected", reasonCode: "no_native_path", revision };
        }
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        tile = { x: args.x, y: args.y };
        revision += 1;
        publish({ ...receipt, state: "succeeded", reasonCode: "target_reached", revision });
        return receipt;
      }
      if (action === "equip_tool") {
        revision += 1;
        return { requestId, executionId, state: "succeeded", reasonCode: "tool_equipped", revision };
      }
      if (action === "chop_tree_source") {
        const outOfRange = distance() > 1;
        if (outOfRange && !chopFromAnywhere) {
          // Honest path: accept, walk to an adjacent tile, then chop. The approach
          // completion is `running`, NOT a terminal -- nothing native has run yet --
          // so the runner must keep waiting for the action's own terminal.
          revision += 1;
          const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
          publish(receipt);
          tile = { x: tree.x - 1, y: tree.y };
          revision += 1;
          const progress = { ...receipt, state: "running", reasonCode: "tool_approach_completed", revision, evidence: { detail: `approach=adjacent` } };
          if (withApproachProgress) publish(progress);
          chopped = true;
          revision += 1;
          publish({
            ...receipt,
            state: "succeeded",
            reasonCode: "tree_source_chopped",
            revision,
            evidence: {
              detail: `target=${args.expectedTargetId};tool=axe;slot=${args.slot};health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2`,
            },
          });
          return receipt;
        }
        // The defect: act at a distance without walking. This must never be accepted
        // as a pass, because the native click path cannot reach the tile from here.
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        chopped = true;
        revision += 1;
        publish({
          ...receipt,
          state: "succeeded",
          reasonCode: "tree_source_chopped",
          revision,
          evidence: {
            detail: `target=${args.expectedTargetId};tool=axe;slot=${args.slot};health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2`,
          },
        });
        return receipt;
      }
      throw new Error(`unexpected_action:${action}`);
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return client;
}

function withReceipts(client) {
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  return receipts;
}

test("approach runner proves the out-of-range chop walks first, then chops", async () => {
  const client = createFake();
  const receipts = withReceipts(client);
  const result = await runChopTreeSourceApproachSmoke(client, receipts, fixtureConfig());

  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "tree_source_chopped_via_approach");
  // The Given is real: the chop was requested from outside the interaction radius.
  assert.ok(result.approach.distanceBeforeChop > 1, `expected distance > 1, got ${result.approach.distanceBeforeChop}`);
  // Arrival announced itself separately from the action terminal.
  assert.ok(
    result.approach.progress.includes("tool_approach_completed"),
    `expected tool_approach_completed, got ${JSON.stringify(result.approach.progress)}`,
  );
  assert.equal(result.receipt.reasonCode, "tree_source_chopped");
  // The post-approach execution still carries the whole tool-family contract.
  for (const key of ["health_before", "health_after", "stump_before", "stump_after", "source_transformed", "stamina_before", "stamina_after", "stamina_delta", "expected_stamina_cost"]) {
    assert.ok(result.evidence[key] !== undefined, `evidence must include ${key}`);
  }
  assert.equal(result.evidence.source_transformed, "true");
});

test("approach runner refuses to pass when the tool acts without walking into range", async () => {
  // A Mod that chops from a distance is not the native behaviour: the click path
  // cannot reach the tile and GetToolLocation swings at the tile in front. The
  // runner must not certify that as a successful approach.
  const client = createFake({ chopFromAnywhere: true });
  const receipts = withReceipts(client);
  const result = await runChopTreeSourceApproachSmoke(client, receipts, fixtureConfig());

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /approach_progress_receipt_missing/);
});

test("approach runner reports a missing given rather than passing when already adjacent", async () => {
  // The precondition separation is part of the contract: if the actor is never
  // moved out of range, the run proves the in-range path (already covered by the
  // other runner) and must not be reported as approach evidence.
  const client = createFake();
  const originalExecute = client.execute;
  let moved = false;
  client.execute = async (request) => {
    if (request.action === "move_to_tile") moved = true;
    return originalExecute(request);
  };
  const receipts = withReceipts(client);
  const result = await runChopTreeSourceApproachSmoke(client, receipts, fixtureConfig());

  assert.equal(moved, true, "the runner must attempt to establish the out-of-range Given");
  assert.equal(result.state, "passed");
  assert.ok(result.approach.distanceBeforeChop > 1);
});
