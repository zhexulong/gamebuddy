import assert from "node:assert/strict";
import test from "node:test";
import { runRemovePlacedItemSmoke } from "./run-stardew-native-local-player-remove-placed-item-smoke.mjs";

const ACTION = "remove_placed_item";
const PLACED_ITEM = "(BC)12";
const TWIG_ITEM = "(O)294";
const KEG_TILE = { x: 20, y: 22 };
const TWIG_TILE = { x: 19, y: 21 };
const AXE_SLOT = 8;
const PICKAXE_SLOT = 9;
const TAPPER_SLOT = 3;

/** The Mod's own identity rule: the object's own facts, never the tool slot. */
const kegTargetId = "placed_item_keg";
const twigTargetId = "placed_item_twig";

/** A snapshot the runner can act on: the fixture's placed machine and twig, plus tools. */
function snapshotWith({ revision, kegPresent = true, twigPresent = true }) {
  return {
    revision,
    location: "Farm",
    tile: { x: 20, y: 21 },
    actionable: true,
    activeExecution: null,
    inventorySlots: 12,
    capabilities: ["cancel_active_execution", "inspect_self", "equip_tool", ACTION],
    worldObjectTargets: [
      ...(kegPresent
        ? [{ targetId: kegTargetId, kind: "removable_object", location: "Farm", x: KEG_TILE.x, y: KEG_TILE.y, slot: AXE_SLOT, qualifiedItemId: PLACED_ITEM, displayName: "Keg" }]
        : []),
      ...(twigPresent
        ? [{ targetId: twigTargetId, kind: "removable_object", location: "Farm", x: TWIG_TILE.x, y: TWIG_TILE.y, slot: AXE_SLOT, qualifiedItemId: TWIG_ITEM, displayName: "Twig" }]
        : []),
    ],
    toolSlots: [
      { slot: AXE_SLOT, label: "(T)Axe" },
      { slot: PICKAXE_SLOT, label: "(T)Pickaxe" },
    ],
  };
}

/**
 * The runner is the thing under test, so the client answers the same calls the harness
 * makes and applies the rules the Mod applies: the twig is removed by an AXE only, the keg
 * by either seam tool, and nothing is removed through a slot that holds no tool.
 */
function makeClient() {
  const receipts = [];
  const client = {
    state: { snapshot: snapshotWith({ revision: 1 }) },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const state = client.state.snapshot;
      const target = state.worldObjectTargets.find((entry) => entry.targetId === request.args.expectedTargetId);
      let receipt;
      if (request.action === "equip_tool") {
        receipt = {
          requestId: request.requestId,
          executionId: `equip_${request.args.tool}`,
          state: "succeeded",
          reasonCode: "tool_equipped",
          revision: state.revision + 1,
          evidence: { detail: `tool=${request.args.tool}` },
        };
      } else if (target == null) {
        receipt = {
          requestId: request.requestId,
          executionId: "remove-placed-item-refused",
          state: "rejected",
          reasonCode: "remove_placed_item_target_not_found",
          revision: state.revision + 1,
          evidence: { detail: `target=${request.args.x},${request.args.y};published=${request.args.expectedTargetId}` },
        };
      } else if (request.args.slot !== AXE_SLOT && request.args.slot !== PICKAXE_SLOT) {
        receipt = {
          requestId: request.requestId,
          executionId: "remove-placed-item-refused",
          state: "rejected",
          reasonCode: "remove_placed_item_tool_not_equipped_in_requested_slot",
          revision: state.revision + 1,
          evidence: { detail: `slot=${request.args.slot};slot_item=empty;current_tool=(T)Axe` },
        };
      } else if (target.qualifiedItemId === TWIG_ITEM && request.args.slot !== AXE_SLOT) {
        // The native branch removes a twig with an axe only: with anything else it returns
        // false and the object stays exactly where it is.
        receipt = {
          requestId: request.requestId,
          executionId: "remove-placed-item-refused",
          state: "rejected",
          reasonCode: "remove_placed_item_tool_cannot_remove_target",
          revision: state.revision + 1,
          evidence: { detail: `target=${request.args.x},${request.args.y};item=${TWIG_ITEM};type=Basic;fragility=0;tool_kind=pickaxe;slot=${request.args.slot}` },
        };
      } else {
        receipt = {
          requestId: request.requestId,
          executionId: "remove-placed-item-execution",
          state: "succeeded",
          reasonCode: "placed_item_removed",
          revision: state.revision + 1,
          evidence: {
            detail:
              `target=${target.targetId};location=Farm;tile=${target.x},${target.y};item=${target.qualifiedItemId};type=Crafting` +
              `;tool=(T)Axe;tool_kind=axe;slot=${request.args.slot};swings=1;removed=true;tile_object_after=none` +
              `;drops=${target.qualifiedItemId};drop_count=1;stamina_before=100;stamina_after=98`,
          },
        };
        client.state.snapshot = snapshotWith({
          revision: receipt.revision,
          kegPresent: target.qualifiedItemId === PLACED_ITEM ? false : true,
          twigPresent: target.qualifiedItemId === TWIG_ITEM ? false : true,
        });
      }
      receipts.push(receipt);
      return receipt;
    },
  };
  return { client, receipts };
}

