import type { HostDeploymentManifest } from "../deployment-manifest.js";
import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { AttemptStartingTurn, CancelledTurn, CompletedTurn, FailedTurn } from "./chat-thread-store.js";
import { startMountedP4ProviderStartFromFacade } from "./p4-provider-start.internal.js";

export type P4ProviderStartFacade = Readonly<{
  /**
   * Starts the P4c provider attempt for the already-accepted exact turn:
   * a durable `armed` record precedes exactly one `session.prompt()` call, and
   * the one-shot `after_provider_response` observation drives a durable
   * `running` record. After prompt settlement and presentation callback drain,
   * that exact running turn terminalizes durably as `completed`, `cancelled`,
   * or `failed(no_visible_presentation)`. It never re-invokes the provider or
   * mints a generation 2. Settlement without an observation leaves the
   * durable `armed` record (reopen `uncertain`).
   */
  start(): Promise<AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn>;
}>;

/**
 * Binds the P4c provider start to the deployment principal and a current
 * coordinator-branded mount. The caller supplies no turn/runtime/session
 * facts; the coordinator's private execution scope supplies them.
 */
export function createP4ProviderStartFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): P4ProviderStartFacade {
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  return Object.freeze({
    async start(): Promise<AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn> {
      try {
        return await startMountedP4ProviderStartFromFacade(manifest, lease);
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
  return new Error("p4_provider_start_unavailable");
}