import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  claimP4MountedAttempt,
  createChatThreadStore,
  transitionP4MountedProviderStart as rawTransitionP4MountedProviderStart,
  transitionP5MountedPresentation as rawTransitionP5MountedPresentation,
} from "./chat-thread-store.js";
import { createP4P5MountedTransitionAuthority } from "./chat-thread-store.p4-p5-transition-authority.internal.js";

const testTransitionAuthority = createP4P5MountedTransitionAuthority();
const transitionP4MountedProviderStart = async (
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
const transitionP5MountedPresentation = async (
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

function _runningStore() {
  return {
    root: undefined as unknown as string,
    store: undefined as unknown as ReturnType<typeof createChatThreadStore>,
    attemptId: "",
  };
}

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/** Creates a thread with an accepted player turn, claimed attempt, durable `armed`, and durable `running` ledger. */
async function prepareRunning(
  root: string,
): Promise<Readonly<{ attemptId: string; store: ReturnType<typeof createChatThreadStore>; base: number }>> {
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
  const { acceptP4MountedPlayerMessage } = await import("./chat-thread-store.js");
  const binding = bindingFor(root);
  await acceptP4MountedPlayerMessage(binding, {
    text: "Hello",
    locale: "en-US",
    idempotencyKey: "abcdefghijklmnopqrstuv",
    expectedDraftRevision: 0,
  });
  const claimed = await claimP4MountedAttempt(binding);
  const attemptId = claimed.attempt.attemptId;
  // The P4 ingress store writes wall-clock timestamps, so every later command
  // timestamp must be a strict offset above the durable updatedAtMs.
  const prefix = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
  await transitionP4MountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "arm", observedAtMs: prefix + 1 },
  );
  await transitionP4MountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "running", statusClass: "success", observedAtMs: prefix + 2 },
  );
  const base = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
  return { attemptId, store, base };
}

