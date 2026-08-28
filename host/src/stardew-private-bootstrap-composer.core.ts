import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LaunchAiClientInput,
  type StardewAiClientLaunchReservation,
  type StardewAiClientProcessOwner,
  type StardewAiClientProcessProbe,
  type StardewAiClientProcessProbeResult,
  type StardewAiClientProcessSpawn,
  type StardewAiClientProcessSpawnResult,
  type StardewAiClientProcessStatus,
  type StopOwnedAiClientResult,
} from "./stardew-ai-client-process-owner.js";
import {
  type StardewPlayerHostBootstrapBroker,
  type StardewPlayerHostBootstrapCapability,
  type StardewPlayerHostBootstrapClaim,
  type StardewPlayerHostBootstrapRequest,
  type StardewPlayerHostBootstrapView,
} from "./stardew-player-host-bootstrap.js";
import {
  type LaunchPlayerHostInput,
  type StardewPlayerHostLaunchReservation,
  type StardewPlayerHostProcessOwner,
  type StardewPlayerHostProcessProbe,
  type StardewPlayerHostProcessProbeResult,
  type StardewPlayerHostProcessSpawn,
  type StardewPlayerHostProcessSpawnResult,
  type StardewPlayerHostProcessStatus,
  type StopOwnedPlayerHostResult,
} from "./stardew-player-host-process-owner.js";
import {
  consumeAdmittedStardewInstallation,
  type AdmittedStardewInstallation,
} from "./stardew-installation-admission.core.js";
import {
  atomicWriteFile,
  captureSafeFileIdentity,
  pathLockPath,
  readSafeDirectory,
  removeOwnedSafeFile,
  verifySafePathBoundary,
  withPathLock,
} from "./path-lock.js";
import {
  readPublishedStardewModPackageContract,
  verifyPublishedStardewModPackage,
} from "./stardew-mod-package-contract.js";
import { createStardewRoleLifecycleFacade } from "./stardew-role-lifecycle-facade.js";
import {
  StardewAttachmentFlow,
  type StardewJoinManifest,
  type StardewVerifiedCabinChoice,
} from "./stardew-attachment.js";
import { createPublishedWindowsReparseInspector } from "./windows-reparse-inspector/index.js";
import type {
  StardewAiClientLaunch,
  StardewExternalPlayerHostBootstrapOwnerRecord,
  StardewExternalPlayerHostPhaseAOwner,
  StardewOwnedPlayerHostBootstrapOwnerRecord,
  StardewOwnedPlayerHostPhaseAOwner,
  StardewPlayerHostLaunch,
  StardewPrivateBootstrapComposition,
  StardewPrivateBootstrapOwnerRecord,
} from "./stardew-private-bootstrap-composer.js";

const OWNER_SCHEMA = "gamebuddy-stardew-private-bootstrap-owner/v2";
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
const PHASE_B_PACKAGE_ENTRIES = Object.freeze([
  "GameBuddy.Stardew.Core.dll",
  "GameBuddy.Stardew.deps.json",
  "GameBuddy.Stardew.dll",
  "Raffinert.FuzzySharp.dll",
  "manifest.json",
] as const);
const PHASE_B_MANAGED_PATHS = Object.freeze([
  OWNER_FILE,
  HOST_PROFILE_ROOT,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${MOD_CONFIG_FILE}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[0]}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[1]}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[2]}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[3]}`,
  `${HOST_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[4]}`,
] as const);
const AI_CLIENT_PROFILE_ROOT = "ai-client";
const AI_CLIENT_MANAGED_PATHS = Object.freeze([
  AI_CLIENT_PROFILE_ROOT,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${MOD_CONFIG_FILE}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[0]}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[1]}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[2]}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[3]}`,
  `${AI_CLIENT_PROFILE_ROOT}/${MODS_DIRECTORY}/${MOD_DIRECTORY}/${PHASE_B_PACKAGE_ENTRIES[4]}`,
] as const);
const C1_MANAGED_PATHS = Object.freeze([
  ...PHASE_B_MANAGED_PATHS,
  ...AI_CLIENT_MANAGED_PATHS,
] as const);

type RegistrationState = "available" | "binding" | "consumed";
type LaunchState = "available" | "binding" | "consumed" | "revoked";

type StardewPrivateBootstrapFacts = Readonly<{
  bootstrapId: string;
  playerId: string;
  companionId: string;
  expiresAtMs: number;
}>;

