import assert from "node:assert/strict";
import test from "node:test";
import { runToggleAnimalDoorSmoke } from "./run-stardew-native-local-player-toggle-animal-door-smoke.mjs";

const ACTION = "toggle_animal_door";
const DOOR_TILE = { x: 31, y: 20 };

/** The Mod's own identity rule: the door state is part of the opaque target id. */
const doorTargetId = (isOpen) => (isOpen ? "animal_door_state_open" : "animal_door_state_closed");

/** A snapshot the runner can act on: one adjacent Coop whose animal door is closed. */
function snapshotWith({ revision, isOpen }) {
  return {
    revision,
    location: "Farm",
    tile: { x: 30, y: 21 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "inspect_self", ACTION],
    animalDoorTargets: [
      { targetId: doorTargetId(isOpen), x: DOOR_TILE.x, y: DOOR_TILE.y, buildingType: "Coop", isOpen },
    ],
  };
}

/**
 * The runner is the thing under test, so the client is a real one in shape: it answers the
 * same calls the harness makes and moves the world the way the native seam would. The
 * receipt is minted from the live projection, and the world only moves when the request
 * named the target the world actually holds — which is exactly the rule under test.
 */
function makeClient({ isOpen }) {
  const receipts = [];
  const client = {
    state: { snapshot: snapshotWith({ revision: 1, isOpen }) },
    // Read through the client, not a closure: a test that rewrites state must change what
    // the runner observes, or it silently tests nothing.
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const live = client.state.snapshot.animalDoorTargets[0];
      const receipt =
        request.args.expectedTargetId === live.targetId
          ? {
              requestId: request.requestId,
              executionId: "animal-door-execution",
              state: "succeeded",
              reasonCode: "animal_door_toggled",
              revision: client.state.snapshot.revision + 1,
              evidence: {
                detail:
                  `target=${live.targetId};tile=${live.x},${live.y};building_type=${live.buildingType}` +
                  `;animal_door_open_before=${live.isOpen};animal_door_open_after=${!live.isOpen};animal_door_open_changed=true` +
                  `;animal_door_amount_before=${live.isOpen ? 1 : 0};animal_door_amount_after=${live.isOpen ? 0 : 1}`,
              },
            }
          : {
              requestId: request.requestId,
              executionId: "animal-door-execution-refused",
              state: "rejected",
              reasonCode: "animal_door_target_changed",
              revision: client.state.snapshot.revision + 1,
              evidence: {
                detail: `tile=${live.x},${live.y};published=${request.args.expectedTargetId};live=${live.targetId};animal_door_open=${live.isOpen}`,
              },
            };
      if (receipt.state === "succeeded") {
        client.state.snapshot = snapshotWith({ revision: receipt.revision, isOpen: !live.isOpen });
      }
      receipts.push(receipt);
      return receipt;
    },
  };
  return { client, receipts };
}

const run = ({ isOpen = false } = {}) => {
  const session = makeClient({ isOpen });
  return {
    ...session,
    result: () => runToggleAnimalDoorSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

test("toggle_animal_door: the flip is asserted from the world, and the identity moves with it", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.door.before, false);
  assert.equal(result.door.after, true);
  assert.equal(result.reasonCode, "animal_door_toggled");
  // The published identity names the state, so the target the run acted on is replaced by
  // the open-door target at the same tile.
  assert.notEqual(result.targetAfter, result.target);
  assert.equal(result.targetAfter, doorTargetId(true));
});

test("toggle_animal_door: a door that did not flip fails the run", async () => {
  // The receipt claims success, but the world's own projection still says closed. A green
  // receipt is not evidence, so this must not pass.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      session.client.state.snapshot = snapshotWith({ revision: receipt.revision, isOpen: false });
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /animal_door_world_unchanged/);
});

test("toggle_animal_door: the stale closed-door target is refused, and claiming success on it fails the run", async () => {
  // The negative case the action's own rule requires: the second submission names a door
  // state that no longer exists, so the state does NOT change and the run must not report
  // success. Both halves are asserted — the honest refusal, and a forged success failing.
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed");
  assert.equal(result.negative.reasonCode, "animal_door_target_changed");
  assert.equal(result.negative.isOpen, true);

  const forged = run();
  const original = forged.client.execute;
  forged.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "animal_door_target_changed") {
      receipt.state = "succeeded";
      receipt.reasonCode = "animal_door_toggled";
    }
    return receipt;
  };
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "a stale target that claims success must fail the run");
});

test("toggle_animal_door: a refusal that still moved the world fails the run", async () => {
  // The other half of the negative case: the refusal is honest, but the door flipped anyway.
  // Without this the post-refusal world re-read is untested.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "animal_door_target_changed") {
      session.client.state.snapshot = snapshotWith({ revision: receipt.revision, isOpen: false });
    }
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /animal_door_stale_target_moved_world/);
});

test("toggle_animal_door: a refusal that re-published a different target fails the run", async () => {
  // The door still reads open, but the identity no longer names that state, so the tile is
  // no longer advertising the door the run toggled. Without this the post-refusal identity
  // guard is untested.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "animal_door_target_changed") {
      session.client.state.snapshot = {
        ...session.client.state.snapshot,
        animalDoorTargets: [
          { targetId: doorTargetId(false), x: DOOR_TILE.x, y: DOOR_TILE.y, buildingType: "Coop", isOpen: true },
        ],
      };
    }
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /animal_door_stale_target_moved_identity/);
});

test("toggle_animal_door: a door whose published identity ignores its state fails the run", async () => {
  // The world flipped, but the target id did not follow it, so the tile still advertises the
  // closed-door target for a door that is open. A state-independent identity makes the
  // action's own staleness rule unenforceable, which is the failure this pins.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") {
      session.client.state.snapshot = {
        ...session.client.state.snapshot,
        animalDoorTargets: [
          { targetId: doorTargetId(false), x: DOOR_TILE.x, y: DOOR_TILE.y, buildingType: "Coop", isOpen: true },
        ],
      };
    }
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /animal_door_world_identity_stale/);
});

test("toggle_animal_door: an open door is not the declared Given, so the run refuses to start", async () => {
  const session = run({ isOpen: true });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "animal_door_declared_given_absent");
});

test("toggle_animal_door: evidence that omits the observed flip fails the run", async () => {
  // The evidence is checked as evidence, separately from the world: a receipt that does not
  // say which two states it observed is not a toggle report.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") receipt.evidence = { detail: "target=animal_door_state_closed;tile=31,20" };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /animal_door_evidence_animal_door_open_before/);
});
