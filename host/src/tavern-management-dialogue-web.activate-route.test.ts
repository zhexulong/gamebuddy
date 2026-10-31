/**
 * `companion.activate` through the real dispatcher, the real service and a real runtime root.
 *
 * The defect this route exists for: a companion created or imported from a card could never
 * become the one being played. The surface told the player that the companion in play is
 * chosen by the start-up configuration and that restarting with her would make her the one in
 * play - but nothing anywhere recorded a choice, so restarting ran the preset companion again,
 * forever. The route's whole job is to record that choice, which is why every assertion here is
 * about the exact durable file the launcher reads, or about a refusal that names why nothing
 * was recorded.
 *
 * What it deliberately does NOT do is switch. The companion in play is the deployment
 * identity's `companionId`, the semantic authority binds its database to that one principal,
 * and `desktop/GameBuddy.Desktop/DeploymentIdentity.cs` is that identity's one authority - so
 * the launcher parks the authority root that is in play, brings the chosen companion's back,
 * and replaces the record. A route that answered anything but `recorded` would be claiming an
 * operation this Host cannot perform.
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { createCompanionActivationService } from "./tavern/companion-activation-service.js";
import { companionSwitchRequestPath } from "./tavern/companion-switch-request.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import { provisionDirectNewCompanion } from "./tavern/new-companion-service.js";
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
const playerId = "player-companion-activate";
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
const ACTIVATE_ROUTES = ["companion.activate"] as const;

const profile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...ACTIVATE_ROUTES],
  operationIds: [...CORE_OPERATIONS, ...ACTIVATE_ROUTES],
  navigationItemIds: ["chat", "characters"],
});
const coreOnlyProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES],
  operationIds: [...CORE_OPERATIONS],
  navigationItemIds: ["chat", "characters"],
});

type Fixture = Readonly<{
  root: string;
  inPlay: Readonly<{ companionId: string; continuityId: string }>;
  archived: Readonly<{ companionId: string; continuityId: string; handle: string }>;
  resolve: (
    handle: string,
  ) => Promise<Readonly<{ companionId: string; continuityId: string; name: string | null }> | null>;
}>;

/** Two real companions under one real runtime root: the one in play and the one to choose. */
async function fixture(): Promise<Fixture> {
  const root = await canonicalTestRoot("tavern-companion-activate-");
  const inPlay = await provisionDirectNewCompanion(root, playerId, "In Play");
  const archived = await provisionDirectNewCompanion(root, playerId, "Nova");
  const handleByCompanionId = new Map([
    [inPlay.identity.companionId, handleFor("I")],
    [archived.identity.companionId, handleFor("N")],
  ]);
  return Object.freeze({
    root,
    inPlay: Object.freeze({ companionId: inPlay.identity.companionId, continuityId: inPlay.identity.continuityId! }),
    archived: Object.freeze({
      companionId: archived.identity.companionId,
      continuityId: archived.identity.continuityId!,
      handle: handleFor("N"),
    }),
    async resolve(handle) {
      for (const entry of [inPlay.identity, archived.identity]) {
        if (handleByCompanionId.get(entry.companionId) !== handle) continue;
        return Object.freeze({
          companionId: entry.companionId,
          continuityId: entry.continuityId!,
          name: entry.companionId === inPlay.identity.companionId ? "In Play" : "Nova",
        });
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

function activation(
  origin: string,
  handle: string,
  session: Readonly<{ csrfToken: string; cookie: string }>,
  options: Readonly<{ csrf?: boolean; search?: string; method?: string }> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Origin: origin,
    Cookie: session.cookie,
    "Content-Type": "application/json",
  };
  if (options.csrf !== false) headers["x-csrf-token"] = session.csrfToken;
  return fetch(`${origin}/api/tavern/v1/companions/${handle}/activate${options.search ?? ""}`, {
    method: options.method ?? "POST",
    headers,
    // A GET carries no body by construction; the route is a POST, so this only ever proves the
    // method is refused rather than that a malformed body was.
    ...(options.method === "GET" ? {} : { body: JSON.stringify({ apiVersion: 1 }) }),
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
  activeProfile: typeof profile | typeof coreOnlyProfile;
  readGameState?: (context: { csrfToken: string; browserSessionExpiresAtMs: number }) => Promise<any>;
}) {
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
          gamePromptAddition: "",
        };
      },
      async update() {
        throw new Error("preference_update_not_used");
      },
    }),
    companionActivationService: createCompanionActivationService({
      runtimeRoot: input.root,
      currentCompanionId: input.currentCompanionId,
      resolveCompanion: input.resolve,
      gameAuthorityPresent: input.readGameState !== undefined,
    }),
    ...(input.readGameState === undefined ? {} : { readGameState: input.readGameState }),
    profile: input.activeProfile,
    bootstrapToken: token,
  };
}

