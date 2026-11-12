import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  type ChatRuntimeBindingExecution,
  withConsumedChatRuntimeBinding,
} from "../../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { createTestChatRuntimeBinding } from "../../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.test-support.js";
import { prepareExactChatRuntimeConstruction } from "../../continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.js";
import { assembleGameRuntimeContext } from "../../continuity-semantic-game-runtime-materializer/game-runtime-context-assembly.js";
import type { ProductionChatRuntimePermit } from "../../continuity-semantic-store/continuity-semantic-production-store.js";
import { DEFAULT_IDENTITY_PROFILE, identityProfileMetadata, writeIdentityProfile } from "../../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../../path-lock.js";
import { identityKey, resolveRuntimePaths } from "../../runtime-identity.js";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { validateWorldBook, writeWorldBook } from "../../worldbook.js";
import { createBuildWindowsStaleLockReclaimer } from "../../windows-stale-lock-reclaimer/index.js";
import {
  buildGameSurfaceAuthoredCatalog,
  type TavernAuthoredContextCatalog,
  type TavernStableContextBinding,
} from "../catalog-service.js";
import {
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
  type TavernStableManagedWorldInfoBinding,
} from "../chat-thread-store.js";
import { createWorldInfoManagementRepository } from "../world-info-management/world-info-management.js";
import { createManagedWorldInfoBindingResolver } from "./managed-world-info-binding.js";

/**
 * Evidence for the continuity-scoped World Info activation (`ad7a64eb`): one record,
 * `identityKey -> {publicTitle, revision}`, read by both surfaces.
 *
 * Every reading here comes from a real runtime root. The library item is written through
 * `createWorldInfoManagementRepository`, the activation through its own `setActivation`,
 * the Game layer through `assembleGameRuntimeContext` (the call the Game materializer
 * makes) and the Chat layer through `prepareExactChatRuntimeConstruction` (the call the
 * Chat surface makes). No layer is handed in by the test, so a claim about "both readers"
 * is a claim about the production readers.
 *
 * Assertion messages name the layer each one is about: layer 1 is her own reviewed book
 * (always applied), layer 2 is the continuity's activated library item.
 */

const PRINCIPAL = Object.freeze({
  continuityId: "continuity_activation_01",
  companionId: "companion_activation_01",
  playerId: "player_activation_01",
});
/**
 * The Game identity carries the save/world pair the runtime core requires. It must still
 * name the SAME continuity key as the Chat principal: `identityKey` ignores that pair
 * whenever `continuityId` is present, which is what lets one activation record reach both.
 */
const GAME_IDENTITY = Object.freeze({
  ...PRINCIPAL,
  saveId: "save_activation_01",
  worldId: "world_activation_01",
});

const OWN_BOOK_ID = "gamebuddy.worldbook.activation";
const OWN_BOOK_PREMISE = "她与玩家在山谷里一起照料这片农场。";
const OWN_BOOK_CONSTANT = "她与玩家是共同开垦这片荒地的搭档。";
const OWN_BOOK_KEYWORD = "下雨时她会在门廊煮热茶看雨。";

const LIBRARY_TITLE = "山谷镇志";
const LIBRARY_CONSTANT_SUMMARY = "镇中央的广场在节日里聚满人。";
const LIBRARY_KEYWORD_SUMMARY = "北边矿洞的深处有寒冰与火焰两种矿层。";
const LIBRARY_ITEM = Object.freeze({
  publicTitle: LIBRARY_TITLE,
  summary: "一份公开的山谷镇资料。",
  entries: Object.freeze([
    Object.freeze({
      scope: "setting" as const,
      publicTitle: "镇广场",
      summary: LIBRARY_CONSTANT_SUMMARY,
      constant: true,
    }),
    Object.freeze({
      scope: "setting" as const,
      publicTitle: "矿洞",
      summary: LIBRARY_KEYWORD_SUMMARY,
      keys: Object.freeze(["矿洞"]),
    }),
  ]),
});

