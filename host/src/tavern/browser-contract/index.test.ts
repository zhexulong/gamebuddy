import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import {
  BrowserEventV1Schema,
  composeTavernProfile,
  isComposedTavernProfile,
  SubmitMessageCommandV1Schema,
  TAVERN_BROWSER_API_V1,
  TAVERN_BROWSER_PROBLEM_CODES_V1,
  TavernBrowserContractV1,
  TavernBrowserFixtureV1,
  TavernBrowserValidatorsV1,
} from "./index.js";

const handle = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
const idempotencyKey = "ABEiM0RVZneImaq7zN3u_w";

const submit = (text: string) => ({ apiVersion: 1, selectionGeneration: 1, text, locale: "en" });

test("Tavern Browser v1 provides a bounded, unmounted Chat Core registry", () => {
  assert.equal(TavernBrowserContractV1.id, TAVERN_BROWSER_API_V1);
  assert.deepEqual(
    TavernBrowserContractV1.routes.map((route) => route.routeId),
    [
      "bootstrap",
      "state.read",
      "draft.read",
      "draft.save",
      "draft.discard",
      "chat.submit",
      "chat.submission_status",
      "chat.list",
      "chat.rename",
      "chat.cancel",
      "memory.read",
      "memory.mutate",
      "world-info.read",
      "world-info.bind",
      "events",
    ],
  );
  assert.ok(TavernBrowserContractV1.routes.every((route) => route.path.startsWith("/api/tavern/v1/")));
  assert.equal("mount" in TavernBrowserContractV1, false);
  assert.deepEqual(Object.keys(TavernBrowserValidatorsV1).sort(), Object.keys(TavernBrowserContractV1.schemas).sort());
});

test("text format accepts NFC astral Unicode and enforces NFC plus exact UTF-8 byte boundaries", () => {
  const validator = Compile(SubmitMessageCommandV1Schema);
  assert.equal(validator.Check(submit("😀 café 𐐷")), true);
  assert.equal(validator.Check(submit("cafe\u0301")), false);
  assert.equal(validator.Check(submit("😀".repeat(4096))), true);
  assert.equal(validator.Check(submit("😀".repeat(4097))), false);
  assert.equal(validator.Check(submit("a".repeat(16_384))), true);
  assert.equal(validator.Check(submit("a".repeat(16_385))), false);
});

test("text format rejects unpaired UTF-16 surrogates before normalization and UTF-8 sizing", () => {
  const validator = Compile(SubmitMessageCommandV1Schema);
  assert.equal(validator.Check(submit("\ud800")), false);
  assert.equal(validator.Check(submit("\udc00")), false);
  assert.equal(validator.Check(submit("😀")), true);
});

