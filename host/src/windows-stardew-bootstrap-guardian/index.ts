import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const helperFileName = "GameBuddy.WindowsStardewBootstrapGuardian.exe";
const manifestFileName = "windows-stardew-bootstrap-guardian.manifest.json";
const protocolVersion = 1;
const rid = "win-x64";
/** Fixed artifact-relative pair destination of the selected Host-TCB production generation. */
const pairDestination = `native/windows-stardew-bootstrap-guardian/${rid}`;
const inventoryFileName = "production-inventory.json";
const inventorySchema = "gamebuddy-host-production-inventory/v4";
const inventoryOriginKind = "verified_windows_stardew_bootstrap_guardian";

import {
  validateGuardianRequest,
  type ArmAttemptRequest,
  type ContainRoleRequest,
  type LaunchRoleRequest,
  type RecoverAttemptRequest,
  type WindowsStardewBootstrapGuardianCategory,
  type WindowsStardewBootstrapGuardianRequest,
} from "./protocol.js";
export type {
  ArmAttemptRequest,
  ContainRoleRequest,
  LaunchRoleRequest,
  RecoverAttemptRequest,
  WindowsStardewBootstrapGuardianCategory,
  WindowsStardewBootstrapGuardianRequest,
} from "./protocol.js";

export type WindowsStardewBootstrapGuardianCapability = object;
const capabilities = new WeakSet<object>();
const states = new WeakMap<object, FixedPairFacts>();

/**
 * Mints the published-artifact capability from the sole fixed internal helper
 * pair of the selected Host-TCB production generation. The generation
 * inventory must declare the exact pair with the verified construction origin;
 * without that deployment binding the published capability is unavailable. The
 * capability captures no unchecked native execution authority. Task 1 has a
 * separately verified resident native Job/lease owner, but this public adapter
 * still only revalidates the complete pair and request, then remains unavailable
 * until the native Desktop generation launcher predecessor owns that process.
 */
export async function createPublishedWindowsStardewBootstrapGuardian(
  hostArtifactRoot: string,
): Promise<WindowsStardewBootstrapGuardianCapability> {
  if (!isAbsolute(hostArtifactRoot)) throw unavailable();
  if (process.platform !== "win32") throw unavailable();
  return await createFixedGuardian(
    resolve(hostArtifactRoot, pairDestination),
    hostArtifactRoot,
    resolve(hostArtifactRoot, inventoryFileName),
  );
}

/**
 * Freeze-the-protocol `arm_attempt`. The request carries only the opaque
 * guardian instance/epoch correlation; it never receives or exposes the
 * guardian lease locator, role Job names, or any public identity. Any unknown
 * or sensitive field (path, PID, token, bridge, lease substitution) is
 * rejected before this public adapter can invoke any native authority. Task 1
 * deliberately gives this adapter no resident-process launch seam, so every
 * admitted request still reports the fixed redacted `kept_unavailable` category.
 */
export async function armAttempt(
  capability: WindowsStardewBootstrapGuardianCapability,
  request: ArmAttemptRequest,
): Promise<WindowsStardewBootstrapGuardianCategory> {
  return await invokeGuardian(capability, request);
}

export async function launchRole(
  capability: WindowsStardewBootstrapGuardianCapability,
  request: LaunchRoleRequest,
): Promise<WindowsStardewBootstrapGuardianCategory> {
  return await invokeGuardian(capability, request);
}

export async function containRole(
  capability: WindowsStardewBootstrapGuardianCapability,
  request: ContainRoleRequest,
): Promise<WindowsStardewBootstrapGuardianCategory> {
  return await invokeGuardian(capability, request);
}

export async function recoverAttempt(
  capability: WindowsStardewBootstrapGuardianCapability,
  request: RecoverAttemptRequest,
): Promise<WindowsStardewBootstrapGuardianCategory> {
  return await invokeGuardian(capability, request);
}

/** Complete canonical pair facts a minted capability revalidates before every operation. */
type FixedPairFacts = Readonly<{
  root: string;
  pairRoot: string;
  executable: string;
  manifest: string;
  sha256: string;
  inventoryPath: string | undefined;
}>;

/** Mints one capability over the canonical pair, capturing only facts that are
 * re-verified immediately before each operation. The digest is derived from the
 * pair bytes at mint time; the same synchronous verification runs for every
 * public-adapter operation before the fixed unavailable result is returned. */
async function createFixedGuardian(
  pairRoot: string,
  root: string,
  inventoryPath: string | undefined,
): Promise<WindowsStardewBootstrapGuardianCapability> {
  if (process.platform !== "win32") throw unavailable();
  if (process.arch !== "x64") throw unavailable();
  const executable = resolve(pairRoot, helperFileName);
  const manifest = resolve(pairRoot, manifestFileName);
  const facts = verifyFixedPair({ root, pairRoot, executable, manifest, inventoryPath });
  return mintGuardianCapability(facts);
}

/**
 * The one authoritative pair check. With `sha256` absent it derives and
 * returns the canonical facts (mint); with `sha256` present it revalidates
 * the complete pair (operation). Every existing ancestor from `root` through the
 * pair directory and both pair files must be a regular non-reparse object
 * whose physical identity equals its canonical path; the manifest must
 * byte-exactly match the canonical manifest of the current helper digest; and
 * the production inventory must still declare the exact verified pair. Any
 * missing, changed, linked, reparse, or ambiguous object fails closed.
 */
