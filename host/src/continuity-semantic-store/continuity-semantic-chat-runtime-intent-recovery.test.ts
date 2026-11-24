/**
 * A Host that dies between `prepareChatRuntime` and `commitChatRuntime` (or between the teardown's two
 * halves) leaves a durable intent nothing in production can move: `rejectChatRuntimeTransition` refuses
 * every Chat runtime mount AND the whole Chat command ledger while any intent is `pending` or
 * `recovery_required`, and the only exits - `recoverChatRuntime` / `recoverChatRuntimeTeardown` - had no
 * production caller and, for `pending`, refused the shape outright (`chat_runtime_recovery_proof_invalid`).
 *
 * These cases drive the real store on a real root. The first pair is the death, quoted in the store's own
 * refusal code; the second pair is the production settlement, and each asserts the NEXT Chat operation is
 * admitted - a recovery that returned but left the block in place would pass a weaker assertion.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import {
  openProductionContinuityStore,
  productionChatOwnerProvenDead,
  type ProductionBootstrapInput,
  type ProductionChatRuntimePermit,
  type ProductionChatRuntimeRecoveryReceipt,
  type ProductionChatRuntimeTeardownPermit,
  type ProductionChatRuntimeTeardownRecoveryReceipt,
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
/** A process this test is not: the intent's owner exited with the Host that prepared it. */
const owner = Object.freeze({
  ownerToken: "owner-token-1",
  runtimeInstanceId: "runtime-instance-1",
  ownerPid: 4_242,
  ownerProcessStartIdentity: "start-identity-1",
});

type Store = ReturnType<ReturnType<typeof openProductionContinuityStore>["bindBootstrapContext"]>;

function receiptFor(chatThreadId: string, chatSurfaceSessionId: string): TavernExactContentReceipt {
  return Object.freeze({
    chatThreadId,
    chatSurfaceSessionId,
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    digest: "c".repeat(64),
  });
}

