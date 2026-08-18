import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type { HostDeploymentManifest } from "../deployment-manifest.js";

/**
 * Host-only Chat construction binding. It owns immutable deployment identity,
 * current Windows owner proof, and one close-drained materialization lease;
 * it contains no Game adapter, launch handle, World scope, or Game authority.
 */
export type OpaqueChatRuntimeBindingToken = Readonly<{
  readonly __opaqueChatRuntimeBindingToken: unique symbol;
}>;
export type ReservedChatRuntimeMaterialization = Readonly<{
  readonly __reservedChatRuntimeMaterialization: unique symbol;
}>;
export type ChatRuntimeBindingFacts = Readonly<{
  runtimeBindingDigest: string;
  runtimeInstanceId: string;
  owner: Readonly<{
    ownerToken: string;
    runtimeInstanceId: string;
    ownerPid: number;
    ownerProcessStartIdentity: string;
  }>;
}>;
export type ChatRuntimeBindingExecution = Readonly<{
  principal: Readonly<{ continuityId: string; companionId: string; playerId: string }>;
  runtimeRoot: string;
  bindingFacts: ChatRuntimeBindingFacts;
}>;
export type ChatRuntimeBinding = Readonly<{
  executeWithBinding<T>(callback: (token: OpaqueChatRuntimeBindingToken) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
}>;

type OwnerProofRecord = Readonly<{ processId: number; creationTime100ns: string }>;
type TokenRecord = {
  execution: ChatRuntimeBindingExecution;
  active: boolean;
  acceptingMaterialization: boolean;
  consumed: boolean;
  operations: Set<LeaseRecord>;
};
type LeaseRecord = {
  execution: ChatRuntimeBindingExecution;
  token: OpaqueChatRuntimeBindingToken;
  done: Promise<void>;
  resolve: () => void;
  consumed: boolean;
  released: boolean;
};

const ownerProofBrand = new WeakSet<object>();
const ownerProofRecords = new WeakMap<object, OwnerProofRecord>();
const tokenBrand = new WeakSet<object>();
const tokenRecords = new WeakMap<object, TokenRecord>();
const executionLifetimeRecords = new WeakMap<object, Readonly<{ token: OpaqueChatRuntimeBindingToken }>>();
const reservationRecords = new WeakMap<object, LeaseRecord>();
const activeExecutionScope = new AsyncLocalStorage<ChatRuntimeBindingExecution>();

/** Test construction is intentionally not exported from the public Chat binding module. */
export function createTestChatRuntimeBinding(
  input: Readonly<{
    manifest: HostDeploymentManifest;
    ownerProof: Readonly<{ processId: number; creationTime100ns: string }>;
  }>,
): ChatRuntimeBinding {
  assertManifest(input.manifest);
  assertOwnerProof(input.ownerProof);
  const ownerIdentity = Object.freeze(Object.create(null));
  ownerProofBrand.add(ownerIdentity);
  ownerProofRecords.set(ownerIdentity, Object.freeze({ ...input.ownerProof }));
  return createBoundChatRuntime(input.manifest, ownerIdentity);
}

/**
 * Production composition-only constructor. The deployment boundary supplies
 * its exact immutable manifest snapshot; this binding never loads or re-reads
 * deployment state itself.
 */
export async function createChatRuntimeBinding(manifest: HostDeploymentManifest): Promise<ChatRuntimeBinding> {
  assertManifest(manifest);
  if (process.platform !== "win32") throw new Error("windows_runtime_owner_identity_required");
  const proof = await queryCurrentOwnerProof();
  const ownerIdentity = Object.freeze(Object.create(null));
  ownerProofBrand.add(ownerIdentity);
  ownerProofRecords.set(ownerIdentity, proof);
  return createBoundChatRuntime(manifest, ownerIdentity);
}

/** Callback-only construction handoff; it cannot be replayed or re-created. */
export function withConsumedChatRuntimeBinding<T>(
  token: unknown,
  callback: (execution: ChatRuntimeBindingExecution) => Promise<T> | T,
): Promise<T> {
  if (typeof callback !== "function") throw new Error("invalid_chat_runtime_binding_callback");
  const execution = consumeBindingToken(token);
  let result: Promise<T> | T;
  try {
    result = activeExecutionScope.run(execution, () => callback(execution));
  } catch (error) {
    stopAcceptingForExecution(execution);
    throw error;
  }
  stopAcceptingForExecution(execution);
  return Promise.resolve(result);
}

/** Reserves exactly one unlocked Chat runtime effect while callback authority is live. */
export function reserveChatRuntimeMaterialization(execution: unknown): ReservedChatRuntimeMaterialization {
  if (!isExecution(execution) || activeExecutionScope.getStore() !== execution)
    throw new Error("chat_runtime_binding_execution_rejected");
  const lifetime = executionLifetimeRecords.get(execution);
  const record = lifetime === undefined ? undefined : tokenRecords.get(lifetime.token);
  if (
    !record ||
    record.execution !== execution ||
    !record.active ||
    !record.acceptingMaterialization ||
    !record.consumed ||
    record.operations.size !== 0
  ) {
    throw new Error("chat_runtime_binding_execution_rejected");
  }
  let resolve!: () => void;
  const lease: LeaseRecord = {
    execution,
    token: lifetime!.token,
    done: new Promise<void>((complete) => {
      resolve = complete;
    }),
    resolve,
    consumed: false,
    released: false,
  };
  const reservation = Object.freeze(Object.create(null)) as ReservedChatRuntimeMaterialization;
  reservationRecords.set(reservation, lease);
  record.operations.add(lease);
  return reservation;
}

/** Narrow facts for store prepare; it cannot reveal a runtime root or execution capability. */
export function readReservedChatRuntimeMaterializationFacts(value: unknown): Readonly<{
  runtimeBindingDigest: string;
  owner: ChatRuntimeBindingFacts["owner"];
}> {
  const lease = requireLiveReservation(value, false);
  return Object.freeze({
    runtimeBindingDigest: lease.execution.bindingFacts.runtimeBindingDigest,
    owner: Object.freeze({ ...lease.execution.bindingFacts.owner }),
  });
}

/** Internal materializer access after durable prepare; never reopens admission. */
export function consumeReservedChatRuntimeMaterialization(value: unknown): ChatRuntimeBindingExecution {
  const lease = requireLiveReservation(value, false);
  lease.consumed = true;
  return lease.execution;
}
export function releaseReservedChatRuntimeMaterialization(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const lease = reservationRecords.get(value);
  if (!lease || lease.released) return;
  lease.released = true;
  tokenRecords.get(lease.token)?.operations.delete(lease);
  lease.resolve();
}

function createBoundChatRuntime(manifest: HostDeploymentManifest, ownerIdentity: object): ChatRuntimeBinding {
  const proof = ownerProofRecords.get(ownerIdentity);
  if (!proof) throw new Error("invalid_windows_process_owner_identity");
  const runtimeInstanceId = randomUUID();
  const owner = Object.freeze({
    ownerToken: randomUUID(),
    runtimeInstanceId,
    ownerPid: proof.processId,
    ownerProcessStartIdentity: proof.creationTime100ns,
  });
  const principal = Object.freeze({ ...manifest.principal });
  const runtimeBindingDigest = createHash("sha256").update(JSON.stringify({ principal, owner }), "utf8").digest("hex");
  const execution: ChatRuntimeBindingExecution = Object.freeze({
    principal,
    runtimeRoot: manifest.runtimeRoot,
    bindingFacts: Object.freeze({ runtimeBindingDigest, runtimeInstanceId, owner }),
  });
  const token = Object.freeze(Object.create(null)) as OpaqueChatRuntimeBindingToken;
  const record: TokenRecord = {
    execution,
    active: true,
    acceptingMaterialization: true,
    consumed: false,
    operations: new Set(),
  };
  tokenBrand.add(token);
  tokenRecords.set(token, record);
  executionLifetimeRecords.set(execution, Object.freeze({ token }));
  let invoked = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    record.acceptingMaterialization = false;
    let attempt!: Promise<void>;
    attempt = Promise.all([...record.operations].map((operation) => operation.done)).then(
      () => {
        record.active = false;
      },
      (error) => {
        // A failed drain must not make the binding irreversibly uncloseable.
        // Retain active resources and permit a later close to retry the same operations.
        if (closePromise === attempt) closePromise = undefined;
        throw error;
      },
    );
    closePromise = attempt;
    return attempt;
  };
  const executeWithBinding = async <T>(
    callback: (token: OpaqueChatRuntimeBindingToken) => Promise<T> | T,
  ): Promise<T> => {
    if (invoked || !record.active || !record.acceptingMaterialization)
      throw new Error("chat_runtime_binding_unavailable");
    if (typeof callback !== "function") throw new Error("invalid_chat_runtime_binding_callback");
    invoked = true;
    try {
      return await callback(token);
    } finally {
      record.acceptingMaterialization = false;
    }
  };
  return Object.freeze({ executeWithBinding, close });
}

