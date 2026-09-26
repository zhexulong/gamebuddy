import {
  consumeComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationIssuer,
} from "./composed-reference-game-browser.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import type { GameOperationalGateEvidence } from "./game-operational-gate-evidence.js";
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
import { readStardewInstallationRegistration } from "./stardew-installation-registration.internal.js";
import { createPublishedWindowsReparseInspector } from "./windows-reparse-inspector/index.js";
import type { WindowsReparseInspectorCapability } from "./windows-reparse-inspector/index.js";
import { selectStardewFolder, type WindowsStardewFolderPickerCapability } from "./windows-stardew-folder-picker/index.js";
import {
  createStardewInstallationDiscoveryProvider,
  createWindowsSteamInstallationSource,
  type StardewInstallationDiscoveryProvider,
  type StardewInstallationDiscoveryProviderResult,
} from "./windows-stardew-installation-discovery/index.js";
import {
  createStardewPrivateBootstrapComposition,
} from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.js";
import type { StardewPrivateBootstrapInternalComposition } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
import type { StardewOwnedPlayerHostBootstrap } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.js";
import {
  createStardewOwnedFarmhandGameSessionMaterializer,
  type StardewOwnedFarmhandGameSessionMaterializer,
} from "./stardew-owned-farmhand-game-session-materializer.internal.js";
import {
  didStardewOwnedPlayerHostStageCEnterControlledLaunch,
  type StardewManifestHandoffChoice,
} from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
import type {
  GameCreateCommandV1,
  GameCreateResultV1,
  GameDisconnectCommandV1,
  GameEndgameCommandV1,
  GameEndgameResultV1,
  GamePrerequisitesSetupCommandV1,
  GameLaunchCommandV1,
  GameResumeCancelCommandV1,
  GameResumeCancelResultV1,
  GameResumeResultV1,
  GameReopenActionAuthorityCommandV1,
  GameReopenActionAuthorityResultV1,
  GameSessionResumeCommandV1,
  GameStopCommandV1,
  StardewCabinChoicesV1,
  StardewCabinConfirmCommandV1,
  StardewCabinConfirmResultV1,
} from "./game-browser-contract/index.js";
import type { StopOwnedAiClientResult } from "./stardew-ai-client-process-owner.js";
import {
  createStardewWorldBindingResolverFromGameAuthority,
  type CreateWorldBindingSeam,
  STARDEW_GAME_INTEGRATION_ID,
  type StardewWorldBindingResolver,
} from "./stardew-owned-farmhand-game-world-binding-resolver.internal.js";
import type { SemanticGameProductionAuthority } from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type {
  ProductionGameSessionBindingInput,
  ProductionGameSessionCreateInput,
  ProductionGameSessionMetadata,
  ProductionGameSessionWorldBinding,
  ProductionGameSessionWorldBindingInput,
  ProductionGameSessionWorldBindingTerminalInput,
} from "./continuity-semantic-store/continuity-semantic-production-store.js";
import type { RoleLaunchOperation } from "./containment/runtime/contract/game-runtime.js";
import {
  createStardewRoleLifecycleFacade,
  type StardewRoleLifecycleReader,
  type StardewRoleLifecycleView,
} from "./stardew-role-lifecycle-facade.js";
import type {
  StardewOwnedPlayerHostStageCResult,
  StardewOwnedAiClientStageDResult,
  StardewContainedPlayerHostLaunchSeam,
  StardewContainedAiClientLaunchSeam,
  StardewPlayerHostRuntimeLaunchCollaborator,
} from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";

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
  /**
   * Coordinator-owned resume phase vocabulary. The fresh resume activation
   * projects `reconnecting` while the attempt is accepted/pending, `syncing`
   * while the fresh bridge/session construction, observation and Game-owned
   * conversation runtime are being established, and `connected_idle` exactly
   * when the resumed world is attached with actions paused
   * (ready-actions-paused; see the action authority view). The browser-facing
   * layer maps this vocabulary onto its schema in the projection slice.
   */
  connectionStatus: "none" | "connected_idle" | "reconnecting" | "syncing" | "stopping" | "stopped" | "failed" | "disconnected";
}>;

export type StardewGameSurfaceAttachmentReader = Readonly<{
  readAttachmentView(): StardewGameSurfaceAttachmentView;
}>;

/**
 * Narrow durable consumer surface for `game.create` (boundary card D2/D6): the
 * Slice-0 store facade slice the lifecycle owner needs to persist the binding
 * intent and transition the session state. It is a structural pick of
 * `SemanticGameProductionAuthority`; no second store or authority is created.
 */
