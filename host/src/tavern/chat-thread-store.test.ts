import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  claimMountedAttempt,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
  type GreetingSource,
  transitionMountedProviderStart as rawTransitionP4MountedProviderStart,
  transitionMountedPresentation as rawTransitionP5MountedPresentation,
  acknowledgeMountedWorldInfoBinding,
  boundedVisibleTail,
  type TavernStableManagedWorldInfoBinding,
} from "./chat-thread-store.js";
import { createMountedTurnTransitionAuthority } from "./chat-thread-store.mounted-turn-transition.internal.js";

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
async function store(key = "a".repeat(64)) {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-");
  let time = 10;
  const s = createChatThreadStore(root, key, () => time++);
  const creation = createProfileAwareChatThreadCreationCapability(s, profileReader);
  return { root, store: s, creation, key };
}

function request(openingSelection: "blank" | typeof opening = opening) {
  return {
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    profileId: "profile_01",
    profileRevision: 1,
    profileCanonicalHash: "a".repeat(64),
    opening: openingSelection,
  } as const;
}

test("SQLite schema and WAL pragmas are initialized on first access", async () => {
  const { root, store: s, creation, key } = await store();
  try {
    await creation.createExplicit(request());
    const dbPath = join(root, "tavern", "v3", "continuities", key, "tavern.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const journalMode = (db.prepare("PRAGMA journal_mode").get() as any)?.journal_mode;
      assert.equal(journalMode?.toLowerCase(), "wal");

      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tavern_threads', 'tavern_messages', 'tavern_message_swipes', 'tavern_thread_stable_artifact_bindings', 'tavern_thread_world_info_bindings', 'tavern_turns', 'tavern_turn_variants', 'tavern_turn_attempts', 'tavern_turn_observations', 'tavern_turn_presentations', 'tavern_turn_terminalizations', 'tavern_chat_submit_idempotency', 'tavern_drafts', 'tavern_active_selection')",
          )
          .all() as any[]
      ).map((row) => row.name);
      assert.deepEqual(tables.sort(), [
        "tavern_active_selection",
        "tavern_chat_submit_idempotency",
        "tavern_drafts",
        "tavern_message_swipes",
        "tavern_messages",
        "tavern_thread_stable_artifact_bindings",
        "tavern_thread_world_info_bindings",
        "tavern_threads",
        "tavern_turn_attempts",
        "tavern_turn_observations",
        "tavern_turn_presentations",
        "tavern_turn_terminalizations",
        "tavern_turn_variants",
        "tavern_turns",
      ]);
      assert.equal(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM pragma_table_info('tavern_threads') WHERE name IN ('metadata_json', 'opening_selection_json')",
            )
            .get() as any
        ).count,
        0,
      );

      // Verify no 0-byte .lock files exist in continuity directory
      const files = await readdir(join(root, "tavern", "v3", "continuities", key));
      assert.equal(
        files.some((f) => f.endsWith(".lock")),
        false,
      );
    } finally {
      db.close();
    }
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("greeting openings require an exact canonical hash on write and reject invalid hashes", async () => {
  const { root, store: s, creation } = await store();
  try {
    await assert.rejects(
      creation.createExplicit({
        chatThreadId: "thread",
        companionId: "companion",
        continuityId: "continuity",
        chatSurfaceSessionId: "surface",
        opening: { messageId: "opening", text: "Hello.", source: { ...source, canonicalHash: undefined } as never },
      }),
      /invalid_greeting_source/,
    );
    await assert.rejects(
      creation.createExplicit({
        chatThreadId: "thread",
        companionId: "companion",
        continuityId: "continuity",
        chatSurfaceSessionId: "surface",
        opening: { messageId: "opening", text: "Hello.", source: { ...source, canonicalHash: "wrong" } },
      }),
      /invalid_greeting_source/,
    );
    const created = await creation.createExplicit(request());
    assert.equal(created.thread.title, null);
    assert.deepEqual(created.thread.openingSelection, { kind: "greeting", messageId: "opening_01", source });
    assert.equal(created.messages.length, 1);
    assert.equal(created.messages[0]?.messageId, "opening_01");
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate thread creation is rejected with exact error", async () => {
  const { root, store: s, creation } = await store();
  try {
    await creation.createExplicit(request());
    await assert.rejects(() => creation.createExplicit(request()), /chat_thread_already_exists/);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing thread resume fails closed with not_found", async () => {
  const { root, store: s } = await store();
  try {
    await assert.rejects(() => s.resumeThread("missing_01", "surface_01"), /chat_thread_not_found/);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("blank opening creates empty transcript and switches to greeting atomically", async () => {
  const { root, store: s, creation } = await store();
  try {
    const created = await creation.createExplicit(request("blank"));
    assert.deepEqual(created.thread.openingSelection, { kind: "blank" });
    assert.deepEqual(created.messages, []);

    const greeting = await s.commitOpening("thread_01", opening);
    assert.equal(greeting.messages.length, 1);
    assert.equal(greeting.messages[0]?.messageId, "opening_01");

    const blank = await s.commitOpening("thread_01", "blank");
    assert.deepEqual(blank.thread.openingSelection, { kind: "blank" });
    assert.deepEqual(blank.messages, []);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("first player message or response locks the opening", async () => {
  const { root, store: s, creation } = await store();
  try {
    await creation.createExplicit(request());
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
    await rm(root, { recursive: true, force: true });
  }
});

test("appendPlayer and commitResponse are idempotent on identical re-submission and reject conflicts", async () => {
  const { root, store: s, creation } = await store();
  try {
    await creation.createExplicit(request());
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
    await rm(root, { recursive: true, force: true });
  }
});

test("draft save and discard update revision monotonically with CAS guard", async () => {
  const { root, store: s, creation } = await store();
  try {
    await creation.createExplicit(request());
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
    await rm(root, { recursive: true, force: true });
  }
});

test("multiline drafts preserve newline, CRLF, and tab text", async () => {
  const { root, store: s, creation } = await store();
  const multiline = "first line\nsecond line\r\nthird line\twith tab";
  try {
    await creation.createExplicit(request("blank"));
    const draft = await s.saveDraft!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      expectedDraftRevision: 0,
      text: multiline,
    });
    assert.equal(draft.text, multiline);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle transitions increment managementRevision monotonically with CAS guard", async () => {
  const { root, store: s, creation } = await store();
  try {
    await creation.createExplicit(request());
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
    await rm(root, { recursive: true, force: true });
  }
});

test("renameThreadTitle updates title and increments managementRevision with CAS", async () => {
  const { root, store: s, creation } = await store();
  try {
    await creation.createExplicit(request());
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
    await rm(root, { recursive: true, force: true });
  }
});

test("active thread selection persists singleton and detects surface mismatch", async () => {
  const { root, store: s, creation } = await store();
  try {
    await creation.createExplicit(request());
    const selection = await s.selectActiveThread("thread_01", "surface_01");
    assert.equal(selection.chatThreadId, "thread_01");
    assert.equal(selection.chatSurfaceSessionId, "surface_01");

    const read = await s.readActiveThreadSelection();
    assert.deepEqual(read, selection);

    await assert.rejects(() => s.selectActiveThread("thread_01", "wrong_surface"), /chat_thread_surface_mismatch/);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("normalized transcript has no fixed entry ceiling", async () => {
  const { root, store: s, creation } = await store();
  try {
    await creation.createExplicit(request());
    for (let i = 1; i <= 501; i++) {
      await s.appendPlayer("thread_01", {
        messageId: `player_${String(i).padStart(4, "0")}`,
        text: `Message ${i}`,
        occurredAtMs: 100 + i,
      });
    }
    assert.equal((await s.resumeThread("thread_01", "surface_01")).messages.length, 502);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent transactions across store instances preserve monotonic managementRevision with 0 deadlocks", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-concurrency-");
  const continuityKey = "c".repeat(64);
  try {
    const store1 = createChatThreadStore(root, continuityKey, () => 100);
    const store2 = createChatThreadStore(root, continuityKey, () => 101);
    const creation1 = createProfileAwareChatThreadCreationCapability(store1, profileReader);
    await creation1.createExplicit({
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
    await rm(root, { recursive: true, force: true });
  }
});

test("World Info desired edits preserve applied revision, pending unbind is durable, and stale acceptance is blocked", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-world-info-lifecycle-");
  const key = createHash("sha256").update(["player_01", "companion_01", "continuity_01"].join("\u001f")).digest("hex");
  const revision1: TavernStableManagedWorldInfoBinding = Object.freeze({
    source: "managed_world_info",
    publicTitle: "Pelican Town",
    revision: 1,
    canonicalHash: "a".repeat(64),
  });
  const revision2: TavernStableManagedWorldInfoBinding = Object.freeze({
    source: "managed_world_info",
    publicTitle: "Pelican Town",
    revision: 2,
    canonicalHash: "b".repeat(64),
  });
  try {
    const s = createChatThreadStore(root, key);
    const creation = createProfileAwareChatThreadCreationCapability(s, profileReader);
    await creation.createExplicit({
      chatThreadId: "thread_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatSurfaceSessionId: "surface_01",
      managedWorldInfoBinding: revision1,
      opening: "blank",
    });
    let state = await s.resumeThread("thread_01", "surface_01");
    assert.deepEqual(state.thread.managedWorldInfoBinding, revision1);
    assert.deepEqual(state.thread.appliedManagedWorldInfoBinding, revision1);
    state = await s.appendPlayer("thread_01", {
      messageId: "player_01",
      text: "active turn",
      occurredAtMs: Date.now(),
    });
    state = await s.setManagedWorldInfoBinding!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      expectedUpdatedAtMs: state.thread.updatedAtMs,
      binding: revision2,
    });
    assert.deepEqual(state.thread.managedWorldInfoBinding, revision2);
    assert.deepEqual(state.thread.appliedManagedWorldInfoBinding, revision1);
    await assert.rejects(
      () =>
        import("./chat-thread-store.js").then(({ acceptMountedPlayerMessage }) =>
          acceptMountedPlayerMessage(
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
              text: "blocked",
              locale: "en",
              idempotencyKey: "abcdefghijklmnopqrstuv",
              expectedDraftRevision: 0,
              authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
            },
          ),
        ),
      /context_unavailable/,
    );
    state = await s.setManagedWorldInfoBinding!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      expectedUpdatedAtMs: state.thread.updatedAtMs,
    });
    assert.equal(state.thread.managedWorldInfoBinding, undefined);
    assert.deepEqual(state.thread.appliedManagedWorldInfoBinding, revision1);
    s.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordinator-branded World Info acknowledgement applies only the exact desired binding after terminal settlement", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-world-info-ack-");
  const key = createHash("sha256").update(["player_01", "companion_01", "continuity_01"].join("\u001f")).digest("hex");
  const revision1: TavernStableManagedWorldInfoBinding = Object.freeze({
    source: "managed_world_info",
    publicTitle: "Pelican Town",
    revision: 1,
    canonicalHash: "a".repeat(64),
  });
  const revision2: TavernStableManagedWorldInfoBinding = Object.freeze({
    source: "managed_world_info",
    publicTitle: "Pelican Town",
    revision: 2,
    canonicalHash: "b".repeat(64),
  });
  const authority = createMountedTurnTransitionAuthority();
  const operation = authority.mintOperation();
  try {
    const s = createChatThreadStore(root, key);
    const creation = createProfileAwareChatThreadCreationCapability(s, profileReader);
    await creation.createExplicit({
      chatThreadId: "thread_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatSurfaceSessionId: "surface_01",
      managedWorldInfoBinding: revision1,
      opening: "blank",
    });
    let state = await s.resumeThread("thread_01", "surface_01");
    await s.setManagedWorldInfoBinding!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      expectedUpdatedAtMs: state.thread.updatedAtMs,
      binding: revision2,
    });
    state = await acknowledgeMountedWorldInfoBinding({
      authority: authority.authority,
      operationAuthority: operation.authority,
      runtimeRoot: root,
      playerId: "player_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      binding: revision2,
      expectedOldAppliedBinding: revision1,
    });
    assert.deepEqual(state.thread.appliedManagedWorldInfoBinding, revision2);
    await assert.rejects(
      () =>
        acknowledgeMountedWorldInfoBinding({
          authority: authority.authority,
          operationAuthority: operation.authority,
          runtimeRoot: root,
          playerId: "player_01",
          companionId: "companion_01",
          continuityId: "continuity_01",
          chatThreadId: "thread_01",
          chatSurfaceSessionId: "surface_01",
          binding: revision1,
          expectedOldAppliedBinding: revision1,
        }),
      /chat_thread_worldbook_applied_conflict/,
    );
    s.close?.();
  } finally {
    operation.revoke();
    authority.revoke();
    await rm(root, { recursive: true, force: true });
  }
});

// A live v4 root holds ONE binding row per thread, and that row belongs to ONE
// source family (the v4 CHECK required it); v5 keeps one row per slot. The fixture
// below builds the real current root and then re-shapes ONLY the one table v5
// changed (plus the recorded version), which is exactly the difference a live v4
// root has, so the migration runs against a real old-shaped file.
//
// The first version of this fixture wrote ONE thread carrying both families and
// then tried to fold them back into a single v4 row: that cannot exist. The
// `INSERT` hit `UNIQUE constraint failed: ...thread_id` - and because the raw handle
// was still open when the throw left the scope, the `rm` in the `finally` blocked
// instead of failing, so the whole file hung (0.0 s of CPU over a minute) rather
// than reporting a fixture error. Two threads, one family each, is what a v4 root
// actually looks like; the raw handle is closed in a `finally` so a fixture fault
// can never hang the runner again.
test("a v4 root keeps the companion's own book and the attached managed item across the slot migration", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-world-info-migration-");
  const key = createHash("sha256").update(["player_01", "companion_01", "continuity_01"].join("\u001f")).digest("hex");
  const companionRevision = Object.freeze({
    worldBookId: "gamebuddy-worldbook-default-companion",
    revision: 1,
    canonicalHash: "d".repeat(64),
    provenance: "reviewed-import" as const,
  });
  const managedRevision: TavernStableManagedWorldInfoBinding = Object.freeze({
    source: "managed_world_info",
    publicTitle: "Pelican Town",
    revision: 3,
    canonicalHash: "c".repeat(64),
  });
  try {
    const s = createChatThreadStore(root, key);
    const creation = createProfileAwareChatThreadCreationCapability(s, profileReader);
    await creation.createExplicit({
      chatThreadId: "thread_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatSurfaceSessionId: "surface_01",
      companionWorldBookBinding: companionRevision,
      opening: "blank",
    });
    await creation.createExplicit({
      chatThreadId: "thread_02",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatSurfaceSessionId: "surface_02",
      managedWorldInfoBinding: managedRevision,
      opening: "blank",
    });
    s.close?.();
    const dbPath = join(root, "tavern", "v3", "continuities", key, "tavern.sqlite");
    const oldShape = new DatabaseSync(dbPath);
    try {
      oldShape.exec(`
      ALTER TABLE tavern_thread_world_info_bindings RENAME TO tavern_thread_world_info_bindings_v5;
      CREATE TABLE tavern_thread_world_info_bindings (
        thread_id TEXT PRIMARY KEY REFERENCES tavern_threads(thread_id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source IN ('world_book', 'managed_world_info')),
        world_book_id TEXT,
        public_title TEXT,
        revision INTEGER CHECK(revision IS NULL OR revision > 0),
        canonical_hash TEXT,
        provenance TEXT,
        applied_revision INTEGER CHECK(applied_revision IS NULL OR applied_revision > 0),
        applied_canonical_hash TEXT,
        applied_public_title TEXT,
        applied_world_book_id TEXT,
        CHECK(
          (
            (
              source = 'world_book'
              AND public_title IS NULL
              AND provenance IN ('authored', 'st-card-import', 'reviewed-import')
              AND (world_book_id IS NOT NULL OR applied_world_book_id IS NOT NULL)
            )
            OR
            (
              source = 'managed_world_info'
              AND world_book_id IS NULL
              AND provenance IS NULL
              AND (public_title IS NOT NULL OR applied_public_title IS NOT NULL)
            )
          )
          AND ((revision IS NOT NULL AND canonical_hash IS NOT NULL) OR (revision IS NULL AND canonical_hash IS NULL))
          AND (
            (
              applied_revision IS NULL
              AND applied_canonical_hash IS NULL
              AND applied_public_title IS NULL
              AND applied_world_book_id IS NULL
            )
            OR (
              applied_revision IS NOT NULL
              AND applied_canonical_hash IS NOT NULL
              AND (
                (source = 'managed_world_info' AND applied_public_title IS NOT NULL AND applied_world_book_id IS NULL)
                OR (source = 'world_book' AND applied_public_title IS NULL AND applied_world_book_id IS NOT NULL)
              )
            )
          )
        )
      );
      INSERT INTO tavern_thread_world_info_bindings (
        thread_id, source, world_book_id, public_title, revision, canonical_hash, provenance,
        applied_revision, applied_canonical_hash, applied_public_title, applied_world_book_id
      )
      SELECT
        thread_id,
        CASE slot WHEN 'companion' THEN 'world_book' ELSE 'managed_world_info' END,
        world_book_id, public_title, revision, canonical_hash, provenance,
        applied_revision, applied_canonical_hash, applied_public_title, applied_world_book_id
      FROM tavern_thread_world_info_bindings_v5;
      DROP TABLE tavern_thread_world_info_bindings_v5;
      -- A genuine v4 root predates the message -> session-entry binding (schema v6), so the fixture drops
      -- it too: the migration under test has to add it back, not find it already there.
      DROP TABLE tavern_message_entries;
      PRAGMA user_version = 4;
    `);
    } finally {
      // Closed here rather than on the success path alone: a fixture that throws must
      // not leave the file open, because an open handle makes the `rm` below block
      // instead of failing (which is how this test hung the whole file).
      oldShape.close();
    }

    const migrated = createChatThreadStore(root, key);
    const first = await migrated.resumeThread("thread_01", "surface_01");
    const second = await migrated.resumeThread("thread_02", "surface_02");
    assert.deepEqual(first.thread.companionWorldBookBinding, companionRevision);
    assert.deepEqual(first.thread.appliedCompanionWorldBookBinding, companionRevision);
    assert.equal(first.thread.managedWorldInfoBinding, undefined);
    assert.deepEqual(second.thread.managedWorldInfoBinding, managedRevision);
    assert.deepEqual(second.thread.appliedManagedWorldInfoBinding, managedRevision);
    assert.equal(second.thread.companionWorldBookBinding, undefined);
    migrated.close?.();
    const inspected = new DatabaseSync(dbPath);
    try {
      const version = (inspected.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      const slots = (
        inspected.prepare("SELECT slot FROM tavern_thread_world_info_bindings ORDER BY slot, thread_id").all() as any[]
      ).map((row) => row.slot);
      assert.equal(version, 6);
      assert.deepEqual(slots, ["companion", "managed"]);
    } finally {
      inspected.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("volatile selector uses accepted text and bounded tail while returning refs only", async () => {
  const { selectAuthoredContextVolatileSourceRefs } = await import("./chat-thread-store.js");
  const candidate = {
    sourceId: "world-info_entry_1",
    kind: "lorebook_entry" as const,
    revision: "1",
    canonicalHash: createHash("sha256").update("secret body").digest("hex"),
    totalOrderKey: "0001",
    provenance: "world-info/revision/1",
    content: "secret body",
    budgetTokens: 12,
    selectionKeys: ["moon festival"],
  };
  const selected = selectAuthoredContextVolatileSourceRefs("Discuss the Moon Festival", "visible tail", [candidate]);
  assert.equal(selected.tokenCount, 12);
  assert.deepEqual(selected.refs, [
    {
      sourceId: candidate.sourceId,
      kind: candidate.kind,
      revision: candidate.revision,
      canonicalHash: candidate.canonicalHash,
      totalOrderKey: candidate.totalOrderKey,
      provenance: candidate.provenance,
    },
  ]);
  assert.equal("content" in selected.refs[0]!, false);
  assert.deepEqual(selectAuthoredContextVolatileSourceRefs("unrelated", "visible tail", [candidate]), {
    refs: [],
    tokenCount: 0,
  });
});

test("volatile selector respects secondaryKeys and selectiveLogic across all 4 modes", async () => {
  const { selectAuthoredContextVolatileSourceRefs } = await import("./chat-thread-store.js");

  const makeCandidate = (
    id: string,
    selectionKeys: string[],
    secondaryKeys?: string[],
    selectiveLogic?: 0 | 1 | 2 | 3,
  ) => ({
    sourceId: `source_${id}`,
    kind: "lorebook_entry" as const,
    revision: "1",
    canonicalHash: createHash("sha256").update(`content ${id}`).digest("hex"),
    totalOrderKey: id.padStart(4, "0"),
    provenance: `world-info/${id}`,
    content: `content ${id}`,
    budgetTokens: 10,
    selectionKeys,
    ...(secondaryKeys !== undefined ? { secondaryKeys } : {}),
    ...(selectiveLogic !== undefined ? { selectiveLogic } : {}),
  });

  // cand0: logic 0 (AND ANY) with secondaryKeys ["fire", "water"]
  const cand0 = makeCandidate("0", ["magic"], ["fire", "water"], 0);
  // cand1: logic 1 (NOT ALL) with secondaryKeys ["fire", "water"]
  const cand1 = makeCandidate("1", ["magic"], ["fire", "water"], 1);
  // cand2: logic 2 (NOT ANY) with secondaryKeys ["fire", "water"]
  const cand2 = makeCandidate("2", ["magic"], ["fire", "water"], 2);
  // cand3: logic 3 (AND ALL) with secondaryKeys ["fire", "water"]
  const cand3 = makeCandidate("3", ["magic"], ["fire", "water"], 3);

  // Scenario A: corpus has primary "magic" and neither secondary
  {
    const res = selectAuthoredContextVolatileSourceRefs("cast magic spell", "tail", [cand0, cand1, cand2, cand3]);
    const ids = res.refs.map((r) => r.sourceId);
    // 0 (AND ANY): false (0/2 match) -> suppressed
    // 1 (NOT ALL): true (0/2 match, !allSecondary) -> triggered
    // 2 (NOT ANY): true (0/2 match, !anySecondary) -> triggered
    // 3 (AND ALL): false (0/2 match) -> suppressed
    assert.deepEqual(ids, ["source_1", "source_2"]);
  }

  // Scenario B: corpus has primary "magic" and one secondary "fire"
  {
    const res = selectAuthoredContextVolatileSourceRefs("cast magic fire", "tail", [cand0, cand1, cand2, cand3]);
    const ids = res.refs.map((r) => r.sourceId);
    // 0 (AND ANY): true (1/2 match) -> triggered
    // 1 (NOT ALL): true (1/2 match, !allSecondary) -> triggered
    // 2 (NOT ANY): false (1/2 match, !anySecondary is false) -> suppressed
    // 3 (AND ALL): false (1/2 match, allSecondary is false) -> suppressed
    assert.deepEqual(ids, ["source_0", "source_1"]);
  }

  // Scenario C: corpus has primary "magic" and both secondaries "fire" and "water"
  {
    const res = selectAuthoredContextVolatileSourceRefs("cast magic fire and water", "tail", [
      cand0,
      cand1,
      cand2,
      cand3,
    ]);
    const ids = res.refs.map((r) => r.sourceId);
    // 0 (AND ANY): true (2/2 match) -> triggered
    // 1 (NOT ALL): false (2/2 match, !allSecondary is false) -> suppressed
    // 2 (NOT ANY): false (2/2 match, !anySecondary is false) -> suppressed
    // 3 (AND ALL): true (2/2 match, allSecondary is true) -> triggered
    assert.deepEqual(ids, ["source_0", "source_3"]);
  }

  // Scenario D: corpus has both secondaries "fire" and "water", but NO primary "magic"
  {
    const res = selectAuthoredContextVolatileSourceRefs("fire and water everywhere", "tail", [
      cand0,
      cand1,
      cand2,
      cand3,
    ]);
    // None should trigger because primaryMatch fails
    assert.deepEqual(res.refs, []);
    assert.equal(res.tokenCount, 0);
  }

  // Scenario E: default selectiveLogic is 0 (AND ANY) when secondaryKeys is present but selectiveLogic is undefined
  {
    const candDefault = makeCandidate("def", ["magic"], ["fire", "water"]);
    const resHit = selectAuthoredContextVolatileSourceRefs("magic fire", "tail", [candDefault]);
    assert.equal(resHit.refs.length, 1);
    const resMiss = selectAuthoredContextVolatileSourceRefs("magic only", "tail", [candDefault]);
    assert.equal(resMiss.refs.length, 0);
  }

  // Scenario F: validation rejects invalid secondaryKeys and selectiveLogic
  {
    assert.throws(
      () => selectAuthoredContextVolatileSourceRefs("magic", "tail", [{ ...cand0, secondaryKeys: [] as any }]),
      /invalid_chat_turn_context_volatile_candidate/,
    );
    assert.throws(
      () => selectAuthoredContextVolatileSourceRefs("magic", "tail", [{ ...cand0, secondaryKeys: [""] as any }]),
      /invalid_chat_turn_context_volatile_candidate/,
    );
    assert.throws(
      () => selectAuthoredContextVolatileSourceRefs("magic", "tail", [{ ...cand0, secondaryKeys: [123] as any }]),
      /invalid_chat_turn_context_volatile_candidate/,
    );
    assert.throws(
      () => selectAuthoredContextVolatileSourceRefs("magic", "tail", [{ ...cand0, selectiveLogic: 4 as any }]),
      /invalid_chat_turn_context_volatile_candidate/,
    );
    assert.throws(
      () => selectAuthoredContextVolatileSourceRefs("magic", "tail", [{ ...cand0, selectiveLogic: -1 as any }]),
      /invalid_chat_turn_context_volatile_candidate/,
    );
    assert.throws(
      () => selectAuthoredContextVolatileSourceRefs("magic", "tail", [{ ...cand0, selectiveLogic: "0" as any }]),
      /invalid_chat_turn_context_volatile_candidate/,
    );
  }
});

test("a durable turn plan with volatile world-book sources round-trips through SQLite", async () => {
  // Regression guard: the volatile INSERT carried ten placeholders for a nine-column table, so accepting a
  // turn that actually HAD volatile sources threw `10 values for 9 columns`, which the Chat service re-wrapped
  // as `chat_pipeline_service_unavailable` and the browser saw as HTTP 503. Every earlier test accepted with
  // `volatileSourceRefs` empty, so the statement never ran and the defect stayed invisible.
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p4-volatile-");
  const continuityKey = createHash("sha256")
    .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
    .digest("hex");
  try {
    const t0 = Date.now();
    const s = createChatThreadStore(root, continuityKey, () => t0);
    const creation = createProfileAwareChatThreadCreationCapability(s, profileReader);
    await creation.createExplicit({
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
    const volatileContent = "雨天喜欢在门廊煮热茶看雨。";
    const accepted = await (await import("./chat-thread-store.js")).acceptMountedPlayerMessage(binding, {
      text: "今天下雨了",
      locale: "zh-CN",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
      authoredContextPreparation: {
        sourceRefs: [],
        stableTokenCount: 0,
        volatileSourceRefs: [
          {
            sourceId: "world-info_entry_1",
            kind: "lorebook_entry",
            revision: "2",
            canonicalHash: createHash("sha256").update(volatileContent, "utf8").digest("hex"),
            totalOrderKey: "0001",
            provenance: `tavern-world-book-entry/world-info_entry_1/revision/2/canonical/${"c".repeat(64)}`,
          },
        ],
        volatileTokenCount: 8,
      },
    });
    assert.equal(accepted.status, "accepted_queued");
    const state = await s.resumeThread("thread_01", "surface_01");
    assert.deepEqual(state.currentTurnContextPlan?.volatileSources, [
      {
        sourceId: "world-info_entry_1",
        kind: "lorebook_entry",
        revision: "2",
        canonicalHash: createHash("sha256").update(volatileContent, "utf8").digest("hex"),
        totalOrderKey: "0001",
        provenance: `tavern-world-book-entry/world-info_entry_1/revision/2/canonical/${"c".repeat(64)}`,
      },
    ]);
    assert.equal(state.currentTurnContextPlan?.volatileTokenCount, 8);
    s.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4 durable turn acceptance, claim, start, and presentation transitions work atomically", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-p4p5-");
  const continuityKey = createHash("sha256")
    .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
    .digest("hex");
  try {
    const t0 = Date.now();
    const s = createChatThreadStore(root, continuityKey, () => t0);
    const creation = createProfileAwareChatThreadCreationCapability(s, profileReader);
    await creation.createExplicit({
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

    const accepted = await (await import("./chat-thread-store.js")).acceptMountedPlayerMessage(binding, {
      text: "Hello from P4",
      locale: "en-US",
      idempotencyKey: "abcdefghijklmnopqrstuv",
      expectedDraftRevision: 0,
      authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
    });
    assert.equal(accepted.status, "accepted_queued");

    const acceptedState = await s.resumeThread("thread_01", "surface_01");
    assert.deepEqual(acceptedState.currentTurnContextPlan, {
      threadId: "thread_01",
      turnId: accepted.turnId,
      continuityId: "continuity_01",
      companionId: "companion_01",
      playerId: "player_01",
      profileId: "profile_01",
      profileRevision: 1,
      profileCanonicalHash: "a".repeat(64),
      chatSurfaceSessionId: "surface_01",
      stableSources: [],
      stableTokenCount: 0,
      volatileSources: [],
      volatileTokenCount: 0,
    });

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

    const claimed = await claimMountedAttempt(claimBinding);
    assert.equal(claimed.status, "attempt_starting");

    const armed = await transitionMountedProviderStart(
      { ...claimBinding, attemptId: claimed.attempt.attemptId },
      { operation: "arm", observedAtMs: t0 + 1000 },
    );
    assert.equal(armed.status, "attempt_starting");

    const running = await transitionMountedProviderStart(
      { ...claimBinding, attemptId: claimed.attempt.attemptId },
      { operation: "running", statusClass: "success", observedAtMs: t0 + 2000 },
    );
    assert.equal(running.status, "running");

    const committed = await transitionMountedPresentation(
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
    assert.equal(state.messages[0]?.text, "Hello from P4");
    assert.equal(state.messages[1]?.text, "Response from P5");

    s.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the volatile scan window is the bound book's declared depth, not the whole transcript", async () => {
  const { boundedVisibleTail, DEFAULT_WORLDBOOK_SCAN_DEPTH, selectAuthoredContextVolatileSourceRefs } = await import(
    "./chat-thread-store.js"
  );
  const { validateWorldBook } = await import("../worldbook.js");
  const content = "雨天恩赐与安排";
  const candidate = {
    sourceId: "worldbook_entry_1",
    kind: "lorebook_entry" as const,
    revision: "1",
    canonicalHash: createHash("sha256").update(content).digest("hex"),
    totalOrderKey: "0001",
    provenance: "worldbook/1",
    content,
    budgetTokens: 12,
    selectionKeys: ["下雨"],
  };
  // The trigger word lives in the OLDER of the two visible messages.
  const messages: ReadonlyArray<Readonly<{ text: string }>> = [{ text: "今天下雨了" }, { text: "接着聊聊别的吧" }];
  const baseBook = Object.freeze({
    schemaVersion: 1 as const,
    worldBookId: "wb_01",
    revision: 1,
    alwaysOnPremise: "",
    entries: Object.freeze([]),
  });
  const declaresNone = validateWorldBook(baseBook);
  const declaresOne = validateWorldBook({ ...baseBook, scanDepth: 1 });
  assert.equal(declaresNone.scanDepth, undefined);
  assert.equal(declaresOne.scanDepth, 1);

  // A book that declares none applies the documented default (2), so the older
  // turn is inside the window and its keyword reaches the entry.
  const defaultDepth = declaresNone.scanDepth ?? DEFAULT_WORLDBOOK_SCAN_DEPTH;
  assert.equal(defaultDepth, 2);
  assert.equal(boundedVisibleTail(messages, defaultDepth), "今天下雨了\n接着聊聊别的吧");
  assert.equal(
    selectAuthoredContextVolatileSourceRefs("", boundedVisibleTail(messages, defaultDepth), [candidate]).refs.length,
    1,
  );

  // The same book declaring depth 1 narrows the window by exactly the declared
  // amount: the older turn falls out and the entry is not retrieved.
  assert.equal(declaresOne.scanDepth, 1);
  assert.equal(boundedVisibleTail(messages, declaresOne.scanDepth!), "接着聊聊别的吧");
  assert.deepEqual(
    selectAuthoredContextVolatileSourceRefs("", boundedVisibleTail(messages, declaresOne.scanDepth!), [candidate]),
    { refs: [], tokenCount: 0 },
  );

  // A non-positive or non-integer depth never degrades to scanning everything.
  assert.equal(boundedVisibleTail(messages, 0), "");
  assert.equal(boundedVisibleTail(messages, Number.NaN), "");
});

/**
 * The durable half of the same-position variant decision, pinned where it already holds. The two
 * writes a regenerate/swipe path must use are `appendSwipeVariant` and `selectSwipe`, and neither
 * may add a transcript row: the reply position gains variants, the transcript does not grow. Every
 * assertion is made on a read-back, and the variant-scan assertion reads the same bounded tail the
 * per-turn World Info selection uses, so "the active variant is the visible one" is proven against
 * the Host's own context assembly rather than against this store's return value.
 */
test("a swipe variant is the same reply position: one player row, and the active variant is the text the Host reads", async () => {
  const { root, store: s, creation } = await store();
  const reopened = createChatThreadStore(root, "a".repeat(64));
  try {
    await creation.createExplicit(request());
    await s.appendPlayer("thread_01", { messageId: "player_01", text: "Hello", occurredAtMs: 101 });
    await s.commitResponse("thread_01", { messageId: "response_01", text: "Hello back", occurredAtMs: 102 });

    const after = await s.appendSwipeVariant!(
      testTransitionAuthority.authority,
      "thread_01",
      "response_01",
      "Hello again",
    );
    assert.deepEqual(
      after.messages.map((message) => message.messageId),
      ["opening_01", "player_01", "response_01"],
    );
    assert.deepEqual(
      after.messages.filter((message) => message.role === "player").map((message) => message.messageId),
      ["player_01"],
    );
    const reply = after.messages[2]!;
    assert.deepEqual(reply.swipes, ["Hello back", "Hello again"]);
    assert.equal(reply.activeSwipeIndex, 1);
    assert.equal(reply.text, "Hello again");
    // The bounded visible tail the per-turn World Info selection scans carries the active
    // variant and not the abandoned one.
    assert.equal(boundedVisibleTail(after.messages, 2), "Hello\nHello again");

    const restored = await s.selectSwipe!(testTransitionAuthority.authority, "thread_01", "response_01", {
      direction: "prev",
    });
    assert.deepEqual(
      restored.messages.map((message) => message.messageId),
      ["opening_01", "player_01", "response_01"],
    );
    assert.equal(restored.messages[2]!.text, "Hello back");
    assert.equal(restored.messages[2]!.activeSwipeIndex, 0);
    assert.deepEqual(restored.messages[2]!.swipes, ["Hello back", "Hello again"]);
    assert.equal(boundedVisibleTail(restored.messages, 2), "Hello\nHello back");

    // Both halves are durable, not this store's own memory: a second connection on the same
    // root/continuity reads the same position and the same selection.
    const durable = await reopened.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      durable.messages.map((message) => message.messageId),
      ["opening_01", "player_01", "response_01"],
    );
    assert.equal(durable.messages[2]!.text, "Hello back");
    assert.equal(durable.messages[2]!.activeSwipeIndex, 0);
    assert.deepEqual(durable.messages[2]!.swipes, ["Hello back", "Hello again"]);

    // A player line is never a variant position, in either direction, and an unknown
    // message is not a silent no-op.
    await assert.rejects(
      () => s.appendSwipeVariant!(testTransitionAuthority.authority, "thread_01", "player_01", "Not a reply"),
      /chat_thread_swipe_not_allowed/,
    );
    await assert.rejects(
      () => s.selectSwipe!(testTransitionAuthority.authority, "thread_01", "player_01", { direction: "next" }),
      /chat_thread_swipe_not_allowed/,
    );
    await assert.rejects(
      () => s.appendSwipeVariant!(testTransitionAuthority.authority, "thread_01", "missing_01", "No"),
      /message_not_found/,
    );
    await assert.rejects(
      () => s.selectSwipe!(testTransitionAuthority.authority, "thread_01", "missing_01", { direction: "next" }),
      /message_not_found/,
    );
    // The writers are now behind the same mounted transition authority as
    // `commit_presentation`: a revoked authority mutates nothing.
    const revoked = createMountedTurnTransitionAuthority();
    revoked.revoke();
    await assert.rejects(
      () => s.appendSwipeVariant!(revoked.authority, "thread_01", "response_01", "Not authorized"),
      /p4_p5_transition_authority_unavailable/,
    );
    await assert.rejects(
      () => s.selectSwipe!(revoked.authority, "thread_01", "response_01", { direction: "next" }),
      /p4_p5_transition_authority_unavailable/,
    );
  } finally {
    reopened.close?.();
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Her reply is the other message the player may correct, and it is the one row whose text is carried
 * twice: `tavern_messages.text` is the message every reader sees, and `tavern_message_swipes` is what a
 * later swipe selects back to. An edit has to rewrite both, and only the variant that is ACTIVE - her
 * other attempts are hers and stay as they were - or the replaced words come back the moment the player
 * switches away and back. Every assertion is made on a read-back, and the variant-scan assertion reads
 * the same bounded tail the per-turn World Info selection uses, so "the corrected words are the visible
 * ones" is proven against the Host's own context assembly rather than against this store's return value.
 */
test("an edit of her reply rewrites the variant it stands on and leaves her other attempts alone", async () => {
  const { root, store: s, creation, key } = await store();
  const reopened = createChatThreadStore(root, key);
  try {
    await creation.createExplicit(request());
    await s.appendPlayer("thread_01", { messageId: "player_01", text: "Hello", occurredAtMs: 101 });
    await s.commitResponse("thread_01", { messageId: "response_01", text: "Hello back", occurredAtMs: 102 });
    const variants = await s.appendSwipeVariant!(
      testTransitionAuthority.authority,
      "thread_01",
      "response_01",
      "Hello again",
    );
    assert.equal(variants.messages[2]!.text, "Hello again");
    assert.deepEqual(variants.messages[2]!.swipes, ["Hello back", "Hello again"]);

    const edited = await s.editTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
      messageId: "response_01",
      expectedOrder: 2,
      text: "Hello again, corrected",
    });
    // The edit adds no row and moves none: it is her own reply position, rewritten.
    assert.deepEqual(
      edited.messages.map((message) => message.messageId),
      ["opening_01", "player_01", "response_01"],
    );
    // The row the player reads and the variant it stands on moved together; the attempt she abandoned
    // did not.
    assert.equal(edited.messages[2]!.text, "Hello again, corrected");
    assert.equal(edited.messages[2]!.activeSwipeIndex, 1);
    assert.deepEqual(edited.messages[2]!.swipes, ["Hello back", "Hello again, corrected"]);
    assert.equal(boundedVisibleTail(edited.messages, 2), "Hello\nHello again, corrected");

    // Away and back: the other attempt is still the words she wrote, and returning to the edited
    // position finds the correction rather than the words the player replaced.
    const away = await s.selectSwipe!(testTransitionAuthority.authority, "thread_01", "response_01", {
      direction: "prev",
    });
    assert.equal(away.messages[2]!.text, "Hello back");
    assert.equal(away.messages[2]!.activeSwipeIndex, 0);
    assert.deepEqual(away.messages[2]!.swipes, ["Hello back", "Hello again, corrected"]);
    const back = await s.selectSwipe!(testTransitionAuthority.authority, "thread_01", "response_01", {
      direction: "next",
    });
    assert.equal(back.messages[2]!.text, "Hello again, corrected");
    assert.equal(back.messages[2]!.activeSwipeIndex, 1);

    // Both halves are durable, not this store's own memory: a second connection on the same
    // root/continuity reads the same position.
    const durable = await reopened.resumeThread("thread_01", "surface_01");
    assert.equal(durable.messages[2]!.text, "Hello again, corrected");
    assert.deepEqual(durable.messages[2]!.swipes, ["Hello back", "Hello again, corrected"]);

    // The greeting is the row this operation refuses, and a refusal moves neither place.
    await assert.rejects(
      () =>
        s.editTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: "opening_01",
          expectedOrder: 0,
          text: "Rewrite the greeting",
        }),
      /chat_edit_opening_retained/,
    );
    const afterRefusal = await reopened.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      afterRefusal.messages.map((message) => message.text),
      durable.messages.map((message) => message.text),
    );
    assert.deepEqual(
      afterRefusal.messages.map((message) => message.swipes),
      durable.messages.map((message) => message.swipes),
    );
    // A player line is not a variant position: it carries no variant an edit could rewrite.
    assert.equal(afterRefusal.messages[1]!.swipes, undefined);
  } finally {
    reopened.close?.();
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The list projection reads one row per thread, so the last message must arrive
 * from ONE batched statement rather than one transcript open per thread: this
 * pins the shape the projection depends on (`tavern_messages.text` is the active
 * swipe, so the last row's text needs no swipe join).
 */
test("listThreadLastMessages returns each thread's last appended message in one batched read", async () => {
  const { root, store: s, creation } = await store();
  try {
    await creation.createExplicit(request());
    await creation.createExplicit({
      ...request(),
      chatThreadId: "thread_02",
      chatSurfaceSessionId: "surface_02",
      opening: { ...opening, messageId: "opening_02", text: "A second opening." },
    });
    await s.appendPlayer("thread_01", {
      messageId: "player_01",
      text: "What did you do yesterday?",
      occurredAtMs: 40,
    });
    const read = [...(await s.listThreadLastMessages!())].sort((left, right) =>
      left.chatThreadId.localeCompare(right.chatThreadId),
    );
    assert.deepEqual(read, [
      { chatThreadId: "thread_01", text: "What did you do yesterday?" },
      { chatThreadId: "thread_02", text: "A second opening." },
    ]);
    // A thread with no message at all is absent from the read rather than present
    // empty: the projection turns an absence into `preview: null`.
    await creation.createExplicit({
      ...request(),
      chatThreadId: "thread_03",
      chatSurfaceSessionId: "surface_03",
      opening: "blank",
    });
    const afterBlank = await s.listThreadLastMessages!();
    assert.deepEqual(afterBlank.map((last) => last.chatThreadId).includes("thread_03"), false);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A rewind is the one Chat mutation that removes transcript rows, so it must remove the ledger
 * those rows were the only evidence for, in the same transaction, or the next read refuses the
 * whole thread (`validateTurnIntegrity`). Both turns below are real accepted turns - a durable turn
 * row, an attempt, a committed presentation and its idempotency record - because that is the shape a
 * rewind actually meets, and the reply rows are named by the caller exactly as the provider commit
 * names them.
 */
test("a rewind drops the named message and every row after it, together with the turns only those rows evidenced", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-rewind-");
  const continuityKey = createHash("sha256")
    .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
    .digest("hex");
  const t0 = Date.now();
  const s = createChatThreadStore(root, continuityKey, () => t0);
  const reopened = createChatThreadStore(root, continuityKey, () => t0);
  try {
    const creation = createProfileAwareChatThreadCreationCapability(s, profileReader);
    await creation.createExplicit(request(opening));
    const accept = (await import("./chat-thread-store.js")).acceptMountedPlayerMessage;
    const binding = {
      runtimeRoot: root,
      playerId: "player_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      selectionGeneration: 1,
    };
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
    /** One complete turn: accept, claim, arm, run, commit the reply, complete. */
    const turn = async (ordinal: number, text: string, replyId: string) => {
      const key = `key${ordinal}`.padEnd(22, "x");
      const accepted = await accept(binding, {
        text,
        locale: "en-US",
        idempotencyKey: key,
        expectedDraftRevision: ordinal - 1,
        authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
      });
      const claimed = await claimMountedAttempt(claimBinding);
      const attempt = { ...claimBinding, attemptId: claimed.attempt.attemptId };
      await transitionMountedProviderStart(attempt, { operation: "arm", observedAtMs: t0 + 1 });
      await transitionMountedProviderStart(attempt, {
        operation: "running",
        statusClass: "success",
        observedAtMs: t0 + 2,
      });
      await transitionMountedPresentation(attempt, {
        operation: "commit_presentation",
        cancelEpoch: 1,
        message: { messageId: replyId, text: `${text} back`, occurredAtMs: t0 + 3 },
        committedAtMs: t0 + 3,
      });
      await transitionMountedPresentation(attempt, { operation: "claim_completion", claimedAtMs: t0 + 4 });
      await transitionMountedPresentation(attempt, { operation: "complete", completedAtMs: t0 + 5 });
      return { key, playerId: accepted.messageId, turnId: accepted.turnId };
    };

    const first = await turn(1, "First line", "reply_01");
    const second = await turn(2, "Second line", "reply_02");
    const before = await s.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      before.messages.map((message) => message.messageId),
      ["opening_01", first.playerId, "reply_01", second.playerId, "reply_02"],
    );
    assert.equal(before.idempotency.length, 2);

    // Rewinding to the second player line drops that turn's player row, its reply, the turn itself
    // and its idempotency record; the first turn - rows and bookkeeping - is untouched.
    const after = await s.rewindTranscript!(testTransitionAuthority.authority, "thread_01", {
      messageId: second.playerId,
      expectedOrder: 3,
    });
    assert.deepEqual(
      after.messages.map((message) => message.messageId),
      ["opening_01", first.playerId, "reply_01"],
    );
    assert.equal(after.turnLedger?.turnId, first.turnId);
    assert.equal(after.turnLedger?.status, "completed");
    assert.deepEqual(
      after.idempotency.map((record) => record.key),
      [first.key],
    );
    // The ledger rows really are gone, not merely unread: a later read of the same thread must not
    // raise `invalid_chat_thread_turn_ledger`, and the drop is durable across connections.
    const durable = await reopened.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      durable.messages.map((message) => message.messageId),
      ["opening_01", first.playerId, "reply_01"],
    );
    assert.equal(durable.idempotency.length, 1);
    const tables = new DatabaseSync(join(root, "tavern", "v3", "continuities", continuityKey, "tavern.sqlite"));
    try {
      assert.equal((tables.prepare("SELECT COUNT(*) AS n FROM tavern_turns").get() as any).n, 1);
      assert.equal((tables.prepare("SELECT COUNT(*) AS n FROM tavern_turn_presentations").get() as any).n, 1);
    } finally {
      tables.close();
    }

    // A rewind through the greeting the Chat opened on is refused: the recorded opening would
    // outlive the message it names.
    await assert.rejects(
      () =>
        s.rewindTranscript!(testTransitionAuthority.authority, "thread_01", {
          messageId: "opening_01",
          expectedOrder: 0,
        }),
      /chat_rewind_opening_retained/,
    );
    // An unknown row, and a row that is not at the position the caller read.
    await assert.rejects(
      () =>
        s.rewindTranscript!(testTransitionAuthority.authority, "thread_01", {
          messageId: "missing_01",
          expectedOrder: 0,
        }),
      /chat_message_not_found/,
    );
    await assert.rejects(
      () =>
        s.rewindTranscript!(testTransitionAuthority.authority, "thread_01", {
          messageId: "reply_01",
          expectedOrder: 3,
        }),
      /chat_message_revision_conflict/,
    );

    // A rewind cannot orphan a turn either: dropping a committed reply while its player line stays
    // takes that turn's bookkeeping with it, and the transcript still reads back.
    const third = await turn(3, "Third line", "reply_03");
    const orphaned = await s.rewindTranscript!(testTransitionAuthority.authority, "thread_01", {
      messageId: "reply_03",
      expectedOrder: 4,
    });
    assert.deepEqual(
      orphaned.messages.map((message) => message.messageId),
      ["opening_01", first.playerId, "reply_01", third.playerId],
    );
    assert.equal(orphaned.turnLedger?.turnId, first.turnId);
    assert.deepEqual(
      orphaned.idempotency.map((record) => record.key),
      [first.key],
    );

    // A turn that has not reached its terminal state refuses the whole rewind: no row is dropped
    // while a reply is being written.
    const held = await accept(binding, {
      text: "Fourth line",
      locale: "en-US",
      idempotencyKey: "key4".padEnd(22, "x"),
      expectedDraftRevision: 3,
      authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
    });
    const heldState = await s.resumeThread("thread_01", "surface_01");
    await assert.rejects(
      () =>
        s.rewindTranscript!(testTransitionAuthority.authority, "thread_01", {
          messageId: held.messageId,
          expectedOrder: heldState.messages.findIndex((message) => message.messageId === held.messageId),
        }),
      /chat_rewind_turn_active/,
    );
    assert.deepEqual(
      (await s.resumeThread("thread_01", "surface_01")).messages.map((message) => message.messageId),
      heldState.messages.map((message) => message.messageId),
    );

    // The writer sits behind the mounted transition authority, exactly as the swipe writers do.
    const revoked = createMountedTurnTransitionAuthority();
    revoked.revoke();
    await assert.rejects(
      () => s.rewindTranscript!(revoked.authority, "thread_01", { messageId: "reply_01", expectedOrder: 2 }),
      /p4_p5_transition_authority_unavailable/,
    );
  } finally {
    reopened.close?.();
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * An edit is the one Chat mutation that rewrites a row in place, so it must rewrite exactly the row the
 * player named and nothing else: the transcript order, the turn bookkeeping and every other row stay as
 * they were. The rows below come from real accepted turns - the same shape the mounted Chat meets -
 * because a player line IS an accepted turn's evidence (`validateTurnIntegrity` names it), and an edit
 * that broke that evidence would make the next read refuse the whole thread.
 *
 * Her reply is the other message this operation edits, and the variant bookkeeping its own edit keeps
 * (the row's text and the active variant its row carries, rewritten together) is proven next door, in
 * "an edit of her reply rewrites the variant it stands on and leaves her other attempts alone". Here the
 * greeting the Chat opened on is the row that refuses, with a code of its own: it is the conversation's
 * own anchor and has its own editor, which is a different fact from the one the player-only refusal used
 * to carry.
 */
test("an edit rewrites the player's own row in place and leaves the transcript exactly as it was when it refuses", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-edit-");
  const continuityKey = createHash("sha256")
    .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
    .digest("hex");
  const t0 = Date.now();
  const s = createChatThreadStore(root, continuityKey, () => t0);
  const reopened = createChatThreadStore(root, continuityKey, () => t0);
  try {
    const creation = createProfileAwareChatThreadCreationCapability(s, profileReader);
    await creation.createExplicit(request(opening));
    const accept = (await import("./chat-thread-store.js")).acceptMountedPlayerMessage;
    const binding = {
      runtimeRoot: root,
      playerId: "player_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      selectionGeneration: 1,
    };
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
    /** One complete turn: accept, claim, arm, run, commit the reply, complete. */
    const turn = async (ordinal: number, text: string, replyId: string) => {
      const key = `key${ordinal}`.padEnd(22, "x");
      const accepted = await accept(binding, {
        text,
        locale: "en-US",
        idempotencyKey: key,
        expectedDraftRevision: ordinal - 1,
        authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
      });
      const claimed = await claimMountedAttempt(claimBinding);
      const attempt = { ...claimBinding, attemptId: claimed.attempt.attemptId };
      await transitionMountedProviderStart(attempt, { operation: "arm", observedAtMs: t0 + 1 });
      await transitionMountedProviderStart(attempt, {
        operation: "running",
        statusClass: "success",
        observedAtMs: t0 + 2,
      });
      await transitionMountedPresentation(attempt, {
        operation: "commit_presentation",
        cancelEpoch: 1,
        message: { messageId: replyId, text: `${text} back`, occurredAtMs: t0 + 3 },
        committedAtMs: t0 + 3,
      });
      await transitionMountedPresentation(attempt, { operation: "claim_completion", claimedAtMs: t0 + 4 });
      await transitionMountedPresentation(attempt, { operation: "complete", completedAtMs: t0 + 5 });
      return { key, playerId: accepted.messageId, turnId: accepted.turnId };
    };

    const first = await turn(1, "First line", "reply_01");
    const second = await turn(2, "Second line", "reply_02");
    const before = await s.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      before.messages.map((message) => message.messageId),
      ["opening_01", first.playerId, "reply_01", second.playerId, "reply_02"],
    );

    // The edit lands on the named row and only there: same rows, same order, same turn bookkeeping,
    // and the durable read-back is what answers.
    const after = await s.editTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
      messageId: first.playerId,
      expectedOrder: 1,
      text: "First line, corrected",
    });
    assert.deepEqual(
      after.messages.map((message) => message.messageId),
      ["opening_01", first.playerId, "reply_01", second.playerId, "reply_02"],
    );
    assert.deepEqual(
      after.messages.map((message) => message.text),
      ["Welcome to the tavern.", "First line, corrected", "First line back", "Second line", "Second line back"],
    );
    assert.equal(after.turnLedger?.turnId, second.turnId);
    assert.equal(after.turnLedger?.status, "completed");
    assert.equal(after.idempotency.length, 2);
    const durable = await reopened.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      durable.messages.map((message) => message.text),
      ["Welcome to the tavern.", "First line, corrected", "First line back", "Second line", "Second line back"],
    );
    // The turn's own evidence is still readable: the edit changed words, not the ledger the words
    // belong to.
    assert.equal(durable.turnLedger?.idempotencyKey, second.key);

    const unchanged = durable.messages.map((message) => message.text);
    // Her reply stands in two places - the row's text and its active variant - and the refusals below
    // may not move either of them.
    const unchangedSwipes = durable.messages.map((message) => message.swipes);
    // A row this Chat does not carry.
    await assert.rejects(
      () =>
        s.editTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: "missing_01",
          expectedOrder: 1,
          text: "Nowhere",
        }),
      /chat_message_not_found/,
    );
    // A row that is no longer at the position the caller read.
    await assert.rejects(
      () =>
        s.editTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: first.playerId,
          expectedOrder: 3,
          text: "The wrong row entirely",
        }),
      /chat_message_revision_conflict/,
    );
    // The greeting the Chat opened on: the conversation's own anchor, which has its own editor, so an
    // in-place edit refuses by naming exactly that rather than as a row the player did not write.
    await assert.rejects(
      () =>
        s.editTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: "opening_01",
          expectedOrder: 0,
          text: "Rewrite the greeting",
        }),
      /chat_edit_opening_retained/,
    );
    // Text the durable store will not carry (empty, or non-NFC) is its own refusal, not an edit.
    await assert.rejects(
      () =>
        s.editTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: first.playerId,
          expectedOrder: 1,
          text: "",
        }),
      /invalid_chat_thread_text/,
    );

    // A turn that has not reached its terminal state refuses the whole edit: the transcript is not
    // allowed to change under a reply that is being written from that very text.
    const held = await accept(binding, {
      text: "Third line",
      locale: "en-US",
      idempotencyKey: "key3".padEnd(22, "x"),
      expectedDraftRevision: 2,
      authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
    });
    const heldState = await s.resumeThread("thread_01", "surface_01");
    await assert.rejects(
      () =>
        s.editTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: held.messageId,
          expectedOrder: heldState.messages.findIndex((message) => message.messageId === held.messageId),
          text: "Changed while she answers",
        }),
      /chat_edit_turn_active/,
    );
    assert.deepEqual(
      (await s.resumeThread("thread_01", "surface_01")).messages.map((message) => message.text),
      heldState.messages.map((message) => message.text),
    );
    // Every refusal above left the transcript byte-identical, not merely unread differently: the rows
    // the player reads and the variants her replies stand on.
    assert.deepEqual(
      heldState.messages.slice(0, 5).map((message) => message.text),
      unchanged,
    );
    assert.deepEqual(
      heldState.messages.slice(0, 5).map((message) => message.swipes),
      unchangedSwipes,
    );

    // The writer sits behind the mounted transition authority, exactly as the swipe and rewind
    // writers do.
    const revoked = createMountedTurnTransitionAuthority();
    revoked.revoke();
    await assert.rejects(
      () =>
        s.editTranscriptMessage!(revoked.authority, "thread_01", {
          messageId: first.playerId,
          expectedOrder: 1,
          text: "Not without the lease",
        }),
      /p4_p5_transition_authority_unavailable/,
    );
  } finally {
    reopened.close?.();
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A single-row delete is the one Chat mutation that leaves a GAP: everything before the named row and
 * everything after it stay exactly where they were, and only the turns whose evidence that one row was
 * go with it (`validateTurnIntegrity` would otherwise expect a row the transcript no longer carries).
 * The binding the model's own path is resolved through - `tavern_message_entries` - is written by the
 * provider runner and read back here, and it goes with the row it names.
 */
test("a mid-transcript delete removes exactly one row and only the turns that row evidenced", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-thread-delete-");
  const continuityKey = createHash("sha256")
    .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
    .digest("hex");
  const t0 = Date.now();
  const s = createChatThreadStore(root, continuityKey, () => t0);
  const reopened = createChatThreadStore(root, continuityKey, () => t0);
  try {
    const creation = createProfileAwareChatThreadCreationCapability(s, profileReader);
    await creation.createExplicit(request(opening));
    const accept = (await import("./chat-thread-store.js")).acceptMountedPlayerMessage;
    const binding = {
      runtimeRoot: root,
      playerId: "player_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      selectionGeneration: 1,
    };
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
    /** One complete turn: accept, claim, arm, run, commit the reply, complete. */
    const turn = async (ordinal: number, text: string, replyId: string) => {
      const key = `key${ordinal}`.padEnd(22, "x");
      const accepted = await accept(binding, {
        text,
        locale: "en-US",
        idempotencyKey: key,
        expectedDraftRevision: ordinal - 1,
        authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
      });
      const claimed = await claimMountedAttempt(claimBinding);
      const attempt = { ...claimBinding, attemptId: claimed.attempt.attemptId };
      await transitionMountedProviderStart(attempt, { operation: "arm", observedAtMs: t0 + 1 });
      await transitionMountedProviderStart(attempt, {
        operation: "running",
        statusClass: "success",
        observedAtMs: t0 + 2,
      });
      await transitionMountedPresentation(attempt, {
        operation: "commit_presentation",
        cancelEpoch: 1,
        message: { messageId: replyId, text: `${text} back`, occurredAtMs: t0 + 3 },
        committedAtMs: t0 + 3,
      });
      await transitionMountedPresentation(attempt, { operation: "claim_completion", claimedAtMs: t0 + 4 });
      await transitionMountedPresentation(attempt, { operation: "complete", completedAtMs: t0 + 5 });
      return { key, playerId: accepted.messageId, turnId: accepted.turnId };
    };

    const first = await turn(1, "First line", "reply_01");
    const second = await turn(2, "Second line", "reply_02");
    const third = await turn(3, "Third line", "reply_03");
    const before = await s.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      before.messages.map((message) => message.messageId),
      ["opening_01", first.playerId, "reply_01", second.playerId, "reply_02", third.playerId, "reply_03"],
    );

    // The binding the runner records after a turn's prompt settles: the player row is carried by the
    // prompt's own user entry and the reply row by the assistant entry the presentation committed.
    await s.recordTranscriptEntryBinding!(testTransitionAuthority.authority, "thread_01", [
      { messageId: first.playerId, entryId: "entry_p1" },
      { messageId: "reply_01", entryId: "entry_a1" },
      { messageId: second.playerId, entryId: "entry_p2" },
      { messageId: "reply_02", entryId: "entry_a2" },
      { messageId: third.playerId, entryId: "entry_p3" },
      { messageId: "reply_03", entryId: "entry_a3" },
    ]);
    // It is 1:N: a same-position variant turn appends a NEW reply entry for the same reply row, so the
    // row is carried by more than one entry over its life and the delete resolves the set against the
    // session's active path rather than trusting the newest write.
    await s.recordTranscriptEntryBinding!(testTransitionAuthority.authority, "thread_01", [
      { messageId: "reply_02", entryId: "entry_a2_variant" },
      { messageId: "reply_02", entryId: "entry_a2" },
    ]);
    assert.deepEqual(await s.readTranscriptEntryBinding!("thread_01", "reply_02"), ["entry_a2", "entry_a2_variant"]);
    assert.deepEqual(await s.readTranscriptEntryBinding!("thread_01", second.playerId), ["entry_p2"]);
    // A row this Chat does not carry cannot be given a binding: the row's own foreign key refuses it,
    // so no binding can outlive the transcript row it names.
    await assert.rejects(
      () =>
        s.recordTranscriptEntryBinding!(testTransitionAuthority.authority, "thread_01", [
          { messageId: "invented_row", entryId: "entry_invented" },
        ]),
      /FOREIGN KEY/i,
    );

    // The delete: her second reply leaves the middle of the conversation. Everything before it and
    // everything after it stays, and the second turn's own bookkeeping goes with the reply that was
    // its only presentation row - while the player line that turn answered stays exactly where it was.
    const after = await s.deleteTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
      messageId: "reply_02",
      expectedOrder: 4,
    });
    assert.deepEqual(
      after.messages.map((message) => message.messageId),
      ["opening_01", first.playerId, "reply_01", second.playerId, third.playerId, "reply_03"],
    );
    assert.equal(after.turnLedger?.turnId, third.turnId);
    assert.equal(after.turnLedger?.status, "completed");
    assert.deepEqual(
      after.idempotency.map((record) => record.key),
      [first.key, third.key],
    );
    // The binding went with the row (`ON DELETE CASCADE`), so nothing names a session entry no
    // transcript row carries any more.
    assert.deepEqual(await s.readTranscriptEntryBinding!("thread_01", "reply_02"), []);
    // And the hole is durable across connections, not a projection this process kept.
    const durable = await reopened.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      durable.messages.map((message) => message.messageId),
      ["opening_01", first.playerId, "reply_01", second.playerId, third.playerId, "reply_03"],
    );
    assert.equal(durable.idempotency.length, 2);
    const tables = new DatabaseSync(join(root, "tavern", "v3", "continuities", continuityKey, "tavern.sqlite"));
    try {
      assert.equal((tables.prepare("SELECT COUNT(*) AS n FROM tavern_turns").get() as any).n, 2);
      assert.equal((tables.prepare("SELECT COUNT(*) AS n FROM tavern_turn_presentations").get() as any).n, 2);
      const ordinals = (
        tables
          .prepare("SELECT append_ordinal FROM tavern_messages WHERE thread_id = ? ORDER BY append_ordinal")
          .all("thread_01") as any[]
      ).map((row) => row.append_ordinal);
      // The surviving rows keep the ordinals they had: a hole is a gap in the conversation, not a
      // renumbering that would move every row after it.
      assert.deepEqual(ordinals, [0, 1, 2, 3, 5, 6]);
    } finally {
      tables.close();
    }

    // Every refusal, and each one leaves the transcript exactly as it was.
    const held = await s.resumeThread("thread_01", "surface_01");
    const unchanged = held.messages.map((message) => message.messageId);
    await assert.rejects(
      () =>
        s.deleteTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: "missing_01",
          expectedOrder: 1,
        }),
      /chat_message_not_found/,
    );
    await assert.rejects(
      () =>
        s.deleteTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: third.playerId,
          expectedOrder: 1,
        }),
      /chat_message_revision_conflict/,
    );
    // The greeting is the row the thread's own opening names.
    await assert.rejects(
      () =>
        s.deleteTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: "opening_01",
          expectedOrder: 0,
        }),
      /chat_delete_opening_retained/,
    );
    // A turn that has not reached its terminal state refuses the whole delete: no row leaves the
    // transcript while a reply is being written.
    const heldTurn = await accept(binding, {
      text: "Fourth line",
      locale: "en-US",
      idempotencyKey: "key4".padEnd(22, "x"),
      expectedDraftRevision: 3,
      authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
    });
    const heldWithTurn = await s.resumeThread("thread_01", "surface_01");
    await assert.rejects(
      () =>
        s.deleteTranscriptMessage!(testTransitionAuthority.authority, "thread_01", {
          messageId: "reply_01",
          expectedOrder: 2,
        }),
      /chat_delete_turn_active/,
    );
    assert.deepEqual(
      (await s.resumeThread("thread_01", "surface_01")).messages.map((message) => message.messageId),
      heldWithTurn.messages.map((message) => message.messageId),
    );
    assert.deepEqual(
      heldWithTurn.messages.slice(0, unchanged.length).map((message) => message.messageId),
      unchanged,
    );
    const revoked = createMountedTurnTransitionAuthority();
    revoked.revoke();
    await assert.rejects(
      () =>
        s.deleteTranscriptMessage!(revoked.authority, "thread_01", {
          messageId: first.playerId,
          expectedOrder: 1,
        }),
      /p4_p5_transition_authority_unavailable/,
    );
    assert.equal(heldTurn.messageId.length > 0, true);
  } finally {
    reopened.close?.();
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
