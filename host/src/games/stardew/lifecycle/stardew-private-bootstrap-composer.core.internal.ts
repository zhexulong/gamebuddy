import { randomUUID } from "node:crypto";
import { cp, link, lstat, mkdir, readdir, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  LaunchAiClientInput,
  ReadOwnedAiClientGenerationResult,
  StardewAiClientLaunchReservation,
  StardewAiClientProcessOwner,
  StardewAiClientProcessProbe,
  StardewAiClientProcessSpawn,
  StardewAiClientProcessStatus,
  StopOwnedAiClientResult,
} from "../../../stardew-ai-client-process-owner.js";
import type {
  StardewPlayerHostBootstrapBroker,
  StardewPlayerHostBootstrapCapability,
  StardewPlayerHostBootstrapClaim,
  StardewPlayerHostBootstrapRequest,
  StardewPlayerHostBootstrapView,
} from "../../../stardew-player-host-bootstrap.js";
import type {
  LaunchPlayerHostInput,
  StardewPlayerHostLaunchReservation,
  StardewPlayerHostProcessOwner,
  StardewPlayerHostProcessProbe,
  StardewPlayerHostProcessProbeResult,
  StardewPlayerHostProcessSpawn,
  StardewPlayerHostProcessStatus,
  StopOwnedPlayerHostResult,
} from "../../../stardew-player-host-process-owner.js";
import {
  consumeAdmittedStardewInstallation,
  type AdmittedStardewInstallation,
} from "../../../stardew-installation-admission.core.js";
import {
  atomicWriteFile,
  captureSafeFileIdentity,
  pathLockPath,
  readSafeDirectory,
  removeOwnedSafeFile,
  removeSafeFile,
  verifySafePathBoundary,
  withPathLock,
} from "../../../path-lock.js";
import {
  readStardewInstallationRegistration,
  withStardewLifecycleInstallationRegistrationOwner,
  type StardewInstallationRegistrationOwnerTransactionMarker,
} from "../../../stardew-installation-registration.internal.js";
import { readStrictJsonFile } from "../../../strict-json-reader.js";
import {
  probeStardewGuardianObjects,
  type StardewGuardianNamedObjectProbe,
} from "./stardew-guardian-object-presence.js";
import { readStardewPlayerSettings } from "../stardew-player-settings.js";
import {
  projectStardewModActionPolicy,
  readStardewModPresentationLocale,
  writeStardewModActionPolicyIntoConfig,
  type StardewModActionPolicyProjection,
} from "../stardew-mod-action-policy-projection.js";
import type { Scope } from "../../../protocol.js";
import { createStardewRoleLifecycleFacade } from "../../../stardew-role-lifecycle-facade.js";
import { ContainmentRoleAlreadyContainedError } from "../../../containment/runtime/contract/game-runtime.js";
import type {
  TypedPrivateGameAuthorizationProducer,
  TypedPrivateGameFacts,
} from "../../../containment/runtime/contract/game-runtime.js";
import {
  StardewAttachmentFlow,
  STARDEW_CABIN_OCCUPANCY_PUBLISHED_WITHIN_MS,
  type StardewCabinOccupancyExpectation,
  type StardewCabinOccupancyReading,
  type StardewJoinManifest,
  type StardewVerifiedCabinChoice,
} from "../../../stardew-attachment.js";
export type PrivateModProfileStagingDependencies = Readonly<{
  readPackage(): Promise<Readonly<{ root: string; entries: readonly string[] }>>;
  createSecret(): string;
  nowMs(): number;
  /**
   * The companion's display name, from the identity profile the runtime provisioned at mount.
   *
   * It is the single authority every surface reads her name from, and the farmhand standing in the player's world is the same
   * character - an NPC calling her "GameBuddy" while the Chat surface calls her by her own name is two identities for one
   * companion. Absent means the profile has not been read yet, and the Mod's own default applies.
   */
  readCompanionDisplayName?(): Promise<string | undefined>;
}>;
import type {
  StardewAiClientLaunch,
  StardewExternalPlayerHostPhaseAOwner,
  StardewOwnedPlayerHostBootstrap,
  StardewPlayerHostLaunch,
  StardewPrivateBootstrapComposition,
} from "./stardew-private-bootstrap-composer.js";
import type {
  StardewExternalPlayerHostPhaseAOwnerOwnerRecord,
  StardewGuardianBinding,
  StardewOwnedPlayerHostBootstrapOwnerRecord,
  StardewPrivateBootstrapOwnerRecord,
} from "./stardew-private-bootstrap-owner-records.private.js";

/**
 * Composition-private Player Host profile staging and role launch.
 *
 * One thing here is a DECISION POINT rather than an accident: the Player Host is
 * launched with `--mods-path <attempt>/player-host/Mods`, so that isolated root
 * is the WHOLE set of Mods the game loads - SMAPI ignores `<game>/Mods` the
 * moment it is handed this path. Isolation is deliberate (the attempt needs its
 * own session-scoped GameBuddy config), but an isolated root that carries only
 * that one Mod would silently start the player's world without every Mod their
 * save was built on. So the launch carries the player's own Mods into that root
 * and reports what it carried as `StardewPlayerHostModsRoot`; a root that ends
 * up carrying no player Mod at all is a named state on the launch result, never
 * an unremarked one. The carried entries are the only links this attempt ever
 * creates, and no link is ever followed - see `readProfileModsEntries` and
 * `removeDeclaredDirectoryLinks`.
 */

/**
 * Whether the Mod will accept this as a farmhand's name.
 *
 * The same rule as `HostFarmhandProvisioningConfig.IsUsableFarmhandName` on the C# side: letters, digits, spaces, and the
 * punctuation real names carry. Kept here as well because this side decides what to write, and a name the game refuses would
 * otherwise fail the whole staging instead of falling back.
 */
function isUsableFarmhandName(name: string | undefined): name is string {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return false;
  return /^[\p{L}\p{N} ._'-]+$/u.test(trimmed);
}

const OWNER_SCHEMA = "gamebuddy-stardew-private-bootstrap-owner/v4";
const MAX_OWNER_RECORD_BYTES = 64 * 1024;
const OWNER_FILE = "owner.json";
const OWNER_LOCK_LEAF = pathLockPath(OWNER_FILE);
const LAUNCH_GENERATION_ENVIRONMENT_VARIABLE = "GAMEBUDDY_STARDEW_LAUNCH_GENERATION";
const OPAQUE = /^[A-Za-z0-9_-]{1,128}$/;
const HOST_PROFILE_ROOT = "player-host";
const MODS_DIRECTORY = "Mods";
const MOD_DIRECTORY = "GameBuddy";
const MOD_CONFIG_FILE = "config.json";
const INTEGRATION_VERSION = "0.1.0";
const MANIFEST_LIFETIME_SECONDS = 120;
/**
 * Display-only values for the staged Player Host world-creation form. The
 * physical slot basename the Player Host publishes after creation remains the
 * only world-identity authority, so none of these is an identity: they exist
 * solely because SMAPI must be handed a complete, non-empty creation form.
 */
const WORLD_CREATION_FARM_NAME = "GameBuddy Farm";
const WORLD_CREATION_PLAYER_NAME = "GameBuddy";
const WORLD_CREATION_FAVORITE_THING = "Companion";
const PHASE_B_PACKAGE_ENTRIES = Object.freeze([
  "GameBuddy.Stardew.Core.dll",
  "GameBuddy.Stardew.deps.json",
  "GameBuddy.Stardew.dll",
  "manifest.json",
] as const);
const PHASE_B_MANAGED_PATHS = ownedManagedPathSet([
  OWNER_FILE,
  HOST_PROFILE_ROOT,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${MOD_CONFIG_FILE}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[0]}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[1]}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[2]}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[3]}`,
] as const);
const AI_CLIENT_PROFILE_ROOT = "ai-client";
const AI_CLIENT_MANAGED_PATHS = ownedManagedPathSet([
  AI_CLIENT_PROFILE_ROOT,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${MOD_CONFIG_FILE}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[0]}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[1]}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[2]}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[3]}`,
] as const);
const C1_MANAGED_PATHS = ownedManagedPathSet([...PHASE_B_MANAGED_PATHS, ...AI_CLIENT_MANAGED_PATHS] as const);

/**
 * The owned-path set of one attempt: authored once here, refused unless every
 * entry is a contained relative path.
 *
 * Why it exists: this declaration is the attempt's entire delete surface
 * (`consumeRecoveredAttemptCleanup` deletes exactly these paths, relative to the
 * attempt's own transaction directory). The owner ruling makes it a guarantee
 * rather than luck that no entry names a Stardew save: a `GameBuddyFarm_*` slot
 * under the Stardew saves root is the player's own progress across bootstrap
 * attempts and is never part of an attempt's owned set -- ordinary close, endgame
 * and crash cleanup included. A declaration that leaves the transaction
 * directory -- absolute, drive-qualified, UNC, or carrying a `.`/`..` segment --
 * is refused here, when the set is authored, so the mistake fails on import
 * instead of on someone's farm. The cleanup re-checks containment against the
 * real directory before deleting anything; this is the authoring-time half of
 * the same rule.
 */
export function ownedManagedPathSet<T extends readonly string[]>(declared: T): T {
  for (const contained of declared) {
    if (
      contained.length === 0 ||
      contained.startsWith("/") ||
      contained.includes("\\") ||
      contained.includes(":") ||
      contained.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    )
      throw new Error("stardew_bootstrap_managed_path_not_contained");
  }
  return Object.freeze([...declared]) as unknown as T;
}

type RegistrationState = "available" | "binding" | "consumed";
type LaunchState = "available" | "binding" | "consumed" | "revoked";

type StardewPrivateBootstrapFacts = Readonly<{
  bootstrapId: string;
  playerId: string;
  companionId: string;
  expiresAtMs: number;
}>;

/**
 * Private role-launch recipe assembled only after fresh installation admission.
 * It is deliberately limited to the admitted executable/cwd/args and the
 * reservation's generation; no platform bytes, Guardian material, plan ID, or
 * public DTO crosses this callback boundary.
 */
export type StardewPrivateRoleLaunchRecipe = Readonly<{
  role: "player_host" | "ai_client";
  executable: string;
  cwd: string;
  args: readonly string[];
  launchGeneration: string;
}>;

/**
 * One-shot contained-launch seam handed to the lifecycle launch decision after
 * fresh installation admission and recipe assembly. `provideAuthorization` is
 * core-bound: invoking it atomically claims the exact one-shot Player Host
 * reservation and hands the recipe's typed facts (executable/cwd/arguments and
 * the full child environment including the launch generation) to the Host
 * runtime authorization capability. No platform bytes, raw child, or private
 * recipe value crosses this boundary; the caller never interprets the facts.
 */
export type StardewContainedPlayerHostLaunchSeam = Readonly<{
  readonly role: "player_host";
  readonly launchGeneration: string;
  readonly provideAuthorization: TypedPrivateGameAuthorizationProducer;
}>;

/**
 * One-shot contained-launch seam for the AI-client role. `provideAuthorization`
 * is core-bound: invoking it atomically claims the exact one-shot AI-client
 * reservation and hands the recipe's typed facts to the Host runtime
 * authorization capability without creating a raw child. Same boundary rules
 * as `StardewContainedPlayerHostLaunchSeam`.
 */
export type StardewContainedAiClientLaunchSeam = Readonly<{
  readonly role: "ai_client";
  readonly launchGeneration: string;
  readonly provideAuthorization: TypedPrivateGameAuthorizationProducer;
}>;

/**
 * The exact owner's durable recovery drive. It is the recovery half of the same
 * one-shot Guardian owner binding the contained runtime consumes: the exact
 * Guardian recovery-gate correlation plus the very CAS-cursor transition
 * surface the live owner binding exposes over this owner's `owner.json`. It
 * opens no second durable read/write seam and needs no launch.
 */
export type StardewBootstrapOwnerRecoveryDrive = Readonly<{
  readonly recoveryGateBinding: StardewBootstrapGuardianRecoveryGateBinding;
  readonly transitions: StardewBootstrapOwnerTransitions;
}>;

/**
 * The role exit a containment transport reported for one launched role, with the
 * native exit code the OS reported for the process that ended.
 *
 * It is declared here rather than imported from `containment/auth`: ADR-0007
 * gives `games/stardew/**` no edge to the authenticated Guardian transport, and
 * that seam has no compatibility re-export. The shape is structural, so the
 * composition-owned adapter that actually holds the session satisfies it without
 * this layer naming the transport's type.
 */
export type StardewContainedRoleExit = Readonly<{ role: "player_host" | "ai_client"; exitCode: number }>;

/**
 * Private, bounded, per-owner runtime collaborator injected by the Host
 * composition. It constructs one composition-owned `ContainedGameRuntime` per
 * owner (binding from the owner's Guardian correlation) and forwards the
 * lifecycle-created `RoleLaunchOperation` and the core-bound authorization
 * seam to `runtime.launchRole` for both roles. Containment and close are also
 * routed through the same per-owner runtime so the lifecycle can prove
 * containment of each launched role and close the platform session exactly
 * once. No raw session, pipe, PID, Job, token, or path crosses this seam.
 */
