import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, TavernArtifactStore } from "./artifact-store.js";
import {
  createTavernCatalogService,
  materializeTavernStableContext,
  type TavernCatalogBindingStore,
  type TavernCatalogSelection,
} from "./catalog-service.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import { validateTavernArtifact } from "./types.js";
import { createManagedWorldInfoBindingResolver } from "./world-info-binding/managed-world-info-binding.js";
import { createWorldInfoManagementRepository } from "./world-info-management/world-info-management.js";

const hash = "a".repeat(64);
const companion = {
  schemaVersion: 1 as const,
  revision: 1,
  companionId: "companion",
  continuityId: "continuity",
  name: "Buddy",
  profileId: "profile",
  profileRevision: 1,
  profileHash: hash,
};
const catalog = {
  personas: [{ schemaVersion: 1 as const, revision: 1, personaId: "persona", name: "Player" }],
  scenarios: [
    {
      schemaVersion: 1 as const,
      revision: 1,
      scenarioId: "scenario",
      name: "Quiet room",
      description: "A quiet tavern scenario.",
      text: "Quiet.",
      provenance: "authored" as const,
      owner: "chat_override" as const,
    },
  ],
  greetings: [
    {
      schemaVersion: 1 as const,
      revision: 1,
      greetingSetId: "greeting",
      variants: [{ variantId: "first", text: "Hello." }],
    },
  ],
  worldBooks: [
    { bindingId: "companion-book", worldBookId: "book", revision: 1, canonicalHash: hash, scope: "companion" as const },
    { bindingId: "chat-book", worldBookId: "book", revision: 1, canonicalHash: hash, scope: "chat" as const },
  ],
};

function store(): TavernCatalogBindingStore {
  let value: TavernCatalogSelection | undefined;
  return {
    async read() {
      return value;
    },
    async write(next, expected) {
      assert.equal(expected, value?.revision);
      value = next;
      return next;
    },
  };
}
test("catalog selects only the latest valid canonical source revision", () => {
  const service = createTavernCatalogService(store());
  const revisions = {
    ...catalog,
    personas: [
      { ...catalog.personas[0]!, revision: 1, name: "Old" },
      { ...catalog.personas[0]!, revision: 2, name: "Current" },
    ],
  };
  assert.deepEqual(
    service.list(revisions).personas.map((persona) => [persona.revision, persona.name]),
    [[2, "Current"]],
  );
  assert.throws(
    () =>
      service.list({
        ...catalog,
        personas: [
          { ...catalog.personas[0]!, revision: 2 },
          { ...catalog.personas[0]!, revision: 2 },
        ],
      }),
    /invalid_tavern_catalog/,
  );
});

test("catalog selection is scoped, revisioned, and contains only inert references", async () => {
  const service = createTavernCatalogService(store());
  const selected = await service.select(companion, catalog, {
    scope: { kind: "chat", companionId: "companion", continuityId: "continuity", chatThreadId: "thread" },
    personaId: "persona",
    scenarioId: "scenario",
    greetingSetId: "greeting",
    worldBookBindingIds: ["chat-book"],
  });
  assert.deepEqual(selected.worldBookBindingIds, ["chat-book"]);
  assert.equal(selected.revision, 1);
  await assert.rejects(
    service.select(companion, catalog, {
      scope: { kind: "chat", companionId: "companion", continuityId: "wrong", chatThreadId: "thread" },
      worldBookBindingIds: [],
    }),
    /scope_mismatch/,
  );
  await assert.rejects(
    service.select(companion, catalog, {
      scope: { kind: "companion", companionId: "companion" },
      worldBookBindingIds: ["chat-book"],
    }),
    /worldbook_selection/,
  );
});

