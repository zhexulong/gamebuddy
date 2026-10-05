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
import {
  readStardewInstallationRegistration,
  withStardewLifecycleInstallationRegistrationOwner,
} from "./stardew-installation-registration.internal.js";
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
  openRecoverableStardewBootstrapOwner,
  readRecoverableStardewBootstrapOwnerRecoveryBinding,
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
import {
  createStardewIssuedJoinManifestSource,
  createStardewWorldCreationBindingSeam,
} from "./stardew-owned-farmhand-game-world-creation-seam.internal.js";
import type { SemanticGameProductionAuthority } from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type {
  ProductionGameSessionBindingInput,
  ProductionGameSessionCreateInput,
  ProductionGameSessionMetadata,
  ProductionGameSessionWorldBinding,
  ProductionGameSessionWorldBindingInput,
  ProductionGameSessionWorldBindingSlotHolder,
  ProductionGameSessionWorldBindingSlotReleaseInput,
  ProductionGameSessionWorldBindingTerminalInput,
} from "./continuity-semantic-store/continuity-semantic-production-store.js";
import {
  mintGameSessionWorldBindingSlotLeaseVerdict,
  productionGameSessionWorldBindingSlotLeaseVerdict,
} from "./continuity-semantic-store/continuity-semantic-production-store.js";
import type { RedactedRecoveryOutcome, RoleLaunchOperation } from "./containment/runtime/contract/game-runtime.js";
import { FarmhandBridgeConnectionNotAvailableError } from "./containment/runtime/contract/game-runtime.js";
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
import {
  readStardewOwnerRecoveryDriver,
  type StardewOwnerRecoveryRequest,
} from "./composition/stardew/stardew-guardian-platform.js";

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
  /**
   * Slot-addressed holder readback: what - if anything - still holds the world
   * slot an (integration, binding ref) names, including the opaque handle its
   * release demands. A create that observes a holder is looking at an attempt
   * whose own registration never closed out.
   */
  readGameSessionWorldBindingSlotHolder(
    input: Readonly<{ integrationId: string; bindingRef: string }>,
  ): Promise<ProductionGameSessionWorldBindingSlotHolder | null>;
  /**
   * Releases one slot whose holder is proven gone, landing it on the canonical
   * terminal shape. It takes the holder's own handle plus the native-lease
   * verdict correlated to that handle; the store refuses every weaker proof, so
   * this member is not a way to free a slot whose holder was not proven gone.
   */
  releaseGameSessionWorldBindingSlot(
    input: ProductionGameSessionWorldBindingSlotReleaseInput,
  ): Promise<ProductionGameSessionWorldBinding>;
}>;

/**
 * Integration-private PER-CREATE world-creation seam builder (Loop 4 path B').
 *
 * The Stardew seam may only report the physical save slot the exact launched
 * Player Host observed, and the only authority for that slot is the signed join
 * manifest the Player Host issued for THIS create's own attachment request. The
 * builder therefore receives the admitted join request identity and the exact
 * owner that manifest belongs to, and returns the seam for that one create: the
 * coordinator can never hand it a caller-supplied world identity, and a create
 * that has no admitted manifest has no seam to call. The returned seam is
 * bounded by the coordinator's own create deadline.
 */
export type StardewWorldCreationSeamFactory = (
  input: Readonly<{
    owner: StardewOwnedPlayerHostBootstrap;
    joinRequestId: string;
    deadlineMs: number;
  }>,
) => CreateWorldBindingSeam;

/**
 * The single durable failure closure of an admitted create attempt.
 *
 * Both legal failure shapes of the frozen create protocol (design card 114,
 * "Create durable protocol") live here and nowhere else: a failure before the
 * world binding was registered fails the pending metadata intent and leaves no
 * binding row, while a failure after registration marks the binding terminal and
 * fails the metadata inside the store's own single transaction. The repository
 * never removes a save the native game may already have produced, and a create
 * whose failure cannot be durably applied is never reported as a clean
 * unavailable outcome: its caller turns this throw into the terminal
 * `stardew_game_create_failed`.
 */
async function settleFailedCreateAttempt(input: Readonly<{
  authority: StardewGameSessionCreationAuthority | undefined;
  creationRequestId: string;
  integrationId: string;
  operationId: string;
  metadata: ProductionGameSessionMetadata | null;
  bindingRegistered: boolean;
}>): Promise<void> {
  const authority = input.authority;
  // An unmounted seam/authority fails the create before any durable write, so
  // there is nothing this closure may settle.
  if (authority === undefined) return;
  if (input.bindingRegistered) {
    await authority.markGameSessionWorldBindingTerminal({
      gameSessionId: input.metadata!.gameSessionId,
      integrationId: input.integrationId,
      expectedRevision: 1,
      operationId: input.operationId,
    });
    return;
  }
  if (input.metadata !== null) {
    await authority.failGameSessionCreation({
      creationRequestId: input.creationRequestId,
      gameSessionId: input.metadata.gameSessionId,
      expectedRevision: 1,
    });
  }
}

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
 * Which of the two legal AI-client activation shapes a fresh attach asks for.
 * `re_arm` is the resume shape: a resume is only admitted over an activation
 * that already ended, so it always arms a genuinely new one-shot generation
 * first. `core_admitted` is the create shape: the core itself decides between
 * that fresh generation and the owner's still intact first activation, and the
 * coordinator is not allowed to guess which one applies.
 */
