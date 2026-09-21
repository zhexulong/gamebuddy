import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createComposedReferenceGameBrowserApi } from "../src/composed-reference-game-browser-api.ts";
import { composeReferenceGameBrowserProfile } from "../../host/src/composed-browser-contract/index.js";
import { createComposedReferenceGameBrowserRequestHandler } from "../../host/src/composed-reference-game-browser.ts";
import { GameBrowserFixtureV1, composeGameProfile } from "../../host/src/game-browser-contract/index.js";
import { TavernBrowserFixtureV1, composeTavernProfile } from "../../host/src/tavern/browser-contract/index.js";

const BOOTSTRAP_TOKEN = "A".repeat(43);
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
const profile = composeReferenceGameBrowserProfile({ tavernProfile, gameProfile });

function stateForChat(context) {
  const state = TavernBrowserFixtureV1.snapshot();
  return {
    ...state,
    build: { ...state.build, profileId: tavernProfile.profileId },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}

function stateForGame(context) {
  const state = GameBrowserFixtureV1.state();
  return {
    ...state,
    build: { ...state.build, profileId: gameProfile.profileId },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}

async function start(handler) {
  const server = createServer((request, response) => {
    const address = server.address();
    handler.handle(request, response, `http://127.0.0.1:${address.port}`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await handler.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("composed browser client and Host listener complete a real bootstrap/state round trip", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile,
    bootstrapToken: BOOTSTRAP_TOKEN,
    readChat: async (context) => stateForChat(context),
    readGame: async (context) => stateForGame(context),
  });
  const server = await start(handler);
  try {
    const calls = [];
    const nativeFetch = globalThis.fetch;
    let sessionCookie;
    const fetchLike = async (input, init) => {
      const headers = { ...(init?.headers ?? {}), origin: server.origin };
      if (sessionCookie !== undefined) headers.cookie = sessionCookie;
      const requestInit = { ...init, headers };
      calls.push({ input: String(input), init: requestInit });
      const response = await nativeFetch(`${server.origin}${input}`, requestInit);
      const setCookie = response.headers.get("set-cookie");
      if (setCookie !== null) sessionCookie = setCookie.split(";", 1)[0];
      return response;
    };
    const api = createComposedReferenceGameBrowserApi(fetchLike);
    const root = await api.bootstrap(BOOTSTRAP_TOKEN);
    const reread = await api.readState();

    assert.equal(root.build.browserContract, "composed_reference_game_browser_api/v1");
    assert.equal(root.game.build.profileId, gameProfile.profileId);
    assert.equal(reread.chat.build.profileId, tavernProfile.profileId);
    assert.deepEqual(calls.map(({ input, init }) => [input, init.method]), [
      ["/api/composed-reference-game/v1/bootstrap", "POST"],
      ["/api/composed-reference-game/v1/state", "GET"],
    ]);
    assert.match(calls[0].init.body, /bootstrapToken/);

    const forged = await nativeFetch(`${server.origin}/api/composed-reference-game/v1/state`, {
      headers: { origin: server.origin },
    });
    assert.equal(forged.status, 401);
  } finally {
    await server.close();
  }
});

test("composed browser listener rejects bootstrap token replay", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile,
    bootstrapToken: BOOTSTRAP_TOKEN,
    readChat: async (context) => stateForChat(context),
    readGame: async (context) => stateForGame(context),
  });
  const server = await start(handler);
  try {
    const first = await fetch(`${server.origin}/api/composed-reference-game/v1/bootstrap`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: BOOTSTRAP_TOKEN }),
    });
    assert.equal(first.status, 200);
    const replay = await fetch(`${server.origin}/api/composed-reference-game/v1/bootstrap`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: BOOTSTRAP_TOKEN }),
    });
    assert.equal(replay.status, 401);
  } finally {
    await server.close();
  }
});

test("composed browser listener rejects additive client input on bootstrap", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile,
    bootstrapToken: BOOTSTRAP_TOKEN,
    readChat: async (context) => stateForChat(context),
    readGame: async (context) => stateForGame(context),
  });
  const server = await start(handler);
  try {
    const extraField = await fetch(`${server.origin}/api/composed-reference-game/v1/bootstrap`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: BOOTSTRAP_TOKEN, extra: true }),
    });
    assert.equal(extraField.status, 401);
  } finally {
    await server.close();
  }
});

test("composed browser listener enforces CSRF on POST operations", async () => {
  let retryCalls = 0;
  const discoveryGameProfile = composeGameProfile({
    profileId: "gamebuddy.game.preview",
    releaseTier: "game_preview",
    operationIds: [
      "game.state.read",
      "game.installation.discovery.read",
      "game.installation.discovery.confirm",
      "game.installation.discovery.retry",
      "game.installation.discovery.cancel",
      "game.installation.discovery.manual_picker",
    ],
    navigationItemIds: ["game"],
  });
  const discoveryProfile = composeReferenceGameBrowserProfile({ tavernProfile, gameProfile: discoveryGameProfile });
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: discoveryProfile,
    bootstrapToken: BOOTSTRAP_TOKEN,
    readChat: async (context) => stateForChat(context),
    readGame: async (context) => stateForGame(context),
    gameDiscovery: {
      read: async () => ({ apiVersion: 1, candidates: [], diagnostics: [] }),
      confirm: async () => ({ apiVersion: 1, status: "accepted" }),
      retry: async () => { retryCalls += 1; return { apiVersion: 1, candidates: [], diagnostics: [] }; },
      cancel: async () => ({ apiVersion: 1, status: "accepted" }),
      manualPicker: async () => ({ apiVersion: 1, status: "requested" }),
    },
  });
  const server = await start(handler);
  try {
    const boot = await fetch(`${server.origin}/api/composed-reference-game/v1/bootstrap`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: BOOTSTRAP_TOKEN }),
    });
    assert.equal(boot.status, 200);
    const root = await boot.json();
    const sessionCookie = boot.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(sessionCookie);
    const csrf = root.chat.csrfToken;
    assert.ok(csrf);

    const retryPath = "/api/composed-reference-game/v1/game/installation/discovery/retry";
    const retryBody = JSON.stringify({ apiVersion: 1 });

    const noCsrf = await fetch(`${server.origin}${retryPath}`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json", cookie: sessionCookie },
      body: retryBody,
    });
    assert.equal(noCsrf.status, 401);

    const wrongCsrf = await fetch(`${server.origin}${retryPath}`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json", cookie: sessionCookie, "x-csrf-token": "B".repeat(43) },
      body: retryBody,
    });
    assert.equal(wrongCsrf.status, 401);

    const rightCsrf = await fetch(`${server.origin}${retryPath}`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json", cookie: sessionCookie, "x-csrf-token": csrf },
      body: retryBody,
    });
    assert.equal(rightCsrf.status, 200);
    assert.equal(retryCalls, 1);
  } finally {
    await server.close();
  }
});
