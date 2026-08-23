import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { type CompanionInterruption, createCompanionInterruption } from "../companion-interruption.js";
import {
  createChatRuntimeBinding,
  type OpaqueChatRuntimeBindingToken,
  readReservedChatRuntimeMaterializationFacts,
  releaseReservedChatRuntimeMaterialization,
  reserveChatRuntimeMaterialization,
  withConsumedChatRuntimeBinding,
} from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
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
  ProductionGameTerminalReceipt,
  ProductionGameWorld,
  ProductionSagaReadback,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { identityKey, type RuntimeSession } from "../runtime.js";
import type { CreateChatThreadRequest } from "../tavern/chat-thread-store.js";
import {
  createChatThreadStore,
  transitionP4MountedProviderStart,
  transitionP5MountedPresentation,
} from "../tavern/chat-thread-store.js";
import {
  createP4P5MountedTransitionAuthority,
  type P4P5MountedTransitionAuthorityLease,
  type P4P5MountedTransitionOperationAuthorityLease,
} from "../tavern/chat-thread-store.p4-p5-transition-authority.internal.js";
import {
  createManifestDerivedInitialChatExactContentPort,
  type InitialChatExactContentPort,
  isTrustedTavernExactContentReceipt,
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
 * P4c's one fixed internal start-admission deadline. It is minted exactly once
 * while consuming the one-shot invocation admission and creating the private
 * execution scope; it is never caller-supplied, durable, projected, or a
 * provider/cancellation timeout.
 */
export const P4C_PROVIDER_INVOCATION_ADMISSION_DEADLINE_MS = 120_000;
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
  abortActivePrompt(expected: Readonly<{ turnId: string; attemptId: string }>): Promise<"aborted" | "not_active" | "mismatch">;
  close(): Promise<void>;
}>;
export type SemanticChatRuntimeMountOptions = Readonly<{
  tavernNarrativeGateNonceSha256?: string;
}>;
type MountedChatRuntimeLeaseRecord = {
  active: boolean;
  readonly runtimeRoot: string;
  readonly principal: Readonly<{ playerId: string; companionId: string; continuityId: string }>;
  readonly chatThreadId: string;
  readonly chatSurfaceSessionId: string;
  readonly selectionGeneration: number;
  readonly p4AttemptBinding?: MountedP4AttemptBinding;
  /** Live materialized runtime session for the P4c start scope; never public. */
  readonly p4ProviderStartRuntimeSession?: RuntimeSession;

  /**
   * Process-local one-shot reservation for a durable generation-one attempt.
   * It closes concurrent/reentrant start calls before the durable `armed` write;
   * after that write, the ledger observation is the crash-safe no-reprompt proof.
   */
  readonly p4ProviderStartAttemptIds: Set<string>;
  /** Revoked synchronously when this mounted lease begins closing. */
  readonly p4P5TransitionAuthority: P4P5MountedTransitionAuthorityLease;
  /**
   * Chat-owned in-process presentation epoch (design/71 §3.4). It is created
   * once at mount, stored privately, and never durable; the ledger CAS is the
   * durable cancel authority. A stop via the coordinator's private cancel seam
   * invalidates every minted presentation admission for this lease.
   */
  readonly p5PresentationEpoch: CompanionInterruption;

  /** The sole Pi prompt currently executing under this mounted lease. */
  activePrompt?: Readonly<{ turnId: string; attemptId: string; aborting: boolean }>;
  /** Retained legacy P4/P5 cancellation state; new browser Stop bypasses it. */
  p5Cancellation?: Promise<P5CancelResult>;
  readonly begin: <T>(work: () => Promise<T>) => Promise<T>;
  close(): Promise<void>;
};
const mountedChatRuntimeLeases = new WeakMap<object, MountedChatRuntimeLeaseRecord>();

/**
 * Private P4 composition capability. It is intentionally unexported: only the
 * narrowly named Tavern internal seam can receive it through this callback.
 */
type MountedP4Admission = Readonly<{ readonly __mountedP4Admission: unique symbol }>;
type MountedP4AdmissionRecord = Readonly<{
  lease: MountedChatRuntimeLeaseRecord;
  active: { value: boolean };
  consuming: { value: boolean };
}>;
const mountedP4Admissions = new WeakMap<object, MountedP4AdmissionRecord>();

