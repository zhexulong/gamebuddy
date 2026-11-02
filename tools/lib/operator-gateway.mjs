/**
 * The operator's own gateway, as the `tools/` harness layer sees it.
 *
 * Single authority note: the provider id of the operator's environment connection and the environment switch that
 * moves its address are owned by `host/src/tavern/provider-catalog.ts` (`TAVERN_ENVIRONMENT_PROVIDER_ID`,
 * `TAVERN_OPERATOR_GATEWAY_BASE_URL_ENV`). This module carries a read-only mirror of those two names, because the
 * `tools/` harness layer must not import Host source - the same rule `tools/lib/stardew-live-run.mjs` states for the
 * window-mode vocabulary. The Host module stays the authority, and the mirror is guarded twice:
 *
 *   - `tools/lib/operator-gateway.test.mjs` reads the declaration in `host/src/tavern/provider-catalog.ts` and asserts
 *     the mirror agrees with it, so a changed authority fails a test instead of drifting;
 *   - the `operator-gateway-provider-id` rule in `tools/lib/duplicated-authority.mjs` fails any OTHER file under
 *     `tools/` that spells the id again, so a harness has to import it from here.
 *
 * The ADDRESS is READ, never invented. The Host may keep a default, because it resolves exactly one address per
 * process from the product's own configuration. A harness may not: with the switch unset it would dial whatever
 * happens to be on a developer's loopback and report the resulting `ECONNREFUSED` as if the gateway were down, which
 * is a failure with no cause in it. `requiredOperatorGatewayBaseUrl()` therefore refuses BY NAME and names the
 * variable to set.
 */

export const OPERATOR_GATEWAY_PROVIDER_ID = "cpa-oai";

/** The one switch that moves the operator's gateway off its default address (see `provider-catalog.ts`). */
export const OPERATOR_GATEWAY_BASE_URL_VARIABLE = "GAMEBUDDY_OPERATOR_GATEWAY_BASE_URL";

/**
 * The base URL of the operator's gateway, or a named refusal naming the variable to set.
 *
 * The same shape rules as the Host's own resolver: a plain http(s) URL with no credentials, a query or a fragment,
 * and no trailing slash (every request path is appended to this value). A value that breaks one of them is refused
 * here rather than handed to `fetch`, where it would surface as a URL parse error or a wrong endpoint.
 *
 * The `env` parameter exists so a caller can name the environment it means; it defaults to the process's own.
 */
export function requiredOperatorGatewayBaseUrl(env = process.env) {
  const configured = env[OPERATOR_GATEWAY_BASE_URL_VARIABLE]?.trim() ?? "";
  if (configured === "") {
    throw new Error(
      `operator_gateway_base_url_unset: set ${OPERATOR_GATEWAY_BASE_URL_VARIABLE} to the base URL of the operator's own ` +
        "gateway - the address `host/src/tavern/provider-catalog.ts` resolves for the environment connection, ending at " +
        "`/v1`; this harness carries no default and will not guess an address",
    );
  }
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`operator_gateway_base_url_invalid: ${OPERATOR_GATEWAY_BASE_URL_VARIABLE} is not an absolute URL`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `operator_gateway_base_url_invalid: ${OPERATOR_GATEWAY_BASE_URL_VARIABLE} must be a plain http(s) base URL ` +
        "with no credentials, query or fragment",
    );
  }
  return configured.replace(/\/+$/u, "");
}
