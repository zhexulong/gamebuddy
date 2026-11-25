/**
 * The platform is a member of the composed root in its own right, with a route family of its own.
 *
 * The shell's session token, the appearance it paints itself in, the interface language and whether this Host has a
 * connection directory used to be read out of the Chat half: the token was `session.snapshot.csrfToken` and the two
 * preferences were the Chat's own settings routes. A mount with no readable Chat half then had nothing to act
 * with - which is why the platform became a member (`readPlatformMember` in `composed-reference-game-browser.ts`)
 * and a route family (`COMPOSED_PLATFORM_ROUTES_V1` in `composed-browser-contract/index.ts`).
 *
 * What this file measures, all through the real handler and a real loopback listener:
 *
 *  - the root publishes the platform member, and its token is the SAME session the halves are read under - one root,
 *    one browser session;
 *  - a root whose Chat producer throws AND whose Game half cannot be read still publishes it, because it is neither
 *    producer's document;
 *  - `GET /api/platform/v1/{appearance,locale}` answer the seam's one record, `PUT` on either is CSRF-admitted and
 *    revision-checked, and neither the Chat half's settings routes nor the platform's own are served by accident;
 *  - a Host composed with no platform seam publishes no member and answers `404` on the family, rather than an empty
 *    one that looks like a preference nobody has chosen.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  COMPOSED_PLATFORM_ROUTES_V1,
  type ComposedPlatformPreferenceV1,
  composeReferenceGameBrowserProfile,
} from "./composed-browser-contract/index.js";
import {
  type ComposedReferenceGameBrowserPlatformSeam,
  createComposedReferenceGameBrowserRequestHandler,
} from "./composed-reference-game-browser.js";
import { composeGameProfile, type GameBrowserStateV1, GameBrowserFixtureV1 } from "./game-browser-contract/index.js";
import {
  composeTavernProfile,
  type TavernStateSnapshotV1,
  TavernBrowserFixtureV1,
} from "./tavern/browser-contract/index.js";

const bootstrapToken = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
const SESSION_COOKIE = "gb_composed_reference_game_session";
const profile = composeReferenceGameBrowserProfile({
  tavernProfile: composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: [
      "bootstrap",
      "state.read",
      "draft.read",
      "chat.submit",
      "chat.cancel",
      "chat.submission_status",
      "events",
    ],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  }),
  gameProfile: composeGameProfile({
    profileId: "gamebuddy.game.preview",
    releaseTier: "game_preview",
    operationIds: ["game.state.read"],
    navigationItemIds: ["game"],
  }),
});

/** The projection each half publishes on this session. Profiles match, so both are accepted. */
const chatState = (csrfToken: string, expiresAtMs: number): TavernStateSnapshotV1 => ({
  ...TavernBrowserFixtureV1.snapshot(),
  build: { browserContract: "tavern_browser_api/v1", profileId: profile.tavernProfile.profileId },
  csrfToken,
  browserSession: { expiresAtMs },
});
const gameState = (csrfToken: string, expiresAtMs: number): GameBrowserStateV1 => ({
  ...GameBrowserFixtureV1.state(),
  build: { browserContract: "game_browser_api/v1", profileId: profile.gameProfile!.profileId },
  csrfToken,
  browserSession: { expiresAtMs },
});

/** The one player-preference record the seam stands for, mutable so a write is visible to the next read. */
function platformSeam(overrides: Partial<ComposedPlatformPreferenceV1> = {}) {
  const preference: ComposedPlatformPreferenceV1 = { revision: 0, appearance: "system", locale: null, ...overrides };
  const seam: ComposedReferenceGameBrowserPlatformSeam = Object.freeze({
    read: async () => ({ ...preference }),
    updateAppearance: async (command) => {
      if (command.expectedRevision !== preference.revision) throw new Error("player_preference_revision_conflict");
      preference.revision += 1;
      preference.appearance = command.appearance;
      return { ...preference };
    },
    updateLocale: async (command) => {
      if (command.expectedRevision !== preference.revision) throw new Error("player_preference_revision_conflict");
      preference.revision += 1;
      preference.locale = command.locale;
      return { ...preference };
    },
    connection: "available",
  });
  return Object.freeze({ seam, preference });
}

