import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { dehydrateCompanionSpeech } from "../companion-speech-dehydration.js";
import {
  attachNativeCompanionContent,
  CHAT_TRANSCRIPT_STAGE_DIRECTION,
  type NativeCompanionContentEvent,
} from "../native-companion-content.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  claimMountedAttempt,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
  transitionMountedProviderStart as rawTransitionMountedProviderStart,
  transitionMountedPresentation as rawTransitionMountedPresentation,
} from "./chat-thread-store.js";
import { createMountedTurnTransitionAuthority } from "./chat-thread-store.mounted-turn-transition.internal.js";

const testTransitionAuthority = createMountedTurnTransitionAuthority();
const transitionMountedProviderStart = async (
  binding: Omit<Parameters<typeof rawTransitionMountedProviderStart>[0], "authority" | "operationAuthority">,
  command: Parameters<typeof rawTransitionMountedProviderStart>[1],
) => {
  const operation = testTransitionAuthority.mintOperation();
  try {
    return await rawTransitionMountedProviderStart(
      { authority: testTransitionAuthority.authority, operationAuthority: operation.authority, ...binding },
      command,
    );
  } finally {
    operation.revoke();
  }
};
const transitionMountedPresentation = async (
  binding: Omit<Parameters<typeof rawTransitionMountedPresentation>[0], "authority" | "operationAuthority">,
  command: Parameters<typeof rawTransitionMountedPresentation>[1],
) => {
  const operation = testTransitionAuthority.mintOperation();
  try {
    return await rawTransitionMountedPresentation(
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

/**
 * Every store this file opens, closed before its root is removed.
 *
 * The failure this prevents: a store left open holds the continuity SQLite file
 * (`tavern.sqlite`, its `-wal` and `-shm`) against deletion, and `fs.rm` on
 * Windows then blocks forever instead of failing - so this file printed
 * `TAP version 13` and nothing else, for four minutes, every test hanging in
 * its own `finally` and the runner never reaching the first result.
 */
const openStores: Array<ReturnType<typeof createChatThreadStore>> = [];

/** Opens a store on `root` and remembers it, so this file always closes what it opened. */
function openStore(root: string, now?: () => number): ReturnType<typeof createChatThreadStore> {
  const store =
    now === undefined ? createChatThreadStore(root, continuityKey) : createChatThreadStore(root, continuityKey, now);
  openStores.push(store);
  return store;
}

async function removeTestRoot(root: string) {
  for (const store of openStores.splice(0)) store.close?.();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

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
  const store = openStore(
    root,
    (() => {
      let current = 100;
      return () => current++;
    })(),
  );
  const creation = createProfileAwareChatThreadCreationCapability(store, { async readExact() { return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) }; } });
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
  const claimed = await claimMountedAttempt(binding);
  const attemptId = claimed.attempt.attemptId;
  // The ingress store writes wall-clock timestamps, so every later command
  // timestamp must be a strict offset above the durable updatedAtMs.
  const prefix = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
  await transitionMountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "arm", observedAtMs: prefix + 1 },
  );
  await transitionMountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "running", statusClass: "success", observedAtMs: prefix + 2 },
  );
  const base = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
  return { attemptId, store, base };
}

test("presentation commits exactly one durable presentation from running and reopens identical", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-commit-");
  try {
    const { attemptId, store, base } = await prepareRunning(root);
    const committedAt = base + 10;
    const messageId = "response_abc123";
    const committed = await transitionMountedPresentation(
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
    const reopened = await openStore(root).resumeThread("thread_01", "surface_01");
    assert.deepEqual(reopened.turnLedger, committed);
    assert.deepEqual(reopened.messages, state.messages);
  } finally {
    await removeTestRoot(root);
  }
});

test("presentation commit retry with the identical message is idempotent and never double-appends", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-retry-");
  try {
    const { attemptId, base } = await prepareRunning(root);
    const command = {
      operation: "commit_presentation" as const,
      cancelEpoch: 0,
      message: { messageId: "response_abc123", text: "Still here.", occurredAtMs: base + 20 },
      committedAtMs: base + 20,
    };
    const first = await transitionMountedPresentation({ ...bindingFor(root), attemptId }, command);
    const retried = await transitionMountedPresentation({ ...bindingFor(root), attemptId }, command);
    assert.deepEqual(retried, first);
    const state = await openStore(root).resumeThread("thread_01", "surface_01");
    assert.equal(state.turnLedger?.status ?? null, "presentation_committed");
    assert.equal(state.messages.filter((message) => message.kind === "response").length, 1);
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { ...command, message: { ...command.message, text: "Different." } },
        ),
      /chat_thread_message_id_conflict/,
    );
  } finally {
    await removeTestRoot(root);
  }
});

