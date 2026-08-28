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
    url: overrides.url ?? "/internal/lifecycle-activation",
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

    let callbackCalls = 0;
    let firstBrowserSessionId: string | undefined;
    const consumed = consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
      issuer,
      admission,
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
        (facts) => facts.browserSessionId,
      ),
      firstBrowserSessionId,
    );
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        admission,
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
        () => "foreign",
      ),
      undefined,
    );
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        Object.freeze({}) as ComposedReferenceGameBrowserLifecycleActivationAdmission,
        () => "forged",
      ),
      undefined,
    );
    let browserSessionId: string | undefined;
    assert.equal(
      consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        issuer,
        admission,
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

test("construction rejects fake or mismounted capabilities", () => {
  assert.throws(() => createComposedReferenceGameBrowserRequestHandler({ profile: {} as never, bootstrapToken, async readChat() { return TavernBrowserFixtureV1.snapshot(); } }), /Invalid composed/);
  assert.throws(() => createComposedReferenceGameBrowserRequestHandler({ profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile }), bootstrapToken, async readChat() { return TavernBrowserFixtureV1.snapshot(); } }), /game reader/);
  assert.throws(() => createComposedReferenceGameBrowserRequestHandler({ profile: composeReferenceGameBrowserProfile({ tavernProfile }), bootstrapToken: "short", async readChat() { return TavernBrowserFixtureV1.snapshot(); } }), /bootstrap token/);
});
