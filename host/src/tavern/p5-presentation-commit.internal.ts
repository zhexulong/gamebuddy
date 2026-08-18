import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { AttemptStartingTurn, CancelledTurn, CompletedTurn, FailedTurn } from "./chat-thread-store.js";
import { createP4ProviderStartFacade } from "./p4-provider-start.js";

/**
 * The non-launchable P5 verification bridge has no post-hoc presentation
 * capability. It delegates to the sole P4c facade, whose one invocation
 * performs both the provider prompt and its in-prompt P5 lifecycle.
 */
export async function startMountedP5PresentationCommitFromFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): Promise<AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn> {
  return createP4ProviderStartFacade(manifest, lease).start();
}
