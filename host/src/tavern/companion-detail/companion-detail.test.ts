import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TavernArtifactStore } from "../artifact-store.js";
import { resolveTavernPaths } from "../tavern-paths.js";
import { validateTavernArtifact } from "../types.js";
import { createCompanionDetailService } from "./companion-detail-service.js";

const hash = "a".repeat(64);

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tavern-companion-detail-"));
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
    { playerId: "player", companionId: "companion", continuityId: "continuity" },
  );
  const store = new TavernArtifactStore(root);
  return { root, paths, store, detail: createCompanionDetailService(paths, store) };
}

function companion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1 as const,
    revision: 1,
    companionId: "companion",
    continuityId: "continuity",
    name: "Buddy",
    profileId: "profile",
    profileRevision: 7,
    profileHash: hash,
    ...overrides,
  };
}

test("Companion detail projects only player-safe canonical scoped fields", async () => {
  const { root, paths, store, detail } = await setup();
  try {
    await store.write(join(paths.companionRoot, "companion.json"), companion(), validateTavernArtifact);
    const result = await detail.read();
    assert.deepEqual(result, { name: "Buddy" });
    assert.deepEqual(Object.keys(result).sort(), ["name"]);
    assert.equal(Object.isFrozen(result), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Companion detail fails closed for missing, invalid, and out-of-scope canonical records", async () => {
  const { root, paths, store, detail } = await setup();
  try {
    await assert.rejects(detail.read(), /tavern_artifact_unreadable/);

    const path = join(paths.companionRoot, "companion.json");
    await store.write(path, companion(), validateTavernArtifact);
    await writeFile(path, "{not json", "utf8");
    await assert.rejects(detail.read(), /tavern_artifact_unreadable/);
    await rm(path);

    await store.write(path, companion({ revision: 2, continuityId: "other-continuity" }), validateTavernArtifact);
    await assert.rejects(detail.read(), /tavern_companion_scope_mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