type MountedP4AttemptAdmission = Readonly<{ readonly __mountedP4AttemptAdmission: unique symbol }>;
type MountedP4AttemptBinding = Readonly<{
  runtimeBindingDigest: string;
  runtimeOwner: Readonly<{
    ownerToken: string;
    runtimeInstanceId: string;
    ownerPid: number;
    ownerProcessStartIdentity: string;
  }>;
}>;
type MountedP4AttemptAdmissionRecord = Readonly<{
  lease: MountedChatRuntimeLeaseRecord;
  binding: MountedP4AttemptBinding;
  active: { value: boolean };
  consuming: { value: boolean };
}>;
const mountedP4AttemptAdmissions = new WeakMap<object, MountedP4AttemptAdmissionRecord>();

/**
 * P4c's private execution scope. It is the only way a Tavern P4c consumer can
 * reach the live runtime session, the sole store-writer port, the immutable
 * bound facts, and the coordinator-minted start-admission deadline. None of
 * them may be retained after the admission callback returns.
 */
export type P4ProviderStartExecutionScope = Readonly<{
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
  }>;
  /** Coordinator-minted fixed start-admission deadline, struck exactly once per execution scope. */
  deadlineAtMs: number;
  /** The live materialized runtime session; only for the single prompt call. */
  runtimeSession: RuntimeSession;
  /**
   * The sole store-writer port for this exact attempt's arm/not_started/running
   * transitions and provider-rejection failure. It is callback-scoped and
   * bound to the mounted runtime root and full origin tuple.
   */
  transitionStore(
    command: import("../tavern/chat-thread-store.js").P4ProviderStartTransition,
  ): Promise<
    | import("../tavern/chat-thread-store.js").AttemptStartingTurn
    | import("../tavern/chat-thread-store.js").RunningTurn
    | import("../tavern/chat-thread-store.js").FailedTurn
    | import("../tavern/chat-thread-store.js").CancelledTurn
  >;
  /**
   * The sole P5 durable writer port for this exact running attempt. It remains
   * inside the already-exclusive P4c prompt consumer; it cannot prompt Pi or
   * be retained outside this callback scope.
   */
  transitionPresentation(
    command: import("../tavern/chat-thread-store.js").P5PresentationTransition,
  ): Promise<import("../tavern/chat-thread-store.js").ChatTurnLedger>;
  /** Reads the exact durable accepted player message text for the canonical envelope. */
  readAcceptedMessageText(): Promise<string>;
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
   * Performs P5's synchronous cancel/commit arbitration for this exact native
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

type P5ExactLedger = Exclude<
  import("../tavern/chat-thread-store.js").ChatTurnLedger,
  import("../tavern/chat-thread-store.js").AcceptedQueuedTurn
>;
type P5CancelResult = Exclude<
  P5ExactLedger,
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

async function readExactP5Ledger(record: MountedChatRuntimeLeaseRecord): Promise<P5ExactLedger> {
  const binding = record.p4AttemptBinding;
  if (binding === undefined)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
  const store = createChatThreadStore(record.runtimeRoot, identityKey(Object.freeze({ ...record.principal })));
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

async function readP5CancellationResult(record: MountedChatRuntimeLeaseRecord): Promise<P5CancelResult> {
  const current = await readExactP5Ledger(record);
  if (
    current.status === "attempt_starting" ||
    current.status === "running" ||
    current.status === "presentation_committed"
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
  return current;
}

type MountedP4AttemptInvocationAdmission = Readonly<{
  readonly __mountedP4AttemptInvocationAdmission: unique symbol;
}>;
type MountedP4AttemptInvocationRecord = Readonly<{
  lease: MountedChatRuntimeLeaseRecord;
  turn: import("../tavern/chat-thread-store.js").AttemptStartingTurn;
  active: { value: boolean };
  consuming: { value: boolean };
}>;
const mountedP4AttemptInvocationAdmissions = new WeakMap<object, MountedP4AttemptInvocationRecord>();

/**
 * P4's only coordinator-internal composition entry. It validates the exact
 * manifest/lease binding, begins close-drained work, and delegates the opaque
 * admission directly to Tavern's private internal seam.
 */
export async function acceptMountedP4DurableTurn(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  accept: (admission: MountedP4Admission) => Promise<import("../tavern/chat-thread-store.js").AcceptedQueuedTurn>,
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
    const active = { value: true };
    const consuming = { value: false };
    const admission = Object.freeze({}) as MountedP4Admission;
    mountedP4Admissions.set(admission, Object.freeze({ lease: record, active, consuming }));
    try {
      return await accept(admission);
    } finally {
      active.value = false;
    }
  });
}

