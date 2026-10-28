import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  PlayerPreferenceRevisionConflict,
  type PlayerPreference,
  type PlayerPreferenceUpdate,
} from "./settings/player-preference-store.js";
import {
  composeTavernProfile,
  type MemoryMutationCommandV1,
  type MemoryReadV1,
  TavernBrowserValidatorsV1,
  type WorldInfoStateV1,
} from "./tavern/browser-contract/index.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import { projectRenderedCompanionWorldBook, updateCompanionWorldBook } from "./tavern/companion-world-book-service.js";
import { createGreetingManagementService } from "./tavern/greeting-management/greeting-management.js";
import { createPersonaManagementService } from "./tavern/persona-management/persona-management.js";
import {
  createScenarioManagementService,
  withScenarioSurfaceMacros,
} from "./tavern/scenario-management/scenario-management.js";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import { exportCompanionCard, type CompanionCardFormat } from "./tavern/companion-card-export.js";
import type { CompanionCardExportResult } from "./tavern/companion-card-export-service.js";
import { writeCompanionCardPng } from "./tavern/png-card-writer.js";
import { pngPictureFile } from "./test-support/png-card.test-support.js";
import { decodeStCard } from "./st-card-import.js";
import { macroTable } from "./tavern/macro-engine.js";
import { readWorldBook, validateWorldBook, writeWorldBook } from "./worldbook.js";
import type { MemoryManagementService } from "./tavern/memory-management/memory-management.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type { PublicWorldInfoProjection } from "./tavern/world-info-management/world-info-management.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import {
  createTavernManagementDialogueWebRequestHandler,
  MAX_BODY_BYTES,
  startTavernManagementDialogueWebServer,
} from "./tavern-management-dialogue-web.js";

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const maxDraftText = "a".repeat(16_384);
const profile = composeTavernProfile({
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
    "settings.voice.devices",
  ],
  operationIds: [
    "draft.save",
    "draft.discard",
    "chat.rename",
    "world-info.bind",
    "settings.voice.read",
    "settings.voice.consent",
    "settings.voice.devices",
  ],
  navigationItemIds: ["chat"],
});

/**
 * The same management profile plus the World Info authoring group. All four of its
 * routes sit on one path and are declared last, in the dispatcher's own canonical
 * group order, so this profile is a legal capability slice.
 */
const worldInfoAuthoringProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...profile.routeIds, "world-info.detail", "world-info.create", "world-info.update", "world-info.delete"],
  operationIds: [
    ...profile.operationIds,
    "world-info.detail",
    "world-info.create",
    "world-info.update",
    "world-info.delete",
  ],
  navigationItemIds: ["chat"],
});

const state: TavernManagementState = {
  selection: {
    chatHandle: handle,
    generation: 1,
    stateRevision: handle,
  },
  companionDisplayName: "Mira",
  companionHandle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA",
  title: "Farm Chat",
  transcript: [],
  draft: { revision: 0, text: null },
  turn: null,
  operations: [
    {
      operationId: "draft.save",
      labelKey: "tavern.operation.draft.save",
      availability: "available",
      routeId: "draft.save",
    },
    {
      operationId: "draft.discard",
      labelKey: "tavern.operation.draft.discard",
      availability: "available",
      routeId: "draft.discard",
    },
    {
      operationId: "chat.rename",
      labelKey: "tavern.operation.rename",
      availability: "available",
      routeId: "chat.rename",
    },
  ],
  worldInfo: null,
};
const facade: TavernManagementStateFacade = Object.freeze({
  read: async () => state,
  close: async () => undefined,
});
const list: import("./tavern/browser-contract/index.js").ChatListV1 = {
  apiVersion: 1,
  chats: [
    {
      handle,
      title: "Farm Chat",
      status: "active",
      managementRevision: 1,
      isSelected: true,
      updatedAtMs: 1_760_000_000_000,
      preview: "The parsnips took. All of them, by the look of it.",
    },
  ],
};
const renameResult: import("./tavern/browser-contract/index.js").ChatTitleV1 = {
  apiVersion: 1,
  title: "New Farm Chat",
  managementRevision: 2,
};

/** Memory-read profile used by tests that exercise the memory.read route. */
const memoryProfile = composeTavernProfile({
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
    "memory.read",
    "memory.mutate",
    "world-info.read",
    "world-info.bind",
    "settings.voice.read",
    "settings.voice.consent",
  ],
  operationIds: [
    "draft.save",
    "draft.discard",
    "chat.rename",
    "memory.mutate",
    "world-info.bind",
    "settings.voice.read",
    "settings.voice.consent",
  ],
  navigationItemIds: ["chat", "memory"],
});

const memoryReadStub: MemoryReadV1 = Object.freeze({
  apiVersion: 1,
  projectionRevision: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  chapters: Object.freeze([]),
  memories: Object.freeze([
    Object.freeze({
      handle: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
      title: "Semantic memory",
      content: "Visible player memory",
      category: "semantic",
      status: "active",
      origin: "companion",
      pinned: false,
    }),
  ]),
});

function memoryService(recorder?: { reads: number; mutations: MemoryMutationCommandV1[] }): MemoryManagementService {
  return Object.freeze({
    async read() {
      if (recorder !== undefined) recorder.reads += 1;
      return memoryReadStub;
    },
    async mutate(command: MemoryMutationCommandV1) {
      recorder?.mutations.push(command);
      return memoryReadStub;
    },
    async close() {
      // no-op
    },
  });
}

/** Safe World Info fixture: opaque handles only, no durable fact is expressible. */
const worldInfoState: WorldInfoStateV1 = {
  state: "none",
  revision: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  items: [
    {
      handle: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
      title: "Pelican Town",
      summary: "The valley hub.",
      selected: false,
      pending: false,
    },
  ],
};

/** One library item's own content, as the authoring read route projects it. */
const worldInfoItem: PublicWorldInfoProjection = {
  revision: 1,
  publicTitle: "Pelican Town",
  summary: "The revised town facts.",
  entries: [{ scope: "setting", publicTitle: "Square", summary: "Town center." }],
};

function worldInfoService(recorder?: {
  reads?: number;
  sets?: number;
  closes?: number;
  readError?: Error | undefined;
  setError?: Error | undefined;
  details?: number;
  creates?: number;
  updates?: number;
  deletes?: number;
  detailResult?: PublicWorldInfoProjection | null | undefined;
  createError?: Error | undefined;
  updateError?: Error | undefined;
  deleteError?: Error | undefined;
}): WorldInfoBindingManagementService {
  const counters = recorder ?? { reads: 0, sets: 0, closes: 0 };
  return Object.freeze({
    async read() {
      counters.reads = (counters.reads ?? 0) + 1;
      if (counters.readError !== undefined) throw counters.readError;
      return worldInfoState;
    },
    async setBinding() {
      counters.sets = (counters.sets ?? 0) + 1;
      if (counters.setError !== undefined) throw counters.setError;
      return worldInfoState;
    },
    /** The item's own content, or `null` when the caller set it to the "no longer listed" answer. */
    async detail() {
      counters.details = (counters.details ?? 0) + 1;
      return counters.detailResult === undefined ? worldInfoItem : counters.detailResult;
    },
    async create() {
      counters.creates = (counters.creates ?? 0) + 1;
      if (counters.createError !== undefined) throw counters.createError;
      return worldInfoState;
    },
    async update() {
      counters.updates = (counters.updates ?? 0) + 1;
      if (counters.updateError !== undefined) throw counters.updateError;
      return worldInfoState;
    },
    async delete() {
      counters.deletes = (counters.deletes ?? 0) + 1;
      if (counters.deleteError !== undefined) throw counters.deleteError;
      return worldInfoState;
    },
    async close() {
      counters.closes = (counters.closes ?? 0) + 1;
    },
  });
}

const voicePreferenceStore = Object.freeze({
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
  async update(expectedRevision: number, update: PlayerPreferenceUpdate) {
    assert.equal(expectedRevision, 0);
    return {
      revision: 1,
      locale: null,
      disclosureVersion: update.action === "accept" ? update.disclosureVersion : null,
      consent: update.action === "accept" ? ("accepted" as const) : ("revoked" as const),
      decidedAtMs: 1,
      outputDevice: update.action === "setOutputDevice" ? update.outputDevice : null,
      persona: update.action === "setPersona" ? update.persona : null,
      paced: update.action === "setPaced" ? update.paced : false,
      gamePromptAddition: update.action === "setGamePromptAddition" ? update.addition : "",
    };
  },
});

function service(recorder: {
  lists: number;
  renames: number;
  draftReads: number;
  draftSaves: number;
  draftDiscards: number;
  closes: number;
  renameError?: Error | undefined;
  draftError?: Error | undefined;
}): ChatManagementService {
  return Object.freeze({
    async readDraft() {
      recorder.draftReads += 1;
      if (recorder.draftError !== undefined) throw recorder.draftError;
      return { apiVersion: 1 as const, revision: state.draft.revision, text: state.draft.text };
    },
    async saveDraft(command) {
      recorder.draftSaves += 1;
      if (recorder.draftError !== undefined) throw recorder.draftError;
      return { apiVersion: 1 as const, revision: command.expectedRevision + 1, text: command.text };
    },
    async discardDraft(command) {
      recorder.draftDiscards += 1;
      if (recorder.draftError !== undefined) throw recorder.draftError;
      return { apiVersion: 1 as const, revision: command.expectedRevision + 1, text: null };
    },
    async listChats(query) {
      recorder.lists += 1;
      assert.equal(query.apiVersion, 1);
      return list;
    },
    async renameChatTitle(command) {
      recorder.renames += 1;
      if (recorder.renameError !== undefined) throw recorder.renameError;
      assert.equal(command.title, "New Farm Chat");
      return renameResult;
    },
    async transitionLifecycle() {
      throw new Error("chat_retention_route_not_mounted");
    },
    async commitOpeningVariant() {
      throw new Error("chat_opening_route_not_mounted");
    },
    async close() {
      recorder.closes += 1;
    },
  });
}

