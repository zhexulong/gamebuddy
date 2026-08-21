import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyStatus,
  createReferencePipelineSession,
  pendingSubmission,
  ReferencePipelineSessionError,
} from "../src/reference-pipeline-session.ts";

const PROFILE = "gamebuddy.chat-core.reference-pipeline";
const KEY = "ABEiM0RVZneImaq7zN3u_w"; // canonical 22-char unpadded base64url

function makeSnapshot(overrides = {}) {
  const snapshot = {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: PROFILE },
    csrfToken: "C".repeat(43),
    browserSession: { expiresAtMs: 0 },
    operations: [
      { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "messages" },
    ],
    navigation: [],
    selection: { chatHandle: "chat-handle-1", generation: 3, stateRevision: "state-rev-1" },
    chat: {
      companion: { name: "Mira" },
      title: null,
      transcript: [],
      draft: { revision: 7, present: true },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: { epoch: "E".repeat(43), cursor: "A".repeat(43) },
  };
  return applyOverrides(snapshot, overrides);
}

function applyOverrides(snapshot, overrides) {
  const next = structuredClone(snapshot);
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      next[key] !== null &&
      typeof next[key] === "object" &&
      !Array.isArray(next[key])
    ) {
      next[key] = { ...next[key], ...value };
    } else {
      next[key] = value;
    }
  }
  return next;
}

