import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
  createComposedReferenceGameBrowserApi,
  validateComposedReferenceGameRoot,
} from "../src/composed-reference-game-browser-api.ts";
import { composedProblemView } from "../src/composed-problem-view.ts";
import { messages } from "../src/i18n.ts";
import { composeReferenceGameBrowserProfile } from "../../host/src/composed-browser-contract/index.js";
import { createComposedReferenceGameBrowserRequestHandler } from "../../host/src/composed-reference-game-browser.js";
import { composeGameProfile, GameBrowserFixtureV1 } from "../../host/src/game-browser-contract/index.js";
import { composeTavernProfile, TavernBrowserFixtureV1 } from "../../host/src/tavern/browser-contract/index.js";

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
      instance: { status: "none", gameTitle: null, generation: 0 },
      compatibility: { status: "unchecked", message: null },
      attachment: { status: "none", generation: 0 },
      connectionStatus: "none",
      actionAuthority: "unavailable",
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

test("composed Game projection admits the resume-phase syncing status while staying closed to unknown statuses", () => {
  // reconnecting → syncing → connected_idle are the coordinator resume-phase
  // projections; the browser gate must admit syncing instead of failing closed.
  assert.equal(
    validateComposedReferenceGameRoot(root(gameSnapshot({ connectionStatus: "syncing" }))).game.game.connectionStatus,
    "syncing",
  );
  assert.equal(
    validateComposedReferenceGameRoot(root(gameSnapshot({ connectionStatus: "reconnecting" }))).game.game.connectionStatus,
    "reconnecting",
  );
  for (const connectionStatus of ["connected", "resuming", "syncing_idle", "SYNCING"]) {
    assert.throws(
      () => validateComposedReferenceGameRoot(root(gameSnapshot({ connectionStatus }))),
      ComposedReferenceGameProtocolError,
    );
  }
});

