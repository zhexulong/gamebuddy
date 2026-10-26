import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  claimMountedAttempt,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
  transitionMountedProviderStart as rawTransitionP4MountedProviderStart,
  transitionMountedPresentation as rawTransitionP5MountedPresentation,
} from "./chat-thread-store.js";
import { createMountedTurnTransitionAuthority } from "./chat-thread-store.mounted-turn-transition.internal.js";

/**
 * P6 durable cancel authority prerequisite - characterization.
 *
 * This suite pins the exact fail-closed behavior of the existing durable
 * state machine for queued (`accepted_queued`/`attempt_starting`) cancel
 * attempts and proves the two structural facts that block the P6 route:
 *
 * 1. The frozen ledger types/validators (`CancelClaimedTurn`/`CancelledTurn`
 *    derive from `RunningTurn`, which requires an attempt plus a durable
 *    `running` observation written solely by the source-owned
 *    `after_provider_response` observer) leave NO legal durable artifact
 *    shape for a queued-source P5 `claim_cancel`. Every queued claim_cancel
 *    attempt fails closed with zero durable mutation, and the rejection never
 *    poisons the later P4c start/presentation path.
 * 2. The existing acceptance `idempotency` record family cannot host a
 *    cancel result; a cancel-specific record would be a new artifact family
 *    outside the current v2 store boundary (an owner decision, not a seam).
 *
 * It then pins the one ordinary exit a pre-invocation attempt does have: the
 * P4c provider-start `cancel` accepts a durable `not_started` source and writes
 * the same `cancelled` terminal the armed source writes, preserving the
 * attempt and the observation, while the validator keeps rejecting the rows
 * that would make that shape dishonest.
 */

const testTransitionAuthority = createMountedTurnTransitionAuthority();
const transitionMountedProviderStart = async (
  binding: Omit<Parameters<typeof rawTransitionP4MountedProviderStart>[0], "authority" | "operationAuthority">,
  command: Parameters<typeof rawTransitionP4MountedProviderStart>[1],
) => {
  const operation = testTransitionAuthority.mintOperation();
  try {
    return await rawTransitionP4MountedProviderStart(
      { authority: testTransitionAuthority.authority, operationAuthority: operation.authority, ...binding },
      command,
    );
  } finally {
    operation.revoke();
  }
};
const transitionMountedPresentation = async (
  binding: Omit<Parameters<typeof rawTransitionP5MountedPresentation>[0], "authority" | "operationAuthority">,
  command: Parameters<typeof rawTransitionP5MountedPresentation>[1],
) => {
  const operation = testTransitionAuthority.mintOperation();
  try {
    return await rawTransitionP5MountedPresentation(
      { authority: testTransitionAuthority.authority, operationAuthority: operation.authority, ...binding },
      command,
    );
  } finally {
    operation.revoke();
  }
};

const bindingFor = (root: string) =>
  ({
    runtimeRoot: root,
    playerId: "player_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    selectionGeneration: 3,
    runtimeBindingDigest: "d".repeat(64),
    runtimeOwner: {
      ownerToken: "owner_01",
      runtimeInstanceId: "runtime_01",
      ownerPid: 1,
      ownerProcessStartIdentity: "start_01",
    },
  }) as const;
const continuityKey = createHash("sha256")
  .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
  .digest("hex");
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/**
 * Builds an exact thread with one accepted player turn and drives it to the
 * requested pre-running durable ledger state. Returns the store and the exact
 * claimed attemptId (empty for `accepted_queued`).
 */
async function prepare(
  root: string,
  target: "accepted_queued" | "attempt_starting" | "armed" | "not_started" | "running",
): Promise<Readonly<{ store: ReturnType<typeof createChatThreadStore>; attemptId: string }>> {
  const store = createChatThreadStore(
    root,
    continuityKey,
    (() => {
      let current = 100;
      return () => current++;
    })(),
  );
  const creation = createProfileAwareChatThreadCreationCapability(store, {
    async readExact() {
      return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
    },
  });
  await creation.createExplicit({
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    opening: "blank",
  });
  const { acceptMountedPlayerMessage } = await import("./chat-thread-store.js");
  const binding = bindingFor(root);
  await acceptMountedPlayerMessage(binding, {
    text: "Hello",
    locale: "en-US",
    idempotencyKey: "abcdefghijklmnopqrstuv",
    expectedDraftRevision: 0,
    authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
  });
  if (target === "accepted_queued") return { store, attemptId: "" };
  const claimed = await claimMountedAttempt(binding);
  const attemptId = claimed.attempt.attemptId;
  if (target === "attempt_starting") return { store, attemptId };
  const prefix = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
  await transitionMountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "arm", observedAtMs: prefix + 1 },
  );
  if (target === "armed") return { store, attemptId };
  if (target === "not_started") {
    await transitionMountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "not_started", reasonCode: "admission_revoked", observedAtMs: prefix + 2 },
    );
    return { store, attemptId };
  }
  await transitionMountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "running", statusClass: "success", observedAtMs: prefix + 2 },
  );
  return { store, attemptId };
}

