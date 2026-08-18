import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  claimP4MountedAttempt,
  createChatThreadStore,
  MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES,
  MAX_DRAFT_ARTIFACT_BYTES,
  MAX_IDEMPOTENCY_ARTIFACT_BYTES,
  MAX_MESSAGES_ARTIFACT_BYTES,
  MAX_THREAD_ARTIFACT_BYTES,
  MAX_TRANSACTION_ARTIFACT_BYTES,
  MAX_TURN_LEDGER_ARTIFACT_BYTES,
  transitionP4MountedProviderStart as rawTransitionP4MountedProviderStart,
  type AttemptStartingTurn,
  type GreetingSource,
  type RunningTurn,
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

const source: GreetingSource = {
  greetingSetId: "greetings_01",
  sourceRevision: 2,
  canonicalHash: "a".repeat(64),
  variantId: "alternate_01",
  profileRevision: 3,
  scenarioRevision: null,
};
const opening = { messageId: "opening_01", text: "Welcome to the tavern.", source } as const;

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const ARTIFACT_NAMES = ["thread.json", "messages.json", "draft.json", "turn-ledger.json", "idempotency.json", "transaction.json"] as const;
const staleAgo = () => new Date(Date.now() - 6 * 60_000);
const threadDir = (root: string, continuityKey: string, chatThreadId = "thread_01") =>
  join(root, "tavern", "v1", "continuities", continuityKey, "threads", chatThreadId);

function playerMessages(
  count: number,
  text: string,
  startAtMs = 100,
): ReadonlyArray<{
  messageId: string;
  role: "player";
  kind: "player";
  text: string;
  occurredAtMs: number;
  greetingSource: null;
}> {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `player_${String(index).padStart(4, "0")}`,
    role: "player" as const,
    kind: "player" as const,
    text,
    occurredAtMs: startAtMs + index,
    greetingSource: null,
  }));
}

