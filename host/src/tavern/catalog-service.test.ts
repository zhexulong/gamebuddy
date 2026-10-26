import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { rm } from "node:fs/promises";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { readAuthoredContextRegistry } from "../test-support/authored-context-catalog.test-support.js";
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
import { DEFAULT_COMPANION_PRESET } from "./default-companion-preset.js";
import { macroTable } from "./macro-engine.js";
import { writeCompanionPostHistoryInstructions } from "./post-history-instructions.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import { type Scenario, validateTavernArtifact } from "./types.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

// The run's macro table for these fixtures: a zh companion named 琥珀, so a
// scenario's own {{char}}/{{user}} resolve to 琥珀/你 (the player being addressed,
// never the third-person noun 玩家).
const TEST_MACROS = macroTable({ char: "琥珀", locale: "zh-CN" });

/** One reviewed always-on entry of a managed World Info layer, as its author wrote it. */
type ManagedConstant = Readonly<{ publicTitle: string; summary: string }>;
/**
 * The prose a managed World Info layer publishes when it carries any always-on entry: the
 * layer's own title, then each constant under its own heading - what the player authored.
 */
function renderedWorldInfo(publicTitle: string, constants: readonly ManagedConstant[]): string {
  return [`## ${publicTitle}`, ...constants.flatMap((entry) => [`## ${entry.publicTitle}`, entry.summary])].join(
    "\n\n",
  );
}

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
      managedWorldInfoBinding: exact.binding,
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
      { managedWorldInfo: exact },
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
    // A short source publishes exactly the authored prose, byte for byte - the reading is
    // unchanged by the removal of the per-source cap.
    assert.equal(catalog.stableSources[0]?.content, "## Pelican Town\n\n## Town square\n\nThe center of town.");
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
          { managedWorldInfo: { ...exact, content: `${exact.content}tampered` } },
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
          { managedWorldInfo: exact },
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
          { managedWorldInfo: { ...exact, binding: { ...exact.binding, canonicalHash: "b".repeat(64) } } },
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
      managedWorldInfoBinding: exact.binding,
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
      { managedWorldInfo: exact },
    );
    const stable = catalog.stableSources[0]!;
    // The per-source budget the reference reports is accounting, not a cap: it counts the
    // published source's own bytes.
    assert.equal(stable.budgetTokens, Math.ceil(stable.content.length / 4));
    assert.match(stable.content, /Always Town/);
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