test("stable materialization uses exact Persona, Scenario, complete DialogueExamples, and always-on WorldBook bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-stable-"));
  const paths = resolveTavernPaths({ root } as never, {
    playerId: "player",
    companionId: "companion",
    continuityId: "continuity",
  });
  const artifacts = new TavernArtifactStore(root);
  const persona = await artifacts.write(
    tavernRevisionPath(join(paths.playerRoot, "personas", "persona"), 1),
    { schemaVersion: 1 as const, revision: 1, personaId: "persona", name: "Player", description: "Curious." },
    validateTavernArtifact,
  );
  const scenario = await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "scenarios", "scenario"), 1),
    {
      schemaVersion: 1 as const,
      revision: 1,
      scenarioId: "scenario",
      name: "Quiet tavern",
      description: "A peaceful tavern scenario.",
      text: "Quiet tavern.",
      provenance: "authored" as const,
      owner: "chat_override" as const,
    },
    validateTavernArtifact,
  );
  const examples = await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "dialogue-examples", "examples"), 1),
    { schemaVersion: 1 as const, revision: 1, examplesId: "examples", blocks: ["A: hello", "B: welcome"] },
    validateTavernArtifact,
  );
  const threads = createChatThreadStore(root, "continuity-key");
  const worldBookBinding = {
    worldBookId: "book",
    revision: 3,
    canonicalHash: "b".repeat(64),
    provenance: "reviewed-import" as const,
  };
  const selected = await threads.createThread({
    chatThreadId: "thread",
    companionId: "companion",
    continuityId: "continuity",
    chatSurfaceSessionId: "surface",
    personaId: "persona",
    scenarioId: "scenario",
    stableArtifactBindings: [
      { kind: "persona", sourceId: "persona", revision: 1, canonicalHash: persona.canonicalHash },
      { kind: "scenario", sourceId: "scenario", revision: 1, canonicalHash: scenario.canonicalHash },
      { kind: "dialogue_examples", sourceId: "examples", revision: 1, canonicalHash: examples.canonicalHash },
    ],
    worldBookBinding,
    opening: "blank",
  });
  const binding = { continuityId: "continuity", sessionId: "pi-session", surface: "tavern" as const };
  const snapshot = await materializeTavernStableContext(paths, artifacts, selected.thread, binding, {
    binding: worldBookBinding,
    alwaysOnPremise: "The tavern is peaceful.",
  });
  assert.deepEqual(
    snapshot.sources.map((source) => source.kind),
    ["dialogue_examples", "persona", "scenario", "worldbook"],
  );
  assert.equal(
    snapshot.sources.find((source) => source.kind === "dialogue_examples")!.content,
    canonicalJson({ blocks: ["A: hello", "B: welcome"] }),
  );
  assert.equal(
    snapshot.sources.find((source) => source.kind === "worldbook")!.provenance,
    `worldbook/book/revision/3/canonical/${"b".repeat(64)}/provenance/reviewed-import`,
  );
  assert.equal(snapshot.sources.reduce((total, source) => total + source.budgetTokens, 0) <= 2_048, true);
  assert.equal(Object.isFrozen(snapshot), true);
  const blank = await threads.createThread({
    chatThreadId: "blank",
    companionId: "companion",
    continuityId: "continuity",
    chatSurfaceSessionId: "surface",
    opening: "blank",
  });
  assert.deepEqual((await materializeTavernStableContext(paths, artifacts, blank.thread, binding)).sources, []);
  await assert.rejects(
    () =>
      materializeTavernStableContext(
        paths,
        artifacts,
        {
          ...selected.thread,
          stableArtifactBindings: selected.thread.stableArtifactBindings!.map((source) =>
            source.kind === "scenario" ? { ...source, canonicalHash: "c".repeat(64) } : source,
          ),
        },
        binding,
        { binding: worldBookBinding, alwaysOnPremise: "The tavern is peaceful." },
      ),
    /source_hash_mismatch/,
  );
  await assert.rejects(
    () => materializeTavernStableContext(paths, artifacts, selected.thread, binding),
    /worldbook_binding_mismatch/,
  );
  await assert.rejects(
    () => materializeTavernStableContext(paths, artifacts, selected.thread, { ...binding, continuityId: "other" }),
    /binding_mismatch/,
  );
});

test("stable materialization accepts only exact resolved managed World Info content", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-managed-world-info-"));
  const paths = resolveTavernPaths({ root } as never, {
    playerId: "player",
    companionId: "companion",
    continuityId: "continuity",
  });
  const repository = createWorldInfoManagementRepository(root);
  await repository.create({
    publicTitle: "Pelican Town",
    summary: "A small valley town.",
    entries: [{ scope: "setting", publicTitle: "Square", summary: "Town center." }],
  });
  const resolver = createManagedWorldInfoBindingResolver(repository);
  const managedBinding = await resolver.bindExact("Pelican Town", 1);
  const threads = createChatThreadStore(root, "continuity-key");
  const thread = await threads.createThread({
    chatThreadId: "thread",
    companionId: "companion",
    continuityId: "continuity",
    chatSurfaceSessionId: "surface",
    worldBookBinding: managedBinding,
    opening: "blank",
  });
  const source = await resolver.resolve(managedBinding);
  const snapshot = await materializeTavernStableContext(
    paths,
    new TavernArtifactStore(root),
    thread.thread,
    { continuityId: "continuity", sessionId: "pi-session", surface: "tavern" },
    source,
  );
  assert.equal(snapshot.sources[0]!.content, source.content);
  assert.match(snapshot.sources[0]!.provenance, /^managed-world-info\/Pelican Town\/revision\/1\/canonical\//);
  await assert.rejects(
    () =>
      materializeTavernStableContext(
        paths,
        new TavernArtifactStore(root),
        thread.thread,
        { continuityId: "continuity", sessionId: "pi-session", surface: "tavern" },
        { ...source, binding: { ...managedBinding, canonicalHash: "c".repeat(64) } },
      ),
    /worldbook_binding_mismatch/,
  );
});
