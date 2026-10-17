/**
 * Every Chat the player opens carries the card's life.
 *
 * The owner's complaint was felt as a symptom - "the card's life does not reach
 * her" - and this file pins it to the two seams that create a Chat. The FIRST
 * Chat of a continuity is created by the chat-selection saga through
 * `createManifestDerivedInitialChatExactContentPort`, which resolves the
 * companion's own durable artifacts for a request that names none. A LATER Chat
 * is created by the management surface's New Chat, which goes through
 * `TavernLibraryService.createNewChat` - and that path resolved only the opening,
 * so the reviewed card's scenario and its whole world book were on disk and never
 * bound to the thread the mount path materializes from.
 *
 * The proof is the assembled prompt material, not the code: each Chat is
 * constructed exactly as the mount path constructs it
 * (`prepareExactChatRuntimeConstruction`) and its DESIRED catalog is read back
 * through the same `materializeDesiredStableContextForPiSession` handoff Magic
 * Context publishes - a fresh thread's own book is reached through the desired
 * channel, because in the mounted channel an unapplied binding resolves to the
 * applied (undefined) one, which is the mount service's job (see
 * `continuity-semantic-chat-runtime-construction.internal.ts`). The Tier-1 half of
 * the same prompt is `buildChatCompanionSystemPrompt`, which is where the card's
 * persona and its dialogue examples live.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  type ChatRuntimeBindingExecution,
  withConsumedChatRuntimeBinding,
} from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { createTestChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.test-support.js";
import { prepareExactChatRuntimeConstruction } from "../continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { buildChatCompanionSystemPrompt, identityProfileMetadata } from "../identity-profile.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { createManifestDerivedInitialChatExactContentPort } from "./initial-chat-exact-content-port.js";
import { createTavernLibraryService } from "./library-service.js";
import {
  createNewCompanionService,
  provisionDirectNewCompanion,
  provisionNewCompanion,
} from "./new-companion-service.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import { type CharacterCandidate, validateTavernArtifact } from "./types.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/**
 * A reviewed card, in the shape the ST-card import produces: a persona, one
 * dialogue example, a scenario, a first greeting, and a world book with one
 * always-on entry and one keyword-gated one. The strings are sentinels so a quoted
 * read-back names exactly which content class arrived.
 */
const CARD = Object.freeze({
  name: "琥珀",
  personaCore: "SENTINEL-PERSONA: 琥珀 keeps the 削木四叶草发卡 in, even on the wettest mornings.",
  example: Object.freeze({
    user: "SENTINEL-EXAMPLE-USER: Morning, partner. The parsnips are up.",
    companion: "SENTINEL-EXAMPLE-COMPANION: *She props the hoe against the fence.* All fifteen. Look.",
  }),
  scenario: "SENTINEL-SCENARIO: you two left the city together and took over the overgrown valley farm.",
  greeting: "SENTINEL-GREETING: *The screen door creaks open.* Morning! Listen - a woodpecker, east of the treeline.",
  constantEntry: "SENTINEL-CONSTANT: {{char}} keeps the ledger; {{user}} takes the heavy work.",
  gatedEntry: "SENTINEL-GATED: on rainy valley days nobody hauls water - {{char}} brews the tea instead.",
});

const REVIEWED_FIELDS = ["name", "persona_core", "example_1", "scenario", "first_greeting"] as const;

const FIRST = Object.freeze({
  chatThreadId: `chat-${"1".repeat(16)}`,
  chatSurfaceSessionId: `surface-${"1".repeat(16)}`,
});
const SECOND = Object.freeze({
  chatThreadId: `chat-${"2".repeat(16)}`,
  chatSurfaceSessionId: `surface-${"2".repeat(16)}`,
});

