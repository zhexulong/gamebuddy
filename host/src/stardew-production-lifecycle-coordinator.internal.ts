import {
  consumeComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationIssuer,
} from "./composed-reference-game-browser.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import {
  createStardewPrivateBootstrapComposition,
} from "./stardew-private-bootstrap-composer.internal.js";
import type { StardewOwnedPlayerHostPhaseAOwner } from "./stardew-private-bootstrap-composer.js";
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
  state: "inactive" | "reserving" | "staging" | "staged" | "failed" | "closing" | "closed";
}>;

export type StardewLifecycleActivationIssuerBindingSink = Readonly<{
  bindBrowserAdmissionIssuer(issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer): void;
}>;

export type StardewProductionLifecycleActivationOwner = Readonly<{
  bindBrowserAdmissionIssuer(issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer): void;
  activate(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
  ): Promise<StardewPrivateActivationSnapshot>;
  readPrivateActivationSnapshot(): StardewPrivateActivationSnapshot;
}>;

/** Internal production lifecycle authority; no launch or browser admission is returned. */
export type StardewProductionLifecycleCoordinator = Readonly<{
  readonly lifecycleReader: StardewRoleLifecycleReader;
  readonly activationOwner: StardewProductionLifecycleActivationOwner;
  close(): Promise<void>;
}>;

type BootstrapComposition = ReturnType<typeof createStardewPrivateBootstrapComposition>;
type ActivationState = StardewPrivateActivationSnapshot["state"];

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

function createCoordinator(
  manifest: HostDeploymentManifest,
  internal: BootstrapComposition,
): StardewProductionLifecycleCoordinator {
  const runtimeRoot = `${manifest.runtimeRoot}`;
  const playerId = `${manifest.principal.playerId}`;
  const companionId = `${manifest.principal.companionId}`;
  const requestId = `${manifest.bootstrapOperationId}`;
  const authorityGeneration = manifest.authorityGeneration;
  const composition = internal.composition;
  const facade = createStardewRoleLifecycleFacade(null, composition.aiClientProcessOwner);

  let activationState: ActivationState = "inactive";
  let revision = 0;
  let issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer | undefined;
  let acceptedAdmission: ComposedReferenceGameBrowserLifecycleActivationAdmission | undefined;
  let activationPromise: Promise<StardewPrivateActivationSnapshot> | undefined;
  let exactOwner: StardewOwnedPlayerHostPhaseAOwner | undefined;
  let ownerQuarantined = false;
  let brokerClosed = false;
  let aiStopped = false;
  let playerStopped = false;
  let closePromise: Promise<void> | undefined;

  const lifecycleReader: StardewRoleLifecycleReader = Object.freeze({
    async readRoleLifecycleView() {
      if (activationState === "closed") throw new Error("stardew_lifecycle_closed");
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

  const activationOwner: StardewProductionLifecycleActivationOwner = Object.freeze({
    bindBrowserAdmissionIssuer,
    activate,
    readPrivateActivationSnapshot: snapshot,
  });

  const closeAttempt = async (): Promise<void> => {
    if (activationState !== "closed") transition("closing");
    const activation = activationPromise;
    if (activation !== undefined) await activation.catch(() => undefined);
    let incomplete = false;
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
    if (!aiStopped) {
      try { aiStopped = successfulAiStop(composition.aiClientProcessOwner.stopOwnedAiClient()); } catch { /* retry */ }
      if (!aiStopped) incomplete = true;
    }
    if (!playerStopped) {
      try { playerStopped = successfulPlayerStop(composition.playerHostProcessOwner.stopOwnedPlayerHost()); } catch { /* retry */ }
      if (!playerStopped) incomplete = true;
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
): StardewProductionLifecycleCoordinator {
  return createCoordinator(manifest, internal);
}

/** Constructs the coordinator exclusively from the closed first-party composition. */
export function createStardewProductionLifecycleCoordinator(
  manifest: HostDeploymentManifest,
): StardewProductionLifecycleCoordinator {
  return createCoordinator(manifest, createStardewPrivateBootstrapComposition());
}
