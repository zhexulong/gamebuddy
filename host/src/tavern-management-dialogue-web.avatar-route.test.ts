/**
 * `companion.avatar.update` through the real dispatcher and the real avatar service.
 *
 * The one write that gives a roster companion a picture, and the family it belongs to:
 * the route is `/api/tavern/v1/companions/:companionHandle/avatar`, resolving ANY
 * companion the roster listed - the same roster-wide addressing the inspector
 * (`companion.profile.read`) and the card export (`companion.card.export`) use, NOT the
 * mounted-only family (`character.voice.*`, `companion.worldbook.*`). The roster and the
 * inspector show every companion, and an upload must not require her to be the mounted
 * one; a card import staged for one companion must not be able to replace another's
 * picture either, which is why the handle is the ONLY thing the request names.
 *
 * Everything under test is real: the dispatcher, the avatar service, the file on disk
 * and the digest. The body is the whole picture, base64, exactly the spelling
 * `character.import.stage` uses for a PNG card.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { pngCardFile, pngPictureFile } from "./test-support/png-card.test-support.js";
import {
  composeTavernProfile,
  type CompanionAvatarV1,
  MAX_COMPANION_AVATAR_BASE64_CHARS,
} from "./tavern/browser-contract/index.js";
import {
  companionAvatarPath,
  createCompanionAvatarService,
  type CompanionAvatarOwner,
} from "./tavern/companion-avatar/index.js";
import {
  createTavernManagementDialogueWebRequestHandler,
  startTavernManagementDialogueWebServer,
} from "./tavern-management-dialogue-web.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const absentHandle = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const unknownHandle = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZA";
const playerId = "player-avatar-route";

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

const AVATAR_ROUTES = ["companion.avatar.update"] as const;

const profile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [...CORE_ROUTES, ...AVATAR_ROUTES],
  operationIds: [...CORE_OPERATIONS, ...AVATAR_ROUTES],
  navigationItemIds: ["chat", "characters"],
});

/** The avatar group on its own, to prove the route's own composition fails closed. */
const hello: CompanionAvatarOwner = Object.freeze({
  companionId: "companion-avatar-route",
  continuityId: "continuity-avatar-route",
});
const empty: CompanionAvatarOwner = Object.freeze({
  companionId: "companion-avatar-route-absent",
  continuityId: "continuity-avatar-route-absent",
});

/** The one reverse map: the handle names exactly the companion it was minted for. */
function avatarServiceFor(root: string): Readonly<{
  service: ReturnType<typeof createCompanionAvatarService>;
  pathOf: (companion: CompanionAvatarOwner) => string;
}> {
  return Object.freeze({
    service: createCompanionAvatarService({
      runtimeRoot: root,
      playerId,
      async resolveCompanion(candidate) {
        if (candidate === handle) return hello;
        if (candidate === absentHandle) return empty;
        return null;
      },
    }),
    pathOf: (companion) => companionAvatarPath(root, playerId, companion),
  });
}

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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

/** One upload of one base64 picture body; `csrf: false` omits the header on purpose. */
function upload(
  origin: string,
  companionHandle: string,
  session: Readonly<{ csrfToken: string; cookie: string }>,
  avatarBase64: string,
  options: Readonly<{ csrf?: boolean; search?: string; method?: string; origin?: string }> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Origin: options.origin ?? origin,
    Cookie: session.cookie,
    "Content-Type": "application/json",
  };
  if (options.csrf !== false) headers["x-csrf-token"] = session.csrfToken;
  return fetch(`${origin}/api/tavern/v1/companions/${companionHandle}/avatar${options.search ?? ""}`, {
    method: options.method ?? "PUT",
    headers,
    body: JSON.stringify({ apiVersion: 1, avatarBase64 }),
  });
}

/** The refusal's own code, read from the bounded problem body. */
async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

/** The mounted management services the avatar route does not use. */
function managementOptions(service: ReturnType<typeof createCompanionAvatarService>) {
  return {
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
    companionAvatarService: service,
    profile,
    bootstrapToken: token,
  };
}

