import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import {
  BrowserEventV1Schema,
  CHAT_LIST_PREVIEW_MAX_LENGTH,
  chatListPreviewText,
  composeTavernProfile,
  isComposedTavernProfile,
  SubmitMessageCommandV1Schema,
  TAVERN_BROWSER_API_V1,
  TAVERN_BROWSER_PROBLEM_CODES_V1,
  TavernBrowserContractV1,
  TavernBrowserFixtureV1,
  TavernBrowserValidatorsV1,
  TavernCompanionLocaleV1Schema,
  TavernVoicePersonaV1Schema,
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
      "chat.opening",
      "chat.create",
      "chat.select",
      "chat.cancel",
      "chat.swipe",
      "chat.regenerate",
      "chat.rewind",
      "memory.read",
      "memory.mutate",
      "world-info.read",
      "world-info.bind",
      "world-info.detail",
      "world-info.create",
      "world-info.update",
      "world-info.delete",
      "settings.voice.read",
      "settings.voice.consent",
      "settings.voice.devices",
      "settings.language.read",
      "settings.language.update",
      "settings.connection.read",
      "settings.connection.create",
      "settings.connection.test",
      "settings.connection.activate",
      "settings.connection.model",
      "settings.connection.remove",
      "settings.profiles.read",
      "settings.profiles.update",
      "events",
      "companion.list",
      "companion.worldbook.read",
      "companion.profile.read",
      "companion.create",
      "character.voice.read",
      "character.voice.update",
      "character.import.stage",
      "character.import.read",
      "character.import.review",
      "character.import.confirm",
      "character.import.history",
      "persona.read",
      "persona.update",
      "scenario.read",
      "scenario.update",
      "greeting.read",
      "greeting.update",
      "chat.archive",
      "chat.restore",
      "chat.trash",
    ],
  );
  assert.ok(TavernBrowserContractV1.routes.every((route) => route.path.startsWith("/api/tavern/v1/")));
  assert.equal("mount" in TavernBrowserContractV1, false);
  assert.deepEqual(Object.keys(TavernBrowserValidatorsV1).sort(), Object.keys(TavernBrowserContractV1.schemas).sort());
});

/**
 * The wire API-shape union and the runtime's own adapter list are one
 * vocabulary. The frozen contract cannot import `tavern/provider-catalog.ts`
 * (the browser client loads this module directly, so it stays
 * dependency-free), so this test is the pin that keeps the two from drifting:
 * a shape the escape hatch may choose is exactly a shape Pi can speak.
 */
