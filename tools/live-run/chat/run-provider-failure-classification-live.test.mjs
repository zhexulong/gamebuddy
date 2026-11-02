/**
 * The falsifier for the real-endpoint classification probe: every branch of the three-way judgement is driven by an injected violation and produces the finding it claims.
 *
 * The live runner (`run-provider-failure-classification-live.mjs`) is the thing that measures a real
 * `api.deepseek.com` response; this file is what makes its judgement provable without a network. The
 * judgement is `judgeProviderFailureClassification`, a pure function, and its whole value is that the
 * three outcomes stay DISTINCT:
 *
 *   - the endpoint was never reached        -> inconclusive, exit 0
 *   - reached, refusal classified wrongly   -> exit 1, naming produced and expected
 *   - reached, answer was something else    -> exit 1, reported as its own case
 *
 * A single "red" for all three is the defect `problem-code.13` taught us about. So each violation below
 * is injected separately and each one must reach ITS branch: an unreachable transport must not be
 * reported as a misclassification, a 2xx must not be reported as either, and a changed classifier mapping
 * must not be blamed on the turn.
 *
 * The credential assertions matter for the same reason: this file is the only thing standing between a
 * future edit and a probe that spends an operator's real DeepSeek key.
 *
 * red-proof: inject a 401 against a turn with no cause, a cause collapsed into endpoint_unreachable, a
 * misclassified cause, a changed classifier mapping, an unreachable transport, a 2xx reply, an HTML reply
 * and a sentence equal to the five-cause paragraph, each through judgeProviderFailureClassification, and
 * require classification_wrong / classification_mapping_changed / external_endpoint_unreachable (exit 0) /
 * external_endpoint_unexpected / sentence_collapsed (tools/live-run/chat/run-provider-failure-classification-live.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFakeCredentialOnly,
  ENDPOINT,
  EVIDENCE_BODY_MAX_CHARS,
  exitCodeFor,
  FAKE_API_KEY,
  judgeProviderFailureClassification,
  PROBE_STATES,
  reachedARefusal,
  readEndpointEvidence,
} from "./run-provider-failure-classification-live.mjs";

/** The endpoint's own reply shape, as the live run measured it: 401 and an authentication error body. */
const REFUSED = Object.freeze({
  reachability: "reached",
  failure: null,
  status: 401,
  contentType: "application/json",
  jsonBody: true,
  bodyChars: 204,
  redactedBody: '{"error":{"message":"Authentication Fails, Your api key: ****robe is invalid"}}',
});

const UNREACHABLE = Object.freeze({
  reachability: "unreachable",
  failure: "dns",
  status: null,
  contentType: null,
  jsonBody: false,
  bodyChars: 0,
  redactedBody: "",
});

const CREDENTIAL_SENTENCE = "The endpoint refused your API key: it is missing, wrong, or has been revoked.";
const FIVE_CAUSE_SENTENCE =
  "The reply never reached a model: the endpoint refused it - the key, the model, or the endpoint itself.";
const UNREACHABLE_SENTENCE = "The endpoint could not be reached at all.";

function judge(overrides = {}) {
  return judgeProviderFailureClassification({
    evidence: REFUSED,
    expectedClass: "credential_rejected",
    observedClass: "credential_rejected",
    sentence: CREDENTIAL_SENTENCE,
    runtimeUnavailableSentence: FIVE_CAUSE_SENTENCE,
    endpointUnreachableSentence: UNREACHABLE_SENTENCE,
    ...overrides,
  });
}

test("a 401 the Host classified as a credential refusal is verified, and that is the only green", () => {
  assert.deepEqual(judge(), { state: PROBE_STATES.verified, reason: null });
  assert.equal(exitCodeFor(PROBE_STATES.verified), 0);
});

