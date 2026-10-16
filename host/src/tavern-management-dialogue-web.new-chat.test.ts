/**
 * New Chat (design/26 §4.4): the `POST /api/tavern/v1/chats` route over the real
 * `TavernLibraryService` opening seam and a real durable `ChatThreadStore`.
 *
 * The point of this test is the read-back, not the wire: a created Chat must be
 * a durable thread the very next list read observes, and that thread's opening
 * must be the mounted companion's own greeting - the same greeting record the
 * `PUT /api/tavern/v1/chat/opening` variant choice pages through. A route that
 * answered 200 while writing nothing, or while writing a blank opening, would
 * pass every schema check and still leave the player with one usable Chat.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import {
  type ChatCreateResultV1,
  type ChatListV1,
  chatListPreviewText,
  composeTavernProfile,
  type CreateChatCommandV1,
  TAVERN_BROWSER_API_VERSION,
} from "./tavern/browser-contract/index.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "./tavern/chat-thread-store.js";
import { createGreetingManagementService } from "./tavern/greeting-management/greeting-management.js";
import { createTavernLibraryService } from "./tavern/library-service.js";
import { resolveTavernPaths } from "./tavern/tavern-paths.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import { startTavernManagementDialogueWebServer } from "./tavern-management-dialogue-web.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const bootstrapToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GREETING_TEXT = "Good morning, farmer. The valley is quiet today.";
const HASH = "a".repeat(64);

/** The same canonical opaque handle shape the Host's lease projection mints. */
function opaqueHandle(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("base64url").slice(0, 43);
}

const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };

function managementProfile(withCreate: boolean) {
  return composeTavernProfile({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: [
      "bootstrap",
      "state.read",
      "draft.read",
      "draft.save",
      "draft.discard",
      "chat.list",
      "chat.rename",
      "world-info.read",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
      ...(withCreate ? (["chat.create"] as const) : []),
    ],
    operationIds: [
      "draft.save",
      "draft.discard",
      "chat.rename",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
      ...(withCreate ? (["chat.create"] as const) : []),
    ],
    navigationItemIds: ["chat"],
  });
}

/**
 * The durable fixture: one mounted companion with a reviewed greeting set, one
 * already-existing blank Chat, and the real library opening seam on top of the
 * same store the management list reads.
 *
 * `withCompanionArtifact: false` is the two-producer disagreement: a companion
 * whose library `companion.json` was never written. The seed installs that record
 * through the library's own creation path, so a missing one is not the ordinary
 * mounted-companion case - it must fail closed with the bounded, non-retryable
 * `companion_record_unreadable`, never a retryable runtime 503.
 */
