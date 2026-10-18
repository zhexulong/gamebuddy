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

/**
 * The producer's vocabulary is the MOUNTED PROFILE's, derived here rather than kept as a second
 * hand-written copy of it.
 *
 * That copy drifted twice in one night: `companion.detail` was deleted from the profile and stayed
 * in the list, and `chat.opening`/`chat.create`/`chat.select` and the world-book reads were declared
 * and missing from it. A list that has to be hand-edited to agree with the profile is the drift the
 * equality assertion was standing in front of, and editing it is also how the next operation gets
 * silently skipped. Both directions are checked below instead, so the only things that can fail are
 * a MISSING attempt block and a STALE one, each named by the operation it belongs to.
 */
const { readMountedTavernManagementProfile } = await import("./lib/tavern-mounted-operation-vocabulary.mjs");
const DECLARED_OPERATIONS = readMountedTavernManagementProfile().operationIds;

/** Every operation the producer actually exercises, read out of its own source. */
function attemptedOperations() {
  return [...SOURCE.matchAll(/await attempt\("([a-z][a-z0-9._-]*)"/g)].map((match) => match[1]);
}

/** The bounded machine codes one attempt block asserts about its own reply, or null when it has none. */
function assertedCodesOrNull(operationId) {
  if (!SOURCE.includes(`await attempt("${operationId}", async () => {`)) return null;
  return [...attemptBody(operationId).matchAll(/throw new Error\("([a-z0-9_]+)"\)/g)].map((match) => match[1]);
}

test("the producer exercises every operation the mounted profile declares", (t) => {
  // A declared operation with no attempt block leaves the release evidence claiming a surface
  // exists while nothing exercised it. The failure names the operation it is missing for.
  const missing = DECLARED_OPERATIONS.filter((operationId) => assertedCodesOrNull(operationId) === null);
  const attempted = attemptedOperations();
  t.diagnostic(
    `operation-evidence.1: ${DECLARED_OPERATIONS.length} operation(s) declared by the mounted profile, ${attempted.length} attempt block(s) in the producer, ${DECLARED_OPERATIONS.length - missing.length} covered, ${missing.length} missing`,
  );
  assert.deepEqual(missing, [], "every operation the mounted profile declares must be exercised by the producer");
});

test("the producer exercises nothing the mounted profile does not declare", (t) => {
  // The reverse direction, which is what the hand-written list used to catch and what no derived
  // comparison can: a block kept for an operation the profile no longer declares is a stale step
  // whose outcome would be reported for a surface that does not exist.
  const declared = new Set(DECLARED_OPERATIONS);
  const attempted = attemptedOperations();
  const stale = [...new Set(attempted.filter((operationId) => !declared.has(operationId)))];
  t.diagnostic(
    `operation-evidence.2: ${attempted.length} attempt block(s), ${attempted.length - stale.length} matching a declared operation, ${stale.length} stale`,
  );
  assert.deepEqual(stale, [], "a step must name an operation the mounted profile declares");
});

test("no operation is reported as passed on the strength of a 2xx alone", (t) => {
  // Every block must assert something about the REPLY, not only that the call
  // resolved. `sendJson` already throws on a non-2xx, so a block whose only
  // statement is the request would report a pass for a no-op server.
  const bare = [];
  for (const operationId of DECLARED_OPERATIONS) {
    const assertions = assertedCodesOrNull(operationId);
    if (assertions === null) continue;
    if (assertions.length === 0) bare.push(operationId);
  }
  t.diagnostic(
    `operation-evidence.3: ${DECLARED_OPERATIONS.length - bare.length} operation(s) assert at least one postcondition, ${bare.length} assert nothing`,
  );
  assert.deepEqual(bare, [], "an operation whose only statement is the request reports nothing as evidence");
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
    // The authoring writes: each code may only be emitted once the write has answered or
    // the item has been read back through the detail route.
    "world-info.create": ["world_info_create_revision_unadvanced", "world_info_item_not_created"],
    "world-info.update": [
      "world_info_update_revision_unadvanced",
      "world_info_item_revision_unadvanced",
      "world_info_update_not_applied",
      "world_info_update_not_durable",
    ],
    "world-info.delete": ["world_info_delete_revision_unadvanced", "world_info_item_not_removed"],
    // The companion directive is CASed on her profile revision; the edit must advance it and read
    // back through the read route.
    "character.voice.update": [
      "character_voice_profile_revision_unadvanced",
      "character_voice_not_applied",
      "character_voice_source_not_player",
      "character_voice_not_durable",
    ],
    // Her own world book is one durable file replaced whole, CASed on the revision the step read.
    // This step is the one write that sends TWO mutations - it puts a marked body in and then puts
    // her own body back - so the codes below are the ones asserted after its LAST request; the
    // advance from +1 to +2 is what proves the edit really landed in between, and the codes for the
    // edit itself (`worldbook_edit_not_applied`, `worldbook_edit_revision_unadvanced`) are asserted
    // against the reply and the read-back between the two writes.
    "companion.worldbook.update": ["worldbook_restore_not_applied", "worldbook_revision_unadvanced"],
  };
  // A write that belongs to no declared operation is a stale entry, exactly like a stale attempt
  // block: its codes would be checked against a surface the mounted profile does not serve.
  const undeclared = Object.keys(postWriteAssertions).filter(
    (operationId) => !DECLARED_OPERATIONS.includes(operationId),
  );
  assert.deepEqual(undeclared, [], "every write named here must be an operation the mounted profile declares");
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
    assert.match(afterMutation, /unadvanced/, `${operationId} must fail when the revision did not advance`);
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
  // This operation seeds no catalog, so on a fresh root it cannot produce a bindable
  // handle and the only command it sends is sourceHandle: null. The producer must say
  // so, because the operation still reports `passed` and a reader would otherwise take
  // it as evidence for the bound path.
  const body = attemptBody("world-info.bind");
  assert.match(body, /COVERAGE BOUNDARY/);
  assert.match(body, /bindExact/, "the uncovered path must be named");
  assert.match(body, /sourceHandle: null/);
});
