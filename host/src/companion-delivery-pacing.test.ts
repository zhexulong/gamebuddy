import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DELIVERY_PACING,
  GAME_DELIVERY_PACING,
  budgetedSpeechPieces,
  selectReactionSound,
  typingDurationMs,
} from "./companion-delivery-pacing.js";

/**
 * The pacing rules exist so a short remark is not made to wait as long as a
 * paragraph, and so a sound before the reply can never read as a claim that work
 * was done. Every case below fails if one of those properties stops holding.
 */

const GAME_TYPING = GAME_DELIVERY_PACING.typing!;

test("a long remark is made to wait longer than a short one", () => {
  const short = typingDurationMs("好", GAME_TYPING);
  const long = typingDurationMs("我把东边那片地翻完了，现在去收花椰菜。", GAME_TYPING);
  assert.ok(long > short * 4, `long=${long} short=${short}`);
});

test("a single character waits more than a two-character word at the same pace", () => {
  const one = typingDurationMs("嗯", GAME_TYPING);
  const two = typingDurationMs("嗯嗯", GAME_TYPING);
  assert.ok(one > two, `one=${one} two=${two}`);
});

test("a Chinese character costs more than a latin one", () => {
  assert.ok(typingDurationMs("好", GAME_TYPING) > typingDurationMs("ab", GAME_TYPING));
});

test("the same text at the same pace always waits the same time", () => {
  const text = "水浇好了。";
  assert.equal(typingDurationMs(text, GAME_TYPING), typingDurationMs(text, GAME_TYPING));
});

test("the game surface gives every mechanism a value; the chat surface switches them all off", () => {
  assert.notEqual(GAME_DELIVERY_PACING.typing, null);
  assert.notEqual(GAME_DELIVERY_PACING.reaction, null);
  assert.notEqual(GAME_DELIVERY_PACING.lengthBudget, null);
  assert.equal(CHAT_DELIVERY_PACING.typing, null);
  assert.equal(CHAT_DELIVERY_PACING.reaction, null);
  assert.equal(CHAT_DELIVERY_PACING.lengthBudget, null);
});

test("a reaction is a sound, never a claim about the world", () => {
  const claims = ["好", "完成", "搞定", "行了", "收到", "done", "ok", "okay", "finished"];
  const reaction = GAME_DELIVERY_PACING.reaction!;
  for (const locale of Object.keys(reaction.byLanguage)) {
    for (let seed = 0; seed < 64; seed += 1) {
      const sound = selectReactionSound(`turn-${seed}`, locale, reaction);
      if (sound === null) continue;
      for (const claim of claims)
        assert.ok(
          !sound.toLowerCase().includes(claim.toLowerCase()),
          `reaction ${JSON.stringify(sound)} in ${locale} contains the claim ${JSON.stringify(claim)}`,
        );
    }
  }
});

test("the same turn picks the same reaction, so a replay is identical", () => {
  const reaction = GAME_DELIVERY_PACING.reaction!;
  assert.equal(selectReactionSound("turn-42", "zh", reaction), selectReactionSound("turn-42", "zh", reaction));
});

test("a language with no vocabulary says nothing rather than inventing one", () => {
  const reaction = GAME_DELIVERY_PACING.reaction!;
  assert.equal(selectReactionSound("turn-1", "xx", reaction), null);
});

test("a piece never exceeds the budget unless a single sentence does", () => {
  const budget = GAME_DELIVERY_PACING.lengthBudget!;
  const normal = budgetedSpeechPieces("第一句在这里。第二句也不长。第三句同样短。", budget);
  assert.ok(normal.length >= 1);
  for (const piece of normal) assert.ok(piece.length <= budget.maxChars, `piece of ${piece.length} chars`);

  const oneLongSentence = `${"很".repeat(200)}。`;
  assert.deepEqual(budgetedSpeechPieces(oneLongSentence, budget), [oneLongSentence]);
});

test("text within the budget is delivered as one piece, unchanged", () => {
  const text = "种子买好了。";
  assert.deepEqual(budgetedSpeechPieces(text, GAME_DELIVERY_PACING.lengthBudget!), [text]);
});
