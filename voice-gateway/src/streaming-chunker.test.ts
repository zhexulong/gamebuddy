import { strict as assert } from "node:assert";
import test from "node:test";

import { ACCUMULATOR_MS, MAX_CHUNK_LENGTH, MAX_TAG_LENGTH, StreamingSentenceChunker } from "./streaming-chunker.js";

function collect(chunker: StreamingSentenceChunker, deltas: readonly Readonly<{ text: string; atMs: number }>[]) {
  const out: Array<Readonly<{ text: string; complete: boolean }>> = [];
  for (const delta of deltas) out.push(...chunker.push(delta.text, delta.atMs));
  return out;
}

test("StreamingSentenceChunker emits complete sentences immediately on punctuation", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  const chunks = collect(chunker, [
    { text: "早上好，伙伴。", atMs: 0 },
    { text: "今天天气不错。", atMs: 1 },
  ]);
  assert.deepEqual(chunks, [
    { text: "早上好，伙伴。", complete: true },
    { text: "今天天气不错。", complete: true },
  ]);
  assert.equal(chunker.bufferedLength, 0);
});

test("StreamingSentenceChunker keeps an unterminated tail until the accumulator threshold", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  assert.deepEqual(collect(chunker, [{ text: "这是一句很长还没有结束的", atMs: 0 }]), []);
  assert.equal(chunker.bufferedLength > 0, true);
  const chunks = collect(chunker, [{ text: "内容在被念出来。", atMs: ACCUMULATOR_MS - 1 }]);
  assert.deepEqual(chunks, [{ text: "这是一句很长还没有结束的内容在被念出来。", complete: true }]);
});

test("StreamingSentenceChunker emits a partial chunk at the accumulator threshold (anti-swallow)", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  const chunks = collect(chunker, [
    { text: "没有标点的一句话被", atMs: 0 },
    { text: "蓄水池推进", atMs: ACCUMULATOR_MS },
  ]);
  assert.deepEqual(chunks, [{ text: "没有标点的一句话被蓄水池推进", complete: false }]);
  assert.equal(chunker.bufferedLength, 0);
});

test("StreamingSentenceChunker hard-cuts an unterminated sentence over the length cap", () => {
  const chunker = new StreamingSentenceChunker("en-US");
  const long = "word ".repeat(100); // ~500 chars, no terminator
  const chunks = collect(chunker, [{ text: long, atMs: 0 }]);
  assert.equal(chunks.length >= 2, true);
  for (const chunk of chunks) {
    assert.equal(chunk.text.length <= MAX_CHUNK_LENGTH + 1, true);
    assert.equal(chunk.complete, false);
  }
  // The residual tail (< cap) stays buffered for the next delta or flush;
  // it is never discarded, so playback cannot swallow it.
  assert.equal(chunker.bufferedLength > 0, true);
  assert.equal(chunker.bufferedLength <= MAX_CHUNK_LENGTH, true);
  assert.deepEqual(chunker.flush(), [{ text: "word ".repeat(20).trim(), complete: false }]);
});

test("StreamingSentenceChunker skips symbol noise and fenced code blocks", () => {
  const chunker = new StreamingSentenceChunker("en-US");
  const chunks = collect(chunker, [
    { text: "```\nconst x = 1;\n```\n", atMs: 0 },
    { text: "---\n***\n...\n", atMs: 1 },
    { text: "Hello, world.", atMs: 2 },
  ]);
  assert.deepEqual(chunks, [{ text: "Hello, world.", complete: true }]);
});

test("StreamingSentenceChunker flush returns the pending tail exactly once", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  assert.deepEqual(collect(chunker, [{ text: "还没有说完", atMs: 0 }]), []);
  assert.deepEqual(chunker.flush(), [{ text: "还没有说完", complete: false }]);
  assert.deepEqual(chunker.flush(), []);
});

test("StreamingSentenceChunker reset discards the buffer without emitting", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  collect(chunker, [{ text: "将被丢弃", atMs: 0 }]);
  chunker.reset();
  assert.equal(chunker.bufferedLength, 0);
  assert.deepEqual(chunker.flush(), []);
});

test("StreamingSentenceChunker groups newline-terminated sentences and keeps quotes attached", () => {
  const chunker = new StreamingSentenceChunker("en-US");
  const chunks = collect(chunker, [{ text: "Line one.\nLine two!\n", atMs: 0 }]);
  assert.deepEqual(chunks, [
    { text: "Line one.", complete: true },
    { text: "Line two!", complete: true },
  ]);
});

test("StreamingSentenceChunker strips character-card action beats but keeps dialogue", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  // *...* action beats are stage direction: dropped, dialogue survives.
  const chunks = collect(chunker, [
    { text: "*从屏幕边探出脑袋，尾巴轻轻晃了晃* 唔…今天帮你整理了文件。", atMs: 0 },
  ]);
  assert.deepEqual(chunks, [{ text: "唔…今天帮你整理了文件。", complete: true }]);
});

test("StreamingSentenceChunker keeps **emphasis** but not *beats* across deltas", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  // A beat can split across deltas; emphasis survives as spoken content.
  const chunks = collect(chunker, [
    { text: "*从屏", atMs: 0 },
    { text: "幕边探出脑袋，尾巴轻轻晃了晃* **很重要** 哦！", atMs: 1 },
    { text: " 要听吗？", atMs: 2 },
  ]);
  assert.deepEqual(chunks, [
    { text: "很重要 哦！", complete: true },
    { text: "要听吗？", complete: true },
  ]);
});

test("StreamingSentenceChunker drops a pure action-beat utterance entirely", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  const chunks = collect(chunker, [
    { text: "*安静地喝了一口茶*", atMs: 0 },
  ]);
  assert.deepEqual(chunks, []);
  assert.deepEqual(chunker.flush(), []);
});

test("StreamingSentenceChunker strips parenthesised action beats but keeps short MiMo tags", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  const chunks = collect(chunker, [
    { text: "（翻出记事本，笔尖轻点）歌词啊……让我想想。", atMs: 0 },
  ]);
  assert.deepEqual(chunks, [{ text: "歌词啊……让我想想。", complete: true }]);
  // Short emotion tags survive for the TTS.
  const tagChunker = new StreamingSentenceChunker("zh-CN");
  const tagChunks = collect(tagChunker, [
    { text: "（轻声）悄悄告诉你，今天风很舒服。", atMs: 0 },
  ]);
  assert.deepEqual(tagChunks, [{ text: "（轻声）悄悄告诉你，今天风很舒服。", complete: true }]);
});

test("StreamingSentenceChunker handles a parenthesised beat split across deltas", () => {
  const chunker = new StreamingSentenceChunker("zh-CN");
  const chunks = collect(chunker, [
    { text: "（翻出记事本，笔尖轻", atMs: 0 },
    { text: "点）好的，这就来。", atMs: 1 },
  ]);
  assert.deepEqual(chunks, [{ text: "好的，这就来。", complete: true }]);
});