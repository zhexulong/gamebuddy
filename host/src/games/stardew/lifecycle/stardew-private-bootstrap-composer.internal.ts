import type {
  StardewOwnedPlayerHostBootstrap,
} from "./stardew-private-bootstrap-composer.js";
import {
  productionPlayerHostProbe,
  productionPlayerHostSpawn,
  productionProbe,
  productionSpawn,
} from "./stardew-process-implementations.js";
import { createProductionStagingDependencies } from "../../../bootstrap/roots/stardew-private-mod-profile-staging.js";
import {
  consumeOwnedPlayerHostBootstrap as consumeOwnedPlayerHostBootstrapCore,
  createStardewPrivateBootstrapProductionCore,
  settleOwnedPlayerHostContainedRuntimeAttempt as settleOwnedPlayerHostContainedRuntimeAttemptCore,
  settleOwnedPlayerHostRegistrationAttempt as settleOwnedPlayerHostRegistrationAttemptCore,
  stageOwnedPlayerHostProfile as stageOwnedPlayerHostProfileCore,
  terminalizeOwnedPlayerHostBootstrap as terminalizeOwnedPlayerHostBootstrapCore,
  type StardewBootstrapGuardianSettlementProof,
  type StardewPrivateBootstrapInternalComposition,
} from "./stardew-private-bootstrap-composer.core.js";

/** Constructs the complete trusted production bootstrap composition. */
export type StardewBootstrapGuardianOwnerFactory = Readonly<{
  /**
   * Advances the durable attempt to `contained`, mints the matching settlement
   * proof and releases the bound registration pointer. Only the explicit endgame
   * operation reaches this.
   */
  settle(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
}>;

export type StardewPrivateBootstrapTrustedComposition = StardewPrivateBootstrapInternalComposition & Readonly<{
  settleOwnedPlayerHostContainedRuntimeAttempt(
    owner: StardewOwnedPlayerHostBootstrap,
    launchedRoles: readonly ("playerHost" | "aiClient")[],
  ): Promise<void>;
}>;

export function createStardewPrivateBootstrapComposition(): StardewPrivateBootstrapTrustedComposition {
  const core = createStardewPrivateBootstrapProductionCore({
    rawSpawn: productionSpawn,
    rawProbe: productionProbe,
    rawPlayerHostSpawn: productionPlayerHostSpawn,
    rawPlayerHostProbe: productionPlayerHostProbe,
    staging: createProductionStagingDependencies(),
  });
  return Object.freeze({
    ...core,
    settleOwnedPlayerHostContainedRuntimeAttempt: (owner, launchedRoles) =>
      settleOwnedPlayerHostContainedRuntimeAttemptCore(owner, launchedRoles),
  });
}

/** Consumes an exact composer-minted owner for one Stage-B preparation attempt. */
export function consumeOwnedPlayerHostBootstrap<T>(
  owner: StardewOwnedPlayerHostBootstrap,
  callback: () => Promise<T> | T,
): Promise<T> | T {
  return consumeOwnedPlayerHostBootstrapCore(owner, callback);
}

/** Permanently terminalizes an owner after post-staging admission failure. */
export function terminalizeOwnedPlayerHostBootstrap(
  owner: StardewOwnedPlayerHostBootstrap,
): void {
  terminalizeOwnedPlayerHostBootstrapCore(owner);
}

/** Releases a matching pointer only through a Guardian-private proof. */
export async function settleOwnedPlayerHostRegistrationAttempt(
  owner: StardewOwnedPlayerHostBootstrap,
  proof: StardewBootstrapGuardianSettlementProof,
): Promise<void> {
  await settleOwnedPlayerHostRegistrationAttemptCore(owner, proof);
}

/** Runs the closed production Player Host profile staging profile staging operation. */
export async function stageOwnedPlayerHostProfile(
  owner: StardewOwnedPlayerHostBootstrap,
): Promise<void> {
  await stageOwnedPlayerHostProfileCore(owner);
}
