import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  acceptMountedPlayerMessage,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
  type GreetingSource,
} from "./chat-thread-store.js";

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

/**
 * The continuity key the mounted acceptance route is registered under (`identityKeyForP4`). One key for
 * the whole file, so the store a test opens is the store the mounted ingress beside it dispatches to.
 */
const storeKey = createHash("sha256")
  .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
  .digest("hex");

async function fixture() {
  const root = await canonicalTestRoot("gamebuddy-chat-fork-");
  let time = 10;
  const store = createChatThreadStore(root, storeKey, () => time++);
  const creation = createProfileAwareChatThreadCreationCapability(store, profileReader);
  return { root, store, creation };
}

function createRequest(chatThreadId: string, chatSurfaceSessionId: string) {
  return {
    chatThreadId,
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId,
    stableArtifactBindings: [{ kind: "persona", sourceId: "persona_01", revision: 4, canonicalHash: "b".repeat(64) }],
    companionWorldBookBinding: {
      worldBookId: "world_book_01",
      revision: 2,
      canonicalHash: "c".repeat(64),
      provenance: "authored",
    },
    opening,
  } as const;
}

/**
 * Every durable row one thread owns, read straight out of the SQLite file by a connection that is not
 * the store's own. This is what "the original thread is unchanged" has to mean: a fork that moved a row
 * could still project the same `ChatThreadState` if the projection forgot a column, so the assertion is
 * made against the rows themselves rather than against the read model.
 */
function durableThreadRows(root: string, chatThreadId: string): string {
  const db = new DatabaseSync(join(root, "tavern", "v3", "continuities", storeKey, "tavern.sqlite"));
  try {
    const dump = (sql: string) => JSON.stringify(db.prepare(sql).all(chatThreadId));
    return [
      dump("SELECT * FROM tavern_threads WHERE thread_id = ?"),
      dump("SELECT * FROM tavern_messages WHERE thread_id = ? ORDER BY append_ordinal"),
      dump("SELECT * FROM tavern_message_swipes WHERE thread_id = ? ORDER BY message_id, swipe_index"),
      dump("SELECT * FROM tavern_thread_stable_artifact_bindings WHERE thread_id = ? ORDER BY kind"),
      dump("SELECT * FROM tavern_thread_world_info_bindings WHERE thread_id = ? ORDER BY slot"),
      dump("SELECT * FROM tavern_turns WHERE thread_id = ? ORDER BY turn_id"),
      dump("SELECT * FROM tavern_thread_forks WHERE thread_id = ?"),
      dump("SELECT * FROM tavern_drafts WHERE thread_id = ?"),
    ].join("\u001f");
  } finally {
    db.close();
  }
}

/** One greeting, two exchanges: opening_01, player_01, response_01, player_02, response_02. */
async function twoExchanges(store: ReturnType<typeof createChatThreadStore>) {
  await store.appendPlayer("thread_01", { messageId: "player_01", text: "Evening.", occurredAtMs: 101 });
  await store.commitResponse("thread_01", { messageId: "response_01", text: "Evening to you.", occurredAtMs: 102 });
  await store.appendPlayer("thread_01", { messageId: "player_02", text: "Busy night?", occurredAtMs: 103 });
  await store.commitResponse("thread_01", { messageId: "response_02", text: "Steady enough.", occurredAtMs: 104 });
}

