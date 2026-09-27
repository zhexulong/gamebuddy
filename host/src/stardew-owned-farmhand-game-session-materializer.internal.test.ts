import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SemanticGameProductionAuthority } from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import { createStardewOwnedFarmhandGameSessionMaterializer } from "./stardew-owned-farmhand-game-session-materializer.internal.js";

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
  const materializer = createStardewOwnedFarmhandGameSessionMaterializer(
    manifest,
    undefined as unknown as SemanticGameProductionAuthority,
  );
  assert.deepEqual(Object.keys(materializer), ["materialize"]);
  assert.equal(Object.isFrozen(materializer), true);
  assert.equal(materializer.materialize.length, 2);
  assert.equal("runEnter" in materializer, false);
  assert.equal("close" in materializer, false);
  assert.equal("attach" in materializer, false);
});

test("owned Farmhand materializer preserves authenticated receipt-backed construction order over the injected Game authority", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = testDirectory.endsWith("src") ? testDirectory : resolve(testDirectory, "..", "src");
  const source = await readFile(
    resolve(sourceRoot, "stardew-owned-farmhand-game-session-materializer.internal.ts"),
    "utf8",
  );
  assert.match(
    source,
    /LocalStardewBridgeClient\.connectFarmhand\(\s*connection\.scope,\s*connection\.pipeName,\s*connection\.token,\s*connection\.launchGeneration,\s*deadlineMs\s*,?\s*STARDEW_INTEGRATION_LAUNCHER\.module\s*,?\s*\)/,
  );
  assert.match(source, /createStardewIntegrationLaunchHandleFromAuthenticatedBridge\(/);
  assert.match(source, /createGameRuntimeBindingFromReceiptBackedLaunch\(/);
  assert.match(source, /constructKnownUnmountedGameSemanticFacade\(/);
  assert.match(source, /createHostGameRuntimeMaterializer\(\)/);
  assert.doesNotMatch(source, /createKnownSemanticGameFacadeFromReceiptBackedBinding/);
  assert.doesNotMatch(source, /createKnownSemanticGameProductionAuthorityFromDeploymentManifest/);
  const connectIndex = source.indexOf("const bridge = await LocalStardewBridgeClient.connectFarmhand");
  const launchIndex = source.indexOf(
    "const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge",
  );
  const bindingIndex = source.indexOf("const binding = await createGameRuntimeBindingFromReceiptBackedLaunch");
  const facadeIndex = source.indexOf("return constructKnownUnmountedGameSemanticFacade(");
  assert.ok(connectIndex >= 0);
  assert.ok(launchIndex >= 0);
  assert.ok(bindingIndex >= 0);
  assert.ok(facadeIndex >= 0);
  assert.ok(connectIndex < launchIndex);
  assert.ok(launchIndex < bindingIndex);
  assert.ok(bindingIndex < facadeIndex);
  // Construction failure closes only the binding the materializer created.
  assert.match(source, /await binding\.close\(\)/);
  // Injected Game authority never appears in failure cleanup: upstream
  // factories close their own transport/launch when they reject, and this
  // slice re-closes only the binding it created — never game, launch, bridge.
  assert.doesNotMatch(source, /game\.close\(/);
  assert.doesNotMatch(source, /launch\.close\(/);
  assert.doesNotMatch(source, /bridge\.close\(/);
  assert.doesNotMatch(source, /runEnter\s*[:=]/);
  assert.doesNotMatch(source, /activateCommittedIngress/);
  assert.doesNotMatch(source, /attachVoiceStopper/);
});

test("Preview and operational gate sources do not import the product materializer", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = testDirectory.endsWith("src") ? testDirectory : resolve(testDirectory, "..", "src");
  const checked = [
    "farmhand-companion-preview.ts",
  ];
  assert.ok(checked.length >= 1);
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

/**
 * Task 3 Step 2: static production import inventory.
 *
 * The private generation-bound materializer is the ONE seam that may construct the
 * shipped Stardew Game facade, so exactly one production module may import it: the
 * lifecycle coordinator. Everything the plan names as forbidden — the shipped entry,
 * semantic operator selection, the product catalog, Preview, Portfolio, and the
 * operational runner — must not reach it.
 *
 * This scans production TypeScript sources rather than relying on structural typing,
 * because a type-compatible duplicate wiring would pass a type check while still
 * creating a second construction path.
 */
test("only the lifecycle coordinator imports the private Stardew materializer", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = testDirectory.endsWith("src") ? testDirectory : resolve(testDirectory, "..", "src");
  const repositoryRoot = resolve(sourceRoot, "..", "..");

  const materializerModule = "stardew-owned-farmhand-game-session-materializer";
  const files = await collectProductionTypeScript(sourceRoot);

  const importers: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // Match an actual module specifier, not a comment or an unrelated identifier.
    if (new RegExp(`from\\s+["'][^"']*${materializerModule}[^"']*["']`).test(source)) {
      importers.push(file.slice(repositoryRoot.length + 1).replaceAll("\\", "/"));
    }
  }

  assert.deepEqual(
    importers,
    ["host/src/stardew-production-lifecycle-coordinator.internal.ts"],
    "exactly the lifecycle coordinator may import the private materializer",
  );

  // The forbidden surfaces must also not name the operator-config construction route
  // that Task 2 removed, so a future change cannot reintroduce it under a new name.
  for (const relative of [
    "host/src/main.ts",
    "host/src/semantic-main-config.ts",
    "host/src/integration-catalog-product.ts",
    "host/src/farmhand-companion-preview.ts",
  ]) {
    const source = await readFile(join(repositoryRoot, relative), "utf8");
    assert.doesNotMatch(source, /createKnownSemanticGameFacadeFromOperatorConfig/);
    assert.doesNotMatch(source, /createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig/);
  }
});

/** Recursively collect production TypeScript sources, excluding tests and fixtures. */
async function collectProductionTypeScript(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Generated outputs and dependency trees are not production sources.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      found.push(...(await collectProductionTypeScript(path)));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    // Test, test-support, and fixture modules are not shipped production modules.
    if (/\.(test|spec)\.ts$/.test(entry.name)) continue;
    if (/\.test-support\.ts$/.test(entry.name)) continue;
    if (/-test-fixtures?\.ts$/.test(entry.name)) continue;
    found.push(path);
  }
  found.sort();
  return found;
}
