import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import type { PlayerPreference, PlayerPreferenceUpdate } from "./settings/player-preference-store.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import type { TavernConnectionProbe } from "./tavern/connection-probe.js";
import { createTavernConnectionService } from "./tavern/connection-service.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type { WorldInfoStateV1 } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import { startTavernManagementDialogueWebServer } from "./tavern-management-dialogue-web.js";

/**
 * ADR-0010's Class B rule, enforced as a rule rather than as one removed guard.
 *
 * The ADR (`design/adr/0010-unified-in-flight-action-rule.md`) splits every
 * player action a generating turn can overlap into two classes. Class A is a
 * focus transfer: it aborts the turn through the one cancel path. Class B is
 * state, configuration or metadata: it must NEVER be refused because a turn is
 * generating, and its new value is what the next turn reads.
 *
 * The failure this gate exists for: `settings.connection.activate` carried a
 * `turnActive` refusal (`TavernDialogueBusyError` -> 409 `dialogue_busy`) that
 * made the settings panel refuse a model switch for the whole duration of a
 * reply. Removing that guard by hand is exactly the fix that grows back, because
 * nothing held the rule.
 *
 * So this gate holds the rule directly:
 *
 * - the Class B action list is DERIVED from the ADR's own section, so a newly
 *   declared Class B action cannot be added without landing in the table here
 *   (an unmapped action fails the gate instead of silently passing);
 * - each action is driven through the real management dispatcher with a durable
 *   turn IN FLIGHT, and must succeed (2xx) - never a turn-derived refusal;
 * - each action must not read the durable turn projection at all, which turns
 *   "it did not consult the turn" into a fact rather than a reading;
 * - the turn projection must be identical afterwards: the action did not
 *   disturb, cancel or complete the turn;
 * - the response must carry the value the durable store now holds, which is what
 *   "the next turn uses the new value" means from the browser's side.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADR = join(REPO, "design", "adr", "0010-unified-in-flight-action-rule.md");

/**
 * The Class B action ids the ADR itself names, read from the `### Class B`
 * section only, so the `### Class A` list can never leak into the requirement.
 */
