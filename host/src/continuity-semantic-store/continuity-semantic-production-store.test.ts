import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTestWindowsOwnerDeathVerification } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.test-support.js";
import {
  openProductionContinuityStore,
  type ProductionBootstrapInput,
  type ProductionGameRequest,
  type ProductionGameTerminalReceipt,
  productionChatOwnerProvenDead,
} from "./continuity-semantic-production-store.js";

const principal = { continuityId: "continuity1", companionId: "companion1", playerId: "player1" } as const;
const bootstrap: ProductionBootstrapInput = {
  principal,
  bootstrapOperationId: "bootstrap1",
  authorityGeneration: 1,
  authorityRootIdentity: "a".repeat(64),
};
const owner = {
  ownerToken: "owner-token",
  runtimeInstanceId: "runtime-1",
  ownerPid: process.pid,
  ownerProcessStartIdentity: "start-1",
} as const;
const game = (
  operationId: string,
  kind: "enter" | "close",
  expected: any,
  gameSessionId = "game-session",
): ProductionGameRequest => ({
  principal,
  operationId,
  requestId: `request-${operationId}`,
  kind,
  gameSessionId,
  world: { integrationId: "stardew", saveId: "save-1", worldId: "world-1" },
  bindingDigest: "d".repeat(64),
  owner,
  deadlineAtMs: Date.now() + 60_000,
  expected,
});
const receipt = (permit: any, kind: "runtime_bootstrapped" | "runtime_torn_down"): ProductionGameTerminalReceipt => ({
  kind,
  operationId: permit.operationId,
  requestId: permit.requestId,
  gameSessionId: permit.gameSessionId,
  bindingDigest: permit.bindingDigest,
  world: permit.world,
  owner: permit.owner,
  fenceToken: permit.fenceToken,
  occurredAtMs: Date.now(),
});

