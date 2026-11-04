// The run's provider wire, made readable: a recording proxy in front of the endpoint the product dials.
//
// The frontend run drives the product's own UI, and the provider request is posted by the HOST. Nothing
// the drivers can intercept over CDP carries it, and the operator's gateway writes no request log
// (`observability.logs.request-log: false` in its own config), so the only place a body can be read is
// between the Host and the gateway - which is what this module puts there.
//
// Two facts make that legitimate rather than a substitution:
//
//   the endpoint is the product's own. `upstreamBaseUrl` is read from the generation's catalog
//   (`operatorGatewayBaseUrl()`), so the run talks to exactly the address it would have talked to;
//   nothing here dials an address the product did not resolve, and `tools/` never spells one.
//
//   the model is the real model. The request is forwarded unchanged and the real reply streams back;
//   the proxy only keeps a copy of what went out. A stub that answered instead would change what the
//   run measures, which is the defect this instrument exists to avoid.
//
// The failure path is a NAMED absence, never a silent one: an unreadable generation or a proxy that
// cannot listen leaves the run pointed at its own gateway and returns the reason, so `INJECTION` reports
// `unobserved:no_provider_request_capture:<reason>` instead of a run that quietly recorded nothing.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OPERATOR_GATEWAY_BASE_URL_VARIABLE } from "../../../lib/operator-gateway.mjs";
import { startRecordingProviderProxy } from "../../core/recording-provider-proxy.mjs";
import { resolveGenerationRoot } from "./seed-connection.mjs";

/**
 * The base URL the product resolves for its provider, read from the generation it is about to install.
 *
 * Read BEFORE the environment is rewritten below, and that order is the whole reason this is a separate
 * step: `provider-catalog.ts` resolves its address once at module load, so a read taken after the
 * rewrite would answer the proxy's own address and the proxy would forward to itself.
 */
async function generationGatewayBaseUrl(artifactRoot) {
  const generationRoot = await resolveGenerationRoot(artifactRoot);
  const catalog = await import(pathToFileURL(join(generationRoot, "tavern", "provider-catalog.js")).href);
  if (typeof catalog.operatorGatewayBaseUrl !== "function") throw new Error("generation_exports_no_gateway_resolver");
  const baseUrl = catalog.operatorGatewayBaseUrl();
  if (typeof baseUrl !== "string" || baseUrl.length === 0) throw new Error("generation_resolved_no_gateway_address");
  return baseUrl;
}

/**
 * Start recording the run's provider wire, and point the product's own process at the recorder.
 *
 * `env` is the environment the launched Host child inherits, so writing the switch here is what makes
 * the child dial the proxy. It is written only when the proxy is listening: a run with no recorder keeps
 * the address it had.
 */
export async function startWireCapture({
  artifactRoot,
  capturePath,
  env = process.env,
  readUpstream = generationGatewayBaseUrl,
  startProxy = startRecordingProviderProxy,
}) {
  let upstreamBaseUrl;
  try {
    upstreamBaseUrl = await readUpstream(artifactRoot);
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason: `upstream_unresolved:${String(error?.message ?? error).slice(0, 200)}`,
    });
  }
  let proxy;
  try {
    proxy = await startProxy({ upstreamBaseUrl, capturePath });
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason: `proxy_refused:${String(error?.message ?? error).slice(0, 200)}`,
    });
  }
  env[OPERATOR_GATEWAY_BASE_URL_VARIABLE] = proxy.baseUrl;
  return Object.freeze({
    kind: "recording",
    baseUrl: proxy.baseUrl,
    upstreamBaseUrl: proxy.upstreamBaseUrl,
    capturePath: proxy.capturePath,
    close: proxy.close,
  });
}