test("opaque values are canonical unpadded base64url and idempotency is exactly a canonical 128-bit value", () => {
  const state = TavernBrowserFixtureV1.snapshot();
  assert.equal(TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(state), true);
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({ ...state, csrfToken: `${handle}=` }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({ ...state, csrfToken: `${handle.slice(0, -1)}B` }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.MessageSubmissionStatusQueryV1Schema.Check({
      apiVersion: 1,
      selectionGeneration: 1,
      idempotencyKey,
    }),
    true,
  );
  assert.equal(
    TavernBrowserValidatorsV1.MessageSubmissionStatusQueryV1Schema.Check({
      apiVersion: 1,
      selectionGeneration: 1,
      idempotencyKey: `${idempotencyKey}=`,
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.MessageSubmissionStatusQueryV1Schema.Check({
      apiVersion: 1,
      selectionGeneration: 1,
      idempotencyKey: `${idempotencyKey.slice(0, -1)}B`,
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.MessageSubmissionStatusQueryV1Schema.Check({
      apiVersion: 1,
      selectionGeneration: 1,
      idempotencyKey: idempotencyKey.slice(0, -1),
    }),
    false,
  );
});

test("problem codes and events are closed unions", () => {
  assert.equal(
    TavernBrowserValidatorsV1.TavernProblemV1Schema.Check({
      type: "about:blank",
      title: "Bad request",
      status: 400,
      code: "invalid_request",
      requestId: handle,
      retryable: false,
    }),
    true,
  );
  assert.equal(
    TavernBrowserValidatorsV1.TavernProblemV1Schema.Check({
      type: "about:blank",
      title: "Bad request",
      status: 400,
      code: "invented_code",
      requestId: handle,
      retryable: false,
    }),
    false,
  );
  assert.deepEqual(TAVERN_BROWSER_PROBLEM_CODES_V1.includes("invented_code" as never), false);
  const event = Compile(BrowserEventV1Schema);
  const base = { apiVersion: 1, epoch: handle, sequence: 1, selectionGeneration: 1 };
  assert.equal(event.Check({ ...base, eventType: "draft.changed", payload: { revision: 1, present: true } }), true);
  assert.equal(event.Check({ ...base, eventType: "turn.changed", payload: { revision: 1, present: true } }), false);
});

test("chat list is metadata-only with opaque handles and an exact active status", () => {
  const list = {
    apiVersion: 1,
    chats: [
      {
        handle,
        title: "Mounted Chat",
        status: "active",
        managementRevision: 3,
        isSelected: true,
      },
    ],
  };
  assert.equal(TavernBrowserValidatorsV1.ChatListV1Schema.Check(list), true);
  assert.equal(
    TavernBrowserValidatorsV1.ChatListV1Schema.Check({
      ...list,
      chats: [{ ...list.chats[0], handle: "not-base64url!" }],
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.ChatListV1Schema.Check({
      ...list,
      chats: [{ ...list.chats[0], status: "archived" }],
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.ChatListV1Schema.Check({
      ...list,
      chats: [{ ...list.chats[0], chatThreadId: "thread_01" }],
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.ChatListV1Schema.Check({
      ...list,
      chats: Array.from({ length: 101 }, () => list.chats[0]),
    }),
    false,
  );
  assert.equal(TavernBrowserValidatorsV1.ChatListQueryV1Schema.Check({ apiVersion: 1, state: "active" }), true);
  assert.equal(TavernBrowserValidatorsV1.ChatListQueryV1Schema.Check({ apiVersion: 1, state: "trashed" }), false);
  assert.equal(TavernBrowserValidatorsV1.ChatListQueryV1Schema.Check({ apiVersion: 1 }), true);
});

test("memory read projection contains only safe bounded rows and validates strict shape", () => {
  const memory = {
    apiVersion: 1,
    projectionRevision: handle,
    memories: [
      {
        handle,
        title: "The farmer loves blueberries",
        content: "The farmer loves blueberries.",
        category: "semantic",
        status: "active",
        pinned: false,
      },
    ],
  };
  assert.equal(TavernBrowserValidatorsV1.MemoryReadV1Schema.Check(memory), true);
  // Raw stateToken is never a projected field.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: [{ ...memory.memories[0], stateToken: "tok_abc" }],
    }),
    false,
  );
  // Handle must be a valid opaque handle.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: [{ ...memory.memories[0], handle: "invalid" }],
    }),
    false,
  );
  // All six safe fields are required; extra fields are rejected.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: [{ ...memory.memories[0], extra: true }],
    }),
    false,
  );
  // Missing handle is rejected.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: [{ title: "No handle", content: "content", category: "semantic", status: "active", pinned: false }],
    }),
    false,
  );
  // Max 200 items.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: Array.from({ length: 201 }, () => ({
        handle,
        title: "row",
        content: "content",
        category: "semantic" as const,
        status: "active" as const,
        pinned: false,
      })),
    }),
    false,
  );
  // Exactly 200 items is allowed.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: Array.from({ length: 200 }, (_, i) => ({
        handle,
        title: `row ${i}`,
        content: `content ${i}`,
        category: "semantic" as const,
        status: "active" as const,
        pinned: false,
      })),
    }),
    true,
  );
  // Title length 0 is rejected.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: [{ ...memory.memories[0], title: "" }],
    }),
    false,
  );
  // Title longer than 256 is rejected.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: [{ ...memory.memories[0], title: "x".repeat(257) }],
    }),
    false,
  );
  // Category must be one of the two frozen values.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: [{ ...memory.memories[0], category: "recent" }],
    }),
    false,
  );
  // Status must be one of the three frozen values.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: [{ ...memory.memories[0], status: "removed" }],
    }),
    false,
  );
  // projectionRevision is not a storage revision.
  assert.equal(TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({ ...memory, projectionRevision: 42 }), false);
  // Null projectionRevision is rejected (must be opaque handle).
  assert.equal(TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({ ...memory, projectionRevision: null }), false);
});

