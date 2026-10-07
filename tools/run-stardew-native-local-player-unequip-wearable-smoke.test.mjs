import assert from "node:assert/strict";
import test from "node:test";
import {
  SCENARIO_INVENTORY_FULL,
  SCENARIO_ORDINARY,
  runUnequipWearableSmoke,
} from "./run-stardew-native-local-player-unequip-wearable-smoke.mjs";

const ACTION = "unequip_wearable";
const CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
const HAT_ITEM = "(H)0";
const BODY_SLOTS = ["hat", "boots", "shirt", "pants", "left_ring", "right_ring"];
/** A well-formed opaque id from ANOTHER target family: it names no wearable body slot. */
const FOREIGN_TARGET_ID = "animal_door_0123456789abcdef";
const FREE_SLOT = 6;
const OCCUPIED_SLOTS = [0, 1, 2, 3, 4, 5, 7, 8];

const hatTargetId = (occupantId) =>
  `wearable_hat_${occupantId === null ? "0000000000000000" : "1111111111111111"}`;

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

function world({ hatOccupant = HAT_ITEM, occupied = OCCUPIED_SLOTS } = {}) {
  return {
    revision: 1,
    location: "Farm",
    tile: { x: 30, y: 21 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    inventorySlots: 36,
    inventoryItemFacts: occupied.map((slot) => ({
      slot,
      qualifiedItemId: "(O)388",
      displayName: "Wood",
      stack: 5,
    })),
    wearableTargets: BODY_SLOTS.map((bodySlot) => ({
      targetId: bodySlot === "hat" ? hatTargetId(hatOccupant) : `wearable_${bodySlot}_2222222222222222`,
      bodySlot,
      occupantQualifiedItemId: bodySlot === "hat" ? hatOccupant : null,
      occupantDisplayName: bodySlot === "hat" && hatOccupant !== null ? "Hat" : null,
    })),
  };
}

const fullInventoryWorld = () =>
  world({ occupied: Array.from({ length: 36 }, (_, slot) => slot) });

function isInventoryFull(state) {
  const occupied = new Set(state.inventoryItemFacts.map((entry) => entry.slot));
  for (let slot = 0; slot < state.inventorySlots; slot++) if (!occupied.has(slot)) return false;
  return true;
}

/** The native unequip: the body slot empties (and its identity moves with it) and the item lands. */
function applyUnequip(state, { destinationSlot, bodySlot = "hat", keepIdentity = false } = {}) {
  const wearableTargets = state.wearableTargets.map((entry) =>
    entry.bodySlot !== bodySlot
      ? entry
      : {
          ...entry,
          targetId: keepIdentity ? entry.targetId : hatTargetId(null),
          occupantQualifiedItemId: null,
          occupantDisplayName: null,
        },
  );
  const inventoryItemFacts = destinationSlot === null
    ? state.inventoryItemFacts
    : [...state.inventoryItemFacts, { slot: destinationSlot, qualifiedItemId: HAT_ITEM, displayName: "Hat", stack: 1 }];
  return { ...state, revision: state.revision + 1, wearableTargets, inventoryItemFacts };
}

/** The inverse of the native equip: the body slot fills again, which IS a world change. */
function applyReEquip(state) {
  const wearableTargets = state.wearableTargets.map((entry) =>
    entry.bodySlot !== "hat"
      ? entry
      : { ...entry, targetId: hatTargetId(HAT_ITEM), occupantQualifiedItemId: HAT_ITEM, occupantDisplayName: "Hat" },
  );
  return { ...state, revision: state.revision + 1, wearableTargets };
}

function makeClient({ initialWorld = world(), scenario = SCENARIO_ORDINARY, hooks = {} } = {}) {
  const receipts = [];
  const client = {
    // The world IS the client's cached snapshot, read through the client and never through a
    // closure: a test that rewrites the snapshot must change what the runner observes.
    state: { snapshot: initialWorld },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const current = client.state.snapshot;
      assert.equal(request.action, ACTION);
      assert.ok(Number.isInteger(request.args.slot), "the runner must name a destination slot");
      assert.equal(typeof request.args.expectedTargetId, "string");
      const bodySlot = bodySlotFromTargetId(request.args.expectedTargetId);
      let receipt;
      if (bodySlot === null) {
        receipt = {
          state: "rejected",
          reasonCode: "wearable_target_not_found",
          revision: current.revision + 1,
          evidence: { detail: `published=${request.args.expectedTargetId};body_slots=${BODY_SLOTS.join("|")}` },
        };
      } else {
        const live = current.wearableTargets.find((entry) => entry.bodySlot === bodySlot);
        if (live.occupantQualifiedItemId == null) {
          receipt = {
            state: "succeeded",
            reasonCode: "wearable_already_unequipped",
            revision: current.revision + 1,
            evidence: {
              detail: `body_slot=${bodySlot};destination_slot=${request.args.slot};occupant=none;moved=false`,
            },
          };
          if (hooks.moveOnRepeat) client.state.snapshot = applyReEquip(current);
        } else if (live.targetId !== request.args.expectedTargetId) {
          receipt = {
            state: "rejected",
            reasonCode: "wearable_target_changed",
            revision: current.revision + 1,
            evidence: {
              detail: `body_slot=${bodySlot};published=${request.args.expectedTargetId};live=${live.targetId};occupant_before=${live.occupantQualifiedItemId}`,
            },
          };
        } else if (isInventoryFull(current) && !hooks.ignoreInventoryFull) {
          receipt = {
            state: "rejected",
            reasonCode: "wearable_inventory_full",
            revision: current.revision + 1,
            evidence: {
              detail:
                `body_slot=${bodySlot};destination_slot=${request.args.slot};occupant_before=${live.occupantQualifiedItemId};` +
                `inventory_full=true;free_inventory_slots=0;inventory_slots=${current.inventorySlots}`,
            },
          };
          if (hooks.refusalMovesWorld) client.state.snapshot = applyUnequip(current, { destinationSlot: null });
          if (hooks.refusalOpensSlot)
            client.state.snapshot = {
              ...client.state.snapshot,
              inventoryItemFacts: client.state.snapshot.inventoryItemFacts.slice(1),
            };
        } else if (current.inventoryItemFacts.some((entry) => entry.slot === request.args.slot)) {
          receipt = {
            state: "rejected",
            reasonCode: "wearable_destination_slot_occupied",
            revision: current.revision + 1,
            evidence: {
              detail: `body_slot=${bodySlot};destination_slot=${request.args.slot};destination_item=(O)388;inventory_full=false;free_inventory_slots=28`,
            },
          };
        } else {
          receipt = {
            state: "succeeded",
            reasonCode: "wearable_unequipped",
            revision: current.revision + 1,
            evidence: {
              detail:
                `body_slot=${bodySlot};destination_slot=${request.args.slot};occupant_before=${live.occupantQualifiedItemId};` +
                `occupant_after=none;removed=${live.occupantQualifiedItemId};destination_before=none;` +
                `destination_after=${live.occupantQualifiedItemId};landed=true`,
            },
          };
          if (!hooks.skipWorldMove)
            client.state.snapshot = applyUnequip(current, {
              destinationSlot: hooks.destinationSlotForSuccess === undefined ? request.args.slot : hooks.destinationSlotForSuccess,
              keepIdentity: hooks.stateIndependentIdentity === true,
            });
        }
      }
      const pushed = { ...receipt, requestId: request.requestId, executionId: `exec_${ACTION}_${receipts.length + 1}` };
      receipts.push(pushed);
      return pushed;
    },
  };
  return { client, receipts, scenario };
}

