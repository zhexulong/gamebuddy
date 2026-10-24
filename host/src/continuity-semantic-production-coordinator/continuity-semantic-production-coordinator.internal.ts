import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { type CompanionInterruption, createCompanionInterruption } from "../companion-interruption.js";
import {
  type OpaqueChatRuntimeBindingToken,
  readReservedChatRuntimeMaterializationFacts,
  releaseReservedChatRuntimeMaterialization,
  reserveChatRuntimeMaterialization,
  withConsumedChatRuntimeBinding,
} from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { createChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.js";
import type { MaterializedChatRuntime } from "../continuity-semantic-chat-runtime-materializer/continuity-semantic-chat-runtime-materializer.internal.js";
import { createHostChatRuntimeMaterializer } from "../continuity-semantic-chat-runtime-materializer/continuity-semantic-chat-runtime-materializer.js";
import {
  createWindowsOwnerDeathVerifier,
  type WindowsOwnerDeathVerifier,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.js";
import {
  createCanonicalProductionAuthorityAdmission,
  type FreshContinuityProvision,
  type FreshContinuityProvisionOptions,
  openKnownProductionContinuityFromCanonicalAdmission,
  provisionFreshProductionContinuityFromCanonicalAdmission,
} from "../continuity-semantic-provisioning/continuity-semantic-provisioning.internal.js";
import type {
  ProductionChatCatalog,
  ProductionChatCommandReadback,
  ProductionChatLifecycleInput,
  ProductionChatRuntimeOwner,
  ProductionChatRuntimeReadback,
  ProductionChatRuntimeReceipt,
  ProductionChatRuntimeRequest,
  ProductionChatRuntimeTeardownPermit,
  ProductionChatRuntimeTeardownReceipt,
  ProductionChatRuntimeTeardownRequest,
  ProductionGameOwner,
  ProductionGamePermit,
  ProductionGameReadback,
  ProductionGameRecoveryTarget,
  ProductionGameSessionBindingInput,
  ProductionGameSessionCreateInput,
  ProductionGameSessionMetadata,
  ProductionGameSessionWorldBinding,
  ProductionGameSessionWorldBindingInput,
  ProductionGameSessionWorldBindingSlotHolder,
  ProductionGameSessionWorldBindingSlotReleaseInput,
  ProductionGameSessionWorldBindingTerminalInput,
  ProductionGameTerminalReceipt,
  ProductionGameWorld,
  ProductionSagaReadback,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import {
  boundEntryOnActivePath,
  branchPiVariantAnchor,
  deletePiTranscriptEntry,
  editPiTranscriptEntry,
  rewindPiTranscriptTail,
  type PiTranscriptMessage,
} from "../pi-session-variant-branch.internal.js";
import { identityKey, type CompanionModelConfig, type RuntimeSession } from "../runtime.js";
import {
  acknowledgeMountedWorldInfoBinding,
  claimMountedAttempt as claimStoreMountedAttempt,
  createChatThreadStore,
  ExactThreadNotFoundError,
  ExactThreadSurfaceMismatchError,
  transitionMountedProviderStart,
  transitionMountedPresentation,
} from "../tavern/chat-thread-store.js";
import {
  createMountedTurnTransitionAuthority,
  type MountedTurnTransitionAuthorityLease,
  type MountedTurnTransitionOperationAuthorityLease,
} from "../tavern/chat-thread-store.mounted-turn-transition.internal.js";
import { seedDefaultCompanionIntoFreshRuntimeRoot } from "../tavern/default-companion-seed.js";
import {
  createManifestDerivedInitialChatExactContentPort,
  type InitialChatExactContentPort,
  isTrustedTavernExactContentReceipt,
  TavernInitialChatExactContentPortError,
  type TavernExactContentReceipt,
} from "../tavern/initial-chat-exact-content-port.js";
import { WindowsNamedMutexBroker, WindowsNamedMutexBrokerError } from "../windows-named-mutex-broker.js";
import type { WindowsAuthorityRootMutex, WindowsPartitionMutexLease } from "../windows-partition-mutex.js";
import { createWindowsAuthorityRootMutex } from "../windows-partition-mutex.js";
export class SemanticProductionCoordinatorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SemanticProductionCoordinatorError";
  }
}

/**
 * One fixed internal start-admission deadline. It is minted exactly once
 * while consuming the one-shot invocation admission and creating the private
 * execution scope; it is never caller-supplied, durable, projected, or a
 * provider/cancellation timeout.
 */
export const PROVIDER_INVOCATION_ADMISSION_DEADLINE_MS = 120_000;
/** Fixed, bounded cold-start budget for one Host-owned Chat runtime materialization. */
const CHAT_RUNTIME_BOOTSTRAP_MATERIALIZATION_DEADLINE_MS = 120_000;
/** This is deliberately opaque outside this module.  Its identity, not its shape, is the capability. */
type DialogueSagaHolder = object;
type SagaFacts = Readonly<{
  principal: FreshContinuityProvision["principal"];
  bootstrapOperationId: string;
  authorityGeneration: number;
  storeId: string;
  schemaVersion: number;
  authorityRootIdentity: string;
}>;
type Brand = Readonly<{
  digest: string;
  operations: readonly string[];
  facts: SagaFacts;
}>;
const brands = new WeakMap<object, Brand>();

/**
 * Host-minted mounted Chat capability. Its non-forgeable close authority stays
 * in the coordinator; consumers receive neither binding, store nor permit.
 */
export type MountedChatBrowserProjection = Readonly<{
  /** Browser-safe, per-mounted-lease reference; never a durable Chat identifier. */
  chatHandle: string;
  /** Exact verified mounted record vector.selectionRevision. */
  selectionGeneration: number;
  /** Browser-safe revision reference; never a durable selection/storage revision. */
  selectionStateRevision: string;
  /** Projects an already-validated durable message identifier into a display-only reference. */
  projectMessageHandle(messageId: string): string;
  /** Projects an already-validated durable turn identifier into a display-only reference. */
  projectTurnHandle(turnId: string): string;
  /**
   * Projects any already-validated durable thread/surface pair into a
   * display-only reference; the mounted pair projects to the mounted
   * `chatHandle` so list entries and the selection always agree.
   */
  projectChatHandle(chatThreadId: string, chatSurfaceSessionId: string): string;
  /**
   * Projects an already-validated durable companion identifier into a
   * display-only reference. The mounted companion projects to a stable
   * handle so the library list and the detail route always agree.
   */
  projectCompanionHandle(companionId: string): string;
}>;
/** What the mounted runtime's live session runs with, as the session itself reports it. */
export type MountedModelSelection = Readonly<{
  provider: string;
  modelId: string;
  thinkingLevel: string;
}>;
export type MountedModelSelectionReload = Readonly<{
  status: "applied" | "turn_in_flight";
  /**
   * Read back from the live Pi session, never from the selection that was asked for, and `null`
   * when the player has no selection at all: a mount that opened before any connection was
   * activated holds no model, and saying so is the answer rather than naming Pi's own `unknown`
   * placeholder as if it were one.
   */
  modelSelection: MountedModelSelection | null;
}>;
export type MountedChatRuntimeLease = Readonly<{
  /**
   * Browser/Host-consumer-safe runtime projection. The actual Pi session ID is
   * an evidence-binding fact and remains in the coordinator-private record.
   */
  runtimeSession: Pick<RuntimeSession, "profile">;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  browserProjection: MountedChatBrowserProjection;
  /**
   * Cancels only the current exact in-flight Pi prompt without exposing the Pi
   * session. A stale turn/attempt pair cannot abort a later prompt.
   */
  abortActivePrompt(
    expected: Readonly<{ turnId: string; attemptId: string }>,
  ): Promise<"aborted" | "not_active" | "mismatch">;
  /**
   * Applies the player's current connection selection to this mounted runtime
   * (design/28 §5.3): the provider/model the next prompt runs with, without
   * touching the conversation. An idle mount takes it immediately; a mount whose
   * turn has not reached a terminal ledger state keeps that turn and answers
   * `turn_in_flight`, and the selection lands at the next prompt instead. Either
   * answer reports the selection the live session actually holds.
   */
  reloadModelSelection(): Promise<MountedModelSelectionReload>;
  close(): Promise<void>;
}>;
export type SemanticChatRuntimeMountOptions = Readonly<{
  tavernNarrativeGateNonceSha256?: string;
}>;
/**
 * ADR 0009: the narrow production capability a player action uses to say which
 * Chat the runtime shows. `create` mints the new Chat's identity inside the
 * authority; `select` names an existing verified Chat the caller resolved from
 * its own safe projection. Neither form can name a durable vector or command.
 */
export type SemanticChatSelectionRequest =
  | Readonly<{ kind: "create"; selectionGeneration: number }>
  | Readonly<{
      kind: "select";
      selectionGeneration: number;
      chatThreadId: string;
      chatSurfaceSessionId: string;
    }>;
/**
 * The honest product answer to a selection request. Switching is turn-level,
 * not process-level: the mounted runtime hot-swaps the Chat it serves inside
 * this process and answers `switched`. Selecting another Chat is a focus
 * transfer, so a turn that is still generating is aborted first through the
 * same cancel path an explicit browser Stop uses - it is never refused and the
 * player never has to wait for generation to finish (ADR-0010).
 *
 * A mounted turn with nothing running is aborted through that same path: a turn
 * whose attempt had not started yet is prepared to the armed state the cancel
 * seam terminalizes, and one that recorded a pre-invocation `not_started` proof
 * is terminalized directly, so each becomes the ordinary interrupted turn instead
 * of holding the mount (see `prepareMountedTurnForChatSelection`). `turn_in_flight`
 * survives only as the fail-closed answer for the mounted turn this authority
 * cannot reach with that path - a turn already past the cancel seam into
 * `cancel_claimed`/`completion_claimed` whose runner cannot settle (a crashed or
 * stranded prompt) - and the runtime then stays where it is rather than being torn
 * down under the turn. The recorded expectation is durable in both cases, so a
 * later start still lands on the Chat the player chose.
 */
export type SemanticChatSelectionOutcome =
  | Readonly<{ status: "switched"; chatThreadId: string; chatSurfaceSessionId: string }>
  | Readonly<{ status: "turn_in_flight"; chatThreadId: string; chatSurfaceSessionId: string }>;
/** The slice of the Chat runtime authority a management surface may hold. */
export type SemanticChatSelectionCapability = Readonly<{
  requestChatSelection(input: SemanticChatSelectionRequest): Promise<SemanticChatSelectionOutcome>;
}>;
type MountedChatRuntimeLeaseRecord = {
  active: boolean;
  readonly runtimeRoot: string;
  readonly principal: Readonly<{ playerId: string; companionId: string; continuityId: string }>;
  readonly chatThreadId: string;
  readonly chatSurfaceSessionId: string;
  readonly selectionGeneration: number;
  readonly attemptBinding?: MountedAttemptBinding;
  /** Live materialized runtime session for the start scope; never public. */
  readonly providerRuntimeSession?: RuntimeSession;
  /** Construction-private model reload for this exact mount; never public. */
  readonly reloadModelSelection?: NonNullable<MaterializedChatRuntime["reloadModelSelection"]>;
  /** The selection this mount configured Pi with; never public. */
  readonly appliedModelConfig?: NonNullable<MaterializedChatRuntime["appliedModelConfig"]>;
  /** Exact mounted authored catalog capability; never public or retained by callers. */
  authoredContextCapability?: import("@cortexkit/pi-magic-context/tavern").TavernAuthoredContextRuntimeCapability;
  refreshAuthoredContext?: (
    currentCapability: import("@cortexkit/pi-magic-context/tavern").TavernAuthoredContextRuntimeCapability,
  ) => Promise<import("@cortexkit/pi-magic-context/tavern").TavernAuthoredContextRuntimeCapability>;
  authoredContextRefreshPromise?: Promise<void> | undefined;

  /**
   * Process-local one-shot reservation for a durable generation-one attempt.
   * It closes concurrent/reentrant start calls before the durable `armed` write;
   * after that write, the ledger observation is the crash-safe no-reprompt proof.
   */
  readonly startedAttemptIds: Set<string>;
  /** Revoked synchronously when this mounted lease begins closing. */
  readonly transitionAuthority: MountedTurnTransitionAuthorityLease;
  /**
   * Chat-owned in-process presentation epoch (design/71 §3.4). It is created
   * once at mount, stored privately, and never durable; the ledger CAS is the
   * durable cancel authority. A stop via the coordinator's private cancel seam
   * invalidates every minted presentation admission for this lease.
   */
  readonly presentationEpoch: CompanionInterruption;

  /** The sole Pi prompt currently executing under this mounted lease. */
  activePrompt?: Readonly<{ turnId: string; attemptId: string; aborting: boolean }> | undefined;
  /**
   * Process-local waiters resolved by the prompt runner once that prompt has
   * stopped executing, which is after its durable terminal transition. They are
   * never durable and never cross a mount: a focus transfer waits on them so no
   * transition authority is revoked while an aborted turn is still settling.
   */
  readonly promptSettlementWaiters: Set<() => void>;
  /** Retained cancellation state; new browser Stop bypasses it. */
  cancellation?: Promise<CancelResult>;
  readonly begin: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * This lease's own store, opened lazily by the first read that needs it and
   * closed by `close()`. Every coordinator read under this mounted lease shares
   * it, so a long-lived mount holds exactly one SQLite connection instead of one
   * per read. `store()` refuses once the lease has begun closing.
   */
  readonly store: () => import("../tavern/chat-thread-store.js").ChatThreadStore;
  close(): Promise<void>;
};
const mountedChatRuntimeLeases = new WeakMap<object, MountedChatRuntimeLeaseRecord>();

/**
 * The one way a mounted runtime adopts the player's current connection
 * selection: the materialized runtime re-reads it through the construction
 * function a mount uses and applies it to the live Pi session. Nothing about the
 * conversation moves - the transcript, the ledger and the session's own entries
 * stay exactly as they are; only the provider/model the next prompt runs with
 * changes.
 *
 * `null` means the player has activated nothing, so there is nothing to adopt.
 * That is not a refusal: a Chat that opened before any connection existed is
 * the ordinary first-run state, and the prompt it then attempts is what fails
 * by name, at the point of use, with Settings named where the model is brought.
 */
async function applyMountedModelSelection(record: MountedChatRuntimeLeaseRecord): Promise<CompanionModelConfig | null> {
  const reload = record.reloadModelSelection;
  if (reload === undefined)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_model_selection_unavailable");
  return await reload();
}

/**
 * The selection the live Pi session holds, read from the session rather than remembered.
 *
 * `null` is the mounted runtime's own answer while the player has activated no connection. That is
 * a state, not a failure: the session is running on Pi's `unknown` placeholder, and reporting the
 * placeholder as the player's model would name a model nobody selected. A mount that HAS a
 * selection but cannot read the session's thinking level back is the only refusal left here.
 */
function readMountedModelSelection(record: MountedChatRuntimeLeaseRecord): MountedModelSelection | null {
  const applied = record.appliedModelConfig?.();
  if (applied === null) return null;
  const state = record.providerRuntimeSession?.session.agent.state;
  if (applied === undefined || state === undefined)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_model_selection_unavailable");
  return Object.freeze({ provider: applied.provider, modelId: applied.modelId, thinkingLevel: state.thinkingLevel });
}

/**
 * Private composition capability. It is intentionally unexported: only the
 * narrowly named Tavern internal seam can receive it through this callback.
 */
type MountedAdmission = Readonly<{ readonly __mountedAdmission: unique symbol }>;
type MountedAdmissionRecord = Readonly<{
  lease: MountedChatRuntimeLeaseRecord;
  active: { value: boolean };
  consuming: { value: boolean };
}>;
const mountedAdmissions = new WeakMap<object, MountedAdmissionRecord>();

type MountedAttemptAdmission = Readonly<{ readonly __mountedAttemptAdmission: unique symbol }>;
type MountedAttemptBinding = Readonly<{
  runtimeBindingDigest: string;
  runtimeOwner: Readonly<{
    ownerToken: string;
    runtimeInstanceId: string;
    ownerPid: number;
    ownerProcessStartIdentity: string;
  }>;
}>;
type MountedAttemptAdmissionRecord = Readonly<{
  lease: MountedChatRuntimeLeaseRecord;
  binding: MountedAttemptBinding;
  active: { value: boolean };
  consuming: { value: boolean };
}>;
const mountedAttemptAdmissions = new WeakMap<object, MountedAttemptAdmissionRecord>();

/**
 * Private execution scope. It is the only way a consumer can
 * reach the live runtime session, the sole store-writer port, the immutable
 * bound facts, and the coordinator-minted start-admission deadline. None of
 * them may be retained after the admission callback returns.
 */
export type ProviderInvocationScope = Readonly<{
  facts: Readonly<{
    turnId: string;
    messageId: string;
    attemptId: string;
    generation: 1;
    selectionGeneration: number;
    idempotencyKey: string;
    acceptedAtMs: number;
    runtimeRoot: string;
    playerId: string;
    companionId: string;
    continuityId: string;
    chatThreadId: string;
    chatSurfaceSessionId: string;
    runtimeBindingDigest: string;
    runtimeOwner: Readonly<{
      ownerToken: string;
      runtimeInstanceId: string;
      ownerPid: number;
      ownerProcessStartIdentity: string;
    }>;
    /**
     * Present only for a same-position variant turn: the existing companion
     * message this turn re-generates in place, with the anchor player message
     * its prompt came from. The P5 runner commits a `commit_variant` for it
     * instead of a `commit_presentation` insert.
     */
    variant: Readonly<{ targetMessageId: string; anchorMessageId: string }> | null;
  }>;
  /** Coordinator-minted fixed start-admission deadline, struck exactly once per execution scope. */
  deadlineAtMs: number;
  /** The live materialized runtime session; only for the single prompt call. */
  runtimeSession: RuntimeSession;
  /** Callback-scoped authored-context verifier for this exact mounted session. */
  authoredContextCapability: Readonly<{
    assertInstall(
      durableTurnId: string,
      refs: readonly Readonly<Record<string, string>>[],
      volatileRefs?: readonly Readonly<Record<string, string>>[],
    ): void;
    clearVolatileForTurn(durableTurnId: string): void;
  }>;
  /**
   * The Pi-side half of a same-position variant turn. It verifies the session
   * shape against the position's durable variant texts and moves the active leaf
   * to the entry before `anchorText`'s player line, so this turn's prompt appends
   * one player line and one reply there; a position whose session shape it cannot
   * prove refuses and the caller must leave the position unchanged. The durable
   * binding this stands in for is the prepared-response transaction of design 24:341.
   */
  branchVariantAnchor(
    anchorText: string,
  ): Promise<import("../pi-session-variant-branch.internal.js").PiVariantBranchResult>;
  /**
   * The sole store-writer port for this exact attempt's arm/not_started/running
   * transitions and provider-rejection failure. It is callback-scoped and
   * bound to the mounted runtime root and full origin tuple.
   */
  transitionStore(
    command: import("../tavern/chat-thread-store.js").ProviderStartTransition,
  ): Promise<
    | import("../tavern/chat-thread-store.js").AttemptStartingTurn
    | import("../tavern/chat-thread-store.js").RunningTurn
    | import("../tavern/chat-thread-store.js").FailedTurn
    | import("../tavern/chat-thread-store.js").CancelledTurn
  >;
  /**
   * The sole durable writer port for this exact running attempt. It remains
   * inside the already-exclusive prompt consumer; it cannot prompt Pi or
   * be retained outside this callback scope.
   */
  transitionPresentation(
    command: import("../tavern/chat-thread-store.js").PresentationTransition,
  ): Promise<import("../tavern/chat-thread-store.js").ChatTurnLedger>;
  /** Reads the exact durable accepted player message text for the canonical envelope. */
  readAcceptedMessageText(): Promise<string>;
  /** Reads the exact durable reference-only authored-context plan. */
  readAcceptedAuthoredContextPlan(): Promise<import("../tavern/chat-thread-store.js").AcceptedTurnAuthoredContextPlan>;
  /** Fresh exact durable ledger read for ordinary Stop/completion race recovery. */
  readCurrentTurnLedger(): Promise<import("../tavern/chat-thread-store.js").ChatTurnLedger>;
  /**
   * Fail-closed linearization point: exact active scope + lease + deadline.
   */
  assertAdmission(): void;
  /**
   * Marks the exact sole prompt as active until the returned release function
   * runs. This is ordinary lifecycle bookkeeping for Stop, not a provider or
   * presentation authority.
   */
  beginActivePrompt(): () => void;
  /**
   * Performs synchronous cancel/commit arbitration for this exact native
   * content finalization. The returned release function merely closes the
   * in-process reservation; the subsequent transition still owns durability.
   */
  reserveNativeContentCommit(): Readonly<{ cancelEpoch: number; release(): void }> | undefined;
  /**
   * Tests whether native content preview is still permitted for this exact
   * mounted prompt. It observes the same Host-owned interruption epoch as the
   * final commit reservation but never creates any presentation authority.
   */
  canPreviewNativeContent(): boolean;
  /**
   * Records the Pi session entries this exact turn's prompt appended for the durable rows the turn
   * wrote, as the durable `(thread_id, message_id, entry_id)` binding a single-row delete reads. It
   * is deliberately infallible towards the turn: the runner calls it after the prompt has settled,
   * and a binding it cannot write leaves a row a delete will honestly refuse on rather than
   * poisoning a reply that is already visible.
   */
  recordTranscriptEntryBinding(entries: readonly Readonly<{ messageId: string; entryId: string }>[]): Promise<void>;
  /**
   * Reads the durable winner for a STOP that raced this invocation. The runner
   * owns prompt/gate drain and therefore performs the final `cancel` or
   * `complete` transition after this read-back.
   */
  finalizeCancellation(): Promise<
    | import("../tavern/chat-thread-store.js").CompletionClaimedTurn
    | import("../tavern/chat-thread-store.js").CompletedTurn
    | import("../tavern/chat-thread-store.js").CancelClaimedTurn
    | import("../tavern/chat-thread-store.js").CancelledTurn
    | import("../tavern/chat-thread-store.js").FailedTurn
    | undefined
  >;
}>;

type PresentationLedger = Exclude<
  import("../tavern/chat-thread-store.js").ChatTurnLedger,
  import("../tavern/chat-thread-store.js").AcceptedQueuedTurn
>;
type CancelResult = Exclude<
  PresentationLedger,
  | import("../tavern/chat-thread-store.js").AttemptStartingTurn
  | import("../tavern/chat-thread-store.js").RunningTurn
  | import("../tavern/chat-thread-store.js").PresentationCommittedTurn
>;

function isTurnWithExactAttempt(
  ledger: import("../tavern/chat-thread-store.js").ChatTurnLedger,
  attemptId: string,
): ledger is Exclude<
  import("../tavern/chat-thread-store.js").ChatTurnLedger,
  import("../tavern/chat-thread-store.js").AcceptedQueuedTurn
> {
  return ledger.status !== "accepted_queued" && ledger.attempt.attemptId === attemptId;
}

async function readCurrentPresentationLedger(record: MountedChatRuntimeLeaseRecord): Promise<PresentationLedger> {
  const binding = record.attemptBinding;
  if (binding === undefined)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
  const store = record.store();
  const ledger = (await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId)).turnLedger;
  if (
    ledger === null ||
    ledger.status === "accepted_queued" ||
    ledger.status === "attempt_starting" ||
    ledger.attempt.generation !== 1 ||
    ledger.attempt.selectionGeneration !== record.selectionGeneration ||
    ledger.attempt.runtimeBindingDigest !== binding.runtimeBindingDigest ||
    ledger.attempt.runtimeOwner.ownerToken !== binding.runtimeOwner.ownerToken ||
    ledger.attempt.runtimeOwner.runtimeInstanceId !== binding.runtimeOwner.runtimeInstanceId ||
    ledger.attempt.runtimeOwner.ownerPid !== binding.runtimeOwner.ownerPid ||
    ledger.attempt.runtimeOwner.ownerProcessStartIdentity !== binding.runtimeOwner.ownerProcessStartIdentity
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
  return ledger;
}

async function readCancellationResult(record: MountedChatRuntimeLeaseRecord): Promise<CancelResult> {
  const current = await readCurrentPresentationLedger(record);
  if (
    current.status === "attempt_starting" ||
    current.status === "running" ||
    current.status === "presentation_committed"
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
  return current;
}

/**
 * Waits for the mounted lease's sole active prompt to stop executing. The runner
 * that owns the prompt resolves this in its terminal drain, after the durable
 * terminal transition and before it returns, so awaiting it fences the whole
 * settlement of an aborted turn.
 */
function waitForMountedPromptSettlement(record: MountedChatRuntimeLeaseRecord): Promise<void> {
  if (record.activePrompt === undefined) return Promise.resolve();
  return new Promise<void>((resolve) => record.promptSettlementWaiters.add(resolve));
}

type MountedAttemptInvocationAdmission = Readonly<{
  readonly __mountedAttemptInvocationAdmission: unique symbol;
}>;
type MountedAttemptInvocationRecord = Readonly<{
  lease: MountedChatRuntimeLeaseRecord;
  turn: import("../tavern/chat-thread-store.js").AttemptStartingTurn;
  active: { value: boolean };
  consuming: { value: boolean };
}>;
const mountedAttemptInvocationAdmissions = new WeakMap<object, MountedAttemptInvocationRecord>();

/**
 * The only coordinator-internal composition entry. It validates the exact
 * manifest/lease binding, begins close-drained work, and delegates the opaque
 * admission directly to Tavern's private internal seam.
 */
/**
 * Refreshes desired authored context without starting a turn. This is the
 * management-surface settle path: while a turn runs it must wait for exact
 * settlement (and therefore throws context_unavailable, matching
 * ensureCurrentAuthoredContext), but on an idle mounted runtime it applies a
 * pending World Info binding immediately instead of stranding it until the
 * next player turn. The applied state is still minted only through the
 * transition authority; this function merely asks for the same convergence the
 * turn path uses, without creating a turn or a durable admission.
 */
export async function settleMountedAuthoredContext(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
): Promise<void> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_admission_rejected");
  return record.begin(async () => {
    if (!record.active) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_admission_rejected");
    await ensureCurrentAuthoredContext(manifest, record);
  });
}

export async function acceptMountedDurableTurn(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  accept: (admission: MountedAdmission) => Promise<import("../tavern/chat-thread-store.js").AcceptedQueuedTurn>,
): Promise<import("../tavern/chat-thread-store.js").AcceptedQueuedTurn> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_admission_rejected");
  return record.begin(async () => {
    if (!record.active) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_admission_rejected");
    await ensureCurrentAuthoredContext(manifest, record);
    if (!record.active) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_admission_rejected");
    const active = { value: true };
    const consuming = { value: false };
    const admission = Object.freeze({}) as MountedAdmission;
    mountedAdmissions.set(admission, Object.freeze({ lease: record, active, consuming }));
    try {
      return await accept(admission);
    } finally {
      active.value = false;
    }
  });
}

