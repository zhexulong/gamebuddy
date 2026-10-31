import assert from "node:assert/strict";
import test from "node:test";

import { classifyProviderFailure, type ProviderFailureClass } from "./provider-failure-classification.js";

/**
 * The five classes, derived from the exact strings Pi produces.
 *
 * Every case below is a real provider wording, not an invented one: the status-first
 * shapes are what `formatProviderError` builds (`"<status>: <body>"`), and the
 * body-only shapes are what it passes through unchanged when the SDK already folded
 * the body into `error.message` (Anthropic, Google).
 *
 * The boundary this file protects is not "the classifier is clever". It is that a
 * refusal acquires exactly one of five names, and that the name is chosen from
 * evidence the provider actually supplied.
 */

/** `[errorMessage, expected, why]` - `why` becomes the assertion's own failure text. */
const CASES: readonly (readonly [string, ProviderFailureClass, string])[] = [
  // Status-first: the provider's own statement.
  [
    '401: {"error":{"message":"Incorrect API key provided: sk-proj-AbC***XyZ"}}',
    "credential_rejected",
    "a 401 is a refused credential whatever the body says",
  ],
  [
    '403: {"error":{"message":"You do not have access to this resource"}}',
    "credential_rejected",
    "a 403 is the same refusal under another status",
  ],
  ['429: {"error":{"message":"Rate limit reached for requests per min"}}', "rate_limited", "a 429 is a throttle"],
  [
    '404: {"error":{"message":"The model `gpt-9` does not exist"}}',
    "model_not_served",
    "a 404 from a completion endpoint names a model the endpoint will not serve",
  ],
  ["404: Not Found", "model_not_served", "a bare 404 is still the endpoint not serving what was asked"],

  // The prefixed shape `formatProviderError` builds when the SDK supplied a prefix.
  [
    "Anthropic API error (401): invalid x-api-key",
    "credential_rejected",
    "the SDK-prefixed status is read the same way",
  ],
  ["Groq (429): rate limit exceeded", "rate_limited", "same, for a throttling gateway"],

  // Body-only: no usable status survived, so the wording decides.
  ["Incorrect API key provided: sk-abc", "credential_rejected", "OpenAI's own 401 prose without the status"],
  ["invalid_api_key: the provided key is not valid", "credential_rejected", "a gateway error code naming the key"],
  ["Promise rate limit exceeded", "rate_limited", "a throttle the provider phrased without a status"],
  ["The model `claude-9` does not exist or you do not have access to it", "model_not_served", "OpenAI's 404 prose"],

  // Overflow, in the wordings this Host recognises.
  ["prompt is too long: 213462 tokens > 200000 maximum", "context_overflow", "Anthropic's overflow"],
  ["Your input exceeds the context window of this model", "context_overflow", "OpenAI's overflow"],
  ["maximum context length is 8192 tokens", "context_overflow", "an OpenRouter/vLLM-shaped overflow"],
  ["the request exceeds the available context size, try increasing it", "context_overflow", "llama.cpp's overflow"],
  ["400: request_too_large", "context_overflow", "Anthropic's byte-size overflow, statussed as 400"],

  // Nothing recognisable: the honest class, not a guess.
  ["fetch failed", "endpoint_unreachable", "a transport failure names no provider cause"],
  ["connect ECONNREFUSED 127.0.0.1:11434", "endpoint_unreachable", "a refused connection"],
  ["getaddrinfo ENOTFOUND api.example.invalid", "endpoint_unreachable", "a DNS failure"],
  [
    '500: {"error":{"message":"internal server error"}}',
    "endpoint_unreachable",
    "a server fault is not one of the player's four fixable causes",
  ],
];

test("every provider refusal acquires exactly one class, from evidence the provider supplied", () => {
  for (const [errorMessage, expected, why] of CASES) {
    assert.equal(classifyProviderFailure(errorMessage), expected, `${why} (${errorMessage})`);
  }
});

test("a throttle phrased as 'too many tokens' is a rate limit, not an overflow", () => {
  // Amazon Bedrock's throttling wording, which matches a generic overflow phrase and
  // would otherwise tell the player to shorten a conversation that was never too long.
  assert.equal(
    classifyProviderFailure("Throttling error: Too many tokens, please wait before trying again."),
    "rate_limited",
  );
});

test("the five members are the whole union, and every one is reachable from real provider text", () => {
  const reached = new Set(CASES.map(([, expected]) => expected));
  const declared: readonly ProviderFailureClass[] = [
    "credential_rejected",
    "model_not_served",
    "rate_limited",
    "context_overflow",
    "endpoint_unreachable",
  ];
  for (const member of declared) {
    assert.equal(reached.has(member), true, `no case reaches ${member}`);
  }
  assert.equal(reached.size, declared.length);
});

test("a message the provider never supplied classifies as nothing rather than as a cause", () => {
  // An aborted turn, an extension refusal, a transport that produced no message: the
  // observer passes `undefined` and the surface must say nothing about a cause.
  for (const absent of [undefined, null, "", 42, {}]) {
    assert.equal(classifyProviderFailure(absent), undefined, String(absent));
  }
});
