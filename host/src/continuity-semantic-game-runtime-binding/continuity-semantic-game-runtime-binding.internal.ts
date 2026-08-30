import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

import type { IntegrationLaunchHandle } from "../integration-launcher.js";
import type { IntegrationWorldScope } from "../game-integration-adapter.js";
import type { GameConnection } from "../game-connection.js";

/** Construction-zone-only process owner proof. No fields are exposed on the proof object. */
export type OpaqueRuntimeOwnerIdentity = Readonly<{
  readonly __opaqueRuntimeOwnerIdentity: unique symbol;
}>;

/** Construction-zone-only execution capability. Consumers must not retain it past one callback. */
export type OpaqueGameRuntimeBindingToken = Readonly<{
  readonly __opaqueGameRuntimeBindingToken: unique symbol;
}>;

/** Durable Game-request facts minted once per validated Host launch. */
export type GameRuntimeBindingFacts = Readonly<{
  bindingDigest: string;
  runtimeInstanceId: string;
  owner: Readonly<{
    ownerToken: string;
    runtimeInstanceId: string;
    ownerPid: number;
    ownerProcessStartIdentity: string;
  }>;
}>;

export type GameRuntimeBindingExecution = Readonly<{
  /** Exact manifest tuple loaded by the construction-zone binding. */
  principal: Readonly<{ continuityId: string; companionId: string; playerId: string }>;
  /** Canonical deployment runtime root read from that same manifest. */
  runtimeRoot: string;
  connection: GameConnection;
  world: IntegrationWorldScope;
  launch: IntegrationLaunchHandle;
  ownerIdentity: OpaqueRuntimeOwnerIdentity;
  bindingFacts: GameRuntimeBindingFacts;
}>;

type OwnerProofRecord = Readonly<{ processId: number; creationTime100ns: string }>;
type TokenRecord = {
  execution: GameRuntimeBindingExecution;
  active: boolean;
  acceptingMaterialization: boolean;
  consumed: boolean;
  operations: Set<MaterializationLeaseRecord>;
};
type ExecutionLifetimeRecord = Readonly<{ token: OpaqueGameRuntimeBindingToken }>;
type MaterializationLeaseRecord = {
  execution: GameRuntimeBindingExecution;
  token: OpaqueGameRuntimeBindingToken;
  done: Promise<void>;
  resolve: () => void;
  consumed: boolean;
  released: boolean;
};
/** Callback-admitted, construction-zone-only reservation for one S4c effect. */
export type ReservedGameRuntimeMaterialization = Readonly<{
  readonly __reservedGameRuntimeMaterialization: unique symbol;
}>;

const ownerProofBrand = new WeakSet<object>();
const ownerProofRecords = new WeakMap<object, OwnerProofRecord>();
const tokenBrand = new WeakSet<object>();
const tokenRecords = new WeakMap<object, TokenRecord>();
const executionLifetimeRecords = new WeakMap<object, ExecutionLifetimeRecord>();
const materializationLeaseRecords = new WeakMap<object, MaterializationLeaseRecord>();
const activeExecutionScope = new AsyncLocalStorage<GameRuntimeBindingExecution>();

export function brandRuntimeOwnerIdentity(record: OwnerProofRecord): OpaqueRuntimeOwnerIdentity {
  if (
    !Number.isSafeInteger(record.processId) ||
    record.processId <= 0 ||
    !validCreationTime(record.creationTime100ns)
  ) {
    throw new Error("invalid_windows_process_owner_identity");
  }
  const proof = Object.freeze(Object.create(null)) as OpaqueRuntimeOwnerIdentity;
  ownerProofBrand.add(proof);
  ownerProofRecords.set(proof, Object.freeze({ ...record }));
  return proof;
}

export function assertRuntimeOwnerIdentity(value: unknown): asserts value is OpaqueRuntimeOwnerIdentity {
  if (!isObject(value) || !ownerProofBrand.has(value) || !Object.isFrozen(value)) {
    throw new Error("invalid_windows_process_owner_identity");
  }
}

