import {
  consumeComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationIssuer,
} from "./composed-reference-game-browser.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import type {
  ConnectedSemanticGameLease,
  ConstructedUnmountedGameSemanticFacade,
} from "./continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.js";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitStardewInstallation,
  type AdmittedStardewInstallation,
} from "./stardew-installation-admission.js";
import { createPublishedWindowsReparseInspector } from "./windows-reparse-inspector/index.js";
import type { WindowsReparseInspectorCapability } from "./windows-reparse-inspector/index.js";
import { selectStardewFolder, type WindowsStardewFolderPickerCapability } from "./windows-stardew-folder-picker/index.js";
import {
  createStardewPrivateBootstrapComposition,
} from "./stardew-private-bootstrap-composer.internal.js";
import type { StardewPrivateBootstrapInternalComposition } from "./stardew-private-bootstrap-composer.core.js";
import type { StardewOwnedPlayerHostPhaseAOwner } from "./stardew-private-bootstrap-composer.js";
import {
  createStardewOwnedFarmhandGameSessionMaterializer,
  type StardewOwnedFarmhandGameSessionMaterializer,
} from "./stardew-owned-farmhand-game-session-materializer.internal.js";
import {
  didStardewOwnedPlayerHostStageCEnterControlledLaunch,
  type StardewManifestHandoffChoice,
} from "./stardew-private-bootstrap-composer.core.js";
import type {
  GameDisconnectCommandV1,
  GamePrerequisitesSetupCommandV1,
  GameLaunchCommandV1,
  GameStopCommandV1,
  StardewCabinChoicesV1,
  StardewCabinConfirmCommandV1,
  StardewCabinConfirmResultV1,
} from "./game-browser-contract/index.js";
import type { StopOwnedAiClientResult } from "./stardew-ai-client-process-owner.js";
import type { StopOwnedPlayerHostResult } from "./stardew-player-host-process-owner.js";
import {
  createStardewRoleLifecycleFacade,
  type StardewRoleLifecycleReader,
} from "./stardew-role-lifecycle-facade.js";

export type StardewPrivateActivationSnapshot = Readonly<{
  schemaVersion: 1;
  requestId: string;
  authorityGeneration: number;
  revision: number;
  state: "inactive" | "reserving" | "staging" | "staged" | "launching_player_host" | "awaiting_player_host_attestation" | "failed" | "closing" | "closed";
}>;

export type StardewLifecycleActivationIssuerBindingSink = Readonly<{
  bindBrowserAdmissionIssuer(issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer): void;
}>;

export type StardewGameSurfaceAttachmentView = Readonly<{
  status: "none" | "attached";
  generation: number;
  connectionStatus: "none" | "connected_idle" | "stopping" | "stopped" | "failed";
}>;

export type StardewGameSurfaceAttachmentReader = Readonly<{
  readAttachmentView(): StardewGameSurfaceAttachmentView;
}>;

/**
 * Narrowest coordinator-owned launch-readiness fact: the exact expected Player
 * Host instance generation this lifecycle can launch. It is 0 until the
 * coordinator owns and stages the instance, and is never sourced from the UI,
 * a manifest default, or the attachment reader.
 */
export type StardewGameSurfaceLaunchReadinessView = Readonly<{
  generation: number;
  status: "none" | "ready" | "failed";
}>;

export type StardewGameSurfaceLaunchReadinessReader = Readonly<{
  readLaunchReadinessView(): StardewGameSurfaceLaunchReadinessView;
}>;

export type StardewProductionLifecycleActivationOwner = Readonly<{
  bindBrowserAdmissionIssuer(issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer): void;
  activate(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ): Promise<StardewPrivateActivationSnapshot>;
  setupPlayerHost(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GamePrerequisitesSetupCommandV1,
  ): Promise<void>;
  launchPlayerHost(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameLaunchCommandV1,
  ): Promise<StardewPrivateActivationSnapshot>;
  readPrivateActivationSnapshot(): StardewPrivateActivationSnapshot;
  readCabinChoices(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ): Promise<StardewCabinChoicesV1>;
  confirmCabinChoice(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: StardewCabinConfirmCommandV1,
  ): Promise<StardewCabinConfirmResultV1>;
  stopGame(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameStopCommandV1,
  ): Promise<void>;
  disconnectGame(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameDisconnectCommandV1,
  ): Promise<void>;
}>;