test("memory mutation command is a strict ordinary CRUD CAS command", () => {
  const create = {
    apiVersion: 1,
    operation: "create",
    expectedProjectionRevision: handle,
    content: "Player-managed semantic memory",
  };
  const update = { ...create, operation: "update", handle };
  const archive = {
    apiVersion: 1,
    operation: "archive",
    expectedProjectionRevision: handle,
    handle,
  };
  assert.equal(TavernBrowserValidatorsV1.MemoryMutationCommandV1Schema.Check(create), true);
  assert.equal(TavernBrowserValidatorsV1.MemoryMutationCommandV1Schema.Check(update), true);
  assert.equal(TavernBrowserValidatorsV1.MemoryMutationCommandV1Schema.Check(archive), true);
  assert.equal(TavernBrowserValidatorsV1.MemoryMutationCommandV1Schema.Check({ ...create, handle }), false);
  assert.equal(
    TavernBrowserValidatorsV1.MemoryMutationCommandV1Schema.Check({ ...archive, content: "unexpected" }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.MemoryMutationCommandV1Schema.Check({
      ...create,
      expectedProjectionRevision: "opaque-but-not-canonical=",
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.MemoryMutationCommandV1Schema.Check({ ...create, content: "cafe\u0301" }),
    false,
  );
});

test("memory state requires a read-backed opaque projection revision before it can advertise CRUD", () => {
  const state = TavernBrowserFixtureV1.snapshot();
  assert.equal(state.memory.readAvailable, false);
  assert.equal(state.memory.mutationAvailable, false);
  assert.equal(state.memory.projectionRevision, null);
  assert.equal(TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(state), true);
  // When a projectionRevision is available, readAvailable must be true.
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({
      ...state,
      memory: { readAvailable: true, mutationAvailable: false, projectionRevision: handle },
    }),
    true,
  );
  // Mutation cannot be advertised without a successful same-snapshot read.
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({
      ...state,
      memory: { readAvailable: false, mutationAvailable: true, projectionRevision: null },
    }),
    false,
  );
  // Nor can a failed read retain a stale opaque revision.
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({
      ...state,
      memory: { readAvailable: false, mutationAvailable: false, projectionRevision: handle },
    }),
    false,
  );
});

