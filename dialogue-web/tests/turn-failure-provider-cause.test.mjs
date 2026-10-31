/**
 * A refused turn's sentence is the CAUSE, and the five causes read differently.
 *
 * The measured defect: the Host settles every provider refusal as `runtime_unavailable`, and the
 * surface worded that one member with one paragraph naming five causes - a missing key, a model
 * the endpoint does not serve, an unreachable endpoint, and (once the classifier existed) a
 * throttle and an over-long conversation. A player holding a revoked key and a player being
 * rate-limited read the same words and had no way to tell which fix was theirs.
 *
 * Two rules, and the second is the one a paraphrase would pass while failing the first:
 *
 *  - every class gets its own sentence, in both catalogues, and no class inherits the paragraph;
 *  - the sentences are DISTINCT from each other and from `chatFailedRuntimeUnavailable`, so a
 *    future edit that quietly routes two causes to one string fails here rather than shipping a
 *    surface that cannot tell them apart.
 *
 * The `context_overflow` sentence has its own rule: it may not promise that a new chat fixes it.
 * The fixed floor (system prompt, tools, memory, authored context) is not the player's to shorten,
 * so a sentence that only says "start a new chat" is advice that can fail.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { turnFailureText } from "../src/components/turn-failure-text.ts";
import { messages } from "../src/i18n.ts";

/** The five classes, in the classifier's own order. */
const CLASSES = [
  "credential_rejected",
  "model_not_served",
  "rate_limited",
  "context_overflow",
  "endpoint_unreachable",
];

test("each classified provider cause words its own sentence, in both catalogues", () => {
  const failures = [];
  const readings = new Map();
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    const sentences = new Map();
    for (const providerFailure of CLASSES) {
      const sentence = turnFailureText("runtime_unavailable", labels, providerFailure);
      sentences.set(providerFailure, sentence);
      if (sentence.length === 0) failures.push(`${locale} ${providerFailure} has no sentence`);
      // A class is contract vocabulary: the sentence may never print it back.
      if (sentence.includes(providerFailure)) failures.push(`${locale} ${providerFailure} prints the raw class`);
      // The generic paragraph is the sentence this change exists to replace. A class that still
      // reads it has gained nothing.
      if (sentence === labels.chatFailedRuntimeUnavailable)
        failures.push(`${locale} ${providerFailure} still reads the five-cause paragraph`);
    }
    // Distinctness, which is the property the whole change exists for: five causes, five sentences.
    const distinct = new Set(sentences.values());
    if (distinct.size !== CLASSES.length)
      failures.push(`${locale} renders ${distinct.size} distinct sentences for ${CLASSES.length} causes`);
    readings.set(locale, sentences);
  }
  assert.deepEqual(failures, [], "every classified cause must reach the player as its own sentence");

  // The specific pair the change was filed for: a refused credential and a throttle.
  assert.notEqual(
    readings.get("en").get("credential_rejected"),
    readings.get("en").get("rate_limited"),
    "a 401 and a 429 must not read the same",
  );
});

test("an unclassified failure keeps its code's own sentence, and a cause never rewrites another code", () => {
  const labels = messages("en");
  // No cause published: the turn's code is all the surface has, and it says so.
  assert.equal(turnFailureText("runtime_unavailable", labels), labels.chatFailedRuntimeUnavailable);
  assert.equal(turnFailureText("interrupted", labels), labels.chatFailedInterrupted);
  assert.equal(turnFailureText(undefined, labels), labels.chatFailed);
  // A cause only ever describes a provider refusal. A stale one beside another code must not
  // rewrite that code's sentence into advice about a key.
  assert.equal(turnFailureText("interrupted", labels, "credential_rejected"), labels.chatFailedInterrupted);
  assert.equal(turnFailureText("storage_unavailable", labels, "rate_limited"), labels.chatFailedStorageUnavailable);
});

test("the context-overflow sentence names what happened and does not promise a new chat is a cure", () => {
  // The over-promise this guards: the floor (system prompt + tools + memory + authored context)
  // can exceed a small model's window on its own, and a player who starts a new chat and hits the
  // same wall was told something untrue.
  const labels = messages("en");
  const sentence = turnFailureText("runtime_unavailable", labels, "context_overflow");
  assert.match(sentence, /longer than this model's context window/u, "the sentence states what happened");
  assert.match(sentence, /new chat|remove older messages/u, "it names an action that is true");
  assert.doesNotMatch(
    sentence,
    /will (?:be )?fix|always (?:fix|work)|guarantee/iu,
    "it must not claim a fresh chat always resolves the overflow",
  );
});