async function fixture(withCreate: boolean, options: Readonly<{ withCompanionArtifact?: boolean }> = {}) {
  const withCompanionArtifact = options.withCompanionArtifact ?? true;
  const root = await canonicalTestRoot("tavern-new-chat-");
  const paths = resolveTavernPaths(
    {
      root,
      runtimeCwd: root,
      agentDir: "x",
      sessionDir: "x",
      identityProfilePath: "x",
      identityProfileBindingPath: "x",
      runManifestPath: "x",
    },
    identity,
  );
  const artifacts = new TavernArtifactStore(root);
  const threads = createChatThreadStore(root, "b".repeat(64), () => 10);
  const profileReader = {
    async readExact() {
      return { profileId: "profile", revision: 1, canonicalHash: HASH };
    },
  };
  const library = createTavernLibraryService(paths, artifacts, threads, profileReader);
  if (withCompanionArtifact) {
    await library.createNewCompanion({
      companionId: identity.companionId,
      continuityId: identity.continuityId,
      name: "Mira",
      profileId: "profile",
      profileRevision: 1,
      profileHash: HASH,
    });
  }
  await createGreetingManagementService(artifacts, paths.companionRoot).create({
    label: "Initial Greeting",
    variants: [
      { label: "Default", text: GREETING_TEXT },
      { label: "Warm", text: "There you are. I kept the kettle on." },
    ],
  });
  const greetingRecord = await createGreetingManagementService(artifacts, paths.companionRoot).readExact();
  assert.ok(greetingRecord !== null);

  // The Chat that already exists is genuinely blank, so the greeting on the
  // second one cannot be a re-read of the first.
  const firstChatThreadId = `chat-${"1".repeat(16)}`;
  const firstChatSurfaceSessionId = `surface-${"1".repeat(16)}`;
  if (withCompanionArtifact) {
    await library.createNewChat({
      chatThreadId: firstChatThreadId,
      chatSurfaceSessionId: firstChatSurfaceSessionId,
      opening: { kind: "blank" },
    });
  } else {
    // The runtime's own opening Chat: created through the profile-aware creation
    // capability the mount path uses, so no library companion artifact is read.
    await createProfileAwareChatThreadCreationCapability(threads, profileReader).createExplicit({
      chatThreadId: firstChatThreadId,
      chatSurfaceSessionId: firstChatSurfaceSessionId,
      companionId: identity.companionId,
      continuityId: identity.continuityId,
      opening: "blank",
    });
  }

  const created = {
    chatThreadId: "",
    chatSurfaceSessionId: "",
    calls: 0,
    failWith: undefined as Error | undefined,
  };
  const newChatProvisioner = Object.freeze({
    /**
     * The composition's New Chat provisioner, reduced to this fixture: mint the
     * thread identity, ask the library for the mounted companion's own opening
     * (the request names none), then project the created Chat's entry.
     */
    async create(command: CreateChatCommandV1): Promise<ChatCreateResultV1> {
      created.calls += 1;
      if (created.failWith !== undefined) throw created.failWith;
      if (command.selectionGeneration !== 1) throw new Error("chat_management_selection_conflict");
      const suffix = randomUUID().replaceAll("-", "");
      created.chatThreadId = `chat-${suffix.slice(0, 16)}`;
      created.chatSurfaceSessionId = `surface-${suffix.slice(16, 32)}`;
      const state = await library.createNewChat({
        chatThreadId: created.chatThreadId,
        chatSurfaceSessionId: created.chatSurfaceSessionId,
      });
      const opening = state.messages.find((message) => message.kind === "opening");
      return Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        chat: Object.freeze({
          handle: opaqueHandle(`${created.chatThreadId}\u0000${created.chatSurfaceSessionId}`),
          title: state.thread.title ?? null,
          status: "active" as const,
          managementRevision: state.thread.managementRevision ?? 1,
          isSelected: false,
          updatedAtMs: state.thread.updatedAtMs,
          preview: chatListPreviewText(opening === undefined ? null : opening.text),
        }),
        opening: opening === undefined ? null : opening.text,
      });
    },
  });

  const state: TavernManagementState = {
    selection: {
      chatHandle: opaqueHandle(`${firstChatThreadId}\u0000${firstChatSurfaceSessionId}`),
      generation: 1,
      stateRevision: opaqueHandle("state-revision"),
    },
    companionDisplayName: "Mira",
    title: null,
    transcript: [],
    draft: { revision: 0, text: null },
    turn: null,
    operations: [],
    worldInfo: null,
  };
  const facade: TavernManagementStateFacade = Object.freeze({
    read: async () => state,
    close: async () => undefined,
  });
  /** The metadata-only list, read from the same durable store the route wrote to. */
  let listReads = 0;
  const managementService: ChatManagementService = Object.freeze({
    async listChats(): Promise<ChatListV1> {
      listReads += 1;
      const durable = await threads.listThreads!();
      // The same batched read the production projection uses: one query for every
      // thread's last message, then the row's own durable facts.
      const lastMessages = new Map(
        (await threads.listThreadLastMessages!()).map((last) => [last.chatThreadId, last.text]),
      );
      return Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        chats: durable
          .filter((thread) => (thread.lifecycleStatus ?? "active") === "active")
          .map((thread) =>
            Object.freeze({
              handle: opaqueHandle(`${thread.chatThreadId}\u0000${thread.chatSurfaceSessionId}`),
              title: thread.title ?? null,
              status: "active" as const,
              managementRevision: thread.managementRevision ?? 1,
              isSelected: thread.chatThreadId === firstChatThreadId,
              updatedAtMs: thread.updatedAtMs,
              preview: chatListPreviewText(lastMessages.get(thread.chatThreadId) ?? null),
            }),
          ),
      });
    },
    async renameChatTitle() {
      throw new Error("chat_management_service_unavailable");
    },
    async transitionLifecycle() {
      throw new Error("chat_management_service_unavailable");
    },
    async commitOpeningVariant() {
      throw new Error("chat_management_service_unavailable");
    },
    async readDraft() {
      throw new Error("chat_management_service_unavailable");
    },
    async saveDraft() {
      throw new Error("chat_management_service_unavailable");
    },
    async discardDraft() {
      throw new Error("chat_management_service_unavailable");
    },
    async close() {},
  });
  const worldInfoService: WorldInfoBindingManagementService = Object.freeze({
    async read() {
      return { state: "none" as const, revision: opaqueHandle("world-info"), items: [] };
    },
    async setBinding() {
      return { state: "none" as const, revision: opaqueHandle("world-info"), items: [] };
    },
    async close() {},
  });
  const page = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService,
    worldInfoService,
    newChatProvisioner,
    playerPreferenceStore: Object.freeze({
      async read() {
        return {
          revision: 0,
          locale: null,
          disclosureVersion: null,
          consent: "undecided" as const,
          decidedAtMs: null,
          outputDevice: null,
        };
      },
      async update() {
        throw new Error("player_preference_store_unavailable");
      },
    }),
    profile: managementProfile(withCreate),
    bootstrapToken,
  });
  return {
    page,
    library,
    threads,
    created,
    paths,
    greetingRecord,
    firstChat: { chatThreadId: firstChatThreadId, chatSurfaceSessionId: firstChatSurfaceSessionId },
    listReads: () => listReads,
  };
}