test("companion.avatar.update gives a roster companion a picture, replaces it, and names every refusal", async () => {
  const root = await canonicalTestRoot("tavern-avatar-route-");
  const { service, pathOf } = avatarServiceFor(root);
  const server = await startTavernManagementDialogueWebServer(managementOptions(service));
  try {
    const origin = server.origin;
    const session = await bootstrap(origin);
    const first = pngCardFile(JSON.stringify({ spec: "chara_card_v3", data: { name: "Mira" } }));
    const second = pngPictureFile();

    // No picture yet: an ordinary absence, which the asset face answers with her monogram.
    assert.deepEqual(await service.read(handle), { state: "absent" });

    // The whole picture, base64, and the reply is the Host's own read-back: the digest of
    // the bytes now ON DISK, which is the ETag the asset face publishes for that URL.
    const uploaded = await upload(origin, handle, session, Buffer.from(first).toString("base64"));
    assert.equal(uploaded.status, 200);
    const firstReply = (await uploaded.json()) as CompanionAvatarV1;
    assert.deepEqual(firstReply, { apiVersion: 1, handle, digest: digestOf(first) });
    assert.deepEqual(await readFile(pathOf(hello)), Buffer.from(first));
    assert.deepEqual(await service.read(handle), {
      state: "present",
      bytes: Buffer.from(first),
      digest: digestOf(first),
    });

    // A SECOND, different picture at the same URL. The digest changes with the bytes -
    // that is what makes a browser revalidating this URL be served the new picture.
    const replaced = await upload(origin, handle, session, Buffer.from(second).toString("base64"));
    assert.equal(replaced.status, 200);
    const secondReply = (await replaced.json()) as CompanionAvatarV1;
    assert.equal(secondReply.digest, digestOf(second));
    assert.notEqual(secondReply.digest, firstReply.digest);
    assert.deepEqual(await readFile(pathOf(hello)), Buffer.from(second));

    // A handle the roster never projected names no companion: the route reports that
    // rather than borrowing the mounted companion's identity.
    const unknown = await upload(origin, unknownHandle, session, Buffer.from(second).toString("base64"));
    assert.equal(unknown.status, 404);
    assert.equal(await codeOf(unknown), "companion_not_found");

    // A file that is not a picture, refused by name - and NOTHING changed: the picture she
    // already has is still hers, byte for byte.
    const malformed = await upload(
      origin,
      handle,
      session,
      Buffer.from('{"data":{"name":"Mira"}}', "utf8").toString("base64"),
    );
    assert.equal(malformed.status, 422);
    assert.equal(await codeOf(malformed), "companion_avatar_malformed");
    assert.deepEqual(await readFile(pathOf(hello)), Buffer.from(second));

    // A picture over the avatar module's own ceiling, refused by name, nothing changed.
    // The body is one canonical base64 string at the schema's own ceiling; it decodes to
    // one byte more than the ceiling, which is exactly the file the module will not keep.
    const oversized = await upload(origin, handle, session, "A".repeat(MAX_COMPANION_AVATAR_BASE64_CHARS));
    assert.equal(oversized.status, 413);
    assert.equal(await codeOf(oversized), "companion_avatar_too_large");
    assert.deepEqual(await readFile(pathOf(hello)), Buffer.from(second));

    // Base64 that is not canonical would decode to a different, shorter file, so it is
    // refused before the service sees it.
    const notCanonical = await upload(origin, handle, session, `${Buffer.from(second).toString("base64")}!!`);
    assert.equal(notCanonical.status, 400);
    assert.equal(await codeOf(notCanonical), "invalid_request");

    // The write discipline every management mutation carries: a missing CSRF token is a
    // 403, and the picture is untouched.
    const noCsrf = await upload(origin, handle, session, Buffer.from(first).toString("base64"), { csrf: false });
    assert.equal(noCsrf.status, 403);
    assert.equal(await codeOf(noCsrf), "csrf_failed");
    assert.deepEqual(await readFile(pathOf(hello)), Buffer.from(second));

    // A cross-origin write is refused before any service runs.
    const crossOrigin = await upload(origin, handle, session, Buffer.from(first).toString("base64"), {
      origin: "http://127.0.0.1:1",
    });
    assert.equal(crossOrigin.status, 401);
    assert.equal(await codeOf(crossOrigin), "unauthorized");

    // The URL is the whole address: a query string would make it name something else.
    const withQuery = await upload(origin, handle, session, Buffer.from(second).toString("base64"), {
      search: "?v=1",
    });
    assert.equal(withQuery.status, 400);
    assert.equal(await codeOf(withQuery), "invalid_request");

    // Only PUT is this route's: a POST to the same path is no route at all.
    const posted = await upload(origin, handle, session, Buffer.from(second).toString("base64"), { method: "POST" });
    assert.equal(posted.status, 404);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a companion with no picture is untouched by a refused upload, and the monogram stays", async () => {
  const root = await canonicalTestRoot("tavern-avatar-route-absent-");
  const { service, pathOf } = avatarServiceFor(root);
  const server = await startTavernManagementDialogueWebServer(managementOptions(service));
  try {
    const origin = server.origin;
    const session = await bootstrap(origin);
    // A companion whose picture was never set: the refusal invent nothing, and no file
    // appears where the asset face looks.
    const refused = await upload(origin, absentHandle, session, "AAAA");
    assert.equal(refused.status, 422);
    assert.equal(await codeOf(refused), "companion_avatar_malformed");
    assert.deepEqual(await service.read(absentHandle), { state: "absent" });
    assert.deepEqual(await readFile(pathOf(empty)).catch(() => null), null);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the avatar route is absent when the profile does not declare it, and composition fails closed without the service", async () => {
  const root = await canonicalTestRoot("tavern-avatar-route-undeclared-");
  const { service } = avatarServiceFor(root);
  // The core profile does NOT declare `companion.avatar.update`, so the route the browser
  // calls is not served even though the service was injected.
  const server = await startTavernManagementDialogueWebServer({
    ...managementOptions(service),
    profile: composeTavernProfile({
      profileId: "gamebuddy.tavern-management.chat-list-title",
      releaseTier: "tavern_management",
      routeIds: [...CORE_ROUTES],
      operationIds: [...CORE_OPERATIONS],
      navigationItemIds: ["chat"],
    }),
  });
  try {
    const origin = server.origin;
    const session = await bootstrap(origin);
    const refused = await upload(origin, handle, session, Buffer.from(pngPictureFile()).toString("base64"));
    assert.equal(refused.status, 404);
    assert.equal(await codeOf(refused), "profile_operation_unavailable");
    assert.deepEqual(await service.read(handle), { state: "absent" });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }

  // A profile that advertises the route without the bound service fails closed at
  // composition, so the surface is never shown an upload control the Host cannot serve.
  // Every other service the profile's routes need is injected, so the only missing one is
  // the avatar's own.
  const { companionAvatarService, ...withoutAvatar } = managementOptions(service);
  assert.equal(companionAvatarService, service);
  assert.throws(
    () => createTavernManagementDialogueWebRequestHandler({ ...withoutAvatar, profile }),
    /tavern_management_composition_unavailable/,
  );
});
