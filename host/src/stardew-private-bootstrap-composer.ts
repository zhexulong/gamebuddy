import type {
  LaunchAiClientInput,
  StardewAiClientLaunchReservation,
  StardewAiClientProcessOwner,
  StardewAiClientProcessStatus,
} from "./stardew-ai-client-process-owner.js";
import type {
  StardewPlayerHostBootstrapBroker,
  StardewPlayerHostBootstrapClaim,
} from "./stardew-player-host-bootstrap.js";
import type { StardewAttachmentFlow } from "./stardew-attachment.js";
import type { StardewRoleLifecycleFacade } from "./stardew-role-lifecycle-facade.js";
import type {
  LaunchPlayerHostInput,
  StardewPlayerHostLaunchReservation,
  StardewPlayerHostProcessOwner,
  StardewPlayerHostProcessStatus,
} from "./stardew-player-host-process-owner.js";
import { createStardewPrivateBootstrapComposition as createProductionComposition } from "./stardew-private-bootstrap-composer.internal.js";

const OWNER_SCHEMA = "gamebuddy-stardew-private-bootstrap-owner/v2";

export type StardewExternalPlayerHostBootstrapOwnerRecord = Readonly<{
  schema: typeof OWNER_SCHEMA;
  bootstrapId: string;
  playerId: string;
  companionId: string;
  playerHost: Readonly<{ kind: "external_unattested" }>;
  aiClient: Readonly<{ kind: "launch_reserved"; launchGeneration: string }>;
  expiresAtMs: number;
  state: "reserved" | "quarantined";
  cleanupDisposition: "pending" | "retry_required";
  managedPaths: readonly string[];
}>;

export type StardewOwnedPlayerHostBootstrapOwnerRecord = Readonly<{
  schema: typeof OWNER_SCHEMA;
  bootstrapId: string;
  playerId: string;
  companionId: string;
  playerHost: Readonly<{ kind: "launch_reserved"; launchGeneration: string }>;
  aiClient: Readonly<{ kind: "launch_reserved"; launchGeneration: string }>;
  expiresAtMs: number;
  state: "reserved" | "quarantined";
  cleanupDisposition: "pending" | "retry_required";
  managedPaths: readonly string[];
}>;

export type StardewPrivateBootstrapOwnerRecord =
  | StardewExternalPlayerHostBootstrapOwnerRecord
  | StardewOwnedPlayerHostBootstrapOwnerRecord;

export type StardewAiClientLaunch = (
  input: LaunchAiClientInput,
) => Readonly<{ status: StardewAiClientProcessStatus }>;

export type StardewPlayerHostLaunch = (
  input: LaunchPlayerHostInput,
) => Readonly<{ status: StardewPlayerHostProcessStatus }>;

export type StardewExternalPlayerHostPhaseAOwner = Readonly<{
  readonly record: StardewExternalPlayerHostBootstrapOwnerRecord;
  readonly transactionDirectory: string;
  consumeAiClientLaunch<T>(callback: (launch: StardewAiClientLaunch) => T): T;
  quarantine(): Promise<void>;
}>;

declare const stardewOwnedPlayerHostPhaseAOwnerBrand: unique symbol;

export type StardewOwnedPlayerHostPhaseAOwner = Readonly<{
  readonly [stardewOwnedPlayerHostPhaseAOwnerBrand]: never;
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
  reserveOwnedPlayerHostPhaseA(
    runtimeRoot: string,
    claim: StardewPlayerHostBootstrapClaim,
    playerHostReservation: StardewPlayerHostLaunchReservation,
    aiClientReservation: StardewAiClientLaunchReservation,
  ): Promise<StardewOwnedPlayerHostPhaseAOwner>;
}>;

/** Constructs the public redacted Phase-A authority boundary. */
export function createStardewPrivateBootstrapComposition(): StardewPrivateBootstrapComposition {
  const internalComposition = createProductionComposition();
  const composition = internalComposition.composition;
  return Object.freeze({
    broker: composition.broker,
    playerHostProcessOwner: composition.playerHostProcessOwner,
    aiClientProcessOwner: composition.aiClientProcessOwner,
    createRoleLifecycleFacade: composition.createRoleLifecycleFacade,
    reserveExternalPlayerHostPhaseA: composition.reserveExternalPlayerHostPhaseA,
    reserveOwnedPlayerHostPhaseA: composition.reserveOwnedPlayerHostPhaseA,
  });
}
