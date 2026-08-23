import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertP4P5MountedTransitionAuthority,
  assertP4P5MountedTransitionOperationAuthority,
  type P4P5MountedTransitionAuthority,
  type P4P5MountedTransitionOperationAuthority,
} from "./chat-thread-store.p4-p5-transition-authority.internal.js";

/**
 * Scoped Tavern persistence seam. It owns only a ChatThread's visible opening
 * and append-only normal messages; it neither reads Pi/Magic Context state nor
 * implements message edit/swipe/branch or any Game operation.
 */
export const CHAT_THREAD_SCHEMA_VERSION = 1 as const;
export const CHAT_THREAD_SELECTION_SCHEMA_VERSION = 1 as const;

/**
 * Frozen P3.5 artifact contracts from design/67 §3.B.3. Every JSON-encoded
 * ChatThread artifact has a named byte budget enforced both before write and
 * before parse, and the transcript envelope has a fixed entry ceiling.
 *
 * The message/journal budgets cover at most 500 total persisted transcript
 * entries (including an opening), each NFC, control-free, and at most 16,384
 * UTF-8 bytes including JSON escaping and bounded metadata.
 */
export const MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES = 500 as const;
export const MAX_CHAT_MESSAGE_TEXT_UTF8_BYTES = 16_384 as const;
export const MAX_THREAD_ARTIFACT_BYTES = 64 * 1024;
export const MAX_DRAFT_ARTIFACT_BYTES = 32 * 1024;
export const MAX_TURN_LEDGER_ARTIFACT_BYTES = 16 * 1024;
export const MAX_IDEMPOTENCY_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_MESSAGES_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_TRANSACTION_ARTIFACT_BYTES = 21 * 1024 * 1024;

export type GreetingSource = Readonly<{
  greetingSetId: string;
  sourceRevision: number;
  canonicalHash: string;
  variantId: string;
  profileRevision: number;
  scenarioRevision: number | null;
}>;

export type OpeningSelection =
  | Readonly<{ kind: "blank" }>
  | Readonly<{ kind: "greeting"; messageId: string; source: GreetingSource }>;

export type TavernStableArtifactBinding = Readonly<{
  kind: "persona" | "scenario" | "dialogue_examples";
  sourceId: string;
  revision: number;
  canonicalHash: string;
}>;
/** Metadata only: the external WorldBook body stays at the independently-audited binding. */
export type TavernStableWorldBookBinding = Readonly<{
  worldBookId: string;
  revision: number;
  canonicalHash: string;
  provenance: "authored" | "st-card-import" | "reviewed-import";
}>;
/**
 * A managed World Info revision is an explicit source variant, rather than a
 * type-punned WorldBook. Its public title is the only public resolver key.
 */
export type TavernStableManagedWorldInfoBinding = Readonly<{
  source: "managed_world_info";
  publicTitle: string;
  revision: number;
  canonicalHash: string;
}>;
export type TavernStableWorldInfoBinding = TavernStableWorldBookBinding | TavernStableManagedWorldInfoBinding;

export type ChatThread = Readonly<{
  schemaVersion: typeof CHAT_THREAD_SCHEMA_VERSION;
  chatThreadId: string;
  companionId: string;
  continuityId: string;
  /** Tavern-only selected presentation sources; never runtime identity or Game state. */
  personaId?: string;
  scenarioId?: string;
  /** Exact immutable source records; no source may be resolved as latest. */
  stableArtifactBindings?: readonly TavernStableArtifactBinding[];
  worldBookBinding?: TavernStableWorldInfoBinding;
  /** Exact continuity-ledger Chat session this thread is attached to. */
  chatSurfaceSessionId: string;
  createdAtMs: number;
  updatedAtMs: number;
  openingSelection: OpeningSelection;
  /** Player-authored display metadata only; it never derives from transcript content. */
  title?: string | null;
  /** Lifecycle metadata is independent from content revision/timestamps. */
  lifecycleStatus?: "active" | "archived" | "trashed";
  /** Monotonically increasing durable lifecycle-management revision. */
  managementRevision?: number;
  /** Exact durable pre-trash state; present only while lifecycleStatus is trashed. */
  trashRestoreStatus?: "active" | "archived";
  /** The first non-opening event makes either opening choice immutable. */
  openingLockedAtEventId: string | null;
}>;

export type ChatThreadMessage = Readonly<{
  messageId: string;
  role: "player" | "companion";
  kind: "opening" | "player" | "response";
  text: string;
  occurredAtMs: number;
  /** Present only on message zero; unselected greetings are never persisted. */
  greetingSource: GreetingSource | null;
}>;

export type ChatDraft = Readonly<{ revision: number; text: string | null }>;
export type AcceptedQueuedTurn = Readonly<{
  turnId: string;
  status: "accepted_queued";
  idempotencyKey: string;
  messageId: string;
  acceptedAtMs: number;
}>;

/** Durable, immutable record of P4b's claim boundary; it is never a prompt capability. */
export type AttemptClaimV1 = Readonly<{
  generation: 1;
  attemptId: string;
  claimedAtMs: number;
  selectionGeneration: number;
  runtimeBindingDigest: string;
  runtimeOwner: Readonly<{
    ownerToken: string;
    runtimeInstanceId: string;
    ownerPid: number;
    ownerProcessStartIdentity: string;
  }>;
}>;

/**
 * P4c's bounded observation sub-record. `armed` is durable strictly before
 * the single Host prompt invocation; `not_started` is a surviving-process,
 * pre-invocation local proof only; `running` is written solely on the
 * source-owned one-shot `after_provider_response` observer.
 */
export type AttemptObservationV1 =
  | Readonly<{ phase: "armed"; observedAtMs: number }>
  | Readonly<{
      phase: "not_started";
      reasonCode: "admission_revoked" | "session_unavailable" | "invocation_deadline_expired";
      observedAtMs: number;
    }>
  | Readonly<{
      phase: "running";
      source: "after_provider_response";
      statusClass: "success" | "error";
      observedAtMs: number;
    }>;

export type AttemptStartingTurn = Readonly<{
  turnId: string;
  status: "attempt_starting";
  idempotencyKey: string;
  messageId: string;
  acceptedAtMs: number;
  attempt: AttemptClaimV1;
  /** P4c bounded observation: durable `armed` before invocation, or durable local `not_started`. */
  observation?: AttemptObservationV1;
}>;

export type RunningTurn = Readonly<{
  turnId: string;
  status: "running";
  idempotencyKey: string;
  messageId: string;
  acceptedAtMs: number;
  attempt: AttemptClaimV1;
  observation: AttemptObservationV1 & { phase: "running" };
}>;

/**
 * P5's bounded presentation sub-record. `expressionId` equals the durable
 * companion message identifier; `cancelEpoch` is bound at admission and
 * revalidated immediately before commit; it is never provider content.
 */
export type PresentationCommitV1 = Readonly<{
  expressionId: string;
  messageId: string;
  cancelEpoch: number;
  committedAtMs: number;
}>;

export type PresentationCommittedTurn = Omit<RunningTurn, "status"> &
  Readonly<{
    status: "presentation_committed";
    presentation: PresentationCommitV1;
  }>;
export type CompletionClaimedTurn = Omit<PresentationCommittedTurn, "status"> &
  Readonly<{ status: "completion_claimed"; completionClaimedAtMs: number }>;
export type CompletedTurn = Omit<CompletionClaimedTurn, "status"> &
  Readonly<{ status: "completed"; completedAtMs: number }>;
export type CancelClaimedTurn = Omit<RunningTurn, "status"> &
  Readonly<{
    status: "cancel_claimed";
    presentation: PresentationCommitV1 | null;
    cancelClaimedAtMs: number;
  }>;
/**
 * A STOP can terminalize either a durable P5 cancel claim (after `running`) or
 * an already-invoked P4 attempt that is still merely `armed`. In both cases it
 * preserves the exact attempt and has no visible presentation unless one was
 * durably committed before the P5 claim.
 */
export type CancelledTurn = Readonly<{
  turnId: string;
  status: "cancelled";
  idempotencyKey: string;
  messageId: string;
  acceptedAtMs: number;
  attempt: AttemptClaimV1;
  observation: AttemptObservationV1 & { phase: "armed" | "running" };
  presentation: PresentationCommitV1 | null;
  cancelClaimedAtMs: number;
  cancelledAtMs: number;
}>;
/** A provider rejection may fail directly from the durable armed state; P5 failures follow running. */
export type FailedTurn = Readonly<{
  turnId: string;
  status: "failed";
  idempotencyKey: string;
  messageId: string;
  acceptedAtMs: number;
  attempt: AttemptClaimV1;
  observation: AttemptObservationV1;
  presentation: PresentationCommitV1 | null;
  reasonCode: "interrupted" | "no_visible_presentation" | "runtime_unavailable" | "storage_unavailable";
  failedAtMs: number;
}>;

export type ChatTurnLedger =
  | AcceptedQueuedTurn
  | AttemptStartingTurn
  | RunningTurn
  | PresentationCommittedTurn
  | CompletionClaimedTurn
  | CompletedTurn
  | CancelClaimedTurn
  | CancelledTurn
  | FailedTurn;

type MountedP4AcceptanceInput = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  playerId: string;
  companionId: string;
  continuityId: string;
  selectionGeneration: number;
  text: string;
  locale: string;
  idempotencyKey: string;
  expectedDraftRevision: number;
}>;

/** Player-controlled fields only. Binding facts come solely from a consumed mounted admission. */
type P4MountedAcceptanceCommand = Readonly<{
  text: string;
  locale: string;
  idempotencyKey: string;
  expectedDraftRevision: number;
}>;

export type ChatThreadState = Readonly<{
  thread: ChatThread;
  messages: readonly ChatThreadMessage[];
  draft: ChatDraft;
  turnLedger: ChatTurnLedger | null;
  /** P4a's immutable acceptance result; it is intentionally not rewritten by P4b. */
  idempotency: readonly Readonly<{ key: string; fingerprint: string; result: AcceptedQueuedTurn }>[];
}>;

/**
 * The durable Tavern selector is intentionally distinct from the active Host
 * runtime. A caller must still construct the exact Pi session named here; the
 * store never treats selection as a context handoff or runtime switch.
 */
export type ActiveChatThreadSelection = Readonly<{
  schemaVersion: typeof CHAT_THREAD_SELECTION_SCHEMA_VERSION;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  selectedAtMs: number;
}>;

export type CreateChatThreadRequest = Readonly<{
  chatThreadId: string;
  companionId: string;
  continuityId: string;
  chatSurfaceSessionId: string;
  personaId?: string;
  scenarioId?: string;
  stableArtifactBindings?: readonly TavernStableArtifactBinding[];
  worldBookBinding?: TavernStableWorldInfoBinding;
  opening: "blank" | Readonly<{ messageId: string; text: string; source: GreetingSource }>;
}>;

export type InitialChatExactContentCapability = Readonly<{
  /** Opens only an already persisted, exact thread/surface binding. */
  resumeExact(chatThreadId: string, chatSurfaceSessionId: string): Promise<ChatThreadState>;
  /** Creates a new durable thread; callers must not use this to resume. */
  createExplicit(request: CreateChatThreadRequest): Promise<ChatThreadState>;
}>;

export type ChatThreadStore = Readonly<{
  createThread(request: CreateChatThreadRequest): Promise<ChatThreadState>;
  /** Lists durable thread metadata only; transcript data remains explicitly opened. */
  listThreads?(): Promise<readonly ChatThread[]>;
  /** Returns no selection rather than guessing from a latest thread. */
  readActiveThreadSelection(): Promise<ActiveChatThreadSelection | null>;
  /**
   * Reads a durable selector and its exact thread binding without nesting a
   * selector→thread lock. A final selector read detects a concurrent change.
   */
  readActiveThreadBinding?(): Promise<ChatThreadState | null>;
  /**
   * Persists only an exact already-bound thread/surface pair after durable
   * readback. It neither creates a surface nor changes a live Pi runtime.
   */
  selectActiveThread(chatThreadId: string, chatSurfaceSessionId: string): Promise<ActiveChatThreadSelection>;
  /** Opens precisely one persisted thread; there is deliberately no "latest" fallback. */
  resumeThread(chatThreadId: string, chatSurfaceSessionId: string): Promise<ChatThreadState>;
  commitOpening(chatThreadId: string, opening: CreateChatThreadRequest["opening"]): Promise<ChatThreadState>;
  appendPlayer(
    chatThreadId: string,
    message: Readonly<{
      messageId: string;
      text: string;
      occurredAtMs: number;
    }>,
  ): Promise<ChatThreadState>;
  /** Resolves only after the response and its pristine lock are durably committed. */
  commitResponse(
    chatThreadId: string,
    response: Readonly<{
      messageId: string;
      text: string;
      occurredAtMs: number;
    }>,
  ): Promise<ChatThreadState>;
  /**
   * Ordinary exact-turn Stop mutation. It is intentionally independent from
   * the retired P4/P5 transition authority: the service supplies a current
   * mounted turn/attempt pair, SQLite decides the terminal winner, and the
   * returned value is a fresh durable read-back.
   */
  cancelActiveTurn?(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      expectedTurnId: string;
      expectedAttemptId: string;
      cancelledAtMs: number;
    }>,
  ): Promise<ChatThreadState>;
  /** Exact pristine-thread only WorldBook binding mutation with optimistic revision guard. */
  setWorldBookBinding?(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      companionId: string;
      continuityId: string;
      expectedUpdatedAtMs: number;
      binding?: TavernStableWorldInfoBinding;
    }>,
  ): Promise<ChatThreadState>;
  /** Metadata-only player title mutation using the lifecycle management CAS. */
  renameThreadTitle?(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      expectedManagementRevision: number;
      title: string;
    }>,
  ): Promise<ChatThread>;
  /** Saves exact draft text through a durable optimistic revision CAS. */
  saveDraft?(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      expectedDraftRevision: number;
      text: string;
    }>,
  ): Promise<ChatDraft>;
  /** Clears exact draft text through a durable optimistic revision CAS. */
  discardDraft?(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      expectedDraftRevision: number;
    }>,
  ): Promise<ChatDraft>;
  /** Durable lifecycle operation; no messages, bindings, title, or draft are changed. */
  transitionLifecycle?(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      companionId: string;
      continuityId: string;
      expectedManagementRevision: number;
      operation: "archive" | "restore" | "trash";
    }>,
  ): Promise<ChatThread>;
  /** Closes the SQLite database connection if open. */
  close?(): void;
}>;