function assertRejected(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ReferencePipelineSessionError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test("bootstrap records the active identity and rejects absent or malformed identities", () => {
  const snapshot = makeSnapshot();
  const session = createReferencePipelineSession(snapshot);
  assert.deepEqual(session.snapshot, snapshot);
  assert.equal(session.pending, null);
  assert.ok(Object.isFrozen(session));

  const invalid = [
    ["null snapshot", null],
    ["non-object snapshot", "snapshot"],
    ["wrong apiVersion", makeSnapshot({ apiVersion: 2 })],
    ["missing build", makeSnapshot({ build: undefined })],
    ["foreign browser contract", makeSnapshot({ build: { browserContract: "tavern_browser_api/v999" } })],
    ["empty profileId", makeSnapshot({ build: { profileId: "" } })],
    ["null selection", makeSnapshot({ selection: null })],
    ["absent selection", makeSnapshot({ selection: undefined })],
    ["empty chatHandle", makeSnapshot({ selection: { chatHandle: "" } })],
    ["zero generation", makeSnapshot({ selection: { generation: 0 } })],
    ["fractional generation", makeSnapshot({ selection: { generation: 2.5 } })],
    ["string generation", makeSnapshot({ selection: { generation: "3" } })],
    ["empty stateRevision", makeSnapshot({ selection: { stateRevision: "" } })],
    ["selection without stateRevision", { ...makeSnapshot(), selection: { chatHandle: "chat-handle-1", generation: 3 } }],
  ];
  for (const [, value] of invalid) {
    assertRejected(() => createReferencePipelineSession(value), "state_reconciliation_required");
  }
});

test("applySnapshot atomically replaces the snapshot only for the exact same mounted identity", () => {
  const initial = makeSnapshot();
  const session = createReferencePipelineSession(initial);

  const next = makeSnapshot({
    csrfToken: "D".repeat(43),
    chat: {
      title: "Changed title",
      transcript: [
        { handle: "m-1", role: "companion", text: "A newer durable opening.", locale: "und", order: 0, revision: 1 },
      ],
      draft: { revision: 2, present: true },
      turn: { handle: "t-1", state: "queued", projectionRevision: 1, canCancel: false },
    },
  });
  const updated = session.applySnapshot(next);
  assert.notEqual(updated, session);
  assert.equal(updated.snapshot, next, "same (frozen) snapshot object, atomically mounted");
  assert.deepEqual(updated.snapshot, next);
  assert.deepEqual(updated.snapshot.chat.transcript, next.chat.transcript);
  // the prior session and its snapshot are untouched
  assert.deepEqual(session.snapshot, initial);
  assert.equal(session.pending, null);
  assert.notEqual(session.snapshot, updated.snapshot);

  // csrf/transcript/turn are NOT part of the identity fingerprint
  const csrfChanged = session.applySnapshot(makeSnapshot({ csrfToken: "X".repeat(43) }));
  assert.equal(csrfChanged.snapshot.csrfToken, "X".repeat(43));

  // any selection identity change is a different mount
  assertRejected(() => session.applySnapshot(makeSnapshot({ selection: { stateRevision: "state-rev-2" } })), "state_reconciliation_required");
  assertRejected(() => session.applySnapshot(makeSnapshot({ selection: { generation: 9 } })), "state_reconciliation_required");
  assertRejected(
    () => session.applySnapshot(makeSnapshot({ selection: { chatHandle: "chat-handle-2" } })),
    "state_reconciliation_required",
  );
  // profile identity change is a different mount
  assertRejected(() => session.applySnapshot(makeSnapshot({ build: { profileId: "gamebuddy.chat-core.p3" } })), "state_reconciliation_required");
  // a snapshot without an active identity can never replace the mount
  assertRejected(() => session.applySnapshot(makeSnapshot({ selection: null })), "state_reconciliation_required");
  assertRejected(() => session.applySnapshot(null), "state_reconciliation_required");
});

test("identity mismatch preserves all prior state including pending", () => {
  const session = createReferencePipelineSession(makeSnapshot());
  const pending = pendingSubmission(KEY, session.snapshot);
  const withPending = session.withPending(pending);
  assert.equal(withPending.pending, pending);

  assertRejected(
    () => withPending.applySnapshot(makeSnapshot({ selection: { generation: 4 } })),
    "state_reconciliation_required",
  );
  // nothing was replaced or cleared: snapshot and pending stay by reference
  assert.equal(withPending.snapshot, session.snapshot);
  assert.equal(withPending.pending, pending);
  assert.deepEqual(withPending.snapshot, makeSnapshot());

  // malformed replacements cannot clear pending either
  assertRejected(() => withPending.applySnapshot(null), "state_reconciliation_required");
  assert.equal(withPending.pending, pending);
});

test("pending submission is content-free with exactly the frozen enumerable keys", () => {
  const snapshot = makeSnapshot();
  const pending = pendingSubmission(KEY, snapshot);

  assert.deepEqual(Object.keys(pending).sort(), [
    "expectedDraftRevision",
    "idempotencyKey",
    "selectionGeneration",
    "stateRevision",
  ]);
  assert.equal(Object.keys(pending).length, 4);
  assert.equal(pending.idempotencyKey, KEY);
  assert.equal(pending.selectionGeneration, snapshot.selection.generation);
  assert.equal(pending.stateRevision, snapshot.selection.stateRevision);
  assert.equal(pending.expectedDraftRevision, snapshot.chat.draft.revision);
  assert.ok(Object.isFrozen(pending));

  // an explicit expectedDraftRevision overrides the snapshot draft revision
  const explicit = pendingSubmission(KEY, snapshot, 11);
  assert.equal(explicit.expectedDraftRevision, 11);

  // malformed correlations are rejected
  for (const badKey of ["", "short", "A".repeat(21), "A".repeat(23), "A".repeat(22) + "!", "A".repeat(11) + "!" + "A".repeat(10)]) {
    assertRejected(() => pendingSubmission(badKey, snapshot), "invalid_request");
  }
  assertRejected(() => pendingSubmission(KEY, snapshot, -1), "invalid_request");
  assertRejected(() => pendingSubmission(KEY, snapshot, 1.5), "invalid_request");
});

test("pending creation rejects an unavailable or busy submit operation and nonavailable state", () => {
  const snapshot = makeSnapshot();
  const submitOp = { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "messages" };

  // absent submit operation
  assertRejected(() => pendingSubmission(KEY, makeSnapshot({ operations: [] })), "profile_operation_unavailable");
  assertRejected(
    () =>
      pendingSubmission(
        KEY,
        makeSnapshot({
          operations: [
            { operationId: "draft.save", labelKey: "tavern.operation.draft.save", availability: "available", routeId: "draft" },
          ],
        }),
      ),
    "profile_operation_unavailable",
  );
  // unavailable submit operation
  assertRejected(
    () => pendingSubmission(KEY, makeSnapshot({ operations: [{ ...submitOp, availability: "unavailable" }] })),
    "profile_operation_unavailable",
  );
  // busy submit operation (non-terminal turn in flight)
  assertRejected(
    () => pendingSubmission(KEY, makeSnapshot({ operations: [{ ...submitOp, availability: "busy" }] })),
    "turn_busy",
  );
  // nonavailable state / no active identity
  assertRejected(() => pendingSubmission(KEY, makeSnapshot({ chat: null })), "state_reconciliation_required");
  assertRejected(() => pendingSubmission(KEY, makeSnapshot({ selection: null })), "state_reconciliation_required");
  assertRejected(() => pendingSubmission(KEY, makeSnapshot({ selection: { generation: 0 } })), "state_reconciliation_required");
  assert.equal(snapshot.selection.generation, 3, "fixture sanity");
});

test("applyEvent accepts ordered same-epoch events, ignores duplicates, and fails closed on gaps or resync", () => {
  const session = createReferencePipelineSession(makeSnapshot());
  const event = (sequence, overrides = {}) => ({
    apiVersion: 1,
    epoch: "E".repeat(43),
    sequence,
    selectionGeneration: 3,
    eventType: "draft.changed",
    payload: { revision: sequence, present: true },
    ...overrides,
  });
  const first = session.applyEvent(event(1));
  assert.equal(first, first.applyEvent(event(1)));
  const second = first.applyEvent(event(2));
  assertRejected(() => second.applyEvent(event(4)), "stream_resync_required");
  assertRejected(() => second.applyEvent(event(3, { epoch: "F".repeat(43) })), "stream_resync_required");
  assertRejected(() => second.applyEvent(event(3, { eventType: "stream.resync_required", payload: { reason: "gap" } })), "stream_resync_required");
});

test("a valid event with a different selectionGeneration is a stream resync, never accepted, and recovery reset adopts the authoritative cursor", () => {
  const session = createReferencePipelineSession(makeSnapshot());
  const pending = pendingSubmission(KEY, session.snapshot);
  const withPending = session.withPending(pending);
  const event = (sequence, overrides = {}) => ({
    apiVersion: 1,
    epoch: "E".repeat(43),
    sequence,
    selectionGeneration: 3,
    eventType: "draft.changed",
    payload: { revision: sequence, present: true },
    ...overrides,
  });

  // schema-valid events that disagree with the mounted selection generation are
  // stream resync (stale or forged), never a state/identity switch
  assertRejected(() => withPending.applyEvent(event(1, { selectionGeneration: 4 })), "stream_resync_required");
  assertRejected(() => withPending.applyEvent(event(1, { selectionGeneration: 2 })), "stream_resync_required");
  assertRejected(() => withPending.applyEvent(event(1, { selectionGeneration: 4, epoch: "F".repeat(43) })), "stream_resync_required");

  // the original identity, snapshot and pending stay untouched by reference
  assert.equal(withPending.snapshot, session.snapshot);
  assert.equal(withPending.pending, pending);
  assert.deepEqual(withPending.snapshot, makeSnapshot());

  // a rejected event must not corrupt the volatile checkpoint: the next
  // correctly-generated event is still accepted in order
  const accepted = withPending.applyEvent(event(1));
  assert.equal(accepted.snapshot, session.snapshot);
  assert.equal(accepted.pending, pending);
  assertRejected(() => accepted.applyEvent(event(2, { selectionGeneration: 5 })), "stream_resync_required");
  const advanced = accepted.applyEvent(event(2));
  assert.equal(advanced.snapshot, session.snapshot);

  // recovery reset adopts the mounted snapshot's authoritative cursor and
  // accepts the next durable event in that epoch
  const recovered = advanced.resetEventCheckpoint();
  assert.equal(recovered.snapshot, session.snapshot);
  assert.equal(recovered.pending, pending);
  assert.equal(recovered.applyEvent(event(3)).snapshot, session.snapshot);

  // an authoritative /state snapshot with the same identity but a fresh
  // authoritative cursor is adoptable; the stale epoch is then rejected
  const authoritative = makeSnapshot({ eventStream: { epoch: "F".repeat(43), cursor: "B".repeat(43) } });
  const reanchored = recovered.applySnapshot(authoritative).resetEventCheckpoint();
  assertRejected(() => reanchored.applyEvent(event(1, { epoch: "E".repeat(43) })), "stream_resync_required");
  const inNewEpoch = reanchored.applyEvent(event(1, { epoch: "F".repeat(43) }));
  assert.equal(inNewEpoch.snapshot, authoritative);
});

test("resetEventCheckpoint allows authoritative snapshot recovery to accept the next event", () => {
  const session = createReferencePipelineSession(makeSnapshot());
  const event = (sequence) => ({
    apiVersion: 1,
    epoch: "E".repeat(43),
    sequence,
    selectionGeneration: 3,
    eventType: "draft.changed",
    payload: { revision: sequence, present: true },
  });
  const checkpointed = session.applyEvent(event(1));
  assertRejected(() => checkpointed.applyEvent(event(3)), "stream_resync_required");
  const recovered = checkpointed.resetEventCheckpoint();
  assert.equal(recovered.snapshot, checkpointed.snapshot);
  assert.equal(recovered.applyEvent(event(1)).snapshot, recovered.snapshot);
  assert.equal(recovered.applyEvent(event(1)).pending, null);
  assert.equal(recovered.applyEvent(event(2)).snapshot, recovered.snapshot);
});

test("applyStatus preserves pending except for a terminal disposition and never mutates snapshot or turn", () => {
  const session = createReferencePipelineSession(makeSnapshot());
  const pending = pendingSubmission(KEY, session.snapshot);
  const committedResult = {
    apiVersion: 1,
    disposition: "accepted",
    message: { handle: "m-1", role: "player", text: "Hello", locale: "und", order: 1, revision: 1 },
    turn: { handle: "t-1", state: "queued", projectionRevision: 1, canCancel: false },
  };

  for (const disposition of ["unknown", "pending", "accepted", "expired"]) {
    const result = applyStatus(pending, { apiVersion: 1, disposition });
    assert.equal(result.pending, pending, `${disposition} preserves the exact pending record`);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(Object.keys(result), ["pending"]);
  }

  // only a terminal disposition clears
  const terminal = applyStatus(pending, { apiVersion: 1, disposition: "terminal", committedResult });
  assert.equal(terminal.pending, null);

  // a null pending stays null either way
  assert.equal(applyStatus(null, { apiVersion: 1, disposition: "accepted" }).pending, null);
  assert.equal(applyStatus(null, { apiVersion: 1, disposition: "terminal" }).pending, null);

  // snapshot and turn are never read or mutated from a status result
  const before = session.snapshot;
  assert.equal(session.pending, null);
  applyStatus(pending, { apiVersion: 1, disposition: "terminal", committedResult });
  assert.equal(session.snapshot, before);
  assert.equal(session.pending, null);
  assert.equal(session.snapshot.chat.turn, null);

  // malformed statuses fail closed without clearing
  for (const bad of [null, "terminal", { disposition: "terminal" }, { apiVersion: 2, disposition: "terminal" }, { apiVersion: 1, disposition: "bogus" }]) {
    assertRejected(() => applyStatus(pending, bad), "state_reconciliation_required");
  }
});

test("withPending sets and clears the pending record immutably", () => {
  const session = createReferencePipelineSession(makeSnapshot());
  const pending = pendingSubmission(KEY, session.snapshot);

  const withPending = session.withPending(pending);
  assert.equal(withPending.pending, pending);
  assert.equal(session.pending, null);
  assert.notEqual(withPending, session);
  assert.equal(withPending.snapshot, session.snapshot);

  const cleared = withPending.withPending(null);
  assert.equal(cleared.pending, null);
  assert.equal(withPending.pending, pending);
  assert.equal(cleared.snapshot, withPending.snapshot);

  // malformed or enlarged pending records are rejected fail-closed
  assertRejected(
    () => session.withPending({ idempotencyKey: KEY, selectionGeneration: 3, stateRevision: "state-rev-1" }),
    "state_reconciliation_required",
  );
  assertRejected(
    () =>
      session.withPending({
        idempotencyKey: KEY,
        selectionGeneration: 3,
        stateRevision: "state-rev-1",
        expectedDraftRevision: 7,
        text: "must never live in pending",
      }),
    "state_reconciliation_required",
  );
  assertRejected(() => session.withPending({ ...pending, idempotencyKey: "not-a-key" }), "state_reconciliation_required");
});

test("every value and output is frozen and immutable", () => {
  const snapshot = makeSnapshot({
    chat: {
      transcript: [
        { handle: "m-1", role: "companion", text: "A durable opening.", locale: "und", order: 0, revision: 1 },
      ],
    },
  });
  const session = createReferencePipelineSession(snapshot);
  assert.ok(Object.isFrozen(session));
  assert.ok(Object.isFrozen(session.snapshot));
  assert.ok(Object.isFrozen(session.snapshot.build));
  assert.ok(Object.isFrozen(session.snapshot.selection));
  assert.ok(Object.isFrozen(session.snapshot.operations));
  assert.ok(Object.isFrozen(session.snapshot.operations[0]));
  assert.ok(Object.isFrozen(session.snapshot.chat));
  assert.ok(Object.isFrozen(session.snapshot.chat.transcript));
  assert.ok(Object.isFrozen(session.snapshot.chat.transcript[0]));

  // strict-mode mutation attempts on frozen state throw
  assert.throws(() => {
    session.snapshot.chat.title = "hacked";
  }, TypeError);
  assert.throws(() => {
    session.snapshot.chat.transcript.push({});
  }, TypeError);
  assert.throws(() => {
    session.snapshot.selection.generation = 99;
  }, TypeError);

  const pending = pendingSubmission(KEY, session.snapshot);
  assert.ok(Object.isFrozen(pending));
  const held = session.withPending(pending);
  assert.ok(Object.isFrozen(held.pending));
  assert.throws(() => {
    held.pending.idempotencyKey = "changed";
  }, TypeError);

  const result = applyStatus(pending, { apiVersion: 1, disposition: "accepted" });
  assert.ok(Object.isFrozen(result));
  assert.throws(() => {
    result.pending = null;
  }, TypeError);
});

test("the reducer module is self-contained: no imports, network, storage, timers or host references", async () => {
  const source = await readFile(new URL("../src/reference-pipeline-session.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bimport\b/, "module must not import anything");
  assert.doesNotMatch(source, /from\s+["']host\//, "module must not reference host modules");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "no network");
  assert.doesNotMatch(
    source,
    /sessionStorage|localStorage|EventSource|XMLHttpRequest|WebSocket|setTimeout|setInterval|crypto\./,
    "no storage, SSE, timers or crypto",
  );
});
