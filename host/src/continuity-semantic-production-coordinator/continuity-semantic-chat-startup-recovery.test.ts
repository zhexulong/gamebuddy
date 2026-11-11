/**
 * A Host that dies mid-turn leaves the Chat's current turn durable but non-terminal, and `acceptMounted`
 * refuses every new turn until that turn reaches a terminal status - so the Chat answers every send with
 * `turn_busy` for the life of the root, and no code settles it because the process that owned it exited.
 *
 * These cases drive the real store and the real P5 transition seam, so the readings are the store's and
 * not a double's: the turn is created exactly as a crashed Host leaves it (accepted, claimed, armed,
 * running, then abandoned), the settlement runs through the production function, and what is asserted
 * afterwards is the durable ledger plus the next send's admission.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import type { WindowsOwnerDeathOutcome } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.internal.js";
import { createTestWindowsOwnerDeathVerification } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.test-support.js";
import { identityKey } from "../runtime.js";
import {
  acceptMountedPlayerMessage,
  type ChatTurnLedger,
  claimMountedAttempt,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
  transitionMountedPresentation,
  transitionMountedProviderStart,
} from "../tavern/chat-thread-store.js";
import { createMountedTurnTransitionAuthority } from "../tavern/chat-thread-store.mounted-turn-transition.internal.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  type AbandonedStartedChatTurn,
  settleAbandonedChatTurnOnStartup,
} from "./continuity-semantic-production-coordinator.internal.js";

const principal = Object.freeze({ playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" });
const chat = Object.freeze({ chatThreadId: "thread_01", chatSurfaceSessionId: "surface_01" });
/** A process this test is not: the turn was owned by a Host that has since exited. */
const deadOwnerPid = 4_242;
const ownerOf = (ownerPid: number) =>
  Object.freeze({
    ownerToken: "owner_01",
    runtimeInstanceId: "runtime_01",
    ownerPid,
    ownerProcessStartIdentity: "start_01",
  });

function binding(root: string, ownerPid = deadOwnerPid) {
  return {
    runtimeRoot: root,
    ...principal,
    ...chat,
    selectionGeneration: 1,
    runtimeBindingDigest: "d".repeat(64),
    runtimeOwner: ownerOf(ownerPid),
  };
}

/** The same two-process probe, in one process: every durable step a live Host writes before it dies. */
async function abandonedTurn(root: string, store: ReturnType<typeof createChatThreadStore>, ownerPid: number) {
  await createProfileAwareChatThreadCreationCapability(store, {
    async readExact() {
      return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
    },
  }).createExplicit({
    chatThreadId: chat.chatThreadId,
    companionId: principal.companionId,
    continuityId: principal.continuityId,
    chatSurfaceSessionId: chat.chatSurfaceSessionId,
    opening: "blank",
  });
  await acceptMountedPlayerMessage(binding(root, ownerPid), {
    text: "Hello",
    locale: "en-US",
    idempotencyKey: "abcdefghijklmnopqrstuv",
    expectedDraftRevision: 0,
    authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
  });
  const claimed = await claimMountedAttempt(binding(root, ownerPid));
  const durableAt = async () =>
    (await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId)).thread.updatedAtMs;
  const authority = createMountedTurnTransitionAuthority();
  try {
    const arm = authority.mintOperation();
    try {
      await transitionMountedProviderStart(
        {
          ...binding(root, ownerPid),
          authority: authority.authority,
          operationAuthority: arm.authority,
          attemptId: claimed.attempt.attemptId,
        },
        { operation: "arm", observedAtMs: (await durableAt()) + 1 },
      );
    } finally {
      arm.revoke();
    }
    const running = authority.mintOperation();
    try {
      await transitionMountedProviderStart(
        {
          ...binding(root, ownerPid),
          authority: authority.authority,
          operationAuthority: running.authority,
          attemptId: claimed.attempt.attemptId,
        },
        { operation: "running", statusClass: "success", observedAtMs: (await durableAt()) + 2 },
      );
    } finally {
      running.revoke();
    }
  } finally {
    authority.revoke();
  }
  return claimed.attempt.attemptId;
}

/** The production settlement, driven against this root's real store and real P5 transition seam. */
function settle(root: string, store: ReturnType<typeof createChatThreadStore>, outcome: WindowsOwnerDeathOutcome) {
  const authority = createMountedTurnTransitionAuthority();
  return settleAbandonedChatTurnOnStartup(
    chat,
    async () => (await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId)).turnLedger,
    async (turn: AbandonedStartedChatTurn) => {
      const operation = authority.mintOperation();
      try {
        // The same guard the production caller applies: a settlement is never timed before the turn
        // it closes.
        const failedAtMs = Math.max(
          Date.now(),
          (await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId)).thread.updatedAtMs,
        );
        await transitionMountedPresentation(
          {
            ...binding(root),
            authority: authority.authority,
            operationAuthority: operation.authority,
            selectionGeneration: turn.attempt.selectionGeneration,
            runtimeBindingDigest: turn.attempt.runtimeBindingDigest,
            runtimeOwner: turn.attempt.runtimeOwner,
            attemptId: turn.attempt.attemptId,
          },
          { operation: "fail", reasonCode: "interrupted", failedAtMs },
        );
      } finally {
        operation.revoke();
      }
    },
    Object.freeze({ verify: async (exactOwner) => createTestWindowsOwnerDeathVerification(exactOwner, outcome) }),
  ).finally(() => authority.revoke());
}

