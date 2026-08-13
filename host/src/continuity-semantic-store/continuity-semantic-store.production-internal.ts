import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canonicalSha256,
  type ExistingGameOwner,
  type ExactChatThreadMetadata,
  type GameOrigin,
  type GameWorld,
  type LegacyContinuitySnapshot,
  type LegacyEvent,
  validateQuiescentLegacyContinuitySnapshot,
} from "../continuity-production-migration/continuity-production-migration.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION = 13;
const STORE_SCHEMA_VERSION = PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION;
const MAX_BUSY_TIMEOUT_MS = 250;
type LedgerEvent = LegacyEvent;
export type DurablePreviousRuntimeOwner = Readonly<{
  ownerToken: string;
  runtimeInstanceId: string;
  ownerPid: number;
  ownerProcessStartIdentity: string;
}>;
type PreviousRuntimeOwnerVerificationStatus = "proven_dead" | "unavailable" | "alive" | "ambiguous" | "mismatch";
type PreviousRuntimeOwnerVerification<
  S extends PreviousRuntimeOwnerVerificationStatus,
  O extends DurablePreviousRuntimeOwner | null,
> = Readonly<{ status: S; owner: O }>;
export type PreviousRuntimeOwnerVerificationResult =
  | PreviousRuntimeOwnerVerification<"proven_dead", DurablePreviousRuntimeOwner>
  | PreviousRuntimeOwnerVerification<"unavailable", null>
  | PreviousRuntimeOwnerVerification<"alive", DurablePreviousRuntimeOwner>
  | PreviousRuntimeOwnerVerification<"ambiguous", DurablePreviousRuntimeOwner | null>
  | PreviousRuntimeOwnerVerification<"mismatch", DurablePreviousRuntimeOwner | null>;
/** Trusted process-inspection port. It must return one of the factory results below. */
export type PreviousRuntimeOwnerVerifier = Readonly<{
  verifyPreviousRuntimeOwner(owner: DurablePreviousRuntimeOwner): PreviousRuntimeOwnerVerificationResult;
}>;

// Factory identity is intentionally module-private: public DTO fields must never act as authority.
const factoryCreatedPreviousRuntimeOwnerVerifications = new WeakSet<object>();
function verification<S extends PreviousRuntimeOwnerVerificationStatus, O extends DurablePreviousRuntimeOwner | null>(
  status: S,
  owner: O,
): PreviousRuntimeOwnerVerification<S, O> {
  const result = Object.freeze({ status, owner: (owner === null ? null : Object.freeze({ ...owner })) as O });
  factoryCreatedPreviousRuntimeOwnerVerifications.add(result);
  return result;
}
export function previousRuntimeOwnerProvenDead(
  owner: DurablePreviousRuntimeOwner,
): PreviousRuntimeOwnerVerificationResult {
  return verification("proven_dead", owner);
}
export function previousRuntimeOwnerUnavailable(): PreviousRuntimeOwnerVerificationResult {
  return verification("unavailable", null);
}
export function previousRuntimeOwnerAlive(owner: DurablePreviousRuntimeOwner): PreviousRuntimeOwnerVerificationResult {
  return verification("alive", owner);
}
export function previousRuntimeOwnerAmbiguous(
  owner: DurablePreviousRuntimeOwner | null = null,
): PreviousRuntimeOwnerVerificationResult {
  return verification("ambiguous", owner);
}
export function previousRuntimeOwnerMismatch(
  owner: DurablePreviousRuntimeOwner | null = null,
): PreviousRuntimeOwnerVerificationResult {
  return verification("mismatch", owner);
}
export type ContinuitySemanticStoreOptions = Readonly<{
  runtimeRoot: string;
  busyTimeoutMs?: number;
  previousRuntimeOwnerVerifier?: PreviousRuntimeOwnerVerifier /** Production admission rejects, rather than upgrades, historical schemas. */;
  allowHistoricalSchemaUpgrade?: boolean /** Test-only clock; never mounted in production. */;
  nowMs?: () => number;
}>;
export type ContinuityThread = ExactChatThreadMetadata;
/** Authenticated identity is distinct from untrusted command payload. */
export type AuthenticatedContinuityPrincipal = Readonly<{
  continuityId: string;
  companionId: string;
  playerId: string;
}>;
export type ContinuityLease = ExistingGameOwner;
/** The sole adoption input is the canonical migration snapshot DTO. */
export type AdoptLegacyPartitionInput = LegacyContinuitySnapshot;
type SnapshotChatSession = Readonly<{
  sessionId: string;
  surface: "chat";
  state: string;
  createdAtMs: number;
  updatedAtMs: number;
  origin: null;
  world: null;
  returnChatSessionId: null;
}>;
type SnapshotGameSession = Readonly<{
  sessionId: string;
  surface: "game";
  state: string;
  createdAtMs: number;
  updatedAtMs: number;
  origin: GameOrigin;
  world: GameWorld;
  returnChatSessionId: string;
}>;
type SnapshotSession = SnapshotChatSession | SnapshotGameSession;
export type AuthoritativeSnapshot = Readonly<{
  continuityId: string;
  companionId: string;
  playerId: string;
  revision: number;
  fenceEpoch: number;
  authorityState: "adopted" | "semantic_active" | "semantic_quarantined_abandoned_mutex";
  legacySnapshotHash: string;
  activeSelection: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; selectionRevision: number }> | null;
  threads: readonly ContinuityThread[];
  sessions: readonly SnapshotSession[];
  events: readonly LedgerEvent[];
  gameSessions: readonly SnapshotGameSession[];
  lease: ContinuityLease | null;
}>;
export type CommandErrorCode =
  | "invalid_command"
  | "exact_principal_required"
  | "continuity_not_found"
  | "partition_quarantined"
  | "operation_payload_conflict"
  | "selection_revision_conflict"
  | "management_revision_conflict"
  | "fence_conflict"
  | "exact_chat_binding_required"
  | "lifecycle_transition_invalid"
  | "deadline_expired"
  | "game_revision_conflict"
  | "lease_revision_conflict"
  | "game_binding_conflict"
  | "permit_conflict"
  | "receipt_invalid"
  | "game_transition_invalid"
  | "effect_failed";
export class ContinuityCommandError extends Error {
  constructor(readonly code: CommandErrorCode) {
    super(code);
    this.name = "ContinuityCommandError";
  }
}
export type RegisterExactChatCommand = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  continuityId: string;
  companionId: string;
  playerId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  expectedPartitionRevision: number;
  expectedFenceEpoch: number;
  operationId: string;
}>;
export type ChatSelectionCommand = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  continuityId: string;
  companionId: string;
  playerId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  expectedPartitionRevision: number;
  expectedSelectionRevision: number;
  expectedFenceEpoch: number;
  operationId: string;
}>;
export type SemanticChatCatalog = Readonly<{
  continuityId: string;
  revision: number;
  fenceEpoch: number;
  activeSelection: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; selectionRevision: number }> | null;
  threads: readonly Readonly<{
    chatThreadId: string;
    chatSurfaceSessionId: string;
    companionId: string;
    lifecycle: "active" | "archived" | "trashed";
    managementRevision: number;
  }>[];
}>;
export type InitialChatSagaClaim = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  sagaId: string;
  payloadDigest: string;
  expectedPartitionRevision: number;
  expectedFenceEpoch: number;
}>;
export type InitialChatSagaChatRegistration = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  sagaId: string;
  payloadDigest: string;
  claimToken: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  expectedPartitionRevision: number;
  expectedFenceEpoch: number;
}>;
export type InitialChatSagaContentVerification = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  sagaId: string;
  payloadDigest: string;
  claimToken: string;
  contentBindingDigest: string;
}>;
export type InitialChatSagaSelection = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  sagaId: string;
  payloadDigest: string;
  claimToken: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  expectedPartitionRevision: number;
  expectedSelectionRevision: number;
  expectedFenceEpoch: number;
}>;
export type InitialChatSagaReadback = Readonly<{
  continuityId: string;
  revision: number;
  fenceEpoch: number;
  activeSelection: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; selectionRevision: number }> | null;
  phase: "claimed_empty" | "chat_registered" | "content_verified" | "selected";
  sagaId: string;
  payloadDigest: string;
  claimToken: string;
  chatThreadId: string | null;
  chatSurfaceSessionId: string | null;
  contentBindingDigest: string | null;
}>;
export type ArchiveLifecycleCommand = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  continuityId: string;
  companionId: string;
  playerId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  expectedManagementRevision: number;
  expectedFenceEpoch: number;
  operationId: string;
  operation: "archive" | "trash" | "restore";
}>;
export type ChatCommandReadback = Readonly<{
  continuityId: string;
  revision: number;
  fenceEpoch: number;
  operationId: string;
  activeSelection: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; selectionRevision: number }> | null;
  thread: Readonly<{
    chatThreadId: string;
    chatSurfaceSessionId: string;
    companionId: string;
    lifecycle: "active" | "archived" | "trashed";
    managementRevision: number;
    trashRestoreLifecycle: "active" | "archived" | null;
  }>;
}>;
export type GameCommandKind = "game_enter" | "game_return" | "lease_release" | "game_recovery";
export type GameCommand = Readonly<{
  kind: GameCommandKind;
  principal: AuthenticatedContinuityPrincipal;
  continuityId: string;
  operationId: string;
  gameSessionId: string;
  origin: GameOrigin;
  world: GameWorld;
  bindingDigest: string;
  expectedPartitionRevision: number;
  expectedGameRevision: number;
  expectedLeaseRevision: number;
  expectedSelectionRevision: number;
  expectedFenceEpoch: number;
  deadlineAtMs: number;
  runtimeInstanceId: string;
  ownerPid: number;
  ownerProcessStartIdentity: string /** Caller correlation only; never process-liveness evidence. */;
  recoveryRequestId?: string;
}>;
export type GamePermit = Readonly<{
  kind: GameCommandKind;
  continuityId: string;
  operationId: string;
  payloadDigest: string;
  gameSessionId: string;
  origin: GameOrigin;
  world: GameWorld;
  bindingDigest: string;
  fenceEpoch: number;
  fenceToken: string;
  deadlineAtMs: number;
  runtimeInstanceId: string;
  ownerPid: number;
  ownerProcessStartIdentity: string;
}>;
export type GameTerminalReceipt = Readonly<{
  kind: "runtime_bootstrapped" | "runtime_torn_down" | "lease_released" | "recovery_completed";
  operationId: string;
  gameSessionId: string;
  bindingDigest: string;
  origin: GameOrigin;
  world: GameWorld;
  runtimeInstanceId: string;
  ownerPid: number;
  ownerProcessStartIdentity: string;
  occurredAtMs: number;
}>;
export type GameTerminalCommand = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  permit: GamePermit;
  receipt: GameTerminalReceipt;
  expectedPartitionRevision: number;
  expectedGameRevision: number;
  expectedLeaseRevision: number;
  expectedSelectionRevision: number;
  expectedFenceEpoch: number;
}>;
export type GameAbortReason = "cancelled" | "host_shutdown" | "receipt_rejected" | "deadline_expired";
export type GameRevisionVector = Readonly<{
  partitionRevision: number;
  gameRevision: number;
  leaseRevision: number;
  selectionRevision: number;
  fenceEpoch: number;
}>;
/** Bounded durable cause for a terminal recovery outcome; distinct from caller-requested abort semantics. */
export type GameRecoveryReason =
  | "deadline_expired"
  | "receipt_invalid"
  | "revision_or_fence_conflict"
  | "effect_failed";
/** The executor reported failure without a terminal receipt; the external outcome is unknown. */
export type GameEffectFailureReason = "effect_failed";
export type GameRecoveryFacts = Readonly<{ prepared: GameRevisionVector; final: GameRevisionVector }>;
export type GameCommandReadback = Readonly<{
  continuityId: string;
  revision: number;
  fenceEpoch: number;
  operationId: string;
  gameSessionId: string;
  gameState: string;
  originChatState: string;
  leaseState: ContinuityLease["state"] | null;
  pending: boolean;
  status: "pending" | "terminal" | "aborted" | "recovery_required";
  abortReason: GameAbortReason | null;
  recoveryReason?: GameRecoveryReason;
  recoveryErrorCode?: CommandErrorCode;
  recoveryFacts?: GameRecoveryFacts;
}>;
export type GamePrepareOutcome =
  | Readonly<{ outcome: "effect_owned"; permit: GamePermit; readback: GameCommandReadback }>
  | Readonly<{
      outcome: "effect_pending" | "completed" | "aborted" | "recovery_required";
      readback: GameCommandReadback;
    }>;
export type GameOperationCommitInput = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  permit: GamePermit;
  receipt: GameTerminalReceipt;
}>;
export type GameOperationAbortInput = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  permit: GamePermit;
  reason: GameAbortReason;
}>;
export type GameOperationFailureInput = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  permit: GamePermit;
  reason: GameEffectFailureReason;
}>;
export type InitialChatSagaStore = Readonly<{
  claimInitialChatSaga(input: InitialChatSagaClaim): InitialChatSagaReadback;
  registerInitialChatSagaChat(input: InitialChatSagaChatRegistration): InitialChatSagaReadback;
  verifyInitialChatSagaContent(input: InitialChatSagaContentVerification): InitialChatSagaReadback;
  selectInitialChatSagaChat(input: InitialChatSagaSelection): InitialChatSagaReadback;
  readInitialChatSaga(
    input: Readonly<{ principal: AuthenticatedContinuityPrincipal; sagaId: string }>,
  ): InitialChatSagaReadback | null;
}>;
export type ContinuitySemanticStore = Readonly<{
  adoptLegacyPartition(input: AdoptLegacyPartitionInput): AuthoritativeSnapshot;
  markAbandonedMutexQuarantine(input: Readonly<{ principal: AuthenticatedContinuityPrincipal }>): Readonly<{
    continuityId: string;
    authorityState: "semantic_quarantined_abandoned_mutex";
    revision: number;
    fenceEpoch: number;
  }>;
  readAuthoritativeSnapshot(input: Readonly<{ continuityId: string }>): AuthoritativeSnapshot | null;
  registerExactChat(input: RegisterExactChatCommand): ChatCommandReadback;
  readChatCatalog(input: Readonly<{ principal: AuthenticatedContinuityPrincipal }>): SemanticChatCatalog;
  selectOpenExactChat(input: ChatSelectionCommand): ChatCommandReadback;
  transitionArchiveLifecycle(input: ArchiveLifecycleCommand): ChatCommandReadback;
  prepareGameCommand(input: GameCommand): GamePermit;
  prepareGameOperation(input: GameCommand): GamePrepareOutcome;
  readGameOperation(
    input: Readonly<{ principal: AuthenticatedContinuityPrincipal; operationId: string }>,
  ): GameCommandReadback | null;
  readPreparedGameOperationVector(
    input: Readonly<{ principal: AuthenticatedContinuityPrincipal; operationId: string }>,
  ): GameRevisionVector | null;
  commitGameTerminal(input: GameTerminalCommand): GameCommandReadback;
  commitGameOperation(input: GameOperationCommitInput): GameCommandReadback;
  abortGameCommand(
    input: Readonly<{ principal: AuthenticatedContinuityPrincipal; permit: GamePermit; expectedFenceEpoch: number }>,
  ): GameCommandReadback;
  abortGameOperation(input: GameOperationAbortInput): GameCommandReadback;
  failGameOperation(input: GameOperationFailureInput): GameCommandReadback;
  close(): void;
}>;

