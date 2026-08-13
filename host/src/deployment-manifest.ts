import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

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
const MAX_BYTES = 65_536;
const MAX_DEPTH = 32;
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
  let source: string;
  try {
    source = await readBoundedManifestSource(resolve(manifestPath));
  } catch {
    throw invalid();
  }
  if (hasDuplicateKeysOrInvalidJson(source)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
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

async function readBoundedManifestSource(sourcePath: string): Promise<string> {
  const handle = await open(sourcePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > MAX_BYTES) throw invalid();

    // Never size this allocation from filesystem metadata: a racing writer must
    // not be able to turn the manifest read into an unbounded allocation.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    const after = await handle.stat();
    if (!after.isFile() || bytesRead > MAX_BYTES || bytesRead !== before.size || after.size !== before.size)
      throw invalid();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
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
    if (depth > MAX_DEPTH) throw new Error("json_depth");
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
