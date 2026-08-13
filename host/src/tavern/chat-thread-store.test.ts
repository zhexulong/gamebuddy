import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChatThreadStore, type GreetingSource } from "./chat-thread-store.js";

const source: GreetingSource = {
  greetingSetId: "greetings_01",
  sourceRevision: 2,
  canonicalHash: "a".repeat(64),
  variantId: "alternate_01",
  profileRevision: 3,
  scenarioRevision: null,
};
const opening = { messageId: "opening_01", text: "Welcome to the tavern.", source } as const;

async function store() {
  return createChatThreadStore(
    await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-")),
    "a".repeat(64),
    (() => {
      let time = 10;
      return () => time++;
    })(),
  );
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

test("new greeting openings require an exact canonical hash while legacy stored openings remain readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-thread-store-"));
  try {
    const store = createChatThreadStore(root, "a".repeat(64), () => 10);
    await assert.rejects(
      store.createThread({
        chatThreadId: "thread",
        companionId: "companion",
        continuityId: "continuity",
        chatSurfaceSessionId: "surface",
        opening: { messageId: "opening", text: "Hello.", source: { ...source, canonicalHash: undefined } },
      }),
      /invalid_greeting_source/,
    );
    await assert.rejects(
      store.createThread({
        chatThreadId: "thread",
        companionId: "companion",
        continuityId: "continuity",
        chatSurfaceSessionId: "surface",
        opening: { messageId: "opening", text: "Hello.", source: { ...source, canonicalHash: "wrong" } },
      }),
      /invalid_greeting_source/,
    );

    const created = await store.createThread(request());
    const threadPath = join(
      root,
      "tavern",
      "v1",
      "continuities",
      "a".repeat(64),
      "threads",
      "thread_01",
      "thread.json",
    );
    const legacyThread = JSON.parse(await readFile(threadPath, "utf8"));
    delete legacyThread.title;
    delete legacyThread.lifecycleStatus;
    delete legacyThread.managementRevision;
    await writeFile(threadPath, JSON.stringify(legacyThread), "utf8");
    const resumed = await store.resumeThread("thread_01", "surface_01");
    assert.equal(resumed.thread.title, null);
    assert.equal(resumed.thread.lifecycleStatus, "active");
    assert.equal(resumed.thread.managementRevision, 1);
    assert.deepEqual(resumed.messages, created.messages);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact missing is nominal only when no thread artifacts exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-"));
  try {
    const threads = createChatThreadStore(root, "f".repeat(64));
    await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /chat_thread_not_found/);
    const directory = join(root, "tavern", "v1", "continuities", "f".repeat(64), "threads", "thread_01");
    await (await import("node:fs/promises")).mkdir(directory, { recursive: true });
    await writeFile(join(directory, "messages.json"), "{}", "utf8");
    await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /incomplete_artifacts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("New Chat durably creates selected greeting as message zero and exact resume never replays it", async () => {
  const threads = await store();
  const created = await threads.createThread(request());
  assert.equal(created.thread.title, null);
  assert.deepEqual(created.thread.openingSelection, { kind: "greeting", messageId: "opening_01", source });
  assert.deepEqual(
    created.messages.map((message) => message.messageId),
    ["opening_01"],
  );
  const resumed = await threads.resumeThread("thread_01", "surface_01");
  assert.deepEqual(resumed, created);
  await assert.rejects(() => threads.resumeThread("thread_01", "other_surface"), /chat_thread_surface_mismatch/);
});

test("blank is a durable opening sentinel and pristine selection switches atomically", async () => {
  const threads = await store();
  await threads.createThread(request("blank"));
  const greeting = await threads.commitOpening("thread_01", opening);
  assert.equal(greeting.messages.length, 1);
  const blank = await threads.commitOpening("thread_01", "blank");
  assert.deepEqual(blank.thread.openingSelection, { kind: "blank" });
  assert.deepEqual(blank.messages, []);
  const replacement = await threads.commitOpening("thread_01", {
    ...opening,
    messageId: "opening_02",
    text: "A different greeting.",
    source: { ...source, variantId: "first_01" },
  });
  assert.deepEqual(
    replacement.messages.map((message) => message.messageId),
    ["opening_02"],
  );
});

test("first non-opening event locks greeting and response is returned only after durable commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-"));
  const threads = createChatThreadStore(root, "b".repeat(64), () => 100);
  await threads.createThread(request());
  const player = await threads.appendPlayer("thread_01", { messageId: "player_01", text: "Hello", occurredAtMs: 101 });
  assert.equal(player.thread.openingLockedAtEventId, "player_01");
  await assert.rejects(() => threads.commitOpening("thread_01", "blank"), /chat_thread_opening_locked/);
  const response = await threads.commitResponse("thread_01", {
    messageId: "response_01",
    text: "Hello back",
    occurredAtMs: 102,
  });
  const messagesPath = join(
    root,
    "tavern",
    "v1",
    "continuities",
    "b".repeat(64),
    "threads",
    "thread_01",
    "messages.json",
  );
  assert.match(await readFile(messagesPath, "utf8"), /Hello back/);
  assert.deepEqual(
    response.messages.map((message) => message.messageId),
    ["opening_01", "player_01", "response_01"],
  );
});

