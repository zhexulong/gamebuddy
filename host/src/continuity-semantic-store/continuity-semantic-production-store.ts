import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isProductionChatRuntimeDeadlineCancellation,
  type ProductionChatRuntimeDeadlineCancellationInput,
} from "./continuity-semantic-deadline-cancellation.internal.js";
import {
  readWindowsOwnerDeathVerification,
  type WindowsOwnerDeathVerification,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.internal.js";

/** Production-only, fresh-only S4a substrate. It intentionally has no adoption or legacy imports. */
export const PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION = 42;
export type ProductionPrincipal = Readonly<{ continuityId: string; companionId: string; playerId: string }>;
export type ProductionBootstrapInput = Readonly<{
  principal: ProductionPrincipal;
  bootstrapOperationId: string;
  authorityGeneration: number;
  authorityRootIdentity: string;
}>;
export type TavernExactContentReceipt = Readonly<{
  chatThreadId: string;
  companionId: string;
  continuityId: string;
  chatSurfaceSessionId: string;
  digest: string;
}>;
export type SagaVector = Readonly<{ partitionRevision: number; fenceEpoch: number; selectionRevision: number }>;
export type GameRevisionVector = Readonly<{
  partitionRevision: number;
  gameRevision: number;
  leaseRevision: number;
  fenceEpoch: number;
}>;
export type ProductionSagaReadback = Readonly<{
  phase: "claimed_empty" | "chat_registered" | "content_verified" | "selected";
  vector: SagaVector;
  chatThreadId: string | null;
  chatSurfaceSessionId: string | null;
  receipt: TavernExactContentReceipt | null;
}>;
export type ProductionStoreMetadata = Readonly<{ storeId: string; schemaVersion: number }>;
/** Immutable admission facts supplied only by the provisioner after canonical bootstrap validation. */
export type ProductionBootstrapContext = Readonly<{
  bootstrap: ProductionBootstrapInput;
  metadata: ProductionStoreMetadata;
}>;
export type ProductionSagaInput = Readonly<{ holderBindingDigest: string; operationId: string; expected: SagaVector }>;
/** Fresh-only post-initial Chat command. The bound bootstrap principal is never caller input. */
export type ProductionChatCommandInput = Readonly<{
  operationId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  expected: SagaVector;
}>;
export type ProductionChatLifecycleInput = Readonly<{
  operationId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  expectedManagementRevision: number;
  expected: SagaVector;
  operation: "archive" | "trash" | "restore";
}>;
export type ProductionChatLifecycle = "active" | "archived" | "trashed";
export type ProductionChatCatalog = Readonly<{
  vector: SagaVector;
  activeSelection: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; selectionRevision: number }> | null;
  threads: readonly Readonly<{
    chatThreadId: string;
    chatSurfaceSessionId: string;
    lifecycle: ProductionChatLifecycle;
    managementRevision: number;
    contentState: "registered" | "verified";
  }>[];
}>;
export type ProductionChatCommandReadback = Readonly<{
  operationId: string;
  kind: "register_chat" | "verify_chat_content" | "select_chat" | "transition_chat_lifecycle";
  chatThreadId: string;
  chatSurfaceSessionId: string;
  lifecycle: ProductionChatLifecycle;
  managementRevision: number;
  vector: SagaVector;
  activeSelection: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; selectionRevision: number }> | null;
}>;
/** v38 Chat runtime request; production callers derive this only inside the Host construction zone. */
export type ProductionChatRuntimeOwner = Readonly<{
  ownerToken: string;
  runtimeInstanceId: string;
  ownerPid: number;
  ownerProcessStartIdentity: string;
}>;
export type ProductionChatRuntimeRequest = Readonly<{
  principal: ProductionPrincipal;
  operationId: string;
  requestId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  runtimeBindingDigest: string;
  owner: ProductionChatRuntimeOwner;
  deadlineAtMs: number;
  expected: SagaVector;
}>;
export type ProductionChatRuntimePermit = Readonly<
  ProductionChatRuntimeRequest & { payloadDigest: string; fenceToken: string; prepared: SagaVector }
>;
export type ProductionChatRuntimeReceipt = Readonly<{
  kind: "chat_runtime_bootstrapped";
  operationId: string;
  requestId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  runtimeBindingDigest: string;
  owner: ProductionChatRuntimeOwner;
  fenceToken: string;
  occurredAtMs: number;
}>;
export type ProductionChatRuntimeRecoveryReceipt = Readonly<{
  kind: "chat_runtime_recovery_completed";
  operationId: string;
  requestId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  runtimeBindingDigest: string;
  owner: ProductionChatRuntimeOwner;
  fenceToken: string;
  occurredAtMs: number;
}>;
export type ProductionChatRuntimeReadback = Readonly<{
  operationId: string;
  requestId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  status: "pending" | "terminal" | "recovery_required";
  runtimeState: "pending" | "active" | "recovery_required";
  vector: SagaVector;
  receipt: ProductionChatRuntimeReceipt | ProductionChatRuntimeRecoveryReceipt | null;
  recoveryReason: "effect_failed" | "receipt_invalid" | "deadline_expired" | "revision_conflict" | null;
}>;
export type ProductionChatRuntimePrepareOutcome = Readonly<{
  outcome: "effect_owned" | "completed" | "effect_pending" | "recovery_required";
  permit: ProductionChatRuntimePermit | null;
  readback: ProductionChatRuntimeReadback;
}>;
export type ProductionChatRuntimeTerminalInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionChatRuntimePermit;
  receipt: ProductionChatRuntimeReceipt;
}>;
export type ProductionChatRuntimeFailureInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionChatRuntimePermit;
  /** Existing coordinator path: effect failure is distinct from deadline cancellation. */
  reason: "effect_failed";
}>;
/** v40 teardown is a fresh-only append-only successor to one terminal bootstrap operation. */
export type ProductionChatRuntimeTeardownRequest = Readonly<{
  principal: ProductionPrincipal;
  operationId: string;
  requestId: string;
  bootstrapOperationId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  runtimeBindingDigest: string;
  owner: ProductionChatRuntimeOwner;
  deadlineAtMs: number;
  expected: SagaVector;
}>;
export type ProductionChatRuntimeTeardownPermit = Readonly<
  ProductionChatRuntimeTeardownRequest & { payloadDigest: string; fenceToken: string; prepared: SagaVector }
>;
export type ProductionChatRuntimeTeardownReceipt = Readonly<{
  kind: "chat_runtime_torn_down";
  operationId: string;
  requestId: string;
  bootstrapOperationId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  runtimeBindingDigest: string;
  owner: ProductionChatRuntimeOwner;
  fenceToken: string;
  occurredAtMs: number;
}>;
export type ProductionChatRuntimeTeardownRecoveryReceipt = Readonly<{
  kind: "chat_runtime_teardown_recovery_completed";
  operationId: string;
  requestId: string;
  bootstrapOperationId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  runtimeBindingDigest: string;
  owner: ProductionChatRuntimeOwner;
  fenceToken: string;
  occurredAtMs: number;
}>;
export type ProductionChatRuntimeTeardownReadback = Readonly<{
  operationId: string;
  requestId: string;
  bootstrapOperationId: string;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  status: "pending" | "terminal" | "recovery_required";
  runtimeState: "pending" | "closed" | "recovery_required";
  vector: SagaVector;
  receipt: ProductionChatRuntimeTeardownReceipt | ProductionChatRuntimeTeardownRecoveryReceipt | null;
  recoveryReason: "effect_failed" | "receipt_invalid" | "deadline_expired" | "revision_conflict" | null;
}>;
export type ProductionChatRuntimeTeardownPrepareOutcome = Readonly<{
  outcome: "effect_owned" | "completed" | "effect_pending" | "recovery_required";
  permit: ProductionChatRuntimeTeardownPermit | null;
  readback: ProductionChatRuntimeTeardownReadback;
}>;
export type ProductionChatRuntimeTeardownTerminalInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionChatRuntimeTeardownPermit;
  receipt: ProductionChatRuntimeTeardownReceipt;
}>;
export type ProductionChatRuntimeTeardownFailureInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionChatRuntimeTeardownPermit;
  reason: "effect_failed";
}>;
export type ProductionChatRuntimeTeardownRecoveryInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionChatRuntimeTeardownPermit;
  proof: ProductionChatRuntimeRecoveryProof;
  receipt: ProductionChatRuntimeTeardownRecoveryReceipt;
}>;
/** Branded internal operation for the sole authority that may cancel an expired permit. */
export type ProductionChatRuntimeRecoveryProof = Readonly<{ owner: ProductionChatRuntimeOwner; proof: "proven_dead" }>;
export type ProductionChatRuntimeRecoveryInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionChatRuntimePermit;
  proof: ProductionChatRuntimeRecoveryProof;
  receipt: ProductionChatRuntimeRecoveryReceipt;
}>;
const productionChatRuntimeRecoveryProofs = new WeakSet<object>();
export function productionChatOwnerProvenDead(owner: ProductionChatRuntimeOwner): ProductionChatRuntimeRecoveryProof {
  const proof = Object.freeze({ owner: Object.freeze({ ...owner }), proof: "proven_dead" as const });
  productionChatRuntimeRecoveryProofs.add(proof);
  return proof;
}
export type ProductionGameWorld = Readonly<{ integrationId: string; saveId: string; worldId: string }>;
export type ProductionGameOwner = Readonly<{
  ownerToken: string;
  runtimeInstanceId: string;
  ownerPid: number;
  ownerProcessStartIdentity: string;
}>;
export type ProductionGameRequest = Readonly<{
  principal: ProductionPrincipal;
  operationId: string;
  requestId: string;
  kind: "enter" | "close";
  gameSessionId: string;
  world: ProductionGameWorld;
  bindingDigest: string;
  owner: ProductionGameOwner;
  deadlineAtMs: number;
  expected: GameRevisionVector;
}>;
export type ProductionGamePermit = Readonly<
  ProductionGameRequest & { payloadDigest: string; fenceToken: string; prepared: GameRevisionVector }
>;
export type ProductionGameTerminalReceipt = Readonly<{
  kind: "runtime_bootstrapped" | "runtime_torn_down";
  operationId: string;
  requestId: string;
  gameSessionId: string;
  bindingDigest: string;
  world: ProductionGameWorld;
  owner: ProductionGameOwner;
  fenceToken: string;
  occurredAtMs: number;
}>;
export type ProductionGameRecoveryReceipt = Readonly<{
  kind: "recovery_completed";
  operationId: string;
  requestId: string;
  gameSessionId: string;
  bindingDigest: string;
  world: ProductionGameWorld;
  owner: ProductionGameOwner;
  fenceToken: string;
  occurredAtMs: number;
}>;
export type ProductionGameReadback = Readonly<{
  operationId: string;
  requestId: string;
  status: "pending" | "terminal" | "recovery_required";
  gameSessionId: string;
  gameState: "pending" | "active" | "ended" | "recovery_required";
  leaseState: "owned" | "close_pending" | "recovery_required" | null;
  vector: GameRevisionVector;
  receipt: ProductionGameTerminalReceipt | ProductionGameRecoveryReceipt | null;
  recoveryReason: "effect_failed" | "receipt_invalid" | "deadline_expired" | "revision_conflict" | null;
}>;
export type ProductionGamePrepareOutcome = Readonly<{
  outcome: "effect_owned" | "completed" | "effect_pending" | "recovery_required";
  permit: ProductionGamePermit | null;
  readback: ProductionGameReadback;
}>;
export type ProductionGameTerminalInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionGamePermit;
  receipt: ProductionGameTerminalReceipt;
}>;
export type ProductionGameFailureInput = Readonly<{
  principal: ProductionPrincipal;
  permit: ProductionGamePermit;
  reason: "effect_failed";
}>;
/** Opaque result from a fresh independent Windows OS owner query. */
export type ProductionGameRecoveryProof = WindowsOwnerDeathVerification;
export type ProductionGameRecoveryInput = Readonly<{
  /** Recovery is never an implicit close/failure fallback. */
  request: "recover_dead_owner";
  principal: ProductionPrincipal;
  permit: ProductionGamePermit;
  proof: ProductionGameRecoveryProof;
  receipt: ProductionGameRecoveryReceipt;
}>;
/** Internal recovery readback: owner tuple and permit originate from one durable row. */
export type ProductionGameRecoveryTarget = Readonly<{
  owner: ProductionGameOwner;
  permit: ProductionGamePermit;
  readback: ProductionGameReadback;
}>;

export type ProductionSagaStore = Readonly<{
  claim(input: ProductionSagaInput): ProductionSagaReadback;
  register(input: ProductionSagaInput): ProductionSagaReadback;
  verify(input: ProductionSagaInput, receipt: TavernExactContentReceipt): ProductionSagaReadback;
  select(input: ProductionSagaInput): ProductionSagaReadback;
  /** Catalog and mutations are fresh-only v37 commands, isolated from Tavern content effects. */
  readChatCatalog(): ProductionChatCatalog;
  registerChat(input: ProductionChatCommandInput): ProductionChatCommandReadback;
  verifyChatContent(
    input: ProductionChatCommandInput,
    receipt: TavernExactContentReceipt,
  ): ProductionChatCommandReadback;
  selectChat(input: ProductionChatCommandInput): ProductionChatCommandReadback;
  transitionChatLifecycle(input: ProductionChatLifecycleInput): ProductionChatCommandReadback;
  /** Short SQLite prepare only; runtime materialization must execute outside the mutex. */
  prepareChatRuntime(input: ProductionChatRuntimeRequest): ProductionChatRuntimePrepareOutcome;
  commitChatRuntime(input: ProductionChatRuntimeTerminalInput): ProductionChatRuntimeReadback;
  /** v40 append-only teardown protocol; runtime effects remain outside this store transaction. */
  prepareChatRuntimeTeardown(input: ProductionChatRuntimeTeardownRequest): ProductionChatRuntimeTeardownPrepareOutcome;
  commitChatRuntimeTeardown(input: ProductionChatRuntimeTeardownTerminalInput): ProductionChatRuntimeTeardownReadback;
  failChatRuntimeTeardown(input: ProductionChatRuntimeTeardownFailureInput): ProductionChatRuntimeTeardownReadback;
  recoverChatRuntimeTeardown(input: ProductionChatRuntimeTeardownRecoveryInput): ProductionChatRuntimeTeardownReadback;
  failChatRuntime(
    input: ProductionChatRuntimeFailureInput | ProductionChatRuntimeDeadlineCancellationInput,
  ): ProductionChatRuntimeReadback;
  recoverChatRuntime(input: ProductionChatRuntimeRecoveryInput): ProductionChatRuntimeReadback;
  resume(holderBindingDigest: string): ProductionSagaReadback | null;
  /** Durable fail-closed state for an abandoned Windows root mutex. */
  quarantineAfterAbandonedMutex(): void;
  readQuarantine(): Readonly<{ quarantined: boolean; reason: string | null }>;
  prepareGame(input: ProductionGameRequest): ProductionGamePrepareOutcome;
  commitGameTerminal(input: ProductionGameTerminalInput): ProductionGameReadback;
  failGame(input: ProductionGameFailureInput): ProductionGameReadback;
  recoverGame(input: ProductionGameRecoveryInput): ProductionGameReadback;
  /** Reads one exact durable dead-owner recovery target; only recovery-required or close-pending close intents qualify. */
  readGameRecoveryTarget(
    input: Readonly<{ principal: ProductionPrincipal; operationId: string }>,
  ): ProductionGameRecoveryTarget | null;
  /** Current independent Game admission; it never consults Chat selection or lifecycle. */
  readGameAdmission(): Readonly<{ vector: GameRevisionVector; activeGameSessionId: string | null }>;
  readGameOperation(
    input: Readonly<{ principal: ProductionPrincipal; operationId: string }>,
  ): ProductionGameReadback | null;
}>;
export type ProductionContinuityStore = Readonly<{
  bootstrapFresh(input: ProductionBootstrapInput): ProductionStoreMetadata;
  validateBootstrap(input: ProductionBootstrapInput): ProductionStoreMetadata;
  /** Binds exactly once; all returned saga methods revalidate this immutable tuple in their transaction. */
  bindBootstrapContext(context: ProductionBootstrapContext): ProductionSagaStore;
  configuration(): Readonly<{ journalMode: string; synchronous: number; busyTimeoutMs: number }>;
  close(): void;
}>;

const DB = "gamebuddy-continuity-v1.sqlite";
const tableNames = [
  "production_active_selection",
  "production_bootstrap",
  "production_chat_lifecycle_metadata",
  "production_chat_runtime_intent",
  "production_chat_runtime_teardown_intent",
  "production_continuity_command",
  "production_continuity_event",
  "production_continuity_thread",
  "production_game_intent",
  "production_game_lease",
  "production_game_session",
  "production_initial_chat_saga",
  "production_partition",
  "production_quarantine",
  "production_saga_operation",
  "production_saga_receipt",
  "production_store_meta",
  "production_surface_session",
] as const;
const indexNames = [
  "production_event_partition_index",
  "production_game_intent_partition_index",
  "production_saga_operation_step_index",
  "production_surface_partition_index",
  "production_thread_partition_index",
  "production_chat_runtime_teardown_predecessor_index",
] as const;
const schema = `
CREATE TABLE production_store_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL CHECK(schema_version=42));
CREATE TABLE production_bootstrap (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL REFERENCES production_store_meta(store_id), bootstrap_operation_id TEXT NOT NULL UNIQUE, continuity_id TEXT NOT NULL, companion_id TEXT NOT NULL, player_id TEXT NOT NULL, authority_generation INTEGER NOT NULL CHECK(authority_generation>=1), authority_root_identity TEXT NOT NULL);
CREATE TABLE production_partition (singleton INTEGER PRIMARY KEY CHECK(singleton=1), continuity_id TEXT NOT NULL UNIQUE, companion_id TEXT NOT NULL, player_id TEXT NOT NULL, partition_revision INTEGER NOT NULL CHECK(partition_revision>=1), fence_epoch INTEGER NOT NULL CHECK(fence_epoch>=1), selection_revision INTEGER NOT NULL CHECK(selection_revision>=0), game_partition_revision INTEGER NOT NULL CHECK(game_partition_revision>=1), game_fence_epoch INTEGER NOT NULL CHECK(game_fence_epoch>=1));
CREATE TABLE production_surface_session (session_id TEXT PRIMARY KEY, continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), surface TEXT NOT NULL CHECK(surface IN ('chat','game')), state TEXT NOT NULL CHECK(state IN ('suspended','active','ended','pending','recovery_required')), created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0), updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0));
CREATE TABLE production_continuity_thread (chat_surface_session_id TEXT PRIMARY KEY REFERENCES production_surface_session(session_id), continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), chat_thread_id TEXT NOT NULL, companion_id TEXT NOT NULL, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived','trashed')), content_receipt_json TEXT, content_receipt_digest TEXT, UNIQUE(continuity_id,chat_thread_id), CHECK((content_receipt_json IS NULL AND content_receipt_digest IS NULL) OR (content_receipt_json IS NOT NULL AND content_receipt_digest IS NOT NULL)));
CREATE TABLE production_chat_lifecycle_metadata (chat_surface_session_id TEXT PRIMARY KEY REFERENCES production_continuity_thread(chat_surface_session_id), management_revision INTEGER NOT NULL CHECK(management_revision>=1), trash_restore_lifecycle TEXT CHECK(trash_restore_lifecycle IN ('active','archived')));
CREATE TABLE production_chat_runtime_intent (continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), operation_id TEXT NOT NULL, request_id TEXT NOT NULL, chat_surface_session_id TEXT NOT NULL REFERENCES production_continuity_thread(chat_surface_session_id), chat_thread_id TEXT NOT NULL, payload_digest TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','terminal','recovery_required')), runtime_binding_digest TEXT NOT NULL, owner_json TEXT NOT NULL, fence_token TEXT NOT NULL, deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>=0), prepared_at_ms INTEGER NOT NULL CHECK(prepared_at_ms>=0), prepared_vector_json TEXT NOT NULL, committed_vector_json TEXT, receipt_json TEXT, receipt_digest TEXT, recovery_reason TEXT CHECK(recovery_reason IN ('effect_failed','receipt_invalid','deadline_expired','revision_conflict')), PRIMARY KEY(continuity_id,operation_id), UNIQUE(continuity_id,request_id));
CREATE TABLE production_chat_runtime_teardown_intent (continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), operation_id TEXT NOT NULL, request_id TEXT NOT NULL, bootstrap_operation_id TEXT NOT NULL, chat_surface_session_id TEXT NOT NULL REFERENCES production_continuity_thread(chat_surface_session_id), chat_thread_id TEXT NOT NULL, payload_digest TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','terminal','recovery_required')), runtime_binding_digest TEXT NOT NULL, owner_json TEXT NOT NULL, fence_token TEXT NOT NULL, deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>=0), prepared_at_ms INTEGER NOT NULL CHECK(prepared_at_ms>=0), prepared_vector_json TEXT NOT NULL, committed_vector_json TEXT, receipt_json TEXT, receipt_digest TEXT, recovery_reason TEXT CHECK(recovery_reason IN ('effect_failed','receipt_invalid','deadline_expired','revision_conflict')), PRIMARY KEY(continuity_id,operation_id), UNIQUE(continuity_id,request_id));
CREATE TABLE production_continuity_event (event_id TEXT PRIMARY KEY, continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), session_id TEXT NOT NULL REFERENCES production_surface_session(session_id), type TEXT NOT NULL CHECK(type='chat_registered'), surface TEXT NOT NULL CHECK(surface='chat'), occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms>=0));
CREATE TABLE production_active_selection (singleton INTEGER PRIMARY KEY CHECK(singleton=1), chat_surface_session_id TEXT NOT NULL REFERENCES production_continuity_thread(chat_surface_session_id), chat_thread_id TEXT NOT NULL, selection_revision INTEGER NOT NULL CHECK(selection_revision>=1));
CREATE TABLE production_game_session (session_id TEXT PRIMARY KEY REFERENCES production_surface_session(session_id), continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), state TEXT NOT NULL CHECK(state IN ('pending','active','ended','recovery_required')));
CREATE TABLE production_game_lease (continuity_id TEXT PRIMARY KEY REFERENCES production_partition(continuity_id), session_id TEXT NOT NULL REFERENCES production_game_session(session_id), binding_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('owned','close_pending','recovery_required')), lease_revision INTEGER NOT NULL CHECK(lease_revision>=1), world_json TEXT NOT NULL DEFAULT '{}', owner_json TEXT NOT NULL DEFAULT '{}', fence_token TEXT NOT NULL DEFAULT '', deadline_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(deadline_at_ms>=0));
CREATE TABLE production_game_intent (continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), operation_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES production_game_session(session_id), payload_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','terminal','aborted','recovery_required')), request_id TEXT NOT NULL DEFAULT '', request_json TEXT NOT NULL DEFAULT '{}', world_json TEXT NOT NULL DEFAULT '{}', owner_json TEXT NOT NULL DEFAULT '{}', fence_token TEXT NOT NULL DEFAULT '', deadline_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(deadline_at_ms>=0), prepared_vector_json TEXT NOT NULL DEFAULT '{}', committed_vector_json TEXT, receipt_json TEXT, receipt_digest TEXT, recovery_reason TEXT CHECK(recovery_reason IN ('effect_failed','receipt_invalid','deadline_expired','revision_conflict')), PRIMARY KEY(continuity_id,operation_id));
CREATE TABLE production_continuity_command (continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), operation_id TEXT NOT NULL, command_kind TEXT NOT NULL CHECK(command_kind IN ('register_chat','verify_chat_content','select_chat','transition_chat_lifecycle')), payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, response_json TEXT NOT NULL, response_digest TEXT NOT NULL, committed_vector_json TEXT NOT NULL, PRIMARY KEY(continuity_id,operation_id));
CREATE TABLE production_quarantine (quarantine_id TEXT PRIMARY KEY, continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), reason TEXT NOT NULL);
CREATE TABLE production_initial_chat_saga (singleton INTEGER PRIMARY KEY CHECK(singleton=1), holder_binding_digest TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('claimed_empty','chat_registered','content_verified','selected')), chat_thread_id TEXT, chat_surface_session_id TEXT REFERENCES production_surface_session(session_id), receipt_json TEXT, receipt_digest TEXT, CHECK((phase='claimed_empty' AND chat_thread_id IS NULL AND chat_surface_session_id IS NULL AND receipt_json IS NULL AND receipt_digest IS NULL) OR (phase='chat_registered' AND chat_thread_id IS NOT NULL AND chat_surface_session_id IS NOT NULL AND receipt_json IS NULL AND receipt_digest IS NULL) OR (phase='content_verified' AND chat_thread_id IS NOT NULL AND chat_surface_session_id IS NOT NULL AND receipt_json IS NOT NULL AND receipt_digest IS NOT NULL) OR (phase='selected' AND chat_thread_id IS NOT NULL AND chat_surface_session_id IS NOT NULL AND receipt_json IS NOT NULL AND receipt_digest IS NOT NULL)));
CREATE TABLE production_saga_operation (operation_id TEXT PRIMARY KEY, step TEXT NOT NULL CHECK(step IN ('claim_empty','register_exact','verify_exact_content','select_open')), holder_binding_digest TEXT NOT NULL, request_json TEXT NOT NULL, request_digest TEXT NOT NULL, response_json TEXT NOT NULL, response_digest TEXT NOT NULL, committed_vector_json TEXT NOT NULL);
CREATE TABLE production_saga_receipt (operation_id TEXT PRIMARY KEY REFERENCES production_saga_operation(operation_id), step TEXT NOT NULL CHECK(step IN ('claim_empty','register_exact','verify_exact_content','select_open')), request_json TEXT NOT NULL, request_digest TEXT NOT NULL, response_json TEXT NOT NULL, response_digest TEXT NOT NULL, committed_vector_json TEXT NOT NULL);
CREATE INDEX production_event_partition_index ON production_continuity_event(continuity_id,event_id);
CREATE INDEX production_game_intent_partition_index ON production_game_intent(continuity_id,operation_id);
CREATE INDEX production_saga_operation_step_index ON production_saga_operation(step,operation_id);
CREATE INDEX production_surface_partition_index ON production_surface_session(continuity_id,session_id);
CREATE INDEX production_thread_partition_index ON production_continuity_thread(continuity_id,chat_thread_id);
CREATE UNIQUE INDEX production_chat_runtime_teardown_predecessor_index ON production_chat_runtime_teardown_intent(continuity_id,bootstrap_operation_id);`;

