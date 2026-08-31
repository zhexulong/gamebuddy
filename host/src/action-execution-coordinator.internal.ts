import { randomUUID } from "node:crypto";
import { type CompanionInterruption, createCompanionInterruption } from "./companion-interruption.js";
import {
  ExecutionCorrelationLedger,
  type ExecutionDispatch,
  type RecoverableExecutionDispatch,
} from "./execution-correlation-ledger.js";
import type { ExecutionWake, ExecutionWakeSource } from "./integration-launcher.js";
import type { IntegrationDispatchAdmission } from "./game-integration-adapter.js";
import type { GameConnection } from "./game-connection.js";
import type { ExecutionReceipt } from "./protocol.js";
import { ReceiptReplayLedger } from "./receipt-replay.js";

/**
 * Private, single-internal-owner action execution coordinator. It merges the
 * orthogonal concerns that previously lived split across the runtime dispatch
 * controller, the correlation ledger, the orphaned receipt-order audit, and
 * launcher wake normalization:
 *
 * - admission minting (owner + observer + exact/pending cancel),
 * - request -> execution correlation through `ExecutionCorrelationLedger`,
 * - deterministic receipt-order audit through `ReceiptReplayLedger` as the
 *   single receipt-admission path before the correlation ledger,
 * - epoch close + exact-once epoch cancellation for Host STOP,
 * - one shared fail-closed wake normalization for every action route.
 *
 * It is deliberately action-agnostic: it never receives `{action, payload}`,
 * never switches on `action`, and never validates or interprets a postcondition.
 * Per-action argument validation stays in protocol.ts and per-action
 * completion evidence stays in the module action catalog.
 */

export type ActionExecutionAdmission = IntegrationDispatchAdmission &
  Readonly<{
    cancelPending(reasonCode: string): void;
  }>;

export type ActionExecutionCoordinator = Readonly<{
  interruption: CompanionInterruption;
  createAdmission(): ActionExecutionAdmission;
  /**
   * Single receipt-admission path. The replay audit rejects impossible order
   * (terminal rewrite, non-monotonic revision, success without evidence) and
   * the correlation ledger binds the receipt to its pre-write registration.
   */
  receiveReceipt(receipt: ExecutionReceipt): void;
  /** Shared fail-closed wake normalization for task waiters and launcher wake routes. */
  receiveWake(wake: unknown): ExecutionWake | null;
  /** Exact original tuples retained only after a possibly-written dispatch loses its receipt. */
  uncertainDispatches(): readonly RecoverableExecutionDispatch[];
  cancelEpoch(epoch: number, reasonCode: string): Promise<void>;
  interrupt(reasonCode: string): Promise<void>;
}>;

/**
 * Compose every action surface with a runtime-local interruption epoch, one
 * correlation ledger, and one receipt-order audit. The module's adapter cancel
 * method is reachable only as the ledger's exact sender; neither Agent surface
 * receives it directly.
 */