/** Internal production lifecycle authority; no launch or browser admission is returned. */
export type StardewProductionLifecycleCoordinator = Readonly<{
  readonly lifecycleReader: StardewRoleLifecycleReader;
  readonly attachmentReader: StardewGameSurfaceAttachmentReader;
  readonly launchReadinessReader: StardewGameSurfaceLaunchReadinessReader;
  readonly activationOwner: StardewProductionLifecycleActivationOwner;
  close(): Promise<void>;
}>;

type BootstrapComposition = StardewPrivateBootstrapInternalComposition;
type ActivationState = StardewPrivateActivationSnapshot["state"];
type MaterializeFarmhandGameSession = StardewOwnedFarmhandGameSessionMaterializer["materialize"];

class StardewProductionLifecycleCloseError extends Error {
  public constructor() {
    super("stardew_lifecycle_close_incomplete");
    this.name = "StardewProductionLifecycleCloseError";
  }
}

function successfulAiStop(result: StopOwnedAiClientResult): boolean {
  return result.kind === "no_owned_ai_client" || result.kind === "already_stopped" || result.kind === "terminated";
}

function successfulPlayerStop(result: StopOwnedPlayerHostResult): boolean {
  return result.kind === "no_owned_player_host" || result.kind === "already_stopped" || result.kind === "terminated";
}

function isTransientFarmhandBridgeConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function waitForFarmhandBridgeRetry(deadlineMs: number): Promise<void> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error("bridge_connect_deadline_exceeded");
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(25, remainingMs)));
}

