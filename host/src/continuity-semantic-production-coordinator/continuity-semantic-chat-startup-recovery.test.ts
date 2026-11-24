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
  type PresentationTransition,
  transitionMountedPresentation,
  transitionMountedProviderStart,
} from "../tavern/chat-thread-store.js";
import { createMountedTurnTransitionAuthority } from "../tavern/chat-thread-store.mounted-turn-transition.internal.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  type AbandonedClaimedCancelChatTurn,
  type AbandonedStartedChatTurn,
  settleAbandonedChatTurnOnStartup,
  settleNeverStartedChatTurnOnMount,
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

/**
 * The generation steps a dead Host can be interrupted at, each of which leaves a durable
 * non-terminal turn. `running` is the step every later one passes through.
 */
type AbandonedStep = "running" | "presentation_committed" | "completion_claimed" | "cancel_claimed";

/** The same two-process probe, in one process: every durable step a live Host writes before it dies. */
async function abandonedTurn(
  root: string,
  store: ReturnType<typeof createChatThreadStore>,
  ownerPid: number,
  upTo: AbandonedStep = "running",
) {
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
  /** The P5 transitions of one abandoned turn, each under its own operation authority. */
  const presentation = async (command: PresentationTransition): Promise<void> => {
    const operation = authority.mintOperation();
    try {
      await transitionMountedPresentation(
        {
          ...binding(root, ownerPid),
          authority: authority.authority,
          operationAuthority: operation.authority,
          selectionGeneration: claimed.attempt.selectionGeneration,
          runtimeBindingDigest: claimed.attempt.runtimeBindingDigest,
          runtimeOwner: claimed.attempt.runtimeOwner,
          attemptId: claimed.attempt.attemptId,
        },
        command,
      );
    } finally {
      operation.revoke();
    }
  };
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
    if (upTo === "running") return claimed.attempt.attemptId;
    const committedAtMs = (await durableAt()) + 3;
    await presentation({
      operation: "commit_presentation",
      cancelEpoch: 1,
      message: { messageId: "companion_reply_01", text: "I am still here.", occurredAtMs: committedAtMs },
      committedAtMs,
    });
    if (upTo === "cancel_claimed") {
      // Another authority won this turn's durable cancel while the prompt was still generating, after the
      // reply had already been presented: the claim is the winner and the final `cancel` was never written.
      await presentation({ operation: "claim_cancel", claimedAtMs: (await durableAt()) + 4 });
      return claimed.attempt.attemptId;
    }
    if (upTo === "presentation_committed") return claimed.attempt.attemptId;
    await presentation({ operation: "claim_completion", claimedAtMs: (await durableAt()) + 4 });
    return claimed.attempt.attemptId;
  } finally {
    authority.revoke();
  }
}

/** The production settlement, driven against this root's real store and real P5 transition seam. */
function settle(root: string, store: ReturnType<typeof createChatThreadStore>, outcome: WindowsOwnerDeathOutcome) {
  const authority = createMountedTurnTransitionAuthority();
  /** One P5 transition written the way the settlement writes it: after the turn's own last durable write. */
  const transition = async (
    attempt: AbandonedStartedChatTurn["attempt"],
    terminal: (atMs: number) => PresentationTransition,
  ): Promise<void> => {
    const operation = authority.mintOperation();
    try {
      const atMs = Math.max(
        Date.now(),
        (await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId)).thread.updatedAtMs,
      );
      await transitionMountedPresentation(
        {
          ...binding(root),
          authority: authority.authority,
          operationAuthority: operation.authority,
          selectionGeneration: attempt.selectionGeneration,
          runtimeBindingDigest: attempt.runtimeBindingDigest,
          runtimeOwner: attempt.runtimeOwner,
          attemptId: attempt.attemptId,
        },
        terminal(atMs),
      );
    } finally {
      operation.revoke();
    }
  };
  return settleAbandonedChatTurnOnStartup(
    chat,
    async () => (await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId)).turnLedger,
    async (turn: AbandonedStartedChatTurn) =>
      transition(turn.attempt, (failedAtMs) => ({ operation: "fail", reasonCode: "interrupted", failedAtMs })),
    async (turn: AbandonedClaimedCancelChatTurn) =>
      transition(turn.attempt, (cancelledAtMs) => ({ operation: "cancel", cancelledAtMs })),
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

