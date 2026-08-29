import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import {
  consumeComposedReferenceGameBrowserLifecycleActivationAdmission,
  createComposedReferenceGameBrowserRequestHandler,
  issueComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationIssuer,
  type ComposedReferenceGameBrowserReadContext,
} from "./composed-reference-game-browser.js";
import { composeReferenceGameBrowserProfile } from "./composed-browser-contract/index.js";
import { composeTavernProfile, TavernBrowserFixtureV1 } from "./tavern/browser-contract/index.js";
import { composeGameProfile, GameBrowserFixtureV1 } from "./game-browser-contract/index.js";

const bootstrapToken = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
const tavernProfile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
  operationIds: ["chat.submit", "chat.cancel"],
  navigationItemIds: ["chat"],
});
const gameProfile = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: ["game.state.read"],
  navigationItemIds: ["game"],
});
const gameProfileWithSetup = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: ["game.state.read", "game.prerequisites.setup"],
  navigationItemIds: ["game"],
});
const gameProfileWithDisconnect = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: ["game.state.read", "game.disconnect"],
  navigationItemIds: ["game"],
});
const gameProfileWithStop = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: ["game.state.read", "game.stop"],
  navigationItemIds: ["game"],
});
const gameProfileWithCabins = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: ["game.state.read", "game.stardew.cabins.read", "game.stardew.cabins.confirm"],
  navigationItemIds: ["game"],
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

function stateForGame(context: ComposedReferenceGameBrowserReadContext) {
  const base = GameBrowserFixtureV1.state();
  return {
    ...base,
    build: { ...base.build, profileId: gameProfile.profileId },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}

async function start(handler: ReturnType<typeof createComposedReferenceGameBrowserRequestHandler>) {
  const server = createServer((request, response) =>
    handler.handle(request, response, `http://127.0.0.1:${(server.address() as { port: number }).port}`),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, server, async close() { await handler.close(); await closeServer(server); } };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function bootstrap(origin: string) {
  return fetch(`${origin}/api/composed-reference-game/v1/bootstrap`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
  });
}

function lifecycleRequest(
  origin: string,
  cookie: string,
  csrfToken: string,
  overrides: Partial<Pick<IncomingMessage, "method" | "url">> & {
    headers?: IncomingMessage["headers"];
  } = {},
): IncomingMessage {
  const originUrl = new URL(origin);
  return {
    method: overrides.method ?? "POST",
    url: overrides.url ?? "/api/composed-reference-game/v1/lifecycle/activate",
    headers: {
      host: originUrl.host,
      origin,
      "content-type": "application/json",
      cookie,
      "x-csrf-token": csrfToken,
      ...overrides.headers,
    },
  } as unknown as IncomingMessage;
}

test("game.prerequisites.setup mount is exact and cannot drift from its production callback", () => {
  assert.throws(
    () => createComposedReferenceGameBrowserRequestHandler({
      profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithSetup }),
      bootstrapToken,
      readChat: async (context) => stateForChat(context),
      readGame: async (context) => stateForGame(context),
    }),
    /setup operation is mismounted/,
  );
  assert.throws(
    () => createComposedReferenceGameBrowserRequestHandler({
      profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile }),
      bootstrapToken,
      readChat: async (context) => stateForChat(context),
      readGame: async (context) => stateForGame(context),
      gameSetup: async () => undefined,
    }),
    /setup operation is mismounted/,
  );
});

