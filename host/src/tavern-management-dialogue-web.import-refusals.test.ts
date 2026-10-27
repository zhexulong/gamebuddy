import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import type { PlayerPreferenceUpdate } from "./settings/player-preference-store.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import {
  composeTavernProfile,
  type StCardImportReadResultV1,
  type StCardImportStageResultV1,
} from "./tavern/browser-contract/index.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import { StCardImportService } from "./tavern/st-card-import-service.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import { resolveTavernPaths, tavernImportPath } from "./tavern/tavern-paths.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import { startTavernManagementDialogueWebServer } from "./tavern-management-dialogue-web.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

/**
 * Which answer each reviewed-card import route gives, and to whom it gives it.
 *
 * The three routes below read, review and confirm a staged card. Each of them can
 * refuse because of the request (the handle names no import, the review names a
 * field the candidate does not carry, the confirm has no review to provision) and
 * each can fail because of the Host (a store that failed, a runtime that is not
 * there). The first is the player's to act on and says which one it is; the second
 * is GameBuddy's own failure and says so. A route that reports the second as the
 * first hands the player a detailed accusation of fields they never sent, and the
 * cause is gone - so every case here is asserted as a pair.
 */

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const identity = Object.freeze({
  playerId: "player-import-refusals",
  companionId: "companion-import-refusals",
  continuityId: "continuity-import-refusals",
});

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

const profile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...IMPORT_ROUTES],
  operationIds: [...CORE_OPERATIONS, ...IMPORT_ROUTES],
  navigationItemIds: ["chat", "characters"],
});

