import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import { createTestWindowsOwnerDeathVerification } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.test-support.js";
import {
  mintGameSessionWorldBindingSlotLeaseVerdict,
  openProductionContinuityStore,
  type ProductionBootstrapInput,
  type ProductionGameRequest,
  type ProductionGameTerminalReceipt,
  productionChatOwnerProvenDead,
  productionGameSessionWorldBindingSlotLeaseVerdict,
  productionGameSessionWorldBindingSlotRelease,
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
/**
 * A slot-release proof: the native lease verdict together with the holder handle
 * the verdict was obtained for. The release requires that correlation to equal
 * the row's own `holderHandle`, so a verdict obtained for one holder cannot be
 * substituted into another holder's slot.
 */
const slotReleaseProof = (
  holderHandle: string,
  verdict: Parameters<typeof mintGameSessionWorldBindingSlotLeaseVerdict>[0] = "holder_gone",
) => ({ verdict: mintGameSessionWorldBindingSlotLeaseVerdict(verdict), holderHandle });

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
      holderHandle: "holder-bind-01",
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
        holderHandle: "holder-bind-01",
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
          holderHandle: "holder-other-bind-01",
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
          holderHandle: "holder-other-bind-02",
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
          holderHandle: "holder-late-bind-01",
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
      holderHandle: "holder-binding-fail-01",
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
          holderHandle: "holder-late-bind-resumable",
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
      holderHandle: "holder-bind-corrupt-reopen",
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
      holderHandle: "holder-bind-settle-01",
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
      holderHandle: "holder-bind-duplicate-first",
    });
    // The legitimate same-session replay is the store-owned operation identity,
    // and it must never be mistaken for a foreign claim on the slot.
    assert.deepEqual(
      store.registerGameSessionWorldBinding({
        gameSessionId: first.gameSessionId,
        integrationId: "stardew",
        bindingRef: "Farm_389124477",
        operationId: "bind-duplicate-first",
        holderHandle: "holder-bind-duplicate-first",
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
          holderHandle: "holder-bind-duplicate-first-replay",
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
          holderHandle: "holder-bind-duplicate-second",
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
        holderHandle: "holder-bind-duplicate-foreign",
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
      holderHandle: "holder-bind-duplicate-third",
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

/**
 * The slot wedge, now repaired for every holder that carries a handle.
 *
 * The shape this test pins is the one a crash leaves behind: a create registers
 * the world binding and only then completes the session, so a death in between
 * leaves `registered revision 1` over `pending revision 1` - completed later by
 * nothing but this test - and the per-command `operationId` the terminal settle
 * demands existed only in the dead process's memory. No store fact can settle
 * that holder for a successor, and `failGameSessionCreation` refuses a session
 * that already has a binding row.
 *
 * The owner's ruling (D2-A', 2026-10-05 evening) is that a successor releases
 * such a slot by presenting the holder's own handle - written at registration,
 * read back for the slot - together with a native lease verdict proving the
 * holder's lease gone; the verdict is carried with the holder it was obtained
 * for, so a verdict obtained for one attempt can never free another holder's
 * slot. The
 * released holder lands on the canonical terminal shape
 * (binding terminal revision 2 paired with metadata failed revision 3) inside the
 * store's one settle transaction. The release assertions at the end of this test
 * are that repair.
 *
 * Every refusal above them is kept, because each is still true and still the
 * negative coverage the repair must not weaken: the pre-registration settle and
 * the command-identified terminal settle still refuse (no operationId), the
 * duplicate-slot rule still refuses a second live session for the slot, and a
 * restart neither repairs nor quarantines the abandoned pair on its own.
 *
 * A holder written before the handle column existed cannot be released by this
 * operation, and that is not closeable here: the handle column is NOT NULL, and a
 * store written before it existed is refused at open by the physical-signature
 * check instead of being read with unknown holders or backfilled. A backfill
 * would have to invent the handle of a dead attempt, which is the guess this
 * ruling forbids.
 */
test(
  "A slot abandoned by a dead holder is released by that holder's own handle plus a native lease verdict that the holder is gone",
  () => {
  const root = canonicalTestRootSync("production-game-session-slot-wedge-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  let controlClosed = false;
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    // Session A registers the slot; its per-command operationId is dropped here
    // exactly as a process death would (the coordinator mints it with
    // randomBytes(32) inside an in-memory idempotency slot).
    const first = store.createGameSessionMetadata({
      creationRequestId: "wedge-create-first",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    assert.deepEqual(
      store.registerGameSessionWorldBinding({
        gameSessionId: first.gameSessionId,
        integrationId: "stardew",
        bindingRef: "Farm_389124477",
        operationId: "wedge-bind-first",
        holderHandle: "holder-wedge-bind-first",
      }),
      {
        gameSessionId: first.gameSessionId,
        integrationId: "stardew",
        bindingRef: "Farm_389124477",
        status: "registered",
        revision: 1,
      },
    );
    // The abandoned pair is not discoverable as resumable, and no readback
    // carries the operationId the terminal settle demands.
    assert.deepEqual(store.listResumableGameSessions(), []);
    assert.deepEqual(
      Object.keys(
        store.readGameSessionWorldBinding({ gameSessionId: first.gameSessionId, integrationId: "stardew" })!,
      ).sort(),
      ["bindingRef", "gameSessionId", "integrationId", "revision", "status"],
    );
    // A later create is refused by the surviving holder.
    const second = store.createGameSessionMetadata({
      creationRequestId: "wedge-create-second",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    assert.throws(
      () =>
        store.registerGameSessionWorldBinding({
          gameSessionId: second.gameSessionId,
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
          operationId: "wedge-bind-second",
          holderHandle: "holder-wedge-bind-second",
        }),
      /game_session_world_binding_duplicate/,
    );
    // The pre-registration settle refuses because the binding row exists (this
    // is the isolated binding-row predicate: the creation request is the true
    // one, so the identity/ revision checks above it pass).
    assert.throws(
      () =>
        store.failGameSessionCreation({
          creationRequestId: "wedge-create-first",
          gameSessionId: first.gameSessionId,
          expectedRevision: 1,
        }),
      /game_session_metadata_conflict/,
    );
    // The terminal settle refuses without the lost operationId.
    assert.throws(
      () =>
        store.markGameSessionWorldBindingTerminal({
          gameSessionId: first.gameSessionId,
          integrationId: "stardew",
          expectedRevision: 1,
          operationId: "wedge-bind-first-lost",
        }),
      /game_session_world_binding_conflict/,
    );
    // The one transition reachable without the operationId makes the holder
    // resumable and still does not free the slot.
    assert.equal(
      store.completeGameSessionBinding({
        creationRequestId: "wedge-create-first",
        gameSessionId: first.gameSessionId,
        expectedRevision: 1,
      }).status,
      "resumable",
    );
    assert.throws(
      () =>
        store.registerGameSessionWorldBinding({
          gameSessionId: second.gameSessionId,
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
          operationId: "wedge-bind-second-again",
          holderHandle: "holder-wedge-bind-second-again",
        }),
      /game_session_world_binding_duplicate/,
    );
    assert.throws(
      () =>
        store.markGameSessionWorldBindingTerminal({
          gameSessionId: first.gameSessionId,
          integrationId: "stardew",
          expectedRevision: 1,
          operationId: "wedge-bind-first-lost",
        }),
      /game_session_world_binding_conflict/,
    );
    // The refused create settles the pre-registration way and stays refused.
    assert.deepEqual(
      store.failGameSessionCreation({
        creationRequestId: "wedge-create-second",
        gameSessionId: second.gameSessionId,
        expectedRevision: 1,
      }),
      { ...second, status: "failed", revision: 2 },
    );
    const third = store.createGameSessionMetadata({
      creationRequestId: "wedge-create-third",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    assert.throws(
      () =>
        store.registerGameSessionWorldBinding({
          gameSessionId: third.gameSessionId,
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
          operationId: "wedge-bind-third",
          holderHandle: "holder-wedge-bind-third",
        }),
      /game_session_world_binding_duplicate/,
    );
    control.close();
    controlClosed = true;
    // A restart neither repairs nor quarantines the abandoned pair: the
    // materialization rules accept `resumable rev2 + registered rev1`, and the
    // slot stays held for every later create.
    const reopenedControl = openProductionContinuityStore({ runtimeRoot: root });
    try {
      const reopenedStore = reopenedControl.bindBootstrapContext({
        bootstrap,
        metadata: reopenedControl.validateBootstrap(bootstrap),
      });
      assert.deepEqual(reopenedStore.listResumableGameSessions(), [{ ...first, status: "resumable", revision: 2 }]);
      const fourth = reopenedStore.createGameSessionMetadata({
        creationRequestId: "wedge-create-fourth",
        integrationId: "stardew",
        continuityIdentityId: principal.continuityId,
      });
      assert.throws(
        () =>
          reopenedStore.registerGameSessionWorldBinding({
            gameSessionId: fourth.gameSessionId,
            integrationId: "stardew",
            bindingRef: "Farm_389124477",
            operationId: "wedge-bind-fourth",
            holderHandle: "holder-wedge-bind-fourth",
          }),
        /game_session_world_binding_duplicate/,
      );
      // The holder is now discoverable - but only because this test kept the
      // operationId; a real restart does not, and every settle still refuses.
      assert.throws(
        () =>
          reopenedStore.failGameSessionCreation({
            creationRequestId: "wedge-fresh-creation-request",
            gameSessionId: first.gameSessionId,
            expectedRevision: 2,
          }),
        /game_session_metadata_conflict/,
      );
      assert.throws(
        () =>
          reopenedStore.markGameSessionWorldBindingTerminal({
            gameSessionId: first.gameSessionId,
            integrationId: "stardew",
            expectedRevision: 1,
            operationId: "wedge-bind-first-lost",
          }),
        /game_session_world_binding_conflict/,
      );
      // The repair. The successor reads the holder of the slot it wants to free
      // - the handle is the only identity of that holder a restart leaves behind
      // - and releases it with a native verdict that the holder's owner is dead.
      assert.deepEqual(
        reopenedStore.readGameSessionWorldBindingSlotHolder({
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
        }),
        {
          gameSessionId: first.gameSessionId,
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
          status: "registered",
          revision: 1,
          holderHandle: "holder-wedge-bind-first",
        },
      );
      // A guess is refused: the same slot with any other handle is not this
      // holder, and the refusal leaves the abandoned pair exactly as it was.
      assert.throws(
        () =>
          reopenedStore.releaseGameSessionWorldBindingSlot({
            integrationId: "stardew",
            bindingRef: "Farm_389124477",
            holderHandle: "holder-wedge-bind-guessed",
            proof: slotReleaseProof("holder-wedge-bind-guessed"),
          }),
        /game_session_world_binding_slot_handle_mismatch/,
      );
      assert.deepEqual(
        reopenedStore.readGameSessionMetadata({ gameSessionId: first.gameSessionId }),
        { ...first, status: "resumable", revision: 2 },
      );
      assert.deepEqual(
        reopenedStore.releaseGameSessionWorldBindingSlot({
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
          holderHandle: "holder-wedge-bind-first",
          proof: slotReleaseProof("holder-wedge-bind-first"),
        }),
        {
          gameSessionId: first.gameSessionId,
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
          status: "terminal",
          revision: 2,
        },
      );
      // The released holder landed on the canonical settled pair, and its row is
      // still there: nothing was deleted.
      assert.deepEqual(
        reopenedStore.readGameSessionMetadata({ gameSessionId: first.gameSessionId }),
        { ...first, status: "failed", revision: 3 },
      );
      assert.deepEqual(reopenedStore.listResumableGameSessions(), []);
      assert.equal(
        reopenedStore.readGameSessionWorldBinding({ gameSessionId: first.gameSessionId, integrationId: "stardew" })
          ?.status,
        "terminal",
      );
      // The slot is free: the create the duplicate rule refused is accepted.
      assert.equal(
        reopenedStore.registerGameSessionWorldBinding({
          gameSessionId: fourth.gameSessionId,
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
          operationId: "wedge-bind-fourth",
          holderHandle: "holder-wedge-bind-fourth",
        }).status,
        "registered",
      );
      // The slot now resolves to the live holder, not to the settled row that
      // still carries the same slot: a released handle cannot free the slot its
      // successor holds.
      assert.equal(
        reopenedStore.readGameSessionWorldBindingSlotHolder({
          integrationId: "stardew",
          bindingRef: "Farm_389124477",
        })?.holderHandle,
        "holder-wedge-bind-fourth",
      );
      assert.throws(
        () =>
          reopenedStore.releaseGameSessionWorldBindingSlot({
            integrationId: "stardew",
            bindingRef: "Farm_389124477",
            holderHandle: "holder-wedge-bind-first",
            proof: slotReleaseProof("holder-wedge-bind-first"),
          }),
        /game_session_world_binding_slot_handle_mismatch/,
      );
    } finally {
      reopenedControl.close();
    }
  } finally {
    if (!controlClosed) control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("World-slot release requires the holder's own handle and a native lease verdict, and refuses every weaker call", () => {
  // The refusal codes are the contract, so they are pinned literally and the
  // exported bounded set is pinned to be exactly these five.
  assert.deepEqual(Object.values(productionGameSessionWorldBindingSlotRelease).sort(), [
    "game_session_world_binding_slot_handle_mismatch",
    "game_session_world_binding_slot_holder_not_proven_gone",
    "game_session_world_binding_slot_holder_terminal",
    "game_session_world_binding_slot_missing",
    "game_session_world_binding_slot_proof_invalid",
  ]);
  // The verdict is a closed two-value set, and that is the safety property: the
  // held direction of the native probe has no "the holder is alive" member it
  // could be promoted into, so no optimistic reading of a held lease exists.
  assert.deepEqual(Object.values(productionGameSessionWorldBindingSlotLeaseVerdict).sort(), [
    "holder_gone",
    "lease_not_proven_free",
  ]);
  const root = canonicalTestRootSync("production-game-session-slot-release-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  let controlClosed = false;
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const holder = store.createGameSessionMetadata({
      creationRequestId: "release-create-holder",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    const holderBinding = store.registerGameSessionWorldBinding({
      gameSessionId: holder.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_771002311",
      operationId: "release-bind-holder",
      holderHandle: "holder-release-holder",
    });
    // The holder identity has its own slot-addressed surface, so the redacted
    // binding readback stays exactly as redacted as this suite already pins.
    assert.deepEqual(Object.keys(holderBinding).sort(), [
      "bindingRef",
      "gameSessionId",
      "integrationId",
      "revision",
      "status",
    ]);
    const slotHolder = () =>
      store.readGameSessionWorldBindingSlotHolder({ integrationId: "stardew", bindingRef: "Farm_771002311" });
    assert.deepEqual(slotHolder(), {
      gameSessionId: holder.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_771002311",
      status: "registered",
      revision: 1,
      holderHandle: "holder-release-holder",
    });
    assert.equal(
      store.readGameSessionWorldBindingSlotHolder({ integrationId: "stardew", bindingRef: "Farm_000000000" }),
      null,
    );
    assert.equal(
      store.readGameSessionWorldBindingSlotHolder({ integrationId: "other-integration", bindingRef: "Farm_771002311" }),
      null,
    );
    /** The bounded refusal code of one call, or the released binding's status. */
    const outcomeOf =
      (target: typeof store) =>
      (input: unknown): string => {
        try {
          return target.releaseGameSessionWorldBindingSlot(input as never).status;
        } catch (error) {
          return (error as Error).message;
        }
      };
    const outcome = outcomeOf(store);
    const release = (holderHandle: string, proof: unknown) => ({
      integrationId: "stardew",
      bindingRef: "Farm_771002311",
      holderHandle,
      proof,
    });
    // The holder's own proof: the native lease verdict for the holder's lease,
    // carried together with the holder it was obtained for.
    const deadProof = slotReleaseProof("holder-release-holder");
    // A slot nobody holds, and the same slot under another integration, are not
    // this operation's business.
    assert.equal(
      outcome({ integrationId: "stardew", bindingRef: "Farm_000000000", holderHandle: "holder-release-holder", proof: deadProof }),
      "game_session_world_binding_slot_missing",
    );
    assert.equal(
      outcome({ integrationId: "other-integration", bindingRef: "Farm_771002311", holderHandle: "holder-release-holder", proof: deadProof }),
      "game_session_world_binding_slot_missing",
    );
    // The slot alone is not enough: the handle is the holder's identity, not a
    // second name for the slot.
    assert.equal(outcome(release("holder-release-other", deadProof)), "game_session_world_binding_slot_handle_mismatch");
    // A caller-asserted boolean, an unminted look-alike, a structured clone of
    // a real verdict, a caller-asserted verdict STRING and a missing proof are
    // all no proof at all. The clone and the string below are carried in an
    // otherwise well-shaped, correctly correlated proof on purpose: what refuses
    // them is the opaque verdict itself, not the shape of the proof that carries
    // it, and a verdict is a minted token rather than a value a caller may name.
    assert.equal(outcome(release("holder-release-holder", true)), "game_session_world_binding_slot_proof_invalid");
    assert.equal(
      outcome(release("holder-release-holder", { outcome: "holder_gone" })),
      "game_session_world_binding_slot_proof_invalid",
    );
    assert.equal(
      outcome(
        release("holder-release-holder", {
          verdict: { ...deadProof.verdict },
          holderHandle: "holder-release-holder",
        }),
      ),
      "game_session_world_binding_slot_proof_invalid",
    );
    assert.equal(
      outcome(release("holder-release-holder", { verdict: "holder_gone", holderHandle: "holder-release-holder" })),
      "game_session_world_binding_slot_proof_invalid",
    );
    assert.equal(
      outcome(release("holder-release-holder", undefined)),
      "game_session_world_binding_slot_proof_invalid",
    );
    // The held direction of the native probe refuses, and is never read as
    // optimistically gone. It is named for what the probe established - the
    // lease was not shown free - and not as "the holder is alive", which a held
    // same-name mutex cannot establish: the handle under that name may be the
    // Host's own recovery gate for the same name, and Windows exposes no
    // mutex-owner query to attribute it.
    assert.equal(
      outcome(release("holder-release-holder", slotReleaseProof("holder-release-holder", "lease_not_proven_free"))),
      "game_session_world_binding_slot_holder_not_proven_gone",
    );
    // Every refusal above left the abandoned holder exactly as it was: a bounded
    // refusal is never a partial write.
    assert.deepEqual(slotHolder(), {
      gameSessionId: holder.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_771002311",
      status: "registered",
      revision: 1,
      holderHandle: "holder-release-holder",
    });
    assert.deepEqual(store.readGameSessionMetadata({ gameSessionId: holder.gameSessionId }), holder);
    assert.deepEqual(store.listResumableGameSessions(), []);
    // Cross-attempt substitution, the concretely exploitable shape the bare
    // verdict left open: a Host-minted holder-gone verdict obtained about one
    // attempt used to free another holder's slot. The proof now carries the
    // holder it was obtained for, and the release requires that correlation to
    // equal the row's own `holderHandle`, so this substitution is refused with
    // the bounded `proofInvalid` code even though the caller presents the right
    // handle for the slot it targets. Nothing else changes: the holder's own
    // proof below still lands, because a bounded refusal is never a partial
    // write.
    const unrelatedHolder = store.createGameSessionMetadata({
      creationRequestId: "release-create-unrelated",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    store.registerGameSessionWorldBinding({
      gameSessionId: unrelatedHolder.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_771002312",
      operationId: "release-bind-unrelated",
      holderHandle: "holder-release-unrelated",
    });
    const otherHolderDeadProof = slotReleaseProof("holder-release-unrelated");
    assert.equal(
      outcome({
        integrationId: "stardew",
        bindingRef: "Farm_771002311",
        holderHandle: "holder-release-holder",
        proof: otherHolderDeadProof,
      }),
      "game_session_world_binding_slot_proof_invalid",
    );
    assert.deepEqual(slotHolder(), {
      gameSessionId: holder.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_771002311",
      status: "registered",
      revision: 1,
      holderHandle: "holder-release-holder",
    });
    // The correlation binds the proof to the holder; the verdict itself carries
    // no lease name and no owner tuple, and the binding row deliberately carries
    // no owner tuple to compare it against (design/105:70 keeps pids off a
    // session record). One verdict token - even one the composition obtained
    // while probing some other attempt's lease - is therefore still accepted for
    // this holder's slot once the proof names this holder. That is the trust
    // boundary this store does not close and cannot close - it trusts the
    // in-process composition that ran the probe for the holder it names, exactly
    // as the existing settle-proof path does (see
    // `ProductionGameSessionWorldBindingSlotReleaseProof`) - so this assertion
    // stays a boundary statement and is not a safety claim about the verdict, and
    // nothing here independently authenticates who ran the probe. The single
    // token below is deliberately reused for the second holder further down.
    const sharedLeaseVerdict = mintGameSessionWorldBindingSlotLeaseVerdict("holder_gone");
    assert.equal(
      outcome({
        integrationId: "stardew",
        bindingRef: "Farm_771002312",
        holderHandle: "holder-release-unrelated",
        proof: { verdict: sharedLeaseVerdict, holderHandle: "holder-release-unrelated" },
      }),
      "terminal",
    );
    // The release itself: the holder's own handle plus the holder-gone lease
    // verdict, landing on the canonical settled pair that a command-identified
    // settle produces. The verdict token is the same one that freed the unrelated
    // holder above, because nothing in it is bound to a lease or a holder - the
    // boundary just documented.
    assert.equal(
      outcome(release("holder-release-holder", { verdict: sharedLeaseVerdict, holderHandle: "holder-release-holder" })),
      "terminal",
    );
    assert.deepEqual(store.readGameSessionMetadata({ gameSessionId: holder.gameSessionId }), {
      ...holder,
      status: "failed",
      revision: 3,
    });
    assert.equal(
      store.readGameSessionWorldBinding({ gameSessionId: holder.gameSessionId, integrationId: "stardew" })?.status,
      "terminal",
    );
    // The settled holder is still readable - nothing was deleted - and its
    // handle is still visible, so an operator can see who held the slot.
    assert.deepEqual(slotHolder(), {
      gameSessionId: holder.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_771002311",
      status: "terminal",
      revision: 2,
      holderHandle: "holder-release-holder",
    });
    // Terminal is sticky and a repeated call is a bounded refusal, never a no-op
    // that reports success for a call that released nothing.
    assert.equal(outcome(release("holder-release-holder", deadProof)), "game_session_world_binding_slot_holder_terminal");
    // The repaired product outcome: the slot is free for the next create.
    const successor = store.createGameSessionMetadata({
      creationRequestId: "release-create-successor",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    assert.equal(
      store.registerGameSessionWorldBinding({
        gameSessionId: successor.gameSessionId,
        integrationId: "stardew",
        bindingRef: "Farm_771002311",
        operationId: "release-bind-successor",
        holderHandle: "holder-release-successor",
      }).status,
      "registered",
    );
    assert.equal(slotHolder()?.holderHandle, "holder-release-successor");
    control.close();
    controlClosed = true;
    // The settled pair and the released slot survive a restart.
    const reopenedControl = openProductionContinuityStore({ runtimeRoot: root });
    try {
      const reopenedStore = reopenedControl.bindBootstrapContext({
        bootstrap,
        metadata: reopenedControl.validateBootstrap(bootstrap),
      });
      assert.deepEqual(reopenedStore.readGameSessionMetadata({ gameSessionId: holder.gameSessionId }), {
        ...holder,
        status: "failed",
        revision: 3,
      });
      assert.equal(
        reopenedStore.readGameSessionWorldBinding({ gameSessionId: holder.gameSessionId, integrationId: "stardew" })
          ?.status,
        "terminal",
      );
      assert.equal(
        outcomeOf(reopenedStore)(release("holder-release-holder", deadProof)),
        "game_session_world_binding_slot_handle_mismatch",
      );
      assert.equal(
        reopenedStore.readGameSessionWorldBindingSlotHolder({
          integrationId: "stardew",
          bindingRef: "Farm_771002311",
        })?.holderHandle,
        "holder-release-successor",
      );
    } finally {
      reopenedControl.close();
    }
  } finally {
    if (!controlClosed) control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * The refusal that protects a live holder.
 *
 * A held same-name lease is the one answer the native probe cannot attribute, so
 * it must refuse: releasing on it would settle a slot whose holder may still be
 * running. The refusal is therefore pinned to leave both durable facts exactly as
 * the live holder left them - the binding still `registered` at revision 1, the
 * metadata still `pending` at revision 1 - and the holder must still be able to
 * settle itself through its own live command identity afterwards.
 */
test("A slot whose holder's lease is not proven free is refused, and the live holder's slot and pending metadata are untouched", () => {
  const root = canonicalTestRootSync("production-game-session-slot-not-proven-gone-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const holder = store.createGameSessionMetadata({
      creationRequestId: "not-proven-gone-create-holder",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    // The shape a live holder is in while it holds the slot: registration landed,
    // the session is still the pending revision the create left.
    assert.equal(holder.status, "pending");
    assert.equal(holder.revision, 1);
    store.registerGameSessionWorldBinding({
      gameSessionId: holder.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_204553118",
      operationId: "not-proven-gone-bind-holder",
      holderHandle: "holder-not-proven-gone",
    });
    assert.throws(
      () =>
        store.releaseGameSessionWorldBindingSlot({
          integrationId: "stardew",
          bindingRef: "Farm_204553118",
          holderHandle: "holder-not-proven-gone",
          proof: slotReleaseProof("holder-not-proven-gone", "lease_not_proven_free"),
        }),
      /game_session_world_binding_slot_holder_not_proven_gone/,
    );
    // The refusal is not a partial write: the slot the live holder registered is
    // still registered, and its session metadata is still the pending revision
    // the create left, so the live holder still owns the world it bound.
    assert.deepEqual(
      store.readGameSessionWorldBindingSlotHolder({ integrationId: "stardew", bindingRef: "Farm_204553118" }),
      {
        gameSessionId: holder.gameSessionId,
        integrationId: "stardew",
        bindingRef: "Farm_204553118",
        status: "registered",
        revision: 1,
        holderHandle: "holder-not-proven-gone",
      },
    );
    assert.deepEqual(store.readGameSessionMetadata({ gameSessionId: holder.gameSessionId }), holder);
    assert.deepEqual(store.listResumableGameSessions(), []);
    // The live holder is not wedged by the refusal: its own command identity
    // still settles the slot the ordinary way.
    assert.equal(
      store.markGameSessionWorldBindingTerminal({
        gameSessionId: holder.gameSessionId,
        integrationId: "stardew",
        expectedRevision: 1,
        operationId: "not-proven-gone-bind-holder",
      }).status,
      "terminal",
    );
    assert.deepEqual(store.readGameSessionMetadata({ gameSessionId: holder.gameSessionId }), {
      ...holder,
      status: "failed",
      revision: 3,
    });
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("A store written before the holder handle column existed is refused at open, so a handle-less holder cannot exist", () => {
  const root = canonicalTestRootSync("production-game-session-slot-handle-legacy-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const holder = store.createGameSessionMetadata({
      creationRequestId: "legacy-create-holder",
      integrationId: "stardew",
      continuityIdentityId: principal.continuityId,
    });
    store.registerGameSessionWorldBinding({
      gameSessionId: holder.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_551209934",
      operationId: "legacy-bind-holder",
      holderHandle: "holder-legacy-holder",
    });
  } finally {
    control.close();
  }
  try {
    const db = new DatabaseSync(join(root, "gamebuddy-continuity-v1.sqlite"));
    try {
      // A handle is not optional. The column is NOT NULL, so not even an
      // out-of-band writer can erase one and leave a holder this release would
      // have to guess the identity of.
      assert.throws(
        () =>
          db
            .prepare("UPDATE production_game_session_world_binding SET holder_handle=NULL WHERE binding_ref=?")
            .run("Farm_551209934"),
        /NOT NULL constraint failed/,
      );
      // The only shape a store written before this column existed can have is
      // the table without the column, and it is refused at open rather than read
      // with holders whose identity no longer exists or backfilled: a backfill
      // would have to invent the handle of a dead attempt, which is exactly the
      // guess the ruling forbids. Those rows are therefore unreleasable here by
      // construction, and disposing of such a store is an out-of-band operation.
      db.exec("ALTER TABLE production_game_session_world_binding DROP COLUMN holder_handle");
    } finally {
      db.close();
    }
    assert.throws(() => openProductionContinuityStore({ runtimeRoot: root }), /unsupported_production_store_schema/);
  } finally {
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