function createCoordinator(
  manifest: HostDeploymentManifest,
  internal: BootstrapComposition,
  createInstallationInspector: () => Promise<WindowsReparseInspectorCapability>,
  materializeFarmhandGameSession: MaterializeFarmhandGameSession,
  folderPicker: WindowsStardewFolderPickerCapability,
): StardewProductionLifecycleCoordinator {
  const runtimeRoot = `${manifest.runtimeRoot}`;
  const playerId = `${manifest.principal.playerId}`;
  const companionId = `${manifest.principal.companionId}`;
  const requestId = `${manifest.bootstrapOperationId}`;
  const authorityGeneration = manifest.authorityGeneration;
  const composition = internal.composition;
  const facade = createStardewRoleLifecycleFacade(
    null,
    composition.aiClientProcessOwner,
    composition.playerHostProcessOwner,
  );

  let activationState: ActivationState = "inactive";
  let revision = 0;
  let issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer | undefined;
  let acceptedAdmission: ComposedReferenceGameBrowserLifecycleActivationAdmission | undefined;
  let activationPromise: Promise<StardewPrivateActivationSnapshot> | undefined;
  let exactOwner: StardewOwnedPlayerHostPhaseAOwner | undefined;
  let ownerQuarantined = false;
  let admittedInstallation: AdmittedStardewInstallation | undefined;
  // This lifecycle owns one not-yet-launched Player Host instance. Reconnect
  // generations are a separate authority and are not implemented in this slice.
  const expectedPlayerHostInstanceGeneration = 1;
  let launchPromise: Promise<StardewPrivateActivationSnapshot> | undefined;
  let launchTerminal = false;
  let playerHostAttestationCorrelated = false;
  let brokerClosed = false;
  let farmhandGameRuntimeFacade: ConstructedUnmountedGameSemanticFacade | undefined;
  let farmhandGameRuntimeLease: ConnectedSemanticGameLease | undefined;
  let farmhandGameRuntimeFacadeClosed = false;
  let attachmentGeneration = 0;
  let attachmentConnectionStatus: StardewGameSurfaceAttachmentView["connectionStatus"] = "none";
  const gameStops = new Map<string, Readonly<{
    browserSessionId: string;
    expectedAttachmentGeneration: number;
    promise: Promise<void>;
  }>>();
  const gameDisconnects = new Map<string, Readonly<{
    browserSessionId: string;
    expectedAttachmentGeneration: number;
    promise: Promise<void>;
  }>>();
  let attachmentTeardownPromise: Promise<void> | undefined;
  const gameSetups = new Map<string, Readonly<{ browserSessionId: string; promise: Promise<void> }>>();
  let setupPromise: Promise<void> | undefined;
  const gameLaunches = new Map<string, Readonly<{
    browserSessionId: string;
    expectedInstanceGeneration: number;
    promise: Promise<StardewPrivateActivationSnapshot>;
  }>>();
  let aiStopped = false;
  let playerStopped = false;
  let closePromise: Promise<void> | undefined;
  const handoffCoordinator = internal.createOwnedPlayerHostManifestHandoffCoordinator();
  const cabinHandles = new Map<string, Readonly<{
    browserSessionId: string;
    owner: StardewOwnedPlayerHostPhaseAOwner;
    revision: number;
    expiresAtMs: number;
    choice: StardewManifestHandoffChoice;
    consumed: { value: boolean };
  }>>();
  const cabinConfirmations = new Map<string, Readonly<{
    payload: string;
    promise: Promise<StardewCabinConfirmResultV1>;
    uncertain: { value: boolean };
  }>>();
  let cabinConfirmationKey: string | undefined;

  const attachmentReader: StardewGameSurfaceAttachmentReader = Object.freeze({
    readAttachmentView(): StardewGameSurfaceAttachmentView {
      return Object.freeze({
        status: attachmentGeneration === 0 ? "none" : "attached",
        generation: attachmentGeneration,
        connectionStatus: attachmentConnectionStatus,
      });
    },
  });
  const launchReadinessReader: StardewGameSurfaceLaunchReadinessReader = Object.freeze({
      readLaunchReadinessView(): StardewGameSurfaceLaunchReadinessView {
        if (launchTerminal) return Object.freeze({ generation: 0, status: "failed" });
        if (exactOwner !== undefined && admittedInstallation !== undefined && activationState === "staged") {
          return Object.freeze({ generation: expectedPlayerHostInstanceGeneration, status: "ready" });
        }
        return Object.freeze({ generation: 0, status: "none" });
      },
    });
  const lifecycleReader: StardewRoleLifecycleReader = Object.freeze({
    async readRoleLifecycleView() {
      if (activationState === "awaiting_player_host_attestation" && !playerHostAttestationCorrelated)
        await correlatePlayerHostAttestation();
      return facade.readRoleLifecycleView();
    },
  });
  const isClosing = (): boolean => activationState === "closing" || activationState === "closed";

  const transition = (next: ActivationState): void => {
    if (activationState === next) return;
    activationState = next;
    revision += 1;
  };
  const snapshot = (): StardewPrivateActivationSnapshot => Object.freeze({
    schemaVersion: 1,
    requestId,
    authorityGeneration,
    revision,
    state: activationState,
  });

  const bindBrowserAdmissionIssuer = (
    candidate: ComposedReferenceGameBrowserLifecycleActivationIssuer,
  ): void => {
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    if (issuer !== undefined) throw new Error("stardew_lifecycle_activation_issuer_already_bound");
    issuer = candidate;
  };

  const runActivation = async (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ): Promise<StardewPrivateActivationSnapshot> => {
    const boundIssuer = issuer;
    if (boundIssuer === undefined) throw new Error("stardew_lifecycle_activation_issuer_unbound");
    transition("reserving");
    try {
      const ownerPromise = consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
        boundIssuer,
        admission,
        "lifecycle_activation",
        ({ browserSessionId, expiresAtMs }) => {
          const claim = composition.broker.confirm({
            playerId,
            companionId,
            browserSessionId,
            expiresAtMs: Math.min(expiresAtMs, Date.now() + 10 * 60_000),
          }).consume(browserSessionId);
           return internal.reserveOwnedPlayerHostPhaseAForActivation(runtimeRoot, claim);
        },
      );
      if (ownerPromise === undefined) throw new Error("stardew_lifecycle_activation_admission_invalid");
      const owner = await ownerPromise;
      exactOwner = owner;
      if (isClosing()) {
        await internal.quarantineOwnedPlayerHostOwner(owner);
        ownerQuarantined = true;
        throw new Error("stardew_lifecycle_closing");
      }
      transition("staging");
       await internal.stageOwnedPlayerHostPhaseB(owner);
       if (isClosing()) {
         await internal.quarantineOwnedPlayerHostOwner(owner);
         ownerQuarantined = true;
         internal.terminalizeOwnedPlayerHostOwner(owner);
         throw new Error("stardew_lifecycle_closing");
       }
      transition("staged");
      return snapshot();
    } catch (error) {
      if (!isClosing()) transition("failed");
      throw new Error("stardew_lifecycle_activation_failed", { cause: error });
    }
  };

  const activate = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ): Promise<StardewPrivateActivationSnapshot> => {
    if (activationState === "closing" || activationState === "closed")
      return Promise.reject(new Error("stardew_lifecycle_closing"));
    if (acceptedAdmission !== undefined) {
      if (acceptedAdmission !== admission)
        return Promise.reject(new Error("stardew_lifecycle_activation_conflict"));
      return activationPromise!;
    }
    acceptedAdmission = admission;
    activationPromise = runActivation(admission);
    return activationPromise;
  };

  const correlatePlayerHostAttestation = async (): Promise<void> => {
    const owner = exactOwner;
    if (owner === undefined) throw new Error("stardew_player_host_attestation_owner_missing");
    try {
      playerHostAttestationCorrelated = await internal.readAndCorrelateOwnedPlayerHostSession(owner);
    } catch (error) {
      launchTerminal = true;
      if (!isClosing()) transition("failed");
      try {
        await internal.quarantineOwnedPlayerHostOwner(owner);
        ownerQuarantined = true;
      } catch {
        // Preserve the terminal private correlation failure.
      }
      throw new Error("stardew_player_host_attestation_failed", { cause: error });
    }
  };

  const runPlayerHostLaunch = async (
    installation: AdmittedStardewInstallation,
  ): Promise<StardewPrivateActivationSnapshot> => {
    const owner = exactOwner;
    if (owner === undefined) throw new Error("stardew_player_host_launch_owner_missing");
    transition("launching_player_host");
    let launchCompleted = false;
    try {
      if (isClosing()) throw new Error("stardew_lifecycle_closing");
      const result = await internal.launchOwnedPlayerHostStageC(owner, installation);
      launchCompleted = true;
      if (result.status.kind !== "awaiting_player_host_attestation")
        throw new Error("stardew_player_host_launch_terminal_projection_invalid");
      if (isClosing()) throw new Error("stardew_lifecycle_closing");
       transition("awaiting_player_host_attestation");
       await correlatePlayerHostAttestation();
       return snapshot();
    } catch (error) {
      const launchMayHaveRun = launchCompleted || didStardewOwnedPlayerHostStageCEnterControlledLaunch(error);
      if (launchMayHaveRun) {
        launchTerminal = true;
        if (!isClosing()) transition("failed");
        try {
          await internal.quarantineOwnedPlayerHostOwner(owner);
          ownerQuarantined = true;
        } catch {
          // Close retains and retries the exact-owner quarantine.
        }
      } else if (!isClosing()) {
        admittedInstallation = undefined;
        launchPromise = undefined;
        transition("staged");
      }
      throw new Error("stardew_player_host_launch_failed", { cause: error });
    }
  };

  const launchSelectedPlayerHost = (
    installation: AdmittedStardewInstallation,
  ): Promise<StardewPrivateActivationSnapshot> => {
    if (isClosing()) return Promise.reject(new Error("stardew_lifecycle_closing"));
    if (launchTerminal) return Promise.reject(new Error("stardew_player_host_launch_quarantined"));
    if (launchPromise !== undefined) return launchPromise;
    if (activationState !== "staged")
      return Promise.reject(new Error("stardew_player_host_launch_not_staged"));
    admittedInstallation = installation;
    launchPromise = runPlayerHostLaunch(installation);
    return launchPromise;
  };

  const consumeBrowserAdmission = <T>(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    expectedOperation: "cabin_read" | "cabin_confirm" | "game_setup" | "game_launch" | "game_stop" | "game_disconnect",
    callback: (browserSessionId: string, expiresAtMs: number) => T,
  ): T => {
    const boundIssuer = issuer;
    if (boundIssuer === undefined) throw new Error("stardew_lifecycle_activation_issuer_unbound");
    const result = consumeComposedReferenceGameBrowserLifecycleActivationAdmission(
      boundIssuer,
      admission,
      expectedOperation,
      ({ browserSessionId, expiresAtMs }) => callback(browserSessionId, expiresAtMs),
    );
    if (result === undefined) throw new Error("stardew_cabin_browser_admission_invalid");
    return result;
  };

  const selectAndAdmitPlayerHostInstallation = async (): Promise<AdmittedStardewInstallation | undefined> => {
    const result = await selectStardewFolder(folderPicker);
    if (result.status === "cancelled") return undefined;
    const inspector = await createInstallationInspector();
    return admitStardewInstallation(inspector, result.path);
  };

  const setupPlayerHost = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GamePrerequisitesSetupCommandV1,
  ): Promise<void> => consumeBrowserAdmission(admission, "game_setup", (browserSessionId) => {
    const prior = gameSetups.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.browserSessionId !== browserSessionId) return Promise.reject(new Error("stardew_game_setup_idempotency_conflict"));
      return prior.promise;
    }
    if (setupPromise !== undefined) return Promise.reject(new Error("stardew_game_setup_in_progress"));
    if (isClosing()) return Promise.reject(new Error("stardew_lifecycle_closing"));
    if (activationState !== "staged") return Promise.reject(new Error("stardew_player_host_launch_not_staged"));
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        admittedInstallation = undefined;
        const installation = await selectAndAdmitPlayerHostInstallation();
        if (installation === undefined) return;
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        admittedInstallation = installation;
      } catch (error) {
        if (isClosing()) throw new Error("stardew_lifecycle_closing", { cause: error });
        throw new Error("stardew_game_setup_failed", { cause: error });
      } finally {
        if (setupPromise === promise) setupPromise = undefined;
      }
    })();
    setupPromise = promise;
    gameSetups.set(command.idempotencyKey, Object.freeze({ browserSessionId, promise }));
    return promise;
  });

  const launchPlayerHost = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameLaunchCommandV1,
  ): Promise<StardewPrivateActivationSnapshot> => consumeBrowserAdmission(admission, "game_launch", (browserSessionId) => {
    const prior = gameLaunches.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.browserSessionId !== browserSessionId || prior.expectedInstanceGeneration !== command.expectedInstanceGeneration)
        return Promise.reject(new Error("stardew_game_launch_idempotency_conflict"));
      return prior.promise;
    }
    if (isClosing()) return Promise.reject(new Error("stardew_lifecycle_closing"));
    if (setupPromise !== undefined) return Promise.reject(new Error("stardew_game_setup_in_progress"));
    if (launchPromise !== undefined) return Promise.reject(new Error("stardew_game_launch_in_progress"));
    if (command.expectedInstanceGeneration !== expectedPlayerHostInstanceGeneration)
      return Promise.reject(new Error("stardew_game_instance_generation_conflict"));
    const installation = admittedInstallation;
    if (installation === undefined || activationState !== "staged")
      return Promise.reject(new Error("stardew_player_host_launch_not_staged"));
    const promise = launchSelectedPlayerHost(installation);
    gameLaunches.set(command.idempotencyKey, Object.freeze({
      browserSessionId,
      expectedInstanceGeneration: command.expectedInstanceGeneration,
      promise,
    }));
    return promise;
  });

  const readCabinChoices = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ): Promise<StardewCabinChoicesV1> => consumeBrowserAdmission(admission, "cabin_read", async (browserSessionId, sessionExpiry) => {
    const owner = exactOwner;
    if (owner === undefined || activationState !== "awaiting_player_host_attestation")
      throw new Error("stardew_cabin_handoff_unavailable");
    const boundRevision = revision;
    const choices = await handoffCoordinator.list(owner);
    if (revision !== boundRevision || isClosing()) throw new Error("stardew_cabin_handoff_revision_changed");
    return {
      apiVersion: 1 as const,
      choices: choices.map((choice) => {
        const choiceHandle = randomBytes(32).toString("base64url");
        const expiresAtMs = Math.min(choice.expiresAtMs, sessionExpiry, Date.now() + 60_000);
        cabinHandles.set(choiceHandle, Object.freeze({
          browserSessionId, owner, revision: boundRevision, expiresAtMs, choice, consumed: { value: false },
        }));
        return { displayLabel: choice.displayLabel, availability: "available" as const, choiceHandle, expiresAtMs };
      }),
    };
  });

  const confirmCabinChoice = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: StardewCabinConfirmCommandV1,
  ): Promise<StardewCabinConfirmResultV1> => consumeBrowserAdmission(admission, "cabin_confirm", (browserSessionId) => {
    const payload = JSON.stringify(command);
    const existing = cabinConfirmations.get(command.idempotencyKey);
    if (existing !== undefined) {
      if (existing.payload !== payload) throw new Error("stardew_cabin_idempotency_conflict");
      if (existing.uncertain.value) throw new Error("stardew_cabin_publication_uncertain");
      return existing.promise;
    }
    const handle = cabinHandles.get(command.choiceHandle);
    if (handle === undefined) throw new Error("stardew_cabin_choice_handle_invalid");
    if (handle.browserSessionId !== browserSessionId) throw new Error("stardew_cabin_choice_session_conflict");
    if (handle.owner !== exactOwner || handle.revision !== revision)
      throw new Error("stardew_cabin_choice_revision_stale");
    if (handle.expiresAtMs <= Date.now()) throw new Error("stardew_cabin_choice_expired");
    if (handle.consumed.value) throw new Error("stardew_cabin_choice_consumed");
    if (cabinConfirmationKey !== undefined)
      throw new Error("stardew_cabin_confirmation_conflict");

    handle.consumed.value = true;
    cabinConfirmationKey = command.idempotencyKey;
    const uncertain = { value: false };
    let manifestAdmitted = false;
    const promise = handoffCoordinator.confirmAndAdmit(handle.choice.selection, { confirmed: true })
      .then(async (admission) => {
        manifestAdmitted = true;
        await internal.materializeAiClientProfileAfterManifestAdmission(handle.owner, admission);
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        const installation = admittedInstallation;
        if (installation === undefined) throw new Error("stardew_ai_client_launch_installation_missing");
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        const result = await internal.launchOwnedAiClientStageD(handle.owner, installation);
        if (result.status.kind !== "awaiting_ai_client_attestation")
          throw new Error("stardew_ai_client_launch_terminal_projection_invalid");
        while (farmhandGameRuntimeFacade === undefined) {
          if (isClosing()) throw new Error("stardew_lifecycle_closing");
          try {
            farmhandGameRuntimeFacade = await internal.consumeOwnedFarmhandBridgeConnection(
              handle.owner,
              (connection) => materializeFarmhandGameSession(connection, handle.expiresAtMs),
            );
          } catch (error) {
            if (!isTransientFarmhandBridgeConnectError(error)) throw error;
            await waitForFarmhandBridgeRetry(handle.expiresAtMs);
          }
        }
        const enteredLease = await farmhandGameRuntimeFacade.runEnter();
        farmhandGameRuntimeLease = enteredLease;
        if (isClosing()) {
          await farmhandGameRuntimeFacade.close();
          farmhandGameRuntimeFacade = undefined;
          farmhandGameRuntimeLease = undefined;
          farmhandGameRuntimeFacadeClosed = true;
          throw new Error("stardew_lifecycle_closing");
        }
        // The browser Game surface has no Voice attachment. Bind the tracked
        // production absent-Voice STOP adapter before releasing the committed,
        // receipt-owned initial facts. Only then publish this surface incarnation.
        enteredLease.host.attachVoiceStopper(async () => undefined);
        enteredLease.activateCommittedIngress();
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        attachmentGeneration = 1;
        attachmentConnectionStatus = "connected_idle";
        return Object.freeze({ apiVersion: 1 as const, status: "manifest_admitted" as const });
      })
      .catch(async (error: unknown) => {
        if (manifestAdmitted || (error instanceof Error && error.message === "stardew_manifest_handoff_publication_uncertain")) {
          uncertain.value = true;
          if (manifestAdmitted && !ownerQuarantined) {
            try {
              await internal.quarantineOwnedPlayerHostOwner(handle.owner);
              ownerQuarantined = true;
            } catch {
              // close() retains the exact owner and retries durable quarantine.
            }
          }
          throw new Error("stardew_cabin_publication_uncertain", { cause: error });
        }
        cabinConfirmations.delete(command.idempotencyKey);
        cabinConfirmationKey = undefined;
        handle.consumed.value = false;
        throw error;
      });
    cabinConfirmations.set(command.idempotencyKey, Object.freeze({ payload, promise, uncertain }));
    return promise;
  });

  const stopGame = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameStopCommandV1,
  ): Promise<void> => consumeBrowserAdmission(admission, "game_stop", (browserSessionId) => {
    const existing = gameStops.get(command.idempotencyKey);
    if (existing !== undefined) {
      if (
        existing.browserSessionId !== browserSessionId ||
        existing.expectedAttachmentGeneration !== command.expectedAttachmentGeneration
      )
        throw new Error("stardew_game_stop_idempotency_conflict");
      return existing.promise;
    }
    const lease = farmhandGameRuntimeLease;
    if (
      lease === undefined ||
      attachmentGeneration === 0 ||
      attachmentConnectionStatus === "failed" ||
      attachmentTeardownPromise !== undefined ||
      isClosing()
    )
      throw new Error("stardew_game_runtime_unavailable");
    if (command.expectedAttachmentGeneration !== attachmentGeneration)
      throw new Error("stardew_game_attachment_generation_conflict");
    attachmentConnectionStatus = "stopping";
    let settled: Promise<void>;
    try {
      settled = lease.host.stopAll({
        stopId: command.idempotencyKey,
        sourceEventId: randomUUID(),
        reasonCode: "player_stop_all",
      }).settled;
    } catch (error) {
      attachmentConnectionStatus = "failed";
      settled = Promise.reject(error);
    }
    const stopGeneration = attachmentGeneration;
    const promise = settled.then(
      () => {
        if (attachmentGeneration === stopGeneration) attachmentConnectionStatus = "stopped";
      },
      (error: unknown) => {
        if (attachmentGeneration === stopGeneration) attachmentConnectionStatus = "failed";
        throw error;
      },
    );
    gameStops.set(command.idempotencyKey, Object.freeze({
      browserSessionId,
      expectedAttachmentGeneration: command.expectedAttachmentGeneration,
      promise,
    }));
    return promise;
  });

  const teardownAttachment = (): Promise<void> => {
    if (attachmentTeardownPromise !== undefined) return attachmentTeardownPromise;
    const facadeToClose = farmhandGameRuntimeFacade;
    const leaseToCancel = farmhandGameRuntimeLease;
    const generationToClose = attachmentGeneration;
    if (facadeToClose === undefined || leaseToCancel === undefined || generationToClose === 0)
      return Promise.resolve();

    let resolveAttempt!: () => void;
    let rejectAttempt!: (error: unknown) => void;
    const attempt = new Promise<void>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    // Publish the shared teardown linearization point before cancellation can
    // synchronously throw or re-enter STOP/disconnect admission.
    attachmentTeardownPromise = attempt;
    attachmentConnectionStatus = "stopping";

    try {
      leaseToCancel.cancelPromptDefinedTask();
      const stopsToJoin = [...gameStops.values()]
        .filter((stop) => stop.expectedAttachmentGeneration === generationToClose)
        // A terminal STOP failure still permits the stronger containment action
        // of closing the exact semantic facade, but teardown must wait for it.
        .map((stop) => stop.promise.catch(() => undefined));
      void (async () => {
        await Promise.all(stopsToJoin);
        await facadeToClose.close();
        if (
          farmhandGameRuntimeFacade === facadeToClose &&
          farmhandGameRuntimeLease === leaseToCancel &&
          attachmentGeneration === generationToClose
        ) {
          farmhandGameRuntimeFacadeClosed = true;
          farmhandGameRuntimeFacade = undefined;
          farmhandGameRuntimeLease = undefined;
          attachmentGeneration = 0;
          attachmentConnectionStatus = "none";
        }
      })().then(resolveAttempt, rejectAttempt);
    } catch (error) {
      rejectAttempt(error);
    }

    void attempt.catch(() => {
      if (attachmentTeardownPromise === attempt) attachmentTeardownPromise = undefined;
      if (attachmentGeneration === generationToClose) attachmentConnectionStatus = "failed";
    });
    return attempt;
  };

  const disconnectGame = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameDisconnectCommandV1,
  ): Promise<void> => consumeBrowserAdmission(admission, "game_disconnect", (browserSessionId) => {
    const existing = gameDisconnects.get(command.idempotencyKey);
    if (existing !== undefined) {
      if (
        existing.browserSessionId !== browserSessionId ||
        existing.expectedAttachmentGeneration !== command.expectedAttachmentGeneration
      ) throw new Error("stardew_game_disconnect_idempotency_conflict");
      return existing.promise;
    }
    if (attachmentTeardownPromise !== undefined)
      throw new Error("stardew_game_disconnect_in_progress");
    if (command.expectedAttachmentGeneration !== attachmentGeneration)
      throw new Error("stardew_game_attachment_generation_conflict");
    if (farmhandGameRuntimeFacade === undefined || farmhandGameRuntimeLease === undefined || isClosing())
      throw new Error("stardew_game_runtime_unavailable");
    const promise = teardownAttachment();
    gameDisconnects.set(command.idempotencyKey, Object.freeze({
      browserSessionId,
      expectedAttachmentGeneration: command.expectedAttachmentGeneration,
      promise,
    }));
    return promise;
  });

  const activationOwner: StardewProductionLifecycleActivationOwner = Object.freeze({
    bindBrowserAdmissionIssuer,
    activate,
    setupPlayerHost,
    launchPlayerHost,
    readPrivateActivationSnapshot: snapshot,
    readCabinChoices,
    confirmCabinChoice,
    stopGame,
    disconnectGame,
  });

  const closeAttempt = async (): Promise<void> => {
    if (activationState !== "closed") transition("closing");
    if (attachmentGeneration !== 0) attachmentConnectionStatus = "stopping";
    const activation = activationPromise;
    if (activation !== undefined) await activation.catch(() => undefined);
    const setup = setupPromise;
    if (setup !== undefined) await setup.catch(() => undefined);
    const launch = launchPromise;
    if (launch !== undefined) await launch.catch(() => undefined);
    const confirmationKey = cabinConfirmationKey;
    if (confirmationKey !== undefined) {
      await cabinConfirmations.get(confirmationKey)?.promise.catch(() => undefined);
    }
    let incomplete = false;
    if (!farmhandGameRuntimeFacadeClosed) {
      try {
        if (farmhandGameRuntimeFacade !== undefined && farmhandGameRuntimeLease !== undefined && attachmentGeneration !== 0)
          await teardownAttachment();
        else {
          await farmhandGameRuntimeFacade?.close();
          farmhandGameRuntimeFacadeClosed = true;
          farmhandGameRuntimeFacade = undefined;
          farmhandGameRuntimeLease = undefined;
        }
      } catch {
        incomplete = true;
      }
    }
    const mayStopOwnedProcesses = farmhandGameRuntimeFacadeClosed;
    if (exactOwner !== undefined && !ownerQuarantined) {
      try {
        await internal.quarantineOwnedPlayerHostOwner(exactOwner);
        ownerQuarantined = true;
      } catch {
        incomplete = true;
      }
    }
    if (!brokerClosed) {
      try { composition.broker.close(); brokerClosed = true; } catch { incomplete = true; }
    }
    if (mayStopOwnedProcesses) {
      if (!aiStopped) {
        try { aiStopped = successfulAiStop(composition.aiClientProcessOwner.stopOwnedAiClient()); } catch { /* retry */ }
        if (!aiStopped) incomplete = true;
      }
      if (!playerStopped) {
        try { playerStopped = successfulPlayerStop(composition.playerHostProcessOwner.stopOwnedPlayerHost()); } catch { /* retry */ }
        if (!playerStopped) incomplete = true;
      }
    }
    if (incomplete) throw new StardewProductionLifecycleCloseError();
    attachmentGeneration = 0;
    attachmentConnectionStatus = "none";
    gameSetups.clear();
    gameStops.clear();
    gameDisconnects.clear();
    transition("closed");
  };

  const close = (): Promise<void> => {
    if (activationState === "closed") return closePromise ?? Promise.resolve();
    if (closePromise !== undefined) return closePromise;
    // Reject bind/activate synchronously before any drain starts.
    transition("closing");
    const attempt = closeAttempt();
    closePromise = attempt;
    void attempt.catch(() => { if (activationState !== "closed") closePromise = undefined; });
    return attempt;
  };

  return Object.freeze({ lifecycleReader, attachmentReader, launchReadinessReader, activationOwner, close });
}