test("management handler exposes the draft-capable profile and CSRF-protected mutations", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(),
    profile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);
    const snapshot = (await bootstrap.json()) as {
      csrfToken: string;
      build: { profileId: string };
      operations: unknown[];
      selection: unknown;
    };
    assert.equal(snapshot.build.profileId, "gamebuddy.tavern-management.chat-list-title");
    assert.deepEqual(snapshot.operations, state.operations);
    assert.deepEqual(snapshot.selection, state.selection);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;

    const chats = await fetch(`${origin}/api/tavern/v1/chats?apiVersion=1&state=active`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(chats.status, 200);
    assert.deepEqual(await chats.json(), list);
    assert.equal(recorder.lists, 1);

    const draftRead = await fetch(`${origin}/api/tavern/v1/draft`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(draftRead.status, 200);
    assert.deepEqual(await draftRead.json(), { apiVersion: 1, revision: 0, text: null });

    const draftSave = await fetch(`${origin}/api/tavern/v1/draft`, {
      method: "PUT",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
      },
      body: JSON.stringify({
        apiVersion: 1,
        selectionGeneration: 1,
        expectedRevision: 0,
        text: maxDraftText,
      }),
    });
    assert.equal(draftSave.status, 200);
    assert.deepEqual(await draftSave.json(), { apiVersion: 1, revision: 1, text: maxDraftText });

    const draftDiscard = await fetch(`${origin}/api/tavern/v1/draft`, {
      method: "DELETE",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, expectedRevision: 1 }),
    });
    assert.equal(draftDiscard.status, 200);
    assert.deepEqual(await draftDiscard.json(), { apiVersion: 1, revision: 2, text: null });
    assert.equal(recorder.draftReads, 1);
    assert.equal(recorder.draftSaves, 1);
    assert.equal(recorder.draftDiscards, 1);

    const rename = await fetch(`${origin}/api/tavern/v1/chat/title`, {
      method: "PUT",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
      },
      body: JSON.stringify({
        apiVersion: 1,
        chatHandle: handle,
        expectedManagementRevision: 1,
        title: "New Farm Chat",
      }),
    });
    assert.equal(rename.status, 200);
    assert.deepEqual(await rename.json(), renameResult);
    assert.equal(recorder.renames, 1);

    // The frozen reference routes are absent from the management profile.
    for (const path of [
      "/api/tavern/v1/messages",
      "/api/tavern/v1/message-submission-status",
      "/api/tavern/v1/events",
    ]) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 404);
    }
  } finally {
    await server.close();
  }
  assert.equal(recorder.closes, 1);
});

test("management handler maps a missing target, a foreign binding and a stale revision to bounded problem semantics", async () => {
  const recorder = {
    lists: 0,
    renames: 0,
    draftReads: 0,
    draftSaves: 0,
    draftDiscards: 0,
    closes: 0,
    renameError: undefined as Error | undefined,
  };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(),
    profile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const rename = (overrides: Record<string, unknown>) =>
    request(
      "PUT",
      "/api/tavern/v1/chat/title",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      {
        apiVersion: 1,
        chatHandle: handle,
        expectedManagementRevision: 1,
        title: "New Farm Chat",
        ...overrides,
      },
    );
  const problemFor = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    assert.equal(output.status, 409);
    return (JSON.parse(output.body) as { code: string }).code;
  };

  recorder.renameError = new Error("chat_management_selection_conflict");
  assert.equal(await problemFor(rename({ chatHandle: `${"A".repeat(42)}E` })), "selection_conflict");
  // The mounted-only selection generation is gone from the command: a stale sender that still carries
  // it is refused 400 rather than accepted as a second, ignored selector.
  recorder.renameError = undefined;
  const staleField = new ControlledResponse("finish");
  await dispatch(handler, rename({ selectionGeneration: 99 }), staleField);
  assert.equal(staleField.status, 400);
  assert.equal((JSON.parse(staleField.body) as { code: string }).code, "invalid_request");
  // A handle that names no Chat of this partition is a bounded 404, not a selection conflict about a
  // selection the request never made.
  recorder.renameError = new Error("chat_not_found");
  const unknownTarget = new ControlledResponse("finish");
  await dispatch(handler, rename({ chatHandle: `${"A".repeat(42)}E` }), unknownTarget);
  assert.equal(unknownTarget.status, 404);
  assert.equal((JSON.parse(unknownTarget.body) as { code: string }).code, "chat_not_found");
  recorder.renameError = new Error("chat_management_revision_conflict");
  assert.equal(await problemFor(rename({ expectedManagementRevision: 7 })), "draft_conflict");
  await handler.close();
});

test("management handler enforces session, CSRF, origin and exact query/body validation", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(),
    profile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;

  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return { status: output.status, body: output.body };
  };

  // Chat list requires the browser session cookie and exact query shape.
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/chats?apiVersion=1", { "sec-fetch-site": "same-origin" }))).status,
    401,
  );
  assert.equal(
    (
      await run(
        request("GET", "/api/tavern/v1/chats?apiVersion=1&invented=1", { cookie, "sec-fetch-site": "same-origin" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await run(
        request("GET", "/api/tavern/v1/chats?apiVersion=1&apiVersion=2", { cookie, "sec-fetch-site": "same-origin" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/chats?apiVersion=1", { cookie, "sec-fetch-site": "same-origin" })))
      .status,
    200,
  );

  // Rename requires origin, session, CSRF and a valid command.
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/chat/title",
          { cookie, "x-csrf-token": csrf },
          {
            apiVersion: 1,
            chatHandle: handle,
            expectedManagementRevision: 1,
            title: "New Farm Chat",
          },
        ),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/chat/title",
          { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": "B".repeat(43) },
          {
            apiVersion: 1,
            chatHandle: handle,
            expectedManagementRevision: 1,
            title: "New Farm Chat",
          },
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/chat/title",
          { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
          { apiVersion: 1, chatHandle: handle, expectedManagementRevision: 1 },
        ),
      )
    ).status,
    400,
  );
  assert.equal(recorder.renames, 0);
  await handler.close();
});

test("management handler rejects the frozen reference profile before binding a listener", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const referenceProfile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.submission_status"],
    operationIds: ["chat.submit"],
    navigationItemIds: ["chat"],
  });
  await assert.rejects(
    startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: service(recorder),
      profile: referenceProfile,
      bootstrapToken: token,
    }),
    /tavern_management_profile_operation_unavailable/,
  );
});

test("management handler rejects a structural clone of the composed profile before dispatch", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  // Exact management fields and the same frozen own-shape, but never branded
  // by composeTavernProfile's WeakSet: the HTTP ingress must fail closed here,
  // before any dispatch or injected-service use, never only when a route
  // happens to admit work.
  const structuralClone = Object.freeze({ ...profile }) as typeof profile;
  assert.throws(
    () =>
      createTavernManagementDialogueWebRequestHandler({
        managementStateFacade: facade,
        managementService: service(recorder),
        worldInfoService: worldInfoService(),
        profile: structuralClone,
        bootstrapToken: token,
      }),
    /tavern_management_profile_operation_unavailable/,
  );
  assert.equal(recorder.closes, 0);
});

test("management handler serves memory.read as a same-origin browser session read and projects read availability", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: service(recorder),
    memoryService: memoryService(),
    worldInfoService: worldInfoService(),
    profile: memoryProfile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);
    const snapshot = (await bootstrap.json()) as {
      memory: unknown;
      csrfToken: string;
      navigation: ReadonlyArray<Readonly<{ itemId: string; availability: string }>>;
    };
    assert.deepEqual(snapshot.memory, {
      readAvailable: true,
      mutationAvailable: true,
      projectionRevision: memoryReadStub.projectionRevision,
    });
    // The mounted Memory route with a live read projects the Memory navigation
    // item as available alongside Chat.
    assert.deepEqual(snapshot.navigation, [
      { itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" },
      { itemId: "memory", labelKey: "tavern.nav.memory", availability: "available" },
    ]);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;

    const memory = await fetch(`${origin}/api/tavern/v1/memory`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(memory.status, 200);
    assert.deepEqual(await memory.json(), memoryReadStub);
    assert.equal(TavernBrowserValidatorsV1.MemoryReadV1Schema.Check(memoryReadStub), true);

    const mutation = await fetch(`${origin}/api/tavern/v1/memory`, {
      method: "PUT",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
      },
      body: JSON.stringify({
        apiVersion: 1,
        operation: "update",
        expectedProjectionRevision: memoryReadStub.projectionRevision,
        handle: memoryReadStub.memories[0]!.handle,
        content: "Updated player memory",
      }),
    });
    assert.equal(mutation.status, 200);
    assert.deepEqual(await mutation.json(), memoryReadStub);

    const stateRead = await fetch(`${origin}/api/tavern/v1/state`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(stateRead.status, 200);
    const state = (await stateRead.json()) as { memory: unknown };
    assert.deepEqual(state.memory, {
      readAvailable: true,
      mutationAvailable: true,
      projectionRevision: memoryReadStub.projectionRevision,
    });
  } finally {
    await server.close();
  }
  assert.equal(recorder.closes, 1);
});

test("management handler fails closed when the profile advertises memory.read without a bounded memory service", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  await assert.rejects(
    startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: service(recorder),
      worldInfoService: worldInfoService(),
      profile: memoryProfile,
      playerPreferenceStore: voicePreferenceStore,
      bootstrapToken: token,
    }),
    /tavern_management_composition_unavailable/,
  );
});

test("management handler does not activate an injected memory service when the profile omits memory.read", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const memoryRecorder = { reads: 0, closes: 0 };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    memoryService: Object.freeze({
      async read() {
        memoryRecorder.reads += 1;
        return memoryReadStub;
      },
      async close() {
        memoryRecorder.closes += 1;
      },
    }),
    worldInfoService: worldInfoService(),
    profile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  assert.equal(memoryRecorder.reads, 0);
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const output = new ControlledResponse("finish");
  await dispatch(handler, request("GET", "/api/tavern/v1/memory", { cookie, "sec-fetch-site": "same-origin" }), output);
  assert.equal(output.status, 404);
  assert.equal(memoryRecorder.reads, 0);
  await handler.close();
  assert.equal(memoryRecorder.closes, 1);
});

test("management handler closes each service at most once", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const memoryRecorder = { closes: 0 };
  const worldInfoRecorder = { closes: 0 };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    memoryService: Object.freeze({
      async read() {
        return memoryReadStub;
      },
      async close() {
        memoryRecorder.closes += 1;
      },
    }),
    worldInfoService: worldInfoService(worldInfoRecorder),
    profile: memoryProfile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  await Promise.all([handler.close(), handler.close()]);
  await handler.close();
  assert.equal(recorder.closes, 1);
  assert.equal(memoryRecorder.closes, 1);
  assert.equal(worldInfoRecorder.closes, 1);
});