type StardewAiClientLaunchRegistration = Readonly<{
  launchGeneration: string;
  launch(input: LaunchAiClientInput): Readonly<{
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
  revoke(): void;
}>;

type PlayerHostLaunchRegistration = {
  state: RegistrationState;
  readonly registration: StardewPlayerHostLaunchRegistration;
};

type StardewPrivateBootstrapOwnerRecordBase = Readonly<{
  schema: typeof OWNER_SCHEMA;
  bootstrapId: string;
  playerId: string;
  companionId: string;
  aiClient: Readonly<{
    kind: "launch_reserved";
    launchGeneration: string;
  }>;
  expiresAtMs: number;
  state: "reserved" | "quarantined";
  cleanupDisposition: "pending" | "retry_required";
  managedPaths: readonly string[];
}>;

export type StardewPrivateBootstrapCoreDependencies = Readonly<{
  rawSpawn: StardewAiClientProcessSpawn;
  rawProbe: StardewAiClientProcessProbe;
  rawPlayerHostSpawn: StardewPlayerHostProcessSpawn;
  rawPlayerHostProbe: StardewPlayerHostProcessProbe;
  createBootstrapIdentity: () => string;
  createLaunchGeneration: () => string;
  createPlayerHostLaunchGeneration: () => string;
  nowMs: () => number;
  staging?: PrivateModProfileStagingDependencies;
}>;

/**
 * Constructs the complete production Phase A authority boundary for both the
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
type StardewManifestAdmission = Readonly<{  readonly [stardewManifestAdmissionBrand]: never;
}>;

export type StardewManifestHandoffCoordinator = Readonly<{
  select(
    owner: StardewOwnedPlayerHostPhaseAOwner,
    candidateCabinId: string,
  ): Promise<StardewManifestHandoffSelection>;
  confirmAndAdmit(
    selection: StardewManifestHandoffSelection,
    confirmation: Readonly<{ confirmed: true }>,
  ): Promise<StardewManifestAdmission>;
}>;

type StardewManifestAdmissionValue = Awaited<ReturnType<StardewManifestHandoffCoordinator["confirmAndAdmit"]>>;

type MaterializeAiClientProfileAfterManifestAdmission = (
  owner: StardewOwnedPlayerHostPhaseAOwner,
  admission: StardewManifestAdmissionValue,
) => Promise<void>;

export type StardewPrivateBootstrapInternalComposition = Readonly<{
  readonly composition: StardewPrivateBootstrapComposition;
  createOwnedPlayerHostAttachmentFlow(owner: StardewOwnedPlayerHostPhaseAOwner): StardewAttachmentFlow;
  createOwnedPlayerHostManifestHandoffCoordinator(): StardewManifestHandoffCoordinator;
  materializeAiClientProfileAfterManifestAdmission(
    owner: StardewOwnedPlayerHostPhaseAOwner,
    admission: StardewManifestAdmission,
  ): Promise<void>;
  launchOwnedPlayerHostStageC(
    owner: StardewOwnedPlayerHostPhaseAOwner,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
}>;

export function createStardewPrivateBootstrapProductionCore(): StardewPrivateBootstrapInternalComposition {
  if (platform() !== "win32") {
    throw new Error("stardew_private_bootstrap_composition_requires_windows");
  }
  const closed = createStardewPrivateBootstrapCore({
    rawSpawn: productionSpawn,
    rawProbe: productionProbe,
    rawPlayerHostSpawn: productionPlayerHostSpawn,
    rawPlayerHostProbe: productionPlayerHostProbe,
    createBootstrapIdentity: randomUUID,
    createLaunchGeneration: randomUUID,
    createPlayerHostLaunchGeneration: randomUUID,
    nowMs: Date.now,
  });
  return Object.freeze({
    composition: closed.composition,
    createOwnedPlayerHostAttachmentFlow: closed.createOwnedPlayerHostAttachmentFlow,
     createOwnedPlayerHostManifestHandoffCoordinator: closed.createOwnedPlayerHostManifestHandoffCoordinator,
     materializeAiClientProfileAfterManifestAdmission: closed.materializeAiClientProfileAfterManifestAdmission,
     launchOwnedPlayerHostStageC: closed.launchOwnedPlayerHostStageC,
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
}>;

export function createStardewPrivateBootstrapTestCore(
  dependencies: StardewPrivateBootstrapCoreDependencies,
): Readonly<{
   composition: StardewPrivateBootstrapComposition;
   consumeStagedOwnedPlayerHostPhaseB(owner: StardewOwnedPlayerHostPhaseAOwner): void;
   createOwnedPlayerHostAttachmentFlow(owner: StardewOwnedPlayerHostPhaseAOwner): StardewAttachmentFlow;
   createOwnedPlayerHostManifestHandoffCoordinator(): StardewManifestHandoffCoordinator;
   materializeAiClientProfileAfterManifestAdmission: MaterializeAiClientProfileAfterManifestAdmission;
   launchOwnedPlayerHostStageC(
     owner: StardewOwnedPlayerHostPhaseAOwner,
     installation: AdmittedStardewInstallation,
   ): Promise<StardewOwnedPlayerHostStageCResult>;
   bindOwnedPlayerHostPhaseAOwner(
    owner: StardewOwnedPlayerHostPhaseAOwner,
  ): StardewOwnedPlayerHostPhaseACoreTestView;
}> {
  validateTestingDependencies(dependencies);
  const base = createStardewPrivateBootstrapCore(dependencies);
  const owned = new WeakSet<object>();
  const reserveOwnedPlayerHostPhaseA = base.composition.reserveOwnedPlayerHostPhaseA.bind(base.composition);
  const composition: StardewPrivateBootstrapComposition = Object.freeze({
    ...base.composition,
    async reserveOwnedPlayerHostPhaseA(...args) {
      const owner = await reserveOwnedPlayerHostPhaseA(...args);
      owned.add(owner);
      return owner;
    },
  });
  return Object.freeze({
    composition,
    consumeStagedOwnedPlayerHostPhaseB(owner) {
      // Composition-bound test-only staged consume: the base closed
      // composition supplies its stored identity, so owners minted by any
      // other composition are rejected before the staged marker changes.
      base.consumeStagedOwnedPlayerHostPhaseB(owner);
    },
     createOwnedPlayerHostAttachmentFlow(owner) {
       // Composition-bound test-only attachment factory: the base closed
       // composition supplies its stored identity, so forged and cross-
       // composition owners are rejected before any flow is constructed.
       return base.createOwnedPlayerHostAttachmentFlow(owner);
     },
     createOwnedPlayerHostManifestHandoffCoordinator() {
       return base.createOwnedPlayerHostManifestHandoffCoordinator();
     },
     materializeAiClientProfileAfterManifestAdmission(owner, admission) {
       return base.materializeAiClientProfileAfterManifestAdmission(owner, admission);
     },
     launchOwnedPlayerHostStageC(owner, installation) {
      // Composition-bound test-only Stage-C launch: the base closed
      // composition supplies its stored identity, so forged and
      // cross-composition owners are rejected before the launch attempt.
      return base.launchOwnedPlayerHostStageC(owner, installation);
    },
    bindOwnedPlayerHostPhaseAOwner(owner) {
      if (!owned.has(owner)) throw new Error("stardew_owned_phase_a_owner_not_registered");
      const facts = requireOwnedPhaseAFacts(owner);
      return Object.freeze({
        get record() { return facts.durableOwner.record as StardewOwnedPlayerHostBootstrapOwnerRecord; },
        get transactionDirectory() { return facts.durableOwner.transactionDirectory; },
        quarantine: facts.quarantineOwner,
        consumePlayerHostLaunch: facts.consumePlayerHostLaunch,
        consumeAiClientLaunch: facts.consumeAiClientLaunch,
        hasPrivateMaterial: () => facts.privateMaterial.value !== null,
      });
    },
  });
}

function createStardewPrivateBootstrapCore(
  dependencies: StardewPrivateBootstrapCoreDependencies,
): ClosedBootstrapCore {
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
  consumeStagedOwnedPlayerHostPhaseB(owner: StardewOwnedPlayerHostPhaseAOwner): void;
  createOwnedPlayerHostAttachmentFlow(owner: StardewOwnedPlayerHostPhaseAOwner): StardewAttachmentFlow;
  createOwnedPlayerHostManifestHandoffCoordinator(): StardewManifestHandoffCoordinator;
  materializeAiClientProfileAfterManifestAdmission: MaterializeAiClientProfileAfterManifestAdmission;
  launchOwnedPlayerHostStageC(
    owner: StardewOwnedPlayerHostPhaseAOwner,
    installation: AdmittedStardewInstallation,
  ): Promise<StardewOwnedPlayerHostStageCResult>;
}>;

function createClosedComposition(
  dependencies: StardewPrivateBootstrapCoreDependencies,
): ClosedBootstrapCore {
  const stagingDependencies = dependencies.staging === undefined
    ? undefined
    : Object.freeze({ ...dependencies.staging });
  const compositionIdentity = Object.freeze({});
  const claims = new WeakMap<StardewPlayerHostBootstrapClaim, ClaimRegistration>();
  const playerHostLaunches = new WeakMap<StardewPlayerHostLaunchReservation, PlayerHostLaunchRegistration>();
  const aiLaunches = new WeakMap<StardewAiClientLaunchReservation, AiLaunchRegistration>();
  const manifestHandoff = createManifestHandoffCoordinatorCore(
    compositionIdentity,
    dependencies.nowMs,
    () => stagingDependencies ?? productionStagingDependencies(),
  );
  const manifestHandoffCoordinator = manifestHandoff.coordinator;

  const registerConsumedClaim = (
    claim: StardewPlayerHostBootstrapClaim,
    facts: StardewPrivateBootstrapFacts,
  ): void => {
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
    if (aiLaunches.has(reservation))
      throw new Error("stardew_ai_client_reservation_already_registered");
    aiLaunches.set(reservation, {
      state: "available",
      registration,
    });
  };

  const registerPlayerHostLaunch = (
    reservation: StardewPlayerHostLaunchReservation,
    registration: StardewPlayerHostLaunchRegistration,
  ): void => {
    if (playerHostLaunches.has(reservation))
      throw new Error("stardew_player_host_reservation_already_registered");
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
      return createStardewRoleLifecycleFacade(attachment, aiClientProcessOwner);
    },
    async reserveExternalPlayerHostPhaseA(runtimeRoot, claim, aiClientReservation) {
      const claimRegistration = claims.get(claim);
      if (claimRegistration === undefined)
        throw new Error("stardew_bootstrap_claim_not_registered");
      const aiLaunchRegistration = aiLaunches.get(aiClientReservation);
      if (aiLaunchRegistration === undefined)
        throw new Error("stardew_ai_client_reservation_not_registered");
      if (claimRegistration.state !== "available")
        throw new Error("stardew_bootstrap_claim_not_available");
      if (aiLaunchRegistration.state !== "available")
        throw new Error("stardew_ai_client_reservation_not_available");

      // Bind exact nominal identities synchronously before persistence awaits.
      claimRegistration.state = "binding";
      aiLaunchRegistration.state = "binding";

      let durableOwner: DurableOwnerFor<StardewExternalPlayerHostBootstrapOwnerRecord>;
      try {
        durableOwner = await persistPrivateBootstrapOwner({
          runtimeRoot,
          bootstrapFacts: claimRegistration.facts,
          playerHost: { kind: "external_unattested" as const },
          aiClientLaunchGeneration: aiLaunchRegistration.registration.launchGeneration,
          readClock: dependencies.nowMs,
        });
      } catch (error) {
        try { aiLaunchRegistration.registration.revoke(); } catch { /* fail closed */ }
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
          try { aiLaunchRegistration.registration.revoke(); } catch { /* fail closed */ }
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
    async reserveOwnedPlayerHostPhaseA(
      runtimeRoot,
      claim,
      playerHostReservation,
      aiClientReservation,
    ) {
      const claimRegistration = claims.get(claim);
      if (claimRegistration === undefined)
        throw new Error("stardew_bootstrap_claim_not_registered");
      const playerHostLaunchRegistration = playerHostLaunches.get(playerHostReservation);
      if (playerHostLaunchRegistration === undefined)
        throw new Error("stardew_player_host_reservation_not_registered");
      const aiLaunchRegistration = aiLaunches.get(aiClientReservation);
      if (aiLaunchRegistration === undefined)
        throw new Error("stardew_ai_client_reservation_not_registered");
      if (claimRegistration.state !== "available")
        throw new Error("stardew_bootstrap_claim_not_available");
      if (playerHostLaunchRegistration.state !== "available")
        throw new Error("stardew_player_host_reservation_not_available");
      if (aiLaunchRegistration.state !== "available")
        throw new Error("stardew_ai_client_reservation_not_available");

      // Bind all three exact nominal identities synchronously before any
      // persistence await. A competing join can therefore never reuse a pair.
      claimRegistration.state = "binding";
      playerHostLaunchRegistration.state = "binding";
      aiLaunchRegistration.state = "binding";

      let durableOwner: DurableOwnerFor<StardewOwnedPlayerHostBootstrapOwnerRecord>;
      try {
        durableOwner = await persistPrivateBootstrapOwner({
          runtimeRoot,
          bootstrapFacts: claimRegistration.facts,
          playerHost: {
            kind: "launch_reserved" as const,
            launchGeneration: playerHostLaunchRegistration.registration.launchGeneration,
          },
          aiClientLaunchGeneration: aiLaunchRegistration.registration.launchGeneration,
          readClock: dependencies.nowMs,
        });
      } catch (error) {
        try { playerHostLaunchRegistration.registration.revoke(); } catch { /* fail closed */ }
        try { aiLaunchRegistration.registration.revoke(); } catch { /* fail closed */ }
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
          try { playerHostLaunchRegistration.registration.revoke(); } catch { /* fail closed */ }
          try { aiLaunchRegistration.registration.revoke(); } catch { /* fail closed */ }
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
      const facts = requireOwnedPhaseAFacts(owner, compositionIdentity);
      facts.stagingDependencies = stagingDependencies;
      return owner;
    },
  });
  return Object.freeze({
    composition,
    consumeStagedOwnedPlayerHostPhaseB: (owner: StardewOwnedPlayerHostPhaseAOwner): void => {
      consumeStagedOwnedPlayerHostPhaseB(owner, compositionIdentity);
    },
     createOwnedPlayerHostAttachmentFlow: (owner: StardewOwnedPlayerHostPhaseAOwner): StardewAttachmentFlow =>
       createOwnedPlayerHostAttachmentFlowCore(owner, compositionIdentity, dependencies.nowMs),
      createOwnedPlayerHostManifestHandoffCoordinator: (): StardewManifestHandoffCoordinator =>
        manifestHandoffCoordinator,
      materializeAiClientProfileAfterManifestAdmission: (
        owner: StardewOwnedPlayerHostPhaseAOwner,
        admission: StardewManifestAdmissionValue,
      ): Promise<void> => manifestHandoff.materialize(owner, admission),
      launchOwnedPlayerHostStageC: (
      owner: StardewOwnedPlayerHostPhaseAOwner,
      installation: AdmittedStardewInstallation,
    ): Promise<StardewOwnedPlayerHostStageCResult> =>
      launchOwnedPlayerHostStageC(owner, installation, compositionIdentity),
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
    playerHost: TPlayerHost;
    aiClientLaunchGeneration: string;
    readClock: () => number;
  }>;

type DurableOwnerFor<TRecord extends StardewPrivateBootstrapOwnerRecord> =
  Omit<DurableOwner, "record"> & Readonly<{ record: TRecord }>;

function persistPrivateBootstrapOwner(
  input: PersistPrivateBootstrapOwnerInput<Readonly<{ kind: "external_unattested" }>>,
): Promise<DurableOwnerFor<StardewExternalPlayerHostBootstrapOwnerRecord>>;
function persistPrivateBootstrapOwner(
  input: PersistPrivateBootstrapOwnerInput<Readonly<{
    kind: "launch_reserved";
    launchGeneration: string;
  }>>,
): Promise<DurableOwnerFor<StardewOwnedPlayerHostBootstrapOwnerRecord>>;
async function persistPrivateBootstrapOwner(
  input: PersistPrivateBootstrapOwnerInput<StardewPrivateBootstrapOwnerRecord["playerHost"]>,
): Promise<DurableOwner> {
  validateBootstrapFacts(input.bootstrapFacts, input.readClock());
  if (input.playerHost.kind === "launch_reserved" &&
      !isOpaque(input.playerHost.launchGeneration))
    throw new TypeError("invalid_stardew_player_host_launch_generation");
  if (!isOpaque(input.aiClientLaunchGeneration))
    throw new TypeError("invalid_stardew_ai_client_launch_generation");

  const root = resolve(input.runtimeRoot);
  const transactionsRoot = join(root, "stardew-private-bootstrap");
  const directory = join(transactionsRoot, input.bootstrapFacts.bootstrapId);
  const ownerPath = join(directory, OWNER_FILE);

  await verifySafePathBoundary(join(root, ".stardew-private-bootstrap-admission"), root);
  await withPathLock(
    ownerPath,
    async () => {
      const blocking = (await readDirectoryIfPresent(directory, root)).filter(
        (entry) => entry !== OWNER_LOCK_LEAF,
      );
      if (blocking.length !== 0) throw new Error("stardew_bootstrap_owner_occupied");
      if (input.bootstrapFacts.expiresAtMs <= input.readClock())
        throw new Error("stardew_bootstrap_claim_expired");
      const baseRecord = {
        schema: OWNER_SCHEMA as typeof OWNER_SCHEMA,
        bootstrapId: input.bootstrapFacts.bootstrapId,
        playerId: input.bootstrapFacts.playerId,
        companionId: input.bootstrapFacts.companionId,
        aiClient: {
          kind: "launch_reserved" as const,
          launchGeneration: input.aiClientLaunchGeneration,
        },
        expiresAtMs: input.bootstrapFacts.expiresAtMs,
        state: "reserved" as const,
        cleanupDisposition: "pending" as const,
        managedPaths: [OWNER_FILE] as [typeof OWNER_FILE],
      };
      const record: StardewPrivateBootstrapOwnerRecord = input.playerHost.kind === "external_unattested"
        ? freezeRecord({ ...baseRecord, playerHost: input.playerHost })
        : freezeRecord({ ...baseRecord, playerHost: input.playerHost });
      await atomicWriteFile(ownerPath, `${JSON.stringify(record)}\n`, root);
    },
    { containmentRoot: root },
  );

  let record = await readAndValidateOwner(ownerPath, root);
  let quarantinePromise: Promise<void> | null = null;
  let quarantineStarted = record.state === "quarantined";
  return Object.freeze({
    get record() { return record; },
    transactionDirectory: directory,
    replaceRecord(next: StardewPrivateBootstrapOwnerRecord): void { record = freezeRecord(next); },
    quarantine(): Promise<void> {
      if (quarantineStarted) return quarantinePromise ?? Promise.resolve();
      quarantineStarted = true;
      quarantinePromise = (async () => {
        await withPathLock(ownerPath, async () => {
          const current = await readAndValidateOwner(ownerPath, root);
          if (current.bootstrapId !== record.bootstrapId)
            throw new Error("stardew_bootstrap_owner_state_mismatch");
          if (current.state === "quarantined") {
            record = current;
            return;
          }
          if (current.state !== "reserved")
            throw new Error("stardew_bootstrap_owner_state_mismatch");
          const next = freezeRecord({
            ...current,
            state: "quarantined",
            cleanupDisposition: "retry_required",
          });
          await atomicWriteFile(ownerPath, `${JSON.stringify(next)}\n`, root);
          record = next;
        }, { containmentRoot: root });
      })();
      return quarantinePromise;
    },
  });
}

type OwnedPhaseAOwnerBindingState = "unbound" | "binding" | "bound" | "terminal";

type OwnedPhaseBState = "not_staged" | "staged" | "launching";
type ManifestHandoffSelectionState =
  | "available"
  | "confirming"
  | "request_published"
  | "admitted"
  | "uncertain"
  | "terminal";

type ManifestHandoffSelectionFacts = {
  readonly compositionIdentity: object;
  readonly owner: StardewOwnedPlayerHostPhaseAOwner;
  readonly flow: StardewAttachmentFlow;
  readonly choice: StardewVerifiedCabinChoice;
  readonly expiresAtMs: number;
  state: ManifestHandoffSelectionState;
  requestId: string | null;
  manifest: Readonly<StardewJoinManifest> | null;
};

type ManifestHandoffAdmissionFacts = Readonly<{
  readonly compositionIdentity: object;
  readonly owner: StardewOwnedPlayerHostPhaseAOwner;
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
 * exists; a future closed Stage-D primitive owns the only read path through
 * the same WeakMap.
 */
type StardewPrivateBootstrapMaterial = Readonly<{
  readonly sessionDirectory: string;
  readonly sessionToken: string;
  readonly integrationVersion: string;
  readonly companionId: string;
}>;

type OwnedPhaseAFacts = {
  readonly compositionIdentity: object;
  readonly durableOwner: DurableOwner;
  readonly playerHostRegistration: StardewPlayerHostLaunchRegistration;
  readonly aiClientRegistration: StardewAiClientLaunchRegistration;
  readonly expiresAtMs: number;
  readonly readClock: () => number;
  readonly launchStates: { playerHost: LaunchState; aiClient: LaunchState };
  readonly quarantine: { started: boolean; promise: Promise<void> | null };
  readonly bindingState: { value: OwnedPhaseAOwnerBindingState };
  readonly phaseBState: { value: OwnedPhaseBState };
  readonly aiClientProfileState: { value: "not_materialized" | "materializing" | "materialized" | "failed" };
  readonly privateMaterial: { value: StardewPrivateBootstrapMaterial | null };
  stagingDependencies?: PrivateModProfileStagingDependencies;
  consumePlayerHostLaunch: <T>(callback: (launch: StardewPlayerHostLaunch) => T) => T;
  consumeAiClientLaunch: <T>(callback: (launch: StardewAiClientLaunch) => T) => T;
  quarantineOwner: () => Promise<void>;
};

const ownedPhaseAFacts = new WeakMap<object, OwnedPhaseAFacts>();

function requireOwnedPhaseAFacts(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  compositionIdentity?: object,
): OwnedPhaseAFacts {
  if (typeof owner !== "object" || owner === null) throw new Error("stardew_owned_phase_a_owner_not_registered");
  const facts = ownedPhaseAFacts.get(owner);
  if (facts === undefined ||
      (compositionIdentity !== undefined && facts.compositionIdentity !== compositionIdentity)) {
    throw new Error("stardew_owned_phase_a_owner_not_registered");
  }
  return facts;
}

/**
 * Private composition seam for later Stage-0 launch preparation. Successful
 * binding is globally once per exact composer-minted owner, across every
 * session launcher instance. Failed asynchronous preparation restores `unbound` only
 * after its callback settles, so a complete later retry remains possible.
 */
export function consumeOwnedPlayerHostPhaseAOwner<T>(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  callback: () => Promise<T> | T,
): Promise<T> | T {
  const facts = requireOwnedPhaseAFacts(owner);
  if (typeof callback !== "function" || facts.bindingState.value !== "unbound") {
    throw new Error("stardew_owned_phase_a_owner_not_registered");
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
          restoreOwnedPhaseAOwnerAfterFailure(owner);
          throw error;
        },
      );
    }
    facts.bindingState.value = "bound";
    return result;
  } catch (error) {
    restoreOwnedPhaseAOwnerAfterFailure(owner);
    throw error;
  }
}

