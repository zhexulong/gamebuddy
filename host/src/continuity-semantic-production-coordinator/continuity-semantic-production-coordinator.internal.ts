import { createHash, randomUUID } from "node:crypto";
import {
  createChatRuntimeBindingFromManifest,
  type OpaqueChatRuntimeBindingToken,
  readReservedChatRuntimeMaterializationFacts,
  releaseReservedChatRuntimeMaterialization,
  reserveChatRuntimeMaterialization,
  withConsumedChatRuntimeBinding,
} from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { createHostChatRuntimeMaterializer } from "../continuity-semantic-chat-runtime-materializer/continuity-semantic-chat-runtime-materializer.js";
import type { MaterializedChatRuntime } from "../continuity-semantic-chat-runtime-materializer/continuity-semantic-chat-runtime-materializer.internal.js";
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
  ProductionChatRuntimeFailureInput,
  ProductionChatRuntimeOwner,
  ProductionChatRuntimePrepareOutcome,
  ProductionChatRuntimeReadback,
  ProductionChatRuntimeReceipt,
  ProductionChatRuntimeRequest,
  ProductionChatRuntimeTeardownPermit,
  ProductionChatRuntimeTeardownReadback,
  ProductionChatRuntimeTeardownReceipt,
  ProductionChatRuntimeTeardownRequest,
  ProductionChatRuntimeTerminalInput,
  ProductionGameOwner,
  ProductionGamePermit,
  ProductionGamePrepareOutcome,
  ProductionGameReadback,
  ProductionGameTerminalReceipt,
  ProductionGameWorld,
  ProductionSagaReadback,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { RuntimeSession } from "../runtime.js";
import type { CreateChatThreadRequest } from "../tavern/chat-thread-store.js";
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
/** This is deliberately opaque outside this module.  Its identity, not its shape, is the capability. */
type DialogueSagaHolder = object;
type Brand = Readonly<{ digest: string; operations: readonly string[] }>;
const brands = new WeakMap<object, Brand>();

/**
 * Host-minted mounted Chat capability. Its non-forgeable close authority stays
 * in the coordinator; consumers receive neither binding, store nor permit.
 */
