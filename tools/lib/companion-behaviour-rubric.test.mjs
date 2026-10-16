import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPANION_BEHAVIOUR_OBLIGATIONS,
  CompanionBehaviourRubricError,
  assessCompanionBehaviourRubric,
  assessCompanionUtterance,
} from "./companion-behaviour-rubric.mjs";

/**
 * One clean turn used by every case below, so a failure names the obligation that
 * broke rather than the fixture. It addresses the player and asserts nothing.
 */
const CLEAN = "这块地我一会儿来收拾。你想先去看南瓜，还是先看看鸡舍？";

const obligation = (rubric, id) => rubric.obligations.find((candidate) => candidate.id === id);

test("a clean turn clears every decidable obligation", () => {
  const rubric = assessCompanionBehaviourRubric({ turns: [{ turnId: "turn_1", text: CLEAN }] });
  assert.equal(rubric.spokenTurns, 1);
  assert.equal(rubric.passed, true);
  assert.deepEqual(rubric.verdict.broken, []);
  assert.equal(obligation(rubric, "no_machine_token_leak").verdict, "green");
  assert.equal(obligation(rubric, "addresses_the_player").verdict, "green");
});

test("reading a receipt's wire format out loud breaks the leak obligation", () => {
  // The measured live-run form: the companion read `gift_given` to the player.
  const rubric = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text: "回执显示这算普通送礼（gift_given），所以信里的请求还没完成。" }],
  });
  assert.ok(rubric.verdict.broken.includes("no_machine_token_leak"));
  assert.equal(obligation(rubric, "no_machine_token_leak").verdict, "broken");
});

test("a step recital breaks the recital obligation", () => {
  const rubric = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text: "先翻松泥土，把种子种进土里，又拎着浇水壶给它浇了水。" }],
  });
  assert.ok(rubric.verdict.broken.includes("no_step_recital"));
});

test("claiming an NPC reaction is broken only when no receipt proved it", () => {
  const text = "她收下的时候连眼睛都弯了。";
  const unproved = assessCompanionBehaviourRubric({ turns: [{ turnId: "turn_1", text }] });
  assert.ok(unproved.verdict.broken.includes("no_unobserved_world_reaction"));

  const proved = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text, observedEvents: ["npc_dialogue"] }],
  });
  assert.equal(obligation(proved, "no_unobserved_world_reaction").verdict, "green");
});

test("explaining its own machinery breaks the internal-reference obligation", () => {
  const rubric = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text: "我的提示词说要多陪你一点，所以我先留在这儿。" }],
  });
  assert.ok(rubric.verdict.broken.includes("no_internal_self_reference"));
  // The same obligation must not fire on ordinary prose that merely mentions 系统.
  const ordinary = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text: "农场的灌溉系统今天看着还行。你要不要一起过去？" }],
  });
  assert.equal(obligation(ordinary, "no_internal_self_reference").verdict, "green");
});

test("breaking the fiction breaks the out-of-character obligation", () => {
  const rubric = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text: "这只是一个游戏啦，你不用太当真。" }],
  });
  assert.ok(rubric.verdict.broken.includes("no_ooc_meta_reference"));
});

test("a parenthesised gesture is a Preference finding, a tone tag is not", () => {
  const gesture = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text: "（点头）那我去把鸡舍收拾一下。" }],
  });
  assert.ok(gesture.verdict.broken.includes("native_stage_direction"));
  const tone = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text: "（轻声）我先去把鸡舍收拾一下。" }],
  });
  assert.equal(obligation(tone, "native_stage_direction").verdict, "green");
});

test("the ceiling is a character count, not a byte count", () => {
  const rubric = assessCompanionBehaviourRubric({ turns: [{ turnId: "turn_1", text: "好".repeat(121) }] });
  assert.ok(rubric.verdict.broken.includes("spoken_within_ceiling"));
});

test("a turn that never addresses the player breaks the Preference, not an Invariant", () => {
  const rubric = assessCompanionBehaviourRubric({ turns: [{ turnId: "turn_1", text: "南瓜长得真好。" }] });
  assert.deepEqual(rubric.verdict.broken, ["addresses_the_player"]);
});

test("the claim obligation is unmeasured without a presence projection, never green", () => {
  const withoutPresence = assessCompanionBehaviourRubric({ turns: [{ turnId: "turn_1", text: CLEAN }] });
  assert.equal(obligation(withoutPresence, "claim_fulfillable").verdict, "unmeasured");
  const withPresence = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text: CLEAN }],
    presence: { turns: [], findings: [{ turnId: "turn_1", finding: "claim_not_visible" }] },
  });
  assert.equal(obligation(withPresence, "claim_fulfillable").verdict, "broken");
});

test("the presence projection's own findings are carried under this rubric's id", () => {
  const rubric = assessCompanionBehaviourRubric({
    turns: [{ turnId: "turn_1", text: "我这就去浇水。" }],
    presence: { turns: [], findings: [{ turnId: "turn_1", finding: "claim_unreceipted" }] },
  });
  assert.ok(
    rubric.findings.some(
      (finding) => finding.obligation === "claim_fulfillable" && finding.detail === "claim_unreceipted",
    ),
  );
});