export function classBActionIds(markdown: string): string[] {
  const section = markdown.split(/^### Class B/mu)[1]?.split(/^###/mu)[0] ?? "";
  const ids = [...section.matchAll(/`([a-z][a-z0-9._-]*)`/gu)].map((match) => match[1]!);
  return [...new Set(ids)].sort();
}

const HANDLE = "A".repeat(43);
const ITEM_HANDLE = `${"B".repeat(42)}A`;
const MEMORY_HANDLE = `${"C".repeat(42)}A`;
const PROJECTION_REVISION = `${"D".repeat(42)}A`;
const WORLD_INFO_REVISION = `${"W".repeat(42)}A`;
const WORLD_INFO_REVISION_BOUND = `${"X".repeat(42)}A`;
const BOOTSTRAP_TOKEN = "A".repeat(43);

/** The frozen canonical route/operation groups, in the order a profile requires. */
const CORE_ROUTES = [
  "bootstrap",
  "state.read",
  "draft.read",
  "draft.save",
  "draft.discard",
  "chat.list",
  "chat.rename",
  "memory.read",
  "memory.mutate",
  "world-info.read",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
] as const;
const CORE_OPERATIONS = [
  "draft.save",
  "draft.discard",
  "chat.rename",
  "memory.mutate",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
] as const;
const OPTIONAL_GROUPS = [
  ["settings.voice.devices"],
  ["settings.language.read", "settings.language.update"],
  [
    "settings.connection.read",
    "settings.connection.create",
    "settings.connection.test",
    "settings.connection.activate",
    "settings.connection.model",
    "settings.connection.remove",
  ],
  ["settings.profiles.read", "settings.profiles.update"],
  [
    "companion.list",
    "companion.detail",
    "companion.create",
    "persona.read",
    "persona.update",
    "scenario.read",
    "scenario.update",
    "greeting.read",
    "greeting.update",
    "chat.archive",
    "chat.restore",
    "chat.trash",
  ],
] as const;

/** Mutable facts the requests need: the live connection and preference revisions. */
type Facts = { connectionId: string; connectionRevision: number; preferenceRevision: number };

type ClassBAction = Readonly<{
  /** The exact request the shipped surface sends for this ADR action. */
  request: (facts: Facts) => Readonly<{ method: string; path: string; body?: unknown }>;
  /** The value the durable authority now holds and the response must carry back. */
  readBack: (body: Record<string, unknown>) => void;
}>;

/**
 * The request each ADR action maps to. A Class B action the ADR names but this
 * table does not is a gate failure, so the list cannot grow unchecked.
 */
const CLASS_B_REQUESTS: Readonly<Record<string, ClassBAction>> = Object.freeze({
  "settings.profiles.update": {
    request: () => ({
      method: "PUT",
      path: "/api/tavern/v1/settings/profiles",
      body: { apiVersion: 1, surface: "chat", expectedRevision: 0, modelId: "class-b-model", thinkingLevel: "high" },
    }),
    readBack: (body) => {
      const chat = body.chat as { modelId: string; thinkingLevel: string };
      assert.equal(chat.modelId, "class-b-model");
      assert.equal(chat.thinkingLevel, "high");
    },
  },
  "settings.connection.model": {
    request: (facts) => ({
      method: "POST",
      path: `/api/tavern/v1/settings/connections/${facts.connectionId}/model`,
      body: {
        apiVersion: 1,
        expectedRevision: facts.connectionRevision,
        modelId: "deepseek-v4-pro",
        thinkingLevel: "max",
      },
    }),
    readBack: (body) => {
      const [connection] = body.connections as readonly { modelId: string; thinkingLevel: string }[];
      assert.equal(connection!.modelId, "deepseek-v4-pro");
      assert.equal(connection!.thinkingLevel, "max");
    },
  },
  "settings.connection.activate": {
    request: (facts) => ({
      method: "POST",
      path: `/api/tavern/v1/settings/connections/${facts.connectionId}/activate`,
      body: { apiVersion: 1, expectedRevision: facts.connectionRevision },
    }),
    readBack: (body) => {
      const active = body.active as { connectionId: string } | null;
      assert.ok(active !== null, "the activation must be recorded as the durable active connection");
      assert.match(active.connectionId, /^[A-Za-z0-9_-]{43}$/u);
    },
  },
  "world-info.bind": {
    request: () => ({
      method: "PUT",
      path: "/api/tavern/v1/world-info",
      body: { apiVersion: 1, selectionGeneration: 1, expectedRevision: WORLD_INFO_REVISION, sourceHandle: ITEM_HANDLE },
    }),
    readBack: (body) => assert.equal(body.state, "selected"),
  },
  "persona.update": {
    request: () => ({
      method: "PUT",
      path: "/api/tavern/v1/persona",
      body: { apiVersion: 1, expectedRevision: 0, name: "class-b-persona" },
    }),
    readBack: (body) => assert.equal(body.name, "class-b-persona"),
  },
  "scenario.update": {
    request: () => ({
      method: "PUT",
      path: "/api/tavern/v1/scenario",
      body: { apiVersion: 1, expectedRevision: 0, name: "class-b-scenario", description: "class-b-scenario-text" },
    }),
    readBack: (body) => assert.equal(body.name, "class-b-scenario"),
  },
  "greeting.update": {
    request: () => ({
      method: "PUT",
      path: "/api/tavern/v1/greeting",
      body: { apiVersion: 1, expectedRevision: 0, variants: [{ text: "class-b-opening" }] },
    }),
    readBack: (body) => {
      const [variant] = body.variants as readonly { text: string }[];
      assert.equal(variant!.text, "class-b-opening");
    },
  },
  "chat.rename": {
    request: () => ({
      method: "PUT",
      path: "/api/tavern/v1/chat/title",
      body: {
        apiVersion: 1,
        selectionGeneration: 1,
        chatHandle: HANDLE,
        expectedManagementRevision: 1,
        title: "class-b-title",
      },
    }),
    readBack: (body) => assert.equal(body.title, "class-b-title"),
  },
  "chat.archive": {
    request: () => ({
      method: "POST",
      path: `/api/tavern/v1/chats/${HANDLE}/archive`,
      body: { apiVersion: 1, selectionGeneration: 1, expectedManagementRevision: 1 },
    }),
    readBack: (body) => assert.equal(body.status, "archived"),
  },
  "chat.restore": {
    request: () => ({
      method: "POST",
      path: `/api/tavern/v1/chats/${HANDLE}/restore`,
      body: { apiVersion: 1, selectionGeneration: 1, expectedManagementRevision: 1 },
    }),
    readBack: (body) => assert.equal(body.status, "active"),
  },
  "chat.trash": {
    request: () => ({
      method: "POST",
      path: `/api/tavern/v1/chats/${HANDLE}/trash`,
      body: { apiVersion: 1, selectionGeneration: 1, expectedManagementRevision: 1 },
    }),
    readBack: (body) => assert.equal(body.status, "trashed"),
  },
  "memory.mutate": {
    request: () => ({
      method: "PUT",
      path: "/api/tavern/v1/memory",
      body: {
        apiVersion: 1,
        operation: "create",
        expectedProjectionRevision: PROJECTION_REVISION,
        content: "class-b-memory",
      },
    }),
    readBack: (body) => {
      const memories = body.memories as readonly { content: string }[];
      assert.ok(
        memories.some((memory) => memory.content === "class-b-memory"),
        "the new memory must be in the read-back",
      );
    },
  },
  "draft.save": {
    request: () => ({
      method: "PUT",
      path: "/api/tavern/v1/draft",
      body: { apiVersion: 1, selectionGeneration: 1, expectedRevision: 0, text: "class-b-draft" },
    }),
    readBack: (body) => assert.equal(body.text, "class-b-draft"),
  },
  "draft.discard": {
    request: () => ({
      method: "DELETE",
      path: "/api/tavern/v1/draft",
      body: { apiVersion: 1, selectionGeneration: 1, expectedRevision: 1 },
    }),
    readBack: (body) => assert.equal(body.text, null),
  },
  "settings.language.update": {
    request: (facts) => ({
      method: "PUT",
      path: "/api/tavern/v1/settings/language",
      body: { expectedRevision: facts.preferenceRevision, locale: "ja-JP" },
    }),
    readBack: (body) => assert.equal(body.locale, "ja-JP"),
  },
  "settings.voice.consent": {
    request: (facts) => ({
      method: "PUT",
      path: "/api/tavern/v1/settings/voice-preference",
      body: { action: "accept", expectedRevision: facts.preferenceRevision, disclosureVersion: "mimo-cloud-tts-v1" },
    }),
    readBack: (body) => assert.equal(body.consent, "accepted"),
  },
  "settings.voice.devices": {
    request: () => ({ method: "GET", path: "/api/tavern/v1/settings/voice-devices" }),
    readBack: (body) => {
      const devices = body.devices as readonly { id: string; name: string }[];
      assert.equal(devices[0]!.id, "waveout:1");
    },
  },
});

/** A durable turn that is generating for the whole run: the Class B precondition. */
function runningTurnFacade(): Readonly<{ facade: TavernManagementStateFacade; reads: () => number }> {
  const state: TavernManagementState = {
    selection: { chatHandle: HANDLE, generation: 1, stateRevision: HANDLE },
    companionDisplayName: "Mira",
    title: "Farm Chat",
    transcript: [],
    draft: { revision: 0, text: null },
    turn: { handle: HANDLE, state: "running", projectionRevision: 1, canCancel: true },
    operations: [],
    worldInfo: null,
  };
  let reads = 0;
  return {
    facade: Object.freeze({
      async read() {
        reads += 1;
        return state;
      },
      async close() {
        // no-op
      },
    }),
    reads: () => reads,
  };
}

function appliedPreference(
  current: PlayerPreference,
  expectedRevision: number,
  update: PlayerPreferenceUpdate,
): PlayerPreference {
  const next: PlayerPreference = { ...current, revision: expectedRevision + 1 };
  if (update.action === "setLocale") return { ...next, locale: update.locale };
  if (update.action === "accept")
    return { ...next, disclosureVersion: update.disclosureVersion, consent: "accepted", decidedAtMs: 1 };
  if (update.action === "revoke") return { ...next, consent: "revoked" };
  return { ...next, outputDevice: update.outputDevice };
}

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

test("ADR-0010 Class B: no Host module re-wires a turn-state reader into a Class B path", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // The behavioural run above cannot see a composition that arms the refusal but
  // is not mounted by the gate. This is that seam: the removed guard was armed by
  // a `readTurnState` reader wired in from the composition, so both the service
  // and its composition must stay turn-blind.
  const connectionService = await readFile(join(here, "tavern", "connection-service.ts"), "utf8");
  assert.ok(!/turnActive/u.test(connectionService), "the connection service must not read turn state");
  assert.ok(
    !/TavernDialogueBusyError/u.test(connectionService),
    "a turn-busy refusal on a Class B path must not come back",
  );
  const composition = await readFile(join(here, "composition", "desktop-presentation-admission-owner.ts"), "utf8");
  assert.ok(
    !/readTurnState/u.test(composition),
    "the composition must not wire a turn-state reader into the connection service",
  );
});

