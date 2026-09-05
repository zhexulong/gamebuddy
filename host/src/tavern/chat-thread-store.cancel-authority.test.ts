import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  claimMountedAttempt,
  createChatThreadStore,
  transitionMountedProviderStart as rawTransitionP4MountedProviderStart,
  transitionMountedPresentation as rawTransitionP5MountedPresentation,
} from "./chat-thread-store.js";
import { createMountedTurnTransitionAuthority } from "./chat-thread-store.mounted-turn-transition.internal.js";

/**
 * P6 durable cancel authority prerequisite — characterization only.
 *
 * This suite pins the exact fail-closed behavior of the existing durable
 * state machine for queued (`accepted_queued`/`attempt_starting`) cancel
 * attempts and proves the two structural facts that block the P6 route:
 *
 * 1. The frozen ledger types/validators (`CancelClaimedTurn`/`CancelledTurn`
 *    derive from `RunningTurn`, which requires an attempt plus a durable
 *    `running` observation written solely by the source-owned
 *    `after_provider_response` observer) leave NO legal durable artifact
 *    shape for a queued-source cancel. Every queued claim_cancel attempt
 *    fails closed with zero durable mutation, and the rejection never
 *    poisons the later P4c start/presentation path.
 * 2. The existing acceptance `idempotency` record family cannot host a
 *    cancel result; a cancel-specific record would be a new artifact family
 *    outside the current v2 store boundary (an owner decision, not a seam).
 *
 * No production file is modified by this suite.
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
  await store.createThread({
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
  try {
    const { store } = await prepare(root, "accepted_queued");
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
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: claim_cancel rejects attempt_starting sources until durable running, with zero mutation at each rejection", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-starting-");
  try {
    const { store, attemptId } = await prepare(root, "attempt_starting");
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
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: claim_cancel rejects a not_started attempt with zero mutation", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-not-started-");
  try {
    const { store, attemptId } = await prepare(root, "not_started");
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
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: active P5 cancel and completion-first arbitration are unchanged", async () => {
  const root = await canonicalTestRoot("gamebuddy-cancel-auth-active-");
  try {
    const { store, attemptId } = await prepare(root, "running");
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
    try {
      const second = await prepare(secondRoot, "running");
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
      await rm(secondRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
