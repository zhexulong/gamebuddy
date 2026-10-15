import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { dehydrateCompanionSpeech } from "../companion-speech-dehydration.js";
import {
  attachNativeCompanionContent,
  CHAT_TRANSCRIPT_SCAFFOLDING,
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
 * The rule for the Chat row's second axis, on the same durable row.
 *
 * The failure this catches: `CHAT_TRANSCRIPT_STAGE_DIRECTION` stopped the Chat
 * lane projecting the model's text, and that projection had been - without ever
 * saying so - the only thing removing the model's own scaffolding. Under `keep`
 * a literal `<thinking>` block is written into the player's transcript and
 * nothing left on the Chat path takes it back out. The rule the row is asserted
 * against: action beats are performance and stay, model scaffolding is leakage
 * and goes, and prose that was never scaffolding is never dropped.
 *
 * The row is read back from a freshly reopened durable store, and the reader is
 * the real observer configured with both production Chat choices, so a flipped
 * `CHAT_TRANSCRIPT_SCAFFOLDING` - or a strip there - fails right here.
 */
test("the Chat persistence path drops model scaffolding and keeps the action beat", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-turn-scaffolding-");
  try {
    const { attemptId, base } = await prepareRunning(root);
    // A reply shaped the way a real one is: the model's own reasoning around the
    // performance, plus one markdown divider and one emphasised line.
    const reasoning = "玩家刚醒，先顺着围裙的话题接一句。";
    const innerThought = "她还没吃早饭。";
    const aside = "别催她。";
    const modelText =
      `<thinking>${reasoning}</thinking>\n\n` +
      "*正蹲在田埂边用小花铲抠一块顽固的碎石，听到声音抬起头。*\n\n" +
      "“嗯？醒啦。”\n\n" +
      `（思考：${innerThought}）\n\n` +
      `【内心：${aside}】\n\n` +
      "**今日提醒**：锅里有昨晚上剩的防风草汤。\n\n" +
      "---\n\n" +
      "*她把铲子往腰侧工具包里一插，站起来拍了拍膝盖上的土。*";
    const presented = await chatPresentationOf(modelText);
    assert.ok(typeof presented === "string", "the observer commits the model's final assistant text");

    const committedAt = base + 10;
    const messageId = "chat_native_attempt_scaffolding";
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
    const stored = row?.text ?? "";

    // Scaffolding is leakage: none of it reaches the durable row.
    assert.doesNotMatch(stored, /<\/?think/iu, "the stored row still carries the model's reasoning tags");
    assert.doesNotMatch(stored, new RegExp(reasoning, "u"), "the stored row still carries the reasoning text");
    assert.doesNotMatch(stored, /[（【](?:思考|内心|脑内)/u, "the stored row still carries a reasoning frame");
    assert.doesNotMatch(stored, new RegExp(innerThought, "u"), "the stored row still carries an inner thought");
    assert.doesNotMatch(stored, new RegExp(aside, "u"), "the stored row still carries an inner monologue");
    assert.doesNotMatch(stored, /\*\*/u, "the stored row still carries markdown emphasis markers");
    assert.doesNotMatch(stored, /^[ \t]*---[ \t]*$/mu, "the stored row still carries a divider rule");

    // Performance stays, byte for byte ...
    assert.match(
      stored,
      /\*正蹲在田埂边用小花铲抠一块顽固的碎石，听到声音抬起头。\*/u,
      "the stored row lost the first action beat",
    );
    assert.match(
      stored,
      /\*她把铲子往腰侧工具包里一插，站起来拍了拍膝盖上的土。\*/u,
      "the stored row lost the second action beat",
    );
    // ... and so does every word that was never scaffolding.
    assert.match(stored, /“嗯？醒啦。”/u, "the stored row lost the dialogue between the beats");
    assert.match(stored, /今日提醒：锅里有昨晚上剩的防风草汤。/u, "unwrapping the emphasis dropped its words");
    // Stated against the rule rather than the function: the row is neither the
    // model's raw text nor the dehydrator's projection of it.
    assert.notEqual(stored, modelText);
    assert.notEqual(stored, dehydrateCompanionSpeech(modelText));
  } finally {
    await removeTestRoot(root);
  }
});