test("WorldBook binding mutates only the exact pristine thread with an optimistic revision read-back", async () => {
  const threads = await store();
  const created = await threads.createThread(request("blank"));
  const binding = {
    worldBookId: "book_01",
    revision: 2,
    canonicalHash: "a".repeat(64),
    provenance: "authored" as const,
  };
  const bound = await threads.setWorldBookBinding!({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    expectedUpdatedAtMs: created.thread.updatedAtMs,
    binding,
  });
  assert.deepEqual(bound.thread.worldBookBinding, binding);
  assert.deepEqual((await threads.resumeThread("thread_01", "surface_01")).thread.worldBookBinding, binding);
  await assert.rejects(
    () =>
      threads.setWorldBookBinding!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        companionId: "companion_01",
        continuityId: "continuity_01",
        expectedUpdatedAtMs: created.thread.updatedAtMs,
      }),
    /revision_conflict/,
  );
  const afterPlayer = await threads.appendPlayer("thread_01", {
    messageId: "player_01",
    text: "Hello",
    occurredAtMs: 100,
  });
  await assert.rejects(
    () =>
      threads.setWorldBookBinding!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        companionId: "companion_01",
        continuityId: "continuity_01",
        expectedUpdatedAtMs: afterPlayer.thread.updatedAtMs,
      }),
    /worldbook_locked/,
  );
  await assert.rejects(
    () =>
      threads.setWorldBookBinding!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "wrong_surface",
        companionId: "companion_01",
        continuityId: "continuity_01",
        expectedUpdatedAtMs: afterPlayer.thread.updatedAtMs,
      }),
    /scope_mismatch/,
  );
});

test("managed World Info binding is explicit and has the same pristine and updatedAt guards", async () => {
  const threads = await store();
  const created = await threads.createThread(request("blank"));
  const binding = {
    source: "managed_world_info" as const,
    publicTitle: "Pelican Town",
    revision: 2,
    canonicalHash: "b".repeat(64),
  };
  const bound = await threads.setWorldBookBinding!({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    expectedUpdatedAtMs: created.thread.updatedAtMs,
    binding,
  });
  assert.deepEqual(bound.thread.worldBookBinding, binding);
  await assert.rejects(
    () =>
      threads.setWorldBookBinding!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        companionId: "companion_01",
        continuityId: "continuity_01",
        expectedUpdatedAtMs: created.thread.updatedAtMs,
      }),
    /revision_conflict/,
  );
  const afterPlayer = await threads.appendPlayer("thread_01", {
    messageId: "player_01",
    text: "Hello",
    occurredAtMs: 100,
  });
  await assert.rejects(
    () =>
      threads.setWorldBookBinding!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        companionId: "companion_01",
        continuityId: "continuity_01",
        expectedUpdatedAtMs: afterPlayer.thread.updatedAtMs,
        binding,
      }),
    /worldbook_locked/,
  );
});

