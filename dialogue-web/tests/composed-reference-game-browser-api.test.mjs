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


test("Stardew cabin client uses the frozen exact read and confirmation DTOs", async () => {
  const choiceHandle = "B".repeat(42) + "A";
  const idempotencyKey = "C".repeat(21) + "A";
  const recorder = transport(
    jsonResponse(root()),
    jsonResponse({
      apiVersion: 1,
      choices: [{ displayLabel: "North cabin", availability: "available", choiceHandle, expiresAtMs: 2000 }],
    }),
    jsonResponse({ apiVersion: 1, status: "manifest_admitted" }),
  );
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);

  await api.bootstrap(HANDLE);
  const choices = await api.readStardewCabins();
  const admitted = await api.confirmStardewCabin({ apiVersion: 1, idempotencyKey, choiceHandle, confirmed: true });

  assert.equal(choices.choices[0].displayLabel, "North cabin");
  assert.deepEqual(admitted, { apiVersion: 1, status: "manifest_admitted" });
  assert.deepEqual(
    recorder.calls.slice(1).map(({ input, init }) => ({ input, method: init.method, headers: init.headers, body: init.body })),
    [
      { input: "/api/composed-reference-game/v1/game/stardew/cabins", method: "GET", headers: undefined, body: undefined },
      {
        input: "/api/composed-reference-game/v1/game/stardew/cabins/confirm",
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
        body: JSON.stringify({ apiVersion: 1, idempotencyKey, choiceHandle, confirmed: true }),
      },
    ],
  );
});

test("Stardew cabin client rejects additive identity fields", async () => {
  const leaked = transport(jsonResponse({
    apiVersion: 1,
    choices: [{
      displayLabel: "North cabin",
      availability: "available",
      choiceHandle: "B".repeat(42) + "A",
      expiresAtMs: 2000,
      cabinId: "raw-cabin-id",
    }],
  }));

  await assert.rejects(
    createComposedReferenceGameBrowserApi(leaked.fetch).readStardewCabins(),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_stardew_cabin_choice",
  );
});


test("Stardew cabin validators require the exact frozen bounded contract", async () => {
  const validChoice = {
    displayLabel: "North cabin",
    availability: "available",
    choiceHandle: "B".repeat(42) + "A",
    expiresAtMs: 2000,
  };
  const invalidResponses = [
    { apiVersion: 2, choices: [validChoice] },
    { apiVersion: 1, choices: [{ ...validChoice, displayLabel: "" }] },
    { apiVersion: 1, choices: [{ ...validChoice, displayLabel: "x".repeat(129) }] },
    { apiVersion: 1, choices: [{ ...validChoice, availability: "busy" }] },
    { apiVersion: 1, choices: [{ ...validChoice, choiceHandle: "A".repeat(42) }] },
    { apiVersion: 1, choices: [{ ...validChoice, choiceHandle: "B".repeat(43) }] },
    { apiVersion: 1, choices: [{ ...validChoice, expiresAtMs: -1 }] },
    { apiVersion: 1, choices: [{ ...validChoice, result: "ready" }] },
    { apiVersion: 1, choices: Array.from({ length: 65 }, () => validChoice) },
  ];

  for (const response of invalidResponses) {
    const recorder = transport(jsonResponse(response));
    await assert.rejects(
      createComposedReferenceGameBrowserApi(recorder.fetch).readStardewCabins(),
      ComposedReferenceGameProtocolError,
    );
  }

  const malformedResult = transport(
    jsonResponse(root()),
    jsonResponse({ apiVersion: 1, status: "manifest_admitted", ready: true }),
  );
  const api = createComposedReferenceGameBrowserApi(malformedResult.fetch);
  await api.bootstrap(HANDLE);
  await assert.rejects(
    api.confirmStardewCabin({
      apiVersion: 1,
      idempotencyKey: "C".repeat(21) + "A",
      choiceHandle: validChoice.choiceHandle,
      confirmed: true,
    }),
    ComposedReferenceGameProtocolError,
  );
});

test("Stardew cabin problems preserve stale, conflict, in-progress, and uncertain outcomes", async () => {
  for (const code of [
    "stardew_cabin_choice_stale",
    "idempotency_conflict",
    "game_operation_in_progress",
    "stardew_manifest_handoff_uncertain",
  ]) {
    const recorder = transport(jsonResponse({ code }, 409));
    await assert.rejects(
      createComposedReferenceGameBrowserApi(recorder.fetch).readStardewCabins(),
      (error) => error instanceof ComposedReferenceGameProblemError && error.code === code,
    );
  }
});


test("Game setup preserves terminal unavailable and prerequisites outcomes as typed problems", async () => {
  for (const code of ["game_unavailable", "game_prerequisites_missing"]) {
    const key = "U".repeat(21) + "A";
    const recorder = transport(jsonResponse(root()), jsonResponse({ code }, 409));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.setupGame({ apiVersion: 1, idempotencyKey: key }),
      (error) => error instanceof ComposedReferenceGameProblemError && error.code === code,
    );
  }
});

test("Game setup client sends only the exact idempotency command and accepts 204 empty", async () => {
  const key = "U".repeat(21) + "A";
  const recorder = transport(jsonResponse(root()), new Response(null, { status: 204 }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  await api.setupGame({ apiVersion: 1, idempotencyKey: key });
  assert.deepEqual(recorder.calls[1], {
    input: "/api/composed-reference-game/v1/game/prerequisites/setup",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
      body: JSON.stringify({ apiVersion: 1, idempotencyKey: key }),
      credentials: "same-origin",
    },
  });
  await assert.rejects(
    api.setupGame({ apiVersion: 1, idempotencyKey: key, path: "C:\\Games\\Stardew Valley" }),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_setup_request",
  );
});

test("Game STOP client sends the exact generation-bound command and accepts only 204 empty", async () => {
  const key = "S".repeat(21) + "A";
  const recorder = transport(jsonResponse(root()), new Response(null, { status: 204 }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  await api.stopGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 });
  assert.deepEqual(
    { input: recorder.calls[1].input, method: recorder.calls[1].init.method, headers: recorder.calls[1].init.headers, body: recorder.calls[1].init.body },
    {
      input: "/api/composed-reference-game/v1/game/stop",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
      body: JSON.stringify({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 }),
    },
  );
  await assert.rejects(
    api.stopGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 0 }),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_stop_request",
  );
  await assert.rejects(
    api.stopGame({ apiVersion: 1, idempotencyKey: `${key}x`, expectedAttachmentGeneration: 1 }),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_stop_request",
  );
});

test("Game disconnect client sends the exact generation-bound command and accepts only 204 empty", async () => {
  const key = "D".repeat(21) + "A";
  const recorder = transport(jsonResponse(root()), new Response(null, { status: 204 }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  await api.disconnectGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 });
  assert.deepEqual(
    { input: recorder.calls[1].input, method: recorder.calls[1].init.method, headers: recorder.calls[1].init.headers, body: recorder.calls[1].init.body },
    {
      input: "/api/composed-reference-game/v1/game/disconnect",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
      body: JSON.stringify({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 }),
    },
  );
  await assert.rejects(
    api.disconnectGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 0 }),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_disconnect_request",
  );
});
