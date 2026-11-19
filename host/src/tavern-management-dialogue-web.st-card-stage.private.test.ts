import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { identityKey } from "./runtime.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { pngCardFile, pngCardFileWithoutImage, pngPictureFile } from "./test-support/png-card.test-support.js";
import type { WorldBookEntry } from "./worldbook.js";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import { composeTavernProfile, type StCardImportStageResultV1 } from "./tavern/browser-contract/index.js";
import { createChatThreadStore } from "./tavern/chat-thread-store.js";
import { companionAvatarPath } from "./tavern/companion-avatar/index.js";
import { type CompanionCardRecords, exportCompanionCard } from "./tavern/companion-card-export.js";
import { createCompanionCardExportService } from "./tavern/companion-card-export-service.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { provisionNewCompanion } from "./tavern/new-companion-service.js";
import { writeCompanionCardPng } from "./tavern/png-card-writer.js";
import { StCardImportService } from "./tavern/st-card-import-service.js";
import { resolveTavernPaths } from "./tavern/tavern-paths.js";
import { startTavernManagementDialogueWebServer } from "./tavern-management-dialogue-web.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

const IMPORT_ROUTES = [
  "character.import.stage",
  "character.import.read",
  "character.import.review",
  "character.import.confirm",
  "character.import.history",
] as const;

const profile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...IMPORT_ROUTES],
  operationIds: [...CORE_OPERATIONS, ...IMPORT_ROUTES],
  navigationItemIds: ["chat", "characters"],
});

const identity = Object.freeze({
  playerId: "player-stage",
  companionId: "companion-stage",
  continuityId: "continuity-stage",
});

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

/** The response's body, once, with the status asserted against that same text. */
async function ok<T>(response: Response): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as T;
}

async function stagePng(
  origin: string,
  session: Readonly<{ csrfToken: string; cookie: string }>,
  file: Uint8Array,
): Promise<Response> {
  return await post(origin, "/api/tavern/v1/imports", session, {
    apiVersion: 1,
    cardSource: "png",
    cardFileBase64: Buffer.from(file).toString("base64"),
  });
}

/**
 * The reviewed-card import through the real dispatcher, the real staging service
 * and the real provisioner: the only thing a stub stands in for is the
 * composition owner's own `confirmStCardImport` glue, which is reproduced here
 * line for line so the chain under test is the production one.
 */
