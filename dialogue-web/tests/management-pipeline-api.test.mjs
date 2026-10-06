import assert from "node:assert/strict";
import test from "node:test";
import {
  TavernProtocolError,
  createManagementPipelineApi,
  validateMemoryMutationCommand,
  validateMemoryRead,
  validateModelProfileUpdateCommand,
  validateModelProfiles,
  validateSetWorldInfoBindingCommand,
  validateSnapshot,
  validateStCardImportHistory,
  validateWorldInfoState,
  validateVoiceDevices,
  validateVoicePreference,
} from "../src/management-pipeline-api.ts";
import { createManagementPipelineSession } from "../src/management-pipeline-session.ts";

const HANDLE = "A".repeat(43);
const BAD_HANDLE = "B".repeat(43);

function worldInfo(overrides = {}) {
  return {
    state: "selected",
    revision: HANDLE,
    items: [{ handle: HANDLE, title: "Pelican Town", summary: "A safe summary", selected: true, pending: false }],
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

test("management mutation observer receives only successful content-free operation outcomes", async () => {
  const observations = [];
  const api = createManagementPipelineApi(async (path) => {
    if (path.includes("/chat/title")) return response({ apiVersion: 1, title: null, managementRevision: 2 });
    throw new Error("unexpected_route");
  }, (observation) => observations.push(observation));
  await api.renameChatTitle({ apiVersion: 1, selectionGeneration: 1, chatHandle: HANDLE, expectedManagementRevision: 1, title: "Renamed" }, HANDLE);
  assert.deepEqual(observations, [{ operationId: "chat.rename", outcome: "passed", projectionRevision: "2" }]);
});

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

test("management Voice preference validators and client use exact session and CSRF-bound routes", async () => {
  const preference = { revision: 0, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null };
  const accepted = { revision: 1, disclosureVersion: "mimo-cloud-tts-v1", consent: "accepted", decidedAtMs: 10, outputDevice: null };
  assert.deepEqual(validateVoicePreference(preference), preference);
  assert.throws(() => validateVoicePreference({ ...preference, extra: true }), TavernProtocolError);
  const command = { expectedRevision: 0, action: "accept", disclosureVersion: "mimo-cloud-tts-v1" };
  const calls = [];
  const api = createManagementPipelineApi(async (path, init) => {
    calls.push({ path, init });
    return response(path.endsWith("voice-preference") && init.method === "PUT" ? accepted : preference);
  });
  assert.deepEqual(await api.readVoicePreference(), preference);
  assert.deepEqual(await api.updateVoicePreference(command, HANDLE), accepted);
  assert.deepEqual(calls[0], { path: "/api/tavern/v1/settings/voice-preference", init: { method: "GET", credentials: "same-origin" } });
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(calls[1].init.headers, { "Content-Type": "application/json", "x-csrf-token": HANDLE });
  assert.equal(calls[1].init.body, JSON.stringify(command));
  await assert.rejects(api.updateVoicePreference({ ...command, extra: true }, HANDLE), TavernProtocolError);
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

test("management Voice device enumeration and output-device selection use exact routes", async () => {
  // The panel can only offer real endpoints if this read is wired, and the
  // selection must travel as the existing setOutputDevice action with the
  // current preference revision (a stale revision is a durable conflict).
  const devices = {
    devices: [
      { id: "waveout:0", name: "Headphones" },
      { id: "waveout:1", name: "Speakers" },
    ],
    defaultSelectable: true,
  };
  assert.deepEqual(validateVoiceDevices(devices), devices);
  // A malformed endpoint id must fail closed rather than reach the gateway.
  assert.throws(() => validateVoiceDevices({ ...devices, devices: [{ id: "speakers", name: "X" }] }), TavernProtocolError);
  assert.throws(() => validateVoiceDevices({ ...devices, defaultSelectable: false }), TavernProtocolError);
  assert.throws(() => validateVoiceDevices({ ...devices, devices: Array.from({ length: 33 }, () => ({ id: "waveout:0", name: "x" })) }), TavernProtocolError);

  const selected = { revision: 4, disclosureVersion: "mimo-cloud-tts-v1", consent: "accepted", decidedAtMs: 10, outputDevice: "waveout:1" };
  const calls = [];
  const api = createManagementPipelineApi(async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith("voice-devices")) return response(devices);
    return response(path.endsWith("voice-preference") && init.method === "PUT" ? selected : { ...selected, outputDevice: null });
  });
  assert.deepEqual(await api.readVoiceDevices(), devices);
  const command = { expectedRevision: 0, action: "setOutputDevice", outputDevice: "waveout:1" };
  assert.deepEqual(await api.updateVoicePreference(command, HANDLE), selected);
  assert.deepEqual(calls[0], { path: "/api/tavern/v1/settings/voice-devices", init: { method: "GET", credentials: "same-origin" } });
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(calls[1].init.headers, { "Content-Type": "application/json", "x-csrf-token": HANDLE });
  assert.equal(calls[1].init.body, JSON.stringify(command));

  // Releasing a pin is the null form of the same action, not a separate route.
  const release = { expectedRevision: 4, action: "setOutputDevice", outputDevice: null };
  assert.deepEqual(await api.updateVoicePreference(release, HANDLE), selected);
  assert.equal(calls[2].init.body, JSON.stringify(release));
  // A non-endpoint device id and an unknown action both fail closed.
  await assert.rejects(api.updateVoicePreference({ ...command, outputDevice: "speakers" }, HANDLE), TavernProtocolError);
  await assert.rejects(api.updateVoicePreference({ ...command, action: "setOutputDeviceX" }, HANDLE), TavernProtocolError);
});

test("management import history validator and client use the exact session-read route", async () => {
  // The loss report is durable evidence the Host already wrote: the mirror
  // accepts exactly its shape and rejects anything a card body could smuggle
  // into it, and it reads through the one session-authenticated route.
  const history = {
    apiVersion: 1,
    entries: [
      {
        importId: HANDLE,
        occurredAtMs: 1_700_000_000_000,
        cardName: "Safe Rin",
        counts: { accepted_typed: 2, preserved_opaque: 0, dropped_unsupported: 1, rejected_invalid: 0 },
      },
    ],
  };
  assert.deepEqual(validateStCardImportHistory(history), history);
  assert.throws(() => validateStCardImportHistory({ ...history, extra: true }), TavernProtocolError);
  assert.throws(
    () => validateStCardImportHistory({ ...history, entries: [{ ...history.entries[0], body: "card body text" }] }),
    TavernProtocolError,
  );
  assert.throws(
    () => validateStCardImportHistory({
      ...history,
      entries: [{ ...history.entries[0], counts: { accepted_typed: 1, preserved_opaque: 0 } }],
    }),
    TavernProtocolError,
  );
  assert.throws(
    () => validateStCardImportHistory({ ...history, entries: [{ ...history.entries[0], importId: "not-a-handle" }] }),
    TavernProtocolError,
  );
  assert.throws(
    () => validateStCardImportHistory({
      ...history,
      entries: [{ ...history.entries[0], counts: { ...history.entries[0].counts, accepted_typed: -1 } }],
    }),
    TavernProtocolError,
  );

  const calls = [];
  const api = createManagementPipelineApi(async (path, init) => {
    calls.push({ path, init });
    return response(history);
  });
  assert.deepEqual(await api.readStCardImportHistory(), history);
  assert.deepEqual(calls[0], {
    path: "/api/tavern/v1/import-history",
    init: { method: "GET", credentials: "same-origin" },
  });
});

test("the hand-written client mirror covers the Host contract's whole operation, label and problem vocabulary", async () => {
  // The browser client mirrors `tavern_browser_api/v1` by hand and stays
  // dependency-free, so nothing at compile time forces the two to agree. The
  // Host-derived vocabulary is compared against the mirror source directly:
  // comparing it through a runtime snapshot would test this fixture's shape, not
  // the vocabulary, and the failure this guards (a Host operation with no client
  // mirror) is a static gap, not a runtime state.
  const { readFile } = await import("node:fs/promises");
  const { TavernBrowserContractV1 } = await import("../../host/src/tavern/browser-contract/index.ts");
  const literalsIn = (union) => {
    const members = Array.isArray(union?.anyOf) ? union.anyOf : Array.isArray(union?.oneOf) ? union.oneOf : [];
    return members.map((member) => member?.const).filter((value) => typeof value === "string");
  };
  const operationSchema = TavernBrowserContractV1.schemas.TavernBrowserOperationV1Schema;
  const operationIds = literalsIn(operationSchema.properties.operationId);
  const labelKeys = literalsIn(operationSchema.properties.labelKey);
  const problemCodes = literalsIn(TavernBrowserContractV1.schemas.TavernProblemV1Schema.properties.code);
  assert.ok(operationIds.length >= 30, `the contract declares the mounted surface, saw ${operationIds.length}`);
  assert.ok(problemCodes.length >= 30, `the contract declares a closed problem vocabulary, saw ${problemCodes.length}`);

  const mirror = await readFile(new URL("../src/management-pipeline-api.ts", import.meta.url), "utf8");
  const sessionMirror = await readFile(new URL("../src/management-pipeline-session.ts", import.meta.url), "utf8");
  for (const [kind, vocabulary, source] of [
    ["operation", operationIds, mirror],
    ["label", labelKeys, mirror],
    ["problem code", problemCodes, mirror],
    ["operation", operationIds, sessionMirror],
    ["label", labelKeys, sessionMirror],
  ]) {
    for (const member of vocabulary) {
      assert.ok(
        source.includes(`"${member}"`),
        `the client mirror is missing the Host-declared ${kind} ${member}`,
      );
    }
  }
});

function modelProfiles(overrides = {}) {
  return {
    apiVersion: 1,
    chat: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
    game: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
    recommendedModels: [
      {
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        modelId: "deepseek-v4-flash",
        modelLabel: "DeepSeek V4 Flash",
        allowedThinkingLevels: ["low", "high", "max"],
        defaultThinkingLevel: "high",
      },
    ],
    ...overrides,
  };
}

test("management model-profile validators and client round-trip a player-typed model id through the exact session and CSRF-bound routes", async () => {
  const profiles = modelProfiles();
  assert.deepEqual(validateModelProfiles(profiles), profiles);

  // A model id outside the recommendation is the player's own value: a general
  // bounded string, never a closed union and never a catalog membership test.
  const playerValue = modelProfiles({
    game: { revision: 1, modelId: "qwen2.5-coder:7b", thinkingLevel: "xhigh" },
  });
  assert.deepEqual(validateModelProfiles(playerValue), playerValue);

  const command = {
    apiVersion: 1,
    surface: "game",
    expectedRevision: 0,
    modelId: "qwen2.5-coder:7b",
    thinkingLevel: "xhigh",
  };
  assert.deepEqual(validateModelProfileUpdateCommand(command), command);
  for (const surface of ["chat", "game"]) {
    assert.deepEqual(validateModelProfileUpdateCommand({ ...command, surface }), { ...command, surface });
  }

  // Only the bounded shape is refused, and both schemas are strict.
  assert.throws(() => validateModelProfiles({ ...profiles, extra: true }), TavernProtocolError);
  assert.throws(
    () => validateModelProfiles({ ...profiles, game: { revision: 1, modelId: "has space", thinkingLevel: "high" } }),
    TavernProtocolError,
  );
  assert.throws(
    () => validateModelProfiles({ ...profiles, recommendedModels: [{ providerId: "deepseek" }] }),
    TavernProtocolError,
  );
  assert.throws(() => validateModelProfileUpdateCommand({ ...command, surface: "both" }), TavernProtocolError);
  assert.throws(() => validateModelProfileUpdateCommand({ ...command, expectedRevision: -1 }), TavernProtocolError);
  assert.throws(() => validateModelProfileUpdateCommand({ ...command, thinkingLevel: "high level" }), TavernProtocolError);

  const calls = [];
  const api = createManagementPipelineApi(async (path, init) => {
    calls.push({ path, init });
    return response(init.method === "PUT" ? playerValue : profiles);
  });
  assert.deepEqual(await api.readModelProfiles(), profiles);
  assert.deepEqual(calls[0], {
    path: "/api/tavern/v1/settings/profiles",
    init: { method: "GET", credentials: "same-origin" },
  });

  // A malformed command and a non-canonical CSRF token are refused before any fetch.
  await assert.rejects(api.updateModelProfile({ ...command, modelId: "has space" }, HANDLE), TavernProtocolError);
  await assert.rejects(api.updateModelProfile(command, "not-a-canonical-csrf-token="), TavernProtocolError);
  assert.equal(calls.length, 1);

  assert.deepEqual(await api.updateModelProfile(command, HANDLE), playerValue);
  assert.deepEqual(calls[1], {
    path: "/api/tavern/v1/settings/profiles",
    init: {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-csrf-token": HANDLE },
      body: JSON.stringify(command),
    },
  });
});
