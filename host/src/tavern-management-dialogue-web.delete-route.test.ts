/**
 * `companion.delete` through the real dispatcher, the real service and a real runtime root.
 *
 * The one irreversible operation on the Characters surface, and the shape every refusal is
 * proved in: the companion in play, a stale revision, an unknown handle, and a request
 * without the CSRF fact. The success case proves the deletion's actual scope on disk - her
 * artifact root and her authored files are gone, another companion is untouched, and her
 * `tavern.sqlite` (her conversations) is still there, because deleting her does not delete
 * what the player said to her.
 */
import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { identityKey, resolveRuntimePaths } from "./runtime-identity.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import { createChatThreadStore } from "./tavern/chat-thread-store.js";
import { createCompanionDeletionService } from "./tavern/companion-deletion-service.js";
import { provisionDirectNewCompanion } from "./tavern/new-companion-service.js";
import { resolveTavernPaths } from "./tavern/tavern-paths.js";
import {
  createTavernManagementDialogueWebRequestHandler,
  startTavernManagementDialogueWebServer,
} from "./tavern-management-dialogue-web.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const playerId = "player-companion-delete";

/** A handle shape the dispatcher's own segment matcher accepts (22..128 of the URL alphabet). */
const handleFor = (seed: string): string => `${seed}${"A".repeat(43 - seed.length)}`;

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

const DELETE_ROUTES = ["companion.delete"] as const;

const profile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...DELETE_ROUTES],
  operationIds: [...CORE_OPERATIONS, ...DELETE_ROUTES],
  navigationItemIds: ["chat", "characters"],
});

/** The core-only profile, which does NOT declare the route: the dispatcher must answer 404. */
const coreOnlyProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES],
  operationIds: [...CORE_OPERATIONS],
  navigationItemIds: ["chat", "characters"],
});

type Fixture = Readonly<{
  root: string;
  /** The companion in play: refused by name. */
  inPlay: Readonly<{ companionId: string; continuityId: string; handle: string; revision: number }>;
  /** The duplicate the player wants gone. */
  doomed: Readonly<{ companionId: string; continuityId: string; handle: string; revision: number }>;
  /** A third companion that must be untouched by the removal. */
  kept: Readonly<{ companionId: string; continuityId: string; handle: string; revision: number }>;
  resolve: (handle: string) => Promise<Readonly<{ companionId: string; continuityId: string }> | null>;
}>;

/**
 * Three real companions under one real runtime root, each with her own profile, record and
 * conversations. The fixture is the library as the roster enumerates it: every companion has
 * her own `companion.json`; the in-play one is additionally the deployment's mounted identity.
 */
