import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { DEFAULT_IDENTITY_PROFILE, identityProfileHash, identityProfileMetadata } from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { pngCardFile } from "../test-support/png-card.test-support.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { companionAvatarPath } from "./companion-avatar/index.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { createTavernLibraryService } from "./library-service.js";
import { createScenarioManagementService } from "./scenario-management/scenario-management.js";
import { resolveTavernPaths } from "./tavern-paths.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  createNewCompanionService,
  provisionDirectNewCompanion,
  provisionNewCompanion,
} from "./new-companion-service.js";

const hash = "a".repeat(64);

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function cleanupTestRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await assert.rejects(access(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

const candidate = {
  schemaVersion: 1 as const,
  revision: 1,
  candidateId: "candidate",
  sourceFormat: "st-v3" as const,
  sourceVersion: "st-v3",
  sourceHash: hash,
  name: "Candidate",
  reviewState: "reviewed" as const,
  fields: [
    { field: "persona_core", text: "calm", eligibility: "profile_eligible_after_explicit_review" as const },
    // The card's name is reviewable too: approving it names the companion, and
    // declining it keeps the default. An imported companion must be able to be
    // called what the player imported.
    { field: "name", text: "Candidate", eligibility: "profile_eligible_after_explicit_review" as const },
    { field: "creators_notes", text: "notes", eligibility: "candidate_only" as const },
  ],
};
test("New Companion requires explicit eligible-field review and creates only supplied new metadata", async () => {
  const writes: unknown[] = [];
  const service = createNewCompanionService({
    async create(input) {
      writes.push(input);
      return { schemaVersion: 1 as const, revision: 1, ...input };
    },
  });
  const review = service.review(candidate, { reviewedFields: ["persona_core"], approvedAtMs: 1 });
  const created = await service.create(review, candidate, {
    companionId: "new-companion",
    continuityId: "new-continuity",
    name: "New Buddy",
    profileId: "profile",
    profileRevision: 1,
    profileHash: hash,
  });
  assert.equal(created.companionId, "new-companion");
  assert.equal(writes.length, 1);
  assert.throws(
    () => service.review(candidate, { reviewedFields: ["creators_notes"], approvedAtMs: 1 }),
    /invalid_new_companion_review/,
  );
  await assert.rejects(
    service.create({ ...review, sourceHash: "b".repeat(64) }, candidate, {
      companionId: "new-companion",
      continuityId: "new-continuity",
      name: "New Buddy",
      profileId: "profile",
      profileRevision: 1,
      profileHash: hash,
    }),
    /review_required/,
  );
});

test("direct New Companion provisions a fresh opaque identity, continuity, and Host-owned profile without a candidate", async () => {
  const root = await canonicalTestRoot("tavern-direct-new-companion-");
  try {
    const created = await provisionDirectNewCompanion(root, "player", "Direct Buddy");
    assert.match(created.identity.companionId, /^companion-/);
    assert.match(created.identity.continuityId!, /^continuity-/);
    assert.equal(created.profile.identity.name, "Direct Buddy");
    const runtimeRoot = join(root, "contexts", identityKey(created.identity));
    assert.match(await readFile(join(runtimeRoot, "identity-profile.json"), "utf8"), /Direct Buddy/);
    assert.match(
      await readFile(join(runtimeRoot, "identity-profile-binding.json"), "utf8"),
      new RegExp(identityKey(created.identity)),
    );
    await assert.rejects(provisionDirectNewCompanion(root, "player", "\u0000"), /invalid_new_companion_name/);
  } finally {
    await cleanupTestRoot(root);
  }
});

test("New Companion fails closed when runtime namespace is replaced by a symlink", async (t) => {
  const root = await canonicalTestRoot("tavern-new-companion-boundary-");
  const outside = await canonicalTestRoot("tavern-new-companion-outside-");
  const contextsPath = join(root, "contexts");
  const outsideSentinel = join(outside, "sentinel.txt");
  try {
    await writeFile(outsideSentinel, "outside-sentinel", "utf8");
    try {
      await symlink(outside, contextsPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(provisionDirectNewCompanion(root, "player", "Blocked Buddy"), /unsafe_path_boundary/);
    assert.equal(await readFile(outsideSentinel, "utf8"), "outside-sentinel");
    await assert.rejects(lstat(join(outside, "identity-profile.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("New Companion renders macros inside reviewed examples and writes them into the profile (AIRP fork S2)", async () => {
  const root = await canonicalTestRoot("tavern-new-companion-examples-");
  const examplesCandidate = {
    ...candidate,
    fields: [
      {
        field: "persona_core",
        text: "{{char}} likes amethyst.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "example_1",
        text: JSON.stringify({ user: "Want to play?", companion: "<BOT> is always up for it." }),
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "example_2",
        text: JSON.stringify({ user: "{{user}} tired?", companion: "A little, but stay with me." }),
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
    ],
  };
  try {
    const review = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    }).review(examplesCandidate, {
      reviewedFields: ["persona_core", "example_1", "example_2"],
      approvedAtMs: 10,
    });
    const threadStore = createChatThreadStore(root, "d".repeat(64));
    try {
      // The run's own language decides `{{user}}` (the real mount passes what
      // `resolveCompanionLocale` reads); an English run says `you`.
      const created = await provisionNewCompanion(
        root,
        "player",
        examplesCandidate,
        review,
        threadStore,
        undefined,
        "en-US",
      );
      // Examples survive review, are macro-rendered ({{char}}→name, {{user}}→the
      // run's word for the player) and land in the IdentityProfile so
      // renderIdentityProfile can teach from them.
      assert.deepEqual(created.profile.examples, [
        { user: "Want to play?", companion: "GameBuddy Companion is always up for it." },
        { user: "you tired?", companion: "A little, but stay with me." },
      ]);
      assert.equal(identityProfileHash(created.profile), identityProfileHash(created.profile));
    } finally {
      threadStore.close?.();
    }
  } finally {
    await cleanupTestRoot(root);
  }
});

test("New Companion maps the reviewed persona and renders card macros deterministically", async () => {
  const root = await canonicalTestRoot("tavern-new-companion-persona-");
  const personaCandidate = {
    ...candidate,
    fields: [
      {
        field: "persona_core",
        text: "{{char}} is calm when {{user}} needs help.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "persona_interaction_style",
        text: "Listen to <USER> before answering.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "persona_expression_style",
        text: "<BOT> speaks clearly to {{USER}}.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
    ],
  };
  try {
    const review = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    }).review(personaCandidate, {
      reviewedFields: ["persona_core", "persona_interaction_style", "persona_expression_style"],
      approvedAtMs: 9,
    });
    // `provisionNewCompanion` writes through the store it is handed and does not
    // own it, so the test closes it before the root is removed.
    const threadStore = createChatThreadStore(root, "b".repeat(64));
    try {
      const created = await provisionNewCompanion(
        root,
        "player",
        personaCandidate,
        review,
        threadStore,
        undefined,
        "en-US",
      );
      assert.deepEqual(created.profile.persona, {
        core: "GameBuddy Companion is calm when you needs help.",
        interactionStyle: "Listen to you before answering.",
        expressionStyle: "GameBuddy Companion speaks clearly to you.",
      });
      assert.equal(
        identityProfileHash(created.profile),
        identityProfileHash({ ...created.profile, persona: { ...created.profile.persona! } }),
      );
    } finally {
      threadStore.close?.();
    }
  } finally {
    await cleanupTestRoot(root);
  }
});

test("New Companion provisions a fresh opaque identity and Host-owned profile binding", async () => {
  const root = await canonicalTestRoot("tavern-new-companion-");
  try {
    const pending = { ...candidate, reviewState: "pending" as const };
    const review = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    }).review(pending, { reviewedFields: ["persona_core"], approvedAtMs: 9 });
    const threadStore = createChatThreadStore(root, "b".repeat(64));
    try {
      const created = await provisionNewCompanion(root, "player", pending, review, threadStore);
      assert.notEqual(created.identity.companionId, "companion");
      assert.notEqual(created.identity.continuityId, "continuity");
      assert.equal(created.profile.persona?.core, "calm");
      const runtimeRoot = join(root, "contexts", identityKey(created.identity));
      assert.match(
        await readFile(join(runtimeRoot, "identity-profile.json"), "utf8"),
        new RegExp(created.profile.profileId),
      );
      assert.match(
        await readFile(join(runtimeRoot, "identity-profile-binding.json"), "utf8"),
        new RegExp(identityKey(created.identity)),
      );
    } finally {
      threadStore.close?.();
    }
  } finally {
    await cleanupTestRoot(root);
  }
});

test("New Companion provisions reviewed scenario and first greeting for library new chat", async () => {
  const root = await canonicalTestRoot("tavern-new-companion-narrative-");
  let threadStore: ReturnType<typeof createChatThreadStore> | undefined;
  const narrativeCandidate = {
    ...candidate,
    fields: [
      {
        field: "persona_core",
        text: "Warm and brave companion.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "scenario",
        text: "You meet at the mountain overlook at dawn.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "first_greeting",
        text: "The wind is cold, but the sunrise is magnificent.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
    ],
  };
  try {
    const service = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    });
    const review = service.review(narrativeCandidate, {
      reviewedFields: ["persona_core", "scenario", "first_greeting"],
      approvedAtMs: 100,
    });
    threadStore = createChatThreadStore(root, "c".repeat(64));
    const created = await provisionNewCompanion(root, "player", narrativeCandidate, review, threadStore);

    const runtimePaths = resolveRuntimePaths(created.identity, root);
    const tavernPaths = resolveTavernPaths(runtimePaths, created.identity);
    const store = new TavernArtifactStore(root);
    const scenarioService = createScenarioManagementService(store, tavernPaths.companionRoot);
    const greetingService = createGreetingManagementService(store, tavernPaths.companionRoot);

    const persistedScenario = await scenarioService.read();
    assert.ok(persistedScenario !== null);
    assert.equal(persistedScenario.name, "Default Scenario");
    assert.equal(persistedScenario.description, "You meet at the mountain overlook at dawn.");

    const persistedGreeting = await greetingService.read();
    assert.ok(persistedGreeting !== null);
    assert.equal(persistedGreeting.label, "Initial Greeting");
    assert.equal(persistedGreeting.variants.length, 1);
    assert.equal(persistedGreeting.variants[0]?.text, "The wind is cold, but the sunrise is magnificent.");

    const library = createTavernLibraryService(tavernPaths, store, threadStore, {
      async readExact() {
        return identityProfileMetadata(created.profile);
      },
    });

    const digest = createHash("sha256").update(resolve(tavernPaths.companionRoot), "utf8").digest("hex").slice(0, 32);
    const scenarioId = `player-scenario-${digest}`;
    const greetingSetId = `greeting-set-${digest}`;

    const newChat = await library.createNewChat({
      chatThreadId: "thread-narrative-01",
      chatSurfaceSessionId: "surface-01",
      scenarioId,
      opening: {
        kind: "greeting",
        greetingSetId,
        variantId: "greeting-1",
        messageId: "msg-01",
      },
    });

    assert.equal(newChat.messages.length, 1);
    assert.equal(newChat.messages[0]?.text, "The wind is cold, but the sunrise is magnificent.");
    assert.equal(newChat.messages[0]?.kind, "opening");
    assert.equal(newChat.messages[0]?.greetingSource?.greetingSetId, greetingSetId);

    const scenarioBinding = newChat.thread.stableArtifactBindings?.find((b) => b.kind === "scenario");
    assert.ok(scenarioBinding !== undefined);
    assert.equal(scenarioBinding.sourceId, scenarioId);
    assert.equal(scenarioBinding.revision, 1);
    assert.match(scenarioBinding.canonicalHash, /^[a-f0-9]{64}$/);
  } finally {
    // The test owns this store and the library service reads through it, so it
    // is released here; an unclosed store keeps the root locked on Windows.
    threadStore?.close?.();
    await cleanupTestRoot(root);
  }
});
test("reviewed card world book lands as the bound worldbook.json and threads carry its metadata binding (S3)", async () => {
  const root = await canonicalTestRoot("tavern-new-companion-worldbook-");
  const candidates = {
    ...candidate,
    worldBookCandidates: [
      {
        entryId: "kohaku-entry-10",
        title: "开拓同盟与农场誓约",
        content: "琥珀与玩家是共同开拓农场的青梅竹马合伙人。",
        scope: "setting" as const,
        provenance: "reviewed-import" as const,
        tokenBudget: "small" as const,
        constant: true,
      },
      {
        entryId: "kohaku-entry-1",
        title: "雨天安排",
        content: "雨天喜欢在门廊煮热茶看雨。",
        scope: "setting" as const,
        provenance: "reviewed-import" as const,
        tokenBudget: "small" as const,
        keys: ["下雨", "雨天"],
      },
    ],
  };
  try {
    const review = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    }).review(candidates, {
      reviewedFields: ["persona_core"],
      approvedAtMs: 10,
    });
    const threadStore = createChatThreadStore(root, "e".repeat(64));
    try {
      const created = await provisionNewCompanion(root, "player", candidates, review, threadStore);
      const runtimeRoot = join(root, "contexts", identityKey(created.identity));
      const worldbook = JSON.parse(await readFile(join(runtimeRoot, "worldbook.json"), "utf8"));
      assert.equal(worldbook.worldBookId, `gamebuddy-worldbook-${created.identity.companionId}`);
      assert.equal(worldbook.revision, 1);
      assert.equal(worldbook.entries.length, 2);
      assert.equal(worldbook.entries[0].constant, true);
      assert.equal(worldbook.entries[1].constant, undefined);
      // A keyword-gated entry's trigger words are the card's own and must reach
      // the persisted worldbook: the volatile selector matches them against what
      // the player said, so dropping them makes the entry unreachable.
      assert.deepEqual(worldbook.entries[1].keys, ["下雨", "雨天"]);
      // The binding a chat creator will mount (createNewChat already carries
      // TavernStableWorldBookBinding) is exactly the on-disk revision metadata.
      assert.match(worldbook.canonicalHash, /^[a-f0-9]{64}$/);
    } finally {
      threadStore.close?.();
    }
  } finally {
    await cleanupTestRoot(root);
  }
});
test("an approved card name names the companion; an unapproved one leaves the default", async () => {
  const root = await canonicalTestRoot("tavern-reviewed-name-");
  const namedCandidate = {
    ...candidate,
    name: "Imported Rae",
    fields: [
      {
        field: "name",
        text: "Imported Rae",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "persona_core",
        text: "Quiet, attentive.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
    ],
  };
  try {
    const service = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    });
    const threadStore = createChatThreadStore(root, "e".repeat(64));
    try {
      // Approved name: the companion carries the card's own name.
      const approved = await provisionNewCompanion(
        root,
        "player",
        namedCandidate,
        service.review(namedCandidate, { reviewedFields: ["name", "persona_core"], approvedAtMs: 11 }),
        threadStore,
      );
      assert.equal(approved.profile.identity.name, "Imported Rae");
      assert.equal(approved.companion.name, "Imported Rae");
      // Unapproved name: fail closed to the default rather than adopting it
      // silently. The card name never applies without an explicit review.
      const declined = await provisionNewCompanion(
        root,
        "player",
        namedCandidate,
        service.review(namedCandidate, { reviewedFields: ["persona_core"], approvedAtMs: 12 }),
        threadStore,
      );
      assert.equal(declined.profile.identity.name, DEFAULT_IDENTITY_PROFILE.identity.name);
      assert.notEqual(declined.companion.name, "Imported Rae");
    } finally {
      threadStore.close?.();
    }
  } finally {
    await cleanupTestRoot(root);
  }
});
async function readGreetingVariants(
  root: string,
  provision: Awaited<ReturnType<typeof provisionNewCompanion>>,
): Promise<readonly { label: string | null; text: string }[]> {
  const runtimePaths = resolveRuntimePaths(provision.identity, root);
  const tavernPaths = resolveTavernPaths(runtimePaths, provision.identity);
  const greeting = await createGreetingManagementService(
    new TavernArtifactStore(root),
    tavernPaths.companionRoot,
  ).read();
  return greeting?.variants.map((variant) => ({ label: variant.label ?? null, text: variant.text })) ?? [];
}

