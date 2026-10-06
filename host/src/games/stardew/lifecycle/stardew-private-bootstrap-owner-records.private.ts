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

/**
 * Parent states of one durable attempt. `ai_settled_player_preserved` is the
 * AI-side recovery terminal: the recovery gate opened, the broker classified
 * the player role as NOT contained (the player's world is deliberately left
 * untouched) and settled the AI side by its own kill-on-close classification,
 * so no role CAS ever ran. It is named for what the recovery OBSERVED and never
 * for a containment it did not observe: a record carrying it may not claim
 * either role was contained. `contained` and `quarantined` stay the only two
 * states that record role containment.
 */
type StardewBootstrapParentState = "reserved" | "closing" | "recovering" | "ai_settled_player_preserved" | "contained" | "quarantined";
type StardewBootstrapGuardianState = "reserved" | "armed" | "closing" | "recovering" | "ai_settled_player_preserved" | "contained" | "quarantined";
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

export type StardewExternalPlayerHostPhaseAOwnerOwnerRecord = StardewPrivateBootstrapOwnerRecordBase & Readonly<{
  playerHost: Readonly<{ kind: "external_unattested" }>;
}>;

export type StardewOwnedPlayerHostBootstrapOwnerRecord = StardewPrivateBootstrapOwnerRecordBase & Readonly<{
  playerHost: Readonly<{ kind: "launch_reserved"; launchGeneration: string }>;
}>;

export type StardewPrivateBootstrapOwnerRecord =
  | StardewExternalPlayerHostPhaseAOwnerOwnerRecord
  | StardewOwnedPlayerHostBootstrapOwnerRecord;
