import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChatThreadStore } from "../chat-thread-store.js";
import {
  createChatLifecycleService,
  createInternalChatLifecycleService,
  type ChatLifecycleAtomicGuard,
  type ChatLifecycleMutationReader,
} from "./chat-lifecycle-service.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-lifecycle-"));
  let time = 10;
  const store = createChatThreadStore(root, "a".repeat(64), () => time++);
  const create = async (id: string, title?: string) => {
    const state = await store.createThread({
      chatThreadId: id,
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatSurfaceSessionId: `${id}_surface`,
      opening: "blank",
    });
    if (title !== undefined)
      await store.renameThreadTitle!({
        chatThreadId: id,
        chatSurfaceSessionId: `${id}_surface`,
        expectedManagementRevision: 1,
        title,
      });
  };
  return {
    store,
    create,
    root,
    dispose: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  };
}
const passGuard: ChatLifecycleAtomicGuard = {
  async withExactThreadManagementLock(_binding, operation) {
    return operation();
  },
};
const passMutationReader: ChatLifecycleMutationReader = {
  async assertChatLifecycleMutationAllowed() {},
};
function service(
  store: ReturnType<typeof createChatThreadStore>,
  atomicGuard: ChatLifecycleAtomicGuard = passGuard,
  mutationReader: ChatLifecycleMutationReader = passMutationReader,
) {
  return createChatLifecycleService(
    store,
    { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" },
    atomicGuard,
    mutationReader,
  );
}

test("trash persists the exact pre-trash restore target and transition readback", async () => {
  const f = await fixture();
  try {
    await f.create("thread_01", "Morning plans");
    const lifecycle = service(f.store);
    const archived = await lifecycle.archive({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "thread_01_surface",
      expectedManagementRevision: 2,
    });
    const trashed = await lifecycle.trash({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "thread_01_surface",
      expectedManagementRevision: archived.managementRevision,
    });
    assert.deepEqual(trashed, { status: "trashed", managementRevision: 4, title: "Morning plans" });
    assert.equal((await f.store.resumeThread("thread_01", "thread_01_surface")).thread.trashRestoreStatus, "archived");
    assert.deepEqual(
      await lifecycle.restore({
        chatThreadId: "thread_01",
        chatSurfaceSessionId: "thread_01_surface",
        expectedManagementRevision: 4,
      }),
      { status: "archived", managementRevision: 5, title: "Morning plans" },
    );
  } finally {
    await f.dispose();
  }
});

test("lifecycle mutation reader receives the exact identity and thread binding", async () => {
  const f = await fixture();
  try {
    await f.create("thread_01");
    const calls: Array<readonly [unknown, unknown]> = [];
    const mutationReader: ChatLifecycleMutationReader = {
      async assertChatLifecycleMutationAllowed(identity, threadBinding) {
        calls.push([identity, threadBinding]);
      },
    };
    await service(f.store, passGuard, mutationReader).archive({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "thread_01_surface",
      expectedManagementRevision: 1,
    });
    assert.deepEqual(calls, [
      [
        { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" },
        { chatThreadId: "thread_01", chatSurfaceSessionId: "thread_01_surface" },
      ],
    ]);
  } finally {
    await f.dispose();
  }
});

test("title and lifecycle share one management CAS and reject stale writes", async () => {
  const f = await fixture();
  try {
    await f.create("thread_01");
    const lifecycle = service(f.store);
    await lifecycle.archive({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "thread_01_surface",
      expectedManagementRevision: 1,
    });
    await assert.rejects(
      () =>
        f.store.renameThreadTitle!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId: "thread_01_surface",
          expectedManagementRevision: 1,
          title: "stale",
        }),
      /management_revision_conflict/,
    );
    const renamed = await f.store.renameThreadTitle!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "thread_01_surface",
      expectedManagementRevision: 2,
      title: "Fresh",
    });
    await assert.rejects(
      () =>
        lifecycle.restore({
          chatThreadId: "thread_01",
          chatSurfaceSessionId: "thread_01_surface",
          expectedManagementRevision: 2,
        }),
      /management_revision_conflict/,
    );
    assert.equal(renamed.managementRevision, 3);
  } finally {
    await f.dispose();
  }
});

