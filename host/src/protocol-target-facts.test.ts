import assert from "node:assert/strict";
import test from "node:test";

import { isWorldObjectTargetFact } from "./protocol-target-facts.js";

/** One world-object row, spelled the way the Mod's `BridgeWorldObjectTarget` writes it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId: "placed_furniture_0123456789abcdef",
    kind: "placed_furniture",
    location: "FarmHouse",
    x: 4,
    y: 5,
    slot: -1,
    qualifiedItemId: "(F)1396",
    displayName: "Oak Chair",
    rotation: 1,
    rotations: 4,
    ...overrides,
  };
}

test("a placed furniture row carries its live rotation and its own cycle", () => {
  assert.equal(isWorldObjectTargetFact(row()), true);
  assert.equal(isWorldObjectTargetFact(row({ rotation: 0, rotations: 2 })), true);
  assert.equal(isWorldObjectTargetFact(row({ rotation: 3, rotations: 4 })), true);
});

test("a non-furniture row carries null, not a sentinel that reads as a value", () => {
  for (const kind of [
    "placement_candidate",
    "removable_object",
    "non_removable_object",
    "breakable_container",
    "empty_pedestal",
  ]) {
    assert.equal(
      isWorldObjectTargetFact(row({ kind, rotation: null, rotations: null })),
      true,
      `${kind} with explicit null is the absence this row is allowed to publish`,
    );
    // The falsifier: 0 is a LEGAL rotation, so a 0 or -1 sentinel would be read as a real value by any
    // caller. Only the explicit null is accepted for a kind that has no rotation at all.
    assert.equal(
      isWorldObjectTargetFact(row({ kind, rotation: 0, rotations: 0 })),
      false,
      `${kind} rotation sentinel 0`,
    );
    assert.equal(isWorldObjectTargetFact(row({ kind, rotation: -1, rotations: -1 })), false, `${kind} sentinel -1`);
  }
});

test("a furniture row without the rotation fact is refused rather than published without it", () => {
  assert.equal(isWorldObjectTargetFact(row({ rotation: null })), false);
  assert.equal(isWorldObjectTargetFact(row({ rotations: null })), false);
  const { rotation: _rotation, ...withoutRotation } = row();
  assert.equal(isWorldObjectTargetFact(withoutRotation), false);
});

test("the rotation values are the engine's own, not any integer", () => {
  assert.equal(isWorldObjectTargetFact(row({ rotation: 4 })), false, "currentRotation is 0..3");
  assert.equal(isWorldObjectTargetFact(row({ rotation: -1 })), false);
  assert.equal(isWorldObjectTargetFact(row({ rotations: 5 })), false, "cycles are Data/Furniture's 0, 2 or 4");
  assert.equal(isWorldObjectTargetFact(row({ rotation: 1.5 })), false);
  assert.equal(isWorldObjectTargetFact(row({ rotation: "1" })), false);
});