test("management handler rejects Memory mutation before service work for missing session, origin, CSRF, and malformed commands", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const memoryRecorder = { reads: 0, mutations: [] as MemoryMutationCommandV1[] };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    memoryService: memoryService(memoryRecorder),
    worldInfoService: worldInfoService(),
    profile: memoryProfile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const command: MemoryMutationCommandV1 = {
    apiVersion: 1,
    operation: "archive",
    expectedProjectionRevision: memoryReadStub.projectionRevision,
    handle: memoryReadStub.memories[0]!.handle,
  };
  const run = async (headers: Record<string, string>, body: unknown = command) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, request("PUT", "/api/tavern/v1/memory", headers, body), output);
    return output.status;
  };
  assert.equal(await run({ cookie, "x-csrf-token": csrf }), 401);
  assert.equal(await run({ origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": "B".repeat(43) }), 403);
  assert.equal(
    await run({ origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf }, { ...command, extra: true }),
    400,
  );
  assert.equal(
    await run(
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      { ...command, expectedProjectionRevision: "not-a-canonical-memory-revision" },
    ),
    400,
  );
  assert.equal(memoryRecorder.mutations.length, 0);
  assert.equal(await run({ origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf }), 200);
  assert.deepEqual(memoryRecorder.mutations, [command]);
  await handler.close();
});

test("management handler rejects memory.read requests without the browser session and with a different origin read", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    memoryService: memoryService(),
    worldInfoService: worldInfoService(),
    profile: memoryProfile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;

  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return { status: output.status, body: output.body };
  };

  // No session cookie: rejected as unauthorized.
  assert.equal((await run(request("GET", "/api/tavern/v1/memory", { "sec-fetch-site": "same-origin" }))).status, 401);
  // Foreign origin performs a non-safe cross-site fetch: rejected.
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/memory", { origin: "http://evil.example", cookie }))).status,
    401,
  );
  // Query string is not part of the frozen memory.read route.
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/memory?apiVersion=1", { cookie, "sec-fetch-site": "same-origin" })))
      .status,
    400,
  );
  // Body is not allowed on the read route.
  assert.equal(
    (
      await run(
        request("GET", "/api/tavern/v1/memory", { cookie, "sec-fetch-site": "same-origin", "content-length": "2" }, {}),
      )
    ).status,
    400,
  );
  // Exact browser session read succeeds.
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/memory", { cookie, "sec-fetch-site": "same-origin" }))).status,
    200,
  );
  await handler.close();
});

test("management handler maps a Memory projection conflict to a safe 409 without stale read-back", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const conflictingMemory: MemoryManagementService = Object.freeze({
    async read() {
      return memoryReadStub;
    },
    async mutate() {
      throw new Error("memory_projection_conflict");
    },
    async close() {
      // no-op
    },
  });
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    memoryService: conflictingMemory,
    worldInfoService: worldInfoService(),
    profile: memoryProfile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const output = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "PUT",
      "/api/tavern/v1/memory",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      {
        apiVersion: 1,
        operation: "archive",
        expectedProjectionRevision: memoryReadStub.projectionRevision,
        handle: memoryReadStub.memories[0]!.handle,
      },
    ),
    output,
  );
  assert.equal(output.status, 409);
  assert.equal((JSON.parse(output.body) as { code: string }).code, "state_reconciliation_required");
  await handler.close();
});

test("management handler maps memory storage failures to the storage problem code on the read route", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const failingMemory: MemoryManagementService = Object.freeze({
    async read() {
      throw new Error("sqlite: database disk image is malformed");
    },
    async close() {
      // no-op
    },
  });
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    memoryService: failingMemory,
    worldInfoService: worldInfoService(),
    profile: memoryProfile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;

  const output = new ControlledResponse("finish");
  await dispatch(handler, request("GET", "/api/tavern/v1/memory", { cookie, "sec-fetch-site": "same-origin" }), output);
  assert.equal(output.status, 503);
  assert.equal((JSON.parse(output.body) as { code: string }).code, "storage_unavailable");
  await handler.close();
});

test("management handler projects the Memory navigation item as unavailable when the read fails", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const failingMemory: MemoryManagementService = Object.freeze({
    async read() {
      throw new Error("memory_read_storage_unavailable");
    },
    async close() {
      // no-op
    },
  });
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    memoryService: failingMemory,
    worldInfoService: worldInfoService(),
    profile: memoryProfile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const snapshot = JSON.parse(bootstrap.body) as {
    navigation: ReadonlyArray<Readonly<{ itemId: string; availability: string }>>;
    memory: Readonly<{ readAvailable: boolean; mutationAvailable: boolean; projectionRevision: string | null }>;
  };
  // A failed Memory read must not advertise Memory capability: the navigation
  // item stays unavailable and projectionRevision stays null.
  assert.deepEqual(snapshot.navigation, [
    { itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" },
    { itemId: "memory", labelKey: "tavern.nav.memory", availability: "unavailable" },
  ]);
  assert.deepEqual(snapshot.memory, {
    readAvailable: false,
    mutationAvailable: false,
    projectionRevision: null,
  });
  await handler.close();
});

test("management handler rejects a Memory-route profile that omits the Memory navigation item", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const mismatchedProfile = composeTavernProfile({
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
      "memory.read",
    ],
    operationIds: ["draft.save", "draft.discard", "chat.rename"],
    navigationItemIds: ["chat"],
  });
  await assert.rejects(
    startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: service(recorder),
      memoryService: memoryService(),
      profile: mismatchedProfile,
      bootstrapToken: token,
    }),
    /tavern_management_profile_operation_unavailable/,
  );
});

test("management handler serves world-info read/bind with session, CSRF and strict command validation", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const worldInfoRecorder = { reads: 0, sets: 0, closes: 0 };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(worldInfoRecorder),
    profile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return { status: output.status, body: output.body };
  };

  // GET requires a bootstrapped same-origin authenticated browser session.
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/world-info", { "sec-fetch-site": "same-origin" }))).status,
    401,
  );
  assert.equal(worldInfoRecorder.reads, 0);

  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  // Bootstrap projects a validated World Info state through the service
  // (this profile declares world-info.read), consuming exactly one read;
  // reset the counter so the route-level accounting is exact.
  assert.equal(worldInfoRecorder.reads, 1);
  worldInfoRecorder.reads = 0;
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;

  // Query or body on the read route is rejected before the service runs.
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/world-info?apiVersion=1", { cookie, "sec-fetch-site": "same-origin" })))
      .status,
    400,
  );
  assert.equal(
    (
      await run(
        request(
          "GET",
          "/api/tavern/v1/world-info",
          { cookie, "sec-fetch-site": "same-origin", "content-length": "2" },
          {},
        ),
      )
    ).status,
    400,
  );
  assert.equal(worldInfoRecorder.reads, 0);

  // A valid read returns the schema-valid safe state and calls read once.
  const read = await run(request("GET", "/api/tavern/v1/world-info", { cookie, "sec-fetch-site": "same-origin" }));
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.body), worldInfoState);
  assert.equal(worldInfoRecorder.reads, 1);

  // PUT rejects a wrong Origin before any service work.
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/world-info",
          { origin: "http://evil.example", cookie, "x-csrf-token": csrf },
          { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, sourceHandle: null },
        ),
      )
    ).status,
    401,
  );
  assert.equal(worldInfoRecorder.sets, 0);
  // PUT requires an exact untampered CSRF token. A wrong token must reject
  // before setBinding, not on the service-provided problem path.
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/world-info",
          { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": "B".repeat(43) },
          { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, sourceHandle: null },
        ),
      )
    ).status,
    403,
  );
  // Strict command violations (extra field, malformed expectedRevision) are
  // rejected before the service is ever consulted.
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/world-info",
          { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
          { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, sourceHandle: null, extra: true },
        ),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/world-info",
          { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
          { apiVersion: 1, selectionGeneration: 1, expectedRevision: "not-an-opaque-handle", sourceHandle: null },
        ),
      )
    ).status,
    400,
  );
  assert.equal(worldInfoRecorder.sets, 0);

  // A valid strict command reaches setBinding exactly once with the exact
  // command and returns the service's durable read-back.
  const bound = await run(
    request(
      "PUT",
      "/api/tavern/v1/world-info",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, sourceHandle: null },
    ),
  );
  assert.equal(bound.status, 200);
  assert.deepEqual(JSON.parse(bound.body), worldInfoState);
  assert.equal(worldInfoRecorder.sets, 1);
  await handler.close();
  assert.equal(worldInfoRecorder.closes, 1);
  assert.equal(recorder.closes, 1);
});

test("management handler fails closed when the profile advertises world-info routes without a bounded world-info service", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  // The management profile declares world-info.read and world-info.bind; a
  // handler constructed without the World Info binding service must fail
  // closed before any route or injected-service use (same gate as memory.read).
  await assert.rejects(
    startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: service(recorder),
      profile,
      playerPreferenceStore: voicePreferenceStore,
      bootstrapToken: token,
    }),
    /tavern_management_composition_unavailable/,
  );
});

test("management handler maps world-info binding conflict and locked errors to 409 state_reconciliation_required without raw text", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const worldInfoRecorder = {
    reads: 0,
    sets: 0,
    closes: 0,
    setError: undefined as Error | undefined,
  };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(worldInfoRecorder),
    profile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const put = async () => {
    const output = new ControlledResponse("finish");
    await dispatch(
      handler,
      request(
        "PUT",
        "/api/tavern/v1/world-info",
        { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
        { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, sourceHandle: null },
      ),
      output,
    );
    return output;
  };

  for (const serviceError of ["world_info_binding_conflict", "world_info_binding_locked"]) {
    worldInfoRecorder.setError = new Error(serviceError);
    const response = await put();
    assert.equal(response.status, 409);
    const payload = JSON.parse(response.body) as {
      code: string;
      title: string;
      type: string;
      status: number;
    };
    assert.equal(payload.code, "state_reconciliation_required");
    assert.equal(payload.status, 409);
    assert.equal(payload.type, "urn:gamebuddy:tavern:state_reconciliation_required");
    assert.ok(!payload.title.includes(serviceError), "raw service error text must not leak");
    assert.ok(!payload.title.includes("world_info"), "raw internal identifier must not leak");
  }
  assert.equal(worldInfoRecorder.sets, 2);
  await handler.close();
});

