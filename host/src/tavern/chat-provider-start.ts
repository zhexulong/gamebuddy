import {
  consumeMountedAttemptInvocationAdmission,
  startMountedAttempt,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { AttemptStartingTurn, CancelledTurn, CompletedTurn, FailedTurn } from "./chat-thread-store.js";
import { runMountedProviderStartLedger, type NativeChatPreviewPublisher } from "./p4-provider-start-execution.js";

/**
 * Starts the one already-claimed mounted Chat turn. The coordinator retains
 * ownership of the exact runtime, active Pi prompt, durable state transition,
 * presentation admission, and Stop lifecycle; this operation only enters its
 * normal provider-start boundary.
 */
export async function startMountedChatProvider(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  previewPublisher?: NativeChatPreviewPublisher,
): Promise<AttemptStartingTurn | CompletedTurn | CancelledTurn | FailedTurn> {
  return await startMountedAttempt(manifest, lease, (invocation) =>
    consumeMountedAttemptInvocationAdmission(invocation, (scope) =>
      runMountedProviderStartLedger(scope, previewPublisher),
    ),
  );
}
