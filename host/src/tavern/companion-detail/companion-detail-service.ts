import { join } from "node:path";
import { TavernArtifactStore } from "../artifact-store.js";
import type { TavernPaths } from "../tavern-paths.js";
import { validateTavernArtifact, type TavernCompanion } from "../types.js";

/**
 * Read-only player-safe projection of the canonical companion record.
 * This boundary deliberately excludes identifiers, continuity, artifact hashes,
 * paths, raw profiles, sources, lifecycle state, and all mutation operations.
 */
export type TavernCompanionDetail = Readonly<{
  name: string;
}>;

export type TavernCompanionDetailService = Readonly<{
  read(): Promise<TavernCompanionDetail>;
}>;

export function createCompanionDetailService(
  paths: TavernPaths,
  store: TavernArtifactStore,
): TavernCompanionDetailService {
  const companionPath = join(paths.companionRoot, "companion.json");
  return Object.freeze({
    async read(): Promise<TavernCompanionDetail> {
      const artifact = (await store.read(companionPath, validateTavernArtifact)).artifact;
      if (!isCompanion(artifact)) throw new Error("invalid_tavern_companion");
      if (artifact.companionId !== paths.companionId || artifact.continuityId !== paths.continuityId)
        throw new Error("tavern_companion_scope_mismatch");
      return Object.freeze({ name: artifact.name });
    },
  });
}

function isCompanion(value: unknown): value is TavernCompanion {
  return typeof value === "object" && value !== null && "companionId" in value && "profileId" in value;
}
