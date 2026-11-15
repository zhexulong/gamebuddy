import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";

import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { composeTavernProfile } from "./browser-contract/index.js";
import { createChatForkService, forkIdentityFor, isReplayOfFork } from "./chat-fork-service.js";
import {
  type ChatThreadState,
  type GreetingSource,
  classifyInitialChatExactContentFailure,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
} from "./chat-thread-store.js";

/**
 * The two facts the fork entry's idempotency is made of, driven against a real store.
 *
 * The service itself needs a branded mounted lease, which only a real coordinator authority can mint; what a
 * fork can get WRONG, though, is the identity one key mints and the rule that decides whether the Chat a key
 * already names is this fork. Those are the two exported rules below, and the store they act on is the
 * production one.
 */

const source: GreetingSource = {
  greetingSetId: "greetings_01",
  sourceRevision: 2,
  canonicalHash: "a".repeat(64),
  variantId: "alternate_01",
  profileRevision: 3,
  scenarioRevision: null,
};
const opening = { messageId: "opening_01", text: "Welcome to the tavern.", source } as const;

const profileReader = {
  async readExact() {
    return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
  },
};

const storeKey = createHash("sha256")
  .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
  .digest("hex");

/** One 22-character key, the shape the contract's `IdempotencyKey` accepts. */
const KEY = "Fk3qZ9vT2mR7xLb1Nc8Wd4";

async function fixture() {
  const root = await canonicalTestRoot("gamebuddy-chat-fork-service-");
  let time = 10;
  const store = createChatThreadStore(root, storeKey, () => time++);
  const creation = createProfileAwareChatThreadCreationCapability(store, profileReader);
  await creation.createExplicit({
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    stableArtifactBindings: [{ kind: "persona", sourceId: "persona_01", revision: 4, canonicalHash: "b".repeat(64) }],
    opening,
  });
  await store.appendPlayer("thread_01", { messageId: "player_01", text: "Evening.", occurredAtMs: 101 });
  await store.commitResponse("thread_01", { messageId: "response_01", text: "Evening to you.", occurredAtMs: 102 });
  await store.appendPlayer("thread_01", { messageId: "player_02", text: "Busy night?", occurredAtMs: 103 });
  await store.commitResponse("thread_01", { messageId: "response_02", text: "Steady enough.", occurredAtMs: 104 });
  return { root, store };
}

function idsOf(state: ChatThreadState): readonly string[] {
  return state.messages.map((message) => message.messageId);
}

test("a fork at one row carries exactly that prefix, and the source keeps every row it had", async () => {
  const { root, store } = await fixture();
  try {
    const before = idsOf(await store.resumeThread("thread_01", "surface_01"));
    const identity = forkIdentityFor(KEY);
    const forked = await store.forkThread!({
      originChatThreadId: "thread_01",
      originMessageId: "response_01",
      ...identity,
    });

    // The identity is the key's, so a retry cannot mint a different Chat.
    assert.equal(forked.thread.chatThreadId, identity.chatThreadId);
    assert.equal(forked.thread.chatSurfaceSessionId, identity.chatSurfaceSessionId);
    // The branch is the prefix ENDING at the named row - by id, not by count.
    assert.deepEqual(idsOf(forked), ["opening_01", "player_01", "response_01"]);
    assert.deepEqual(forked.thread.forkedFrom, { chatThreadId: "thread_01", messageId: "response_01" });
    // The source keeps all five, in order, and is not the branch.
    assert.deepEqual(idsOf(await store.resumeThread("thread_01", "surface_01")), before);
    assert.deepEqual(before, ["opening_01", "player_01", "response_01", "player_02", "response_02"]);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a second fork at the same row with the same key does not create a second Chat", async () => {
  const { root, store } = await fixture();
  try {
    const identity = forkIdentityFor(KEY);
    await store.forkThread!({
      originChatThreadId: "thread_01",
      originMessageId: "response_01",
      ...identity,
    });
    // The retry derives the identity AGAIN, exactly as a second request does: a derivation that answered
    // differently the second time would mint a second branch and this is where that shows.
    const retry = forkIdentityFor(KEY);
    assert.deepEqual(retry, identity);
    let refused: unknown;
    try {
      await store.forkThread!({
        originChatThreadId: "thread_01",
        originMessageId: "response_01",
        ...retry,
      });
    } catch (error) {
      refused = error;
    }
    assert.equal(classifyInitialChatExactContentFailure(refused), "already_exists");

    const existing = await store.resumeThread(retry.chatThreadId, retry.chatSurfaceSessionId);
    assert.equal(isReplayOfFork(existing, "thread_01", "response_01"), true);
    // The same key pointed at another row is a collision, not a replay.
    assert.equal(isReplayOfFork(existing, "thread_01", "response_02"), false);
    assert.equal(isReplayOfFork(existing, "thread_02", "response_01"), false);

    // Exactly two Chats: the origin and the one branch the key minted.
    assert.deepEqual(
      (await store.listThreads!()).map((thread) => thread.chatThreadId).sort(),
      ["thread_01", identity.chatThreadId].sort(),
    );
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("the fork entry refuses a structural lease it did not receive from the coordinator", async () => {
  const { root, store } = await fixture();
  try {
    const forged = Object.freeze({
      runtimeSession: Object.freeze({}),
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      browserProjection: Object.freeze({
        chatHandle: "forged-chat",
        selectionGeneration: 1,
        selectionStateRevision: "forged-revision",
        projectMessageHandle: () => "forged-message",
        projectTurnHandle: () => "forged-turn",
        projectChatHandle: () => "forged-thread",
        projectCompanionHandle: () => "forged-companion",
      }),
      attachPresentation: () => () => undefined,
      close: async () => undefined,
    }) as unknown as MountedChatRuntimeLease;
    const profile = composeTavernProfile({
      profileId: "gamebuddy.chat-core.reference-pipeline",
      releaseTier: "chat_core",
      routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.fork"],
      operationIds: ["chat.submit", "chat.cancel"],
      navigationItemIds: ["chat"],
    });
    assert.throws(() => createChatForkService({ threads: store, lease: forged, profile }), /chat_fork_unavailable/);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
