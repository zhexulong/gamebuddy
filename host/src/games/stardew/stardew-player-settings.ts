import { join } from "node:path";
import { atomicWriteFile, withPathLock } from "../../path-lock.js";
import { readStrictJsonFile } from "../../strict-json-reader.js";

/**
 * The player's own Stardew settings, in one Host-owned durable record.
 *
 * Why this file exists instead of a browser write into the Mod's config.json:
 * `Mods/GameBuddy/config.json` is not a player document. It lives inside a
 * machine-minted attempt directory (`stardew-private-bootstrap/<bootstrapId>/`)
 * that `consumeRecoveredAttemptCleanup` deletes at settlement, it is written
 * once with `flag: "wx"` at staging, and it carries the bridge credentials, the
 * provisioning token and ~90 fixture fields beside the two settings a player
 * actually owns. A checkbox whose value lives there would vanish at the next
 * launch.
 *
 * So the player's answer is durable here, at a stable root-level path the player
 * can find, and the private-bootstrap composer PROJECTS it into the config.json
 * it already writes for each role. The Mod therefore needs no change: it reads
 * the config the composer hands it, exactly as it does today.
 *
 * Two field groups, and each states only what it can:
 *
 *  - `deniedActionFamilies` removes whole action families from the Agent-visible
 *    capability surface. The Mod re-reads the action policy from `config.json` on
 *    a 120-tick throttle (`FarmhandPolicyRefreshThrottle`, 2 s at 60 Hz), so a
 *    change reaches a RUNNING game without a restart.
 *  - `advanceDayMinimumOnlineFarmers` is the co-op night floor: how many farmers
 *    must be connected before a dispatched `advance_day` may start a night. The
 *    Mod reads it once, at embodiment initialisation
 *    (`ModEntry.cs` `ConfigureLifecycleMinimumFarmers`), so a change takes effect
 *    the next time the world loads - not while a world is running.
 */
const STARDEW_PLAYER_SETTINGS_SCHEMA_VERSION = 1 as const;

/** Bound on a family id, matching the Mod catalog's own action/family id shape. */
const STARDEW_ACTION_FAMILY_ID_PATTERN = /^[a-z][a-z0-9_]{1,127}$/u;

/** The most families one record may deny: the catalog's whole declared set fits well inside it. */
const STARDEW_DENIED_FAMILY_LIMIT = 64;

/** The single root-level path of the record: one path, one authority. */
export function stardewPlayerSettingsPath(runtimeRoot: string): string {
  return join(runtimeRoot, "stardew", "player-settings.json");
}

export type StardewPlayerSettings = Readonly<{
  /** Advanced by every write; a write that read an older value is refused. */
  revision: number;
  /** Action families the player has switched off. Deny-by-exception, like the Mod's own default. */
  deniedActionFamilies: readonly string[];
  /** Farmers that must be online before a night may start. 1 is the honest single-player minimum. */
  advanceDayMinimumOnlineFarmers: number;
}>;

type StoredStardewPlayerSettings = Readonly<{
  schemaVersion: typeof STARDEW_PLAYER_SETTINGS_SCHEMA_VERSION;
  revision: number;
  deniedActionFamilies: readonly string[];
  advanceDayMinimumOnlineFarmers: number;
}>;

/**
 * The one update the settings route accepts. It replaces the two player-owned
 * values together, because the surface edits them together and a partial write
 * would need a second revision to describe itself.
 */
export type StardewPlayerSettingsUpdate = Readonly<{
  deniedActionFamilies: readonly string[];
  advanceDayMinimumOnlineFarmers: number;
}>;

export class StardewPlayerSettingsRevisionConflict extends Error {
  constructor() {
    super("stardew_player_settings_revision_conflict");
  }
}

/**
 * The co-op night floor's legal range. The upper bound is the engine's own
 * co-op ceiling (four farmers share one farm), so a stored value can never name
 * a night that no world could ever start.
 */
const MINIMUM_ONLINE_FARMERS_MIN = 1;
const MINIMUM_ONLINE_FARMERS_MAX = 4;

/** The record a Host with no stored settings projects: every family consented, solo night. */
export const DEFAULT_STARDEW_PLAYER_SETTINGS: StoredStardewPlayerSettings = Object.freeze({
  schemaVersion: STARDEW_PLAYER_SETTINGS_SCHEMA_VERSION,
  revision: 0,
  deniedActionFamilies: Object.freeze([]) as unknown as readonly string[],
  advanceDayMinimumOnlineFarmers: 1,
});

export class StardewPlayerSettingsStore {
  constructor(private readonly runtimeRoot: string) {}

  get path(): string {
    return stardewPlayerSettingsPath(this.runtimeRoot);
  }

  async read(): Promise<StardewPlayerSettings> {
    return project(await this.load());
  }