async function readArtifactBytes(directory: string, name: string): Promise<Buffer | null> {
  try {
    return await readFile(join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function snapshotThread(directory: string): Promise<readonly (readonly [string, Buffer | null])[]> {
  return Promise.all(ARTIFACT_NAMES.map(async (name) => [name, await readArtifactBytes(directory, name)] as const));
}

async function injectPreparedJournal(directory: string, state: unknown): Promise<void> {
  await writeFile(join(directory, "transaction.json"), JSON.stringify({ schemaVersion: 1, state }), "utf8");
}

async function moveDirectoryForJunction({
  directory,
  movedDirectory,
}: Readonly<{ directory: string; movedDirectory: string }>) {
  await rename(directory, movedDirectory);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
}

async function createJunction(target: string, directory: string) {
  try {
    await symlink(target, directory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    // On Windows a just-moved directory can briefly reappear as a stale empty
    // entry. Remove only that test fixture destination, prove it is absent,
    // then retry the same junction creation. Setup failures remain failures;
    // only an unsupported junction operation is eligible for the explicit skip.
    if (
      process.platform !== "win32" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      !["ENOTEMPTY", "EEXIST"].includes(String(error.code))
    )
      throw error;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    await assert.rejects(lstat(directory), { code: "ENOENT" });
    await symlink(target, directory, "junction");
  }
}

function skipUnsupportedWindowsJunction(t: { skip: (reason?: string) => void }, error: unknown) {
  if (
    process.platform === "win32" &&
    error instanceof Error &&
    "code" in error &&
    ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
  ) {
    t.skip("Windows junction fixture creation is unsupported");
    return true;
  }
  return false;
}

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

test("greeting openings require an exact canonical hash on write and historical openings are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-thread-store-"));
  try {
    const store = createChatThreadStore(root, "a".repeat(64), () => 10);
    await assert.rejects(
      store.createThread({
        chatThreadId: "thread",
        companionId: "companion",
        continuityId: "continuity",
        chatSurfaceSessionId: "surface",
        opening: { messageId: "opening", text: "Hello.", source: { ...source, canonicalHash: undefined } as never },
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
    const storedMessages = JSON.parse(await readFile(threadPath.replace("thread.json", "messages.json"), "utf8"));
    storedMessages.messages[0].greetingSource.canonicalHash = undefined;
    const messagesPath = threadPath.replace("thread.json", "messages.json");
    await writeFile(messagesPath, JSON.stringify(storedMessages), "utf8");
    await assert.rejects(() => store.resumeThread("thread_01", "surface_01"), /invalid_greeting_source/);

    storedMessages.messages[0].greetingSource.canonicalHash = source.canonicalHash;
    await writeFile(messagesPath, JSON.stringify(storedMessages), "utf8");
    const historicalThread = JSON.parse(await readFile(threadPath, "utf8"));
    delete historicalThread.title;
    delete historicalThread.lifecycleStatus;
    delete historicalThread.managementRevision;
    await writeFile(threadPath, JSON.stringify(historicalThread), "utf8");
    await assert.rejects(() => store.resumeThread("thread_01", "surface_01"), /invalid_chat_thread/);

    await writeFile(threadPath, JSON.stringify(created.thread), "utf8");
    historicalThread.stableArtifactBindings = undefined;
    await writeFile(threadPath, JSON.stringify(historicalThread), "utf8");
    await assert.rejects(() => store.resumeThread("thread_01", "surface_01"), /invalid_tavern_stable_binding/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted canonical chat artifacts reject unknown root and nested keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-schema-"));
  const continuityKey = "c".repeat(64);
  const directory = join(root, "tavern", "v1", "continuities", continuityKey, "threads", "thread_01");
  const threadPath = join(directory, "thread.json");
  const messagesPath = join(directory, "messages.json");
  const selectionPath = join(root, "tavern", "v1", "continuities", continuityKey, "active-chat-thread.json");
  try {
    const threads = createChatThreadStore(root, continuityKey, () => 10);
    await threads.createThread({
      ...request(),
      stableArtifactBindings: [{ kind: "persona", sourceId: "persona_01", revision: 1, canonicalHash: "b".repeat(64) }],
      worldBookBinding: { worldBookId: "book_01", revision: 1, canonicalHash: "c".repeat(64), provenance: "authored" },
    });
    await threads.selectActiveThread("thread_01", "surface_01");

    // Restore known-good bytes explicitly after each independent corruption.
    const cleanThread = await readFile(threadPath, "utf8");
    const cleanMessages = await readFile(messagesPath, "utf8");
    const cleanSelection = await readFile(selectionPath, "utf8");
    const mutations: readonly [string, (artifact: any) => void, RegExp][] = [
      [
        threadPath,
        (artifact) => {
          artifact.unexpected = true;
        },
        /invalid_chat_thread/,
      ],
      [
        threadPath,
        (artifact) => {
          artifact.openingSelection.unexpected = true;
        },
        /invalid_chat_thread_opening/,
      ],
      [
        threadPath,
        (artifact) => {
          artifact.openingSelection.source.unexpected = true;
        },
        /invalid_greeting_source/,
      ],
      [
        threadPath,
        (artifact) => {
          artifact.stableArtifactBindings[0].unexpected = true;
        },
        /invalid_tavern_stable_binding/,
      ],
      [
        threadPath,
        (artifact) => {
          artifact.worldBookBinding.unexpected = true;
        },
        /invalid_tavern_worldbook_binding/,
      ],
      [
        messagesPath,
        (artifact) => {
          artifact.unexpected = true;
        },
        /invalid_chat_thread_messages/,
      ],
      [
        messagesPath,
        (artifact) => {
          artifact.messages[0].unexpected = true;
        },
        /invalid_chat_thread_message/,
      ],
      [
        messagesPath,
        (artifact) => {
          artifact.messages[0].greetingSource.unexpected = true;
        },
        /invalid_greeting_source/,
      ],
      [
        selectionPath,
        (artifact) => {
          artifact.unexpected = true;
        },
        /invalid_active_chat_thread_selection/,
      ],
    ];
    for (const [path, mutate, expected] of mutations) {
      const artifact = JSON.parse(await readFile(path, "utf8"));
      mutate(artifact);
      await writeFile(path, JSON.stringify(artifact), "utf8");
      if (path === selectionPath) await assert.rejects(() => threads.readActiveThreadSelection(), expected);
      else await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), expected);
      await writeFile(threadPath, cleanThread, "utf8");
      await writeFile(messagesPath, cleanMessages, "utf8");
      await writeFile(selectionPath, cleanSelection, "utf8");
    }
    const journalPath = join(directory, "transaction.json");
    const state = { thread: JSON.parse(cleanThread), messages: JSON.parse(cleanMessages).messages };
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, state, unexpected: true }), "utf8");
    await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /invalid_chat_thread_transaction/);
    await rm(journalPath);
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, state: { ...state, unexpected: true } }), "utf8");
    await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /invalid_chat_thread_state/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("message grammar rejects all invalid role/source combinations in artifacts and transaction journals", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-message-grammar-"));
  const continuityKey = "g".repeat(64);
  const directory = join(root, "tavern", "v1", "continuities", continuityKey, "threads", "thread_01");
  const messagesPath = join(directory, "messages.json");
  const journalPath = join(directory, "transaction.json");
  try {
    const threads = createChatThreadStore(root, continuityKey, () => 10);
    const clean = await threads.createThread(request());
    const invalid: readonly Partial<(typeof clean.messages)[number]>[] = [
      { role: "player" },
      { role: "companion", kind: "player" },
      { kind: "response", greetingSource: source },
    ];
    for (const patch of invalid) {
      const artifact = JSON.parse(await readFile(messagesPath, "utf8"));
      Object.assign(artifact.messages[0], patch);
      await writeFile(messagesPath, JSON.stringify(artifact), "utf8");
      await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /invalid_chat_thread_message/);
      await writeFile(messagesPath, JSON.stringify({ schemaVersion: 1, chatThreadId: "thread_01", messages: clean.messages }), "utf8");

      const state = { ...clean, messages: clean.messages.map((message, index) => index === 0 ? { ...message, ...patch } : message) };
      await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, state }), "utf8");
      await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /invalid_chat_thread_message/);
      await rm(journalPath);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted chat records reject duplicate decoded keys before schema validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-duplicate-key-"));
  const continuityKey = "e".repeat(64);
  const directory = join(root, "tavern", "v1", "continuities", continuityKey, "threads", "thread_01");
  const threadPath = join(directory, "thread.json");
  const messagesPath = join(directory, "messages.json");
  const journalPath = join(directory, "transaction.json");
  const selectionPath = join(root, "tavern", "v1", "continuities", continuityKey, "active-chat-thread.json");
  const withDuplicateDecodedSchemaVersion = (json: string): string => json.replace("{", '{"\\u0073chemaVersion":999,');
  try {
    const threads = createChatThreadStore(root, continuityKey, () => 10);
    await threads.createThread(request());
    await threads.selectActiveThread("thread_01", "surface_01");
    const cleanThread = await readFile(threadPath, "utf8");
    const cleanMessages = await readFile(messagesPath, "utf8");
    const cleanSelection = await readFile(selectionPath, "utf8");
    const records: readonly [string, () => Promise<unknown>][] = [
      [selectionPath, () => threads.readActiveThreadSelection()],
      [threadPath, () => threads.resumeThread("thread_01", "surface_01")],
      [messagesPath, () => threads.resumeThread("thread_01", "surface_01")],
    ];
    for (const [path, read] of records) {
      await writeFile(path, withDuplicateDecodedSchemaVersion(await readFile(path, "utf8")), "utf8");
      await assert.rejects(read, /invalid_strict_json_file/);
      await writeFile(threadPath, cleanThread, "utf8");
      await writeFile(messagesPath, cleanMessages, "utf8");
      await writeFile(selectionPath, cleanSelection, "utf8");
    }
    await writeFile(
      journalPath,
      withDuplicateDecodedSchemaVersion(
        JSON.stringify({
          schemaVersion: 1,
          state: { thread: JSON.parse(cleanThread), messages: JSON.parse(cleanMessages).messages },
        }),
      ),
      "utf8",
    );
    await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /invalid_strict_json_file/);
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
    await moveDirectoryForJunction({ directory: threadDirectory, movedDirectory: movedThreadDirectory });
    try {
      await createJunction(outside, threadDirectory);
    } catch (error) {
      if (skipUnsupportedWindowsJunction(t, error)) return;
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
    await moveDirectoryForJunction({ directory: continuityDirectory, movedDirectory: movedContinuityDirectory });
    try {
      await createJunction(outside, continuityDirectory);
    } catch (error) {
      if (skipUnsupportedWindowsJunction(t, error)) return;
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

test("foreign prepared transaction is rejected before recovery writes and remains byte-identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-foreign-prepared-"));
  const continuityKey = "z".repeat(64);
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  const directoryFor = (id: string) => join(root, "tavern", "v1", "continuities", continuityKey, "threads", id);
  const names = ["thread.json", "messages.json", "draft.json", "turn-ledger.json", "idempotency.json", "transaction.json"];
  try {
    await threads.createThread({ chatThreadId: "thread_a", companionId: "companion_01", continuityId: "continuity_01", chatSurfaceSessionId: "surface_a", opening: "blank" });
    await threads.createThread({ chatThreadId: "thread_b", companionId: "companion_01", continuityId: "continuity_01", chatSurfaceSessionId: "surface_b", opening: "blank" });
    const stateB = await threads.resumeThread("thread_b", "surface_b");
    const accepted = { turnId: "turn_b", status: "accepted_queued" as const, idempotencyKey: "abcdefghijklmnopqrstuv", messageId: "player_b", acceptedAtMs: 101 };
    const preparedB = { ...stateB, messages: [{ messageId: "player_b", role: "player" as const, kind: "player" as const, text: "B", occurredAtMs: 101, greetingSource: null }], draft: { revision: 1, text: null }, turnLedger: accepted, idempotency: [{ key: accepted.idempotencyKey, fingerprint: "b".repeat(64), result: accepted }] };
    await writeFile(join(directoryFor("thread_a"), "transaction.json"), JSON.stringify({ schemaVersion: 1, state: preparedB }), "utf8");
    const before = await Promise.all(names.map(async (name) => [name, await readFile(join(directoryFor("thread_a"), name))] as const));
    await assert.rejects(() => threads.resumeThread("thread_a", "surface_a"), /chat_thread_directory_mismatch/);
    const after = await Promise.all(names.map(async (name) => [name, await readFile(join(directoryFor("thread_a"), name))] as const));
    assert.deepEqual(after, before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4b claims exactly one durable attempt generation and preserves the P4a idempotency receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p4b-"));
  const binding = {
    runtimeRoot: root,
    playerId: "player_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    selectionGeneration: 7,
    runtimeBindingDigest: "d".repeat(64),
    runtimeOwner: { ownerToken: "owner_01", runtimeInstanceId: "runtime_01", ownerPid: 123, ownerProcessStartIdentity: "start_01" },
  } as const;
  const continuityKey = createHash("sha256")
    .update([binding.playerId, binding.companionId, binding.continuityId].join("\u001f"))
    .digest("hex");
  const threads = createChatThreadStore(root, continuityKey, (() => { let current = 100; return () => current++; })());
  try {
    await threads.createThread(request("blank"));
    const accepted = await (async () => {
      const { acceptP4MountedPlayerMessage } = await import("./chat-thread-store.js");
      return acceptP4MountedPlayerMessage(binding, { text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 });
    })();
    const [first, second] = await Promise.allSettled([
      claimP4MountedAttempt(binding),
      claimP4MountedAttempt(binding),
    ]);
    const fulfilled = [first, second].filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claimP4MountedAttempt>>> =>
        result.status === "fulfilled",
    );
    assert.equal(
      fulfilled.length,
      1,
      [first, second]
        .map((result) => (result.status === "rejected" ? String(result.reason) : "fulfilled"))
        .join("; "),
    );
    const claimed = fulfilled[0]!.value;
    assert.equal(claimed.status, "attempt_starting");
    assert.equal(claimed.attempt.generation, 1);
    assert.equal(claimed.attempt.selectionGeneration, 7);
    assert.equal(claimed.attempt.runtimeBindingDigest, binding.runtimeBindingDigest);
    assert.deepEqual(claimed.attempt.runtimeOwner, binding.runtimeOwner);
    await assert.rejects(() => claimP4MountedAttempt(binding), /attempt_already_claimed/);
    const reopened = await createChatThreadStore(root, continuityKey).resumeThread("thread_01", "surface_01");
    assert.deepEqual(reopened.turnLedger, claimed);
    assert.equal(reopened.idempotency.length, 1);
    assert.deepEqual(reopened.idempotency[0]!.result, accepted);
    assert.equal(reopened.messages.filter((message) => message.kind === "player").length, 1);
    assert.equal(reopened.draft.revision, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4b validates runtime claim facts before durable mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p4b-invalid-"));
  const continuityKey = "q".repeat(64);
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  const binding = {
    runtimeRoot: root, playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01", chatThreadId: "thread_01", chatSurfaceSessionId: "surface_01", selectionGeneration: 1, runtimeBindingDigest: "d".repeat(64), runtimeOwner: { ownerToken: "owner_01", runtimeInstanceId: "runtime_01", ownerPid: 1, ownerProcessStartIdentity: "start_01" },
  } as const;
  try {
    await threads.createThread(request("blank"));
    await assert.rejects(() => claimP4MountedAttempt({ ...binding, runtimeBindingDigest: "bad" }), /invalid_chat_thread_attempt_claim/);
    const state = await threads.resumeThread("thread_01", "surface_01");
    assert.equal(state.turnLedger, null);
    assert.equal(state.messages.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4c arms exactly one durable provider-start observation and preserves it on reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p4c-arm-"));
  const binding = {
    runtimeRoot: root,
    playerId: "player_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    selectionGeneration: 7,
    runtimeBindingDigest: "d".repeat(64),
    runtimeOwner: { ownerToken: "owner_01", runtimeInstanceId: "runtime_01", ownerPid: 123, ownerProcessStartIdentity: "start_01" },
  } as const;
  const continuityKey = createHash("sha256")
    .update([binding.playerId, binding.companionId, binding.continuityId].join("\u001f"))
    .digest("hex");
  const threads = createChatThreadStore(root, continuityKey, (() => { let current = 100; return () => current++; })());
  try {
    await threads.createThread(request("blank"));
    const { acceptP4MountedPlayerMessage } = await import("./chat-thread-store.js");
    const accepted = await acceptP4MountedPlayerMessage(binding, { text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 });
    const claimed = await claimP4MountedAttempt(binding);
    const firstObservedAt = (await threads.resumeThread("thread_01", "surface_01")).thread.updatedAtMs + 1;
    assert.equal(claimed.observation, undefined);
    const armed = await transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "arm", observedAtMs: firstObservedAt });
    assert.equal(armed.status, "attempt_starting");
    assert.deepEqual(armed.observation, { phase: "armed", observedAtMs: firstObservedAt });
    // Frozen CAS table: no observation or `armed` is the only arm source state.
    const rearmedAt = firstObservedAt + 1;
    const rearmed = await transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "arm", observedAtMs: rearmedAt });
    assert.deepEqual(rearmed.observation, { phase: "armed", observedAtMs: rearmedAt });
    const reopened = await createChatThreadStore(root, continuityKey).resumeThread("thread_01", "surface_01");
    assert.deepEqual(reopened.turnLedger, rearmed);
    assert.deepEqual(reopened.idempotency[0]!.result, accepted);
    // `armed` must never be a `running` record and must not rewrite the claim.
    const ledger = reopened.turnLedger as AttemptStartingTurn;
    assert.equal(ledger.status, "attempt_starting");
    assert.equal(ledger.attempt.attemptId, claimed.attempt.attemptId);
    assert.equal(ledger.attempt.generation, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4c not_started is durable only from a live armed record", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p4c-not-started-"));
  const binding = {
    runtimeRoot: root, playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01", chatThreadId: "thread_01", chatSurfaceSessionId: "surface_01", selectionGeneration: 1, runtimeBindingDigest: "d".repeat(64), runtimeOwner: { ownerToken: "owner_01", runtimeInstanceId: "runtime_01", ownerPid: 1, ownerProcessStartIdentity: "start_01" },
  } as const;
  const continuityKey = createHash("sha256")
    .update([binding.playerId, binding.companionId, binding.continuityId].join("\u001f"))
    .digest("hex");
  const threads = createChatThreadStore(root, continuityKey, (() => { let current = 100; return () => current++; })());
  try {
    await threads.createThread(request("blank"));
    const { acceptP4MountedPlayerMessage } = await import("./chat-thread-store.js");
    await acceptP4MountedPlayerMessage(binding, { text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 });
    const claimed = await claimP4MountedAttempt(binding);
    const firstObservedAt = (await threads.resumeThread("thread_01", "surface_01")).thread.updatedAtMs + 1;
    // Without a durable `armed` record, `not_started` is not locally provable.
    await assert.rejects(
      () => transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "not_started", reasonCode: "invocation_deadline_expired", observedAtMs: firstObservedAt }),
      /provider_start_observation_conflict/,
    );
    let state = await threads.resumeThread("thread_01", "surface_01");
    assert.deepEqual(state.turnLedger, claimed);
    await transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "arm", observedAtMs: firstObservedAt });
    const notStartedAt = firstObservedAt + 1;
    const notStarted = await transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "not_started", reasonCode: "invocation_deadline_expired", observedAtMs: notStartedAt });
    assert.deepEqual(notStarted.observation, { phase: "not_started", reasonCode: "invocation_deadline_expired", observedAtMs: notStartedAt });
    // A second local not_started write is a replay and fails closed.
    await assert.rejects(
      () => transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "not_started", reasonCode: "admission_revoked", observedAtMs: notStartedAt + 1 }),
      /provider_start_observation_conflict/,
    );
    state = await createChatThreadStore(root, continuityKey).resumeThread("thread_01", "surface_01");
    assert.deepEqual(state.turnLedger, notStarted);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4c running is reachable only from armed and reopens with the bounded observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p4c-running-"));
  const binding = {
    runtimeRoot: root, playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01", chatThreadId: "thread_01", chatSurfaceSessionId: "surface_01", selectionGeneration: 3, runtimeBindingDigest: "d".repeat(64), runtimeOwner: { ownerToken: "owner_01", runtimeInstanceId: "runtime_01", ownerPid: 1, ownerProcessStartIdentity: "start_01" },
  } as const;
  const continuityKey = createHash("sha256")
    .update([binding.playerId, binding.companionId, binding.continuityId].join("\u001f"))
    .digest("hex");
  const threads = createChatThreadStore(root, continuityKey, (() => { let current = 100; return () => current++; })());
  try {
    await threads.createThread(request("blank"));
    const { acceptP4MountedPlayerMessage } = await import("./chat-thread-store.js");
    const accepted = await acceptP4MountedPlayerMessage(binding, { text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 });
    const claimed = await claimP4MountedAttempt(binding);
    const firstObservedAt = (await threads.resumeThread("thread_01", "surface_01")).thread.updatedAtMs + 1;
    // `running` without a durable `armed` record is forbidden.
    await assert.rejects(
      () => transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "running", statusClass: "success", observedAtMs: firstObservedAt }),
      /provider_start_observation_conflict/,
    );
    await transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "arm", observedAtMs: firstObservedAt });
    const runningAt = firstObservedAt + 1;
    const running = await transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "running", statusClass: "success", observedAtMs: runningAt });
    assert.equal(running.status, "running");
    assert.deepEqual(running.observation, { phase: "running", source: "after_provider_response", statusClass: "success", observedAtMs: runningAt });
    const runningLedger = running as RunningTurn;
    assert.equal(runningLedger.attempt.generation, 1);
    // `running` is terminal for P4c: no arm, not_started, or second running write.
    for (const command of [
      { operation: "arm", observedAtMs: 301 },
      { operation: "not_started", reasonCode: "admission_revoked", observedAtMs: 301 },
      { operation: "running", statusClass: "error", observedAtMs: 301 },
    ] as const) {
      await assert.rejects(
        () => transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, command),
        /provider_start_claim_missing/,
      );
    }
    const state = await createChatThreadStore(root, continuityKey).resumeThread("thread_01", "surface_01");
    assert.deepEqual(state.turnLedger, running);
    assert.deepEqual(state.idempotency[0]!.result, accepted);
    assert.equal(state.messages.filter((message) => message.kind === "player").length, 1);
    assert.equal(state.draft.revision, 1);
    // The bounded observation stays far inside the frozen 16 KiB ledger budget.
    const ledgerBytes = Buffer.byteLength(JSON.stringify(state.turnLedger), "utf8");
    assert.ok(ledgerBytes < MAX_TURN_LEDGER_ARTIFACT_BYTES, `ledger bytes ${ledgerBytes}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4c transitions fail closed on claim, attempt, and scope mismatches with zero mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p4c-cas-"));
  const binding = {
    runtimeRoot: root, playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01", chatThreadId: "thread_01", chatSurfaceSessionId: "surface_01", selectionGeneration: 1, runtimeBindingDigest: "d".repeat(64), runtimeOwner: { ownerToken: "owner_01", runtimeInstanceId: "runtime_01", ownerPid: 1, ownerProcessStartIdentity: "start_01" },
  } as const;
  const continuityKey = createHash("sha256")
    .update([binding.playerId, binding.companionId, binding.continuityId].join("\u001f"))
    .digest("hex");
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  try {
    await threads.createThread(request("blank"));
    // No claim yet: every transition rejects before any durable write.
    await assert.rejects(() => transitionP4MountedProviderStart({ ...binding, attemptId: "attempt_dummy" }, { operation: "arm", observedAtMs: 200 }), /provider_start_claim_missing/);
    const { acceptP4MountedPlayerMessage } = await import("./chat-thread-store.js");
    await acceptP4MountedPlayerMessage(binding, { text: "Hello", locale: "en-US", idempotencyKey: "abcdefghijklmnopqrstuv", expectedDraftRevision: 0 });
    const claimed = await claimP4MountedAttempt(binding);
    const state = await threads.resumeThread("thread_01", "surface_01");
    const before = await readFile(join(threadDir(root, continuityKey), "turn-ledger.json"));
    for (const bad of [
      { ...binding, attemptId: "attempt_other" },
      { ...binding, attemptId: claimed.attempt.attemptId, selectionGeneration: 2 },
      { ...binding, attemptId: claimed.attempt.attemptId, runtimeBindingDigest: "e".repeat(64) },
      { ...binding, attemptId: claimed.attempt.attemptId, runtimeOwner: { ownerToken: "owner_02", runtimeInstanceId: "runtime_01", ownerPid: 1, ownerProcessStartIdentity: "start_01" } },
    ]) {
      await assert.rejects(
        () => transitionP4MountedProviderStart(bad, { operation: "arm", observedAtMs: 200 }),
        /provider_start_attempt_mismatch/,
      );
    }
    await assert.rejects(
      () => transitionP4MountedProviderStart({ ...binding, chatSurfaceSessionId: "surface_02", attemptId: claimed.attempt.attemptId }, { operation: "arm", observedAtMs: 200 }),
      /chat_thread_scope_mismatch/,
    );
    await assert.rejects(
      () => transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "arm", observedAtMs: 99 }),
      /provider_start_observation_time_regression/,
    );
    // Malformed commands fail before any store read or mutation.
    for (const command of [
      { operation: "arm" },
      { operation: "not_started", reasonCode: "invalid", observedAtMs: 200 },
      { operation: "running", statusClass: "unknown", observedAtMs: 200 },
      { operation: "other", observedAtMs: 200 },
    ] as const) {
      await assert.rejects(
        () => transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, command as never),
        /invalid_chat_thread_observation/,
      );
    }
    const after = await readFile(join(threadDir(root, continuityKey), "turn-ledger.json"));
    assert.deepEqual(after, before);
    assert.deepEqual((await threads.resumeThread("thread_01", "surface_01")).turnLedger, claimed);
    // Archived threads reject every provider-start transition.
    await threads.transitionLifecycle!({ chatThreadId: "thread_01", chatSurfaceSessionId: "surface_01", companionId: "companion_01", continuityId: "continuity_01", expectedManagementRevision: state.thread.managementRevision!, operation: "archive" });
    await assert.rejects(
      () => transitionP4MountedProviderStart({ ...binding, attemptId: claimed.attempt.attemptId }, { operation: "arm", observedAtMs: 200 }),
      /chat_thread_lifecycle_not_active/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4c prepared-journal recovery preserves armed and running exactly and rejects malformed observation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p4c-journal-"));
  const continuityKey = "p4c".padEnd(64, "x");
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  try {
    await threads.createThread(request("blank"));
    const directory = threadDir(root, continuityKey);
    const base = await threads.resumeThread("thread_01", "surface_01");
    const claimed = {
      turnId: "turn_01",
      status: "attempt_starting" as const,
      idempotencyKey: "abcdefghijklmnopqrstuv",
      messageId: "player_01",
      acceptedAtMs: 100,
      attempt: {
        generation: 1 as const,
        attemptId: "attempt_01",
        claimedAtMs: 101,
        selectionGeneration: 1,
        runtimeBindingDigest: "d".repeat(64),
        runtimeOwner: { ownerToken: "owner_01", runtimeInstanceId: "runtime_01", ownerPid: 1, ownerProcessStartIdentity: "start_01" },
      },
    };
    const messages = [{ messageId: "player_01", role: "player" as const, kind: "player" as const, text: "Hello", occurredAtMs: 100, greetingSource: null }];
    const idempotency = [{ key: "abcdefghijklmnopqrstuv", fingerprint: "b".repeat(64), result: { turnId: "turn_01", status: "accepted_queued" as const, idempotencyKey: "abcdefghijklmnopqrstuv", messageId: "player_01", acceptedAtMs: 100 } }];
    for (const [name, ledger, expected] of [
      ["armed", { ...claimed, observation: { phase: "armed", observedAtMs: 200 } }, "armed"],
      ["not_started", { ...claimed, observation: { phase: "not_started", reasonCode: "session_unavailable", observedAtMs: 200 } }, "not_started"],
      ["running", { ...claimed, status: "running" as const, observation: { phase: "running", source: "after_provider_response", statusClass: "error", observedAtMs: 300 } }, "running"],
    ] as const) {
      await writeFile(join(directory, "transaction.json"), JSON.stringify({ schemaVersion: 1, state: { thread: { ...base.thread, updatedAtMs: 300 }, messages, draft: { revision: 1, text: null }, turnLedger: ledger, idempotency } }), "utf8");
      const recovered = await threads.resumeThread("thread_01", "surface_01");
      const turnLedger = recovered.turnLedger as AttemptStartingTurn | RunningTurn;
      assert.equal(turnLedger.status === "running" ? "running" : turnLedger.observation?.phase, expected);
      assert.deepEqual(turnLedger.attempt, claimed.attempt);
    }
    // A malformed observation (unknown phase) is rejected by recovery with zero repair writes.
    const malformed = { ...claimed, observation: { phase: "mystery", observedAtMs: 200 } };
    await writeFile(join(directory, "transaction.json"), JSON.stringify({ schemaVersion: 1, state: { thread: base.thread, messages, draft: { revision: 1, text: null }, turnLedger: malformed, idempotency } }), "utf8");
    const before = await snapshotThread(directory);
    await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /invalid_chat_thread_observation/);
    const after = await snapshotThread(directory);
    assert.deepEqual(after, before);
    // A running ledger without the required observation is rejected too.
    await writeFile(join(directory, "transaction.json"), JSON.stringify({ schemaVersion: 1, state: { thread: base.thread, messages, draft: { revision: 1, text: null }, turnLedger: { ...claimed, status: "running" }, idempotency } }), "utf8");
    await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), /invalid_chat_thread_observation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared response transaction is recovered exactly without creating or replaying an opening", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-"));
  const threads = createChatThreadStore(root, "c".repeat(64), () => 100);
  const initial = await threads.createThread(request());
  const threadDir = join(root, "tavern", "v1", "continuities", "c".repeat(64), "threads", "thread_01");
  const recovered = {
    thread: { ...initial.thread, openingLockedAtEventId: "response_01", updatedAtMs: 101 },
    draft: initial.draft,
    turnLedger: initial.turnLedger,
    idempotency: initial.idempotency,
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

test("draft save and discard use the exact surface and durable revision CAS", async () => {
  const threads = await store();
  await threads.createThread(request("blank"));
  const saved = await threads.saveDraft!({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    expectedDraftRevision: 0,
    text: "  remember this  ",
  });
  assert.deepEqual(saved, { revision: 1, text: "  remember this  " });
  await assert.rejects(
    () =>
      threads.saveDraft!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        expectedDraftRevision: 0,
        text: "stale",
      }),
    /chat_draft_revision_conflict/,
  );
  const discarded = await threads.discardDraft!({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    expectedDraftRevision: saved.revision,
  });
  assert.deepEqual(discarded, { revision: 2, text: null });
  const reopened = await threads.resumeThread("thread_01", "surface_01");
  assert.deepEqual(reopened.draft, discarded);
  await assert.rejects(
    () =>
      threads.discardDraft!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "other_surface",
        expectedDraftRevision: discarded.revision,
      }),
    /chat_thread_surface_mismatch/,
  );
  await assert.rejects(
    () =>
      threads.saveDraft!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        expectedDraftRevision: discarded.revision,
        text: "line\nbreak",
      }),
    /invalid_chat_thread_draft/,
  );
});

test("draft mutation rejects a non-active thread before durable mutation", async () => {
  const threads = await store();
  await threads.createThread(request("blank"));
  const created = await threads.transitionLifecycle!({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    expectedManagementRevision: 1,
    operation: "archive",
  });
  assert.equal(created.lifecycleStatus, "archived");
  await assert.rejects(
    () =>
      threads.saveDraft!({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "surface_01",
        expectedDraftRevision: 0,
        text: "not allowed",
      }),
    /chat_thread_lifecycle_not_active/,
  );
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
      state: { thread: { ...persisted, title: "Recovered title", updatedAtMs: renamed.updatedAtMs + 1 }, messages: [], draft: { revision: 0, text: null }, turnLedger: null, idempotency: [] },
    }),
    "utf8",
  );
  const recovered = await threads.resumeThread("thread_01", "surface_01");
  assert.equal(recovered.thread.title, "Recovered title");
  assert.deepEqual(recovered.messages, []);
});

test("incremental appends cross the legacy 64 KiB reader ceiling and reopen durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-growth-"));
  const continuityKey = "grow".repeat(16);
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  try {
    await threads.createThread(request("blank"));
    const text = "x".repeat(1_000);
    for (let index = 0; index < 60; index += 1) {
      await threads.appendPlayer("thread_01", {
        messageId: `player_${String(index).padStart(4, "0")}`,
        text,
        occurredAtMs: 100 + index,
      });
    }
    const reopened = await threads.resumeThread("thread_01", "surface_01");
    assert.equal(reopened.messages.length, 60);
    assert.equal(reopened.messages[59]!.text, text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exactly 500 total entries including an opening; the 501st append is rejected with zero mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-capacity-opening-"));
  const continuityKey = "withopening".padEnd(64, "x");
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  try {
    const created = await threads.createThread(request());
    const messages = [...created.messages, ...playerMessages(499, "Hello", 200)];
    const state = {
      thread: { ...created.thread, updatedAtMs: 200 + 498, openingLockedAtEventId: "player_0000" },
      messages,
      draft: { revision: 0, text: null },
      turnLedger: null,
      idempotency: [],
    };
    const directory = threadDir(root, continuityKey);
    await injectPreparedJournal(directory, state);
    const reopened = await threads.resumeThread("thread_01", "surface_01");
    assert.equal(reopened.messages.length, MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES);
    const before = await snapshotThread(directory);
    await assert.rejects(
      () => threads.appendPlayer("thread_01", { messageId: "player_501st", text: "Hello", occurredAtMs: 999 }),
      { message: "chat_thread_capacity_exceeded" },
    );
    const after = await snapshotThread(directory);
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exactly 500 entries without an opening; 501st append and P4 acceptance are rejected with zero mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-capacity-blank-"));
  const continuityKey = createHash("sha256")
    .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
    .digest("hex");
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  try {
    const created = await threads.createThread(request("blank"));
    const messages = playerMessages(500, "Hello");
    const state = {
      thread: { ...created.thread, updatedAtMs: 599, openingLockedAtEventId: "player_0000" },
      messages,
      draft: { revision: 0, text: null },
      turnLedger: null,
      idempotency: [],
    };
    const directory = threadDir(root, continuityKey);
    await injectPreparedJournal(directory, state);
    const reopened = await threads.resumeThread("thread_01", "surface_01");
    assert.equal(reopened.messages.length, MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES);
    const before = await snapshotThread(directory);
    await assert.rejects(
      () => threads.appendPlayer("thread_01", { messageId: "player_501st", text: "Hello", occurredAtMs: 999 }),
      { message: "chat_thread_capacity_exceeded" },
    );
    const { acceptP4MountedPlayerMessage } = await import("./chat-thread-store.js");
    await assert.rejects(
      () =>
        acceptP4MountedPlayerMessage(
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
            text: "Hello",
            locale: "en-US",
            idempotencyKey: "abcdefghijklmnopqrstuv",
            expectedDraftRevision: 0,
          },
        ),
      { message: "chat_thread_capacity_exceeded" },
    );
    const after = await snapshotThread(directory);
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P3 state at the declared maximum projects the complete bounded transcript inside the frozen envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-p3-max-"));
  const continuityKey = "maxp3".padEnd(64, "0");
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  try {
    const created = await threads.createThread(request("blank"));
    const text = "a".repeat(16_384);
    const messages = playerMessages(500, text);
    const state = {
      thread: { ...created.thread, updatedAtMs: 599, openingLockedAtEventId: "player_0000" },
      messages,
      draft: { revision: 0, text: null },
      turnLedger: null,
      idempotency: [],
    };
    const journalJson = JSON.stringify({ schemaVersion: 1, state });
    assert.ok(Buffer.byteLength(journalJson, "utf8") <= MAX_TRANSACTION_ARTIFACT_BYTES);
    const directory = threadDir(root, continuityKey);
    await writeFile(join(directory, "transaction.json"), journalJson, "utf8");
    const reopened = await threads.resumeThread("thread_01", "surface_01");
    assert.equal(reopened.messages.length, MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES);
    assert.deepEqual(reopened.messages, messages);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("over-budget artifacts are rejected before parse and stay byte-for-byte unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-over-budget-"));
  const continuityKey = "budget".padEnd(64, "x");
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  try {
    await threads.createThread(request("blank"));
    const directory = threadDir(root, continuityKey);
    const budgets: readonly (readonly [string, number])[] = [
      ["thread.json", MAX_THREAD_ARTIFACT_BYTES],
      ["draft.json", MAX_DRAFT_ARTIFACT_BYTES],
      ["turn-ledger.json", MAX_TURN_LEDGER_ARTIFACT_BYTES],
      ["idempotency.json", MAX_IDEMPOTENCY_ARTIFACT_BYTES],
      ["messages.json", MAX_MESSAGES_ARTIFACT_BYTES],
    ];
    for (const [name, budget] of budgets) {
      const path = join(directory, name);
      const pristine = await readFile(path);
      const garbage = Buffer.alloc(budget + 1, 0x61);
      await writeFile(path, garbage);
      await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), {
        message: "invalid_strict_json_file",
      });
      assert.deepEqual(await readFile(path), garbage);
      await writeFile(path, pristine, "utf8");
    }
    // The prepared transaction envelope is the frozen state-response maximum;
    // an over-budget journal is rejected before any recovery repair write.
    const journalPath = join(directory, "transaction.json");
    const journalGarbage = Buffer.alloc(MAX_TRANSACTION_ARTIFACT_BYTES + 1, 0x62);
    await writeFile(journalPath, journalGarbage);
    await assert.rejects(() => threads.resumeThread("thread_01", "surface_01"), {
      message: "invalid_strict_json_file",
    });
    assert.deepEqual(await readFile(journalPath), journalGarbage);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chat mutation recovers eligible stale lock crash residue without its own cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-lock-recovery-"));
  const continuityKey = "stale".padEnd(64, "x");
  const threads = createChatThreadStore(root, continuityKey, () => 100);
  try {
    await threads.createThread(request("blank"));
    const directory = threadDir(root, continuityKey);
    const lockPath = join(directory, "thread.json.lock");
    await writeFile(lockPath, Buffer.alloc(0));
    await utimes(lockPath, staleAgo(), staleAgo());
    const appended = await threads.appendPlayer("thread_01", {
      messageId: "player_01",
      text: "Hello",
      occurredAtMs: 101,
    });
    assert.equal(appended.messages.length, 1);
    await writeFile(lockPath, "partial write", "utf8");
    await utimes(lockPath, staleAgo(), staleAgo());
    await threads.appendPlayer("thread_01", { messageId: "player_02", text: "Hello", occurredAtMs: 102 });
    assert.equal((await threads.resumeThread("thread_01", "surface_01")).messages.length, 2);
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted message, response, and opening text share the P4 NFC, control, and byte policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-thread-text-policy-"));
  const threads = createChatThreadStore(root, "text".padEnd(64, "x"), () => 100);
  try {
    await threads.createThread(request("blank"));
    const bad = ["control\u0001byte", "c1\u0085control", "e\u0301decomposed", "x".repeat(16_385)];
    for (const [index, text] of bad.entries()) {
      await assert.rejects(
        () =>
          threads.appendPlayer("thread_01", {
            messageId: `player_bad_${index}`,
            text,
            occurredAtMs: 100 + index,
          }),
        { message: "invalid_chat_thread_text" },
      );
      await assert.rejects(
        () =>
          threads.commitResponse("thread_01", {
            messageId: `response_bad_${index}`,
            text,
            occurredAtMs: 100 + index,
          }),
        { message: "invalid_chat_thread_text" },
      );
    }
    await assert.rejects(
      () => threads.commitOpening("thread_01", { messageId: "opening_bad", text: "control\u0001byte", source }),
      { message: "invalid_chat_thread_text" },
    );
    const accepted = await threads.appendPlayer("thread_01", {
      messageId: "player_ok",
      text: "x".repeat(16_384),
      occurredAtMs: 200,
    });
    assert.equal(accepted.messages.length, 1);
    assert.equal((await threads.resumeThread("thread_01", "surface_01")).messages.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
