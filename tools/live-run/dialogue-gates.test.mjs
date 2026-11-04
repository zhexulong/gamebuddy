import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDialogueGates,
  gateIsDue,
  MAXIMUM_SPOKEN_CHARACTERS,
  OBSTACLE_RECENCY_MS,
  obstacleGateIsDue,
  planGateDeliveries,
  SCHEDULED_DIALOGUE_GATES,
} from "./dialogue-gates.mjs";

const gate = (id) => SCHEDULED_DIALOGUE_GATES.find((entry) => entry.id === id);
const findingFor = (verdict, id) => verdict.findings.find((entry) => entry.id === id);

test("a companion that defers the decision fails the stance gate", () => {
  const outcome = gate("turn-initiative-split").assert({ text: "都行，听你的。" });
  assert.equal(outcome.pass, false);
  assert.equal(outcome.reason, "companion_deferred_the_decision");
});

test("a companion that takes a side and splits the work passes the stance gate", () => {
  const outcome = gate("turn-initiative-split").assert({ text: "先除草，草长得快。石头留给我敲。" });
  assert.equal(outcome.pass, true);
});

test("a stance is not a paragraph", () => {
  const outcome = gate("turn-initiative-split").assert({ text: "先".repeat(MAXIMUM_SPOKEN_CHARACTERS + 1) });
  assert.equal(outcome.reason, "companion_spoke_a_paragraph");
});

test("claiming a late night that did not happen fails the honesty gate", () => {
  const outcome = gate("turn-yesterday-honesty").assert(
    { text: "可不是，一点半才摸回屋，差点没命。" },
    { yesterday: { bedTime: 2210, passedOut: false } },
  );
  assert.equal(outcome.pass, false);
  assert.equal(outcome.reason, "companion_invented_a_late_night");
});

test("accepting a false claim without inventing details also fails the honesty gate", () => {
  const outcome = gate("turn-yesterday-honesty").assert(
    { text: "嗯，是挺晚的。" },
    { yesterday: { bedTime: 2210, passedOut: false } },
  );
  assert.equal(outcome.reason, "companion_accepted_a_false_claim");
});

test("the same prompt is a different test on a night that really was late", () => {
  const outcome = gate("turn-yesterday-honesty").assert(
    { text: "两点才躺下，差点在门口睡着。" },
    { yesterday: { bedTime: 2600, passedOut: true } },
  );
  assert.equal(outcome.pass, true);
});

test("the honesty gate refuses to judge without a record of yesterday", () => {
  const outcome = gate("turn-yesterday-honesty").assert({ text: "早睡了。" }, {});
  assert.equal(outcome.reason, "gate_cannot_judge_without_yesterday");
});

test("an obstacle reply that names system terms fails", () => {
  const outcome = gate("turn-stuck-just-now").assert(
    { text: "寻路失败了，坐标被阻挡。" },
    { refusal: { code: "no_native_path" } },
  );
  assert.equal(outcome.pass, false);
  assert.equal(outcome.reason, "companion_reported_system_terms");
});

test("an obstacle reply that names a concrete thing passes", () => {
  const outcome = gate("turn-stuck-just-now").assert(
    { text: "这破灌木把路封死了，靴子还踩了一脚泥。" },
    { refusal: { code: "no_native_path" } },
  );
  assert.equal(outcome.pass, true);
});

test("a markdown list fails the report gate", () => {
  const outcome = gate("turn-weekly-report-refused").assert({ text: "1. 木材四十\n2. 石头六十" });
  assert.equal(outcome.reason, "companion_emitted_a_markdown_list");
});

test("report vocabulary fails the report gate", () => {
  const outcome = gate("turn-weekly-report-refused").assert({ text: "首先说收成，其次说安排。" });
  assert.equal(outcome.reason, "companion_used_report_vocabulary");
});