test("composed Game projection admits the action-authority statuses while staying closed to invented values", () => {
  for (const actionAuthority of ["unavailable", "active", "paused"]) {
    assert.equal(
      validateComposedReferenceGameRoot(root(gameSnapshot({ actionAuthority }))).game.game.actionAuthority,
      actionAuthority,
    );
  }
  for (const actionAuthority of ["pending", "awaiting", "resumed", "ready"]) {
    assert.throws(
      () => validateComposedReferenceGameRoot(root(gameSnapshot({ actionAuthority }))),
      ComposedReferenceGameProtocolError,
    );
  }
  assert.throws(
    () => validateComposedReferenceGameRoot(root(gameSnapshot({ actionAuthorityDetail: "paused" }))),
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

  const foreign = transport(jsonResponse({ code: "raw producer detail" }, 409));
  await assert.rejects(
    createComposedReferenceGameBrowserApi(foreign.fetch).readState(),
    (error) =>
      error instanceof ComposedReferenceGameProtocolError &&
      error.reason === "invalid_problem",
  );

  // A code this build does not know is still a *bounded* token: it is preserved
  // and shown instead of being turned into an opaque protocol failure, which is
  // what makes an unfamiliar refusal diagnosable rather than invisible.
  const unknown = transport(jsonResponse({ code: "game_endgame_settlement_unavailable" }, 409));
  await assert.rejects(
    createComposedReferenceGameBrowserApi(unknown.fetch).readState(),
    (error) =>
      error instanceof ComposedReferenceGameProblemError &&
      error.code === "game_endgame_settlement_unavailable" &&
      error.causeCode === null,
  );

  // The bounded cause the shell projects for a lifecycle refusal is read as its
  // own field; an unbounded or additive shape is still refused outright.
  const caused = transport(
    jsonResponse({ code: "game_unavailable", cause: "stardew_player_host_launch_runtime_unavailable" }, 409),
  );
  await assert.rejects(
    createComposedReferenceGameBrowserApi(caused.fetch).readState(),
    (error) =>
      error instanceof ComposedReferenceGameProblemError &&
      error.code === "game_unavailable" &&
      error.causeCode === "stardew_player_host_launch_runtime_unavailable",
  );
  for (const body of [
    { code: "game_unavailable", cause: "C:\\Games\\Stardew Valley" },
    { code: "game_unavailable", cause: "stardew_" + "a".repeat(200) },
    { code: "game_unavailable", cause: "not_a_coordinator_code" },
    { code: "game_unavailable", cause: "stardew_ok", detail: "raw producer text" },
    { code: "C:\\Games\\Stardew Valley" },
    { code: "" },
    { code: "a".repeat(200) },
  ]) {
    const recorder = transport(jsonResponse(body, 409));
    await assert.rejects(
      createComposedReferenceGameBrowserApi(recorder.fetch).readState(),
      (error) =>
        error instanceof ComposedReferenceGameProtocolError &&
        error.reason === "invalid_problem",
    );
  }
});


test("installation discovery is strict, uses opaque candidate IDs, and gates mutations on CSRF", async () => {
  const candidateId = "A".repeat(22);
  const discovery = { apiVersion: 1, candidates: [{ candidateId, source: "registry", label: "Game", hint: null, status: "candidate" }], diagnostics: [] };
  const recorder = transport(jsonResponse(discovery));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  assert.deepEqual(await api.readStardewInstallationDiscovery(), discovery);
  for (const valid of ["A".repeat(22), "A".repeat(43), "A".repeat(128)]) {
    const validRecorder = transport(jsonResponse({
      ...discovery,
      candidates: [{ ...discovery.candidates[0], candidateId: valid }],
    }));
    assert.deepEqual(
      await createComposedReferenceGameBrowserApi(validRecorder.fetch).readStardewInstallationDiscovery(),
      { ...discovery, candidates: [{ ...discovery.candidates[0], candidateId: valid }] },
    );
  }
  for (const bad of [
    "A".repeat(21),
    "A".repeat(129),
    "A".repeat(22) + "!",
    "A".repeat(22) + "/path",
    "A".repeat(21) + "B", // length % 4 === 2, non-zero trailing bits
    "A".repeat(42) + "B", // length % 4 === 3, non-zero trailing bits
  ]) {
    await assert.rejects(api.confirmStardewInstallation(bad), ComposedReferenceGameProtocolError);
  }
  assert.equal(recorder.calls.length, 1);
  for (const method of ["retryStardewInstallationDiscovery", "cancelStardewInstallationDiscovery", "openStardewInstallationPicker"]) {
    await assert.rejects(api[method](), (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "missing_composed_session");
  }
  assert.equal(recorder.calls.length, 1);
  for (const bad of [
    { ...discovery, extra: true },
    { ...discovery, diagnostics: Array.from({ length: 33 }, () => "x") },
    { ...discovery, candidates: [{ ...discovery.candidates[0], path: "C:/raw", executable: "game.exe" }] },
  ]) {
    const badTransport = transport(jsonResponse(bad));
    await assert.rejects(createComposedReferenceGameBrowserApi(badTransport.fetch).readStardewInstallationDiscovery(), ComposedReferenceGameProtocolError);
  }
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

test("Game launch client sends the exact projected generation and accepts only 204 empty", async () => {
  const key = "L".repeat(21) + "A";
  const recorder = transport(jsonResponse(root()), new Response(null, { status: 204 }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  await api.launchGame({ apiVersion: 1, idempotencyKey: key, expectedInstanceGeneration: 1 });
  assert.deepEqual(
    { input: recorder.calls[1].input, method: recorder.calls[1].init.method, headers: recorder.calls[1].init.headers, body: recorder.calls[1].init.body },
    {
      input: "/api/composed-reference-game/v1/game/launch",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
      body: JSON.stringify({ apiVersion: 1, idempotencyKey: key, expectedInstanceGeneration: 1 }),
    },
  );
  for (const invalid of [
    { apiVersion: 1, idempotencyKey: key, expectedInstanceGeneration: 0 },
    { apiVersion: 1, idempotencyKey: key, expectedInstanceGeneration: 1, path: "C:\\Games\\Stardew Valley" },
  ]) {
    await assert.rejects(
      api.launchGame(invalid),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_launch_request",
    );
  }
});

test("Game launch preserves frozen typed problem outcomes", async () => {
  for (const code of ["game_instance_not_found", "game_prerequisites_missing", "game_unavailable", "game_operation_in_progress", "idempotency_conflict"]) {
    const recorder = transport(jsonResponse(root()), jsonResponse({ code }, 409));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.launchGame({ apiVersion: 1, idempotencyKey: "L".repeat(21) + "A", expectedInstanceGeneration: 1 }),
      (error) => error instanceof ComposedReferenceGameProblemError && error.code === code,
    );
  }
});

test("a launch refused as not staged keeps its own reason instead of collapsing into a retryable failure", async () => {
  // The coordinator refuses a launch whose lifecycle is not staged with
  // `stardew_player_host_launch_not_staged`, and the composed shell maps exactly
  // that error to `game_prerequisites_missing` on the launch route alone. If the
  // client reclassified it (or marked it retryable), the UI could not distinguish
  // "activate first" from a transient launch failure and would show the generic
  // uncertain-launch message.
  const recorder = transport(
    jsonResponse(root()),
    jsonResponse({ code: "game_prerequisites_missing" }, 409),
  );
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  await assert.rejects(
    api.launchGame({ apiVersion: 1, idempotencyKey: "L".repeat(21) + "A", expectedInstanceGeneration: 1 }),
    (error) =>
      error instanceof ComposedReferenceGameProblemError &&
      error.code === "game_prerequisites_missing" &&
      error.status === 409 &&
      error.retryable === false,
  );
});

test("lifecycle activation posts the fieldless route with no body and accepts only 204 empty", async () => {
  const recorder = transport(jsonResponse(root()), new Response(null, { status: 204 }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  await api.activateLifecycle();
  assert.deepEqual(recorder.calls[1], {
    input: "/api/composed-reference-game/v1/lifecycle/activate",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
      credentials: "same-origin",
    },
  });
  // No body key at all: the shell answers 409 malformed_request to any body or
  // query string, because the admission alone names what is being activated.
  assert.equal("body" in recorder.calls[1].init, false);
});

test("lifecycle activation treats any non-204 answer as a refusal rather than success", async () => {
  for (const response of [
    new Response(null, { status: 200 }),
    new Response(JSON.stringify({ code: "state_unavailable" }), { status: 200, headers: { "content-type": "application/json" } }),
    // A 204 that nevertheless carries a token: `Response` cannot hold a body at
    // 204, so this is the hand-rolled shape a mis-behaving producer would send.
    { ok: true, status: 204, text: async () => "activated" },
  ]) {
    const recorder = transport(jsonResponse(root()), response);
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.activateLifecycle(),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "unexpected_status",
    );
  }
});

test("lifecycle activation preserves the shell's own refusal codes as typed problems", async () => {
  for (const [code, status] of [
    ["unauthorized", 401],
    ["not_found", 404],
    ["malformed_request", 409],
    ["idempotency_conflict", 409],
    ["game_unavailable", 409],
    ["state_unavailable", 409],
  ]) {
    const recorder = transport(jsonResponse(root()), jsonResponse({ code }, status));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.activateLifecycle(),
      (error) => error instanceof ComposedReferenceGameProblemError && error.code === code && error.status === status,
    );
  }
});

test("lifecycle activation needs the composed session before it will reach the route", async () => {
  const recorder = transport();
  await assert.rejects(
    createComposedReferenceGameBrowserApi(recorder.fetch).activateLifecycle(),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "missing_composed_session",
  );
  assert.equal(recorder.calls.length, 0);
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

test("Game resume client sends the exact generation-bound command and decodes strict results", async () => {
  const key = "R".repeat(21) + "A";
  const recorder = transport(jsonResponse(root()), jsonResponse({ apiVersion: 1, status: "accepted" }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  const resumed = await api.resumeGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 });
  assert.deepEqual(resumed, { apiVersion: 1, status: "accepted" });
  assert.deepEqual(
    { input: recorder.calls[1].input, method: recorder.calls[1].init.method, headers: recorder.calls[1].init.headers, body: recorder.calls[1].init.body },
    {
      input: "/api/composed-reference-game/v1/game/resume",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
      body: JSON.stringify({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 }),
    },
  );
  for (const invalid of [
    { apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 0 },
    { apiVersion: 1, idempotencyKey: `${key}x`, expectedAttachmentGeneration: 1 },
    { apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1, path: "C:\\Games\\Stardew Valley" },
  ]) {
    await assert.rejects(
      api.resumeGame(invalid),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_resume_request",
    );
  }
});

test("Game resume requires an established CSRF session before any transport", async () => {
  const recorder = transport();
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await assert.rejects(
    api.resumeGame({ apiVersion: 1, idempotencyKey: "R".repeat(21) + "A", expectedAttachmentGeneration: 1 }),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "missing_composed_session",
  );
  assert.deepEqual(recorder.calls, []);
});

test("Game resume decodes every strict status and rejects malformed or additive results", async () => {
  const key = "R".repeat(21) + "A";
  for (const status of ["accepted", "attached", "unavailable"]) {
    const recorder = transport(jsonResponse(root()), jsonResponse({ apiVersion: 1, status }));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    const resumed = await api.resumeGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 });
    assert.deepEqual(resumed, { apiVersion: 1, status });
  }
  for (const bad of [
    { apiVersion: 1, status: "accepted", generation: 3 },
    { apiVersion: 1, status: "resumed" },
    { apiVersion: 2, status: "accepted" },
    { apiVersion: 1, status: "attached", token: "leak" },
  ]) {
    const recorder = transport(jsonResponse(root()), jsonResponse(bad));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.resumeGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 }),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_resume_result",
    );
  }
});

test("Game resume preserves frozen typed problem outcomes and rejects non-200 transport", async () => {
  const key = "R".repeat(21) + "A";
  for (const code of ["game_attachment_conflict", "game_runtime_unavailable", "idempotency_conflict", "game_operation_in_progress", "game_unavailable", "state_unavailable"]) {
    const recorder = transport(jsonResponse(root()), jsonResponse({ code }, 409));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.resumeGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 }),
      (error) => error instanceof ComposedReferenceGameProblemError && error.code === code,
    );
  }
  for (const response of [
    new Response(null, { status: 204 }),
    new Response("not-json", { status: 200 }),
    new Response(JSON.stringify({ code: "state_unavailable", detail: "raw producer text" }), { status: 409 }),
    new Response(JSON.stringify({ code: "raw producer detail" }), { status: 409 }),
  ]) {
    const recorder = transport(jsonResponse(root()), response);
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.resumeGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 1 }),
      ComposedReferenceGameProtocolError,
    );
  }
});