/** Refreshes desired authored context only after exact terminal settlement. */
async function ensureCurrentAuthoredContext(
  manifest: HostDeploymentManifest,
  record: MountedChatRuntimeLeaseRecord,
): Promise<void> {
  const inFlight = record.authoredContextRefreshPromise;
  if (inFlight !== undefined) {
    await inFlight;
    if (!record.active) throw new SemanticProductionCoordinatorError("context_unavailable");
    return;
  }

  const store = record.store();
  let refreshPromise!: Promise<void>;
  refreshPromise = (async () => {
    const state = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
    if (!record.active) throw new SemanticProductionCoordinatorError("context_unavailable");
    if (sameBindingForCoordinator(state.thread.managedWorldInfoBinding, state.thread.appliedManagedWorldInfoBinding))
      return;
    if (
      (state.turnLedger !== null && !isTerminalTurnStatusForCoordinator(state.turnLedger.status)) ||
      record.activePrompt !== undefined
    )
      throw new SemanticProductionCoordinatorError("context_unavailable");

    const refresh = record.refreshAuthoredContext;
    const current = record.authoredContextCapability;
    if (refresh === undefined || current === undefined)
      throw new SemanticProductionCoordinatorError("context_unavailable");
    const next = await refresh(current);
    // The private bridge invalidates `current` as part of replacement. Retain
    // the replacement immediately so any failed post-replacement fence or
    // retry can never use the stale capability.
    record.authoredContextCapability = next;
    if (!record.active) throw new SemanticProductionCoordinatorError("context_unavailable");
    const after = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
    if (
      (after.turnLedger !== null && !isTerminalTurnStatusForCoordinator(after.turnLedger.status)) ||
      record.activePrompt !== undefined
    )
      throw new SemanticProductionCoordinatorError("context_unavailable");
    if (!record.active) throw new SemanticProductionCoordinatorError("context_unavailable");
    // The desired binding must remain unchanged across the replacement.
    if (!sameBindingForCoordinator(after.thread.managedWorldInfoBinding, state.thread.managedWorldInfoBinding))
      throw new SemanticProductionCoordinatorError("context_unavailable");
    const operationAuthority = record.transitionAuthority.mintOperation();
    try {
      await acknowledgeMountedWorldInfoBinding({
        authority: record.transitionAuthority.authority,
        operationAuthority: operationAuthority.authority,
        runtimeRoot: record.runtimeRoot,
        playerId: record.principal.playerId,
        companionId: manifest.principal.companionId,
        continuityId: manifest.principal.continuityId,
        chatThreadId: record.chatThreadId,
        chatSurfaceSessionId: record.chatSurfaceSessionId,
        ...(after.thread.managedWorldInfoBinding === undefined
          ? {}
          : { binding: after.thread.managedWorldInfoBinding }),
        ...(state.thread.appliedManagedWorldInfoBinding === undefined
          ? {}
          : { expectedOldAppliedBinding: state.thread.appliedManagedWorldInfoBinding }),
      });
    } finally {
      operationAuthority.revoke();
    }
    if (!record.active) throw new SemanticProductionCoordinatorError("context_unavailable");
  })();
  record.authoredContextRefreshPromise = refreshPromise;
  try {
    await refreshPromise;
  } finally {
    if (record.authoredContextRefreshPromise === refreshPromise) record.authoredContextRefreshPromise = undefined;
  }
}

function isTerminalTurnStatusForCoordinator(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function sameBindingForCoordinator(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null || b === undefined || b === null)
    return (a === undefined || a === null) && (b === undefined || b === null);
  if (typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  if (left.source === "managed_world_info" || right.source === "managed_world_info")
    return (
      left.source === "managed_world_info" &&
      right.source === "managed_world_info" &&
      left.publicTitle === right.publicTitle &&
      left.revision === right.revision &&
      left.canonicalHash === right.canonicalHash
    );
  return (
    left.worldBookId === right.worldBookId &&
    left.revision === right.revision &&
    left.canonicalHash === right.canonicalHash &&
    left.provenance === right.provenance
  );
}

/** Tavern-private consumption seam; callers cannot observe a lease record. */
/**
 * Claim admission. Runtime binding facts are read only from the mounted
 * coordinator record; no facade, lease field, or store caller can provide them.
 * This runner does not invoke Pi or make a provider call.
 */
export async function claimMountedAttempt(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  claim: (admission: MountedAttemptAdmission) => Promise<import("../tavern/chat-thread-store.js").AttemptStartingTurn>,
): Promise<import("../tavern/chat-thread-store.js").AttemptStartingTurn> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId ||
    record.attemptBinding === undefined
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
  return record.begin(async () => {
    if (!record.active)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
    const active = { value: true };
    const consuming = { value: false };
    const admission = Object.freeze({}) as MountedAttemptAdmission;
    mountedAttemptAdmissions.set(
      admission,
      Object.freeze({ lease: record, binding: record.attemptBinding!, active, consuming }),
    );
    try {
      return await claim(admission);
    } finally {
      active.value = false;
    }
  });
}

/** Tavern-private attempt claim consumption seam; it produces only durable claim facts. */
export async function consumeMountedAttemptAdmission<T>(
  admission: MountedAttemptAdmission,
  callback: (
    facts: Readonly<{
      runtimeRoot: string;
      playerId: string;
      companionId: string;
      continuityId: string;
      chatThreadId: string;
      chatSurfaceSessionId: string;
      selectionGeneration: number;
      runtimeBindingDigest: string;
      runtimeOwner: MountedAttemptBinding["runtimeOwner"];
    }>,
  ) => Promise<T>,
): Promise<T> {
  const record = mountedAttemptAdmissions.get(admission);
  if (record === undefined || !record.active.value || !record.lease.active || record.consuming.value)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
  record.consuming.value = true;
  try {
    const mounted = record.lease;
    return await callback(
      Object.freeze({
        runtimeRoot: mounted.runtimeRoot,
        playerId: mounted.principal.playerId,
        companionId: mounted.principal.companionId,
        continuityId: mounted.principal.continuityId,
        chatThreadId: mounted.chatThreadId,
        chatSurfaceSessionId: mounted.chatSurfaceSessionId,
        selectionGeneration: mounted.selectionGeneration,
        runtimeBindingDigest: record.binding.runtimeBindingDigest,
        runtimeOwner: record.binding.runtimeOwner,
      }),
    );
  } finally {
    record.active.value = false;
    record.consuming.value = false;
  }
}

/**
 * Private post-claim invocation admission. Consuming it mints exactly
 * one coordinator-private execution scope: the live materialized session, the
 * full immutable origin facts, the sole store-writer port, and the fixed
 * coordinator-minted start-admission deadline. No AgentSession, binding,
 * store, or minting path escapes this callback.
 */
export async function consumeMountedAttemptInvocationAdmission<T>(
  admission: MountedAttemptInvocationAdmission,
  callback: (scope: ProviderInvocationScope) => Promise<T>,
): Promise<T> {
  const record = mountedAttemptInvocationAdmissions.get(admission);
  if (record === undefined || !record.active.value || !record.lease.active || record.consuming.value)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_invocation_rejected");
  record.consuming.value = true;
  let operationAuthority: MountedTurnTransitionOperationAuthorityLease | undefined;
  try {
    const mounted = record.lease;
    const runtimeSession = mounted.providerRuntimeSession;
    if (runtimeSession === undefined)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_provider_start_session_unavailable");
    // Before this prompt exists: the player's connection selection is the
    // authority for the provider/model it runs with, whether it was activated on
    // an idle Chat (adopted at activation) or while a previous turn was still
    // generating (that reload answered `turn_in_flight`). No prompt is streaming
    // here, so adopting it disturbs nothing, and a selection this runtime already
    // carries is left untouched.
    await applyMountedModelSelection(mounted);
    const { attempt } = record.turn;
    const deadlineAtMs = Date.now() + PROVIDER_INVOCATION_ADMISSION_DEADLINE_MS;
    const facts = Object.freeze({
      turnId: record.turn.turnId,
      messageId: record.turn.messageId,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      selectionGeneration: attempt.selectionGeneration,
      idempotencyKey: record.turn.idempotencyKey,
      acceptedAtMs: record.turn.acceptedAtMs,
      runtimeRoot: mounted.runtimeRoot,
      playerId: mounted.principal.playerId,
      companionId: mounted.principal.companionId,
      continuityId: mounted.principal.continuityId,
      chatThreadId: mounted.chatThreadId,
      chatSurfaceSessionId: mounted.chatSurfaceSessionId,
      runtimeBindingDigest: attempt.runtimeBindingDigest,
      runtimeOwner: attempt.runtimeOwner,
      variant: record.turn.variant ?? null,
    });
    operationAuthority = mounted.transitionAuthority.mintOperation();
    const scopedOperationAuthority = operationAuthority;
    const assertScopeActive = (): void => {
      if (!record.active.value || !mounted.active)
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_invocation_rejected");
    };
    const assertAdmission = (): void => {
      assertScopeActive();
      if (Date.now() > deadlineAtMs)
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_provider_start_deadline_expired");
    };
    const transitionStore = async (
      command: import("../tavern/chat-thread-store.js").ProviderStartTransition,
    ): Promise<
      | import("../tavern/chat-thread-store.js").AttemptStartingTurn
      | import("../tavern/chat-thread-store.js").RunningTurn
      | import("../tavern/chat-thread-store.js").FailedTurn
      | import("../tavern/chat-thread-store.js").CancelledTurn
    > => {
      assertScopeActive();
      return transitionMountedProviderStart(
        Object.freeze({
          authority: mounted.transitionAuthority.authority,
          operationAuthority: scopedOperationAuthority.authority,
          runtimeRoot: mounted.runtimeRoot,
          playerId: mounted.principal.playerId,
          companionId: mounted.principal.companionId,
          continuityId: mounted.principal.continuityId,
          chatThreadId: mounted.chatThreadId,
          chatSurfaceSessionId: mounted.chatSurfaceSessionId,
          selectionGeneration: attempt.selectionGeneration,
          runtimeBindingDigest: attempt.runtimeBindingDigest,
          runtimeOwner: attempt.runtimeOwner,
          attemptId: attempt.attemptId,
        }),
        command,
      );
    };
    const transitionPresentation = async (
      command: import("../tavern/chat-thread-store.js").PresentationTransition,
    ): Promise<import("../tavern/chat-thread-store.js").ChatTurnLedger> => {
      assertScopeActive();
      return transitionMountedPresentation(
        Object.freeze({
          authority: mounted.transitionAuthority.authority,
          operationAuthority: scopedOperationAuthority.authority,
          runtimeRoot: mounted.runtimeRoot,
          playerId: mounted.principal.playerId,
          companionId: mounted.principal.companionId,
          continuityId: mounted.principal.continuityId,
          chatThreadId: mounted.chatThreadId,
          chatSurfaceSessionId: mounted.chatSurfaceSessionId,
          selectionGeneration: attempt.selectionGeneration,
          runtimeBindingDigest: attempt.runtimeBindingDigest,
          runtimeOwner: attempt.runtimeOwner,
          attemptId: attempt.attemptId,
        }),
        command,
      );
    };
    /**
     * The Pi-side half of a same-position variant turn, on the transitional
     * session-shape binding `branchPiVariantAnchor` documents. The position's own
     * durable variant texts are the proof the branch tail belongs to the reply this
     * turn is re-generating; a position whose shape does not match them refuses here,
     * before the caller's durable commit, so no variant can become visible without
     * the model's context already carrying it.
     */
    const branchVariantAnchor = async (
      anchorText: string,
    ): Promise<import("../pi-session-variant-branch.internal.js").PiVariantBranchResult> => {
      assertScopeActive();
      const variant = record.turn.variant;
      if (variant === undefined)
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_variant_activation_unavailable");
      const state = await mounted.store().resumeThread(mounted.chatThreadId, mounted.chatSurfaceSessionId);
      const position = state.messages.find((message) => message.messageId === variant.targetMessageId);
      if (position === undefined || position.role !== "companion" || position.kind !== "response")
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_variant_activation_unavailable");
      assertScopeActive();
      return branchPiVariantAnchor(
        runtimeSession.session,
        Object.freeze({
          variantTexts:
            position.swipes === undefined || position.swipes.length === 0 ? [position.text] : position.swipes,
        }),
        anchorText,
      );
    };
    const readAcceptedMessageText = async (): Promise<string> => {
      const store = mounted.store();
      const state = await store.resumeThread(mounted.chatThreadId, mounted.chatSurfaceSessionId);
      // A same-position variant turn owns no player message: its prompt is the
      // anchor player row the targeted reply answered. A missing anchor or a
      // prompt that no longer resolves to a player row fails closed on the same
      // bounded code rather than falling back to any other text.
      const promptMessageId = record.turn.variant?.anchorMessageId ?? record.turn.messageId;
      const message = state.messages.find(
        (candidate) =>
          candidate.messageId === promptMessageId && candidate.role === "player" && candidate.kind === "player",
      );
      if (message === undefined)
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_provider_start_message_unavailable");
      return message.text;
    };
    const readAcceptedAuthoredContextPlan = async (): Promise<
      import("../tavern/chat-thread-store.js").AcceptedTurnAuthoredContextPlan
    > => {
      assertScopeActive();
      const store = mounted.store();
      const state = await store.resumeThread(mounted.chatThreadId, mounted.chatSurfaceSessionId);
      const plan = state.currentTurnContextPlan;
      if (plan === undefined || plan.turnId !== facts.turnId)
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_authored_context_plan_unavailable");
      return plan;
    };
    const readCurrentTurnLedger = async (): Promise<import("../tavern/chat-thread-store.js").ChatTurnLedger> => {
      const store = mounted.store();
      const ledger = (await store.resumeThread(mounted.chatThreadId, mounted.chatSurfaceSessionId)).turnLedger;
      if (ledger === null || ledger.turnId !== facts.turnId || !isTurnWithExactAttempt(ledger, facts.attemptId))
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_turn_unavailable");
      return ledger;
    };
    const beginActivePrompt = (): (() => void) => {
      assertAdmission();
      if (mounted.activePrompt !== undefined)
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_prompt_already_active");
      const activePrompt = Object.freeze({ turnId: facts.turnId, attemptId: facts.attemptId, aborting: false });
      mounted.activePrompt = activePrompt;
      return () => {
        if (mounted.activePrompt === activePrompt) mounted.activePrompt = undefined;
        for (const resolve of mounted.promptSettlementWaiters) resolve();
        mounted.promptSettlementWaiters.clear();
      };
    };
    let nativeContentCommitReserved = false;
    let nativeContentPreviewEpoch: import("../companion-interruption.js").InterruptionSnapshot | undefined;
    const reserveNativeContentCommit = (): Readonly<{ cancelEpoch: number; release(): void }> | undefined => {
      const observationEpoch = mounted.presentationEpoch.capture();
      if (
        nativeContentCommitReserved ||
        !mounted.presentationEpoch.isCurrent(observationEpoch) ||
        !record.active.value ||
        !mounted.active
      )
        return undefined;
      nativeContentCommitReserved = true;
      return Object.freeze({
        cancelEpoch: observationEpoch.epoch,
        release: () => {
          nativeContentCommitReserved = false;
        },
      });
    };
    const canPreviewNativeContent = (): boolean => {
      const previewEpoch = (nativeContentPreviewEpoch ??= mounted.presentationEpoch.capture());
      return record.active.value && mounted.active && mounted.presentationEpoch.isCurrent(previewEpoch);
    };
    /**
     * Records which Pi session entries this exact turn's prompt produced for the rows it wrote, so a
     * later single-row delete can name the entry it omits instead of guessing at a position. The
     * runner is the only caller that knows what the prompt appended, and it calls this after the
     * prompt settles. A binding write can never fail the turn it describes: the reply is already
     * durable by then, and a row with no binding is the honest state a delete refuses on.
     */
    const recordTranscriptEntryBinding = async (
      entries: readonly Readonly<{ messageId: string; entryId: string }>[],
    ): Promise<void> => {
      if (entries.length === 0) return;
      assertScopeActive();
      const store = mounted.store();
      if (typeof store.recordTranscriptEntryBinding !== "function") return;
      await store.recordTranscriptEntryBinding(mounted.transitionAuthority.authority, mounted.chatThreadId, entries);
    };
    const finalizeCancellation = async (): Promise<
      | import("../tavern/chat-thread-store.js").CompletionClaimedTurn
      | import("../tavern/chat-thread-store.js").CompletedTurn
      | import("../tavern/chat-thread-store.js").CancelClaimedTurn
      | import("../tavern/chat-thread-store.js").CancelledTurn
      | import("../tavern/chat-thread-store.js").FailedTurn
      | undefined
    > => {
      const cancellation = mounted.cancellation;
      if (cancellation === undefined) return undefined;
      const winner = await cancellation;
      switch (winner.status) {
        case "completion_claimed":
        case "completed":
        case "cancel_claimed":
        case "cancelled":
        case "failed":
          return winner;
        default:
          throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
      }
    };
    return await callback(
      Object.freeze({
        facts,
        deadlineAtMs,
        runtimeSession,
        authoredContextCapability: Object.freeze({
          assertInstall: (
            durableTurnId: string,
            refs: readonly Readonly<Record<string, string>>[],
            volatileRefs?: readonly Readonly<Record<string, string>>[],
          ) => {
            assertScopeActive();
            const capability = mounted.authoredContextCapability;
            if (capability === undefined || typeof capability.assertInstall !== "function")
              throw new SemanticProductionCoordinatorError("semantic_chat_runtime_authored_context_unavailable");
            capability.assertInstall(
              durableTurnId,
              refs as readonly import("@cortexkit/pi-magic-context/tavern").GameBuddyAuthoredStableSourceRef[],
              volatileRefs as
                | readonly import("@cortexkit/pi-magic-context/tavern").GameBuddyAuthoredVolatileSourceRef[]
                | undefined,
            );
          },
          clearVolatileForTurn: (durableTurnId: string) => {
            assertScopeActive();
            const capability = mounted.authoredContextCapability;
            if (capability === undefined || typeof capability.clearVolatileForTurn !== "function")
              throw new SemanticProductionCoordinatorError("semantic_chat_runtime_authored_context_unavailable");
            capability.clearVolatileForTurn(durableTurnId);
          },
        }),
        transitionStore,
        transitionPresentation,
        branchVariantAnchor,
        readAcceptedMessageText,
        readAcceptedAuthoredContextPlan,
        readCurrentTurnLedger,
        assertAdmission,
        beginActivePrompt,
        reserveNativeContentCommit,
        canPreviewNativeContent,
        recordTranscriptEntryBinding,
        finalizeCancellation,
      }),
    );
  } finally {
    operationAuthority?.revoke();
    record.active.value = false;
    record.consuming.value = false;
  }
}