test("every undecidable obligation is reported unmeasured rather than approximated", () => {
  const rubric = assessCompanionBehaviourRubric({ turns: [{ turnId: "turn_1", text: CLEAN }] });
  const unjudged = COMPANION_BEHAVIOUR_OBLIGATIONS.filter((entry) => entry.class === "Unjudged").map(
    (entry) => entry.id,
  );
  assert.ok(unjudged.length > 0);
  for (const id of unjudged) {
    assert.equal(obligation(rubric, id).verdict, "unmeasured");
    assert.ok(rubric.verdict.unmeasured.includes(id));
  }
});

test("a run with no spoken turn is unmeasured and never vacuously passed", () => {
  const rubric = assessCompanionBehaviourRubric({ turns: [{ turnId: "turn_1", text: "   " }] });
  assert.equal(rubric.spokenTurns, 0);
  assert.equal(rubric.passed, false);
  assert.equal(obligation(rubric, "no_machine_token_leak").verdict, "unmeasured");
  assert.equal(obligation(rubric, "no_machine_token_leak").detail, "no_recorded_turn");
});

test("an utterance result exposes which detector produced which signal", () => {
  const utterance = assessCompanionUtterance("（点头）我先去看看。", { observedEvents: [] });
  assert.deepEqual(utterance.gate.reasons, []);
  assert.deepEqual(utterance.textStageDirection, ["（点头）"]);
  assert.deepEqual(utterance.oocMetaReference, []);
});

test("malformed input fails closed instead of matching nothing", () => {
  assert.throws(() => assessCompanionBehaviourRubric({ turns: "not-an-array" }), CompanionBehaviourRubricError);
  assert.throws(
    () => assessCompanionBehaviourRubric({ turns: [{ turnId: "bad id!", text: "x" }] }),
    CompanionBehaviourRubricError,
  );
  assert.throws(() => assessCompanionBehaviourRubric({ turns: [{ turnId: "turn_1" }] }), CompanionBehaviourRubricError);
  assert.throws(() => assessCompanionBehaviourRubric({ turns: [], presence: [] }), CompanionBehaviourRubricError);
  assert.throws(
    () => assessCompanionBehaviourRubric({ turns: [], presence: { findings: [{}] } }),
    CompanionBehaviourRubricError,
  );
  assert.throws(() => assessCompanionUtterance("x", { observedEvents: "npc_dialogue" }), CompanionBehaviourRubricError);
});

test("performance obligations are decided by the run report, and unmeasured without one", () => {
  const obligation = (rubric, id) => rubric.obligations.find((entry) => entry.id === id);

  // No run report: a performance obligation cannot be decided by reading speech, so it must say so rather than pass.
  const without = assessCompanionBehaviourRubric({ turns: [{ turnId: "t1", text: "我先去东边看看。" }] });
  assert.equal(obligation(without, "observation_continuity").verdict, "unmeasured");
  assert.equal(obligation(without, "trace_snapshot_share").verdict, "unmeasured");
  assert.equal(obligation(without, "trace_duplicate_payload_bounded").verdict, "unmeasured");

  // The shape a real audit found: a 600 s session unobserved for its last 216 s, a trace that is 96.7% snapshot bytes,
  // and one identical record repeated until it is 5.8% of the trace.
  const broken = assessCompanionBehaviourRubric({
    turns: [],
    runReport: {
      durationSeconds: 600.351,
      observationCycles: 292,
      observationFailures: 107,
      unobservedTailMs: 216_000,
      traceBytes: { total: 2_430_000, snapshot: 2_350_000, largestRepeatedRecordBytes: 141_000 },
    },
  });
  assert.equal(obligation(broken, "observation_continuity").verdict, "broken");
  assert.match(obligation(broken, "observation_continuity").detail, /unobserved tail 216s of 600s; failures 107\/292/u);
  assert.equal(obligation(broken, "trace_snapshot_share").verdict, "broken");
  assert.match(obligation(broken, "trace_snapshot_share").detail, /96\.7% of 2430000 B/u);
  assert.equal(obligation(broken, "trace_duplicate_payload_bounded").verdict, "broken");
  assert.ok(
    broken.verdict.broken.includes("observation_continuity"),
    "a broken performance obligation must surface in the verdict",
  );

  // A run that observed throughout and kept its trace proportionate is green on all three.
  const healthy = assessCompanionBehaviourRubric({
    turns: [],
    runReport: {
      durationSeconds: 600,
      observationCycles: 292,
      observationFailures: 0,
      unobservedTailMs: 2_000,
      traceBytes: { total: 1_000_000, snapshot: 500_000, largestRepeatedRecordBytes: 1_000 },
    },
  });
  assert.equal(obligation(healthy, "observation_continuity").verdict, "green");
  assert.equal(obligation(healthy, "trace_snapshot_share").verdict, "green");
  assert.equal(obligation(healthy, "trace_duplicate_payload_bounded").verdict, "green");
});
