import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createStardewOwnedFarmhandGameSessionMaterializer } from "./stardew-owned-farmhand-game-session-materializer.internal.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";

const manifest: HostDeploymentManifest = Object.freeze({
  schemaVersion: 2,
  topology: "independent_chat_and_game_surfaces",
  runtimeRoot: process.cwd(),
  principal: Object.freeze({
    continuityId: "continuity-materializer-test",
    playerId: "player-materializer-test",
    companionId: "companion-materializer-test",
  }),
  bootstrapOperationId: "bootstrap-materializer-test",
  authorityGeneration: 1,
});

test("owned Farmhand materializer exposes only one unmounted construction operation", async () => {
  const materializerModule = await import("./stardew-owned-farmhand-game-session-materializer.internal.js");
  assert.deepEqual(Object.keys(materializerModule), ["createStardewOwnedFarmhandGameSessionMaterializer"]);
  const materializer = createStardewOwnedFarmhandGameSessionMaterializer(manifest);
  assert.deepEqual(Object.keys(materializer), ["materialize"]);
  assert.equal(Object.isFrozen(materializer), true);
  assert.equal(materializer.materialize.length, 2);
  assert.equal("runEnter" in materializer, false);
  assert.equal("close" in materializer, false);
  assert.equal("attach" in materializer, false);
});

test("owned Farmhand materializer preserves authenticated receipt-backed construction order", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = testDirectory.endsWith("src") ? testDirectory : resolve(testDirectory, "..", "src");
  const source = await readFile(resolve(sourceRoot, "stardew-owned-farmhand-game-session-materializer.internal.ts"), "utf8");
  assert.match(
    source,
    /LocalStardewBridgeClient\.connectFarmhand\(\s*connection\.scope,\s*connection\.pipeName,\s*connection\.token,\s*connection\.launchGeneration,\s*deadlineMs\s*,?\s*\)/,
  );
  assert.match(source, /createStardewIntegrationLaunchHandleFromAuthenticatedBridge\(/);
  assert.match(source, /createGameRuntimeBindingFromReceiptBackedLaunch\(/);
  assert.match(source, /createKnownSemanticGameFacadeFromReceiptBackedBinding\(manifest, binding\)/);
  const connectIndex = source.indexOf("const bridge = await LocalStardewBridgeClient.connectFarmhand");
  const launchIndex = source.indexOf("const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge");
  const bindingIndex = source.indexOf("const binding = await createGameRuntimeBindingFromReceiptBackedLaunch");
  const facadeIndex = source.indexOf("return createKnownSemanticGameFacadeFromReceiptBackedBinding");
  assert.ok(connectIndex >= 0);
  assert.ok(launchIndex >= 0);
  assert.ok(bindingIndex >= 0);
  assert.ok(facadeIndex >= 0);
  assert.ok(connectIndex < launchIndex);
  assert.ok(launchIndex < bindingIndex);
  assert.ok(bindingIndex < facadeIndex);
  assert.doesNotMatch(source, /runEnter\s*[:=]/);
  assert.doesNotMatch(source, /activateCommittedIngress/);
  assert.doesNotMatch(source, /attachVoiceStopper/);
});

test("Preview, Portfolio, and operational gate sources do not import the product materializer", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = testDirectory.endsWith("src") ? testDirectory : resolve(testDirectory, "..", "src");
  const checked = [
    "farmhand-companion-preview.ts",
    ...(await readdir(sourceRoot)).filter((leaf) => leaf.startsWith("portfolio-") && leaf.endsWith(".ts")),
  ];
  assert.ok(checked.length > 1);
  for (const leaf of checked) {
    const source = await readFile(join(sourceRoot, leaf), "utf8");
    assert.doesNotMatch(source, /stardew-owned-farmhand-game-session-materializer/);
  }

  const operationalGateSource = await readFile(
    resolve(sourceRoot, "..", "..", "tools", "run-game-operational-gate.mjs"),
    "utf8",
  );
  assert.doesNotMatch(operationalGateSource, /stardew-owned-farmhand-game-session-materializer/);
});
