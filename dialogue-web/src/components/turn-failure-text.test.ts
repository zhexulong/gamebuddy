import assert from "node:assert/strict";
import test from "node:test";
import { messages } from "../i18n";
import type { BrowserTurnV1 } from "../reference-pipeline-api";
import { turnFailureText } from "./turn-failure-text";

/**
 * The failed turn's sentence, as one pure function.
 *
 * A `failed` turn is four different events to the player (the connection dropped,
 * nothing was shown, the endpoint refused, the reply could not be written), and a
 * provider refusal is five more. The surface used to answer all of them with one
 * "try again", so these are the properties that keep the distinction - no browser,
 * no mocked catalogue, the real `messages(locale)` both catalogues ship.
 *
 * The code and cause populations are hand-written here because the mirror declares
 * them as private consts; `tests/problem-code-gate.test.mjs` holds that mirror to
 * EQUALITY with the Host's own declarations, which is where drift is caught.
 */

const LOCALES = ["en", "zh-CN"] as const;
const PROBLEM_CODES = ["interrupted", "no_visible_presentation", "runtime_unavailable", "storage_unavailable"] as const;
const PROVIDER_FAILURES = [
  "credential_rejected",
  "model_not_served",
  "rate_limited",
  "context_overflow",
  "endpoint_unreachable",
] as const;

test("a failed turn with no code says only that it failed", () => {
  for (const locale of LOCALES) {
    const labels = messages(locale);
    assert.equal(turnFailureText(undefined, labels), labels.chatFailed);
  }
});

test("each problem code reaches the player as its own sentence, never as the code", () => {
  for (const locale of LOCALES) {
    const labels = messages(locale);
    const sentences = PROBLEM_CODES.map((code) => {
      const sentence = turnFailureText(code, labels);
      assert.ok(sentence.length > 0, `${locale} ${code} is empty`);
      assert.notEqual(sentence, code, `${locale} ${code} is rendered as the wire member`);
      assert.ok(!sentence.includes(code), `${locale} ${code} still contains the raw member`);
      // A code that inherited the generic line is a failure the surface stopped explaining.
      assert.notEqual(sentence, labels.chatFailed, `${locale} ${code} reads as the generic failure`);
      return sentence;
    });
    assert.equal(new Set(sentences).size, PROBLEM_CODES.length, `${locale} two problem codes share one sentence`);
  }
});

test("a classified provider cause words its own sentence, and no cause inherits the paragraph", () => {
  for (const locale of LOCALES) {
    const labels = messages(locale);
    const sentences = PROVIDER_FAILURES.map((providerFailure) => {
      const sentence = turnFailureText("runtime_unavailable", labels, providerFailure);
      assert.ok(sentence.length > 0, `${locale} ${providerFailure} is empty`);
      assert.ok(!sentence.includes(providerFailure), `${locale} ${providerFailure} prints the raw class`);
      // The five-cause paragraph is the sentence this distinction exists to replace.
      assert.notEqual(sentence, labels.chatFailedRuntimeUnavailable, `${locale} ${providerFailure} inherits it`);
      return sentence;
    });
    assert.equal(
      new Set(sentences).size,
      PROVIDER_FAILURES.length,
      `${locale} renders fewer distinct sentences than causes`,
    );
    // The pair the change was filed for: a refused credential and a throttle are different fixes.
    assert.notEqual(
      turnFailureText("runtime_unavailable", labels, "credential_rejected"),
      turnFailureText("runtime_unavailable", labels, "rate_limited"),
    );
  }
});

test("a cause never rewrites another code's sentence", () => {
  const labels = messages("en");
  for (const code of ["interrupted", "no_visible_presentation", "storage_unavailable"] as const)
    assert.equal(
      turnFailureText(code, labels, "credential_rejected"),
      turnFailureText(code, labels),
      `${code} lost its own sentence to a cause it cannot have`,
    );

  // A refusal with no cause classified keeps the code's own sentence.
  assert.equal(turnFailureText("runtime_unavailable", labels), labels.chatFailedRuntimeUnavailable);
});

test("a cause this build does not classify falls back to the refusal's own sentence", () => {
  // The untyped boundary: the value arrives off the wire, and the wire validator refuses
  // an unknown class before it reaches here - so this is a build-time guard, not a path.
  const unclassified = "vendor_specific_refusal" as unknown as NonNullable<BrowserTurnV1["providerFailure"]>;
  const labels = messages("en");
  const sentence = turnFailureText("runtime_unavailable", labels, unclassified);
  assert.equal(sentence, labels.chatFailedRuntimeUnavailable);
  assert.ok(!sentence.includes(unclassified), "the surface printed a class it does not have words for");
});
