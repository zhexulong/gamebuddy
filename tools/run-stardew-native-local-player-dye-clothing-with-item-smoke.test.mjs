import assert from "node:assert/strict";
import test from "node:test";

import { assertDyeClothingPostconditions } from "./run-stardew-native-local-player-dye-clothing-with-item-smoke.mjs";

/**
 * The dye_clothing_with_item live contract's judgement, tested DIRECTLY — no transport fake.
 *
 * One case per way the live run could lie: a colour that did not move, a colour that moved when the
 * dye carried the colour the garment already had, a receipt whose "before" is not the colour the
 * world showed, a world whose republished colour disagrees with the receipt, a dye item that was not
 * consumed (or was consumed when the native rule says otherwise), a garment the act removed, a
 * receipt that names another target, non-integer counts, and an observation surface that carries no
 * colour or no inventory — which must read `not_checked`, never a pass.
 */
const TARGET = Object.freeze({
  targetId: "tailoring_dye_0123456789abcdef",
  kind: "dye",
  leftSlot: 0,
  rightSlot: 1,
  leftQualifiedItemId: "(S)1001",
  rightQualifiedItemId: "(O)684",
  garmentColour: "255,255,255",
});

const GARMENT_SLOT = Object.freeze({ slot: 0, qualifiedItemId: "(S)1001", stack: 1 });

function honestEvidence(overrides = {}) {
  return {
    target: TARGET.targetId,
    location: "Farm",
    garment_slot: "0",
    dye_slot: "1",
    garment: TARGET.leftQualifiedItemId,
    dye: TARGET.rightQualifiedItemId,
    colour_before: "255,255,255",
    colour_expected: "0,0,255",
    colour_after: "127,127,255",
    strength: "0.5",
    strength_source: "context_tag_dye_medium",
    colour_changed: "true",
    prismatic_after: "false",
    dye_before: "3",
    dye_after: "2",
    dye_spent: "true",
    colour_route: "TailoringMenu.GetDyeColor",
    ...overrides,
  };
}

const BEFORE = Object.freeze({
  inventory: { "(S)1001": 1, "(O)684": 3 },
  garmentColour: "255,255,255",
  garmentSlot: GARMENT_SLOT,
});
const AFTER = Object.freeze({
  inventory: { "(S)1001": 1, "(O)684": 2 },
  garmentColour: "127,127,255",
  garmentSlot: GARMENT_SLOT,
});

function judge({ evidence = honestEvidence(), before = BEFORE, after = AFTER } = {}) {
  return assertDyeClothingPostconditions({ target: TARGET, evidence, before, after });
}

test("the honest run satisfies every check", () => {
  const checks = judge();
  assert.equal(checks.receiptNamesTheTarget, true);
  assert.equal(checks.receiptCountsAreIntegers, true);
  assert.equal(checks.receiptAgreesWithObservedBefore, true);
  assert.equal(checks.receiptSaysDyeConsumed, true);
  assert.equal(checks.receiptSaysColourApplied, true);
  assert.equal(checks.worldShowsColourAfter, true);
  assert.equal(checks.worldShowsColourMoved, true);
  assert.equal(checks.worldShowsDyeConsumed, true);
  assert.equal(checks.worldShowsGarmentStillOwned, true);
});

test("a colour that did not move is not a dye, on either surface", () => {
  const checks = judge({ evidence: honestEvidence({ colour_after: "255,255,255", colour_changed: "false" }), after: { ...AFTER, garmentColour: "255,255,255" } });
  assert.equal(checks.receiptSaysColourApplied, false);
  assert.equal(checks.worldShowsColourMoved, false);
  assert.equal(checks.worldShowsColourAfter, true);
});

test("a dye that carries the colour the garment already has must NOT move it", () => {
  const checks = judge({
    evidence: honestEvidence({ colour_before: "0,0,255", colour_expected: "0,0,255", colour_after: "0,0,255", colour_changed: "false" }),
    before: { ...BEFORE, garmentColour: "0,0,255" },
    after: { ...AFTER, garmentColour: "0,0,255" },
  });
  assert.equal(checks.receiptSaysColourApplied, true);
  assert.equal(checks.worldShowsColourMoved, true);
  // ...and a colour that moved anyway is the same lie in the other direction.
  const moved = judge({
    evidence: honestEvidence({ colour_before: "0,0,255", colour_expected: "0,0,255", colour_after: "10,0,255", colour_changed: "true" }),
    before: { ...BEFORE, garmentColour: "0,0,255" },
    after: { ...AFTER, garmentColour: "10,0,255" },
  });
  assert.equal(moved.receiptSaysColourApplied, false);
  assert.equal(moved.worldShowsColourMoved, false);
});

test("a republished colour that disagrees with the receipt fails, even when the receipt is self-consistent", () => {
  const checks = judge({ after: { ...AFTER, garmentColour: "200,200,200" } });
  assert.equal(checks.receiptSaysColourApplied, true);
  assert.equal(checks.worldShowsColourAfter, false);
});

test("a receipt whose BEFORE is not the colour the world showed fails", () => {
  assert.equal(judge({ evidence: honestEvidence({ colour_before: "1,2,3" }) }).receiptAgreesWithObservedBefore, false);
});

test("a dye item that stayed in the backpack fails, and a recipe that spends no right item is judged by what it does", () => {
  assert.equal(judge({ evidence: honestEvidence({ dye_after: "3" }), after: { ...AFTER, inventory: { "(S)1001": 1, "(O)684": 3 } } }).receiptSaysDyeConsumed, false);
  const unspent = judge({
    evidence: honestEvidence({ dye_spent: "false", dye_after: "3" }),
    after: { ...AFTER, inventory: { "(S)1001": 1, "(O)684": 3 } },
  });
  assert.equal(unspent.receiptSaysDyeConsumed, true);
  assert.equal(unspent.worldShowsDyeConsumed, true);
  assert.equal(judge({ evidence: honestEvidence({ dye_spent: "false", dye_after: "2" }) }).receiptSaysDyeConsumed, false);
});

test("a garment the act removed is not a dye", () => {
  assert.equal(judge({ after: { ...AFTER, garmentSlot: null } }).worldShowsGarmentStillOwned, false);
});

test("a receipt that names another target fails", () => {
  assert.equal(judge({ evidence: honestEvidence({ garment: "(S)1002" }) }).receiptNamesTheTarget, false);
  assert.equal(judge({ evidence: honestEvidence({ dye: "(O)685" }) }).receiptNamesTheTarget, false);
  assert.equal(judge({ evidence: honestEvidence({ target: "tailoring_dye_ffffffffffffffff" }) }).receiptNamesTheTarget, false);
});

test("non-integer counts fail before anything is compared", () => {
  const checks = judge({ evidence: honestEvidence({ dye_before: "many" }) });
  assert.equal(checks.receiptCountsAreIntegers, false);
  assert.equal(checks.receiptSaysDyeConsumed, false);
});

test("an observation surface without colour or inventory reports those halves as not_checked", () => {
  const checks = judge({
    before: { inventory: null, garmentColour: null, garmentSlot: null },
    after: { inventory: null, garmentColour: null, garmentSlot: null },
  });
  assert.equal(checks.worldShowsColourAfter, "not_checked");
  assert.equal(checks.worldShowsColourMoved, "not_checked");
  assert.equal(checks.worldShowsDyeConsumed, "not_checked");
  assert.equal(checks.worldShowsGarmentStillOwned, "not_checked");
  // The receipt's own "before" cannot be corroborated at all, which is a failure, not a pass.
  assert.equal(checks.receiptAgreesWithObservedBefore, false);
});