export type StardewPlayerHostRuntimeLaunchCollaborator = Readonly<{
  launchPlayerHost(
    owner: StardewOwnedPlayerHostBootstrap,
    operation: import("../../../containment/runtime/contract/game-runtime.js").RoleLaunchOperation,
    launch: StardewContainedPlayerHostLaunchSeam,
  ): Promise<import("../../../containment/runtime/contract/game-runtime.js").RedactedRoleLaunchOutcome>;
  launchAiClient(
    owner: StardewOwnedPlayerHostBootstrap,
    operation: import("../../../containment/runtime/contract/game-runtime.js").RoleLaunchOperation,
    launch: StardewContainedAiClientLaunchSeam,
  ): Promise<import("../../../containment/runtime/contract/game-runtime.js").RedactedRoleLaunchOutcome>;
  containPlayerHost(
    owner: StardewOwnedPlayerHostBootstrap,
  ): Promise<import("../../../containment/runtime/contract/game-runtime.js").RedactedContainmentOutcome>;
  containAiClient(
    owner: StardewOwnedPlayerHostBootstrap,
  ): Promise<import("../../../containment/runtime/contract/game-runtime.js").RedactedContainmentOutcome>;
  /**
   * The player-role exit the Guardian reported for this launch, with the native
   * exit code the game process ended with, or null while none has been reported.
   *
   * Only the containment transport can observe this: it owns the process the
   * Guardian launched. Null is "unknown" and must never be read as "still
   * running" - a session that carried no such event says nothing about the
   * process either way.
   */
  readPlayerHostRoleExit?(): StardewContainedRoleExit | null;
  /**
   * The exact owner's durable recovery drive. A recovery is a chain of durable
   * transitions over this owner's `owner.json`, so it belongs to the one
   * collaborator that already holds the exact owner and its consumed Guardian
   * binding — never to a second owner path or a second durable read/write seam.
   * Opening the drive consumes the same one-shot owner binding the contained
   * runtime uses, so it is reachable before a launch as well; the native
   * recovery attempt itself is still driven by whoever holds the Guardian
   * recovery gate.
   */
  recovery(owner: StardewOwnedPlayerHostBootstrap): StardewBootstrapOwnerRecoveryDrive;
  /**
   * Protected terminal settlement for the exact owner. It is only reachable
   * from the coordinator's explicit endgame operation, never from ordinary
   * close, AI crash or controller EOF. It settles the platform session and then
   * advances the durable Stardew owner attempt and releases the bound
   * registration pointer through the matching Guardian settlement proof.
   */
  settle(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  close(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
}>;

type StardewPrivateChildEnvironment = Readonly<{
  SystemRoot: string;
  WINDIR: string;
  TEMP: string;
  TMP: string;
  USERPROFILE: string;
  [LAUNCH_GENERATION_ENVIRONMENT_VARIABLE]: string;
}>;

type StardewAiClientLaunchRegistration = Readonly<{
  launchGeneration: string;
  launch(input: LaunchAiClientInput): Readonly<{
    status: StardewAiClientProcessStatus;
  }>;
  /**
   * Contained variant: marks the exact AI-client reservation consumed and the
   * process owner awaiting attestation without creating a raw child. The
   * native process is owned by the authenticated platform session; the
   * kill-on-close Guardian Job terminates it at platform close, so the owner
   * holds no pid and `stopOwnedAiClient` reports already-stopped.
   */
  containedLaunch(): Readonly<{
    status: StardewAiClientProcessStatus;
  }>;
  revoke(): void;
}>;

type ClaimRegistration = {
  state: RegistrationState;
  readonly facts: StardewPrivateBootstrapFacts;
};

type AiLaunchRegistration = {
  state: RegistrationState;
  readonly registration: StardewAiClientLaunchRegistration;
};

type StardewPlayerHostLaunchRegistration = Readonly<{
  launchGeneration: string;
  launch(input: LaunchPlayerHostInput): Readonly<{
    status: StardewPlayerHostProcessStatus;
  }>;
  /**
   * Contained variant: commits the exact one-shot reservation and marks the process owner awaiting
   * attestation without creating a raw child. The native process is owned by the authenticated
   * platform session; this owner holds no pid for it, so the ending it gets back is the Guardian's
   * report through `notePlayerHostEnded` rather than a handle of its own.
   */
  containedLaunch(): Readonly<{
    status: StardewPlayerHostProcessStatus;
  }>;
  revoke(): void;
}>;

type PlayerHostLaunchRegistration = {
  state: RegistrationState;
  readonly registration: StardewPlayerHostLaunchRegistration;
};

export type StardewPrivateBootstrapCoreDependencies = Readonly<{
  rawSpawn: StardewAiClientProcessSpawn;
  rawProbe: StardewAiClientProcessProbe;
  rawPlayerHostSpawn: StardewPlayerHostProcessSpawn;
  rawPlayerHostProbe: StardewPlayerHostProcessProbe;
  createBootstrapIdentity: () => string;
  createGuardianRevision: () => string;
  createGuardianInstanceId: () => string;
  createGuardianEpoch: () => number;
  createGuardianLeaseName: () => string;
  createGuardianPlayerJobName: () => string;
  createGuardianAiJobName: () => string;
  createLaunchGeneration: () => string;
  createPlayerHostLaunchGeneration: () => string;
  createBridgePipeName: () => string;
  createBridgeToken: () => string;
  nowMs: () => number;
  staging?: PrivateModProfileStagingDependencies;
}>;

/**
 * Constructs the complete production Player Host bootstrap reservation authority boundary for both the
 * external and directly owned Player-Host topologies. Registrar callbacks,
 * trusted facts, generations, and persistence remain closure-only; callers
 * receive only the broker, the two role-specific process owners, and joins.
 */
declare const stardewManifestHandoffSelectionBrand: unique symbol;

/**
 * Composition-private, fieldless selection capability. The exact verified
 * choice, owner, flow, and composition identity remain in the module-private
 * WeakMap below; this object is only an unforgeable-in-practice lookup key.
 */
type StardewManifestHandoffSelection = Readonly<{
  readonly [stardewManifestHandoffSelectionBrand]: never;
}>;

declare const stardewManifestAdmissionBrand: unique symbol;

/**
 * Composition-private, fieldless admission capability. No manifest, request,
 * owner, path, or session material is represented on this value.
 */
type StardewManifestAdmission = Readonly<{ readonly [stardewManifestAdmissionBrand]: never }>;

/**
 * One cabin this companion may move into.
 *
 * `cabinId` is the Mod's own identity for the cabin (`stardew-session.json` `cabins[].cabinId`, written from
 * `cabin.NameOrUniqueName`), and `displayLabel` is this layer's rendering of it: the cabin's position in the Mod's
 * own, UNFILTERED cabin list. The pair travels together because the word alone cannot say which cabin it names - a
 * label re-derived later from a shorter list would point at a different cabin.
 */
export type StardewManifestHandoffChoice = Readonly<{
  cabinId: string;
  displayLabel: string;
  expiresAtMs: number;
  selection: StardewManifestHandoffSelection;
}>;

export type StardewManifestHandoffCoordinator = Readonly<{
  list(owner: StardewOwnedPlayerHostBootstrap): Promise<readonly StardewManifestHandoffChoice[]>;
  select(owner: StardewOwnedPlayerHostBootstrap, candidateCabinId: string): Promise<StardewManifestHandoffSelection>;
  confirmAndAdmit(
    selection: StardewManifestHandoffSelection,
    confirmation: Readonly<{ confirmed: true }>,
  ): Promise<StardewManifestAdmission>;
  /**
   * Owner-bound join request identity of an admission THIS composition minted.
   * The integration-private world-creation seam can only read the observed save
   * slot from the signed join manifest that was issued for one specific
   * attachment request, so the request identity must come from the admission
   * itself: it is minted inside `confirmAndAdmit` and is exposed only for the
   * exact owner and composition it was admitted for. A forged, foreign,
   * quarantined or expired admission fails closed; a caller can therefore never
   * name a request whose manifest belongs to another world or another surface.
   */
  readAdmittedJoinRequestId(owner: StardewOwnedPlayerHostBootstrap, admission: StardewManifestAdmission): string;
  /**
   * Whether the admission's publication took effect in the save the Player Host has loaded.
   *
   * This is the ONE reader of the question the cabin press's quarantine turns on, and it is private to
   * this composition for the two facts only it holds: the admission (so the answer is about the world
   * and farmhand THIS attempt's manifest named, never about "some world") and the attempt's own session
   * material (so it reads the document the Mod published for this attempt). The reading carries both
   * clocks and the attempt record it was taken under, which is what the release re-checks.
   *
   * A quarantined owner stays readable HERE and nowhere else: every other member of this object refuses a
   * quarantined attempt (`assertManifestHandoffOwnerAdmissible`), because a quarantined attempt may be
   * asked what happened but never driven.
   */
  readCabinOccupancy(
    owner: StardewOwnedPlayerHostBootstrap,
    admission: StardewManifestAdmission,
  ): Promise<StardewCabinOccupancyEvidence>;
  /**
   * The ONE release of the cabin press's quarantined attempt, behind the four assertions in
   * `releaseCabinPublicationQuarantine`, which is the only writer it reaches.
   *
   * The admission is required, not optional: assertion (d) is about this attempt's own world, and the
   * manifest this admission names is the only place that world identity exists.
   */
  releaseQuarantinedCabinPublication(
    owner: StardewOwnedPlayerHostBootstrap,
    admission: StardewManifestAdmission,
    evidence: StardewCabinOccupancyEvidence,
    probe: StardewGuardianNamedObjectProbe,
  ): Promise<void>;
}>;

type StardewManifestAdmissionValue = Awaited<ReturnType<StardewManifestHandoffCoordinator["confirmAndAdmit"]>>;

type MaterializeAiClientProfileAfterManifestAdmission = (
  owner: StardewOwnedPlayerHostBootstrap,
  admission: StardewManifestAdmissionValue,
) => Promise<void>;

export type StardewPrivateBootstrapInternalComposition = Readonly<{
  readonly composition: StardewPrivateBootstrapComposition;
  createOwnedPlayerHostAttachmentFlow(owner: StardewOwnedPlayerHostBootstrap): StardewAttachmentFlow;
  readAndCorrelateOwnedPlayerHostSession(owner: StardewOwnedPlayerHostBootstrap): Promise<boolean>;
  createOwnedPlayerHostManifestHandoffCoordinator(): StardewManifestHandoffCoordinator;
  materializeAiClientProfileAfterManifestAdmission(
    owner: StardewOwnedPlayerHostBootstrap,
    admission: StardewManifestAdmission,
  ): Promise<void>;
  launchMaterializedAiClient(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedAiClientStageDResult>;
  /**
   * Composition-private contained AI-client launch. The same owner/profile/
   * inventory/bridge validations and fresh identity reread as
   * `launchMaterializedAiClient` run first; then the launch decision receives
   * a `StardewContainedAiClientLaunchSeam`. Invoking the seam's producer (the
   * Host runtime's `launchRole` step) atomically commits the exact one-shot
   * AI-client reservation and marks the process owner awaiting attestation
   * without creating a raw child; the kill-on-close Guardian Job owns the
   * native process at platform close.
   */
  launchMaterializedAiClientContained(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
    launchContained: (launch: StardewContainedAiClientLaunchSeam) => Promise<void> | void,
  ): Promise<StardewOwnedAiClientStageDResult>;
  consumeOwnedFarmhandBridgeConnection<T extends Readonly<{ close(): void | Promise<void> }>>(
    owner: StardewOwnedPlayerHostBootstrap,
    callback: (connection: StardewPrivateFarmhandBridgeConnection) => Promise<T> | T,
  ): Promise<T>;
  /**
   * Per-activation fresh connection/launch authority. Re-arms the one-shot
   * Farmhand bridge connection and AI-client launch reservation only after the
   * previous activation fully ended (connection consumed and AI launch
   * claimed): the ended AI is stopped, a fresh launch generation is reserved
   * and durably rotated, and both states re-arm. Deferred-error vocabulary
   * matches `consumeOwnedFarmhandBridgeConnection`.
   */
  prepareFreshFarmhandAiClientActivation(owner: StardewOwnedPlayerHostBootstrap): Promise<{ launchGeneration: string }>;
  /**
   * Rolls a re-armed-but-not-yet-attached fresh activation back to the fully
   * consumed base so a later resume can prepare a new generation again.
   */
  abandonFarmhandAiClientActivation(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  launchStagedPlayerHost(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
  /**
   * Composition-private contained Player Host launch. Performing the exact
   * same owner/staging validations and fresh identity reread as
   * `launchStagedPlayerHost`, it hands the launch decision a
   * `StardewContainedPlayerHostLaunchSeam`; once that decision invokes the
   * runtime with `launchRole`, the seam's producer atomically claims the
   * one-shot reservation and authorizes the recipe-derived typed facts. Any
   * failure after the claim is classified through
   * `didStardewOwnedPlayerHostStageCEnterControlledLaunch` exactly like the
   * direct-spawn Stage C consumer.
   */
  launchStagedPlayerHostContained(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
    launchContained: (launch: StardewContainedPlayerHostLaunchSeam) => Promise<void> | void,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
  replaceStagedInstallationLocator(
    owner: StardewOwnedPlayerHostBootstrap,
    expectedRevision: number,
    locator: string,
  ): Promise<void>;
  reserveOwnedPlayerHostBootstrapForActivation(
    runtimeRoot: string,
    claim: StardewPlayerHostBootstrapClaim,
  ): Promise<StardewOwnedPlayerHostBootstrap>;
  stageOwnedPlayerHostProfile(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  terminalizeOwnedPlayerHostOwner(owner: StardewOwnedPlayerHostBootstrap): void;
  /**
   * Records that the attempt this composition prepared is over - the Guardian reported the Player
   * Host's exit, or an explicit endgame settled it - so both process owners' one-shot launch
   * reservations are spent and the next attempt mints its own. It is the Player Host's counterpart
   * of the AI client's "the ended activation is superseded" edge, and it never kills, contains or
   * probes anything (ADR-0007, ADR-0015 §6 U4a).
   */
  noteAttemptEnded(): void;
  quarantineOwnedPlayerHostOwner(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  /**
   * Drops the attempt's private session material when this Host forgets the attempt.
   *
   * The quarantine deliberately keeps it (`quarantineOwner` says why: the cabin-occupancy probe authenticates a
   * read of the Mod's document with that token), so the attempt's end is the one place the secret goes.
   */
  forgetOwnedPlayerHostMaterial(owner: StardewOwnedPlayerHostBootstrap): void;
  /**
   * Best effort: merge the player's action policy into the config of the attempt
   * this owner owns, so a save reaches a running world through the Mod's own
   * 120-tick reread. `written: false` means there was no config to write (no
   * AI-client profile materialized yet, or the attempt was settled and cleaned
   * up), which is a state rather than a failure.
   */
  projectPlayerActionPolicyIntoOwnedAttempt(
    owner: StardewOwnedPlayerHostBootstrap,
    policy: StardewModActionPolicyProjection,
  ): Promise<{ written: boolean }>;
  /**
   * Host-boot reconcile of the one durable installation-registration pointer.
   *
   * Every ordinary close and every crash quarantines the owner record and leaves
   * the registration's `activeAttempt` bound, so the next launch is refused with
   * `stardew_bootstrap_registration_unavailable`. This pass releases that pointer
   * for an attempt whose owner record is terminal AND whose Guardian-owned
   * objects the OS proves gone. It is bookkeeping only: it never claims
   * containment, never touches `containedRuntimeTeardown.settle`, and never
   * widens what the Guardian's own settlement proof is allowed to say.
   */
  reconcileHeldBootstrapRegistration(
    runtimeRoot: string,
    probe: StardewGuardianNamedObjectProbe,
  ): Promise<StardewBootstrapRegistrationReconcileReport>;
}>;

export function createStardewPrivateBootstrapProductionCore(
  physical: Pick<
    StardewPrivateBootstrapCoreDependencies,
    "rawSpawn" | "rawProbe" | "rawPlayerHostSpawn" | "rawPlayerHostProbe"
  > &
    Readonly<{ staging: PrivateModProfileStagingDependencies }>,
): StardewPrivateBootstrapInternalComposition {
  if (platform() !== "win32") {
    throw new Error("stardew_private_bootstrap_composition_requires_windows");
  }
  const closed = createStardewPrivateBootstrapCore({
    rawSpawn: physical.rawSpawn,
    rawProbe: physical.rawProbe,
    rawPlayerHostSpawn: physical.rawPlayerHostSpawn,
    rawPlayerHostProbe: physical.rawPlayerHostProbe,
    createBootstrapIdentity: randomUUID,
    createGuardianRevision: randomUUID,
    createGuardianInstanceId: randomUUID,
    createGuardianEpoch: () => 1,
    createGuardianLeaseName: () => `Local\\GameBuddy-${randomUUID()}`,
    createGuardianPlayerJobName: () => `Local\\GameBuddy-${randomUUID()}`,
    createGuardianAiJobName: () => `Local\\GameBuddy-${randomUUID()}`,
    createLaunchGeneration: randomUUID,
    createPlayerHostLaunchGeneration: randomUUID,
    createBridgePipeName: createPrivateBridgePipeName,
    createBridgeToken: createPrivateBridgeToken,
    nowMs: Date.now,
    staging: physical.staging,
  });
  return Object.freeze({
    composition: closed.composition,
    createOwnedPlayerHostAttachmentFlow: closed.createOwnedPlayerHostAttachmentFlow,
    readAndCorrelateOwnedPlayerHostSession: closed.readAndCorrelateOwnedPlayerHostSession,
    createOwnedPlayerHostManifestHandoffCoordinator: closed.createOwnedPlayerHostManifestHandoffCoordinator,
    materializeAiClientProfileAfterManifestAdmission: closed.materializeAiClientProfileAfterManifestAdmission,
    launchMaterializedAiClient: closed.launchMaterializedAiClient,
    launchMaterializedAiClientContained: closed.launchMaterializedAiClientContained,
    consumeOwnedFarmhandBridgeConnection: closed.consumeOwnedFarmhandBridgeConnection,
    prepareFreshFarmhandAiClientActivation: closed.prepareFreshFarmhandAiClientActivation,
    abandonFarmhandAiClientActivation: closed.abandonFarmhandAiClientActivation,
    launchStagedPlayerHost: closed.launchStagedPlayerHost,
    launchStagedPlayerHostContained: closed.launchStagedPlayerHostContained,
    replaceStagedInstallationLocator: closed.replaceStagedInstallationLocator,
    reserveOwnedPlayerHostBootstrapForActivation: closed.reserveOwnedPlayerHostBootstrapForActivation,
    stageOwnedPlayerHostProfile: closed.stageOwnedPlayerHostProfile,
    terminalizeOwnedPlayerHostOwner: closed.terminalizeOwnedPlayerHostOwner,
    noteAttemptEnded: closed.noteAttemptEnded,
    quarantineOwnedPlayerHostOwner: closed.quarantineOwnedPlayerHostOwner,
    forgetOwnedPlayerHostMaterial: closed.forgetOwnedPlayerHostMaterial,
    projectPlayerActionPolicyIntoOwnedAttempt: closed.projectPlayerActionPolicyIntoOwnedAttempt,
    reconcileHeldBootstrapRegistration: closed.reconcileHeldBootstrapRegistration,
  });
}

export type StardewOwnedPlayerHostPhaseACoreTestView = Readonly<{
  readonly record: StardewOwnedPlayerHostBootstrapOwnerRecord;
  readonly transactionDirectory: string;
  quarantine(): Promise<void>;
  consumePlayerHostLaunch<T>(callback: (launch: StardewPlayerHostLaunch) => T): T;
  consumeAiClientLaunch<T>(callback: (launch: StardewAiClientLaunch) => T): T;
  /**
   * Test-only boolean observation of the private Stage-B session material
   * retained inside the exact owner facts. Returns presence only; no secret,
   * path, or value surface is exposed. The exact same-composition bind
   * rejects forged and cross-composition owners before this is reachable.
   */
  hasPrivateMaterial(): boolean;
}>;

export type StardewOwnedPlayerHostStageCResult = Readonly<{
  status: StardewPlayerHostProcessStatus;
  modsRoot: StardewPlayerHostModsRoot;
}>;

/**
 * What the launch found in the player's own `Mods` folder and carried into the
 * isolated SMAPI profile root it hands over as `--mods-path`.
 *
 * `kind: "empty"` is the named state a caller reads when a launch carries no
 * player Mod at all. It is deliberately NOT a refusal: a vanilla player, and a
 * game folder SMAPI has not created `Mods` in yet, are both legitimate and both
 * playable. What is refused is a launch whose profile root ends up without the
 * staged Mod itself, and every step that cannot carry an entry names itself
 * (`mods_root_target_missing:<name>`, `mods_root_copy_failed:<name>`), while a
 * link that could not be made is named in `linkRefusals` and carried by copy.
 */
export type StardewPlayerHostModsRoot =
  | Readonly<{
      kind: "carried";
      /** The player's Mod directory names now present in the profile root, sorted. */
      entries: readonly string[];
      /** One `mods_root_link_refused:<errno>` per entry a link could not carry and a copy did. */
      linkRefusals: readonly string[];
    }>
  | Readonly<{
      kind: "empty";
      reason: "player_mods_root_absent" | "player_mods_root_holds_only_staged_mod";
    }>;

export type StardewOwnedAiClientStageDResult = Readonly<{
  status: StardewAiClientProcessStatus;
}>;

export function createStardewPrivateBootstrapTestCore(dependencies: StardewPrivateBootstrapCoreDependencies): Readonly<{
  composition: StardewPrivateBootstrapComposition;
  consumeStagedOwnedPlayerHostProfile(owner: StardewOwnedPlayerHostBootstrap): void;
  createOwnedPlayerHostAttachmentFlow(owner: StardewOwnedPlayerHostBootstrap): StardewAttachmentFlow;
  readAndCorrelateOwnedPlayerHostSession(owner: StardewOwnedPlayerHostBootstrap): Promise<boolean>;
  createOwnedPlayerHostManifestHandoffCoordinator(): StardewManifestHandoffCoordinator;
  materializeAiClientProfileAfterManifestAdmission: MaterializeAiClientProfileAfterManifestAdmission;
  launchMaterializedAiClient(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedAiClientStageDResult>;
  /**
   * Composition-private contained AI-client launch. The same owner/profile/
   * inventory/bridge validations and fresh identity reread as
   * `launchMaterializedAiClient` run first; then the launch decision receives
   * a `StardewContainedAiClientLaunchSeam`. Invoking the seam's producer (the
   * Host runtime's `launchRole` step) atomically commits the exact one-shot
   * AI-client reservation and marks the process owner awaiting attestation
   * without creating a raw child; the kill-on-close Guardian Job owns the
   * native process at platform close.
   */
  launchMaterializedAiClientContained(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
    launchContained: (launch: StardewContainedAiClientLaunchSeam) => Promise<void> | void,
  ): Promise<StardewOwnedAiClientStageDResult>;
  consumeOwnedFarmhandBridgeConnection<T extends Readonly<{ close(): void | Promise<void> }>>(
    owner: StardewOwnedPlayerHostBootstrap,
    callback: (connection: StardewPrivateFarmhandBridgeConnection) => Promise<T> | T,
  ): Promise<T>;
  /**
   * Per-activation fresh connection/launch authority. Re-arms the one-shot
   * Farmhand bridge connection and AI-client launch reservation only after the
   * previous activation fully ended (connection consumed and AI launch
   * claimed): the ended AI is stopped, a fresh launch generation is reserved
   * and durably rotated, and both states re-arm. Deferred-error vocabulary
   * matches `consumeOwnedFarmhandBridgeConnection`.
   */
  prepareFreshFarmhandAiClientActivation(owner: StardewOwnedPlayerHostBootstrap): Promise<{ launchGeneration: string }>;
  /**
   * Rolls a re-armed-but-not-yet-attached fresh activation back to the fully
   * consumed base so a later resume can prepare a new generation again.
   */
  abandonFarmhandAiClientActivation(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  launchStagedPlayerHost(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
  launchStagedPlayerHostContained(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
    launchContained: (launch: StardewContainedPlayerHostLaunchSeam) => Promise<void> | void,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
  replaceStagedInstallationLocator(
    owner: StardewOwnedPlayerHostBootstrap,
    expectedRevision: number,
    locator: string,
  ): Promise<void>;
  reserveOwnedPlayerHostBootstrapForActivation(
    runtimeRoot: string,
    claim: StardewPlayerHostBootstrapClaim,
  ): Promise<StardewOwnedPlayerHostBootstrap>;
  stageOwnedPlayerHostProfile(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  terminalizeOwnedPlayerHostOwner(owner: StardewOwnedPlayerHostBootstrap): void;
  /**
   * Records that the attempt this composition prepared is over - the Guardian reported the Player
   * Host's exit, or an explicit endgame settled it - so both process owners' one-shot launch
   * reservations are spent and the next attempt mints its own. It is the Player Host's counterpart
   * of the AI client's "the ended activation is superseded" edge, and it never kills, contains or
   * probes anything (ADR-0007, ADR-0015 §6 U4a).
   */
  noteAttemptEnded(): void;
  quarantineOwnedPlayerHostOwner(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  /**
   * Drops the attempt's private session material when this Host forgets the attempt.
   *
   * The quarantine deliberately keeps it (`quarantineOwner` says why: the cabin-occupancy probe authenticates a
   * read of the Mod's document with that token), so the attempt's end is the one place the secret goes.
   */
  forgetOwnedPlayerHostMaterial(owner: StardewOwnedPlayerHostBootstrap): void;
  projectPlayerActionPolicyIntoOwnedAttempt(
    owner: StardewOwnedPlayerHostBootstrap,
    policy: StardewModActionPolicyProjection,
  ): Promise<{ written: boolean }>;
  bindOwnedPlayerHostPhaseAOwner(owner: StardewOwnedPlayerHostBootstrap): StardewOwnedPlayerHostPhaseACoreTestView;
  reconcileHeldBootstrapRegistration(
    runtimeRoot: string,
    probe: StardewGuardianNamedObjectProbe,
  ): Promise<StardewBootstrapRegistrationReconcileReport>;
  createOwnerTransitionsForTesting(
    input: Readonly<{
      ownerPath: string;
      containmentRoot: string;
      immutableFence: StardewOwnerImmutableFence;
    }>,
  ): StardewOwnerTransitionPrimitives;
}> {
  validateTestingDependencies(dependencies);
  const base = createStardewPrivateBootstrapCore(dependencies);
  const owned = new WeakSet<object>();
  const reserveOwnedPlayerHostBootstrap = base.composition.reserveOwnedPlayerHostBootstrap.bind(base.composition);
  const composition: StardewPrivateBootstrapComposition = Object.freeze({
    ...base.composition,
    async reserveOwnedPlayerHostBootstrap(...args) {
      const owner = await reserveOwnedPlayerHostBootstrap(...args);
      owned.add(owner);
      return owner;
    },
  });
  return Object.freeze({
    composition,
    consumeStagedOwnedPlayerHostProfile(owner) {
      // Composition-bound test-only staged consume: the base closed
      // composition supplies its stored identity, so owners minted by any
      // other composition are rejected before the staged marker changes.
      base.consumeStagedOwnedPlayerHostProfile(owner);
    },
    createOwnedPlayerHostAttachmentFlow(owner) {
      // Composition-bound test-only attachment factory: the base closed
      // composition supplies its stored identity, so forged and cross-
      // composition owners are rejected before any flow is constructed.
      return base.createOwnedPlayerHostAttachmentFlow(owner);
    },
    readAndCorrelateOwnedPlayerHostSession(owner) {
      return base.readAndCorrelateOwnedPlayerHostSession(owner);
    },
    createOwnedPlayerHostManifestHandoffCoordinator() {
      return base.createOwnedPlayerHostManifestHandoffCoordinator();
    },
    materializeAiClientProfileAfterManifestAdmission(owner, admission) {
      return base.materializeAiClientProfileAfterManifestAdmission(owner, admission);
    },
    launchMaterializedAiClient(owner, installation) {
      return base.launchMaterializedAiClient(owner, installation);
    },
    launchMaterializedAiClientContained(owner, installation, launchContained) {
      return base.launchMaterializedAiClientContained(owner, installation, launchContained);
    },
    consumeOwnedFarmhandBridgeConnection(owner, callback) {
      return base.consumeOwnedFarmhandBridgeConnection(owner, callback);
    },
    prepareFreshFarmhandAiClientActivation(owner) {
      return base.prepareFreshFarmhandAiClientActivation(owner);
    },
    abandonFarmhandAiClientActivation(owner) {
      return base.abandonFarmhandAiClientActivation(owner);
    },
    launchStagedPlayerHost(owner, installation) {
      // Composition-bound test-only staged Player Host launch: the base closed
      // composition supplies its stored identity, so forged and
      // cross-composition owners are rejected before the launch attempt.
      return base.launchStagedPlayerHost(owner, installation);
    },
    launchStagedPlayerHostContained(owner, installation, launchContained) {
      return base.launchStagedPlayerHostContained(owner, installation, launchContained);
    },
    replaceStagedInstallationLocator(owner, expectedRevision, locator) {
      return base.replaceStagedInstallationLocator(owner, expectedRevision, locator);
    },
    reserveOwnedPlayerHostBootstrapForActivation(runtimeRoot, claim) {
      return base.reserveOwnedPlayerHostBootstrapForActivation(runtimeRoot, claim);
    },
    stageOwnedPlayerHostProfile(owner) {
      return base.stageOwnedPlayerHostProfile(owner);
    },
    terminalizeOwnedPlayerHostOwner(owner) {
      base.terminalizeOwnedPlayerHostOwner(owner);
    },
    noteAttemptEnded() {
      base.noteAttemptEnded();
    },
    quarantineOwnedPlayerHostOwner(owner) {
      return base.quarantineOwnedPlayerHostOwner(owner);
    },
    forgetOwnedPlayerHostMaterial(owner) {
      base.forgetOwnedPlayerHostMaterial(owner);
    },
    projectPlayerActionPolicyIntoOwnedAttempt(owner, policy) {
      return base.projectPlayerActionPolicyIntoOwnedAttempt(owner, policy);
    },
    reconcileHeldBootstrapRegistration(runtimeRoot, probe) {
      return base.reconcileHeldBootstrapRegistration(runtimeRoot, probe);
    },
    bindOwnedPlayerHostPhaseAOwner(owner) {
      const facts = requireOwnedPlayerHostBootstrapFacts(owner);
      return Object.freeze({
        get record() {
          return facts.durableOwner.record as StardewOwnedPlayerHostBootstrapOwnerRecord;
        },
        get transactionDirectory() {
          return facts.durableOwner.transactionDirectory;
        },
        quarantine: facts.quarantineOwner,
        consumePlayerHostLaunch: facts.consumePlayerHostLaunch,
        consumeAiClientLaunch: facts.consumeAiClientLaunch,
        hasPrivateMaterial: () => facts.privateMaterial.value !== null,
      });
    },
    createOwnerTransitionsForTesting(input) {
      return createStardewBootstrapOwnerTransitionPrimitives(input, productionOwnerTransitionPersistence);
    },
  });
}

function createStardewPrivateBootstrapCore(dependencies: StardewPrivateBootstrapCoreDependencies): ClosedBootstrapCore {
  validateTestingDependencies(dependencies);
  return createClosedComposition(dependencies);
}

/**
 * Private closed-core seam: the public composition projection plus the
 * closure-owned staged-consume primitive bound to the exact composition
 * identity object. This shape is never exported; only the closed composition
 * and the dedicated test composition hold it.
 */
type ClosedBootstrapCore = Readonly<{
  readonly composition: StardewPrivateBootstrapComposition;
  consumeStagedOwnedPlayerHostProfile(owner: StardewOwnedPlayerHostBootstrap): void;
  createOwnedPlayerHostAttachmentFlow(owner: StardewOwnedPlayerHostBootstrap): StardewAttachmentFlow;
  readAndCorrelateOwnedPlayerHostSession(owner: StardewOwnedPlayerHostBootstrap): Promise<boolean>;
  createOwnedPlayerHostManifestHandoffCoordinator(): StardewManifestHandoffCoordinator;
  materializeAiClientProfileAfterManifestAdmission: MaterializeAiClientProfileAfterManifestAdmission;
  launchMaterializedAiClient(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedAiClientStageDResult>;
  /**
   * Composition-private contained AI-client launch. The same owner/profile/
   * inventory/bridge validations and fresh identity reread as
   * `launchMaterializedAiClient` run first; then the launch decision receives
   * a `StardewContainedAiClientLaunchSeam`. Invoking the seam's producer (the
   * Host runtime's `launchRole` step) atomically commits the exact one-shot
   * AI-client reservation and marks the process owner awaiting attestation
   * without creating a raw child; the kill-on-close Guardian Job owns the
   * native process at platform close.
   */
  launchMaterializedAiClientContained(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
    launchContained: (launch: StardewContainedAiClientLaunchSeam) => Promise<void> | void,
  ): Promise<StardewOwnedAiClientStageDResult>;
  consumeOwnedFarmhandBridgeConnection<T extends Readonly<{ close(): void | Promise<void> }>>(
    owner: StardewOwnedPlayerHostBootstrap,
    callback: (connection: StardewPrivateFarmhandBridgeConnection) => Promise<T> | T,
  ): Promise<T>;
  /**
   * Per-activation fresh connection/launch authority. Re-arms the one-shot
   * Farmhand bridge connection and AI-client launch reservation only after the
   * previous activation fully ended (connection consumed and AI launch
   * claimed): the ended AI is stopped, a fresh launch generation is reserved
   * and durably rotated, and both states re-arm. Deferred-error vocabulary
   * matches `consumeOwnedFarmhandBridgeConnection`.
   */
  prepareFreshFarmhandAiClientActivation(owner: StardewOwnedPlayerHostBootstrap): Promise<{ launchGeneration: string }>;
  /**
   * Rolls a re-armed-but-not-yet-attached fresh activation back to the fully
   * consumed base so a later resume can prepare a new generation again.
   */
  abandonFarmhandAiClientActivation(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  launchStagedPlayerHost(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
  launchStagedPlayerHostContained(
    owner: StardewOwnedPlayerHostBootstrap,
    installation: AdmittedStardewInstallation,
    launchContained: (launch: StardewContainedPlayerHostLaunchSeam) => Promise<void> | void,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
  replaceStagedInstallationLocator(
    owner: StardewOwnedPlayerHostBootstrap,
    expectedRevision: number,
    locator: string,
  ): Promise<void>;
  reserveOwnedPlayerHostBootstrapForActivation(
    runtimeRoot: string,
    claim: StardewPlayerHostBootstrapClaim,
  ): Promise<StardewOwnedPlayerHostBootstrap>;
  stageOwnedPlayerHostProfile(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  terminalizeOwnedPlayerHostOwner(owner: StardewOwnedPlayerHostBootstrap): void;
  /**
   * Records that the attempt this composition prepared is over - the Guardian reported the Player
   * Host's exit, or an explicit endgame settled it - so both process owners' one-shot launch
   * reservations are spent and the next attempt mints its own. It is the Player Host's counterpart
   * of the AI client's "the ended activation is superseded" edge, and it never kills, contains or
   * probes anything (ADR-0007, ADR-0015 §6 U4a).
   */
  noteAttemptEnded(): void;
  quarantineOwnedPlayerHostOwner(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  forgetOwnedPlayerHostMaterial(owner: StardewOwnedPlayerHostBootstrap): void;
  projectPlayerActionPolicyIntoOwnedAttempt(
    owner: StardewOwnedPlayerHostBootstrap,
    policy: StardewModActionPolicyProjection,
  ): Promise<{ written: boolean }>;
  reconcileHeldBootstrapRegistration(
    runtimeRoot: string,
    probe: StardewGuardianNamedObjectProbe,
  ): Promise<StardewBootstrapRegistrationReconcileReport>;
}>;

function createClosedComposition(dependencies: StardewPrivateBootstrapCoreDependencies): ClosedBootstrapCore {
  const stagingDependencies =
    dependencies.staging === undefined ? undefined : Object.freeze({ ...dependencies.staging });
  const compositionIdentity = Object.freeze({});
  const claims = new WeakMap<StardewPlayerHostBootstrapClaim, ClaimRegistration>();
  const playerHostLaunches = new WeakMap<StardewPlayerHostLaunchReservation, PlayerHostLaunchRegistration>();
  const aiLaunches = new WeakMap<StardewAiClientLaunchReservation, AiLaunchRegistration>();
  // Only the activation path marks a claim for the registration-bound owner
  // transaction. The older raw reservation path remains test-only plumbing and
  // cannot manufacture a registration pointer.
  const registrationBoundClaims = new WeakSet<StardewPlayerHostBootstrapClaim>();
  const manifestHandoff = createManifestHandoffCoordinatorCore(
    compositionIdentity,
    dependencies.nowMs,
    () => requireStagingDependencies(stagingDependencies),
    dependencies.createBridgePipeName,
    dependencies.createBridgeToken,
  );
  const manifestHandoffCoordinator = manifestHandoff.coordinator;

  const registerConsumedClaim = (claim: StardewPlayerHostBootstrapClaim, facts: StardewPrivateBootstrapFacts): void => {
    if (claims.has(claim)) throw new Error("stardew_bootstrap_claim_already_registered");
    claims.set(claim, {
      state: "available",
      facts: freezeBootstrapFacts(facts),
    });
  };

  const registerAiClientLaunch = (
    reservation: StardewAiClientLaunchReservation,
    registration: StardewAiClientLaunchRegistration,
  ): void => {
    if (aiLaunches.has(reservation)) throw new Error("stardew_ai_client_reservation_already_registered");
    aiLaunches.set(reservation, {
      state: "available",
      registration,
    });
  };

  const registerPlayerHostLaunch = (
    reservation: StardewPlayerHostLaunchReservation,
    registration: StardewPlayerHostLaunchRegistration,
  ): void => {
    if (playerHostLaunches.has(reservation)) throw new Error("stardew_player_host_reservation_already_registered");
    playerHostLaunches.set(reservation, {
      state: "available",
      registration,
    });
  };

  const broker = createPlayerHostBootstrapBroker(
    registerConsumedClaim,
    dependencies.createBootstrapIdentity,
    dependencies.nowMs,
  );
  const playerHostProcessOwner = createPlayerHostProcessOwner(
    dependencies.rawPlayerHostSpawn,
    dependencies.rawPlayerHostProbe,
    dependencies.createPlayerHostLaunchGeneration,
    registerPlayerHostLaunch,
  );
  const aiClientProcessOwner = createAiClientProcessOwner(
    dependencies.rawSpawn,
    dependencies.rawProbe,
    dependencies.createLaunchGeneration,
    registerAiClientLaunch,
  );

  const composition: StardewPrivateBootstrapComposition = Object.freeze({
    broker,
    playerHostProcessOwner,
    aiClientProcessOwner,
    createRoleLifecycleFacade(attachment) {
      return createStardewRoleLifecycleFacade(attachment, aiClientProcessOwner, playerHostProcessOwner);
    },
    async reserveExternalPlayerHostPhaseA(runtimeRoot, claim, aiClientReservation) {
      const claimRegistration = claims.get(claim);
      if (claimRegistration === undefined) throw new Error("stardew_bootstrap_claim_not_registered");
      const aiLaunchRegistration = aiLaunches.get(aiClientReservation);
      if (aiLaunchRegistration === undefined) throw new Error("stardew_ai_client_reservation_not_registered");
      if (claimRegistration.state !== "available") throw new Error("stardew_bootstrap_claim_not_available");
      if (aiLaunchRegistration.state !== "available") throw new Error("stardew_ai_client_reservation_not_available");

      // Bind exact nominal identities synchronously before persistence awaits.
      claimRegistration.state = "binding";
      aiLaunchRegistration.state = "binding";

      let durableOwner: DurableOwnerFor<StardewExternalPlayerHostPhaseAOwnerOwnerRecord>;
      try {
        durableOwner = await persistPrivateBootstrapOwner({
          runtimeRoot,
          bootstrapFacts: claimRegistration.facts,
          guardian: createGuardianBinding(dependencies),
          playerHost: { kind: "external_unattested" as const },
          aiClientLaunchGeneration: aiLaunchRegistration.registration.launchGeneration,
          readClock: dependencies.nowMs,
        });
      } catch (error) {
        try {
          aiLaunchRegistration.registration.revoke();
        } catch {
          /* fail closed */
        }
        throw error;
      } finally {
        claimRegistration.state = "consumed";
        aiLaunchRegistration.state = "consumed";
      }

      // The durable reread is not enough if the absolute deadline elapsed
      // while writing/reading. Quarantine and revoke before failing closed.
      if (claimRegistration.facts.expiresAtMs <= dependencies.nowMs()) {
        try {
          await durableOwner.quarantine();
        } finally {
          try {
            aiLaunchRegistration.registration.revoke();
          } catch {
            /* fail closed */
          }
        }
        throw new Error("stardew_bootstrap_claim_expired_after_persistence");
      }

      return composeExternalPlayerHostOwner(
        durableOwner,
        aiLaunchRegistration.registration,
        claimRegistration.facts.expiresAtMs,
        dependencies.nowMs,
      );
    },
    async reserveOwnedPlayerHostBootstrap(runtimeRoot, claim, playerHostReservation, aiClientReservation) {
      const claimRegistration = claims.get(claim);
      if (claimRegistration === undefined) throw new Error("stardew_bootstrap_claim_not_registered");
      const playerHostLaunchRegistration = playerHostLaunches.get(playerHostReservation);
      if (playerHostLaunchRegistration === undefined) throw new Error("stardew_player_host_reservation_not_registered");
      const aiLaunchRegistration = aiLaunches.get(aiClientReservation);
      if (aiLaunchRegistration === undefined) throw new Error("stardew_ai_client_reservation_not_registered");
      if (claimRegistration.state !== "available") throw new Error("stardew_bootstrap_claim_not_available");
      if (playerHostLaunchRegistration.state !== "available")
        throw new Error("stardew_player_host_reservation_not_available");
      if (aiLaunchRegistration.state !== "available") throw new Error("stardew_ai_client_reservation_not_available");

      // Bind all three exact nominal identities synchronously before any
      // persistence await. A competing join can therefore never reuse a pair.
      claimRegistration.state = "binding";
      playerHostLaunchRegistration.state = "binding";
      aiLaunchRegistration.state = "binding";

      let durableOwner: DurableOwnerFor<StardewOwnedPlayerHostBootstrapOwnerRecord>;
      try {
        const guardian = createGuardianBinding(dependencies);
        const persist = (reuseExistingOwner = false) =>
          persistPrivateBootstrapOwner({
            runtimeRoot,
            bootstrapFacts: claimRegistration.facts,
            guardian,
            playerHost: {
              kind: "launch_reserved" as const,
              launchGeneration: playerHostLaunchRegistration.registration.launchGeneration,
            },
            aiClientLaunchGeneration: aiLaunchRegistration.registration.launchGeneration,
            readClock: dependencies.nowMs,
            reuseExistingOwner,
          });
        durableOwner = registrationBoundClaims.delete(claim)
          ? await prepareAndBindOwnedRegistrationAttempt(runtimeRoot, claimRegistration.facts, persist)
          : await persist();
      } catch (error) {
        try {
          playerHostLaunchRegistration.registration.revoke();
        } catch {
          /* fail closed */
        }
        try {
          aiLaunchRegistration.registration.revoke();
        } catch {
          /* fail closed */
        }
        throw error;
      } finally {
        claimRegistration.state = "consumed";
        playerHostLaunchRegistration.state = "consumed";
        aiLaunchRegistration.state = "consumed";
      }

      if (claimRegistration.facts.expiresAtMs <= dependencies.nowMs()) {
        try {
          await durableOwner.quarantine();
        } finally {
          try {
            playerHostLaunchRegistration.registration.revoke();
          } catch {
            /* fail closed */
          }
          try {
            aiLaunchRegistration.registration.revoke();
          } catch {
            /* fail closed */
          }
        }
        throw new Error("stardew_bootstrap_claim_expired_after_persistence");
      }

      const owner = composeOwnedPlayerHostOwner(
        durableOwner,
        playerHostLaunchRegistration.registration,
        aiLaunchRegistration.registration,
        claimRegistration.facts.expiresAtMs,
        dependencies.nowMs,
        compositionIdentity,
      );
      const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      if (stagingDependencies !== undefined) facts.stagingDependencies = stagingDependencies;
      return owner;
    },
  });
  return Object.freeze({
    composition,
    consumeStagedOwnedPlayerHostProfile: (owner: StardewOwnedPlayerHostBootstrap): void => {
      consumeStagedOwnedPlayerHostProfile(owner, compositionIdentity);
    },
    createOwnedPlayerHostAttachmentFlow: (owner: StardewOwnedPlayerHostBootstrap): StardewAttachmentFlow =>
      createOwnedPlayerHostAttachmentFlowCore(owner, compositionIdentity, dependencies.nowMs),
    readAndCorrelateOwnedPlayerHostSession: (owner: StardewOwnedPlayerHostBootstrap): Promise<boolean> =>
      readAndCorrelateOwnedPlayerHostSessionCore(owner, compositionIdentity, dependencies.nowMs),
    createOwnedPlayerHostManifestHandoffCoordinator: (): StardewManifestHandoffCoordinator =>
      manifestHandoffCoordinator,
    materializeAiClientProfileAfterManifestAdmission: (
      owner: StardewOwnedPlayerHostBootstrap,
      admission: StardewManifestAdmissionValue,
    ): Promise<void> => manifestHandoff.materialize(owner, admission),
    launchMaterializedAiClient: (
      owner: StardewOwnedPlayerHostBootstrap,
      installation: AdmittedStardewInstallation,
    ): Promise<StardewOwnedAiClientStageDResult> =>
      launchMaterializedAiClient(owner, installation, compositionIdentity),
    launchMaterializedAiClientContained: (
      owner: StardewOwnedPlayerHostBootstrap,
      installation: AdmittedStardewInstallation,
      launchContained: (launch: StardewContainedAiClientLaunchSeam) => Promise<void> | void,
    ): Promise<StardewOwnedAiClientStageDResult> =>
      launchMaterializedAiClientContained(owner, installation, launchContained, compositionIdentity),
    consumeOwnedFarmhandBridgeConnection: <T extends Readonly<{ close(): void | Promise<void> }>>(
      owner: StardewOwnedPlayerHostBootstrap,
      callback: (connection: StardewPrivateFarmhandBridgeConnection) => Promise<T> | T,
    ): Promise<T> =>
      consumeOwnedFarmhandBridgeConnection(owner, callback, compositionIdentity, () =>
        aiClientProcessOwner.readStatus(),
      ),
    prepareFreshFarmhandAiClientActivation: (owner: StardewOwnedPlayerHostBootstrap) =>
      prepareFreshFarmhandAiClientActivation(
        owner,
        compositionIdentity,
        () => {
          const capability = aiClientProcessOwner.reserveAiClientLaunch();
          const registration = aiLaunches.get(capability);
          if (registration === undefined) throw new Error("stardew_ai_client_launch_not_registered");
          return registration.registration;
        },
        () => aiClientProcessOwner.readStatus(),
        () => aiClientProcessOwner.stopOwnedAiClient(),
      ),
    abandonFarmhandAiClientActivation: (owner: StardewOwnedPlayerHostBootstrap) =>
      abandonFarmhandAiClientActivation(owner, compositionIdentity),
    launchStagedPlayerHost: (
      owner: StardewOwnedPlayerHostBootstrap,
      installation: AdmittedStardewInstallation,
    ): Promise<StardewOwnedPlayerHostStageCResult> => launchStagedPlayerHost(owner, installation, compositionIdentity),
    launchStagedPlayerHostContained: (
      owner: StardewOwnedPlayerHostBootstrap,
      installation: AdmittedStardewInstallation,
      launchContained: (launch: StardewContainedPlayerHostLaunchSeam) => Promise<void> | void,
    ): Promise<StardewOwnedPlayerHostStageCResult> =>
      launchStagedPlayerHostContained(owner, installation, launchContained, compositionIdentity),
    replaceStagedInstallationLocator: async (owner, expectedRevision, locator): Promise<void> => {
      const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      const runtimeRoot = dirname(dirname(facts.durableOwner.transactionDirectory));
      await withStardewLifecycleInstallationRegistrationOwner(runtimeRoot, async (registration) => {
        await registration.replaceActiveAttemptLocator(
          expectedRevision,
          facts.durableOwner.record.bootstrapId,
          locator,
        );
      });
    },
    reserveOwnedPlayerHostBootstrapForActivation: async (
      runtimeRoot: string,
      claim: StardewPlayerHostBootstrapClaim,
    ): Promise<StardewOwnedPlayerHostBootstrap> => {
      const claimRegistration = claims.get(claim);
      if (claimRegistration === undefined || claimRegistration.state !== "available")
        throw new Error("stardew_bootstrap_claim_not_available");
      let playerReservation: StardewPlayerHostLaunchReservation | undefined;
      let aiReservation: StardewAiClientLaunchReservation | undefined;
      try {
        playerReservation = playerHostProcessOwner.reservePlayerHostLaunch();
        aiReservation = aiClientProcessOwner.reserveAiClientLaunch();
        registrationBoundClaims.add(claim);
        return await composition.reserveOwnedPlayerHostBootstrap(runtimeRoot, claim, playerReservation, aiReservation);
      } catch (error) {
        // No reservation or claim may survive a pre-owner failure. Exact
        // registrations remain closure-private and are revoked here even
        // when the second manager reservation fails synchronously.
        if (playerReservation !== undefined) {
          try {
            playerHostLaunches.get(playerReservation)?.registration.revoke();
          } catch {
            /* fail closed */
          }
          const registration = playerHostLaunches.get(playerReservation);
          if (registration !== undefined) registration.state = "consumed";
        }
        if (aiReservation !== undefined) {
          try {
            aiLaunches.get(aiReservation)?.registration.revoke();
          } catch {
            /* fail closed */
          }
          const registration = aiLaunches.get(aiReservation);
          if (registration !== undefined) registration.state = "consumed";
        }
        registrationBoundClaims.delete(claim);
        claimRegistration.state = "consumed";
        throw error;
      }
    },
    stageOwnedPlayerHostProfile: async (owner: StardewOwnedPlayerHostBootstrap): Promise<void> => {
      requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      await consumeOwnedPlayerHostBootstrap(owner, async () => {
        try {
          await stageOwnedPlayerHostProfile(owner);
        } catch (error) {
          try {
            await requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity).quarantineOwner();
          } finally {
            terminalizeOwnedPlayerHostBootstrap(owner);
          }
          throw error;
        }
      });
    },
    noteAttemptEnded: (): void => {
      playerHostProcessOwner.notePlayerHostEnded();
      aiClientProcessOwner.noteAiClientEnded();
    },
    terminalizeOwnedPlayerHostOwner: (owner: StardewOwnedPlayerHostBootstrap): void => {
      requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      terminalizeOwnedPlayerHostBootstrap(owner);
    },
    /**
     * Best-effort live write of the player's action policy into the config of the
     * attempt this owner owns, so a save reaches a RUNNING world through the Mod's
     * own 120-tick config reread instead of waiting for the next bootstrap.
     *
     * It returns `written: false` rather than throwing when there is no config to
     * write: before the AI-client profile is materialized there is nothing the Mod
     * could be reading, and after settlement the attempt directory is gone. Neither
     * is a failure the player caused, and the durable record is projected into the
     * next bootstrap's config either way.
     *
     * A write that fails for a real reason is thrown, never swallowed: a settings
     * save that silently did not reach the game is the one outcome worse than a
     * refusal.
     */
    projectPlayerActionPolicyIntoOwnedAttempt: async (
      owner: StardewOwnedPlayerHostBootstrap,
      policy: StardewModActionPolicyProjection,
    ): Promise<{ written: boolean }> => {
      const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      const configPath = join(
        resolve(facts.durableOwner.transactionDirectory),
        AI_CLIENT_PROFILE_ROOT,
        MODS_DIRECTORY,
        MOD_DIRECTORY,
        MOD_CONFIG_FILE,
      );
      const written = await writeStardewModActionPolicyIntoConfig(configPath, policy);
      return Object.freeze({ written });
    },
    quarantineOwnedPlayerHostOwner: (owner: StardewOwnedPlayerHostBootstrap): Promise<void> => {
      const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      return facts.quarantineOwner();
    },
    /**
     * Drops the attempt's private session material when this Host forgets the attempt.
     *
     * It is the ONE place the clearing happens. The quarantine no longer clears it, because the ONE probe that
     * can free a quarantined cabin attempt authenticates the Mod's own document with this token: without it the
     * probe cannot tell "no cabin holds her" from a forged claim, and a forged `not_bound` licenses exactly the
     * second signed manifest the quarantine exists to prevent. The token authenticates a READ only, it never
     * leaves this Host, and it is already written to the AI client's config by materialisation.
     */
    forgetOwnedPlayerHostMaterial: (owner: StardewOwnedPlayerHostBootstrap): void => {
      const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      facts.privateMaterial.value = null;
      facts.privateBridgeMaterial.value = null;
    },
    reconcileHeldBootstrapRegistration,
  });
}

type DurableOwner = Readonly<{
  readonly record: StardewPrivateBootstrapOwnerRecord;
  readonly transactionDirectory: string;
  replaceRecord(record: StardewPrivateBootstrapOwnerRecord): void;
  quarantine(): Promise<void>;
}>;

type PersistPrivateBootstrapOwnerInput<TPlayerHost extends StardewPrivateBootstrapOwnerRecord["playerHost"]> =
  Readonly<{
    runtimeRoot: string;
    bootstrapFacts: StardewPrivateBootstrapFacts;
    guardian: StardewGuardianBinding;
    playerHost: TPlayerHost;
    aiClientLaunchGeneration: string;
    readClock: () => number;
    reuseExistingOwner?: boolean;
  }>;

type DurableOwnerFor<TRecord extends StardewPrivateBootstrapOwnerRecord> = Omit<DurableOwner, "record"> &
  Readonly<{ record: TRecord }>;

/**
 * The ONE terminal-state predicate for the private owner record.
 *
 * Every consumer of "is this attempt closed out?" reads this predicate, so a new
 * terminal can never be added to the state matrix while one of them keeps
 * reading the old pair: a consumer that missed one terminal would treat a closed
 * attempt as a recoverable one (or the reverse) with no test going red.
 *
 * The three states are terminal for the same reason: nothing more may be driven
 * on the attempt. `contained` drained both roles,
 * `ai_settled_player_preserved` records the AI-side recovery terminal (the
 * player's world was deliberately preserved and no role containment was
 * observed), and `quarantined` is the residue of a cleanup that could not
 * finish. None of them is openable, recoverable, or a legal predecessor of the
 * ordinary close.
 */
function isTerminalOwnerState(state: string): boolean {
  return state === "contained" || state === "quarantined" || state === "ai_settled_player_preserved";
}

async function reconcileSettledRegistrationMarker(
  runtimeRoot: string,
  terminal: StardewPrivateBootstrapOwnerRecord,
  immutableFence: StardewOwnerImmutableFence,
  registration: Parameters<Parameters<typeof withStardewLifecycleInstallationRegistrationOwner>[1]>[0],
  marker: StardewInstallationRegistrationOwnerTransactionMarker,
): Promise<void> {
  if (
    marker.operation !== "settlement_release" ||
    marker.bootstrapCorrelation !== terminal.bootstrapId ||
    marker.ownerRecordRevision !== terminal.ownerRecordRevision
  )
    throw new Error("stardew_bootstrap_registration_unavailable");
  const ownerPath = join(runtimeRoot, "stardew-private-bootstrap", terminal.bootstrapId, OWNER_FILE);
  const persisted = await withPathLock(ownerPath, () => readAndValidateOwner(ownerPath, runtimeRoot), {
    containmentRoot: runtimeRoot,
  });
  if (
    !sameImmutableFence(persisted, immutableFence) ||
    persisted.ownerRecordRevision !== marker.ownerRecordRevision ||
    persisted.bootstrapId !== marker.bootstrapCorrelation ||
    !isTerminalOwnerState(persisted.state)
  ) {
    throw new Error("stardew_bootstrap_registration_unavailable");
  }
  const current = await registration.readRegistration();
  if (current === null || current.state !== "ready") throw new Error("stardew_bootstrap_registration_unavailable");
  if (current.revision === marker.registrationRevision && current.activeAttempt === null) {
    await registration.clearMarker(marker);
    return;
  }
  if (
    current.revision !== marker.registrationRevision - 1 ||
    current.activeAttempt?.bootstrapCorrelation !== marker.bootstrapCorrelation
  ) {
    throw new Error("stardew_bootstrap_registration_unavailable");
  }
  await registration.releaseSettledPointer(current.revision, marker);
  await registration.clearMarker(marker);
}

async function prepareAndBindOwnedRegistrationAttempt(
  runtimeRoot: string,
  bootstrapFacts: StardewPrivateBootstrapFacts,
  persist: () => Promise<DurableOwnerFor<StardewOwnedPlayerHostBootstrapOwnerRecord>>,
): Promise<DurableOwnerFor<StardewOwnedPlayerHostBootstrapOwnerRecord>> {
  const root = resolve(runtimeRoot);
  try {
    const outcome = await withStardewLifecycleInstallationRegistrationOwner(root, async (registration) => {
      // A normal launch is not a recovery authority. Retain any interrupted
      // prepare transaction exactly as found for its owner-specific settlement
      // or recovery path, and never adopt its owner or active-attempt pointer.
      if ((await registration.readMarker()) !== null) {
        throw new Error("stardew_bootstrap_registration_unavailable");
      }

      const current = await registration.readRegistration();
      if (current === null || current.state !== "ready") {
        throw new Error("stardew_bootstrap_registration_unavailable");
      }
      // The registration itself is fine and an attempt is holding it. It leaves this
      // callback as a verdict rather than an exception: the registration lock maps every
      // error it does not own to its own unavailable code, and a held pointer is the
      // composer's fact about its own records, not the registration module's.
      if (current.activeAttempt !== null) return Object.freeze({ kind: "held" as const });
      const marker: StardewInstallationRegistrationOwnerTransactionMarker = Object.freeze({
        schema: "gamebuddy-stardew-installation-owner-transaction/v1",
        operation: "prepare_bind",
        bootstrapCorrelation: bootstrapFacts.bootstrapId,
        registrationRevision: current.revision + 1,
        ownerRecordRevision: 1,
      });
      await registration.writeMarker(marker);
      const durableOwner = await persist();
      if (
        durableOwner.record.bootstrapId !== marker.bootstrapCorrelation ||
        durableOwner.record.ownerRecordRevision !== marker.ownerRecordRevision ||
        durableOwner.record.state !== "reserved"
      ) {
        throw new Error("stardew_bootstrap_registration_unavailable");
      }
      const paired = await registration.bindPreparedPointer(current.revision, marker);
      if (
        paired.activeAttempt?.bootstrapCorrelation !== marker.bootstrapCorrelation ||
        paired.revision !== marker.registrationRevision
      ) {
        throw new Error("stardew_bootstrap_registration_unavailable");
      }
      await registration.clearMarker(marker);
      return Object.freeze({ kind: "bound" as const, durableOwner });
    });
    if (outcome.kind === "held") throw new Error("stardew_bootstrap_registration_held");
    return outcome.durableOwner;
  } catch (error) {
    if (error instanceof Error && error.message === "stardew_installation_registration_unavailable") {
      throw new Error("stardew_bootstrap_registration_unavailable");
    }
    throw error;
  }
}

/** The live registration owner seam, live only inside its callback. */
type RegistrationOwnerSeam = Parameters<Parameters<typeof withStardewLifecycleInstallationRegistrationOwner>[1]>[0];

/**
 * The ONE release of a held registration pointer.
 *
 * Two callers reach it and neither owns a second implementation: the Guardian's
 * explicit settlement (with its proof reservation already held) and the Host-boot
 * reconcile (after the OS proved the attempt's objects gone). It re-reads the
 * terminal owner record under the path lock, re-checks the caller's immutable
 * fence and exact revision, writes the settlement marker, releases the pointer
 * through the registration's own CAS, verifies the released revision, and clears
 * the marker. A record that changed under the caller, or a pointer that no longer
 * names this attempt, refuses before anything is written.
 */
async function releaseSettledPlayerHostRegistrationAttempt(
  runtimeRoot: string,
  bootstrapCorrelation: string,
  immutableFence: StardewOwnerImmutableFence,
  expectedTerminalOwnerRecordRevision: number,
  registration: RegistrationOwnerSeam,
): Promise<void> {
  const ownerPath = join(runtimeRoot, "stardew-private-bootstrap", bootstrapCorrelation, OWNER_FILE);
  const terminal = await withPathLock(ownerPath, () => readAndValidateOwner(ownerPath, runtimeRoot), {
    containmentRoot: runtimeRoot,
  });
  if (
    !sameImmutableFence(terminal, immutableFence) ||
    terminal.ownerRecordRevision !== expectedTerminalOwnerRecordRevision ||
    terminal.bootstrapId !== bootstrapCorrelation ||
    !isTerminalOwnerState(terminal.state)
  ) {
    throw new Error("stardew_bootstrap_registration_unavailable");
  }
  const current = await registration.readRegistration();
  if (
    current === null ||
    current.state !== "ready" ||
    current.activeAttempt?.bootstrapCorrelation !== bootstrapCorrelation
  ) {
    throw new Error("stardew_bootstrap_registration_unavailable");
  }
  const existingMarker = await registration.readMarker();
  if (existingMarker !== null) {
    await reconcileSettledRegistrationMarker(runtimeRoot, terminal, immutableFence, registration, existingMarker);
    return;
  }
  const marker: StardewInstallationRegistrationOwnerTransactionMarker = Object.freeze({
    schema: "gamebuddy-stardew-installation-owner-transaction/v1",
    operation: "settlement_release",
    bootstrapCorrelation,
    registrationRevision: current.revision + 1,
    ownerRecordRevision: terminal.ownerRecordRevision,
  });
  await registration.writeMarker(marker);
  const released = await registration.releaseSettledPointer(current.revision, marker);
  if (released.activeAttempt !== null || released.revision !== marker.registrationRevision) {
    throw new Error("stardew_bootstrap_registration_unavailable");
  }
  await registration.clearMarker(marker);
}

/**
 * The evidence a `not_bound` answer has to be for the quarantine release to read it: the answer, the
 * world it is about, both clocks, and the attempt record it was taken under.
 *
 * The record half is what makes assertion (a) an assertion rather than a restatement: the release
 * re-reads the record under its own lock and refuses when it is not the one this evidence was taken
 * under, so a decision and the write it licenses cannot be separated by a change nobody saw.
 */
export type StardewCabinOccupancyEvidence = Readonly<{
  reading: StardewCabinOccupancyReading;
  record: Readonly<{
    bootstrapId: string;
    ownerRecordRevision: number;
    state: StardewPrivateBootstrapOwnerRecord["state"];
    cleanupDisposition: StardewPrivateBootstrapOwnerRecord["cleanupDisposition"];
  }>;
}>;

/**
 * Why a cabin-press quarantine release refused, one name per assertion.
 *
 * The names are the product's, not the assertion's position: a player asked "why did the press not
 * free the attempt" has to be answered by the fact that refused, and a release that cannot name the
 * fact it rested on is not allowed to write anything.
 */
export type StardewCabinQuarantineReleaseRefusal =
  /** (a) The record in the transaction is not the quarantined attempt this evidence was taken under. */
  | "record_is_not_the_quarantined_attempt"
  /** (b) The installation registration holds another attempt, so the pointer is not this one to release. */
  | "registration_names_another_attempt"
  /** (c) The attempt's Guardian-owned objects were not proven gone. */
  | "guardian_objects_not_proven_dead"
  /** (d) The answer is not a fresh `not_bound` about this attempt's own world. */
  | "evidence_not_fresh_for_this_world";

const CABIN_QUARANTINE_RELEASE_REFUSALS: Readonly<Record<StardewCabinQuarantineReleaseRefusal, string>> = Object.freeze(
  {
    record_is_not_the_quarantined_attempt: "stardew_cabin_quarantine_record_is_not_the_quarantined_attempt",
    registration_names_another_attempt: "stardew_cabin_quarantine_registration_names_another_attempt",
    guardian_objects_not_proven_dead: "stardew_cabin_quarantine_guardian_objects_not_proven_dead",
    evidence_not_fresh_for_this_world: "stardew_cabin_quarantine_evidence_not_fresh_for_this_world",
  },
);

/** The error the release throws for one refusal, so a caller classifies it by the same name it reports. */
export function stardewCabinQuarantineReleaseRefusalName(refusal: StardewCabinQuarantineReleaseRefusal): string {
  return CABIN_QUARANTINE_RELEASE_REFUSALS[refusal];
}

/** The refusal a thrown release error names, or null for any other failure. */
export function stardewCabinQuarantineRefusalOf(error: unknown): StardewCabinQuarantineReleaseRefusal | null {
  if (!(error instanceof Error)) return null;
  for (const [refusal, name] of Object.entries(CABIN_QUARANTINE_RELEASE_REFUSALS))
    if (error.message === name) return refusal as StardewCabinQuarantineReleaseRefusal;
  return null;
}

/**
 * Assertion (d), in one place: a fresh `not_bound` about THIS attempt's world.
 *
 * Every clause is a different way the answer could stop being evidence: another answer (only absence
 * licenses a release), another world or farmhand (the answer would be about a save this attempt never
 * published into), no authenticated document (`publishedAtUnixMs` null is a document nobody could
 * attribute), or a reading older than the freshness bound the probe itself applies.
 */
function assertCabinOccupancyEvidenceForThisWorld(
  evidence: StardewCabinOccupancyEvidence,
  expected: StardewCabinOccupancyExpectation,
  nowMs: number,
): void {
  const refuse: () => never = () => {
    throw new Error(CABIN_QUARANTINE_RELEASE_REFUSALS.evidence_not_fresh_for_this_world);
  };
  const { reading } = evidence;
  if (reading.occupancy.status !== "not_bound") refuse();
  if (
    reading.expectation.saveId !== expected.saveId ||
    reading.expectation.worldId !== expected.worldId ||
    reading.expectation.farmhandId !== expected.farmhandId
  )
    refuse();
  if (reading.publishedAtUnixMs === null) refuse();
  if (nowMs - reading.publishedAtUnixMs > STARDEW_CABIN_OCCUPANCY_PUBLISHED_WITHIN_MS) refuse();
  if (reading.observedAtUnixMs > nowMs) refuse();
  if (nowMs - reading.observedAtUnixMs > STARDEW_CABIN_OCCUPANCY_PUBLISHED_WITHIN_MS) refuse();
}

/**
 * The ONE release of the cabin press's quarantined attempt, behind four assertions.
 *
 * The quarantine exists because the press's signed manifest WAS admitted and the attach that follows
 * it refused (`stardew_cabin_publication_uncertain`): a second press would write a second manifest
 * into the same world. So the only thing that may release it is a proof that the first publication did
 * NOT take effect - and a proof is four facts, not one:
 *
 * 1. (a) the record under the transaction is the quarantined attempt the evidence was taken under,
 *    by bootstrap id and exact revision, in the state only this press writes;
 * 2. (b) the installation registration still names that attempt, so the pointer released is the held
 *    one and not a successor's;
 * 3. (c) the attempt's Guardian-owned objects are proven gone, because a second Player Host launched
 *    over a world the first one still owns is the same double binding by another route;
 * 4. (d) the answer is a fresh `not_bound` about this attempt's own world.
 *
 * Any one of them failing refuses by its own name and writes nothing. The write itself is the same
 * `releaseSettledPlayerHostRegistrationAttempt` every other terminal uses - one release, one CAS,
 * one verified revision - never a second implementation of it.
 */
async function releaseCabinPublicationQuarantine(
  runtimeRoot: string,
  bootstrapCorrelation: string,
  evidence: StardewCabinOccupancyEvidence,
  expectedWorld: StardewCabinOccupancyExpectation,
  probe: StardewGuardianNamedObjectProbe,
  readClock: () => number,
): Promise<void> {
  const ownerPath = join(runtimeRoot, "stardew-private-bootstrap", bootstrapCorrelation, OWNER_FILE);
  const terminal = await withPathLock(ownerPath, () => readAndValidateOwner(ownerPath, runtimeRoot), {
    containmentRoot: runtimeRoot,
  });
  if (
    terminal.bootstrapId !== evidence.record.bootstrapId ||
    terminal.bootstrapId !== bootstrapCorrelation ||
    terminal.ownerRecordRevision !== evidence.record.ownerRecordRevision ||
    terminal.state !== "quarantined" ||
    terminal.cleanupDisposition !== "retry_required"
  )
    throw new Error(CABIN_QUARANTINE_RELEASE_REFUSALS.record_is_not_the_quarantined_attempt);
  const registration = await readStardewInstallationRegistration(runtimeRoot);
  if (
    registration === null ||
    registration.state !== "ready" ||
    registration.activeAttempt?.bootstrapCorrelation !== bootstrapCorrelation
  )
    throw new Error(CABIN_QUARANTINE_RELEASE_REFUSALS.registration_names_another_attempt);
  const verdict = await probeStardewGuardianObjects(probe, {
    playerJobName: terminal.guardian.playerJobName,
    leaseName: terminal.guardian.leaseName,
  });
  if (verdict.presence !== "absent")
    throw new Error(CABIN_QUARANTINE_RELEASE_REFUSALS.guardian_objects_not_proven_dead);
  assertCabinOccupancyEvidenceForThisWorld(evidence, expectedWorld, readClock());
  // The four assertions are made OUTSIDE the registration owner lock, because that lock maps every error it does
  // not own to its own `stardew_installation_registration_unavailable` - a refusal that names nothing about a
  // cabin attempt. The write below is still the ONE release, and it re-reads the record, the fence, the exact
  // revision and the pointer's own attempt inside the lock: a pointer that moved between these checks and the
  // lock refuses as that layer's own unavailable, which is fail-closed and never a wrong release.
  await withStardewLifecycleInstallationRegistrationOwner(runtimeRoot, async (ownerRegistration) => {
    await releaseSettledPlayerHostRegistrationAttempt(
      runtimeRoot,
      bootstrapCorrelation,
      immutableFenceFor(terminal),
      terminal.ownerRecordRevision,
      ownerRegistration,
    );
  });
}

/**
 * Private owner/Guardian completion seam. It is intentionally not part of the
 * production composition or public registration API; the Guardian's exact
 * containment proof remains the only authority that can release the pointer.
 */
export async function settleOwnedPlayerHostRegistrationAttempt(
  owner: StardewOwnedPlayerHostBootstrap,
  proof: StardewBootstrapGuardianSettlementProof,
): Promise<void> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner);
  const proofReservation = reserveStardewBootstrapGuardianSettlementProof(owner, proof);
  try {
    const runtimeRoot = dirname(dirname(facts.durableOwner.transactionDirectory));
    await withStardewLifecycleInstallationRegistrationOwner(runtimeRoot, async (registration) => {
      await releaseSettledPlayerHostRegistrationAttempt(
        runtimeRoot,
        facts.durableOwner.record.bootstrapId,
        facts.immutableFence,
        proofReservation.expectedTerminalOwnerRecordRevision,
        registration,
      );
    });
    proofReservation.commit();
  } catch (error) {
    proofReservation.restore();
    if (error instanceof Error && error.message === "stardew_installation_registration_unavailable") {
      throw new Error("stardew_bootstrap_registration_unavailable");
    }
    throw error;
  }
}

/**
 * One named outcome per attempt record the reconcile examined. Every one of them
 * is a fact an operator can act on, and only `released` and `finalised` changed
 * durable state.
 */
export type StardewBootstrapRegistrationReconcileOutcome =
  /** The record was already terminal and the OS proved both objects gone: the pointer was released. */
  | "released"
  /** The record was not terminal, the OS proved both objects gone, and it was finalised; `finalisation` names the terminal written. */
  | "finalised"
  /** Both objects opened: the attempt still owns them, whichever state its record is in. */
  | "kept_objects_present"
  /** One object missing, or any answered object the probe could not classify. */
  | "kept_presence_unverifiable"
  /**
   * The probe could not run at all, so neither object was ever asked about.
   *
   * It is kept apart from `kept_objects_present` and `kept_presence_unverifiable`
   * because the player has to do something different about it: a present object is
   * the previous attempt's Guardian still holding the lease and the player Job,
   * while this one is a Host that could not find out - a blocked in-box compiler, a
   * PowerShell the policy does not allow - and the next launch is refused either
   * way. Only the name of the condition distinguishes them.
   */
  | "kept_probe_unavailable"
  /** The registration does not name this attempt, or could not be read at all. */
  | "kept_not_bound"
  /** The owner record could not be read or validated. */
  | "kept_unreadable"
  /** Absence was proven, the record is not terminal, and the durable engine refused to take it to one. */
  | "kept_finalise_refused"
  /** Absence was proven and the record is terminal, but the release itself refused (record or pointer changed under it). */
  | "kept_release_refused";

/**
 * The durable terminal a pass actually wrote for an attempt, so that a reader
 * never has to infer which one freed the player.
 *
 * Four shapes, and the suffix always means the SAME thing: something after the
 * named terminal refused, and the name carries that refusal rather than hiding it.
 *
 * - `ai_settled_player_preserved` - the finalisation reached the AI-side terminal
 *   and the pointer was released.
 * - `ai_settled_player_preserved:<reason>` - the terminal and the release both
 *   landed, and a step after them (the attempt's own residue cleanup) refused, so
 *   the transaction stays on disk.
 * - `quarantined:<reason>` - the finalisation could not reach its terminal and its
 *   OWN failure closure quarantined the attempt; the pointer was then released, so
 *   the player is free and the reason that pushed it there survives.
 * - `refused:<reason>` - the durable engine refused before writing any terminal, so
 *   the attempt is exactly as it was found and the next boot will read it again.
 */
export type StardewBootstrapRegistrationReconcileFinalisation =
  | "ai_settled_player_preserved"
  | `ai_settled_player_preserved:${string}`
  | `quarantined:${string}`
  | `refused:${string}`;

export type StardewBootstrapRegistrationReconcileRecord = Readonly<{
  bootstrapCorrelation: string;
  outcome: StardewBootstrapRegistrationReconcileOutcome;
  /** The terminal this pass wrote for the attempt, or null when it wrote none. */
  finalisation: StardewBootstrapRegistrationReconcileFinalisation | null;
}>;

/** One record's outcome, frozen, so every exit of the per-record decision spells it the same way. */
function reconcileRecord(
  bootstrapCorrelation: string,
  outcome: StardewBootstrapRegistrationReconcileOutcome,
  finalisation: StardewBootstrapRegistrationReconcileFinalisation | null = null,
): StardewBootstrapRegistrationReconcileRecord {
  return Object.freeze({ bootstrapCorrelation, outcome, finalisation });
}

export type StardewBootstrapRegistrationReconcileReport = Readonly<{
  /** How many attempt records were read. Zero is a counted zero, not an absent report. */
  examined: number;
  released: number;
  /** How many records were not terminal and were finalised (and released) by this pass. */
  finalised: number;
  records: readonly StardewBootstrapRegistrationReconcileRecord[];
}>;

/**
 * Host-boot reconcile over `stardew-private-bootstrap` records.
 *
 * This is the entry point that matters for a crashed attempt. The finalisation
 * that frees a player whose Guardian died was reachable only through
 * `game.create`, which opens the leftover attempt and drives its recovery; a
 * player who never pressed Create again stayed blocked on every boot, because the
 * only pass that ran could report the record it would not touch. The
 * `game.create` trigger stays - it is a valid second entry, and a create that
 * finds a leftover still has to answer for it - but boot is the path every player
 * actually takes.
 *
 * Its authority is bounded by ONE measurement: the presence verdict for the two
 * OS objects the attempt's Guardian binding names. Only `proven_dead` (both
 * `not_found`) may move a record; `present`, `unverifiable` and `unmeasured` leave
 * everything exactly as it was, and each reports its own outcome so a reader can
 * tell a held object from a probe that never ran.
 *
 * A terminal record is released, not finalised: this pass releases its
 * BOOKKEEPING and never stands in for `containedRuntimeTeardown.settle`, which
 * remains the only path allowed to say a live runtime was contained.
 *
 * A NON-terminal record is finalised through the existing recovery finalisation,
 * which is what closes the boot deadlock; `finaliseAbsentAttempt` owns the one
 * decision that needs arguing (which terminal the evidence supports) and the
 * record it reports.
 *
 * Idempotent: a released pointer is no longer the active attempt, so a second pass
 * reports `kept_not_bound` for the same record and releases nothing again, and a
 * finalised attempt has consumed its transaction record entirely.
 */
export async function reconcileHeldBootstrapRegistration(
  runtimeRoot: string,
  probe: StardewGuardianNamedObjectProbe,
): Promise<StardewBootstrapRegistrationReconcileReport> {
  const root = resolve(runtimeRoot);
  const correlations = await attemptRecordCorrelations(root);
  const bound = await boundBootstrapCorrelation(root);
  const records: StardewBootstrapRegistrationReconcileRecord[] = [];
  let released = 0;
  let finalised = 0;
  for (const bootstrapCorrelation of correlations) {
    const record =
      bound !== bootstrapCorrelation
        ? reconcileRecord(bootstrapCorrelation, "kept_not_bound")
        : await reconcileHeldBootstrapAttempt(root, bootstrapCorrelation, probe);
    if (record.outcome === "released") released += 1;
    if (record.outcome === "finalised") finalised += 1;
    records.push(record);
  }
  return Object.freeze({ examined: correlations.length, released, finalised, records: Object.freeze(records) });
}

/** The attempt correlation the registration currently binds, or null when it binds none. */
async function boundBootstrapCorrelation(root: string): Promise<string | null> {
  try {
    const registration = await readStardewInstallationRegistration(root);
    return registration !== null && registration.state === "ready"
      ? (registration.activeAttempt?.bootstrapCorrelation ?? null)
      : null;
  } catch {
    // Another writer holds an owner transaction (or the record is unreadable).
    // That is not a reading of "no attempt is bound", so nothing may be released.
    return null;
  }
}

/** Attempt records are the directories under the transaction root that carry an owner record. */
async function attemptRecordCorrelations(root: string): Promise<readonly string[]> {
  const transactionsRoot = join(root, "stardew-private-bootstrap");
  const entries = await readDirectoryIfPresent(transactionsRoot, root);
  const correlations: string[] = [];
  for (const entry of entries) {
    if (!isOpaque(entry)) continue;
    let leaves: readonly string[];
    try {
      leaves = await readDirectoryIfPresent(join(transactionsRoot, entry), root);
    } catch {
      continue;
    }
    if (leaves.includes(OWNER_FILE)) correlations.push(entry);
  }
  return Object.freeze(correlations.sort());
}

async function reconcileHeldBootstrapAttempt(
  root: string,
  bootstrapCorrelation: string,
  probe: StardewGuardianNamedObjectProbe,
): Promise<StardewBootstrapRegistrationReconcileRecord> {
  const ownerPath = join(root, "stardew-private-bootstrap", bootstrapCorrelation, OWNER_FILE);
  let record: StardewPrivateBootstrapOwnerRecord;
  try {
    record = await withPathLock(ownerPath, () => readAndValidateOwner(ownerPath, root), { containmentRoot: root });
  } catch {
    return reconcileRecord(bootstrapCorrelation, "kept_unreadable");
  }
  if (record.bootstrapId !== bootstrapCorrelation) return reconcileRecord(bootstrapCorrelation, "kept_unreadable");
  const verdict = await probeStardewGuardianObjects(probe, {
    playerJobName: record.guardian.playerJobName,
    leaseName: record.guardian.leaseName,
  });
  if (verdict.presence === "present") return reconcileRecord(bootstrapCorrelation, "kept_objects_present");
  if (verdict.presence === "unmeasured") return reconcileRecord(bootstrapCorrelation, "kept_probe_unavailable");
  if (verdict.presence === "unverifiable") return reconcileRecord(bootstrapCorrelation, "kept_presence_unverifiable");
  if (!isTerminalOwnerState(record.state)) return await finaliseAbsentAttempt(root, bootstrapCorrelation, record);
  try {
    await withStardewLifecycleInstallationRegistrationOwner(root, async (registration) => {
      await releaseSettledPlayerHostRegistrationAttempt(
        root,
        bootstrapCorrelation,
        immutableFenceFor(record),
        record.ownerRecordRevision,
        registration,
      );
    });
  } catch {
    return reconcileRecord(bootstrapCorrelation, "kept_release_refused");
  }
  return reconcileRecord(bootstrapCorrelation, "released");
}

/**
 * Closes out ONE attempt the OS proved gone, through the existing recovery
 * finalisation.
 *
 * The terminal it asks for is `ai_settled_player_preserved`, and the whole reason
 * is what the presence verdict can and cannot prove. Both named objects
 * `not_found` proves the Guardian's own ownership handles are closed: its lease
 * mutex is released and its player-Job handle no longer exists. That is an AI-side
 * fact - the attempt's Guardian, which is the only owner its AI client ever had, is
 * gone - and it is not a containment fact. The native Guardian creates the player
 * Job with kill-on-close OFF so the player's world survives its Guardian, which
 * means the game process is left running, orphaned outside any job, and the durable
 * player role is still `armed`/`active` and never `contained`. The native recovery
 * classifier refuses to classify the player role contained at all, for the stated
 * reason that player world ownership is not an AI containment artifact. Claiming
 * `contained` here would need a role CAS nobody observed, in the one record that
 * decides whether the player can start again; the sibling finalisation records
 * exactly what was observed instead.
 *
 * The handle and its one-shot Guardian binding are minted over the record this pass
 * already read and validated, never over a second read: the binding's CAS cursor is
 * that exact predecessor, and the finalisation reads the same handle's durable
 * record for the terminal it must match. A record already `recovering` adopts the
 * actor it recorded, so an interrupted recovery is closed out under its own actor;
 * only a record with none goes through `beginRecovery` to mint one.
 *
 * A finalisation that refuses is not reported as one that ran. The record is
 * re-read: still non-terminal means the durable engine refused before writing any
 * terminal (nothing was closed out, the next boot reads it again); terminal means
 * the finalisation's own failure closure quarantined it, and the pointer is then
 * released through the same `releaseSettledPlayerHostRegistrationAttempt` every
 * other terminal uses, so one boot frees the player and the reason survives in the
 * report.
 */
async function finaliseAbsentAttempt(
  root: string,
  bootstrapCorrelation: string,
  record: StardewPrivateBootstrapOwnerRecord,
): Promise<StardewBootstrapRegistrationReconcileRecord> {
  const ownerPath = join(root, "stardew-private-bootstrap", bootstrapCorrelation, OWNER_FILE);
  const owner = composeRecoverablePlayerHostOwner(durableOwnerStateOver(ownerPath, root, record));
  const { transitions } = consumeStardewBootstrapGuardianOwnerBinding(
    createStardewBootstrapGuardianOwnerBinding(owner),
  );
  const recoveryInstanceId = record.recoveryInstanceId ?? randomUUID();
  let refusal: unknown;
  try {
    if (record.state !== "recovering") await transitions.beginRecovery(recoveryInstanceId);
    await finalizeRecoveredPlayerHostAiSettledRuntimeAttempt(owner, recoveryInstanceId);
    return reconcileRecord(bootstrapCorrelation, "finalised", "ai_settled_player_preserved");
  } catch (error) {
    refusal = error;
  }
  const reason = bootstrapFinaliseRefusalReason(refusal);
  const stopped = await readOwnerRecordOrNull(ownerPath, root);
  if (stopped !== null && !isTerminalOwnerState(stopped.state))
    return reconcileRecord(bootstrapCorrelation, "kept_finalise_refused", `refused:${reason}`);
  if (stopped !== null && (await boundBootstrapCorrelation(root)) === bootstrapCorrelation) {
    try {
      await withStardewLifecycleInstallationRegistrationOwner(root, async (registration) => {
        await releaseSettledPlayerHostRegistrationAttempt(
          root,
          bootstrapCorrelation,
          immutableFenceFor(stopped),
          stopped.ownerRecordRevision,
          registration,
        );
      });
    } catch {
      return reconcileRecord(
        bootstrapCorrelation,
        "kept_release_refused",
        stopped.state === "quarantined" ? `quarantined:${reason}` : "ai_settled_player_preserved",
      );
    }
  }
  // A record that is gone was consumed by the finalisation, which only deletes it
  // after the terminal write and the pointer release have both succeeded.
  return reconcileRecord(
    bootstrapCorrelation,
    "finalised",
    stopped !== null && stopped.state === "quarantined"
      ? `quarantined:${reason}`
      : `ai_settled_player_preserved:${reason}`,
  );
}

/**
 * The bounded reason a finalisation refused with, quoted rather than summarised.
 *
 * The finalisation wraps its durable refusal in one code, so the cause is the only
 * place the transition the engine actually refused survives. The result is
 * restricted to the alphabet the operator's one-line record format can carry, so a
 * reason can never split or terminate the record it belongs to.
 */
function bootstrapFinaliseRefusalReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  const cause = error instanceof Error && error.cause instanceof Error ? `/${error.cause.message}` : "";
  return `${message}${cause}`.replace(/[^A-Za-z0-9_/-]/gu, "_");
}

/** The attempt's own record, or null when it is not on disk (consumed by a close-out). */
async function readOwnerRecordOrNull(
  ownerPath: string,
  root: string,
): Promise<StardewPrivateBootstrapOwnerRecord | null> {
  try {
    return await readAndValidateOwner(ownerPath, root);
  } catch {
    return null;
  }
}

function persistPrivateBootstrapOwner(
  input: PersistPrivateBootstrapOwnerInput<Readonly<{ kind: "external_unattested" }>>,
): Promise<DurableOwnerFor<StardewExternalPlayerHostPhaseAOwnerOwnerRecord>>;
function persistPrivateBootstrapOwner(
  input: PersistPrivateBootstrapOwnerInput<
    Readonly<{
      kind: "launch_reserved";
      launchGeneration: string;
    }>
  >,
): Promise<DurableOwnerFor<StardewOwnedPlayerHostBootstrapOwnerRecord>>;
async function persistPrivateBootstrapOwner(
  input: PersistPrivateBootstrapOwnerInput<StardewPrivateBootstrapOwnerRecord["playerHost"]>,
): Promise<DurableOwner> {
  validateBootstrapFacts(input.bootstrapFacts, input.readClock());
  if (input.playerHost.kind === "launch_reserved" && !isOpaque(input.playerHost.launchGeneration))
    throw new TypeError("invalid_stardew_player_host_launch_generation");
  if (!isOpaque(input.aiClientLaunchGeneration)) throw new TypeError("invalid_stardew_ai_client_launch_generation");

  const root = resolve(input.runtimeRoot);
  const transactionsRoot = join(root, "stardew-private-bootstrap");
  const directory = join(transactionsRoot, input.bootstrapFacts.bootstrapId);
  const ownerPath = join(directory, OWNER_FILE);

  await verifySafePathBoundary(join(root, ".stardew-private-bootstrap-admission"), root);
  await withPathLock(
    ownerPath,
    async () => {
      const blocking = (await readDirectoryIfPresent(directory, root)).filter((entry) => entry !== OWNER_LOCK_LEAF);
      if (blocking.length !== 0) {
        if (!input.reuseExistingOwner || blocking.length !== 1 || blocking[0] !== OWNER_FILE) {
          throw new Error("stardew_bootstrap_owner_occupied");
        }
        const existing = await readAndValidateOwner(ownerPath, root);
        if (
          existing.bootstrapId !== input.bootstrapFacts.bootstrapId ||
          existing.playerId !== input.bootstrapFacts.playerId ||
          existing.companionId !== input.bootstrapFacts.companionId ||
          existing.expiresAtMs !== input.bootstrapFacts.expiresAtMs ||
          JSON.stringify(existing.guardian) !== JSON.stringify(input.guardian) ||
          existing.ownerRecordRevision !== 1 ||
          existing.state !== "reserved" ||
          existing.guardianState !== "reserved" ||
          existing.playerHostState !== "reserved" ||
          existing.aiClientState !== "reserved" ||
          existing.recoveryInstanceId !== null ||
          existing.cleanupDisposition !== "pending" ||
          JSON.stringify(existing.managedPaths) !== JSON.stringify([OWNER_FILE]) ||
          existing.aiClient.launchGeneration !== input.aiClientLaunchGeneration ||
          (input.playerHost.kind === "launch_reserved" &&
            (existing.playerHost.kind !== "launch_reserved" ||
              existing.playerHost.launchGeneration !== input.playerHost.launchGeneration))
        ) {
          throw new Error("stardew_bootstrap_owner_occupied");
        }
      } else {
        if (input.bootstrapFacts.expiresAtMs <= input.readClock()) throw new Error("stardew_bootstrap_claim_expired");
        const baseRecord = {
          schema: OWNER_SCHEMA as typeof OWNER_SCHEMA,
          bootstrapId: input.bootstrapFacts.bootstrapId,
          playerId: input.bootstrapFacts.playerId,
          companionId: input.bootstrapFacts.companionId,
          guardian: input.guardian,
          aiClient: {
            kind: "launch_reserved" as const,
            launchGeneration: input.aiClientLaunchGeneration,
          },
          expiresAtMs: input.bootstrapFacts.expiresAtMs,
          ownerRecordRevision: 1,
          state: "reserved" as const,
          guardianState: "reserved" as const,
          playerHostState: "reserved" as const,
          aiClientState: "reserved" as const,
          recoveryInstanceId: null,
          cleanupDisposition: "pending" as const,
          managedPaths: [OWNER_FILE] as [typeof OWNER_FILE],
        };
        const record: StardewPrivateBootstrapOwnerRecord =
          input.playerHost.kind === "external_unattested"
            ? freezeRecord({ ...baseRecord, playerHost: input.playerHost })
            : freezeRecord({ ...baseRecord, playerHost: input.playerHost });
        if (blocking.length === 0) await atomicWriteFile(ownerPath, `${JSON.stringify(record)}\n`, root);
      }
    },
    { containmentRoot: root },
  );

  return openDurableOwnerState(ownerPath, root);
}

/**
 * The durable owner surface over an already-persisted `owner.json`: the record
 * this process currently believes, the transaction directory it lives in, the
 * in-memory successor hand-off every durable CAS uses, and the quarantine
 * closure. The reservation path and the recoverable opener share this one
 * definition, so both hand out the same surface instead of two lookalikes.
 */
async function openDurableOwnerState(ownerPath: string, root: string): Promise<DurableOwner> {
  return durableOwnerStateOver(ownerPath, root, await readAndValidateOwner(ownerPath, root));
}

function durableOwnerStateOver(
  ownerPath: string,
  root: string,
  initialRecord: StardewPrivateBootstrapOwnerRecord,
): DurableOwner {
  let record = initialRecord;
  let quarantinePromise: Promise<void> | null = null;
  let quarantineStarted = record.state === "quarantined";
  return Object.freeze({
    get record() {
      return record;
    },
    transactionDirectory: dirname(ownerPath),
    replaceRecord(next: StardewPrivateBootstrapOwnerRecord): void {
      record = freezeRecord(next);
    },
    quarantine(): Promise<void> {
      if (quarantinePromise !== null) return quarantinePromise;
      if (quarantineStarted && record.state === "quarantined") return Promise.resolve();
      quarantineStarted = true;
      const persistence = (async () => {
        const current = record;
        if (current.state === "quarantined") return;
        record = await createProductionStardewBootstrapOwnerTransitionPrimitives({
          ownerPath,
          containmentRoot: root,
          immutableFence: immutableFenceFor(current),
        }).quarantine(current.ownerRecordRevision);
      })();
      quarantinePromise = persistence.then(
        () => undefined,
        (error: unknown) => {
          // A rejected persistence attempt is retryable. Keep the durable
          // owner's quarantine-started state, but release only its in-flight
          // promise so the exact owner can make a later durable attempt.
          quarantinePromise = null;
          throw error;
        },
      );
      return quarantinePromise;
    },
  });
}

type OwnedPlayerHostBootstrapBindingState = "unbound" | "binding" | "bound" | "terminal";

type OwnedPlayerHostProfileStagingState = "not_staged" | "staged" | "launching";
type ManifestHandoffSelectionState =
  | "available"
  | "confirming"
  | "request_published"
  | "admitted"
  | "uncertain"
  | "terminal";

type ManifestHandoffSelectionFacts = {
  readonly compositionIdentity: object;
  readonly owner: StardewOwnedPlayerHostBootstrap;
  readonly flow: StardewAttachmentFlow;
  readonly choice: StardewVerifiedCabinChoice;
  readonly verifiedAdvertisementRuntimeRole: string;
  readonly verifiedAdvertisementGeneration: string;
  readonly expiresAtMs: number;
  state: ManifestHandoffSelectionState;
  requestId: string | null;
  manifest: Readonly<StardewJoinManifest> | null;
};

type ManifestHandoffAdmissionFacts = Readonly<{
  readonly compositionIdentity: object;
  readonly owner: StardewOwnedPlayerHostBootstrap;
  readonly flow: StardewAttachmentFlow;
  readonly choice: StardewVerifiedCabinChoice;
  readonly requestId: string;
  readonly manifest: Readonly<StardewJoinManifest>;
  readonly admittedAtMs: number;
  readonly expiresAtMs: number;
  readonly consumed: { value: boolean };
}>;

type ManifestHandoffCoordinatorCore = Readonly<{
  readonly coordinator: StardewManifestHandoffCoordinator;
  readonly materialize: MaterializeAiClientProfileAfterManifestAdmission;
}>;

/**
 * Private Stage-B session material retained only inside the exact composed
 * owner facts. Binds the exact values written to the Player Host
 * HostFarmhandProvisioning config (never re-read from config.json) to the
 * composition identity, owner lifetime, and quarantine lifecycle. No getter,
 * DTO field, manifest ingress, browser projection, or serialization surface
 * exists; a future closed materialized AI Client primitive owns the only read path through
 * the same WeakMap.
 */
type StardewPrivateBootstrapMaterial = Readonly<{
  readonly sessionDirectory: string;
  readonly sessionToken: string;
  readonly integrationVersion: string;
  readonly companionId: string;
}>;

export type StardewPrivateFarmhandBridgeConnection = Readonly<{
  scope: Scope;
  pipeName: string;
  token: string;
  launchGeneration: string;
}>;

/**
 * The exact owner's Farmhand bridge connection authority is not in the state the
 * caller requires. One refusal, two callers, and (before this identity existed)
 * two different meanings read off the same message text:
 *
 * - this composition refuses to consume a connection that is not `available`
 *   (the one-shot connection was already consumed, or is not armed yet), which
 *   the lifecycle reads as "this attach cannot be built here, defer it";
 * - this composition refuses to arm a fresh activation because the previous one
 *   never fully ended, which the lifecycle reads as "the owner's first one-shot
 *   activation is still intact", the state a create launches through.
 *
 * Both refusals are legitimately reported by the same composition probe, so the
 * lifecycle cannot distinguish them by call site; it distinguishes the two
 * readings by which probe it just ran. What it must NOT do is distinguish them by
 * comparing a message literal that only this module can see: renaming the text
 * would silently turn "still intact, launch through it" into a hard failure, or
 * turn a real refusal into something the lifecycle tolerates.
 *
 * The identity is declared here, beside the `bridgeConnectionState` fact and the
 * connection type it reports on, rather than in the containment contract both
 * sides used to import: that contract is the layer every game shares, and its own
 * README states it does not know game names. Both sides import this module, so the
 * two still cannot drift without the shared type changing.
 */
export class FarmhandBridgeConnectionNotAvailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FarmhandBridgeConnectionNotAvailableError";
  }
}

/**
 * The bridge fields this Host alone owns in the AI client's `config.json`, and the
 * only question its reread may ask: is this document the one THIS attempt authored
 * for THIS companion?
 *
 * It cannot be a byte question. The document is co-owned: the Mod rewrites it whole
 * through `Helper.WriteConfig` from its own config class (`PersistVerifiedFarmhandScope`
 * when the client reaches the world, and `ModConfig.cs` states the same rule), which
 * serializes every field the class has - the Mod's defaults, and none of the keys only
 * this Host knows. So the bytes of a live document stop matching the composed ones as
 * soon as the client boots, while the fields that name the attempt and the companion are
 * the ones a replaced or swapped profile actually moves.
 */
type StardewPrivateAiClientBridgeConfigIdentity = Readonly<{
  readonly pipeName: string;
  readonly bridgeToken: string;
  readonly saveId: string;
  readonly worldId: string;
  readonly playerId: string;
  readonly companionId: string;
  readonly manifestPath: string;
  readonly sessionToken: string;
  readonly integrationVersion: string;
}>;

type StardewPrivateBridgeMaterial = Readonly<{
  readonly configIdentity: StardewPrivateAiClientBridgeConfigIdentity;
  readonly connection: Omit<StardewPrivateFarmhandBridgeConnection, "launchGeneration">;
}>;

type OwnedPlayerHostBootstrapFacts = {
  readonly compositionIdentity: object;
  readonly immutableFence: StardewOwnerImmutableFence;
  readonly durableOwner: DurableOwner;
  readonly playerHostRegistration: StardewPlayerHostLaunchRegistration;
  /** Replaced by `prepareFreshFarmhandAiClientActivation` for each fresh activation. */
  aiClientRegistration: StardewAiClientLaunchRegistration;
  readonly expiresAtMs: number;
  readonly readClock: () => number;
  readonly launchStates: { playerHost: LaunchState; aiClient: LaunchState };
  readonly quarantine: { started: boolean; promise: Promise<void> | null };
  readonly bindingState: { value: OwnedPlayerHostBootstrapBindingState };
  readonly playerHostProfileStagingState: { value: OwnedPlayerHostProfileStagingState };
  readonly aiClientProfileState: { value: "not_materialized" | "materializing" | "materialized" | "failed" };
  readonly bridgeConnectionState: { value: "unavailable" | "available" | "binding" | "consumed" };
  readonly privateMaterial: { value: StardewPrivateBootstrapMaterial | null };
  readonly privateBridgeMaterial: { value: StardewPrivateBridgeMaterial | null };
  stagingDependencies?: PrivateModProfileStagingDependencies;
  consumePlayerHostLaunch: <T>(callback: (launch: StardewPlayerHostLaunch) => T) => T;
  /** Contained variant: claiming the launch commits the one-shot reservation without creating a raw child. */
  consumePlayerHostLaunchContained: <T>(callback: (claim: (typedFacts: TypedPrivateGameFacts) => void) => T) => T;
  consumeAiClientLaunch: <T>(callback: (launch: StardewAiClientLaunch) => T) => T;
  /** Contained variant: commits the one-shot AI-client reservation and marks the process owner awaiting attestation without a raw child. */
  consumeAiClientLaunchContained: <T>(callback: (claim: (typedFacts: TypedPrivateGameFacts) => void) => T) => T;
  quarantineOwner: () => Promise<void>;
};

const ownedPlayerHostBootstrapFacts = new WeakMap<object, OwnedPlayerHostBootstrapFacts>();

function requireOwnedPlayerHostBootstrapFacts(
  owner: StardewOwnedPlayerHostBootstrap,
  compositionIdentity?: object,
): OwnedPlayerHostBootstrapFacts {
  if (typeof owner !== "object" || owner === null)
    throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  const facts = ownedPlayerHostBootstrapFacts.get(owner);
  if (facts === undefined || (compositionIdentity !== undefined && facts.compositionIdentity !== compositionIdentity)) {
    throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  }
  return facts;
}

/**
 * Private composition seam for later Stage-0 launch preparation. Successful
 * binding is globally once per exact composer-minted owner, across every
 * session launcher instance. Failed asynchronous preparation restores `unbound` only
 * after its callback settles, so a complete later retry remains possible.
 */
export function consumeOwnedPlayerHostBootstrap<T>(
  owner: StardewOwnedPlayerHostBootstrap,
  callback: () => Promise<T> | T,
): Promise<T> | T {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner);
  if (typeof callback !== "function" || facts.bindingState.value !== "unbound") {
    throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  }
  facts.bindingState.value = "binding";
  try {
    const result = callback();
    if (result !== null && typeof (result as Promise<T>).then === "function") {
      return Promise.resolve(result).then(
        (value) => {
          facts.bindingState.value = "bound";
          return value;
        },
        (error: unknown) => {
          restoreOwnedPlayerHostBootstrapAfterFailure(owner);
          throw error;
        },
      );
    }
    facts.bindingState.value = "bound";
    return result;
  } catch (error) {
    restoreOwnedPlayerHostBootstrapAfterFailure(owner);
    throw error;
  }
}

/**
 * Marks an exact consumed owner permanently unavailable after Stage B has
 * succeeded and subsequent final admission failed after quarantine started.
 */
export function terminalizeOwnedPlayerHostBootstrap(owner: StardewOwnedPlayerHostBootstrap): void {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner);
  if (facts.bindingState.value !== "binding")
    throw new Error("stardew_owned_player_host_bootstrap_owner_not_registered");
  facts.bindingState.value = "terminal";
}

function restoreOwnedPlayerHostBootstrapAfterFailure(owner: StardewOwnedPlayerHostBootstrap): void {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner);
  if (facts.bindingState.value !== "terminal") facts.bindingState.value = "unbound";
}

/**
 * The Player Host profile staging profile operation is intentionally concrete and closed: its
 * package root, layout, config, secret, and result remain composition-owned.
 * It consumes no launch reservation and returns no path or launch authority.
 */
export async function stageOwnedPlayerHostProfile(owner: StardewOwnedPlayerHostBootstrap): Promise<void> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner);
  const dependencies = requireStagingDependencies(facts.stagingDependencies);
  await stageOwnedPlayerHostProfileWithValidatedDependencies(owner, dependencies);
}

function requireStagingDependencies(
  dependencies: PrivateModProfileStagingDependencies | undefined,
): PrivateModProfileStagingDependencies {
  if (dependencies === undefined) {
    throw new Error("stardew_private_mod_profile_staging_dependencies_missing");
  }
  return dependencies;
}

async function stageOwnedPlayerHostProfileWithValidatedDependencies(
  owner: StardewOwnedPlayerHostBootstrap,
  dependencies: PrivateModProfileStagingDependencies,
): Promise<void> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner);
  if (facts.bindingState.value !== "binding") throw new Error("stardew_owned_player_host_bootstrap_owner_not_staging");
  try {
    if (facts.expiresAtMs <= dependencies.nowMs()) throw new Error("stardew_private_mod_profile_staging_expired");
    const packageSource = await dependencies.readPackage();
    validatePackageSource(packageSource);
    if (facts.expiresAtMs <= dependencies.nowMs()) throw new Error("stardew_private_mod_profile_staging_expired");
    const companionDisplayName = await dependencies.readCompanionDisplayName?.();
    const privateMaterial = await stagePlayerHostModProfile(owner, packageSource, dependencies, companionDisplayName);
    facts.privateMaterial.value = privateMaterial;
  } catch (error) {
    try {
      await facts.quarantineOwner();
    } catch {
      /* staging failure remains primary */
    }
    throw error;
  }
  facts.playerHostProfileStagingState.value = "staged";
}

/**
 * Core-private staged-consume primitive. Requires the exact closure-owned
 * composition identity that minted the owner and permanently drains the
 * staged marker a single time: forged/cross-composition, unbound,
 * non-staged, expired, quarantine-started, and previously consumed owners
 * are rejected, and no callback, spawn, reservation, path, profile, secret,
 * or generation surface is exposed. Never exported from this module; only
 * the closed composition and the dedicated test composition reach it with
 * their stored identity.
 */
function consumeStagedOwnedPlayerHostProfile(
  owner: StardewOwnedPlayerHostBootstrap,
  compositionIdentity: object,
): void {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  if (facts.bindingState.value !== "bound") throw new Error("stardew_owned_player_host_bootstrap_owner_not_bound");
  if (facts.playerHostProfileStagingState.value !== "staged")
    throw new Error("stardew_owned_player_host_bootstrap_player_host_profile_staging_not_staged");
  if (facts.quarantine.started) throw new Error("stardew_owned_player_host_bootstrap_owner_quarantined");
  if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");
  facts.playerHostProfileStagingState.value = "not_staged";
}

/**
 * Core-private composition-bound attachment factory. It admits only the exact
 * owner minted by this closed composition while its bound Stage-B material is
 * still staged, non-quarantined, and within its absolute deadline. The factory
 * is read-only: it does not consume a marker or reservation and does not write
 * any file. Admission failures are intentionally redacted to the generic
 * private-launch error used by this boundary.
 */
function createManifestHandoffCoordinatorCore(
  compositionIdentity: object,
  readClock: () => number,
  resolveStagingDependencies: () => PrivateModProfileStagingDependencies,
  createBridgePipeName: () => string,
  createBridgeToken: () => string,
): ManifestHandoffCoordinatorCore {
  const selections = new WeakMap<StardewManifestHandoffSelection, ManifestHandoffSelectionFacts>();
  const admissions = new WeakMap<StardewManifestAdmission, ManifestHandoffAdmissionFacts>();
  /**
   * The facts of an admission THIS composition minted for THIS owner, or a refusal.
   *
   * `consumed` is deliberately not asked. Materialising the AI-client profile consumes the admission,
   * and the failure that quarantines the attempt happens after that - so the consumed admission is
   * exactly the one whose publication fate the occupancy evidence is about. Every other member of this
   * object still refuses a consumed admission for its own write; this one only reads.
   */
  function requireAdmissionOfThisAttempt(
    owner: StardewOwnedPlayerHostBootstrap,
    admission: StardewManifestAdmission,
  ): ManifestHandoffAdmissionFacts {
    requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
    const admissionFacts = admissions.get(admission);
    if (
      admissionFacts === undefined ||
      admissionFacts.compositionIdentity !== compositionIdentity ||
      admissionFacts.owner !== owner
    )
      throw new Error("invalid_stardew_manifest_admission");
    return admissionFacts;
  }
  const coordinator = {
    async list(owner: StardewOwnedPlayerHostBootstrap): Promise<readonly StardewManifestHandoffChoice[]> {
      const ownerFacts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
      const flow = createOwnedPlayerHostAttachmentFlowCore(owner, compositionIdentity, readClock);
      const session = await flow.readLiveSession();
      // The label is the cabin's position in the Mod's own list, taken BEFORE the filter. Numbering the cabins this
      // companion may use renumbered her cabin whenever another companion bound one before it: the same cabin was
      // "Cabin 1" in one world state and "Cabin 2" in the next, so the word could not be carried across a reload.
      const choices = await Promise.all(
        session.cabins
          .map((cabin, index) => ({ cabin, label: `Cabin ${index + 1}` }))
          .filter(
            ({ cabin }) =>
              !cabin.isBusy &&
              (cabin.boundCompanionId === "" ||
                cabin.boundCompanionId === ownerFacts.privateMaterial.value?.companionId),
          )
          .map(async ({ cabin, label }) =>
            Object.freeze({
              cabinId: cabin.cabinId,
              displayLabel: label,
              expiresAtMs: ownerFacts.expiresAtMs,
              selection: await coordinator.select(owner, cabin.cabinId),
            }),
          ),
      );
      assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
      return Object.freeze(choices);
    },
    async select(
      owner: StardewOwnedPlayerHostBootstrap,
      candidateCabinId: string,
    ): Promise<StardewManifestHandoffSelection> {
      const ownerFacts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
      const flow = createOwnedPlayerHostAttachmentFlowCore(owner, compositionIdentity, readClock);
      const expectedGeneration = requirePlayerHostLaunchGeneration(ownerFacts);
      let choice: StardewVerifiedCabinChoice;
      try {
        choice = await flow.verifyCabinChoice(candidateCabinId, expectedGeneration);
      } catch (error) {
        if (error instanceof Error && error.message === "stardew_player_host_generation_mismatch")
          await quarantinePlayerHostGenerationMismatch(ownerFacts);
        throw error;
      }
      assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
      const selection = Object.freeze(Object.create(null)) as StardewManifestHandoffSelection;
      const facts: ManifestHandoffSelectionFacts = {
        compositionIdentity,
        owner,
        flow,
        choice,
        verifiedAdvertisementRuntimeRole: "player_host",
        verifiedAdvertisementGeneration: expectedGeneration,
        expiresAtMs: ownerFacts.expiresAtMs,
        state: "available",
        requestId: null,
        manifest: null,
      };
      selections.set(selection, facts);
      return selection;
    },
    async confirmAndAdmit(
      selection: StardewManifestHandoffSelection,
      confirmation: Readonly<{ confirmed: true }>,
    ): Promise<StardewManifestAdmission> {
      if (confirmation === null || typeof confirmation !== "object" || confirmation.confirmed !== true)
        throw new Error("user_confirmation_required");
      const facts = selections.get(selection);
      if (facts === undefined || facts.compositionIdentity !== compositionIdentity)
        throw new Error("invalid_stardew_manifest_handoff_selection");
      if (facts.state !== "available") throw new Error("invalid_stardew_manifest_handoff_selection");
      facts.state = "confirming";
      const ownerFacts = requireOwnedPlayerHostBootstrapFacts(facts.owner, compositionIdentity);
      try {
        assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
        await assertPlayerHostGenerationCorrelation(ownerFacts, facts.verifiedAdvertisementGeneration);
        let requestId: string;
        try {
          requestId = await facts.flow.confirmAndRequest(facts.choice, { confirmed: true });
        } catch (error) {
          if (didManifestRequestPublicationPossiblyOccur(error)) {
            throw refuseManifestHandoffStage(facts, "request_publication", error);
          }
          facts.state = "terminal";
          throw redactManifestHandoffError(error);
        }
        facts.requestId = requestId;
        facts.state = "request_published";
        const remainingMs = Math.min(60_000, Math.max(1, facts.expiresAtMs - readClock()));
        let manifest: StardewJoinManifest;
        try {
          manifest = await facts.flow.waitForManifest(requestId, remainingMs);
        } catch (error) {
          throw refuseManifestHandoffStage(facts, "manifest_not_admitted", error);
        }
        try {
          assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
        } catch (error) {
          throw refuseManifestHandoffStage(facts, "owner_not_admissible", error);
        }
        try {
          await assertPlayerHostGenerationCorrelation(ownerFacts, facts.verifiedAdvertisementGeneration);
        } catch (error) {
          throw refuseManifestHandoffStage(facts, "generation_changed", error);
        }
        facts.manifest = Object.freeze({ ...manifest });
        facts.state = "admitted";
        const admission = Object.freeze(Object.create(null)) as StardewManifestAdmission;
        const admissionFacts: ManifestHandoffAdmissionFacts = {
          compositionIdentity,
          owner: facts.owner,
          flow: facts.flow,
          choice: facts.choice,
          requestId,
          manifest: facts.manifest,
          admittedAtMs: readClock(),
          expiresAtMs: facts.manifest.expiresAtUnixMs,
          consumed: { value: false },
        };
        admissions.set(admission, admissionFacts);
        return admission;
      } catch (error) {
        if (facts.state === "confirming") facts.state = "terminal";
        throw redactManifestHandoffError(error);
      }
    },
    readAdmittedJoinRequestId(owner: StardewOwnedPlayerHostBootstrap, admission: StardewManifestAdmission): string {
      const ownerFacts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      const admissionFacts = admissions.get(admission);
      if (
        admissionFacts === undefined ||
        admissionFacts.compositionIdentity !== compositionIdentity ||
        admissionFacts.owner !== owner ||
        ownerFacts.bindingState.value !== "bound" ||
        ownerFacts.quarantine.started ||
        ownerFacts.expiresAtMs <= readClock() ||
        admissionFacts.expiresAtMs <= readClock()
      )
        throw new Error("stardew_admitted_join_request_not_admissible");
      return admissionFacts.requestId;
    },
    async readCabinOccupancy(
      owner: StardewOwnedPlayerHostBootstrap,
      admission: StardewManifestAdmission,
    ): Promise<StardewCabinOccupancyEvidence> {
      const ownerFacts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      const admissionFacts = requireAdmissionOfThisAttempt(owner, admission);
      const material = ownerFacts.privateMaterial.value;
      // `terminal` is the state the quarantine this read exists for leaves the binding in
      // (`quarantineOwnedPlayerHostOwner` -> `terminalizeOwnedPlayerHostOwner`), so the one thing that
      // makes the read impossible is the material being gone or the bind still in flight.
      if (
        material === null ||
        ownerFacts.bindingState.value === "unbound" ||
        ownerFacts.bindingState.value === "binding"
      )
        throw new Error("stardew_cabin_occupancy_unavailable");
      const runtimeRoot = dirname(dirname(ownerFacts.durableOwner.transactionDirectory));
      const ownerPath = join(ownerFacts.durableOwner.transactionDirectory, OWNER_FILE);
      // The record is read under the same lock every writer takes, so the evidence names the exact
      // revision the release will compare against rather than one this side remembered.
      const record = await withPathLock(ownerPath, () => readAndValidateOwner(ownerPath, runtimeRoot), {
        containmentRoot: runtimeRoot,
      });
      const flow = new StardewAttachmentFlow({
        sessionDirectory: material.sessionDirectory,
        sessionToken: material.sessionToken,
        companionId: material.companionId,
        nowMs: readClock,
      });
      const reading = await flow.readCabinOccupancy({
        saveId: admissionFacts.manifest.saveId,
        worldId: admissionFacts.manifest.worldId,
        farmhandId: admissionFacts.manifest.farmhandId,
      });
      return Object.freeze({
        reading,
        record: Object.freeze({
          bootstrapId: record.bootstrapId,
          ownerRecordRevision: record.ownerRecordRevision,
          state: record.state,
          cleanupDisposition: record.cleanupDisposition,
        }),
      });
    },
    async releaseQuarantinedCabinPublication(
      owner: StardewOwnedPlayerHostBootstrap,
      admission: StardewManifestAdmission,
      evidence: StardewCabinOccupancyEvidence,
      probe: StardewGuardianNamedObjectProbe,
    ): Promise<void> {
      const ownerFacts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
      const admissionFacts = requireAdmissionOfThisAttempt(owner, admission);
      const runtimeRoot = dirname(dirname(ownerFacts.durableOwner.transactionDirectory));
      await releaseCabinPublicationQuarantine(
        runtimeRoot,
        ownerFacts.durableOwner.record.bootstrapId,
        evidence,
        Object.freeze({
          saveId: admissionFacts.manifest.saveId,
          worldId: admissionFacts.manifest.worldId,
          farmhandId: admissionFacts.manifest.farmhandId,
        }),
        probe,
        readClock,
      );
    },
  } satisfies StardewManifestHandoffCoordinator;
  const materialize: MaterializeAiClientProfileAfterManifestAdmission = async (owner, admission) => {
    const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
    const admissionFacts = admissions.get(admission);
    if (
      admissionFacts === undefined ||
      admissionFacts.compositionIdentity !== compositionIdentity ||
      admissionFacts.owner !== owner ||
      admissionFacts.consumed.value ||
      facts.bindingState.value !== "bound" ||
      facts.quarantine.started ||
      facts.expiresAtMs <= readClock() ||
      admissionFacts.expiresAtMs <= readClock() ||
      admissionFacts.manifest.expiresAtUnixMs <= readClock() ||
      facts.privateMaterial.value === null ||
      admissionFacts.requestId !== admissionFacts.manifest.requestId ||
      admissionFacts.manifest.companionId !== facts.privateMaterial.value?.companionId ||
      admissionFacts.manifest.integrationVersion !== facts.privateMaterial.value?.integrationVersion ||
      facts.aiClientProfileState.value !== "not_materialized" ||
      facts.launchStates.aiClient !== "available"
    ) {
      throw new Error("stardew_ai_client_profile_materialization_not_admissible");
    }

    // The one-shot admission is consumed before any asynchronous package read or
    // filesystem operation. It is intentionally never restored after failure.
    admissionFacts.consumed.value = true;
    facts.aiClientProfileState.value = "materializing";
    const dependencies = resolveStagingDependencies();
    try {
      const packageSource = await dependencies.readPackage();
      validatePackageSource(packageSource);
      if (
        facts.expiresAtMs <= readClock() ||
        admissionFacts.expiresAtMs <= readClock() ||
        admissionFacts.manifest.expiresAtUnixMs <= readClock()
      ) {
        throw new Error("stardew_ai_client_profile_materialization_expired");
      }
      const bridgeMaterial = await stageAiClientProfile(
        owner,
        admissionFacts,
        packageSource,
        dependencies,
        createBridgePipeName,
        createBridgeToken,
      );
      facts.privateBridgeMaterial.value = bridgeMaterial;
      facts.aiClientProfileState.value = "materialized";
      facts.bridgeConnectionState.value = "available";
    } catch (error) {
      facts.privateBridgeMaterial.value = null;
      facts.aiClientProfileState.value = "failed";
      facts.bridgeConnectionState.value = "consumed";
      try {
        await facts.quarantineOwner();
      } catch {
        /* preserve materialization failure */
      }
      throw error;
    }
  };
  return Object.freeze({ coordinator: Object.freeze(coordinator), materialize });
}

function requirePlayerHostLaunchGeneration(facts: OwnedPlayerHostBootstrapFacts): string {
  const playerHost = facts.durableOwner.record.playerHost;
  if (playerHost.kind !== "launch_reserved") throw new Error("stardew_player_host_generation_unavailable");
  return playerHost.launchGeneration;
}

async function quarantinePlayerHostGenerationMismatch(facts: OwnedPlayerHostBootstrapFacts): Promise<never> {
  try {
    await facts.quarantineOwner();
  } catch {
    // Preserve the terminal correlation failure; quarantine is itself one-shot
    // and the owner remains closed when persistence cannot complete.
  }
  throw new Error("stardew_player_host_generation_mismatch");
}

async function assertPlayerHostGenerationCorrelation(
  facts: OwnedPlayerHostBootstrapFacts,
  advertisementGeneration: string,
): Promise<void> {
  if (advertisementGeneration !== requirePlayerHostLaunchGeneration(facts))
    await quarantinePlayerHostGenerationMismatch(facts);
}

function assertManifestHandoffOwnerAdmissible(facts: OwnedPlayerHostBootstrapFacts, readClock: () => number): void {
  if (
    facts.bindingState.value !== "bound" ||
    facts.quarantine.started ||
    facts.expiresAtMs <= readClock() ||
    facts.privateMaterial.value === null
  )
    throw new Error("stardew_manifest_handoff_not_admissible");
}

type ManifestHandoffUncertainStage =
  | "request_publication"
  | "manifest_not_admitted"
  | "owner_not_admissible"
  | "generation_changed";

/**
 * The questions `confirmAndAdmit` can no longer answer once the attachment request is on disk, and
 * the refusal each of them answers with.
 *
 * They shared one code (`stardew_manifest_handoff_publication_uncertain`) until run r19 was refused
 * 106 ms after the player's press with `cause: null`, and its own evidence could not say which had
 * fired: the manifest the Mod issued did not pass this side's validation, the owner stopped being
 * admissible, or the Player Host generation the selection was verified against had moved. Every one
 * of those is the same fact at the browser's boundary - the published request's fate is unknown, so
 * the attempt stays and the key may not be replayed - and a different fact for whoever has to fix
 * it. The browser's bounded code is unchanged; these are what its cause chain carries.
 */
const MANIFEST_HANDOFF_UNCERTAIN_REFUSAL: Readonly<Record<ManifestHandoffUncertainStage, string>> = Object.freeze({
  request_publication: "stardew_manifest_handoff_publication_uncertain",
  manifest_not_admitted: "stardew_manifest_handoff_manifest_not_admitted",
  owner_not_admissible: "stardew_manifest_handoff_owner_not_admissible",
  generation_changed: "stardew_manifest_handoff_generation_changed",
});

/** The refusal each uncertain stage answers with. One declaration, so no stage can be minted unseen. */
export const STARDEW_MANIFEST_HANDOFF_UNCERTAIN_REFUSALS: readonly string[] = Object.freeze(
  Object.values(MANIFEST_HANDOFF_UNCERTAIN_REFUSAL),
);

/** Whether a `confirmAndAdmit` refusal leaves a published request whose fate this side cannot know. */
export function isManifestHandoffUncertainRefusal(error: unknown): boolean {
  return error instanceof Error && STARDEW_MANIFEST_HANDOFF_UNCERTAIN_REFUSALS.includes(error.message);
}

function refuseManifestHandoffStage(
  facts: ManifestHandoffSelectionFacts,
  stage: ManifestHandoffUncertainStage,
  cause: unknown,
): Error {
  facts.state = "uncertain";
  return new Error(MANIFEST_HANDOFF_UNCERTAIN_REFUSAL[stage], { cause });
}

function didManifestRequestPublicationPossiblyOccur(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  // These validation failures all occur before confirmAndRequest constructs or writes the request; the
  // `stardew_session_` PREFIX is why a lapsed advertisement is one (named literally, it matched only itself).
  return !/^(?:user_confirmation_required|invalid_cabin_id|invalid_stardew_cabin_choice|invalid_expected_farmhand_id|stardew_session_[a-z_]+|stardew_protocol_mismatch|stardew_host_not_ready|cabin_missing|target_farmhand_busy|cabin_bound_to_other_companion)$/u.test(
    error.message,
  );
}

function redactManifestHandoffError(error: unknown): Error {
  if (
    error instanceof Error &&
    (!didManifestRequestPublicationPossiblyOccur(error) ||
      /^stardew_manifest_handoff_|^user_confirmation_required$|^invalid_stardew_manifest_handoff_selection$/.test(
        error.message,
      ))
  )
    return error;
  return new Error("stardew_manifest_handoff_failed");
}

async function readAndCorrelateOwnedPlayerHostSessionCore(
  owner: StardewOwnedPlayerHostBootstrap,
  compositionIdentity: object,
  readClock: () => number,
): Promise<boolean> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  const flow = createOwnedPlayerHostAttachmentFlowCore(owner, compositionIdentity, readClock);
  try {
    const session = await flow.readLiveSession();
    await assertPlayerHostGenerationCorrelation(facts, session.launchGeneration);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "stardew_player_host_generation_mismatch") throw error;
    if (facts.expiresAtMs <= readClock()) throw new Error("stardew_player_host_attestation_deadline_expired");
    return false;
  }
}

function createOwnedPlayerHostAttachmentFlowCore(
  owner: StardewOwnedPlayerHostBootstrap,
  compositionIdentity: object,
  readClock: () => number,
): StardewAttachmentFlow {
  try {
    const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
    // staged Player Host clears playerHostProfileStagingState after consuming only the Player Host launch
    // reservation. Private session material deliberately remains available for
    // the later authenticated attachment read path, so material presence—not
    // the transient staging state—is the admission proof here.
    if (facts.bindingState.value !== "bound") throw new Error("staged_material_unavailable");
    if (facts.quarantine.started || facts.expiresAtMs <= readClock()) throw new Error("owner_not_admissible");
    const material = facts.privateMaterial.value;
    if (material === null) throw new Error("staged_material_unavailable");
    return new StardewAttachmentFlow({
      sessionDirectory: material.sessionDirectory,
      sessionToken: material.sessionToken,
      companionId: material.companionId,
      nowMs: readClock,
    });
  } catch {
    throw new Error("stardew_private_launch_admission_failed");
  }
}

/**
 * Core-private composition-bound staged Player Host launch primitive. Requires the exact
 * closure-owned composition identity that minted the owner, which must be
 * `bindingState=bound` and `playerHostProfileStagingState=staged`. Atomically marks an in-flight
 * launch attempt, fresh-rechecks the admitted SMAPI identity, derives exactly
 * `<root>/StardewModdingAPI.exe`, args `['--mods-path',
 * <transaction>/player-host/Mods]`, cwd root, and consumes the exact reserved
 * Player Host launch. Fresh identity failure: zero spawn and restores
 * `playerHostProfileStagingState=staged` for retry. Spawn/process probe failure preserves the
 * existing one-shot owner behavior; the staged marker drains permanently.
 * Never exported from this module; only the closed composition and the
 * dedicated test composition reach it with their stored identity.
 */
const stageCControlledLaunchErrors = new WeakSet<object>();

/** Internal classification only: true means the one-shot controlled launch callback was entered. */
export function didStardewOwnedPlayerHostStageCEnterControlledLaunch(error: unknown): boolean {
  return typeof error === "object" && error !== null && stageCControlledLaunchErrors.has(error);
}

async function launchStagedPlayerHost(
  owner: StardewOwnedPlayerHostBootstrap,
  installation: AdmittedStardewInstallation,
  compositionIdentity: object,
): Promise<StardewOwnedPlayerHostStageCResult> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  if (facts.bindingState.value !== "bound") throw new Error("stardew_owned_player_host_bootstrap_owner_not_bound");
  if (facts.playerHostProfileStagingState.value !== "staged")
    throw new Error("stardew_owned_player_host_bootstrap_player_host_profile_staging_not_staged");
  if (facts.quarantine.started) throw new Error("stardew_owned_player_host_bootstrap_owner_quarantined");
  if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");

  // Atomically mark the in-flight launch attempt before any await so a
  // concurrent staged Player Host invocation for the exact owner can never double-spawn.
  facts.playerHostProfileStagingState.value = "launching";

  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const modsPath = join(transactionDirectory, HOST_PROFILE_ROOT, MODS_DIRECTORY);

  let launchEntered = false;
  try {
    const launched = await consumeAdmittedStardewInstallation(installation, async (root, executable) => {
      // Carried before the launch consumer runs: the profile root is what SMAPI
      // will read as the game's whole Mod list, and a failure here spawns nothing
      // so the staged marker still restores for a complete retry.
      const modsRoot = await carryPlayerModsIntoProfileRoot(root, modsPath, transactionDirectory);
      launchEntered = true;
      const recipe: StardewPrivateRoleLaunchRecipe = Object.freeze({
        role: "player_host",
        executable,
        cwd: root,
        args: Object.freeze(["--mods-path", modsPath]),
        launchGeneration: facts.playerHostRegistration.launchGeneration,
      });
      const result = facts.consumePlayerHostLaunch((launch) =>
        launch({
          executable: recipe.executable,
          args: recipe.args,
          cwd: recipe.cwd,
        }),
      );
      return Object.freeze({ result, modsRoot });
    });
    // Launch succeeded: the staged profile has been used.
    facts.playerHostProfileStagingState.value = "not_staged";
    return Object.freeze({ status: launched.result.status, modsRoot: launched.modsRoot });
  } catch (error) {
    // A fresh identity failure never enters the Player Host launch consumer:
    // zero spawns happened, so the staged marker restores for a complete
    // retry. Spawn/probe/expiry/quarantine-on-entry failures keep the existing
    // one-shot owner behavior; the staged marker drains permanently.
    facts.playerHostProfileStagingState.value = launchEntered ? "not_staged" : "staged";
    if (launchEntered && typeof error === "object" && error !== null) {
      stageCControlledLaunchErrors.add(error);
    }
    throw error;
  }
}

/**
 * Core-private composition-bound contained staged Player Host launch. The same
 * owner/staging validations and request-local fresh install identity reread as
 * `launchStagedPlayerHost` run first; then the launch decision receives the
 * core-bound `StardewContainedPlayerHostLaunchSeam`. Invoking the seam's
 * producer (the Host runtime's `launchRole` step) atomically claims the exact
 * one-shot Player Host reservation and authorizes the recipe-derived typed
 * facts; no raw child is created here. Claim-attempt failures keep the one-shot
 * owner behavior and drain the staged marker permanently (classified through
 * `didStardewOwnedPlayerHostStageCEnterControlledLaunch`), while pre-claim
 * failures restore the staged marker exactly like the direct-spawn path.
 */
async function launchStagedPlayerHostContained(
  owner: StardewOwnedPlayerHostBootstrap,
  installation: AdmittedStardewInstallation,
  launchContained: (launch: StardewContainedPlayerHostLaunchSeam) => Promise<void> | void,
  compositionIdentity: object,
): Promise<StardewOwnedPlayerHostStageCResult> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  if (facts.bindingState.value !== "bound") throw new Error("stardew_owned_player_host_bootstrap_owner_not_bound");
  if (facts.playerHostProfileStagingState.value !== "staged")
    throw new Error("stardew_owned_player_host_bootstrap_player_host_profile_staging_not_staged");
  if (facts.quarantine.started) throw new Error("stardew_owned_player_host_bootstrap_owner_quarantined");
  if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");

  // Atomically mark the in-flight launch attempt before any await so a
  // concurrent contained staged Player Host invocation can never double-launch.
  facts.playerHostProfileStagingState.value = "launching";

  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const modsPath = join(transactionDirectory, HOST_PROFILE_ROOT, MODS_DIRECTORY);

  let claimAttempted = false;
  let carriedModsRoot: StardewPlayerHostModsRoot | undefined;
  try {
    await consumeAdmittedStardewInstallation(installation, async (root, executable) => {
      // Carried before the claim: nothing is spawned until the profile root holds
      // the whole Mod list the game will load.
      carriedModsRoot = await carryPlayerModsIntoProfileRoot(root, modsPath, transactionDirectory);
      const recipe: StardewPrivateRoleLaunchRecipe = Object.freeze({
        role: "player_host",
        executable,
        cwd: root,
        args: Object.freeze(["--mods-path", modsPath]),
        launchGeneration: facts.playerHostRegistration.launchGeneration,
      });
      const typedFacts: TypedPrivateGameFacts = Object.freeze({
        executable: recipe.executable,
        cwd: recipe.cwd,
        arguments: recipe.args,
        environment: createStardewChildEnvironment(recipe.launchGeneration),
      });
      const seam: StardewContainedPlayerHostLaunchSeam = Object.freeze({
        role: "player_host",
        launchGeneration: recipe.launchGeneration,
        provideAuthorization: (authorize) => {
          // The claim attempt boundary: any failure from here on (including
          // a later arm/launch transport failure inside the caller's runtime)
          // is treated as a possibly-entered controlled launch.
          claimAttempted = true;
          facts.consumePlayerHostLaunchContained((claim) => {
            claim(typedFacts);
            authorize(typedFacts);
          });
        },
      });
      return launchContained(seam);
    });
    // A launch decision that completes without ever invoking the producer
    // cannot have committed the one-shot reservation: fail closed before the
    // staged marker drains so a retry remains possible. The direct-spawn
    // consumer is equivalent (success is only produced by consuming the launch).
    if (!claimAttempted || carriedModsRoot === undefined)
      throw new Error("stardew_contained_player_host_launch_claim_not_attempted");
    // The contained launch succeeded: the staged profile has been used.
    facts.playerHostProfileStagingState.value = "not_staged";
    return Object.freeze({
      status: { kind: "awaiting_player_host_attestation" as const },
      modsRoot: carriedModsRoot,
    });
  } catch (error) {
    // A fresh identity failure never reaches the seam: zero claims happened, so
    // the staged marker restores for a complete retry. Any claim-attempt
    // failure keeps the one-shot owner behavior; the staged marker drains
    // permanently and the caller's launchMayHaveRun classification matches the
    // direct-spawn Stage C consumer.
    facts.playerHostProfileStagingState.value = claimAttempted ? "not_staged" : "staged";
    if (claimAttempted && typeof error === "object" && error !== null) {
      stageCControlledLaunchErrors.add(error);
    }
    throw error;
  }
}

/**
 * Core-private composition-bound AI-client launch. The exact owner must have a
 * completely materialized C1 profile. Durable managed inventory is reread before
 * the admitted installation performs its final identity-chain reread. The bridge
 * document's own identity is checked again after that asynchronous reread; only
 * then may the exact reserved AI launch be consumed.
 */
async function launchMaterializedAiClient(
  owner: StardewOwnedPlayerHostBootstrap,
  installation: AdmittedStardewInstallation,
  compositionIdentity: object,
): Promise<StardewOwnedAiClientStageDResult> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  if (facts.bindingState.value !== "bound" || facts.aiClientProfileState.value !== "materialized")
    throw new Error("stardew_ai_client_profile_not_materialized");
  if (facts.quarantine.started) throw new Error("stardew_owned_player_host_bootstrap_owner_quarantined");
  if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");
  if (facts.launchStates.aiClient !== "available") throw new Error("stardew_ai_client_launch_not_available");

  const bridgeMaterial = facts.privateBridgeMaterial.value;
  if (bridgeMaterial === null) throw new Error("stardew_ai_client_bridge_material_unavailable");

  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const authorityRoot = dirname(dirname(transactionDirectory));
  const ownerPath = join(transactionDirectory, OWNER_FILE);
  const current = await readAndValidateOwner(ownerPath, authorityRoot);
  if (
    current.bootstrapId !== facts.durableOwner.record.bootstrapId ||
    JSON.stringify(current) !== JSON.stringify(facts.durableOwner.record) ||
    current.state !== "reserved" ||
    JSON.stringify(current.managedPaths) !== JSON.stringify(C1_MANAGED_PATHS)
  )
    throw new Error("stardew_ai_client_profile_inventory_invalid");
  await assertMaterializedC1Inventory(transactionDirectory, authorityRoot);
  const configPath = join(transactionDirectory, AI_CLIENT_PROFILE_ROOT, MODS_DIRECTORY, MOD_DIRECTORY, MOD_CONFIG_FILE);
  await assertAiClientBridgeConfigIdentity(configPath, transactionDirectory, bridgeMaterial.configIdentity);
  if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");

  const modsPath = join(transactionDirectory, AI_CLIENT_PROFILE_ROOT, MODS_DIRECTORY);
  return consumeAdmittedStardewInstallation(installation, async (root, executable) => {
    await assertAiClientBridgeConfigIdentity(configPath, transactionDirectory, bridgeMaterial.configIdentity);
    if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");
    const recipe: StardewPrivateRoleLaunchRecipe = Object.freeze({
      role: "ai_client",
      executable,
      cwd: root,
      args: Object.freeze(["--mods-path", modsPath]),
      launchGeneration: facts.aiClientRegistration.launchGeneration,
    });
    return facts.consumeAiClientLaunch((launch) =>
      launch({
        executable: recipe.executable,
        args: recipe.args,
        cwd: recipe.cwd,
      }),
    );
  });
}

/**
 * Core-private composition-bound contained AI-client launch. The same
 * owner/profile/inventory/bridge preconditions and request-local fresh install
 * identity reread as `launchMaterializedAiClient` run first; then the launch
 * decision receives the core-bound `StardewContainedAiClientLaunchSeam`.
 * Invoking the seam's producer (the Host runtime's `launchRole` step)
 * atomically commits the exact one-shot AI-client reservation and marks the
 * process owner awaiting attestation without creating a raw child. Pre-claim
 * failures leave the reservation available; claim-attempt failures keep the
 * one-shot owner behavior exactly like the direct-spawn Stage D consumer.
 */
async function launchMaterializedAiClientContained(
  owner: StardewOwnedPlayerHostBootstrap,
  installation: AdmittedStardewInstallation,
  launchContained: (launch: StardewContainedAiClientLaunchSeam) => Promise<void> | void,
  compositionIdentity: object,
): Promise<StardewOwnedAiClientStageDResult> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  if (facts.bindingState.value !== "bound" || facts.aiClientProfileState.value !== "materialized")
    throw new Error("stardew_ai_client_profile_not_materialized");
  if (facts.quarantine.started) throw new Error("stardew_owned_player_host_bootstrap_owner_quarantined");
  if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");
  if (facts.launchStates.aiClient !== "available") throw new Error("stardew_ai_client_launch_not_available");

  const bridgeMaterial = facts.privateBridgeMaterial.value;
  if (bridgeMaterial === null) throw new Error("stardew_ai_client_bridge_material_unavailable");

  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const authorityRoot = dirname(dirname(transactionDirectory));
  const ownerPath = join(transactionDirectory, OWNER_FILE);
  const current = await readAndValidateOwner(ownerPath, authorityRoot);
  if (
    current.bootstrapId !== facts.durableOwner.record.bootstrapId ||
    JSON.stringify(current) !== JSON.stringify(facts.durableOwner.record) ||
    current.state !== "reserved" ||
    JSON.stringify(current.managedPaths) !== JSON.stringify(C1_MANAGED_PATHS)
  )
    throw new Error("stardew_ai_client_profile_inventory_invalid");
  await assertMaterializedC1Inventory(transactionDirectory, authorityRoot);
  const configPath = join(transactionDirectory, AI_CLIENT_PROFILE_ROOT, MODS_DIRECTORY, MOD_DIRECTORY, MOD_CONFIG_FILE);
  await assertAiClientBridgeConfigIdentity(configPath, transactionDirectory, bridgeMaterial.configIdentity);
  if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");

  const modsPath = join(transactionDirectory, AI_CLIENT_PROFILE_ROOT, MODS_DIRECTORY);
  let claimAttempted = false;
  await consumeAdmittedStardewInstallation(installation, async (root, executable) => {
    await assertAiClientBridgeConfigIdentity(configPath, transactionDirectory, bridgeMaterial.configIdentity);
    if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");
    const recipe: StardewPrivateRoleLaunchRecipe = Object.freeze({
      role: "ai_client",
      executable,
      cwd: root,
      args: Object.freeze(["--mods-path", modsPath]),
      launchGeneration: facts.aiClientRegistration.launchGeneration,
    });
    const typedFacts: TypedPrivateGameFacts = Object.freeze({
      executable: recipe.executable,
      cwd: recipe.cwd,
      arguments: recipe.args,
      environment: createStardewChildEnvironment(recipe.launchGeneration),
    });
    const seam: StardewContainedAiClientLaunchSeam = Object.freeze({
      role: "ai_client",
      launchGeneration: recipe.launchGeneration,
      provideAuthorization: (authorize) => {
        // The claim attempt boundary: any failure from here on (including a
        // later arm/launch transport failure inside the caller's runtime)
        // keeps the exact one-shot owner behavior.
        claimAttempted = true;
        facts.consumeAiClientLaunchContained((claim) => {
          claim(typedFacts);
          authorize(typedFacts);
        });
      },
    });
    return launchContained(seam);
  });
  // A launch decision that completes without ever invoking the producer
  // cannot have committed the one-shot reservation: fail closed so a retry
  // remains possible.
  if (!claimAttempted) throw new Error("stardew_contained_ai_client_launch_claim_not_attempted");
  return Object.freeze({ status: { kind: "awaiting_ai_client_attestation" as const } });
}

async function consumeOwnedFarmhandBridgeConnection<T extends Readonly<{ close(): void | Promise<void> }>>(
  owner: StardewOwnedPlayerHostBootstrap,
  callback: (connection: StardewPrivateFarmhandBridgeConnection) => Promise<T> | T,
  compositionIdentity: object,
  readAiClientStatus: () => StardewAiClientProcessStatus,
): Promise<T> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  if (typeof callback !== "function") throw new TypeError("invalid_stardew_farmhand_bridge_connection_callback");
  if (facts.bindingState.value !== "bound" || facts.aiClientProfileState.value !== "materialized")
    throw new Error("stardew_farmhand_bridge_profile_not_materialized");
  if (facts.quarantine.started) throw new Error("stardew_owned_player_host_bootstrap_owner_quarantined");
  if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");
  if (facts.bridgeConnectionState.value !== "available")
    throw new FarmhandBridgeConnectionNotAvailableError("stardew_farmhand_bridge_connection_not_available");
  if (readAiClientStatus().kind !== "awaiting_ai_client_attestation")
    throw new Error("stardew_farmhand_bridge_ai_client_not_awaiting_attestation");
  if (facts.aiClientRegistration.launchGeneration !== facts.durableOwner.record.aiClient.launchGeneration)
    throw new Error("stardew_ai_client_generation_mismatch");
  if (facts.aiClientProfileState.value !== "materialized" || facts.aiClientRegistration.launchGeneration.length === 0)
    throw new Error("stardew_farmhand_bridge_connection_not_admissible");

  facts.bridgeConnectionState.value = "binding";
  let callbackEntered = false;
  try {
    if (facts.aiClientRegistration.launchGeneration !== facts.durableOwner.record.aiClient.launchGeneration)
      throw new Error("stardew_ai_client_generation_mismatch");
    const bridgeMaterial = facts.privateBridgeMaterial.value;
    if (bridgeMaterial === null) throw new Error("stardew_ai_client_bridge_material_unavailable");
    const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
    const authorityRoot = dirname(dirname(transactionDirectory));
    const ownerPath = join(transactionDirectory, OWNER_FILE);
    const current = await readAndValidateOwner(ownerPath, authorityRoot);
    if (
      JSON.stringify(current) !== JSON.stringify(facts.durableOwner.record) ||
      current.state !== "reserved" ||
      JSON.stringify(current.managedPaths) !== JSON.stringify(C1_MANAGED_PATHS)
    ) {
      throw new Error("stardew_farmhand_bridge_owner_invalid");
    }
    await assertMaterializedC1Inventory(transactionDirectory, authorityRoot);
    const configPath = join(
      transactionDirectory,
      AI_CLIENT_PROFILE_ROOT,
      MODS_DIRECTORY,
      MOD_DIRECTORY,
      MOD_CONFIG_FILE,
    );
    await assertAiClientBridgeConfigIdentity(configPath, transactionDirectory, bridgeMaterial.configIdentity);
    if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");
    if (facts.aiClientRegistration.launchGeneration !== current.aiClient.launchGeneration)
      throw new Error("stardew_ai_client_generation_mismatch");
    if (readAiClientStatus().kind !== "awaiting_ai_client_attestation")
      throw new Error("stardew_farmhand_bridge_ai_client_not_awaiting_attestation");

    callbackEntered = true;
    const result = await callback(
      Object.freeze({
        ...bridgeMaterial.connection,
        launchGeneration: current.aiClient.launchGeneration,
      }),
    );
    if (readAiClientStatus().kind !== "awaiting_ai_client_attestation") {
      try {
        await result.close();
      } catch {
        /* the caller receives no connection authority */
      }
      throw new Error("stardew_farmhand_bridge_ai_client_not_awaiting_attestation");
    }
    facts.bridgeConnectionState.value = "consumed";
    return result;
  } catch (error) {
    facts.bridgeConnectionState.value = callbackEntered ? "available" : "consumed";
    throw error;
  }
}