test("presentation completion claims and completes only from an exact committed presentation", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-complete-");
  try {
    const { attemptId, base } = await prepareRunning(root);
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_completion", claimedAtMs: base + 10 },
        ),
      /p5_presentation_completion_source_required/,
    );
    await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_presentation",
        cancelEpoch: 0,
        message: { messageId: "response_abc123", text: "Done.", occurredAtMs: base + 11 },
        committedAtMs: base + 11,
      },
    );
    const claimedCompletion = await transitionMountedPresentation(
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
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_completion", claimedAtMs: base + 13 },
        ),
      /p5_presentation_completion_source_required/,
    );
    const completed = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "complete", completedAtMs: base + 14 },
    );
    assert.equal(completed.status, "completed");
    const reopened = await openStore(root).resumeThread("thread_01", "surface_01");
    assert.deepEqual(reopened.turnLedger, completed);
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "fail", reasonCode: "interrupted", failedAtMs: base + 15 },
        ),
      /p5_presentation_terminal_immutable/,
    );
  } finally {
    await removeTestRoot(root);
  }
});

test("presentation cancel after commit keeps the bubble historical and terminalizes cancelled", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-cancel-");
  try {
    const { attemptId, base } = await prepareRunning(root);
    await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_presentation",
        cancelEpoch: 1,
        message: { messageId: "response_abc123", text: "Visible.", occurredAtMs: base + 10 },
        committedAtMs: base + 10,
      },
    );
    const cancelClaimed = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 11 },
    );
    assert.equal(cancelClaimed.status, "cancel_claimed");
    if (cancelClaimed.status === "cancel_claimed")
      assert.equal(cancelClaimed.presentation?.messageId, "response_abc123");
    const cancelled = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 12 },
    );
    assert.equal(cancelled.status, "cancelled");
    const state = await openStore(root).resumeThread("thread_01", "surface_01");
    assert.equal(state.messages.filter((message) => message.kind === "response").length, 1);
    const repeated = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 13 },
    );
    assert.equal(repeated.status, "cancelled");
  } finally {
    await removeTestRoot(root);
  }
});

test("presentation cancel before commit declines the late presentation callback", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-cancel-early-");
  try {
    const { attemptId, store, base } = await prepareRunning(root);
    const early = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 10 },
    );
    assert.equal(early.status, "cancel_claimed");
    if (early.status === "cancel_claimed") assert.equal(early.presentation, null);
    await assert.rejects(
      () =>
        transitionMountedPresentation(
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
    const finish = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 12 },
    );
    assert.equal(finish.status, "cancelled");
    const state = await store.resumeThread("thread_01", "surface_01");
    assert.equal(state.messages.filter((message) => message.kind === "response").length, 0);
  } finally {
    await removeTestRoot(root);
  }
});

test("presentation fails from a live running attempt and rejects attempt-starting or terminal sources", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-fail-");
  try {
    const { attemptId, base } = await prepareRunning(root);
    const failed = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "fail", reasonCode: "no_visible_presentation", failedAtMs: base + 10 },
    );
    assert.equal(failed.status, "failed");
    if (failed.status === "failed") {
      assert.equal(failed.reasonCode, "no_visible_presentation");
      assert.equal(failed.presentation, null);
    }
    const reopened = await openStore(root).resumeThread("thread_01", "surface_01");
    assert.deepEqual(reopened.turnLedger, failed);
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "complete", completedAtMs: base + 11 },
        ),
      /p5_presentation_complete_source_required/,
    );
  } finally {
    await removeTestRoot(root);
  }
});

test("presentation fail is not reachable before the provider start observation", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-fail-early-");
  try {
    const store = openStore(
      root,
      (() => {
        let current = 100;
        return () => current++;
      })(),
    );
    const creation = createProfileAwareChatThreadCreationCapability(store, { async readExact() { return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) }; } });
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
    const claimed = await claimMountedAttempt(binding);
    const attemptId = claimed.attempt.attemptId;
    const failedAt = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs + 1;
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "fail", reasonCode: "no_visible_presentation", failedAtMs: failedAt },
        ),
      /p5_presentation_terminal_immutable/,
    );
  } finally {
    await removeTestRoot(root);
  }
});

