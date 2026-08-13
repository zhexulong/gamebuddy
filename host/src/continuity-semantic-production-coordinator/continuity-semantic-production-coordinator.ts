/**
 * Production authority surface. Construction is deliberately owned by deployment
 * composition; this module exposes no caller-supplied mutex, store, provision,
 * or coordinator constructor.
 */
export { SemanticProductionCoordinatorError } from "./continuity-semantic-production-coordinator.internal.js";
export type { SemanticProductionAuthority } from "./continuity-semantic-production-coordinator.internal.js";
