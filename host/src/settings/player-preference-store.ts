import { atomicWriteFile, withPathLock } from "../path-lock.js";
import { readStrictJsonFile } from "../strict-json-reader.js";
import { join } from "node:path";

/**
 * Host-owned player preference record. One path, one revision, both field
 * groups: the companion language the runtimes read at mount and the cloud TTS
 * consent/output the Voice surface reads. Every player-visible settings write
 * goes through this one record's compare-and-swap, so a write from either
 * settings surface advances the same revision and a stale expectedRevision is
 * rejected for both.
 */
export const PLAYER_PREFERENCE_SCHEMA_VERSION = 1 as const;

/** The companion language. The frontend (Tavern) is the single configuration
 * point; everything that needs a locale (Agent prompt/session language,
 * companion presentation locale, fixture required-live-locale) reads this same
 * preference instead of each side hard-coding its own. */
export type CompanionLocale = "zh-CN" | "en-US";

/** The companion language when the player has not chosen one. */
export const DEFAULT_COMPANION_LOCALE: CompanionLocale = "zh-CN";

export const VOICE_CLOUD_TTS_DISCLOSURE_VERSION = "mimo-cloud-tts-v1" as const;

/**
 * Player-selectable Voice output endpoint. `null` means "use the Windows
 * default multimedia output at each open"; a `waveout:N` value pins one
 * enumerated endpoint (the Voice Gateway never silently falls back from an
 * explicit selection). The value is an endpoint selection, not a credential.
 */
export type VoiceOutputDevice = string | null;

export type VoiceCloudTtsConsent = "undecided" | "accepted" | "revoked";

/**
 * The single root-level path of the record. One path, one authority: the
 * management surface writes it and every runtime reads it, so neither side
 * carries a preference of its own.
 */
export function playerPreferencePath(runtimeRoot: string): string {
  return join(runtimeRoot, "settings", "player-preference.json");
}

export type PlayerPreference = Readonly<{
  revision: number;
  /** Canonical companion language; null means "not configured yet". */
  locale: CompanionLocale | null;
  /** Cloud TTS disclosure the player last acted on; null when never accepted. */
  disclosureVersion: typeof VOICE_CLOUD_TTS_DISCLOSURE_VERSION | null;
  consent: VoiceCloudTtsConsent;
  decidedAtMs: number | null;
  /** Player-chosen output endpoint; null selects the Windows default. */
  outputDevice: VoiceOutputDevice;
}>;

/**
 * Every field-group write the record accepts. The language surface sends
 * `setLocale`; the Voice surface sends the consent and output actions. Each one
 * is a revision-checked mutation of the same record, never a second authority.
 */
export type PlayerPreferenceUpdate =
  | Readonly<{ action: "setLocale"; locale: CompanionLocale }>
  | Readonly<{ action: "accept"; disclosureVersion: typeof VOICE_CLOUD_TTS_DISCLOSURE_VERSION }>
  | Readonly<{ action: "revoke" }>
  | Readonly<{ action: "setOutputDevice"; outputDevice: VoiceOutputDevice }>;

type StoredPlayerPreference = Readonly<{
  schemaVersion: typeof PLAYER_PREFERENCE_SCHEMA_VERSION;
  revision: number;
  locale: CompanionLocale | null;
  disclosureVersion: typeof VOICE_CLOUD_TTS_DISCLOSURE_VERSION | null;
  consent: VoiceCloudTtsConsent;
  decidedAtMs: number | null;
  outputDevice: VoiceOutputDevice;
}>;

export class PlayerPreferenceRevisionConflict extends Error {
  constructor() {
    super("player_preference_revision_conflict");
  }
}

/** Durable Host-owned player preference (one record for every settings surface). */
export class PlayerPreferenceStore {
  constructor(private readonly path: string) {}

  async read(): Promise<PlayerPreference> {
    return project(await this.load());
  }

  async update(expectedRevision: number, update: PlayerPreferenceUpdate): Promise<PlayerPreference> {
    if (!isRevision(expectedRevision) || !isUpdate(update)) throw new Error("invalid_player_preference_update");
    return await withPathLock(this.path, async () => {
      const current = await this.load();
      if (current.revision !== expectedRevision) throw new PlayerPreferenceRevisionConflict();
      const decidedThisUpdate = update.action === "accept" || update.action === "revoke";
      const next: StoredPlayerPreference = Object.freeze({
        schemaVersion: PLAYER_PREFERENCE_SCHEMA_VERSION,
        revision: current.revision + 1,
        locale: update.action === "setLocale" ? update.locale : current.locale,
        disclosureVersion:
          update.action === "accept" ? update.disclosureVersion : current.disclosureVersion,
        consent:
          update.action === "accept" ? "accepted" : update.action === "revoke" ? "revoked" : current.consent,
        decidedAtMs: decidedThisUpdate ? Date.now() : current.decidedAtMs,
        outputDevice: update.action === "setOutputDevice" ? update.outputDevice : current.outputDevice,
      });
      await writeAtomically(this.path, next);
      const readBack = await this.load();
      if (JSON.stringify(readBack) !== JSON.stringify(next)) throw new Error("player_preference_readback_mismatch");
      return project(readBack);
    });
  }

