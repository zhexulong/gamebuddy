import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { canonicalHash, canonicalJson, TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { createTavernLibraryService } from "./library-service.js";
import { createScenarioManagementService } from "./scenario-management/scenario-management.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import { validateTavernArtifact } from "./types.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const hash = "a".repeat(64);
const profileReader = { async readExact() { return { profileId: "profile", revision: 1, canonicalHash: hash }; } };
async function setup() {
  const root = await canonicalTestRoot("tavern-library-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths(
    {
      root,
      runtimeCwd: root,
      agentDir: "x",
      sessionDir: "x",
      identityProfilePath: "x",
      identityProfileBindingPath: "x",
      runManifestPath: "x",
    },
    identity,
  );
  const artifacts = new TavernArtifactStore(root);
  const threads = createChatThreadStore(root, "b".repeat(64), () => 10);
  const service = createTavernLibraryService(paths, artifacts, threads, profileReader);
  return { root, paths, artifacts, service, threads };
}
async function writeSelections(root: string, paths: ReturnType<typeof resolveTavernPaths>) {
  const artifacts = new TavernArtifactStore(root);
  await artifacts.write(
    tavernRevisionPath(join(paths.playerRoot, "personas", "persona"), 1),
    { schemaVersion: 1, revision: 1, personaId: "persona", name: "Player" },
    validateTavernArtifact,
  );
  await artifacts.write(
    tavernRevisionPath(join(paths.playerRoot, "personas", "persona"), 2),
    { schemaVersion: 1, revision: 2, personaId: "persona", name: "Player v2" },
    validateTavernArtifact,
  );
  await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "scenarios", "scenario"), 1),
    {
      schemaVersion: 1,
      revision: 1,
      scenarioId: "scenario",
      name: "Quiet tavern",
      description: "A quiet place for conversation.",
      text: "A quiet tavern.",
      provenance: "authored",
      owner: "chat_override",
    },
    validateTavernArtifact,
  );
  await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "scenarios", "scenario"), 2),
    {
      schemaVersion: 1,
      revision: 2,
      scenarioId: "scenario",
      name: "Lively tavern",
      description: "A lively place for conversation.",
      text: "A lively tavern.",
      provenance: "authored",
      owner: "chat_override",
    },
    validateTavernArtifact,
  );
  await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "greetings", "greetings"), 1),
    {
      schemaVersion: 1,
      revision: 1,
      greetingSetId: "greetings",
      variants: [
        { variantId: "first", text: "Welcome." },
        { variantId: "alternate", text: "Good evening." },
      ],
    },
    validateTavernArtifact,
  );
  await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "greetings", "greetings"), 2),
    {
      schemaVersion: 1,
      revision: 2,
      greetingSetId: "greetings",
      variants: [{ variantId: "alternate", text: "Welcome back." }],
    },
    validateTavernArtifact,
  );
  await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "dialogue-examples", "examples"), 1),
    { schemaVersion: 1, revision: 1, examplesId: "examples", blocks: ["First example."] },
    validateTavernArtifact,
  );
  await artifacts.write(
    tavernRevisionPath(join(paths.companionRoot, "dialogue-examples", "examples"), 2),
    { schemaVersion: 1, revision: 2, examplesId: "examples", blocks: ["Latest example."] },
    validateTavernArtifact,
  );
}

