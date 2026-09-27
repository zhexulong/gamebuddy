import assert from "node:assert/strict";
import test from "node:test";

import { chunkCompanionSpeech } from "./companion-speech-chunker.js";

test("chunks a multi-sentence paragraph into at most two-sentence chunks in order", () => {
  assert.deepEqual(
    chunkCompanionSpeech("早安!今天天气真好。我们一起去种地吧。还记得浇水吗?"),
    ["早安!今天天气真好。", "我们一起去种地吧。还记得浇水吗?"],
  );
});

test("keeps a single long sentence without a boundary as one chunk", () => {
  const longSentence = "这条消息特别长" + "非常长".repeat(200) + "但是始终没有任何标点边界所以只能整句输出。";
  assert.deepEqual(chunkCompanionSpeech(longSentence), [longSentence]);
});

test("quote balance prevents a mid-unit split and keeps a quoted sentence whole", () => {
  // 三个开口引号都没有闭合 → 整段保持为一个 chunk。
  assert.deepEqual(
    chunkCompanionSpeech("他说:\u201C好的,我去。\u201C继续。\u201C"),
    ["他说:\u201C好的,我去。\u201C继续。\u201C"],
  );
  // 一个完整闭合的 "好的。" 保持整体。
  assert.deepEqual(chunkCompanionSpeech("\u201C好的。\u201D"), ["\u201C好的。\u201D"]);
  assert.deepEqual(chunkCompanionSpeech('"好的。"'), ['"好的。"']);
  // 引号内多个句子合并为一段,外层闭合后正常收尾。
  assert.deepEqual(chunkCompanionSpeech("他说:\u201C第一句。第二句。第三句。\u201D"), [
    "他说:\u201C第一句。第二句。第三句。\u201D",
  ]);
});

test("bracket balance prevents a mid-split while intact brackets still split cleanly", () => {
  assert.deepEqual(chunkCompanionSpeech("我们(大概五十。六十。还在涨。"), ["我们(大概五十。六十。还在涨。"]);
  assert.deepEqual(chunkCompanionSpeech("(轻声)记得浇水。(停顿)明天见。"), ["(轻声)记得浇水。(停顿)明天见。"]);
  assert.deepEqual(chunkCompanionSpeech("(好的。)走了。", 1), ["(好的。)", "走了。"]);
});

test("treats empty and whitespace-only input as no chunks", () => {
  assert.deepEqual(chunkCompanionSpeech(""), []);
  assert.deepEqual(chunkCompanionSpeech("   "), []);
  assert.deepEqual(chunkCompanionSpeech("\n\t  \r\n"), []);
});

test("treats newlines as hard markers for sentence units", () => {
  assert.deepEqual(chunkCompanionSpeech("早上好。\n今天想去哪?"), ["早上好。", "今天想去哪?"]);
  assert.deepEqual(chunkCompanionSpeech("第一句\n第二句"), ["第一句", "第二句"]);
  assert.deepEqual(chunkCompanionSpeech("a。\r\nb。"), ["a。", "b。"]);
});

test("groups exactly the allowed number of sentences per chunk", () => {
  assert.deepEqual(chunkCompanionSpeech("甲。乙。"), ["甲。乙。"]);
  assert.deepEqual(chunkCompanionSpeech("甲。乙。丙。"), ["甲。乙。", "丙。"]);
  assert.deepEqual(chunkCompanionSpeech("甲。乙。丙。", 1), ["甲。", "乙。", "丙。"]);
  assert.deepEqual(chunkCompanionSpeech("甲。乙。丙。", 3), ["甲。乙。丙。"]);
});

test("collapses internal whitespace but preserves a single separator gap", () => {
  assert.deepEqual(chunkCompanionSpeech("跑  步去  了。\u3000好好休息。"), ["跑 步去 了。 好好休息。"]);
  assert.deepEqual(chunkCompanionSpeech("无空格的句子。第二句。"), ["无空格的句子。第二句。"]);
});

test("never splits mid-sentence to satisfy the budget and is deterministic", () => {
  const text = "这一整句没有任何边界完全打不断。\n短句。";
  assert.deepEqual(chunkCompanionSpeech(text), ["这一整句没有任何边界完全打不断。", "短句。"]);
  for (const sample of [text, "早安!今天天气真好。我们一起去种地吧。", "他说:\u201C好的,我去。\u201C继续。\u201C", ""]) {
    assert.deepEqual(chunkCompanionSpeech(sample), chunkCompanionSpeech(sample));
  }
});

test("does not treat half-width periods or arbitrary punctuation as boundaries", () => {
  assert.deepEqual(chunkCompanionSpeech("3.14 和 42.5 哪个更大?"), ["3.14 和 42.5 哪个更大?"]);
  assert.deepEqual(chunkCompanionSpeech("好的,我来了。"), ["好的,我来了。"]);
});