test("the wire API-shape union is exactly the runtime's own adapter set", async () => {
  const { TAVERN_PI_API_SHAPES } = await import("../provider-catalog.js");
  const declared = TavernBrowserContractV1.schemas.TavernConnectionApiShapeV1Schema.anyOf.map(
    (member) => (member as { readonly const: string }).const,
  );
  assert.deepEqual(declared, [...TAVERN_PI_API_SHAPES]);

  // The escape hatch's create command admits every one of them and nothing
  // else: a garbage shape must never reach the runtime's provider entry.
  const create = TavernBrowserValidatorsV1.TavernConnectionCreateCommandV1Schema;
  for (const apiShape of declared)
    assert.equal(
      create.Check({ apiVersion: 1, providerId: "gamebuddy-openai-compatible", apiShape }),
      true,
      `expected ${apiShape} to be a valid shape`,
    );
  for (const apiShape of ["invented-messages", "openai", "Anthropic-Messages", "", " openai-responses"])
    assert.equal(
      create.Check({ apiVersion: 1, providerId: "gamebuddy-openai-compatible", apiShape }),
      false,
      `expected ${JSON.stringify(apiShape)} to be refused`,
    );
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
  // The connection surface's problem codes are part of the same closed union,
  // so the browser can rely on each one meaning exactly one thing.
  for (const code of [
    "dialogue_busy",
    "connection_not_found",
    "connection_not_ready",
    "connection_conflict",
    "connection_limit_reached",
    // The rewind refusals are the same kind of closed vocabulary: each names one point the player
    // asked for and nothing else, so the surface can say which one happened.
    "chat_message_not_found",
    "chat_message_revision_conflict",
    "chat_rewind_opening_retained",
    "chat_rewind_turn_active",
  ] as const) {
    assert.equal(TAVERN_BROWSER_PROBLEM_CODES_V1.includes(code), true, code);
    assert.equal(
      TavernBrowserValidatorsV1.TavernProblemV1Schema.Check({
        type: `urn:gamebuddy:tavern:${code}`,
        title: code.replaceAll("_", " "),
        status: 409,
        code,
        requestId: handle,
        retryable: false,
      }),
      true,
      code,
    );
  }
  const event = Compile(BrowserEventV1Schema);
  const base = { apiVersion: 1, epoch: handle, sequence: 1, selectionGeneration: 1 };
  assert.equal(event.Check({ ...base, eventType: "draft.changed", payload: { revision: 1, present: true } }), true);
  assert.equal(
    event.Check({
      ...base,
      eventType: "companion.delta",
      payload: { turnHandle: handle, delta: "Hi" },
    }),
    true,
  );
  assert.equal(
    event.Check({
      ...base,
      eventType: "companion.delta",
      payload: { turnHandle: "not-opaque", delta: "Hi", text: "forged" },
    }),
    false,
  );
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
        updatedAtMs: 1_760_000_000_000,
        preview: "The parsnips took. All of them, by the look of it.",
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

/**
 * The row's two identity facts are required, not decoration: a Host that omitted
 * either would put the list back where it was - every row reading `New chat` with
 * nothing to tell one from another. The bounds are the contract's own.
 */
test("chat list row requires its durable time and a bounded preview", () => {
  const row = {
    handle,
    title: null,
    status: "active",
    managementRevision: 1,
    isSelected: false,
    updatedAtMs: 1_760_000_000_000,
    preview: null,
  };
  assert.equal(TavernBrowserValidatorsV1.ChatListEntryV1Schema.Check(row), true);
  const { updatedAtMs: _time, ...withoutTime } = row;
  assert.equal(TavernBrowserValidatorsV1.ChatListEntryV1Schema.Check(withoutTime), false);
  const { preview: _preview, ...withoutPreview } = row;
  assert.equal(TavernBrowserValidatorsV1.ChatListEntryV1Schema.Check(withoutPreview), false);
  assert.equal(TavernBrowserValidatorsV1.ChatListEntryV1Schema.Check({ ...row, updatedAtMs: -1 }), false);
  assert.equal(
    TavernBrowserValidatorsV1.ChatListEntryV1Schema.Check({
      ...row,
      preview: "x".repeat(CHAT_LIST_PREVIEW_MAX_LENGTH + 1),
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.ChatListEntryV1Schema.Check({
      ...row,
      preview: "x".repeat(CHAT_LIST_PREVIEW_MAX_LENGTH),
    }),
    true,
  );
});

/**
 * The preview is prose the player reads on a list row, so it is plain text: an
 * action beat loses its `*` delimiter, a `{{macro}}` run is residue the row must
 * not print, whitespace collapses, and the text is bounded at the contract's own
 * ceiling rather than at the message's.
 */
test("a row preview is plain, collapsed and bounded text", () => {
  assert.equal(
    chatListPreviewText("*The porch lantern is still lit when she comes out.*\n\n{{user}}, the parsnips took."),
    "The porch lantern is still lit when she comes out., the parsnips took.",
  );
  assert.equal(chatListPreviewText("  \n\t  "), null, "markup-only text previews as nothing, not as an empty row");
  assert.equal(chatListPreviewText(null), null);
  const long = "parsnip ".repeat(40).trim();
  const bounded = chatListPreviewText(long)!;
  assert.equal(bounded.length, CHAT_LIST_PREVIEW_MAX_LENGTH);
  assert.equal(bounded.endsWith("…"), true);
  assert.equal(bounded.includes("*"), false);
  assert.equal(bounded.includes("{{"), false);
});

test("memory read projection contains only safe bounded rows and validates strict shape", () => {
  // `chapters` is a real member of the read, not decoration: it is the continuity's narrative
  // chapters. A young continuity legitimately has none - a chapter is folded only once the usable
  // window is about 65% full (~487k tokens) - so an empty list is the expected, valid answer here.
  // The fixture is not "missing" the member; it is asserting that the member exists and that an empty
  // one is a honest projection of "no chapter yet".
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
        origin: "companion",
        pinned: false,
      },
    ],
    chapters: [],
  };
  assert.equal(TavernBrowserValidatorsV1.MemoryReadV1Schema.Check(memory), true);
  // The member is required, not quietly relaxed: a read that omits the continuity's chapters is not a
  // Memory read at all. Accepting one would leave a client unable to tell "no chapters yet" from "the
  // Host dropped them".
  const withoutChapters: Record<string, unknown> = { ...memory };
  delete withoutChapters.chapters;
  assert.equal(TavernBrowserValidatorsV1.MemoryReadV1Schema.Check(withoutChapters), false);
  // A chapter the fold itself wrote validates, ...
  const chapter = {
    handle,
    title: "The first week on the farm",
    span: "2026-10-01→2026-10-03",
    content: "She remembers the first week.",
    status: "sealed",
    editedByPlayer: false,
  };
  assert.equal(TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({ ...memory, chapters: [chapter] }), true);
  // ... the player's own correction is the same shape, distinguished only by status/editedByPlayer, ...
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      chapters: [{ ...chapter, status: "edited", editedByPlayer: true }],
    }),
    true,
  );
  // ... and a chapter carrying a durable identifier the browser never sees is rejected by the same
  // strict shape as a memory row.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({ ...memory, chapters: [{ ...chapter, chapterId: 7 }] }),
    false,
  );
  // The chapter status union stays closed.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({ ...memory, chapters: [{ ...chapter, status: "folded" }] }),
    false,
  );
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
  // All seven safe fields are required; extra fields are rejected.
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
      memories: [
        {
          title: "No handle",
          content: "content",
          category: "semantic",
          status: "active",
          origin: "companion",
          pinned: false,
        },
      ],
    }),
    false,
  );
  // The provenance union is closed: an unknown origin is not a memory.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: [{ ...memory.memories[0], origin: "system" }],
    }),
    false,
  );
  // More than 200 items remain valid; the v1 schema has no row-count ceiling.
  assert.equal(
    TavernBrowserValidatorsV1.MemoryReadV1Schema.Check({
      ...memory,
      memories: Array.from({ length: 800 }, (_, i) => ({
        handle,
        title: `row ${i}`,
        content: `content ${i}`,
        category: "semantic" as const,
        status: "active" as const,
        origin: "companion" as const,
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
  // Additive optional voice surface: absent (old shell) and the three states
  // validate; a forged extra field or unknown state is rejected.
  assert.equal(TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({ ...state, voice: null }), true);
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({ ...state, voice: { state: "unavailable" } }),
    true,
  );
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({ ...state, voice: { state: "ready" } }),
    true,
  );
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({ ...state, voice: { state: "speaking" } }),
    true,
  );
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({ ...state, voice: { state: "bogus" } }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check({ ...state, voice: { state: "ready", extra: 1 } }),
    false,
  );
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
      "chat.opening",
      "PUT",
      "/api/tavern/v1/chat/opening",
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
      "chat.create",
      "POST",
      "/api/tavern/v1/chats",
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
      "chat.select",
      "PUT",
      "/api/tavern/v1/chat/select",
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
      "chat.swipe",
      "POST",
      "/api/tavern/v1/messages/swipe",
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
      "chat.regenerate",
      "POST",
      "/api/tavern/v1/messages/regenerate",
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
      "chat.rewind",
      "POST",
      "/api/tavern/v1/messages/rewind",
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
      "world-info.detail",
      "GET",
      "/api/tavern/v1/world-info/item",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      [],
      ["apiVersion", "selectionGeneration", "expectedRevision", "itemHandle"],
      200,
      "application/json",
    ],
    [
      "world-info.create",
      "POST",
      "/api/tavern/v1/world-info/item",
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
      "world-info.update",
      "PUT",
      "/api/tavern/v1/world-info/item",
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
      "world-info.delete",
      "DELETE",
      "/api/tavern/v1/world-info/item",
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
      "settings.voice.read",
      "GET",
      "/api/tavern/v1/settings/voice-preference",
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
      "settings.voice.consent",
      "PUT",
      "/api/tavern/v1/settings/voice-preference",
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
      "settings.voice.devices",
      "GET",
      "/api/tavern/v1/settings/voice-devices",
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
      "settings.language.read",
      "GET",
      "/api/tavern/v1/settings/language",
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
      "settings.language.update",
      "PUT",
      "/api/tavern/v1/settings/language",
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
      "settings.connection.read",
      "GET",
      "/api/tavern/v1/settings/connection",
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
      "settings.connection.create",
      "POST",
      "/api/tavern/v1/settings/connections",
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
      "settings.connection.test",
      "POST",
      "/api/tavern/v1/settings/connections/:connectionId/test",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["connectionId"],
      [],
      200,
      "application/json",
    ],
    [
      "settings.connection.activate",
      "POST",
      "/api/tavern/v1/settings/connections/:connectionId/activate",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["connectionId"],
      [],
      200,
      "application/json",
    ],
    [
      "settings.connection.model",
      "POST",
      "/api/tavern/v1/settings/connections/:connectionId/model",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["connectionId"],
      [],
      200,
      "application/json",
    ],
    [
      "settings.connection.remove",
      "DELETE",
      "/api/tavern/v1/settings/connections/:connectionId",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["connectionId"],
      [],
      200,
      "application/json",
    ],
    [
      "settings.profiles.read",
      "GET",
      "/api/tavern/v1/settings/profiles",
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
      "settings.profiles.update",
      "PUT",
      "/api/tavern/v1/settings/profiles",
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
    [
      "companion.list",
      "GET",
      "/api/tavern/v1/companions",
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
      "companion.worldbook.read",
      "GET",
      "/api/tavern/v1/companions/:companionHandle/worldbook",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      ["companionHandle"],
      [],
      200,
      "application/json",
    ],
    [
      "companion.profile.read",
      "GET",
      "/api/tavern/v1/companions/:companionHandle/profile",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      ["companionHandle"],
      [],
      200,
      "application/json",
    ],
    [
      "companion.create",
      "POST",
      "/api/tavern/v1/companions",
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
      "character.voice.read",
      "GET",
      "/api/tavern/v1/companions/:companionHandle/voice",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      ["companionHandle"],
      [],
      200,
      "application/json",
    ],
    [
      "character.voice.update",
      "PUT",
      "/api/tavern/v1/companions/:companionHandle/voice",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["companionHandle"],
      [],
      200,
      "application/json",
    ],
    [
      "character.import.stage",
      "POST",
      "/api/tavern/v1/imports",
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
      "character.import.read",
      "GET",
      "/api/tavern/v1/imports/:importId",
      "browser_session",
      "same-origin",
      "none",
      "none",
      [],
      ["importId"],
      [],
      200,
      "application/json",
    ],
    [
      "character.import.review",
      "POST",
      "/api/tavern/v1/imports/:importId/review",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["importId"],
      [],
      200,
      "application/json",
    ],
    [
      "character.import.confirm",
      "POST",
      "/api/tavern/v1/imports/:importId/confirm",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["importId"],
      [],
      200,
      "application/json",
    ],
    [
      "character.import.history",
      "GET",
      "/api/tavern/v1/import-history",
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
      "persona.read",
      "GET",
      "/api/tavern/v1/persona",
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
      "persona.update",
      "PUT",
      "/api/tavern/v1/persona",
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
      "scenario.read",
      "GET",
      "/api/tavern/v1/scenario",
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
      "scenario.update",
      "PUT",
      "/api/tavern/v1/scenario",
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
      "greeting.read",
      "GET",
      "/api/tavern/v1/greeting",
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
      "greeting.update",
      "PUT",
      "/api/tavern/v1/greeting",
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
      "chat.archive",
      "POST",
      "/api/tavern/v1/chats/:chatHandle/archive",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["chatHandle"],
      [],
      200,
      "application/json",
    ],
    [
      "chat.restore",
      "POST",
      "/api/tavern/v1/chats/:chatHandle/restore",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["chatHandle"],
      [],
      200,
      "application/json",
    ],
    [
      "chat.trash",
      "POST",
      "/api/tavern/v1/chats/:chatHandle/trash",
      "browser_session",
      "same-origin",
      "required",
      "none",
      ["x-csrf-token"],
      ["chatHandle"],
      [],
      200,
      "application/json",
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
test("world-info DTO projects a bounded opaque pending state without raw durable facts", () => {
  // The WorldInfoStateV1 projection has no apiVersion member: the route
  // success schema is a strict term and rejects any extra field, including
  // a spurious apiVersion the browser could attach.
  const state = {
    state: "pending",
    revision: handle,
    items: [
      {
        handle,
        title: "Pelican Town",
        summary: "The revised town facts.",
        selected: false,
        pending: true,
      },
    ],
  };
  assert.equal(TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(state), true);
  assert.equal(TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({ ...state, apiVersion: 1 }), false);
  // selected and pending are both required item fields; a raw selected item is
  // only expressible with an explicit pending boolean.
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({
      ...state,
      items: [{ handle, title: "Pelican Town", summary: null, selected: true }],
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({
      ...state,
      items: [{ handle, title: "Pelican Town", summary: null, selected: true, pending: false }],
    }),
    true,
  );
  // Raw durable facts (public title in the opaque revision handle, canonical
  // hash, source id, storage revision) are never expressible in the projection.
  assert.equal(TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({ ...state, revision: "Pelican Town" }), false);
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({
      ...state,
      items: [{ ...state.items[0], canonicalHash: "a".repeat(64) }],
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({
      ...state,
      items: [{ ...state.items[0], source: "managed_world_info" }],
    }),
    false,
  );
  // Opaque handles use the canonical unpadded base64url form, not raw titles
  // and never raw numeric revisions/timestamps.
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({
      ...state,
      items: [{ ...state.items[0], handle: "Pelican Town" }],
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({
      ...state,
      items: [{ ...state.items[0], handle: "1234567890" }],
    }),
    false,
  );
  // Extra fields are rejected; the union of states is closed.
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({
      ...state,
      items: [{ ...state.items[0], extra: true }],
    }),
    false,
  );
  assert.equal(TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({ ...state, state: "locked" }), false);
  // "unavailable" is a member of the closed union; only invented states are
  // rejected. The browser can never itself produce a state string.
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({ ...state, state: "unavailable", items: [] }),
    true,
  );
  assert.equal(TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({ ...state, state: "invented" }), false);
  // Title length and summary bounds are enforced.
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({
      ...state,
      items: [{ ...state.items[0], title: "" }],
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({
      ...state,
      items: [{ ...state.items[0], summary: "x".repeat(513) }],
    }),
    false,
  );
  const unavailable = { state: "unavailable", revision: handle, items: [] };
  assert.equal(TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(unavailable), true);
  assert.equal(TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check({ ...unavailable, revision: "raw" }), false);
});

test("world-info bind command is a strict opaque revision-scoped union", () => {
  const bind = { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, sourceHandle: handle };
  const unbind = { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, sourceHandle: null };
  assert.equal(TavernBrowserValidatorsV1.SetWorldInfoBindingCommandV1Schema.Check(bind), true);
  assert.equal(TavernBrowserValidatorsV1.SetWorldInfoBindingCommandV1Schema.Check(unbind), true);
  // Raw title or numeric/storage revision is never expressible.
  assert.equal(
    TavernBrowserValidatorsV1.SetWorldInfoBindingCommandV1Schema.Check({ ...bind, expectedRevision: "Pelican Town" }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.SetWorldInfoBindingCommandV1Schema.Check({ ...bind, sourceHandle: "Pelican Town" }),
    false,
  );
  assert.equal(TavernBrowserValidatorsV1.SetWorldInfoBindingCommandV1Schema.Check({ ...bind, extra: true }), false);
  assert.equal(
    TavernBrowserValidatorsV1.SetWorldInfoBindingCommandV1Schema.Check({ ...bind, selectionGeneration: 0 }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.SetWorldInfoBindingCommandV1Schema.Check({ ...bind, sourceHandle: `${handle}=` }),
    false,
  );
});
test("world-info authoring DTOs carry item content and address it by opaque handles", () => {
  const entry = { scope: "setting", publicTitle: "Square", summary: "Town center." };
  const item = { revision: 1, publicTitle: "Pelican Town", summary: "A small valley town.", entries: [entry] };
  assert.equal(TavernBrowserValidatorsV1.WorldInfoItemV1Schema.Check(item), true);
  // The entry's optional facts are legal when present, never inventable.
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoItemV1Schema.Check({
      ...item,
      entries: [{ ...entry, keys: ["square"], secondaryKeys: ["town"], selectiveLogic: 3, constant: true }],
    }),
    true,
  );
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoItemV1Schema.Check({ ...item, entries: [{ ...entry, selectiveLogic: 4 }] }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoItemV1Schema.Check({ ...item, entries: [{ ...entry, keys: [] }] }),
    false,
  );
  // One item's own projection carries its content and its own revision, and no
  // library-internal fact: no storage handle, no canonical hash, and a raw title is
  // never a revision.
  assert.equal(TavernBrowserValidatorsV1.WorldInfoItemV1Schema.Check({ ...item, handle }), false);
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoItemV1Schema.Check({ ...item, canonicalHash: "a".repeat(64) }),
    false,
  );
  assert.equal(TavernBrowserValidatorsV1.WorldInfoItemV1Schema.Check({ ...item, revision: 0 }), false);

  const create = {
    apiVersion: 1,
    selectionGeneration: 1,
    expectedRevision: handle,
    item: { publicTitle: "Pelican Town", summary: "A small valley town.", entries: [entry] },
  };
  assert.equal(TavernBrowserValidatorsV1.WorldInfoCreateCommandV1Schema.Check(create), true);
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoCreateCommandV1Schema.Check({ ...create, expectedRevision: "Pelican Town" }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoCreateCommandV1Schema.Check({ ...create, selectionGeneration: 0 }),
    false,
  );
  assert.equal(TavernBrowserValidatorsV1.WorldInfoCreateCommandV1Schema.Check({ ...create, extra: true }), false);
  // A create carries no library revision of its own: the library mints the item's first one.
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoCreateCommandV1Schema.Check({
      ...create,
      item: { ...create.item, expectedRevision: 1 },
    }),
    false,
  );

  const update = { ...create, itemHandle: handle, item: { ...create.item, expectedRevision: 1 } };
  assert.equal(TavernBrowserValidatorsV1.WorldInfoUpdateCommandV1Schema.Check(update), true);
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoUpdateCommandV1Schema.Check({
      ...update,
      item: { ...update.item, expectedRevision: 0 },
    }),
    false,
  );
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoUpdateCommandV1Schema.Check({ ...update, itemHandle: "Pelican Town" }),
    false,
  );
  // The CAS revision belongs to the edited item; an update without it is not expressible.
  assert.equal(TavernBrowserValidatorsV1.WorldInfoUpdateCommandV1Schema.Check({ ...update, item: create.item }), false);

  // The same shape is the detail query and the delete body: one address, one meaning.
  const address = { apiVersion: 1, selectionGeneration: 1, expectedRevision: handle, itemHandle: handle };
  assert.equal(TavernBrowserValidatorsV1.WorldInfoItemCommandV1Schema.Check(address), true);
  assert.equal(
    TavernBrowserValidatorsV1.WorldInfoItemCommandV1Schema.Check({ ...address, itemHandle: "Pelican Town" }),
    false,
  );
  assert.equal(TavernBrowserValidatorsV1.WorldInfoItemCommandV1Schema.Check({ ...address, extra: true }), false);
});
test("import operations carry CSRF-bound write routes and safe projections", () => {
  const stage = TavernBrowserContractV1.routes.find((route) => route.routeId === "character.import.stage");
  const read = TavernBrowserContractV1.routes.find((route) => route.routeId === "character.import.read");
  const review = TavernBrowserContractV1.routes.find((route) => route.routeId === "character.import.review");
  const confirm = TavernBrowserContractV1.routes.find((route) => route.routeId === "character.import.confirm");
  assert.ok(stage);
  assert.equal(stage.method, "POST");
  assert.equal(stage.path, "/api/tavern/v1/imports");
  assert.equal(stage.csrf, "required");
  assert.ok(read);
  assert.equal(read.method, "GET");
  assert.equal(read.path, "/api/tavern/v1/imports/:importId");
  assert.equal(read.csrf, "none");
  assert.ok(review);
  assert.equal(review.method, "POST");
  assert.equal(review.path, "/api/tavern/v1/imports/:importId/review");
  assert.equal(review.csrf, "required");
  assert.ok(confirm);
  assert.equal(confirm.method, "POST");
  assert.equal(confirm.path, "/api/tavern/v1/imports/:importId/confirm");
  assert.equal(confirm.csrf, "required");
  // The stage result carries only player-readable projections (field summary,
  // dispositions, the decoder's counted-loss ledger) - never card body text.
  const stageResult = TavernBrowserContractV1.schemas.StCardImportStageResultV1Schema;
  assert.deepEqual(Object.keys(stageResult.properties ?? {}).sort(), [
    "apiVersion",
    "candidateRevision",
    "dispositions",
    "fields",
    "importId",
    "losses",
    "name",
  ]);
});
test("the companion language is the same bounded BCP-47 shape on the wire and in the store", async () => {
  // The contract must stay dependency-free (a dialogue-web test loads it directly under
  // Node), so its locale shape is a literal. This is the pin that keeps that literal and
  // the Host's own COMPANION_LOCALE_PATTERN from drifting: the shape is bounded, and the
  // set of languages is the player's choice.
  const { COMPANION_LOCALE_PATTERN, COMPANION_LOCALE_MAX_LENGTH } = await import(
    "../../settings/player-preference-store.js"
  );
  const declared = TavernCompanionLocaleV1Schema as unknown as {
    readonly pattern: string;
    readonly maxLength: number;
    readonly minLength: number;
  };
  assert.equal(declared.pattern, COMPANION_LOCALE_PATTERN.source);
  assert.equal(declared.maxLength, COMPANION_LOCALE_MAX_LENGTH);

  const write = TavernBrowserValidatorsV1.TavernLanguagePreferenceCommandV1Schema;
  for (const tag of ["zh-CN", "en-US", "ja-JP", "pt-BR", "zh-Hant-TW"]) {
    assert.equal(write.Check({ expectedRevision: 1, locale: tag }), true, `${tag} must save`);
  }
  for (const tag of ["", "x", "ja_JP", "ja-JP-x-private-extra-tag"]) {
    assert.equal(write.Check({ expectedRevision: 1, locale: tag }), false, `${tag} must be refused`);
  }

  // The stored locale is the same shape with the "never chosen" null.
  const read = TavernBrowserValidatorsV1.TavernLanguagePreferenceV1Schema;
  assert.equal(read.Check({ revision: 0, locale: null }), true);
  assert.equal(read.Check({ revision: 0, locale: "ja-JP" }), true);
  assert.equal(read.Check({ revision: 0, locale: "not a locale" }), false);
});

test("the voice persona is the same bounded shape on the wire and in the store, and rides the consent command", async () => {
  // The contract stays dependency-free, so its persona shape is a literal. This
  // pin keeps that literal and the Host's own VOICE_PERSONA_PATTERN from
  // drifting: the shape is bounded, and the set of personas is the extension's.
  const { VOICE_PERSONA_PATTERN, VOICE_PERSONA_MAX_LENGTH } = await import("../../settings/player-preference-store.js");
  const declared = TavernVoicePersonaV1Schema as unknown as {
    readonly anyOf: readonly { readonly type?: string; readonly pattern?: string; readonly maxLength?: number }[];
  };
  const stringOption = declared.anyOf.find((option) => option.type === "string");
  assert.ok(stringOption !== undefined, "the persona shape declares a string option");
  assert.equal(stringOption.pattern, VOICE_PERSONA_PATTERN.source);
  assert.equal(stringOption.maxLength, VOICE_PERSONA_MAX_LENGTH);
  assert.equal(
    declared.anyOf.some((option) => option.type === "null"),
    true,
    "`null` (no persona; the gateway variable stays unset) is expressible",
  );

  // The read shape carries the persona as a required member.
  const read = TavernBrowserValidatorsV1.TavernVoicePreferenceV1Schema;
  const preference = (persona: unknown) => ({
    revision: 1,
    disclosureVersion: null,
    consent: "undecided",
    decidedAtMs: null,
    outputDevice: null,
    persona,
  });
  assert.equal(read.Check(preference(null)), true);
  assert.equal(read.Check(preference("soft_maid")), true);
  assert.equal(read.Check(preference("SoftMaid")), false);
  assert.equal(read.Check(preference("soft maid")), false);
  assert.equal(read.Check(preference("soft-maid")), false);
  assert.equal(read.Check(preference("a".repeat(33))), false);
  assert.equal(
    read.Check({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null }),
    false,
    "the persona is a required member of the frozen read shape",
  );
  assert.equal(read.Check({ ...preference(null), extra: true }), false);

  // The fourth command variant rides the existing consent operation: a persona
  // selection is one more revision-checked mutation, never a new route.
  const write = TavernBrowserValidatorsV1.TavernVoicePreferenceConsentCommandV1Schema;
  assert.equal(write.Check({ expectedRevision: 1, action: "setPersona", persona: "soft_maid" }), true);
  assert.equal(write.Check({ expectedRevision: 1, action: "setPersona", persona: null }), true);
  assert.equal(write.Check({ expectedRevision: 1, action: "setPersona", persona: "SoftMaid" }), false);
  assert.equal(write.Check({ expectedRevision: 1, action: "setPersona", persona: "a".repeat(33) }), false);
  assert.equal(write.Check({ expectedRevision: 1, action: "setPersona" }), false);
  assert.equal(write.Check({ expectedRevision: 1, action: "setPersona", persona: null, extra: true }), false);
});