test("authenticated game.prerequisites.setup is one-shot, schema-bound, and returns an empty completion", async () => {
  const calls: unknown[] = [];
  let handler!: ReturnType<typeof createComposedReferenceGameBrowserRequestHandler>;
  handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithSetup }),
    bootstrapToken,
    readChat: async (context) => stateForChat(context),
    readGame: async (context) => stateForGame(context),
    gameSetup: async (admission, command) => {
      const consumed = consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        handler.lifecycleActivationIssuer,
        admission,
        "game_setup",
        (facts) => { calls.push({ command, facts }); return true; },
      );
      if (consumed !== true) throw new Error("setup_admission_invalid");
    },
  });
  const server = await start(handler);
  try {
    const initial = await bootstrap(server.origin);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = await initial.json() as { chat: { csrfToken: string } };
    const path = `${server.origin}/api/composed-reference-game/v1/game/prerequisites/setup`;
    const command = { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" };
    const completed = await fetch(path, {
      method: "POST",
      headers: { origin: server.origin, cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    assert.equal(completed.status, 204);
    assert.equal(await completed.text(), "");
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0] as { command: unknown }).command, command);

    for (const request of [
      { headers: { origin: server.origin, cookie: "gb_composed_reference_game_session=wrong", "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" }, body: command },
      { headers: { origin: "http://127.0.0.1:1", cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" }, body: command },
      { headers: { origin: server.origin, cookie, "x-csrf-token": "wrong", "content-type": "application/json" }, body: command },
      { headers: { origin: server.origin, cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" }, body: { ...command, path: "C:\\Games\\Stardew Valley" } },
    ]) {
      const response = await fetch(path, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
      assert.equal(response.status, request.body === command ? 401 : 409);
    }
    assert.equal(calls.length, 1);
  } finally { await server.close(); }
});

test("game.stop mount is exact and cannot drift from its production callback", () => {
  assert.throws(
    () => createComposedReferenceGameBrowserRequestHandler({
      profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithStop }),
      bootstrapToken,
      readChat: async (context) => stateForChat(context),
      readGame: async (context) => stateForGame(context),
    }),
    /stop operation is mismounted/,
  );
  assert.throws(
    () => createComposedReferenceGameBrowserRequestHandler({
      profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile }),
      bootstrapToken,
      readChat: async (context) => stateForChat(context),
      readGame: async (context) => stateForGame(context),
      gameStop: async () => undefined,
    }),
    /stop operation is mismounted/,
  );
});

test("authenticated game.stop is one-shot, schema-bound, and returns an empty completion", async () => {
  const calls: unknown[] = [];
  let handler!: ReturnType<typeof createComposedReferenceGameBrowserRequestHandler>;
  handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithStop }),
    bootstrapToken,
    readChat: async (context) => stateForChat(context),
    readGame: async (context) => stateForGame(context),
    gameStop: async (admission, command) => {
      const consumed = consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        handler.lifecycleActivationIssuer,
        admission,
        "game_stop",
        (facts) => { calls.push({ command, facts }); return true; },
      );
      if (consumed !== true) throw new Error("stop_admission_invalid");
    },
  });
  const server = await start(handler);
  try {
    const initial = await bootstrap(server.origin);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = await initial.json() as { chat: { csrfToken: string } };
    const command = { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 1 };
    const stopped = await fetch(`${server.origin}/api/composed-reference-game/v1/game/stop`, {
      method: "POST",
      headers: { origin: server.origin, cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    assert.equal(stopped.status, 204);
    assert.equal(await stopped.text(), "");
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0] as { command: unknown }).command, command);
    const malformed = await fetch(`${server.origin}/api/composed-reference-game/v1/game/stop`, {
      method: "POST",
      headers: { origin: server.origin, cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ ...command, expectedAttachmentGeneration: 0 }),
    });
    assert.equal(malformed.status, 409);
    assert.deepEqual(await malformed.json(), { code: "malformed_request" });
    assert.equal(calls.length, 1);
    const unauthorized = await fetch(`${server.origin}/api/composed-reference-game/v1/game/stop`, {
      method: "POST",
      headers: { origin: server.origin, cookie, "x-csrf-token": "invalid", "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(calls.length, 1);
  } finally { await server.close(); }
});

test("Chat-only broker issues one session and leaves game route unavailable", async () => {
  let received: ComposedReferenceGameBrowserReadContext | undefined;
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) { received = context; return stateForChat(context); },
  });
  const server = await start(handler);
  try {
    const initial = await bootstrap(server.origin);
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = await initial.json() as { game: null; chat: { csrfToken: string; browserSession: { expiresAtMs: number } } };
    assert.equal(root.game, null);
    assert.equal(root.chat.csrfToken, received!.csrfToken);
    assert.equal(root.chat.browserSession.expiresAtMs, received!.browserSessionExpiresAtMs);
    const game = await fetch(`${server.origin}/api/composed-reference-game/v1/game`, { headers: { origin: server.origin, cookie } });
    assert.equal(game.status, 404);
  } finally { await server.close(); }
});

