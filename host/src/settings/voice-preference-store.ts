import { atomicWriteFile, withPathLock } from "../path-lock.js";
import { readStrictJsonFile } from "../strict-json-reader.js";

export const VOICE_CLOUD_TTS_DISCLOSURE_VERSION = "mimo-cloud-tts-v1" as const;

export type VoiceCloudTtsConsent = "undecided" | "accepted" | "revoked";
export type VoicePreference = Readonly<{
  revision: number;
  disclosureVersion: typeof VOICE_CLOUD_TTS_DISCLOSURE_VERSION | null;
  consent: VoiceCloudTtsConsent;
  decidedAtMs: number | null;
}>;
export type VoicePreferenceUpdate =
  | Readonly<{ action: "accept"; disclosureVersion: typeof VOICE_CLOUD_TTS_DISCLOSURE_VERSION }>
  | Readonly<{ action: "revoke" }>;

type StoredVoicePreference = Readonly<VoicePreference>;
type StoredVoicePreferences = Readonly<{
  schemaVersion: 1;
  revision: number;
  disclosureVersion: typeof VOICE_CLOUD_TTS_DISCLOSURE_VERSION | null;
  consent: VoiceCloudTtsConsent;
  decidedAtMs: number | null;
}>;

export class VoicePreferenceRevisionConflict extends Error {
  constructor() {
    super("voice_preference_revision_conflict");
  }
}

/** Durable Host-owned cloud TTS disclosure and consent preference. */
export class VoicePreferenceStore {
  constructor(private readonly path: string) {}

  async read(): Promise<VoicePreference> {
    return project(await this.load());
  }

  async update(expectedRevision: number, update: VoicePreferenceUpdate): Promise<VoicePreference> {
    if (!isRevision(expectedRevision) || !isUpdate(update)) throw new Error("invalid_voice_preference_update");
    return await withPathLock(this.path, async () => {
      const current = await this.load();
      if (current.revision !== expectedRevision) throw new VoicePreferenceRevisionConflict();
      const next: StoredVoicePreferences = Object.freeze({
        schemaVersion: 1,
        revision: current.revision + 1,
        disclosureVersion:
          update.action === "accept" ? update.disclosureVersion : current.disclosureVersion,
        consent: update.action === "accept" ? "accepted" : "revoked",
        decidedAtMs: Date.now(),
      });
      await writeAtomically(this.path, next);
      const readBack = await this.load();
      if (JSON.stringify(readBack) !== JSON.stringify(next)) throw new Error("voice_preference_readback_mismatch");
      return project(readBack);
    });
  }

  private async load(): Promise<StoredVoicePreferences> {
    try {
      return validateStored(await readStrictJsonFile(this.path));
    } catch (error) {
      if (isNotFound(error)) return DEFAULT_VOICE_PREFERENCE;
      throw new Error("invalid_voice_preference_store");
    }
  }
}

const DEFAULT_VOICE_PREFERENCE: StoredVoicePreferences = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  disclosureVersion: null,
  consent: "undecided",
  decidedAtMs: null,
});

function project(value: StoredVoicePreference): VoicePreference {
  return Object.freeze({
    revision: value.revision,
    disclosureVersion: value.disclosureVersion,
    consent: value.consent,
    decidedAtMs: value.decidedAtMs,
  });
}

function validateStored(value: unknown): StoredVoicePreferences {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !isRevision(value.revision) ||
    !isDisclosureVersionOrNull(value.disclosureVersion) ||
    !isConsent(value.consent) ||
    !isDecisionTimeOrNull(value.decidedAtMs) ||
    !hasExactKeys(value, ["schemaVersion", "revision", "disclosureVersion", "consent", "decidedAtMs"])
  )
    throw new Error("invalid_voice_preference_store");

  const disclosureVersion = value.disclosureVersion as typeof VOICE_CLOUD_TTS_DISCLOSURE_VERSION | null;
  if (value.consent === "undecided" && (disclosureVersion !== null || value.decidedAtMs !== null))
    throw new Error("invalid_voice_preference_store");
  if (value.consent === "accepted" && disclosureVersion !== VOICE_CLOUD_TTS_DISCLOSURE_VERSION)
    throw new Error("invalid_voice_preference_store");
  if (value.consent !== "undecided" && value.decidedAtMs === null)
    throw new Error("invalid_voice_preference_store");

  return Object.freeze({
    schemaVersion: 1,
    revision: value.revision,
    disclosureVersion,
    consent: value.consent,
    decidedAtMs: value.decidedAtMs,
  });
}

function isUpdate(value: unknown): value is VoicePreferenceUpdate {
  if (!record(value) || typeof value.action !== "string") return false;
  if (value.action === "accept") {
    return (
      hasExactKeys(value, ["action", "disclosureVersion"]) &&
      value.disclosureVersion === VOICE_CLOUD_TTS_DISCLOSURE_VERSION
    );
  }
  return value.action === "revoke" && hasExactKeys(value, ["action"]);
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function writeAtomically(path: string, value: StoredVoicePreferences): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(value));
}