  private async load(): Promise<StoredPlayerPreference> {
    try {
      return validateStored(await readStrictJsonFile(this.path));
    } catch (error) {
      if (isNotFound(error)) return DEFAULT_PLAYER_PREFERENCE;
      throw new Error("invalid_player_preference_store");
    }
  }
}

/**
 * The player's chosen companion language, or undefined when never configured.
 *
 * The runtime resolves this at mount, so the prompt's single language authority
 * and the presentation locale are the player's choice instead of a hardcoded
 * default. An unreadable or corrupt record throws rather than silently speaking
 * a language the player did not choose.
 */
export async function readStoredCompanionLocale(
  runtimeRoot: string,
): Promise<CompanionLocale | undefined> {
  const preference = await new PlayerPreferenceStore(playerPreferencePath(runtimeRoot)).read();
  return preference.locale ?? undefined;
}

/** The effective companion language: the player's choice, else the default. */
export async function resolveCompanionLocale(runtimeRoot: string): Promise<CompanionLocale> {
  return (await readStoredCompanionLocale(runtimeRoot)) ?? DEFAULT_COMPANION_LOCALE;
}

const DEFAULT_PLAYER_PREFERENCE: StoredPlayerPreference = Object.freeze({
  schemaVersion: PLAYER_PREFERENCE_SCHEMA_VERSION,
  revision: 0,
  locale: null,
  disclosureVersion: null,
  consent: "undecided",
  decidedAtMs: null,
  outputDevice: null,
});

function project(value: StoredPlayerPreference): PlayerPreference {
  return Object.freeze({
    revision: value.revision,
    locale: value.locale,
    disclosureVersion: value.disclosureVersion,
    consent: value.consent,
    decidedAtMs: value.decidedAtMs,
    outputDevice: value.outputDevice,
  });
}

function validateStored(value: unknown): StoredPlayerPreference {
  if (
    !record(value) ||
    value.schemaVersion !== PLAYER_PREFERENCE_SCHEMA_VERSION ||
    !isRevision(value.revision) ||
    !isLocaleOrNull(value.locale) ||
    !isDisclosureVersionOrNull(value.disclosureVersion) ||
    !isConsent(value.consent) ||
    !isDecisionTimeOrNull(value.decidedAtMs) ||
    !isOutputDevice(value.outputDevice) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "revision",
      "locale",
      "disclosureVersion",
      "consent",
      "decidedAtMs",
      "outputDevice",
    ])
  )
    throw new Error("invalid_player_preference_store");

  const disclosureVersion = value.disclosureVersion as typeof VOICE_CLOUD_TTS_DISCLOSURE_VERSION | null;
  const consent = value.consent as VoiceCloudTtsConsent;
  // A consent state and its evidence may never disagree: `undecided` carries no
  // disclosure/timestamp, `accepted` carries exactly the frozen disclosure, and
  // a decided state always carries the moment the player decided.
  if (consent === "undecided" && (disclosureVersion !== null || value.decidedAtMs !== null))
    throw new Error("invalid_player_preference_store");
  if (consent === "accepted" && disclosureVersion !== VOICE_CLOUD_TTS_DISCLOSURE_VERSION)
    throw new Error("invalid_player_preference_store");
  if (consent !== "undecided" && value.decidedAtMs === null)
    throw new Error("invalid_player_preference_store");

  return Object.freeze({
    schemaVersion: PLAYER_PREFERENCE_SCHEMA_VERSION,
    revision: value.revision,
    locale: value.locale as CompanionLocale | null,
    disclosureVersion,
    consent,
    decidedAtMs: value.decidedAtMs as number | null,
    outputDevice: value.outputDevice as VoiceOutputDevice,
  });
}

function isUpdate(value: unknown): value is PlayerPreferenceUpdate {
  if (!record(value) || typeof value.action !== "string") return false;
  if (value.action === "setLocale") {
    return hasExactKeys(value, ["action", "locale"]) && isLocale(value.locale);
  }
  if (value.action === "accept") {
    return (
      hasExactKeys(value, ["action", "disclosureVersion"]) &&
      value.disclosureVersion === VOICE_CLOUD_TTS_DISCLOSURE_VERSION
    );
  }
  if (value.action === "setOutputDevice") {
    return hasExactKeys(value, ["action", "outputDevice"]) && isOutputDevice(value.outputDevice);
  }
  return value.action === "revoke" && hasExactKeys(value, ["action"]);
}

function isLocale(value: unknown): value is CompanionLocale {
  return value === "zh-CN" || value === "en-US";
}

function isLocaleOrNull(value: unknown): value is CompanionLocale | null {
  return value === null || isLocale(value);
}

/**
 * `null` = Windows default output at each open; `waveout:N` pins one endpoint.
 * The shape is bounded and exact: no path, device name, or free text is ever
 * stored, so a stale endpoint cannot be confused with a filesystem target.
 */
function isOutputDevice(value: unknown): value is VoiceOutputDevice {
  return value === null || (typeof value === "string" && /^waveout:\d{1,4}$/.test(value));
}

function isConsent(value: unknown): value is VoiceCloudTtsConsent {
  return value === "undecided" || value === "accepted" || value === "revoked";
}

function isDisclosureVersionOrNull(value: unknown): value is string | null {
  return value === null || value === VOICE_CLOUD_TTS_DISCLOSURE_VERSION;
}

function isDecisionTimeOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function writeAtomically(path: string, value: StoredPlayerPreference): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(value));
}
