/**
 * A recording reverse proxy: the frontend live run's provider traffic, forwarded unchanged to the real
 * endpoint, with every request kept so `INJECTION` has a wire to read.
 *
 * Why this exists at all. The frontend run drives the product's own UI, so the provider request is
 * posted by the HOST, not by the page: nothing a driver can intercept over CDP carries a provider body.
 * `stub-provider.mjs` closes that gap on the other live-run kits by ANSWERING the request, which changes
 * what the run measures - a fixed stub reply instead of a model's. This one reasons the other way round:
 * the request reaches the real endpoint and the real model answers it; the proxy only keeps a copy of
 * what went out. What a run mounting this can assert is unchanged from any other frontend run, plus one
 * thing more: which authored-context blocks each turn actually sent.
 *
 * The capture is one JSON object per line, appended as each request arrives, and each line names its own
 * writer (`source`). An append is the right shape for a run that streams: rewriting a growing document
 * after every request costs the square of the run and loses every earlier record if the process is
 * killed mid-write. The reader refuses a file whose lines disagree about which instance wrote them
 * (`frontend/capture/observation.cjs`), so a reader can never inherit a source from the wrong writer.
 *
 * Attribution is by identity and never by position. The Host stamps every outbound provider request
 * with the turn it belongs to and the submission key that turn was accepted under
 * (`host/src/provider-turn-header.internal.ts`): a body is keyed by the values that travelled with it. A
 * request carrying neither is recorded with `turnId: null` and `idempotencyKey: null` - arrival order is
 * not turn order, and a `/models` probe, a transport retry or a second surface inserts a record that
 * shifts every later position.
 *
 * It carries no headers. That is a decision rather than a redaction: the credential travels in
 * `authorization`, and a capture file lives in the run's stage directory for the whole run, read by
 * every driver of the run and kept beside the report. The two names above and the assembled body are the
 * whole reading.
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { appendFileSync } from "node:fs";

/** The `source` this writer declares, so a reader can say whose wire it is describing. */
export const RECORDING_PROXY_CAPTURE_SOURCE = "recording-provider-proxy";

/**
 * The headers the Host names the turn on.
 *
 * `tools/` must not import Host source, so these mirror `PROVIDER_TURN_HEADER_NAME` and
 * `PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME` in `host/src/provider-turn-header.internal.ts`;
 * `recording-provider-proxy.test.mjs` reads that declaration and asserts the three agree, so a rename in
 * the Host fails a test instead of leaving a reader that finds no identity on any body.
 */
export const PROVIDER_TURN_HEADER_NAME = "X-GameBuddy-Turn-Id";
export const PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME = "X-GameBuddy-Idempotency-Key";

/** Hop-by-hop headers belong to one connection and are not forwarded by a proxy. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Start the proxy in front of `upstreamBaseUrl` and record each request it forwards.
 *
 * The listener binds an ephemeral loopback port, as `stub-provider.mjs` does: a local recorder that asks
 * the OS for a free port cannot collide with a sibling run, which is why the CDP port needs a named lock
 * (Edge can only be told a fixed one) and this does not.
 *
 * `capturePath` is where the records are appended; the caller owns the directory (a run's stage
 * `state/`), and nothing here invents a location.
 *
 * `baseUrl` is what the product must be pointed at: the same base URL shape it was going to dial - the
 * incoming request path already carries the base's own path because an OpenAI-compatible client appends
 * `/models` and `/chat/completions` to the base URL it was given.
 */
export async function startRecordingProviderProxy({ upstreamBaseUrl, capturePath }) {
  const upstream = parseUpstream(upstreamBaseUrl);
  if (typeof capturePath !== "string" || capturePath.length === 0)
    throw new Error("recording_proxy_capture_path_required");
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      appendCapture(capturePath, upstreamBaseUrl, recordOf(request, raw));
      forward({ upstream, request, raw, response });
    });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}${upstream.pathname.replace(/\/+$/u, "")}`;
  let closed = false;
  return Object.freeze({
    baseUrl,
    upstreamBaseUrl,
    capturePath,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((closed_) => server.close(closed_));
    },
  });
}

function parseUpstream(upstreamBaseUrl) {
  let parsed;
  try {
    parsed = new URL(upstreamBaseUrl);
  } catch {
    throw new Error(`recording_proxy_upstream_invalid:${String(upstreamBaseUrl)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error(`recording_proxy_upstream_unsupported:${parsed.protocol}`);
  return parsed;
}

/**
 * One record per request: the identities the Host put on it, and the body as it was posted.
 *
 * `body` is the parsed JSON when the body parses and the raw text when it does not, because a body this
 * kit cannot parse is still what went on the wire and is recorded as such rather than dropped. A request
 * that names no turn records `null` for both identities - an empty string would be an identity that
 * matches nothing.
 */
function recordOf(request, raw) {
  let body = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* A body that is not JSON stays the text it is; the reader ignores what it cannot read as a body. */
  }
  return {
    source: RECORDING_PROXY_CAPTURE_SOURCE,
    at: new Date().toISOString(),
    method: request.method,
    path: request.url,
    turnId: headerOf(request, PROVIDER_TURN_HEADER_NAME),
    idempotencyKey: headerOf(request, PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME),
    body,
  };
}

function headerOf(request, name) {
  const value = request.headers[name.toLowerCase()];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Append one line to the capture.
 *
 * `upstreamBaseUrl` is repeated on every line rather than declared once in a preamble: a file whose
 * first line is a document and whose rest are records is a file with two shapes, and a reader that
 * skipped the first line would read the wrong thing as a request.
 */
function appendCapture(capturePath, upstreamBaseUrl, record) {
  appendFileSync(capturePath, `${JSON.stringify({ ...record, upstreamBaseUrl })}\n`, "utf8");
}

function forward({ upstream, request, raw, response }) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers.host = upstream.host;
  const requestImpl = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const ahead = requestImpl(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: request.url,
      headers,
    },
    (answer) => {
      const answered = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        answered[name] = value;
      }
      response.writeHead(answer.statusCode ?? 502, answered);
      // Streamed, never buffered: a turn's first token is only as early as the bytes this hands over,
      // and a proxy that waited for `end` would give every turn a first-token of its total duration.
      answer.pipe(response);
    },
  );
  // A proxy that cannot reach its upstream must fail the request it was given, not answer it from
  // itself: the product's turn has to fail visibly rather than read a reply no model produced.
  ahead.on("error", (error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { type: "recording_proxy_upstream_unreachable", message: String(error?.message ?? error).slice(0, 200) },
      }),
    );
  });
  if (raw.length > 0) ahead.write(raw);
  ahead.end();
}
