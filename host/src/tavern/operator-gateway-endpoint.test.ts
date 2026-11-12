/**
 * The operator's own gateway endpoint is CONFIGURATION, not a literal this source tree freezes.
 *
 * The gateway is our infrastructure - the operator's cliproxyapi instance - so its address belongs in one place and
 * has to be overridable. Three modules used to spell `http://127.0.0.1:8317/v1` independently: the catalog entry the
 * probe reads, the `models.json` block the Agent runtime is handed, and the gameplay sub-agent's own copy of that
 * block. A drift between them is invisible until a probe says `ready` and the Agent's very first turn fails to
 * connect, so the assertions below pin the two properties that make one owner real:
 *
 *  - the DEFAULT is exactly the address every existing developer root already holds (red if it silently moves);
 *  - every reader derives it from that one entry (red if a second owner reappears, since the equality only holds
 *    while all three read the same value).
 *
 * Precedence, in full: `GAMEBUDDY_OPERATOR_GATEWAY_BASE_URL` when it is a plain http(s) base URL, otherwise
 * `DEFAULT_OPERATOR_GATEWAY_BASE_URL`. It is resolved once, when the catalog module loads, so the probe and the
 * runtime cannot talk to two different gateways within one process. `GAMEBUDDY_OPERATOR_GATEWAY` is a different
 * fact and keeps its own meaning: it decides WHO may be offered the entry, never where it points.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { environmentProviderEntry } from "./pi-provider-store.js";
import {
  catalogProvider,
  DEFAULT_OPERATOR_GATEWAY_BASE_URL,
  operatorGatewayBaseUrl,
  resolveOperatorGatewayBaseUrl,
  TAVERN_ENVIRONMENT_PROVIDER_ID,
  TAVERN_OPERATOR_GATEWAY_BASE_URL_ENV,
  TAVERN_OPERATOR_GATEWAY_ENV,
} from "./provider-catalog.js";

const configured = (value: string): Readonly<Record<string, string | undefined>> => ({
  [TAVERN_OPERATOR_GATEWAY_BASE_URL_ENV]: value,
});

test("the zero-configuration default is the address existing developer roots already carry", () => {
  // Spelled out rather than read from the constant it is meant to pin: a test that compares the default to itself
  // passes after any change. This is the value `pi-provider-store.test.ts` holds byte-for-byte in its golden document
  // and the one `model-runtime.private.test.ts` matches on, so moving it is a visible product decision, not a tidy-up.
  assert.equal(DEFAULT_OPERATOR_GATEWAY_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(resolveOperatorGatewayBaseUrl({}), "http://127.0.0.1:8317/v1");
  assert.equal(resolveOperatorGatewayBaseUrl(configured("")), "http://127.0.0.1:8317/v1");
  assert.equal(resolveOperatorGatewayBaseUrl(configured("   ")), "http://127.0.0.1:8317/v1");
});

test("the environment override wins, with a trailing slash trimmed", () => {
  assert.equal(resolveOperatorGatewayBaseUrl(configured("http://10.0.0.7:9000/v1/")), "http://10.0.0.7:9000/v1");
  assert.equal(
    resolveOperatorGatewayBaseUrl(configured("  https://gateway.example.test:8443/openai/v1  ")),
    "https://gateway.example.test:8443/openai/v1",
  );
  // A bare origin is a legitimate base URL: only the request paths are appended to it.
  assert.equal(resolveOperatorGatewayBaseUrl(configured("http://10.0.0.7:9000/")), "http://10.0.0.7:9000");
});

test("a value that is not a plain http(s) base URL is refused rather than guessed at", () => {
  // `localhost:8317/v1` parses as a URL with the scheme `localhost:` - the shape a developer reaches for when they
  // drop the protocol, and exactly the one that would otherwise be written into `models.json` and fail at turn time.
  for (const value of [
    "127.0.0.1:8317/v1",
    "localhost:8317/v1",
    "ftp://gateway.test/v1",
    "http://user:secret@gateway.test/v1",
    "http://gateway.test/v1?key=1",
    "http://gateway.test/v1#fragment",
  ]) {
    assert.throws(
      () => resolveOperatorGatewayBaseUrl(configured(value)),
      /^Error: operator_gateway_base_url_invalid/u,
      value,
    );
  }
});

test("the probe and the Agent runtime read the same catalog entry, and nothing else", () => {
  const provider = catalogProvider(TAVERN_ENVIRONMENT_PROVIDER_ID);
  assert.ok(provider !== null, "the catalog still declares the operator's gateway entry");
  // The entry IS the resolved configuration, not a copy of the default that happens to agree with it today.
  assert.equal(provider.baseUrl, resolveOperatorGatewayBaseUrl(process.env));
  assert.equal(operatorGatewayBaseUrl(), provider.baseUrl);
  // The document Pi reads carries that same address: one authority, two readers.
  assert.equal(
    environmentProviderEntry("deepseek-v4.1-flash", undefined, "session-under-test").baseUrl,
    provider.baseUrl,
  );
});

test("offering the entry and moving the entry are two different switches", () => {
  assert.notEqual(TAVERN_OPERATOR_GATEWAY_ENV, TAVERN_OPERATOR_GATEWAY_BASE_URL_ENV);
  const environment = { [TAVERN_OPERATOR_GATEWAY_ENV]: "1" };
  assert.equal(
    resolveOperatorGatewayBaseUrl(environment),
    DEFAULT_OPERATOR_GATEWAY_BASE_URL,
    "opting in to the entry must not move it",
  );
});
