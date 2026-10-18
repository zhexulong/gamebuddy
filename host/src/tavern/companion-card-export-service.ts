import { existsSync } from "node:fs";
import { join } from "node:path";
import { readIdentityProfile } from "../identity-profile.js";
import type { IdentityProfile } from "../identity-profile.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import type { CompanionIdentity } from "../runtime.js";
import { readWorldBook, type WorldBook } from "../worldbook.js";
import type { TavernArtifactStore } from "./artifact-store.js";
import { companionAvatarPath, readAvatarFile } from "./companion-avatar/index.js";
import {
  type CompanionCardExport,
  type CompanionCardFormat,
  type CompanionCardRecords,
  companionCardFileName,
  exportCompanionCard,
} from "./companion-card-export.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { writeCompanionCardPng } from "./png-card-writer.js";
import { createScenarioManagementService } from "./scenario-management/scenario-management.js";
import { resolveTavernPaths } from "./tavern-paths.js";

/**
 * The target one roster handle resolves to. Which companion a handle names is not
 * this module's decision: the handle is a per-mount HMAC, so the caller owns the
 * reverse map (`resolveCompanion`) and this module only reads the roots the
 * resolved record derives.
 */
export type CompanionCardExportTarget = Readonly<{
  companionId: string;
  continuityId: string;
  /**
   * The companion's library name, used only when she has no readable identity
   * profile; `null` means the caller could not name her at all, which is a handle
   * the roster never projected (see `read`).
   */
  name: string | null;
}>;

/**
 * One companion's card, in the form the caller named.
 *
 * The JSON arm is the card's own text; the PNG arm is the card file itself - her
 * picture with the card inside it - as bytes, because the browser saves exactly
 * what the Host built rather than re-encoding it. Both arms are the same card:
 * the PNG is the JSON with one `tEXt` chunk added to a picture, not a second
 * projection of her records (see `png-card-writer.ts`).
 */
export type CompanionCardExportResult =
  | Readonly<{ format: "json"; spec: CompanionCardExport["spec"]; fileName: string; card: string }>
  | Readonly<{ format: "png"; spec: CompanionCardExport["spec"]; fileName: string; cardFile: Uint8Array }>;

export type CompanionCardExportService = Readonly<{
  read(handle: string, format: CompanionCardFormat): Promise<CompanionCardExportResult | null>;
}>;

/**
 * Exports one companion's own records as a standard Tavern V3 character card.
 *
 * Like the read-only inspector, this resolves any handle the roster projected -
 * a companion a player is not currently playing can still have her world book,
 * scenario, openings and directive taken out and backed up. It reads her durable
 * artifacts from the roots her own `companion.json` derives, sends them through
 * the pure builder (`companion-card-export.ts`) and returns the card's bytes with
 * the filename the browser saves them under.
 *
 * Nothing here writes: the export is a projection, so it cannot become a second,
 * divergent place to edit a companion. A record that is PRESENT but unreadable
 * fails closed by name (`companion_record_unreadable` / `companion_world_book_unreadable`)
 * rather than being exported as an absent field - a truncated card would read as
 * the author's own work.
 *
 * **The PNG form, and what image goes inside it.** A PNG card must contain an
 * image, and the honest one is HER OWN picture: the bytes her companion namespace
 * already holds, framed unchanged around the card chunk. When she has no picture
 * - a companion created directly, or imported from a `.json` card, neither of
 * which ever carried one - the export refuses the PNG form BY NAME
 * (`companion_card_image_absent`) and the player is told the JSON card carries her
 * records without a picture. It does not invent art and it does not ship a blank
 * card: a fabricated placeholder would be a picture that is not her, and a card
 * whose only image is one this Host made up is a card that lies about its
 * companion.
 *
 * The card carries the durable record's own text, macros and all. The import
 * renders `{{user}}`/`{{char}}` through the run's macro table on the way in, so
 * the export writes what the author wrote and the round trip lands on the same
 * effective values.
 */
