import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createIdentityProfileBinding,
  type IdentityProfileMetadata,
  identityProfileHash,
  identityProfileMetadata,
  type IdentityProfile,
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

/** The effective directive the durable profile holds, or null when it holds none. */
export type CompanionVoiceProjection = Readonly<{ text: string; source: "card" | "player" }>;

export function projectCompanionVoice(profile: IdentityProfile): CompanionVoiceProjection | null {
  const voice = profile.characterVoice;
  return voice === undefined ? null : Object.freeze({ text: voice.text, source: voice.source });
}

/**
 * One revision-CASed edit or clear of the mounted companion's performance
 * directive (the reviewed card's `system_prompt`). `voice === null` clears the
 * field - the member is removed, never stored as empty text, so a cleared
 * directive reads as absent everywhere it is consumed. A non-null voice
 * re-authors the text as the player's (`source: "player"`).
 *
 * The identity profile is one durable record read at every runtime mount. Two
 * distinct pins name it, and both are carried here:
 *
 *  - each surface session's `identity-profile-binding.json` pins that record's
 *    revision and canonical hash (`assertProfileMatchesBinding` at mount);
 *  - each Chat thread pins the same triple on its own row, and the runtime
 *    construction refuses a thread whose pin does not match the profile it read.
 *    That pin is the guard that keeps a Chat's authored context honest: a Chat
 *    mounts only against the profile it was created with.
 *
 * Refreshing the first and not the second used to leave every existing Chat of
 * the companion unable to mount at all. So the edit rewrites the profile and then
 * re-pins every thread of the same continuity that still pins the exact triple it
 * replaced (`refreshCompanionProfileBinding`), which keeps the guard's purpose
 * while making the save carry its threads with it.
 *
 * Two authorities - one file and SQLite rows - cannot be one atomic act, so the
 * order is the one that fails safe, exactly as `updateCompanionWorldBook` does it:
 * the file is put back byte for byte and the save is refused when the re-pin
 * cannot happen. `chat_profile_binding_turn_active` means a Chat of this companion
 * is answering right now, and an accepted turn's plan pins the same triple and is
 * write-once, so the player is told to save again once the reply finishes rather
 * than having the turn's own evidence rewritten underneath it.
 *
 * A revision other than the one the browser read is refused - the browser never
 * silently overwrites an edit it did not see.
 */
export async function updateMountedCompanionVoice(
  input: Readonly<{
    identityProfilePath: string;
    runtimeCwd: string;
    containmentRoot: string;
    identityKey: string;
    expectedProfileRevision: number;
    voice: Readonly<{ text: string }> | null;
    refreshThreadBindings: CompanionProfileBindingRefresh;
  }>,
): Promise<Readonly<{ profileRevision: number; characterVoice: CompanionVoiceProjection | null }>> {
  return await withPathLock(
    input.identityProfilePath,
    async () => {
      const currentBytes = await readFile(input.identityProfilePath, "utf8");
      const current = await readIdentityProfile(input.identityProfilePath);
      if (current.revision !== input.expectedProfileRevision) throw new Error("character_voice_conflict");
      const previous = identityProfileMetadata(current);
      // Clearing must REMOVE the member rather than store empty text, so the
      // existing value is stripped before the next profile is validated.
      const withoutVoice: Record<string, unknown> = { ...current };
      delete withoutVoice.characterVoice;
      const next = validateIdentityProfile({
        ...withoutVoice,
        revision: current.revision + 1,
        ...(input.voice === null ? {} : { characterVoice: { text: input.voice.text, source: "player" } }),
      });
      const nextBytes = JSON.stringify({ ...next, canonicalHash: identityProfileHash(next) }, null, 2);
      await atomicWriteFile(input.identityProfilePath, nextBytes, input.containmentRoot);
      try {
        await input.refreshThreadBindings(previous, identityProfileMetadata(next));
      } catch (error) {
        await atomicWriteFile(input.identityProfilePath, currentBytes, input.containmentRoot);
        // A Chat of this companion is answering: the refusal is the player's, and it names the one
        // thing they can do (save again once the reply finishes). Every other failure is the durable
        // thread store not following the change at all - a storage fact, not the player's.
        if (error instanceof Error && error.message === "chat_profile_binding_turn_active") throw error;
        throw new Error("character_voice_binding_unavailable");
      }
      await refreshProfileBindings(input.runtimeCwd, input.identityKey, next, input.containmentRoot);
      return Object.freeze({ profileRevision: next.revision, characterVoice: projectCompanionVoice(next) });
    },
    { containmentRoot: input.containmentRoot },
  );
}

/**
 * Rewrites every binding that pins this continuity's profile. A binding that is
 * already absent is skipped: a session that never mounted has nothing to keep
 * coherent, and its first mount binds the current profile itself.
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
