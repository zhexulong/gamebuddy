import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  type AttemptStartingTurn,
  claimP4MountedAttempt,
  createChatThreadStore,
  type GreetingSource,
  MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES,
  type RunningTurn,
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

const source: GreetingSource = {
  greetingSetId: "greetings_01",
  sourceRevision: 2,
  canonicalHash: "a".repeat(64),
  variantId: "alternate_01",
  profileRevision: 3,
  scenarioRevision: null,
};
const opening = { messageId: "opening_01", text: "Welcome to the tavern.", source } as const;

async function store(key = "a".repeat(64)) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-"));
  let time = 10;
  const s = createChatThreadStore(root, key, () => time++);
  return { root, store: s, key };
}

function request(openingSelection: "blank" | typeof opening = opening) {
  return {
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    opening: openingSelection,
  } as const;
}

test("SQLite schema and WAL pragmas are initialized on first access", async () => {
  const { root, store: s, key } = await store();
  try {
    await s.createThread(request());
    const dbPath = join(root, "tavern", "v1", "continuities", key, "tavern.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const journalMode = (db.prepare("PRAGMA journal_mode").get() as any)?.journal_mode;
      assert.equal(journalMode?.toLowerCase(), "wal");

      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tavern_threads', 'tavern_drafts', 'tavern_active_selection')",
          )
          .all() as any[]
      ).map((row) => row.name);
      assert.deepEqual(tables.sort(), ["tavern_active_selection", "tavern_drafts", "tavern_threads"]);

      // Verify no 0-byte .lock files exist in continuity directory
      const files = await readdir(join(root, "tavern", "v1", "continuities", key));
      assert.equal(
        files.some((f) => f.endsWith(".lock")),
        false,
      );
    } finally {
      db.close();
    }
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("greeting openings require an exact canonical hash on write and reject invalid hashes", async () => {
  const { root, store: s } = await store();
  try {
    await assert.rejects(
      s.createThread({
        chatThreadId: "thread",
        companionId: "companion",
        continuityId: "continuity",
        chatSurfaceSessionId: "surface",
        opening: { messageId: "opening", text: "Hello.", source: { ...source, canonicalHash: undefined } as never },
      }),
      /invalid_greeting_source/,
    );
    await assert.rejects(
      s.createThread({
        chatThreadId: "thread",
        companionId: "companion",
        continuityId: "continuity",
        chatSurfaceSessionId: "surface",
        opening: { messageId: "opening", text: "Hello.", source: { ...source, canonicalHash: "wrong" } },
      }),
      /invalid_greeting_source/,
    );
    const created = await s.createThread(request());
    assert.equal(created.thread.title, null);
    assert.deepEqual(created.thread.openingSelection, { kind: "greeting", messageId: "opening_01", source });
    assert.equal(created.messages.length, 1);
    assert.equal(created.messages[0].messageId, "opening_01");
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("duplicate thread creation is rejected with exact error", async () => {
  const { root, store: s } = await store();
  try {
    await s.createThread(request());
    await assert.rejects(() => s.createThread(request()), /chat_thread_already_exists/);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("missing thread resume fails closed with not_found", async () => {
  const { root, store: s } = await store();
  try {
    await assert.rejects(() => s.resumeThread("missing_01", "surface_01"), /chat_thread_not_found/);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("blank opening creates empty transcript and switches to greeting atomically", async () => {
  const { root, store: s } = await store();
  try {
    const created = await s.createThread(request("blank"));
    assert.deepEqual(created.thread.openingSelection, { kind: "blank" });
    assert.deepEqual(created.messages, []);

    const greeting = await s.commitOpening("thread_01", opening);
    assert.equal(greeting.messages.length, 1);
    assert.equal(greeting.messages[0].messageId, "opening_01");

    const blank = await s.commitOpening("thread_01", "blank");
    assert.deepEqual(blank.thread.openingSelection, { kind: "blank" });
    assert.deepEqual(blank.messages, []);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("first player message or response locks the opening", async () => {
  const { root, store: s } = await store();
  try {
    await s.createThread(request());
    const player = await s.appendPlayer("thread_01", { messageId: "player_01", text: "Hello", occurredAtMs: 101 });
    assert.equal(player.thread.openingLockedAtEventId, "player_01");
    await assert.rejects(() => s.commitOpening("thread_01", "blank"), /chat_thread_opening_locked/);

    const response = await s.commitResponse("thread_01", {
      messageId: "response_01",
      text: "Hello back",
      occurredAtMs: 102,
    });
    assert.deepEqual(
      response.messages.map((m) => m.messageId),
      ["opening_01", "player_01", "response_01"],
    );
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("appendPlayer and commitResponse are idempotent on identical re-submission and reject conflicts", async () => {
  const { root, store: s } = await store();
  try {
    await s.createThread(request());
    const first = await s.appendPlayer("thread_01", { messageId: "player_01", text: "Hello", occurredAtMs: 101 });
    const replay = await s.appendPlayer("thread_01", { messageId: "player_01", text: "Hello", occurredAtMs: 101 });
    assert.deepEqual(replay, first);

    await assert.rejects(
      () => s.appendPlayer("thread_01", { messageId: "player_01", text: "Different", occurredAtMs: 101 }),
      /chat_thread_message_id_conflict/,
    );

    const resp = await s.commitResponse("thread_01", { messageId: "response_01", text: "Hi", occurredAtMs: 102 });
    const respReplay = await s.commitResponse("thread_01", {
      messageId: "response_01",
      text: "Hi",
      occurredAtMs: 102,
    });
    assert.deepEqual(respReplay, resp);

    await assert.rejects(
      () => s.commitResponse("thread_01", { messageId: "response_01", text: "Conflicting", occurredAtMs: 102 }),
      /chat_thread_message_id_conflict/,
    );
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("draft save and discard update revision monotonically with CAS guard", async () => {
  const { root, store: s } = await store();
  try {
    await s.createThread(request());
    const initial = await s.resumeThread("thread_01", "surface_01");
    assert.deepEqual(initial.draft, { revision: 0, text: null });

    const draft1 = await s.saveDraft!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      expectedDraftRevision: 0,
      text: "Draft text",
    });
    assert.deepEqual(draft1, { revision: 1, text: "Draft text" });

    // Stale revision CAS rejection
    await assert.rejects(
      () =>
        s.saveDraft!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId: "surface_01",
          expectedDraftRevision: 0,
          text: "Stale",
        }),
      /chat_draft_revision_conflict/,
    );

    const discarded = await s.discardDraft!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      expectedDraftRevision: 1,
    });
    assert.deepEqual(discarded, { revision: 2, text: null });
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("lifecycle transitions increment managementRevision monotonically with CAS guard", async () => {
  const { root, store: s } = await store();
  try {
    await s.createThread(request());
    const thread1 = await s.transitionLifecycle!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      expectedManagementRevision: 1,
      operation: "archive",
    });
    assert.equal(thread1.lifecycleStatus, "archived");
    assert.equal(thread1.managementRevision, 2);

    // Stale management revision conflict
    await assert.rejects(
      () =>
        s.transitionLifecycle!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId: "surface_01",
          companionId: "companion_01",
          continuityId: "continuity_01",
          expectedManagementRevision: 1,
          operation: "restore",
        }),
      /chat_thread_management_revision_conflict/,
    );

    const thread2 = await s.transitionLifecycle!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      expectedManagementRevision: 2,
      operation: "trash",
    });
    assert.equal(thread2.lifecycleStatus, "trashed");
    assert.equal(thread2.trashRestoreStatus, "archived");
    assert.equal(thread2.managementRevision, 3);

    const thread3 = await s.transitionLifecycle!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      expectedManagementRevision: 3,
      operation: "restore",
    });
    assert.equal(thread3.lifecycleStatus, "archived");
    assert.equal(thread3.managementRevision, 4);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("renameThreadTitle updates title and increments managementRevision with CAS", async () => {
  const { root, store: s } = await store();
  try {
    await s.createThread(request());
    const renamed = await s.renameThreadTitle!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      expectedManagementRevision: 1,
      title: "My New Chat Title",
    });
    assert.equal(renamed.title, "My New Chat Title");
    assert.equal(renamed.managementRevision, 2);

    // Same title throws unchanged error
    await assert.rejects(
      () =>
        s.renameThreadTitle!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId: "surface_01",
          expectedManagementRevision: 2,
          title: "My New Chat Title",
        }),
      /chat_thread_title_unchanged/,
    );

    // Stale revision throws conflict error
    await assert.rejects(
      () =>
        s.renameThreadTitle!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId: "surface_01",
          expectedManagementRevision: 1,
          title: "Another Title",
        }),
      /chat_thread_management_revision_conflict/,
    );
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("active thread selection persists singleton and detects surface mismatch", async () => {
  const { root, store: s } = await store();
  try {
    await s.createThread(request());
    const selection = await s.selectActiveThread("thread_01", "surface_01");
    assert.equal(selection.chatThreadId, "thread_01");
    assert.equal(selection.chatSurfaceSessionId, "surface_01");

    const read = await s.readActiveThreadSelection();
    assert.deepEqual(read, selection);

    await assert.rejects(() => s.selectActiveThread("thread_01", "wrong_surface"), /chat_thread_surface_mismatch/);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("capacity limit of 500 messages is strictly enforced", async () => {
  const { root, store: s } = await store();
  try {
    await s.createThread(request()); // 1 message (opening)
    for (let i = 1; i < MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES; i++) {
      await s.appendPlayer("thread_01", {
        messageId: `player_${String(i).padStart(4, "0")}`,
        text: `Message ${i}`,
        occurredAtMs: 100 + i,
      });
    }
    const state = await s.resumeThread("thread_01", "surface_01");
    assert.equal(state.messages.length, MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES);

    // 501st message is rejected
    await assert.rejects(
      () =>
        s.appendPlayer("thread_01", {
          messageId: "player_overflow",
          text: "Overflow",
          occurredAtMs: 9999,
        }),
      /chat_thread_capacity_exceeded/,
    );
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("concurrent transactions across store instances preserve monotonic managementRevision with 0 deadlocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-concurrency-"));
  const continuityKey = "c".repeat(64);
  try {
    const store1 = createChatThreadStore(root, continuityKey, () => 100);
    const store2 = createChatThreadStore(root, continuityKey, () => 101);
    await store1.createThread({
      chatThreadId: "thread_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatSurfaceSessionId: "surface_01",
      opening: "blank",
    });

    // Run 20 concurrent renames/transitions from two store instances
    let currentRevision = 1;
    for (let round = 0; round < 10; round++) {
      const op1 = store1.renameThreadTitle!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        expectedManagementRevision: currentRevision,
        title: `Title round ${round} by store 1`,
      });
      const op2 = store2.renameThreadTitle!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        expectedManagementRevision: currentRevision,
        title: `Title round ${round} by store 2`,
      });

      const results = await Promise.allSettled([op1, op2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly one succeeds and one fails with CAS conflict
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.match(String((rejected[0] as PromiseRejectedResult).reason), /chat_thread_management_revision_conflict/);

      currentRevision = (fulfilled[0] as PromiseFulfilledResult<any>).value.managementRevision;
      assert.equal(currentRevision, round + 2);
    }

    store1.close?.();
    store2.close?.();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("P4 durable turn acceptance, claim, start, and presentation transitions work atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p4p5-"));
  const continuityKey = createHash("sha256")
    .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
    .digest("hex");
  try {
    const t0 = Date.now();
    const s = createChatThreadStore(root, continuityKey, () => t0);
    await s.createThread({
      chatThreadId: "thread_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatSurfaceSessionId: "surface_01",
      opening: "blank",
    });

    const binding = {
      runtimeRoot: root,
      playerId: "player_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      selectionGeneration: 1,
    };

    const accepted = await (await import("./chat-thread-store.js")).acceptP4MountedPlayerMessage(binding, {
      text: "Hello from P4",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
    });
    assert.equal(accepted.status, "accepted_queued");

    const claimBinding = {
      ...binding,
      runtimeBindingDigest: "b".repeat(64),
      runtimeOwner: {
        ownerToken: "owner_01",
        runtimeInstanceId: "inst_01",
        ownerPid: 1234,
        ownerProcessStartIdentity: "pid_1234",
      },
    };

    const claimed = await claimP4MountedAttempt(claimBinding);
    assert.equal(claimed.status, "attempt_starting");

    const armed = await transitionP4MountedProviderStart(
      { ...claimBinding, attemptId: claimed.attempt.attemptId },
      { operation: "arm", observedAtMs: t0 + 1000 },
    );
    assert.equal(armed.status, "attempt_starting");

    const running = await transitionP4MountedProviderStart(
      { ...claimBinding, attemptId: claimed.attempt.attemptId },
      { operation: "running", statusClass: "success", observedAtMs: t0 + 2000 },
    );
    assert.equal(running.status, "running");

    const committed = await transitionP5MountedPresentation(
      { ...claimBinding, attemptId: claimed.attempt.attemptId },
      {
        operation: "commit_presentation",
        cancelEpoch: 1,
        message: { messageId: "resp_01", text: "Response from P5", occurredAtMs: t0 + 3000 },
        committedAtMs: t0 + 3000,
      },
    );
    assert.equal(committed.status, "presentation_committed");

    const state = await s.resumeThread("thread_01", "surface_01");
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0].text, "Hello from P4");
    assert.equal(state.messages[1].text, "Response from P5");

    s.close?.();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
