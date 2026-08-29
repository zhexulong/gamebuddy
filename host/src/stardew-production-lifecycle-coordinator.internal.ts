import {
  consumeComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationIssuer,
} from "./composed-reference-game-browser.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import type { ConstructedUnmountedGameSemanticFacade, ConnectedSemanticGameLease } from "./continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.js";
import { createKnownSemanticGameFacadeFromReceiptBackedBinding } from "./continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.internal.js";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { admitStardewInstallation } from "./stardew-installation-admission.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import { createGameRuntimeBindingFromReceiptBackedLaunch } from "./continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
  STARDEW_INTEGRATION_LAUNCHER,
} from "./stardew-integration-launcher.js";
import { createPublishedWindowsReparseInspector } from "./windows-reparse-inspector/index.js";
import type { WindowsReparseInspectorCapability } from "./windows-reparse-inspector/index.js";
import {
  createStardewPrivateBootstrapComposition,
} from "./stardew-private-bootstrap-composer.internal.js";
import type { StardewOwnedPlayerHostPhaseAOwner } from "./stardew-private-bootstrap-composer.js";
import {
  didStardewOwnedPlayerHostStageCEnterControlledLaunch,
  type StardewManifestHandoffChoice,
  type StardewPrivateFarmhandBridgeConnection,
} from "./stardew-private-bootstrap-composer.core.js";
import type {
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

export type StardewProductionLifecycleActivationOwner = Readonly<{
  bindBrowserAdmissionIssuer(issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer): void;
  activate(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ): Promise<StardewPrivateActivationSnapshot>;
  launchStagedPlayerHost(gameDirectoryCandidate: string): Promise<StardewPrivateActivationSnapshot>;
  readPrivateActivationSnapshot(): StardewPrivateActivationSnapshot;
  readCabinChoices(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ): Promise<StardewCabinChoicesV1>;
  confirmCabinChoice(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: StardewCabinConfirmCommandV1,
  ): Promise<StardewCabinConfirmResultV1>;
}>;

/** Internal production lifecycle authority; no launch or browser admission is returned. */
export type StardewProductionLifecycleCoordinator = Readonly<{
  readonly lifecycleReader: StardewRoleLifecycleReader;
  readonly activationOwner: StardewProductionLifecycleActivationOwner;
  close(): Promise<void>;
}>;

type BootstrapComposition = ReturnType<typeof createStardewPrivateBootstrapComposition>;
type ActivationState = StardewPrivateActivationSnapshot["state"];
type ConnectFarmhandGameRuntimeFacade = (
  connection: StardewPrivateFarmhandBridgeConnection,
  deadlineMs: number,
) => Promise<ConstructedUnmountedGameSemanticFacade>;

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
  connectFarmhandGameRuntimeFacade: ConnectFarmhandGameRuntimeFacade,
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
  let launchCandidate: string | undefined;
  let launchPromise: Promise<StardewPrivateActivationSnapshot> | undefined;
  let launchTerminal = false;
  let playerHostAttestationCorrelated = false;
  let brokerClosed = false;
  let farmhandGameRuntimeFacade: ConstructedUnmountedGameSemanticFacade | undefined;
  let farmhandGameRuntimeLease: ConnectedSemanticGameLease | undefined;
  let farmhandGameRuntimeFacadeClosed = false;
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
    candidate: string,
  ): Promise<StardewPrivateActivationSnapshot> => {
    const owner = exactOwner;
    if (owner === undefined) throw new Error("stardew_player_host_launch_owner_missing");
    transition("launching_player_host");
    let launchCompleted = false;
    try {
      const inspector = await createInstallationInspector();
      const installation = await admitStardewInstallation(inspector, candidate);
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
        launchCandidate = undefined;
        launchPromise = undefined;
        transition("staged");
      }
      throw new Error("stardew_player_host_launch_failed", { cause: error });
    }
  };

  const launchStagedPlayerHost = (
    candidate: string,
  ): Promise<StardewPrivateActivationSnapshot> => {
    if (isClosing()) return Promise.reject(new Error("stardew_lifecycle_closing"));
    if (launchTerminal) return Promise.reject(new Error("stardew_player_host_launch_quarantined"));
    if (launchCandidate !== undefined) {
      if (candidate !== launchCandidate)
        return Promise.reject(new Error("stardew_player_host_launch_conflict"));
      return launchPromise!;
    }
    if (activationState !== "staged")
      return Promise.reject(new Error("stardew_player_host_launch_not_staged"));
    launchCandidate = candidate;
    launchPromise = runPlayerHostLaunch(candidate);
    return launchPromise;
  };

  const consumeCabinAdmission = <T>(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    expectedOperation: "cabin_read" | "cabin_confirm",
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

  const readCabinChoices = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ): Promise<StardewCabinChoicesV1> => consumeCabinAdmission(admission, "cabin_read", async (browserSessionId, sessionExpiry) => {
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
  ): Promise<StardewCabinConfirmResultV1> => consumeCabinAdmission(admission, "cabin_confirm", (browserSessionId) => {
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
        const candidate = launchCandidate;
        if (candidate === undefined) throw new Error("stardew_ai_client_launch_candidate_missing");
        const inspector = await createInstallationInspector();
        const installation = await admitStardewInstallation(inspector, candidate);
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        const result = await internal.launchOwnedAiClientStageD(handle.owner, installation);
        if (result.status.kind !== "awaiting_ai_client_attestation")
          throw new Error("stardew_ai_client_launch_terminal_projection_invalid");
        while (farmhandGameRuntimeFacade === undefined) {
          if (isClosing()) throw new Error("stardew_lifecycle_closing");
          try {
            farmhandGameRuntimeFacade = await internal.consumeOwnedFarmhandBridgeConnection(
              handle.owner,
              (connection) => connectFarmhandGameRuntimeFacade(connection, handle.expiresAtMs),
            );
          } catch (error) {
            if (!isTransientFarmhandBridgeConnectError(error)) throw error;
            await waitForFarmhandBridgeRetry(handle.expiresAtMs);
          }
        }
        farmhandGameRuntimeLease = await farmhandGameRuntimeFacade.runEnter();
        if (isClosing()) {
          await farmhandGameRuntimeFacade.close();
          farmhandGameRuntimeFacade = undefined;
          farmhandGameRuntimeLease = undefined;
          farmhandGameRuntimeFacadeClosed = true;
          throw new Error("stardew_lifecycle_closing");
        }
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

  const activationOwner: StardewProductionLifecycleActivationOwner = Object.freeze({
    bindBrowserAdmissionIssuer,
    activate,
    launchStagedPlayerHost,
    readPrivateActivationSnapshot: snapshot,
    readCabinChoices,
    confirmCabinChoice,
  });

  const closeAttempt = async (): Promise<void> => {
    if (activationState !== "closed") transition("closing");
    const activation = activationPromise;
    if (activation !== undefined) await activation.catch(() => undefined);
    const launch = launchPromise;
    if (launch !== undefined) await launch.catch(() => undefined);
    const confirmationKey = cabinConfirmationKey;
    if (confirmationKey !== undefined) {
      await cabinConfirmations.get(confirmationKey)?.promise.catch(() => undefined);
    }
    let incomplete = false;
    if (!farmhandGameRuntimeFacadeClosed) {
      try {
        await farmhandGameRuntimeFacade?.close();
        farmhandGameRuntimeFacadeClosed = true;
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

  return Object.freeze({ lifecycleReader, activationOwner, close });
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
  connectFarmhandGameRuntimeFacade: ConnectFarmhandGameRuntimeFacade,
): StardewProductionLifecycleCoordinator {
  return createCoordinator(manifest, internal, createInstallationInspector, connectFarmhandGameRuntimeFacade);
}

/** Constructs the coordinator exclusively from the closed first-party composition. */
export function createStardewProductionLifecycleCoordinator(
  manifest: HostDeploymentManifest,
): StardewProductionLifecycleCoordinator {
  const hostArtifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  return createCoordinator(
    manifest,
    createStardewPrivateBootstrapComposition(),
    () => createPublishedWindowsReparseInspector(hostArtifactRoot),
    async (connection, deadlineMs) => {
      const bridge = await LocalStardewBridgeClient.connectFarmhand(
        connection.scope,
        connection.pipeName,
        connection.token,
        connection.launchGeneration,
        deadlineMs,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        bridge,
        Object.freeze({
          playerId: manifest.principal.playerId,
          companionId: manifest.principal.companionId,
          saveId: connection.scope.saveId,
          worldId: connection.scope.worldId,
        }),
      );
      const binding = await createGameRuntimeBindingFromReceiptBackedLaunch(
        Object.freeze({
          manifest,
          launcher: STARDEW_INTEGRATION_LAUNCHER,
          launch,
          expectedWorld: Object.freeze({
            saveId: connection.scope.saveId,
            worldId: connection.scope.worldId,
          }),
        }),
      );
      return createKnownSemanticGameFacadeFromReceiptBackedBinding(manifest, binding);
    },
  );
}
