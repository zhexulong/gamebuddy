const OWNER_SCHEMA = "gamebuddy-stardew-private-bootstrap-owner/v4";

/** Immutable, record-bound Guardian correlation; never part of the public composer declaration. */
export type StardewGuardianBinding = Readonly<{
  bindingRevision: string;
  guardianInstanceId: string;
  guardianEpoch: number;
  leaseName: string;
  playerJobName: string;
  aiJobName: string;
}>;

type StardewBootstrapParentState = "reserved" | "closing" | "recovering" | "contained" | "quarantined";
type StardewBootstrapGuardianState = "reserved" | "armed" | "closing" | "recovering" | "contained" | "quarantined";
type StardewBootstrapRoleState = "reserved" | "armed" | "active" | "closing" | "contained" | "quarantined";

type StardewPrivateBootstrapOwnerRecordBase = Readonly<{
  schema: typeof OWNER_SCHEMA;
  bootstrapId: string;
  playerId: string;
  companionId: string;
  guardian: StardewGuardianBinding;
  ownerRecordRevision: number;
  state: StardewBootstrapParentState;
  guardianState: StardewBootstrapGuardianState;
  playerHostState: StardewBootstrapRoleState;
  aiClientState: StardewBootstrapRoleState;
  recoveryInstanceId: string | null;
  aiClient: Readonly<{ kind: "launch_reserved"; launchGeneration: string }>;
  expiresAtMs: number;
  cleanupDisposition: "pending" | "retry_required";
  managedPaths: readonly string[];
}>;

export type StardewExternalPlayerHostBootstrapOwnerRecord = StardewPrivateBootstrapOwnerRecordBase & Readonly<{
  playerHost: Readonly<{ kind: "external_unattested" }>;
}>;

export type StardewOwnedPlayerHostBootstrapOwnerRecord = StardewPrivateBootstrapOwnerRecordBase & Readonly<{
  playerHost: Readonly<{ kind: "launch_reserved"; launchGeneration: string }>;
}>;

export type StardewPrivateBootstrapOwnerRecord =
  | StardewExternalPlayerHostBootstrapOwnerRecord
  | StardewOwnedPlayerHostBootstrapOwnerRecord;
