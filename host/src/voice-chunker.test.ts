import assert from "node:assert/strict";
import test from "node:test";

import fc from "./test-support/fast-check.js";
import { createSentenceChunker } from "./voice-chunker.js";

test("voice-chunker: fast first-chunk emission on short clause punctuation", () => {
  const chunks: string[] = [];
  const chunker = createSentenceChunker((c) => chunks.push(c), { minFirstChunkLength: 3 });

  // Stream token by token
  chunker.push("好的");
  assert.equal(chunks.length, 0);

  chunker.push("，我们");
  assert.deepEqual(chunks, ["好的，"]);

  chunker.push("现在就去");
  assert.deepEqual(chunks, ["好的，"]);

  chunker.push("矿洞！好的");
  assert.deepEqual(chunks, ["好的，", "我们现在就去矿洞！"]);

  chunker.flush();
  assert.deepEqual(chunks, ["好的，", "我们现在就去矿洞！", "好的"]);
});

test("voice-chunker: continuous punctuation atomic aggregation", () => {
  const chunks: string[] = [];
  const chunker = createSentenceChunker((c) => chunks.push(c));

  chunker.push("等等");
  chunker.push("……");
  chunker.push("……");
  chunker.push("这是");
  assert.deepEqual(chunks, ["等等…………"]);

  chunker.push("真的");
  chunker.push("吗");
  chunker.push("？？？");
  chunker.push("走吧");
  assert.deepEqual(chunks, ["等等…………", "这是真的吗？？？"]);

  chunker.flush();
  assert.deepEqual(chunks, ["等等…………", "这是真的吗？？？", "走吧"]);
});

test("voice-chunker: ASCII continuous punctuation and quotes aggregation", () => {
  const chunks: string[] = [];
  const chunker = createSentenceChunker((c) => chunks.push(c));

  chunker.push("Wait");
  chunker.push("...");
  chunker.push(" what");
  assert.deepEqual(chunks, ["Wait..."]);

  chunker.push(" happened");
  chunker.push("?!");
  chunker.push(" Let's");
  assert.deepEqual(chunks, ["Wait...", " what happened?!"]);

  chunker.push(" go.");
  chunker.flush();
  assert.deepEqual(chunks, ["Wait...", " what happened?!", " Let's go."]);
});

test("voice-chunker: maxChunkLength fallback cuts long uninterrupted text without losing chars", () => {
  const chunks: string[] = [];
  const chunker = createSentenceChunker((c) => chunks.push(c), { maxChunkLength: 20 });

  const longText = "这是一段非常非常非常非常非常非常长的没有标点的句子";
  chunker.push(longText);
  chunker.flush();

  assert.equal(chunks.join(""), longText);
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0);
    assert.ok(chunk.length <= 25);
  }
});

test("voice-chunker: newline immediately triggers chunk break", () => {
  const chunks: string[] = [];
  const chunker = createSentenceChunker((c) => chunks.push(c));

  chunker.push("第一行\n第二行\n第三行");
  chunker.flush();

  assert.deepEqual(chunks, ["第一行\n", "第二行\n", "第三行"]);
  assert.equal(chunks.join(""), "第一行\n第二行\n第三行");
});

test("voice-chunker: reset clears internal buffer without emitting", () => {
  const chunks: string[] = [];
  const chunker = createSentenceChunker((c) => chunks.push(c));

  chunker.push("未完成的句子");
  assert.equal(chunker.buffered, "未完成的句子");
  chunker.reset();
  assert.equal(chunker.buffered, "");
  assert.equal(chunks.length, 0);

  chunker.push("新句子。下一句");
  assert.deepEqual(chunks, ["新句子。"]);
  chunker.flush();
  assert.deepEqual(chunks, ["新句子。", "下一句"]);
});

test("voice-chunker: PBT - string invariant under arbitrary single-character streaming", () => {
  fc.assert(
    fc.property(fc.fullUnicodeString({ minLength: 0, maxLength: 200 }), (text) => {
      const chunks: string[] = [];
      const chunker = createSentenceChunker((c) => chunks.push(c));

      // Push 1 character at a time
      for (const char of text) {
        chunker.push(char);
      }
      chunker.flush();

      // Invariant 1: Concatenation matches original text exactly
      assert.equal(chunks.join(""), text);

      // Invariant 2: No empty chunks
      for (const chunk of chunks) {
        assert.ok(chunk.length > 0, "Chunk must not be empty");
      }
    }),
    { numRuns: 100 },
  );
});

test("voice-chunker: PBT - string invariant under random token chunking", () => {
  fc.assert(
    fc.property(
      fc.fullUnicodeString({ minLength: 1, maxLength: 200 }),
      fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 30 }),
      (text, splitSizes) => {
        const chunks: string[] = [];
        const chunker = createSentenceChunker((c) => chunks.push(c));

        // Slice text into random token deltas
        let offset = 0;
        let splitIdx = 0;
        while (offset < text.length) {
          const size = splitSizes[splitIdx % splitSizes.length]!;
          splitIdx++;
          const delta = text.slice(offset, offset + size);
          offset += size;
          chunker.push(delta);
        }
        chunker.flush();

        // Invariant 1: Concatenation matches original text exactly
        assert.equal(chunks.join(""), text);

        // Invariant 2: No empty chunks
        for (const chunk of chunks) {
          assert.ok(chunk.length > 0, "Chunk must not be empty");
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("voice-chunker: PBT - multiline and dialogue text preservation", () => {
  fc.assert(
    fc.property(fc.multilineString({ minLength: 1, maxLength: 150 }), (text) => {
      const chunks: string[] = [];
      const chunker = createSentenceChunker((c) => chunks.push(c), { maxChunkLength: 35 });

      chunker.push(text);
      chunker.flush();

      assert.equal(chunks.join(""), text);
      for (const chunk of chunks) {
        assert.ok(chunk.length > 0);
      }
    }),
    { numRuns: 100 },
  );
});