const canonical = (value: unknown): string => JSON.stringify(order(value));
const order = (value: any): any =>
  Array.isArray(value)
    ? value.map(order)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, order(value[key])]),
        )
      : value;
const digest = (value: unknown): string => createHash("sha256").update(canonical(value), "utf8").digest("hex");
const safeId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const validFenceToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(v);
function exactDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => {
    const descriptor = descriptors[key];
    return (
      !!descriptor &&
      descriptor.enumerable === true &&
      descriptor.writable === true &&
      descriptor.configurable === true &&
      "value" in descriptor
    );
  });
}
/** Exact plain data shape for values that may be Host-frozen (for example permits). */
function exactPlainDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => {
    const descriptor = descriptors[key];
    return !!descriptor && descriptor.enumerable === true && "value" in descriptor;
  });
}
/** Host lifecycle receipts are immutable canonical data, unlike writable request inputs. */
function exactFrozenPlainDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Object.isFrozen(value) && exactPlainDataObject(value, keys);
}
function exactReceiptDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  // Runtime receipts are Host-minted immutable records.  Their ingress shape
  // must be exact, but rejecting frozen data would reject the only legitimate
  // producer as well as untrusted mutable payloads.
  if (!exactPlainDataObject(value, keys)) return false;
  const record = value as Record<string, unknown>;
  return (
    exactPlainDataObject(record.origin, [
      "chatThreadId",
      "chatSurfaceSessionId",
      "playerId",
      "companionId",
      "continuityId",
    ]) &&
    exactPlainDataObject(record.world, ["integrationId", "saveId", "worldId"]) &&
    exactPlainDataObject(record.owner, ["ownerToken", "runtimeInstanceId", "ownerPid", "ownerProcessStartIdentity"])
  );
}
const vectorKeys = ["partitionRevision", "fenceEpoch", "selectionRevision"] as const;
/** Reads only property descriptors so untrusted vector accessors never execute at ingress. */
const validVector = (v: unknown): v is SagaVector => validVectorRecord(v, true);
/** A Host-minted frozen permit preserves exact vector values but is not caller ingress. */
const validStoredVector = (v: unknown): v is SagaVector => validVectorRecord(v, false);
function validVectorRecord(v: unknown, requireWritable: boolean): v is SagaVector {
  if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return false;
  if (Reflect.ownKeys(v).length !== vectorKeys.length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  for (const key of vectorKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      (requireWritable && descriptor.writable !== true) ||
      !("value" in descriptor) ||
      !Number.isSafeInteger(descriptor.value)
    )
      return false;
  }
  return (
    descriptors.partitionRevision.value >= 1 &&
    descriptors.fenceEpoch.value >= 1 &&
    descriptors.selectionRevision.value >= 0
  );
}
const validPrincipal = (p: unknown): p is ProductionPrincipal =>
  !!p &&
  typeof p === "object" &&
  safeId((p as ProductionPrincipal).continuityId) &&
  safeId((p as ProductionPrincipal).companionId) &&
  safeId((p as ProductionPrincipal).playerId);