/** Test-only harness. It intentionally has no production bootstrap, migration, or JSON fallback. */
export function openContinuitySemanticStore(
  options: ContinuitySemanticStoreOptions,
): ContinuitySemanticStore & InitialChatSagaStore {
  return openConnectionBackedStore(options, "WAL", true);
}

export type ProductionBootstrapInput = Readonly<{
  principal: AuthenticatedContinuityPrincipal;
  bootstrapOperationId: string;
  legacySnapshotHash: string;
  authorityGeneration: number;
  authorityRootIdentity: string;
}>;
export type ProductionStoreMetadata = Readonly<{ storeId: string; schemaVersion: number }>;
/** Opaque production control: neither callers nor its returned store receive DatabaseSync. */
export type ProductionContinuityStore = Readonly<{
  store: ContinuitySemanticStore;
  bootstrapFresh(input: ProductionBootstrapInput): ProductionStoreMetadata;
  validateBootstrap(input: ProductionBootstrapInput): ProductionStoreMetadata;
  configuration(): Readonly<{ journalMode: string; synchronous: number; busyTimeoutMs: number }>;
  close(): void;
}>;
/** Production-only factory. The caller cannot select its journal mode or schema-upgrade policy. */
export function openProductionContinuityStore(options: Readonly<{ runtimeRoot: string }>): ProductionContinuityStore {
  if (!isNonEmpty(options.runtimeRoot)) throw new Error("invalid_runtime_root");
  const db = new DatabaseSync(join(options.runtimeRoot, "gamebuddy-continuity-v1.sqlite"));
  try {
    db.exec(
      `PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${MAX_BUSY_TIMEOUT_MS};`,
    );
    initialize(db, false);
  } catch (error) {
    db.close();
    throw error;
  }
  const store = createConnectionBackedStore(db, Date.now, undefined);
  let closed = false;
  const requireOpen = (): void => {
    if (closed) throw new Error("production_continuity_store_closed");
  };
  return Object.freeze({
    store,
    bootstrapFresh(input) {
      requireOpen();
      return bootstrapProduction(db, input);
    },
    validateBootstrap(input) {
      requireOpen();
      return validateProductionBootstrap(db, input);
    },
    configuration() {
      requireOpen();
      return Object.freeze({
        journalMode: (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
        synchronous: (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous,
        busyTimeoutMs: (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
      });
    },
    close() {
      if (!closed) {
        closed = true;
        store.close();
      }
    },
  });
}

function createConnectionBackedStore(
  db: DatabaseSync,
  nowMs: () => number,
  previousRuntimeOwnerVerifier: PreviousRuntimeOwnerVerifier | undefined,
): ContinuitySemanticStore & InitialChatSagaStore {
  let closed = false;
  const requireOpen = (): void => {
    if (closed) throw new Error("continuity_semantic_store_closed");
  };
  return Object.freeze({
    adoptLegacyPartition(input) {
      requireOpen();
      validateQuiescentLegacyContinuitySnapshot(input);
      return withImmediateTransaction(db, () => {
        const existing = db
          .prepare("SELECT legacy_snapshot_hash FROM continuity_partition WHERE continuity_id = ?")
          .get(input.continuityId) as { legacy_snapshot_hash: string } | undefined;
        if (existing && existing.legacy_snapshot_hash !== input.snapshotHash)
          throw new Error("continuity_authority_conflict");
        if (!existing) insertInput(db, input);
        return readSnapshot(db, input.continuityId)!;
      });
    },
    claimInitialChatSaga(input) {
      requireOpen();
      return claimInitialChatSaga(db, input);
    },
    registerInitialChatSagaChat(input) {
      requireOpen();
      return registerInitialChatSagaChat(db, input, nowMs());
    },
    verifyInitialChatSagaContent(input) {
      requireOpen();
      return verifyInitialChatSagaContent(db, input);
    },
    selectInitialChatSagaChat(input) {
      requireOpen();
      return selectInitialChatSagaChat(db, input, nowMs());
    },
    readInitialChatSaga(input) {
      requireOpen();
      return readInitialChatSaga(db, input);
    },
    markAbandonedMutexQuarantine(input) {
      requireOpen();
      return markAbandonedMutexQuarantine(db, input);
    },
    readAuthoritativeSnapshot({ continuityId }) {
      requireOpen();
      if (!opaque(continuityId)) throw new Error("invalid_continuity_id");
      return withImmediateTransaction(db, () => readSnapshot(db, continuityId));
    },
    registerExactChat(input) {
      requireOpen();
      return registerExactChat(db, input, nowMs());
    },
    readChatCatalog(input) {
      requireOpen();
      return readChatCatalog(db, input);
    },
    selectOpenExactChat(input) {
      requireOpen();
      return runChatCommand(db, input, "select_open", validateSelectionCommand, applySelection);
    },
    transitionArchiveLifecycle(input) {
      requireOpen();
      return runChatCommand(db, input, "archive_lifecycle", validateArchiveCommand, applyArchiveLifecycle);
    },
    prepareGameCommand(input) {
      requireOpen();
      return prepareGameCommand(db, input, nowMs(), previousRuntimeOwnerVerifier);
    },
    prepareGameOperation(input) {
      requireOpen();
      return prepareGameOperation(db, input, nowMs(), previousRuntimeOwnerVerifier);
    },
    readGameOperation(input) {
      requireOpen();
      return readGameOperation(db, input);
    },
    readPreparedGameOperationVector(input) {
      requireOpen();
      return readPreparedGameOperationVector(db, input);
    },
    commitGameTerminal(input) {
      requireOpen();
      return commitGameTerminal(db, input, nowMs());
    },
    commitGameOperation(input) {
      requireOpen();
      return commitGameOperation(db, input, nowMs());
    },
    abortGameCommand(input) {
      requireOpen();
      return abortGameCommand(db, input);
    },
    abortGameOperation(input) {
      requireOpen();
      return abortGameOperation(db, input);
    },
    failGameOperation(input) {
      requireOpen();
      return failGameOperation(db, input);
    },
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  });
}

function openConnectionBackedStore(
  options: ContinuitySemanticStoreOptions,
  journalMode: "WAL" | "DELETE",
  allowRuntimeRootCreate: boolean,
): ContinuitySemanticStore & InitialChatSagaStore {
  if (!isNonEmpty(options.runtimeRoot)) throw new Error("invalid_runtime_root");
  const busyTimeoutMs = options.busyTimeoutMs ?? MAX_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS)
    throw new Error("invalid_busy_timeout");
  if (allowRuntimeRootCreate) mkdirSync(options.runtimeRoot, { recursive: true });
  const db = new DatabaseSync(join(options.runtimeRoot, "gamebuddy-continuity-v1.sqlite"));
  try {
    db.exec(
      `PRAGMA foreign_keys=ON; PRAGMA journal_mode=${journalMode}; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${busyTimeoutMs};`,
    );
    initialize(db, options.allowHistoricalSchemaUpgrade !== false);
  } catch (error) {
    db.close();
    throw error;
  }
  return createConnectionBackedStore(db, options.nowMs ?? Date.now, options.previousRuntimeOwnerVerifier);
}
function bootstrapProduction(db: DatabaseSync, input: ProductionBootstrapInput): ProductionStoreMetadata {
  if (
    !validPrincipal(input.principal) ||
    !opaque(input.bootstrapOperationId) ||
    !/^[a-f0-9]{64}$/.test(input.legacySnapshotHash) ||
    !positiveGeneration(input.authorityGeneration) ||
    !authorityRootIdentity(input.authorityRootIdentity)
  )
    throw new Error("invalid_production_bootstrap");
  return withImmediateTransaction(db, () => {
    const meta = readProductionMetadata(db);
    if (!meta || meta.schemaVersion !== STORE_SCHEMA_VERSION || hasTable(db, "production_continuity_bootstrap"))
      throw new Error("production_store_schema_invalid");
    db.exec(
      "CREATE TABLE production_continuity_bootstrap (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), store_id TEXT NOT NULL, schema_version INTEGER NOT NULL, authority TEXT NOT NULL CHECK (authority = 'SEMANTIC'), authority_state TEXT NOT NULL CHECK (authority_state = 'active'), bootstrap_operation_id TEXT NOT NULL, continuity_id TEXT NOT NULL, companion_id TEXT NOT NULL, player_id TEXT NOT NULL, authority_generation INTEGER NOT NULL, authority_root_identity TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO production_continuity_bootstrap VALUES (1, ?, ?, 'SEMANTIC', 'active', ?, ?, ?, ?, ?, ?)",
    ).run(
      meta.storeId,
      STORE_SCHEMA_VERSION,
      input.bootstrapOperationId,
      input.principal.continuityId,
      input.principal.companionId,
      input.principal.playerId,
      input.authorityGeneration,
      input.authorityRootIdentity,
    );
    db.prepare("INSERT INTO continuity_partition VALUES (?, ?, ?, 1, 1, 'semantic_active', ?)").run(
      input.principal.continuityId,
      input.principal.companionId,
      input.principal.playerId,
      input.legacySnapshotHash,
    );
    return validateProductionBootstrap(db, input);
  });
}
function validateProductionBootstrap(db: DatabaseSync, input: ProductionBootstrapInput): ProductionStoreMetadata {
  if (
    !validPrincipal(input.principal) ||
    !opaque(input.bootstrapOperationId) ||
    !/^[a-f0-9]{64}$/.test(input.legacySnapshotHash) ||
    !positiveGeneration(input.authorityGeneration) ||
    !authorityRootIdentity(input.authorityRootIdentity)
  )
    throw new Error("invalid_production_bootstrap");
  const meta = readProductionMetadata(db);
  if (!meta || meta.schemaVersion !== STORE_SCHEMA_VERSION || !hasTable(db, "production_continuity_bootstrap"))
    throw new Error("production_store_schema_invalid");
  const rows = db.prepare("SELECT * FROM production_continuity_bootstrap").all() as Array<Record<string, unknown>>;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.singleton !== 1 ||
    row.store_id !== meta.storeId ||
    row.schema_version !== STORE_SCHEMA_VERSION ||
    row.authority !== "SEMANTIC" ||
    row.authority_state !== "active" ||
    row.bootstrap_operation_id !== input.bootstrapOperationId ||
    row.continuity_id !== input.principal.continuityId ||
    row.companion_id !== input.principal.companionId ||
    row.player_id !== input.principal.playerId ||
    row.authority_generation !== input.authorityGeneration ||
    row.authority_root_identity !== input.authorityRootIdentity
  )
    throw new Error("production_store_identity_mismatch");
  const partitions = db
    .prepare(
      "SELECT continuity_id,companion_id,player_id,authority_state,legacy_snapshot_hash FROM continuity_partition",
    )
    .all() as Array<Record<string, unknown>>;
  const p = partitions[0];
  if (partitions.length === 1 && p && p.authority_state === "semantic_quarantined_abandoned_mutex")
    throw new Error("production_partition_quarantined");
  if (
    partitions.length !== 1 ||
    !p ||
    p.continuity_id !== input.principal.continuityId ||
    p.companion_id !== input.principal.companionId ||
    p.player_id !== input.principal.playerId ||
    p.authority_state !== "semantic_active" ||
    p.legacy_snapshot_hash !== input.legacySnapshotHash
  )
    throw new Error("production_store_partition_invalid");
  return meta;
}
function readProductionMetadata(db: DatabaseSync): ProductionStoreMetadata | null {
  if (!hasTable(db, "store_meta")) return null;
  const rows = db.prepare("SELECT schema_version,store_id FROM store_meta").all() as Array<{
    schema_version: unknown;
    store_id: unknown;
  }>;
  if (
    rows.length !== 1 ||
    typeof rows[0]?.schema_version !== "number" ||
    !Number.isSafeInteger(rows[0]?.schema_version) ||
    !opaque(rows[0]?.store_id)
  )
    return null;
  return Object.freeze({ schemaVersion: rows[0].schema_version, storeId: rows[0].store_id });
}
function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

export function withImmediateTransaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function")
      throw new Error("async_sqlite_transaction_callback_rejected");
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* none */
    }
    throw error;
  }
}
function initialize(db: DatabaseSync, allowHistoricalSchemaUpgrade: boolean): void {
  const metaExists =
    (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_meta'").get() as unknown) !== undefined;
  if (metaExists) {
    const metas = db.prepare("SELECT schema_version, store_id FROM store_meta").all() as Array<{
      schema_version: number;
      store_id: string;
    }>;
    if (metas.length !== 1 || !Number.isSafeInteger(metas[0]?.schema_version) || !opaque(metas[0]?.store_id))
      throw new Error("unsupported_continuity_store_schema");
    const meta = metas[0];
    if (meta.schema_version !== STORE_SCHEMA_VERSION) throw new Error("unsupported_continuity_store_schema");
    validateCurrentSchemaSignature(db, true);
    return;
  }
  withImmediateTransaction(db, () => {
    db.exec(
      `CREATE TABLE store_meta (schema_version INTEGER NOT NULL, store_id TEXT NOT NULL); CREATE TABLE continuity_partition (continuity_id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, player_id TEXT NOT NULL, revision INTEGER NOT NULL, fence_epoch INTEGER NOT NULL, authority_state TEXT NOT NULL, legacy_snapshot_hash TEXT NOT NULL); CREATE TABLE active_chat_selection (continuity_id TEXT PRIMARY KEY REFERENCES continuity_partition(continuity_id), chat_thread_id TEXT NOT NULL, chat_surface_session_id TEXT NOT NULL, selection_revision INTEGER NOT NULL); CREATE TABLE continuity_command (continuity_id TEXT NOT NULL REFERENCES continuity_partition(continuity_id), operation_id TEXT NOT NULL, command_kind TEXT NOT NULL, payload_digest TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY (continuity_id, operation_id)); CREATE TABLE chat_lifecycle_metadata (chat_surface_session_id TEXT PRIMARY KEY REFERENCES continuity_thread(chat_surface_session_id), management_revision INTEGER NOT NULL, trash_restore_lifecycle TEXT CHECK (trash_restore_lifecycle IN ('active', 'archived'))); CREATE TABLE surface_session (session_id TEXT PRIMARY KEY, continuity_id TEXT NOT NULL REFERENCES continuity_partition(continuity_id), surface TEXT NOT NULL, state TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, chat_thread_id TEXT, player_id TEXT, companion_id TEXT, origin_chat_thread_id TEXT, origin_chat_surface_session_id TEXT, origin_continuity_id TEXT, integration_id TEXT, save_id TEXT, world_id TEXT, return_chat_session_id TEXT, game_revision INTEGER NOT NULL DEFAULT 1); CREATE TABLE continuity_thread (chat_surface_session_id TEXT PRIMARY KEY REFERENCES surface_session(session_id), continuity_id TEXT NOT NULL REFERENCES continuity_partition(continuity_id), chat_thread_id TEXT NOT NULL, companion_id TEXT NOT NULL, lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived', 'trashed')), UNIQUE (continuity_id, chat_thread_id)); CREATE TABLE continuity_event (event_id TEXT PRIMARY KEY, continuity_id TEXT NOT NULL REFERENCES continuity_partition(continuity_id), type TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES surface_session(session_id), surface TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL); CREATE TABLE game_runtime_lease (continuity_id TEXT PRIMARY KEY REFERENCES continuity_partition(continuity_id), session_id TEXT NOT NULL REFERENCES surface_session(session_id), binding_digest TEXT NOT NULL, owner_token TEXT NOT NULL, runtime_instance_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_process_start_identity TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('owned', 'return_pending', 'recovery_required')), lease_revision INTEGER NOT NULL DEFAULT 1); CREATE TABLE game_command_intent (continuity_id TEXT NOT NULL REFERENCES continuity_partition(continuity_id), operation_id TEXT NOT NULL, kind TEXT NOT NULL, payload_digest TEXT NOT NULL, game_session_id TEXT NOT NULL, binding_digest TEXT NOT NULL, origin_json TEXT NOT NULL, world_json TEXT NOT NULL, fence_epoch INTEGER NOT NULL, fence_token TEXT NOT NULL, deadline_at_ms INTEGER NOT NULL, expected_partition_revision INTEGER NOT NULL, expected_game_revision INTEGER NOT NULL, expected_lease_revision INTEGER NOT NULL, expected_selection_revision INTEGER NOT NULL, runtime_instance_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_process_start_identity TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','terminal','aborted','recovery_required')), abort_reason TEXT CHECK(abort_reason IN ('cancelled','host_shutdown','receipt_rejected','deadline_expired')), response_json TEXT, prepared_partition_revision INTEGER, prepared_game_revision INTEGER, prepared_lease_revision INTEGER, prepared_selection_revision INTEGER, recovery_error_code TEXT, recovery_reason TEXT, final_partition_revision INTEGER, final_game_revision INTEGER, final_lease_revision INTEGER, final_selection_revision INTEGER, final_fence_epoch INTEGER, terminal_receipt_digest TEXT, PRIMARY KEY (continuity_id, operation_id)); CREATE TABLE initial_chat_saga (continuity_id TEXT PRIMARY KEY REFERENCES continuity_partition(continuity_id), saga_id TEXT NOT NULL, payload_digest TEXT NOT NULL, claim_token TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('claimed_empty','chat_registered','content_verified','selected')), chat_thread_id TEXT, chat_surface_session_id TEXT, content_binding_digest TEXT, UNIQUE(continuity_id, saga_id));`,
    );
    db.prepare("INSERT INTO store_meta VALUES (?, ?)").run(STORE_SCHEMA_VERSION, randomUUID());
    validateCurrentSchemaSignature(db, true);
  });
}
type HistoricalColumn = readonly [name: string, type: string, notNull: boolean, primaryKeyPosition?: number];
const historicalBaseColumns: Readonly<Record<string, readonly HistoricalColumn[]>> = {
  store_meta: [
    ["schema_version", "INTEGER", true],
    ["store_id", "TEXT", true],
  ],
  continuity_partition: [
    ["continuity_id", "TEXT", false, 1],
    ["companion_id", "TEXT", true],
    ["player_id", "TEXT", true],
    ["revision", "INTEGER", true],
    ["fence_epoch", "INTEGER", true],
    ["authority_state", "TEXT", true],
    ["legacy_snapshot_hash", "TEXT", true],
  ],
  active_chat_selection: [
    ["continuity_id", "TEXT", false, 1],
    ["chat_thread_id", "TEXT", true],
    ["chat_surface_session_id", "TEXT", true],
    ["selection_revision", "INTEGER", true],
  ],
  continuity_command: [
    ["continuity_id", "TEXT", true, 1],
    ["operation_id", "TEXT", true, 2],
    ["command_kind", "TEXT", true],
    ["payload_digest", "TEXT", true],
    ["response_json", "TEXT", true],
  ],
  chat_lifecycle_metadata: [
    ["chat_surface_session_id", "TEXT", false, 1],
    ["management_revision", "INTEGER", true],
    ["trash_restore_lifecycle", "TEXT", false],
  ],
  surface_session: [
    ["session_id", "TEXT", false, 1],
    ["continuity_id", "TEXT", true],
    ["surface", "TEXT", true],
    ["state", "TEXT", true],
    ["created_at_ms", "INTEGER", true],
    ["updated_at_ms", "INTEGER", true],
    ["chat_thread_id", "TEXT", false],
    ["player_id", "TEXT", false],
    ["companion_id", "TEXT", false],
    ["origin_chat_thread_id", "TEXT", false],
    ["origin_chat_surface_session_id", "TEXT", false],
    ["origin_continuity_id", "TEXT", false],
    ["integration_id", "TEXT", false],
    ["save_id", "TEXT", false],
    ["world_id", "TEXT", false],
    ["return_chat_session_id", "TEXT", false],
    ["game_revision", "INTEGER", true],
  ],
  continuity_thread: [
    ["chat_surface_session_id", "TEXT", false, 1],
    ["continuity_id", "TEXT", true],
    ["chat_thread_id", "TEXT", true],
    ["companion_id", "TEXT", true],
    ["lifecycle", "TEXT", true],
  ],
  continuity_event: [
    ["event_id", "TEXT", false, 1],
    ["continuity_id", "TEXT", true],
    ["type", "TEXT", true],
    ["session_id", "TEXT", true],
    ["surface", "TEXT", true],
    ["occurred_at_ms", "INTEGER", true],
  ],
  game_runtime_lease: [
    ["continuity_id", "TEXT", false, 1],
    ["session_id", "TEXT", true],
    ["binding_digest", "TEXT", true],
    ["owner_token", "TEXT", true],
    ["runtime_instance_id", "TEXT", true],
    ["owner_pid", "INTEGER", true],
    ["owner_process_start_identity", "TEXT", true],
    ["state", "TEXT", true],
    ["lease_revision", "INTEGER", true],
  ],
  game_command_intent: [
    ["continuity_id", "TEXT", true, 1],
    ["operation_id", "TEXT", true, 2],
    ["kind", "TEXT", true],
    ["payload_digest", "TEXT", true],
    ["game_session_id", "TEXT", true],
    ["binding_digest", "TEXT", true],
    ["origin_json", "TEXT", true],
    ["world_json", "TEXT", true],
    ["fence_epoch", "INTEGER", true],
    ["fence_token", "TEXT", true],
    ["deadline_at_ms", "INTEGER", true],
    ["expected_partition_revision", "INTEGER", true],
    ["expected_game_revision", "INTEGER", true],
    ["expected_lease_revision", "INTEGER", true],
    ["expected_selection_revision", "INTEGER", true],
    ["runtime_instance_id", "TEXT", true],
    ["owner_pid", "INTEGER", true],
    ["owner_process_start_identity", "TEXT", true],
    ["status", "TEXT", true],
    ["abort_reason", "TEXT", false],
    ["response_json", "TEXT", false],
  ],
};
const historicalForeignKeys: Readonly<Record<string, readonly [string, string, string][]>> = {
  active_chat_selection: [["continuity_id", "continuity_partition", "continuity_id"]],
  continuity_command: [["continuity_id", "continuity_partition", "continuity_id"]],
  chat_lifecycle_metadata: [["chat_surface_session_id", "continuity_thread", "chat_surface_session_id"]],
  surface_session: [["continuity_id", "continuity_partition", "continuity_id"]],
  continuity_thread: [
    ["chat_surface_session_id", "surface_session", "session_id"],
    ["continuity_id", "continuity_partition", "continuity_id"],
  ],
  continuity_event: [
    ["continuity_id", "continuity_partition", "continuity_id"],
    ["session_id", "surface_session", "session_id"],
  ],
  game_runtime_lease: [
    ["continuity_id", "continuity_partition", "continuity_id"],
    ["session_id", "surface_session", "session_id"],
  ],
  game_command_intent: [["continuity_id", "continuity_partition", "continuity_id"]],
};
function validateLegacySchemaSignature(db: DatabaseSync, version: 7 | 8 | 9): void {
  const v8Prepared = [
    ["prepared_partition_revision", "INTEGER", false],
    ["prepared_game_revision", "INTEGER", false],
    ["prepared_lease_revision", "INTEGER", false],
    ["prepared_selection_revision", "INTEGER", false],
  ] as const;
  const v9Extensions = [
    ["recovery_error_code", "TEXT", false],
    ["recovery_reason", "TEXT", false],
    ["final_partition_revision", "INTEGER", false],
    ["final_game_revision", "INTEGER", false],
    ["final_lease_revision", "INTEGER", false],
    ["final_selection_revision", "INTEGER", false],
    ["final_fence_epoch", "INTEGER", false],
    ["terminal_receipt_digest", "TEXT", false],
  ] as const;
  // v8 deployments may have received the additive v9 columns before their metadata bump; admit only exact historical signatures.
  const intentSignatures =
    version === 7
      ? [historicalBaseColumns.game_command_intent]
      : version === 8
        ? [
            [...historicalBaseColumns.game_command_intent, ...v8Prepared],
            [...historicalBaseColumns.game_command_intent, ...v8Prepared, ...v9Extensions],
          ]
        : [[...historicalBaseColumns.game_command_intent, ...v8Prepared, ...v9Extensions]];
  for (const [table, baseColumns] of Object.entries(historicalBaseColumns)) {
    const signatures = table === "game_command_intent" ? intentSignatures : [baseColumns];
    const actual = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    if (
      !signatures.some(
        (expected) =>
          actual.length === expected.length &&
          actual.every(
            (column, index) =>
              column.name === expected[index]![0] &&
              column.type.toUpperCase() === expected[index]![1] &&
              Boolean(column.notnull) === expected[index]![2] &&
              (expected[index]![3] ?? 0) === column.pk,
          ),
      )
    )
      throw new Error("unsupported_continuity_store_schema");
    const expectedFks = historicalForeignKeys[table] ?? [];
    const actualFks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      from: string;
      table: string;
      to: string;
    }>;
    if (
      actualFks.length !== expectedFks.length ||
      expectedFks.some(
        ([from, target, to]) => !actualFks.some((fk) => fk.from === from && fk.table === target && fk.to === to),
      )
    )
      throw new Error("unsupported_continuity_store_schema");
  }
  const sql = (table: string): string =>
    (
      (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
          | { sql?: string }
          | undefined
      )?.sql ?? ""
    )
      .replace(/[\s\"`]/g, "")
      .toLowerCase();
  const requires = (table: string, fragment: string): void => {
    if (!sql(table).includes(fragment)) throw new Error("unsupported_continuity_store_schema");
  };
  requires("continuity_thread", "check(lifecyclein('active','archived','trashed'))");
  requires("game_runtime_lease", "check(statein('owned','return_pending','recovery_required'))");
  requires("game_command_intent", "check(statusin('pending','terminal','aborted','recovery_required'))");
  requires(
    "game_command_intent",
    "check(abort_reasonin('cancelled','host_shutdown','receipt_rejected','deadline_expired'))",
  );
}
function ensureGameCommandIntentColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(game_command_intent)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  for (const column of [
    "prepared_partition_revision",
    "prepared_game_revision",
    "prepared_lease_revision",
    "prepared_selection_revision",
    "recovery_error_code",
    "recovery_reason",
    "final_partition_revision",
    "final_game_revision",
    "final_lease_revision",
    "final_selection_revision",
    "final_fence_epoch",
    "terminal_receipt_digest",
  ]) {
    if (!columns.has(column))
      db.exec(
        `ALTER TABLE game_command_intent ADD COLUMN ${column} ${column === "recovery_error_code" || column === "recovery_reason" || column === "terminal_receipt_digest" ? "TEXT" : "INTEGER"}`,
      );
  }
}
function ensureChatThreadUniqueness(db: DatabaseSync): void {
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS continuity_thread_continuity_id_chat_thread_id_unique ON continuity_thread(continuity_id, chat_thread_id)",
  );
}
function validateCurrentSchemaSignature(db: DatabaseSync, requireUnique: boolean): void {
  const meta = db.prepare("SELECT schema_version FROM store_meta").get() as { schema_version: number } | undefined;
  if (
    !meta ||
    !Number.isSafeInteger(meta.schema_version) ||
    meta.schema_version !== STORE_SCHEMA_VERSION ||
    !hasTable(db, "initial_chat_saga")
  )
    throw new Error("unsupported_continuity_store_schema");
  validateLegacySchemaSignature(db, 9);
  const indexes = db.prepare("PRAGMA index_list(continuity_thread)").all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const matching = indexes.some(
    (index) =>
      Boolean(index.unique) &&
      !Boolean(index.partial) &&
      (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .join(",") === "continuity_id,chat_thread_id",
  );
  if (requireUnique && !matching) throw new Error("unsupported_continuity_store_schema");
}
function positiveGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function authorityRootIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function insertInput(db: DatabaseSync, input: AdoptLegacyPartitionInput): void {
  db.prepare("INSERT INTO continuity_partition VALUES (?, ?, ?, 1, 1, 'adopted', ?)").run(
    input.continuityId,
    input.companionId,
    input.playerId,
    input.snapshotHash,
  );
  if (input.activeSelection)
    db.prepare("INSERT INTO active_chat_selection VALUES (?, ?, ?, ?)").run(
      input.continuityId,
      input.activeSelection.chatThreadId,
      input.activeSelection.chatSurfaceSessionId,
      input.activeSelection.selectionRevision,
    );
  const stmt = db.prepare("INSERT INTO surface_session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const threads = new Map(input.chatThreads.map((t) => [t.chatSurfaceSessionId, t]));
  for (const s of input.legacyLedger.sessions) {
    const t = s.surface === "chat" ? threads.get(s.sessionId) : undefined;
    const o = s.origin;
    const w = s.world;
    stmt.run(
      s.sessionId,
      input.continuityId,
      s.surface,
      s.state,
      s.createdAtMs,
      s.updatedAtMs,
      t?.chatThreadId ?? null,
      o?.playerId ?? null,
      t?.companionId ?? o?.companionId ?? null,
      o?.chatThreadId ?? null,
      o?.chatSurfaceSessionId ?? null,
      o?.continuityId ?? null,
      w?.integrationId ?? null,
      w?.saveId ?? null,
      w?.worldId ?? null,
      s.returnChatSessionId,
      1,
    );
  }
  const thread = db.prepare("INSERT INTO continuity_thread VALUES (?, ?, ?, ?, ?)");
  const metadata = db.prepare("INSERT INTO chat_lifecycle_metadata VALUES (?, ?, ?)");
  for (const t of input.chatThreads) {
    thread.run(t.chatSurfaceSessionId, input.continuityId, t.chatThreadId, t.companionId, t.lifecycle);
    metadata.run(t.chatSurfaceSessionId, t.managementRevision, t.trashRestoreLifecycle);
  }
  const event = db.prepare("INSERT INTO continuity_event VALUES (?, ?, ?, ?, ?, ?)");
  for (const e of input.legacyLedger.events)
    event.run(e.eventId, input.continuityId, e.type, e.sessionId, e.surface, e.occurredAtMs);
  if (input.gameOwner)
    db.prepare("INSERT INTO game_runtime_lease VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      input.continuityId,
      input.gameOwner.gameSessionId,
      input.gameOwner.bindingDigest,
      input.gameOwner.ownerToken,
      input.gameOwner.runtimeInstanceId,
      input.gameOwner.ownerPid,
      input.gameOwner.ownerProcessStartIdentity,
      input.gameOwner.state,
      1,
    );
}
function prepareGameCommand(
  db: DatabaseSync,
  input: GameCommand,
  now: number,
  previousRuntimeOwnerVerifier: PreviousRuntimeOwnerVerifier | undefined,
): GamePermit {
  return prepareGameCommandCore(db, input, now, previousRuntimeOwnerVerifier).permit;
}
/** One immediate transaction owns both idempotency lookup and transition preparation. */
function prepareGameCommandCore(
  db: DatabaseSync,
  input: GameCommand,
  now: number,
  previousRuntimeOwnerVerifier: PreviousRuntimeOwnerVerifier | undefined,
): Readonly<{ permit: GamePermit; created: boolean }> {
  validateGameCommand(input, now);
  const digest = canonicalSha256(input);
  return withImmediateTransaction(db, () => {
    const p = partition(db, input.continuityId);
    assertPrincipal(db, input.principal);
    const existing = db
      .prepare(
        "SELECT payload_digest, fence_epoch, fence_token, deadline_at_ms, runtime_instance_id, owner_pid, owner_process_start_identity FROM game_command_intent WHERE continuity_id=? AND operation_id=?",
      )
      .get(input.continuityId, input.operationId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.payload_digest !== digest) throw commandError("operation_payload_conflict");
      return Object.freeze({ permit: permitFrom(input, digest, existing), created: false });
    }
    validateGameCurrent(db, input, p);
    const fence = p.fence_epoch + 1,
      token = randomUUID();
    if (input.kind === "game_enter") {
      const unresolved = db
        .prepare("SELECT session_id FROM surface_session WHERE continuity_id=? AND surface='game' AND state!='ended'")
        .get(input.continuityId);
      if (unresolved) throw commandError("game_transition_invalid");
      assertActiveSelectedGameOrigin(db, input);
      db.prepare(
        "INSERT INTO surface_session VALUES (?, ?, 'game', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.gameSessionId,
        input.continuityId,
        now,
        now,
        null,
        input.origin.playerId,
        input.origin.companionId,
        input.origin.chatThreadId,
        input.origin.chatSurfaceSessionId,
        input.origin.continuityId,
        input.world.integrationId,
        input.world.saveId,
        input.world.worldId,
        input.origin.chatSurfaceSessionId,
        1,
      );
      db.prepare("INSERT INTO game_runtime_lease VALUES (?, ?, ?, ?, ?, ?, ?, 'owned', 1)").run(
        input.continuityId,
        input.gameSessionId,
        input.bindingDigest,
        "pending",
        input.runtimeInstanceId,
        input.ownerPid,
        input.ownerProcessStartIdentity,
      );
    } else {
      const game = gameRow(db, input);
      if (game.state !== "active" && !(input.kind === "game_recovery" && game.state === "recovery_required"))
        throw commandError("game_transition_invalid");
      if (input.kind === "game_return")
        db.prepare(
          "UPDATE game_runtime_lease SET state='return_pending', lease_revision=lease_revision+1 WHERE continuity_id=?",
        ).run(input.continuityId);
      if (input.kind === "game_recovery") validateRecoveryProof(db, input, previousRuntimeOwnerVerifier);
    }
    db.prepare(
      "INSERT INTO game_command_intent VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
    ).run(
      input.continuityId,
      input.operationId,
      input.kind,
      digest,
      input.gameSessionId,
      input.bindingDigest,
      canonicalJson(input.origin),
      canonicalJson(input.world),
      fence,
      token,
      input.deadlineAtMs,
      input.expectedPartitionRevision,
      input.expectedGameRevision,
      input.expectedLeaseRevision,
      input.expectedSelectionRevision,
      input.runtimeInstanceId,
      input.ownerPid,
      input.ownerProcessStartIdentity,
    );
    db.prepare("UPDATE continuity_partition SET revision=?, fence_epoch=? WHERE continuity_id=?").run(
      p.revision + 1,
      fence,
      input.continuityId,
    );
    const preparedGameRevision = (
      db.prepare("SELECT game_revision FROM surface_session WHERE session_id=?").get(input.gameSessionId) as {
        game_revision: number;
      }
    ).game_revision;
    const preparedLeaseRevision = (
      db
        .prepare("SELECT lease_revision FROM game_runtime_lease WHERE continuity_id=? AND session_id=?")
        .get(input.continuityId, input.gameSessionId) as { lease_revision: number }
    ).lease_revision;
    db.prepare(
      "UPDATE game_command_intent SET prepared_partition_revision=?, prepared_game_revision=?, prepared_lease_revision=?, prepared_selection_revision=? WHERE continuity_id=? AND operation_id=?",
    ).run(
      p.revision + 1,
      preparedGameRevision,
      preparedLeaseRevision,
      selectionRevision(db, input.continuityId),
      input.continuityId,
      input.operationId,
    );
    return Object.freeze({
      permit: Object.freeze({
        kind: input.kind,
        continuityId: input.continuityId,
        operationId: input.operationId,
        payloadDigest: digest,
        gameSessionId: input.gameSessionId,
        origin: input.origin,
        world: input.world,
        bindingDigest: input.bindingDigest,
        fenceEpoch: fence,
        fenceToken: token,
        deadlineAtMs: input.deadlineAtMs,
        runtimeInstanceId: input.runtimeInstanceId,
        ownerPid: input.ownerPid,
        ownerProcessStartIdentity: input.ownerProcessStartIdentity,
      }),
      created: true,
    });
  });
}
function commitGameTerminal(db: DatabaseSync, input: GameTerminalCommand, now: number): GameCommandReadback {
  const supplied = input.permit;
  if (!validPermit(supplied) || !validPrincipal(input.principal)) throw commandError("invalid_command");
  const outcome = withImmediateTransaction(db, () => {
    const p = partition(db, supplied.continuityId);
    assertPrincipal(db, input.principal);
    const i = db
      .prepare("SELECT * FROM game_command_intent WHERE continuity_id=? AND operation_id=?")
      .get(supplied.continuityId, supplied.operationId) as Record<string, unknown> | undefined;
    const q = intentPermit(i);
    if (!q || !samePermit(supplied, q) || !samePrincipal(input.principal, q.origin))
      throw commandError("permit_conflict");
    const receiptDigest = canonicalReceiptDigest(input.receipt);
    if (i!.status === "terminal") {
      if (
        typeof i!.response_json !== "string" ||
        typeof i!.terminal_receipt_digest !== "string" ||
        i!.terminal_receipt_digest !== receiptDigest
      )
        throw commandError("permit_conflict");
      return { readback: Object.freeze(JSON.parse(i!.response_json)) as GameCommandReadback, error: null };
    }
    if (i!.status === "recovery_required") {
      if (
        !validRecoveryErrorCode(i!.recovery_error_code) ||
        !validRecoveryReason(i!.recovery_reason) ||
        typeof i!.response_json !== "string" ||
        typeof i!.terminal_receipt_digest !== "string" ||
        i!.terminal_receipt_digest !== receiptDigest
      )
        throw commandError("permit_conflict");
      return { readback: null, error: i!.recovery_error_code };
    }
    if (i!.status !== "pending") throw commandError("permit_conflict");
    const fail = (error: CommandErrorCode, reason: GameRecoveryReason) => {
      markRecovery(db, q, error, reason, receiptDigest);
      return { readback: null, error };
    };
    if (p.fence_epoch !== q.fenceEpoch) return fail("game_revision_conflict", "revision_or_fence_conflict");
    if (now > q.deadlineAtMs) return fail("deadline_expired", "deadline_expired");
    if (input.expectedFenceEpoch !== q.fenceEpoch) throw commandError("fence_conflict");
    if (!validReceipt(input.receipt, q, now) || !receiptMatchesLease(db, input.receipt, q))
      return fail("receipt_invalid", "receipt_invalid");
    if (
      p.revision !== input.expectedPartitionRevision ||
      gameRow(db, q).game_revision !== input.expectedGameRevision ||
      leaseRevision(db, q) !== input.expectedLeaseRevision ||
      selectionRevision(db, q.continuityId) !== input.expectedSelectionRevision
    )
      return fail("game_revision_conflict", "revision_or_fence_conflict");
    const expected =
      q.kind === "game_enter"
        ? "runtime_bootstrapped"
        : q.kind === "game_return"
          ? "runtime_torn_down"
          : q.kind === "lease_release"
            ? "lease_released"
            : "recovery_completed";
    if (input.receipt.kind !== expected) return fail("receipt_invalid", "receipt_invalid");
    if (q.kind === "game_enter") {
      db.prepare(
        "UPDATE surface_session SET state='active', updated_at_ms=?, game_revision=game_revision+1 WHERE session_id=?",
      ).run(now, q.gameSessionId);
      db.prepare("UPDATE surface_session SET state='suspended', updated_at_ms=? WHERE session_id=?").run(
        now,
        q.origin.chatSurfaceSessionId,
      );
    } else if (q.kind === "game_return") {
      db.prepare(
        "UPDATE surface_session SET state='ended', updated_at_ms=?, game_revision=game_revision+1 WHERE session_id=?",
      ).run(now, q.gameSessionId);
      db.prepare("UPDATE surface_session SET state='active', updated_at_ms=? WHERE session_id=?").run(
        now,
        q.origin.chatSurfaceSessionId,
      );
      db.prepare("DELETE FROM game_runtime_lease WHERE continuity_id=?").run(q.continuityId);
    } else if (q.kind === "lease_release") {
      markRecovery(db, q);
    } else {
      db.prepare(
        "UPDATE surface_session SET state='active', updated_at_ms=?, game_revision=game_revision+1 WHERE session_id=?",
      ).run(now, q.gameSessionId);
      db.prepare(
        "UPDATE game_runtime_lease SET owner_token=?, runtime_instance_id=?, owner_pid=?, owner_process_start_identity=?, state='owned' WHERE continuity_id=?",
      ).run(q.fenceToken, q.runtimeInstanceId, q.ownerPid, q.ownerProcessStartIdentity, q.continuityId);
    }
    db.prepare("UPDATE game_command_intent SET status='terminal' WHERE continuity_id=? AND operation_id=?").run(
      q.continuityId,
      q.operationId,
    );
    db.prepare("UPDATE continuity_partition SET revision=?, fence_epoch=? WHERE continuity_id=?").run(
      p.revision + 1,
      p.fence_epoch + 1,
      q.continuityId,
    );
    const r = gameReadback(db, q);
    db.prepare(
      "UPDATE game_command_intent SET response_json=?, terminal_receipt_digest=? WHERE continuity_id=? AND operation_id=?",
    ).run(canonicalJson(r), receiptDigest, q.continuityId, q.operationId);
    return { readback: r, error: null };
  });
  if (outcome.error) throw commandError(outcome.error);
  return outcome.readback!;
}
function abortGameCommand(
  db: DatabaseSync,
  input: Readonly<{ principal: AuthenticatedContinuityPrincipal; permit: GamePermit; expectedFenceEpoch: number }>,
): GameCommandReadback {
  return abortGameOperation(
    db,
    { principal: input.principal, permit: input.permit, reason: "cancelled" },
    input.expectedFenceEpoch,
  );
}
function partition(db: DatabaseSync, c: string): { revision: number; fence_epoch: number } {
  const p = db
    .prepare("SELECT revision,fence_epoch,authority_state FROM continuity_partition WHERE continuity_id=?")
    .get(c) as { revision: number; fence_epoch: number; authority_state: unknown } | undefined;
  if (!p) throw commandError("continuity_not_found");
  if (p.authority_state === "semantic_quarantined_abandoned_mutex") throw commandError("partition_quarantined");
  if (p.authority_state !== "semantic_active" && p.authority_state !== "adopted")
    throw commandError("partition_quarantined");
  if (hasTable(db, "production_continuity_bootstrap") && p.authority_state !== "semantic_active")
    throw commandError("partition_quarantined");
  return p;
}
function markAbandonedMutexQuarantine(
  db: DatabaseSync,
  input: Readonly<{ principal: AuthenticatedContinuityPrincipal }>,
): Readonly<{
  continuityId: string;
  authorityState: "semantic_quarantined_abandoned_mutex";
  revision: number;
  fenceEpoch: number;
}> {
  if (!validPrincipal(input.principal)) throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    assertPrincipal(db, input.principal);
    const row = db
      .prepare("SELECT revision,fence_epoch,authority_state FROM continuity_partition WHERE continuity_id=?")
      .get(input.principal.continuityId) as
      | { revision: unknown; fence_epoch: unknown; authority_state: unknown }
      | undefined;
    if (!row) throw commandError("continuity_not_found");
    if (row.authority_state === "semantic_quarantined_abandoned_mutex") {
      if (!positiveRevision(row.revision) || !positiveRevision(row.fence_epoch))
        throw commandError("partition_quarantined");
      return Object.freeze({
        continuityId: input.principal.continuityId,
        authorityState: "semantic_quarantined_abandoned_mutex" as const,
        revision: row.revision,
        fenceEpoch: row.fence_epoch,
      });
    }
    if (
      row.authority_state !== "semantic_active" ||
      !positiveRevision(row.revision) ||
      !positiveRevision(row.fence_epoch)
    )
      throw commandError("partition_quarantined");
    db.prepare(
      "UPDATE continuity_partition SET authority_state='semantic_quarantined_abandoned_mutex', revision=?, fence_epoch=? WHERE continuity_id=? AND authority_state='semantic_active'",
    ).run(row.revision + 1, row.fence_epoch + 1, input.principal.continuityId);
    const reread = db
      .prepare("SELECT revision,fence_epoch,authority_state FROM continuity_partition WHERE continuity_id=?")
      .get(input.principal.continuityId) as
      | { revision: unknown; fence_epoch: unknown; authority_state: unknown }
      | undefined;
    if (
      !reread ||
      reread.authority_state !== "semantic_quarantined_abandoned_mutex" ||
      reread.revision !== row.revision + 1 ||
      reread.fence_epoch !== row.fence_epoch + 1
    )
      throw commandError("partition_quarantined");
    return Object.freeze({
      continuityId: input.principal.continuityId,
      authorityState: "semantic_quarantined_abandoned_mutex" as const,
      revision: reread.revision as number,
      fenceEpoch: reread.fence_epoch as number,
    });
  });
}
function validPrincipal(p: unknown): p is AuthenticatedContinuityPrincipal {
  return (
    !!p &&
    typeof p === "object" &&
    opaque((p as AuthenticatedContinuityPrincipal).continuityId) &&
    opaque((p as AuthenticatedContinuityPrincipal).companionId) &&
    opaque((p as AuthenticatedContinuityPrincipal).playerId)
  );
}
function samePrincipal(
  p: AuthenticatedContinuityPrincipal,
  v: Readonly<{ continuityId: string; companionId: string; playerId: string }>,
): boolean {
  return p.continuityId === v.continuityId && p.companionId === v.companionId && p.playerId === v.playerId;
}
function assertPrincipal(db: DatabaseSync, p: AuthenticatedContinuityPrincipal): void {
  if (!validPrincipal(p)) throw commandError("invalid_command");
  if (
    !db
      .prepare("SELECT 1 FROM continuity_partition WHERE continuity_id=? AND companion_id=? AND player_id=?")
      .get(p.continuityId, p.companionId, p.playerId)
  )
    throw commandError("exact_principal_required");
}
function gameRow(db: DatabaseSync, q: GameCommand | GamePermit): Record<string, any> {
  const g = db
    .prepare("SELECT * FROM surface_session WHERE continuity_id=? AND session_id=? AND surface='game'")
    .get(q.continuityId, q.gameSessionId) as Record<string, any> | undefined;
  if (
    !g ||
    g.origin_chat_thread_id !== q.origin.chatThreadId ||
    g.origin_chat_surface_session_id !== q.origin.chatSurfaceSessionId ||
    g.player_id !== q.origin.playerId ||
    g.companion_id !== q.origin.companionId ||
    g.world_id !== q.world.worldId ||
    g.save_id !== q.world.saveId ||
    g.integration_id !== q.world.integrationId
  )
    throw commandError("game_binding_conflict");
  return g;
}
function leaseRevision(db: DatabaseSync, q: GameCommand | GamePermit): number {
  const l = db
    .prepare("SELECT lease_revision,binding_digest FROM game_runtime_lease WHERE continuity_id=? AND session_id=?")
    .get(q.continuityId, q.gameSessionId) as { lease_revision: number; binding_digest: string } | undefined;
  if (!l || l.binding_digest !== q.bindingDigest) throw commandError("game_binding_conflict");
  return l.lease_revision;
}
function selectionRevision(db: DatabaseSync, c: string): number {
  return (
    (
      db.prepare("SELECT selection_revision FROM active_chat_selection WHERE continuity_id=?").get(c) as
        | { selection_revision: number }
        | undefined
    )?.selection_revision ?? 0
  );
}
function validateGameCurrent(db: DatabaseSync, q: GameCommand, p: { revision: number; fence_epoch: number }): void {
  if (p.revision !== q.expectedPartitionRevision) throw commandError("game_revision_conflict");
  if (p.fence_epoch !== q.expectedFenceEpoch) throw commandError("fence_conflict");
  if (selectionRevision(db, q.continuityId) !== q.expectedSelectionRevision)
    throw commandError("selection_revision_conflict");
  if (q.kind !== "game_enter") {
    const g = gameRow(db, q);
    if (g.game_revision !== q.expectedGameRevision) throw commandError("game_revision_conflict");
    if (leaseRevision(db, q) !== q.expectedLeaseRevision) throw commandError("lease_revision_conflict");
  }
}
function validateGameCommand(q: GameCommand, now: number): void {
  if (
    !["game_enter", "game_return", "lease_release", "game_recovery"].includes(q.kind) ||
    !opaque(q.continuityId) ||
    !opaque(q.operationId) ||
    !opaque(q.gameSessionId) ||
    !validPrincipal(q.principal) ||
    q.principal.continuityId !== q.continuityId ||
    !samePrincipal(q.principal, q.origin) ||
    !validOrigin(q.origin, q.continuityId) ||
    !validWorld(q.world) ||
    !hash(q.bindingDigest) ||
    !opaque(q.runtimeInstanceId) ||
    !Number.isSafeInteger(q.ownerPid) ||
    q.ownerPid <= 0 ||
    !opaque(q.ownerProcessStartIdentity) ||
    !positiveRevision(q.expectedPartitionRevision) ||
    !nonNegativeRevision(q.expectedGameRevision) ||
    !nonNegativeRevision(q.expectedLeaseRevision) ||
    !nonNegativeRevision(q.expectedSelectionRevision) ||
    !positiveRevision(q.expectedFenceEpoch) ||
    !timestamp(q.deadlineAtMs) ||
    q.deadlineAtMs <= now ||
    (q.recoveryRequestId !== undefined && !opaque(q.recoveryRequestId))
  )
    throw commandError("invalid_command");
}
function intentPermit(i: Record<string, unknown> | undefined): GamePermit | null {
  if (
    !i ||
    typeof i.kind !== "string" ||
    typeof i.continuity_id !== "string" ||
    typeof i.operation_id !== "string" ||
    typeof i.payload_digest !== "string" ||
    typeof i.game_session_id !== "string" ||
    typeof i.binding_digest !== "string" ||
    typeof i.fence_epoch !== "number" ||
    typeof i.fence_token !== "string" ||
    typeof i.deadline_at_ms !== "number" ||
    typeof i.runtime_instance_id !== "string" ||
    typeof i.owner_pid !== "number" ||
    typeof i.owner_process_start_identity !== "string" ||
    typeof i.origin_json !== "string" ||
    typeof i.world_json !== "string"
  )
    return null;
  try {
    const q: GamePermit = {
      kind: i.kind as GameCommandKind,
      continuityId: i.continuity_id,
      operationId: i.operation_id,
      payloadDigest: i.payload_digest,
      gameSessionId: i.game_session_id,
      origin: JSON.parse(i.origin_json),
      world: JSON.parse(i.world_json),
      bindingDigest: i.binding_digest,
      fenceEpoch: i.fence_epoch,
      fenceToken: i.fence_token,
      deadlineAtMs: i.deadline_at_ms,
      runtimeInstanceId: i.runtime_instance_id,
      ownerPid: i.owner_pid,
      ownerProcessStartIdentity: i.owner_process_start_identity,
    };
    return validPermit(q) ? Object.freeze(q) : null;
  } catch {
    return null;
  }
}
function samePermit(a: GamePermit, b: GamePermit): boolean {
  return (
    a.kind === b.kind &&
    a.continuityId === b.continuityId &&
    a.operationId === b.operationId &&
    a.payloadDigest === b.payloadDigest &&
    a.gameSessionId === b.gameSessionId &&
    same(a.origin, b.origin) &&
    same(a.world, b.world) &&
    a.bindingDigest === b.bindingDigest &&
    a.fenceEpoch === b.fenceEpoch &&
    a.fenceToken === b.fenceToken &&
    a.deadlineAtMs === b.deadlineAtMs &&
    a.runtimeInstanceId === b.runtimeInstanceId &&
    a.ownerPid === b.ownerPid &&
    a.ownerProcessStartIdentity === b.ownerProcessStartIdentity
  );
}
function sameDurableOwner(a: DurablePreviousRuntimeOwner, b: DurablePreviousRuntimeOwner): boolean {
  return (
    a.ownerToken === b.ownerToken &&
    a.runtimeInstanceId === b.runtimeInstanceId &&
    a.ownerPid === b.ownerPid &&
    a.ownerProcessStartIdentity === b.ownerProcessStartIdentity
  );
}
function trustedPreviousRuntimeOwnerVerification(result: unknown): result is PreviousRuntimeOwnerVerificationResult {
  if (
    !result ||
    typeof result !== "object" ||
    !factoryCreatedPreviousRuntimeOwnerVerifications.has(result) ||
    !Object.isFrozen(result)
  )
    return false;
  if (
    Object.getOwnPropertySymbols(result).length !== 0 ||
    Object.getOwnPropertyNames(result).length !== 2 ||
    !Object.hasOwn(result, "status") ||
    !Object.hasOwn(result, "owner")
  )
    return false;
  const { status, owner } = result as PreviousRuntimeOwnerVerificationResult;
  if (status === "unavailable") return owner === null;
  const validOwner =
    typeof owner === "object" &&
    owner !== null &&
    Object.isFrozen(owner) &&
    Object.getOwnPropertySymbols(owner).length === 0 &&
    Object.getOwnPropertyNames(owner).length === 4 &&
    Object.hasOwn(owner, "ownerToken") &&
    Object.hasOwn(owner, "runtimeInstanceId") &&
    Object.hasOwn(owner, "ownerPid") &&
    Object.hasOwn(owner, "ownerProcessStartIdentity") &&
    opaque(owner.ownerToken) &&
    opaque(owner.runtimeInstanceId) &&
    Number.isSafeInteger(owner.ownerPid) &&
    owner.ownerPid > 0 &&
    opaque(owner.ownerProcessStartIdentity);
  if (status === "proven_dead" || status === "alive") return validOwner;
  return (status === "ambiguous" || status === "mismatch") && (owner === null || validOwner);
}
function validateRecoveryProof(
  db: DatabaseSync,
  q: GameCommand,
  verifier: PreviousRuntimeOwnerVerifier | undefined,
): void {
  const l = db
    .prepare(
      "SELECT owner_token,runtime_instance_id,owner_pid,owner_process_start_identity FROM game_runtime_lease WHERE continuity_id=? AND session_id=?",
    )
    .get(q.continuityId, q.gameSessionId) as Record<string, unknown> | undefined;
  if (
    !l ||
    !opaque(l.owner_token) ||
    !opaque(l.runtime_instance_id) ||
    !Number.isSafeInteger(l.owner_pid) ||
    !opaque(l.owner_process_start_identity)
  )
    throw commandError("game_transition_invalid");
  const ownerPid = l.owner_pid as number;
  if (ownerPid <= 0) throw commandError("game_transition_invalid");
  const durableOwner: DurablePreviousRuntimeOwner = Object.freeze({
    ownerToken: l.owner_token,
    runtimeInstanceId: l.runtime_instance_id,
    ownerPid,
    ownerProcessStartIdentity: l.owner_process_start_identity,
  });
  let result: PreviousRuntimeOwnerVerificationResult;
  try {
    if (!verifier) throw new Error("unavailable");
    result = verifier.verifyPreviousRuntimeOwner(durableOwner);
    if (!result || typeof (result as { then?: unknown }).then === "function")
      throw new Error("asynchronous_verifier_rejected");
  } catch {
    throw commandError("game_transition_invalid");
  }
  if (
    !trustedPreviousRuntimeOwnerVerification(result) ||
    result.status !== "proven_dead" ||
    !sameDurableOwner(result.owner, durableOwner)
  )
    throw commandError("game_transition_invalid");
  if (
    q.runtimeInstanceId === durableOwner.runtimeInstanceId &&
    q.ownerPid === durableOwner.ownerPid &&
    q.ownerProcessStartIdentity === durableOwner.ownerProcessStartIdentity
  )
    throw commandError("game_transition_invalid");
}
function permitFrom(q: GameCommand, digest: string, i: Record<string, unknown>): GamePermit {
  return Object.freeze({
    kind: q.kind,
    continuityId: q.continuityId,
    operationId: q.operationId,
    payloadDigest: digest,
    gameSessionId: q.gameSessionId,
    origin: q.origin,
    world: q.world,
    bindingDigest: q.bindingDigest,
    fenceEpoch: i.fence_epoch as number,
    fenceToken: i.fence_token as string,
    deadlineAtMs: i.deadline_at_ms as number,
    runtimeInstanceId: i.runtime_instance_id as string,
    ownerPid: i.owner_pid as number,
    ownerProcessStartIdentity: i.owner_process_start_identity as string,
  });
}
function validPermit(q: GamePermit): boolean {
  return (
    opaque(q.continuityId) &&
    opaque(q.operationId) &&
    hash(q.payloadDigest) &&
    opaque(q.gameSessionId) &&
    validOrigin(q.origin, q.continuityId) &&
    validWorld(q.world) &&
    hash(q.bindingDigest) &&
    positiveRevision(q.fenceEpoch) &&
    opaque(q.fenceToken) &&
    timestamp(q.deadlineAtMs) &&
    opaque(q.runtimeInstanceId) &&
    Number.isSafeInteger(q.ownerPid) &&
    q.ownerPid > 0 &&
    opaque(q.ownerProcessStartIdentity)
  );
}
function validReceipt(r: GameTerminalReceipt, q: GamePermit, now: number): boolean {
  return (
    !!r &&
    opaque(r.operationId) &&
    r.operationId === q.operationId &&
    r.gameSessionId === q.gameSessionId &&
    r.bindingDigest === q.bindingDigest &&
    same(r.origin, q.origin) &&
    same(r.world, q.world) &&
    opaque(r.runtimeInstanceId) &&
    Number.isSafeInteger(r.ownerPid) &&
    r.ownerPid > 0 &&
    opaque(r.ownerProcessStartIdentity) &&
    timestamp(r.occurredAtMs) &&
    r.occurredAtMs <= now &&
    r.occurredAtMs <= q.deadlineAtMs
  );
}
function receiptMatchesLease(db: DatabaseSync, r: GameTerminalReceipt, q: GamePermit): boolean {
  if (q.kind === "game_recovery")
    return (
      r.runtimeInstanceId === q.runtimeInstanceId &&
      r.ownerPid === q.ownerPid &&
      r.ownerProcessStartIdentity === q.ownerProcessStartIdentity
    );
  const l = db
    .prepare(
      "SELECT binding_digest,runtime_instance_id,owner_pid,owner_process_start_identity FROM game_runtime_lease WHERE continuity_id=? AND session_id=?",
    )
    .get(q.continuityId, q.gameSessionId) as Record<string, unknown> | undefined;
  return (
    !!l &&
    l.binding_digest === q.bindingDigest &&
    l.runtime_instance_id === r.runtimeInstanceId &&
    l.owner_pid === r.ownerPid &&
    l.owner_process_start_identity === r.ownerProcessStartIdentity
  );
}
function markRecovery(
  db: DatabaseSync,
  q: GamePermit,
  errorCode?: CommandErrorCode,
  reason?: GameRecoveryReason,
  receiptDigest?: string | null,
): void {
  db.prepare(
    "UPDATE surface_session SET state='recovery_required', game_revision=game_revision+1 WHERE session_id=?",
  ).run(q.gameSessionId);
  db.prepare(
    "UPDATE game_runtime_lease SET state='recovery_required', lease_revision=lease_revision+1 WHERE continuity_id=?",
  ).run(q.continuityId);
  if (!reason) return;
  const readback = recoveryReadback(db, q, reason, errorCode!);
  db.prepare(
    "UPDATE game_command_intent SET status='recovery_required', recovery_error_code=?, recovery_reason=?, response_json=?, final_partition_revision=?, final_game_revision=?, final_lease_revision=?, final_selection_revision=?, final_fence_epoch=?, terminal_receipt_digest=? WHERE continuity_id=? AND operation_id=?",
  ).run(
    errorCode!,
    reason,
    canonicalJson(readback),
    readback.recoveryFacts!.final.partitionRevision,
    readback.recoveryFacts!.final.gameRevision,
    readback.recoveryFacts!.final.leaseRevision,
    readback.recoveryFacts!.final.selectionRevision,
    readback.recoveryFacts!.final.fenceEpoch,
    receiptDigest ?? null,
    q.continuityId,
    q.operationId,
  );
}
function recoveryReadback(
  db: DatabaseSync,
  q: GamePermit,
  reason: GameRecoveryReason,
  errorCode: CommandErrorCode,
): GameCommandReadback {
  const base = gameReadback(db, q);
  const i = db
    .prepare(
      "SELECT prepared_partition_revision,prepared_game_revision,prepared_lease_revision,prepared_selection_revision,fence_epoch FROM game_command_intent WHERE continuity_id=? AND operation_id=?",
    )
    .get(q.continuityId, q.operationId) as Record<string, number>;
  const prepared = Object.freeze({
    partitionRevision: i.prepared_partition_revision,
    gameRevision: i.prepared_game_revision,
    leaseRevision: i.prepared_lease_revision,
    selectionRevision: i.prepared_selection_revision,
    fenceEpoch: i.fence_epoch,
  });
  const final = Object.freeze({
    partitionRevision: base.revision,
    gameRevision: gameRow(db, q).game_revision as number,
    leaseRevision: leaseRevision(db, q),
    selectionRevision: selectionRevision(db, q.continuityId),
    fenceEpoch: base.fenceEpoch,
  });
  return Object.freeze({
    ...base,
    status: "recovery_required",
    recoveryReason: reason,
    recoveryErrorCode: errorCode,
    recoveryFacts: Object.freeze({ prepared, final }),
  });
}
function gameReadback(db: DatabaseSync, q: GamePermit): GameCommandReadback {
  const p = partition(db, q.continuityId),
    g = gameRow(db, q),
    o = db.prepare("SELECT state FROM surface_session WHERE session_id=?").get(q.origin.chatSurfaceSessionId) as {
      state: string;
    },
    l = db.prepare("SELECT state FROM game_runtime_lease WHERE continuity_id=?").get(q.continuityId) as
      | { state: ContinuityLease["state"] }
      | undefined;
  return Object.freeze({
    continuityId: q.continuityId,
    revision: p.revision,
    fenceEpoch: p.fence_epoch,
    operationId: q.operationId,
    gameSessionId: q.gameSessionId,
    gameState: g.state,
    originChatState: o.state,
    leaseState: l?.state ?? null,
    pending: false,
    status: "terminal",
    abortReason: null,
  });
}

