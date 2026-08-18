import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import {
  acceptMountedP4DurableTurn,
  consumeMountedP4Admission,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import {
  acceptP4MountedPlayerMessage,
  type AcceptedQueuedTurn,
} from "./chat-thread-store.js";

type P4MountedAcceptanceCommand = Readonly<{
  text: string;
  locale: string;
  idempotencyKey: string;
  expectedDraftRevision: number;
}>;

/**
 * The only P4 composition bridge. The public facade supplies no callback and
 * neither ordinary consumers nor the facade can obtain an admission.
 */
export async function acceptMountedP4DurableTurnFromFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  command: P4MountedAcceptanceCommand,
): Promise<AcceptedQueuedTurn> {
  return acceptMountedP4DurableTurn(manifest, lease, (admission) =>
    consumeMountedP4Admission(admission, (binding) => acceptP4MountedPlayerMessage(binding, command)),
  );
}
