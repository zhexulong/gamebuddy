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
  createStardewBootstrapGuardianOwnerBinding,
  createStardewPrivateBootstrapProductionCore,
  settleOwnedPlayerHostRegistrationAttempt as settleOwnedPlayerHostRegistrationAttemptCore,
  stageOwnedPlayerHostProfile as stageOwnedPlayerHostProfileCore,
  terminalizeOwnedPlayerHostBootstrap as terminalizeOwnedPlayerHostBootstrapCore,
  type StardewBootstrapGuardianSettlementProof,
  type StardewPrivateBootstrapInternalComposition,
} from "./stardew-private-bootstrap-composer.core.js";
import {
  createStardewBootstrapGuardianNativePortsFromDesktopSession,
  createStardewBootstrapGuardianOwner,
  type StardewBootstrapGuardianNativePorts,
  type StardewBootstrapGuardianOwner,
} from "./stardew-bootstrap-guardian.private.js";
import type { DesktopGuardianSession } from "../../../containment/auth/desktop-guardian-session.internal.js";

/** Constructs the complete trusted production bootstrap composition. */
export type StardewPrivateBootstrapTrustedComposition = StardewPrivateBootstrapInternalComposition & Readonly<{
  createStardewBootstrapGuardianOwner(
    owner: StardewOwnedPlayerHostBootstrap,
    native: StardewBootstrapGuardianNativePorts,
  ): StardewBootstrapGuardianOwner;

}>;

export function createStardewPrivateBootstrapComposition(): StardewPrivateBootstrapTrustedComposition & Readonly<{
  createStardewBootstrapGuardianOwnerFromDesktopSession(
    owner: StardewOwnedPlayerHostBootstrap,
    session: DesktopGuardianSession,
    deadlineUnixMs: number,
  ): StardewBootstrapGuardianOwner;
}> {
  const core = createStardewPrivateBootstrapProductionCore({
    rawSpawn: productionSpawn,
    rawProbe: productionProbe,
    rawPlayerHostSpawn: productionPlayerHostSpawn,
    rawPlayerHostProbe: productionPlayerHostProbe,
    staging: createProductionStagingDependencies(),
  });
  return Object.freeze({
    ...core,
    createStardewBootstrapGuardianOwner: (owner, native) =>
      createStardewBootstrapGuardianOwner(createStardewBootstrapGuardianOwnerBinding(owner), native),
    createStardewBootstrapGuardianOwnerFromDesktopSession: (owner, session, deadlineUnixMs) => {
      const binding = createStardewBootstrapGuardianOwnerBinding(owner);
      return createStardewBootstrapGuardianOwner(
        binding,
        createStardewBootstrapGuardianNativePortsFromDesktopSession(binding, session, deadlineUnixMs),
      );
    },
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