const SIBLING_TITLE = "北山矿井笔记";
const SIBLING_CONSTANT_SUMMARY = "北山矿井的入口在铁路旁，井口结着霜。";
const SIBLING_ITEM = Object.freeze({
  publicTitle: SIBLING_TITLE,
  summary: "另一份公开资料。",
  entries: Object.freeze([
    Object.freeze({
      scope: "setting" as const,
      publicTitle: "井口",
      summary: SIBLING_CONSTANT_SUMMARY,
      constant: true,
    }),
  ]),
});

const CHAT_THREAD = "thread_activation";
const CHAT_SURFACE_SESSION = "chat_session_activation";
const CHAT_PROFILE_ID = "profile_activation";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

function ownBook() {
  return validateWorldBook({
    schemaVersion: 1,
    worldBookId: OWN_BOOK_ID,
    revision: 3,
    alwaysOnPremise: OWN_BOOK_PREMISE,
    entries: [
      {
        entryId: "own-constant",
        title: "农场誓约",
        content: OWN_BOOK_CONSTANT,
        scope: "setting",
        provenance: "reviewed-import",
        tokenBudget: "small",
        constant: true,
      },
      {
        entryId: "own-rain",
        title: "雨天安排",
        content: OWN_BOOK_KEYWORD,
        scope: "setting",
        provenance: "reviewed-import",
        tokenBudget: "small",
        keys: ["下雨"],
      },
    ],
  });
}

function gameScope(sessionId: string): TavernStableContextBinding {
  return Object.freeze({
    continuityId: PRINCIPAL.continuityId,
    sessionId,
    surface: "game",
    threadId: "game-session-activation",
    profile: Object.freeze({ profileId: CHAT_PROFILE_ID, revision: 1, canonicalHash: "a".repeat(64) }),
  });
}

/**
 * A real runtime root. `ownBook` writes the reviewed world book where production reads it,
 * `<runtimeRoot>/contexts/<identityKey>/worldbook.json`.
 */
async function fixtureRoot(
  name: string,
  options: Readonly<{ ownBook?: boolean }> = {},
): Promise<Readonly<{ root: string; runtimeRoot: string }>> {
  const root = await canonicalTestRoot(`continuity-world-info-${name}-`);
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  if (options.ownBook === true) {
    const paths = resolveRuntimePaths(GAME_IDENTITY, runtimeRoot);
    await mkdir(paths.runtimeCwd, { recursive: true });
    await writeWorldBook(join(paths.runtimeCwd, "worldbook.json"), ownBook());
  }
  return Object.freeze({ root, runtimeRoot });
}

async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** The Game surface's own path: assembly (what the materializer calls), then the composer. */
async function gameCatalog(
  runtimeRoot: string,
  scope: TavernStableContextBinding,
): Promise<
  Readonly<{ context: Awaited<ReturnType<typeof assembleGameRuntimeContext>>; catalog: TavernAuthoredContextCatalog }>
> {
  const context = await assembleGameRuntimeContext({ identity: GAME_IDENTITY, runtimeRoot });
  return Object.freeze({
    context,
    catalog: buildGameSurfaceAuthoredCatalog(
      scope,
      context.worldBook,
      { char: null },
      context.scenario,
      context.worldInfo,
    ),
  });
}

function permit(
  execution: ChatRuntimeBindingExecution,
  threadId: string,
  surfaceSessionId: string,
): ProductionChatRuntimePermit {
  return Object.freeze({
    principal: execution.principal,
    operationId: "operation_activation",
    requestId: "request_activation",
    chatThreadId: threadId,
    chatSurfaceSessionId: surfaceSessionId,
    runtimeBindingDigest: execution.bindingFacts.runtimeBindingDigest,
    owner: execution.bindingFacts.owner,
    deadlineAtMs: Date.now() + 5_000,
    expected: Object.freeze({ partitionRevision: 1, fenceEpoch: 1, selectionRevision: 1 }),
    payloadDigest: "b".repeat(64),
    fenceToken: "fence_activation",
    prepared: Object.freeze({ partitionRevision: 2, fenceEpoch: 2, selectionRevision: 1 }),
  });
}

