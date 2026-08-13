import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withPathLock } from "../path-lock.js";
import type { CompanionModelConfig } from "../runtime.js";

export const MODEL_PROFILE_MODEL_ID = "deepseek-v4-flash" as const;
export type ModelProfileSurface = "chat" | "game";
export type ModelThinkingLevel = "high";
export type ModelProfile = Readonly<{
  surface: ModelProfileSurface;
  revision: number;
  modelId: typeof MODEL_PROFILE_MODEL_ID;
  thinkingLevel: ModelThinkingLevel;
}>;
export type ModelProfileUpdate = Readonly<{
  modelId: typeof MODEL_PROFILE_MODEL_ID;
  thinkingLevel: ModelThinkingLevel;
}>;
type StoredProfiles = Readonly<{ schemaVersion: 1; chat: StoredProfile; game: StoredProfile }>;
type StoredProfile = Readonly<{
  revision: number;
  modelId: typeof MODEL_PROFILE_MODEL_ID;
  thinkingLevel: ModelThinkingLevel;
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

  /** @deprecated Activation is not a model preference and cannot be changed. */
  async setActive(_surface: ModelProfileSurface, _expectedRevision: number, _active: boolean): Promise<never> {
    throw new Error("model_profile_activation_removed");
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
      return validateStored(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if (isNotFound(error)) return DEFAULT_PROFILES;
      throw new Error("invalid_model_profile_store");
    }
  }
}

const DEFAULT_PROFILE: StoredProfile = Object.freeze({
  revision: 0,
  modelId: MODEL_PROFILE_MODEL_ID,
  thinkingLevel: "high",
});
const DEFAULT_PROFILES: StoredProfiles = Object.freeze({
  schemaVersion: 1,
  chat: DEFAULT_PROFILE,
  game: DEFAULT_PROFILE,
});

/**
 * Resolves the sole approved preference into the runtime's approved model shape.
 * A preference makes no credential, connection, or liveness claim.
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
  if (!record(value) || value.schemaVersion !== 1 || !validProfile(value.chat) || !validProfile(value.game))
    throw new Error("invalid_model_profile_store");
  return Object.freeze({ schemaVersion: 1, chat: freezeProfile(value.chat), game: freezeProfile(value.game) });
}
function freezeProfile(value: Record<string, unknown>): StoredProfile {
  return Object.freeze({
    revision: value.revision as number,
    modelId: value.modelId as typeof MODEL_PROFILE_MODEL_ID,
    thinkingLevel: value.thinkingLevel as ModelThinkingLevel,
  });
}
function validProfile(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    isRevision(value.revision) &&
    value.modelId === MODEL_PROFILE_MODEL_ID &&
    value.thinkingLevel === "high" &&
    (Object.keys(value).length === 3 || (Object.keys(value).length === 4 && typeof value.active === "boolean"))
  );
}
function validPublicProfile(value: unknown): value is ModelProfile {
  return (
    record(value) &&
    isSurface(value.surface) &&
    isRevision(value.revision) &&
    value.modelId === MODEL_PROFILE_MODEL_ID &&
    value.thinkingLevel === "high" &&
    Object.keys(value).length === 4
  );
}
function isUpdate(value: unknown): value is ModelProfileUpdate {
  return (
    record(value) &&
    value.modelId === MODEL_PROFILE_MODEL_ID &&
    value.thinkingLevel === "high" &&
    Object.keys(value).length === 2
  );
}
function isSurface(value: unknown): value is ModelProfileSurface {
  return value === "chat" || value === "game";
}
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function writeAtomically(path: string, value: StoredProfiles): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