/**
 * The only start runner. It reads the already durable claim under the
 * mounted authority, then mints one callback-scoped invocation admission.
 * It never calls the claim ingress, so a start cannot create generation 2
 * or replace an existing attempt.
 */
export async function startMountedAttempt(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  start: (
    invocation: MountedAttemptInvocationAdmission,
  ) => Promise<
    | import("../tavern/chat-thread-store.js").AttemptStartingTurn
    | import("../tavern/chat-thread-store.js").CompletedTurn
    | import("../tavern/chat-thread-store.js").CancelledTurn
    | import("../tavern/chat-thread-store.js").FailedTurn
  >,
): Promise<
  | import("../tavern/chat-thread-store.js").AttemptStartingTurn
  | import("../tavern/chat-thread-store.js").CompletedTurn
  | import("../tavern/chat-thread-store.js").CancelledTurn
  | import("../tavern/chat-thread-store.js").FailedTurn
> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId ||
    record.attemptBinding === undefined
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
  return record.begin(async () => {
    if (!record.active)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
    const binding = record.attemptBinding;
    if (binding === undefined)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
    const store = record.store();
    const state = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
    const turn = state.turnLedger;
    if (
      turn === null ||
      turn.status !== "attempt_starting" ||
      turn.observation !== undefined ||
      turn.attempt.generation !== 1 ||
      turn.attempt.selectionGeneration !== record.selectionGeneration ||
      turn.attempt.runtimeBindingDigest !== binding.runtimeBindingDigest ||
      turn.attempt.runtimeOwner.ownerToken !== binding.runtimeOwner.ownerToken ||
      turn.attempt.runtimeOwner.runtimeInstanceId !== binding.runtimeOwner.runtimeInstanceId ||
      turn.attempt.runtimeOwner.ownerPid !== binding.runtimeOwner.ownerPid ||
      turn.attempt.runtimeOwner.ownerProcessStartIdentity !== binding.runtimeOwner.ownerProcessStartIdentity
    )
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
    if (record.startedAttemptIds.has(turn.attempt.attemptId))
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
    record.startedAttemptIds.add(turn.attempt.attemptId);
    const invocationActive = { value: true };
    const invocationConsuming = { value: false };
    const invocation = Object.freeze({}) as MountedAttemptInvocationAdmission;
    mountedAttemptInvocationAdmissions.set(
      invocation,
      Object.freeze({ lease: record, turn, active: invocationActive, consuming: invocationConsuming }),
    );
    try {
      return await start(invocation);
    } catch (error) {
      // A local failure before `armed` is durably committed has not reached the
      // Host invocation boundary. Re-read the exact ledger before releasing the
      // in-process reservation: any ambiguity keeps it reserved fail-closed.
      try {
        const readBack = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
        const readBackTurn = readBack.turnLedger;
        if (
          readBackTurn !== null &&
          readBackTurn.status === "attempt_starting" &&
          readBackTurn.observation === undefined &&
          readBackTurn.attempt.attemptId === turn.attempt.attemptId &&
          readBackTurn.attempt.selectionGeneration === turn.attempt.selectionGeneration &&
          readBackTurn.attempt.runtimeBindingDigest === turn.attempt.runtimeBindingDigest &&
          readBackTurn.attempt.runtimeOwner.ownerToken === turn.attempt.runtimeOwner.ownerToken &&
          readBackTurn.attempt.runtimeOwner.runtimeInstanceId === turn.attempt.runtimeOwner.runtimeInstanceId &&
          readBackTurn.attempt.runtimeOwner.ownerPid === turn.attempt.runtimeOwner.ownerPid &&
          readBackTurn.attempt.runtimeOwner.ownerProcessStartIdentity ===
            turn.attempt.runtimeOwner.ownerProcessStartIdentity
        )
          record.startedAttemptIds.delete(turn.attempt.attemptId);
      } catch {
        // Unknown read-back state must retain the reservation: releasing it
        // could permit a second Host prompt after an unobserved arm boundary.
      }
      throw error;
    } finally {
      invocationActive.value = false;
    }
  });
}

export async function consumeMountedDurableAdmission<T>(
  admission: MountedAdmission,
  callback: (
    facts: Readonly<{
      runtimeRoot: string;
      playerId: string;
      companionId: string;
      continuityId: string;
      chatThreadId: string;
      chatSurfaceSessionId: string;
      selectionGeneration: number;
      profile: Readonly<{ profileId: string; revision: number; canonicalHash: string }>;
      authoredContextCapability: Readonly<{
        prepare(transientPreflightId: string): Readonly<{
          sourceRefs: readonly Readonly<Record<string, string>>[];
          stableTokenCount: number;
          volatileSourceRefs: readonly Readonly<Record<string, string>>[];
          volatileSourceCandidates: readonly Readonly<Record<string, unknown>>[];
          volatileTokenCount: number;
        }>;
        materializeVolatileForTurn(
          turnId: string,
          acceptedPlayerText: string,
          boundedVisibleTail: string,
        ): Readonly<{ refs: readonly Readonly<Record<string, string>>[]; tokenCount: number }>;
      }>;
    }>,
  ) => Promise<T>,
): Promise<T> {
  const record = mountedAdmissions.get(admission);
  if (record === undefined || !record.active.value || record.consuming.value)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_admission_rejected");
  record.consuming.value = true;
  try {
    const mounted = record.lease;
    const mountedThreadStore = mounted.store();
    const mountedThread = (await mountedThreadStore.resumeThread(mounted.chatThreadId, mounted.chatSurfaceSessionId))
      .thread;
    return await callback(
      Object.freeze({
        runtimeRoot: mounted.runtimeRoot,
        playerId: mounted.principal.playerId,
        companionId: mounted.principal.companionId,
        continuityId: mounted.principal.continuityId,
        chatThreadId: mounted.chatThreadId,
        chatSurfaceSessionId: mounted.chatSurfaceSessionId,
        selectionGeneration: mounted.selectionGeneration,
        profile: Object.freeze({
          profileId: mountedThread.profileId,
          revision: mountedThread.profileRevision,
          canonicalHash: mountedThread.profileCanonicalHash,
        }),
        authoredContextCapability: Object.freeze({
          prepare: (transientPreflightId: string) => {
            const capability = mounted.authoredContextCapability;
            if (capability === undefined)
              throw new SemanticProductionCoordinatorError("semantic_chat_runtime_authored_context_unavailable");
            if (typeof capability.prepare !== "function")
              throw new SemanticProductionCoordinatorError("semantic_chat_runtime_authored_context_unavailable");
            return capability.prepare(transientPreflightId);
          },
          materializeVolatileForTurn: (turnId: string, acceptedPlayerText: string, boundedVisibleTail: string) => {
            const capability = mounted.authoredContextCapability;
            if (capability === undefined || typeof capability.materializeVolatileForTurn !== "function")
              throw new SemanticProductionCoordinatorError("semantic_chat_runtime_authored_context_unavailable");
            return capability.materializeVolatileForTurn(turnId, acceptedPlayerText, boundedVisibleTail);
          },
        }),
      }),
    );
  } finally {
    record.active.value = false;
    record.consuming.value = false;
  }
}

/**
 * The one authorized swipe-position ingress. `store.selectSwipe` requires the
 * coordinator-minted mounted transition authority, and only a live mounted lease
 * record holds one; so a caller that has a store but no live mount cannot mutate
 * a reply position. It neither creates nor selects a Chat and never prompts Pi.
 */
export async function selectMountedSwipeVariant(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  input: Readonly<{ messageId: string; targetIndex?: number; direction?: "prev" | "next" }>,
): Promise<import("../tavern/chat-thread-store.js").ChatThreadState> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId ||
    typeof input.messageId !== "string" ||
    input.messageId.length === 0
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_swipe_selection_unavailable");
  const store = record.store();
  return await store.selectSwipe!(record.transitionAuthority.authority, record.chatThreadId, input.messageId, {
    ...(input.targetIndex === undefined ? {} : { targetIndex: input.targetIndex }),
    ...(input.direction === undefined ? {} : { direction: input.direction }),
  });
}

/**
 * A mounted-mutation refusal that names its own branch on stderr and throws the code the surface reads.
 *
 * The four mounted ingresses (swipe, rewind, edit, delete) share one guard shape, and the route's
 * `problemFor` maps every code whose text contains "runtime" into the same opaque 503
 * `runtime_unavailable`. So the branches that are a fact about the point the player named - a position
 * the transcript no longer holds, the greeting the Chat opened on, a row that is neither the player's
 * own words nor her reply - throw the durable store's own bounded code for that fact, which the route
 * already maps to its own status and the client already has a sentence for; refusing with the
 * ingress's generic code there told the player the runtime was gone about a message the player can see.
 * A refusal that is genuinely about the runtime - no live mount, no exact runtime session - keeps the
 * ingress's own code and stays that 503, and the branch line on stderr is its only distinguishing
 * evidence on a Host.
 *
 * The branch name is a diagnostic for whoever reads the Host's stderr, the style the session-shape
 * refusals below already use: the kit buffers the entry's stderr in the launch phase, so it is a hint
 * for a host-level run rather than a capture channel.
 */
function refuseMountedMutation(branch: string, code: string): never {
  process.stderr.write(`[mounted-mutation] ${branch} -> ${code}\n`);
  throw new SemanticProductionCoordinatorError(code);
}

/**
 * The one authorized rewind ingress. A rewind reshapes the model's own session, and only a live
 * mounted lease holds the exact runtime session the mounted conversation owns, so a caller with a
 * store but no live mount cannot reshape a conversation. Like the swipe ingress it neither creates
 * nor selects a Chat.
 *
 * The shape is Pi's and SillyTavern's: the message the player names is KEPT and everything after it
 * stops contributing - Pi moves the session leaf to that entry, and the vendor's append-only edit of
 * it pins the cut durably (`rewindPiTranscriptTail`).
 *
 * The order is the whole point. The durable read, the session's own shortening and the durable
 * truncation share one synchronous critical section - there is no `await` between them, and the Host
 * runs on a single event loop - so nothing can be admitted between the session shape this rewind
 * proved and the rows it removes. The store re-checks the ledger inside its own transaction, so a
 * turn admitted by a write that slipped in before the read still refuses; that refusal rolls the
 * transaction back, and the session is put where it was. A refused rewind therefore leaves both
 * authorities exactly as it found them.
 */
export async function rewindMountedChatTranscript(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  input: Readonly<{ messageId: string; expectedOrder: number }>,
): Promise<import("../tavern/chat-thread-store.js").ChatThreadState> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId ||
    typeof input.messageId !== "string" ||
    input.messageId.length === 0 ||
    !Number.isSafeInteger(input.expectedOrder) ||
    input.expectedOrder < 0
  )
    throw refuseMountedMutation("rewind record-or-input", "semantic_chat_runtime_rewind_unavailable");
  const runtimeSession = record.providerRuntimeSession;
  if (runtimeSession === undefined)
    throw refuseMountedMutation("rewind session-missing", "semantic_chat_runtime_rewind_unavailable");
  const store = record.store();
  const state = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
  // Row zero is the greeting the Chat opened on, and it is also the session's own anchor (the
  // conversation's first assistant message, Order 0). A rewind keeps the message it names and drops
  // everything after it, so the kept row - the anchor included when it is the one named - is the entry
  // the cut is pinned to, and only what follows it is proved positionally. The one target still refused
  // by name is the greeting itself: a rewind that would leave nothing but the conversation's own opening
  // is not a cut back into the exchange, and the opening is the row the thread's opening record names.
  if (state.messages[input.expectedOrder]?.kind === "opening")
    throw refuseMountedMutation("rewind target-opening", "chat_rewind_opening_retained");
  const dropped: PiTranscriptMessage[] = state.messages
    .slice(input.expectedOrder + 1)
    .map((message) => Object.freeze({ role: message.role, text: message.text }));
  const rewound = rewindPiTranscriptTail(runtimeSession.session, dropped);
  if (rewound.status !== "rewound") {
    process.stderr.write(`[rewind] session shape refused: ${rewound.reason}\n`);
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_rewind_unavailable");
  }
  try {
    return await store.rewindTranscript!(record.transitionAuthority.authority, record.chatThreadId, input);
  } catch (error) {
    rewound.revert();
    throw error;
  }
}

/**
 * The one authorized in-place edit ingress. An edit replaces what the model's own session carries for
 * one message - the player's own line, her reply, or the greeting the Chat opened on - and only a live
 * mounted lease holds the exact runtime session whose path the mounted conversation owns; so a caller
 * with a store but no live mount cannot reshape a conversation. Like the swipe and rewind
 * ingresses it neither creates nor selects a Chat and never prompts Pi.
 *
 * The order is the whole point, and it is the rewind's: the durable read, the session's own
 * replacement and the durable row update share one synchronous critical section - there is no
 * `await` between them, and the Host runs on a single event loop - so nothing can be admitted
 * between the session shape this edit proved and the row it rewrites. The store re-checks the row and
 * the ledger inside its own transaction, so a turn admitted by a write that slipped in before the
 * read still refuses; that refusal rolls the transaction back, and the entry's own original text is
 * put back by an appended edit, so the session file agrees with the transcript the player still has.
 * A refused edit therefore leaves both authorities exactly as it found them.
 */
export async function editMountedChatMessage(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  input: Readonly<{ messageId: string; expectedOrder: number; text: string }>,
): Promise<import("../tavern/chat-thread-store.js").ChatThreadState> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId ||
    typeof input.messageId !== "string" ||
    input.messageId.length === 0 ||
    typeof input.text !== "string" ||
    input.text.length === 0 ||
    !Number.isSafeInteger(input.expectedOrder) ||
    input.expectedOrder < 0
  )
    throw refuseMountedMutation("edit record-or-input", "semantic_chat_runtime_edit_unavailable");
  const runtimeSession = record.providerRuntimeSession;
  if (runtimeSession === undefined)
    throw refuseMountedMutation("edit session-missing", "semantic_chat_runtime_edit_unavailable");
  const store = record.store();
  const state = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
  const target = state.messages[input.expectedOrder];
  if (target === undefined || target.messageId !== input.messageId)
    throw refuseMountedMutation("edit target-mismatch", "chat_message_revision_conflict");
  // The player's own line, her reply, or the greeting the Chat opened on: row zero is the conversation's
  // own opening, which the mount anchors in the session as its first assistant message, and a row that is
  // none of them is not a message this operation edits.
  const editable =
    (target.role === "player" && target.kind === "player") ||
    (target.role === "companion" && (target.kind === "response" || target.kind === "opening"));
  // Unreachable by the store's own kinds: a row whose role and kind disagree is a store/product
  // disagreement, so it fails closed as an internal fault instead of borrowing a player-facing code.
  if (!editable) throw refuseMountedMutation("edit target-not-editable", "chat_message_not_editable");
  // The transcript rows the model's own context carries, in order, up to and including the row the
  // player named: each one is paired with the entry contributing exactly its words in its role
  // (`editPiTranscriptEntry`), so an entry no row names - the Host's own system prompt, an intermediate
  // tool-use commentary - is passed over rather than counted, and the row after such an entry lands.
  // The conversation's own opening row is named only when it is the row being edited: the mount anchors
  // it as the session's first assistant message, but that anchor is an entry no row must name - a
  // greeting the row projection drops contributes no row at all - and the exchange rows after it are
  // proved on their own.
  const rows: PiTranscriptMessage[] = state.messages
    .slice(0, input.expectedOrder + 1)
    .filter((message, order) => message.kind !== "opening" || order === input.expectedOrder)
    .map((message) => Object.freeze({ role: message.role, text: message.text }));
  const edited = editPiTranscriptEntry(runtimeSession.session, rows, input.text);
  if (edited.status !== "edited") {
    process.stderr.write(`[edit] session shape refused: ${edited.reason}\n`);
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_edit_unavailable");
  }
  try {
    return await store.editTranscriptMessage!(record.transitionAuthority.authority, record.chatThreadId, input);
  } catch (error) {
    edited.revert();
    throw error;
  }
}

/**
 * The one authorized single-message delete ingress. A delete removes exactly one row from the middle of
 * a conversation, and only a live mounted lease holds the exact runtime session whose active path the
 * mounted conversation owns; so a caller with a store but no live mount cannot reshape a conversation.
 * Like the swipe, rewind and edit ingresses it neither creates nor selects a Chat and never prompts Pi.
 *
 * The order is the difference from a rewind, and it is the reason this operation needed a durable
 * binding at all. A rewind drops a SUFFIX and proves that suffix positionally - the session's own newest
 * message entries must carry the dropped rows in order - so it never has to tell two entries of the same
 * role apart. A hole in the MIDDLE has no tail to match against, so the row the player named is resolved
 * through the durable `(thread_id, message_id, entry_id)` binding the runner recorded for the turn that
 * wrote it, and the entry that omission names must be the one on the model's active path. A row with no
 * recorded binding (every row written before the binding existed) refuses as exactly that, and never as
 * a guess.
 *
 * The durable read, the entry's omission in the session and the durable row removal share one
 * synchronous critical section - there is no `await` between the session proof and the session
 * mutation, and the Host runs on a single event loop - so nothing can be admitted between them. The
 * store re-checks the row, its position and the ledger inside its own transaction, so a turn admitted by
 * a write that slipped in before the read still refuses; that refusal rolls the transaction back and the
 * entry's own contribution is put back by an appended edit, so the session file agrees with the
 * transcript the player still has. A refused delete therefore leaves both authorities exactly as it
 * found them.
 */
export async function deleteMountedChatMessage(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  input: Readonly<{ messageId: string; expectedOrder: number }>,
): Promise<import("../tavern/chat-thread-store.js").ChatThreadState> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId ||
    typeof input.messageId !== "string" ||
    input.messageId.length === 0 ||
    !Number.isSafeInteger(input.expectedOrder) ||
    input.expectedOrder < 0
  )
    throw refuseMountedMutation("delete record-or-input", "semantic_chat_runtime_delete_unavailable");
  const runtimeSession = record.providerRuntimeSession;
  if (runtimeSession === undefined)
    throw refuseMountedMutation("delete session-missing", "semantic_chat_runtime_delete_unavailable");
  const store = record.store();
  const state = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
  const target = state.messages[input.expectedOrder];
  if (target === undefined || target.messageId !== input.messageId)
    throw refuseMountedMutation("delete target-mismatch", "chat_message_revision_conflict");
  const bound =
    typeof store.readTranscriptEntryBinding === "function"
      ? await store.readTranscriptEntryBinding(record.chatThreadId, input.messageId)
      : [];
  const entryId = boundEntryOnActivePath(runtimeSession.session, bound);
  if (entryId === null) throw new SemanticProductionCoordinatorError("chat_delete_binding_unavailable");
  let deleted: import("../pi-session-variant-branch.internal.js").PiTranscriptDeleteResult;
  try {
    deleted = deletePiTranscriptEntry(runtimeSession.session, entryId);
  } catch {
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_delete_unavailable");
  }
  if (deleted.status !== "deleted") {
    process.stderr.write(`[delete] session shape refused: ${deleted.reason}\n`);
    throw new SemanticProductionCoordinatorError("chat_delete_binding_unavailable");
  }
  try {
    return await store.deleteTranscriptMessage!(record.transitionAuthority.authority, record.chatThreadId, input);
  } catch (error) {
    deleted.revert();
    throw error;
  }
}

