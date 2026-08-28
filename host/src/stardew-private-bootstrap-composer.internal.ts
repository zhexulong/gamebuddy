import type {
  StardewOwnedPlayerHostPhaseAOwner,
} from "./stardew-private-bootstrap-composer.js";
import {
  consumeOwnedPlayerHostPhaseAOwner as consumeOwnedPlayerHostPhaseAOwnerCore,
  createStardewPrivateBootstrapProductionCore,
  stageOwnedPlayerHostPhaseB as stageOwnedPlayerHostPhaseBCore,
  terminalizeOwnedPlayerHostPhaseAOwner as terminalizeOwnedPlayerHostPhaseAOwnerCore,
  type StardewPrivateBootstrapInternalComposition,
} from "./stardew-private-bootstrap-composer.core.js";

/** Constructs the complete trusted production bootstrap composition. */
export function createStardewPrivateBootstrapComposition(): StardewPrivateBootstrapInternalComposition {
  return createStardewPrivateBootstrapProductionCore();
}

/** Consumes an exact composer-minted owner for one Stage-B preparation attempt. */
export function consumeOwnedPlayerHostPhaseAOwner<T>(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  callback: () => Promise<T> | T,
): Promise<T> | T {
  return consumeOwnedPlayerHostPhaseAOwnerCore(owner, callback);
}

/** Permanently terminalizes an owner after post-staging admission failure. */
export function terminalizeOwnedPlayerHostPhaseAOwner(
  owner: StardewOwnedPlayerHostPhaseAOwner,
): void {
  terminalizeOwnedPlayerHostPhaseAOwnerCore(owner);
}

/** Runs the closed production Phase-B profile staging operation. */
export async function stageOwnedPlayerHostPhaseB(
  owner: StardewOwnedPlayerHostPhaseAOwner,
): Promise<void> {
  await stageOwnedPlayerHostPhaseBCore(owner);
}