function sagaReadback(db: DatabaseSync, continuityId: string): InitialChatSagaReadback {
  const p = partition(db, continuityId);
  const row = db.prepare("SELECT * FROM initial_chat_saga WHERE continuity_id=?").get(continuityId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw commandError("continuity_not_found");
  const selection = db
    .prepare(
      "SELECT chat_thread_id,chat_surface_session_id,selection_revision FROM active_chat_selection WHERE continuity_id=?",
    )
    .get(continuityId) as Record<string, unknown> | undefined;
  return Object.freeze({
    continuityId,
    revision: p.revision,
    fenceEpoch: p.fence_epoch,
    activeSelection: selection
      ? Object.freeze({
          chatThreadId: selection.chat_thread_id as string,
          chatSurfaceSessionId: selection.chat_surface_session_id as string,
          selectionRevision: selection.selection_revision as number,
        })
      : null,
    phase: row.phase as InitialChatSagaReadback["phase"],
    sagaId: row.saga_id as string,
    payloadDigest: row.payload_digest as string,
    claimToken: row.claim_token as string,
    chatThreadId: row.chat_thread_id as string | null,
    chatSurfaceSessionId: row.chat_surface_session_id as string | null,
    contentBindingDigest: row.content_binding_digest as string | null,
  });
}
function validSagaBase(
  input: Readonly<{ principal: AuthenticatedContinuityPrincipal; sagaId: string; payloadDigest: string }>,
): boolean {
  return validPrincipal(input.principal) && opaque(input.sagaId) && hash(input.payloadDigest);
}
function sagaRow(
  db: DatabaseSync,
  input: Readonly<{
    principal: AuthenticatedContinuityPrincipal;
    sagaId: string;
    payloadDigest: string;
    claimToken?: string;
  }>,
): Record<string, unknown> {
  assertPrincipal(db, input.principal);
  const row = db.prepare("SELECT * FROM initial_chat_saga WHERE continuity_id=?").get(input.principal.continuityId) as
    | Record<string, unknown>
    | undefined;
  if (
    !row ||
    row.saga_id !== input.sagaId ||
    row.payload_digest !== input.payloadDigest ||
    (input.claimToken !== undefined && row.claim_token !== input.claimToken)
  )
    throw commandError("operation_payload_conflict");
  return row;
}
function claimInitialChatSaga(db: DatabaseSync, input: InitialChatSagaClaim): InitialChatSagaReadback {
  if (
    !validSagaBase(input) ||
    !positiveRevision(input.expectedPartitionRevision) ||
    !positiveRevision(input.expectedFenceEpoch)
  )
    throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    assertPrincipal(db, input.principal);
    const existing = db
      .prepare("SELECT saga_id,payload_digest FROM initial_chat_saga WHERE continuity_id=?")
      .get(input.principal.continuityId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.saga_id !== input.sagaId || existing.payload_digest !== input.payloadDigest)
        throw commandError("operation_payload_conflict");
      return sagaReadback(db, input.principal.continuityId);
    }
    const p = partition(db, input.principal.continuityId);
    if (p.revision !== input.expectedPartitionRevision) throw commandError("game_revision_conflict");
    if (p.fence_epoch !== input.expectedFenceEpoch) throw commandError("fence_conflict");
    if (
      db
        .prepare(
          "SELECT 1 FROM continuity_thread WHERE continuity_id=? UNION ALL SELECT 1 FROM active_chat_selection WHERE continuity_id=? UNION ALL SELECT 1 FROM surface_session WHERE continuity_id=? AND surface='game' AND state!='ended'",
        )
        .get(input.principal.continuityId, input.principal.continuityId, input.principal.continuityId)
    )
      throw commandError("lifecycle_transition_invalid");
    db.prepare("INSERT INTO initial_chat_saga VALUES (?,?,?,?, 'claimed_empty',NULL,NULL,NULL)").run(
      input.principal.continuityId,
      input.sagaId,
      input.payloadDigest,
      randomUUID(),
    );
    db.prepare("UPDATE continuity_partition SET revision=?,fence_epoch=? WHERE continuity_id=?").run(
      p.revision + 1,
      p.fence_epoch + 1,
      input.principal.continuityId,
    );
    return sagaReadback(db, input.principal.continuityId);
  });
}
function registerInitialChatSagaChat(
  db: DatabaseSync,
  input: InitialChatSagaChatRegistration,
  now: number,
): InitialChatSagaReadback {
  if (
    !validSagaBase(input) ||
    !opaque(input.claimToken) ||
    !opaque(input.chatThreadId) ||
    !opaque(input.chatSurfaceSessionId) ||
    !positiveRevision(input.expectedPartitionRevision) ||
    !positiveRevision(input.expectedFenceEpoch)
  )
    throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    const row = sagaRow(db, input);
    if (row.phase !== "claimed_empty") {
      if (row.chat_thread_id === input.chatThreadId && row.chat_surface_session_id === input.chatSurfaceSessionId)
        return sagaReadback(db, input.principal.continuityId);
      throw commandError("operation_payload_conflict");
    }
    const p = partition(db, input.principal.continuityId);
    if (p.revision !== input.expectedPartitionRevision) throw commandError("game_revision_conflict");
    if (p.fence_epoch !== input.expectedFenceEpoch) throw commandError("fence_conflict");
    if (
      db
        .prepare(
          "SELECT 1 FROM continuity_thread WHERE chat_surface_session_id=? OR (continuity_id=? AND chat_thread_id=?)",
        )
        .get(input.chatSurfaceSessionId, input.principal.continuityId, input.chatThreadId)
    )
      throw commandError("exact_chat_binding_required");
    db.prepare(
      "INSERT INTO surface_session VALUES (?, ?, 'chat', 'suspended', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)",
    ).run(
      input.chatSurfaceSessionId,
      input.principal.continuityId,
      now,
      now,
      input.chatThreadId,
      input.principal.playerId,
      input.principal.companionId,
    );
    db.prepare("INSERT INTO continuity_thread VALUES (?, ?, ?, ?, 'active')").run(
      input.chatSurfaceSessionId,
      input.principal.continuityId,
      input.chatThreadId,
      input.principal.companionId,
    );
    db.prepare("INSERT INTO chat_lifecycle_metadata VALUES (?,1,NULL)").run(input.chatSurfaceSessionId);
    db.prepare("INSERT INTO continuity_event VALUES (?,?,'session_created',?,'chat',?)").run(
      randomUUID(),
      input.principal.continuityId,
      input.chatSurfaceSessionId,
      now,
    );
    db.prepare(
      "UPDATE initial_chat_saga SET phase='chat_registered',chat_thread_id=?,chat_surface_session_id=? WHERE continuity_id=?",
    ).run(input.chatThreadId, input.chatSurfaceSessionId, input.principal.continuityId);
    db.prepare("UPDATE continuity_partition SET revision=?,fence_epoch=? WHERE continuity_id=?").run(
      p.revision + 1,
      p.fence_epoch + 1,
      input.principal.continuityId,
    );
    return sagaReadback(db, input.principal.continuityId);
  });
}
function verifyInitialChatSagaContent(
  db: DatabaseSync,
  input: InitialChatSagaContentVerification,
): InitialChatSagaReadback {
  if (!validSagaBase(input) || !opaque(input.claimToken) || !hash(input.contentBindingDigest))
    throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    const row = sagaRow(db, input);
    if (row.phase === "content_verified" || row.phase === "selected") {
      if (row.content_binding_digest === input.contentBindingDigest)
        return sagaReadback(db, input.principal.continuityId);
      throw commandError("operation_payload_conflict");
    }
    if (row.phase !== "chat_registered") throw commandError("lifecycle_transition_invalid");
    db.prepare(
      "UPDATE initial_chat_saga SET phase='content_verified',content_binding_digest=? WHERE continuity_id=?",
    ).run(input.contentBindingDigest, input.principal.continuityId);
    return sagaReadback(db, input.principal.continuityId);
  });
}
function selectInitialChatSagaChat(
  db: DatabaseSync,
  input: InitialChatSagaSelection,
  now: number,
): InitialChatSagaReadback {
  if (
    !validSagaBase(input) ||
    !opaque(input.claimToken) ||
    !opaque(input.chatThreadId) ||
    !opaque(input.chatSurfaceSessionId) ||
    !positiveRevision(input.expectedPartitionRevision) ||
    !nonNegativeRevision(input.expectedSelectionRevision) ||
    !positiveRevision(input.expectedFenceEpoch)
  )
    throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    const row = sagaRow(db, input);
    if (row.phase === "selected") {
      if (row.chat_thread_id === input.chatThreadId && row.chat_surface_session_id === input.chatSurfaceSessionId)
        return sagaReadback(db, input.principal.continuityId);
      throw commandError("operation_payload_conflict");
    }
    if (
      row.phase !== "content_verified" ||
      row.chat_thread_id !== input.chatThreadId ||
      row.chat_surface_session_id !== input.chatSurfaceSessionId
    )
      throw commandError("lifecycle_transition_invalid");
    const p = partition(db, input.principal.continuityId);
    if (p.revision !== input.expectedPartitionRevision) throw commandError("game_revision_conflict");
    if (p.fence_epoch !== input.expectedFenceEpoch) throw commandError("fence_conflict");
    if (
      db
        .prepare("SELECT 1 FROM surface_session WHERE continuity_id=? AND surface='game' AND state!='ended'")
        .get(input.principal.continuityId)
    )
      throw commandError("game_transition_invalid");
    const selection = db
      .prepare("SELECT selection_revision FROM active_chat_selection WHERE continuity_id=?")
      .get(input.principal.continuityId) as { selection_revision: number } | undefined;
    if ((selection?.selection_revision ?? 0) !== input.expectedSelectionRevision)
      throw commandError("selection_revision_conflict");
    const surface = db
      .prepare("SELECT state FROM surface_session WHERE session_id=? AND continuity_id=?")
      .get(input.chatSurfaceSessionId, input.principal.continuityId) as { state: string } | undefined;
    if (!surface || surface.state !== "suspended") throw commandError("lifecycle_transition_invalid");
    db.prepare("UPDATE surface_session SET state='active',updated_at_ms=? WHERE session_id=?").run(
      now,
      input.chatSurfaceSessionId,
    );
    db.prepare("INSERT INTO active_chat_selection VALUES (?,?,?,?)").run(
      input.principal.continuityId,
      input.chatThreadId,
      input.chatSurfaceSessionId,
      1,
    );
    db.prepare("UPDATE initial_chat_saga SET phase='selected' WHERE continuity_id=?").run(input.principal.continuityId);
    db.prepare("UPDATE continuity_partition SET revision=?,fence_epoch=? WHERE continuity_id=?").run(
      p.revision + 1,
      p.fence_epoch + 1,
      input.principal.continuityId,
    );
    return sagaReadback(db, input.principal.continuityId);
  });
}
function readInitialChatSaga(
  db: DatabaseSync,
  input: Readonly<{ principal: AuthenticatedContinuityPrincipal; sagaId: string }>,
): InitialChatSagaReadback | null {
  if (!validPrincipal(input.principal) || !opaque(input.sagaId)) throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    assertPrincipal(db, input.principal);
    const row = db
      .prepare("SELECT saga_id FROM initial_chat_saga WHERE continuity_id=?")
      .get(input.principal.continuityId) as { saga_id: string } | undefined;
    if (!row) return null;
    if (row.saga_id !== input.sagaId) throw commandError("operation_payload_conflict");
    return sagaReadback(db, input.principal.continuityId);
  });
}

