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

test("natural dialogue with ordering or sequence markers is not failed by decommissioned step_checklist", () => {
  const samples = [
    "我先把院子那两棵浇了，回头再进屋鼓捣。",
    "我先歇会儿，今天天真热，太阳晒得人头晕，等太阳下山了我再去地里。",
    "我先把院子扫了，刚才风吹落了满地的枯叶，弄完我又去喂了鸡。",
    "我先去西边看看，要是那边杂草多的话，回头再叫你一起弄。",
    "先等一下，我把鞋带系好，再去把那棵树给砍了。",
    "我先把水浇了，顺便看了一眼防风草，然后就赶紧跑回来了。",
  ];
  for (const line of samples) {
    const result = assessCompanionInteraction(line, []);
    assert.equal(result.reasons.includes("step_checklist"), false, line);
    assert.equal(result.passed, true, line);
  }
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

test("rejects reading the receipt's wire format out loud to the player", () => {
  // A third live run — after the NPC-reaction hole was closed — told the player
  // “回执显示这算普通送礼（gift_given）…quest_25_completed 还是 false”. It spoke
  // the receipt's machine identifiers. This is a SHAPE, so one pattern covers the
  // class; Chinese prose and ordinary English carry no `_`.
  const leaked =
    "不过有一点要说清楚：回执显示这算普通送礼（gift_given），乔迪信里那单任务并没有因此打勾，quest_25_completed 还是 false。";
  const result = assessCompanionInteraction(leaked, []);
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("machine_token_leak"));
  assert.deepEqual(result.metrics.machineTokens, ["gift_given", "quest_25_completed"]);
  // Constant-style identifiers are the same leak class.
  const constant = assessCompanionInteraction("状态是 GIFT_RECORDED，不是 QUEST_COMPLETED。", []);
  assert.equal(constant.passed, false);
  assert.ok(constant.reasons.includes("machine_token_leak"));
});

test("rejects Magic Context's §N§ prompt self-tag leaking into player speech", () => {
  // The model mimics the `§N§` self-tag Magic Context puts on the prompt (its own
  // instructions tell it to prefix every reply with one). A real Game run presented
  // it verbatim: "§43§ 已经进屋了，被窝那边我去占着。". The marker carries no `_`, so
  // machine_token_leak cannot see it; it needs its own named failure. The persistence
  // path already scrubs the Chat row, so this is the check that a presentation still
  // carrying it is a named failure rather than a silent pass.
  const leaked = "§43§ 已经进屋了，被窝那边我去占着。";
  const result = assessCompanionInteraction(leaked, []);
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("self_tag_leak"));
  assert.equal(result.metrics.selfTag, true);
  // Ordinary prose never carries the marker, so a clean line stays clean.
  const clean = assessCompanionInteraction("（轻声）已经进屋了，被窝那边我去占着。", []);
  assert.equal(clean.passed, true);
  assert.equal(clean.metrics.selfTag, false);
});

test("does not flag a player-directed line that mentions no NPC reaction", () => {
  const line = "（满意）花椰菜收好了，你想现在送去给乔迪，还是先回屋歇会儿？";
  const result = assessCompanionInteraction(line, []);
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
});

test("rejects a body-part reaction claim the receipts never recorded", () => {
  // A later live run narrated "她收下的时候连眼睛都弯了" while the same receipts
  // recorded showed_response=false. The direct-verb list missed it because the
  // reaction was expressed through a body part, not an emotion word.
  const fabricated = "（笑）她收下的时候连眼睛都弯了——45点好感，一颗花椰菜换来的。";
  const result = assessCompanionInteraction(fabricated, []);
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("unobserved_event"));
  assert.equal(result.metrics.claimedNpcReaction, true);
  // And it is acceptable once the game really showed the reaction.
  assert.equal(assessCompanionInteraction(fabricated, ["npc_dialogue"]).passed, true);
});

test("a motionless body-part description is not a reaction claim", () => {
  // Naming a body part without a change verb is description, not a claim that
  // the world reacted, so the hard signal must stay off.
  for (const line of ["她的眼睛很大，头发也是黑的。", "乔迪站在柜台后面，穿着一件蓝外套。"]) {
    const result = assessCompanionInteraction(line, []);
    assert.equal(result.passed, true, line);
    assert.equal(result.metrics.claimedNpcReaction, false, line);
  }
});

test("hypothetical condition with NPC verb is not an unobserved event", () => {
  const line = "她要是答应了，咱们就省事多了。";
  const result = assessCompanionInteraction(line, []);
  assert.equal(result.passed, true, line);
  assert.equal(result.reasons.includes("unobserved_event"), false, line);
});