test("Game reopen client sends the exact generation-bound command and decodes the strict reopened result", async () => {
  const key = "P".repeat(21) + "A";
  const recorder = transport(jsonResponse(root()), jsonResponse({ apiVersion: 1, status: "reopened" }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  const reopened = await api.reopenGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 });
  assert.deepEqual(reopened, { apiVersion: 1, status: "reopened" });
  assert.deepEqual(
    { input: recorder.calls[1].input, method: recorder.calls[1].init.method, headers: recorder.calls[1].init.headers, body: recorder.calls[1].init.body },
    {
      input: "/api/composed-reference-game/v1/game/reopen",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
      body: JSON.stringify({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 }),
    },
  );
  for (const invalid of [
    { apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 0 },
    { apiVersion: 1, idempotencyKey: `${key}x`, expectedAttachmentGeneration: 2 },
    { apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2, path: "C:\\Games\\Stardew Valley" },
  ]) {
    await assert.rejects(
      api.reopenGame(invalid),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_reopen_request",
    );
  }
});

test("Game reopen requires an established CSRF session before any transport", async () => {
  const recorder = transport();
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await assert.rejects(
    api.reopenGame({ apiVersion: 1, idempotencyKey: "P".repeat(21) + "A", expectedAttachmentGeneration: 2 }),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "missing_composed_session",
  );
  assert.deepEqual(recorder.calls, []);
});