export function openProductionContinuityStore(
  options: Readonly<{
    runtimeRoot: string /** Deterministic clock seam for direct store tests. */;
    nowMs?: () => number;
  }>,
): ProductionContinuityStore {
  if (!options || typeof options.runtimeRoot !== "string" || !options.runtimeRoot)
    throw new Error("invalid_runtime_root");
  if (options.nowMs !== undefined && typeof options.nowMs !== "function") throw new Error("invalid_clock");
  const nowMs = options.nowMs ?? Date.now;
  const path = join(options.runtimeRoot, DB);
  const existed = existsSync(path);
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    db.exec("PRAGMA foreign_keys=ON");
    admit(db, existed);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250");
  } catch (error) {
    db.close();
    throw error;
  }
  const requireOpen = () => {
    if (closed) throw new Error("production_continuity_store_closed");
  };
  let bound: ProductionBootstrapContext | null = null;
  return Object.freeze({
    bootstrapFresh(input) {
      requireOpen();
      validateBootstrapInput(input);
      return transaction(db, () => {
        if (db.prepare("SELECT 1 FROM production_bootstrap").get()) return validateBootstrap(db, input);
        const meta = metadata(db)!;
        db.prepare("INSERT INTO production_bootstrap VALUES(1,?,?,?,?,?,?,?)").run(
          meta.storeId,
          input.bootstrapOperationId,
          input.principal.continuityId,
          input.principal.companionId,
          input.principal.playerId,
          input.authorityGeneration,
          input.authorityRootIdentity,
        );
        db.prepare("INSERT INTO production_partition VALUES(1,?,?,?,1,1,0,1,1)").run(
          input.principal.continuityId,
          input.principal.companionId,
          input.principal.playerId,
        );
        return validateBootstrap(db, input);
      });
    },
    validateBootstrap(input) {
      requireOpen();
      validateBootstrapInput(input);
      return transaction(db, () => validateBootstrap(db, input));
    },
    bindBootstrapContext(context) {
      requireOpen();
      if (bound) throw new Error("production_bootstrap_context_already_bound");
      const immutable = freezeBootstrapContext(context);
      transaction(db, () => validateExpectedBootstrap(db, immutable));
      bound = immutable;
      return Object.freeze({
        claim(input) {
          requireOpen();
          return step(db, immutable, "claim_empty", input);
        },
        register(input) {
          requireOpen();
          return step(db, immutable, "register_exact", input);
        },
        verify(input, receipt) {
          requireOpen();
          return step(db, immutable, "verify_exact_content", input, receipt);
        },
        select(input) {
          requireOpen();
          return step(db, immutable, "select_open", input);
        },
        readChatCatalog() {
          requireOpen();
          return readChatCatalog(db, immutable);
        },
        registerChat(input) {
          requireOpen();
          return runChatCommand(db, immutable, input, "register_chat");
        },
        verifyChatContent(input, receipt) {
          requireOpen();
          return runChatCommand(db, immutable, input, "verify_chat_content", receipt);
        },
        selectChat(input) {
          requireOpen();
          return runChatCommand(db, immutable, input, "select_chat");
        },
        transitionChatLifecycle(input) {
          requireOpen();
          return runChatLifecycleCommand(db, immutable, input);
        },
        prepareChatRuntime(input) {
          requireOpen();
          return prepareChatRuntime(db, immutable, input, nowMs);
        },
        commitChatRuntime(input) {
          requireOpen();
          return commitChatRuntime(db, immutable, input, nowMs);
        },
        prepareChatRuntimeTeardown(input) {
          requireOpen();
          return prepareChatRuntimeTeardown(db, immutable, input, nowMs);
        },
        commitChatRuntimeTeardown(input) {
          requireOpen();
          return commitChatRuntimeTeardown(db, immutable, input, nowMs);
        },
        failChatRuntimeTeardown(input) {
          requireOpen();
          return failChatRuntimeTeardown(db, immutable, input, nowMs);
        },
        recoverChatRuntimeTeardown(input) {
          requireOpen();
          return recoverChatRuntimeTeardown(db, immutable, input);
        },
        failChatRuntime(input) {
          requireOpen();
          return failChatRuntime(db, immutable, input, nowMs);
        },
        recoverChatRuntime(input) {
          requireOpen();
          return recoverChatRuntime(db, immutable, input);
        },
        resume(holderBindingDigest) {
          requireOpen();
          if (!sha(holderBindingDigest)) throw new Error("invalid_saga_holder");
          return transaction(db, () => {
            validateExpectedBootstrap(db, immutable);
            rejectQuarantined(db);
            const saga = db.prepare("SELECT * FROM production_initial_chat_saga WHERE singleton=1").get() as any;
            if (!saga) return null;
            if (saga.holder_binding_digest !== holderBindingDigest) throw new Error("saga_holder_mismatch");
            return readSaga(db);
          });
        },
        quarantineAfterAbandonedMutex() {
          requireOpen();
          transaction(db, () => {
            validateExpectedBootstrap(db, immutable);
            const existing = db.prepare("SELECT * FROM production_quarantine").all() as any[];
            if (
              existing.length > 1 ||
              (existing.length === 1 &&
                (existing[0].reason !== "abandoned_windows_root_mutex" ||
                  existing[0].continuity_id !== immutable.bootstrap.principal.continuityId))
            )
              throw new Error("production_quarantine_invalid");
            if (!existing.length)
              db.prepare("INSERT INTO production_quarantine VALUES(?,?,?)").run(
                `abandoned-${immutable.metadata.storeId}`,
                immutable.bootstrap.principal.continuityId,
                "abandoned_windows_root_mutex",
              );
          });
        },
        readQuarantine() {
          requireOpen();
          return transaction(db, () => {
            validateExpectedBootstrap(db, immutable);
            const rows = db.prepare("SELECT * FROM production_quarantine").all() as any[];
            if (!rows.length) return Object.freeze({ quarantined: false, reason: null });
            if (
              rows.length !== 1 ||
              rows[0].continuity_id !== immutable.bootstrap.principal.continuityId ||
              rows[0].reason !== "abandoned_windows_root_mutex"
            )
              throw new Error("production_quarantine_invalid");
            return Object.freeze({ quarantined: true, reason: rows[0].reason });
          });
        },
        prepareGame(input) {
          requireOpen();
          return prepareGame(db, immutable, input, nowMs);
        },
        commitGameTerminal(input) {
          requireOpen();
          return commitGameTerminal(db, immutable, input, nowMs);
        },
        failGame(input) {
          requireOpen();
          return failGame(db, immutable, input);
        },
        recoverGame(input) {
          requireOpen();
          return recoverGame(db, immutable, input);
        },
        readGameRecoveryTarget(input) {
          requireOpen();
          return readGameRecoveryTarget(db, immutable, input);
        },
        readGameAdmission() {
          requireOpen();
          return readGameAdmission(db, immutable);
        },
        readGameOperation(input) {
          requireOpen();
          return readGameOperation(db, immutable, input);
        },
      });
    },
    configuration() {
      requireOpen();
      return Object.freeze({
        journalMode: (db.prepare("PRAGMA journal_mode").get() as any).journal_mode,
        synchronous: (db.prepare("PRAGMA synchronous").get() as any).synchronous,
        busyTimeoutMs: (db.prepare("PRAGMA busy_timeout").get() as any).timeout,
      });
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  });
}
function transaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
function admit(db: DatabaseSync, existed: boolean): void {
  const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as any[];
  if (!objects.length) {
    if (existed) throw new Error("unsupported_production_store_schema");
    transaction(db, () => {
      db.exec(schema);
      db.prepare("INSERT INTO production_store_meta VALUES(1,?,?)").run(
        randomUUID(),
        PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION,
      );
    });
  }
  validatePhysicalSignature(db);
  validateMaterialization(db);
}
function validatePhysicalSignature(db: DatabaseSync): void {
  const objects = db
    .prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all() as any[];
  const actualTables = objects.filter((o) => o.type === "table").map((o) => o.name);
  const actualIndexes = objects.filter((o) => o.type === "index").map((o) => o.name);
  if (
    objects.some((o) => o.type !== "table" && o.type !== "index") ||
    actualTables.join("|") !== [...tableNames].sort().join("|") ||
    actualIndexes.join("|") !== [...indexNames].sort().join("|")
  )
    throw new Error("unsupported_production_store_schema");
  for (const name of tableNames) {
    const expected = columnSignature(name);
    const actual = db.prepare(`PRAGMA table_info(${name})`).all() as any[];
    const actualFk = db.prepare(`PRAGMA foreign_key_list(${name})`).all() as any[];
    const actualSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as any)?.sql;
    const approved = approvedTableSignature(name);
    if (
      canonical(
        actual.map((c) => [c.cid, c.name, String(c.type).toUpperCase(), Boolean(c.notnull), c.dflt_value, c.pk]),
      ) !== canonical(expected) ||
      canonical(actualFk.map((f) => [f.id, f.seq, f.table, f.from, f.to, f.on_update, f.on_delete, f.match])) !==
        canonical(approved.foreignKeys) ||
      normalizeSql(actualSql) !== approved.sql
    )
      throw new Error("unsupported_production_store_schema");
  }
  for (const name of indexNames) {
    const actual = indexSignature(db, name);
    const approved = approvedIndexSignature(name);
    if (canonical(actual) !== canonical(approved)) throw new Error("unsupported_production_store_schema");
  }
  const meta = metadata(db);
  if (
    !meta ||
    meta.schemaVersion !== PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION ||
    (db.prepare("PRAGMA integrity_check").get() as any).integrity_check !== "ok" ||
    (db.prepare("PRAGMA foreign_key_check").all() as any[]).length
  )
    throw new Error("unsupported_production_store_schema");
}
const expectedColumns = new Map<string, any[]>();
const approvedTables = new Map<string, Readonly<{ sql: string; foreignKeys: any[] }>>();
const approvedIndexes = new Map<string, any>();
function normalizeSql(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\s\"`]/g, "").toLowerCase() : "";
}
function approvedTableSignature(table: string): Readonly<{ sql: string; foreignKeys: any[] }> {
  let value = approvedTables.get(table);
  if (value) return value;
  const temp = new DatabaseSync(":memory:");
  try {
    temp.exec(schema);
    value = Object.freeze({
      sql: normalizeSql(
        (temp.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as any).sql,
      ),
      foreignKeys: (temp.prepare(`PRAGMA foreign_key_list(${table})`).all() as any[]).map((f) => [
        f.id,
        f.seq,
        f.table,
        f.from,
        f.to,
        f.on_update,
        f.on_delete,
        f.match,
      ]),
    });
    approvedTables.set(table, value);
    return value;
  } finally {
    temp.close();
  }
}
function columnSignature(table: string): any[] {
  let value = expectedColumns.get(table);
  if (value) return value;
  const temp = new DatabaseSync(":memory:");
  try {
    temp.exec(schema);
    value = (temp.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => [
      c.cid,
      c.name,
      String(c.type).toUpperCase(),
      Boolean(c.notnull),
      c.dflt_value,
      c.pk,
    ]);
    expectedColumns.set(table, value);
    return value;
  } finally {
    temp.close();
  }
}
function indexTable(name: string): string {
  return name.includes("teardown_predecessor")
    ? "production_chat_runtime_teardown_intent"
    : name.includes("event")
      ? "production_continuity_event"
      : name.includes("intent")
        ? "production_game_intent"
        : name.includes("saga")
          ? "production_saga_operation"
          : name.includes("surface")
            ? "production_surface_session"
            : "production_continuity_thread";
}
function indexSignature(db: DatabaseSync, name: string): any {
  const listed = (db.prepare(`PRAGMA index_list(${indexTable(name)})`).all() as any[]).find((i) => i.name === name);
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as any)?.sql;
  return [
    listed ? [listed.unique, listed.origin, listed.partial] : null,
    normalizeSql(sql),
    (db.prepare(`PRAGMA index_xinfo(${name})`).all() as any[]).map((c) => [
      c.seqno,
      c.cid,
      c.name,
      c.desc,
      c.coll,
      c.key,
    ]),
  ];
}
function approvedIndexSignature(name: string): any {
  let value = approvedIndexes.get(name);
  if (value) return value;
  const temp = new DatabaseSync(":memory:");
  try {
    temp.exec(schema);
    value = indexSignature(temp, name);
    approvedIndexes.set(name, value);
    return value;
  } finally {
    temp.close();
  }
}
function metadata(db: DatabaseSync): ProductionStoreMetadata | null {
  const rows = db.prepare("SELECT store_id,schema_version FROM production_store_meta").all() as any[];
  return rows.length === 1 &&
    typeof rows[0].store_id === "string" &&
    /^[0-9a-f-]{36}$/.test(rows[0].store_id) &&
    Number.isSafeInteger(rows[0].schema_version)
    ? Object.freeze({ storeId: rows[0].store_id, schemaVersion: rows[0].schema_version })
    : null;
}
function validateBootstrapInput(input: ProductionBootstrapInput): void {
  if (
    !input ||
    !validPrincipal(input.principal) ||
    !safeId(input.bootstrapOperationId) ||
    !Number.isSafeInteger(input.authorityGeneration) ||
    input.authorityGeneration < 1 ||
    !sha(input.authorityRootIdentity)
  )
    throw new Error("invalid_production_bootstrap");
}
function freezeBootstrapContext(context: ProductionBootstrapContext): ProductionBootstrapContext {
  if (!context || !context.metadata || !context.bootstrap) throw new Error("invalid_production_bootstrap_context");
  validateBootstrapInput(context.bootstrap);
  if (
    typeof context.metadata.storeId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(context.metadata.storeId) ||
    context.metadata.schemaVersion !== PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION
  )
    throw new Error("invalid_production_bootstrap_context");
  return Object.freeze({
    bootstrap: Object.freeze({
      principal: Object.freeze({ ...context.bootstrap.principal }),
      bootstrapOperationId: context.bootstrap.bootstrapOperationId,
      authorityGeneration: context.bootstrap.authorityGeneration,
      authorityRootIdentity: context.bootstrap.authorityRootIdentity,
    }),
    metadata: Object.freeze({ ...context.metadata }),
  });
}
function validateExpectedBootstrap(db: DatabaseSync, expected: ProductionBootstrapContext): ProductionStoreMetadata {
  const actual = validateBootstrap(db, expected.bootstrap);
  if (actual.storeId !== expected.metadata.storeId || actual.schemaVersion !== expected.metadata.schemaVersion)
    throw new Error("production_store_identity_mismatch");
  return actual;
}
function validateBootstrap(db: DatabaseSync, input: ProductionBootstrapInput): ProductionStoreMetadata {
  validatePhysicalSignature(db);
  const meta = metadata(db);
  const b = db.prepare("SELECT * FROM production_bootstrap").all() as any[];
  const p = db.prepare("SELECT * FROM production_partition").all() as any[];
  if (
    !meta ||
    b.length !== 1 ||
    p.length !== 1 ||
    b[0].store_id !== meta.storeId ||
    b[0].bootstrap_operation_id !== input.bootstrapOperationId ||
    b[0].continuity_id !== input.principal.continuityId ||
    b[0].companion_id !== input.principal.companionId ||
    b[0].player_id !== input.principal.playerId ||
    b[0].authority_generation !== input.authorityGeneration ||
    b[0].authority_root_identity !== input.authorityRootIdentity ||
    p[0].continuity_id !== input.principal.continuityId ||
    p[0].companion_id !== input.principal.companionId ||
    p[0].player_id !== input.principal.playerId
  )
    throw new Error("production_store_identity_mismatch");
  validateMaterialization(db);
  return meta;
}
function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;
}
function validateMaterialization(db: DatabaseSync): void {
  const boot = count(db, "production_bootstrap"),
    part = count(db, "production_partition");
  if ((boot === 0) !== (part === 0) || boot > 1 || part > 1)
    throw new Error("production_store_materialization_invalid");
  if (!part) {
    for (const table of tableNames)
      if (
        table !== "production_store_meta" &&
        table !== "production_bootstrap" &&
        table !== "production_game_session" &&
        table !== "production_game_lease" &&
        table !== "production_game_intent" &&
        count(db, table)
      )
        throw new Error("production_store_materialization_invalid");
    return;
  }
  const saga = db.prepare("SELECT * FROM production_initial_chat_saga WHERE singleton=1").get() as any;
  if (!saga) {
    for (const table of [
      "production_active_selection",
      "production_continuity_thread",
      "production_chat_lifecycle_metadata",
      "production_continuity_event",
      "production_chat_runtime_intent",
      "production_continuity_command",
      "production_saga_operation",
      "production_saga_receipt",
    ])
      if (count(db, table)) throw new Error("production_store_materialization_invalid");
    const quarantines = db.prepare("SELECT * FROM production_quarantine").all() as any[];
    if (
      quarantines.length > 1 ||
      (quarantines.length === 1 &&
        (quarantines[0].continuity_id !==
          db.prepare("SELECT continuity_id FROM production_bootstrap WHERE singleton=1").get()?.continuity_id ||
          quarantines[0].reason !== "abandoned_windows_root_mutex" ||
          quarantines[0].quarantine_id !== `abandoned-${metadata(db)?.storeId}`))
    )
      throw new Error("production_store_materialization_invalid");
    return;
  }
  if (
    !sha(saga.holder_binding_digest) ||
    !["claimed_empty", "chat_registered", "content_verified", "selected"].includes(saga.phase)
  )
    throw new Error("production_store_materialization_invalid");
  const operations = db.prepare("SELECT * FROM production_saga_operation").all() as any[];
  const receipts = db.prepare("SELECT * FROM production_saga_receipt").all() as any[];
  if (
    operations.length !== receipts.length ||
    operations.some((o) => {
      const r = receipts.find((r) => r.operation_id === o.operation_id);
      return (
        !r ||
        o.step !== r.step ||
        o.request_json !== r.request_json ||
        o.request_digest !== r.request_digest ||
        o.response_json !== r.response_json ||
        o.response_digest !== r.response_digest ||
        o.committed_vector_json !== r.committed_vector_json ||
        digest(parse(o.request_json)) !== o.request_digest ||
        digest(parse(o.response_json)) !== o.response_digest ||
        canonical(parse(o.committed_vector_json)) !== o.committed_vector_json ||
        !validVector(parse(o.committed_vector_json))
      );
    })
  )
    throw new Error("production_store_materialization_invalid");
  const expectedSteps =
    saga.phase === "claimed_empty"
      ? ["claim_empty"]
      : saga.phase === "chat_registered"
        ? ["claim_empty", "register_exact"]
        : saga.phase === "content_verified"
          ? ["claim_empty", "register_exact", "verify_exact_content"]
          : ["claim_empty", "register_exact", "verify_exact_content", "select_open"];
  const orderedOperations = expectedSteps.map((step) => operations.find((o) => o.step === step));
  if (
    operations.length !== expectedSteps.length ||
    orderedOperations.some((o) => !o) ||
    orderedOperations.some((o, index) => {
      const vector = parse(o!.committed_vector_json);
      return (
        vector.partitionRevision !== index + 2 ||
        vector.fenceEpoch !== index + 2 ||
        vector.selectionRevision !== (index === 3 ? 1 : 0)
      );
    })
  )
    throw new Error("production_store_materialization_invalid");
  for (let index = 0; index < orderedOperations.length; index++) {
    const operation = orderedOperations[index]!;
    if (!validOperationHolderBinding(saga, operation, index))
      throw new Error("production_store_materialization_invalid");
    const expected = expectedOperationResponse(db, operation.step);
    if (
      operation.response_json !== canonical(expected) ||
      operation.response_digest !== digest(expected) ||
      operation.committed_vector_json !== canonical(expected.vector)
    )
      throw new Error("production_store_materialization_invalid");
  }
  const p = db.prepare("SELECT * FROM production_partition WHERE singleton=1").get() as any;
  const chat = db.prepare("SELECT * FROM production_surface_session WHERE surface='chat'").all() as any[],
    thread = db.prepare("SELECT * FROM production_continuity_thread").all() as any[],
    lifecycle = db.prepare("SELECT * FROM production_chat_lifecycle_metadata").all() as any[],
    event = db.prepare("SELECT * FROM production_continuity_event").all() as any[],
    selection = db.prepare("SELECT * FROM production_active_selection").all() as any[];
  const games = db.prepare("SELECT * FROM production_game_session").all() as any[];
  const leases = db.prepare("SELECT * FROM production_game_lease").all() as any[];
  const intents = db.prepare("SELECT * FROM production_game_intent").all() as any[];
  const chatRuntimeIntents = db.prepare("SELECT * FROM production_chat_runtime_intent").all() as any[];
  const bootstrap = db
    .prepare("SELECT continuity_id,companion_id,player_id FROM production_bootstrap WHERE singleton=1")
    .get() as any;
  const liveGames = games.filter((g) => g.state !== "ended"),
    liveGameState = null,
    successorActive = false,
    successorEnter = false;
  if (
    liveGames.length > 1 ||
    games.some(
      (g) =>
        g.continuity_id !== p?.continuity_id ||
        !safeId(g.session_id) ||
        !["pending", "active", "ended", "recovery_required"].includes(g.state) ||
        !db
          .prepare(
            "SELECT 1 FROM production_surface_session WHERE session_id=? AND continuity_id=? AND surface='game' AND state=?",
          )
          .get(g.session_id, p.continuity_id, g.state),
    ) ||
    leases.length > 1 ||
    leases.some(
      (l) =>
        l.continuity_id !== p?.continuity_id ||
        !games.some((g) => g.session_id === l.session_id) ||
        !["owned", "close_pending", "recovery_required"].includes(l.state),
    ) ||
    chatRuntimeIntents.some((intent) => !validPersistedChatRuntimeIntent(db, intent, p, bootstrap)) ||
    !validPersistedChatRuntimeTeardownIntents(db, p, bootstrap)
  )
    throw new Error("production_store_materialization_invalid");
  const chatRuntimeState = currentChatRuntimeState(db, chatRuntimeIntents);
  if (count(db, "production_continuity_command")) {
    validateV35ChatExtension(
      db,
      saga,
      p,
      chat,
      thread,
      lifecycle,
      event,
      selection,
      liveGameState,
      successorActive,
      successorEnter,
      chatRuntimeState,
      bootstrap,
    );
    return;
  }
  if (
    !p ||
    p.continuity_id !==
      db.prepare("SELECT continuity_id FROM production_bootstrap WHERE singleton=1").get()?.continuity_id ||
    p.companion_id !==
      db.prepare("SELECT companion_id FROM production_bootstrap WHERE singleton=1").get()?.companion_id ||
    p.player_id !== db.prepare("SELECT player_id FROM production_bootstrap WHERE singleton=1").get()?.player_id ||
    p.partition_revision < expectedSteps.length + 1 ||
    p.fence_epoch < expectedSteps.length + 1 ||
    p.partition_revision !== p.fence_epoch ||
    p.selection_revision !== (saga.phase === "selected" ? 1 : 0) ||
    (saga.phase === "claimed_empty" &&
      (chat.length || thread.length || lifecycle.length || event.length || selection.length)) ||
    (saga.phase !== "claimed_empty" &&
      (chat.length !== 1 ||
        thread.length !== 1 ||
        lifecycle.length !== 1 ||
        event.length !== 1 ||
        selection.length !== (saga.phase === "selected" ? 1 : 0))) ||
    count(db, "production_continuity_command")
  )
    throw new Error("production_store_materialization_invalid");
  const quarantines = db.prepare("SELECT * FROM production_quarantine").all() as any[];
  if (
    quarantines.length > 1 ||
    (quarantines.length === 1 &&
      (quarantines[0].continuity_id !== p.continuity_id ||
        quarantines[0].reason !== "abandoned_windows_root_mutex" ||
        quarantines[0].quarantine_id !== `abandoned-${metadata(db)?.storeId}`))
  )
    throw new Error("production_store_materialization_invalid");
  if (saga.phase !== "claimed_empty") {
    const s = chat[0],
      t = thread[0],
      l = lifecycle[0],
      e = event[0];
    if (
      s.session_id !== saga.chat_surface_session_id ||
      s.continuity_id !== p.continuity_id ||
      s.surface !== "chat" ||
      s.state !==
        (chatRuntimeState !== null
          ? chatRuntimeState === "recovery_required"
            ? "recovery_required"
            : chatRuntimeState === "closed"
              ? "ended"
              : chatRuntimeState === "active"
                ? "active"
                : "suspended"
          : saga.phase === "selected"
            ? "active"
            : "suspended") ||
      s.created_at_ms !== 0 ||
      t.chat_surface_session_id !== s.session_id ||
      t.continuity_id !== p.continuity_id ||
      t.chat_thread_id !== saga.chat_thread_id ||
      t.companion_id !== p.companion_id ||
      t.lifecycle !== "active" ||
      l.chat_surface_session_id !== s.session_id ||
      l.management_revision !== 1 ||
      e.continuity_id !== p.continuity_id ||
      e.session_id !== s.session_id ||
      e.type !== "chat_registered" ||
      e.surface !== "chat" ||
      e.occurred_at_ms !== 0 ||
      (saga.phase === "selected" &&
        (selection[0].chat_surface_session_id !== s.session_id ||
          selection[0].chat_thread_id !== t.chat_thread_id ||
          selection[0].selection_revision !== 1))
    )
      throw new Error("production_store_materialization_invalid");
  }
  if (["content_verified", "selected"].includes(saga.phase)) {
    const receipt = parse(saga.receipt_json);
    if (
      !receipt ||
      digest(receipt) !== saga.receipt_digest ||
      !validReceipt(receipt) ||
      receipt.chatThreadId !== saga.chat_thread_id ||
      receipt.chatSurfaceSessionId !== saga.chat_surface_session_id ||
      receipt.continuityId !== p.continuity_id ||
      receipt.companionId !== p.companion_id
    )
      throw new Error("production_store_materialization_invalid");
  } else if (saga.receipt_json !== null || saga.receipt_digest !== null)
    throw new Error("production_store_materialization_invalid");
}
function parse(value: unknown): any {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
function selectedReadback(
  db: DatabaseSync,
): Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; selectionRevision: number }> | null {
  const row = db
    .prepare(
      "SELECT chat_thread_id,chat_surface_session_id,selection_revision FROM production_active_selection WHERE singleton=1",
    )
    .get() as any;
  return row
    ? Object.freeze({
        chatThreadId: row.chat_thread_id,
        chatSurfaceSessionId: row.chat_surface_session_id,
        selectionRevision: row.selection_revision,
      })
    : null;
}
function sagaVector(db: DatabaseSync): SagaVector {
  const p = db
    .prepare("SELECT partition_revision,fence_epoch,selection_revision FROM production_partition WHERE singleton=1")
    .get() as any;
  if (
    !p ||
    !positiveRevision(p.partition_revision) ||
    !positiveRevision(p.fence_epoch) ||
    !Number.isSafeInteger(p.selection_revision) ||
    p.selection_revision < 0
  )
    throw new Error("production_store_materialization_invalid");
  return Object.freeze({
    partitionRevision: p.partition_revision,
    fenceEpoch: p.fence_epoch,
    selectionRevision: p.selection_revision,
  });
}
function chatReadback(db: DatabaseSync, operationId: string, thread: any): ProductionChatCommandReadback {
  const metadata = db
    .prepare("SELECT management_revision FROM production_chat_lifecycle_metadata WHERE chat_surface_session_id=?")
    .get(thread.chat_surface_session_id) as any;
  if (!metadata || !positiveRevision(metadata.management_revision))
    throw new Error("production_store_materialization_invalid");
  const row = db
    .prepare("SELECT command_kind FROM production_continuity_command WHERE operation_id=?")
    .get(operationId) as any;
  const kind = row?.command_kind;
  if (!["register_chat", "verify_chat_content", "select_chat", "transition_chat_lifecycle"].includes(kind))
    throw new Error("production_store_materialization_invalid");
  return Object.freeze({
    operationId,
    kind,
    chatThreadId: thread.chat_thread_id,
    chatSurfaceSessionId: thread.chat_surface_session_id,
    lifecycle: thread.lifecycle,
    managementRevision: metadata.management_revision,
    vector: sagaVector(db),
    activeSelection: selectedReadback(db),
  });
}
function validChatInput(input: unknown): input is ProductionChatCommandInput {
  if (!input || typeof input !== "object") return false;
  const value = input as ProductionChatCommandInput;
  return (
    safeId(value.operationId) &&
    safeId(value.chatThreadId) &&
    safeId(value.chatSurfaceSessionId) &&
    validVector(value.expected)
  );
}
function validChatLifecycleInput(input: unknown): input is ProductionChatLifecycleInput {
  if (
    !validChatInput(input) ||
    !positiveRevision((input as ProductionChatLifecycleInput).expectedManagementRevision) ||
    !["archive", "trash", "restore"].includes((input as ProductionChatLifecycleInput).operation)
  )
    return false;
  return true;
}
function runChatCommand(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatCommandInput,
  kind: "register_chat" | "verify_chat_content" | "select_chat",
  receipt?: TavernExactContentReceipt,
): ProductionChatCommandReadback {
  if (!validChatInput(input) || (kind === "verify_chat_content" && !validReceipt(receipt)))
    throw new Error("invalid_chat_operation");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    const request = Object.freeze({
        kind,
        operationId: input.operationId,
        chatThreadId: input.chatThreadId,
        chatSurfaceSessionId: input.chatSurfaceSessionId,
        expected: input.expected,
        receipt: receipt ?? null,
      }),
      requestJson = canonical(request),
      requestDigest = digest(request);
    const old = db
      .prepare("SELECT * FROM production_continuity_command WHERE continuity_id=? AND operation_id=?")
      .get(bootstrap.bootstrap.principal.continuityId, input.operationId) as any;
    if (old) {
      if (old.command_kind !== kind || old.payload_json !== requestJson || old.payload_digest !== requestDigest)
        throw new Error("chat_operation_conflict");
      const response = parse(old.response_json);
      if (
        !validChatReadback(response) ||
        old.response_digest !== digest(response) ||
        old.committed_vector_json !== canonical(response.vector)
      )
        throw new Error("chat_receipt_corrupt");
      return freezeChatReadback(response);
    }
    const p = sagaVector(db);
    rejectChatRuntimeTransition(db);
    if (canonical(p) !== canonical(input.expected)) throw new Error("chat_vector_conflict");
    const initialSaga = db.prepare("SELECT phase FROM production_initial_chat_saga WHERE singleton=1").get() as any;
    if (initialSaga?.phase !== "selected") throw new Error("chat_initialization_incomplete");
    const principal = bootstrap.bootstrap.principal;
    const existing = db
      .prepare(
        "SELECT * FROM production_continuity_thread WHERE chat_surface_session_id=? OR (continuity_id=? AND chat_thread_id=?)",
      )
      .get(input.chatSurfaceSessionId, principal.continuityId, input.chatThreadId) as any;
    if (kind === "register_chat") {
      if (existing) throw new Error("chat_exact_binding_conflict");
      db.prepare("INSERT INTO production_surface_session VALUES(?,?,'chat','suspended',0,0)").run(
        input.chatSurfaceSessionId,
        principal.continuityId,
      );
      db.prepare(
        "INSERT INTO production_continuity_thread(chat_surface_session_id,continuity_id,chat_thread_id,companion_id,lifecycle,content_receipt_json,content_receipt_digest) VALUES(?,?,?,?, 'active',NULL,NULL)",
      ).run(input.chatSurfaceSessionId, principal.continuityId, input.chatThreadId, principal.companionId);
      db.prepare(
        "INSERT INTO production_chat_lifecycle_metadata(chat_surface_session_id,management_revision,trash_restore_lifecycle) VALUES(?,1,NULL)",
      ).run(input.chatSurfaceSessionId);
      db.prepare("INSERT INTO production_continuity_event VALUES(?,?,?,'chat_registered','chat',0)").run(
        `event-${input.operationId}`,
        principal.continuityId,
        input.chatSurfaceSessionId,
      );
    } else {
      if (
        !existing ||
        existing.continuity_id !== principal.continuityId ||
        existing.chat_thread_id !== input.chatThreadId ||
        existing.companion_id !== principal.companionId
      )
        throw new Error("chat_exact_binding_conflict");
      if (kind === "verify_chat_content") {
        if (existing.lifecycle !== "active" || existing.content_receipt_json !== null)
          throw new Error("chat_transition_invalid");
        if (
          receipt!.chatThreadId !== input.chatThreadId ||
          receipt!.chatSurfaceSessionId !== input.chatSurfaceSessionId ||
          receipt!.continuityId !== principal.continuityId ||
          receipt!.companionId !== principal.companionId
        )
          throw new Error("content_receipt_invalid");
        db.prepare(
          "UPDATE production_continuity_thread SET content_receipt_json=?,content_receipt_digest=? WHERE chat_surface_session_id=?",
        ).run(canonical(receipt), digest(receipt), input.chatSurfaceSessionId);
      } else {
        if (existing.lifecycle !== "active" || !existing.content_receipt_json || !existing.content_receipt_digest)
          throw new Error("chat_transition_invalid");
        const oldSelection = selectedReadback(db);
        const reselectingCurrent =
          oldSelection !== null &&
          oldSelection.chatThreadId === input.chatThreadId &&
          oldSelection.chatSurfaceSessionId === input.chatSurfaceSessionId;
        if (reselectingCurrent)
          requireSameChatRuntimeSuccessorBridge(
            db,
            principal.continuityId,
            input.expected,
            input.chatThreadId,
            input.chatSurfaceSessionId,
          );
        if (oldSelection && !reselectingCurrent)
          db.prepare("UPDATE production_surface_session SET state='suspended' WHERE session_id=?").run(
            oldSelection.chatSurfaceSessionId,
          );
        db.prepare("UPDATE production_surface_session SET state='active' WHERE session_id=?").run(
          input.chatSurfaceSessionId,
        );
        const nextSelection = p.selectionRevision + 1;
        db.prepare(
          "INSERT INTO production_active_selection(singleton,chat_surface_session_id,chat_thread_id,selection_revision) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET chat_surface_session_id=excluded.chat_surface_session_id,chat_thread_id=excluded.chat_thread_id,selection_revision=excluded.selection_revision",
        ).run(input.chatSurfaceSessionId, input.chatThreadId, nextSelection);
      }
    }
    db.prepare(
      "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1,selection_revision=selection_revision+? WHERE singleton=1",
    ).run(kind === "select_chat" ? 1 : 0);
    const thread = db
      .prepare("SELECT * FROM production_continuity_thread WHERE chat_surface_session_id=?")
      .get(input.chatSurfaceSessionId) as any;
    const command = Object.freeze({
      operationId: input.operationId,
      kind,
      chatThreadId: thread.chat_thread_id,
      chatSurfaceSessionId: thread.chat_surface_session_id,
      lifecycle: thread.lifecycle,
      managementRevision: (
        db
          .prepare("SELECT management_revision FROM production_chat_lifecycle_metadata WHERE chat_surface_session_id=?")
          .get(thread.chat_surface_session_id) as any
      ).management_revision,
      vector: sagaVector(db),
      activeSelection: selectedReadback(db),
    });
    db.prepare("INSERT INTO production_continuity_command VALUES(?,?,?,?,?,?,?,?)").run(
      principal.continuityId,
      input.operationId,
      kind,
      requestJson,
      requestDigest,
      canonical(command),
      digest(command),
      canonical(command.vector),
    );
    return command;
  });
}
function runChatLifecycleCommand(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatLifecycleInput,
): ProductionChatCommandReadback {
  if (!validChatLifecycleInput(input)) throw new Error("invalid_chat_operation");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    const request = Object.freeze({
        kind: "transition_chat_lifecycle",
        operationId: input.operationId,
        chatThreadId: input.chatThreadId,
        chatSurfaceSessionId: input.chatSurfaceSessionId,
        expectedManagementRevision: input.expectedManagementRevision,
        expected: input.expected,
        operation: input.operation,
      }),
      requestJson = canonical(request),
      requestDigest = digest(request),
      principal = bootstrap.bootstrap.principal,
      old = db
        .prepare("SELECT * FROM production_continuity_command WHERE continuity_id=? AND operation_id=?")
        .get(principal.continuityId, input.operationId) as any;
    if (old) {
      if (old.command_kind !== request.kind || old.payload_json !== requestJson || old.payload_digest !== requestDigest)
        throw new Error("chat_operation_conflict");
      const response = parse(old.response_json);
      if (
        !validChatReadback(response) ||
        old.response_digest !== digest(response) ||
        old.committed_vector_json !== canonical(response.vector)
      )
        throw new Error("chat_receipt_corrupt");
      return freezeChatReadback(response);
    }
    rejectChatRuntimeTransition(db);
    if (canonical(sagaVector(db)) !== canonical(input.expected)) throw new Error("chat_vector_conflict");
    const initialSaga = db.prepare("SELECT phase FROM production_initial_chat_saga WHERE singleton=1").get() as any;
    if (initialSaga?.phase !== "selected") throw new Error("chat_initialization_incomplete");
    const thread = db
        .prepare(
          "SELECT * FROM production_continuity_thread WHERE chat_surface_session_id=? AND continuity_id=? AND chat_thread_id=?",
        )
        .get(input.chatSurfaceSessionId, principal.continuityId, input.chatThreadId) as any,
      metadata = db
        .prepare("SELECT * FROM production_chat_lifecycle_metadata WHERE chat_surface_session_id=?")
        .get(input.chatSurfaceSessionId) as any;
    if (
      !thread ||
      !metadata ||
      metadata.management_revision !== input.expectedManagementRevision ||
      thread.content_receipt_json === null ||
      thread.content_receipt_digest === null
    )
      throw new Error("chat_lifecycle_conflict");
    const selected = selectedReadback(db);
    if (selected?.chatSurfaceSessionId === input.chatSurfaceSessionId)
      throw new Error("chat_selected_lifecycle_forbidden");
    let lifecycle: ProductionChatLifecycle,
      restore: null | "active" | "archived" = null;
    if (input.operation === "archive") {
      if (thread.lifecycle !== "active") throw new Error("chat_transition_invalid");
      lifecycle = "archived";
    } else if (input.operation === "trash") {
      if (thread.lifecycle !== "active" && thread.lifecycle !== "archived") throw new Error("chat_transition_invalid");
      lifecycle = "trashed";
      restore = thread.lifecycle;
    } else {
      if (thread.lifecycle !== "trashed" || !metadata.trash_restore_lifecycle)
        throw new Error("chat_transition_invalid");
      lifecycle = metadata.trash_restore_lifecycle;
    }
    db.prepare("UPDATE production_continuity_thread SET lifecycle=? WHERE chat_surface_session_id=?").run(
      lifecycle,
      input.chatSurfaceSessionId,
    );
    db.prepare(
      "UPDATE production_chat_lifecycle_metadata SET management_revision=management_revision+1,trash_restore_lifecycle=? WHERE chat_surface_session_id=?",
    ).run(input.operation === "trash" ? restore : null, input.chatSurfaceSessionId);
    db.prepare("UPDATE production_surface_session SET state=? WHERE session_id=?").run(
      lifecycle === "active" ? "suspended" : "ended",
      input.chatSurfaceSessionId,
    );
    db.prepare(
      "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1 WHERE singleton=1",
    ).run();
    const updated = db
        .prepare("SELECT * FROM production_continuity_thread WHERE chat_surface_session_id=?")
        .get(input.chatSurfaceSessionId) as any,
      command = Object.freeze({
        operationId: input.operationId,
        kind: "transition_chat_lifecycle" as const,
        chatThreadId: updated.chat_thread_id,
        chatSurfaceSessionId: updated.chat_surface_session_id,
        lifecycle: updated.lifecycle,
        managementRevision: (
          db
            .prepare(
              "SELECT management_revision FROM production_chat_lifecycle_metadata WHERE chat_surface_session_id=?",
            )
            .get(updated.chat_surface_session_id) as any
        ).management_revision,
        vector: sagaVector(db),
        activeSelection: selectedReadback(db),
      });
    db.prepare("INSERT INTO production_continuity_command VALUES(?,?,?,?,?,?,?,?)").run(
      principal.continuityId,
      input.operationId,
      command.kind,
      requestJson,
      requestDigest,
      canonical(command),
      digest(command),
      canonical(command.vector),
    );
    return command;
  });
}
function rejectChatRuntimeTransition(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM production_chat_runtime_intent WHERE status IN ('pending','recovery_required')").get())
    throw new Error("chat_runtime_transition_pending");
  if (
    db
      .prepare("SELECT 1 FROM production_chat_runtime_teardown_intent WHERE status IN ('pending','recovery_required')")
      .get()
  )
    throw new Error("chat_runtime_transition_pending");
}
type ChatRuntimeSuccessorAdmission = Readonly<{ predecessor: any; teardown: any; bridge: any }>;
function requireSameChatRuntimeSuccessorBridge(
  db: DatabaseSync,
  continuityId: string,
  expected: SagaVector,
  chatThreadId: string,
  chatSurfaceSessionId: string,
): void {
  const predecessors = db
    .prepare(
      "SELECT operation_id FROM production_chat_runtime_intent WHERE continuity_id=? AND status='terminal' AND chat_thread_id=? AND chat_surface_session_id=?",
    )
    .all(continuityId, chatThreadId, chatSurfaceSessionId) as Array<{ operation_id: string }>;
  const matches = predecessors.filter((predecessor) => {
    const teardown = db
      .prepare(
        "SELECT committed_vector_json FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND bootstrap_operation_id=? AND status='terminal'",
      )
      .get(continuityId, predecessor.operation_id) as { committed_vector_json?: string } | undefined;
    if (!teardown?.committed_vector_json) return false;
    const committed = parse(teardown.committed_vector_json);
    return validStoredVector(committed) && canonical(committed) === canonical(expected);
  });
  if (matches.length !== 1) throw new Error("chat_runtime_reentry_selection_invalid");
}
function chatRuntimeSuccessorAdmissions(
  db: DatabaseSync,
  input: Readonly<{ continuityId: string; expected: SagaVector; chatThreadId: string; chatSurfaceSessionId: string }>,
): ChatRuntimeSuccessorAdmission[] {
  const predecessors = db
    .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=? AND status='terminal'")
    .all(input.continuityId) as any[];
  const bridges = db
    .prepare(
      "SELECT payload_json,response_json FROM production_continuity_command WHERE continuity_id=? AND command_kind='select_chat'",
    )
    .all(input.continuityId) as any[];
  const admissions: ChatRuntimeSuccessorAdmission[] = [];
  for (const predecessor of predecessors) {
    const teardown = db
      .prepare(
        "SELECT * FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND bootstrap_operation_id=?",
      )
      .get(input.continuityId, predecessor.operation_id) as any;
    if (!teardown || teardown.status !== "terminal") continue;
    const teardownVector = parse(teardown.committed_vector_json);
    if (!validStoredVector(teardownVector)) continue;
    const matches = bridges.filter((bridge) => {
      const payload = parse(bridge.payload_json),
        response = parse(bridge.response_json);
      return (
        validStoredVector(payload?.expected) &&
        canonical(payload.expected) === canonical(teardownVector) &&
        validStoredVector(response?.vector) &&
        canonical(response.vector) === canonical(input.expected) &&
        response.chatThreadId === input.chatThreadId &&
        response.chatSurfaceSessionId === input.chatSurfaceSessionId
      );
    });
    if (matches.length === 1) admissions.push({ predecessor, teardown, bridge: matches[0] });
  }
  return admissions;
}
function requireChatRuntimeSuccessorAdmission(db: DatabaseSync, input: ProductionChatRuntimeRequest): void {
  const rows = db
    .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=?")
    .all(input.principal.continuityId) as any[];
  if (!rows.length) {
    const initial = db
      .prepare("SELECT response_json,committed_vector_json FROM production_saga_operation WHERE step='select_open'")
      .all() as any[];
    const bridges = initial.filter((candidate) => {
      const response = parse(candidate.response_json),
        vector = parse(candidate.committed_vector_json);
      return (
        validStoredVector(vector) &&
        response?.phase === "selected" &&
        response?.vector &&
        canonical(response.vector) === canonical(vector)
      );
    });
    if (bridges.length !== 1 || canonical(input.expected) !== canonical(parse(bridges[0].committed_vector_json)))
      throw new Error("chat_runtime_chain_invalid");
    return;
  }
  // The predecessor is the unique terminal bootstrap whose exact teardown
  // vector is consumed by the unique select bridge producing this request's
  // expected vector. Operation-id order is not a temporal chain proof.
  if (
    chatRuntimeSuccessorAdmissions(db, {
      continuityId: input.principal.continuityId,
      expected: input.expected,
      chatThreadId: input.chatThreadId,
      chatSurfaceSessionId: input.chatSurfaceSessionId,
    }).length !== 1
  )
    throw new Error("chat_runtime_chain_invalid");
}
function validChatReadback(value: unknown): value is ProductionChatCommandReadback {
  if (!value || typeof value !== "object") return false;
  const v = value as any;
  return (
    safeId(v.operationId) &&
    ["register_chat", "verify_chat_content", "select_chat", "transition_chat_lifecycle"].includes(v.kind) &&
    safeId(v.chatThreadId) &&
    safeId(v.chatSurfaceSessionId) &&
    ["active", "archived", "trashed"].includes(v.lifecycle) &&
    positiveRevision(v.managementRevision) &&
    validVector(v.vector) &&
    (v.activeSelection === null ||
      (!!v.activeSelection &&
        safeId(v.activeSelection.chatThreadId) &&
        safeId(v.activeSelection.chatSurfaceSessionId) &&
        positiveRevision(v.activeSelection.selectionRevision)))
  );
}
function freezeChatReadback(value: ProductionChatCommandReadback): ProductionChatCommandReadback {
  return Object.freeze({
    operationId: value.operationId,
    kind: value.kind,
    chatThreadId: value.chatThreadId,
    chatSurfaceSessionId: value.chatSurfaceSessionId,
    lifecycle: value.lifecycle,
    managementRevision: value.managementRevision,
    vector: Object.freeze({ ...value.vector }),
    activeSelection: value.activeSelection === null ? null : Object.freeze({ ...value.activeSelection }),
  });
}
function readChatCatalog(db: DatabaseSync, bootstrap: ProductionBootstrapContext): ProductionChatCatalog {
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    const principal = bootstrap.bootstrap.principal,
      rows = db
        .prepare(
          "SELECT t.chat_thread_id,t.chat_surface_session_id,t.lifecycle,t.content_receipt_json,t.content_receipt_digest,m.management_revision FROM production_continuity_thread t JOIN production_chat_lifecycle_metadata m ON m.chat_surface_session_id=t.chat_surface_session_id WHERE t.continuity_id=? ORDER BY t.chat_surface_session_id",
        )
        .all(principal.continuityId) as any[];
    const threads = rows.map((row) => {
      const receipt = row.content_receipt_json === null ? null : parse(row.content_receipt_json);
      if (
        !safeId(row.chat_thread_id) ||
        !safeId(row.chat_surface_session_id) ||
        !["active", "archived", "trashed"].includes(row.lifecycle) ||
        !positiveRevision(row.management_revision) ||
        (receipt !== null && (!validReceipt(receipt) || row.content_receipt_digest !== digest(receipt)))
      )
        throw new Error("production_store_materialization_invalid");
      return Object.freeze({
        chatThreadId: row.chat_thread_id,
        chatSurfaceSessionId: row.chat_surface_session_id,
        lifecycle: row.lifecycle as ProductionChatLifecycle,
        managementRevision: row.management_revision,
        contentState: receipt === null ? ("registered" as const) : ("verified" as const),
      });
    });
    return Object.freeze({
      vector: sagaVector(db),
      activeSelection: selectedReadback(db),
      threads: Object.freeze(threads),
    });
  });
}
function validateV35ChatExtension(
  db: DatabaseSync,
  saga: any,
  p: any,
  chat: any[],
  threads: any[],
  metadataRows: any[],
  events: any[],
  selection: any[],
  liveGameState: any,
  successorActive: boolean,
  successorEnter: boolean,
  chatRuntimeState: "pending" | "recovery_required" | "active" | "closed" | null,
  bootstrap: any,
): void {
  const quarantines = db.prepare("SELECT * FROM production_quarantine").all() as any[];
  if (
    quarantines.length > 1 ||
    (quarantines.length === 1 &&
      (quarantines[0].continuity_id !== p?.continuity_id ||
        quarantines[0].reason !== "abandoned_windows_root_mutex" ||
        quarantines[0].quarantine_id !== `abandoned-${metadata(db)?.storeId}`))
  )
    throw new Error("production_store_materialization_invalid");
  if (
    !p ||
    saga.phase !== "selected" ||
    p.continuity_id !== bootstrap?.continuity_id ||
    p.companion_id !== bootstrap?.companion_id ||
    p.player_id !== bootstrap?.player_id ||
    p.partition_revision !== p.fence_epoch ||
    !positiveRevision(p.selection_revision) ||
    selection.length !== 1 ||
    selection[0].selection_revision !== p.selection_revision ||
    chat.length !== threads.length ||
    threads.length !== metadataRows.length ||
    threads.length !== events.length ||
    threads.length < 1
  )
    throw new Error("production_store_materialization_invalid");
  const selected = selection[0],
    knownSessions = new Map(chat.map((row) => [row.session_id, row]));
  const knownMetadata = new Map(metadataRows.map((row) => [row.chat_surface_session_id, row]));
  const selectedThread = threads.find(
    (row) =>
      row.chat_surface_session_id === selected.chat_surface_session_id &&
      row.chat_thread_id === selected.chat_thread_id,
  );
  if (
    !selectedThread ||
    selectedThread.lifecycle !== "active" ||
    selectedThread.content_receipt_json === null ||
    !knownMetadata.has(selected.chat_surface_session_id)
  )
    throw new Error("production_store_materialization_invalid");
  const seenThread = new Set<string>(),
    seenSession = new Set<string>();
  for (const thread of threads) {
    const session = knownSessions.get(thread.chat_surface_session_id),
      meta = knownMetadata.get(thread.chat_surface_session_id),
      receipt = thread.content_receipt_json === null ? null : parse(thread.content_receipt_json);
    if (
      !session ||
      !meta ||
      thread.continuity_id !== p.continuity_id ||
      thread.companion_id !== p.companion_id ||
      !safeId(thread.chat_thread_id) ||
      !safeId(thread.chat_surface_session_id) ||
      seenThread.has(thread.chat_thread_id) ||
      seenSession.has(thread.chat_surface_session_id) ||
      !["active", "archived", "trashed"].includes(thread.lifecycle) ||
      !positiveRevision(meta.management_revision) ||
      (receipt === null) !== (thread.content_receipt_digest === null) ||
      (receipt !== null &&
        (!validReceipt(receipt) ||
          digest(receipt) !== thread.content_receipt_digest ||
          receipt.chatThreadId !== thread.chat_thread_id ||
          receipt.chatSurfaceSessionId !== thread.chat_surface_session_id ||
          receipt.companionId !== p.companion_id ||
          receipt.continuityId !== p.continuity_id)) ||
      !(
        (thread.lifecycle === "active" &&
          session.state ===
            (thread.chat_surface_session_id === selected.chat_surface_session_id
              ? chatRuntimeState !== null
                ? chatRuntimeState === "recovery_required"
                  ? "recovery_required"
                  : chatRuntimeState === "closed"
                    ? "ended"
                    : chatRuntimeState === "active"
                      ? "active"
                      : "suspended"
                : "active"
              : "suspended")) ||
        ((thread.lifecycle === "archived" || thread.lifecycle === "trashed") && session.state === "ended")
      )
    )
      throw new Error("production_store_materialization_invalid");
    if (
      thread.lifecycle === "trashed"
        ? !["active", "archived"].includes(meta.trash_restore_lifecycle)
        : meta.trash_restore_lifecycle !== null
    )
      throw new Error("production_store_materialization_invalid");
    seenThread.add(thread.chat_thread_id);
    seenSession.add(thread.chat_surface_session_id);
  }
  for (const event of events)
    if (
      event.continuity_id !== p.continuity_id ||
      event.type !== "chat_registered" ||
      event.surface !== "chat" ||
      !knownSessions.has(event.session_id) ||
      event.occurred_at_ms !== 0
    )
      throw new Error("production_store_materialization_invalid");
  const commands = db
    .prepare("SELECT * FROM production_continuity_command WHERE continuity_id=?")
    .all(p.continuity_id) as any[];
  if (
    !commands.length ||
    new Set(commands.map((row) => row.operation_id)).size !== commands.length ||
    commands.some(
      (row) =>
        !safeId(row.operation_id) ||
        !["register_chat", "verify_chat_content", "select_chat", "transition_chat_lifecycle"].includes(
          row.command_kind,
        ) ||
        parse(row.payload_json) === null ||
        canonical(parse(row.payload_json)) !== row.payload_json ||
        row.payload_digest !== digest(parse(row.payload_json)) ||
        !validChatReadback(parse(row.response_json)) ||
        row.response_json !== canonical(parse(row.response_json)) ||
        row.response_digest !== digest(parse(row.response_json)) ||
        row.committed_vector_json !== canonical(parse(row.response_json).vector),
    )
  )
    throw new Error("production_store_materialization_invalid");
  validateV35ChatCommandTrail(db, saga, p, threads, metadataRows, events, selection, commands);
}

