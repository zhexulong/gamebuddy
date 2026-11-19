import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import test from "node:test";
import type { MountedChatRuntimeLease } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { readSourceShape } from "../../test-support/source-shape.test-support.js";
import { ChatListV1Schema, composeTavernProfile } from "../browser-contract/index.js";
import { createChatManagementService } from "./chat-management-service.js";

const principal = Object.freeze({ playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" });

function manifest(root: string): HostDeploymentManifest {
  return Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: root,
    principal,
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
  });
}

function managementProfile() {
  return composeTavernProfile({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: ["bootstrap", "state.read", "draft.read", "draft.save", "draft.discard", "chat.list", "chat.rename"],
    operationIds: ["draft.save", "draft.discard", "chat.rename"],
    navigationItemIds: ["chat"],
  });
}

function catalogStub() {
  return Object.freeze({
    async readChatCatalog() {
      return Object.freeze({ threads: Object.freeze([]), expectedSelection: null });
    },
  });
}

function forgedLease(): MountedChatRuntimeLease {
  return Object.freeze({
    runtimeSession: Object.freeze({}),
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    browserProjection: Object.freeze({
      chatHandle: "forged-chat",
      selectionGeneration: 1,
      selectionStateRevision: "forged-revision",
      projectMessageHandle: () => "forged-message",
      projectTurnHandle: () => "forged-turn",
      projectChatHandle: () => "forged-thread",
    }),
    attachPresentation: () => () => undefined,
    close: async () => undefined,
  }) as unknown as MountedChatRuntimeLease;
}

