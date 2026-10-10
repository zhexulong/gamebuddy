import assert from "node:assert/strict";
import test from "node:test";

import { runBodyOwnerHoldSmoke } from "./run-stardew-native-local-player-body-owner-hold-smoke.mjs";

/**
 * Offline guards for the body-owner live gate.
 *
 * The gate's whole value is that it can FAIL, so every case below removes one of the properties the run claims
 * and expects the exact reason. A gate that can only ever pass would let the guidance promise a supersede that
 * does not happen.
 */
const CONFIG = {
  fixtureScenario: "native_till_soil_v1",
  actions: ["move_to_tile", "travel", "till_soil", "equip_tool"],
  saveSlot: "fixture_slot",
  logicalSaveSlot: "fixture_slot",
};

const SOIL = [
  { x: 20, y: 20 },
  { x: 26, y: 20 }, // six tiles away: far enough that the walk cannot settle before the next request
];

function makeClient({ ownerKind = "body_owned_by_movement", interruptible = true, inFlight = true, secondRefused = false, firstNeverTerminal = false } = {}) {
  const state = { tile: { x: 20, y: 20 }, revision: 10, active: null };
  const cache = { snapshot: { revision: 10 } };
  const receipts = [];
  let moveCount = 0;
  const client = {
    state: cache,
    async observe() {
      cache.snapshot = { revision: state.revision };
      return {
        revision: state.revision,
        location: "Farm",
        tile: state.tile,
        actionable: state.active === null,
        activeExecution: state.active,
        capabilities: ["inspect_self", "move_to_tile", "navigate_to_destination", "observe_scene", "till_soil", "travel"],
        soilTiles: SOIL,
        toolSlots: [],
        currentTool: "Axe",
        inventorySlots: 12,
      };
    },
    async execute(request) {
      if (request.action !== "move_to_tile") throw new Error(`unexpected action ${request.action}`);
      moveCount += 1;
      const executionId = `exec_${moveCount}`;
      if (moveCount === 1) {
        state.revision += 1;
        state.active = inFlight ? { executionId, requestId: request.requestId, action: "move_to_tile", state: "accepted", reasonCode: "accepted", evidence: null, ownerKind, interruptible } : null;
        if (!firstNeverTerminal) {
          // The walk ends as soon as the second directive arrives, which is what the guidance promises.
          state.revision += 1;
          receipts.push({ executionId, requestId: request.requestId, state: "rejected", reasonCode: "superseded_by_new_directive", revision: state.revision, evidence: null });
        }
        return { requestId: request.requestId, executionId, state: "accepted", reasonCode: "accepted", revision: state.revision };
      }
      if (secondRefused) return { requestId: request.requestId, executionId, state: "rejected", reasonCode: "body_release_unavailable", revision: state.revision };
      state.revision += 1;
      state.active = null;
      // The second walk reaches its own terminal, so the wait for it is satisfied by evidence rather than by the
      // body merely being free (which would also be true before the walk started).
      state.revision += 1;
      receipts.push({ executionId, requestId: request.requestId, state: "succeeded", reasonCode: "target_reached", revision: state.revision, evidence: { detail: "arrived=true" } });
      return { requestId: request.requestId, executionId, state: "accepted", reasonCode: "accepted", revision: state.revision };
    },
  };
  return { client, receipts, config: CONFIG, get moves() { return moveCount; } };
}

test("the body-owner hold passes: the in-flight owner is observable and a new directive supersedes it", async () => {
  const { client, receipts } = makeClient();
  const result = await runBodyOwnerHoldSmoke(client, receipts, CONFIG);
  assert.equal(result.reasonCode, "body_owner_hold_observable_and_supersedable", JSON.stringify(result));
  assert.equal(result.observability.ownerKindNamed, true);
  assert.equal(result.observability.interruptibleIsBoolean, true);
  assert.equal(result.ownerKind, "body_owned_by_movement");
  assert.equal(result.interruptible, true);
  assert.equal(result.supersede.firstIsTerminal, true);
});

test("the gate fails closed when the in-flight snapshot carries no owner", async () => {
  const { client, receipts } = makeClient({ inFlight: false });
  const result = await runBodyOwnerHoldSmoke(client, receipts, CONFIG);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^body_owner_observability_missing/);
});

test("the gate fails closed when the owner kind is a blind code again", async () => {
  // This is the regression the whole change removes: `body_owned` with no owner named.
  const { client, receipts } = makeClient({ ownerKind: "body_owned" });
  const result = await runBodyOwnerHoldSmoke(client, receipts, CONFIG);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^body_owner_observability_missing/);
});

test("the gate fails closed when the owner kind is not one this lane publishes", async () => {
  const { client, receipts } = makeClient({ ownerKind: "body_owned_by_ride" });
  const result = await runBodyOwnerHoldSmoke(client, receipts, CONFIG);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^body_owner_observability_missing/);
});

test("the gate fails closed when a second directive is refused instead of taking over", async () => {
  const { client, receipts } = makeClient({ secondRefused: true });
  const result = await runBodyOwnerHoldSmoke(client, receipts, CONFIG);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^body_owner_supersede_not_accepted/);
});

test("the gate fails closed when the superseded walk never reaches a terminal", async () => {
  const { client, receipts } = makeClient({ firstNeverTerminal: true });
  const result = await runBodyOwnerHoldSmoke(client, receipts, CONFIG, { terminalTimeoutMs: 200 });
  assert.equal(result.state, "blocked");
  assert.match(
    result.reasonCode,
    /^body_owner_supersede_missing|^body_owner_hold_not_settled|^native_terminal_receipt_missing_or_stale/,
  );
});

test("the gate refuses a fixture whose scenario or actions drifted", async () => {
  // The fixture contract is validated BEFORE the run and throws, matching the sibling recovery-chain runner: a
  // drifted fixture is a harness fault, not a blocked action, and must not be reportable as a product verdict.
  const { client, receipts } = makeClient();
  await assert.rejects(
    () => runBodyOwnerHoldSmoke(client, receipts, { ...CONFIG, fixtureScenario: "native_move_v1" }),
    /^Error: native_local_fixture_scenario_mismatch/,
  );
  await assert.rejects(
    () => runBodyOwnerHoldSmoke(client, receipts, { ...CONFIG, actions: ["move_to_tile"] }),
    /^Error: native_local_fixture_action_missing:/,
  );
});

test("a walk target closer than three tiles is refused as too near to prove anything", async () => {
  const { client, receipts } = makeClient();
  const near = { ...client, async observe() { const s = await client.observe(); return { ...s, soilTiles: [{ x: s.tile.x + 1, y: s.tile.y }] }; } };
  const result = await runBodyOwnerHoldSmoke(near, receipts, CONFIG);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^body_owner_hold_no_walk_target/);
});
