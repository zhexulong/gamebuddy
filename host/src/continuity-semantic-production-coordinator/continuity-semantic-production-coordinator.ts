/**
 * Production authority surface. Construction is deliberately owned by deployment
 * composition; this module exposes no caller-supplied mutex, store, provision,
 * or coordinator constructor.
 */

export type {
  GameEffectFacts,
  LiveSemanticGame,
  MountedChatRuntimeLease,
  SemanticChatRuntimeMountOptions,
  SemanticChatRuntimeProductionAuthority,
  SemanticGameProductionAuthority,
} from "./continuity-semantic-production-coordinator.internal.js";
export {
  createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
  createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
  createKnownSemanticGameProductionAuthorityFromDeploymentManifest,
  createSharedSemanticProductionAuthorityFromDeploymentManifest,
  isCurrentMountedChatRuntimeLease,
  settleMountedAuthoredContext,
  stopMountedChatPresentationEpoch,
  SemanticProductionCoordinatorError,
} from "./continuity-semantic-production-coordinator.internal.js";