test("Game reopen decodes only the frozen reopened result and rejects malformed or additive results", async () => {
  const key = "P".repeat(21) + "A";
  const recorder = transport(jsonResponse(root()), jsonResponse({ apiVersion: 1, status: "reopened" }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  const reopened = await api.reopenGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 });
  assert.deepEqual(reopened, { apiVersion: 1, status: "reopened" });
  for (const bad of [
    { apiVersion: 1, status: "reopened", generation: 3 },
    { apiVersion: 1, status: "active" },
    { apiVersion: 2, status: "reopened" },
    { apiVersion: 1, status: "reopened", token: "leak" },
  ]) {
    const recorder = transport(jsonResponse(root()), jsonResponse(bad));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.reopenGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 }),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_reopen_result",
    );
  }
});

test("Game reopen preserves frozen typed problem outcomes and rejects non-200 transport", async () => {
  const key = "P".repeat(21) + "A";
  // The Host already maps not_paused→game_operation_in_progress and
  // reopen_idempotency_conflict→idempotency_conflict on its side; the client
  // must preserve exactly those frozen wire codes as typed problems.
  for (const code of ["game_operation_in_progress", "idempotency_conflict", "state_unavailable"]) {
    const recorder = transport(jsonResponse(root()), jsonResponse({ code }, 409));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.reopenGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 }),
      (error) => error instanceof ComposedReferenceGameProblemError && error.code === code,
    );
  }
  for (const response of [
    new Response(null, { status: 204 }),
    new Response("not-json", { status: 200 }),
    new Response(JSON.stringify({ code: "state_unavailable", detail: "raw producer text" }), { status: 409 }),
    new Response(JSON.stringify({ code: "raw producer detail" }), { status: 409 }),
  ]) {
    const recorder = transport(jsonResponse(root()), response);
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.reopenGame({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 }),
      ComposedReferenceGameProtocolError,
    );
  }
});
test("Game create client sends the exact integration and continuity binding command and decodes strict results", async () => {
  const key = "C".repeat(21) + "A";
  const sessionId = "0".repeat(32);
  const recorder = transport(jsonResponse(root()), jsonResponse({ apiVersion: 1, status: "attached", gameSessionId: sessionId }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  const created = await api.createGameSession({
    apiVersion: 1,
    idempotencyKey: key,
    integrationId: "stardew",
    continuityIdentityId: null,
  });
  assert.deepEqual(created, { apiVersion: 1, status: "attached", gameSessionId: sessionId });
  assert.deepEqual(
    { input: recorder.calls[1].input, method: recorder.calls[1].init.method, headers: recorder.calls[1].init.headers, body: recorder.calls[1].init.body },
    {
      input: "/api/composed-reference-game/v1/game/create",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
      body: JSON.stringify({ apiVersion: 1, idempotencyKey: key, integrationId: "stardew", continuityIdentityId: null }),
    },
  );
  // A player-selected continuity binding is carried verbatim as an explicit
  // SAFE_ID; the client never reorders or augments the strict command.
  const boundKey = "B".repeat(21) + "A";
  const boundRecorder = transport(jsonResponse(root()), jsonResponse({ apiVersion: 1, status: "accepted", gameSessionId: sessionId }));
  const boundApi = createComposedReferenceGameBrowserApi(boundRecorder.fetch);
  await boundApi.bootstrap(HANDLE);
  await boundApi.createGameSession({
    apiVersion: 1,
    idempotencyKey: boundKey,
    integrationId: "stardew",
    continuityIdentityId: "continuity-identity-1",
  });
  assert.deepEqual(
    boundRecorder.calls[1].init.body,
    JSON.stringify({ apiVersion: 1, idempotencyKey: boundKey, integrationId: "stardew", continuityIdentityId: "continuity-identity-1" }),
  );
  for (const invalid of [
    { apiVersion: 1, idempotencyKey: key, integrationId: "", continuityIdentityId: null },
    { apiVersion: 1, idempotencyKey: key, integrationId: "bad/id", continuityIdentityId: null },
    { apiVersion: 1, idempotencyKey: `${key}x`, integrationId: "stardew", continuityIdentityId: null },
    { apiVersion: 1, idempotencyKey: key, integrationId: "stardew", continuityIdentityId: "has space" },
    { apiVersion: 1, idempotencyKey: key, integrationId: "stardew", continuityIdentityId: null, path: "C:\\Games\\Stardew Valley" },
  ]) {
    await assert.rejects(
      api.createGameSession(invalid),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_create_request",
    );
  }
});

test("Game create requires an established CSRF session before any transport", async () => {
  const recorder = transport();
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await assert.rejects(
    api.createGameSession({ apiVersion: 1, idempotencyKey: "C".repeat(21) + "A", integrationId: "stardew", continuityIdentityId: null }),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "missing_composed_session",
  );
  assert.deepEqual(recorder.calls, []);
});

test("Game create result binds status to the gameSessionId exactly: handle on accepted/attached, null on unavailable", async () => {
  const key = "C".repeat(21) + "A";
  const sessionId = "0".repeat(32);
  for (const status of ["accepted", "attached"]) {
    const recorder = transport(jsonResponse(root()), jsonResponse({ apiVersion: 1, status, gameSessionId: sessionId }));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    const created = await api.createGameSession({ apiVersion: 1, idempotencyKey: key, integrationId: "stardew", continuityIdentityId: null });
    assert.deepEqual(created, { apiVersion: 1, status, gameSessionId: sessionId });
  }
  const unavailableRecorder = transport(jsonResponse(root()), jsonResponse({ apiVersion: 1, status: "unavailable", gameSessionId: null }));
  const unavailableApi = createComposedReferenceGameBrowserApi(unavailableRecorder.fetch);
  await unavailableApi.bootstrap(HANDLE);
  const unavailable = await unavailableApi.createGameSession({ apiVersion: 1, idempotencyKey: key, integrationId: "stardew", continuityIdentityId: null });
  assert.deepEqual(unavailable, { apiVersion: 1, status: "unavailable", gameSessionId: null });
  for (const bad of [
    { apiVersion: 1, status: "accepted", gameSessionId: null },
    { apiVersion: 1, status: "attached" },
    { apiVersion: 1, status: "unavailable", gameSessionId: sessionId },
    { apiVersion: 1, status: "unavailable", gameSessionId: null, token: "leak" },
    { apiVersion: 1, status: "created", gameSessionId: sessionId },
    { apiVersion: 2, status: "attached", gameSessionId: sessionId },
  ]) {
    const recorder = transport(jsonResponse(root()), jsonResponse(bad));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.createGameSession({ apiVersion: 1, idempotencyKey: key, integrationId: "stardew", continuityIdentityId: null }),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_create_result",
    );
  }
});

test("Game create preserves frozen typed problem outcomes and rejects non-200 transport", async () => {
  const key = "C".repeat(21) + "A";
  for (const code of ["idempotency_conflict", "game_operation_in_progress", "game_runtime_unavailable", "game_unavailable", "game_storage_unavailable", "state_unavailable"]) {
    const recorder = transport(jsonResponse(root()), jsonResponse({ code }, 409));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.createGameSession({ apiVersion: 1, idempotencyKey: key, integrationId: "stardew", continuityIdentityId: null }),
      (error) => error instanceof ComposedReferenceGameProblemError && error.code === code,
    );
  }
  for (const response of [
    new Response(null, { status: 204 }),
    new Response("not-json", { status: 200 }),
    new Response(JSON.stringify({ code: "state_unavailable", detail: "raw producer text" }), { status: 409 }),
    new Response(JSON.stringify({ code: "raw producer detail" }), { status: 409 }),
  ]) {
    const recorder = transport(jsonResponse(root()), response);
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.createGameSession({ apiVersion: 1, idempotencyKey: key, integrationId: "stardew", continuityIdentityId: null }),
      ComposedReferenceGameProtocolError,
    );
  }
});

