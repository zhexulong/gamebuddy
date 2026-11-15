import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { PlayerPreferenceStore, playerPreferencePath } from "./settings/player-preference-store.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import type { ChatForkService } from "./tavern/chat-fork-service.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import { startTavernManagementDialogueWebServer } from "./tavern-management-dialogue-web.js";

// The one record's durable path lock releases through the same reclaimer the production runtime binds.
bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const idempotencyKey = "B".repeat(22);
const CORE_ROUTES = [
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
] as const;
const CORE_OPERATIONS = [
  "draft.save",
  "draft.discard",
  "chat.rename",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
] as const;
const FORK_ROUTES = ["chat.fork"] as const;

function profileWithFork(withFork: boolean) {
  return composeTavernProfile({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: withFork ? [...CORE_ROUTES, ...FORK_ROUTES] : [...CORE_ROUTES],
    operationIds: [...CORE_OPERATIONS],
    navigationItemIds: ["chat", "characters"],
  });
}

const state: TavernManagementState = {
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  companionDisplayName: "Mira",
  companionHandle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA",
  title: "Farm Chat",
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

function worldInfoService(): WorldInfoBindingManagementService {
  const bound = { state: "none" as const, revision: handle, items: [] };
  return Object.freeze({
    async read() {
      return bound;
    },
    async setBinding() {
      return bound;
    },
    async detail() {
      throw new Error("unused_world_info_detail");
    },
    async create() {
      throw new Error("unused_world_info_create");
    },
    async update() {
      throw new Error("unused_world_info_update");
    },
    async delete() {
      throw new Error("unused_world_info_delete");
    },
    async close() {
      // no-op
    },
  });
}

function managementService(): ChatManagementService {
  return Object.freeze({
    async listChats() {
      return { apiVersion: 1 as const, chats: [] };
    },
    async renameChatTitle() {
      throw new Error("rename_not_used");
    },
    async transitionLifecycle() {
      throw new Error("retention_not_used");
    },
    async commitOpeningVariant() {
      throw new Error("opening_variant_not_used");
    },
    async readDraft() {
      return { apiVersion: 1 as const, revision: 0, text: null };
    },
    async saveDraft() {
      throw new Error("draft_save_not_used");
    },
    async discardDraft() {
      throw new Error("draft_discard_not_used");
    },
    async close() {
      // no-op
    },
  });
}

const forkedRow = Object.freeze({
  apiVersion: 1 as const,
  chat: Object.freeze({
    // A canonical base64url handle of 32 bytes: 42 characters plus a final one whose two low bits are the
    // padding the format requires (`A`), which is why the last character cannot be any letter.
    handle: `${"C".repeat(42)}A`,
    title: "Farm Chat",
    status: "active" as const,
    managementRevision: 1,
    isSelected: false,
    updatedAtMs: 1,
    preview: "Mira: The greenhouse is warm.",
  }),
});

/** Records what reached the seam, so a refusal that never calls it is observable as an absence. */
function recordingForkService(): Readonly<{ service: ChatForkService; calls: () => number }> {
  let calls = 0;
  const service = Object.freeze({
    async fork() {
      calls += 1;
      return forkedRow;
    },
  });
  return { service, calls: () => calls };
}

async function withServer(
  options: Readonly<{ withFork: boolean; fork?: ChatForkService }>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  // The core surface carries the voice/language settings pair, which reads the one Host-owned
  // preference record: this test never writes it, so a real record on a temporary root is the
  // cheapest honest collaborator (a stub could hide a second, divergent record).
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-chat-fork-web-"));
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: managementService(),
    worldInfoService: worldInfoService(),
    playerPreferenceStore: new PlayerPreferenceStore(playerPreferencePath(root)),
    ...(options.fork === undefined ? {} : { chatForkService: options.fork }),
    profile: profileWithFork(options.withFork),
    bootstrapToken: token,
  });
  try {
    await run(server.origin);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

async function bootstrap(origin: string): Promise<{ csrfToken: string; cookie: string }> {
  const response = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return {
    csrfToken: (JSON.parse(body) as { csrfToken: string }).csrfToken,
    cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!,
  };
}

const FORK_BODY = JSON.stringify({ apiVersion: 1, selectionGeneration: 1, messageHandle: handle });

function fork(origin: string, headers: Readonly<Record<string, string>>, body: string = FORK_BODY): Promise<Response> {
  return fetch(`${origin}/api/tavern/v1/chats/fork`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body,
  });
}

