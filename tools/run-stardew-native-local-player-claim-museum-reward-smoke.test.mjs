import assert from "node:assert/strict";
import test from "node:test";

import { assertClaimMuseumRewardPostconditions } from "./run-stardew-native-local-player-claim-museum-reward-smoke.mjs";

/**
 * The claim_museum_reward live judgement, tested DIRECTLY - no transport fake.
 *
 * The judgement is pure, so it is exported and exercised here with no client at all, which is also what
 * makes these cases meaningful: each one is a distinct way the LIVE run could lie. The runner fails on any
 * `false` OR `not_checked`, so the "could not look" case is asserted to be `not_checked` rather than a
 * silent pass.
 */

const TARGET = { targetId: "museum_reward_0123456789abcdef", location: "ArchaeologyHouse", rewardCount: 3 };

const EVIDENCE = {
  target: TARGET.targetId,
  location: "ArchaeologyHouse",
  rewards_before: "3",
  rewards_returned: "3",
  rewards_delivered: "3",
  rewards_recorded: "3",
  rewards_after: "0",
  mail_flags_before: "12",
  mail_flags_after: "16",
  inventory_units_before: "40",
  inventory_units_after: "43",
  rewards_collected: "true",
};

const PASSING = { target: TARGET, evidence: EVIDENCE, targetsAfter: [] };

/** The checks that would fail the run: `false` and `not_checked` both count. */
const failures = (checks) => Object.entries(checks).filter(([, ok]) => ok === false || ok === "not_checked").map(([name]) => name);

test("the honest happy path passes every check", () => {
  const checks = assertClaimMuseumRewardPostconditions(PASSING);
  assert.deepEqual(checks, {
    receiptSaysCollected: true,
    returnedTheWholePublishedSet: true,
    deliveredAndRecordedTheWholeSet: true,
    nothingLeftToCollect: true,
    somethingWasRecorded: true,
    publishedFactChanged: true,
  });
});

test("a receipt that does not claim the collection fails", () => {
  const checks = assertClaimMuseumRewardPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, rewards_collected: "false" },
  });
  assert.equal(checks.receiptSaysCollected, false);
});

test("an empty published set is not the declared Given", () => {
  const checks = assertClaimMuseumRewardPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, rewards_before: "0", rewards_returned: "0", rewards_delivered: "0", rewards_recorded: "0" },
  });
  assert.equal(checks.returnedTheWholePublishedSet, false);
  assert.equal(checks.deliveredAndRecordedTheWholeSet, false);
});

test("an enumeration that returned FEWER rewards than the target named fails", () => {
  const checks = assertClaimMuseumRewardPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, rewards_returned: "2", rewards_delivered: "2", rewards_recorded: "2" },
  });
  assert.equal(checks.returnedTheWholePublishedSet, false);
});

test("a reward that was recorded but never deposited fails", () => {
  const checks = assertClaimMuseumRewardPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, rewards_delivered: "2" },
  });
  assert.equal(checks.deliveredAndRecordedTheWholeSet, false);
});

test("a reward that was deposited but never recorded fails: the reward would be paid twice", () => {
  const checks = assertClaimMuseumRewardPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, rewards_recorded: "2" },
  });
  assert.equal(checks.deliveredAndRecordedTheWholeSet, false);
});

test("a claim that left something collectable fails", () => {
  const checks = assertClaimMuseumRewardPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, rewards_after: "1" },
  });
  assert.equal(checks.nothingLeftToCollect, false);
});

test("a claim that recorded nothing at all fails", () => {
  const checks = assertClaimMuseumRewardPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, mail_flags_after: "12" },
  });
  assert.equal(checks.somethingWasRecorded, false);
});

test("a reward set still advertised after the claim fails: the published fact must change", () => {
  const checks = assertClaimMuseumRewardPostconditions({ ...PASSING, targetsAfter: [{ ...TARGET }] });
  assert.equal(checks.publishedFactChanged, false);
});

test("an EMPTY projection with a different target id still counts as changed", () => {
  const checks = assertClaimMuseumRewardPostconditions({
    ...PASSING,
    targetsAfter: [{ targetId: "museum_reward_fedcba9876543210", location: "ArchaeologyHouse", rewardCount: 1 }],
  });
  assert.equal(checks.publishedFactChanged, false, "the target set must be empty, not merely different");
});

test("a surface with no museumRewardTargets reports not_checked, NEVER a pass", () => {
  const checks = assertClaimMuseumRewardPostconditions({ ...PASSING, targetsAfter: null });
  assert.equal(checks.publishedFactChanged, "not_checked");
  assert.deepEqual(failures(checks), ["publishedFactChanged"]);
});