test("cancel authority prerequisite: claim_cancel rejects an accepted_queued turn with zero mutation and no later-activation poisoning", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-accepted-");
  let closeStore: (() => void) | undefined;
  try {
    const { store } = await prepare(root, "accepted_queued");
    closeStore = () => store.close?.();
    const before = await store.resumeThread("thread_01", "surface_01");
    // A queued turn has no attempt claim, so the exact-attempt P5 port refuses
    // it before any cancel CAS can be evaluated.
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId: "attempt_pending_01" },
          { operation: "claim_cancel", claimedAtMs: 200 },
        ),
      /p5_presentation_claim_missing/,
    );
    const after = await store.resumeThread("thread_01", "surface_01");
    assert.deepEqual(after, before);
    assert.equal(after.turnLedger?.status, "accepted_queued");
    assert.equal(after.messages.length, 1);
    assert.equal(after.idempotency.length, 1);
    // The rejection is side-effect free: the later P4b/P4c path (claim → arm →
    // running → presentation activation/commit → completion) stays fully
    // usable, i.e. the rejected cancel did not poison the later activation.
    const claimed = await claimMountedAttempt(bindingFor(root));
    const attemptId = claimed.attempt.attemptId;
    const prefix = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
    await transitionMountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "arm", observedAtMs: prefix + 1 },
    );
    await transitionMountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "running", statusClass: "success", observedAtMs: prefix + 2 },
    );
    const committedAt = prefix + 3;
    const committed = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_presentation",
        cancelEpoch: 0,
        message: {
          messageId: "response_after_rejected_cancel_01",
          text: "Visible after rejected cancel.",
          occurredAtMs: committedAt,
        },
        committedAtMs: committedAt,
      },
    );
    assert.equal(committed.status, "presentation_committed");
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: claim_cancel rejects attempt_starting sources until durable running, with zero mutation at each rejection", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-starting-");
  let closeStore: (() => void) | undefined;
  try {
    const { store, attemptId } = await prepare(root, "attempt_starting");
    closeStore = () => store.close?.();
    const unarmed = await store.resumeThread("thread_01", "surface_01");
    assert.equal(unarmed.turnLedger?.status, "attempt_starting");
    assert.equal(unarmed.turnLedger?.observation, undefined);
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_cancel", claimedAtMs: unarmed.thread.updatedAtMs + 1 },
        ),
      /p5_presentation_cancel_source_required/,
    );
    assert.deepEqual(await store.resumeThread("thread_01", "surface_01"), unarmed);

    // The rejection never closes/poisons the start path: arm is still legal.
    const prefix = unarmed.thread.updatedAtMs;
    await transitionMountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "arm", observedAtMs: prefix + 1 },
    );
    const armed = await store.resumeThread("thread_01", "surface_01");
    assert.equal(armed.turnLedger?.status, "attempt_starting");
    assert.equal(armed.turnLedger?.observation?.phase, "armed");
    // A durable `armed` attempt (provider prompt may already be in flight) is
    // still not a legal cancel source.
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_cancel", claimedAtMs: prefix + 2 },
        ),
      /p5_presentation_cancel_source_required/,
    );
    assert.deepEqual(await store.resumeThread("thread_01", "surface_01"), armed);

    // Cancel becomes reachable only after the source-owned durable `running`
    // observation exists.
    await transitionMountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "running", statusClass: "success", observedAtMs: prefix + 2 },
    );
    const runningBase = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
    const claimedCancel = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: runningBase + 1 },
    );
    assert.equal(claimedCancel.status, "cancel_claimed");
    const cancelled = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: runningBase + 2 },
    );
    assert.equal(cancelled.status, "cancelled");
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: claim_cancel rejects a not_started attempt with zero mutation", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-not-started-");
  let closeStore: (() => void) | undefined;
  try {
    const { store, attemptId } = await prepare(root, "not_started");
    closeStore = () => store.close?.();
    const before = await store.resumeThread("thread_01", "surface_01");
    assert.equal(before.turnLedger?.status, "attempt_starting");
    assert.equal(before.turnLedger?.observation?.phase, "not_started");
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_cancel", claimedAtMs: before.thread.updatedAtMs + 1 },
        ),
      /p5_presentation_cancel_source_required/,
    );
    assert.deepEqual(await store.resumeThread("thread_01", "surface_01"), before);
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: active P5 cancel and completion-first arbitration are unchanged", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-active-");
  let closeStore: (() => void) | undefined;
  try {
    const { store, attemptId } = await prepare(root, "running");
    closeStore = () => store.close?.();
    const base = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;

    // Active cancel: claim → repeat claim (stable) → late presentation
    // rejected → terminal cancelled; repeat terminal cancel is stable.
    const claimedCancel = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 1 },
    );
    assert.equal(claimedCancel.status, "cancel_claimed");
    const repeatedClaim = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 2 },
    );
    assert.deepEqual(repeatedClaim, claimedCancel);
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          {
            operation: "commit_presentation",
            cancelEpoch: 0,
            message: { messageId: "response_late_01", text: "Late.", occurredAtMs: base + 3 },
            committedAtMs: base + 3,
          },
        ),
      /p5_presentation_source_running_required/,
    );
    const cancelled = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 4 },
    );
    assert.equal(cancelled.status, "cancelled");
    const repeatedCancel = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 5 },
    );
    assert.equal(repeatedCancel.status, "cancelled");
    const terminal = await store.resumeThread("thread_01", "surface_01");
    assert.equal(terminal.messages.filter((message) => message.kind === "response").length, 0);

    // Completion-first: cancel loses the arbitration at the store CAS and the
    // terminal completion stays stable.
    const secondRoot = await canonicalTestRoot("gamebuddy-cancel-auth-complete-");
    let closeSecond: (() => void) | undefined;
    try {
      const second = await prepare(secondRoot, "running");
      closeSecond = () => second.store.close?.();
      const secondBase = (await second.store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
      await transitionMountedPresentation(
        { ...bindingFor(secondRoot), attemptId: second.attemptId },
        {
          operation: "commit_presentation",
          cancelEpoch: 0,
          message: { messageId: "response_complete_01", text: "Done.", occurredAtMs: secondBase + 1 },
          committedAtMs: secondBase + 1,
        },
      );
      const completionClaimed = await transitionMountedPresentation(
        { ...bindingFor(secondRoot), attemptId: second.attemptId },
        { operation: "claim_completion", claimedAtMs: secondBase + 2 },
      );
      assert.equal(completionClaimed.status, "completion_claimed");
      await assert.rejects(
        () =>
          transitionMountedPresentation(
            { ...bindingFor(secondRoot), attemptId: second.attemptId },
            { operation: "claim_cancel", claimedAtMs: secondBase + 3 },
          ),
        /p5_presentation_cancel_source_required/,
      );
      const completed = await transitionMountedPresentation(
        { ...bindingFor(secondRoot), attemptId: second.attemptId },
        { operation: "complete", completedAtMs: secondBase + 4 },
      );
      assert.equal(completed.status, "completed");
      await assert.rejects(
        () =>
          transitionMountedPresentation(
            { ...bindingFor(secondRoot), attemptId: second.attemptId },
            { operation: "claim_cancel", claimedAtMs: secondBase + 5 },
          ),
        /p5_presentation_cancel_source_required/,
      );
    } finally {
      closeSecond?.();
      await rm(secondRoot, { recursive: true, force: true });
    }
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority: a not_started attempt has an ordinary turn-level cancel exit that preserves its pre-invocation proof", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-not-started-exit-");
  let closeStore: (() => void) | undefined;
  try {
    const { store, attemptId } = await prepare(root, "not_started");
    closeStore = () => store.close?.();
    const before = await store.resumeThread("thread_01", "surface_01");
    assert.equal(before.turnLedger?.status, "attempt_starting");
    assert.equal(before.turnLedger?.observation?.phase, "not_started");
    const base = before.thread.updatedAtMs;

    // The exit reuses the armed-cancel terminal vocabulary: `cancelled`, keeping
    // the exact attempt and the `not_started` observation with its own reason.
    const cancelled = await transitionMountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", observedAtMs: base + 1, cancelledAtMs: base + 2 },
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.attempt.attemptId, attemptId);
    assert.equal(cancelled.observation.phase, "not_started");
    assert.equal(cancelled.observation.reasonCode, "admission_revoked");
    assert.equal(cancelled.presentation, null);

    // The durable row is terminal, not just the returned value.
    const durable = await store.resumeThread("thread_01", "surface_01");
    assert.equal(durable.turnLedger?.status, "cancelled");
    assert.equal(durable.turnLedger?.observation?.phase, "not_started");
    assert.equal(durable.turnLedger?.attempt.attemptId, attemptId);
    assert.equal(durable.turnLedger?.presentation, null);
    // No provider saw this turn, so no companion message was invented for it.
    assert.equal(durable.messages.filter((message) => message.kind === "response").length, 0);
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority: the widened not_started exit still rejects the fabricated and impossible rows", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-not-started-honest-");
  let closeStore: (() => void) | undefined;
  try {
    const { store, attemptId } = await prepare(root, "not_started");
    closeStore = () => store.close?.();
    const before = await store.resumeThread("thread_01", "surface_01");

    // An `armed` observation can never be fabricated for a turn that durably
    // recorded it never armed: the exit may cancel this shape, never re-arm it.
    await assert.rejects(
      () =>
        transitionMountedProviderStart(
          { ...bindingFor(root), attemptId },
          { operation: "arm", observedAtMs: before.thread.updatedAtMs + 1 },
        ),
      /provider_start_observation_conflict/,
    );
    assert.deepEqual(await store.resumeThread("thread_01", "surface_01"), before);

    // Plant a genuinely impossible durable row directly: a `cancelled` terminal
    // whose observation is the pre-invocation `not_started` proof, yet whose
    // presentation row claims a committed response bubble. A turn that never
    // reached `running` could never have committed one.
    const dbPath = join(root, "tavern", "v3", "continuities", continuityKey, "tavern.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const turnId = before.turnLedger?.turnId;
      assert.ok(turnId);
      const at = before.thread.updatedAtMs;
      db.prepare("UPDATE tavern_turns SET status = 'cancelled' WHERE turn_id = ?").run(turnId);
      db.prepare(
        "INSERT INTO tavern_messages (thread_id, message_id, append_ordinal, role, kind, text, occurred_at_ms, parent_id, active_swipe_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("thread_01", "response_planted_01", 1, "companion", "response", "Impossible.", at + 3, null, 0);
      db.prepare(
        "INSERT INTO tavern_message_swipes (thread_id, message_id, swipe_index, text) VALUES (?, ?, ?, ?)",
      ).run("thread_01", "response_planted_01", 0, "Impossible.");
      // Six columns since schema v7 added `truncated`; a positional INSERT has to match the table it is planting into.
      db.prepare("INSERT INTO tavern_turn_presentations VALUES (?, ?, ?, ?, ?, ?)").run(
        turnId,
        "response_planted_01",
        "response_planted_01",
        0,
        at + 3,
        0,
      );
      db.prepare("INSERT OR REPLACE INTO tavern_turn_terminalizations VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        turnId,
        null,
        null,
        at + 1,
        at + 2,
        null,
        null,
      );
    } finally {
      db.close();
    }
    await assert.rejects(() => store.resumeThread("thread_01", "surface_01"), /invalid_chat_thread_turn_ledger/);
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority: a claimed cancel is not overwritable by a failure", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-claim-immutable-");
  let closeStore: (() => void) | undefined;
  try {
    const { store, attemptId } = await prepare(root, "running");
    closeStore = () => store.close?.();
    const base = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
    const claimed = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 1 },
    );
    assert.equal(claimed.status, "cancel_claimed");

    // The defect this covers: the mounted cancel seam publishes its durable claim and
    // then aborts the prompt it owns, so the runner that drains that prompt is the only
    // writer left that can terminalize the turn. While nothing consumed the published
    // winner, that runner reported the stop's own abort as this turn's failure, and the
    // store let the failure replace the claimed interruption - losing the cancel, the
    // timestamps and the fact that the player had already stopped the turn.
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "fail", reasonCode: "runtime_unavailable", failedAtMs: base + 2 },
        ),
      /p5_presentation_terminal_immutable/,
    );
    assert.deepEqual((await store.resumeThread("thread_01", "surface_01")).turnLedger, claimed);

    // The claim's own owner still finishes it, and keeps the claim's identity.
    const cancelled = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 3 },
    );
    assert.equal(cancelled.status, "cancelled");
    if (cancelled.status === "cancelled") {
      assert.equal(cancelled.cancelClaimedAtMs, base + 1);
      assert.equal(cancelled.cancelledAtMs, base + 3);
    }
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});