function consumeBindingToken(value: unknown): ChatRuntimeBindingExecution {
  if (typeof value !== "object" || value === null || !tokenBrand.has(value))
    throw new Error("invalid_chat_runtime_binding");
  const record = tokenRecords.get(value);
  if (!record || !record.active || !record.acceptingMaterialization || record.consumed)
    throw new Error("chat_runtime_binding_replay_rejected");
  record.consumed = true;
  return record.execution;
}
function stopAcceptingForExecution(execution: ChatRuntimeBindingExecution): void {
  const lifetime = executionLifetimeRecords.get(execution);
  const record = lifetime === undefined ? undefined : tokenRecords.get(lifetime.token);
  if (record) record.acceptingMaterialization = false;
}
function requireLiveReservation(value: unknown, allowConsumed: boolean): LeaseRecord {
  if (typeof value !== "object" || value === null) throw new Error("chat_runtime_binding_execution_rejected");
  const lease = reservationRecords.get(value);
  const record = lease === undefined ? undefined : tokenRecords.get(lease.token);
  if (
    !lease ||
    lease.released ||
    (!allowConsumed && lease.consumed) ||
    !record ||
    record.execution !== lease.execution ||
    !record.active
  ) {
    throw new Error("chat_runtime_binding_execution_rejected");
  }
  return lease;
}
function isExecution(value: unknown): value is ChatRuntimeBindingExecution {
  return typeof value === "object" && value !== null && executionLifetimeRecords.has(value);
}
function assertManifest(value: unknown): asserts value is HostDeploymentManifest {
  if (
    !value ||
    typeof value !== "object" ||
    !Object.isFrozen(value) ||
    !("principal" in value) ||
    !value.principal ||
    typeof value.principal !== "object" ||
    !Object.isFrozen(value.principal) ||
    !("runtimeRoot" in value)
  ) {
    throw new Error("invalid_host_deployment_manifest");
  }
}
function assertOwnerProof(value: unknown): asserts value is Readonly<{ processId: number; creationTime100ns: string }> {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger((value as { processId?: unknown }).processId) ||
    (value as { processId: number }).processId <= 0 ||
    typeof (value as { creationTime100ns?: unknown }).creationTime100ns !== "string" ||
    !/^[0-9]{1,20}$/.test((value as { creationTime100ns: string }).creationTime100ns) ||
    BigInt((value as { creationTime100ns: string }).creationTime100ns) <= 0n
  )
    throw new Error("invalid_windows_process_owner_identity");
}
async function queryCurrentOwnerProof(): Promise<OwnerProofRecord> {
  const run = promisify(execFile);
  const processId = process.pid;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$expectedProcessId = ${processId}`,
    "$processRecord = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $expectedProcessId)",
    "if ($null -eq $processRecord) { throw 'process_not_found' }",
    "$creationTicks = ([datetime]$processRecord.CreationDate).ToUniversalTime().Ticks",
    "[Console]::Out.WriteLine(([string]$processRecord.ProcessId + '|' + [string]$creationTicks))",
  ].join("; ");
  try {
    const result = await run(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 5_000, maxBuffer: 256, encoding: "utf8" },
    );
    if (result.stderr.length !== 0) throw new Error("unexpected_windows_owner_identity_stderr");
    const match = /^([1-9][0-9]{0,9})\|([1-9][0-9]{0,19})\r?\n$/.exec(result.stdout);
    if (!match || Number(match[1]) !== processId || !match[2]) throw new Error("invalid_windows_owner_identity_output");
    const proof = Object.freeze({ processId, creationTime100ns: match[2] });
    assertOwnerProof(proof);
    return proof;
  } catch {
    throw new Error("windows_runtime_owner_identity_query_failed");
  }
}