async function ledger(store: ReturnType<typeof createChatThreadStore>): Promise<ChatTurnLedger | null> {
  return (await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId)).turnLedger;
}

/** Sends one ordinary player message; the answer is either the receipt or the refusal code. */
async function send(root: string, store: ReturnType<typeof createChatThreadStore>, idempotencyKey: string) {
  const state = await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId);
  return acceptMountedPlayerMessage(binding(root), {
    text: "Are you there?",
    locale: "en-US",
    idempotencyKey,
    expectedDraftRevision: state.draft.revision,
    authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
  });
}

/** Every startup settlement writes one bounded diagnostic line; these tests read it back. */
async function captureDiagnostics<T>(run: () => Promise<T>): Promise<Readonly<{ result: T; diagnostics: string }>> {
  let diagnostics = "";
  const stderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostics += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return Object.freeze({ result: await run(), diagnostics });
  } finally {
    process.stderr.write = stderrWrite;
  }
}

async function fixture(ownerPid = deadOwnerPid) {
  const root = await canonicalTestRoot("gamebuddy-chat-recovery-");
  const store = createChatThreadStore(root, identityKey(principal));
  try {
    const attemptId = await abandonedTurn(root, store, ownerPid);
    return { root, store, attemptId };
  } catch (error) {
    store.close?.();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}

function cleanup(root: string, store: ReturnType<typeof createChatThreadStore>): void {
  store.close?.();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows SQLite cleanup is best effort */
  }
}

test("a Chat whose Host died mid-turn is refused with turn_busy, then settled as interrupted and admitted", async () => {
  const { root, store, attemptId } = await fixture();
  try {
    // The defect, measured on this tree before anything settles it: the durable turn is `running`, its
    // owner is gone, and the store compares no owners, so the next send cannot be admitted.
    assert.equal((await ledger(store))?.status, "running");
    await assert.rejects(send(root, store, "bcdefghijklmnopqrstuvw"), /turn_busy/);

    const { result, diagnostics } = await captureDiagnostics(() => settle(root, store, "proven_dead"));

    // The settlement names the Chat, the turn, the process that owed it, and what the OS said.
    assert.equal(result?.settlement, "settled");
    assert.equal(result?.code, "chat_turn_recovery_settled");
    assert.equal(result?.turnStatus, "running");
    assert.equal(result?.ownerPid, deadOwnerPid);
    assert.equal(result?.ownerOutcome, "proven_dead");
    assert.match(diagnostics, /^\[chat-recovery\] startup /u);
    assert.match(diagnostics, /chat=thread_01/u);
    assert.match(diagnostics, /turn=turn_/u);
    assert.match(diagnostics, /state=running/u);
    assert.match(diagnostics, new RegExp(`owner_pid=${deadOwnerPid}`, "u"));
    assert.match(diagnostics, /owner=proven_dead/u);

    // What the player opens next: the abandoned turn is explained, not vanished, and the exact attempt
    // it lost travels with it.
    const settled = await ledger(store);
    assert.equal(settled?.status, "failed");
    assert.equal(settled?.status === "failed" ? settled.reasonCode : undefined, "interrupted");
    assert.equal(settled?.status === "failed" ? settled.attempt.attemptId : undefined, attemptId);
    assert.equal(settled?.status === "failed" ? settled.observation.phase : undefined, "running");

    // And the next send is admitted by the ordinary gate, unchanged.
    const accepted = await send(root, store, "bcdefghijklmnopqrstuvw");
    assert.equal(accepted.status, "accepted_queued");
  } finally {
    cleanup(root, store);
  }
});

test("a second mount finds nothing to settle and settles nothing", async () => {
  const { root, store } = await fixture();
  try {
    const first = await settle(root, store, "proven_dead");
    const { result: second, diagnostics } = await captureDiagnostics(() => settle(root, store, "proven_dead"));
    assert.equal(first?.settlement, "settled");
    // A second Host re-reads the same durable ledger, which is now terminal: no second settlement, and
    // no line claiming one.
    assert.equal(second, null);
    assert.equal(diagnostics, "");
    assert.equal((await ledger(store))?.status, "failed");
  } finally {
    cleanup(root, store);
  }
});