/** One fresh root whose initial Chat is registered, verified and selected. */
function freshRoot() {
  const root = canonicalTestRootSync("production-chat-runtime-intent-recovery-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  const metadata = control.bootstrapFresh(bootstrap);
  const store = control.bindBootstrapContext({ bootstrap, metadata });
  const claim = store.claim({
    holderBindingDigest,
    operationId: "claim-1",
    expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
  });
  const registered = store.register({ holderBindingDigest, operationId: "register-1", expected: claim.vector });
  const verified = store.verify(
    { holderBindingDigest, operationId: "verify-1", expected: registered.vector },
    receiptFor(registered.chatThreadId!, registered.chatSurfaceSessionId!),
  );
  store.select({ holderBindingDigest, operationId: "select-1", expected: verified.vector });
  return { root, control, store };
}

/** The Chat runtime request the settled selection admits, named by `suffix`. */
function runtimeRequest(store: Store, suffix: string) {
  return {
    principal,
    operationId: `runtime-${suffix}`,
    requestId: `runtime-request-${suffix}`,
    chatThreadId: store.readChatCatalog().activeSelection!.chatThreadId,
    chatSurfaceSessionId: store.readChatCatalog().activeSelection!.chatSurfaceSessionId,
    runtimeBindingDigest: "d".repeat(64),
    owner: Object.freeze({ ...owner }),
    deadlineAtMs: Date.now() + 60_000,
    expected: { ...store.readChatCatalog().vector },
  };
}

function teardownRequest(store: Store, runtime: ProductionChatRuntimePermit, suffix: string) {
  return {
    principal,
    operationId: `teardown-${suffix}`,
    requestId: `teardown-request-${suffix}`,
    bootstrapOperationId: runtime.operationId,
    chatThreadId: runtime.chatThreadId,
    chatSurfaceSessionId: runtime.chatSurfaceSessionId,
    runtimeBindingDigest: runtime.runtimeBindingDigest,
    owner: Object.freeze({ ...owner }),
    deadlineAtMs: Date.now() + 60_000,
    expected: { ...store.readChatCatalog().vector },
  };
}

function bootstrapReceipt(permit: ProductionChatRuntimePermit) {
  return Object.freeze({
    kind: "chat_runtime_bootstrapped" as const,
    operationId: permit.operationId,
    requestId: permit.requestId,
    chatThreadId: permit.chatThreadId,
    chatSurfaceSessionId: permit.chatSurfaceSessionId,
    runtimeBindingDigest: permit.runtimeBindingDigest,
    owner: Object.freeze({ ...permit.owner }),
    fenceToken: permit.fenceToken,
    occurredAtMs: Date.now(),
  });
}

/** The recovery receipts the store accepts: the durable permit's own facts, and nothing minted here. */
function bootstrapRecoveryReceipt(permit: ProductionChatRuntimePermit): ProductionChatRuntimeRecoveryReceipt {
  return Object.freeze({
    kind: "chat_runtime_recovery_completed",
    operationId: permit.operationId,
    requestId: permit.requestId,
    chatThreadId: permit.chatThreadId,
    chatSurfaceSessionId: permit.chatSurfaceSessionId,
    runtimeBindingDigest: permit.runtimeBindingDigest,
    owner: Object.freeze({ ...permit.owner }),
    fenceToken: permit.fenceToken,
    occurredAtMs: Date.now(),
  });
}

function teardownRecoveryReceipt(
  permit: ProductionChatRuntimeTeardownPermit,
): ProductionChatRuntimeTeardownRecoveryReceipt {
  return Object.freeze({
    kind: "chat_runtime_teardown_recovery_completed",
    operationId: permit.operationId,
    requestId: permit.requestId,
    bootstrapOperationId: permit.bootstrapOperationId,
    chatThreadId: permit.chatThreadId,
    chatSurfaceSessionId: permit.chatSurfaceSessionId,
    runtimeBindingDigest: permit.runtimeBindingDigest,
    owner: Object.freeze({ ...permit.owner }),
    fenceToken: permit.fenceToken,
    occurredAtMs: Date.now(),
  });
}

/** Commits a Chat runtime so the teardown half has its required terminal predecessor. */
function committedRuntime(store: Store): ProductionChatRuntimePermit {
  const prepared = store.prepareChatRuntime(runtimeRequest(store, "committed"));
  assert.equal(prepared.outcome, "effect_owned");
  const permit = prepared.permit!;
  assert.equal(
    store.commitChatRuntime({ principal, permit, receipt: bootstrapReceipt(permit) }).runtimeState,
    "active",
  );
  return permit;
}

test("a Chat runtime intent a dead Host left pending refuses every later Chat operation by name", () => {
  const { root, control, store } = freshRoot();
  try {
    const prepared = store.prepareChatRuntime(runtimeRequest(store, "orphan"));
    // The effect never committed: exactly what a process that exits between the two writes leaves.
    assert.equal(prepared.outcome, "effect_owned");
    assert.equal(prepared.readback.status, "pending");

    // What the player's next request gets, in the store's own words - the runtime mount first ...
    assert.throws(
      () => store.prepareChatRuntime(runtimeRequest(store, "after-orphan")),
      /chat_runtime_transition_pending/,
      "the mount is refused by name while the orphan holds the transition",
    );
    // ... and the Chat command ledger, which is how a new or switched Chat would be registered.
    assert.throws(
      () =>
        store.selectChat({
          operationId: "select-after-orphan",
          chatThreadId: store.readChatCatalog().activeSelection!.chatThreadId,
          chatSurfaceSessionId: store.readChatCatalog().activeSelection!.chatSurfaceSessionId,
          expected: { ...store.readChatCatalog().vector },
        }),
      /chat_runtime_transition_pending/,
      "every Chat command is refused by the same name",
    );
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Chat runtime intent that reached recovery_required refuses every later Chat operation by name", () => {
  const { root, control, store } = freshRoot();
  try {
    const prepared = store.prepareChatRuntime(runtimeRequest(store, "failed"));
    // The production effect-failure exit (`failChatRuntimeAfterError`): the runtime never came up.
    const failed = store.failChatRuntime({ principal, permit: prepared.permit!, reason: "effect_failed" });
    assert.equal(failed.status, "recovery_required");
    assert.equal(failed.recoveryReason, "effect_failed");

    assert.throws(
      () => store.prepareChatRuntime(runtimeRequest(store, "after-failed")),
      /chat_runtime_transition_pending/,
    );
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an orphaned pending Chat runtime intent is re-derived from its own durable row, settled, and the mount is admitted", () => {
  const { root, control, store } = freshRoot();
  let reopened: ReturnType<typeof openProductionContinuityStore> | null = null;
  try {
    const prepared = store.prepareChatRuntime(runtimeRequest(store, "settle"));
    const permit = prepared.permit!;

    const target = store.readPendingChatRuntimeRecoveryTarget();
    assert.equal(target?.kind, "bootstrap");
    assert.equal(target?.permit.operationId, permit.operationId);
    // The permit the settlement is driven with is the durable row's, not one this process minted.
    assert.equal(target?.permit.fenceToken, permit.fenceToken);
    assert.equal(target?.readback.status, "pending");

    const recovered = store.recoverChatRuntime({
      principal,
      permit: target!.permit as ProductionChatRuntimePermit,
      proof: productionChatOwnerProvenDead(target!.owner),
      receipt: bootstrapRecoveryReceipt(target!.permit as ProductionChatRuntimePermit),
    });
    assert.equal(recovered.status, "terminal");
    assert.equal(recovered.runtimeState, "active");

    // The obligation is gone, so the two things it blocked are back: the Chat command ledger, whose first
    // admitted command is the successor bridge a mount after an interrupted cycle has to consume ...
    assert.equal(store.readPendingChatRuntimeRecoveryTarget(), null);
    store.selectChat({
      operationId: "select-successor",
      chatThreadId: permit.chatThreadId,
      chatSurfaceSessionId: permit.chatSurfaceSessionId,
      expected: { ...store.readChatCatalog().vector },
    });
    // ... and the runtime mount itself.
    assert.equal(store.prepareChatRuntime(runtimeRequest(store, "admitted")).outcome, "effect_owned");

    // The recovered root is still a valid materialization, not just a row that moved: it reopens.
    control.close();
    reopened = openProductionContinuityStore({ runtimeRoot: root });
  } finally {
    reopened?.close();
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the recovery_required Chat runtime intent is settled from its own durable row and the mount is admitted", () => {
  const { root, control, store } = freshRoot();
  let reopened: ReturnType<typeof openProductionContinuityStore> | null = null;
  try {
    const prepared = store.prepareChatRuntime(runtimeRequest(store, "failed-settle"));
    store.failChatRuntime({ principal, permit: prepared.permit!, reason: "effect_failed" });

    const target = store.readPendingChatRuntimeRecoveryTarget();
    assert.equal(target?.kind, "bootstrap");
    assert.equal(target?.readback.status, "recovery_required");
    assert.equal(target?.readback.recoveryReason, "effect_failed");

    const recovered = store.recoverChatRuntime({
      principal,
      permit: target!.permit as ProductionChatRuntimePermit,
      proof: productionChatOwnerProvenDead(target!.owner),
      receipt: bootstrapRecoveryReceipt(target!.permit as ProductionChatRuntimePermit),
    });
    assert.equal(recovered.status, "terminal");
    assert.equal(recovered.recoveryReason, null);
    store.selectChat({
      operationId: "select-successor",
      chatThreadId: prepared.permit!.chatThreadId,
      chatSurfaceSessionId: prepared.permit!.chatSurfaceSessionId,
      expected: { ...store.readChatCatalog().vector },
    });
    assert.equal(store.prepareChatRuntime(runtimeRequest(store, "admitted")).outcome, "effect_owned");

    control.close();
    reopened = openProductionContinuityStore({ runtimeRoot: root });
  } finally {
    reopened?.close();
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an orphaned pending Chat runtime teardown is settled from its own durable row and the torn-down Chat reads closed", () => {
  const { root, control, store } = freshRoot();
  let reopened: ReturnType<typeof openProductionContinuityStore> | null = null;
  try {
    const runtime = committedRuntime(store);
    const prepared = store.prepareChatRuntimeTeardown(teardownRequest(store, runtime, "orphan"));
    assert.equal(prepared.outcome, "effect_owned");
    const permit = prepared.permit!;
    // The teardown's effect never committed: the same crash window as the bootstrap's.
    assert.throws(
      () => store.prepareChatRuntimeTeardown(teardownRequest(store, runtime, "after-orphan")),
      /chat_runtime_transition_pending/,
    );

    const target = store.readPendingChatRuntimeRecoveryTarget();
    assert.equal(target?.kind, "teardown");
    assert.equal(target?.permit.operationId, permit.operationId);

    const recovered = store.recoverChatRuntimeTeardown({
      principal,
      permit: target!.permit as ProductionChatRuntimeTeardownPermit,
      proof: productionChatOwnerProvenDead(target!.owner),
      receipt: teardownRecoveryReceipt(target!.permit as ProductionChatRuntimeTeardownPermit),
    });
    assert.equal(recovered.status, "terminal");
    assert.equal(recovered.runtimeState, "closed");
    assert.equal(store.readPendingChatRuntimeRecoveryTarget(), null);

    // The torn-down Chat's session is `ended` and the root is still a valid materialization.
    control.close();
    reopened = openProductionContinuityStore({ runtimeRoot: root });
  } finally {
    reopened?.close();
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});