/**
 * Rotates the durable owner record's AI-client launch generation to a fresh
 * per-activation generation under the exact path lock. The fresh v4 record is
 * write-verified, so disk and the in-memory record agree before any state
 * re-arms; a failure leaves the previous generation untouched.
 */
async function rotateAiClientLaunchGeneration(
  facts: OwnedPlayerHostBootstrapFacts,
  launchGeneration: string,
): Promise<void> {
  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const authorityRoot = dirname(dirname(transactionDirectory));
  const ownerPath = join(transactionDirectory, OWNER_FILE);
  const expected = facts.durableOwner.record;
  let rotated: StardewPrivateBootstrapOwnerRecord | undefined;
  await withPathLock(
    ownerPath,
    async () => {
      const current = await readAndValidateOwner(ownerPath, authorityRoot);
      if (
        current.bootstrapId !== expected.bootstrapId ||
        JSON.stringify(current) !== JSON.stringify(expected) ||
        current.state !== "reserved" ||
        JSON.stringify(current.managedPaths) !== JSON.stringify(C1_MANAGED_PATHS)
      )
        throw new Error("stardew_farmhand_bridge_owner_invalid");
      rotated = freezeRecord({ ...current, aiClient: { kind: "launch_reserved" as const, launchGeneration } });
      await atomicWriteFile(ownerPath, `${JSON.stringify(rotated)}\n`, authorityRoot);
      const reread = await readAndValidateOwner(ownerPath, authorityRoot);
      if (JSON.stringify(reread) !== JSON.stringify(rotated))
        throw new Error("stardew_farmhand_bridge_generation_rotation_reread_mismatch");
    },
    { containmentRoot: authorityRoot },
  );
  if (rotated === undefined) throw new Error("stardew_farmhand_bridge_generation_rotation_missing");
  facts.durableOwner.replaceRecord(rotated);
}