test("management handler maps world-info service and storage unavailability to safe 503 problem codes without raw text", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const worldInfoRecorder = {
    reads: 0,
    sets: 0,
    closes: 0,
    setError: undefined as Error | undefined,
  };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(worldInfoRecorder),
    profile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;

  for (const [serviceError, expectedCode] of [
    ["world_info_binding_service_unavailable", "runtime_unavailable"],
    ["world_info_binding_storage_unavailable", "storage_unavailable"],
  ] as const) {
    worldInfoRecorder.setError = new Error(serviceError);
    const output = new ControlledResponse("finish");
    await dispatch(
      handler,
      request(
        "PUT",
        "/api/tavern/v1/world-info",
        { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
        { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, sourceHandle: null },
      ),
      output,
    );
    assert.equal(output.status, 503);
    const payload = JSON.parse(output.body) as {
      code: string;
      title: string;
      type: string;
      status: number;
      retryable: boolean;
    };
    assert.equal(payload.code, expectedCode);
    assert.equal(payload.status, 503);
    assert.equal(payload.type, `urn:gamebuddy:tavern:${expectedCode}`);
    assert.equal(payload.retryable, true);
    assert.ok(!payload.title.includes("world_info"), "raw internal identifier must not leak");
  }
  assert.equal(worldInfoRecorder.sets, 2);
  await handler.close();
});

test("management handler rejects oversized request bodies with HTTP 413 and closes connection", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(),
    profile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    // 1. Content-Length exceeding MAX_BODY_BYTES returns 413 payload_too_large
    const oversizedBody = JSON.stringify({ apiVersion: 1, bootstrapToken: token }) + " ".repeat(MAX_BODY_BYTES + 1024);
    const res = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: oversizedBody,
    });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get("connection"), "close");
    const problem = (await res.json()) as { code: string; status: number };
    assert.equal(problem.code, "payload_too_large");
    assert.equal(problem.status, 413);

    // 2. Chunked body exceeding MAX_BODY_BYTES returns 413 payload_too_large
    const chunk1 = '{"apiVersion":1,"bootstrapToken":"' + token + '","padding":"';
    const chunk2 = "x".repeat(MAX_BODY_BYTES + 1024) + '"}';
    const chunkedRes = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk1));
          controller.enqueue(new TextEncoder().encode(chunk2));
          controller.close();
        },
      }),
    } as RequestInit & { duplex: string });
    assert.equal(chunkedRes.status, 413);
    assert.equal(chunkedRes.headers.get("connection"), "close");
    const chunkedProblem = (await chunkedRes.json()) as { code: string; status: number };
    assert.equal(chunkedProblem.code, "payload_too_large");
    assert.equal(chunkedProblem.status, 413);
  } finally {
    await server.close();
  }
});

test("management dispatcher destroys request socket and returns 413 payload_too_large for oversized payloads", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(),
    profile,
    playerPreferenceStore: voicePreferenceStore,
    bootstrapToken: token,
  });
  try {
    let socketDestroyed = false;
    const mockSocket = {
      get destroyed() {
        return socketDestroyed;
      },
      destroy() {
        socketDestroyed = true;
      },
    };
    const oversizedBody = JSON.stringify({ apiVersion: 1, bootstrapToken: token }) + " ".repeat(MAX_BODY_BYTES + 1024);
    const req = request("POST", "/api/tavern/v1/bootstrap", { origin: "http://127.0.0.1:7331" }, oversizedBody);
    Object.defineProperty(req, "socket", { value: mockSocket, configurable: true });

    const output = new ControlledResponse("finish");
    await dispatch(handler, req, output);

    assert.equal(output.status, 413);
    assert.equal(output.headers.get("connection"), "close");
    const payload = JSON.parse(output.body) as { code: string; status: number };
    assert.equal(payload.code, "payload_too_large");
    assert.equal(payload.status, 413);
    assert.equal(socketDestroyed, true);
  } finally {
    await handler.close();
  }
});

class ControlledResponse extends EventEmitter {
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  readonly headers = new (class extends Map<string, string> {
    override get(key: string): string | undefined {
      return super.get(key) ?? super.get(key.toLowerCase());
    }
  })();
  status = 0;
  body = "";
  private readonly outcome: "finish" | "premature_close";
  constructor(outcome: "finish" | "premature_close") {
    super();
    this.outcome = outcome;
  }
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
    this.headers.set(name.toLowerCase(), value);
  }
  writeHead(status: number, headers?: Record<string, string>): void {
    this.status = status;
    if (headers !== undefined) {
      for (const [key, value] of Object.entries(headers)) {
        this.headers.set(key, value);
        this.headers.set(key.toLowerCase(), value);
      }
    }
  }
  end(body = ""): void {
    this.body = body;
    this.writableEnded = true;
    if (this.outcome === "finish") {
      this.writableFinished = true;
      this.emit("finish");
      return;
    }
    this.emit("close");
  }
}

function request(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): import("node:http").IncomingMessage {
  const hasBody = body !== undefined;
  const encoded = hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : "";
  return Object.assign(Readable.from([encoded]), {
    method,
    url: path,
    headers: {
      host: "127.0.0.1:7331",
      ...(hasBody
        ? {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(encoded)),
          }
        : {}),
      ...headers,
    },
  }) as unknown as import("node:http").IncomingMessage;
}

async function dispatch(
  handler: ReturnType<typeof createTavernManagementDialogueWebRequestHandler>,
  input: import("node:http").IncomingMessage,
  output: ControlledResponse,
): Promise<void> {
  handler.handle(input, output as unknown as import("node:http").ServerResponse, "http://127.0.0.1:7331");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("management handler exposes the Host-owned Voice preference read and consent routes with session and CSRF gating", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(),
    playerPreferenceStore: voicePreferenceStore,
    profile,
    bootstrapToken: token,
  });
  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return output;
  };
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/settings/voice-preference", { "sec-fetch-site": "same-origin" }))).status,
    401,
  );
  const bootstrap = await run(
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const read = await run(
    request("GET", "/api/tavern/v1/settings/voice-preference", { cookie, "sec-fetch-site": "same-origin" }),
  );
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.body), {
    revision: 0,
    disclosureVersion: null,
    consent: "undecided",
    decidedAtMs: null,
    outputDevice: null,
    persona: null,
  });
  const missingCsrf = await run(
    request(
      "PUT",
      "/api/tavern/v1/settings/voice-preference",
      { origin: "http://127.0.0.1:7331", cookie },
      { expectedRevision: 0, action: "accept", disclosureVersion: "mimo-cloud-tts-v1" },
    ),
  );
  assert.equal(missingCsrf.status, 403);
  const invalid = await run(
    request(
      "PUT",
      "/api/tavern/v1/settings/voice-preference",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      { expectedRevision: 0, action: "accept", disclosureVersion: "mimo-cloud-tts-v1", extra: true },
    ),
  );
  assert.equal(invalid.status, 400);
  const accepted = await run(
    request(
      "PUT",
      "/api/tavern/v1/settings/voice-preference",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      { expectedRevision: 0, action: "accept", disclosureVersion: "mimo-cloud-tts-v1" },
    ),
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.body), {
    revision: 1,
    disclosureVersion: "mimo-cloud-tts-v1",
    consent: "accepted",
    decidedAtMs: 1,
    outputDevice: null,
    persona: null,
  });
  await handler.close();
  assert.equal(recorder.closes, 1);
});

test("management handler lists output endpoints through the injected Voice Gateway enumerator", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  let calls = 0;
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(),
    playerPreferenceStore: voicePreferenceStore,
    listVoiceOutputDevices: async () => {
      calls += 1;
      return [
        { id: "waveout:0", name: "Headphones" },
        { id: "waveout:1", name: "Speakers (C-Media)" },
      ];
    },
    profile,
    bootstrapToken: token,
  });
  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return output;
  };
  // Unauthenticated read is rejected before the enumerator is consulted.
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/settings/voice-devices", { "sec-fetch-site": "same-origin" }))).status,
    401,
  );
  assert.equal(calls, 0);
  const bootstrap = await run(
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
  );
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const devices = await run(
    request("GET", "/api/tavern/v1/settings/voice-devices", { cookie, "sec-fetch-site": "same-origin" }),
  );
  assert.equal(devices.status, 200);
  assert.deepEqual(JSON.parse(devices.body), {
    devices: [
      { id: "waveout:0", name: "Headphones" },
      { id: "waveout:1", name: "Speakers (C-Media)" },
    ],
    defaultSelectable: true,
  });
  assert.equal(calls, 1);
  await handler.close();
  assert.equal(recorder.closes, 1);
});

test("management handler fails closed when the profile advertises Voice preference routes without the Host store", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  await assert.rejects(
    startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: service(recorder),
      worldInfoService: worldInfoService(),
      profile,
      bootstrapToken: token,
    }),
    /tavern_management_composition_unavailable/,
  );
});

test("management handler exposes the Host-owned language preference read and update routes with session and CSRF gating", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const languageProfile = composeTavernProfile({
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
      "settings.language.read",
      "settings.language.update",
    ],
    operationIds: [
      "draft.save",
      "draft.discard",
      "chat.rename",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
      "settings.language.read",
      "settings.language.update",
    ],
    navigationItemIds: ["chat"],
  });
  let languageState: PlayerPreference = {
    revision: 0,
    locale: null,
    disclosureVersion: null,
    consent: "undecided",
    decidedAtMs: null,
    outputDevice: null,
    persona: null,
    paced: false,
    gamePromptAddition: "",
  };
  // One Host-owned record carries both settings field groups (the companion
  // language and the Voice consent/output), so this language surface writes the
  // same store the Voice surface writes.
  const preferenceStore = {
    read: async () => languageState,
    update: async (expectedRevision: number, update: PlayerPreferenceUpdate) => {
      if (expectedRevision !== languageState.revision) throw new PlayerPreferenceRevisionConflict();
      languageState = { ...languageState, revision: languageState.revision + 1 };
      if (update.action === "setLocale") languageState = { ...languageState, locale: update.locale };
      return languageState;
    },
  };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(),
    playerPreferenceStore: preferenceStore,
    profile: languageProfile,
    bootstrapToken: token,
  });
  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return output;
  };
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/settings/language", { "sec-fetch-site": "same-origin" }))).status,
    401,
  );
  const bootstrap = await run(
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const read = await run(
    request("GET", "/api/tavern/v1/settings/language", { cookie, "sec-fetch-site": "same-origin" }),
  );
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.body), { revision: 0, locale: null });
  const missingCsrf = await run(
    request(
      "PUT",
      "/api/tavern/v1/settings/language",
      { origin: "http://127.0.0.1:7331", cookie },
      { expectedRevision: 0, locale: "zh-CN" },
    ),
  );
  assert.equal(missingCsrf.status, 403);
  const invalid = await run(
    request(
      "PUT",
      "/api/tavern/v1/settings/language",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      // The contract's locale is a bounded BCP-47-shaped tag
      // (`^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$`), so the malformed command is
      // one that fails that shape rather than one language the build does not ship.
      { expectedRevision: 0, locale: "not_a_locale" },
    ),
  );
  assert.equal(invalid.status, 400);
  const updated = await run(
    request(
      "PUT",
      "/api/tavern/v1/settings/language",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      { expectedRevision: 0, locale: "zh-CN" },
    ),
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(JSON.parse(updated.body), { revision: 1, locale: "zh-CN" });
  const english = await run(
    request(
      "PUT",
      "/api/tavern/v1/settings/language",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      { expectedRevision: 1, locale: "en-US" },
    ),
  );
  assert.equal(english.status, 200);
  assert.deepEqual(JSON.parse(english.body), { revision: 2, locale: "en-US" });
  await handler.close();
  assert.equal(recorder.closes, 1);
});

