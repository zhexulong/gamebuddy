import {
  bindStardewPrivateBootstrapOwnerTestSupport,
  consumeStagedOwnedPlayerHostPhaseBForTesting,
  createStardewPrivateBootstrapCompositionForTesting,
  launchOwnedPlayerHostStageCForTesting,
} from "./stardew-private-bootstrap-composer.test-support-internal.js";
import type {
  StardewOwnedPlayerHostPhaseAOwner,
  StardewPrivateBootstrapComposition,
} from "./stardew-private-bootstrap-composer.js";
import type {
  StardewAiClientProcessProbe,
  StardewAiClientProcessSpawn,
} from "./stardew-ai-client-process-owner.js";
import type {
  StardewPlayerHostProcessProbe,
  StardewPlayerHostProcessSpawn,
} from "./stardew-player-host-process-owner.js";

export type StardewPrivateBootstrapComposerTestSupportInput = Readonly<{
  rawSpawn: StardewAiClientProcessSpawn;
  rawProbe: StardewAiClientProcessProbe;
  rawPlayerHostSpawn: StardewPlayerHostProcessSpawn;
  rawPlayerHostProbe: StardewPlayerHostProcessProbe;
  createBootstrapIdentity: () => string;
  createLaunchGeneration: () => string;
  createPlayerHostLaunchGeneration: () => string;
  nowMs: () => number;
}>;

/**
 * Deterministic test support for the production closed composition. It accepts
 * only role-specific raw spawn/probe, identity generators, and clock. Trusted
 * facts, registrar callbacks, persistence, package paths, and secrets are
 * never inputs; low-level package/secret fixtures belong to the internal
 * test-support adapter.
 */
export function createStardewPrivateBootstrapComposerTestSupport(
  input: StardewPrivateBootstrapComposerTestSupportInput,
): StardewPrivateBootstrapComposition {
  if (input === null || typeof input !== "object" || Object.prototype.hasOwnProperty.call(input, "staging")) {
    throw new TypeError("invalid_stardew_private_bootstrap_testing_dependencies");
  }
  return createStardewPrivateBootstrapCompositionForTesting(input).composition;
}

export {
  bindStardewPrivateBootstrapOwnerTestSupport,
  consumeStagedOwnedPlayerHostPhaseBForTesting,
  launchOwnedPlayerHostStageCForTesting,
};