type IdempotencyRecord = Readonly<{ key: string; fingerprint: string; result: AcceptedQueuedTurn }>;

type ThreadMetadata = {
  chatSurfaceSessionId: string;
  stableArtifactBindings?: readonly TavernStableArtifactBinding[];
  worldBookBinding?: TavernStableWorldInfoBinding;
  trashRestoreStatus?: "active" | "archived";
  openingLockedAtEventId?: string | null;
  turnLedger?: ChatTurnLedger | null;
  idempotency?: readonly IdempotencyRecord[];
  messages?: readonly ChatThreadMessage[];
};

const genuineChatThreadStores = new WeakSet<object>();
const p4AcceptanceByStore = new WeakMap<object, (input: MountedP4AcceptanceInput) => Promise<AcceptedQueuedTurn>>();
type MountedP4AttemptClaimInput = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  playerId: string;
  companionId: string;
  continuityId: string;
  selectionGeneration: number;
  runtimeBindingDigest: string;
  runtimeOwner: AttemptClaimV1["runtimeOwner"];
}>;
const p4AttemptClaimByStore = new WeakMap<
  object,
  (input: MountedP4AttemptClaimInput) => Promise<AttemptStartingTurn>
>();

/** P4c's three frozen store transitions: arm, local pre-invocation not_started, running. */
export type P4ProviderStartTransition =
  | Readonly<{ operation: "arm"; observedAtMs: number }>
  | Readonly<{
      operation: "not_started";
      reasonCode: "admission_revoked" | "session_unavailable" | "invocation_deadline_expired";
      observedAtMs: number;
    }>
  | Readonly<{ operation: "running"; statusClass: "success" | "error"; observedAtMs: number }>
  | Readonly<{ operation: "fail"; reasonCode: "runtime_unavailable"; observedAtMs: number; failedAtMs: number }>
  | Readonly<{ operation: "cancel"; observedAtMs: number; cancelledAtMs: number }>;

/** P5 frozen terminalization reason codes (design/71 §4.1). */
export type P5TerminalFailureReason =
  | "interrupted"
  | "no_visible_presentation"
  | "runtime_unavailable"
  | "storage_unavailable";

/**
 * P5's six frozen store transitions. Every command carries the exact attemptId
 * the coordinator bound at admission; any mismatch fails closed with zero
 * durable mutation.
 */
export type P5PresentationTransition =
  | Readonly<{
      operation: "commit_presentation";
      cancelEpoch: number;
      message: Readonly<{ messageId: string; text: string; occurredAtMs: number }>;
      committedAtMs: number;
    }>
  | Readonly<{ operation: "claim_completion"; claimedAtMs: number }>
  | Readonly<{ operation: "complete"; completedAtMs: number }>
  | Readonly<{ operation: "claim_cancel"; claimedAtMs: number }>
  | Readonly<{ operation: "cancel"; cancelledAtMs: number }>
  | Readonly<{ operation: "fail"; reasonCode: P5TerminalFailureReason; failedAtMs: number }>;

type MountedP5PresentationInput = Readonly<{
  authority: P4P5MountedTransitionAuthority;
  operationAuthority: P4P5MountedTransitionOperationAuthority;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  playerId: string;
  companionId: string;
  continuityId: string;
  selectionGeneration: number;
  runtimeBindingDigest: string;
  runtimeOwner: AttemptClaimV1["runtimeOwner"];
  attemptId: string;
}>;
const p5PresentationByStore = new WeakMap<
  object,
  (input: MountedP5PresentationInput, command: P5PresentationTransition) => Promise<ChatTurnLedger>
>();
type MountedP4ProviderStartInput = Readonly<{
  authority: P4P5MountedTransitionAuthority;
  operationAuthority: P4P5MountedTransitionOperationAuthority;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  playerId: string;
  companionId: string;
  continuityId: string;
  selectionGeneration: number;
  runtimeBindingDigest: string;
  runtimeOwner: AttemptClaimV1["runtimeOwner"];
  attemptId: string;
}>;
const p4ProviderStartByStore = new WeakMap<
  object,
  (
    input: MountedP4ProviderStartInput,
    command: P4ProviderStartTransition,
  ) => Promise<AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn>
>();

/**
 * Host-private P4 store ingress. Its binding input has no exported type and is
 * derived only by p4-durable-turn-acceptance.internal.ts after coordinator
 * admission consumption; it is not part of ChatThreadStore's public surface.
 */
export async function acceptP4MountedPlayerMessage(
  binding: Readonly<{
    runtimeRoot: string;
    playerId: string;
    companionId: string;
    continuityId: string;
    chatThreadId: string;
    chatSurfaceSessionId: string;
    selectionGeneration: number;
  }>,
  command: P4MountedAcceptanceCommand,
): Promise<AcceptedQueuedTurn> {
  const store = createChatThreadStore(
    binding.runtimeRoot,
    identityKeyForP4(binding.playerId, binding.companionId, binding.continuityId),
  );
  const accept = p4AcceptanceByStore.get(store);
  if (accept === undefined) throw new Error("p4_acceptance_port_unavailable");
  try {
    return await accept(Object.freeze({ ...binding, ...command }));
  } finally {
    store.close?.();
  }
}

/**
 * Host-private P4b durable ingress. The coordinator supplies the runtime facts
 * only after consuming a mounted claim admission; this port never prompts Pi.
 */
export async function claimP4MountedAttempt(
  binding: Readonly<{
    runtimeRoot: string;
    playerId: string;
    companionId: string;
    continuityId: string;
    chatThreadId: string;
    chatSurfaceSessionId: string;
    selectionGeneration: number;
    runtimeBindingDigest: string;
    runtimeOwner: AttemptClaimV1["runtimeOwner"];
  }>,
): Promise<AttemptStartingTurn> {
  const store = createChatThreadStore(
    binding.runtimeRoot,
    identityKeyForP4(binding.playerId, binding.companionId, binding.continuityId),
  );
  const claim = p4AttemptClaimByStore.get(store);
  if (claim === undefined) throw new Error("p4_attempt_claim_port_unavailable");
  try {
    return await claim(Object.freeze({ ...binding }));
  } finally {
    store.close?.();
  }
}

/**
 * Host-private P4c durable ingress. The coordinator supplies the runtime facts
 * and exact attemptId only after consuming the mounted invocation admission;
 * this port never prompts Pi and never reads provider data.
 */
export async function transitionP4MountedProviderStart(
  binding: Readonly<{
    authority: P4P5MountedTransitionAuthority;
    operationAuthority: P4P5MountedTransitionOperationAuthority;
    runtimeRoot: string;
    playerId: string;
    companionId: string;
    continuityId: string;
    chatThreadId: string;
    chatSurfaceSessionId: string;
    selectionGeneration: number;
    runtimeBindingDigest: string;
    runtimeOwner: AttemptClaimV1["runtimeOwner"];
    attemptId: string;
  }>,
  command: P4ProviderStartTransition,
): Promise<AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn> {
  assertP4P5MountedTransitionAuthority(binding.authority);
  assertP4P5MountedTransitionOperationAuthority(binding.operationAuthority);
  const store = createChatThreadStore(
    binding.runtimeRoot,
    identityKeyForP4(binding.playerId, binding.companionId, binding.continuityId),
  );
  const transition = p4ProviderStartByStore.get(store);
  if (transition === undefined) throw new Error("p4_provider_start_port_unavailable");
  try {
    return await transition(Object.freeze({ ...binding }), validateProviderStartTransition(command));
  } finally {
    store.close?.();
  }
}

/**
 * Host-private P5 durable ingress. The coordinator supplies runtime facts and
 * the exact attemptId only after consuming the mounted P5 presentation
 * admission; it never reads provider data and never prompts Pi.
 */
export async function transitionP5MountedPresentation(
  binding: Readonly<{
    authority: P4P5MountedTransitionAuthority;
    operationAuthority: P4P5MountedTransitionOperationAuthority;
    runtimeRoot: string;
    playerId: string;
    companionId: string;
    continuityId: string;
    chatThreadId: string;
    chatSurfaceSessionId: string;
    selectionGeneration: number;
    runtimeBindingDigest: string;
    runtimeOwner: AttemptClaimV1["runtimeOwner"];
    attemptId: string;
  }>,
  command: P5PresentationTransition,
): Promise<ChatTurnLedger> {
  assertP4P5MountedTransitionAuthority(binding.authority);
  assertP4P5MountedTransitionOperationAuthority(binding.operationAuthority);
  const store = createChatThreadStore(
    binding.runtimeRoot,
    identityKeyForP4(binding.playerId, binding.companionId, binding.continuityId),
  );
  const transition = p5PresentationByStore.get(store);
  if (transition === undefined) throw new Error("p5_presentation_port_unavailable");
  try {
    return await transition(asMountedP5PresentationInput(binding), validatePresentationTransition(command));
  } finally {
    store.close?.();
  }
}

function asMountedP5PresentationInput(
  value: Readonly<{
    runtimeRoot: string;
    playerId: string;
    companionId: string;
    continuityId: string;
    chatThreadId: string;
    chatSurfaceSessionId: string;
    selectionGeneration: number;
    runtimeBindingDigest: string;
    runtimeOwner: AttemptClaimV1["runtimeOwner"];
    attemptId: string;
    authority: P4P5MountedTransitionAuthority;
    operationAuthority: P4P5MountedTransitionOperationAuthority;
  }>,
): MountedP5PresentationInput {
  return Object.freeze({ ...value });
}

function identityKeyForP4(playerId: string, companionId: string, continuityId: string): string {
  return createHash("sha256").update([playerId, companionId, continuityId].join("\u001f")).digest("hex");
}

const initialExactContentCapabilities = new WeakSet<object>();
const initialExactContentCapabilityByStore = new WeakMap<object, InitialChatExactContentCapability>();

/** Only a store created by this module can mint this unmounted capability. */
export function createInitialChatExactContentCapability(store: ChatThreadStore): InitialChatExactContentCapability {
  if (!genuineChatThreadStores.has(store)) throw new Error("untrusted_chat_thread_store");
  const capability = initialExactContentCapabilityByStore.get(store);
  if (capability === undefined) throw new Error("missing_chat_thread_store_capability");
  return capability;
}

/** Port-only identity check; matching methods or proxies are never capabilities. */
export function isInitialChatExactContentCapability(value: unknown): value is InitialChatExactContentCapability {
  return !!value && typeof value === "object" && initialExactContentCapabilities.has(value);
}

export function classifyInitialChatExactContentFailure(error: unknown): "not_found" | "already_exists" | undefined {
  if (error instanceof ExactThreadNotFoundError) return "not_found";
  if (error instanceof ExactThreadAlreadyExistsError) return "already_exists";
  return undefined;
}

