import {
  type ChatRuntimeBindingExecution,
  consumeReservedChatRuntimeMaterialization,
  type ReservedChatRuntimeMaterialization,
  releaseReservedChatRuntimeMaterialization,
} from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type {
  ProductionChatRuntimePermit,
  ProductionChatRuntimeReceipt,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { RuntimeSession } from "../runtime.js";

/** Minimal reverse-disposal boundary; no Pi session, runtime root, or binding leaks. */
type ChatRuntimeStableContextLifecycle = Readonly<{}>;

import type { TavernAuthoredContextRuntimeCapability } from "@cortexkit/pi-magic-context/internal/gamebuddy-authored-context-bridge";

export type ChatRuntimeDisposal = Readonly<{
  session: Readonly<{ dispose(): void }>;
  authoredContextCapability?: TavernAuthoredContextRuntimeCapability;
}>;


export type MaterializedChatRuntime = Readonly<{
  receipt: ProductionChatRuntimeReceipt;
  /**
   * Construction-zone-only mounted runtime. It is populated solely by the
   * Host production materializer and is consumed only by the coordinator.
   */
  runtimeSession?: RuntimeSession;
  authoredContextCapability?: TavernAuthoredContextRuntimeCapability;
  /** Runtime resources only. The later coordinator owns durable terminalization and binding close. */
  close(): Promise<void>;
}>;
export type ChatRuntimeMaterialization = ChatRuntimeDisposal &
  Readonly<{
    /** Never exposed by this module's public product; retained for production mounting only. */
    runtimeSession?: RuntimeSession;
  authoredContextCapability?: TavernAuthoredContextRuntimeCapability;
  }>;
export type ChatRuntimeMaterializer = Readonly<{
  /** Construction-zone-only: consumes one callback-admitted Chat binding reservation. */
  materialize(
    reservation: ReservedChatRuntimeMaterialization,
    permit: ProductionChatRuntimePermit,
  ): Promise<MaterializedChatRuntime>;
}>;

/**
 * One Host-owned unlocked Chat effect. A binding reservation is admitted only
 * synchronously in its one-shot callback; this function is its only consumer.
 * It never writes semantic state: the coordinator owns `commit/fail` after it
 * receives this exact Host lifecycle receipt.
 */
export async function materializeExactChatRuntime(
  reservation: ReservedChatRuntimeMaterialization,
  permit: ProductionChatRuntimePermit,
  factory: (execution: ChatRuntimeBindingExecution) => Promise<ChatRuntimeMaterialization>,
): Promise<MaterializedChatRuntime> {
  const execution = consumeReservedChatRuntimeMaterialization(reservation);
  let runtime: ChatRuntimeDisposal | undefined;
  let finalized = false;
  try {
    try {
      assertExecution(execution);
      assertExactPermit(execution, permit);
      runtime = await factory(execution);
      assertRuntimeDisposal(runtime);
      // The external effect may have taken arbitrary time. Recheck before
      // minting the Host receipt, then let the store independently recheck it.
      assertExactPermit(execution, permit);
      const result = finalizeMaterializedChatRuntime(permit, runtime);
      finalized = true;
      return result;
    } catch (primary) {
      if (!finalized && runtime !== undefined) {
        try {
          await closeMaterializedChatRuntime(runtime);
        } catch (cleanup) {
          // Cleanup is part of the construction contract: retain the primary
          // admission/factory failure while exposing every reverse failure.
          throw new AggregateError([primary, ...aggregateErrors(cleanup)], "chat_runtime_materialization_failed");
        }
      }
      throw primary;
    }
  } finally {
    releaseReservedChatRuntimeMaterialization(reservation);
  }
}

/** Mints Host lifecycle evidence only after the exact post-factory admission. */
function finalizeMaterializedChatRuntime(
  permit: ProductionChatRuntimePermit,
  runtime: ChatRuntimeMaterialization,
): MaterializedChatRuntime {
  assertRuntimeDisposal(runtime);
  const receipt = mintChatRuntimeReceipt(permit);
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    receipt,
    ...(runtime.runtimeSession === undefined ? {} : { runtimeSession: runtime.runtimeSession }),
    ...(runtime.authoredContextCapability === undefined ? {} : { authoredContextCapability: runtime.authoredContextCapability }),
    close: () => {
      if (closePromise !== undefined) return closePromise;
      let shared!: Promise<void>;
      shared = closeMaterializedChatRuntime(runtime).then(
        () => undefined,
        (error) => {
          // A failed reverse-disposal is retryable. Keep the captured clear and
          // dispose operations in the runtime object; only fulfillment is cached.
          if (closePromise === shared) closePromise = undefined;
          throw error;
        },
      );
      closePromise = shared;
      return shared;
    },
  });
}

function mintChatRuntimeReceipt(permit: ProductionChatRuntimePermit): ProductionChatRuntimeReceipt {
  assertPermit(permit);
  const occurredAtMs = Date.now();
  if (occurredAtMs > permit.deadlineAtMs) throw new Error("chat_runtime_materialization_deadline_expired");
  return Object.freeze({
    kind: "chat_runtime_bootstrapped",
    operationId: permit.operationId,
    requestId: permit.requestId,
    chatThreadId: permit.chatThreadId,
    chatSurfaceSessionId: permit.chatSurfaceSessionId,
    runtimeBindingDigest: permit.runtimeBindingDigest,
    owner: Object.freeze({ ...permit.owner }),
    fenceToken: permit.fenceToken,
    occurredAtMs,
  });
}