function registerExactChat(db: DatabaseSync, input: RegisterExactChatCommand, now: number): ChatCommandReadback {
  validateRegisterCommand(input);
  const digest = canonicalSha256(input);
  return withImmediateTransaction(db, () => {
    const p = partition(db, input.continuityId);
    assertPrincipal(db, input.principal);
    const existing = db
      .prepare(
        "SELECT command_kind,payload_digest,response_json FROM continuity_command WHERE continuity_id=? AND operation_id=?",
      )
      .get(input.continuityId, input.operationId) as
      | { command_kind: string; payload_digest: string; response_json: string }
      | undefined;
    if (existing) {
      if (existing.command_kind !== "register_exact" || existing.payload_digest !== digest)
        throw commandError("operation_payload_conflict");
      return freezeReadback(JSON.parse(existing.response_json));
    }
    if (p.revision !== input.expectedPartitionRevision) throw commandError("game_revision_conflict");
    if (p.fence_epoch !== input.expectedFenceEpoch) throw commandError("fence_conflict");
    if (
      db
        .prepare(
          "SELECT 1 FROM continuity_thread WHERE chat_surface_session_id=? OR (continuity_id=? AND chat_thread_id=?)",
        )
        .get(input.chatSurfaceSessionId, input.continuityId, input.chatThreadId)
    )
      throw commandError("exact_chat_binding_required");
    db.prepare(
      "INSERT INTO surface_session VALUES (?, ?, 'chat', 'suspended', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)",
    ).run(
      input.chatSurfaceSessionId,
      input.continuityId,
      now,
      now,
      input.chatThreadId,
      input.playerId,
      input.companionId,
    );
    db.prepare("INSERT INTO continuity_thread VALUES (?, ?, ?, ?, 'active')").run(
      input.chatSurfaceSessionId,
      input.continuityId,
      input.chatThreadId,
      input.companionId,
    );
    db.prepare("INSERT INTO chat_lifecycle_metadata VALUES (?,1,NULL)").run(input.chatSurfaceSessionId);
    db.prepare("INSERT INTO continuity_event VALUES (?,?,'session_created',?,'chat',?)").run(
      randomUUID(),
      input.continuityId,
      input.chatSurfaceSessionId,
      now,
    );
    db.prepare("UPDATE continuity_partition SET revision=?,fence_epoch=? WHERE continuity_id=?").run(
      p.revision + 1,
      p.fence_epoch + 1,
      input.continuityId,
    );
    const result = readCommandReadback(db, input.continuityId, input.chatSurfaceSessionId, input.operationId);
    db.prepare("INSERT INTO continuity_command VALUES (?,?,'register_exact',?,?)").run(
      input.continuityId,
      input.operationId,
      digest,
      canonicalJson(result),
    );
    return result;
  });
}
function readChatCatalog(
  db: DatabaseSync,
  input: Readonly<{ principal: AuthenticatedContinuityPrincipal }>,
): SemanticChatCatalog {
  if (!validPrincipal(input.principal)) throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    assertPrincipal(db, input.principal);
    const p = partition(db, input.principal.continuityId);
    const s = db
      .prepare(
        "SELECT chat_thread_id,chat_surface_session_id,selection_revision FROM active_chat_selection WHERE continuity_id=?",
      )
      .get(input.principal.continuityId) as
      | { chat_thread_id: string; chat_surface_session_id: string; selection_revision: number }
      | undefined;
    const rows = db
      .prepare(
        "SELECT t.chat_thread_id,t.chat_surface_session_id,t.companion_id,t.lifecycle,m.management_revision FROM continuity_thread t JOIN chat_lifecycle_metadata m ON m.chat_surface_session_id=t.chat_surface_session_id WHERE t.continuity_id=? ORDER BY t.chat_surface_session_id",
      )
      .all(input.principal.continuityId) as Array<Record<string, unknown>>;
    return Object.freeze({
      continuityId: input.principal.continuityId,
      revision: p.revision,
      fenceEpoch: p.fence_epoch,
      activeSelection: s
        ? Object.freeze({
            chatThreadId: s.chat_thread_id,
            chatSurfaceSessionId: s.chat_surface_session_id,
            selectionRevision: s.selection_revision,
          })
        : null,
      threads: Object.freeze(
        rows.map((r) =>
          Object.freeze({
            chatThreadId: r.chat_thread_id as string,
            chatSurfaceSessionId: r.chat_surface_session_id as string,
            companionId: r.companion_id as string,
            lifecycle: r.lifecycle as "active" | "archived" | "trashed",
            managementRevision: r.management_revision as number,
          }),
        ),
      ),
    });
  });
}
function runChatCommand<T extends ChatSelectionCommand | ArchiveLifecycleCommand>(
  db: DatabaseSync,
  input: T,
  kind: "select_open" | "archive_lifecycle",
  validate: (input: T) => void,
  apply: (db: DatabaseSync, input: T) => void,
): ChatCommandReadback {
  validate(input);
  const digest = canonicalSha256(input);
  return withImmediateTransaction(db, () => {
    const partition = partitionForActiveCommand(db, input.continuityId);
    assertPrincipal(db, input.principal);
    const existing = db
      .prepare(
        "SELECT command_kind, payload_digest, response_json FROM continuity_command WHERE continuity_id = ? AND operation_id = ?",
      )
      .get(input.continuityId, input.operationId) as
      | { command_kind: string; payload_digest: string; response_json: string }
      | undefined;
    if (existing) {
      if (existing.command_kind !== kind || existing.payload_digest !== digest)
        throw commandError("operation_payload_conflict");
      return freezeReadback(JSON.parse(existing.response_json));
    }
    if (partition.fence_epoch !== input.expectedFenceEpoch) throw commandError("fence_conflict");
    if ("expectedPartitionRevision" in input && partition.revision !== input.expectedPartitionRevision)
      throw commandError("game_revision_conflict");
    apply(db, input);
    db.prepare("UPDATE continuity_partition SET revision = ?, fence_epoch = ? WHERE continuity_id = ?").run(
      partition.revision + 1,
      partition.fence_epoch + 1,
      input.continuityId,
    );
    const readback = readCommandReadback(db, input.continuityId, input.chatSurfaceSessionId, input.operationId);
    db.prepare("INSERT INTO continuity_command VALUES (?, ?, ?, ?, ?)").run(
      input.continuityId,
      input.operationId,
      kind,
      digest,
      canonicalJson(readback),
    );
    return readback;
  });
}
function partitionForActiveCommand(db: DatabaseSync, continuityId: string): { revision: number; fence_epoch: number } {
  return partition(db, continuityId);
}
function applySelection(db: DatabaseSync, input: ChatSelectionCommand): void {
  const thread = exactThread(db, input);
  if (thread.lifecycle !== "active") throw commandError("lifecycle_transition_invalid");
  const targetSurface = db
    .prepare("SELECT surface,state FROM surface_session WHERE session_id=? AND continuity_id=?")
    .get(input.chatSurfaceSessionId, input.continuityId) as { surface: string; state: string } | undefined;
  if (
    !targetSurface ||
    targetSurface.surface !== "chat" ||
    (targetSurface.state !== "active" && targetSurface.state !== "suspended")
  )
    throw commandError("lifecycle_transition_invalid");
  const blockingGame = db
    .prepare("SELECT 1 FROM surface_session WHERE continuity_id=? AND surface='game' AND state!='ended'")
    .get(input.continuityId);
  if (blockingGame) throw commandError("game_transition_invalid");
  const current = db
    .prepare("SELECT chat_surface_session_id,selection_revision FROM active_chat_selection WHERE continuity_id = ?")
    .get(input.continuityId) as { chat_surface_session_id: string; selection_revision: number } | undefined;
  const revision = current?.selection_revision ?? 0;
  if (revision !== input.expectedSelectionRevision) throw commandError("selection_revision_conflict");
  const now = Date.now();
  if (current && current.chat_surface_session_id !== input.chatSurfaceSessionId) {
    const prior = db
      .prepare("SELECT surface,state FROM surface_session WHERE session_id=? AND continuity_id=?")
      .get(current.chat_surface_session_id, input.continuityId) as { surface: string; state: string } | undefined;
    if (!prior || prior.surface !== "chat" || prior.state !== "active")
      throw commandError("lifecycle_transition_invalid");
    db.prepare(
      "UPDATE surface_session SET state='suspended',updated_at_ms=? WHERE session_id=? AND continuity_id=?",
    ).run(now, current.chat_surface_session_id, input.continuityId);
    db.prepare("INSERT INTO continuity_event VALUES (?,?,'surface_suspended',?,'chat',?)").run(
      randomUUID(),
      input.continuityId,
      current.chat_surface_session_id,
      now,
    );
  }
  if (targetSurface.state !== "active") {
    db.prepare("UPDATE surface_session SET state='active',updated_at_ms=? WHERE session_id=? AND continuity_id=?").run(
      now,
      input.chatSurfaceSessionId,
      input.continuityId,
    );
    db.prepare("INSERT INTO continuity_event VALUES (?,?,'surface_resumed',?,'chat',?)").run(
      randomUUID(),
      input.continuityId,
      input.chatSurfaceSessionId,
      now,
    );
  }
  db.prepare(
    "INSERT INTO active_chat_selection VALUES (?, ?, ?, ?) ON CONFLICT(continuity_id) DO UPDATE SET chat_thread_id=excluded.chat_thread_id, chat_surface_session_id=excluded.chat_surface_session_id, selection_revision=excluded.selection_revision",
  ).run(input.continuityId, thread.chat_thread_id, thread.chat_surface_session_id, revision + 1);
}
function applyArchiveLifecycle(db: DatabaseSync, input: ArchiveLifecycleCommand): void {
  const thread = exactThread(db, input);
  const metadata = db
    .prepare(
      "SELECT management_revision, trash_restore_lifecycle FROM chat_lifecycle_metadata WHERE chat_surface_session_id = ?",
    )
    .get(input.chatSurfaceSessionId) as
    | { management_revision: number; trash_restore_lifecycle: "active" | "archived" | null }
    | undefined;
  if (!metadata) throw commandError("exact_chat_binding_required");
  if (metadata.management_revision !== input.expectedManagementRevision)
    throw commandError("management_revision_conflict");
  const next = lifecycleTransition(thread.lifecycle, metadata.trash_restore_lifecycle, input.operation);
  if (!next) throw commandError("lifecycle_transition_invalid");
  const selection = db
    .prepare("SELECT chat_surface_session_id FROM active_chat_selection WHERE continuity_id=?")
    .get(input.continuityId) as { chat_surface_session_id: string } | undefined;
  if (selection?.chat_surface_session_id === input.chatSurfaceSessionId && next.lifecycle !== "active")
    throw commandError("lifecycle_transition_invalid");
  db.prepare("UPDATE continuity_thread SET lifecycle = ? WHERE chat_surface_session_id = ?").run(
    next.lifecycle,
    input.chatSurfaceSessionId,
  );
  db.prepare(
    "UPDATE chat_lifecycle_metadata SET management_revision = ?, trash_restore_lifecycle = ? WHERE chat_surface_session_id = ?",
  ).run(metadata.management_revision + 1, next.trashRestoreLifecycle, input.chatSurfaceSessionId);
}
function assertActiveSelectedGameOrigin(db: DatabaseSync, input: GameCommand): void {
  const thread = exactThread(db, {
    continuityId: input.continuityId,
    companionId: input.origin.companionId,
    chatThreadId: input.origin.chatThreadId,
    chatSurfaceSessionId: input.origin.chatSurfaceSessionId,
  });
  if (thread.lifecycle !== "active") throw commandError("game_transition_invalid");
  const surface = db
    .prepare("SELECT surface,state FROM surface_session WHERE session_id=? AND continuity_id=?")
    .get(input.origin.chatSurfaceSessionId, input.continuityId) as { surface: string; state: string } | undefined;
  if (!surface || surface.surface !== "chat" || surface.state !== "active")
    throw commandError("game_transition_invalid");
  const selection = db
    .prepare("SELECT chat_thread_id,chat_surface_session_id FROM active_chat_selection WHERE continuity_id=?")
    .get(input.continuityId) as { chat_thread_id: string; chat_surface_session_id: string } | undefined;
  if (
    !selection ||
    selection.chat_thread_id !== input.origin.chatThreadId ||
    selection.chat_surface_session_id !== input.origin.chatSurfaceSessionId
  )
    throw commandError("game_transition_invalid");
}
function exactThread(
  db: DatabaseSync,
  input: Readonly<{ continuityId: string; companionId: string; chatThreadId: string; chatSurfaceSessionId: string }>,
): {
  chat_thread_id: string;
  chat_surface_session_id: string;
  companion_id: string;
  lifecycle: "active" | "archived" | "trashed";
} {
  const row = db
    .prepare(
      "SELECT chat_thread_id, chat_surface_session_id, companion_id, lifecycle FROM continuity_thread WHERE continuity_id = ? AND chat_surface_session_id = ? AND chat_thread_id = ? AND companion_id = ?",
    )
    .get(input.continuityId, input.chatSurfaceSessionId, input.chatThreadId, input.companionId) as
    | {
        chat_thread_id: string;
        chat_surface_session_id: string;
        companion_id: string;
        lifecycle: "active" | "archived" | "trashed";
      }
    | undefined;
  if (!row) throw commandError("exact_chat_binding_required");
  return row;
}
function lifecycleTransition(
  current: "active" | "archived" | "trashed",
  restore: "active" | "archived" | null,
  operation: ArchiveLifecycleCommand["operation"],
): { lifecycle: "active" | "archived" | "trashed"; trashRestoreLifecycle: "active" | "archived" | null } | null {
  if (operation === "archive" && current === "active") return { lifecycle: "archived", trashRestoreLifecycle: null };
  if (operation === "trash" && (current === "active" || current === "archived"))
    return { lifecycle: "trashed", trashRestoreLifecycle: current };
  if (operation === "restore" && current === "archived") return { lifecycle: "active", trashRestoreLifecycle: null };
  if (operation === "restore" && current === "trashed" && restore)
    return { lifecycle: restore, trashRestoreLifecycle: null };
  return null;
}
function readCommandReadback(
  db: DatabaseSync,
  continuityId: string,
  surfaceId: string,
  operationId: string,
): ChatCommandReadback {
  const partition = db
    .prepare("SELECT revision, fence_epoch FROM continuity_partition WHERE continuity_id = ?")
    .get(continuityId) as { revision: number; fence_epoch: number };
  const selection = db
    .prepare(
      "SELECT chat_thread_id, chat_surface_session_id, selection_revision FROM active_chat_selection WHERE continuity_id = ?",
    )
    .get(continuityId) as
    | { chat_thread_id: string; chat_surface_session_id: string; selection_revision: number }
    | undefined;
  const thread = db
    .prepare(
      "SELECT t.chat_thread_id, t.chat_surface_session_id, t.companion_id, t.lifecycle, m.management_revision, m.trash_restore_lifecycle FROM continuity_thread t JOIN chat_lifecycle_metadata m ON m.chat_surface_session_id = t.chat_surface_session_id WHERE t.continuity_id = ? AND t.chat_surface_session_id = ?",
    )
    .get(continuityId, surfaceId) as Record<string, unknown> | undefined;
  if (!thread) throw commandError("exact_chat_binding_required");
  return Object.freeze({
    continuityId,
    revision: partition.revision,
    fenceEpoch: partition.fence_epoch,
    operationId,
    activeSelection: selection
      ? Object.freeze({
          chatThreadId: selection.chat_thread_id,
          chatSurfaceSessionId: selection.chat_surface_session_id,
          selectionRevision: selection.selection_revision,
        })
      : null,
    thread: Object.freeze({
      chatThreadId: thread.chat_thread_id as string,
      chatSurfaceSessionId: thread.chat_surface_session_id as string,
      companionId: thread.companion_id as string,
      lifecycle: thread.lifecycle as "active" | "archived" | "trashed",
      managementRevision: thread.management_revision as number,
      trashRestoreLifecycle: thread.trash_restore_lifecycle as "active" | "archived" | null,
    }),
  });
}
function freezeReadback(value: unknown): ChatCommandReadback {
  if (!value || typeof value !== "object") throw commandError("operation_payload_conflict");
  return Object.freeze(value) as ChatCommandReadback;
}
function commandError(code: CommandErrorCode): ContinuityCommandError {
  return new ContinuityCommandError(code);
}
function validateRegisterCommand(input: RegisterExactChatCommand): void {
  if (!validChatCommand(input) || !positiveRevision(input.expectedPartitionRevision))
    throw commandError("invalid_command");
}
function validateSelectionCommand(input: ChatSelectionCommand): void {
  if (
    !validChatCommand(input) ||
    !positiveRevision(input.expectedPartitionRevision) ||
    !nonNegativeRevision(input.expectedSelectionRevision)
  )
    throw commandError("invalid_command");
}
function validateArchiveCommand(input: ArchiveLifecycleCommand): void {
  if (
    !validChatCommand(input) ||
    !positiveRevision(input.expectedManagementRevision) ||
    !["archive", "trash", "restore"].includes(input.operation)
  )
    throw commandError("invalid_command");
}
function validChatCommand(
  input: Readonly<{
    principal: AuthenticatedContinuityPrincipal;
    continuityId: string;
    companionId: string;
    playerId: string;
    chatThreadId: string;
    chatSurfaceSessionId: string;
    expectedFenceEpoch: number;
    operationId: string;
  }>,
): boolean {
  return (
    validPrincipal(input.principal) &&
    samePrincipal(input.principal, input) &&
    opaque(input.continuityId) &&
    opaque(input.companionId) &&
    opaque(input.playerId) &&
    opaque(input.chatThreadId) &&
    opaque(input.chatSurfaceSessionId) &&
    opaque(input.operationId) &&
    positiveRevision(input.expectedFenceEpoch)
  );
}
function positiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function nonNegativeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function readSnapshot(db: DatabaseSync, continuityId: string): AuthoritativeSnapshot | null {
  const p = db.prepare("SELECT * FROM continuity_partition WHERE continuity_id=?").get(continuityId) as
    | {
        companion_id: string;
        player_id: string;
        revision: number;
        fence_epoch: number;
        authority_state: "adopted" | "semantic_active" | "semantic_quarantined_abandoned_mutex";
        legacy_snapshot_hash: string;
      }
    | undefined;
  if (!p) return null;
  partition(db, continuityId);
  const sel = db.prepare("SELECT * FROM active_chat_selection WHERE continuity_id=?").get(continuityId) as
    | { chat_thread_id: string; chat_surface_session_id: string; selection_revision: number }
    | undefined;
  const rows = db
    .prepare("SELECT * FROM surface_session WHERE continuity_id=? ORDER BY session_id")
    .all(continuityId) as Array<Record<string, unknown>>;
  const sessions: readonly SnapshotSession[] = rows.map((r) =>
    r.surface === "game"
      ? Object.freeze({
          sessionId: r.session_id as string,
          surface: "game" as const,
          state: r.state as string,
          createdAtMs: r.created_at_ms as number,
          updatedAtMs: r.updated_at_ms as number,
          origin: Object.freeze({
            chatThreadId: r.origin_chat_thread_id as string,
            chatSurfaceSessionId: r.origin_chat_surface_session_id as string,
            playerId: r.player_id as string,
            companionId: r.companion_id as string,
            continuityId: r.origin_continuity_id as string,
          }),
          world: Object.freeze({
            integrationId: r.integration_id as string,
            saveId: r.save_id as string,
            worldId: r.world_id as string,
          }),
          returnChatSessionId: r.return_chat_session_id as string,
        })
      : Object.freeze({
          sessionId: r.session_id as string,
          surface: "chat" as const,
          state: r.state as string,
          createdAtMs: r.created_at_ms as number,
          updatedAtMs: r.updated_at_ms as number,
          origin: null,
          world: null,
          returnChatSessionId: null,
        }),
  );
  const threadRows = db
    .prepare(
      "SELECT t.*, m.management_revision, m.trash_restore_lifecycle FROM continuity_thread t JOIN chat_lifecycle_metadata m ON m.chat_surface_session_id=t.chat_surface_session_id WHERE t.continuity_id=? ORDER BY t.chat_surface_session_id",
    )
    .all(continuityId) as Array<Record<string, unknown>>;
  const threads = threadRows.map((r) => {
    const restore = r.trash_restore_lifecycle;
    if (
      !isLifecycle(r.lifecycle) ||
      !opaque(r.chat_thread_id) ||
      !opaque(r.chat_surface_session_id) ||
      !opaque(r.companion_id) ||
      (r.lifecycle === "trashed" ? !(restore === "active" || restore === "archived") : restore !== null)
    )
      throw new Error("invalid_materialized_continuity_thread");
    return Object.freeze({
      chatThreadId: r.chat_thread_id,
      chatSurfaceSessionId: r.chat_surface_session_id,
      companionId: r.companion_id,
      playerId: p.player_id,
      continuityId,
      lifecycle: r.lifecycle,
      managementRevision: r.management_revision as number,
      trashRestoreLifecycle: restore as "active" | "archived" | null,
    });
  });
  const events = db
    .prepare("SELECT * FROM continuity_event WHERE continuity_id=? ORDER BY occurred_at_ms, event_id")
    .all(continuityId)
    .map((r: Record<string, unknown>) =>
      Object.freeze({
        eventId: r.event_id as string,
        type: r.type as LedgerEvent["type"],
        sessionId: r.session_id as string,
        surface: r.surface as "chat" | "game",
        occurredAtMs: r.occurred_at_ms as number,
      }),
    );
  const games: readonly SnapshotGameSession[] = sessions
    .filter((s): s is SnapshotGameSession => s.surface === "game")
    .map((s) =>
      Object.freeze({
        sessionId: s.sessionId,
        surface: "game" as const,
        state: s.state,
        createdAtMs: s.createdAtMs,
        updatedAtMs: s.updatedAtMs,
        origin: s.origin,
        world: s.world,
        returnChatSessionId: s.returnChatSessionId,
      }),
    );
  const l = db.prepare("SELECT * FROM game_runtime_lease WHERE continuity_id=?").get(continuityId) as
    | Record<string, unknown>
    | undefined;
  let lease: ContinuityLease | null = null;
  if (l) {
    const game = games.find((g) => g.sessionId === l.session_id);
    const state = l.state;
    if (!game || !isLeaseState(state)) throw new Error("invalid_materialized_game_lease");
    lease = Object.freeze({
      gameSessionId: game.sessionId,
      bindingDigest: l.binding_digest as string,
      ownerToken: l.owner_token as string,
      runtimeInstanceId: l.runtime_instance_id as string,
      ownerPid: l.owner_pid as number,
      ownerProcessStartIdentity: l.owner_process_start_identity as string,
      origin: game.origin,
      world: game.world,
      state,
    });
  }
  return Object.freeze({
    continuityId,
    companionId: p.companion_id,
    playerId: p.player_id,
    revision: p.revision,
    fenceEpoch: p.fence_epoch,
    authorityState: p.authority_state,
    legacySnapshotHash: p.legacy_snapshot_hash,
    activeSelection: sel
      ? Object.freeze({
          chatThreadId: sel.chat_thread_id,
          chatSurfaceSessionId: sel.chat_surface_session_id,
          selectionRevision: sel.selection_revision,
        })
      : null,
    threads: Object.freeze(threads),
    sessions: Object.freeze(sessions),
    events: Object.freeze(events),
    gameSessions: Object.freeze(games),
    lease,
  });
}
function isLifecycle(v: unknown): v is ContinuityThread["lifecycle"] {
  return v === "active" || v === "archived" || v === "trashed";
}
function isLeaseState(v: unknown): v is ContinuityLease["state"] {
  return v === "owned" || v === "return_pending" || v === "recovery_required";
}
function same(a: object, b: object): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function validOrigin(v: GameOrigin | null, c: string): v is GameOrigin {
  return (
    !!v &&
    v.continuityId === c &&
    [v.chatThreadId, v.chatSurfaceSessionId, v.playerId, v.companionId, v.continuityId].every(opaque)
  );
}
function validWorld(v: GameWorld | null): v is GameWorld {
  return !!v && [v.integrationId, v.saveId, v.worldId].every(opaque);
}
function opaque(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
}
function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function hash(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
}
function timestamp(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function readIntentReadback(db: DatabaseSync, intent: Record<string, unknown>): GameCommandReadback {
  if (typeof intent.response_json === "string")
    return Object.freeze(JSON.parse(intent.response_json)) as GameCommandReadback;
  const permit = intentPermit(intent);
  if (!permit) throw commandError("permit_conflict");
  const base = gameReadback(db, permit);
  const status = intent.status as GameCommandReadback["status"];
  return Object.freeze({
    ...base,
    pending: status === "pending",
    status,
    abortReason: validAbortReason(intent.abort_reason) ? intent.abort_reason : null,
  });
}
function canonicalReceiptDigest(receipt: unknown): string | null {
  try {
    return canonicalSha256(receipt);
  } catch {
    return null;
  }
}
function validRecoveryErrorCode(value: unknown): value is CommandErrorCode {
  return (
    value === "receipt_invalid" ||
    value === "deadline_expired" ||
    value === "game_revision_conflict" ||
    value === "effect_failed"
  );
}
function validRecoveryReason(value: unknown): value is GameRecoveryReason {
  return (
    value === "receipt_invalid" ||
    value === "deadline_expired" ||
    value === "revision_or_fence_conflict" ||
    value === "effect_failed"
  );
}
function validAbortReason(value: unknown): value is GameAbortReason {
  return (
    value === "cancelled" || value === "host_shutdown" || value === "receipt_rejected" || value === "deadline_expired"
  );
}
function prepareGameOperation(
  db: DatabaseSync,
  input: GameCommand,
  now: number,
  verifier: PreviousRuntimeOwnerVerifier | undefined,
): GamePrepareOutcome {
  const prepared = prepareGameCommandCore(db, input, now, verifier);
  return withImmediateTransaction(db, () => {
    partition(db, input.continuityId);
    const intent = db
      .prepare("SELECT * FROM game_command_intent WHERE continuity_id=? AND operation_id=?")
      .get(input.continuityId, input.operationId) as Record<string, unknown>;
    const readback = readIntentReadback(db, intent);
    if (prepared.created) return Object.freeze({ outcome: "effect_owned" as const, permit: prepared.permit, readback });
    const outcome =
      intent.status === "pending"
        ? "effect_pending"
        : intent.status === "terminal"
          ? "completed"
          : (intent.status as "aborted" | "recovery_required");
    return Object.freeze({ outcome, readback });
  });
}
function readGameOperation(
  db: DatabaseSync,
  input: Readonly<{ principal: AuthenticatedContinuityPrincipal; operationId: string }>,
): GameCommandReadback | null {
  if (!validPrincipal(input.principal) || !opaque(input.operationId)) throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    partition(db, input.principal.continuityId);
    assertPrincipal(db, input.principal);
    const i = db
      .prepare("SELECT * FROM game_command_intent WHERE continuity_id=? AND operation_id=?")
      .get(input.principal.continuityId, input.operationId) as Record<string, unknown> | undefined;
    return i ? readIntentReadback(db, i) : null;
  });
}
function readPreparedGameOperationVector(
  db: DatabaseSync,
  input: Readonly<{ principal: AuthenticatedContinuityPrincipal; operationId: string }>,
): GameRevisionVector | null {
  if (!validPrincipal(input.principal) || !opaque(input.operationId)) throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    partition(db, input.principal.continuityId);
    assertPrincipal(db, input.principal);
    const i = db
      .prepare(
        "SELECT status, fence_epoch, prepared_partition_revision, prepared_game_revision, prepared_lease_revision, prepared_selection_revision FROM game_command_intent WHERE continuity_id=? AND operation_id=?",
      )
      .get(input.principal.continuityId, input.operationId) as Record<string, unknown> | undefined;
    if (!i || i.status !== "pending") return null;
    const {
      prepared_partition_revision: partitionRevision,
      prepared_game_revision: gameRevision,
      prepared_lease_revision: leaseRevision,
      prepared_selection_revision: selectionRevision,
      fence_epoch: fenceEpoch,
    } = i;
    if (
      !positiveRevision(partitionRevision) ||
      !positiveRevision(gameRevision) ||
      !positiveRevision(leaseRevision) ||
      !nonNegativeRevision(selectionRevision) ||
      !positiveRevision(fenceEpoch)
    )
      throw commandError("permit_conflict");
    return Object.freeze({ partitionRevision, gameRevision, leaseRevision, selectionRevision, fenceEpoch });
  });
}
function commitGameOperation(db: DatabaseSync, input: GameOperationCommitInput, now: number): GameCommandReadback {
  const i = withImmediateTransaction(db, () => {
    partition(db, input.permit.continuityId);
    return db
      .prepare(
        "SELECT prepared_partition_revision,prepared_game_revision,prepared_lease_revision,prepared_selection_revision,fence_epoch FROM game_command_intent WHERE continuity_id=? AND operation_id=?",
      )
      .get(input.permit.continuityId, input.permit.operationId) as Record<string, number> | undefined;
  });
  if (
    !i ||
    !positiveRevision(i.prepared_partition_revision) ||
    !positiveRevision(i.prepared_game_revision) ||
    !positiveRevision(i.prepared_lease_revision) ||
    !nonNegativeRevision(i.prepared_selection_revision) ||
    !positiveRevision(i.fence_epoch)
  )
    throw commandError("permit_conflict");
  return commitGameTerminal(
    db,
    {
      principal: input.principal,
      permit: input.permit,
      receipt: input.receipt,
      expectedPartitionRevision: i.prepared_partition_revision,
      expectedGameRevision: i.prepared_game_revision,
      expectedLeaseRevision: i.prepared_lease_revision,
      expectedSelectionRevision: i.prepared_selection_revision,
      expectedFenceEpoch: i.fence_epoch,
    },
    now,
  );
}
function failGameOperation(db: DatabaseSync, input: GameOperationFailureInput): GameCommandReadback {
  if (input.reason !== "effect_failed" || !validPermit(input.permit) || !validPrincipal(input.principal))
    throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    const q = input.permit;
    const p = partition(db, q.continuityId);
    assertPrincipal(db, input.principal);
    const i = db
      .prepare("SELECT * FROM game_command_intent WHERE continuity_id=? AND operation_id=?")
      .get(q.continuityId, q.operationId) as Record<string, unknown> | undefined;
    const durable = intentPermit(i);
    if (!durable || !samePermit(q, durable) || !samePrincipal(input.principal, durable.origin))
      throw commandError("permit_conflict");
    if (i!.status === "recovery_required") {
      if (
        i!.recovery_error_code !== "effect_failed" ||
        i!.recovery_reason !== "effect_failed" ||
        typeof i!.response_json !== "string" ||
        i!.terminal_receipt_digest !== null ||
        i!.abort_reason !== null
      )
        throw commandError("permit_conflict");
      return Object.freeze(JSON.parse(i!.response_json)) as GameCommandReadback;
    }
    if (i!.status !== "pending" || p.fence_epoch !== q.fenceEpoch) throw commandError("permit_conflict");
    markRecovery(db, q, "effect_failed", "effect_failed");
    const result = readIntentReadback(
      db,
      db
        .prepare("SELECT * FROM game_command_intent WHERE continuity_id=? AND operation_id=?")
        .get(q.continuityId, q.operationId) as Record<string, unknown>,
    );
    if (result.status !== "recovery_required") throw commandError("permit_conflict");
    return result;
  });
}
function abortGameOperation(
  db: DatabaseSync,
  input: GameOperationAbortInput,
  expectedFenceEpoch?: number,
): GameCommandReadback {
  if (!validAbortReason(input.reason)) throw commandError("invalid_command");
  return withImmediateTransaction(db, () => {
    const q = input.permit;
    if (!validPermit(q) || !validPrincipal(input.principal)) throw commandError("invalid_command");
    const p = partition(db, q.continuityId);
    assertPrincipal(db, input.principal);
    const i = db
      .prepare("SELECT * FROM game_command_intent WHERE continuity_id=? AND operation_id=?")
      .get(q.continuityId, q.operationId) as Record<string, unknown> | undefined;
    const durable = intentPermit(i);
    if (!durable || !samePermit(q, durable) || !samePrincipal(input.principal, durable.origin))
      throw commandError("permit_conflict");
    if (
      expectedFenceEpoch !== undefined &&
      (p.fence_epoch !== expectedFenceEpoch || q.fenceEpoch !== expectedFenceEpoch)
    )
      throw commandError("fence_conflict");
    if (i!.status === "aborted") {
      if (typeof i!.response_json !== "string" || i!.abort_reason !== input.reason)
        throw commandError("permit_conflict");
      return Object.freeze(JSON.parse(i!.response_json)) as GameCommandReadback;
    }
    if (i!.status !== "pending" || p.fence_epoch !== q.fenceEpoch) throw commandError("permit_conflict");
    let readback: GameCommandReadback;
    if (q.kind === "game_enter") {
      db.prepare("DELETE FROM game_runtime_lease WHERE continuity_id=?").run(q.continuityId);
      db.prepare("DELETE FROM surface_session WHERE session_id=?").run(q.gameSessionId);
      const origin = db
        .prepare("SELECT state FROM surface_session WHERE session_id=?")
        .get(q.origin.chatSurfaceSessionId) as { state: string };
      readback = Object.freeze({
        continuityId: q.continuityId,
        revision: p.revision,
        fenceEpoch: p.fence_epoch,
        operationId: q.operationId,
        gameSessionId: q.gameSessionId,
        gameState: "absent",
        originChatState: origin.state,
        leaseState: null,
        pending: false,
        status: "aborted",
        abortReason: input.reason,
      });
    } else {
      markRecovery(db, q);
      const base = gameReadback(db, q);
      readback = Object.freeze({ ...base, pending: false, status: "aborted", abortReason: input.reason });
    }
    db.prepare(
      "UPDATE game_command_intent SET status='aborted', abort_reason=?, response_json=? WHERE continuity_id=? AND operation_id=?",
    ).run(input.reason, canonicalJson(readback), q.continuityId, q.operationId);
    return readback;
  });
}