class ExactThreadNotFoundError extends Error {
  constructor() {
    super("chat_thread_not_found");
  }
}
class ExactThreadAlreadyExistsError extends Error {
  constructor() {
    super("chat_thread_already_exists");
  }
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tavern_threads (
      thread_id TEXT PRIMARY KEY,
      companion_id TEXT NOT NULL,
      continuity_id TEXT NOT NULL,
      session_file TEXT,
      title TEXT,
      persona_id TEXT,
      scenario_id TEXT,
      lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_status IN ('active', 'archived', 'trashed')),
      management_revision INTEGER NOT NULL DEFAULT 1 CHECK(management_revision >= 1),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      opening_selection_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS tavern_drafts (
      thread_id TEXT PRIMARY KEY REFERENCES tavern_threads(thread_id) ON DELETE CASCADE,
      draft_content TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tavern_active_selection (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      chat_thread_id TEXT NOT NULL,
      chat_surface_session_id TEXT NOT NULL,
      selected_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tavern_threads_continuity ON tavern_threads(continuity_id, thread_id);
  `);
}

function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

/**
 * The caller supplies the already-derived opaque continuity key (normally
 * RuntimeSession.identityKey). This keeps storage derivation out of browser
 * input and avoids creating a second identity scheme before Tavern artifacts.
 */
export function createChatThreadStore(
  root: string,
  continuityKey: string,
  now: () => number = Date.now,
): ChatThreadStore {
  assertId("continuityKey", continuityKey);
  const continuityRoot = join(root, "tavern", "v1", "continuities", continuityKey);
  const dbPath = join(continuityRoot, "tavern.sqlite");

  function withDb<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(continuityRoot, { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;",
      );
      initSchema(db);
      return runInTransaction(db, () => fn(db));
    } finally {
      try {
        db.close();
      } catch {}
    }
  }

  const store: ChatThreadStore = Object.freeze({
    async createThread(request): Promise<ChatThreadState> {
      validateCreate(request);
      return withDb((db) => {
        const existing = db.prepare("SELECT 1 FROM tavern_threads WHERE thread_id = ?").get(request.chatThreadId);
        if (existing) {
          throw new ExactThreadAlreadyExistsError();
        }
        const timestamp = now();
        const opening = normalizeOpening(request.opening);
        const openingSelectionJson = JSON.stringify(
          opening === "blank"
            ? { kind: "blank" as const }
            : {
                kind: "greeting" as const,
                messageId: opening.messageId,
                source: opening.source,
              },
        );

        const initialMessages: ChatThreadMessage[] =
          opening === "blank"
            ? []
            : [
                validateMessage({
                  messageId: opening.messageId,
                  role: "companion",
                  kind: "opening",
                  text: opening.text,
                  occurredAtMs: timestamp,
                  greetingSource: opening.source,
                }),
              ];

        const initialMetadata: ThreadMetadata = {
          chatSurfaceSessionId: request.chatSurfaceSessionId,
          stableArtifactBindings: request.stableArtifactBindings ?? [],
          worldBookBinding: request.worldBookBinding,
          openingLockedAtEventId: null,
          turnLedger: null,
          idempotency: [],
          messages: initialMessages,
        };

        const sessionFile = `${request.chatThreadId}.jsonl`;

        db.prepare(
          `INSERT INTO tavern_threads (
            thread_id, companion_id, continuity_id, session_file, title,
            persona_id, scenario_id, lifecycle_status, management_revision,
            created_at_ms, updated_at_ms, opening_selection_json, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          request.chatThreadId,
          request.companionId,
          request.continuityId,
          sessionFile,
          null,
          request.personaId ?? null,
          request.scenarioId ?? null,
          "active",
          1,
          timestamp,
          timestamp,
          openingSelectionJson,
          JSON.stringify(initialMetadata),
        );

        db.prepare(
          `INSERT INTO tavern_drafts (thread_id, draft_content, revision, updated_at_ms)
          VALUES (?, NULL, 0, ?)`,
        ).run(request.chatThreadId, timestamp);

        return readStateFromDb(db, request.chatThreadId);
      });
    },

    async listThreads(): Promise<readonly ChatThread[]> {
      return withDb((db) => {
        const rows = db.prepare("SELECT * FROM tavern_threads ORDER BY thread_id ASC").all() as any[];
        return Object.freeze(rows.map(rowToThread));
      });
    },

    async readActiveThreadSelection(): Promise<ActiveChatThreadSelection | null> {
      return withDb((db) => {
        const row = db.prepare("SELECT * FROM tavern_active_selection WHERE singleton = 1").get() as any;
        if (!row) return null;
        return validateActiveSelection({
          schemaVersion: CHAT_THREAD_SELECTION_SCHEMA_VERSION,
          chatThreadId: row.chat_thread_id,
          chatSurfaceSessionId: row.chat_surface_session_id,
          selectedAtMs: row.selected_at_ms,
        });
      });
    },

    async readActiveThreadBinding(): Promise<ChatThreadState | null> {
      const first = await store.readActiveThreadSelection();
      if (first === null) return null;
      const state = await store.resumeThread(first.chatThreadId, first.chatSurfaceSessionId);
      const final = await store.readActiveThreadSelection();
      if (
        final === null ||
        final.chatThreadId !== first.chatThreadId ||
        final.chatSurfaceSessionId !== first.chatSurfaceSessionId ||
        final.selectedAtMs !== first.selectedAtMs
      )
        throw new Error("active_chat_thread_selection_changed");
      return state;
    },

    async selectActiveThread(chatThreadId, chatSurfaceSessionId): Promise<ActiveChatThreadSelection> {
      assertId("chatSurfaceSessionId", chatSurfaceSessionId);
      assertId("chatThreadId", chatThreadId);
      return withDb((db) => {
        const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(chatThreadId) as any;
        if (!threadRow) throw new ExactThreadNotFoundError();
        const thread = rowToThread(threadRow);
        if (thread.chatSurfaceSessionId !== chatSurfaceSessionId)
          throw new Error("chat_thread_surface_mismatch");

        const selectedAtMs = now();
        db.prepare(
          `INSERT INTO tavern_active_selection (singleton, chat_thread_id, chat_surface_session_id, selected_at_ms)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            chat_thread_id = excluded.chat_thread_id,
            chat_surface_session_id = excluded.chat_surface_session_id,
            selected_at_ms = excluded.selected_at_ms`,
        ).run(chatThreadId, chatSurfaceSessionId, selectedAtMs);

        const selRow = db.prepare("SELECT * FROM tavern_active_selection WHERE singleton = 1").get() as any;
        return validateActiveSelection({
          schemaVersion: CHAT_THREAD_SELECTION_SCHEMA_VERSION,
          chatThreadId: selRow.chat_thread_id,
          chatSurfaceSessionId: selRow.chat_surface_session_id,
          selectedAtMs: selRow.selected_at_ms,
        });
      });
    },

    async resumeThread(chatThreadId, chatSurfaceSessionId): Promise<ChatThreadState> {
      assertId("chatSurfaceSessionId", chatSurfaceSessionId);
      assertId("chatThreadId", chatThreadId);
      return withDb((db) => {
        const state = readStateFromDb(db, chatThreadId);
        if (state.thread.chatSurfaceSessionId !== chatSurfaceSessionId)
          throw new Error("chat_thread_surface_mismatch");
        return state;
      });
    },

    async commitOpening(chatThreadId, requestedOpening): Promise<ChatThreadState> {
      assertId("chatThreadId", chatThreadId);
      const opening = normalizeOpening(requestedOpening);
      return withDb((db) => {
        const current = readStateFromDb(db, chatThreadId);
        if (
          current.thread.openingLockedAtEventId !== null ||
          current.messages.some((message) => message.kind !== "opening")
        )
          throw new Error("chat_thread_opening_locked");

        const updatedAt = now();
        const openingSelectionJson = JSON.stringify(
          opening === "blank"
            ? { kind: "blank" as const }
            : {
                kind: "greeting" as const,
                messageId: opening.messageId,
                source: opening.source,
              },
        );

        const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(chatThreadId) as any;
        const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
        const messages: ChatThreadMessage[] =
          opening === "blank"
            ? []
            : [
                validateMessage({
                  messageId: opening.messageId,
                  role: "companion",
                  kind: "opening",
                  text: opening.text,
                  occurredAtMs: updatedAt,
                  greetingSource: opening.source,
                }),
              ];

        metadata.messages = messages;

        db.prepare(
          "UPDATE tavern_threads SET opening_selection_json = ?, updated_at_ms = ?, metadata_json = ? WHERE thread_id = ?",
        ).run(openingSelectionJson, updatedAt, JSON.stringify(metadata), chatThreadId);

        return readStateFromDb(db, chatThreadId);
      });
    },

    async appendPlayer(chatThreadId, message): Promise<ChatThreadState> {
      validateNormalMessage(message);
      return withDb((db) => {
        const current = readStateFromDb(db, chatThreadId);
        const existing = current.messages.find((m) => m.messageId === message.messageId);
        if (existing !== undefined) {
          if (existing.kind !== "player" || existing.text !== message.text)
            throw new Error("chat_thread_message_id_conflict");
          return current;
        }
        if (current.messages.length >= MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES)
          throw new Error("chat_thread_capacity_exceeded");

        const lockedAt = current.thread.openingLockedAtEventId ?? message.messageId;
        const updatedAt = now();

        const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(chatThreadId) as any;
        const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
        const messages: ChatThreadMessage[] = Array.isArray(metadata.messages) ? [...metadata.messages] : [];

        messages.push(
          validateMessage({
            messageId: message.messageId,
            role: "player",
            kind: "player",
            text: message.text,
            occurredAtMs: message.occurredAtMs,
            greetingSource: null,
          }),
        );

        metadata.messages = messages;
        metadata.openingLockedAtEventId = lockedAt;

        db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, metadata_json = ? WHERE thread_id = ?").run(
          updatedAt,
          JSON.stringify(metadata),
          chatThreadId,
        );

        return readStateFromDb(db, chatThreadId);
      });
    },

    async commitResponse(chatThreadId, response): Promise<ChatThreadState> {
      validateNormalMessage(response);
      return withDb((db) => {
        const current = readStateFromDb(db, chatThreadId);
        const existing = current.messages.find((m) => m.messageId === response.messageId);
        if (existing !== undefined) {
          if (existing.kind !== "response" || existing.text !== response.text)
            throw new Error("chat_thread_message_id_conflict");
          return current;
        }
        if (current.messages.length >= MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES)
          throw new Error("chat_thread_capacity_exceeded");

        const lockedAt = current.thread.openingLockedAtEventId ?? response.messageId;
        const updatedAt = now();

        const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(chatThreadId) as any;
        const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
        const messages: ChatThreadMessage[] = Array.isArray(metadata.messages) ? [...metadata.messages] : [];

        messages.push(
          validateMessage({
            messageId: response.messageId,
            role: "companion",
            kind: "response",
            text: response.text,
            occurredAtMs: response.occurredAtMs,
            greetingSource: null,
          }),
        );

        metadata.messages = messages;
        metadata.openingLockedAtEventId = lockedAt;

        db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, metadata_json = ? WHERE thread_id = ?").run(
          updatedAt,
          JSON.stringify(metadata),
          chatThreadId,
        );

        return readStateFromDb(db, chatThreadId);
      });
    },

    async cancelActiveTurn(input): Promise<ChatThreadState> {
      assertId("chatThreadId", input.chatThreadId);
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertId("expectedTurnId", input.expectedTurnId);
      assertId("expectedAttemptId", input.expectedAttemptId);
      assertTimestamp(input.cancelledAtMs);
      return withDb((db) => {
        const current = readStateFromDb(db, input.chatThreadId);
        const thread = current.thread;
        if (thread.chatSurfaceSessionId !== input.chatSurfaceSessionId)
          throw new Error("chat_thread_surface_mismatch");
        if ((thread.lifecycleStatus ?? "active") !== "active")
          throw new Error("chat_thread_lifecycle_not_active");
        const ledger = current.turnLedger;
        if (ledger === null || ledger.turnId !== input.expectedTurnId)
          throw new Error("chat_turn_not_current");
        if (isTerminalLedger(ledger)) {
          if (!isTurnWithAttempt(ledger) || ledger.attempt.attemptId !== input.expectedAttemptId)
            throw new Error("chat_turn_not_current");
          return current;
        }
        if (!isTurnWithAttempt(ledger) || ledger.attempt.attemptId !== input.expectedAttemptId)
          throw new Error("chat_turn_not_current");
        if (input.cancelledAtMs < thread.updatedAtMs) throw new Error("chat_turn_time_regression");
        const observation = ledger.observation;
        if (ledger.status === "attempt_starting" && observation?.phase !== "armed")
          throw new Error("chat_turn_not_cancellable");
        if (ledger.status !== "attempt_starting" && ledger.status !== "running")
          throw new Error("chat_turn_not_cancellable");
        const cancellableObservation = observation;
        if (
          cancellableObservation === undefined ||
          (cancellableObservation.phase !== "armed" && cancellableObservation.phase !== "running")
        )
          throw new Error("chat_turn_not_cancellable");
        if (input.cancelledAtMs < thread.updatedAtMs) throw new Error("chat_turn_time_regression");
        const nextLedger = freezeCancelledTurn({
          ...ledger,
          status: "cancelled",
          observation: cancellableObservation,
          presentation: null,
          cancelClaimedAtMs: input.cancelledAtMs,
          cancelledAtMs: input.cancelledAtMs,
        });
        const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(input.chatThreadId) as any;
        const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
        metadata.turnLedger = nextLedger;
        db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, metadata_json = ? WHERE thread_id = ?").run(
          input.cancelledAtMs,
          JSON.stringify(metadata),
          input.chatThreadId,
        );
        const readBack = readStateFromDb(db, input.chatThreadId);
        if (readBack.turnLedger?.status !== "cancelled" || readBack.turnLedger.turnId !== input.expectedTurnId)
          throw new Error("chat_turn_cancel_readback_mismatch");
        return readBack;
      });
    },

    async setWorldBookBinding(input): Promise<ChatThreadState> {
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertId("companionId", input.companionId);
      assertId("continuityId", input.continuityId);
      assertTimestamp(input.expectedUpdatedAtMs);
      if (input.binding !== undefined) freezeStableWorldBookBinding(input.binding);
      return withDb((db) => {
        const current = readStateFromDb(db, input.chatThreadId);
        if (
          current.thread.chatSurfaceSessionId !== input.chatSurfaceSessionId ||
          current.thread.companionId !== input.companionId ||
          current.thread.continuityId !== input.continuityId
        )
          throw new Error("chat_thread_scope_mismatch");
        if (current.thread.updatedAtMs !== input.expectedUpdatedAtMs) throw new Error("chat_thread_revision_conflict");
        if (current.messages.length !== 0) throw new Error("chat_thread_worldbook_locked");

        const updatedAt = now();
        const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(input.chatThreadId) as any;
        const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
        metadata.worldBookBinding = input.binding ? freezeStableWorldBookBinding(input.binding) : undefined;

        db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, metadata_json = ? WHERE thread_id = ?").run(
          updatedAt,
          JSON.stringify(metadata),
          input.chatThreadId,
        );

        return readStateFromDb(db, input.chatThreadId);
      });
    },

    async transitionLifecycle(input): Promise<ChatThread> {
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertId("companionId", input.companionId);
      assertId("continuityId", input.continuityId);
      assertManagementRevision(input.expectedManagementRevision);
      if (input.operation !== "archive" && input.operation !== "restore" && input.operation !== "trash")
        throw new Error("invalid_chat_thread_lifecycle_operation");
      return withDb((db) => {
        const current = readStateFromDb(db, input.chatThreadId);
        const thread = current.thread;
        if (thread.chatSurfaceSessionId !== input.chatSurfaceSessionId) throw new Error("chat_thread_surface_mismatch");
        if (thread.companionId !== input.companionId || thread.continuityId !== input.continuityId)
          throw new Error("chat_thread_scope_mismatch");
        const currentManagementRevision = thread.managementRevision ?? 1;
        if (currentManagementRevision !== input.expectedManagementRevision)
          throw new Error("chat_thread_management_revision_conflict");
        const transition = resolveLifecycleTransition(
          thread.lifecycleStatus ?? "active",
          thread.trashRestoreStatus,
          input.operation,
        );
        const nextRevision = currentManagementRevision + 1;

        const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(input.chatThreadId) as any;
        const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
        metadata.trashRestoreStatus = transition.trashRestoreStatus;

        db.prepare(
          "UPDATE tavern_threads SET lifecycle_status = ?, management_revision = ?, metadata_json = ? WHERE thread_id = ?",
        ).run(transition.status, nextRevision, JSON.stringify(metadata), input.chatThreadId);

        return (readStateFromDb(db, input.chatThreadId)).thread;
      });
    },

    async renameThreadTitle(input): Promise<ChatThread> {
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertManagementRevision(input.expectedManagementRevision);
      const title = normalizeThreadTitle(input.title);
      return withDb((db) => {
        const current = readStateFromDb(db, input.chatThreadId);
        const managementRevision = current.thread.managementRevision ?? 1;
        if (current.thread.chatSurfaceSessionId !== input.chatSurfaceSessionId)
          throw new Error("chat_thread_surface_mismatch");
        if (managementRevision !== input.expectedManagementRevision)
          throw new Error("chat_thread_management_revision_conflict");
        if (current.thread.title === title) throw new Error("chat_thread_title_unchanged");

        const nextRevision = managementRevision + 1;
        db.prepare("UPDATE tavern_threads SET title = ?, management_revision = ? WHERE thread_id = ?").run(
          title,
          nextRevision,
          input.chatThreadId,
        );

        return (readStateFromDb(db, input.chatThreadId)).thread;
      });
    },

    async saveDraft(input): Promise<ChatDraft> {
      validateDraftMutation(input);
      return mutateDraft(input, input.text);
    },

    async discardDraft(input): Promise<ChatDraft> {
      validateDraftMutation(input);
      return mutateDraft(input, null);
    },

    close(): void {
      // With per-operation withDb lifecycle, connections are closed after every operation.
    },
  });

  function mutateDraft(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      expectedDraftRevision: number;
    }>,
    text: string | null,
  ): Promise<ChatDraft> {
    return Promise.resolve().then(() =>
      withDb((db) => {
        const current = readStateFromDb(db, input.chatThreadId);
        if (current.thread.chatSurfaceSessionId !== input.chatSurfaceSessionId)
          throw new Error("chat_thread_surface_mismatch");
        if ((current.thread.lifecycleStatus ?? "active") !== "active")
          throw new Error("chat_thread_lifecycle_not_active");
        if (current.draft.revision !== input.expectedDraftRevision) throw new Error("chat_draft_revision_conflict");

        const nextRevision = current.draft.revision + 1;
        const updatedAt = now();
        db.prepare(
          "UPDATE tavern_drafts SET revision = ?, draft_content = ?, updated_at_ms = ? WHERE thread_id = ?",
        ).run(nextRevision, text, updatedAt, input.chatThreadId);

        return (readStateFromDb(db, input.chatThreadId)).draft;
      }),
    );
  }

  function validateDraftMutation(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      expectedDraftRevision: number;
      text?: string;
    }>,
  ): void {
    assertId("chatThreadId", input.chatThreadId);
    assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
    if (!Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 0)
      throw new Error("invalid_chat_draft_revision");
    if (input.text !== undefined) {
      if (!isText(input.text)) throw new Error("invalid_chat_thread_draft");
    }
  }

  const initialCapability: InitialChatExactContentCapability = Object.freeze({
    async resumeExact(chatThreadId, chatSurfaceSessionId): Promise<ChatThreadState> {
      return store.resumeThread(chatThreadId, chatSurfaceSessionId);
    },
    async createExplicit(request): Promise<ChatThreadState> {
      await store.createThread(request);
      return store.resumeThread(request.chatThreadId, request.chatSurfaceSessionId);
    },
  });

  genuineChatThreadStores.add(store);
  initialExactContentCapabilities.add(initialCapability);
  initialExactContentCapabilityByStore.set(store, initialCapability);
  p4AcceptanceByStore.set(store, acceptMounted);
  p4AttemptClaimByStore.set(store, claimMountedAttempt);
  p4ProviderStartByStore.set(store, transitionMountedProviderStart);
  p5PresentationByStore.set(store, transitionMountedPresentation);
  return store;

  async function acceptMounted(input: MountedP4AcceptanceInput): Promise<AcceptedQueuedTurn> {
    validateAcceptanceInput(input);
    return withDb((db) => {
      const current = readStateFromDb(db, input.chatThreadId);
      const thread = current.thread;
      if (
        thread.chatSurfaceSessionId !== input.chatSurfaceSessionId ||
        thread.companionId !== input.companionId ||
        thread.continuityId !== input.continuityId
      )
        throw new Error("chat_thread_scope_mismatch");
      if (thread.lifecycleStatus !== "active") throw new Error("chat_thread_lifecycle_not_active");

      const fingerprint = acceptanceFingerprint(input);
      const existing = current.idempotency.find((record) => record.key === input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new Error("idempotency_conflict");
        return existing.result;
      }
      if (
        current.turnLedger !== null &&
        current.turnLedger.status !== "completed" &&
        current.turnLedger.status !== "cancelled" &&
        current.turnLedger.status !== "failed"
      )
        throw new Error("turn_busy");
      if (current.draft.revision !== input.expectedDraftRevision) throw new Error("chat_draft_revision_conflict");
      if (current.messages.length >= MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES)
        throw new Error("chat_thread_capacity_exceeded");

      const acceptedAtMs = now();
      const messageId = `player_${randomUUID().replace(/-/gu, "")}`;
      const turnId = `turn_${randomUUID().replace(/-/gu, "")}`;
      const result = freezeAcceptedTurn({
        turnId,
        status: "accepted_queued",
        idempotencyKey: input.idempotencyKey,
        messageId,
        acceptedAtMs,
      });

      const lockedAt = thread.openingLockedAtEventId ?? messageId;
      const nextIdempotency = [...current.idempotency, Object.freeze({ key: input.idempotencyKey, fingerprint, result })];

      const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(input.chatThreadId) as any;
      const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
      const messages: ChatThreadMessage[] = Array.isArray(metadata.messages) ? [...metadata.messages] : [];

      messages.push(
        validateMessage({
          messageId,
          role: "player",
          kind: "player",
          text: input.text,
          occurredAtMs: acceptedAtMs,
          greetingSource: null,
        }),
      );

      metadata.messages = messages;
      metadata.openingLockedAtEventId = lockedAt;
      metadata.turnLedger = result;
      metadata.idempotency = nextIdempotency;

      db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, metadata_json = ? WHERE thread_id = ?").run(
        acceptedAtMs,
        JSON.stringify(metadata),
        input.chatThreadId,
      );

      db.prepare(
        "UPDATE tavern_drafts SET revision = ?, draft_content = NULL, updated_at_ms = ? WHERE thread_id = ?",
      ).run(current.draft.revision + 1, acceptedAtMs, input.chatThreadId);

      const readBack = readStateFromDb(db, input.chatThreadId);
      const durable = readBack.idempotency.find((record) => record.key === input.idempotencyKey);
      if (!durable || durable.fingerprint !== fingerprint) throw new Error("chat_turn_readback_mismatch");
      return durable.result;
    });
  }

  async function claimMountedAttempt(input: MountedP4AttemptClaimInput): Promise<AttemptStartingTurn> {
    validateAttemptClaimInput(input);
    return withDb((db) => {
      const current = readStateFromDb(db, input.chatThreadId);
      const thread = current.thread;
      if (
        thread.chatSurfaceSessionId !== input.chatSurfaceSessionId ||
        thread.companionId !== input.companionId ||
        thread.continuityId !== input.continuityId
      )
        throw new Error("chat_thread_scope_mismatch");
      if (thread.lifecycleStatus !== "active") throw new Error("chat_thread_lifecycle_not_active");
      if (current.turnLedger === null || current.turnLedger.status !== "accepted_queued")
        throw new Error("attempt_already_claimed");

      const claimedAtMs = now();
      const attempt = freezeAttemptClaim({
        generation: 1,
        attemptId: `attempt_${randomUUID().replace(/-/gu, "")}`,
        claimedAtMs,
        selectionGeneration: input.selectionGeneration,
        runtimeBindingDigest: input.runtimeBindingDigest,
        runtimeOwner: input.runtimeOwner,
      });
      const claimed = freezeAttemptStartingTurn({
        ...current.turnLedger,
        status: "attempt_starting",
        attempt,
      });

      const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(input.chatThreadId) as any;
      const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
      metadata.turnLedger = claimed;

      db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, metadata_json = ? WHERE thread_id = ?").run(
        claimedAtMs,
        JSON.stringify(metadata),
        input.chatThreadId,
      );

      const readBack = readStateFromDb(db, input.chatThreadId);
      if (
        readBack.turnLedger === null ||
        readBack.turnLedger.status !== "attempt_starting" ||
        readBack.turnLedger.turnId !== claimed.turnId ||
        readBack.turnLedger.attempt.attemptId !== attempt.attemptId
      )
        throw new Error("chat_attempt_claim_readback_mismatch");
      return readBack.turnLedger;
    });
  }

  async function transitionMountedProviderStart(
    input: MountedP4ProviderStartInput,
    command: P4ProviderStartTransition,
  ): Promise<AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn> {
    validateProviderStartInput(input);
    return withDb((db) => {
      assertP4P5MountedTransitionAuthority(input.authority);
      assertP4P5MountedTransitionOperationAuthority(input.operationAuthority);
      const current = readStateFromDb(db, input.chatThreadId);
      const thread = current.thread;
      if (
        thread.chatSurfaceSessionId !== input.chatSurfaceSessionId ||
        thread.companionId !== input.companionId ||
        thread.continuityId !== input.continuityId
      )
        throw new Error("chat_thread_scope_mismatch");
      if (thread.lifecycleStatus !== "active") throw new Error("chat_thread_lifecycle_not_active");
      const ledger = current.turnLedger;
      if (ledger === null || ledger.status !== "attempt_starting") throw new Error("provider_start_claim_missing");
      assertExactProviderStartAttempt(ledger.attempt, input);
      const observation = ledger.observation;
      const observedAtMs = command.observedAtMs;
      if (observedAtMs < thread.updatedAtMs) throw new Error("provider_start_observation_time_regression");
      let nextLedger: AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn;
      if (command.operation === "arm") {
        if (observation !== undefined && observation.phase !== "armed")
          throw new Error("provider_start_observation_conflict");
        nextLedger = freezeAttemptStartingTurn({
          ...ledger,
          observation: Object.freeze({ phase: "armed" as const, observedAtMs }),
        });
      } else if (command.operation === "not_started") {
        if (observation === undefined || observation.phase !== "armed")
          throw new Error("provider_start_observation_conflict");
        nextLedger = freezeAttemptStartingTurn({
          ...ledger,
          observation: Object.freeze({
            phase: "not_started" as const,
            reasonCode: command.reasonCode,
            observedAtMs,
          }),
        });
      } else if (command.operation === "running") {
        if (observation === undefined || observation.phase !== "armed")
          throw new Error("provider_start_observation_conflict");
        nextLedger = freezeRunningTurn({
          ...ledger,
          status: "running",
          observation: Object.freeze({
            phase: "running" as const,
            source: "after_provider_response" as const,
            statusClass: command.statusClass,
            observedAtMs,
          }),
        });
      } else if (command.operation === "fail") {
        if (observation === undefined || observation.phase !== "armed" || command.failedAtMs < observedAtMs)
          throw new Error("provider_start_observation_conflict");
        nextLedger = freezeFailedTurn({
          ...ledger,
          status: "failed",
          observation,
          presentation: null,
          reasonCode: command.reasonCode,
          failedAtMs: command.failedAtMs,
        });
      } else {
        if (observation === undefined || observation.phase !== "armed" || command.cancelledAtMs < observedAtMs)
          throw new Error("provider_start_observation_conflict");
        nextLedger = freezeCancelledTurn({
          ...ledger,
          status: "cancelled",
          observation,
          presentation: null,
          cancelClaimedAtMs: observedAtMs,
          cancelledAtMs: command.cancelledAtMs,
        });
      }

      const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(input.chatThreadId) as any;
      const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
      metadata.turnLedger = nextLedger;

      db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, metadata_json = ? WHERE thread_id = ?").run(
        observedAtMs,
        JSON.stringify(metadata),
        input.chatThreadId,
      );

      const readBack = readStateFromDb(db, input.chatThreadId);
      const readBackLedger = readBack.turnLedger;
      assertProviderStartReadBack(readBackLedger, command, input);
      if (readBackLedger === null || readBackLedger.status === "accepted_queued")
        throw new Error("chat_provider_start_readback_mismatch");
      if (
        readBackLedger.status !== "attempt_starting" &&
        readBackLedger.status !== "running" &&
        readBackLedger.status !== "failed" &&
        readBackLedger.status !== "cancelled"
      )
        throw new Error("chat_provider_start_readback_mismatch");
      return readBackLedger;
    });
  }

  async function transitionMountedPresentation(
    input: MountedP5PresentationInput,
    command: P5PresentationTransition,
  ): Promise<ChatTurnLedger> {
    validatePresentationInput(input);
    return withDb((db) => {
      assertP4P5MountedTransitionAuthority(input.authority);
      assertP4P5MountedTransitionOperationAuthority(input.operationAuthority);
      const current = readStateFromDb(db, input.chatThreadId);
      const thread = current.thread;
      if (
        thread.chatSurfaceSessionId !== input.chatSurfaceSessionId ||
        thread.companionId !== input.companionId ||
        thread.continuityId !== input.continuityId
      )
        throw new Error("chat_thread_scope_mismatch");
      if (thread.lifecycleStatus !== "active") throw new Error("chat_thread_lifecycle_not_active");
      const ledger = current.turnLedger;
      if (ledger === null || !isTurnWithAttempt(ledger)) throw new Error("p5_presentation_claim_missing");
      assertExactP5Attempt(ledger.attempt, input);
      const atMs = timestampFor(command);
      if (atMs < thread.updatedAtMs) throw new Error("p5_presentation_time_regression");

      const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(input.chatThreadId) as any;
      const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};
      const messages: ChatThreadMessage[] = Array.isArray(metadata.messages) ? [...metadata.messages] : [];

      let nextLedger: ChatTurnLedger;
      switch (command.operation) {
        case "commit_presentation": {
          validateNormalMessage(command.message);
          const existing = messages.find((message) => message.messageId === command.message.messageId);
          if (existing !== undefined) {
            if (existing.kind !== "response" || existing.role !== "companion" || existing.text !== command.message.text)
              throw new Error("chat_thread_message_id_conflict");
            if (
              current.turnLedger?.status !== "presentation_committed" ||
              current.turnLedger.presentation.expressionId !== command.message.messageId ||
              current.turnLedger.presentation.cancelEpoch !== command.cancelEpoch
            )
              throw new Error("chat_thread_message_id_conflict");
            nextLedger = current.turnLedger;
            break;
          }
          if (ledger.status !== "running") throw new Error("p5_presentation_source_running_required");
          const presentation = freezePresentationCommit(
            Object.freeze({
              expressionId: command.message.messageId,
              messageId: command.message.messageId,
              cancelEpoch: command.cancelEpoch,
              committedAtMs: command.committedAtMs,
            }),
          );
          nextLedger = freezePresentationCommittedTurn({
            ...ledger,
            status: "presentation_committed",
            presentation,
          });

          messages.push(
            validateMessage({
              messageId: command.message.messageId,
              role: "companion",
              kind: "response",
              text: command.message.text,
              occurredAtMs: command.message.occurredAtMs,
              greetingSource: null,
            }),
          );
          metadata.messages = messages;
          break;
        }
        case "claim_completion": {
          if (ledger.status !== "presentation_committed") throw new Error("p5_presentation_completion_source_required");
          nextLedger = freezeCompletionClaimedTurn({
            ...ledger,
            status: "completion_claimed",
            completionClaimedAtMs: command.claimedAtMs,
          });
          break;
        }
        case "complete": {
          if (ledger.status !== "completion_claimed") throw new Error("p5_presentation_complete_source_required");
          nextLedger = freezeCompletedTurn({ ...ledger, status: "completed", completedAtMs: command.completedAtMs });
          break;
        }
        case "claim_cancel": {
          if (ledger.status === "cancel_claimed" || ledger.status === "cancelled") {
            return ledger;
          }
          if (ledger.status !== "running" && ledger.status !== "presentation_committed")
            throw new Error("p5_presentation_cancel_source_required");
          nextLedger = freezeCancelClaimedTurn({
            ...ledger,
            status: "cancel_claimed",
            presentation: ledger.status === "presentation_committed" ? ledger.presentation : null,
            cancelClaimedAtMs: command.claimedAtMs,
          });
          break;
        }
        case "cancel": {
          if (ledger.status === "cancelled") return ledger;
          if (ledger.status !== "cancel_claimed") throw new Error("p5_presentation_cancel_source_required");
          nextLedger = freezeCancelledTurn({ ...ledger, status: "cancelled", cancelledAtMs: command.cancelledAtMs });
          break;
        }
        default: {
          if (ledger.status === "attempt_starting" || isTerminalLedger(ledger))
            throw new Error("p5_presentation_terminal_immutable");
          nextLedger = freezeFailedTurn({
            turnId: ledger.turnId,
            status: "failed",
            idempotencyKey: ledger.idempotencyKey,
            messageId: ledger.messageId,
            acceptedAtMs: ledger.acceptedAtMs,
            attempt: ledger.attempt,
            observation: ledger.observation,
            presentation: presentationOf(ledger),
            reasonCode: command.reasonCode,
            failedAtMs: command.failedAtMs,
          });
          break;
        }
      }

      metadata.turnLedger = nextLedger;

      db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, metadata_json = ? WHERE thread_id = ?").run(
        atMs,
        JSON.stringify(metadata),
        input.chatThreadId,
      );

      const readBack = readStateFromDb(db, input.chatThreadId);
      assertP5ReadBack(readBack.turnLedger, command, input);
      if (readBack.turnLedger === null) throw new Error("chat_p5_readback_mismatch");
      return readBack.turnLedger;
    });
  }
}