export type MountedChatRuntimeLease = Readonly<{
  runtimeSession: RuntimeSession;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  close(): Promise<void>;
}>;
type MountedChatRuntimeLeaseRecord = Readonly<{ close(): Promise<void> }>;
const mountedChatRuntimeLeases = new WeakMap<object, MountedChatRuntimeLeaseRecord>();

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
  const facts = Object.freeze({
    principal: p.principal,
    bootstrapOperationId: p.bootstrapOperationId,
    authorityGeneration: p.authorityGeneration,
    storeId: p.storeId,
    schemaVersion: p.schemaVersion,
    authorityRootIdentity: p.authorityRootIdentity,
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(facts).sort())))
    .digest("hex");
  brands.set(
    holder,
    Object.freeze({
      digest,
      operations: Object.freeze(
        ["claim_empty", "register_exact", "verify_exact_content", "select_open"].map((step) =>
          createHash("sha256").update(`${digest}\0${step}`).digest("hex"),
        ),
      ),
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
  let binding: Awaited<ReturnType<typeof createChatRuntimeBindingFromManifest>> | undefined;
  try {
    const admission = createCanonicalProductionAuthorityAdmission(input.runtimeCwd);
    provision = await openProvisionWithAdmission(
      () => provisionFreshProductionContinuityFromCanonicalAdmission(input, admission),
      admission.authorityRootIdentity,
      mutex,
    );
    semantic = create(provision, mutex);
    await semantic.initializeInitialChat(createManifestDerivedInitialChatExactContentPort(manifest));
    binding = await createChatRuntimeBindingFromManifest(manifest);
    return createFreshChatRuntimeAuthority(provision, semantic, binding, mutex, broker);
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
    return createKnownGameAuthority(provision, mutex, createOwnedMutexCloser(mutex, broker));
  } catch (error) {
    await closeOwnedMutex(mutex, broker);
    throw error;
  }
}

async function createFreshChatRuntimeAuthority(
  provision: FreshContinuityProvision,
  semantic: SemanticProductionAuthority,
  binding: Awaited<ReturnType<typeof createChatRuntimeBindingFromManifest>>,
  mutex: WindowsAuthorityRootMutex,
  broker: WindowsNamedMutexBroker,
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
          materialized = await createHostChatRuntimeMaterializer().materialize(reservation, permit);
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
      if (mountedStartPromise !== undefined) return mountedStartPromise;
      mountedStartPromise = startChatRuntime().then((readback) => {
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
        ) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_mount_readback_rejected");
        let lease!: MountedChatRuntimeLease;
        lease = Object.freeze({
          runtimeSession,
          chatThreadId: readback.chatThreadId,
          chatSurfaceSessionId: readback.chatSurfaceSessionId,
          close(this: unknown): Promise<void> {
            if (this !== lease || !mountedChatRuntimeLeases.has(lease))
              return Promise.reject(new SemanticProductionCoordinatorError("semantic_chat_runtime_lease_rejected"));
            return mountedChatRuntimeLeases.get(lease)!.close();
          },
        });
        mountedChatRuntimeLeases.set(lease, Object.freeze({ close: () => authority.close() }));
        return lease;
      });
      return mountedStartPromise;
    },
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
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
              owner: permit.owner,
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
        try {
          await seal();
        } catch (sealError) {
          throw sealError;
        }
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
        try {
          await seal();
        } catch (sealError) {
          throw sealError;
        }
        throw error;
      }
      try {
        await release(lease);
      } catch (error) {
        try {
          await seal();
        } catch (sealError) {
          throw sealError;
        }
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
    try {
      lease = await requireLease(mutex, provision.authorityRootIdentity, provision, () => {
        poisoned = true;
        closing = true;
      });
    } catch (error) {
      throw error;
    }
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
    kind: "register" | "verify" | "select" | "lifecycle",
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
        const receipt = await ensureRegisteredContent(content, registered, request);
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
        if (current.phase === "claimed_empty") {
          // A crash after claim leaves no binding to read from Tavern. Continue the
          // same saga by registering first, then use the create-or-read exact port.
          const registered = await stepUnchecked(1);
          const receipt = await ensureRegisteredContent(content, registered);
          const verified = await verifyUnchecked(receipt);
          if (!verified.receipt || !sameTavernExactContentReceipt(receipt, verified.receipt))
            throw new SemanticProductionCoordinatorError("tavern_exact_content_receipt_mismatch");
          return stepUnchecked(3);
        }
        if (!current.chatThreadId || !current.chatSurfaceSessionId)
          throw new SemanticProductionCoordinatorError("initial_chat_binding_missing");
        // Every reopen phase re-reads Tavern through the current process's genuine
        // capability. A SQLite receipt is data, never trusted Tavern evidence.
        if (current.phase === "chat_registered") {
          // Registration persisted the exact semantic binding but may have crashed
          // before Tavern content creation. Reconciliation owns create-or-read only
          // for this registered phase; later phases must prove durable exact resume.
          const receipt = await ensureRegisteredContent(content, current);
          const verified = await verifyUnchecked(receipt);
          if (!verified.receipt || !sameTavernExactContentReceipt(receipt, verified.receipt))
            throw new SemanticProductionCoordinatorError("tavern_exact_content_receipt_mismatch");
        } else if (current.phase === "content_verified") {
          const receipt = await content.resumeExact(
            current.chatThreadId,
            provision.principal.companionId,
            provision.principal.continuityId,
            current.chatSurfaceSessionId,
          );
          if (!isTrustedTavernExactContentReceipt(receipt))
            throw new SemanticProductionCoordinatorError("untrusted_tavern_exact_content_receipt");
          if (!current.receipt || !sameTavernExactContentReceipt(receipt, current.receipt))
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
  async function ensureRegisteredContent(
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
    // No lease spans this await. The port itself only accepts Tavern's published branded capability.
    const receipt = await content.ensureExactContent(
      Object.freeze({
        chatThreadId: registered.chatThreadId,
        chatSurfaceSessionId: registered.chatSurfaceSessionId,
        companionId: provision.principal.companionId,
        continuityId: provision.principal.continuityId,
      }),
      exactRequest,
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
  closeDependencies: () => Promise<void>,
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
        return outcome.permit;
      }),
    );
  const retire = (live: LiveSemanticGame): void => {
    const record = liveGames.get(live);
    if (liveGames.delete(live)) {
      if (record && liveByEnterOperation.get(record.operationId) === live)
        liveByEnterOperation.delete(record.operationId);
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
  return Object.freeze({
    authority: "SEMANTIC" as const,
    prepareEnter,
    commitEnter,
    failEnter,
    prepareClose,
    commitClose,
    failClose,
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
    try {
      await lease.safetySealAfterAbandonedQuarantineFailure();
    } catch (sealError) {
      throw sealError;
    }
    throw error;
  }
  poisonBeforeVerifiedRelease?.();
  try {
    await lease.release();
  } catch (error) {
    try {
      await lease.safetySealAfterAbandonedQuarantineFailure();
    } catch (sealError) {
      throw sealError;
    }
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
