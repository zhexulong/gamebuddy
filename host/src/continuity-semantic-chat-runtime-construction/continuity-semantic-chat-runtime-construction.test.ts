import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  type ChatRuntimeBindingExecution,
  withConsumedChatRuntimeBinding,
} from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { createTestChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.test-support.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import {
  buildChatCompanionSystemPrompt,
  DEFAULT_IDENTITY_PROFILE,
  identityProfileMetadata,
  writeIdentityProfile,
} from "../identity-profile.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "../tavern/chat-thread-store.js";
import { createManagedWorldInfoBindingResolver } from "../tavern/world-info-binding/managed-world-info-binding.js";
import { createWorldInfoManagementRepository } from "../tavern/world-info-management/world-info-management.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  PlayerPreferenceStore,
  playerPreferencePath,
  resolveCompanionLocale,
} from "../settings/player-preference-store.js";
import { prepareExactChatRuntimeConstruction } from "./continuity-semantic-chat-runtime-construction.internal.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

function permit(execution: ChatRuntimeBindingExecution): ProductionChatRuntimePermit {
  return Object.freeze({
    principal: execution.principal,
    operationId: "operation_01",
    requestId: "request_01",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "chat_session_01",
    runtimeBindingDigest: execution.bindingFacts.runtimeBindingDigest,
    owner: execution.bindingFacts.owner,
    deadlineAtMs: Date.now() + 5_000,
    expected: Object.freeze({ partitionRevision: 1, fenceEpoch: 1, selectionRevision: 1 }),
    payloadDigest: "b".repeat(64),
    fenceToken: "fence_01",
    prepared: Object.freeze({ partitionRevision: 2, fenceEpoch: 2, selectionRevision: 1 }),
  });
}

type FixtureOptions = Readonly<{
  worldInfo?: Readonly<{
    publicTitle: string;
    summary: string;
    entries: readonly Readonly<{ scope: "companion" | "setting"; publicTitle: string; summary: string }>[];
    selectedRevision?: number;
  }>;
  /** The companion's OWN world book, as production binds it: a native binding whose metadata is read from
   * the very file the runtime will read (no `source` field, which is what distinguishes it from a managed
   * World Info binding). This is the path `createManifestDerivedInitialChatExactContentPort` takes. */
  ownWorldBookPath?: string;
}>;

async function fixture(options: FixtureOptions = {}) {
  const root = await canonicalTestRoot("chat-runtime-construction-");
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  const manifest = Object.freeze({
    schemaVersion: 2 as const,
    topology: "independent_chat_and_game_surfaces" as const,
    runtimeRoot,
    principal,
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
  });
  const binding = createTestChatRuntimeBinding({
    manifest,
    ownerProof: Object.freeze({ processId: 42, creationTime100ns: "123456" }),
  });
  let worldBookBinding: import("../tavern/chat-thread-store.js").TavernStableWorldInfoBinding | undefined;
  if (options.worldInfo !== undefined) {
    const repository = createWorldInfoManagementRepository(runtimeRoot);
    const created = await repository.create(options.worldInfo);
    worldBookBinding = await createManagedWorldInfoBindingResolver(repository).bindExact(
      options.worldInfo.publicTitle,
      options.worldInfo.selectedRevision ?? created.revision,
    );
  } else if (options.ownWorldBookPath !== undefined) {
    const { copyFile } = await import("node:fs/promises");
    const { readWorldBook, worldBookMetadata } = await import("../worldbook.js");
    const { identityKey } = await import("../runtime-identity.js");
    // The RUNTIME CWD, not the root: `runtime-identity.ts:107` puts the cwd at
    // `<root>/contexts/<identityKey(identity)>`, provisioning writes the book there
    // (`new-companion-service.ts:202`), and construction reads it there
    // (`continuity-semantic-chat-runtime-construction.internal.ts:306`). Writing it to the root instead is the
    // defect this fixture now guards against: the book was on disk, the runtime never read it, and the
    // companion answered as if it had no book at all.
    const runtimeCwd = join(runtimeRoot, "contexts", identityKey(principal));
    await mkdir(runtimeCwd, { recursive: true });
    const bookPath = join(runtimeCwd, "worldbook.json");
    await copyFile(options.ownWorldBookPath, bookPath);
    const book = await readWorldBook(bookPath);
    const metadata = worldBookMetadata(book);
    worldBookBinding = Object.freeze({
      worldBookId: book.worldBookId,
      revision: metadata.revision,
      canonicalHash: metadata.canonicalHash,
      // Required by the store's validator: a native binding carries its provenance (the reviewed card import
      // is "reviewed-import"; omitting it fails with `invalid_tavern_worldbook_binding`).
      provenance: "reviewed-import" as const,
    }) as never;
  }
  const threads = createChatThreadStore(runtimeRoot, identityKey(principal));
  const profile = Object.freeze({
    ...DEFAULT_IDENTITY_PROFILE,
    profileId: "profile_01",
    identity: Object.freeze({ ...DEFAULT_IDENTITY_PROFILE.identity }),
  });
  const profileMetadata = identityProfileMetadata(profile);
  const profilePaths = resolveRuntimePaths(principal, runtimeRoot, "chat_session_01");
  await writeIdentityProfile(profilePaths.identityProfilePath, profile);
  const creation = createProfileAwareChatThreadCreationCapability(threads, { async readExact() { return profileMetadata; } });
  await creation.createExplicit({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "chat_session_01",
    companionId: principal.companionId,
    continuityId: principal.continuityId,
    ...(worldBookBinding === undefined ? {} : { worldBookBinding }),
    opening: "blank",
  });
  return Object.freeze({ root, runtimeRoot, binding, threads });
}

