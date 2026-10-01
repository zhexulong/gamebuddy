import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { rm } from "node:fs/promises";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { canonicalHash, TavernArtifactStore } from "./artifact-store.js";
import { materializeTavernAuthoredStableCatalog, materializeTavernAuthoredContextCatalog } from "./catalog-service.js";
import { createManagedWorldInfoBindingResolver } from "./world-info-binding/managed-world-info-binding.js";
import { createWorldInfoManagementRepository } from "./world-info-management/world-info-management.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "./chat-thread-store.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import { validateTavernArtifact } from "./types.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

test("compiles exact managed World Info revision as a reference-safe lorebook_constant", async () => {
  const root = await canonicalTestRoot("gamebuddy-managed-catalog-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  const repository = createWorldInfoManagementRepository(root);
  let closeStore: (() => void) | undefined;
  try {
    const created = await repository.create({
      publicTitle: "Pelican Town",
      summary: "A small valley town.",
      entries: [{ scope: "setting", publicTitle: "Town square", summary: "The center of town.", constant: true, keys: ["square", "town"] }],
    });
    await repository.update("Pelican Town", {
      expectedRevision: 1,
      publicTitle: "Pelican Town",
      summary: "A small valley town, revised.",
       entries: [{ scope: "setting", publicTitle: "Town square", summary: "The center of town, revised.", constant: true, keys: ["square"] }],
    });
    const binding = createManagedWorldInfoBindingResolver(repository);
    const exact = await binding.resolve({
      source: "managed_world_info",
      publicTitle: "Pelican Town",
      revision: created.revision,
      canonicalHash: canonicalHash({
        revision: created.revision,
        publicTitle: created.publicTitle,
        summary: created.summary,
        entries: created.entries,
      }),
    });
    const threads = createChatThreadStore(root, "continuity-key");
    closeStore = () => threads.close?.();
    const creation = createProfileAwareChatThreadCreationCapability(threads, { async readExact() { return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) }; } });
    const thread = await creation.createExplicit({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      companionId: "companion",
      continuityId: "continuity",
      worldBookBinding: exact.binding,
      opening: "blank",
    });
    const catalog = await materializeTavernAuthoredStableCatalog(paths, new TavernArtifactStore(root), thread.thread, {
      continuityId: "continuity",
      sessionId: "pi-session",
      surface: "tavern",
      threadId: "thread",
      profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
    }, exact);
    assert.deepEqual(catalog.stableSources.map((source) => source.kind), ["lorebook_constant"]);
    assert.equal(catalog.stableSources[0]?.revision, "1");
    assert.match(catalog.stableSources[0]?.sourceId ?? "", /^managed_world_info_[a-f0-9]{32}$/);
    assert.match(catalog.stableSources[0]?.provenance ?? "", /managed-world-info\/Pelican Town\/revision\/1/);
     assert.match(catalog.stableSources[0]?.content ?? "", /Town square/);
     assert.match(catalog.stableSources[0]?.content ?? "", /The center of town/);
     assert.doesNotMatch(catalog.stableSources[0]?.content ?? "", /volatile/);
     assert.notEqual(catalog.stableSources[0]?.content, exact.content);
     assert.deepEqual(catalog.volatileSources, []);
    await assert.rejects(
      () => materializeTavernAuthoredContextCatalog(paths, new TavernArtifactStore(root), thread.thread, {
        continuityId: "continuity", sessionId: "pi-session", surface: "tavern", threadId: "thread",
        profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
      }, { ...exact, content: `${exact.content}tampered` }),
      /tavern_stable_context_worldbook_binding_mismatch/,
    );
    await assert.rejects(
      () => materializeTavernAuthoredContextCatalog(paths, new TavernArtifactStore(root), thread.thread, {
        continuityId: "continuity", sessionId: "pi-session", surface: "tavern", threadId: "thread",
        profile: { profileId: "profile-drift", revision: 1, canonicalHash: "a".repeat(64) },
      }, exact),
      /tavern_stable_context_binding_mismatch/,
    );
    await assert.rejects(
      () => materializeTavernAuthoredStableCatalog(paths, new TavernArtifactStore(root), thread.thread, {
        continuityId: "continuity", sessionId: "pi-session", surface: "tavern", threadId: "thread",
        profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
      }, { ...exact, binding: { ...exact.binding, canonicalHash: "b".repeat(64) } }),
      /tavern_stable_context_worldbook_binding_mismatch/,
    );
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("stable World Info excludes constants from volatile sources and matches volatile entries by keys", async () => {
  const root = await canonicalTestRoot("gamebuddy-catalog-volatile-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  const repository = createWorldInfoManagementRepository(root);
  let closeStore: (() => void) | undefined;
  try {
    const created = await repository.create({
      publicTitle: "Large Lore",
      summary: "Compact overview.",
      entries: [
        { scope: "setting", publicTitle: "Always Town", summary: "Stable town fact.", constant: true, keys: ["stable town"] },
        ...Array.from({ length: 150 }, (_, index) => ({
          scope: "setting" as const,
          publicTitle: `Entry ${index + 1}`,
          summary: `Volatile fact ${index + 1}.`,
          keys: [`trigger-${index + 1}`, `alias-${index + 1}`],
          constant: false,
        })),
      ],
    });
    const resolver = createManagedWorldInfoBindingResolver(repository);
    const exact = await resolver.resolve(await resolver.bindExact(created.publicTitle, 1));
    const threads = createChatThreadStore(root, "continuity-key");
    closeStore = () => threads.close?.();
    const creation = createProfileAwareChatThreadCreationCapability(threads, { async readExact() { return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) }; } });
    const thread = await creation.createExplicit({ chatThreadId: "thread", chatSurfaceSessionId: "surface", companionId: "companion", continuityId: "continuity", worldBookBinding: exact.binding, opening: "blank" });
    const catalog = await materializeTavernAuthoredStableCatalog(paths, new TavernArtifactStore(root), thread.thread, { continuityId: "continuity", sessionId: "pi-session", surface: "tavern", threadId: "thread", profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) } }, exact);
    assert.ok(catalog.stableSources[0]!.budgetTokens <= 2_048);
    assert.match(catalog.stableSources[0]!.content, /Always Town/);
    assert.doesNotMatch(catalog.stableSources[0]!.content, /Volatile fact/);
    assert.equal(catalog.volatileSources.length, 150);
    assert.ok(catalog.volatileSources.every((source) => !source.content.includes("Stable town fact")));
    assert.deepEqual(catalog.volatileSources[0]?.selectionKeys, ["trigger-1", "alias-1"]);
    assert.deepEqual(catalog.volatileSources[149]?.selectionKeys, ["trigger-150", "alias-150"]);
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("stable World Info falls back to Overview when constant content exceeds the stable budget", async () => {
  const root = await canonicalTestRoot("gamebuddy-catalog-overview-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  const repository = createWorldInfoManagementRepository(root);
  let closeStore: (() => void) | undefined;
  try {
    const created = await repository.create({
      publicTitle: "Large Lore",
      summary: "Compact overview.",
      entries: [
        { scope: "setting", publicTitle: "Large constant 1", summary: "x".repeat(4_000), constant: true },
        { scope: "setting", publicTitle: "Large constant 2", summary: "y".repeat(4_000), constant: true },
        { scope: "setting", publicTitle: "Large constant 3", summary: "z".repeat(4_000), constant: true },
      ],
    });
    const resolver = createManagedWorldInfoBindingResolver(repository);
    const exact = await resolver.resolve(await resolver.bindExact(created.publicTitle, 1));
    const threads = createChatThreadStore(root, "continuity-key");
    closeStore = () => threads.close?.();
    const creation = createProfileAwareChatThreadCreationCapability(threads, { async readExact() { return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) }; } });
    const thread = await creation.createExplicit({ chatThreadId: "thread", chatSurfaceSessionId: "surface", companionId: "companion", continuityId: "continuity", worldBookBinding: exact.binding, opening: "blank" });
    const catalog = await materializeTavernAuthoredStableCatalog(paths, new TavernArtifactStore(root), thread.thread, { continuityId: "continuity", sessionId: "pi-session", surface: "tavern", threadId: "thread", profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) } }, exact);
    assert.ok(catalog.stableSources[0]!.budgetTokens <= 2_048);
    assert.match(catalog.stableSources[0]!.content, /Large Lore/);
    assert.doesNotMatch(catalog.stableSources[0]!.content, /Large constant 1/);
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("compiles exact v2 Chat catalog with reference-free scope and deterministic sources", async () => {
  const root = await canonicalTestRoot("gamebuddy-catalog-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  const artifacts = new TavernArtifactStore(root);
  const persona = await artifacts.write(tavernRevisionPath(join(paths.playerRoot, "personas", "persona"), 1), { schemaVersion: 1 as const, revision: 1, personaId: "persona", name: "Player" }, validateTavernArtifact);
  const scenario = await artifacts.write(tavernRevisionPath(join(paths.companionRoot, "scenarios", "scenario"), 1), { schemaVersion: 1 as const, revision: 1, scenarioId: "scenario", name: "Scenario", description: "Quiet.", text: "Quiet.", provenance: "authored" as const, owner: "chat_override" as const }, validateTavernArtifact);
  const threads = createChatThreadStore(root, "continuity-key");
  const creation = createProfileAwareChatThreadCreationCapability(threads, { async readExact() { return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) }; } });
  const thread = await creation.createExplicit({ chatThreadId: "thread", chatSurfaceSessionId: "surface", companionId: "companion", continuityId: "continuity", personaId: "persona", scenarioId: "scenario", stableArtifactBindings: [
    { kind: "persona", sourceId: "persona", revision: 1, canonicalHash: persona.canonicalHash },
    { kind: "scenario", sourceId: "scenario", revision: 1, canonicalHash: scenario.canonicalHash },
  ], opening: "blank" });
  const scope = { continuityId: "continuity", sessionId: "pi-session", surface: "tavern" as const, threadId: "thread", profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) } };
  const catalog = await materializeTavernAuthoredContextCatalog(paths, artifacts, thread.thread, scope);
  assert.equal(catalog.version, "gamebuddy-authored-context-catalog/v2");
  assert.deepEqual(catalog.stableSources.map((source) => source.kind), ["persona", "scenario"]);
  assert.equal(catalog.scope.threadId, "thread");
  assert.match(catalog.canonicalHash, /^[a-f0-9]{64}$/);
  await assert.rejects(() => materializeTavernAuthoredContextCatalog(paths, artifacts, thread.thread, { ...scope, threadId: "foreign" }), /binding_mismatch/);
  threads.close?.();
});