type FreshAiClientActivation = "re_arm" | "core_admitted";

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
  /**
   * Recovery drive for the exact owner's non-terminal attempt. The owner-held
   * half of the collaborator is what makes this reachable from the lifecycle at
   * all, so it is forwarded here rather than reachable only from the composition
   * that owns the binding; the recovery actor and the post-CAS binding facts
   * arrive per invocation from the caller that observed the crashed attempt.
   */
  recover(owner: StardewOwnedPlayerHostBootstrap, request: StardewOwnerRecoveryRequest): Promise<RedactedRecoveryOutcome>;
  /**
   * Terminal closure of a recovery THIS seam drove, on the same owner path as
   * `recover` and through the same consumed one-shot owner binding: the durable
   * parent record advances to its terminal state and the bound registration
   * pointer is released, so the attempt stops occupying the registration.
   *
   * It is not a second authority: it can only be reached for an owner whose own
   * binding is already consumed (that is what drove the recovery), and the request
   * it takes is the one the recovery took, so the actor the durable CASes recorded
   * and the actor this must match cannot drift apart.
   */
  finalizeRecovered(owner: StardewOwnedPlayerHostBootstrap, request: StardewOwnerRecoveryRequest): Promise<void>;
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
export async function containedPlayerHostLaunchDecision(
  runtimeLaunchPlayerHost: StardewPlayerHostRuntimeLaunchCollaborator,
  owner: StardewOwnedPlayerHostBootstrap,
  launch: StardewContainedPlayerHostLaunchSeam,
  nowMs: () => number = Date.now,
): Promise<void> {
  // `async` is part of the contract of this adapter, not a formatting choice.
  // Every failure it can produce is a failure of the launch decision -- the
  // role-launch operation's own deadline check, or the collaborator's guards
  // and transport -- and the caller consumes the decision by awaiting the
  // returned value without a try/catch of its own. A non-async body that only
  // chains `.then()` turns any synchronous throw in that path into an
  // out-of-band exception at the caller's frame instead of a rejection, which
  // is indistinguishable from a crash. Awaiting here keeps every failure on the
  // returned promise.
  const outcome = await runtimeLaunchPlayerHost.launchPlayerHost(
    owner,
    createStardewPlayerHostRoleLaunchOperation(nowMs),
    launch,
  );
  if (outcome.status !== "succeeded") throw new Error("stardew_contained_player_host_launch_failed");
}

/**
 * Composes the coordinator-side launch decision for the contained AI-client
 * path: the same preconditions and deadline model as the Player Host decision,
 * with the AI-client role receiver.
 */
export async function containedAiClientLaunchDecision(
  runtimeLaunchAiClient: StardewPlayerHostRuntimeLaunchCollaborator,
  owner: StardewOwnedPlayerHostBootstrap,
  launch: StardewContainedAiClientLaunchSeam,
  nowMs: () => number = Date.now,
): Promise<void> {
  // Same rejection contract as the Player Host decision above: the AI-client
  // launch decision fails on its returned promise, never as a synchronous throw
  // out of this call.
  const outcome = await runtimeLaunchAiClient.launchAiClient(
    owner,
    createStardewPlayerHostRoleLaunchOperation(nowMs),
    launch,
  );
  if (outcome.status !== "succeeded") throw new Error("stardew_contained_ai_client_launch_failed");
}

/**
 * Adapts the composition collaborator's per-owner runtime into the lifetime-
 * owned containment seam. Containment outcome failures never count as success.
 */
export function containedRuntimeTeardownFromCollaborator(
  runtimeLaunch: StardewPlayerHostRuntimeLaunchCollaborator,
): StardewContainedRuntimeTeardown {
  // The recovery half is read once, here. A collaborator that cannot drive a
  // recovery (a test reference, or any adapter without an owner-held Guardian
  // binding) keeps the contain/close/settle behavior it always had and refuses a
  // recovery instead of reporting one that never ran.
  const recoveryDriver = readStardewOwnerRecoveryDriver(runtimeLaunch);
  // Every member below resolves a `Promise` in the seam's contract, so every
  // member is `async`. The seam's consumers await it (or attach only a rejection
  // handler) and hold no try/catch around the call, so a synchronous throw from
  // this adapter or from the collaborator beneath it would escape their frame as
  // an unhandled exception instead of arriving as the awaited failure they
  // handle. `async` is what keeps a refusal, a refusal reported by the
  // collaborator as a failed outcome, and a synchronous throw from the
  // collaborator all on the same rejection path.
  return Object.freeze({
    containPlayerHost: async (owner) => {
      const outcome = await runtimeLaunch.containPlayerHost(owner);
      if (outcome.status !== "succeeded") throw new Error("stardew_contained_player_host_contain_failed");
    },
    containAiClient: async (owner) => {
      const outcome = await runtimeLaunch.containAiClient(owner);
      if (outcome.status !== "succeeded") throw new Error("stardew_contained_ai_client_contain_failed");
    },
    recover: async (owner, request) => {
      if (recoveryDriver === undefined) throw new Error("stardew_contained_recovery_drive_unavailable");
      return recoveryDriver.recover(owner, request);
    },
    finalizeRecovered: async (owner, request) => {
      // The same refusal as `recover`, for the same reason: without the
      // owner-held recovery half there is nothing that could close the attempt
      // out, and reporting a finalization that never ran is exactly the
      // fabricated success this seam must never produce.
      if (recoveryDriver === undefined) throw new Error("stardew_contained_recovery_drive_unavailable");
      await recoveryDriver.finalizeRecovered(owner, request);
    },
    close: async (owner) => runtimeLaunch.close(owner),
    settle: async (owner) => runtimeLaunch.settle(owner),
  });
}