/**
 * Coordinator-private cancel seam. It synchronously revokes the current
 * presentation epoch, then records the exact durable cancel claim while the
 * running prompt is drained. P6 may later supply an authenticated ingress,
 * but this seam deliberately exposes no HTTP/browser surface.
 */
export async function stopMountedChatPresentationEpoch(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  input: Readonly<{ stopId: string; sourceEventId: string; reasonCode: string }>,
): Promise<CancelResult> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");

  // A mounted attempt has exactly one cancel claimant. `CompanionInterruption`
  // may receive distinct control IDs, but later STOPs must not replace or race
  // the first durable claim for this exact attempt.
  if (record.cancellation !== undefined) {
    await record.cancellation;
    return readCancellationResult(record);
  }

  // Preflight is durable and side-effect free. A queued turn cannot be
  // cancelled, but an armed prompt may be aborted and terminalized directly
  // without waiting for a provider-response observation.
  const preflight = await readCurrentPresentationLedger(record).catch(async (error) => {
    const store = record.store();
    const ledger = (await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId)).turnLedger;
    if (
      ledger?.status === "attempt_starting" &&
      ledger.observation?.phase === "armed" &&
      record.attemptBinding !== undefined &&
      ledger.attempt.selectionGeneration === record.selectionGeneration &&
      ledger.attempt.runtimeBindingDigest === record.attemptBinding.runtimeBindingDigest &&
      ledger.attempt.runtimeOwner.ownerToken === record.attemptBinding.runtimeOwner.ownerToken &&
      ledger.attempt.runtimeOwner.runtimeInstanceId === record.attemptBinding.runtimeOwner.runtimeInstanceId &&
      ledger.attempt.runtimeOwner.ownerPid === record.attemptBinding.runtimeOwner.ownerPid &&
      ledger.attempt.runtimeOwner.ownerProcessStartIdentity ===
        record.attemptBinding.runtimeOwner.ownerProcessStartIdentity
    )
      return ledger;
    throw error;
  });
  switch (preflight.status) {
    case "completion_claimed":
    case "completed":
    case "failed":
    case "cancel_claimed":
    case "cancelled":
      return preflight;
    case "running":
    case "presentation_committed":
      break;
    case "attempt_starting":
      if (preflight.observation?.phase !== "armed")
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
      break;
    default:
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
  }

  // Two distinct STOPs can overlap at the asynchronous durable preflight.
  // Recheck immediately before the synchronous epoch linearization so only the
  // first claimant may revoke and create the cancel-claim promise.
  if (record.cancellation !== undefined) {
    await record.cancellation;
    return readCancellationResult(record);
  }

  const stop = record.presentationEpoch.stop(input.stopId, input.sourceEventId, input.reasonCode);
  if (!stop.accepted)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");

  // The provider invocation runner occupies record.begin() for the lifetime of session.prompt().
  // STOP must not queue its durable claim behind that runner because settlement
  // waits for this exact claim to classify its winner. Revoke synchronously,
  // then claim before any callback or prompt drain: this is the first durable
  // cancel authority after the in-memory epoch closes. The runner owns the
  // later drain and final `cancelled` transition. In particular STOP must not
  // await gate.drain(): a listener may itself await STOP while it is pending.
  // Claim the durable winner before awaiting Pi abort. `abort()` may settle the
  // prompt synchronously, so awaiting it first would let rejection terminalize
  // the turn as failed even though STOP already won its linearization point.
  const abort = record.providerRuntimeSession?.session?.abort;
  const cancellation: Promise<CancelResult> = (async (): Promise<CancelResult> => {
    const binding = record.attemptBinding;
    if (binding === undefined)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
    const store = record.store();
    const state = await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
    const ledger = state.turnLedger;
    if (
      ledger === null ||
      ledger.status === "accepted_queued" ||
      ledger.attempt.generation !== 1 ||
      ledger.attempt.selectionGeneration !== record.selectionGeneration ||
      ledger.attempt.runtimeBindingDigest !== binding.runtimeBindingDigest ||
      ledger.attempt.runtimeOwner.ownerToken !== binding.runtimeOwner.ownerToken ||
      ledger.attempt.runtimeOwner.runtimeInstanceId !== binding.runtimeOwner.runtimeInstanceId ||
      ledger.attempt.runtimeOwner.ownerPid !== binding.runtimeOwner.ownerPid ||
      ledger.attempt.runtimeOwner.ownerProcessStartIdentity !== binding.runtimeOwner.ownerProcessStartIdentity
    )
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");

    switch (ledger.status) {
      case "completion_claimed":
      case "completed":
      case "failed":
      case "cancel_claimed":
      case "cancelled":
        return ledger;
      default:
        break;
    }
    const operationAuthority = record.transitionAuthority.mintOperation();
    try {
      if (ledger.status === "attempt_starting") {
        if (ledger.observation?.phase !== "armed")
          throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
        // An `armed` turn has no separate claim step: this one transition both
        // claims and cancels it, so both stamps are the same instant and come
        // from one clock read. Two reads would let the pair straddle a
        // millisecond boundary and misreport a single transition as two.
        const cancelledAtMs = Date.now();
        const cancelled = await transitionMountedProviderStart(
          Object.freeze({
            authority: record.transitionAuthority.authority,
            operationAuthority: operationAuthority.authority,
            runtimeRoot: record.runtimeRoot,
            playerId: record.principal.playerId,
            companionId: record.principal.companionId,
            continuityId: record.principal.continuityId,
            chatThreadId: record.chatThreadId,
            chatSurfaceSessionId: record.chatSurfaceSessionId,
            selectionGeneration: ledger.attempt.selectionGeneration,
            runtimeBindingDigest: ledger.attempt.runtimeBindingDigest,
            runtimeOwner: ledger.attempt.runtimeOwner,
            attemptId: ledger.attempt.attemptId,
          }),
          Object.freeze({ operation: "cancel", observedAtMs: cancelledAtMs, cancelledAtMs }),
        );
        if (cancelled.status !== "cancelled")
          throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
        return cancelled;
      }
      if (ledger.status !== "running" && ledger.status !== "presentation_committed")
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
      const cancelled = await transitionMountedPresentation(
        Object.freeze({
          authority: record.transitionAuthority.authority,
          operationAuthority: operationAuthority.authority,
          runtimeRoot: record.runtimeRoot,
          playerId: record.principal.playerId,
          companionId: record.principal.companionId,
          continuityId: record.principal.continuityId,
          chatThreadId: record.chatThreadId,
          chatSurfaceSessionId: record.chatSurfaceSessionId,
          selectionGeneration: ledger.attempt.selectionGeneration,
          runtimeBindingDigest: ledger.attempt.runtimeBindingDigest,
          runtimeOwner: ledger.attempt.runtimeOwner,
          attemptId: ledger.attempt.attemptId,
        }),
        Object.freeze({ operation: "claim_cancel", claimedAtMs: Date.now() }),
      );
      if (cancelled.status !== "cancel_claimed")
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
      return cancelled;
    } catch (error) {
      // Completion can win after the durable running preflight but before this
      // cancel CAS. That is a normal winner race: preserve the first durable
      // representation rather than converting it into a cancellation failure.
      const winner = await readCancellationResult(record);
      if (
        winner.status === "completion_claimed" ||
        winner.status === "completed" ||
        winner.status === "failed" ||
        winner.status === "cancel_claimed" ||
        winner.status === "cancelled"
      )
        return winner;
      throw error;
    } finally {
      operationAuthority.revoke();
    }
  })();
  // Publish the durable winner promise before aborting. A synchronous abort
  // rejection then observes this promise in provider invocation and cannot replace STOP with
  // a failed terminal state.
  record.cancellation = cancellation;
  // Stop's browser-visible winner is the durable cancellation, not the
  // provider transport's eventual abort settlement. Invoke the exact mounted
  // session once but do not let a stuck/slow provider abort hold the HTTP
  // request or its authoritative reread hostage. Any rejection is deliberately
  // ignored: SQLite already selected the terminal winner before this call.
  if (typeof abort === "function") {
    try {
      void Promise.resolve(abort.call(record.providerRuntimeSession!.session)).catch(() => undefined);
    } catch {
      // Synchronous transport failure also cannot replace the durable winner.
    }
  }
  return cancellation;
}

/**
 * Proves that a value is the coordinator's still-current mounted lease. This
 * is identity-based: structural copies cannot carry the private WeakMap brand.
 * It deliberately reveals no lease record, control, store, or minting path.
 */
export function isCurrentMountedChatRuntimeLease(value: unknown): value is MountedChatRuntimeLease {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return mountedChatRuntimeLeases.get(value)?.active === true;
}

function createMountedChatBrowserProjection(
  chatThreadId: string,
  chatSurfaceSessionId: string,
  selectionRevision: number,
): MountedChatBrowserProjection {
  if (!Number.isSafeInteger(selectionRevision) || selectionRevision < 1)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_mount_selection_revision_rejected");
  const secret = randomBytes(32);
  const project = (domain: "chat" | "selection-state" | "message" | "turn" | "companion", value: string): string =>
    createHmac("sha256", secret)
      .update(`${domain}\0${chatThreadId}\0${chatSurfaceSessionId}\0${value}`, "utf8")
      .digest("base64url");
  return Object.freeze({
    chatHandle: project("chat", ""),
    selectionGeneration: selectionRevision,
    selectionStateRevision: project("selection-state", String(selectionRevision)),
    projectMessageHandle(messageId: string): string {
      if (!validId(messageId))
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_message_id_rejected");
      return project("message", messageId);
    },
    projectTurnHandle(turnId: string): string {
      if (!validId(turnId)) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_turn_id_rejected");
      return project("turn", turnId);
    },
    projectChatHandle(otherChatThreadId: string, otherChatSurfaceSessionId: string): string {
      if (!validId(otherChatThreadId) || !validId(otherChatSurfaceSessionId))
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_thread_id_rejected");
      if (otherChatThreadId === chatThreadId && otherChatSurfaceSessionId === chatSurfaceSessionId)
        return project("chat", "");
      return project("chat", `${otherChatThreadId}\0${otherChatSurfaceSessionId}`);
    },
    projectCompanionHandle(otherCompanionId: string): string {
      if (!validId(otherCompanionId))
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_companion_id_rejected");
      return project("companion", otherCompanionId);
    },
  });
}

export type SemanticChatRuntimeProductionAuthority = Readonly<{
  authority: "SEMANTIC";
  startChatRuntime(): Promise<ProductionChatRuntimeReadback>;
  startMountedChatRuntime(): Promise<MountedChatRuntimeLease>;
  /**
   * ADR 0009: records the player's expected Chat selection. The recorded
   * expectation never advances a runtime vector; the next start's pre-mount
   * settlement honours it with the single `select_chat` bridge.
   */
  requestChatSelection(input: SemanticChatSelectionRequest): Promise<SemanticChatSelectionOutcome>;
  close(): Promise<void>;
}>;

export type SemanticProductionAuthority = Readonly<{
  authority: "SEMANTIC";
  /** Manifest-bound, close-drained Chat catalog. No Tavern content is read under this semantic mutex. */
  readChatCatalog(): Promise<ProductionChatCatalog>;
  /** Identities and CAS vectors are derived internally from the immediately preceding semantic readback. */
  registerChat(): Promise<ProductionChatCommandReadback>;
  verifyRegisteredChatContent(receipt: TavernExactContentReceipt): Promise<ProductionChatCommandReadback>;
  selectVerifiedChat(): Promise<ProductionChatCommandReadback>;
  /**
   * Coordinator-private exact same-selection successor bridge. Derives the
   * current exact active Chat from the durable catalog and writes one ordinary
   * `select_chat` bridge for it. The store's successor admission consumes this
   * bridge only for a mount after the exact terminal predecessor teardown, or
   * after an interrupted cycle - a terminal predecessor with no teardown at all,
   * whose own committed vector is the end this bridge consumes - and for no other
   * shape, so the bridge cannot fork the runtime chain.
   */
  reselectTerminalChatRuntimeSuccessor(): Promise<ProductionChatCommandReadback>;
  transitionNonSelectedChatLifecycle(
    operation: ProductionChatLifecycleInput["operation"],
  ): Promise<ProductionChatCommandReadback>;
  startInitialChat(): Promise<ProductionSagaReadback>;
  registerInitialChat(): Promise<ProductionSagaReadback>;
  verifyInitialChat(receipt: TavernExactContentReceipt): Promise<ProductionSagaReadback>;
  selectInitialChat(): Promise<ProductionSagaReadback>;
  /** The only content-aware path: SQLite steps are locked; Tavern I/O is intentionally unlocked. */
  initializeInitialChat(content: InitialChatExactContentPort): Promise<ProductionSagaReadback>;
  /** Reads the durable saga only; the composition's explicit resume path re-reads Tavern separately. */
  resumeInitialChat(): Promise<ProductionSagaReadback | null>;
  resumeInitialChatWithContent(content: InitialChatExactContentPort): Promise<ProductionSagaReadback | null>;
  close(): Promise<void>;
}>;

/**
 * One shared-unless-owner primitive: both the mounted Chat runtime authority
 * and the Game authority are constructed over the same provision and the same
 * Windows root mutex/broker. The owner exposes only the existing narrow
 * Chat/Game authority surfaces plus its own idempotent close; it never
 * delegates a provision, store, mutex or raw broker. Either projection's close
 * drains/rejects only its own operations; the shared provision and
 * mutex/broker close solely through the owner close.
 */
export type SharedSemanticProductionAuthority = Readonly<{
  chat: SemanticChatRuntimeProductionAuthority;
  game: SemanticGameProductionAuthority;
  close(): Promise<void>;
}>;

/** Construction-zone-only S4d Game authority. It never exposes a store, mutex, or provision. */
export type SemanticGameProductionAuthority = Readonly<{
  authority: "SEMANTIC";
  prepareEnter(facts: GameEffectFacts): Promise<ProductionGamePermit>;
  commitEnter(permit: ProductionGamePermit, receipt: ProductionGameTerminalReceipt): Promise<LiveSemanticGame>;
  failEnter(permit: ProductionGamePermit): Promise<ProductionGameReadback>;
  prepareClose(live: LiveSemanticGame): Promise<ProductionGamePermit>;
  commitClose(
    live: LiveSemanticGame,
    permit: ProductionGamePermit,
    receipt: ProductionGameTerminalReceipt,
  ): Promise<ProductionGameReadback>;
  failClose(live: LiveSemanticGame, permit: ProductionGamePermit): Promise<ProductionGameReadback>;
  /** Explicit, dead-owner-only recovery. The caller supplies no owner, proof, or permit. */
  recoverDeadOwner(
    input: Readonly<{ request: "recover_dead_owner"; operationId: string }>,
  ): Promise<ProductionGameReadback>;
  /** design/105 Slice 0: owner-free durable Game session metadata, forwarded under this authority's mutex. */
  createGameSessionMetadata(input: ProductionGameSessionCreateInput): Promise<ProductionGameSessionMetadata>;
  completeGameSessionBinding(input: ProductionGameSessionBindingInput): Promise<ProductionGameSessionMetadata>;
  failGameSessionCreation(input: ProductionGameSessionBindingInput): Promise<ProductionGameSessionMetadata>;
  readGameSessionMetadata(input: Readonly<{ gameSessionId: string }>): Promise<ProductionGameSessionMetadata | null>;
  listResumableGameSessions(): Promise<readonly ProductionGameSessionMetadata[]>;
  registerGameSessionWorldBinding(
    input: ProductionGameSessionWorldBindingInput,
  ): Promise<ProductionGameSessionWorldBinding>;
  readGameSessionWorldBinding(
    input: Readonly<{ gameSessionId: string; integrationId: string }>,
  ): Promise<ProductionGameSessionWorldBinding | null>;
  markGameSessionWorldBindingTerminal(
    input: ProductionGameSessionWorldBindingTerminalInput,
  ): Promise<ProductionGameSessionWorldBinding>;
  /**
   * design/105 Slice 0 world-slot surface, projected exactly like the members
   * above. The read hands back whatever holder the store has, including the
   * handle a release demands; the release forwards the caller's holder handle
   * and its correlated native-lease proof unchanged. Neither invents, derives,
   * defaults or substitutes a handle, and a store refusal reaches the caller as
   * its own bounded code rather than a generic error or a falsy return.
   */
  readGameSessionWorldBindingSlotHolder(
    input: Readonly<{ integrationId: string; bindingRef: string }>,
  ): Promise<ProductionGameSessionWorldBindingSlotHolder | null>;
  releaseGameSessionWorldBindingSlot(
    input: ProductionGameSessionWorldBindingSlotReleaseInput,
  ): Promise<ProductionGameSessionWorldBinding>;
  close(): Promise<void>;
}>;
/** Only the S4 construction zone may supply facts drawn from its active binding execution. */
export type GameEffectFacts = Readonly<{
  world: ProductionGameWorld;
  bindingDigest: string;
  owner: ProductionGameOwner;
}>;
/** Opaque live-runtime record: only commitEnter can mint it, and only prepare/terminal close can consume it. */
export type LiveSemanticGame = Readonly<{ readonly __liveSemanticGame: unique symbol }>;
const liveGames = new WeakMap<
  object,
  Readonly<{
    operationId: string;
    gameSessionId: string;
    facts: GameEffectFacts;
    vector: ProductionGameReadback["vector"];
  }>
>();
type LiveGameRecord = Readonly<{
  operationId: string;
  gameSessionId: string;
  facts: GameEffectFacts;
  vector: ProductionGameReadback["vector"];
}>;

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  for (let current: object | null = value as object; current !== null; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "then");
    if (!descriptor) continue;
    return "value" in descriptor ? typeof descriptor.value === "function" : true;
  }
  return false;
}

function createDialogueSagaHolder(p: FreshContinuityProvision): DialogueSagaHolder {
  const holder = Object.freeze({});
  const facts: SagaFacts = Object.freeze({
    principal: p.principal,
    bootstrapOperationId: p.bootstrapOperationId,
    authorityGeneration: p.authorityGeneration,
    storeId: p.storeId,
    schemaVersion: p.schemaVersion,
    authorityRootIdentity: p.authorityRootIdentity,
  });
  const digest = p.authorityRootIdentity;
  brands.set(
    holder,
    Object.freeze({
      digest,
      operations: Object.freeze(
        ["claim_empty", "register_exact", "verify_exact_content", "select_open"].map(
          (step) => `${digest.slice(0, 16)}-${step}`,
        ),
      ),
      facts,
    }),
  );
  return holder;
}
function brand(holder: DialogueSagaHolder): Brand {
  const result = brands.get(holder);
  if (!result) throw new SemanticProductionCoordinatorError("semantic_production_saga_holder_rejected");
  return result;
}

/**
 * Installs the reviewed default companion (琥珀 / Kohaku) on the FIRST creation
 * of a fresh runtime root, before any surface reads `identity-profile.json` or
 * creates its initial Chat thread.
 *
 * Only the `fresh` provisioning branch calls this: a `known` open means the root
 * already exists, so the seed is a no-op there by construction and a player's
 * later edits are never overwritten (see `default-companion-seed.ts`).
 */
async function seedDefaultCompanionForFreshRoot(manifest: HostDeploymentManifest): Promise<void> {
  await seedDefaultCompanionIntoFreshRuntimeRoot(
    Object.freeze({
      continuityId: manifest.principal.continuityId,
      companionId: manifest.principal.companionId,
      playerId: manifest.principal.playerId,
    }),
    manifest.runtimeRoot,
  );
}

/**
 * The sole production constructor. It owns the genuine Windows broker and
 * root adapter; callers can provide only a deployment manifest already parsed
 * by the deployment boundary, never a mutex, store, provision, or holder.
 */
export async function createFreshSemanticProductionAuthorityFromDeploymentManifest(
  manifest: HostDeploymentManifest,
): Promise<SemanticProductionAuthority> {
  return createSemanticProductionAuthorityFromDeploymentManifest(manifest, "fresh");
}

/**
 * Internal, unmounted Chat composition. The manifest is the sole deployment
 * selection boundary; every binding, authority, mutex, request fact and
 * materializer is constructed here and is never caller-injectable.
 */
export async function createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(
  manifest: HostDeploymentManifest,
  options: SemanticChatRuntimeMountOptions = {},
): Promise<SemanticChatRuntimeProductionAuthority> {
  const input: FreshContinuityProvisionOptions = Object.freeze({
    runtimeCwd: manifest.runtimeRoot,
    principal: Object.freeze({ ...manifest.principal }),
    bootstrapOperationId: manifest.bootstrapOperationId,
    authorityGeneration: manifest.authorityGeneration,
  });
  const broker = new WindowsNamedMutexBroker();
  const mutex = createWindowsAuthorityRootMutex(broker);
  let provision: FreshContinuityProvision | undefined;
  let semantic: SemanticProductionAuthority | undefined;
  let binding: Awaited<ReturnType<typeof createChatRuntimeBinding>> | undefined;
  try {
    const admission = createCanonicalProductionAuthorityAdmission(input.runtimeCwd);
    provision = await openProvisionWithAdmission(
      () => provisionFreshProductionContinuityFromCanonicalAdmission(input, admission),
      admission.authorityRootIdentity,
      mutex,
    );
    await seedDefaultCompanionForFreshRoot(manifest);
    semantic = create(provision, mutex);
    await initializeInitialChatAndCloseContentPort(semantic, manifest);
    binding = await createChatRuntimeBinding(manifest);
    return createFreshChatRuntimeAuthority(provision, semantic, binding, mutex, broker, options, false, manifest);
  } catch (error) {
    try {
      await binding?.close();
    } catch {
      /* preserve construction failure */
    }
    try {
      await semantic?.close();
    } catch {
      provision?.close();
    }
    if (semantic === undefined && provision !== undefined) {
      try {
        provision.close();
      } catch {
        /* preserve construction failure */
      }
    }
    await closeOwnedMutex(mutex, broker).catch(() => undefined);
    throw error;
  }
}