/**
 * Releases both stores a fixture owns before its runtime root is removed.
 *
 * The fixture opens its own store, and `prepareExactChatRuntimeConstruction`
 * opens a second one on the same root. Production releases the construction's
 * store through `closeChatThreadStore()`; the fixture's belongs to the test. Both
 * hold a live SQLite connection, and an unclosed one keeps the runtime root from
 * being removed on Windows.
 */
async function releaseConstructionAndFixture(
  prepared: { readonly closeChatThreadStore?: () => void } | undefined,
  value: { readonly threads: { close?: () => void }; readonly root: string },
): Promise<void> {
  prepared?.closeChatThreadStore?.();
  value.threads.close?.();
  await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
test("Chat construction exposes only the exact catalog materialization handoff", async () => {
  const value = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    const catalog = await prepared.materializeStableContextForPiSession("pi_session_01");
    assert.equal(catalog.scope.threadId, "thread_01");
    assert.equal("publishStableContextForPiSession" in prepared, false);
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});

test("Chat construction publishes an exact managed World Info revision into the stable catalog", async () => {
  const value = await fixture({
    worldInfo: {
      publicTitle: "Pelican Town",
      summary: "Original town facts.",
      entries: [{ scope: "setting", publicTitle: "Square", summary: "Original square." }],
    },
  });
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    const catalog = await prepared.materializeStableContextForPiSession("pi_session_world_info");
    assert.deepEqual(catalog.stableSources.map((source) => source.kind), ["lorebook_constant"]);
    assert.equal(catalog.stableSources[0]?.revision, "1");
    assert.match(catalog.stableSources[0]?.sourceId ?? "", /^managed_world_info_[a-f0-9]{32}$/);
    assert.equal(catalog.stableSources[0]?.content.includes("Original town facts."), true);
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});

test("Chat construction derives model and exact stable Tavern snapshot from the binding-owned root", async () => {
  const value = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    assert.deepEqual(prepared.identity, principal);
    assert.equal(prepared.runtimeRoot, value.runtimeRoot);
    assert.equal(prepared.surfaceSessionId, "chat_session_01");
    assert.equal(prepared.modelConfig.provider, "cpa-oai");
    assert.equal(prepared.modelConfig.modelId, "deepseek-v4-flash");
    assert.equal(prepared.modelProfileRevision, 0);
    // Chat mounts no speaking pseudo-tool or presentation callback. Native
    // assistant content is observed privately by the bound provider invocation.
    assert.equal(prepared.presentation.admissionProvider, undefined);
    assert.equal(prepared.presentation.textPort, undefined);
    const stableContext = await prepared.materializeStableContextForPiSession("pi_session_genuine");
    assert.equal(stableContext.scope.continuityId, principal.continuityId);
    assert.equal(stableContext.scope.sessionId, "pi_session_genuine");
    assert.notEqual(stableContext.scope.sessionId, prepared.surfaceSessionId);
    assert.deepEqual(stableContext.stableSources, []);
    assert.match(stableContext.canonicalHash, /^[a-f0-9]{64}$/);
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});

test("Chat construction regenerates the canonical hash for each actual Pi session", async () => {
  const value = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    const first = await prepared.materializeStableContextForPiSession("pi_session_one");
    const second = await prepared.materializeStableContextForPiSession("pi_session_two");
    assert.notEqual(first.canonicalHash, second.canonicalHash);
    assert.equal(first.scope.sessionId, "pi_session_one");
    assert.equal(second.scope.sessionId, "pi_session_two");
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});

test("Chat construction rejects profile metadata drift before publication", async () => {
  const value = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    const paths = resolveRuntimePaths(principal, value.runtimeRoot, "chat_session_01");
    const drifted = Object.freeze({ ...DEFAULT_IDENTITY_PROFILE, profileId: "profile_drift", identity: Object.freeze({ ...DEFAULT_IDENTITY_PROFILE.identity }) });
    await writeIdentityProfile(paths.identityProfilePath, drifted);
    await assert.rejects(
      value.binding.executeWithBinding((token) =>
        withConsumedChatRuntimeBinding(token, (execution) =>
          prepareExactChatRuntimeConstruction(execution, permit(execution)),
        ),
      ),
      /chat_runtime_exact_content_unavailable/,
    );
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});

test("Chat construction rejects a missing exact Tavern thread rather than creating or selecting one", async () => {
  const value = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    await assert.rejects(
      value.binding.executeWithBinding((token) =>
        withConsumedChatRuntimeBinding(token, (execution) =>
          prepareExactChatRuntimeConstruction(
            execution,
            Object.freeze({ ...permit(execution), chatThreadId: "thread_missing" }),
          ),
        ),
      ),
      /chat_runtime_exact_content_unavailable/,
    );
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});

test("Chat construction takes the companion language from the player's stored preference", async () => {
  // The runtime must not carry a locale of its own: the same root read by the
  // management surface is what decides what the companion speaks, and the prompt's
  // single language authority follows it.
  const value = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    const paths = resolveRuntimePaths(principal, value.runtimeRoot, "chat_session_01");
    const store = new PlayerPreferenceStore(playerPreferencePath(value.runtimeRoot));
    // Never configured: the runtime's own default, unchanged from before the
    // preference existed.
    assert.equal(await resolveCompanionLocale(value.runtimeRoot), "zh-CN");
    const english = await store.update(0, { action: "setLocale", locale: "en-US" });
    assert.equal(english.locale, "en-US");
    prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    assert.equal(prepared.presentation.profile.locale, "en-US");
    // And that value is exactly what the prompt's language line will say.
    const prompt = buildChatCompanionSystemPrompt(
      DEFAULT_IDENTITY_PROFILE,
      prepared.presentation.profile.locale,
    );
    assert.match(prompt, /Consistently converse in English/u);
    assert.doesNotMatch(prompt, /Chinese/u);
    // A second construction on the same root sees the update: the preference is
    // durable state, not a mount-time snapshot.
    await store.update(english.revision, { action: "setLocale", locale: "zh-CN" });
    assert.equal(await resolveCompanionLocale(value.runtimeRoot), "zh-CN");
    const chinese = buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE, "zh-CN");
    assert.match(chinese, /Consistently converse in Chinese \(Simplified\)/u);
    void paths;
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});

