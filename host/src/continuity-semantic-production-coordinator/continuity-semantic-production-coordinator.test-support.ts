import {
  readReservedChatRuntimeMaterializationFacts,
  reserveChatRuntimeMaterialization,
  withConsumedChatRuntimeBinding,
  releaseReservedChatRuntimeMaterialization,
  type ChatRuntimeBinding,
  type ChatRuntimeBindingFacts,
  type OpaqueChatRuntimeBindingToken,
  type ReservedChatRuntimeMaterialization,
} from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type {
  ChatRuntimeMaterializer,
  MaterializedChatRuntime,
} from "../continuity-semantic-chat-runtime-materializer/continuity-semantic-chat-runtime-materializer.internal.js";
import type {
  ProductionChatRuntimePrepareOutcome,
  ProductionChatRuntimeReceipt,
  ProductionChatRuntimePermit,
  ProductionChatRuntimeReadback,
  ProductionChatRuntimeTeardownPermit,
  ProductionChatRuntimeTeardownReceipt,
  ProductionChatRuntimeTeardownReadback,
  ProductionChatRuntimeTeardownRequest,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { SemanticProductionCoordinatorError } from "./continuity-semantic-production-coordinator.internal.js";
import type { RuntimeSession } from "../runtime.js";

export type TestMountedChatRuntimeLease = Readonly<{
  runtimeSession: RuntimeSession;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  close(): Promise<void>;
}>;
export type SemanticChatRuntimeCoordinator = Readonly<{
  start(): Promise<ProductionChatRuntimeReadback>;
  startMounted(): Promise<TestMountedChatRuntimeLease>;
  close(): Promise<void>;
}>;
export type SemanticChatRuntimeCoordinatorOptions = Readonly<{
  binding: ChatRuntimeBinding;
  materializer: ChatRuntimeMaterializer;
  locked<T>(work: () => T): Promise<T>;
  store: Readonly<{
    prepare(
      facts: Readonly<{ runtimeBindingDigest: string; owner: ChatRuntimeBindingFacts["owner"] }>,
    ): ProductionChatRuntimePrepareOutcome;
    commit(permit: ProductionChatRuntimePermit, receipt: ProductionChatRuntimeReceipt): ProductionChatRuntimeReadback;
    fail(permit: ProductionChatRuntimePermit): ProductionChatRuntimeReadback;
    prepareTeardown?(request: ProductionChatRuntimeTeardownRequest): Readonly<{
      outcome: "effect_owned" | "completed" | "effect_pending" | "recovery_required";
      permit: ProductionChatRuntimeTeardownPermit | null;
      readback: ProductionChatRuntimeTeardownReadback;
    }>;
    commitTeardown?(
      permit: ProductionChatRuntimeTeardownPermit,
      receipt: ProductionChatRuntimeTeardownReceipt,
    ): ProductionChatRuntimeTeardownReadback;
  }>;
  closeDependencies?: () => Promise<void>;
}>;

/** Test-only coordinator harness for deterministic v40 teardown protocol tests. */
export function createTestSemanticChatRuntimeCoordinator(
  options: SemanticChatRuntimeCoordinatorOptions,
): SemanticChatRuntimeCoordinator {
  let closing = false;
  let closed = false;
  let pending = 0;
  let closePromise: Promise<void> | undefined;
  type LiveRecord = {
    runtime: MaterializedChatRuntime;
    bootstrapPermit: ProductionChatRuntimePermit;
    vector: ProductionChatRuntimeReadback["vector"];
    teardownPermit?: ProductionChatRuntimeTeardownPermit;
    teardownReceipt?: ProductionChatRuntimeTeardownReceipt;
    physicallyClosed: boolean;
  };
  let live: LiveRecord | undefined;
  let bindingClosed = false;
  let dependenciesClosed = false;
  let startPromise: Promise<ProductionChatRuntimeReadback> | undefined;
  let mountedStartPromise: Promise<TestMountedChatRuntimeLease> | undefined;
  const mountedLeases = new WeakMap<object, Readonly<{ close(): Promise<void> }>>();
  const drainWaiters = new Set<() => void>();
  const waitForDrain = (): Promise<void> =>
    pending === 0 ? Promise.resolve() : new Promise((resolve) => drainWaiters.add(resolve));
  const begin = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing || closed)
      return Promise.reject(new SemanticProductionCoordinatorError("semantic_chat_runtime_coordinator_closed"));
    pending++;
    return work().finally(() => {
      pending--;
      if (pending === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    });
  };
  const start = (): Promise<ProductionChatRuntimeReadback> => {
    if (startPromise) return startPromise;
    startPromise = begin(async () => {
      let reservation: ReservedChatRuntimeMaterialization | undefined;
      try {
        await options.binding.executeWithBinding((token: OpaqueChatRuntimeBindingToken) =>
          withConsumedChatRuntimeBinding(token, (execution) => {
            reservation = reserveChatRuntimeMaterialization(execution);
          }),
        );
        if (!reservation) throw new SemanticProductionCoordinatorError("semantic_chat_runtime_reservation_missing");
        const facts = readReservedChatRuntimeMaterializationFacts(reservation);
        const prepared = await options.locked(() => options.store.prepare(facts));
        if (prepared.outcome !== "effect_owned" || prepared.permit === null) {
          releaseReservedChatRuntimeMaterialization(reservation);
          return prepared.readback;
        }
        const permit = prepared.permit;
        let materialized: MaterializedChatRuntime;
        try {
          materialized = await options.materializer.materialize(reservation, permit);
        } catch (error) {
          try {
            await attemptDurableFail(options, permit, error);
          } catch (failure) {
            throw failure;
          }
          throw error;
        }
        reservation = undefined;
        let committed: ProductionChatRuntimeReadback;
        try {
          committed = await options.locked(() => options.store.commit(permit, materialized.receipt));
        } catch (error) {
          try {
            await closeAndFail(options, permit, materialized, error);
          } catch (failure) {
            throw failure;
          }
          throw error;
        }
        if (committed.status !== "terminal" || committed.runtimeState !== "active") {
          const recoveryRequired = new SemanticProductionCoordinatorError("semantic_chat_runtime_recovery_required");
          try {
            await closeAndFail(options, permit, materialized, recoveryRequired);
          } catch (failure) {
            throw failure;
          }
          throw recoveryRequired;
        }
        live = { runtime: materialized, bootstrapPermit: permit, vector: committed.vector, physicallyClosed: false };
        return committed;
      } finally {
        if (reservation) releaseReservedChatRuntimeMaterialization(reservation);
      }
    });
    return startPromise;
  };
  let coordinator!: SemanticChatRuntimeCoordinator;
  coordinator = Object.freeze({
    start,
    startMounted: () => {
      if (mountedStartPromise) return mountedStartPromise;
      mountedStartPromise = start().then((readback) => {
        const runtimeSession = live?.runtime.runtimeSession;
        if (
          !live ||
          !runtimeSession ||
          readback.status !== "terminal" ||
          readback.runtimeState !== "active" ||
          readback.operationId !== live.bootstrapPermit.operationId ||
          readback.requestId !== live.bootstrapPermit.requestId ||
          readback.chatThreadId !== live.runtime.receipt.chatThreadId ||
          readback.chatSurfaceSessionId !== live.runtime.receipt.chatSurfaceSessionId
        )
          throw new SemanticProductionCoordinatorError("semantic_chat_runtime_mount_readback_rejected");
        let lease!: TestMountedChatRuntimeLease;
        lease = Object.freeze({
          runtimeSession,
          chatThreadId: readback.chatThreadId,
          chatSurfaceSessionId: readback.chatSurfaceSessionId,
          close(this: unknown): Promise<void> {
            if (this !== lease || !mountedLeases.has(lease))
              return Promise.reject(new SemanticProductionCoordinatorError("semantic_chat_runtime_lease_rejected"));
            return mountedLeases.get(lease)!.close();
          },
        });
        mountedLeases.set(lease, Object.freeze({ close: () => coordinator.close() }));
        return lease;
      });
      return mountedStartPromise;
    },
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      const attempt = (async () => {
        await waitForDrain();
        if (live) {
          const record = live;
          if (!options.store.prepareTeardown || !options.store.commitTeardown) {
            // Existing construction-only tests that do not model v40 store rows
            // retain a deterministic direct-disposal path; all protocol-aware
            // callers take the exact prepare/commit path below.
            if (!record.physicallyClosed) {
              await record.runtime.close();
              record.physicallyClosed = true;
            }
          } else if (!record.teardownPermit) {
            const request = Object.freeze({
              principal: record.bootstrapPermit.principal,
              operationId: "teardown_01",
              requestId: "teardown_request_01",
              bootstrapOperationId: record.bootstrapPermit.operationId,
              chatThreadId: record.bootstrapPermit.chatThreadId,
              chatSurfaceSessionId: record.bootstrapPermit.chatSurfaceSessionId,
              runtimeBindingDigest: record.bootstrapPermit.runtimeBindingDigest,
              owner: record.bootstrapPermit.owner,
              deadlineAtMs: Date.now() + 30_000,
              expected: { ...record.vector },
            });
            const prepared = await options.locked(() => options.store.prepareTeardown!(request));
            if (prepared.outcome !== "effect_owned" || !prepared.permit)
              throw new SemanticProductionCoordinatorError("semantic_chat_runtime_teardown_not_effect_owned");
            record.teardownPermit = prepared.permit;
          }
          if (options.store.prepareTeardown && options.store.commitTeardown) {
            if (!record.physicallyClosed) {
              await record.runtime.close();
              record.physicallyClosed = true;
            }
            if (!record.teardownReceipt) {
              const permit = record.teardownPermit!;
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
            const terminal = await options.locked(() =>
              options.store.commitTeardown!(record.teardownPermit!, record.teardownReceipt!),
            );
            if (terminal.status !== "terminal" || terminal.runtimeState !== "closed")
              throw new SemanticProductionCoordinatorError("semantic_chat_runtime_teardown_not_terminal");
          }
        }
        if (live) live = undefined;
        if (!bindingClosed) {
          await options.binding.close();
          bindingClosed = true;
        }
        if (!dependenciesClosed) {
          await options.closeDependencies?.();
          dependenciesClosed = true;
        }
        closed = true;
      })();
      closePromise = attempt;
      void attempt.catch(() => {
        if (!closed) closePromise = undefined;
      });
      return attempt;
    },
  });
  return coordinator;
}

async function attemptDurableFail(
  options: SemanticChatRuntimeCoordinatorOptions,
  permit: ProductionChatRuntimePermit,
  primary: unknown,
): Promise<void> {
  try {
    await options.locked(() => options.store.fail(permit));
  } catch (failError) {
    throw new AggregateError([primary, failError], "semantic_chat_runtime_effect_failure");
  }
}

async function closeAndFail(
  options: SemanticChatRuntimeCoordinatorOptions,
  permit: ProductionChatRuntimePermit,
  materialized: MaterializedChatRuntime,
  primary: unknown,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await materialized.close();
  } catch (closeError) {
    failures.push(closeError);
  }
  try {
    await options.locked(() => options.store.fail(permit));
  } catch (failError) {
    failures.push(failError);
  }
  if (failures.length) throw new AggregateError([primary, ...failures], "semantic_chat_runtime_effect_failure");
}
