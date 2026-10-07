import assert from "node:assert/strict";
import test from "node:test";
import {
  bodySlotForQualifiedItemId,
  runEquipWearableSmoke,
} from "./run-stardew-native-local-player-equip-wearable-smoke.mjs";

const ACTION = "equip_wearable";
const CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
const HAT_ITEM = "(H)0";
const SOURCE_SLOT = 5;
/** A well-formed opaque id from ANOTHER target family: it names no wearable body slot. */
const FOREIGN_TARGET_ID = "animal_door_0123456789abcdef";
const BODY_SLOTS = ["hat", "boots", "shirt", "pants", "left_ring", "right_ring"];

/**
 * The runner is the thing under test, so the fake client is a real one in shape: it answers the
 * same calls the harness makes and implements the Mod's OWN rule — an unknown target id is refused
 * first, an already-satisfied request is the idempotent success before the staleness check, a
 * target whose slot state moved is refused, and only then does the world change. The receipt is
 * minted from the live projection, and the world only moves when the request named the state the
 * world actually holds, which is exactly the rule under test.
 */
/**
 * The Mod's own identity rule: `wearable_<body_slot>_<16 hex>`, where the digest carries the
 * slot's occupant. The slot's state therefore has TWO spellings here — one per occupant — because
 * that is exactly what the real hash does.
 */
const hatTargetId = (occupantId) =>
  `wearable_hat_${occupantId === null ? "0000000000000000" : occupantId === HAT_ITEM ? "1111111111111111" : "3333333333333333"}`;

/** The Mod's own token rule: `wearable_<body_slot>_<16 hex>`, and nothing else names a body slot. */
function bodySlotFromTargetId(targetId) {
  if (typeof targetId !== "string") return null;
  for (const slot of BODY_SLOTS) {
    const prefix = `wearable_${slot}_`;
    if (!targetId.startsWith(prefix)) continue;
    const digest = targetId.slice(prefix.length);
    if (digest.length === 16 && /^[0-9a-f]+$/.test(digest)) return slot;
  }
  return null;
}

