import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { ModelProfileStore } from "./settings/model-profile-store.js";
import { PlayerPreferenceStore, playerPreferencePath } from "./settings/player-preference-store.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import { TAVERN_PROVIDER_CATALOG } from "./tavern/provider-catalog.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import { createTavernManagementDialogueWebRequestHandler } from "./tavern-management-dialogue-web.js";

/**
 * The model-profile management routes (design/28 §2.3) as the browser sees them.
 *
 * These tests own the contract the player journey depends on: the Chat and Game
 * profiles are the player's own model id and thinking level, a model id the
 * shipped recommendation does not name round-trips byte for byte (the defect this
 * slice removes), the shipped catalog is projection-only guidance, each surface
 * advances on its own durable revision, and the exact session/CSRF/origin gates
 * of the management profile apply to both routes.
 */

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let canonicalTemporaryRoot: string;

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  canonicalTemporaryRoot = await realpath(tmpdir());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const state: TavernManagementState = {
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  companionDisplayName: "Mira",
  title: "Farm Chat",
  transcript: [],
  draft: { revision: 0, text: null },
  turn: null,
  operations: [],
  worldInfo: null,
};

/** The frozen management core (no Memory), exactly the canonical profile order. */
const BASE_ROUTES = [
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
const BASE_OPERATIONS = [
  "draft.save",
  "draft.discard",
  "chat.rename",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
] as const;

const profilesProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...BASE_ROUTES, "settings.profiles.read", "settings.profiles.update"],
  operationIds: [...BASE_OPERATIONS, "settings.profiles.read", "settings.profiles.update"],
  navigationItemIds: ["chat"],
});

/** A profile that advertises neither profile route: the panel must see 404. */
const profileWithoutModelProfiles = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...BASE_ROUTES],
  operationIds: [...BASE_OPERATIONS],
  navigationItemIds: ["chat"],
});

const managementService: ChatManagementService = Object.freeze({
  async readDraft() {
    return { apiVersion: 1 as const, revision: 0, text: null };
  },
  async saveDraft() {
    return { apiVersion: 1 as const, revision: 1, text: null };
  },
  async discardDraft() {
    return { apiVersion: 1 as const, revision: 1, text: null };
  },
  async listChats() {
    return { apiVersion: 1 as const, chats: [] };
  },
  async renameChatTitle() {
    return { apiVersion: 1 as const, title: null, managementRevision: 1 };
  },
  async transitionLifecycle() {
    throw new Error("retention_not_used");
  },
  async close() {},
});

const worldInfoState = { state: "none" as const, revision: handle, items: [] };

const worldInfoService: WorldInfoBindingManagementService = Object.freeze({
  async read() {
    return worldInfoState;
  },
  async setBinding() {
    return worldInfoState;
  },
  async close() {},
});

function facade(): TavernManagementStateFacade {
  return Object.freeze({
    async read() {
      return state;
    },
    async close() {},
  });
}

/**
 * The one Host-owned player preference record the management profile mounts for
 * its Voice/Language field groups. These tests exercise only the model-profile
 * routes, so a real store on the test root is enough to satisfy composition.
 */
function playerPreferenceStore(root: string): PlayerPreferenceStore {
  return new PlayerPreferenceStore(playerPreferencePath(root));
}

