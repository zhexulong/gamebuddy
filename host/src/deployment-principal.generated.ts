// GENERATED FILE - do not edit. Regenerate: node tools/generate-deployment-principal.mjs --write
// Target: host/src/deployment-principal.generated.ts
// Source of truth: contracts/deployment-principal.v1.json
export const DEPLOYMENT_PRINCIPAL_KEYS = ["continuityId", "companionId", "playerId"] as const;

/** The keys a deployment manifest's `principal` object must carry, and no others. */
export type DeploymentPrincipalKey = (typeof DEPLOYMENT_PRINCIPAL_KEYS)[number];