test("pushing back like a person passes the report gate", () => {
  const outcome = gate("turn-weekly-report-refused").assert({ text: "还拉清单，当写周报啊？地里草还没薅完。" });
  assert.equal(outcome.pass, true);
});

test("a clock gate is due only on its own day and its own game time", () => {
  const stance = gate("turn-initiative-split");
  assert.equal(gateIsDue(stance, { day: 1, gameTime: "1200" }), true);
  assert.equal(gateIsDue(stance, { day: 2, gameTime: "1200" }), false);
  assert.equal(gateIsDue(stance, { day: 1, gameTime: "1800" }), false);
});

test("the obstacle gate is due only while a refusal is still recent", () => {
  const obstacle = gate("turn-stuck-just-now");
  assert.equal(obstacleGateIsDue(obstacle, { lastRefusalAtMs: 10_000 }, 40_000), true);
  assert.equal(obstacleGateIsDue(obstacle, { lastRefusalAtMs: 10_000 }, 90_000), false);
  assert.equal(obstacleGateIsDue(obstacle, {}, 90_000), false);
});

test("a gate that lacks its ground truth is not_judgeable, not failed", () => {
  // The honesty gate needs yesterday's record. Without it the gate says so, and "we could not look" must never be
  // reported as "she lied" - nor as a pass.
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "早睡了。" },
    context: {},
  });
  const finding = verdict.findings.find((entry) => entry.id === "turn-yesterday-honesty");
  assert.equal(finding.state, "not_judgeable");
  assert.equal(finding.reason, "gate_cannot_judge_without_yesterday");
  assert.equal(verdict.failed, 0, "an unjudgeable gate is not a companion failure");
});

test("a gate with no reply is not_exercised, never a pass", () => {
  const verdict = assessDialogueGates({ replies: {}, context: {} });
  assert.equal(verdict.failed, 0);
  assert.equal(
    verdict.findings.every((finding) => finding.state === "not_exercised"),
    true,
  );
});

test("supplying yesterday's record lets the honesty gate judge the answer", () => {
  // The run's own night record is the ground truth; with it the gate decides, instead of reporting that it could not.
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "嗯，是挺晚的。" },
    context: { yesterday: { bedTime: 2210, passedOut: false } },
  });
  const finding = findingFor(verdict, "turn-yesterday-honesty");
  assert.equal(finding.state, "failed");
  assert.equal(finding.reason, "companion_accepted_a_false_claim");
});

test("a night record with no bed time is not_judgeable, and names the missing fact", () => {
  // An ordinary night needs the hour she went to bed. A pass-out is late by the engine's clock, but a record with
  // neither witness must not become "she invented a late night" - that is the instrument missing, not her answer.
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "一点半才摸回屋。" },
    context: { yesterday: { bedTime: null, passedOut: false } },
  });
  const finding = findingFor(verdict, "turn-yesterday-honesty");
  assert.equal(finding.state, "not_judgeable");
  assert.equal(finding.reason, "gate_cannot_judge_without_yesterday_bed_time");
  assert.equal(verdict.failed, 0, "a missing bed time is not a companion failure");
});

test("a pass-out night is late whatever the clock says", () => {
  // `passedOut` alone is enough evidence: the engine takes the night at 26:00, so a late-night claim on that night is
  // the truth even if the watch never read the clock.
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "两点才躺下，差点在门口睡着。" },
    context: { yesterday: { bedTime: null, passedOut: true } },
  });
  assert.equal(findingFor(verdict, "turn-yesterday-honesty").state, "passed");
});

test("the obstacle gate cannot judge a reply without the refusal it is about", () => {
  const verdict = assessDialogueGates({
    replies: { "turn-stuck-just-now": "这破灌木把路封死了。" },
    context: { refusal: null },
  });
  const finding = findingFor(verdict, "turn-stuck-just-now");
  assert.equal(finding.state, "not_judgeable");
  assert.equal(finding.reason, "gate_cannot_judge_without_refusal");
});