function rowToThread(row: any): ChatThread {
  const openingSelection = JSON.parse(row.opening_selection_json);
  const metadata: ThreadMetadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  const thread: ChatThread = {
    schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
    chatThreadId: row.thread_id,
    companionId: row.companion_id,
    continuityId: row.continuity_id,
    ...(row.persona_id ? { personaId: row.persona_id } : {}),
    ...(row.scenario_id ? { scenarioId: row.scenario_id } : {}),
    stableArtifactBindings: freezeStableArtifactBindings(metadata.stableArtifactBindings ?? []),
    ...(metadata.worldBookBinding ? { worldBookBinding: freezeStableWorldBookBinding(metadata.worldBookBinding) } : {}),
    chatSurfaceSessionId: metadata.chatSurfaceSessionId ?? row.thread_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    openingSelection: validateOpeningSelection(openingSelection),
    title: validateStoredThreadTitle(row.title),
    lifecycleStatus: validateLifecycleStatus(row.lifecycle_status),
    managementRevision: validateManagementRevision(row.management_revision),
    ...(metadata.trashRestoreStatus ? { trashRestoreStatus: validateTrashRestoreStatus(metadata.trashRestoreStatus) } : {}),
    openingLockedAtEventId: metadata.openingLockedAtEventId ?? null,
  };
  return freezeThread(thread);
}