/**
 * Runs the real Chat presentation observer over one Pi assistant message and
 * returns the text it hands the persistence lane. `CHAT_TRANSCRIPT_STAGE_DIRECTION`
 * and `CHAT_TRANSCRIPT_SCAFFOLDING` are the production decisions, so this reader
 * cannot agree with a lane that has been changed to strip, or to let the model's
 * own scaffolding through.
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
    { stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION, scaffolding: CHAT_TRANSCRIPT_SCAFFOLDING },
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

/**
 * A same-position variant acceptance is a turn with no player message of its own.
 * The durable position facts live on the turn and must resolve to the existing
 * reply and the player message that reply answered; every assertion below reads
 * the store back rather than trusting the acceptance return value.
 */
test("a same-position variant acceptance mints no player row and records the target and anchor", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-variant-acceptance-");
  try {
    const store = openStore(root);
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
      opening: {
        messageId: "opening_01",
        text: "Welcome to the tavern.",
        source: {
          greetingSetId: "greetings_01",
          sourceRevision: 2,
          canonicalHash: "a".repeat(64),
          variantId: "alternate_01",
          profileRevision: 3,
          scenarioRevision: null,
        },
      },
    });
    await store.appendPlayer("thread_01", { messageId: "player_01", text: "Hello", occurredAtMs: 101 });
    await store.commitResponse("thread_01", { messageId: "response_01", text: "Hello back", occurredAtMs: 102 });

    const { acceptMountedPlayerMessage } = await import("./chat-thread-store.js");
    const command = {
      text: "Hello",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
      authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
    } as const;
    // Bounded, zero-mutation refusals: an unknown target, a player line, and a
    // companion message with no anchor player message before it (the opening).
    await assert.rejects(
      () => acceptMountedPlayerMessage(bindingFor(root), { ...command, variantTargetMessageId: "missing_01" }),
      /chat_variant_target_not_found/,
    );
    await assert.rejects(
      () => acceptMountedPlayerMessage(bindingFor(root), { ...command, variantTargetMessageId: "player_01" }),
      /chat_variant_target_not_companion/,
    );
    await assert.rejects(
      () => acceptMountedPlayerMessage(bindingFor(root), { ...command, variantTargetMessageId: "opening_01" }),
      /chat_variant_anchor_unavailable/,
    );

    // The player is mid-sentence: a regeneration is not their message being sent, so
    // the draft they are typing must survive it. It is set after the refusals above,
    // which are decided against the empty draft revision the command names.
    await store.saveDraft!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      expectedDraftRevision: 0,
      text: "still typing this",
    });

    const accepted = await acceptMountedPlayerMessage(bindingFor(root), {
      ...command,
      expectedDraftRevision: 1,
      variantTargetMessageId: "response_01",
    });
    assert.deepEqual(accepted.variant, { targetMessageId: "response_01", anchorMessageId: "player_01" });
    // The variant turn's own identity is opaque and names no message row.
    assert.equal(accepted.messageId, `variant_${accepted.turnId}`);

    const state = await store.resumeThread("thread_01", "surface_01");
    // No row was minted at all: not a player row, not a companion row.
    assert.deepEqual(
      state.messages.map((message) => message.messageId),
      ["opening_01", "player_01", "response_01"],
    );
    // ... and the draft the player is typing is byte-identical: only an ordinary
    // acceptance consumes it.
    assert.deepEqual(state.draft, { revision: 1, text: "still typing this" });
    assert.deepEqual(
      state.messages.filter((message) => message.role === "player").map((message) => message.messageId),
      ["player_01"],
    );
    const ledger = state.turnLedger;
    assert.ok(ledger !== null);
    assert.equal(ledger.status, "accepted_queued");
    assert.deepEqual(ledger.variant, { targetMessageId: "response_01", anchorMessageId: "player_01" });
    assert.equal(ledger.messageId, `variant_${ledger.turnId}`);

    // The ledger and its idempotency record are durable: a second connection on
    // the same root/continuity reads the same variant position facts back.
    const durable = await openStore(root).resumeThread("thread_01", "surface_01");
    assert.deepEqual(durable.turnLedger?.variant, { targetMessageId: "response_01", anchorMessageId: "player_01" });
    assert.deepEqual(durable.idempotency.find((record) => record.key === command.idempotencyKey)?.result.variant, {
      targetMessageId: "response_01",
      anchorMessageId: "player_01",
    });
  } finally {
    await removeTestRoot(root);
  }
});