function verifyFixedPair(
  input: Readonly<{
    root: string;
    pairRoot: string;
    executable: string;
    manifest: string;
    sha256?: string;
    inventoryPath: string | undefined;
  }>,
): FixedPairFacts {
  verifyDirectoryChainSync(input.root, input.pairRoot);
  verifyRegularSync(input.executable);
  verifyRegularSync(input.manifest);
  const manifest = readBytesSync(input.manifest);
  const binary = readBytesSync(input.executable);
  const sha256 = createHash("sha256").update(binary).digest("hex");
  if (input.sha256 !== undefined && sha256 !== input.sha256) throw unavailable();
  if (!manifest.equals(Buffer.from(canonicalManifest(sha256), "utf8"))) throw unavailable();
  if (input.inventoryPath !== undefined) {
    verifyRegularSync(input.inventoryPath);
    verifyInventorySync(readBytesSync(input.inventoryPath), sha256, manifest);
  }
  return Object.freeze({
    root: input.root,
    pairRoot: input.pairRoot,
    executable: input.executable,
    manifest: input.manifest,
    sha256,
    inventoryPath: input.inventoryPath,
  });
}

function canonicalManifest(sha256: string): string {
  return `{"schemaVersion":1,"protocolVersion":${protocolVersion},"rid":"${rid}","helperFileName":"${helperFileName}","sha256":"${sha256}"}\n`;
}

/** Walks every existing ancestor from `root` through `target`, requiring each
 * to be a real non-reparse directory whose physical identity equals its
 * canonical path. A lexical `relative()` containment check alone is not
 * sufficient; this physical walk is the provenance proof. */
function verifyDirectoryChainSync(root: string, target: string): void {
  verifyDirectorySync(root);
  const remainder = relative(root, target);
  if (remainder === "") return;
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw unavailable();
  let cursor = root;
  for (const item of remainder.split(sep)) {
    cursor = resolve(cursor, item);
    verifyDirectorySync(cursor);
  }
}

function verifyDirectorySync(path: string): void {
  const state = safeLstatSync(path);
  if (state === undefined || !state.isDirectory() || state.isSymbolicLink()) throw unavailable();
  verifyPhysicalIdentitySync(path);
}

function verifyRegularSync(path: string): void {
  const state = safeLstatSync(path);
  if (state === undefined || !state.isFile() || state.isSymbolicLink()) throw unavailable();
  verifyPhysicalIdentitySync(path);
}

function verifyPhysicalIdentitySync(path: string): void {
  let physical: string;
  try {
    physical = realpathSync(path);
  } catch {
    throw unavailable();
  }
  if (!samePhysicalPath(path, physical)) throw unavailable();
}

function safeLstatSync(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function readBytesSync(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw unavailable();
  }
}

function samePhysicalPath(left: string, right: string): boolean {
  const a = resolve(left).replaceAll("\\", "/");
  const b = resolve(right).replaceAll("\\", "/");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The generation inventory binds this pair to the selected Host-TCB
 * deployment generation and its verified construction origin. The exact two
 * pair entries must each be present exactly once with the verified origin;
 * missing, replaced, or unproven entries fail closed. */
function verifyInventorySync(raw: Buffer, helperSha256: string, manifestBytes: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw unavailable();
  }
  if (!isRecord(parsed) || parsed.schema !== inventorySchema || !Array.isArray(parsed.entries)) throw unavailable();
  const helperPath = `${pairDestination}/${helperFileName}`;
  const manifestPath = `${pairDestination}/${manifestFileName}`;
  if (parsed.entries.filter((entry) => entry?.path === helperPath).length !== 1
    || parsed.entries.filter((entry) => entry?.path === manifestPath).length !== 1) throw unavailable();
  const helperMatches = parsed.entries.filter((entry) =>
    isVerifiedPairEntry(entry, helperPath, helperSha256),
  );
  const manifestMatches = parsed.entries.filter((entry) =>
    isVerifiedPairEntry(entry, manifestPath, helperSha256),  );
  if (helperMatches.length !== 1 || manifestMatches.length !== 1) throw unavailable();
  if (helperMatches[0]!.sha256 !== helperSha256) throw unavailable();
  if (manifestMatches[0]!.sha256 !== createHash("sha256").update(manifestBytes).digest("hex")) throw unavailable();
}

type InventoryEntry = Readonly<Record<string, unknown>>;

function isVerifiedPairEntry(entry: unknown, path: string, helperSha256: string): entry is InventoryEntry {
  return (
    isRecord(entry) &&
    entry.path === path &&
    entry.type === "file" &&
    typeof entry.sha256 === "string" &&
    isVerifiedPairOrigin(entry.origin, helperSha256)
  );
}

function isVerifiedPairOrigin(origin: unknown, helperSha256: string): boolean {
  return (
    isRecord(origin) &&
    origin.kind === inventoryOriginKind &&
    origin.destination === pairDestination &&
    origin.helper === helperFileName &&
    origin.manifest === manifestFileName &&
    origin.helperSha256 === helperSha256
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


async function invokeGuardian(
  capability: WindowsStardewBootstrapGuardianCapability,
  request: WindowsStardewBootstrapGuardianRequest,
): Promise<WindowsStardewBootstrapGuardianCategory> {
  const facts = capability !== undefined && capabilities.has(capability) ? states.get(capability) : undefined;
  if (facts === undefined) throw unavailable();
  verifyFixedPair(facts);
  validateGuardianRequest(request);
  return "kept_unavailable";
}

function mintGuardianCapability(state: FixedPairFacts): WindowsStardewBootstrapGuardianCapability {
  const capability = Object.freeze({});
  capabilities.add(capability);
  states.set(capability, state);
  return capability;
}


function unavailable(): Error {
  return new Error("windows_stardew_bootstrap_guardian_unavailable");
}