test("title rename binds exact selection, generation, revision and bounded NFC title", () => {
  const command = {
    apiVersion: 1,
    selectionGeneration: 1,
    chatHandle: handle,
    expectedManagementRevision: 3,
    title: "Farm Morning Chat",
  };
  assert.equal(TavernBrowserValidatorsV1.RenameChatTitleCommandV1Schema.Check(command), true);
  assert.equal(
    TavernBrowserValidatorsV1.RenameChatTitleCommandV1Schema.Check({ ...command, selectionGeneration: 0 }),
    false,
  );
  assert.equal(TavernBrowserValidatorsV1.RenameChatTitleCommandV1Schema.Check({ ...command, chatHandle: "A" }), false);
  assert.equal(
    TavernBrowserValidatorsV1.RenameChatTitleCommandV1Schema.Check({ ...command, expectedManagementRevision: -1 }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.RenameChatTitleCommandV1Schema.Check({ ...command, title: "cafe\u0301" }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.RenameChatTitleCommandV1Schema.Check({ ...command, title: "a".repeat(121) }),
    false,
  );
  const result = { apiVersion: 1, title: "Farm Morning Chat", managementRevision: 4 };
  assert.equal(TavernBrowserValidatorsV1.ChatTitleV1Schema.Check(result), true);
  assert.equal(
    TavernBrowserValidatorsV1.ChatTitleV1Schema.Check({ ...result, managementRevision: 4, extra: true }),
    false,
  );
});

test("profiles strictly own contract-declared route, operation, and navigation capabilities", () => {
  const p3RouteIds = ["bootstrap", "state.read", "draft.read"];
  const profile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.p3",
    releaseTier: "chat_core",
    routeIds: p3RouteIds,
    operationIds: [],
    navigationItemIds: ["chat"],
  });
  assert.deepEqual(profile.routeIds, p3RouteIds);
  assert.deepEqual(profile.operationIds, []);
  assert.deepEqual(profile.navigationItemIds, ["chat"]);
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.routeIds), true);
  assert.equal(Object.isFrozen(profile.operationIds), true);
  assert.equal(Object.isFrozen(profile.navigationItemIds), true);
  assert.equal(profile.routeIds.includes("events"), false);
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core.missing-submit-route",
        releaseTier: "chat_core",
        routeIds: ["bootstrap", "state.read", "draft.read"],
        operationIds: ["chat.submit"],
        navigationItemIds: ["chat"],
      }),
    /operation route is unavailable in the profile/,
  );
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core.missing-submit-operation",
        releaseTier: "chat_core",
        routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit"],
        operationIds: [],
        navigationItemIds: ["chat"],
      }),
    /route operation is unavailable in the profile/,
  );
  const submitProfile = composeTavernProfile({
    profileId: "chat-core.submit",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit"],
    operationIds: ["chat.submit"],
    navigationItemIds: ["chat"],
  });
  assert.deepEqual(submitProfile.operationIds, ["chat.submit"]);
  assert.deepEqual(submitProfile.routeIds, ["bootstrap", "state.read", "draft.read", "chat.submit"]);
  assert.deepEqual(
    TavernBrowserContractV1.routes
      .filter((route) => (route as { readonly operationId?: unknown }).operationId !== undefined)
      .map((route) => route.routeId)
      .filter((routeId) => profile.routeIds.includes(routeId)),
    [],
  );
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core",
        releaseTier: "chat_core",
        operationIds: [],
        navigationItemIds: [],
      }),
    /capability slice/,
  );
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core",
        releaseTier: "chat_core",
        routeIds: "bootstrap",
        operationIds: [],
        navigationItemIds: [],
      }),
    /routes are invalid/,
  );
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core",
        releaseTier: "chat_core",
        routeIds: ["invented"],
        operationIds: [],
        navigationItemIds: [],
      }),
    /not declared by the contract/,
  );
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core",
        releaseTier: "chat_core",
        routeIds: ["bootstrap", "bootstrap"],
        operationIds: [],
        navigationItemIds: [],
      }),
    /route is duplicated/,
  );
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core",
        releaseTier: "chat_core",
        routeIds: [],
        operationIds: [],
        navigationItemIds: ["chat"],
        extra: true,
      }),
    /capability slice/,
  );
  const exactProfile = () => ({
    profileId: "chat-core",
    releaseTier: "chat_core" as const,
    routeIds: [],
    operationIds: [],
    navigationItemIds: [],
  });
  const symbolExtra = exactProfile();
  Object.defineProperty(symbolExtra, Symbol("extra"), { value: true, enumerable: false });
  assert.throws(() => composeTavernProfile(symbolExtra), /capability slice/);
  const hiddenExtra = exactProfile();
  Object.defineProperty(hiddenExtra, "hidden", { value: true, enumerable: false });
  assert.throws(() => composeTavernProfile(hiddenExtra), /capability slice/);
  const accessorField = exactProfile();
  Object.defineProperty(accessorField, "profileId", { enumerable: true, get: () => "chat-core" });
  assert.throws(() => composeTavernProfile(accessorField), /capability slice/);
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core",
        releaseTier: "tavern_management",
        routeIds: [],
        operationIds: ["memory.read"],
        navigationItemIds: [],
      }),
    /not bound to a route/,
  );
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core",
        releaseTier: "chat_core",
        routeIds: [],
        operationIds: ["chat.submit", "chat.submit"],
        navigationItemIds: [],
      }),
    /duplicated/,
  );
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core",
        releaseTier: "chat_core",
        routeIds: [],
        operationIds: [],
        navigationItemIds: ["invented"],
      }),
    /not declared by the contract/,
  );
  assert.throws(
    () =>
      composeTavernProfile({
        profileId: "chat-core",
        releaseTier: "chat_core",
        routeIds: [],
        operationIds: [],
        navigationItemIds: ["chat", "chat"],
      }),
    /duplicated/,
  );
  assert.throws(
    () => composeTavernProfile({ id: "selected_l3_v1", must: [], later: [], unsupported: [] }),
    /capability slice/,
  );
});

