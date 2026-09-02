import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertMountedTurnTransitionAuthority,
  assertMountedTurnTransitionOperationAuthority,
  type MountedTurnTransitionAuthority,
  type MountedTurnTransitionOperationAuthority,
} from "./chat-thread-store.mounted-turn-transition.internal.js";

/**
 * Scoped Tavern persistence seam. It owns only a ChatThread's visible opening,
 * append-only messages, swipe variants, and turn lifecycle; it neither reads
 * Pi/Magic Context state nor implements message edit/branch or any Game operation.
 */
export const CHAT_THREAD_SCHEMA_VERSION = 2 as const;
export const CHAT_THREAD_SELECTION_SCHEMA_VERSION = 1 as const;

/** Individual message text remains bounded; normalized transcripts have no entry ceiling. */
export const MAX_CHAT_MESSAGE_TEXT_UTF8_BYTES = 16_384 as const;

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
  parentId?: string | null;
  swipes?: readonly string[];
  activeSwipeIndex?: number;
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

type MountedAcceptanceInput = Readonly<{
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
type MountedAcceptanceCommand = Readonly<{
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
  selectSwipe?(
    chatThreadId: string,
    messageId: string,
    selection: Readonly<{ targetIndex?: number; direction?: "prev" | "next" }>,
  ): Promise<ChatThreadState>;
  appendSwipeVariant?(
    chatThreadId: string,
    messageId: string,
    newText: string,
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

const genuineChatThreadStores = new WeakSet<object>();
const acceptanceByStore = new WeakMap<object, (input: MountedAcceptanceInput) => Promise<AcceptedQueuedTurn>>();
type MountedAttemptClaimInput = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  playerId: string;
  companionId: string;
  continuityId: string;
  selectionGeneration: number;
  runtimeBindingDigest: string;
  runtimeOwner: AttemptClaimV1["runtimeOwner"];
}>;
const attemptClaimByStore = new WeakMap<
  object,
  (input: MountedAttemptClaimInput) => Promise<AttemptStartingTurn>
>();

/** P4c's three frozen store transitions: arm, local pre-invocation not_started, running. */
export type ProviderStartTransition =
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
export type PresentationTransition =
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

type MountedPresentationInput = Readonly<{
  authority: MountedTurnTransitionAuthority;
  operationAuthority: MountedTurnTransitionOperationAuthority;
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
const presentationByStore = new WeakMap<
  object,
  (input: MountedPresentationInput, command: PresentationTransition) => Promise<ChatTurnLedger>
>();
type MountedProviderStartInput = Readonly<{
  authority: MountedTurnTransitionAuthority;
  operationAuthority: MountedTurnTransitionOperationAuthority;
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
const providerStartByStore = new WeakMap<
  object,
  (
    input: MountedProviderStartInput,
    command: ProviderStartTransition,
  ) => Promise<AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn>
>();

/**
 * Host-private P4 store ingress. Its binding input has no exported type and is
 * derived only by player-turn-acceptance.internal.ts after coordinator
 * admission consumption; it is not part of ChatThreadStore's public surface.
 */
export async function acceptMountedPlayerMessage(
  binding: Readonly<{
    runtimeRoot: string;
    playerId: string;
    companionId: string;
    continuityId: string;
    chatThreadId: string;
    chatSurfaceSessionId: string;
    selectionGeneration: number;
  }>,
  command: MountedAcceptanceCommand,
): Promise<AcceptedQueuedTurn> {
  const store = createChatThreadStore(
    binding.runtimeRoot,
    identityKeyForP4(binding.playerId, binding.companionId, binding.continuityId),
  );
  const accept = acceptanceByStore.get(store);
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
export async function claimMountedAttempt(
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
  const claim = attemptClaimByStore.get(store);
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
export async function transitionMountedProviderStart(
  binding: Readonly<{
    authority: MountedTurnTransitionAuthority;
    operationAuthority: MountedTurnTransitionOperationAuthority;
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
  command: ProviderStartTransition,
): Promise<AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn> {
  assertMountedTurnTransitionAuthority(binding.authority);
  assertMountedTurnTransitionOperationAuthority(binding.operationAuthority);
  const store = createChatThreadStore(
    binding.runtimeRoot,
    identityKeyForP4(binding.playerId, binding.companionId, binding.continuityId),
  );
  const transition = providerStartByStore.get(store);
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
export async function transitionMountedPresentation(
  binding: Readonly<{
    authority: MountedTurnTransitionAuthority;
    operationAuthority: MountedTurnTransitionOperationAuthority;
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
  command: PresentationTransition,
): Promise<ChatTurnLedger> {
  assertMountedTurnTransitionAuthority(binding.authority);
  assertMountedTurnTransitionOperationAuthority(binding.operationAuthority);
  const store = createChatThreadStore(
    binding.runtimeRoot,
    identityKeyForP4(binding.playerId, binding.companionId, binding.continuityId),
  );
  const transition = presentationByStore.get(store);
  if (transition === undefined) throw new Error("p5_presentation_port_unavailable");
  try {
    return await transition(asMountedPresentationInput(binding), validatePresentationTransition(command));
  } finally {
    store.close?.();
  }
}

function asMountedPresentationInput(
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
    authority: MountedTurnTransitionAuthority;
    operationAuthority: MountedTurnTransitionOperationAuthority;
  }>,
): MountedPresentationInput {
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
  const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const version = Number(versionRow?.user_version ?? 0);
  if (version === 2) {
    assertNormalizedSchema(db);
    return;
  }
  if (version !== 0) throw new Error("chat_thread_schema_version_mismatch");

  const existingTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as any[];
  if (existingTables.length !== 0) throw new Error("chat_thread_schema_version_mismatch");

  db.exec(`
    CREATE TABLE tavern_threads (
      thread_id TEXT PRIMARY KEY,
      companion_id TEXT NOT NULL,
      continuity_id TEXT NOT NULL,
      title TEXT,
      persona_id TEXT,
      scenario_id TEXT,
      chat_surface_session_id TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL DEFAULT 'active'
        CHECK(lifecycle_status IN ('active', 'archived', 'trashed')),
      management_revision INTEGER NOT NULL DEFAULT 1
        CHECK(management_revision >= 1),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      opening_kind TEXT NOT NULL CHECK(opening_kind IN ('blank', 'greeting')),
      opening_message_id TEXT,
      greeting_set_id TEXT,
      greeting_source_revision INTEGER,
      greeting_canonical_hash TEXT,
      greeting_variant_id TEXT,
      greeting_profile_revision INTEGER,
      greeting_scenario_revision INTEGER,
      opening_locked_at_event_id TEXT,
      trash_restore_status TEXT
        CHECK(trash_restore_status IS NULL OR trash_restore_status IN ('active', 'archived')),
      CHECK(
        (opening_kind = 'blank' AND opening_message_id IS NULL AND greeting_set_id IS NULL
          AND greeting_source_revision IS NULL AND greeting_canonical_hash IS NULL
          AND greeting_variant_id IS NULL AND greeting_profile_revision IS NULL
          AND greeting_scenario_revision IS NULL)
        OR
        (opening_kind = 'greeting' AND opening_message_id IS NOT NULL AND greeting_set_id IS NOT NULL
          AND greeting_source_revision IS NOT NULL AND greeting_canonical_hash IS NOT NULL
          AND greeting_variant_id IS NOT NULL AND greeting_profile_revision IS NOT NULL)
      ),
      CHECK(
        (lifecycle_status = 'trashed' AND trash_restore_status IS NOT NULL)
        OR (lifecycle_status <> 'trashed' AND trash_restore_status IS NULL)
      )
    );

    CREATE TABLE tavern_messages (
      thread_id TEXT NOT NULL REFERENCES tavern_threads(thread_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      append_ordinal INTEGER NOT NULL CHECK(append_ordinal >= 0),
      role TEXT NOT NULL CHECK(role IN ('player', 'companion')),
      kind TEXT NOT NULL CHECK(kind IN ('opening', 'player', 'response')),
      text TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      parent_id TEXT,
      active_swipe_index INTEGER NOT NULL DEFAULT 0 CHECK(active_swipe_index >= 0),
      greeting_set_id TEXT,
      greeting_source_revision INTEGER,
      greeting_canonical_hash TEXT,
      greeting_variant_id TEXT,
      greeting_profile_revision INTEGER,
      greeting_scenario_revision INTEGER,
      PRIMARY KEY(thread_id, message_id),
      UNIQUE(thread_id, append_ordinal),
      FOREIGN KEY(thread_id, parent_id)
        REFERENCES tavern_messages(thread_id, message_id)
        ON DELETE RESTRICT,
      CHECK(
        (kind = 'opening' AND role = 'companion' AND greeting_set_id IS NOT NULL
          AND greeting_source_revision IS NOT NULL AND greeting_canonical_hash IS NOT NULL
          AND greeting_variant_id IS NOT NULL AND greeting_profile_revision IS NOT NULL)
        OR (kind = 'player' AND role = 'player' AND greeting_set_id IS NULL
          AND greeting_source_revision IS NULL AND greeting_canonical_hash IS NULL
          AND greeting_variant_id IS NULL AND greeting_profile_revision IS NULL
          AND greeting_scenario_revision IS NULL)
        OR (kind = 'response' AND role = 'companion' AND greeting_set_id IS NULL
          AND greeting_source_revision IS NULL AND greeting_canonical_hash IS NULL
          AND greeting_variant_id IS NULL AND greeting_profile_revision IS NULL
          AND greeting_scenario_revision IS NULL)
      )
    );

    CREATE TABLE tavern_message_swipes (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      swipe_index INTEGER NOT NULL CHECK(swipe_index >= 0),
      text TEXT NOT NULL,
      PRIMARY KEY(thread_id, message_id, swipe_index),
      FOREIGN KEY(thread_id, message_id)
        REFERENCES tavern_messages(thread_id, message_id)
        ON DELETE CASCADE
    );

    CREATE TABLE tavern_thread_stable_artifact_bindings (
      thread_id TEXT NOT NULL REFERENCES tavern_threads(thread_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('persona', 'scenario', 'dialogue_examples')),
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      canonical_hash TEXT NOT NULL,
      PRIMARY KEY(thread_id, kind)
    );

    CREATE TABLE tavern_thread_world_info_bindings (
      thread_id TEXT PRIMARY KEY REFERENCES tavern_threads(thread_id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('world_book', 'managed_world_info')),
      world_book_id TEXT,
      public_title TEXT,
      revision INTEGER NOT NULL CHECK(revision > 0),
      canonical_hash TEXT NOT NULL,
      provenance TEXT,
      CHECK(
        (source = 'world_book' AND world_book_id IS NOT NULL AND public_title IS NULL
          AND provenance IN ('authored', 'st-card-import', 'reviewed-import'))
        OR
        (source = 'managed_world_info' AND world_book_id IS NULL AND public_title IS NOT NULL
          AND provenance IS NULL)
      )
    );

    CREATE TABLE tavern_turns (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES tavern_threads(thread_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN (
        'accepted_queued', 'attempt_starting', 'running',
        'presentation_committed', 'completion_claimed', 'completed',
        'cancel_claimed', 'cancelled', 'failed'
      )),
      idempotency_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      accepted_at_ms INTEGER NOT NULL,
      is_current INTEGER NOT NULL CHECK(is_current IN (0, 1)),
      UNIQUE(thread_id, message_id)
    );

    CREATE TABLE tavern_turn_attempts (
      turn_id TEXT PRIMARY KEY REFERENCES tavern_turns(turn_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK(generation = 1),
      attempt_id TEXT NOT NULL UNIQUE,
      claimed_at_ms INTEGER NOT NULL,
      selection_generation INTEGER NOT NULL CHECK(selection_generation > 0),
      runtime_binding_digest TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
      owner_process_start_identity TEXT NOT NULL
    );

    CREATE TABLE tavern_turn_observations (
      turn_id TEXT PRIMARY KEY REFERENCES tavern_turns(turn_id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK(phase IN ('armed', 'not_started', 'running')),
      reason_code TEXT,
      source TEXT,
      status_class TEXT,
      observed_at_ms INTEGER NOT NULL
    );

    CREATE TABLE tavern_turn_presentations (
      turn_id TEXT PRIMARY KEY REFERENCES tavern_turns(turn_id) ON DELETE CASCADE,
      expression_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      cancel_epoch INTEGER NOT NULL CHECK(cancel_epoch >= 0),
      committed_at_ms INTEGER NOT NULL
    );

    CREATE TABLE tavern_turn_terminalizations (
      turn_id TEXT PRIMARY KEY REFERENCES tavern_turns(turn_id) ON DELETE CASCADE,
      completion_claimed_at_ms INTEGER,
      completed_at_ms INTEGER,
      cancel_claimed_at_ms INTEGER,
      cancelled_at_ms INTEGER,
      failed_at_ms INTEGER,
      reason_code TEXT
    );

    CREATE TABLE tavern_chat_submit_idempotency (
      thread_id TEXT NOT NULL REFERENCES tavern_threads(thread_id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      turn_id TEXT NOT NULL REFERENCES tavern_turns(turn_id) ON DELETE RESTRICT,
      PRIMARY KEY(thread_id, idempotency_key),
      UNIQUE(thread_id, turn_id)
    );

    CREATE TABLE tavern_drafts (
      thread_id TEXT PRIMARY KEY REFERENCES tavern_threads(thread_id) ON DELETE CASCADE,
      draft_content TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE tavern_active_selection (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      chat_thread_id TEXT NOT NULL REFERENCES tavern_threads(thread_id) ON DELETE CASCADE,
      chat_surface_session_id TEXT NOT NULL,
      selected_at_ms INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX idx_tavern_turns_one_current_per_thread
      ON tavern_turns(thread_id) WHERE is_current = 1;
    CREATE INDEX idx_tavern_threads_continuity
      ON tavern_threads(continuity_id, thread_id);
    CREATE INDEX idx_tavern_messages_ordinal
      ON tavern_messages(thread_id, append_ordinal);
    CREATE INDEX idx_tavern_idempotency_turn
      ON tavern_chat_submit_idempotency(turn_id);
  `);
  db.exec("PRAGMA user_version = 2");
  assertNormalizedSchema(db);
}

function assertNormalizedSchema(db: DatabaseSync): void {
  const requiredTables = [
    "tavern_threads",
    "tavern_messages",
    "tavern_message_swipes",
    "tavern_thread_stable_artifact_bindings",
    "tavern_thread_world_info_bindings",
    "tavern_turns",
    "tavern_turn_attempts",
    "tavern_turn_observations",
    "tavern_turn_presentations",
    "tavern_turn_terminalizations",
    "tavern_chat_submit_idempotency",
    "tavern_drafts",
    "tavern_active_selection",
  ];
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((row) => row.name),
  );
  if (requiredTables.some((table) => !tables.has(table)))
    throw new Error("chat_thread_schema_mismatch");
  const threadColumns = new Set(
    (db.prepare("PRAGMA table_info(tavern_threads)").all() as any[]).map((column) => column.name),
  );
  const requiredThreadColumns = [
    "thread_id",
    "companion_id",
    "continuity_id",
    "chat_surface_session_id",
    "opening_kind",
    "opening_message_id",
    "opening_locked_at_event_id",
  ];
  if (
    requiredThreadColumns.some((column) => !threadColumns.has(column)) ||
    threadColumns.has("metadata_json") ||
    threadColumns.has("opening_selection_json") ||
    threadColumns.has("session_file")
  )
    throw new Error("chat_thread_schema_mismatch");
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
  const continuityRoot = join(root, "tavern", "v2", "continuities", continuityKey);
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
        const initialMessages: ChatThreadMessage[] =
          opening === "blank"
            ? []
            : [validateMessage({ messageId: opening.messageId, role: "companion", kind: "opening", text: opening.text, occurredAtMs: timestamp, greetingSource: opening.source })];
        const greeting = opening === "blank" ? null : opening.source;
        db.prepare(
          `INSERT INTO tavern_threads (
            thread_id, companion_id, continuity_id, title, persona_id, scenario_id,
            chat_surface_session_id, lifecycle_status, management_revision, created_at_ms, updated_at_ms,
            opening_kind, opening_message_id, greeting_set_id, greeting_source_revision, greeting_canonical_hash,
            greeting_variant_id, greeting_profile_revision, greeting_scenario_revision, opening_locked_at_event_id
          ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          request.chatThreadId, request.companionId, request.continuityId,
          request.personaId ?? null, request.scenarioId ?? null, request.chatSurfaceSessionId, timestamp, timestamp,
          opening === "blank" ? "blank" : "greeting", opening === "blank" ? null : opening.messageId,
          greeting?.greetingSetId ?? null, greeting?.sourceRevision ?? null, greeting?.canonicalHash ?? null,
          greeting?.variantId ?? null, greeting?.profileRevision ?? null, greeting?.scenarioRevision ?? null,
        );
        for (const binding of request.stableArtifactBindings ?? [])
          db.prepare(`INSERT INTO tavern_thread_stable_artifact_bindings (thread_id, kind, source_id, revision, canonical_hash) VALUES (?, ?, ?, ?, ?)`)
            .run(request.chatThreadId, binding.kind, binding.sourceId, binding.revision, binding.canonicalHash);
        if (request.worldBookBinding) writeWorldInfoBinding(db, request.chatThreadId, request.worldBookBinding);
        for (const message of initialMessages) insertMessage(db, request.chatThreadId, message);
        db.prepare(`INSERT INTO tavern_drafts (thread_id, draft_content, revision, updated_at_ms) VALUES (?, NULL, 0, ?)`).run(request.chatThreadId, timestamp);
        return readStateFromDb(db, request.chatThreadId);
      });
    },

    async listThreads(): Promise<readonly ChatThread[]> {
      return withDb((db) => {
        const rows = db.prepare("SELECT * FROM tavern_threads ORDER BY thread_id ASC").all() as any[];
        return Object.freeze(rows.map((row) => rowToThread(db, row)));
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
        const thread = rowToThread(db, threadRow);
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
        const openingMessage: ChatThreadMessage | null = opening === "blank" ? null : validateMessage({ messageId: opening.messageId, role: "companion", kind: "opening", text: opening.text, occurredAtMs: updatedAt, greetingSource: opening.source });
        const greeting = opening === "blank" ? null : opening.source;
        db.prepare("UPDATE tavern_threads SET opening_kind = ?, opening_message_id = ?, greeting_set_id = ?, greeting_source_revision = ?, greeting_canonical_hash = ?, greeting_variant_id = ?, greeting_profile_revision = ?, greeting_scenario_revision = ?, updated_at_ms = ? WHERE thread_id = ?").run(opening === "blank" ? "blank" : "greeting", opening === "blank" ? null : opening.messageId, greeting?.greetingSetId ?? null, greeting?.sourceRevision ?? null, greeting?.canonicalHash ?? null, greeting?.variantId ?? null, greeting?.profileRevision ?? null, greeting?.scenarioRevision ?? null, updatedAt, chatThreadId);
        replaceOpeningMessage(db, chatThreadId, openingMessage);
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
        const lockedAt = current.thread.openingLockedAtEventId ?? message.messageId;
        const updatedAt = now();
        db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, opening_locked_at_event_id = ? WHERE thread_id = ?").run(updatedAt, lockedAt, chatThreadId);
        insertMessage(db, chatThreadId, validateMessage({ messageId: message.messageId, role: "player", kind: "player", text: message.text, occurredAtMs: message.occurredAtMs, greetingSource: null }));
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
        const lockedAt = current.thread.openingLockedAtEventId ?? response.messageId;
        const updatedAt = now();
        db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, opening_locked_at_event_id = ? WHERE thread_id = ?").run(updatedAt, lockedAt, chatThreadId);
        insertMessage(db, chatThreadId, validateMessage({ messageId: response.messageId, role: "companion", kind: "response", text: response.text, occurredAtMs: response.occurredAtMs, greetingSource: null }));
        return readStateFromDb(db, chatThreadId);
      });
    },

    async selectSwipe(chatThreadId, messageId, selection): Promise<ChatThreadState> {
      assertId("chatThreadId", chatThreadId);
      assertId("messageId", messageId);
      return withDb((db) => {
        const current = readStateFromDb(db, chatThreadId);
        const target = current.messages.find((message) => message.messageId === messageId);
        if (!target) throw new Error("message_not_found");
        const swipes = target.swipes && target.swipes.length ? target.swipes : [target.text];
        const currentIndex = target.activeSwipeIndex ?? 0;
        if (target.role !== "companion") throw new Error("chat_thread_swipe_not_allowed");
        let activeSwipeIndex = currentIndex;
        if (selection.targetIndex !== undefined && selection.targetIndex >= 0 && selection.targetIndex < swipes.length)
          activeSwipeIndex = selection.targetIndex;
        else if (selection.direction === "next") activeSwipeIndex = Math.min(swipes.length - 1, currentIndex + 1);
        else if (selection.direction === "prev") activeSwipeIndex = Math.max(0, currentIndex - 1);
        db.prepare(
          "UPDATE tavern_messages SET text = ?, active_swipe_index = ? WHERE thread_id = ? AND message_id = ?",
        ).run(swipes[activeSwipeIndex], activeSwipeIndex, chatThreadId, messageId);
        db.prepare("UPDATE tavern_threads SET updated_at_ms = ? WHERE thread_id = ?").run(now(), chatThreadId);
        return readStateFromDb(db, chatThreadId);
      });
    },

    async appendSwipeVariant(chatThreadId, messageId, newText): Promise<ChatThreadState> {
      assertId("chatThreadId", chatThreadId);
      assertId("messageId", messageId);
      assertText(newText);
      return withDb((db) => {
        const current = readStateFromDb(db, chatThreadId);
        const target = current.messages.find((message) => message.messageId === messageId);
        if (!target) throw new Error("message_not_found");
        if (target.role !== "companion") throw new Error("chat_thread_swipe_not_allowed");
        const nextIndex = target.swipes?.length ?? 1;
        if (target.swipes === undefined) {
          db.prepare(
            "INSERT INTO tavern_message_swipes (thread_id, message_id, swipe_index, text) VALUES (?, ?, 0, ?)",
          ).run(chatThreadId, messageId, target.text);
        }
        db.prepare(
          "INSERT INTO tavern_message_swipes (thread_id, message_id, swipe_index, text) VALUES (?, ?, ?, ?)",
        ).run(chatThreadId, messageId, nextIndex, newText);
        db.prepare(
          "UPDATE tavern_messages SET text = ?, active_swipe_index = ? WHERE thread_id = ? AND message_id = ?",
        ).run(newText, nextIndex, chatThreadId, messageId);
        db.prepare("UPDATE tavern_threads SET updated_at_ms = ? WHERE thread_id = ?").run(now(), chatThreadId);
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
        persistTurn(db, input.chatThreadId, nextLedger);
        db.prepare("UPDATE tavern_threads SET updated_at_ms = ? WHERE thread_id = ?").run(
          input.cancelledAtMs, input.chatThreadId,
        );
        const readBack = readStateFromDb(db, input.chatThreadId);
        if (readBack.turnLedger?.status !== "cancelled" || readBack.turnLedger.turnId !== input.expectedTurnId)
          throw new Error("chat_turn_cancel_readback_mismatch");
        return readBack;
      });
    },

    async setWorldBookBinding(input): Promise<ChatThreadState> {
      assertId("chatThreadId", input.chatThreadId);
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
        if (current.thread.updatedAtMs !== input.expectedUpdatedAtMs)
          throw new Error("chat_thread_revision_conflict");
        if (current.messages.length !== 0) throw new Error("chat_thread_worldbook_locked");

        const updatedAt = now();
        writeWorldInfoBinding(db, input.chatThreadId, input.binding ? freezeStableWorldBookBinding(input.binding) : undefined);
        db.prepare("UPDATE tavern_threads SET updated_at_ms = ? WHERE thread_id = ?").run(updatedAt, input.chatThreadId);

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

        db.prepare("UPDATE tavern_threads SET lifecycle_status = ?, management_revision = ?, trash_restore_status = ? WHERE thread_id = ?").run(
          transition.status, nextRevision, transition.trashRestoreStatus ?? null, input.chatThreadId,
        );

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
  acceptanceByStore.set(store, acceptMounted);
  attemptClaimByStore.set(store, claimMountedAttempt);
  providerStartByStore.set(store, transitionMountedProviderStart);
  presentationByStore.set(store, transitionMountedPresentation);
  return store;

  async function acceptMounted(input: MountedAcceptanceInput): Promise<AcceptedQueuedTurn> {
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
      const existingRow = db.prepare(
        "SELECT i.fingerprint, i.turn_id, t.idempotency_key, t.message_id, t.accepted_at_ms FROM tavern_chat_submit_idempotency i JOIN tavern_turns t ON t.turn_id = i.turn_id AND t.thread_id = i.thread_id WHERE i.thread_id = ? AND i.idempotency_key = ?",
      ).get(input.chatThreadId, input.idempotencyKey) as any;
      if (existingRow !== undefined) {
        if (existingRow.fingerprint !== fingerprint) throw new Error("idempotency_conflict");
        return validateAcceptedTurn({
          turnId: existingRow.turn_id,
          status: "accepted_queued",
          idempotencyKey: existingRow.idempotency_key,
          messageId: existingRow.message_id,
          acceptedAtMs: existingRow.accepted_at_ms,
        });
      }
      if (
        current.turnLedger !== null &&
        current.turnLedger.status !== "completed" &&
        current.turnLedger.status !== "cancelled" &&
        current.turnLedger.status !== "failed"
      )
        throw new Error("turn_busy");
      if (current.draft.revision !== input.expectedDraftRevision) throw new Error("chat_draft_revision_conflict");

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
      insertMessage(db, input.chatThreadId, validateMessage({ messageId, role: "player", kind: "player", text: input.text, occurredAtMs: acceptedAtMs, greetingSource: null }));
      persistTurn(db, input.chatThreadId, result);
      db.prepare("INSERT INTO tavern_chat_submit_idempotency (thread_id, idempotency_key, fingerprint, turn_id) VALUES (?, ?, ?, ?)").run(
        input.chatThreadId, input.idempotencyKey, fingerprint, turnId,
      );
      db.prepare("UPDATE tavern_threads SET updated_at_ms = ?, opening_locked_at_event_id = ? WHERE thread_id = ?").run(
        acceptedAtMs, lockedAt, input.chatThreadId,
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

  async function claimMountedAttempt(input: MountedAttemptClaimInput): Promise<AttemptStartingTurn> {
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

      persistTurn(db, input.chatThreadId, claimed);
      db.prepare("UPDATE tavern_threads SET updated_at_ms = ? WHERE thread_id = ?").run(claimedAtMs, input.chatThreadId);

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
    input: MountedProviderStartInput,
    command: ProviderStartTransition,
  ): Promise<AttemptStartingTurn | RunningTurn | FailedTurn | CancelledTurn> {
    validateProviderStartInput(input);
    return withDb((db) => {
      assertMountedTurnTransitionAuthority(input.authority);
      assertMountedTurnTransitionOperationAuthority(input.operationAuthority);
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

      persistTurn(db, input.chatThreadId, nextLedger);
      db.prepare("UPDATE tavern_threads SET updated_at_ms = ? WHERE thread_id = ?").run(observedAtMs, input.chatThreadId);

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
    input: MountedPresentationInput,
    command: PresentationTransition,
  ): Promise<ChatTurnLedger> {
    validatePresentationInput(input);
    return withDb((db) => {
      assertMountedTurnTransitionAuthority(input.authority);
      assertMountedTurnTransitionOperationAuthority(input.operationAuthority);
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
      assertExactPresentationAttempt(ledger.attempt, input);
      const atMs = timestampFor(command);
      if (atMs < thread.updatedAtMs) throw new Error("p5_presentation_time_regression");

      const messages = current.messages;
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

          insertMessage(db, input.chatThreadId, validateMessage({ messageId: command.message.messageId, role: "companion", kind: "response", text: command.message.text, occurredAtMs: command.message.occurredAtMs, greetingSource: null }));
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

      persistTurn(db, input.chatThreadId, nextLedger);
      db.prepare("UPDATE tavern_threads SET updated_at_ms = ? WHERE thread_id = ?").run(atMs, input.chatThreadId);

      const readBack = readStateFromDb(db, input.chatThreadId);
      assertP5ReadBack(readBack.turnLedger, command, input);
      if (readBack.turnLedger === null) throw new Error("chat_p5_readback_mismatch");
      return readBack.turnLedger;
    });
  }
}

function greetingSourceFromRow(row: any): GreetingSource | null {
  if (row.greeting_set_id === null || row.greeting_set_id === undefined) return null;
  return freezeGreetingSource({
    greetingSetId: row.greeting_set_id, sourceRevision: row.greeting_source_revision,
    canonicalHash: row.greeting_canonical_hash, variantId: row.greeting_variant_id,
    profileRevision: row.greeting_profile_revision, scenarioRevision: row.greeting_scenario_revision,
  });
}

function rowToThread(db: DatabaseSync, row: any): ChatThread {
  const greeting = greetingSourceFromRow(row);
  const openingSelection: OpeningSelection = row.opening_kind === "blank"
    ? Object.freeze({ kind: "blank" })
    : validateOpeningSelection({ kind: "greeting", messageId: row.opening_message_id, source: greeting });
  const stableArtifactBindings = freezeStableArtifactBindings((db.prepare(
    "SELECT kind, source_id, revision, canonical_hash FROM tavern_thread_stable_artifact_bindings WHERE thread_id = ? ORDER BY kind",
  ).all(row.thread_id) as any[]).map((binding) => ({
    kind: binding.kind, sourceId: binding.source_id, revision: binding.revision, canonicalHash: binding.canonical_hash,
  })));
  const world = db.prepare("SELECT * FROM tavern_thread_world_info_bindings WHERE thread_id = ?").get(row.thread_id) as any;
  const worldBookBinding: TavernStableWorldInfoBinding | undefined = !world ? undefined : world.source === "managed_world_info"
    ? freezeStableWorldBookBinding({ source: "managed_world_info", publicTitle: world.public_title, revision: world.revision, canonicalHash: world.canonical_hash })
    : freezeStableWorldBookBinding({ worldBookId: world.world_book_id, revision: world.revision, canonicalHash: world.canonical_hash, provenance: world.provenance });
  return freezeThread({
    schemaVersion: CHAT_THREAD_SCHEMA_VERSION, chatThreadId: row.thread_id, companionId: row.companion_id,
    continuityId: row.continuity_id, ...(row.persona_id ? { personaId: row.persona_id } : {}),
    ...(row.scenario_id ? { scenarioId: row.scenario_id } : {}), stableArtifactBindings,
    ...(worldBookBinding ? { worldBookBinding } : {}), chatSurfaceSessionId: row.chat_surface_session_id,
    createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, openingSelection,
    title: validateStoredThreadTitle(row.title), lifecycleStatus: validateLifecycleStatus(row.lifecycle_status),
    managementRevision: validateManagementRevision(row.management_revision),
    ...(row.trash_restore_status ? { trashRestoreStatus: validateTrashRestoreStatus(row.trash_restore_status) } : {}),
    openingLockedAtEventId: row.opening_locked_at_event_id ?? null,
  });
}

function readMessages(db: DatabaseSync, threadId: string): ChatThreadMessage[] {
  const swipeRows = db.prepare("SELECT message_id, swipe_index, text FROM tavern_message_swipes WHERE thread_id = ? ORDER BY message_id, swipe_index").all(threadId) as any[];
  const swipes = new Map<string, string[]>();
  for (const swipe of swipeRows) {
    const values = swipes.get(swipe.message_id) ?? [];
    if (swipe.swipe_index !== values.length) throw new Error("invalid_chat_thread_swipe_order");
    values.push(swipe.text);
    swipes.set(swipe.message_id, values);
  }
  return (db.prepare("SELECT * FROM tavern_messages WHERE thread_id = ? ORDER BY append_ordinal").all(threadId) as any[]).map((row) => {
    const swipeValues = swipes.get(row.message_id);
    if (row.role === "companion") {
      if (swipeValues === undefined) throw new Error("invalid_chat_thread_swipe_order");
      return validateMessage({
        messageId: row.message_id,
        role: row.role,
        kind: row.kind,
        text: row.text,
        occurredAtMs: row.occurred_at_ms,
        greetingSource: greetingSourceFromRow(row),
        ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
        swipes: swipeValues,
        activeSwipeIndex: row.active_swipe_index,
      });
    }
    if (swipeValues !== undefined || row.active_swipe_index !== 0) throw new Error("invalid_chat_thread_swipe_order");
    return validateMessage({
      messageId: row.message_id,
      role: row.role,
      kind: row.kind,
      text: row.text,
      occurredAtMs: row.occurred_at_ms,
      greetingSource: greetingSourceFromRow(row),
      ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    });
  });
}

function insertMessage(db: DatabaseSync, threadId: string, message: ChatThreadMessage): void {
  const ordinalRow = db.prepare("SELECT COALESCE(MAX(append_ordinal), -1) AS ordinal FROM tavern_messages WHERE thread_id = ?").get(threadId) as any;
  const source = message.greetingSource;
  db.prepare(`INSERT INTO tavern_messages (thread_id, message_id, append_ordinal, role, kind, text, occurred_at_ms, parent_id, active_swipe_index, greeting_set_id, greeting_source_revision, greeting_canonical_hash, greeting_variant_id, greeting_profile_revision, greeting_scenario_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    threadId, message.messageId, ordinalRow.ordinal + 1, message.role, message.kind, message.text, message.occurredAtMs,
    message.parentId ?? null, message.activeSwipeIndex ?? 0, source?.greetingSetId ?? null, source?.sourceRevision ?? null,
    source?.canonicalHash ?? null, source?.variantId ?? null, source?.profileRevision ?? null, source?.scenarioRevision ?? null,
  );
  if (message.role === "companion") {
    for (const [index, text] of (message.swipes ?? [message.text]).entries())
      db.prepare("INSERT INTO tavern_message_swipes (thread_id, message_id, swipe_index, text) VALUES (?, ?, ?, ?)").run(
        threadId,
        message.messageId,
        index,
        text,
      );
  }
}

function replaceOpeningMessage(db: DatabaseSync, threadId: string, message: ChatThreadMessage | null): void {
  db.prepare("DELETE FROM tavern_messages WHERE thread_id = ? AND kind = 'opening'").run(threadId);
  if (message) insertMessage(db, threadId, message);
}

function writeWorldInfoBinding(db: DatabaseSync, threadId: string, binding: TavernStableWorldInfoBinding | undefined): void {
  db.prepare("DELETE FROM tavern_thread_world_info_bindings WHERE thread_id = ?").run(threadId);
  if (!binding) return;
  if ("source" in binding) db.prepare("INSERT INTO tavern_thread_world_info_bindings (thread_id, source, public_title, revision, canonical_hash) VALUES (?, 'managed_world_info', ?, ?, ?)").run(threadId, binding.publicTitle, binding.revision, binding.canonicalHash);
  else db.prepare("INSERT INTO tavern_thread_world_info_bindings (thread_id, source, world_book_id, revision, canonical_hash, provenance) VALUES (?, 'world_book', ?, ?, ?, ?)").run(threadId, binding.worldBookId, binding.revision, binding.canonicalHash, binding.provenance);
}

function persistTurn(db: DatabaseSync, threadId: string, ledger: ChatTurnLedger): void {
  db.prepare("UPDATE tavern_turns SET is_current = 0 WHERE thread_id = ? AND turn_id <> ?").run(threadId, ledger.turnId);
  db.prepare(`INSERT INTO tavern_turns (turn_id, thread_id, status, idempotency_key, message_id, accepted_at_ms, is_current) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(turn_id) DO UPDATE SET status = excluded.status, is_current = 1`).run(ledger.turnId, threadId, ledger.status, ledger.idempotencyKey, ledger.messageId, ledger.acceptedAtMs);
  if (!isTurnWithAttempt(ledger)) return;
  db.prepare("DELETE FROM tavern_turn_attempts WHERE turn_id = ?").run(ledger.turnId);
  const attempt = ledger.attempt;
  db.prepare("INSERT INTO tavern_turn_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(ledger.turnId, attempt.generation, attempt.attemptId, attempt.claimedAtMs, attempt.selectionGeneration, attempt.runtimeBindingDigest, attempt.runtimeOwner.ownerToken, attempt.runtimeOwner.runtimeInstanceId, attempt.runtimeOwner.ownerPid, attempt.runtimeOwner.ownerProcessStartIdentity);
  db.prepare("DELETE FROM tavern_turn_observations WHERE turn_id = ?").run(ledger.turnId);
  db.prepare("DELETE FROM tavern_turn_presentations WHERE turn_id = ?").run(ledger.turnId);
  db.prepare("DELETE FROM tavern_turn_terminalizations WHERE turn_id = ?").run(ledger.turnId);
  if (ledger.observation) db.prepare("INSERT INTO tavern_turn_observations VALUES (?, ?, ?, ?, ?, ?)").run(ledger.turnId, ledger.observation.phase, "reasonCode" in ledger.observation ? ledger.observation.reasonCode : null, "source" in ledger.observation ? ledger.observation.source : null, "statusClass" in ledger.observation ? ledger.observation.statusClass : null, ledger.observation.observedAtMs);
  const presentation = presentationOf(ledger);
  if (presentation) db.prepare("INSERT INTO tavern_turn_presentations VALUES (?, ?, ?, ?, ?)").run(ledger.turnId, presentation.expressionId, presentation.messageId, presentation.cancelEpoch, presentation.committedAtMs);
  db.prepare("INSERT INTO tavern_turn_terminalizations VALUES (?, ?, ?, ?, ?, ?, ?)").run(ledger.turnId, ledger.status === "completion_claimed" || ledger.status === "completed" ? ledger.completionClaimedAtMs : null, ledger.status === "completed" ? ledger.completedAtMs : null, ledger.status === "cancel_claimed" || ledger.status === "cancelled" ? ledger.cancelClaimedAtMs : null, ledger.status === "cancelled" ? ledger.cancelledAtMs : null, ledger.status === "failed" ? ledger.failedAtMs : null, ledger.status === "failed" ? ledger.reasonCode : null);
}

function readTurnLedger(db: DatabaseSync, row: any): ChatTurnLedger {
  const base = {
    turnId: row.turn_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    messageId: row.message_id,
    acceptedAtMs: row.accepted_at_ms,
  };
  if (row.status === "accepted_queued") return validateTurnLedger(base);

  const attempt = db.prepare("SELECT * FROM tavern_turn_attempts WHERE turn_id = ?").get(row.turn_id) as any;
  const observation = db.prepare("SELECT * FROM tavern_turn_observations WHERE turn_id = ?").get(row.turn_id) as any;
  const presentation = db.prepare("SELECT * FROM tavern_turn_presentations WHERE turn_id = ?").get(row.turn_id) as any;
  const terminal = db.prepare("SELECT * FROM tavern_turn_terminalizations WHERE turn_id = ?").get(row.turn_id) as any;
  if (!attempt || !terminal || (row.status !== "attempt_starting" && !observation))
    throw new Error("invalid_chat_thread_turn_ledger");

  const attemptValue = {
    generation: attempt.generation,
    attemptId: attempt.attempt_id,
    claimedAtMs: attempt.claimed_at_ms,
    selectionGeneration: attempt.selection_generation,
    runtimeBindingDigest: attempt.runtime_binding_digest,
    runtimeOwner: {
      ownerToken: attempt.owner_token,
      runtimeInstanceId: attempt.runtime_instance_id,
      ownerPid: attempt.owner_pid,
      ownerProcessStartIdentity: attempt.owner_process_start_identity,
    },
  };
  const observationValue = observation
    ? {
        phase: observation.phase,
        ...(observation.reason_code ? { reasonCode: observation.reason_code } : {}),
        ...(observation.source ? { source: observation.source } : {}),
        ...(observation.status_class ? { statusClass: observation.status_class } : {}),
        observedAtMs: observation.observed_at_ms,
      }
    : undefined;
  const presentationValue = presentation
    ? {
        expressionId: presentation.expression_id,
        messageId: presentation.message_id,
        cancelEpoch: presentation.cancel_epoch,
        committedAtMs: presentation.committed_at_ms,
      }
    : null;

  return validateTurnLedger({
    ...base,
    attempt: attemptValue,
    ...(observationValue === undefined ? {} : { observation: observationValue }),
    ...(row.status === "presentation_committed" ? { presentation: presentationValue } : {}),
    ...(row.status === "completion_claimed"
      ? { presentation: presentationValue, completionClaimedAtMs: terminal.completion_claimed_at_ms }
      : {}),
    ...(row.status === "completed"
      ? {
          presentation: presentationValue,
          completionClaimedAtMs: terminal.completion_claimed_at_ms,
          completedAtMs: terminal.completed_at_ms,
        }
      : {}),
    ...(row.status === "cancel_claimed"
      ? { presentation: presentationValue, cancelClaimedAtMs: terminal.cancel_claimed_at_ms }
      : {}),
    ...(row.status === "cancelled"
      ? {
          presentation: presentationValue,
          cancelClaimedAtMs: terminal.cancel_claimed_at_ms,
          cancelledAtMs: terminal.cancelled_at_ms,
        }
      : {}),
    ...(row.status === "failed"
      ? { presentation: presentationValue, reasonCode: terminal.reason_code, failedAtMs: terminal.failed_at_ms }
      : {}),
  });
}

function readStateFromDb(db: DatabaseSync, chatThreadId: string): ChatThreadState {
  assertId("chatThreadId", chatThreadId);
  const threadRow = db.prepare("SELECT * FROM tavern_threads WHERE thread_id = ?").get(chatThreadId) as any;
  if (!threadRow) throw new ExactThreadNotFoundError();
  const thread = rowToThread(db, threadRow);
  const messages = readMessages(db, chatThreadId);
  const draftRow = db.prepare("SELECT * FROM tavern_drafts WHERE thread_id = ?").get(chatThreadId) as any;
  const draft = draftRow ? validateDraft({ revision: draftRow.revision, text: draftRow.draft_content ?? null }) : validateDraft({ revision: 0, text: null });
  const turnRow = db.prepare("SELECT * FROM tavern_turns WHERE thread_id = ? AND is_current = 1").get(chatThreadId) as any;
  const turnLedger = turnRow ? readTurnLedger(db, turnRow) : null;
  const idempotency = (db.prepare(
    "SELECT i.idempotency_key, i.fingerprint, t.turn_id, t.idempotency_key AS turn_idempotency_key, t.message_id, t.accepted_at_ms FROM tavern_chat_submit_idempotency i JOIN tavern_turns t ON t.turn_id = i.turn_id WHERE i.thread_id = ? ORDER BY i.idempotency_key",
  ).all(chatThreadId) as any[]).map((entry) =>
    validateIdempotency({
      key: entry.idempotency_key,
      fingerprint: entry.fingerprint,
      result: {
        turnId: entry.turn_id,
        status: "accepted_queued",
        idempotencyKey: entry.turn_idempotency_key,
        messageId: entry.message_id,
        acceptedAtMs: entry.accepted_at_ms,
      },
    }),
  );
  validateOpeningConsistency(thread, messages);
  validateTurnIntegrity(messages, turnLedger, idempotency);
  return freezeState({ thread, messages, draft, turnLedger, idempotency });
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
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "messageId",
      "role",
      "kind",
      "text",
      "occurredAtMs",
      "greetingSource",
      "parentId",
      "swipes",
      "activeSwipeIndex",
    ])
  )
    throw new Error("invalid_chat_thread_message");
  const messageId = value.messageId;
  const role = value.role;
  const kind = value.kind;
  const text = value.text;
  const occurredAtMs = value.occurredAtMs;
  const greetingSourceValue = value.greetingSource;
  const parentId = typeof value.parentId === "string" ? value.parentId : value.parentId === null ? null : undefined;
  const swipes =
    Array.isArray(value.swipes) && value.swipes.every(isText)
      ? Object.freeze([...value.swipes])
      : undefined;
  const activeSwipeIndex =
    typeof value.activeSwipeIndex === "number" &&
    Number.isSafeInteger(value.activeSwipeIndex) &&
    value.activeSwipeIndex >= 0
      ? value.activeSwipeIndex
      : undefined;

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
  if (swipes !== undefined && (swipes.length === 0 || activeSwipeIndex === undefined || activeSwipeIndex >= swipes.length))
    throw new Error("invalid_chat_thread_message");
  if (kind === "player" && (swipes !== undefined || activeSwipeIndex !== undefined || parentId !== undefined))
    throw new Error("invalid_chat_thread_message");
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
    ...(parentId !== undefined ? { parentId } : {}),
    ...(swipes !== undefined ? { swipes } : {}),
    ...(activeSwipeIndex !== undefined ? { activeSwipeIndex } : {}),
  });
}

function validateOpeningConsistency(thread: ChatThread, messages: readonly ChatThreadMessage[]): void {
  if (messages.some((message) => message.parentId !== undefined && message.parentId !== null && !messages.some((parent) => parent.messageId === message.parentId)))
    throw new Error("invalid_chat_thread_parent_message");
  if (messages.some((message, index) => message.kind === "opening" && index !== 0))
    throw new Error("invalid_chat_thread_opening_consistency");
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

function validateAcceptanceInput(value: MountedAcceptanceInput): void {
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

function validateAttemptClaimInput(value: MountedAttemptClaimInput): void {
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

function validateProviderStartInput(value: MountedProviderStartInput): void {
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

function validatePresentationInput(value: MountedPresentationInput): void {
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

function timestampFor(command: PresentationTransition): number {
  if (command.operation === "commit_presentation") return command.committedAtMs;
  if (command.operation === "claim_completion") return command.claimedAtMs;
  if (command.operation === "complete") return command.completedAtMs;
  if (command.operation === "claim_cancel") return command.claimedAtMs;
  if (command.operation === "cancel") return command.cancelledAtMs;
  return command.failedAtMs;
}

function assertExactPresentationAttempt(attempt: AttemptClaimV1, input: MountedPresentationInput): void {
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

function validatePresentationTransition(value: PresentationTransition): PresentationTransition {
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
  command: PresentationTransition,
  input: MountedPresentationInput,
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

function validateProviderStartTransition(value: ProviderStartTransition): ProviderStartTransition {
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

function assertExactProviderStartAttempt(attempt: AttemptClaimV1, input: MountedProviderStartInput): void {
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
  command: ProviderStartTransition,
  input: MountedProviderStartInput,
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

function acceptanceFingerprint(input: MountedAcceptanceInput): string {
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
    ...(message.swipes === undefined ? {} : { swipes: Object.freeze([...message.swipes]) }),
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