/**
 * Known-root successor Chat composition. Opens only an exact already-bootstrapped
 * authority root, derives the current exact active Chat internally, writes the
 * single same-selection successor bridge, then mounts the successor runtime
 * through the existing terminal-teardown successor admission. It never
 * provisions fresh roots, creates Chat content, or touches a live runtime's
 * teardown authority: a pending/recovery runtime or an absent terminal
 * teardown fails closed with no lease and no runtime started.
 */
export async function createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(
  manifest: HostDeploymentManifest,
  options: SemanticChatRuntimeMountOptions = {},
): Promise<SemanticChatRuntimeProductionAuthority> {
  const input: FreshContinuityProvisionOptions = Object.freeze({
    runtimeCwd: manifest.runtimeRoot,
    principal: Object.freeze({ ...manifest.principal }),
    bootstrapOperationId: manifest.bootstrapOperationId,
    authorityGeneration: manifest.authorityGeneration,
  });
  const broker = new WindowsNamedMutexBroker();
  const mutex = createWindowsAuthorityRootMutex(broker);
  let provision: FreshContinuityProvision | undefined;
  let semantic: SemanticProductionAuthority | undefined;
  let binding: Awaited<ReturnType<typeof createChatRuntimeBinding>> | undefined;
  try {
    const admission = createCanonicalProductionAuthorityAdmission(input.runtimeCwd);
    provision = await openProvisionWithAdmission(
      () => openKnownProductionContinuityFromCanonicalAdmission(input, admission),
      admission.authorityRootIdentity,
      mutex,
    );
    semantic = create(provision, mutex);
    // Binding construction is non-durable; complete it before minting the
    // durable successor bridge so a failed owner-proof check cannot orphan one.
    binding = await createChatRuntimeBinding(manifest);
    await semantic.reselectTerminalChatRuntimeSuccessor();
    return createFreshChatRuntimeAuthority(provision, semantic, binding, mutex, broker, options, false, manifest);
  } catch (error) {
    try {
      await binding?.close();
    } catch {
      /* preserve construction failure */
    }
    try {
      await semantic?.close();
    } catch {
      provision?.close();
    }
    if (semantic === undefined && provision !== undefined) {
      try {
        provision.close();
      } catch {
        /* preserve construction failure */
      }
    }
    await closeOwnedMutex(mutex, broker).catch(() => undefined);
    throw error;
  }
}

/** Explicit Dialogue-only recovery constructor. It never probes or falls back to fresh provision. */
export async function createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest(
  manifest: HostDeploymentManifest,
): Promise<SemanticProductionAuthority> {
  return createSemanticProductionAuthorityFromDeploymentManifest(manifest, "known");
}

/**
 * S4d's known-open Game authority. It owns the fresh provision and short
 * Windows mutex sections but exposes neither; callers receive only internal
 * prepare/terminal operations. It cannot create or adopt an authority.
 */
export async function createKnownSemanticGameProductionAuthorityFromDeploymentManifest(
  manifest: HostDeploymentManifest,
): Promise<SemanticGameProductionAuthority> {
  const input: FreshContinuityProvisionOptions = Object.freeze({
    runtimeCwd: manifest.runtimeRoot,
    principal: Object.freeze({ ...manifest.principal }),
    bootstrapOperationId: manifest.bootstrapOperationId,
    authorityGeneration: manifest.authorityGeneration,
  });
  const broker = new WindowsNamedMutexBroker();
  const mutex = createWindowsAuthorityRootMutex(broker);
  try {
    const admission = createCanonicalProductionAuthorityAdmission(input.runtimeCwd);
    const provision = await openProvisionWithAdmission(
      () => openKnownProductionContinuityFromCanonicalAdmission(input, admission),
      admission.authorityRootIdentity,
      mutex,
    );
    return createKnownGameAuthority(
      provision,
      mutex,
      createOwnedMutexCloser(mutex, broker),
      createWindowsOwnerDeathVerifier(),
    );
  } catch (error) {
    await closeOwnedMutex(mutex, broker);
    throw error;
  }
}

/**
 * Shared Chat/Game semantic authority factory. The manifest is the sole
 * deployment selection boundary; both projections share one provision and one
 * Windows root mutex/broker. The Chat side is the real mounted Chat runtime
 * authority (`startMountedChatRuntime`), constructed over the same provision,
 * the shared store projection, and its own runtime binding. `fresh` provisions
 * the root and initializes the initial Chat exactly like the standalone fresh
 * Chat constructor; `known` reuses the standalone known-root successor wiring
 * (`reselectTerminalChatRuntimeSuccessor`). Projection close never closes the
 * shared provision/mutex; only the returned owner close drains the Game
 * projection, the Chat runtime projection, and then the single provision and
 * mutex/broker in that order.
 */
export async function createSharedSemanticProductionAuthorityFromDeploymentManifest(
  manifest: HostDeploymentManifest,
  mode: "fresh" | "known",
  options: SemanticChatRuntimeMountOptions = {},
): Promise<SharedSemanticProductionAuthority> {
  const input: FreshContinuityProvisionOptions = Object.freeze({
    runtimeCwd: manifest.runtimeRoot,
    principal: Object.freeze({ ...manifest.principal }),
    bootstrapOperationId: manifest.bootstrapOperationId,
    authorityGeneration: manifest.authorityGeneration,
  });
  const broker = new WindowsNamedMutexBroker();
  const mutex = createWindowsAuthorityRootMutex(broker);
  let provision: FreshContinuityProvision | undefined;
  let semantic: SemanticProductionAuthority | undefined;
  let binding: Awaited<ReturnType<typeof createChatRuntimeBinding>> | undefined;
  let chat: SemanticChatRuntimeProductionAuthority | undefined;
  let game: SemanticGameProductionAuthority | undefined;
  try {
    const admission = createCanonicalProductionAuthorityAdmission(input.runtimeCwd);
    provision = await openProvisionWithAdmission(
      () =>
        mode === "fresh"
          ? provisionFreshProductionContinuityFromCanonicalAdmission(input, admission)
          : openKnownProductionContinuityFromCanonicalAdmission(input, admission),
      admission.authorityRootIdentity,
      mutex,
    );
    // Shared projections intentionally do not close the provision/mutex: an
    // explicit shared-ownership close flag suppresses those in each helper.
    semantic = create(provision, mutex, undefined, true);
    game = createKnownGameAuthority(provision, mutex, undefined, createWindowsOwnerDeathVerifier(), true);
    if (mode === "fresh") {
      await seedDefaultCompanionForFreshRoot(manifest);
      await initializeInitialChatAndCloseContentPort(semantic, manifest);
      binding = await createChatRuntimeBinding(manifest);
    } else {
      // Known Chat is mounted as the terminal successor exactly like the
      // standalone known Chat runtime constructor; it never adopts a live Chat.
      binding = await createChatRuntimeBinding(manifest);
      await semantic.reselectTerminalChatRuntimeSuccessor();
    }
    // The real mounted runtime projection shares the provision/mutex/broker;
    // its own close tears down the runtime and closes its Chat binding and
    // drain-only store projection, leaving shared resources for the owner.
    chat = await createFreshChatRuntimeAuthority(provision, semantic, binding, mutex, broker, options, true, manifest);
    binding = undefined;
    return createSharedSemanticProductionAuthorityOwner(chat, game, provision, mutex, broker);
  } catch (error) {
    try {
      await binding?.close();
    } catch {
      /* preserve construction failure */
    }
    try {
      await chat?.close();
    } catch {
      /* preserve construction failure */
    }
    try {
      await semantic?.close();
    } catch {
      /* preserve construction failure */
    }
    try {
      await game?.close();
    } catch {
      /* preserve construction failure */
    }
    provision?.close();
    await closeOwnedMutex(mutex, broker).catch(() => undefined);
    throw error;
  }
}

function createSharedSemanticProductionAuthorityOwner(
  chat: SemanticChatRuntimeProductionAuthority,
  game: SemanticGameProductionAuthority,
  provision: FreshContinuityProvision,
  mutex: WindowsAuthorityRootMutex,
  broker: WindowsNamedMutexBroker,
): SharedSemanticProductionAuthority {
  let closePromise: Promise<void> | undefined;
  let chatClosed = false;
  let gameClosed = false;
  let provisionClosed = false;
  let mutexClosed = false;
  let brokerClosed = false;
  let terminalError: unknown;
  return Object.freeze({
    chat,
    game,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      const attempt = (async () => {
        // Drain both projections first. A projection closed earlier is closed
        // again here safely because its own close is memoized. Game is closed
        // before Chat so a live Game runtime (whose close refuses by design)
        // leaves Chat open and usable while the owner close stays retryable.
        if (!gameClosed) {
          await game.close();
          gameClosed = true;
        }
        if (!chatClosed) {
          await chat.close();
          chatClosed = true;
        }
        // Only the owner closes the one shared provision and mutex/broker.
        if (!provisionClosed) {
          provision.close();
          provisionClosed = true;
        }
        if (!mutexClosed) {
          await mutex.close();
          mutexClosed = true;
        }
        if (!brokerClosed) {
          try {
            await broker.close();
          } catch (error) {
            if (isTerminalBrokerCloseError(error)) terminalError = error;
            throw error;
          }
          brokerClosed = true;
        }
      })();
      closePromise = attempt;
      void attempt.catch((error) => {
        if (terminalError === undefined && !isTerminalBrokerCloseError(error)) closePromise = undefined;
      });
      return attempt;
    },
  });
}

