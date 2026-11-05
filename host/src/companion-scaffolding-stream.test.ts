import assert from "node:assert/strict";
import test from "node:test";

import {
  createScaffoldingStreamProjection,
  REASONING_FRAMES,
  removeModelScaffolding,
} from "./companion-scaffolding.js";

const PROSE_BEFORE = "早安。";
const PROSE_AFTER = "今天有雨。";
const REASONING = "玩家刚醒先别催";

/** The reasoning text sliced into every 3-character window, so a chunk cannot hide it by splitting. */
const REASONING_SNIPPETS = Array.from({ length: REASONING.length - 2 }, (_unused, at) => REASONING.slice(at, at + 3));

/** Every way a fragment boundary can fall inside one input: whole, per character, and each single split. */
function chunkings(input: string): readonly (readonly string[])[] {
  return [
    [input],
    [...input],
    ...Array.from({ length: input.length - 1 }, (_unused, split) => [
      input.slice(0, split + 1),
      input.slice(split + 1),
    ]),
  ];
}

/** Pushes every chunk through one projection and returns what it released, tail included. */
function released(chunks: readonly string[]): readonly string[] {
  const projection = createScaffoldingStreamProjection();
  const pieces = chunks.map((chunk) => projection.push(chunk));
  const tail = projection.flush();
  return tail.length === 0 ? pieces : [...pieces, tail];
}

test("no reasoning frame reaches the stream, at any fragment boundary", () => {
  // The population is the rule's own declaration, so a frame added there is
  // covered here without this table being touched. Both halves matter: the frame
  // must vanish (the durable row drops it too) and the prose around it must
  // survive in order.
  for (const frame of REASONING_FRAMES) {
    for (const closing of frame.closings) {
      const input = `${PROSE_BEFORE}${frame.opening}：${REASONING}${closing}${PROSE_AFTER}`;
      for (const chunks of chunkings(input)) {
        const pieces = released(chunks);
        const name = `${frame.opening} closed by ${closing}, chunks ${JSON.stringify(chunks)}`;
        assert.equal(pieces.join(""), removeModelScaffolding(input), name);
        assert.equal(pieces.join(""), `${PROSE_BEFORE}${PROSE_AFTER}`, name);
        for (const piece of pieces) {
          assert.equal(piece.includes(frame.opening), false, name);
          for (const snippet of REASONING_SNIPPETS) assert.equal(piece.includes(snippet), false, name);
        }
      }
    }
  }
});

test("a frame the message never closes is dropped by the stream and by the durable row", () => {
  const unterminated = createScaffoldingStreamProjection();
  assert.equal(unterminated.push("<thinking>玩家刚醒"), "");
  // Both halves of the rule read the same declaration, so both drop what the frame
  // never closed: the stream saw the frame open, and the whole message can identify
  // it just as well. A durable row that kept the reasoning text would print it after
  // the bubble withheld it.
  assert.equal(unterminated.flush(), "");
  assert.equal(removeModelScaffolding("<thinking>玩家刚醒"), "");

  const partial = createScaffoldingStreamProjection();
  assert.equal(partial.push("早安<"), "早安");
  assert.equal(partial.flush(), "<");
});

test("an unclosed frame releases the same text on both halves, at every fragment boundary", () => {
  for (const frame of REASONING_FRAMES) {
    const input = `${PROSE_BEFORE}${frame.opening}：${REASONING}`;
    const whole = removeModelScaffolding(input);
    assert.equal(whole, PROSE_BEFORE, frame.opening);
    for (const chunks of chunkings(input)) {
      assert.equal(released(chunks).join(""), whole, `${frame.opening}, chunks ${JSON.stringify(chunks)}`);
    }
  }
});

test("a bracket the frame rule does not name is released as prose, in order", () => {
  for (const [name, chunks, expected] of [
    ["an audio tag", ["（轻声", "）早安。"], "（轻声）早安。"],
    ["a frame opening split across two fragments", ["（思", "考过要下雨的）早安。"], "早安。"],
  ] as const) {
    assert.equal(released(chunks).join(""), expected, name);
  }
});

test("two frames in one message release the prose between them unbroken", () => {
  const input = "早安。<thinking>别催她。</thinking>今天有雨。【内心：别催。】那我去浇水。";
  assert.equal(released([...input]).join(""), removeModelScaffolding(input));
  assert.equal(released([...input]).join(""), "早安。今天有雨。那我去浇水。");
});