test("companion.activate records the choice for the launcher and names every refusal", async () => {
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
    const requestPath = companionSwitchRequestPath(f.root);

    // 1. A companion already in play is not a switch, and nothing is recorded for her.
    const alreadyInPlay = await activation(origin, handleFor("I"), session);
    assert.equal(alreadyInPlay.status, 409);
    assert.equal(await codeOf(alreadyInPlay), "companion_switch_already_in_play");
    assert.equal(await absent(requestPath), true);

    // 2. An unknown handle names nothing this mount projected: 404, and still nothing written.
    const unknown = await activation(origin, handleFor("Z"), session);
    assert.equal(unknown.status, 404);
    assert.equal(await codeOf(unknown), "companion_not_found");
    assert.equal(await absent(requestPath), true);

    // 3. No CSRF header: refused before the service runs.
    const noCsrf = await activation(origin, f.archived.handle, session, { csrf: false });
    assert.equal(noCsrf.status, 403);
    assert.equal(await codeOf(noCsrf), "csrf_failed");
    assert.equal(await absent(requestPath), true);

    // 4. Neither a query string nor a GET belongs to this route.
    const withQuery = await activation(origin, f.archived.handle, session, { search: "?force=1" });
    assert.equal(withQuery.status, 400);
    const wrongMethod = await activation(origin, f.archived.handle, session, { method: "GET" });
    assert.notEqual(wrongMethod.status, 200);
    assert.equal(await absent(requestPath), true);

    // 5. The success case: the exact file the launcher reads, carrying the choice and the
    //    compare-and-set the surface read.
    const recorded = await activation(origin, f.archived.handle, session);
    assert.equal(recorded.status, 200);
    const body = (await recorded.json()) as { apiVersion: number; handle: string; status: string };
    assert.deepEqual(body, { apiVersion: 1, handle: f.archived.handle, status: "recorded" });

    const written = JSON.parse(await readFile(requestPath, "utf8")) as Record<string, unknown>;
    assert.equal(written.expectedActiveCompanionId, f.inPlay.companionId);
    assert.equal(written.targetCompanionId, f.archived.companionId);
    assert.equal(written.targetContinuityId, f.archived.continuityId);
  } finally {
    await server.close();
  }
});

test("a running game refuses the switch by name, and the player is told to stop it first", async () => {
  const f = await fixture();
  const gameState = (overrides: Record<string, unknown>) => async () => ({
    apiVersion: 1,
    build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
    csrfToken: "csrf",
    browserSession: { expiresAtMs: 1 },
    game: {
      prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
      instance: { status: "none", gameTitle: null, generation: 0 },
      compatibility: { status: "unchecked", message: null },
      attachment: { status: "none", generation: 0 },
      connectionStatus: "none",
      actionAuthority: "unavailable",
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: { available: false, count: 0 },
      latestOutcome: "none",
      ...overrides,
    },
  });
  const server = await startTavernManagementDialogueWebServer(
    managementOptions({
      root: f.root,
      resolve: f.resolve,
      currentCompanionId: f.inPlay.companionId,
      activeProfile: profile,
      readGameState: gameState({ instance: { status: "running", gameTitle: "Stardew Valley", generation: 1 } }),
    }),
  );
  try {
    const origin = server.origin;
    const session = await bootstrap(origin);
    const refused = await activation(origin, f.archived.handle, session);
    assert.equal(refused.status, 409);
    assert.equal(await codeOf(refused), "companion_switch_requires_no_session");
    // The refusal recorded nothing: a request left behind would switch her at the next launch,
    // which is the opposite of what the player was told.
    assert.equal(await absent(companionSwitchRequestPath(f.root)), true);
  } finally {
    await server.close();
  }
});

test("a mount whose profile does not declare the route answers 404 rather than recording a hidden switch", async () => {
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
    const refused = await activation(origin, f.archived.handle, session);
    assert.equal(refused.status, 404);
    assert.equal(await codeOf(refused), "profile_operation_unavailable");
    assert.equal(await absent(companionSwitchRequestPath(f.root)), true);
  } finally {
    await server.close();
  }
});
