import type { HostDeploymentManifest } from "../deployment-manifest.js";
import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { AcceptedQueuedTurn } from "./chat-thread-store.js";
import { acceptMountedP4DurableTurnFromFacade } from "./p4-durable-turn-acceptance.internal.js";

/** Caller input contains only player-authored command fields, never authority binding facts. */
export type P4AcceptPlayerMessageCommand = Readonly<{
  text: string;
  locale: string;
  idempotencyKey: string;
  expectedDraftRevision: number;
}>;
export type P4DurableTurnAcceptanceFacade = Readonly<{
  accept(command: P4AcceptPlayerMessageCommand): Promise<AcceptedQueuedTurn>;
}>;

/**
 * Binds durable acceptance to the deployment principal and a coordinator-branded
 * current mount. No browser input can select a thread, surface, or generation.
 */
export function createP4DurableTurnAcceptanceFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): P4DurableTurnAcceptanceFacade {
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  return Object.freeze({
    async accept(command): Promise<AcceptedQueuedTurn> {
      try {
        return await acceptMountedP4DurableTurnFromFacade(manifest, lease, Object.freeze({
          text: command.text.normalize("NFC"),
          locale: command.locale,
          idempotencyKey: command.idempotencyKey,
          expectedDraftRevision: command.expectedDraftRevision,
        }));
      } catch (error) {
        if (error instanceof Error && /semantic_chat_runtime_p4_admission_rejected|semantic_chat_runtime_authority_closed/.test(error.message)) throw unavailable();
        throw error;
      }
    },
  });
}
function unavailable(): Error { return new Error("p4_durable_turn_acceptance_unavailable"); }