test("Game resume cancel client sends the exact generation-bound cancellation command and decodes the strict cancelled result", async () => {
  const key = "X".repeat(21) + "A";
  const recorder = transport(jsonResponse(root()), jsonResponse({ apiVersion: 1, status: "cancelled" }));
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await api.bootstrap(HANDLE);
  const cancelled = await api.cancelResume({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 });
  assert.deepEqual(cancelled, { apiVersion: 1, status: "cancelled" });
  assert.deepEqual(
    { input: recorder.calls[1].input, method: recorder.calls[1].init.method, headers: recorder.calls[1].init.headers, body: recorder.calls[1].init.body },
    {
      input: "/api/composed-reference-game/v1/game/resume/cancel",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": HANDLE },
      body: JSON.stringify({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 }),
    },
  );
  for (const invalid of [
    { apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 0 },
    { apiVersion: 1, idempotencyKey: `${key}x`, expectedAttachmentGeneration: 2 },
    { apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2, path: "C:\\Games\\Stardew Valley" },
  ]) {
    await assert.rejects(
      api.cancelResume(invalid),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_resume_cancel_request",
    );
  }
});

test("Game resume cancel requires an established CSRF session before any transport", async () => {
  const recorder = transport();
  const api = createComposedReferenceGameBrowserApi(recorder.fetch);
  await assert.rejects(
    api.cancelResume({ apiVersion: 1, idempotencyKey: "X".repeat(21) + "A", expectedAttachmentGeneration: 2 }),
    (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "missing_composed_session",
  );
  assert.deepEqual(recorder.calls, []);
});

test("Game resume cancel decodes only the frozen cancelled result and rejects malformed or additive results", async () => {
  const key = "X".repeat(21) + "A";
  for (const bad of [
    { apiVersion: 1, status: "cancelled", generation: 3 },
    { apiVersion: 1, status: "active" },
    { apiVersion: 2, status: "cancelled" },
    { apiVersion: 1, status: "cancelled", token: "leak" },
  ]) {
    const recorder = transport(jsonResponse(root()), jsonResponse(bad));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.cancelResume({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 }),
      (error) => error instanceof ComposedReferenceGameProtocolError && error.reason === "invalid_game_resume_cancel_result",
    );
  }
});

