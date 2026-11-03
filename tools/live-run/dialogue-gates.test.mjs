import assert from "node:assert/strict";
import test from "node:test";

import {
  MAXIMUM_SPOKEN_CHARACTERS,
  SCHEDULED_DIALOGUE_GATES,
  assessDialogueGates,
  gateIsDue,
  obstacleGateIsDue,
} from "./dialogue-gates.mjs";

const gate = (id) => SCHEDULED_DIALOGUE_GATES.find((entry) => entry.id === id);

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
