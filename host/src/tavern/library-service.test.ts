import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { canonicalHash, canonicalJson, TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { createTavernLibraryService } from "./library-service.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import { validateTavernArtifact } from "./types.js";

const hash = "a".repeat(64);
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
  const service = createTavernLibraryService(paths, artifacts, threads);
  return { root, paths, artifacts, service };
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
  const { root, paths, artifacts, service } = await setup();
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
        const { root, paths, service } = await setup();
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
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});

test("Library companion enumeration and current companion fail closed for corrupt companion records", async () => {
  const { root, paths, service } = await setup();
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
    await rm(root, { recursive: true, force: true });
  }
});

test("New Chat fails closed for absent companion and unverified greeting selections", async () => {
  const { root, paths, service } = await setup();
  try {
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
    await writeSelections(root, paths);
    await assert.rejects(
      service.createNewChat({
        chatThreadId: "thread",
        chatSurfaceSessionId: "surface",
        opening: { kind: "greeting", greetingSetId: "greetings", variantId: "missing" },
      }),
      /tavern_greeting_variant_not_found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
