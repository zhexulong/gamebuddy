/**
 * Production authority surface. Construction is deliberately owned by deployment
 * composition; this module exposes no caller-supplied mutex, store, provision,
 * or coordinator constructor.
 */
export {
  SemanticProductionCoordinatorError,
  createKnownSemanticGameProductionAuthorityFromDeploymentManifest,
  createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
  createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
  isCurrentMountedChatRuntimeLease,
} from "./continuity-semantic-production-coordinator.internal.js";
export type {
  GameEffectFacts,
  LiveSemanticGame,
  SemanticGameProductionAuthority,
  SemanticChatRuntimeProductionAuthority,
  SemanticChatRuntimeMountOptions,
  MountedChatRuntimeLease,
} from "./continuity-semantic-production-coordinator.internal.js";
