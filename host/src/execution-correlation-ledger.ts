import type { ExecutionReceipt, ExecutionRequest, ExecutionState } from "./protocol.js";
import type {
  StardewLogicalActionRecoveryJournal,
  StardewLogicalActionRecoveryRecord,
} from "./stardew-logical-action-recovery-journal.js";

export type ExecutionCorrelationOwner = Readonly<{
  ownerId: string;
  epoch: number;
}>;

export type ExecutionDispatch = ExecutionCorrelationOwner &
  Readonly<{
    requestId: string;
    /** Original immutable key, retained only for exact read-only receipt recovery. */
    idempotencyKey?: string;
    /** Optional complete request material for the private Stardew recovery journal. */
    recoveryMaterial?: Readonly<{
      logicalActionId: string;
      dispatchOrdinal?: number;
      request: ExecutionRequest;
      scope?: Readonly<Record<string, unknown>>;
      bindingIdentity?: Readonly<Record<string, unknown>>;
    }>;
  }>;

export type ExecutionCancelSender = (
  requestId: string,
  executionId: string,
  reasonCode: string,
) => Promise<ExecutionReceipt>;

export interface ExecutionDispatchObserver {
  beforeWrite(dispatch: ExecutionDispatch): void | Promise<void>;
  bindReceipt(receipt: ExecutionReceipt): void | Promise<void>;
  markUncertain(dispatch: ExecutionDispatch): void | Promise<void>;
}

export type RecoverableExecutionDispatch = Readonly<{
  ownerId: string;
  epoch: number;
  requestId: string;
  idempotencyKey: string;
  logicalActionId?: string;
  dispatchOrdinal?: number;
  actionId?: string;
  args?: Readonly<Record<string, unknown>>;
  expectedRevision?: number;
  deadlineMs?: number;
  scope?: Readonly<Record<string, unknown>>;
  bindingIdentity?: Readonly<Record<string, unknown>>;
}>;

type Correlation = ExecutionDispatch & {
  executionId: string | null;
  uncertain: boolean;
  cancelRequired: string | null;
  cancelSent: boolean;
  cancelPromise: Promise<ExecutionReceipt> | null;
  cancelSettled: Promise<void> | null;
  resolveCancelSettled: (() => void) | null;
  rejectCancelSettled: ((error: unknown) => void) | null;
};

/**
 * Single terminal-state authority for receipt lifetime decisions: after one
 * of these states a Mod-owned execution can never resume, so the correlation
 * retires and a pending STOP cancellation barrier settles without a cancel
 * request. Progress states (`accepted`, `running`, `meaningful_progress`) are
 * deliberately absent; a receipt in one of those states must keep the
 * correlation alive until a later terminal receipt or an exact cancel settles.
 */
export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = Object.freeze([
  "blocked",
  "invalidated",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "expired",
  "rejected",
  "uncertain",
] as const);

/** The launcher and every correlation consumer share this single classification. */
export function isTerminalExecutionState(state: ExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.includes(state);
}

/**
 * Runtime-local correlation only. This does not infer execution state or
 * authority from a receipt; it records dispatches and sends each exact cancel
 * request at most once after the Mod has supplied an execution id.
 */
export class ExecutionCorrelationLedger implements ExecutionDispatchObserver {
  readonly #byRequestId = new Map<string, Correlation>();
  readonly #tombstones = new Map<string, true>();
  readonly #maxTombstones: number;
  readonly #sendCancel: ExecutionCancelSender;
  readonly #recoveryJournal: StardewLogicalActionRecoveryJournal | undefined;
  readonly #preparingRequestIds = new Set<string>();

