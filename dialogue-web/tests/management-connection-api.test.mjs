import assert from "node:assert/strict";
import test from "node:test";
import {
  createManagementPipelineApi,
  TavernProtocolError,
  validateConnectionProbe,
  validateConnectionState,
} from "../src/management-pipeline-api.ts";

/**
 * Browser side of the connection management contract (design/28 §1, §5.1, §5.3).
 *
 * The browser may only select a catalog entry, must send exactly the fields that
 * entry declares, must treat the player's own base URL as the one readable
 * endpoint fact, and must reject any projection that carries a credential or a
 * shape the Host contract does not define.
 */

const HANDLE = "A".repeat(43);

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function connectionState(overrides = {}) {
  const row = {
    connectionId: HANDLE,
    label: "OpenAI-compatible endpoint · qwen2.5-coder:7b",
    providerId: "gamebuddy-openai-compatible",
    providerLabel: "OpenAI-compatible endpoint",
    configured: true,
    readiness: "configured",
    active: false,
    modelId: "qwen2.5-coder:7b",
    modelLabel: "qwen2.5-coder:7b",
    thinkingLevel: "high",
    baseUrl: "http://127.0.0.1:11434/v1",
    failure: null,
    lastCheckedAtMs: null,
    ...(overrides.row ?? {}),
  };
  return {
    apiVersion: 1,
    revision: 3,
    active: overrides.active ?? null,
    connections: overrides.connections ?? [row],
    providers:
      overrides.providers ??
      [
        {
          providerId: "cpa-oai",
          label: "GameBuddy Agent (CPA)",
          setupFields: [],
          allowedPlayerModels: [
            {
              modelId: "deepseek-v4-flash",
              modelLabel: "DeepSeek V4 Flash",
              allowedThinkingLevels: ["low", "high", "max"],
              defaultThinkingLevel: "high",
            },
          ],
          escapeHatch: false,
          environmentManaged: true,
        },
        {
          providerId: "gamebuddy-openai-compatible",
          label: "OpenAI-compatible endpoint",
          setupFields: ["baseUrl", "apiKey", "modelId"],
          allowedPlayerModels: [],
          escapeHatch: true,
          environmentManaged: false,
        },
      ],
  };
}

test("the connection projection is strictly validated and never invents a ready state", () => {
  const state = connectionState();
  assert.deepEqual(validateConnectionState(state), state);

  // An unknown field, a missing provider payload field and an inconsistent
  // readiness/failure pairing all fail closed.
  assert.throws(
    () => validateConnectionState({ ...state, connections: [{ ...state.connections[0], credential: "sk-x" }] }),
    TavernProtocolError,
  );
  assert.throws(
    () => validateConnectionState({ ...state, providers: [{ ...state.providers[0], headers: {} }] }),
    TavernProtocolError,
  );
  assert.throws(
    () =>
      validateConnectionState({
        ...state,
        connections: [{ ...state.connections[0], readiness: "ready", failure: "unauthorized" }],
      }),
    TavernProtocolError,
  );
  assert.throws(
    () => validateConnectionState({ ...state, connections: [{ ...state.connections[0], readiness: "failed" }] }),
    TavernProtocolError,
  );
  // The active flag must agree with the active selection.
  assert.throws(
    () => validateConnectionState({ ...state, connections: [{ ...state.connections[0], active: true }] }),
    TavernProtocolError,
  );
  // A setup field outside the Host allowlist cannot be rendered or sent.
  assert.throws(
    () => validateConnectionState({ ...state, providers: [{ ...state.providers[0], setupFields: ["script"] }] }),
    TavernProtocolError,
  );
  // A thinking level the model does not offer cannot become a selection.
  assert.throws(
    () =>
      validateConnectionState({
        ...state,
        providers: [
          {
            ...state.providers[0],
            allowedPlayerModels: [
              {
                modelId: "deepseek-v4-flash",
                modelLabel: "DeepSeek V4 Flash",
                allowedThinkingLevels: ["high"],
                defaultThinkingLevel: "low",
              },
            ],
          },
        ],
      }),
    TavernProtocolError,
  );
});

