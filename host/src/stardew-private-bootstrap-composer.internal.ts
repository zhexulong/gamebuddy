import type {
  StardewOwnedPlayerHostPhaseAOwner,
} from "./stardew-private-bootstrap-composer.js";
import {
  consumeOwnedPlayerHostPhaseAOwner as consumeOwnedPlayerHostPhaseAOwnerCore,
  createStardewBootstrapGuardianOwnerBinding,
  createStardewPrivateBootstrapProductionCore,
  stageOwnedPlayerHostPhaseB as stageOwnedPlayerHostPhaseBCore,
  terminalizeOwnedPlayerHostPhaseAOwner as terminalizeOwnedPlayerHostPhaseAOwnerCore,
  type StardewPrivateBootstrapInternalComposition,
} from "./stardew-private-bootstrap-composer.core.js";
import {
  createStardewBootstrapGuardianOwner,
  type StardewBootstrapGuardianNativePorts,
  type StardewBootstrapGuardianOwner,
} from "./stardew-bootstrap-guardian.private.js";

/** Constructs the complete trusted production bootstrap composition. */
export type StardewPrivateBootstrapTrustedComposition = StardewPrivateBootstrapInternalComposition & Readonly<{
  createStardewBootstrapGuardianOwner(
    owner: StardewOwnedPlayerHostPhaseAOwner,
    native: StardewBootstrapGuardianNativePorts,
  ): StardewBootstrapGuardianOwner;
}>;

export function createStardewPrivateBootstrapComposition(): StardewPrivateBootstrapTrustedComposition {
  const core = createStardewPrivateBootstrapProductionCore();
  return Object.freeze({
    ...core,
    createStardewBootstrapGuardianOwner: (owner, native) =>
      createStardewBootstrapGuardianOwner(createStardewBootstrapGuardianOwnerBinding(owner), native),
  });
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
