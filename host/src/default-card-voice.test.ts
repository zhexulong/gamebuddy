import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_IDENTITY_PROFILE, renderIdentityProfile } from "./identity-profile.js";

/**
 * The default card has to teach a REGISTER, not just a disposition.
 *
 * Measured on our own runs: of 4425 assistant messages that carried both text and
 * a tool call, only 7% mentioned the player at all and only 9% contained a spoken
 * particle; the median was 23 characters of flat work log ("我先从最近的开始收。").
 * The system prompt cannot fix that - `identity-profile.ts` classifies every prompt
 * instruction as floor / form / channel and states that a prompt-written shape
 * rule beats a card that teaches the opposite shape, so form belongs to the card.
 * The card was the empty part.
 *
 * These cases pin the card's shape, not its wording, so the text can be improved
 * without the test having to be rewritten for every edit.
 */

const examples = DEFAULT_IDENTITY_PROFILE.examples ?? [];

test("the default card carries dialogue examples at all", () => {
  // Register travels by sample. Without examples the model picks its cheapest
  // register, which is what produced the work log.
  assert.ok(examples.length >= 6, `expected at least 6 examples, found ${examples.length}`);
});

test("every example is a spoken turn addressed to the player, not a status report", () => {
  for (const example of examples) {
    const spoken = example.companion;
    assert.ok(/[你咱]|你/.test(spoken), `example does not address the player: ${JSON.stringify(spoken)}`);
  }
});

test("most examples carry a spoken particle, so the register is conversational", () => {
  const withParticle = examples.filter((e) => /[啊呢吧啦嘛哦呀诶嘿嘞]/u.test(e.companion));
  assert.ok(
    withParticle.length >= Math.ceil(examples.length * 0.6),
    `expected most examples to sound spoken, ${withParticle.length} of ${examples.length} do`,
  );
});

test("no example is a bare step report: each either asks, answers, or says what it is doing for the player", () => {
  // The specific failure this guards: "我先从最近的开始收。" - it narrates a
  // procedure with no listener. A spoken turn either involves the player or
  // commits to something on their behalf.
  for (const example of examples) {
    assert.ok(
      /[你咱]|[？?]|等我|交给我|我来|一起|要不要|好不好/u.test(example.companion),
      `example narrates procedure without a listener: ${JSON.stringify(example.companion)}`,
    );
  }
});

test("examples stay short enough for the delivery budget", () => {
  for (const example of examples) {
    const length = [...example.companion].length;
    assert.ok(
      length <= 60,
      `example is ${length} characters, longer than a spoken turn should be: ${JSON.stringify(example.companion)}`,
    );
  }
});

test("the examples reach the system prompt under a labelled dialogue block", () => {
  const rendered = renderIdentityProfile(DEFAULT_IDENTITY_PROFILE, "zh-CN");
  assert.match(rendered, /\[Dialogue Examples\]/);
  for (const example of examples) {
    assert.ok(rendered.includes(example.companion), "every example must be rendered, not silently dropped");
  }
});

test("the card's expression style names spoken register rather than describing a mood", () => {
  const style = DEFAULT_IDENTITY_PROFILE.persona?.expressionStyle ?? "";
  // A mood adjective ("lightly playful") does not tell a model what to type; a
  // register instruction does.
  assert.match(style, /短|一句|说|称|话/su);
});

test("examples use no stage direction, because bubbles strip it", () => {
  // `companion-speech-dehydration.ts` removes `*...*` beats from bubbles, so an
  // example whose voice lives inside asterisks teaches nothing the player sees.
  for (const example of examples) {
    assert.ok(
      !/[*（(]/u.test(example.companion),
      `example relies on stage direction: ${JSON.stringify(example.companion)}`,
    );
  }
});