async function stageFixmounted(root: string) {
  const paths = resolveTavernPaths({ root } as never, identity);
  const store = new TavernArtifactStore(root);
  const service = new StCardImportService(store, paths);
  const threads = createChatThreadStore(root, identityKey(identity));
  /** The identity each confirm provisioned, in order: the composition owner's own glue returns only the name. */
  const provisioned: Array<Readonly<{ companionId: string; continuityId: string }>> = [];
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: Object.freeze({
      read: async () => ({
        selection: { chatHandle: handle, generation: 1, stateRevision: handle },
        companionDisplayName: "Mira",
        companionHandle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA",
        title: "Farm Chat",
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
    stCardImportService: service,
    worldInfoService: Object.freeze({
      async read() {
        return { state: "none" as const, revision: handle, items: [] };
      },
      async setBinding() {
        return { state: "none" as const, revision: handle, items: [] };
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
          appearance: "system" as const,
        };
      },
    }),
    stCardImportHistoryService: Object.freeze({ list: async () => [] }),
    confirmStCardImport: async (importId: string) => {
      const imported = await service.read(importId);
      const review = await service.confirmedReview(importId);
      const provision = await provisionNewCompanion(
        root,
        identity.playerId,
        imported.candidate.artifact,
        review,
        threads,
        await service.stagedAvatar(importId),
      );
      provisioned.push(
        Object.freeze({ companionId: provision.identity.companionId, continuityId: provision.identity.continuityId! }),
      );
      return Object.freeze({ name: provision.companion.name });
    },
    profile,
    bootstrapToken: token,
  });
  return Object.freeze({ server, service, store, threads, provisioned });
}

const novaCard = JSON.stringify({
  spec: "chara_card_v3",
  data: { name: "Nova", description: "A quiet astronomer." },
});

test("a PNG card's fields and its picture both come from the bytes the Host itself read", async () => {
  const root = await canonicalTestRoot("tavern-st-card-stage-");
  const fixture = await stageFixmounted(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const picture = pngCardFile(novaCard);

    const stagedBody = await ok<StCardImportStageResultV1>(await stagePng(origin, session, picture));
    // Every one of these came out of the Host's own decoder reading the PNG
    // bytes on the wire. The browser never sent a field name: it sent a file.
    assert.equal(stagedBody.name, "Nova");
    assert.deepEqual(
      stagedBody.fields.map((field) => field.field),
      ["name", "identity_role", "continuity", "persona_core"],
    );

    // The picture is staged beside the candidate, byte for byte.
    const stagedAvatar = await fixture.service.stagedAvatar(stagedBody.importId);
    assert.deepEqual(stagedAvatar === undefined ? undefined : Buffer.from(stagedAvatar), Buffer.from(picture));

    // A JSON card takes the other arm and stages no picture at all.
    const jsonBody = await ok<StCardImportStageResultV1>(
      await post(origin, "/api/tavern/v1/imports", session, {
        apiVersion: 1,
        cardSource: "json",
        card: novaCard,
      }),
    );
    assert.equal(await fixture.service.stagedAvatar(jsonBody.importId), undefined);
    assert.deepEqual(
      jsonBody.fields.map((field) => field.field),
      stagedBody.fields.map((field) => field.field),
    );
  } finally {
    await fixture.server.close();
    fixture.threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("the stage route forwards the closing direction's own loss, naming the macros that will cost it", async () => {
  // End to end on purpose: the decoder records the loss, the route mirror copies it, and the wire
  // schema accepts it. A member dropped in any of the three leaves the player reading "her closing
  // direction is missing" with nothing to search the card for.
  const root = await canonicalTestRoot("tavern-st-card-stage-loss-");
  const fixture = await stageFixmounted(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await ok<StCardImportStageResultV1>(
      await post(origin, "/api/tavern/v1/imports", session, {
        apiVersion: 1,
        cardSource: "json",
        card: JSON.stringify({
          spec: "chara_card_v3",
          data: { name: "Rin", description: "calm", post_history_instructions: "Close as {{time}} says." },
        }),
      }),
    );
    const loss = staged.losses?.find((entry) => entry.reason === "unrenderable_post_history_instructions");
    assert.equal(loss?.field, "post_history_instructions");
    assert.equal(loss?.count, 1);
    // The macros the player has to edit out, by name: the record itself is stored verbatim.
    assert.deepEqual(loss?.macros, [{ token: "{{time}}", standard: true }]);
    // A field-level row carries no entry title, because a field has none.
    assert.equal(Object.hasOwn(loss ?? {}, "omitted"), false);
  } finally {
    await fixture.server.close();
    fixture.threads.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("confirm provisions the companion and writes her picture where the avatar face reads it", async () => {
  const root = await canonicalTestRoot("tavern-st-card-confirm-");
  const fixture = await stageFixmounted(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const picture = pngCardFile(novaCard);
    const importId = (await ok<StCardImportStageResultV1>(await stagePng(origin, session, picture))).importId;

    await ok(
      await post(origin, `/api/tavern/v1/imports/${importId}/review`, session, {
        apiVersion: 1,
        reviewedFields: ["name", "persona_core"],
        approvedAtMs: 1,
      }),
    );
    const confirmed = await ok<{ name: string }>(
      await post(origin, `/api/tavern/v1/imports/${importId}/confirm`, session, { apiVersion: 1 }),
    );
    assert.equal(confirmed.name, "Nova");

    // The confirmed companion's own root holds exactly the picture the player
    // picked, at the one path the runtime avatar face reads.
    assert.equal(fixture.provisioned.length, 1);
    const herPicture = await readFile(companionAvatarPath(root, identity.playerId, fixture.provisioned[0]!));
    assert.deepEqual(herPicture, Buffer.from(picture));
  } finally {
    await fixture.server.close();
    fixture.threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a PNG whose image is not a picture is imported without it, and the report says so", async () => {
  const root = await canonicalTestRoot("tavern-st-card-avatar-drop-");
  const fixture = await stageFixmounted(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const cardWithBrokenImage = pngCardFileWithoutImage(novaCard);
    const stagedBody = await ok<StCardImportStageResultV1>(await stagePng(origin, session, cardWithBrokenImage));
    // The card is importable - the Host's decoder found its chunk - and the
    // picture is not, which the player-visible result says rather than leaving a
    // silently picture-less companion behind.
    assert.equal(stagedBody.name, "Nova");
    assert.ok(
      stagedBody.dispositions.some(
        (disposition) =>
          disposition.field === "avatar" &&
          disposition.classification === "dropped_unsupported" &&
          disposition.reason === "avatar_malformed",
      ),
      JSON.stringify(stagedBody.dispositions),
    );
    assert.equal(await fixture.service.stagedAvatar(stagedBody.importId), undefined);
  } finally {
    await fixture.server.close();
    fixture.threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("the stage route refuses a non-canonical payload, a cardless PNG and a bare picture", async () => {
  const root = await canonicalTestRoot("tavern-st-card-stage-refusals-");
  const fixture = await stageFixmounted(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const encoded = Buffer.from(pngCardFile(novaCard)).toString("base64");

    // Base64 that does not re-encode to itself is not the file the player picked:
    // `Buffer.from(..., "base64")` would silently drop the stray characters and
    // import a different, shorter file.
    const nonCanonical = await post(origin, "/api/tavern/v1/imports", session, {
      apiVersion: 1,
      cardSource: "png",
      cardFileBase64: `${encoded}!!!`,
    });
    assert.equal(nonCanonical.status, 400);

    // An unpadded/whitespace payload is refused the same way.
    const padded = await post(origin, "/api/tavern/v1/imports", session, {
      apiVersion: 1,
      cardSource: "png",
      cardFileBase64: `${encoded.slice(0, 8)} ${encoded.slice(8)}`,
    });
    assert.equal(padded.status, 400);

    // Neither arm may carry the other's field: the union is strict.
    const mixed = await post(origin, "/api/tavern/v1/imports", session, {
      apiVersion: 1,
      cardSource: "json",
      card: novaCard,
      cardFileBase64: encoded,
    });
    assert.equal(mixed.status, 400);

    // A picture with no card chunk is refused by name, exactly as a cardless
    // `.json` is.
    const cardless = await post(origin, "/api/tavern/v1/imports", session, {
      apiVersion: 1,
      cardSource: "png",
      cardFileBase64: Buffer.from(pngPictureFile()).toString("base64"),
    });
    assert.equal(cardless.status, 422);
    assert.equal(((await cardless.json()) as { code: string }).code, "st_card_import_rejected");
  } finally {
    await fixture.server.close();
    fixture.threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a staged card that is abandoned leaves nothing in any companion's own root", async () => {
  const root = await canonicalTestRoot("tavern-st-card-abandoned-");
  const fixture = await stageFixmounted(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await stagePng(origin, session, pngCardFile(novaCard));
    assert.equal(staged.status, 200, await staged.text());
    // Staging is not provisioning: nothing exists under the tavern's companion
    // roots at all, because a companion namespace is created by confirm and only
    // by confirm.
    await assert.rejects(
      access(join(resolveTavernPaths({ root } as never, identity).root, "companions")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  } finally {
    await fixture.server.close();
    fixture.threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Her records as the export builder takes them: the shipped companion's own profile, opening set,
 * scenario and world book (`DEFAULT_COMPANION_PRESET`, so the population grows with her), one entry
 * that carries EVERY optional world-book key the card format has, and the author fields this product
 * keeps without interpreting.
 */
function shippedCompanionRecords(): CompanionCardRecords {
  const preset = DEFAULT_COMPANION_PRESET;
  return {
    name: preset.profile.identity.name,
    ...(preset.profile.persona === undefined ? {} : { persona: preset.profile.persona }),
    ...(preset.profile.examples === undefined ? {} : { examples: preset.profile.examples }),
    ...(preset.profile.characterVoice === undefined ? {} : { characterVoice: preset.profile.characterVoice }),
    ...(preset.scenario === undefined ? {} : { scenario: preset.scenario }),
    openings: preset.greetings.map((greeting) => Object.freeze({ text: greeting.text })),
    worldBook: Object.freeze({
      ...preset.worldBook,
      entries: Object.freeze([...preset.worldBook.entries, SECONDARY_GATED_ENTRY]),
    }),
    ...(preset.postHistoryInstructions === undefined
      ? {}
      : { postHistoryInstructions: preset.postHistoryInstructions }),
    preservedFields: Object.freeze({
      creator: "gamebuddy",
      character_version: "1.0.0",
      tags: Object.freeze(["星露谷", "农场搭档"]),
    }),
    extensions: Object.freeze({ talkativeness: "0.5", inCharactersFavorites: false }),
  };
}

/** The one entry in her book that carries every optional key: the ones a round trip loses silently. */
const SECONDARY_GATED_ENTRY: WorldBookEntry = Object.freeze({
  entryId: "wb-entry-secondary",
  title: "只在说到镇上时补充",
  content: "提到了酒吧，并且已经聊到镇上的时候，她才补充这一条。",
  scope: "setting",
  provenance: "authored",
  tokenBudget: "small",
  keys: ["酒吧"],
  secondaryKeys: ["镇上"],
  selectiveLogic: 0,
  constant: false,
  enabled: false,
});

/**
 * A book entry's card-relevant facts, normalized the way the FORMAT defines them: an absent `keys`,
 * `secondaryKeys`, `constant` or `enabled` is the spec's own default (`none`, `none`, `false`,
 * enabled), so a durable entry and the entry the import reads back are comparable without pinning
 * which spelling of "off" a record happens to use.
 */
function bookEntryFacts(entry: WorldBookEntry) {
  return {
    title: entry.title,
    content: entry.content,
    keys: entry.keys ?? [],
    secondaryKeys: entry.secondaryKeys ?? [],
    selectiveLogic: entry.selectiveLogic ?? null,
    constant: entry.constant === true,
    enabled: entry.enabled !== false,
  };
}

/**
 * A companion's own card, given back to the route that will read it.
 *
 * Driver R's real run exported 琥珀's PNG card (`status=200`, 29,655 bytes, chunks
 * `IHDR/tEXt/IDAT/IEND`, a 15,044-character `chara` chunk) and then handed that exact file to the
 * surface's own picker, which answered `{"state":"error","text":"无法导入该角色卡。"}` with no review
 * and no companion. The decoder kept the card; the STAGE ROUTE refused the projection of it, because
 * the player-readable field rows are derived from the card (`st-card-import-service.ts`,
 * `candidateFromReport`) and the wire schema capped them at a hand-written 32
 * (`browser-contract/index.ts`, `StCardImportStageResultV1Schema.fields`). The shipped companion
 * produces 39 rows before this test adds its own, so her own card was unreadable by the Host that
 * wrote it.
 *
 * Every assertion below is a field the import accepts, compared with the card the export wrote - the
 * lossless round trip AGENTS.md names. A field that survives export but is dropped on import is the
 * defect even when the import "succeeds".
 */
test("the card the Host exports from a companion is staged by the route that will read it", async () => {
  const root = await canonicalTestRoot("tavern-st-card-round-trip-");
  const fixture = await stageFixmounted(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const records = shippedCompanionRecords();
    const exported = exportCompanionCard(records);
    // The PNG arm as the player saves it: a picture with the card inside its one `tEXt` chunk.
    const cardFile = writeCompanionCardPng(pngPictureFile(), exported.card);
    const card = JSON.parse(exported.card) as { readonly data: Readonly<Record<string, unknown>> };

    const staged = await ok<StCardImportStageResultV1>(await stagePng(origin, session, cardFile));
    assert.equal(staged.name, records.name);

    const rows = staged.fields.map((field) => field.field);
    const worldBookRows = rows.filter((row) => row.startsWith("worldbook_"));
    assert.deepEqual(
      rows.filter((row) => !row.startsWith("worldbook_")),
      [
        "name",
        "identity_role",
        "continuity",
        ...(records.scenario === undefined ? [] : ["scenario"]),
        "system_prompt",
        "persona_core",
        "persona_interaction_style",
        ...(records.examples ?? []).map((_, index) => `example_${index + 1}`),
        "first_greeting",
        ...(records.openings ?? []).slice(1).map((_, index) => `alternate_greeting_${index + 1}`),
      ],
    );
    assert.equal(worldBookRows.length, records.worldBook?.entries.length ?? 0);
    // The world-book rows carry the entries' own text, in the book's order.
    assert.deepEqual(
      worldBookRows.map((row) => staged.fields.find((field) => field.field === row)?.chars),
      (records.worldBook?.entries ?? []).map((entry) => entry.content.length),
    );

    // Every accepted field, read back out of the durable candidate the stage wrote.
    const candidate = (await fixture.service.read(staged.importId)).candidate.artifact;
    const fieldText = (field: string): string | undefined => candidate.fields.find((row) => row.field === field)?.text;
    assert.equal(candidate.name, card.data.name);
    assert.equal(fieldText("persona_core"), card.data.description);
    assert.equal(fieldText("persona_interaction_style"), card.data.personality);
    assert.equal(fieldText("scenario"), card.data.scenario);
    assert.equal(fieldText("system_prompt"), card.data.system_prompt);
    assert.equal(fieldText("first_greeting"), card.data.first_mes);
    assert.deepEqual(
      rows.filter((row) => row.startsWith("alternate_greeting_")).map((row) => fieldText(row)),
      card.data.alternate_greetings ?? [],
    );
    assert.deepEqual(
      rows.filter((row) => row.startsWith("example_")).map((row) => JSON.parse(fieldText(row) ?? "null")),
      records.examples,
    );
    assert.equal(candidate.postHistoryInstructions, card.data.post_history_instructions);
    assert.deepEqual(candidate.extensions, records.extensions);
    assert.deepEqual(candidate.preservedFields, records.preservedFields);
    assert.equal(candidate.worldBookScanDepth, records.worldBook?.scanDepth);
    assert.deepEqual(
      (candidate.worldBookCandidates ?? []).map(bookEntryFacts),
      (records.worldBook?.entries ?? []).map(bookEntryFacts),
    );

    // The review the surface records covers exactly the fields the Host marked eligible - for this
    // companion that is more rows than the old hand-written cap, which refused her here too.
    const kept = staged.fields
      .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
      .map((field) => field.field);
    const reviewed = await ok<Readonly<{ reviewedFields: readonly string[] }>>(
      await post(origin, `/api/tavern/v1/imports/${staged.importId}/review`, session, {
        apiVersion: 1,
        reviewedFields: kept,
        approvedAtMs: 1,
      }),
    );
    assert.deepEqual(reviewed.reviewedFields, kept);
  } finally {
    await fixture.server.close();
    fixture.threads.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * The other direction: the companion a card provisions exports a card that stages the same way.
 *
 * A card that came in through the import and went out through the export is the same card, so the
 * second stage sees the same rows and the same opening. This is where a card-shaped record that lost
 * a field on the way IN shows up: the export can only write what provisioning kept.
 */
test("the companion a card provisions exports a card the same route stages again", async () => {
  const root = await canonicalTestRoot("tavern-st-card-re-export-");
  const fixture = await stageFixmounted(root);
  try {
    const origin = fixture.server.origin;
    const session = await bootstrap(origin);
    const staged = await ok<StCardImportStageResultV1>(
      await stagePng(
        origin,
        session,
        writeCompanionCardPng(pngPictureFile(), exportCompanionCard(shippedCompanionRecords()).card),
      ),
    );
    await ok(
      await post(origin, `/api/tavern/v1/imports/${staged.importId}/review`, session, {
        apiVersion: 1,
        reviewedFields: staged.fields
          .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
          .map((field) => field.field),
        approvedAtMs: 1,
      }),
    );
    await ok(await post(origin, `/api/tavern/v1/imports/${staged.importId}/confirm`, session, { apiVersion: 1 }));
    const provisioned = fixture.provisioned[0];
    assert.ok(provisioned !== undefined, "the confirm provisioned a companion");

    const again = await createCompanionCardExportService({
      store: new TavernArtifactStore(root),
      runtimeRoot: root,
      playerId: identity.playerId,
      resolveCompanion: async () =>
        Object.freeze({ companionId: provisioned.companionId, continuityId: provisioned.continuityId, name: null }),
    }).read(handle, "json");
    assert.ok(again !== null && again.format === "json", "her card exports");
    const reStaged = await ok<StCardImportStageResultV1>(
      await post(origin, "/api/tavern/v1/imports", session, {
        apiVersion: 1,
        cardSource: "json",
        card: again.card,
      }),
    );
    assert.equal(reStaged.name, staged.name);
    assert.deepEqual(
      reStaged.fields.map((field) => field.field),
      staged.fields.map((field) => field.field),
    );
  } finally {
    await fixture.server.close();
    fixture.threads.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