/**
 * Marks an exact consumed owner permanently unavailable after Stage B has
 * succeeded and subsequent final admission failed after quarantine started.
 */
export function terminalizeOwnedPlayerHostPhaseAOwner(
  owner: StardewOwnedPlayerHostPhaseAOwner,
): void {
  const facts = requireOwnedPhaseAFacts(owner);
  if (facts.bindingState.value !== "binding")
    throw new Error("stardew_owned_phase_a_owner_not_registered");
  facts.bindingState.value = "terminal";
}

function restoreOwnedPhaseAOwnerAfterFailure(owner: StardewOwnedPlayerHostPhaseAOwner): void {
  const facts = requireOwnedPhaseAFacts(owner);
  if (facts.bindingState.value !== "terminal") facts.bindingState.value = "unbound";
}

type PrivateModProfileStagingDependencies = Readonly<{
  readPackage(): Promise<Readonly<{ root: string; entries: readonly string[] }>>;
  createSecret(): string;
  nowMs(): number;
}>;

/**
 * The Phase-B profile operation is intentionally concrete and closed: its
 * package root, layout, config, secret, and result remain composition-owned.
 * It consumes no launch reservation and returns no path or launch authority.
 */
export async function stageOwnedPlayerHostPhaseB(
  owner: StardewOwnedPlayerHostPhaseAOwner,
): Promise<void> {
  const facts = requireOwnedPhaseAFacts(owner);
  const dependencies = facts.stagingDependencies ?? productionStagingDependencies();
  await stageOwnedPlayerHostPhaseBWithValidatedDependencies(owner, dependencies);
}

