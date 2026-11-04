/*
 * The failure paths are the reason this module exists as its own unit: a recorder that cannot start must
 * leave the run measuring what it measured before, and must say by name that nothing is recorded. Both
 * readings are asserted here against the environment the launched child inherits, because a switch written
 * when no recorder is listening would point the whole run at a dead address.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { OPERATOR_GATEWAY_BASE_URL_VARIABLE } from "../../../lib/operator-gateway.mjs";
import { startWireCapture } from "./wire-capture.mjs";

const base = { artifactRoot: "C:/nowhere/artifact", capturePath: "C:/nowhere/wire.json" };

test("an unresolvable endpoint is a named absence and leaves the product on its own gateway", async () => {
  const env = {};
  const capture = await startWireCapture({
    ...base,
    env,
    readUpstream: () => Promise.reject(new Error("artifact_pointer_unreadable")),
  });
  assert.equal(capture.kind, "unavailable");
  assert.match(capture.reason, /^upstream_unresolved:.*artifact_pointer_unreadable/u);
  assert.deepEqual(env, {}, "no recorder is listening, so nothing may be pointed at one");
});

test("a recorder that cannot listen is a named absence, not a run that records nothing silently", async () => {
  const env = {};
  const capture = await startWireCapture({
    ...base,
    env,
    readUpstream: () => Promise.resolve("http://127.0.0.1:9/v1"),
    startProxy: () => Promise.reject(new Error("EADDRINUSE")),
  });
  assert.equal(capture.kind, "unavailable");
  assert.match(capture.reason, /^proxy_refused:.*EADDRINUSE/u);
  assert.deepEqual(env, {});
});

test("a started recorder becomes the address the launched child dials, in front of the one the product resolved", async () => {
  const env = {};
  const closed = [];
  const capture = await startWireCapture({
    ...base,
    env,
    readUpstream: () => Promise.resolve("http://127.0.0.1:9/v1"),
    startProxy: ({ upstreamBaseUrl, capturePath }) =>
      Promise.resolve({
        baseUrl: "http://127.0.0.1:54321/v1",
        upstreamBaseUrl,
        capturePath,
        close: () => {
          closed.push(capturePath);
        },
      }),
  });
  assert.equal(capture.kind, "recording");
  assert.equal(capture.upstreamBaseUrl, "http://127.0.0.1:9/v1");
  assert.equal(
    env[OPERATOR_GATEWAY_BASE_URL_VARIABLE],
    "http://127.0.0.1:54321/v1",
    "the child inherits this environment, so this is the switch that puts the recorder in the path",
  );
  await capture.close();
  assert.deepEqual(closed, [base.capturePath]);
});