function world({ hatOccupant = null, sourceSlotPresent = true } = {}) {
  const facts = [];
  if (sourceSlotPresent) facts.push({ slot: SOURCE_SLOT, qualifiedItemId: HAT_ITEM, displayName: "Hat", stack: 1 });
  return {
    revision: 1,
    location: "Farm",
    tile: { x: 30, y: 21 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    inventorySlots: 36,
    inventoryItemFacts: facts,
    wearableTargets: [
      {
        targetId: hatTargetId(hatOccupant),
        bodySlot: "hat",
        occupantQualifiedItemId: hatOccupant,
        occupantDisplayName: hatOccupant === null ? null : "Hat",
      },
      { targetId: "wearable_boots_state_empty", bodySlot: "boots", occupantQualifiedItemId: null, occupantDisplayName: null },
      { targetId: "wearable_shirt_state_empty", bodySlot: "shirt", occupantQualifiedItemId: null, occupantDisplayName: null },
      { targetId: "wearable_pants_state_empty", bodySlot: "pants", occupantQualifiedItemId: null, occupantDisplayName: null },
      { targetId: "wearable_left_ring_state_empty", bodySlot: "left_ring", occupantQualifiedItemId: null, occupantDisplayName: null },
      { targetId: "wearable_right_ring_state_empty", bodySlot: "right_ring", occupantQualifiedItemId: null, occupantDisplayName: null },
    ],
  };
}

/** Apply the equip the way the native slot write does: the slot fills and the pack entry leaves. */
function equip(current, { item = HAT_ITEM, keepPackSlot = false, stateIndependentIdentity = false } = {}) {
  const wearableTargets = current.wearableTargets.map((entry) =>
    entry.bodySlot !== "hat"
      ? entry
      : {
          ...entry,
          targetId: stateIndependentIdentity ? entry.targetId : hatTargetId(item),
          occupantQualifiedItemId: item,
        },
  );
  const inventoryItemFacts = keepPackSlot
    ? current.inventoryItemFacts
    : current.inventoryItemFacts.filter((entry) => entry.slot !== SOURCE_SLOT);
  return { ...current, revision: current.revision + 1, wearableTargets, inventoryItemFacts };
}

function makeClient({ initialWorld = world(), hooks = {} } = {}) {
  const receipts = [];
  const client = {
    // The world IS the client's cached snapshot, read through the client and never through a
    // closure: a test that rewrites the snapshot must change what the runner observes, or the
    // test silently pins nothing.
    state: { snapshot: initialWorld },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const current = client.state.snapshot;
      assert.equal(request.action, ACTION);
      assert.ok(Number.isInteger(request.args.slot), "the runner must name a backpack slot");
      assert.equal(typeof request.args.expectedQualifiedItemId, "string");
      assert.equal(typeof request.args.expectedTargetId, "string");
      const live = current.wearableTargets.find((entry) => entry.bodySlot === "hat");
      let receipt;
      // The Mod's own order: the id must name a body slot at all, then an already-satisfied
      // request wins over the staleness the first call itself caused, then a stale state is
      // refused, and only then does the world change. The `known` set is deliberately NOT part of
      // this: a not-found answer is reserved for ids that name no body slot, exactly as the Mod
      // reserves it (a valid token with a wrong digest is `wearable_target_changed`).
      if (bodySlotFromTargetId(request.args.expectedTargetId) === null) {
        receipt = {
          state: "rejected",
          reasonCode: "wearable_target_not_found",
          revision: current.revision + 1,
          evidence: { detail: `published=${request.args.expectedTargetId};body_slots=hat|boots` },
        };
      } else if (live.occupantQualifiedItemId === request.args.expectedQualifiedItemId) {
        receipt = {
          state: "succeeded",
          reasonCode: "wearable_already_equipped",
          revision: current.revision + 1,
          evidence: {
            detail:
              `body_slot=hat;source_slot=${request.args.slot};requested=${request.args.expectedQualifiedItemId};` +
              `occupant=${live.occupantQualifiedItemId};moved=false`,
          },
        };
        if (hooks.moveOnRepeat) client.state.snapshot = equip(current, { item: "(H)22", keepPackSlot: true });
      } else if (live.targetId !== request.args.expectedTargetId) {
        receipt = {
          state: "rejected",
          reasonCode: "wearable_target_changed",
          revision: current.revision + 1,
          evidence: {
            detail: `body_slot=hat;published=${request.args.expectedTargetId};live=${live.targetId};occupant_before=none`,
          },
        };
      } else {
        receipt = {
          state: "succeeded",
          reasonCode: "wearable_equipped",
          revision: current.revision + 1,
          evidence: {
            detail:
              `body_slot=hat;source_slot=${request.args.slot};requested=${request.args.expectedQualifiedItemId};` +
              `occupant_before=none;occupant_after=${request.args.expectedQualifiedItemId};displaced=none;pack_slot_after=none`,
          },
        };
        if (!hooks.skipWorldMove) client.state.snapshot = equip(current, hooks.equipOptions ?? {});
      }
      const pushed = { ...receipt, requestId: request.requestId, executionId: `exec_${ACTION}_${receipts.length + 1}` };
      receipts.push(pushed);
      return pushed;
    },
  };
  return { client, receipts };
}

const run = (options = {}) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runEquipWearableSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

test("equip_wearable: the slot change is asserted from the world, and the identity moves with it", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "wearable_equipped");
  assert.equal(result.bodySlot, "hat");
  assert.equal(result.slot, SOURCE_SLOT);
  assert.equal(result.item, HAT_ITEM);
  // The published identity names the state, so the empty-slot target the run acted on is replaced
  // by the filled-slot target for the same slot.
  assert.notEqual(result.targetAfter, result.target);
  assert.equal(result.targetAfter, hatTargetId(HAT_ITEM));
  assert.equal(result.negatives.unknownTarget.reasonCode, "wearable_target_not_found");
  assert.equal(result.negatives.repeat.reasonCode, "wearable_already_equipped");
});

