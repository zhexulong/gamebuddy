import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MANIFEST_FILE = "payload-manifest.json";
const MANIFEST_SCHEMA = "gamebuddy-smapi-payload-manifest/v1";
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

const SMAPI_PAYLOAD_DESTINATION = "native/smapi";
const SMAPI_PAYLOAD_LOADER_FILE = "StardewModdingAPI.exe";

type SmapiPayloadFile = Readonly<{ path: string; size: number; sha256: string }>;

/**
 * The verified SMAPI payload one generation ships.
 *
 * `root` is the absolute directory holding the payload files; `files` is the payload's
 * own complete file set with the bytes' digests, read from the manifest this payload was
 * published with. Nothing here is caller-supplied: a generation either carries a payload
 * the manifest describes exactly, or there is no payload.
 *
 * `playerOwnedFiles` names the payload entries SMAPI itself treats as the player's
 * settings. They are written only when absent, so a one-click install never resets a
 * configuration the player has already changed.
 */
export type SmapiPayload = Readonly<{
  version: string;
  root: string;
  files: readonly SmapiPayloadFile[];
  playerOwnedFiles: readonly string[];
  licensePath: string;
}>;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contained(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

/** One regular, symlink-free file: the only shape a payload entry may have. */
async function regularFileOrUndefined(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const state = await lstat(path);
    return state.isFile() && !state.isSymbolicLink() ? state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads and verifies the SMAPI payload from an immutable published generation.
 *
 * The payload is the directory's authority: the manifest names the exact complete file
 * set, and every listed entry is re-read here, so a payload that gained, lost or altered
 * a file is refused instead of being copied into a player's game folder. The directory
 * itself must also hold nothing beyond the declared set, which is what makes "the file
 * list is the payload" true rather than aspirational.
 */
export async function readSmapiPayload(artifactRoot: string): Promise<SmapiPayload> {
  if (typeof artifactRoot !== "string" || !isAbsolute(artifactRoot)) throw payloadUnavailable();
  const payloadRoot = resolve(artifactRoot, SMAPI_PAYLOAD_DESTINATION);
  try {
    const manifestState = await regularFileOrUndefined(resolve(payloadRoot, MANIFEST_FILE));
    if (manifestState === undefined) throw payloadUnavailable();
    const manifest = JSON.parse(await readFile(resolve(payloadRoot, MANIFEST_FILE), "utf8")) as unknown;
    if (!isRecord(manifest)) throw payloadUnavailable();
    if (
      manifest.schema !== MANIFEST_SCHEMA ||
      typeof manifest.version !== "string" ||
      !VERSION.test(manifest.version) ||
      typeof manifest.root !== "string" ||
      !SAFE_RELATIVE_PATH.test(manifest.root) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length === 0 ||
      !isRecord(manifest.license) ||
      typeof manifest.license.file !== "string" ||
      !SAFE_RELATIVE_PATH.test(manifest.license.file) ||
      typeof manifest.license.sha256 !== "string" ||
      !SHA256.test(manifest.license.sha256) ||
      (manifest.playerOwnedFiles !== undefined && !Array.isArray(manifest.playerOwnedFiles))
    )
      throw payloadUnavailable();

    const files: SmapiPayloadFile[] = [];
    const seen = new Set<string>();
    for (const entry of manifest.files as unknown[]) {
      if (!isRecord(entry)) throw payloadUnavailable();
      const path = entry.path;
      if (typeof path !== "string" || !SAFE_RELATIVE_PATH.test(path)) throw payloadUnavailable();
      if (seen.has(path)) throw payloadUnavailable();
      seen.add(path);
      if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) throw payloadUnavailable();
      if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0)
        throw payloadUnavailable();
      files.push(Object.freeze({ path, size: entry.size, sha256: entry.sha256 }));
    }
    if (!seen.has(SMAPI_PAYLOAD_LOADER_FILE)) throw payloadUnavailable();

    const playerOwnedFiles: string[] = [];
    for (const entry of (manifest.playerOwnedFiles as unknown[] | undefined) ?? []) {
      if (typeof entry !== "string" || !seen.has(entry)) throw payloadUnavailable();
      playerOwnedFiles.push(entry);
    }

    const payloadFilesRoot = resolve(payloadRoot, manifest.root);
    const actual = (await listRelativeFiles(payloadFilesRoot)).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...seen].sort())) throw payloadUnavailable();
    for (const file of files) {
      const path = resolve(payloadFilesRoot, file.path);
      if (!contained(payloadFilesRoot, path)) throw payloadUnavailable();
      const state = await regularFileOrUndefined(path);
      if (state === undefined || state.size !== file.size) throw payloadUnavailable();
      if (sha256(await readFile(path)) !== file.sha256) throw payloadUnavailable();
    }

    const licensePath = resolve(payloadRoot, manifest.license.file);
    if (!contained(payloadRoot, licensePath)) throw payloadUnavailable();
    const license = await readFile(licensePath);
    if (sha256(license) !== manifest.license.sha256) throw payloadUnavailable();
    if (
      !license.includes(Buffer.from("GNU LESSER GENERAL PUBLIC LICENSE")) ||
      !license.includes(Buffer.from("Version 3, 29 June 2007"))
    )
      throw payloadUnavailable();

    return Object.freeze({
      version: manifest.version,
      root: payloadFilesRoot,
      files: Object.freeze(files),
      playerOwnedFiles: Object.freeze(playerOwnedFiles),
      licensePath,
    });
  } catch (error) {
    throw error instanceof Error && error.message === "smapi_payload_unavailable" ? error : payloadUnavailable();
  }
}

async function listRelativeFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw payloadUnavailable();
  }
  return files;
}

function payloadUnavailable(): Error {
  return new Error("smapi_payload_unavailable");
}
