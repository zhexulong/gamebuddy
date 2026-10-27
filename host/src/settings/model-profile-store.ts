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
/** The bounds the connection form's own fields carry, so a profile cannot hold an id the form would reject. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value);
}
function isProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

export type ModelProfileSurface = "chat" | "game";
export type ModelProfile = Readonly<{
  surface: ModelProfileSurface;
  revision: number;
  thinkingLevel: string;
  /**
   * This surface's own provider/model, when the player gave it one.
   *
   * Absent is the ordinary state and means "use the active connection": one connection is the authority for the whole
   * product, so a player who configured it once is not asked to configure it again for a second surface. Present, it
   * overrides the connection for that surface alone - which is the only way to run the companion on one model in Chat
   * and a cheaper or more literal one in the Game, where she reasons before she acts.
   */
  modelId?: string;
  providerId?: string;
}>;
export type ModelProfileUpdate = Readonly<{
  thinkingLevel: string;
  modelId?: string | null;
  providerId?: string | null;
}>;
type StoredProfiles = Readonly<{ schemaVersion: 1; chat: StoredProfile; game: StoredProfile }>;
type StoredProfile = Readonly<{
  revision: number;
  thinkingLevel: string;
  modelId?: string;
  providerId?: string;
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
      thinkingLevel: update.thinkingLevel,
      // The override is written only when the update states it. Naming neither keeps whatever this surface held - changing
      // how much she reasons is not a reason to drop the model the player pinned here - and naming both as `null` clears
      // it, which is the only way back to the active connection.
      ...(update.modelId === undefined && update.providerId === undefined
        ? current.modelId === undefined || current.providerId === undefined
          ? {}
          : { modelId: current.modelId, providerId: current.providerId }
        : update.modelId === null || update.providerId === null
          ? {}
          : { modelId: update.modelId, providerId: update.providerId }),
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
      // The persisted order is the order `freezeProfile` reads back with, because the readback check compares the two
      // documents as JSON text. Spelling it out here keeps that true without depending on the key order a caller's
      // object literal happened to have - which is exactly how this broke once.
      const changed = change(current);
      const next: StoredProfile = Object.freeze({
        revision: current.revision + 1,
        thinkingLevel: changed.thinkingLevel,
        ...(changed.modelId === undefined ? {} : { modelId: changed.modelId }),
        ...(changed.providerId === undefined ? {} : { providerId: changed.providerId }),
      });
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
  return Object.freeze({
    surface,
    revision: profile.revision,
    thinkingLevel: profile.thinkingLevel,
    ...(profile.modelId === undefined ? {} : { modelId: profile.modelId }),
    ...(profile.providerId === undefined ? {} : { providerId: profile.providerId }),
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
  const known = ["revision", "thinkingLevel", "modelId", "providerId"];
  if (!Object.keys(value).every((key) => known.includes(key))) return false;
  if (!isRevision(value.revision) || !isThinkingLevel(value.thinkingLevel)) return false;
  if (value.modelId !== undefined && !isModelId(value.modelId)) return false;
  if (value.providerId !== undefined && !isProviderId(value.providerId)) return false;
  // A provider without a model names nothing to run, so that half is still refused.
  //
  // The other half is NOT refused any more: a model without its provider is exactly what every root
  // upgraded from the previous format has on disk, and the comment above promises those load. It used to
  // be refused here, which turned that promise into documentation - measured 2026-10-27, a real root
  // written on 2026-10-24 failed every live run at step 0 with `invalid_model_profile_store` before a
  // single game action. `freezeProfile` drops the orphaned id, so the pair rule is preserved where it
  // matters (nothing resolves a model without a provider) without bricking the read.
  return value.providerId === undefined || value.modelId !== undefined;
}
function freezeProfile(value: Record<string, unknown>): StoredProfile {
  // An orphaned `modelId` - a model with no provider - is dropped here rather than refused above. The
  // product cannot resolve it, so keeping it would only let a stale id disagree with the player's active
  // connection; dropping it is what the tolerance in `validStoredProfile` is FOR.
  const paired = value.modelId !== undefined && value.providerId !== undefined;
  return Object.freeze({
    revision: value.revision as number,
    thinkingLevel: value.thinkingLevel as string,
    ...(paired ? { modelId: value.modelId as string, providerId: value.providerId as string } : {}),
  });
}
function isUpdate(value: unknown): value is ModelProfileUpdate {
  if (!record(value) || !isThinkingLevel(value.thinkingLevel)) return false;
  const known = ["thinkingLevel", "modelId", "providerId"];
  if (!Object.keys(value).every((key) => known.includes(key))) return false;
  const model = value.modelId;
  const provider = value.providerId;
  // Neither mentioned: only the level changes, and the surface keeps whatever override it had.
  if (model === undefined && provider === undefined) return true;
  if (model !== null && !isModelId(model)) return false;
  if (provider !== null && !isProviderId(provider)) return false;
  if (model === undefined || provider === undefined) return false;
  // Set together, or cleared together. A half-stated pair names nothing this product can resolve.
  return (model === null) === (provider === null);
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
