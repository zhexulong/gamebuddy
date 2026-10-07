import assert from "node:assert/strict";
import test from "node:test";
import { runPlaceOwnedObjectSmoke } from "./run-stardew-native-local-player-place-owned-object-smoke.mjs";

const ACTION = "place_owned_object";
const ITEM = "(BC)105";
const TILE = { x: 20, y: 21 };
const TAPPER_SLOT = 3;

/** The Mod's own identity rule: location, slot, tile and item decide the opaque id. */
const placementTargetId = (slot) => `place_owned_object_slot${slot}`;
const placedObjectTargetId = "placed_item_tapper";

/**
 * A snapshot the runner can act on: one tapper in the backpack whose only placeable tile
 * is the tree tile the fixture armed.
 */
function snapshotWith({ revision, placed, slot = TAPPER_SLOT }) {
  return {
    revision,
    location: "Farm",
    tile: { x: TILE.x, y: TILE.y + 1 },
    actionable: true,
    activeExecution: null,
    inventorySlots: 12,
    capabilities: ["cancel_active_execution", "inspect_self", ACTION],
    worldObjectTargets: [
      ...(placed
        ? [{ targetId: placedObjectTargetId, kind: "removable_object", location: "Farm", x: TILE.x, y: TILE.y, slot: 7, qualifiedItemId: ITEM, displayName: "Tapper" }]
        : [{ targetId: placementTargetId(slot), kind: "placement_candidate", location: "Farm", x: TILE.x, y: TILE.y, slot, qualifiedItemId: ITEM, displayName: "Tapper" }]),
    ],
  };
}

/**
 * The runner is the thing under test, so the client answers the same calls the harness
 * makes and moves the world the way the native branch would: the object appears only when
 * the request named the target the world actually holds AND the named slot holds the item.
 */
function makeClient({ placed = false } = {}) {
  const receipts = [];
  const client = {
    state: { snapshot: snapshotWith({ revision: 1, placed }) },
    // Read through the client, not a closure: a test that rewrites state must change what
    // the runner observes, or it silently tests nothing.
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const state = client.state.snapshot;
      const candidate = state.worldObjectTargets[0];
      // The Mod answers "does the named slot hold the item this request claims?" before it
      // looks at the tile, so the fake must apply the same order.
      const rightSlot = request.args.slot === TAPPER_SLOT;
      let receipt;
      if (!rightSlot) {
        receipt = {
          requestId: request.requestId,
          executionId: "place-owned-object-execution-refused",
          state: "rejected",
          reasonCode: "place_owned_object_not_owned_in_slot",
          revision: state.revision + 1,
          evidence: { detail: `slot=${request.args.slot};expected_item=${ITEM};slot_item=empty` },
        };
      } else if (candidate.kind !== "placement_candidate") {
        receipt = {
          requestId: request.requestId,
          executionId: "place-owned-object-execution-refused",
          state: "rejected",
          reasonCode: "place_owned_object_tile_occupied",
          revision: state.revision + 1,
          evidence: { detail: `target=${request.args.x},${request.args.y};occupant=${candidate.qualifiedItemId}` },
        };
      } else {
        receipt = {
          requestId: request.requestId,
          executionId: "place-owned-object-execution",
          state: "succeeded",
          reasonCode: "owned_object_placed",
          revision: state.revision + 1,
          evidence: {
            detail:
              `target=${candidate.targetId};location=Farm;tile=${candidate.x},${candidate.y};slot=${candidate.slot};item=${ITEM}` +
              `;terrain_feature=Tree;terrain_feature_tapped=true;native_placement=true;object_present=true` +
              `;placed_qualified_item_id=${ITEM};placed_type=Crafting;inventory_before=2;inventory_after=1`,
          },
        };
      }
      if (receipt.state === "succeeded") {
        client.state.snapshot = snapshotWith({ revision: receipt.revision, placed: true, slot: candidate.slot });
      }
      receipts.push(receipt);
      return receipt;
    },
  };
  return { client, receipts };
}

const run = (options = {}) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runPlaceOwnedObjectSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

/** Rewrite the client's execute, keeping the honest behaviour available. */
function mutate(session, rewrite) {
  const original = session.client.execute;
  session.client.execute = async (request) => rewrite(await original(request), request, session);
}