test("internal list/search retains exact opaque bindings while public results do not", async () => {
  const f = await fixture();
  try {
    await f.create("thread_01", "A QUIET morning");
    await f.create("thread_02", "A quiet morning");
    await f.store.appendPlayer("thread_02", {
      messageId: "message_01",
      text: "hidden transcript text",
      occurredAtMs: 50,
    });
    const internal = createInternalChatLifecycleService(
      f.store,
      { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" },
      passGuard,
      passMutationReader,
    );
    const results = await internal.searchTitlesInternal({ literal: "quiet", status: "active" });
    assert.deepEqual(
      results.map((result) => result.binding.chatThreadId),
      ["thread_01", "thread_02"],
    );
    assert.deepEqual(
      await service(f.store).searchTitles({ literal: "QUIET", status: "active" }),
      results.map((result) => result.metadata),
    );
    assert.deepEqual(await internal.listInternal("archived"), []);
    assert.deepEqual(await internal.searchTitlesInternal({ literal: "hidden", status: "active" }), []);
  } finally {
    await f.dispose();
  }
});

test("separate lifecycle services serialize concurrent archive and produce one CAS winner", async () => {
  const f = await fixture();
  try {
    await f.create("thread_01");
    const firstStore = createChatThreadStore(f.root, "a".repeat(64));
    const secondStore = createChatThreadStore(f.root, "a".repeat(64));
    const requests = {
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "thread_01_surface",
      expectedManagementRevision: 1,
    } as const;
    const [first, second] = await Promise.allSettled([
      service(firstStore).archive(requests),
      service(secondStore).archive(requests),
    ]);
    assert.equal([first, second].filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      [first, second].filter(
        (result) => result.status === "rejected" && /management_revision_conflict/.test(String(result.reason)),
      ).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("archive and title mutations share the durable management CAS under a concurrent race", async () => {
  const f = await fixture();
  try {
    await f.create("thread_01");
    const requests = {
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "thread_01_surface",
      expectedManagementRevision: 1,
    } as const;
    const [archive, rename] = await Promise.allSettled([
      service(f.store).archive(requests),
      f.store.renameThreadTitle!({ ...requests, title: "Concurrent" }),
    ]);
    assert.equal([archive, rename].filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      [archive, rename].filter(
        (result) => result.status === "rejected" && /management_revision_conflict/.test(String(result.reason)),
      ).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("a lifecycle request using a listed revision is rejected after another mutation", async () => {
  const f = await fixture();
  try {
    await f.create("thread_01", "Before");
    const listed = (await f.store.listThreads!()).find((thread) => thread.chatThreadId === "thread_01")!;
    await f.store.renameThreadTitle!({
      chatThreadId: listed.chatThreadId,
      chatSurfaceSessionId: listed.chatSurfaceSessionId,
      expectedManagementRevision: listed.managementRevision!,
      title: "After",
    });
    await assert.rejects(
      () =>
        service(f.store).archive({
          chatThreadId: listed.chatThreadId,
          chatSurfaceSessionId: listed.chatSurfaceSessionId,
          expectedManagementRevision: listed.managementRevision!,
        }),
      /management_revision_conflict/,
    );
  } finally {
    await f.dispose();
  }
});

test("missing mutation reader fails closed without a legacy guard fallback", async () => {
  const f = await fixture();
  try {
    await f.create("thread_01");
    assert.throws(
      () =>
        createChatLifecycleService(
          f.store,
          { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" },
          passGuard,
          undefined,
        ),
      /mutation_reader_unavailable/,
    );
  } finally {
    await f.dispose();
  }
});

test("missing atomic guard fails closed rather than claiming cross-system serialization", async () => {
  const f = await fixture();
  try {
    await f.create("thread_01");
    assert.throws(
      () =>
        createChatLifecycleService(
          f.store,
          { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" },
          undefined,
          passMutationReader,
        ),
      /atomic_guard_unavailable/,
    );
  } finally {
    await f.dispose();
  }
});
