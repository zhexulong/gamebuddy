import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeOrVerifyRunManifest, type CompanionRunManifest } from "./run-manifest.js";
import type { IntegrationActionPolicy } from "./integration-module.js";
import type { RuntimePaths } from "./runtime.js";

const manifest: CompanionRunManifest = {
  schemaVersion: 1,
  identity: { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" },
  runtime: { pi: "test", magicContext: "test" },
  model: { provider: null, modelId: null, thinkingLevel: null },
  gameplaySubagentModel: null,
  actionRegistryRevision: "revision_01",
  actionPolicy: { policyVersion: 1, deniedActions: [], deniedFamilies: [] } satisfies IntegrationActionPolicy,
  mountedTools: ["companion_status"],
  knowledge: { mounted: false, gameVersion: null, bundleVersion: null },
  identityProfile: { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) },
  worldBook: null,
  presentation: null,
  featureFlags: {
    gameplaySubagent: false,
    magicContextMemoryDomain: "ongoing-interaction",
    magicContextMemoryEnabled: true,
    magicContextAutoPromoteEnabled: false,
    magicContextAutoSearchEnabled: false,
  },
};

async function paths(): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-run-manifest-"));
  return {
    root,
    runtimeCwd: root,
    agentDir: join(root, "pi-agent"),
    sessionDir: join(root, "sessions"),
    identityProfilePath: join(root, "identity-profile.json"),
    identityProfileBindingPath: join(root, "identity-profile-binding.json"),
    runManifestPath: join(root, "companion-run-manifest.json"),
  };
}

test("run manifest writes once atomically and verifies stable immutable configuration", async () => {
  const runtimePaths = await paths();
  await writeOrVerifyRunManifest(runtimePaths, manifest);
  await writeOrVerifyRunManifest(runtimePaths, manifest);
  assert.deepEqual(JSON.parse(await readFile(runtimePaths.runManifestPath, "utf8")), manifest);
});

test("run manifest surfaces malformed and corrupt persisted data as a public invalid-manifest error", async () => {
  const runtimePaths = await paths();
  for (const contents of ["{ truncated", '{"key":1,"key":2}']) {
    await writeFile(runtimePaths.runManifestPath, contents, "utf8");
    await assert.rejects(() => writeOrVerifyRunManifest(runtimePaths, manifest), { message: "invalid_run_manifest" });
  }
});

test("run manifest preserves configuration mismatch semantics", async () => {
  const runtimePaths = await paths();
  await writeFile(runtimePaths.runManifestPath, JSON.stringify(manifest), "utf8");
  await assert.rejects(() => writeOrVerifyRunManifest(runtimePaths, { ...manifest, mountedTools: ["other_tool"] }), {
    message: "run_manifest_mismatch",
  });
});

test("run manifest serializes concurrent identical initialization without corrupting its immutable binding", async () => {
  const runtimePaths = await paths();
  await Promise.all(Array.from({ length: 8 }, () => writeOrVerifyRunManifest(runtimePaths, manifest)));
  assert.deepEqual(JSON.parse(await readFile(runtimePaths.runManifestPath, "utf8")), manifest);
});