export function createActionExecutionCoordinator(connection: GameConnection): ActionExecutionCoordinator {
  const interruption = createCompanionInterruption();
  const ledger = new ExecutionCorrelationLedger(
    async (requestId, executionId, reasonCode) =>
      (await Promise.resolve(
        connection.module.cancelExecution(connection, requestId, executionId, reasonCode),
      )) as never,
  );
  const replay = new ReceiptReplayLedger();

  const receiveReceipt = (receipt: ExecutionReceipt): void => {
    // The bridge resolves an execution_request with the same receipt that its
    // fact route already delivered synchronously. That byte-identical
    // transition is an idempotent re-delivery, not an order violation; the
    // correlation ledger recomposition is a safe no-op (it is already bound or
    // already retired). Any different receipt for a known execution must
    // satisfy the deterministic order audit or admission fails closed.
    const previous = replay.receipt(receipt.executionId);
    if (previous !== null && identicalReceipt(previous, receipt)) {
      ledger.bindReceipt(receipt);
      return;
    }
    const fault = replay.apply(receipt);
    if (fault !== null) throw new Error(`execution_receipt_replay_rejected:${fault}`);
    ledger.bindReceipt(receipt);
  };

  const createAdmission = (): ActionExecutionAdmission => {
    const snapshot = interruption.capture();
    const owner = Object.freeze({
      ownerId: `runtime_${randomUUID()}`,
      epoch: snapshot.epoch,
    });
    return Object.freeze({
      owner,
      observer: Object.freeze({
        beforeWrite: (dispatch: ExecutionDispatch) => {
          interruption.assertCurrent(snapshot);
          // Always defer the post-admission STOP fence through a promise. Even
          // a synchronous ledger admission is awaited by the tool wrapper, so a
          // STOP queued in the same turn must close the epoch before native
          // execution can resume from that await continuation.
          return Promise.resolve(ledger.beforeWrite(dispatch)).then(() => interruption.assertCurrent(snapshot));
        },
        bindReceipt: (receipt: ExecutionReceipt) => receiveReceipt(receipt),
        markUncertain: (dispatch: ExecutionDispatch) => ledger.markUncertain(dispatch),
      }),
      cancelExact: (requestId, executionId, reasonCode) =>
        ledger.requestCancelExact(owner, requestId, executionId, reasonCode),
      cancelPending: (reasonCode) => {
        void ledger.requestCancelOwner(owner, reasonCode);
      },
    });
  };

  return Object.freeze({
    interruption,
    createAdmission,
    receiveReceipt,
    receiveWake: (wake: unknown): ExecutionWake | null => normalizeExecutionWake(wake),
    uncertainDispatches: () => ledger.uncertainDispatches(),
    cancelEpoch: async (epoch: number, reasonCode: string) => {
      await Promise.all(ledger.requestCancelEpoch(epoch, reasonCode));
    },
    interrupt: async (reasonCode: string) => {
      const snapshot = interruption.capture();
      interruption.close(reasonCode);
      await Promise.all(ledger.requestCancelEpoch(snapshot.epoch, reasonCode));
    },
  });
}

/**
 * Two executions of the same bridge transition are identical only when every
 * observable receipt field matches. Evidence is compared canonically so key
 * order cannot turn one adapter message into a fake order violation.
 */
function identicalReceipt(left: ExecutionReceipt, right: ExecutionReceipt): boolean {
  return (
    left.executionId === right.executionId &&
    left.requestId === right.requestId &&
    left.state === right.state &&
    left.reasonCode === right.reasonCode &&
    left.revision === right.revision &&
    canonicalStableJson(left.evidence) === canonicalStableJson(right.evidence)
  );
}

function canonicalStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Adapter-owned optional capability lookup; absent adapters keep polling. */
export function executionWakeSourceFor(connection: unknown): ExecutionWakeSource | undefined {
  if (!isRecord(connection) || !isRecord(connection.executionWakeSource)) return undefined;
  const source = connection.executionWakeSource;
  return typeof source.onExecutionWake === "function" ? (source as ExecutionWakeSource) : undefined;
}

/** Reject malformed adapter values before they can wake a task-owned waiter. */
export function normalizeExecutionWake(value: unknown): ExecutionWake | null {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.reasonCode !== "string" ||
    value.reasonCode.length === 0
  )
    return null;
  if (value.kind === "invalidated" || value.kind === "disconnected")
    return Object.freeze({ kind: value.kind, reasonCode: value.reasonCode });
  if (
    value.kind !== "terminal" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    typeof value.executionId !== "string" ||
    value.executionId.length === 0 ||
    typeof value.state !== "string" ||
    value.state.length === 0
  )
    return null;
  return Object.freeze({
    kind: "terminal",
    requestId: value.requestId,
    executionId: value.executionId,
    state: value.state,
    reasonCode: value.reasonCode,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