/**
 * The Chat surface's own path: create the conversation (optionally carrying its own managed
 * binding), then materialize the stable catalog the mounted Chat publishes for a Pi session.
 */
async function chatCatalog(
  runtimeRoot: string,
  input: Readonly<{
    piSessionId: string;
    threadId?: string;
    surfaceSessionId?: string;
    managedWorldInfoBinding?: TavernStableManagedWorldInfoBinding;
  }>,
): Promise<TavernAuthoredContextCatalog> {
  const threadId = input.threadId ?? CHAT_THREAD;
  const surfaceSessionId = input.surfaceSessionId ?? CHAT_SURFACE_SESSION;
  const paths = resolveRuntimePaths(PRINCIPAL, runtimeRoot, surfaceSessionId);
  const profile = Object.freeze({
    ...DEFAULT_IDENTITY_PROFILE,
    profileId: CHAT_PROFILE_ID,
    identity: Object.freeze({ ...DEFAULT_IDENTITY_PROFILE.identity }),
  });
  const profileMetadata = identityProfileMetadata(profile);
  await writeIdentityProfile(paths.identityProfilePath, profile);
  const threads = createChatThreadStore(runtimeRoot, identityKey(PRINCIPAL));
  const binding = createTestChatRuntimeBinding({
    manifest: Object.freeze({
      schemaVersion: 2 as const,
      topology: "independent_chat_and_game_surfaces" as const,
      runtimeRoot,
      principal: PRINCIPAL,
      bootstrapOperationId: "bootstrap_activation_01",
      authorityGeneration: 1,
    }),
    ownerProof: Object.freeze({ processId: process.pid, creationTime100ns: "123456" }),
  });
  const creation = createProfileAwareChatThreadCreationCapability(threads, {
    async readExact() {
      return profileMetadata;
    },
  });
  await creation.createExplicit({
    chatThreadId: threadId,
    chatSurfaceSessionId: surfaceSessionId,
    companionId: PRINCIPAL.companionId,
    continuityId: PRINCIPAL.continuityId,
    ...(input.managedWorldInfoBinding === undefined ? {} : { managedWorldInfoBinding: input.managedWorldInfoBinding }),
    opening: "blank",
  });
  let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
  try {
    prepared = await binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution, threadId, surfaceSessionId)),
      ),
    );
    return await prepared.materializeStableContextForPiSession(input.piSessionId);
  } finally {
    prepared?.closeChatThreadStore?.();
    threads.close?.();
    await binding.close();
  }
}

/** Collects what an operation writes to stderr, which is where a refused Game layer is named. */
async function withCapturedStderr<T>(operation: () => Promise<T>): Promise<Readonly<{ result: T; stderr: string }>> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    return Object.freeze({ result: await operation(), stderr: lines.join("") });
  } finally {
    process.stderr.write = original;
  }
}