test("management handler fails closed when the profile advertises language routes without the Host store", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const languageProfile = composeTavernProfile({
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
      "settings.language.read",
      "settings.language.update",
    ],
    operationIds: [
      "draft.save",
      "draft.discard",
      "chat.rename",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
      "settings.language.read",
      "settings.language.update",
    ],
    navigationItemIds: ["chat"],
  });
  await assert.rejects(
    startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: service(recorder),
      worldInfoService: worldInfoService(),
      profile: languageProfile,
      bootstrapToken: token,
    }),
    /tavern_management_composition_unavailable/,
  );
});

test("management handler maps Voice preference revision conflicts to the safe settings problem", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    worldInfoService: worldInfoService(),
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
        throw new PlayerPreferenceRevisionConflict();
      },
    }),
    profile,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const output = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "PUT",
      "/api/tavern/v1/settings/voice-preference",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      { expectedRevision: 0, action: "revoke" },
    ),
    output,
  );
  assert.equal(output.status, 409);
  assert.equal((JSON.parse(output.body) as { code: string }).code, "settings_revision_conflict");
  await handler.close();
});

/**
 * One CSRF condition, one answer, across every mutation.
 *
 * `world-info.bind`, `chat.rename` and `chat.opening` answered 400
 * `invalid_request` for a *missing* `x-csrf-token` while every other mutation
 * answered 403 `csrf_failed`; a CSRF failure is an authorization failure, so 403
 * is the one correct answer. This enumerates the routes instead of pinning one,
 * so a route that copies one of the old branches fails here rather than shipping
 * a second vocabulary for the same refusal. The check runs before any route can
 * refuse for a missing profile or service, so the handler needs no services.
 */
test("every CSRF-protected management mutation answers 403 csrf_failed for a missing token", async () => {
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service({
      lists: 0,
      renames: 0,
      draftReads: 0,
      draftSaves: 0,
      draftDiscards: 0,
      closes: 0,
    }),
    worldInfoService: worldInfoService(),
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
        return {
          revision: 1,
          locale: null,
          disclosureVersion: null,
          consent: "accepted" as const,
          decidedAtMs: 1,
          outputDevice: null,
          persona: null,
          paced: false,
          gamePromptAddition: "",
        };
      },
    }),
    profile,
    bootstrapToken: token,
  });
  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return output;
  };
  const bootstrap = await run(
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
  );
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;

  const mutations: readonly (readonly [string, string])[] = [
    ["PUT", "/api/tavern/v1/draft"],
    ["DELETE", "/api/tavern/v1/draft"],
    ["PUT", "/api/tavern/v1/world-info"],
    ["POST", "/api/tavern/v1/chats"],
    ["POST", `/api/tavern/v1/chats/${handle}/archive`],
    ["POST", `/api/tavern/v1/chats/${handle}/restore`],
    ["POST", `/api/tavern/v1/chats/${handle}/trash`],
    ["PUT", "/api/tavern/v1/chat/select"],
    ["PUT", "/api/tavern/v1/chat/title"],
    ["PUT", "/api/tavern/v1/chat/opening"],
    ["PUT", "/api/tavern/v1/memory"],
    ["POST", "/api/tavern/v1/settings/connections"],
    ["POST", `/api/tavern/v1/settings/connections/${handle}/test`],
    ["POST", `/api/tavern/v1/settings/connections/${handle}/activate`],
    ["POST", `/api/tavern/v1/settings/connections/${handle}/model`],
    ["DELETE", `/api/tavern/v1/settings/connections/${handle}`],
    ["PUT", "/api/tavern/v1/settings/profiles"],
    ["PUT", "/api/tavern/v1/settings/voice-preference"],
    ["PUT", "/api/tavern/v1/settings/language"],
    ["PUT", "/api/tavern/v1/settings/delivery"],
    ["PUT", "/api/tavern/v1/settings/game-prompt"],
    ["POST", "/api/tavern/v1/companions"],
    ["POST", "/api/tavern/v1/imports"],
    ["POST", `/api/tavern/v1/imports/${handle}/review`],
    ["POST", `/api/tavern/v1/imports/${handle}/confirm`],
    ["PUT", "/api/tavern/v1/persona"],
    ["PUT", "/api/tavern/v1/scenario"],
    ["PUT", "/api/tavern/v1/greeting"],
    ["POST", "/api/tavern/v1/world-info/item"],
    ["PUT", "/api/tavern/v1/world-info/item"],
    ["DELETE", "/api/tavern/v1/world-info/item"],
  ];
  for (const [method, path] of mutations) {
    const response = await run(request(method, path, { origin: "http://127.0.0.1:7331", cookie }));
    assert.equal(response.status, 403, `${method} ${path} answered ${response.status}, not 403`);
    assert.equal(
      (JSON.parse(response.body) as { code: string }).code,
      "csrf_failed",
      `${method} ${path} did not name the CSRF failure`,
    );
  }
  await handler.close();
});

/**
 * The World Info authoring routes. One read and three mutations, all on the same path, all
 * addressed by an opaque handle from the exact projection the caller read: the read carries
 * its command in the query and the mutations in a body, and every route answers with the
 * library's own answer instead of a local guess.
 */
test("management handler serves world-info.detail with session, an exact query and a named refusal", async () => {
  const worldInfoRecorder = {
    reads: 0,
    sets: 0,
    closes: 0,
    details: 0,
    detailResult: undefined as PublicWorldInfoProjection | null | undefined,
  };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service({ lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 }),
    worldInfoService: worldInfoService(worldInfoRecorder),
    playerPreferenceStore: voicePreferenceStore,
    profile: worldInfoAuthoringProfile,
    bootstrapToken: token,
  });
  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return { status: output.status, body: output.body };
  };
  const query = `apiVersion=1&selectionGeneration=1&expectedRevision=${handle}&itemHandle=${handle}`;

  // The read is a browser-session read: without a session it does no service work.
  assert.equal(
    (await run(request("GET", `/api/tavern/v1/world-info/item?${query}`, { "sec-fetch-site": "same-origin" }))).status,
    401,
  );
  assert.equal(worldInfoRecorder.details, 0);

  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;

  // The query is strict: an undeclared parameter and a missing command field both refuse
  // before the service is consulted.
  assert.equal(
    (
      await run(
        request("GET", `/api/tavern/v1/world-info/item?${query}&extra=1`, { cookie, "sec-fetch-site": "same-origin" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await run(
        request("GET", "/api/tavern/v1/world-info/item?apiVersion=1", { cookie, "sec-fetch-site": "same-origin" }),
      )
    ).status,
    400,
  );
  assert.equal(worldInfoRecorder.details, 0);

  // A valid command returns the item's own content at its exact revision.
  const read = await run(
    request("GET", `/api/tavern/v1/world-info/item?${query}`, { cookie, "sec-fetch-site": "same-origin" }),
  );
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.body), worldInfoItem);
  assert.equal(worldInfoRecorder.details, 1);

  // An item the library no longer lists is its own bounded 404, never a generic failure.
  worldInfoRecorder.detailResult = null;
  const missing = await run(
    request("GET", `/api/tavern/v1/world-info/item?${query}`, { cookie, "sec-fetch-site": "same-origin" }),
  );
  assert.equal(missing.status, 404);
  const problem = JSON.parse(missing.body) as { code: string; status: number; type: string; title: string };
  assert.equal(problem.code, "world_info_not_found");
  assert.equal(problem.status, 404);
  assert.equal(problem.type, "urn:gamebuddy:tavern:world_info_not_found");
  assert.equal(problem.title, "world info not found");
  await handler.close();
});

