import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import { DEFAULT_IDENTITY_PROFILE, identityProfileMetadata, writeIdentityProfile } from "../identity-profile.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "../tavern/chat-thread-store.js";
import { createManagedWorldInfoBindingResolver } from "../tavern/world-info-binding/managed-world-info-binding.js";
import { createWorldInfoManagementRepository } from "../tavern/world-info-management/world-info-management.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { validateWorldBook, writeWorldBook } from "../worldbook.js";
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

test("Chat construction binds the companion's own reviewed world book when the thread names none", async () => {
  // The reviewed import writes the card's world book into the companion's runtime
  // cwd. The Game surface compiles it into m[0] automatically; the Chat surface
  // materialized only what a thread bound, so a companion provisioned from a card
  // carried its backdrop in Game and silently lost it in Chat. With no explicit
  // binding, the companion's own book IS the background.
  const value = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    const paths = resolveRuntimePaths(principal, value.runtimeRoot, "chat_session_01");
    await mkdir(paths.runtimeCwd, { recursive: true });
    await writeWorldBook(
      join(paths.runtimeCwd, "worldbook.json"),
      validateWorldBook({
        schemaVersion: 1,
        worldBookId: "gamebuddy-worldbook-companion_01",
        revision: 1,
        alwaysOnPremise: "The valley breathes with the seasons.",
        entries: [
          {
            entryId: "card-entry-1",
            title: "Footpaths",
            content: "Knows every footpath around the valley.",
            scope: "setting",
            provenance: "reviewed-import",
            tokenBudget: "small",
            constant: true,
          },
          {
            entryId: "card-entry-2",
            title: "Likes",
            content: "Fond of a quiet morning.",
            scope: "setting",
            provenance: "reviewed-import",
            tokenBudget: "small",
          },
        ],
      }),
    );
    prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    const catalog = await prepared.materializeStableContextForPiSession("pi_session_companion_book");
    assert.deepEqual(catalog.stableSources.map((source) => source.kind), ["lorebook_constant"]);
    assert.equal(catalog.stableSources[0]?.sourceId, "gamebuddy-worldbook-companion_01");
    // The always-on entry and the premise ride the stable source.
    assert.match(catalog.stableSources[0]?.content ?? "", /valley breathes/);
    assert.match(catalog.stableSources[0]?.content ?? "", /every footpath/);
    // Keyword-gated entries do NOT ride the stable prefix, and are not published
    // as volatile candidates either: Chat registers its catalog once per Pi
    // session while the volatile channel binds per turn, so candidates published
    // here could never agree with a turn binding.
    assert.doesNotMatch(catalog.stableSources[0]?.content ?? "", /quiet morning/);
    assert.deepEqual(catalog.volatileSources, []);
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});

test("Chat construction fails closed on a companion world book it cannot read", async () => {
  // A present but unreadable book must refuse construction rather than silently
  // materializing an empty backdrop, the same way a drifted binding does.
  const value = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    const paths = resolveRuntimePaths(principal, value.runtimeRoot, "chat_session_01");
    await mkdir(paths.runtimeCwd, { recursive: true });
    await writeFile(join(paths.runtimeCwd, "worldbook.json"), "{ not a world book", "utf8");
    prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    await assert.rejects(
      () => prepared!.materializeStableContextForPiSession("pi_session_broken_book"),
      /chat_runtime_exact_content_unavailable/,
    );
  } finally {
    await value.binding.close();
    await releaseConstructionAndFixture(prepared, value);
  }
});
