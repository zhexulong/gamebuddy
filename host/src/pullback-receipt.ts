// host/src/pullback-receipt.ts
import type { ExecutionReceipt } from "./protocol.js";

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(recordB, key)) return false;
    if (!deepEqual(recordA[key], recordB[key])) return false;
  }
  return true;
}

export interface PullbackSpec {
  readonly targetProperty: string;
  readonly targetLocation: {
    readonly location: string;
    readonly tile: { readonly x: number; readonly y: number };
  };
  readonly expectedValue: unknown;
}

export interface StepReceipt {
  readonly stepIndex: number;
  readonly actionType: string;
  readonly state: "succeeded" | "failed" | "cancelled";
  readonly reasonCode: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PullbackEvidence extends PullbackSpec {
  readonly actualValue: unknown;
  readonly equalizerMatched?: boolean;
  readonly stepReceipts?: readonly StepReceipt[];
  readonly failedStepIndex?: number | null;
}

export function createCompositeExecutionReceipt(params: {
  executionId: string;
  requestId: string;
  action: string;
  spec: PullbackSpec;
  actualValue: unknown;
  revision: number;
  steps: readonly StepReceipt[];
  failedStepIndex?: number | null;
}): ExecutionReceipt {
  const failedStep = typeof params.failedStepIndex === "number" ? params.steps[params.failedStepIndex] : null;
  const equalizerMatched = !failedStep && deepEqual(params.spec.expectedValue, params.actualValue);

  const reasonCode = failedStep
    ? (failedStep.reasonCode.startsWith("step_failed:") ? failedStep.reasonCode : `step_failed:${failedStep.actionType}:${failedStep.reasonCode}`)
    : equalizerMatched
      ? "equalizer_matched"
      : "equalizer_mismatch";

  return Object.freeze({
    executionId: params.executionId,
    requestId: params.requestId,
    state: equalizerMatched ? "succeeded" : "failed",
    reasonCode,
    revision: params.revision,
    evidence: Object.freeze({
      action: params.action,
      targetProperty: params.spec.targetProperty,
      targetLocation: params.spec.targetLocation,
      expectedValue: params.spec.expectedValue,
      actualValue: params.actualValue,
      equalizerMatched,
      stepReceipts: params.steps,
      failedStepIndex: params.failedStepIndex ?? null,
    } as Record<string, unknown>),
  });
}

export function verifyPullbackEqualizer(receipt: ExecutionReceipt): boolean {
  if (!receipt.evidence || typeof receipt.evidence !== "object") return false;
  const evidence = receipt.evidence as Record<string, unknown>;
  return (
    evidence.equalizerMatched === true &&
    deepEqual(evidence.expectedValue, evidence.actualValue)
  );
}
