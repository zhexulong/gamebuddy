import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { composeReferenceGameBrowserProfile } from "./composed-browser-contract/index.js";
import {
  createComposedReferenceGameBrowserRequestHandler,
  type ComposedReferenceGameBrowserReadContext,
} from "./composed-reference-game-browser.js";
import { createReferencePipelineDialogueWebDelegatedHandler } from "./reference-pipeline-dialogue-web.delegated.js";
import {
  type DeleteMessageCommandV1,
  type DeleteMessageResultV1,
  type EditMessageCommandV1,
  type EditMessageResultV1,
  type RegenerateMessageCommandV1,
  type RewindChatCommandV1,
  type RewindChatResultV1,
  type SwipeSelectCommandV1,
  type SwipeSelectResultV1,
  composeReferenceTavernProfile,
  composeTavernProfile,
  referenceTavernProfileFitsCanonicalGroups,
  TavernBrowserFixtureV1,
} from "./tavern/browser-contract/index.js";
import type { ChatPipelineService, SubmitResultV1 } from "./tavern/chat-pipeline-service.js";
import { createChatEventStream } from "./tavern/chat-event-stream.js";
import type { ReferencePipelineState, ReferencePipelineStateFacade } from "./tavern/reference-pipeline-state.js";

const bootstrapToken = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const tavernProfile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
  operationIds: ["chat.submit", "chat.cancel"],
  navigationItemIds: ["chat"],
});