test("a fork copies the conversation up to one row into a new thread and leaves the original byte-identical", async () => {
  const { root, store, creation } = await fixture();
  try {
    await creation.createExplicit(createRequest("thread_01", "surface_01"));
    await twoExchanges(store);

    const originStateBefore = await store.resumeThread("thread_01", "surface_01");
    const originRowsBefore = durableThreadRows(root, "thread_01");

    const forked = await store.forkThread!({
      originChatThreadId: "thread_01",
      originMessageId: "response_01",
      chatThreadId: "thread_02",
      chatSurfaceSessionId: "surface_02",
    });

    // The new thread carries exactly the prior rows, in order, and nothing after the row it was cut at.
    assert.deepEqual(
      forked.messages.map((message) => message.messageId),
      ["opening_01", "player_01", "response_01"],
    );
    assert.deepEqual(forked.messages, originStateBefore.messages.slice(0, 3));
    // Its own identity, and the link back to where it was cut from.
    assert.equal(forked.thread.chatThreadId, "thread_02");
    assert.equal(forked.thread.chatSurfaceSessionId, "surface_02");
    assert.deepEqual(forked.thread.forkedFrom, { chatThreadId: "thread_01", messageId: "response_01" });
    // Everything that makes it a thread of the same conversation is the origin's own.
    assert.equal(forked.thread.companionId, originStateBefore.thread.companionId);
    assert.equal(forked.thread.continuityId, originStateBefore.thread.continuityId);
    assert.equal(forked.thread.profileId, originStateBefore.thread.profileId);
    assert.equal(forked.thread.profileRevision, originStateBefore.thread.profileRevision);
    assert.equal(forked.thread.profileCanonicalHash, originStateBefore.thread.profileCanonicalHash);
    assert.deepEqual(forked.thread.stableArtifactBindings, originStateBefore.thread.stableArtifactBindings);
    assert.deepEqual(forked.thread.companionWorldBookBinding, originStateBefore.thread.companionWorldBookBinding);
    assert.deepEqual(forked.thread.openingSelection, originStateBefore.thread.openingSelection);
    // A branch is a transcript, not a ledger: nothing ran here yet.
    assert.equal(forked.turnLedger, null);
    assert.deepEqual(forked.draft, { revision: 0, text: null });
    assert.deepEqual(forked.idempotency, []);

    // It is a real thread of the one store: both reads that back the Chat list see it.
    const threads = await store.listThreads!();
    assert.deepEqual(
      threads.map((thread) => thread.chatThreadId),
      ["thread_01", "thread_02"],
    );
    const lastMessages = await store.listThreadLastMessages!();
    assert.deepEqual(
      lastMessages.map((entry) => [entry.chatThreadId, entry.text]),
      [
        ["thread_01", "Steady enough."],
        ["thread_02", "Evening to you."],
      ],
    );
    // And it is bound to the surface session it was given, not the origin's.
    await assert.rejects(() => store.resumeThread("thread_02", "surface_01"), /chat_thread_surface_mismatch/);

    // The original is byte-identical: same projected state, and the same rows on disk.
    assert.deepEqual(await store.resumeThread("thread_01", "surface_01"), originStateBefore);
    assert.equal(durableThreadRows(root, "thread_01"), originRowsBefore);
    assert.equal((await store.resumeThread("thread_01", "surface_01")).thread.forkedFrom, undefined);

    // A fork never lands on a thread that already exists.
    await assert.rejects(
      store.forkThread!({
        originChatThreadId: "thread_01",
        originMessageId: "response_01",
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_03",
      }),
      /chat_thread_already_exists/,
    );
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork from the last row copies the whole conversation", async () => {
  const { root, store, creation } = await fixture();
  try {
    await creation.createExplicit(createRequest("thread_01", "surface_01"));
    await twoExchanges(store);
    const forked = await store.forkThread!({
      originChatThreadId: "thread_01",
      originMessageId: "response_02",
      chatThreadId: "thread_02",
      chatSurfaceSessionId: "surface_02",
    });
    assert.deepEqual(
      forked.messages.map((message) => message.messageId),
      ["opening_01", "player_01", "response_01", "player_02", "response_02"],
    );
    assert.deepEqual(forked.thread.forkedFrom, { chatThreadId: "thread_01", messageId: "response_02" });
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork from a blank opening copies no greeting, because the origin has none", async () => {
  const { root, store, creation } = await fixture();
  try {
    await creation.createExplicit({ ...createRequest("thread_01", "surface_01"), opening: "blank" });
    await store.appendPlayer("thread_01", { messageId: "player_01", text: "Evening.", occurredAtMs: 101 });
    await store.commitResponse("thread_01", { messageId: "response_01", text: "Evening to you.", occurredAtMs: 102 });
    const forked = await store.forkThread!({
      originChatThreadId: "thread_01",
      originMessageId: "player_01",
      chatThreadId: "thread_02",
      chatSurfaceSessionId: "surface_02",
    });
    assert.deepEqual(
      forked.messages.map((message) => message.messageId),
      ["player_01"],
    );
    // The one row is a player line, so the branch opened on nothing and its first row is the player's.
    assert.deepEqual(forked.thread.openingSelection, { kind: "blank" });
    assert.equal(forked.thread.openingLockedAtEventId, "player_01");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork refuses a row this Chat does not carry", async () => {
  const { root, store, creation } = await fixture();
  try {
    await creation.createExplicit(createRequest("thread_01", "surface_01"));
    await twoExchanges(store);
    await assert.rejects(
      store.forkThread!({
        originChatThreadId: "thread_01",
        originMessageId: "response_99",
        chatThreadId: "thread_02",
        chatSurfaceSessionId: "surface_02",
      }),
      /chat_fork_target_not_found/,
    );
    // Nothing was created by the refused attempt.
    assert.deepEqual(
      (await store.listThreads!()).map((thread) => thread.chatThreadId),
      ["thread_01"],
    );
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork refuses while the origin's turn is in flight", async () => {
  const { root, store, creation } = await fixture();
  try {
    await creation.createExplicit(createRequest("thread_01", "surface_01"));
    await twoExchanges(store);
    const accepted = await acceptMountedPlayerMessage(
      {
        runtimeRoot: root,
        playerId: "player_01",
        companionId: "companion_01",
        continuityId: "continuity_01",
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        selectionGeneration: 1,
      },
      {
        text: "One more thing.",
        locale: "en-US",
        idempotencyKey: "abcdefghijklmnopqrstuv",
        expectedDraftRevision: 0,
        authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
      },
    );
    assert.equal(accepted.status, "accepted_queued");
    // The in-flight turn's own player row is already in the transcript; forking at it would copy a line
    // whose reply nobody has read yet.
    await assert.rejects(
      store.forkThread!({
        originChatThreadId: "thread_01",
        originMessageId: accepted.messageId,
        chatThreadId: "thread_02",
        chatSurfaceSessionId: "surface_02",
      }),
      /chat_fork_turn_active/,
    );
    assert.deepEqual(
      (await store.listThreads!()).map((thread) => thread.chatThreadId),
      ["thread_01"],
    );
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork refuses the opening the Chat opened on", async () => {
  const { root, store, creation } = await fixture();
  try {
    await creation.createExplicit(createRequest("thread_01", "surface_01"));
    await twoExchanges(store);
    await assert.rejects(
      store.forkThread!({
        originChatThreadId: "thread_01",
        originMessageId: "opening_01",
        chatThreadId: "thread_02",
        chatSurfaceSessionId: "surface_02",
      }),
      /chat_fork_opening_retained/,
    );
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork refuses an origin thread this store does not carry", async () => {
  const { root, store, creation } = await fixture();
  try {
    await creation.createExplicit(createRequest("thread_01", "surface_01"));
    await assert.rejects(
      store.forkThread!({
        originChatThreadId: "thread_99",
        originMessageId: "opening_01",
        chatThreadId: "thread_02",
        chatSurfaceSessionId: "surface_02",
      }),
      /chat_thread_not_found/,
    );
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
