import type { ActionExecutionCoordinator } from "./action-execution-coordinator.internal.js";
import type { ExecutionReceipt, ExecutionReceiptQuery } from "./protocol.js";

/**
 * Instance-bound port exposed only by a freshly authenticated Stardew bridge
 * client. It is intentionally read-only: recovery cannot reissue an action,
 * construct a request, or mint a cancel identity.
 */
export type ExactReceiptRecoveryPort = Readonly<{
  queryExecutionReceipt(query: ExecutionReceiptQuery): Promise<ExecutionReceipt>;
}>;

export type ReceiptRecoveryOutcome =
  | Readonly<{ requestId: string; result: "admitted"; state: ExecutionReceipt["state"] }>
  | Readonly<{ requestId: string; result: "not_found" }>
  | Readonly<{ requestId: string; result: "rejected"; reasonCode: string }>;

/** Narrow capability guard for the composition boundary; it never widens GameConnection. */
export function isExactReceiptRecoveryPort(value: unknown): value is ExactReceiptRecoveryPort {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Readonly<{ queryExecutionReceipt?: unknown }>).queryExecutionReceipt === "function"
  );
}

/**
 * Replays each bounded uncertain tuple once after a product composition has
 * established a completely new, authenticated bridge binding. The coordinator
 * remains the only receipt-admission owner; this supervisor owns neither a
 * connection lifecycle nor action execution and intentionally performs no
 * retry loop. A later real binding transition may call it again.
 */
export class StardewExecutionRecoverySupervisor {
  constructor(private readonly coordinator: ActionExecutionCoordinator) {}

  public async recoverFromFreshBinding(port: ExactReceiptRecoveryPort): Promise<readonly ReceiptRecoveryOutcome[]> {
    const outcomes: ReceiptRecoveryOutcome[] = [];
    for (const dispatch of this.coordinator.uncertainDispatches()) {
      try {
        const receipt = await port.queryExecutionReceipt({
          requestId: dispatch.requestId,
          idempotencyKey: dispatch.idempotencyKey,
        });
        if (receipt.requestId !== dispatch.requestId) {
          outcomes.push(
            Object.freeze({
              requestId: dispatch.requestId,
              result: "rejected",
              reasonCode: "receipt_request_mismatch",
            }),
          );
          continue;
        }
        this.coordinator.receiveReceipt(receipt);
        outcomes.push(Object.freeze({ requestId: dispatch.requestId, result: "admitted", state: receipt.state }));
      } catch (error) {
        const reasonCode = bridgeReasonCode(error);
        outcomes.push(
          reasonCode === "receipt_not_found"
            ? Object.freeze({ requestId: dispatch.requestId, result: "not_found" })
            : Object.freeze({ requestId: dispatch.requestId, result: "rejected", reasonCode }),
        );
      }
    }
    return Object.freeze(outcomes);
  }
}

function bridgeReasonCode(error: unknown): string {
  if (!(error instanceof Error)) return "recovery_query_failed";
  const prefix = "bridge_rejected:";
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : "recovery_query_failed";
}
