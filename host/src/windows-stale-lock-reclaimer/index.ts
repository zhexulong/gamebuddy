import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReclaimerCapability,
  reclaimerState,
  type ReclaimerState,
  type SpawnHelper,
  type WindowsStaleLockReclaimerCapability,
} from "./internal.js";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(modulePath), "..", "..");
const helperFileName = "GameBuddy.WindowsStaleLockReclaimer.exe";
const manifestFileName = "windows-stale-lock-reclaimer.manifest.json";
const protocolVersion = 1;
const rid = "win-x64";
const timeoutMs = 5_000;
const outputLimitBytes = 64 * 1024;
/** Fixed artifact-relative pair destination of the selected Host-TCB production generation. */
const pairDestination = `native/windows-stale-lock-reclaimer/${rid}`;
const inventoryFileName = "production-inventory.json";
const inventorySchema = "gamebuddy-host-production-inventory/v4";
const inventoryOriginKind = "verified_windows_stale_lock_reclaimer";

export type WindowsStaleLockReclaimPolicy = "stale_malformed" | "stale_valid_dead";
export type WindowsStaleLockReclaimCategory =
  | "reclaimed"
  | "missing"
  | "kept_malformed_fresh"
  | "kept_valid_fresh"
  | "kept_policy_mismatch"
  | "kept_identity_changed"
  | "kept_path_replaced"
  | "kept_not_regular"
  | "indeterminate";
export type WindowsStaleLockReleaseCategory = "released" | "missing" | "kept_token_mismatch" | "kept_not_regular" | "indeterminate";
export type WindowsStaleLockReclaimerRequest = Readonly<
  | { schemaVersion: 1; operation: "reclaim_stale_lock"; policy: WindowsStaleLockReclaimPolicy; root: string; segments: readonly string[] }
  | { schemaVersion: 1; operation: "release_owned_lock"; token: string; root: string; segments: readonly string[] }
>;
export type { WindowsStaleLockReclaimerCapability } from "./internal.js";

const RECLAIM_CATEGORIES: ReadonlySet<string> = new Set([
  "reclaimed", "missing", "kept_malformed_fresh", "kept_valid_fresh", "kept_policy_mismatch",
  "kept_identity_changed", "kept_path_replaced", "kept_not_regular", "indeterminate",
]);
const RELEASE_CATEGORIES: ReadonlySet<string> = new Set([
  "released", "missing", "kept_token_mismatch", "kept_not_regular", "indeterminate",
]);

/** Mints the build-only capability from the sole repository-relative helper pair. */
export async function createBuildWindowsStaleLockReclaimer(): Promise<WindowsStaleLockReclaimerCapability> {
  const pairRoot = resolve(repositoryRoot, "native", "windows-stale-lock-reclaimer", ".dist", rid);
  return await createFixedReclaimer(pairRoot, pairRoot, undefined);
}

/**
 * Mints the published-artifact capability from the sole fixed internal helper
 * pair of the selected Host-TCB production generation. The generation
 * inventory must declare the exact pair with the verified construction origin;
 * without that deployment binding the published capability is unavailable. The
 * capability captures no unchecked pathname: the complete pair is revalidated
 * immediately before every spawn. This does not claim isolation from a
 * malicious principal able to modify the Host deployment TCB after that check.
 */
export async function createPublishedWindowsStaleLockReclaimer(
  hostArtifactRoot: string,
): Promise<WindowsStaleLockReclaimerCapability> {
  if (!isAbsolute(hostArtifactRoot)) throw unavailable();
  if (process.platform !== "win32") return createReclaimerCapability({ executable: "", spawnHelper: unavailableSpawn });
  return await createFixedReclaimer(
    resolve(hostArtifactRoot, pairDestination),
    hostArtifactRoot,
    resolve(hostArtifactRoot, inventoryFileName),
  );
}

/**
 * Fixed default production policy. It accepts only the strictly verified helper
 * pair co-located with this emitted adapter's artifact root. Repository build
 * pairs are available exclusively through the explicit build/test minting API;
 * a missing or tampered published pair makes the caller fail closed.
 */
export async function requestWindowsStaleLockReclaimer(): Promise<WindowsStaleLockReclaimerCapability | undefined> {
  if (process.platform !== "win32" || process.arch !== "x64") return undefined;
  const published = await createPublishedWindowsStaleLockReclaimer(resolve(dirname(modulePath), "..")).catch(() => undefined);
  if (published !== undefined) return published;
  return await createBuildWindowsStaleLockReclaimer().catch(() => undefined);
}

/**
 * Invokes the fixed `reclaim_stale_lock` operation on one drive-rooted `.lock`
 * leaf through an opaque capability. The capability owns the helper path; this
 * function derives the frozen drive root plus literal safe relative segments
 * from the absolute lock path and sends the exact root/segments request.
 * Unsupported paths (relative, UNC, extended-length, device, wildcard, dot,
 * dot-dot, empty or reserved forms, non-`.lock` leaf) fail closed before any
 * helper spawn.
 */
