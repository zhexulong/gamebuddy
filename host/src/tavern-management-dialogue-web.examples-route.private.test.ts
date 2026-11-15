/**
 * `character.examples.read` / `character.examples.update` through the real dispatcher and the real
 * save.
 *
 * Her example dialogues are a member of the mounted companion's durable identity profile - the
 * same record her performance directive lives in - so the pair is addressed and CASed exactly like
 * `character.voice.*`: the mounted companion's handle resolves, any other handle is a 404, a read
 * is a same-origin fetch and a save is a CSRF-bound write against the profile revision the browser
 * read.
 *
 * The failure this file holds down is the one the lane started from: a durable field that reaches
 * the prompt (`renderIdentityProfile` renders these rows under `[Dialogue Examples]`, and the Chat
 * system prompt is built from that rendering) with no writer anywhere. The prompt reading itself is
 * `companion-examples-service.test.ts`'s; this is the wire's own half.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
  createIdentityProfileBinding,
  DEFAULT_IDENTITY_PROFILE,
  readIdentityProfile,
  validateIdentityProfile,
  writeIdentityProfile,
  writeIdentityProfileBinding,
} from "./identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { identityKey, resolveRuntimePaths, type CompanionIdentity } from "./runtime-identity.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { type CompanionExamplesV1, composeTavernProfile } from "./tavern/browser-contract/index.js";
import { renderCompanionExamples, updateMountedCompanionExamples } from "./tavern/companion-examples-service.js";
import { macroTable } from "./tavern/macro-engine.js";
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
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const foreignHandle = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const profileRevision = 3;

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity-examples-route",
  companionId: "companion-examples-route",
  playerId: "player-examples-route",
});

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

const EXAMPLES_ROUTES = ["character.examples.read", "character.examples.update"] as const;

const profile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...EXAMPLES_ROUTES],
  operationIds: [...CORE_OPERATIONS, ...EXAMPLES_ROUTES],
  navigationItemIds: ["chat", "characters"],
});

/** The mounted companion's own rows, written where the composition reads them. */
async function seedProfile(root: string): Promise<{ profilePath: string; runtimeCwd: string }> {
  const paths = resolveRuntimePaths(identity, root, "surface-examples-route");
  const seeded = validateIdentityProfile({
    ...DEFAULT_IDENTITY_PROFILE,
    profileId: "gamebuddy.companion_examples_route",
    revision: profileRevision,
    identity: { ...DEFAULT_IDENTITY_PROFILE.identity, name: "Mira" },
    examples: [{ user: "{{user}} 回来了", companion: "{{char}} 在门口等。" }],
  });
  await writeIdentityProfile(paths.identityProfilePath, seeded, { containmentRoot: paths.root });
  await writeIdentityProfileBinding(
    paths.identityProfileBindingPath,
    createIdentityProfileBinding(identityKey(identity), seeded),
    { containmentRoot: paths.root },
  );
  return { profilePath: paths.identityProfilePath, runtimeCwd: paths.runtimeCwd };
}

