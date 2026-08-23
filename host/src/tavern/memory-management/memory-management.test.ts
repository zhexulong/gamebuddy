import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MountedChatRuntimeLease } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { composeTavernProfile } from "../browser-contract/index.js";
import { createMemoryManagementService } from "./memory-management.js";

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

function memoryReadProfile() {
  return composeTavernProfile({
    profileId: "gamebuddy.tavern-management.memory-read",
    releaseTier: "tavern_management",
    routeIds: [
      "bootstrap",
      "state.read",
      "draft.read",
      "draft.save",
      "draft.discard",
      "chat.list",
      "chat.rename",
      "memory.read",
      "memory.mutate",
    ],
    operationIds: ["draft.save", "draft.discard", "chat.rename", "memory.mutate"],
    navigationItemIds: ["chat", "memory"],
  });
}

function chatListTitleProfile() {
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

test("memory service rejects forged structural mounted leases and wrong profiles before any durable access", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-forged-"));
  try {
    const forged = forgedLease();
    assert.throws(
      () => createMemoryManagementService({ manifest: manifest(root), lease: forged, profile: memoryReadProfile() }),
      /memory_read_service_unavailable/,
    );
    assert.throws(
      () =>
        createMemoryManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: { ...memoryReadProfile() },
        }),
      /memory_read_service_unavailable/,
    );
    // Profile without memory.read is rejected at construction.
    assert.throws(
      () =>
        createMemoryManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: chatListTitleProfile(),
        }),
      /memory_read_service_unavailable/,
    );
    // A non-composed profile is rejected before durable access.
    assert.throws(
      () =>
        createMemoryManagementService({
          manifest: manifest(root),
          lease: forged,
          profile: { ...memoryReadProfile(), routeIds: ["memory.read"] } as unknown as ReturnType<
            typeof composeTavernProfile
          >,
        }),
      /memory_read_service_unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory service source keeps the store, lease and coordinator authority private", async () => {
  const source = await readFile(new URL("./memory-management.js", import.meta.url), "utf8");
  // The service composes browser DTOs, the coordinator lease check, and the
  // runtime Magic Context extension resolver. It owns no HTTP or direct
  // SQLite access; the vendor extension retains its own read projection.
  assert.match(source, /from ["']\.\.\/browser-contract\/index\.js["']/);
  assert.match(source, /from ["']\.\.\/\.\.\/runtime\.js["']/);
  assert.match(source, /from ["']\.\.\/\.\.\/continuity-semantic-production/);
  assert.doesNotMatch(
    source,
    /continuity-semantic-production-coordinator\.internal|transitionP4Mounted|transitionP5Mounted/,
  );
  assert.doesNotMatch(source, /from ["'][^"']*(node:http|express|router|fetch)[^"']*["']/);
  assert.match(source, /resolveMagicContextExtensionEntry/);
  const executableSource = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(executableSource, /(?:from|import\s*\()[^\n]*sqlite|context\.db|openDatabase/);
});

const mountedPreamble = `
  const [coordinatorUrl, deploymentUrl, serviceUrl, contractUrl, manifestPath] = process.argv.slice(1);
  const { bindWindowsStaleLockReclaimer } = await import(new URL("../path-lock.js", coordinatorUrl).href);
  const { createBuildWindowsStaleLockReclaimer } = await import(new URL("../windows-stale-lock-reclaimer/index.js", coordinatorUrl).href);
  await bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = await import(coordinatorUrl);
  const { loadHostDeploymentManifest } = await import(deploymentUrl);
  const { createMemoryManagementService } = await import(serviceUrl);
  const { composeTavernProfile } = await import(contractUrl);
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const profile = composeTavernProfile({
    profileId: "gamebuddy.tavern-management.memory-read",
    releaseTier: "tavern_management",
    routeIds: ["bootstrap","state.read","draft.read","draft.save","draft.discard","chat.list","chat.rename","memory.read","memory.mutate"],
    operationIds: ["draft.save","draft.discard","chat.rename","memory.mutate"],
    navigationItemIds: ["chat","memory"],
  });
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  const lease = await authority.startMountedChatRuntime();
  const run = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } };
`;

async function runMountedChild(body: string, root: string): Promise<Record<string, unknown>> {
  const coordinatorUrl = new URL(
    "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
    import.meta.url,
  ).href;
  const deploymentUrl = new URL("../../deployment-manifest.js", import.meta.url).href;
  const serviceUrl = new URL("./memory-management.js", import.meta.url).href;
  const contractUrl = new URL("../browser-contract/index.js", import.meta.url).href;
  const manifestPath = join(root, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: root,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      mountedPreamble + body,
      coordinatorUrl,
      deploymentUrl,
      serviceUrl,
      contractUrl,
      manifestPath,
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
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-service-"));
  try {
    return await runMountedChild(body, root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => undefined);
  }
}

test("mounted memory service projects only safe DTOs for the exact continuity", async () => {
  const results = await mounted(`
    const { TavernBrowserValidatorsV1 } = await import(contractUrl);
    const stub = Object.freeze({
      listMemories: async (input) => {
        if (input.continuityId !== manifest.principal.continuityId) throw new Error("gamebuddy_memory_continuity_mismatch");
        return [
          { stateToken: "tok_abc_original", content: "  The farmer  loves  blueberries.   ", category: "semantic", status: "active" },
          { stateToken: "tok_xyz_original", content: "Mira is a forest spirit.", category: "interaction", status: "permanent" },
          { stateToken: "tok_789_original", content: "Old quest notes.", category: "semantic", status: "archived" },
        ];
      },
    });
    const service = createMemoryManagementService({ manifest, lease, profile }, stub);
    const result = await service.read();
    const second = await service.read();
    await service.close();
    const afterClose = await run(async () => await service.read());
    const rawTokens = ["tok_abc_original", "tok_xyz_original", "tok_789_original"];
    const leakedRaw = result.memories.some((m) => rawTokens.includes(m.handle));
    const stableRevision = result.projectionRevision === second.projectionRevision;
    const rawContents = ["The farmer  loves  blueberries.", "Mira is a forest spirit.", "Old quest notes."];
    const contentLeak = rawContents.some((content) => JSON.stringify(result).includes(content));
    process.stdout.write(JSON.stringify({
      result,
      hasPermanent: result.memories.some((m) => m.status === "permanent" && m.pinned === true),
      hasActiveUnpinned: result.memories.some((m) => m.status === "active" && m.pinned === false),
      hasArchivedUnpinned: result.memories.some((m) => m.status === "archived" && m.pinned === false),
      leakedRaw,
      contentLeak,
      stableRevision,
      schemaOk: TavernBrowserValidatorsV1.MemoryReadV1Schema.Check(result),
      afterClose,
      continuityId: manifest.principal.continuityId,
      exposedKeys: result.memories.map((m) => Object.keys(m).sort()),
      projectionRevisionLen: result.projectionRevision.length,
    }));
    await lease.close();
    await authority.close();
  `);
  const result = results.result as {
    apiVersion: number;
    memories: ReadonlyArray<Readonly<Record<string, unknown>>>;
  };
  assert.equal(result.apiVersion, 1);
  assert.equal(result.memories.length, 3);
  assert.equal(results.hasPermanent, true);
  assert.equal(results.hasActiveUnpinned, true);
  assert.equal(results.hasArchivedUnpinned, true);
  assert.equal(results.leakedRaw, false);
  assert.equal(results.contentLeak, true);
  assert.equal(results.stableRevision, true);
  assert.equal(results.schemaOk, true);
  // Exposure is exactly the bounded player-managed browser DTO, nothing else.
  for (const keys of results.exposedKeys as readonly (readonly string[])[]) {
    assert.deepEqual(keys, ["category", "content", "handle", "pinned", "status", "title"]);
  }
  assert.equal(results.projectionRevisionLen, 43);
  assert.equal((results.afterClose as { ok: boolean }).ok, false);
  assert.equal(results.continuityId, "continuity_01");
});

test("mounted memory service reads the exact embedded runtime's vendor Memory partition", async () => {
  const results = await mounted(`
    const runtime = await import(new URL("../../runtime.js", serviceUrl).href);
    const { pathToFileURL } = await import("node:url");
    const actualRuntimeCwd = runtime.resolveRuntimePaths(
      manifest.principal,
      manifest.runtimeRoot,
      lease.chatSurfaceSessionId,
    ).runtimeCwd;
    const extension = await import(pathToFileURL(runtime.resolveMagicContextExtensionEntry()).href);
    const directFacade = extension.createGameBuddyPlayerMemoryCrudFacade({
      continuityId: manifest.principal.continuityId,
      runtimeCwd: actualRuntimeCwd,
    });
    await directFacade.create({
      continuityId: manifest.principal.continuityId,
      content: "Memory created in the exact mounted runtime",
    });
    const service = createMemoryManagementService({ manifest, lease, profile });
    const read = await service.read();
    process.stdout.write(JSON.stringify({
      actualRuntimeCwd,
      rootRuntimeCwd: manifest.runtimeRoot,
      read,
    }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.notEqual(results.actualRuntimeCwd, results.rootRuntimeCwd);
  assert.equal(
    (results.read as { memories: Array<{ content: string }> }).memories.some(
      (memory) => memory.content === "Memory created in the exact mounted runtime",
    ),
    true,
  );
});

test("mounted memory service mutates only after projection CAS and always returns a fresh safe reread", async () => {
  const results = await mounted(`
    let rows = [{ stateToken: "tok_original", content: "Original", category: "semantic", status: "active" }];
    const writes = [];
    const stub = Object.freeze({
      listMemories: async () => rows,
      create: async ({ content }) => {
        writes.push({ operation: "create", content });
        rows = [...rows, { stateToken: "tok_created", content, category: "semantic", status: "active" }];
      },
      update: async ({ stateToken, content }) => {
        writes.push({ operation: "update", stateToken, content });
        rows = rows.map((row) => row.stateToken === stateToken ? { ...row, stateToken: "tok_updated", content } : row);
      },
      archive: async ({ stateToken }) => {
        writes.push({ operation: "archive", stateToken });
        rows = rows.map((row) => row.stateToken === stateToken ? { ...row, stateToken: "tok_archived", status: "archived" } : row);
      },
    });
    const service = createMemoryManagementService({ manifest, lease, profile }, stub);
    const initial = await service.read();
    const created = await service.mutate({ apiVersion: 1, operation: "create", expectedProjectionRevision: initial.projectionRevision, content: "Created" });
    const createdRow = created.memories.find((row) => row.content === "Created");
    const updated = await service.mutate({ apiVersion: 1, operation: "update", expectedProjectionRevision: created.projectionRevision, handle: createdRow.handle, content: "Updated" });
    const updatedRow = updated.memories.find((row) => row.content === "Updated");
    const archived = await service.mutate({ apiVersion: 1, operation: "archive", expectedProjectionRevision: updated.projectionRevision, handle: updatedRow.handle });
    const stale = await run(async () => await service.mutate({ apiVersion: 1, operation: "create", expectedProjectionRevision: initial.projectionRevision, content: "Stale" }));
    process.stdout.write(JSON.stringify({ created, updated, archived, writes, stale }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.deepEqual(results.writes, [
    { operation: "create", content: "Created" },
    { operation: "update", stateToken: "tok_created", content: "Updated" },
    { operation: "archive", stateToken: "tok_updated" },
  ]);
  assert.equal((results.archived as { memories: Array<{ content: string; status: string }> }).memories.find((row) => row.content === "Updated")?.status, "archived");
  assert.equal((results.stale as { ok: boolean }).ok, false);
  assert.match((results.stale as { error: string }).error, /memory_mutation_conflict/);
});

test("mounted memory service rejects concurrent creates sharing the same projection revision", async () => {
  const results = await mounted(`
    let rows = [];
    const stub = Object.freeze({
      listMemories: async () => rows,
      create: async ({ content }) => {
        rows = [...rows, { stateToken: "tok_" + content, content, category: "semantic", status: "active" }];
      },
      update: async () => { throw new Error("unexpected update"); },
      archive: async () => { throw new Error("unexpected archive"); },
    });
    const service = createMemoryManagementService({ manifest, lease, profile }, stub);
    const initial = await service.read();
    const first = await service.mutate({
      apiVersion: 1,
      operation: "create",
      expectedProjectionRevision: initial.projectionRevision,
      content: "First concurrent create",
    });
    const second = await run(async () => await service.mutate({
      apiVersion: 1,
      operation: "create",
      expectedProjectionRevision: initial.projectionRevision,
      content: "Second stale create",
    }));
    const reread = await service.read();
    process.stdout.write(JSON.stringify({ first, second, reread }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.second as { ok: boolean }).ok, false);
  assert.match((results.second as { error: string }).error, /memory_mutation_conflict/);
  assert.deepEqual(
    (results.reread as { memories: Array<{ content: string }> }).memories.map((memory) => memory.content),
    ["First concurrent create"],
  );
});

test("mounted memory service maps a vendor CAS conflict to 409 without a stale success projection", async () => {
  const results = await mounted(`
    let rows = [{ stateToken: "tok_original", content: "Original", category: "semantic", status: "active" }];
    const stub = Object.freeze({
      listMemories: async () => rows,
      create: async () => { throw new Error("unexpected create"); },
      update: async () => {
        rows = [{ stateToken: "tok_newer", content: "Concurrent writer won", category: "semantic", status: "active" }];
        throw new Error("Memory state token was not found or is stale");
      },
      archive: async () => { throw new Error("unexpected archive"); },
    });
    const service = createMemoryManagementService({ manifest, lease, profile }, stub);
    const initial = await service.read();
    const target = initial.memories[0];
    const outcome = await run(async () => await service.mutate({
      apiVersion: 1,
      operation: "update",
      expectedProjectionRevision: initial.projectionRevision,
      handle: target.handle,
      content: "Stale browser write",
    }));
    const reread = await service.read();
    process.stdout.write(JSON.stringify({ outcome, reread }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.outcome as { ok: boolean }).ok, false);
  assert.match((results.outcome as { error: string }).error, /memory_mutation_conflict/);
  assert.deepEqual(
    (results.reread as { memories: Array<{ content: string }> }).memories.map((row) => row.content),
    ["Concurrent writer won"],
  );
});

test("mounted memory service fails closed on continuity mismatch without exposing partial state", async () => {
  const results = await mounted(`
    const errorStub = Object.freeze({
      listMemories: async () => { throw new Error("gamebuddy_memory_continuity_mismatch"); },
    });
    const service = createMemoryManagementService({ manifest, lease, profile }, errorStub);
    const outcome = await run(async () => await service.read());
    process.stdout.write(JSON.stringify({ outcome }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.outcome as { ok: boolean }).ok, false);
  assert.match((results.outcome as { error: string }).error, /memory_read_unavailable/);
});

test("mounted memory service fails closed on storage errors and after lease revocation", async () => {
  const results = await mounted(`
    const storageStub = Object.freeze({
      listMemories: async () => { throw new Error("sqlite: database disk image is malformed"); },
    });
    const service = createMemoryManagementService({ manifest, lease, profile }, storageStub);
    const storageOutcome = await run(async () => await service.read());
    // Closing the lease revokes the mount, so a fresh read must fail closed.
    await lease.close();
    const revokedOutcome = await run(async () => await service.read());
    process.stdout.write(JSON.stringify({ storageOutcome, revokedOutcome }));
    await service.close();
    await authority.close();
  `);
  const storageOutcome = results.storageOutcome as { ok: boolean; error: string };
  assert.equal(storageOutcome.ok, false);
  assert.match(storageOutcome.error, /memory_read_storage_unavailable/);
  assert.equal((results.revokedOutcome as { ok: boolean }).ok, false);
  assert.match((results.revokedOutcome as { error: string }).error, /memory_read_service_unavailable/);
});

test("mounted memory service rejects malformed or oversized vendor content before it reaches the browser projection", async () => {
  const results = await mounted(`
    const oversizedStub = Object.freeze({
      listMemories: async () => [{
        stateToken: "tok_oversized",
        content: "x".repeat(4097),
        category: "semantic",
        status: "active",
      }],
    });
    const service = createMemoryManagementService({ manifest, lease, profile }, oversizedStub);
    const outcome = await run(async () => await service.read());
    process.stdout.write(JSON.stringify({ outcome }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.outcome as { ok: boolean }).ok, false);
  assert.match((results.outcome as { error: string }).error, /memory_read_service_unavailable/);
});

test("mounted memory service fails closed when the projected set exceeds the contract bound", async () => {
  const results = await mounted(`
    const largeStub = Object.freeze({
      listMemories: async () => {
        return Array.from({ length: 201 }, (_, i) => ({
          stateToken: "tok_" + i,
          content: "row " + i,
          category: "semantic",
          status: "active",
        }));
      },
    });
    const service = createMemoryManagementService({ manifest, lease, profile }, largeStub);
    const outcome = await run(async () => await service.read());
    process.stdout.write(JSON.stringify({ outcome }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal((results.outcome as { ok: boolean }).ok, false);
  assert.match((results.outcome as { error: string }).error, /memory_read_service_unavailable/);
});

test("mounted memory service uses fixed category labels that never derive from content", async () => {
  const results = await mounted(`
    const longStub = Object.freeze({
      listMemories: async () => [{
        stateToken: "tok_long",
        content: "player-private-content-" + "x".repeat(1000),
        category: "semantic",
        status: "active",
      }],
    });
    const service = createMemoryManagementService({ manifest, lease, profile }, longStub);
    const result = await service.read();
    process.stdout.write(JSON.stringify({ title: result.memories[0].title }));
    await service.close();
    await lease.close();
    await authority.close();
  `);
  assert.equal(results.title, "Semantic memory");
});
