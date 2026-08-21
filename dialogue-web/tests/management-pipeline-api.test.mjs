import assert from "node:assert/strict";
import test from "node:test";
import {
  TavernProtocolError,
  createManagementPipelineApi,
  validateMemoryMutationCommand,
  validateMemoryRead,
  validateSetWorldInfoBindingCommand,
  validateSnapshot,
  validateWorldInfoState,
} from "../src/management-pipeline-api.ts";
import { createManagementPipelineSession } from "../src/management-pipeline-session.ts";

const HANDLE = "A".repeat(43);
const BAD_HANDLE = "B".repeat(43);

function worldInfo(overrides = {}) {
  return {
    state: "selected",
    revision: HANDLE,
    items: [{ handle: HANDLE, title: "Pelican Town", summary: "A safe summary", selected: true }],
    ...overrides,
  };
}

function snapshot(worldInfoValue = worldInfo()) {
  return {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern-management.chat-list-title" },
    csrfToken: HANDLE,
    browserSession: { expiresAtMs: 0 },
    operations: [
      {
        operationId: "world-info.bind",
        labelKey: "tavern.operation.world-info.bind",
        availability: "available",
        routeId: "world-info.bind",
      },
    ],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: HANDLE, generation: 1, stateRevision: HANDLE },
    chat: {
      companion: { name: "Mira" },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: worldInfoValue,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  };
}

function response(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function memoryRead(overrides = {}) {
  return {
    apiVersion: 1,
    projectionRevision: HANDLE,
    memories: [
      {
        handle: `${"C".repeat(42)}A`,
        title: "Semantic memory",
        content: "The farmer likes blueberries.",
        category: "semantic",
        status: "active",
        pinned: false,
      },
    ],
    ...overrides,
  };
}

test("management Memory validators and client reject malformed, noncanonical, and non-strict mutations before fetch", async () => {
  let calls = 0;
  const api = createManagementPipelineApi(async () => {
    calls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  const valid = {
    apiVersion: 1,
    operation: "create",
    expectedProjectionRevision: HANDLE,
    content: "A durable memory",
  };
  await assert.rejects(
    api.mutateMemory({ ...valid, expectedProjectionRevision: "opaque-but-not-canonical=" }, HANDLE),
    TavernProtocolError,
  );
  await assert.rejects(api.mutateMemory({ ...valid, handle: HANDLE }, HANDLE), TavernProtocolError);
  await assert.rejects(api.mutateMemory({ ...valid, content: "cafe\u0301" }, HANDLE), TavernProtocolError);
  await assert.rejects(api.mutateMemory(valid, "not-a-canonical-csrf-token="), TavernProtocolError);
  assert.equal(calls, 0);
});

test("management Memory validators and client use exact read and CSRF-bound mutation routes", async () => {
  const read = memoryRead();
  assert.deepEqual(validateMemoryRead(read), read);
  const command = { apiVersion: 1, operation: "update", expectedProjectionRevision: HANDLE, handle: `${"C".repeat(42)}A`, content: "Updated memory." };
  assert.deepEqual(validateMemoryMutationCommand(command), command);
  assert.throws(() => validateMemoryMutationCommand({ ...command, extra: true }), TavernProtocolError);
  assert.throws(() => validateMemoryMutationCommand({ ...command, content: "" }), TavernProtocolError);
  assert.throws(() => validateMemoryMutationCommand({ ...command, content: "x".repeat(4097) }), TavernProtocolError);
  assert.throws(() => validateMemoryMutationCommand({ ...command, content: "e\u0301" }), TavernProtocolError);

  const calls = [];
  const api = createManagementPipelineApi(async (path, init) => {
    calls.push({ path, init });
    return response(read);
  });
  assert.deepEqual(await api.readMemory(), read);
  assert.deepEqual(await api.mutateMemory(command, HANDLE), read);
  assert.deepEqual(calls[0], { path: "/api/tavern/v1/memory", init: { method: "GET", credentials: "same-origin" } });
  assert.equal(calls[1].path, "/api/tavern/v1/memory");
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(calls[1].init.headers, { "Content-Type": "application/json", "x-csrf-token": HANDLE });
  assert.equal(calls[1].init.body, JSON.stringify(command));
});

test("management snapshot rejects Memory mutation capability without a successful read-backed projection", () => {
  assert.throws(
    () => validateSnapshot({ ...snapshot(), memory: { readAvailable: false, mutationAvailable: true, projectionRevision: null } }),
    TavernProtocolError,
  );
  assert.throws(
    () => validateSnapshot({ ...snapshot(), memory: { readAvailable: false, mutationAvailable: false, projectionRevision: HANDLE } }),
    TavernProtocolError,
  );
});

test("management World Info snapshot mirror accepts the published opaque state and session", () => {
  const validated = validateSnapshot(snapshot());
  assert.equal(validated.chat.worldInfo.revision, HANDLE);
  assert.equal(validated.chat.worldInfo.items[0].selected, true);
  assert.equal(createManagementPipelineSession(validated).snapshot, validated);
});

test("management World Info validators reject incomplete, noncanonical, and non-strict values", () => {
  assert.throws(() => validateWorldInfoState({ state: "none", items: [] }), TavernProtocolError);
  assert.throws(() => validateWorldInfoState(worldInfo({ revision: BAD_HANDLE })), TavernProtocolError);
  assert.throws(() => validateWorldInfoState(worldInfo({ items: [{ ...worldInfo().items[0], selected: undefined }] })), TavernProtocolError);
  assert.throws(
    () => validateSetWorldInfoBindingCommand({ apiVersion: 1, selectionGeneration: 1, expectedRevision: HANDLE, sourceHandle: null, extra: true }),
    TavernProtocolError,
  );
});

test("management World Info client uses the exact read and CSRF-bound bind routes", async () => {
  const calls = [];
  const api = createManagementPipelineApi(async (path, init) => {
    calls.push({ path, init });
    return response(worldInfo());
  });
  assert.deepEqual(await api.readWorldInfo(), worldInfo());
  assert.deepEqual(
    await api.setWorldInfoBinding({ apiVersion: 1, selectionGeneration: 1, expectedRevision: HANDLE, sourceHandle: null }, HANDLE),
    worldInfo(),
  );
  assert.deepEqual(calls[0], { path: "/api/tavern/v1/world-info", init: { method: "GET", credentials: "same-origin" } });
  assert.equal(calls[1].path, "/api/tavern/v1/world-info");
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(calls[1].init.headers, { "Content-Type": "application/json", "x-csrf-token": HANDLE });
  assert.equal(calls[1].init.body, JSON.stringify({ apiVersion: 1, selectionGeneration: 1, expectedRevision: HANDLE, sourceHandle: null }));
});
