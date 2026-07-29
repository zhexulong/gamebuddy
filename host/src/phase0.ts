export const PHASE_0_HOST_NAME = "gamebuddy-companion-host";

/**
 * Phase 0A has no model, provider, tool, game, filesystem, or network access.
 * This marker makes the empty host independently buildable and testable while
 * runtime provenance and tool-isolation decisions remain pending.
 */
export function describePhase0Host(): string {
  return `${PHASE_0_HOST_NAME}: scaffold only`;
}