async function fixture(): Promise<Fixture> {
  const root = await canonicalTestRoot("tavern-companion-delete-");
  const provision = async (name: string) => {
    const created = await provisionDirectNewCompanion(root, playerId, name);
    const identity = created.identity;
    // Her conversations: opening the store creates `tavern.sqlite` for her partition, which is
    // the durable record the removal must leave where it is. The store is rooted at the runtime
    // root exactly as the composition roots it (`createChatThreadStore(manifest.runtimeRoot, …)`).
    const threads = createChatThreadStore(root, identityKey(identity));
    await threads.listThreads?.();
    threads.close?.();
    return Object.freeze({
      companionId: identity.companionId,
      continuityId: identity.continuityId!,
      record: created.companion,
    });
  };
  const inPlay = await provision("In Play");
  const doomed = await provision("Doomed");
  const kept = await provision("Kept");
  const handleByCompanionId = new Map([
    [inPlay.companionId, handleFor("I")],
    [doomed.companionId, handleFor("D")],
    [kept.companionId, handleFor("K")],
  ]);
  return Object.freeze({
    root,
    inPlay: Object.freeze({
      companionId: inPlay.companionId,
      continuityId: inPlay.continuityId,
      handle: handleFor("I"),
      revision: inPlay.record.revision,
    }),
    doomed: Object.freeze({
      companionId: doomed.companionId,
      continuityId: doomed.continuityId,
      handle: handleFor("D"),
      revision: doomed.record.revision,
    }),
    kept: Object.freeze({
      companionId: kept.companionId,
      continuityId: kept.continuityId,
      handle: handleFor("K"),
      revision: kept.record.revision,
    }),
    async resolve(handle) {
      for (const entry of [inPlay, doomed, kept]) {
        if (handleByCompanionId.get(entry.companionId) !== handle) continue;
        return Object.freeze({ companionId: entry.companionId, continuityId: entry.continuityId });
      }
      return null;
    },
  });
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

function deletion(
  origin: string,
  handle: string,
  expectedRevision: number,
  session: Readonly<{ csrfToken: string; cookie: string }>,
  options: Readonly<{ csrf?: boolean; search?: string }> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Origin: origin,
    Cookie: session.cookie,
    "Content-Type": "application/json",
  };
  if (options.csrf !== false) headers["x-csrf-token"] = session.csrfToken;
  return fetch(`${origin}/api/tavern/v1/companions/${handle}${options.search ?? ""}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ apiVersion: 1, expectedRevision }),
  });
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

async function absent(path: string): Promise<boolean> {
  return await access(path).then(
    () => false,
    () => true,
  );
}

function managementOptions(input: {
  root: string;
  resolve: Fixture["resolve"];
  currentCompanionId: string;
  activeProfile: typeof profile;
}) {
  const service = createCompanionDeletionService({
    store: new TavernArtifactStore(input.root),
    runtimeRoot: input.root,
    playerId,
    currentCompanionId: input.currentCompanionId,
    resolveCompanion: input.resolve,
  });
  return {
    managementStateFacade: Object.freeze({
      read: async () => ({
        selection: { chatHandle: handleFor("C"), generation: 1, stateRevision: handleFor("C") },
        companionDisplayName: "In Play",
        companionHandle: handleFor("I"),
        title: "Farm Chat",
        transcript: [],
        draft: { revision: 0, text: null },
        turn: null,
        operations: [],
        worldInfo: null,
      }),
      close: async () => undefined,
    }),
    managementService: Object.freeze({
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
    }),
    worldInfoService: Object.freeze({
      async read() {
        return { state: "none" as const, revision: handleFor("W"), items: [] };
      },
      async setBinding() {
        return { state: "none" as const, revision: handleFor("W"), items: [] };
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
    }),
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
          paced: false,
        };
      },
      async update() {
        throw new Error("preference_update_not_used");
      },
    }),
    companionDeletionService: service,
    profile: input.activeProfile,
    bootstrapToken: token,
  };
}

test("companion.delete names every refusal and, on success, removes her record and her directory but not her conversations", async () => {
  const f = await fixture();
  const server = await startTavernManagementDialogueWebServer(
    managementOptions({
      root: f.root,
      resolve: f.resolve,
      currentCompanionId: f.inPlay.companionId,
      activeProfile: profile,
    }),
  );
  try {
    const origin = server.origin;
    const session = await bootstrap(origin);

    // 1. The companion in play is refused by name: her Chats ARE the mounted conversation.
    const inPlay = await deletion(origin, f.inPlay.handle, f.inPlay.revision, session);
    assert.equal(inPlay.status, 409);
    assert.equal(await codeOf(inPlay), "companion_delete_in_play");
    // And nothing about her was touched by the refusal.
    const inPlayRuntime = resolveRuntimePaths(
      { playerId, companionId: f.inPlay.companionId, continuityId: f.inPlay.continuityId },
      f.root,
    );
    assert.equal(await absent(inPlayRuntime.identityProfilePath), false);

    // 2. A stale revision is the bounded compare-and-set refusal, not a lost write.
    const stale = await deletion(origin, f.doomed.handle, f.doomed.revision + 7, session);
    assert.equal(stale.status, 409);
    assert.equal(await codeOf(stale), "companion_conflict");

    // 3. An unknown handle names nothing: 404 with its own code, never a silent success.
    const unknown = await deletion(origin, handleFor("Z"), 1, session);
    assert.equal(unknown.status, 404);
    assert.equal(await codeOf(unknown), "companion_not_found");

    // 4. No CSRF header: refused before the service runs, and she is still there.
    const noCsrf = await deletion(origin, f.doomed.handle, f.doomed.revision, session, { csrf: false });
    assert.equal(noCsrf.status, 403);
    assert.equal(await codeOf(noCsrf), "csrf_failed");

    // 5. The query string is not part of this route.
    const withQuery = await deletion(origin, f.doomed.handle, f.doomed.revision, session, { search: "?force=1" });
    assert.equal(withQuery.status, 400);
    assert.equal(await codeOf(withQuery), "invalid_request");

    const doomedRuntime = resolveRuntimePaths(
      { playerId, companionId: f.doomed.companionId, continuityId: f.doomed.continuityId },
      f.root,
    );
    const doomedTavern = resolveTavernPaths(doomedRuntime, {
      playerId,
      companionId: f.doomed.companionId,
      continuityId: f.doomed.continuityId,
    });
    const keptRuntime = resolveRuntimePaths(
      { playerId, companionId: f.kept.companionId, continuityId: f.kept.continuityId },
      f.root,
    );
    const keptTavern = resolveTavernPaths(keptRuntime, {
      playerId,
      companionId: f.kept.companionId,
      continuityId: f.kept.continuityId,
    });
    // Her conversations are the player's: the store the Chats live in is untouched.
    const doomedChatStore = join(
      f.root,
      "tavern",
      "v3",
      "continuities",
      identityKey({
        playerId,
        companionId: f.doomed.companionId,
        continuityId: f.doomed.continuityId,
      }),
      "tavern.sqlite",
    );
    assert.equal(await absent(doomedChatStore), false, "her conversation store is not part of the deletion unit");

    // 6. The real removal.
    const removed = await deletion(origin, f.doomed.handle, f.doomed.revision, session);
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.deepEqual(await removed.json(), { apiVersion: 1, handle: f.doomed.handle });

    // Her directory - record, picture, scenario, greetings, her own book - is gone whole.
    assert.equal(await absent(doomedTavern.companionRoot), true);
    // Her authored identity record is gone too: it is hers, and it is not under that root.
    assert.equal(await absent(doomedRuntime.identityProfilePath), true);
    assert.equal(await absent(doomedRuntime.identityProfileBindingPath), true);
    // What she said to the player is still on disk, untouched.
    assert.equal(await absent(doomedChatStore), false);

    // The companion in play and the third companion are exactly as they were.
    assert.equal(await absent(inPlayRuntime.identityProfilePath), false);
    assert.equal(await absent(inPlayTavernRoot(f.root, f.inPlay)), false);
    assert.equal(await absent(keptRuntime.identityProfilePath), false);
    assert.equal(await absent(keptTavern.companionRoot), false);
    assert.match(await readFile(join(keptTavern.companionRoot, "companion.json"), "utf8"), /Kept/u);
  } finally {
    await server.close();
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function inPlayTavernRoot(root: string, companion: Readonly<{ companionId: string; continuityId: string }>): string {
  const runtimePaths = resolveRuntimePaths(
    { playerId, companionId: companion.companionId, continuityId: companion.continuityId },
    root,
  );
  return resolveTavernPaths(runtimePaths, {
    playerId,
    companionId: companion.companionId,
    continuityId: companion.continuityId,
  }).companionRoot;
}

test("a profile that does not declare companion.delete answers 404 and deletes nothing", async () => {
  const f = await fixture();
  const server = await startTavernManagementDialogueWebServer(
    managementOptions({
      root: f.root,
      resolve: f.resolve,
      currentCompanionId: f.inPlay.companionId,
      activeProfile: coreOnlyProfile,
    }),
  );
  try {
    const origin = server.origin;
    const session = await bootstrap(origin);
    const refused = await deletion(origin, f.kept.handle, f.kept.revision, session);
    assert.equal(refused.status, 404);
    assert.equal(await codeOf(refused), "profile_operation_unavailable");
    const runtime = resolveRuntimePaths(
      { playerId, companionId: f.kept.companionId, continuityId: f.kept.continuityId },
      f.root,
    );
    assert.equal(await absent(runtime.identityProfilePath), false);
  } finally {
    await server.close();
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the handler fails closed when the profile advertises companion.delete but no service is bound", async () => {
  const options = { profile, bootstrapToken: token } as Parameters<
    typeof createTavernManagementDialogueWebRequestHandler
  >[0];
  assert.throws(
    () => createTavernManagementDialogueWebRequestHandler(options),
    /tavern_management_composition_unavailable/u,
  );
});
