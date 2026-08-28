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
import {
  createReferencePipelineDialogueWebDelegatedHandler,
} from "./reference-pipeline-dialogue-web.delegated.js";
import { composeTavernProfile, TavernBrowserFixtureV1 } from "./tavern/browser-contract/index.js";
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
});
const facade: ReferencePipelineStateFacade = Object.freeze({
  read: async () => state,
  readDraft: async () => Object.freeze({ apiVersion: 1, revision: 4, text: "draft" }),
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

function service(recorder: { starts: number; statuses: number; closes: number; cancels?: string[] }): ChatPipelineService {
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
    async readChat(context) { return stateForChat(context); },
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
    async readChat(context) { return stateForChat(context); },
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
    async readChat(context) { return stateForChat(context); },
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
    const root = await initial.json() as { chat: { csrfToken: string } };
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
    const snapshot = await stateResponse.json() as { build: { profileId: string }; csrfToken: string };
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

test("delegated handler without a mounted pipeline service fails mutations closed", async () => {
  const broker = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
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
    const root = await initial.json() as { chat: { csrfToken: string } };
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
    assert.equal((await submit.json() as { code: string }).code, "runtime_unavailable");
  } finally {
    await server.close();
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
  assert.deepEqual(
    delegatedImporters.filter((leaf) => leaf.endsWith(".test.ts")).sort(),
    ["reference-pipeline-dialogue-web.delegated.test.ts"],
  );

  // The public dialogue facade keeps no delegated factory, verifyAuth
  // callback, or broker auth DTO surface.
  const publicSource = await readFile(join(sourceRoot, "reference-pipeline-dialogue-web.ts"), "utf8");
  assert.doesNotMatch(publicSource, /createReferencePipelineDialogueWebDelegatedHandler|DelegatedAuth|verifyAuth|delegatedAuth/);
  const coreSource = await readFile(join(sourceRoot, "reference-pipeline-dialogue-web.core.ts"), "utf8");
  assert.doesNotMatch(coreSource, /DelegatedAuth|verifyAuth|delegatedAuth|ComposedReferenceGameBrowser/);
});