const run = ({ scenario = SCENARIO_ORDINARY, ...options } = {}) => {
  const session = makeClient({ scenario, ...options });
  return {
    ...session,
    result: () =>
      runUnequipWearableSmoke(
        session.client,
        session.receipts,
        { NativeLocalPlayerFixture: { Enable: true, FixtureScenario: scenario } },
        { terminalTimeoutMs: 1_000 },
      ),
  };
};

test("unequip_wearable: the slot empties into the named slot, and the identity moves with it", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "wearable_unequipped");
  assert.equal(result.bodySlot, "hat");
  assert.equal(result.slot, FREE_SLOT);
  assert.equal(result.item, HAT_ITEM);
  assert.notEqual(result.targetAfter, result.target);
  assert.equal(result.targetAfter, hatTargetId(null));
  assert.equal(result.negatives.unknownTarget.reasonCode, "wearable_target_not_found");
  assert.equal(result.negatives.occupiedDestination.reasonCode, "wearable_destination_slot_occupied");
  assert.equal(result.negatives.repeat.reasonCode, "wearable_already_unequipped");
});

test("unequip_wearable: a FULL backpack is refused and nothing moves", async () => {
  const session = run({ scenario: SCENARIO_INVENTORY_FULL, initialWorld: fullInventoryWorld() });
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "wearable_inventory_full");
  assert.equal(result.refusal.state, "rejected");
  assert.equal(result.refusal.reasonCode, "wearable_inventory_full");
  assert.equal(result.refusal.target, result.target);
});