test("management service rejects forged structural leases, non-composed profiles and profiles without chat.rename", async () => {
  const root = await canonicalTestRoot("gamebuddy-management-forged-");
  try {
    const forged = forgedLease();
    assert.throws(
      () =>
        createChatManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: managementProfile(),
          chatCatalog: catalogStub(),
        }),
      /chat_management_service_unavailable/,
    );
    assert.throws(
      () =>
        createChatManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: { ...managementProfile() },
          chatCatalog: catalogStub(),
        }),
      /chat_management_service_unavailable/,
    );
    const referenceProfile = composeTavernProfile({
      profileId: "gamebuddy.chat-core.reference-pipeline",
      releaseTier: "chat_core",
      routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.submission_status"],
      operationIds: ["chat.submit"],
      navigationItemIds: ["chat"],
    });
    assert.throws(
      () =>
        createChatManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: referenceProfile,
          chatCatalog: catalogStub(),
        }),
      /chat_management_service_unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("management service source keeps the store, lease and coordinator authority private", async () => {
  const { shape: source } = readSourceShape(new URL("./chat-management-service.js", import.meta.url));
  // The service composes only the existing public title-management seam and
  // the browser contract; it never imports coordinator internal bridges or
  // P4/P5 transition authority.
  assert.match(source, /from "\.\/chat-title-management\.js"/);
  assert.doesNotMatch(
    source,
    /continuity-semantic-production-coordinator\.internal|transitionMountedProviderStart|transitionMountedPresentation/,
  );
  assert.doesNotMatch(source, /from ["'][^"']*(node:http|express|router|fetch)[^"']*["']/);
});

const mountPreamble = `
  const [serviceUrl, coordinatorUrl, deploymentUrl, storeUrl, runtimeUrl, contractUrl, facadeUrl, root] = process.argv.slice(1);
  const { writeFile, mkdir } = await import("node:fs/promises");
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  const manifestPath = root + "/manifest.json";
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
  const { loadHostDeploymentManifest } = await import(deploymentUrl);
  const coordinator = await import(coordinatorUrl);
  const { createSharedSemanticProductionAuthorityFromDeploymentManifest } = coordinator;
  const { createChatManagementService } = await import(serviceUrl);
   const { createChatThreadStore, createProfileAwareChatThreadCreationCapability } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { composeTavernProfile, TavernBrowserValidatorsV1 } = await import(contractUrl);
  const { createTavernManagementStateFacade } = await import(facadeUrl);
  const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", storeUrl).href);
  const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", storeUrl).href);
  await bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const profile = composeTavernProfile({ profileId: "gamebuddy.tavern-management.chat-list-title", releaseTier: "tavern_management", routeIds: ["bootstrap", "state.read", "draft.read", "draft.save", "draft.discard", "chat.list", "chat.rename"], operationIds: ["draft.save", "draft.discard", "chat.rename"], navigationItemIds: ["chat"] });
  const shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(manifest);
  const authority = shared.chat;
  const lease = await authority.startMountedChatRuntime();
  const service = createChatManagementService({ manifest, lease, profile, chatCatalog: shared.catalog });
  const facade = await createTavernManagementStateFacade(manifest, lease, profile);
  const store = () => createChatThreadStore(root, identityKey(principal));
  const { createManifestDerivedInitialChatExactContentPort } = await import(new URL("../initial-chat-exact-content-port.js", serviceUrl).href);
  const createChat = async (chatThreadId, chatSurfaceSessionId) => {
    const content = createManifestDerivedInitialChatExactContentPort(manifest);
    try {
      await content.port.createExplicit({ chatThreadId, chatSurfaceSessionId, companionId: principal.companionId, continuityId: principal.continuityId, opening: "blank" });
    } finally {
      content.close();
    }
  };
  const selectChat = async (chatThreadId, chatSurfaceSessionId, selectionGeneration) =>
    authority.requestChatSelection({ kind: "select", selectionGeneration, chatThreadId, chatSurfaceSessionId });
  const code = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } };
`;

async function runMountedChild(body: string, root: string): Promise<Record<string, unknown>> {
  const serviceUrl = new URL("./chat-management-service.js", import.meta.url).href;
  const coordinatorUrl = new URL(
    "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
    import.meta.url,
  ).href;
  const deploymentUrl = new URL("../../deployment-manifest.js", import.meta.url).href;
  const storeUrl = new URL("../chat-thread-store.js", import.meta.url).href;
  const runtimeUrl = new URL("../../runtime.js", import.meta.url).href;
  const contractUrl = new URL("../browser-contract/index.js", import.meta.url).href;
  const facadeUrl = new URL("../tavern-management-state.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      mountPreamble + body,
      serviceUrl,
      coordinatorUrl,
      deploymentUrl,
      storeUrl,
      runtimeUrl,
      contractUrl,
      facadeUrl,
      root,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const [code] = (await once(child, "exit")) as [number | null];
  assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
  return JSON.parse(Buffer.concat(output).toString("utf8")) as Record<string, unknown>;
}

async function mounted(body: string): Promise<Record<string, unknown>> {
  const root = await canonicalTestRoot("gamebuddy-management-service-");
  try {
    return await runMountedChild(body, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("mounted management service lists durable metadata only and renames any Chat of the partition through the management CAS", async () => {
  const results = await mounted(`
    const handle = lease.browserProjection.chatHandle;
    const secondHandle = lease.browserProjection.projectChatHandle("thread_02", "surface_02");
    const list = await service.listChats({ apiVersion: 1, state: "active" });
    const listValue = list;
     const secondStore = store();
     const secondCreation = createProfileAwareChatThreadCreationCapability(secondStore, { async readExact() { return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) }; } });
     // A marker-bearing opening (an action beat and a macro that was never resolved):
     // the row's preview must be plain text, not the transcript's own markup.
     const second = await secondCreation.createExplicit({ chatThreadId: "thread_02", companionId: "companion_01", continuityId: "continuity_01", chatSurfaceSessionId: "surface_02", profileId: "profile_01", profileRevision: 1, profileCanonicalHash: "a".repeat(64), opening: { messageId: "opening_02", text: "*The lantern is still lit.* {{user}}, the parsnips took.", source: { greetingSetId: "greetings_01", sourceRevision: 2, canonicalHash: "a".repeat(64), variantId: "alternate_01", profileRevision: 3, scenarioRevision: null } } });
    const two = await service.listChats({ apiVersion: 1 });
    const durableMounted = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    const durableSecond = await store().resumeThread("thread_02", "surface_02");
    const rename = await service.renameChatTitle({ apiVersion: 1, chatHandle: handle, expectedManagementRevision: 1, title: "Renamed Farm Chat" });
    const readBack = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    // The rename names ANY Chat of the partition by its own handle, not only the mounted one: the
    // second Chat is renamed while the mounted Chat - title and revision - are left exactly as they
    // were, because no selection is consulted or changed.
    const nonMountedRename = await service.renameChatTitle({ apiVersion: 1, chatHandle: secondHandle, expectedManagementRevision: 1, title: "The other one" });
    const mountedAfter = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    const secondAfter = await store().resumeThread("thread_02", "surface_02");
    // The SAME request twice is the stale-revision conflict, not a second write.
    const twiceSame = await code(() => service.renameChatTitle({ apiVersion: 1, chatHandle: secondHandle, expectedManagementRevision: 1, title: "The other one" }));
    const unknownHandle = await code(() => service.renameChatTitle({ apiVersion: 1, chatHandle: "B".repeat(43), expectedManagementRevision: 1, title: "X" }));
    const staleRevision = await code(() => service.renameChatTitle({ apiVersion: 1, chatHandle: handle, expectedManagementRevision: 1, title: "Another" }));
    const unchanged = await code(() => service.renameChatTitle({ apiVersion: 1, chatHandle: handle, expectedManagementRevision: 2, title: "Renamed Farm Chat" }));
    const invalidTitle = await code(() => service.renameChatTitle({ apiVersion: 1, chatHandle: handle, expectedManagementRevision: 2, title: "   " }));
    const facadeState = await facade.read();
    process.stdout.write(JSON.stringify({
      listValue,
      two,
      rename,
      readBackTitle: readBack.thread.title,
      readBackRevision: readBack.thread.managementRevision,
      nonMountedRename,
      mountedUnchangedAfterNonMounted: readBack.thread.title === mountedAfter.thread.title && readBack.thread.managementRevision === mountedAfter.thread.managementRevision,
      secondTitle: secondAfter.thread.title,
      secondRevision: secondAfter.thread.managementRevision,
      twiceSame,
      unknownHandle,
      staleRevision,
      unchanged,
      invalidTitle,
      facadeState,
      rawIds: [lease.chatThreadId, lease.chatSurfaceSessionId, "thread_02", "surface_02", "companion_01", "continuity_01"],
      secondThreadId: second.thread.chatThreadId,
      durableMountedTime: durableMounted.thread.updatedAtMs,
      durableSecondTime: durableSecond.thread.updatedAtMs,
      mountedLastMessage: durableMounted.messages.at(-1) === undefined ? null : durableMounted.messages.at(-1).text,
      secondMessageCount: durableSecond.messages.length,
      mounted: { chatThreadId: lease.chatThreadId, chatSurfaceSessionId: lease.chatSurfaceSessionId },
    }));
    await service.close();
    await lease.close();
    await shared.close();
  `);
  const listValue = results.listValue as { chats: ReadonlyArray<Readonly<Record<string, unknown>>> };
  assert.equal(listValue.chats.length, 1);
  assert.equal(listValue.chats[0]?.isSelected, true);
  assert.equal((results.two as { chats: unknown[] }).chats.length, 2);
  const secondEntry = (results.two as { chats: ReadonlyArray<Readonly<Record<string, unknown>>> }).chats.find(
    (chat) => chat.isSelected === false,
  )!;
  assert.equal(secondEntry.status, "active");
  assert.equal(secondEntry.handle !== (listValue.chats[0] as Readonly<Record<string, unknown>>).handle, true);
  // The row's two identity facts, read from the durable thread the projection just
  // listed: the store's own `updated_at_ms`, and the last message as plain text.
  assert.equal(secondEntry.updatedAtMs, results.durableSecondTime);
  assert.equal((listValue.chats[0] as Readonly<Record<string, unknown>>).updatedAtMs, results.durableMountedTime);
  assert.equal(results.secondMessageCount, 1);
  assert.equal(secondEntry.preview, "The lantern is still lit., the parsnips took.");
  assert.equal(
    String(secondEntry.preview).includes("*") || String(secondEntry.preview).includes("{{"),
    false,
    "the row preview carried transcript markup",
  );
  assert.notEqual(
    secondEntry.preview,
    (listValue.chats[0] as Readonly<Record<string, unknown>>).preview,
    "two Chats opened differently must not read as the same row",
  );
  const rename = results.rename as { title: string; managementRevision: number };
  assert.equal(rename.title, "Renamed Farm Chat");
  assert.equal(rename.managementRevision, 2);
  assert.equal(results.readBackTitle, "Renamed Farm Chat");
  assert.equal(results.readBackRevision, 2);
  // The rename names any Chat of the partition by its own handle: a non-mounted target advances THAT
  // Chat's revision and leaves the mounted Chat - title and revision - exactly as it was.
  const nonMountedRename = results.nonMountedRename as { title: string; managementRevision: number };
  assert.equal(nonMountedRename.title, "The other one");
  assert.equal(nonMountedRename.managementRevision, 2);
  assert.equal(results.secondTitle, "The other one");
  assert.equal(results.secondRevision, 2);
  assert.equal(results.mountedUnchangedAfterNonMounted, true, "renaming a non-mounted Chat moved the mounted one");
  // The SAME request twice is the stale-revision conflict, not a second write, and a handle no Chat
  // of the partition carries is a bounded not-found rather than a selection conflict.
  assert.equal((results.twiceSame as { error: string }).error, "chat_management_revision_conflict");
  assert.equal((results.unknownHandle as { error: string }).error, "chat_not_found");
  assert.equal((results.staleRevision as { error: string }).error, "chat_management_revision_conflict");
  assert.equal((results.unchanged as { error: string }).error, "chat_management_revision_conflict");
  assert.equal((results.invalidTitle as { error: string }).error, "invalid_request");
  const facadeState = results.facadeState as {
    selection: { chatHandle: string; generation: number; stateRevision: string };
    operations: ReadonlyArray<{ operationId: string; labelKey: string; availability: string; routeId: string }>;
  };
  assert.equal(facadeState.selection.chatHandle, (listValue.chats[0] as Readonly<Record<string, unknown>>).handle);
  assert.deepEqual(facadeState.operations, [
    {
      operationId: "draft.save",
      labelKey: "tavern.operation.draft.save",
      availability: "available",
      routeId: "draft.save",
    },
    {
      operationId: "draft.discard",
      labelKey: "tavern.operation.draft.discard",
      availability: "available",
      routeId: "draft.discard",
    },
    {
      operationId: "chat.rename",
      labelKey: "tavern.operation.rename",
      availability: "available",
      routeId: "chat.rename",
    },
  ]);
  // Metadata-only projection: no raw durable identifier may appear in any
  // serialized player DTO.
  const serialized = JSON.stringify({
    list: results.listValue,
    two: results.two,
    rename: results.rename,
    facade: results.facadeState,
  });
  for (const raw of results.rawIds as string[]) {
    assert.equal(serialized.includes(raw), false, `raw durable identifier leaked: ${raw}`);
  }
});

test("mounted management state projects world-info.bind as a strict browser operation when the profile declares it", async () => {
  const results = await mounted(`
    const worldInfoProfile = composeTavernProfile({
      profileId: "gamebuddy.tavern-management.chat-list-title",
      releaseTier: "tavern_management",
      routeIds: ["bootstrap", "state.read", "draft.read", "draft.save", "draft.discard", "chat.list", "chat.rename", "world-info.read", "world-info.bind"],
      operationIds: ["draft.save", "draft.discard", "chat.rename", "world-info.bind"],
      navigationItemIds: ["chat"],
    });
    const worldInfoService = Object.freeze({
      read: async () => ({ state: "none", revision: "A".repeat(43), items: [] }),
      setBinding: async () => { throw new Error("stub_set_binding_unreached"); },
      detail: async () => { throw new Error("stub_detail_unreached"); },
      create: async () => { throw new Error("stub_create_unreached"); },
      update: async () => { throw new Error("stub_update_unreached"); },
      delete: async () => { throw new Error("stub_delete_unreached"); },
      close: async () => undefined,
    });
    const worldInfoFacade = await createTavernManagementStateFacade(manifest, lease, worldInfoProfile, worldInfoService);
    const state = await worldInfoFacade.read();
    const bindOperation = state.operations.find((operation) => operation.operationId === "world-info.bind");
    const strict = TavernBrowserValidatorsV1.TavernBrowserOperationV1Schema.Check(bindOperation);
    process.stdout.write(JSON.stringify({
      bindOperation,
      strict,
      worldInfo: state.worldInfo,
      operations: state.operations.map((operation) => operation.operationId),
    }));
    await lease.close();
    await shared.close();
  `);
  const bindOperation = results.bindOperation as {
    operationId: string;
    labelKey: string;
    availability: string;
    routeId: string;
  };
  assert.deepEqual(bindOperation, {
    operationId: "world-info.bind",
    labelKey: "tavern.operation.world-info.bind",
    availability: "available",
    routeId: "world-info.bind",
  });
  assert.equal(results.strict, true);
  // The exact safe World Info projection stays in the snapshot and the
  // mounted Chat's existing operations remain intact.
  assert.deepEqual(results.worldInfo, { state: "none", revision: "A".repeat(43), items: [] });
  assert.deepEqual(results.operations, ["draft.save", "draft.discard", "chat.rename", "world-info.bind"]);
});

test("mounted management state facade rejects structural clones of a composed profile before durable I/O", async () => {
  const results = await mounted(`
    const { isComposedTavernProfile } = await import(contractUrl);
    // Structural clone: identical own keys and frozen shapes, but never
    // branded by composeTavernProfile's WeakSet, so only the canonical
    // identity-brand guard rejects it, never the legacy shape check.
    const structuralClone = Object.freeze({ ...profile });
    const cloneIsBranded = isComposedTavernProfile(structuralClone);
    // Any durable read against a missing root must fail with an I/O error;
    // if facade construction still rejects with the profile failure here,
    // the profile gate provably precedes all durable I/O.
    const absentManifest = Object.freeze({ ...manifest, runtimeRoot: root + "/missing-root" });
    const rejected = await code(() => createTavernManagementStateFacade(absentManifest, lease, structuralClone));
    const brandedLeaf = await code(() => createTavernManagementStateFacade(absentManifest, lease, profile));
    process.stdout.write(JSON.stringify({ cloneIsBranded, rejected, brandedLeaf }));
    await lease.close();
    await shared.close();
  `);
  // The frozen spread is a perfect structural copy but never the branded
  // object, so the WeakSet brand guard and the shape guard disagree.
  assert.equal(results.cloneIsBranded, false);
  // The facade rejects the clone with the exact fail-closed error even
  // though the mounted root was replaced by a nonexistent one, proving the
  // rejection precedes the durable identity-profile reads.
  assert.deepEqual(results.rejected, { ok: false, error: "tavern_management_state_unavailable" });
  // Harness proof: a branded profile against the same missing root fails
  // with a real I/O error, so the clone rejection above cannot come from
  // durable I/O.
  assert.equal((results.brandedLeaf as { ok: boolean }).ok, false);
  assert.equal((results.brandedLeaf as { error: string }).error.includes("ENOENT"), true);
});

/**
 * A player's Chat count is their own: the list read is the only way the surface
 * reaches a Chat (no paging, no query), so the 101st Chat must read back as a
 * 101st row. The row shape is still fixed - `status` is still `active` and
 * `preview` is still plain text - but the number of rows is the player's.
 */
test("the mounted list read returns the player's 101st Chat instead of refusing the whole list", async () => {
  const results = await mounted(`
    const creation = createProfileAwareChatThreadCreationCapability(store(), { async readExact() { return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) }; } });
    for (let index = 2; index <= 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      await creation.createExplicit({
        chatThreadId: "thread_" + suffix,
        companionId: "companion_01",
        continuityId: "continuity_01",
        chatSurfaceSessionId: "surface_" + suffix,
        profileId: "profile_01",
        profileRevision: 1,
        profileCanonicalHash: "a".repeat(64),
        opening: { messageId: "opening_" + suffix, text: "Chat " + suffix, source: { greetingSetId: "greetings_01", sourceRevision: 2, canonicalHash: "a".repeat(64), variantId: "default_01", profileRevision: 3, scenarioRevision: null } },
      });
    }
    const list = await service.listChats({ apiVersion: 1 });
    const durableThreadCount = (await store().listThreads()).length;
    process.stdout.write(JSON.stringify({
      count: list.chats.length,
      handles: list.chats.map((chat) => chat.handle),
      durableThreadCount,
      lastPreview: list.chats.map((chat) => chat.preview).find((preview) => preview === "Chat 101") ?? null,
    }));
    await service.close();
    await lease.close();
    await shared.close();
  `);
  assert.equal(results.durableThreadCount, 101);
  assert.equal(results.count, 101, "the list read refused a Chat count the player reached");
  const handles = results.handles as string[];
  assert.equal(new Set(handles).size, 101, "two rows of the list read as the same Chat");
  assert.equal(results.lastPreview, "Chat 101", "the 101st Chat is not in the list as its own row");
});

/**
 * THE FIVE CLAUSES OF THE UNMOUNTABLE-SUCCESSOR REFUSAL, one test each.
 *
 * The refusal exists for one state: a removal that leaves the next start with Chats it cannot mount,
 * which fails closed with `semantic_chat_liveness_unrecoverable` before a browser exists. A refusal
 * that also fires on a request the product can serve is worse than none - it blocks an ordinary
 * removal over a state the player cannot repair from inside the product. So each clause below has its
 * own test, written so that clause alone decides the answer: drop it and the reading inverts.
 */

/**
 * (i) THE REQUEST MUST REMOVE A LIVE CHAT.
 *
 * A restore can only name a Chat that already left the active list, so the row's own lifecycle state
 * is the whole clause - and it must be the clause, not an incidental one: in the state below the Chat
 * this mount serves is the archived one, the survivor is a Chat the semantic authority never
 * registered, and the same request issued as a removal is refused. Only the restore is served, and
 * only because it puts the Chat back.
 */
test("a restore of the served Chat is served in the state a removal of it is refused in", async () => {
  const results = await mounted(`
    const handle = lease.browserProjection.chatHandle;
    const survivor = { chatThreadId: "chat-" + "2".repeat(16), chatSurfaceSessionId: "surface-" + "2".repeat(16) };
    await createChat(survivor.chatThreadId, survivor.chatSurfaceSessionId);
    // The served Chat leaves the active list through another writer of the same durable authority -
    // the state a restore exists for, and the state a removal request can still name.
    const row = (await store().listThreads()).find((thread) => thread.chatThreadId === lease.chatThreadId);
    await store().transitionLifecycle({ chatThreadId: row.chatThreadId, chatSurfaceSessionId: row.chatSurfaceSessionId, companionId: "companion_01", continuityId: "continuity_01", expectedManagementRevision: row.managementRevision ?? 1, operation: "archive" });
    const removalOfAnArchivedChat = await code(() => service.transitionLifecycle({ apiVersion: 1, chatHandle: handle, expectedManagementRevision: 2, operation: "archive" }));
    const restored = await code(() => service.transitionLifecycle({ apiVersion: 1, chatHandle: handle, expectedManagementRevision: 2, operation: "restore" }));
    const removalAfterRestore = await code(() => service.transitionLifecycle({ apiVersion: 1, chatHandle: handle, expectedManagementRevision: 3, operation: "archive" }));
    const durable = (await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId)).thread;
    process.stdout.write(JSON.stringify({ removalOfAnArchivedChat, restored, removalAfterRestore, lifecycle: durable.lifecycleStatus, mountedThreadId: lease.chatThreadId }));
    await service.close();
    await lease.close();
    await shared.close();
  `);
  // The archived row is the store's own refusal of an impossible transition, under the store's name.
  assert.deepEqual(results.removalOfAnArchivedChat, {
    ok: false,
    error: "chat_management_lifecycle_invalid",
  });
  assert.equal((results.restored as { ok: boolean }).ok, true, "a restore was refused as if it were a removal");
  assert.equal(results.lifecycle, "active", "the restore did not put the Chat back");
  // ...and the SAME row, now live, is refused as a removal with the survivor set unmoved by either
  // call: the refused restore reading above could not have been the empty list's, nor a revision's.
  assert.deepEqual(results.removalAfterRestore, {
    ok: false,
    error: `chat_successor_unmountable:${String(results.mountedThreadId)}`,
  });
  assert.equal(results.lifecycle, "active", "the refused removal reached the durable row");
});

/**
 * (ii) ONLY THE REMOVAL THAT WOULD ORPHAN THE SELECTION IS JUDGED.
 *
 * A durable archive never moves the mount lease: the mounted runtime keeps serving the Chat the player
 * is looking at until the shell migrates its selection. So while the served Chat is still a live row,
 * removing any OTHER Chat leaves the next start's selection exactly where it was - live, verified, and
 * readable - and the semantic authority is never consulted for it. Once the served Chat has left the
 * list through any writer, every removal is judged by what it leaves behind, because then the next
 * start has to find a successor.
 */
test("a sibling removal is served without asking the catalog, and a removal is judged once the mount's Chat is gone", async () => {
  const results = await mounted(`
    const sibling = { chatThreadId: "chat-" + "3".repeat(16), chatSurfaceSessionId: "surface-" + "3".repeat(16) };
    const first = { chatThreadId: "chat-" + "4".repeat(16), chatSurfaceSessionId: "surface-" + "4".repeat(16) };
    const second = { chatThreadId: "chat-" + "5".repeat(16), chatSurfaceSessionId: "surface-" + "5".repeat(16) };
    await createChat(sibling.chatThreadId, sibling.chatSurfaceSessionId);
    await createChat(first.chatThreadId, first.chatSurfaceSessionId);
    await createChat(second.chatThreadId, second.chatSurfaceSessionId);
    // The catalog, counted: whether a removal consults the semantic authority at all is the one thing
    // a removal of another Chat must not do.
    let catalogReads = 0;
    const countingCatalog = Object.freeze({ async readChatCatalog() { catalogReads += 1; return shared.catalog.readChatCatalog(); } });
    const countingService = createChatManagementService({ manifest, lease, profile, chatCatalog: countingCatalog });
    const handleOf = (target) => lease.browserProjection.projectChatHandle(target.chatThreadId, target.chatSurfaceSessionId);
    const siblingRemoval = await code(() => countingService.transitionLifecycle({ apiVersion: 1, chatHandle: handleOf(sibling), expectedManagementRevision: 1, operation: "archive" }));
    const readsAfterSibling = catalogReads;
    // The served Chat leaves the list through another writer of the same durable authority, and the
    // two Chats left carry no verified content: what a removal leaves is now the whole question.
    const row = (await store().listThreads()).find((thread) => thread.chatThreadId === lease.chatThreadId);
    await store().transitionLifecycle({ chatThreadId: row.chatThreadId, chatSurfaceSessionId: row.chatSurfaceSessionId, companionId: "companion_01", continuityId: "continuity_01", expectedManagementRevision: row.managementRevision ?? 1, operation: "archive" });
    const orphanedRemoval = await code(() => countingService.transitionLifecycle({ apiVersion: 1, chatHandle: handleOf(first), expectedManagementRevision: 1, operation: "archive" }));
    const readsAfterOrphaned = catalogReads - readsAfterSibling;
    const firstRow = (await store().resumeThread(first.chatThreadId, first.chatSurfaceSessionId)).thread;
    const active = (await countingService.listChats({ apiVersion: 1, state: "active" })).chats.length;
    process.stdout.write(JSON.stringify({ siblingRemoval, readsAfterSibling, orphanedRemoval, readsAfterOrphaned, firstLifecycle: firstRow.lifecycleStatus, active }));
    await countingService.close();
    await service.close();
    await lease.close();
    await shared.close();
  `);
  // Reading 1: the served Chat is live, so the sibling goes - and the semantic authority is not asked,
  // because nothing about that removal can leave the next start without a selection.
  assert.equal(
    (results.siblingRemoval as { ok: boolean }).ok,
    true,
    "a removal of a Chat the mount does not serve was refused while that mount's Chat was still live",
  );
  assert.equal(results.readsAfterSibling, 0, "a removal of another Chat consulted the semantic catalog");
  // Reading 2: with the served Chat gone, the same-shaped request leaves two unverified Chats and one
  // survivor, which is the state that bricks the next start - so it is refused, naming the Chat.
  const orphaned = results.orphanedRemoval as { ok: boolean; error?: string };
  assert.equal(
    orphaned.ok,
    false,
    "a removal that left only unmountable Chats was served once the served Chat was gone",
  );
  assert.match(
    String(orphaned.error),
    /^chat_successor_unmountable:/u,
    "the orphaned removal was refused as something other than the unmountable successor's own fact",
  );
  assert.equal(results.readsAfterOrphaned, 1, "the orphaned removal did not reach the catalog's answer");
  assert.equal(results.firstLifecycle, "active", "the refused removal reached the durable row");
  assert.equal(results.active, 2, "the refused removal left the active list changed");
});

/**
 * (iii) A SURVIVOR MUST EXIST - AND THE EMPTY LIST KEEPS ITS OWN NAME.
 *
 * The last live Chat is a different fact with a different sentence: nothing is left to open, so the
 * player creates one, where the unmountable survivor is one click from being mountable. The empty
 * list is judged inside the removal's own transaction (`ChatThreadStore.transitionLifecycle`), so
 * this clause is what keeps this guard from borrowing that refusal's name.
 */
test("archiving the last live Chat is the empty list's refusal, not the unmountable successor's", async () => {
  const results = await mounted(`
    const removal = await code(() => service.transitionLifecycle({ apiVersion: 1, chatHandle: lease.browserProjection.chatHandle, expectedManagementRevision: 1, operation: "archive" }));
    const durable = (await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId)).thread;
    const active = (await service.listChats({ apiVersion: 1, state: "active" })).chats.length;
    process.stdout.write(JSON.stringify({ removal, lifecycle: durable.lifecycleStatus, active }));
    await service.close();
    await lease.close();
    await shared.close();
  `);
  assert.deepEqual(results.removal, { ok: false, error: "chat_active_list_empty" });
  assert.equal(results.lifecycle, "active", "the refused removal reached the durable row");
  assert.equal(results.active, 1, "the refused removal left the active list changed");
});

/**
 * (iv) NO SURVIVOR MAY CARRY VERIFIED CONTENT.
 *
 * A New Chat is durable from the moment `chat.create` writes it, but the semantic catalog learns it
 * only when the player opens it. That asymmetry is the whole defect: removing the served Chat while
 * such a Chat is the only survivor leaves the next start with no successor it could mount. The
 * forward path is the one the refusal names - open it once - and it is exercised here so the refusal
 * is proved to be about the catalog's answer, not about removals in general.
 */
test("a survivor the semantic authority never verified refuses the removal, and a verified one does not", async () => {
  const results = await mounted(`
    const servedHandle = lease.browserProjection.chatHandle;
    const survivor = { chatThreadId: "chat-" + "6".repeat(16), chatSurfaceSessionId: "surface-" + "6".repeat(16) };
    await createChat(survivor.chatThreadId, survivor.chatSurfaceSessionId);
    const refused = await code(() => service.transitionLifecycle({ apiVersion: 1, chatHandle: servedHandle, expectedManagementRevision: 1, operation: "archive" }));
    const durableAfterRefusal = (await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId)).thread;
    const activeAfterRefusal = (await service.listChats({ apiVersion: 1, state: "active" })).chats.length;
    // The forward path the refusal names: open the survivor once, which registers and verifies it...
    await selectChat(survivor.chatThreadId, survivor.chatSurfaceSessionId, lease.browserProjection.selectionGeneration);
    const onSurvivor = await authority.startMountedChatRuntime();
    // ...and come back to the served Chat, so THIS mount serves the Chat whose survivor the catalog
    // now knows. The catalog's answer, not the removal, is the difference.
    await selectChat(lease.chatThreadId, lease.chatSurfaceSessionId, onSurvivor.browserProjection.selectionGeneration);
    const migrated = await authority.startMountedChatRuntime();
    const serviceOnServed = createChatManagementService({ manifest, lease: migrated, profile, chatCatalog: shared.catalog });
    const servedAgain = migrated.browserProjection.projectChatHandle(lease.chatThreadId, lease.chatSurfaceSessionId);
    const served = await code(() => serviceOnServed.transitionLifecycle({ apiVersion: 1, chatHandle: servedAgain, expectedManagementRevision: 1, operation: "archive" }));
    process.stdout.write(JSON.stringify({ refused, durableLifecycleAfterRefusal: durableAfterRefusal.lifecycleStatus, activeAfterRefusal, served, mountedThreadId: lease.chatThreadId }));
    await serviceOnServed.close();
    await service.close();
    await migrated.close();
    await onSurvivor.close();
    await lease.close();
    await shared.close();
  `);
  assert.deepEqual(results.refused, {
    ok: false,
    error: `chat_successor_unmountable:${String(results.mountedThreadId)}`,
  });
  assert.equal(results.durableLifecycleAfterRefusal, "active", "the refused removal reached the durable row");
  assert.equal(results.activeAfterRefusal, 2, "the refused removal left the active list changed");
  assert.equal(
    (results.served as { ok: boolean }).ok,
    true,
    "the same removal was refused with a verified survivor, so the refusal is not about the catalog's answer",
  );
});

/**
 * (v) A RECORDED EXPECTATION FOR A SURVIVOR IS AN ADMISSION, NOT A BRICK.
 *
 * A player who selects a Chat only the pre-mount settlement can register leaves exactly two durable
 * facts: the recorded expectation, and the Chat's Tavern content. The next mount settles it -
 * register, verify, select, all before the runtime is prepared - so a removal that leaves that Chat
 * behind is served, not refused. This child writes the pair through the same store API the
 * settlement writes it through, because the state it describes is the one a crash between the
 * record and the release leaves, and the product has no other way to produce a pending expectation.
 */
test("a survivor a recorded selection expectation will settle is mountable, so the removal is served and the next start mounts it", async () => {
  const results = await mounted(`
    const servedHandle = lease.browserProjection.chatHandle;
    const survivor = { chatThreadId: "chat-" + "6".repeat(16), chatSurfaceSessionId: "surface-" + "6".repeat(16) };
    await createChat(survivor.chatThreadId, survivor.chatSurfaceSessionId);
    const { openProductionContinuityStore } = await import(new URL("../continuity-semantic-store/continuity-semantic-production-store.js", storeUrl).href);
    const { PRODUCTION_AUTHORITY_RECORD_NAMES, createCanonicalProductionAuthorityAdmission } = await import(new URL("../continuity-semantic-provisioning/continuity-semantic-provisioning.internal.js", storeUrl).href);
    const control = openProductionContinuityStore({ runtimeRoot: root + "/" + PRODUCTION_AUTHORITY_RECORD_NAMES.authorityDirectory });
    try {
      const bootstrap = { principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1, authorityRootIdentity: createCanonicalProductionAuthorityAdmission(root).authorityRootIdentity };
      const durableStore = control.bindBootstrapContext({ bootstrap, metadata: control.validateBootstrap(bootstrap) });
      durableStore.recordChatSelectionIntent({ intent: { kind: "create", chatThreadId: survivor.chatThreadId, chatSurfaceSessionId: survivor.chatSurfaceSessionId }, expected: { ...durableStore.readChatCatalog().vector } });
    } finally {
      control.close();
    }
    const removal = await code(() => service.transitionLifecycle({ apiVersion: 1, chatHandle: servedHandle, expectedManagementRevision: 1, operation: "archive" }));
    const durable = (await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId)).thread;
    await service.close();
    await lease.close();
    await shared.close();
    // The next start, through the same entry point the composition calls first.
    const reopened = await coordinator.createSharedSemanticProductionAuthorityFromDeploymentManifest(manifest);
    const mounted = await reopened.chat.startMountedChatRuntime();
    const catalog = await reopened.catalog.readChatCatalog();
    const survivorRow = catalog.threads.find((thread) => thread.chatThreadId === survivor.chatThreadId);
    process.stdout.write(JSON.stringify({
      removal,
      lifecycle: durable.lifecycleStatus,
      mountedThreadId: mounted.chatThreadId,
      survivorThreadId: survivor.chatThreadId,
      survivorContentState: survivorRow === undefined ? null : survivorRow.contentState,
      pendingSelection: catalog.expectedSelection === null ? null : catalog.expectedSelection.chatThreadId,
    }));
    await mounted.close();
    await reopened.close();
  `);
  assert.equal(
    (results.removal as { ok: boolean }).ok,
    true,
    "the removal was refused although the recorded expectation settles the survivor",
  );
  assert.equal(results.lifecycle, "archived", "the served removal did not reach the durable row");
  assert.equal(
    results.mountedThreadId,
    results.survivorThreadId,
    "the next start did not mount the survivor the expectation named, so the expectation never was an admission",
  );
  assert.equal(results.survivorContentState, "verified", "the settlement did not verify the survivor's content");
  assert.equal(results.pendingSelection, null, "the settlement left the expectation pending");
});

/**
 * Two removals issued in one tick are the shape the empty-list rule used to miss.
 *
 * The refusal was a read in front of the write: both requests listed the threads before either had
 * written, each saw the other's Chat still live, and both archived - emptying the list, which is the
 * state the next start cannot recover from. It is now the removal's own transaction that judges it,
 * so the loser reads the winner's committed rows.
 */
test("two removals issued in one tick cannot leave the companion with no active Chat", async () => {
  const results = await mounted(`
    const other = { chatThreadId: "chat-" + "7".repeat(16), chatSurfaceSessionId: "surface-" + "7".repeat(16) };
    await createChat(other.chatThreadId, other.chatSurfaceSessionId);
    // Both Chats are opened first, so the pair of removals is about the empty list alone and not
    // about the unmountable-survivor rule.
    await selectChat(other.chatThreadId, other.chatSurfaceSessionId, lease.browserProjection.selectionGeneration);
    const migrated = await authority.startMountedChatRuntime();
    const serviceOnSuccessor = createChatManagementService({ manifest, lease: migrated, profile, chatCatalog: shared.catalog });
    const servedHandle = migrated.browserProjection.projectChatHandle(lease.chatThreadId, lease.chatSurfaceSessionId);
    const outcomes = await Promise.all([
      code(() => serviceOnSuccessor.transitionLifecycle({ apiVersion: 1, chatHandle: servedHandle, expectedManagementRevision: 1, operation: "archive" })),
      code(() => serviceOnSuccessor.transitionLifecycle({ apiVersion: 1, chatHandle: migrated.browserProjection.chatHandle, expectedManagementRevision: 1, operation: "archive" })),
    ]);
    const live = (await serviceOnSuccessor.listChats({ apiVersion: 1, state: "active" })).chats.length;
    process.stdout.write(JSON.stringify({ outcomes, live }));
    await serviceOnSuccessor.close();
    await service.close();
    await migrated.close();
    await lease.close();
    await shared.close();
  `);
  const outcomes = results.outcomes as readonly { ok: boolean; error?: string }[];
  assert.equal(
    outcomes.filter((outcome) => outcome.ok).length,
    1,
    "both removals committed, so the companion was left with no Chat the next start could mount",
  );
  assert.deepEqual(
    outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.error),
    ["chat_active_list_empty"],
    "the losing removal was refused as something other than the empty list",
  );
  assert.equal(results.live, 1, "the active list did not end with exactly one Chat");
});

/**
 * THE GATE: no removal the library offers can leave the companion with no live Chat.
 *
 * The population is DERIVED, not listed. Every operation the service itself exports is invoked with a
 * removal command and observed against the durable lifecycle row that command names; an operation that
 * moves that row is a removal path, whatever it is called, so one added tomorrow joins the population
 * without anyone remembering to add it here. Each discovered path is then crossed with the states a
 * removal can be issued from - the last live Chat, a live sibling, an archived sibling, a trashed
 * sibling, an illegal transition - and every case must either leave at least one live Chat or be
 * refused under a code the caller can act on. Two passes of the whole population are compared, because
 * a gate standing on an unrepeatable harness is a gate that will flake later.
 *
 * `mountableSurvivors` is the SEMANTIC authority's own answer for the Chats this removal left behind -
 * a row the catalog holds as verified, which is exactly what the next start's successor settlement
 * requires and the transcript authority alone cannot see. An accepted removal that leaves a
 * non-empty list with none of them mountable is the brick: the next start fails closed with
 * `semantic_chat_liveness_unrecoverable` before a browser exists, so this gate fails that reading
 * rather than printing it.
 */
test("a_removal_leaves_the_companion_no_chat: every removal path leaves a live Chat or is refused by name", async (t) => {
  const results = await mounted(`
    const apiVersion = 1;
    const companionId = "companion_01";
    const continuityId = "continuity_01";
    const mountedThreadId = lease.chatThreadId;
    const mountedHandle = lease.browserProjection.chatHandle;
    const threads = store();
    const creation = createProfileAwareChatThreadCreationCapability(threads, { async readExact() { return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) }; } });
    const threadIdOf = new Map([[mountedHandle, mountedThreadId]]);
    let made = 0;

    const rows = async () => (await threads.listThreads()).filter((thread) => thread.companionId === companionId && thread.continuityId === continuityId);
    const rowOf = async (chatHandle) => (await rows()).find((thread) => thread.chatThreadId === threadIdOf.get(chatHandle));
    const liveThreadIds = async () => (await rows()).filter((thread) => (thread.lifecycleStatus ?? "active") === "active").map((thread) => thread.chatThreadId);
    const archived = async (chatThreadId, operation) => {
      const row = (await rows()).find((thread) => thread.chatThreadId === chatThreadId);
      await threads.transitionLifecycle({ chatThreadId, chatSurfaceSessionId: row.chatSurfaceSessionId, companionId, continuityId, expectedManagementRevision: row.managementRevision ?? 1, operation });
    };

    const makeSibling = async (kind) => {
      made += 1;
      const suffix = String(made).padStart(3, "0");
      const chatThreadId = "gate_thread_" + suffix;
      const chatSurfaceSessionId = "gate_surface_" + suffix;
      await creation.createExplicit({
        chatThreadId, companionId, continuityId, chatSurfaceSessionId,
        profileId: "profile_01", profileRevision: 1, profileCanonicalHash: "a".repeat(64),
        opening: { messageId: "gate_opening_" + suffix, text: "Chat " + suffix, source: { greetingSetId: "greetings_01", sourceRevision: 2, canonicalHash: "a".repeat(64), variantId: "default_01", profileRevision: 3, scenarioRevision: null } },
      });
      const handle = lease.browserProjection.projectChatHandle(chatThreadId, chatSurfaceSessionId);
      threadIdOf.set(handle, chatThreadId);
      if (kind !== "active") await archived(chatThreadId, kind === "archived" ? "archive" : "trash");
      return { handle, chatThreadId, chatSurfaceSessionId };
    };

    const issue = async (operationName, chatHandle, operation) => {
      const row = await rowOf(chatHandle);
      const expectedManagementRevision = row === undefined ? 1 : (row.managementRevision ?? 1);
      try {
        await service[operationName]({ apiVersion, chatHandle, expectedManagementRevision, operation });
        return { outcome: "ok", code: null };
      } catch (error) {
        return { outcome: "refused", code: error instanceof Error ? error.message : String(error) };
      }
    };

    const read = async (operationName, caseId, outcome) => {
      const live = await liveThreadIds();
      // The semantic authority's own answer for the survivors, not a second list written here: a Chat
      // it holds as verified is one the next start's successor settlement can actually mount.
      const verified = new Set(
        (await shared.catalog.readChatCatalog()).threads
          .filter((thread) => thread.contentState === "verified")
          .map((thread) => thread.chatThreadId),
      );
      return {
        path: operationName,
        case: caseId,
        outcome: outcome.outcome,
        code: outcome.code,
        live: live.length,
        survivors: live.map((chatThreadId) => (chatThreadId === mountedThreadId ? "mounted" : "created")),
        mountableSurvivors: live.filter((chatThreadId) => verified.has(chatThreadId)).length,
      };
    };

    // Discovery: the service's own exported operations, each asked to perform a removal.
    const probe = createChatManagementService({ manifest, lease, profile, chatCatalog: shared.catalog });
    const operations = Object.keys(probe);
    const removalPaths = [];
    const discovery = [];
    for (const operationName of operations) {
      const target = await makeSibling("active");
      const before = (await rowOf(target.handle)).lifecycleStatus ?? "active";
      let outcome;
      try {
        await probe[operationName]({ apiVersion, chatHandle: target.handle, expectedManagementRevision: 1, operation: "archive" });
        outcome = "ok";
      } catch (error) {
        outcome = error instanceof Error ? error.message : String(error);
      }
      const after = (await rowOf(target.handle)).lifecycleStatus ?? "active";
      if (after !== before) removalPaths.push(operationName);
      else if (after === "active") await archived(target.chatThreadId, "archive");
      discovery.push({ operation: operationName, outcome, lifecycle: before + "->" + after });
    }

    const cases = [
      { id: "last_live:archive", run: async (path) => read(path, "last_live:archive", await issue(path, mountedHandle, "archive")) },
      { id: "last_live:trash", run: async (path) => read(path, "last_live:trash", await issue(path, mountedHandle, "trash")) },
      {
        id: "last_live_with_archived_sibling:archive",
        run: async (path) => {
          await makeSibling("archived");
          return read(path, "last_live_with_archived_sibling:archive", await issue(path, mountedHandle, "archive"));
        },
      },
      {
        id: "last_live_with_trashed_sibling:trash",
        run: async (path) => {
          await makeSibling("trashed");
          return read(path, "last_live_with_trashed_sibling:trash", await issue(path, mountedHandle, "trash"));
        },
      },
      {
        id: "two_live:archive_mounted",
        run: async (path) => {
          const sibling = await makeSibling("active");
          const outcome = await issue(path, mountedHandle, "archive");
          const result = await read(path, "two_live:archive_mounted", outcome);
          // Leave the live set exactly as this case found it, whichever way it answered: the sibling
          // it created is the next case's business, and a case that keeps its own leftovers is how
          // the two population passes stop being comparable.
          if (outcome.outcome === "ok") await issue(path, mountedHandle, "restore");
          await archived(sibling.chatThreadId, "archive");
          return result;
        },
      },
      {
        id: "two_live:archive_sibling",
        run: async (path) => {
          const sibling = await makeSibling("active");
          return read(path, "two_live:archive_sibling", await issue(path, sibling.handle, "archive"));
        },
      },
      {
        id: "archived_sibling:trash",
        run: async (path) => {
          const sibling = await makeSibling("archived");
          return read(path, "archived_sibling:trash", await issue(path, sibling.handle, "trash"));
        },
      },
      {
        id: "archived_sibling:restore",
        run: async (path) => {
          const sibling = await makeSibling("archived");
          const result = await read(path, "archived_sibling:restore", await issue(path, sibling.handle, "restore"));
          await archived(sibling.chatThreadId, "archive");
          return result;
        },
      },
      {
        id: "trashed_sibling:restore",
        run: async (path) => {
          const sibling = await makeSibling("trashed");
          const outcome = await issue(path, sibling.handle, "restore");
          const result = await read(path, "trashed_sibling:restore", outcome);
          if (outcome.outcome === "ok") await archived(sibling.chatThreadId, "archive");
          return result;
        },
      },
      {
        id: "archived_sibling:archive",
        run: async (path) => {
          const sibling = await makeSibling("archived");
          return read(path, "archived_sibling:archive", await issue(path, sibling.handle, "archive"));
        },
      },
    ];

    const population = async () => {
      const readings = [];
      for (const entry of cases) for (const operationName of removalPaths) readings.push(await entry.run(operationName));
      return readings;
    };
    const first = await population();
    const second = await population();

    process.stdout.write(JSON.stringify({ operations, removalPaths, discovery, first, second }));
    await service.close();
    await lease.close();
    await shared.close();
  `);

  const operations = results.operations as string[];
  const removalPaths = results.removalPaths as string[];
  const readings = results.first as ReadonlyArray<{
    path: string;
    case: string;
    outcome: "ok" | "refused";
    code: string | null;
    live: number;
    survivors: readonly string[];
    mountableSurvivors: number;
  }>;
  const name = (reading: { path: string; case: string }): string => `${reading.path}:${reading.case}`;
  const unmountableSuccessor = (code: string | null): boolean =>
    code !== null && code.startsWith("chat_successor_unmountable:");

  // A population that discovered nothing agrees with itself, so it is blocked rather than passed.
  assert.ok(
    operations.length > 0,
    "a_removal_leaves_the_companion_no_chat: the service exported no operation to examine",
  );
  assert.ok(
    removalPaths.length > 0,
    `a_removal_leaves_the_companion_no_chat: no operation of ${operations.join(", ")} moved a Chat out of the active list`,
  );
  // A gate on an unrepeatable harness is a gate that flakes later, so the two passes are compared -
  // after the substance, so that a red names the defect rather than this.

  const offenders = readings.filter((reading) => reading.outcome === "ok" && reading.live === 0).map(name);
  assert.deepEqual(
    offenders,
    [],
    `a_removal_leaves_the_companion_no_chat: ${offenders.join(", ")} left the companion with no live Chat`,
  );
  const unnamed = readings
    .filter(
      (reading) =>
        reading.outcome === "refused" &&
        reading.code !== "chat_active_list_empty" &&
        reading.code !== "chat_management_lifecycle_invalid" &&
        !unmountableSuccessor(reading.code),
    )
    .map((reading) => `${name(reading)}=${reading.code}`);
  assert.deepEqual(
    unnamed,
    [],
    `a_removal_leaves_the_companion_no_chat: ${unnamed.join(", ")} was refused as a service outage instead of by rule`,
  );
  // THE BRICK ITSELF: an accepted removal that leaves Chats behind and not one the semantic authority
  // could mount. This is the reading the next start turns into `semantic_chat_liveness_unrecoverable`
  // before a browser exists, so a route that allows it has bricked the root.
  const bricked = readings
    .filter((reading) => reading.outcome === "ok" && reading.live > 0 && reading.mountableSurvivors === 0)
    .map(name);
  assert.deepEqual(
    bricked,
    [],
    `a_removal_leaves_the_companion_no_chat: ${bricked.join(", ")} left only Chats the next start could not mount`,
  );
  // The rule must be witnessed, and it must refuse only the removal that would empty the list.
  const refused = readings.filter((reading) => reading.code === "chat_active_list_empty").length;
  assert.ok(refused > 0, "a_removal_leaves_the_companion_no_chat: the population never reached the empty-list rule");
  const unmountable = readings.filter((reading) => unmountableSuccessor(reading.code)).length;
  assert.ok(
    unmountable > 0,
    "a_removal_leaves_the_companion_no_chat: the population never reached the unmountable-successor rule, so this gate does not hold it",
  );
  assert.ok(
    readings.some((reading) => reading.outcome === "ok"),
    "a_removal_leaves_the_companion_no_chat: every removal was refused, so the guard refuses the batch rather than the one removal",
  );
  assert.deepEqual(
    results.second,
    results.first,
    "a_removal_leaves_the_companion_no_chat: the two population passes disagreed",
  );
  t.diagnostic(
    `a_removal_leaves_the_companion_no_chat: removals examined ${readings.length} · refused by the empty list ${refused} · by the unmountable successor ${unmountable} · leaves-none ${offenders.length} · leaves-only-unmountable ${bricked.length}`,
  );

  // The list read is the only way the surface reaches a Chat, so its ceiling is read from the contract
  // that carries it and its truncation sites from the projection that builds it. "It holds by
  // construction" stops being true the day someone adds a cap, and this is what would notice.
  const listBound = (ChatListV1Schema.properties.chats as unknown as { readonly maxItems?: number }).maxItems ?? null;
  const { shape: serviceSource } = readSourceShape(new URL("./chat-management-service.js", import.meta.url));
  const listReadStart = serviceSource.indexOf("const listChats = async");
  const listReadEnd = serviceSource.indexOf("const readDraft = async");
  assert.ok(
    listReadStart >= 0 && listReadEnd > listReadStart,
    "a_removal_leaves_the_companion_no_chat: the list read is not where this gate reads it, so its truncation sites were not measured",
  );
  const truncationSites =
    serviceSource.slice(listReadStart, listReadEnd).match(/\.(?:slice|splice|toSpliced)\s*\(/gu) ?? [];
  t.diagnostic(
    `a_removal_leaves_the_companion_no_chat: list bound: ${listBound === null ? "none" : String(listBound)} · truncation sites: ${truncationSites.length}`,
  );
  assert.deepEqual(
    truncationSites,
    [],
    "a_removal_leaves_the_companion_no_chat: the list read truncates instead of refusing a list it cannot return whole",
  );
});
