/**
 * The falsifiers for the tools-side gateway mirror (`tools/lib/operator-gateway.mjs`).
 *
 * The mirror is a copy, so it needs the two things a copy needs to be safe: something that fails when the authority
 * it mirrors moves, and something that fails when the mirror invents a value of its own.
 *
 *   - the declaration tests read `host/src/tavern/provider-catalog.ts` and assert this mirror still states the same
 *     provider id and the same address variable;
 *   - the address tests assert the reader refuses BY NAME when the switch is unset - naming the variable to set and the
 *     file that read it - so no harness can fall back onto an address nobody configured, and no refusal is anonymous;
 *   - the last test asserts the module spells no absolute URL at all, which is what makes "the address is read,
 *     never invented" a property of the file rather than a promise in its header.
 *
 * red-proof: mutate - change `OPERATOR_GATEWAY_PROVIDER_ID` in `tools/lib/operator-gateway.mjs` to any other id and
 * "the provider id is the Host authority's" fails, naming the Host declaration it disagrees with; delete the
 * `configured === ""` branch and "an unset switch is refused by name" fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OPERATOR_GATEWAY_BASE_URL_VARIABLE,
  OPERATOR_GATEWAY_PROVIDER_ID,
  requiredOperatorGatewayBaseUrl,
} from "./operator-gateway.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The Host module that owns both names this file mirrors. */
const HOST_AUTHORITY = "host/src/tavern/provider-catalog.ts";
const authoritySource = readFileSync(join(repoRoot, HOST_AUTHORITY), "utf8");

/**
 * The string literal one `export const <name> = "..."` declares in the Host authority, or null when the module no
 * longer declares that name at all. Matched on the declaration rather than on the literal alone, so a value that
 * moved to a different constant is not read as agreement.
 */
function authorityValue(name) {
  const declaration = new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`, "u").exec(authoritySource);
  return declaration?.[1] ?? null;
}

test("the provider id is the Host authority's", () => {
  assert.equal(
    authorityValue("TAVERN_ENVIRONMENT_PROVIDER_ID"),
    OPERATOR_GATEWAY_PROVIDER_ID,
    `${HOST_AUTHORITY} no longer declares TAVERN_ENVIRONMENT_PROVIDER_ID as the id this mirror states`,
  );
});

test("the address variable is the Host authority's", () => {
  assert.equal(
    authorityValue("TAVERN_OPERATOR_GATEWAY_BASE_URL_ENV"),
    OPERATOR_GATEWAY_BASE_URL_VARIABLE,
    `${HOST_AUTHORITY} no longer declares TAVERN_OPERATOR_GATEWAY_BASE_URL_ENV as the variable this mirror states`,
  );
});

const READER = "tools/lib/operator-gateway.test.mjs";

test("an unset switch is refused by name, naming the variable and the file", () => {
  assert.throws(
    () => requiredOperatorGatewayBaseUrl(READER, {}),
    (error) => {
      assert.match(error.message, /^operator_gateway_base_url_unset:/u);
      assert.ok(
        error.message.includes(OPERATOR_GATEWAY_BASE_URL_VARIABLE),
        "the refusal has to name the variable the operator has to set",
      );
      assert.ok(
        error.message.includes(READER),
        "the refusal has to name the file that read the address, so it can be traced to a command",
      );
      return true;
    },
  );
});

test("a reader that does not name itself is a programming error, not a configuration one", () => {
  assert.throws(() => requiredOperatorGatewayBaseUrl(), {
    name: "TypeError",
    message: /^operator_gateway_reader_required:/u,
  });
  assert.throws(() => requiredOperatorGatewayBaseUrl("  "), { name: "TypeError" });
});

test("a blank switch is refused the same way as an absent one", () => {
  assert.throws(() => requiredOperatorGatewayBaseUrl(READER, { [OPERATOR_GATEWAY_BASE_URL_VARIABLE]: "   " }), {
    message: /^operator_gateway_base_url_unset:/u,
  });
});

test("a configured switch is returned trimmed of its trailing slash", () => {
  const configured = "http://127.0.0.1:9/v1";
  const read = (value) => requiredOperatorGatewayBaseUrl(READER, { [OPERATOR_GATEWAY_BASE_URL_VARIABLE]: value });
  assert.equal(read(configured), configured);
  assert.equal(read(`${configured}///`), configured);
  assert.equal(read(" http://host:9/v1 "), "http://host:9/v1");
});

test("a value that is not a plain http(s) base URL is refused by name", () => {
  const refused = [
    "not a url",
    "ftp://host/v1",
    "http://user:secret@host/v1",
    "http://host/v1?key=secret",
    "http://host/v1#fragment",
  ];
  for (const value of refused) {
    assert.throws(
      () => requiredOperatorGatewayBaseUrl(READER, { [OPERATOR_GATEWAY_BASE_URL_VARIABLE]: value }),
      { message: new RegExp(`^operator_gateway_base_url_invalid:.*${OPERATOR_GATEWAY_BASE_URL_VARIABLE}`, "u") },
      `${value} has to be refused rather than handed to fetch`,
    );
  }
});

test("the mirror spells no address of its own", () => {
  const source = readFileSync(join(repoRoot, "tools", "lib", "operator-gateway.mjs"), "utf8");
  assert.equal(
    /https?:\/\//u.test(source),
    false,
    "the mirror must read the address from the environment; an absolute URL in this file is a second spelling of it",
  );
});
