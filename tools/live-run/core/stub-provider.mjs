/**
 * The one local OpenAI-compatible endpoint a live run mounts when its subject is WHAT THE PRODUCT SENDS.
 *
 * A live run's claim is about the assembled request, not about a model's wording, and a commercial
 * provider can only answer the second question. Pointing the product's own escape-hatch provider at an
 * endpoint this process serves turns the first question into an observation: the request body Pi
 * actually posted is recorded here, so the run can measure the system prompt's bytes, the authored
 * baseline's bytes, the tool declarations and the message array on a real turn.
 *
 * What that trades away is stated by every caller in its own output, because it is the whole
 * qualification of the evidence: no model is called. A run that mounts this asserts what the product
 * sends, never what a model replies (`tools/live-run/README.md` §4 and §6).
 *
 * Two routes, and only the two a real endpoint must offer:
 *
 *   GET  <base>/models              the product's own liveness probe, answered with the one model id
 *   POST <base>/chat/completions    one fixed assistant reply, streamed in the shape Pi's
 *                                   `openai-completions` adapter parses, with every request recorded
 *
 * The `/models` route is not a convenience: it is what lets a caller record a `ready` connection
 * through the PRODUCT's probe and store instead of hand-writing a document the product would refuse.
 */

import { createServer } from "node:http";

/** The id every streamed chunk carries; fixed so a run's artifact never varies by transport detail. */
const STREAM_ID = "chatcmpl-live-stub";

/**
 * Start the endpoint on an ephemeral loopback port.
 *
 * `next()` hands out the recorded requests in arrival order and resolves immediately for one that has
 * already arrived, so a caller that starts a turn and then waits cannot miss the body it is waiting
 * for; `requests` is the whole log, for a reading taken after the last turn.
 *
 * Each record carries the request's headers beside its body, because a body alone cannot be attributed
 * to a turn: the Host names the turn on `X-GameBuddy-Turn-Id`, and a reader holding only bodies could
 * only count them in arrival order - which a probe, a retry or a second surface silently shifts.
 */
export async function startLocalStubProvider({ modelId, reply }) {
  if (typeof modelId !== "string" || modelId.length === 0) throw new Error("stub_provider_model_required");
  if (typeof reply !== "string" || reply.length === 0) throw new Error("stub_provider_reply_required");
  const requests = [];
  /** How many recorded requests a `next()` caller has already been handed. */
  let served = 0;
  const waiters = [];
  const deliver = () => {
    while (waiters.length > 0 && requests.length > served) {
      served += 1;
      waiters.shift()(requests[served - 1]);
    }
  };
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (request.method === "GET" && /\/models$/u.test(request.url ?? "")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ object: "list", data: [{ id: modelId, object: "model", owned_by: "live-run-stub" }] }),
        );
        return;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      requests.push(Object.freeze({ method: request.method, url: request.url, headers: { ...request.headers }, body }));
      deliver();
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({
        id: STREAM_ID,
        object: "chat.completion.chunk",
        model: modelId,
        choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
      });
      send({
        id: STREAM_ID,
        object: "chat.completion.chunk",
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  let closed = false;
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    modelId,
    requests,
    next: () =>
      new Promise((taken) => {
        waiters.push(taken);
        deliver();
      }),
    /** Idempotent: a caller that closes on both its refusal and its normal path calls it twice. */
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((closed_) => server.close(closed_));
    },
  });
}