function readStateFromDb(db: DatabaseSync, chatThreadId: string): ChatThreadState {
  assertId("chatThreadId", chatThreadId);
  const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(chatThreadId) as any;
  if (!threadRow) {
    throw new ExactThreadNotFoundError();
  }
  const thread = rowToThread(threadRow);
  const metadata: ThreadMetadata = threadRow.metadata_json ? JSON.parse(threadRow.metadata_json) : {};

  const rawMessages: unknown[] = Array.isArray(metadata.messages) ? metadata.messages : [];
  const messages: ChatThreadMessage[] = rawMessages.map(validateMessage);

  const draftRow = db.prepare("SELECT * FROM tavern_drafts WHERE thread_id = ?").get(chatThreadId) as any;
  const draft = draftRow
    ? validateDraft({ revision: draftRow.revision, text: draftRow.draft_content ?? null })
    : validateDraft({ revision: 0, text: null });

  const turnLedger = metadata.turnLedger ? validateTurnLedger(metadata.turnLedger) : null;
  const idempotencyRaw = Array.isArray(metadata.idempotency) ? metadata.idempotency : [];
  const idempotency = idempotencyRaw.map(validateIdempotency);

  validateOpeningConsistency(thread, messages);
  validateTurnIntegrity(messages, turnLedger, idempotency);

  return freezeState({
    thread,
    messages,
    draft,
    turnLedger,
    idempotency,
  });
}

function validateActiveSelection(value: unknown): ActiveChatThreadSelection {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["schemaVersion", "chatThreadId", "chatSurfaceSessionId", "selectedAtMs"]) ||
    value.schemaVersion !== CHAT_THREAD_SELECTION_SCHEMA_VERSION
  )
    throw new Error("invalid_active_chat_thread_selection");
  assertId("chatThreadId", value.chatThreadId);
  assertId("chatSurfaceSessionId", value.chatSurfaceSessionId);
  assertTimestamp(value.selectedAtMs);
  return freezeActiveSelection({
    schemaVersion: CHAT_THREAD_SELECTION_SCHEMA_VERSION,
    chatThreadId: value.chatThreadId,
    chatSurfaceSessionId: value.chatSurfaceSessionId,
    selectedAtMs: value.selectedAtMs,
  });
}

function freezeActiveSelection(value: ActiveChatThreadSelection): ActiveChatThreadSelection {
  return Object.freeze({ ...value });
}

function validateCreate(request: CreateChatThreadRequest): void {
  assertId("chatThreadId", request.chatThreadId);
  assertId("companionId", request.companionId);
  assertId("continuityId", request.continuityId);
  assertId("chatSurfaceSessionId", request.chatSurfaceSessionId);
  if (request.personaId !== undefined) assertId("personaId", request.personaId);
  if (request.scenarioId !== undefined) assertId("scenarioId", request.scenarioId);
  freezeStableArtifactBindings(request.stableArtifactBindings ?? []);
  if (request.worldBookBinding !== undefined) freezeStableWorldBookBinding(request.worldBookBinding);
  normalizeOpening(request.opening);
}

function normalizeOpening(
  opening: CreateChatThreadRequest["opening"],
): "blank" | Readonly<{ messageId: string; text: string; source: GreetingSource }> {
  if (opening === "blank") return opening;
  if (!isRecord(opening)) throw new Error("invalid_chat_thread_opening");
  assertId("messageId", opening.messageId);
  assertText(opening.text);
  validateGreetingSource(opening.source);
  return Object.freeze({
    messageId: opening.messageId,
    text: opening.text,
    source: freezeGreetingSource(opening.source),
  });
}

function validateNormalMessage(message: Readonly<{ messageId: string; text: string; occurredAtMs: number }>): void {
  assertId("messageId", message.messageId);
  assertText(message.text);
  assertTimestamp(message.occurredAtMs);
}

function validateGreetingSource(value: unknown): asserts value is GreetingSource {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "greetingSetId",
      "sourceRevision",
      "canonicalHash",
      "variantId",
      "profileRevision",
      "scenarioRevision",
    ])
  )
    throw new Error("invalid_greeting_source");
  assertId("greetingSetId", value.greetingSetId);
  assertId("variantId", value.variantId);
  for (const key of ["sourceRevision", "profileRevision"] as const)
    if (!isRevision(value[key])) throw new Error("invalid_greeting_source");
  if (value.scenarioRevision !== null && !isRevision(value.scenarioRevision))
    throw new Error("invalid_greeting_source");
  if (!isHash(value.canonicalHash)) throw new Error("invalid_greeting_source");
}

function validateOpeningSelection(value: unknown): OpeningSelection {
  if (!isRecord(value)) throw new Error("invalid_chat_thread_opening");
  const kind = value.kind;
  if (kind === "blank" && Object.keys(value).length === 1) return Object.freeze({ kind: "blank" });
  if (kind === "greeting" && onlyKeys(value, ["kind", "messageId", "source"])) {
    const messageId = value.messageId;
    const source = value.source;
    assertId("messageId", messageId);
    validateGreetingSource(source);
    return Object.freeze({
      kind: "greeting",
      messageId,
      source: freezeGreetingSource(source),
    });
  }
  throw new Error("invalid_chat_thread_opening");
}

function validateMessage(value: unknown): ChatThreadMessage {
  if (!isRecord(value) || !onlyKeys(value, ["messageId", "role", "kind", "text", "occurredAtMs", "greetingSource"]))
    throw new Error("invalid_chat_thread_message");
  const messageId = value.messageId;
  const role = value.role;
  const kind = value.kind;
  const text = value.text;
  const occurredAtMs = value.occurredAtMs;
  const greetingSourceValue = value.greetingSource;
  if (
    !isId(messageId) ||
    (role !== "player" && role !== "companion") ||
    (kind !== "opening" && kind !== "player" && kind !== "response") ||
    !isText(text) ||
    !isTimestamp(occurredAtMs) ||
    (greetingSourceValue !== null && !isRecord(greetingSourceValue))
  )
    throw new Error("invalid_chat_thread_message");
  const validGrammar =
    (kind === "opening" && role === "companion" && greetingSourceValue !== null) ||
    (kind === "player" && role === "player" && greetingSourceValue === null) ||
    (kind === "response" && role === "companion" && greetingSourceValue === null);
  if (!validGrammar) throw new Error("invalid_chat_thread_message");
  let greetingSource: GreetingSource | null;
  if (greetingSourceValue === null) {
    greetingSource = null;
  } else {
    validateGreetingSource(greetingSourceValue);
    greetingSource = freezeGreetingSource(greetingSourceValue);
  }
  return freezeMessage({
    messageId,
    role,
    kind,
    text,
    occurredAtMs,
    greetingSource,
  });
}

function validateOpeningConsistency(thread: ChatThread, messages: readonly ChatThreadMessage[]): void {
  const opening = messages.filter((message) => message.kind === "opening");
  if (
    thread.openingSelection.kind === "blank"
      ? opening.length !== 0
      : opening.length !== 1 ||
        opening[0]!.messageId !== thread.openingSelection.messageId ||
        !sameSource(opening[0]!.greetingSource, thread.openingSelection.source)
  )
    throw new Error("invalid_chat_thread_opening_consistency");
  if (
    messages.some(
      (message, index) => messages.findIndex((candidate) => candidate.messageId === message.messageId) !== index,
    )
  )
    throw new Error("invalid_chat_thread_duplicate_message");
}

function sameSource(left: GreetingSource | null, right: GreetingSource): boolean {
  return (
    left !== null &&
    left.greetingSetId === right.greetingSetId &&
    left.sourceRevision === right.sourceRevision &&
    left.canonicalHash === right.canonicalHash &&
    left.variantId === right.variantId &&
    left.profileRevision === right.profileRevision &&
    left.scenarioRevision === right.scenarioRevision
  );
}

function validateDraft(value: unknown): ChatDraft {
  if (!isRecord(value) || !onlyKeys(value, ["revision", "text"])) throw new Error("invalid_chat_thread_draft");
  return freezeDraft({ revision: value.revision as number, text: value.text as string | null });
}