/** Reverse close of resources acquired by one Chat runtime factory. */
export async function closeMaterializedChatRuntime(runtime: ChatRuntimeDisposal): Promise<void> {
  const errors: unknown[] = [];
  try { await runtime.authoredContextCapability?.clear(); } catch (error) { errors.push(error); }
  try {
    runtime.session.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "chat_runtime_materialization_close_failed");
}

function aggregateErrors(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors : [error];
}

function assertExecution(value: unknown): asserts value is ChatRuntimeBindingExecution {
  if (
    !plainFrozenRecord(value, ["principal", "runtimeRoot", "bindingFacts"]) ||
    !plainFrozenRecord(value.principal, ["continuityId", "companionId", "playerId"]) ||
    !identifier(value.principal.continuityId) ||
    !identifier(value.principal.companionId) ||
    !identifier(value.principal.playerId) ||
    typeof value.runtimeRoot !== "string" ||
    value.runtimeRoot.length === 0 ||
    !plainFrozenRecord(value.bindingFacts, ["runtimeBindingDigest", "runtimeInstanceId", "owner"]) ||
    !sha256(value.bindingFacts.runtimeBindingDigest) ||
    !identifier(value.bindingFacts.runtimeInstanceId) ||
    !validOwner(value.bindingFacts.owner) ||
    value.bindingFacts.owner.runtimeInstanceId !== value.bindingFacts.runtimeInstanceId
  )
    throw new Error("invalid_chat_runtime_binding_execution");
}

function assertExactPermit(execution: ChatRuntimeBindingExecution, permit: ProductionChatRuntimePermit): void {
  if (
    !validPermit(permit) ||
    !samePrincipal(permit.principal, execution.principal) ||
    permit.runtimeBindingDigest !== execution.bindingFacts.runtimeBindingDigest ||
    !sameOwner(permit.owner, execution.bindingFacts.owner)
  )
    throw new Error("chat_runtime_materialization_permit_rejected");
}

function assertPermit(permit: unknown): asserts permit is ProductionChatRuntimePermit {
  if (!validPermit(permit)) throw new Error("chat_runtime_materialization_permit_rejected");
}
function validPermit(value: unknown): value is ProductionChatRuntimePermit {
  if (
    !plainFrozenRecord(value, [
      "principal",
      "operationId",
      "requestId",
      "chatThreadId",
      "chatSurfaceSessionId",
      "runtimeBindingDigest",
      "owner",
      "deadlineAtMs",
      "expected",
      "payloadDigest",
      "fenceToken",
      "prepared",
    ])
  )
    return false;
  return (
    validPrincipal(value.principal) &&
    identifier(value.operationId) &&
    identifier(value.requestId) &&
    identifier(value.chatThreadId) &&
    identifier(value.chatSurfaceSessionId) &&
    sha256(value.runtimeBindingDigest) &&
    validOwner(value.owner) &&
    nonNegativeInteger(value.deadlineAtMs) &&
    Date.now() <= value.deadlineAtMs &&
    validVector(value.expected) &&
    sha256(value.payloadDigest) &&
    identifier(value.fenceToken) &&
    validVector(value.prepared)
  );
}
function assertRuntimeDisposal(value: unknown): asserts value is ChatRuntimeDisposal {
  if (
    !value ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "session") ||
    !(value as { session?: unknown }).session ||
    typeof (value as { session: { dispose?: unknown } }).session.dispose !== "function"
  )
    throw new Error("invalid_chat_runtime_materialization_result");
}
function validPrincipal(
  value: unknown,
): value is Readonly<{ continuityId: string; companionId: string; playerId: string }> {
  return (
    plainRecord(value, ["continuityId", "companionId", "playerId"]) &&
    identifier(value.continuityId) &&
    identifier(value.companionId) &&
    identifier(value.playerId)
  );
}
function validOwner(value: unknown): value is ProductionChatRuntimePermit["owner"] {
  return (
    plainRecord(value, ["ownerToken", "runtimeInstanceId", "ownerPid", "ownerProcessStartIdentity"]) &&
    identifier(value.ownerToken) &&
    identifier(value.runtimeInstanceId) &&
    Number.isSafeInteger(value.ownerPid) &&
    value.ownerPid > 0 &&
    identifier(value.ownerProcessStartIdentity)
  );
}
function validVector(value: unknown): boolean {
  return (
    plainRecord(value, ["partitionRevision", "fenceEpoch", "selectionRevision"]) &&
    nonNegativeInteger(value.partitionRevision) &&
    nonNegativeInteger(value.fenceEpoch) &&
    nonNegativeInteger(value.selectionRevision)
  );
}
function samePrincipal(left: unknown, right: unknown): boolean {
  return (
    validPrincipal(left) &&
    validPrincipal(right) &&
    left.continuityId === right.continuityId &&
    left.companionId === right.companionId &&
    left.playerId === right.playerId
  );
}
function sameOwner(left: unknown, right: unknown): boolean {
  return (
    validOwner(left) &&
    validOwner(right) &&
    left.ownerToken === right.ownerToken &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.ownerPid === right.ownerPid &&
    left.ownerProcessStartIdentity === right.ownerProcessStartIdentity
  );
}
function plainFrozenRecord(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return plainRecord(value, keys) && Object.isFrozen(value);
}
function plainRecord(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.getOwnPropertyNames(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