/**
 * Per-activation fresh connection/launch authority: re-arms the one-shot
 * Farmhand bridge connection and AI-client launch reservation for a NEW
 * activation, but only after the previous activation fully ended (its bridge
 * connection was consumed and its AI launch was claimed). It ends the previous
 * activation's AI (fail closed when the terminal identity is uncertain),
 * reserves a fresh launch generation, durably rotates the record generation,
 * and only then swaps the fresh registration in and re-arms both states. The
 * fresh authenticated scope/policy/revision/deadline validation still runs at
 * new-connection creation time (connect/hello), never here.
 */
async function prepareFreshFarmhandAiClientActivation(
  owner: StardewOwnedPlayerHostBootstrap,
  compositionIdentity: object,
  reserveAiClientLaunch: () => StardewAiClientLaunchRegistration,
  readAiClientStatus: () => StardewAiClientProcessStatus,
  stopOwnedAiClient: () => StopOwnedAiClientResult,
): Promise<{ launchGeneration: string }> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  if (facts.bindingState.value !== "bound" || facts.aiClientProfileState.value !== "materialized")
    throw new Error("stardew_farmhand_bridge_profile_not_materialized");
  if (facts.quarantine.started) throw new Error("stardew_owned_player_host_bootstrap_owner_quarantined");
  if (facts.expiresAtMs <= facts.readClock()) throw new Error("stardew_owned_player_host_bootstrap_owner_expired");
  // A fresh generation may be claimed only after an ended activation: a never
  // consumed or still-binding machine has no ended activation to supersede.
  // The refusal carries the shared typed identity so the lifecycle classifies
  // this state by identity; the message text stays for the other consumers of
  // this probe, which still read it as a deferred attach (see the class doc).
  if (facts.bridgeConnectionState.value !== "consumed" || facts.launchStates.aiClient !== "consumed")
    throw new FarmhandBridgeConnectionNotAvailableError("stardew_farmhand_bridge_connection_not_available");
  if (facts.privateBridgeMaterial.value === null) throw new Error("stardew_ai_client_bridge_material_unavailable");

  const oldStatus = readAiClientStatus();
  if (oldStatus.kind === "ai_client_launch_pending")
    throw new Error("stardew_farmhand_bridge_ai_client_launch_pending");
  if (oldStatus.kind === "awaiting_ai_client_attestation") {
    const stop = stopOwnedAiClient();
    if (stop.kind !== "terminated" && stop.kind !== "already_stopped" && stop.kind !== "no_owned_ai_client")
      throw new Error("stardew_farmhand_bridge_ai_client_stop_failed");
  }

  const registration = reserveAiClientLaunch();
  try {
    await rotateAiClientLaunchGeneration(facts, registration.launchGeneration);
  } catch (error) {
    try {
      registration.revoke();
    } catch {
      /* rotation failure remains primary */
    }
    throw error;
  }
  facts.aiClientRegistration = registration;
  facts.launchStates.aiClient = "available";
  facts.bridgeConnectionState.value = "available";
  return Object.freeze({ launchGeneration: registration.launchGeneration });
}