/** The service the composition binds: the mounted handle only, exactly as the composition does it. */
function examplesServiceFor(root: string, seed: { profilePath: string; runtimeCwd: string }) {
  const macros = () => macroTable({ char: "Mira", locale: "zh-CN" });
  return Object.freeze({
    async read(candidate: string) {
      if (candidate !== handle) return null;
      const current = await readIdentityProfile(seed.profilePath);
      return Object.freeze({
        profileRevision: current.revision,
        examples: renderCompanionExamples(current, await macros()),
      });
    },
    async update(
      candidate: string,
      command: { expectedProfileRevision: number; examples: CompanionExamplesV1["examples"] },
    ) {
      if (candidate !== handle) return null;
      return await updateMountedCompanionExamples({
        identityProfilePath: seed.profilePath,
        runtimeCwd: seed.runtimeCwd,
        containmentRoot: root,
        identityKey: identityKey(identity),
        expectedProfileRevision: command.expectedProfileRevision,
        macros: await macros(),
        examples: command.examples,
        // Nothing pins this profile in a suite that mounts no Chat of hers: the re-pin is a
        // no-op, and `chat-thread-profile-repin.test.ts` is where the real one is measured.
        refreshThreadBindings: async () => 0,
      });
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

function callExamples(
  origin: string,
  candidate: string,
  session: Readonly<{ csrfToken: string; cookie: string }>,
  body: unknown | null,
  options: Readonly<{ method?: string; csrf?: boolean; search?: string; origin?: string }> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Origin: options.origin ?? origin,
    Cookie: session.cookie,
    "Content-Type": "application/json",
  };
  if (options.csrf !== false) headers["x-csrf-token"] = session.csrfToken;
  return fetch(`${origin}/api/tavern/v1/companions/${candidate}/examples${options.search ?? ""}`, {
    method: options.method ?? (body === null ? "GET" : "PUT"),
    headers,
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

/** The mounted management services the examples route does not use. */
function managementOptions(examplesService: ReturnType<typeof examplesServiceFor>) {
  return {
    managementStateFacade: Object.freeze({
      read: async () => ({
        selection: { chatHandle: handle, generation: 1, stateRevision: handle },
        companionDisplayName: "Mira",
        companionHandle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA",
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
        return { state: "none" as const, revision: handle, items: [] };
      },
      async setBinding() {
        return { state: "none" as const, revision: handle, items: [] };
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
          appearance: "system" as const,
        };
      },
      async update() {
        return {
          revision: 1,
          locale: null,
          disclosureVersion: null,
          consent: "revoked" as const,
          decidedAtMs: 1,
          outputDevice: null,
          persona: null,
          paced: false,
          gamePromptAddition: "",
          appearance: "system" as const,
        };
      },
    }),
    companionExamplesService: examplesService,
    profile,
    bootstrapToken: token,
  };
}

test("her example dialogues are read rendered and saved against the revision the browser read", async () => {
  const root = await canonicalTestRoot("tavern-examples-route-");
  const seed = await seedProfile(root);
  const server = await startTavernManagementDialogueWebServer(managementOptions(examplesServiceFor(root, seed)));
  try {
    const origin = server.origin;
    const session = await bootstrap(origin);

    // The read is what the surface paints: her author's `{{user}}`/`{{char}}` resolved, and the
    // profile revision the save must CAS on.
    const read = await callExamples(origin, handle, session, null);
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()) as CompanionExamplesV1, {
      apiVersion: 1,
      profileRevision,
      examples: [{ user: "你 回来了", companion: "Mira 在门口等。" }],
    });

    // The save sends back what the surface painted, with one row added. The reply is the Host's
    // own re-projection - advanced revision, rendered rows - not an echo of the request.
    const saved = await callExamples(origin, handle, session, {
      apiVersion: 1,
      expectedProfileRevision: profileRevision,
      examples: [
        { user: "你 回来了", companion: "Mira 在门口等。" },
        { user: "今天做什么？", companion: "先把水壶灌满。" },
      ],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()) as CompanionExamplesV1, {
      apiVersion: 1,
      profileRevision: profileRevision + 1,
      examples: [
        { user: "你 回来了", companion: "Mira 在门口等。" },
        { user: "今天做什么？", companion: "先把水壶灌满。" },
      ],
    });

    // Durable, and the untouched row is still the AUTHOR's: a save must not bake one run's
    // rendering into the record the card export writes back.
    const durable = await readIdentityProfile(seed.profilePath);
    assert.deepEqual(durable.examples, [
      { user: "{{user}} 回来了", companion: "{{char}} 在门口等。" },
      { user: "今天做什么？", companion: "先把水壶灌满。" },
    ]);

    // A save that names the revision it already replaced is the ordinary stale edit, refused by
    // name and writing nothing.
    const stale = await callExamples(origin, handle, session, {
      apiVersion: 1,
      expectedProfileRevision: profileRevision,
      examples: [{ user: "x", companion: "y" }],
    });
    assert.equal(stale.status, 409);
    assert.equal(await codeOf(stale), "character_examples_conflict");
    assert.deepEqual(await readIdentityProfile(seed.profilePath), durable);

    // A handle that names another companion resolves to nothing here: this pair addresses the
    // mounted companion's own record, and a foreign handle is never written.
    const foreignRead = await callExamples(origin, foreignHandle, session, null);
    assert.equal(foreignRead.status, 404);
    assert.equal(await codeOf(foreignRead), "companion_not_found");
    const foreignWrite = await callExamples(origin, foreignHandle, session, {
      apiVersion: 1,
      expectedProfileRevision: profileRevision + 1,
      examples: [],
    });
    assert.equal(foreignWrite.status, 404);
    assert.equal(await codeOf(foreignWrite), "companion_not_found");

    // The write discipline every management mutation carries.
    const noCsrf = await callExamples(
      origin,
      handle,
      session,
      { apiVersion: 1, expectedProfileRevision: profileRevision + 1, examples: [] },
      { csrf: false },
    );
    assert.equal(noCsrf.status, 403);
    assert.equal(await codeOf(noCsrf), "csrf_failed");
    const crossOrigin = await callExamples(
      origin,
      handle,
      session,
      { apiVersion: 1, expectedProfileRevision: profileRevision + 1, examples: [] },
      { origin: "http://127.0.0.1:1" },
    );
    assert.equal(crossOrigin.status, 401);
    assert.equal(await codeOf(crossOrigin), "unauthorized");
    const withQuery = await callExamples(origin, handle, session, null, { search: "?v=1" });
    assert.equal(withQuery.status, 400);
    assert.equal(await codeOf(withQuery), "invalid_request");
    // Only GET and PUT are this route's: a POST to the same path is no route at all.
    const posted = await callExamples(
      origin,
      handle,
      session,
      {
        apiVersion: 1,
        expectedProfileRevision: profileRevision + 1,
        examples: [],
      },
      { method: "POST" },
    );
    assert.equal(posted.status, 404);
    assert.deepEqual(await readIdentityProfile(seed.profilePath), durable);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the pair is absent when the profile does not declare it, and composition fails closed without it", async () => {
  const root = await canonicalTestRoot("tavern-examples-route-undeclared-");
  const seed = await seedProfile(root);
  const service = examplesServiceFor(root, seed);
  const server = await startTavernManagementDialogueWebServer({
    ...managementOptions(service),
    profile: composeTavernProfile({
      profileId: "gamebuddy.tavern-management.chat-list-title",
      releaseTier: "tavern_management",
      routeIds: [...CORE_ROUTES],
      operationIds: [...CORE_OPERATIONS],
      navigationItemIds: ["chat"],
    }),
  });
  try {
    const origin = server.origin;
    const session = await bootstrap(origin);
    const refused = await callExamples(origin, handle, session, null);
    assert.equal(refused.status, 404);
    assert.equal(await codeOf(refused), "profile_operation_unavailable");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }

  // A profile that advertises the routes without the bound service fails closed at composition,
  // so the surface is never shown an editor the Host cannot save.
  const { companionExamplesService, ...withoutExamples } = managementOptions(service);
  assert.equal(companionExamplesService, service);
  assert.throws(
    () => createTavernManagementDialogueWebRequestHandler({ ...withoutExamples, profile }),
    /tavern_management_composition_unavailable/,
  );
});
