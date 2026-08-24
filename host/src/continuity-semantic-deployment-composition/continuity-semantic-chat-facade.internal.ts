import {
  createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
  createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
  type MountedChatRuntimeLease,
  type SemanticChatRuntimeMountOptions,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { ProductionChatRuntimeReadback } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";

/** Internal-only unmounted Chat construction product. No runtime internals escape. */
export type ConstructedUnmountedChatSemanticFacade = Readonly<{
  authority: "SEMANTIC";
  /** Legacy internal readback lane retained only for existing construction tests. */
  startChatRuntime(): Promise<ProductionChatRuntimeReadback>;
  /** Mounted Tavern lane; its opaque close authority remains coordinator-owned. */
  startMountedChatRuntime(): Promise<MountedChatRuntimeLease>;
  close(): Promise<void>;
}>;

/**
 * The sole deployment-path Chat composition. Its caller supplies the one
 * already-loaded immutable deployment manifest; authority, Windows mutex,
 * binding, and Host materializer all consume that exact object and remain
 * owned by the production coordinator. This module is deliberately not a
 * public deployment facade and does not mount a UI/runtime entrypoint.
 */
async function createUnmountedChatSemanticFacade(
  authority: Awaited<ReturnType<typeof createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest>>,
): Promise<ConstructedUnmountedChatSemanticFacade> {
  return Object.freeze({
    authority: "SEMANTIC" as const,
    startChatRuntime: authority.startChatRuntime,
    startMountedChatRuntime: authority.startMountedChatRuntime,
    close: authority.close,
  });
}

export async function createFreshUnmountedChatSemanticFacade(
  manifest: HostDeploymentManifest,
  options: SemanticChatRuntimeMountOptions = {},
): Promise<ConstructedUnmountedChatSemanticFacade> {
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest, options);
  return createUnmountedChatSemanticFacade(authority);
}

export async function createKnownUnmountedChatSemanticFacade(
  manifest: HostDeploymentManifest,
  options: SemanticChatRuntimeMountOptions = {},
): Promise<ConstructedUnmountedChatSemanticFacade> {
  return createUnmountedChatSemanticFacade(
    await createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest, options),
  );
}
