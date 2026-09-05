import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import type { MountedChatRuntimeLease } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { composeTavernProfile } from "../browser-contract/index.js";
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
      () => createChatManagementService({ manifest: manifest(root), lease: forged, profile: managementProfile() }),
      /chat_management_service_unavailable/,
    );
    assert.throws(
      () =>
        createChatManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: { ...managementProfile() },
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
      () => createChatManagementService({ manifest: manifest(root), lease: forged, profile: referenceProfile }),
      /chat_management_service_unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("management service source keeps the store, lease and coordinator authority private", async () => {
  const source = await readFile(new URL("./chat-management-service.js", import.meta.url), "utf8");
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
  const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = coordinator;
  const { createChatManagementService } = await import(serviceUrl);
  const { createChatThreadStore } = await import(storeUrl);
  const { identityKey } = await import(runtimeUrl);
  const { composeTavernProfile, TavernBrowserValidatorsV1 } = await import(contractUrl);
  const { createTavernManagementStateFacade } = await import(facadeUrl);
  const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", storeUrl).href);
  const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", storeUrl).href);
  await bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const profile = composeTavernProfile({ profileId: "gamebuddy.tavern-management.chat-list-title", releaseTier: "tavern_management", routeIds: ["bootstrap", "state.read", "draft.read", "draft.save", "draft.discard", "chat.list", "chat.rename"], operationIds: ["draft.save", "draft.discard", "chat.rename"], navigationItemIds: ["chat"] });
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const lease = await authority.startMountedChatRuntime();
  const service = createChatManagementService({ manifest, lease, profile });
  const facade = await createTavernManagementStateFacade(manifest, lease, profile);
  const store = () => createChatThreadStore(root, identityKey(principal));
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

test("mounted management service lists durable metadata only and renames the exact mounted Chat through the management CAS", async () => {
  const results = await mounted(`
    const handle = lease.browserProjection.chatHandle;
    const generation = lease.browserProjection.selectionGeneration;
    const list = await service.listChats({ apiVersion: 1, state: "active" });
    const listValue = list;
    const second = await store().createThread({ chatThreadId: "thread_02", companionId: "companion_01", continuityId: "continuity_01", chatSurfaceSessionId: "surface_02", opening: "blank" });
    const two = await service.listChats({ apiVersion: 1 });
    const rename = await service.renameChatTitle({ apiVersion: 1, selectionGeneration: generation, chatHandle: handle, expectedManagementRevision: 1, title: "Renamed Farm Chat" });
    const readBack = await store().resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
    const wrongGeneration = await code(() => service.renameChatTitle({ apiVersion: 1, selectionGeneration: generation + 1, chatHandle: handle, expectedManagementRevision: 1, title: "X" }));
    const foreignHandle = await code(() => service.renameChatTitle({ apiVersion: 1, selectionGeneration: generation, chatHandle: "B".repeat(43), expectedManagementRevision: 1, title: "X" }));
    const staleRevision = await code(() => service.renameChatTitle({ apiVersion: 1, selectionGeneration: generation, chatHandle: handle, expectedManagementRevision: 1, title: "Another" }));
    const unchanged = await code(() => service.renameChatTitle({ apiVersion: 1, selectionGeneration: generation, chatHandle: handle, expectedManagementRevision: 2, title: "Renamed Farm Chat" }));
    const invalidTitle = await code(() => service.renameChatTitle({ apiVersion: 1, selectionGeneration: generation, chatHandle: handle, expectedManagementRevision: 2, title: "   " }));
    const facadeState = await facade.read();
    process.stdout.write(JSON.stringify({
      listValue,
      two,
      rename,
      readBackTitle: readBack.thread.title,
      readBackRevision: readBack.thread.managementRevision,
      wrongGeneration,
      foreignHandle,
      staleRevision,
      unchanged,
      invalidTitle,
      facadeState,
      rawIds: [lease.chatThreadId, lease.chatSurfaceSessionId, "thread_02", "surface_02", "companion_01", "continuity_01"],
      secondThreadId: second.thread.chatThreadId,
      mounted: { chatThreadId: lease.chatThreadId, chatSurfaceSessionId: lease.chatSurfaceSessionId },
    }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  const listValue = results.listValue as { chats: ReadonlyArray<Readonly<Record<string, unknown>>> };
  assert.equal(listValue.chats.length, 1);
  assert.equal(listValue.chats[0].isSelected, true);
  assert.equal((results.two as { chats: unknown[] }).chats.length, 2);
  const secondEntry = (results.two as { chats: ReadonlyArray<Readonly<Record<string, unknown>>> }).chats.find(
    (chat) => chat.isSelected === false,
  )!;
  assert.equal(secondEntry.status, "active");
  assert.equal(secondEntry.handle !== (listValue.chats[0] as Readonly<Record<string, unknown>>).handle, true);
  const rename = results.rename as { title: string; managementRevision: number };
  assert.equal(rename.title, "Renamed Farm Chat");
  assert.equal(rename.managementRevision, 2);
  assert.equal(results.readBackTitle, "Renamed Farm Chat");
  assert.equal(results.readBackRevision, 2);
  assert.equal((results.wrongGeneration as { error: string }).error, "chat_management_selection_conflict");
  assert.equal((results.foreignHandle as { error: string }).error, "chat_management_selection_conflict");
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
    await authority.close();
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
    await authority.close();
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