/**
 * Rolls a re-armed-but-not-yet-attached fresh activation back to the fully
 * consumed base so a later resume can prepare a new generation again. Used by
 * the coordinator when the fresh AI launch or bridge consume of a resume
 * attempt failed; revoking the registration is idempotent when the claim
 * already consumed it, and both per-activation states close.
 */
async function abandonFarmhandAiClientActivation(
  owner: StardewOwnedPlayerHostBootstrap,
  compositionIdentity: object,
): Promise<void> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  try {
    facts.aiClientRegistration.revoke();
  } catch {
    /* an earlier claim already consumed it */
  }
  facts.launchStates.aiClient = "consumed";
  facts.bridgeConnectionState.value = "consumed";
}

async function stageAiClientProfile(
  owner: StardewOwnedPlayerHostBootstrap,
  admission: ManifestHandoffAdmissionFacts,
  packageSource: Readonly<{ root: string; entries: readonly string[] }>,
  dependencies: PrivateModProfileStagingDependencies,
  createBridgePipeName: () => string,
  createBridgeToken: () => string,
): Promise<StardewPrivateBridgeMaterial> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner);
  const material = facts.privateMaterial.value;
  if (material === null) throw new Error("stardew_ai_client_profile_materialization_material_missing");
  const pipeName = createBridgePipeName();
  const bridgeToken = createBridgeToken();
  if (!isBridgePipeName(pipeName) || !isBridgeToken(bridgeToken))
    throw new Error("stardew_ai_client_bridge_material_invalid");
  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const ownerPath = join(transactionDirectory, OWNER_FILE);
  const managed = new Map<string, import("../../../path-lock.js").SafeFileIdentity>();
  const createdDirectories: string[] = [];
  let recordExtended = false;
  let originalRecord: StardewPrivateBootstrapOwnerRecord | undefined;
  return withPathLock(
    ownerPath,
    async () => {
      try {
        const current = await readAndValidateOwner(ownerPath, dirname(dirname(transactionDirectory)));
        if (
          current.bootstrapId !== facts.durableOwner.record.bootstrapId ||
          JSON.stringify(current) !== JSON.stringify(facts.durableOwner.record) ||
          current.state !== "reserved" ||
          current.expiresAtMs <= readClockForMaterialization(facts, admission, dependencies) ||
          JSON.stringify(current.managedPaths) !== JSON.stringify(PHASE_B_MANAGED_PATHS)
        )
          throw new Error("stardew_ai_client_profile_materialization_owner_invalid");

        await assertC1ExistingInventory(transactionDirectory, dirname(dirname(transactionDirectory)));
        await assertAiClientDestinationAbsent(transactionDirectory, dirname(dirname(transactionDirectory)));
        await assertManifestCorrelationStillHeld(material, admission);

        const next = freezeRecord({ ...current, managedPaths: [...C1_MANAGED_PATHS] });
        originalRecord = facts.durableOwner.record;
        await atomicWriteFile(ownerPath, `${JSON.stringify(next)}\n`, dirname(dirname(transactionDirectory)));
        facts.durableOwner.replaceRecord(next);
        recordExtended = true;

        const aiClientModDirectory = join(transactionDirectory, AI_CLIENT_PROFILE_ROOT, MODS_DIRECTORY, MOD_DIRECTORY);
        for (const directory of [
          join(transactionDirectory, AI_CLIENT_PROFILE_ROOT),
          join(transactionDirectory, AI_CLIENT_PROFILE_ROOT, MODS_DIRECTORY),
          aiClientModDirectory,
        ]) {
          await verifySafePathBoundary(directory, transactionDirectory);
          await mkdir(directory);
          createdDirectories.push(directory);
        }

        const manifestPath = join(material.sessionDirectory, "stardew-farmhand-manifest.json");
        await verifySafePathBoundary(manifestPath, transactionDirectory);
        // The player's own action consent and companion language, projected from
        // their durable records into the config the Mod actually reads. The AI-client
        // profile is the one whose reader gates the Agent surface: `TryInitializeEmbodiment`
        // publishes `EnabledActionSet` and the co-op night floor from THIS document,
        // while the Player Host profile only validates its own policy. This document
        // is authored whole (it is created exclusive, and every key in it is the
        // composer's), so the player-owned keys are written as ordinary members here;
        // a LIVE edit merges them into the same document instead, because by then it
        // carries whatever the Mod's own WriteConfig left in it.
        //
        // `PresentationLocale` is the one member that is conditional: it is written
        // only when the player has chosen a companion language, because its absence
        // is what tells the Mod to present in the live game locale.
        const runtimeRoot = dirname(dirname(transactionDirectory));
        const playerSettings = await readStardewPlayerSettings(runtimeRoot);
        const actionPolicy = projectStardewModActionPolicy(
          playerSettings,
          await readStardewModPresentationLocale(runtimeRoot),
        );
        const configIdentity: StardewPrivateAiClientBridgeConfigIdentity = Object.freeze({
          pipeName,
          bridgeToken,
          saveId: admission.manifest.saveId,
          worldId: admission.manifest.worldId,
          playerId: admission.manifest.farmhandId,
          companionId: admission.manifest.companionId,
          manifestPath,
          sessionToken: material.sessionToken,
          integrationVersion: material.integrationVersion,
        });
        const aiClientConfig = JSON.stringify({
          EnableLocalBridge: true,
          PipeName: configIdentity.pipeName,
          BridgeToken: configIdentity.bridgeToken,
          SaveId: configIdentity.saveId,
          WorldId: configIdentity.worldId,
          PlayerId: configIdentity.playerId,
          CompanionId: configIdentity.companionId,
          ActionPolicyVersion: 1,
          ...(actionPolicy.PresentationLocale === undefined
            ? {}
            : { PresentationLocale: actionPolicy.PresentationLocale }),
          DeniedActions: actionPolicy.DeniedActions,
          DeniedActionFamilies: actionPolicy.DeniedActionFamilies,
          AdvanceDayMinimumOnlineFarmers: actionPolicy.AdvanceDayMinimumOnlineFarmers,
          FarmhandProvisioner: {
            Enable: true,
            ManifestPath: configIdentity.manifestPath,
            SessionToken: configIdentity.sessionToken,
            IntegrationVersion: configIdentity.integrationVersion,
            TimeoutSeconds: 45,
          },
        });
        await writeManagedFile(
          join(aiClientModDirectory, MOD_CONFIG_FILE),
          aiClientConfig,
          transactionDirectory,
          managed,
        );
        for (const entry of packageSource.entries) {
          const content = await readFile(join(packageSource.root, entry));
          if (content.length === 0) throw new Error("stardew_ai_client_profile_materialization_package_invalid");
          await writeManagedFile(join(aiClientModDirectory, entry), content, transactionDirectory, managed);
        }

        const rereadPackage = await dependencies.readPackage();
        validatePackageSource(rereadPackage);
        if (
          rereadPackage.root !== packageSource.root ||
          JSON.stringify(rereadPackage.entries) !== JSON.stringify(packageSource.entries)
        )
          throw new Error("stardew_ai_client_profile_materialization_package_changed");
        if (
          facts.expiresAtMs <= readClockForMaterialization(facts, admission, dependencies) ||
          admission.expiresAtMs <= readClockForMaterialization(facts, admission, dependencies) ||
          admission.manifest.expiresAtUnixMs <= readClockForMaterialization(facts, admission, dependencies)
        ) {
          throw new Error("stardew_ai_client_profile_materialization_expired");
        }
        return Object.freeze({
          configIdentity,
          connection: Object.freeze({
            scope: Object.freeze({
              integrationId: "stardew",
              saveId: admission.manifest.saveId,
              worldId: admission.manifest.worldId,
              playerId: admission.manifest.farmhandId,
              companionId: admission.manifest.companionId,
            }),
            pipeName,
            token: bridgeToken,
          }),
        });
      } catch (error) {
        if (recordExtended) {
          await rollbackStagedPlayerHostProfile(managed, createdDirectories, transactionDirectory);
          if (originalRecord === undefined)
            throw new Error("stardew_ai_client_profile_materialization_rollback_record_missing");
          await atomicWriteFile(
            ownerPath,
            `${JSON.stringify(originalRecord)}\n`,
            dirname(dirname(transactionDirectory)),
          );
          facts.durableOwner.replaceRecord(originalRecord);
        }
        throw error;
      }
    },
    { containmentRoot: dirname(dirname(transactionDirectory)) },
  );
}

/**
 * Asserts that the AI client's bridge document is still the one this attempt
 * authored, for this companion.
 *
 * The question is identity, not bytes. The Mod owns the document's serialization
 * (`PersistVerifiedFarmhandScope` -> `Helper.WriteConfig`) and rewrites it whole from
 * its own config class the moment its client reaches the world, which is exactly
 * when this Host connects - so a byte comparison refuses a binding that is intact,
 * and does it permanently, because those two documents can never agree again. What
 * a replaced profile or a swapped document actually moves is the pipe it points at,
 * the token that authenticates it, the save/world/farmhand/companion it claims, and
 * the provisioning manifest it reads; those are the fields compared here.
 *
 * A document that is unreadable, or that carries a duplicate key, is refused rather
 * than half-read: the reader decides that, so a live write can never be mistaken
 * for a matching identity.
 */
async function assertAiClientBridgeConfigIdentity(
  configPath: string,
  transactionDirectory: string,
  identity: StardewPrivateAiClientBridgeConfigIdentity,
): Promise<void> {
  await verifySafePathBoundary(configPath, transactionDirectory);
  let document: unknown;
  try {
    document = await readStrictJsonFile(configPath);
  } catch (error) {
    // A missing document is not this refusal: the caller's own existence question
    // owns that answer, exactly as it did before the document was read this way.
    if (isNodeError(error) && error.code === "ENOENT") throw error;
    throw new Error("stardew_ai_client_bridge_config_mismatch", { cause: error });
  }
  if (!isAiClientBridgeConfigDocument(document, identity)) throw new Error("stardew_ai_client_bridge_config_mismatch");
}

function isAiClientBridgeConfigDocument(
  document: unknown,
  identity: StardewPrivateAiClientBridgeConfigIdentity,
): boolean {
  if (!isRecord(document)) return false;
  const provisioner = document.FarmhandProvisioner;
  return (
    document.EnableLocalBridge === true &&
    document.PipeName === identity.pipeName &&
    document.BridgeToken === identity.bridgeToken &&
    document.SaveId === identity.saveId &&
    document.WorldId === identity.worldId &&
    document.PlayerId === identity.playerId &&
    document.CompanionId === identity.companionId &&
    isRecord(provisioner) &&
    provisioner.Enable === true &&
    provisioner.ManifestPath === identity.manifestPath &&
    provisioner.SessionToken === identity.sessionToken &&
    provisioner.IntegrationVersion === identity.integrationVersion
  );
}

function readClockForMaterialization(
  facts: OwnedPlayerHostBootstrapFacts,
  _admission: ManifestHandoffAdmissionFacts,
  dependencies: PrivateModProfileStagingDependencies,
): number {
  return Math.max(facts.readClock(), dependencies.nowMs());
}

async function assertC1ExistingInventory(transactionDirectory: string, root: string): Promise<void> {
  const entries = await readSafeDirectory(transactionDirectory, root);
  const allowed = new Set([OWNER_FILE, OWNER_LOCK_LEAF, HOST_PROFILE_ROOT, "session"]);
  if (entries.some((entry) => !allowed.has(entry)))
    throw new Error("stardew_ai_client_profile_materialization_inventory_invalid");

  const hostProfile = join(transactionDirectory, HOST_PROFILE_ROOT);
  const hostMods = join(hostProfile, MODS_DIRECTORY);
  const hostMod = join(hostMods, MOD_DIRECTORY);
  if (
    JSON.stringify(await readSafeDirectory(hostProfile, root)) !== JSON.stringify([MODS_DIRECTORY]) ||
    !(await readProfileModsEntries(hostMods, root)).includes(MOD_DIRECTORY)
  ) {
    throw new Error("stardew_ai_client_profile_materialization_inventory_invalid");
  }
  const expectedFiles = [MOD_CONFIG_FILE, ...PHASE_B_PACKAGE_ENTRIES].sort();
  const actualFiles = [...(await readSafeDirectory(hostMod, root))].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
    throw new Error("stardew_ai_client_profile_materialization_inventory_invalid");
  if (entries.includes("session")) await readSafeDirectory(join(transactionDirectory, "session"), root);
}

async function assertMaterializedC1Inventory(transactionDirectory: string, root: string): Promise<void> {
  const entries = [...(await readSafeDirectory(transactionDirectory, root))].sort();
  const expectedEntries = [AI_CLIENT_PROFILE_ROOT, HOST_PROFILE_ROOT, OWNER_FILE, "session"].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries))
    throw new Error("stardew_ai_client_profile_inventory_invalid");

  for (const profileRoot of [HOST_PROFILE_ROOT, AI_CLIENT_PROFILE_ROOT]) {
    const profile = join(transactionDirectory, profileRoot);
    const mods = join(profile, MODS_DIRECTORY);
    const mod = join(mods, MOD_DIRECTORY);
    if (
      JSON.stringify(await readSafeDirectory(profile, root)) !== JSON.stringify([MODS_DIRECTORY]) ||
      !(await readProfileModsEntries(mods, root)).includes(MOD_DIRECTORY)
    ) {
      throw new Error("stardew_ai_client_profile_inventory_invalid");
    }
    const expectedFiles = [MOD_CONFIG_FILE, ...PHASE_B_PACKAGE_ENTRIES].sort();
    const actualFiles = [...(await readSafeDirectory(mod, root))].sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
      throw new Error("stardew_ai_client_profile_inventory_invalid");
  }
  await readSafeDirectory(join(transactionDirectory, "session"), root);
}

async function assertManifestCorrelationStillHeld(
  material: StardewPrivateBootstrapMaterial,
  admission: ManifestHandoffAdmissionFacts,
): Promise<void> {
  const manifestPath = join(material.sessionDirectory, "stardew-farmhand-manifest.json");
  if (
    resolve(material.sessionDirectory) !== resolve(dirname(manifestPath)) ||
    admission.manifest.requestId !== admission.requestId ||
    admission.manifest.companionId !== material.companionId ||
    admission.manifest.integrationVersion !== material.integrationVersion
  ) {
    throw new Error("stardew_ai_client_profile_materialization_correlation_invalid");
  }
  // The signed manifest was already verified by the composition-owned
  // attachment flow before it minted this opaque admission. This consumer
  // verifies only the retained correlation and safe pathname; it deliberately
  // never re-reads or copies the manifest, avoiding a second verifier path.
  await verifySafePathBoundary(manifestPath);
}

