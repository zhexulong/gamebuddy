import { strict as assert } from "node:assert";
import test from "node:test";

import {
  ACCUMULATOR_MS,
  MAX_CHUNK_LENGTH,
  StreamingSentenceChunker,
} from "./streaming-chunker.js";

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