import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { materializeTavernAuthoredContextCatalog } from "./catalog-service.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "./chat-thread-store.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import { validateTavernArtifact } from "./types.js";

test("compiles exact v2 Chat catalog with reference-free scope and deterministic sources", async () => {
  const root = await canonicalTestRoot("gamebuddy-catalog-");
  const identity = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  const paths = resolveTavernPaths({ root } as never, identity);
  const artifacts = new TavernArtifactStore(root);
  const persona = await artifacts.write(tavernRevisionPath(join(paths.playerRoot, "personas", "persona"), 1), { schemaVersion: 1 as const, revision: 1, personaId: "persona", name: "Player" }, validateTavernArtifact);
  const scenario = await artifacts.write(tavernRevisionPath(join(paths.companionRoot, "scenarios", "scenario"), 1), { schemaVersion: 1 as const, revision: 1, scenarioId: "scenario", text: "Quiet.", provenance: "authored" as const, owner: "chat_override" as const }, validateTavernArtifact);
  const threads = createChatThreadStore(root, "continuity-key");
  const creation = createProfileAwareChatThreadCreationCapability(threads, { async readExact() { return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) }; } });
  const thread = await creation.createExplicit({ chatThreadId: "thread", chatSurfaceSessionId: "surface", companionId: "companion", continuityId: "continuity", personaId: "persona", scenarioId: "scenario", stableArtifactBindings: [
    { kind: "persona", sourceId: "persona", revision: 1, canonicalHash: persona.canonicalHash },
    { kind: "scenario", sourceId: "scenario", revision: 1, canonicalHash: scenario.canonicalHash },
  ], opening: "blank" });
  const scope = { continuityId: "continuity", sessionId: "pi-session", surface: "tavern" as const, threadId: "thread", profile: { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) } };
  const catalog = await materializeTavernAuthoredContextCatalog(paths, artifacts, thread.thread, scope);
  assert.equal(catalog.version, "gamebuddy-authored-context-catalog/v2");
  assert.deepEqual(catalog.stableSources.map((source) => source.kind), ["persona", "scenario"]);
  assert.equal(catalog.scope.threadId, "thread");
  assert.match(catalog.canonicalHash, /^[a-f0-9]{64}$/);
  await assert.rejects(() => materializeTavernAuthoredContextCatalog(paths, artifacts, thread.thread, { ...scope, threadId: "foreign" }), /binding_mismatch/);
});
