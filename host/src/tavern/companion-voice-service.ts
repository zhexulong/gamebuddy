import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createIdentityProfileBinding,
  identityProfileHash,
  type IdentityProfile,
  readIdentityProfile,
  readIdentityProfileBinding,
  validateIdentityProfile,
  writeIdentityProfileBinding,
} from "../identity-profile.js";
import { atomicWriteFile, withPathLock } from "../path-lock.js";

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
 * The identity profile is one durable record read at every runtime mount, and
 * each surface session's binding pins that record's revision and canonical
 * hash. An edit therefore rewrites the profile AND refreshes every existing
 * binding for the same continuity, so a later mount of any Chat still passes
 * `assertProfileMatchesBinding` instead of failing `identity_profile_mismatch`.
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
  }>,
): Promise<Readonly<{ profileRevision: number; characterVoice: CompanionVoiceProjection | null }>> {
  return await withPathLock(
    input.identityProfilePath,
    async () => {
      const current = await readIdentityProfile(input.identityProfilePath);
      if (current.revision !== input.expectedProfileRevision) throw new Error("character_voice_conflict");
      // Clearing must REMOVE the member rather than store empty text, so the
      // existing value is stripped before the next profile is validated.
      const withoutVoice: Record<string, unknown> = { ...current };
      delete withoutVoice.characterVoice;
      const next = validateIdentityProfile({
        ...withoutVoice,
        revision: current.revision + 1,
        ...(input.voice === null ? {} : { characterVoice: { text: input.voice.text, source: "player" } }),
      });
      await atomicWriteFile(
        input.identityProfilePath,
        JSON.stringify({ ...next, canonicalHash: identityProfileHash(next) }, null, 2),
        input.containmentRoot,
      );
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
