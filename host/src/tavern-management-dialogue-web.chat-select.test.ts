/**
 * Chat selection (ADR 0009 / ADR-0010): the `PUT /api/tavern/v1/chat/select` route over the real dispatcher.
 *
 * The point of this test is the durable read-back and the bounded refusals, not the wire: the
 * chosen Chat must become the durable active selection the very next mount settles, the generation
 * the browser read must be the generation the Host accepts, the already-selected Chat must be
 * a no-op rather than a second admission, and a still-generating turn must not stop the switch -
 * aborting it is the authority's own job (ADR-0010). `turn_in_flight` survives only for a durable
 * turn whose attempt has not started, where there is nothing to abort.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import {
  type ChatListV1,
  type ChatSelectResultV1,
  chatListPreviewText,
  composeTavernProfile,
  type SelectChatCommandV1,
  TAVERN_BROWSER_API_VERSION,
} from "./tavern/browser-contract/index.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "./tavern/chat-thread-store.js";
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

function opaqueHandle(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("base64url").slice(0, 43);
}

function profile() {
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
      "chat.select",
    ],
    operationIds: [
      "draft.save",
      "draft.discard",
      "chat.rename",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
      "chat.select",
    ],
    navigationItemIds: ["chat"],
  });
}

async function fixture() {
  const root = await canonicalTestRoot("tavern-chat-select-");
  const threads = createChatThreadStore(root, "b".repeat(64), () => 10);
  const first = { chatThreadId: `chat-${"1".repeat(16)}`, chatSurfaceSessionId: `surface-${"1".repeat(16)}` };
  const second = { chatThreadId: `chat-${"2".repeat(16)}`, chatSurfaceSessionId: `surface-${"2".repeat(16)}` };
  const creation = createProfileAwareChatThreadCreationCapability(threads, {
    async readExact() {
      return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
    },
  });
  await creation.createExplicit({
    ...first,
    companionId: "companion",
    continuityId: "continuity",
    opening: "blank",
  });
  await creation.createExplicit({
    ...second,
    companionId: "companion",
    continuityId: "continuity",
    opening: "blank",
  });
  await threads.selectActiveThread(first.chatThreadId, first.chatSurfaceSessionId);
  const handleOf = (target: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>) =>
    opaqueHandle(`${target.chatThreadId}\u0000${target.chatSurfaceSessionId}`);
  let selectionCalls = 0;
  // `false` models the one durable state the authority cannot abort: a turn whose
  // attempt has not started yet.
  let startedAttempt = true;
  const chatSelectProvisioner = Object.freeze({
    /**
     * The dispatch route's splice point, reduced to this fixture: resolve the opaque handle to the
     * durable thread pair, refuse a stale generation, no-op the already-selected Chat, answer the
     * residual `turn_in_flight` only for a turn with no started attempt, and switch the active
     * selection durably (the real production provisioner asks the semantic authority to abort a
     * generating turn and then release and remount the mounted Chat runtime).
     */
    async select(command: SelectChatCommandV1): Promise<ChatSelectResultV1> {
      const active = await threads.readActiveThreadSelection();
      const generation = active === null ? 1 : 1;
      if (command.selectionGeneration !== generation) throw new Error("chat_management_selection_conflict");
      const durable = await threads.listThreads!();
      const target = durable.find((thread) => handleOf(thread) === command.chatHandle);
      if (target === undefined) throw new Error("chat_management_selection_conflict");
      const alreadySelected =
        active !== null &&
        active.chatThreadId === target.chatThreadId &&
        active.chatSurfaceSessionId === target.chatSurfaceSessionId;
      if (alreadySelected) return Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, status: "switched" });
      if (!startedAttempt) return Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, status: "turn_in_flight" });
      selectionCalls += 1;
      await threads.selectActiveThread(target.chatThreadId, target.chatSurfaceSessionId);
      return Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, status: "switched" });
    },
  });
  const state: TavernManagementState = {
    selection: { chatHandle: handleOf(first), generation: 1, stateRevision: opaqueHandle("state-revision") },
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
  const managementService: ChatManagementService = Object.freeze({
    async listChats(): Promise<ChatListV1> {
      const active = await threads.readActiveThreadSelection();
      const durable = await threads.listThreads!();
      const lastMessages = new Map(
        (await threads.listThreadLastMessages!()).map((last) => [last.chatThreadId, last.text]),
      );
      return Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        chats: durable.map((thread) =>
          Object.freeze({
            handle: handleOf(thread),
            title: thread.title ?? null,
            status: "active" as const,
            managementRevision: thread.managementRevision ?? 1,
            isSelected:
              active !== null &&
              active.chatThreadId === thread.chatThreadId &&
              active.chatSurfaceSessionId === thread.chatSurfaceSessionId,
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
    chatSelectProvisioner,
    playerPreferenceStore: Object.freeze({
      async read() {
        return {
          revision: 0,
          locale: null,
          disclosureVersion: null,
          consent: "undecided" as const,
          decidedAtMs: null,
          outputDevice: null,
          persona: null,
        };
      },
      async update() {
        throw new Error("player_preference_store_unavailable");
      },
    }),
    profile: profile(),
    bootstrapToken,
  });
  return {
    page,
    threads,
    first,
    second,
    handleOf,
    selectionCalls: () => selectionCalls,
    setStartedAttempt: (value: boolean) => {
      startedAttempt = value;
    },
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

test("chat.select switches the mounted Chat in process, refuses a stale generation, and no-ops the selection", async () => {
  const f = await fixture();
  try {
    const { origin } = f.page;
    const { cookie, csrf } = await openSession(origin);
    const select = (body: unknown, includeCsrf = true) =>
      fetch(`${origin}/api/tavern/v1/chat/select`, {
        method: "PUT",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          ...(includeCsrf ? { "X-CSRF-Token": csrf } : {}),
        },
        body: JSON.stringify(body),
      });

    // CSRF is required for the mutation.
    const noCsrf = await select({ apiVersion: 1, selectionGeneration: 1, chatHandle: f.handleOf(f.second) }, false);
    assert.equal(noCsrf.status, 403);

    // A stale generation is the bounded selection refusal, not a silent switch.
    const stale = await select({ apiVersion: 1, selectionGeneration: 99, chatHandle: f.handleOf(f.second) });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code?: string }).code, "selection_conflict");
    assert.equal(f.selectionCalls(), 0);

    // An unknown Chat is the same bounded refusal.
    const unknown = await select({ apiVersion: 1, selectionGeneration: 1, chatHandle: opaqueHandle("no-such-chat") });
    assert.equal(unknown.status, 409);
    assert.equal(((await unknown.json()) as { code?: string }).code, "selection_conflict");
    assert.equal(f.selectionCalls(), 0);

    // A still-generating turn does not withhold the switch: aborting it is the
    // authority's own job (ADR-0010), so the route answers the honest outcome and
    // the durable selection moves.
    f.setStartedAttempt(true);
    const whileGenerating = await select({ apiVersion: 1, selectionGeneration: 1, chatHandle: f.handleOf(f.second) });
    assert.equal(whileGenerating.status, 200);
    assert.deepEqual(await whileGenerating.json(), { apiVersion: 1, status: "switched" });
    assert.equal(f.selectionCalls(), 1);
    assert.equal((await f.threads.readActiveThreadSelection())?.chatThreadId, f.second.chatThreadId);
    // Back to the mounted Chat for the remaining cases.
    await f.threads.selectActiveThread(f.first.chatThreadId, f.first.chatSurfaceSessionId);

    // The one durable state with nothing to abort answers the residual
    // `turn_in_flight`, and nothing durable changes under it.
    f.setStartedAttempt(false);
    const residual = await select({ apiVersion: 1, selectionGeneration: 1, chatHandle: f.handleOf(f.second) });
    assert.equal(residual.status, 200);
    assert.deepEqual(await residual.json(), { apiVersion: 1, status: "turn_in_flight" });
    assert.equal(f.selectionCalls(), 1);
    assert.equal((await f.threads.readActiveThreadSelection())?.chatThreadId, f.first.chatThreadId);
    f.setStartedAttempt(true);

    // Selecting the mounted Chat is a no-op: no durable write, no second admission.
    const noop = await select({ apiVersion: 1, selectionGeneration: 1, chatHandle: f.handleOf(f.first) });
    assert.equal(noop.status, 200);
    assert.deepEqual(await noop.json(), { apiVersion: 1, status: "switched" });
    assert.equal(f.selectionCalls(), 1);

    // A real selection switches the mounted Chat and answers the honest switched outcome.
    const chosen = await select({ apiVersion: 1, selectionGeneration: 1, chatHandle: f.handleOf(f.second) });
    assert.equal(chosen.status, 200);
    assert.deepEqual(await chosen.json(), { apiVersion: 1, status: "switched" });
    assert.equal(f.selectionCalls(), 2);

    // Real read-back: the durable active selection is now the chosen Chat, and a fresh list read
    // reflects it.
    const active = await f.threads.readActiveThreadSelection();
    assert.equal(active?.chatThreadId, f.second.chatThreadId);
    assert.equal(active?.chatSurfaceSessionId, f.second.chatSurfaceSessionId);
    const list = await fetch(`${origin}/api/tavern/v1/chats?apiVersion=1&state=active`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as ChatListV1;
    assert.equal(body.chats.filter((entry) => entry.isSelected).length, 1);
    assert.equal(body.chats.find((entry) => entry.isSelected)?.handle, f.handleOf(f.second));
  } finally {
    await f.page.close();
  }
});