const run = () => {
  const session = makeClient();
  return {
    ...session,
    result: () => runRemovePlacedItemSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

function mutate(session, rewrite) {
  const original = session.client.execute;
  session.client.execute = async (request) => rewrite(await original(request), request, session);
}

test("remove_placed_item: the removal is asserted from the world, with the removed object's own drop", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "placed_item_removed");
  assert.equal(result.item, PLACED_ITEM);
  assert.equal(result.tool.kind, "axe");
  assert.deepEqual(result.drops, [PLACED_ITEM]);
});

test("remove_placed_item: an object that is still there fails the run", async () => {
  // The receipt claims success, but the world still publishes the object on that tile.
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.state === "succeeded" && receipt.reasonCode === "placed_item_removed")
      session.client.state.snapshot = snapshotWith({ revision: receipt.revision });
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /remove_placed_item_world_unchanged/);
});

test("remove_placed_item: a removal whose drop was not observed fails the run", async () => {
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.reasonCode === "placed_item_removed")
      receipt.evidence = { detail: `${receipt.evidence.detail.replace(`drops=${PLACED_ITEM};drop_count=1`, "drops=;drop_count=0")}` };
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /remove_placed_item_drop_unobserved/);
});

test("remove_placed_item: the wrong-tool negative is asserted, and a silent no-op there fails the run", async () => {
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed");
  assert.equal(result.negative.wrongTool, "remove_placed_item_tool_cannot_remove_target");

  const forged = run();
  mutate(forged, (receipt, request) => {
    if (receipt.reasonCode === "remove_placed_item_tool_cannot_remove_target") {
      receipt.state = "succeeded";
      receipt.reasonCode = "placed_item_removed";
      // The world does NOT move, which is exactly the silent no-op the named refusal exists
      // to prevent.
      void request;
    }
    return receipt;
  });
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "a pickaxe on a twig must never be reported as a removal");
});

test("remove_placed_item: a wrong-tool refusal that removed the object anyway fails the run", async () => {
  // The refusal is honest, but the world changed: the twig is gone although the request was
  // refused, which means something else removed it.
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.reasonCode === "remove_placed_item_tool_cannot_remove_target")
      session.client.state.snapshot = snapshotWith({ revision: receipt.revision, twigPresent: false });
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /remove_placed_item_wrong_tool_moved_world/);
});

test("remove_placed_item: the stale-target negative is asserted, and claiming success on it fails the run", async () => {
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed");
  assert.equal(result.negative.staleTarget, "remove_placed_item_target_not_found");

  const forged = run();
  mutate(forged, (receipt) => {
    if (receipt.reasonCode === "remove_placed_item_target_not_found") {
      receipt.state = "succeeded";
      receipt.reasonCode = "placed_item_removed";
    }
    return receipt;
  });
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "a target that no longer exists must not be reported as removed");
});

test("remove_placed_item: the empty-slot negative is asserted, and a success on it fails the run", async () => {
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed");
  assert.equal(result.negative.emptySlot, "remove_placed_item_tool_not_equipped_in_requested_slot");

  const forged = run();
  mutate(forged, (receipt) => {
    if (receipt.reasonCode === "remove_placed_item_tool_not_equipped_in_requested_slot") {
      receipt.state = "succeeded";
      receipt.reasonCode = "placed_item_removed";
    }
    return receipt;
  });
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "a slot that holds no tool must not be able to remove anything");
});

test("remove_placed_item: a swing count that was never observed fails the run", async () => {
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.reasonCode === "placed_item_removed")
      receipt.evidence = { detail: receipt.evidence.detail.replace("swings=1", "swings=0") };
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /remove_placed_item_swings_unobserved/);
});

test("remove_placed_item: a refusal that moved the world fails the run", async () => {
  // The empty-slot refusal is honest, but the twig it named disappeared anyway, so something
  // else removed an object this action was told to leave alone.
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.reasonCode === "remove_placed_item_tool_not_equipped_in_requested_slot")
      session.client.state.snapshot = snapshotWith({ revision: receipt.revision, twigPresent: false });
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /remove_placed_item_empty_slot_moved_world/);
});

test("remove_placed_item: a declared Given that is absent blocks the run", async () => {
  const session = run();
  session.client.state.snapshot = { ...session.client.state.snapshot, worldObjectTargets: [] };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /remove_placed_item_declared_given_absent/);
});
