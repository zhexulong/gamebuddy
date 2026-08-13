import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { PRODUCT_INTEGRATION_CATALOG } from "../integration-catalog-product.js";
import { createGameRuntimeBinding } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import { createHostGameRuntimeMaterializer } from "../continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import { createKnownSemanticGameProductionAuthorityFromDeploymentManifest } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import {
  constructKnownUnmountedGameSemanticFacade,
  type ConstructedUnmountedGameSemanticFacade,
} from "../continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.js";
import type { ConfigurableIntegrationLauncher } from "../integration-catalog.js";

const MAX_BYTES = 65_536;
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
): Promise<ConstructedUnmountedGameSemanticFacade> {
  const selected = await selectHostOwnedGameIntegration(operatorConfigPath);
  const manifest = await loadHostDeploymentManifest(selected.manifestPath);
  const binding = await createGameRuntimeBinding(
    Object.freeze({
      manifestPath: selected.manifestPath,
      launcher: selected.launcher,
      launcherConfig: selected.launcherConfig,
      configDirectory: selected.configDirectory,
    }),
  );
  try {
    const game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
    return constructKnownUnmountedGameSemanticFacade(binding, game, createHostGameRuntimeMaterializer());
  } catch (error) {
    try {
      await binding.close();
    } catch {
      /* preserve primary construction failure */
    }
    throw error;
  }
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
  // JSON.parse must not get an opportunity to collapse duplicate decoded keys.
  const raw = await readBounded(canonicalPath);
  let parsed: unknown;
  if (hasDuplicateKeysOrInvalidJson(raw)) throw new Error("invalid_semantic_game_operator_config");
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_semantic_game_operator_config");
  }
  const value = exactObject(parsed, TOP_LEVEL_KEYS);
  if (
    value === null ||
    value.schemaVersion !== 1 ||
    !identifier(value.integrationId) ||
    !Object.prototype.hasOwnProperty.call(value, "integration")
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

async function readBounded(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > MAX_BYTES) throw new Error("invalid");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile() || bytesRead > MAX_BYTES || bytesRead !== before.size || after.size !== before.size)
      throw new Error("invalid");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
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

/** Parses JSON while rejecting duplicate decoded object keys before JSON.parse collapses them. */
function hasDuplicateKeysOrInvalidJson(source: string): boolean {
  let offset = 0;
  let duplicate = false;
  const whitespace = (): void => {
    while (offset < source.length && /\s/.test(source[offset]!)) offset += 1;
  };
  const string = (): string => {
    if (source[offset++] !== '"') throw new Error("json");
    let decoded = "";
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === '"') return decoded;
      if (character < " ") throw new Error("json");
      if (character !== "\\") {
        decoded += character;
        continue;
      }
      const escape = source[offset++];
      if (escape === '"' || escape === "\\" || escape === "/") decoded += escape;
      else if (escape === "b") decoded += "\b";
      else if (escape === "f") decoded += "\f";
      else if (escape === "n") decoded += "\n";
      else if (escape === "r") decoded += "\r";
      else if (escape === "t") decoded += "\t";
      else if (escape === "u") {
        const hex = source.slice(offset, offset + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("json");
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
      } else throw new Error("json");
    }
    throw new Error("json");
  };
  const value = (depth = 0): void => {
    if (depth > 32) throw new Error("json_depth");
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      whitespace();
      const names = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        whitespace();
        const name = string();
        if (names.has(name)) duplicate = true;
        else names.add(name);
        whitespace();
        if (source[offset++] !== ":") throw new Error("json");
        value(depth + 1);
        whitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset++] !== ",") throw new Error("json");
      }
    }
    if (source[offset] === "[") {
      offset += 1;
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset++] !== ",") throw new Error("json");
      }
    }
    if (source[offset] === '"') {
      string();
      return;
    }
    const literal = /^(?:true|false|null)(?![A-Za-z0-9_$])/.exec(source.slice(offset));
    if (literal) {
      offset += literal[0].length;
      return;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(offset));
    if (number) {
      offset += number[0].length;
      return;
    }
    throw new Error("json");
  };
  try {
    whitespace();
    value();
    whitespace();
    return duplicate || offset !== source.length;
  } catch {
    return true;
  }
}