function freezeDraft(value: ChatDraft): ChatDraft {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || (value.text !== null && !isText(value.text)))
    throw new Error("invalid_chat_thread_draft");
  return Object.freeze({ revision: value.revision, text: value.text });
}

function validateAcceptedTurn(value: unknown): AcceptedQueuedTurn {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["turnId", "status", "idempotencyKey", "messageId", "acceptedAtMs"]) ||
    value.status !== "accepted_queued"
  )
    throw new Error("invalid_chat_thread_turn_ledger");
  assertId("turnId", value.turnId);
  assertId("messageId", value.messageId);
  assertIdempotencyKey(value.idempotencyKey);
  assertTimestamp(value.acceptedAtMs);
  return Object.freeze({
    turnId: value.turnId,
    status: "accepted_queued",
    idempotencyKey: value.idempotencyKey,
    messageId: value.messageId,
    acceptedAtMs: value.acceptedAtMs,
  });
}

function freezeAcceptedTurn(value: AcceptedQueuedTurn): AcceptedQueuedTurn {
  return validateAcceptedTurn(value);
}

function validateTurnLedger(value: unknown): ChatTurnLedger {
  if (!isRecord(value)) throw new Error("invalid_chat_thread_turn_ledger");
  if (value.status === "accepted_queued") return validateAcceptedTurn(value);
  if (value.status === "attempt_starting") {
    if (!onlyKeys(value, ["turnId", "status", "idempotencyKey", "messageId", "acceptedAtMs", "attempt", "observation"]))
      throw new Error("invalid_chat_thread_turn_ledger");
    const observation = value.observation === undefined ? undefined : validateAttemptObservation(value.observation);
    if (observation !== undefined && observation.phase === "running")
      throw new Error("invalid_chat_thread_turn_ledger");
    return freezeAttemptStartingTurn({
      turnId: value.turnId as string,
      status: "attempt_starting",
      idempotencyKey: value.idempotencyKey as string,
      messageId: value.messageId as string,
      acceptedAtMs: value.acceptedAtMs as number,
      attempt: value.attempt as AttemptClaimV1,
      ...(observation === undefined ? {} : { observation }),
    });
  }
  if (value.status === "running") {
    if (!onlyKeys(value, ["turnId", "status", "idempotencyKey", "messageId", "acceptedAtMs", "attempt", "observation"]))
      throw new Error("invalid_chat_thread_turn_ledger");
    const observation = validateAttemptObservation(value.observation);
    if (observation.phase !== "running") throw new Error("invalid_chat_thread_turn_ledger");
    return freezeRunningTurn({
      turnId: value.turnId as string,
      status: "running",
      idempotencyKey: value.idempotencyKey as string,
      messageId: value.messageId as string,
      acceptedAtMs: value.acceptedAtMs as number,
      attempt: value.attempt as AttemptClaimV1,
      observation,
    });
  }
  if (
    value.status === "presentation_committed" ||
    value.status === "completion_claimed" ||
    value.status === "completed" ||
    value.status === "cancel_claimed" ||
    value.status === "cancelled" ||
    value.status === "failed"
  ) {
    const common = validateP5TerminalishCommon(value);
    if (value.status === "failed")
      return freezeFailedTurn({
        turnId: value.turnId as string,
        status: "failed",
        idempotencyKey: value.idempotencyKey as string,
        messageId: value.messageId as string,
        acceptedAtMs: value.acceptedAtMs as number,
        attempt: value.attempt as AttemptClaimV1,
        observation: common.observation,
        presentation: common.presentation ?? null,
        reasonCode: common.reasonCode!,
        failedAtMs: common.failedAtMs!,
      });
    if (value.status === "cancelled")
      return freezeCancelledTurn({
        turnId: value.turnId as string,
        status: "cancelled",
        idempotencyKey: value.idempotencyKey as string,
        messageId: value.messageId as string,
        acceptedAtMs: value.acceptedAtMs as number,
        attempt: value.attempt as AttemptClaimV1,
        observation: common.observation as AttemptObservationV1 & { phase: "armed" | "running" },
        presentation: common.presentation ?? null,
        cancelClaimedAtMs: common.cancelClaimedAtMs!,
        cancelledAtMs: common.cancelledAtMs!,
      });
    if (common.observation.phase !== "running") throw new Error("invalid_chat_thread_turn_ledger");
    const base = freezeRunningTurn({
      turnId: value.turnId as string,
      status: "running",
      idempotencyKey: value.idempotencyKey as string,
      messageId: value.messageId as string,
      acceptedAtMs: value.acceptedAtMs as number,
      attempt: value.attempt as AttemptClaimV1,
      observation: common.observation,
    });
    if (value.status === "presentation_committed")
      return freezePresentationCommittedTurn({
        ...base,
        status: "presentation_committed",
        presentation: common.presentation!,
      });
    if (value.status === "completion_claimed")
      return freezeCompletionClaimedTurn({
        ...base,
        status: "completion_claimed",
        presentation: common.presentation!,
        completionClaimedAtMs: common.completionClaimedAtMs!,
      });
    if (value.status === "completed")
      return freezeCompletedTurn({
        ...base,
        status: "completed",
        presentation: common.presentation!,
        completionClaimedAtMs: common.completionClaimedAtMs!,
        completedAtMs: common.completedAtMs!,
      });
    if (value.status === "cancel_claimed")
      return freezeCancelClaimedTurn({
        ...base,
        status: "cancel_claimed",
        presentation: common.presentation ?? null,
        cancelClaimedAtMs: common.cancelClaimedAtMs!,
      });
    throw new Error("invalid_chat_thread_turn_ledger");
  }
  throw new Error("invalid_chat_thread_turn_ledger");
}