  constructor(
    sendCancel: ExecutionCancelSender,
    options: Readonly<{
      maxTombstones?: number;
      recoveryJournal?: StardewLogicalActionRecoveryJournal;
    }> = {},
  ) {
    this.#sendCancel = sendCancel;
    this.#recoveryJournal = options.recoveryJournal;
    this.#maxTombstones = options.maxTombstones ?? 256;
    if (!Number.isSafeInteger(this.#maxTombstones) || this.#maxTombstones < 1)
      throw new Error("invalid_execution_correlation_tombstone_limit");
  }

  beforeWrite(dispatch: ExecutionDispatch): void | Promise<void> {
    assertDispatch(dispatch);
    if (
      this.#byRequestId.has(dispatch.requestId) ||
      this.#tombstones.has(dispatch.requestId) ||
      this.#preparingRequestIds.has(dispatch.requestId)
    )
      throw new Error("duplicate_execution_correlation");

    if (this.#recoveryJournal === undefined) {
      this.#insert(dispatch);
      return;
    }

    const material = dispatch.recoveryMaterial;
    if (material === undefined) throw new Error("recovery_material_required");
    this.#preparingRequestIds.add(dispatch.requestId);
    const record = {
      logicalActionId: material.logicalActionId,
      dispatchOrdinal:
        material.dispatchOrdinal ?? this.#recoveryJournal.allocateDispatchOrdinal(),
      ownerId: dispatch.ownerId,
      epoch: dispatch.epoch,
      requestId: dispatch.requestId,
      idempotencyKey: material.request.idempotencyKey,
      actionId: material.request.action,
      canonicalRequest: material.request,
      canonicalArgs: material.request.args,
      expectedRevision: material.request.expectedRevision,
      deadlineMs: material.request.deadlineMs,
      ...(material.scope === undefined ? {} : { scope: material.scope }),
      ...(material.bindingIdentity === undefined
        ? {}
        : { bindingIdentity: material.bindingIdentity }),
    };
    return this.#recoveryJournal.prepare(record).then(
      () => {
        this.#preparingRequestIds.delete(dispatch.requestId);
        this.#insert({
          ...dispatch,
          idempotencyKey: material.request.idempotencyKey,
          recoveryMaterial: {
            ...material,
            dispatchOrdinal: record.dispatchOrdinal,
          },
        });
      },
      (error) => {
        this.#preparingRequestIds.delete(dispatch.requestId);
        throw error;
      },
    );
  }

  bindReceipt(receipt: ExecutionReceipt): void | Promise<void> {
    const correlation = this.#byRequestId.get(receipt.requestId);
    if (correlation === undefined) return;
    if (correlation.executionId !== null && correlation.executionId !== receipt.executionId)
      throw new Error("execution_correlation_receipt_mismatch");
    const material = correlation.recoveryMaterial;
    const journalRecord =
      material === undefined || this.#recoveryJournal === undefined
        ? null
        : this.#recoveryJournal.record(material.logicalActionId);
    if (journalRecord?.state === "recovery_required")
      throw new Error("execution_correlation_recovery_required");
    if (material !== undefined && material.request.action !== receipt.actionId)
      throw new Error("execution_correlation_action_mismatch");
    correlation.executionId = receipt.executionId;
    correlation.uncertain = false;
    if (isTerminalExecutionState(receipt.state)) {
      const settle =
        this.#recoveryJournal === undefined || material === undefined
          ? undefined
          : this.#recoveryJournal.markTerminalSettled(material.logicalActionId);
      if (settle !== undefined) {
        return settle.then(
          () => {
            correlation.resolveCancelSettled?.();
            this.#retire(correlation);
          },
          (error) => {
            correlation.uncertain = true;
            throw error;
          },
        );
      }
      correlation.resolveCancelSettled?.();
      this.#retire(correlation);
      return;
    }
    const pending =
      this.#recoveryJournal === undefined || material === undefined
        ? undefined
        : this.#recoveryJournal.markRecoveryPending(material.logicalActionId);
    if (pending !== undefined) {
      return pending.then(
        () => {
          this.#sendPendingCancel(correlation);
        },
        (error) => {
          correlation.uncertain = true;
          throw error;
        },
      );
    }
    this.#sendPendingCancel(correlation);
  }

  markUncertain(dispatch: ExecutionDispatch): void | Promise<void> {
    const correlation = this.#require(dispatch);
    if (correlation.executionId !== null) return;
    correlation.uncertain = true;
    const material = correlation.recoveryMaterial;
    if (this.#recoveryJournal === undefined || material === undefined) return;
    return this.#recoveryJournal.markSentUnknown(material.logicalActionId).then(
      () => this.#recoveryJournal!.markRecoveryPending(material.logicalActionId),
    ).then(
      () => undefined,
      (error) => {
        correlation.uncertain = false;
        throw error;
      },
    );
  }

  /** Mark one owner's registrations before any asynchronous work. */
  requestCancelOwner(owner: ExecutionCorrelationOwner, reasonCode: string): readonly Promise<ExecutionReceipt>[] {
    assertOwner(owner);
    return [...this.#byRequestId.values()]
      .filter((correlation) => correlation.ownerId === owner.ownerId && correlation.epoch === owner.epoch)
      .map((correlation) => this.#requestCancel(correlation, reasonCode))
      .filter((promise): promise is Promise<ExecutionReceipt> => promise !== null);
  }

  /**
   * Runtime STOP must await every old registration. A pre-receipt registration
   * remains pending until it becomes terminal or its late exact cancellation settles.
   */
  requestCancelEpoch(epoch: number, reasonCode: string): readonly Promise<void>[] {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("invalid_execution_correlation_epoch");
    return [...this.#byRequestId.values()]
      .filter((correlation) => correlation.epoch === epoch)
      .map((correlation) => {
        this.#requestCancel(correlation, reasonCode);
        return correlation.cancelSettled!;
      });
  }

  /**
   * Bounded uncertain dispatches that carry the original immutable key. This
   * is descriptive only: callers may query a fresh authenticated Mod binding,
   * never resend the action request.
   */
  uncertainDispatches(): readonly RecoverableExecutionDispatch[] {
    return Object.freeze(
      [...this.#byRequestId.values()]
        .filter(
          (correlation): correlation is Correlation & { idempotencyKey: string } =>
            validText(correlation.idempotencyKey ?? "") &&
            (correlation.uncertain || this.#isJournalRecoverable(correlation)),
        )
        .map((correlation) => {
          const material = correlation.recoveryMaterial;
          return Object.freeze({
            ownerId: correlation.ownerId,
            epoch: correlation.epoch,
            requestId: correlation.requestId,
            idempotencyKey: correlation.idempotencyKey,
            ...(material === undefined
              ? {}
              : {
                  logicalActionId: material.logicalActionId,
                  dispatchOrdinal: material.dispatchOrdinal,
                  actionId: material.request.action,
                  args: material.request.args,
                  expectedRevision: material.request.expectedRevision,
                  deadlineMs: material.request.deadlineMs,
                  ...(material.scope === undefined ? {} : { scope: material.scope }),
                  ...(material.bindingIdentity === undefined ? {} : { bindingIdentity: material.bindingIdentity }),
                }),
          });
        }),
    );
  }

  /** Rehydrate only nonterminal records from the direct Host recovery journal. */
  rehydrate(records: readonly StardewLogicalActionRecoveryRecord[]): void {
    for (const record of records) {
      if (record.state === "terminal_settled" || record.state === "recovery_required") continue;
      if (this.#byRequestId.has(record.requestId) || this.#tombstones.has(record.requestId))
        throw new Error("duplicate_execution_correlation");
      this.#byRequestId.set(record.requestId, {
        ownerId: record.ownerId,
        epoch: record.epoch,
        requestId: record.requestId,
        idempotencyKey: record.idempotencyKey,
        recoveryMaterial: {
          logicalActionId: record.logicalActionId,
          dispatchOrdinal: record.dispatchOrdinal,
          request: record.canonicalRequest,
          ...(record.scope === undefined ? {} : { scope: record.scope }),
          ...(record.bindingIdentity === undefined ? {} : { bindingIdentity: record.bindingIdentity }),
        },
        executionId: null,
        uncertain: true,
        cancelRequired: null,
        cancelSent: false,
        cancelPromise: null,
        cancelSettled: null,
        resolveCancelSettled: null,
        rejectCancelSettled: null,
      });
    }
  }

  #isJournalRecoverable(correlation: Correlation): boolean {
    const material = correlation.recoveryMaterial;
    if (this.#recoveryJournal === undefined || material === undefined) return false;
    const state = this.#recoveryJournal.record(material.logicalActionId)?.state;
    return state === "prepared" || state === "sent_unknown" || state === "recovery_pending";
  }

  /** Fence one uncertain lineage after recovery could not prove a receipt. */
  markRecoveryRequired(dispatch: RecoverableExecutionDispatch): Promise<void> {
    const correlation = this.#byRequestId.get(dispatch.requestId);
    if (
      correlation === undefined ||
      correlation.ownerId !== dispatch.ownerId ||
      correlation.epoch !== dispatch.epoch ||
      correlation.idempotencyKey !== dispatch.idempotencyKey
    ) {
      return Promise.reject(new Error("unknown_execution_correlation"));
    }
    const material = correlation.recoveryMaterial;
    if (this.#recoveryJournal === undefined || material === undefined) return Promise.resolve();
    return this.#recoveryJournal.markRecoveryRequired(material.logicalActionId).then(
      () => {
        correlation.uncertain = false;
      },
      (error) => {
        correlation.uncertain = true;
        throw error;
      },
    );
  }

  /** Runtime-only recovery facade resolves the exact already-registered owner. */
  requestCancelKnown(requestId: string, executionId: string, reasonCode: string): Promise<ExecutionReceipt> {
    const correlation = this.#byRequestId.get(requestId);
    if (correlation === undefined || correlation.executionId !== executionId)
      throw new Error("unknown_execution_correlation");
    const pending = this.#requestCancel(correlation, reasonCode);
    if (pending === null) throw new Error("unknown_execution_correlation");
    return pending;
  }

  /** The direct-agent cancel facade must present the exact tuple it previously dispatched. */
  requestCancelExact(
    owner: ExecutionCorrelationOwner,
    requestId: string,
    executionId: string,
    reasonCode: string,
  ): Promise<ExecutionReceipt> {
    const correlation = this.#require({ ...owner, requestId });
    if (correlation.executionId !== executionId) throw new Error("unknown_execution_correlation");
    const pending = this.#requestCancel(correlation, reasonCode);
    if (pending === null) throw new Error("unknown_execution_correlation");
    return pending;
  }

  #insert(dispatch: ExecutionDispatch): void {
    this.#byRequestId.set(dispatch.requestId, {
      ...dispatch,
      executionId: null,
      uncertain: false,
      cancelRequired: null,
      cancelSent: false,
      cancelPromise: null,
      cancelSettled: null,
      resolveCancelSettled: null,
      rejectCancelSettled: null,
    });
  }

  #require(dispatch: ExecutionDispatch): Correlation {
    assertDispatch(dispatch);
    const correlation = this.#byRequestId.get(dispatch.requestId);
    if (correlation === undefined || correlation.ownerId !== dispatch.ownerId || correlation.epoch !== dispatch.epoch)
      throw new Error("unknown_execution_correlation");
    return correlation;
  }

  #requestCancel(correlation: Correlation, reasonCode: string): Promise<ExecutionReceipt> | null {
    if (!validText(reasonCode)) throw new Error("invalid_execution_correlation_reason");
    correlation.cancelRequired ??= reasonCode;
    this.#ensureCancellationBarrier(correlation);
    return this.#sendPendingCancel(correlation);
  }

  #ensureCancellationBarrier(correlation: Correlation): Promise<void> {
    if (correlation.cancelSettled !== null) return correlation.cancelSettled;
    correlation.cancelSettled = new Promise<void>((resolve, reject) => {
      correlation.resolveCancelSettled = resolve;
      correlation.rejectCancelSettled = reject;
    });
    return correlation.cancelSettled;
  }

  #sendPendingCancel(correlation: Correlation): Promise<ExecutionReceipt> | null {
    if (correlation.cancelRequired === null || correlation.executionId === null) return null;
    if (correlation.cancelPromise !== null) return correlation.cancelPromise;
    correlation.cancelSent = true;
    correlation.cancelPromise = this.#sendCancel(
      correlation.requestId,
      correlation.executionId,
      correlation.cancelRequired,
    );
    void correlation.cancelPromise.then(
      () => correlation.resolveCancelSettled?.(),
      (error) => correlation.rejectCancelSettled?.(error),
    );
    return correlation.cancelPromise;
  }

  #retire(correlation: Correlation): void {
    this.#byRequestId.delete(correlation.requestId);
    this.#tombstones.set(correlation.requestId, true);
    while (this.#tombstones.size > this.#maxTombstones) this.#tombstones.delete(this.#tombstones.keys().next().value!);
  }
}

