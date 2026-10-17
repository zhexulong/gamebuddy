import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile, verifySafePathBoundary, withPathLock } from "../../path-lock.js";
import { resolveRuntimePaths } from "../../runtime-identity.js";
import { ST_CARD_DECODER_LIMITS_V1 } from "../compatibility-manifest.v1.js";
import { resolveTavernPaths } from "../tavern-paths.js";

/**
 * A companion's picture, on disk and behind the runtime asset face.
 *
 * The bytes are the player's own card file, imported and then owned by the
 * companion's namespace: they are user data, not a build artifact, so this
 * module writes and reads them directly rather than going through the verified
 * static-artifact tree (which is frozen and hash-verified at build time).
 *
 * There is exactly one file name, one directory, and one format. The directory
 * is the companion's own `companionRoot`, derived from her identity exactly as
 * every other companion artifact is, so a handle the roster handed out names at
 * most the one picture belonging to the one companion that handle named.
 *
 * **Re-import, and what it leaves behind.** Importing the same card again
 * provisions a NEW companion: a new identity namespace, hence a new
 * `companionRoot`, hence a new picture. The previous companion's file is neither
 * overwritten (nothing is written to a namespace that already exists) nor deleted
 * - it lives exactly as long as the companion record it belongs to, because the
 * companion's directory is the unit of deletion and nothing here deletes one. So
 * no garbage collector is added for this file: a sweep would have to reason about
 * which companions are still reachable, while the directory already answers that
 * by existing or not. If a companion-delete operation is ever added, this picture
 * goes with the directory, and that operation - not this module - owns the
 * decision. (Nothing deletes a companion root today: the roster has no delete.)
 */
export const COMPANION_AVATAR_FILE_NAME = "avatar.png" as const;

/**
 * The avatar's size ceiling, and it is deliberately the card decoder's own
 * ceiling for a PNG card (`ST_CARD_DECODER_LIMITS_V1.inputBytesPng`) rather than
 * a second number. The avatar IS the card file's bytes - the picture and the
 * tEXt chunk that carries the card live in the same file - so the number that
 * bounds an importable card is the number that bounds its picture. A tighter
 * ceiling here would refuse to show a picture the import had already accepted;
 * a looser one would admit a file the decoder itself refuses.
 */
export const MAX_COMPANION_AVATAR_BYTES = ST_CARD_DECODER_LIMITS_V1.inputBytesPng;

const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10] as const);

/**
 * True when `bytes` is a structurally complete PNG container: the eight
 * signature bytes, an IHDR chunk first, and a chunk chain whose every declared
 * length stays inside the file and which reaches IEND.
 *
 * This is a container check, not a decode. The Host never inflates a player's
 * picture: pixels it cannot render are the UI's monogram fallback, which is an
 * ordinary state. What it does refuse is a file that is not a PNG at all - a
 * JSON card renamed `.png`, a truncated download, an arbitrary binary - so a
 * stored avatar is never something a browser has to guess at.
 */
export function isCompletePngFile(bytes: Uint8Array): boolean {
  // Signature (8) + a shortest possible IHDR chunk (12 + 13) + IEND (12).
  if (bytes.length < 8 + 25 + 12) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  let offset = PNG_SIGNATURE.length;
  let first = true;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (offset + 12 + length > bytes.length) return false;
    if (first && (type !== "IHDR" || length !== 13)) return false;
    first = false;
    offset += 12 + length;
    if (type === "IEND") return true;
  }
  return false;
}

export type CompanionAvatarOwner = Readonly<{ companionId: string; continuityId: string }>;

export type CompanionAvatarRead = Readonly<{ state: "present"; bytes: Buffer }> | Readonly<{ state: "absent" }>;

export type CompanionAvatarService = Readonly<{
  /**
   * The companion's picture. `null` means the handle names no companion this
   * Host's roster projects - a different answer from `absent`, which means a
   * roster companion who simply has no picture.
   *
   * A file that EXISTS but cannot be used throws instead of reporting `absent`:
   * "she has no picture" and "her picture is there and unreadable" are different
   * facts, and only the first one is an ordinary state.
   */
  read(handle: string): Promise<CompanionAvatarRead | null>;
}>;

