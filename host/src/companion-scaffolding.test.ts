import assert from "node:assert/strict";
import test from "node:test";

import { REASONING_FRAMES, removeModelScaffolding } from "./companion-scaffolding.js";

/** One form, the text that carries it, and what the durable Chat row must hold. */
type ScaffoldingCase = readonly [name: string, input: string, stored: string];

/**
 * The scaffolding side of the rule, form by form. Each form is named with the
 * reason it is scaffolding rather than performance, so a form removed without a
 * reason here - or a form that stops being removed - is visible.
 */
const SCAFFOLDING: readonly ScaffoldingCase[] = [
  ["a reasoning block on its own line", "<thinking>玩家刚醒，先接一句话。</thinking>\n\n早安。", "早安。"],
  ["a reasoning block around the whole reply", "<thinking>玩家刚醒。</thinking>", ""],
  ["a reasoning block mid-sentence", "早安。<thinking>玩家刚醒。</thinking>今天有雨。", "早安。今天有雨。"],
  ["a multi-line reasoning block", "<thinking>\n玩家刚醒。\n先接一句话。\n</thinking>\n\n早安。", "早安。"],
  ["the <thought> spelling", "<thought>玩家刚醒。</thought>早安。", "早安。"],
  ["a full-width thought frame", "（思考：她还没吃早饭。）早安。", "早安。"],
  ["a full-width inner-monologue frame", "【内心：别催她。】早安。", "早安。"],
  ["a reasoning frame in DeepSeek's own spelling", "<think> 她刚醒，先接一句。 </think>早安。", "早安。"],
  ["the shorter tag does not swallow the longer one", "<thinking>a</thinking>早", "早"],
  ["a reasoning frame the model never closed runs to the end of the message", "早安。<think>还没想完", "早安。"],
  ["a truncated reply that is nothing but an unclosed frame", "<thinking>玩家刚醒，先接一句", ""],
  ["an unclosed full-width frame", "早安。（思考：她还没吃早饭", "早安。"],
  ["a full-width inner-monologue paren frame", "（脑内：别催她。）早安。", "早安。"],
  ["markdown emphasis, keeping its words", "**今日提醒**：锅里有汤。", "今日提醒：锅里有汤。"],
  ["a divider rule on its own line", "早安。\n\n---\n\n晚上好。", "早安。\n\n\n\n晚上好。"],
  ["a divider rule with trailing spaces", "早安。\n---   \n晚上好。", "早安。\n\n晚上好。"],
];

/**
 * The kept side: every form the rule deliberately leaves alone, byte for byte.
 * These are the "never silently drop ordinary prose" cases, and every `*...*`
 * beat is one of them.
 */
const KEPT: readonly ScaffoldingCase[] = [
  ["an action beat on its own line", "*正蹲在田埂边抠一块碎石。*\n\n“早。”", "same"],
  [
    "a beat at the row's start, directly after a removed block",
    "<thinking>玩家刚醒。</thinking>\n\n*她抬起头。*",
    "*她抬起头。*",
  ],
  ["a beat spanning two lines", "*她先是蹲着，\n然后站了起来。*\n\n“早。”", "same"],
  ["a MiMo audio tag in full-width parens", "（轻声）早安。", "same"],
  ["a MiMo audio tag in square brackets", "[pause] 早安。", "same"],
  ["an ordinary parenthetical aside", "早安。（她还没吃早饭）", "same"],
  ["the ASCII spelling of a thought, which is ordinary English", "(thinking aloud) 早安。", "same"],
  ["the ASCII bracket spelling of a thought", "[thinking] 早安。", "same"],
  ["bold italic, which unwrapping would turn into a beat", "***强调*** 早安。", "same"],
  ["a markdown heading", "# 今日提醒\n早安。", "same"],
  ["a closing tag with no frame it could close", "嗯</thinking>早安。", "same"],
  ["a divider that is not alone on its line", "早安---晚上好。", "same"],
  ["plain prose with no scaffolding at all", "早安。今天天气不错，锅里有汤。", "same"],
  ["the ordinary punctuation a removed beat leaves behind", "“嗯？醒啦。”\n\n“锅里有汤。”", "same"],
];

test("every model-scaffolding form is removed, and only the form", () => {
  for (const [name, input, expected] of SCAFFOLDING) assert.equal(removeModelScaffolding(input), expected, name);
});

test("no beat and no ordinary form is touched", () => {
  for (const [name, input, expected] of KEPT)
    assert.equal(removeModelScaffolding(input), expected === "same" ? input : expected, name);
});

test("a frame the message never closed is dropped to the end, in every family", () => {
  // The population is the rule's own declaration: a family added there is covered
  // here without this test being touched, and one whose unclosed form survives the
  // durable row fails by name.
  for (const frame of REASONING_FRAMES) {
    assert.equal(removeModelScaffolding(`早安。${frame.opening}还没想完`), "早安。", frame.opening);
  }
});

test("removing scaffolding never drops the words around it", () => {
  const input = "<thinking>玩家刚醒。</thinking>早安。<thinking>先接一句。</thinking>今天有雨。";
  assert.equal(removeModelScaffolding(input), "早安。今天有雨。");
});
