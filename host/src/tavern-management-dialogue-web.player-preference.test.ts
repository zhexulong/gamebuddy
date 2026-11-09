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
/** The appearance group sits after the language group in the dispatcher's canonical order. */
const APPEARANCE_ROUTES = ["settings.appearance.read", "settings.appearance.update"] as const;
/** The interface-language group sits directly after the appearance group in that same order. */
const UI_LANGUAGE_ROUTES = ["settings.ui-language.read", "settings.ui-language.update"] as const;

const settingsProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...LANGUAGE_ROUTES, ...APPEARANCE_ROUTES, ...UI_LANGUAGE_ROUTES],
  operationIds: [...CORE_OPERATIONS, ...LANGUAGE_ROUTES, ...APPEARANCE_ROUTES, ...UI_LANGUAGE_ROUTES],
  navigationItemIds: ["chat", "characters"],
});

const state: TavernManagementState = {
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  companionDisplayName: "Mira",
  companionHandle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA",
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
      persona: null,
      paced: false,
    });
    assert.deepEqual(Object.keys(voice0).sort(), [
      "consent",
      "decidedAtMs",
      "disclosureVersion",
      "outputDevice",
      "persona",
      "revision",
    ]);

    // A language write advances the record to revision 1 ...
    const languageWrite = await write(origin, "/api/tavern/v1/settings/language", session, {
      expectedRevision: 0,
      locale: "en-US",
    });
    assert.equal(languageWrite.status, 200);
    assert.deepEqual(await languageWrite.json(), { revision: 1, locale: "en-US" });

    // ... and the Voice surface reads that SAME revision, not a second one.
    const voiceAfterLanguage = await (await read(origin, "/api/tavern/v1/settings/voice-preference", session)).json();
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
test("a persona selection round-trips through the SAME consent operation and a stale revision is a conflict", async () => {
  await withServer(async (origin) => {
    const session = await bootstrap(origin);
    const path = "/api/tavern/v1/settings/voice-preference";

    // The never-configured record has no persona.
    const initial = (await (await read(origin, path, session)).json()) as { revision: number; persona: string | null };
    assert.equal(initial.revision, 0);
    assert.equal(initial.persona, null);

    // Selecting a persona rides the existing consent operation: no new route,
    // one revision-checked mutation of the same one record.
    const chosen = await write(origin, path, session, {
      expectedRevision: 0,
      action: "setPersona",
      persona: "soft_maid",
    });
    assert.equal(chosen.status, 200);
    const afterChoice = (await chosen.json()) as { revision: number; persona: string | null; consent: string };
    assert.equal(afterChoice.revision, 1);
    assert.equal(afterChoice.persona, "soft_maid");
    // Picking a persona is not a consent decision.
    assert.equal(afterChoice.consent, "undecided");

    // The authoritative read-back carries it, and the shared record's revision
    // moved for the language surface too.
    const reread = (await (await read(origin, path, session)).json()) as { revision: number; persona: string | null };
    assert.equal(reread.persona, "soft_maid");
    const language = (await (await read(origin, "/api/tavern/v1/settings/language", session)).json()) as {
      revision: number;
      locale: string | null;
    };
    assert.equal(language.revision, reread.revision);

    // A stale revision is a conflict, not a silent overwrite, and it mutates nothing.
    const stale = await write(origin, path, session, {
      expectedRevision: 0,
      action: "setPersona",
      persona: "gentle_maid",
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code: string }).code, "settings_revision_conflict");
    const unchanged = (await (await read(origin, path, session)).json()) as { persona: string | null };
    assert.equal(unchanged.persona, "soft_maid");

    // A persona outside the bounded shape fails closed at the wire.
    const invalid = await write(origin, path, session, {
      expectedRevision: 1,
      action: "setPersona",
      persona: "SoftMaid",
    });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { code: string }).code, "invalid_request");

    // Clearing the selection is the null form of the same action.
    const cleared = await write(origin, path, session, {
      expectedRevision: 1,
      action: "setPersona",
      persona: null,
    });
    assert.equal(cleared.status, 200);
    const afterClear = (await cleared.json()) as { revision: number; persona: string | null };
    assert.equal(afterClear.revision, 2);
    assert.equal(afterClear.persona, null);
  });
});

/**
 * The appearance route pair, over the real handler and the real durable record.
 *
 * The three things this pins that nothing else can: the surface is a browser-session read and a
 * CSRF-bound write (a write without the header is refused before the store sees it); a stale
 * `expectedRevision` is a conflict rather than a silent overwrite of the language group beside it;
 * and the reply IS the record's read-back, so the page can paint the answer instead of the request.
 */