type V35TrailThread = {
  chatThreadId: string;
  chatSurfaceSessionId: string;
  lifecycle: ProductionChatLifecycle;
  managementRevision: number;
  receipt: TavernExactContentReceipt | null;
  trashRestoreLifecycle: "active" | "archived" | null;
};
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
function sameSagaVector(left: SagaVector, right: SagaVector): boolean {
  return (
    left.partitionRevision === right.partitionRevision &&
    left.fenceEpoch === right.fenceEpoch &&
    left.selectionRevision === right.selectionRevision
  );
}
/** Replays only the v37 Chat command ledger; Game transitions may create partition/fence gaps, never selection gaps. */
function validateV35ChatCommandTrail(
  db: DatabaseSync,
  saga: any,
  partition: any,
  threads: any[],
  metadataRows: any[],
  events: any[],
  selection: any[],
  commands: any[],
): void {
  const initialReceipt = parse(saga.receipt_json) as TavernExactContentReceipt | null;
  if (
    !validReceipt(initialReceipt) ||
    initialReceipt.chatThreadId !== saga.chat_thread_id ||
    initialReceipt.chatSurfaceSessionId !== saga.chat_surface_session_id
  )
    throw new Error("production_store_materialization_invalid");
  const model = new Map<string, V35TrailThread>();
  model.set(saga.chat_surface_session_id, {
    chatThreadId: saga.chat_thread_id,
    chatSurfaceSessionId: saga.chat_surface_session_id,
    lifecycle: "active",
    managementRevision: 1,
    receipt: initialReceipt,
    trashRestoreLifecycle: null,
  });
  let active: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; selectionRevision: number }> =
    Object.freeze({
      chatThreadId: saga.chat_thread_id as string,
      chatSurfaceSessionId: saga.chat_surface_session_id as string,
      selectionRevision: 1,
    });
  let previous: SagaVector | null = null;
  const seenExpected = new Set<string>();
  const ordered = commands
    .map((row) =>
      Object.freeze({
        row,
        request: parse(row.payload_json) as Record<string, unknown>,
        response: parse(row.response_json) as ProductionChatCommandReadback,
      }),
    )
    .sort(
      (left, right) =>
        ((left.request?.expected as SagaVector | undefined)?.partitionRevision ?? -1) -
        ((right.request?.expected as SagaVector | undefined)?.partitionRevision ?? -1),
    );
  for (const { row, request, response } of ordered) {
    if (!request || typeof request !== "object" || !response || typeof response !== "object")
      throw new Error("production_store_materialization_invalid");
    const kind = row.command_kind as ProductionChatCommandReadback["kind"],
      expected = request.expected as SagaVector;
    const baseKeys =
      kind === "transition_chat_lifecycle"
        ? [
            "kind",
            "operationId",
            "chatThreadId",
            "chatSurfaceSessionId",
            "expectedManagementRevision",
            "expected",
            "operation",
          ]
        : ["kind", "operationId", "chatThreadId", "chatSurfaceSessionId", "expected", "receipt"];
    if (
      !exactKeys(request, baseKeys) ||
      request.kind !== kind ||
      request.operationId !== row.operation_id ||
      !safeId(request.operationId) ||
      !safeId(request.chatThreadId) ||
      !safeId(request.chatSurfaceSessionId) ||
      !validVector(expected) ||
      expected.partitionRevision !== expected.fenceEpoch ||
      expected.selectionRevision !== active.selectionRevision ||
      !sameSagaVector(response.vector, {
        partitionRevision: expected.partitionRevision + 1,
        fenceEpoch: expected.fenceEpoch + 1,
        selectionRevision: expected.selectionRevision + (kind === "select_chat" ? 1 : 0),
      }) ||
      response.operationId !== row.operation_id ||
      response.kind !== kind ||
      response.chatThreadId !== request.chatThreadId ||
      response.chatSurfaceSessionId !== request.chatSurfaceSessionId
    )
      throw new Error("production_store_materialization_invalid");
    const expectedKey = canonical(expected);
    if (seenExpected.has(expectedKey)) throw new Error("production_store_materialization_invalid");
    seenExpected.add(expectedKey);
    if (
      previous !== null &&
      (expected.partitionRevision < previous.partitionRevision || expected.fenceEpoch < previous.fenceEpoch)
    )
      throw new Error("production_store_materialization_invalid");
    if (
      previous !== null &&
      (expected.partitionRevision === previous.partitionRevision || expected.fenceEpoch === previous.fenceEpoch) &&
      !sameSagaVector(expected, previous)
    )
      throw new Error("production_store_materialization_invalid");
    if (
      previous === null &&
      (expected.partitionRevision < 5 || expected.fenceEpoch < 5 || expected.selectionRevision !== 1)
    )
      throw new Error("production_store_materialization_invalid");
    const known = model.get(request.chatSurfaceSessionId as string);
    if (kind === "register_chat") {
      if (
        request.receipt !== null ||
        known ||
        [...model.values()].some((thread) => thread.chatThreadId === request.chatThreadId) ||
        response.lifecycle !== "active" ||
        response.managementRevision !== 1
      )
        throw new Error("production_store_materialization_invalid");
      model.set(request.chatSurfaceSessionId as string, {
        chatThreadId: request.chatThreadId as string,
        chatSurfaceSessionId: request.chatSurfaceSessionId as string,
        lifecycle: "active",
        managementRevision: 1,
        receipt: null,
        trashRestoreLifecycle: null,
      });
    } else if (kind === "verify_chat_content") {
      const receipt = request.receipt as TavernExactContentReceipt;
      if (
        !known ||
        known.lifecycle !== "active" ||
        known.receipt !== null ||
        !validReceipt(receipt) ||
        receipt.chatThreadId !== known.chatThreadId ||
        receipt.chatSurfaceSessionId !== known.chatSurfaceSessionId ||
        receipt.continuityId !== partition.continuity_id ||
        receipt.companionId !== partition.companion_id ||
        response.lifecycle !== "active" ||
        response.managementRevision !== known.managementRevision
      )
        throw new Error("production_store_materialization_invalid");
      known.receipt = receipt;
    } else if (kind === "select_chat") {
      if (
        request.receipt !== null ||
        !known ||
        known.lifecycle !== "active" ||
        known.receipt === null ||
        response.lifecycle !== "active" ||
        response.managementRevision !== known.managementRevision
      )
        throw new Error("production_store_materialization_invalid");
      active = Object.freeze({
        chatThreadId: known.chatThreadId,
        chatSurfaceSessionId: known.chatSurfaceSessionId,
        selectionRevision: expected.selectionRevision + 1,
      });
    } else {
      const operation = request.operation as ProductionChatLifecycleInput["operation"],
        expectedManagementRevision = request.expectedManagementRevision;
      if (
        !known ||
        known.receipt === null ||
        active.chatSurfaceSessionId === known.chatSurfaceSessionId ||
        !positiveRevision(expectedManagementRevision) ||
        expectedManagementRevision !== known.managementRevision ||
        !["archive", "trash", "restore"].includes(operation) ||
        response.managementRevision !== known.managementRevision + 1
      )
        throw new Error("production_store_materialization_invalid");
      if (operation === "archive") {
        if (known.lifecycle !== "active") throw new Error("production_store_materialization_invalid");
        known.lifecycle = "archived";
        known.trashRestoreLifecycle = null;
      } else if (operation === "trash") {
        if (known.lifecycle !== "active" && known.lifecycle !== "archived")
          throw new Error("production_store_materialization_invalid");
        known.trashRestoreLifecycle = known.lifecycle;
        known.lifecycle = "trashed";
      } else {
        if (known.lifecycle !== "trashed" || known.trashRestoreLifecycle === null)
          throw new Error("production_store_materialization_invalid");
        known.lifecycle = known.trashRestoreLifecycle;
        known.trashRestoreLifecycle = null;
      }
      known.managementRevision++;
      if (response.lifecycle !== known.lifecycle) throw new Error("production_store_materialization_invalid");
    }
    if (
      (response.activeSelection === null) !== false ||
      response.activeSelection.chatThreadId !== active.chatThreadId ||
      response.activeSelection.chatSurfaceSessionId !== active.chatSurfaceSessionId ||
      response.activeSelection.selectionRevision !== active.selectionRevision
    )
      throw new Error("production_store_materialization_invalid");
    previous = response.vector;
  }
  if (
    !previous ||
    partition.partition_revision < previous.partitionRevision ||
    partition.fence_epoch < previous.fenceEpoch ||
    partition.selection_revision !== active.selectionRevision ||
    selection[0].chat_thread_id !== active.chatThreadId ||
    selection[0].chat_surface_session_id !== active.chatSurfaceSessionId
  )
    throw new Error("production_store_materialization_invalid");
  const metadata = new Map(metadataRows.map((row) => [row.chat_surface_session_id, row]));
  const eventSessions = new Set<string>();
  for (const event of events) {
    if (!safeId(event.event_id) || eventSessions.has(event.session_id) || !model.has(event.session_id))
      throw new Error("production_store_materialization_invalid");
    eventSessions.add(event.session_id);
  }
  if (model.size !== threads.length || eventSessions.size !== model.size)
    throw new Error("production_store_materialization_invalid");
  for (const thread of threads) {
    const expected = model.get(thread.chat_surface_session_id),
      meta = metadata.get(thread.chat_surface_session_id);
    if (
      !expected ||
      !meta ||
      thread.chat_thread_id !== expected.chatThreadId ||
      thread.lifecycle !== expected.lifecycle ||
      meta.management_revision !== expected.managementRevision ||
      meta.trash_restore_lifecycle !== expected.trashRestoreLifecycle ||
      (expected.receipt === null) !== (thread.content_receipt_json === null) ||
      (expected.receipt !== null &&
        (thread.content_receipt_json !== canonical(expected.receipt) ||
          thread.content_receipt_digest !== digest(expected.receipt)))
    )
      throw new Error("production_store_materialization_invalid");
  }
}