test("stable World Info publishes every constant in full when the authored content exceeds the old overview threshold", async (t) => {
  const root = await canonicalTestRoot("gamebuddy-catalog-overview-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  const repository = createWorldInfoManagementRepository(root);
  let closeStore: (() => void) | undefined;
  try {
    // Five 4 000-character constants: the rendered source is well past the 2 048-token
    // per-source point the catalog used to shorten at.
    const LONG_ENTRY_CHARS = 4_000;
    const longEntries: readonly ManagedConstant[] = Array.from({ length: 5 }, (_, index) => ({
      publicTitle: `Large constant ${index + 1}`,
      summary: String.fromCharCode(97 + index).repeat(LONG_ENTRY_CHARS),
    }));
    const created = await repository.create({
      publicTitle: "Large Lore",
      summary: "Compact overview.",
      entries: longEntries.map((entry) => ({ scope: "setting" as const, ...entry, constant: true })),
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
      managedWorldInfoBinding: exact.binding,
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
      { managedWorldInfo: exact },
    );
    const stable = catalog.stableSources[0]!;
    // The rendered input is the overview heading and every constant under its own heading -
    // what the player authored, joined as prose.
    const renderedInput = renderedWorldInfo("Large Lore", longEntries);
    assert.ok(
      renderedInput.length > 2_048 * 4,
      `fixture must exceed the old per-source point: ${renderedInput.length}`,
    );
    t.diagnostic(`rendered input ${renderedInput.length} chars; published ${stable.content.length} chars`);
    // Published IN FULL: the body is exactly the rendered input, byte for byte, and its own
    // budget accounting equals it.
    assert.equal(stable.content, renderedInput);
    assert.equal(stable.content.length, renderedInput.length);
    assert.equal(stable.budgetTokens, Math.ceil(renderedInput.length / 4));
    // The tail of the player's text is what the old truncation dropped; it is present now.
    assert.equal(stable.content.endsWith(longEntries[4]!.summary), true);
    assert.match(stable.content, /^## Large Lore/m);
    assert.match(stable.content, /^## Large constant 1$/m);
    assert.match(stable.content, /^## Large constant 5$/m);
    for (const entry of longEntries) assert.equal(stable.content.includes(entry.summary), true);
    // The same bytes survive the vendor's own publisher - the renderer whose block the provider
    // actually receives - so nothing downstream re-imposes a cap of its own.
    const scope = {
      continuityId: "continuity",
      sessionId: "pi-session",
      surface: "tavern" as const,
      threadId: "thread",
      profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
    };
    const { publishGameBuddyAuthoredStableCatalog } = await import("@cortexkit/pi-magic-context/tavern");
    const capability = publishGameBuddyAuthoredStableCatalog(scope, catalog);
    try {
      const rendered = readAuthoredContextRegistry()?.materializations.get(scope.sessionId)?.renderedBlock ?? "";
      t.diagnostic(`rendered block ${rendered.length} chars around the ${renderedInput.length}-char authored input`);
      assert.ok(
        rendered.length > renderedInput.length,
        `the rendered block carries all the authored bytes: ${rendered.length}`,
      );
      assert.equal(rendered.includes(longEntries[0]!.summary), true);
      assert.equal(rendered.includes(longEntries[4]!.summary), true);
      assert.equal(rendered.includes(`## ${longEntries[4]!.publicTitle}`), true);
    } finally {
      await capability.clear();
    }
  } finally {
    closeStore?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a larger authored source publishes a larger body and a different stable hash", async (t) => {
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const publish = async (prefix: string, entries: readonly ManagedConstant[]) => {
    const root = await canonicalTestRoot(prefix);
    const paths = resolveTavernPaths({ root } as never, identity);
    const repository = createWorldInfoManagementRepository(root);
    const threads = createChatThreadStore(root, "continuity-key");
    try {
      const created = await repository.create({
        publicTitle: "Field Notes",
        summary: "Notes from the valley.",
        entries: entries.map((entry) => ({ scope: "setting" as const, ...entry, constant: true })),
      });
      const resolver = createManagedWorldInfoBindingResolver(repository);
      const exact = await resolver.resolve(await resolver.bindExact(created.publicTitle, 1));
      const thread = await createProfileAwareChatThreadCreationCapability(threads, {
        async readExact() {
          return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
        },
      }).createExplicit({
        chatThreadId: "thread",
        chatSurfaceSessionId: "surface",
        companionId: "companion",
        continuityId: "continuity",
        managedWorldInfoBinding: exact.binding,
        opening: "blank",
      });
      return await materializeTavernAuthoredStableCatalog(
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
        { managedWorldInfo: exact },
      );
    } finally {
      threads.close?.();
      await rm(root, { recursive: true, force: true });
    }
  };

  const shortEntries: readonly ManagedConstant[] = [
    { publicTitle: "Season", summary: "Spring arrives late this year." },
  ];
  // One entry per 4 000 authored characters: the authored field bound, not a publish-time cap.
  const longEntries: readonly ManagedConstant[] = [
    ...shortEntries,
    ...Array.from({ length: 6 }, (_, index) => ({ publicTitle: `Field ${index + 1}`, summary: "雨".repeat(4_000) })),
  ];
  const short = await publish("gamebuddy-catalog-size-short-", shortEntries);
  const long = await publish("gamebuddy-catalog-size-long-", longEntries);
  const shortSource = short.stableSources[0]!;
  const longSource = long.stableSources[0]!;
  t.diagnostic(
    `short body ${shortSource.content.length} chars / ${shortSource.budgetTokens} tokens; long body ${longSource.content.length} chars / ${longSource.budgetTokens} tokens`,
  );
  // Nothing is trimmed to a common ceiling: each body IS the rendered authored input, so the
  // larger source is the larger body by the characters and the entry headings its author added.
  assert.equal(shortSource.content, renderedWorldInfo("Field Notes", shortEntries));
  assert.equal(longSource.content, renderedWorldInfo("Field Notes", longEntries));
  assert.ok(longSource.content.length - shortSource.content.length > 24_000);
  assert.ok(longSource.content.length > 20_000);
  assert.ok(longSource.budgetTokens > shortSource.budgetTokens);
  assert.equal(longSource.content.endsWith("雨".repeat(4_000)), true);
  // The stable hash covers the published bytes, so a different source is a different hash -
  // at the source and at the catalog.
  assert.notEqual(longSource.canonicalHash, shortSource.canonicalHash);
  assert.notEqual(long.canonicalHash, short.canonicalHash);
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
test("buildGameSurfaceAuthoredCatalog mounts the reviewed always-on WorldBook as a lorebook_constant m[0] source and its keyword entries as per-turn volatile candidates", async () => {
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
  // The keyword-gated entry is not dropped, it is the per-turn half: the Game scope
  // composes volatile candidates with the SAME `deriveVolatileWorldInfoSources` the Chat
  // scope uses, so the entry the constant-only Game catalog used to lose entirely is now
  // selectable for a turn. Its trigger words are the card's title when it names none, and
  // its total order key continues AFTER the stable source (one increasing sequence).
  assert.equal(catalog.volatileSources.length, 1);
  assert.equal(catalog.volatileSources[0]?.kind, "lorebook_entry");
  assert.equal(catalog.volatileSources[0]?.content, "雨天喜欢在门廊煮热茶看雨。");
  assert.deepEqual(catalog.volatileSources[0]?.selectionKeys, ["雨天安排"]);
  assert.equal(catalog.volatileSources[0]?.totalOrderKey, "0002");
  assert.equal(catalog.volatileSources[0]?.sourceId, `${worldBook.worldBookId}_entry_1`);
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
  // Budget accounting reports the published bytes; it is not a ceiling the source is held
  // under.
  assert.equal(source?.budgetTokens, Math.ceil((source?.content.length ?? 0) / 4));
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
  assert.match(content, /Kohaku and you share the farm\./);
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
test("a Game keyword entry is PUBLISHED as a live per-turn candidate, and the vendor's own selector binds it to the turn whose world state names it", async () => {
  // The Game-surface defect this pins: the Game catalog carried NO volatile candidates at all, so the
  // card's keyword-gated entries could never reach the companion however correct the rest of the chain
  // was. This drives the vendor's OWN publisher and per-turn selector - the same capability the Game
  // runtime now holds - so "the entry reached the model" is a claim about the published catalog and the
  // extension's reader channel, not about a helper in this file.
  const worldBook = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "gamebuddy-worldbook-companion-game",
    revision: 4,
    alwaysOnPremise: "山谷的四季轮转。",
    entries: [
      {
        entryId: "e-constant",
        title: "农场誓约",
        content: "琥珀与玩家一同开垦这片荒地。",
        scope: "setting",
        provenance: "reviewed-import",
        tokenBudget: "small",
        constant: true,
      },
      {
        entryId: "e-rain",
        title: "雨天恩赐与安排",
        content: "下雨时山谷的雨水浸透整座农场，省去一整天的浇灌。",
        scope: "setting",
        provenance: "reviewed-import",
        tokenBudget: "small",
        keys: ["下雨", "雨天", "暴雨"],
      },
    ],
  });
  const scope = {
    continuityId: "continuity",
    sessionId: "pi-session-game-volatile",
    surface: "game" as const,
    threadId: "game-session",
    profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
  };
  const catalog = buildGameSurfaceAuthoredCatalog(scope, {
    metadata: worldBookMetadata(worldBook),
    book: worldBook,
  });
  const { publishGameBuddyAuthoredStableCatalog } = await import("@cortexkit/pi-magic-context/tavern");
  // A vendor rejection here (its v2 validator re-derives the catalog's canonical form) would mean the
  // Game catalog's hash and shape do not match what the extension accepts.
  const capability = publishGameBuddyAuthoredStableCatalog(scope, catalog);
  try {
    assert.equal(catalog.volatileSources.length, 1);
    assert.deepEqual(catalog.volatileSources[0]?.selectionKeys, ["下雨", "雨天", "暴雨"]);
    // Nothing is selected before a turn owns it.
    assert.equal(readAuthoredContextRegistry()?.volatileTurns.get(scope.sessionId), undefined);
    // The turn's world state names the card's own trigger word, so the vendor's selector binds exactly
    // that entry - and the same text is what the extension injects as <runtime-environment>.
    const bound = capability.materializeVolatileForTurn(
      "turn_0001",
      "现在正在下雨，土地已经湿透了。",
      "天气：雨天；体力: 20（已疲惫）",
    );
    assert.deepEqual(
      bound.refs.map((ref) => ref.sourceId),
      [`${worldBook.worldBookId}_entry_1`],
    );
    assert.equal(
      bound.refs[0]?.canonicalHash,
      createHash("sha256").update(catalog.volatileSources[0]!.content, "utf8").digest("hex"),
    );
    // The binding is the one the extension's m[1] reader consumes, keyed by the exact Pi session.
    const registryBinding = readAuthoredContextRegistry()?.volatileTurns.get(scope.sessionId);
    assert.equal(registryBinding?.turnId, "turn_0001");
    assert.deepEqual(
      (registryBinding?.sourceRefs ?? []).map((ref) => (ref as Readonly<{ sourceId: string }>).sourceId),
      [`${worldBook.worldBookId}_entry_1`],
    );
    capability.clearVolatileForTurn("turn_0001");
    assert.equal(readAuthoredContextRegistry()?.volatileTurns.get(scope.sessionId), undefined);
    // A turn whose delivered text names nothing selects nothing: the entry is chosen, never always-on.
    const quiet = capability.materializeVolatileForTurn("turn_0002", "平静的一天，什么也没发生。", "天气：晴天");
    assert.deepEqual(quiet.refs, []);
    capability.clearVolatileForTurn("turn_0002");
  } finally {
    await capability.clear();
  }
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
        // The card's own second gate, the shape an imported entry carries once its
        // `secondary_keys` survive the import: this entry is only about sunny days the
        // player also brought a picnic or the washing into.
        secondaryKeys: ["野餐", "晒被子"],
        selectiveLogic: 0,
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
      companionWorldBookBinding: binding,
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
        companionWorldBook: {
          binding,
          alwaysOnPremise: book.alwaysOnPremise,
          constantEntries: book.entries.filter((entry) => entry.constant === true),
          keywordEntries: book.entries.filter((entry) => entry.constant !== true),
        },
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
    // The secondary gate reaches the per-turn selector with the primary words: it is
    // the only place the four SillyTavern modes are applied, so a candidate built
    // without it can never honour the card's own rule.
    assert.deepEqual(catalog.volatileSources[0]?.secondaryKeys, ["野餐", "晒被子"]);
    assert.equal(catalog.volatileSources[0]?.selectiveLogic, 0);
  } finally {
    threads.close?.();
  }
});

/**
 * What the model is told reads as her world, not as the record it is stored in.
 *
 * The block opens with "everything below is the established background setting ... treat it as
 * canon", and then used to hand the model a database row for every source but the scenario: her
 * person as `{"description":...,"name":...}`, her example exchanges as a `blocks` array with
 * escaped lore on one line. A model asked to keep canon has to read the player's words.
 *
 * Asserted on the RENDERED block, through the vendor's own publisher, because that string - not
 * the catalog object - is what the provider receives; and on every authored word surviving it.
 * The vendor's validator re-derives the catalog's canonical form before it mints a capability,
 * so publishing is also what proves the catalogue's hash still behaves as it did.
 */
test("every authored source reaches the model as prose, with the durable record's identity left out", async () => {
  const root = await canonicalTestRoot("gamebuddy-authored-prose-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  const artifacts = new TavernArtifactStore(root);
  const PERSONA_TEXT = "SENTINEL-PERSONA: 山谷里长大的木匠，话不多，习惯在清晨先给屋外的水缸添满水。";
  const EXAMPLE_TEXT = "SENTINEL-EXAMPLE: 你: 今天先把西边那垄翻了？\n琥珀: 先喝口水，太阳还没上来呢。";
  const persona = await artifacts.write(
    tavernRevisionPath(join(paths.playerRoot, "personas", "persona"), 1),
    { schemaVersion: 1 as const, revision: 1, personaId: "persona", name: "阿明", description: PERSONA_TEXT },
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
      text: DEFAULT_COMPANION_PRESET.scenario ?? "Quiet.",
      provenance: "authored" as const,
      owner: "chat_override" as const,
    },
    validateTavernArtifact,
  );
  const examples = await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "dialogue-examples", "examples"), 1),
    { schemaVersion: 1 as const, revision: 1, examplesId: "examples", blocks: [EXAMPLE_TEXT] },
    validateTavernArtifact,
  );
  // The shipped card's own book, exactly as the reviewed import binds it to a Chat.
  const book = DEFAULT_COMPANION_PRESET.worldBook;
  const metadata = worldBookMetadata(book);
  const binding = {
    worldBookId: book.worldBookId,
    revision: metadata.revision,
    canonicalHash: metadata.canonicalHash,
    provenance: "reviewed-import" as const,
  };
  const constants = book.entries.filter((entry) => entry.constant === true);
  const threads = createChatThreadStore(root, "continuity-key");
  try {
    const thread = await createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
      },
    }).createExplicit({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      companionId: "companion",
      continuityId: "continuity",
      personaId: "persona",
      scenarioId: "scenario",
      stableArtifactBindings: [
        { kind: "persona", sourceId: "persona", revision: 1, canonicalHash: persona.canonicalHash },
        { kind: "scenario", sourceId: "scenario", revision: 1, canonicalHash: scenario.canonicalHash },
        { kind: "dialogue_examples", sourceId: "examples", revision: 1, canonicalHash: examples.canonicalHash },
      ],
      companionWorldBookBinding: binding,
      opening: "blank",
    });
    const scope = {
      continuityId: "continuity",
      sessionId: "pi-authored-prose",
      surface: "tavern" as const,
      threadId: "thread",
      profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
    };
    const catalog = await materializeTavernAuthoredStableCatalog(paths, artifacts, thread.thread, scope, TEST_MACROS, {
      companionWorldBook: {
        binding,
        alwaysOnPremise: book.alwaysOnPremise,
        constantEntries: constants,
        keywordEntries: book.entries.filter((entry) => entry.constant !== true),
      },
    });
    assert.deepEqual(
      catalog.stableSources.map((source) => source.kind),
      ["dialogue_examples", "persona", "scenario", "lorebook_constant"],
    );
    // No source is a JSON record any more: each one is prose the model can read.
    for (const source of catalog.stableSources) {
      assert.equal(
        source.content.trimStart().startsWith("{"),
        false,
        `${source.kind} must not reach the model as a JSON record: ${source.content.slice(0, 120)}`,
      );
      // The hash still binds the rendered bytes, exactly as before: only the rendering moved.
      assert.equal(
        source.canonicalHash,
        createHash("sha256").update(source.content, "utf8").digest("hex"),
        `${source.kind}'s published hash must bind the prose it publishes`,
      );
    }

    const { publishGameBuddyAuthoredStableCatalog } = await import("@cortexkit/pi-magic-context/tavern");
    const capability = publishGameBuddyAuthoredStableCatalog(scope, catalog);
    try {
      const materialization = readAuthoredContextRegistry()?.materializations.get(scope.sessionId);
      assert.notEqual(materialization, undefined, "the vendor accepted the catalog this test built");
      const block = materialization?.renderedBlock ?? "";
      // The renderer XML-escapes `<`, `>` and `&`; nothing else is rewritten.
      const readable = block.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
      // Every authored word survives, byte for byte, in what the model receives.
      for (const authored of [
        "阿明",
        PERSONA_TEXT,
        DEFAULT_COMPANION_PRESET.scenario ?? "",
        book.alwaysOnPremise,
        ...constants.map((entry) => entry.content),
        EXAMPLE_TEXT,
      ])
        assert.equal(readable.includes(authored), true, `the model must read the authored words verbatim: ${authored}`);
      // ...and the entries keep ONE readable frame: their own title as a heading.
      for (const entry of constants)
        assert.equal(
          readable.includes(`## ${entry.title}`),
          true,
          `the entry keeps its authored title as a heading: ${entry.title}`,
        );
      // The durable record's identity is bookkeeping and stays out of the prompt.
      for (const identifier of ["entryId", "worldBookId", "personaId", "examplesId", '"blocks"'])
        assert.equal(
          block.includes(identifier),
          false,
          `${identifier} is durable bookkeeping and must not reach the model: ${block.slice(0, 400)}`,
        );
    } finally {
      await capability.clear();
    }
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true });
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
    assert.equal(content.includes("你"), true, "the run's player reference resolves {{user}}");
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

test("buildGameSurfaceAuthoredCatalog mounts the companion's scenario as Tier 2 stable background without moving the book or the volatile layer", () => {
  const scope = {
    continuityId: "continuity",
    sessionId: "pi-session-game-scenario",
    surface: "game" as const,
    threadId: "game-session",
    profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
  };
  const worldBook = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "default-companion",
    revision: 3,
    alwaysOnPremise: "The reviewed companion backdrop.",
    entries: [
      {
        entryId: "pact",
        title: "Farm pact",
        content: "{{char}} and {{user}} share the farm.",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
        constant: true,
      },
      {
        entryId: "rain",
        title: "Rainy plan",
        content: "Tea on the porch when it rains.",
        scope: "setting",
        provenance: "st-card-import",
        tokenBudget: "small",
      },
    ],
  });
  const binding = { metadata: worldBookMetadata(worldBook), book: worldBook };
  const withoutScenario = buildGameSurfaceAuthoredCatalog(scope, binding, { char: "Kohaku" });
  const catalog = buildGameSurfaceAuthoredCatalog(
    scope,
    binding,
    { char: "Kohaku" },
    {
      scenarioId: "player-scenario-abc",
      revision: 2,
      canonicalHash: "b".repeat(64),
      text: "{{char}} left the city and took over grandfather's run-down farm beside {{user}}.",
    },
  );

  // The scenario is a stable source under the existing `scenario` kind - the
  // same vocabulary the Chat catalog and the vendor validator already speak.
  const scenarioSource = catalog.stableSources.find((source) => source.kind === "scenario");
  assert.equal(scenarioSource?.sourceId, "player-scenario-abc");
  assert.equal(scenarioSource?.revision, "2");
  // Rendered through the run's macro table: never a raw `{{user}}`/`{{char}}`.
  assert.match(scenarioSource?.content ?? "", /Kohaku left the city/u);
  assert.match(scenarioSource?.content ?? "", /beside the player\./u);
  assert.doesNotMatch(scenarioSource?.content ?? "", /\{\{/u);
  // The book's own stable source and the per-turn volatile layer keep their exact
  // bytes and total order keys: the scenario only ADDS a stable source.
  assert.deepEqual(
    catalog.stableSources.find((source) => source.kind === "lorebook_constant"),
    withoutScenario.stableSources.find((source) => source.kind === "lorebook_constant"),
  );
  assert.deepEqual(catalog.volatileSources, withoutScenario.volatileSources);
  assert.equal(withoutScenario.volatileSources[0]?.totalOrderKey, "0002");
  // One increasing sequence: the scenario continues after the book and its candidates.
  assert.equal(scenarioSource?.totalOrderKey, "0003");
});

test("the companion's scenario reaches the Game even when the card carries no world book", () => {
  const scope = {
    continuityId: "continuity",
    sessionId: "pi-session-game-scenario-solo",
    surface: "game" as const,
    threadId: "game-session",
    profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
  };
  const catalog = buildGameSurfaceAuthoredCatalog(
    scope,
    undefined,
    { char: "Kohaku" },
    {
      scenarioId: "player-scenario-solo",
      revision: 1,
      canonicalHash: "c".repeat(64),
      text: "{{char}} farms with {{user}}.",
    },
  );
  assert.deepEqual(
    catalog.stableSources.map((source) => source.kind),
    ["scenario"],
  );
  assert.equal(catalog.volatileSources.length, 0);
});

test("the Game catalog refuses a scenario macro the run cannot render", () => {
  const scope = {
    continuityId: "continuity",
    sessionId: "pi-session-game-scenario-poisoned",
    surface: "game" as const,
    threadId: "game-session",
    profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
  };
  assert.throws(
    () =>
      buildGameSurfaceAuthoredCatalog(
        scope,
        undefined,
        { char: "Kohaku" },
        {
          scenarioId: "poisoned",
          revision: 1,
          canonicalHash: "d".repeat(64),
          text: "A {{unknown_macro}} reference.",
        },
      ),
    /game_authored_context_unrendered_macro/,
  );
});

test("the vendor publishes the Game catalog carrying the companion's scenario as a stable kind", async () => {
  const scope = {
    continuityId: "continuity",
    sessionId: "pi-session-game-scenario-vendor",
    surface: "game" as const,
    threadId: "game-session",
    profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) },
  };
  const catalog = buildGameSurfaceAuthoredCatalog(
    scope,
    undefined,
    { char: "Kohaku" },
    {
      scenarioId: "player-scenario-vendor",
      revision: 1,
      canonicalHash: "e".repeat(64),
      text: "{{char}} farms with {{user}}.",
    },
  );
  const { publishGameBuddyAuthoredStableCatalog } = await import("@cortexkit/pi-magic-context/tavern");
  const capability = publishGameBuddyAuthoredStableCatalog(scope, catalog);
  try {
    assert.deepEqual(
      capability.prepare("preflight_01").sourceRefs.map((ref) => ref.kind),
      ["scenario"],
    );
  } finally {
    await capability.clear();
  }
});