test("active thread binding atomically detects selector drift without selector-to-thread nesting", async () => {
  const threads = await store();
  await threads.createThread(request("blank"));
  await threads.selectActiveThread("thread_01", "surface_01");
  const binding = await threads.readActiveThreadBinding!();
  assert.equal(binding?.thread.chatThreadId, "thread_01");
});

test("thread reads and writes fail closed after its parent is replaced, without touching an external sentinel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-boundary-outside-"));
  const continuityKey = "f".repeat(64);
  const threadDirectory = join(root, "tavern", "v1", "continuities", continuityKey, "threads", "thread_01");
  const movedThreadDirectory = `${threadDirectory}-real`;
  const sentinel = join(outside, "sentinel.txt");
  try {
    const threads = createChatThreadStore(root, continuityKey, () => 100);
    await threads.createThread(request("blank"));
    await writeFile(sentinel, "must remain untouched", "utf8");
    await rename(threadDirectory, movedThreadDirectory);
    try {
      await symlink(outside, threadDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /unsafe_path_boundary/);
    await assert.rejects(
      () => threads.appendPlayer("thread_01", { messageId: "player_01", text: "must not escape", occurredAtMs: 101 }),
      /unsafe_path_boundary/,
    );
    assert.equal(await readFile(sentinel, "utf8"), "must remain untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("active selection reads and writes fail closed after its parent is replaced, without touching an external sentinel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-selection-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "gamebuddy-chat-selection-boundary-outside-"));
  const continuityKey = "d".repeat(64);
  const continuityDirectory = join(root, "tavern", "v1", "continuities", continuityKey);
  const movedContinuityDirectory = `${continuityDirectory}-real`;
  const sentinel = join(outside, "sentinel.txt");
  try {
    const threads = createChatThreadStore(root, continuityKey, () => 100);
    await threads.createThread(request("blank"));
    await threads.selectActiveThread("thread_01", "surface_01");
    await writeFile(sentinel, "must remain untouched", "utf8");
    await rename(continuityDirectory, movedContinuityDirectory);
    try {
      await symlink(outside, continuityDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(() => threads.readActiveThreadSelection(), /unsafe_path_boundary/);
    await assert.rejects(() => threads.selectActiveThread("thread_01", "surface_01"), /unsafe_path_boundary/);
    assert.equal(await readFile(sentinel, "utf8"), "must remain untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("active selection is exact, durably read back, and never guessed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-"));
  const threads = createChatThreadStore(root, "d".repeat(64), () => 100);
  assert.equal(await threads.readActiveThreadSelection(), null);
  await threads.createThread(request("blank"));
  await assert.rejects(() => threads.selectActiveThread("thread_01", "wrong_surface"), /chat_thread_surface_mismatch/);
  const selected = await threads.selectActiveThread("thread_01", "surface_01");
  assert.deepEqual(selected, {
    schemaVersion: 1,
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    selectedAtMs: 100,
  });
  const restarted = createChatThreadStore(root, "d".repeat(64));
  assert.deepEqual(await restarted.readActiveThreadSelection(), selected);
});

test("player title rename normalizes safely, rejects stale or unchanged requests, and reads back durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-"));
  const threads = createChatThreadStore(
    root,
    "e".repeat(64),
    (() => {
      let time = 100;
      return () => time++;
    })(),
  );
  const created = await threads.createThread(request("blank"));
  const renamed = await threads.renameThreadTitle!({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    expectedManagementRevision: created.thread.managementRevision!,
    title: "  A quiet morning  ",
  });
  assert.equal(renamed.title, "A quiet morning");
  assert.equal(
    (await createChatThreadStore(root, "e".repeat(64)).resumeThread("thread_01", "surface_01")).thread.title,
    "A quiet morning",
  );
  await assert.rejects(
    () =>
      threads.renameThreadTitle!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        expectedManagementRevision: created.thread.managementRevision!,
        title: "A new title",
      }),
    /management_revision_conflict/,
  );
  await assert.rejects(
    () =>
      threads.renameThreadTitle!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        expectedManagementRevision: renamed.managementRevision!,
        title: "A quiet morning",
      }),
    /title_unchanged/,
  );
  for (const title of ["   ", "line\nbreak", "nul\u0000byte", "x".repeat(129)]) {
    await assert.rejects(
      () =>
        threads.renameThreadTitle!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId: "surface_01",
          expectedManagementRevision: renamed.managementRevision!,
          title,
        }),
      /invalid_chat_thread_title/,
    );
  }
  await assert.rejects(
    () =>
      threads.renameThreadTitle!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "wrong_surface",
        expectedManagementRevision: renamed.managementRevision!,
        title: "A new title",
      }),
    /surface_mismatch/,
  );
});