test("Chat construction refuses an unreadable language preference instead of guessing", async () => {
  // A corrupt preference must not silently fall back to a language the player did
  // not choose.
  const value = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    const path = playerPreferencePath(value.runtimeRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not a preference", "utf8");
    await assert.rejects(
      () => resolveCompanionLocale(value.runtimeRoot),
      /invalid_player_preference_store/u,
    );
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});

// REMOVED (diagnosing-bugs Phase 3, hypothesis (a) confirmed): the test that stood here asserted that a
// keyword-gated entry from the companion's own world book reaches the STABLE catalog. It was red, but its
// red was not the product's behaviour: the fixture creates the thread through
// `createProfileAwareChatThreadCreationCapability` directly, while production creates it through
// `createManifestDerivedInitialChatExactContentPort`, whose `createExplicit` binds the companion's own book
// when the request carries none (`host/src/tavern/initial-chat-exact-content-port.ts:139-141`,
// `companionOwnWorldBookBinding`). With no binding on the thread, `resolveBoundWorldBookSource` is never
// called — a valid probe showed exactly that — so the assertion could never have been green, and removing
// the `constant === true` filter (the other candidate) legitimately changed nothing.
//
// The real seam for this symptom is therefore the PRODUCTION path: thread created through that port (native
// binding present) → construction → `resolveBoundWorldBookSource` forwards only `constant: true` entries
// (that file's L317) → 1 of the reviewed card's 37 entries reaches the context and the other 36
// (keyword-gated, e.g. the 大肥鱼 shyness and the two sisters) do not. The regression test belongs at that
// seam, with the volatile/per-turn channel in scope, and must state which channel it asserts.

// The seam this asserts is the PRODUCTION one: a thread carrying a NATIVE binding for the companion's own
// world book — what `createManifestDerivedInitialChatExactContentPort` binds when the request carries none —
// so `materializeContextForPiSession` reaches
// `resolveBoundWorldBookSource(effectiveBinding, runtimeCwd)`. Two directions: the always-on entry (control,
// which proves the machinery is reached at all) and a keyword-gated one (the reported symptom, where the
// companion answered as if it had no book).
test("Chat construction materializes the companion's own world book (always-on control + keyword-gated)", async () => {
  const { existsSync } = await import("node:fs");
  const { resolve: resolvePath } = await import("node:path");
  const { readWorldBook } = await import("../worldbook.js");
  let repoRoot: string | undefined;
  for (const candidate of [process.cwd(), resolvePath(process.cwd(), ".."), resolvePath(process.cwd(), "..", "..")]) {
    if (existsSync(resolvePath(candidate, "assets/tavern/presets/deepseek-chan/worldbook.json"))) {
      repoRoot = candidate;
      break;
    }
  }
  assert.ok(repoRoot !== undefined, "the reviewed card must be findable from the test cwd");
  const bookPath = resolvePath(repoRoot, "assets/tavern/presets/deepseek-chan/worldbook.json");
  const book = await readWorldBook(bookPath);
  const constantEntry = book.entries.find((entry) => entry.constant === true);
  const keywordEntry = book.entries.find((entry) => entry.constant !== true);
  assert.ok(constantEntry !== undefined && keywordEntry !== undefined, "the reviewed card has both kinds of entry");
  const value = await fixture({ ownWorldBookPath: bookPath });
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    // The DESIRED channel: in "mounted" mode a binding that has not been applied yet resolves to the
    // applied (undefined) one — that is the mount service's job, not construction's — so a fresh thread's
    // own book is reached through the desired materialization, which is exactly where
    // `resolveBoundWorldBookSource` runs.
    const catalog = await prepared.materializeDesiredStableContextForPiSession("pi_session_own_book");
    const materialized = catalog.stableSources.map((source) => source.content).join("\n");
    assert.equal(
      materialized.includes(constantEntry.content.slice(0, 12)),
      true,
      "control: the book's always-on entry reaches the materialization",
    );
    // A keyword-gated entry belongs to the PER-TURN channel: `deriveVolatileWorldInfoSources` exposes it as
    // a volatile selection candidate, and Magic Context selects it when the turn's text matches its key.
    // Asserting it on the stable channel (where the tests previously looked) asked the wrong question.
    const volatileContent = catalog.volatileSources.map((source) => source.content).join("\n");
    assert.equal(
      volatileContent.includes(keywordEntry.content.slice(0, 12)),
      true,
      "a keyword-gated fact from the companion's own world book must become a volatile per-turn candidate",
    );
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});
