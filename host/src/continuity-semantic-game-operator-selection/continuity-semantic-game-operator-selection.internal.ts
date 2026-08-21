import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  type ConstructedUnmountedGameSemanticFacade,
  constructKnownUnmountedGameSemanticFacade,
} from "../continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.js";
import { createGameRuntimeBinding } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import {
  createHostGameRuntimeMaterializer,
  type HostGameRuntimeMaterializerOptions,
} from "../continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import { createKnownSemanticGameProductionAuthorityFromDeploymentManifest } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import type { ConfigurableIntegrationLauncher } from "../integration-catalog.js";
import { PRODUCT_INTEGRATION_CATALOG } from "../integration-catalog-product.js";
import { readStrictJsonFile } from "../strict-json-reader.js";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TOP_LEVEL_KEYS = ["schemaVersion", "manifestPath", "integrationId", "integration"] as const;

/**
 * Operator-controlled input for the future semantic Game entry composition.
 * It deliberately contains no player/companion/continuity/world/owner/runtime
 * authority: those facts remain manifest-, adapter-, and S4b-owned.
 */
type HostSemanticGameOperatorConfig = Readonly<{
  schemaVersion: 1;
  manifestPath: string;
  integrationId: string;
  integration: unknown;
}>;

/** Construction-owned adapter selection. Its opaque config has no consumer export. */
export type HostGameRuntimeConstructionOptions = HostGameRuntimeMaterializerOptions;

type HostOwnedGameIntegrationSelection = Readonly<{
  manifestPath: string;
  launcher: ConfigurableIntegrationLauncher;
  launcherConfig: unknown;
  configDirectory: string;
}>;

/**
 * Loads the only operator configuration accepted by the semantic Game
 * construction root. Product selection is closed over the compiled catalog;
 * callers cannot inject a launcher or a pre-prepared adapter configuration.
 */
async function selectHostOwnedGameIntegration(operatorConfigPath: string): Promise<HostOwnedGameIntegrationSelection> {
  const loaded = await loadHostSemanticGameOperatorConfig(operatorConfigPath);
  const launcher = PRODUCT_INTEGRATION_CATALOG.get(loaded.config.integrationId);
  if (launcher === undefined) throw new Error("semantic_game_operator_integration_not_registered");
  return Object.freeze({
    manifestPath: loaded.config.manifestPath,
    launcher,
    launcherConfig: loaded.config.integration,
    configDirectory: loaded.configDirectory,
  });
}

/**
 * The sole consumer-facing Game construction port. It receives only a strict
 * operator-owned file path; all adapter selection and launch configuration
 * remain internal. This is not an entrypoint and does not provision, recover,
 * or fall back to legacy authority.
 */
export async function createKnownSemanticGameFacadeFromOperatorConfig(
  operatorConfigPath: string,
  options: HostGameRuntimeConstructionOptions = {},
): Promise<ConstructedUnmountedGameSemanticFacade> {
  const selected = await selectHostOwnedGameIntegration(operatorConfigPath);
  const manifest = await loadHostDeploymentManifest(selected.manifestPath);
  const binding = await createGameRuntimeBinding(
    Object.freeze({
      manifest,
      launcher: selected.launcher,
      launcherConfig: selected.launcherConfig,
      configDirectory: selected.configDirectory,
    }),
  );
  try {
    const game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
    return constructKnownUnmountedGameSemanticFacade(binding, game, createHostGameRuntimeMaterializer(options));
  } catch (error) {
    try {
      await binding.close();
    } catch {
      /* preserve primary construction failure */
    }
    throw error;
  }
}

/**
 * Recovery composition deliberately owns only the durable Game authority. It
 * parses the identical operator and deployment inputs as normal composition,
 * but never selects an adapter or creates a runtime binding. Consequently old
 * owner proof and durable recovery complete before any launcher side effect
 * could be introduced.
 */
export type SemanticGameDeadOwnerRecoveryFacade = Readonly<{
  recoverDeadOwner(input: Readonly<{ request: "recover_dead_owner"; operationId: string }>): Promise<void>;
  close(): Promise<void>;
}>;

export async function createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig(
  operatorConfigPath: string,
): Promise<SemanticGameDeadOwnerRecoveryFacade> {
  const loaded = await loadHostSemanticGameOperatorConfig(operatorConfigPath);
  const manifest = await loadHostDeploymentManifest(loaded.config.manifestPath);
  const game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
  return Object.freeze({
    recoverDeadOwner: async (input) => {
      await game.recoverDeadOwner(input);
    },
    close: async () => {
      await game.close();
    },
  });
}

/** Strict bounded operator-file parser; adapter configuration remains opaque. */
async function loadHostSemanticGameOperatorConfig(operatorConfigPath: string): Promise<
  Readonly<{
    config: HostSemanticGameOperatorConfig;
    configDirectory: string;
  }>
> {
  if (
    typeof operatorConfigPath !== "string" ||
    operatorConfigPath.length === 0 ||
    operatorConfigPath.includes("\0") ||
    !isAbsolute(operatorConfigPath)
  ) {
    throw new Error("invalid_semantic_game_operator_config");
  }
  const canonicalPath = await canonicalRegularFile(operatorConfigPath);
  let parsed: unknown;
  try {
    parsed = await readStrictJsonFile(canonicalPath);
  } catch {
    throw new Error("invalid_semantic_game_operator_config");
  }
  const value = exactObject(parsed, TOP_LEVEL_KEYS);
  if (
    value === null ||
    value.schemaVersion !== 1 ||
    !identifier(value.integrationId) ||
    !Object.hasOwn(value, "integration")
  ) {
    throw new Error("invalid_semantic_game_operator_config");
  }
  const manifestPath = await canonicalRegularFile(value.manifestPath);
  return Object.freeze({
    config: Object.freeze({
      schemaVersion: 1 as const,
      manifestPath,
      integrationId: value.integrationId,
      integration: value.integration,
    }),
    configDirectory: dirname(canonicalPath),
  });
}

async function canonicalRegularFile(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value))
    throw new Error("invalid_semantic_game_operator_config");
  try {
    const canonical = await realpath(resolve(value));
    if (!(await stat(canonical)).isFile()) throw new Error("not_file");
    return canonical;
  } catch {
    throw new Error("invalid_semantic_game_operator_config");
  }
}

function exactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    return null;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== allowed.length || !allowed.every((key) => names.includes(key))) return null;
  return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}