test("prepared response transaction is recovered exactly without creating or replaying an opening", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-"));
  const threads = createChatThreadStore(root, "c".repeat(64), () => 100);
  const initial = await threads.createThread(request());
  const threadDir = join(root, "tavern", "v1", "continuities", "c".repeat(64), "threads", "thread_01");
  const recovered = {
    thread: { ...initial.thread, openingLockedAtEventId: "response_01", updatedAtMs: 101 },
    messages: [
      ...initial.messages,
      {
        messageId: "response_01",
        role: "companion",
        kind: "response",
        text: "Durable reply",
        occurredAtMs: 101,
        greetingSource: null,
      },
    ],
  };
  await writeFile(join(threadDir, "transaction.json"), JSON.stringify({ schemaVersion: 1, state: recovered }), "utf8");
  const state = await threads.resumeThread("thread_01", "surface_01");
  assert.deepEqual(
    state.messages.map((message) => message.messageId),
    ["opening_01", "response_01"],
  );
  assert.equal(state.thread.openingLockedAtEventId, "response_01");
  await assert.rejects(() => threads.commitOpening("thread_01", "blank"), /chat_thread_opening_locked/);
});

test("thread title is null by default, normalizes explicit metadata, and rejects unsafe lengths or controls", async () => {
  const threads = await store();
  const created = await threads.createThread(request("blank"));
  assert.equal(created.thread.title, null);

  const renamed = await threads.renameThreadTitle!({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    expectedManagementRevision: created.thread.managementRevision!,
    title: "  Chat at noon  ",
  });
  assert.equal(renamed.title, "Chat at noon");
  for (const title of [" ", "x".repeat(121), "safe\nunsafe", "safe\u0000unsafe"]) {
    await assert.rejects(
      () =>
        threads.renameThreadTitle!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId: "surface_01",
          expectedManagementRevision: renamed.managementRevision!,
          title,
        }),
      /invalid_chat_thread_title/,
    );
  }
});

test("thread title uses exact surface and revision and returns journal-backed durable readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-"));
  let time = 100;
  const threads = createChatThreadStore(root, "e".repeat(64), () => time++);
  const created = await threads.createThread(request("blank"));
  await assert.rejects(
    () =>
      threads.renameThreadTitle!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "other_surface",
        expectedManagementRevision: created.thread.managementRevision!,
        title: "No",
      }),
    /chat_thread_surface_mismatch/,
  );
  const renamed = await threads.renameThreadTitle!({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    expectedManagementRevision: created.thread.managementRevision!,
    title: "Durable title",
  });
  await assert.rejects(
    () =>
      threads.renameThreadTitle!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        expectedManagementRevision: created.thread.managementRevision!,
        title: "Stale title",
      }),
    /chat_thread_management_revision_conflict/,
  );

  const threadDir = join(root, "tavern", "v1", "continuities", "e".repeat(64), "threads", "thread_01");
  const persisted = JSON.parse(await readFile(join(threadDir, "thread.json"), "utf8"));
  await writeFile(
    join(threadDir, "transaction.json"),
    JSON.stringify({
      schemaVersion: 1,
      state: { thread: { ...persisted, title: "Recovered title", updatedAtMs: renamed.updatedAtMs + 1 }, messages: [] },
    }),
    "utf8",
  );
  const recovered = await threads.resumeThread("thread_01", "surface_01");
  assert.equal(recovered.thread.title, "Recovered title");
  assert.deepEqual(recovered.messages, []);
});
