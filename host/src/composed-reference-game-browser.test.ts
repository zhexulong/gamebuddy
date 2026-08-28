import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  createComposedReferenceGameBrowserRequestHandler,
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

test("construction rejects fake or mismounted capabilities", () => {
  assert.throws(() => createComposedReferenceGameBrowserRequestHandler({ profile: {} as never, bootstrapToken, async readChat() { return TavernBrowserFixtureV1.snapshot(); } }), /Invalid composed/);
  assert.throws(() => createComposedReferenceGameBrowserRequestHandler({ profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile }), bootstrapToken, async readChat() { return TavernBrowserFixtureV1.snapshot(); } }), /game reader/);
  assert.throws(() => createComposedReferenceGameBrowserRequestHandler({ profile: composeReferenceGameBrowserProfile({ tavernProfile }), bootstrapToken: "short", async readChat() { return TavernBrowserFixtureV1.snapshot(); } }), /bootstrap token/);
});
