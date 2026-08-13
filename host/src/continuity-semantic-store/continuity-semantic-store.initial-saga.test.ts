import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { openContinuitySemanticStore, type AuthenticatedContinuityPrincipal } from "./continuity-semantic-store.js";
import { createQuiescentLegacyContinuitySnapshot } from "../continuity-production-migration/continuity-production-migration.js";

const principal: AuthenticatedContinuityPrincipal = {
  continuityId: "continuity1",
  companionId: "companion1",
  playerId: "player1",
};
const digest = "a".repeat(64);
const content = "b".repeat(64);
function h() {
  const root = mkdtempSync(`${tmpdir()}/initial-saga-`);
  const store = openContinuitySemanticStore({ runtimeRoot: root, nowMs: () => 100 });
  store.adoptLegacyPartition(
    createQuiescentLegacyContinuitySnapshot({
      continuityId: principal.continuityId,
      companionId: principal.companionId,
      playerId: principal.playerId,
      legacyLedger: {
        schemaVersion: 3,
        continuityId: principal.continuityId,
        companionId: principal.companionId,
        playerId: principal.playerId,
        sessions: [],
        events: [],
      },
      chatThreads: [],
      activeSelections: [],
      gameOwner: null,
    } as never),
  );
  return {
    root,
    store,
    close() {
      try {
        store.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function code(fn: () => unknown, c: string) {
  assert.throws(
    fn,
    (e: unknown) => typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === c,
  );
}
function claim(x: ReturnType<typeof h>) {
  return x.store.claimInitialChatSaga({
    principal,
    sagaId: "saga1",
    payloadDigest: digest,
    expectedPartitionRevision: 1,
    expectedFenceEpoch: 1,
  });
}
test("initial saga claims only empty catalog, reopens, and exact replay is stable", () => {
  const x = h();
  try {
    const first = claim(x);
    assert.equal(first.phase, "claimed_empty");
    assert.deepEqual(claim(x), first);
    x.store.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: x.root });
    assert.deepEqual(reopened.readInitialChatSaga({ principal, sagaId: "saga1" }), first);
    reopened.close();
  } finally {
    x.close();
  }
});
test("initial saga enforces one holder and exact payload", () => {
  const x = h();
  try {
    claim(x);
    code(
      () =>
        x.store.claimInitialChatSaga({
          principal,
          sagaId: "saga2",
          payloadDigest: digest,
          expectedPartitionRevision: 2,
          expectedFenceEpoch: 2,
        }),
      "operation_payload_conflict",
    );
    code(
      () =>
        x.store.claimInitialChatSaga({
          principal,
          sagaId: "saga1",
          payloadDigest: content,
          expectedPartitionRevision: 2,
          expectedFenceEpoch: 2,
        }),
      "operation_payload_conflict",
    );
  } finally {
    x.close();
  }
});
test("initial saga phases reject out of order and stale vectors then persist terminal selection", () => {
  const x = h();
  try {
    const c = claim(x);
    code(
      () =>
        x.store.verifyInitialChatSagaContent({
          principal,
          sagaId: "saga1",
          payloadDigest: digest,
          claimToken: c.claimToken,
          contentBindingDigest: content,
        }),
      "lifecycle_transition_invalid",
    );
    code(
      () =>
        x.store.registerInitialChatSagaChat({
          principal,
          sagaId: "saga1",
          payloadDigest: digest,
          claimToken: c.claimToken,
          chatThreadId: "thread1",
          chatSurfaceSessionId: "chat1",
          expectedPartitionRevision: 1,
          expectedFenceEpoch: 2,
        }),
      "game_revision_conflict",
    );
    const registered = x.store.registerInitialChatSagaChat({
      principal,
      sagaId: "saga1",
      payloadDigest: digest,
      claimToken: c.claimToken,
      chatThreadId: "thread1",
      chatSurfaceSessionId: "chat1",
      expectedPartitionRevision: 2,
      expectedFenceEpoch: 2,
    });
    code(
      () =>
        x.store.selectInitialChatSagaChat({
          principal,
          sagaId: "saga1",
          payloadDigest: digest,
          claimToken: c.claimToken,
          chatThreadId: "thread1",
          chatSurfaceSessionId: "chat1",
          expectedPartitionRevision: 3,
          expectedSelectionRevision: 0,
          expectedFenceEpoch: 3,
        }),
      "lifecycle_transition_invalid",
    );
    const verified = x.store.verifyInitialChatSagaContent({
      principal,
      sagaId: "saga1",
      payloadDigest: digest,
      claimToken: c.claimToken,
      contentBindingDigest: content,
    });
    const terminal = x.store.selectInitialChatSagaChat({
      principal,
      sagaId: "saga1",
      payloadDigest: digest,
      claimToken: c.claimToken,
      chatThreadId: "thread1",
      chatSurfaceSessionId: "chat1",
      expectedPartitionRevision: 3,
      expectedSelectionRevision: 0,
      expectedFenceEpoch: 3,
    });
    assert.equal(registered.phase, "chat_registered");
    assert.equal(verified.phase, "content_verified");
    assert.equal(terminal.phase, "selected");
    assert.deepEqual(
      x.store.selectInitialChatSagaChat({
        principal,
        sagaId: "saga1",
        payloadDigest: digest,
        claimToken: c.claimToken,
        chatThreadId: "thread1",
        chatSurfaceSessionId: "chat1",
        expectedPartitionRevision: 4,
        expectedSelectionRevision: 1,
        expectedFenceEpoch: 4,
      }),
      terminal,
    );
    x.store.close();
    const reopened = openContinuitySemanticStore({ runtimeRoot: x.root });
    assert.deepEqual(reopened.readInitialChatSaga({ principal, sagaId: "saga1" }), terminal);
    reopened.close();
  } finally {
    x.close();
  }
});
test("initial saga claim fails closed for nonempty catalog and wrong claim token", () => {
  const x = h();
  try {
    x.store.registerExactChat({
      principal,
      continuityId: "continuity1",
      companionId: "companion1",
      playerId: "player1",
      chatThreadId: "other",
      chatSurfaceSessionId: "otherchat",
      expectedPartitionRevision: 1,
      expectedFenceEpoch: 1,
      operationId: "existing",
    });
    code(
      () =>
        x.store.claimInitialChatSaga({
          principal,
          sagaId: "saga1",
          payloadDigest: digest,
          expectedPartitionRevision: 2,
          expectedFenceEpoch: 2,
        }),
      "lifecycle_transition_invalid",
    );
  } finally {
    x.close();
  }
  const y = h();
  try {
    const c = claim(y);
    code(
      () =>
        y.store.registerInitialChatSagaChat({
          principal,
          sagaId: "saga1",
          payloadDigest: digest,
          claimToken: "wrong",
          chatThreadId: "thread1",
          chatSurfaceSessionId: "chat1",
          expectedPartitionRevision: 2,
          expectedFenceEpoch: 2,
        }),
      "operation_payload_conflict",
    );
  } finally {
    y.close();
  }
});