async function withHandler(
  options: Readonly<{
    profile?: ReturnType<typeof composeTavernProfile>;
  }>,
  run: (
    profilesPath: string,
    request: (
      method: string,
      path: string,
      headers?: Record<string, string>,
      body?: unknown,
    ) => Promise<Readonly<{ status: number; body: unknown; raw: string }>>,
    bootstrap: () => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-model-profile-routes-"));
  const profilesPath = join(root, "settings", "model-profiles.json");
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade(),
    managementService,
    worldInfoService,
    playerPreferenceStore: playerPreferenceStore(root),
    profile: options.profile ?? profilesProfile,
    bootstrapToken: token,
    modelProfileStore: new ModelProfileStore(profilesPath),
  });
  let cookie: string | null = null;
  let csrf: string | null = null;
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const incoming = {
      method,
      url: path,
      headers: {
        host: "127.0.0.1:7331",
        origin: "http://127.0.0.1:7331",
        "sec-fetch-site": "same-origin",
        ...(cookie === null ? {} : { cookie }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf8");
      },
    } as unknown as IncomingMessage;
    const response = new ControlledResponse();
    handler.handle(incoming, response as never, "http://127.0.0.1:7331");
    await response.done(25_000);
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie !== undefined) cookie = setCookie.split(";", 1)[0]!;
    return { status: response.status, body: response.json(), raw: response.bodyText };
  };
  const bootstrap = async () => {
    const result = await call("POST", "/api/tavern/v1/bootstrap", {}, { apiVersion: 1, bootstrapToken: token });
    assert.equal(result.status, 200);
    csrf = (result.body as { csrfToken: string }).csrfToken;
  };
  try {
    await run(
      profilesPath,
      async (method, path, headers = {}, body) =>
        await call(method, path, { ...(csrf === null ? {} : { "x-csrf-token": csrf }), ...headers }, body),
      bootstrap,
    );
  } finally {
    await handler.close();
    await rm(root, { recursive: true, force: true });
  }
}

class ControlledResponse {
  status = 0;
  headers = new Map<string, string>();
  bodyText = "";
  private ended = false;
  private settle: (() => void) | null = null;

