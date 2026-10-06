import assert from "node:assert/strict";
import test from "node:test";
import type { VoicePreferenceUpdate } from "./settings/voice-preference-store.js";
import { composeTavernProfile, type StCardImportHistoryV1 } from "./tavern/browser-contract/index.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import { startTavernManagementDialogueWebServer } from "./tavern-management-dialogue-web.js";

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
/** Two distinct canonical base64url handles, the shape the Host mints for an import. */
const newerImportId = `${'I'.repeat(42)}A`;
const olderImportId = `${'I'.repeat(42)}E`;

/**
 * The reviewed ST-card import extension, including its history read. A profile
 * that declares the group declares the whole group (routes and operations), so
 * the history route is mounted exactly when the import surface is.
 */
const IMPORT_ROUTES = [
  "character.import.stage",
  "character.import.read",
  "character.import.review",
  "character.import.confirm",
  "character.import.history",
] as const;

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

const importProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...IMPORT_ROUTES],
  operationIds: [...CORE_OPERATIONS, ...IMPORT_ROUTES],
  navigationItemIds: ["chat", "characters"],
});

/** The same surface without the import extension: the history route is absent. */
const noImportProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES],
  operationIds: [...CORE_OPERATIONS],
  navigationItemIds: ["chat", "characters"],
});

const state: TavernManagementState = {
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  companionDisplayName: "Mira",
  title: "Farm Chat",
  transcript: [],
  draft: { revision: 0, text: null },
  turn: null,
  operations: [],
  worldInfo: null,
};

const facade: TavernManagementStateFacade = Object.freeze({
  read: async () => state,
  close: async () => undefined,
});

const worldInfoState = {
  state: "none" as const,
  revision: handle,
  items: [],
};

function worldInfoService(): WorldInfoBindingManagementService {
  return Object.freeze({
    async read() {
      return worldInfoState;
    },
    async setBinding() {
      return worldInfoState;
    },
    async close() {
      // no-op
    },
  });
}

const voicePreferenceStore = Object.freeze({
  async read() {
    return {
      revision: 0,
      disclosureVersion: null,
      consent: "undecided" as const,
      decidedAtMs: null,
      outputDevice: null,
    };
  },
  async update(_expectedRevision: number, _update: VoicePreferenceUpdate) {
    return {
      revision: 1,
      disclosureVersion: null,
      consent: "revoked" as const,
      decidedAtMs: 1,
      outputDevice: null,
    };
  },
});

/** The routes under test never leave the import surface, so the rest is inert. */
function managementService(): ChatManagementService {
  return Object.freeze({
    async listChats() {
      return { apiVersion: 1 as const, chats: [] };
    },
    async renameChatTitle() {
      throw new Error("rename_not_used");
    },
    async transitionLifecycle() {
      throw new Error("retention_not_used");
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
  });
}

const stCardImportService = Object.freeze({
  async import() {
    throw new Error("stage_not_used");
  },
  async read() {
    throw new Error("read_not_used");
  },
  async recordReview() {
    throw new Error("review_not_used");
  },
  async readReview() {
    return null;
  },
});

const historyEntries = Object.freeze([
  Object.freeze({
    importId: newerImportId,
    occurredAtMs: 1_700_000_500_000,
    cardName: "Safe Rin",
    counts: Object.freeze({ accepted_typed: 2, preserved_opaque: 0, dropped_unsupported: 1, rejected_invalid: 0 }),
  }),
  Object.freeze({
    importId: olderImportId,
    occurredAtMs: 1_700_000_000_000,
    cardName: "Quiet Ash",
    counts: Object.freeze({ accepted_typed: 0, preserved_opaque: 1, dropped_unsupported: 0, rejected_invalid: 0 }),
  }),
]);

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

test("management history route serves the durable loss report to the exact browser session", async () => {
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: managementService(),
    worldInfoService: worldInfoService(),
    voicePreferenceStore,
    stCardImportService,
    confirmStCardImport: async () => Object.freeze({ name: "Safe Rin" }),
    stCardImportHistoryService: Object.freeze({ list: async () => historyEntries }),
    profile: importProfile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    // No browser session, no history: the loss report is player-scoped evidence.
    assert.equal((await fetch(`${origin}/api/tavern/v1/import-history`)).status, 401);

    const { cookie } = await bootstrap(origin);
    const response = await fetch(`${origin}/api/tavern/v1/import-history`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as StCardImportHistoryV1;
    // The route projects exactly the Host's record: the card name, when, and the
    // per-class counts. No card body text is expressible here at all.
    assert.deepEqual(body, {
      apiVersion: 1,
      entries: [
        {
          importId: newerImportId,
          occurredAtMs: 1_700_000_500_000,
          cardName: "Safe Rin",
          counts: { accepted_typed: 2, preserved_opaque: 0, dropped_unsupported: 1, rejected_invalid: 0 },
        },
        {
          importId: olderImportId,
          occurredAtMs: 1_700_000_000_000,
          cardName: "Quiet Ash",
          counts: { accepted_typed: 0, preserved_opaque: 1, dropped_unsupported: 0, rejected_invalid: 0 },
        },
      ],
    });
    // The route is strict about its request shape: a query string is refused
    // rather than silently ignored.
    assert.equal(
      (await fetch(`${origin}/api/tavern/v1/import-history?apiVersion=1`, {
        headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      })).status,
      400,
    );
  } finally {
    await server.close();
  }
});

test("management history route is absent from a profile that declares no reviewed import", async () => {
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: managementService(),
    worldInfoService: worldInfoService(),
    voicePreferenceStore,
    profile: noImportProfile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const { cookie } = await bootstrap(origin);
    const response = await fetch(`${origin}/api/tavern/v1/import-history`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, "profile_operation_unavailable");
  } finally {
    await server.close();
  }
});

test("a profile that declares the import group without its history service fails closed before any dispatch", async () => {
  await assert.rejects(
    // The route, the operation AND the two import services are declared, but the
    // history service is not: the profile advertises a capability the mounted
    // dispatcher could not serve, so construction refuses it.
    startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: managementService(),
      worldInfoService: worldInfoService(),
      voicePreferenceStore,
      stCardImportService,
      confirmStCardImport: async () => Object.freeze({ name: "Safe Rin" }),
      profile: importProfile,
      bootstrapToken: token,
    }),
    /tavern_management_composition_unavailable/u,
  );
});
