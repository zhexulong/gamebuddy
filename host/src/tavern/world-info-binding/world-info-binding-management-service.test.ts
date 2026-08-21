import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MountedChatRuntimeLease } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import {
  composeTavernProfile,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
} from "../browser-contract/index.js";
import { createWorldInfoBindingManagementService } from "./world-info-binding-management-service.js";

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
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-world-info-forged-"));
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
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const repository = createWorldInfoManagementRepository(root);
  await repository.create({ publicTitle: "Pelican Town", summary: "A small valley town.", entries: [{ scope: "setting", publicTitle: "Square", summary: "Town center." }] });
  const profile = composeTavernProfile({ profileId: "gamebuddy.tavern-management.world-info-binding", releaseTier: "tavern_management", routeIds: ["bootstrap", "state.read", "chat.list", "chat.rename", "world-info.read", "world-info.bind"], operationIds: ["chat.rename", "world-info.bind"], navigationItemIds: ["chat"] });
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const lease = await authority.startMountedChatRuntime();
  const service = createWorldInfoBindingManagementService({ manifest, lease, profile, repository });
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
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
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
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-world-info-service-"));
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
    const selectedItem = bind.items.find((item) => item.selected === true);
    const durable = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
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
  assert.equal(bind.state, "selected");
  assert.equal(bind.items.filter((item) => item.selected === true).length, 1);
  const selectedItem = results.selectedItem as { handle: string; title: string; selected: boolean };
  assert.equal(selectedItem.title, "Pelican Town");
  assert.equal(selectedItem.selected, true);
  const durableBinding = results.durableBinding as { source: string; publicTitle: string; revision: number };
  assert.equal(durableBinding.source, "managed_world_info");
  assert.equal(durableBinding.publicTitle, "Pelican Town");
  assert.equal(durableBinding.revision, 1);
  // The old opaque revision handle is now superseded (updatedAtMs changed).
  assert.equal((results.staleBind as { error: string }).error, "world_info_binding_conflict");
  const unbind = results.unbind as { state: string };
  assert.equal(unbind.state, "none");
  assert.equal(results.durableAfterUnbindBinding, undefined);
  assert.equal((results.afterUnbindRead as { state: string }).state, "none");
  const durable = JSON.stringify({
    first: results.first,
    bind: results.bind,
    unbind: results.unbind,
    afterBindRead: results.afterBindRead,
  });
  for (const raw of (results.protective as { rawIds: string[] }).rawIds)
    assert.equal(durable.includes(raw), false, `raw durable identity leaked: ${raw}`);
  // The durable binding canonical hash must never reach the browser projection.
  const durableHash = (results.durableBinding as { canonicalHash?: string }).canonicalHash;
  if (durableHash !== undefined)
    assert.equal(durable.includes(durableHash), false, "durable binding hash leaked into browser projection");
});

test("mounted binding service locks after a durable message and keeps the binding intact", async () => {
  const results = await mounted(`
    const first = await service.read();
    const item = first.items[0];
    const bind = await service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: item.handle });
    await store().appendPlayer(lease.chatThreadId, { messageId: "msg_0001", text: "A durable player note.", occurredAtMs: Date.now() });
    const lockedRead = await service.read();
    const lockedUnbind = await code(() => service.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: lockedRead.revision, sourceHandle: null }));
    const durableAfterLock = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    process.stdout.write(JSON.stringify({
      lockedRead,
      lockedUnbind,
      durableAfterLockMessages: durableAfterLock.messages.length,
      durableAfterLockBinding: durableAfterLock.thread.worldBookBinding,
    }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.lockedRead as { state: string }).state, "locked");
  assert.equal((results.lockedUnbind as { error: string }).error, "world_info_binding_locked");
  assert.equal(results.durableAfterLockMessages, 1);
  const binding = results.durableAfterLockBinding as { source: string; publicTitle: string; revision: number };
  assert.equal(binding.source, "managed_world_info");
  assert.equal(binding.revision, 1);
});

test("binding service source keeps store, resolver, lease and coordinator authority private", async () => {
  const source = await readFile(new URL("./world-info-binding-management-service.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/managed-world-info-binding\.js"/);
  assert.match(source, /from "\.\.\/chat-thread-store\.js"/);
  assert.doesNotMatch(
    source,
    /continuity-semantic-production-coordinator\.internal|transitionP4Mounted|transitionP5Mounted/,
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
  const fresh = results.fresh as { state: string; items: ReadonlyArray<{ selected: boolean }> };
  assert.equal(fresh.state, "selected");
  assert.equal(fresh.items.filter((item) => item.selected).length, 1);
  const durableBinding = results.durableBinding as { publicTitle: string; revision: number };
  assert.equal(durableBinding.publicTitle, "Pelican Town");
  assert.equal(durableBinding.revision, 1);
  // Every projection mints fresh opaque handles even for the same source.
  assert.notEqual(second.items[0].handle, first.items[0].handle);
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
    const first = await guardedService.read();
    const attempted = await code(() => guardedService.setBinding({ apiVersion: 1, selectionGeneration: generation, expectedRevision: first.revision, sourceHandle: first.items[0].handle }));
    const durable = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    process.stdout.write(JSON.stringify({ attempted, durableBinding: durable.thread.worldBookBinding, durableMessages: durable.messages.length, firstItemHandle: first.items[0].handle }));
    await guardedService.close();
    await service.close();
    await authority.close();
  `);
  assert.equal((results.attempted as { error: string }).error, "world_info_binding_service_unavailable");
  assert.equal(results.durableBinding, undefined);
  assert.equal(results.durableMessages, 0);
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
    process.stdout.write(JSON.stringify({ firstRevision: first.revision, supersedingRevision: superseding.revision, attempted, durableBinding: durable.thread.worldBookBinding, durableMessages: durable.messages.length }));
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
  // resolver: the mutation must fail closed without any durable write.
  assert.equal(attempted.ok, false);
  assert.equal(attempted.error, "world_info_binding_conflict");
  assert.equal(results.durableBinding, undefined);
  assert.equal(results.durableMessages, 0);
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