  /**
   * Compare-and-swap over one record. `expectedRevision` is the revision the
   * caller read; a stale value throws `StardewPlayerSettingsRevisionConflict`
   * rather than overwriting a newer answer.
   *
   * The write is a merge over whatever the file currently holds, not a
   * replacement of the document: `load()` returns the record's own fields and
   * `writeAtomically` re-reads the file's raw object and patches only the four
   * keys this store owns. A field somebody added by hand - a future setting, a
   * field a player documented for themselves - survives every save. That is the
   * same whole-record-replacement defect this repository has fixed twice, and it
   * is what a browser payload must never be able to reintroduce.
   */
  async update(expectedRevision: number, update: StardewPlayerSettingsUpdate): Promise<StardewPlayerSettings> {
    if (!(isRevision(expectedRevision) && isUpdate(update))) throw new Error("invalid_stardew_player_settings_update");
    const path = this.path;
    return await withPathLock(path, async () => {
      const current = await this.load();
      if (current.revision !== expectedRevision) throw new StardewPlayerSettingsRevisionConflict();
      const next: StoredStardewPlayerSettings = Object.freeze({
        schemaVersion: STARDEW_PLAYER_SETTINGS_SCHEMA_VERSION,
        revision: current.revision + 1,
        deniedActionFamilies: Object.freeze([...update.deniedActionFamilies].sort()),
        advanceDayMinimumOnlineFarmers: update.advanceDayMinimumOnlineFarmers,
      });
      await this.writeMergingForeignKeys(next);
      const readBack = await this.load();
      if (
        readBack.revision !== next.revision ||
        readBack.advanceDayMinimumOnlineFarmers !== next.advanceDayMinimumOnlineFarmers ||
        JSON.stringify(readBack.deniedActionFamilies) !== JSON.stringify(next.deniedActionFamilies)
      )
        throw new Error("stardew_player_settings_readback_mismatch");
      return project(readBack);
    });
  }

  /**
   * Writes the record's own keys into the document and leaves every other key
   * exactly as it was found. An absent document starts empty, so the first save
   * creates the record and nothing else.
   */
  private async writeMergingForeignKeys(next: StoredStardewPlayerSettings): Promise<void> {
    const existing = await this.readRawDocument();
    const merged: Record<string, unknown> = {
      ...existing,
      schemaVersion: next.schemaVersion,
      revision: next.revision,
      deniedActionFamilies: next.deniedActionFamilies,
      advanceDayMinimumOnlineFarmers: next.advanceDayMinimumOnlineFarmers,
    };
    await atomicWriteFile(this.path, JSON.stringify(merged));
  }

  /**
   * The document as it is on disk, with no validation: only the merge needs it,
   * and it must preserve keys this module knows nothing about. A file that is
   * not a JSON object is a corrupt record, not a document to merge into.
   */
  private async readRawDocument(): Promise<Record<string, unknown>> {
    let value: unknown;
    try {
      value = await readStrictJsonFile(this.path);
    } catch (error) {
      if (isNotFound(error)) return {};
      throw new Error("invalid_stardew_player_settings_store");
    }
    if (!isRecord(value)) throw new Error("invalid_stardew_player_settings_store");
    return { ...value };
  }

  private async load(): Promise<StoredStardewPlayerSettings> {
    try {
      return validateStored(await readStrictJsonFile(this.path));
    } catch (error) {
      if (isNotFound(error)) return DEFAULT_STARDEW_PLAYER_SETTINGS;
      throw new Error("invalid_stardew_player_settings_store");
    }
  }
}

/** The player's stored settings, or the defaults when nothing has been saved yet. */
export async function readStardewPlayerSettings(runtimeRoot: string): Promise<StardewPlayerSettings> {
  return new StardewPlayerSettingsStore(runtimeRoot).read();
}

function project(value: StoredStardewPlayerSettings): StardewPlayerSettings {
  return Object.freeze({
    revision: value.revision,
    deniedActionFamilies: value.deniedActionFamilies,
    advanceDayMinimumOnlineFarmers: value.advanceDayMinimumOnlineFarmers,
  });
}

function validateStored(value: unknown): StoredStardewPlayerSettings {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STARDEW_PLAYER_SETTINGS_SCHEMA_VERSION ||
    !isRevision(value.revision) ||
    !isDeniedFamilies(value.deniedActionFamilies) ||
    !isMinimumOnlineFarmers(value.advanceDayMinimumOnlineFarmers)
  )
    throw new Error("invalid_stardew_player_settings_store");
  return Object.freeze({
    schemaVersion: STARDEW_PLAYER_SETTINGS_SCHEMA_VERSION,
    revision: value.revision,
    deniedActionFamilies: Object.freeze([...(value.deniedActionFamilies as readonly string[])]),
    advanceDayMinimumOnlineFarmers: value.advanceDayMinimumOnlineFarmers as number,
  });
}

function isUpdate(value: unknown): value is StardewPlayerSettingsUpdate {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "deniedActionFamilies") &&
    Object.hasOwn(value, "advanceDayMinimumOnlineFarmers") &&
    isDeniedFamilies(value.deniedActionFamilies) &&
    isMinimumOnlineFarmers(value.advanceDayMinimumOnlineFarmers)
  );
}

/**
 * A denial list is a set of catalog family ids: bounded, sorted and duplicated
 * entries refused, so a stored value can never mean two different things
 * depending on which reader looked at it.
 */
function isDeniedFamilies(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > STARDEW_DENIED_FAMILY_LIMIT) return false;
  if (!value.every((entry) => typeof entry === "string" && STARDEW_ACTION_FAMILY_ID_PATTERN.test(entry))) return false;
  return new Set(value).size === value.length;
}

function isMinimumOnlineFarmers(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MINIMUM_ONLINE_FARMERS_MIN &&
    value <= MINIMUM_ONLINE_FARMERS_MAX
  );
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
