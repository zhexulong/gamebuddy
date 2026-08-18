import { createHash, randomUUID } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertP4P5MountedTransitionAuthority,
  assertP4P5MountedTransitionOperationAuthority,
  type P4P5MountedTransitionAuthority,
  type P4P5MountedTransitionOperationAuthority,
} from "./chat-thread-store.p4-p5-transition-authority.internal.js";
import { readStrictJsonFile, STRICT_JSON_READER_DEFAULT_BUDGET_BYTES } from "../strict-json-reader.js";
import {
  atomicWriteFile,
  captureSafeFileIdentity,
  withPathLock as lockedPath,
  readSafeDirectory,
  removeOwnedSafeFile,
  verifySafePathBoundary,
} from "../path-lock.js";

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
 * UTF-8 bytes including JSON escaping and bounded metadata. The prepared
 * transaction budget is also the enforced maximum for the state response
 * envelope: the frozen complete-snapshot projection must either fit entirely
 * or fail closed; it never silently truncates.
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
export type CancelledTurn = Omit<CancelClaimedTurn, "status"> &
  Readonly<{ status: "cancelled"; cancelledAtMs: number }>;
export type FailedTurn = Omit<RunningTurn, "status"> &
  Readonly<{
    status: "failed";
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
}>;

type StoredMessages = Readonly<{
  schemaVersion: typeof CHAT_THREAD_SCHEMA_VERSION;
  chatThreadId: string;
  messages: readonly ChatThreadMessage[];
}>;
type StoredDraft = Readonly<{ schemaVersion: typeof CHAT_THREAD_SCHEMA_VERSION; revision: number; text: string | null }>;
type StoredTurnLedger = Readonly<{ schemaVersion: typeof CHAT_THREAD_SCHEMA_VERSION; turnLedger: ChatTurnLedger | null }>;
type IdempotencyRecord = Readonly<{ key: string; fingerprint: string; result: AcceptedQueuedTurn }>;
type StoredIdempotency = Readonly<{ schemaVersion: typeof CHAT_THREAD_SCHEMA_VERSION; idempotency: readonly IdempotencyRecord[] }>;
type PreparedTransaction = Readonly<{
  schemaVersion: typeof CHAT_THREAD_SCHEMA_VERSION;
  state: ChatThreadState;
}>;

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
const p4AttemptClaimByStore = new WeakMap<object, (input: MountedP4AttemptClaimInput) => Promise<AttemptStartingTurn>>();

