import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  acceptMountedPlayerMessage,
  claimMountedAttempt,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
  transitionMountedPresentation as rawTransitionMountedPresentation,
  transitionMountedProviderStart as rawTransitionMountedProviderStart,
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

const continuityKey = createHash("sha256")
  .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
  .digest("hex");

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

const openStores: Array<ReturnType<typeof createChatThreadStore>> = [];

function openStore(root: string): ReturnType<typeof createChatThreadStore> {
  const store = createChatThreadStore(root, continuityKey);
  openStores.push(store);
  return store;
}

async function removeTestRoot(root: string): Promise<void> {
  for (const store of openStores.splice(0)) store.close?.();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/** Drives the current accepted turn to a durable `running` ledger through the provider path's own steps. */
async function startRunning(
  root: string,
  store: ReturnType<typeof createChatThreadStore>,
  text: string,
  idempotencyKey: string,
  variantTargetMessageId?: string,
): Promise<string> {
  const binding = bindingFor(root);
  await acceptMountedPlayerMessage(binding, {
    text,
    locale: "en-US",
    idempotencyKey,
    expectedDraftRevision: (await store.resumeThread("thread_01", "surface_01")).draft.revision,
    authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
    ...(variantTargetMessageId === undefined ? {} : { variantTargetMessageId }),
  });
  const claimed = await claimMountedAttempt(binding);
  const attemptId = claimed.attempt.attemptId;
  const durableAt = async (): Promise<number> =>
    (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
  await transitionMountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "arm", observedAtMs: (await durableAt()) + 1 },
  );
  await transitionMountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "running", statusClass: "success", observedAtMs: (await durableAt()) + 2 },
  );
  return attemptId;
}

/**
 * The swipe family is the one mounted mutation that never learned to wait, and a swipe moves the model's
 * active leaf: Pi appends the reply it is streaming as a child of the leaf that exists when the provider
 * answers (`SessionManager.appendMessage`, `agent-session.js` `message_end`), so a leaf moved
 * mid-generation files that reply under a variant it does not answer.
 *
 * The three sibling mutations all refuse a live turn in the store's own transaction
 * (`chat_rewind_turn_active`, `chat_edit_turn_active`, `chat_delete_turn_active`), and that refusal is what
 * makes "the store and Pi are both or neither" true for them - the store call precedes the leaf move.
 * This pins the same rule to the swipe family, with the code the surface already words for exactly this
 * fact: a reply is still being written.
 */
test("swipe and variant removal refuse while a reply is still being written", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-swipe-turn-active-");
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
      opening: "blank",
    });
    const durableAt = async (): Promise<number> =>
      (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;

    // One reply position carrying two variants, committed the way the provider path commits them.
    const replyMessageId = "response_01";
    const firstAttempt = await startRunning(root, store, "Hello", "abcdefghijklmnopqrstuv");
    await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: firstAttempt },
      {
        operation: "commit_presentation",
        cancelEpoch: 0,
        message: { messageId: replyMessageId, text: "Fine.", occurredAtMs: (await durableAt()) + 3 },
        committedAtMs: (await durableAt()) + 3,
      },
    );
    await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: firstAttempt },
      { operation: "claim_completion", claimedAtMs: (await durableAt()) + 4 },
    );
    await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: firstAttempt },
      { operation: "complete", completedAtMs: (await durableAt()) + 5 },
    );
    const variantAttempt = await startRunning(root, store, "Hello", "bcdefghijklmnopqrstuvw", replyMessageId);
    await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: variantAttempt },
      {
        operation: "commit_variant",
        cancelEpoch: 0,
        variant: { targetMessageId: replyMessageId, text: "Better.", occurredAtMs: (await durableAt()) + 6 },
        committedAtMs: (await durableAt()) + 6,
      },
    );
    await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: variantAttempt },
      { operation: "claim_completion", claimedAtMs: (await durableAt()) + 7 },
    );
    await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: variantAttempt },
      { operation: "complete", completedAtMs: (await durableAt()) + 8 },
    );
    const settled = await store.resumeThread("thread_01", "surface_01");
    const settledRow = settled.messages.find((message) => message.messageId === replyMessageId);
    assert.deepEqual(settledRow?.swipes, ["Fine.", "Better."]);
    assert.equal(settledRow?.activeSwipeIndex, 1);

    // The live turn: the player asked again and the provider is writing.
    await startRunning(root, store, "Next?", "cdefghijklmnopqrstuvwx");
    assert.equal((await store.resumeThread("thread_01", "surface_01")).turnLedger?.status, "running");

    await assert.rejects(
      () => store.selectSwipe!(testTransitionAuthority.authority, "thread_01", replyMessageId, { direction: "prev" }),
      /turn_busy/,
    );
    await assert.rejects(
      () => store.removeSwipeVariant!(testTransitionAuthority.authority, "thread_01", replyMessageId, 0),
      /turn_busy/,
    );

    // Neither refusal moved either layer: the position still shows the variant the player was reading.
    const after = await store.resumeThread("thread_01", "surface_01");
    const afterRow = after.messages.find((message) => message.messageId === replyMessageId);
    assert.deepEqual(afterRow?.swipes, ["Fine.", "Better."]);
    assert.equal(afterRow?.activeSwipeIndex, 1);
    assert.equal(afterRow?.text, "Better.");
  } finally {
    await removeTestRoot(root);
  }
});