test("P5 commits exactly one durable presentation from running and reopens identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p5-commit-"));
  try {
    const { attemptId, store, base } = await prepareRunning(root);
    const committedAt = base + 10;
    const messageId = "response_abc123";
    const committed = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_presentation",
        cancelEpoch: 0,
        message: { messageId, text: "I am here.", occurredAtMs: committedAt },
        committedAtMs: committedAt,
      },
    );
    assert.equal(committed.status, "presentation_committed");
    if (committed.status === "presentation_committed") {
      assert.deepEqual(committed.presentation, {
        expressionId: messageId,
        messageId,
        cancelEpoch: 0,
        committedAtMs: committedAt,
      });
      assert.equal(committed.attempt.attemptId, attemptId);
    }
    const state = await store.resumeThread("thread_01", "surface_01");
    assert.deepEqual(state.turnLedger, committed);
    const bubble = state.messages.find((message) => message.messageId === messageId);
    assert.equal(bubble?.role, "companion");
    assert.equal(bubble?.kind, "response");
    assert.equal(bubble?.text, "I am here.");
    assert.equal(state.messages.filter((message) => message.kind === "player").length, 1);
    assert.equal(state.messages.filter((message) => message.kind === "response").length, 1);
    const reopened = await createChatThreadStore(root, continuityKey).resumeThread("thread_01", "surface_01");
    assert.deepEqual(reopened.turnLedger, committed);
    assert.deepEqual(reopened.messages, state.messages);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5 commit retry with the identical message is idempotent and never double-appends", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p5-retry-"));
  try {
    const { attemptId, base } = await prepareRunning(root);
    const command = {
      operation: "commit_presentation" as const,
      cancelEpoch: 0,
      message: { messageId: "response_abc123", text: "Still here.", occurredAtMs: base + 20 },
      committedAtMs: base + 20,
    };
    const first = await transitionP5MountedPresentation({ ...bindingFor(root), attemptId }, command);
    const retried = await transitionP5MountedPresentation({ ...bindingFor(root), attemptId }, command);
    assert.deepEqual(retried, first);
    const state = await createChatThreadStore(root, continuityKey).resumeThread("thread_01", "surface_01");
    assert.equal(state.turnLedger?.status ?? null, "presentation_committed");
    assert.equal(state.messages.filter((message) => message.kind === "response").length, 1);
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          { ...command, message: { ...command.message, text: "Different." } },
        ),
      /chat_thread_message_id_conflict/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5 completion claims and completes only from an exact committed presentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p5-complete-"));
  try {
    const { attemptId, base } = await prepareRunning(root);
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_completion", claimedAtMs: base + 10 },
        ),
      /p5_presentation_completion_source_required/,
    );
    await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_presentation",
        cancelEpoch: 0,
        message: { messageId: "response_abc123", text: "Done.", occurredAtMs: base + 11 },
        committedAtMs: base + 11,
      },
    );
    const claimedCompletion = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_completion", claimedAtMs: base + 12 },
    );
    assert.equal(claimedCompletion.status, "completion_claimed");
    if (claimedCompletion.status === "completion_claimed") {
      assert.equal(claimedCompletion.completionClaimedAtMs, base + 12);
      assert.equal(claimedCompletion.presentation.messageId, "response_abc123");
    }
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_completion", claimedAtMs: base + 13 },
        ),
      /p5_presentation_completion_source_required/,
    );
    const completed = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "complete", completedAtMs: base + 14 },
    );
    assert.equal(completed.status, "completed");
    const reopened = await createChatThreadStore(root, continuityKey).resumeThread("thread_01", "surface_01");
    assert.deepEqual(reopened.turnLedger, completed);
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "fail", reasonCode: "interrupted", failedAtMs: base + 15 },
        ),
      /p5_presentation_terminal_immutable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5 cancel after commit keeps the bubble historical and terminalizes cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p5-cancel-"));
  try {
    const { attemptId, base } = await prepareRunning(root);
    await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_presentation",
        cancelEpoch: 1,
        message: { messageId: "response_abc123", text: "Visible.", occurredAtMs: base + 10 },
        committedAtMs: base + 10,
      },
    );
    const cancelClaimed = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 11 },
    );
    assert.equal(cancelClaimed.status, "cancel_claimed");
    if (cancelClaimed.status === "cancel_claimed")
      assert.equal(cancelClaimed.presentation?.messageId, "response_abc123");
    const cancelled = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 12 },
    );
    assert.equal(cancelled.status, "cancelled");
    const state = await createChatThreadStore(root, continuityKey).resumeThread("thread_01", "surface_01");
    assert.equal(state.messages.filter((message) => message.kind === "response").length, 1);
    const repeated = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 13 },
    );
    assert.equal(repeated.status, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5 cancel before commit declines the late presentation callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p5-cancel-early-"));
  try {
    const { attemptId, store, base } = await prepareRunning(root);
    const early = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 10 },
    );
    assert.equal(early.status, "cancel_claimed");
    if (early.status === "cancel_claimed") assert.equal(early.presentation, null);
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          {
            operation: "commit_presentation",
            cancelEpoch: 1,
            message: { messageId: "response_abc123", text: "Late.", occurredAtMs: base + 11 },
            committedAtMs: base + 11,
          },
        ),
      /p5_presentation_source_running_required/,
    );
    const finish = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 12 },
    );
    assert.equal(finish.status, "cancelled");
    const state = await store.resumeThread("thread_01", "surface_01");
    assert.equal(state.messages.filter((message) => message.kind === "response").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5 fails from a live running attempt and rejects attempt-starting or terminal sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p5-fail-"));
  try {
    const { attemptId, base } = await prepareRunning(root);
    const failed = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "fail", reasonCode: "no_visible_presentation", failedAtMs: base + 10 },
    );
    assert.equal(failed.status, "failed");
    if (failed.status === "failed") {
      assert.equal(failed.reasonCode, "no_visible_presentation");
      assert.equal(failed.presentation, null);
    }
    const reopened = await createChatThreadStore(root, continuityKey).resumeThread("thread_01", "surface_01");
    assert.deepEqual(reopened.turnLedger, failed);
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "complete", completedAtMs: base + 11 },
        ),
      /p5_presentation_complete_source_required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5 fail is not reachable before the provider start observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p5-fail-early-"));
  try {
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
    const { acceptP4MountedPlayerMessage } = await import("./chat-thread-store.js");
    const binding = bindingFor(root);
    await acceptP4MountedPlayerMessage(binding, {
      text: "Hello",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
    });
    const claimed = await claimP4MountedAttempt(binding);
    const attemptId = claimed.attempt.attemptId;
    const failedAt = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs + 1;
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "fail", reasonCode: "no_visible_presentation", failedAtMs: failedAt },
        ),
      /p5_presentation_terminal_immutable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5 transition authority rejects a revoked capability before durable mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p5-authority-revoked-"));
  try {
    const { attemptId, store, base } = await prepareRunning(root);
    const revoked = createP4P5MountedTransitionAuthority();
    const operation = revoked.mintOperation();
    const before = await store.resumeThread("thread_01", "surface_01");
    revoked.revoke();
    await assert.rejects(
      () =>
        rawTransitionP5MountedPresentation(
          { authority: revoked.authority, operationAuthority: operation.authority, ...bindingFor(root), attemptId },
          {
            operation: "commit_presentation",
            cancelEpoch: 0,
            message: { messageId: "response_revoked_01", text: "blocked", occurredAtMs: base + 10 },
            committedAtMs: base + 10,
          },
        ),
      /p4_p5_transition_authority_unavailable/,
    );
    assert.deepEqual(await store.resumeThread("thread_01", "surface_01"), before);
    operation.revoke();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P5 exact attempt binding rejects a foreign attempt or binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p5-attempt-"));
  try {
    const { attemptId, store, base } = await prepareRunning(root);
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId: "attempt_foreign" },
          { operation: "claim_cancel", claimedAtMs: base + 10 },
        ),
      /p5_presentation_attempt_mismatch/,
    );
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          {
            ...bindingFor(root),
            attemptId,
            runtimeOwner: { ...bindingFor(root).runtimeOwner, ownerToken: "owner_changed" },
          },
          { operation: "claim_cancel", claimedAtMs: base + 10 },
        ),
      /p5_presentation_attempt_mismatch/,
    );
    const state = await store.resumeThread("thread_01", "surface_01");
    assert.equal(state.turnLedger?.status ?? null, "running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