export function readRuntimeOwnerIdentityRecord(value: OpaqueRuntimeOwnerIdentity): OwnerProofRecord {
  assertRuntimeOwnerIdentity(value);
  const record = ownerProofRecords.get(value);
  if (record === undefined) throw new Error("invalid_windows_process_owner_identity");
  return record;
}

export function mintGameRuntimeBindingFacts(
  input: Readonly<{
    principal: Readonly<{ continuityId: string; companionId: string; playerId: string }>;
    world: IntegrationWorldScope;
    ownerIdentity: OpaqueRuntimeOwnerIdentity;
  }>,
): GameRuntimeBindingFacts {
  const ownerRecord = readRuntimeOwnerIdentityRecord(input.ownerIdentity);
  const runtimeInstanceId = randomUUID();
  const owner = Object.freeze({
    ownerToken: randomUUID(),
    runtimeInstanceId,
    ownerPid: ownerRecord.processId,
    ownerProcessStartIdentity: ownerRecord.creationTime100ns,
  });
  const bindingDigest = createHash("sha256")
    .update(
      JSON.stringify({
        principal: input.principal,
        world: { integrationId: input.world.integrationId, saveId: input.world.saveId, worldId: input.world.worldId },
        owner,
      }),
      "utf8",
    )
    .digest("hex");
  return Object.freeze({ bindingDigest, runtimeInstanceId, owner });
}

export function mintBindingToken(execution: GameRuntimeBindingExecution): OpaqueGameRuntimeBindingToken {
  const token = Object.freeze(Object.create(null)) as OpaqueGameRuntimeBindingToken;
  tokenBrand.add(token);
  tokenRecords.set(token, {
    execution,
    active: true,
    acceptingMaterialization: true,
    consumed: false,
    operations: new Set(),
  });
  executionLifetimeRecords.set(execution, Object.freeze({ token }));
  return token;
}

export function stopAcceptingBindingMaterialization(token: OpaqueGameRuntimeBindingToken): void {
  const record = tokenRecords.get(token);
  if (record !== undefined) record.acceptingMaterialization = false;
}

function stopAcceptingBindingMaterializationForExecution(execution: GameRuntimeBindingExecution): void {
  const lifetime = executionLifetimeRecords.get(execution);
  if (lifetime !== undefined) stopAcceptingBindingMaterialization(lifetime.token);
}

export async function drainBindingMaterializations(token: OpaqueGameRuntimeBindingToken): Promise<void> {
  const record = tokenRecords.get(token);
  if (record === undefined) return;
  await Promise.all([...record.operations].map((operation) => operation.done));
}

export function revokeBindingToken(token: OpaqueGameRuntimeBindingToken): void {
  const record = tokenRecords.get(token);
  if (record !== undefined) {
    record.acceptingMaterialization = false;
    record.active = false;
  }
}

/**
 * Internal composer handoff. The execution is usable only during this callback;
 * retaining it or constructing a lookalike cannot materialize a second runtime.
 */
export function withConsumedBindingExecution<T>(
  token: unknown,
  callback: (execution: GameRuntimeBindingExecution) => Promise<T> | T,
): Promise<T> {
  if (typeof callback !== "function") throw new Error("invalid_game_runtime_binding_callback");
  const execution = consumeBindingToken(token);
  let result: Promise<T> | T;
  try {
    result = activeExecutionScope.run(execution, () => callback(execution));
  } catch (error) {
    // A synchronously returned callback has already left its construction
    // scope. Close admission before any detached microtask can inherit ALS.
    stopAcceptingBindingMaterializationForExecution(execution);
    throw error;
  }
  // S4c acquires its one materialization lease synchronously while the
  // composer invokes it. Close admission immediately after *any* callback
  // return (including an unsettled promise): later ALS-inheriting work may
  // complete that admitted lease, but can never begin another external effect.
  stopAcceptingBindingMaterializationForExecution(execution);
  return Promise.resolve(result);
}

/**
 * Acquires one S4c materialization lease. Detached async continuations inherit
 * AsyncLocalStorage, so ALS locates the callback but the token lifetime record
 * separately denies admission once callback completion or close has begun.
 */
