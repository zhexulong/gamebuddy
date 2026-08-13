import type { ExecutionReceipt } from "./protocol.js";

export type ExecutionCorrelationOwner = Readonly<{
  ownerId: string;
  epoch: number;
}>;

export type ExecutionDispatch = ExecutionCorrelationOwner &
  Readonly<{
    requestId: string;
  }>;

export type ExecutionCancelSender = (
  requestId: string,
  executionId: string,
  reasonCode: string,
) => Promise<ExecutionReceipt>;

export interface ExecutionDispatchObserver {
  beforeWrite(dispatch: ExecutionDispatch): void;
  bindReceipt(receipt: ExecutionReceipt): void;
  markUncertain(dispatch: ExecutionDispatch): void;
}

type Correlation = ExecutionDispatch & {
  executionId: string | null;
  uncertain: boolean;
  cancelRequired: string | null;
  cancelSent: boolean;
  cancelPromise: Promise<ExecutionReceipt> | null;
};

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

  constructor(sendCancel: ExecutionCancelSender, options: Readonly<{ maxTombstones?: number }> = {}) {
    this.#sendCancel = sendCancel;
    this.#maxTombstones = options.maxTombstones ?? 256;
    if (!Number.isSafeInteger(this.#maxTombstones) || this.#maxTombstones < 1)
      throw new Error("invalid_execution_correlation_tombstone_limit");
  }

  beforeWrite(dispatch: ExecutionDispatch): void {
    assertDispatch(dispatch);
    if (this.#byRequestId.has(dispatch.requestId) || this.#tombstones.has(dispatch.requestId))
      throw new Error("duplicate_execution_correlation");
    this.#byRequestId.set(dispatch.requestId, {
      ...dispatch,
      executionId: null,
      uncertain: false,
      cancelRequired: null,
      cancelSent: false,
      cancelPromise: null,
    });
  }

  bindReceipt(receipt: ExecutionReceipt): void {
    const correlation = this.#byRequestId.get(receipt.requestId);
    if (correlation === undefined) return;
    if (correlation.executionId !== null && correlation.executionId !== receipt.executionId)
      throw new Error("execution_correlation_receipt_mismatch");
    correlation.executionId = receipt.executionId;
    correlation.uncertain = false;
    if (isTerminalReceipt(receipt)) {
      this.#retire(correlation);
      return;
    }
    this.#sendPendingCancel(correlation);
  }

  markUncertain(dispatch: ExecutionDispatch): void {
    const correlation = this.#require(dispatch);
    if (correlation.executionId === null) correlation.uncertain = true;
  }

  /** Mark one owner's registrations before any asynchronous work. */
  requestCancelOwner(owner: ExecutionCorrelationOwner, reasonCode: string): readonly Promise<ExecutionReceipt>[] {
    assertOwner(owner);
    return [...this.#byRequestId.values()]
      .filter((correlation) => correlation.ownerId === owner.ownerId && correlation.epoch === owner.epoch)
      .map((correlation) => this.#requestCancel(correlation, reasonCode))
      .filter((promise): promise is Promise<ExecutionReceipt> => promise !== null);
  }

  /** Runtime stop is the sole epoch-wide cancellation authority. */
  requestCancelEpoch(epoch: number, reasonCode: string): readonly Promise<ExecutionReceipt>[] {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("invalid_execution_correlation_epoch");
    return [...this.#byRequestId.values()]
      .filter((correlation) => correlation.epoch === epoch)
      .map((correlation) => this.#requestCancel(correlation, reasonCode))
      .filter((promise): promise is Promise<ExecutionReceipt> => promise !== null);
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

  #require(dispatch: ExecutionDispatch): Correlation {
    assertDispatch(dispatch);
    const correlation = this.#byRequestId.get(dispatch.requestId);
    if (
      correlation === undefined ||
      correlation.ownerId !== dispatch.ownerId ||
      correlation.epoch !== dispatch.epoch
    )
      throw new Error("unknown_execution_correlation");
    return correlation;
  }

  #requestCancel(correlation: Correlation, reasonCode: string): Promise<ExecutionReceipt> | null {
    if (!validText(reasonCode)) throw new Error("invalid_execution_correlation_reason");
    if (correlation.executionId === null) {
      correlation.cancelRequired ??= reasonCode;
      return null;
    }
    correlation.cancelRequired ??= reasonCode;
    return this.#sendPendingCancel(correlation);
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
}

function assertOwner(owner: ExecutionCorrelationOwner): void {
  if (!validText(owner.ownerId) || !Number.isSafeInteger(owner.epoch) || owner.epoch < 0)
    throw new Error("invalid_execution_correlation_dispatch");
}

function validText(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isTerminalReceipt(receipt: ExecutionReceipt): boolean {
  return (
    receipt.state === "blocked" ||
    receipt.state === "invalidated" ||
    receipt.state === "succeeded" ||
    receipt.state === "partially_succeeded" ||
    receipt.state === "failed" ||
    receipt.state === "cancelled" ||
    receipt.state === "expired" ||
    receipt.state === "rejected" ||
    receipt.state === "uncertain"
  );
}