test("Game recovery requires explicit OS-proven owner death and exact owner tuple", () => {
  const root = mkdtempSync(`${tmpdir()}/production-game-recovery-`);
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const entered = store.prepareGame(
      game("enter-recover", "enter", { partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }),
    );
    const active = store.commitGameTerminal({
      principal,
      permit: entered.permit!,
      receipt: receipt(entered.permit!, "runtime_bootstrapped"),
    });
    const closing = store.prepareGame(game("close-recover", "close", active.vector));
    store.failGame({ principal, permit: closing.permit!, reason: "effect_failed" });
    const recoveryReceipt = { ...receipt(closing.permit!, "runtime_torn_down"), kind: "recovery_completed" as const };
    for (const outcome of ["alive", "mismatch", "ambiguous", "unavailable"] as const) {
      assert.throws(
        () =>
          store.recoverGame({
            request: "recover_dead_owner",
            principal,
            permit: closing.permit!,
            proof: createTestWindowsOwnerDeathVerification(owner, outcome),
            receipt: recoveryReceipt,
          }),
        /recovery_owner_not_proven_dead/,
      );
      assert.equal(
        store.readGameOperation({ principal, operationId: closing.permit!.operationId })!.status,
        "recovery_required",
      );
    }
    const mismatched = { ...owner, ownerProcessStartIdentity: "other-start" };
    assert.throws(
      () =>
        store.recoverGame({
          request: "recover_dead_owner",
          principal,
          permit: closing.permit!,
          proof: createTestWindowsOwnerDeathVerification(mismatched, "proven_dead"),
          receipt: recoveryReceipt,
        }),
      /recovery_proof_invalid/,
    );
    const recovered = store.recoverGame({
      request: "recover_dead_owner",
      principal,
      permit: closing.permit!,
      proof: createTestWindowsOwnerDeathVerification(owner, "proven_dead"),
      receipt: recoveryReceipt,
    });
    assert.equal(recovered.gameState, "ended");
    assert.equal(recovered.leaseState, null);
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Game close-pending dead-owner recovery terminalizes without a runtime teardown receipt", () => {
  const root = mkdtempSync(`${tmpdir()}/production-game-close-pending-recovery-`);
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const entered = store.prepareGame(
      game("enter-close-pending", "enter", { partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }),
    );
    const active = store.commitGameTerminal({
      principal,
      permit: entered.permit!,
      receipt: receipt(entered.permit!, "runtime_bootstrapped"),
    });
    const closing = store.prepareGame(game("close-close-pending", "close", active.vector));
    const target = store.readGameRecoveryTarget({ principal, operationId: closing.permit!.operationId });
    assert.ok(target);
    assert.equal(target.readback.status, "pending");
    assert.equal(target.readback.leaseState, "close_pending");
    const recoveryReceipt = Object.freeze({
      ...receipt(closing.permit!, "runtime_torn_down"),
      kind: "recovery_completed" as const,
    });
    assert.throws(
      () =>
        store.recoverGame({
          request: "recover_dead_owner",
          principal,
          permit: closing.permit!,
          proof: createTestWindowsOwnerDeathVerification({ ...owner, ownerToken: "wrong-owner" }, "proven_dead"),
          receipt: recoveryReceipt,
        }),
      /recovery_proof_invalid/,
    );
    assert.equal(
      store.readGameOperation({ principal, operationId: closing.permit!.operationId })!.leaseState,
      "close_pending",
    );
    assert.throws(
      () =>
        store.recoverGame({
          request: "recover_dead_owner",
          principal,
          permit: {
            ...target.permit,
            expected: { ...target.permit.expected, fenceEpoch: target.permit.expected.fenceEpoch + 1 },
          },
          proof: createTestWindowsOwnerDeathVerification(target.owner, "proven_dead"),
          receipt: recoveryReceipt,
        }),
      /recovery_proof_invalid/,
    );
    assert.equal(
      store.readGameOperation({ principal, operationId: closing.permit!.operationId })!.leaseState,
      "close_pending",
    );
    const recovered = store.recoverGame({
      request: "recover_dead_owner",
      principal,
      permit: target.permit,
      proof: createTestWindowsOwnerDeathVerification(target.owner, "proven_dead"),
      receipt: recoveryReceipt,
    });
    assert.equal(recovered.status, "terminal");
    assert.equal(recovered.gameState, "ended");
    assert.equal(recovered.leaseState, null);
    assert.equal(recovered.receipt?.kind, "recovery_completed");
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Chat runtime commit accepts only frozen exact canonical receipts", () => {
  const createFixture = () => {
    const root = mkdtempSync(`${tmpdir()}/production-chat-receipt-`);
    const control = openProductionContinuityStore({ runtimeRoot: root });
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const holderBindingDigest = "b".repeat(64);
    const claim = store.claim({
      holderBindingDigest,
      operationId: "claim_receipt",
      expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
    });
    const registered = store.register({ holderBindingDigest, operationId: "register_receipt", expected: claim.vector });
    const verified = store.verify(
      { holderBindingDigest, operationId: "verify_receipt", expected: registered.vector },
      {
        chatThreadId: registered.chatThreadId!,
        chatSurfaceSessionId: registered.chatSurfaceSessionId!,
        continuityId: principal.continuityId,
        companionId: principal.companionId,
        digest: "c".repeat(64),
      },
    );
    const selected = store.select({ holderBindingDigest, operationId: "select_receipt", expected: verified.vector });
    const prepared = store.prepareChatRuntime(
      Object.freeze({
        principal,
        operationId: "runtime_receipt",
        requestId: "runtime_request_receipt",
        chatThreadId: selected.chatThreadId!,
        chatSurfaceSessionId: selected.chatSurfaceSessionId!,
        runtimeBindingDigest: "d".repeat(64),
        owner: Object.freeze({ ...owner }),
        deadlineAtMs: Date.now() + 30_000,
        expected: { ...store.readChatCatalog().vector },
      }),
    );
    if (!prepared.permit) throw new Error("missing_chat_runtime_permit");
    const canonicalReceipt = () =>
      Object.freeze({
        kind: "chat_runtime_bootstrapped" as const,
        operationId: prepared.permit!.operationId,
        requestId: prepared.permit!.requestId,
        chatThreadId: prepared.permit!.chatThreadId,
        chatSurfaceSessionId: prepared.permit!.chatSurfaceSessionId,
        runtimeBindingDigest: prepared.permit!.runtimeBindingDigest,
        owner: Object.freeze({ ...prepared.permit!.owner }),
        fenceToken: prepared.permit!.fenceToken,
        occurredAtMs: Date.now(),
      });
    return { root, control, store, permit: prepared.permit, canonicalReceipt };
  };
  const accepted = createFixture();
  let reopenedControl: ReturnType<typeof openProductionContinuityStore> | null = null;
  try {
    assert.equal(
      accepted.store.commitChatRuntime({ principal, permit: accepted.permit, receipt: accepted.canonicalReceipt() })
        .runtimeState,
      "active",
    );
    accepted.control.close();
    reopenedControl = openProductionContinuityStore({ runtimeRoot: accepted.root });
    const reopenedMetadata = reopenedControl.validateBootstrap(bootstrap);
    const reopened = reopenedControl.bindBootstrapContext({ bootstrap, metadata: reopenedMetadata });
    const teardown = reopened.prepareChatRuntimeTeardown({
      principal,
      operationId: "runtime_receipt_teardown",
      requestId: "runtime_request_receipt_teardown",
      bootstrapOperationId: accepted.permit.operationId,
      chatThreadId: accepted.permit.chatThreadId,
      chatSurfaceSessionId: accepted.permit.chatSurfaceSessionId,
      runtimeBindingDigest: accepted.permit.runtimeBindingDigest,
      owner: Object.freeze({ ...owner }),
      deadlineAtMs: Date.now() + 30_000,
      expected: { ...reopened.readChatCatalog().vector },
    });
    assert.equal(teardown.outcome, "effect_owned");
    assert.ok(teardown.permit);
    assert.equal(
      reopened.commitChatRuntimeTeardown({
        principal,
        permit: teardown.permit,
        receipt: Object.freeze({
          kind: "chat_runtime_torn_down" as const,
          operationId: teardown.permit.operationId,
          requestId: teardown.permit.requestId,
          bootstrapOperationId: teardown.permit.bootstrapOperationId,
          chatThreadId: teardown.permit.chatThreadId,
          chatSurfaceSessionId: teardown.permit.chatSurfaceSessionId,
          runtimeBindingDigest: teardown.permit.runtimeBindingDigest,
          owner: Object.freeze({ ...owner }),
          fenceToken: teardown.permit.fenceToken,
          occurredAtMs: Date.now(),
        }),
      }).runtimeState,
      "closed",
    );
  } finally {
    reopenedControl?.close();
    accepted.control.close();
    rmSync(accepted.root, { recursive: true, force: true });
  }
  for (const makeInvalid of [
    (receipt: any) => ({ ...receipt, owner: { ...receipt.owner } }),
    (receipt: any) => Object.freeze({ ...receipt, unexpected: true }),
    (receipt: any) => Object.freeze(Object.assign(Object.create(null), receipt)),
    (receipt: any) =>
      Object.freeze(
        Object.defineProperty({ ...receipt }, "kind", { enumerable: true, get: () => "chat_runtime_bootstrapped" }),
      ),
  ]) {
    const rejected = createFixture();
    try {
      const result = rejected.store.commitChatRuntime({
        principal,
        permit: rejected.permit,
        receipt: makeInvalid(rejected.canonicalReceipt()),
      });
      assert.equal(result.runtimeState, "recovery_required");
    } finally {
      rejected.control.close();
      rmSync(rejected.root, { recursive: true, force: true });
    }
  }
});