async function openSession(origin: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { csrfToken: string };
  return { cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!, csrf: body.csrfToken };
}

test("New Chat creates a durable second Chat that opens on the companion's own greeting", async () => {
  const f = await fixture(true);
  try {
    const { origin } = f.page;
    const { cookie, csrf } = await openSession(origin);

    const before = await fetch(`${origin}/api/tavern/v1/chats?apiVersion=1&state=active`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(before.status, 200);
    assert.equal(((await before.json()) as ChatListV1).chats.length, 1);

    const create = await fetch(`${origin}/api/tavern/v1/chats`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1 }),
    });
    assert.equal(create.status, 200);
    const result = (await create.json()) as ChatCreateResultV1;
    assert.equal(f.created.calls, 1);
    // The created Chat is NOT the mounted one, and its message zero is the
    // companion's own greeting - so the surface can render it before claiming
    // success (design/26 §4.4).
    assert.equal(result.chat.isSelected, false);
    assert.equal(result.chat.status, "active");
    assert.equal(result.opening, GREETING_TEXT);

    // The fresh read-back shows two Chats, and the new one is in the list.
    const after = await fetch(`${origin}/api/tavern/v1/chats?apiVersion=1&state=active`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(after.status, 200);
    const listed = (await after.json()) as ChatListV1;
    assert.equal(listed.chats.length, 2);
    assert.equal(listed.chats.filter((chat) => chat.handle === result.chat.handle).length, 1);
    assert.equal(listed.chats.filter((chat) => chat.isSelected).length, 1);

    // The durable thread itself carries the greeting opening, from the exact
    // greeting record the variant-choice route later pages through.
    const durable = await f.threads.resumeThread(f.created.chatThreadId, f.created.chatSurfaceSessionId);
    const opening = durable.messages.find((message) => message.kind === "opening");
    assert.ok(opening !== undefined);
    assert.equal(opening.text, GREETING_TEXT);
    assert.equal(opening.greetingSource?.variantId, "greeting-1");
    assert.equal(opening.greetingSource?.greetingSetId, f.greetingRecord.greetingSetId);
    assert.equal(opening.greetingSource?.sourceRevision, f.greetingRecord.revision);
    assert.equal(opening.greetingSource?.canonicalHash, f.greetingRecord.canonicalHash);
    assert.equal(durable.thread.openingSelection.kind, "greeting");
    // The opening is not yet sealed, so the variant choice is still legal on it.
    assert.equal(durable.thread.openingLockedAtEventId, null);

    // The two rows a player sees after one New Chat: both carry the durable thread
    // time, and the Chat that opened on the greeting does not read like the blank
    // one. Before this contract change both rows were the single word `New chat`.
    const createdEntry = listed.chats.find((chat) => chat.handle === result.chat.handle)!;
    const blankEntry = listed.chats.find((chat) => chat.handle !== result.chat.handle)!;
    assert.equal(createdEntry.updatedAtMs, durable.thread.updatedAtMs);
    assert.equal(createdEntry.preview, GREETING_TEXT);
    assert.equal(
      blankEntry.updatedAtMs,
      (await f.threads.resumeThread(f.firstChat.chatThreadId, f.firstChat.chatSurfaceSessionId)).thread.updatedAtMs,
    );
    assert.equal(blankEntry.preview, null, "a genuinely blank Chat has no message to preview");
    assert.notEqual(blankEntry.preview, createdEntry.preview);
  } finally {
    await f.page.close();
  }
});