test("unequip_wearable: a full backpack that unequips anyway fails the run", async () => {
  // This is the frozen rule: with nowhere to land, removing the wearable drops it on the ground.
  const session = run({
    scenario: SCENARIO_INVENTORY_FULL,
    initialWorld: fullInventoryWorld(),
    hooks: { ignoreInventoryFull: true },
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_full_inventory_not_refused/);
});

test("unequip_wearable: a refusal that still moved the item fails the run", async () => {
  const session = run({
    scenario: SCENARIO_INVENTORY_FULL,
    initialWorld: fullInventoryWorld(),
    hooks: { refusalMovesWorld: true },
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_full_inventory_moved_world/);
});

test("unequip_wearable: a refusal that still opened a backpack slot fails the run", async () => {
  const session = run({
    scenario: SCENARIO_INVENTORY_FULL,
    initialWorld: fullInventoryWorld(),
    hooks: { refusalOpensSlot: true },
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_full_inventory_slot_opened/);
});

test("unequip_wearable: an ordinary run under the full-backpack scenario is the declared Given absent", async () => {
  // The scenario declares a full backpack; the runner must refuse to start rather than report a
  // successful unequip as if the Given had been armed.
  const session = run({ scenario: SCENARIO_INVENTORY_FULL });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_declared_given_absent:inventory_not_full/);
});

test("unequip_wearable: an unsupported scenario fails the run instead of guessing", async () => {
  const session = run({ scenario: "native_some_other_v1" });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_scenario_unsupported/);
});

test("unequip_wearable: a destination that is not free is refused, and claiming success fails the run", async () => {
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed");
  assert.equal(result.negatives.occupiedDestination.reasonCode, "wearable_destination_slot_occupied");

  const forged = run();
  const original = forged.client.execute;
  forged.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "wearable_destination_slot_occupied") {
      receipt.state = "succeeded";
      receipt.reasonCode = "wearable_unequipped";
    }
    return receipt;
  };
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "a destination that is not free must not report a move");
});

test("unequip_wearable: an occupied destination that still moved the world fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "wearable_destination_slot_occupied")
      session.client.state.snapshot = applyUnequip(session.client.state.snapshot, { destinationSlot: null });
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_occupied_destination_moved_world/);
});

test("unequip_wearable: a claimed unequip whose destination stayed empty fails the run", async () => {
  const session = run({ hooks: { destinationSlotForSuccess: null } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_destination_empty/);
});

test("unequip_wearable: a claimed unequip that left the body slot unchanged fails the run", async () => {
  const session = run({ hooks: { skipWorldMove: true } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_world_unchanged/);
});

test("unequip_wearable: a target whose published identity ignores its state fails the run", async () => {
  const session = run({ hooks: { stateIndependentIdentity: true } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_world_identity_stale/);
});

test("unequip_wearable: a repeat that is a rejected error instead of an idempotent success fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "wearable_already_unequipped") {
      receipt.state = "rejected";
      receipt.reasonCode = "wearable_target_changed";
    }
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_repeat_not_idempotent/);
});

test("unequip_wearable: an idempotent repeat that still moved the world fails the run", async () => {
  // The repeat is answered correctly, but the wearable is back on the actor: the world moved under
  // an idempotent receipt, so the run must not report success.
  const session = run({ hooks: { moveOnRepeat: true } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_repeat_moved_world/);
});

test("unequip_wearable: an actor wearing nothing is the declared Given absent", async () => {
  const session = run({ initialWorld: world({ hatOccupant: null }) });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_declared_given_absent:not_wearing_any_wearable/);
});

test("unequip_wearable: evidence that omits the observed destination fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "wearable_unequipped")
      receipt.evidence = { detail: "body_slot=hat;destination_slot=6;occupant_before=(H)0;occupant_after=none;removed=(H)0" };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /unequip_wearable_evidence_destination_after/);
});

test("unequip_wearable: the foreign-family id this suite uses is not a wearable target", () => {
  assert.equal(FOREIGN_TARGET_ID, "animal_door_0123456789abcdef");
  assert.equal(bodySlotFromTargetId(FOREIGN_TARGET_ID), null);
  assert.equal(bodySlotFromTargetId(hatTargetId(null)), "hat");
  assert.equal(bodySlotFromTargetId("wearable_hat_XYZ"), null);
});