export function createCompanionCardExportService(
  options: Readonly<{
    store: TavernArtifactStore;
    runtimeRoot: string;
    playerId: string;
    resolveCompanion(handle: string): Promise<CompanionCardExportTarget | null>;
  }>,
): CompanionCardExportService {
  return Object.freeze({
    async read(handle: string, format: CompanionCardFormat): Promise<CompanionCardExportResult | null> {
      const companion = await options.resolveCompanion(handle);
      if (companion === null) return null;
      const identity = Object.freeze({
        playerId: options.playerId,
        companionId: companion.companionId,
        continuityId: companion.continuityId,
      });
      const runtimePaths = resolveRuntimePaths(identity, options.runtimeRoot);
      const tavernPaths = resolveTavernPaths(runtimePaths, identity);
      // A missing identity profile is ordinary: both provisioning paths write one,
      // but a companion without one still has her library name. A profile that is
      // PRESENT but unreadable fails closed instead of exporting her without it.
      const profile = existsSync(runtimePaths.identityProfilePath)
        ? await readIdentityProfileOrThrow(runtimePaths.identityProfilePath)
        : null;
      const name = profile?.identity.name ?? companion.name;
      if (name === null) return null;
      const scenario = await readScenarioOrThrow(options, tavernPaths.companionRoot);
      const greetings = await readGreetingsOrThrow(options, tavernPaths.companionRoot);
      const worldBook = await readWorldBookOrThrow(runtimePaths.runtimeCwd);
      const records: CompanionCardRecords = {
        name,
        ...(profile?.persona === undefined ? {} : { persona: profile.persona }),
        ...(profile?.examples === undefined ? {} : { examples: profile.examples }),
        ...(profile?.characterVoice === undefined ? {} : { characterVoice: profile.characterVoice }),
        ...(scenario === null ? {} : { scenario: scenario.description }),
        ...(greetings === null
          ? {}
          : { openings: greetings.variants.map((variant) => Object.freeze({ text: variant.text })) }),
        worldBook,
      };
      const card = exportCompanionCard(records);
      if (format === "json")
        return Object.freeze({ format: "json", spec: card.spec, fileName: card.fileName, card: card.card });
      const picture = await readAvatarOrThrow(options, identity);
      if (picture === null) throw new Error("companion_card_image_absent");
      return Object.freeze({
        format: "png",
        spec: card.spec,
        fileName: companionCardFileName(name, "png"),
        cardFile: writeCompanionCardPng(picture, card.card),
      });
    },
  });
}

async function readIdentityProfileOrThrow(path: string): Promise<IdentityProfile> {
  try {
    return await readIdentityProfile(path);
  } catch {
    throw new Error("companion_record_unreadable");
  }
}

/**
 * Her own picture, or `null` when she has none.
 *
 * Absence is an ordinary state (she was created directly, or imported from a
 * `.json` card) and the caller refuses the PNG form by name for it. A picture
 * that EXISTS and cannot be used throws: "she has no picture" and "her picture is
 * there and unreadable" are different facts, and only a present-but-broken
 * companion artifact is `companion_record_unreadable`.
 */
async function readAvatarOrThrow(
  options: Readonly<{ runtimeRoot: string; playerId: string }>,
  identity: CompanionIdentity,
): Promise<Uint8Array | null> {
  let read;
  try {
    read = await readAvatarFile(
      companionAvatarPath(options.runtimeRoot, options.playerId, {
        companionId: identity.companionId,
        continuityId: identity.continuityId!,
      }),
      options.runtimeRoot,
    );
  } catch {
    throw new Error("companion_record_unreadable");
  }
  return read.state === "absent" ? null : read.bytes;
}

async function readScenarioOrThrow(
  options: Readonly<{ store: TavernArtifactStore }>,
  companionRoot: string,
): Promise<Readonly<{ description: string }> | null> {
  try {
    const scenario = await createScenarioManagementService(options.store, companionRoot).read();
    return scenario === null ? null : Object.freeze({ description: scenario.description });
  } catch {
    throw new Error("companion_record_unreadable");
  }
}

async function readGreetingsOrThrow(
  options: Readonly<{ store: TavernArtifactStore }>,
  companionRoot: string,
): Promise<Readonly<{ variants: readonly Readonly<{ text: string }>[] }> | null> {
  try {
    const greetings = await createGreetingManagementService(options.store, companionRoot).read();
    return greetings === null ? null : Object.freeze({ variants: greetings.variants });
  } catch {
    throw new Error("companion_record_unreadable");
  }
}

async function readWorldBookOrThrow(runtimeCwd: string): Promise<WorldBook | null> {
  const path = join(runtimeCwd, "worldbook.json");
  if (!existsSync(path)) return null;
  try {
    return await readWorldBook(path);
  } catch {
    throw new Error("companion_world_book_unreadable");
  }
}
