import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTailorClothingPostconditions,
  inventoryItemCounts,
} from "./run-stardew-native-local-player-tailor-clothing-smoke.mjs";

/**
 * The tailor_clothing live contract's judgement, tested DIRECTLY — no transport fake.
 *
 * One case per way the live run could lie: a garment that never appeared, reagents that stayed, a
 * receipt whose own counts disagree with each other, a receipt whose counts disagree with the WORLD,
 * a disposition that does not match the split it reports, an inventory surface that is absent (which
 * must read `not_checked`, never a pass), and a receipt that names a different target.
 *
 * The honest case is first and every other case flips exactly ONE fact away from it, so a check
 * that silently stopped checking would leave its case green and be caught.
 */
const TARGET = Object.freeze({
  targetId: "tailoring_recipe_0123456789abcdef",
  kind: "recipe",
  leftSlot: 0,
  rightSlot: 1,
  leftQualifiedItemId: "(O)428",
  rightQualifiedItemId: "(O)684",
  outputQualifiedItemId: "(S)1001",
});

function honestEvidence(overrides = {}) {
  return {
    target: TARGET.targetId,
    location: "Farm",
    left_slot: "0",
    right_slot: "1",
    left: TARGET.leftQualifiedItemId,
    right: TARGET.rightQualifiedItemId,
    output: TARGET.outputQualifiedItemId,
    left_before: "3",
    left_after: "2",
    right_before: "3",
    right_after: "2",
    right_spent: "true",
    output_before: "0",
    output_after: "1",
    delivered: "1",
    dropped: "0",
    disposition: "inventory",
    dropped_debris: "0",
    ...overrides,
  };
}

const BEFORE = Object.freeze({ "(O)428": 3, "(O)684": 3 });
const AFTER = Object.freeze({ "(O)428": 2, "(O)684": 2, "(S)1001": 1 });

function judge({ evidence = honestEvidence(), before = BEFORE, after = AFTER } = {}) {
  return assertTailorClothingPostconditions({ target: TARGET, evidence, before, after });
}

test("the honest run satisfies every check", () => {
  const checks = judge();
  assert.equal(checks.receiptNamesTheTarget, true);
  assert.equal(checks.receiptCountsAreIntegers, true);
  assert.equal(checks.receiptSaysReagentsSpent, true);
  assert.equal(checks.receiptSaysGarmentExists, true);
  assert.equal(checks.dispositionMatchesSplit, true);
  assert.equal(checks.worldShowsReagentsSpent, true);
  assert.equal(checks.worldShowsGarmentExists, true);
});

test("a garment that never appeared fails the second half of the postcondition", () => {
  const checks = judge({
    evidence: honestEvidence({ output_after: "0", delivered: "0", dropped: "0", disposition: "dropped_on_ground" }),
    after: { "(O)428": 2, "(O)684": 2 },
  });
  assert.equal(checks.receiptSaysGarmentExists, false);
  assert.equal(checks.worldShowsGarmentExists, false);
});

test("reagents that stayed in the backpack fail the first half of the postcondition", () => {
  const checks = judge({
    evidence: honestEvidence({ left_after: "3", right_after: "3" }),
    after: { "(O)428": 3, "(O)684": 3, "(S)1001": 1 },
  });
  assert.equal(checks.receiptSaysReagentsSpent, false);
  assert.equal(checks.worldShowsReagentsSpent, false);
});

test("a recipe that spends no right item is judged by the item it does not spend", () => {
  const checks = judge({
    evidence: honestEvidence({ right_spent: "false", right_after: "3" }),
    after: { "(O)428": 2, "(O)684": 3, "(S)1001": 1 },
  });
  assert.equal(checks.receiptSaysReagentsSpent, true);
  assert.equal(checks.worldShowsReagentsSpent, true);
  // ...and claiming the right item was spent when the recipe says otherwise is a lie.
  assert.equal(judge({ evidence: honestEvidence({ right_spent: "false", right_after: "2" }) }).receiptSaysReagentsSpent, false);
});

test("a receipt whose counts disagree with the world fails even when its own counts are coherent", () => {
  const checks = judge({ evidence: honestEvidence({ delivered: "1", output_after: "1" }), after: { "(O)428": 2, "(O)684": 2 } });
  assert.equal(checks.receiptSaysGarmentExists, true);
  assert.equal(checks.worldShowsGarmentExists, false);
});

test("a world that shows MORE consumption than the receipt claims fails too", () => {
  const checks = judge({ after: { "(O)428": 1, "(O)684": 1, "(S)1001": 1 } });
  assert.equal(checks.worldShowsReagentsSpent, false);
});

test("a disposition that does not match the reported split fails", () => {
  assert.equal(judge({ evidence: honestEvidence({ disposition: "dropped_on_ground" }) }).dispositionMatchesSplit, false);
  assert.equal(
    judge({
      evidence: honestEvidence({ delivered: "0", dropped: "1", output_after: "0", disposition: "inventory" }),
      after: { "(O)428": 2, "(O)684": 2 },
    }).dispositionMatchesSplit,
    false,
  );
  assert.equal(
    judge({
      evidence: honestEvidence({ delivered: "0", dropped: "1", output_after: "0", disposition: "dropped_on_ground" }),
      after: { "(O)428": 2, "(O)684": 2 },
    }).dispositionMatchesSplit,
    true,
  );
});

test("an absent inventory surface reports the world halves as not_checked, never as a pass", () => {
  const checks = judge({ before: null, after: null });
  assert.equal(checks.worldShowsReagentsSpent, "not_checked");
  assert.equal(checks.worldShowsGarmentExists, "not_checked");
});

test("a receipt that names another target fails", () => {
  assert.equal(judge({ evidence: honestEvidence({ output: "(S)1002" }) }).receiptNamesTheTarget, false);
  assert.equal(judge({ evidence: honestEvidence({ target: "tailoring_recipe_ffffffffffffffff" }) }).receiptNamesTheTarget, false);
});

test("non-integer counts fail before anything is compared", () => {
  const checks = judge({ evidence: honestEvidence({ left_before: "you cannot eat a chicken" }) });
  assert.equal(checks.receiptCountsAreIntegers, false);
  assert.equal(checks.receiptSaysReagentsSpent, false);
  assert.equal(checks.receiptSaysGarmentExists, false);
});

test("inventoryItemCounts treats an absent projection as not observed and sums stacks otherwise", () => {
  assert.equal(inventoryItemCounts({}), null);
  assert.equal(inventoryItemCounts({ inventoryItemFacts: "nope" }), null);
  assert.deepEqual(
    inventoryItemCounts({
      inventoryItemFacts: [
        { slot: 0, qualifiedItemId: "(O)428", stack: 2 },
        { slot: 5, qualifiedItemId: "(O)428", stack: 1 },
        { slot: 6, qualifiedItemId: "(S)1001", stack: 1 },
        { slot: 7, qualifiedItemId: "(O)999" },
      ],
    }),
    { "(O)428": 3, "(S)1001": 1 },
  );
});
