import type { ActionExecutionCoordinator } from "./action-execution-coordinator.internal.js";
import type { StableGameRuntimeBindingIdentity } from "./continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import type { ExecutionReceipt, ExecutionReceiptQuery } from "./protocol.js";

/**
 * Instance-bound port exposed only by a freshly authenticated Stardew bridge
 * client. It is intentionally read-only: recovery cannot reissue an action,
 * construct a request, or mint a cancel identity.
 */
export type ExactReceiptRecoveryPort = Readonly<{
  /** Stable bridge scope attested by the fresh authenticated binding. */
  scope: StableGameRuntimeBindingIdentity;
  /** Stable binding identity (never a runtime owner or generation). */
  bindingIdentity: StableGameRuntimeBindingIdentity;
  queryExecutionReceipt(query: ExecutionReceiptQuery): Promise<ExecutionReceipt>;
}>;

export type ReceiptRecoveryOutcome =
  | Readonly<{ requestId: string; result: "admitted"; state: ExecutionReceipt["state"] }>
  | Readonly<{ requestId: string; result: "recovery_required"; reasonCode: string }>;

/** Narrow capability guard for the composition boundary; it never widens GameConnection. */
export function isExactReceiptRecoveryPort(value: unknown): value is ExactReceiptRecoveryPort {
  return (
    typeof value === "object" &&
    value !== null &&
      Object.isFrozen(value) &&
      isExactStableStardewIdentity((value as Readonly<{ scope?: unknown }>).scope) &&
      isExactStableStardewIdentity((value as Readonly<{ bindingIdentity?: unknown }>).bindingIdentity) &&
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
        if (!sameStableStardewIdentity(dispatch.scope, port.scope))
          throw new Error("bridge_rejected:receipt_scope_mismatch");
        if (!sameStableStardewIdentity(dispatch.bindingIdentity, port.bindingIdentity))
          throw new Error("bridge_rejected:receipt_binding_mismatch");
        const receipt = await port.queryExecutionReceipt({
          requestId: dispatch.requestId,
          idempotencyKey: dispatch.idempotencyKey,
        });
        if (
          !isRecord(receipt) ||
          receipt.requestId !== dispatch.requestId ||
          receipt.actionId !== dispatch.actionId
        ) {
          const reasonCode =
            !isRecord(receipt) || receipt.requestId !== dispatch.requestId
              ? "receipt_request_mismatch"
              : "receipt_action_mismatch";
          await this.coordinator.markRecoveryRequired(dispatch);
          outcomes.push(Object.freeze({ requestId: dispatch.requestId, result: "recovery_required", reasonCode }));
          continue;
        }
        await this.coordinator.receiveReceipt(receipt);
        outcomes.push(Object.freeze({ requestId: dispatch.requestId, result: "admitted", state: receipt.state }));
      } catch (error) {
        const reasonCode = bridgeReasonCode(error);
        await this.coordinator.markRecoveryRequired(dispatch);
        outcomes.push(Object.freeze({
          requestId: dispatch.requestId,
          result: "recovery_required",
          reasonCode,
        }));
      }
    }
    return Object.freeze(outcomes);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STABLE_IDENTITY_KEYS = Object.freeze([
  "product",
  "continuityId",
  "integrationId",
  "saveId",
  "worldId",
] as const);

function isExactStableStardewIdentity(value: unknown): value is StableGameRuntimeBindingIdentity {
  return isRecord(value) && Object.isFrozen(value) && sameStableStardewIdentity(value, value);
}

function sameStableStardewIdentity(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  const expectedKeys = [...STABLE_IDENTITY_KEYS].sort();
  if (
    leftKeys.length !== expectedKeys.length ||
    rightKeys.length !== expectedKeys.length ||
    !leftKeys.every((key, index) => key === expectedKeys[index]) ||
    !rightKeys.every((key, index) => key === expectedKeys[index])
  ) return false;
  return (
    left.product === "stardew" &&
    right.product === "stardew" &&
    left.integrationId === "stardew" &&
    right.integrationId === "stardew" &&
    typeof left.continuityId === "string" &&
    left.continuityId === right.continuityId &&
    typeof left.saveId === "string" &&
    left.saveId === right.saveId &&
    typeof left.worldId === "string" &&
    left.worldId === right.worldId
  );
}

function bridgeReasonCode(error: unknown): string {
  if (!(error instanceof Error)) return "recovery_query_failed";
  const prefix = "bridge_rejected:";
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : "recovery_query_failed";
}