test("presentation transition authority rejects a revoked capability before durable mutation", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-authority-revoked-");
  try {
    const { attemptId, store, base } = await prepareRunning(root);
    const revoked = createMountedTurnTransitionAuthority();
    const operation = revoked.mintOperation();
    const before = await store.resumeThread("thread_01", "surface_01");
    revoked.revoke();
    await assert.rejects(
      () =>
        rawTransitionMountedPresentation(
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
    await removeTestRoot(root);
  }
});

test("presentation exact attempt binding rejects a foreign attempt or binding", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-attempt-");
  try {
    const { attemptId, store, base } = await prepareRunning(root);
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId: "attempt_foreign" },
          { operation: "claim_cancel", claimedAtMs: base + 10 },
        ),
      /p5_presentation_attempt_mismatch/,
    );
    await assert.rejects(
      () =>
        transitionMountedPresentation(
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
    await removeTestRoot(root);
  }
});


/**
 * The Chat turn path's persistence rule, asserted end to end.
 *
 * The failure this catches: the Chat lane hands the persistence transition a
 * projection of the model's text instead of the text itself. Every generated
 * message then loses the companion's only expression channel in Chat (her
 * `*...*` action beats), and the loss is irreversible for every row already
 * written - while the renderer keeps drawing the class it can no longer find.
 * The row is read back from a freshly reopened durable store, and the reader is
 * the real `attachNativeCompanionContent` configured with the production Chat
 * presentation choice, so a planted dehydrate on this path (the constant flipped
 * to `strip`, or a literal substituted for it) fails right here.
 */
test("the Chat persistence path stores the model's own text, action beat included, and reads it back unchanged", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-turn-action-beat-");
  try {
    const { attemptId, base } = await prepareRunning(root);
    // A real reply's shape: two asterisk beats around quoted speech.
    const modelText =
      "*正蹲在田埂边用小花铲抠一块顽固的碎石，听到声音抬起头，茶褐色的发尾沾了点泥星子。*\n\n“嗯？醒啦。”\n\n*她把铲子往腰侧工具包里一插，站起来拍了拍膝盖上的土。*\n\n“锅里有昨晚上剩的防风草汤，热一热就能喝。”";
    const presented = await chatPresentationOf(modelText);
    assert.ok(typeof presented === "string", "the observer commits the model's final assistant text");
    if (presented !== modelText)
      assert.fail(
        `the Chat presentation lane handed the store ${JSON.stringify(presented)} instead of the model's own text ${JSON.stringify(modelText)}`,
      );

    const committedAt = base + 10;
    const messageId = "chat_native_attempt_action_beat";
    const committed = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_presentation",
        cancelEpoch: 0,
        message: { messageId, text: presented, occurredAtMs: committedAt },
        committedAtMs: committedAt,
      },
    );
    assert.equal(committed.status, "presentation_committed");

    // What the player's transcript is built from: the durable store, reopened.
    const reopened = await openStore(root).resumeThread("thread_01", "surface_01");
    const row = reopened.messages.find((message) => message.messageId === messageId);
    assert.equal(row?.role, "companion");
    assert.equal(row?.kind, "response");
    assert.equal(row?.text, modelText);
    // Stated against the rule, not against the function: the stored row must not
    // be the dehydrator's projection of the model's text.
    assert.notEqual(row?.text, dehydrateCompanionSpeech(modelText));
    assert.match(row?.text ?? "", /\*[^*]+\*/u, "the stored row still carries the action beat");
  } finally {
    await removeTestRoot(root);
  }
});

/**
 * Runs the real Chat presentation observer over one Pi assistant message and
 * returns the text it hands the persistence lane. `CHAT_TRANSCRIPT_STAGE_DIRECTION`
 * is the production decision, so this reader cannot agree with a lane that has
 * been changed to strip.
 */
async function chatPresentationOf(modelText: string): Promise<string | undefined> {
  const listeners = new Set<(event: NativeCompanionContentEvent) => void>();
  const finals: string[] = [];
  const rejections: string[] = [];
  const observer = attachNativeCompanionContent(
    Object.freeze({
      subscribe(listener: (event: NativeCompanionContentEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    {
      onPreviewDelta: async () => undefined,
      onFinalText: async (value) => {
        finals.push(value);
      },
      onRejected: async (reason) => {
        rejections.push(reason);
      },
    },
    { stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION },
  );
  observer.open();
  const message = Object.freeze({
    role: "assistant" as const,
    content: [Object.freeze({ type: "text" as const, text: modelText })],
    stopReason: "stop",
    responseId: "assistant_action_beat",
  });
  for (const listener of [...listeners]) {
    listener({ type: "message_start", message });
    listener({ type: "message_end", message });
  }
  await observer.close();
  assert.deepEqual(rejections, [], "the Chat presentation must not reject a reply that carries a beat");
  return finals[0];
}