test("reviewed alternate openings land as labelled variants beside the default opening", async () => {
  const root = await canonicalTestRoot("tavern-new-companion-alternate-openings-");
  let threadStore: ReturnType<typeof createChatThreadStore> | undefined;
  const openingsCandidate = {
    ...candidate,
    fields: [
      {
        field: "first_greeting",
        text: "Default opening.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "alternate_greeting_1",
        text: "First alternate.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "alternate_greeting_2",
        text: "Second alternate.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
    ],
  };
  try {
    const review = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    }).review(openingsCandidate, {
      reviewedFields: ["first_greeting", "alternate_greeting_1", "alternate_greeting_2"],
      approvedAtMs: 21,
    });
    threadStore = createChatThreadStore(root, "a".repeat(64));
    const created = await provisionNewCompanion(root, "player", openingsCandidate, review, threadStore);
    // The default opening keeps its identity; each alternate becomes one labelled
    // variant. The card's own 1-based order is the stable, honest label.
    assert.deepEqual(await readGreetingVariants(root, created), [
      { label: "Default", text: "Default opening." },
      { label: "Alternate 1", text: "First alternate." },
      { label: "Alternate 2", text: "Second alternate." },
    ]);
    // Fails if alternates are dropped, merged into the default, or mislabelled.
  } finally {
    threadStore?.close?.();
    await cleanupTestRoot(root);
  }
});