function stateForChat(context: ComposedReferenceGameBrowserReadContext) {
  const base = TavernBrowserFixtureV1.snapshot();
  return {
    ...base,
    build: { ...base.build, profileId: tavernProfile.profileId },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}

const eventStream = createChatEventStream();
const state: ReferencePipelineState = Object.freeze({
  selection: Object.freeze({ chatHandle: handle, generation: 1, stateRevision: handle }),
  companionDisplayName: "Companion",
  companionHandle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA",
  title: "Delegated Chat",
  transcript: Object.freeze([]),
  draft: Object.freeze({ revision: 4, text: "draft" }),
  turn: null,
  operations: Object.freeze([
    Object.freeze({
      operationId: "chat.submit" as const,
      labelKey: "tavern.operation.submit" as const,
      availability: "available" as const,
      routeId: "chat.submit",
    }),
  ]),
  eventStream: Object.freeze({ epoch: eventStream.epoch, cursor: eventStream.cursor }),
  voice: null,
});
const facade: ReferencePipelineStateFacade = Object.freeze({
  read: async () => state,
  readDraft: async () => Object.freeze({ apiVersion: 1, revision: 4, text: "draft" }),
  close: async () => undefined,
});

const result: SubmitResultV1 = Object.freeze({
  apiVersion: 1,
  disposition: "accepted",
  message: Object.freeze({
    handle,
    role: "player",
    text: "Hello",
    locale: "en",
    order: 0,
    revision: 1,
  }),
  turn: Object.freeze({ handle, state: "queued", projectionRevision: 1, canCancel: false }),
});

function service(recorder: {
  starts: number;
  statuses: number;
  closes: number;
  cancels?: string[];
}): ChatPipelineService {
  return Object.freeze({
    async submitAfterResponseCommit(command, idempotencyKey, commit202) {
      assert.equal(command.text, "Hello");
      assert.equal(idempotencyKey, "A".repeat(22));
      assert.equal(recorder.starts, 0);
      await commit202(result);
      recorder.starts += 1;
      return result;
    },
    async readSubmissionStatus(query) {
      recorder.statuses += 1;
      assert.deepEqual(query, {
        apiVersion: 1,
        idempotencyKey: "A".repeat(22),
        selectionGeneration: 1,
      });
      return Object.freeze({
        apiVersion: 1,
        disposition: "accepted" as const,
        committedResult: result,
      });
    },
    async cancel(turnHandle, command) {
      if (command.selectionGeneration !== 1) throw new Error("chat_pipeline_service_selection_conflict");
      recorder.cancels?.push(turnHandle);
      return Object.freeze({ ...result.turn, state: "cancelled" as const });
    },
    async close() {
      recorder.closes += 1;
    },
  });
}

async function start(
  broker: ReturnType<typeof createComposedReferenceGameBrowserRequestHandler>,
  delegated: ReturnType<typeof createReferencePipelineDialogueWebDelegatedHandler>,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const pathname = new URL(request.url ?? "/", origin).pathname;
    if (pathname.startsWith("/api/composed-reference-game/")) broker.handle(request, response, origin);
    else delegated.handle(request, response, origin);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return Object.freeze({
    origin,
    async close() {
      const brokerDrain = broker.close();
      const delegateDrain = delegated.close();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await brokerDrain;
      await delegateDrain;
    },
  });
}

async function bootstrap(origin: string) {
  return fetch(`${origin}/api/composed-reference-game/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
  });
}

test("delegated handler construction rejects forged or foreign capabilities", () => {
  const real = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const forged = [
    Object.freeze({}),
    Object.freeze({ brand: "composed_reference_game_browser" }),
    // A structural clone is not WeakSet-branded and must fail closed.
    Object.freeze({ ...real.delegatedAuthCapability }),
  ];
  for (const capability of forged) {
    assert.throws(
      () =>
        createReferencePipelineDialogueWebDelegatedHandler({
          profile: tavernProfile,
          referenceStateFacade: facade,
          pipelineService: service({ starts: 0, statuses: 0, closes: 0 }),
          eventStream,
          capability: capability as never,
        }),
      /reference_pipeline_delegated_capability_invalid/,
    );
  }
  // The exact broker-minted capability is accepted.
  const handler = createReferencePipelineDialogueWebDelegatedHandler({
    profile: tavernProfile,
    referenceStateFacade: facade,
    pipelineService: service({ starts: 0, statuses: 0, closes: 0 }),
    eventStream,
    capability: real.delegatedAuthCapability,
  });
  assert.equal(typeof handler.handle, "function");
  assert.equal(typeof handler.close, "function");
});

test("delegated handler rejects invalid composition before any Tavern operation", () => {
  const real = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const invalid = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status"],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  });
  assert.throws(
    () =>
      createReferencePipelineDialogueWebDelegatedHandler({
        profile: invalid,
        referenceStateFacade: facade,
        eventStream,
        capability: real.delegatedAuthCapability,
      }),
    /reference_pipeline_profile_operation_unavailable/,
  );
  // The exact reference profile declares "events", so a missing event stream fails closed.
  assert.throws(
    () =>
      createReferencePipelineDialogueWebDelegatedHandler({
        profile: tavernProfile,
        referenceStateFacade: facade,
        capability: real.delegatedAuthCapability,
      }),
    /reference_pipeline_event_stream_unavailable/,
  );
  void real.close();
});

test("delegated handler serves all mounted Tavern operations with the broker session and no second bootstrap", async () => {
  const recorder = { starts: 0, statuses: 0, closes: 0, cancels: [] as string[] };
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const delegated = createReferencePipelineDialogueWebDelegatedHandler({
    profile: tavernProfile,
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    eventStream,
    capability: broker.delegatedAuthCapability,
  });
  const server = await start(broker, delegated);
  try {
    const initial = await bootstrap(server.origin);
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = (await initial.json()) as { chat: { csrfToken: string } };
    const brokerCsrf = root.chat.csrfToken;

    // No delegated bootstrap and no second Set-Cookie anywhere.
    const refBootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
    });
    assert.equal(refBootstrap.status, 404);
    assert.equal(refBootstrap.headers.get("set-cookie"), null);

    // State projection uses the broker's exact session facts.
    const stateResponse = await fetch(`${server.origin}/api/tavern/v1/state`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(stateResponse.status, 200);
    assert.equal(stateResponse.headers.get("set-cookie"), null);
    const snapshot = (await stateResponse.json()) as { build: { profileId: string }; csrfToken: string };
    assert.equal(snapshot.build.profileId, tavernProfile.profileId);
    assert.equal(snapshot.csrfToken, brokerCsrf);

    // Wrong or missing cookie is rejected for every mounted route.
    const wrongCookie = await fetch(`${server.origin}/api/tavern/v1/state`, {
      headers: { Cookie: "gb_composed_reference_game_session=wrong", "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(wrongCookie.status, 401);
    const noCookie = await fetch(`${server.origin}/api/tavern/v1/draft`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(noCookie.status, 401);

    // Draft reads through the broker session.
    const draft = await fetch(`${server.origin}/api/tavern/v1/draft`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(draft.status, 200);
    assert.deepEqual(await draft.json(), { apiVersion: 1, revision: 4, text: "draft" });

    // Mutations use the broker CSRF: wrong CSRF fails before the service.
    const wrongCsrf = await fetch(`${server.origin}/api/tavern/v1/messages`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": "B".repeat(43),
        "Idempotency-Key": "A".repeat(22),
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, text: "Hello", locale: "en" }),
    });
    assert.equal(wrongCsrf.status, 403);
    assert.equal(recorder.starts, 0);

    // Correct CSRF drives the pipeline service to a durable 202.
    const submit = await fetch(`${server.origin}/api/tavern/v1/messages`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": brokerCsrf,
        "Idempotency-Key": "A".repeat(22),
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, text: "Hello", locale: "en" }),
    });
    assert.equal(submit.status, 202);
    assert.deepEqual(await submit.json(), result);
    assert.equal(recorder.starts, 1);

    // Submission status needs no CSRF but still needs the broker session.
    const status = await fetch(`${server.origin}/api/tavern/v1/message-submission-status`, {
      method: "POST",
      headers: { Origin: server.origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, idempotencyKey: "A".repeat(22), selectionGeneration: 1 }),
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { apiVersion: 1, disposition: "accepted", committedResult: result });
    assert.equal(recorder.statuses, 1);

    // Cancel validates the handle against the broker session.
    const cancelled = await fetch(`${server.origin}/api/tavern/v1/turns/${handle}/cancel`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": brokerCsrf,
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1 }),
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), {
      apiVersion: 1,
      disposition: "cancelled",
      turn: { ...result.turn, state: "cancelled" },
    });
    assert.deepEqual(recorder.cancels, [handle]);

    // Events route requires auth and resyncs an ambiguous cursor through the real stream.
    const noAuthEvents = await fetch(`${server.origin}/api/tavern/v1/events?apiVersion=1`, {
      headers: { Origin: server.origin },
    });
    assert.equal(noAuthEvents.status, 401);
    const malformedEvents = await fetch(`${server.origin}/api/tavern/v1/events?unexpected=1`, {
      headers: { Origin: server.origin, Cookie: cookie },
    });
    assert.equal(malformedEvents.status, 400);
    const future = await fetch(
      `${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=${eventStream.encodeCursor({ epoch: eventStream.epoch, sequence: 999 })}`,
      { headers: { Origin: server.origin, Cookie: cookie } },
    );
    assert.equal(future.status, 200);
    const resync = await future.text();
    assert.match(resync, /event: stream\.resync_required/);
    assert.match(resync, /ambiguous_cursor/);
  } finally {
    await server.close();
    assert.equal(recorder.closes, 1);
  }
});

test("delegated handler submits a message the contract allows, however long", async () => {
  // The contract permits message text up to 16,384 UTF-8 bytes (`MAX_TEXT_UTF8_BYTES`,
  // `tavern-browser-nfc-utf8-text-v1` on `SubmitMessageCommandV1.text`). The transport read this
  // route's body with the BOOTSTRAP limit (4 KiB), so a long but perfectly valid message was
  // refused before it ever reached the pipeline - a player typing a long message got a rejection
  // for a message the product had already declared valid.
  let receivedText;
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const delegated = createReferencePipelineDialogueWebDelegatedHandler({
    profile: tavernProfile,
    referenceStateFacade: facade,
    pipelineService: Object.freeze({
      async submitAfterResponseCommit(
        command: { text: string },
        _key: string,
        commit202: (committed: SubmitResultV1) => Promise<void>,
      ) {
        receivedText = command.text;
        await commit202(result);
        recorder.starts += 1;
        return result;
      },
      async readSubmissionStatus() {
        recorder.statuses += 1;
        return Object.freeze({ apiVersion: 1, disposition: "accepted" as const, committedResult: result });
      },
      async cancel() {
        throw new Error("not_used");
      },
      async close() {
        recorder.closes += 1;
      },
    }) as unknown as ChatPipelineService,
    eventStream,
    capability: broker.delegatedAuthCapability,
  });
  const server = await start(broker, delegated);
  try {
    const initial = await bootstrap(server.origin);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = (await initial.json()) as { chat: { csrfToken: string } };
    // 8,000 characters: inside the contract's 16,384-byte ceiling for ASCII, far outside the
    // 4 KiB bootstrap limit the route used to read the body with.
    const longText = "a".repeat(8_000);
    const submit = await fetch(`${server.origin}/api/tavern/v1/messages`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": root.chat.csrfToken,
        "Idempotency-Key": "A".repeat(22),
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, text: longText, locale: "en" }),
    });
    assert.equal(submit.status, 202, `long message must be accepted, got ${submit.status} ${await submit.text()}`);
    assert.equal(receivedText, longText);
    assert.equal(recorder.starts, 1);
  } finally {
    await server.close();
  }
});

test("delegated handler keeps a bound, and the bound is the contract's before the transport's", async () => {
  // Two distinct ceilings, and the order matters. The contract's text limit is applied to the
  // DECODED string (16,384 UTF-8 bytes), so text past it is a typed 400 with the service never
  // reached. The transport's body ceiling is only a blowup guard, so a body past IT is a 413.
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const delegated = createReferencePipelineDialogueWebDelegatedHandler({
    profile: tavernProfile,
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    eventStream,
    capability: broker.delegatedAuthCapability,
  });
  const server = await start(broker, delegated);
  try {
    const initial = await bootstrap(server.origin);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = (await initial.json()) as { chat: { csrfToken: string } };
    const post = (text: string) =>
      fetch(`${server.origin}/api/tavern/v1/messages`, {
        method: "POST",
        headers: {
          Origin: server.origin,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": root.chat.csrfToken,
          "Idempotency-Key": "A".repeat(22),
        },
        body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, text, locale: "en" }),
      });
    // Past the contract's text ceiling, inside the transport's body ceiling.
    const pastTextCeiling = await post("a".repeat(20_000));
    assert.equal(pastTextCeiling.status, 400);
    assert.equal(((await pastTextCeiling.json()) as { code: string }).code, "invalid_request");
    // Past the transport's body ceiling.
    const pastBodyCeiling = await post("a".repeat(200_000));
    assert.equal(pastBodyCeiling.status, 413);
    assert.equal(((await pastBodyCeiling.json()) as { code: string }).code, "payload_too_large");
    assert.equal(recorder.starts, 0);
  } finally {
    await server.close();
  }
});

test("delegated handler without a mounted pipeline service fails mutations closed", async () => {
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const delegated = createReferencePipelineDialogueWebDelegatedHandler({
    profile: tavernProfile,
    referenceStateFacade: facade,
    eventStream,
    capability: broker.delegatedAuthCapability,
  });
  const server = await start(broker, delegated);
  try {
    const initial = await bootstrap(server.origin);
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = (await initial.json()) as { chat: { csrfToken: string } };
    const submit = await fetch(`${server.origin}/api/tavern/v1/messages`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": root.chat.csrfToken,
        "Idempotency-Key": "A".repeat(22),
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, text: "Hello", locale: "en" }),
    });
    assert.equal(submit.status, 503);
    assert.equal(((await submit.json()) as { code: string }).code, "runtime_unavailable");
  } finally {
    await server.close();
  }
});

/**
 * A pipeline service that answers only the message-mutation half of the reference profile
 * (Regenerate, Swipe, Rewind, Edit and Delete), so a test can prove the dispatcher reaches them.
 */
function mutationService(
  recorder: {
    swipes: SwipeSelectCommandV1[];
    regenerations: { command: RegenerateMessageCommandV1; idempotencyKey: string }[];
    rewinds: RewindChatCommandV1[];
    edits: EditMessageCommandV1[];
    deletes: DeleteMessageCommandV1[];
    closes: number;
  },
  swipeResult: SwipeSelectResultV1,
  rewind: { result: RewindChatResultV1; refusal?: string } = { result: REWIND_RESULT },
  edit: { result: EditMessageResultV1; refusal?: string } = { result: EDIT_RESULT },
  remove: { result: DeleteMessageResultV1; refusal?: string } = { result: DELETE_RESULT },
): ChatPipelineService {
  return Object.freeze({
    async submitAfterResponseCommit() {
      throw new Error("not_used");
    },
    async readSubmissionStatus() {
      throw new Error("not_used");
    },
    async cancel() {
      throw new Error("not_used");
    },
    async selectSwipe(command): Promise<SwipeSelectResultV1> {
      recorder.swipes.push(command);
      return swipeResult;
    },
    async regenerate(command, idempotencyKey): Promise<SubmitResultV1> {
      recorder.regenerations.push({ command, idempotencyKey });
      return result;
    },
    async rewind(command): Promise<RewindChatResultV1> {
      recorder.rewinds.push(command);
      if (rewind.refusal !== undefined) throw new Error(rewind.refusal);
      return rewind.result;
    },
    async edit(command): Promise<EditMessageResultV1> {
      recorder.edits.push(command);
      if (edit.refusal !== undefined) throw new Error(edit.refusal);
      return edit.result;
    },
    async delete(command): Promise<DeleteMessageResultV1> {
      recorder.deletes.push(command);
      if (remove.refusal !== undefined) throw new Error(remove.refusal);
      return remove.result;
    },
    async close() {
      recorder.closes += 1;
    },
  });
}

/** An emptied transcript: the rewind's answer when the player removed the first message. */
const REWIND_RESULT: RewindChatResultV1 = Object.freeze({ apiVersion: 1, lastMessage: null });

/** The edited row, as the durable read-back holds it: the edit's own answer. */
const EDIT_RESULT: EditMessageResultV1 = Object.freeze({
  apiVersion: 1,
  message: Object.freeze({
    handle,
    role: "player" as const,
    text: "a corrected line",
    locale: "und" as const,
    order: 0,
    revision: 1,
  }),
});

/**
 * The delete's own answer. It names no row: the gap is the result, and the surface rereads the
 * transcript rather than being told what now occupies the position.
 */
const DELETE_RESULT: DeleteMessageResultV1 = Object.freeze({ apiVersion: 1 });

test("the production reference profile declares the message-mutation group and fits the canonical groups", () => {
  const production = composeReferenceTavernProfile();
  assert.equal(referenceTavernProfileFitsCanonicalGroups(production), true);
  // The declaration is the core Chat routes plus the message-mutation extension, in the canonical
  // order: a profile that grows a route without growing a group would fail the fit above.
  assert.deepEqual(production.routeIds, [
    ...tavernProfile.routeIds,
    "chat.swipe",
    "chat.regenerate",
    "chat.rewind",
    "chat.edit",
    "chat.delete",
  ]);
  assert.deepEqual(production.operationIds, ["chat.submit", "chat.cancel"]);
});

test("the reference dispatcher rejects a profile that declares a route outside its canonical groups", () => {
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  // `memory.read` is a declared contract route but belongs to no reference group: a profile that
  // advertises it claims a capability this dispatcher cannot serve. The group assertion is what
  // refuses it at construction, rather than mounting a surface with an unanswered route.
  const outsideGroups = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: [...tavernProfile.routeIds, "memory.read"],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  });
  assert.equal(referenceTavernProfileFitsCanonicalGroups(outsideGroups), false);
  assert.throws(
    () =>
      createReferencePipelineDialogueWebDelegatedHandler({
        profile: outsideGroups,
        referenceStateFacade: facade,
        pipelineService: service({ starts: 0, statuses: 0, closes: 0 }),
        eventStream,
        capability: broker.delegatedAuthCapability,
      }),
    /reference_pipeline_profile_operation_unavailable/,
  );
  void broker.close();
});

test("delegated handler answers the reference profile's Swipe and Regenerate routes", async () => {
  const production = composeReferenceTavernProfile();
  const swipeMessage = {
    handle,
    role: "companion" as const,
    text: "the second variant",
    locale: "en" as const,
    order: 0,
    revision: 1,
    swipeInfo: { currentIndex: 1, totalSwipes: 2, label: "◀ 2/2 ▶", hasPrevious: true, hasNext: false },
  };
  const swipeResult: SwipeSelectResultV1 = Object.freeze({ apiVersion: 1, message: Object.freeze(swipeMessage) });
  const recorder: {
    swipes: SwipeSelectCommandV1[];
    regenerations: { command: RegenerateMessageCommandV1; idempotencyKey: string }[];
    rewinds: RewindChatCommandV1[];
    edits: EditMessageCommandV1[];
    deletes: DeleteMessageCommandV1[];
    closes: number;
  } = { swipes: [], regenerations: [], rewinds: [], edits: [], deletes: [], closes: 0 };
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile: production }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const delegated = createReferencePipelineDialogueWebDelegatedHandler({
    profile: production,
    referenceStateFacade: facade,
    pipelineService: mutationService(recorder, swipeResult),
    eventStream,
    capability: broker.delegatedAuthCapability,
  });
  const server = await start(broker, delegated);
  try {
    const initial = await bootstrap(server.origin);
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = (await initial.json()) as { chat: { csrfToken: string } };
    const csrf = root.chat.csrfToken;

    const swipe = await fetch(`${server.origin}/api/tavern/v1/messages/swipe`, {
      method: "POST",
      headers: { Origin: server.origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, messageHandle: handle, direction: "next" }),
    });
    const swipeBody = await swipe.text();
    assert.equal(swipe.status, 200, `swipe must be served, got ${swipe.status} ${swipeBody}`);
    assert.deepEqual(JSON.parse(swipeBody), { apiVersion: 1, message: swipeMessage });

    const regenerate = await fetch(`${server.origin}/api/tavern/v1/messages/regenerate`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        "Idempotency-Key": "A".repeat(22),
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, messageHandle: handle }),
    });
    const regenerateBody = await regenerate.text();
    assert.equal(regenerate.status, 202, `regenerate must be served, got ${regenerate.status} ${regenerateBody}`);
    assert.deepEqual(JSON.parse(regenerateBody), result);
    assert.deepEqual(recorder.swipes, [
      { apiVersion: 1, selectionGeneration: 1, messageHandle: handle, direction: "next" },
    ]);
    assert.deepEqual(recorder.regenerations, [
      {
        command: { apiVersion: 1, selectionGeneration: 1, messageHandle: handle },
        idempotencyKey: "A".repeat(22),
      },
    ]);
  } finally {
    await server.close();
    assert.equal(recorder.closes, 1);
  }
});

test("delegated handler answers the reference profile's Rewind route, and a refusal keeps its own name", async () => {
  const production = composeReferenceTavernProfile();
  const lastMessage = {
    handle,
    role: "companion" as const,
    text: "the reply the player kept",
    locale: "en" as const,
    order: 1,
    revision: 1,
  };
  const rewind: { result: RewindChatResultV1; refusal?: string } = {
    result: Object.freeze({ apiVersion: 1, lastMessage: Object.freeze(lastMessage) }),
  };
  const recorder: {
    swipes: SwipeSelectCommandV1[];
    regenerations: { command: RegenerateMessageCommandV1; idempotencyKey: string }[];
    rewinds: RewindChatCommandV1[];
    edits: EditMessageCommandV1[];
    deletes: DeleteMessageCommandV1[];
    closes: number;
  } = { swipes: [], regenerations: [], rewinds: [], edits: [], deletes: [], closes: 0 };
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile: production }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const delegated = createReferencePipelineDialogueWebDelegatedHandler({
    profile: production,
    referenceStateFacade: facade,
    pipelineService: mutationService(
      recorder,
      Object.freeze({ apiVersion: 1, message: Object.freeze({ ...lastMessage }) }),
      rewind,
    ),
    eventStream,
    capability: broker.delegatedAuthCapability,
  });
  const server = await start(broker, delegated);
  try {
    const initial = await bootstrap(server.origin);
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = (await initial.json()) as { chat: { csrfToken: string } };
    const csrf = root.chat.csrfToken;
    const command = { apiVersion: 1, selectionGeneration: 1, messageHandle: handle, expectedOrder: 0 };
    const rewindRequest = (token: string, body: unknown) =>
      fetch(`${server.origin}/api/tavern/v1/messages/rewind`, {
        method: "POST",
        headers: { Origin: server.origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
      });

    // The route reaches the service and answers with the transcript's new last row.
    const answered = await rewindRequest(csrf, command);
    const answeredBody = await answered.text();
    assert.equal(answered.status, 200, `rewind must be served, got ${answered.status} ${answeredBody}`);
    assert.deepEqual(JSON.parse(answeredBody), rewind.result);
    assert.deepEqual(recorder.rewinds, [command]);

    // A body the contract does not admit is refused before the service, not after it.
    const malformed = await rewindRequest(csrf, { apiVersion: 1, selectionGeneration: 1, messageHandle: handle });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { code: string }).code, "invalid_request");
    assert.equal(recorder.rewinds.length, 1);

    // The wrong CSRF fails before the service too, as every mutation on this surface does.
    const wrongCsrf = await rewindRequest("B".repeat(43), command);
    assert.equal(wrongCsrf.status, 403);
    assert.equal(((await wrongCsrf.json()) as { code: string }).code, "csrf_failed");
    assert.equal(recorder.rewinds.length, 1);

    // A refusal the Host named keeps its own code: the player is told a reply is still being
    // written, not that the runtime went away.
    rewind.refusal = "chat_rewind_turn_active";
    const refused = await rewindRequest(csrf, command);
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, "chat_rewind_turn_active");
    assert.equal(recorder.rewinds.length, 2);
  } finally {
    await server.close();
    assert.equal(recorder.closes, 1);
  }
});

test("delegated handler answers the reference profile's Edit route, and every refusal keeps its own name", async () => {
  const production = composeReferenceTavernProfile();
  const edit: { result: EditMessageResultV1; refusal?: string } = { result: EDIT_RESULT };
  const recorder: {
    swipes: SwipeSelectCommandV1[];
    regenerations: { command: RegenerateMessageCommandV1; idempotencyKey: string }[];
    rewinds: RewindChatCommandV1[];
    edits: EditMessageCommandV1[];
    deletes: DeleteMessageCommandV1[];
    closes: number;
  } = { swipes: [], regenerations: [], rewinds: [], edits: [], deletes: [], closes: 0 };
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile: production }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const delegated = createReferencePipelineDialogueWebDelegatedHandler({
    profile: production,
    referenceStateFacade: facade,
    pipelineService: mutationService(
      recorder,
      Object.freeze({ apiVersion: 1, message: Object.freeze({ ...EDIT_RESULT.message }) }),
      { result: REWIND_RESULT },
      edit,
    ),
    eventStream,
    capability: broker.delegatedAuthCapability,
  });
  const server = await start(broker, delegated);
  try {
    const initial = await bootstrap(server.origin);
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = (await initial.json()) as { chat: { csrfToken: string } };
    const csrf = root.chat.csrfToken;
    const command = {
      apiVersion: 1,
      selectionGeneration: 1,
      messageHandle: handle,
      expectedOrder: 0,
      text: "a corrected line",
    };
    const editRequest = (token: string, body: unknown) =>
      fetch(`${server.origin}/api/tavern/v1/messages/edit`, {
        method: "POST",
        headers: { Origin: server.origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
      });

    // The route reaches the service and answers with the edited row the durable read-back holds.
    const answered = await editRequest(csrf, command);
    const answeredBody = await answered.text();
    assert.equal(answered.status, 200, `edit must be served, got ${answered.status} ${answeredBody}`);
    assert.deepEqual(JSON.parse(answeredBody), edit.result);
    assert.deepEqual(recorder.edits, [command]);

    // A body the contract does not admit is refused before the service, not after it: an edit without
    // the text it writes names nothing to change.
    const malformed = await editRequest(csrf, {
      apiVersion: 1,
      selectionGeneration: 1,
      messageHandle: handle,
      expectedOrder: 0,
    });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { code: string }).code, "invalid_request");
    assert.equal(recorder.edits.length, 1);

    // The wrong CSRF fails before the service too, as every mutation on this surface does.
    const wrongCsrf = await editRequest("B".repeat(43), command);
    assert.equal(wrongCsrf.status, 403);
    assert.equal(((await wrongCsrf.json()) as { code: string }).code, "csrf_failed");
    assert.equal(recorder.edits.length, 1);

    // Each refusal the Host names keeps its own code: the player is told which row the edit cannot
    // touch, not that the runtime went away.
    for (const refusal of [
      "chat_edit_not_player_message",
      "chat_edit_turn_active",
      "chat_message_not_found",
    ] as const) {
      edit.refusal = refusal;
      const refused = await editRequest(csrf, command);
      assert.equal(refused.status, 409, refusal);
      assert.equal(((await refused.json()) as { code: string }).code, refusal);
    }
    assert.equal(recorder.edits.length, 4);
  } finally {
    await server.close();
    assert.equal(recorder.closes, 1);
  }
});

test("delegated handler answers the reference profile's Delete route, and every refusal keeps its own name", async () => {
  const production = composeReferenceTavernProfile();
  const remove: { result: DeleteMessageResultV1; refusal?: string } = { result: DELETE_RESULT };
  const recorder: {
    swipes: SwipeSelectCommandV1[];
    regenerations: { command: RegenerateMessageCommandV1; idempotencyKey: string }[];
    rewinds: RewindChatCommandV1[];
    edits: EditMessageCommandV1[];
    deletes: DeleteMessageCommandV1[];
    closes: number;
  } = { swipes: [], regenerations: [], rewinds: [], edits: [], deletes: [], closes: 0 };
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile: production }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context);
    },
  });
  const delegated = createReferencePipelineDialogueWebDelegatedHandler({
    profile: production,
    referenceStateFacade: facade,
    pipelineService: mutationService(
      recorder,
      Object.freeze({ apiVersion: 1, message: Object.freeze({ ...EDIT_RESULT.message }) }),
      { result: REWIND_RESULT },
      { result: EDIT_RESULT },
      remove,
    ),
    eventStream,
    capability: broker.delegatedAuthCapability,
  });
  const server = await start(broker, delegated);
  try {
    const initial = await bootstrap(server.origin);
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = (await initial.json()) as { chat: { csrfToken: string } };
    const csrf = root.chat.csrfToken;
    const command = { apiVersion: 1, selectionGeneration: 1, messageHandle: handle, expectedOrder: 2 };
    const deleteRequest = (token: string, body: unknown) =>
      fetch(`${server.origin}/api/tavern/v1/messages/delete`, {
        method: "POST",
        headers: { Origin: server.origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
      });

    // The route reaches the service and answers with nothing but the protocol version: the gap is the
    // result, and the surface rereads the transcript rather than being told what occupies it.
    const answered = await deleteRequest(csrf, command);
    const answeredBody = await answered.text();
    assert.equal(answered.status, 200, `delete must be served, got ${answered.status} ${answeredBody}`);
    assert.deepEqual(JSON.parse(answeredBody), remove.result);
    assert.deepEqual(recorder.deletes, [command]);

    // A body the contract does not admit is refused before the service, not after it: a delete without
    // the position the page rendered names no point to remove.
    const malformed = await deleteRequest(csrf, {
      apiVersion: 1,
      selectionGeneration: 1,
      messageHandle: handle,
    });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { code: string }).code, "invalid_request");
    assert.equal(recorder.deletes.length, 1);

    // The wrong CSRF fails before the service too, as every mutation on this surface does.
    const wrongCsrf = await deleteRequest("B".repeat(43), command);
    assert.equal(wrongCsrf.status, 403);
    assert.equal(((await wrongCsrf.json()) as { code: string }).code, "csrf_failed");
    assert.equal(recorder.deletes.length, 1);

    // Each refusal the Host names keeps its own code - including the one that is not about the player's
    // choice at all: a row whose model entry was never recorded cannot be removed on its own.
    for (const refusal of [
      "chat_delete_opening_retained",
      "chat_delete_turn_active",
      "chat_delete_binding_unavailable",
      "chat_message_not_found",
      "chat_message_revision_conflict",
    ] as const) {
      remove.refusal = refusal;
      const refused = await deleteRequest(csrf, command);
      assert.equal(refused.status, 409, refusal);
      assert.equal(((await refused.json()) as { code: string }).code, refusal);
    }
    assert.equal(recorder.deletes.length, 6);
  } finally {
    await server.close();
    assert.equal(recorder.closes, 1);
  }
});

test("only the composed shell imports the internal delegated facade in production", async () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const leaves = (await readdir(sourceRoot, { recursive: true }))
    .map((leaf) => leaf.replaceAll("\\", "/"))
    .filter((leaf) => leaf.endsWith(".ts"));
  const delegatedImporters: string[] = [];
  for (const leaf of leaves) {
    const source = await readFile(join(sourceRoot, leaf), "utf8");
    if (/from\s+["'][^"']*reference-pipeline-dialogue-web\.delegated\.js["']/.test(source))
      delegatedImporters.push(leaf);
  }
  const productionImporters = delegatedImporters.filter((leaf) => !leaf.endsWith(".test.ts"));
  assert.deepEqual(productionImporters, ["tavern/composed-reference-game-static-shell-composition.ts"]);
  assert.deepEqual(delegatedImporters.filter((leaf) => leaf.endsWith(".test.ts")).sort(), [
    "reference-pipeline-dialogue-web.delegated.test.ts",
  ]);

  // The public dialogue facade keeps no delegated factory, verifyAuth
  // callback, or broker auth DTO surface.
  const publicSource = await readFile(join(sourceRoot, "reference-pipeline-dialogue-web.ts"), "utf8");
  assert.doesNotMatch(
    publicSource,
    /createReferencePipelineDialogueWebDelegatedHandler|DelegatedAuth|verifyAuth|delegatedAuth/,
  );
  const coreSource = await readFile(join(sourceRoot, "reference-pipeline-dialogue-web.core.ts"), "utf8");
  assert.doesNotMatch(coreSource, /DelegatedAuth|verifyAuth|delegatedAuth|ComposedReferenceGameBrowser/);
});