/**
 * The red-before fact, pinned beside the green: the ordinary acceptance today's
 * `regenerate` runs is an ordinary player submit, so it mints a second player row
 * for the exchange it re-asks. The variant acceptance on the same shape of thread
 * mints none. Both halves read the store back, so neither is asserted from the
 * acceptance return value.
 */
test("the ordinary acceptance behind today's regenerate appends a second player row where a variant mints none", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-variant-red-before-");
  try {
    const store = openStore(root);
    const creation = createProfileAwareChatThreadCreationCapability(store, {
      async readExact() {
        return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
      },
    });
    const openingFor = (threadId: string, suffix: string) => ({
      chatThreadId: threadId,
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatSurfaceSessionId: suffix === "01" ? "surface_01" : "surface_02",
      opening: {
        messageId: `opening_${suffix}`,
        text: "Welcome to the tavern.",
        source: {
          greetingSetId: "greetings_01",
          sourceRevision: 2,
          canonicalHash: "a".repeat(64),
          variantId: "alternate_01",
          profileRevision: 3,
          scenarioRevision: null,
        },
      },
    });
    for (const [threadId, suffix] of [
      ["thread_01", "01"],
      ["thread_02", "02"],
    ] as const) {
      await creation.createExplicit(openingFor(threadId, suffix));
      await store.appendPlayer(threadId, { messageId: `player_${suffix}`, text: "Hello", occurredAtMs: 101 });
      await store.commitResponse(threadId, { messageId: `response_${suffix}`, text: "Hello back", occurredAtMs: 102 });
    }

    const { acceptMountedPlayerMessage } = await import("./chat-thread-store.js");
    const prepared = { sourceRefs: [], stableTokenCount: 0 } as const;
    // The red-before half: an ordinary acceptance is what today's regenerate runs,
    // and it mints a second player row at the transcript tail.
    await acceptMountedPlayerMessage(bindingFor(root), {
      text: "Hello",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
      authoredContextPreparation: prepared,
    });
    const ordinary = await store.resumeThread("thread_01", "surface_01");
    const ordinaryPlayerRows = ordinary.messages
      .filter((message) => message.role === "player")
      .map((message) => message.messageId);
    assert.equal(ordinaryPlayerRows.length, 2);
    assert.equal(ordinaryPlayerRows[0], "player_01");
    assert.notEqual(ordinaryPlayerRows[1], "player_01");

    // The green half: the same exchange re-asked as a variant mints no player row,
    // and the existing reply position is untouched until a variant is committed.
    await acceptMountedPlayerMessage(
      { ...bindingFor(root), chatThreadId: "thread_02", chatSurfaceSessionId: "surface_02" },
      {
        text: "Hello",
        locale: "en-US",
        idempotencyKey: "bcdefghijklmnopqrstuvw",
        expectedDraftRevision: 0,
        authoredContextPreparation: prepared,
        variantTargetMessageId: "response_02",
      },
    );
    const variant = await store.resumeThread("thread_02", "surface_02");
    assert.deepEqual(
      variant.messages.map((message) => message.messageId),
      ["opening_02", "player_02", "response_02"],
    );
    assert.deepEqual(
      variant.messages.filter((message) => message.role === "player").map((message) => message.messageId),
      ["player_02"],
    );
    assert.deepEqual(variant.turnLedger?.variant, { targetMessageId: "response_02", anchorMessageId: "player_02" });
  } finally {
    await removeTestRoot(root);
  }
});

/**
 * Creates a thread whose reply is already durably committed, then a running
 * variant turn that targets that reply. The variant turn mints no player row;
 * its attempt is the only turn state.
 */
