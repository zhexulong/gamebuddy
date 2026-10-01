import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { identityProfileHash, identityProfileMetadata } from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
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
    { field: "name", text: "Candidate", eligibility: "candidate_only" as const },
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
    () => service.review(candidate, { reviewedFields: ["name"], approvedAtMs: 1 }),
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
      );
      assert.deepEqual(created.profile.persona, {
        core: "GameBuddy Companion is calm when player needs help.",
        interactionStyle: "Listen to player before answering.",
        expressionStyle: "GameBuddy Companion speaks clearly to player.",
      });
      assert.equal(identityProfileHash(created.profile), identityProfileHash({ ...created.profile, persona: { ...created.profile.persona! } }));
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
      const created = await provisionNewCompanion(
        root,
        "player",
        pending,
        review,
        threadStore,
      );
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
    const created = await provisionNewCompanion(
      root,
      "player",
      narrativeCandidate,
      review,
      threadStore,
    );

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

    const library = createTavernLibraryService(
      tavernPaths,
      store,
      threadStore,
      {
        async readExact() {
          return identityProfileMetadata(created.profile);
        },
      },
    );

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
