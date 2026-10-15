import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { AcceptedQueuedTurn } from "./chat-thread-store.js";
import { acceptMountedDurableTurnFromFacade } from "./player-turn-acceptance.internal.js";

/** Caller input contains only player-authored command fields, never authority binding facts. */
export type AcceptPlayerTurnCommand = Readonly<{
  text: string;
  locale: string;
  idempotencyKey: string;
  expectedDraftRevision: number;
  /**
   * The bounded visible transcript tail the per-turn World Info selection also
   * scans, composed by the Host from the durable read-back. Never browser input.
   */
  boundedVisibleTail?: string;
  /**
   * Same-position variant acceptance: target an existing companion reply and
   * mint no player message. The prompt text then comes from the anchor player
   * message the target answered, never from a newly accepted row.
   */
  variantTargetMessageId?: string;
}>;
export type PlayerTurnAcceptor = Readonly<{
  accept(command: AcceptPlayerTurnCommand): Promise<AcceptedQueuedTurn>;
}>;

/**
 * Binds durable acceptance to the deployment principal and a coordinator-branded
 * current mount. No browser input can select a thread, surface, or generation.
 */
export function createPlayerTurnAcceptor(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): PlayerTurnAcceptor {
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  return Object.freeze({
    async accept(command): Promise<AcceptedQueuedTurn> {
      try {
        return await acceptMountedDurableTurnFromFacade(
          manifest,
          lease,
          Object.freeze({
            text: command.text.normalize("NFC"),
            locale: command.locale,
            idempotencyKey: command.idempotencyKey,
            expectedDraftRevision: command.expectedDraftRevision,
            ...(command.boundedVisibleTail === undefined ? {} : { boundedVisibleTail: command.boundedVisibleTail }),
            ...(command.variantTargetMessageId === undefined
              ? {}
              : { variantTargetMessageId: command.variantTargetMessageId }),
          }),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          /semantic_chat_runtime_p4_admission_rejected|semantic_chat_runtime_authority_closed/.test(error.message)
        )
          throw unavailable();
        throw error;
      }
    },
  });
}
function unavailable(): Error {
  return new Error("p4_durable_turn_acceptance_unavailable");
}
