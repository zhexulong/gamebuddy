import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { AttemptStartingTurn } from "./chat-thread-store.js";
import { claimMountedP4ProviderAttemptFromFacade } from "./p4-provider-attempt.internal.js";

export type P4ProviderAttemptFacade = Readonly<{
  /**
   * Claims the already-accepted exact turn. This is deliberately not a prompt
   * operation: P4b has no provider, presentation, or session capability.
   */
  claim(): Promise<AttemptStartingTurn>;
}>;

/**
 * Binds the P4b attempt claim to the deployment principal and a current
 * coordinator-branded mount. The caller supplies no turn/runtime facts.
 */
export function createP4ProviderAttemptFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): P4ProviderAttemptFacade {
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  return Object.freeze({
    async claim(): Promise<AttemptStartingTurn> {
      try {
        return await claimMountedP4ProviderAttemptFromFacade(manifest, lease);
      } catch (error) {
        if (
          error instanceof Error &&
          /semantic_chat_runtime_p4_attempt_admission_rejected|semantic_chat_runtime_authority_closed/.test(
            error.message,
          )
        )
          throw unavailable();
        throw error;
      }
    },
  });
}

function unavailable(): Error {
  return new Error("p4_provider_attempt_unavailable");
}