  async done(timeoutMs: number): Promise<void> {
    if (this.ended) return;
    await new Promise<void>((resolveDone, rejectDone) => {
      this.settle = resolveDone;
      setTimeout(() => {
        this.settle = null;
        rejectDone(new Error("controlled_response_never_ended"));
      }, timeoutMs).unref?.();
    });
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  writeHead(status: number, headers?: Record<string, string>): void {
    this.status = status;
    for (const [key, value] of Object.entries(headers ?? {})) this.headers.set(key, value);
  }
  end(body?: string): void {
    this.bodyText += body ?? "";
    if (this.ended) return;
    this.ended = true;
    this.settle?.();
    this.settle = null;
  }
  json(): unknown {
    try {
      return JSON.parse(this.bodyText);
    } catch {
      return undefined;
    }
  }
  get writableEnded(): boolean {
    return this.ended;
  }
  get destroyed(): boolean {
    return false;
  }
  get writableFinished(): boolean {
    return this.ended;
  }
  once(): void {}
  resume(): void {}
  setHeaderOut(): void {}
  get socket(): undefined {
    return undefined;
  }
}

type ProfilesBody = Readonly<{
  apiVersion: 1;
  chat: Readonly<{ revision: number; modelId: string; thinkingLevel: string }>;
  game: Readonly<{ revision: number; modelId: string; thinkingLevel: string }>;
  recommendedModels: readonly Readonly<{
    providerId: string;
    providerLabel: string;
    modelId: string;
    modelLabel: string;
    allowedThinkingLevels: readonly string[];
    defaultThinkingLevel: string;
  }>[];
}>;

test("the profiles read is a browser-session read of both surfaces plus the shipped guidance", async () => {
  await withHandler({}, async (_path, request, bootstrap) => {
    // Unauthenticated and cross-origin reads are refused before any store read.
    assert.equal((await request("GET", "/api/tavern/v1/settings/profiles")).status, 401);
    await bootstrap();
    const result = await request("GET", "/api/tavern/v1/settings/profiles");
    assert.equal(result.status, 200);
    const profiles = result.body as ProfilesBody;
    assert.equal(profiles.apiVersion, 1);
    assert.deepEqual(profiles.chat, { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" });
    assert.deepEqual(profiles.game, { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" });
    // The guidance list is derived from the one provider catalog, so it names the
    // shipped models without becoming the set of models a profile may hold.
    const shipped = TAVERN_PROVIDER_CATALOG.flatMap((provider) => provider.allowedPlayerModels.map((m) => m.modelId));
    assert.deepEqual(
      profiles.recommendedModels.map((model) => model.modelId),
      shipped,
    );
    assert.ok(shipped.includes("gpt-5.6-luna"));
    assert.equal(profiles.recommendedModels.every((model) => model.providerLabel.length > 0), true);
    // The projection carries no credential and no endpoint fact.
    for (const forbidden of ["apiKey", "key", "baseUrl", "endpoint", "token", "secret"]) {
      assert.equal(result.raw.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  });
});

test("a model id outside the shipped catalog round-trips through the authenticated update", async () => {
  await withHandler({}, async (profilesPath, request, bootstrap) => {
    // Cross-origin and missing-CSRF writes are refused before any store write.
    assert.equal(
      (
        await request("PUT", "/api/tavern/v1/settings/profiles", { "sec-fetch-site": "cross-site" }, {
          apiVersion: 1,
          surface: "game",
          expectedRevision: 0,
          modelId: "qwen2.5-coder:7b",
          thinkingLevel: "xhigh",
        })
      ).status,
      401,
    );
    await bootstrap();
    assert.equal(
      (
        await request("PUT", "/api/tavern/v1/settings/profiles", { "x-csrf-token": "" }, {
          apiVersion: 1,
          surface: "game",
          expectedRevision: 0,
          modelId: "qwen2.5-coder:7b",
          thinkingLevel: "xhigh",
        })
      ).status,
      403,
    );

    const localModelId = "qwen2.5-coder:7b";
    const updated = await request("PUT", "/api/tavern/v1/settings/profiles", {}, {
      apiVersion: 1,
      surface: "game",
      expectedRevision: 0,
      modelId: localModelId,
      thinkingLevel: "xhigh",
    });
    assert.equal(updated.status, 200);
    const profiles = updated.body as ProfilesBody;
    assert.equal(profiles.game.modelId, localModelId);
    assert.equal(profiles.game.thinkingLevel, "xhigh");
    assert.equal(profiles.game.revision, 1);
    // The other surface's durable revision must not move.
    assert.equal(profiles.chat.revision, 0);
    assert.equal(profiles.chat.modelId, "deepseek-v4-flash");

    // The durable file is the authority: a fresh store reads the exact value back.
    const reopened = await new ModelProfileStore(profilesPath).read("game");
    assert.equal(reopened.modelId, localModelId);
    assert.equal(reopened.thinkingLevel, "xhigh");
    assert.equal(reopened.revision, 1);

    // The read route projects the same durable fact after the write.
    const read = await request("GET", "/api/tavern/v1/settings/profiles");
    assert.equal((read.body as ProfilesBody).game.modelId, localModelId);
  });
});

test("a stale revision and a malformed model id are rejected without changing the profile", async () => {
  await withHandler({}, async (profilesPath, request, bootstrap) => {
    await bootstrap();
    const conflict = await request("PUT", "/api/tavern/v1/settings/profiles", {}, {
      apiVersion: 1,
      surface: "chat",
      expectedRevision: 7,
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as { code: string }).code, "settings_revision_conflict");

    const malformed = await request("PUT", "/api/tavern/v1/settings/profiles", {}, {
      apiVersion: 1,
      surface: "chat",
      expectedRevision: 0,
      modelId: "has space",
      thinkingLevel: "high",
    });
    assert.equal(malformed.status, 400);
    assert.equal((malformed.body as { code: string }).code, "invalid_request");

    assert.equal((await new ModelProfileStore(profilesPath).read("chat")).revision, 0);
  });
});

test("a profile that advertises no profile route answers 404 instead of inventing one", async () => {
  await withHandler({ profile: profileWithoutModelProfiles }, async (_path, request, bootstrap) => {
    await bootstrap();
    assert.equal((await request("GET", "/api/tavern/v1/settings/profiles")).status, 404);
    const write = await request("PUT", "/api/tavern/v1/settings/profiles", {}, {
      apiVersion: 1,
      surface: "chat",
      expectedRevision: 0,
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
    });
    assert.equal(write.status, 404);
    assert.equal((write.body as { code: string }).code, "profile_operation_unavailable");
  });
});

test("advertising a profile route without the Host store fails closed at construction", () => {
  assert.throws(
    () =>
      createTavernManagementDialogueWebRequestHandler({
        managementStateFacade: facade(),
        managementService,
        worldInfoService,
        playerPreferenceStore: playerPreferenceStore(tmpdir()),
        profile: profilesProfile,
        bootstrapToken: token,
      }),
    /tavern_management_composition_unavailable/,
  );
});
