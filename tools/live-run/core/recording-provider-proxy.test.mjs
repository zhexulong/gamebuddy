/*
 * red-proof: these tests were run against a deliberately broken proxy before they were accepted.
 *
 *   attribution by arrival order   keying each record by its index instead of its own headers reddens
 *                                  "two turns are recorded under their own ids, in arrival order" and
 *                                  "a request that names no turn is recorded with no identity".
 *   a mirrored header name that drifted
 *                                  renaming PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME in the Host reddens
 *                                  "the names this kit reads are the ones the Host stamps".
 *   a document instead of appends dropping `source` from a line reddens "the reader reads the lines this
 *                                  writer appends"; buffering the reply reddens "the reply streams through".
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME,
  PROVIDER_TURN_HEADER_NAME,
  RECORDING_PROXY_CAPTURE_SOURCE,
  startRecordingProviderProxy,
} from "./recording-provider-proxy.mjs";
import observation from "../frontend/capture/observation.cjs";

const { injectionFacts, readCapturedRequests } = observation;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "wire-proxy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** An upstream that answers with a body of its own, so a reply the proxy invented cannot be mistaken for it. */
async function fakeUpstream(t) {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "fake-upstream-reply", path: request.url }));
    });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  t.after(() => new Promise((closed) => server.close(closed)));
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

const post = (baseUrl, { turnId = null, idempotencyKey = null }, body) =>
  fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(turnId === null ? {} : { [PROVIDER_TURN_HEADER_NAME]: turnId }),
      ...(idempotencyKey === null ? {} : { [PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey }),
    },
    body: JSON.stringify(body),
  });

const bodyFor = (line) => ({
  model: "m",
  messages: [{ role: "system", content: `<gamebuddy-authored-context>${line}</gamebuddy-authored-context>` }],
});

const linesOf = async (capturePath) =>
  (await readFile(capturePath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

test("the names this kit reads are the ones the Host stamps", () => {
  const declaration = readFileSync(join(REPO, "host", "src", "provider-turn-header.internal.ts"), "utf8");
  const declared = (name) => {
    const match = new RegExp(`export const ${name} = "([^"]+)"`, "u").exec(declaration);
    assert.ok(match !== null, `the Host still declares ${name}; a reader cannot mirror what it cannot find`);
    return match[1];
  };
  assert.equal(
    PROVIDER_TURN_HEADER_NAME,
    declared("PROVIDER_TURN_HEADER_NAME"),
    "the kit's mirror of the Host's turn header drifted: every body would then be recorded with no turn id",
  );
  assert.equal(
    PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME,
    declared("PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME"),
    "the submission key is the only identity a page's own marks share with the wire; a drifted name records every body unjoinable",
  );
});

test("the request reaches the real endpoint unchanged and its own answer comes back", async (t) => {
  const upstream = await fakeUpstream(t);
  const dir = await scratch(t);
  const proxy = await startRecordingProviderProxy({
    upstreamBaseUrl: upstream.baseUrl,
    capturePath: join(dir, "wire.jsonl"),
  });
  t.after(() => proxy.close());

  const answer = await post(proxy.baseUrl, { turnId: "turn-1", idempotencyKey: "key-1" }, bodyFor("hello"));
  assert.equal(answer.status, 201, "the client sees the upstream's status, not one this proxy chose");
  assert.deepEqual(
    await answer.json(),
    { object: "fake-upstream-reply", path: "/v1/chat/completions" },
    "the client sees the upstream's own body: the run must measure a real reply",
  );
  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].method, "POST");
  assert.equal(upstream.seen[0].url, "/v1/chat/completions", "the base URL's own path travels with the request");
  assert.deepEqual(
    JSON.parse(upstream.seen[0].body),
    bodyFor("hello"),
    "the upstream receives the body that was posted",
  );
});

test("the reply streams through: the first chunk arrives while the upstream is still writing", async (t) => {
  const GAP_MS = 400;
  const server = createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", async () => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write('data: {"delta":"first"}\n\n');
      await sleep(GAP_MS);
      response.write('data: {"delta":"second"}\n\n');
      response.end();
    });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  t.after(() => new Promise((closed) => server.close(closed)));
  const dir = await scratch(t);
  const proxy = await startRecordingProviderProxy({
    upstreamBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    capturePath: join(dir, "wire.jsonl"),
  });
  t.after(() => proxy.close());

  const started = Date.now();
  const answer = await post(proxy.baseUrl, { turnId: "turn-1", idempotencyKey: "key-1" }, bodyFor("stream"));
  const reader = answer.body.getReader();
  const first = await reader.read();
  const firstArrivedMs = Date.now() - started;
  let all = Buffer.from(first.value ?? []).toString("utf8");
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    all += Buffer.from(chunk.value).toString("utf8");
  }
  assert.match(all, /first/u, "the whole reply still arrives");
  assert.match(all, /second/u, "the whole reply still arrives");
  assert.ok(
    firstArrivedMs < GAP_MS,
    `a proxy that buffered the reply would hand the first chunk over with the last: first chunk at ${firstArrivedMs}ms of a ${GAP_MS}ms gap`,
  );
});