/**
 * Residual internal test join. It is imported only by the source-named
 * `*.test-support-internal.ts` adapter; production composition never accepts
 * caller dependencies. The adapter remains temporary until the wider Host
 * test-support registry is consolidated.
 */
export function createStardewProductionLifecycleCoordinatorFromTestingComposition(
  manifest: HostDeploymentManifest,
  internal: BootstrapComposition,
  createInstallationInspector: () => Promise<WindowsReparseInspectorCapability>,
  materializeFarmhandGameSession: MaterializeFarmhandGameSession,
  folderPicker: WindowsStardewFolderPickerCapability,
): StardewProductionLifecycleCoordinator {
  return createCoordinator(manifest, internal, createInstallationInspector, materializeFarmhandGameSession, folderPicker);
}

/** Constructs the coordinator exclusively from the closed first-party composition. */
export function createStardewProductionLifecycleCoordinator(
  manifest: HostDeploymentManifest,
  folderPicker: WindowsStardewFolderPickerCapability,
): StardewProductionLifecycleCoordinator {
  const hostArtifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  const materializer = createStardewOwnedFarmhandGameSessionMaterializer(manifest);
  return createCoordinator(
    manifest,
    createStardewPrivateBootstrapComposition(),
    () => createPublishedWindowsReparseInspector(hostArtifactRoot),
    materializer.materialize,
    folderPicker,
  );
}