function validateP5TerminalishCommon(value: Record<string, unknown>): Readonly<{
  observation: AttemptObservationV1;
  presentation: PresentationCommitV1 | null;
  completionClaimedAtMs?: number;
  completedAtMs?: number;
  cancelClaimedAtMs?: number;
  cancelledAtMs?: number;
  failedAtMs?: number;
  reasonCode?: P5TerminalFailureReason;
}> {
  const status = value.status;
  const commonKeys = [
    "turnId",
    "status",
    "idempotencyKey",
    "messageId",
    "acceptedAtMs",
    "attempt",
    "observation",
    "presentation",
  ];
  const keys =
    status === "presentation_committed"
      ? commonKeys
      : status === "completion_claimed"
        ? [...commonKeys, "completionClaimedAtMs"]
        : status === "completed"
          ? [...commonKeys, "completionClaimedAtMs", "completedAtMs"]
          : status === "cancel_claimed"
            ? [...commonKeys, "cancelClaimedAtMs"]
            : status === "cancelled"
              ? [...commonKeys, "cancelClaimedAtMs", "cancelledAtMs"]
              : [...commonKeys, "reasonCode", "failedAtMs"];
  if (!onlyKeys(value, keys)) throw new Error("invalid_chat_thread_turn_ledger");
  const observation = validateAttemptObservation(value.observation);
  if (status !== "failed" && status !== "cancelled" && observation.phase !== "running")
    throw new Error("invalid_chat_thread_turn_ledger");
  if ((status === "failed" || status === "cancelled") && observation.phase !== "armed" && observation.phase !== "running")
    throw new Error("invalid_chat_thread_turn_ledger");
  const presentation = value.presentation === null ? null : validatePresentationCommit(value.presentation);
  if (status === "completion_claimed" || status === "completed") {
    if (presentation === null || !isTimestamp(value.completionClaimedAtMs))
      throw new Error("invalid_chat_thread_turn_ledger");
    if (status === "completed" && !isTimestamp(value.completedAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
  }
  if (status === "cancel_claimed" || status === "cancelled") {
    if (!isTimestamp(value.cancelClaimedAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
    if (status === "cancelled" && !isTimestamp(value.cancelledAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
  }
  if (status === "failed") {
    if (!isTimestamp(value.failedAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
    const reasonCode = value.reasonCode;
    if (
      reasonCode !== "interrupted" &&
      reasonCode !== "no_visible_presentation" &&
      reasonCode !== "runtime_unavailable" &&
      reasonCode !== "storage_unavailable"
    )
      throw new Error("invalid_chat_thread_turn_ledger");
  }
  return Object.freeze({
    observation,
    presentation,
    ...(status === "completion_claimed" || status === "completed"
      ? { completionClaimedAtMs: value.completionClaimedAtMs as number }
      : {}),
    ...(status === "completed" ? { completedAtMs: value.completedAtMs as number } : {}),
    ...(status === "cancel_claimed" || status === "cancelled"
      ? { cancelClaimedAtMs: value.cancelClaimedAtMs as number }
      : {}),
    ...(status === "cancelled" ? { cancelledAtMs: value.cancelledAtMs as number } : {}),
    ...(status === "failed"
      ? { failedAtMs: value.failedAtMs as number, reasonCode: value.reasonCode as P5TerminalFailureReason }
      : {}),
  });
}

function freezeAttemptStartingTurn(value: AttemptStartingTurn): AttemptStartingTurn {
  const accepted = validateAcceptedTurn({
    turnId: value.turnId,
    status: "accepted_queued",
    idempotencyKey: value.idempotencyKey,
    messageId: value.messageId,
    acceptedAtMs: value.acceptedAtMs,
  });
  const observation = value.observation === undefined ? undefined : validateAttemptObservation(value.observation);
  if (observation !== undefined && observation.phase === "running") throw new Error("invalid_chat_thread_turn_ledger");
  return Object.freeze({
    ...accepted,
    status: "attempt_starting",
    attempt: freezeAttemptClaim(value.attempt),
    ...(observation === undefined ? {} : { observation }),
  });
}

function validateAttemptObservation(value: unknown): AttemptObservationV1 {
  if (!isRecord(value) || !isTimestamp(value.observedAtMs)) throw new Error("invalid_chat_thread_observation");
  if (value.phase === "armed") {
    if (!onlyKeys(value, ["phase", "observedAtMs"])) throw new Error("invalid_chat_thread_observation");
    return Object.freeze({ phase: "armed", observedAtMs: value.observedAtMs });
  }
  if (value.phase === "not_started") {
    if (
      !onlyKeys(value, ["phase", "reasonCode", "observedAtMs"]) ||
      (value.reasonCode !== "admission_revoked" &&
        value.reasonCode !== "session_unavailable" &&
        value.reasonCode !== "invocation_deadline_expired")
    )
      throw new Error("invalid_chat_thread_observation");
    return Object.freeze({
      phase: "not_started",
      reasonCode: value.reasonCode,
      observedAtMs: value.observedAtMs,
    });
  }
  if (value.phase === "running") {
    if (
      !onlyKeys(value, ["phase", "source", "statusClass", "observedAtMs"]) ||
      value.source !== "after_provider_response" ||
      (value.statusClass !== "success" && value.statusClass !== "error")
    )
      throw new Error("invalid_chat_thread_observation");
    return Object.freeze({
      phase: "running",
      source: "after_provider_response",
      statusClass: value.statusClass,
      observedAtMs: value.observedAtMs,
    });
  }
  throw new Error("invalid_chat_thread_observation");
}

function freezeRunningTurn(value: RunningTurn): RunningTurn {
  const accepted = validateAcceptedTurn({
    turnId: value.turnId,
    status: "accepted_queued",
    idempotencyKey: value.idempotencyKey,
    messageId: value.messageId,
    acceptedAtMs: value.acceptedAtMs,
  });
  const observation = validateAttemptObservation(value.observation);
  if (observation.phase !== "running") throw new Error("invalid_chat_thread_turn_ledger");
  return Object.freeze({
    ...accepted,
    status: "running",
    attempt: freezeAttemptClaim(value.attempt),
    observation,
  });
}

function freezePresentationCommittedTurn(value: PresentationCommittedTurn): PresentationCommittedTurn {
  const base = freezeRunningTurn({ ...value, status: "running" });
  const presentation = validatePresentationCommit(value.presentation);
  return Object.freeze({ ...base, status: "presentation_committed", presentation });
}

function freezeCompletionClaimedTurn(value: CompletionClaimedTurn): CompletionClaimedTurn {
  const base = freezePresentationCommittedTurn({ ...value, status: "presentation_committed" });
  if (!isTimestamp(value.completionClaimedAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
  return Object.freeze({ ...base, status: "completion_claimed", completionClaimedAtMs: value.completionClaimedAtMs });
}

function freezeCompletedTurn(value: CompletedTurn): CompletedTurn {
  const base = freezeCompletionClaimedTurn({ ...value, status: "completion_claimed" });
  if (!isTimestamp(value.completedAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
  return Object.freeze({ ...base, status: "completed", completedAtMs: value.completedAtMs });
}

function freezeCancelClaimedTurn(value: CancelClaimedTurn): CancelClaimedTurn {
  const base = freezeRunningTurn({ ...value, status: "running" });
  if (!isTimestamp(value.cancelClaimedAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
  return Object.freeze({
    ...base,
    status: "cancel_claimed",
    presentation: value.presentation === null ? null : validatePresentationCommit(value.presentation),
    cancelClaimedAtMs: value.cancelClaimedAtMs,
  });
}

function freezeCancelledTurn(value: CancelledTurn): CancelledTurn {
  const accepted = validateAcceptedTurn({
    turnId: value.turnId,
    status: "accepted_queued",
    idempotencyKey: value.idempotencyKey,
    messageId: value.messageId,
    acceptedAtMs: value.acceptedAtMs,
  });
  const observation = validateAttemptObservation(value.observation);
  if (observation.phase !== "armed" && observation.phase !== "running")
    throw new Error("invalid_chat_thread_turn_ledger");
  if (
    !isTimestamp(value.cancelClaimedAtMs) ||
    !isTimestamp(value.cancelledAtMs) ||
    value.cancelledAtMs < value.cancelClaimedAtMs
  )
    throw new Error("invalid_chat_thread_turn_ledger");
  return Object.freeze({
    ...accepted,
    status: "cancelled",
    attempt: freezeAttemptClaim(value.attempt),
    observation,
    presentation: value.presentation === null ? null : validatePresentationCommit(value.presentation),
    cancelClaimedAtMs: value.cancelClaimedAtMs,
    cancelledAtMs: value.cancelledAtMs,
  });
}

function freezeFailedTurn(value: FailedTurn): FailedTurn {
  const accepted = validateAcceptedTurn({
    turnId: value.turnId,
    status: "accepted_queued",
    idempotencyKey: value.idempotencyKey,
    messageId: value.messageId,
    acceptedAtMs: value.acceptedAtMs,
  });
  const observation = validateAttemptObservation(value.observation);
  if (observation.phase !== "armed" && observation.phase !== "running")
    throw new Error("invalid_chat_thread_turn_ledger");
  if (!isTimestamp(value.failedAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
  const reasonCode = value.reasonCode;
  if (
    reasonCode !== "interrupted" &&
    reasonCode !== "no_visible_presentation" &&
    reasonCode !== "runtime_unavailable" &&
    reasonCode !== "storage_unavailable"
  )
    throw new Error("invalid_chat_thread_turn_ledger");
  return Object.freeze({
    ...accepted,
    status: "failed",
    attempt: freezeAttemptClaim(value.attempt),
    observation,
    presentation: value.presentation === null ? null : validatePresentationCommit(value.presentation),
    reasonCode,
    failedAtMs: value.failedAtMs,
  });
}

function freezeAttemptClaim(value: AttemptClaimV1): AttemptClaimV1 {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "generation",
      "attemptId",
      "claimedAtMs",
      "selectionGeneration",
      "runtimeBindingDigest",
      "runtimeOwner",
    ]) ||
    value.generation !== 1
  )
    throw new Error("invalid_chat_thread_attempt_claim");
  assertId("attemptId", value.attemptId);
  assertTimestamp(value.claimedAtMs);
  if (
    !isRevision(value.selectionGeneration) ||
    !isHash(value.runtimeBindingDigest) ||
    !isRecord(value.runtimeOwner) ||
    !onlyKeys(value.runtimeOwner, ["ownerToken", "runtimeInstanceId", "ownerPid", "ownerProcessStartIdentity"])
  )
    throw new Error("invalid_chat_thread_attempt_claim");
  assertId("ownerToken", value.runtimeOwner.ownerToken);
  assertId("runtimeInstanceId", value.runtimeOwner.runtimeInstanceId);
  assertId("ownerProcessStartIdentity", value.runtimeOwner.ownerProcessStartIdentity);
  if (!Number.isSafeInteger(value.runtimeOwner.ownerPid) || value.runtimeOwner.ownerPid < 1)
    throw new Error("invalid_chat_thread_attempt_claim");
  return Object.freeze({
    generation: 1,
    attemptId: value.attemptId,
    claimedAtMs: value.claimedAtMs,
    selectionGeneration: value.selectionGeneration,
    runtimeBindingDigest: value.runtimeBindingDigest,
    runtimeOwner: Object.freeze({ ...value.runtimeOwner }),
  });
}

function validateIdempotency(value: unknown): IdempotencyRecord {
  if (!isRecord(value) || !onlyKeys(value, ["key", "fingerprint", "result"]) || !isHash(value.fingerprint))
    throw new Error("invalid_chat_thread_idempotency");
  assertIdempotencyKey(value.key);
  const result = validateAcceptedTurn(value.result);
  if (result.idempotencyKey !== value.key) throw new Error("invalid_chat_thread_idempotency");
  return Object.freeze({ key: value.key, fingerprint: value.fingerprint, result });
}

function validateAcceptanceInput(value: MountedP4AcceptanceInput): void {
  assertId("chatThreadId", value.chatThreadId);
  assertId("chatSurfaceSessionId", value.chatSurfaceSessionId);
  assertId("playerId", value.playerId);
  assertId("companionId", value.companionId);
  assertId("continuityId", value.continuityId);
  if (
    !isRevision(value.selectionGeneration) ||
    !Number.isSafeInteger(value.expectedDraftRevision) ||
    value.expectedDraftRevision < 0
  )
    throw new Error("invalid_chat_message_acceptance");
  if (typeof value.locale !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(value.locale))
    throw new Error("invalid_chat_message_locale");
  if (!isText(value.text)) throw new Error("invalid_chat_message_text");
  assertIdempotencyKey(value.idempotencyKey);
}

function validateAttemptClaimInput(value: MountedP4AttemptClaimInput): void {
  assertId("chatThreadId", value.chatThreadId);
  assertId("chatSurfaceSessionId", value.chatSurfaceSessionId);
  assertId("playerId", value.playerId);
  assertId("companionId", value.companionId);
  assertId("continuityId", value.continuityId);
  freezeAttemptClaim({
    generation: 1,
    attemptId: "attempt_validation",
    claimedAtMs: 1,
    selectionGeneration: value.selectionGeneration,
    runtimeBindingDigest: value.runtimeBindingDigest,
    runtimeOwner: value.runtimeOwner,
  });
}

function validateProviderStartInput(value: MountedP4ProviderStartInput): void {
  assertId("chatThreadId", value.chatThreadId);
  assertId("chatSurfaceSessionId", value.chatSurfaceSessionId);
  assertId("playerId", value.playerId);
  assertId("companionId", value.companionId);
  assertId("continuityId", value.continuityId);
  assertId("attemptId", value.attemptId);
  freezeAttemptClaim({
    generation: 1,
    attemptId: "attempt_validation",
    claimedAtMs: 1,
    selectionGeneration: value.selectionGeneration,
    runtimeBindingDigest: value.runtimeBindingDigest,
    runtimeOwner: value.runtimeOwner,
  });
}

function validatePresentationInput(value: MountedP5PresentationInput): void {
  assertId("chatThreadId", value.chatThreadId);
  assertId("chatSurfaceSessionId", value.chatSurfaceSessionId);
  assertId("playerId", value.playerId);
  assertId("companionId", value.companionId);
  assertId("continuityId", value.continuityId);
  assertId("attemptId", value.attemptId);
  freezeAttemptClaim({
    generation: 1,
    attemptId: "attempt_validation",
    claimedAtMs: 1,
    selectionGeneration: value.selectionGeneration,
    runtimeBindingDigest: value.runtimeBindingDigest,
    runtimeOwner: value.runtimeOwner,
  });
}

function isTurnWithAttempt(ledger: ChatTurnLedger): ledger is Exclude<ChatTurnLedger, AcceptedQueuedTurn> {
  return ledger.status !== "accepted_queued";
}

function isTerminalLedger(ledger: ChatTurnLedger): boolean {
  return ledger.status === "completed" || ledger.status === "cancelled" || ledger.status === "failed";
}

function presentationOf(ledger: Exclude<ChatTurnLedger, AcceptedQueuedTurn>): PresentationCommitV1 | null {
  if (
    ledger.status === "presentation_committed" ||
    ledger.status === "completion_claimed" ||
    ledger.status === "completed"
  )
    return ledger.presentation;
  if (ledger.status === "cancel_claimed" || ledger.status === "cancelled" || ledger.status === "failed")
    return ledger.presentation;
  return null;
}

function timestampFor(command: P5PresentationTransition): number {
  if (command.operation === "commit_presentation") return command.committedAtMs;
  if (command.operation === "claim_completion") return command.claimedAtMs;
  if (command.operation === "complete") return command.completedAtMs;
  if (command.operation === "claim_cancel") return command.claimedAtMs;
  if (command.operation === "cancel") return command.cancelledAtMs;
  return command.failedAtMs;
}

function assertExactP5Attempt(attempt: AttemptClaimV1, input: MountedP5PresentationInput): void {
  if (
    attempt.attemptId !== input.attemptId ||
    attempt.generation !== 1 ||
    attempt.selectionGeneration !== input.selectionGeneration ||
    attempt.runtimeBindingDigest !== input.runtimeBindingDigest ||
    attempt.runtimeOwner.ownerToken !== input.runtimeOwner.ownerToken ||
    attempt.runtimeOwner.runtimeInstanceId !== input.runtimeOwner.runtimeInstanceId ||
    attempt.runtimeOwner.ownerPid !== input.runtimeOwner.ownerPid ||
    attempt.runtimeOwner.ownerProcessStartIdentity !== input.runtimeOwner.ownerProcessStartIdentity
  )
    throw new Error("p5_presentation_attempt_mismatch");
}

function validatePresentationTransition(value: P5PresentationTransition): P5PresentationTransition {
  if (!isRecord(value)) throw new Error("invalid_chat_thread_observation");
  switch (value.operation) {
    case "commit_presentation": {
      if (!isRecord(value.message) || value.operation !== "commit_presentation") break;
      const message = value.message as Record<string, unknown>;
      const cancelEpoch = value.cancelEpoch;
      const committedAtMs = value.committedAtMs;
      if (
        !onlyKeys(value, ["operation", "cancelEpoch", "message", "committedAtMs"]) ||
        !Number.isSafeInteger(cancelEpoch) ||
        (cancelEpoch as number) < 0 ||
        !isTimestamp(committedAtMs) ||
        !onlyKeys(message, ["messageId", "text", "occurredAtMs"])
      )
        break;
      validateNormalMessage({
        messageId: message.messageId as string,
        text: message.text as string,
        occurredAtMs: message.occurredAtMs as number,
      });
      freezePresentationCommit(
        Object.freeze({
          expressionId: message.messageId as string,
          messageId: message.messageId as string,
          cancelEpoch: cancelEpoch as number,
          committedAtMs: committedAtMs as number,
        }),
      );
      return Object.freeze({
        operation: "commit_presentation",
        cancelEpoch: cancelEpoch as number,
        message: Object.freeze({
          messageId: message.messageId as string,
          text: message.text as string,
          occurredAtMs: message.occurredAtMs as number,
        }),
        committedAtMs: committedAtMs as number,
      });
    }
    case "claim_completion":
      if (onlyKeys(value, ["operation", "claimedAtMs"]) && isTimestamp(value.claimedAtMs))
        return Object.freeze({ operation: "claim_completion", claimedAtMs: value.claimedAtMs });
      break;
    case "complete":
      if (onlyKeys(value, ["operation", "completedAtMs"]) && isTimestamp(value.completedAtMs))
        return Object.freeze({ operation: "complete", completedAtMs: value.completedAtMs });
      break;
    case "claim_cancel":
      if (onlyKeys(value, ["operation", "claimedAtMs"]) && isTimestamp(value.claimedAtMs))
        return Object.freeze({ operation: "claim_cancel", claimedAtMs: value.claimedAtMs });
      break;
    case "cancel":
      if (onlyKeys(value, ["operation", "cancelledAtMs"]) && isTimestamp(value.cancelledAtMs))
        return Object.freeze({ operation: "cancel", cancelledAtMs: value.cancelledAtMs });
      break;
    case "fail":
      if (
        onlyKeys(value, ["operation", "reasonCode", "failedAtMs"]) &&
        isTimestamp(value.failedAtMs) &&
        (value.reasonCode === "interrupted" ||
          value.reasonCode === "no_visible_presentation" ||
          value.reasonCode === "runtime_unavailable" ||
          value.reasonCode === "storage_unavailable")
      )
        return Object.freeze({
          operation: "fail",
          reasonCode: value.reasonCode as P5TerminalFailureReason,
          failedAtMs: value.failedAtMs,
        });
      break;
    default:
      break;
  }
  throw new Error("invalid_chat_thread_observation");
}

function assertP5ReadBack(
  ledger: ChatTurnLedger | null,
  command: P5PresentationTransition,
  input: MountedP5PresentationInput,
): void {
  if (ledger === null) throw new Error("chat_p5_readback_mismatch");
  const operation = command.operation;
  const expected =
    operation === "commit_presentation"
      ? "presentation_committed"
      : operation === "claim_completion"
        ? "completion_claimed"
        : operation === "complete"
          ? "completed"
          : operation === "claim_cancel"
            ? "cancel_claimed"
            : operation === "cancel"
              ? "cancelled"
              : "failed";
  if (ledger.status !== expected || !isTurnWithAttempt(ledger)) throw new Error("chat_p5_readback_mismatch");
  if (ledger.attempt.attemptId !== input.attemptId) throw new Error("chat_p5_readback_mismatch");
  if (operation === "commit_presentation" && ledger.status === "presentation_committed") {
    if (ledger.presentation.expressionId !== command.message.messageId) throw new Error("chat_p5_readback_mismatch");
  }
  if (operation === "fail" && ledger.status === "failed" && ledger.reasonCode !== command.reasonCode)
    throw new Error("chat_p5_readback_mismatch");
}

function freezePresentationCommit(value: PresentationCommitV1): PresentationCommitV1 {
  if (
    !isId(value.expressionId) ||
    value.expressionId !== value.messageId ||
    !isId(value.messageId) ||
    !Number.isSafeInteger(value.cancelEpoch) ||
    value.cancelEpoch < 0 ||
    !isTimestamp(value.committedAtMs)
  )
    throw new Error("invalid_presentation_commit");
  return Object.freeze({ ...value });
}

function validatePresentationCommit(value: unknown): PresentationCommitV1 {
  if (!isRecord(value) || !onlyKeys(value, ["expressionId", "messageId", "cancelEpoch", "committedAtMs"]))
    throw new Error("invalid_presentation_commit");
  return freezePresentationCommit({
    expressionId: value.expressionId as string,
    messageId: value.messageId as string,
    cancelEpoch: value.cancelEpoch as number,
    committedAtMs: value.committedAtMs as number,
  });
}

function validateProviderStartTransition(value: P4ProviderStartTransition): P4ProviderStartTransition {
  if (!isRecord(value) || !isTimestamp(value.observedAtMs)) throw new Error("invalid_chat_thread_observation");
  if (value.operation === "arm" && onlyKeys(value, ["operation", "observedAtMs"]))
    return Object.freeze({ operation: "arm", observedAtMs: value.observedAtMs });
  if (
    value.operation === "not_started" &&
    onlyKeys(value, ["operation", "reasonCode", "observedAtMs"]) &&
    (value.reasonCode === "admission_revoked" ||
      value.reasonCode === "session_unavailable" ||
      value.reasonCode === "invocation_deadline_expired")
  )
    return Object.freeze({ operation: "not_started", reasonCode: value.reasonCode, observedAtMs: value.observedAtMs });
  if (
    value.operation === "running" &&
    onlyKeys(value, ["operation", "statusClass", "observedAtMs"]) &&
    (value.statusClass === "success" || value.statusClass === "error")
  )
    return Object.freeze({ operation: "running", statusClass: value.statusClass, observedAtMs: value.observedAtMs });
  if (
    value.operation === "fail" &&
    onlyKeys(value, ["operation", "reasonCode", "observedAtMs", "failedAtMs"]) &&
    value.reasonCode === "runtime_unavailable" &&
    isTimestamp(value.failedAtMs) &&
    value.failedAtMs >= value.observedAtMs
  )
    return Object.freeze({
      operation: "fail",
      reasonCode: "runtime_unavailable",
      observedAtMs: value.observedAtMs,
      failedAtMs: value.failedAtMs,
    });
  if (
    value.operation === "cancel" &&
    onlyKeys(value, ["operation", "observedAtMs", "cancelledAtMs"]) &&
    isTimestamp(value.cancelledAtMs) &&
    value.cancelledAtMs >= value.observedAtMs
  )
    return Object.freeze({
      operation: "cancel",
      observedAtMs: value.observedAtMs,
      cancelledAtMs: value.cancelledAtMs,
    });
  throw new Error("invalid_chat_thread_observation");
}

function assertExactProviderStartAttempt(attempt: AttemptClaimV1, input: MountedP4ProviderStartInput): void {
  if (
    attempt.attemptId !== input.attemptId ||
    attempt.selectionGeneration !== input.selectionGeneration ||
    attempt.runtimeBindingDigest !== input.runtimeBindingDigest ||
    attempt.runtimeOwner.ownerToken !== input.runtimeOwner.ownerToken ||
    attempt.runtimeOwner.runtimeInstanceId !== input.runtimeOwner.runtimeInstanceId ||
    attempt.runtimeOwner.ownerPid !== input.runtimeOwner.ownerPid ||
    attempt.runtimeOwner.ownerProcessStartIdentity !== input.runtimeOwner.ownerProcessStartIdentity
  )
    throw new Error("provider_start_attempt_mismatch");
}

function assertProviderStartReadBack(
  ledger: ChatTurnLedger | null,
  command: P4ProviderStartTransition,
  input: MountedP4ProviderStartInput,
): void {
  if (ledger === null) throw new Error("chat_provider_start_readback_mismatch");
  if (command.operation === "arm") {
    if (
      ledger.status !== "attempt_starting" ||
      ledger.attempt.attemptId !== input.attemptId ||
      ledger.observation?.phase !== "armed"
    )
      throw new Error("chat_provider_start_readback_mismatch");
    return;
  }
  if (command.operation === "not_started") {
    if (
      ledger.status !== "attempt_starting" ||
      ledger.attempt.attemptId !== input.attemptId ||
      ledger.observation?.phase !== "not_started" ||
      ledger.observation.reasonCode !== command.reasonCode
    )
      throw new Error("chat_provider_start_readback_mismatch");
    return;
  }
  if (command.operation === "fail") {
    if (
      ledger.status !== "failed" ||
      ledger.attempt.attemptId !== input.attemptId ||
      ledger.observation.phase !== "armed" ||
      ledger.reasonCode !== command.reasonCode ||
      ledger.failedAtMs !== command.failedAtMs
    )
      throw new Error("chat_provider_start_readback_mismatch");
    return;
  }
  if (command.operation === "cancel") {
    if (
      ledger.status !== "cancelled" ||
      ledger.attempt.attemptId !== input.attemptId ||
      ledger.observation.phase !== "armed" ||
      ledger.cancelledAtMs !== command.cancelledAtMs
    )
      throw new Error("chat_provider_start_readback_mismatch");
    return;
  }
  if (
    ledger.status !== "running" ||
    ledger.attempt.attemptId !== input.attemptId ||
    ledger.observation.phase !== "running" ||
    ledger.observation.statusClass !== command.statusClass
  )
    throw new Error("chat_provider_start_readback_mismatch");
}

function assertIdempotencyKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(value)) throw new Error("invalid_idempotency_key");
}

function acceptanceFingerprint(input: MountedP4AcceptanceInput): string {
  const fields = [
    "chat.message.submit",
    input.chatThreadId,
    input.chatSurfaceSessionId,
    input.playerId,
    input.companionId,
    input.continuityId,
    String(input.selectionGeneration),
    input.text,
    input.locale,
    String(input.expectedDraftRevision),
  ];
  const canonical = fields.map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validateTurnIntegrity(
  messages: readonly ChatThreadMessage[],
  turnLedger: ChatTurnLedger | null,
  idempotency: readonly IdempotencyRecord[],
): void {
  if (new Set(idempotency.map((record) => record.key)).size !== idempotency.length)
    throw new Error("invalid_chat_thread_idempotency");
  if (
    new Set(idempotency.map((record) => record.result.turnId)).size !== idempotency.length ||
    new Set(idempotency.map((record) => record.result.messageId)).size !== idempotency.length
  )
    throw new Error("invalid_chat_thread_idempotency");
  for (const record of idempotency) {
    if (
      !messages.some(
        (message) =>
          message.messageId === record.result.messageId && message.role === "player" && message.kind === "player",
      )
    )
      throw new Error("invalid_chat_thread_idempotency");
  }
  if (turnLedger === null) {
    if (idempotency.length !== 0) throw new Error("invalid_chat_thread_idempotency");
    return;
  }
  if (
    !messages.some(
      (message) => message.messageId === turnLedger.messageId && message.role === "player" && message.kind === "player",
    )
  )
    throw new Error("invalid_chat_thread_turn_ledger");
  const matching = idempotency.filter(
    (record) =>
      record.key === turnLedger.idempotencyKey &&
      record.result.turnId === turnLedger.turnId &&
      record.result.messageId === turnLedger.messageId &&
      record.result.acceptedAtMs === turnLedger.acceptedAtMs,
  );
  if (matching.length !== 1) throw new Error("invalid_chat_thread_turn_ledger");
  if (isTurnWithAttempt(turnLedger)) {
    const presentation = presentationOf(turnLedger);
    if (presentation !== null) {
      const bubble = messages.find((message) => message.messageId === presentation.messageId);
      if (bubble === undefined || bubble.role !== "companion" || bubble.kind !== "response")
        throw new Error("invalid_chat_thread_turn_ledger");
    }
  }
}

function freezeState(state: ChatThreadState): ChatThreadState {
  validateOpeningConsistency(state.thread, state.messages);
  validateTurnIntegrity(state.messages, state.turnLedger, state.idempotency);
  return Object.freeze({
    thread: state.thread,
    messages: Object.freeze([...state.messages]),
    draft: freezeDraft(state.draft),
    turnLedger: state.turnLedger === null ? null : validateTurnLedger(state.turnLedger),
    idempotency: Object.freeze(state.idempotency.map(validateIdempotency)),
  });
}

function freezeThread(thread: ChatThread): ChatThread {
  const lifecycleStatus = validateLifecycleStatus(thread.lifecycleStatus);
  const trashRestoreStatus =
    thread.trashRestoreStatus === undefined ? undefined : validateTrashRestoreStatus(thread.trashRestoreStatus);
  if (lifecycleStatus === "trashed" ? trashRestoreStatus === undefined : trashRestoreStatus !== undefined)
    throw new Error("invalid_chat_thread_trash_restore_status");
  return Object.freeze({
    ...thread,
    title: validateStoredThreadTitle(thread.title),
    lifecycleStatus,
    managementRevision: validateManagementRevision(thread.managementRevision),
    ...(trashRestoreStatus === undefined ? { trashRestoreStatus: undefined } : { trashRestoreStatus }),
    stableArtifactBindings: freezeStableArtifactBindings(thread.stableArtifactBindings ?? []),
    ...(thread.worldBookBinding === undefined
      ? {}
      : {
          worldBookBinding: freezeStableWorldBookBinding(thread.worldBookBinding),
        }),
    openingSelection:
      thread.openingSelection.kind === "blank"
        ? Object.freeze({ kind: "blank" })
        : Object.freeze({
            kind: "greeting",
            messageId: thread.openingSelection.messageId,
            source: freezeGreetingSource(thread.openingSelection.source),
          }),
  });
}

function freezeStableArtifactBindings(values: unknown): readonly TavernStableArtifactBinding[] {
  if (!Array.isArray(values) || values.length > 3) throw new Error("invalid_tavern_stable_binding");
  const bindings = values.map((value) => {
    if (
      !isRecord(value) ||
      !onlyKeys(value, ["kind", "sourceId", "revision", "canonicalHash"]) ||
      (value.kind !== "persona" && value.kind !== "scenario" && value.kind !== "dialogue_examples") ||
      !isId(value.sourceId) ||
      !isRevision(value.revision) ||
      !isHash(value.canonicalHash)
    )
      throw new Error("invalid_tavern_stable_binding");
    return Object.freeze({
      kind: value.kind,
      sourceId: value.sourceId,
      revision: value.revision,
      canonicalHash: value.canonicalHash,
    });
  });
  if (new Set(bindings.map((value) => value.kind)).size !== bindings.length)
    throw new Error("invalid_tavern_stable_binding");
  return Object.freeze(bindings);
}

function freezeStableWorldBookBinding(value: unknown): TavernStableWorldInfoBinding {
  if (!isRecord(value) || !isRevision(value.revision) || !isHash(value.canonicalHash))
    throw new Error("invalid_tavern_worldbook_binding");
  if ("source" in value && value.source === "managed_world_info") {
    if (!isText(value.publicTitle) || !onlyKeys(value, ["source", "publicTitle", "revision", "canonicalHash"]))
      throw new Error("invalid_tavern_worldbook_binding");
    return Object.freeze({
      source: "managed_world_info",
      publicTitle: value.publicTitle,
      revision: value.revision,
      canonicalHash: value.canonicalHash,
    });
  }
  if (
    !onlyKeys(value, ["worldBookId", "revision", "canonicalHash", "provenance"]) ||
    !("worldBookId" in value) ||
    !isId(value.worldBookId) ||
    (value.provenance !== "authored" && value.provenance !== "st-card-import" && value.provenance !== "reviewed-import")
  )
    throw new Error("invalid_tavern_worldbook_binding");
  return Object.freeze({
    worldBookId: value.worldBookId,
    revision: value.revision,
    canonicalHash: value.canonicalHash,
    provenance: value.provenance,
  });
}

function freezeMessage(message: ChatThreadMessage): ChatThreadMessage {
  return Object.freeze({
    ...message,
    greetingSource: message.greetingSource === null ? null : freezeGreetingSource(message.greetingSource),
  });
}

function freezeGreetingSource(source: GreetingSource): GreetingSource {
  return Object.freeze({ ...source });
}

function assertId(label: string, value: unknown): asserts value is string {
  if (!isId(value)) throw new Error(`invalid_${label}`);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertText(value: unknown): asserts value is string {
  if (!isText(value)) throw new Error("invalid_chat_thread_text");
}

function normalizeThreadTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_chat_thread_title");
  const title = value.trim();
  if (!isThreadTitle(title)) throw new Error("invalid_chat_thread_title");
  return title;
}

function validateStoredThreadTitle(value: unknown): string | null {
  if (value === null) return null;
  if (!isThreadTitle(value)) throw new Error("invalid_chat_thread_title");
  return value;
}

function isThreadTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    !/\p{Cc}/u.test(value) &&
    value === value.trim()
  );
}

function validateLifecycleStatus(value: unknown): "active" | "archived" | "trashed" {
  if (value === "active" || value === "archived" || value === "trashed") return value;
  throw new Error("invalid_chat_thread_lifecycle_status");
}

function validateTrashRestoreStatus(value: unknown): "active" | "archived" {
  if (value === "active" || value === "archived") return value;
  throw new Error("invalid_chat_thread_trash_restore_status");
}

function resolveLifecycleTransition(
  status: "active" | "archived" | "trashed",
  restoreStatus: "active" | "archived" | undefined,
  operation: "archive" | "restore" | "trash",
): Readonly<{
  status: "active" | "archived" | "trashed";
  trashRestoreStatus?: "active" | "archived";
}> {
  if (operation === "archive" && status === "active") return Object.freeze({ status: "archived" });
  if (operation === "restore" && status === "archived") return Object.freeze({ status: "active" });
  if (operation === "trash" && (status === "active" || status === "archived"))
    return Object.freeze({ status: "trashed", trashRestoreStatus: status });
  if (operation === "restore" && status === "trashed" && restoreStatus !== undefined)
    return Object.freeze({ status: restoreStatus });
  throw new Error("chat_thread_lifecycle_transition_invalid");
}

function validateManagementRevision(value: unknown): number {
  assertManagementRevision(value);
  return value;
}

function assertManagementRevision(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid_chat_thread_management_revision");
}

function assertTimestamp(value: unknown): asserts value is number {
  if (!isTimestamp(value)) throw new Error("invalid_chat_thread_timestamp");
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.normalize("NFC") &&
    !/[\u0000-\u001F\u007F-\u009F]/u.test(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_CHAT_MESSAGE_TEXT_UTF8_BYTES
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
