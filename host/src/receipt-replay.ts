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
    const previous = this.#latest.get(receipt.executionId);
    if (previous !== undefined) {
      if (previous.requestId !== receipt.requestId) return "execution_request_mismatch";
      if (receipt.revision <= previous.revision) return "non_monotonic_revision";
      if (TERMINAL_STATES.has(previous.state)) return "terminal_state_rewritten";
      if (!PROGRESS_STATES.has(previous.state)) return "invalid_previous_state";
    }
    if (receipt.state === "succeeded" && (receipt.evidence === null || Object.keys(receipt.evidence).length === 0))
      return "success_without_evidence";
    this.#latest.set(receipt.executionId, Object.freeze({ ...receipt }));
    return null;
  }

  public receipt(executionId: string): ExecutionReceipt | null {
    return this.#latest.get(executionId) ?? null;
  }
}