test("management handler serves the world-info authoring mutations with CSRF and one named refusal each", async () => {
  const worldInfoRecorder = {
    reads: 0,
    sets: 0,
    closes: 0,
    creates: 0,
    updates: 0,
    deletes: 0,
    createError: undefined as Error | undefined,
    updateError: undefined as Error | undefined,
    deleteError: undefined as Error | undefined,
  };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service({ lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 }),
    worldInfoService: worldInfoService(worldInfoRecorder),
    playerPreferenceStore: voicePreferenceStore,
    profile: worldInfoAuthoringProfile,
    bootstrapToken: token,
  });
  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return { status: output.status, body: output.body };
  };
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;

  const content = {
    publicTitle: "Pelican Town",
    summary: "The revised town facts.",
    entries: [{ scope: "setting", publicTitle: "Square", summary: "Town center." }],
  };
  const address = { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, itemHandle: handle };
  // A create addresses nothing existing: it carries the projection handle and the content.
  const createCommand = {
    apiVersion: 1,
    selectionGeneration: 1,
    expectedRevision: handle,
    item: content,
  };
  const updateCommand = { ...address, item: { ...content, expectedRevision: 1 } };
  const mutation = (method: string, body: unknown, csrfToken?: string) =>
    run(
      request(
        method,
        "/api/tavern/v1/world-info/item",
        {
          origin: "http://127.0.0.1:7331",
          cookie,
          ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
        },
        body,
      ),
    );

  // Every mutation refuses a missing CSRF token before any service work.
  assert.equal((await mutation("POST", createCommand)).status, 403);
  assert.equal((await mutation("PUT", updateCommand)).status, 403);
  assert.equal((await mutation("DELETE", address)).status, 403);
  assert.deepEqual([worldInfoRecorder.creates, worldInfoRecorder.updates, worldInfoRecorder.deletes], [0, 0, 0]);

  // A strict body violation is refused before the service is consulted.
  assert.equal((await mutation("POST", { ...createCommand, extra: true }, csrf)).status, 400);
  assert.equal((await mutation("PUT", { ...updateCommand, item: content }, csrf)).status, 400);
  assert.equal((await mutation("DELETE", { ...address, itemHandle: "Pelican Town" }, csrf)).status, 400);
  assert.deepEqual([worldInfoRecorder.creates, worldInfoRecorder.updates, worldInfoRecorder.deletes], [0, 0, 0]);

  // The three mutations reach the service once each and answer with its re-projected state.
  const created = await mutation("POST", createCommand, csrf);
  assert.equal(created.status, 200);
  assert.deepEqual(JSON.parse(created.body), worldInfoState);
  const updated = await mutation("PUT", updateCommand, csrf);
  assert.equal(updated.status, 200);
  assert.deepEqual(JSON.parse(updated.body), worldInfoState);
  const removed = await mutation("DELETE", address, csrf);
  assert.equal(removed.status, 200);
  assert.deepEqual(JSON.parse(removed.body), worldInfoState);
  assert.deepEqual([worldInfoRecorder.creates, worldInfoRecorder.updates, worldInfoRecorder.deletes], [1, 1, 1]);

  // Each library refusal reaches the player as its own bounded code, with no raw text.
  const refusal = async (method: string, body: unknown, message: string) => {
    if (method === "POST") worldInfoRecorder.createError = new Error(message);
    else if (method === "PUT") worldInfoRecorder.updateError = new Error(message);
    else worldInfoRecorder.deleteError = new Error(message);
    const response = await mutation(method, body, csrf);
    assert.equal(response.status, 409, `${method} answered ${response.status}`);
    const payload = JSON.parse(response.body) as { code: string; status: number; type: string; title: string };
    assert.equal(payload.code, message);
    assert.equal(payload.status, 409);
    assert.equal(payload.type, `urn:gamebuddy:tavern:${message}`);
    assert.ok(!payload.title.includes(message), "the raw service message must not leak into the title");
    assert.ok(!payload.title.includes("world_info"), "a raw internal identifier must not leak");
  };
  await refusal("POST", createCommand, "world_info_already_exists");
  await refusal("PUT", updateCommand, "world_info_revision_conflict");
  await refusal("DELETE", address, "world_info_in_use");

  await handler.close();
  assert.equal(worldInfoRecorder.closes, 1);
});

test("management handler does not serve a World Info authoring route the profile never declares", async () => {
  const worldInfoRecorder = { reads: 0, sets: 0, closes: 0, details: 0, creates: 0, updates: 0, deletes: 0 };
  // The injected service is present, so a route that answers here answers because the
  // profile declared it - not because the handler happened to have something to call.
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service({ lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 }),
    worldInfoService: worldInfoService(worldInfoRecorder),
    playerPreferenceStore: voicePreferenceStore,
    profile,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      { apiVersion: 1, bootstrapToken: token },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return { status: output.status, body: output.body };
  };
  const query = `apiVersion=1&selectionGeneration=1&expectedRevision=${handle}&itemHandle=${handle}`;
  const address = { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, itemHandle: handle };
  const projection = { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle };

  for (const [method, path, body] of [
    ["GET", `/api/tavern/v1/world-info/item?${query}`, undefined],
    [
      "POST",
      "/api/tavern/v1/world-info/item",
      { ...projection, item: { publicTitle: "Pelican Town", summary: "s", entries: [] } },
    ],
    [
      "PUT",
      "/api/tavern/v1/world-info/item",
      { ...address, item: { publicTitle: "Pelican Town", summary: "s", entries: [], expectedRevision: 1 } },
    ],
    ["DELETE", "/api/tavern/v1/world-info/item", address],
  ] as const) {
    const response = await run(
      request(
        method,
        path,
        method === "GET"
          ? { cookie, "sec-fetch-site": "same-origin" }
          : { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
        body,
      ),
    );
    assert.equal(response.status, 404, `${method} ${path} answered ${response.status}`);
    assert.equal((JSON.parse(response.body) as { code: string }).code, "profile_operation_unavailable");
  }
  assert.deepEqual(
    [worldInfoRecorder.details, worldInfoRecorder.creates, worldInfoRecorder.updates, worldInfoRecorder.deletes],
    [0, 0, 0, 0],
  );
  await handler.close();
});

/**
 * The management profile that also serves the Characters surface's own book: the shared
 * core plus the `companion.list`/persona/scenario/greeting/retention group, which is
 * all-or-nothing and now carries her own book's edit beside its read.
 */
const charactersRouteGroup = [
  "companion.list",
  "companion.worldbook.read",
  "companion.worldbook.update",
  "companion.create",
  "persona.read",
  "persona.update",
  "scenario.read",
  "scenario.update",
  "greeting.read",
  "greeting.update",
  "chat.archive",
  "chat.restore",
  "chat.trash",
] as const;
const charactersProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...profile.routeIds, ...charactersRouteGroup],
  operationIds: [...profile.operationIds, ...charactersRouteGroup],
  navigationItemIds: ["chat", "characters"],
});

/** The run's own macro table, so the rendered bodies are asserted rather than assumed. */
const surfaceMacros = macroTable({ char: "琥珀", user: "阿岚" });

/**
 * The companion whose book the surface edits (the mount's own library entry).
 * `handle` is the opaque per-mount handle the roster projects, which is the only handle
 * these routes resolve.
 */
function realCompanionWorldBookService(
  root: string,
  calls: { refreshes: number; announced: readonly number[] | null },
): Readonly<{
  read(handle: string): Promise<import("./tavern/browser-contract/index.js").CompanionWorldBookV1 | null>;
  update(
    handle: string,
    command: import("./tavern/browser-contract/index.js").UpdateCompanionWorldBookCommandV1,
  ): Promise<import("./tavern/browser-contract/index.js").CompanionWorldBookV1 | null>;
}> {
  return Object.freeze({
    async read(requested: string) {
      if (requested !== handle) return null;
      return await projectRenderedCompanionWorldBook(root, surfaceMacros);
    },
    async update(
      requested: string,
      command: import("./tavern/browser-contract/index.js").UpdateCompanionWorldBookCommandV1,
    ) {
      if (requested !== handle) return null;
      return await updateCompanionWorldBook({
        path: join(root, "worldbook.json"),
        containmentRoot: root,
        macros: surfaceMacros,
        expectedRevision: command.expectedRevision,
        entries: command.entries,
        refreshBindings: async (previous, next) => {
          calls.refreshes += 1;
          calls.announced = [previous.revision, next.revision];
          return 0;
        },
      });
    },
  });
}

function cardOwnedBook(): import("./worldbook.js").WorldBook {
  return validateWorldBook({
    schemaVersion: 1,
    worldBookId: "worldbook_route_proof",
    revision: 7,
    alwaysOnPremise: "{{user}}和她一起打理农场。",
    scanDepth: 4,
    entries: [
      {
        entryId: "st-json-1",
        title: "温室",
        content: "{{char}}把温室的玻璃换成了新的。",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
        keys: ["温室", "玻璃房"],
      },
      {
        entryId: "st-json-2",
        title: "洒水器",
        content: "洒水器接在井边。",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
        constant: true,
        keys: ["洒水器"],
      },
    ],
  });
}