export type StardewGameSessionCreationAuthority = Readonly<{
  createGameSessionMetadata(input: ProductionGameSessionCreateInput): Promise<ProductionGameSessionMetadata>;
  registerGameSessionWorldBinding(input: ProductionGameSessionWorldBindingInput): Promise<ProductionGameSessionWorldBinding>;
  completeGameSessionBinding(input: ProductionGameSessionBindingInput): Promise<ProductionGameSessionMetadata>;
  failGameSessionCreation(input: ProductionGameSessionBindingInput): Promise<ProductionGameSessionMetadata>;
  markGameSessionWorldBindingTerminal(input: ProductionGameSessionWorldBindingTerminalInput): Promise<ProductionGameSessionWorldBinding>;
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

/**
 * Coordinator-owned redacted action authority projection. `active` means the
 * attached runtime can admit new Game instructions (only a fresh explicit Game
 * instruction reopens admission after a resume); `paused` is projected during
 * and after a resume that created a newer activation and while no new
 * instruction reopened the authority (equivalent to ready-actions-paused);
 * `unavailable` is projected when there is no attached runtime behind the
 * projection.
 */
export type StardewGameSurfaceActionAuthorityView = Readonly<{
  status: "unavailable" | "active" | "paused";
}>;

export type StardewGameSurfaceActionAuthorityReader = Readonly<{
  readActionAuthorityView(): StardewGameSurfaceActionAuthorityView;
}>;

export type StardewInstallationDiscoveryView = Readonly<StardewInstallationDiscoveryProviderResult>;
export type StardewInstallationSelectionResult = Readonly<{ status: "registered" | "cancelled" | "unavailable" }>;

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
  /**
   * Coordinator-owned fresh-generation resume seam. Resolves the game
   * session's registered world binding, and only after an ok resolve creates a
   * new activation: any stale failed attachment is torn down through the shared
   * teardown machinery, attachmentGeneration strictly increments to >= 2
   * (never reusing 0/1), the fresh bridge/session attach chain runs through the
   * existing materializer seam (hello, observation, Game-owned conversation
   * runtime, committed ingress), and action authority stays paused until a new
   * explicit Game instruction reopens it (no old task is resumed). Typed
   * outcomes: `attached` only after the real attach completed, `accepted` when
   * the attempt is admitted but the attach is not yet complete inside this
   * instance, unavailable for a missing/terminal binding (no activation
   * created). Fail-closed on stale tuples and in-progress overlap; the browser
   * contract schema stays unmodified.
   */
  resume(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameSessionResumeCommandV1,
  ): Promise<GameResumeResultV1>;
  /**
   * Coordinator-owned `game.create` seam (boundary card D1/D2). A new Game
   * session/world binding is created in two phases: persist the binding intent
   * (pending), then have the selected integration's private createWorldBinding
   * seam produce an opaque bindingRef, register it, complete the session, and
   * run the first activation (generation 1, actions paused until a fresh
   * explicit Game instruction reopens them). Typed outcomes: `attached` only
   * after the first activation completed, `accepted` when the durable session
   * is bound but the attach is still pending inside this instance,
   * `unavailable` when the create failed without any resumable half-record
   * (failure paths are mutually exclusive and store-enforced). It never
   * fabricates an attached result and never touches the Player world.
   */
  createGameSession(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameCreateCommandV1,
  ): Promise<GameCreateResultV1>;
  /**
   * Coordinator-owned `game.resume.cancel` seam (boundary card D3). It
   * terminates only the exact in-flight reconnect epoch (matching generation):
   * the resume retry loop stops, the armed AI activation is abandoned, a
   * partial facade is closed, and the projection becomes disconnected/
   * unavailable while the attachment generation keeps its armed value (a
   * retry mints a fresh attempt identity). The Player world and the durable
   * session state are never touched; the session stays resumable. Fail-closed
   * when no in-flight resume matches.
   */
  cancelResume(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameResumeCancelCommandV1,
  ): Promise<GameResumeCancelResultV1>;
  /**
   * Coordinator-owned action-authority reopen seam. A new explicit Game
   * instruction is the only path that reopens the paused authority to active;
   * it never touches an old task/facade/lease and never changes the
   * attachment generation. Fail-closed on any authority state other than
   * `paused` and on stale idempotency tuples.
   */
  reopenActionAuthority(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameReopenActionAuthorityCommandV1,
  ): Promise<GameReopenActionAuthorityResultV1>;
  stopGame(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameStopCommandV1,
  ): Promise<void>;
  disconnectGame(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameDisconnectCommandV1,
  ): Promise<void>;
  /**
   * Explicit endgame seam. This is the only operation that terminates the
   * Player and projects `gameended`; ordinary close, AI crash, controller EOF
   * and reconnect failure are forbidden from reaching it. It is also the only
   * operation that settles the contained Guardian attempt, which is what
   * releases the registration's active-attempt pointer.
   */
  endgameGame(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameEndgameCommandV1,
  ): Promise<GameEndgameResultV1>;
  readInstallationDiscovery(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<StardewInstallationDiscoveryView>;
  confirmInstallation(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission, candidateId: string): Promise<StardewInstallationSelectionResult>;
  retryInstallationDiscovery(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<StardewInstallationDiscoveryView>;
  cancelInstallationSelection(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<StardewInstallationSelectionResult>;
  openInstallationPicker(admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<StardewInstallationSelectionResult>;
}>;

/** Internal production lifecycle authority; no launch or browser admission is returned. */
export type StardewProductionLifecycleCoordinator = Readonly<{
  readonly lifecycleReader: StardewRoleLifecycleReader;
  readonly attachmentReader: StardewGameSurfaceAttachmentReader;
  readonly launchReadinessReader: StardewGameSurfaceLaunchReadinessReader;
  readonly actionAuthorityReader: StardewGameSurfaceActionAuthorityReader;
  readonly activationOwner: StardewProductionLifecycleActivationOwner;
  readonly headlessOperationalGame: HeadlessOperationalGame;
  close(): Promise<void>;
}>;

/**
 * Composition-only one-shot operational lease. It exposes no installation,
 * bridge, process, session, or browser admission surface: ingress activation
 * and termination are the only operations the operational runner may drive.
 * On top of that, it exposes exactly the session/dispatch/evidence faces the
 * existing production-game-task-ingress composition requires (piSessionId,
 * gameSessionId, dispatchPromptDefinedTask, cancelPromptDefinedTask,
 * nextOperationalGateEvidence).
 */
export type HeadlessOperationalGameLease = Readonly<{
  piSessionId: string;
  gameSessionId: string;
  activateCommittedIngress(): void;
  dispatchPromptDefinedTask(task: string): Promise<void>;
  cancelPromptDefinedTask(): void;
  nextOperationalGateEvidence?(): Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">>;
  close(): Promise<void>;
}>;

/** Non-exported coordinator-private headless admission consumed by production composition only. */
export type HeadlessOperationalGame = Readonly<{
  activateHeadlessOperationalGame(manifest: HostDeploymentManifest): Promise<HeadlessOperationalGameLease>;
}>;

type BootstrapComposition = StardewPrivateBootstrapInternalComposition;
type ActivationState = StardewPrivateActivationSnapshot["state"];
type MaterializeFarmhandGameSession = StardewOwnedFarmhandGameSessionMaterializer["materialize"];

/**
 * Lifecycle-owned launch strategy for the staged Player Host. The coordinator
 * treats it as opaque: the testing composition wires the direct-spawn Stage C
 * consumer (test reference), while the formal Desktop composition wires the
 * contained Player Host runtime launch seam. Production has no runtime
 * fallback; each composition root selects exactly one launch strategy.
 */
export type StardewLifecyclePlayerHostLaunch = (
  owner: StardewOwnedPlayerHostBootstrap,
  installation: AdmittedStardewInstallation,
) => Promise<StardewOwnedPlayerHostStageCResult>;

/**
 * Lifecycle-owned launch strategy for the staged AI client. Mirrors
 * `StardewLifecyclePlayerHostLaunch`: the testing composition wires the
 * direct-spawn Stage D consumer (test reference), while the formal Desktop
 * composition wires the contained AI-client runtime launch seam. Production
 * has no raw-spawn fallback; each composition root selects exactly one path.
 */
export type StardewLifecycleAiClientLaunch = (
  owner: StardewOwnedPlayerHostBootstrap,
  installation: AdmittedStardewInstallation,
) => Promise<StardewOwnedAiClientStageDResult>;

/**
 * Lifecycle-owned runtime containment horizon. The coordinator invokes it only
 * for roles that were actually launched through the contained runtime; the
 * generic runtime itself rejects contain of a role it never launched, and the
 * coordinator tracks which roles reached the launched state so no contain/close
 * is invented for the direct-spawn test reference.
 */
export type StardewContainedRuntimeTeardown = Readonly<{
  containPlayerHost(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  containAiClient(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  /**
   * Protected terminal settlement. Only the explicit endgame operation may call
   * it: it terminates and drains both role Jobs, advances the durable owner
   * attempt to `contained`, and releases the bound registration pointer through
   * the matching Guardian settlement proof.
   */
  settle(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
  close(owner: StardewOwnedPlayerHostBootstrap): Promise<void>;
}>;

/**
 * Lifecycle-owned horizon for one contained role-launch invocation (Player
 * Host or AI client; both roles share the same per-invocation launch budget).
 * It is created only after fresh admission, recipe, and reservation
 * preconditions pass; it is never derived from a bootstrap timeout, browser
 * admission expiry, owner/attempt expiry, or game lifetime.
 */
export const STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS = 60_000;

/** Creates the per-invocation `RoleLaunchOperation` at the launch-decision point. */
export function createStardewPlayerHostRoleLaunchOperation(
  nowMs: () => number = Date.now,
): RoleLaunchOperation {
  const deadlineUnixMs = nowMs() + STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS;
  if (!Number.isSafeInteger(deadlineUnixMs) || deadlineUnixMs <= Date.now())
    throw new Error("stardew_player_host_role_launch_operation_deadline_invalid");
  return Object.freeze({ deadlineUnixMs });
}

/**
 * Composes the coordinator-side launch decision for the contained runtime
 * path: after the core claim seam is handed over, create the invocation's
 * RoleLaunchOperation, request the contained role launch through the
 * composition collaborator, and convert an outcome failure into the same
 * terminal classification the direct-spawn Stage C consumer produces.
 */
export function containedPlayerHostLaunchDecision(
  runtimeLaunchPlayerHost: StardewPlayerHostRuntimeLaunchCollaborator,
  owner: StardewOwnedPlayerHostBootstrap,
  launch: StardewContainedPlayerHostLaunchSeam,
  nowMs: () => number = Date.now,
): Promise<void> {
  return runtimeLaunchPlayerHost.launchPlayerHost(owner, createStardewPlayerHostRoleLaunchOperation(nowMs), launch)
    .then((outcome) => {
      if (outcome.status !== "succeeded") throw new Error("stardew_contained_player_host_launch_failed");
    });
}

/**
 * Composes the coordinator-side launch decision for the contained AI-client
 * path: the same preconditions and deadline model as the Player Host decision,
 * with the AI-client role receiver.
 */
export function containedAiClientLaunchDecision(
  runtimeLaunchAiClient: StardewPlayerHostRuntimeLaunchCollaborator,
  owner: StardewOwnedPlayerHostBootstrap,
  launch: StardewContainedAiClientLaunchSeam,
  nowMs: () => number = Date.now,
): Promise<void> {
  return runtimeLaunchAiClient.launchAiClient(owner, createStardewPlayerHostRoleLaunchOperation(nowMs), launch)
    .then((outcome) => {
      if (outcome.status !== "succeeded") throw new Error("stardew_contained_ai_client_launch_failed");
    });
}

/**
 * Adapts the composition collaborator's per-owner runtime into the lifetime-
 * owned containment seam. Containment outcome failures never count as success.
 */
export function containedRuntimeTeardownFromCollaborator(
  runtimeLaunch: StardewPlayerHostRuntimeLaunchCollaborator,
): StardewContainedRuntimeTeardown {
  return Object.freeze({
    containPlayerHost: (owner) => runtimeLaunch.containPlayerHost(owner).then((outcome) => {
      if (outcome.status !== "succeeded") throw new Error("stardew_contained_player_host_contain_failed");
    }),
    containAiClient: (owner) => runtimeLaunch.containAiClient(owner).then((outcome) => {
      if (outcome.status !== "succeeded") throw new Error("stardew_contained_ai_client_contain_failed");
    }),
    close: (owner) => runtimeLaunch.close(owner),
    settle: (owner) => runtimeLaunch.settle(owner),
  });
}

class StardewProductionLifecycleCloseError extends Error {
  public constructor() {
    super("stardew_lifecycle_close_incomplete");
    this.name = "StardewProductionLifecycleCloseError";
  }
}

function successfulAiStop(result: StopOwnedAiClientResult): boolean {
  return result.kind === "no_owned_ai_client" || result.kind === "already_stopped" || result.kind === "terminated";
}

function isTransientFarmhandBridgeConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/**
 * Errors that mean the fresh resume attach cannot be built inside this
 * coordinator instance because the one-shot owner/connection seam is not
 * available (the prior activation consumed it) or was never armed (the AI
 * profile was never materialized). They defer the attach to the next layer's
 * fresh connection/launch authority instead of classifying the attempt as
 * failed; every other error (owner quarantined/expired, launch generation
 * mismatch, bridge protocol failures, deadlines) stays a hard failure.
 */
function isResumeAttachDeferredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "stardew_farmhand_bridge_connection_not_available" ||
    error.message === "stardew_farmhand_bridge_profile_not_materialized"
  );
}

/** The resume cancel epoch terminated the in-flight attach; the cancel seam owns its teardown and projection. */
function isResumeCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === "stardew_game_resume_cancelled";
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
  worldBindingResolver: StardewWorldBindingResolver,
  playerHostLaunch: StardewLifecyclePlayerHostLaunch,
  aiClientLaunch: StardewLifecycleAiClientLaunch,
  gameSessionCreationAuthority?: StardewGameSessionCreationAuthority,
  createWorldBindingSeam?: CreateWorldBindingSeam,
  containedRuntimeTeardown?: StardewContainedRuntimeTeardown,
  installationDiscovery?: StardewInstallationDiscoveryProvider,
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
  let exactOwner: StardewOwnedPlayerHostBootstrap | undefined;
  let ownerQuarantined = false;
  // This lifecycle owns one not-yet-launched Player Host instance. Reconnect
  // generations are a separate authority and are not implemented in this slice.
  const expectedPlayerHostInstanceGeneration = 1;
  let launchPromise: Promise<StardewPrivateActivationSnapshot> | undefined;
  const installationDiscoveryProvider = installationDiscovery;
  let launchTerminal = false;
  let playerHostAttestationCorrelated = false;
  // Roles launched through the contained runtime. Containment/close at close()
  // is invoked only for roles that actually reached the launched state through
  // the runtime; the direct-spawn test reference has no runtime and must never
  // invent contain/close.
  let playerHostLaunchThroughRuntime = false;
  let aiClientLaunchThroughRuntime = false;
  const runtimeContained: { playerHost: boolean; aiClient: boolean } = { playerHost: false, aiClient: false };
  let runtimeClosed = false;
  let brokerClosed = false;
  let farmhandGameRuntimeFacade: ConstructedUnmountedGameSemanticFacade | undefined;
  let farmhandGameRuntimeLease: ConnectedSemanticGameLease | undefined;
  let farmhandGameRuntimeFacadeClosed = false;
  let attachmentGeneration = 0;
  let attachmentConnectionStatus: StardewGameSurfaceAttachmentView["connectionStatus"] = "none";
  // Coordinator-owned action authority: a resume creates a newer activation
  // whose authority pauses until a fresh explicit Game instruction reopens it.
  let actionAuthorityStatus: StardewGameSurfaceActionAuthorityView["status"] = "unavailable";
  let resumedGameSessionId: string | undefined;
  const gameResumes = new Map<string, Readonly<{
    browserSessionId: string;
    gameSessionId: string;
    expectedAttachmentGeneration: number;
    promise: Promise<GameResumeResultV1>;
  }>>();
  let resumePromise: Promise<GameResumeResultV1> | undefined;
  /**
   * Resume cancel epoch (boundary card D3): set only by an admitted cancel,
   * reset only when a genuinely new resume attempt starts. The attach machinery
   * checks it at safe points (before every retry wait and before committing the
   * ingress) so no stale reconnect can complete after a cancel.
   */
  let resumeCancelRequested = false;
  const gameResumeCancels = new Map<string, Readonly<{
    browserSessionId: string;
    expectedAttachmentGeneration: number;
    promise: Promise<GameResumeCancelResultV1>;
  }>>();
  const gameCreates = new Map<string, Readonly<{
    browserSessionId: string;
    integrationId: string;
    continuityIdentityId: string | null;
    /** Store-level creation request identity minted inside the coordinator's idempotency slot. */
    creationRequestId: string;
    /** Store-level world binding operation identity minted by the coordinator and retained for the terminal path. */
    operationId: string;
    promise: Promise<GameCreateResultV1>;
  }>>();
  let createPromise: Promise<GameCreateResultV1> | undefined;
  const gameReopens = new Map<string, Readonly<{
    browserSessionId: string;
    expectedAttachmentGeneration: number;
    promise: Promise<GameReopenActionAuthorityResultV1>;
  }>>();
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
  const gameEndgames = new Map<string, Readonly<{
    browserSessionId: string;
    expectedAttachmentGeneration: number;
    promise: Promise<GameEndgameResultV1>;
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
  /**
   * Set once an explicit endgame settled this attempt. The durable owner record
   * is already terminal (`contained`) and both role Jobs are already drained, so
   * the later ordinary close must not re-quarantine it or re-drive the runtime.
   */
  let endgameSettled = false;
  let closePromise: Promise<void> | undefined;
  const handoffCoordinator = internal.createOwnedPlayerHostManifestHandoffCoordinator();
  const cabinHandles = new Map<string, Readonly<{
    browserSessionId: string;
    owner: StardewOwnedPlayerHostBootstrap;
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
      if (exactOwner !== undefined && activationState === "staged") {
        return Object.freeze({ generation: expectedPlayerHostInstanceGeneration, status: "ready" });
      }
      return Object.freeze({ generation: 0, status: "none" });
    },
  });
  const actionAuthorityReader: StardewGameSurfaceActionAuthorityReader = Object.freeze({
    readActionAuthorityView(): StardewGameSurfaceActionAuthorityView {
      return Object.freeze({ status: actionAuthorityStatus });
    },
  });
  // Coordinator-authoritative Player Host slot. The facade's process-owner
  // projection cannot reflect the contained runtime path (the direct Node
  // process owner is never marked when the runtime owns the launch), so the
  // lifecycle's own launch facts drive the slot for every state the
  // coordinator knows definitively; the facade remains authoritative for
  // idle/stopped/unavailable states.
  const coordinatorPlayerHostSlot = (): StardewRoleLifecycleView["playerHost"] | undefined => {
    switch (activationState) {
      case "launching_player_host":
        return Object.freeze({ state: "pending", ownership: "gamebuddy_direct_spawn" });
      case "awaiting_player_host_attestation":
        return Object.freeze({ state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn" });
      default:
        return undefined;
    }
  };
  const lifecycleReader: StardewRoleLifecycleReader = Object.freeze({
    async readRoleLifecycleView() {
      if (activationState === "awaiting_player_host_attestation" && !playerHostAttestationCorrelated)
        await correlatePlayerHostAttestation();
      const view = await facade.readRoleLifecycleView();
      const playerHost = coordinatorPlayerHostSlot();
      if (playerHost === undefined) return view;
      return Object.freeze({ schemaVersion: 1, playerHost, aiClient: view.aiClient });
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
           return internal.reserveOwnedPlayerHostBootstrapForActivation(runtimeRoot, claim);
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
       await internal.stageOwnedPlayerHostProfile(owner);
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

  const runPlayerHostLaunch = async (): Promise<StardewPrivateActivationSnapshot> => {
    const owner = exactOwner;
    if (owner === undefined) throw new Error("stardew_player_host_launch_owner_missing");
    transition("launching_player_host");
    let launchCompleted = false;
    try {
      if (isClosing()) throw new Error("stardew_lifecycle_closing");
      const result = await withFreshRegisteredInstallation((installation) =>
        playerHostLaunch(owner, installation),
      );
      launchCompleted = true;
      if (result.status.kind !== "awaiting_player_host_attestation")
        throw new Error("stardew_player_host_launch_terminal_projection_invalid");
      if (isClosing()) throw new Error("stardew_lifecycle_closing");
       transition("awaiting_player_host_attestation");
       if (containedRuntimeTeardown !== undefined) playerHostLaunchThroughRuntime = true;
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
        launchPromise = undefined;
        transition("staged");
      }
      throw new Error("stardew_player_host_launch_failed", { cause: error });
    }
  };

  const launchSelectedPlayerHost = (): Promise<StardewPrivateActivationSnapshot> => {
    if (isClosing()) return Promise.reject(new Error("stardew_lifecycle_closing"));
    if (launchTerminal) return Promise.reject(new Error("stardew_player_host_launch_quarantined"));
    if (launchPromise !== undefined) return launchPromise;
    if (activationState !== "staged")
      return Promise.reject(new Error("stardew_player_host_launch_not_staged"));
    launchPromise = runPlayerHostLaunch();
    return launchPromise;
  };

  const consumeBrowserAdmission = <T>(
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    expectedOperation: "cabin_read" | "cabin_confirm" | "discovery_read" | "discovery_confirm" | "discovery_retry" | "discovery_cancel" | "discovery_picker" | "game_setup" | "game_launch" | "game_stop" | "game_resume" | "game_resume_cancel" | "game_reopen" | "game_disconnect" | "game_endgame" | "game_create",
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

  const withFreshRegisteredInstallation = async <T>(
    callback: (installation: AdmittedStardewInstallation) => Promise<T>,
  ): Promise<T> => {
    const registration = await readStardewInstallationRegistration(runtimeRoot);
    if (registration === null || registration.state !== "ready" || registration.locator === null ||
        registration.activeAttempt === null)
      throw new Error("stardew_registered_installation_unavailable");
    const inspector = await createInstallationInspector();
    const installation = await admitStardewInstallation(inspector, registration.locator);
    return await callback(installation);
  };

  const registerInstallationLocator = async (locator: string): Promise<StardewInstallationSelectionResult> => {
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    const inspector = await createInstallationInspector();
    await admitStardewInstallation(inspector, locator);
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    const current = await readStardewInstallationRegistration(runtimeRoot);
    const owner = exactOwner;
    if (current === null || current.state !== "ready" || owner === undefined) throw new Error("stardew_installation_registration_unavailable");
    await internal.replaceStagedInstallationLocator(owner, current.revision, locator);
    return Object.freeze({ status: "registered" });
  };
  const selectAndRegisterPlayerHostInstallation = async (): Promise<boolean> => {
    const result = await selectStardewFolder(folderPicker);
    if (result.status === "cancelled") return false;
    await registerInstallationLocator(result.path);
    return true;
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
        const registered = await selectAndRegisterPlayerHostInstallation();
        if (!registered) return;
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
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
    if (activationState !== "staged")
      return Promise.reject(new Error("stardew_player_host_launch_not_staged"));
    const promise = launchSelectedPlayerHost();
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
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        const result = await withFreshRegisteredInstallation((installation) =>
          aiClientLaunch(handle.owner, installation),
        );
        if (result.status.kind !== "awaiting_ai_client_attestation")
          throw new Error("stardew_ai_client_launch_terminal_projection_invalid");
        if (containedRuntimeTeardown !== undefined) aiClientLaunchThroughRuntime = true;
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
        actionAuthorityStatus = "active";
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
          actionAuthorityStatus = "unavailable";
          resumedGameSessionId = undefined;
        }
      })().then(() => {
        if (attachmentTeardownPromise === attempt) attachmentTeardownPromise = undefined;
        resolveAttempt();
      }, rejectAttempt);
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

  const closePartialAttachment = async (): Promise<void> => {
    const stale = farmhandGameRuntimeFacade;
    if (stale === undefined) return;
    await stale.close();
    if (farmhandGameRuntimeFacade === stale) {
      farmhandGameRuntimeLease = undefined;
      farmhandGameRuntimeFacade = undefined;
      farmhandGameRuntimeFacadeClosed = true;
    }
  };

  /**
   * Explicit endgame. This is the only operation that terminates the Player and
   * projects `gameended`, and the only one that settles the contained Guardian
   * attempt (which is what releases the registration's active-attempt pointer).
   *
   * Order matters and mirrors the survival task: terminate/contain both role
   * Jobs through the contained runtime's protected settlement, then settle the
   * durable attempt and release the pointer, then tear the attachment down. A
   * normal close never reaches any of this, so it cannot end the Player world.
   */
  const endgameGame = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameEndgameCommandV1,
  ): Promise<GameEndgameResultV1> => consumeBrowserAdmission(admission, "game_endgame", (browserSessionId) => {
    // The attempt is already ended, so this is the same terminal outcome rather
    // than a new operation -- whether the caller replays the exact key or sends a
    // fresh one. This must be checked before the attachment-generation guard below,
    // because the successful endgame tears the attachment down and resets
    // `attachmentGeneration` to 0, so a repeat with the original generation would
    // otherwise be rejected as a conflict for a game that is already over. Re-driving
    // the runtime would likewise reach its settled latch and surface an opaque
    // `stardew_contained_runtime_settlement_unavailable` to the browser.
    if (endgameSettled) {
      return Promise.resolve(Object.freeze({ apiVersion: 1 as const, status: "gameended" as const }));
    }
    const existing = gameEndgames.get(command.idempotencyKey);
    if (existing !== undefined) {
      if (
        existing.browserSessionId !== browserSessionId ||
        existing.expectedAttachmentGeneration !== command.expectedAttachmentGeneration
      ) throw new Error("stardew_game_endgame_idempotency_conflict");
      return existing.promise;
    }
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    if (command.expectedAttachmentGeneration !== attachmentGeneration)
      throw new Error("stardew_game_attachment_generation_conflict");
    const owner = exactOwner;
    if (owner === undefined) throw new Error("stardew_game_endgame_unavailable");
    const promise = (async (): Promise<GameEndgameResultV1> => {
      // Nothing else may still be mutating this attempt while it is ended.
      const stopsToJoin = [...gameStops.values()].map((stop) => stop.promise.catch(() => undefined));
      await Promise.all(stopsToJoin);
      if (containedRuntimeTeardown === undefined)
        throw new Error("stardew_game_endgame_unavailable");
      // Tear the semantic attachment down first, exactly like the proven
      // disconnect path: this cancels the prompt-defined task and closes the
      // facade before anything else touches the attempt. Doing this after the
      // roles are contained would leave a lease whose task was never cancelled.
      await teardownAttachment();
      // Terminate and drain both role Jobs through the Guardian. The contained
      // runtime's settlement is deliberately guarded: it refuses unless every
      // role that actually launched is already contained, so the endgame must
      // contain them itself and can never settle an attempt whose processes are
      // still live.
      if (playerHostLaunchThroughRuntime && !runtimeContained.playerHost) {
        await containedRuntimeTeardown.containPlayerHost(owner);
        runtimeContained.playerHost = true;
      }
      if (aiClientLaunchThroughRuntime && !runtimeContained.aiClient) {
        await containedRuntimeTeardown.containAiClient(owner);
        runtimeContained.aiClient = true;
      }
      // Settle the contained attempt exactly once. This is where the durable
      // owner attempt advances to `contained` and the registration pointer is
      // released. Without it the pointer would stay bound forever, because an
      // ordinary close deliberately never contains the Player.
      await containedRuntimeTeardown.settle(owner);
      endgameSettled = true;
      actionAuthorityStatus = "unavailable";
      return Object.freeze({ apiVersion: 1 as const, status: "gameended" as const });
    })();
    gameEndgames.set(command.idempotencyKey, Object.freeze({
      browserSessionId,
      expectedAttachmentGeneration: command.expectedAttachmentGeneration,
      promise,
    }));
    return promise;
  });

  /**
   * Closes any stale previous-activation attachment (facade/lease) through the
   * shared teardown machinery before the fresh resume activation is minted, so
   * no old-activation in-memory objects outlive the new activation. A facade
   * left without a lease (a failed enter) is closed directly; a facade+lease
   * pair goes through the full teardown timing (prompt-task cancel, stops
   * join, exact facade close, generation/authority reset).
   */
  const closeStaleAttachment = async (): Promise<void> => {
    if (farmhandGameRuntimeLease !== undefined && farmhandGameRuntimeFacade !== undefined) {
      await teardownAttachment();
      return;
    }
    await closePartialAttachment();
  };

  /**
   * Builds the fresh resume activation over the registered world binding: a
   * new Farmhand bridge connection (hello/instance-binding check), a new
   * unmounted semantic facade and entered lease (fresh observation and the
   * Game-owned companion conversation runtime), then the committed ingress
   * publication. Only the coordinator's existing materializer attach seam is
   * reused; no old activation task or prompt state is resumed. Each resume
   * first arms a fresh per-activation connection/launch generation in the core
   * (ending the previous activation's AI, never reusing its connection,
   * callback, lease, or attachment), then relaunches the AI client under the
   * existing launch authority before consuming the freshly armed connection.
   * `isCancelRequested` lets a resume cancel epoch terminate the retry loop at
   * every safe point and prevent any stale reconnect from completing; the
   * create path passes a never-requested check (create is not cancellable).
   * Returns true when the attach completed, false when the attempt stays
   * accepted because the attach cannot be built inside this instance (the
   * profile was never materialized or no prior activation exists to supersede).
   */
  const attachResumedWorld = async (
    deadlineMs: number,
    isCancelRequested: () => boolean,
  ): Promise<boolean> => {
    const owner = exactOwner;
    if (owner === undefined) return false;
    attachmentConnectionStatus = "syncing";
    try {
      if (farmhandGameRuntimeFacade === undefined) {
        // Fresh activation: prepare a genuinely new generation of the one-shot
        // connection/launch authority, then relaunch the AI client through the
        // existing Stage D seam (fresh installation reread before the exact
        // claim at the launch decision). A deferred error keeps the attempt
        // accepted; every other failure abandons the armed activation so a
        // later resume can prepare a new generation again.
        await internal.prepareFreshFarmhandAiClientActivation(owner);
        if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
        try {
          await withFreshRegisteredInstallation((installation) => aiClientLaunch(owner, installation));
          if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
        } catch (error) {
          if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
          await internal.abandonFarmhandAiClientActivation(owner).catch(() => undefined);
          throw error;
        }
        while (farmhandGameRuntimeFacade === undefined) {
          if (isClosing()) throw new Error("stardew_lifecycle_closing");
          if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
          try {
            farmhandGameRuntimeFacade = await internal.consumeOwnedFarmhandBridgeConnection(
              owner,
              (connection) => materializeFarmhandGameSession(connection, deadlineMs),
            );
          } catch (error) {
            if (!isTransientFarmhandBridgeConnectError(error)) {
              if (isResumeAttachDeferredError(error)) {
                // A deferred error after arming closes the armed activation so
                // the next resume can prepare again; the attempt stays accepted.
                await internal.abandonFarmhandAiClientActivation(owner).catch(() => undefined);
                attachmentConnectionStatus = "reconnecting";
                return false;
              }
              await internal.abandonFarmhandAiClientActivation(owner).catch(() => undefined);
              throw error;
            }
            // Cancel epoch check before every retry wait (card D3.3): a cancel
            // terminates the retry loop instead of letting it continue.
            if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
            await waitForFarmhandBridgeRetry(deadlineMs);
          }
        }
        if (isCancelRequested()) {
          await closePartialAttachment();
          throw new Error("stardew_game_resume_cancelled");
        }
      }
    } catch (error) {
      if (isResumeAttachDeferredError(error)) {
        // The attempt stays accepted: the fresh attach is pending on the next
        // layer's fresh connection/launch authority for this owner.
        attachmentConnectionStatus = "reconnecting";
        return false;
      }
      throw error;
    }
    const enteredLease = await farmhandGameRuntimeFacade.runEnter();
    farmhandGameRuntimeLease = enteredLease;
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    if (isCancelRequested()) {
      // The reconnect epoch is terminated before its ingress commits; only a
      // partial facade (never a committed attachment) is closed here.
      await closePartialAttachment();
      throw new Error("stardew_game_resume_cancelled");
    }
    enteredLease.host.attachVoiceStopper(async () => undefined);
    enteredLease.activateCommittedIngress();
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    // The resumed world is attached with actions paused: the authority is
    // reopened only by a fresh explicit Game instruction (ready-actions-paused).
    attachmentConnectionStatus = "connected_idle";
    return true;
  };

  const resume: StardewProductionLifecycleActivationOwner["resume"] = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameSessionResumeCommandV1,
  ): Promise<GameResumeResultV1> => consumeBrowserAdmission(admission, "game_resume", (browserSessionId, sessionExpiryMs) => {
    const prior = gameResumes.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (
        prior.browserSessionId !== browserSessionId ||
        prior.gameSessionId !== command.gameSessionId ||
        prior.expectedAttachmentGeneration !== command.expectedAttachmentGeneration
      ) throw new Error("stardew_game_resume_idempotency_conflict");
      return prior.promise;
    }
    if (resumePromise !== undefined || createPromise !== undefined)
      throw new Error("stardew_game_resume_in_progress");
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    // Resume is the recovery seam over a previously ended activation. A live,
    // healthy attached runtime is still a single-activation authority, so a
    // fresh generation is never minted on top of one; a stale attachment
    // marked failed is closed through the shared teardown machinery instead.
    if (farmhandGameRuntimeLease !== undefined && attachmentConnectionStatus !== "failed")
      throw new Error("stardew_game_runtime_unavailable");
    // One coordinator owns one resumed world binding; resuming a different
    // Game session under the same lifecycle is a stale cross-session command.
    if (resumedGameSessionId !== undefined && command.gameSessionId !== resumedGameSessionId)
      throw new Error("stardew_game_resume_idempotency_conflict");
    // Fresh resume generations start at >= 2, strictly increment, and never
    // reuse the 0/1 pair owned by the initial activation.
    const nextGeneration = Math.max(attachmentGeneration + 1, 2);
    if (command.expectedAttachmentGeneration !== nextGeneration)
      throw new Error("stardew_game_attachment_generation_conflict");
    const resumeDeadlineMs = Math.min(sessionExpiryMs, Date.now() + 60_000);
    // A genuinely new attempt resets the cancel epoch; a cancel is only
    // admitted while THIS attempt is in flight, so no stale flag survives.
    resumeCancelRequested = false;
    let attempt!: Promise<GameResumeResultV1>;
    attempt = (async (): Promise<GameResumeResultV1> => {
      try {
        const outcome = await worldBindingResolver.resolveWorldBinding(command.gameSessionId);
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        if (!outcome.ok) {
          // No activation is created for a missing/foreign/terminal binding.
          return Object.freeze({ apiVersion: 1, status: "unavailable" });
        }
        // Close any stale failed attachment so no old-activation facade/lease
        // outlives the fresh activation.
        await closeStaleAttachment();
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Fresh activation: the world binding is registered and resumable.
        // Actions pause until a new explicit Game instruction reopens the
        // authority; no old task or prompt state is resumed.
        resumedGameSessionId = command.gameSessionId;
        attachmentGeneration = nextGeneration;
        attachmentConnectionStatus = "reconnecting";
        actionAuthorityStatus = "paused";
        const attached = await attachResumedWorld(resumeDeadlineMs, () => resumeCancelRequested);
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // A cancel epoch that terminated the attempt (deferred path) must
        // never surface as a successful accepted result.
        if (resumeCancelRequested) throw new Error("stardew_game_resume_cancelled");
        return Object.freeze({
          apiVersion: 1,
          status: attached ? "attached" : "accepted",
        });
      } catch (error) {
        if (isClosing()) throw new Error("stardew_lifecycle_closing", { cause: error });
        if (isResumeCancelledError(error)) {
          // The cancel seam owns the reconnect teardown and the disconnected
          // projection; the failed-attachment projection must not overwrite it.
          throw error;
        }
        attachmentConnectionStatus = "failed";
        // A partial facade created before its lease entered must not outlive
        // the failed attempt; a facade+lease pair is retained for the shared
        // teardown on retry/close.
        if (farmhandGameRuntimeLease === undefined && farmhandGameRuntimeFacade !== undefined) {
          try {
            await closePartialAttachment();
          } catch {
            // Retained for the coordinator close retry.
          }
        }
        throw error;
      } finally {
        if (resumePromise === attempt) resumePromise = undefined;
      }
    })();
    resumePromise = attempt;
    gameResumes.set(command.idempotencyKey, Object.freeze({
      browserSessionId,
      gameSessionId: command.gameSessionId,
      expectedAttachmentGeneration: command.expectedAttachmentGeneration,
      promise: attempt,
    }));
    return attempt;
  });

  /**
   * Coordinator-owned start-new-game seam (boundary card D1/D2). Admitted
   * creates persist the binding intent (pending rev1), invoke the selected
   * integration's private createWorldBinding seam, register the world binding
   * (registered rev1), complete the session (resumable rev2), and run the
   * first activation (generation 1) with actions paused (ready-actions-paused;
   * only game.reopen reopens). The two failure paths are mutually exclusive
   * and store-enforced: before registration the pending intent fails closed to
   * failed rev2 with no binding row; after registration the binding goes
   * terminal (rev2) with the metadata failed (rev3) in one transaction. The
   * result is never `attached` unless the first activation completed; a
   * closed/unmounted createWorldBinding seam or any phase failure yields
   * `unavailable` with a null gameSessionId.
   */
  const createGameSession: StardewProductionLifecycleActivationOwner["createGameSession"] = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameCreateCommandV1,
  ): Promise<GameCreateResultV1> => consumeBrowserAdmission(admission, "game_create", (browserSessionId, sessionExpiryMs) => {
    const prior = gameCreates.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (
        prior.browserSessionId !== browserSessionId ||
        prior.integrationId !== command.integrationId ||
        prior.continuityIdentityId !== command.continuityIdentityId
      ) throw new Error("stardew_game_create_idempotency_conflict");
      return prior.promise;
    }
    if (createPromise !== undefined || resumePromise !== undefined)
      throw new Error("stardew_game_create_in_progress");
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    // Single-activation authority (card D4): a live healthy attachment is a
    // live world; create is a Start-new-game operation for the post-resume
    // surface and never mints on top of one.
    if (farmhandGameRuntimeLease !== undefined && attachmentConnectionStatus !== "failed")
      throw new Error("stardew_game_runtime_unavailable");
    // Card D6: integrationId must be the coordinator's own published
    // integration; anything else would register a session this surface could
    // never attach (cross-session/world misconnect prevention).
    if (command.integrationId !== STARDEW_GAME_INTEGRATION_ID)
      throw new Error("stardew_game_create_integration_conflict");
    // The store-level creation request and world binding operation identities
    // are minted inside the coordinator's idempotency slot and retained in it
    // for the terminal failure path (card D1 decision 3 / D2).
    const creationRequestId = randomBytes(32).toString("base64url");
    const operationId = randomBytes(32).toString("base64url");
    const createDeadlineMs = Math.min(sessionExpiryMs, Date.now() + 60_000);
    let attempt!: Promise<GameCreateResultV1>;
    attempt = (async (): Promise<GameCreateResultV1> => {
      let metadata: ProductionGameSessionMetadata | null = null;
      let bindingRegistered = false;
      try {
        const authority = gameSessionCreationAuthority;
        const seam = createWorldBindingSeam;
        // A closed/unmounted integration seam fails the create before any
        // durable write: never a fabricated attached result, never a resumable
        // half-record (the Stardew implementation is a later integration
        // task; the fake second integration implements the same seam).
        if (authority === undefined || seam === undefined)
          throw new Error("stardew_game_world_creation_unavailable");
        // Phase 1: persist the binding intent (pending rev1 + store-minted
        // gameSessionId). The id is opaque; every later durable step re-verifies
        // it through the store's own CAS checks.
        metadata = await authority.createGameSessionMetadata({
          creationRequestId,
          integrationId: command.integrationId,
          continuityIdentityId: command.continuityIdentityId,
        });
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2a: the selected integration creates the actual world and only
        // then returns an opaque bindingRef.
        const world = await seam.createWorldBinding({
          gameSessionId: metadata.gameSessionId,
          integrationId: command.integrationId,
          // No integration-private world request exists on this wire; the
          // generic seam consumes it as an opaque payload for later tasks.
          worldRequest: Object.freeze({}),
        });
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2b: register the world binding under the coordinator-minted
        // operation identity (registered rev1).
        await authority.registerGameSessionWorldBinding({
          gameSessionId: metadata.gameSessionId,
          integrationId: command.integrationId,
          bindingRef: world.bindingRef,
          operationId,
        });
        bindingRegistered = true;
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2c: complete the session (resumable rev2).
        await authority.completeGameSessionBinding({
          creationRequestId,
          gameSessionId: metadata.gameSessionId,
          expectedRevision: 1,
        });
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2d: first activation (generation 1 from a clean surface, else
        // strictly incrementing). This is a new world session, not a resume:
        // the previous resume lineage's in-memory guard is cleared so it can
        // never shadow the new session, and actions stay paused until a fresh
        // explicit Game instruction reopens them.
        resumedGameSessionId = undefined;
        await closeStaleAttachment();
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        attachmentGeneration = Math.max(attachmentGeneration + 1, 1);
        attachmentConnectionStatus = "reconnecting";
        actionAuthorityStatus = "paused";
        const attached = await attachResumedWorld(createDeadlineMs, () => false);
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        return Object.freeze({
          apiVersion: 1,
          status: attached ? "attached" : "accepted",
          gameSessionId: metadata.gameSessionId,
        });
      } catch (error) {
        if (isClosing()) throw new Error("stardew_lifecycle_closing", { cause: error });
        try {
          // Card D2 failure matrix: before registration the pending intent
          // fails closed (failed rev2, no binding row); after registration the
          // binding goes terminal with the metadata failed in one transaction.
          if (bindingRegistered) {
            await gameSessionCreationAuthority!.markGameSessionWorldBindingTerminal({
              gameSessionId: metadata!.gameSessionId,
              integrationId: command.integrationId,
              expectedRevision: 1,
              operationId,
            });
          } else if (metadata !== null) {
            await gameSessionCreationAuthority!.failGameSessionCreation({
              creationRequestId,
              gameSessionId: metadata.gameSessionId,
              expectedRevision: 1,
            });
          }
        } catch (failureError) {
          // A failure path that cannot be durably applied must never be
          // reported as a clean unavailable outcome.
          throw new Error("stardew_game_create_failed", { cause: failureError });
        }
        return Object.freeze({ apiVersion: 1, status: "unavailable", gameSessionId: null });
      } finally {
        if (createPromise === attempt) createPromise = undefined;
      }
    })();
    createPromise = attempt;
    gameCreates.set(command.idempotencyKey, Object.freeze({
      browserSessionId,
      integrationId: command.integrationId,
      continuityIdentityId: command.continuityIdentityId,
      creationRequestId,
      operationId,
      promise: attempt,
    }));
    return attempt;
  });

  /**
   * Coordinator-owned resume cancel seam (boundary card D3). Only an in-flight
   * resume attempt whose armed generation matches exactly is cancellable; a
   * stale or absent epoch fails closed. The cancel epoch stops the attach
   * retry loop at its safe points, the armed AI activation is abandoned, a
   * partial facade is closed, and the projection becomes disconnected/
   * unavailable while the attachment generation keeps its armed value (a
   * retry mints a fresh attempt identity). The Player world and the durable
   * session state are never touched: no endgame, no terminal binding, no
   * metadata change, the session stays resumable.
   */
  const cancelResume: StardewProductionLifecycleActivationOwner["cancelResume"] = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameResumeCancelCommandV1,
  ): Promise<GameResumeCancelResultV1> => consumeBrowserAdmission(admission, "game_resume_cancel", (browserSessionId) => {
    const prior = gameResumeCancels.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.browserSessionId !== browserSessionId || prior.expectedAttachmentGeneration !== command.expectedAttachmentGeneration)
        throw new Error("stardew_game_resume_cancel_idempotency_conflict");
      return prior.promise;
    }
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    const inFlight = resumePromise;
    if (inFlight === undefined) throw new Error("stardew_game_resume_cancel_unavailable");
    if (command.expectedAttachmentGeneration !== attachmentGeneration)
      throw new Error("stardew_game_attachment_generation_conflict");
    resumeCancelRequested = true;
    const owner = exactOwner;
    const promise = (async (): Promise<GameResumeCancelResultV1> => {
      // Terminate the armed AI activation and close any partial facade of the
      // reconnect epoch. Both are idempotent against the attempt's own
      // cancelled cleanup and never touch the Player world or durable state.
      if (owner !== undefined) {
        await internal.abandonFarmhandAiClientActivation(owner).catch(() => undefined);
      }
      await closePartialAttachment().catch(() => undefined);
      // The attempt settles at its next safe point; no stale reconnect can
      // complete afterward.
      await inFlight.catch(() => undefined);
      // If the reconnect epoch committed before the cancel epoch landed, the
      // cancel fails closed instead of tearing down a live attachment (cancel
      // is not disconnect).
      if (farmhandGameRuntimeLease !== undefined && attachmentConnectionStatus === "connected_idle")
        throw new Error("stardew_game_resume_cancel_conflict");
      // Card D3.6: disconnected/unavailable projection; the generation keeps
      // its armed value so Retry mints the next attempt identity (G+1).
      attachmentConnectionStatus = "disconnected";
      actionAuthorityStatus = "unavailable";
      return Object.freeze({ apiVersion: 1, status: "cancelled" });
    })();
    gameResumeCancels.set(command.idempotencyKey, Object.freeze({
      browserSessionId,
      expectedAttachmentGeneration: command.expectedAttachmentGeneration,
      promise,
    }));
    return promise;
  });

  /**
   * Coordinator-owned action-authority reopen seam. A resume is the only path
   * that pauses the authority (ready-actions-paused); a fresh explicit Game
   * instruction is the only path that reopens it to active. No old task,
   * facade, lease, or attachment is touched and attachmentGeneration never
   * changes. Fail-closed on any other authority state and on stale idempotency
   * tuples.
   */
  const reopenActionAuthority: StardewProductionLifecycleActivationOwner["reopenActionAuthority"] = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    command: GameReopenActionAuthorityCommandV1,
  ): Promise<GameReopenActionAuthorityResultV1> => consumeBrowserAdmission(admission, "game_reopen", (browserSessionId) => {
    const prior = gameReopens.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.browserSessionId !== browserSessionId || prior.expectedAttachmentGeneration !== command.expectedAttachmentGeneration)
        throw new Error("stardew_game_reopen_idempotency_conflict");
      return prior.promise;
    }
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    // Only a fresh explicit Game instruction may reopen a paused authority;
    // it never touches an old task/facade/lease and never changes the
    // attachment generation. A stale tuple from an older attachment fails
    // closed like every other generation-bound mutation command.
    if (actionAuthorityStatus !== "paused")
      throw new Error("stardew_game_action_authority_not_paused");
    if (command.expectedAttachmentGeneration !== attachmentGeneration)
      throw new Error("stardew_game_attachment_generation_conflict");
    actionAuthorityStatus = "active";
    const result: GameReopenActionAuthorityResultV1 = Object.freeze({ apiVersion: 1, status: "reopened" });
    const promise = Promise.resolve(result);
    gameReopens.set(command.idempotencyKey, Object.freeze({
      browserSessionId,
      expectedAttachmentGeneration: command.expectedAttachmentGeneration,
      promise,
    }));
    return promise;
  });

  const readInstallationDiscovery = (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission) =>
    consumeBrowserAdmission(admission, "discovery_read", async () => {
      if (installationDiscoveryProvider === undefined) throw new Error("stardew_installation_discovery_unavailable");
      return installationDiscoveryProvider.discover();
    });
  const confirmInstallation = (
    admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
    candidateId: string,
  ) => consumeBrowserAdmission(admission, "discovery_confirm", async () => {
    if (isClosing() || installationDiscoveryProvider === undefined)
      return Object.freeze({ status: "unavailable" as const });
    try {
      return await registerInstallationLocator(installationDiscoveryProvider.confirm(candidateId));
    } catch {
      return Object.freeze({ status: "unavailable" as const });
    }
  });
  const retryInstallationDiscovery = (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission) =>
    consumeBrowserAdmission(admission, "discovery_retry", async (): Promise<StardewInstallationDiscoveryView> => {
      if (isClosing() || installationDiscoveryProvider === undefined)
        throw new Error("stardew_installation_discovery_unavailable");
      installationDiscoveryProvider.reset();
      return installationDiscoveryProvider.discover();
    });
  const cancelInstallationSelection = (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission) =>
    consumeBrowserAdmission(admission, "discovery_cancel", async () => {
      if (isClosing()) return { status: "unavailable" as const };
      installationDiscoveryProvider?.reset();
      return { status: "cancelled" as const };
    });
  const openInstallationPicker = (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission) =>
    consumeBrowserAdmission(admission, "discovery_picker", async () => {
      if (isClosing()) return { status: "unavailable" as const };
      try { return (await selectAndRegisterPlayerHostInstallation()) ? { status: "registered" as const } : { status: "cancelled" as const }; }
      catch { return { status: "unavailable" as const }; }
    });

  const activationOwner: StardewProductionLifecycleActivationOwner = Object.freeze({
    bindBrowserAdmissionIssuer,
    activate,
    setupPlayerHost,
    launchPlayerHost,
    readPrivateActivationSnapshot: snapshot,
    readCabinChoices,
    confirmCabinChoice,
    resume,
    createGameSession,
    cancelResume,
    reopenActionAuthority,
    stopGame,
    disconnectGame,
    endgameGame,
    readInstallationDiscovery,
    confirmInstallation,
    retryInstallationDiscovery,
    cancelInstallationSelection,
    openInstallationPicker,
  });

  /**
   * Composition-only one-shot operational Game admission (Design 100). It is
   * the production operational-gate consumer of the same lifecycle core the
   * browser path uses; it never manufactures a browser admission and never
   * returns an installation, bridge, process, session, or capability fact.
   *
   * Sequence: verify the exact deployment-manifest identity → consume the
   * Design 101 registration owner → fresh-admit the private locator → reserve/
   * stage the Player Host through the same broker/owner core → Player Host
   * launch + attestation → auto-select the single registered Farmhand cabin →
   * AI-client launch → Design 99 materializer → durable runEnter. Committed
   * ingress stays armed (not activated) until the lease owner asks, exactly
   * like the browser surface only after its own ingress composition arms.
   */
  let headlessActivationInFlight = false;
  const headlessOperationalGame: HeadlessOperationalGame = Object.freeze({
    activateHeadlessOperationalGame: async (candidate: HostDeploymentManifest): Promise<HeadlessOperationalGameLease> => {
      if (isClosing()) throw new Error("stardew_lifecycle_closing");
      if (headlessActivationInFlight || acceptedAdmission !== undefined || activationPromise !== undefined || exactOwner !== undefined)
        throw new Error("stardew_lifecycle_activation_conflict");
      if (
        candidate.schemaVersion !== manifest.schemaVersion ||
        candidate.runtimeRoot !== manifest.runtimeRoot ||
        candidate.bootstrapOperationId !== manifest.bootstrapOperationId ||
        candidate.authorityGeneration !== manifest.authorityGeneration ||
        candidate.principal.playerId !== manifest.principal.playerId ||
        candidate.principal.companionId !== manifest.principal.companionId ||
        candidate.principal.continuityId !== manifest.principal.continuityId
      ) throw new Error("stardew_headless_manifest_identity_mismatch");
      // The operational runner may not drive a second lifecycle while this
      // one-shot admission is in flight; the returned lease is the only handle.
      headlessActivationInFlight = true;
      try {
        const registered = await readStardewInstallationRegistration(runtimeRoot);
        if (registered === null || registered.state !== "ready" || registered.locator === null)
          throw new Error("stardew_registered_installation_unavailable");
        transition("reserving");
        const headlessSessionId = `headless-${randomUUID()}`;
        const claim = composition.broker.confirm({
          playerId,
          companionId,
          browserSessionId: headlessSessionId,
          expiresAtMs: Date.now() + 10 * 60_000,
        }).consume(headlessSessionId);
        const owner = await internal.reserveOwnedPlayerHostBootstrapForActivation(runtimeRoot, claim);
        exactOwner = owner;
        if (isClosing()) {
          await internal.quarantineOwnedPlayerHostOwner(owner);
          ownerQuarantined = true;
          throw new Error("stardew_lifecycle_closing");
        }
        transition("staging");
        await internal.stageOwnedPlayerHostProfile(owner);
        if (isClosing()) {
          await internal.quarantineOwnedPlayerHostOwner(owner);
          ownerQuarantined = true;
          internal.terminalizeOwnedPlayerHostOwner(owner);
          throw new Error("stardew_lifecycle_closing");
        }
        transition("staged");
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Player Host launch + attestation through the same lifecycle core. The
        // one-shot headless launch never awaits a browser command; the launch
        // gate and the exact-owner attestation correlation run exactly once.
        if (launchPromise !== undefined) throw new Error("stardew_player_host_launch_in_progress");
        launchPromise = runPlayerHostLaunch();
        await launchPromise;
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Auto-select the first registered Farmhand cabin (this one-shot
        // operational topology owns exactly one AI Farmhand attachment).
        const ownerForHandoff = exactOwner;
        if (ownerForHandoff === undefined || activationState !== "awaiting_player_host_attestation")
          throw new Error("stardew_cabin_handoff_unavailable");
        const choices = await handoffCoordinator.list(ownerForHandoff);
        const choice = choices[0];
        if (choice === undefined) throw new Error("stardew_headless_cabin_unavailable");
        const handoffExpiry = choice.expiresAtMs;
        const admission = await handoffCoordinator.confirmAndAdmit(choice.selection, { confirmed: true });
        await internal.materializeAiClientProfileAfterManifestAdmission(ownerForHandoff, admission);
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        const aiResult = await withFreshRegisteredInstallation((candidateInstallation) =>
          aiClientLaunch(ownerForHandoff, candidateInstallation),
        );
        if (aiResult.status.kind !== "awaiting_ai_client_attestation")
          throw new Error("stardew_ai_client_launch_terminal_projection_invalid");
        if (containedRuntimeTeardown !== undefined) aiClientLaunchThroughRuntime = true;
        while (farmhandGameRuntimeFacade === undefined) {
          if (isClosing()) throw new Error("stardew_lifecycle_closing");
          try {
            farmhandGameRuntimeFacade = await internal.consumeOwnedFarmhandBridgeConnection(
              ownerForHandoff,
              (connection) => materializeFarmhandGameSession(connection, handoffExpiry),
            );
          } catch (error) {
            if (!isTransientFarmhandBridgeConnectError(error)) throw error;
            await waitForFarmhandBridgeRetry(handoffExpiry);
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
        // The operational surface has no Voice attachment. Bind the tracked
        // production absent-Voice STOP adapter and persist the durable
        // attachment facts; committed ingress activation is deferred to the
        // lease owner (the task-ingress composition arms before committing).
        enteredLease.host.attachVoiceStopper(async () => undefined);
        attachmentGeneration = 1;
        attachmentConnectionStatus = "connected_idle";
        actionAuthorityStatus = "active";
        let ingressActivated = false;
        let leaseClosed = false;
        const leaseUnavailable = (): never => {
          throw new Error("stardew_headless_lease_unavailable");
        };
        const requireLive = (): ConnectedSemanticGameLease => {
          if (leaseClosed || isClosing() || farmhandGameRuntimeLease !== enteredLease) leaseUnavailable();
          return enteredLease;
        };
        return Object.freeze({
          piSessionId: enteredLease.piSessionId,
          gameSessionId: enteredLease.gameSessionId,
          activateCommittedIngress: (): void => {
            const live = requireLive();
            if (ingressActivated) throw new Error("stardew_headless_ingress_already_activated");
            live.activateCommittedIngress();
            ingressActivated = true;
          },
          dispatchPromptDefinedTask: async (task: string): Promise<void> => {
            const live = requireLive();
            if (!ingressActivated) throw new Error("stardew_headless_ingress_not_activated");
            await live.dispatchPromptDefinedTask(task);
          },
          cancelPromptDefinedTask: (): void => {
            const live = requireLive();
            live.cancelPromptDefinedTask();
          },
          nextOperationalGateEvidence: enteredLease.nextOperationalGateEvidence === undefined
            ? undefined
            : () => {
                const live = requireLive();
                return live.nextOperationalGateEvidence!();
              },
          close: async (): Promise<void> => {
            if (leaseClosed) return;
            leaseClosed = true;
            await teardownAttachment();
          },
        }) as HeadlessOperationalGameLease;
      } catch (error) {
        if (isClosing()) throw new Error("stardew_lifecycle_closing", { cause: error });
        if (exactOwner !== undefined && !ownerQuarantined) {
          try {
            await internal.quarantineOwnedPlayerHostOwner(exactOwner);
            ownerQuarantined = true;
          } catch {
            // close() retains and retries the exact-owner quarantine.
          }
        }
        throw error;
      } finally {
        headlessActivationInFlight = false;
      }
    },
  });


  const closeAttempt = async (): Promise<void> => {
    if (activationState !== "closed") transition("closing");
    // An explicit endgame is terminal: it already drained both role Jobs,
    // released the platform session and drove the durable owner record to
    // `contained`. The ordinary close that follows is pure bookkeeping and must
    // not re-drive the runtime, re-quarantine the terminal owner, or re-stop an
    // owner the endgame already stopped.
    if (endgameSettled) {
      attachmentGeneration = 0;
      attachmentConnectionStatus = "none";
      actionAuthorityStatus = "unavailable";
      resumedGameSessionId = undefined;
      gameResumes.clear();
      gameResumeCancels.clear();
      gameReopens.clear();
      gameSetups.clear();
      gameStops.clear();
      gameDisconnects.clear();
      gameEndgames.clear();
      gameCreates.clear();
      transition("closed");
      return;
    }
    if (attachmentGeneration !== 0) attachmentConnectionStatus = "stopping";
    const activation = activationPromise;
    if (activation !== undefined) await activation.catch(() => undefined);
    const setup = setupPromise;
    if (setup !== undefined) await setup.catch(() => undefined);
    const launch = launchPromise;
    if (launch !== undefined) await launch.catch(() => undefined);
    const resume = resumePromise;
    if (resume !== undefined) await resume.catch(() => undefined);
    const create = createPromise;
    if (create !== undefined) await create.catch(() => undefined);
    const confirmationKey = cabinConfirmationKey;
    if (confirmationKey !== undefined) {
      await cabinConfirmations.get(confirmationKey)?.promise.catch(() => undefined);
    }
    // Join any in-flight explicit endgame before touching the contained runtime.
    // The endgame is the only route to a terminal attempt, and it drives
    // contain/settle on the same runtime this close is about to close. Without this
    // join both orders are reachable: a close that lands between the endgame's
    // contains would mark the runtime closed, so the endgame's next contain/settle
    // rejects AFTER the Player Job was already terminated -- leaving the Player
    // dead, the durable owner record nonterminal and the registration pointer still
    // bound, with no path back to terminality. Joined exactly like the stop join
    // above.
    const endingsToJoin = [...gameEndgames.values()].map((endgame) => endgame.promise.catch(() => undefined));
    if (endingsToJoin.length > 0) await Promise.all(endingsToJoin);
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
    }
    // Ordinary close stops AI authority only. The Player Host keeps running:
    // its Job is non-kill-on-close and this path must not call `contain_role` for
    // it. ADR-0007's superseding clarification is explicit — "default GameBuddy
    // close, AI crash and controller EOF stop AI and do not end Player/world ...
    // Guardian may hold OS containment authority but must not turn last-handle
    // close into an implicit endgame" — and the survival task removes "default
    // close/crash player kill" outright. So this drains the AI role, then closes
    // the platform session (which releases the Guardian's ownership without
    // terminating the Player), and never contains the Player.
    if (containedRuntimeTeardown !== undefined && exactOwner !== undefined) {
      try {
        if (aiClientLaunchThroughRuntime && !runtimeContained.aiClient) {
          await containedRuntimeTeardown.containAiClient(exactOwner);
          runtimeContained.aiClient = true;
        }
        if ((playerHostLaunchThroughRuntime || aiClientLaunchThroughRuntime) && !runtimeClosed) {
          await containedRuntimeTeardown.close(exactOwner);
          runtimeClosed = true;
        }
      } catch {
        incomplete = true;
      }
    }
    if (incomplete) throw new StardewProductionLifecycleCloseError();
    attachmentGeneration = 0;
    attachmentConnectionStatus = "none";
    actionAuthorityStatus = "unavailable";
    resumedGameSessionId = undefined;
    gameResumes.clear();
    gameResumeCancels.clear();
    gameReopens.clear();
    gameSetups.clear();
    gameStops.clear();
    gameDisconnects.clear();
    gameCreates.clear();
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

  return Object.freeze({
    lifecycleReader,
    attachmentReader,
    launchReadinessReader,
    actionAuthorityReader,
    activationOwner,
    headlessOperationalGame,
    close,
  });
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
  worldBindingResolver: StardewWorldBindingResolver,
  playerHostLaunch: StardewLifecyclePlayerHostLaunch = (owner, installation) =>
    internal.launchStagedPlayerHost(owner, installation),
  aiClientLaunch: StardewLifecycleAiClientLaunch = (owner, installation) =>
    internal.launchMaterializedAiClient(owner, installation),
  gameSessionCreationAuthority?: StardewGameSessionCreationAuthority,
  createWorldBindingSeam?: CreateWorldBindingSeam,
  containedRuntimeTeardown?: StardewContainedRuntimeTeardown,
  installationDiscoveryProvider?: StardewInstallationDiscoveryProvider,
): StardewProductionLifecycleCoordinator {
  return createCoordinator(
    manifest,
    internal,
    createInstallationInspector,
    materializeFarmhandGameSession,
    folderPicker,
    worldBindingResolver,
    // The dedicated testing adapter keeps the direct-spawn Stage C/D consumers
    // as the deterministic behavioral reference; production composition roots
    // select the contained runtime launch strategy instead.
    playerHostLaunch,
    aiClientLaunch,
    gameSessionCreationAuthority,
    createWorldBindingSeam,
    containedRuntimeTeardown,
    installationDiscoveryProvider,
  );
}

/** Constructs the coordinator exclusively from the closed first-party composition. */
export function createStardewProductionLifecycleCoordinator(
  manifest: HostDeploymentManifest,
  folderPicker: WindowsStardewFolderPickerCapability,
  game: SemanticGameProductionAuthority,
  runtimeLaunchPlayerHost?: StardewPlayerHostRuntimeLaunchCollaborator,
): StardewProductionLifecycleCoordinator {
  const hostArtifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  const materializer = createStardewOwnedFarmhandGameSessionMaterializer(manifest, game);
  const internal = createStardewPrivateBootstrapComposition();
  // Production has no raw-spawn fallback and no second launch authority:
  // without the runtime collaborator both role launches fail closed, and the
  // direct-spawn Stage C/D consumers exist only in the test-support reference.
  const playerHostLaunch: StardewLifecyclePlayerHostLaunch = runtimeLaunchPlayerHost === undefined
    ? async () => { throw new Error("stardew_player_host_launch_runtime_unavailable"); }
    : (owner, installation) => internal.launchStagedPlayerHostContained(
        owner,
        installation,
        (launch) => containedPlayerHostLaunchDecision(runtimeLaunchPlayerHost, owner, launch),
      );
  const aiClientLaunch: StardewLifecycleAiClientLaunch = runtimeLaunchPlayerHost === undefined
    ? async () => { throw new Error("stardew_ai_client_launch_runtime_unavailable"); }
    : (owner, installation) => internal.launchMaterializedAiClientContained(
        owner,
        installation,
        (launch) => containedAiClientLaunchDecision(runtimeLaunchPlayerHost, owner, launch),
      );
  const containedRuntimeTeardown = runtimeLaunchPlayerHost === undefined
    ? undefined
    : containedRuntimeTeardownFromCollaborator(runtimeLaunchPlayerHost);
  return createCoordinator(
    manifest,
    internal,
    () => createPublishedWindowsReparseInspector(hostArtifactRoot),
    materializer.materialize,
    folderPicker,
    createStardewWorldBindingResolverFromGameAuthority(game),
    playerHostLaunch,
    aiClientLaunch,
    // Create consumes the injected Slice-0 store facade slice; the Stardew
    // createWorldBinding implementation (new world/save creation) is a later
    // integration task, so the seam stays unmounted and every create fails
    // closed as unavailable — never a fabricated attached result.
    game,
    undefined,
    containedRuntimeTeardown,
    createStardewInstallationDiscoveryProvider({ source: createWindowsSteamInstallationSource() }),
  );
}
