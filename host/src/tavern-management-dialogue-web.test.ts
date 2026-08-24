import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  composeTavernProfile,
  TavernBrowserValidatorsV1,
  type MemoryMutationCommandV1,
  type MemoryReadV1,
  type WorldInfoStateV1,
} from "./tavern/browser-contract/index.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import type { MemoryManagementService } from "./tavern/memory-management/memory-management.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import {
  createTavernManagementDialogueWebRequestHandler,
  startTavernManagementDialogueWebServer,
} from "./tavern-management-dialogue-web.js";

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
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
  ],
  operationIds: ["draft.save", "draft.discard", "chat.rename", "world-info.bind"],
  navigationItemIds: ["chat"],
});

const state: TavernManagementState = {
  selection: {
    chatHandle: handle,
    generation: 1,
    stateRevision: handle,
  },
  companionDisplayName: "Mira",
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
  ],
  operationIds: ["draft.save", "draft.discard", "chat.rename", "memory.mutate", "world-info.bind"],
  navigationItemIds: ["chat", "memory"],
});

const memoryReadStub: MemoryReadV1 = Object.freeze({
  apiVersion: 1,
  projectionRevision: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  memories: Object.freeze([
    Object.freeze({
      handle: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
      title: "Semantic memory",
      content: "Visible player memory",
      category: "semantic",
      status: "active",
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
    },
  ],
};

function worldInfoService(recorder?: {
  reads?: number;
  sets?: number;
  closes?: number;
  readError?: Error;
  setError?: Error;
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
    async close() {
      counters.closes = (counters.closes ?? 0) + 1;
    },
  });
}

function service(recorder: {
  lists: number;
  renames: number;
  draftReads: number;
  draftSaves: number;
  draftDiscards: number;
  closes: number;
  renameError?: Error;
  draftError?: Error;
}): ChatManagementService {
  return Object.freeze({
    async readDraft() {
      recorder.draftReads += 1;
      if (recorder.draftError !== undefined) throw recorder.draftError;
      return { apiVersion: 1, revision: state.draft.revision, text: state.draft.text };
    },
    async saveDraft(command) {
      recorder.draftSaves += 1;
      if (recorder.draftError !== undefined) throw recorder.draftError;
      return { apiVersion: 1, revision: command.expectedRevision + 1, text: command.text };
    },
    async discardDraft(command) {
      recorder.draftDiscards += 1;
      if (recorder.draftError !== undefined) throw recorder.draftError;
      return { apiVersion: 1, revision: command.expectedRevision + 1, text: null };
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
        text: "Remember the orchard",
      }),
    });
    assert.equal(draftSave.status, 200);
    assert.deepEqual(await draftSave.json(), { apiVersion: 1, revision: 1, text: "Remember the orchard" });

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
        selectionGeneration: 1,
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

test("management handler maps foreign binding, wrong generation and stale revision to existing problem semantics", async () => {
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
        selectionGeneration: 1,
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
  assert.equal(await problemFor(rename({ selectionGeneration: 99 })), "selection_conflict");
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
            selectionGeneration: 1,
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
            selectionGeneration: 1,
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
          { apiVersion: 1, selectionGeneration: 1, chatHandle: handle, expectedManagementRevision: 1 },
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

class ControlledResponse extends EventEmitter {
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  readonly headers = new Map<string, string>();
  status = 0;
  body = "";
  constructor(private readonly outcome: "finish" | "premature_close") {
    super();
  }
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  writeHead(status: number): void {
    this.status = status;
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
  const encoded = hasBody ? JSON.stringify(body) : "";
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
