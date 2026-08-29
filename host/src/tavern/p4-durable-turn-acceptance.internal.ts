import {
  acceptMountedDurableTurn,
  consumeMountedDurableAdmission,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { type AcceptedQueuedTurn, acceptP4MountedPlayerMessage } from "./chat-thread-store.js";

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
  return acceptMountedDurableTurn(manifest, lease, (admission) =>
    consumeMountedDurableAdmission(admission, (binding) => acceptP4MountedPlayerMessage(binding, command)),
  );
}