async function createFreshChatRuntimeAuthority(
  provision: FreshContinuityProvision,
  semantic: SemanticProductionAuthority,
  binding: Awaited<ReturnType<typeof createChatRuntimeBinding>>,
  mutex: WindowsAuthorityRootMutex,
  broker: WindowsNamedMutexBroker,
  options: SemanticChatRuntimeMountOptions,
  sharedOwnerClose: boolean,
  manifest: HostDeploymentManifest,
): Promise<SemanticChatRuntimeProductionAuthority> {
  let pending = 0;
  let closing = false;
  let closed = false;
  type LiveChatRuntimeRecord = {
    readonly bootstrapPermit: import("../continuity-semantic-store/continuity-semantic-production-store.js").ProductionChatRuntimePermit;
    readonly bootstrapReceipt: ProductionChatRuntimeReceipt;
    readonly runtime: MaterializedChatRuntime;
    vector: ProductionChatRuntimeReadback["vector"];
    teardownPermit?: ProductionChatRuntimeTeardownPermit;
    teardownReceipt?: ProductionChatRuntimeTeardownReceipt;
    physicallyClosed: boolean;
  };
  const liveByBootstrapOperation = new Map<string, LiveChatRuntimeRecord>();
  let startPromise: Promise<ProductionChatRuntimeReadback> | undefined;
  let mountedStartPromise: Promise<MountedChatRuntimeLease> | undefined;
  let mountedLease: MountedChatRuntimeLease | undefined;
  /**
   * Every lease this authority has minted, current or already superseded by an
   * in-process turn-level switch. Its `close()` closes the authority's mounted
   * Chat lane, so a stale lease must still be able to shut the lane down.
   */
  const issuedLeases = new WeakSet<object>();
  let closePromise: Promise<void> | undefined;
  let terminalError: unknown;
  let bindingClosed = false;
  let semanticClosed = false;
  let mutexClosed = false;
  let brokerClosed = false;
  let authority!: SemanticChatRuntimeProductionAuthority;

  /**
   * The one Chat-owned store for this mounted authority. Reads under the mount
   * share it, so a long-lived mount holds one SQLite connection rather than one
   * per read. It is opened lazily by the first read and closed with the other
   * drained resources at the end of `close()`.
   *
   * The accessor refuses once close has begun, which is why in-flight reads fail
   * closed rather than racing a connection that is about to disappear.
   */
  let mountedChatThreadStore: import("../tavern/chat-thread-store.js").ChatThreadStore | undefined;
  let mountedChatThreadStoreClosed = false;
  const mountedStore = (): import("../tavern/chat-thread-store.js").ChatThreadStore => {
    if (mountedChatThreadStoreClosed)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_authority_closed");
    mountedChatThreadStore ??= createChatThreadStore(
      provision.runtimeCwd,
      identityKey(Object.freeze({ ...provision.principal })),
    );
    return mountedChatThreadStore;
  };
  const drainWaiters = new Set<() => void>();
  const waitForDrain = (): Promise<void> =>
    pending === 0 ? Promise.resolve() : new Promise((resolve) => drainWaiters.add(resolve));
  const begin = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing || closed)
      return Promise.reject(new SemanticProductionCoordinatorError("semantic_chat_runtime_authority_closed"));
    pending += 1;
    return work().finally(() => {
      pending -= 1;
      if (pending === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    });
  };
  const locked = async <T>(work: () => T): Promise<T> => {
    const lease = await requireLease(mutex, provision.authorityRootIdentity, provision, () => {
      closing = true;
    });
    let value: T | undefined;
    let failure: unknown;
    try {
      value = work();
      if (isThenable(value)) throw new SemanticProductionCoordinatorError("async_partition_mutex_section_rejected");
    } catch (error) {
      failure = error;
    }
    try {
      await release(lease);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
    return value as T;
  };

  /**
   * One mounted runtime's durable and physical teardown: prepare the teardown
   * under the partition mutex, close every runtime resource in reverse order,
   * then commit the terminal teardown that advances the vector the successor
   * mount's select bridge consumes. Used both by the authority's terminal close
   * and by an in-process turn-level Chat switch, which leaves the authority,
   * its binding, store, mutex and broker open.
   */
  const tearDownChatRuntimeRecord = async (record: LiveChatRuntimeRecord): Promise<void> => {
    if (!record.teardownPermit) {
      const request: ProductionChatRuntimeTeardownRequest = Object.freeze({
        principal: provision.principal,
        operationId: `chat-teardown-${randomUUID().replaceAll("-", "")}`,
        requestId: `chat-teardown-request-${randomUUID().replaceAll("-", "")}`,
        bootstrapOperationId: record.bootstrapPermit.operationId,
        chatThreadId: record.bootstrapPermit.chatThreadId,
        chatSurfaceSessionId: record.bootstrapPermit.chatSurfaceSessionId,
        runtimeBindingDigest: record.bootstrapPermit.runtimeBindingDigest,
        owner: record.bootstrapPermit.owner,
        deadlineAtMs: Date.now() + 30_000,
        expected: { ...record.vector },
      });
      const prepared = await locked(() => provision.store.prepareChatRuntimeTeardown(request));
      if (prepared.outcome === "completed") {
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_teardown_runtime_record_mismatch");
      }
      if (prepared.outcome !== "effect_owned" || prepared.permit === null) {
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_teardown_not_effect_owned");
      }
      record.teardownPermit = prepared.permit;
    }
    if (!record.physicallyClosed) {
      await record.runtime.close();
      record.physicallyClosed = true;
    }
    if (!record.teardownReceipt) {
      const permit = record.teardownPermit;
      if (!permit) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_teardown_permit_missing");
      record.teardownReceipt = Object.freeze({
        kind: "chat_runtime_torn_down" as const,
        operationId: permit.operationId,
        requestId: permit.requestId,
        bootstrapOperationId: permit.bootstrapOperationId,
        chatThreadId: permit.chatThreadId,
        chatSurfaceSessionId: permit.chatSurfaceSessionId,
        runtimeBindingDigest: permit.runtimeBindingDigest,
        owner: Object.freeze({ ...permit.owner }),
        fenceToken: permit.fenceToken,
        occurredAtMs: Date.now(),
      });
    }
    const permit = record.teardownPermit;
    const receipt = record.teardownReceipt;
    if (!permit || !receipt)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_teardown_evidence_missing");
    const terminal = await locked(() =>
      provision.store.commitChatRuntimeTeardown(Object.freeze({ principal: provision.principal, permit, receipt })),
    );
    if (terminal.status !== "terminal" || terminal.runtimeState !== "closed")
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_teardown_not_terminal");
    liveByBootstrapOperation.delete(record.bootstrapPermit.operationId);
  };

  /** True while the mounted runtime serves a turn that has not reached a terminal ledger state. */
  const mountedLeaseHasTurnInFlight = async (record: MountedChatRuntimeLeaseRecord): Promise<boolean> => {
    if (record.activePrompt !== undefined) return true;
    if (record.attemptBinding === undefined) return false;
    const state = await record.store().resumeThread(record.chatThreadId, record.chatSurfaceSessionId);
    return state.turnLedger !== null && !isTerminalTurnStatusForCoordinator(state.turnLedger.status);
  };

  /**
   * Exactly the durable states the mounted cancel seam can terminalize: an
   * armed prompt, or a generating/presented turn. `accepted_queued` and a claim
   * whose attempt never reached an observation are not cancellable as they
   * stand - the seam's exact-attempt CAS needs a durable `armed` observation -
   * so a focus transfer prepares those two to `armed` first instead of leaving
   * the mount held by a turn with nothing running. A claim that recorded a
   * pre-invocation `not_started` is not cancellable here either, but it is
   * already terminalized directly by the same preparation.
   */
  const isMountedTurnCancellable = async (record: MountedChatRuntimeLeaseRecord): Promise<boolean> => {
    const ledger = (await record.store().resumeThread(record.chatThreadId, record.chatSurfaceSessionId)).turnLedger;
    if (ledger === null) return false;
    if (ledger.status === "running" || ledger.status === "presentation_committed") return true;
    return ledger.status === "attempt_starting" && ledger.observation?.phase === "armed";
  };

  /**
   * ADR-0010. A durable mounted turn with nothing running must not hold the
   * mount, and exactly three shapes reach that state: a turn the player's message
   * made durable but that was never scheduled (no attempt at all), a durable
   * claim whose attempt never reached an observation (the arm step never landed
   * because the process died there, or its start reservation was released), and a
   * claim whose attempt recorded `not_started` (the pre-invocation linearization
   * revoked its admission or expired its deadline, so no prompt ever began).
   *
   * None has a running Pi prompt. The first two are driven to the cancel seam's
   * exact `armed` source through the mounted authority's own transitions: the
   * claim the start itself would have made, then the last durable step before the
   * single Host invocation. The third already carries its own pre-invocation
   * proof, so it is terminalized by the same ordinary turn-level cancel directly
   * - re-arming it would fabricate an `armed` observation for a turn that proved
   * it never armed. Arming a turn whose live start runner is also arming only
   * decides that race in favour of the player's switch: the abort below stays the
   * ordinary one, so a prompt that was invoked anyway is aborted by the durable
   * cancel winner and the mounted session, never killed silently.
   */
  const prepareMountedTurnForChatSelection = async (record: MountedChatRuntimeLeaseRecord): Promise<void> => {
    const lease = mountedLease;
    if (lease === undefined || record.attemptBinding === undefined) return;
    const store = record.store();
    const readTurnLedger = async (): Promise<import("../tavern/chat-thread-store.js").ChatTurnLedger | null> =>
      (await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId)).turnLedger;
    let turn = await readTurnLedger();
    if (turn === null || isTerminalTurnStatusForCoordinator(turn.status)) return;
    if (turn.status === "accepted_queued") {
      try {
        await claimMountedAttempt(manifest, lease, (admission) =>
          consumeMountedAttemptAdmission(admission, (facts) => claimStoreMountedAttempt(facts)),
        );
      } catch {
        // A concurrent claim leaves the same durable shape this preparation
        // needs, and the durable read below is the only authority on it.
      }
      turn = await readTurnLedger();
    }
    if (turn === null || turn.status !== "attempt_starting") return;
    if (turn.observation !== undefined && turn.observation.phase !== "not_started") return;
    const operationAuthority = record.transitionAuthority.mintOperation();
    try {
      const atMs = Date.now();
      await transitionMountedProviderStart(
        Object.freeze({
          authority: record.transitionAuthority.authority,
          operationAuthority: operationAuthority.authority,
          runtimeRoot: record.runtimeRoot,
          playerId: record.principal.playerId,
          companionId: record.principal.companionId,
          continuityId: record.principal.continuityId,
          chatThreadId: record.chatThreadId,
          chatSurfaceSessionId: record.chatSurfaceSessionId,
          selectionGeneration: turn.attempt.selectionGeneration,
          runtimeBindingDigest: turn.attempt.runtimeBindingDigest,
          runtimeOwner: turn.attempt.runtimeOwner,
          attemptId: turn.attempt.attemptId,
        }),
        turn.observation === undefined
          ? Object.freeze({ operation: "arm", observedAtMs: atMs })
          : Object.freeze({ operation: "cancel", observedAtMs: atMs, cancelledAtMs: atMs }),
      );
    } finally {
      operationAuthority.revoke();
    }
  };

  /**
   * Class A abort for a focus transfer (ADR-0010). It reuses the one existing
   * cancel path - the same seam an authenticated browser Stop reaches - so the
   * presentation epoch is revoked, the exact durable cancel CAS wins, and the
   * one mounted Pi prompt is aborted. It then waits only for that prompt's own
   * runner to settle the ledger, because the transition authority is revoked
   * when the mount is released and a revoked authority can no longer terminalize
   * the turn. Whatever the turn had already committed stays durably stored as
   * the interrupted turn's presentation; only never-committed preview deltas are
   * discarded.
   */
  const abortMountedTurnForChatSelection = async (record: MountedChatRuntimeLeaseRecord): Promise<void> => {
    const lease = mountedLease;
    if (lease === undefined) return;
    if (await isMountedTurnCancellable(record))
      await stopMountedChatPresentationEpoch(manifest, lease, {
        stopId: `chat_select_stop_${randomUUID().replaceAll("-", "")}`,
        sourceEventId: `chat_select_source_${randomUUID().replaceAll("-", "")}`,
        reasonCode: "player_chat_select",
      });
    // A turn already terminalized above can still have its prompt draining, and
    // the exact prompt the cancel claim won is settled by its own runner; the
    // release revokes the transition authority, so wait for that settlement
    // before the mount is torn down under it.
    await waitForMountedPromptSettlement(record);
  };

  /**
   * Releases the one mounted runtime in process so a different Chat can be
   * mounted by the same authority. The mounted lease is revoked synchronously
   * first, so no new turn can be admitted while the teardown runs. A caller that
   * is switching Chat (ADR-0010) has already prepared and aborted any durable
   * turn through the cancel seam and waited for it to settle, so the lease is
   * releasable; a turn this seam cannot reach is restored untouched and reported
   * as the bounded residual `turn_in_flight`.
   */
  const releaseMountedChatRuntime = async (): Promise<"released" | "turn_in_flight"> => {
    const lease = mountedLease;
    const record = lease === undefined ? undefined : mountedChatRuntimeLeases.get(lease);
    if (record !== undefined && record.active) {
      record.active = false;
      if (await mountedLeaseHasTurnInFlight(record)) {
        record.active = true;
        return "turn_in_flight";
      }
      record.transitionAuthority.revoke();
    }
    const live = [...liveByBootstrapOperation.values()][0];
    if (live !== undefined) await tearDownChatRuntimeRecord(live);
    mountedLease = undefined;
    mountedStartPromise = undefined;
    startPromise = undefined;
    return "released";
  };

  const startChatRuntime = (): Promise<ProductionChatRuntimeReadback> => {
    if (startPromise) return startPromise;
    startPromise = begin(async () => {
      // ADR 0009: the recorded expectation is settled before anything of this
      // mount is prepared, so the runtime mounts the Chat the player asked for.
      await settleExpectedChatSelection();
      let reservation:
        | import("../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js").ReservedChatRuntimeMaterialization
        | undefined;
      let permit:
        | import("../continuity-semantic-store/continuity-semantic-production-store.js").ProductionChatRuntimePermit
        | undefined;
      try {
        await binding.executeWithBinding((token: OpaqueChatRuntimeBindingToken) =>
          withConsumedChatRuntimeBinding(token, (execution) => {
            reservation = reserveChatRuntimeMaterialization(execution);
          }),
        );
        if (!reservation) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_reservation_missing");
        const facts = readReservedChatRuntimeMaterializationFacts(reservation);
        const prepared = await locked(() => {
          const catalog = provision.store.readChatCatalog();
          const selected = catalog.activeSelection;
          if (!selected) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_selection_missing");
          const request: ProductionChatRuntimeRequest = Object.freeze({
            principal: provision.principal,
            operationId: `chat-runtime-${randomUUID().replaceAll("-", "")}`,
            requestId: `chat-request-${randomUUID().replaceAll("-", "")}`,
            chatThreadId: selected.chatThreadId,
            chatSurfaceSessionId: selected.chatSurfaceSessionId,
            runtimeBindingDigest: facts.runtimeBindingDigest,
            owner: Object.freeze({ ...facts.owner }) as ProductionChatRuntimeOwner,
            deadlineAtMs: Date.now() + CHAT_RUNTIME_BOOTSTRAP_MATERIALIZATION_DEADLINE_MS,
            // Freeze the request boundary, but keep the exact copied vector writable for
            // the store's caller-ingress descriptor contract.
            expected: { ...catalog.vector },
          });
          return provision.store.prepareChatRuntime(request);
        });
        if (prepared.outcome !== "effect_owned" || prepared.permit === null) {
          releaseReservedChatRuntimeMaterialization(reservation);
          return prepared.readback;
        }
        permit = prepared.permit;
        let materialized: MaterializedChatRuntime;
        try {
          materialized = await createHostChatRuntimeMaterializer(
            Object.freeze({
              ...(options.tavernNarrativeGateNonceSha256 === undefined
                ? {}
                : { tavernNarrativeGateNonceSha256: options.tavernNarrativeGateNonceSha256 }),
            }),
          ).materialize(reservation, permit);
        } catch (error) {
          await failChatRuntimeAfterError(locked, provision, permit, error);
          throw error;
        }
        reservation = undefined;
        let committed: ProductionChatRuntimeReadback;
        try {
          committed = await locked(() =>
            provision.store.commitChatRuntime(
              Object.freeze({ principal: provision.principal, permit: permit!, receipt: materialized.receipt }),
            ),
          );
        } catch (error) {
          await closeAndFailChatRuntime(locked, provision, permit, materialized, error);
          throw error;
        }
        if (
          committed.status !== "terminal" ||
          committed.runtimeState !== "active" ||
          committed.operationId !== permit.operationId ||
          committed.requestId !== permit.requestId ||
          committed.chatThreadId !== materialized.receipt.chatThreadId ||
          committed.chatSurfaceSessionId !== materialized.receipt.chatSurfaceSessionId ||
          committed.receipt === null ||
          committed.receipt.kind !== "chat_runtime_bootstrapped" ||
          committed.receipt.operationId !== materialized.receipt.operationId ||
          committed.receipt.requestId !== materialized.receipt.requestId ||
          committed.receipt.chatThreadId !== materialized.receipt.chatThreadId ||
          committed.receipt.chatSurfaceSessionId !== materialized.receipt.chatSurfaceSessionId
        ) {
          const error = new SemanticProductionCoordinatorError("semantic_chat_runtime_not_active");
          await closeAndFailChatRuntime(locked, provision, permit, materialized, error);
          throw error;
        }
        liveByBootstrapOperation.set(permit.operationId, {
          bootstrapPermit: permit,
          bootstrapReceipt: materialized.receipt,
          runtime: materialized,
          vector: committed.vector,
          physicallyClosed: false,
        });
        return committed;
      } finally {
        if (reservation) releaseReservedChatRuntimeMaterialization(reservation);
      }
    });
    return startPromise;
  };
  function mintChatSelectionIdentity(): Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }> {
    const suffix = randomUUID().replaceAll("-", "");
    return Object.freeze({
      chatThreadId: `chat-${suffix.slice(0, 16)}`,
      chatSurfaceSessionId: `surface-${suffix.slice(16, 32)}`,
    });
  }
  /**
   * One settlement command id, derived from the exact committed vector and
   * target it runs against. A resumed settlement therefore reuses the id of the
   * step it already committed and can never mint a second command for it.
   */
  function chatSelectionOperationId(
    kind: "settle-register" | "settle-verify" | "settle-select",
    catalog: ProductionChatCatalog,
    target: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>,
  ): string {
    const suffix = createHash("sha256")
      .update(
        `${provision.authorityRootIdentity}\u0000${kind}\u0000${catalog.vector.partitionRevision}\u0000${catalog.vector.fenceEpoch}\u0000${catalog.vector.selectionRevision}\u0000${target.chatThreadId}\u0000${target.chatSurfaceSessionId}`,
      )
      .digest("hex");
    return `chat-${kind}-${suffix.slice(0, 32)}`;
  }
  /**
   * Proves the exact Tavern content behind a not-yet-registered selection target
   * exists, so the settlement cannot become the thing that creates a conversation
   * the player never had. It reads through this authority's own Chat thread store:
   * a second store opened on the same root/continuity key takes over the mounted
   * runtime's route registrations and detaches them when it closes, so a live
   * turn's own cancel path must never be shadowed by another connection.
   */
  async function assertSelectTargetContentExists(
    target: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>,
  ): Promise<void> {
    try {
      await mountedStore().resumeThread(target.chatThreadId, target.chatSurfaceSessionId);
    } catch (error) {
      // This thread with another Chat's surface session, or no such thread at
      // all, is the bounded refusal: only that exact pair may be registered by
      // the settlement. A genuine storage failure keeps its own error.
      if (error instanceof ExactThreadNotFoundError || error instanceof ExactThreadSurfaceMismatchError)
        throw new SemanticProductionCoordinatorError("semantic_chat_selection_conflict");
      throw error;
    }
  }
  /**
   * ADR 0009 / ADR-0010. The recorded expectation is durable and the request is
   * never refused for a generating turn: the one mounted runtime whose turn is
   * still in flight is aborted through the same cancel path an explicit browser
   * Stop uses, and a mounted turn with nothing running is prepared to exactly
   * that path first. The abort is allowed to settle, then the runtime is
   * released and the successor mount for the requested Chat is committed in this
   * same process. Only a mounted turn this authority cannot reach with that path
   * leaves the runtime where it is, and that is the bounded `turn_in_flight`.
   */
  const requestChatSelection = (input: SemanticChatSelectionRequest): Promise<SemanticChatSelectionOutcome> =>
    begin(async () => {
      const target =
        input?.kind === "select"
          ? Object.freeze({
              chatThreadId: input.chatThreadId,
              chatSurfaceSessionId: input.chatSurfaceSessionId,
            })
          : mintChatSelectionIdentity();
      // ADR 0009: a `select` names a Chat the player can reach, and the durable
      // authority only admits a `select` expectation for a Chat it already knows. A
      // Chat the product's New Chat creates is written to Tavern content and
      // registered nowhere, so it is not known here yet - while the pre-mount
      // settlement is the one window in which a registration may advance the
      // vector, because a mounted runtime forbids it (the teardown consumes the
      // runtime's own committed vector). That leaves exactly two halves:
      //
      // - the target's exact Tavern content must already exist. This runs BEFORE
      //   anything is released: the settlement runs after the release, so a target
      //   that could never be registered would otherwise leave the player with no
      //   mounted Chat at all. It is also what stops a request from fabricating a
      //   conversation, since the recorded shape below may create content the
      //   settlement does not find.
      // - the expectation is recorded in the settlement's own `create` shape, which
      //   is the durable shape for "a Chat only the settlement registers". The
      //   settlement registers that exact pair and verifies its Tavern content
      //   before the Chat can become active or be mounted, and a pair anything else
      //   already occupies is still refused by the authority.
      let intentKind: "create" | "select" = input?.kind === "select" ? "select" : "create";
      if (input?.kind === "select") {
        const unregistered = await locked(() => {
          const catalog = provision.store.readChatCatalog();
          if (
            !Number.isSafeInteger(input.selectionGeneration) ||
            input.selectionGeneration < 1 ||
            catalog.activeSelection?.selectionRevision !== input.selectionGeneration
          )
            throw new SemanticProductionCoordinatorError("semantic_chat_selection_generation_conflict");
          return !catalog.threads.some(
            (thread) =>
              thread.chatThreadId === target.chatThreadId &&
              thread.chatSurfaceSessionId === target.chatSurfaceSessionId,
          );
        });
        if (unregistered) {
          await assertSelectTargetContentExists(target);
          intentKind = "create";
        }
      }
      const mountedRecord = mountedLease === undefined ? undefined : mountedChatRuntimeLeases.get(mountedLease);
      await locked(() => {
        const catalog = provision.store.readChatCatalog();
        if (
          (input?.kind !== "create" && input?.kind !== "select") ||
          !Number.isSafeInteger(input.selectionGeneration) ||
          input.selectionGeneration < 1 ||
          catalog.activeSelection?.selectionRevision !== input.selectionGeneration
        )
          throw new SemanticProductionCoordinatorError("semantic_chat_selection_generation_conflict");
        try {
          provision.store.recordChatSelectionIntent(
            Object.freeze({
              intent: Object.freeze({ kind: intentKind, ...target }),
              expected: { ...catalog.vector },
            }),
          );
        } catch (error) {
          // A runtime transition in flight and a target the settlement could
          // never honour are the same product answer: this request conflicts
          // with the current selection state and changes nothing.
          if (
            error instanceof Error &&
            (error.message === "chat_selection_transition_in_flight" || error.message === "chat_selection_conflict")
          )
            throw new SemanticProductionCoordinatorError("semantic_chat_selection_conflict");
          throw error;
        }
      });
      // The runtime already serves the requested Chat: there is nothing to
      // release, and the recorded expectation is cleared by the next settlement.
      if (
        mountedRecord?.active === true &&
        mountedRecord.chatThreadId === target.chatThreadId &&
        mountedRecord.chatSurfaceSessionId === target.chatSurfaceSessionId
      )
        return Object.freeze({ status: "switched" as const, ...target });
      if (mountedRecord?.active === true && (await mountedLeaseHasTurnInFlight(mountedRecord))) {
        await prepareMountedTurnForChatSelection(mountedRecord);
        await abortMountedTurnForChatSelection(mountedRecord);
      }
      if ((await releaseMountedChatRuntime()) === "turn_in_flight")
        return Object.freeze({ status: "turn_in_flight" as const, ...target });
      await startMountedChatRuntime();
      return Object.freeze({ status: "switched" as const, ...target });
    });
  /**
   * ADR 0009 pre-mount settlement. It runs under the same mutex as the runtime
   * start and reuses the ordinary register/verify/select commands: a Chat the
   * player created is registered, its Tavern content is materialized outside the
   * semantic mutex through the manifest-derived content port (exactly as the
   * initial-Chat saga does), verified, selected, and the expectation is cleared.
   * The single `select_chat` bridge this leaves behind is the successor bridge
   * the store's admission demands; nothing here changes what the teardown or
   * successor comparisons read.
   */
  async function settleExpectedChatSelection(): Promise<void> {
    const pending = await locked(() => {
      const catalog = provision.store.readChatCatalog();
      const intent = catalog.expectedSelection;
      if (intent === null) return null;
      const target = Object.freeze({
        chatThreadId: intent.chatThreadId,
        chatSurfaceSessionId: intent.chatSurfaceSessionId,
      });
      const thread = catalog.threads.find(
        (candidate) =>
          candidate.chatThreadId === target.chatThreadId &&
          candidate.chatSurfaceSessionId === target.chatSurfaceSessionId,
      );
      if (thread?.contentState === "verified") {
        const active =
          catalog.activeSelection?.chatThreadId === target.chatThreadId &&
          catalog.activeSelection.chatSurfaceSessionId === target.chatSurfaceSessionId;
        if (!active)
          provision.store.selectChat(
            Object.freeze({
              operationId: chatSelectionOperationId("settle-select", catalog, target),
              chatThreadId: target.chatThreadId,
              chatSurfaceSessionId: target.chatSurfaceSessionId,
              expected: { ...catalog.vector },
            }),
          );
        provision.store.clearChatSelectionIntent(
          Object.freeze({ expected: { ...provision.store.readChatCatalog().vector } }),
        );
        return null;
      }
      if (thread) return null;
      provision.store.registerChat(
        Object.freeze({
          operationId: chatSelectionOperationId("settle-register", catalog, target),
          chatThreadId: target.chatThreadId,
          chatSurfaceSessionId: target.chatSurfaceSessionId,
          expected: { ...catalog.vector },
        }),
      );
      return Object.freeze({ kind: intent.kind, target });
    });
    if (pending === null) return;
    const receipt = await materializeExpectedChatContent(pending.kind, pending.target);
    await locked(() => {
      const registered = provision.store.readChatCatalog();
      provision.store.verifyChatContent(
        Object.freeze({
          operationId: chatSelectionOperationId("settle-verify", registered, pending.target),
          chatThreadId: pending.target.chatThreadId,
          chatSurfaceSessionId: pending.target.chatSurfaceSessionId,
          expected: { ...registered.vector },
        }),
        receipt,
      );
      const verified = provision.store.readChatCatalog();
      provision.store.selectChat(
        Object.freeze({
          operationId: chatSelectionOperationId("settle-select", verified, pending.target),
          chatThreadId: pending.target.chatThreadId,
          chatSurfaceSessionId: pending.target.chatSurfaceSessionId,
          expected: { ...verified.vector },
        }),
      );
      provision.store.clearChatSelectionIntent(
        Object.freeze({ expected: { ...provision.store.readChatCatalog().vector } }),
      );
    });
  }
  /**
   * The Tavern content behind the recorded expectation, materialized with the
   * semantic mutex released. Only a `create` may create missing content: a
   * `select` names a Chat whose content already exists, so any other readback
   * failure stays the failure it is.
   */
  async function materializeExpectedChatContent(
    kind: "create" | "select",
    target: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>,
  ): Promise<TavernExactContentReceipt> {
    const content = createManifestDerivedInitialChatExactContentPort(manifest);
    try {
      try {
        const resumed = await content.port.resumeExact(
          target.chatThreadId,
          provision.principal.companionId,
          provision.principal.continuityId,
          target.chatSurfaceSessionId,
        );
        if (!isTrustedTavernExactContentReceipt(resumed))
          throw new SemanticProductionCoordinatorError("untrusted_tavern_exact_content_receipt");
        return resumed;
      } catch (error) {
        if (
          kind !== "create" ||
          !(error instanceof TavernInitialChatExactContentPortError) ||
          error.code !== "chat_thread_not_found"
        )
          throw error;
        const created = await content.port.createExplicit(
          Object.freeze({
            chatThreadId: target.chatThreadId,
            companionId: provision.principal.companionId,
            continuityId: provision.principal.continuityId,
            chatSurfaceSessionId: target.chatSurfaceSessionId,
          }),
        );
        if (!isTrustedTavernExactContentReceipt(created))
          throw new SemanticProductionCoordinatorError("untrusted_tavern_exact_content_receipt");
        return created;
      }
    } finally {
      content.close();
    }
  }
  /**
   * Mints the mounted Chat runtime capability for the currently selected Chat.
   * The memoization lives for the life of one mount: an in-process turn-level
   * switch releases that mount and clears it, so the next call mints the
   * successor capability for the Chat the player selected.
   */
  const startMountedChatRuntime = (): Promise<MountedChatRuntimeLease> => {
    // This is a synchronous acceptance boundary. Once close begins, neither a
    // previously-created start promise nor an already-active runtime may mint
    // or return a mounted capability.
    if (closing || closed)
      return Promise.reject(new SemanticProductionCoordinatorError("semantic_chat_runtime_authority_closed"));
    if (mountedStartPromise !== undefined) return mountedStartPromise;
    mountedStartPromise = startChatRuntime().then((readback) => {
      // startChatRuntime may have been accepted before a concurrent close.
      // Recheck after its asynchronous work, immediately before lease minting.
      if (closing || closed) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_authority_closed");
      const record = liveByBootstrapOperation.get(readback.operationId);
      const runtimeSession = record?.runtime.runtimeSession;
      if (
        !record ||
        !runtimeSession ||
        readback.status !== "terminal" ||
        readback.runtimeState !== "active" ||
        readback.operationId !== record.bootstrapReceipt.operationId ||
        readback.requestId !== record.bootstrapReceipt.requestId ||
        readback.chatThreadId !== record.bootstrapReceipt.chatThreadId ||
        readback.chatSurfaceSessionId !== record.bootstrapReceipt.chatSurfaceSessionId
      )
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_mount_readback_rejected");
      // The live-gate-only reporter is emitted after the exact runtime has
      // been committed active but before the browser server can accept input.
      // Normal consumers still receive only the safe lease projection.
      //
      // The optional call is where two different worlds look identical: a runtime
      // built without a gate nonce has no reporter, and a runtime that has one but
      // cannot send says so on stderr. A reader looking only at the absent marker
      // cannot tell them apart, and "no marker" then reads as "the product never
      // reached the provider". This line separates them.
      if (runtimeSession.reportTavernNarrativeGateRuntime === undefined) {
        process.stderr.write("[tavern-gate] runtime marker unavailable: no_reporter\n");
      } else {
        runtimeSession.reportTavernNarrativeGateRuntime();
      }
      const browserProjection = createMountedChatBrowserProjection(
        readback.chatThreadId,
        readback.chatSurfaceSessionId,
        record.vector.selectionRevision,
      );
      let lease!: MountedChatRuntimeLease;
      lease = Object.freeze({
        // The lease exposes only profile metadata. The start runner gets the exact live
        // runtime solely from this module's private WeakMap record below.
        runtimeSession: Object.freeze({ profile: runtimeSession.profile }),
        chatThreadId: readback.chatThreadId,
        chatSurfaceSessionId: readback.chatSurfaceSessionId,
        browserProjection,
        async abortActivePrompt(
          this: unknown,
          expected: Readonly<{ turnId: string; attemptId: string }>,
        ): Promise<"aborted" | "not_active" | "mismatch"> {
          if (this !== lease || !isCurrentMountedChatRuntimeLease(lease))
            throw new SemanticProductionCoordinatorError("semantic_chat_runtime_lease_rejected");
          if (
            expected === null ||
            typeof expected !== "object" ||
            !/^[A-Za-z0-9_-]{1,128}$/u.test(expected.turnId) ||
            !/^[A-Za-z0-9_-]{1,128}$/u.test(expected.attemptId)
          )
            throw new SemanticProductionCoordinatorError("semantic_chat_runtime_abort_request_rejected");
          const leaseRecord = mountedChatRuntimeLeases.get(lease);
          if (leaseRecord === undefined || !leaseRecord.active)
            throw new SemanticProductionCoordinatorError("semantic_chat_runtime_lease_rejected");
          const activePrompt = leaseRecord.activePrompt;
          if (activePrompt === undefined) return "not_active";
          if (activePrompt.turnId !== expected.turnId || activePrompt.attemptId !== expected.attemptId)
            return "mismatch";
          if (activePrompt.aborting) return "not_active";
          leaseRecord.activePrompt = Object.freeze({ ...activePrompt, aborting: true });
          const session = record.runtime.runtimeSession?.session;
          const abort = session?.abort;
          if (typeof abort !== "function") return "not_active";
          try {
            await abort.call(session);
          } catch {
            // A failed transport abort does not change the ordinary SQLite
            // terminal winner selected by the authenticated Stop request.
          }
          return "aborted";
        },
        async reloadModelSelection(this: unknown): Promise<MountedModelSelectionReload> {
          if (this !== lease || !isCurrentMountedChatRuntimeLease(lease))
            throw new SemanticProductionCoordinatorError("semantic_chat_runtime_lease_rejected");
          const leaseRecord = mountedChatRuntimeLeases.get(lease);
          if (leaseRecord === undefined || !leaseRecord.active)
            throw new SemanticProductionCoordinatorError("semantic_chat_runtime_lease_rejected");
          // The same terminal test a mount release uses: a turn that has not
          // reached a terminal ledger state, or a Pi prompt that is still running,
          // keeps the runtime it started with. The selection is not lost - the
          // next prompt adopts it before it begins.
          if (await mountedLeaseHasTurnInFlight(leaseRecord))
            return Object.freeze({ status: "turn_in_flight", modelSelection: readMountedModelSelection(leaseRecord) });
          await applyMountedModelSelection(leaseRecord);
          return Object.freeze({ status: "applied", modelSelection: readMountedModelSelection(leaseRecord) });
        },
        close(this: unknown): Promise<void> {
          if (this !== lease || !issuedLeases.has(lease as object))
            return Promise.reject(new SemanticProductionCoordinatorError("semantic_chat_runtime_lease_rejected"));
          const leaseRecord = mountedChatRuntimeLeases.get(lease);
          if (leaseRecord !== undefined) {
            leaseRecord.active = false;
            leaseRecord.transitionAuthority.revoke();
          }
          return authority.close();
        },
      });
      issuedLeases.add(lease as object);
      mountedChatRuntimeLeases.set(lease, {
        active: true,
        runtimeRoot: provision.runtimeCwd,
        principal: Object.freeze({ ...provision.principal }),
        chatThreadId: readback.chatThreadId,
        chatSurfaceSessionId: readback.chatSurfaceSessionId,
        selectionGeneration: record.vector.selectionRevision,
        attemptBinding: Object.freeze({
          runtimeBindingDigest: record.bootstrapPermit.runtimeBindingDigest,
          runtimeOwner: Object.freeze({ ...record.bootstrapPermit.owner }),
        }),
        ...(runtimeSession === undefined ? {} : { providerRuntimeSession: runtimeSession }),
        ...(record.runtime.reloadModelSelection === undefined
          ? {}
          : { reloadModelSelection: record.runtime.reloadModelSelection }),
        ...(record.runtime.appliedModelConfig === undefined
          ? {}
          : { appliedModelConfig: record.runtime.appliedModelConfig }),
        ...(record.runtime.authoredContextCapability === undefined
          ? {}
          : { authoredContextCapability: record.runtime.authoredContextCapability }),
        ...(record.runtime.refreshAuthoredContext === undefined
          ? {}
          : { refreshAuthoredContext: record.runtime.refreshAuthoredContext }),
        startedAttemptIds: new Set<string>(),
        transitionAuthority: createMountedTurnTransitionAuthority(),
        presentationEpoch: createCompanionInterruption(),
        promptSettlementWaiters: new Set<() => void>(),
        begin,
        store: mountedStore,
        close: () => authority.close(),
      });
      mountedLease = lease;
      return lease;
    });
    return mountedStartPromise;
  };
  authority = Object.freeze({
    authority: "SEMANTIC" as const,
    startChatRuntime,
    requestChatSelection,
    startMountedChatRuntime,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      const activeLease = mountedLease === undefined ? undefined : mountedChatRuntimeLeases.get(mountedLease);
      if (activeLease) {
        activeLease.active = false;
        activeLease.transitionAuthority.revoke();
      }
      const attempt = (async () => {
        await waitForDrain();
        const record = [...liveByBootstrapOperation.values()][0];
        if (record) await tearDownChatRuntimeRecord(record);
        // In a shared composition the mutex and broker stay open for the owner's
        // retryable close, but the Chat binding and the drain-only store semantic
        // projection are Chat-owned and must be closed by this projection.
        //
        // The mounted Chat store closes here rather than when `closing` was set:
        // every read already in flight when close began has drained above, so
        // this can never pull the connection out from under one.
        if (!mountedChatThreadStoreClosed) {
          mountedChatThreadStoreClosed = true;
          mountedChatThreadStore?.close?.();
          mountedChatThreadStore = undefined;
        }
        if (!bindingClosed) {
          await binding.close();
          bindingClosed = true;
        }
        if (!semanticClosed) {
          await semantic.close();
          semanticClosed = true;
        }
        if (!sharedOwnerClose) {
          if (!mutexClosed) {
            await mutex.close();
            mutexClosed = true;
          }
          if (!brokerClosed) {
            try {
              await broker.close();
            } catch (error) {
              if (isTerminalBrokerCloseError(error)) terminalError = error;
              throw error;
            }
            brokerClosed = true;
          }
        }
        closed = true;
      })();
      closePromise = attempt;
      void attempt.catch((error) => {
        if (!closed && terminalError === undefined && !isTerminalBrokerCloseError(error)) closePromise = undefined;
      });
      return attempt;
    },
  });
  return authority;
}