export function reserveGameRuntimeMaterialization(execution: unknown): ReservedGameRuntimeMaterialization {
  if (!isGameRuntimeBindingExecution(execution) || activeExecutionScope.getStore() !== execution)
    throw new Error("game_runtime_binding_execution_rejected");
  const lifetime = executionLifetimeRecords.get(execution);
  if (lifetime === undefined) throw new Error("game_runtime_binding_execution_rejected");
  const record = tokenRecords.get(lifetime.token);
  if (
    record === undefined ||
    record.execution !== execution ||
    !record.active ||
    !record.acceptingMaterialization ||
    !record.consumed ||
    record.operations.size !== 0
  ) {
    throw new Error("game_runtime_binding_execution_rejected");
  }
  let resolve!: () => void;
  const activeExecution = execution as GameRuntimeBindingExecution;
  const leaseRecord: MaterializationLeaseRecord = {
    execution: activeExecution,
    token: lifetime.token,
    done: new Promise<void>((complete) => {
      resolve = complete;
    }),
    resolve,
    consumed: false,
    released: false,
  };
  const reservation = Object.freeze(Object.create(null)) as ReservedGameRuntimeMaterialization;
  materializationLeaseRecords.set(reservation, leaseRecord);
  record.operations.add(leaseRecord);
  return reservation;
}

/** Consumes one already-admitted reservation without re-opening callback admission. */
/** Returns only the immutable facts required to durably prepare the reservation's one effect. */
export function readReservedGameRuntimeMaterializationFacts(value: unknown): Readonly<{
  world: IntegrationWorldScope;
  bindingDigest: string;
  owner: GameRuntimeBindingFacts["owner"];
}> {
  if (!isObject(value)) throw new Error("game_runtime_binding_execution_rejected");
  const lease = materializationLeaseRecords.get(value);
  const record = lease === undefined ? undefined : tokenRecords.get(lease.token);
  if (
    lease === undefined ||
    lease.released ||
    lease.consumed ||
    record === undefined ||
    record.execution !== lease.execution ||
    !record.active
  ) {
    throw new Error("game_runtime_binding_execution_rejected");
  }
  return Object.freeze({
    world: Object.freeze({
      integrationId: lease.execution.world.integrationId,
      saveId: lease.execution.world.saveId,
      worldId: lease.execution.world.worldId,
    }),
    bindingDigest: lease.execution.bindingFacts.bindingDigest,
    owner: Object.freeze({ ...lease.execution.bindingFacts.owner }),
  });
}

export function consumeReservedGameRuntimeMaterialization(value: unknown): GameRuntimeBindingExecution {
  if (!isObject(value)) throw new Error("game_runtime_binding_execution_rejected");
  const lease = materializationLeaseRecords.get(value);
  const record = lease === undefined ? undefined : tokenRecords.get(lease.token);
  if (
    lease === undefined ||
    lease.released ||
    lease.consumed ||
    record === undefined ||
    record.execution !== lease.execution ||
    !record.active
  ) {
    throw new Error("game_runtime_binding_execution_rejected");
  }
  lease.consumed = true;
  return lease.execution;
}

export function releaseReservedGameRuntimeMaterialization(value: unknown): void {
  if (!isObject(value)) return;
  const lease = materializationLeaseRecords.get(value);
  if (lease === undefined || lease.released) return;
  lease.released = true;
  tokenRecords.get(lease.token)?.operations.delete(lease);
  lease.resolve();
}

/** Internal test/readback helper. It does not grant an active S4c materialization scope. */
export function consumeBindingToken(token: unknown): GameRuntimeBindingExecution {
  if (!isObject(token) || !tokenBrand.has(token)) throw new Error("invalid_game_runtime_binding");
  const record = tokenRecords.get(token);
  if (record === undefined || !record.active || !record.acceptingMaterialization || record.consumed)
    throw new Error("game_runtime_binding_replay_rejected");
  record.consumed = true;
  return record.execution;
}

function validCreationTime(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value) && BigInt(value) > 0n;
}
function isGameRuntimeBindingExecution(value: unknown): value is GameRuntimeBindingExecution {
  return typeof value === "object" && value !== null;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
