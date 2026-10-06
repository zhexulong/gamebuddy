import { atomicWriteFile, withPathLock } from "../path-lock.js";
import type { CompanionModelConfig } from "../runtime.js";
import { PLAYER_MODEL_ID_PATTERN } from "../runtime-identity.js";
import { readStrictJsonFile } from "../strict-json-reader.js";

/**
 * The one active model profile per surface (design/28 §2.3): the Chat profile
 * and the Game profile each name their own model id and thinking level.
 *
 * Both fields are the player's own input. A model id is a general bounded
 * string — any vendor name, a local server's model, a third-party gateway's
 * spelling — and a thinking level is the exact string the embedded runtime
 * receives. Neither is a closed union and neither is validated against the
 * shipped catalog: the recommended catalog is guidance, never the upper bound
 * of what a player may save (design/28 §2.3.1, §2.3.2, §2.3.7).
 */

/** Bound for a player-typed thinking level: a short token, never arbitrary text. */
const THINKING_LEVEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export type ModelProfileSurface = "chat" | "game";
export type ModelProfile = Readonly<{
  surface: ModelProfileSurface;
  revision: number;
  modelId: string;
  thinkingLevel: string;
}>;
export type ModelProfileUpdate = Readonly<{
  modelId: string;
  thinkingLevel: string;
}>;
type StoredProfiles = Readonly<{ schemaVersion: 1; chat: StoredProfile; game: StoredProfile }>;
type StoredProfile = Readonly<{
  revision: number;
  modelId: string;
  thinkingLevel: string;
}>;

export class ModelProfileRevisionConflict extends Error {
  constructor() {
    super("model_profile_revision_conflict");
  }
}

/** Durable Host-owned preference store. It never reads, writes, or exposes credentials. */
export class ModelProfileStore {
  constructor(private readonly path: string) {}

  async read(surface: ModelProfileSurface): Promise<ModelProfile> {
    const profiles = await this.load();
    return project(surface, profiles[surface]);
  }

  async update(
    surface: ModelProfileSurface,
    expectedRevision: number,
    update: ModelProfileUpdate,
  ): Promise<ModelProfile> {
    if (!isSurface(surface) || !isRevision(expectedRevision) || !isUpdate(update))
      throw new Error("invalid_model_profile_update");
    return this.mutate(surface, expectedRevision, (current) => ({
      ...current,
      modelId: update.modelId,
      thinkingLevel: update.thinkingLevel,
    }));
  }

  private async mutate(
    surface: ModelProfileSurface,
    expectedRevision: number,
    change: (current: StoredProfile) => Omit<StoredProfile, "revision">,
  ): Promise<ModelProfile> {
    return withPathLock(this.path, async () => {
      const profiles = await this.load();
      const current = profiles[surface];
      if (current.revision !== expectedRevision) throw new ModelProfileRevisionConflict();
      const next: StoredProfile = Object.freeze({ ...change(current), revision: current.revision + 1 });
      const persisted: StoredProfiles = Object.freeze({ ...profiles, [surface]: next });
      await writeAtomically(this.path, persisted);
      const readBack = await this.load();
      if (JSON.stringify(readBack) !== JSON.stringify(persisted)) throw new Error("model_profile_readback_mismatch");
      return project(surface, readBack[surface]);
    });
  }

  private async load(): Promise<StoredProfiles> {
    try {
      return validateStored(await readStrictJsonFile(this.path));
    } catch (error) {
      if (isNotFound(error)) return DEFAULT_PROFILES;
      throw new Error("invalid_model_profile_store");
    }
  }
}

/** The shipped recommendation a root starts from; a player may replace either field. */
const DEFAULT_PROFILE: StoredProfile = Object.freeze({
  revision: 0,
  modelId: "deepseek-v4-flash",
  thinkingLevel: "high",
});
const DEFAULT_PROFILES: StoredProfiles = Object.freeze({
  schemaVersion: 1,
  chat: DEFAULT_PROFILE,
  game: DEFAULT_PROFILE,
});

/**
 * Resolves the player's saved preference into the runtime's model shape. The
 * profile makes no credential, connection, or liveness claim, and its model id
 * is never checked against the recommended catalog: a profile that saves is a
 * profile the runtime is constructed with (design/28 §2.3.1).
 */
export function resolveModelProfileConfig(profile: ModelProfile): CompanionModelConfig | null {
  if (!validPublicProfile(profile)) return null;
  return Object.freeze({ provider: "cpa-oai", modelId: profile.modelId, thinkingLevel: profile.thinkingLevel });
}

function project(surface: ModelProfileSurface, profile: StoredProfile): ModelProfile {
  return Object.freeze({
    surface,
    revision: profile.revision,
    modelId: profile.modelId,
    thinkingLevel: profile.thinkingLevel,
  });
}
function validateStored(value: unknown): StoredProfiles {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !validStoredProfile(value.chat) ||
    !validStoredProfile(value.game) ||
    !hasExactKeys(value, ["schemaVersion", "chat", "game"])
  )
    throw new Error("invalid_model_profile_store");
  return Object.freeze({ schemaVersion: 1, chat: freezeProfile(value.chat), game: freezeProfile(value.game) });
}
function freezeProfile(value: Record<string, unknown>): StoredProfile {
  return Object.freeze({
    revision: value.revision as number,
    modelId: value.modelId as string,
    thinkingLevel: value.thinkingLevel as string,
  });
}
function validStoredProfile(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    isRevision(value.revision) &&
    isModelId(value.modelId) &&
    isThinkingLevel(value.thinkingLevel) &&
    hasExactKeys(value, ["revision", "modelId", "thinkingLevel"])
  );
}
function validPublicProfile(value: unknown): value is ModelProfile {
  return (
    record(value) &&
    isSurface(value.surface) &&
    isRevision(value.revision) &&
    isModelId(value.modelId) &&
    isThinkingLevel(value.thinkingLevel) &&
    Object.keys(value).length === 4
  );
}
function isUpdate(value: unknown): value is ModelProfileUpdate {
  return (
    record(value) &&
    isModelId(value.modelId) &&
    isThinkingLevel(value.thinkingLevel) &&
    Object.keys(value).length === 2
  );
}
function isModelId(value: unknown): value is string {
  return typeof value === "string" && PLAYER_MODEL_ID_PATTERN.test(value);
}
function isThinkingLevel(value: unknown): value is string {
  return typeof value === "string" && THINKING_LEVEL_PATTERN.test(value);
}
function isSurface(value: unknown): value is ModelProfileSurface {
  return value === "chat" || value === "game";
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
async function writeAtomically(path: string, value: StoredProfiles): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(value));
}