test("an endpoint that never answered is INCONCLUSIVE, not our defect, and exits 0", () => {
  const verdict = judge({
    evidence: UNREACHABLE,
    expectedClass: null,
    observedClass: null,
    sentence: FIVE_CAUSE_SENTENCE,
  });
  assert.equal(verdict.state, PROBE_STATES.externalEndpointUnreachable);
  assert.match(verdict.reason, /network_did_not_reach_endpoint:dns/);
  assert.equal(exitCodeFor(verdict.state), 0, "a red run for a reason that is not ours is how a gate stops being read");
  // Ordering, and the reason it is asserted: the same transport failure with a turn that DID record
  // something wrong must still be inconclusive. The unreachable case is a fact about the network and
  // outranks every statement the turn makes.
  const withWrongTurn = judge({ evidence: UNREACHABLE, expectedClass: null, observedClass: "rate_limited" });
  assert.equal(withWrongTurn.state, PROBE_STATES.externalEndpointUnreachable);
});

test("a reply this gate cannot read is its own case, neither unreachable nor a misclassification", () => {
  const accepted = judge({
    evidence: { ...REFUSED, status: 200, jsonBody: true, redactedBody: '{"data":[{"id":"deepseek-chat"}]}' },
    expectedClass: null,
  });
  assert.equal(accepted.state, PROBE_STATES.externalEndpointUnexpected);
  assert.equal(accepted.reason, "endpoint_accepted_the_invalid_key");
  assert.equal(exitCodeFor(accepted.state), 1);

  const html = judge({
    evidence: {
      ...REFUSED,
      status: 403,
      jsonBody: false,
      contentType: "text/html",
      redactedBody: "<html>portal</html>",
    },
  });
  assert.equal(html.state, PROBE_STATES.externalEndpointUnexpected);
  assert.equal(html.reason, "endpoint_replied_without_a_json_error");
  assert.notEqual(html.state, PROBE_STATES.externalEndpointUnreachable);
});

test("a changed classifier mapping is reported as the mapping, not as this turn getting it wrong", () => {
  const verdict = judge({ expectedClass: "rate_limited", observedClass: "rate_limited" });
  assert.equal(verdict.state, PROBE_STATES.classificationMappingChanged);
  assert.match(verdict.reason, /a_401_no_longer_classifies_as_credential_rejected:rate_limited/);
  assert.equal(exitCodeFor(verdict.state), 1);
});

test("the original defect - a refusal with no cause, or one collapsed into endpoint_unreachable - is named", () => {
  const absent = judge({ observedClass: null, sentence: FIVE_CAUSE_SENTENCE });
  assert.equal(absent.state, PROBE_STATES.classificationWrong);
  assert.equal(absent.reason, "no_provider_failure_recorded_on_the_durable_turn");

  const collapsed = judge({ observedClass: "endpoint_unreachable", sentence: UNREACHABLE_SENTENCE });
  assert.equal(collapsed.state, PROBE_STATES.classificationWrong);
  assert.equal(collapsed.reason, "collapsed_into_endpoint_unreachable");

  const misclassified = judge({ observedClass: "rate_limited" });
  assert.equal(misclassified.state, PROBE_STATES.classificationWrong);
  assert.equal(
    misclassified.reason,
    "produced_rate_limited_expected_credential_rejected",
    "the report must name the member produced AND the member expected",
  );
});

test("a correct cause routed to the wrong sentence is still a collapse, and says which sentence", () => {
  const generic = judge({ sentence: FIVE_CAUSE_SENTENCE });
  assert.equal(generic.state, PROBE_STATES.sentenceCollapsed);
  assert.equal(generic.reason, "reads_the_runtime_unavailable_sentence");

  const unreachable = judge({ sentence: UNREACHABLE_SENTENCE });
  assert.equal(unreachable.state, PROBE_STATES.sentenceCollapsed);
  assert.equal(unreachable.reason, "reads_the_endpoint_unreachable_sentence_while_the_endpoint_answered");
});

test("every state carries an exit code, and only the two honest ones are green", () => {
  const expected = new Map([
    [PROBE_STATES.verified, 0],
    [PROBE_STATES.externalEndpointUnreachable, 0],
    [PROBE_STATES.externalEndpointUnexpected, 1],
    [PROBE_STATES.classificationMappingChanged, 1],
    [PROBE_STATES.classificationWrong, 1],
    [PROBE_STATES.sentenceCollapsed, 1],
  ]);
  assert.deepEqual(
    Object.values(PROBE_STATES).sort(),
    [...expected.keys()].sort(),
    "every declared state must be classified here, so a new one cannot default to an unexamined exit code",
  );
  for (const [state, code] of expected) assert.equal(exitCodeFor(state), code, state);
});

