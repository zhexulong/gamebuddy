import type {
  LaunchAiClientInput,
  StardewAiClientLaunchReservation,
  StardewAiClientProcessOwner,
  StardewAiClientProcessStatus,
} from "../../../stardew-ai-client-process-owner.js";
import type {
  StardewPlayerHostBootstrapBroker,
  StardewPlayerHostBootstrapClaim,
} from "../../../stardew-player-host-bootstrap.js";
import type { StardewAttachmentFlow } from "../../../stardew-attachment.js";
import type { StardewRoleLifecycleFacade } from "../../../stardew-role-lifecycle-facade.js";
import type {
  LaunchPlayerHostInput,
  StardewPlayerHostLaunchReservation,
  StardewPlayerHostProcessOwner,
  StardewPlayerHostProcessStatus,
} from "../../../stardew-player-host-process-owner.js";
import { createStardewPrivateBootstrapComposition as createProductionComposition } from "./stardew-private-bootstrap-composer.internal.js";


export type StardewAiClientLaunch = (
  input: LaunchAiClientInput,
) => Readonly<{ status: StardewAiClientProcessStatus }>;

export type StardewPlayerHostLaunch = (
  input: LaunchPlayerHostInput,
) => Readonly<{ status: StardewPlayerHostProcessStatus }>;

declare const stardewExternalPlayerHostPhaseAOwnerBrand: unique symbol;

/**
 * Opaque external-host Player Host bootstrap reservation authority. Durable owner bytes, runtime paths,
 * and Guardian facts remain closure-private; only the existing narrow launch
 * consume and fail-closed quarantine operations are exposed.
 */
export type StardewExternalPlayerHostPhaseAOwner = Readonly<{
  /** Nominal only; no runtime field is present on the opaque owner. */
  readonly [stardewExternalPlayerHostPhaseAOwnerBrand]?: never;
  consumeAiClientLaunch<T>(callback: (launch: StardewAiClientLaunch) => T): T;
  quarantine(): Promise<void>;
}>;

declare const stardewOwnedPlayerHostBootstrapBrand: unique symbol;

export type StardewOwnedPlayerHostBootstrap = Readonly<{
  readonly [stardewOwnedPlayerHostBootstrapBrand]: never;
}>;

export type StardewPrivateBootstrapComposition = Readonly<{
  readonly broker: StardewPlayerHostBootstrapBroker;
  readonly playerHostProcessOwner: StardewPlayerHostProcessOwner;
  readonly aiClientProcessOwner: StardewAiClientProcessOwner;
  createRoleLifecycleFacade(
    attachment: StardewAttachmentFlow,
  ): StardewRoleLifecycleFacade;
  reserveExternalPlayerHostPhaseA(
    runtimeRoot: string,
    claim: StardewPlayerHostBootstrapClaim,
    aiClientReservation: StardewAiClientLaunchReservation,
  ): Promise<StardewExternalPlayerHostPhaseAOwner>;
  reserveOwnedPlayerHostBootstrap(
    runtimeRoot: string,
    claim: StardewPlayerHostBootstrapClaim,
    playerHostReservation: StardewPlayerHostLaunchReservation,
    aiClientReservation: StardewAiClientLaunchReservation,
  ): Promise<StardewOwnedPlayerHostBootstrap>;
}>;

/** Constructs the public redacted Player Host bootstrap reservation authority boundary. */
export function createStardewPrivateBootstrapComposition(): StardewPrivateBootstrapComposition {
  const internalComposition = createProductionComposition();
  const composition = internalComposition.composition;
  return Object.freeze({
    broker: composition.broker,
    playerHostProcessOwner: composition.playerHostProcessOwner,
    aiClientProcessOwner: composition.aiClientProcessOwner,
    createRoleLifecycleFacade: composition.createRoleLifecycleFacade,
    reserveExternalPlayerHostPhaseA: composition.reserveExternalPlayerHostPhaseA,
    reserveOwnedPlayerHostBootstrap: composition.reserveOwnedPlayerHostBootstrap,
  });
}