type Handler = ReturnType<typeof createComposedReferenceGameBrowserRequestHandler>;

async function start(handler: Handler) {
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

async function bootstrap(origin: string) {
  const response = await fetch(`${origin}/api/composed-reference-game/v1/bootstrap`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0]!)
    .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(cookie, "the bootstrap set the broker's session cookie");
  return { status: response.status, body: await response.json(), cookie };
}

const read = (origin: string, path: string, cookie: string) =>
  fetch(`${origin}${path}`, { headers: { origin, cookie } });

const write = (origin: string, path: string, cookie: string, body: unknown, csrfToken?: string) =>
  fetch(`${origin}${path}`, {
    method: "PUT",
    headers: {
      origin,
      cookie,
      "content-type": "application/json",
      ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
    },
    body: JSON.stringify(body),
  });

function handlerWith(
  seam: ComposedReferenceGameBrowserPlatformSeam | undefined,
  halves: Readonly<{ readChat?: () => unknown; readGame?: () => unknown }> = {},
) {
  return createComposedReferenceGameBrowserRequestHandler({
    profile,
    bootstrapToken,
    readChat: async (context) => {
      if (halves.readChat !== undefined) return halves.readChat() as never;
      return chatState(context.csrfToken, context.browserSessionExpiresAtMs);
    },
    readGame: async (context) => {
      if (halves.readGame !== undefined) return halves.readGame() as never;
      return gameState(context.csrfToken, context.browserSessionExpiresAtMs);
    },
    ...(seam === undefined ? {} : { platform: seam }),
  });
}

test("the root publishes the platform member on the same session the halves publish", async () => {
  const { seam, preference } = platformSeam({ revision: 2, appearance: "dark", locale: "zh-CN" });
  const handler = handlerWith(seam);
  const server = await start(handler);
  try {
    const { status, body } = await bootstrap(server.origin);
    assert.equal(status, 200);
    assert.deepEqual(body.platform, {
      apiVersion: 1,
      csrfToken: body.chat.csrfToken,
      browserSession: { expiresAtMs: body.chat.browserSession.expiresAtMs },
      preference,
      connection: "available",
    });
    assert.equal(
      body.platform.csrfToken,
      body.game.csrfToken,
      "one root is one browser session: the platform's token is the Game half's too",
    );
  } finally {
    await server.close();
  }
});

test("a root whose Chat producer throws and whose Game half cannot be read still publishes the platform", async () => {
  const { seam } = platformSeam({ appearance: "light" });
  const handler = handlerWith(seam, {
    readChat: () => {
      throw new Error("chat_projection_failed");
    },
    readGame: () => {
      throw new Error("game_projection_failed");
    },
  });
  const server = await start(handler);
  try {
    const { status, body } = await bootstrap(server.origin);
    assert.equal(status, 200, "neither producer's fault refuses the root");
    assert.equal(Object.hasOwn(body, "chat"), false, "a half that could not be read is absent, not null");
    assert.equal(Object.hasOwn(body, "game"), false);
    assert.equal(body.platform.preference.appearance, "light");
  } finally {
    await server.close();
  }
});

test("a Host composed with no platform seam publishes no member and serves no platform route", async () => {
  const handler = handlerWith(undefined);
  const server = await start(handler);
  try {
    const { body, cookie } = await bootstrap(server.origin);
    assert.equal(Object.hasOwn(body, "platform"), false);
    for (const row of COMPOSED_PLATFORM_ROUTES_V1) {
      const response =
        row.method === "GET"
          ? await read(server.origin, row.path, cookie)
          : await write(server.origin, row.path, cookie, { expectedRevision: 0 });
      assert.equal(response.status, 404, `${row.method} ${row.path} is not published by a mount that owes no platform`);
    }
  } finally {
    await server.close();
  }
});

test("the platform's two reads are the one record's two fields", async () => {
  const { seam } = platformSeam({ revision: 7, appearance: "dark", locale: "zh-CN" });
  const handler = handlerWith(seam);
  const server = await start(handler);
  try {
    const { cookie } = await bootstrap(server.origin);
    const appearance = await read(server.origin, "/api/platform/v1/appearance", cookie);
    assert.equal(appearance.status, 200);
    assert.deepEqual(await appearance.json(), { revision: 7, appearance: "dark" });
    const locale = await read(server.origin, "/api/platform/v1/locale", cookie);
    assert.equal(locale.status, 200);
    assert.deepEqual(await locale.json(), { revision: 7, locale: "zh-CN" });
  } finally {
    await server.close();
  }
});