async function prepareRunningVariant(
  root: string,
): Promise<Readonly<{ attemptId: string; store: ReturnType<typeof createChatThreadStore>; base: number }>> {
  const store = openStore(
    root,
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
    opening: {
      messageId: "opening_01",
      text: "Welcome to the tavern.",
      source: {
        greetingSetId: "greetings_01",
        sourceRevision: 2,
        canonicalHash: "a".repeat(64),
        variantId: "alternate_01",
        profileRevision: 3,
        scenarioRevision: null,
      },
    },
  });
  await store.appendPlayer("thread_01", { messageId: "player_01", text: "Hello", occurredAtMs: 101 });
  await store.commitResponse("thread_01", { messageId: "response_01", text: "First reply.", occurredAtMs: 102 });
  const { acceptMountedPlayerMessage } = await import("./chat-thread-store.js");
  const binding = bindingFor(root);
  await acceptMountedPlayerMessage(binding, {
    text: "Hello",
    locale: "en-US",
    idempotencyKey: "abcdefghijklmnopqrstuv",
    expectedDraftRevision: 0,
    variantTargetMessageId: "response_01",
    authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
  });
  const claimed = await claimMountedAttempt(binding);
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
  const base = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
  return { attemptId, store, base };
}

/**
 * Item (c): the same-position variant commits through the presentation path. It
 * appends a swipe to the existing reply row - no INSERT, no new player row - and
 * an identical replay is idempotent. Every assertion reads the store back.
 */
test("commit_variant appends a swipe to the existing reply position and replays identically", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p5-variant-");
  try {
    const { attemptId, store, base } = await prepareRunningVariant(root);
    const committedAt = base + 10;
    const committed = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_variant",
        cancelEpoch: 0,
        variant: { targetMessageId: "response_01", text: "Second reply.", occurredAtMs: committedAt },
        committedAtMs: committedAt,
      },
    );
    assert.equal(committed.status, "presentation_committed");
    if (committed.status === "presentation_committed") {
      assert.deepEqual(committed.presentation, {
        expressionId: "response_01",
        messageId: "response_01",
        cancelEpoch: 0,
        committedAtMs: committedAt,
      });
    }
    const state = await store.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      state.messages.map((message) => message.messageId),
      ["opening_01", "player_01", "response_01"],
    );
    assert.deepEqual(
      state.messages.filter((message) => message.role === "player").map((message) => message.messageId),
      ["player_01"],
    );
    const reply = state.messages[2]!;
    assert.deepEqual(reply.swipes, ["First reply.", "Second reply."]);
    assert.equal(reply.activeSwipeIndex, 1);
    assert.equal(reply.text, "Second reply.");

    // Replay of the identical variant command is idempotent and never appends a
    // third swipe.
    const replayed = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_variant",
        cancelEpoch: 0,
        variant: { targetMessageId: "response_01", text: "Second reply.", occurredAtMs: committedAt },
        committedAtMs: committedAt,
      },
    );
    assert.equal(replayed.status, "presentation_committed");
    const afterReplay = await store.resumeThread("thread_01", "surface_01");
    assert.deepEqual(afterReplay.messages[2]!.swipes, ["First reply.", "Second reply."]);

    // A conflicting replay is refused and mutates nothing.
    await assert.rejects(
      () =>
        transitionMountedPresentation(
          { ...bindingFor(root), attemptId },
          {
            operation: "commit_variant",
            cancelEpoch: 0,
            variant: { targetMessageId: "response_01", text: "A third reply.", occurredAtMs: committedAt },
            committedAtMs: committedAt,
          },
        ),
      /chat_variant_commit_conflict/,
    );

    // The same position is still a normal swipe position: selectSwipe restores
    // the first text without adding a row.
    const restored = await store.selectSwipe!(testTransitionAuthority.authority, "thread_01", "response_01", {
      direction: "prev",
    });
    assert.deepEqual(
      restored.messages.map((message) => message.messageId),
      ["opening_01", "player_01", "response_01"],
    );
    assert.equal(restored.messages[2]!.text, "First reply.");
    assert.equal(restored.messages[2]!.activeSwipeIndex, 0);
    assert.deepEqual(restored.messages[2]!.swipes, ["First reply.", "Second reply."]);
  } finally {
    await removeTestRoot(root);
  }
});