/**
 * The one path a companion's avatar lives at, derived from her identity the same
 * way every other companion artifact is. Exported so a caller that already holds
 * the identity (the import confirm step) can write to the exact path this
 * service will later read.
 */
export function companionAvatarPath(runtimeRoot: string, playerId: string, companion: CompanionAvatarOwner): string {
  const identity = Object.freeze({
    playerId,
    companionId: companion.companionId,
    continuityId: companion.continuityId,
  });
  return join(
    resolveTavernPaths(resolveRuntimePaths(identity, runtimeRoot), identity).companionRoot,
    COMPANION_AVATAR_FILE_NAME,
  );
}

export function createCompanionAvatarService(
  options: Readonly<{
    runtimeRoot: string;
    playerId: string;
    /**
     * The roster's own reverse map, exactly as `companion.profile.read` uses it:
     * the handle is a per-mount HMAC and this is the only way back to the
     * companion it names.
     */
    resolveCompanion(handle: string): Promise<CompanionAvatarOwner | null>;
  }>,
): CompanionAvatarService {
  return Object.freeze({
    async read(handle: string): Promise<CompanionAvatarRead | null> {
      const companion = await options.resolveCompanion(handle);
      if (companion === null) return null;
      return await readAvatarFile(
        companionAvatarPath(options.runtimeRoot, options.playerId, companion),
        options.runtimeRoot,
      );
    },
  });
}

/**
 * Writes one companion's picture where the avatar face will read it.
 *
 * The lock creates and verifies the companion's own directory before the write
 * (the directory may not exist yet: a card that carried no scenario and no
 * greeting never caused one to be created), and the write itself is the same
 * exclusive-temporary-then-rename as every other durable artifact here uses.
 * Called once, at provision: a companion namespace is never adopted or
 * overwritten, so one companion root holds one name and one picture.
 */
export async function writeAvatarFile(path: string, bytes: Uint8Array, containmentRoot: string): Promise<void> {
  await withPathLock(
    path,
    async () => {
      await atomicWriteFile(path, bytes, containmentRoot);
    },
    { containmentRoot },
  );
}

/**
 * Reads one avatar file at an exact path, inside an exact containment root.
 *
 * Absence (`absent`) is an ordinary state, not an error; a file that exists and
 * cannot be used throws, because "there is no picture" and "her picture is there
 * and unreadable" are different facts. Both the companion's own picture and the
 * staged copy of a just-imported one are read through this one function, so the
 * two can never disagree about what an avatar file is.
 */
export async function readAvatarFile(path: string, containmentRoot: string): Promise<CompanionAvatarRead> {
  try {
    // The leaf may be absent; its ancestry may not be unprovable. This refuses a
    // symlinked or reparse-point companion root (or avatar) before any byte is
    // opened, so a link can never name a file outside the companion's namespace.
    await verifySafePathBoundary(path, containmentRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return Object.freeze({ state: "absent" });
    throw new Error("companion_avatar_unreadable", { cause: error });
  }
  let stat;
  try {
    stat = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return Object.freeze({ state: "absent" });
    throw new Error("companion_avatar_unreadable", { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("companion_avatar_unreadable");
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size > MAX_COMPANION_AVATAR_BYTES) throw new Error("companion_avatar_too_large");
  const bytes = await readExactly(path, size);
  if (!isCompletePngFile(bytes)) throw new Error("companion_avatar_malformed");
  return Object.freeze({ state: "present", bytes });
}

/** Reads one file's declared size exactly, through a handle that stays the file it opened. */
async function readExactly(path: string, size: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size !== BigInt(size)) throw new Error("companion_avatar_unreadable");
    const body = Buffer.alloc(size);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (bytesRead === 0) throw new Error("companion_avatar_unreadable");
      offset += bytesRead;
    }
    return body;
  } finally {
    await handle.close();
  }
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = offset; index < offset + length && index < bytes.length; index += 1)
    value += String.fromCharCode(bytes[index]!);
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
