import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { identityKey } from "./runtime.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { pngCardFile, pngCardFileWithoutImage, pngPictureFile } from "./test-support/png-card.test-support.js";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import { composeTavernProfile, type StCardImportStageResultV1 } from "./tavern/browser-contract/index.js";
import { createChatThreadStore } from "./tavern/chat-thread-store.js";
import { companionAvatarPath } from "./tavern/companion-avatar/index.js";
import { provisionNewCompanion } from "./tavern/new-companion-service.js";
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
