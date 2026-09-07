import assert from "node:assert/strict";
import { mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";

import type { GameRuntimeBinding } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import { createFreshSemanticProductionAuthorityFromDeploymentManifest } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import {
  createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig,
  createKnownSemanticGameFacadeFromOperatorConfig,
  createKnownSemanticGameFacadeFromReceiptBackedBinding,
} from "./continuity-semantic-game-operator-selection.internal.js";

const principal = { continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" };

type Fixture = Readonly<{ root: string; runtimeRoot: string; manifestPath: string; configPath: string }>;

async function fixture(): Promise<Fixture> {
  const root = await canonicalTestRoot("semantic-game-operator-");
  const runtimeRoot = join(root, "runtime");
  const manifestPath = join(root, "manifest.json");
  const configPath = join(root, "game-operator.json");
  await mkdir(runtimeRoot);
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
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

test("operator selection maps malformed UTF-8 and oversized config files to its domain error", async () => {
  const f = await fixture();
  try {
    await writeFile(f.configPath, Buffer.from([0xff]));
    await assert.rejects(createKnownSemanticGameFacadeFromOperatorConfig(f.configPath), {
      message: "invalid_semantic_game_operator_config",
    });
    await writeFile(f.configPath, "{}", "utf8");
    await truncate(f.configPath, 65_537);
    await assert.rejects(createKnownSemanticGameFacadeFromOperatorConfig(f.configPath), {
      message: "invalid_semantic_game_operator_config",
    });
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("receipt-backed binding composition constructs an unmounted production facade without consuming the binding", async () => {
  const f = await fixture();
  let executionCalls = 0;
  let closeCalls = 0;
  const binding: GameRuntimeBinding = Object.freeze({
    executeWithBinding: async () => {
      executionCalls += 1;
      throw new Error("unexpected_binding_execution");
    },
    close: async () => {
      closeCalls += 1;
    },
  });
  try {
    const manifest = await loadHostDeploymentManifest(f.manifestPath);
    const fresh = await createFreshSemanticProductionAuthorityFromDeploymentManifest(manifest);
    await fresh.close();
    const facade = await createKnownSemanticGameFacadeFromReceiptBackedBinding(manifest, binding);
    assert.equal(facade.authority, "SEMANTIC");
    assert.equal(executionCalls, 0);
    assert.equal(closeCalls, 0);
    await facade.close();
    assert.equal(executionCalls, 0);
    assert.equal(closeCalls, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("dead-owner recovery composition is authority-only and cannot create launcher or runtime side effects", async () => {
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
  const recovery = source.slice(
    source.indexOf("export async function createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig"),
    source.indexOf(
      "/** Strict bounded operator-file parser",
      source.indexOf("export async function createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig"),
    ),
  );
  assert.match(recovery, /loadHostSemanticGameOperatorConfig\(operatorConfigPath\)/);
  assert.match(recovery, /loadHostDeploymentManifest\(loaded\.config\.manifestPath\)/);
  assert.match(recovery, /createKnownSemanticGameProductionAuthorityFromDeploymentManifest\(manifest\)/);
  for (const forbidden of [
    "selectHostOwnedGameIntegration",
    "PRODUCT_INTEGRATION_CATALOG",
    "createGameRuntimeBinding",
    "createHostGameRuntimeMaterializer",
    "constructKnownUnmountedGameSemanticFacade",
    "launcher",
    ".prepare(",
    ".launch(",
    ".revoke(",
  ]) {
    assert.equal(recovery.includes(forbidden), false, `recovery side-effect ingress: ${forbidden}`);
  }
  assert.doesNotMatch(recovery, /runEnter|binding|materializer|authority:/);
  assert.match(recovery, /recoverDeadOwner: async \(input\)/);
  assert.match(recovery, /close: async \(\) => \{\s*await game\.close\(\)/);
});

test("normal Game composition passes one immutable manifest snapshot to authority and binding without a second path load", async () => {
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
  const composition = source.slice(
    source.indexOf("export async function createKnownSemanticGameFacadeFromOperatorConfig"),
    source.indexOf("/**\n * Recovery composition"),
  );
  assert.equal((composition.match(/loadHostDeploymentManifest\(/g) ?? []).length, 1);
  assert.match(composition, /const manifest = await loadHostDeploymentManifest\(selected\.manifestPath\)/);
  assert.match(composition, /createGameRuntimeBinding\(\s*Object\.freeze\(\{\s*manifest,/);
  assert.match(composition, /createKnownSemanticGameProductionAuthorityFromDeploymentManifest\(manifest\)/);
  assert.doesNotMatch(composition, /manifestPath:\s*selected\.manifestPath/);
});

test("authority-only recovery parses malformed operator input before any recovery construction", async () => {
  const f = await fixture();
  try {
    await writeFile(f.configPath, "{not-json");
    await assert.rejects(
      createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig(f.configPath),
      /invalid_semantic_game_operator_config/,
    );
    await writeFile(
      f.configPath,
      JSON.stringify({
        schemaVersion: 1,
        manifestPath: f.manifestPath,
        integrationId: "stardew",
        integration: {},
        extra: true,
      }),
    );
    await assert.rejects(
      createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig(f.configPath),
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
  for (const forbidden of ["integration-bootstrap", "main.js", "dialogue-web-main", "createIntegrationCatalog("]) {
    assert.equal(source.includes(forbidden), false, `forbidden selection ingress: ${forbidden}`);
  }
  assert.match(source, /createKnownSemanticGameFacadeFromOperatorConfig\(\s*operatorConfigPath: string,/);
  assert.match(source, /HostGameRuntimeMaterializerOptions/);
  assert.match(source, /createHostGameRuntimeMaterializer\(options\)/);
  assert.match(source, /PRODUCT_INTEGRATION_CATALOG\.get/);
  assert.match(source, /loadHostDeploymentManifest\(selected\.manifestPath\)/);
  assert.match(
    source,
    /from "\.\.\/continuity-semantic-production-coordinator\/continuity-semantic-production-coordinator\.js"/,
  );
  assert.doesNotMatch(source, /continuity-semantic-production-coordinator\.internal\.js/);
});
