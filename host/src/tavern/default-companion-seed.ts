import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  identityProfileHash,
  identityProfileMetadata,
  type IdentityProfile,
  validateIdentityProfile,
  writeIdentityProfile,
} from "../identity-profile.js";
import { identityKey, type CompanionIdentity, resolveRuntimePaths } from "../runtime-identity.js";
import { type WorldBook, validateWorldBook, writeWorldBook } from "../worldbook.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { DEFAULT_COMPANION_PRESET, type DefaultCompanionPreset } from "./default-companion-preset.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { createTavernLibraryService } from "./library-service.js";
import { resolveTavernPaths } from "./tavern-paths.js";

/**
 * The product-owned seed that installs the reviewed default companion — 琥珀 /
 * Kohaku — into a FRESH runtime root.
 *
 * Why it is needed: the product's first-creation path used to seed the
 * mechanical `DEFAULT_IDENTITY_PROFILE` ("GameBuddy Companion") with zero
 * openings and no world book, so a new player met a placeholder while the
 * reviewed preset sat unread. `tools/live-run/core/persona.mjs`
 * (`provisionLiveRunPersona`) already compiled a card into
 * `identity-profile.json` plus a greeting record for the live-run harness, but
 * the product path never called it. This is the product-owned equivalent: it
 * installs the SAME compiled artifacts (a card compiled by the product's own
 * `previewStCard` + `candidateToIdentityProfile`, never a second converter —
 * see `default-companion-preset.ts`) through the product's OWN write paths,
 * `writeIdentityProfile` and the greeting management service.
 *
 * First-creation-only by construction: if `<runtimeCwd>/identity-profile.json`
 * already exists the function returns without touching anything, so a player's
 * later edits — a renamed companion, a rewritten persona, an updated world book
 * — are never overwritten. That is also why it is only called on a FRESH
 * provision: a `known` open means the root already exists.
 */
export type DefaultCompanionSeedOutcome = Readonly<{
  /** True only when this call created the profile; false when the root already had one. */
  seeded: boolean;
  reason: "seeded" | "already_present";
  identityName: string;
  profileId: string;
  worldBookId: string;
  greetingVariants: number;
}>;

export async function seedDefaultCompanionIntoFreshRuntimeRoot(
  identity: CompanionIdentity,
  runtimeRoot: string,
  preset: DefaultCompanionPreset = DEFAULT_COMPANION_PRESET,
): Promise<DefaultCompanionSeedOutcome> {
  const paths = resolveRuntimePaths(identity, runtimeRoot);
  const profile: IdentityProfile = validateIdentityProfile(preset.profile);
  const worldBook: WorldBook = validateWorldBook(preset.worldBook);
  const outcome = (seeded: boolean): DefaultCompanionSeedOutcome =>
    Object.freeze({
      seeded,
      reason: seeded ? "seeded" : "already_present",
      identityName: profile.identity.name,
      profileId: profile.profileId,
      worldBookId: worldBook.worldBookId,
      greetingVariants: preset.greetings.length,
    });
  // A pre-existing profile means this is not a fresh root: leave every authored
  // value alone.
  if (existsSync(paths.identityProfilePath)) return outcome(false);
  // The write path owns the lock and creates the `contexts/<identityKey>`
  // parents; the runtime root itself may not have one yet.
  await writeIdentityProfile(paths.identityProfilePath, profile, { containmentRoot: paths.root });
  const worldBookPath = join(paths.runtimeCwd, "worldbook.json");
  if (!existsSync(worldBookPath)) await writeWorldBook(worldBookPath, worldBook);
  const tavernPaths = resolveTavernPaths(paths, identity);
  const artifacts = new TavernArtifactStore(paths.root);
  const greetings = createGreetingManagementService(artifacts, tavernPaths.companionRoot);
  // A resumed root keeps its record; the default variant is what the initial
  // Chat draws its opening from (`initial-chat-exact-content-port.ts`).
  if ((await greetings.readExact()) === null && preset.greetings.length > 0)
    await greetings.create({ label: "Initial Greeting", variants: preset.greetings });
  // A seeded companion must be exactly a companion the library created. The
  // library's chat selector reads `companion.json`, and this is the only place a
  // fresh root's companion comes from, so the record is installed through the
  // library's OWN creation path: one producer of that record, never a second
  // copy of the shape that could drift from it. Without this the library would
  // have to accept a companion whose record it never wrote, which is the
  // two-producer disagreement - not a missing file to tolerate.
  const threads = createChatThreadStore(paths.runtimeCwd, identityKey(identity));
  try {
    await createTavernLibraryService(tavernPaths, artifacts, threads, {
      async readExact() {
        return identityProfileMetadata(profile);
      },
    }).createNewCompanion({
      companionId: identity.companionId,
      continuityId: identity.continuityId!,
      name: profile.identity.name,
      profileId: profile.profileId,
      profileRevision: profile.revision,
      profileHash: identityProfileHash(profile),
    });
  } finally {
    threads.close?.();
  }
  return outcome(true);
}