test("a reviewed default opening with no alternates produces exactly today's greeting record", async () => {
  const root = await canonicalTestRoot("tavern-new-companion-no-alternates-");
  let threadStore: ReturnType<typeof createChatThreadStore> | undefined;
  const singleOpeningCandidate = {
    ...candidate,
    fields: [
      {
        field: "first_greeting",
        text: "Solo opening.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
    ],
  };
  try {
    const review = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    }).review(singleOpeningCandidate, { reviewedFields: ["first_greeting"], approvedAtMs: 22 });
    threadStore = createChatThreadStore(root, "b".repeat(64));
    const created = await provisionNewCompanion(root, "player", singleOpeningCandidate, review, threadStore);
    assert.deepEqual(await readGreetingVariants(root, created), [{ label: "Default", text: "Solo opening." }]);
    // Fails if decoding alternate openings changes the record for a card without them.
  } finally {
    threadStore?.close?.();
    await cleanupTestRoot(root);
  }
});

test("provisioning the same reviewed card twice does not multiply greeting variants", async () => {
  const root = await canonicalTestRoot("tavern-new-companion-idempotent-openings-");
  let threadStore: ReturnType<typeof createChatThreadStore> | undefined;
  const openingsCandidate = {
    ...candidate,
    fields: [
      {
        field: "first_greeting",
        text: "Default opening.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "alternate_greeting_1",
        text: "First alternate.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
      {
        field: "alternate_greeting_2",
        text: "Second alternate.",
        eligibility: "profile_eligible_after_explicit_review" as const,
      },
    ],
  };
  try {
    const review = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    }).review(openingsCandidate, {
      reviewedFields: ["first_greeting", "alternate_greeting_1", "alternate_greeting_2"],
      approvedAtMs: 23,
    });
    threadStore = createChatThreadStore(root, "c".repeat(64));
    const first = await readGreetingVariants(
      root,
      await provisionNewCompanion(root, "player", openingsCandidate, review, threadStore),
    );
    const second = await readGreetingVariants(
      root,
      await provisionNewCompanion(root, "player", openingsCandidate, review, threadStore),
    );
    assert.equal(first.length, 3);
    assert.deepEqual(second, first);
    // Fails if a second import appends to the same variant list instead of rebuilding it.
  } finally {
    threadStore?.close?.();
    await cleanupTestRoot(root);
  }
});