async function fixture(ownerPid = deadOwnerPid, upTo: AbandonedStep = "running") {
  const root = await canonicalTestRoot("gamebuddy-chat-recovery-");
  const store = createChatThreadStore(root, identityKey(principal));
  try {
    const attemptId = await abandonedTurn(root, store, ownerPid, upTo);
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

/**
 * The whole two-half settlement, with the mount's cancel seam replaced by the store transitions it
 * drives: claim (only when nothing was claimed), arm, then the ordinary turn-level cancel. The seam's
 * own wiring is the mount's, and the switch suite drives that against a real runtime; what this pins is
 * the DECISION - which shapes are deferred, and that the durable ledger ends terminal and admits a send.
 */
async function settleNeverStarted(
  root: string,
  store: ReturnType<typeof createChatThreadStore>,
  outcome: WindowsOwnerDeathOutcome,
) {
  const transitionAuthority = createMountedTurnTransitionAuthority();
  const read = async () => (await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId)).turnLedger;
  const durableAt = async () =>
    (await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId)).thread.updatedAtMs;
  try {
    const preMount = await settleAbandonedChatTurnOnStartup(
      chat,
      read,
      async () => {
        throw new Error("a turn that never started must not be settled as an interrupted prompt");
      },
      async () => {
        throw new Error("a turn that never started was never claimed into a cancel");
      },
      Object.freeze({
        verify: async (exactOwner) => createTestWindowsOwnerDeathVerification(exactOwner, outcome),
      }),
    );
    if (preMount?.settlement !== "deferred") return preMount;
    return await settleNeverStartedChatTurnOnMount(preMount, read, async () => {
      let turn = await read();
      if (turn?.status === "accepted_queued") turn = await claimMountedAttempt(binding(root));
      if (turn?.status !== "attempt_starting") throw new Error("never_started_settlement_source_unavailable");
      const observedAtMs = (await durableAt()) + 1;
      const arm = transitionAuthority.mintOperation();
      try {
        if (turn.observation === undefined)
          await transitionMountedProviderStart(
            {
              ...binding(root),
              authority: transitionAuthority.authority,
              operationAuthority: arm.authority,
              attemptId: turn.attempt.attemptId,
            },
            { operation: "arm", observedAtMs },
          );
      } finally {
        arm.revoke();
      }
      const cancel = transitionAuthority.mintOperation();
      try {
        await transitionMountedProviderStart(
          {
            ...binding(root),
            authority: transitionAuthority.authority,
            operationAuthority: cancel.authority,
            attemptId: turn.attempt.attemptId,
          },
          { operation: "cancel", observedAtMs: observedAtMs + 1, cancelledAtMs: observedAtMs + 1 },
        );
      } finally {
        cancel.revoke();
      }
    });
  } finally {
    transitionAuthority.revoke();
  }
}

test("a turn accepted before its owner died is settled through the mount's own cancel seam, and the Chat accepts again", async () => {
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
    // The defect, measured on this tree before the settlement runs: the turn is durable and non-terminal,
    // and the ordinary admission gate refuses every send with `turn_busy` - for the life of the root.
    assert.equal((await ledger(store))?.status, "accepted_queued");
    await assert.rejects(send(root, store, "bcdefghijklmnopqrstuvw"), /turn_busy/u);

    const { result, diagnostics } = await captureDiagnostics(() => settleNeverStarted(root, store, "proven_dead"));
    // A turn whose prompt never started has no `failed` shape (that one carries the observation of a
    // prompt that started), so it is deferred to the mount and closed by the one cancel seam there.
    assert.equal(result?.settlement, "settled");
    assert.equal(result?.code, "chat_turn_recovery_settled_never_started");
    assert.equal(result?.turnStatus, "accepted_queued");
    assert.equal(result?.ownerPid, null);
    assert.match(diagnostics, /handing the turn that never started to the mount's own cancel seam/u);
    assert.match(diagnostics, /as cancelled; the next message is accepted/u);

    // What the player gets: a terminal turn with no reply, the player's own line still there, and a Chat
    // that admits the next message.
    const settled = await ledger(store);
    assert.equal(settled?.status, "cancelled");
    assert.equal(settled?.status === "cancelled" ? settled.presentation : undefined, null);
    assert.equal(settled?.status === "cancelled" ? settled.observation.phase : undefined, "armed");
    const accepted = await send(root, store, "bcdefghijklmnopqrstuvw");
    assert.equal(accepted.status, "accepted_queued");
  } finally {
    cleanup(root, store);
  }
});

