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
  "settings.language.read",
  "settings.language.update",
  "settings.connection.read",
  "settings.connection.create",
  "settings.connection.test",
  "settings.connection.activate",
  "settings.connection.model",
  "settings.connection.remove",
  "settings.profiles.read",
  "settings.profiles.update",
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
  "character.import.stage",
  "character.import.read",
  "character.import.review",
  "character.import.confirm",
  "character.import.history",
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
  // Revision advance proves a mutation really happened. The property that makes
  // the advance meaningful is WHERE it is checked: a write whose only revision
  // message comes from the read it CASed against passes against a server that
  // stored nothing, because that guard runs before the request is sent.
  // `settings.voice.consent` was exactly that - it read `revision`, sent the
  // PUT, and never looked at the reply - yet the previous version of this test
  // accepted it, because a body-wide match for `revision` and `unadvanced` was
  // satisfied by its PRE-write guard (`voice_revision_unavailable`).
  //
  // So every check below is scoped to what the operation asserts AFTER its
  // mutation request: `postWriteAssertions` names, per write, the codes that
  // may only be emitted once the write has answered - the applied value on the
  // reply and/or a read-back through the read route. Deleting any one of those
  // assertions (the usual way a write decays back into a 2xx check) fails here.
  const postWriteAssertions = {
    "settings.voice.consent": [
      "voice_consent_not_applied",
      "voice_consent_revision_unadvanced",
      "voice_consent_not_durable",
    ],
    "settings.connection.create": ["connection_create_not_stored", "connection_create_revision_unadvanced"],
    "settings.connection.test": ["connection_probe_revision_unadvanced"],
    "settings.connection.model": ["connection_model_not_applied", "connection_model_revision_unadvanced"],
    "settings.connection.remove": [
      "connection_remove_record_retained",
      "connection_remove_revision_unadvanced",
      "connection_remove_not_durable",
    ],
    "settings.profiles.update": ["profile_model_not_applied", "profile_revision_unadvanced"],
    "settings.language.update": [
      "language_locale_not_applied",
      "language_revision_unadvanced",
      "language_locale_not_durable",
    ],
    "world-info.bind": ["world_info_revision_unadvanced"],
  };
  for (const [operationId, codes] of Object.entries(postWriteAssertions)) {
    const body = attemptBody(operationId);
    // The mutation is the LAST request the block sends: everything the block
    // asserts after it is a statement about the state the write produced.
    const mutation = body.lastIndexOf("await sendJson(");
    assert.notEqual(mutation, -1, `${operationId} must issue its mutation through sendJson`);
    const afterMutation = body.slice(mutation);
    for (const code of codes) {
      assert.ok(
        afterMutation.includes(`throw new Error("${code}")`),
        `${operationId} must assert ${code} against the state after its write; guarding the revision it read before the write is not evidence it stored anything`,
      );
    }
    assert.match(afterMutation, /revision/, `${operationId} must assert the revision it advanced`);
    assert.match(
      afterMutation,
      /unadvanced/,
      `${operationId} must fail when the revision did not advance`,
    );
  }
});

test("the companion detail read asserts identity, not just a non-empty name", () => {
  // The detail route projects `apiVersion` + `name` only (CompanionDetailV1Schema:
  // "name only (companion-detail boundary)"), so the projected name is what has
  // to match the name the LIST attributed to the exact handle that was asked
  // for. A `name.length > 0` check passes for whatever companion the route felt
  // like answering with - a hollow pass for the read whose whole point is
  // resolving one exact companion.
  const body = attemptBody("companion.detail");
  assert.match(
    body,
    /companion_detail_identity_mismatch/,
    "companion.detail must reject a detail that is not the asked-for companion",
  );
  assert.match(
    body,
    /detail\.name !== current\.name/,
    "companion.detail must compare the name the list projected for that exact handle",
  );
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