test("two turns are recorded under their own ids, in arrival order", async (t) => {
  const upstream = await fakeUpstream(t);
  const dir = await scratch(t);
  const capturePath = join(dir, "wire.jsonl");
  const proxy = await startRecordingProviderProxy({ upstreamBaseUrl: upstream.baseUrl, capturePath });
  t.after(() => proxy.close());

  await post(proxy.baseUrl, { turnId: "turn-a", idempotencyKey: "key-a" }, bodyFor("first"));
  await post(proxy.baseUrl, { turnId: "turn-b", idempotencyKey: "key-b" }, bodyFor("second"));

  const records = await linesOf(capturePath);
  assert.deepEqual(
    records.map((record) => [
      record.turnId,
      record.idempotencyKey,
      record.body.messages[0].content.includes("first") ? "first" : "second",
    ]),
    [
      ["turn-a", "key-a", "first"],
      ["turn-b", "key-b", "second"],
    ],
    "each body is keyed by the headers that travelled with it, in the order it arrived",
  );
});

test("each request appends its own line, so a run killed mid-stream keeps what it already recorded", async (t) => {
  const upstream = await fakeUpstream(t);
  const dir = await scratch(t);
  const capturePath = join(dir, "wire.jsonl");
  const proxy = await startRecordingProviderProxy({ upstreamBaseUrl: upstream.baseUrl, capturePath });
  t.after(() => proxy.close());

  await post(proxy.baseUrl, { turnId: "turn-a", idempotencyKey: "key-a" }, bodyFor("first"));
  const afterFirst = await linesOf(capturePath);
  await post(proxy.baseUrl, { turnId: "turn-b", idempotencyKey: "key-b" }, bodyFor("second"));

  assert.equal(afterFirst.length, 1, "the first record is on disk before the second request arrives");
  assert.equal(
    afterFirst[0].source,
    RECORDING_PROXY_CAPTURE_SOURCE,
    "every line says which instance wrote it, so no reader inherits a source from another line",
  );
  assert.equal(afterFirst[0].upstreamBaseUrl, upstream.baseUrl, "each line names the endpoint it was forwarded to");
  assert.equal(typeof afterFirst[0].at, "string", "each line names when it arrived");
  assert.equal(afterFirst[0].path, "/v1/chat/completions", "each line names the path it was posted to");
  assert.equal((await linesOf(capturePath)).length, 2, "the second request adds a line instead of rewriting the file");
});

test("a request that names no turn is recorded with no identity", async (t) => {
  const upstream = await fakeUpstream(t);
  const dir = await scratch(t);
  const capturePath = join(dir, "wire.jsonl");
  const proxy = await startRecordingProviderProxy({ upstreamBaseUrl: upstream.baseUrl, capturePath });
  t.after(() => proxy.close());

  await post(proxy.baseUrl, { turnId: "turn-a", idempotencyKey: "key-a" }, bodyFor("labelled"));
  await post(proxy.baseUrl, {}, { model: "m", messages: [{ role: "user", content: "no turn header" }] });

  const records = await linesOf(capturePath);
  assert.equal(records.length, 2);
  assert.equal(records[0].turnId, "turn-a");
  assert.equal(
    records[1].turnId,
    null,
    "a request with no header belongs to no turn: inheriting the previous id is the misattribution this replaces",
  );
  assert.equal(
    records[1].idempotencyKey,
    null,
    "and no key either: an empty string would be an identity that matches nothing",
  );
});

test("the reader reads the lines this writer appends, and joins them to a page's own turn keys", async (t) => {
  const upstream = await fakeUpstream(t);
  const dir = await scratch(t);
  const capturePath = join(dir, "wire.jsonl");
  const proxy = await startRecordingProviderProxy({ upstreamBaseUrl: upstream.baseUrl, capturePath });
  t.after(() => proxy.close());

  await post(proxy.baseUrl, { turnId: "turn_a", idempotencyKey: "key-a" }, bodyFor("a fact only this turn sent"));
  await post(proxy.baseUrl, { turnId: "turn_b", idempotencyKey: "key-b" }, bodyFor("a different turn"));

  const captured = readCapturedRequests(capturePath);
  assert.equal(captured.ok, true, "the reader accepts the file this writer appends");
  assert.equal(captured.source, RECORDING_PROXY_CAPTURE_SOURCE);
  const injection = await injectionFacts(captured, ["key-b", "key-missing"]);
  assert.equal(injection.ok, true);
  assert.deepEqual(
    injection.turns.map((turn) => [turn.turnId, turn.authoredContext.present]),
    [["key-b", true]],
    "the turn a driver observed is read from the body its own submission key names; the one it did not observe is reported missing",
  );
  assert.deepEqual(injection.missing, ["key-missing"]);
  assert.equal(
    injection.foreign,
    1,
    "the other turn's record is counted as another driver's, never shown as this one's",
  );
});