test("the platform's writes answer the record's one revision and refuse a stale one", async () => {
  const { seam, preference } = platformSeam();
  const handler = handlerWith(seam);
  const server = await start(handler);
  try {
    const { body, cookie } = await bootstrap(server.origin);
    const token = body.platform.csrfToken;

    const written = await write(
      server.origin,
      "/api/platform/v1/appearance",
      cookie,
      {
        expectedRevision: 0,
        appearance: "light",
      },
      token,
    );
    assert.equal(written.status, 200);
    assert.deepEqual(await written.json(), { revision: 1, appearance: "light" });
    assert.equal(preference.appearance, "light");

    const localised = await write(
      server.origin,
      "/api/platform/v1/locale",
      cookie,
      {
        expectedRevision: 1,
        locale: "zh-CN",
      },
      token,
    );
    assert.equal(localised.status, 200);
    assert.deepEqual(await localised.json(), { revision: 2, locale: "zh-CN" });

    // One record, one revision: the appearance write's revision is the one the locale write CASed on, and a write
    // that presents the revision it already spent is refused.
    const stale = await write(
      server.origin,
      "/api/platform/v1/appearance",
      cookie,
      {
        expectedRevision: 0,
        appearance: "dark",
      },
      token,
    );
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { code: "state_unavailable" });
    assert.equal(preference.appearance, "light", "a refused write changed nothing");
  } finally {
    await server.close();
  }
});

test("the platform's writes are admitted on this broker's own session and CSRF header", async () => {
  const { seam } = platformSeam();
  const handler = handlerWith(seam);
  const server = await start(handler);
  try {
    const { body, cookie } = await bootstrap(server.origin);
    const command = { expectedRevision: 0, appearance: "dark" };

    const headerless = await write(server.origin, "/api/platform/v1/appearance", cookie, command);
    assert.equal(headerless.status, 401, "a write with no CSRF header is not admitted");

    const foreign = await write(server.origin, "/api/platform/v1/appearance", cookie, command, "F".repeat(43));
    assert.equal(foreign.status, 401, "nor is one carrying a token this session did not mint");

    const expired = await write(
      server.origin,
      "/api/platform/v1/appearance",
      "wrong=1",
      command,
      body.platform.csrfToken,
    );
    assert.equal(expired.status, 401, "nor one with no session cookie behind it");
  } finally {
    await server.close();
  }
});

test("the platform's route family is not the Chat half's settings routes", async () => {
  const { seam } = platformSeam();
  const handler = handlerWith(seam);
  const server = await start(handler);
  try {
    const { cookie } = await bootstrap(server.origin);
    for (const retired of ["/api/tavern/v1/settings/appearance", "/api/tavern/v1/settings/ui-language"]) {
      const response = await read(server.origin, retired, cookie);
      assert.equal(response.status, 404, `${retired} is the management dispatcher's, not the composed broker's`);
    }
    assert.deepEqual(
      COMPOSED_PLATFORM_ROUTES_V1.map((row) => `${row.method} ${row.path}`),
      [
        "GET /api/platform/v1/appearance",
        "PUT /api/platform/v1/appearance",
        "GET /api/platform/v1/locale",
        "PUT /api/platform/v1/locale",
      ],
      "the family the handler builds its routes from is exactly these four wire shapes",
    );
  } finally {
    await server.close();
  }
});

test("the connection directory's availability is the composition's fact, not a record's", async () => {
  const preference: ComposedPlatformPreferenceV1 = { revision: 0, appearance: "system", locale: null };
  const seam: ComposedReferenceGameBrowserPlatformSeam = Object.freeze({
    read: async () => ({ ...preference }),
    updateAppearance: async () => ({ ...preference, revision: 1 }),
    updateLocale: async () => ({ ...preference, revision: 1 }),
    connection: "unavailable",
  });
  const handler = handlerWith(seam);
  const server = await start(handler);
  try {
    const { body } = await bootstrap(server.origin);
    assert.equal(body.platform.connection, "unavailable");
  } finally {
    await server.close();
  }
});