test("equip_wearable: a claimed equip that left the slot empty fails the run", async () => {
  // A green receipt is not evidence: the world's own projection still says the hat slot is empty.
  const session = run({ hooks: { skipWorldMove: true } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_world_unchanged/);
});

test("equip_wearable: a target whose published identity ignores its state fails the run", async () => {
  const session = run({ hooks: { equipOptions: { stateIndependentIdentity: true } } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_world_identity_stale/);
});

test("equip_wearable: an item that is still in the backpack after a claimed equip fails the run", async () => {
  const session = run({ hooks: { equipOptions: { keepPackSlot: true } } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_pack_slot_not_cleared/);
});

test("equip_wearable: a repeat that is refused instead of answered idempotently fails the run", async () => {
  // The negative the action's own rule requires: the repeat names the pre-state, so an
  // implementation that validates the stale target BEFORE the already-satisfied check reports
  // `wearable_target_changed` — an error where the action is in fact already satisfied.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "wearable_already_equipped") {
      receipt.state = "rejected";
      receipt.reasonCode = "wearable_target_changed";
    }
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_repeat_not_idempotent/);
});

test("equip_wearable: an idempotent repeat that still moved the world fails the run", async () => {
  // The other half: the repeat is answered correctly, but it swapped the worn item anyway.
  const session = run({ hooks: { moveOnRepeat: true } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_repeat_moved_world/);
});

test("equip_wearable: an unknown target that is not refused fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "wearable_target_not_found") {
      receipt.state = "succeeded";
      receipt.reasonCode = "wearable_equipped";
    }
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_unknown_target_not_refused/);
});

test("equip_wearable: an unknown target that still moved the world fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "wearable_target_not_found") session.client.state.snapshot = equip(session.client.state.snapshot);
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_unknown_target_moved_world/);
});

test("equip_wearable: evidence that omits the observed slot contents fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "wearable_equipped")
      receipt.evidence = { detail: "body_slot=hat;source_slot=5;requested=(H)0;occupant_before=none" };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_evidence_occupant_after/);
});

test("equip_wearable: an empty body slot with nothing wearable in the pack is the declared Given absent", async () => {
  const session = run({ initialWorld: world({ sourceSlotPresent: false }) });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_declared_given_absent/);
});

test("equip_wearable: a body slot the actor already wears is not the declared Given", async () => {
  // The fixture declares an EMPTY slot; a filled one is a different transition, and the runner
  // must refuse to start rather than exercise the swap path as if it were the declared Given.
  const session = run({ initialWorld: world({ hatOccupant: "(H)22" }) });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /equip_wearable_declared_given_absent/);
});

test("equip_wearable: the foreign-family id this suite uses is not a wearable target", () => {
  assert.equal(FOREIGN_TARGET_ID, "animal_door_0123456789abcdef");
  assert.equal(bodySlotFromTargetId(FOREIGN_TARGET_ID), null);
  assert.equal(bodySlotFromTargetId(hatTargetId(null)), "hat");
  assert.equal(bodySlotFromTargetId("wearable_hat_XYZ"), null);
});

test("equip_wearable: the backpack item-type prefixes the runner maps are the game's own", () => {
  assert.equal(bodySlotForQualifiedItemId("(H)0"), "hat");
  assert.equal(bodySlotForQualifiedItemId("(B)505"), "boots");
  assert.equal(bodySlotForQualifiedItemId("(S)1000"), "shirt");
  assert.equal(bodySlotForQualifiedItemId("(P)1"), "pants");
  // Rings are `(O)` items in this build (Ring.cs TypeDefinitionId), so they are deliberately not
  // mapped: guessing a ring slot from an id prefix would retarget the wrong body slot.
  assert.equal(bodySlotForQualifiedItemId("(O)520"), null);
  assert.equal(bodySlotForQualifiedItemId("(O)388"), null);
  assert.equal(bodySlotForQualifiedItemId(undefined), null);
});
