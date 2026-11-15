import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createIdentityProfileBinding,
  identityProfileHash,
  type IdentityProfile,
  type IdentityProfileMetadata,
  identityProfileMetadata,
  readIdentityProfile,
  readIdentityProfileBinding,
  validateIdentityProfile,
  writeIdentityProfileBinding,
} from "../identity-profile.js";
import { atomicWriteFile, withPathLock } from "../path-lock.js";

/** Carries one profile revision to the Chat threads of this companion pinned to the one it replaced. */
export type CompanionProfileBindingRefresh = (
  previous: IdentityProfileMetadata,
  next: IdentityProfileMetadata,
) => Promise<number>;

/**
 * One revision-CASed edit of the mounted companion's durable identity profile.
 *
 * The profile is ONE record and it has several authored members - her persona, her example
 * dialogues, her performance directive - each with its own editor and its own vocabulary. So
 * the write is here once and the members are its callers: the record, the lock, the revision
 * compare-and-set, the rollback and the two pin refreshes below are the same acts whichever
 * member the player is editing, and a second copy of them would be a second place for the
 * profile's own invariants to drift.
 *
 * Two distinct pins name this record, and both are carried here:
 *
 *  - each surface session's `identity-profile-binding.json` pins that record's revision and
 *    canonical hash (`assertProfileMatchesBinding` at mount);
 *  - each Chat thread pins the same triple on its own row, and the runtime construction
 *    refuses a thread whose pin does not match the profile it read. That pin is the guard
 *    that keeps a Chat's authored context honest: a Chat mounts only against the profile it
 *    was created with.
 *
 * Refreshing the first and not the second used to leave every existing Chat of the companion
 * unable to mount at all. So the edit rewrites the profile and then re-pins every thread of
 * the same continuity that still pins the exact triple it replaced, which keeps the guard's
 * purpose while making the save carry its threads with it.
 *
 * Two authorities - one file and SQLite rows - cannot be one atomic act, so the order is the
 * one that fails safe, exactly as `updateCompanionWorldBook` does it: the file is put back
 * byte for byte and the save is refused when the re-pin cannot happen. A re-pin that fails
 * because a Chat of this companion is answering is a refusal the player can act on (save
 * again once the reply finishes): the accepted turn's plan pins the same triple and is
 * write-once, so the turn's own evidence is never rewritten underneath it. Every other
 * re-pin failure is the durable thread store not following the change at all - a storage
 * fact, not the player's.
 *
 * The three refusal codes are the caller's, because each is the fact of the member being
 * edited ("her directive could not be saved" must not read as "her examples could not be").
 */
export async function writeMountedIdentityProfile(
  input: Readonly<{
    identityProfilePath: string;
    runtimeCwd: string;
    containmentRoot: string;
    identityKey: string;
    expectedProfileRevision: number;
    /** The record this write produces. Called inside the lock, after the CAS. */
    next(current: IdentityProfile): Record<string, unknown>;
    /** The code thrown when the record moved on since the browser read it. */
    conflict: string;
    /** The code thrown when the file was put back because the store could not follow it. */
    bindingUnavailable: string;
    refreshThreadBindings: CompanionProfileBindingRefresh;
  }>,
): Promise<IdentityProfile> {
  return await withPathLock(
    input.identityProfilePath,
    async () => {
      const currentBytes = await readFile(input.identityProfilePath, "utf8");
      const current = await readIdentityProfile(input.identityProfilePath);
      if (current.revision !== input.expectedProfileRevision) throw new Error(input.conflict);
      const previous = identityProfileMetadata(current);
      const next = validateIdentityProfile(input.next(current));
      const nextBytes = JSON.stringify({ ...next, canonicalHash: identityProfileHash(next) }, null, 2);
      await atomicWriteFile(input.identityProfilePath, nextBytes, input.containmentRoot);
      try {
        await input.refreshThreadBindings(previous, identityProfileMetadata(next));
      } catch (error) {
        await atomicWriteFile(input.identityProfilePath, currentBytes, input.containmentRoot);
        // The store's own turn-active refusal passes through unchanged: it is one fact about one
        // reply on both surfaces, and both routes answer it with the same bounded code.
        if (error instanceof Error && error.message === "chat_profile_binding_turn_active") throw error;
        throw new Error(input.bindingUnavailable);
      }
      await refreshProfileBindings(input.runtimeCwd, input.identityKey, next, input.containmentRoot);
      return next;
    },
    { containmentRoot: input.containmentRoot },
  );
}

/**
 * Rewrites every binding that pins this continuity's profile. A binding that is already
 * absent is skipped: a session that never mounted has nothing to keep coherent, and its
 * first mount binds the current profile itself.
 */
async function refreshProfileBindings(
  runtimeCwd: string,
  identityKey: string,
  profile: IdentityProfile,
  containmentRoot: string,
): Promise<void> {
  await refreshBinding(join(runtimeCwd, "identity-profile-binding.json"), identityKey, profile, containmentRoot);
  let sessions;
  try {
    sessions = await readdir(join(runtimeCwd, "surface-sessions"), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of sessions) {
    if (!entry.isDirectory()) continue;
    await refreshBinding(
      join(runtimeCwd, "surface-sessions", entry.name, "identity-profile-binding.json"),
      identityKey,
      profile,
      containmentRoot,
    );
  }
}

async function refreshBinding(
  bindingPath: string,
  identityKey: string,
  profile: IdentityProfile,
  containmentRoot: string,
): Promise<void> {
  const existing = await readIdentityProfileBinding(bindingPath);
  if (existing === null) return;
  await writeIdentityProfileBinding(
    bindingPath,
    createIdentityProfileBinding(identityKey, profile, existing.sessionFile),
    { containmentRoot },
  );
}