test("a branch is refused before the seam without a session, without CSRF, and without a key", async () => {
  const recorded = recordingForkService();
  await withServer({ withFork: true, fork: recorded.service }, async (origin) => {
    // No origin, no session: the two refusals a browser tab cannot talk its way past.
    const noSession = await fetch(`${origin}/api/tavern/v1/chats/fork`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "idempotency-key": idempotencyKey },
      body: FORK_BODY,
    });
    assert.equal(noSession.status, 401);

    const session = await bootstrap(origin);
    const noCsrf = await fork(origin, { Cookie: session.cookie, "idempotency-key": idempotencyKey });
    assert.equal(noCsrf.status, 403);

    // The key is what makes the response replayable: without it the surface cannot promise which
    // branch a retry means, so the request never reaches the seam.
    const noKey = await fork(origin, { Cookie: session.cookie, "x-csrf-token": session.csrfToken });
    assert.equal(noKey.status, 400);
    const badBody = await fork(
      origin,
      { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "idempotency-key": idempotencyKey },
      JSON.stringify({ apiVersion: 1, messageHandle: handle }),
    );
    assert.equal(badBody.status, 400);

    assert.equal(recorded.calls(), 0, "no refusal above may reach the fork seam");
  });
});

test("a profile without the branch route answers it as a capability it does not declare", async () => {
  const recorded = recordingForkService();
  await withServer({ withFork: false, fork: recorded.service }, async (origin) => {
    const session = await bootstrap(origin);
    const response = await fork(origin, {
      Cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      "idempotency-key": idempotencyKey,
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, "profile_operation_unavailable");
    assert.equal(recorded.calls(), 0);
  });
});

test("a declared branch reaches the seam with the key it was sent, and answers the created Chat", async () => {
  let seen: Readonly<{ command: unknown; key: string }> | undefined;
  await withServer(
    {
      withFork: true,
      fork: Object.freeze({
        async fork(command, key) {
          seen = { command, key };
          return forkedRow;
        },
      }),
    },
    async (origin) => {
      const session = await bootstrap(origin);
      const response = await fork(origin, {
        Cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "idempotency-key": idempotencyKey,
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.deepEqual(JSON.parse(body), forkedRow);
      assert.deepEqual(seen?.command, { apiVersion: 1, selectionGeneration: 1, messageHandle: handle });
      assert.equal(seen?.key, idempotencyKey);
    },
  );
});

test("the seam's own refusals reach the browser by name, never as a generic failure", async () => {
  const refusals = new Map([
    ["chat_fork_target_not_found", 404],
    ["chat_fork_turn_active", 409],
    ["chat_fork_opening_retained", 409],
    ["idempotency_conflict", 409],
    ["chat_fork_unavailable", 503],
  ]);
  for (const [message, status] of refusals) {
    await withServer(
      {
        withFork: true,
        fork: Object.freeze({
          async fork(): Promise<never> {
            throw new Error(message);
          },
        }),
      },
      async (origin) => {
        const session = await bootstrap(origin);
        const response = await fork(origin, {
          Cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "idempotency-key": idempotencyKey,
        });
        const body = (await response.json()) as { code: string };
        assert.equal(response.status, status, `${message} is answered ${status}`);
        assert.equal(
          body.code,
          message === "chat_fork_unavailable" ? "storage_unavailable" : message,
          `${message} does not collapse into a generic failure`,
        );
      },
    );
  }
});
