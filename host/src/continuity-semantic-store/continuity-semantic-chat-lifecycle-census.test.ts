import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import {
  openProductionContinuityStore,
  type ProductionBootstrapInput,
  type TavernExactContentReceipt,
} from "./continuity-semantic-production-store.js";

const principal = { continuityId: "continuity1", companionId: "companion1", playerId: "player1" } as const;
const bootstrap: ProductionBootstrapInput = {
  principal,
  bootstrapOperationId: "bootstrap1",
  authorityGeneration: 1,
  authorityRootIdentity: "a".repeat(64),
};
const holderBindingDigest = "b".repeat(64);
const runtimeBindingDigest = "d".repeat(64);
const runtimeOwner = Object.freeze({
  ownerToken: "owner-token",
  runtimeInstanceId: "runtime-1",
  ownerPid: process.pid,
  ownerProcessStartIdentity: "start-1",
});

/** ADR-0011's two gating questions, executed against the file rather than reported by the store. */
const LIFECYCLE_ROWS_QUERY = "SELECT lifecycle, COUNT(*) FROM production_continuity_thread GROUP BY lifecycle";
const LIFECYCLE_COMMANDS_QUERY =
  "SELECT COUNT(*) FROM production_continuity_command WHERE command_kind='transition_chat_lifecycle'";

function receiptFor(chatThreadId: string, chatSurfaceSessionId: string): TavernExactContentReceipt {
  return Object.freeze({
    chatThreadId,
    chatSurfaceSessionId,
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    digest: "c".repeat(64),
  });
}

/**
 * ADR-0011 deletes the semantic store's Chat lifecycle mirror, and its first precondition is that the
 * mirror is a write-once constant: the corpus holds only `active`, and no `transition_chat_lifecycle`
 * command was ever committed. A non-zero answer here means a caller nobody has seen writes the mirror,
 * and the deletion needs a data decision rather than a schema change.
 *
 * The corpus below is produced by driving every Chat writer the store publishes for a live Chat -
 * the initial-Chat saga, `register_chat`, `verify_chat_content`, `select_chat`, the recorded selection
 * intent, and a mount/teardown cycle. `transition_chat_lifecycle` is deliberately NOT driven: the
 * census is about what production writers leave behind, and that command's exclusion from production
 * is the fact under test. The answers are read back through a separate read-only connection, so the
 * counts are committed state and not anything the store reports about itself.
 */
test("the semantic corpus carries only an active lifecycle and no lifecycle command", () => {
  const root = canonicalTestRootSync("production-chat-lifecycle-census-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const claim = store.claim({
      holderBindingDigest,
      operationId: "claim-1",
      expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
    });
    const registered = store.register({ holderBindingDigest, operationId: "register-1", expected: claim.vector });
    const initialReceipt = receiptFor(registered.chatThreadId!, registered.chatSurfaceSessionId!);
    const verified = store.verify(
      { holderBindingDigest, operationId: "verify-1", expected: registered.vector },
      initialReceipt,
    );
    store.select({ holderBindingDigest, operationId: "select-1", expected: verified.vector });

    const second = Object.freeze({ chatThreadId: "chat-second", chatSurfaceSessionId: "surface-second" });
    store.registerChat(
      Object.freeze({ operationId: "register-chat-2", ...second, expected: { ...store.readChatCatalog().vector } }),
    );
    store.verifyChatContent(
      Object.freeze({ operationId: "verify-chat-2", ...second, expected: { ...store.readChatCatalog().vector } }),
      receiptFor(second.chatThreadId, second.chatSurfaceSessionId),
    );
    store.recordChatSelectionIntent(
      Object.freeze({
        intent: Object.freeze({ kind: "select" as const, ...second }),
        expected: { ...store.readChatCatalog().vector },
      }),
    );
    store.clearChatSelectionIntent(Object.freeze({ expected: { ...store.readChatCatalog().vector } }));
    store.selectChat(
      Object.freeze({ operationId: "select-chat-2", ...second, expected: { ...store.readChatCatalog().vector } }),
    );

    const prepared = store.prepareChatRuntime(
      Object.freeze({
        principal,
        operationId: "runtime-2",
        requestId: "runtime-request-2",
        ...second,
        runtimeBindingDigest,
        owner: runtimeOwner,
        deadlineAtMs: Date.now() + 60_000,
        expected: { ...store.readChatCatalog().vector },
      }),
    );
    assert.equal(prepared.outcome, "effect_owned");
    const permit = prepared.permit!;
    store.commitChatRuntime({
      principal,
      permit,
      receipt: Object.freeze({
        kind: "chat_runtime_bootstrapped" as const,
        operationId: permit.operationId,
        requestId: permit.requestId,
        chatThreadId: permit.chatThreadId,
        chatSurfaceSessionId: permit.chatSurfaceSessionId,
        runtimeBindingDigest: permit.runtimeBindingDigest,
        owner: Object.freeze({ ...permit.owner }),
        fenceToken: permit.fenceToken,
        occurredAtMs: Date.now(),
      }),
    });
    const teardown = store.prepareChatRuntimeTeardown({
      principal,
      operationId: "teardown-2",
      requestId: "teardown-request-2",
      bootstrapOperationId: "runtime-2",
      ...second,
      runtimeBindingDigest,
      owner: runtimeOwner,
      deadlineAtMs: Date.now() + 60_000,
      expected: { ...store.readChatCatalog().vector },
    });
    assert.equal(teardown.outcome, "effect_owned");
    const teardownPermit = teardown.permit!;
    store.commitChatRuntimeTeardown({
      principal,
      permit: teardownPermit,
      receipt: Object.freeze({
        kind: "chat_runtime_torn_down" as const,
        operationId: teardownPermit.operationId,
        requestId: teardownPermit.requestId,
        bootstrapOperationId: teardownPermit.bootstrapOperationId,
        chatThreadId: teardownPermit.chatThreadId,
        chatSurfaceSessionId: teardownPermit.chatSurfaceSessionId,
        runtimeBindingDigest: teardownPermit.runtimeBindingDigest,
        owner: Object.freeze({ ...teardownPermit.owner }),
        fenceToken: teardownPermit.fenceToken,
        occurredAtMs: Date.now(),
      }),
    });
    control.close();

    const db = new DatabaseSync(join(root, "gamebuddy-continuity-v1.sqlite"), { readOnly: true });
    try {
      const lifecycleRows = db.prepare(LIFECYCLE_ROWS_QUERY).all() as { lifecycle: string; "COUNT(*)": number }[];
      const lifecycleCommands = db.prepare(LIFECYCLE_COMMANDS_QUERY).get() as { "COUNT(*)": number };
      console.log(`census Q1: ${LIFECYCLE_ROWS_QUERY} -> ${JSON.stringify(lifecycleRows)}`);
      console.log(`census Q2: ${LIFECYCLE_COMMANDS_QUERY} -> ${lifecycleCommands["COUNT(*)"]}`);
      assert.deepEqual(
        lifecycleRows.map((row) => row.lifecycle),
        ["active"],
        "a Chat left the active lifecycle, so a production writer reaches the mirror",
      );
      assert.equal(
        lifecycleRows[0]!["COUNT(*)"],
        2,
        "the census must cover both Chats this corpus registers, or it measured an empty population",
      );
      assert.equal(
        lifecycleCommands["COUNT(*)"],
        0,
        "a transition_chat_lifecycle command was committed, so the mirror has a caller",
      );
    } finally {
      db.close();
    }
  } finally {
    control.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows keeps the WAL sidecars until the last handle is gone; the root is disposable. */
    }
  }
});
