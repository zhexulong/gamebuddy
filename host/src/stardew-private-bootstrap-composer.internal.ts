import type {
  StardewOwnedPlayerHostPhaseAOwner,
} from "./stardew-private-bootstrap-composer.js";
import {
  consumeOwnedPlayerHostPhaseAOwner as consumeOwnedPlayerHostPhaseAOwnerCore,
  createStardewBootstrapGuardianOwnerBinding,
  createStardewPrivateBootstrapProductionCore,
  settleOwnedPlayerHostRegistrationAttempt as settleOwnedPlayerHostRegistrationAttemptCore,
  stageOwnedPlayerHostPhaseB as stageOwnedPlayerHostPhaseBCore,
  terminalizeOwnedPlayerHostPhaseAOwner as terminalizeOwnedPlayerHostPhaseAOwnerCore,
  type StardewBootstrapGuardianSettlementProof,
  type StardewPrivateBootstrapInternalComposition,
} from "./stardew-private-bootstrap-composer.core.js";
import {
  createStardewBootstrapGuardianNativePortsFromDesktopSession,
  createStardewBootstrapGuardianOwner,
  type StardewBootstrapGuardianNativePorts,
  type StardewBootstrapGuardianOwner,
} from "./stardew-bootstrap-guardian.private.js";
import type { DesktopGuardianSession } from "./desktop-guardian-session.internal.js";

/** Constructs the complete trusted production bootstrap composition. */
export type StardewPrivateBootstrapTrustedComposition = StardewPrivateBootstrapInternalComposition & Readonly<{
  createStardewBootstrapGuardianOwner(
    owner: StardewOwnedPlayerHostPhaseAOwner,
    native: StardewBootstrapGuardianNativePorts,
  ): StardewBootstrapGuardianOwner;

}>;

export function createStardewPrivateBootstrapComposition(): StardewPrivateBootstrapTrustedComposition & Readonly<{
  createStardewBootstrapGuardianOwnerFromDesktopSession(
    owner: StardewOwnedPlayerHostPhaseAOwner,
    session: DesktopGuardianSession,
    deadlineUnixMs: number,
  ): StardewBootstrapGuardianOwner;
}> {
  const core = createStardewPrivateBootstrapProductionCore();
  return Object.freeze({
    ...core,
    createStardewBootstrapGuardianOwner: (owner, native) =>
      createStardewBootstrapGuardianOwner(createStardewBootstrapGuardianOwnerBinding(owner), native),
    createStardewBootstrapGuardianOwnerFromDesktopSession: (owner, session, deadlineUnixMs) => {
      const binding = createStardewBootstrapGuardianOwnerBinding(owner);
      return createStardewBootstrapGuardianOwner(binding, createStardewBootstrapGuardianNativePortsFromDesktopSession(binding, session, deadlineUnixMs));
    },
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

/** Releases a matching pointer only through a Guardian-private proof. */
export async function settleOwnedPlayerHostRegistrationAttempt(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  proof: StardewBootstrapGuardianSettlementProof,
): Promise<void> {
  await settleOwnedPlayerHostRegistrationAttemptCore(owner, proof);
}

/** Runs the closed production Phase-B profile staging operation. */
export async function stageOwnedPlayerHostPhaseB(
  owner: StardewOwnedPlayerHostPhaseAOwner,
): Promise<void> {
  await stageOwnedPlayerHostPhaseBCore(owner);
}
