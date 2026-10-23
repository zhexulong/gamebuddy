import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  problemCodeFor,
  problemTextWithCode,
  TavernProblemError,
  TavernProtocolError,
  createManagementPipelineApi,
  validateMemoryMutationCommand,
  validateMemoryRead,
  validateModelProfileUpdateCommand,
  validateModelProfiles,
  validateSetWorldInfoBindingCommand,
  validateSnapshot,
  validateStCardImportHistory,
  validateCompanionAvatar,
  validateWorldInfoState,
  validateVoiceDevices,
  validateVoicePreference,
} from "../src/management-pipeline-api.ts";
import { createManagementPipelineSession } from "../src/management-pipeline-session.ts";
import { messages } from "../src/i18n.ts";

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
      companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
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
    // Chapters are the continuity's narrative history, on the same panel and under the same revision.
    chapters: [
      {
        handle: HANDLE,
        title: "First days",
        span: "2026-10-01\u21922026-10-03",
        content: "We put up the shutters; you hated the colour.",
        status: "edited",
        editedByPlayer: true,
      },
    ],
    memories: [
      {
        handle: `${"C".repeat(42)}A`,
        title: "Semantic memory",
        content: "The farmer likes blueberries.",
        category: "semantic",
        status: "active",
        // Whose memory it is. The read contract carries it and the panel splits on
        // it, so the fixture must too - a fixture that predates a field the
        // validator requires is what turned this suite red.
        origin: "companion",
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
  await api.renameChatTitle({ apiVersion: 1, chatHandle: HANDLE, expectedManagementRevision: 1, title: "Renamed" }, HANDLE);
  assert.deepEqual(observations, [{ operationId: "chat.rename", outcome: "passed", projectionRevision: "2" }]);
  // The mounted-only selection generation is gone from the command: an old sender that still carries
  // it is refused by the client before any fetch, so the strip cannot be silently undone on one side.
  await assert.rejects(
    api.renameChatTitle(
      { apiVersion: 1, selectionGeneration: 1, chatHandle: HANDLE, expectedManagementRevision: 1, title: "Renamed" },
      HANDLE,
    ),
    TavernProtocolError,
  );
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

test("management avatar upload is one base64 PUT on the roster companion's own route, and its reply is the digest", async () => {
  // The reply's digest is the value the runtime asset face publishes as that URL's ETag,
  // so the mirror accepts exactly that shape - a sha256 hex - and refuses anything else.
  const avatar = { apiVersion: 1, handle: HANDLE, digest: "a".repeat(64) };
  assert.deepEqual(validateCompanionAvatar(avatar), avatar);
  assert.throws(() => validateCompanionAvatar({ ...avatar, digest: "A".repeat(64) }), TavernProtocolError);
  assert.throws(() => validateCompanionAvatar({ ...avatar, digest: "a".repeat(63) }), TavernProtocolError);
  assert.throws(() => validateCompanionAvatar({ ...avatar, extra: true }), TavernProtocolError);
  assert.throws(() => validateCompanionAvatar({ apiVersion: 1, handle: BAD_HANDLE, digest: avatar.digest }), TavernProtocolError);

  const calls = [];
  const api = createManagementPipelineApi(async (path, init) => {
    calls.push({ path, init });
    return response(avatar);
  });
  assert.deepEqual(await api.uploadCompanionAvatar(HANDLE, "AAAA", HANDLE), avatar);
  assert.equal(calls[0].path, `/api/tavern/v1/companions/${HANDLE}/avatar`);
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json", "x-csrf-token": HANDLE });
  assert.equal(calls[0].init.body, JSON.stringify({ apiVersion: 1, avatarBase64: "AAAA" }));
  // A non-canonical handle or an empty payload is refused before any request is made.
  await assert.rejects(api.uploadCompanionAvatar(BAD_HANDLE, "AAAA", HANDLE), TavernProtocolError);
  await assert.rejects(api.uploadCompanionAvatar(HANDLE, "", HANDLE), TavernProtocolError);
  assert.equal(calls.length, 1);
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

test("management snapshot carries the turn's length-ceiling fact additively and refuses a false one", () => {
  const turn = { handle: HANDLE, state: "completed", projectionRevision: 1, canCancel: false };
  const withTurn = (value) => ({ ...snapshot(), chat: { ...snapshot().chat, turn: value } });
  assert.doesNotThrow(() => validateSnapshot(withTurn({ ...turn })));
  assert.doesNotThrow(() => validateSnapshot(withTurn({ ...turn, truncated: true })));
  assert.doesNotThrow(() => validateSnapshot(withTurn({ ...turn, problemCode: "interrupted", truncated: true })));
  for (const truncated of [false, "true", 1]) {
    assert.throws(() => validateSnapshot(withTurn({ ...turn, truncated })), TavernProtocolError);
  }
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
  const preference = { revision: 0, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null };
  const accepted = { revision: 1, disclosureVersion: "mimo-cloud-tts-v1", consent: "accepted", decidedAtMs: 10, outputDevice: null, persona: null };
  assert.deepEqual(validateVoicePreference(preference), preference);
  // The persona is a required member of the frozen read shape, and only the
  // bounded lowercase-snake id shape (or null) is accepted.
  assert.deepEqual(validateVoicePreference({ ...preference, persona: "soft_maid" }), { ...preference, persona: "soft_maid" });
  assert.throws(() => validateVoicePreference({ ...preference, persona: "SoftMaid" }), TavernProtocolError);
  assert.throws(() => validateVoicePreference({ ...preference, persona: "a".repeat(33) }), TavernProtocolError);
  assert.throws(
    () => validateVoicePreference({ revision: 0, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null }),
    TavernProtocolError,
  );
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

  const selected = { revision: 4, disclosureVersion: "mimo-cloud-tts-v1", consent: "accepted", decidedAtMs: 10, outputDevice: "waveout:1", persona: null };
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

test("management Voice persona selection rides the existing consent command", async () => {
  // A persona selection is the fourth variant of the SAME consent operation:
  // no new route, one CSRF-bound PUT, and only the bounded persona shape (or
  // null) is accepted.
  const selected = { revision: 5, disclosureVersion: "mimo-cloud-tts-v1", consent: "accepted", decidedAtMs: 10, outputDevice: null, persona: "soft_maid" };
  const calls = [];
  const api = createManagementPipelineApi(async (path, init) => {
    calls.push({ path, init });
    return response(init.method === "PUT" ? selected : { ...selected, persona: null });
  });
  const command = { expectedRevision: 4, action: "setPersona", persona: "soft_maid" };
  assert.deepEqual(await api.updateVoicePreference(command, HANDLE), selected);
  assert.equal(calls[0].path, "/api/tavern/v1/settings/voice-preference");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json", "x-csrf-token": HANDLE });
  assert.equal(calls[0].init.body, JSON.stringify(command));

  // Clearing back to no persona is the null form of the same action.
  const clear = { expectedRevision: 5, action: "setPersona", persona: null };
  assert.deepEqual(await api.updateVoicePreference(clear, HANDLE), selected);
  assert.equal(calls[1].init.body, JSON.stringify(clear));

  // The shape is bounded: an uppercase/gapped id and an extra key fail closed.
  await assert.rejects(api.updateVoicePreference({ ...command, persona: "SoftMaid" }, HANDLE), TavernProtocolError);
  await assert.rejects(api.updateVoicePreference({ ...command, persona: 7 }, HANDLE), TavernProtocolError);
  await assert.rejects(api.updateVoicePreference({ ...command, extra: true }, HANDLE), TavernProtocolError);
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

test("the client mirror's API shape and thinking level lists are the Host contract's", async () => {
  // Same reason as the vocabulary test above, for the two lists a player picks from. A
  // missing shape is not cosmetic: the player cannot configure that endpoint at all, which is
  // exactly how `azure-openai-responses` and `pi-messages` were absent on the Host side.
  const { readFile } = await import("node:fs/promises");
  const { TavernBrowserContractV1 } = await import("../../host/src/tavern/browser-contract/index.ts");
  const literalsIn = (union) => {
    const members = Array.isArray(union?.anyOf) ? union.anyOf : Array.isArray(union?.oneOf) ? union.oneOf : [];
    return members.map((member) => member?.const).filter((value) => typeof value === "string");
  };
  const shapes = literalsIn(TavernBrowserContractV1.schemas.TavernConnectionApiShapeV1Schema);
  const levels = literalsIn(TavernBrowserContractV1.schemas.TavernConnectionThinkingLevelV1Schema);
  assert.deepEqual(shapes.length, 10, `the contract declares the runtime's own shape set, saw ${shapes.join(", ")}`);
  assert.deepEqual(levels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

  const mirror = await readFile(new URL("../src/management-pipeline-api.ts", import.meta.url), "utf8");
  const listIn = (source, name) => {
    const start = source.indexOf(name);
    assert.notEqual(start, -1, `the mirror no longer declares ${name}`);
    const end = source.indexOf("] as const", start);
    assert.notEqual(end, -1, `${name} is no longer a const list`);
    return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  };
  assert.deepEqual(listIn(mirror, "const CONNECTION_API_SHAPES"), shapes, "the mirror's shape list drifted from the contract");
  assert.deepEqual(
    listIn(mirror, "const CONNECTION_THINKING_LEVELS"),
    levels,
    "the mirror's thinking level list drifted from the contract",
  );
});

/**
 * One connection row, as the Host projects it. `modelIds` is the endpoint's own listing from the
 * last probe: the mirror must accept what the contract declares and hold the same bound, or a real
 * 40-model endpoint read becomes an opaque protocol error in the panel.
 */
function connectionRow(overrides = {}) {
  return {
    connectionId: HANDLE,
    label: "DeepSeek \u00b7 deepseek-v4.1-flash",
    providerId: "deepseek",
    providerLabel: "DeepSeek",
    configured: true,
    readiness: "configured",
    active: false,
    modelId: "deepseek-v4.1-flash",
    modelLabel: "DeepSeek V4.1 Flash",
    thinkingLevel: "high",
    allowedThinkingLevels: ["low", "high", "max"],
    modelIds: null,
    baseUrl: null,
    failure: null,
    lastCheckedAtMs: null,
    ...overrides,
  };
}

function connectionState(overrides = {}) {
  return { apiVersion: 1, revision: 1, active: null, connections: [connectionRow()], providers: [], ...overrides };
}

test("the client mirror accepts the endpoint's own listing under the Host contract's own bound", async () => {
  const { readFile } = await import("node:fs/promises");
  const { TAVERN_MODEL_LISTING_LIMIT, TavernBrowserContractV1 } = await import(
    "../../host/src/tavern/browser-contract/index.ts"
  );
  const { validateConnectionState } = await import("../src/management-pipeline-api.ts");
  const listing = (count) => Array.from({ length: count }, (_unused, index) => `model-${index}`);

  // The bound is read from one place: the contract's declared ceiling for the published array.
  const declared = TavernBrowserContractV1.schemas.TavernConnectionV1Schema.properties.modelIds.anyOf;
  assert.ok(Array.isArray(declared), "the contract's row no longer declares a bounded listing");
  assert.equal(declared[0].maxItems, TAVERN_MODEL_LISTING_LIMIT, "the contract's listing bound moved");
  const mirror = await readFile(new URL("../src/management-pipeline-api.ts", import.meta.url), "utf8");
  const literal = /const CONNECTION_MODEL_LISTING_LIMIT = (\d+);/u.exec(mirror);
  assert.notEqual(literal, null, "the mirror no longer declares CONNECTION_MODEL_LISTING_LIMIT");
  assert.equal(Number(literal[1]), TAVERN_MODEL_LISTING_LIMIT, "the mirror's listing bound drifted from the contract's");

  // No probe yet, the endpoint's whole listing, and the ceiling itself are all readable states.
  assert.doesNotThrow(() => validateConnectionState(connectionState()));
  assert.doesNotThrow(() =>
    validateConnectionState(connectionState({ connections: [connectionRow({ modelIds: ["qwen2.5-coder:7b"] })] }))
  );
  assert.doesNotThrow(() =>
    validateConnectionState(
      connectionState({ connections: [connectionRow({ modelIds: listing(TAVERN_MODEL_LISTING_LIMIT) })] })
    )
  );
  // One past the ceiling, an id the product would refuse as a model id, and a non-list are not.
  for (const modelIds of [listing(TAVERN_MODEL_LISTING_LIMIT + 1), ["with space"], [""], [7], "not-a-list"])
    assert.throws(
      () => validateConnectionState(connectionState({ connections: [connectionRow({ modelIds })] })),
      `expected ${JSON.stringify(modelIds)} to be refused`
    );
});

function modelProfiles(overrides = {}) {
  return {
    apiVersion: 1,
    chat: { revision: 0, modelId: "deepseek-v4.1-flash", thinkingLevel: "high" },
    game: { revision: 0, modelId: "deepseek-v4.1-flash", thinkingLevel: "high" },
    recommendedModels: [
      {
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        modelId: "deepseek-v4.1-flash",
        modelLabel: "DeepSeek V4.1 Flash",
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

/**
 * The management surfaces must not be the last place that flattens a reason.
 *
 * `problem-code-gate.test.mjs` holds the two ends of the contract: the codes the
 * Host may produce are declared, and the client mirrors them. That gate stops at
 * the wire. The failure this one exists for is one layer further in: a surface
 * caught the validated RFC-9457 problem and reported a bare
 * `labels.failure` / `labels.*Failed`, so a `draft_conflict`, a
 * `connection_not_ready` and a genuine outage all read as the same sentence and
 * the player could not tell what to do next.
 *
 * Two halves, deliberately: the shared helper is asserted to render a bounded code as the
 * player's own sentence - and to keep the code out of it - while every management surface is
 * scanned for the catch shape that flattens one. The scan is proven against the shape it
 * forbids, so it cannot pass by finding nothing.
 */
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const PROBLEM_SURFACES = [
  join(WEB, "components", "management-surface-panels.tsx"),
  join(WEB, "components", "management-panels.tsx"),
  join(WEB, "components", "CharactersPanel.tsx"),
];

/** Catches that decide a failure outcome without naming what they caught. */
export function flatteningCatchesIn(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const bound =
        node.variableDeclaration !== undefined && ts.isIdentifier(node.variableDeclaration.name)
          ? node.variableDeclaration.name.text
          : null;
      const body = node.block.getText();
      const decidesFailure = body.includes('kind: "failure"');
      const usesCause = bound !== null && new RegExp(`\\b${bound}\\b`, "u").test(body);
      if (decidesFailure && !usesCause) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        found.push(`${fileName.replace(/\\/gu, "/").split("/src/").pop()}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

test("the Host's typed 413 payload_too_large surfaces as a problem, not as protocol corruption", async () => {
  // The management dispatcher answers an over-ceiling body with the typed 413
  // `payload_too_large` (`host/src/tavern-management-dialogue-web.test.ts:1410-1440`), and
  // that code is sent outside the Host's schema check, so the mirror is the only thing that
  // can read it: before the fix `PROBLEM_CODES` did not name it and the refusal arrived as
  // `TavernProtocolError`, which carries no code for `problemCodeFor` to name.
  const labels = messages("en");
  const problem = {
    type: "about:blank",
    title: "Payload too large",
    status: 413,
    code: "payload_too_large",
    requestId: HANDLE,
    retryable: false,
  };
  let calls = 0;
  const api = createManagementPipelineApi(async () => {
    calls += 1;
    return new Response(JSON.stringify(problem), { status: 413, headers: { "content-type": "application/json" } });
  });
  await assert.rejects(
    api.mutateMemory(
      { apiVersion: 1, operation: "create", expectedProjectionRevision: HANDLE, content: "A durable memory" },
      HANDLE,
    ),
    (error) => {
      assert.ok(error instanceof TavernProblemError, `expected the typed problem, got ${error?.name}`);
      // The developer half names the code; the player's half never does.
      assert.equal(problemCodeFor(error), "payload_too_large");
      assert.equal(
        problemTextWithCode("Operation failed.", error, labels),
        labels.problemRequestRejectedDetail,
        "a typed 413 is the catalogue's \"that cannot be taken as sent\" sentence",
      );
      assert.equal(problemTextWithCode("Operation failed.", error, labels).includes("payload_too_large"), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("problem-code-surface.1: a bounded problem code is worded for the player and named for the developer", () => {
  const labels = messages("en");
  const bounded = new TavernProblemError({
    type: "urn:gamebuddy:tavern:draft_conflict",
    title: "draft conflict",
    status: 409,
    code: "draft_conflict",
    requestId: HANDLE,
    retryable: false,
  });
  const message = problemTextWithCode("Operation failed.", bounded, labels);
  // The sentence is the one the Chat view words this refusal with - not a second vocabulary of
  // the management surface's own.
  assert.equal(message, labels.problemRevisionConflictDetail, "a stale draft reads as the stale-draft sentence");
  assert.notEqual(message, "Operation failed.", "a bounded refusal must not collapse into the generic sentence");
  // The strong half: the code is not in the text the player reads.
  assert.equal(message.includes("draft_conflict"), false, `the raw code must not reach the player: ${message}`);
  // ... and it is not lost, it is in the developer half.
  assert.equal(problemCodeFor(bounded), "draft_conflict", "a log line or a data-* attribute still names the code");

  // An opaque protocol failure names no code, so the sentence is the caller's own and the
  // developer half reports nothing.
  assert.equal(problemTextWithCode("Operation failed.", new TavernProtocolError(), labels), "Operation failed.");
  assert.equal(problemCodeFor(new TavernProtocolError()), null);
  assert.equal(problemTextWithCode("Operation failed.", new Error("boom"), labels), "Operation failed.");
  assert.equal(problemCodeFor(new Error("boom")), null);
});

test("problem-code-surface.2: the flattening scan detects the shape it forbids", () => {
  const flattened = [
    "export function f(labels: unknown, report: (n: unknown) => void) {",
    "  try {",
    "    g();",
    "  } catch {",
    '    report({ kind: "failure", text: labels.failure });',
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(flatteningCatchesIn(flattened, "dialogue-web/src/components/sample.tsx"), [
    "components/sample.tsx:4",
  ]);

  const names = [
    "export function f(labels: unknown, report: (n: unknown) => void, problemText: (b: string, e: unknown) => string) {",
    "  try {",
    "    g();",
    "  } catch (error) {",
    '    report({ kind: "failure", text: problemText(labels.failure, error) });',
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(flatteningCatchesIn(names, "dialogue-web/src/components/sample.tsx"), []);
});

test("problem-code-surface.3: no management surface flattens a caught problem", (t) => {
  const findings = [];
  let catches = 0;
  for (const file of PROBLEM_SURFACES) {
    const text = readFileSync(file, "utf8");
    catches += (text.match(/\bcatch\b/gu) ?? []).length;
    findings.push(...flatteningCatchesIn(text, file));
  }
  t.diagnostic(
    `problem-code-surface.3: ${PROBLEM_SURFACES.length} surface(s), ${catches} catch token(s), ${findings.length} flattening catch(es)`,
  );
  assert.deepEqual(
    findings,
    [],
    "a surface that reports a failure must name the reason it caught",
  );
});
