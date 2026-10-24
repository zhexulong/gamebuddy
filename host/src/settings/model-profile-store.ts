import { atomicWriteFile, withPathLock } from "../path-lock.js";
import { readStrictJsonFile } from "../strict-json-reader.js";

/**
 * The one active model profile per surface (design/28 §2.3): the Chat profile
 * and the Game profile each name their own thinking level.
 *
 * This store names no model and no provider, and that is the whole point: this
 * product ships no model endpoint, so the model a surface runs with comes from
 * the player's own active connection - the one thing that knows a provider, a
 * model id and an endpoint together. A profile that carried a model id of its
 * own would be a second, unreadable spelling of that choice: it could name a
 * model no connection serves, and nothing but the connection decides whether it
 * exists.
 *
 * What is left is genuinely the surface's own: how much the companion reasons
 * before she answers in the Chat, and before she acts in the Game. The level is
 * the exact string the embedded runtime receives (design/28 §2.3.2, §2.3.5).
 */

/** Bound for a player-typed thinking level: a short token, never arbitrary text. */
const THINKING_LEVEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export type ModelProfileSurface = "chat" | "game";
export type ModelProfile = Readonly<{
  surface: ModelProfileSurface;
  revision: number;
  thinkingLevel: string;
}>;
export type ModelProfileUpdate = Readonly<{
  thinkingLevel: string;
}>;
type StoredProfiles = Readonly<{ schemaVersion: 1; chat: StoredProfile; game: StoredProfile }>;
type StoredProfile = Readonly<{
  revision: number;
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

/**
 * What a root starts from. It names only the level the runtime is comfortable with, because that
 * is the only thing this store still owns: the model is the player's active connection's, and a
 * fresh root has none, so a fresh root has no model (see the surfaces' own construction).
 */
const DEFAULT_PROFILE: StoredProfile = Object.freeze({ revision: 0, thinkingLevel: "high" });
const DEFAULT_PROFILES: StoredProfiles = Object.freeze({
  schemaVersion: 1,
  chat: DEFAULT_PROFILE,
  game: DEFAULT_PROFILE,
});

function project(surface: ModelProfileSurface, profile: StoredProfile): ModelProfile {
  return Object.freeze({ surface, revision: profile.revision, thinkingLevel: profile.thinkingLevel });
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
/**
 * A legacy `modelId` member is tolerated and dropped, never preserved.
 *
 * A profile written before this store stopped owning a model id still carries one, and a root that
 * upgraded must not fail to load because of a field the product no longer reads: the player's real
 * model is their active connection's, and the stale member can only disagree with it. It is not
 * rewritten on read - reading is not writing - so the field disappears at the first save.
 */
function validStoredProfile(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  const keys = Object.keys(value).filter((key) => key !== "modelId");
  return (
    isRevision(value.revision) &&
    isThinkingLevel(value.thinkingLevel) &&
    keys.length === 2 &&
    keys.every((key) => key === "revision" || key === "thinkingLevel")
  );
}
function freezeProfile(value: Record<string, unknown>): StoredProfile {
  return Object.freeze({
    revision: value.revision as number,
    thinkingLevel: value.thinkingLevel as string,
  });
}
function isUpdate(value: unknown): value is ModelProfileUpdate {
  return record(value) && isThinkingLevel(value.thinkingLevel) && Object.keys(value).length === 1;
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