/**
 * The reviewed card's picture is part of what the import keeps.
 *
 * A PNG card's image and the `tEXt` chunk that carries its card are one object,
 * so "the avatar" is not a second artifact to be modelled: it is the file the
 * player picked, written to the one path the runtime avatar face reads it from.
 * A card that carried no picture provisions a companion with none - absence is
 * an ordinary state, never a zero-byte file that would read as a broken image.
 */
test("provisioning writes the reviewed card's picture into her own root, and nothing when there is none", async () => {
  const root = await canonicalTestRoot("tavern-new-companion-avatar-");
  let threadStore: ReturnType<typeof createChatThreadStore> | undefined;
  try {
    const review = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    }).review(candidate, { reviewedFields: ["persona_core"], approvedAtMs: 1 });
    const picture = pngCardFile(JSON.stringify({ data: { name: "Candidate" } }));
    threadStore = createChatThreadStore(root, "e".repeat(64));
    const withPicture = await provisionNewCompanion(root, "player", candidate, review, threadStore, picture);
    assert.deepEqual(
      await readFile(
        companionAvatarPath(root, "player", {
          companionId: withPicture.identity.companionId,
          continuityId: withPicture.identity.continuityId!,
        }),
      ),
      Buffer.from(picture),
    );

    threadStore.close?.();
    threadStore = createChatThreadStore(root, "f".repeat(64));
    const withoutPicture = await provisionNewCompanion(root, "player", candidate, review, threadStore);
    await assert.rejects(
      access(
        companionAvatarPath(root, "player", {
          companionId: withoutPicture.identity.companionId,
          continuityId: withoutPicture.identity.continuityId!,
        }),
      ),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    // The two companions are separate namespaces: one import can never overwrite
    // another's picture, because neither shares a root.
    assert.notEqual(withPicture.identity.companionId, withoutPicture.identity.companionId);
  } finally {
    threadStore?.close?.();
    await cleanupTestRoot(root);
  }
});