test("companion.worldbook.update rewrites the real durable book through the route, CASed on the revision it read", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-world-book-route-"));
  await writeWorldBook(join(root, "worldbook.json"), cardOwnedBook());
  const calls = { refreshes: 0, announced: null as readonly number[] | null };
  // A REAL loopback server and real `fetch`, not an in-process response object: this route
  // reads and writes a real file, so the reply lands on real I/O and a fixed number of event-loop
  // ticks is not a settle condition. It also proves the route is served on the wire.
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: service({ lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 }),
    worldInfoService: worldInfoService(),
    playerPreferenceStore: voicePreferenceStore,
    libraryService: Object.freeze({
      async listCompanions() {
        return [{ handle, name: "琥珀", isCurrent: true }];
      },
    }),
    personaService: Object.freeze({
      async read() {
        return null;
      },
      async update(request) {
        return { revision: request.expectedRevision + 1, name: request.name };
      },
    }),
    scenarioService: Object.freeze({
      async read() {
        return null;
      },
      async update(request) {
        return {
          revision: request.expectedRevision + 1,
          name: request.name,
          description: request.description,
          preview: request.description.slice(0, 64),
        };
      },
    }),
    greetingService: Object.freeze({
      async read() {
        return null;
      },
      async update(request) {
        return { revision: request.expectedRevision + 1, variants: request.variants };
      },
    }),
    companionWorldBookService: realCompanionWorldBookService(root, calls),
    profile: charactersProfile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);
    const snapshot = (await bootstrap.json()) as { csrfToken: string };
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const session = { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" };
    const writes = { ...session, "Content-Type": "application/json", "X-CSRF-Token": snapshot.csrfToken };
    const worldBookPath = `/api/tavern/v1/companions/${handle}/worldbook`;

    // The read projects the durable revision, which is what the edit CASes on.
    const read = await fetch(`${origin}${worldBookPath}`, { headers: session });
    assert.equal(read.status, 200);
    const before = (await read.json()) as {
      present: boolean;
      revision: number | null;
      entries: readonly { title: string; keys: readonly string[]; constant: boolean; content: string }[];
    };
    assert.equal(before.present, true);
    assert.equal(before.revision, 7);
    assert.deepEqual(
      before.entries.map((entry) => entry.content),
      ["琥珀把温室的玻璃换成了新的。", "洒水器接在井边。"],
    );

    // A rewrite without the CSRF header is refused before it can touch the book.
    const noCsrf = await fetch(`${origin}${worldBookPath}`, {
      method: "PUT",
      headers: { ...session, "Content-Type": "application/json" },
      body: JSON.stringify({
        apiVersion: 1,
        expectedRevision: 7,
        entries: [{ title: "温室", keys: [], constant: false, content: "改过了。" }],
      }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(((await noCsrf.json()) as { code: string }).code, "csrf_failed");

    // A body the contract does not admit is refused by the request schema.
    const invalidBody = await fetch(`${origin}${worldBookPath}`, {
      method: "PUT",
      headers: writes,
      body: JSON.stringify({ apiVersion: 1, expectedRevision: 7 }),
    });
    assert.equal(invalidBody.status, 400);

    // A handle this mount never handed out resolves to nothing at all.
    const unknownHandle = await fetch(`${origin}/api/tavern/v1/companions/${"Z".repeat(43)}/worldbook`, {
      method: "PUT",
      headers: writes,
      body: JSON.stringify({
        apiVersion: 1,
        expectedRevision: 7,
        entries: [{ title: "温室", keys: [], constant: false, content: "改过了。" }],
      }),
    });
    assert.equal(unknownHandle.status, 404);
    assert.equal(((await unknownHandle.json()) as { code: string }).code, "companion_not_found");

    // The player rewrites one body and adds a row, leaving the other row alone.
    const updated = await fetch(`${origin}${worldBookPath}`, {
      method: "PUT",
      headers: writes,
      body: JSON.stringify({
        apiVersion: 1,
        expectedRevision: 7,
        entries: [
          { title: "温室", keys: ["温室", "玻璃房"], constant: false, content: "{{user}}说这扇玻璃是她挑的。" },
          before.entries[1]!,
          { title: "雨天", keys: ["下雨", "雨天"], constant: false, content: "{{char}}喜欢雨天。" },
        ],
      }),
    });
    assert.equal(updated.status, 200);
    const updatedBody = (await updated.json()) as {
      revision: number | null;
      entries: readonly { title: string; content: string }[];
    };
    assert.equal(updatedBody.revision, 8);
    // The reply is the Host's own re-projection: the macros are RENDERED on the wire.
    assert.deepEqual(
      updatedBody.entries.map((entry) => entry.content),
      ["阿岚说这扇玻璃是她挑的。", "洒水器接在井边。", "琥珀喜欢雨天。"],
    );
    assert.equal(calls.refreshes, 1, "the edit carries the new revision to the threads that pin the old one");
    assert.deepEqual(calls.announced, [7, 8]);

    // …while the durable file holds the PLAYER's own words, and the card's own text on
    // the row she did not touch.
    const durable = await readWorldBook(join(root, "worldbook.json"));
    assert.deepEqual(
      durable.entries.map((entry) => entry.content),
      ["{{user}}说这扇玻璃是她挑的。", "洒水器接在井边。", "{{char}}喜欢雨天。"],
    );
    // A row whose body the player rewrote is still the entry she rewrote - rewriting what an
    // entry SAYS is not renaming it, so the card's own provenance stays with it. This used to
    // read `authored`, which meant a body edit relocated the entry to "came from nowhere".
    assert.equal(durable.entries[0]!.provenance, "st-card-import");
    assert.equal(durable.entries[1]!.provenance, "st-card-import");
    // …and the row the player ADDED is hers, from nowhere, because no entry claimed it.
    assert.equal(durable.entries[2]!.provenance, "authored");
    assert.equal(durable.alwaysOnPremise, "{{user}}和她一起打理农场。");

    // Removing the row the player added, and reading the book back.
    const removed = await fetch(`${origin}${worldBookPath}`, {
      method: "PUT",
      headers: writes,
      body: JSON.stringify({ apiVersion: 1, expectedRevision: 8, entries: updatedBody.entries.slice(0, 2) }),
    });
    assert.equal(removed.status, 200);
    const afterRemoval = (await removed.json()) as { revision: number | null; entries: readonly { title: string }[] };
    assert.equal(afterRemoval.revision, 9);
    assert.deepEqual(
      afterRemoval.entries.map((entry) => entry.title),
      ["温室", "洒水器"],
    );
    assert.equal(calls.refreshes, 2, "each successful edit carries the new revision to the threads");

    // The stale revision — the one the browser read first — now names a book that has
    // moved on twice, and the refusal says exactly that instead of "failed".
    const stale = await fetch(`${origin}${worldBookPath}`, {
      method: "PUT",
      headers: writes,
      body: JSON.stringify({
        apiVersion: 1,
        expectedRevision: 7,
        entries: [{ title: "温室", keys: [], constant: false, content: "旧版本。" }],
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code: string }).code, "companion_world_book_conflict");
    // …and a refused edit changes nothing, at any revision.
    assert.equal((await readWorldBook(join(root, "worldbook.json"))).revision, 9);
    assert.equal(calls.refreshes, 2, "a refused edit never reaches the threads");

    // An entry the persistent validator will not keep gets its own code, not invalid_request.
    const invalidEntry = await fetch(`${origin}${worldBookPath}`, {
      method: "PUT",
      headers: writes,
      body: JSON.stringify({
        apiVersion: 1,
        expectedRevision: 9,
        entries: [{ title: "温室", keys: [], constant: false, content: "" }],
      }),
    });
    assert.equal(invalidEntry.status, 400);
    assert.equal(((await invalidEntry.json()) as { code: string }).code, "authored_content_invalid");
    assert.equal((await readWorldBook(join(root, "worldbook.json"))).revision, 9);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("companion.worldbook.update names a companion with no book and a book it cannot read", async () => {
  const absent = await mkdtemp(join(tmpdir(), "gamebuddy-world-book-absent-"));
  const broken = await mkdtemp(join(tmpdir(), "gamebuddy-world-book-broken-"));
  await writeFile(join(broken, "worldbook.json"), "{ not json", "utf8");
  for (const [root, expectedStatus, expectedCode] of [
    [absent, 404, "companion_world_book_absent"],
    [broken, 503, "companion_record_unreadable"],
  ] as const) {
    const calls = { refreshes: 0, announced: null as readonly number[] | null };
    const server = await startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: service({ lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 }),
      worldInfoService: worldInfoService(),
      playerPreferenceStore: voicePreferenceStore,
      libraryService: Object.freeze({
        async listCompanions() {
          return [{ handle, name: "琥珀", isCurrent: true }];
        },
      }),
      personaService: Object.freeze({
        async read() {
          return null;
        },
        async update(request) {
          return { revision: request.expectedRevision + 1, name: request.name };
        },
      }),
      scenarioService: Object.freeze({
        async read() {
          return null;
        },
        async update(request) {
          return {
            revision: request.expectedRevision + 1,
            name: request.name,
            description: request.description,
            preview: request.description.slice(0, 64),
          };
        },
      }),
      greetingService: Object.freeze({
        async read() {
          return null;
        },
        async update(request) {
          return { revision: request.expectedRevision + 1, variants: request.variants };
        },
      }),
      companionWorldBookService: realCompanionWorldBookService(root, calls),
      profile: charactersProfile,
      bootstrapToken: token,
    });
    try {
      const origin = server.origin;
      const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
      });
      const snapshot = (await bootstrap.json()) as { csrfToken: string };
      const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
      const refused = await fetch(`${origin}/api/tavern/v1/companions/${handle}/worldbook`, {
        method: "PUT",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-CSRF-Token": snapshot.csrfToken,
        },
        body: JSON.stringify({
          apiVersion: 1,
          expectedRevision: 1,
          entries: [{ title: "温室", keys: [], constant: false, content: "正文。" }],
        }),
      });
      assert.equal(refused.status, expectedStatus);
      assert.equal(((await refused.json()) as { code: string }).code, expectedCode);
      assert.equal(calls.refreshes, 0);
      // Neither refusal invented a book.
      if (root === absent) await assert.rejects(readFile(join(absent, "worldbook.json"), "utf8"), /ENOENT/);
    } finally {
      await server.close();
    }
  }
  await rm(absent, { recursive: true, force: true });
  await rm(broken, { recursive: true, force: true });
});

/**
 * The character-card export route (`companion.card.export`).
 *
 * A read, so it is a same-origin browser fetch with NO CSRF header - taking her
 * work out cannot change her. The exact opaque handle the roster projected
 * resolves that companion (any listed one, not only the mounted companion), and
 * each way the Host can refuse is its own bounded code: a handle this mount never
 * handed out, a record that cannot be read, or a card too large to be imported
 * back.
 */
const tooLargeHandle = "T".repeat(42) + "A";
const unreadableHandle = "U".repeat(42) + "A";
const unknownHandle = "Z".repeat(42) + "A";
/** A companion whose PNG form has no picture to carry. */
const noPictureHandle = "P".repeat(42) + "A";
const exportRouteGroup = ["companion.card.export"] as const;
const exportProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...profile.routeIds, ...exportRouteGroup],
  operationIds: [...profile.operationIds, ...exportRouteGroup],
  navigationItemIds: ["chat", "characters"],
});
/** The export group on its own, to prove the route's own composition fails closed. */
const exportOnlyProfile = composeTavernProfile({
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
    "companion.card.export",
  ],
  operationIds: [
    "draft.save",
    "draft.discard",
    "chat.rename",
    "world-info.bind",
    "settings.voice.read",
    "settings.voice.consent",
    "companion.card.export",
  ],
  navigationItemIds: ["chat", "characters"],
});

function cardExportService(recorder: { reads: string[] }): Readonly<{
  read(handle: string, format: CompanionCardFormat): Promise<CompanionCardExportResult | null>;
}> {
  const card = exportCompanionCard({ name: "琥珀", scenario: "你们一起在祖辈留下的农场里开始新的生活。" });
  // A real PNG card, so the route's own base64 payload is checked against bytes a
  // decoder can read back rather than against an arbitrary string.
  const cardFile = writeCompanionCardPng(pngPictureFile(), card.card);
  return Object.freeze({
    async read(requested: string, format: CompanionCardFormat) {
      recorder.reads.push(`${format} ${requested}`);
      if (requested === handle)
        return format === "png"
          ? Object.freeze({ format: "png" as const, spec: card.spec, fileName: "琥珀.png", cardFile })
          : Object.freeze({ format: "json" as const, spec: card.spec, fileName: card.fileName, card: card.card });
      if (requested === tooLargeHandle) throw new Error("companion_card_too_large");
      if (requested === unreadableHandle) throw new Error("companion_record_unreadable");
      if (requested === noPictureHandle && format === "png") throw new Error("companion_card_image_absent");
      return null;
    },
  });
}

