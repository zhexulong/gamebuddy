import type { HostDeploymentManifest } from "../deployment-manifest.js";
import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { AttemptStartingTurn, CancelledTurn, CompletedTurn, FailedTurn } from "./chat-thread-store.js";
import { startMountedP5PresentationCommitFromFacade } from "./p5-presentation-commit.internal.js";

export type P5PresentationCommitFacade = Readonly<{
  /**
   * Starts the already-claimed exact P4c turn. The single invocation owns the
   * in-prompt P5 presentation commit and terminalization; it never offers a
   * post-hoc presentation start or an additional provider call.
   */
  start(): Promise<AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn>;
}>;

/**
 * Non-launchable verification facade for the connected P4c/P5 turn path.
 * Callers supply no session, attempt, gate, transition, or cancel authority.
 */
export function createP5PresentationCommitFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): P5PresentationCommitFacade {
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  return Object.freeze({
    async start(): Promise<AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn> {
      try {
        return await startMountedP5PresentationCommitFromFacade(manifest, lease);
      } catch (error) {
        if (
          error instanceof Error &&
          /semantic_chat_runtime_p4_attempt_admission_rejected|semantic_chat_runtime_authority_closed|semantic_chat_runtime_p4_attempt_invocation_rejected|semantic_chat_runtime_p4_provider_start_deadline_expired|semantic_chat_runtime_p4_provider_start_session_unavailable/.test(
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
  return new Error("p5_presentation_commit_unavailable");
}