/** P4c's three frozen store transitions: arm, local pre-invocation not_started, running. */
export type P4ProviderStartTransition =
  | Readonly<{ operation: "arm"; observedAtMs: number }>
  | Readonly<{
      operation: "not_started";
      reasonCode: "admission_revoked" | "session_unavailable" | "invocation_deadline_expired";
      observedAtMs: number;
    }>
  | Readonly<{ operation: "running"; statusClass: "success" | "error"; observedAtMs: number }>;

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
  ) => Promise<AttemptStartingTurn | RunningTurn>
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
  return accept(Object.freeze({ ...binding, ...command }));
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
  return claim(Object.freeze({ ...binding }));
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
): Promise<AttemptStartingTurn | RunningTurn> {
  assertP4P5MountedTransitionAuthority(binding.authority);
  assertP4P5MountedTransitionOperationAuthority(binding.operationAuthority);
  const store = createChatThreadStore(
    binding.runtimeRoot,
    identityKeyForP4(binding.playerId, binding.companionId, binding.continuityId),
  );
  const transition = p4ProviderStartByStore.get(store);
  if (transition === undefined) throw new Error("p4_provider_start_port_unavailable");
  return transition(Object.freeze({ ...binding }), validateProviderStartTransition(command));
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
  return transition(asMountedP5PresentationInput(binding), validatePresentationTransition(command));
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

const initialExactContentCapabilityByStore = new WeakMap<object, InitialChatExactContentCapability>();
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
  const threadRoot = join(continuityRoot, "threads");
  const activeSelectionPath = join(continuityRoot, "active-chat-thread.json");
  const containmentRoot = join(root, "tavern", "v1");
  const withPathLock = <T>(path: string, work: () => Promise<T>): Promise<T> =>
    lockedPath(path, work, { containmentRoot });

  const pathsFor = (chatThreadId: string) => {
    assertId("chatThreadId", chatThreadId);
    const directory = join(threadRoot, chatThreadId);
    return Object.freeze({
      directory,
      thread: join(directory, "thread.json"),
      messages: join(directory, "messages.json"),
      draft: join(directory, "draft.json"),
      turnLedger: join(directory, "turn-ledger.json"),
      idempotency: join(directory, "idempotency.json"),
      journal: join(directory, "transaction.json"),
    });
  };

  const mutate = async (
    chatThreadId: string,
    change: (current: ChatThreadState) => ChatThreadState,
  ): Promise<ChatThreadState> => {
    const paths = pathsFor(chatThreadId);
    return withPathLock(paths.thread, async () => {
      const current = await readState(paths, containmentRoot);
      const next = freezeState(change(current));
      await commitState(paths, next, containmentRoot);
      return next;
    });
  };

  const store: ChatThreadStore = Object.freeze({
    async createThread(request): Promise<ChatThreadState> {
      validateCreate(request);
      const paths = pathsFor(request.chatThreadId);
      return withPathLock(paths.thread, async () => {
        if (
          (await exists(paths.thread, containmentRoot)) ||
          (await exists(paths.messages, containmentRoot)) ||
          (await exists(paths.draft, containmentRoot)) ||
          (await exists(paths.turnLedger, containmentRoot)) ||
          (await exists(paths.idempotency, containmentRoot)) ||
          (await exists(paths.journal, containmentRoot))
        )
          throw new ExactThreadAlreadyExistsError();
        const timestamp = now();
        const opening = normalizeOpening(request.opening);
        const messages =
          opening === "blank"
            ? []
            : [
                freezeMessage({
                  messageId: opening.messageId,
                  role: "companion",
                  kind: "opening",
                  text: opening.text,
                  occurredAtMs: timestamp,
                  greetingSource: opening.source,
                }),
              ];
        const thread = freezeThread({
          schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
          chatThreadId: request.chatThreadId,
          companionId: request.companionId,
          continuityId: request.continuityId,
          ...(request.personaId === undefined ? {} : { personaId: request.personaId }),
          ...(request.scenarioId === undefined ? {} : { scenarioId: request.scenarioId }),
          stableArtifactBindings: freezeStableArtifactBindings(request.stableArtifactBindings ?? []),
          ...(request.worldBookBinding === undefined
            ? {}
            : {
                worldBookBinding: freezeStableWorldBookBinding(request.worldBookBinding),
              }),
          chatSurfaceSessionId: request.chatSurfaceSessionId,
          createdAtMs: timestamp,
          updatedAtMs: timestamp,
          openingSelection:
            opening === "blank"
              ? Object.freeze({ kind: "blank" as const })
              : Object.freeze({
                  kind: "greeting" as const,
                  messageId: opening.messageId,
                  source: opening.source,
                }),
          title: null,
          lifecycleStatus: "active",
          managementRevision: 1,
          openingLockedAtEventId: null,
        });
        const state = freezeState({ thread, messages, draft: freezeDraft({ revision: 0, text: null }), turnLedger: null, idempotency: [] });
        await commitState(paths, state, containmentRoot);
        return state;
      });
    },

    async listThreads(): Promise<readonly ChatThread[]> {
      let entries: readonly string[];
      try {
        entries = await readSafeDirectory(threadRoot, join(root, "tavern", "v1"));
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return Object.freeze([]);
        throw error;
      }
      const threads = await Promise.all(
        [...entries].sort().map(async (chatThreadId) => {
          if (!isId(chatThreadId)) throw new Error("invalid_chat_thread_directory");
          const paths = pathsFor(chatThreadId);
          return withPathLock(paths.thread, async () => (await readState(paths, containmentRoot)).thread);
        }),
      );
      return Object.freeze(threads);
    },

    async readActiveThreadSelection(): Promise<ActiveChatThreadSelection | null> {
      return withPathLock(activeSelectionPath, async () => {
        try {
          return validateActiveSelection(await safeReadJson(activeSelectionPath, containmentRoot));
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") return null;
          throw error;
        }
      });
    },

    async readActiveThreadBinding(): Promise<ChatThreadState | null> {
      const first = await readSelection();
      if (first === null) return null;
      const state = await resumeExact(first.chatThreadId, first.chatSurfaceSessionId);
      const final = await readSelection();
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
      const paths = pathsFor(chatThreadId);
      // Read the exact durable mapping before publishing it. Lock ordering is
      // thread then selector everywhere this operation needs both resources.
      return withPathLock(paths.thread, async () => {
        const state = await readState(paths, containmentRoot);
        if (state.thread.chatSurfaceSessionId !== chatSurfaceSessionId) throw new Error("chat_thread_surface_mismatch");
        return withPathLock(activeSelectionPath, async () => {
          const selection = freezeActiveSelection({
            schemaVersion: CHAT_THREAD_SELECTION_SCHEMA_VERSION,
            chatThreadId,
            chatSurfaceSessionId,
            selectedAtMs: now(),
          });
          await atomicWriteFile(activeSelectionPath, JSON.stringify(selection, null, 2), containmentRoot);
          // Read back and validate so callers never claim durable selection
          // based solely on a successful write.
          return validateActiveSelection(await safeReadJson(activeSelectionPath, containmentRoot));
        });
      });
    },

    async resumeThread(chatThreadId, chatSurfaceSessionId): Promise<ChatThreadState> {
      assertId("chatSurfaceSessionId", chatSurfaceSessionId);
      const paths = pathsFor(chatThreadId);
      return withPathLock(paths.thread, async () => {
        const state = await readState(paths, containmentRoot);
        if (state.thread.chatSurfaceSessionId !== chatSurfaceSessionId) throw new Error("chat_thread_surface_mismatch");
        return state;
      });
    },

    async commitOpening(chatThreadId, requestedOpening): Promise<ChatThreadState> {
      const opening = normalizeOpening(requestedOpening);
      return mutate(chatThreadId, (current) => {
        if (
          current.thread.openingLockedAtEventId !== null ||
          current.messages.some((message) => message.kind !== "opening")
        )
          throw new Error("chat_thread_opening_locked");
        const messages =
          opening === "blank"
            ? []
            : [
                freezeMessage({
                  messageId: opening.messageId,
                  role: "companion",
                  kind: "opening",
                  text: opening.text,
                  occurredAtMs: now(),
                  greetingSource: opening.source,
                }),
              ];
        return {
          thread: freezeThread({
            ...current.thread,
            updatedAtMs: now(),
            openingSelection:
              opening === "blank"
                ? Object.freeze({ kind: "blank" as const })
                : Object.freeze({
                    kind: "greeting" as const,
                    messageId: opening.messageId,
                    source: opening.source,
                  }),
          }),
          messages,
          draft: current.draft,
          turnLedger: current.turnLedger,
          idempotency: current.idempotency,
        };
      });
    },

    async appendPlayer(chatThreadId, message): Promise<ChatThreadState> {
      return appendNormal(chatThreadId, "player", message);
    },

    async commitResponse(chatThreadId, response): Promise<ChatThreadState> {
      // This method is the response publication boundary: callers must await
      // it before SSE/UI display. No in-memory-only response is returned.
      return appendNormal(chatThreadId, "response", response);
    },

    async setWorldBookBinding(input): Promise<ChatThreadState> {
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertId("companionId", input.companionId);
      assertId("continuityId", input.continuityId);
      assertTimestamp(input.expectedUpdatedAtMs);
      if (input.binding !== undefined) freezeStableWorldBookBinding(input.binding);
      return mutate(input.chatThreadId, (current) => {
        if (
          current.thread.chatSurfaceSessionId !== input.chatSurfaceSessionId ||
          current.thread.companionId !== input.companionId ||
          current.thread.continuityId !== input.continuityId
        )
          throw new Error("chat_thread_scope_mismatch");
        if (current.thread.updatedAtMs !== input.expectedUpdatedAtMs) throw new Error("chat_thread_revision_conflict");
        if (current.messages.length !== 0) throw new Error("chat_thread_worldbook_locked");
        return {
          thread: freezeThread({
            ...current.thread,
            ...(input.binding === undefined ? { worldBookBinding: undefined } : { worldBookBinding: input.binding }),
            updatedAtMs: now(),
          }),
          messages: current.messages,
          draft: current.draft,
          turnLedger: current.turnLedger,
          idempotency: current.idempotency,
        };
      });
    },

    async transitionLifecycle(input): Promise<ChatThread> {
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertId("companionId", input.companionId);
      assertId("continuityId", input.continuityId);
      assertManagementRevision(input.expectedManagementRevision);
      if (input.operation !== "archive" && input.operation !== "restore" && input.operation !== "trash")
        throw new Error("invalid_chat_thread_lifecycle_operation");
      const paths = pathsFor(input.chatThreadId);
      return withPathLock(paths.thread, async () => {
        const current = await readState(paths, containmentRoot);
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
        const next = freezeState({
          thread: freezeThread({
            ...thread,
            lifecycleStatus: transition.status,
            ...(transition.trashRestoreStatus === undefined
              ? { trashRestoreStatus: undefined }
              : { trashRestoreStatus: transition.trashRestoreStatus }),
            managementRevision: currentManagementRevision + 1,
          }),
          messages: current.messages,
          draft: current.draft,
          turnLedger: current.turnLedger,
          idempotency: current.idempotency,
        });
        await commitState(paths, next, containmentRoot);
        return (await readState(paths, containmentRoot)).thread;
      });
    },

    async renameThreadTitle(input): Promise<ChatThread> {
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertManagementRevision(input.expectedManagementRevision);
      const title = normalizeThreadTitle(input.title);
      const paths = pathsFor(input.chatThreadId);
      return withPathLock(paths.thread, async () => {
        const current = await readState(paths, containmentRoot);
        const managementRevision = current.thread.managementRevision ?? 1;
        if (current.thread.chatSurfaceSessionId !== input.chatSurfaceSessionId)
          throw new Error("chat_thread_surface_mismatch");
        if (managementRevision !== input.expectedManagementRevision)
          throw new Error("chat_thread_management_revision_conflict");
        if (current.thread.title === title) throw new Error("chat_thread_title_unchanged");
        const next = freezeState({
          thread: freezeThread({
            ...current.thread,
            title,
            managementRevision: managementRevision + 1,
          }),
          messages: current.messages,
          draft: current.draft,
          turnLedger: current.turnLedger,
          idempotency: current.idempotency,
        });
        await commitState(paths, next, containmentRoot);
        return (await readState(paths, containmentRoot)).thread;
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
  });

  async function mutateDraft(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      expectedDraftRevision: number;
    }>,
    text: string | null,
  ): Promise<ChatDraft> {
    const paths = pathsFor(input.chatThreadId);
    return withPathLock(paths.thread, async () => {
      const current = await readState(paths, containmentRoot);
      if (current.thread.chatSurfaceSessionId !== input.chatSurfaceSessionId)
        throw new Error("chat_thread_surface_mismatch");
      if ((current.thread.lifecycleStatus ?? "active") !== "active")
        throw new Error("chat_thread_lifecycle_not_active");
      if (current.draft.revision !== input.expectedDraftRevision)
        throw new Error("chat_draft_revision_conflict");
      const next = freezeState({
        thread: current.thread,
        messages: current.messages,
        draft: freezeDraft({ revision: current.draft.revision + 1, text }),
        turnLedger: current.turnLedger,
        idempotency: current.idempotency,
      });
      await commitState(paths, next, containmentRoot);
      return (await readState(paths, containmentRoot)).draft;
    });
  }

  function validateDraftMutation(input: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; expectedDraftRevision: number; text?: string }>): void {
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
      return resumeExact(chatThreadId, chatSurfaceSessionId);
    },
    async createExplicit(request): Promise<ChatThreadState> {
      await store.createThread(request);
      return resumeExact(request.chatThreadId, request.chatSurfaceSessionId);
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
    const paths = pathsFor(input.chatThreadId);
    return withPathLock(paths.thread, async () => {
      const current = await readState(paths, containmentRoot);
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
      if (current.turnLedger !== null) throw new Error("turn_busy");
      if (current.draft.revision !== input.expectedDraftRevision) throw new Error("chat_draft_revision_conflict");
      if (current.messages.length >= MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES)
        throw new Error("chat_thread_capacity_exceeded");
      const acceptedAtMs = now();
      const messageId = `player_${randomUUID().replace(/-/gu, "")}`;
      const result = freezeAcceptedTurn({ turnId: `turn_${randomUUID().replace(/-/gu, "")}`, status: "accepted_queued", idempotencyKey: input.idempotencyKey, messageId, acceptedAtMs });
      const next = freezeState({ thread: freezeThread({ ...thread, updatedAtMs: acceptedAtMs, openingLockedAtEventId: thread.openingLockedAtEventId ?? messageId }), messages: [...current.messages, freezeMessage({ messageId, role: "player", kind: "player", text: input.text, occurredAtMs: acceptedAtMs, greetingSource: null })], draft: freezeDraft({ revision: current.draft.revision + 1, text: null }), turnLedger: result, idempotency: [...current.idempotency, Object.freeze({ key: input.idempotencyKey, fingerprint, result })] });
      await commitState(paths, next, containmentRoot);
      const readBack = await readState(paths, containmentRoot);
      const durable = readBack.idempotency.find((record) => record.key === input.idempotencyKey);
      if (!durable || durable.fingerprint !== fingerprint) throw new Error("chat_turn_readback_mismatch");
      return durable.result;
    });
  }

  async function claimMountedAttempt(input: MountedP4AttemptClaimInput): Promise<AttemptStartingTurn> {
    validateAttemptClaimInput(input);
    const paths = pathsFor(input.chatThreadId);
    return withPathLock(paths.thread, async () => {
      const current = await readState(paths, containmentRoot);
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
      const next = freezeState({
        thread: freezeThread({ ...thread, updatedAtMs: claimedAtMs }),
        messages: current.messages,
        draft: current.draft,
        turnLedger: claimed,
        idempotency: current.idempotency,
      });
      await commitState(paths, next, containmentRoot);
      const readBack = await readState(paths, containmentRoot);
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
  ): Promise<AttemptStartingTurn | RunningTurn> {
    validateProviderStartInput(input);
    const paths = pathsFor(input.chatThreadId);
    return withPathLock(paths.thread, async () => {
      // A transition can queue behind another writer while either its mounted
      // lease or its callback-scoped operation is revoked. Recheck both at
      // the durable-write boundary.
      assertP4P5MountedTransitionAuthority(input.authority);
      assertP4P5MountedTransitionOperationAuthority(input.operationAuthority);
      const current = await readState(paths, containmentRoot);
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
      let nextLedger: AttemptStartingTurn | RunningTurn;
      if (command.operation === "arm") {
        // Frozen CAS: no observation or `armed` is the only arm source state.
        if (observation !== undefined && observation.phase !== "armed")
          throw new Error("provider_start_observation_conflict");
        nextLedger = freezeAttemptStartingTurn({
          ...ledger,
          observation: Object.freeze({ phase: "armed" as const, observedAtMs }),
        });
      } else if (command.operation === "not_started") {
        // `not_started` is only a surviving-process, pre-invocation local proof.
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
      } else {
        // `running` is reachable only from a durable `armed` record.
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
      }
      const next = freezeState({
        thread: freezeThread({ ...thread, updatedAtMs: observedAtMs }),
        messages: current.messages,
        draft: current.draft,
        turnLedger: nextLedger,
        idempotency: current.idempotency,
      });
      await commitState(paths, next, containmentRoot);
      const readBack = await readState(paths, containmentRoot);
      const readBackLedger = readBack.turnLedger;
      assertProviderStartReadBack(readBackLedger, command, input);
      if (readBackLedger === null || readBackLedger.status === "accepted_queued")
        throw new Error("chat_provider_start_readback_mismatch");
      if (readBackLedger.status !== "attempt_starting" && readBackLedger.status !== "running")
        throw new Error("chat_provider_start_readback_mismatch");
      return readBackLedger;
    });
  }

  async function transitionMountedPresentation(
    input: MountedP5PresentationInput,
    command: P5PresentationTransition,
  ): Promise<ChatTurnLedger> {
    validatePresentationInput(input);
    const paths = pathsFor(input.chatThreadId);
    return withPathLock(paths.thread, async () => {
      // A P5 transition can queue behind another writer after either its
      // lease or callback operation was revoked; do not carry pre-queue
      // authority across that boundary.
      assertP4P5MountedTransitionAuthority(input.authority);
      assertP4P5MountedTransitionOperationAuthority(input.operationAuthority);
      const current = await readState(paths, containmentRoot);
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
      let nextLedger: ChatTurnLedger;
      let nextMessages: readonly ChatThreadMessage[] = current.messages;
      switch (command.operation) {
        case "commit_presentation": {
          validateNormalMessage(command.message);
          const existing = current.messages.find((message) => message.messageId === command.message.messageId);
          if (existing !== undefined) {
            // A Pi transport retry must never double-commit. A retried callback
            // with the identical response message is an idempotent no-op only
            // when the ledger already carries the exact same presentation.
            if (
              existing.kind !== "response" ||
              existing.role !== "companion" ||
              existing.text !== command.message.text
            )
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
          // The running source check is deliberately below the idempotency
          // no-op: a retried callback after the durable commit read-back is
          // accepted as a durable no-op, never as a live running commit.
          if (ledger.status !== "running") throw new Error("p5_presentation_source_running_required");
          const presentation = freezePresentationCommit(Object.freeze({
            expressionId: command.message.messageId,
            messageId: command.message.messageId,
            cancelEpoch: command.cancelEpoch,
            committedAtMs: command.committedAtMs,
          }));
          nextLedger = freezePresentationCommittedTurn({
            ...ledger,
            status: "presentation_committed",
            presentation,
          });
          nextMessages = [
            ...nextMessages,
            freezeMessage({
              messageId: command.message.messageId,
              role: "companion",
              kind: "response",
              text: command.message.text,
              occurredAtMs: command.message.occurredAtMs,
              greetingSource: null,
            }),
          ];
          break;
        }
        case "claim_completion": {
          if (ledger.status !== "presentation_committed")
            throw new Error("p5_presentation_completion_source_required");
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
            // Idempotent repeat cancel: return the existing durable representation.
            return ledger;
          }
          if (ledger.status !== "running" && ledger.status !== "presentation_committed")
            throw new Error("p5_presentation_cancel_source_required");
          nextLedger = freezeCancelClaimedTurn({
            ...ledger,
            status: "cancel_claimed",
            presentation:
              ledger.status === "presentation_committed" ? ledger.presentation : null,
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
          // operation === "fail"
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
      const next = freezeState({
        thread: freezeThread({ ...thread, updatedAtMs: atMs }),
        messages: nextMessages,
        draft: current.draft,
        turnLedger: nextLedger,
        idempotency: current.idempotency,
      });
      await commitState(paths, next, containmentRoot);
      const readBack = await readState(paths, containmentRoot);
      assertP5ReadBack(readBack.turnLedger, command, input);
      if (readBack.turnLedger === null) throw new Error("chat_p5_readback_mismatch");
      return readBack.turnLedger;
    });
  }

  async function readSelection(): Promise<ActiveChatThreadSelection | null> {
    return withPathLock(activeSelectionPath, async () => {
      try {
        return validateActiveSelection(await safeReadJson(activeSelectionPath, containmentRoot));
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return null;
        throw error;
      }
    });
  }
  async function resumeExact(chatThreadId: string, chatSurfaceSessionId: string): Promise<ChatThreadState> {
    const paths = pathsFor(chatThreadId);
    return withPathLock(paths.thread, async () => {
      const state = await readState(paths, containmentRoot);
      if (state.thread.chatSurfaceSessionId !== chatSurfaceSessionId) throw new Error("chat_thread_surface_mismatch");
      return state;
    });
  }

  async function appendNormal(
    chatThreadId: string,
    kind: "player" | "response",
    input: Readonly<{ messageId: string; text: string; occurredAtMs: number }>,
  ): Promise<ChatThreadState> {
    validateNormalMessage(input);
    return mutate(chatThreadId, (current) => {
      const existing = current.messages.find((message) => message.messageId === input.messageId);
      if (existing !== undefined) {
        if (existing.kind !== kind || existing.text !== input.text) throw new Error("chat_thread_message_id_conflict");
        return current;
      }
      if (current.messages.length >= MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES)
        throw new Error("chat_thread_capacity_exceeded");
      const message = freezeMessage({
        messageId: input.messageId,
        role: kind === "player" ? "player" : "companion",
        kind,
        text: input.text,
        occurredAtMs: input.occurredAtMs,
        greetingSource: null,
      });
      const lockedAt = current.thread.openingLockedAtEventId ?? input.messageId;
      return {
        thread: freezeThread({
          ...current.thread,
          updatedAtMs: now(),
          openingLockedAtEventId: lockedAt,
        }),
        messages: [...current.messages, message],
        draft: current.draft,
        turnLedger: current.turnLedger,
        idempotency: current.idempotency,
      };
    });
  }
}

async function readState(
  paths: Readonly<{ thread: string; messages: string; draft: string; turnLedger: string; idempotency: string; journal: string }>, containmentRoot: string,
): Promise<ChatThreadState> {
  if (await exists(paths.journal, containmentRoot)) {
    const expectedChatThreadId = paths.thread.split(/[\\/]/u).at(-2);
    if (expectedChatThreadId === undefined) throw new Error("chat_thread_directory_mismatch");
    const prepared = validatePrepared(await safeReadJson(paths.journal, containmentRoot, MAX_TRANSACTION_ARTIFACT_BYTES), expectedChatThreadId);
    const journalIdentity = await captureSafeFileIdentity(paths.journal, containmentRoot);
    if (journalIdentity === undefined) throw new Error("chat_thread_journal_disappeared");
    await writeStateFiles(paths, prepared.state, containmentRoot);
    const recovered = await readArtifacts(paths, containmentRoot);
    await removeOwnedSafeFile(paths.journal, journalIdentity, containmentRoot);
    return recovered;
  }
  return readArtifacts(paths, containmentRoot);
}
async function readArtifacts(
  paths: Readonly<{ thread: string; messages: string; draft: string; turnLedger: string; idempotency: string }>, containmentRoot: string,
): Promise<ChatThreadState> {
  let rawThread: unknown;
  try { rawThread = await safeReadJson(paths.thread, containmentRoot); } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      if (!(await exists(paths.messages, containmentRoot)) && !(await exists(paths.draft, containmentRoot)) && !(await exists(paths.turnLedger, containmentRoot)) && !(await exists(paths.idempotency, containmentRoot))) throw new ExactThreadNotFoundError();
      throw new Error("chat_thread_incomplete_artifacts");
    }
    throw error;
  }
  const thread = validateThread(rawThread);
  const directoryId = paths.thread.split(/[\\/]/u).at(-2);
  if (directoryId !== thread.chatThreadId) throw new Error("chat_thread_directory_mismatch");
  try {
    const [messages, draft, ledger, idempotency] = await Promise.all([safeReadJson(paths.messages, containmentRoot, MAX_MESSAGES_ARTIFACT_BYTES), safeReadJson(paths.draft, containmentRoot, MAX_DRAFT_ARTIFACT_BYTES), safeReadJson(paths.turnLedger, containmentRoot, MAX_TURN_LEDGER_ARTIFACT_BYTES), safeReadJson(paths.idempotency, containmentRoot, MAX_IDEMPOTENCY_ARTIFACT_BYTES)]);
    if (!isRecord(ledger) || !onlyKeys(ledger, ["schemaVersion", "turnLedger"]) || ledger.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION) throw new Error("invalid_chat_thread_turn_ledger");
    if (!isRecord(idempotency) || !onlyKeys(idempotency, ["schemaVersion", "idempotency"]) || idempotency.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION || !Array.isArray(idempotency.idempotency)) throw new Error("invalid_chat_thread_idempotency");
    if (!isRecord(draft) || !onlyKeys(draft, ["schemaVersion", "revision", "text"]) || draft.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION) throw new Error("invalid_chat_thread_draft");
    return validateState({ thread, messages: validateMessages(messages, thread.chatThreadId).messages, draft: { revision: draft.revision, text: draft.text }, turnLedger: ledger.turnLedger, idempotency: idempotency.idempotency });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new Error("chat_thread_incomplete_artifacts");
    throw error;
  }
}
async function commitState(
  paths: Readonly<{ thread: string; messages: string; draft: string; turnLedger: string; idempotency: string; journal: string }>, state: ChatThreadState, containmentRoot: string,
): Promise<void> {
  const journalJson = JSON.stringify({ schemaVersion: CHAT_THREAD_SCHEMA_VERSION, state } satisfies PreparedTransaction, null, 2);
  assertArtifactBudget(paths.journal, MAX_TRANSACTION_ARTIFACT_BYTES, journalJson);
  await atomicWriteFile(paths.journal, journalJson, containmentRoot);
  const journalIdentity = await captureSafeFileIdentity(paths.journal, containmentRoot);
  if (journalIdentity === undefined) throw new Error("chat_thread_journal_disappeared");
  await writeStateFiles(paths, state, containmentRoot);
  await readArtifacts(paths, containmentRoot);
  await removeOwnedSafeFile(paths.journal, journalIdentity, containmentRoot);
}
async function writeStateFiles(
  paths: Readonly<{ thread: string; messages: string; draft: string; turnLedger: string; idempotency: string }>, state: ChatThreadState, containmentRoot: string,
): Promise<void> {
  // Every named artifact budget is enforced before any file is touched, so an
  // over-budget state can never leave a partially repaired artifact set.
  const artifacts = [
    [paths.messages, MAX_MESSAGES_ARTIFACT_BYTES, { schemaVersion: CHAT_THREAD_SCHEMA_VERSION, chatThreadId: state.thread.chatThreadId, messages: state.messages } satisfies StoredMessages],
    [paths.draft, MAX_DRAFT_ARTIFACT_BYTES, { schemaVersion: CHAT_THREAD_SCHEMA_VERSION, revision: state.draft.revision, text: state.draft.text } satisfies StoredDraft],
    [paths.turnLedger, MAX_TURN_LEDGER_ARTIFACT_BYTES, { schemaVersion: CHAT_THREAD_SCHEMA_VERSION, turnLedger: state.turnLedger } satisfies StoredTurnLedger],
    [paths.idempotency, MAX_IDEMPOTENCY_ARTIFACT_BYTES, { schemaVersion: CHAT_THREAD_SCHEMA_VERSION, idempotency: state.idempotency } satisfies StoredIdempotency],
    [paths.thread, MAX_THREAD_ARTIFACT_BYTES, state.thread],
  ] as const satisfies readonly (readonly [string, number, unknown])[];
  const encoded = artifacts.map(([path, budget, value]) => {
    const json = JSON.stringify(value, null, 2);
    assertArtifactBudget(path, budget, json);
    return [path, json] as const;
  });
  for (const [path, json] of encoded) await atomicWriteFile(path, json, containmentRoot);
}

function assertArtifactBudget(path: string, budgetBytes: number, json: string): void {
  if (Buffer.byteLength(json, "utf8") > budgetBytes) throw new Error("chat_thread_artifact_budget_exceeded");
}
async function safeReadFile(path: string, containmentRoot: string): Promise<string> {
  // The lock's boundary check is not a read capability. Reverify immediately
  // before every filesystem read so a replaced parent fails closed.
  await verifySafePathBoundary(path, containmentRoot);
  return fsReadFile(path, "utf8");
}
async function safeReadJson(path: string, containmentRoot: string, maxBytes: number = STRICT_JSON_READER_DEFAULT_BUDGET_BYTES): Promise<unknown> {
  // The strict reader owns stable-file, duplicate-key, UTF-8, reparse and
  // byte-budget rejection; preserve this store's containment boundary
  // immediately before each persisted read.
  await verifySafePathBoundary(path, containmentRoot);
  return readStrictJsonFile(path, maxBytes);
}
async function exists(path: string, containmentRoot: string): Promise<boolean> {
  try {
    await safeReadFile(path, containmentRoot);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
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
function validatePrepared(value: unknown, expectedChatThreadId: string): PreparedTransaction {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["schemaVersion", "state"]) ||
    value.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION
  )
    throw new Error("invalid_chat_thread_transaction");
  const state = validateState(value.state);
  // Prepared recovery is scoped to the exact directory selected before any
  // recovery write; an internally coherent foreign transaction must remain untouched.
  if (state.thread.chatThreadId !== expectedChatThreadId) throw new Error("chat_thread_directory_mismatch");
  return Object.freeze({ schemaVersion: CHAT_THREAD_SCHEMA_VERSION, state });
}
function validateState(value: unknown): ChatThreadState {
  if (!isRecord(value) || !onlyKeys(value, ["thread", "messages", "draft", "turnLedger", "idempotency"])) throw new Error("invalid_chat_thread_state");
  const thread = validateThread(value.thread);
  if (!Array.isArray(value.messages)) throw new Error("invalid_chat_thread_state");
  const messages = value.messages.map(validateMessage);
  if (messages.length > MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES) throw new Error("chat_thread_capacity_exceeded");
  const draft = validateDraft(value.draft);
  const turnLedger = value.turnLedger === null ? null : validateTurnLedger(value.turnLedger);
  if (!Array.isArray(value.idempotency)) throw new Error("invalid_chat_thread_state");
  const idempotency = value.idempotency.map(validateIdempotency);
  validateOpeningConsistency(thread, messages);
  validateTurnIntegrity(messages, turnLedger, idempotency);
  return freezeState({ thread, messages, draft, turnLedger, idempotency });
}
function validateThread(value: unknown): ChatThread {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "schemaVersion",
      "chatThreadId",
      "companionId",
      "continuityId",
      "personaId",
      "scenarioId",
      "stableArtifactBindings",
      "worldBookBinding",
      "chatSurfaceSessionId",
      "createdAtMs",
      "updatedAtMs",
      "openingSelection",
      "title",
      "lifecycleStatus",
      "managementRevision",
      "trashRestoreStatus",
      "openingLockedAtEventId",
    ]) ||
    value.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION
  )
    throw new Error("invalid_chat_thread");
  const chatThreadId = value.chatThreadId;
  const companionId = value.companionId;
  const continuityId = value.continuityId;
  const personaId = value.personaId;
  const scenarioId = value.scenarioId;
  const chatSurfaceSessionId = value.chatSurfaceSessionId;
  assertId("chatThreadId", chatThreadId);
  assertId("companionId", companionId);
  assertId("continuityId", continuityId);
  if (personaId !== undefined && !isId(personaId)) throw new Error("invalid_chat_thread");
  if (scenarioId !== undefined && !isId(scenarioId)) throw new Error("invalid_chat_thread");
  assertId("chatSurfaceSessionId", chatSurfaceSessionId);
  const stableArtifactBindings = freezeStableArtifactBindings(value.stableArtifactBindings);
  const worldBookBinding =
    value.worldBookBinding === undefined ? undefined : freezeStableWorldBookBinding(value.worldBookBinding);
  const createdAtMs = value.createdAtMs;
  const updatedAtMs = value.updatedAtMs;
  assertTimestamp(createdAtMs);
  assertTimestamp(updatedAtMs);
  if (updatedAtMs < createdAtMs) throw new Error("invalid_chat_thread");
  const title = validateStoredThreadTitle(value.title);
  const lifecycleStatus = validateLifecycleStatus(value.lifecycleStatus);
  const managementRevision = validateManagementRevision(value.managementRevision);
  const trashRestoreStatus =
    value.trashRestoreStatus === undefined ? undefined : validateTrashRestoreStatus(value.trashRestoreStatus);
  if (lifecycleStatus === "trashed" ? trashRestoreStatus === undefined : trashRestoreStatus !== undefined)
    throw new Error("invalid_chat_thread_trash_restore_status");
  const locked = value.openingLockedAtEventId;
  if (locked !== null) assertId("openingLockedAtEventId", locked);
  const opening = validateOpeningSelection(value.openingSelection);
  return freezeThread({
    schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
    chatThreadId,
    companionId,
    continuityId,
    ...(personaId === undefined ? {} : { personaId }),
    ...(scenarioId === undefined ? {} : { scenarioId }),
    stableArtifactBindings,
    ...(worldBookBinding === undefined ? {} : { worldBookBinding }),
    chatSurfaceSessionId,
    createdAtMs,
    updatedAtMs,
    openingSelection: opening,
    title,
    lifecycleStatus,
    managementRevision,
    ...(trashRestoreStatus === undefined ? {} : { trashRestoreStatus }),
    openingLockedAtEventId: locked,
  });
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
function validateMessages(value: unknown, chatThreadId: string): StoredMessages {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["schemaVersion", "chatThreadId", "messages"]) ||
    value.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION ||
    value.chatThreadId !== chatThreadId ||
    !Array.isArray(value.messages)
  )
    throw new Error("invalid_chat_thread_messages");
  const messages = Object.freeze(value.messages.map(validateMessage));
  if (messages.length > MAX_CHAT_THREAD_TRANSCRIPT_MESSAGES) throw new Error("chat_thread_capacity_exceeded");
  return Object.freeze({
    schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
    chatThreadId,
    messages,
  });
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
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || (value.text !== null && !isText(value.text))) throw new Error("invalid_chat_thread_draft");
  return Object.freeze({ revision: value.revision, text: value.text });
}
function validateAcceptedTurn(value: unknown): AcceptedQueuedTurn {
  if (!isRecord(value) || !onlyKeys(value, ["turnId", "status", "idempotencyKey", "messageId", "acceptedAtMs"]) || value.status !== "accepted_queued")
    throw new Error("invalid_chat_thread_turn_ledger");
  assertId("turnId", value.turnId); assertId("messageId", value.messageId); assertIdempotencyKey(value.idempotencyKey); assertTimestamp(value.acceptedAtMs);
  return Object.freeze({ turnId: value.turnId, status: "accepted_queued", idempotencyKey: value.idempotencyKey, messageId: value.messageId, acceptedAtMs: value.acceptedAtMs });
}
function freezeAcceptedTurn(value: AcceptedQueuedTurn): AcceptedQueuedTurn { return validateAcceptedTurn(value); }
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
      return freezePresentationCommittedTurn({ ...base, status: "presentation_committed", presentation: common.presentation! });
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
    if (value.status === "cancelled")
      return freezeCancelledTurn({
        ...base,
        status: "cancelled",
        presentation: common.presentation ?? null,
        cancelClaimedAtMs: common.cancelClaimedAtMs!,
        cancelledAtMs: common.cancelledAtMs!,
      });
    return freezeFailedTurn({
      ...base,
      status: "failed",
      presentation: common.presentation ?? null,
      reasonCode: common.reasonCode!,
      failedAtMs: common.failedAtMs!,
    });
  }
  throw new Error("invalid_chat_thread_turn_ledger");
}
function validateP5TerminalishCommon(value: Record<string, unknown>): Readonly<{
  observation: AttemptObservationV1 & { phase: "running" };
  presentation: PresentationCommitV1 | null;
  completionClaimedAtMs?: number;
  completedAtMs?: number;
  cancelClaimedAtMs?: number;
  cancelledAtMs?: number;
  failedAtMs?: number;
  reasonCode?: P5TerminalFailureReason;
}> {
  const status = value.status;
  const commonKeys = ["turnId", "status", "idempotencyKey", "messageId", "acceptedAtMs", "attempt", "observation", "presentation"];
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
  if (observation.phase !== "running") throw new Error("invalid_chat_thread_turn_ledger");
  const presentation = value.presentation === null ? null : validatePresentationCommit(value.presentation);
  if (status === "completion_claimed" || status === "completed") {
    if (presentation === null || !isTimestamp(value.completionClaimedAtMs))
      throw new Error("invalid_chat_thread_turn_ledger");
    if (status === "completed" && !isTimestamp(value.completedAtMs))
      throw new Error("invalid_chat_thread_turn_ledger");
  }
  if (status === "cancel_claimed" || status === "cancelled") {
    if (!isTimestamp(value.cancelClaimedAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
    if (status === "cancelled" && !isTimestamp(value.cancelledAtMs))
      throw new Error("invalid_chat_thread_turn_ledger");
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
  if (observation !== undefined && observation.phase === "running")
    throw new Error("invalid_chat_thread_turn_ledger");
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
  const base = freezeCancelClaimedTurn({ ...value, status: "cancel_claimed" });
  if (!isTimestamp(value.cancelledAtMs)) throw new Error("invalid_chat_thread_turn_ledger");
  return Object.freeze({ ...base, status: "cancelled", cancelledAtMs: value.cancelledAtMs });
}
function freezeFailedTurn(value: FailedTurn): FailedTurn {
  const base = freezeRunningTurn({ ...value, status: "running" });
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
    ...base,
    status: "failed",
    presentation: value.presentation === null ? null : validatePresentationCommit(value.presentation),
    reasonCode,
    failedAtMs: value.failedAtMs,
  });
}
function freezeAttemptClaim(value: AttemptClaimV1): AttemptClaimV1 {
  if (!isRecord(value) || !onlyKeys(value, ["generation", "attemptId", "claimedAtMs", "selectionGeneration", "runtimeBindingDigest", "runtimeOwner"]) || value.generation !== 1)
    throw new Error("invalid_chat_thread_attempt_claim");
  assertId("attemptId", value.attemptId); assertTimestamp(value.claimedAtMs);
  if (!isRevision(value.selectionGeneration) || !isHash(value.runtimeBindingDigest) || !isRecord(value.runtimeOwner) || !onlyKeys(value.runtimeOwner, ["ownerToken", "runtimeInstanceId", "ownerPid", "ownerProcessStartIdentity"]))
    throw new Error("invalid_chat_thread_attempt_claim");
  assertId("ownerToken", value.runtimeOwner.ownerToken); assertId("runtimeInstanceId", value.runtimeOwner.runtimeInstanceId); assertId("ownerProcessStartIdentity", value.runtimeOwner.ownerProcessStartIdentity);
  if (!Number.isSafeInteger(value.runtimeOwner.ownerPid) || value.runtimeOwner.ownerPid < 1) throw new Error("invalid_chat_thread_attempt_claim");
  return Object.freeze({ generation: 1, attemptId: value.attemptId, claimedAtMs: value.claimedAtMs, selectionGeneration: value.selectionGeneration, runtimeBindingDigest: value.runtimeBindingDigest, runtimeOwner: Object.freeze({ ...value.runtimeOwner }) });
}
function validateIdempotency(value: unknown): IdempotencyRecord {
  if (!isRecord(value) || !onlyKeys(value, ["key", "fingerprint", "result"]) || !isHash(value.fingerprint)) throw new Error("invalid_chat_thread_idempotency");
  assertIdempotencyKey(value.key);
  const result = validateAcceptedTurn(value.result);
  if (result.idempotencyKey !== value.key) throw new Error("invalid_chat_thread_idempotency");
  return Object.freeze({ key: value.key, fingerprint: value.fingerprint, result });
}
function validateAcceptanceInput(value: MountedP4AcceptanceInput): void {
  assertId("chatThreadId", value.chatThreadId); assertId("chatSurfaceSessionId", value.chatSurfaceSessionId); assertId("playerId", value.playerId); assertId("companionId", value.companionId); assertId("continuityId", value.continuityId);
  if (!isRevision(value.selectionGeneration) || !Number.isSafeInteger(value.expectedDraftRevision) || value.expectedDraftRevision < 0) throw new Error("invalid_chat_message_acceptance");
  if (typeof value.locale !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(value.locale)) throw new Error("invalid_chat_message_locale");
  if (!isText(value.text)) throw new Error("invalid_chat_message_text");
  assertIdempotencyKey(value.idempotencyKey);
}
function validateAttemptClaimInput(value: MountedP4AttemptClaimInput): void {
  assertId("chatThreadId", value.chatThreadId); assertId("chatSurfaceSessionId", value.chatSurfaceSessionId); assertId("playerId", value.playerId); assertId("companionId", value.companionId); assertId("continuityId", value.continuityId);
  freezeAttemptClaim({ generation: 1, attemptId: "attempt_validation", claimedAtMs: 1, selectionGeneration: value.selectionGeneration, runtimeBindingDigest: value.runtimeBindingDigest, runtimeOwner: value.runtimeOwner });
}
function validateProviderStartInput(value: MountedP4ProviderStartInput): void {
  assertId("chatThreadId", value.chatThreadId); assertId("chatSurfaceSessionId", value.chatSurfaceSessionId); assertId("playerId", value.playerId); assertId("companionId", value.companionId); assertId("continuityId", value.continuityId);
  assertId("attemptId", value.attemptId);
  freezeAttemptClaim({ generation: 1, attemptId: "attempt_validation", claimedAtMs: 1, selectionGeneration: value.selectionGeneration, runtimeBindingDigest: value.runtimeBindingDigest, runtimeOwner: value.runtimeOwner });
}
function validatePresentationInput(value: MountedP5PresentationInput): void {
  assertId("chatThreadId", value.chatThreadId); assertId("chatSurfaceSessionId", value.chatSurfaceSessionId); assertId("playerId", value.playerId); assertId("companionId", value.companionId); assertId("continuityId", value.continuityId);
  assertId("attemptId", value.attemptId);
  freezeAttemptClaim({ generation: 1, attemptId: "attempt_validation", claimedAtMs: 1, selectionGeneration: value.selectionGeneration, runtimeBindingDigest: value.runtimeBindingDigest, runtimeOwner: value.runtimeOwner });
}
function isTurnWithAttempt(ledger: ChatTurnLedger): ledger is Exclude<ChatTurnLedger, AcceptedQueuedTurn> {
  return ledger.status !== "accepted_queued";
}
function isTerminalLedger(ledger: ChatTurnLedger): boolean {
  return ledger.status === "completed" || ledger.status === "cancelled" || ledger.status === "failed";
}
function presentationOf(
  ledger: Exclude<ChatTurnLedger, AcceptedQueuedTurn>,
): PresentationCommitV1 | null {
  if (ledger.status === "presentation_committed" || ledger.status === "completion_claimed" || ledger.status === "completed")
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
      validateNormalMessage({ messageId: message.messageId as string, text: message.text as string, occurredAtMs: message.occurredAtMs as number });
      freezePresentationCommit(Object.freeze({
        expressionId: message.messageId as string,
        messageId: message.messageId as string,
        cancelEpoch: cancelEpoch as number,
        committedAtMs: committedAtMs as number,
      }));
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
  if (
    ledger.status !== "running" ||
    ledger.attempt.attemptId !== input.attemptId ||
    ledger.observation.phase !== "running" ||
    ledger.observation.statusClass !== command.statusClass
  )
    throw new Error("chat_provider_start_readback_mismatch");
}
function assertIdempotencyKey(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(value)) throw new Error("invalid_idempotency_key"); }
function acceptanceFingerprint(input: MountedP4AcceptanceInput): string {
  const fields = ["chat.message.submit", input.chatThreadId, input.chatSurfaceSessionId, input.playerId, input.companionId, input.continuityId, String(input.selectionGeneration), input.text, input.locale, String(input.expectedDraftRevision)];
  const canonical = fields.map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
function validateTurnIntegrity(messages: readonly ChatThreadMessage[], turnLedger: ChatTurnLedger | null, idempotency: readonly IdempotencyRecord[]): void {
  if (new Set(idempotency.map((record) => record.key)).size !== idempotency.length) throw new Error("invalid_chat_thread_idempotency");
  if (new Set(idempotency.map((record) => record.result.turnId)).size !== idempotency.length || new Set(idempotency.map((record) => record.result.messageId)).size !== idempotency.length) throw new Error("invalid_chat_thread_idempotency");
  for (const record of idempotency) {
    if (!messages.some((message) => message.messageId === record.result.messageId && message.role === "player" && message.kind === "player")) throw new Error("invalid_chat_thread_idempotency");
  }
  if (turnLedger === null) {
    if (idempotency.length !== 0) throw new Error("invalid_chat_thread_idempotency");
    return;
  }
  if (!messages.some((message) => message.messageId === turnLedger.messageId && message.role === "player" && message.kind === "player")) throw new Error("invalid_chat_thread_turn_ledger");
  const matching = idempotency.filter((record) => record.key === turnLedger.idempotencyKey && record.result.turnId === turnLedger.turnId && record.result.messageId === turnLedger.messageId && record.result.acceptedAtMs === turnLedger.acceptedAtMs);
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
  return Object.freeze({ thread: state.thread, messages: Object.freeze([...state.messages]), draft: freezeDraft(state.draft), turnLedger: state.turnLedger === null ? null : validateTurnLedger(state.turnLedger), idempotency: Object.freeze(state.idempotency.map(validateIdempotency)) });
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
  // All persisted normal message text shares the P4 player-input policy: NFC,
  // no C0/C1 controls, and at most 16,384 UTF-8 bytes. Response/opening paths
  // must not retain a looser character-count-only rule.
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
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