test("the appearance is read and written over its own CSRF-bound route, through the one record", async () => {
  await withServer(async (origin) => {
    const session = await bootstrap(origin);

    const before = await (await read(origin, "/api/tavern/v1/settings/appearance", session)).json();
    assert.deepEqual(before, { revision: 0, appearance: "system" });
    assert.deepEqual(Object.keys(before).sort(), ["appearance", "revision"]);

    // A write from another origin, and one without the session's CSRF header, both stop before the store.
    const noOrigin = await fetch(`${origin}/api/tavern/v1/settings/appearance`, {
      method: "PUT",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ expectedRevision: 0, appearance: "light" }),
    });
    assert.equal(noOrigin.status, 401);
    const noCsrf = await fetch(`${origin}/api/tavern/v1/settings/appearance`, {
      method: "PUT",
      headers: { Origin: origin, Cookie: session.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, appearance: "light" }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(
      (await (await read(origin, "/api/tavern/v1/settings/appearance", session)).json()).appearance,
      "system",
    );

    // A value the contract does not declare is refused as an invalid request, not stored.
    const fourth = await write(origin, "/api/tavern/v1/settings/appearance", session, {
      expectedRevision: 0,
      appearance: "sepia",
    });
    assert.equal(fourth.status, 400);

    const written = await write(origin, "/api/tavern/v1/settings/appearance", session, {
      expectedRevision: 0,
      appearance: "light",
    });
    assert.equal(written.status, 200);
    assert.deepEqual(await written.json(), { revision: 1, appearance: "light" });
    assert.deepEqual(await (await read(origin, "/api/tavern/v1/settings/appearance", session)).json(), {
      revision: 1,
      appearance: "light",
    });

    // The same record: the language group reads the revision the appearance write produced, and a
    // stale appearance write from a tab that never saw it is a conflict rather than a clobber.
    assert.deepEqual(await (await read(origin, "/api/tavern/v1/settings/language", session)).json(), {
      revision: 1,
      locale: null,
    });
    const stale = await write(origin, "/api/tavern/v1/settings/appearance", session, {
      expectedRevision: 0,
      appearance: "dark",
    });
    assert.equal(stale.status, 409);
    assert.equal(
      (await (await read(origin, "/api/tavern/v1/settings/appearance", session)).json()).appearance,
      "light",
    );
  });
});

/**
 * The interface-language route pair, over the real handler and the real durable record.
 *
 * This is the layer the defect was in: the choice used to live in this browser's `localStorage`, and
 * the Desktop serves the shell from an ephemeral `127.0.0.1` origin, so every launch was a fresh store
 * and the interface language reset. The three things this pins:
 *
 *  - the surface is a browser-session read and a CSRF-bound write (a write from another origin, or one
 *    without the session's own header, is refused before the store sees it);
 *  - the value set is CLOSED: a language no catalogue ships is an invalid request, never stored - and
 *    the companion language's own open BCP-47 tag is not accepted here either, because the two are
 *    separate choices;
 *  - the reply IS the record's read-back, and a stale `expectedRevision` is a conflict rather than a
 *    silent overwrite of the appearance group beside it in the same record.
 */
test("the interface language is read and written over its own CSRF-bound route, through the one record", async () => {
  await withServer(async (origin) => {
    const session = await bootstrap(origin);

    const before = await (await read(origin, "/api/tavern/v1/settings/ui-language", session)).json();
    assert.deepEqual(before, { revision: 0, locale: null });
    assert.deepEqual(Object.keys(before).sort(), ["locale", "revision"]);

    // A write from another origin, and one without the session's CSRF header, both stop before the store.
    const noOrigin = await fetch(`${origin}/api/tavern/v1/settings/ui-language`, {
      method: "PUT",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ expectedRevision: 0, locale: "en" }),
    });
    assert.equal(noOrigin.status, 401);
    const noCsrf = await fetch(`${origin}/api/tavern/v1/settings/ui-language`, {
      method: "PUT",
      headers: { Origin: origin, Cookie: session.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, locale: "en" }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await (await read(origin, "/api/tavern/v1/settings/ui-language", session)).json()).locale, null);

    // A language no catalogue ships is refused, and so is the companion language's own open tag: this
    // route stores a UI language, not "some BCP-47 string".
    for (const refused of ["ja-JP", "sepia", "zh"]) {
      const invalid = await write(origin, "/api/tavern/v1/settings/ui-language", session, {
        expectedRevision: 0,
        locale: refused,
      });
      assert.equal(invalid.status, 400, `${refused} is not a UI language this product ships`);
    }

    const written = await write(origin, "/api/tavern/v1/settings/ui-language", session, {
      expectedRevision: 0,
      locale: "en",
    });
    assert.equal(written.status, 200);
    assert.deepEqual(await written.json(), { revision: 1, locale: "en" });
    assert.deepEqual(await (await read(origin, "/api/tavern/v1/settings/ui-language", session)).json(), {
      revision: 1,
      locale: "en",
    });

    // The same record: the companion language group reads the revision this write produced, and its own
    // value is untouched - the interface language never rewrites what she speaks.
    assert.deepEqual(await (await read(origin, "/api/tavern/v1/settings/language", session)).json(), {
      revision: 1,
      locale: null,
    });
    const companion = await write(origin, "/api/tavern/v1/settings/language", session, {
      expectedRevision: 1,
      locale: "zh-CN",
    });
    assert.equal(companion.status, 200);
    assert.deepEqual(await (await read(origin, "/api/tavern/v1/settings/ui-language", session)).json(), {
      revision: 2,
      locale: "en",
    });

    // A stale write from a tab that never saw those revisions is a conflict, not a clobber.
    const stale = await write(origin, "/api/tavern/v1/settings/ui-language", session, {
      expectedRevision: 0,
      locale: "zh-CN",
    });
    assert.equal(stale.status, 409);
    assert.equal((await (await read(origin, "/api/tavern/v1/settings/ui-language", session)).json()).locale, "en");
  });
});