async function assertAiClientDestinationAbsent(transactionDirectory: string, root: string): Promise<void> {
  const destination = join(transactionDirectory, AI_CLIENT_PROFILE_ROOT);
  await verifySafePathBoundary(destination, root);
  try {
    await lstat(destination);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("stardew_ai_client_profile_materialization_occupied");
}

/**
 * The player's own `Mods` entries, carried into this attempt's SMAPI profile root.
 *
 * A directory is carried by a junction and a file by a hard link, so neither
 * duplicates the player's bytes; a link the filesystem refuses (another volume, a
 * target that will not take one) falls back to a copy and names the refusal in
 * `linkRefusals` instead of hiding it. Only the staged Mod is skipped - it is
 * this attempt's own, written at staging with the session-scoped config, and the
 * player's copy of it must never replace it.
 */
async function carryPlayerModsIntoProfileRoot(
  gameRoot: string,
  profileModsRoot: string,
  transactionDirectory: string,
): Promise<StardewPlayerHostModsRoot> {
  const playerModsRoot = join(gameRoot, MODS_DIRECTORY);
  let names: readonly string[];
  try {
    names = await readdir(playerModsRoot);
  } catch (error) {
    // A loader that has never run has no `Mods` folder; the player has nothing to
    // fix there, so this is the named empty state rather than a failure.
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return Object.freeze({ kind: "empty" as const, reason: "player_mods_root_absent" as const });
    throw new Error(`mods_root_target_missing:${isNodeError(error) ? (error.code ?? "unknown") : "unknown"}`, {
      cause: error,
    });
  }
  const entries: string[] = [];
  const linkRefusals: string[] = [];
  for (const name of [...names].sort()) {
    if (name === MOD_DIRECTORY) continue;
    const source = join(playerModsRoot, name);
    const destination = join(profileModsRoot, name);
    await verifySafePathBoundary(destination, transactionDirectory);
    let sourceState: Awaited<ReturnType<typeof lstat>>;
    try {
      sourceState = await lstat(source);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT")
        throw new Error(`mods_root_target_missing:${name}`, { cause: error });
      throw error;
    }
    const refusal = sourceState.isDirectory()
      ? await refusedLink(() => symlink(source, destination, "junction"))
      : sourceState.isFile()
        ? await refusedLink(() => link(source, destination))
        : "not_a_regular_entry";
    if (refusal === undefined) {
      entries.push(name);
      continue;
    }
    await copyPlayerMod(source, destination, name);
    if (refusal !== "not_a_regular_entry") linkRefusals.push(`mods_root_link_refused:${refusal}`);
    entries.push(name);
  }
  // The staged Mod is this attempt's whole reason for the isolated root: a root
  // that lost it would start a game with none of GameBuddy's own Mod either.
  if (!(await readProfileModsEntries(profileModsRoot, transactionDirectory)).includes(MOD_DIRECTORY))
    throw new Error("stardew_player_host_mods_root_staged_mod_missing");
  if (entries.length === 0)
    return Object.freeze({ kind: "empty" as const, reason: "player_mods_root_holds_only_staged_mod" as const });
  return Object.freeze({
    kind: "carried" as const,
    entries: Object.freeze(entries),
    linkRefusals: Object.freeze(linkRefusals),
  });
}

/** The errno of a refused link, or `undefined` when the link was made. */
async function refusedLink(carry: () => Promise<void>): Promise<string | undefined> {
  try {
    await carry();
    return undefined;
  } catch (error) {
    return isNodeError(error) ? (error.code ?? "unknown") : "unknown";
  }
}

/** Copies one entry, dereferencing so the profile root never inherits the player's own links. */
async function copyPlayerMod(source: string, destination: string, name: string): Promise<void> {
  try {
    await cp(source, destination, { recursive: true, dereference: true, errorOnExist: true, force: false });
  } catch (error) {
    throw new Error(`mods_root_copy_failed:${name}`, { cause: error });
  }
}

/**
 * The profile root's entries, read without following a single link.
 *
 * `readSafeDirectory` refuses a directory holding any link child, which is right
 * for every artifact this attempt wrote itself - and wrong for the one directory
 * it deliberately fills with links into the player's own `Mods`. Those links are
 * named here and never resolved, so the inventory still proves what staging put
 * there without ever walking outside the attempt.
 *
 * The root itself is proven through the staged Mod's config leaf rather than by
 * `verifySafePathBoundary(profileModsRoot)`, which accepts only a regular-file
 * leaf: the ancestors of that leaf are exactly the directory chain this has to
 * stand on, and an absent leaf still verifies every one of them.
 */
async function readProfileModsEntries(profileModsRoot: string, root: string): Promise<readonly string[]> {
  await verifySafePathBoundary(join(profileModsRoot, MOD_DIRECTORY, MOD_CONFIG_FILE), root);
  const entries = await readdir(profileModsRoot);
  for (const entry of entries) {
    const entryPath = resolve(profileModsRoot, entry);
    const state = await lstat(entryPath);
    if (!state.isDirectory() && !state.isFile() && !state.isSymbolicLink()) throw new Error("unsafe_path_boundary");
  }
  return Object.freeze(entries);
}

async function stagePlayerHostModProfile(
  owner: StardewOwnedPlayerHostBootstrap,
  packageSource: Readonly<{ root: string; entries: readonly string[] }>,
  dependencies: PrivateModProfileStagingDependencies,
  companionDisplayName: string | undefined,
): Promise<StardewPrivateBootstrapMaterial> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner);
  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const ownerPath = join(transactionDirectory, OWNER_FILE);
  const managed = new Map<string, import("../../../path-lock.js").SafeFileIdentity>();
  const createdDirectories: string[] = [];
  let recordExtended = false;
  return withPathLock(
    ownerPath,
    async () => {
      try {
        const current = await readAndValidateOwner(ownerPath, dirname(dirname(transactionDirectory)));
        if (
          current.bootstrapId !== facts.durableOwner.record.bootstrapId ||
          current.state !== "reserved" ||
          current.expiresAtMs <= dependencies.nowMs() ||
          JSON.stringify(current.managedPaths) !== JSON.stringify([OWNER_FILE])
        ) {
          throw new Error("stardew_private_mod_profile_staging_owner_invalid");
        }
        await assertStagingDestinationEmpty(transactionDirectory, dirname(dirname(transactionDirectory)));
        const next = freezeRecord({ ...current, managedPaths: [...PHASE_B_MANAGED_PATHS] });
        await atomicWriteFile(ownerPath, `${JSON.stringify(next)}\n`, dirname(dirname(transactionDirectory)));
        facts.durableOwner.replaceRecord(next);
        recordExtended = true;

        const sessionSecret = dependencies.createSecret();
        if (!isProvisioningSecret(sessionSecret)) {
          throw new Error("stardew_private_mod_profile_staging_material_invalid");
        }
        const sessionDirectory = join(transactionDirectory, "session");
        const hostModDirectory = join(transactionDirectory, HOST_PROFILE_ROOT, MODS_DIRECTORY, MOD_DIRECTORY);
        for (const directory of [
          join(transactionDirectory, HOST_PROFILE_ROOT),
          join(transactionDirectory, HOST_PROFILE_ROOT, MODS_DIRECTORY),
          hostModDirectory,
        ]) {
          await verifySafePathBoundary(directory, transactionDirectory);
          await mkdir(directory);
          createdDirectories.push(directory);
        }
        // The player's own companion language, in the SECOND document the Mod reads.
        //
        // The AI-client profile above presents the companion's text from this value. This profile is
        // the world's, and here the same value decides something else: Stardew applies
        // startup_preferences.languageCode ASYNCHRONOUSLY, from the title-menu update, so the formal
        // world entry must not drive the native new-game entry until the live game locale is this
        // language (WorldCreationBootstrap.HoldsForLiveLocale). Measured 2026-11-16: without it the
        // Player Host entered its world one second after the main menu and stayed English for the
        // whole session, around a zh-CN product. Absent - exactly as in the AI-client document -
        // when the player never chose a language, because its absence is what tells the Mod that the
        // live game locale is the authority.
        const presentationLocale = await readStardewModPresentationLocale(dirname(dirname(transactionDirectory)));
        const hostConfig = JSON.stringify({
          ...(presentationLocale === undefined ? {} : { PresentationLocale: presentationLocale }),
          HostFarmhandProvisioning: {
            Enable: true,
            SessionDirectory: sessionDirectory,
            SessionToken: sessionSecret,
            IntegrationVersion: INTEGRATION_VERSION,
            ManifestLifetimeSeconds: MANIFEST_LIFETIME_SECONDS,
            AuthorizedCompanionIds: [facts.durableOwner.record.companionId],
            // Her name in the world is her name. The Mod rejects anything that is not a usable Farmer name, so a card whose
            // name the game cannot carry falls back rather than failing the whole staging - the character still arrives, under
            // the name the Mod defaults to, and the surface says the name is fixed at creation.
            ...(isUsableFarmhandName(companionDisplayName) ? { FarmhandName: companionDisplayName } : {}),
          },
          // Creation is requested, never named: the Mod creates one world from
          // this form and publishes the physical slot basename it observed, which
          // stays the single world-identity authority. This file therefore carries
          // no save/slot identity, only the one-shot creation request.
          WorldCreation: {
            Enable: true,
            FarmName: WORLD_CREATION_FARM_NAME,
            PlayerName: WORLD_CREATION_PLAYER_NAME,
            FavoriteThing: WORLD_CREATION_FAVORITE_THING,
            CreateOnce: true,
          },
        });
        await writeManagedFile(join(hostModDirectory, MOD_CONFIG_FILE), hostConfig, transactionDirectory, managed);
        for (const entry of packageSource.entries) {
          const content = await readFile(join(packageSource.root, entry));
          if (content.length === 0) throw new Error("stardew_private_mod_profile_staging_package_invalid");
          await writeManagedFile(join(hostModDirectory, entry), content, transactionDirectory, managed);
        }
        const rereadPackage = await dependencies.readPackage();
        validatePackageSource(rereadPackage);
        if (
          rereadPackage.root !== packageSource.root ||
          JSON.stringify(rereadPackage.entries) !== JSON.stringify(packageSource.entries)
        ) {
          throw new Error("stardew_private_mod_profile_staging_package_changed");
        }
        if (facts.expiresAtMs <= dependencies.nowMs()) throw new Error("stardew_private_mod_profile_staging_expired");
        return Object.freeze({
          sessionDirectory,
          sessionToken: sessionSecret,
          integrationVersion: INTEGRATION_VERSION,
          companionId: facts.durableOwner.record.companionId,
        });
      } catch (error) {
        if (recordExtended) await rollbackStagedPlayerHostProfile(managed, createdDirectories, transactionDirectory);
        throw error;
      }
    },
    { containmentRoot: dirname(dirname(transactionDirectory)) },
  );
}

async function assertStagingDestinationEmpty(transactionDirectory: string, root: string): Promise<void> {
  const entries = await readSafeDirectory(transactionDirectory, root);
  const allowed = new Set([OWNER_FILE, OWNER_LOCK_LEAF]);
  if (entries.some((entry) => !allowed.has(entry))) throw new Error("stardew_private_mod_profile_staging_occupied");
}

async function writeManagedFile(
  path: string,
  content: string | Uint8Array,
  transactionDirectory: string,
  managed: Map<string, import("../../../path-lock.js").SafeFileIdentity>,
): Promise<void> {
  await verifySafePathBoundary(path, transactionDirectory);
  await writeFile(path, content, { encoding: typeof content === "string" ? "utf8" : undefined, flag: "wx" });
  const reread = await readFile(path);
  const expected = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (!reread.equals(expected)) throw new Error("stardew_private_mod_profile_staging_config_reread_failed");
  const identity = await captureSafeFileIdentity(path, transactionDirectory);
  if (identity === undefined) throw new Error("stardew_private_mod_profile_staging_write_unproven");
  managed.set(path, identity);
}

async function rollbackStagedPlayerHostProfile(
  managed: ReadonlyMap<string, import("../../../path-lock.js").SafeFileIdentity>,
  createdDirectories: readonly string[],
  transactionDirectory: string,
): Promise<void> {
  let failed = false;
  for (const [path, identity] of [...managed.entries()].reverse()) {
    try {
      await removeOwnedSafeFile(path, identity, transactionDirectory);
    } catch {
      failed = true;
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      await readSafeDirectory(directory, transactionDirectory);
      await rmdir(directory);
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST"))
        continue;
      failed = true;
    }
  }
  if (failed) throw new Error("stardew_private_mod_profile_staging_rollback_uncertain");
}

function validatePackageSource(
  value: unknown,
): asserts value is Readonly<{ root: string; entries: readonly string[] }> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["root", "entries"]) ||
    typeof value.root !== "string" ||
    !isAbsolute(value.root) ||
    !Array.isArray(value.entries) ||
    JSON.stringify(value.entries) !== JSON.stringify(PHASE_B_PACKAGE_ENTRIES)
  ) {
    throw new Error("stardew_private_mod_profile_staging_package_invalid");
  }
}

function createPrivateBridgePipeName(): string {
  return `gamebuddy-stardew-${randomUUID()}`;
}

function createPrivateBridgeToken(): string {
  return `${randomUUID()}${randomUUID()}`;
}

function isBridgePipeName(value: string): boolean {
  return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isBridgeToken(value: string): boolean {
  return value.length >= 16 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isProvisioningSecret(value: string): boolean {
  return value.length >= 16 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
}

function composeOwnedPlayerHostOwner(
  durableOwner: DurableOwner &
    Readonly<{
      record: StardewOwnedPlayerHostBootstrapOwnerRecord;
    }>,
  playerHostRegistration: StardewPlayerHostLaunchRegistration,
  aiClientRegistration: StardewAiClientLaunchRegistration,
  expiresAtMs: number,
  readClock: () => number,
  compositionIdentity: object,
): StardewOwnedPlayerHostBootstrap {
  let playerHostLaunchState: LaunchState = "available";
  let aiClientLaunchState: LaunchState = "available";
  let quarantineStarted = false;
  let quarantinePromise: Promise<void> | null = null;
  // Per-activation registration holder: each fresh activation replaces the
  // exact AI-client registration (fresh reservation/launch generation). The
  // launch/revoke closures and the facts surface always observe the CURRENT
  // registration, never the initial-activation one.
  const aiClientRegistrationHolder: { registration: StardewAiClientLaunchRegistration } = {
    registration: aiClientRegistration,
  };

  const revokePlayerHostLaunch = (): void => {
    if (playerHostLaunchState === "revoked") return;
    playerHostLaunchState = "revoked";
    playerHostRegistration.revoke();
  };
  const revokeAiClientLaunch = (): void => {
    if (aiClientLaunchState === "revoked") return;
    aiClientLaunchState = "revoked";
    aiClientRegistrationHolder.registration.revoke();
  };

  const consumeLaunch = <TLaunchInput, TLaunchResult, T>(
    input: Readonly<{
      role: "player_host" | "ai_client";
      callback: (launch: (launchInput: TLaunchInput) => TLaunchResult) => T;
      getState: () => LaunchState;
      setState: (state: LaunchState) => void;
      launch: (launchInput: TLaunchInput) => TLaunchResult;
      revoke: () => void;
    }>,
  ): T => {
    if (input.getState() !== "available") throw new Error(`stardew_${input.role}_launch_not_available`);
    if (typeof input.callback !== "function") throw new TypeError(`invalid_stardew_${input.role}_launch_callback`);

    input.setState("binding");
    if (expiresAtMs <= readClock()) {
      try {
        input.revoke();
      } catch {
        /* expiry remains primary */
      }
      throw new Error("stardew_bootstrap_owner_expired");
    }

    let callbackActive = true;
    let launchCalled = false;
    const launch = (launchInput: TLaunchInput): TLaunchResult => {
      if (!callbackActive || launchCalled || quarantineStarted)
        throw new Error(`stardew_${input.role}_launch_callback_not_active`);
      if (expiresAtMs <= readClock()) {
        try {
          input.revoke();
        } catch {
          /* expiry remains primary */
        }
        throw new Error("stardew_bootstrap_owner_expired");
      }
      launchCalled = true;
      return input.launch(launchInput);
    };

    try {
      return input.callback(launch);
    } finally {
      callbackActive = false;
      if (!quarantineStarted && !launchCalled) input.revoke();
      else if (!quarantineStarted) input.setState("consumed");
    }
  };

  const owner = Object.freeze({}) as StardewOwnedPlayerHostBootstrap;
  const bindingState: { value: OwnedPlayerHostBootstrapBindingState } = { value: "unbound" };
  const playerHostProfileStagingState: { value: OwnedPlayerHostProfileStagingState } = { value: "not_staged" };
  const aiClientProfileState: OwnedPlayerHostBootstrapFacts["aiClientProfileState"] = { value: "not_materialized" };
  const facts: OwnedPlayerHostBootstrapFacts = {
    compositionIdentity,
    immutableFence: immutableFenceFor(durableOwner.record),
    durableOwner,
    playerHostRegistration,
    get aiClientRegistration() {
      return aiClientRegistrationHolder.registration;
    },
    set aiClientRegistration(value: StardewAiClientLaunchRegistration) {
      aiClientRegistrationHolder.registration = value;
    },
    expiresAtMs,
    readClock,
    launchStates: {
      get playerHost() {
        return playerHostLaunchState;
      },
      set playerHost(value: LaunchState) {
        playerHostLaunchState = value;
      },
      get aiClient() {
        return aiClientLaunchState;
      },
      set aiClient(value: LaunchState) {
        aiClientLaunchState = value;
      },
    },
    quarantine: {
      get started() {
        return quarantineStarted;
      },
      set started(value: boolean) {
        quarantineStarted = value;
      },
      get promise() {
        return quarantinePromise;
      },
      set promise(value: Promise<void> | null) {
        quarantinePromise = value;
      },
    },
    bindingState,
    playerHostProfileStagingState,
    aiClientProfileState,
    bridgeConnectionState: { value: "unavailable" },
    privateMaterial: { value: null },
    privateBridgeMaterial: { value: null },
    consumePlayerHostLaunch: (callback) =>
      consumeLaunch({
        role: "player_host",
        callback,
        getState: () => playerHostLaunchState,
        setState: (state) => {
          playerHostLaunchState = state;
        },
        launch: (launchInput) => playerHostRegistration.launch(launchInput),
        revoke: revokePlayerHostLaunch,
      }),
    // Contained variant: claiming the launch creates no raw child and ends the reservation exactly
    // as the direct one does, so the attempt's one-shot authority is spent either way. The process
    // is the platform session's; the ending comes back through `notePlayerHostEnded`.
    consumePlayerHostLaunchContained: (callback) =>
      consumeLaunch({
        role: "player_host",
        callback,
        getState: () => playerHostLaunchState,
        setState: (state) => {
          playerHostLaunchState = state;
        },
        launch: () => playerHostRegistration.containedLaunch(),
        revoke: revokePlayerHostLaunch,
      }),
    consumeAiClientLaunch: (callback) =>
      consumeLaunch({
        role: "ai_client",
        callback,
        getState: () => aiClientLaunchState,
        setState: (state) => {
          aiClientLaunchState = state;
        },
        launch: (launchInput) => aiClientRegistrationHolder.registration.launch(launchInput),
        revoke: revokeAiClientLaunch,
      }),
    // Contained variant: committing the claim marks the process owner awaiting
    // attestation without a raw child; the Guardian kill-on-close Job owns the
    // native termination at platform close.
    consumeAiClientLaunchContained: (callback) =>
      consumeLaunch({
        role: "ai_client",
        callback,
        getState: () => aiClientLaunchState,
        setState: (state) => {
          aiClientLaunchState = state;
        },
        launch: () => aiClientRegistrationHolder.registration.containedLaunch(),
        revoke: revokeAiClientLaunch,
      }),
    quarantineOwner: () => {
      if (quarantinePromise !== null) return quarantinePromise;
      quarantineStarted = true;
      // The session material is deliberately NOT cleared here. Its `sessionToken` authenticates a READ of
      // the Mod's own document (`readCabinOccupancy`), never a write: the one probe that can tell "this save
      // does not hold her" from a forged claim needs it, and a forged `not_bound` is precisely the second
      // signed manifest a cabin quarantine exists to prevent. Keeping it costs one HMAC secret in Host memory
      // for an attempt whose record is still on disk - a secret this Host already wrote to the AI client's
      // config at materialisation - and it is dropped where the attempt is forgotten
      // (`forgetOwnedPlayerHostMaterial`). The BRIDGE material below is a write authority and goes now.
      facts.privateBridgeMaterial.value = null;
      facts.bridgeConnectionState.value = "consumed";
      if (playerHostLaunchState === "available") playerHostLaunchState = "binding";
      if (aiClientLaunchState === "available") aiClientLaunchState = "binding";
      const persistence = durableOwner.quarantine();
      quarantinePromise = persistence.then(
        () => {
          let firstError: unknown;
          try {
            revokePlayerHostLaunch();
          } catch (error) {
            firstError = error;
          }
          try {
            revokeAiClientLaunch();
          } catch (error) {
            firstError ??= error;
          }
          if (firstError !== undefined) throw firstError;
        },
        (persistenceError: unknown) => {
          // Persistence uncertainty never reopens this exact owner. Clear
          // only the in-flight wrapper so the same owner can retry durable
          // quarantine after the persistence failure is repaired.
          quarantinePromise = null;
          try {
            revokePlayerHostLaunch();
          } catch {
            /* persistence remains primary */
          }
          try {
            revokeAiClientLaunch();
          } catch {
            /* persistence remains primary */
          }
          throw persistenceError;
        },
      );
      return quarantinePromise;
    },
  };
  ownedPlayerHostBootstrapFacts.set(owner, facts);
  return owner;
}

function composeExternalPlayerHostOwner(
  durableOwner: DurableOwner &
    Readonly<{
      record: StardewExternalPlayerHostPhaseAOwnerOwnerRecord;
    }>,
  registration: StardewAiClientLaunchRegistration,
  expiresAtMs: number,
  readClock: () => number,
): StardewExternalPlayerHostPhaseAOwner {
  let launchState: LaunchState = "available";
  let quarantineStarted = false;
  let quarantinePromise: Promise<void> | null = null;

  const revokeLaunch = (): void => {
    if (launchState === "revoked") return;
    // Mark permanently revoked before invoking the hook so a throwing hook
    // cannot make the exact launch authority appear reusable. Quarantine must
    // also call the exact registration's idempotent revoke after prior consume.
    launchState = "revoked";
    registration.revoke();
  };

  // Keep the record, transaction directory, and Guardian binding exclusively
  // in this closure. The public external owner is an operation capability.
  return Object.freeze({
    consumeAiClientLaunch<T>(callback: (launch: StardewAiClientLaunch) => T): T {
      if (launchState !== "available") throw new Error("stardew_ai_client_launch_not_available");
      if (typeof callback !== "function") throw new TypeError("invalid_stardew_ai_client_launch_callback");

      // Synchronously consume owner state and fresh-check the absolute expiry
      // before the manager registration can launch a child.
      launchState = "binding";
      if (expiresAtMs <= readClock()) {
        try {
          revokeLaunch();
        } catch {
          /* expiry remains primary */
        }
        throw new Error("stardew_bootstrap_owner_expired");
      }

      let callbackActive = true;
      let launchCalled = false;
      const launch: StardewAiClientLaunch = (input) => {
        if (!callbackActive || launchCalled || quarantineStarted)
          throw new Error("stardew_ai_client_launch_callback_not_active");
        if (expiresAtMs <= readClock()) {
          try {
            revokeLaunch();
          } catch {
            /* expiry remains primary */
          }
          throw new Error("stardew_bootstrap_owner_expired");
        }
        launchCalled = true;
        return registration.launch(input);
      };

      try {
        return callback(launch);
      } finally {
        callbackActive = false;
        if (!quarantineStarted && !launchCalled) revokeLaunch();
        else if (!quarantineStarted) launchState = "consumed";
      }
    },
    quarantine(): Promise<void> {
      if (quarantinePromise !== null) return quarantinePromise;

      // Move launch authority out of available synchronously, before the first
      // persistence await. The same promise makes all calls idempotent.
      quarantineStarted = true;
      if (launchState === "available") launchState = "binding";
      quarantinePromise = durableOwner.quarantine().then(
        () => {
          revokeLaunch();
        },
        (persistenceError: unknown) => {
          // Permanent exact-registration revocation follows persistence. Never
          // let revoke failure replace the primary persistence error.
          try {
            revokeLaunch();
          } catch {
            /* persistence remains primary */
          }
          throw persistenceError;
        },
      );
      return quarantinePromise;
    },
  }) as StardewExternalPlayerHostPhaseAOwner;
}

type ActiveBootstrap = {
  bootstrapId: string;
  playerId: string;
  companionId: string;
  browserSessionId: string;
  expiresAtMs: number;
  state: "pending" | "consumed" | "revoked";
};

function createPlayerHostBootstrapBroker(
  registerConsumedClaim: (claim: StardewPlayerHostBootstrapClaim, facts: StardewPrivateBootstrapFacts) => void,
  mintIdentity: () => string,
  readClock: () => number,
): StardewPlayerHostBootstrapBroker {
  let active: ActiveBootstrap | null = null;
  let closed = false;
  const expired = (record: ActiveBootstrap): boolean => readClock() >= record.expiresAtMs;

  return Object.freeze({
    confirm(request: StardewPlayerHostBootstrapRequest): StardewPlayerHostBootstrapCapability {
      if (closed) throw new Error("stardew_bootstrap_broker_closed");
      const nowMs = readClock();
      validateBootstrapRequest(request, nowMs);
      if (active !== null && active.state === "pending" && !expired(active))
        throw new Error("stardew_bootstrap_already_active");

      const bootstrapId = mintIdentity();
      if (!isOpaque(bootstrapId)) throw new Error("stardew_bootstrap_identity_invalid");
      const record: ActiveBootstrap = {
        bootstrapId,
        playerId: request.playerId,
        companionId: request.companionId,
        browserSessionId: request.browserSessionId,
        expiresAtMs: request.expiresAtMs,
        state: "pending",
      };
      active = record;
      return Object.freeze({
        readView(): StardewPlayerHostBootstrapView {
          return Object.freeze({
            schemaVersion: 1 as const,
            state: record.state === "pending" && expired(record) ? ("expired" as const) : record.state,
          });
        },
        consume(browserSessionId: string): StardewPlayerHostBootstrapClaim {
          if (record.state !== "pending") throw new Error("stardew_bootstrap_not_pending");
          if (expired(record)) throw new Error("stardew_bootstrap_expired");
          if (!isOpaque(browserSessionId) || browserSessionId !== record.browserSessionId)
            throw new Error("stardew_bootstrap_session_mismatch");
          record.state = "consumed";
          const claim = Object.freeze({}) as StardewPlayerHostBootstrapClaim;
          try {
            registerConsumedClaim(claim, {
              bootstrapId: record.bootstrapId,
              playerId: record.playerId,
              companionId: record.companionId,
              expiresAtMs: record.expiresAtMs,
            });
          } catch {
            record.state = "revoked";
            throw new Error("stardew_bootstrap_claim_registration_failed");
          }
          return claim;
        },
        revoke(): void {
          if (record.state === "pending") record.state = "revoked";
        },
      });
    },
    close(): void {
      closed = true;
      if (active?.state === "pending") active.state = "revoked";
    },
  });
}

type OwnedAiClient = {
  readonly kill: () => boolean;
  readonly pid: number;
  readonly creationDate: string;
};

type OwnedProcessState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "awaiting_ai_client_attestation";
      readonly owned: OwnedAiClient;
      readonly launchGeneration: string;
    }
  | {
      // Contained launch: the native process is owned by the authenticated
      // platform session, so no pid/kill handle exists on the Host side. The
      // kill-on-close Guardian Job terminates it at platform close; stop is a
      // success no-op (already_stopped).
      readonly kind: "awaiting_ai_client_attestation";
      readonly owned: null;
      readonly launchGeneration: string;
    }
  | { readonly kind: "ai_client_stopped" };

type OwnedPlayerHost = {
  readonly kill: () => boolean;
  readonly pid: number;
  readonly creationDate: string;
};

type OwnedPlayerHostProcessState =
  | { readonly kind: "idle" }
  // `owned` is the Host's own child, or null for a CONTAINED launch, where the platform session and
  // the Guardian's player Job own the process and this Host never holds a pid for it.
  | { readonly kind: "awaiting_player_host_attestation"; readonly owned: OwnedPlayerHost | null }
  | { readonly kind: "player_host_stopped" };

function createPlayerHostProcessOwner(
  rawSpawn: StardewPlayerHostProcessSpawn,
  rawProbe: StardewPlayerHostProcessProbe,
  createLaunchGeneration: () => string,
  registerPlayerHostLaunch: (
    reservation: StardewPlayerHostLaunchReservation,
    registration: StardewPlayerHostLaunchRegistration,
  ) => void,
): StardewPlayerHostProcessOwner {
  let state: OwnedPlayerHostProcessState = { kind: "idle" };
  let reservation: Readonly<{
    capability: StardewPlayerHostLaunchReservation;
    launchGeneration: string;
  }> | null = null;

  function launchWithGeneration(
    input: LaunchPlayerHostInput,
    launchGeneration: string,
  ): Readonly<{ status: StardewPlayerHostProcessStatus }> {
    if (state.kind === "awaiting_player_host_attestation") throw new Error("owned_player_host_already_active");
    validatePlayerHostLaunchInput(input);

    const spawned = rawSpawn(input.executable, [...input.args], {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      shell: false,
      windowsHide: true,
      env: createStardewChildEnvironment(launchGeneration),
    });
    const pid = spawned.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      try {
        spawned.kill();
      } catch {
        /* launch failure remains primary */
      }
      throw new Error("spawned_player_host_child_missing_valid_pid");
    }

    let probeResult: StardewPlayerHostProcessProbeResult;
    try {
      probeResult = rawProbe(pid);
    } catch {
      try {
        spawned.kill();
      } catch {
        /* launch failure remains primary */
      }
      throw new Error("player_host_probe_failed_no_process");
    }
    if (probeResult === null) {
      try {
        spawned.kill();
      } catch {
        /* launch failure remains primary */
      }
      throw new Error("player_host_probe_failed_no_process");
    }
    if (probeResult.pid !== pid) {
      try {
        spawned.kill();
      } catch {
        /* launch failure remains primary */
      }
      throw new Error("player_host_probe_pid_mismatch");
    }
    if (typeof probeResult.creationDate !== "string" || probeResult.creationDate.length === 0) {
      try {
        spawned.kill();
      } catch {
        /* launch failure remains primary */
      }
      throw new Error("player_host_probe_invalid_creation_identity");
    }

    state = {
      kind: "awaiting_player_host_attestation",
      owned: {
        kill: () => spawned.kill(),
        pid,
        creationDate: probeResult.creationDate,
      },
    };
    return Object.freeze({
      status: { kind: "awaiting_player_host_attestation" } as const,
    });
  }

  return Object.freeze({
    readStatus(): StardewPlayerHostProcessStatus {
      if (reservation !== null) return { kind: "player_host_launch_pending" };
      return { kind: state.kind };
    },
    reservePlayerHostLaunch(): StardewPlayerHostLaunchReservation {
      if (reservation !== null || state.kind === "awaiting_player_host_attestation")
        throw new Error("owned_player_host_launch_already_active");
      const launchGeneration = createLaunchGeneration();
      if (!isOpaque(launchGeneration)) throw new Error("invalid_player_host_launch_generation");

      const capability = Object.freeze({}) as StardewPlayerHostLaunchReservation;
      reservation = Object.freeze({ capability, launchGeneration });
      let consumed = false;
      const registration: StardewPlayerHostLaunchRegistration = Object.freeze({
        launchGeneration,
        launch(input) {
          if (consumed || reservation?.capability !== capability)
            throw new Error("player_host_launch_reservation_not_active");
          consumed = true;
          reservation = null;
          return launchWithGeneration(input, launchGeneration);
        },
        containedLaunch() {
          if (consumed || reservation?.capability !== capability)
            throw new Error("player_host_launch_reservation_not_active");
          consumed = true;
          reservation = null;
          if (state.kind === "awaiting_player_host_attestation") throw new Error("owned_player_host_already_active");
          state = { kind: "awaiting_player_host_attestation", owned: null };
          return Object.freeze({
            status: { kind: "awaiting_player_host_attestation" as const },
          });
        },
        revoke() {
          if (!consumed && reservation?.capability === capability) reservation = null;
          consumed = true;
        },
      });

      try {
        registerPlayerHostLaunch(capability, registration);
      } catch (error) {
        registration.revoke();
        throw error;
      }
      return capability;
    },
    stopOwnedPlayerHost(): StopOwnedPlayerHostResult {
      if (state.kind === "idle") return { kind: "no_owned_player_host", killed: false };
      if (state.kind === "player_host_stopped") return { kind: "already_stopped", killed: false };
      // A contained launch owns no process here: the player's world belongs to its Guardian Job, and
      // this Host has neither a pid nor a handle to end. `contain_role` - the explicit endgame's own
      // authenticated operation - is the only thing that reaches it (ADR-0007).
      if (state.owned === null) return { kind: "no_owned_player_host", killed: false };

      const { owned } = state;
      let probeResult: StardewPlayerHostProcessProbeResult;
      try {
        probeResult = rawProbe(owned.pid);
      } catch {
        return { kind: "identity_probe_failed", killed: false };
      }
      if (probeResult === null) return { kind: "identity_probe_failed", killed: false };
      if (probeResult.pid !== owned.pid || probeResult.creationDate !== owned.creationDate)
        return { kind: "identity_mismatch", killed: false };

      let killed: boolean;
      try {
        killed = owned.kill();
      } catch {
        return { kind: "termination_failed", killed: false };
      }
      if (killed !== true) return { kind: "termination_failed", killed: false };
      state = { kind: "player_host_stopped" };
      return { kind: "terminated", killed: true };
    },
    /**
     * The contained ending: the world this attempt launched is gone and this owner holds no handle
     * that could say so. Marking `player_host_stopped` here is what lets the next attempt reserve at
     * all, and it claims only what its caller proved - see `StardewPlayerHostProcessOwner`.
     */
    notePlayerHostEnded(): void {
      if (state.kind === "awaiting_player_host_attestation" && state.owned === null)
        state = { kind: "player_host_stopped" };
    },
  });
}

function createAiClientProcessOwner(
  rawSpawn: StardewAiClientProcessSpawn,
  rawProbe: StardewAiClientProcessProbe,
  createLaunchGeneration: () => string,
  registerAiClientLaunch: (
    reservation: StardewAiClientLaunchReservation,
    registration: StardewAiClientLaunchRegistration,
  ) => void,
): StardewAiClientProcessOwner {
  let state: OwnedProcessState = { kind: "idle" };
  let reservation: Readonly<{
    capability: StardewAiClientLaunchReservation;
    launchGeneration: string;
  }> | null = null;

  function launchWithGeneration(
    input: LaunchAiClientInput,
    launchGeneration: string,
  ): Readonly<{ status: StardewAiClientProcessStatus }> {
    if (state.kind === "awaiting_ai_client_attestation") throw new Error("owned_ai_client_already_active");
    validateLaunchInput(input);

    const spawned = rawSpawn(input.executable, [...input.args], {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      shell: false,
      windowsHide: true,
      env: createStardewChildEnvironment(launchGeneration),
    });
    const pid = spawned.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      spawned.kill();
      throw new Error("spawned_child_missing_valid_pid");
    }

    const probeResult = rawProbe(pid);
    if (probeResult === null) {
      spawned.kill();
      throw new Error("probe_failed_no_process");
    }
    if (probeResult.pid !== pid) {
      spawned.kill();
      throw new Error("probe_pid_mismatch");
    }
    if (typeof probeResult.creationDate !== "string" || probeResult.creationDate.length === 0) {
      spawned.kill();
      throw new Error("probe_invalid_creation_identity");
    }

    state = {
      kind: "awaiting_ai_client_attestation",
      owned: {
        kill: () => spawned.kill(),
        pid,
        creationDate: probeResult.creationDate,
      },
      launchGeneration,
    };
    return Object.freeze({
      status: { kind: "awaiting_ai_client_attestation" } as const,
    });
  }

  const owner: StardewAiClientProcessOwner = Object.freeze({
    readStatus(): StardewAiClientProcessStatus {
      if (reservation !== null) return { kind: "ai_client_launch_pending" };
      return { kind: state.kind };
    },
    readOwnedAiClientGeneration(): ReadOwnedAiClientGenerationResult {
      // Only a launched (owned) AI process has an opaque generation; a
      // pending-but-unlaunched reservation and an idle owner expose null.
      if (state.kind !== "awaiting_ai_client_attestation") {
        return Object.freeze({ ownedGeneration: null });
      }
      return Object.freeze({ ownedGeneration: Object.freeze({ launchGeneration: state.launchGeneration }) });
    },
    reserveAiClientLaunch(): StardewAiClientLaunchReservation {
      if (reservation !== null || state.kind === "awaiting_ai_client_attestation")
        throw new Error("owned_ai_client_launch_already_active");
      const launchGeneration = createLaunchGeneration();
      if (!isOpaque(launchGeneration)) throw new Error("invalid_launch_generation");

      const capability = Object.freeze({}) as StardewAiClientLaunchReservation;
      reservation = Object.freeze({ capability, launchGeneration });
      let consumed = false;
      const registration: StardewAiClientLaunchRegistration = Object.freeze({
        launchGeneration,
        launch(input) {
          if (consumed || reservation?.capability !== capability)
            throw new Error("ai_client_launch_reservation_not_active");
          consumed = true;
          reservation = null;
          return launchWithGeneration(input, launchGeneration);
        },
        containedLaunch() {
          if (consumed || reservation?.capability !== capability)
            throw new Error("ai_client_launch_reservation_not_active");
          consumed = true;
          reservation = null;
          if (state.kind === "awaiting_ai_client_attestation") throw new Error("owned_ai_client_already_active");
          state = { kind: "awaiting_ai_client_attestation", owned: null, launchGeneration };
          return Object.freeze({
            status: { kind: "awaiting_ai_client_attestation" as const },
          });
        },
        revoke() {
          if (!consumed && reservation?.capability === capability) reservation = null;
          consumed = true;
        },
      });

      try {
        registerAiClientLaunch(capability, registration);
      } catch (error) {
        registration.revoke();
        throw error;
      }
      return capability;
    },
    noteAiClientEnded(): void {
      // A reservation the attempt never used is spent with it: nothing can launch it any more, and
      // the next attempt mints its own.
      if (reservation !== null) reservation = null;
      // A contained launch owns no process here; the attempt's own containment already ran, so the
      // only thing left to record is that this owner holds no activation any more.
      if (state.kind === "awaiting_ai_client_attestation" && state.owned === null)
        state = { kind: "ai_client_stopped" };
    },
    stopOwnedAiClient(): StopOwnedAiClientResult {
      if (state.kind === "idle") return { kind: "no_owned_ai_client", killed: false };
      if (state.kind === "ai_client_stopped") return { kind: "already_stopped", killed: false };
      // Contained launch: the Host holds no pid/kill handle. The Guardian
      // kill-on-close Job terminates the native process at platform close, so
      // a direct stop is a success no-op and never probes an invented pid. The
      // exact state still advances to `ai_client_stopped` so the ended
      // activation can be superseded by a fresh per-activation reservation.
      if (state.kind === "awaiting_ai_client_attestation" && state.owned === null) {
        state = { kind: "ai_client_stopped" };
        return { kind: "already_stopped", killed: false };
      }

      const { owned } = state;
      const probeResult = rawProbe(owned.pid);
      if (probeResult === null) return { kind: "identity_probe_failed", killed: false };
      if (probeResult.pid !== owned.pid || probeResult.creationDate !== owned.creationDate)
        return { kind: "identity_mismatch", killed: false };

      let killed: boolean;
      try {
        killed = owned.kill();
      } catch {
        return { kind: "termination_failed", killed: false };
      }
      if (killed !== true) return { kind: "termination_failed", killed: false };
      state = { kind: "ai_client_stopped" };
      return { kind: "terminated", killed: true };
    },
  });
  return owner;
}

