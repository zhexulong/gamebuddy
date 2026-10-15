import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { rm } from "node:fs/promises";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { canonicalHash, TavernArtifactStore } from "./artifact-store.js";
import {
  buildGameSurfaceAuthoredCatalog,
  materializeTavernAuthoredStableCatalog,
  materializeTavernAuthoredContextCatalog,
} from "./catalog-service.js";
import { validateWorldBook, worldBookMetadata } from "../worldbook.js";
import { createManagedWorldInfoBindingResolver } from "./world-info-binding/managed-world-info-binding.js";
import { createWorldInfoManagementRepository } from "./world-info-management/world-info-management.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "./chat-thread-store.js";
import { macroTable } from "./macro-engine.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import { type Scenario, validateTavernArtifact } from "./types.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

// The run's macro table for these fixtures: a zh companion named 琥珀, so a
// scenario's own {{char}}/{{user}} resolve to 琥珀/玩家.
const TEST_MACROS = macroTable({ char: "琥珀", locale: "zh-CN" });

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
      entries: [
        {
          scope: "setting",
          publicTitle: "Town square",
          summary: "The center of town.",
          constant: true,
          keys: ["square", "town"],
        },
      ],
    });
    await repository.update("Pelican Town", {
      expectedRevision: 1,
      publicTitle: "Pelican Town",
      summary: "A small valley town, revised.",
      entries: [
        {
          scope: "setting",
          publicTitle: "Town square",
          summary: "The center of town, revised.",
          constant: true,
          keys: ["square"],
        },
      ],
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
    const creation = createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
      },
    });
    const thread = await creation.createExplicit({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      companionId: "companion",
      continuityId: "continuity",
      worldBookBinding: exact.binding,
      opening: "blank",
    });
    const catalog = await materializeTavernAuthoredStableCatalog(
      paths,
      new TavernArtifactStore(root),
      thread.thread,
      {
        continuityId: "continuity",
        sessionId: "pi-session",
        surface: "tavern",
        threadId: "thread",
        profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
      },
      TEST_MACROS,
      exact,
    );
    assert.deepEqual(
      catalog.stableSources.map((source) => source.kind),
      ["lorebook_constant"],
    );
    assert.equal(catalog.stableSources[0]?.revision, "1");
    assert.match(catalog.stableSources[0]?.sourceId ?? "", /^managed_world_info_[a-f0-9]{32}$/);
    assert.match(catalog.stableSources[0]?.provenance ?? "", /managed-world-info\/Pelican Town\/revision\/1/);
    assert.match(catalog.stableSources[0]?.content ?? "", /Town square/);
    assert.match(catalog.stableSources[0]?.content ?? "", /The center of town/);
    assert.doesNotMatch(catalog.stableSources[0]?.content ?? "", /volatile/);
    assert.notEqual(catalog.stableSources[0]?.content, exact.content);
    assert.deepEqual(catalog.volatileSources, []);
    await assert.rejects(
      () =>
        materializeTavernAuthoredContextCatalog(
          paths,
          new TavernArtifactStore(root),
          thread.thread,
          {
            continuityId: "continuity",
            sessionId: "pi-session",
            surface: "tavern",
            threadId: "thread",
            profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
          },
          TEST_MACROS,
          { ...exact, content: `${exact.content}tampered` },
        ),
      /tavern_stable_context_worldbook_binding_mismatch/,
    );
    await assert.rejects(
      () =>
        materializeTavernAuthoredContextCatalog(
          paths,
          new TavernArtifactStore(root),
          thread.thread,
          {
            continuityId: "continuity",
            sessionId: "pi-session",
            surface: "tavern",
            threadId: "thread",
            profile: { profileId: "profile-drift", revision: 1, canonicalHash: "a".repeat(64) },
          },
          TEST_MACROS,
          exact,
        ),
      /tavern_stable_context_binding_mismatch/,
    );
    await assert.rejects(
      () =>
        materializeTavernAuthoredStableCatalog(
          paths,
          new TavernArtifactStore(root),
          thread.thread,
          {
            continuityId: "continuity",
            sessionId: "pi-session",
            surface: "tavern",
            threadId: "thread",
            profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
          },
          TEST_MACROS,
          { ...exact, binding: { ...exact.binding, canonicalHash: "b".repeat(64) } },
        ),
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
        {
          scope: "setting",
          publicTitle: "Always Town",
          summary: "Stable town fact.",
          constant: true,
          keys: ["stable town"],
        },
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
    const creation = createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
      },
    });
    const thread = await creation.createExplicit({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      companionId: "companion",
      continuityId: "continuity",
      worldBookBinding: exact.binding,
      opening: "blank",
    });
    const catalog = await materializeTavernAuthoredStableCatalog(
      paths,
      new TavernArtifactStore(root),
      thread.thread,
      {
        continuityId: "continuity",
        sessionId: "pi-session",
        surface: "tavern",
        threadId: "thread",
        profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
      },
      TEST_MACROS,
      exact,
    );
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
    const creation = createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
      },
    });
    const thread = await creation.createExplicit({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      companionId: "companion",
      continuityId: "continuity",
      worldBookBinding: exact.binding,
      opening: "blank",
    });
    const catalog = await materializeTavernAuthoredStableCatalog(
      paths,
      new TavernArtifactStore(root),
      thread.thread,
      {
        continuityId: "continuity",
        sessionId: "pi-session",
        surface: "tavern",
        threadId: "thread",
        profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
      },
      TEST_MACROS,
      exact,
    );
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
  const persona = await artifacts.write(
    tavernRevisionPath(join(paths.playerRoot, "personas", "persona"), 1),
    { schemaVersion: 1 as const, revision: 1, personaId: "persona", name: "Player" },
    validateTavernArtifact,
  );
  const scenario = await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "scenarios", "scenario"), 1),
    {
      schemaVersion: 1 as const,
      revision: 1,
      scenarioId: "scenario",
      name: "Scenario",
      description: "Quiet.",
      text: "Quiet.",
      provenance: "authored" as const,
      owner: "chat_override" as const,
    },
    validateTavernArtifact,
  );
  const threads = createChatThreadStore(root, "continuity-key");
  const creation = createProfileAwareChatThreadCreationCapability(threads, {
    async readExact() {
      return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
    },
  });
  const thread = await creation.createExplicit({
    chatThreadId: "thread",
    chatSurfaceSessionId: "surface",
    companionId: "companion",
    continuityId: "continuity",
    personaId: "persona",
    scenarioId: "scenario",
    stableArtifactBindings: [
      { kind: "persona", sourceId: "persona", revision: 1, canonicalHash: persona.canonicalHash },
      { kind: "scenario", sourceId: "scenario", revision: 1, canonicalHash: scenario.canonicalHash },
    ],
    opening: "blank",
  });
  const scope = {
    continuityId: "continuity",
    sessionId: "pi-session",
    surface: "tavern" as const,
    threadId: "thread",
    profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
  };
  const catalog = await materializeTavernAuthoredContextCatalog(paths, artifacts, thread.thread, scope, TEST_MACROS);
  assert.equal(catalog.version, "gamebuddy-authored-context-catalog/v2");
  assert.deepEqual(
    catalog.stableSources.map((source) => source.kind),
    ["persona", "scenario"],
  );
  assert.equal(catalog.scope.threadId, "thread");
  assert.match(catalog.canonicalHash, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () =>
      materializeTavernAuthoredContextCatalog(
        paths,
        artifacts,
        thread.thread,
        { ...scope, threadId: "foreign" },
        TEST_MACROS,
      ),
    /binding_mismatch/,
  );
  threads.close?.();
});
test("buildGameSurfaceAuthoredCatalog mounts only the reviewed always-on WorldBook as a lorebook_constant m[0] source", async () => {
  const worldBook = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "default-companion",
    revision: 3,
    alwaysOnPremise: "This is the player-reviewed companion backdrop.",
    entries: [
      {
        entryId: "kohaku-entry-10",
        title: "开拓同盟与农场誓约",
        content: "琥珀与玩家是共同开拓农场的青梅竹马合伙人。",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
        constant: true,
      },
      {
        entryId: "kohaku-entry-1",
        title: "雨天安排",
        content: "雨天喜欢在门廊煮热茶看雨。",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
      },
    ],
  });
  const binding = { metadata: worldBookMetadata(worldBook), book: worldBook };
  const catalog = buildGameSurfaceAuthoredCatalog(
    {
      continuityId: "continuity",
      sessionId: "pi-session",
      surface: "game",
      threadId: "game-session",
      profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
    },
    binding,
  );
  assert.deepEqual(
    catalog.stableSources.map((source) => source.kind),
    ["lorebook_constant"],
  );
  const source = catalog.stableSources[0];
  assert.equal(source?.sourceId, "default-companion");
  assert.equal(source?.revision, "3");
  // always-on premise renders, the constant entry renders, keyword-gated entry does not.
  assert.match(source?.content ?? "", /player-reviewed companion backdrop/);
  assert.match(source?.content ?? "", /琥珀与玩家是共同开拓农场的青梅竹马合伙人。/);
  assert.doesNotMatch(source?.content ?? "", /雨天喜欢在门廊煮热茶看雨。/);
  assert.deepEqual(catalog.volatileSources, []);
  // Canonical hash is deterministic: same input -> same catalog.
  const again = buildGameSurfaceAuthoredCatalog(
    {
      continuityId: "continuity",
      sessionId: "pi-session",
      surface: "game",
      threadId: "game-session",
      profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
    },
    binding,
  );
  assert.equal(again.canonicalHash, catalog.canonicalHash);
  // Budget is bounded by the 2K stable-context ceiling.
  assert.ok(source.budgetTokens > 0);
});