function assertDispatch(dispatch: ExecutionDispatch): void {
  assertOwner(dispatch);
  if (!validText(dispatch.requestId)) throw new Error("invalid_execution_correlation_dispatch");
  if (dispatch.idempotencyKey !== undefined && !validText(dispatch.idempotencyKey))
    throw new Error("invalid_execution_correlation_dispatch");
  if (dispatch.recoveryMaterial !== undefined) {
    if (
      !validText(dispatch.recoveryMaterial.logicalActionId) ||
      (dispatch.recoveryMaterial.dispatchOrdinal !== undefined &&
        (!Number.isSafeInteger(dispatch.recoveryMaterial.dispatchOrdinal) ||
          dispatch.recoveryMaterial.dispatchOrdinal < 1)) ||
      dispatch.recoveryMaterial.request.requestId !== dispatch.requestId ||
      dispatch.recoveryMaterial.request.idempotencyKey !== dispatch.idempotencyKey
    ) {
      throw new Error("invalid_execution_correlation_recovery_material");
    }
  }
}

function assertOwner(owner: ExecutionCorrelationOwner): void {
  if (!validText(owner.ownerId) || !Number.isSafeInteger(owner.epoch) || owner.epoch < 0)
    throw new Error("invalid_execution_correlation_dispatch");
}

function validText(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