const POST_HISTORY_IDENTITY = { playerId: "player", companionId: "companion", continuityId: "continuity" };

/**
 * One real Chat thread over the companion's own root, materialized through the product's
 * own catalog call - the seam that reads her `post-history-instructions.json`.
 */
async function closingDirectionFixture(root: string) {
  const paths = resolveTavernPaths({ root } as never, POST_HISTORY_IDENTITY);
  const artifacts = new TavernArtifactStore(root);
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
    opening: "blank",
  });
  const scope = Object.freeze({
    continuityId: "continuity",
    sessionId: "pi-session",
    surface: "tavern" as const,
    threadId: "thread",
    profile: Object.freeze({ profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) }),
  });
  return Object.freeze({
    paths,
    artifacts,
    scope,
    catalog: () => materializeTavernAuthoredContextCatalog(paths, artifacts, thread.thread, scope, TEST_MACROS),
    close: () => threads.close?.(),
  });
}

/**
 * Rewrites her durable closing direction.
 *
 * The record is written once, at provisioning (revision 1), and the product offers no
 * edit operation for it yet, so "the author changed this line" is a re-provisioned
 * record: the old file goes and the product's own writer stamps the new one.
 */
async function rewriteClosingDirection(
  artifacts: TavernArtifactStore,
  companionRoot: string,
  text: string,
): Promise<void> {
  await rm(join(companionRoot, "post-history-instructions.json"), { force: true });
  await writeCompanionPostHistoryInstructions(artifacts, companionRoot, text);
}

