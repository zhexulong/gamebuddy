import { lstat, readdir, readFile } from "node:fs/promises";

// Production-byte provenance is deliberately verified by the exact parent
// wrapper through PRE/POST generation rechecks, never by this child module
// consulting a mutable production inventory file.
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  inspectWindowsPathIdentityChain,
  type WindowsReparseInspectorCapability,
  type WindowsPathObjectIdentity,
} from "./windows-reparse-inspector/index.js";

export type StardewModPackageContract = Readonly<{
  schema: "gamebuddy-stardew-mod-package-contract/v1";
  descriptor: Readonly<{ kind: "verified_stardew_mod_package"; destination: "native/stardew-mod/GameBuddy"; project: string; manifest: "manifest.json" }>;
  entries: readonly [string, string, string, string, string];
  manifestIdentity: Readonly<Record<string, string>>;
  dependencyAuthority: Readonly<Record<string, unknown>>;
}>;

const contractFileName = "stardew-mod-package-contract.json";
const contractSchema = "gamebuddy-stardew-mod-package-contract/v1";

/** Reads and validates the fixed contract next to a published Host module. */
export async function readPublishedStardewModPackageContract(hostArtifactRoot: string): Promise<StardewModPackageContract> {
  try {
    if (!isAbsolute(hostArtifactRoot)) throw new Error();
    const path = resolve(hostArtifactRoot, contractFileName);
    if (!contained(hostArtifactRoot, path)) throw new Error();
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error();
    return parseContract(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw unavailable();
  }
}

/** Freshly verifies the one fixed package subtree. No caller supplies its path or descriptor. */
export async function verifyPublishedStardewModPackage(
  hostArtifactRoot: string,
  contract: StardewModPackageContract,
  inspector: WindowsReparseInspectorCapability,
): Promise<void> {
  try {
    const root = resolve(hostArtifactRoot, contract.descriptor.destination.replaceAll("/", sep));
    if (!contained(hostArtifactRoot, root)) throw new Error();
    await safeDirectory(hostArtifactRoot, root);
    await assertCleanIdentityChain(inspector, root, "directory");
    const entries = await readdir(root, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...contract.entries].sort())) throw new Error();
    for (const name of contract.entries) {
      const path = resolve(root, name);
      if (!contained(root, path)) throw new Error();
      const state = await lstat(path);
      if (!state.isFile() || state.isSymbolicLink()) throw new Error();
      await assertCleanIdentityChain(inspector, path, "regular_file");
    }
    const manifest = JSON.parse(await readFile(resolve(root, contract.descriptor.manifest), "utf8")) as unknown;
    if (!isRecord(manifest) || !exactEntries(manifest, contract.manifestIdentity)) throw new Error();
    const deps = JSON.parse(await readFile(resolve(root, "GameBuddy.Stardew.deps.json"), "utf8")) as unknown;
    validateDependencies(deps, contract.dependencyAuthority);
    // Byte provenance is intentionally owned by the wrapper's complete pinned
    // generation PRE/POST rechecks. This child-local verifier owns only the
    // package's fixed structure, path safety, readable files, manifest and
    // dependency semantics.
    for (const name of contract.entries) {
      const content = await readFile(resolve(root, name));
      if (content.length === 0) throw new Error();
    }
  } catch {
    throw unavailable();
  }
}

function parseContract(value: unknown): StardewModPackageContract {
  if (!isRecord(value) || value.schema !== contractSchema || !isRecord(value.descriptor) || !Array.isArray(value.entries)
    || !isRecord(value.manifestIdentity) || !isRecord(value.dependencyAuthority)
    || value.descriptor.kind !== "verified_stardew_mod_package" || value.descriptor.destination !== "native/stardew-mod/GameBuddy"
    || value.descriptor.manifest !== "manifest.json" || typeof value.descriptor.project !== "string"
    || value.entries.length !== 5 || new Set(value.entries).size !== 5 || value.entries.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry))) throw unavailable();
  return Object.freeze({
    schema: contractSchema,
    descriptor: Object.freeze({ kind: value.descriptor.kind, destination: value.descriptor.destination, project: value.descriptor.project, manifest: value.descriptor.manifest }),
    entries: Object.freeze([...value.entries]) as StardewModPackageContract["entries"],
    manifestIdentity: Object.freeze({ ...value.manifestIdentity } as Record<string, string>),
    dependencyAuthority: Object.freeze(value.dependencyAuthority),
  });
}

async function safeDirectory(root: string, path: string): Promise<void> {
  const segments = relative(root, path).split(sep);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    const state = await lstat(current);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error();
  }
}
function contained(root: string, value: string): boolean { const remainder = relative(root, value); return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactEntries(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean { const a = Object.keys(actual).sort(); const b = Object.keys(expected).sort(); return JSON.stringify(a) === JSON.stringify(b) && b.every((key) => actual[key] === expected[key]); }
function exactRuntimeEntries(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const keys = Object.keys(expected).sort();
  return JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(keys)
    && keys.every((key) => {
      const expectedValue = expected[key];
      return Array.isArray(expectedValue) && expectedValue.length === 0
        ? isRecord(actual[key]) && Object.keys(actual[key]).length === 0
        : JSON.stringify(actual[key]) === JSON.stringify(expectedValue);
    });
}
function exactKeys(actual: unknown, keys: unknown): actual is Record<string, unknown> {
  return isRecord(actual) && Array.isArray(keys) && keys.every((key) => typeof key === "string")
    && JSON.stringify(Object.keys(actual).sort()) === JSON.stringify([...keys].sort());
}
function validateDependencies(value: unknown, authority: Record<string, unknown>): void {
  if (!exactKeys(value, authority.rootKeys) || !isRecord(value.runtimeTarget) || !isRecord(authority.runtimeTarget)
    || value.runtimeTarget.name !== authority.runtimeTarget.name || value.runtimeTarget.signature !== authority.runtimeTarget.signature
    || !exactKeys(value.compilationOptions, authority.compilationOptionsKeys)
    || !isRecord(value.targets) || !exactKeys(value.targets, [authority.targetFramework])
    || !isRecord(value.libraries) || !exactKeys(value.libraries, authority.libraryKeys)
    || !isRecord(authority.packages) || !isRecord(value.targets[authority.targetFramework as string])) throw new Error();
  const target = value.targets[authority.targetFramework as string];
  if (!exactKeys(target, authority.targetKeys)) throw new Error();
  for (const key of authority.targetKeys as unknown[]) {
    if (typeof key !== "string" || !isRecord(authority.packages[key]) || !isRecord(target[key])) throw new Error();
    const rule = authority.packages[key]; const actual = target[key];
    if (!exactKeys(actual, rule.keys)) throw new Error();
    if (rule.dependencies !== undefined && (!isRecord(actual.dependencies) || !exactEntries(actual.dependencies, rule.dependencies as Record<string, unknown>))) throw new Error();
    if (rule.runtime !== undefined && (!isRecord(actual.runtime) || !exactRuntimeEntries(actual.runtime, rule.runtime as Record<string, unknown>))) throw new Error();
  }
}
async function assertCleanIdentityChain(inspector: WindowsReparseInspectorCapability, path: string, expectedLeaf: "directory" | "regular_file"): Promise<void> {
  const chain = await inspectWindowsPathIdentityChain(inspector, path);
  if (chain.length === 0 || chain.some((item) => item.isReparsePoint) || chain.some((item, index) => item.objectKind !== (index === chain.length - 1 ? expectedLeaf : "directory"))) throw new Error();
}
function unavailable(): Error { return new Error("stardew_published_mod_package_invalid"); }