function validatePlayerHostLaunchInput(input: LaunchPlayerHostInput): void {
  if (!isRecord(input)) throw new Error("invalid_player_host_launch_input");
  const expectedKeys = input.cwd === undefined ? ["executable", "args"] : ["executable", "args", "cwd"];
  if (!exactKeys(input, expectedKeys)) throw new Error("invalid_player_host_launch_input_keys");
  const { executable, args, cwd } = input;
  if (typeof executable !== "string" || executable.length === 0 || !isAbsolute(executable))
    throw new Error("invalid_player_host_launch_executable_not_absolute");
  if (!Array.isArray(args)) throw new Error("invalid_player_host_launch_args_not_array");
  if (args.length === 0) throw new Error("invalid_player_host_launch_args_empty");
  if (args.length > 128) throw new Error("invalid_player_host_launch_args_too_many");
  for (const token of args) {
    if (typeof token !== "string") throw new Error("invalid_player_host_launch_args_token_not_string");
    if (token.length === 0) throw new Error("invalid_player_host_launch_args_token_empty");
    if (token.length > 4096) throw new Error("invalid_player_host_launch_args_token_too_long");
    if (token.includes("\0")) throw new Error("invalid_player_host_launch_args_contains_nul");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)))
    throw new Error("invalid_player_host_launch_cwd_not_absolute");
}

function validateLaunchInput(input: LaunchAiClientInput): void {
  if (!isRecord(input)) throw new Error("invalid_launch_input");
  const { executable, args, cwd } = input;
  if (typeof executable !== "string" || executable.length === 0 || !isAbsolute(executable))
    throw new Error("invalid_launch_executable_not_absolute");
  if (!Array.isArray(args)) throw new Error("invalid_launch_args_not_array");
  if (args.length === 0) throw new Error("invalid_launch_args_empty");
  if (args.length > 128) throw new Error("invalid_launch_args_too_many");
  for (const token of args) {
    if (typeof token !== "string") throw new Error("invalid_launch_args_token_not_string");
    if (token.length === 0) throw new Error("invalid_launch_args_token_empty");
    if (token.length > 4096) throw new Error("invalid_launch_args_token_too_long");
    if (token.includes("\0")) throw new Error("invalid_launch_args_contains_nul");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)))
    throw new Error("invalid_launch_cwd_not_absolute");
}

async function readDirectoryIfPresent(path: string, root: string): Promise<readonly string[]> {
  try {
    return await readSafeDirectory(path, root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function createGuardianBinding(dependencies: StardewPrivateBootstrapCoreDependencies): StardewGuardianBinding {
  const binding = {
    bindingRevision: dependencies.createGuardianRevision(),
    guardianInstanceId: dependencies.createGuardianInstanceId(),
    guardianEpoch: dependencies.createGuardianEpoch(),
    leaseName: dependencies.createGuardianLeaseName(),
    playerJobName: dependencies.createGuardianPlayerJobName(),
    aiJobName: dependencies.createGuardianAiJobName(),
  };
  if (
    !isOpaque(binding.bindingRevision) ||
    !isOpaque(binding.guardianInstanceId) ||
    !isPositiveBoundedInteger(binding.guardianEpoch) ||
    !isGuardianName(binding.leaseName) ||
    !isGuardianName(binding.playerJobName) ||
    !isGuardianName(binding.aiJobName) ||
    new Set([binding.leaseName, binding.playerJobName, binding.aiJobName]).size !== 3
  )
    throw new Error("invalid_stardew_guardian_binding");
  return Object.freeze(binding);
}

type StardewOwnerImmutableFence = Readonly<{
  bootstrapId: string;
  playerId: string;
  companionId: string;
  guardian: StardewGuardianBinding;
}>;

type StardewOwnerTransitionPrimitives = Readonly<{
  arm(expectedRevision: number): Promise<StardewPrivateBootstrapOwnerRecord>;
  activate(role: "playerHost" | "aiClient", expectedRevision: number): Promise<StardewPrivateBootstrapOwnerRecord>;
  beginControlledClose(expectedRevision: number): Promise<StardewPrivateBootstrapOwnerRecord>;
  containControlledRole(
    role: "playerHost" | "aiClient",
    expectedRevision: number,
  ): Promise<StardewPrivateBootstrapOwnerRecord>;
  beginRecovery(expectedRevision: number, recoveryInstanceId: string): Promise<StardewPrivateBootstrapOwnerRecord>;
  containRecoveringRole(
    role: "playerHost" | "aiClient",
    expectedRevision: number,
    recoveryInstanceId: string,
  ): Promise<StardewPrivateBootstrapOwnerRecord>;
  finalizeControlledContained(expectedRevision: number): Promise<StardewPrivateBootstrapOwnerRecord>;
  finalizeRecoveredContained(
    expectedRevision: number,
    requiredRecoveryInstanceId: string,
  ): Promise<StardewPrivateBootstrapOwnerRecord>;
  finalizeRecoveredAiSettledPlayerPreserved(
    expectedRevision: number,
    requiredRecoveryInstanceId: string,
  ): Promise<StardewPrivateBootstrapOwnerRecord>;
  quarantine(expectedRevision: number): Promise<StardewPrivateBootstrapOwnerRecord>;
  quarantineRecovery(
    expectedRevision: number,
    requiredRecoveryInstanceId: string,
  ): Promise<StardewPrivateBootstrapOwnerRecord>;
}>;

type OwnerTransitionPersistence = Readonly<{
  atomicWrite(ownerPath: string, content: string, containmentRoot: string): Promise<void>;
  strictRead(ownerPath: string, containmentRoot: string): Promise<StardewPrivateBootstrapOwnerRecord>;
}>;

/** Core-private durable lifecycle transition engine. */
function createStardewBootstrapOwnerTransitionPrimitives(
  input: Readonly<{
    ownerPath: string;
    containmentRoot: string;
    immutableFence: StardewOwnerImmutableFence;
  }>,
  persistence: OwnerTransitionPersistence,
): StardewOwnerTransitionPrimitives {
  const transition = async (
    expectedRevision: number,
    mutate: (current: StardewPrivateBootstrapOwnerRecord) => StardewPrivateBootstrapOwnerRecord,
    requiredRecoveryInstanceId: string | null = null,
  ): Promise<StardewPrivateBootstrapOwnerRecord> =>
    withPathLock(
      input.ownerPath,
      async () => {
        // Validate the persisted predecessor before constructing or writing a
        // successor. A failed CAS therefore leaves its exact bytes untouched.
        const current = await persistence.strictRead(input.ownerPath, input.containmentRoot);
        if (
          current.ownerRecordRevision !== expectedRevision ||
          !sameImmutableFence(current, input.immutableFence) ||
          (requiredRecoveryInstanceId !== null && current.recoveryInstanceId !== requiredRecoveryInstanceId)
        ) {
          throw new Error("stardew_bootstrap_owner_transition_mismatch");
        }
        const candidate = { ...mutate(current), ownerRecordRevision: current.ownerRecordRevision + 1 };
        // The same strict v4 validator validates both disk JSON and in-memory CAS
        // successors before the single atomic write.
        const next = validateOwnerRecord(candidate);
        if (
          !sameImmutableFence(next, input.immutableFence) ||
          next.ownerRecordRevision !== current.ownerRecordRevision + 1
        ) {
          throw new Error("stardew_bootstrap_owner_transition_invalid");
        }
        await persistence.atomicWrite(input.ownerPath, `${JSON.stringify(next)}\n`, input.containmentRoot);
        const reread = await persistence.strictRead(input.ownerPath, input.containmentRoot);
        if (
          reread.ownerRecordRevision !== next.ownerRecordRevision ||
          JSON.stringify(reread) !== JSON.stringify(next)
        ) {
          throw new Error("stardew_bootstrap_owner_transition_reread_mismatch");
        }
        return reread;
      },
      { containmentRoot: input.containmentRoot },
    );
  const changeRole = (
    current: StardewPrivateBootstrapOwnerRecord,
    role: "playerHost" | "aiClient",
    state: StardewPrivateBootstrapOwnerRecord["playerHostState"],
  ) => (role === "playerHost" ? { ...current, playerHostState: state } : { ...current, aiClientState: state });
  return Object.freeze({
    arm: (revision) =>
      transition(revision, (current) => {
        if (
          current.state !== "reserved" ||
          current.guardianState !== "reserved" ||
          current.playerHostState !== "reserved" ||
          current.aiClientState !== "reserved"
        )
          throw new Error("stardew_bootstrap_owner_transition_invalid");
        return { ...current, guardianState: "armed", playerHostState: "armed", aiClientState: "armed" };
      }),
    activate: (role, revision) =>
      transition(revision, (current) => {
        if (
          current.state !== "reserved" ||
          current.guardianState !== "armed" ||
          (role === "playerHost" ? current.playerHostState : current.aiClientState) !== "armed"
        )
          throw new Error("stardew_bootstrap_owner_transition_invalid");
        return changeRole(current, role, "active");
      }),
    beginControlledClose: (revision) =>
      transition(revision, (current) => {
        if (
          current.state !== "reserved" ||
          current.guardianState !== "armed" ||
          ![current.playerHostState, current.aiClientState].every(
            (state) => state === "armed" || state === "active" || state === "contained",
          )
        ) {
          throw new Error("stardew_bootstrap_owner_transition_invalid");
        }
        return {
          ...current,
          state: "closing",
          guardianState: "closing",
          playerHostState: current.playerHostState === "contained" ? "contained" : "closing",
          aiClientState: current.aiClientState === "contained" ? "contained" : "closing",
        };
      }),
    containControlledRole: (role, revision) =>
      transition(revision, (current) => {
        if (
          current.state !== "closing" ||
          current.guardianState !== "closing" ||
          (role === "playerHost" ? current.playerHostState : current.aiClientState) !== "closing"
        )
          throw new Error("stardew_bootstrap_owner_transition_invalid");
        return changeRole(current, role, "contained");
      }),
    beginRecovery: (revision, recoveryInstanceId) =>
      transition(revision, (current) => {
        if (
          !isOpaque(recoveryInstanceId) ||
          current.recoveryInstanceId !== null ||
          !(
            (current.state === "reserved" &&
              (current.guardianState === "reserved" || current.guardianState === "armed")) ||
            (current.state === "closing" && current.guardianState === "closing")
          )
        ) {
          throw new Error("stardew_bootstrap_owner_transition_invalid");
        }
        return { ...current, state: "recovering", guardianState: "recovering", recoveryInstanceId };
      }),
    containRecoveringRole: (role, revision, recoveryInstanceId) =>
      transition(
        revision,
        (current) => {
          if (current.state !== "recovering" || current.guardianState !== "recovering")
            throw new Error("stardew_bootstrap_owner_transition_invalid");
          // A role this recovery already contained is not a transition that is still
          // available. It fails closed with its own shared typed refusal so a driver
          // that resumed a crashed recovery can tell "already contained" from a wrong
          // state and drive only the roles it actually recovered. The refusal's
          // identity comes from the platform contract because the recovery wire - the
          // driver that must tolerate exactly this case - cannot see this engine's
          // message.
          if ((role === "playerHost" ? current.playerHostState : current.aiClientState) === "contained")
            throw new ContainmentRoleAlreadyContainedError("stardew_bootstrap_owner_recovery_role_already_contained");
          return changeRole(current, role, "contained");
        },
        recoveryInstanceId,
      ),
    finalizeControlledContained: (revision) =>
      transition(revision, (current) => {
        if (
          current.state !== "closing" ||
          current.guardianState !== "closing" ||
          current.recoveryInstanceId !== null ||
          current.playerHostState !== "contained" ||
          current.aiClientState !== "contained"
        )
          throw new Error("stardew_bootstrap_owner_transition_invalid");
        return { ...current, state: "contained", guardianState: "contained", recoveryInstanceId: null };
      }),
    finalizeRecoveredContained: (revision, recoveryInstanceId) =>
      transition(
        revision,
        (current) => {
          if (
            !isOpaque(recoveryInstanceId) ||
            current.state !== "recovering" ||
            current.guardianState !== "recovering" ||
            current.playerHostState !== "contained" ||
            current.aiClientState !== "contained"
          )
            throw new Error("stardew_bootstrap_owner_transition_invalid");
          return { ...current, state: "contained", guardianState: "contained", recoveryInstanceId: null };
        },
        recoveryInstanceId,
      ),
    // The AI-side recovery terminal. It is reachable ONLY from `recovering`, and
    // only on the outcome the driver observed as "the AI side is settled and the
    // player's world was deliberately preserved": the recovery's player-role
    // classification returned before any role CAS, so neither role was observed
    // contained.
    //
    // The transition therefore refuses a predecessor that already carries a role
    // containment. Recording this terminal over a contained role would be the
    // record claiming a containment this recovery never observed (and, for the
    // AI side, one the broker never reported to the Host at all). A record whose
    // role was contained by an EARLIER controlled close is not this terminal, and
    // the refusal travels back through the recovery's own failure closure, which
    // quarantines it - a bounded refusal, never a fabricated terminal.
    finalizeRecoveredAiSettledPlayerPreserved: (revision, recoveryInstanceId) =>
      transition(
        revision,
        (current) => {
          if (
            !isOpaque(recoveryInstanceId) ||
            current.state !== "recovering" ||
            current.guardianState !== "recovering" ||
            current.playerHostState === "contained" ||
            current.aiClientState === "contained"
          )
            throw new Error("stardew_bootstrap_owner_transition_invalid");
          // `cleanupDisposition` stays `pending`: the AI side really was cleaned up
          // and the player's world needs no retry, so this terminal owes no
          // `retry_required` residue. The consumption of that declaration happens in
          // the finalize that drives this transition.
          return {
            ...current,
            state: "ai_settled_player_preserved",
            guardianState: "ai_settled_player_preserved",
            recoveryInstanceId: null,
          };
        },
        recoveryInstanceId,
      ),
    quarantine: (revision) =>
      transition(revision, (current) => {
        if (current.state === "recovering" || isTerminalOwnerState(current.state))
          throw new Error("stardew_bootstrap_owner_transition_invalid");
        return {
          ...current,
          state: "quarantined",
          guardianState: "quarantined",
          playerHostState: current.playerHostState === "contained" ? "contained" : "quarantined",
          aiClientState: current.aiClientState === "contained" ? "contained" : "quarantined",
          recoveryInstanceId: null,
          cleanupDisposition: "retry_required",
        };
      }),
    quarantineRecovery: (revision, recoveryInstanceId) =>
      transition(
        revision,
        (current) => {
          if (
            !isOpaque(recoveryInstanceId) ||
            current.state !== "recovering" ||
            current.guardianState !== "recovering"
          ) {
            throw new Error("stardew_bootstrap_owner_transition_invalid");
          }
          return {
            ...current,
            state: "quarantined",
            guardianState: "quarantined",
            playerHostState: current.playerHostState === "contained" ? "contained" : "quarantined",
            aiClientState: current.aiClientState === "contained" ? "contained" : "quarantined",
            recoveryInstanceId: null,
            cleanupDisposition: "retry_required",
          };
        },
        recoveryInstanceId,
      ),
  });
}

const productionOwnerTransitionPersistence: OwnerTransitionPersistence = Object.freeze({
  atomicWrite: atomicWriteFile,
  strictRead: readAndValidateOwner,
});

function createProductionStardewBootstrapOwnerTransitionPrimitives(
  input: Readonly<{ ownerPath: string; containmentRoot: string; immutableFence: StardewOwnerImmutableFence }>,
): StardewOwnerTransitionPrimitives {
  return createStardewBootstrapOwnerTransitionPrimitives(input, productionOwnerTransitionPersistence);
}

/**
 * One CAS-cursor port over the durable transition engine, used by the
 * recoverable-owner opener.
 *
 * The live owner binding exposes the same surface but does not route through
 * here: `createStardewBootstrapGuardianOwnerBinding` re-implements this cursor
 * and advance against its own primitive instance, because it also has to hand
 * every successor record to `replaceRecord` and fix up the binding's recorded
 * revision while the opener has no in-memory record at all. The two surfaces are
 * therefore equal by duplication today, not by sharing this function, so a change
 * to the cursor or to the transition names belongs in both places.
 */
function createStardewBootstrapOwnerTransitionPort(
  primitives: StardewOwnerTransitionPrimitives,
  initialOwnerRecordRevision: number,
  onAdvanced?: (record: StardewPrivateBootstrapOwnerRecord) => void,
): StardewBootstrapGuardianOwnerTransitionPort {
  let revision = initialOwnerRecordRevision;
  const advance = async (
    operation: (expectedRevision: number) => Promise<StardewPrivateBootstrapOwnerRecord>,
  ): Promise<void> => {
    const next = await operation(revision);
    revision = next.ownerRecordRevision;
    if (onAdvanced !== undefined) onAdvanced(next);
  };
  return Object.freeze({
    armAcknowledged: () => advance((current) => primitives.arm(current)),
    roleActive: (role) => advance((current) => primitives.activate(role, current)),
    beginControlledClose: () => advance((current) => primitives.beginControlledClose(current)),
    controlledRoleContained: (role) => advance((current) => primitives.containControlledRole(role, current)),
    finalizeControlledContained: () => advance((current) => primitives.finalizeControlledContained(current)),
    beginRecovery: (actor) => advance((current) => primitives.beginRecovery(current, actor)),
    recoveryRoleContained: (role, actor) =>
      advance((current) => primitives.containRecoveringRole(role, current, actor)),
    finalizeRecoveredContained: (actor) => advance((current) => primitives.finalizeRecoveredContained(current, actor)),
    finalizeRecoveredAiSettledPlayerPreserved: (actor) =>
      advance((current) => primitives.finalizeRecoveredAiSettledPlayerPreserved(current, actor)),
    quarantine: () => advance((current) => primitives.quarantine(current)),
    quarantineRecovery: (actor) => advance((current) => primitives.quarantineRecovery(current, actor)),
  });
}

function immutableFenceFor(owner: StardewPrivateBootstrapOwnerRecord): StardewOwnerImmutableFence {
  return Object.freeze({
    bootstrapId: owner.bootstrapId,
    playerId: owner.playerId,
    companionId: owner.companionId,
    guardian: owner.guardian,
  });
}

/**
 * Fieldless, composition-bound handoff for the Guardian private owner. The
 * WeakMap below is the only place that associates it with a durable path,
 * immutable fence, and current CAS revision.
 */
declare const stardewGuardianOwnerBindingBrand: unique symbol;
export type StardewBootstrapGuardianOwnerBinding = Readonly<{
  readonly [stardewGuardianOwnerBindingBrand]: never;
}>;

export type StardewBootstrapGuardianOwnerTransitionPort = Readonly<{
  armAcknowledged(): Promise<void>;
  roleActive(role: "playerHost" | "aiClient"): Promise<void>;
  beginControlledClose(): Promise<void>;
  controlledRoleContained(role: "playerHost" | "aiClient"): Promise<void>;
  finalizeControlledContained(): Promise<void>;
  beginRecovery(recoveryInstanceId: string): Promise<void>;
  recoveryRoleContained(role: "playerHost" | "aiClient", recoveryInstanceId: string): Promise<void>;
  finalizeRecoveredContained(recoveryInstanceId: string): Promise<void>;
  finalizeRecoveredAiSettledPlayerPreserved(recoveryInstanceId: string): Promise<void>;
  quarantine(): Promise<void>;
  quarantineRecovery(recoveryInstanceId: string): Promise<void>;
}>;

export type StardewBootstrapGuardianRecoveryGateBinding = Readonly<{
  bindingRevision: string;
  leaseName: string;
}>;

export type StardewBootstrapOwnerTransitions = StardewBootstrapGuardianOwnerTransitionPort;

declare const stardewGuardianSettlementProofBrand: unique symbol;
export type StardewBootstrapGuardianSettlementProof = Readonly<{
  readonly [stardewGuardianSettlementProofBrand]: never;
}>;

type GuardianOwnerBindingFacts = {
  readonly port: StardewBootstrapGuardianOwnerTransitionPort;
  readonly recoveryGateBinding: StardewBootstrapGuardianRecoveryGateBinding;
  readonly settlementBinding: object;
  readonly immutableFence: StardewOwnerImmutableFence;
  currentOwnerRecordRevision: number;
  consumed: boolean;
};
type GuardianSettlementProofFacts = {
  readonly settlementBinding: object;
  readonly immutableFence: StardewOwnerImmutableFence;
  readonly expectedTerminalOwnerRecordRevision: number;
  state: "available" | "reserved" | "consumed";
};
const guardianOwnerBindings = new WeakMap<object, GuardianOwnerBindingFacts>();
const guardianSettlementProofs = new WeakMap<object, GuardianSettlementProofFacts>();

/**
 * Creates one exact Guardian owner binding for a composer-minted owned Player Host bootstrap reservation
 * owner. No path, fence, record, revision, or persistence callback crosses
 * this boundary; every named transition advances the closure-held CAS cursor.
 */
export type StardewBootstrapGuardianNativeArmFrame = Readonly<{
  bootstrapId: string;
  guardianInstanceId: string;
  guardianEpoch: number;
  attemptId: string;
  revision: string;
  leaseName: string;
  playerJobName: string;
  aiJobName: string;
}>;

/** Returns the tokenless native arm facts for the exact consumed owner binding. */
export function readStardewBootstrapGuardianNativeArmFrame(
  binding: StardewBootstrapGuardianOwnerBinding,
): StardewBootstrapGuardianNativeArmFrame {
  if (typeof binding !== "object" || binding === null)
    throw new Error("stardew_bootstrap_guardian_owner_binding_not_registered");
  const facts = guardianOwnerBindings.get(binding);
  if (facts === undefined || facts.consumed) throw new Error("stardew_bootstrap_guardian_owner_binding_not_registered");
  const owner = facts.immutableFence;
  return Object.freeze({
    bootstrapId: owner.bootstrapId,
    guardianInstanceId: owner.guardian.guardianInstanceId,
    guardianEpoch: owner.guardian.guardianEpoch,
    attemptId: owner.bootstrapId,
    revision: owner.guardian.bindingRevision,
    leaseName: owner.guardian.leaseName,
    playerJobName: owner.guardian.playerJobName,
    aiJobName: owner.guardian.aiJobName,
  });
}

export function createStardewBootstrapGuardianOwnerBinding(
  owner: StardewOwnedPlayerHostBootstrap,
  compositionIdentity?: object,
): StardewBootstrapGuardianOwnerBinding {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner, compositionIdentity);
  const existing = guardianOwnerBindings.get(owner);
  if (existing !== undefined) throw new Error("stardew_bootstrap_guardian_owner_binding_unavailable");
  const initial = facts.durableOwner.record;
  const transitions = createProductionStardewBootstrapOwnerTransitionPrimitives({
    ownerPath: join(facts.durableOwner.transactionDirectory, OWNER_FILE),
    containmentRoot: dirname(dirname(facts.durableOwner.transactionDirectory)),
    immutableFence: immutableFenceFor(initial),
  });
  let revision = initial.ownerRecordRevision;
  const advance = async (
    operation: (expectedRevision: number) => Promise<StardewPrivateBootstrapOwnerRecord>,
  ): Promise<void> => {
    const next = await operation(revision);
    revision = next.ownerRecordRevision;
    facts.durableOwner.replaceRecord(next);
    const guardianFacts = guardianOwnerBindings.get(owner);
    if (guardianFacts !== undefined) guardianFacts.currentOwnerRecordRevision = revision;
  };
  const port: StardewBootstrapGuardianOwnerTransitionPort = Object.freeze({
    armAcknowledged: () => advance((current) => transitions.arm(current)),
    roleActive: (role) => advance((current) => transitions.activate(role, current)),
    beginControlledClose: () => advance((current) => transitions.beginControlledClose(current)),
    controlledRoleContained: (role) => advance((current) => transitions.containControlledRole(role, current)),
    finalizeControlledContained: () => advance((current) => transitions.finalizeControlledContained(current)),
    beginRecovery: (actor) => advance((current) => transitions.beginRecovery(current, actor)),
    recoveryRoleContained: (role, actor) =>
      advance((current) => transitions.containRecoveringRole(role, current, actor)),
    finalizeRecoveredContained: (actor) => advance((current) => transitions.finalizeRecoveredContained(current, actor)),
    finalizeRecoveredAiSettledPlayerPreserved: (actor) =>
      advance((current) => transitions.finalizeRecoveredAiSettledPlayerPreserved(current, actor)),
    quarantine: () => advance((current) => transitions.quarantine(current)),
    quarantineRecovery: (actor) => advance((current) => transitions.quarantineRecovery(current, actor)),
  });
  guardianOwnerBindings.set(owner, {
    port,
    recoveryGateBinding: Object.freeze({
      bindingRevision: initial.guardian.bindingRevision,
      leaseName: initial.guardian.leaseName,
    }),
    settlementBinding: Object.freeze(Object.create(null)),
    immutableFence: immutableFenceFor(initial),
    currentOwnerRecordRevision: initial.ownerRecordRevision,
    consumed: false,
  });
  return owner as unknown as StardewBootstrapGuardianOwnerBinding;
}

/** Consumes only a registered composition-bound Guardian owner binding. */
export function consumeStardewBootstrapGuardianOwnerBinding(binding: StardewBootstrapGuardianOwnerBinding): Readonly<{
  transitions: StardewBootstrapGuardianOwnerTransitionPort;
  recoveryGateBinding: StardewBootstrapGuardianRecoveryGateBinding;
  settlementBinding: object;
  armFrame: StardewBootstrapGuardianNativeArmFrame;
}> {
  if (typeof binding !== "object" || binding === null) {
    throw new Error("stardew_bootstrap_guardian_owner_binding_not_registered");
  }
  const facts = guardianOwnerBindings.get(binding);
  if (facts === undefined || facts.consumed) throw new Error("stardew_bootstrap_guardian_owner_binding_not_registered");
  // Read the arm frame before the binding is marked consumed: the production
  // contained runtime needs it to build the native correlation, and computing it
  // here keeps arm-frame reading and durable-transition ownership on one seam.
  const armFrame = readStardewBootstrapGuardianNativeArmFrame(binding);
  facts.consumed = true;
  return Object.freeze({
    transitions: facts.port,
    recoveryGateBinding: facts.recoveryGateBinding,
    settlementBinding: facts.settlementBinding,
    armFrame,
  });
}

/**
 * The identity every recovery handle is registered under. It is deliberately not
 * a composition identity: a recovery handle stands for a crashed attempt's
 * durable record, not for the composition that happens to be driving the
 * recovery, so the composition-bound surfaces (staging, launch, terminal owner
 * operations) refuse it while the module-level recovery and settlement seams
 * accept it. It is one shared object rather than a second registry: the handle
 * is registered in the same owner-facts singleton every other owner uses, and
 * its Guardian binding is minted and consumed by the same single production
 * consumption site every other owner's binding goes through.
 */
const recoverableOwnerIdentity = Object.freeze({});

/**
 * A recovery handle owns no launch authority: the attempt's launch reservations
 * were consumed by the process that crashed, so a launch through this handle
 * could never be true. The refusal is the whole behavior, and it is the same
 * bounded error for both roles because the reason is the same for both.
 */
function refuseRecoverableOwnerLaunch(): never {
  throw new Error("stardew_recoverable_owner_launch_unavailable");
}

function createRecoverablePlayerHostRegistration(launchGeneration: string): StardewPlayerHostLaunchRegistration {
  return Object.freeze({
    launchGeneration,
    launch: refuseRecoverableOwnerLaunch,
    containedLaunch: refuseRecoverableOwnerLaunch,
    // There is no in-process reservation left to revoke: the one this record
    // describes died with the process that held it.
    revoke: () => undefined,
  });
}

function createRecoverableAiClientRegistration(launchGeneration: string): StardewAiClientLaunchRegistration {
  return Object.freeze({
    launchGeneration,
    launch: refuseRecoverableOwnerLaunch,
    containedLaunch: refuseRecoverableOwnerLaunch,
    revoke: () => undefined,
  });
}

/**
 * The recovery handle of one opened attempt, as a real composer owner handle: it
 * is registered in this module's owner-facts singleton exactly like a reserved
 * owner, so the recovery seam, the settlement and the post-recovery cleanup all
 * accept it through the same accessor and the same Guardian owner binding every
 * other owner goes through. It is not a second authority, a second handle type,
 * or a second durable seam.
 *
 * Its one difference from a reserved owner is that it owns no launch authority
 * (see `refuseRecoverableOwnerLaunch`) and that its bootstrap binding state
 * starts at `terminal`, so no lifecycle can bind it as a live owner. Every fact
 * it does expose -- the durable record, its transaction directory, and the
 * immutable Guardian fence -- is the crashed attempt's own, read from its own
 * `owner.json`.
 */
function composeRecoverablePlayerHostOwner(durableOwner: DurableOwner): StardewOwnedPlayerHostBootstrap {
  const initial = durableOwner.record;
  // An owned launch reservation records its Player Host generation; an external
  // Player Host attempt has none, which is the only thing the empty marker
  // describes. Nothing can reach a launch through this handle either way.
  const playerHostGeneration = initial.playerHost.kind === "launch_reserved" ? initial.playerHost.launchGeneration : "";
  const owner = Object.freeze({}) as StardewOwnedPlayerHostBootstrap;
  const facts: OwnedPlayerHostBootstrapFacts = {
    compositionIdentity: recoverableOwnerIdentity,
    immutableFence: immutableFenceFor(initial),
    durableOwner,
    playerHostRegistration: createRecoverablePlayerHostRegistration(playerHostGeneration),
    aiClientRegistration: createRecoverableAiClientRegistration(initial.aiClient.launchGeneration),
    expiresAtMs: initial.expiresAtMs,
    readClock: () => Date.now(),
    launchStates: { playerHost: "revoked", aiClient: "revoked" },
    quarantine: { started: false, promise: null },
    bindingState: { value: "terminal" },
    playerHostProfileStagingState: { value: "not_staged" },
    aiClientProfileState: { value: "not_materialized" },
    bridgeConnectionState: { value: "unavailable" },
    privateMaterial: { value: null },
    privateBridgeMaterial: { value: null },
    consumePlayerHostLaunch: refuseRecoverableOwnerLaunch,
    consumePlayerHostLaunchContained: refuseRecoverableOwnerLaunch,
    consumeAiClientLaunch: refuseRecoverableOwnerLaunch,
    consumeAiClientLaunchContained: refuseRecoverableOwnerLaunch,
    quarantineOwner: () => durableOwner.quarantine(),
  };
  ownedPlayerHostBootstrapFacts.set(owner, facts);
  return owner;
}

/**
 * One recoverable instance over an existing crashed `owner.json`.
 */
export type StardewRecoverableBootstrapOwner = Readonly<{
  ownerPath: string;
  /** The CAS revision this instance was opened at. */
  ownerRecordRevision: number;
  /** The same transition surface the live owner binding exposes. */
  transitions: StardewBootstrapOwnerTransitions;
  /** The recorded recovery actor, or null when the record has none. */
  recoveryInstanceId: string | null;
  /**
   * The composer-minted owner handle for this exact attempt, over the same
   * durable record this instance was opened from. It is the credential the
   * recovery seam (`recover`/`finalizeRecovered`) and the registration-pointer
   * release require: both resolve it through the same owner-facts and Guardian
   * owner-binding singletons every other owner uses, so the recovery cannot
   * open a second owner path, a second durable seam, or a second in-process
   * authority for this attempt.
   */
  owner: StardewOwnedPlayerHostBootstrap;
}>;

/**
 * The only legal way to open an existing crashed (non-pristine, non-terminal)
 * `owner.json` as a recoverable instance.
 *
 * The normal reservation path refuses every non-pristine record
 * (`stardew_bootstrap_owner_occupied`), so a Guardian/Host crash that left the
 * durable attempt non-terminal had no path back to a terminal state. This seam
 * reopens exactly that record and hands out the same one-CAS-cursor transition
 * surface the live owner binding uses, so a recovery driver needs no second
 * durable read/write seam.
 *
 * It is deliberately fail-closed and never returns a half-usable instance. A
 * `contained`/`quarantined` terminal record and any record whose principal
 * (bootstrap/player/companion) is not the requested one throw, and so does any
 * record the strict v4 validator rejects: that is the same validator that
 * guards every CAS successor, so a record whose state/role matrix is already
 * inconsistent is never handed out as a drive. The single locked read below
 * also sources the immutable fence and the CAS cursor, so the returned revision
 * is the exact persisted predecessor the engine CASes from; a record that moves
 * afterwards fails its transition with `stardew_bootstrap_owner_transition_mismatch`
 * rather than being driven from a stale cursor.
 *
 * The durable `recoveryInstanceId` is adopted, never minted here: an interrupted
 * recovery resumes its exact recorded actor, and a record that has none reports
 * `null` so the caller mints a fresh one through `beginRecovery`.
 */
export async function openRecoverableStardewBootstrapOwner(
  input: Readonly<{
    /**
     * The root the existing private-bootstrap transaction is derived from: the
     * record is read at
     * `<transactionRoot>/stardew-private-bootstrap/<bootstrapId>/owner.json`,
     * exactly where the reservation path persists it.
     */
    transactionRoot: string;
    bootstrapFacts: Readonly<{ bootstrapId: string; playerId: string; companionId: string }>;
  }>,
): Promise<StardewRecoverableBootstrapOwner> {
  if (
    !isRecord(input) ||
    !exactKeys(input, ["transactionRoot", "bootstrapFacts"]) ||
    typeof input.transactionRoot !== "string" ||
    input.transactionRoot.length === 0 ||
    input.transactionRoot.includes("\0") ||
    !isRecord(input.bootstrapFacts) ||
    !exactKeys(input.bootstrapFacts, ["bootstrapId", "playerId", "companionId"]) ||
    !isOpaque(input.bootstrapFacts.bootstrapId) ||
    !isOpaque(input.bootstrapFacts.playerId) ||
    !isOpaque(input.bootstrapFacts.companionId)
  ) {
    throw new TypeError("invalid_stardew_recoverable_bootstrap_owner_input");
  }
  const root = resolve(input.transactionRoot);
  const ownerPath = join(root, "stardew-private-bootstrap", input.bootstrapFacts.bootstrapId, OWNER_FILE);
  const record = await withPathLock(ownerPath, () => readAndValidateOwner(ownerPath, root), { containmentRoot: root });
  if (
    record.bootstrapId !== input.bootstrapFacts.bootstrapId ||
    record.playerId !== input.bootstrapFacts.playerId ||
    record.companionId !== input.bootstrapFacts.companionId
  ) {
    throw new Error("stardew_bootstrap_owner_recovery_principal_mismatch");
  }
  if (isTerminalOwnerState(record.state)) {
    throw new Error(STARDEW_BOOTSTRAP_OWNER_RECOVERY_TERMINAL_REFUSAL);
  }
  return Object.freeze({
    ownerPath,
    ownerRecordRevision: record.ownerRecordRevision,
    transitions: createStardewBootstrapOwnerTransitionPort(
      createProductionStardewBootstrapOwnerTransitionPrimitives({
        ownerPath,
        containmentRoot: root,
        immutableFence: immutableFenceFor(record),
      }),
      record.ownerRecordRevision,
    ),
    recoveryInstanceId: record.recoveryInstanceId,
    // The credential is composed from this same locked read, never from a second
    // one: the handle's record, fence and CAS revision are the exact predecessor
    // the returned transition port continues from.
    owner: composeRecoverablePlayerHostOwner(durableOwnerStateOver(ownerPath, root, record)),
  });
}

/**
 * The one bounded refusal of "this attempt's durable record is not recoverable".
 *
 * A `contained` record has terminated and drained both roles, and a
 * `quarantined` one is the residue of a cleanup that could not finish, so
 * neither may yield anything a caller could read as recoverable. The opener and
 * the recovery-binding projection meet that one fact at two moments -- opening
 * the attempt, and reading its post-CAS binding -- and they name it with this
 * one code: a consumer that had to tell two names for one decision would
 * eventually read one of them as "the record is fine here", which is exactly
 * the fabricated success this seam must never produce.
 */
export const STARDEW_BOOTSTRAP_OWNER_RECOVERY_TERMINAL_REFUSAL = "stardew_bootstrap_owner_recovery_terminal";

/**
 * The post-CAS recovery binding of an already-opened crashed attempt, projected
 * out of that attempt's own durable record.
 *
 * The opener alone cannot feed a recovery drive: it hands out the record it read
 * when it opened the attempt, while the wire needs the binding facts of the
 * CURRENT record -- the successor the durable `recovering` CAS wrote, read
 * before the one-shot post-CAS classification frame. Those facts exist only
 * inside this attempt's strict v4 record, whose validator is module-private, so
 * this reads them through the very same `readAndValidateOwner` the opener itself
 * uses: one read path, one validator, one durable seam, and no second copy of
 * either.
 *
 * The read is bound to the composer-minted credential the handle carries rather
 * than to the handle's exposed path, so it can only ever read the record OF that
 * attempt: a handle that is not this module's credential refuses with
 * `stardew_owned_player_host_bootstrap_owner_not_registered` instead of reading
 * some other `owner.json`. A record that is terminal refuses with
 * `STARDEW_BOOTSTRAP_OWNER_RECOVERY_TERMINAL_REFUSAL` and returns nothing.
 *
 * What comes back is exactly the fact set the drive's `readRecoveryBinding`
 * contract consumes -- the five Guardian binding facts and the two role states
 * the platform's post-CAS frame encodes -- and nothing else: no path, no process
 * identity, no launch generation, and no lease material beyond the lease NAME
 * the native gate must already name. The absent fields are as much part of that
 * contract as the present ones, because this value reaches a native frame and
 * every extra key would widen what a recovery driver can see with no reader on
 * the other side.
 *
 * Unlike the opener, the read takes no path lock: the opener locks because it
 * sources a CAS cursor and an immutable fence that must belong to one
 * generation, while this is a one-frame snapshot whose durability the engine
 * itself re-checks -- every recovery CAS re-reads the record and validates its
 * exact revision, so a record that moves after this read fails that CAS instead
 * of driving a stale binding.
 */
export async function readRecoverableStardewBootstrapOwnerRecoveryBinding(
  opened: StardewRecoverableBootstrapOwner,
): Promise<TypedPrivateGameFacts> {
  if (typeof opened !== "object" || opened === null) {
    throw new TypeError("invalid_stardew_recoverable_bootstrap_owner_handle");
  }
  const { durableOwner } = requireOwnedPlayerHostBootstrapFacts(opened.owner);
  // `<transactionRoot>/stardew-private-bootstrap/<bootstrapId>` is the exact
  // directory the opener read, and its grandparent is the containment root that
  // boundary-verifies it -- the same two steps the settlement seam above takes
  // from the same durable facts.
  const root = dirname(dirname(durableOwner.transactionDirectory));
  const record = await readAndValidateOwner(join(durableOwner.transactionDirectory, OWNER_FILE), root);
  if (isTerminalOwnerState(record.state)) {
    throw new Error(STARDEW_BOOTSTRAP_OWNER_RECOVERY_TERMINAL_REFUSAL);
  }
  return Object.freeze({
    bindingRevision: record.guardian.bindingRevision,
    ownerRecordRevision: record.ownerRecordRevision,
    leaseName: record.guardian.leaseName,
    playerJobName: record.guardian.playerJobName,
    aiJobName: record.guardian.aiJobName,
    playerHostState: record.playerHostState,
    aiClientState: record.aiClientState,
  });
}

/**
 * Advances the durable owner attempt to `contained` and releases the bound
 * registration pointer through the matching Guardian settlement proof.
 *
 * This is the production replacement for the retired game-layer Guardian owner
 * seam: the durable `owner.json` transitions now live on the same path that
 * actually drives the native arm/launch/contain, so the record can no longer
 * stay `reserved` while the native attempt runs.
 *
 * A settled attempt has terminated and drained both role Jobs, so both roles
 * are durably `contained`: a role the runtime never launched has an empty Job
 * and nothing outside containment. The durable record therefore records both,
 * which is exactly the state its validator requires before it accepts
 * `contained`.
 */
export async function settleOwnedPlayerHostContainedRuntimeAttempt(
  owner: StardewOwnedPlayerHostBootstrap,
  launchedRoles: readonly ("playerHost" | "aiClient")[],
): Promise<void> {
  const proof = await advanceOwnedPlayerHostToContainedAndMintProof(owner, launchedRoles);
  await settleOwnedPlayerHostRegistrationAttempt(owner, proof);
}

/**
 * Closes out a recovery that already reached containment: the durable parent
 * record advances from `recovering` to its terminal `contained` state, and only
 * then is the bound registration pointer released.
 *
 * The two steps are one contract unit because a recovery that reached
 * containment but is never finalized is not recovered in any usable sense: the
 * attempt keeps occupying the registration whose own admission path refuses a
 * non-pristine record, so the next reservation stays refused and the system
 * never returns to a usable state. That is the whole reason this exists.
 *
 * It runs on the same owner path as the recovery drive itself: the durable
 * record is advanced only through that exact owner's consumed one-shot Guardian
 * binding (so a caller cannot close out a recovery it never drove), and the
 * release goes through the same marker/pointer path the explicit endgame uses,
 * so no second durable read/write seam and no second authority is opened.
 *
 * The native recovery is NOT re-driven here. Its result is already settled by
 * the time this runs, and an uncertain native recovery must never be repeated.
 * A finalize the durable engine refuses is never turned into a terminal state by
 * invention: the recovery's own failure closure quarantines it, and the bounded
 * refusal travels back to the caller.
 *
 * Once both durable steps have succeeded, the attempt's own cleanup declaration
 * is consumed: see `consumeRecoveredAttemptCleanup` for what that deletes and
 * what it refuses to delete.
 */
export async function finalizeRecoveredPlayerHostContainedRuntimeAttempt(
  owner: StardewOwnedPlayerHostBootstrap,
  recoveryInstanceId: string,
): Promise<void> {
  return finalizeRecoveredPlayerHostRuntimeAttempt(owner, recoveryInstanceId, "contained");
}

/**
 * Closes out a recovery that reached the AI-side terminal: the durable parent
 * record advances from `recovering` to `ai_settled_player_preserved`, and only
 * then is the bound registration pointer released.
 *
 * It is the sibling of `finalizeRecoveredPlayerHostContainedRuntimeAttempt` and
 * runs on exactly the same owner path, the same consumed one-shot Guardian
 * binding, the same settlement proof and the same cleanup consumption. Only the
 * terminal the durable engine is asked for differs, because only the recovery
 * OUTCOME differs:
 *
 * - `ai_settled_player_preserved` is the outcome where the broker classified
 *   the player role as not contained (the native never adopts the player's
 *   world) and settled the AI side by its own classification, so the
 *   conversation returned before any role CAS. No role is recorded contained,
 *   and this finalize neither claims nor needs one: the terminal transition
 *   refuses a predecessor carrying a role containment.
 *
 * The two durable steps are still one contract unit, for the same reason as the
 * contained finalize: without it the attempt keeps occupying the registration
 * whose own admission path refuses a non-pristine record, so the next
 * reservation - the create path's AND the resume path's alike - stays refused.
 * That is the whole reason this exists.
 *
 * The attempt's cleanup declaration is consumed here too. The AI side really was
 * cleaned up and the player's world needs no retry, so this terminal owes no
 * `retry_required` residue: the attempt's transaction is deleted rather than
 * left as a debt.
 */
export async function finalizeRecoveredPlayerHostAiSettledRuntimeAttempt(
  owner: StardewOwnedPlayerHostBootstrap,
  recoveryInstanceId: string,
): Promise<void> {
  return finalizeRecoveredPlayerHostRuntimeAttempt(owner, recoveryInstanceId, "ai_settled_player_preserved");
}

/**
 * The one finalization body both recovered terminal kinds share. It advances the
 * durable record to the requested terminal through the exact owner's consumed
 * one-shot Guardian binding, mints the settlement proof for that terminal
 * revision, releases the bound registration pointer, and consumes the attempt's
 * cleanup declaration.
 */
async function finalizeRecoveredPlayerHostRuntimeAttempt(
  owner: StardewOwnedPlayerHostBootstrap,
  recoveryInstanceId: string,
  terminal: "contained" | "ai_settled_player_preserved",
): Promise<void> {
  const facts = requireOwnedPlayerHostBootstrapFacts(owner);
  const guardianFacts = guardianOwnerBindings.get(owner);
  if (guardianFacts === undefined || !guardianFacts.consumed) {
    throw new Error("stardew_bootstrap_guardian_owner_binding_not_registered");
  }
  const transitions = guardianFacts.port;
  try {
    if (terminal === "contained") await transitions.finalizeRecoveredContained(recoveryInstanceId);
    else await transitions.finalizeRecoveredAiSettledPlayerPreserved(recoveryInstanceId);
  } catch (error) {
    // A recovery that cannot be taken to its terminal parent state must not stay
    // in a state another authority could mistake for a live recovery, so it runs
    // its own failure closure before the refusal travels back. That closure can
    // refuse too (the record is no longer `recovering`), and then the finalize
    // refusal stays the primary failure rather than being replaced.
    try {
      await transitions.quarantineRecovery(recoveryInstanceId);
    } catch {
      /* the finalize refusal stays primary */
    }
    throw new Error("stardew_bootstrap_owner_recovery_finalize_failed", { cause: error });
  }
  // Minted after the terminal CAS: the settlement proof is bound to the exact
  // terminal revision it was produced for, and the release then verifies that
  // revision against the persisted record.
  const proof = mintStardewBootstrapGuardianSettlementProof(
    owner as unknown as StardewBootstrapGuardianOwnerBinding,
    guardianFacts.settlementBinding,
  );
  await settleOwnedPlayerHostRegistrationAttempt(owner, proof);
  // The recovery is only closed out once the attempt stops occupying disk as
  // well as the registration: both durable steps above succeeded, so the
  // record's own cleanup declaration is consumed here and nowhere earlier. A
  // quarantined attempt keeps its disposition `retry_required` and therefore
  // keeps its residue -- the case this seam deliberately does not cover.
  if (facts.durableOwner.record.cleanupDisposition === "pending") {
    const transactionDirectory = facts.durableOwner.transactionDirectory;
    await consumeRecoveredAttemptCleanup(
      transactionDirectory,
      facts.durableOwner.record.managedPaths,
      dirname(dirname(transactionDirectory)),
    );
  }
}

/**
 * The declared managed paths of one attempt, deepest first and with the record
 * last.
 *
 * Deepest first is what lets a declared directory tree be removed without ever
 * deleting something the record did not declare: every declared child is gone
 * before its parent is offered for removal. The record goes last because it is
 * the declaration itself, so a partial failure still leaves behind the record
 * that says what is owed.
 */
function declaredManagedPathOrder(managedPaths: readonly string[]): readonly string[] {
  const ordered = [...managedPaths].sort((left, right) => right.split("/").length - left.split("/").length);
  const recordIndex = ordered.indexOf(OWNER_FILE);
  if (recordIndex >= 0) {
    const [recordPath] = ordered.splice(recordIndex, 1);
    if (recordPath !== undefined) ordered.push(recordPath);
  }
  return ordered;
}

/**
 * Consumes one attempt's cleanup declaration in place: the declared managed
 * paths are deleted under the attempt's transaction directory after its
 * recovery has been closed out.
 *
 * Why it exists: `cleanupDisposition`/`managedPaths` were written and validated
 * by every transition but never consumed, so a crashed attempt left its whole
 * transaction directory (the owner record plus any staged role profile) on disk
 * for good, one per crash.
 *
 * The declaration is the entire delete surface. Every path comes out of the
 * durable record; directories are removed only once they are empty (`rmdir`,
 * never recursive) and files only through the identity-bound `removeSafeFile`,
 * so an undeclared child keeps its parent and nothing undeclared is ever
 * removed -- not the transaction directory itself, not the lock leaf, not an
 * undeclared subtree. A resolved path that is not inside the attempt's own
 * directory throws instead of being resolved through it.
 *
 * It is idempotent: a path that is already gone is not a failure, and neither is
 * a declared directory that still holds something this attempt did not declare
 * -- refusal to widen the surface is the honest outcome rather than recursing
 * into it. Every other failure travels back as its own bounded refusal instead
 * of being swallowed: the attempt was not cleaned, and nothing may report that
 * it was.
 */
async function consumeRecoveredAttemptCleanup(
  transactionDirectory: string,
  managedPaths: readonly string[],
  runtimeRoot: string,
): Promise<void> {
  const attemptRoot = resolve(transactionDirectory);
  for (const declared of declaredManagedPathOrder(managedPaths)) {
    const target = resolve(attemptRoot, declared);
    const relativePath = relative(attemptRoot, target);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("stardew_bootstrap_attempt_cleanup_failed");
    }
    try {
      const stat = await lstat(target);
      // A link is never a managed path: following it would delete whatever it
      // points at, which the record never declared.
      if (stat.isSymbolicLink()) throw new Error("unsafe_path_boundary");
      if (stat.isDirectory()) {
        await removeDeclaredDirectoryLinks(target);
        await readSafeDirectory(target, runtimeRoot);
        await rmdir(target);
      } else {
        await removeSafeFile(target, runtimeRoot);
      }
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) continue;
      throw new Error("stardew_bootstrap_attempt_cleanup_failed", { cause: error });
    }
  }
}

