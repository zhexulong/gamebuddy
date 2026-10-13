import assert from "node:assert/strict";
import test from "node:test";

import { assertAcceptSpecialOrderPostconditions } from "./run-stardew-native-local-player-accept-special-order-smoke.mjs";

/**
 * The accept_special_order live judgement, tested DIRECTLY - no transport fake.
 *
 * The judgement is pure, so it is exported and exercised here with no client at all, which is also what
 * makes these cases meaningful: each one is a distinct way the LIVE run could lie. The runner fails on any
 * `false` OR `not_checked`, so the "could not look" cases are asserted to be `not_checked` rather than a
 * silent pass.
 */

const TARGET = { targetId: "special_order_0123456789abcdef", questKey: "Museum_Order", orderType: "", generationSeed: 4242 };

const EVIDENCE = {
  special_order_id: TARGET.targetId,
  board_type: "none",
  quest_key: TARGET.questKey,
  generation_seed: "4242",
  board_marker_before: "false",
  board_marker_after: "true",
  orders_before: "0",
  orders_after: "1",
  order_present_after: "true",
  order_in_progress_after: "true",
};

const PASSING = {
  target: TARGET,
  evidence: EVIDENCE,
  targetsAfter: [],
  activeOrderKeysAfter: [TARGET.questKey],
};

/** The checks that would fail the run: `false` and `not_checked` both count. */
const failures = (checks) => Object.entries(checks).filter(([, ok]) => ok === false || ok === "not_checked").map(([name]) => name);

test("the honest happy path passes every check", () => {
  const checks = assertAcceptSpecialOrderPostconditions(PASSING);
  assert.deepEqual(checks, {
    receiptSaysAccepted: true,
    activeListGrewByOne: true,
    boardTypeMarked: true,
    evidenceNamesTheOffer: true,
    offerNoLongerAdvertised: true,
    noOfferLeftOnTheBoard: true,
    activeListNamesOrder: true,
  });
});

test("a receipt claiming an accept whose order never entered the active list fails", () => {
  const checks = assertAcceptSpecialOrderPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, order_present_after: "false" },
  });
  assert.equal(checks.receiptSaysAccepted, false);
});

test("an accept whose order is not InProgress fails", () => {
  const checks = assertAcceptSpecialOrderPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, order_in_progress_after: "false" },
  });
  assert.equal(checks.receiptSaysAccepted, false);
});

test("an accept that added NO order fails: the write half adds exactly one", () => {
  const checks = assertAcceptSpecialOrderPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, orders_after: "0" },
  });
  assert.equal(checks.activeListGrewByOne, false);
});

test("an accept that added TWO orders fails", () => {
  const checks = assertAcceptSpecialOrderPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, orders_before: "1", orders_after: "3" },
  });
  assert.equal(checks.activeListGrewByOne, false);
});

test("an accept that skipped the board's own marker fails", () => {
  const checks = assertAcceptSpecialOrderPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, board_marker_after: "false" },
  });
  assert.equal(checks.boardTypeMarked, false);
  assert.equal(checks.receiptSaysAccepted, false);
});

test("an accept against a board that was ALREADY marked fails: the marker must flip", () => {
  const checks = assertAcceptSpecialOrderPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, board_marker_before: "true" },
  });
  assert.equal(checks.boardTypeMarked, false);
});

test("a receipt naming a DIFFERENT order than the target fails", () => {
  const checks = assertAcceptSpecialOrderPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, quest_key: "Some_Other_Order" },
  });
  assert.equal(checks.evidenceNamesTheOffer, false);
});

test("an offer still advertised after the accept fails: the published fact must change", () => {
  const checks = assertAcceptSpecialOrderPostconditions({
    ...PASSING,
    targetsAfter: [{ ...TARGET }],
  });
  assert.equal(checks.offerNoLongerAdvertised, false);
  assert.equal(checks.noOfferLeftOnTheBoard, false);
});

test("a DIFFERENT offer still on the board fails: the fixture published exactly one", () => {
  const checks = assertAcceptSpecialOrderPostconditions({
    ...PASSING,
    targetsAfter: [{ targetId: "special_order_fedcba9876543210", questKey: "Qi_Order", orderType: "Qi", generationSeed: 7 }],
  });
  assert.equal(checks.offerNoLongerAdvertised, true);
  assert.equal(checks.noOfferLeftOnTheBoard, false);
});

test("a snapshot whose active-order read does not name the accepted order fails", () => {
  const checks = assertAcceptSpecialOrderPostconditions({ ...PASSING, activeOrderKeysAfter: [] });
  assert.equal(checks.activeListNamesOrder, false);
});

test("a surface with no specialOrderTargets reports not_checked, NEVER a pass", () => {
  const checks = assertAcceptSpecialOrderPostconditions({ ...PASSING, targetsAfter: null });
  assert.equal(checks.offerNoLongerAdvertised, "not_checked");
  assert.equal(checks.noOfferLeftOnTheBoard, "not_checked");
  assert.deepEqual(failures(checks).sort(), ["noOfferLeftOnTheBoard", "offerNoLongerAdvertised"]);
});

test("a surface with no activeSpecialOrderKeys reports not_checked, NEVER a pass", () => {
  const checks = assertAcceptSpecialOrderPostconditions({ ...PASSING, activeOrderKeysAfter: null });
  assert.equal(checks.activeListNamesOrder, "not_checked");
  assert.deepEqual(failures(checks), ["activeListNamesOrder"]);
});
