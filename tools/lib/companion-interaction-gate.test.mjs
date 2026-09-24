import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCompanionInteraction } from "./companion-interaction-gate.mjs";

test("accepts a short spoken line that addresses the player", () => {
  const result = assessCompanionInteraction("（轻声）种好啦，接下来就看它慢慢长大了——你想不想等它几天？");
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.metrics.hasPlayerAddress, true);
});

test("accepts a short emotion-first exclamation without addressing the player", () => {
  const result = assessCompanionInteraction("（有点得意）都弄妥当啦！");
  assert.equal(result.passed, true);
  assert.equal(result.metrics.hasPlayerAddress, false);
});

test("rejects a step-by-step recital", () => {
  const result = assessCompanionInteraction("（轻声）我在屋外找了块空地，先翻松泥土，把一颗花椰菜种子种进土里，又拎着浇水壶给它浇了水，现在等它慢慢长大。");
  assert.equal(result.passed, false);
  assert.deepEqual(result.reasons, ["step_checklist"]);
});

test("rejects a long broadcast-style summary even without a checklist", () => {
  const result = assessCompanionInteraction(
    "（轻声）今天早上我一直待在农场里，太阳晒得背上暖洋洋的，泥土的味道也很好闻。种子应该很快就能发芽，到时候我们一起去看，顺便也可以摘点别的菜回来。你觉得这样安排可以吗？我觉得这样安排真的挺好的，你觉得呢？我们还可以顺便看看那边的小溪，听说春天里有鱼游过来，你喜欢钓鱼吗？",
  );
  assert.equal(result.passed, false);
  assert.deepEqual(result.reasons, ["summary_too_long"]);
});

test("rejects the exact recital pattern observed in the live run", () => {
  const observed = "都弄妥当啦——我在屋外找了块向阳的空地，先翻松泥土，把一颗花椰菜种子种进土里，又拎着浇水壶给它浇了水；现在乔迪的花椰菜就安安稳稳躺在湿润的土里等着慢慢长大，等它成熟我第一时间摘下来给她送去。";
  const result = assessCompanionInteraction(observed);
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("step_checklist"));
});

test("rejects empty text", () => {
  const result = assessCompanionInteraction("   ");
  assert.equal(result.passed, false);
  assert.deepEqual(result.reasons, ["empty"]);
});
test("rejects narrating an NPC reaction the receipts never recorded", () => {
  // The live trace's summary claimed "Jodi beamed and said dinner was saved"
  // while the offer receipt recorded showed_response=false: no dialogue happened.
  // Inventing a world reaction is a worse interaction failure than being long.
  const fabricated = "（开心）搞定了！花椰菜交到乔迪手里了，她一看到就乐了，还念叨着晚饭有救了。接下来想干嘛？";
  const withoutEvidence = assessCompanionInteraction(fabricated, []);
  assert.equal(withoutEvidence.passed, false);
  assert.ok(withoutEvidence.reasons.includes("unobserved_event"));
  // The same line is acceptable once the game actually showed the reaction.
  const withEvidence = assessCompanionInteraction(fabricated, ["npc_dialogue"]);
  assert.equal(withEvidence.passed, true);
});

test("does not flag a player-directed line that mentions no NPC reaction", () => {
  const line = "（满意）花椰菜收好了，你想现在送去给乔迪，还是先回屋歇会儿？";
  const result = assessCompanionInteraction(line, []);
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
});
