/**
 * `presets.read` through the real dispatcher over a real preset store.
 *
 * WHY THIS FILE EXISTS
 * The Preset panel (`dialogue-web/src/components/PresetAssemblySurface.tsx`) reads
 * `GET /api/tavern/v1/presets` on mount. Until this route existed the only thing that answered was a Playwright
 * `page.route` stub, so a real Host answered 404 and the panel showed its read-failure banner - a panel wired to a
 * route nobody served. These tests hold the route to the producer rather than to a hand-written body: the expected
 * payload is what `presetAssemblySurface` returns for the same stored document and the same three caller facts, so a
 * number that drifts between the route and the producer fails here instead of on a screenshot.
 *
 * The store is the REAL one (`createPresetStore`) over a real root, and the empty case is the store's own answer -
 * `list()` over a root with no presets - not a constant this test's subject returns when it thinks of nothing.
 *
 * WHAT THE PAYLOAD CANNOT SAY YET, and this test states it rather than hiding it: no preset is bound to the Chat
 * runtime, so the sampler reading is the named absence `{ unavailable: "no_composed_model" }` and every marker is a
 * slot with no source. Both are the composition's inputs here exactly as they are in
 * `desktop-presentation-admission-owner.ts`; the assertions below prove the route carries them through, not that
 * they are what a live session would say.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { type PresetAssemblySurfaceV1, presetAssemblySurface } from "./preset-assembly-surface.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import { createPresetAssemblyRead } from "./tavern/preset-assembly-read.js";
import type { MacroContext } from "./tavern/preset-macros.js";
import { createPresetStore, type PresetStore } from "./tavern/preset-store.js";
import {
  createTavernManagementDialogueWebRequestHandler,
  startTavernManagementDialogueWebServer,
} from "./tavern-management-dialogue-web.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
/** A handle shape the dispatcher's own opaque-handle test accepts (22..128 of the URL alphabet). */
const handle = `${"C".repeat(42)}A`;

const CORE_ROUTES = [
  "bootstrap",
  "state.read",
  "draft.read",
  "draft.save",
  "draft.discard",
  "chat.list",
  "chat.rename",
  "world-info.read",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
] as const;

const CORE_OPERATIONS = [
  "draft.save",
  "draft.discard",
  "chat.rename",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
] as const;

const PRESET_ROUTES = ["presets.read"] as const;

const profile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...PRESET_ROUTES],
  operationIds: [...CORE_OPERATIONS],
  navigationItemIds: ["chat", "characters"],
});

/** The same declaration without the preset readout: the route must answer 404 rather than serve an undeclared read. */
const coreOnlyProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES],
  operationIds: [...CORE_OPERATIONS],
  navigationItemIds: ["chat", "characters"],
});

const PRESET_ID = "route-fixture";

/** A chat-completion preset with a marker slot, a switched-off entry, an in-chat row and two macro spellings. */
const PRESET_DOCUMENT = Object.freeze({
  name: "Route fixture - depth aware",
  temperature: 0.85,
  top_p: 0.9,
  prompts: [
    { identifier: "main", name: "Main Prompt", role: "system", enabled: true, content: "Write {{char}}'s reply." },
    { identifier: "worldInfoBefore", marker: true, role: "system", enabled: true, content: "" },
    { identifier: "charDescription", marker: true, role: "system", enabled: true, content: "" },
    { identifier: "chatHistory", marker: true, role: "system", enabled: true, content: "" },
    {
      identifier: "jailbreak",
      name: "Jailbreak",
      role: "system",
      enabled: true,
      content: "Stay in voice after the transcript.",
    },
    {
      identifier: "clockNote",
      name: "Clock",
      role: "system",
      enabled: true,
      content: "The scene is lit as it is at {{time}}.",
      injection_position: 1,
      injection_depth: 3,
      injection_order: 100,
    },
    {
      identifier: "altRegister",
      name: "Alternate register",
      role: "system",
      enabled: false,
      content: "A different register for this scene.",
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
        { identifier: "clockNote", enabled: true },
        { identifier: "altRegister", enabled: false },
      ],
    },
  ],
});

/**
 * The three caller facts this mount has, spelled once: no authoring context, no slot content, and no composed model
 * (`desktop-presentation-admission-owner.ts` supplies exactly these today). Every assertion below uses THESE values,
 * so the expectation is the producer's own answer rather than a second copy of the numbers.
 */