test("mounted game shares the exact minted read context and bootstrap remains one-time", async () => {
  const contexts: ComposedReferenceGameBrowserReadContext[] = [];
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile }),
    bootstrapToken,
    async readChat(context) { contexts.push(context); return stateForChat(context); },
    async readGame(context) { contexts.push(context); return stateForGame(context); },
  });
  const server = await start(handler);
  try {
    const initial = await bootstrap(server.origin);
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    assert.equal(contexts.length, 2);
    assert.deepEqual(contexts[0], contexts[1]);
    const state = await fetch(`${server.origin}/api/composed-reference-game/v1/state`, { headers: { origin: server.origin, cookie } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).game.build.profileId, gameProfile.profileId);
    const game = await fetch(`${server.origin}/api/composed-reference-game/v1/game`, { headers: { origin: server.origin, cookie } });
    assert.equal(game.status, 200);
    assert.deepEqual((await game.json()).browserSession.expiresAtMs, contexts[0]!.browserSessionExpiresAtMs);
    assert.equal((await bootstrap(server.origin)).status, 401);
  } finally { await server.close(); }
});

test("broker fails closed when the supplied origin is not a literal loopback origin", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
  });
  const server = createServer((request, response) =>
    handler.handle(request, response, "http://localhost:12345"),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const actualOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${actualOrigin}/api/composed-reference-game/v1/bootstrap`, {
      method: "POST",
      headers: { origin: "http://localhost:12345", "content-type": "application/json", host: "localhost:12345" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
    });
    assert.equal(response.status, 401);
  } finally {
    await handler.close();
    await closeServer(server);
  }
});

test("broker fail-closes invalid origin, cookie, producer output, and close", async () => {
  const profile = composeReferenceGameBrowserProfile({ tavernProfile });
  const invalidProducer = createComposedReferenceGameBrowserRequestHandler({
    profile,
    bootstrapToken,
    async readChat(context) { return { ...stateForChat(context), csrfToken: "wrong" }; },
  });
  const badServer = await start(invalidProducer);
  try { assert.equal((await bootstrap(badServer.origin)).status, 409); } finally { await badServer.close(); }

  const handler = createComposedReferenceGameBrowserRequestHandler({ profile, bootstrapToken, async readChat(context) { return stateForChat(context); } });
  const server = await start(handler);
  try {
    assert.equal((await fetch(`${server.origin}/api/composed-reference-game/v1/bootstrap`, { method: "POST", headers: { origin: "http://wrong", "content-type": "application/json" }, body: JSON.stringify({ apiVersion: 1, bootstrapToken }) })).status, 401);
    const initial = await bootstrap(server.origin);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    assert.equal((await fetch(`${server.origin}/api/composed-reference-game/v1/state`, { headers: { origin: server.origin, cookie: "gb_composed_reference_game_session=wrong" } })).status, 401);
    await handler.close();
    assert.equal((await fetch(`${server.origin}/api/composed-reference-game/v1/state`, { headers: { origin: server.origin, cookie } })).status, 503);
  } finally { await closeServer(server.server); }
});

test("lifecycle activation admission is fieldless, exact-session-bound, and one-shot", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
  });
  const server = await start(handler);
  try {
    const initial = await bootstrap(server.origin);
    const root = await initial.json() as {
      chat: { csrfToken: string; browserSession: { expiresAtMs: number } };
    };
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const issuer = handler.lifecycleActivationIssuer;
    const admission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(
      issuer,
      lifecycleRequest(server.origin, cookie, root.chat.csrfToken),
      server.origin,
    );

    assert.ok(admission);
    assert.deepEqual(Object.keys(issuer), []);
    assert.deepEqual(Object.keys(admission), []);
    assert.equal(JSON.stringify(issuer), "{}");
    assert.equal(JSON.stringify(admission), "{}");
    assert.equal("cookie" in issuer, false);
    assert.equal("csrfToken" in admission, false);
    assert.equal("sessionId" in admission, false);
    assert.equal("principal" in admission, false);
    assert.equal("path" in admission, false);
    assert.equal("request" in admission, false);

    const secondAdmission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(
      issuer,
      lifecycleRequest(server.origin, cookie, root.chat.csrfToken),
      server.origin,
    );
    assert.ok(secondAdmission);

    const cabinReadAdmission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(
      issuer,
      lifecycleRequest(server.origin, cookie, root.chat.csrfToken, {
        method: "GET",
        url: "/api/composed-reference-game/v1/game/stardew/cabins",
      }),
      server.origin,
    );
    assert.ok(cabinReadAdmission);
    let wrongOperationCallbackCalls = 0;
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        cabinReadAdmission,
        "lifecycle_activation",
        () => { wrongOperationCallbackCalls += 1; return "wrong-operation"; },
      ),
      undefined,
    );
    assert.equal(wrongOperationCallbackCalls, 0);
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        cabinReadAdmission,
        "cabin_read",
        () => "cabin-read",
      ),
      "cabin-read",
    );

    let callbackCalls = 0;
    let firstBrowserSessionId: string | undefined;
    const consumed = consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
      issuer,
      admission,
      "lifecycle_activation",
      (facts) => {
        callbackCalls += 1;
        assert.deepEqual(Object.keys(facts).sort(), ["browserSessionId", "expiresAtMs"]);
        assert.equal(Object.isFrozen(facts), true);
        assert.equal(facts.expiresAtMs, root.chat.browserSession.expiresAtMs);
        assert.match(facts.browserSessionId, /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(facts.browserSessionId, root.chat.csrfToken);
        assert.notEqual(facts.browserSessionId, cookie.split("=", 2)[1]);
        assert.equal(JSON.stringify(root).includes(facts.browserSessionId), false);
        assert.equal("browserSessionId" in issuer, false);
        assert.equal("browserSessionId" in admission, false);
        firstBrowserSessionId = facts.browserSessionId;
        assert.equal(
          consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
            issuer,
            admission,
            "lifecycle_activation",
            () => "reentered",
          ),
          undefined,
        );
        return "activated";
      },
    );
    assert.equal(consumed, "activated");
    assert.equal(callbackCalls, 1);
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        secondAdmission,
        "lifecycle_activation",
        (facts) => facts.browserSessionId,
      ),
      firstBrowserSessionId,
    );
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        admission,
        "lifecycle_activation",
        () => "replayed",
      ),
      undefined,
    );
  } finally { await server.close(); }
});

test("lifecycle admission rejects malformed auth, foreign and forged authority", async () => {
  const makeHandler = () => createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
  });
  const handler = makeHandler();
  const foreignHandler = makeHandler();
  const server = await start(handler);
  const foreignServer = await start(foreignHandler);
  try {
    const initial = await bootstrap(server.origin);
    const root = await initial.json() as { chat: { csrfToken: string } };
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const issuer = handler.lifecycleActivationIssuer;
    const validRequest = lifecycleRequest(server.origin, cookie, root.chat.csrfToken);
    const issue = (request: IncomingMessage, origin = server.origin) =>
      issueComposedReferenceGameBrowserLifecycleActivationAdmission(issuer, request, origin);

    assert.equal(issue(lifecycleRequest(server.origin, cookie, root.chat.csrfToken, { method: "GET" })), null);
    assert.equal(issue(lifecycleRequest(server.origin, cookie, root.chat.csrfToken, { headers: { "content-type": "text/plain" } })), null);
    assert.equal(issue(lifecycleRequest(server.origin, "gb_composed_reference_game_session=wrong", root.chat.csrfToken)), null);
    assert.equal(issue(lifecycleRequest(server.origin, cookie, "wrong")), null);
    assert.equal(issue(lifecycleRequest(server.origin, cookie, root.chat.csrfToken, { headers: { origin: "http://127.0.0.1:1" } })), null);
    assert.equal(issue(validRequest, "http://localhost:1"), null);
    assert.equal(
      issueComposedReferenceGameBrowserLifecycleActivationAdmission(
        Object.freeze({}) as ComposedReferenceGameBrowserLifecycleActivationIssuer,
        validRequest,
        server.origin,
      ),
      null,
    );

    const admission = issue(validRequest);
    assert.ok(admission);
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        foreignHandler.lifecycleActivationIssuer,
        admission,
        "lifecycle_activation",
        () => "foreign",
      ),
      undefined,
    );
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        Object.freeze({}) as ComposedReferenceGameBrowserLifecycleActivationAdmission,
        "lifecycle_activation",
        () => "forged",
      ),
      undefined,
    );
    let browserSessionId: string | undefined;
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        admission,
        "lifecycle_activation",
        (facts) => {
          browserSessionId = facts.browserSessionId;
          return "rightful";
        },
      ),
      "rightful",
    );

    const foreignInitial = await bootstrap(foreignServer.origin);
    const foreignRoot = await foreignInitial.json() as { chat: { csrfToken: string } };
    const foreignCookie = foreignInitial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const foreignAdmission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(
      foreignHandler.lifecycleActivationIssuer,
      lifecycleRequest(foreignServer.origin, foreignCookie, foreignRoot.chat.csrfToken),
      foreignServer.origin,
    );
    assert.ok(foreignAdmission);
    const foreignBrowserSessionId =
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        foreignHandler.lifecycleActivationIssuer,
        foreignAdmission,
        "lifecycle_activation",
        (facts) => facts.browserSessionId,
      );
    assert.match(foreignBrowserSessionId!, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(foreignBrowserSessionId, browserSessionId);
  } finally {
    await server.close();
    await foreignServer.close();
  }
});

test("lifecycle admission fails after expiry or broker close and publishes no route", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
  });
  const server = await start(handler);
  const realDateNow = Date.now;
  try {
    const initial = await bootstrap(server.origin);
    const root = await initial.json() as {
      apiVersion: number;
      build: unknown;
      chat: { csrfToken: string; browserSession: { expiresAtMs: number } };
      game: null;
    };
    assert.deepEqual(Object.keys(root).sort(), ["apiVersion", "build", "chat", "game"]);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const request = lifecycleRequest(server.origin, cookie, root.chat.csrfToken);
    const issuer = handler.lifecycleActivationIssuer;
    const expiringAdmission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(
      issuer,
      request,
      server.origin,
    );
    const closedAdmission = issueComposedReferenceGameBrowserLifecycleActivationAdmission(
      issuer,
      request,
      server.origin,
    );
    assert.ok(expiringAdmission);
    assert.ok(closedAdmission);
    Date.now = () => root.chat.browserSession.expiresAtMs;
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        expiringAdmission,
        "lifecycle_activation",
        () => "expired",
      ),
      undefined,
    );
    assert.equal(
      issueComposedReferenceGameBrowserLifecycleActivationAdmission(issuer, request, server.origin),
      null,
    );
    Date.now = realDateNow;

    const route = await fetch(`${server.origin}/api/composed-reference-game/v1/game.launch`, {
      method: "POST",
      headers: {
        origin: server.origin,
        "content-type": "application/json",
        cookie,
        "x-csrf-token": root.chat.csrfToken,
      },
      body: "{}",
    });
    assert.equal(route.status, 404);
    await handler.close();
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        closedAdmission,
        "lifecycle_activation",
        () => "closed",
      ),
      undefined,
    );
  } finally {
    Date.now = realDateNow;
    await handler.close();
    await closeServer(server.server);
  }
});

test("authenticated Stardew cabin routes dispatch only exact frozen wire contracts", async () => {
  const choiceHandle = "A".repeat(43);
  const idempotencyKey = "A".repeat(22);
  const rawCabinId = "raw-cabin-id-must-not-cross-wire";
  let readCalls = 0;
  let confirmCalls = 0;
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithCabins }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
    async readGame(context) { return stateForGame(context); },
    stardewCabins: {
      async read(admission) {
        readCalls += 1;
        return consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
          handler.lifecycleActivationIssuer,
          admission,
          "cabin_read",
          () => ({
            apiVersion: 1 as const,
            choices: [{
              displayLabel: "Cabin 1",
              availability: "available" as const,
              choiceHandle,
              expiresAtMs: Date.now() + 60_000,
            }],
          }),
        )!;
      },
      async confirm(admission, command) {
        confirmCalls += 1;
        return consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
          handler.lifecycleActivationIssuer,
          admission,
          "cabin_confirm",
          () => {
            assert.deepEqual(command, {
              apiVersion: 1,
              idempotencyKey,
              choiceHandle,
              confirmed: true,
            });
            return Object.freeze({ apiVersion: 1 as const, status: "manifest_admitted" as const });
          },
        )!;
      },
    },
  });
  const server = await start(handler);
  try {
    const initial = await bootstrap(server.origin);
    const root = await initial.json() as { chat: { csrfToken: string } };
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const cabinPath = `${server.origin}/api/composed-reference-game/v1/game/stardew/cabins`;

    const choicesResponse = await fetch(cabinPath, {
      headers: { origin: server.origin, cookie },
    });
    assert.equal(choicesResponse.status, 200);
    const choicesText = await choicesResponse.text();
    assert.deepEqual(JSON.parse(choicesText), {
      apiVersion: 1,
      choices: [{ displayLabel: "Cabin 1", availability: "available", choiceHandle, expiresAtMs: JSON.parse(choicesText).choices[0].expiresAtMs }],
    });
    assert.equal(readCalls, 1);
    for (const forbidden of [rawCabinId, "cabinId", "companionId", "ownerFarmhandId", "AI", "Bridge", "ready"])
      assert.equal(choicesText.includes(forbidden), false);

    const command = { apiVersion: 1, idempotencyKey, choiceHandle, confirmed: true };
    const confirmResponse = await fetch(`${cabinPath}/confirm`, {
      method: "POST",
      headers: {
        origin: server.origin,
        cookie,
        "content-type": "application/json",
        "x-csrf-token": root.chat.csrfToken,
      },
      body: JSON.stringify(command),
    });
    assert.equal(confirmResponse.status, 200);
    const confirmationText = await confirmResponse.text();
    assert.deepEqual(JSON.parse(confirmationText), { apiVersion: 1, status: "manifest_admitted" });
    assert.equal(confirmCalls, 1);
    for (const forbidden of [rawCabinId, "cabinId", "companionId", "ownerFarmhandId", "AI", "Bridge", "ready"])
      assert.equal(confirmationText.includes(forbidden), false);
  } finally { await server.close(); }
});

test("Stardew cabin routes reject wrong auth, origin, CSRF, and DTO before lifecycle callbacks", async () => {
  let lifecycleCalls = 0;
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithCabins }),
    bootstrapToken,
    async readChat(context) { return stateForChat(context); },
    async readGame(context) { return stateForGame(context); },
    stardewCabins: {
      async read() { lifecycleCalls += 1; throw new Error("must-not-dispatch"); },
      async confirm() { lifecycleCalls += 1; throw new Error("must-not-dispatch"); },
    },
  });
  const server = await start(handler);
  try {
    const initial = await bootstrap(server.origin);
    const root = await initial.json() as { chat: { csrfToken: string } };
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const cabinPath = `${server.origin}/api/composed-reference-game/v1/game/stardew/cabins`;
    const exactCommand = {
      apiVersion: 1,
      idempotencyKey: "A".repeat(22),
      choiceHandle: "A".repeat(43),
      confirmed: true,
    };

    assert.equal((await fetch(cabinPath, { headers: { origin: server.origin, cookie: "gb_composed_reference_game_session=wrong" } })).status, 401);
    assert.equal((await fetch(cabinPath, { headers: { origin: "http://127.0.0.1:1", cookie } })).status, 401);
    assert.equal((await fetch(`${cabinPath}/confirm`, {
      method: "POST",
      headers: { origin: server.origin, cookie, "content-type": "application/json", "x-csrf-token": "wrong" },
      body: JSON.stringify(exactCommand),
    })).status, 401);
    assert.equal((await fetch(`${cabinPath}/confirm`, {
      method: "POST",
      headers: { origin: server.origin, cookie, "content-type": "application/json", "x-csrf-token": root.chat.csrfToken },
      body: JSON.stringify({ ...exactCommand, cabinId: "forbidden-raw-id" }),
    })).status, 409);
    assert.equal(lifecycleCalls, 0);
  } finally { await server.close(); }
});

test("game.prerequisites.setup maps only frozen typed outcomes without leaking internal errors", async () => {
  const cases = [
    ["stardew_game_setup_idempotency_conflict", "idempotency_conflict"],
    ["stardew_game_setup_in_progress", "game_operation_in_progress"],
    ["stardew_game_setup_failed", "game_unavailable"],
    ["stardew_player_host_launch_not_staged", "game_prerequisites_missing"],
    ["private-setup-sensitive-C:\\Games\\Stardew Valley", "state_unavailable"],
  ] as const;
  for (const [internalMessage, expectedCode] of cases) {
    const handler = createComposedReferenceGameBrowserRequestHandler({
      profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithSetup }),
      bootstrapToken,
      readChat: async (context) => stateForChat(context),
      readGame: async (context) => stateForGame(context),
      gameSetup: async () => { throw new Error(internalMessage); },
    });
    const server = await start(handler);
    try {
      const initial = await bootstrap(server.origin);
      const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
      const root = await initial.json() as { chat: { csrfToken: string } };
      const response = await fetch(`${server.origin}/api/composed-reference-game/v1/game/prerequisites/setup`, {
        method: "POST",
        headers: { origin: server.origin, cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }),
      });
      assert.equal(response.status, 409);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { code: expectedCode });
      assert.equal(text.includes(internalMessage), false);
      assert.equal(text.includes("Stardew Valley"), false);
    } finally { await server.close(); }
  }
});

test("game.stop maps only frozen typed outcomes without leaking internal errors", async () => {
  const cases = [
    ["stardew_game_attachment_generation_conflict", "game_attachment_conflict"],
    ["stardew_game_runtime_unavailable", "game_runtime_unavailable"],
    ["stardew_game_stop_idempotency_conflict", "idempotency_conflict"],
    ["private-stop-sensitive-detail", "state_unavailable"],
  ] as const;
  for (const [internalMessage, expectedCode] of cases) {
    const handler = createComposedReferenceGameBrowserRequestHandler({
      profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithStop }),
      bootstrapToken,
      readChat: async (context) => stateForChat(context),
      readGame: async (context) => stateForGame(context),
      gameStop: async () => { throw new Error(internalMessage); },
    });
    const server = await start(handler);
    try {
      const initial = await bootstrap(server.origin);
      const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
      const root = await initial.json() as { chat: { csrfToken: string } };
      const response = await fetch(`${server.origin}/api/composed-reference-game/v1/game/stop`, {
        method: "POST",
        headers: { origin: server.origin, cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 1 }),
      });
      assert.equal(response.status, 409);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { code: expectedCode });
      assert.equal(text.includes(internalMessage), false);
    } finally { await server.close(); }
  }
});

test("game.disconnect maps only frozen typed outcomes without leaking internal errors", async () => {
  const cases = [
    ["stardew_game_attachment_generation_conflict", "game_attachment_conflict"],
    ["stardew_game_runtime_unavailable", "game_runtime_unavailable"],
    ["stardew_game_disconnect_idempotency_conflict", "idempotency_conflict"],
    ["stardew_game_disconnect_in_progress", "game_operation_in_progress"],
    ["private-disconnect-sensitive-detail", "state_unavailable"],
  ] as const;
  for (const [internalMessage, expectedCode] of cases) {
    const handler = createComposedReferenceGameBrowserRequestHandler({
      profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithDisconnect }),
      bootstrapToken,
      readChat: async (context) => stateForChat(context),
      readGame: async (context) => stateForGame(context),
      gameDisconnect: async () => { throw new Error(internalMessage); },
    });
    const server = await start(handler);
    try {
      const initial = await bootstrap(server.origin);
      const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
      const root = await initial.json() as { chat: { csrfToken: string } };
      const response = await fetch(`${server.origin}/api/composed-reference-game/v1/game/disconnect`, {
        method: "POST",
        headers: { origin: server.origin, cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 1 }),
      });
      assert.equal(response.status, 409);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { code: expectedCode });
      assert.equal(text.includes(internalMessage), false);
    } finally { await server.close(); }
  }
});

test("Stardew cabin confirmation maps only frozen typed outcomes", async () => {
  const cases = [
    ["stardew_cabin_choice_expired", "stardew_cabin_choice_stale"],
    ["stardew_cabin_idempotency_conflict", "idempotency_conflict"],
    ["stardew_cabin_confirmation_conflict", "game_operation_in_progress"],
    ["stardew_cabin_publication_uncertain", "stardew_manifest_handoff_uncertain"],
    ["private-sensitive-detail", "state_unavailable"],
  ] as const;
  for (const [internalMessage, expectedCode] of cases) {
    const handler = createComposedReferenceGameBrowserRequestHandler({
      profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithCabins }),
      bootstrapToken,
      async readChat(context) { return stateForChat(context); },
      async readGame(context) { return stateForGame(context); },
      stardewCabins: {
        async read() { return Object.freeze({ apiVersion: 1 as const, choices: [] }); },
        async confirm() { throw new Error(internalMessage); },
      },
    });
    const server = await start(handler);
    try {
      const initial = await bootstrap(server.origin);
      const root = await initial.json() as { chat: { csrfToken: string } };
      const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
      const response = await fetch(`${server.origin}/api/composed-reference-game/v1/game/stardew/cabins/confirm`, {
        method: "POST",
        headers: {
          origin: server.origin,
          cookie,
          "content-type": "application/json",
          "x-csrf-token": root.chat.csrfToken,
        },
        body: JSON.stringify({
          apiVersion: 1,
          idempotencyKey: "A".repeat(22),
          choiceHandle: "A".repeat(43),
          confirmed: true,
        }),
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { code: expectedCode });
    } finally {
      await server.close();
    }
  }
});

test("construction rejects fake or mismounted capabilities", () => {
  assert.throws(() => createComposedReferenceGameBrowserRequestHandler({ profile: {} as never, bootstrapToken, async readChat() { return TavernBrowserFixtureV1.snapshot(); } }), /Invalid composed/);
  assert.throws(() => createComposedReferenceGameBrowserRequestHandler({ profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile }), bootstrapToken, async readChat() { return TavernBrowserFixtureV1.snapshot(); } }), /game reader/);
  assert.throws(() => createComposedReferenceGameBrowserRequestHandler({ profile: composeReferenceGameBrowserProfile({ tavernProfile }), bootstrapToken: "short", async readChat() { return TavernBrowserFixtureV1.snapshot(); } }), /bootstrap token/);
});


test("authenticated game.disconnect is schema-bound, admission-bound, and returns 204 empty", async () => {
  const calls: unknown[] = [];
  let handler!: ReturnType<typeof createComposedReferenceGameBrowserRequestHandler>;
  handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: gameProfileWithDisconnect }),
    bootstrapToken,
    readChat: async (context) => stateForChat(context),
    readGame: async (context) => stateForGame(context),
    gameDisconnect: async (admission, command) => {
      const consumed = consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        handler.lifecycleActivationIssuer, admission, "game_disconnect",
        (facts) => { calls.push({ command, facts }); return true; },
      );
      if (consumed !== true) throw new Error("disconnect_admission_invalid");
    },
  });
  const server = await start(handler);
  try {
    const initial = await bootstrap(server.origin);
    const cookie = initial.headers.get("set-cookie")!.split(";", 1)[0]!;
    const root = await initial.json() as { chat: { csrfToken: string } };
    const command = { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 1 };
    const response = await fetch(`${server.origin}/api/composed-reference-game/v1/game/disconnect`, {
      method: "POST",
      headers: { origin: server.origin, cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(calls.length, 1);
    const malformed = await fetch(`${server.origin}/api/composed-reference-game/v1/game/disconnect`, {
      method: "POST",
      headers: { origin: server.origin, cookie, "x-csrf-token": root.chat.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ ...command, extra: true }),
    });
    assert.equal(malformed.status, 409);
    assert.equal(calls.length, 1);
  } finally { await server.close(); }
});