test("place_owned_object: the object is asserted from the world, and the tapper branch effect is asserted", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed", result.reasonCode);
  assert.equal(result.reasonCode, "owned_object_placed");
  assert.equal(result.item, ITEM);
  assert.equal(result.placed, placedObjectTargetId);
  assert.equal(result.evidence.terrain_feature, "Tree");
  assert.equal(result.evidence.terrain_feature_tapped, "true");
});

test("place_owned_object: an object that never appeared fails the run", async () => {
  // The receipt claims success, but the world's own projection still advertises the
  // placement candidate for that tile. A green receipt is not evidence.
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.state === "succeeded")
      session.client.state.snapshot = snapshotWith({ revision: receipt.revision, placed: false });
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_owned_object_world_object_missing/);
});

test("place_owned_object: a placement that left the item in the pack fails the run", async () => {
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("inventory_before=2;inventory_after=1", "inventory_before=2;inventory_after=2") };
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_owned_object_inventory_not_consumed/);
});

test("place_owned_object: the occupied-tile negative is asserted, and claiming success on it fails the run", async () => {
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed", result.reasonCode);
  assert.equal(result.negative.occupied, "place_owned_object_tile_occupied");

  const forged = run();
  mutate(forged, (receipt) => {
    if (receipt.reasonCode === "place_owned_object_tile_occupied") {
      receipt.state = "succeeded";
      receipt.reasonCode = "owned_object_placed";
    }
    return receipt;
  });
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "a second placement must not be reported as success");
  assert.match(forgedResult.reasonCode, /place_owned_object_occupied_not_refused/);
});

test("place_owned_object: the occupied negative that still moved the world fails the run", async () => {
  // The refusal is honest, but the receipt identity of the object on the tile changed
  // anyway, which means something was placed twice.
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.reasonCode === "place_owned_object_tile_occupied") {
      session.client.state.snapshot = {
        ...session.client.state.snapshot,
        worldObjectTargets: [
          { targetId: "placed_item_second_tapper", kind: "removable_object", location: "Farm", x: TILE.x, y: TILE.y, slot: 7, qualifiedItemId: ITEM, displayName: "Tapper" },
        ],
      };
    }
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_owned_object_occupied_moved_world/);
});

test("place_owned_object: the wrong-slot negative is asserted, and a silent no-op there fails the run", async () => {
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed", result.reasonCode);
  assert.equal(result.negative.wrongSlot, "place_owned_object_not_owned_in_slot");

  const forged = run();
  mutate(forged, (receipt) => {
    if (receipt.reasonCode === "place_owned_object_not_owned_in_slot") {
      receipt.state = "succeeded";
      receipt.reasonCode = "owned_object_placed";
    }
    return receipt;
  });
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "a request naming a slot that does not hold the item must not succeed");
});

test("place_owned_object: evidence that omits the observed tapper effect fails the run", async () => {
  // The evidence is checked as evidence, separately from the world: a receipt that does not
  // name the ground it placed on, or does not report the tapper branch's own effect, is not
  // a report of this action.
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace(";terrain_feature=Tree;terrain_feature_tapped=true", ";terrain_feature=Tree;terrain_feature_tapped=none") };
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_owned_object_evidence_terrain_feature_tapped/);
});

test("place_owned_object: a placement candidate that stayed published fails the run", async () => {
  // The object appeared, but the Mod still advertises the tile as placeable, which means the
  // world did not really take the placement. A receipt that reports success there is not a
  // report about the world.
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.state === "succeeded") {
      const state = session.client.state.snapshot;
      session.client.state.snapshot = {
        ...state,
        worldObjectTargets: [...state.worldObjectTargets, { targetId: placementTargetId(TAPPER_SLOT), kind: "placement_candidate", location: "Farm", x: TILE.x, y: TILE.y, slot: TAPPER_SLOT, qualifiedItemId: ITEM, displayName: "Tapper" }],
      };
    }
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_owned_object_stale_candidate_republished/);
});

test("place_owned_object: a tile that is not the declared Given blocks the run", async () => {
  // The declared Given is an advertised placement candidate; without one there is nothing
  // honest to act on, and the run must say so with the candidates it saw.
  const session = run();
  session.client.state.snapshot = { ...session.client.state.snapshot, worldObjectTargets: [] };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_owned_object_declared_given_absent/);
});
