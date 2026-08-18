import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { readStrictJsonFile } from "./strict-json-reader.js";

export const DEPLOYMENT_MANIFEST_SCHEMA_VERSION = 2 as const;
export const DEPLOYMENT_MANIFEST_TOPOLOGY = "independent_chat_and_game_surfaces" as const;

export type DeploymentPrincipal = Readonly<{
  continuityId: string;
  companionId: string;
  playerId: string;
}>;

export type HostDeploymentManifest = Readonly<{
  schemaVersion: typeof DEPLOYMENT_MANIFEST_SCHEMA_VERSION;
  topology: typeof DEPLOYMENT_MANIFEST_TOPOLOGY;
  runtimeRoot: string;
  principal: DeploymentPrincipal;
  bootstrapOperationId: string;
  authorityGeneration: number;
}>;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "topology",
  "runtimeRoot",
  "principal",
  "bootstrapOperationId",
  "authorityGeneration",
] as const;
const PRINCIPAL_KEYS = ["continuityId", "companionId", "playerId"] as const;

/**
 * Loads the operator-provided, versioned deployment identity shared by future
 * Host entrypoints. This module deliberately has no entrypoint, browser,
 * integration, runtime, or continuity-store dependency.
 */
export async function loadHostDeploymentManifest(manifestPath: string): Promise<HostDeploymentManifest> {
  if (typeof manifestPath !== "string" || manifestPath.length === 0 || manifestPath.includes("\0")) throw invalid();
  let parsed: unknown;
  try {
    parsed = await readStrictJsonFile(resolve(manifestPath));
  } catch {
    throw invalid();
  }
  const raw = exactDataObject(parsed, TOP_LEVEL_KEYS);
  if (!raw) throw invalid();
  if (
    raw.schemaVersion !== DEPLOYMENT_MANIFEST_SCHEMA_VERSION ||
    raw.topology !== DEPLOYMENT_MANIFEST_TOPOLOGY ||
    !identifier(raw.bootstrapOperationId) ||
    !positiveSafeInteger(raw.authorityGeneration)
  )
    throw invalid();
  const principal = exactDataObject(raw.principal, PRINCIPAL_KEYS);
  if (
    !principal ||
    !identifier(principal.continuityId) ||
    !identifier(principal.companionId) ||
    !identifier(principal.playerId)
  )
    throw invalid();
  const runtimeRoot = await canonicalDirectory(raw.runtimeRoot);
  return Object.freeze({
    schemaVersion: DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    topology: DEPLOYMENT_MANIFEST_TOPOLOGY,
    runtimeRoot,
    principal: Object.freeze({
      continuityId: principal.continuityId,
      companionId: principal.companionId,
      playerId: principal.playerId,
    }),
    bootstrapOperationId: raw.bootstrapOperationId,
    authorityGeneration: raw.authorityGeneration,
  });
}

async function canonicalDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) throw invalid();
  try {
    const normalized = resolve(value);
    const canonical = await realpath(normalized);
    if (!isAbsolute(canonical) || !(await stat(canonical)).isDirectory()) throw invalid();
    return canonical;
  } catch {
    throw invalid();
  }
}

function exactDataObject(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(descriptors);
  if (names.length !== allowed.length || !allowed.every((key) => names.includes(key))) return null;
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true ||
      descriptor.writable !== true
    )
      return null;
    result[key] = descriptor.value;
  }
  return result;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}
function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function invalid(): Error {
  return new Error("invalid_host_deployment_manifest");
}