test("the endpoint's body is bounded and redacted, and no request header is ever kept", async () => {
  const secretish = `{"error":{"message":"Incorrect API key provided: sk-${"a".repeat(24)}","padding":"${"b".repeat(9_000)}"}}`;
  const evidence = await readEndpointEvidence({
    baseUrl: ENDPOINT,
    apiKey: FAKE_API_KEY,
    transport: async () => new Response(secretish, { status: 401, headers: { "content-type": "application/json" } }),
  });
  assert.equal(evidence.status, 401);
  assert.ok(
    evidence.redactedBody.length <= EVIDENCE_BODY_MAX_CHARS,
    `the evidence line must be bounded, got ${evidence.redactedBody.length} chars`,
  );
  assert.ok(evidence.redactedBody.includes("<REDACTED>"), "a key-shaped run in the body must be redacted, not dropped");
  assert.equal(evidence.redactedBody.includes("aaaaaaaa"), false, evidence.redactedBody);
  const serialized = JSON.stringify(evidence);
  assert.equal(/authorization|bearer/i.test(serialized), false, `no request header may cross: ${serialized}`);
});

test("a transport failure is classified by the layer it failed at, and never carries the endpoint", async () => {
  const dns = await readEndpointEvidence({
    baseUrl: ENDPOINT,
    apiKey: FAKE_API_KEY,
    transport: async () => {
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      throw error;
    },
  });
  assert.equal(dns.reachability, "unreachable");
  assert.equal(dns.failure, "dns");

  const timeout = await readEndpointEvidence({
    baseUrl: ENDPOINT,
    apiKey: FAKE_API_KEY,
    transport: async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    },
  });
  assert.equal(timeout.failure, "timeout");
  assert.equal(JSON.stringify(timeout).includes("api.deepseek.com"), false, "an evidence line never carries the URL");
});

test("the runner's skip-a-turn predicate and the judgement's readable-reply branch are one answer", () => {
  // The two must never disagree: the predicate decides whether a turn is driven, and the judgement
  // decides whether that turn's answer is consulted. A gap between them is a run that either spends a
  // runtime on nothing or judges a turn it never drove.
  const cases = [REFUSED, UNREACHABLE, { ...REFUSED, status: 200 }, { ...REFUSED, status: 503, jsonBody: false }];
  const readsTheTurn = new Set([
    PROBE_STATES.verified,
    PROBE_STATES.classificationMappingChanged,
    PROBE_STATES.classificationWrong,
    PROBE_STATES.sentenceCollapsed,
  ]);
  for (const evidence of cases) {
    const judged = judge({ evidence, expectedClass: null, observedClass: null, sentence: FIVE_CAUSE_SENTENCE });
    assert.equal(
      reachedARefusal(evidence),
      readsTheTurn.has(judged.state),
      `${judged.state} for ${JSON.stringify(evidence)}`,
    );
  }
});

test("the probe's credential is an obviously fake literal and a real one in the environment is refused", () => {
  assert.match(FAKE_API_KEY, /^sk-invalid-/u, "a fake key must say so, or a wrong-status run looks like a real charge");
  // The key is a literal and nothing else: no variable in the environment carries it, so the probe cannot
  // be handed a credential by whoever happens to have one exported.
  assert.equal(
    Object.values(process.env).includes(FAKE_API_KEY),
    false,
    `${FAKE_API_KEY} must be a literal in the probe, never read from the environment`,
  );
  assert.doesNotThrow(() => assertFakeCredentialOnly({}));
  assert.throws(
    () => assertFakeCredentialOnly({ DEEPSEEK_API_KEY: `sk-${"f".repeat(32)}` }),
    /real_credential_in_environment/u,
    "an exported real key must refuse by name before any request is made",
  );
});