test("Game resume cancel preserves frozen typed problem outcomes and rejects non-200 transport", async () => {
  const key = "X".repeat(21) + "A";
  for (const code of ["idempotency_conflict", "game_unavailable", "game_attachment_conflict", "state_unavailable"]) {
    const recorder = transport(jsonResponse(root()), jsonResponse({ code }, 409));
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.cancelResume({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 }),
      (error) => error instanceof ComposedReferenceGameProblemError && error.code === code,
    );
  }
  for (const response of [
    new Response(null, { status: 204 }),
    new Response("not-json", { status: 200 }),
    new Response(JSON.stringify({ code: "state_unavailable", detail: "raw producer text" }), { status: 409 }),
    new Response(JSON.stringify({ code: "raw producer detail" }), { status: 409 }),
  ]) {
    const recorder = transport(jsonResponse(root()), response);
    const api = createComposedReferenceGameBrowserApi(recorder.fetch);
    await api.bootstrap(HANDLE);
    await assert.rejects(
      api.cancelResume({ apiVersion: 1, idempotencyKey: key, expectedAttachmentGeneration: 2 }),
      ComposedReferenceGameProtocolError,
    );
  }
});

// ─── Problem presentation: one category per real failure class ───────────────

/** Reads `/state` through the real client and returns the refusal it raised. */
async function refusal(body, status) {
  const api = createComposedReferenceGameBrowserApi(transport(jsonResponse(body, status)).fetch);
  return api.readState().then(
    () => { throw new Error("expected the read to be refused"); },
    (error) => error,
  );
}