/**
 * Runs one initial-chat saga and always releases the content port it built.
 *
 * The port holds a long-lived store, so it is scoped to this one saga rather
 * than left for collection: an unclosed store keeps its SQLite handle and would
 * hold the continuity root against removal on Windows.
 */
async function initializeInitialChatAndCloseContentPort(
  semantic: SemanticProductionAuthority,
  manifest: HostDeploymentManifest,
): Promise<ProductionSagaReadback> {
  const content = createManifestDerivedInitialChatExactContentPort(manifest);
  try {
    return await semantic.initializeInitialChat(content.port);
  } finally {
    content.close();
  }
}

async function failChatRuntimeAfterError(
  locked: <T>(work: () => T) => Promise<T>,
  provision: FreshContinuityProvision,
  permit: import("../continuity-semantic-store/continuity-semantic-production-store.js").ProductionChatRuntimePermit,
  primary: unknown,
): Promise<void> {
  try {
    const readback = await locked(() =>
      provision.store.failChatRuntime(
        Object.freeze({ principal: provision.principal, permit, reason: "effect_failed" }),
      ),
    );
    if (readback.status !== "recovery_required" || readback.runtimeState !== "recovery_required")
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_failure_not_recovered");
  } catch (error) {
    throw new AggregateError([primary, error], "semantic_chat_runtime_failure");
  }
}

async function closeAndFailChatRuntime(
  locked: <T>(work: () => T) => Promise<T>,
  provision: FreshContinuityProvision,
  permit: import("../continuity-semantic-store/continuity-semantic-production-store.js").ProductionChatRuntimePermit,
  runtime: MaterializedChatRuntime,
  primary: unknown,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await runtime.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    const readback = await locked(() =>
      provision.store.failChatRuntime(
        Object.freeze({ principal: provision.principal, permit, reason: "effect_failed" }),
      ),
    );
    if (readback.status !== "recovery_required" || readback.runtimeState !== "recovery_required")
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_failure_not_recovered");
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError([primary, ...failures], "semantic_chat_runtime_failure");
}

async function createSemanticProductionAuthorityFromDeploymentManifest(
  manifest: HostDeploymentManifest,
  mode: "fresh" | "known",
): Promise<SemanticProductionAuthority> {
  const input: FreshContinuityProvisionOptions = Object.freeze({
    runtimeCwd: manifest.runtimeRoot,
    principal: Object.freeze({ ...manifest.principal }),
    bootstrapOperationId: manifest.bootstrapOperationId,
    authorityGeneration: manifest.authorityGeneration,
  });
  const broker = new WindowsNamedMutexBroker();
  const mutex = createWindowsAuthorityRootMutex(broker);
  try {
    const admission = createCanonicalProductionAuthorityAdmission(input.runtimeCwd);
    const provision = await openProvisionWithAdmission(
      () =>
        mode === "fresh"
          ? provisionFreshProductionContinuityFromCanonicalAdmission(input, admission)
          : openKnownProductionContinuityFromCanonicalAdmission(input, admission),
      admission.authorityRootIdentity,
      mutex,
    );
    if (mode === "fresh") await seedDefaultCompanionForFreshRoot(manifest);
    const authority = create(provision, mutex);
    if (mode === "known") {
      try {
        const current = await authority.resumeInitialChat();
        if (current === null) throw new SemanticProductionCoordinatorError("initial_chat_known_open_saga_absent");
        if (current.phase === "selected")
          throw new SemanticProductionCoordinatorError("initial_chat_known_open_saga_selected");
      } catch (error) {
        try {
          await authority.close();
        } finally {
          await closeOwnedMutex(mutex, broker);
        }
        throw error;
      }
    }
    return createWithCloseDependencies(authority, createOwnedMutexCloser(mutex, broker));
  } catch (error) {
    await closeOwnedMutex(mutex, broker);
    throw error;
  }
}
async function closeOwnedMutex(mutex: WindowsAuthorityRootMutex, broker: WindowsNamedMutexBroker): Promise<void> {
  let failure: unknown;
  for (const close of [() => mutex.close(), () => broker.close()]) {
    try {
      await close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

function isTerminalBrokerCloseError(error: unknown): boolean {
  return error instanceof WindowsNamedMutexBrokerError;
}

function createOwnedMutexCloser(
  mutex: WindowsAuthorityRootMutex,
  broker: WindowsNamedMutexBroker,
): () => Promise<void> {
  let mutexClosed = false;
  let brokerClosed = false;
  return async () => {
    if (!mutexClosed) {
      await mutex.close();
      mutexClosed = true;
    }
    if (!brokerClosed) {
      await broker.close();
      brokerClosed = true;
    }
  };
}

/** Internal production composition ownership; no provision or raw store can cross this boundary. */
function createWithCloseDependencies(
  authority: SemanticProductionAuthority,
  closeDependencies: () => Promise<void>,
): SemanticProductionAuthority {
  let closePromise: Promise<void> | undefined;
  let authorityClosed = false;
  let dependenciesClosed = false;
  let terminalError: unknown;
  return Object.freeze({
    ...authority,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      const attempt = (async () => {
        if (!authorityClosed) {
          await authority.close();
          authorityClosed = true;
        }
        if (!dependenciesClosed) {
          try {
            await closeDependencies();
          } catch (error) {
            if (isTerminalBrokerCloseError(error)) terminalError = error;
            throw error;
          }
          dependenciesClosed = true;
        }
      })();
      closePromise = attempt;
      void attempt.catch((error) => {
        if (terminalError === undefined && !isTerminalBrokerCloseError(error)) closePromise = undefined;
      });
      return attempt;
    },
  });
}

async function openProvisionWithAdmission(
  open: () => FreshContinuityProvision,
  root: string,
  mutex: WindowsAuthorityRootMutex,
): Promise<FreshContinuityProvision> {
  const lease = await requireLease(mutex, root, undefined);
  let provision: FreshContinuityProvision | undefined;
  let sealed = false;
  const seal = async (): Promise<void> => {
    if (sealed) return;
    sealed = true;
    await lease.safetySealAfterAbandonedQuarantineFailure();
  };
  try {
    try {
      provision = open();
    } catch (error) {
      if (lease.disposition === "abandoned") {
        await seal();
      }
      throw error;
    }
    if (lease.disposition === "abandoned") {
      try {
        provision.store.quarantineAfterAbandonedMutex();
        const state = provision.store.readQuarantine();
        if (!state.quarantined || state.reason !== "abandoned_windows_root_mutex")
          throw new Error("quarantine_readback_mismatch");
      } catch (error) {
        await seal();
        throw error;
      }
      try {
        await release(lease);
      } catch (error) {
        await seal();
        throw error;
      }
      throw new SemanticProductionCoordinatorError("semantic_production_abandoned_mutex_quarantined");
    }
    await release(lease);
  } catch (error) {
    // A failed abandoned open/mark/reread is never normally released: its safety
    // seal is the sole terminal containment operation.
    if (lease.disposition !== "abandoned") {
      try {
        await release(lease);
      } catch {
        /* the primary failure remains authoritative */
      }
    } else if (!sealed) {
      // An abandoned lease only normal-releases after the verified-success path.
      try {
        await seal();
      } catch {
        /* the primary failure remains authoritative */
      }
    }
    provision?.close();
    throw error;
  }
  return provision;
}

function create(
  provision: FreshContinuityProvision,
  mutex: WindowsAuthorityRootMutex,
  closeDependencies?: () => Promise<void>,
  shared = false,
): SemanticProductionAuthority {
  const holder = createDialogueSagaHolder(provision);
  const branded = brand(holder);
  let closing = false;
  let closed = false;
  let pending = 0;
  let closePromise: Promise<void> | undefined;
  let provisionClosed = false;
  let dependenciesClosed = false;
  let terminalError: unknown;
  const drainWaiters = new Set<() => void>();
  const waitForDrain = (): Promise<void> =>
    pending === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          drainWaiters.add(resolve);
        });
  const begin = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing || closed)
      return Promise.reject(new SemanticProductionCoordinatorError("semantic_production_authority_closed"));
    pending++; // synchronous acceptance boundary, before the first await
    return work().finally(() => {
      pending--;
      if (pending === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    });
  };
  let poisoned = false;
  const locked = async <T>(work: () => T): Promise<T> => {
    if (poisoned) throw new SemanticProductionCoordinatorError("semantic_production_abandoned_mutex_quarantined");
    let lease: WindowsPartitionMutexLease;
    lease = await requireLease(mutex, provision.authorityRootIdentity, provision, () => {
      poisoned = true;
      closing = true;
    });
    let value: T | undefined;
    let failure: unknown;
    let asyncRejected = false;
    try {
      value = work();
      if (isThenable(value)) {
        asyncRejected = true;
        poisoned = true;
        closing = true;
        throw new SemanticProductionCoordinatorError("async_partition_mutex_section_rejected");
      }
    } catch (error) {
      failure = error;
    }
    if (asyncRejected) {
      // Descriptor-safe thenable rejection must retain containment; no normal
      // release can race unresolved work returned by a compromised store adapter.
      try {
        await lease.safetySealAfterAbandonedQuarantineFailure();
      } catch {
        /* poisoned with no release */
      }
      throw failure;
    }
    try {
      await release(lease);
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    if (failure !== undefined) throw failure;
    return value as T;
  };
  const step = (index: number, receipt?: TavernExactContentReceipt): Promise<ProductionSagaReadback> =>
    begin(() =>
      locked(() => {
        const previous = provision.store.resume(branded.digest);
        const expected = previous
          ? { ...previous.vector }
          : { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 };
        const input = Object.freeze({
          holderBindingDigest: branded.digest,
          operationId: branded.operations[index]!,
          expected,
        });
        return index === 0
          ? provision.store.claim(input)
          : index === 1
            ? provision.store.register(input)
            : index === 2
              ? provision.store.verify(input, receipt!)
              : provision.store.select(input);
      }),
    );
  const resume = (): Promise<ProductionSagaReadback | null> =>
    begin(() => locked(() => provision.store.resume(branded.digest)));
  const nextChatOperation = (
    kind: "register" | "verify" | "select" | "reselect" | "lifecycle",
    catalog: ProductionChatCatalog,
    target: ProductionChatCatalog["threads"][number] | undefined,
    extra?: string,
  ): string => {
    const suffix = createHash("sha256")
      .update(
        `${branded.digest}\0${kind}\0${catalog.vector.partitionRevision}\0${catalog.vector.fenceEpoch}\0${catalog.vector.selectionRevision}\0${target?.chatThreadId ?? ""}\0${target?.chatSurfaceSessionId ?? ""}\0${extra ?? ""}`,
      )
      .digest("hex");
    return `chat-${kind}-${suffix.slice(0, 32)}`;
  };
  const chatOperation = (
    kind: "register" | "verify" | "select" | "lifecycle",
    receipt?: TavernExactContentReceipt,
    lifecycle?: ProductionChatLifecycleInput["operation"],
  ): Promise<ProductionChatCommandReadback> =>
    begin(() =>
      locked(() => {
        const catalog = provision.store.readChatCatalog();
        if (kind === "register") {
          const operationId = nextChatOperation(kind, catalog, undefined),
            threadSuffix = randomUUID().replaceAll("-", "");
          return provision.store.registerChat(
            Object.freeze({
              operationId,
              chatThreadId: `chat-${threadSuffix.slice(0, 16)}`,
              chatSurfaceSessionId: `surface-${threadSuffix.slice(16, 32)}`,
              expected: { ...catalog.vector },
            }),
          );
        }
        const target =
          kind === "verify"
            ? catalog.threads.find((thread) => thread.lifecycle === "active" && thread.contentState === "registered")
            : kind === "select"
              ? catalog.threads.find(
                  (thread) =>
                    thread.lifecycle === "active" &&
                    thread.contentState === "verified" &&
                    thread.chatSurfaceSessionId !== catalog.activeSelection?.chatSurfaceSessionId,
                )
              : lifecycle === "archive"
                ? catalog.threads.find(
                    (thread) =>
                      thread.lifecycle === "active" &&
                      thread.chatSurfaceSessionId !== catalog.activeSelection?.chatSurfaceSessionId,
                  )
                : lifecycle === "trash"
                  ? catalog.threads.find(
                      (thread) =>
                        (thread.lifecycle === "active" || thread.lifecycle === "archived") &&
                        thread.chatSurfaceSessionId !== catalog.activeSelection?.chatSurfaceSessionId,
                    )
                  : catalog.threads.find(
                      (thread) =>
                        thread.lifecycle === "trashed" &&
                        thread.chatSurfaceSessionId !== catalog.activeSelection?.chatSurfaceSessionId,
                    );
        if (!target)
          throw new SemanticProductionCoordinatorError(
            kind === "lifecycle" ? "semantic_chat_lifecycle_target_unavailable" : "semantic_chat_target_unavailable",
          );
        const operationId = nextChatOperation(kind, catalog, target, lifecycle);
        if (kind === "verify") {
          if (
            !isTrustedTavernExactContentReceipt(receipt) ||
            receipt.chatThreadId !== target.chatThreadId ||
            receipt.chatSurfaceSessionId !== target.chatSurfaceSessionId ||
            receipt.companionId !== provision.principal.companionId ||
            receipt.continuityId !== provision.principal.continuityId
          )
            throw new SemanticProductionCoordinatorError("tavern_exact_content_receipt_binding_rejected");
          return provision.store.verifyChatContent(
            Object.freeze({
              operationId,
              chatThreadId: target.chatThreadId,
              chatSurfaceSessionId: target.chatSurfaceSessionId,
              expected: { ...catalog.vector },
            }),
            receipt,
          );
        }
        if (kind === "select")
          return provision.store.selectChat(
            Object.freeze({
              operationId,
              chatThreadId: target.chatThreadId,
              chatSurfaceSessionId: target.chatSurfaceSessionId,
              expected: { ...catalog.vector },
            }),
          );
        return provision.store.transitionChatLifecycle(
          Object.freeze({
            operationId,
            chatThreadId: target.chatThreadId,
            chatSurfaceSessionId: target.chatSurfaceSessionId,
            expectedManagementRevision: target.managementRevision,
            expected: { ...catalog.vector },
            operation: lifecycle!,
          }),
        );
      }),
    );
  return Object.freeze({
    authority: "SEMANTIC" as const,
    readChatCatalog: () => begin(() => locked(() => provision.store.readChatCatalog())),
    registerChat: () => chatOperation("register"),
    verifyRegisteredChatContent: (receipt) => chatOperation("verify", receipt),
    selectVerifiedChat: () => chatOperation("select"),
    reselectTerminalChatRuntimeSuccessor: () =>
      begin(() =>
        locked(() => {
          const catalog = provision.store.readChatCatalog();
          const target = catalog.activeSelection;
          const thread =
            target === null
              ? undefined
              : catalog.threads.find(
                  (candidate) =>
                    candidate.chatThreadId === target!.chatThreadId &&
                    candidate.chatSurfaceSessionId === target!.chatSurfaceSessionId &&
                    candidate.lifecycle === "active" &&
                    candidate.contentState === "verified",
                );
          if (!target || !thread)
            throw new SemanticProductionCoordinatorError("semantic_chat_runtime_successor_target_unavailable");
          return provision.store.selectChat(
            Object.freeze({
              operationId: nextChatOperation("reselect", catalog, thread),
              chatThreadId: thread.chatThreadId,
              chatSurfaceSessionId: thread.chatSurfaceSessionId,
              expected: { ...catalog.vector },
            }),
          );
        }),
      ),
    transitionNonSelectedChatLifecycle: (operation) => chatOperation("lifecycle", undefined, operation),
    startInitialChat: () => step(0),
    registerInitialChat: () => step(1),
    verifyInitialChat: (receipt) =>
      begin(async () => {
        if (!isTrustedTavernExactContentReceipt(receipt))
          throw new SemanticProductionCoordinatorError("untrusted_tavern_exact_content_receipt");
        return locked(() => {
          const current = provision.store.resume(branded.digest);
          if (
            !current ||
            !current.chatThreadId ||
            !current.chatSurfaceSessionId ||
            receipt.chatThreadId !== current.chatThreadId ||
            receipt.chatSurfaceSessionId !== current.chatSurfaceSessionId ||
            receipt.companionId !== provision.principal.companionId ||
            receipt.continuityId !== provision.principal.continuityId
          )
            throw new SemanticProductionCoordinatorError("tavern_exact_content_receipt_binding_rejected");
          return provision.store.verify(
            Object.freeze({
              holderBindingDigest: branded.digest,
              operationId: branded.operations[2]!,
              expected: { ...current.vector },
            }),
            receipt,
          );
        });
      }),
    selectInitialChat: () => step(3),
    initializeInitialChat: (content) =>
      begin(async () => {
        await stepUnchecked(0);
        const registered = await stepUnchecked(1);
        const receipt = await createRegisteredContent(content, registered);
        const verified = await verifyUnchecked(receipt);
        if (!verified.receipt || !sameTavernExactContentReceipt(receipt, verified.receipt))
          throw new SemanticProductionCoordinatorError("tavern_exact_content_receipt_mismatch");
        return stepUnchecked(3);
      }),
    resumeInitialChat: resume,
    resumeInitialChatWithContent: (content) =>
      begin(async () => {
        const current = await resume();
        if (!current) return null;
        if (current.phase === "selected") return current;
        if (current.phase === "claimed_empty")
          throw new SemanticProductionCoordinatorError("initial_chat_resume_requires_explicit_creation");
        if (!current.chatThreadId || !current.chatSurfaceSessionId)
          throw new SemanticProductionCoordinatorError("initial_chat_binding_missing");
        // Reopen never creates Tavern content. Every recoverable phase must prove
        // the exact durable binding through Tavern's current branded capability.
        if (current.phase === "chat_registered" || current.phase === "content_verified") {
          const receipt = await content.resumeExact(
            current.chatThreadId,
            provision.principal.companionId,
            provision.principal.continuityId,
            current.chatSurfaceSessionId,
          );
          if (!isTrustedTavernExactContentReceipt(receipt))
            throw new SemanticProductionCoordinatorError("untrusted_tavern_exact_content_receipt");
          if (current.phase === "chat_registered") {
            const verified = await verifyUnchecked(receipt);
            if (!verified.receipt || !sameTavernExactContentReceipt(receipt, verified.receipt))
              throw new SemanticProductionCoordinatorError("tavern_exact_content_receipt_mismatch");
          } else if (!current.receipt || !sameTavernExactContentReceipt(receipt, current.receipt))
            throw new SemanticProductionCoordinatorError("tavern_exact_content_receipt_mismatch");
        } else {
          throw new SemanticProductionCoordinatorError("initial_chat_resume_phase_invalid");
        }
        return stepUnchecked(3);
      }),
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      const attempt = (async () => {
        await waitForDrain();
        if (!shared && !provisionClosed) {
          provision.close();
          provisionClosed = true;
        }
        if (!shared && !dependenciesClosed && closeDependencies) {
          try {
            await closeDependencies();
          } catch (error) {
            if (isTerminalBrokerCloseError(error)) terminalError = error;
            throw error;
          }
          dependenciesClosed = true;
        }
        closed = true;
      })();
      closePromise = attempt;
      void attempt.catch((error) => {
        if (!closed && terminalError === undefined && !isTerminalBrokerCloseError(error)) closePromise = undefined;
      });
      return attempt;
    },
  });
  async function createRegisteredContent(
    content: InitialChatExactContentPort,
    registered: ProductionSagaReadback,
  ): Promise<TavernExactContentReceipt> {
    if (!registered.chatThreadId || !registered.chatSurfaceSessionId)
      throw new SemanticProductionCoordinatorError("initial_chat_binding_missing");
    // The initializer owns the exact request: the thread, surface and principal
    // are the saga's own registered facts, and the opening is the companion's
    // (the manifest-derived port derives it from the reviewed greeting record).
    // No caller can supply any of the four through this production seam.
    // No lease spans this await. Creation is an initializer-only operation;
    // every production reopen uses resumeExact above and fails closed if absent.
    const receipt = await content.createExplicit(
      Object.freeze({
        chatThreadId: registered.chatThreadId,
        companionId: provision.principal.companionId,
        continuityId: provision.principal.continuityId,
        chatSurfaceSessionId: registered.chatSurfaceSessionId,
      }),
    );
    if (!isTrustedTavernExactContentReceipt(receipt))
      throw new SemanticProductionCoordinatorError("untrusted_tavern_exact_content_receipt");
    return receipt;
  }
  function stepUnchecked(index: number): Promise<ProductionSagaReadback> {
    return locked(() => {
      const previous = provision.store.resume(branded.digest);
      const expected = previous
        ? { ...previous.vector }
        : { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 };
      const input = Object.freeze({
        holderBindingDigest: branded.digest,
        operationId: branded.operations[index]!,
        expected,
      });
      return index === 0
        ? provision.store.claim(input)
        : index === 1
          ? provision.store.register(input)
          : index === 3
            ? provision.store.select(input)
            : (() => {
                throw new SemanticProductionCoordinatorError("initial_chat_step_invalid");
              })();
    });
  }
  function verifyUnchecked(receipt: TavernExactContentReceipt): Promise<ProductionSagaReadback> {
    return locked(() => {
      const current = provision.store.resume(branded.digest);
      if (!current) throw new SemanticProductionCoordinatorError("initial_chat_binding_missing");
      return provision.store.verify(
        Object.freeze({
          holderBindingDigest: branded.digest,
          operationId: branded.operations[2]!,
          expected: { ...current.vector },
        }),
        receipt,
      );
    });
  }
}

