import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
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

test("Game session world binding is durable, exact, idempotent, and redacted", () => {
  const root = canonicalTestRootSync("production-game-session-binding-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  let controlClosed = false;
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-binding",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    const binding = store.registerGameSessionWorldBinding({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      bindingRef: "opaque-world-ref",
      operationId: "bind-01",
    });
    assert.deepEqual(binding, {
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      bindingRef: "opaque-world-ref",
      status: "registered",
      revision: 1,
    });
    assert.deepEqual(
      store.registerGameSessionWorldBinding({
        gameSessionId: session.gameSessionId,
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        operationId: "bind-01",
      }),
      binding,
    );
    assert.deepEqual(
      store.readGameSessionWorldBinding({ gameSessionId: session.gameSessionId, integrationId: "stardew" }),
      binding,
    );
    assert.throws(
      () =>
        store.registerGameSessionWorldBinding({
          gameSessionId: session.gameSessionId,
          integrationId: "stardew",
          bindingRef: "other-world-ref",
          operationId: "bind-01",
        }),
      /game_session_world_binding_conflict/,
    );
    assert.throws(
      () =>
        store.registerGameSessionWorldBinding({
          gameSessionId: session.gameSessionId,
          integrationId: "stardew",
          bindingRef: "other-world-ref",
          operationId: "bind-02",
        }),
      /game_session_world_binding_conflict/,
    );
    const incomplete = store.createGameSessionMetadata({
      creationRequestId: "create-incomplete",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    assert.throws(
      () => store.completeGameSessionBinding({
        creationRequestId: "create-incomplete",
        gameSessionId: incomplete.gameSessionId,
        expectedRevision: 1,
      }),
      /game_session_world_binding_missing/,
    );
    assert.equal(store.readGameSessionMetadata({ gameSessionId: incomplete.gameSessionId })?.status, "pending");
    store.failGameSessionCreation({
      creationRequestId: "create-incomplete",
      gameSessionId: incomplete.gameSessionId,
      expectedRevision: 1,
    });
    assert.throws(
      () =>
        store.registerGameSessionWorldBinding({
          gameSessionId: incomplete.gameSessionId,
          integrationId: "stardew",
          bindingRef: "late-world-ref",
          operationId: "late-bind-01",
        }),
      /game_session_world_binding_conflict/,
    );
    const bindingBeforeFailure = store.createGameSessionMetadata({
      creationRequestId: "create-binding-fail",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    store.registerGameSessionWorldBinding({
      gameSessionId: bindingBeforeFailure.gameSessionId,
      integrationId: "stardew",
      bindingRef: "opaque-binding-fail",
      operationId: "binding-fail-01",
    });
    assert.throws(
      () =>
        store.failGameSessionCreation({
          creationRequestId: "create-binding-fail",
          gameSessionId: bindingBeforeFailure.gameSessionId,
          expectedRevision: 1,
        }),
      /game_session_metadata_conflict/,
    );
    assert.equal(
      store.readGameSessionMetadata({ gameSessionId: bindingBeforeFailure.gameSessionId })?.status,
      "pending",
    );
    const resumable = store.completeGameSessionBinding({
      creationRequestId: "create-binding",
      gameSessionId: session.gameSessionId,
      expectedRevision: 1,
    });
    assert.equal(resumable.status, "resumable");
    assert.deepEqual(store.listResumableGameSessions(), [resumable]);
    assert.throws(
      () =>
        store.registerGameSessionWorldBinding({
          gameSessionId: session.gameSessionId,
          integrationId: "stardew",
          bindingRef: "late-world-ref",
          operationId: "late-bind-resumable",
        }),
      /game_session_world_binding_conflict/,
    );
    control.close();
    controlClosed = true;
    const reopenedControl = openProductionContinuityStore({ runtimeRoot: root });
    let reopenedControlClosed = false;
    try {
      const reopenedStore = reopenedControl.bindBootstrapContext({
        bootstrap,
        metadata: reopenedControl.validateBootstrap(bootstrap),
      });
      assert.deepEqual(
        reopenedStore.readGameSessionWorldBinding({ gameSessionId: session.gameSessionId, integrationId: "stardew" }),
        binding,
      );
      assert.deepEqual(reopenedStore.listResumableGameSessions(), [resumable]);
      const terminal = reopenedStore.markGameSessionWorldBindingTerminal({
        gameSessionId: session.gameSessionId,
        integrationId: "stardew",
        expectedRevision: 1,
        operationId: "bind-01",
      });
      assert.equal(terminal.status, "terminal");
      assert.deepEqual(
        reopenedStore.readGameSessionMetadata({ gameSessionId: session.gameSessionId }),
        { ...resumable, status: "failed", revision: 3 },
      );
      assert.deepEqual(reopenedStore.listResumableGameSessions(), []);
      assert.deepEqual(
        reopenedStore.markGameSessionWorldBindingTerminal({
          gameSessionId: session.gameSessionId,
          integrationId: "stardew",
          expectedRevision: 1,
          operationId: "bind-01",
        }),
        terminal,
      );
      reopenedControl.close();
      reopenedControlClosed = true;
      const terminalReopenedControl = openProductionContinuityStore({ runtimeRoot: root });
      try {
        const terminalReopenedStore = terminalReopenedControl.bindBootstrapContext({
          bootstrap,
          metadata: terminalReopenedControl.validateBootstrap(bootstrap),
        });
        assert.deepEqual(
          terminalReopenedStore.readGameSessionWorldBinding({
            gameSessionId: session.gameSessionId,
            integrationId: "stardew",
          }),
          terminal,
        );
        assert.deepEqual(
          terminalReopenedStore.readGameSessionMetadata({ gameSessionId: session.gameSessionId }),
          { ...resumable, status: "failed", revision: 3 },
        );
        assert.deepEqual(terminalReopenedStore.listResumableGameSessions(), []);
      } finally {
        terminalReopenedControl.close();
      }
    } finally {
      if (!reopenedControlClosed) reopenedControl.close();
    }
  } finally {
    if (!controlClosed) control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Pure Game materialization rejects terminal binding with failed revision 2 on reopen", () => {
  const root = canonicalTestRootSync("production-game-session-corrupt-reopen-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-corrupt-reopen",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    store.registerGameSessionWorldBinding({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      bindingRef: "opaque-corrupt-reopen",
      operationId: "bind-corrupt-reopen",
    });
    store.completeGameSessionBinding({
      creationRequestId: "create-corrupt-reopen",
      gameSessionId: session.gameSessionId,
      expectedRevision: 1,
    });
    store.markGameSessionWorldBindingTerminal({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      expectedRevision: 1,
      operationId: "bind-corrupt-reopen",
    });
    control.close();
    const db = new DatabaseSync(join(root, "gamebuddy-continuity-v1.sqlite"));
    try {
      db.prepare(
        "UPDATE production_game_session_metadata SET status='failed',revision=2 WHERE game_session_id=?",
      ).run(session.gameSessionId);
    } finally {
      db.close();
    }
    assert.throws(
      () => openProductionContinuityStore({ runtimeRoot: root }),
      /production_store_materialization_invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("A session whose completion never landed still settles terminally after registration", () => {
  const root = canonicalTestRootSync("production-game-session-registered-settle-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  let controlClosed = false;
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-settle-registered",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    store.registerGameSessionWorldBinding({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      bindingRef: "opaque-settle-ref",
      operationId: "bind-settle-01",
    });
    // Completion is the only writer that makes a session resumable, so the shape
    // a create leaves behind when completion fails after registration is exactly
    // this: a registered binding with pending revision 1 metadata.
    assert.deepEqual(store.readGameSessionMetadata({ gameSessionId: session.gameSessionId }), session);
    assert.throws(
      () =>
        store.failGameSessionCreation({
          creationRequestId: "create-settle-registered",
          gameSessionId: session.gameSessionId,
          expectedRevision: 1,
        }),
      /game_session_metadata_conflict/,
    );
    const terminal = store.markGameSessionWorldBindingTerminal({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      expectedRevision: 1,
      operationId: "bind-settle-01",
    });
    assert.deepEqual(terminal, {
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      bindingRef: "opaque-settle-ref",
      status: "terminal",
      revision: 2,
    });
    assert.deepEqual(store.readGameSessionMetadata({ gameSessionId: session.gameSessionId }), {
      ...session,
      status: "failed",
      revision: 3,
    });
    assert.deepEqual(store.listResumableGameSessions(), []);
    // Terminal is sticky: the same settle reads back, and a late completion can
    // never revive the settled session.
    assert.deepEqual(
      store.markGameSessionWorldBindingTerminal({
        gameSessionId: session.gameSessionId,
        integrationId: "stardew",
        expectedRevision: 1,
        operationId: "bind-settle-01",
      }),
      terminal,
    );
    assert.throws(
      () =>
        store.completeGameSessionBinding({
          creationRequestId: "create-settle-registered",
          gameSessionId: session.gameSessionId,
          expectedRevision: 1,
        }),
      /game_session_metadata_conflict/,
    );
    control.close();
    controlClosed = true;
    // The settled row pair must survive the store's own materialization rules,
    // which are the authority on which durable row pairs are legal.
    const reopenedControl = openProductionContinuityStore({ runtimeRoot: root });
    try {
      const reopenedStore = reopenedControl.bindBootstrapContext({
        bootstrap,
        metadata: reopenedControl.validateBootstrap(bootstrap),
      });
      assert.deepEqual(
        reopenedStore.readGameSessionWorldBinding({ gameSessionId: session.gameSessionId, integrationId: "stardew" }),
        terminal,
      );
      assert.deepEqual(reopenedStore.readGameSessionMetadata({ gameSessionId: session.gameSessionId }), {
        ...session,
        status: "failed",
        revision: 3,
      });
      assert.deepEqual(reopenedStore.listResumableGameSessions(), []);
    } finally {
      reopenedControl.close();
    }
  } finally {
    if (!controlClosed) control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("A world slot held by a live session is rejected for a second session and reused only once terminal", () => {
  const root = canonicalTestRootSync("production-game-session-duplicate-slot-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  let controlClosed = false;
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const first = store.createGameSessionMetadata({
      creationRequestId: "create-duplicate-first",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    const firstBinding = store.registerGameSessionWorldBinding({
      gameSessionId: first.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      operationId: "bind-duplicate-first",
    });
    // The legitimate same-session replay is the store-owned operation identity,
    // and it must never be mistaken for a foreign claim on the slot.
    assert.deepEqual(
      store.registerGameSessionWorldBinding({
        gameSessionId: first.gameSessionId,
        integrationId: "stardew",
        bindingRef: "Farm_389124477",
        operationId: "bind-duplicate-first",
      }),
      firstBinding,
    );
    // A second binding for the same session stays that session's own conflict.
    assert.throws(
      () =>
        store.registerGameSessionWorldBinding({
          gameSessionId: first.gameSessionId,
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
          operationId: "bind-duplicate-first-replay",
        }),
      /game_session_world_binding_conflict/,
    );
    const second = store.createGameSessionMetadata({
      creationRequestId: "create-duplicate-second",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    assert.throws(
      () =>
        store.registerGameSessionWorldBinding({
          gameSessionId: second.gameSessionId,
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
          operationId: "bind-duplicate-second",
        }),
      /game_session_world_binding_duplicate/,
    );
    // The rejected registration wrote nothing, so the second session can only
    // settle through the pre-registration shape: failed with no binding row.
    assert.equal(
      store.readGameSessionWorldBinding({ gameSessionId: second.gameSessionId, integrationId: "stardew" }),
      null,
    );
    assert.deepEqual(store.readGameSessionMetadata({ gameSessionId: second.gameSessionId }), second);
    store.failGameSessionCreation({
      creationRequestId: "create-duplicate-second",
      gameSessionId: second.gameSessionId,
      expectedRevision: 1,
    });
    assert.deepEqual(store.readGameSessionMetadata({ gameSessionId: second.gameSessionId }), {
      ...second,
      status: "failed",
      revision: 2,
    });
    // The same reference under another integration is another world, not a claim
    // on this one.
    const foreign = store.createGameSessionMetadata({
      creationRequestId: "create-duplicate-foreign",
      integrationId: "other-integration",
      continuityIdentityId: principal.continuityId,
    });
    assert.equal(
      store.registerGameSessionWorldBinding({
        gameSessionId: foreign.gameSessionId,
        integrationId: "other-integration",
        bindingRef: "Farm_389124477",
        operationId: "bind-duplicate-foreign",
      }).status,
      "registered",
    );
    // The first session completes while its binding still holds the slot, and it
    // stays the one resumable session for that world.
    assert.equal(
      store.completeGameSessionBinding({
        creationRequestId: "create-duplicate-first",
        gameSessionId: first.gameSessionId,
        expectedRevision: 1,
      }).status,
      "resumable",
    );
    assert.deepEqual(
      store.listResumableGameSessions().map((row) => row.gameSessionId),
      [first.gameSessionId],
    );
    // Once the holder is settled (terminal binding + failed metadata) the slot is
    // free for a later create: the residual save belongs to the native game, not
    // to any session.
    store.markGameSessionWorldBindingTerminal({
      gameSessionId: first.gameSessionId,
      integrationId: "stardew",
      expectedRevision: 1,
      operationId: "bind-duplicate-first",
    });
    const third = store.createGameSessionMetadata({
      creationRequestId: "create-duplicate-third",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    const thirdBinding = store.registerGameSessionWorldBinding({
      gameSessionId: third.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      operationId: "bind-duplicate-third",
    });
    assert.equal(thirdBinding.status, "registered");
    assert.equal(
      store.completeGameSessionBinding({
        creationRequestId: "create-duplicate-third",
        gameSessionId: third.gameSessionId,
        expectedRevision: 1,
      }).status,
      "resumable",
    );
    assert.deepEqual(
      store.listResumableGameSessions().map((row) => row.gameSessionId),
      [third.gameSessionId],
    );
    control.close();
    controlClosed = true;
    const reopenedControl = openProductionContinuityStore({ runtimeRoot: root });
    try {
      const reopenedStore = reopenedControl.bindBootstrapContext({
        bootstrap,
        metadata: reopenedControl.validateBootstrap(bootstrap),
      });
      assert.equal(
        reopenedStore.readGameSessionWorldBinding({ gameSessionId: first.gameSessionId, integrationId: "stardew" })
          ?.status,
        "terminal",
      );
      assert.equal(
        reopenedStore.readGameSessionWorldBinding({ gameSessionId: third.gameSessionId, integrationId: "stardew" })
          ?.status,
        "registered",
      );
      assert.deepEqual(
        reopenedStore.listResumableGameSessions().map((row) => row.gameSessionId),
        [third.gameSessionId],
      );
    } finally {
      reopenedControl.close();
    }
  } finally {
    if (!controlClosed) control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Game recovery requires explicit OS-proven owner death and exact owner tuple", () => {
  const root = canonicalTestRootSync("production-game-recovery-");
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
  const root = canonicalTestRootSync("production-game-close-pending-recovery-");
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
    const root = canonicalTestRootSync("production-chat-receipt-");
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
  const root = canonicalTestRootSync("production-chat-teardown-recovery-");
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
  const root = canonicalTestRootSync("production-independent-surfaces-");
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
  const root = canonicalTestRootSync("production-game-");
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