test("a gone session is presented as a gone session, never as a reconciliation conflict", async () => {
  // The regression this catches: every non-retryable refusal was rendered as
  // "the chat state could not be safely reconciled", so a plain 401 sent the
  // reader after a consistency fault that did not exist.
  for (const code of ["unauthorized", "csrf_failed"]) {
    for (const locale of ["en", "zh-CN"]) {
      const labels = messages(locale);
      const view = composedProblemView(await refusal({ code }, 401), labels);
      assert.equal(view.title, labels.problemSessionExpiredTitle);
      assert.equal(view.detail, labels.problemSessionExpiredDetail);
      assert.equal(view.detail.includes(labels.problemReconciliationFailedDetail), false);
    }
  }
});

test("a real reconciliation conflict is the only failure presented as reconciliation", async () => {
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    const view = composedProblemView(await refusal({ code: "state_reconciliation_required" }, 409), labels);
    assert.equal(view.title, labels.problemReconciliationFailedTitle);
    assert.equal(view.detail, labels.problemReconciliationFailedDetail);
  }
});

test("a route this build does not serve is presented as an absent route", async () => {
  for (const code of ["not_found", "unsupported_api_version", "profile_operation_unavailable"]) {
    for (const locale of ["en", "zh-CN"]) {
      const labels = messages(locale);
      const view = composedProblemView(await refusal({ code }, 404), labels);
      assert.equal(view.title, labels.problemRouteUnavailableTitle);
      assert.equal(view.detail, labels.problemRouteUnavailableDetail);
    }
  }
});

test("a retryable unavailability keeps its own presentation", async () => {
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    const view = composedProblemView(await refusal({ code: "state_unavailable" }, 409), labels);
    assert.equal(view.title, labels.problemTemporarilyUnavailableTitle);
    assert.equal(view.detail, labels.problemTemporarilyUnavailableDetail);
    const upstream = composedProblemView(await refusal({ code: "game_unavailable" }, 503), labels);
    assert.equal(upstream.detail, labels.problemTemporarilyUnavailableDetail);
  }
});

test("anything the client cannot classify shows the code it actually received", async () => {
  const labels = messages("en");
  // An unknown code is the case that turns tonight's confusion into a one-minute
  // diagnosis: it must reach the text, not be re-worded as reconciliation.
  const unknown = composedProblemView(await refusal({ code: "invented_failure_code" }, 409), labels);
  assert.equal(unknown.title, labels.problemInternalErrorTitle);
  assert.equal(
    unknown.detail,
    labels.problemInternalErrorDetail.replace("{{code}}", "invented_failure_code"),
  );

  // A code with a named bounded cause shows both.
  const caused = composedProblemView(
    await refusal({ code: "game_unavailable", cause: "stardew_player_host_launch_failed" }, 409),
    labels,
  );
  assert.equal(caused.title, labels.problemInternalErrorTitle);
  assert.equal(
    caused.detail,
    labels.problemInternalErrorCauseDetail
      .replace("{{code}}", "game_unavailable")
      .replace("{{cause}}", "stardew_player_host_launch_failed"),
  );

  // A malformed composed root is the client's own protocol failure: it names its
  // own closed reason instead of being re-worded as something it is not. This is
  // the case the mounted composed spec asserts against.
  const malformedRoot = composedProblemView(
    new ComposedReferenceGameProtocolError("invalid_composed_root"),
    labels,
  );
  assert.equal(malformedRoot.title, labels.problemInternalErrorTitle);
  assert.equal(
    malformedRoot.detail,
    labels.problemInternalErrorDetail.replace("{{code}}", "invalid_composed_root"),
  );

  // A transport-level failure has no server code at all; the absence is stated
  // rather than replaced by an invented one.
  const offline = composedProblemView(new Error("socket closed"), labels);
  assert.equal(offline.title, labels.problemInternalErrorTitle);
  assert.equal(
    offline.detail,
    labels.problemInternalErrorDetail.replace("{{code}}", labels.problemInternalErrorNoCode),
  );
});

// ─── Cross-boundary: a real Host body through the real client mapping ────────

const BOOTSTRAP_TOKEN = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";