const MACROS: MacroContext = Object.freeze({
  char: "",
  user: "",
  description: "",
  personality: "",
  scenario: "",
  persona: "",
  itemId: "",
});
const MARKERS: Readonly<Record<string, string>> = Object.freeze({});

async function storeAt(root: string): Promise<PresetStore> {
  return createPresetStore({ runtimeRoot: root, playerRoot: join(root, "tavern", "v1", "players", "player") });
}

/** The read exactly as the composition builds it, over the supplied store. */
function readOver(store: PresetStore) {
  return createPresetAssemblyRead({ store, macros: MACROS, markers: MARKERS, sampling: null });
}

/** The producer's own reading of one stored preset: the single authority every assertion compares against. */
async function producerReading(store: PresetStore, presetId: string): Promise<PresetAssemblySurfaceV1> {
  const record = await store.read(presetId);
  return presetAssemblySurface({
    presetId: record.presetId,
    name: record.summary.name,
    revision: record.revision,
    document: record.document,
    macros: MACROS,
    markers: MARKERS,
    sampling: null,
  });
}

function managementOptions(input: {
  store: PresetStore;
  activeProfile: typeof profile | typeof coreOnlyProfile;
  /** Absent on the composition test that proves the mount fails closed without it. */
  read?: ReturnType<typeof readOver>;
}) {
  return {
    managementStateFacade: Object.freeze({
      read: async () => ({
        selection: { chatHandle: handle, generation: 1, stateRevision: handle },
        companionDisplayName: "Mira",
        companionHandle: handle,
        title: null,
        transcript: [],
        draft: { revision: 0, text: null },
        turn: null,
        operations: [],
        worldInfo: null,
      }),
      close: async () => undefined,
    }),
    managementService: Object.freeze({
      async listChats() {
        return { apiVersion: 1 as const, chats: [] };
      },
      async renameChatTitle() {
        throw new Error("rename_not_used");
      },
      async transitionLifecycle() {
        throw new Error("retention_not_used");
      },
      async commitOpeningVariant() {
        throw new Error("opening_variant_not_used");
      },
      async readDraft() {
        return { apiVersion: 1 as const, revision: 0, text: null };
      },
      async saveDraft() {
        throw new Error("draft_save_not_used");
      },
      async discardDraft() {
        throw new Error("draft_discard_not_used");
      },
      async close() {
        // no-op
      },
    }),
    worldInfoService: Object.freeze({
      async read() {
        return { state: "none" as const, revision: `${"W".repeat(42)}A`, items: [] };
      },
      async setBinding() {
        return { state: "none" as const, revision: `${"W".repeat(42)}A`, items: [] };
      },
      async detail() {
        throw new Error("unused_world_info_detail");
      },
      async create() {
        throw new Error("unused_world_info_create");
      },
      async update() {
        throw new Error("unused_world_info_update");
      },
      async delete() {
        throw new Error("unused_world_info_delete");
      },
      async close() {
        // no-op
      },
    }),
    playerPreferenceStore: Object.freeze({
      async read() {
        return {
          revision: 0,
          locale: null,
          disclosureVersion: null,
          consent: "undecided" as const,
          decidedAtMs: null,
          outputDevice: null,
          persona: null,
          paced: false,
          gamePromptAddition: "",
          appearance: "system" as const,
        };
      },
      async update() {
        throw new Error("preference_update_not_used");
      },
    }),
    ...(input.read === undefined ? {} : { presetAssemblyRead: input.read }),
    profile: input.activeProfile,
    bootstrapToken: token,
  };
}

async function bootstrap(origin: string): Promise<{ csrfToken: string; cookie: string }> {
  const response = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return {
    csrfToken: (JSON.parse(body) as { csrfToken: string }).csrfToken,
    cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!,
  };
}

function readPresets(
  origin: string,
  session: Readonly<{ csrfToken: string; cookie: string }>,
  search = "",
): Promise<Response> {
  return fetch(`${origin}/api/tavern/v1/presets${search}`, {
    method: "GET",
    headers: { Origin: origin, Cookie: session.cookie },
  });
}

