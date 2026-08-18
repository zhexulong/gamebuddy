import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import {
  startMountedP4Attempt,
  consumeMountedP4AttemptInvocationAdmission,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { AttemptStartingTurn, CancelledTurn, CompletedTurn, FailedTurn } from "./chat-thread-store.js";
import { runMountedP4ProviderStartLedger } from "./p4-provider-start-execution.js";

/**
 * The only P4c composition bridge. It has no provider, session, presentation,
 * DialogueController, browser, SSE, or Memory imports; the exclusive P4c
 * consumer runs inside the coordinator's private execution scope.
 */
export async function startMountedP4ProviderStartFromFacade(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): Promise<AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn> {
  return startMountedP4Attempt(
    manifest,
    lease,
    (invocation) =>
      consumeMountedP4AttemptInvocationAdmission(invocation, (scope) =>
        runMountedP4ProviderStartLedger(scope),
      ),
  );
}