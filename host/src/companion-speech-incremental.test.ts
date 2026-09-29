import assert from "node:assert/strict";
import test from "node:test";

import { IncrementalSpeechAccumulator } from "./companion-speech-incremental.js";

// This file is run by the Host suite's Node coordinator (host/scripts/run-tests.mjs
// spawns process.execPath), so it must use node:test like the other Host tests.
// It previously used bun:test and therefore always failed the compiled suite.

test("emits a completed sentence as soon as its boundary arrives", () => {
  const accumulator = new IncrementalSpeechAccumulator();
  assert.deepEqual(accumulator.push("早"), []);
  assert.deepEqual(accumulator.push("安!"), ["早安!"]);
  assert.deepEqual(accumulator.push("今天"), []);
  assert.deepEqual(accumulator.push("下雨。"), ["今天下雨。"]);
  assert.equal(accumulator.bufferedLength, 0);
});

test("keeps an incomplete trailing sentence buffered until flush", () => {
  const accumulator = new IncrementalSpeechAccumulator();
  assert.deepEqual(accumulator.push("明天"), []);
  assert.deepEqual(accumulator.push("见"), []);
  assert.equal(accumulator.bufferedLength, 3);
  assert.equal(accumulator.flush(), "明天见");
  assert.equal(accumulator.bufferedLength, 0);
});

test("does not close a sentence inside an open thinking block", () => {
  const accumulator = new IncrementalSpeechAccumulator();
  assert.deepEqual(accumulator.push("<thinking>"), []);
  assert.deepEqual(accumulator.push("这是一段"), []);
  assert.deepEqual(accumulator.push("推理。"), []);
  assert.deepEqual(accumulator.push("没有边界。"), []);
  // The accumulator only cuts at sentence boundaries; it never strips the
  // scaffold block (dehydration does). So the whole thinking+speech unit
  // is buffered until the closer lands, then emitted whole; the presenter's
  // dehydration turns it into "早安!".
  assert.deepEqual(accumulator.push("</thinking>早安!"), ["<thinking>这是一段推理。没有边界。</thinking>早安!"]);
  assert.equal(accumulator.bufferedLength, 0);
});

test("does not close a sentence inside an open asterisk stage-beat", () => {
  const accumulator = new IncrementalSpeechAccumulator();
  assert.deepEqual(accumulator.push("*转身"), []);
  assert.deepEqual(accumulator.push("微笑。"), []);
  assert.deepEqual(accumulator.push("继续。"), []);
  assert.deepEqual(accumulator.push("*早安!"), ["*转身微笑。继续。*早安!"] as unknown as string[]);
});

test("treats doubled asterisks (markdown emphasis) as closed", () => {
  const accumulator = new IncrementalSpeechAccumulator();
  assert.deepEqual(accumulator.push("**重点**"), []);
  assert.deepEqual(accumulator.push("好。"), ["**重点**好。"]);
});

test("emits multiple sentences from one chunk in order", () => {
  const accumulator = new IncrementalSpeechAccumulator();
  assert.deepEqual(accumulator.push("我这就去浇水。把杂草拔了。然后"), [
    "我这就去浇水。",
    "把杂草拔了。",
  ]);
  assert.equal(accumulator.flush(), "然后");
});

test("does not close a sentence inside a quote until the quote closes", () => {
  const accumulator = new IncrementalSpeechAccumulator();
  // The `。` inside the quote must not close the unit; only the final `。`
  // after the closing quote does.
  assert.deepEqual(accumulator.push('他说:"好的。"继续。'), ['他说:"好的。"继续。']);
});

test("emits an over-limit single sentence whole rather than deferring or re-cutting", () => {
  const accumulator = new IncrementalSpeechAccumulator(8);
  // The sentence has no inner boundary, so the moment its `。` lands it is
  // complete; being over the budget does not hold it back or cut it.
  assert.deepEqual(accumulator.push("这是一个超出了限制的长句子。"), ["这是一个超出了限制的长句子。"]);
  assert.equal(accumulator.bufferedLength, 0);
});

test("ignores empty chunks", () => {
  const accumulator = new IncrementalSpeechAccumulator();
  assert.deepEqual(accumulator.push(""), []);
  assert.equal(accumulator.bufferedLength, 0);
});