test("a turn claimed but never armed by its dead owner is settled the same way, and the Chat accepts again", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-recovery-claimed-only-");
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
    // The arm step never landed: the claim is durable, the prompt was never invoked, nothing is running.
    await claimMountedAttempt(binding(root));
    assert.equal((await ledger(store))?.status, "attempt_starting");
    await assert.rejects(send(root, store, "bcdefghijklmnopqrstuvw"), /turn_busy/u);

    const { result } = await captureDiagnostics(() => settleNeverStarted(root, store, "proven_dead"));
    assert.equal(result?.settlement, "settled");
    assert.equal(result?.turnStatus, "attempt_starting");
    assert.equal(result?.ownerPid, deadOwnerPid);
    assert.equal(result?.ownerOutcome, "proven_dead");
    assert.equal((await ledger(store))?.status, "cancelled");
    assert.equal((await send(root, store, "bcdefghijklmnopqrstuvw")).status, "accepted_queued");
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

/**
 * How every non-terminal turn a dead Host can leave ends.
 *
 * The population is the ledger's own non-terminal statuses rather than a list someone remembered:
 * `Record<NonTerminalTurnStatus, …>` stops compiling the moment `ChatTurnLedger` gains a status, and the
 * table has no spelling for a refusal - a ledger state with no forward path is the defect this file exists
 * to catch, so it is not an outcome the table admits. The four started steps are driven below through the
 * real store; the two steps a turn can die at before its prompt starts are driven by `settleNeverStarted`,
 * in their own two cases above.
 */
type NonTerminalTurnStatus = Exclude<ChatTurnLedger["status"], "completed" | "cancelled" | "failed">;

type HostDeathOutcome =
  | Readonly<{ settlement: "deferred"; code: "chat_turn_recovery_deferred_to_mount" }>
  | Readonly<{ settlement: "settled"; code: string; terminal: "failed" | "cancelled" }>;

const HOST_DEATH_OUTCOMES: Record<NonTerminalTurnStatus, HostDeathOutcome> = {
  accepted_queued: { settlement: "deferred", code: "chat_turn_recovery_deferred_to_mount" },
  attempt_starting: { settlement: "deferred", code: "chat_turn_recovery_deferred_to_mount" },
  running: { settlement: "settled", code: "chat_turn_recovery_settled", terminal: "failed" },
  presentation_committed: { settlement: "settled", code: "chat_turn_recovery_settled", terminal: "failed" },
  completion_claimed: { settlement: "settled", code: "chat_turn_recovery_settled", terminal: "failed" },
  // The member that had no forward path at all: its durable cancel claim was answered with `turn_busy` for
  // the life of the root, because the runner that owed the final `cancel` was the process that died. It now
  // ends as the `cancelled` turn a live cancel leaves.
  cancel_claimed: { settlement: "settled", code: "chat_turn_recovery_settled_cancel_claimed", terminal: "cancelled" },
};

/** The steps this file drives itself; the rest are the two deferred ones, proven above. */
const STARTED_DEATH_STEPS: readonly AbandonedStep[] = Object.freeze([
  "running",
  "presentation_committed",
  "completion_claimed",
  "cancel_claimed",
] as const);

test("every step a dead Host can leave a started turn in ends the way this table says, and the Chat answers after it", async (t) => {
  const undeclared = (Object.keys(HOST_DEATH_OUTCOMES) as NonTerminalTurnStatus[]).filter(
    (status) => !STARTED_DEATH_STEPS.some((step) => step === status),
  );
  assert.deepEqual(
    undeclared,
    ["accepted_queued", "attempt_starting"],
    "a non-terminal turn status this file neither drives nor names as proven elsewhere",
  );
  t.diagnostic(
    `turn death steps: ${STARTED_DEATH_STEPS.length} driven here, declared ${Object.keys(HOST_DEATH_OUTCOMES).length} non-terminal statuses - ${STARTED_DEATH_STEPS.map((step) => `${step}:${HOST_DEATH_OUTCOMES[step].settlement}`).join(", ")}`,
  );

  for (const step of STARTED_DEATH_STEPS) {
    const expected = HOST_DEATH_OUTCOMES[step];
    const { root, store, attemptId } = await fixture(deadOwnerPid, step);
    try {
      // The store really is in that step: the fixture drove the real transitions, it did not seed a row.
      const abandoned = await ledger(store);
      assert.equal(abandoned?.status, step, `the fixture left the turn in ${String(abandoned?.status)}`);
      await assert.rejects(
        send(root, store, "bcdefghijklmnopqrstuvw"),
        /turn_busy/u,
        `${step}: a live turn blocks the next send`,
      );

      const { result, diagnostics } = await captureDiagnostics(() => settle(root, store, "proven_dead"));
      assert.equal(result?.settlement, expected.settlement, `${step}`);
      assert.equal(result?.code, expected.code, `${step}`);
      assert.equal(result?.turnStatus, step, `${step}: the settlement names the step it found`);
      assert.equal(result?.ownerOutcome, "proven_dead", `${step}: the settlement names what the OS said`);
      assert.match(diagnostics, new RegExp(`state=${step}`, "u"), `${step}: the diagnostic names the state`);
      if (expected.settlement !== "settled") assert.fail(`${step}: every step driven here has a forward path`);

      const settled = await ledger(store);
      if (settled?.status === "failed") {
        assert.equal(expected.terminal, "failed", `${step}: this step ends as the failed turn it is`);
        assert.equal(settled.reasonCode, "interrupted", `${step}: the prompt it lost is explained as interrupted`);
      } else if (settled?.status === "cancelled") {
        assert.equal(expected.terminal, "cancelled", `${step}: this step ends as the cancelled turn it is`);
        // The terminal a LIVE cancel leaves, which is the point of the cancel-claim case: the claim the dead
        // owner won keeps its own stamp, the reply already presented stays readable in the transcript, and
        // the row is the same `cancelled` turn an ordinary Stop would have produced.
        assert.equal(
          settled.cancelClaimedAtMs,
          abandoned?.status === "cancel_claimed" ? abandoned.cancelClaimedAtMs : undefined,
          `${step}: the claim's own stamp is preserved, not re-minted`,
        );
        assert.ok(
          settled.cancelledAtMs >= settled.cancelClaimedAtMs,
          `${step}: the terminal is not timed before the claim it finishes`,
        );
        assert.equal(
          settled.presentation?.expressionId,
          "companion_reply_01",
          `${step}: the reply the claim interrupted stays readable`,
        );
      } else {
        assert.fail(`${step}: the abandoned turn is still ${settled === null ? "no ledger" : settled.status}`);
      }
      assert.equal(settled.attempt.attemptId, attemptId, `${step}: the exact attempt it lost travels with it`);
      assert.equal(settled.observation.phase, "running", `${step}: the observation it held travels with it`);
      // A reply that had already reached the transcript stays visible; a turn that never got that far keeps
      // no presentation at all.
      if (step === "presentation_committed" || step === "completion_claimed") {
        assert.equal(
          settled.presentation?.expressionId,
          "companion_reply_01",
          `${step}: the committed reply stays readable`,
        );
        assert.equal(
          (await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId)).messages.some(
            (message) => message.messageId === "companion_reply_01",
          ),
          true,
          `${step}: its transcript row stays`,
        );
      } else if (settled.status === "failed") {
        assert.equal(settled.presentation, null, `${step}: nothing was presented, so nothing is claimed`);
      }
      assert.equal((await send(root, store, "cdefghijklmnopqrstuvwx")).status, "accepted_queued", `${step}`);
    } finally {
      cleanup(root, store);
    }
  }
});

