import { atomicWriteFile, withPathLock } from "../path-lock.js";
import { readStrictJsonFile } from "../strict-json-reader.js";
import { join } from "node:path";

/**
 * Host-owned companion language preference. The frontend (Tavern) is the
 * single configuration point for the companion language; everything that
 * needs a locale (Agent prompt/session language, companion presentation
 * locale, fixture required-live-locale) reads this same preference instead of
 * each side hard-coding its own.
 */
export const COMPANION_LOCALE_SCHEMA_VERSION = 1 as const;
export type CompanionLocale = "zh-CN" | "en-US";

/** The companion language when the player has not chosen one. */
export const DEFAULT_COMPANION_LOCALE: CompanionLocale = "zh-CN";

/**
 * The single root-level path of the preference. One path, one authority: the
 * management surface writes it and every runtime reads it, so neither side
 * carries a locale of its own.
 */
export function companionLocalePath(runtimeRoot: string): string {
  return join(runtimeRoot, "settings", "language-preference.json");
}

export type LanguagePreference = Readonly<{
  revision: number;
  /** Canonical companion language; null means "not configured yet". */
  locale: CompanionLocale | null;
}>;

export type LanguagePreferenceUpdate = Readonly<{ locale: CompanionLocale }>;

type StoredLanguagePreference = Readonly<{
  schemaVersion: typeof COMPANION_LOCALE_SCHEMA_VERSION;
  revision: number;
  locale: CompanionLocale | null;
}>;

export class LanguagePreferenceRevisionConflict extends Error {
  constructor() {
    super("language_preference_revision_conflict");
  }
}

/** Durable Host-owned companion language preference (Tavern single point). */
export class LanguagePreferenceStore {
  constructor(private readonly path: string) {}

  async read(): Promise<LanguagePreference> {
    return project(await this.load());
  }

  async update(
    expectedRevision: number,
    update: LanguagePreferenceUpdate,
  ): Promise<LanguagePreference> {
    if (!isRevision(expectedRevision) || !isUpdate(update))
      throw new Error("invalid_language_preference_update");
    return await withPathLock(this.path, async () => {
      const current = await this.load();
      if (current.revision !== expectedRevision)
        throw new LanguagePreferenceRevisionConflict();
      const next: StoredLanguagePreference = Object.freeze({
        schemaVersion: COMPANION_LOCALE_SCHEMA_VERSION,
        revision: current.revision + 1,
        locale: update.locale,
      });
      await writeAtomically(this.path, next);
      const readBack = await this.load();
      if (JSON.stringify(readBack) !== JSON.stringify(next))
        throw new Error("language_preference_readback_mismatch");
      return project(readBack);
    });
  }

  private async load(): Promise<StoredLanguagePreference> {
    try {
      return validateStored(await readStrictJsonFile(this.path));
    } catch (error) {
      if (isNotFound(error)) return DEFAULT_LANGUAGE_PREFERENCE;
      throw new Error("invalid_language_preference_store");
    }
  }
}

/**
 * The player's chosen companion language, or undefined when never configured.
 *
 * The runtime resolves this at mount, so the prompt's single language authority
 * and the presentation locale are the player's choice instead of a hardcoded
 * default. An unreadable or corrupt preference throws rather than silently
 * speaking a language the player did not choose.
 */
export async function readStoredCompanionLocale(
  runtimeRoot: string,
): Promise<CompanionLocale | undefined> {
  const preference = await new LanguagePreferenceStore(companionLocalePath(runtimeRoot)).read();
  return preference.locale ?? undefined;
}

/** The effective companion language: the player's choice, else the default. */
export async function resolveCompanionLocale(runtimeRoot: string): Promise<CompanionLocale> {
  return (await readStoredCompanionLocale(runtimeRoot)) ?? DEFAULT_COMPANION_LOCALE;
}

const DEFAULT_LANGUAGE_PREFERENCE: StoredLanguagePreference = Object.freeze({
  schemaVersion: COMPANION_LOCALE_SCHEMA_VERSION,
  revision: 0,
  locale: null,
});

function project(value: StoredLanguagePreference): LanguagePreference {
  return Object.freeze({
    revision: value.revision,
    locale: value.locale,
  });
}

function validateStored(value: unknown): StoredLanguagePreference {
  if (
    !record(value) ||
    value.schemaVersion !== COMPANION_LOCALE_SCHEMA_VERSION ||
    !isRevision(value.revision) ||
    !isLocaleOrNull(value.locale)
  )
    throw new Error("invalid_language_preference_store");
  return Object.freeze({
    schemaVersion: COMPANION_LOCALE_SCHEMA_VERSION,
    revision: value.revision,
    locale: value.locale,
  });
}

function isUpdate(value: unknown): value is LanguagePreferenceUpdate {
  return (
    record(value) && hasExactKeys(value, ["locale"]) && isLocale(value.locale)
  );
}

function isLocale(value: unknown): value is CompanionLocale {
  return value === "zh-CN" || value === "en-US";
}

function isLocaleOrNull(value: unknown): value is CompanionLocale | null {
  return value === null || isLocale(value);
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

async function writeAtomically(path: string, value: StoredLanguagePreference): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(value));
}