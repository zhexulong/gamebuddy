import { readFile } from "node:fs/promises";
import { atomicWriteFile, withPathLock } from "../../path-lock.js";
import { readStrictJsonFile } from "../../strict-json-reader.js";
import { readStoredCompanionLocale } from "../../settings/player-preference-store.js";
import type { StardewPlayerSettings } from "./stardew-player-settings.js";

/**
 * The `ModConfig` fields the player's records become, and the merge that puts
 * them into a `config.json` without touching anything else in it.
 *
 * Two records feed this module, and each stays the sole owner of its fields:
 * `stardew-player-settings.json` supplies the action policy and the co-op night
 * floor, and `settings/player-preference.json` supplies the companion language
 * the Mod presents in. Neither is copied here - both are read at projection time
 * and neither is written.
 *
 * Three facts shape this module.
 *
 * First, the Mod's config document is not this Host's to own. It carries the
 * bridge credentials, the provisioning session token and dozens of fixture
 * fields, and the composer wrote every one of them. A settings save that
 * re-serialized the document from the player's record would delete all of them -
 * the same whole-record replacement this repository has fixed twice. So the
 * write is a merge: the document is read, the three owned keys are set, and every
 * other key is written back exactly as it was found.
 *
 * Second, a `config.json` can be a *live* file: while a world is running the Mod
 * re-reads it every 120 ticks (`FarmhandPolicyRefreshThrottle`, about two seconds
 * at 60 Hz) and applies the action policy to the capability surface it publishes.
 * It is also the file the Mod itself rewrites (`PersistVerifiedFarmhandScope` ->
 * `Helper.WriteConfig`), which is why this write is a bounded best effort rather
 * than a claim: a save that lands while the Mod is rewriting the same document is
 * not a failure the player caused, and the durable record is what makes the
 * answer survive either way.
 *
 * Third, `PresentationLocale` is present only when the player has chosen a
 * companion language. When they have not, the key is absent and the Mod's own
 * resolution order - configured locale, else the live game locale
 * (`ModEntry.ResolvePresentationLocale`) - stays in charge. The Host never
 * invents a language here: an unreadable preference record leaves the key out
 * for the same reason the Mod has a fallback at all.
 *
 * `DeniedActions` is written as an empty list rather than omitted. The record has
 * no per-action denials - the surface switches whole families - and an absent key
 * would make the Mod's own reader fall back to its default while the file's
 * remaining policy came from somewhere else. An explicit empty list says what the
 * player's policy really is at this granularity.
 */
export type StardewModActionPolicyProjection = Readonly<{
  DeniedActions: readonly string[];
  DeniedActionFamilies: readonly string[];
  AdvanceDayMinimumOnlineFarmers: number;
  /** Absent leaves the Mod's own live-game-locale fallback in charge. */
  PresentationLocale?: string;
}>;

/** The keys this module owns in the Mod's config document. */
const OWNED_CONFIG_KEYS = Object.freeze([
  "DeniedActions",
  "DeniedActionFamilies",
  "AdvanceDayMinimumOnlineFarmers",
] as const);

/**
 * The player's chosen companion language, read from the record's single
 * authority at projection time, or undefined when they never chose one.
 *
 * This is the same read the Game runtime and the Chat surface already resolve
 * their own locale through, so the Mod's presentation language and the Agent's
 * session language can no longer be two independent answers. A record that is
 * unreadable or corrupt yields undefined rather than a guess: the caller then
 * leaves `PresentationLocale` out of the document, and the Mod falls back to the
 * live game locale exactly as it does for a player who never chose.
 */
export async function readStardewModPresentationLocale(runtimeRoot: string): Promise<string | undefined> {
  try {
    return await readStoredCompanionLocale(runtimeRoot);
  } catch {
    return undefined;
  }
}

export function projectStardewModActionPolicy(
  settings: Pick<StardewPlayerSettings, "deniedActionFamilies" | "advanceDayMinimumOnlineFarmers">,
  presentationLocale?: string,
): StardewModActionPolicyProjection {
  return Object.freeze({
    DeniedActions: Object.freeze([]) as unknown as readonly string[],
    DeniedActionFamilies: Object.freeze([...settings.deniedActionFamilies]),
    AdvanceDayMinimumOnlineFarmers: settings.advanceDayMinimumOnlineFarmers,
    ...(presentationLocale === undefined ? {} : { PresentationLocale: presentationLocale }),
  });
}

/**
 * Sets the owned keys in an already-serialized Mod config document and leaves
 * every other key alone. `existing` is the document's own object, so the caller
 * decides whether it came from disk or from the composer's own staging.
 *
 * `PresentationLocale` is written only when the projection carries it. An absent
 * locale must leave the document without the key - that absence IS the answer,
 * and the Mod's fallback reads it - and a live action-policy save, which says
 * nothing about language, must not erase what a bootstrap authored.
 */
export function mergeStardewModActionPolicy(
  existing: Readonly<Record<string, unknown>>,
  policy: StardewModActionPolicyProjection,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const key of OWNED_CONFIG_KEYS) merged[key] = policy[key];
  if (policy.PresentationLocale !== undefined) merged.PresentationLocale = policy.PresentationLocale;
  return merged;
}

/**
 * The same merge against a `config.json` on disk, under that file's own path
 * lock. Returns false when the file is not there - no attempt is staged, or the
 * last one was settled and cleaned up - which is not an error: the durable record
 * is projected into the next bootstrap's config anyway.
 *
 * A document that is present but is not a JSON object is refused rather than
 * replaced: it is something this module cannot merge into, and overwriting it
 * would destroy whatever it was.
 */
export async function writeStardewModActionPolicyIntoConfig(
  configPath: string,
  policy: StardewModActionPolicyProjection,
): Promise<boolean> {
  try {
    await readFile(configPath);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  return await withPathLock(configPath, async () => {
    let document: unknown;
    try {
      document = await readStrictJsonFile(configPath);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new Error("stardew_mod_config_not_mergeable", { cause: error });
    }
    if (!isRecord(document)) throw new Error("stardew_mod_config_not_mergeable");
    await atomicWriteFile(configPath, JSON.stringify(mergeStardewModActionPolicy(document, policy)));
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