test("a claimed cancel whose owner is still alive is refused by name, and the claim is left exactly as it was", async () => {
  const { root, store } = await fixture(deadOwnerPid, "cancel_claimed");
  try {
    const before = await ledger(store);
    const { diagnostics } = await captureDiagnostics(async () => {
      await assert.rejects(settle(root, store, "alive"), /chat_turn_recovery_blocked_owner_alive/u);
    });
    assert.match(diagnostics, /state=cancel_claimed/u);
    assert.match(diagnostics, new RegExp(`owner_pid=${deadOwnerPid}`, "u"));
    assert.match(diagnostics, /another GameBuddy is already running/u);
    // Nothing changed: the claim is still the winner, and the send is still refused for the same reason.
    assert.deepEqual(await ledger(store), before);
    await assert.rejects(send(root, store, "bcdefghijklmnopqrstuvw"), /turn_busy/u);
  } finally {
    cleanup(root, store);
  }
});

for (const outcome of ["mismatch", "ambiguous", "unavailable"] as const)
  test(`a claimed cancel with an ${outcome} owner verdict is refused with its reason instead of settled`, async () => {
    const { root, store } = await fixture(deadOwnerPid, "cancel_claimed");
    try {
      const before = await ledger(store);
      const { diagnostics } = await captureDiagnostics(async () => {
        await assert.rejects(settle(root, store, outcome), /chat_turn_recovery_blocked_owner_unknown/u);
      });
      assert.match(diagnostics, /state=cancel_claimed/u);
      assert.match(diagnostics, new RegExp(`owner=${outcome}`, "u"));
      assert.match(diagnostics, /could not be proven/u);
      assert.doesNotMatch(diagnostics, /another GameBuddy is already running/u);
      assert.deepEqual(await ledger(store), before);
      await assert.rejects(send(root, store, "bcdefghijklmnopqrstuvw"), /turn_busy/u);
    } finally {
      cleanup(root, store);
    }
  });
