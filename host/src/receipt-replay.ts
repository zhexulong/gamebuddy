import { isDeepStrictEqual } from "node:util";

import type { ExecutionReceipt, ExecutionState } from "./protocol.js";

const TERMINAL_STATES = new Set<ExecutionState>([
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "expired",
  "invalidated",
  "rejected",
  "uncertain",
]);
const PROGRESS_STATES = new Set<ExecutionState>(["accepted", "running", "meaningful_progress", "blocked"]);

/**
 * Deterministic Host-side audit of authoritative receipt order. This is not an
 * execution controller: it accepts only Mod receipts and rejects impossible
 * rewrites, terminal regressions, or a success without postcondition evidence.
 */
export class ReceiptReplayLedger {
  readonly #latest = new Map<string, ExecutionReceipt>();

  public apply(receipt: ExecutionReceipt): string | null {
    if (!PROGRESS_STATES.has(receipt.state) && !TERMINAL_STATES.has(receipt.state)) return "invalid_previous_state";
    const previous = this.#latest.get(receipt.executionId);
    if (previous !== undefined) {
      if (isDeepStrictEqual(previous, receipt)) return null;
      if (previous.requestId !== receipt.requestId) return "execution_request_mismatch";
      if (receipt.revision <= previous.revision) return "non_monotonic_revision";
      if (TERMINAL_STATES.has(previous.state)) return "terminal_state_rewritten";
      if (!PROGRESS_STATES.has(previous.state)) return "invalid_previous_state";
    }
    if (receipt.state === "succeeded" && (receipt.evidence === null || Object.keys(receipt.evidence).length === 0))
      return "success_without_evidence";
    this.#latest.set(receipt.executionId, freezeDeep(structuredClone(receipt)));
    return null;
  }

  public receipt(executionId: string): ExecutionReceipt | null {
    return this.#latest.get(executionId) ?? null;
  }
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) freezeDeep(nested, seen);
  return Object.freeze(value);
}
