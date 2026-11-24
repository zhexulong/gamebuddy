import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { composeReferenceGameBrowserProfile } from "./composed-browser-contract/index.js";
import {
  createComposedReferenceGameBrowserRequestHandler,
  type ComposedReferenceGameBrowserReadContext,
} from "./composed-reference-game-browser.js";
import { composeGameProfile, GameBrowserFixtureV1 } from "./game-browser-contract/index.js";
import { composeTavernProfile, TavernBrowserFixtureV1 } from "./tavern/browser-contract/index.js";

/**
 * The two halves of a composed root are two producer seams, and a fault in either one must not take the
 * document - or the session that reads it - down with it.
 *
 * Measured before this held: `/bootstrap` refused the whole request for a Game-half fault
 * (`409 {code: "state_unavailable", cause: "game_projection_failed"}`) AND retired the session it had just
 * minted (`if (session === activeSession) session = undefined`, `handleBootstrap`), so a completely healthy
 * Chat domain went down with a native game fault - no conversation, no settings, no memory, and no session
 * for the Chat half's own route to answer on. The Chat half had the mirror image of the same defect: it owned
 * the whole document, so a Chat fault took the Game surface - and the running game behind it - down with it.
 *
 * The readings below are the six directions of one rule, one per half: a half that throws, a half that answers
 * something this Host cannot publish, and both halves healthy. Each of the first four answers a root WITHOUT
 * that half's member (never `null`, which is a profile that mounts none), keeps the cookie, and leaves the
 * other half's own route answering exactly as it did.
 */

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

function chatFor(context: ComposedReferenceGameBrowserReadContext) {
  const base = TavernBrowserFixtureV1.snapshot();
  return {
    ...base,
    build: { ...base.build, profileId: tavernProfile.profileId },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}

function gameFor(context: ComposedReferenceGameBrowserReadContext) {
  return {
    ...GameBrowserFixtureV1.state(),
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}

async function start(
  handler: ReturnType<typeof createComposedReferenceGameBrowserRequestHandler>,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) =>
    handler.handle(request, response, `http://127.0.0.1:${(server.address() as { port: number }).port}`),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    async close() {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The one redeem a launch makes, with the one-shot token this Host minted. */
async function bootstrap(origin: string): Promise<Response> {
  return await fetch(`${origin}/api/composed-reference-game/v1/bootstrap`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
  });
}

/** The session cookie a bootstrap published, as the browser would send it back. */
function sessionCookie(response: Response): string | undefined {
  const header = response.headers.get("set-cookie");
  return header === null ? undefined : header.split(";", 1)[0];
}

async function readState(origin: string, cookie: string | undefined): Promise<Response> {
  return await fetch(`${origin}/api/composed-reference-game/v1/state`, {
    headers: cookie === undefined ? { origin } : { origin, cookie },
  });
}

async function readGame(origin: string, cookie: string | undefined): Promise<Response> {
  return await fetch(`${origin}/api/composed-reference-game/v1/game`, {
    headers: cookie === undefined ? { origin } : { origin, cookie },
  });
}

function handlerWith(
  readChat: (context: ComposedReferenceGameBrowserReadContext) => unknown,
  readGame: (context: ComposedReferenceGameBrowserReadContext) => unknown,
) {
  return createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile }),
    bootstrapToken,
    async readChat(context) {
      return (await readChat(context)) as never;
    },
    async readGame(context) {
      const game = await readGame(context);
      return game as never;
    },
  });
}

test("a Game half that throws answers a root with no game member, and the session it was read on survives", async () => {
  const server = await start(
    handlerWith(
      (context) => chatFor(context),
      () => {
        throw new Error("the native game bridge is not answering");
      },
    ),
  );
  try {
    const opened = await bootstrap(server.origin);
    assert.equal(opened.status, 200, "a Game fault is not the whole document's");
    const root = (await opened.json()) as Record<string, unknown>;
    assert.equal(Object.hasOwn(root, "game"), false, "the Game half is absent, never a `null` game");
    assert.ok(root.chat !== null && typeof root.chat === "object", "the Chat half is the complete document");
    assert.equal((root.chat as { build: { profileId: string } }).build.profileId, tavernProfile.profileId);
    assert.equal(root.apiVersion, 1);

    const cookie = sessionCookie(opened);
    assert.ok(cookie !== undefined, "the session is minted and published");
    const state = await readState(server.origin, cookie);
    assert.equal(state.status, 200, "the one-time credential was not spent on a refused request");
    const reread = (await state.json()) as Record<string, unknown>;
    assert.equal(Object.hasOwn(reread, "game"), false);
    assert.ok(reread.chat !== null);

    // The Game half's own route is still the authority for the Game half, and it still refuses: what was
    // degraded is the composed root, never the game's own read.
    const gameRead = await readGame(server.origin, cookie);
    assert.equal(gameRead.status, 409);
    assert.deepEqual(await gameRead.json(), { code: "state_unavailable" });
  } finally {
    await server.close();
  }
});