/**
 * Removes the link children a declared directory may hold - the player Mods
 * population a Player Host launch carried in - without ever following one: the
 * link itself is unlinked, so a junction into the player's own `Mods` costs its
 * directory entry and nothing under its target is touched.
 *
 * Recursion is deliberately absent. `readSafeDirectory` still refuses a link
 * child that remains, so a link this cannot remove fails the cleanup loudly
 * instead of being walked, and an undeclared real child still keeps its parent
 * exactly as before.
 */
async function removeDeclaredDirectoryLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    const entryPath = resolve(directory, entry);
    if ((await lstat(entryPath)).isSymbolicLink()) await unlink(entryPath);
  }
}

/**
 * The first half of the production settlement, split so the release rules can be
 * observed directly: drive the durable record to its terminal `contained` state
 * and mint the matching proof, without touching the registration pointer.
 */
export async function advanceOwnedPlayerHostToContainedAndMintProof(
  owner: StardewOwnedPlayerHostBootstrap,
  launchedRoles: readonly ("playerHost" | "aiClient")[],
): Promise<StardewBootstrapGuardianSettlementProof> {
  requireOwnedPlayerHostBootstrapFacts(owner);
  const guardianFacts = guardianOwnerBindings.get(owner);
  if (guardianFacts === undefined || !guardianFacts.consumed) {
    throw new Error("stardew_bootstrap_guardian_owner_binding_not_registered");
  }
  const transitions = guardianFacts.port;
  const binding = owner as unknown as StardewBootstrapGuardianOwnerBinding;
  // Catch the durable record up to what actually happened, in the exact order
  // its validator requires. Production drives native arm/launch/contain through
  // the generic contained runtime, which deliberately has no Stardew durable
  // types, so the attempt's durable record is advanced here — at the only point
  // where the exact owner, the launched roles and the proof authority meet.
  //
  // Arm always preceded a launch by this same attempt, so recording it is true.
  await transitions.armAcknowledged();
  for (const role of launchedRoles) await transitions.roleActive(role);
  await transitions.beginControlledClose();
  // An endgame terminates and drains both role Jobs, so both roles are durably
  // contained: a role the runtime never launched still has a Job (empty) with
  // nothing left outside containment. The validator requires both.
  await transitions.controlledRoleContained("playerHost");
  await transitions.controlledRoleContained("aiClient");
  await transitions.finalizeControlledContained();
  return mintStardewBootstrapGuardianSettlementProof(binding, guardianFacts.settlementBinding);
}

export function mintStardewBootstrapGuardianSettlementProof(
  binding: StardewBootstrapGuardianOwnerBinding,
  settlementBinding: object,
): StardewBootstrapGuardianSettlementProof {
  const facts = guardianOwnerBindings.get(binding);
  if (facts === undefined || !facts.consumed || facts.settlementBinding !== settlementBinding) {
    throw new Error("stardew_bootstrap_guardian_settlement_proof_unavailable");
  }
  const proof = Object.freeze(Object.create(null)) as StardewBootstrapGuardianSettlementProof;
  guardianSettlementProofs.set(proof, {
    settlementBinding,
    immutableFence: facts.immutableFence,
    expectedTerminalOwnerRecordRevision: facts.currentOwnerRecordRevision,
    state: "available",
  });
  return proof;
}

type ReservedStardewBootstrapGuardianSettlementProof = Readonly<{
  readonly immutableFence: StardewOwnerImmutableFence;
  readonly expectedTerminalOwnerRecordRevision: number;
  commit(): void;
  restore(): void;
}>;

function reserveStardewBootstrapGuardianSettlementProof(
  owner: StardewOwnedPlayerHostBootstrap,
  proof: StardewBootstrapGuardianSettlementProof,
): ReservedStardewBootstrapGuardianSettlementProof {
  const proofFacts = typeof proof === "object" && proof !== null ? guardianSettlementProofs.get(proof) : undefined;
  const ownerFacts = guardianOwnerBindings.get(owner);
  if (
    proofFacts === undefined ||
    ownerFacts === undefined ||
    proofFacts.settlementBinding !== ownerFacts.settlementBinding ||
    JSON.stringify(ownerFacts.immutableFence) !== JSON.stringify(proofFacts.immutableFence) ||
    proofFacts.state !== "available"
  ) {
    throw new Error("stardew_bootstrap_guardian_settlement_proof_unavailable");
  }
  proofFacts.state = "reserved";
  return Object.freeze({
    immutableFence: proofFacts.immutableFence,
    expectedTerminalOwnerRecordRevision: proofFacts.expectedTerminalOwnerRecordRevision,
    commit: () => {
      if (proofFacts.state !== "reserved") {
        throw new Error("stardew_bootstrap_guardian_settlement_proof_unavailable");
      }
      proofFacts.state = "consumed";
    },
    restore: () => {
      if (proofFacts.state === "reserved") proofFacts.state = "available";
    },
  });
}

function sameImmutableFence(owner: StardewPrivateBootstrapOwnerRecord, fence: StardewOwnerImmutableFence): boolean {
  return (
    owner.bootstrapId === fence.bootstrapId &&
    owner.playerId === fence.playerId &&
    owner.companionId === fence.companionId &&
    JSON.stringify(owner.guardian) === JSON.stringify(fence.guardian)
  );
}

export type StardewGuardianArmBindingRead = Readonly<{
  ownerPath: string;
  containmentRoot: string;
  bootstrapId: string;
  playerId: string;
  companionId: string;
  expectedRevision: string;
  expectedOwnerRecordRevision: number;
  nowMs: number;
}>;

/** Composition-private projection of the sole strict owner record. */
export async function readStardewGuardianArmBinding(
  input: StardewGuardianArmBindingRead,
): Promise<StardewGuardianBinding> {
  const owner = await readAndValidateOwner(input.ownerPath, input.containmentRoot);
  if (
    owner.bootstrapId !== input.bootstrapId ||
    owner.playerId !== input.playerId ||
    owner.companionId !== input.companionId ||
    owner.guardian.bindingRevision !== input.expectedRevision ||
    owner.ownerRecordRevision !== input.expectedOwnerRecordRevision ||
    owner.expiresAtMs <= input.nowMs ||
    owner.state !== "reserved" ||
    owner.guardianState !== "reserved" ||
    owner.playerHostState !== "reserved" ||
    owner.aiClientState !== "reserved" ||
    owner.recoveryInstanceId !== null ||
    owner.managedPaths.length !== 1 ||
    owner.managedPaths[0] !== OWNER_FILE
  )
    throw new Error("stardew_bootstrap_guardian_arm_binding_mismatch");
  return Object.freeze({
    ...owner.guardian,
    ownerRecordRevision: owner.ownerRecordRevision,
  }) as StardewGuardianBinding & Readonly<{ ownerRecordRevision: number }>;
}

async function readAndValidateOwner(path: string, root: string): Promise<StardewPrivateBootstrapOwnerRecord> {
  await verifySafePathBoundary(path, root);
  return validateOwnerRecord(await readStrictJsonFile(path, MAX_OWNER_RECORD_BYTES));
}

/** One exact strict v4 validator for persisted bytes and in-memory successors. */
function validateOwnerRecord(value: unknown): StardewPrivateBootstrapOwnerRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schema",
      "bootstrapId",
      "playerId",
      "companionId",
      "guardian",
      "ownerRecordRevision",
      "state",
      "guardianState",
      "playerHostState",
      "aiClientState",
      "recoveryInstanceId",
      "playerHost",
      "aiClient",
      "expiresAtMs",
      "cleanupDisposition",
      "managedPaths",
    ]) ||
    value.schema !== OWNER_SCHEMA ||
    !isOpaque(value.bootstrapId) ||
    !isOpaque(value.playerId) ||
    !isOpaque(value.companionId) ||
    !isGuardianBinding(value.guardian) ||
    (!isExternalPlayerHost(value.playerHost) && !isReservedPlayerHost(value.playerHost)) ||
    !isReservedAiClient(value.aiClient) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    !isPositiveBoundedInteger(value.ownerRecordRevision) ||
    (value.cleanupDisposition !== "pending" && value.cleanupDisposition !== "retry_required") ||
    !isOwnerStateMatrix(value) ||
    !isManagedPathSet(value.managedPaths)
  )
    throw new Error("invalid_stardew_bootstrap_owner");
  return freezeRecord(value as unknown as StardewPrivateBootstrapOwnerRecord);
}

function validateBootstrapRequest(value: unknown, nowMs: number): asserts value is StardewPlayerHostBootstrapRequest {
  if (
    !isRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !exactKeys(value, ["playerId", "companionId", "browserSessionId", "expiresAtMs"]) ||
    !isOpaque(value.playerId) ||
    !isOpaque(value.companionId) ||
    !isOpaque(value.browserSessionId) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    (value.expiresAtMs as number) <= nowMs ||
    (value.expiresAtMs as number) > nowMs + 10 * 60_000
  )
    throw new TypeError("invalid_stardew_bootstrap_request");
}

function validateBootstrapFacts(facts: StardewPrivateBootstrapFacts, nowMs: number): void {
  if (
    !isRecord(facts) ||
    !exactKeys(facts, ["bootstrapId", "playerId", "companionId", "expiresAtMs"]) ||
    !isOpaque(facts.bootstrapId) ||
    !isOpaque(facts.playerId) ||
    !isOpaque(facts.companionId) ||
    !Number.isSafeInteger(facts.expiresAtMs) ||
    facts.expiresAtMs <= nowMs
  )
    throw new TypeError("invalid_stardew_bootstrap_facts");
}

function validateTestingDependencies(value: StardewPrivateBootstrapCoreDependencies): void {
  if (!isRecord(value)) throw new TypeError("invalid_stardew_private_bootstrap_testing_dependencies");
  const optionalKeys = value.staging === undefined ? [] : ["staging"];
  if (
    !exactKeys(value, [
      "rawSpawn",
      "rawProbe",
      "rawPlayerHostSpawn",
      "rawPlayerHostProbe",
      "createBootstrapIdentity",
      "createGuardianRevision",
      "createGuardianInstanceId",
      "createGuardianEpoch",
      "createGuardianLeaseName",
      "createGuardianPlayerJobName",
      "createGuardianAiJobName",
      "createLaunchGeneration",
      "createPlayerHostLaunchGeneration",
      "createBridgePipeName",
      "createBridgeToken",
      "nowMs",
      ...optionalKeys,
    ]) ||
    typeof value.rawSpawn !== "function" ||
    typeof value.rawProbe !== "function" ||
    typeof value.rawPlayerHostSpawn !== "function" ||
    typeof value.rawPlayerHostProbe !== "function" ||
    typeof value.createBootstrapIdentity !== "function" ||
    typeof value.createGuardianRevision !== "function" ||
    typeof value.createGuardianInstanceId !== "function" ||
    typeof value.createGuardianEpoch !== "function" ||
    typeof value.createGuardianLeaseName !== "function" ||
    typeof value.createGuardianPlayerJobName !== "function" ||
    typeof value.createGuardianAiJobName !== "function" ||
    typeof value.createLaunchGeneration !== "function" ||
    typeof value.createPlayerHostLaunchGeneration !== "function" ||
    typeof value.createBridgePipeName !== "function" ||
    typeof value.createBridgeToken !== "function" ||
    typeof value.nowMs !== "function" ||
    (value.staging !== undefined && !isPrivateModProfileStagingDependencies(value.staging))
  ) {
    throw new TypeError("invalid_stardew_private_bootstrap_testing_dependencies");
  }
}

function isPrivateModProfileStagingDependencies(value: unknown): value is PrivateModProfileStagingDependencies {
  return (
    isRecord(value) &&
    // The reader is optional; the other three are the dependency's own body. A staging object that carries it is still a
    // staging object - and one that does not is what a fixture and a root without a readable profile both look like.
    exactKeys(
      value,
      value.readCompanionDisplayName === undefined
        ? ["readPackage", "createSecret", "nowMs"]
        : ["readPackage", "createSecret", "nowMs", "readCompanionDisplayName"],
    ) &&
    typeof value.readPackage === "function" &&
    typeof value.createSecret === "function" &&
    typeof value.nowMs === "function" &&
    (value.readCompanionDisplayName === undefined || typeof value.readCompanionDisplayName === "function")
  );
}

function isManagedPathSet(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string")) return false;
  const expected =
    value.length === 1
      ? [OWNER_FILE]
      : value.length === PHASE_B_MANAGED_PATHS.length
        ? PHASE_B_MANAGED_PATHS
        : value.length === C1_MANAGED_PATHS.length
          ? C1_MANAGED_PATHS
          : [];
  return value.length === expected.length && value.every((path, index) => path === expected[index]);
}

function isExternalPlayerHost(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["kind"]) && value.kind === "external_unattested";
}

function isGuardianBinding(value: unknown): value is StardewGuardianBinding {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "bindingRevision",
      "guardianInstanceId",
      "guardianEpoch",
      "leaseName",
      "playerJobName",
      "aiJobName",
    ]) &&
    isOpaque(value.bindingRevision) &&
    isOpaque(value.guardianInstanceId) &&
    isPositiveBoundedInteger(value.guardianEpoch) &&
    isGuardianName(value.leaseName) &&
    isGuardianName(value.playerJobName) &&
    isGuardianName(value.aiJobName) &&
    new Set([value.leaseName, value.playerJobName, value.aiJobName]).size === 3
  );
}

function isPositiveBoundedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function isOwnerStateMatrix(value: Record<string, unknown>): boolean {
  const parent = value.state;
  const guardian = value.guardianState;
  const player = value.playerHostState;
  const ai = value.aiClientState;
  const recovery = value.recoveryInstanceId;
  const role = (item: unknown): item is "reserved" | "armed" | "active" | "closing" | "contained" | "quarantined" =>
    item === "reserved" ||
    item === "armed" ||
    item === "active" ||
    item === "closing" ||
    item === "contained" ||
    item === "quarantined";
  if (!role(player) || !role(ai)) return false;
  if (parent === "reserved" && guardian === "reserved")
    return player === "reserved" && ai === "reserved" && recovery === null && value.cleanupDisposition === "pending";
  // Arm is atomic for the Guardian and both role Jobs: an armed Guardian can
  // never coexist with a never-armed role.
  if (parent === "reserved" && guardian === "armed")
    return (
      recovery === null &&
      value.cleanupDisposition === "pending" &&
      [player, ai].every((item) => item === "armed" || item === "active" || item === "contained")
    );
  if (parent === "closing" && guardian === "closing")
    return (
      recovery === null &&
      value.cleanupDisposition === "pending" &&
      [player, ai].every((item) => item === "closing" || item === "contained")
    );
  if (parent === "recovering" && guardian === "recovering") {
    if (!isOpaque(recovery) || value.cleanupDisposition !== "pending") return false;
    const belongsTo = (states: readonly string[]) =>
      [player, ai].every((item) => item === "contained" || states.includes(item as string));
    return belongsTo(["reserved"]) || belongsTo(["armed", "active"]) || belongsTo(["closing"]);
  }
  if (parent === "contained" && guardian === "contained")
    return player === "contained" && ai === "contained" && recovery === null && value.cleanupDisposition === "pending";
  if (parent === "quarantined" && guardian === "quarantined")
    return (
      recovery === null &&
      value.cleanupDisposition === "retry_required" &&
      [player, ai].every((item) => item === "contained" || item === "quarantined") &&
      (player === "quarantined" || ai === "quarantined")
    );
  if (parent === "ai_settled_player_preserved" && guardian === "ai_settled_player_preserved") {
    if (recovery !== null || value.cleanupDisposition !== "pending") return false;
    const neverContained = (states: readonly string[]) => [player, ai].every((item) => states.includes(item as string));
    return neverContained(["reserved"]) || neverContained(["armed", "active"]) || neverContained(["closing"]);
  }
  return false;
}

function isGuardianName(value: unknown): value is string {
  return typeof value === "string" && /^Local\\[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isReservedPlayerHost(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ["kind", "launchGeneration"]) &&
    value.kind === "launch_reserved" &&
    isOpaque(value.launchGeneration)
  );
}

function isReservedAiClient(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ["kind", "launchGeneration"]) &&
    value.kind === "launch_reserved" &&
    isOpaque(value.launchGeneration)
  );
}

function isOpaque(value: unknown): value is string {
  return typeof value === "string" && OPAQUE.test(value);
}

/**
 * The most the role's environment may weigh in the launch frame.
 *
 * The frame that carries it is base64url'd into one Guardian session frame bounded at
 * 16 384 bytes (`MAX_GUARDIAN_WIRE_BYTES`, which is the Desktop broker's own
 * `MaxWireBytes`), so the environment's share of that frame has to be stated instead of
 * inherited. What a role legitimately needs is two system directories, one temp
 * directory, the profile and one bounded generation - a few hundred bytes - so this
 * leaves the plan's own absolute paths their room. Measured on the machine that failed:
 * 17 069 forwarded PATH characters were the whole difference between a launch that
 * shipped and one the Host refused before writing it.
 */
export const STARDEW_CHILD_ENVIRONMENT_MAX_BYTES = 1_024;

/**
 * The exact role environment for one launch invocation.
 *
 * Every value is a fact the Host reads for the role itself; nothing is copied wholesale,
 * and `PATH` is absent because nothing in the role resolves a name (see
 * `STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS`). A value that would push the environment past
 * its stated budget is refused here, where the code can still name it, instead of
 * surfacing later as a frame too large to send.
 */
export function createStardewChildEnvironment(launchGeneration: string): StardewPrivateChildEnvironment {
  if (!isOpaque(launchGeneration)) throw new Error("invalid_stardew_child_launch_generation");
  const required = (name: string): string => {
    const value = process.env[name];
    if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
      throw new Error("stardew_child_environment_invalid");
    return value;
  };
  const environment: StardewPrivateChildEnvironment = {
    SystemRoot: required("SystemRoot"),
    WINDIR: required("WINDIR"),
    TEMP: required("TEMP"),
    TMP: required("TMP"),
    USERPROFILE: required("USERPROFILE"),
    [LAUNCH_GENERATION_ENVIRONMENT_VARIABLE]: launchGeneration,
  };
  if (Buffer.byteLength(JSON.stringify(environment), "utf8") > STARDEW_CHILD_ENVIRONMENT_MAX_BYTES)
    throw new Error("stardew_child_environment_too_long");
  return Object.freeze(environment);
}

function freezeBootstrapFacts(
  facts: Readonly<{
    bootstrapId: string;
    playerId: string;
    companionId: string;
    expiresAtMs: number;
  }>,
): StardewPrivateBootstrapFacts {
  return Object.freeze({
    bootstrapId: facts.bootstrapId,
    playerId: facts.playerId,
    companionId: facts.companionId,
    expiresAtMs: facts.expiresAtMs,
  });
}

function freezeRecord<T extends StardewPrivateBootstrapOwnerRecord>(value: T): T {
  return Object.freeze({
    ...value,
    guardian: Object.freeze({ ...value.guardian }),
    playerHost: Object.freeze({ ...value.playerHost }),
    aiClient: Object.freeze({ ...value.aiClient }),
    managedPaths: Object.freeze([...value.managedPaths]),
  }) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