/** Tavern-private consumption seam; callers cannot observe a lease record. */
/**
 * P4b's claim admission. Runtime binding facts are read only from the mounted
 * coordinator record; no facade, lease field, or store caller can provide them.
 * This runner does not invoke Pi or make a provider call.
 */
export async function claimMountedP4Attempt(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  claim: (
    admission: MountedP4AttemptAdmission,
  ) => Promise<import("../tavern/chat-thread-store.js").AttemptStartingTurn>,
): Promise<import("../tavern/chat-thread-store.js").AttemptStartingTurn> {
  const record = mountedChatRuntimeLeases.get(lease);
  if (
    record === undefined ||
    !record.active ||
    manifest.runtimeRoot !== record.runtimeRoot ||
    manifest.principal.playerId !== record.principal.playerId ||
    manifest.principal.companionId !== record.principal.companionId ||
    manifest.principal.continuityId !== record.principal.continuityId ||
    record.p4AttemptBinding === undefined
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
  return record.begin(async () => {
    if (!record.active)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
    const active = { value: true };
    const consuming = { value: false };
    const admission = Object.freeze({}) as MountedP4AttemptAdmission;
    mountedP4AttemptAdmissions.set(
      admission,
      Object.freeze({ lease: record, binding: record.p4AttemptBinding!, active, consuming }),
    );
    try {
      return await claim(admission);
    } finally {
      active.value = false;
    }
  });
}

/** Tavern-private P4b consumption seam; it produces only durable claim facts. */
export async function consumeMountedP4AttemptAdmission<T>(
  admission: MountedP4AttemptAdmission,
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
      runtimeOwner: MountedP4AttemptBinding["runtimeOwner"];
    }>,
  ) => Promise<T>,
): Promise<T> {
  const record = mountedP4AttemptAdmissions.get(admission);
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
 * P4c's private post-claim invocation admission. Consuming it mints exactly
 * one coordinator-private execution scope: the live materialized session, the
 * full immutable origin facts, the sole store-writer port, and the fixed
 * coordinator-minted start-admission deadline. No AgentSession, binding,
 * store, or minting path escapes this callback.
 */
export async function consumeMountedP4AttemptInvocationAdmission<T>(
  admission: MountedP4AttemptInvocationAdmission,
  callback: (scope: P4ProviderStartExecutionScope) => Promise<T>,
): Promise<T> {
  const record = mountedP4AttemptInvocationAdmissions.get(admission);
  if (record === undefined || !record.active.value || !record.lease.active || record.consuming.value)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_invocation_rejected");
  record.consuming.value = true;
  let operationAuthority: P4P5MountedTransitionOperationAuthorityLease | undefined;
  try {
    const mounted = record.lease;
    const runtimeSession = mounted.p4ProviderStartRuntimeSession;
    if (runtimeSession === undefined)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_provider_start_session_unavailable");
    const { attempt } = record.turn;
    const deadlineAtMs = Date.now() + P4C_PROVIDER_INVOCATION_ADMISSION_DEADLINE_MS;
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
    });
    operationAuthority = mounted.p4P5TransitionAuthority.mintOperation();
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
      command: import("../tavern/chat-thread-store.js").P4ProviderStartTransition,
    ): Promise<
      | import("../tavern/chat-thread-store.js").AttemptStartingTurn
      | import("../tavern/chat-thread-store.js").RunningTurn
      | import("../tavern/chat-thread-store.js").FailedTurn
      | import("../tavern/chat-thread-store.js").CancelledTurn
    > => {
      assertScopeActive();
      return transitionP4MountedProviderStart(
        Object.freeze({
          authority: mounted.p4P5TransitionAuthority.authority,
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
      command: import("../tavern/chat-thread-store.js").P5PresentationTransition,
    ): Promise<import("../tavern/chat-thread-store.js").ChatTurnLedger> => {
      assertScopeActive();
      return transitionP5MountedPresentation(
        Object.freeze({
          authority: mounted.p4P5TransitionAuthority.authority,
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
    const readAcceptedMessageText = async (): Promise<string> => {
      const store = createChatThreadStore(mounted.runtimeRoot, identityKey(Object.freeze({ ...mounted.principal })));
      const state = await store.resumeThread(mounted.chatThreadId, mounted.chatSurfaceSessionId);
      const message = state.messages.find(
        (candidate) =>
          candidate.messageId === record.turn.messageId && candidate.role === "player" && candidate.kind === "player",
      );
      if (message === undefined)
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_provider_start_message_unavailable");
      return message.text;
    };
    const readCurrentTurnLedger = async (): Promise<import("../tavern/chat-thread-store.js").ChatTurnLedger> => {
      const store = createChatThreadStore(mounted.runtimeRoot, identityKey(Object.freeze({ ...mounted.principal })));
      const ledger = (await store.resumeThread(mounted.chatThreadId, mounted.chatSurfaceSessionId)).turnLedger;
      if (
        ledger === null ||
        ledger.turnId !== facts.turnId ||
        !isTurnWithExactAttempt(ledger, facts.attemptId)
      )
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
      };
    };
    let nativeContentCommitReserved = false;
    let nativeContentPreviewEpoch: import("../companion-interruption.js").InterruptionSnapshot | undefined;
    const reserveNativeContentCommit = (): Readonly<{ cancelEpoch: number; release(): void }> | undefined => {
      const observationEpoch = mounted.p5PresentationEpoch.capture();
      if (
        nativeContentCommitReserved ||
        !mounted.p5PresentationEpoch.isCurrent(observationEpoch) ||
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
      const previewEpoch = nativeContentPreviewEpoch ??= mounted.p5PresentationEpoch.capture();
      return record.active.value && mounted.active && mounted.p5PresentationEpoch.isCurrent(previewEpoch);
    };
    const finalizeCancellation = async (): Promise<
      | import("../tavern/chat-thread-store.js").CompletionClaimedTurn
      | import("../tavern/chat-thread-store.js").CompletedTurn
      | import("../tavern/chat-thread-store.js").CancelClaimedTurn
      | import("../tavern/chat-thread-store.js").CancelledTurn
      | import("../tavern/chat-thread-store.js").FailedTurn
      | undefined
    > => {
      const cancellation = mounted.p5Cancellation;
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
        transitionStore,
        transitionPresentation,
        readAcceptedMessageText,
        readCurrentTurnLedger,
        assertAdmission,
        beginActivePrompt,
        reserveNativeContentCommit,
        canPreviewNativeContent,
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
 * P4c's only start runner. It reads the already durable P4b claim under the
 * mounted authority, then mints one callback-scoped invocation admission.
 * It never calls the P4b claim ingress, so a start cannot create generation 2
 * or replace an existing attempt.
 */
export async function startMountedP4Attempt(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  start: (
    invocation: MountedP4AttemptInvocationAdmission,
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
    record.p4AttemptBinding === undefined
  )
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
  return record.begin(async () => {
    if (!record.active)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
    const binding = record.p4AttemptBinding;
    if (binding === undefined)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
    const store = createChatThreadStore(record.runtimeRoot, identityKey(Object.freeze({ ...record.principal })));
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
    if (record.p4ProviderStartAttemptIds.has(turn.attempt.attemptId))
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_attempt_admission_rejected");
    record.p4ProviderStartAttemptIds.add(turn.attempt.attemptId);
    const invocationActive = { value: true };
    const invocationConsuming = { value: false };
    const invocation = Object.freeze({}) as MountedP4AttemptInvocationAdmission;
    mountedP4AttemptInvocationAdmissions.set(
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
          record.p4ProviderStartAttemptIds.delete(turn.attempt.attemptId);
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

export async function consumeMountedP4Admission<T>(
  admission: MountedP4Admission,
  callback: (
    facts: Readonly<{
      runtimeRoot: string;
      playerId: string;
      companionId: string;
      continuityId: string;
      chatThreadId: string;
      chatSurfaceSessionId: string;
      selectionGeneration: number;
    }>,
  ) => Promise<T>,
): Promise<T> {
  const record = mountedP4Admissions.get(admission);
  if (record === undefined || !record.active.value || record.consuming.value)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p4_admission_rejected");
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
      }),
    );
  } finally {
    record.active.value = false;
    record.consuming.value = false;
  }
}

/**
 * Coordinator-private P5 cancel seam. It synchronously revokes the current
 * presentation epoch, then records the exact durable cancel claim while the
 * running P4c prompt is drained. P6 may later supply an authenticated ingress,
 * but this seam deliberately exposes no HTTP/browser surface.
 */
export async function stopMountedChatPresentationEpoch(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  input: Readonly<{ stopId: string; sourceEventId: string; reasonCode: string }>,
): Promise<P5CancelResult> {
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
  if (record.p5Cancellation !== undefined) {
    await record.p5Cancellation;
    return readP5CancellationResult(record);
  }

  // Preflight is durable and side-effect free. A queued turn cannot be
  // cancelled, but an armed prompt may be aborted and terminalized directly
  // without waiting for a provider-response observation.
  const preflight = await readExactP5Ledger(record).catch(async (error) => {
    const store = createChatThreadStore(record.runtimeRoot, identityKey(Object.freeze({ ...record.principal })));
    const ledger = (await store.resumeThread(record.chatThreadId, record.chatSurfaceSessionId)).turnLedger;
    if (
      ledger?.status === "attempt_starting" &&
      ledger.observation?.phase === "armed" &&
      record.p4AttemptBinding !== undefined &&
      ledger.attempt.selectionGeneration === record.selectionGeneration &&
      ledger.attempt.runtimeBindingDigest === record.p4AttemptBinding.runtimeBindingDigest &&
      ledger.attempt.runtimeOwner.ownerToken === record.p4AttemptBinding.runtimeOwner.ownerToken &&
      ledger.attempt.runtimeOwner.runtimeInstanceId === record.p4AttemptBinding.runtimeOwner.runtimeInstanceId &&
      ledger.attempt.runtimeOwner.ownerPid === record.p4AttemptBinding.runtimeOwner.ownerPid &&
      ledger.attempt.runtimeOwner.ownerProcessStartIdentity === record.p4AttemptBinding.runtimeOwner.ownerProcessStartIdentity
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
  if (record.p5Cancellation !== undefined) {
    await record.p5Cancellation;
    return readP5CancellationResult(record);
  }

  const stop = record.p5PresentationEpoch.stop(input.stopId, input.sourceEventId, input.reasonCode);
  if (!stop.accepted)
    throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");

  // The P4c runner occupies record.begin() for the lifetime of session.prompt().
  // STOP must not queue its durable claim behind that runner because settlement
  // waits for this exact claim to classify its winner. Revoke synchronously,
  // then claim before any callback or prompt drain: this is the first durable
  // cancel authority after the in-memory epoch closes. The runner owns the
  // later drain and final `cancelled` transition. In particular STOP must not
  // await gate.drain(): a listener may itself await STOP while it is pending.
  // Claim the durable winner before awaiting Pi abort. `abort()` may settle the
  // prompt synchronously, so awaiting it first would let rejection terminalize
  // the turn as failed even though STOP already won its linearization point.
  const abort = record.p4ProviderStartRuntimeSession?.session?.abort;
  const cancellation: Promise<P5CancelResult> = (async (): Promise<P5CancelResult> => {
    const binding = record.p4AttemptBinding;
    if (binding === undefined)
      throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
    const store = createChatThreadStore(record.runtimeRoot, identityKey(Object.freeze({ ...record.principal })));
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
    const operationAuthority = record.p4P5TransitionAuthority.mintOperation();
    try {
      if (ledger.status === "attempt_starting") {
        if (ledger.observation?.phase !== "armed")
          throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
        const cancelled = await transitionP4MountedProviderStart(
          Object.freeze({
            authority: record.p4P5TransitionAuthority.authority,
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
          Object.freeze({ operation: "cancel", observedAtMs: Date.now(), cancelledAtMs: Date.now() }),
        );
        if (cancelled.status !== "cancelled")
          throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
        return cancelled;
      }
      if (ledger.status !== "running" && ledger.status !== "presentation_committed")
        throw new SemanticProductionCoordinatorError("semantic_chat_runtime_p5_presentation_epoch_unavailable");
      const cancelled = await transitionP5MountedPresentation(
        Object.freeze({
          authority: record.p4P5TransitionAuthority.authority,
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
      const winner = await readP5CancellationResult(record);
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
  // rejection then observes this promise in P4c and cannot replace STOP with
  // a failed terminal state.
  record.p5Cancellation = cancellation;
  // Stop's browser-visible winner is the durable cancellation, not the
  // provider transport's eventual abort settlement. Invoke the exact mounted
  // session once but do not let a stuck/slow provider abort hold the HTTP
  // request or its authoritative reread hostage. Any rejection is deliberately
  // ignored: SQLite already selected the terminal winner before this call.
  if (typeof abort === "function") {
    try {
      void Promise.resolve(abort.call(record.p4ProviderStartRuntimeSession!.session)).catch(() => undefined);
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
  const project = (domain: "chat" | "selection-state" | "message" | "turn", value: string): string =>
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
  });
}

export type SemanticChatRuntimeProductionAuthority = Readonly<{
  authority: "SEMANTIC";
  startChatRuntime(): Promise<ProductionChatRuntimeReadback>;
  startMountedChatRuntime(): Promise<MountedChatRuntimeLease>;
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
   * bridge only for a mount after the exact terminal predecessor teardown;
   * without that durable teardown no successor mount is ever admissible and
   * the bridge cannot fork the runtime chain.
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
  initializeInitialChat(
    content: InitialChatExactContentPort,
    request?: CreateChatThreadRequest,
  ): Promise<ProductionSagaReadback>;
  /** Reads the durable saga only; the composition's explicit resume path re-reads Tavern separately. */
  resumeInitialChat(): Promise<ProductionSagaReadback | null>;
  resumeInitialChatWithContent(content: InitialChatExactContentPort): Promise<ProductionSagaReadback | null>;
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
    semantic = create(provision, mutex);
    await semantic.initializeInitialChat(createManifestDerivedInitialChatExactContentPort(manifest));
    binding = await createChatRuntimeBinding(manifest);
    return createFreshChatRuntimeAuthority(provision, semantic, binding, mutex, broker, options);
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
    return createFreshChatRuntimeAuthority(provision, semantic, binding, mutex, broker, options);
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

async function createFreshChatRuntimeAuthority(
  provision: FreshContinuityProvision,
  semantic: SemanticProductionAuthority,
  binding: Awaited<ReturnType<typeof createChatRuntimeBinding>>,
  mutex: WindowsAuthorityRootMutex,
  broker: WindowsNamedMutexBroker,
  options: SemanticChatRuntimeMountOptions,
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
  let closePromise: Promise<void> | undefined;
  let terminalError: unknown;
  let bindingClosed = false;
  let semanticClosed = false;
  let mutexClosed = false;
  let brokerClosed = false;
  let authority!: SemanticChatRuntimeProductionAuthority;
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
  const startChatRuntime = (): Promise<ProductionChatRuntimeReadback> => {
    if (startPromise) return startPromise;
    startPromise = begin(async () => {
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
            deadlineAtMs: Date.now() + 30_000,
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
  authority = Object.freeze({
    authority: "SEMANTIC" as const,
    startChatRuntime,
    startMountedChatRuntime: () => {
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
        runtimeSession.reportTavernNarrativeGateRuntime?.();
        const browserProjection = createMountedChatBrowserProjection(
          readback.chatThreadId,
          readback.chatSurfaceSessionId,
          record.vector.selectionRevision,
        );
        let lease!: MountedChatRuntimeLease;
        lease = Object.freeze({
          // The lease exposes only profile metadata. P4c gets the exact live
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
            if (leaseRecord === undefined || !leaseRecord.active) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_lease_rejected");
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
          close(this: unknown): Promise<void> {
            if (this !== lease || !isCurrentMountedChatRuntimeLease(lease))
              return Promise.reject(new SemanticProductionCoordinatorError("semantic_chat_runtime_lease_rejected"));
            const leaseRecord = mountedChatRuntimeLeases.get(lease)!;
            leaseRecord.active = false;
            leaseRecord.p4P5TransitionAuthority.revoke();
            return leaseRecord.close();
          },
        });
        mountedChatRuntimeLeases.set(lease, {
          active: true,
          runtimeRoot: provision.runtimeCwd,
          principal: Object.freeze({ ...provision.principal }),
          chatThreadId: readback.chatThreadId,
          chatSurfaceSessionId: readback.chatSurfaceSessionId,
          selectionGeneration: record.vector.selectionRevision,
          p4AttemptBinding: Object.freeze({
            runtimeBindingDigest: record.bootstrapPermit.runtimeBindingDigest,
            runtimeOwner: Object.freeze({ ...record.bootstrapPermit.owner }),
          }),
          ...(runtimeSession === undefined ? {} : { p4ProviderStartRuntimeSession: runtimeSession }),
          p4ProviderStartAttemptIds: new Set<string>(),
          p4P5TransitionAuthority: createP4P5MountedTransitionAuthority(),
          p5PresentationEpoch: createCompanionInterruption(),
          begin,
          close: () => authority.close(),
        });
        mountedLease = lease;
        return lease;
      });
      return mountedStartPromise;
    },
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      const activeLease = mountedLease === undefined ? undefined : mountedChatRuntimeLeases.get(mountedLease);
      if (activeLease) {
        activeLease.active = false;
        activeLease.p4P5TransitionAuthority.revoke();
      }
      const attempt = (async () => {
        await waitForDrain();
        const record = [...liveByBootstrapOperation.values()][0];
        if (record) {
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
            provision.store.commitChatRuntimeTeardown(
              Object.freeze({ principal: provision.principal, permit, receipt }),
            ),
          );
          if (terminal.status !== "terminal" || terminal.runtimeState !== "closed")
            throw new SemanticProductionCoordinatorError("semantic_chat_runtime_teardown_not_terminal");
          liveByBootstrapOperation.delete(record.bootstrapPermit.operationId);
        }
        if (!bindingClosed) {
          await binding.close();
          bindingClosed = true;
        }
        if (!semanticClosed) {
          await semantic.close();
          semanticClosed = true;
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
    initializeInitialChat: (content, request) =>
      begin(async () => {
        await stepUnchecked(0);
        const registered = await stepUnchecked(1);
        const receipt = await createRegisteredContent(content, registered, request);
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
        if (!provisionClosed) {
          provision.close();
          provisionClosed = true;
        }
        if (!dependenciesClosed && closeDependencies) {
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
    request?: CreateChatThreadRequest,
  ): Promise<TavernExactContentReceipt> {
    if (!registered.chatThreadId || !registered.chatSurfaceSessionId)
      throw new SemanticProductionCoordinatorError("initial_chat_binding_missing");
    // The initializer owns the exact request. Callers may not supply a different
    // thread, surface, principal, or opening through this production seam.
    const exactRequest =
      request ??
      Object.freeze({
        chatThreadId: registered.chatThreadId,
        companionId: provision.principal.companionId,
        continuityId: provision.principal.continuityId,
        chatSurfaceSessionId: registered.chatSurfaceSessionId,
        opening: "blank" as const,
      });
    // No lease spans this await. Creation is an initializer-only operation;
    // every production reopen uses resumeExact above and fails closed if absent.
    const receipt = await content.createExplicit(exactRequest);
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
  closeDependencies: () => Promise<void>,
  ownerDeathVerifier: WindowsOwnerDeathVerifier,
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
  return Object.freeze({
    authority: "SEMANTIC" as const,
    prepareEnter,
    commitEnter,
    failEnter,
    prepareClose,
    commitClose,
    failClose,
    recoverDeadOwner,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      const attempt = (async () => {
        await waitForDrain();
        if (liveCount !== 0) throw new SemanticProductionCoordinatorError("semantic_game_live_runtime_requires_close");
        if (!provisionClosed) {
          provision.close();
          provisionClosed = true;
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
