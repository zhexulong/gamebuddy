import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createKnownSemanticGameFacadeFromOperatorConfig } from "./continuity-semantic-game-operator-selection.internal.js";

const principal = { continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" };

type Fixture = Readonly<{ root: string; runtimeRoot: string; manifestPath: string; configPath: string }>;

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "semantic-game-operator-"));
  const runtimeRoot = join(root, "runtime");
  const manifestPath = join(root, "manifest.json");
  const configPath = join(root, "game-operator.json");
  await mkdir(runtimeRoot);
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      topology: "dialogue_initializes_game_opens",
      runtimeRoot,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
  return Object.freeze({ root, runtimeRoot, manifestPath, configPath });
}

async function operatorConfig(fixture: Fixture, integrationId: string, integration: unknown = {}): Promise<void> {
  await writeFile(
    fixture.configPath,
    JSON.stringify({ schemaVersion: 1, manifestPath: fixture.manifestPath, integrationId, integration }),
  );
}

test("operator selection fails before binding when config is malformed or adapter is not product-registered", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.configPath,
      JSON.stringify({
        schemaVersion: 1,
        manifestPath: f.manifestPath,
        integrationId: "stardew",
        integration: {},
        unexpected: true,
      }),
    );
    await assert.rejects(
      createKnownSemanticGameFacadeFromOperatorConfig(f.configPath),
      /invalid_semantic_game_operator_config/,
    );
    await operatorConfig(f, "not_registered");
    await assert.rejects(
      createKnownSemanticGameFacadeFromOperatorConfig(f.configPath),
      /semantic_game_operator_integration_not_registered/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("operator selection rejects duplicate decoded keys, relative paths, and cannot consume caller adapter inputs", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.configPath,
      `{"schemaVersion":1,"manifestPath":${JSON.stringify(f.manifestPath)},"integrationId":"stardew","integration":{},"integrationId":"other"}`,
    );
    await assert.rejects(
      createKnownSemanticGameFacadeFromOperatorConfig(f.configPath),
      /invalid_semantic_game_operator_config/,
    );
    await writeFile(
      f.configPath,
      JSON.stringify({
        schemaVersion: 1,
        manifestPath: "relative-manifest.json",
        integrationId: "stardew",
        integration: {},
      }),
    );
    await assert.rejects(
      createKnownSemanticGameFacadeFromOperatorConfig(f.configPath),
      /invalid_semantic_game_operator_config/,
    );
    await assert.rejects(
      createKnownSemanticGameFacadeFromOperatorConfig("relative-config.json"),
      /invalid_semantic_game_operator_config/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("operator Game construction graph accepts only a file path and excludes legacy or entrypoint authority", async () => {
  const { readFile } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const source = await readFile(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.internal.ts",
    ),
    "utf8",
  );
  for (const forbidden of [
    "integration-bootstrap",
    "production-game-continuity",
    "main.js",
    "dialogue-web-main",
    "createIntegrationCatalog(",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden selection ingress: ${forbidden}`);
  }
  assert.match(source, /createKnownSemanticGameFacadeFromOperatorConfig\(\s*operatorConfigPath: string,?\s*\)/);
  assert.match(source, /PRODUCT_INTEGRATION_CATALOG\.get/);
});