function validChatRuntimeOwner(value: unknown): value is ProductionChatRuntimeOwner {
  return validGameOwner(value);
}
function validChatRuntimeRequest(input: unknown): input is ProductionChatRuntimeRequest {
  return validChatRuntimeRequestRecord(input, validVector);
}
function validStoredChatRuntimeRequest(input: unknown): input is ProductionChatRuntimeRequest {
  return validChatRuntimeRequestRecord(input, validStoredVector);
}
function validChatRuntimeTeardownRequest(input: unknown): input is ProductionChatRuntimeTeardownRequest {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const value = input as ProductionChatRuntimeTeardownRequest;
  return (
    validPrincipal(value.principal) &&
    safeId(value.operationId) &&
    safeId(value.requestId) &&
    safeId(value.bootstrapOperationId) &&
    safeId(value.chatThreadId) &&
    safeId(value.chatSurfaceSessionId) &&
    sha(value.runtimeBindingDigest) &&
    validChatRuntimeOwner(value.owner) &&
    Number.isSafeInteger(value.deadlineAtMs) &&
    value.deadlineAtMs >= 0 &&
    validVector(value.expected)
  );
}
function canonicalChatRuntimeTeardownRequest(input: ProductionChatRuntimeTeardownRequest): string {
  return canonical({
    principal: input.principal,
    operationId: input.operationId,
    requestId: input.requestId,
    bootstrapOperationId: input.bootstrapOperationId,
    chatThreadId: input.chatThreadId,
    chatSurfaceSessionId: input.chatSurfaceSessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    owner: input.owner,
    deadlineAtMs: input.deadlineAtMs,
    expected: input.expected,
  });
}
function canonicalValidChatRuntimeTeardownRequest(input: unknown): input is ProductionChatRuntimeTeardownRequest {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const value = input as Record<string, unknown>;
  const keys = [
    "principal",
    "operationId",
    "requestId",
    "bootstrapOperationId",
    "chatThreadId",
    "chatSurfaceSessionId",
    "runtimeBindingDigest",
    "owner",
    "deadlineAtMs",
    "expected",
  ];
  return (
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    validChatRuntimeTeardownRequest(input)
  );
}
function validChatRuntimeRequestRecord(
  input: unknown,
  vectorValidator: (value: unknown) => value is SagaVector,
): input is ProductionChatRuntimeRequest {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const value = input as ProductionChatRuntimeRequest;
  return (
    validPrincipal(value.principal) &&
    safeId(value.operationId) &&
    safeId(value.requestId) &&
    safeId(value.chatThreadId) &&
    safeId(value.chatSurfaceSessionId) &&
    sha(value.runtimeBindingDigest) &&
    validChatRuntimeOwner(value.owner) &&
    Number.isSafeInteger(value.deadlineAtMs) &&
    value.deadlineAtMs >= 0 &&
    vectorValidator(value.expected)
  );
}
function validChatRuntimePermitRequest(input: unknown): input is ProductionChatRuntimeRequest {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const value = input as ProductionChatRuntimeRequest;
  return (
    validPrincipal(value.principal) &&
    safeId(value.operationId) &&
    safeId(value.requestId) &&
    safeId(value.chatThreadId) &&
    safeId(value.chatSurfaceSessionId) &&
    sha(value.runtimeBindingDigest) &&
    validChatRuntimeOwner(value.owner) &&
    Number.isSafeInteger(value.deadlineAtMs) &&
    value.deadlineAtMs >= 0 &&
    validVector(value.expected)
  );
}
function canonicalValidChatRuntimeRequest(input: unknown): input is ProductionChatRuntimeRequest {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const value = input as Record<string, unknown>;
  const keys = [
    "principal",
    "operationId",
    "requestId",
    "chatThreadId",
    "chatSurfaceSessionId",
    "runtimeBindingDigest",
    "owner",
    "deadlineAtMs",
    "expected",
  ];
  return (
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    validChatRuntimeRequest(input)
  );
}
function canonicalChatRuntimeRequest(input: ProductionChatRuntimeRequest): string {
  return canonical({
    principal: input.principal,
    operationId: input.operationId,
    requestId: input.requestId,
    chatThreadId: input.chatThreadId,
    chatSurfaceSessionId: input.chatSurfaceSessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    owner: input.owner,
    deadlineAtMs: input.deadlineAtMs,
    expected: input.expected,
  });
}
function chatRuntimeTeardownReadback(db: DatabaseSync, row: any): ProductionChatRuntimeTeardownReadback {
  const request = parse(row.request_json) as ProductionChatRuntimeTeardownRequest | null;
  const receipt =
    row.receipt_json === null ? null : (parse(row.receipt_json) as ProductionChatRuntimeTeardownReceipt | null);
  if (!request || !["pending", "terminal", "recovery_required"].includes(row.status))
    throw new Error("production_store_materialization_invalid");
  return Object.freeze({
    operationId: row.operation_id,
    requestId: row.request_id,
    bootstrapOperationId: row.bootstrap_operation_id,
    chatThreadId: row.chat_thread_id,
    chatSurfaceSessionId: row.chat_surface_session_id,
    status: row.status,
    runtimeState: row.status === "pending" ? "pending" : row.status === "terminal" ? "closed" : "recovery_required",
    vector: Object.freeze(sagaVector(db)),
    receipt,
    recoveryReason: row.recovery_reason ?? null,
  });
}
function chatRuntimeTeardownPermitFrom(row: any): ProductionChatRuntimeTeardownPermit {
  const request = parse(row.request_json) as ProductionChatRuntimeTeardownRequest | null;
  if (!request) throw new Error("production_store_materialization_invalid");
  return Object.freeze({
    ...request,
    payloadDigest: row.payload_digest,
    fenceToken: row.fence_token,
    prepared: Object.freeze(parse(row.prepared_vector_json)),
  });
}
function validChatRuntimeTeardownPermit(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  permit: ProductionChatRuntimeTeardownPermit,
): any | null {
  if (
    !permit ||
    !canonicalValidChatRuntimeTeardownRequest({
      principal: permit.principal,
      operationId: permit.operationId,
      requestId: permit.requestId,
      bootstrapOperationId: permit.bootstrapOperationId,
      chatThreadId: permit.chatThreadId,
      chatSurfaceSessionId: permit.chatSurfaceSessionId,
      runtimeBindingDigest: permit.runtimeBindingDigest,
      owner: permit.owner,
      deadlineAtMs: permit.deadlineAtMs,
      expected: permit.expected,
    }) ||
    !validStoredVector(permit.prepared) ||
    !sha(permit.payloadDigest) ||
    !validFenceToken(permit.fenceToken)
  )
    return null;
  try {
    validateGamePrincipal(bootstrap, permit.principal);
  } catch {
    return null;
  }
  const requestJson = canonicalChatRuntimeTeardownRequest(permit);
  const row = db
    .prepare("SELECT * FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND operation_id=?")
    .get(permit.principal.continuityId, permit.operationId) as any;
  return row &&
    row.payload_digest === permit.payloadDigest &&
    row.request_json === requestJson &&
    row.request_id === permit.requestId &&
    row.bootstrap_operation_id === permit.bootstrapOperationId &&
    row.chat_thread_id === permit.chatThreadId &&
    row.chat_surface_session_id === permit.chatSurfaceSessionId &&
    row.runtime_binding_digest === permit.runtimeBindingDigest &&
    row.owner_json === canonical(permit.owner) &&
    row.fence_token === permit.fenceToken &&
    row.deadline_at_ms === permit.deadlineAtMs &&
    row.prepared_vector_json === canonical(permit.prepared)
    ? row
    : null;
}
function chatRuntimeReadback(db: DatabaseSync, row: any): ProductionChatRuntimeReadback {
  const request = parse(row.request_json) as ProductionChatRuntimeRequest | null;
  const receipt = row.receipt_json === null ? null : (parse(row.receipt_json) as ProductionChatRuntimeReceipt | null);
  if (!request || !["pending", "terminal", "recovery_required"].includes(row.status))
    throw new Error("production_store_materialization_invalid");
  return Object.freeze({
    operationId: row.operation_id,
    requestId: row.request_id,
    chatThreadId: row.chat_thread_id,
    chatSurfaceSessionId: row.chat_surface_session_id,
    status: row.status,
    runtimeState: row.status === "pending" ? "pending" : row.status === "terminal" ? "active" : "recovery_required",
    vector: Object.freeze(sagaVector(db)),
    receipt,
    recoveryReason: row.recovery_reason ?? null,
  });
}
function chatRuntimePermitFrom(row: any): ProductionChatRuntimePermit {
  const request = parse(row.request_json) as ProductionChatRuntimeRequest | null;
  if (!request) throw new Error("production_store_materialization_invalid");
  return Object.freeze({
    ...request,
    payloadDigest: row.payload_digest,
    fenceToken: row.fence_token,
    prepared: Object.freeze(parse(row.prepared_vector_json)),
  });
}
function validChatRuntimePermit(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  permit: ProductionChatRuntimePermit,
): any | null {
  if (
    !permit ||
    !canonicalValidChatRuntimeRequest({
      principal: permit.principal,
      operationId: permit.operationId,
      requestId: permit.requestId,
      chatThreadId: permit.chatThreadId,
      chatSurfaceSessionId: permit.chatSurfaceSessionId,
      runtimeBindingDigest: permit.runtimeBindingDigest,
      owner: permit.owner,
      deadlineAtMs: permit.deadlineAtMs,
      expected: permit.expected,
    }) ||
    !validStoredVector(permit.prepared) ||
    !sha(permit.payloadDigest) ||
    !validFenceToken(permit.fenceToken)
  )
    return null;
  try {
    validateGamePrincipal(bootstrap, permit.principal);
  } catch {
    return null;
  }
  const row = db
    .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id=?")
    .get(permit.principal.continuityId, permit.operationId) as any;
  return row &&
    row.payload_digest === permit.payloadDigest &&
    row.request_json ===
      canonicalChatRuntimeRequest({
        principal: permit.principal,
        operationId: permit.operationId,
        requestId: permit.requestId,
        chatThreadId: permit.chatThreadId,
        chatSurfaceSessionId: permit.chatSurfaceSessionId,
        runtimeBindingDigest: permit.runtimeBindingDigest,
        owner: permit.owner,
        deadlineAtMs: permit.deadlineAtMs,
        expected: permit.expected,
      }) &&
    row.fence_token === permit.fenceToken &&
    row.deadline_at_ms === permit.deadlineAtMs &&
    row.prepared_vector_json === canonical(permit.prepared)
    ? row
    : null;
}
function chatRuntimeReceiptMatches(
  row: any,
  receipt: unknown,
  kind: "chat_runtime_bootstrapped" | "chat_runtime_recovery_completed" = "chat_runtime_bootstrapped",
  mode: "live" | "persisted" = "live",
): receipt is ProductionChatRuntimeReceipt | ProductionChatRuntimeRecoveryReceipt {
  const request = parse(row.request_json) as ProductionChatRuntimeRequest | null;
  const keys = [
    "kind",
    "operationId",
    "requestId",
    "chatThreadId",
    "chatSurfaceSessionId",
    "runtimeBindingDigest",
    "owner",
    "fenceToken",
    "occurredAtMs",
  ];
  const exactReceiptObject = mode === "live" ? exactFrozenPlainDataObject : exactDataObject;
  if (!request || !exactReceiptObject(receipt, keys) || !validFenceToken(row.fence_token)) return false;
  const value = receipt as ProductionChatRuntimeReceipt | ProductionChatRuntimeRecoveryReceipt;
  // The terminal receipt is JSON-persisted. Its nested owner is therefore
  // reconstructed as a writable exact data record during readback even though
  // the live ingress receipt and nested owner were both frozen before commit.
  const exactOwnerObject = mode === "live" ? exactFrozenPlainDataObject : exactDataObject;
  return (
    exactOwnerObject(value.owner, ["ownerToken", "runtimeInstanceId", "ownerPid", "ownerProcessStartIdentity"]) &&
    value.kind === kind &&
    value.operationId === row.operation_id &&
    value.requestId === row.request_id &&
    value.chatThreadId === row.chat_thread_id &&
    value.chatSurfaceSessionId === row.chat_surface_session_id &&
    value.runtimeBindingDigest === request.runtimeBindingDigest &&
    canonical(value.owner) === row.owner_json &&
    value.fenceToken === row.fence_token &&
    Number.isSafeInteger(value.occurredAtMs) &&
    value.occurredAtMs >= row.prepared_at_ms &&
    (kind === "chat_runtime_recovery_completed" || value.occurredAtMs <= row.deadline_at_ms)
  );
}
function transitionChatRuntimeToRecovery(
  db: DatabaseSync,
  row: any,
  reason: ProductionChatRuntimeReadback["recoveryReason"],
): any {
  if (!reason) throw new Error("chat_runtime_recovery_reason_invalid");
  db.prepare(
    "UPDATE production_chat_runtime_intent SET status='recovery_required',recovery_reason=? WHERE continuity_id=? AND operation_id=?",
  ).run(reason, row.continuity_id, row.operation_id);
  db.prepare(
    "UPDATE production_surface_session SET state='recovery_required' WHERE session_id=? AND surface='chat'",
  ).run(row.chat_surface_session_id);
  db.prepare(
    "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1 WHERE singleton=1",
  ).run();
  return db
    .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id=?")
    .get(row.continuity_id, row.operation_id);
}
function recoverChatRuntime(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatRuntimeRecoveryInput,
): ProductionChatRuntimeReadback {
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    if (!productionChatRuntimeRecoveryProofs.has(input.proof as object) || input.proof.proof !== "proven_dead")
      throw new Error("chat_runtime_recovery_proof_invalid");
    const row = validChatRuntimePermit(db, bootstrap, input.permit);
    if (!row || canonical(input.proof.owner) !== row.owner_json) throw new Error("chat_runtime_recovery_proof_invalid");
    if (row.status === "terminal") {
      const stored = parse(row.receipt_json);
      if (!stored || digest(stored) !== digest(input.receipt) || stored.kind !== "chat_runtime_recovery_completed")
        throw new Error("chat_runtime_permit_conflict");
      return chatRuntimeReadback(db, row);
    }
    if (row.status !== "recovery_required") throw new Error("chat_runtime_recovery_proof_invalid");
    if (!chatRuntimeReceiptMatches(row, input.receipt, "chat_runtime_recovery_completed"))
      throw new Error("chat_runtime_receipt_invalid");
    db.prepare("UPDATE production_surface_session SET state='active' WHERE session_id=? AND surface='chat'").run(
      row.chat_surface_session_id,
    );
    db.prepare(
      "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1 WHERE singleton=1",
    ).run();
    const committed = sagaVector(db);
    db.prepare(
      "UPDATE production_chat_runtime_intent SET status='terminal',recovery_reason=NULL,committed_vector_json=?,receipt_json=?,receipt_digest=? WHERE continuity_id=? AND operation_id=?",
    ).run(canonical(committed), canonical(input.receipt), digest(input.receipt), row.continuity_id, row.operation_id);
    return chatRuntimeReadback(
      db,
      db
        .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id=?")
        .get(row.continuity_id, row.operation_id),
    );
  });
}
function prepareChatRuntime(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatRuntimeRequest,
  nowMs: () => number,
): ProductionChatRuntimePrepareOutcome {
  if (!validChatRuntimeRequest(input)) throw new Error("invalid_chat_runtime_operation");
  if (nowMs() >= input.deadlineAtMs) throw new Error("chat_runtime_deadline_expired");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const requestJson = canonicalChatRuntimeRequest(input),
      payloadDigest = digest(JSON.parse(requestJson)),
      old = db
        .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id=?")
        .get(input.principal.continuityId, input.operationId) as any;
    if (old) {
      if (
        old.payload_digest !== payloadDigest ||
        old.request_json !== requestJson ||
        old.request_id !== input.requestId
      )
        throw new Error("chat_runtime_operation_conflict");
      return Object.freeze({
        outcome:
          old.status === "pending" ? "effect_pending" : old.status === "terminal" ? "completed" : "recovery_required",
        permit: old.status === "pending" ? chatRuntimePermitFrom(old) : null,
        readback: chatRuntimeReadback(db, old),
      });
    }
    rejectChatRuntimeTransition(db);
    const p = sagaVector(db);
    if (canonical(p) !== canonical(input.expected)) throw new Error("chat_runtime_vector_conflict");
    requireChatRuntimeSuccessorAdmission(db, input);
    const selection = selectedReadback(db);
    const thread = db
      .prepare(
        "SELECT * FROM production_continuity_thread WHERE continuity_id=? AND chat_surface_session_id=? AND chat_thread_id=?",
      )
      .get(input.principal.continuityId, input.chatSurfaceSessionId, input.chatThreadId) as any;
    if (
      !selection ||
      selection.chatSurfaceSessionId !== input.chatSurfaceSessionId ||
      selection.chatThreadId !== input.chatThreadId ||
      selection.selectionRevision !== input.expected.selectionRevision ||
      !thread ||
      thread.lifecycle !== "active" ||
      thread.content_receipt_json === null ||
      thread.content_receipt_digest === null
    )
      throw new Error("chat_runtime_origin_conflict");
    const fenceToken = randomUUID().replaceAll("-", "");
    db.prepare("UPDATE production_surface_session SET state='suspended' WHERE session_id=? AND surface='chat'").run(
      input.chatSurfaceSessionId,
    );
    db.prepare(
      "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1 WHERE singleton=1",
    ).run();
    const prepared = sagaVector(db);
    const preparedAtMs = nowMs();
    if (preparedAtMs >= input.deadlineAtMs) throw new Error("chat_runtime_deadline_expired");
    db.prepare(
      "INSERT INTO production_chat_runtime_intent(continuity_id,operation_id,request_id,chat_surface_session_id,chat_thread_id,payload_digest,request_json,status,runtime_binding_digest,owner_json,fence_token,deadline_at_ms,prepared_at_ms,prepared_vector_json,committed_vector_json,receipt_json,receipt_digest,recovery_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      input.principal.continuityId,
      input.operationId,
      input.requestId,
      input.chatSurfaceSessionId,
      input.chatThreadId,
      payloadDigest,
      requestJson,
      "pending",
      input.runtimeBindingDigest,
      canonical(input.owner),
      fenceToken,
      input.deadlineAtMs,
      preparedAtMs,
      canonical(prepared),
      null,
      null,
      null,
      null,
    );
    const row = db
      .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id=?")
      .get(input.principal.continuityId, input.operationId) as any;
    return Object.freeze({
      outcome: "effect_owned" as const,
      permit: chatRuntimePermitFrom(row),
      readback: chatRuntimeReadback(db, row),
    });
  });
}
function commitChatRuntime(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatRuntimeTerminalInput,
  nowMs: () => number,
): ProductionChatRuntimeReadback {
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const row = validChatRuntimePermit(db, bootstrap, input.permit);
    if (!row) throw new Error("chat_runtime_permit_conflict");
    if (row.status === "terminal") {
      const stored = parse(row.receipt_json);
      if (!stored || digest(stored) !== digest(input.receipt)) throw new Error("chat_runtime_permit_conflict");
      return chatRuntimeReadback(db, row);
    }
    if (row.status !== "pending") throw new Error("chat_runtime_permit_conflict");
    if (nowMs() >= row.deadline_at_ms)
      return chatRuntimeReadback(db, transitionChatRuntimeToRecovery(db, row, "deadline_expired"));
    if (!chatRuntimeReceiptMatches(row, input.receipt))
      return chatRuntimeReadback(db, transitionChatRuntimeToRecovery(db, row, "receipt_invalid"));
    if (canonical(sagaVector(db)) !== row.prepared_vector_json)
      return chatRuntimeReadback(db, transitionChatRuntimeToRecovery(db, row, "revision_conflict"));
    db.prepare("UPDATE production_surface_session SET state='active' WHERE session_id=? AND surface='chat'").run(
      row.chat_surface_session_id,
    );
    db.prepare(
      "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1 WHERE singleton=1",
    ).run();
    const committed = sagaVector(db);
    db.prepare(
      "UPDATE production_chat_runtime_intent SET status='terminal',committed_vector_json=?,receipt_json=?,receipt_digest=? WHERE continuity_id=? AND operation_id=?",
    ).run(canonical(committed), canonical(input.receipt), digest(input.receipt), row.continuity_id, row.operation_id);
    return chatRuntimeReadback(
      db,
      db
        .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id=?")
        .get(row.continuity_id, row.operation_id),
    );
  });
}
function prepareChatRuntimeTeardown(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatRuntimeTeardownRequest,
  nowMs: () => number,
): ProductionChatRuntimeTeardownPrepareOutcome {
  if (!validChatRuntimeTeardownRequest(input)) throw new Error("invalid_chat_runtime_teardown_operation");
  if (nowMs() >= input.deadlineAtMs) throw new Error("chat_runtime_teardown_deadline_expired");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const requestJson = canonicalChatRuntimeTeardownRequest(input),
      payloadDigest = digest(JSON.parse(requestJson)),
      old = db
        .prepare("SELECT * FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND operation_id=?")
        .get(input.principal.continuityId, input.operationId) as any;
    if (old) {
      if (
        old.payload_digest !== payloadDigest ||
        old.request_json !== requestJson ||
        old.request_id !== input.requestId
      )
        throw new Error("chat_runtime_teardown_operation_conflict");
      return Object.freeze({
        outcome:
          old.status === "pending"
            ? ("effect_pending" as const)
            : old.status === "terminal"
              ? ("completed" as const)
              : ("recovery_required" as const),
        permit: old.status === "pending" ? chatRuntimeTeardownPermitFrom(old) : null,
        readback: chatRuntimeTeardownReadback(db, old),
      });
    }
    rejectChatRuntimeTransition(db);
    const predecessor = db
      .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id=?")
      .get(input.principal.continuityId, input.bootstrapOperationId) as any;
    if (
      !predecessor ||
      predecessor.status !== "terminal" ||
      predecessor.chat_thread_id !== input.chatThreadId ||
      predecessor.chat_surface_session_id !== input.chatSurfaceSessionId ||
      predecessor.runtime_binding_digest !== input.runtimeBindingDigest ||
      predecessor.owner_json !== canonical(input.owner) ||
      !predecessor.receipt_json ||
      !["chat_runtime_bootstrapped", "chat_runtime_recovery_completed"].includes(parse(predecessor.receipt_json)?.kind)
    )
      throw new Error("chat_runtime_teardown_predecessor_invalid");
    if (
      db
        .prepare(
          "SELECT 1 FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND bootstrap_operation_id=?",
        )
        .get(input.principal.continuityId, input.bootstrapOperationId)
    )
      throw new Error("chat_runtime_teardown_operation_conflict");
    const p = sagaVector(db);
    if (
      canonical(p) !== canonical(input.expected) ||
      canonical(parse(predecessor.committed_vector_json)) !== canonical(input.expected)
    )
      throw new Error("chat_runtime_teardown_vector_conflict");
    const session = db
      .prepare("SELECT state FROM production_surface_session WHERE session_id=? AND surface='chat'")
      .get(input.chatSurfaceSessionId) as any;
    if (!session || session.state !== "active") throw new Error("chat_runtime_teardown_origin_invalid");
    db.prepare("UPDATE production_surface_session SET state='suspended' WHERE session_id=? AND surface='chat'").run(
      input.chatSurfaceSessionId,
    );
    db.prepare(
      "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1 WHERE singleton=1",
    ).run();
    const prepared = sagaVector(db),
      preparedAtMs = nowMs();
    if (preparedAtMs >= input.deadlineAtMs) throw new Error("chat_runtime_teardown_deadline_expired");
    const fenceToken = randomUUID().replaceAll("-", "");
    db.prepare(
      "INSERT INTO production_chat_runtime_teardown_intent(continuity_id,operation_id,request_id,bootstrap_operation_id,chat_surface_session_id,chat_thread_id,payload_digest,request_json,status,runtime_binding_digest,owner_json,fence_token,deadline_at_ms,prepared_at_ms,prepared_vector_json,committed_vector_json,receipt_json,receipt_digest,recovery_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      input.principal.continuityId,
      input.operationId,
      input.requestId,
      input.bootstrapOperationId,
      input.chatSurfaceSessionId,
      input.chatThreadId,
      payloadDigest,
      requestJson,
      "pending",
      input.runtimeBindingDigest,
      canonical(input.owner),
      fenceToken,
      input.deadlineAtMs,
      preparedAtMs,
      canonical(prepared),
      null,
      null,
      null,
      null,
    );
    const row = db
      .prepare("SELECT * FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND operation_id=?")
      .get(input.principal.continuityId, input.operationId) as any;
    return Object.freeze({
      outcome: "effect_owned" as const,
      permit: chatRuntimeTeardownPermitFrom(row),
      readback: chatRuntimeTeardownReadback(db, row),
    });
  });
}
function transitionChatRuntimeTeardownToRecovery(
  db: DatabaseSync,
  row: any,
  reason: Extract<
    ProductionChatRuntimeTeardownReadback["recoveryReason"],
    "effect_failed" | "receipt_invalid" | "deadline_expired"
  >,
  nowMs: () => number,
): any {
  if (canonical(sagaVector(db)) !== row.prepared_vector_json)
    throw new Error("chat_runtime_teardown_revision_conflict");
  db.prepare(
    "UPDATE production_chat_runtime_teardown_intent SET status='recovery_required',recovery_reason=? WHERE continuity_id=? AND operation_id=?",
  ).run(reason, row.continuity_id, row.operation_id);
  db.prepare(
    "UPDATE production_surface_session SET state='recovery_required',updated_at_ms=? WHERE session_id=? AND surface='chat'",
  ).run(nowMs(), row.chat_surface_session_id);
  db.prepare(
    "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1 WHERE singleton=1",
  ).run();
  return db
    .prepare("SELECT * FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND operation_id=?")
    .get(row.continuity_id, row.operation_id);
}
function commitChatRuntimeTeardown(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatRuntimeTeardownTerminalInput,
  nowMs: () => number,
): ProductionChatRuntimeTeardownReadback {
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const row = validChatRuntimeTeardownPermit(db, bootstrap, input.permit);
    if (!row) throw new Error("chat_runtime_teardown_permit_conflict");
    if (row.status === "terminal") {
      const stored = parse(row.receipt_json);
      if (!stored || digest(stored) !== digest(input.receipt)) throw new Error("chat_runtime_teardown_permit_conflict");
      return chatRuntimeTeardownReadback(db, row);
    }
    if (row.status !== "pending") throw new Error("chat_runtime_teardown_permit_conflict");
    const currentNow = nowMs();
    if (currentNow >= row.deadline_at_ms)
      return chatRuntimeTeardownReadback(
        db,
        transitionChatRuntimeTeardownToRecovery(db, row, "deadline_expired", nowMs),
      );
    if (!teardownReceiptMatches(row, input.receipt))
      return chatRuntimeTeardownReadback(
        db,
        transitionChatRuntimeTeardownToRecovery(db, row, "receipt_invalid", nowMs),
      );
    if (canonical(sagaVector(db)) !== row.prepared_vector_json)
      throw new Error("chat_runtime_teardown_revision_conflict");
    db.prepare(
      "UPDATE production_surface_session SET state='ended',updated_at_ms=? WHERE session_id=? AND surface='chat'",
    ).run(input.receipt.occurredAtMs, row.chat_surface_session_id);
    db.prepare(
      "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1 WHERE singleton=1",
    ).run();
    const committed = sagaVector(db);
    db.prepare(
      "UPDATE production_chat_runtime_teardown_intent SET status='terminal',committed_vector_json=?,receipt_json=?,receipt_digest=? WHERE continuity_id=? AND operation_id=?",
    ).run(canonical(committed), canonical(input.receipt), digest(input.receipt), row.continuity_id, row.operation_id);
    return chatRuntimeTeardownReadback(
      db,
      db
        .prepare("SELECT * FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND operation_id=?")
        .get(row.continuity_id, row.operation_id),
    );
  });
}
function failChatRuntimeTeardown(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatRuntimeTeardownFailureInput,
  nowMs: () => number,
): ProductionChatRuntimeTeardownReadback {
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const row = validChatRuntimeTeardownPermit(db, bootstrap, input.permit);
    if (!row) throw new Error("chat_runtime_teardown_permit_conflict");
    if (row.status !== "pending") return chatRuntimeTeardownReadback(db, row);
    return chatRuntimeTeardownReadback(db, transitionChatRuntimeTeardownToRecovery(db, row, "effect_failed", nowMs));
  });
}
function teardownRecoveryReceiptMatches(
  row: any,
  receipt: unknown,
  mode: "live" | "persisted" = "live",
): receipt is ProductionChatRuntimeTeardownRecoveryReceipt {
  const keys = [
    "kind",
    "operationId",
    "requestId",
    "bootstrapOperationId",
    "chatThreadId",
    "chatSurfaceSessionId",
    "runtimeBindingDigest",
    "owner",
    "fenceToken",
    "occurredAtMs",
  ];
  const exactReceiptObject = mode === "live" ? exactFrozenPlainDataObject : exactDataObject;
  if (!row || !exactReceiptObject(receipt, keys) || !validFenceToken(row.fence_token)) return false;
  const request = parse(row.request_json) as ProductionChatRuntimeTeardownRequest | null;
  const value = receipt as ProductionChatRuntimeTeardownRecoveryReceipt;
  const exactOwnerObject = mode === "live" ? exactFrozenPlainDataObject : exactDataObject;
  return (
    !!request &&
    exactOwnerObject(value.owner, ["ownerToken", "runtimeInstanceId", "ownerPid", "ownerProcessStartIdentity"]) &&
    value.kind === "chat_runtime_teardown_recovery_completed" &&
    value.operationId === row.operation_id &&
    value.requestId === row.request_id &&
    value.bootstrapOperationId === row.bootstrap_operation_id &&
    value.chatThreadId === row.chat_thread_id &&
    value.chatSurfaceSessionId === row.chat_surface_session_id &&
    value.runtimeBindingDigest === request.runtimeBindingDigest &&
    canonical(value.owner) === row.owner_json &&
    value.fenceToken === row.fence_token &&
    Number.isSafeInteger(value.occurredAtMs) &&
    value.occurredAtMs >= row.prepared_at_ms
  );
}
function recoverChatRuntimeTeardown(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatRuntimeTeardownRecoveryInput,
): ProductionChatRuntimeTeardownReadback {
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    if (!productionChatRuntimeRecoveryProofs.has(input.proof as object) || input.proof.proof !== "proven_dead")
      throw new Error("chat_runtime_teardown_recovery_proof_invalid");
    const row = validChatRuntimeTeardownPermit(db, bootstrap, input.permit);
    if (!row || canonical(input.proof.owner) !== row.owner_json)
      throw new Error("chat_runtime_teardown_recovery_proof_invalid");
    if (row.status === "terminal") {
      const stored = parse(row.receipt_json);
      if (
        !stored ||
        stored.kind !== "chat_runtime_teardown_recovery_completed" ||
        digest(stored) !== digest(input.receipt)
      )
        throw new Error("chat_runtime_teardown_permit_conflict");
      return chatRuntimeTeardownReadback(db, row);
    }
    if (row.status !== "recovery_required") throw new Error("chat_runtime_teardown_recovery_proof_invalid");
    if (!teardownRecoveryReceiptMatches(row, input.receipt)) throw new Error("chat_runtime_teardown_receipt_invalid");
    if (
      canonical(sagaVector(db)) !==
      canonical({
        partitionRevision: parse(row.prepared_vector_json).partitionRevision + 1,
        fenceEpoch: parse(row.prepared_vector_json).fenceEpoch + 1,
        selectionRevision: parse(row.prepared_vector_json).selectionRevision,
      })
    )
      throw new Error("chat_runtime_teardown_revision_conflict");
    const session = db
      .prepare("SELECT state FROM production_surface_session WHERE session_id=? AND surface='chat'")
      .get(row.chat_surface_session_id) as any;
    if (!session || session.state !== "recovery_required")
      throw new Error("chat_runtime_teardown_recovery_state_invalid");
    db.prepare(
      "UPDATE production_surface_session SET state='ended',updated_at_ms=? WHERE session_id=? AND surface='chat'",
    ).run(input.receipt.occurredAtMs, row.chat_surface_session_id);
    db.prepare(
      "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1 WHERE singleton=1",
    ).run();
    const committed = sagaVector(db);
    db.prepare(
      "UPDATE production_chat_runtime_teardown_intent SET status='terminal',recovery_reason=NULL,committed_vector_json=?,receipt_json=?,receipt_digest=? WHERE continuity_id=? AND operation_id=?",
    ).run(canonical(committed), canonical(input.receipt), digest(input.receipt), row.continuity_id, row.operation_id);
    return chatRuntimeTeardownReadback(
      db,
      db
        .prepare("SELECT * FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND operation_id=?")
        .get(row.continuity_id, row.operation_id),
    );
  });
}
function failChatRuntime(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionChatRuntimeFailureInput | ProductionChatRuntimeDeadlineCancellationInput,
  nowMs: () => number,
): ProductionChatRuntimeReadback {
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    if (!isProductionChatRuntimeDeadlineCancellation(input as object) && !Object.hasOwn(input, "reason"))
      throw new Error("chat_runtime_permit_conflict");
    validateGamePrincipal(bootstrap, input.principal);
    const row = validChatRuntimePermit(db, bootstrap, input.permit);
    if (!row) throw new Error("chat_runtime_permit_conflict");
    if (!isProductionChatRuntimeDeadlineCancellation(input as object)) {
      if (!("reason" in input) || input.reason !== "effect_failed") throw new Error("chat_runtime_permit_conflict");
      if (row.status !== "pending") return chatRuntimeReadback(db, row);
      return chatRuntimeReadback(db, transitionChatRuntimeToRecovery(db, row, "effect_failed"));
    }
    if (row.status === "recovery_required") {
      if (row.recovery_reason !== "deadline_expired") throw new Error("chat_runtime_permit_conflict");
      return chatRuntimeReadback(db, row);
    }
    if (row.status !== "pending" || nowMs() < row.deadline_at_ms) throw new Error("chat_runtime_permit_conflict");
    return chatRuntimeReadback(db, transitionChatRuntimeToRecovery(db, row, "deadline_expired"));
  });
}
/**
 * A Chat runtime history is append-only. Only a pending/recovery row, or the
 * terminal row is receipt evidence, not a live transition. Only one
 * pending/recovery row may describe live materialization; historical terminal
 * rows must never become a permanent admission barrier.
 */