test("the connection client sends only catalog-declared fields, in exact wire shapes", async () => {
  const calls = [];
  const api = createManagementPipelineApi(async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith("/test")) {
      return response({
        apiVersion: 1,
        connectionId: HANDLE,
        outcome: "failed",
        failure: "unauthorized",
        state: connectionState(),
      });
    }
    return response(connectionState());
  });

  await api.readConnection();
  assert.deepEqual(calls[0], {
    path: "/api/tavern/v1/settings/connection",
    init: { method: "GET", credentials: "same-origin" },
  });

  // The escape hatch sends the player's endpoint, credential and model id.
  await api.createConnection(
    {
      apiVersion: 1,
      providerId: "gamebuddy-openai-compatible",
      apiKey: "sk-synthetic",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen2.5-coder:7b",
    },
    HANDLE,
  );
  assert.deepEqual(calls[1], {
    path: "/api/tavern/v1/settings/connections",
    init: {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-csrf-token": HANDLE },
      body: JSON.stringify({
        apiVersion: 1,
        providerId: "gamebuddy-openai-compatible",
        apiKey: "sk-synthetic",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen2.5-coder:7b",
      }),
    },
  });

  // A catalog provider sends no endpoint and no model id.
  await api.createConnection({ apiVersion: 1, providerId: "deepseek", apiKey: "sk-synthetic" }, HANDLE);
  assert.equal(
    calls[2].init.body,
    JSON.stringify({ apiVersion: 1, providerId: "deepseek", apiKey: "sk-synthetic" }),
  );

  const probe = await api.testConnection(HANDLE, 3, HANDLE);
  assert.equal(probe.failure, "unauthorized");
  assert.deepEqual(calls[3], {
    path: `/api/tavern/v1/settings/connections/${HANDLE}/test`,
    init: {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-csrf-token": HANDLE },
      body: JSON.stringify({ apiVersion: 1, expectedRevision: 3 }),
    },
  });

  await api.selectConnectionModel(HANDLE, { expectedRevision: 4, modelId: "deepseek-v4-pro", thinkingLevel: "max" }, HANDLE);
  assert.equal(calls[4].path, `/api/tavern/v1/settings/connections/${HANDLE}/model`);
  assert.equal(
    calls[4].init.body,
    JSON.stringify({ apiVersion: 1, expectedRevision: 4, modelId: "deepseek-v4-pro", thinkingLevel: "max" }),
  );

  await api.activateConnection(HANDLE, 5, HANDLE);
  assert.equal(calls[5].path, `/api/tavern/v1/settings/connections/${HANDLE}/activate`);
  assert.equal(calls[5].init.body, JSON.stringify({ apiVersion: 1, expectedRevision: 5 }));

  await api.removeConnection(HANDLE, 6, HANDLE);
  assert.equal(calls[6].path, `/api/tavern/v1/settings/connections/${HANDLE}`);
  assert.equal(calls[6].init.method, "DELETE");
  assert.equal(calls[6].init.body, JSON.stringify({ apiVersion: 1, expectedRevision: 6 }));

  // Local guards run before any request: a malformed handle, revision or
  // thinking level never reaches the wire.
  await assert.rejects(api.testConnection("not-a-handle", 1, HANDLE), TavernProtocolError);
  await assert.rejects(api.testConnection(HANDLE, -1, HANDLE), TavernProtocolError);
  await assert.rejects(api.selectConnectionModel(HANDLE, { expectedRevision: 1, modelId: "", thinkingLevel: "high" }, HANDLE), TavernProtocolError);
  await assert.rejects(
    api.selectConnectionModel(HANDLE, { expectedRevision: 1, modelId: "m", thinkingLevel: "extreme" }, HANDLE),
    TavernProtocolError,
  );
  assert.equal(calls.length, 7);
});

test("a host problem is surfaced as its closed code, never as provider text", async () => {
  const api = createManagementPipelineApi(async () =>
    response(
      {
        type: "urn:gamebuddy:tavern:dialogue_busy",
        title: "dialogue busy",
        status: 409,
        code: "dialogue_busy",
        requestId: HANDLE,
        retryable: false,
      },
      409,
    ),
  );
  await assert.rejects(api.activateConnection(HANDLE, 1, HANDLE), (error) => {
    assert.equal(error.code, "dialogue_busy");
    assert.equal(error.status, 409);
    return true;
  });
});

test("the probe read-back is a closed outcome with its resulting projection", () => {
  const probe = {
    apiVersion: 1,
    connectionId: HANDLE,
    outcome: "failed",
    failure: "timeout",
    state: connectionState(),
  };
  assert.deepEqual(validateConnectionProbe(probe), probe);
  // `ready` with a failure category, and `failed` without one, are both invalid.
  assert.throws(() => validateConnectionProbe({ ...probe, outcome: "ready" }), TavernProtocolError);
  assert.throws(() => validateConnectionProbe({ ...probe, failure: null }), TavernProtocolError);
  assert.throws(() => validateConnectionProbe({ ...probe, failure: "provider_said_bad_key" }), TavernProtocolError);
  assert.throws(() => validateConnectionProbe({ ...probe, rawProviderBody: "..." }), TavernProtocolError);
});
