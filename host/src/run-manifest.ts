import { createHash } from "node:crypto";
import type { IdentityProfileMetadata } from "./identity-profile.js";
import type { IntegrationActionPolicy } from "./game-integration-adapter.js";
import { atomicWriteFile, withPathLock } from "./path-lock.js";
import type { PresentationProfile } from "./presentation.js";
import type { CompanionIdentity, RuntimePaths } from "./runtime.js";
import { readStrictJsonFile } from "./strict-json-reader.js";
import type { WorldBookMetadata } from "./worldbook.js";

export type CompanionRunManifest = Readonly<{
  schemaVersion: 1;
  identity: CompanionIdentity;
  runtime: Readonly<{ pi: string; magicContext: string }>;
  model: Readonly<{
    provider: string | null;
    modelId: string | null;
    thinkingLevel: string | null;
  }>;
  gameplaySubagentModel: Readonly<{
    provider: string;
    modelId: string;
    thinkingLevel: string;
  }> | null;
  actionRegistryRevision: string;
  actionPolicy: IntegrationActionPolicy;
  mountedTools: readonly string[];
  knowledge: Readonly<{
    mounted: boolean;
    gameVersion: string | null;
    bundleVersion: number | null;
  }>;
  identityProfile: IdentityProfileMetadata;
  worldBook: WorldBookMetadata | null;
  presentation: PresentationProfile | null;
  featureFlags: Readonly<{
    gameplaySubagent: boolean;
    /** Domain selection is recorded, while individual Memory capabilities stay fail-closed. */
    magicContextMemoryDomain: "ongoing-interaction";
    magicContextMemoryEnabled: boolean;
    magicContextAutoPromoteEnabled: boolean;
    magicContextAutoSearchEnabled: false;
  }>;
}>;

export async function writeOrVerifyRunManifest(paths: RuntimePaths, manifest: CompanionRunManifest): Promise<void> {
  const path = paths.runManifestPath;
  return withPathLock(path, async () => {
    const serialized = JSON.stringify(manifest, null, 2);
    try {
      const previous = parseManifest(await readStrictJsonFile(path));
      if (immutableFingerprint(previous) !== immutableFingerprint(manifest)) throw new Error("run_manifest_mismatch");
      // The model is the one field a player changes after the fact: it names their activated
      // connection, and a root that had none when it first opened gains one later. So it is
      // refreshed rather than verified - verifying it would refuse to reopen exactly the fresh
      // install that just followed the product's own guidance, and ignoring it would leave this
      // record naming a model the run no longer uses.
      if (JSON.stringify(previous) !== serialized) await atomicWriteFile(path, serialized);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await atomicWriteFile(path, serialized);
        return;
      }
      if (error instanceof Error && error.message === "invalid_strict_json_file")
        throw new Error("invalid_run_manifest");
      throw error;
    }
  });
}

export function actionRegistryRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * The immutable half of a manifest, which is what `run_manifest_mismatch` compares.
 *
 * It excludes exactly the fields the player owns at runtime. Today that is `model` alone: the
 * selected provider/model is the player's activated connection, so a root that gained one between
 * two mounts must still open, while every genuinely fixed fact - identity, tool set, adapter
 * policy, knowledge bundle, presentation - stays verified.
 */
function immutableFingerprint(value: unknown): string {
  const immutable =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "model"))
      : value;
  return createHash("sha256").update(JSON.stringify(immutable)).digest("hex");
}

function parseManifest(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_run_manifest");
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
