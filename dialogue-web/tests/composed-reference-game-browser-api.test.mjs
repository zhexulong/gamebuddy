import assert from "node:assert/strict";
import test from "node:test";

import {
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
  createComposedReferenceGameBrowserApi,
  validateComposedReferenceGameRoot,
} from "../src/composed-reference-game-browser-api.ts";

const HANDLE = "A".repeat(43);

function chatSnapshot() {
  return {
    apiVersion: 1,
    build: {
      browserContract: "tavern_browser_api/v1",
      profileId: "gamebuddy.chat-core.reference-pipeline",
    },
    csrfToken: HANDLE,
    browserSession: { expiresAtMs: 1000 },
    operations: [
      {
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: "available",
        routeId: "chat.submit",
      },
    ],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: HANDLE, generation: 1, stateRevision: HANDLE },
    chat: {
      companion: { name: "Mira" },
      title: "Exact Chat",
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  };
}

function gameSnapshot(overrides = {}) {
  return {
    apiVersion: 1,
    build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
    csrfToken: HANDLE,
    browserSession: { expiresAtMs: 1000 },
    game: {
      prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
      instance: { status: "none", gameTitle: null },
      compatibility: { status: "unchecked", message: null },
      attachment: { status: "none", generation: 0 },
      connectionStatus: "none",
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: { available: false, count: 0 },
      latestOutcome: "none",
      ...overrides,
    },
  };
}

function root(game = gameSnapshot()) {
  return {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: chatSnapshot(),
    game,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transport(...responses) {
  const calls = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("missing_response");
      return response;
    },
  };
}

test("composed client redeems one exact bootstrap then reads the authoritative composed state", async () => {
  const recorder = transport(jsonResponse(root()), jsonResponse(root(null)));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);

  const opened = await api.bootstrap(HANDLE);
  const reread = await api.readState();

  assert.equal(opened.game.game.connectionStatus, "none");
  assert.equal(reread.game, null);
  assert.deepEqual(
    recorder.calls.map(({ input, init }) => ({
      input,
      method: init.method,
      credentials: init.credentials,
      body: init.body,
    })),
    [
      {
        input: "/api/composed-reference-game/v1/bootstrap",
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ apiVersion: 1, bootstrapToken: HANDLE }),
      },
      {
        input: "/api/composed-reference-game/v1/state",
        method: "GET",
        credentials: "same-origin",
        body: undefined,
      },
    ],
  );
});

test("composed validator is closed and binds nested Chat and Game to one browser session", () => {
  assert.equal(validateComposedReferenceGameRoot(root()).game.game.attachment.status, "none");
  assert.throws(
    () => validateComposedReferenceGameRoot({ ...root(), forged: true }),
    ComposedReferenceGameProtocolError,
  );
  assert.throws(
    () => validateComposedReferenceGameRoot(root({ ...gameSnapshot(), csrfToken: "C".repeat(43) })),
    ComposedReferenceGameProtocolError,
  );
  assert.throws(
    () => validateComposedReferenceGameRoot(root(gameSnapshot({ launchPath: "C:/forged" }))),
    ComposedReferenceGameProtocolError,
  );
});

test("composed client reports bounded server problems without accepting additive fields", async () => {
  const unavailable = transport(jsonResponse({ code: "state_unavailable" }, 409));
  await assert.rejects(
    createComposedReferenceGameBrowserApi(unavailable.fetch).readState(),
    (error) =>
      error instanceof ComposedReferenceGameProblemError &&
      error.code === "state_unavailable" &&
      error.retryable === true,
  );

  const forged = transport(jsonResponse({ code: "state_unavailable", detail: "raw producer text" }, 409));
  await assert.rejects(
    createComposedReferenceGameBrowserApi(forged.fetch).readState(),
    ComposedReferenceGameProtocolError,
  );

  const foreign = transport(jsonResponse({ code: "foreign_server_detail" }, 409));
  await assert.rejects(
    createComposedReferenceGameBrowserApi(foreign.fetch).readState(),
    (error) =>
      error instanceof ComposedReferenceGameProtocolError &&
      error.reason === "invalid_problem",
  );
});
