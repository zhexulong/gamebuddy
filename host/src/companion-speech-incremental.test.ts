import { describe, it, expect } from "bun:test";

import { IncrementalSpeechAccumulator } from "./companion-speech-incremental.js";

describe("IncrementalSpeechAccumulator", () => {
  it("emits a completed sentence as soon as its boundary arrives", () => {
    const accumulator = new IncrementalSpeechAccumulator();
    expect(accumulator.push("早")).toEqual([]);
    expect(accumulator.push("安!")).toEqual(["早安!"]);
    expect(accumulator.push("今天")).toEqual([]);
    expect(accumulator.push("下雨。")).toEqual(["今天下雨。"]);
    expect(accumulator.bufferedLength).toBe(0);
  });

  it("keeps an incomplete trailing sentence buffered until flush", () => {
    const accumulator = new IncrementalSpeechAccumulator();
    expect(accumulator.push("明天")).toEqual([]);
    expect(accumulator.push("见")).toEqual([]);
    expect(accumulator.bufferedLength).toBe(3);
    expect(accumulator.flush()).toBe("明天见");
    expect(accumulator.bufferedLength).toBe(0);
  });

  it("does not close a sentence inside an open thinking block", () => {
    const accumulator = new IncrementalSpeechAccumulator();
    expect(accumulator.push("<thinking>")).toEqual([]);
    expect(accumulator.push("这是一段")).toEqual([]);
    expect(accumulator.push("推理。")).toEqual([]);
    expect(accumulator.push("没有边界。")).toEqual([]);
    // The accumulator only cuts at sentence boundaries; it never strips the
    // scaffold block (dehydration does). So the whole thinking+speech unit
    // is buffered until the closer lands, then emitted whole; the presenter's
    // dehydration turns it into "早安!".
    expect(accumulator.push("</thinking>早安!")).toEqual(["<thinking>这是一段推理。没有边界。</thinking>早安!"]);
    expect(accumulator.bufferedLength).toBe(0);
  });

  it("does not close a sentence inside an open asterisk stage-beat", () => {
    const accumulator = new IncrementalSpeechAccumulator();
    expect(accumulator.push("*转身")).toEqual([]);
    expect(accumulator.push("微笑。")).toEqual([]);
    expect(accumulator.push("继续。")).toEqual([]);
    expect(accumulator.push("*早安!")).toEqual(["*转身微笑。继续。*早安!"] as unknown as string[]);
  });

  it("treats doubled asterisks (markdown emphasis) as closed", () => {
    const accumulator = new IncrementalSpeechAccumulator();
    expect(accumulator.push("**重点**")).toEqual([]);
    expect(accumulator.push("好。")).toEqual(["**重点**好。"]);
  });

  it("emits multiple sentences from one chunk in order", () => {
    const accumulator = new IncrementalSpeechAccumulator();
    expect(accumulator.push("我这就去浇水。把杂草拔了。然后")).toEqual([
      "我这就去浇水。",
      "把杂草拔了。",
    ]);
    expect(accumulator.flush()).toBe("然后");
  });

  it("does not close a sentence inside a quote until the quote closes", () => {
    const accumulator = new IncrementalSpeechAccumulator();
    // The `。` inside the quote must not close the unit; only the final `。`
    // after the closing quote does.
    expect(accumulator.push('他说:"好的。"继续。')).toEqual(['他说:"好的。"继续。']);
  });

  it("emits an over-limit single sentence whole rather than deferring or re-cutting", () => {
    const accumulator = new IncrementalSpeechAccumulator(8);
    // The sentence has no inner boundary, so the moment its `。` lands it is
    // complete; being over the budget does not hold it back or cut it.
    expect(accumulator.push("这是一个超出了限制的长句子。")).toEqual(["这是一个超出了限制的长句子。"]);
    expect(accumulator.bufferedLength).toBe(0);
  });

  it("ignores empty chunks", () => {
    const accumulator = new IncrementalSpeechAccumulator();
    expect(accumulator.push("")).toEqual([]);
    expect(accumulator.bufferedLength).toBe(0);
  });
});