test("buildGameSurfaceAuthoredCatalog refuses a non-game binding", async () => {
  const worldBook = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "wb",
    revision: 1,
    alwaysOnPremise: "backdrop",
    entries: [],
  });
  const binding = { metadata: worldBookMetadata(worldBook), book: worldBook };
  assert.throws(
    () =>
      buildGameSurfaceAuthoredCatalog(
        {
          continuityId: "continuity",
          sessionId: "pi-session",
          surface: "tavern",
          threadId: "thread",
          profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
        },
        binding,
      ),
    /game_authored_context_surface_mismatch/,
  );
});

test("buildGameSurfaceAuthoredCatalog renders worldbook macros, drops an unrenderable entry and refuses a poisoned premise", () => {
  // The failure the rendering half catches: the preset worldbook ships
  // `{{user}}`, and publishing it raw put a literal brace placeholder in the
  // companion's m[0] authored context. The failure the assertion catches: a
  // hand-placed book reaches this function unchanged, so rendering upstream is
  // not enough to keep a placeholder out of a published source.
  const scope = {
    continuityId: "continuity",
    sessionId: "pi-session",
    surface: "game" as const,
    threadId: "game-session",
    profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
  };
  const worldBook = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "macro-worldbook",
    revision: 1,
    alwaysOnPremise: "{{user}} arrives at the valley.",
    entries: [
      {
        entryId: "kohaku-pact",
        title: "Farm pact",
        content: "{{char}} and {{user}} share the farm.",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
        constant: true,
      },
      {
        entryId: "kohaku-broken",
        title: "Broken",
        content: "A {{unknown_macro}} reference.",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
        constant: true,
      },
    ],
  });
  const catalog = buildGameSurfaceAuthoredCatalog(
    scope,
    { metadata: worldBookMetadata(worldBook), book: worldBook },
    { char: "Kohaku" },
  );
  const content = catalog.stableSources[0]?.content ?? "";
  assert.match(content, /the player arrives at the valley\./);
  assert.match(content, /Kohaku and the player share the farm\./);
  // The entry the macro set cannot fully render is dropped, not published.
  assert.doesNotMatch(content, /unknown_macro/);
  assert.doesNotMatch(content, /\{\{/u);

  // Plant an unresolved macro in the premise: the published-source assertion fails.
  const poisoned = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "macro-worldbook",
    revision: 1,
    alwaysOnPremise: "A {{unrendered}} premise.",
    entries: [],
  });
  assert.throws(
    () =>
      buildGameSurfaceAuthoredCatalog(
        scope,
        { metadata: worldBookMetadata(poisoned), book: poisoned },
        { char: "Kohaku" },
      ),
    /game_authored_context_unrendered_macro/,
  );
});
test("native WorldBookBinding materializes constant entries into lorebook_constant and keyword entries as volatile", async () => {
  const root = await canonicalTestRoot("gamebuddy-native-catalog-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  // A bound WorldBookBinding metadata exactly as the reviewed import writes it.
  const book = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "gamebuddy-worldbook-companion-x",
    revision: 1,
    alwaysOnPremise: "The valley breathes with the seasons.",
    entries: [
      {
        entryId: "companion-entry-10",
        title: "勤劳的伴侣",
        content: "见习农夫专注耕耘，没有多余的艺术特长。",
        scope: "setting",
        provenance: "reviewed-import",
        tokenBudget: "small",
        constant: true,
      },
      {
        entryId: "companion-entry-1",
        title: "喜欢晴天",
        content: "伴侣其实格外喜欢晴朗天气。",
        scope: "setting",
        provenance: "reviewed-import",
        tokenBudget: "small",
      },
    ],
  });
  const metadata = worldBookMetadata(book);
  const binding = {
    worldBookId: book.worldBookId,
    revision: metadata.revision,
    canonicalHash: metadata.canonicalHash,
    provenance: "reviewed-import" as const,
  };
  const threads = createChatThreadStore(root, "continuity-key");
  try {
    const creation = createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
      },
    });
    const thread = await creation.createExplicit({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      companionId: "companion",
      continuityId: "continuity",
      worldBookBinding: binding,
      opening: "blank",
    });
    const catalog = await materializeTavernAuthoredStableCatalog(
      paths,
      new TavernArtifactStore(root),
      thread.thread,
      {
        continuityId: "continuity",
        sessionId: "pi-session",
        surface: "tavern",
        threadId: "thread",
        profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
      },
      TEST_MACROS,
      {
        binding,
        alwaysOnPremise: book.alwaysOnPremise,
        constantEntries: book.entries.filter((entry) => entry.constant === true),
        keywordEntries: book.entries.filter((entry) => entry.constant !== true),
      },
    );
    const stable = catalog.stableSources.find((source) => source.kind === "lorebook_constant");
    assert.ok(stable);
    assert.equal(stable.sourceId, book.worldBookId);
    // The constant entry AND the premise ride the stable m[0] source.
    assert.match(stable.content, /The valley breathes/);
    assert.match(stable.content, /勤劳的伴侣/);
    assert.match(stable.content, /专注耕耘/);
    // Keyword-gated entry stays OUT of the stable prefix...
    assert.doesNotMatch(stable.content, /喜欢晴天/);
    // ...and becomes a volatile selection candidate instead.
    assert.equal(catalog.volatileSources.length, 1);
    assert.equal(catalog.volatileSources[0]?.kind, "lorebook_entry");
    assert.equal(catalog.volatileSources[0]?.content, "伴侣其实格外喜欢晴朗天气。");
    assert.deepEqual(catalog.volatileSources[0]?.selectionKeys, ["喜欢晴天"]);
  } finally {
    threads.close?.();
  }
});