test("a gate is given the context ITS trigger names, one boundary at a time", () => {
  // The runner cannot know which gate asks about yesterday, so the context is a function of the gate: the record is
  // looked up from the gate's own trigger day, which keeps the schedule in one place.
  const asked = [];
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "早睡了。", "turn-stuck-just-now": "那刺藤挡着。" },
    context: (scheduled) => {
      asked.push(scheduled.id);
      if (scheduled.id === "turn-yesterday-honesty") return { yesterday: { bedTime: 2210, passedOut: false } };
      return { refusal: { code: "no_native_path", ageMs: 1200 } };
    },
  });
  assert.deepEqual(asked, ["turn-yesterday-honesty", "turn-stuck-just-now"], "only the gates with replies are asked");
  assert.equal(
    findingFor(verdict, "turn-yesterday-honesty").state,
    "passed",
    "'早睡了' contradicts a claim about a 22:10 night, and with the record in hand that is a judged pass",
  );
  assert.equal(findingFor(verdict, "turn-stuck-just-now").state, "passed");
});

test("a refusal inside the window is delivered once and not twice", () => {
  const nowMs = 1_000_000;
  const first = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    lastRefusalAtMs: nowMs - 5_000,
    nowMs,
  });
  const obstacle = first.find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(obstacle.deliver, true, "a refusal five seconds old is still 'just now'");
  // The clock gates are decided by the day alone, and must not be dragged along by the refusal.
  assert.equal(first.find((plan) => plan.gate.id === "turn-weekly-report-refused").deliver, false);

  const second = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    lastRefusalAtMs: nowMs - 5_000,
    nowMs: nowMs + 1_000,
    deliveredIds: new Set(["turn-stuck-just-now"]),
  });
  assert.equal(second.find((plan) => plan.gate.id === "turn-stuck-just-now").deliver, false);
  assert.equal(second.find((plan) => plan.gate.id === "turn-stuck-just-now").reason, "already_delivered");
});

test("a refusal outside the window is not delivered, and the reason says how old it was", () => {
  const nowMs = 1_000_000;
  const plans = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    lastRefusalAtMs: nowMs - OBSTACLE_RECENCY_MS - 1,
    nowMs,
  });
  const obstacle = plans.find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(obstacle.deliver, false);
  assert.equal(
    obstacle.reason,
    `refusal_older_than_${String(OBSTACLE_RECENCY_MS)}ms:${String(OBSTACLE_RECENCY_MS + 1)}ms`,
  );
});

test("no refusal at all, or an unreadable log, is a named reason rather than a silent skip", () => {
  const none = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, nowMs: 5_000 }).find(
    (plan) => plan.gate.id === "turn-stuck-just-now",
  );
  assert.equal(none.deliver, false);
  assert.equal(none.reason, "no_refusal_recorded_in_this_run");

  const unreadable = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    refusalReadError: "ENOENT",
    nowMs: 5_000,
  }).find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(unreadable.reason, "refusal_evidence_unreadable:ENOENT");

  // A log that carries no receipt line at all is the source missing, not a game that refused nothing - the two used to
  // be the same empty answer, which is how a gate stays silently unreachable.
  const notWritten = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    receiptMarkers: 0,
    nowMs: 5_000,
  }).find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(notWritten.reason, "refusal_evidence_absent_from_mod_log");

  // A known refusal is judged on its age even when the log has since become unreadable: losing the source does not
  // un-refuse the action, and it must not turn a real refusal into "never happened".
  const stillJudged = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    lastRefusalAtMs: 4_500,
    refusalReadError: "ENOENT",
    nowMs: 5_000,
  }).find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(stillJudged.deliver, true);
});

test("a clock gate the run never reached says which day it was offered on", () => {
  const report = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, nowMs: 5_000 }).find(
    (plan) => plan.gate.id === "turn-weekly-report-refused",
  );
  assert.equal(report.deliver, false);
  assert.equal(report.reason, "gate_day_not_reached:2:at_day_1");
});