export async function reclaimStaleLock(
  capability: WindowsStaleLockReclaimerCapability,
  absolutePath: string,
  policy: WindowsStaleLockReclaimPolicy,
): Promise<WindowsStaleLockReclaimCategory> {
  const { root, segments } = deriveRootAndSegments(absolutePath);
  const state = reclaimerState(capability);
  if (state === undefined || (process.platform !== "win32" && state.reclaimOnNonWindows !== true)) throw unavailable();
  const category = await runOperation(state, { schemaVersion: 1, operation: "reclaim_stale_lock", policy, root, segments });
  if (!RECLAIM_CATEGORIES.has(category)) throw unavailable();
  return category as WindowsStaleLockReclaimCategory;
}

/**
 * Invokes the fixed `release_owned_lock` operation with the exact owning UUID
 * token. The helper deletes only the object whose bytes, read through its own
 * opened HANDLE, still prove that token. The same frozen root/segments
 * derivation and pre-spawn rejection apply.
 */
export async function releaseOwnedLock(
  capability: WindowsStaleLockReclaimerCapability,
  absolutePath: string,
  token: string,
): Promise<WindowsStaleLockReleaseCategory> {
  const { root, segments } = deriveRootAndSegments(absolutePath);
  const state = reclaimerState(capability);
  if (state === undefined || (process.platform !== "win32" && state.reclaimOnNonWindows !== true)) throw unavailable();
  const category = await runOperation(state, { schemaVersion: 1, operation: "release_owned_lock", token, root, segments });
  if (!RELEASE_CATEGORIES.has(category)) throw unavailable();
  return category as WindowsStaleLockReleaseCategory;
}

/** Complete canonical pair facts a minted capability revalidates before every spawn. */
type FixedPairFacts = Readonly<{
  root: string;
  pairRoot: string;
  executable: string;
  manifest: string;
  sha256: string;
  inventoryPath: string | undefined;
}>;

/** Mints one capability over the canonical pair, capturing only facts that are
 * re-verified immediately before each spawn. The digest is derived from the
 * pair bytes at mint time; the same synchronous verification runs at spawn. */
async function createFixedReclaimer(
  pairRoot: string,
  root: string,
  inventoryPath: string | undefined,
): Promise<WindowsStaleLockReclaimerCapability> {
  if (process.platform !== "win32") return createReclaimerCapability({ executable: "", spawnHelper: unavailableSpawn });
  if (process.arch !== "x64") throw unavailable();
  const executable = resolve(pairRoot, helperFileName);
  const manifest = resolve(pairRoot, manifestFileName);
  const facts = verifyFixedPair({ root, pairRoot, executable, manifest, inventoryPath });
  return createReclaimerCapability({ executable, spawnHelper: verifiedSpawn(facts) });
}

/** Returns a spawn helper that fails closed unless the complete canonical pair
 * still holds immediately before the pathname spawn: physical non-reparse
 * ancestor identity, regular pair files, byte-exact canonical manifest, helper
 * digest, and (production) the generation inventory declaration. The Host-TCB
 * deployment boundary owns any residual check-to-spawn same-principal race. */
function verifiedSpawn(facts: FixedPairFacts): SpawnHelper {
  return (command, args) => {
    if (command !== facts.executable) throw unavailable();
    verifyFixedPair(facts);
    return productionSpawn(command, args);
  };
}

/**
 * The one authoritative pair check. With `sha256` absent it derives and
 * returns the canonical facts (mint); with `sha256` present it revalidates
 * the complete pair (spawn). Every existing ancestor from `root` through the
 * pair directory and both pair files must be a regular non-reparse object
 * whose physical identity equals its canonical path; the manifest must
 * byte-exactly match the canonical manifest of the current helper digest; and
 * the production inventory must still declare the exact verified pair. Any
 * missing, changed, linked, reparse, or ambiguous object fails closed.
 */
function verifyFixedPair(input: Readonly<{
  root: string;
  pairRoot: string;
  executable: string;
  manifest: string;
  sha256?: string;
  inventoryPath: string | undefined;
}>): FixedPairFacts {
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
 * deployment generation and its verified construction origin. Missing,
 * replaced, or unproven inventory fails closed; it is not an ACL ownership
 * proof or a handle-bound executable launch primitive. */
function verifyInventorySync(raw: Buffer, helperSha256: string, manifestBytes: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw unavailable();
  }
  if (!isRecord(parsed) || parsed.schema !== inventorySchema || !Array.isArray(parsed.entries)) throw unavailable();
  const helperMatches = parsed.entries.filter((entry) => isVerifiedPairEntry(entry, `${pairDestination}/${helperFileName}`, helperSha256));
  const manifestMatches = parsed.entries.filter((entry) => isVerifiedPairEntry(entry, `${pairDestination}/${manifestFileName}`, helperSha256));
  if (helperMatches.length !== 1 || manifestMatches.length !== 1) throw unavailable();
  if (helperMatches[0]!.sha256 !== helperSha256) throw unavailable();
  if (manifestMatches[0]!.sha256 !== createHash("sha256").update(manifestBytes).digest("hex")) throw unavailable();
}