function hash64(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reviewedCard(): CharacterCandidate {
  const field = (name: string, text: string) =>
    Object.freeze({ field: name, text, eligibility: "profile_eligible_after_explicit_review" as const });
  return Object.freeze({
    schemaVersion: 1 as const,
    revision: 1,
    candidateId: "st-card-binding",
    sourceFormat: "st-v2" as const,
    sourceVersion: "st-v2",
    sourceHash: hash64("chat-companion-binding-card"),
    name: CARD.name,
    reviewState: "pending" as const,
    fields: Object.freeze([
      field("name", CARD.name),
      field("persona_core", CARD.personaCore),
      field("example_1", JSON.stringify(CARD.example)),
      field("scenario", CARD.scenario),
      field("first_greeting", CARD.greeting),
    ]),
    worldBookCandidates: Object.freeze([
      Object.freeze({
        entryId: "wb-covenant",
        title: "The farm covenant",
        content: CARD.constantEntry,
        scope: "setting" as const,
        provenance: "reviewed-import" as const,
        tokenBudget: "small" as const,
        constant: true,
      }),
      Object.freeze({
        entryId: "wb-rain",
        title: "Rain arrangements",
        content: CARD.gatedEntry,
        scope: "setting" as const,
        provenance: "reviewed-import" as const,
        tokenBudget: "small" as const,
      }),
    ]),
  });
}

/**
 * A fresh runtime root whose companion was provisioned from the reviewed card
 * through the product's own import path - the shape that leaves a profile, a
 * `worldbook.json`, a scenario, a greeting record and the library companion record
 * on disk.
 */
async function cardProvision() {
  const root = await canonicalTestRoot("chat-companion-binding-");
  const bootstrap = createChatThreadStore(root, "provision");
  try {
    const candidate = reviewedCard();
    const review = createNewCompanionService({
      async create() {
        throw new Error("review_does_not_create");
      },
    }).review(candidate, { reviewedFields: [...REVIEWED_FIELDS], approvedAtMs: 10 });
    const provision = await provisionNewCompanion(root, "player", candidate, review, bootstrap);
    return Object.freeze({ root, provision });
  } finally {
    bootstrap.close?.();
  }
}

/** The product's two Chat-creation seams over one provisioned root. */
async function twoChats() {
  const { root, provision } = await cardProvision();
  const identity = provision.identity;
  const tavernPaths = resolveTavernPaths(resolveRuntimePaths(identity, root), identity);
  const artifacts = new TavernArtifactStore(root);
  const threads = createChatThreadStore(root, identityKey(identity));
  const manifest = Object.freeze({
    schemaVersion: 2 as const,
    topology: "independent_chat_and_game_surfaces" as const,
    runtimeRoot: root,
    principal: Object.freeze({
      continuityId: identity.continuityId!,
      companionId: identity.companionId,
      playerId: identity.playerId,
    }),
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
  });
  const library = createTavernLibraryService(tavernPaths, artifacts, threads, {
    async readExact() {
      return identityProfileMetadata(provision.profile);
    },
  });
  return Object.freeze({ root, provision, tavernPaths, artifacts, threads, manifest, library });
}

function permitFor(
  execution: ChatRuntimeBindingExecution,
  chat: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>,
): ProductionChatRuntimePermit {
  return Object.freeze({
    principal: execution.principal,
    operationId: "operation_01",
    requestId: "request_01",
    chatThreadId: chat.chatThreadId,
    chatSurfaceSessionId: chat.chatSurfaceSessionId,
    runtimeBindingDigest: execution.bindingFacts.runtimeBindingDigest,
    owner: execution.bindingFacts.owner,
    deadlineAtMs: Date.now() + 30_000,
    expected: Object.freeze({ partitionRevision: 1, fenceEpoch: 1, selectionRevision: 1 }),
    payloadDigest: "b".repeat(64),
    fenceToken: "fence_01",
    prepared: Object.freeze({ partitionRevision: 2, fenceEpoch: 2, selectionRevision: 1 }),
  });
}

type PreparedChat = Readonly<{
  prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>>;
  binding: Awaited<ReturnType<typeof createTestChatRuntimeBinding>>;
}>;

/**
 * Constructs one Chat exactly as the mount path does, over the real root.
 *
 * Each Chat takes its own binding execution: the binding hands out one
 * close-drained materialization lease per consumption, so one consumption can only
 * ever materialize the one Chat its permit names.
 */
async function constructChat(
  fixture: Awaited<ReturnType<typeof twoChats>>,
  chat: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>,
): Promise<PreparedChat> {
  const binding = createTestChatRuntimeBinding({
    manifest: fixture.manifest,
    ownerProof: Object.freeze({ processId: 42, creationTime100ns: "123456" }),
  });
  try {
    const prepared = await binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permitFor(execution, chat)),
      ),
    );
    return Object.freeze({ prepared, binding });
  } catch (error) {
    await binding.close();
    throw error;
  }
}

