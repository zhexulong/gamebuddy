import { createHash } from "node:crypto";
import { atomicWriteFile, withPathLock } from "./path-lock.js";
import { readStrictJsonFile } from "./strict-json-reader.js";
import type { IntegrationActionPolicy } from "./integration-module.js";
import type { CompanionIdentity, CompanionModelConfig, RuntimePaths } from "./runtime.js";
import type { PresentationProfile } from "./presentation.js";
import type { IdentityProfileMetadata } from "./identity-profile.js";
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
      if (fingerprint(previous) !== fingerprint(manifest)) throw new Error("run_manifest_mismatch");
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

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseManifest(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_run_manifest");
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