test("New Chat refuses a stale selection generation and writes no Chat", async () => {
  const f = await fixture(true);
  try {
    const { origin } = f.page;
    const { cookie, csrf } = await openSession(origin);
    const refused = await fetch(`${origin}/api/tavern/v1/chats`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 99 }),
    });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, "selection_conflict");
    assert.equal(f.created.chatThreadId, "");
    const durable = await f.threads.listThreads!();
    assert.equal(durable.length, 1);

    // A missing CSRF fact is refused before any content work.
    const noCsrf = await fetch(`${origin}/api/tavern/v1/chats`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1 }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(((await noCsrf.json()) as { code: string }).code, "csrf_failed");
    assert.equal(f.created.calls, 1);
  } finally {
    await f.page.close();
  }
});

test("a profile that does not publish chat.create refuses the operation without a producer", async () => {
  const f = await fixture(false);
  try {
    const { origin } = f.page;
    const { cookie, csrf } = await openSession(origin);
    const refused = await fetch(`${origin}/api/tavern/v1/chats`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1 }),
    });
    assert.equal(refused.status, 404);
    assert.equal(((await refused.json()) as { code: string }).code, "profile_operation_unavailable");
    // The route is unmounted, so the provisioner behind it was never reached.
    assert.equal(f.created.calls, 0);
  } finally {
    await f.page.close();
  }
});

/**
 * A companion whose library record is missing is the two-producer disagreement:
 * the seed installs `companion.json` through the library's own creation path, so
 * a missing record is a data-integrity fact, not a runtime outage. It must fail
 * closed with its own bounded, non-retryable code - the capture of dd29319e
 * answered a retryable `503 runtime_unavailable` for exactly this shape, which
 * told the player to retry something that cannot succeed.
 */
test("New Chat on a companion with no library record fails closed with its own honest code", async () => {
  const f = await fixture(true, { withCompanionArtifact: false });
  try {
    const { origin } = f.page;
    const { cookie, csrf } = await openSession(origin);

    const create = await fetch(`${origin}/api/tavern/v1/chats`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1 }),
    });
    assert.equal(create.status, 503);
    const problem = (await create.json()) as { code: string; retryable: boolean };
    assert.equal(problem.code, "companion_record_unreadable");
    // Retrying cannot create the record whose absence is the cause: not retryable.
    assert.equal(problem.retryable, false);

    // No Chat was written behind the refusal.
    const durable = await f.threads.listThreads!();
    assert.equal(durable.length, 1);
  } finally {
    await f.page.close();
  }
});
