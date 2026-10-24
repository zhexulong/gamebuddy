import { readFile } from "node:fs/promises";
import { atomicWriteFile, withPathLock } from "../../path-lock.js";
import { readStrictJsonFile } from "../../strict-json-reader.js";
import type { StardewPlayerSettings } from "./stardew-player-settings.js";

/**
 * The three `ModConfig` fields the player's record becomes, and the merge that
 * puts them into a `config.json` without touching anything else in it.
 *
 * Two facts shape this module.
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
}>;

/** The keys this module owns in the Mod's config document. */
const OWNED_CONFIG_KEYS = Object.freeze([
  "DeniedActions",
  "DeniedActionFamilies",
  "AdvanceDayMinimumOnlineFarmers",
] as const);

export function projectStardewModActionPolicy(
  settings: Pick<StardewPlayerSettings, "deniedActionFamilies" | "advanceDayMinimumOnlineFarmers">,
): StardewModActionPolicyProjection {
  return Object.freeze({
    DeniedActions: Object.freeze([]) as unknown as readonly string[],
    DeniedActionFamilies: Object.freeze([...settings.deniedActionFamilies]),
    AdvanceDayMinimumOnlineFarmers: settings.advanceDayMinimumOnlineFarmers,
  });
}

/**
 * Sets the three owned keys in an already-serialized Mod config document and
 * leaves every other key alone. `existing` is the document's own object, so the
 * caller decides whether it came from disk or from the composer's own staging.
 */
export function mergeStardewModActionPolicy(
  existing: Readonly<Record<string, unknown>>,
  policy: StardewModActionPolicyProjection,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const key of OWNED_CONFIG_KEYS) merged[key] = policy[key];
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
