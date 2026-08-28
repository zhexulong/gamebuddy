import {
  acceptMountedDurableTurn,
  consumeMountedDurableAdmission,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { type AcceptedQueuedTurn, acceptMountedPlayerMessage } from "./chat-thread-store.js";

type MountedAcceptanceCommand = Readonly<{
  text: string;
  locale: string;
  idempotencyKey: string;
  expectedDraftRevision: number;
}>;

/**
 * The only bridge. The public facade supplies no callback and
 * neither ordinary consumers nor the facade can obtain an admission.
 */
export async function acceptMountedDurableTurnFromFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  command: MountedAcceptanceCommand,
): Promise<AcceptedQueuedTurn> {
  return acceptMountedDurableTurn(manifest, lease, (admission) =>
    consumeMountedDurableAdmission(admission, (binding) => acceptMountedPlayerMessage(binding, command)),
  );
}
