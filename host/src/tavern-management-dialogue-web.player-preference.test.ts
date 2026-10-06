import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import { PlayerPreferenceStore, playerPreferencePath } from "./settings/player-preference-store.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import { startTavernManagementDialogueWebServer } from "./tavern-management-dialogue-web.js";

// The record's durable path lock releases through the Windows stale-lock
// reclaimer; bind the same capability the production runtime binds.
bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * The core settings profile plus the language extension group, in the frozen
 * canonical order (core, output devices, language, connections).
 */
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
const LANGUAGE_ROUTES = ["settings.language.read", "settings.language.update"] as const;

const settingsProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...LANGUAGE_ROUTES],
  operationIds: [...CORE_OPERATIONS, ...LANGUAGE_ROUTES],
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

const worldInfoState = { state: "none" as const, revision: handle, items: [] };

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

/** The routes under test never leave the settings surface, so the rest is inert. */
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

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

/**
 * Starts the real handler over a real `PlayerPreferenceStore` on a temporary
 * root, so the shared-revision assertions exercise the durable record rather
 * than a mock that could hide two independent counters.
 */
async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-player-preference-web-"));
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: managementService(),
    worldInfoService: worldInfoService(),
    playerPreferenceStore: new PlayerPreferenceStore(playerPreferencePath(root)),
    profile: settingsProfile,
    bootstrapToken: token,
  });
  try {
    await run(server.origin);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
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

type Session = Readonly<{ csrfToken: string; cookie: string }>;

function read(origin: string, path: string, session: Session): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { Origin: origin, Cookie: session.cookie, "Sec-Fetch-Site": "same-origin" },
  });
}

function write(origin: string, path: string, session: Session, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "PUT",
    headers: {
      Origin: origin,
      Cookie: session.cookie,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "x-csrf-token": session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

test("both settings surfaces read and write ONE record under ONE revision", async () => {
  await withServer(async (origin) => {
    const session = await bootstrap(origin);

    // Both groups project the same never-configured record: revision 0, and each
    // response carries exactly its own frozen key set.
    const language0 = await (await read(origin, "/api/tavern/v1/settings/language", session)).json();
    assert.deepEqual(language0, { revision: 0, locale: null });
    assert.deepEqual(Object.keys(language0).sort(), ["locale", "revision"]);
    const voice0 = await (await read(origin, "/api/tavern/v1/settings/voice-preference", session)).json();
    assert.deepEqual(voice0, {
      revision: 0,
      disclosureVersion: null,
      consent: "undecided",
      decidedAtMs: null,
      outputDevice: null,
    });
    assert.deepEqual(Object.keys(voice0).sort(), ["consent", "decidedAtMs", "disclosureVersion", "outputDevice", "revision"]);

    // A language write advances the record to revision 1 ...
    const languageWrite = await write(origin, "/api/tavern/v1/settings/language", session, {
      expectedRevision: 0,
      locale: "en-US",
    });
    assert.equal(languageWrite.status, 200);
    assert.deepEqual(await languageWrite.json(), { revision: 1, locale: "en-US" });

    // ... and the Voice surface reads that SAME revision, not a second one.
    const voiceAfterLanguage = await (
      await read(origin, "/api/tavern/v1/settings/voice-preference", session)
    ).json();
    assert.equal(voiceAfterLanguage.revision, 1);

    // The voice write continues the one counter from the revision it just read ...
    const voiceWrite = await write(origin, "/api/tavern/v1/settings/voice-preference", session, {
      expectedRevision: 1,
      action: "accept",
      disclosureVersion: "mimo-cloud-tts-v1",
    });
    assert.equal(voiceWrite.status, 200);
    const accepted = (await voiceWrite.json()) as { revision: number; consent: string };
    assert.equal(accepted.revision, 2);
    assert.equal(accepted.consent, "accepted");

    // ... and the language surface now reads revision 2 with its own field group
    // untouched by the voice write.
    assert.deepEqual(await (await read(origin, "/api/tavern/v1/settings/language", session)).json(), {
      revision: 2,
      locale: "en-US",
    });
  });
});

test("a stale expectedRevision is rejected across BOTH settings surfaces", async () => {
  await withServer(async (origin) => {
    const session = await bootstrap(origin);

    const first = await write(origin, "/api/tavern/v1/settings/language", session, {
      expectedRevision: 0,
      locale: "en-US",
    });
    assert.equal(first.status, 200);

    // The voice surface still holds revision 0: the record refuses the write
    // rather than silently taking a second, independent revision.
    const staleVoice = await write(origin, "/api/tavern/v1/settings/voice-preference", session, {
      expectedRevision: 0,
      action: "revoke",
    });
    assert.equal(staleVoice.status, 409);
    assert.equal(((await staleVoice.json()) as { code: string }).code, "settings_revision_conflict");

    // And the language surface's own stale revision is refused after a voice
    // write, so neither group can clobber the other.
    const voiceWrite = await write(origin, "/api/tavern/v1/settings/voice-preference", session, {
      expectedRevision: 1,
      action: "revoke",
    });
    assert.equal(voiceWrite.status, 200);
    const staleLanguage = await write(origin, "/api/tavern/v1/settings/language", session, {
      expectedRevision: 1,
      locale: "zh-CN",
    });
    assert.equal(staleLanguage.status, 409);
    assert.equal(((await staleLanguage.json()) as { code: string }).code, "settings_revision_conflict");

    // Neither rejection mutated the record.
    assert.deepEqual(await (await read(origin, "/api/tavern/v1/settings/language", session)).json(), {
      revision: 2,
      locale: "en-US",
    });
  });
});

test("a profile that declares either settings group without the one record fails closed", async () => {
  await assert.rejects(
    startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: managementService(),
      worldInfoService: worldInfoService(),
      profile: settingsProfile,
      bootstrapToken: token,
    }),
    /tavern_management_composition_unavailable/u,
  );
});