test("ADR-0010 Class B: every action the ADR names succeeds with a turn in flight and leaves the turn alone", async () => {
  // 1. The requirement is the ADR's, not this file's: derive it and prove the
  //    table covers exactly it. A Class B action added to the ADR without a
  //    request here is the failure this catches.
  const declared = classBActionIds(await readFile(ADR, "utf8"));
  assert.ok(declared.length >= 10, `the ADR should name the Class B actions, read ${declared.length}`);
  assert.deepEqual(
    declared.filter((actionId) => CLASS_B_REQUESTS[actionId] === undefined),
    [],
    "every Class B action the ADR names must be exercised by this gate",
  );

  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-class-b-"));
  let worldInfoBound = false;
  const worldInfoState = (): WorldInfoStateV1 => ({
    state: worldInfoBound ? "selected" : "none",
    revision: worldInfoBound ? WORLD_INFO_REVISION_BOUND : WORLD_INFO_REVISION,
    items: [
      { handle: ITEM_HANDLE, title: "Pelican Town", summary: null, selected: worldInfoBound, pending: false },
    ],
  });
  let preference: PlayerPreference = {
    revision: 0,
    locale: null,
    disclosureVersion: null,
    consent: "undecided",
    decidedAtMs: null,
    outputDevice: null,
  };
  const modelProfiles = {
    chat: { surface: "chat" as const, revision: 0, modelId: "initial-model", thinkingLevel: "low" },
    game: { surface: "game" as const, revision: 0, modelId: "initial-model", thinkingLevel: "low" },
  };
  const memories: { handle: string; title: string; content: string }[] = [];
  const memoryRead = () => ({
    apiVersion: 1 as const,
    projectionRevision: PROJECTION_REVISION,
    chapters: Object.freeze([]),
    memories: Object.freeze(
      memories.map((memory) =>
        Object.freeze({
          handle: memory.handle,
          title: memory.title,
          content: memory.content,
          category: "semantic" as const,
          status: "active" as const,
          origin: "companion" as const,
          pinned: false,
        }),
      ),
    ),
  });
  const connectionProbe: TavernConnectionProbe = async () => Object.freeze({ outcome: "ready" as const, failure: null });

  const turn = runningTurnFacade();
  const connection = createTavernConnectionService({ agentDir: root, probe: connectionProbe });
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: turn.facade,
    managementService: Object.freeze({
      async readDraft() {
        return { apiVersion: 1 as const, revision: 0, text: null };
      },
      async saveDraft(command) {
        return { apiVersion: 1 as const, revision: command.expectedRevision + 1, text: command.text };
      },
      async discardDraft(command) {
        return { apiVersion: 1 as const, revision: command.expectedRevision + 1, text: null };
      },
      async listChats() {
        return { apiVersion: 1 as const, chats: [] };
      },
      async renameChatTitle(command) {
        return {
          apiVersion: 1 as const,
          title: command.title,
          managementRevision: command.expectedManagementRevision + 1,
        };
      },
      async transitionLifecycle(command) {
        const status =
          command.operation === "archive" ? ("archived" as const) : command.operation === "trash" ? ("trashed" as const) : ("active" as const);
        return {
          apiVersion: 1 as const,
          handle: command.chatHandle,
          status,
          managementRevision: command.expectedManagementRevision + 1,
        };
      },
      async commitOpeningVariant() {
        return { apiVersion: 1 as const, opening: null, managementRevision: 1 };
      },
      async close() {
        // no-op
      },
    }) satisfies ChatManagementService,
    memoryService: Object.freeze({
      async read() {
        return memoryRead();
      },
      async mutate(command) {
        if (command.operation === "create")
          memories.push({ handle: MEMORY_HANDLE, title: "Class B memory", content: command.content });
        return memoryRead();
      },
      async close() {
        // no-op
      },
    }),
    worldInfoService: Object.freeze({
      async read() {
        return worldInfoState();
      },
      async setBinding(command) {
        worldInfoBound = command.sourceHandle !== null;
        return worldInfoState();
      },
      async close() {
        // no-op
      },
    }),
    playerPreferenceStore: Object.freeze({
      async read() {
        return preference;
      },
      async update(expectedRevision, update) {
        preference = appliedPreference(preference, expectedRevision, update);
        return preference;
      },
    }),
    listVoiceOutputDevices: async () => [{ id: "waveout:1", name: "Speakers" }],
    connectionService: connection,
    modelProfileStore: Object.freeze({
      async read(surface) {
        return { ...modelProfiles[surface] };
      },
      async update(surface, expectedRevision, update) {
        modelProfiles[surface] = {
          surface,
          revision: expectedRevision + 1,
          modelId: update.modelId,
          thinkingLevel: update.thinkingLevel,
        };
        return { ...modelProfiles[surface] };
      },
    }),
    libraryService: Object.freeze({
      async listCompanions() {
        return [];
      },
    }),
    personaService: Object.freeze({
      async read() {
        return null;
      },
      async update(request) {
        return { revision: request.expectedRevision + 1, name: request.name };
      },
    }),
    scenarioService: Object.freeze({
      async read() {
        return null;
      },
      async update(request) {
        return {
          revision: request.expectedRevision + 1,
          name: request.name,
          description: request.description,
          preview: request.description.slice(0, 64),
        };
      },
    }),
    greetingService: Object.freeze({
      async read() {
        return null;
      },
      async update(request) {
        return { revision: request.expectedRevision + 1, variants: request.variants };
      },
    }),
    profile: composeTavernProfile({
      profileId: "gamebuddy.tavern-management.chat-list-title",
      releaseTier: "tavern_management",
      routeIds: [...CORE_ROUTES, ...OPTIONAL_GROUPS.flat()],
      operationIds: [...CORE_OPERATIONS, ...OPTIONAL_GROUPS.flat()],
      navigationItemIds: ["chat", "memory", "characters"],
    }),
    bootstrapToken: BOOTSTRAP_TOKEN,
  });

  try {
    const origin = server.origin;
    const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: BOOTSTRAP_TOKEN }),
    });
    assert.equal(bootstrap.status, 200);
    const snapshot = (await bootstrap.json()) as { csrfToken: string };
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const sessionHeaders = { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" };

    // The precondition the whole rule is about: a durable turn is generating.
    const before = await fetch(`${origin}/api/tavern/v1/state`, { headers: sessionHeaders });
    const beforeState = (await before.json()) as { chat: { turn: unknown } };
    assert.equal((beforeState.chat.turn as { state: string }).state, "running");

    // A ready connection is what `activate` CASes on; this is setup, not a Class B action.
    const created = await fetch(`${origin}/api/tavern/v1/settings/connections`, {
      method: "POST",
      headers: { ...sessionHeaders, "Content-Type": "application/json", "X-CSRF-Token": snapshot.csrfToken },
      body: JSON.stringify({ apiVersion: 1, providerId: "deepseek", apiKey: "sk-synthetic-credential" }),
    });
    assert.equal(created.status, 200);
    const createdBody = (await created.json()) as {
      revision: number;
      connections: readonly { connectionId: string }[];
    };
    const facts: Facts = {
      connectionId: createdBody.connections[0]!.connectionId,
      connectionRevision: createdBody.revision,
      preferenceRevision: 0,
    };
    const probed = await fetch(`${origin}/api/tavern/v1/settings/connections/${facts.connectionId}/test`, {
      method: "POST",
      headers: { ...sessionHeaders, "Content-Type": "application/json", "X-CSRF-Token": snapshot.csrfToken },
      body: JSON.stringify({ apiVersion: 1, expectedRevision: facts.connectionRevision }),
    });
    assert.equal(probed.status, 200);
    facts.connectionRevision = ((await probed.json()) as { state: { revision: number } }).state.revision;

    const order = [
      "settings.profiles.update",
      "settings.connection.activate",
      "settings.connection.model",
      "world-info.bind",
      "persona.update",
      "scenario.update",
      "greeting.update",
      "chat.rename",
      "chat.archive",
      "chat.restore",
      "chat.trash",
      "memory.mutate",
      "draft.save",
      "settings.language.update",
      "settings.voice.consent",
      "settings.voice.devices",
      "draft.discard",
    ];
    assert.deepEqual(
      [...order].sort(),
      Object.keys(CLASS_B_REQUESTS).sort(),
      "the run must exercise every mapped Class B action",
    );

    for (const actionId of order) {
      const action = CLASS_B_REQUESTS[actionId]!;
      const request = action.request(facts);
      const readsBefore = turn.reads();
      const response = await fetch(`${origin}${request.path}`, {
        method: request.method,
        headers: {
          ...sessionHeaders,
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(request.method === "GET" ? {} : { "X-CSRF-Token": snapshot.csrfToken }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      const raw = await response.text();
      assert.equal(response.status, 200, `${actionId} answered ${response.status} while a turn was in flight: ${raw}`);
      // A refusal that consulted the durable turn is the defect the ADR names.
      assert.equal(
        turn.reads() - readsBefore,
        0,
        `${actionId} read the durable turn projection; a Class B action must not consult turn state`,
      );
      const body = JSON.parse(raw) as Record<string, unknown>;
      assert.notEqual(body.code, "dialogue_busy", `${actionId} answered a turn-derived refusal`);
      action.readBack(body);
      if (typeof body.revision === "number" && actionId.startsWith("settings.")) {
        if (actionId.startsWith("settings.connection")) facts.connectionRevision = body.revision;
        else facts.preferenceRevision = body.revision;
      }
    }

    // The turn is undisturbed: still the same generating turn, and no Class B
    // action above ever reached the cancel path that Class A owns.
    const after = await fetch(`${origin}/api/tavern/v1/state`, { headers: sessionHeaders });
    const afterState = (await after.json()) as { chat: { turn: unknown } };
    assert.deepEqual(afterState.chat.turn, beforeState.chat.turn, "a Class B action disturbed the turn");
    assert.equal((afterState.chat.turn as { state: string }).state, "running");
  } finally {
    await server.close();
    await connection.close();
    await rm(root, { recursive: true, force: true });
  }
});