test("a living owner is refused as a single-instance conflict and the turn is left exactly as it was", async () => {
  const { root, store } = await fixture();
  try {
    const before = await ledger(store);
    const { diagnostics } = await captureDiagnostics(async () => {
      await assert.rejects(settle(root, store, "alive"), /chat_turn_recovery_blocked_owner_alive/u);
    });
    assert.match(diagnostics, /another GameBuddy is already running/u);
    assert.doesNotMatch(diagnostics, /owner=unavailable|could not be proven/u);
    // Nothing changed: same turn, same status, and the send is still refused for the same reason.
    assert.deepEqual(await ledger(store), before);
    await assert.rejects(send(root, store, "bcdefghijklmnopqrstuvw"), /turn_busy/);
  } finally {
    cleanup(root, store);
  }
});

test("a turn this process is still running is left to its own runner instead of stopping the mount", async () => {
  // A reload can mount a Chat while this same process still owns a turn in it. That is not a crash
  // residue, and no code outside the turn's own runner may terminalize it - but it is also not a
  // single-instance conflict, so it is reported and the mount goes on.
  const { root, store } = await fixture(process.pid);
  try {
    const before = await ledger(store);
    const { result, diagnostics } = await captureDiagnostics(() => settle(root, store, "alive"));
    assert.equal(result?.settlement, "refused");
    assert.equal(result?.code, "chat_turn_recovery_blocked_turn_active");
    assert.equal(result?.ownerPid, process.pid);
    assert.match(diagnostics, /only its own runner may settle it/u);
    assert.doesNotMatch(diagnostics, /another GameBuddy is already running/u);
    assert.deepEqual(await ledger(store), before);
  } finally {
    cleanup(root, store);
  }
});

for (const outcome of ["mismatch", "ambiguous", "unavailable"] as const)
  test(`an ${outcome} owner verdict is unknown, so the turn is left untouched and the refusal says which condition blocked it`, async () => {
    const { root, store } = await fixture();
    try {
      const before = await ledger(store);
      const { diagnostics } = await captureDiagnostics(async () => {
        await assert.rejects(settle(root, store, outcome), /chat_turn_recovery_blocked_owner_unknown/u);
      });
      assert.match(diagnostics, new RegExp(`owner=${outcome}`, "u"));
      assert.match(diagnostics, /could not be proven/u);
      assert.doesNotMatch(diagnostics, /another GameBuddy is already running/u);
      assert.deepEqual(await ledger(store), before);
      await assert.rejects(send(root, store, "bcdefghijklmnopqrstuvw"), /turn_busy/);
    } finally {
      cleanup(root, store);
    }
  });

test("a turn with no started prompt is named and left untouched instead of settled into a shape it has no evidence for", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-recovery-unstarted-");
  const store = createChatThreadStore(root, identityKey(principal));
  try {
    await createProfileAwareChatThreadCreationCapability(store, {
      async readExact() {
        return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
      },
    }).createExplicit({
      chatThreadId: chat.chatThreadId,
      companionId: principal.companionId,
      continuityId: principal.continuityId,
      chatSurfaceSessionId: chat.chatSurfaceSessionId,
      opening: "blank",
    });
    await acceptMountedPlayerMessage(binding(root), {
      text: "Hello",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
      authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
    });
    const { result, diagnostics } = await captureDiagnostics(() => settle(root, store, "proven_dead"));
    // No prompt ever started, so there is nothing to interrupt - and `failed` carries the observation of
    // a prompt that started, which this turn does not have. It is reported, not invented.
    assert.equal(result?.settlement, "refused");
    assert.equal(result?.code, "chat_turn_recovery_blocked_turn_state");
    assert.equal(result?.turnStatus, "accepted_queued");
    assert.equal(result?.ownerPid, null);
    assert.equal(result?.ownerOutcome, null);
    assert.match(diagnostics, /state=accepted_queued/u);
    assert.match(diagnostics, /no started prompt/u);
    assert.equal((await ledger(store))?.status, "accepted_queued");
  } finally {
    cleanup(root, store);
  }
});

test("a Chat with no current turn owes no recovery and says nothing", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-recovery-idle-");
  const store = createChatThreadStore(root, identityKey(principal));
  try {
    await createProfileAwareChatThreadCreationCapability(store, {
      async readExact() {
        return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
      },
    }).createExplicit({
      chatThreadId: chat.chatThreadId,
      companionId: principal.companionId,
      continuityId: principal.continuityId,
      chatSurfaceSessionId: chat.chatSurfaceSessionId,
      opening: "blank",
    });
    const { result, diagnostics } = await captureDiagnostics(() => settle(root, store, "proven_dead"));
    assert.equal(result, null);
    assert.equal(diagnostics, "");
  } finally {
    cleanup(root, store);
  }
});
