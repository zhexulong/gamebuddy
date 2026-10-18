import { existsSync } from "node:fs";
import { join } from "node:path";
import { readIdentityProfile } from "../identity-profile.js";
import type { IdentityProfile } from "../identity-profile.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import { readWorldBook, type WorldBook } from "../worldbook.js";
import type { TavernArtifactStore } from "./artifact-store.js";
import { type CompanionCardExport, type CompanionCardRecords, exportCompanionCard } from "./companion-card-export.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
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

export type CompanionCardExportService = Readonly<{
  read(handle: string): Promise<CompanionCardExport | null>;
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
    async read(handle: string): Promise<CompanionCardExport | null> {
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
      return exportCompanionCard(records);
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