const card = JSON.stringify({
  spec: "chara_card_v3",
  data: { name: "Nova", description: "A quiet astronomer." },
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

const playerPreferenceStore = Object.freeze({
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
    };
  },
  async update(_expectedRevision: number, _update: PlayerPreferenceUpdate) {
    return {
      revision: 1,
      locale: null,
      disclosureVersion: null,
      consent: "revoked" as const,
      decidedAtMs: 1,
      outputDevice: null,
      persona: null,
      paced: false,
      gamePromptAddition: "",
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

/**
 * A failure injected into the exact service call a route makes. The message is the
 * one an adapter below the route raises for that failure, so the route is exercised
 * with the vocabulary it really meets instead of a synthetic token.
 */
type InjectedFailures = Readonly<{ import?: Error; read?: Error; recordReview?: Error; confirm?: Error }>;

async function mount(root: string, injected: InjectedFailures = {}) {
  const paths = resolveTavernPaths({ root } as never, identity);
  const service = new StCardImportService(new TavernArtifactStore(root), paths);
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: managementService(),
    worldInfoService: worldInfoService(),
    playerPreferenceStore,
    stCardImportService: Object.freeze({
      import: (importId: string, input: string | Uint8Array) =>
        injected.import === undefined ? service.import(importId, input) : Promise.reject(injected.import),
      read: (importId: string) =>
        injected.read === undefined ? service.read(importId) : Promise.reject(injected.read),
      recordReview: (importId: string, input: Readonly<{ reviewedFields: readonly string[]; approvedAtMs: number }>) =>
        injected.recordReview === undefined
          ? service.recordReview(importId, input)
          : Promise.reject(injected.recordReview),
      readReview: (importId: string) => service.readReview(importId),
    }),
    confirmStCardImport: async (importId: string) => {
      if (injected.confirm !== undefined) throw injected.confirm;
      // The composition's own glue refuses before it provisions anything: this is
      // the read it does first, reproduced so the refusal under test is its own.
      await service.confirmedReview(importId);
      return Object.freeze({ name: "Nova" });
    },
    stCardImportHistoryService: Object.freeze({ list: async () => [] }),
    profile,
    bootstrapToken: token,
  });
  return Object.freeze({ server, service, paths });
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

function post(
  origin: string,
  path: string,
  session: Readonly<{ csrfToken: string; cookie: string }>,
  body: unknown,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: session.cookie,
      "Content-Type": "application/json",
      "x-csrf-token": session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

function get(origin: string, path: string, session: Readonly<{ cookie: string }>): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { Origin: origin, Cookie: session.cookie, "Sec-Fetch-Site": "same-origin" },
  });
}

/** The refusal the browser classifies on: its status and its bounded code. */
async function refusal(response: Response): Promise<Readonly<{ status: number; code: string }>> {
  const text = await response.text();
  const body = JSON.parse(text) as { code?: unknown };
  return Object.freeze({ status: response.status, code: typeof body.code === "string" ? body.code : "" });
}

async function stageCard(origin: string, session: Readonly<{ csrfToken: string; cookie: string }>): Promise<string> {
  const response = await post(origin, "/api/tavern/v1/imports", session, {
    apiVersion: 1,
    cardSource: "json",
    card,
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as StCardImportStageResultV1).importId;
}

test("import.stage: a card the decoder rejects is the file's refusal, a write that failed is not", async () => {
  const root = await canonicalTestRoot("tavern-import-stage-refusals-");
  const fixture = await mount(root);
  const failing = await mount(root, { import: new Error("tavern_artifact_storage_unavailable") });
  try {
    const session = await bootstrap(fixture.server.origin);
    // A payload that is not a character card: the one refusal here about the file picked.
    const refused = await post(fixture.server.origin, "/api/tavern/v1/imports", session, {
      apiVersion: 1,
      cardSource: "json",
      card: "{not-json",
    });
    assert.deepEqual(await refusal(refused), { status: 422, code: "st_card_import_rejected" });

    // The same request against a store that failed behind the decode: the file was fine,
    // so nothing here may tell the player it was not a card.
    const failed = await post(failing.server.origin, "/api/tavern/v1/imports", await bootstrap(failing.server.origin), {
      apiVersion: 1,
      cardSource: "json",
      card,
    });
    assert.deepEqual(await refusal(failed), { status: 503, code: "storage_unavailable" });
  } finally {
    await fixture.server.close();
    await failing.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("import.read: an id that stages nothing is the not-found refusal", async () => {
  const root = await canonicalTestRoot("tavern-import-read-not-found-");
  const fixture = await mount(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await stageCard(origin, session);
    // The staged import still reads - so the refusal below is about the id, not the route -
    // and an import nobody has reviewed yet says exactly that instead of failing.
    const unreviewed = await get(origin, `/api/tavern/v1/imports/${staged}`, session);
    const unreviewedBody = await unreviewed.text();
    assert.equal(unreviewed.status, 200, unreviewedBody);
    const readBody = JSON.parse(unreviewedBody) as StCardImportReadResultV1;
    assert.equal(readBody.reviewed, false);
    assert.deepEqual(readBody.reviewedFields, []);

    const namesNothing = await get(origin, `/api/tavern/v1/imports/${"Z".repeat(43)}`, session);
    assert.deepEqual(await refusal(namesNothing), { status: 404, code: "character_import_not_found" });
  } finally {
    await fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("import.read: a staged record that will not read back is the Host's failure, not a missing import", async () => {
  const root = await canonicalTestRoot("tavern-import-read-damaged-");
  const fixture = await mount(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await stageCard(origin, session);
    // A record that EXISTS and is damaged: the player's next step is not "choose
    // again", so nothing here may be answered as a handle that names nothing.
    await writeFile(tavernImportPath(fixture.paths, staged, "candidate.json"), "{ not the record\n", "utf8");

    const damaged = await get(origin, `/api/tavern/v1/imports/${staged}`, session);
    assert.deepEqual(await refusal(damaged), { status: 503, code: "companion_record_unreadable" });
  } finally {
    await fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("import.read: a review record that will not read back is the Host's failure", async () => {
  const root = await canonicalTestRoot("tavern-import-read-review-damaged-");
  const fixture = await mount(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await stageCard(origin, session);
    const reviewed = await post(origin, `/api/tavern/v1/imports/${staged}/review`, session, {
      apiVersion: 1,
      reviewedFields: ["name"],
      approvedAtMs: 1,
    });
    assert.equal(reviewed.status, 200, await reviewed.text());
    // A review that EXISTS and is damaged is not "not reviewed yet": reporting that state
    // would invite the player to review again over a record the Host cannot read.
    await writeFile(
      tavernImportPath(fixture.paths, staged, "candidate.json").replace(/candidate\.json$/u, "review.json"),
      "{ not the record\n",
      "utf8",
    );
    const damaged = await get(origin, `/api/tavern/v1/imports/${staged}`, session);
    assert.deepEqual(await refusal(damaged), { status: 503, code: "companion_record_unreadable" });
  } finally {
    await fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("import.read: a store that failed is the Host's own failure", async () => {
  const root = await canonicalTestRoot("tavern-import-read-outage-");
  const fixture = await mount(root, { read: new Error("tavern_artifact_storage_unavailable") });
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const response = await get(origin, `/api/tavern/v1/imports/${"Z".repeat(43)}`, session);
    assert.deepEqual(await refusal(response), { status: 503, code: "storage_unavailable" });
  } finally {
    await fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("import.review: a field the candidate does not carry is the request refusal", async () => {
  const root = await canonicalTestRoot("tavern-import-review-refused-");
  const fixture = await mount(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await stageCard(origin, session);
    // `creators_notes` is not one of the candidate's own fields, so the review has
    // nothing to record it against: that is the player's request being refused.
    const response = await post(origin, `/api/tavern/v1/imports/${staged}/review`, session, {
      apiVersion: 1,
      reviewedFields: ["creators_notes"],
      approvedAtMs: 1,
    });
    assert.deepEqual(await refusal(response), { status: 409, code: "character_import_review_invalid" });
  } finally {
    await fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("import.review: a store that failed is the Host's own failure, not a refused review", async () => {
  const root = await canonicalTestRoot("tavern-import-review-outage-");
  const fixture = await mount(root, { recordReview: new Error("tavern_artifact_storage_unavailable") });
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await stageCard(origin, session);
    const response = await post(origin, `/api/tavern/v1/imports/${staged}/review`, session, {
      apiVersion: 1,
      reviewedFields: ["name"],
      approvedAtMs: 1,
    });
    assert.deepEqual(await refusal(response), { status: 503, code: "storage_unavailable" });
  } finally {
    await fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("import.confirm: an import that was never reviewed is the confirm refusal", async () => {
  const root = await canonicalTestRoot("tavern-import-confirm-unreviewed-");
  const fixture = await mount(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await stageCard(origin, session);
    const response = await post(origin, `/api/tavern/v1/imports/${staged}/confirm`, session, { apiVersion: 1 });
    assert.deepEqual(await refusal(response), { status: 409, code: "character_import_confirm_invalid" });
  } finally {
    await fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("import.confirm: a provision that failed behind a valid review is the Host's own failure", async () => {
  const root = await canonicalTestRoot("tavern-import-confirm-outage-");
  const fixture = await mount(root, { confirm: new Error("character_import_service_unavailable") });
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await stageCard(origin, session);
    await post(origin, `/api/tavern/v1/imports/${staged}/review`, session, {
      apiVersion: 1,
      reviewedFields: ["name"],
      approvedAtMs: 1,
    });
    const response = await post(origin, `/api/tavern/v1/imports/${staged}/confirm`, session, { apiVersion: 1 });
    assert.deepEqual(await refusal(response), { status: 503, code: "runtime_unavailable" });
  } finally {
    await fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