function productionStagingDependencies(): PrivateModProfileStagingDependencies {
  const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  return Object.freeze({
    async readPackage() {
      const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
      const contract = await readPublishedStardewModPackageContract(artifactRoot);
      await verifyPublishedStardewModPackage(artifactRoot, contract, inspector);
      return Object.freeze({
        root: resolve(artifactRoot, contract.descriptor.destination.replaceAll("/", sep)),
        entries: contract.entries,
      });
    },
    createSecret: createPrivateProvisioningSecret,
    nowMs: Date.now,
  });
}

async function stageOwnedPlayerHostPhaseBWithValidatedDependencies(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  dependencies: PrivateModProfileStagingDependencies,
): Promise<void> {
  const facts = requireOwnedPhaseAFacts(owner);
  if (facts.bindingState.value !== "binding")
    throw new Error("stardew_owned_phase_a_owner_not_staging");
  try {
    if (facts.expiresAtMs <= dependencies.nowMs())
      throw new Error("stardew_private_mod_profile_staging_expired");
    const packageSource = await dependencies.readPackage();
    validatePackageSource(packageSource);
    if (facts.expiresAtMs <= dependencies.nowMs())
      throw new Error("stardew_private_mod_profile_staging_expired");
    const privateMaterial = await stagePlayerHostModProfile(owner, packageSource, dependencies);
    facts.privateMaterial.value = privateMaterial;
  } catch (error) {
    try { await facts.quarantineOwner(); } catch { /* staging failure remains primary */ }
    throw error;
  }
  facts.phaseBState.value = "staged";
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
function consumeStagedOwnedPlayerHostPhaseB(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  compositionIdentity: object,
): void {
  const facts = requireOwnedPhaseAFacts(owner, compositionIdentity);
  if (facts.bindingState.value !== "bound")
    throw new Error("stardew_owned_phase_a_owner_not_bound");
  if (facts.phaseBState.value !== "staged")
    throw new Error("stardew_owned_phase_a_phase_b_not_staged");
  if (facts.quarantine.started)
    throw new Error("stardew_owned_phase_a_owner_quarantined");
  if (facts.expiresAtMs <= facts.readClock())
    throw new Error("stardew_owned_phase_a_owner_expired");
  facts.phaseBState.value = "not_staged";
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
): ManifestHandoffCoordinatorCore {
  const selections = new WeakMap<StardewManifestHandoffSelection, ManifestHandoffSelectionFacts>();
  const admissions = new WeakMap<StardewManifestAdmission, ManifestHandoffAdmissionFacts>();
  const coordinator = {
    async select(
      owner: StardewOwnedPlayerHostPhaseAOwner,
      candidateCabinId: string,
    ): Promise<StardewManifestHandoffSelection> {
      const ownerFacts = requireOwnedPhaseAFacts(owner, compositionIdentity);
      assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
      const flow = createOwnedPlayerHostAttachmentFlowCore(owner, compositionIdentity, readClock);
      const choice = await flow.verifyCabinChoice(candidateCabinId);
      assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
      const selection = Object.freeze(Object.create(null)) as StardewManifestHandoffSelection;
      const facts: ManifestHandoffSelectionFacts = {
        compositionIdentity,
        owner,
        flow,
        choice,
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
      const ownerFacts = requireOwnedPhaseAFacts(facts.owner, compositionIdentity);
      try {
        assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
        let requestId: string;
        try {
          requestId = await facts.flow.confirmAndRequest(facts.choice, { confirmed: true });
        } catch (error) {
          facts.state = "uncertain";
          throw redactManifestHandoffError(error);
        }
        facts.requestId = requestId;
        facts.state = "request_published";
        try {
          const remainingMs = Math.min(60_000, Math.max(1, facts.expiresAtMs - readClock()));
          const manifest = await facts.flow.waitForManifest(requestId, remainingMs);
          assertManifestHandoffOwnerAdmissible(ownerFacts, readClock);
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
          facts.state = "uncertain";
          throw error;
        }
      } catch (error) {
        if (facts.state === "confirming") facts.state = "terminal";
        throw redactManifestHandoffError(error);
      }
    },
  } satisfies StardewManifestHandoffCoordinator;
  const materialize: MaterializeAiClientProfileAfterManifestAdmission = async (owner, admission) => {
    const facts = requireOwnedPhaseAFacts(owner, compositionIdentity);
    const admissionFacts = admissions.get(admission);
    if (admissionFacts === undefined || admissionFacts.compositionIdentity !== compositionIdentity ||
        admissionFacts.owner !== owner || admissionFacts.consumed.value ||
        facts.bindingState.value !== "bound" || facts.quarantine.started ||
        facts.expiresAtMs <= readClock() || admissionFacts.expiresAtMs <= readClock() ||
        admissionFacts.manifest.expiresAtUnixMs <= readClock() || facts.privateMaterial.value === null ||
        admissionFacts.requestId !== admissionFacts.manifest.requestId ||
        admissionFacts.manifest.companionId !== facts.privateMaterial.value?.companionId ||
        admissionFacts.manifest.integrationVersion !== facts.privateMaterial.value?.integrationVersion ||
        facts.aiClientProfileState.value !== "not_materialized" ||
        facts.launchStates.aiClient !== "available") {
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
      if (facts.expiresAtMs <= readClock() || admissionFacts.expiresAtMs <= readClock() ||
          admissionFacts.manifest.expiresAtUnixMs <= readClock()) {
        throw new Error("stardew_ai_client_profile_materialization_expired");
      }
      await stageAiClientProfile(owner, admissionFacts, packageSource, dependencies);
      facts.aiClientProfileState.value = "materialized";
    } catch (error) {
      facts.aiClientProfileState.value = "failed";
      try { await facts.quarantineOwner(); } catch { /* preserve materialization failure */ }
      throw error;
    }
  };
  return Object.freeze({ coordinator: Object.freeze(coordinator), materialize });
}

function assertManifestHandoffOwnerAdmissible(
  facts: OwnedPhaseAFacts,
  readClock: () => number,
): void {
  if (
    facts.bindingState.value !== "bound" ||
    facts.quarantine.started ||
    facts.expiresAtMs <= readClock() ||
    facts.privateMaterial.value === null
  ) throw new Error("stardew_manifest_handoff_not_admissible");
}

function redactManifestHandoffError(error: unknown): Error {
  if (error instanceof Error && /^stardew_manifest_handoff_|^user_confirmation_required$|^invalid_stardew_manifest_handoff_selection$/.test(error.message))
    return error;
  return new Error("stardew_manifest_handoff_failed");
}

function createOwnedPlayerHostAttachmentFlowCore(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  compositionIdentity: object,
  readClock: () => number,
): StardewAttachmentFlow {
  try {
    const facts = requireOwnedPhaseAFacts(owner, compositionIdentity);
    // Stage C clears phaseBState after consuming only the Player Host launch
    // reservation. Private session material deliberately remains available for
    // the later authenticated attachment read path, so material presence—not
    // the transient staging state—is the admission proof here.
    if (facts.bindingState.value !== "bound")
      throw new Error("staged_material_unavailable");
    if (facts.quarantine.started || facts.expiresAtMs <= readClock())
      throw new Error("owner_not_admissible");
    const material = facts.privateMaterial.value;
    if (material === null)
      throw new Error("staged_material_unavailable");
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
 * Core-private composition-bound Stage-C launch primitive. Requires the exact
 * closure-owned composition identity that minted the owner, which must be
 * `bindingState=bound` and `phaseBState=staged`. Atomically marks an in-flight
 * launch attempt, fresh-rechecks the admitted SMAPI identity, derives exactly
 * `<root>/StardewModdingAPI.exe`, args `['--mods-path',
 * <transaction>/player-host/Mods]`, cwd root, and consumes the exact reserved
 * Player Host launch. Fresh identity failure: zero spawn and restores
 * `phaseBState=staged` for retry. Spawn/process probe failure preserves the
 * existing one-shot owner behavior; the staged marker drains permanently.
 * Never exported from this module; only the closed composition and the
 * dedicated test composition reach it with their stored identity.
 */
async function launchOwnedPlayerHostStageC(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  installation: AdmittedStardewInstallation,
  compositionIdentity: object,
): Promise<StardewOwnedPlayerHostStageCResult> {
  const facts = requireOwnedPhaseAFacts(owner, compositionIdentity);
  if (facts.bindingState.value !== "bound")
    throw new Error("stardew_owned_phase_a_owner_not_bound");
  if (facts.phaseBState.value !== "staged")
    throw new Error("stardew_owned_phase_a_phase_b_not_staged");
  if (facts.quarantine.started)
    throw new Error("stardew_owned_phase_a_owner_quarantined");
  if (facts.expiresAtMs <= facts.readClock())
    throw new Error("stardew_owned_phase_a_owner_expired");

  // Atomically mark the in-flight launch attempt before any await so a
  // concurrent Stage-C invocation for the exact owner can never double-spawn.
  facts.phaseBState.value = "launching";

  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const modsPath = join(transactionDirectory, HOST_PROFILE_ROOT, MODS_DIRECTORY);

  let launchEntered = false;
  try {
    const result = await consumeAdmittedStardewInstallation(installation, (root, executable) => {
      launchEntered = true;
      return facts.consumePlayerHostLaunch((launch) =>
        launch({
          executable,
          args: ["--mods-path", modsPath],
          cwd: root,
        }),
      );
    });
    // Launch succeeded: the staged profile has been used.
    facts.phaseBState.value = "not_staged";
    return result;
  } catch (error) {
    // A fresh identity failure never enters the Player Host launch consumer:
    // zero spawns happened, so the staged marker restores for a complete
    // retry. Spawn/probe/expiry/quarantine-on-entry failures keep the existing
    // one-shot owner behavior; the staged marker drains permanently.
    facts.phaseBState.value = launchEntered ? "not_staged" : "staged";
    throw error;
  }
}

async function stageAiClientProfile(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  admission: ManifestHandoffAdmissionFacts,
  packageSource: Readonly<{ root: string; entries: readonly string[] }>,
  dependencies: PrivateModProfileStagingDependencies,
): Promise<void> {
  const facts = requireOwnedPhaseAFacts(owner);
  const material = facts.privateMaterial.value;
  if (material === null) throw new Error("stardew_ai_client_profile_materialization_material_missing");
  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const ownerPath = join(transactionDirectory, OWNER_FILE);
  const managed = new Map<string, import("./path-lock.js").SafeFileIdentity>();
  const createdDirectories: string[] = [];
  let recordExtended = false;
  let originalRecord: StardewPrivateBootstrapOwnerRecord | undefined;
  return withPathLock(ownerPath, async () => {
    try {
      const current = await readAndValidateOwner(ownerPath, dirname(dirname(transactionDirectory)));
      if (
        current.bootstrapId !== facts.durableOwner.record.bootstrapId ||
        JSON.stringify(current) !== JSON.stringify(facts.durableOwner.record) ||
        current.state !== "reserved" ||
        current.expiresAtMs <= readClockForMaterialization(facts, admission, dependencies) ||
        JSON.stringify(current.managedPaths) !== JSON.stringify(PHASE_B_MANAGED_PATHS)
      ) throw new Error("stardew_ai_client_profile_materialization_owner_invalid");

      await assertC1ExistingInventory(transactionDirectory, dirname(dirname(transactionDirectory)));
      await assertAiClientDestinationAbsent(transactionDirectory, dirname(dirname(transactionDirectory)));
      await assertManifestCorrelationStillHeld(material, admission);

      const next = freezeRecord({ ...current, managedPaths: [...C1_MANAGED_PATHS] });
      originalRecord = facts.durableOwner.record;
      await atomicWriteFile(ownerPath, `${JSON.stringify(next)}\n`, dirname(dirname(transactionDirectory)));
      facts.durableOwner.replaceRecord(next);
      recordExtended = true;

      const aiClientModDirectory = join(
        transactionDirectory,
        AI_CLIENT_PROFILE_ROOT,
        MODS_DIRECTORY,
        MOD_DIRECTORY,
      );
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
      const aiClientConfig = JSON.stringify({
        FarmhandProvisioner: {
          Enable: true,
          ManifestPath: manifestPath,
          SessionToken: material.sessionToken,
          IntegrationVersion: material.integrationVersion,
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
      ) throw new Error("stardew_ai_client_profile_materialization_package_changed");
      if (facts.expiresAtMs <= readClockForMaterialization(facts, admission, dependencies) ||
          admission.expiresAtMs <= readClockForMaterialization(facts, admission, dependencies) ||
          admission.manifest.expiresAtUnixMs <= readClockForMaterialization(facts, admission, dependencies)) {
        throw new Error("stardew_ai_client_profile_materialization_expired");
      }
    } catch (error) {
      if (recordExtended) {
        await rollbackStagedPlayerHostProfile(managed, createdDirectories, transactionDirectory);
        if (originalRecord === undefined) throw new Error("stardew_ai_client_profile_materialization_rollback_record_missing");
        await atomicWriteFile(ownerPath, `${JSON.stringify(originalRecord)}\n`, dirname(dirname(transactionDirectory)));
        facts.durableOwner.replaceRecord(originalRecord);
      }
      throw error;
    }
  }, { containmentRoot: dirname(dirname(transactionDirectory)) });
}

function readClockForMaterialization(
  facts: OwnedPhaseAFacts,
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
  if (JSON.stringify(await readSafeDirectory(hostProfile, root)) !== JSON.stringify([MODS_DIRECTORY]) ||
      JSON.stringify(await readSafeDirectory(hostMods, root)) !== JSON.stringify([MOD_DIRECTORY])) {
    throw new Error("stardew_ai_client_profile_materialization_inventory_invalid");
  }
  const expectedFiles = [MOD_CONFIG_FILE, ...PHASE_B_PACKAGE_ENTRIES].sort();
  const actualFiles = [...await readSafeDirectory(hostMod, root)].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
    throw new Error("stardew_ai_client_profile_materialization_inventory_invalid");
  if (entries.includes("session")) await readSafeDirectory(join(transactionDirectory, "session"), root);
}

async function assertManifestCorrelationStillHeld(
  material: StardewPrivateBootstrapMaterial,
  admission: ManifestHandoffAdmissionFacts,
): Promise<void> {
  const manifestPath = join(material.sessionDirectory, "stardew-farmhand-manifest.json");
  if (resolve(material.sessionDirectory) !== resolve(dirname(manifestPath)) ||
      admission.manifest.requestId !== admission.requestId ||
      admission.manifest.companionId !== material.companionId ||
      admission.manifest.integrationVersion !== material.integrationVersion) {
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

async function stagePlayerHostModProfile(
  owner: StardewOwnedPlayerHostPhaseAOwner,
  packageSource: Readonly<{ root: string; entries: readonly string[] }>,
  dependencies: PrivateModProfileStagingDependencies,
): Promise<StardewPrivateBootstrapMaterial> {
  const facts = requireOwnedPhaseAFacts(owner);
  const transactionDirectory = resolve(facts.durableOwner.transactionDirectory);
  const ownerPath = join(transactionDirectory, OWNER_FILE);
  const managed = new Map<string, import("./path-lock.js").SafeFileIdentity>();
  const createdDirectories: string[] = [];
  let recordExtended = false;
  return withPathLock(ownerPath, async () => {
    try {
      const current = await readAndValidateOwner(ownerPath, dirname(dirname(transactionDirectory)));
      if (current.bootstrapId !== facts.durableOwner.record.bootstrapId || current.state !== "reserved" ||
          current.expiresAtMs <= dependencies.nowMs() ||
          JSON.stringify(current.managedPaths) !== JSON.stringify([OWNER_FILE])) {
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
      const hostConfig = JSON.stringify({
        HostFarmhandProvisioning: {
          Enable: true,
          SessionDirectory: sessionDirectory,
          SessionToken: sessionSecret,
          IntegrationVersion: INTEGRATION_VERSION,
          ManifestLifetimeSeconds: MANIFEST_LIFETIME_SECONDS,
          AuthorizedCompanionIds: [facts.durableOwner.record.companionId],
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
      if (rereadPackage.root !== packageSource.root ||
          JSON.stringify(rereadPackage.entries) !== JSON.stringify(packageSource.entries)) {
        throw new Error("stardew_private_mod_profile_staging_package_changed");
      }
      if (facts.expiresAtMs <= dependencies.nowMs())
        throw new Error("stardew_private_mod_profile_staging_expired");
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
  }, { containmentRoot: dirname(dirname(transactionDirectory)) });
}

async function assertStagingDestinationEmpty(transactionDirectory: string, root: string): Promise<void> {
  const entries = await readSafeDirectory(transactionDirectory, root);
  const allowed = new Set([OWNER_FILE, OWNER_LOCK_LEAF]);
  if (entries.some((entry) => !allowed.has(entry)))
    throw new Error("stardew_private_mod_profile_staging_occupied");
}

async function writeManagedFile(
  path: string,
  content: string | Uint8Array,
  transactionDirectory: string,
  managed: Map<string, import("./path-lock.js").SafeFileIdentity>,
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
  managed: ReadonlyMap<string, import("./path-lock.js").SafeFileIdentity>,
  createdDirectories: readonly string[],
  transactionDirectory: string,
): Promise<void> {
  let failed = false;
  for (const [path, identity] of [...managed.entries()].reverse()) {
    try { await removeOwnedSafeFile(path, identity, transactionDirectory); } catch { failed = true; }
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      await readSafeDirectory(directory, transactionDirectory);
      await rmdir(directory);
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST")) continue;
      failed = true;
    }
  }
  if (failed) throw new Error("stardew_private_mod_profile_staging_rollback_uncertain");
}

function validatePackageSource(value: unknown): asserts value is Readonly<{ root: string; entries: readonly string[] }> {
  if (!isRecord(value) || !exactKeys(value, ["root", "entries"]) ||
      typeof value.root !== "string" || !isAbsolute(value.root) ||
      !Array.isArray(value.entries) ||
      JSON.stringify(value.entries) !== JSON.stringify(PHASE_B_PACKAGE_ENTRIES)) {
    throw new Error("stardew_private_mod_profile_staging_package_invalid");
  }
}

function createPrivateProvisioningSecret(): string {
  return `${randomUUID()}${randomUUID()}`;
}

function isProvisioningSecret(value: string): boolean {
  return value.length >= 16 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
}

function composeOwnedPlayerHostOwner(
  durableOwner: DurableOwner & Readonly<{
    record: StardewOwnedPlayerHostBootstrapOwnerRecord;
  }>,
  playerHostRegistration: StardewPlayerHostLaunchRegistration,
  aiClientRegistration: StardewAiClientLaunchRegistration,
  expiresAtMs: number,
  readClock: () => number,
  compositionIdentity: object,
): StardewOwnedPlayerHostPhaseAOwner {
  let playerHostLaunchState: LaunchState = "available";
  let aiClientLaunchState: LaunchState = "available";
  let quarantineStarted = false;
  let quarantinePromise: Promise<void> | null = null;

  const revokePlayerHostLaunch = (): void => {
    if (playerHostLaunchState === "revoked") return;
    playerHostLaunchState = "revoked";
    playerHostRegistration.revoke();
  };
  const revokeAiClientLaunch = (): void => {
    if (aiClientLaunchState === "revoked") return;
    aiClientLaunchState = "revoked";
    aiClientRegistration.revoke();
  };

  const consumeLaunch = <TLaunchInput, TLaunchResult, T>(input: Readonly<{
    role: "player_host" | "ai_client";
    callback: (launch: (launchInput: TLaunchInput) => TLaunchResult) => T;
    getState: () => LaunchState;
    setState: (state: LaunchState) => void;
    launch: (launchInput: TLaunchInput) => TLaunchResult;
    revoke: () => void;
  }>): T => {
    if (input.getState() !== "available")
      throw new Error(`stardew_${input.role}_launch_not_available`);
    if (typeof input.callback !== "function")
      throw new TypeError(`invalid_stardew_${input.role}_launch_callback`);

    input.setState("binding");
    if (expiresAtMs <= readClock()) {
      try { input.revoke(); } catch { /* expiry remains primary */ }
      throw new Error("stardew_bootstrap_owner_expired");
    }

    let callbackActive = true;
    let launchCalled = false;
    const launch = (launchInput: TLaunchInput): TLaunchResult => {
      if (!callbackActive || launchCalled || quarantineStarted)
        throw new Error(`stardew_${input.role}_launch_callback_not_active`);
      if (expiresAtMs <= readClock()) {
        try { input.revoke(); } catch { /* expiry remains primary */ }
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

  const owner = Object.freeze({}) as StardewOwnedPlayerHostPhaseAOwner;
  const bindingState: { value: OwnedPhaseAOwnerBindingState } = { value: "unbound" };
  const phaseBState: { value: OwnedPhaseBState } = { value: "not_staged" };
  const aiClientProfileState: OwnedPhaseAFacts["aiClientProfileState"] = { value: "not_materialized" };
  const facts: OwnedPhaseAFacts = {
    compositionIdentity,
    durableOwner,
    playerHostRegistration,
    aiClientRegistration,
    expiresAtMs,
    readClock,
    launchStates: {
      get playerHost() { return playerHostLaunchState; },
      set playerHost(value: LaunchState) { playerHostLaunchState = value; },
      get aiClient() { return aiClientLaunchState; },
      set aiClient(value: LaunchState) { aiClientLaunchState = value; },
    },
    quarantine: {
      get started() { return quarantineStarted; },
      set started(value: boolean) { quarantineStarted = value; },
      get promise() { return quarantinePromise; },
      set promise(value: Promise<void> | null) { quarantinePromise = value; },
    },
    bindingState,
    phaseBState,
    aiClientProfileState,
    privateMaterial: { value: null },
    consumePlayerHostLaunch: (callback) => consumeLaunch({
      role: "player_host",
      callback,
      getState: () => playerHostLaunchState,
      setState: (state) => { playerHostLaunchState = state; },
      launch: (launchInput) => playerHostRegistration.launch(launchInput),
      revoke: revokePlayerHostLaunch,
    }),
    consumeAiClientLaunch: (callback) => consumeLaunch({
      role: "ai_client",
      callback,
      getState: () => aiClientLaunchState,
      setState: (state) => { aiClientLaunchState = state; },
      launch: (launchInput) => aiClientRegistration.launch(launchInput),
      revoke: revokeAiClientLaunch,
    }),
    quarantineOwner: () => {
      if (quarantinePromise !== null) return quarantinePromise;
      quarantineStarted = true;
      facts.privateMaterial.value = null;
      if (playerHostLaunchState === "available") playerHostLaunchState = "binding";
      if (aiClientLaunchState === "available") aiClientLaunchState = "binding";
      quarantinePromise = durableOwner.quarantine().then(
        () => {
          let firstError: unknown;
          try { revokePlayerHostLaunch(); } catch (error) { firstError = error; }
          try { revokeAiClientLaunch(); } catch (error) { firstError ??= error; }
          if (firstError !== undefined) throw firstError;
        },
        (persistenceError: unknown) => {
          try { revokePlayerHostLaunch(); } catch { /* persistence remains primary */ }
          try { revokeAiClientLaunch(); } catch { /* persistence remains primary */ }
          throw persistenceError;
        },
      );
      return quarantinePromise;
    },
  };
  ownedPhaseAFacts.set(owner, facts);
  return owner;
}

function composeExternalPlayerHostOwner(
  durableOwner: DurableOwner & Readonly<{
    record: StardewExternalPlayerHostBootstrapOwnerRecord;
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

  return Object.freeze({
    get record() { return durableOwner.record; },
    transactionDirectory: durableOwner.transactionDirectory,
    consumeAiClientLaunch<T>(callback: (launch: StardewAiClientLaunch) => T): T {
      if (launchState !== "available")
        throw new Error("stardew_ai_client_launch_not_available");
      if (typeof callback !== "function")
        throw new TypeError("invalid_stardew_ai_client_launch_callback");

      // Synchronously consume owner state and fresh-check the absolute expiry
      // before the manager registration can launch a child.
      launchState = "binding";
      if (expiresAtMs <= readClock()) {
        try { revokeLaunch(); } catch { /* expiry remains primary */ }
        throw new Error("stardew_bootstrap_owner_expired");
      }

      let callbackActive = true;
      let launchCalled = false;
      const launch: StardewAiClientLaunch = (input) => {
        if (!callbackActive || launchCalled || quarantineStarted)
          throw new Error("stardew_ai_client_launch_callback_not_active");
        if (expiresAtMs <= readClock()) {
          try { revokeLaunch(); } catch { /* expiry remains primary */ }
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
          try { revokeLaunch(); } catch { /* persistence remains primary */ }
          throw persistenceError;
        },
      );
      return quarantinePromise;
    },
  });
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
  registerConsumedClaim: (
    claim: StardewPlayerHostBootstrapClaim,
    facts: StardewPrivateBootstrapFacts,
  ) => void,
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
            state: record.state === "pending" && expired(record)
              ? "expired" as const
              : record.state,
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
  | { readonly kind: "awaiting_ai_client_attestation"; readonly owned: OwnedAiClient }
  | { readonly kind: "ai_client_stopped" };

type OwnedPlayerHost = {
  readonly kill: () => boolean;
  readonly pid: number;
  readonly creationDate: string;
};

type OwnedPlayerHostProcessState =
  | { readonly kind: "idle" }
  | { readonly kind: "awaiting_player_host_attestation"; readonly owned: OwnedPlayerHost }
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
    if (state.kind === "awaiting_player_host_attestation")
      throw new Error("owned_player_host_already_active");
    validatePlayerHostLaunchInput(input);

    const spawned = rawSpawn(input.executable, [...input.args], {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        [LAUNCH_GENERATION_ENVIRONMENT_VARIABLE]: launchGeneration,
      },
    });
    const pid = spawned.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      try { spawned.kill(); } catch { /* launch failure remains primary */ }
      throw new Error("spawned_player_host_child_missing_valid_pid");
    }

    let probeResult: StardewPlayerHostProcessProbeResult;
    try { probeResult = rawProbe(pid); }
    catch {
      try { spawned.kill(); } catch { /* launch failure remains primary */ }
      throw new Error("player_host_probe_failed_no_process");
    }
    if (probeResult === null) {
      try { spawned.kill(); } catch { /* launch failure remains primary */ }
      throw new Error("player_host_probe_failed_no_process");
    }
    if (probeResult.pid !== pid) {
      try { spawned.kill(); } catch { /* launch failure remains primary */ }
      throw new Error("player_host_probe_pid_mismatch");
    }
    if (typeof probeResult.creationDate !== "string" || probeResult.creationDate.length === 0) {
      try { spawned.kill(); } catch { /* launch failure remains primary */ }
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

      const { owned } = state;
      let probeResult: StardewPlayerHostProcessProbeResult;
      try { probeResult = rawProbe(owned.pid); }
      catch { return { kind: "identity_probe_failed", killed: false }; }
      if (probeResult === null) return { kind: "identity_probe_failed", killed: false };
      if (probeResult.pid !== owned.pid || probeResult.creationDate !== owned.creationDate)
        return { kind: "identity_mismatch", killed: false };

      let killed: boolean;
      try { killed = owned.kill(); }
      catch { return { kind: "termination_failed", killed: false }; }
      if (killed !== true) return { kind: "termination_failed", killed: false };
      state = { kind: "player_host_stopped" };
      return { kind: "terminated", killed: true };
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
    if (state.kind === "awaiting_ai_client_attestation")
      throw new Error("owned_ai_client_already_active");
    validateLaunchInput(input);

    const spawned = rawSpawn(input.executable, [...input.args], {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        [LAUNCH_GENERATION_ENVIRONMENT_VARIABLE]: launchGeneration,
      },
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
    stopOwnedAiClient(): StopOwnedAiClientResult {
      if (state.kind === "idle") return { kind: "no_owned_ai_client", killed: false };
      if (state.kind === "ai_client_stopped") return { kind: "already_stopped", killed: false };

      const { owned } = state;
      const probeResult = rawProbe(owned.pid);
      if (probeResult === null) return { kind: "identity_probe_failed", killed: false };
      if (probeResult.pid !== owned.pid || probeResult.creationDate !== owned.creationDate)
        return { kind: "identity_mismatch", killed: false };

      let killed: boolean;
      try { killed = owned.kill(); }
      catch { return { kind: "termination_failed", killed: false }; }
      if (killed !== true) return { kind: "termination_failed", killed: false };
      state = { kind: "ai_client_stopped" };
      return { kind: "terminated", killed: true };
    },
  });
  return owner;
}

function productionSpawn(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly shell: boolean;
    readonly windowsHide: boolean;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  },
): StardewAiClientProcessSpawnResult {
  const child = spawn(executable, args, options);
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    child.kill();
    throw new Error("spawned_child_missing_valid_pid");
  }
  return Object.freeze({
    pid,
    kill: () => child.kill(),
  });
}

function productionProbe(pid: number): StardewAiClientProcessProbeResult {
  const result = probeWindowsProcess(pid);
  return result;
}

function productionPlayerHostSpawn(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly shell: boolean;
    readonly windowsHide: boolean;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  },
): StardewPlayerHostProcessSpawnResult {
  const child = spawn(executable, args, options);
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    child.kill();
    throw new Error("spawned_player_host_child_missing_valid_pid");
  }
  return Object.freeze({
    pid,
    kill: () => child.kill(),
  });
}

function productionPlayerHostProbe(pid: number): StardewPlayerHostProcessProbeResult {
  return probeWindowsProcess(pid);
}

function probeWindowsProcess(pid: number): Readonly<{ pid: number; creationDate: string }> | null {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId, CreationDate | ConvertTo-Json -Compress`,
    ],
    {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      encoding: "utf8",
    },
  );
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) return null;
  const trimmed = (result.stdout ?? "").trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return null;
    const resultPid = parsed.ProcessId ?? parsed.pid;
    const creationDate = parsed.CreationDate ?? parsed.creationDate;
    if (typeof resultPid !== "number" || resultPid <= 0 ||
        typeof creationDate !== "string" || creationDate.length === 0) return null;
    return { pid: resultPid, creationDate };
  } catch {
    return null;
  }
}

function validatePlayerHostLaunchInput(input: LaunchPlayerHostInput): void {
  if (!isRecord(input)) throw new Error("invalid_player_host_launch_input");
  const expectedKeys = input.cwd === undefined
    ? ["executable", "args"]
    : ["executable", "args", "cwd"];
  if (!exactKeys(input, expectedKeys))
    throw new Error("invalid_player_host_launch_input_keys");
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
  if (cwd !== undefined &&
      (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)))
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
  if (cwd !== undefined &&
      (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)))
    throw new Error("invalid_launch_cwd_not_absolute");
}

async function readDirectoryIfPresent(path: string, root: string): Promise<readonly string[]> {
  try { return await readSafeDirectory(path, root); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readAndValidateOwner(
  path: string,
  root: string,
): Promise<StardewPrivateBootstrapOwnerRecord> {
  await verifySafePathBoundary(path, root);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_stardew_bootstrap_owner");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schema",
      "bootstrapId",
      "playerId",
      "companionId",
      "playerHost",
      "aiClient",
      "expiresAtMs",
      "state",
      "cleanupDisposition",
      "managedPaths",
    ]) ||
    value.schema !== OWNER_SCHEMA ||
    !isOpaque(value.bootstrapId) ||
    !isOpaque(value.playerId) ||
    !isOpaque(value.companionId) ||
    (!isExternalPlayerHost(value.playerHost) && !isReservedPlayerHost(value.playerHost)) ||
    !isReservedAiClient(value.aiClient) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    (value.state !== "reserved" && value.state !== "quarantined") ||
    (value.cleanupDisposition !== "pending" && value.cleanupDisposition !== "retry_required") ||
    !isManagedPathSet(value.managedPaths)
  ) throw new Error("invalid_stardew_bootstrap_owner");
  return freezeRecord(value as unknown as StardewPrivateBootstrapOwnerRecord);
}

function validateBootstrapRequest(
  value: unknown,
  nowMs: number,
): asserts value is StardewPlayerHostBootstrapRequest {
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
  ) throw new TypeError("invalid_stardew_bootstrap_request");
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
  ) throw new TypeError("invalid_stardew_bootstrap_facts");
}

function validateTestingDependencies(value: StardewPrivateBootstrapCoreDependencies): void {
  if (!isRecord(value))
    throw new TypeError("invalid_stardew_private_bootstrap_testing_dependencies");
  const optionalKeys = value.staging === undefined ? [] : ["staging"];
  if (!exactKeys(value, [
        "rawSpawn", "rawProbe", "rawPlayerHostSpawn", "rawPlayerHostProbe",
        "createBootstrapIdentity", "createLaunchGeneration", "createPlayerHostLaunchGeneration", "nowMs",
        ...optionalKeys,
      ]) ||
      typeof value.rawSpawn !== "function" ||
      typeof value.rawProbe !== "function" ||
      typeof value.rawPlayerHostSpawn !== "function" ||
      typeof value.rawPlayerHostProbe !== "function" ||
      typeof value.createBootstrapIdentity !== "function" ||
      typeof value.createLaunchGeneration !== "function" ||
      typeof value.createPlayerHostLaunchGeneration !== "function" ||
      typeof value.nowMs !== "function" ||
      (value.staging !== undefined && !isPrivateModProfileStagingDependencies(value.staging))) {
    throw new TypeError("invalid_stardew_private_bootstrap_testing_dependencies");
  }
}

function isPrivateModProfileStagingDependencies(
  value: unknown,
): value is PrivateModProfileStagingDependencies {
  return isRecord(value) && exactKeys(value, ["readPackage", "createSecret", "nowMs"]) &&
    typeof value.readPackage === "function" &&
    typeof value.createSecret === "function" &&
    typeof value.nowMs === "function";
}

function isManagedPathSet(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string")) return false;
  const expected = value.length === 1
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

function isReservedPlayerHost(value: unknown): boolean {
  return isRecord(value) &&
    exactKeys(value, ["kind", "launchGeneration"]) &&
    value.kind === "launch_reserved" &&
    isOpaque(value.launchGeneration);
}

function isReservedAiClient(value: unknown): boolean {
  return isRecord(value) &&
    exactKeys(value, ["kind", "launchGeneration"]) &&
    value.kind === "launch_reserved" &&
    isOpaque(value.launchGeneration);
}

function isOpaque(value: unknown): value is string {
  return typeof value === "string" && OPAQUE.test(value);
}

function freezeBootstrapFacts(facts: Readonly<{
  bootstrapId: string;
  playerId: string;
  companionId: string;
  expiresAtMs: number;
}>): StardewPrivateBootstrapFacts {
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