test("the route answers the producer's own reading of every stored preset", async () => {
  const root = await canonicalTestRoot("tavern-presets-route-");
  try {
    const store = await storeAt(root);
    await store.import({ presetId: PRESET_ID, document: structuredClone(PRESET_DOCUMENT) });
    const server = await startTavernManagementDialogueWebServer(
      managementOptions({ store, activeProfile: profile, read: readOver(store) }),
    );
    try {
      const session = await bootstrap(server.origin);
      const response = await readPresets(server.origin, session);
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const payload = JSON.parse(body) as { apiVersion: number; presets: PresetAssemblySurfaceV1[] };

      // The population is the store's own answer: one imported preset, read through the store's own listing.
      const stored = await store.list();
      assert.equal(stored.length, 1, `the fixture must leave exactly one preset in the store, found ${stored.length}`);
      assert.deepEqual(
        payload.presets.map((preset) => preset.presetId),
        stored.map((summary) => summary.presetId),
        "the readout must list exactly the presets the store lists, by the store's own ids",
      );

      // The whole body, against the producer - not a hand-written expectation.
      const expected = await producerReading(store, PRESET_ID);
      assert.deepEqual(payload, { apiVersion: 1, presets: [expected] });

      // The two facts the panel counts, named on their own so a failure says which one drifted.
      assert.ok(expected.entries.total > 0, "the fixture must carry entries, or the count assertion measures nothing");
      assert.equal(
        payload.presets[0]!.entries.total,
        expected.entries.total,
        `the route reports ${payload.presets[0]!.entries.total} entries; the producer reports ${expected.entries.total}`,
      );
      assert.equal(payload.presets[0]!.entries.disabled, 1, "the fixture carries exactly one switched-off entry");
      assert.equal(
        payload.presets[0]!.depth.count,
        expected.depth.count,
        `the route reports ${payload.presets[0]!.depth.count} depth blocks; the producer reports ${expected.depth.count}`,
      );

      // The fifth answer is the named absence, not rows and not the preset's own values: nothing sends them yet.
      assert.deepEqual(
        payload.presets[0]!.sampling,
        { unavailable: "no_composed_model" },
        "with no composed model the sampler reading must be the named absence, never the values the preset wrote",
      );
      assert.ok(
        payload.presets[0]!.unfilledMarkers.length > 0,
        "the mount supplies no slot content, so the assembly names the slots it could not fill",
      );

      // Nothing is addressable on this read: a query string is a request this route does not serve.
      const withQuery = await readPresets(server.origin, session, "?presetId=" + PRESET_ID);
      assert.equal(withQuery.status, 400);
      assert.equal(((await withQuery.json()) as { code: string }).code, "invalid_request");
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an empty store answers an empty readout, and that is the store's answer rather than a constant", async () => {
  const root = await canonicalTestRoot("tavern-presets-route-empty-");
  try {
    const store = await storeAt(root);
    assert.deepEqual(await store.list(), [], "the fixture root must hold no preset before the route is asked");
    const server = await startTavernManagementDialogueWebServer(
      managementOptions({ store, activeProfile: profile, read: readOver(store) }),
    );
    try {
      const session = await bootstrap(server.origin);
      const response = await readPresets(server.origin, session);
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.deepEqual(JSON.parse(body), { apiVersion: 1, presets: [] });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a profile that does not declare presets.read answers 404 rather than serving the read", async () => {
  const root = await canonicalTestRoot("tavern-presets-route-undeclared-");
  try {
    const store = await storeAt(root);
    await store.import({ presetId: PRESET_ID, document: structuredClone(PRESET_DOCUMENT) });
    const server = await startTavernManagementDialogueWebServer(
      managementOptions({ store, activeProfile: coreOnlyProfile, read: readOver(store) }),
    );
    try {
      const session = await bootstrap(server.origin);
      const response = await readPresets(server.origin, session);
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as { code: string }).code, "profile_operation_unavailable");
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the handler fails closed when the profile advertises presets.read but no read is bound", async () => {
  const root = await canonicalTestRoot("tavern-presets-route-unbound-");
  try {
    const store = await storeAt(root);
    const options = managementOptions({ store, activeProfile: profile }) as Parameters<
      typeof createTavernManagementDialogueWebRequestHandler
    >[0];
    assert.throws(
      () => createTavernManagementDialogueWebRequestHandler(options),
      /tavern_management_composition_unavailable/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
