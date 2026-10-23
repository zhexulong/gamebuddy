import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  type IdentityProfile,
  identityProfileHash,
  identityProfileMetadata,
  validateIdentityProfile,
  writeIdentityProfile,
} from "../identity-profile.js";
import { type CompanionIdentity, identityKey, resolveRuntimePaths } from "../runtime-identity.js";
import { validateWorldBook, type WorldBook, writeWorldBook } from "../worldbook.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import {
  companionAvatarPath,
  isCompletePngFile,
  MAX_COMPANION_AVATAR_BYTES,
  writeAvatarFile,
} from "./companion-avatar/index.js";
import { DEFAULT_COMPANION_PRESET, type DefaultCompanionPreset } from "./default-companion-preset.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { createTavernLibraryService } from "./library-service.js";
import { writeCompanionPostHistoryInstructions } from "./post-history-instructions.js";
import { createScenarioManagementService } from "./scenario-management/scenario-management.js";
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
 * `writeIdentityProfile`, the greeting management service, the scenario
 * management service and `writeAvatarFile` for her picture.
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
  // Validated BEFORE the first durable write, so a preset whose picture is not a
  // picture fails by name with nothing half-seeded behind it. A picture that is
  // present and refused is a different fact from a companion who has none, and it
  // must never be the quiet second one.
  const avatar = presetAvatarBytes(preset);
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
  // The reviewed card's scenario is a durable player-scenario record, the same
  // one `new-companion-service.ts` writes at card-import provisioning. It is
  // what BOTH readers resolve by `companionScenarioId`: a new Chat's own scenario
  // (`resolveCompanionOwnScenario`) and the character surface's Scenario panel
  // (`scenario.read`). Without it a fresh player met 「还没有保存场景。」 for a card
  // that carries a scenario, and a new Chat opened unbound. Written through the
  // product's own management service so it stays the one writer of the record.
  const scenarios = createScenarioManagementService(artifacts, tavernPaths.companionRoot);
  if ((await scenarios.read()) === null && preset.scenario !== undefined && preset.scenario.trim() !== "")
    await scenarios.create({ name: "Default Scenario", description: preset.scenario });
  // The reviewed card's closing direction, as her own record beside the scenario
  // and the openings - written through `writeCompanionPostHistoryInstructions`, the
  // one writer the card-import confirm step calls, so a seeded companion and an
  // imported one cannot end up with two different records or two different file
  // names. This is what `readCompanionPostHistoryInstructions` finds when the Chat
  // materialization builds her catalogue, and therefore the only reason the fork
  // appends anything after the transcript. A preset whose card wrote nothing writes
  // no record at all: absence stays absence, never an empty string. The text is
  // stored verbatim - the reader renders its macros.
  if (preset.postHistoryInstructions !== undefined)
    await writeCompanionPostHistoryInstructions(artifacts, tavernPaths.companionRoot, preset.postHistoryInstructions);
  // The reviewed preset's own picture, written where the avatar face reads it - the
  // same authority and the same single file name the card-import confirm step uses
  // (`new-companion-service.ts`), so a seeded companion and an imported one cannot
  // end up with two different pictures or two different file names. The lock creates
  // her `companionRoot` if none of the writes above did.
  if (avatar !== undefined)
    await writeAvatarFile(
      companionAvatarPath(paths.root, identity.playerId, {
        companionId: identity.companionId,
        continuityId: identity.continuityId!,
      }),
      avatar,
      paths.root,
    );
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

/**
 * The preset's own picture as bytes, or `undefined` when it carries none.
 *
 * The bounds are the avatar module's OWN - the same ceiling and the same container
 * check its reader applies to a stored file - so a preset picture can never be
 * something the reader would refuse later. Both refusals are named: `too_large`
 * and `malformed` say which one it was, and neither can be mistaken for a
 * companion who simply has no picture.
 */
function presetAvatarBytes(preset: DefaultCompanionPreset): Buffer | undefined {
  if (preset.avatarBase64 === undefined) return undefined;
  const bytes = Buffer.from(preset.avatarBase64, "base64");
  if (bytes.length > MAX_COMPANION_AVATAR_BYTES) throw new Error("default_companion_avatar_too_large");
  if (!isCompletePngFile(bytes)) throw new Error("default_companion_avatar_malformed");
  return bytes;
}