/**
 * The drive's own bounded refusal for a recovery whose native gate was HELD.
 *
 * It is a distinct code rather than the drive's generic unavailable because the
 * two answer different questions: `stardew_owner_recovery_unavailable` says the
 * recovery did not reach containment, while this one is the lease VERDICT - a
 * live handle exists at the lease name, so the holder was NOT PROVEN GONE. It is
 * never proof that the holder is alive (the handle may be a recovery gate this
 * Host itself opened), and it never means the recovery ran: nothing native ran and
 * the previous lease stays authority. A caller that has to decide whether a
 * holder's slot may be released must tell the two apart, and this is the one
 * identity it reads.
 */
export const STARDEW_OWNER_RECOVERY_GATE_HELD_REFUSAL = "stardew_owner_recovery_gate_held";

/**
 * The create's own bounded refusal for a world slot whose leftover holder was
 * NOT proven gone.
 *
 * It is the create-side reading of the drive's held-gate verdict above, and it
 * is a code of the create rather than of the drive because the two answer
 * different questions: the drive answers "did this recovery reach containment"
 * (it did not, and its own refusal says exactly that), while the create has to
 * answer "may this slot be released so this create can register on it" - and on
 * a held gate the answer is NO, because a live handle exists at the holder's
 * lease name and it may be a recovery gate this Host itself opened. Nothing is
 * finalized, nothing is released, and the leftover attempt's durable state is
 * left exactly as it was found.
 *
 * It deliberately mirrors the store's own name for the same fact
 * (`game_session_world_binding_slot_holder_not_proven_gone`) rather than
 * claiming the holder is alive: a held name proves only that SOME handle exists
 * under it, and Windows exposes no mutex-owner query that could attribute it.
 */
export const STARDEW_GAME_CREATE_SLOT_HOLDER_NOT_PROVEN_GONE = "stardew_game_create_slot_holder_not_proven_gone";

/**
 * One bounded recovery of an attempt whose durable record is not terminal,
 * closed out in the same step: drive the existing per-owner recovery seam, and
 * only when that recovery actually reached containment, finalize it so the
 * attempt's parent record becomes terminal and its registration pointer is
 * released.
 *
 * The finalization deliberately takes the SAME request object the recovery took,
 * so the recovery actor the durable CASes recorded and the actor the finalization
 * must match cannot drift apart, and a caller cannot close out a recovery under
 * an actor it never drove.
 *
 * Nothing short of `recovered` is ever finalized, and the two failing outcomes are
 * deliberately NOT folded into one code. A recovery that did not reach
 * containment reports `stardew_owner_recovery_unavailable`: the native position
 * stays unproven, an uncertain native recovery is neither closed out as if it had
 * succeeded nor re-driven here, and nothing is finalized. A recovery whose gate
 * was held reports `STARDEW_OWNER_RECOVERY_GATE_HELD_REFUSAL` instead, the lease
 * verdict rather than a recovery result. Everything else this can fail with is
 * likewise bounded: a missing seam, and whatever the finalization itself refuses
 * with.
 */
export async function driveStardewOwnedPlayerHostRecovery(
  teardown: StardewContainedRuntimeTeardown | undefined,
  owner: StardewOwnedPlayerHostBootstrap,
  request: StardewOwnerRecoveryRequest,
): Promise<void> {
  if (teardown === undefined) throw new Error("stardew_owner_recovery_seam_unavailable");
  const outcome = await teardown.recover(owner, request);
  if (outcome.status === "gate_held") throw new Error(STARDEW_OWNER_RECOVERY_GATE_HELD_REFUSAL);
  if (outcome.status !== "recovered") throw new Error("stardew_owner_recovery_unavailable");
  await teardown.finalizeRecovered(owner, request);
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
 *
 * Left on message comparison deliberately: it also covers the
 * profile-not-materialized refusal, which has no typed identity yet, so
 * converting only one of its two arms would mix the two classification styles
 * inside one predicate. It keeps working across the connection refusal's own
 * conversion because that refusal still carries the same message text.
 */
export function isResumeAttachDeferredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "stardew_farmhand_bridge_connection_not_available" ||
    error.message === "stardew_farmhand_bridge_profile_not_materialized"
  );
}

/**
 * The composition's own "this owner has no ended activation to supersede"
 * rejection. `prepareFreshFarmhandAiClientActivation` fails closed with it
 * before it reserves a generation, rotates the durable record or stops any
 * process, so it is also the one side-effect-free answer the coordinator can ask
 * for: read as "the owner's first one-shot activation is still intact", it is
 * exactly the state the untouched-reservation launch needs. Any other error is
 * left alone, so a genuinely unavailable fresh generation still fails closed.
 *
 * The test is the platform contract's typed identity rather than the refusal's
 * message text, because the composition is the only side that can see the text:
 * renaming it there would silently reclassify this state as a hard failure here,
 * with no test on either side going red. The identity is exported from the port
 * both sides project, so the two cannot drift without the shared type changing.
 */
