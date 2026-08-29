import {
  claimMountedAttempt,
  consumeMountedAttemptAdmission,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { type AttemptStartingTurn, claimP4MountedAttempt } from "./chat-thread-store.js";

/** The only P4b composition bridge; it has no provider/session imports. */
export async function claimMountedP4ProviderAttemptFromFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): Promise<AttemptStartingTurn> {
  return claimMountedAttempt(manifest, lease, (admission) =>
    consumeMountedAttemptAdmission(admission, (binding) => claimP4MountedAttempt(binding)),
  );
}