test("Chat runtime teardown recovery accepts only frozen exact receipts and persists its canonical readback", () => {
  const root = mkdtempSync(`${tmpdir()}/production-chat-teardown-recovery-`);
  const control = openProductionContinuityStore({ runtimeRoot: root });
  let reopenedControl: ReturnType<typeof openProductionContinuityStore> | null = null;
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const holderBindingDigest = "b".repeat(64);
    const claim = store.claim({
      holderBindingDigest,
      operationId: "claim_teardown_recovery",
      expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
    });
    const registered = store.register({
      holderBindingDigest,
      operationId: "register_teardown_recovery",
      expected: claim.vector,
    });
    const verified = store.verify(
      { holderBindingDigest, operationId: "verify_teardown_recovery", expected: registered.vector },
      {
        chatThreadId: registered.chatThreadId!,
        chatSurfaceSessionId: registered.chatSurfaceSessionId!,
        continuityId: principal.continuityId,
        companionId: principal.companionId,
        digest: "c".repeat(64),
      },
    );
    const selected = store.select({
      holderBindingDigest,
      operationId: "select_teardown_recovery",
      expected: verified.vector,
    });
    const runtime = store.prepareChatRuntime({
      principal,
      operationId: "runtime_teardown_recovery",
      requestId: "runtime_request_teardown_recovery",
      chatThreadId: selected.chatThreadId!,
      chatSurfaceSessionId: selected.chatSurfaceSessionId!,
      runtimeBindingDigest: "d".repeat(64),
      owner: Object.freeze({ ...owner }),
      deadlineAtMs: Date.now() + 30_000,
      expected: { ...store.readChatCatalog().vector },
    });
    assert.ok(runtime.permit);
    assert.equal(
      store.commitChatRuntime({
        principal,
        permit: runtime.permit,
        receipt: Object.freeze({
          kind: "chat_runtime_bootstrapped" as const,
          operationId: runtime.permit.operationId,
          requestId: runtime.permit.requestId,
          chatThreadId: runtime.permit.chatThreadId,
          chatSurfaceSessionId: runtime.permit.chatSurfaceSessionId,
          runtimeBindingDigest: runtime.permit.runtimeBindingDigest,
          owner: Object.freeze({ ...owner }),
          fenceToken: runtime.permit.fenceToken,
          occurredAtMs: Date.now(),
        }),
      }).runtimeState,
      "active",
    );
    const teardown = store.prepareChatRuntimeTeardown({
      principal,
      operationId: "teardown_recovery",
      requestId: "teardown_request_recovery",
      bootstrapOperationId: runtime.permit.operationId,
      chatThreadId: runtime.permit.chatThreadId,
      chatSurfaceSessionId: runtime.permit.chatSurfaceSessionId,
      runtimeBindingDigest: runtime.permit.runtimeBindingDigest,
      owner: Object.freeze({ ...owner }),
      deadlineAtMs: Date.now() + 30_000,
      expected: { ...store.readChatCatalog().vector },
    });
    assert.ok(teardown.permit);
    assert.equal(
      store.failChatRuntimeTeardown({ principal, permit: teardown.permit, reason: "effect_failed" }).runtimeState,
      "recovery_required",
    );
    const recoveryReceipt = Object.freeze({
      kind: "chat_runtime_teardown_recovery_completed" as const,
      operationId: teardown.permit.operationId,
      requestId: teardown.permit.requestId,
      bootstrapOperationId: teardown.permit.bootstrapOperationId,
      chatThreadId: teardown.permit.chatThreadId,
      chatSurfaceSessionId: teardown.permit.chatSurfaceSessionId,
      runtimeBindingDigest: teardown.permit.runtimeBindingDigest,
      owner: Object.freeze({ ...owner }),
      fenceToken: teardown.permit.fenceToken,
      occurredAtMs: Date.now(),
    });
    assert.throws(
      () =>
        store.recoverChatRuntimeTeardown({
          principal,
          permit: teardown.permit!,
          proof: productionChatOwnerProvenDead(teardown.permit!.owner),
          receipt: { ...recoveryReceipt, owner: { ...recoveryReceipt.owner } },
        }),
      /chat_runtime_teardown_receipt_invalid/,
    );
    assert.equal(
      store.recoverChatRuntimeTeardown({
        principal,
        permit: teardown.permit,
        proof: productionChatOwnerProvenDead(teardown.permit.owner),
        receipt: recoveryReceipt,
      }).runtimeState,
      "closed",
    );
    control.close();
    reopenedControl = openProductionContinuityStore({ runtimeRoot: root });
    const reopenedMetadata = reopenedControl.validateBootstrap(bootstrap);
    const reopened = reopenedControl.bindBootstrapContext({ bootstrap, metadata: reopenedMetadata });
    assert.equal(reopened.readChatCatalog().activeSelection?.chatSurfaceSessionId, runtime.permit.chatSurfaceSessionId);
  } finally {
    reopenedControl?.close();
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Chat runtime and Game lifecycle use independent surface fences during concurrent materialization and recovery", () => {
  const root = mkdtempSync(`${tmpdir()}/production-independent-surfaces-`);
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const holderBindingDigest = "b".repeat(64);
    const claim = store.claim({
      holderBindingDigest,
      operationId: "claim_independent",
      expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
    });
    const registered = store.register({
      holderBindingDigest,
      operationId: "register_independent",
      expected: claim.vector,
    });
    const verified = store.verify(
      { holderBindingDigest, operationId: "verify_independent", expected: registered.vector },
      {
        chatThreadId: registered.chatThreadId!,
        chatSurfaceSessionId: registered.chatSurfaceSessionId!,
        continuityId: principal.continuityId,
        companionId: principal.companionId,
        digest: "c".repeat(64),
      },
    );
    const selected = store.select({
      holderBindingDigest,
      operationId: "select_independent",
      expected: verified.vector,
    });
    const chatPrepared = store.prepareChatRuntime({
      principal,
      operationId: "chat_materialize_independent",
      requestId: "chat_request_independent",
      chatThreadId: selected.chatThreadId!,
      chatSurfaceSessionId: selected.chatSurfaceSessionId!,
      runtimeBindingDigest: "d".repeat(64),
      owner,
      deadlineAtMs: Date.now() + 60_000,
      expected: { ...store.readChatCatalog().vector },
    });
    assert.equal(chatPrepared.outcome, "effect_owned");
    assert.ok(chatPrepared.permit);

    const gameEntered = store.prepareGame(
      game("game_enter_independent", "enter", {
        partitionRevision: 1,
        gameRevision: 0,
        leaseRevision: 0,
        fenceEpoch: 1,
      }),
    );
    const gameActive = store.commitGameTerminal({
      principal,
      permit: gameEntered.permit!,
      receipt: receipt(gameEntered.permit!, "runtime_bootstrapped"),
    });
    const closing = store.prepareGame(game("game_close_independent", "close", gameActive.vector));
    const recoveryRequired = store.failGame({ principal, permit: closing.permit!, reason: "effect_failed" });
    assert.equal(recoveryRequired.status, "recovery_required");

    const recovered = store.recoverGame({
      request: "recover_dead_owner",
      principal,
      permit: closing.permit!,
      proof: createTestWindowsOwnerDeathVerification(owner, "proven_dead"),
      receipt: Object.freeze({ ...receipt(closing.permit!, "runtime_torn_down"), kind: "recovery_completed" as const }),
    });
    assert.equal(recovered.gameState, "ended");

    const chatReceipt = Object.freeze({
      kind: "chat_runtime_bootstrapped" as const,
      operationId: chatPrepared.permit!.operationId,
      requestId: chatPrepared.permit!.requestId,
      chatThreadId: chatPrepared.permit!.chatThreadId,
      chatSurfaceSessionId: chatPrepared.permit!.chatSurfaceSessionId,
      runtimeBindingDigest: chatPrepared.permit!.runtimeBindingDigest,
      owner: Object.freeze({ ...owner }),
      fenceToken: chatPrepared.permit!.fenceToken,
      occurredAtMs: Date.now(),
    });
    assert.equal(
      store.commitChatRuntime({ principal, permit: chatPrepared.permit!, receipt: chatReceipt }).runtimeState,
      "active",
    );
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Chat start/materialize/commit remains usable across a Game enter and close", () => {
  const root = mkdtempSync(`${tmpdir()}/production-game-`);
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const entered = store.prepareGame(
      game("enter", "enter", { partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }),
    );
    assert.equal(entered.outcome, "effect_owned");
    assert.ok(entered.permit);
    const active = store.commitGameTerminal({
      principal,
      permit: entered.permit!,
      receipt: receipt(entered.permit!, "runtime_bootstrapped"),
    });
    assert.equal(active.gameState, "active");
    assert.throws(
      () => store.prepareGame(game("second", "enter", active.vector, "second-game")),
      /game_transition_invalid/,
    );
    const closing = store.prepareGame(game("close", "close", active.vector));
    assert.ok(closing.permit);
    const closed = store.commitGameTerminal({
      principal,
      permit: closing.permit!,
      receipt: receipt(closing.permit!, "runtime_torn_down"),
    });
    assert.equal(closed.gameState, "ended");
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});