test("a Game half this Host cannot publish degrades the same way the throwing one does", async () => {
  const server = await start(
    handlerWith(
      (context) => chatFor(context),
      // A legal Game projection of a DIFFERENT browser session: the root would carry a game the page
      // cannot be told is its own, so there is no Game half to publish either.
      () => ({ ...GameBrowserFixtureV1.state(), csrfToken: "C".repeat(43) }),
    ),
  );
  try {
    const opened = await bootstrap(server.origin);
    assert.equal(opened.status, 200);
    const root = (await opened.json()) as Record<string, unknown>;
    assert.equal(Object.hasOwn(root, "game"), false);
    assert.ok(root.chat !== null);
  } finally {
    await server.close();
  }
});

test("a Chat half that throws answers a root with no chat member, and the Game half beside it survives", async () => {
  const server = await start(
    handlerWith(
      () => {
        throw new Error("the chat store is not answering");
      },
      (context) => gameFor(context),
    ),
  );
  try {
    const opened = await bootstrap(server.origin);
    assert.equal(opened.status, 200, "a conversation that could not be read is not the whole document's");
    const root = (await opened.json()) as Record<string, unknown>;
    assert.equal(Object.hasOwn(root, "chat"), false, "the Chat half is absent, never a `null` chat");
    assert.equal(typeof root.game, "object", "the Game half is the document's own, and it is here");

    const cookie = sessionCookie(opened);
    assert.ok(cookie !== undefined, "the session is minted and published");
    const state = await readState(server.origin, cookie);
    assert.equal(state.status, 200, "the session's own read answers");
    assert.equal(Object.hasOwn((await state.json()) as Record<string, unknown>, "chat"), false);

    // The Game half's own route is still the authority for the Game half, and it still answers: what was
    // degraded is the composed root's Chat member, never the game's own read.
    const gameRead = await readGame(server.origin, cookie);
    assert.equal(gameRead.status, 200);
    assert.equal(((await gameRead.json()) as { game: { connectionStatus: string } }).game.connectionStatus, "none");
  } finally {
    await server.close();
  }
});

test("a Chat half this Host cannot publish degrades the same way the throwing one does", async () => {
  const server = await start(
    handlerWith(
      // A legal Chat projection of a DIFFERENT profile: the root would carry a conversation this Host does
      // not publish, so there is no Chat half to publish either.
      (context) => ({
        ...chatFor(context),
        build: { ...chatFor(context).build, profileId: "gamebuddy.chat-core.other" },
      }),
      (context) => gameFor(context),
    ),
  );
  try {
    const opened = await bootstrap(server.origin);
    assert.equal(opened.status, 200);
    const root = (await opened.json()) as Record<string, unknown>;
    assert.equal(Object.hasOwn(root, "chat"), false);
    assert.equal(typeof root.game, "object");
  } finally {
    await server.close();
  }
});

test("both halves healthy still answer one root that carries both members", async () => {
  const server = await start(
    handlerWith(
      (context) => chatFor(context),
      (context) => gameFor(context),
    ),
  );
  try {
    const opened = await bootstrap(server.origin);
    assert.equal(opened.status, 200);
    const cookie = sessionCookie(opened);
    assert.ok(cookie !== undefined);
    const state = await readState(server.origin, cookie);
    assert.equal(state.status, 200);
    const root = (await state.json()) as Record<string, unknown>;
    assert.equal(Object.hasOwn(root, "game"), true, "a Game half that reads is still published");
    assert.equal(typeof root.game, "object");
    assert.equal(Object.hasOwn(root, "chat"), true, "and the Chat half beside it");
    assert.equal(typeof root.chat, "object");
  } finally {
    await server.close();
  }
});
