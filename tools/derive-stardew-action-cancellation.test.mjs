import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCancellableHandlers,
  deriveCancellableActionIds,
  CANCEL_LANES,
} from "./derive-stardew-action-cancellation.mjs";

test("the derivation reports the same lanes Cancel() checks", () => {
  // Seven lanes, read from the Cancel() implementation itself.
  assert.deepEqual(CANCEL_LANES, [
    "active",
    "activeTravel",
    "activePet",
    "activeAnimalProduct",
    "activeItemUse",
    "activeItemPickup",
    "activeNavigate",
  ]);
});

test("every handler is classified and the cancellable set matches the wire lanes", () => {
  const rows = deriveCancellableHandlers();
  assert.ok(rows.length > 30, `expected the full handler set, got ${rows.length}`);

  const cancellable = rows.filter((r) => r.cancellable).map((r) => r.handler.replace(/^RequestLocal/, ""));
  // The exact handlers whose executions may be aborted by the controller's
  // Cancel(): every one of them assigns one of the seven lanes.
  assert.deepEqual(cancellable.sort(), [
    "CollectAnimalProduct",
    "EnterExit",
    "Move",
    "PetAnimal",
    "PickupItem",
    "Travel",
    "UseItem",
  ]);
});

test("synchronous terminal actions are not cancellable", () => {
  const rows = deriveCancellableHandlers();
  const byName = new Map(rows.map((r) => [r.handler, r]));
  // express_emote / face_direction never return Accepted: no active slot, no
  // cancellation window (the live evidence for both recorded immediate
  // terminal receipts, and their handlers never assign an active lane).
  assert.equal(byName.get("RequestLocalExpressEmote").cancellable, false);
  assert.equal(byName.get("RequestLocalFaceDirection").cancellable, false);
});

test("delegation is followed and inline slots are seen", () => {
  const rows = deriveCancellableHandlers();
  const byName = new Map(rows.map((r) => [r.handler, r]));

  // Move registers its own active slot inline; Travel and EnterExit delegate
  // to RequestLocalDoorTransition, whose body owns the slot. Without resolving
  // the delegation they would all be misclassified as not cancellable.
  assert.equal(byName.get("RequestLocalMove").via, undefined);
  assert.equal(byName.get("RequestLocalMove").cancellable, true);
  assert.equal(byName.get("RequestLocalTravel").via, "RequestLocalDoorTransition");
  assert.equal(byName.get("RequestLocalTravel").cancellable, true);
  assert.equal(byName.get("RequestLocalEnterExit").via, "RequestLocalDoorTransition");
  assert.equal(byName.get("RequestLocalEnterExit").cancellable, true);
});

test("actionIds projection maps request handlers to registered action ids", () => {
  assert.deepEqual(deriveCancellableActionIds(), [
    "collect_animal_product",
    "enter_exit",
    "move_to_tile",
    "pet_animal",
    "pickup_item",
    "travel",
    "use_item",
  ]);
});