export function isFirstFarmhandAiClientActivationIntact(error: unknown): boolean {
  return error instanceof FarmhandBridgeConnectionNotAvailableError;
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
  createWorldBindingSeam?: StardewWorldCreationSeamFactory,
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
  /**
   * Coordinator-owned record of the AI-client bridge profile it materialized
   * for its exact owner. The composition materializes that profile at most
   * once per owner, so this lifecycle must know whether the profile it depends
   * on already exists instead of re-materializing it (which the composition
   * rejects as not admissible).
   */
  let aiClientProfileMaterialized = false;
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

  /**
   * The holder handle a world-binding registration must carry is the attempt's
   * own opaque correlation: the registration pointer's `activeAttempt` is bound
   * to the owner record's `bootstrapId`, so the two always name the same attempt.
   * The store deliberately neither mints nor derives this value, so it is read
   * here and passed through verbatim.
   *
   * An interrupted owner transaction (a marker) means the pointer and the
   * attempt's owner record are mid-transition. Marker presence is never evidence
   * of a holder, so this fails closed rather than adopting a correlation it
   * cannot trust; a missing, non-ready or attempt-less pointer fails closed the
   * same way. The read itself stays inside the registration's own exclusive lock,
   * so the correlation cannot be re-bound between the check and the read.
   */
  const readWorldBindingHolderHandle = async (): Promise<string> => {
    const registration = await withStardewLifecycleInstallationRegistrationOwner(
      runtimeRoot,
      async (storage) => {
        if (await storage.readMarker() !== null) return null;
        return await storage.readRegistration();
      },
    );
    if (registration === null || registration.state !== "ready" || registration.activeAttempt === null)
      throw new Error("stardew_game_create_holder_unavailable");
    return registration.activeAttempt.bootstrapCorrelation;
  };

  /**
   * The world-slot crash-recovery trigger: the create-side half of the SLOT
   * WEDGE.
   *
   * `game.create` registers its world binding and only then completes the
   * session, so a create that died between the two - or whose settle closure
   * could not be applied - leaves the world slot held by a session that can
   * never settle itself: the per-command `operationId` its terminal settle
   * demands lived only in the dead process's memory. The slot-addressed read
   * below is what reports that leftover holder, and the holder's own handle is
   * the one thing that can name the attempt to recover.
   *
   * The trigger is deliberately narrow, and every branch of it is fail-closed:
   *
   * - NO holder - or only a settled (`terminal`) one - means there is nothing to
   *   recover, and this create then behaves exactly as it did before this seam
   *   existed.
   * - A `registered` holder means the slot is occupied. Its handle IS the crashed
   *   attempt's bootstrap id - the registration pointer's `activeAttempt.bootstrapCorrelation`
   *   is the owner record's `bootstrapId` - so the attempt to open is the one the
   *   slot names, and it is never derived, defaulted or invented here.
   * - The opener is the ONE sanctioned way to open an existing crashed
   *   (non-pristine, non-terminal) attempt. It refuses a terminal or quarantined
   *   record with its own bounded code, so a terminal attempt is never recovered
   *   through this path.
   * - The drive is the existing one (`driveStardewOwnedPlayerHostRecovery`): the
   *   same teardown seam, the same consumed one-shot owner binding, one attempt,
   *   one recovery. A recovery that did not reach containment is never retried,
   *   and nothing short of `recovered` is ever finalized.
   * - Only after that recovery finalized - which releases the crashed attempt's
   *   own registration pointer and consumes its transaction - is the slot
   *   released, with the handle READ FROM THE SLOT and a holder-gone verdict
   *   minted from that same drive result. One attempt, one verdict, one release.
   * - A HELD gate is refused under this create's own bounded code: the holder
   *   was NOT proven gone, so nothing is finalized, nothing is released, and the
   *   leftover attempt's durable state is left exactly as it was found.
   */
  const recoverLeftoverWorldBindingSlotHolder = async (
    authority: StardewGameSessionCreationAuthority,
    integrationId: string,
    bindingRef: string,
  ): Promise<void> => {
    // Closing stops a create before it does new durable work, so the two new
    // authority members below are never reached once the lifecycle is closing -
    // neither before the read nor after any await that observed closing.
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    const holder = await authority.readGameSessionWorldBindingSlotHolder({ integrationId, bindingRef });
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    // Only a `registered` holder is an occupant. The readback deliberately also
    // returns a slot's settled (`terminal`) row when nothing is registered, so
    // that a release against such a slot is refused as `holderTerminal` instead
    // of being mistaken for an unknown slot - but a settled row is NOT an
    // occupant, and treating it as one would wedge every later create on a slot
    // that has ever been settled. That is not a theoretical case here: the
    // binding ref is the physical save slot the Player Host observed, whose
    // basename is derived from the farm name, so a create that failed once
    // leaves a terminal row under exactly the ref the next create will observe.
    // The store's own cross-session rule agrees: only another `registered` row
    // refuses a registration, and a terminal binding never blocks a later
    // create. The release refuses a terminal holder too, so driving one here
    // could not even make progress.
    if (holder === null || holder.status !== "registered") return;
    const opened = await openRecoverableStardewBootstrapOwner({
      // The root the reservation path persists the attempt's `owner.json`
      // under: the same `runtimeRoot` this lifecycle read the registration and
      // the holder correlation from.
      transactionRoot: runtimeRoot,
      // The slot's own handle names the attempt, so the attempt opened is the
      // one the slot names - passed through verbatim, never derived.
      bootstrapFacts: { bootstrapId: holder.holderHandle, playerId, companionId },
    });
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    // ONE request for both halves of the recovery: the actor the durable CASes
    // record and the actor the finalization must match are the same value, and
    // the post-CAS binding read is this attempt's own current record projected
    // through the composer's strict validator - not a second durable seam and
    // not a second copy of that validator. The durable record's recorded actor
    // is adopted when it has one (an interrupted recovery resumes its exact
    // recorded actor); only a record with none mints a fresh one here.
    const request: StardewOwnerRecoveryRequest = Object.freeze({
      recoveryInstanceId: opened.recoveryInstanceId ?? randomUUID(),
      readRecoveryBinding: () => readRecoverableStardewBootstrapOwnerRecoveryBinding(opened),
    });
    try {
      await driveStardewOwnedPlayerHostRecovery(containedRuntimeTeardown, opened.owner, request);
    } catch (error) {
      // A held gate is the lease VERDICT, not a recovery result: the holder was
      // NOT proven gone, so this create refuses under its own bounded code and
      // leaves the leftover attempt exactly as it found it - no finalize, no
      // release, and no durable change to that attempt's slot. The create's own
      // single failure closure still settles its own intent; the code it fails
      // under is what tells the two apart.
      if (error instanceof Error && error.message === STARDEW_OWNER_RECOVERY_GATE_HELD_REFUSAL)
        throw new Error(STARDEW_GAME_CREATE_SLOT_HOLDER_NOT_PROVEN_GONE, { cause: error });
      // Everything else keeps its own bounded identity and is not folded into
      // the code above; nothing here mints a verdict or releases anything.
      throw error;
    }
    // Reachable only after the drive reported `recovered` AND finalized the
    // attempt: the recovery's own gate proved the holder's lease gone, so the
    // verdict for THIS drive result is `holderGone` - minted from that result,
    // not from an independent probe - and the handle released is the one read
    // from the slot.
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
    await authority.releaseGameSessionWorldBindingSlot({
      integrationId,
      bindingRef,
      holderHandle: holder.holderHandle,
      proof: Object.freeze({
        verdict: mintGameSessionWorldBindingSlotLeaseVerdict(
          productionGameSessionWorldBindingSlotLeaseVerdict.holderGone,
        ),
        holderHandle: holder.holderHandle,
      }),
    });
    if (isClosing()) throw new Error("stardew_lifecycle_closing");
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
        aiClientProfileMaterialized = true;
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
   * Rolls a fresh AI-client activation this lifecycle started back to the
   * composition's fully consumed base, the shape in which the core admits the
   * next activation.
   *
   * The composition consumes the owner's one-shot AI-client launch and bridge
   * connection reservations unconditionally here -- including when the FIRST
   * launch of this owner failed, and including a launch that was claimed while
   * its bridge connection had not been consumed yet -- so both states are
   * `consumed` afterwards no matter how far the attempt got. Every failure exit
   * of a started activation therefore runs through this rollback rather than
   * leaving the core partially consumed.
   */
  const abandonAiClientActivation = async (owner: StardewOwnedPlayerHostBootstrap): Promise<void> => {
    try {
      await internal.abandonFarmhandAiClientActivation(owner);
    } catch {
      // The composition rejects a forged, unknown or cross-composition owner
      // before the consumed transition. The rollback is best effort and the
      // failure that caused it stays primary.
      return;
    }
  };

  /**
   * Leaves the owner's AI-client activation in the one shape the core admits for
   * a fresh attach: a genuinely new generation when the previous activation
   * already ran to its end, or the still intact first activation when it never
   * did. Both shapes then run the same launch below.
   *
   * The core is the only authority for that fact -- `launchStates.aiClient` and
   * `bridgeConnectionState` are its own fields -- and
   * `prepareFreshFarmhandAiClientActivation` asserts exactly that pair before it
   * reserves, rotates or stops anything, failing closed with the platform
   * contract's `FarmhandBridgeConnectionNotAvailableError` while the previous
   * activation was not fully consumed. Asking it here, with no side effect
   * before its own assertion, is what makes the two impossible to disagree: a
   * mirrored coordinator latch could not see the composition's partial
   * transition (a launch that was claimed while its bridge connection was still
   * armed), and a latch that disagreed made the next create report a permanent
   * `accepted` that never progresses. Every other failure is a real one and is
   * never reclassified.
   */
  const beginFarmhandAiClientActivation = async (owner: StardewOwnedPlayerHostBootstrap): Promise<void> => {
    try {
      await internal.prepareFreshFarmhandAiClientActivation(owner);
    } catch (error) {
      if (!isFirstFarmhandAiClientActivationIntact(error)) throw error;
    }
  };

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
   * `aiClientActivation` selects which of the two legal activation shapes runs:
   * a resume (`re_arm`) arms a fresh one-shot launch/connection generation first
   * because a resume is only admitted over an activation that already ended,
   * while a create (`core_admitted`) lets the core admit either that fresh
   * generation or the owner's still intact first activation, so a create that
   * owns the very first activation of its Player Host launches through the
   * still-untouched reservations without the coordinator having to guess.
   * Returns true when the attach completed, false when the attempt stays
   * accepted because the attach cannot be built inside this instance (the
   * profile was never materialized or no prior activation exists to supersede).
   */
  const attachResumedWorld = async (
    deadlineMs: number,
    isCancelRequested: () => boolean,
    aiClientActivation: FreshAiClientActivation,
  ): Promise<boolean> => {
    const owner = exactOwner;
    if (owner === undefined) return false;
    attachmentConnectionStatus = "syncing";
    try {
      if (farmhandGameRuntimeFacade === undefined) {
        // Fresh activation: leave the owner's one-shot activation in the shape
        // the core admits, then relaunch the AI client through the existing
        // Stage D seam (fresh installation reread before the exact claim at the
        // launch decision). Only the arm above can fail without having touched
        // the activation; from the launch on, every exit is rolled back by the
        // single catch below.
        if (aiClientActivation === "re_arm") {
          await internal.prepareFreshFarmhandAiClientActivation(owner);
          if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
        } else {
          await beginFarmhandAiClientActivation(owner);
        }
        try {
          await withFreshRegisteredInstallation((installation) => aiClientLaunch(owner, installation));
          if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
          while (farmhandGameRuntimeFacade === undefined) {
            if (isClosing()) throw new Error("stardew_lifecycle_closing");
            if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
            try {
              farmhandGameRuntimeFacade = await internal.consumeOwnedFarmhandBridgeConnection(
                owner,
                (connection) => materializeFarmhandGameSession(connection, deadlineMs),
              );
            } catch (error) {
              if (!isTransientFarmhandBridgeConnectError(error)) throw error;
              // Cancel epoch check before every retry wait (card D3.3): a cancel
              // terminates the retry loop instead of letting it continue.
              if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
              await waitForFarmhandBridgeRetry(deadlineMs);
            }
          }
        } catch (error) {
          if (isCancelRequested()) throw new Error("stardew_game_resume_cancelled");
          // ONE rollback for the whole started activation, so no exit can leave
          // the core partially consumed: a failed launch, a refused or failed
          // bridge connection, a deferred error and an expired retry wait alike.
          // The retry wait used to escape without it -- leaving the AI launch
          // claimed while its bridge connection stayed armed -- and the next
          // activation then asked the core for a fresh generation, was refused
          // as not available, and was reported as a permanent `accepted` that
          // never progresses.
          await abandonAiClientActivation(owner);
          if (isResumeAttachDeferredError(error)) {
            // The attempt stays accepted: the fresh attach is pending on the next
            // layer's fresh connection/launch authority for this owner.
            attachmentConnectionStatus = "reconnecting";
            return false;
          }
          throw error;
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
        const attached = await attachResumedWorld(resumeDeadlineMs, () => resumeCancelRequested, "re_arm");
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
   * creates persist the binding intent (pending rev1), re-admit their own
   * manifest handoff, invoke the selected integration's private
   * createWorldBinding seam, register the world binding (registered rev1),
   * complete the session (resumable rev2), ensure the AI client profile is
   * materialized and then run the first activation (generation 1) with actions
   * paused (ready-actions-paused; only game.reopen reopens). The two failure
   * paths are mutually exclusive and store-enforced, and both are driven by the
   * ONE closure `settleFailedCreateAttempt`: before registration the pending
   * intent fails closed to failed rev2 with no binding row; after registration
   * the binding goes terminal (rev2) with the metadata failed (rev3) in one
   * transaction. The result is never `attached` unless the first activation
   * completed; a closed/unmounted createWorldBinding seam or any phase failure
   * yields `unavailable` with a null gameSessionId. Create is a post-launch
   * operation (path B'): it is admitted only over the exact Player Host this
   * lifecycle already launched and attested, and the opaque bindingRef it
   * persists is the one the private seam derived from the slot that launched
   * Player Host observed - the slot published in the signed join manifest this
   * create's own handoff admission issued, never a caller-supplied, derived or
   * reassembled world identity.
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
    // Owner ruling (a)/(b): path B' creates the world through the Player Host
    // that is already running (the Mod drives the game's own native new-game
    // entry), so create is a post-launch operation: launch-before-create. The
    // exact owner this lifecycle launched must exist and must already have
    // passed its host attestation; a create that arrives before that launch is
    // a stale command and fails closed here, instead of silently persisting a
    // binding intent and sitting at `accepted` forever. Create never launches:
    // the single launch authority stays `launchPlayerHost`.
    if (
      exactOwner === undefined ||
      activationState !== "awaiting_player_host_attestation" ||
      !playerHostAttestationCorrelated
    ) throw new Error("stardew_game_create_player_host_unavailable");
    // The store-level creation request and world binding operation identities
    // are minted inside the coordinator's idempotency slot and retained in it
    // for the terminal failure path (card D1 decision 3 / D2).
    const creationRequestId = randomBytes(32).toString("base64url");
    const operationId = randomBytes(32).toString("base64url");
    const createDeadlineMs = Math.min(sessionExpiryMs, Date.now() + 60_000);
    // Resolved once per admitted command so the failure closure below always
    // reaches the same durable surface and the same seam builder the attempt
    // started with, after the attempt's own block scope has unwound.
    const creationAuthority = gameSessionCreationAuthority;
    const createWorldBindingSeamFactory = createWorldBindingSeam;
    let attempt!: Promise<GameCreateResultV1>;
    attempt = (async (): Promise<GameCreateResultV1> => {
      let metadata: ProductionGameSessionMetadata | null = null;
      let bindingRegistered = false;
      try {
        // A closed/unmounted integration seam fails the create before any
        // durable write: never a fabricated attached result, never a resumable
        // half-record (the fake second integration implements the same seam).
        if (creationAuthority === undefined || createWorldBindingSeamFactory === undefined)
          throw new Error("stardew_game_world_creation_unavailable");
        // Owner ruling (d): re-attest the same exact owner's Player Host
        // session before consuming it. The world this create now binds must be
        // the one the launched Player Host observed, so the durable create is
        // never based on a stale, pre-launch attestation; a correlation
        // failure is terminal for the exact owner (quarantine + failed launch)
        // and no binding intent is written.
        await correlatePlayerHostAttestation();
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 1: persist the binding intent (pending rev1 + store-minted
        // gameSessionId). The id is opaque; every later durable step re-verifies
        // it through the store's own CAS checks. It is written first, before the
        // game is asked for a world, so a create that has already reached the
        // native handoff always has a durable row the failure closure can settle.
        metadata = await creationAuthority.createGameSessionMetadata({
          creationRequestId,
          integrationId: command.integrationId,
          continuityIdentityId: command.continuityIdentityId,
        });
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2a: admit THIS create's own manifest handoff before the
        // integration-private world-binding seam. The seam's only authority for
        // the observed slot is the signed join manifest the exact launched
        // Player Host issued for this create's own attachment request, and that
        // manifest exists only once this admission has confirmed the cabin and
        // waited for it to be issued; running the seam first would make it read
        // a manifest that belongs to another request (or to no request at all)
        // and it would fail closed on every create. This mirrors the proven
        // cabin-handoff order - `confirmAndAdmit` first, then the owner-scoped
        // work that depends on the admitted manifest (the headless topology's
        // list/confirmAndAdmit/materialize sequence). The exact owner is
        // re-checked here because the activation guard above ran synchronously.
        const handoffOwner = exactOwner;
        if (handoffOwner === undefined) throw new Error("stardew_game_create_player_host_unavailable");
        const choices = await handoffCoordinator.list(handoffOwner);
        const choice = choices[0];
        if (choice === undefined) throw new Error("stardew_game_create_cabin_unavailable");
        const manifestAdmission = await handoffCoordinator.confirmAndAdmit(choice.selection, { confirmed: true });
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2b: the selected integration creates the actual world and only
        // then returns an opaque bindingRef. The seam is built per create from
        // the same production composition, closed over the exact owner and the
        // join request identity this create's admission minted; the builder
        // never receives a caller-supplied world identity and the seam never
        // names, derives or reassembles a slot.
        const worldCreationSeam = createWorldBindingSeamFactory({
          owner: handoffOwner,
          joinRequestId: handoffCoordinator.readAdmittedJoinRequestId(handoffOwner, manifestAdmission),
          deadlineMs: createDeadlineMs,
        });
        const world = await worldCreationSeam.createWorldBinding({
          gameSessionId: metadata.gameSessionId,
          integrationId: command.integrationId,
          // No integration-private world request exists on this wire; the
          // generic seam consumes it as an opaque payload for later tasks.
          worldRequest: Object.freeze({}),
        });
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2c-pre (world-slot crash-recovery trigger): the slot this create
        // is about to register on may still be held by an attempt that never
        // closed out. No holder changes nothing - this create then behaves
        // exactly as it did before this seam existed - while a holder is driven
        // through the existing recovery seam and released only if that recovery
        // proved it gone. See `recoverLeftoverWorldBindingSlotHolder`.
        await recoverLeftoverWorldBindingSlotHolder(creationAuthority, command.integrationId, world.bindingRef);
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2c: register the world binding under the coordinator-minted
        // operation identity (registered rev1), carrying the attempt's own
        // opaque correlation as the holder handle. A read that cannot produce a
        // trustworthy correlation fails this create closed (bounded
        // `stardew_game_create_holder_unavailable`, settled by the same failure
        // closure below) instead of registering a guessed or empty handle.
        const holderHandle = await readWorldBindingHolderHandle();
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        await creationAuthority.registerGameSessionWorldBinding({
          gameSessionId: metadata.gameSessionId,
          integrationId: command.integrationId,
          bindingRef: world.bindingRef,
          operationId,
          holderHandle,
        });
        bindingRegistered = true;
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2d: complete the session (resumable rev2).
        await creationAuthority.completeGameSessionBinding({
          creationRequestId,
          gameSessionId: metadata.gameSessionId,
          expectedRevision: 1,
        });
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        // Phase 2e (owner ruling (c)): the first activation builds a fresh
        // authenticated AI-client connection, which requires the owner's
        // AI-client bridge profile to be materialized first. A Player Host that
        // never admitted a cabin has no materialized profile, so materialize it
        // from the manifest admission this create already holds, exactly like the
        // handoff paths do (the create command carries no cabin choice, and this
        // surface owns one AI Farmhand attachment, so the first available cabin
        // is selected the same way the headless operational topology selects it). The
        // composition materializes a profile at most once per owner, so an owner
        // whose profile already exists (create after a disconnected activation)
        // keeps it and only this create's fresh admission was used for the new
        // world binding. Without this step the first activation would fail
        // deferred with `stardew_farmhand_bridge_profile_not_materialized` and
        // the create would only ever report `accepted`.
        if (!aiClientProfileMaterialized) {
          await internal.materializeAiClientProfileAfterManifestAdmission(handoffOwner, manifestAdmission);
          aiClientProfileMaterialized = true;
          if (isClosing()) throw new Error("stardew_lifecycle_closing");
        }
        // Phase 2f: first activation (generation 1 from a clean surface, else
        // strictly incrementing). This is a new world session, not a resume:
        // the previous resume lineage's in-memory guard is cleared so it can
        // never shadow the new session, and actions stay paused until a fresh
        // explicit Game instruction reopens them. Whether this owner still holds
        // its intact first activation or must be re-armed onto a fresh one is
        // not the coordinator's to decide: the attach asks the core, which is
        // the only owner of that fact (see `beginFarmhandAiClientActivation`).
        resumedGameSessionId = undefined;
        await closeStaleAttachment();
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        attachmentGeneration = Math.max(attachmentGeneration + 1, 1);
        attachmentConnectionStatus = "reconnecting";
        actionAuthorityStatus = "paused";
        const attached = await attachResumedWorld(createDeadlineMs, () => false, "core_admitted");
        if (isClosing()) throw new Error("stardew_lifecycle_closing");
        return Object.freeze({
          apiVersion: 1,
          status: attached ? "attached" : "accepted",
          gameSessionId: metadata.gameSessionId,
        });
      } catch (error) {
        // The ONE durable failure closure of an admitted create, driven by every
        // failure exit above - including a create that close interrupted, since
        // close joins this attempt before it tears anything down. An unfinished
        // create is therefore settled by the durable failure rules instead of
        // leaving a registered binding with resumable metadata behind.
        try {
          await settleFailedCreateAttempt({
            authority: creationAuthority,
            creationRequestId,
            integrationId: command.integrationId,
            operationId,
            metadata,
            bindingRegistered,
          });
        } catch (failureError) {
          // A failure path that cannot be durably applied must never be
          // reported as a clean unavailable outcome.
          throw new Error("stardew_game_create_failed", { cause: failureError });
        }
        // The close that interrupted this create still reaches its caller; the
        // durable state above is already settled.
        if (isClosing()) throw new Error("stardew_lifecycle_closing", { cause: error });
        // The trigger's own bounded refusal is the one create failure that is
        // reported as itself rather than as the generic unavailable outcome: a
        // live holder occupying the slot is a known, expected product state
        // (someone else's attempt still owns that world), and folding it into
        // the same shape as an arbitrary internal failure would hide which one
        // happened. The durable rows above are already settled by the closure,
        // so this cannot leave an inconsistent row behind.
        if (error instanceof Error && error.message === STARDEW_GAME_CREATE_SLOT_HOLDER_NOT_PROVEN_GONE)
          throw error;
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
        await abandonAiClientActivation(owner);
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
        aiClientProfileMaterialized = true;
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
    // Join the in-flight create before ANY return below can skip it, including
    // the terminal endgame branch. Joining it is what makes close drive the
    // create path's own durable failure closure: an interrupted create settles
    // its rows (no registered binding with resumable metadata may survive a
    // close) before this close starts tearing anything down -- and before this
    // close can RESOLVE. An endgame does not end the admissibility of a create:
    // its body changes neither `activationState` nor `exactOwner`, so the
    // admission guards still pass afterwards and a create really can be
    // outstanding on the endgame path.
    const create = createPromise;
    if (create !== undefined) await create.catch(() => undefined);
    // An explicit endgame is terminal: it already drained both role Jobs,
    // released the platform session and drove the durable owner record to
    // `contained`. The ordinary close that follows is pure bookkeeping and must
    // not re-drive the runtime, re-quarantine the terminal owner, or re-stop an
    // owner the endgame already stopped.
    if (endgameSettled) {
      // This branch deliberately skips the teardown below, but it still owns
      // whatever a create built AFTER the endgame tore the attachment down
      // (:1320) -- for example a fresh facade/lease minted at :1449/:1485.
      // Disposing of it here is safe precisely because of the create join
      // above: the attempt has fully settled, so nothing can still be attaching
      // or re-assigning `farmhandGameRuntimeFacade`, and the shared teardown
      // reads the coordinator's own facade/lease/generation (:1179-1183) and
      // closes exactly the leftover. Without both halves, close could resolve
      // while that facade stayed open forever.
      try {
        if (
          farmhandGameRuntimeFacade !== undefined &&
          farmhandGameRuntimeLease !== undefined &&
          attachmentGeneration !== 0
        ) await teardownAttachment();
        else await closePartialAttachment();
      } catch {
        throw new StardewProductionLifecycleCloseError();
      }
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
    // Endgame results are cleared here too: a rejected endgame promise would
    // otherwise be retained for the coordinator's lifetime and a later same-key
    // retry would replay that stale rejection. The endgame already ended the
    // attempt, so nothing here can still need the idempotency record.
    gameEndgames.clear();
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
  createWorldBindingSeam?: StardewWorldCreationSeamFactory,
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
  /**
   * Loop 4 path B' world-creation seam, built per create from the one
   * production authority (owner ruling 2026-10-04):
   *
   * - the owner-bound attachment flow carries the staged private session
   *   directory and session token, so the joint manifest is read (and its
   *   signature verified) against the exact owner this lifecycle launched;
   * - the join request identity comes from the admission the coordinator just
   *   minted, so only the manifest issued for THIS create's own request can
   *   become its bindingRef;
   * - the seam itself returns only the observed physical save-slot basename
   *   from that manifest and fails closed with bounded codes otherwise. It
   *   never reads worldRequest, never names a slot, and never writes a save.
   */
  const createWorldBindingSeam: StardewWorldCreationSeamFactory = ({ owner, joinRequestId, deadlineMs }) =>
    createStardewWorldCreationBindingSeam({
      manifestSource: createStardewIssuedJoinManifestSource({
        attachmentFlow: internal.createOwnedPlayerHostAttachmentFlow(owner),
        requestId: joinRequestId,
      }),
      deadlineMs,
    });
  return createCoordinator(
    manifest,
    internal,
    () => createPublishedWindowsReparseInspector(hostArtifactRoot),
    materializer.materialize,
    folderPicker,
    createStardewWorldBindingResolverFromGameAuthority(game),
    playerHostLaunch,
    aiClientLaunch,
    // Create consumes the injected Slice-0 store facade slice, and the
    // owner-bound seam below is the only world-creation authority: no caller,
    // provider, mock or second integration can inject one.
    game,
    createWorldBindingSeam,
    containedRuntimeTeardown,
    createStardewInstallationDiscoveryProvider({ source: createWindowsSteamInstallationSource() }),
  );
}
