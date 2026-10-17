/**
 * Current product fact, so no reader has to rediscover it:
 *
 * every fresh Chat is created already settled on the companion's OWN card book
 * (`gamebuddy-worldbook-default-companion`, a `world_book`-family binding), and
 * the single binding slot cannot hold a `managed_world_info` desired binding
 * over it (`chat-thread-store.ts` `writeWorldInfoBinding` refuses a mixed
 * source family). So a managed bind cannot take the slot today, and the mounted
 * World Info panel renders an Attach that cannot succeed. This file's tests that
 * bind a managed item therefore establish that precondition through the public
 * store/coordinator seams first; see also the collision test at the bottom and
 * `.pi/tools/binding-fixture-progress.md`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import type { MountedChatRuntimeLease } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import {
  composeTavernProfile,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
} from "../browser-contract/index.js";
import { createWorldInfoBindingManagementService } from "./world-info-binding-management-service.js";
import { canonicalHash } from "../artifact-store.js";

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

function worldInfoProfile(options: { withWorldInfo: boolean } = { withWorldInfo: true }) {
  return composeTavernProfile({
    profileId: "gamebuddy.tavern-management.world-info-binding",
    releaseTier: "tavern_management",
    routeIds: options.withWorldInfo
      ? ["bootstrap", "state.read", "chat.list", "chat.rename", "world-info.read", "world-info.bind"]
      : ["bootstrap", "state.read", "chat.list", "chat.rename"],
    operationIds: options.withWorldInfo ? ["chat.rename", "world-info.bind"] : ["chat.rename"],
    navigationItemIds: ["chat"],
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

test("binding service rejects forged leases, non-composed profiles and profiles without world-info.bind", async () => {
  const root = await canonicalTestRoot("gamebuddy-world-info-forged-");
  try {
    const forged = forgedLease();
    assert.throws(
      () =>
        createWorldInfoBindingManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: worldInfoProfile(),
          repository: {} as never,
        }),
      /world_info_binding_service_unavailable/,
    );
    assert.throws(
      () =>
        createWorldInfoBindingManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: Object.freeze({ ...worldInfoProfile() }),
          repository: {} as never,
        }),
      /world_info_binding_service_unavailable/,
    );
    assert.throws(
      () =>
        createWorldInfoBindingManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: worldInfoProfile({ withWorldInfo: false }),
          repository: {} as never,
        }),
      /world_info_binding_service_unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const mountPreamble = `
  const [serviceUrl, coordinatorUrl, deploymentUrl, storeUrl, runtimeUrl, contractUrl, repoUrl, root] = process.argv.slice(1);
  const { writeFile } = await import("node:fs/promises");
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  const manifestPath = root + "/manifest.json";
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, topology: "independent_chat_and_game_surfaces", runtimeRoot: root, principal, bootstrapOperationId: "bootstrap_01", authorityGeneration: 1 }));
  const { loadHostDeploymentManifest } = await import(deploymentUrl);
  const coordinator = await import(coordinatorUrl);
  const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = coordinator;
  const { createWorldInfoManagementRepository } = await import(repoUrl);
  const { createWorldInfoBindingManagementService } = await import(serviceUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { composeTavernProfile } = await import(contractUrl);
  const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", storeUrl).href);
  const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", storeUrl).href);
  await bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const { acknowledgeMountedWorldInfoBinding } = await import(storeUrl);
  const { createMountedTurnTransitionAuthority } = await import(new URL("./chat-thread-store.mounted-turn-transition.internal.js", storeUrl).href);
  const settleMounted = async () => {
    const settledState = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await applyMounted(settledState.thread.worldBookBinding, settledState.thread.appliedWorldBookBinding);
  };
  const applyMounted = async (binding, expectedOldAppliedBinding) => {
    const transition = createMountedTurnTransitionAuthority();
    const operation = transition.mintOperation();
    try {
      return await acknowledgeMountedWorldInfoBinding({ authority: transition.authority, operationAuthority: operation.authority, runtimeRoot: root, playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01", chatThreadId: lease.chatThreadId, chatSurfaceSessionId: lease.chatSurfaceSessionId, binding, expectedOldAppliedBinding });
    } finally {
      operation.revoke();
      transition.revoke();
    }
  };
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const repository = createWorldInfoManagementRepository(root);
  await repository.create({ publicTitle: "Pelican Town", summary: "A small valley town.", entries: [{ scope: "setting", publicTitle: "Square", summary: "Town center." }] });
  const profile = composeTavernProfile({ profileId: "gamebuddy.tavern-management.world-info-binding", releaseTier: "tavern_management", routeIds: ["bootstrap", "state.read", "chat.list", "chat.rename", "world-info.read", "world-info.bind"], operationIds: ["chat.rename", "world-info.bind"], navigationItemIds: ["chat"] });
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const lease = await authority.startMountedChatRuntime();
  const mountSettle = process.env.GAMEBUDDY_MOUNT_SETTLE === "1";
  const service = createWorldInfoBindingManagementService({
    manifest,
    lease,
    profile,
    repository,
    ...(mountSettle ? { settleAuthoredContext: settleMounted } : {}),
  });
  const store = () => createChatThreadStore(root, identityKey(principal));
  const code = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } };
  const generation = lease.browserProjection.selectionGeneration;
`;

async function runMountedChild(body: string, root: string): Promise<Record<string, unknown>> {
  const serviceUrl = new URL("./world-info-binding-management-service.js", import.meta.url).href;
  const coordinatorUrl = new URL(
    "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
    import.meta.url,
  ).href;
  const deploymentUrl = new URL("../../deployment-manifest.js", import.meta.url).href;
  const storeUrl = new URL("../chat-thread-store.js", import.meta.url).href;
  const runtimeUrl = new URL("../../runtime.js", import.meta.url).href;
  const contractUrl = new URL("../browser-contract/index.js", import.meta.url).href;
  const repoUrl = new URL("../world-info-management/world-info-management.js", import.meta.url).href;
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
      repoUrl,
      root,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, GAMEBUDDY_MOUNT_SETTLE: process.env.GAMEBUDDY_MOUNT_SETTLE ?? "0" },
    },
  );
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const [exitCode] = (await once(child, "exit")) as [number | null];
  assert.equal(exitCode, 0, Buffer.concat(errors).toString("utf8"));
  return JSON.parse(Buffer.concat(output).toString("utf8")) as Record<string, unknown>;
}

async function mounted(body: string): Promise<Record<string, unknown>> {
  const root = await canonicalTestRoot("gamebuddy-world-info-service-");
  try {
    return await runMountedChild(body, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("mounted binding service binds and unbinds the exact immutable revision with durable read-back", async () => {
  const results = await mounted(`
    const first = await service.read();
    const initialItem = first.items[0];
    const bind = await service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: initialItem.handle });
    const selectedItem = bind.items.find((item) => item.pending === true);
    // Only the coordinator adapter may mint applied state. Establish the
    // applied revision through the acknowledged world-info binding seam so
    // the browser lifecycle under test observes desired != applied.
    const durable = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await applyMounted(durable.thread.worldBookBinding, undefined);
    const staleBind = await code(() => service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: initialItem.handle }));
    const afterBindRead = await service.read();
    const unbind = await service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: afterBindRead.revision, sourceHandle: null });
    const durableAfterUnbind = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    const afterUnbindRead = await service.read();
    process.stdout.write(JSON.stringify({
      first,
      initialItem,
      bind,
      selectedItem,
      durableBinding: durable.thread.worldBookBinding,
      appliedBinding: durableAfterUnbind.thread.appliedWorldBookBinding,
      staleBind,
      afterBindRead,
      unbind,
      durableAfterUnbindBinding: durableAfterUnbind.thread.worldBookBinding,
      afterUnbindRead,
      protective: { rawIds: [lease.chatThreadId, lease.chatSurfaceSessionId, "thread_02", "surface_02", "companion_01", "continuity_01"] },
    }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  const first = results.first as { state: string; revision: string; items: ReadonlyArray<Record<string, unknown>> };
  assert.equal(first.state, "none");
  assert.equal(first.items.length, 1);
  // Opaque handles/revision: never the public title, never a numeric
  // timestamp, always the canonical opaque base64url handle format the
  // command validator (`isOpaqueHandle`) accepts. Assert the actual fields,
  // not the JSON-serialized object.
  const initialItem = first.items[0] as { handle: string; title: string; selected: boolean };
  assert.equal(initialItem.handle.includes("Pelican Town"), false);
  assert.equal(first.revision.includes("Pelican Town"), false);
  assert.match(initialItem.handle, /^[A-Za-z0-9_-]{22,128}$/u);
  assert.match(first.revision, /^[A-Za-z0-9_-]{22,128}$/u);
  assert.doesNotMatch(initialItem.handle, /\d{10,}/u);
  assert.doesNotMatch(first.revision, /\d{10,}/u);
  assert.equal(initialItem.title, "Pelican Town");
  assert.equal(initialItem.selected, false);

  const bind = results.bind as { state: string; revision: string; items: ReadonlyArray<Record<string, unknown>> };
  assert.equal(bind.state, "pending");
  assert.equal(bind.items.filter((item) => item.selected === true).length, 0);
  assert.equal(bind.items.filter((item) => item.pending === true).length, 1);
  const selectedItem = results.selectedItem as { handle: string; title: string; selected: boolean; pending: boolean };
  assert.equal(selectedItem.title, "Pelican Town");
  assert.equal(selectedItem.selected, false);
  assert.equal(selectedItem.pending, true);
  const durableBinding = results.durableBinding as { source: string; publicTitle: string; revision: number };
  assert.equal(durableBinding.source, "managed_world_info");
  assert.equal(durableBinding.revision, 1);
  // The old opaque revision handle is now superseded (updatedAtMs changed).
  assert.equal((results.staleBind as { error: string }).error, "world_info_binding_conflict");
  const unbind = results.unbind as { state: string; items: ReadonlyArray<{ pending: boolean }> };
  assert.equal(unbind.state, "pending");
  assert.equal(unbind.items.filter((item) => item.pending).length, 1);
  assert.equal(results.durableAfterUnbindBinding, undefined);
  const appliedAfterUnbind = results.appliedBinding as
    | { source: string; publicTitle: string; revision: number }
    | undefined;
  assert.ok(appliedAfterUnbind);
  assert.equal(appliedAfterUnbind.source, "managed_world_info");
  assert.equal(appliedAfterUnbind.revision, 1);
  assert.equal((results.afterUnbindRead as { state: string }).state, "pending");
  const durable = JSON.stringify({
    first: results.first,
    bind: results.bind,
    unbind: results.unbind,
    afterBindRead: results.afterBindRead,
  });
  for (const raw of (results.protective as { rawIds: string[] }).rawIds)
    assert.equal(durable.includes(raw), false, `raw durable identity leaked: ${raw}`);
  // The durable binding canonical hash must never reach the browser projection.
  const durableHash = (results.durableBinding as { canonicalHash?: string } | undefined)?.canonicalHash;
  if (durableHash !== undefined)
    assert.equal(durable.includes(durableHash), false, "durable binding hash leaked into browser projection");
});

test("mounted binding service reports pending after changing World Info behind a durable transcript", async () => {
  const results = await mounted(`
    const first = await service.read();
    const item = first.items[0];
    const bind = await service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: item.handle });
    await store().appendPlayer(lease.chatThreadId, { messageId: "msg_0001", text: "A durable player note.", occurredAtMs: Date.now() });
    const lockedRead = await service.read();
    // The pending desired binding is retained behind the transcript; the
    // coordinator establishes applied only through the acknowledged seam.
    const boundDurable = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await applyMounted(boundDurable.thread.worldBookBinding, undefined);
    const lockedUnbind = await code(() => service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: lockedRead.revision, sourceHandle: null }));
    const durableAfterLock = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    process.stdout.write(JSON.stringify({
      lockedRead,
      lockedUnbind,
      durableAfterLockMessages: durableAfterLock.messages.length,
       durableAfterLockBinding: durableAfterLock.thread.worldBookBinding,
       durableAfterLockAppliedBinding: durableAfterLock.thread.appliedWorldBookBinding,
    }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.lockedRead as { state: string }).state, "pending");
  assert.equal((results.lockedUnbind as { ok: boolean }).ok, true);
  assert.equal(results.durableAfterLockMessages, 1);
  const binding = results.durableAfterLockBinding as
    | { source: string; publicTitle: string; revision: number }
    | undefined;
  assert.equal(binding, undefined);
  const applied = results.durableAfterLockAppliedBinding as
    | { source: string; publicTitle: string; revision: number }
    | undefined;
  assert.ok(applied);
  assert.equal(applied.source, "managed_world_info");
  assert.equal(applied.revision, 1);
});

test("mounted binding service serves the library write half through the exact projection", async () => {
  const results = await mounted(`
    const { readFile, readdir } = await import("node:fs/promises");
    const initial = await service.read();
    const created = await service.create({ apiVersion: 1, selectionGeneration: generation, expectedRevision: initial.revision, item: { publicTitle: "Stardew Valley", summary: "A larger valley.", entries: [{ scope: "setting", publicTitle: "Bus Stop", summary: "Town entrance." }] } });
    const createdItem = created.items.find((item) => item.title === "Stardew Valley");
    const detail = await service.detail({ apiVersion: 1, selectionGeneration: generation, expectedRevision: created.revision, itemHandle: createdItem.handle });
    // Both a superseded projection handle and a handle from a different
    // projection conflict before any repository I/O.
    const staleDetail = await code(() => service.detail({ apiVersion: 1, selectionGeneration: generation, expectedRevision: initial.revision, itemHandle: createdItem.handle }));
    const foreignHandle = await code(() => service.delete({ apiVersion: 1, selectionGeneration: generation, expectedRevision: created.revision, itemHandle: initial.items[0].handle }));
    const updated = await service.update({ apiVersion: 1, selectionGeneration: generation, expectedRevision: created.revision, itemHandle: createdItem.handle, item: { expectedRevision: 1, publicTitle: "Stardew Valley", summary: "A larger valley, revised.", entries: [{ scope: "setting", publicTitle: "Bus Stop", summary: "Town entrance, revised." }] } });
    const updatedItem = updated.items.find((item) => item.title === "Stardew Valley");
    const detailAfterUpdate = await service.detail({ apiVersion: 1, selectionGeneration: generation, expectedRevision: updated.revision, itemHandle: updatedItem.handle });
    const staleDelete = await code(() => service.delete({ apiVersion: 1, selectionGeneration: generation, expectedRevision: created.revision, itemHandle: createdItem.handle }));
    const removed = await service.delete({ apiVersion: 1, selectionGeneration: generation, expectedRevision: updated.revision, itemHandle: updatedItem.handle });
    const final = await service.read();
    const revisionsRoot = root + "/world-info-management/revisions";
    const handles = await readdir(revisionsRoot);
    const catalog = JSON.parse(await readFile(root + "/world-info-management/catalog.json", "utf8"));
    const disk = {};
    for (const handle of handles) {
      const files = await readdir(revisionsRoot + "/" + handle);
      disk[handle] = { files };
      for (const file of files) disk[handle][file] = JSON.parse(await readFile(revisionsRoot + "/" + handle + "/" + file, "utf8"));
    }
    process.stdout.write(JSON.stringify({ initial, created, detail, staleDetail, foreignHandle, updated, detailAfterUpdate, staleDelete, removed, final, catalog, handles, disk }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.initial as { items: readonly unknown[] }).items.length, 1);
  assert.equal((results.created as { items: readonly unknown[] }).items.length, 2);
  const detail = results.detail as {
    publicTitle: string;
    revision: number;
    entries: readonly { publicTitle: string; summary: string }[];
  };
  assert.equal(detail.publicTitle, "Stardew Valley");
  assert.equal(detail.revision, 1);
  assert.equal(detail.entries[0]?.summary, "Town entrance.");
  assert.equal((results.staleDetail as { error: string }).error, "world_info_binding_conflict");
  assert.equal((results.foreignHandle as { error: string }).error, "world_info_binding_conflict");
  const detailAfterUpdate = results.detailAfterUpdate as { publicTitle: string; revision: number; summary: string };
  assert.equal(detailAfterUpdate.revision, 2);
  assert.equal(detailAfterUpdate.summary, "A larger valley, revised.");
  assert.equal((results.staleDelete as { error: string }).error, "world_info_binding_conflict");
  assert.deepEqual(
    (results.removed as { items: readonly { title: string }[] }).items.map((item) => item.title),
    ["Pelican Town"],
  );
  assert.deepEqual(
    (results.final as { items: readonly { title: string }[] }).items.map((item) => item.title),
    ["Pelican Town"],
  );
  // The immutable revision files for the deleted item are retained on disk and
  // still verify against their own canonical hashes.
  const catalog = results.catalog as { artifacts: readonly { handle: string; publicTitle: string }[] };
  assert.deepEqual(
    catalog.artifacts.map((artifact) => artifact.publicTitle),
    ["Pelican Town"],
  );
  const disk = results.disk as Record<string, { files: string[]; [file: string]: unknown }>;
  const catalogHandles = new Set(catalog.artifacts.map((artifact) => artifact.handle));
  const deletedHandle = Object.keys(disk).find((handle) => !catalogHandles.has(handle));
  assert.ok(deletedHandle, "the deleted item's revision directory must survive the catalog removal");
  const retained = disk[deletedHandle]!;
  assert.deepEqual([...retained.files].sort(), ["1.json", "2.json"]);
  for (const file of ["1.json", "2.json"] as const) {
    const envelope = retained[file] as { canonicalHash: string; artifact: unknown };
    assert.equal(canonicalHash(envelope.artifact), envelope.canonicalHash, `${file} must still verify after delete`);
  }
});

test("mounted binding service refuses a removal or rename of an item the mounted Chat binds", async () => {
  const results = await mounted(`
    // A freshly mounted Chat may already carry a default world_book applied
    // binding, and a managed binding cannot replace another source family.
    // Clear both through the public store/coordinator seams so the exact case
    // under test - a mounted Chat bound to a managed library item - exists.
    const s0 = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await store().setWorldBookBinding({ chatThreadId: lease.chatThreadId, chatSurfaceSessionId: lease.chatSurfaceSessionId, companionId: "companion_01", continuityId: "continuity_01", expectedUpdatedAtMs: s0.thread.updatedAtMs });
    const s1 = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    await applyMounted(undefined, s1.thread.appliedWorldBookBinding);
    const first = await service.read();
    await service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: first.items[0].handle });
    const boundRead = await service.read();
    const bound = boundRead.items[0];
    const refusedDelete = await code(() => service.delete({ apiVersion: 1, selectionGeneration: generation, expectedRevision: boundRead.revision, itemHandle: bound.handle }));
    const refusedRename = await code(() => service.update({ apiVersion: 1, selectionGeneration: generation, expectedRevision: boundRead.revision, itemHandle: bound.handle, item: { expectedRevision: 1, publicTitle: "Renamed Town", summary: "A small valley town.", entries: [{ scope: "setting", publicTitle: "Square", summary: "Town center." }] } }));
    // A content-only update keeps the public title, so the binding still resolves.
    await service.update({ apiVersion: 1, selectionGeneration: generation, expectedRevision: boundRead.revision, itemHandle: bound.handle, item: { expectedRevision: 1, publicTitle: "Pelican Town", summary: "A small valley town, revised.", entries: [{ scope: "setting", publicTitle: "Square", summary: "Town center." }] } });
    const afterUpdate = await service.read();
    await service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: afterUpdate.revision, sourceHandle: null });
    const afterUnbind = await service.read();
    const removed = await service.delete({ apiVersion: 1, selectionGeneration: generation, expectedRevision: afterUnbind.revision, itemHandle: afterUnbind.items[0].handle });
    const final = await service.read();
    process.stdout.write(JSON.stringify({ refusedDelete, refusedRename, afterUpdateCount: afterUpdate.items.length, removed, final }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.refusedDelete as { error: string }).error, "world_info_in_use");
  assert.equal((results.refusedRename as { error: string }).error, "world_info_in_use");
  assert.equal(results.afterUpdateCount, 1);
  const removed = results.removed as { items: readonly unknown[] };
  assert.equal(removed.items.length, 0);
  assert.equal((results.final as { items: readonly unknown[] }).items.length, 0);
});

test("mounted binding service cannot take the binding slot with a managed item while the companion's own book is applied", async () => {
  // CURRENT BEHAVIOR, pinned only so the collision cannot be rediscovered
  // silently - NOT a claim that the refusal is desirable. A fresh Chat is
  // created already settled on the companion's own card book, and the single
  // binding slot refuses a managed desired binding over a `world_book` applied
  // one. The World Info panel's projection says "none"/nothing selected while
  // that book is what the turn's authored context actually carries, so its
  // Attach cannot succeed. This test must be REVISED when the slot decision
  // lands - whether her book belongs in the binding slot at all (a separate
  // default channel or a second slot) or whether a managed bind displaces it.
  // Decision thread and full evidence: `.pi/tools/binding-fixture-progress.md`.
  const results = await mounted(`
    const first = await service.read();
    const attempted = await code(() => service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: first.items[0].handle }));
    const durable = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    process.stdout.write(JSON.stringify({ firstState: first.state, firstSelectedCount: first.items.filter((item) => item.selected).length, firstItemTitle: first.items[0].title, attempted, durableBinding: durable.thread.worldBookBinding, durableApplied: durable.thread.appliedWorldBookBinding, durableMessages: durable.messages.length }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal(results.firstState, "none");
  assert.equal(results.firstSelectedCount, 0);
  assert.equal(results.firstItemTitle, "Pelican Town");
  assert.equal((results.attempted as { error: string }).error, "world_info_binding_conflict");
  const durableBinding = results.durableBinding as { worldBookId: string; revision: number; provenance: string };
  assert.equal(durableBinding.worldBookId, "gamebuddy-worldbook-default-companion");
  assert.equal(durableBinding.revision, 1);
  assert.equal(durableBinding.provenance, "reviewed-import");
  assert.equal("source" in (durableBinding as Record<string, unknown>), false);
  assert.deepEqual(results.durableApplied, results.durableBinding);
  assert.equal(results.durableMessages, 1);
});

test("binding service source keeps store, resolver, lease and coordinator authority private", async () => {
  const source = await readFile(new URL("./world-info-binding-management-service.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/managed-world-info-binding\.js"/);
  assert.match(source, /from "\.\.\/chat-thread-store\.js"/);
  assert.doesNotMatch(
    source,
    /continuity-semantic-production-coordinator\.internal|transitionMountedProviderStart|transitionMountedPresentation/,
  );
  assert.doesNotMatch(source, /from ["'][^"']*(node:http|express|router|fetch)[^"']*["']/);
});

test("mounted binding service rejects a frozen structural profile clone before any durable I/O", async () => {
  const results = await mounted(`
    const clone = Object.freeze({ ...profile });
    const rejected = await code(() => createWorldInfoBindingManagementService({ manifest, lease, profile: clone, repository }));
    process.stdout.write(JSON.stringify({ rejected }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.rejected as { ok: boolean }).ok, false);
  assert.equal((results.rejected as { error: string }).error, "world_info_binding_service_unavailable");
});

test("mounted binding service scopes source handles to the exact current projection revision", async () => {
  const results = await mounted(`
    const first = await service.read();
    await repository.create({ publicTitle: "Stardew Valley", summary: "A larger valley.", entries: [{ scope: "setting", publicTitle: "Bus Stop", summary: "Town entrance." }] });
    const second = await service.read();
    const staleRevision = await code(() => service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: first.items[0].handle }));
    const staleHandleOnNewRevision = await code(() => service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: second.revision, sourceHandle: first.items[0].handle }));
    const fresh = await service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: second.revision, sourceHandle: second.items[0].handle });
    const durable = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    process.stdout.write(JSON.stringify({ first, second, staleRevision, staleHandleOnNewRevision, fresh, durableBinding: durable.thread.worldBookBinding, firstRevision: first.revision, secondRevision: second.revision }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  const first = results.first as { items: ReadonlyArray<{ handle: string }>; revision: string };
  const second = results.second as { items: ReadonlyArray<{ handle: string }>; revision: string };
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 2);
  assert.notEqual(results.firstRevision, results.secondRevision);
  // Old revision combined with its own old handle conflicts.
  assert.equal((results.staleRevision as { error: string }).error, "world_info_binding_conflict");
  // Old source handle combined with the newer revision conflicts.
  assert.equal((results.staleHandleOnNewRevision as { error: string }).error, "world_info_binding_conflict");
  const fresh = results.fresh as { state: string; items: ReadonlyArray<{ selected: boolean; pending: boolean }> };
  assert.equal(fresh.state, "pending");
  assert.equal(fresh.items.filter((item) => item.selected).length, 0);
  assert.equal(fresh.items.filter((item) => item.pending).length, 2);
  const durableBinding = results.durableBinding as { publicTitle: string; revision: number };
  assert.equal(durableBinding.publicTitle, "Pelican Town");
  assert.equal(durableBinding.revision, 1);
  // Every projection mints fresh opaque handles even for the same source.
  assert.notEqual(second.items[0]?.handle, first.items[0]?.handle);
});

test("mounted binding service rechecks the coordinator lease after bindExact and fails closed before durable mutation", async () => {
  const results = await mounted(`
    let closedDuringBind = false;
    const closingHistory = async (publicTitle) => {
      if (!closedDuringBind) {
        closedDuringBind = true;
        await lease.close().catch(() => undefined);
      }
      return repository.history(publicTitle);
    };
    const guardedRepository = Object.freeze({ ...repository, history: closingHistory });
    const guardedService = createWorldInfoBindingManagementService({ manifest, lease, profile, repository: guardedRepository });
    const before = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    const first = await guardedService.read();
    const attempted = await code(() => guardedService.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: first.items[0].handle }));
    const durable = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    process.stdout.write(JSON.stringify({ attempted, beforeBinding: before.thread.worldBookBinding, beforeMessages: before.messages.length, durableBinding: durable.thread.worldBookBinding, durableMessages: durable.messages.length, firstItemHandle: first.items[0].handle }));
    await guardedService.close();
    await service.close();
    await authority.close();
  `);
  assert.equal((results.attempted as { error: string }).error, "world_info_binding_service_unavailable");
  // A fresh Chat starts settled on the companion's own card book, so this
  // refusal's force is "no durable write", not "no binding": the slot must still
  // hold exactly her book, carry no managed binding, and gain no message.
  const beforeBinding = results.beforeBinding as { worldBookId: string; revision: number; provenance: string };
  assert.equal(beforeBinding.worldBookId, "gamebuddy-worldbook-default-companion");
  assert.equal(beforeBinding.revision, 1);
  assert.equal(beforeBinding.provenance, "reviewed-import");
  assert.deepEqual(results.durableBinding, results.beforeBinding);
  assert.equal("source" in (results.durableBinding as Record<string, unknown>), false);
  assert.equal(results.beforeMessages, 1);
  assert.equal(results.durableMessages, results.beforeMessages);
});

test("mounted binding service rejects a mutation superseded by a concurrent read projection without durable write", async () => {
  const results = await mounted(`
    let resolveEntered;
    let resolveRelease;
    const historyEntered = new Promise((resolve) => { resolveEntered = resolve; });
    const releaseHistory = new Promise((resolve) => { resolveRelease = resolve; });
    const gatedHistory = async (publicTitle) => {
      resolveEntered();
      await releaseHistory;
      return repository.history(publicTitle);
    };
    const guardedRepository = Object.freeze({ ...repository, history: gatedHistory });
    const guardedService = createWorldInfoBindingManagementService({ manifest, lease, profile, repository: guardedRepository });
    const before = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    const first = await guardedService.read();
    // Start a mutation on projection A and block it inside resolver.bindExact.
    const pending = guardedService.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: first.items[0].handle });
    await historyEntered;
    // While the mutation awaits the resolver, a concurrent read publishes a
    // superseding projection B without touching the durable thread.
    const superseding = await guardedService.read();
    resolveRelease();
    const attempted = await code(() => pending);
    const durable = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    process.stdout.write(JSON.stringify({ firstRevision: first.revision, supersedingRevision: superseding.revision, attempted, beforeBinding: before.thread.worldBookBinding, beforeMessages: before.messages.length, durableBinding: durable.thread.worldBookBinding, durableMessages: durable.messages.length }));
    await guardedService.close();
    await service.close();
    await lease.close();
    await authority.close();
  `);
  const firstRevision = results.firstRevision as string;
  const supersedingRevision = results.supersedingRevision as string;
  const attempted = results.attempted as { ok: boolean; error: string };
  assert.notEqual(supersedingRevision, firstRevision);
  // The captured projection A was superseded while the mutation awaited the
  // resolver: the mutation must fail closed without any durable write. A fresh
  // Chat is already settled on her card book, so the force is "byte-identical
  // slot and message count", not "no binding".
  assert.equal(attempted.ok, false);
  assert.equal(attempted.error, "world_info_binding_conflict");
  const beforeBinding = results.beforeBinding as { worldBookId: string; revision: number; provenance: string };
  assert.equal(beforeBinding.worldBookId, "gamebuddy-worldbook-default-companion");
  assert.deepEqual(results.durableBinding, results.beforeBinding);
  assert.equal("source" in (results.durableBinding as Record<string, unknown>), false);
  assert.equal(results.beforeMessages, 1);
  assert.equal(results.durableMessages, results.beforeMessages);
});

test("mounted binding service fails closed when the lease is torn down during the catalog list instead of publishing an unavailable projection", async () => {
  const results = await mounted(`
    let resolveEntered;
    let resolveRelease;
    const listEntered = new Promise((resolve) => { resolveEntered = resolve; });
    const releaseList = new Promise((resolve) => { resolveRelease = resolve; });
    const closingList = async () => {
      resolveEntered();
      await releaseList;
      await lease.close().catch(() => undefined);
      return repository.list();
    };
    const guardedRepository = Object.freeze({ ...repository, list: closingList });
    const guardedService = createWorldInfoBindingManagementService({ manifest, lease, profile, repository: guardedRepository });
    const readAttempt = code(() => guardedService.read());
    await listEntered;
    resolveRelease();
    const attempted = await readAttempt;
    process.stdout.write(JSON.stringify({ attempted }));
    await guardedService.close();
    await service.close();
    await authority.close();
  `);
  const attempted = results.attempted as { ok: boolean; error: string };
  // A lease teardown observed across the catalog round-trip is an authority
  // condition: read must reject fail-closed and must not publish a current
  // projection. It may not be demoted into a resolved catalog
  // "unavailable" projection.
  assert.equal(attempted.ok, false);
  assert.equal(attempted.error, "world_info_binding_service_unavailable");
});

test("mounted binding service propagates lease teardown observed during exact selection instead of demoting to unselected", async () => {
  const results = await mounted(`
    const first = await service.read();
    await service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: first.items[0].handle });
    const durableBefore = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    const durableHasBinding = durableBefore.thread.worldBookBinding !== undefined;
    // Only the coordinator adapter may mint applied state. Establish the
    // applied revision so the read's exact-selection path resolves against
    // retained history instead of short-circuiting on an absent applied.
    await applyMounted(durableBefore.thread.worldBookBinding, undefined);
    let resolveEntered;
    let resolveRelease;
    const historyEntered = new Promise((resolve) => { resolveEntered = resolve; });
    const releaseHistory = new Promise((resolve) => { resolveRelease = resolve; });
    const closingHistory = async (publicTitle) => {
      resolveEntered();
      await releaseHistory;
      await lease.close().catch(() => undefined);
      return repository.history(publicTitle);
    };
    const guardedRepository = Object.freeze({ ...repository, history: closingHistory });
    const guardedService = createWorldInfoBindingManagementService({ manifest, lease, profile, repository: guardedRepository });
    const readAttempt = code(() => guardedService.read());
    await historyEntered;
    resolveRelease();
    const attempted = await readAttempt;
    process.stdout.write(JSON.stringify({ attempted, durableHasBinding }));
    await guardedService.close();
    await service.close();
    await authority.close();
  `);
  // The durable binding staged above forces the read's exact-selection path to
  // hit the guarded resolver, so the rejection below is not a vacuous pass.
  assert.equal(results.durableHasBinding, true);
  const attempted = results.attempted as { ok: boolean; error: string };
  assert.equal(attempted.ok, false);
  assert.equal(attempted.error, "world_info_binding_service_unavailable");
});

test("binding service command DTO rejects raw title, numeric timestamp and unknown handles", async () => {
  // The strict command schema lives in the browser contract and is consumed
  // by the dispatcher; the service itself revalidates at the boundary.
  const command = {
    apiVersion: TAVERN_BROWSER_API_VERSION,
    selectionGeneration: 1,
    expectedRevision: "Pelican Town",
    sourceHandle: "12345678901234567890",
  };
  assert.equal(TavernBrowserValidatorsV1.SetWorldInfoBindingCommandV1Schema.Check(command), false);
});

test("mounted binding service settles a pristine bind immediately when the coordinator settle entry is wired", async () => {
  const previous = process.env.GAMEBUDDY_MOUNT_SETTLE;
  process.env.GAMEBUDDY_MOUNT_SETTLE = "1";
  try {
    const results = await mounted(`
      const first = await service.read();
      const item = first.items[0];
      const bind = await service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: item.handle });
      const durable = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
      process.stdout.write(JSON.stringify({ bindState: bind.state, bindSelected: bind.items[0].selected, bindPending: bind.items[0].pending, applied: durable.thread.appliedWorldBookBinding }));
      await service.close();
      await lease.close();
      await authority.close();
    `);
    assert.equal(results.bindState, "selected");
    assert.equal(results.bindSelected, true);
    assert.equal(results.bindPending, false);
    assert.ok(results.applied);
    assert.equal((results.applied as { source: string }).source, "managed_world_info");
  } finally {
    if (previous === undefined) delete process.env.GAMEBUDDY_MOUNT_SETTLE;
    else process.env.GAMEBUDDY_MOUNT_SETTLE = previous;
  }
});