test("composeTavernProfile brands only its own frozen objects; structural clones are not composed", () => {
  const profile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.brand",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read"],
    operationIds: [],
    navigationItemIds: [],
  });
  assert.equal(isComposedTavernProfile(profile), true);
  assert.equal(isComposedTavernProfile(Object.freeze({ ...profile })), false);
  assert.equal(isComposedTavernProfile({ ...profile }), false);
  assert.equal(isComposedTavernProfile(null), false);
  assert.equal(isComposedTavernProfile({}), false);
  assert.equal(isComposedTavernProfile([]), false);
});

test("snapshot event stream permits absent pre-P7 capability but rejects malformed mounted stream", () => {
  const state = TavernBrowserFixtureV1.snapshot();
  assert.equal(state.eventStream, null);
  assert.equal(TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(state), true);
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({ ...state, eventStream: { epoch: handle } }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({
      ...state,
      eventStream: { epoch: handle, cursor: 1 },
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({
      ...state,
      eventStream: { epoch: handle, cursor: handle, extra: true },
    }),
    false,
  );
});

test("every route freezes the exact security, binding, and success policy matrix", () => {
  const expected = [
    [
      "bootstrap",
      "POST",
      "/api/tavern/v1/bootstrap",
      "bootstrap_token",
      "same-origin",
      "none",
      "none",
      [],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "state.read",
      "GET",
      "/api/tavern/v1/state",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "draft.read",
      "GET",
      "/api/tavern/v1/draft",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "draft.save",
      "PUT",
      "/api/tavern/v1/draft",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "draft.discard",
      "DELETE",
      "/api/tavern/v1/draft",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "chat.submit",
      "POST",
      "/api/tavern/v1/messages",
      "browser_session",
      "same-origin",
      "required",
      "required",
      ["x-csrf-token", "idempotency-key"],
      [],
      [],
      202,
      "application/json",
    ],
    [
      "chat.submission_status",
      "POST",
      "/api/tavern/v1/message-submission-status",
      "browser_session",
      "same-origin",
      "none",
      "query_key",
      [],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "chat.list",
      "GET",
      "/api/tavern/v1/chats",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      [],
      ["apiVersion", "state"],
      200,
      "application/json",
    ],
    [
      "chat.rename",
      "PUT",
      "/api/tavern/v1/chat/title",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "chat.cancel",
      "POST",
      "/api/tavern/v1/turns/:turnHandle/cancel",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["turnHandle"],
      [],
      200,
      "application/json",
    ],
    [
      "memory.read",
      "GET",
      "/api/tavern/v1/memory",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "memory.mutate",
      "PUT",
      "/api/tavern/v1/memory",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "world-info.read",
      "GET",
      "/api/tavern/v1/world-info",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "world-info.bind",
      "PUT",
      "/api/tavern/v1/world-info",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      [],
      [],
      200,
      "application/json",
    ],
    [
      "events",
      "GET",
      "/api/tavern/v1/events",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      [],
      ["apiVersion", "cursor"],
      200,
      "text/event-stream",
    ],
  ];
  assert.deepEqual(
    TavernBrowserContractV1.routes.map((route) => [
      route.routeId,
      route.method,
      route.path,
      route.auth,
      route.origin,
      route.csrf,
      route.idempotency,
      Object.keys(route.headers.properties),
      Object.keys(route.pathParams.properties),
      Object.keys(route.query.properties),
      route.success.status,
      route.success.contentType,
    ]),
    expected,
  );
  for (const route of TavernBrowserContractV1.routes) {
    assert.ok(route.headers && route.pathParams && route.query);
    assert.ok(route.success.schema);
  }
  assert.deepEqual(TavernBrowserContractV1.static, {
    shell: { method: "GET", path: "/", auth: "none", origin: "same-origin", contentType: "text/html" },
    assets: {
      method: "GET",
      path: "/assets/:assetPath",
      auth: "none",
      origin: "same-origin",
      contentType: "application/javascript|text/css|image/*|font/*",
    },
  });
});
