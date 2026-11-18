/**
 * What the runtime actually mounted versus what the product placed, read from authoritative files only.
 *
 * The runtime's own run manifest says what the session mounted; the canonical identity profile and world book under the
 * runtime root say what was available. A disposable root has neither, and the caller treats that as "nothing to assert"
 * rather than a failure - so the answer is published field by field instead of being reduced to a boolean.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { assessIdentityProfile } from "../core/content-gate.mjs";

/**
 * Reads what the runtime actually mounted versus what the product placed for
 * this identity, using only authoritative files: the runtime's own run manifest
 * (what the session mounted) and the canonical identity-profile/worldbook under
 * the runtime root (what was available). A disposable root has neither, and the
 * caller treats that as "nothing to assert" rather than a failure.
 */
export async function readAssembledContextEvidence(runtimePaths) {
  const readJson = async (path) => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  };
  const manifest = await readJson(runtimePaths.runManifestPath);
  const canonicalProfile = await readJson(runtimePaths.identityProfilePath);
  const canonicalWorldBook = await readJson(join(runtimePaths.runtimeCwd, "worldbook.json"));
  const mountedProfile = manifest?.identityProfile ?? null;
  const mountedWorldBook = manifest?.worldBook ?? null;
  return Object.freeze({
    // What was available for this identity (absent on a disposable root).
    expectedProfile:
      canonicalProfile === null
        ? null
        : Object.freeze({
            profileId: canonicalProfile.profileId ?? null,
            revision: canonicalProfile.revision ?? null,
            canonicalHash: canonicalProfile.canonicalHash ?? null,
          }),
    // Content facts from the same canonical profile (persona present? macro
    // residue?) — the assembly gate cannot see these; the content gate can.
    contentGate: canonicalProfile === null ? null : assessIdentityProfile(canonicalProfile),
    expectedWorldBook:
      canonicalWorldBook === null
        ? null
        : Object.freeze({
            worldBookId: canonicalWorldBook.worldBookId ?? null,
            revision: canonicalWorldBook.revision ?? null,
          }),
    // What the runtime session actually mounted (from its own run manifest).
    mountedProfileId: mountedProfile?.profileId ?? null,
    mountedProfileRevision: mountedProfile?.revision ?? null,
    mountedProfileHash: mountedProfile?.canonicalHash ?? null,
    mountedWorldBookId: mountedWorldBook?.worldBookId ?? null,
    mountedWorldBookRevision: mountedWorldBook?.revision ?? null,
    manifestPresent: manifest !== null,
    // Model identity the runtime recorded in its own run manifest (M5). Absent
    // on a disposable root; non-null only when the runtime actually wrote it.
    model:
      manifest?.model === undefined || manifest?.model === null
        ? undefined
        : Object.freeze({
            provider: manifest.model.provider ?? null,
            modelId: manifest.model.modelId ?? null,
            thinkingLevel: manifest.model.thinkingLevel ?? null,
          }),
  });
}