test("her card's closing direction is published from her own record, rendered, beside the hashed body", async () => {
  const root = await canonicalTestRoot("gamebuddy-catalog-post-history-");
  const fixture = await closingDirectionFixture(root);
  try {
    const silent = await fixture.catalog();
    // Absent stays absent: no member at all, not an empty string.
    assert.equal(Object.hasOwn(silent, "postHistoryInstructions"), false);
    // The hashed body is exactly the four members the fork recomputes it over.
    assert.equal(
      silent.canonicalHash,
      canonicalHash({
        version: "gamebuddy-authored-context-catalog/v2",
        scope: fixture.scope,
        stableSources: [],
        volatileSources: [],
      }),
    );

    await rewriteClosingDirection(
      fixture.artifacts,
      fixture.paths.companionRoot,
      "Close by raking {{char}}'s coals once, then look at {{user}}.",
    );
    const declared = await fixture.catalog();
    assert.equal(declared.postHistoryInstructions, "Close by raking 琥珀's coals once, then look at 你.");
    // Beside the hash, not inside it: the field renders after the transcript, so it can
    // never bust the cached prefix or its cache key.
    assert.equal(declared.canonicalHash, silent.canonicalHash);
    assert.equal(Object.hasOwn(declared, "postHistoryInstructions"), true);
  } finally {
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a changed record reaches the NEXT materialization: freshness comes from re-reading, not from the hash", async () => {
  const root = await canonicalTestRoot("gamebuddy-catalog-post-history-fresh-");
  const fixture = await closingDirectionFixture(root);
  try {
    const companionRoot = fixture.paths.companionRoot;
    await rewriteClosingDirection(fixture.artifacts, companionRoot, "Close by raking the coals once.");
    const first = await fixture.catalog();
    // Two consecutive materializations of an unchanged record are the same catalogue...
    assert.deepEqual(await fixture.catalog(), first);

    await rewriteClosingDirection(fixture.artifacts, companionRoot, "Close by hanging the kettle back on its hook.");
    const revised = await fixture.catalog();
    // ...and a changed record materializes differently at the SAME canonical hash, which
    // is why the removal of a hand-supplied field can rest on re-materializing her record.
    assert.equal(revised.postHistoryInstructions, "Close by hanging the kettle back on its hook.");
    assert.notDeepEqual(revised, first);
    assert.equal(revised.canonicalHash, first.canonicalHash);
  } finally {
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the closing direction refuses a macro the run cannot render and a rendered text past the shared 4 KB bound", async () => {
  const root = await canonicalTestRoot("gamebuddy-catalog-post-history-bounds-");
  const fixture = await closingDirectionFixture(root);
  try {
    const companionRoot = fixture.paths.companionRoot;
    await rewriteClosingDirection(fixture.artifacts, companionRoot, "x".repeat(4_096));
    assert.equal((await fixture.catalog()).postHistoryInstructions?.length, 4_096);

    // The bound is applied to the RENDERED bytes, so a macro that grows the text over
    // 4 KB is refused here instead of being sent and refused by the fork.
    await rewriteClosingDirection(fixture.artifacts, companionRoot, `${"x".repeat(4_092)}{{char}}`);
    await assert.rejects(() => fixture.catalog(), /tavern_stable_context_post_history_too_long/);

    await rewriteClosingDirection(fixture.artifacts, companionRoot, "Close as {{unknown_macro}} says.");
    await assert.rejects(() => fixture.catalog(), /tavern_stable_context_unrendered_post_history_macro/);
  } finally {
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