test("the scenario's authored macros are rendered into the Chat catalog while the durable record keeps them", async () => {
  const root = await canonicalTestRoot("gamebuddy-catalog-scenario-macros-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  const artifacts = new TavernArtifactStore(root);
  const authored = "{{user}}与青梅竹马{{char}}一起在农场收菜。";
  const scenario = await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "scenarios", "scenario"), 1),
    {
      schemaVersion: 1 as const,
      revision: 1,
      scenarioId: "scenario",
      name: "{{char}}的清晨",
      description: authored,
      text: authored,
      provenance: "authored" as const,
      owner: "chat_override" as const,
    },
    validateTavernArtifact,
  );
  const threads = createChatThreadStore(root, "continuity-key");
  try {
    const creation = createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
      },
    });
    const thread = await creation.createExplicit({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      companionId: "companion",
      continuityId: "continuity",
      scenarioId: "scenario",
      stableArtifactBindings: [
        { kind: "scenario", sourceId: "scenario", revision: 1, canonicalHash: scenario.canonicalHash },
      ],
      opening: "blank",
    });
    const catalog = await materializeTavernAuthoredStableCatalog(
      paths,
      artifacts,
      thread.thread,
      {
        continuityId: "continuity",
        sessionId: "pi-session",
        surface: "tavern",
        threadId: "thread",
        profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
      },
      TEST_MACROS,
    );
    const content = catalog.stableSources.find((source) => source.kind === "scenario")?.content ?? "";
    assert.equal(content.includes("琥珀"), true, "the companion's own name resolves {{char}}");
    assert.equal(content.includes("玩家"), true, "the run's player reference resolves {{user}}");
    assert.doesNotMatch(content, /\{\{/u, "no raw macro reaches the companion's context");
    // The durable record keeps the card's own macros verbatim: the absence above is
    // the rendering, not a scenario that happened to contain none.
    const durable = await artifacts.read(
      tavernRevisionPath(join(paths.companionRoot, "scenarios", "scenario"), 1),
      validateTavernArtifact,
    );
    assert.ok((durable.artifact as Scenario).text.includes("{{user}}"));
    assert.ok((durable.artifact as Scenario).text.includes("{{char}}"));
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("the Chat catalog refuses a scenario macro the run cannot render", async () => {
  const root = await canonicalTestRoot("gamebuddy-catalog-scenario-poisoned-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  const artifacts = new TavernArtifactStore(root);
  const authored = "A {{unknown_macro}} reference.";
  const scenario = await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "scenarios", "poisoned"), 1),
    {
      schemaVersion: 1 as const,
      revision: 1,
      scenarioId: "poisoned",
      name: "Poisoned",
      description: authored,
      text: authored,
      provenance: "authored" as const,
      owner: "chat_override" as const,
    },
    validateTavernArtifact,
  );
  const threads = createChatThreadStore(root, "continuity-key");
  try {
    const creation = createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
      },
    });
    const thread = await creation.createExplicit({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      companionId: "companion",
      continuityId: "continuity",
      scenarioId: "poisoned",
      stableArtifactBindings: [
        { kind: "scenario", sourceId: "poisoned", revision: 1, canonicalHash: scenario.canonicalHash },
      ],
      opening: "blank",
    });
    await assert.rejects(
      () =>
        materializeTavernAuthoredStableCatalog(
          paths,
          artifacts,
          thread.thread,
          {
            continuityId: "continuity",
            sessionId: "pi-session",
            surface: "tavern",
            threadId: "thread",
            profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
          },
          TEST_MACROS,
        ),
      /tavern_stable_context_unrendered_scenario_macro/,
    );
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
