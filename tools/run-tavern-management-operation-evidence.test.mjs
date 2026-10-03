import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The producer is a live harness: it mounts the real generation and drives the
// real loopback API, so it cannot be unit-tested end to end. What CAN be tested
// without a run is the property that makes its output trustworthy at all - that
// every operation it reports carries a postcondition stronger than "the request
// returned 2xx". A producer that accepted any parseable reply would report 14
// passes for a surface where nothing was stored, which is the hollow-success
// shape the whole gate exists to catch.
//
// These are deliberately structural assertions over the producer source: the
// alternative is no regression net at all for the file that manufactures the
// release evidence.

const SOURCE = readFileSync("tools/run-tavern-management-operation-evidence.mjs", "utf8");

/** The body of one `await attempt("<operationId>", async () => { ... });` block. */
function attemptBody(operationId) {
  const marker = `await attempt("${operationId}", async () => {`;
  const start = SOURCE.indexOf(marker);
  assert.notEqual(start, -1, `${operationId} must be exercised by the producer`);
  const open = SOURCE.indexOf("{", start + marker.length - 1);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "{") depth += 1;
    else if (SOURCE[i] === "}") {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(open, i + 1);
    }
  }
  throw new Error(`${operationId} block is unterminated`);
}

const ALL_OPERATIONS = [
  "draft.save",
  "draft.discard",
  "chat.rename",
  "memory.mutate",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
  "settings.voice.devices",
  "settings.connection.read",
  "settings.connection.create",
  "settings.connection.test",
  "settings.connection.activate",
  "settings.connection.model",
  "settings.connection.remove",
  "companion.list",
  "companion.detail",
  "companion.create",
  "persona.read",
  "persona.update",
  "scenario.read",
  "scenario.update",
  "greeting.read",
  "greeting.update",
  "chat.archive",
  "chat.restore",
  "chat.trash",
];

test("the producer exercises every operation the mounted profile declares", async () => {
  const { readMountedTavernManagementProfile } = await import(
    "./lib/tavern-mounted-operation-vocabulary.mjs"
  );
  const declared = readMountedTavernManagementProfile().operationIds;
  assert.deepEqual([...declared].sort(), [...ALL_OPERATIONS].sort());
  for (const operationId of declared) attemptBody(operationId);
});

test("no operation is reported as passed on the strength of a 2xx alone", () => {
  // Every block must assert something about the REPLY, not only that the call
  // resolved. `sendJson` already throws on a non-2xx, so a block whose only
  // statement is the request would report a pass for a no-op server.
  for (const operationId of ALL_OPERATIONS) {
    const body = attemptBody(operationId);
    const assertions = [...body.matchAll(/throw new Error\("([a-z0-9_]+)"\)/g)].map((m) => m[1]);
    assert.ok(
      assertions.length > 0,
      `${operationId} asserts nothing about the response: ${body.slice(0, 120)}`,
    );
  }
});

test("the writes assert their durable effect, not only the reply shape", () => {
  // Revision advance proves a mutation really happened; a write that asserts
  // only the shape of the reply would pass against a server that returned the
  // input unchanged.
  const mustAdvanceRevision = [
    "settings.voice.consent",
    "settings.connection.create",
    "settings.connection.test",
    "settings.connection.model",
    "world-info.bind",
  ];
  for (const operationId of mustAdvanceRevision) {
    const body = attemptBody(operationId);
    assert.match(
      body,
      /revision/,
      `${operationId} must assert the revision it advanced`,
    );
    assert.match(
      body,
      /(unadvanced|revision_unavailable|revision_missing)/,
      `${operationId} must fail when the revision did not advance`,
    );
  }
});

test("the probe refuses a not-configured outcome as evidence", () => {
  // connection-probe.ts issues no request when no key is configured and returns
  // failed/not_configured. Counting that as this operation's pass would make the
  // operation vacuous, so the producer must reject it explicitly.
  const body = attemptBody("settings.connection.test");
  assert.match(body, /not_configured/, "a skipped probe must not count as a pass");
  assert.match(body, /revision_unadvanced|revision_unavailable/, "the probe write must be checked");
});

test("the producer exits non-zero when nothing passed", () => {
  // It writes the outcomes file either way - that records what happened - but a
  // caller reading only the exit status must not see success from a run that
  // produced no evidence.
  assert.match(SOURCE, /if \(passed === 0\) process\.exitCode = 1;/);
});

test("the producer's CLI entry compares against fileURLToPath", () => {
  // `new URL(import.meta.url).pathname` yields /E:/... on Windows while argv[1]
  // is E:\..., so a guard written that way never fires and the tool exits 0
  // having done nothing.
  assert.match(SOURCE, /process\.argv\[1\] === fileURLToPath\(import\.meta\.url\)/);
  assert.doesNotMatch(SOURCE, /new URL\(import\.meta\.url\)\.pathname/);
});

test("the world-info coverage boundary is recorded, not hidden", () => {
  // No world-info authoring route exists, so a fresh root cannot produce a
  // bindable handle and the only reachable command is sourceHandle: null. The
  // producer must say so, because the operation still reports `passed` and a
  // reader would otherwise take it as evidence for the bind path.
  const body = attemptBody("world-info.bind");
  assert.match(body, /COVERAGE BOUNDARY/);
  assert.match(body, /bindExact/, "the uncovered path must be named");
  assert.match(body, /sourceHandle: null/);
});