/** The real composed Host handler, with only its readers and launch seam stubbed. */
function realComposedSurface(gameLaunch) {
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
    operationIds: ["game.state.read", "game.launch"],
    navigationItemIds: ["game"],
  });
  return createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile, gameProfile }),
    bootstrapToken: BOOTSTRAP_TOKEN,
    readChat: async (context) => {
      const base = TavernBrowserFixtureV1.snapshot();
      return {
        ...base,
        build: { ...base.build, profileId: tavernProfile.profileId },
        csrfToken: context.csrfToken,
        browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
      };
    },
    readGame: async (context) => {
      const base = GameBrowserFixtureV1.state();
      return {
        ...base,
        build: { ...base.build, profileId: gameProfile.profileId },
        csrfToken: context.csrfToken,
        browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
      };
    },
    gameLaunch,
  });
}

async function startSurface(handler) {
  const server = createServer((request, response) =>
    handler.handle(request, response, `http://127.0.0.1:${server.address().port}`),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await handler.close();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test("a real composed refusal reaches the player as its own category, over real HTTP", async () => {
  // The failure this test exists for: both sides passed their own tests while
  // disagreeing with each other. Nothing below restates one side - the real Host
  // handler is driven, and its real response body goes through the client's own
  // strict reader and its own presentation.
  //
  // A renewed disagreement fails HERE: re-collapsing the server to a bare
  // `game_unavailable` breaks the code assertions, dropping the bounded cause
  // breaks the cause assertion, and re-wording any non-retryable refusal as
  // reconciliation - the exact regression this lane exists for - breaks the
  // session and title assertions.
  const wrapped = (cause) => {
    const error = new Error("stardew_player_host_launch_failed");
    error.cause = cause;
    return error;
  };
  let thrown = wrapped(new Error("stardew_player_host_launch_runtime_unavailable"));
  const handler = realComposedSurface(async () => { throw thrown; });
  const surface = await startSurface(handler);
  try {
    const en = messages("en");

    // Real 401: no session at all. The body the player's page actually receives is
    // the input to the client's own mapping.
    const unauthenticated = await fetch(`${surface.origin}/api/composed-reference-game/v1/state`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    assert.equal(unauthenticated.status, 401);
    const unauthenticatedBody = await unauthenticated.json();
    assert.deepEqual(unauthenticatedBody, { code: "unauthorized" });
    const unauthenticatedView = composedProblemView(await refusal(unauthenticatedBody, 401), en);
    assert.equal(unauthenticatedView.title, en.problemSessionExpiredTitle);
    assert.equal(unauthenticatedView.detail, en.problemSessionExpiredDetail);

    // Real launch refusals: the client's own api over real HTTP against the real
    // handler, carrying the session cookie the real bootstrap issued.
    let cookie;
    const api = createComposedReferenceGameBrowserApi(async (input, init) => {
      const headers = { ...(init?.headers ?? {}), origin: surface.origin };
      if (cookie !== undefined) headers.cookie = cookie;
      const response = await fetch(`${surface.origin}${input}`, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie !== null) cookie = setCookie.split(";", 1)[0];
      return response;
    });
    // The real bootstrap body must satisfy the client's own strict root validator.
    await api.bootstrap(BOOTSTRAP_TOKEN);
    const launchRefusalOf = (key) => api
      .launchGame({ apiVersion: 1, idempotencyKey: key, expectedInstanceGeneration: 1 })
      .then(
        () => { throw new Error("expected the real launch to be refused"); },
        (error) => error,
      );

    // A known cause gets its own composed code: the runtime collaborator is absent.
    const absentRuntime = await launchRefusalOf("L".repeat(21) + "A");
    assert.ok(absentRuntime instanceof ComposedReferenceGameProblemError, String(absentRuntime));
    assert.equal(absentRuntime.status, 409);
    assert.equal(absentRuntime.code, "game_runtime_unavailable");
    assert.equal(absentRuntime.causeCode, null);

    // Tonight's actual shape: a launch that failed after admission, whose cause is
    // not a known code. The code is still generic, so the bounded cause is what
    // makes it diagnosable - and it must reach the player's text.
    thrown = wrapped(new Error("stardew_private_launch_admission_failed"));
    const wrappedFailure = await launchRefusalOf("M".repeat(21) + "A");
    assert.ok(wrappedFailure instanceof ComposedReferenceGameProblemError, String(wrappedFailure));
    assert.equal(wrappedFailure.code, "game_unavailable");
    assert.equal(wrappedFailure.causeCode, "stardew_private_launch_admission_failed");

    const launchView = composedProblemView(wrappedFailure, en);
    assert.equal(launchView.title, en.problemInternalErrorTitle);
    assert.ok(launchView.detail.includes("game_unavailable"), launchView.detail);
    assert.ok(launchView.detail.includes("stardew_private_launch_admission_failed"), launchView.detail);
    assert.equal(launchView.detail.includes(en.problemReconciliationFailedDetail), false);
  } finally {
    await surface.close();
  }
});