async function release(
  input: Readonly<{
    first?: PreparedChat;
    second?: PreparedChat;
    content?: ReturnType<typeof createManifestDerivedInitialChatExactContentPort>;
    threads?: ReturnType<typeof createChatThreadStore>;
    root: string;
  }>,
): Promise<void> {
  input.first?.prepared.closeChatThreadStore();
  input.second?.prepared.closeChatThreadStore();
  await input.first?.binding.close();
  await input.second?.binding.close();
  input.content?.close();
  input.threads?.close?.();
  await rm(input.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("a Chat created through the product's New Chat carries the card's scenario and its world book", async () => {
  const fixture = await twoChats();
  const content = createManifestDerivedInitialChatExactContentPort(fixture.manifest);
  let firstChat: PreparedChat | undefined;
  let secondChat: PreparedChat | undefined;
  try {
    // The FIRST Chat, exactly as the saga creates it: the request names the four-way
    // identity binding and nothing else.
    await content.port.createExplicit({
      ...FIRST,
      companionId: fixture.provision.identity.companionId,
      continuityId: fixture.provision.identity.continuityId!,
    });
    // The SECOND Chat, exactly as the browser's New Chat reaches it: no ids at all.
    const created = await fixture.library.createNewChat({ ...SECOND });
    assert.equal(created.messages[0]?.text, CARD.greeting, "the opening is still the card's own greeting");

    firstChat = await constructChat(fixture, FIRST);
    secondChat = await constructChat(fixture, SECOND);
    const firstCatalog = await firstChat.prepared.materializeDesiredStableContextForPiSession("pi_first");
    const secondCatalog = await secondChat.prepared.materializeDesiredStableContextForPiSession("pi_second");
    const kinds = (catalog: typeof secondCatalog) => catalog.stableSources.map((source) => source.kind);

    // (1) The card's world book and (2) its scenario, quoted from the catalog the
    // turn's prompt is assembled from.
    assert.deepEqual(
      kinds(secondCatalog),
      ["scenario", "lorebook_constant"],
      `new Chat stable sources: new=${JSON.stringify(kinds(secondCatalog))} first=${JSON.stringify(kinds(firstCatalog))}`,
    );
    const secondStable = secondCatalog.stableSources.map((source) => source.content).join("\n");
    assert.equal(secondStable.includes(CARD.scenario), true, "the card's scenario reaches the new Chat");
    assert.equal(
      secondStable.includes("琥珀 keeps the ledger"),
      true,
      "the card's always-on world book entry reaches the new Chat, macros rendered",
    );
    const secondThread = await fixture.threads.resumeThread(SECOND.chatThreadId, SECOND.chatSurfaceSessionId);
    assert.equal(
      secondThread.thread.stableArtifactBindings?.some((item) => item.kind === "scenario"),
      true,
      "the new Chat's durable thread must bind the companion's own scenario, not only its opening",
    );
    assert.equal(
      secondThread.thread.companionWorldBookBinding !== undefined,
      true,
      "the new Chat's durable thread must bind the companion's own world book",
    );
    assert.equal(secondStable.includes("{{"), false, "no raw macro may be published as authored context");
    const secondVolatile = secondCatalog.volatileSources.map((source) => source.content).join("\n");
    assert.equal(
      secondVolatile.includes("brews the tea instead"),
      true,
      "the rest of the card's book reaches the new Chat as per-turn candidates",
    );

    // (3) The card's persona and (4) its dialogue examples, quoted from the Tier-1
    // half of the same prompt.
    const prompt = buildChatCompanionSystemPrompt(fixture.provision.profile, "zh-CN");
    assert.equal(prompt.includes(CARD.personaCore), true, "the card's persona reaches the prompt");
    assert.equal(prompt.includes(CARD.example.companion), true, "the card's dialogue examples reach the prompt");

    // The FIRST Chat reads the same four classes: a Chat opened by the saga is not
    // allowed to be the poorer one.
    assert.deepEqual(
      kinds(firstCatalog),
      ["scenario", "lorebook_constant"],
      "the first Chat's catalog must carry the card's scenario and its world book too",
    );
    const firstStable = firstCatalog.stableSources.map((source) => source.content).join("\n");
    assert.equal(firstStable.includes(CARD.scenario), true, "the card's scenario reaches the first Chat");
    assert.equal(firstStable.includes("琥珀 keeps the ledger"), true, "the card's book reaches the first Chat");
  } finally {
    await release({
      ...(firstChat === undefined ? {} : { first: firstChat }),
      ...(secondChat === undefined ? {} : { second: secondChat }),
      content,
      threads: fixture.threads,
      root: fixture.root,
    });
  }
});

test("New Chat keeps an explicitly named selection instead of defaulting to the companion's own artifacts", async () => {
  const { root, provision } = await cardProvision();
  const identity = provision.identity;
  const tavernPaths = resolveTavernPaths(resolveRuntimePaths(identity, root), identity);
  const artifacts = new TavernArtifactStore(root);
  const threads = createChatThreadStore(root, identityKey(identity));
  try {
    const library = createTavernLibraryService(tavernPaths, artifacts, threads, {
      async readExact() {
        return identityProfileMetadata(provision.profile);
      },
    });
    const chosenScenarioId = "player-chosen-scenario";
    await artifacts.write(
      tavernRevisionPath(join(tavernPaths.companionRoot, "scenarios", chosenScenarioId), 1),
      {
        schemaVersion: 1,
        revision: 1,
        scenarioId: chosenScenarioId,
        name: "Chosen",
        description: "SENTINEL-CHOSEN-SCENARIO",
        text: "SENTINEL-CHOSEN-SCENARIO",
        provenance: "authored",
        owner: "chat_override",
      },
      validateTavernArtifact,
    );
    const created = await library.createNewChat({
      ...SECOND,
      scenarioId: chosenScenarioId,
      opening: { kind: "blank" },
    });
    assert.deepEqual(
      (created.thread.stableArtifactBindings ?? []).map((item) => item.sourceId),
      [chosenScenarioId],
      "a caller that names its own scenario keeps it; the companion's own is neither added nor substituted",
    );
    assert.equal(
      created.thread.companionWorldBookBinding !== undefined,
      true,
      "the companion's own world book is still the default for a Chat that names none",
    );
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a companion without a card binds nothing rather than inventing content", async () => {
  const root = await canonicalTestRoot("chat-companion-binding-direct-");
  const direct = await provisionDirectNewCompanion(root, "player", "Direct Buddy");
  const tavernPaths = resolveTavernPaths(resolveRuntimePaths(direct.identity, root), direct.identity);
  const artifacts = new TavernArtifactStore(root);
  const threads = createChatThreadStore(root, identityKey(direct.identity));
  try {
    const library = createTavernLibraryService(tavernPaths, artifacts, threads, {
      async readExact() {
        return identityProfileMetadata(direct.profile);
      },
    });
    const created = await library.createNewChat({ ...FIRST, opening: { kind: "blank" } });
    assert.deepEqual(
      created.thread.stableArtifactBindings ?? [],
      [],
      "no scenario is invented for a companion that has no card",
    );
    assert.equal(
      created.thread.companionWorldBookBinding,
      undefined,
      "no world book is invented for a companion with no card",
    );
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a corrupt companion-owned scenario fails the new Chat closed instead of silently opening without it", async () => {
  const { root, provision } = await cardProvision();
  const identity = provision.identity;
  const tavernPaths = resolveTavernPaths(resolveRuntimePaths(identity, root), identity);
  const artifacts = new TavernArtifactStore(root);
  const threads = createChatThreadStore(root, identityKey(identity));
  try {
    // The companion's own scenario id is derived from the companion root, exactly
    // as `scenario-management.ts` derives it when it writes the artifact.
    const digest = createHash("sha256").update(join(tavernPaths.companionRoot), "utf8").digest("hex").slice(0, 32);
    await writeFile(
      join(tavernPaths.companionRoot, "scenarios", `player-scenario-${digest}`, "revisions", "2.json"),
      "{ corrupt",
      "utf8",
    );
    const library = createTavernLibraryService(tavernPaths, artifacts, threads, {
      async readExact() {
        return identityProfileMetadata(provision.profile);
      },
    });
    await assert.rejects(
      library.createNewChat({ ...SECOND }),
      /invalid_tavern_selection/,
      "an unreadable companion-owned scenario must be reported, never silently dropped",
    );
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
