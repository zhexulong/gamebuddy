import { lstat, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

import { readSafeDirectory, removeSafeFile, withPathLock } from "../path-lock.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import type { TavernArtifactStore } from "./artifact-store.js";
import {
  type CompanionDeletionV1,
  type DeleteCompanionCommandV1,
  TAVERN_BROWSER_API_VERSION,
} from "./browser-contract/index.js";
import { resolveTavernPaths } from "./tavern-paths.js";
import { type TavernArtifact, type TavernCompanion, validateTavernArtifact } from "./types.js";

/**
 * Physical removal of one roster companion.
 *
 * Deleting a companion is the only irreversible thing a player can reach from the
 * Characters surface, and the reason it exists at all is the duplicate: importing the
 * same card twice leaves two rows in the library, and before this there was no way to
 * remove either.
 *
 * **What goes.** Her Tavern artifact root - `tavern/v1/companions/<digest>/`, the
 * directory holding `companion.json` (her record), `avatar.png` (her picture),
 * `scenarios/`, `greetings/`, `dialogue-examples/`, `post-history-instructions.json` and
 * `card-extensions.json` - is removed whole, because that directory is the unit of
 * deletion for everything she authored. Her identity record and her own world book are
 * the two single files that are hers and are NOT under it: `contexts/<identityKey>/
 * identity-profile.json`, `identity-profile-binding.json` and `worldbook.json`. Those are
 * removed one by one rather than by removing that directory.
 *
 * **What stays, deliberately.** Her conversations and the Memory those conversations
 * built are not hers to take with her: they are the player's record of what happened, and
 * they live outside everything above (the Chat store at
 * `tavern/v3/continuities/<identityKey>/tavern.sqlite`, Memory under
 * `contexts/<identityKey>/data/cortexkit/magic-context`). Neither is touched here. The
 * consequence is stated on the surface before the player confirms rather than hidden:
 * `chat.list` projects the mounted companion's own partition, so those Chats stop being
 * listed once she is gone. Losing the reachability is the cost of not destroying them.
 *
 * **Order.** The two lone files go first and her record goes last, so a crash between the
 * steps leaves her still listed and still deletable: retrying completes the same removal,
 * and the revision CAS still matches because the record itself was untouched. The reverse
 * order leaves unreachable artifacts behind with no record naming them, which is exactly
 * the half-deleted companion this operation must never produce.
 *
 * **Refusals.** Two, by name, and both are states the player can act on: the companion
 * who is in play (`companion_delete_in_play` - her Chats ARE the mounted conversation, so
 * removing her would take the conversation the player is having) and a record that moved
 * on since the screen read it (`companion_conflict`, the bounded code every other
 * companion compare-and-set already reports).
 */
export type CompanionDeletionTarget = Readonly<{ companionId: string; continuityId: string }>;

export type CompanionDeletionService = Readonly<{
  /**
   * Removes one roster companion. `null` is the answer for a handle this mount's roster
   * never projected, and for a record another writer removed first - never a silent
   * success, because nothing was deleted.
   */
  delete(handle: string, command: DeleteCompanionCommandV1): Promise<CompanionDeletionV1 | null>;
}>;

export function createCompanionDeletionService(
  options: Readonly<{
    store: TavernArtifactStore;
    runtimeRoot: string;
    playerId: string;
    /**
     * The companion the deployment started with - the same fact the roster's `isCurrent`
     * is derived from (`mergeMountedCompanionList`). Injected rather than recomputed: a
     * second definition of "who is in play" is how the surface and the service would come
     * to disagree about whose conversation is mounted.
     */
    currentCompanionId: string;
    /** The roster's own reverse map, exactly as the inspector and the avatar upload use it. */
    resolveCompanion(handle: string): Promise<CompanionDeletionTarget | null>;
  }>,
): CompanionDeletionService {
  return Object.freeze({
    async delete(handle: string, command: DeleteCompanionCommandV1): Promise<CompanionDeletionV1 | null> {
      const companion = await options.resolveCompanion(handle);
      if (companion === null) return null;
      // The one refusal that protects a conversation the player is already having, checked
      // before any I/O: nothing about her in-play state is provisional.
      if (companion.companionId === options.currentCompanionId) throw new Error("companion_delete_in_play");
      const identity = Object.freeze({
        playerId: options.playerId,
        companionId: companion.companionId,
        continuityId: companion.continuityId,
      });
      const runtimePaths = resolveRuntimePaths(identity, options.runtimeRoot);
      const tavernPaths = resolveTavernPaths(runtimePaths, identity);
      const recordPath = join(tavernPaths.companionRoot, "companion.json");
      let deleted = false;
      // The lock is taken on her RECORD file, not on her directory: `withPathLock` verifies a
      // leaf, and a directory is not one. The lock file therefore lives inside the tree that is
      // removed, and releasing it afterwards finds it already gone - which the lock reports as
      // released rather than as a failure.
      await withPathLock(
        recordPath,
        async () => {
          // The record is read INSIDE the lock, so the revision this CAS compares is not one
          // the roster showed and another writer has already replaced.
          const record = await options.store.readIfPresent(recordPath, companionArtifact);
          if (record === undefined) return;
          if (record.artifact.companionId !== companion.companionId) throw new Error("invalid_tavern_companion");
          if (record.revision !== command.expectedRevision) throw new Error("companion_conflict");
          // Her authored records outside the artifact root. Each is one file, and absence is
          // ordinary: a directly-created companion may have no world book at all.
          await removeSafeFile(runtimePaths.identityProfileBindingPath, options.runtimeRoot);
          await removeSafeFile(runtimePaths.identityProfilePath, options.runtimeRoot);
          await removeSafeFile(join(runtimePaths.runtimeCwd, "worldbook.json"), options.runtimeRoot);
          // Her artifact root last, her record inside it: see the header on why this order is
          // the one that cannot leave a half-deleted companion.
          await removeOwnedTree(tavernPaths.companionRoot, options.runtimeRoot);
          deleted = true;
        },
        { containmentRoot: options.runtimeRoot },
      );
      return deleted ? Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, handle }) : null;
    },
  });
}

/**
 * Removes one directory tree inside the runtime root.
 *
 * The tree is verified level by level - the directory chain inside the containment root,
 * and every entry a real file or real directory rather than a link or reparse point -
 * before it is removed. `rm` itself never follows a link, so this check is about refusing
 * to act on a tree this Host did not write, not about escaping the write. Absence is
 * ordinary: the removal is the same operation whether her root carried a picture or only
 * her record.
 */
async function removeOwnedTree(path: string, containmentRoot: string): Promise<void> {
  let entries: readonly string[];
  try {
    entries = await readSafeDirectory(path, containmentRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = join(path, entry);
    const stat = await lstat(child);
    // A link is removed as a link: nothing outside the tree is reachable through one.
    if (stat.isDirectory()) await removeOwnedTree(child, containmentRoot);
    else await rm(child, { force: true });
  }
  // `rmdir`, not `rm`: the directory is empty by now, and `rm` refuses a directory on Windows
  // unless it recurses - which would be a second, unchecked deletion mechanism beside this walk.
  await rmdir(path);
}

/** Her own `companion.json` record, validated as the exact artifact it claims to be. */
function companionArtifact(value: unknown): TavernCompanion & TavernArtifact {
  const artifact = validateTavernArtifact(value);
  if (!("companionId" in artifact) || !("profileId" in artifact)) throw new Error("invalid_tavern_companion");
  return artifact as TavernCompanion & TavernArtifact;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