/**
 * S4d store half. It intentionally owns all request identifiers, deadlines,
 * origins, vectors and terminal calls. The later facade only coordinates the
 * unlocked runtime effect with these opaque return values.
 */
function createKnownGameAuthority(
  provision: FreshContinuityProvision,
  mutex: WindowsAuthorityRootMutex,
  closeDependencies: (() => Promise<void>) | undefined,
  ownerDeathVerifier: WindowsOwnerDeathVerifier,
  shared = false,
): SemanticGameProductionAuthority {
  let closing = false;
  let closed = false;
  let pending = 0;
  let liveCount = 0;
  let closePromise: Promise<void> | undefined;
  let provisionClosed = false;
  let dependenciesClosed = false;
  let terminalError: unknown;
  const liveByEnterOperation = new Map<string, LiveSemanticGame>();
  // A close-pending lease owns exactly one durable teardown operation. The
  // same permit remains authoritative across controlled facade retries.
  const closePermitByLive = new WeakMap<object, ProductionGamePermit>();
  const drainWaiters = new Set<() => void>();
  const waitForDrain = (): Promise<void> =>
    pending === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          drainWaiters.add(resolve);
        });
  const begin = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing || closed)
      return Promise.reject(new SemanticProductionCoordinatorError("semantic_game_authority_closed"));
    pending++;
    return work().finally(() => {
      pending--;
      if (pending === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    });
  };
  const locked = async <T>(work: () => T): Promise<T> => {
    const lease = await requireLease(mutex, provision.authorityRootIdentity, provision, () => {
      closing = true;
    });
    let result: T | undefined;
    let failure: unknown;
    try {
      result = work();
      if (isThenable(result)) throw new SemanticProductionCoordinatorError("async_partition_mutex_section_rejected");
    } catch (error) {
      failure = error;
    }
    try {
      await release(lease);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
    return result as T;
  };
  const prepareEnter = (facts: GameEffectFacts): Promise<ProductionGamePermit> =>
    begin(() =>
      locked(() => {
        assertGameFacts(facts);
        const admission = provision.store.readGameAdmission();
        const request = Object.freeze({
          principal: provision.principal,
          operationId: gameId(),
          requestId: gameId(),
          kind: "enter" as const,
          gameSessionId: gameId(),

          world: freezeWorld(facts.world),
          bindingDigest: facts.bindingDigest,
          owner: freezeOwner(facts.owner),
          deadlineAtMs: gameDeadline(),
          expected: admission.vector,
        });
        const outcome = provision.store.prepareGame(request);
        if (outcome.outcome !== "effect_owned" || outcome.permit === null)
          throw new SemanticProductionCoordinatorError("semantic_game_enter_not_effect_owned");
        return outcome.permit;
      }),
    );
  const commitEnter = (
    permit: ProductionGamePermit,
    receipt: ProductionGameTerminalReceipt,
  ): Promise<LiveSemanticGame> =>
    begin(() =>
      locked(() => {
        const readback = provision.store.commitGameTerminal(
          Object.freeze({ principal: provision.principal, permit, receipt }),
        );
        if (
          readback.status !== "terminal" ||
          readback.gameState !== "active" ||
          receipt.kind !== "runtime_bootstrapped"
        )
          throw new SemanticProductionCoordinatorError("semantic_game_enter_not_active");
        const existing = liveByEnterOperation.get(permit.operationId);
        if (existing) return existing;
        const live = Object.freeze(Object.create(null)) as LiveSemanticGame;
        const record: LiveGameRecord = Object.freeze({
          operationId: permit.operationId,
          gameSessionId: permit.gameSessionId,

          facts: freezeFacts({ world: permit.world, bindingDigest: permit.bindingDigest, owner: permit.owner }),
          vector: readback.vector,
        });
        liveGames.set(live, record);
        liveByEnterOperation.set(permit.operationId, live);
        liveCount++;
        return live;
      }),
    );
  const failEnter = (permit: ProductionGamePermit): Promise<ProductionGameReadback> =>
    begin(() =>
      locked(() =>
        provision.store.failGame(Object.freeze({ principal: provision.principal, permit, reason: "effect_failed" })),
      ),
    );
  const prepareClose = (live: LiveSemanticGame): Promise<ProductionGamePermit> =>
    begin(() =>
      locked(() => {
        const record = requireLiveGame(live);
        const existing = closePermitByLive.get(live);
        if (existing) return existing;
        const request = Object.freeze({
          principal: provision.principal,
          operationId: gameId(),
          requestId: gameId(),
          kind: "close" as const,
          gameSessionId: record.gameSessionId,

          world: record.facts.world,
          bindingDigest: record.facts.bindingDigest,
          owner: record.facts.owner,
          deadlineAtMs: gameDeadline(),
          expected: record.vector,
        });
        const outcome = provision.store.prepareGame(request);
        if (outcome.outcome !== "effect_owned" || outcome.permit === null)
          throw new SemanticProductionCoordinatorError("semantic_game_close_not_effect_owned");
        closePermitByLive.set(live, outcome.permit);
        return outcome.permit;
      }),
    );
  const retire = (live: LiveSemanticGame): void => {
    const record = liveGames.get(live);
    if (liveGames.delete(live)) {
      if (record && liveByEnterOperation.get(record.operationId) === live)
        liveByEnterOperation.delete(record.operationId);
      closePermitByLive.delete(live);
      liveCount--;
    }
  };
  const commitClose = (
    live: LiveSemanticGame,
    permit: ProductionGamePermit,
    receipt: ProductionGameTerminalReceipt,
  ): Promise<ProductionGameReadback> =>
    begin(() =>
      locked(() => {
        requireLiveGame(live);
        const readback = provision.store.commitGameTerminal(
          Object.freeze({ principal: provision.principal, permit, receipt }),
        );
        // A completed close is only close-admissible if it ended the Game and
        // removed every live lease. It has no Chat selection or restoration side effect.
        if (readback.status !== "terminal" || readback.gameState !== "ended" || readback.leaseState !== null) {
          throw new SemanticProductionCoordinatorError("semantic_game_close_not_settled");
        }
        retire(live);
        return readback;
      }),
    );
  const failClose = (live: LiveSemanticGame, permit: ProductionGamePermit): Promise<ProductionGameReadback> =>
    begin(() =>
      locked(() => {
        requireLiveGame(live);
        try {
          return provision.store.failGame(
            Object.freeze({ principal: provision.principal, permit, reason: "effect_failed" }),
          );
        } finally {
          retire(live);
        }
      }),
    );
  const recoverDeadOwner = (input: Readonly<{ request: "recover_dead_owner"; operationId: string }>) =>
    begin(() =>
      orchestrateExplicitGameRecovery(
        input,
        (operationId) =>
          locked(() =>
            provision.store.readGameRecoveryTarget(Object.freeze({ principal: provision.principal, operationId })),
          ),
        (target, proof) =>
          locked(() =>
            provision.store.recoverGame(
              Object.freeze({
                request: "recover_dead_owner" as const,
                principal: provision.principal,
                permit: target.permit,
                proof,
                receipt: recoveryReceipt(target),
              }),
            ),
          ),
        ownerDeathVerifier,
      ),
    );
  const createGameSessionMetadata = (input: ProductionGameSessionCreateInput): Promise<ProductionGameSessionMetadata> =>
    begin(() => locked(() => provision.store.createGameSessionMetadata(input)));
  const completeGameSessionBinding = (
    input: ProductionGameSessionBindingInput,
  ): Promise<ProductionGameSessionMetadata> =>
    begin(() => locked(() => provision.store.completeGameSessionBinding(input)));
  const failGameSessionCreation = (input: ProductionGameSessionBindingInput): Promise<ProductionGameSessionMetadata> =>
    begin(() => locked(() => provision.store.failGameSessionCreation(input)));
  const readGameSessionMetadata = (
    input: Readonly<{ gameSessionId: string }>,
  ): Promise<ProductionGameSessionMetadata | null> =>
    begin(() => locked(() => provision.store.readGameSessionMetadata(input)));
  const listResumableGameSessions = (): Promise<readonly ProductionGameSessionMetadata[]> =>
    begin(() => locked(() => provision.store.listResumableGameSessions()));
  const registerGameSessionWorldBinding = (
    input: ProductionGameSessionWorldBindingInput,
  ): Promise<ProductionGameSessionWorldBinding> =>
    begin(() => locked(() => provision.store.registerGameSessionWorldBinding(input)));
  const readGameSessionWorldBinding = (
    input: Readonly<{ gameSessionId: string; integrationId: string }>,
  ): Promise<ProductionGameSessionWorldBinding | null> =>
    begin(() => locked(() => provision.store.readGameSessionWorldBinding(input)));
  const markGameSessionWorldBindingTerminal = (
    input: ProductionGameSessionWorldBindingTerminalInput,
  ): Promise<ProductionGameSessionWorldBinding> =>
    begin(() => locked(() => provision.store.markGameSessionWorldBindingTerminal(input)));
  const readGameSessionWorldBindingSlotHolder = (
    input: Readonly<{ integrationId: string; bindingRef: string }>,
  ): Promise<ProductionGameSessionWorldBindingSlotHolder | null> =>
    begin(() => locked(() => provision.store.readGameSessionWorldBindingSlotHolder(input)));
  const releaseGameSessionWorldBindingSlot = (
    input: ProductionGameSessionWorldBindingSlotReleaseInput,
  ): Promise<ProductionGameSessionWorldBinding> =>
    begin(() => locked(() => provision.store.releaseGameSessionWorldBindingSlot(input)));
  return Object.freeze({
    authority: "SEMANTIC" as const,
    prepareEnter,
    commitEnter,
    failEnter,
    prepareClose,
    commitClose,
    failClose,
    recoverDeadOwner,
    createGameSessionMetadata,
    completeGameSessionBinding,
    failGameSessionCreation,
    readGameSessionMetadata,
    listResumableGameSessions,
    registerGameSessionWorldBinding,
    readGameSessionWorldBinding,
    markGameSessionWorldBindingTerminal,
    readGameSessionWorldBindingSlotHolder,
    releaseGameSessionWorldBindingSlot,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      const attempt = (async () => {
        await waitForDrain();
        if (liveCount !== 0) throw new SemanticProductionCoordinatorError("semantic_game_live_runtime_requires_close");
        if (!shared && !provisionClosed) {
          provision.close();
          provisionClosed = true;
        }
        if (!shared && !dependenciesClosed && closeDependencies) {
          try {
            await closeDependencies();
          } catch (error) {
            if (isTerminalBrokerCloseError(error)) terminalError = error;
            throw error;
          }
          dependenciesClosed = true;
        }
        closed = true;
      })();
      closePromise = attempt;
      void attempt.catch((error) => {
        // A refused close due to a live runtime is not terminal: the private
        // S4d close path remains the only way to make closure admissible.
        if (!closed && terminalError === undefined && !isTerminalBrokerCloseError(error)) {
          if (liveCount !== 0) closing = false;
          closePromise = undefined;
        }
      });
      return attempt;
    },
  });
}
/** Shared production flow; tests may inject only the OS verifier through this internal seam. */
export async function orchestrateExplicitGameRecovery(
  input: Readonly<{ request: "recover_dead_owner"; operationId: string }>,
  readTarget: (operationId: string) => Promise<ProductionGameRecoveryTarget | null>,
  forward: (
    target: ProductionGameRecoveryTarget,
    proof: import("../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.internal.js").WindowsOwnerDeathVerification,
  ) => Promise<ProductionGameReadback>,
  ownerDeathVerifier: WindowsOwnerDeathVerifier,
): Promise<ProductionGameReadback> {
  if (
    !input ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).length !== 2 ||
    input.request !== "recover_dead_owner" ||
    !validId(input.operationId)
  )
    throw new SemanticProductionCoordinatorError("semantic_game_recovery_request_rejected");
  const target = await readTarget(input.operationId);
  if (!target) throw new SemanticProductionCoordinatorError("semantic_game_recovery_target_unavailable");
  const proof = await ownerDeathVerifier.verify(target.owner);
  return forward(target, proof);
}
function recoveryReceipt(target: ProductionGameRecoveryTarget) {
  const permit = target.permit;
  return Object.freeze({
    kind: "recovery_completed" as const,
    operationId: permit.operationId,
    requestId: permit.requestId,
    gameSessionId: permit.gameSessionId,
    bindingDigest: permit.bindingDigest,
    world: permit.world,
    owner: permit.owner,
    fenceToken: permit.fenceToken,
    occurredAtMs: Date.now(),
  });
}
function gameId(): string {
  return randomUUID();
}
function gameDeadline(): number {
  return Date.now() + 30_000;
}
function assertGameFacts(value: unknown): asserts value is GameEffectFacts {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertyNames(value).length !== 3 ||
    !validGameWorld((value as GameEffectFacts).world) ||
    typeof (value as GameEffectFacts).bindingDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test((value as GameEffectFacts).bindingDigest) ||
    !validGameOwner((value as GameEffectFacts).owner)
  )
    throw new SemanticProductionCoordinatorError("semantic_game_effect_facts_rejected");
}
function validGameWorld(value: unknown): value is ProductionGameWorld {
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 3 &&
    validId((value as ProductionGameWorld).integrationId) &&
    validId((value as ProductionGameWorld).saveId) &&
    validId((value as ProductionGameWorld).worldId)
  );
}
function validGameOwner(value: unknown): value is ProductionGameOwner {
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 4 &&
    validId((value as ProductionGameOwner).ownerToken) &&
    validId((value as ProductionGameOwner).runtimeInstanceId) &&
    Number.isSafeInteger((value as ProductionGameOwner).ownerPid) &&
    (value as ProductionGameOwner).ownerPid > 0 &&
    validId((value as ProductionGameOwner).ownerProcessStartIdentity)
  );
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function freezeWorld(value: ProductionGameWorld): ProductionGameWorld {
  return Object.freeze({ integrationId: value.integrationId, saveId: value.saveId, worldId: value.worldId });
}
function freezeOwner(value: ProductionGameOwner): ProductionGameOwner {
  return Object.freeze({
    ownerToken: value.ownerToken,
    runtimeInstanceId: value.runtimeInstanceId,
    ownerPid: value.ownerPid,
    ownerProcessStartIdentity: value.ownerProcessStartIdentity,
  });
}
function freezeFacts(value: GameEffectFacts): GameEffectFacts {
  return Object.freeze({
    world: freezeWorld(value.world),
    bindingDigest: value.bindingDigest,
    owner: freezeOwner(value.owner),
  });
}
function requireLiveGame(value: unknown): Readonly<{
  operationId: string;
  gameSessionId: string;
  facts: GameEffectFacts;
  vector: ProductionGameReadback["vector"];
}> {
  const record = typeof value === "object" && value !== null ? liveGames.get(value as object) : undefined;
  if (!record) throw new SemanticProductionCoordinatorError("semantic_game_live_runtime_rejected");
  return record;
}

async function requireLease(
  mutex: WindowsAuthorityRootMutex,
  root: string,
  provision: FreshContinuityProvision | undefined,
  poisonBeforeVerifiedRelease?: () => void,
): Promise<WindowsPartitionMutexLease> {
  if (!mutex.acquire) throw new SemanticProductionCoordinatorError("semantic_production_root_mutex_required");
  const lease = await mutex.acquire(root);
  if (lease.disposition !== "abandoned") return lease;
  if (!provision) return lease; // Admission/open persists and rereads quarantine while retaining this lease.
  try {
    provision.store.quarantineAfterAbandonedMutex();
    const state = provision.store.readQuarantine();
    if (!state.quarantined || state.reason !== "abandoned_windows_root_mutex")
      throw new Error("quarantine_readback_mismatch");
  } catch (error) {
    await lease.safetySealAfterAbandonedQuarantineFailure();
    throw error;
  }
  poisonBeforeVerifiedRelease?.();
  try {
    await lease.release();
  } catch (error) {
    await lease.safetySealAfterAbandonedQuarantineFailure();
    throw error;
  }
  throw new SemanticProductionCoordinatorError("semantic_production_abandoned_mutex_quarantined");
}
async function release(lease: WindowsPartitionMutexLease): Promise<void> {
  await lease.release();
}
function sameTavernExactContentReceipt(left: TavernExactContentReceipt, right: TavernExactContentReceipt): boolean {
  return (
    left.chatThreadId === right.chatThreadId &&
    left.companionId === right.companionId &&
    left.continuityId === right.continuityId &&
    left.chatSurfaceSessionId === right.chatSurfaceSessionId &&
    left.digest === right.digest
  );
}