test("the Game catalog carries her own book alone, both layers while the activation verifies, and her own book alone again once it is cleared", async () => {
  const { root, runtimeRoot } = await fixtureRoot("three-states", { ownBook: true });
  const scope = gameScope("pi_session_activation_three_states");
  const repository = createWorldInfoManagementRepository(runtimeRoot);
  try {
    const created = await repository.create(LIBRARY_ITEM);

    // (a) The library holds the item, but nothing is activated for this continuity.
    const bookOnly = await gameCatalog(runtimeRoot, scope);
    assert.equal(
      bookOnly.context.worldInfo,
      undefined,
      "layer 2: no activation record, so no managed source reaches the Game",
    );
    assert.deepEqual(
      bookOnly.catalog.stableSources.map((source) => source.sourceId),
      [OWN_BOOK_ID],
      "layer 1: her own book is the only stable source",
    );
    assert.match(bookOnly.catalog.stableSources[0]!.content, new RegExp(OWN_BOOK_CONSTANT, "u"));
    assert.doesNotMatch(
      JSON.stringify(bookOnly.catalog),
      new RegExp(LIBRARY_CONSTANT_SUMMARY, "u"),
      "layer 2: the library item exists and is still not materialized, because nothing is activated",
    );

    // (b) Activate the exact revision the library holds.
    const activated = await repository.setActivation(identityKey(GAME_IDENTITY), {
      publicTitle: LIBRARY_TITLE,
      revision: created.revision,
    });
    assert.equal(activated?.revision, created.revision, "the authority returns the exact revision it pinned");

    const withActivation = await gameCatalog(runtimeRoot, scope);
    assert.equal(withActivation.context.worldInfo?.binding.publicTitle, LIBRARY_TITLE);
    assert.equal(withActivation.context.worldInfo?.binding.revision, created.revision);
    assert.equal(withActivation.catalog.stableSources.length, 2, "one stable source per layer");
    const bookSource = withActivation.catalog.stableSources[0]!;
    const managedSource = withActivation.catalog.stableSources[1]!;
    assert.deepEqual(
      bookSource,
      bookOnly.catalog.stableSources[0],
      "layer 1: byte-identical with and without the activation, including its total order key",
    );
    assert.match(managedSource.sourceId, /^managed_world_info_[a-f0-9]{32}$/u);
    assert.equal(managedSource.revision, String(created.revision));
    assert.match(managedSource.provenance, /managed-world-info\/山谷镇志\/revision\/1\/canonical\//u);
    assert.match(
      managedSource.content,
      new RegExp(LIBRARY_CONSTANT_SUMMARY, "u"),
      "layer 2: the library item's constant entry is rendered into the stable prefix",
    );
    assert.match(bookSource.content, new RegExp(OWN_BOOK_CONSTANT, "u"), "layer 1: her constant entry is still there");

    const orderKeys = [...withActivation.catalog.stableSources, ...withActivation.catalog.volatileSources].map(
      (source) => source.totalOrderKey,
    );
    // One strictly increasing sequence across both layers and both halves. The library item's
    // keyword entry keeps its index within the item's own entry list, so a gap is expected where
    // that item's constant entry was skipped; what must hold is that no key repeats, that the
    // order never goes backwards, and that layer 1 keeps exactly the keys it had alone.
    assert.equal(new Set(orderKeys).size, orderKeys.length, "no two sources share a total order key");
    const ascendingKeys = orderKeys.map(Number).sort((left, right) => left - right);
    for (let index = 1; index < ascendingKeys.length; index += 1)
      assert.ok(
        ascendingKeys[index]! > ascendingKeys[index - 1]!,
        `total order keys strictly increase: ${ascendingKeys.join(",")}`,
      );
    assert.ok(
      Number(managedSource.totalOrderKey) > Number(bookSource.totalOrderKey),
      "layer 2 sits after layer 1's stable source",
    );
    const managedVolatile = withActivation.catalog.volatileSources.find((source) =>
      source.sourceId.startsWith(`${managedSource.sourceId}_entry_`),
    )!;
    assert.ok(
      Number(managedVolatile.totalOrderKey) > Number(managedSource.totalOrderKey),
      "layer 2's per-turn entry sits after its stable source",
    );
    const layerOneOrderKeys = (catalog: TavernAuthoredContextCatalog) =>
      [...catalog.stableSources, ...catalog.volatileSources]
        .filter((source) => source.sourceId.startsWith(OWN_BOOK_ID))
        .map((source) => source.totalOrderKey);
    assert.deepEqual(
      layerOneOrderKeys(withActivation.catalog),
      layerOneOrderKeys(bookOnly.catalog),
      "layer 1: her own keys are the ones she had with no activation at all",
    );

    // The per-turn half of both layers keeps working: the layers publish their keyword-gated
    // entries as candidates and the vendor's own selector binds the one the turn names.
    const { publishGameBuddyAuthoredStableCatalog } = await import("@cortexkit/pi-magic-context/tavern");
    const capability = publishGameBuddyAuthoredStableCatalog(scope, withActivation.catalog);
    try {
      const managedTurn = capability.materializeVolatileForTurn("turn_0001", "今天我们去矿洞看看。", "天气：晴天");
      assert.deepEqual(
        managedTurn.refs.map((ref) => ref.sourceId),
        [`${managedSource.sourceId}_entry_2`],
        "layer 2: its keyword-gated entry is selected for the turn that names 矿洞",
      );
      capability.clearVolatileForTurn("turn_0001");
      const ownTurn = capability.materializeVolatileForTurn("turn_0002", "外面正在下雨。", "天气：雨天");
      // The native-book branch numbers candidates within the book's keyword entries, while the
      // managed branch keeps each entry's index inside the item's own entry list - which is why
      // this one is `_entry_1` and the library item's keyword entry above is `_entry_2`.
      assert.deepEqual(
        ownTurn.refs.map((ref) => ref.sourceId),
        [`${OWN_BOOK_ID}_entry_1`],
        "layer 1: her own per-turn entry still selects on its own trigger",
      );
      capability.clearVolatileForTurn("turn_0002");
    } finally {
      await capability.clear();
    }

    // (c) Clear the activation.
    assert.equal(
      await repository.setActivation(identityKey(GAME_IDENTITY), null),
      undefined,
      "clearing returns no projection",
    );
    const afterClear = await gameCatalog(runtimeRoot, scope);
    assert.equal(afterClear.context.worldInfo, undefined, "layer 2: the activation is gone");
    assert.deepEqual(
      afterClear.catalog,
      bookOnly.catalog,
      "layer 2 is gone and layer 1 is untouched: clearing returns the exact catalog her book alone produced",
    );
  } finally {
    await removeRoot(root);
  }
});

test("one activation record reaches the Chat construction and the Game materializer as the same layer, byte for byte", async () => {
  const { root, runtimeRoot } = await fixtureRoot("two-readers");
  const repository = createWorldInfoManagementRepository(runtimeRoot);
  try {
    const created = await repository.create(LIBRARY_ITEM);
    assert.equal(
      identityKey(GAME_IDENTITY),
      identityKey(PRINCIPAL),
      "the Game identity and the Chat principal name one continuity key, so one record can serve both",
    );
    await repository.setActivation(identityKey(PRINCIPAL), {
      publicTitle: LIBRARY_TITLE,
      revision: created.revision,
    });

    const chat = await chatCatalog(runtimeRoot, { piSessionId: "pi_session_activation_two_readers_chat" });
    const game = await gameCatalog(runtimeRoot, gameScope("pi_session_activation_two_readers_game"));
    assert.equal(game.catalog.stableSources.length, 1, "premise: this Game root has no own book, so layer 2 is alone");
    assert.equal(
      chat.stableSources.length,
      1,
      "premise: this conversation carries no binding, so the activation is alone",
    );
    const chatManaged = chat.stableSources[0]!;
    const gameManaged = game.catalog.stableSources[0]!;
    assert.equal(chatManaged.sourceId, gameManaged.sourceId, "both readers name the same managed layer");
    assert.equal(chatManaged.revision, gameManaged.revision);
    assert.equal(chatManaged.canonicalHash, gameManaged.canonicalHash);
    assert.equal(chatManaged.provenance, gameManaged.provenance);
    assert.equal(chatManaged.content, gameManaged.content, "the same content, byte for byte");
    assert.match(
      chatManaged.content,
      new RegExp(LIBRARY_CONSTANT_SUMMARY, "u"),
      "the shared content is the activated revision's own rendering, not an empty agreement",
    );
    assert.match(
      chatManaged.content,
      new RegExp(`^## ${LIBRARY_TITLE}$`, "mu"),
      "the shared content names the activated item",
    );

    // One authority, not two look-alikes: repointing the single record moves both readers.
    const sibling = await repository.create(SIBLING_ITEM);
    await repository.setActivation(identityKey(PRINCIPAL), {
      publicTitle: SIBLING_TITLE,
      revision: sibling.revision,
    });
    const movedChat = await chatCatalog(runtimeRoot, {
      piSessionId: "pi_session_activation_two_readers_chat_moved",
      threadId: "thread_activation_moved",
      surfaceSessionId: "chat_session_activation_moved",
    });
    const movedGame = await gameCatalog(runtimeRoot, gameScope("pi_session_activation_two_readers_game_moved"));
    assert.equal(movedChat.stableSources[0]!.content, movedGame.catalog.stableSources[0]!.content);
    assert.match(movedChat.stableSources[0]!.content, new RegExp(SIBLING_CONSTANT_SUMMARY, "u"));
    assert.doesNotMatch(
      movedChat.stableSources[0]!.content,
      new RegExp(LIBRARY_CONSTANT_SUMMARY, "u"),
      "the superseded activation does not linger on either surface",
    );
  } finally {
    await removeRoot(root);
  }
});

test("a revision whose bytes no longer verify refuses the layer by name and leaves the Game her own book only", async () => {
  const { root, runtimeRoot } = await fixtureRoot("drift", { ownBook: true });
  const scope = gameScope("pi_session_activation_drift");
  const repository = createWorldInfoManagementRepository(runtimeRoot);
  try {
    const created = await repository.create(LIBRARY_ITEM);
    // A sibling that was never activated: nothing may be substituted with it either.
    await repository.create(SIBLING_ITEM);
    await repository.setActivation(identityKey(GAME_IDENTITY), {
      publicTitle: LIBRARY_TITLE,
      revision: created.revision,
    });
    const before = await gameCatalog(runtimeRoot, scope);
    assert.equal(before.catalog.stableSources.length, 2, "premise: the activation materializes before the drift");

    // Rewrite the pinned revision's bytes, leaving the envelope's recorded hash in place.
    // Two items live in this root, so the pinned one is found by the title the activation names.
    const revisionsDirectory = join(runtimeRoot, "world-info-management", "revisions");
    let revisionPath: string | undefined;
    for (const entry of await readdir(revisionsDirectory)) {
      const candidate = join(revisionsDirectory, entry, `${created.revision}.json`);
      const envelope = JSON.parse(await readFile(candidate, "utf8")) as { artifact?: { publicTitle?: string } };
      if (envelope.artifact?.publicTitle === LIBRARY_TITLE) revisionPath = candidate;
    }
    assert.notEqual(revisionPath, undefined, "premise: the pinned revision's file was found on disk");
    const tampered = JSON.parse(await readFile(revisionPath!, "utf8")) as { artifact: { summary: string } };
    tampered.artifact.summary = "档案被改写后的内容。";
    await writeFile(revisionPath!, JSON.stringify(tampered), "utf8");

    await assert.rejects(
      () => createManagedWorldInfoBindingResolver(repository).activated(identityKey(GAME_IDENTITY)),
      /continuity_world_info_activation_drift/u,
      "the authority names the refusal; it does not resolve another revision",
    );

    const { result: context, stderr } = await withCapturedStderr(() =>
      assembleGameRuntimeContext({ identity: GAME_IDENTITY, runtimeRoot }),
    );
    assert.equal(context.worldInfo, undefined, "layer 2: the drifted pin yields no managed layer");
    assert.equal(
      stderr.includes("continuity_world_info_activation_drift"),
      true,
      `the Game reader names the refusal: ${stderr.trim() || "<no stderr>"}`,
    );

    const catalog = buildGameSurfaceAuthoredCatalog(
      scope,
      context.worldBook,
      { char: null },
      context.scenario,
      context.worldInfo,
    );
    assert.deepEqual(
      catalog.stableSources.map((source) => source.sourceId),
      [OWN_BOOK_ID],
      "layer 1: her own book still materializes",
    );
    assert.match(catalog.stableSources[0]!.content, new RegExp(OWN_BOOK_CONSTANT, "u"));
    assert.deepEqual(
      catalog,
      buildGameSurfaceAuthoredCatalog(scope, context.worldBook, { char: null }),
      "nothing is substituted in layer 2's place: the catalog is exactly the one her book produces",
    );
    assert.doesNotMatch(
      JSON.stringify(catalog),
      new RegExp(LIBRARY_CONSTANT_SUMMARY, "u"),
      "the drifted item is not materialized",
    );
    assert.doesNotMatch(
      JSON.stringify(catalog),
      new RegExp(SIBLING_CONSTANT_SUMMARY, "u"),
      "the sibling library item is not materialized in its place",
    );

    // The other half of the same named refusal: the item leaves the library.
    const other = await fixtureRoot("drift-deleted");
    const otherRepository = createWorldInfoManagementRepository(other.runtimeRoot);
    try {
      const later = await otherRepository.create(LIBRARY_ITEM);
      await otherRepository.setActivation(identityKey(GAME_IDENTITY), {
        publicTitle: LIBRARY_TITLE,
        revision: later.revision,
      });
      await otherRepository.delete(LIBRARY_TITLE);
      await assert.rejects(
        () => createManagedWorldInfoBindingResolver(otherRepository).activated(identityKey(GAME_IDENTITY)),
        /continuity_world_info_activation_drift/u,
        "a pin the catalog no longer reaches refuses the same way",
      );
    } finally {
      await removeRoot(other.root);
    }
  } finally {
    await removeRoot(root);
  }
});

test("with nothing activated a conversation without a thread binding carries no managed layer, and a thread's own binding still wins over an activation", async () => {
  // (i) The unused case: nothing activated, and a conversation that carries no binding.
  const unusedRoot = await fixtureRoot("unused");
  try {
    const unused = await chatCatalog(unusedRoot.runtimeRoot, { piSessionId: "pi_session_activation_unused" });
    assert.deepEqual(unused.stableSources, [], "layer 2: no activation and no thread binding, so nothing managed");
    assert.deepEqual(unused.volatileSources, [], "layer 2: no per-turn candidates either");
  } finally {
    await removeRoot(unusedRoot.root);
  }

  // (ii) The override rule: a thread's own binding wins, and the activation stays the Game's.
  const overrideRoot = await fixtureRoot("override");
  const repository = createWorldInfoManagementRepository(overrideRoot.runtimeRoot);
  try {
    const activatedItem = await repository.create(LIBRARY_ITEM);
    const boundItem = await repository.create(SIBLING_ITEM);
    await repository.setActivation(identityKey(PRINCIPAL), {
      publicTitle: LIBRARY_TITLE,
      revision: activatedItem.revision,
    });
    const threadBinding = await createManagedWorldInfoBindingResolver(repository).bindExact(
      SIBLING_TITLE,
      boundItem.revision,
    );

    const overridden = await chatCatalog(overrideRoot.runtimeRoot, {
      piSessionId: "pi_session_activation_override",
      managedWorldInfoBinding: threadBinding,
    });
    assert.equal(overridden.stableSources.length, 1, "one managed layer, not two");
    const chatManaged = overridden.stableSources[0]!;
    assert.match(
      chatManaged.content,
      new RegExp(SIBLING_CONSTANT_SUMMARY, "u"),
      "layer 2 (thread binding): the conversation's own binding is materialized",
    );
    assert.doesNotMatch(
      chatManaged.content,
      new RegExp(LIBRARY_CONSTANT_SUMMARY, "u"),
      "layer 2 (override): the continuity activation does not join the thread's binding",
    );
    assert.match(
      chatManaged.content,
      new RegExp(`^## ${SIBLING_TITLE}$`, "mu"),
      "the thread's binding, not the activation, names the managed item",
    );

    const game = await gameCatalog(overrideRoot.runtimeRoot, gameScope("pi_session_activation_override_game"));
    assert.match(
      game.catalog.stableSources[0]!.content,
      new RegExp(LIBRARY_CONSTANT_SUMMARY, "u"),
      "layer 2 (activation): the same root still gives the Game the activated item, because a Game has no thread to override it",
    );
  } finally {
    await removeRoot(overrideRoot.root);
  }
});