test("Companion Library persists inert selected companion metadata and Manage Chats opens exact threads", async () => {
  const { root, paths, artifacts, service, threads } = await setup();
  try {
    const companion = await service.createNewCompanion({
      companionId: "companion",
      continuityId: "continuity",
      name: "Buddy",
      profileId: "profile",
      profileRevision: 1,
      profileHash: hash,
    });
    assert.equal(companion.name, "Buddy");
    assert.deepEqual(
      (await service.listCompanions()).map((item) => item.companionId),
      ["companion"],
    );
    await writeSelections(root, paths);
    const created = await service.createNewChat({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      personaId: "persona",
      scenarioId: "scenario",
      opening: { kind: "greeting", greetingSetId: "greetings", variantId: "alternate", messageId: "opening" },
    });
    assert.deepEqual(
      created.messages.map((item) => item.text),
      ["Welcome back."],
    );
    assert.deepEqual(created.thread.stableArtifactBindings, [
      {
        kind: "persona",
        sourceId: "persona",
        revision: 2,
        canonicalHash: (
          await artifacts.read(
            tavernRevisionPath(join(paths.playerRoot, "personas", "persona"), 2),
            validateTavernArtifact,
          )
        ).canonicalHash,
      },
      {
        kind: "scenario",
        sourceId: "scenario",
        revision: 2,
        canonicalHash: (
          await artifacts.read(
            tavernRevisionPath(join(paths.companionRoot, "scenarios", "scenario"), 2),
            validateTavernArtifact,
          )
        ).canonicalHash,
      },
    ]);
    assert.equal(created.messages[0]!.greetingSource!.sourceRevision, 2);
    assert.equal(
      created.messages[0]!.greetingSource!.canonicalHash,
      (
        await artifacts.read(
          tavernRevisionPath(join(paths.companionRoot, "greetings", "greetings"), 2),
          validateTavernArtifact,
        )
      ).canonicalHash,
    );
    assert.equal(created.thread.personaId, "persona");
    assert.equal(created.thread.scenarioId, "scenario");
    assert.deepEqual(
      (await service.listChats()).map((item) => item.chatThreadId),
      ["thread"],
    );
    assert.deepEqual(await service.activeChatSelection(), null);
    assert.deepEqual(await service.openChat("thread", "surface"), created);
    // Library only validates the exact inert mapping; the runtime owner is
    // solely responsible for committing active selection after Pi activation.
    assert.deepEqual(await service.activeChatSelection(), null);
    await assert.rejects(service.openChat("thread", "other"), /chat_thread_surface_mismatch/);
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("New Chat rejects corrupt, mismatched, and junk revisions on each Library selection path without lower fallback", async () => {
  const selections = [
    {
      kind: "persona",
      directory: (paths: ReturnType<typeof resolveTavernPaths>) => join(paths.playerRoot, "personas", "persona"),
      artifact: (revision: number) => ({
        schemaVersion: 1 as const,
        revision,
        personaId: "wrong-persona",
        name: "Wrong",
      }),
      request: (): Parameters<ReturnType<typeof createTavernLibraryService>["createNewChat"]>[0] => ({
        chatThreadId: "thread",
        chatSurfaceSessionId: "surface",
        personaId: "persona",
        opening: { kind: "blank" },
      }),
      error: /invalid_tavern_selection/,
    },
    {
      kind: "scenario",
      directory: (paths: ReturnType<typeof resolveTavernPaths>) => join(paths.companionRoot, "scenarios", "scenario"),
      artifact: (revision: number) => ({
        schemaVersion: 1 as const,
        revision,
        scenarioId: "wrong-scenario",
        name: "Wrong scenario",
        description: "A mismatched scenario fixture.",
        text: "Wrong",
        provenance: "authored" as const,
        owner: "chat_override" as const,
      }),
      request: (): Parameters<ReturnType<typeof createTavernLibraryService>["createNewChat"]>[0] => ({
        chatThreadId: "thread",
        chatSurfaceSessionId: "surface",
        scenarioId: "scenario",
        opening: { kind: "blank" },
      }),
      error: /invalid_tavern_selection/,
    },
    {
      kind: "dialogue examples",
      directory: (paths: ReturnType<typeof resolveTavernPaths>) =>
        join(paths.companionRoot, "dialogue-examples", "examples"),
      artifact: (revision: number) => ({
        schemaVersion: 1 as const,
        revision,
        examplesId: "wrong-examples",
        blocks: ["Wrong"],
      }),
      request: (): Parameters<ReturnType<typeof createTavernLibraryService>["createNewChat"]>[0] => ({
        chatThreadId: "thread",
        chatSurfaceSessionId: "surface",
        dialogueExamplesId: "examples",
        opening: { kind: "blank" },
      }),
      error: /invalid_tavern_selection/,
    },
    {
      kind: "greeting",
      directory: (paths: ReturnType<typeof resolveTavernPaths>) => join(paths.companionRoot, "greetings", "greetings"),
      artifact: (revision: number) => ({
        schemaVersion: 1 as const,
        revision,
        greetingSetId: "wrong-greetings",
        variants: [{ variantId: "alternate", text: "Wrong" }],
      }),
      request: (): Parameters<ReturnType<typeof createTavernLibraryService>["createNewChat"]>[0] => ({
        chatThreadId: "thread",
        chatSurfaceSessionId: "surface",
        opening: { kind: "greeting", greetingSetId: "greetings", variantId: "alternate" },
      }),
      error: /invalid_tavern_greeting/,
    },
  ] as const;
  for (const selection of selections) {
    for (const invalid of ["corrupt-highest", "mismatched-highest", "junk-filename"] as const) {
      await test(`${selection.kind} selection rejects ${invalid}`, async () => {
        const { root, paths, service, threads } = await setup();
        try {
          await service.createNewCompanion({
            companionId: "companion",
            continuityId: "continuity",
            name: "Buddy",
            profileId: "profile",
            profileRevision: 1,
            profileHash: hash,
          });
          await writeSelections(root, paths);
          const revisions = join(selection.directory(paths), "revisions");
          if (invalid === "corrupt-highest") await writeFile(join(revisions, "3.json"), "{ corrupt", "utf8");
          if (invalid === "mismatched-highest") {
            const artifact = selection.artifact(3);
            await writeFile(
              join(revisions, "3.json"),
              canonicalJson({ schemaVersion: 1, revision: 3, canonicalHash: canonicalHash(artifact), artifact }),
              "utf8",
            );
          }
          if (invalid === "junk-filename") await writeFile(join(revisions, "notes.txt"), "junk", "utf8");
          await assert.rejects(service.createNewChat(selection.request()), selection.error);
        } finally {
          threads.close?.();
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});

test("Library companion enumeration and current companion fail closed for corrupt companion records", async () => {
  const { root, paths, service, threads } = await setup();
  try {
    await service.createNewCompanion({
      companionId: "companion",
      continuityId: "continuity",
      name: "Buddy",
      profileId: "profile",
      profileRevision: 1,
      profileHash: hash,
    });
    const companionPath = join(paths.companionRoot, "companion.json");
    await writeFile(companionPath, "{ corrupt", "utf8");
    await assert.rejects(service.listCompanions(), /tavern_artifact_unreadable/);
    await assert.rejects(
      service.createNewChat({ chatThreadId: "thread", chatSurfaceSessionId: "surface", opening: { kind: "blank" } }),
      /tavern_artifact_unreadable/,
    );
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("New Chat requires the companion record the seed installs, and refuses an unverified greeting", async () => {
  const { root, paths, service, threads } = await setup();
  try {
    // No `companion.json`: the seed installs that record through the library's
    // own creation path, so its absence means the two producers of the record
    // disagree. The library fails closed instead of opening a Chat on a record
    // it never wrote - a missing artifact is never the ordinary case.
    await assert.rejects(
      service.createNewChat({ chatThreadId: "thread", chatSurfaceSessionId: "surface", opening: { kind: "blank" } }),
      /tavern_artifact_unreadable/,
    );

    await service.createNewCompanion({
      companionId: "companion",
      continuityId: "continuity",
      name: "Buddy",
      profileId: "profile",
      profileRevision: 1,
      profileHash: hash,
    });
    const state = await service.createNewChat({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      opening: { kind: "blank" },
    });
    assert.equal(state.messages.length, 0);
    assert.equal(state.thread.companionId, "companion");
    assert.equal(state.thread.continuityId, "continuity");

    await writeSelections(root, paths);
    await assert.rejects(
      service.createNewChat({
        chatThreadId: "thread-two",
        chatSurfaceSessionId: "surface-two",
        opening: { kind: "greeting", greetingSetId: "greetings", variantId: "missing" },
      }),
      /tavern_greeting_variant_not_found/,
    );
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("createNewChat consumes provisioned scenario and first greeting opening with M0 binding", async () => {
  const { root, paths, artifacts, service, threads } = await setup();
  try {
    await service.createNewCompanion({
      companionId: "companion",
      continuityId: "continuity",
      name: "Buddy",
      profileId: "profile",
      profileRevision: 1,
      profileHash: hash,
    });

    const scenarioService = createScenarioManagementService(artifacts, paths.companionRoot);
    const greetingService = createGreetingManagementService(artifacts, paths.companionRoot);

    await scenarioService.create({
      name: "Default Scenario",
      description: "You and Buddy sit by the fireplace in the tavern.",
    });
    await greetingService.create({
      label: "Initial Greeting",
      variants: [{ label: "Default", text: "Greetings, traveler! Pull up a chair." }],
    });

    const digest = createHash("sha256").update(resolve(paths.companionRoot), "utf8").digest("hex").slice(0, 32);
    const scenarioId = `player-scenario-${digest}`;
    const greetingSetId = `greeting-set-${digest}`;

    const chatState = await service.createNewChat({
      chatThreadId: "thread-narrative",
      chatSurfaceSessionId: "surface-narrative",
      scenarioId,
      opening: {
        kind: "greeting",
        greetingSetId,
        variantId: "greeting-1",
        messageId: "msg-first-greeting",
      },
    });

    assert.equal(chatState.messages.length, 1);
    assert.equal(chatState.messages[0]?.text, "Greetings, traveler! Pull up a chair.");
    assert.equal(chatState.messages[0]?.messageId, "msg-first-greeting");

    const scenarioBinding = chatState.thread.stableArtifactBindings?.find((b) => b.kind === "scenario");
    assert.ok(scenarioBinding !== undefined);
    assert.equal(scenarioBinding.sourceId, scenarioId);
    assert.equal(scenarioBinding.revision, 1);
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});


test("New Chat opening variants are recorded on the unlocked chat, read back durably, and refused once sealed", async () => {
  const { root, paths, artifacts, service, threads } = await setup();
  try {
    await service.createNewCompanion({
      companionId: "companion",
      continuityId: "continuity",
      name: "Buddy",
      profileId: "profile",
      profileRevision: 1,
      profileHash: hash,
    });
    await artifacts.write(
      tavernRevisionPath(join(paths.companionRoot, "greetings", "openings"), 1),
      {
        schemaVersion: 1,
        revision: 1,
        greetingSetId: "openings",
        label: "Openings",
        variants: [
          { variantId: "greeting-1", label: "Default", text: "Hello there." },
          { variantId: "greeting-2", label: "Warm", text: "Good to see you again." },
          { variantId: "greeting-3", label: "Brief", text: "Hey." },
        ],
      },
      validateTavernArtifact,
    );
    const created = await service.createNewChat({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      opening: { kind: "greeting", greetingSetId: "openings", variantId: "greeting-1", messageId: "opening" },
    });
    assert.equal(created.messages[0]?.greetingSource?.variantId, "greeting-1");

    // The choice is RECORDED, not merely accepted: a fresh durable read (not the
    // returned object) must observe the chosen variant on the opening message.
    await service.commitOpeningVariant({ chatThreadId: "thread", chatSurfaceSessionId: "surface", direction: "next" });
    const reread = await threads.resumeThread("thread", "surface");
    assert.equal(reread.messages[0]?.greetingSource?.variantId, "greeting-2");
    assert.equal(reread.messages[0]?.text, "Good to see you again.");
    assert.equal(
      reread.thread.openingSelection.kind === "greeting"
        ? reread.thread.openingSelection.source.variantId
        : null,
      "greeting-2",
    );

    // A targeted index is exact, and an out-of-range one is a bounded refusal rather
    // than a silent no-op.
    await service.commitOpeningVariant({ chatThreadId: "thread", chatSurfaceSessionId: "surface", targetIndex: 2 });
    const targeted = await threads.resumeThread("thread", "surface");
    assert.equal(targeted.messages[0]?.greetingSource?.variantId, "greeting-3");
    await assert.rejects(
      service.commitOpeningVariant({ chatThreadId: "thread", chatSurfaceSessionId: "surface", targetIndex: 9 }),
      /chat_opening_variant_not_found/,
    );

    // The first player message seals the opening; the choice is then refused with its
    // bounded code and the durable variant is untouched.
    await threads.appendPlayer("thread", { messageId: "player_1", text: "Hi", occurredAtMs: 11 });
    await assert.rejects(
      service.commitOpeningVariant({ chatThreadId: "thread", chatSurfaceSessionId: "surface", direction: "prev" }),
      /chat_opening_locked/,
    );
    const sealed = await threads.resumeThread("thread", "surface");
    assert.equal(sealed.messages[0]?.greetingSource?.variantId, "greeting-3");
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Chat whose opening is not a greeting refuses the opening choice with a bounded code", async () => {
  const { root, service, threads } = await setup();
  try {
    await service.createNewCompanion({
      companionId: "companion",
      continuityId: "continuity",
      name: "Buddy",
      profileId: "profile",
      profileRevision: 1,
      profileHash: hash,
    });
    await service.createNewChat({
      chatThreadId: "thread",
      chatSurfaceSessionId: "surface",
      opening: { kind: "blank" },
    });
    await assert.rejects(
      service.commitOpeningVariant({ chatThreadId: "thread", chatSurfaceSessionId: "surface", direction: "next" }),
      /chat_opening_not_greeting/,
    );
  } finally {
    threads.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
