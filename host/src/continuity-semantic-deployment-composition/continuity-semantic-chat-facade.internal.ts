import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import {
  createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { ProductionChatRuntimeReadback } from "../continuity-semantic-store/continuity-semantic-production-store.js";

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
 * The sole deployment-path Chat composition. The selected manifest is loaded
 * here, while authority, Windows mutex, binding, and Host materializer remain
 * owned by the production coordinator. This module is deliberately not a
 * public deployment facade and does not mount a UI/runtime entrypoint.
 */
export async function createFreshUnmountedChatSemanticFacade(
  manifestPath: string,
): Promise<ConstructedUnmountedChatSemanticFacade> {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    throw new Error("invalid_chat_semantic_composition_input");
  }
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(manifest);
  return Object.freeze({
    authority: "SEMANTIC" as const,
    startChatRuntime: authority.startChatRuntime,
    startMountedChatRuntime: authority.startMountedChatRuntime,
    close: authority.close,
  });
}
