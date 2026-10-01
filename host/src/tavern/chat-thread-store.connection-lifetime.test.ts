import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  countMountedRouteRegistrations,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
} from "./chat-thread-store.js";

/**
 * Store connection lifetime.
 *
 * Each store owns exactly one lazily opened SQLite connection that `close()`
 * terminates; a second store on the same root owns its own, and a closed store
 * never silently reopens.
 */

const continuityKey = "a".repeat(64);
const profileReader = {
  async readExact() {
    return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
  },
};

function requestedThread() {
  return {
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    opening: "blank",
  } as const;
}

/** Observable seam for the number of `DatabaseSync` constructions. */
function countingOpener(): Readonly<{ opened: DatabaseSync[]; open: (dbPath: string) => DatabaseSync }> {
  const opened: DatabaseSync[] = [];
  return {
    opened,
    open(dbPath: string): DatabaseSync {
      const db = new DatabaseSync(dbPath);
      opened.push(db);
      return db;
    },
  };
}

async function disposeRoot(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {}
}

test("one store lazily opens exactly one connection and reuses it across reads", async () => {
  const root = await canonicalTestRoot("gamebuddy-connection-lifetime-shared-");
  const opener = countingOpener();
  const store = createChatThreadStore(root, continuityKey, () => 100, opener.open);
  try {
    assert.equal(opener.opened.length, 0, "construction must not open a connection");
    const creation = createProfileAwareChatThreadCreationCapability(store, profileReader);
    await creation.createExplicit(requestedThread());
    assert.equal(opener.opened.length, 1);

    await store.resumeThread("thread_01", "surface_01");
    await store.resumeThread("thread_01", "surface_01");
    await store.listThreads?.();
    await store.saveDraft?.({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      expectedDraftRevision: 0,
      text: "draft",
    });
    assert.equal(opener.opened.length, 1, "later calls must reuse the one connection");

    const state = await store.resumeThread("thread_01", "surface_01");
    assert.equal(state.draft.text, "draft");
  } finally {
    store.close?.();
    await disposeRoot(root);
  }
  assert.equal(opener.opened[0]?.isOpen, false, "close() must terminate the connection");
});

test("a second store on the same root owns its own connection", async () => {
  const root = await canonicalTestRoot("gamebuddy-connection-lifetime-separate-");
  const firstOpener = countingOpener();
  const secondOpener = countingOpener();
  const first = createChatThreadStore(root, continuityKey, () => 100, firstOpener.open);
  const second = createChatThreadStore(root, continuityKey, () => 100, secondOpener.open);
  try {
    const creation = createProfileAwareChatThreadCreationCapability(first, profileReader);
    await creation.createExplicit(requestedThread());
    await second.resumeThread("thread_01", "surface_01");

    assert.equal(firstOpener.opened.length, 1);
    assert.equal(secondOpener.opened.length, 1);
    assert.notEqual(firstOpener.opened[0], secondOpener.opened[0]);

    first.close?.();
    assert.equal(firstOpener.opened[0]?.isOpen, false);
    // Closing one store must not disturb the other store's connection.
    assert.equal(secondOpener.opened[0]?.isOpen, true);
    await second.resumeThread("thread_01", "surface_01");
    assert.equal(secondOpener.opened.length, 1);
  } finally {
    second.close?.();
    await disposeRoot(root);
  }
});

test("close() unregisters exactly this store's five mounted routes", async () => {
  const root = await canonicalTestRoot("gamebuddy-connection-lifetime-routes-");
  const opener = countingOpener();
  const first = createChatThreadStore(root, continuityKey, () => 100, opener.open);
  try {
    assert.equal(countMountedRouteRegistrations(root, continuityKey), 5, "a live store registers all five routes");
    first.close?.();
    assert.equal(countMountedRouteRegistrations(root, continuityKey), 0, "close() must unregister its own routes");

    // A store reopened on the same root/continuity key registers afresh, and
    // closing it again leaves nothing behind (the identity-guarded delete must
    // not detach a successor's closures).
    const second = createChatThreadStore(root, continuityKey, () => 100, opener.open);
    assert.equal(countMountedRouteRegistrations(root, continuityKey), 5);
    second.close?.();
    assert.equal(countMountedRouteRegistrations(root, continuityKey), 0);
  } finally {
    await disposeRoot(root);
  }
});

test("a closed store fails closed and never silently reopens", async () => {
  const root = await canonicalTestRoot("gamebuddy-connection-lifetime-closed-");
  const opener = countingOpener();
  const store = createChatThreadStore(root, continuityKey, () => 100, opener.open);
  try {
    const creation = createProfileAwareChatThreadCreationCapability(store, profileReader);
    await creation.createExplicit(requestedThread());
    assert.equal(opener.opened.length, 1);

    store.close?.();
    assert.equal(opener.opened[0]?.isOpen, false);

    await assert.rejects(() => store.resumeThread("thread_01", "surface_01"), /chat_thread_store_closed/);
    await assert.rejects(
      () => store.appendPlayer("thread_01", { messageId: "player_02", text: "after close", occurredAtMs: 200 }),
      /chat_thread_store_closed/,
    );
    await assert.rejects(
      () => creation.createExplicit({ ...requestedThread(), chatThreadId: "thread_02" }),
      /chat_thread_store_closed/,
    );
    assert.equal(opener.opened.length, 1, "a closed store must not open another connection");

    // close() is idempotent.
    store.close?.();
    store.close?.();
    assert.equal(opener.opened.length, 1);
  } finally {
    await disposeRoot(root);
  }
});