type InventoryEntry = Readonly<Record<string, unknown>>;

function isVerifiedPairEntry(entry: unknown, path: string, helperSha256: string): entry is InventoryEntry {
  return isRecord(entry)
    && entry.path === path
    && entry.type === "file"
    && typeof entry.sha256 === "string"
    && isVerifiedPairOrigin(entry.origin, helperSha256);
}

function isVerifiedPairOrigin(origin: unknown, helperSha256: string): boolean {
  return isRecord(origin)
    && origin.kind === inventoryOriginKind
    && origin.destination === pairDestination
    && origin.helper === helperFileName
    && origin.manifest === manifestFileName
    && origin.helperSha256 === helperSha256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runOperation(state: ReclaimerState, request: WindowsStaleLockReclaimerRequest): Promise<string> {
  const serialized = Buffer.from(JSON.stringify(request), "utf8");
  if (serialized.length > outputLimitBytes) throw unavailable();
  return await new Promise<string>((resolveOperation, rejectOperation) => {
    let child: ChildProcess;
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const finish = (category?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectOperation(error); else resolveOperation(category!);
    };
    const overflow = () => { child.kill(); finish(undefined, unavailable()); };
    let timer: ReturnType<typeof setTimeout>;
    try { child = state.spawnHelper(state.executable, []); }
    catch { rejectOperation(unavailable()); return; }
    timer = setTimeout(() => { child.kill(); finish(undefined, unavailable()); }, timeoutMs);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimitBytes) return overflow();
      target.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", () => finish(undefined, unavailable()));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null || Buffer.concat(stderr).length !== 0) return finish(undefined, unavailable());
      const category = parseResponse(Buffer.concat(stdout));
      finish(category, category === undefined ? unavailable() : undefined);
    });
    child.stdin?.once("error", () => finish(undefined, unavailable()));
    child.stdin?.end(serialized);
  });
}

function parseResponse(value: Buffer): string | undefined {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value); } catch { return undefined; }
  const match = /^\{"schemaVersion":1,"result":"([a-z_]+)"\}\n$/.exec(text);
  return match === null ? undefined : match[1];
}

/**
 * Derives the frozen root/segments request tuple from one absolute lock path
 * and rejects every unsupported form before any helper spawn. On Windows only
 * an exact drive-rooted path (`C:\...` or `C:/...`) is admitted and root is
 * the canonical `X:\`; UNC, extended-length, device, drive-relative and every
 * other root form fail closed. On non-Windows only the test-only admission
 * (POSIX absolute path, root `/`) can reach this helper, with the same literal
 * safe segment rules.
 */
const WIN32_DRIVE_ROOT_PATTERN = /^([A-Za-z]:)[\\/]/;
const UNSAFE_SEGMENT_PATTERN = /[\\/:*?"<>|]/;
const RESERVED_SEGMENT_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  "CONIN$", "CONOUT$",
]);

function deriveRootAndSegments(absolutePath: string): { root: string; segments: readonly string[] } {
  let root: string;
  let remainder: string;
  if (process.platform === "win32") {
    const match = WIN32_DRIVE_ROOT_PATTERN.exec(absolutePath);
    if (match === null) throw unavailable();
    root = `${match[1]}\\`;
    remainder = absolutePath.slice(match[0].length);
  } else {
    if (!absolutePath.startsWith("/")) throw unavailable();
    root = "/";
    remainder = absolutePath.slice(1);
  }
  const rawSegments = remainder.split(/[\\/]+/);
  if (rawSegments.length === 0 || rawSegments.some((segment) => !isSafeSegment(segment))) throw unavailable();
  const segments = Object.freeze(rawSegments);
  if (!segments[segments.length - 1]!.toLowerCase().endsWith(".lock")) throw unavailable();
  return { root, segments };
}

/** One literal safe component: non-empty, no dot/dot-dot, no separator,
 * wildcard, colon or reserved-device alias, and no trailing dot/space that
 * Windows would silently strip. Mirrors the native helper's frozen grammar. */
function isSafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment === "." || segment === "..") return false;
  if (segment.includes("\0") || UNSAFE_SEGMENT_PATTERN.test(segment)) return false;
  if (segment.endsWith(" ") || segment.endsWith(".")) return false;
  const baseName = segment.split(".")[0]!;
  return !(baseName.length > 0 && RESERVED_SEGMENT_NAMES.has(baseName.toUpperCase()));
}

function productionSpawn(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}
function unavailableSpawn(): ChildProcess { throw unavailable(); }
function unavailable(): Error { return new Error("windows_stale_lock_reclaimer_unavailable"); }