function validPersistedChatRuntimeTeardownIntents(db: DatabaseSync, partition: any, bootstrap: any): boolean {
  const rows = db.prepare("SELECT * FROM production_chat_runtime_teardown_intent ORDER BY operation_id").all() as any[];
  const bootstrapRows = db.prepare("SELECT * FROM production_chat_runtime_intent ORDER BY operation_id").all() as any[];
  const operationIds = new Set<string>();
  const expectedVectors = new Set<string>();
  const committedVectors = new Set<string>();
  let liveCount = 0;
  for (const row of bootstrapRows) {
    if (operationIds.has(row.operation_id)) return false;
    operationIds.add(row.operation_id);
    if (row.status === "pending" || row.status === "recovery_required") liveCount++;
    const request = parse(row.request_json),
      expected = request?.expected;
    if (
      !request ||
      !validStoredChatRuntimeRequest(request) ||
      !validStoredVector(expected) ||
      expectedVectors.has(canonical(expected)) ||
      !validFenceToken(row.fence_token)
    )
      return false;
    expectedVectors.add(canonical(expected));
    if (row.status === "terminal") {
      const committed = parse(row.committed_vector_json);
      if (!validStoredVector(committed) || committedVectors.has(canonical(committed))) return false;
      committedVectors.add(canonical(committed));
    }
  }
  if (liveCount > 1) return false;
  const predecessors = new Set<string>();
  for (const row of rows) {
    const request = parse(row.request_json),
      prepared = parse(row.prepared_vector_json),
      committed = row.committed_vector_json === null ? null : parse(row.committed_vector_json),
      receipt = row.receipt_json === null ? null : parse(row.receipt_json);
    const predecessor = db
      .prepare("SELECT * FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id=?")
      .get(row.continuity_id, row.bootstrap_operation_id) as any;
    if (
      !request ||
      !validChatRuntimeTeardownRequest(request) ||
      !predecessor ||
      predecessor.status !== "terminal" ||
      row.continuity_id !== partition?.continuity_id ||
      request.principal.continuityId !== bootstrap?.continuity_id ||
      request.principal.companionId !== bootstrap?.companion_id ||
      request.principal.playerId !== bootstrap?.player_id ||
      row.operation_id !== request.operationId ||
      row.request_id !== request.requestId ||
      row.bootstrap_operation_id !== request.bootstrapOperationId ||
      row.chat_thread_id !== request.chatThreadId ||
      row.chat_surface_session_id !== request.chatSurfaceSessionId ||
      row.payload_digest !== digest(request) ||
      row.request_json !== canonicalChatRuntimeTeardownRequest(request) ||
      row.runtime_binding_digest !== request.runtimeBindingDigest ||
      row.owner_json !== canonical(request.owner) ||
      row.deadline_at_ms !== request.deadlineAtMs ||
      !Number.isSafeInteger(row.prepared_at_ms) ||
      row.prepared_at_ms < 0 ||
      row.prepared_at_ms > row.deadline_at_ms ||
      !validStoredVector(prepared) ||
      prepared.partitionRevision !== request.expected.partitionRevision + 1 ||
      prepared.fenceEpoch !== request.expected.fenceEpoch + 1 ||
      prepared.selectionRevision !== request.expected.selectionRevision ||
      predecessor.chat_surface_session_id !== request.chatSurfaceSessionId ||
      predecessor.chat_thread_id !== request.chatThreadId ||
      predecessor.runtime_binding_digest !== request.runtimeBindingDigest ||
      predecessor.owner_json !== canonical(request.owner) ||
      !["pending", "terminal", "recovery_required"].includes(row.status) ||
      predecessors.has(row.bootstrap_operation_id)
    )
      return false;
    predecessors.add(row.bootstrap_operation_id);
    if (operationIds.has(row.operation_id)) return false;
    operationIds.add(row.operation_id);
    if (row.status === "pending" || row.status === "recovery_required") {
      liveCount++;
      if (liveCount > 1) return false;
    }
    if (!validFenceToken(row.fence_token)) return false;
    if (canonical(parse(predecessor.committed_vector_json)) !== canonical(request.expected)) return false;
    if (row.status === "pending" || row.status === "recovery_required") {
      if (
        committed !== null ||
        receipt !== null ||
        row.receipt_digest !== null ||
        (row.status === "pending" && row.recovery_reason !== null) ||
        (row.status === "recovery_required" &&
          !["effect_failed", "receipt_invalid", "deadline_expired", "revision_conflict"].includes(
            row.recovery_reason,
          )) ||
        !db
          .prepare("SELECT 1 FROM production_surface_session WHERE session_id=? AND state=?")
          .get(row.chat_surface_session_id, row.status === "pending" ? "suspended" : "recovery_required")
      )
        return false;
    } else {
      const currentPartition = db
        .prepare("SELECT selection_revision FROM production_partition WHERE singleton=1")
        .get() as any;
      const reopenedBySelection =
        !!db
          .prepare("SELECT 1 FROM production_surface_session WHERE session_id=? AND surface='chat' AND state='active'")
          .get(row.chat_surface_session_id) &&
        validStoredVector(committed) &&
        currentPartition?.selection_revision > committed.selectionRevision;
      const laterRuntime = db
        .prepare("SELECT request_json FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id<>?")
        .all(row.continuity_id, row.bootstrap_operation_id) as any[];
      const reenteredAfterTeardown = laterRuntime.some((candidate) => {
        const laterRequest = parse(candidate.request_json);
        return (
          validStoredChatRuntimeRequest(laterRequest) &&
          laterRequest.expected.partitionRevision === committed.partitionRevision + 1 &&
          laterRequest.expected.fenceEpoch === committed.fenceEpoch + 1 &&
          laterRequest.expected.selectionRevision === committed.selectionRevision + 1 &&
          laterRequest.chatSurfaceSessionId === row.chat_surface_session_id &&
          laterRequest.chatThreadId === row.chat_thread_id
        );
      });
      const recoveredTerminal = teardownRecoveryReceiptMatches(row, receipt, "persisted");
      if (
        !validStoredVector(committed) ||
        !receipt ||
        row.receipt_digest !== digest(receipt) ||
        row.recovery_reason !== null ||
        !(teardownReceiptMatches(row, receipt, "persisted") || recoveredTerminal) ||
        committed.partitionRevision !== prepared.partitionRevision + (recoveredTerminal ? 2 : 1) ||
        committed.fenceEpoch !== prepared.fenceEpoch + (recoveredTerminal ? 2 : 1) ||
        committed.selectionRevision !== prepared.selectionRevision ||
        (!reenteredAfterTeardown &&
          !reopenedBySelection &&
          !db
            .prepare("SELECT 1 FROM production_surface_session WHERE session_id=? AND state='ended'")
            .get(row.chat_surface_session_id))
      )
        return false;
    }
  }
  const terminalTeardowns = rows.filter((row) => row.status === "terminal");
  const committedKeys = new Set<string>();
  for (const row of terminalTeardowns) {
    const committed = parse(row.committed_vector_json);
    if (
      !validStoredVector(committed) ||
      committedKeys.has(canonical(committed)) ||
      committedVectors.has(canonical(committed))
    )
      return false;
    committedKeys.add(canonical(committed));
    committedVectors.add(canonical(committed));
  }
  const initialSagaSelect = db
    .prepare("SELECT response_json,committed_vector_json FROM production_saga_operation WHERE step='select_open'")
    .all() as any[];
  // The first bootstrap is anchored to the one initial select bridge. Every
  // later bootstrap must be the unique successor of a terminal teardown and
  // its exact vector-matching select bridge. This is the same predecessor
  // proof used by live admission; operation-id ordering is not evidence.
  const initialBridges = initialSagaSelect.filter((candidate) => {
    const response = parse(candidate.response_json),
      responseVector = parse(candidate.committed_vector_json);
    return (
      validStoredVector(responseVector) &&
      response?.phase === "selected" &&
      response?.vector &&
      canonical(response.vector) === canonical(responseVector)
    );
  });
  if (bootstrapRows.length && initialBridges.length !== 1) return false;
  const initialVector = initialBridges.length === 1 ? parse(initialBridges[0]!.committed_vector_json) : null;
  const initialRows = bootstrapRows.filter((bootstrapRow) => {
    const request = parse(bootstrapRow.request_json) as ProductionChatRuntimeRequest | null;
    return (
      !!request &&
      validStoredChatRuntimeRequest(request) &&
      validStoredVector(initialVector) &&
      canonical(request.expected) === canonical(initialVector)
    );
  });
  if (bootstrapRows.length && initialRows.length !== 1) return false;
  const successorCounts = new Map<string, number>();
  for (const bootstrapRow of bootstrapRows) {
    const request = parse(bootstrapRow.request_json) as ProductionChatRuntimeRequest | null;
    if (!request || !validStoredChatRuntimeRequest(request)) return false;
    if (initialRows.includes(bootstrapRow)) {
      const initial = initialBridges[0];
      const response = initial ? parse(initial.response_json) : null;
      if (
        !response ||
        response.chatSurfaceSessionId !== request.chatSurfaceSessionId ||
        response.chatThreadId !== request.chatThreadId
      )
        return false;
      continue;
    }
    // v40 has no direct re-entry edge: every non-initial bootstrap is forced
    // through its exact terminal teardown and selection bridge. The helper
    // rejects both ambiguous bridges and ambiguous vector predecessors.
    const admissions = chatRuntimeSuccessorAdmissions(db, {
      continuityId: request.principal.continuityId,
      expected: request.expected,
      chatThreadId: request.chatThreadId,
      chatSurfaceSessionId: request.chatSurfaceSessionId,
    });
    if (admissions.length !== 1) return false;
    const predecessorId = admissions[0]!.predecessor.operation_id;
    successorCounts.set(predecessorId, (successorCounts.get(predecessorId) ?? 0) + 1);
  }
  // A terminal teardown may have no successor only when it is the current
  // chain tip. More than one such tip is a fork; every other teardown has
  // exactly one successor selected through its unique bridge.
  let chainTips = 0;
  for (const teardownRow of terminalTeardowns) {
    const successors = successorCounts.get(teardownRow.bootstrap_operation_id) ?? 0;
    if (successors > 1 || (successors === 0 && ++chainTips > 1)) return false;
  }
  return true;
}
function rowContinuity(db: DatabaseSync): string {
  return (db.prepare("SELECT continuity_id FROM production_partition WHERE singleton=1").get() as any)?.continuity_id;
}
function teardownReceiptMatches(
  row: any,
  receipt: unknown,
  mode: "live" | "persisted" = "live",
): receipt is ProductionChatRuntimeTeardownReceipt {
  const request = parse(row.request_json) as ProductionChatRuntimeTeardownRequest | null;
  const keys = [
    "kind",
    "operationId",
    "requestId",
    "bootstrapOperationId",
    "chatThreadId",
    "chatSurfaceSessionId",
    "runtimeBindingDigest",
    "owner",
    "fenceToken",
    "occurredAtMs",
  ];
  const exactReceiptObject = mode === "live" ? exactFrozenPlainDataObject : exactDataObject;
  if (!request || !exactReceiptObject(receipt, keys) || !validFenceToken(row.fence_token)) return false;
  const value = receipt as ProductionChatRuntimeTeardownReceipt;
  const exactOwnerObject = mode === "live" ? exactFrozenPlainDataObject : exactDataObject;
  return (
    exactOwnerObject(value.owner, ["ownerToken", "runtimeInstanceId", "ownerPid", "ownerProcessStartIdentity"]) &&
    value.kind === "chat_runtime_torn_down" &&
    value.operationId === row.operation_id &&
    value.requestId === row.request_id &&
    value.bootstrapOperationId === row.bootstrap_operation_id &&
    value.chatThreadId === row.chat_thread_id &&
    value.chatSurfaceSessionId === row.chat_surface_session_id &&
    value.runtimeBindingDigest === request.runtimeBindingDigest &&
    canonical(value.owner) === row.owner_json &&
    value.fenceToken === row.fence_token &&
    Number.isSafeInteger(value.occurredAtMs) &&
    value.occurredAtMs >= row.prepared_at_ms &&
    value.occurredAtMs <= row.deadline_at_ms
  );
}
function currentChatRuntimeState(
  db: DatabaseSync,
  intents: any[],
): "pending" | "recovery_required" | "active" | "closed" | null {
  const current = sagaVector(db);
  const live = intents.filter((row) => row.status === "pending" || row.status === "recovery_required");
  if (live.length > 1) throw new Error("production_store_materialization_invalid");
  const teardowns = db
    .prepare("SELECT * FROM production_chat_runtime_teardown_intent ORDER BY operation_id")
    .all() as any[];
  const liveTeardowns = teardowns.filter((row) => row.status === "pending" || row.status === "recovery_required");
  if (liveTeardowns.length > 1) throw new Error("production_store_materialization_invalid");
  const terminalTeardowns = teardowns.filter((row) => row.status === "terminal");
  const exactTipCandidates = terminalTeardowns.filter((row) => {
    const committed = parse(row.committed_vector_json);
    return (
      validStoredVector(committed) &&
      ((committed.partitionRevision === current.partitionRevision &&
        committed.fenceEpoch === current.fenceEpoch &&
        committed.selectionRevision === current.selectionRevision) ||
        (current.partitionRevision >= committed.partitionRevision &&
          current.fenceEpoch >= committed.fenceEpoch &&
          current.selectionRevision >= committed.selectionRevision &&
          current.partitionRevision - committed.partitionRevision === current.fenceEpoch - committed.fenceEpoch &&
          current.partitionRevision - committed.partitionRevision ===
            current.selectionRevision - committed.selectionRevision))
    );
  });
  if (exactTipCandidates.length > 1) throw new Error("production_store_materialization_invalid");
  const teardown = liveTeardowns[0] ?? exactTipCandidates[0];
  // A teardown is itself the live Chat barrier while its effect is unresolved.
  // The predecessor bootstrap is terminal history, but its surface remains
  // suspended until teardown terminally closes it (or recovery is required).
  if (teardown && (teardown.status === "pending" || teardown.status === "recovery_required")) {
    if (live.length) throw new Error("production_store_materialization_invalid");
    const prepared = parse(teardown.prepared_vector_json);
    if (!validStoredVector(prepared)) throw new Error("production_store_materialization_invalid");
    const expectedPartition = prepared.partitionRevision + (teardown.status === "recovery_required" ? 1 : 0);
    const expectedFence = prepared.fenceEpoch + (teardown.status === "recovery_required" ? 1 : 0);
    if (
      current.partitionRevision !== expectedPartition ||
      current.fenceEpoch !== expectedFence ||
      current.selectionRevision !== prepared.selectionRevision
    )
      throw new Error("production_store_materialization_invalid");
    return teardown.status;
  }
  if (!live.length) {
    if (teardown?.status === "terminal") {
      const committed = parse(teardown.committed_vector_json);
      if (!validStoredVector(committed)) throw new Error("production_store_materialization_invalid");
      const successor = intents
        .filter((row) => row.status === "terminal")
        .map((row) => parse(row.committed_vector_json))
        .find(
          (vector) =>
            validStoredVector(vector) &&
            vector.partitionRevision > committed.partitionRevision &&
            vector.partitionRevision === current.partitionRevision &&
            vector.fenceEpoch === current.fenceEpoch &&
            vector.selectionRevision === current.selectionRevision,
        );
      if (successor) return "active";
      if (current.selectionRevision > committed.selectionRevision) {
        if (
          current.partitionRevision !==
            committed.partitionRevision + (current.selectionRevision - committed.selectionRevision) ||
          current.fenceEpoch !== committed.fenceEpoch + (current.selectionRevision - committed.selectionRevision) ||
          !db
            .prepare(
              "SELECT 1 FROM production_surface_session WHERE session_id=? AND surface='chat' AND state='active'",
            )
            .get(teardown.chat_surface_session_id)
        )
          throw new Error("production_store_materialization_invalid");
        return "active";
      }
      if (
        current.partitionRevision !== committed.partitionRevision ||
        current.fenceEpoch !== committed.fenceEpoch ||
        current.selectionRevision !== committed.selectionRevision
      )
        throw new Error("production_store_materialization_invalid");
      return "closed";
    }
    return null;
  }
  const row = live[0]!,
    prepared = parse(row.prepared_vector_json);
  if (!validStoredVector(prepared)) throw new Error("production_store_materialization_invalid");
  const expectedPartition = prepared.partitionRevision + (row.status === "recovery_required" ? 1 : 0);
  const expectedFence = prepared.fenceEpoch + (row.status === "recovery_required" ? 1 : 0);
  if (
    current.partitionRevision !== expectedPartition ||
    current.fenceEpoch !== expectedFence ||
    current.selectionRevision !== prepared.selectionRevision
  )
    throw new Error("production_store_materialization_invalid");
  return row.status;
}
function validPersistedChatRuntimeIntent(db: DatabaseSync, row: any, partition: any, bootstrap: any): boolean {
  const request = parse(row.request_json) as ProductionChatRuntimeRequest | null,
    prepared = parse(row.prepared_vector_json),
    committed = row.committed_vector_json === null ? null : parse(row.committed_vector_json),
    receipt = row.receipt_json === null ? null : parse(row.receipt_json),
    selected = selectedReadback(db),
    chat = db
      .prepare("SELECT * FROM production_surface_session WHERE session_id=? AND surface='chat'")
      .get(row.chat_surface_session_id) as any,
    thread = db
      .prepare("SELECT * FROM production_continuity_thread WHERE chat_surface_session_id=?")
      .get(row.chat_surface_session_id) as any,
    terminalTeardown = db
      .prepare(
        "SELECT status,bootstrap_operation_id,chat_surface_session_id,chat_thread_id FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND bootstrap_operation_id=?",
      )
      .get(row.continuity_id, row.operation_id) as any,
    reenteredAfterTeardown = (() => {
      if (terminalTeardown?.status !== "terminal") return false;
      const teardownRow = db
        .prepare(
          "SELECT committed_vector_json FROM production_chat_runtime_teardown_intent WHERE continuity_id=? AND bootstrap_operation_id=?",
        )
        .get(row.continuity_id, row.operation_id) as any;
      const teardownVector = parse(teardownRow?.committed_vector_json);
      const currentSelection = db
        .prepare("SELECT selection_revision FROM production_partition WHERE singleton=1")
        .get() as any;
      return (
        (validStoredVector(teardownVector) &&
          currentSelection?.selection_revision > teardownVector.selectionRevision &&
          chat?.state === "active") ||
        (
          db
            .prepare(
              "SELECT request_json FROM production_chat_runtime_intent WHERE continuity_id=? AND operation_id<>?",
            )
            .all(row.continuity_id, row.operation_id) as any[]
        ).some((candidate) => {
          const laterRequest = parse(candidate.request_json);
          return (
            validStoredChatRuntimeRequest(laterRequest) &&
            validStoredVector(teardownVector) &&
            laterRequest.expected.partitionRevision === teardownVector.partitionRevision + 1 &&
            laterRequest.expected.fenceEpoch === teardownVector.fenceEpoch + 1 &&
            laterRequest.expected.selectionRevision === teardownVector.selectionRevision + 1 &&
            laterRequest.chatSurfaceSessionId === row.chat_surface_session_id &&
            laterRequest.chatThreadId === row.chat_thread_id
          );
        })
      );
    })(),
    closedByTerminalTeardown =
      terminalTeardown?.status === "terminal" &&
      terminalTeardown.bootstrap_operation_id === row.operation_id &&
      terminalTeardown.chat_surface_session_id === row.chat_surface_session_id &&
      terminalTeardown.chat_thread_id === row.chat_thread_id &&
      !reenteredAfterTeardown;
  const validRuntimeMaterialization =
    !!request &&
    validStoredChatRuntimeRequest(request) &&
    row.continuity_id === partition?.continuity_id &&
    request.principal.continuityId === bootstrap?.continuity_id &&
    request.principal.companionId === bootstrap?.companion_id &&
    request.principal.playerId === bootstrap?.player_id &&
    row.operation_id === request.operationId &&
    row.request_id === request.requestId &&
    row.chat_surface_session_id === request.chatSurfaceSessionId &&
    row.chat_thread_id === request.chatThreadId &&
    row.payload_digest === digest(request) &&
    row.request_json === canonicalChatRuntimeRequest(request) &&
    row.runtime_binding_digest === request.runtimeBindingDigest &&
    row.owner_json === canonical(request.owner) &&
    Number.isSafeInteger(row.deadline_at_ms) &&
    row.deadline_at_ms >= 0 &&
    request.deadlineAtMs === row.deadline_at_ms &&
    Number.isSafeInteger(row.prepared_at_ms) &&
    row.prepared_at_ms >= 0 &&
    row.prepared_at_ms <= row.deadline_at_ms &&
    validStoredVector(prepared) &&
    prepared.partitionRevision === request.expected.partitionRevision + 1 &&
    prepared.fenceEpoch === request.expected.fenceEpoch + 1 &&
    prepared.selectionRevision === request.expected.selectionRevision &&
    !!selected &&
    selected.chatThreadId === request.chatThreadId &&
    selected.chatSurfaceSessionId === request.chatSurfaceSessionId &&
    selected.selectionRevision >= request.expected.selectionRevision &&
    (!!reenteredAfterTeardown || selected.selectionRevision === request.expected.selectionRevision) &&
    !!thread &&
    thread.lifecycle === "active" &&
    thread.content_receipt_json !== null &&
    !!chat &&
    ["pending", "terminal", "recovery_required"].includes(row.status);
  if (!validRuntimeMaterialization) return false;
  if (row.status === "pending")
    return (
      committed === null &&
      receipt === null &&
      row.receipt_digest === null &&
      row.recovery_reason === null &&
      chat.state === "suspended" &&
      partition.partition_revision === prepared.partitionRevision &&
      partition.fence_epoch === prepared.fenceEpoch
    );
  if (row.status === "recovery_required")
    return (
      committed === null &&
      receipt === null &&
      row.receipt_digest === null &&
      ["effect_failed", "receipt_invalid", "deadline_expired", "revision_conflict"].includes(row.recovery_reason) &&
      chat.state === "recovery_required" &&
      partition.partition_revision === prepared.partitionRevision + 1 &&
      partition.fence_epoch === prepared.fenceEpoch + 1
    );
  const recovered = chatRuntimeReceiptMatches(row, receipt, "chat_runtime_recovery_completed", "persisted");
  return (
    validStoredVector(committed) &&
    receipt !== null &&
    (chatRuntimeReceiptMatches(row, receipt, "chat_runtime_bootstrapped", "persisted") || recovered) &&
    row.receipt_digest === digest(receipt) &&
    row.recovery_reason === null &&
    ["active", "suspended", "recovery_required", "ended"].includes(chat.state) &&
    committed.partitionRevision === prepared.partitionRevision + (recovered ? 2 : 1) &&
    committed.fenceEpoch === prepared.fenceEpoch + (recovered ? 2 : 1) &&
    committed.selectionRevision === prepared.selectionRevision
  );
}
function validOperationHolderBinding(saga: any, operation: any, index: number): boolean {
  const request = parse(operation.request_json),
    step = ["claim_empty", "register_exact", "verify_exact_content", "select_open"][index];
  const expected = { partitionRevision: index + 1, fenceEpoch: index + 1, selectionRevision: 0 };
  const receipt = step === "verify_exact_content" ? parse(saga.receipt_json) : null;
  return (
    operation.holder_binding_digest === saga.holder_binding_digest &&
    request !== null &&
    canonical(request) === operation.request_json &&
    request.step === step &&
    request.holderBindingDigest === saga.holder_binding_digest &&
    request.operationId === operation.operation_id &&
    canonical(request.expected) === canonical(expected) &&
    canonical(request.receipt) === canonical(receipt)
  );
}
function validReceipt(value: unknown): value is TavernExactContentReceipt {
  const keys = ["chatThreadId", "companionId", "continuityId", "chatSurfaceSessionId", "digest"];
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => {
    const descriptor = descriptors[key];
    return (
      !!descriptor &&
      descriptor.enumerable &&
      "value" in descriptor &&
      safeId(
        key === "chatThreadId" || key === "companionId" || key === "continuityId" || key === "chatSurfaceSessionId"
          ? descriptor.value
          : descriptor.value,
      ) &&
      (key !== "digest" || sha(descriptor.value))
    );
  });
}
function rejectQuarantined(db: DatabaseSync): void {
  const rows = db.prepare("SELECT * FROM production_quarantine").all() as any[];
  if (rows.length) throw new Error("production_continuity_quarantined");
}
function positiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function step(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  stepName: "claim_empty" | "register_exact" | "verify_exact_content" | "select_open",
  input: ProductionSagaInput,
  receipt?: TavernExactContentReceipt,
): ProductionSagaReadback {
  if (
    !input ||
    !sha(input.holderBindingDigest) ||
    !safeId(input.operationId) ||
    !validVector(input.expected) ||
    (stepName === "verify_exact_content" && !validReceipt(receipt))
  )
    throw new Error("invalid_saga_operation");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    const request = Object.freeze({
      step: stepName,
      holderBindingDigest: input.holderBindingDigest,
      operationId: input.operationId,
      expected: input.expected,
      receipt: receipt ?? null,
    });
    const requestJson = canonical(request),
      requestDigest = digest(request);
    const old = db
      .prepare("SELECT * FROM production_saga_operation WHERE operation_id=?")
      .get(input.operationId) as any;
    if (old) {
      if (old.step !== stepName || old.request_digest !== requestDigest || old.request_json !== requestJson)
        throw new Error("saga_operation_conflict");
      const expected = expectedOperationResponse(db, stepName);
      if (
        old.response_json !== canonical(expected) ||
        old.response_digest !== digest(expected) ||
        old.committed_vector_json !== canonical(expected.vector)
      )
        throw new Error("saga_receipt_corrupt");
      return expected;
    }
    const p = db.prepare("SELECT * FROM production_partition WHERE singleton=1").get() as any;
    if (
      !p ||
      p.partition_revision !== input.expected.partitionRevision ||
      p.fence_epoch !== input.expected.fenceEpoch ||
      p.selection_revision !== input.expected.selectionRevision
    )
      throw new Error("saga_vector_conflict");
    const saga = db.prepare("SELECT * FROM production_initial_chat_saga WHERE singleton=1").get() as any;
    if (stepName === "claim_empty") {
      if (
        saga ||
        canonical(input.expected) !== canonical({ partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 }) ||
        !strictEmpty(db)
      )
        throw new Error("saga_not_empty");
      db.prepare("INSERT INTO production_initial_chat_saga VALUES(1,?,'claimed_empty',NULL,NULL,NULL,NULL)").run(
        input.holderBindingDigest,
      );
    } else {
      if (!saga || saga.holder_binding_digest !== input.holderBindingDigest) throw new Error("saga_holder_mismatch");
      const threadId = `initial-${input.holderBindingDigest.slice(0, 16)}`,
        sessionId = `surface-${input.holderBindingDigest.slice(0, 16)}`;
      if (stepName === "register_exact" && saga.phase === "claimed_empty") {
        db.prepare("INSERT INTO production_surface_session VALUES(?,?,'chat','suspended',0,0)").run(
          sessionId,
          p.continuity_id,
        );
        db.prepare(
          "INSERT INTO production_continuity_thread(chat_surface_session_id,continuity_id,chat_thread_id,companion_id,lifecycle,content_receipt_json,content_receipt_digest) VALUES(?,?,?,?, 'active',NULL,NULL)",
        ).run(sessionId, p.continuity_id, threadId, p.companion_id);
        db.prepare(
          "INSERT INTO production_chat_lifecycle_metadata(chat_surface_session_id,management_revision,trash_restore_lifecycle) VALUES(?,1,NULL)",
        ).run(sessionId);
        db.prepare("INSERT INTO production_continuity_event VALUES(?,?,?,'chat_registered','chat',0)").run(
          `event-${input.holderBindingDigest.slice(0, 16)}`,
          p.continuity_id,
          sessionId,
        );
        db.prepare(
          "UPDATE production_initial_chat_saga SET phase='chat_registered',chat_thread_id=?,chat_surface_session_id=? WHERE singleton=1",
        ).run(threadId, sessionId);
      } else if (stepName === "verify_exact_content" && saga.phase === "chat_registered" && receipt) {
        if (
          receipt.chatThreadId !== saga.chat_thread_id ||
          receipt.chatSurfaceSessionId !== saga.chat_surface_session_id ||
          receipt.continuityId !== p.continuity_id ||
          receipt.companionId !== p.companion_id
        )
          throw new Error("content_receipt_invalid");
        db.prepare(
          "UPDATE production_initial_chat_saga SET phase='content_verified',receipt_json=?,receipt_digest=? WHERE singleton=1",
        ).run(canonical(receipt), digest(receipt));
        db.prepare(
          "UPDATE production_continuity_thread SET content_receipt_json=?,content_receipt_digest=? WHERE chat_surface_session_id=?",
        ).run(canonical(receipt), digest(receipt), saga.chat_surface_session_id);
      } else if (stepName === "select_open" && saga.phase === "content_verified") {
        const stored = parse(saga.receipt_json);
        const thread = db
          .prepare("SELECT lifecycle FROM production_continuity_thread WHERE chat_surface_session_id=?")
          .get(saga.chat_surface_session_id) as any;
        const session = db
          .prepare("SELECT state FROM production_surface_session WHERE session_id=?")
          .get(saga.chat_surface_session_id) as any;
        if (
          !validReceipt(stored) ||
          digest(stored) !== saga.receipt_digest ||
          !thread ||
          thread.lifecycle !== "active" ||
          !session ||
          session.state !== "suspended" ||
          count(db, "production_game_session") ||
          count(db, "production_game_lease") ||
          count(db, "production_game_intent")
        )
          throw new Error("saga_materialization_invalid");
        db.prepare("INSERT INTO production_active_selection VALUES(1,?,?,1)").run(
          saga.chat_surface_session_id,
          saga.chat_thread_id,
        );
        db.prepare("UPDATE production_surface_session SET state='active',updated_at_ms=0 WHERE session_id=?").run(
          saga.chat_surface_session_id,
        );
        db.prepare("UPDATE production_initial_chat_saga SET phase='selected' WHERE singleton=1").run();
      } else throw new Error("saga_transition_invalid");
    }
    db.prepare(
      "UPDATE production_partition SET partition_revision=partition_revision+1,fence_epoch=fence_epoch+1,selection_revision=selection_revision+? WHERE singleton=1",
    ).run(stepName === "select_open" ? 1 : 0);
    const response = readSaga(db);
    const responseJson = canonical(response),
      responseDigest = digest(response),
      vectorJson = canonical(response.vector);
    db.prepare("INSERT INTO production_saga_operation VALUES(?,?,?,?,?,?,?,?)").run(
      input.operationId,
      stepName,
      input.holderBindingDigest,
      requestJson,
      requestDigest,
      responseJson,
      responseDigest,
      vectorJson,
    );
    db.prepare("INSERT INTO production_saga_receipt VALUES(?,?,?,?,?,?,?)").run(
      input.operationId,
      stepName,
      requestJson,
      requestDigest,
      responseJson,
      responseDigest,
      vectorJson,
    );
    return response;
  });
}
function expectedOperationResponse(db: DatabaseSync, step: string): ProductionSagaReadback {
  const saga = db.prepare("SELECT * FROM production_initial_chat_saga WHERE singleton=1").get() as any;
  const p = db.prepare("SELECT * FROM production_partition WHERE singleton=1").get() as any;
  if (!saga || !p) throw new Error("saga_materialization_invalid");
  const phase =
    step === "claim_empty"
      ? "claimed_empty"
      : step === "register_exact"
        ? "chat_registered"
        : step === "verify_exact_content"
          ? "content_verified"
          : step === "select_open"
            ? "selected"
            : null;
  if (!phase) throw new Error("saga_materialization_invalid");
  const receipt = phase === "content_verified" || phase === "selected" ? parse(saga.receipt_json) : null;
  return Object.freeze({
    phase,
    vector: {
      partitionRevision:
        phase === "claimed_empty" ? 2 : phase === "chat_registered" ? 3 : phase === "content_verified" ? 4 : 5,
      fenceEpoch:
        phase === "claimed_empty" ? 2 : phase === "chat_registered" ? 3 : phase === "content_verified" ? 4 : 5,
      selectionRevision: phase === "selected" ? 1 : 0,
    },
    chatThreadId: phase === "claimed_empty" ? null : saga.chat_thread_id,
    chatSurfaceSessionId: phase === "claimed_empty" ? null : saga.chat_surface_session_id,
    receipt,
  });
}
function validateGamePrincipal(bootstrap: ProductionBootstrapContext, principal: ProductionPrincipal): void {
  const expected = bootstrap.bootstrap.principal;
  if (!validPrincipal(principal) || canonical(principal) !== canonical(expected))
    throw new Error("production_game_principal_mismatch");
}
function validGameWorld(value: unknown): value is ProductionGameWorld {
  return (
    exactPlainDataObject(value, ["integrationId", "saveId", "worldId"]) &&
    safeId(value.integrationId) &&
    safeId(value.saveId) &&
    safeId(value.worldId)
  );
}
function validGameOwner(value: unknown): value is ProductionGameOwner {
  return (
    exactPlainDataObject(value, ["ownerToken", "runtimeInstanceId", "ownerPid", "ownerProcessStartIdentity"]) &&
    safeId(value.ownerToken) &&
    safeId(value.runtimeInstanceId) &&
    Number.isSafeInteger(value.ownerPid) &&
    (value.ownerPid as number) > 0 &&
    safeId(value.ownerProcessStartIdentity)
  );
}
function validGameVector(value: unknown): value is GameRevisionVector {
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === 4 &&
    ["partitionRevision", "gameRevision", "leaseRevision", "fenceEpoch"].every((k) =>
      Number.isSafeInteger((value as any)[k]),
    ) &&
    (value as any).partitionRevision >= 1 &&
    (value as any).gameRevision >= 0 &&
    (value as any).leaseRevision >= 0 &&
    (value as any).fenceEpoch >= 1
  );
}
function validGameRequest(value: unknown): value is ProductionGameRequest {
  if (
    !exactPlainDataObject(value, [
      "principal",
      "operationId",
      "requestId",
      "kind",
      "gameSessionId",
      "world",
      "bindingDigest",
      "owner",
      "deadlineAtMs",
      "expected",
    ])
  )
    return false;
  const x = value as ProductionGameRequest;
  return (
    validPrincipal(x.principal) &&
    safeId(x.operationId) &&
    safeId(x.requestId) &&
    (x.kind === "enter" || x.kind === "close") &&
    safeId(x.gameSessionId) &&
    validGameWorld(x.world) &&
    sha(x.bindingDigest) &&
    validGameOwner(x.owner) &&
    Number.isSafeInteger(x.deadlineAtMs) &&
    x.deadlineAtMs >= 0 &&
    validGameVector(x.expected)
  );
}
function currentGameVector(db: DatabaseSync): GameRevisionVector {
  const p = db
      .prepare("SELECT game_partition_revision,game_fence_epoch FROM production_partition WHERE singleton=1")
      .get() as any,
    g = db.prepare("SELECT state FROM production_game_session WHERE state!='ended' LIMIT 1").get() as any,
    l = db.prepare("SELECT lease_revision FROM production_game_lease").get() as any;
  return {
    partitionRevision: p.game_partition_revision,
    gameRevision: g?.state === "active" ? 1 : 0,
    leaseRevision: l?.lease_revision ?? 0,
    fenceEpoch: p.game_fence_epoch,
  };
}
function sameGameVector(a: unknown, b: unknown): boolean {
  return validGameVector(a) && validGameVector(b) && canonical(a) === canonical(b);
}
function gameReadback(db: DatabaseSync, row: any): ProductionGameReadback {
  const g = db.prepare("SELECT state FROM production_game_session WHERE session_id=?").get(row.session_id) as any,
    l = db.prepare("SELECT state FROM production_game_lease WHERE continuity_id=?").get(row.continuity_id) as any;
  return Object.freeze({
    operationId: row.operation_id,
    requestId: row.request_id,
    status: row.status,
    gameSessionId: row.session_id,
    gameState: g?.state ?? "recovery_required",
    leaseState: l?.state ?? null,
    vector: Object.freeze(currentGameVector(db)),
    receipt: parse(row.receipt_json),
    recoveryReason: row.recovery_reason ?? null,
  });
}
function canonicalGameRequest(input: ProductionGameRequest): string {
  return canonical({
    principal: input.principal,
    operationId: input.operationId,
    requestId: input.requestId,
    kind: input.kind,
    gameSessionId: input.gameSessionId,
    world: input.world,
    bindingDigest: input.bindingDigest,
    owner: input.owner,
    deadlineAtMs: input.deadlineAtMs,
    expected: input.expected,
  });
}
function permitFromGame(input: ProductionGameRequest, row: any): ProductionGamePermit {
  return Object.freeze({
    ...input,
    payloadDigest: row.payload_digest,
    fenceToken: row.fence_token,
    prepared: Object.freeze(parse(row.prepared_vector_json)),
  });
}
function validGamePermit(db: DatabaseSync, bootstrap: ProductionBootstrapContext, permit: ProductionGamePermit): any {
  if (
    !permit ||
    !validGameRequest({
      principal: permit.principal,
      operationId: permit.operationId,
      requestId: permit.requestId,
      kind: permit.kind,
      gameSessionId: permit.gameSessionId,
      world: permit.world,
      bindingDigest: permit.bindingDigest,
      owner: permit.owner,
      deadlineAtMs: permit.deadlineAtMs,
      expected: permit.expected,
    }) ||
    !validGameVector(permit.prepared) ||
    !sha(permit.payloadDigest) ||
    !validFenceToken(permit.fenceToken)
  )
    return null;
  try {
    validateGamePrincipal(bootstrap, permit.principal);
  } catch {
    return null;
  }
  const row = db
    .prepare("SELECT * FROM production_game_intent WHERE continuity_id=? AND operation_id=?")
    .get(permit.principal.continuityId, permit.operationId) as any;
  return row &&
    row.payload_digest === permit.payloadDigest &&
    row.fence_token === permit.fenceToken &&
    row.request_json === canonicalGameRequest(permit) &&
    row.prepared_vector_json === canonical(permit.prepared)
    ? row
    : null;
}
function validGameReceiptShape(x: unknown): x is ProductionGameTerminalReceipt | ProductionGameRecoveryReceipt {
  if (
    !exactPlainDataObject(x, [
      "kind",
      "operationId",
      "requestId",
      "gameSessionId",
      "bindingDigest",
      "world",
      "owner",
      "fenceToken",
      "occurredAtMs",
    ])
  )
    return false;
  const r = x as any;
  return (
    ["runtime_bootstrapped", "runtime_torn_down", "recovery_completed"].includes(r.kind) &&
    safeId(r.operationId) &&
    safeId(r.requestId) &&
    safeId(r.gameSessionId) &&
    sha(r.bindingDigest) &&
    validGameWorld(r.world) &&
    validGameOwner(r.owner) &&
    validFenceToken(r.fenceToken) &&
    Number.isSafeInteger(r.occurredAtMs) &&
    r.occurredAtMs >= 0
  );
}
function receiptMatches(row: any, r: any, recovery = false): boolean {
  const q = parse(row.request_json);
  return (
    !!q &&
    validGameReceiptShape(r) &&
    r.operationId === row.operation_id &&
    r.requestId === row.request_id &&
    r.gameSessionId === row.session_id &&
    r.bindingDigest === q.bindingDigest &&
    canonical(r.world) === row.world_json &&
    canonical(r.owner) === row.owner_json &&
    r.fenceToken === row.fence_token &&
    (recovery
      ? r.kind === "recovery_completed"
      : r.kind === (q.kind === "enter" ? "runtime_bootstrapped" : "runtime_torn_down"))
  );
}
function prepareGame(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionGameRequest,
  nowMs: () => number,
): ProductionGamePrepareOutcome {
  if (!validGameRequest(input)) throw new Error("invalid_game_operation");
  if (nowMs() >= input.deadlineAtMs) throw new Error("game_deadline_expired");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    if (nowMs() >= input.deadlineAtMs) throw new Error("game_deadline_expired");
    const json = canonicalGameRequest(input),
      hash = digest(input),
      old = db
        .prepare("SELECT * FROM production_game_intent WHERE continuity_id=? AND operation_id=?")
        .get(input.principal.continuityId, input.operationId) as any;
    if (old) {
      if (old.payload_digest !== hash || old.request_json !== json) throw new Error("game_operation_conflict");
      return Object.freeze({
        outcome:
          old.status === "pending" ? "effect_pending" : old.status === "terminal" ? "completed" : "recovery_required",
        permit: old.status === "pending" ? permitFromGame(input, old) : null,
        readback: gameReadback(db, old),
      });
    }
    if (!sameGameVector(currentGameVector(db), input.expected)) throw new Error("game_vector_conflict");
    const lease = db
      .prepare("SELECT * FROM production_game_lease WHERE continuity_id=?")
      .get(input.principal.continuityId) as any;
    if (input.kind === "enter") {
      if (
        input.expected.gameRevision !== 0 ||
        input.expected.leaseRevision !== 0 ||
        lease ||
        db
          .prepare("SELECT 1 FROM production_game_session WHERE continuity_id=? AND state!='ended'")
          .get(input.principal.continuityId)
      )
        throw new Error("game_transition_invalid");
      db.prepare("INSERT INTO production_surface_session VALUES(?,?,'game','pending',0,0)").run(
        input.gameSessionId,
        input.principal.continuityId,
      );
      db.prepare("INSERT INTO production_game_session VALUES(?,?,'pending')").run(
        input.gameSessionId,
        input.principal.continuityId,
      );
      db.prepare(
        "INSERT INTO production_game_lease(continuity_id,session_id,binding_digest,state,lease_revision,world_json,owner_json,fence_token,deadline_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        input.principal.continuityId,
        input.gameSessionId,
        input.bindingDigest,
        "owned",
        1,
        canonical(input.world),
        canonical(input.owner),
        randomUUID().replaceAll("-", ""),
        input.deadlineAtMs,
      );
    } else {
      if (
        !lease ||
        lease.session_id !== input.gameSessionId ||
        lease.state !== "owned" ||
        lease.binding_digest !== input.bindingDigest ||
        canonical(parse(lease.world_json)) !== canonical(input.world) ||
        canonical(parse(lease.owner_json)) !== canonical(input.owner)
      )
        throw new Error("game_transition_invalid");
      db.prepare(
        "UPDATE production_game_lease SET state='close_pending',lease_revision=lease_revision+1,deadline_at_ms=? WHERE continuity_id=?",
      ).run(input.deadlineAtMs, input.principal.continuityId);
    }
    db.prepare(
      "UPDATE production_partition SET game_partition_revision=game_partition_revision+1,game_fence_epoch=game_fence_epoch+1 WHERE singleton=1",
    ).run();
    const prepared = currentGameVector(db),
      fence = randomUUID().replaceAll("-", "");
    db.prepare(
      "INSERT INTO production_game_intent(continuity_id,operation_id,session_id,payload_digest,status,request_id,request_json,world_json,owner_json,fence_token,deadline_at_ms,prepared_vector_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      input.principal.continuityId,
      input.operationId,
      input.gameSessionId,
      hash,
      "pending",
      input.requestId,
      json,
      canonical(input.world),
      canonical(input.owner),
      fence,
      input.deadlineAtMs,
      canonical(prepared),
    );
    const row = db
      .prepare("SELECT * FROM production_game_intent WHERE continuity_id=? AND operation_id=?")
      .get(input.principal.continuityId, input.operationId) as any;
    return Object.freeze({
      outcome: "effect_owned" as const,
      permit: permitFromGame(input, row),
      readback: gameReadback(db, row),
    });
  });
}
function transitionGameToRecovery(db: DatabaseSync, row: any, reason: any): any {
  db.prepare(
    "UPDATE production_game_intent SET status='recovery_required',recovery_reason=? WHERE continuity_id=? AND operation_id=?",
  ).run(reason, row.continuity_id, row.operation_id);
  db.prepare("UPDATE production_game_session SET state='recovery_required' WHERE session_id=?").run(row.session_id);
  db.prepare("UPDATE production_surface_session SET state='recovery_required' WHERE session_id=?").run(row.session_id);
  db.prepare("UPDATE production_game_lease SET state='recovery_required' WHERE continuity_id=?").run(row.continuity_id);
  db.prepare(
    "UPDATE production_partition SET game_partition_revision=game_partition_revision+1,game_fence_epoch=game_fence_epoch+1 WHERE singleton=1",
  ).run();
  return db
    .prepare("SELECT * FROM production_game_intent WHERE continuity_id=? AND operation_id=?")
    .get(row.continuity_id, row.operation_id);
}
function commitGameTerminal(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionGameTerminalInput,
  nowMs: () => number,
): ProductionGameReadback {
  if (!validGameReceiptShape(input?.receipt)) throw new Error("receipt_invalid");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const row = validGamePermit(db, bootstrap, input.permit);
    if (!row) throw new Error("game_permit_conflict");
    if (row.status === "terminal") return gameReadback(db, row);
    if (row.status !== "pending") throw new Error("game_permit_conflict");
    if (
      nowMs() >= row.deadline_at_ms ||
      input.receipt.occurredAtMs > row.deadline_at_ms ||
      !receiptMatches(row, input.receipt)
    )
      return gameReadback(
        db,
        transitionGameToRecovery(db, row, nowMs() >= row.deadline_at_ms ? "deadline_expired" : "receipt_invalid"),
      );
    if (!sameGameVector(currentGameVector(db), parse(row.prepared_vector_json)))
      return gameReadback(db, transitionGameToRecovery(db, row, "revision_conflict"));
    const close = parse(row.request_json).kind === "close";
    db.prepare("UPDATE production_game_session SET state=? WHERE session_id=?").run(
      close ? "ended" : "active",
      row.session_id,
    );
    db.prepare("UPDATE production_surface_session SET state=? WHERE session_id=?").run(
      close ? "ended" : "active",
      row.session_id,
    );
    if (close) db.prepare("DELETE FROM production_game_lease WHERE continuity_id=?").run(row.continuity_id);
    db.prepare(
      "UPDATE production_partition SET game_partition_revision=game_partition_revision+1,game_fence_epoch=game_fence_epoch+1 WHERE singleton=1",
    ).run();
    db.prepare(
      "UPDATE production_game_intent SET status='terminal',committed_vector_json=?,receipt_json=?,receipt_digest=? WHERE continuity_id=? AND operation_id=?",
    ).run(
      canonical(currentGameVector(db)),
      canonical(input.receipt),
      digest(input.receipt),
      row.continuity_id,
      row.operation_id,
    );
    return gameReadback(
      db,
      db
        .prepare("SELECT * FROM production_game_intent WHERE continuity_id=? AND operation_id=?")
        .get(row.continuity_id, row.operation_id),
    );
  });
}
function failGame(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionGameFailureInput,
): ProductionGameReadback {
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const row = validGamePermit(db, bootstrap, input.permit);
    if (!row || input.reason !== "effect_failed") throw new Error("game_permit_conflict");
    return gameReadback(db, row.status === "pending" ? transitionGameToRecovery(db, row, "effect_failed") : row);
  });
}
function recoverGame(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: ProductionGameRecoveryInput,
): ProductionGameReadback {
  if (input?.request !== "recover_dead_owner" || !validGameReceiptShape(input?.receipt))
    throw new Error("receipt_invalid");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const verification = readWindowsOwnerDeathVerification(input.proof);
    if (verification.outcome !== "proven_dead") throw new Error("recovery_owner_not_proven_dead");
    const row = validGamePermit(db, bootstrap, input.permit);
    if (!row || canonical(verification.owner) !== row.owner_json || !receiptMatches(row, input.receipt, true))
      throw new Error("recovery_proof_invalid");
    const request = parse(row.request_json),
      closePending = row.status === "pending" && request?.kind === "close",
      recoveryRequired = row.status === "recovery_required";
    if (!closePending && !recoveryRequired) throw new Error("receipt_invalid");
    if (closePending && !sameGameVector(currentGameVector(db), parse(row.prepared_vector_json)))
      throw new Error("recovery_exact_owner_cas_conflict");
    const expectedState = closePending ? "close_pending" : "recovery_required",
      sessionState = closePending ? "active" : "recovery_required";
    const lease = db.prepare("SELECT * FROM production_game_lease WHERE continuity_id=?").get(row.continuity_id) as any;
    if (
      !lease ||
      lease.session_id !== row.session_id ||
      lease.state !== expectedState ||
      lease.binding_digest !== request.bindingDigest ||
      lease.owner_json !== row.owner_json ||
      !validFenceToken(lease.fence_token)
    )
      throw new Error("recovery_exact_owner_cas_conflict");
    const ended = db
      .prepare("UPDATE production_game_session SET state='ended' WHERE session_id=? AND continuity_id=? AND state=?")
      .run(row.session_id, row.continuity_id, sessionState);
    if (ended.changes !== 1) throw new Error("recovery_exact_owner_cas_conflict");
    const surfaced = db
      .prepare(
        "UPDATE production_surface_session SET state='ended' WHERE session_id=? AND continuity_id=? AND surface='game' AND state=?",
      )
      .run(row.session_id, row.continuity_id, sessionState);
    if (surfaced.changes !== 1) throw new Error("recovery_exact_owner_cas_conflict");
    const deleted = db
      .prepare(
        "DELETE FROM production_game_lease WHERE continuity_id=? AND session_id=? AND state=? AND binding_digest=? AND owner_json=? AND fence_token=? AND lease_revision=?",
      )
      .run(
        row.continuity_id,
        row.session_id,
        expectedState,
        lease.binding_digest,
        row.owner_json,
        lease.fence_token,
        lease.lease_revision,
      );
    if (deleted.changes !== 1) throw new Error("recovery_exact_owner_cas_conflict");
    db.prepare(
      "UPDATE production_partition SET game_partition_revision=game_partition_revision+1,game_fence_epoch=game_fence_epoch+1 WHERE singleton=1",
    ).run();
    const terminalized = db
      .prepare(
        "UPDATE production_game_intent SET status='terminal',recovery_reason=NULL,receipt_json=?,receipt_digest=?,committed_vector_json=? WHERE continuity_id=? AND operation_id=? AND status=? AND session_id=? AND owner_json=? AND fence_token=? ",
      )
      .run(
        canonical(input.receipt),
        digest(input.receipt),
        canonical(currentGameVector(db)),
        row.continuity_id,
        row.operation_id,
        row.status,
        row.session_id,
        row.owner_json,
        row.fence_token,
      );
    if (terminalized.changes !== 1) throw new Error("recovery_exact_owner_cas_conflict");
    return gameReadback(
      db,
      db
        .prepare("SELECT * FROM production_game_intent WHERE continuity_id=? AND operation_id=?")
        .get(row.continuity_id, row.operation_id),
    );
  });
}
function readGameRecoveryTarget(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: Readonly<{ principal: ProductionPrincipal; operationId: string }>,
): ProductionGameRecoveryTarget | null {
  if (!validPrincipal(input?.principal) || !safeId(input?.operationId)) throw new Error("invalid_game_operation");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const row = db
      .prepare("SELECT * FROM production_game_intent WHERE continuity_id=? AND operation_id=?")
      .get(input.principal.continuityId, input.operationId) as any;
    if (!row) return null;
    const request = parse(row.request_json),
      eligible = row.status === "recovery_required" || (row.status === "pending" && request?.kind === "close");
    if (!eligible) return null;
    const permit = request && validGameRequest(request) ? permitFromGame(request, row) : null;
    if (!permit || canonical(permit.owner) !== row.owner_json) throw new Error("recovery_target_invalid");
    return Object.freeze({ owner: Object.freeze({ ...permit.owner }), permit, readback: gameReadback(db, row) });
  });
}
function readGameAdmission(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
): Readonly<{ vector: GameRevisionVector; activeGameSessionId: string | null }> {
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    const rows = db
      .prepare("SELECT session_id FROM production_game_session WHERE continuity_id=? AND state!='ended'")
      .all(bootstrap.bootstrap.principal.continuityId) as any[];
    if (rows.length > 1) throw new Error("game_admission_ambiguous");
    return Object.freeze({
      vector: Object.freeze(currentGameVector(db)),
      activeGameSessionId: rows.length === 1 ? (rows[0].session_id as string) : null,
    });
  });
}
function readGameOperation(
  db: DatabaseSync,
  bootstrap: ProductionBootstrapContext,
  input: Readonly<{ principal: ProductionPrincipal; operationId: string }>,
): ProductionGameReadback | null {
  if (!validPrincipal(input.principal) || !safeId(input.operationId)) throw new Error("invalid_game_operation");
  return transaction(db, () => {
    validateExpectedBootstrap(db, bootstrap);
    rejectQuarantined(db);
    validateGamePrincipal(bootstrap, input.principal);
    const row = db
      .prepare("SELECT * FROM production_game_intent WHERE continuity_id=? AND operation_id=?")
      .get(input.principal.continuityId, input.operationId) as any;
    return row ? gameReadback(db, row) : null;
  });
}
function strictEmpty(db: DatabaseSync): boolean {
  return [
    "production_active_selection",
    "production_surface_session",
    "production_continuity_thread",
    "production_chat_lifecycle_metadata",
    "production_continuity_event",
    "production_game_session",
    "production_game_lease",
    "production_game_intent",
    "production_continuity_command",
    "production_quarantine",
    "production_initial_chat_saga",
    "production_saga_operation",
    "production_saga_receipt",
  ].every((table) => count(db, table) === 0);
}
function readSaga(db: DatabaseSync): ProductionSagaReadback {
  const p = db.prepare("SELECT * FROM production_partition WHERE singleton=1").get() as any,
    saga = db.prepare("SELECT * FROM production_initial_chat_saga WHERE singleton=1").get() as any;
  if (!p || !saga) throw new Error("saga_materialization_invalid");
  const receipt = saga.receipt_json === null ? null : parse(saga.receipt_json);
  if (receipt !== null && (!validReceipt(receipt) || digest(receipt) !== saga.receipt_digest))
    throw new Error("saga_receipt_corrupt");
  return Object.freeze({
    phase: saga.phase,
    vector: {
      partitionRevision: p.partition_revision,
      fenceEpoch: p.fence_epoch,
      selectionRevision: p.selection_revision,
    },
    chatThreadId: saga.chat_thread_id,
    chatSurfaceSessionId: saga.chat_surface_session_id,
    receipt,
  });
}
