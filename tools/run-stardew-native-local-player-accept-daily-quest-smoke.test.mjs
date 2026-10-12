import assert from "node:assert/strict";
import test from "node:test";

import { assertAcceptDailyQuestPostconditions } from "./run-stardew-native-local-player-accept-daily-quest-smoke.mjs";

/**
 * The accept_daily_quest live judgement, tested DIRECTLY - no transport fake.
 *
 * The judgement is pure, so it is exported and exercised here with no client at all, which is also
 * what makes these cases meaningful: each one is a distinct way the LIVE run could lie. The runner
 * fails on any `false` OR `not_checked`, so the "could not look" cases are asserted to be
 * `not_checked` rather than a silent pass.
 */

const TARGET = { targetId: "daily_quest_0123456789abcdef", questType: 10, title: "Help Wanted" };

const EVIDENCE = {
  daily_quest_id: TARGET.targetId,
  day_of_month: "12",
  quest_type: "10",
  accepted_before: "false",
  accepted_daily_before: "false",
  days_left_before: "-1",
  quest_log_before: "0",
  quest_log_after: "1",
  days_left_after: "2",
  accepted_after: "true",
  accepted_daily_after: "true",
  daily_after: "true",
  can_be_cancelled_after: "true",
  day_accepted_after: "120",
};

const PASSING = {
  target: TARGET,
  evidence: EVIDENCE,
  targetsAfter: [],
  acceptedDailyQuestAfter: true,
};

test("the honest happy path passes every check", () => {
  const checks = assertAcceptDailyQuestPostconditions(PASSING);
  assert.deepEqual(checks, {
    receiptSaysAccepted: true,
    questEnteredLogExactlyOnce: true,
    boardFieldsWritten: true,
    offerNoLongerAdvertised: true,
    worldReportsAccepted: true,
  });
});

test("a receipt claiming an accept whose quest never entered the log fails", () => {
  const checks = assertAcceptDailyQuestPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, quest_log_after: "0" },
  });
  assert.equal(checks.questEnteredLogExactlyOnce, false);
});

test("an accept that logged the quest TWICE fails: the write half adds exactly one entry", () => {
  const checks = assertAcceptDailyQuestPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, quest_log_after: "2" },
  });
  assert.equal(checks.questEnteredLogExactlyOnce, false);
});

test("a receipt whose accepted flags never flipped fails", () => {
  const checks = assertAcceptDailyQuestPostconditions({
    ...PASSING,
    evidence: { ...EVIDENCE, accepted_after: "false", accepted_daily_after: "false" },
  });
  assert.equal(checks.receiptSaysAccepted, false);
});

test("an accept that skipped the board's other fields fails", () => {
  for (const broken of [{ days_left_after: "1" }, { daily_after: "false" }, { can_be_cancelled_after: "false" }]) {
    const checks = assertAcceptDailyQuestPostconditions({ ...PASSING, evidence: { ...EVIDENCE, ...broken } });
    assert.equal(checks.boardFieldsWritten, false, `${JSON.stringify(broken)} must fail boardFieldsWritten`);
  }
});

test("an offer still advertised after the accept fails: the published fact must change", () => {
  const checks = assertAcceptDailyQuestPostconditions({
    ...PASSING,
    targetsAfter: [{ targetId: TARGET.targetId, questType: 10, title: "Help Wanted" }],
  });
  assert.equal(checks.offerNoLongerAdvertised, false);
});

test("a DIFFERENT offer still advertised does not fail: only this target's absence is claimed", () => {
  const checks = assertAcceptDailyQuestPostconditions({
    ...PASSING,
    targetsAfter: [{ targetId: "daily_quest_fedcba9876543210", questType: 10, title: "Help Wanted" }],
  });
  assert.equal(checks.offerNoLongerAdvertised, true);
});

test("a world that does not report the daily quest as accepted fails", () => {
  const checks = assertAcceptDailyQuestPostconditions({ ...PASSING, acceptedDailyQuestAfter: false });
  assert.equal(checks.worldReportsAccepted, false);
});

test("a surface with no dailyQuestTargets reports not_checked, NEVER a pass", () => {
  const checks = assertAcceptDailyQuestPostconditions({ ...PASSING, targetsAfter: null });
  assert.equal(checks.offerNoLongerAdvertised, "not_checked");
  assert.equal(
    Object.entries(checks).filter(([, ok]) => ok === false || ok === "not_checked").length,
    1,
    "the run must fail, on exactly this check",
  );
});

test("a surface with no acceptedDailyQuest field reports not_checked, NEVER a pass", () => {
  const checks = assertAcceptDailyQuestPostconditions({ ...PASSING, acceptedDailyQuestAfter: undefined });
  assert.equal(checks.worldReportsAccepted, "not_checked");
  assert.equal(
    Object.entries(checks).filter(([, ok]) => ok === false || ok === "not_checked").length,
    1,
    "the run must fail, on exactly this check",
  );
});