test("companion.card.export serves a roster companion's card as a session read and names each refusal", async () => {
  const recorder = { reads: [] as string[] };
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: service({ lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 }),
    worldInfoService: worldInfoService(),
    playerPreferenceStore: voicePreferenceStore,
    libraryService: Object.freeze({
      async listCompanions() {
        return [{ handle, name: "琥珀", isCurrent: true }];
      },
    }),
    companionCardExportService: cardExportService(recorder),
    profile: exportProfile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const session = { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" };
    const cardPath = (value: string, format: string) => `/api/tavern/v1/companions/${value}/card?format=${format}`;

    // A read: same-origin session only - no CSRF header - and the exact bytes the
    // Host built come back, which our own decoder accepts. The format is named in
    // the request, never inferred.
    const read = await fetch(`${origin}${cardPath(handle, "json")}`, { headers: session });
    assert.equal(read.status, 200);
    const body = (await read.json()) as {
      apiVersion: number;
      format: string;
      spec: string;
      fileName: string;
      card: string;
    };
    assert.equal(body.apiVersion, 1);
    assert.equal(body.format, "json");
    assert.equal(body.spec, "chara_card_v3");
    assert.equal(body.fileName, "琥珀.json");
    assert.equal(decodeStCard(body.card).candidate?.profileCandidate.identity.name, "琥珀");

    // The PNG form: the WHOLE card file, base64, and the bytes decode to a real
    // PNG card our own decoder reads back to the same companion.
    const readPng = await fetch(`${origin}${cardPath(handle, "png")}`, { headers: session });
    assert.equal(readPng.status, 200);
    const pngBody = (await readPng.json()) as {
      apiVersion: number;
      format: string;
      spec: string;
      fileName: string;
      cardFileBase64: string;
    };
    assert.equal(pngBody.apiVersion, 1);
    assert.equal(pngBody.format, "png");
    assert.equal(pngBody.spec, "chara_card_v3");
    assert.equal(pngBody.fileName, "琥珀.png");
    const cardFile = Buffer.from(pngBody.cardFileBase64, "base64");
    assert.deepEqual(Array.from(cardFile.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    const decodedPng = decodeStCard(cardFile);
    assert.equal(decodedPng.source, "png");
    assert.equal(decodedPng.candidate?.profileCandidate.identity.name, "琥珀");
    assert.deepEqual(recorder.reads, [`json ${handle}`, `png ${handle}`]);

    // A cross-origin read is refused before the service runs.
    const crossOrigin = await fetch(`${origin}${cardPath(handle, "json")}`, {
      headers: { ...session, Origin: `http://127.0.0.1:1` },
    });
    assert.equal(crossOrigin.status, 401);
    // A query the contract does not admit is refused before dispatch: an extra
    // parameter, a format the contract does not declare, and a bare read with no
    // format at all (the form is named, never defaulted).
    const withQuery = await fetch(`${origin}${cardPath(handle, "json")}&x=1`, { headers: session });
    assert.equal(withQuery.status, 400);
    const badFormat = await fetch(`${origin}${cardPath(handle, "webp")}`, { headers: session });
    assert.equal(badFormat.status, 400);
    const noFormat = await fetch(`${origin}/api/tavern/v1/companions/${handle}/card`, { headers: session });
    assert.equal(noFormat.status, 400);
    const repeatedFormat = await fetch(`${origin}${cardPath(handle, "json")}&format=png`, { headers: session });
    assert.equal(repeatedFormat.status, 400);

    // A handle this mount never handed out: the service answers null, and the
    // route reports a companion that is not there rather than borrowing another.
    const unknown = await fetch(`${origin}${cardPath(unknownHandle, "json")}`, { headers: session });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code: string }).code, "companion_not_found");

    // A record that cannot be read is a durable fact, not a retryable outage.
    const unreadable = await fetch(`${origin}${cardPath(unreadableHandle, "json")}`, { headers: session });
    assert.equal(unreadable.status, 503);
    assert.equal(((await unreadable.json()) as { code: string }).code, "companion_record_unreadable");

    // A card too large to import back is its own refusal, not a generic failure.
    const tooLarge = await fetch(`${origin}${cardPath(tooLargeHandle, "json")}`, { headers: session });
    assert.equal(tooLarge.status, 409);
    assert.equal(((await tooLarge.json()) as { code: string }).code, "companion_card_too_large");

    // A companion with no picture gets the PNG form's own refusal, named: the Host
    // does not invent an image, and the JSON card is the form that carries her.
    const noPicture = await fetch(`${origin}${cardPath(noPictureHandle, "png")}`, { headers: session });
    assert.equal(noPicture.status, 409);
    assert.equal(((await noPicture.json()) as { code: string }).code, "companion_card_image_absent");
  } finally {
    await server.close();
  }
});

test("the card export route is absent when the profile does not declare it, and composition fails closed without the service", async () => {
  const recorder = { reads: [] as string[] };
  // The base management profile does NOT declare `companion.card.export`, so the route
  // the browser calls is not served even though the service was injected.
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: service({ lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 }),
    worldInfoService: worldInfoService(),
    playerPreferenceStore: voicePreferenceStore,
    companionCardExportService: cardExportService(recorder),
    profile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const refused = await fetch(`${origin}/api/tavern/v1/companions/${handle}/card?format=json`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(refused.status, 404);
    assert.equal(((await refused.json()) as { code: string }).code, "profile_operation_unavailable");
    assert.deepEqual(recorder.reads, []);
  } finally {
    await server.close();
  }

  // A profile that advertises the route without the bound service fails closed at
  // composition, so the browser is never shown a control the Host cannot serve.
  // Every other service the profile's routes need is injected, so the only missing
  // one is the export's own.
  assert.throws(
    () =>
      createTavernManagementDialogueWebRequestHandler({
        managementStateFacade: facade,
        managementService: service({ lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 }),
        worldInfoService: worldInfoService(),
        playerPreferenceStore: voicePreferenceStore,
        profile: exportOnlyProfile,
        bootstrapToken: token,
      }),
    /tavern_management_composition_unavailable/,
  );
});

/**
 * The three authored records say WHICH record moved.
 *
 * `persona_conflict`, `scenario_conflict` and `greeting_conflict` were declared by the
 * contract's `ProblemCode` union, published in `TAVERN_BROWSER_PROBLEM_CODES_V1`, mirrored
 * by both browser clients and worded in the catalogue ("This changed while you were
 * working") - and no producer could emit any of them. The three management services do
 * throw `persona_revision_conflict` / `scenario_revision_conflict` /
 * `greeting_revision_conflict` (`persona-management.ts:54`, `scenario-management.ts:61`,
 * `greeting-management.ts:55`), but `problemFor` had no branch for those messages, so a
 * stale save fell through to the catch-all and answered `state_reconciliation_required`:
 * the player was told the CHAT state could not be reconciled, which is a false statement
 * about which record moved, and a client that keyed its re-read on the conflict could
 * never have seen one.
 *
 * This drives the real dispatcher over a real loopback server with the real management
 * services over a real artifact store: a save at a stale revision is a 409 that names the
 * record, and the record is unchanged afterwards. The three cases are enumerated from one
 * table so a fourth authored record cannot be added without landing here.
 */
const authoredRecords = [
  {
    name: "persona",
    path: "/api/tavern/v1/persona",
    conflict: "persona_conflict",
    create: { name: "Alex", description: "A calm farmer" },
    stale: { name: "Alex, rewritten", description: "This must not land." },
  },
  {
    name: "scenario",
    path: "/api/tavern/v1/scenario",
    conflict: "scenario_conflict",
    create: { name: "Saloon evening", description: "A quiet evening at the Stardrop Saloon." },
    stale: { name: "Rainy evening", description: "This must not land." },
  },
  {
    name: "greeting",
    path: "/api/tavern/v1/greeting",
    conflict: "greeting_conflict",
    create: { label: "Default", variants: [{ label: "Default", text: "The valley is quiet." }] },
    stale: { label: "Rainy", variants: [{ label: "Rainy", text: "This must not land." }] },
  },
] as const;

test("a stale persona, scenario or greeting save names the record that moved, not the chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-authored-conflict-"));
  try {
    const artifactStore = new TavernArtifactStore(root);
    const server = await startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: service({ lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 }),
      worldInfoService: worldInfoService(),
      playerPreferenceStore: voicePreferenceStore,
      libraryService: Object.freeze({
        async listCompanions() {
          return [{ handle, name: "琥珀", isCurrent: true }];
        },
      }),
      // The REAL services, so the refusal is the one the durable artifact store raises.
      personaService: createPersonaManagementService(artifactStore, root),
      scenarioService: withScenarioSurfaceMacros(createScenarioManagementService(artifactStore, root), async () =>
        macroTable({ char: "琥珀", user: "阿岚" }),
      ),
      greetingService: createGreetingManagementService(artifactStore, root),
      profile: charactersProfile,
      bootstrapToken: token,
    });
    try {
      const origin = server.origin;
      const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
      });
      assert.equal(bootstrap.status, 200);
      const snapshot = (await bootstrap.json()) as { csrfToken: string };
      const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
      const writes = {
        Origin: origin,
        Cookie: cookie,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
      };

      for (const record of authoredRecords) {
        // The first save mints revision 1 through the same control (`expectedRevision: 0`).
        const created = await fetch(`${origin}${record.path}`, {
          method: "PUT",
          headers: writes,
          body: JSON.stringify({ apiVersion: 1, expectedRevision: 0, ...record.create }),
        });
        assert.equal(created.status, 200, `${record.name}: the first save must land`);
        assert.equal(((await created.json()) as { revision: number }).revision, 1);

        // A second save at the SAME revision is stale by one: another tab (or an earlier
        // save) moved the record, and the refusal must name the record it was about.
        const stale = await fetch(`${origin}${record.path}`, {
          method: "PUT",
          headers: writes,
          body: JSON.stringify({ apiVersion: 1, expectedRevision: 0, ...record.stale }),
        });
        assert.equal(stale.status, 409, `${record.name}: a stale save is a conflict`);
        assert.equal(
          ((await stale.json()) as { code: string }).code,
          record.conflict,
          `${record.name}: the refusal must name the record that moved, not the chat`,
        );

        // …and it changed nothing: the next save at the revision the read carries succeeds.
        const read = await fetch(`${origin}${record.path}`, {
          headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
        });
        assert.equal(read.status, 200);
        assert.equal(
          ((await read.json()) as { revision: number }).revision,
          1,
          `${record.name}: a refused save never advanced the record`,
        );
      }
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
