// Shared runner-only mechanics for a formal Stardew production action gate.
// This deliberately does not choose targets, issue navigation, interpret action
// evidence, or decide whether a game postcondition is sufficient. Those remain
// action-specific. It owns only authenticated bridge lifetime, correlation to
// one execution, terminal receipt waiting, and the required fresh reread.

export const TERMINAL_EXECUTION_STATES = new Set([
  "blocked",
  "invalidated",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "expired",
  "rejected",
  "uncertain",
]);

export class FormalActionGateError extends Error {
  constructor(reasonCode, details = undefined) {
    super(reasonCode);
    this.name = "FormalActionGateError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export function isTerminalExecutionState(state) {
  return typeof state === "string" && TERMINAL_EXECUTION_STATES.has(state);
}

/**
 * Keeps one already-authenticated LocalStardewBridgeClient alive through a
 * single production action. Call close() before closing the client.
 */
export function createFormalActionGate(client, { pollMs = 200 } = {}) {
  if (!client || typeof client.observe !== "function" || typeof client.execute !== "function"
    || typeof client.onFact !== "function" || typeof client.onConnectionFact !== "function") {
    throw new TypeError("formal_action_gate_invalid_client");
  }
  if (!Number.isInteger(pollMs) || pollMs < 25 || pollMs > 2_000) {
    throw new TypeError("formal_action_gate_invalid_poll_interval");
  }

  const receipts = [];
  let disconnectedReason = null;
  const unsubscribeFact = client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const unsubscribeConnection = client.onConnectionFact((fact) => {
    if (fact.state === "disconnected") disconnectedReason = fact.reasonCode;
  });
  let closed = false;

  function requireOpen() {
    if (closed) throw new FormalActionGateError("formal_action_gate_closed");
    if (disconnectedReason !== null || client.state.connected !== true) {
      throw new FormalActionGateError("bridge_disconnected", { reasonCode: disconnectedReason ?? client.state.latestReasonCode ?? "unknown" });
    }
  }

  function findReceipt(executionId, initialReceipt = null) {
    const latest = client.state.latestReceipt;
    if (latest?.executionId === executionId) return latest;
    const received = receipts.find((receipt) => receipt?.executionId === executionId);
    if (received !== undefined) return received;
    return initialReceipt?.executionId === executionId ? initialReceipt : null;
  }

  async function observe() {
    requireOpen();
    try {
      return await client.observe();
    } catch (error) {
      if (disconnectedReason !== null || client.state.connected !== true) {
        throw new FormalActionGateError("bridge_disconnected", { reasonCode: disconnectedReason ?? client.state.latestReasonCode ?? "unknown" });
      }
      throw new FormalActionGateError("bridge_observe_failed", { message: boundedErrorMessage(error) });
    }
  }

  async function waitForActionable({ initialSnapshot = null, timeoutMs = 10_000 } = {}) {
    validateTimeout(timeoutMs, "formal_action_gate_invalid_actionable_timeout");
    const deadline = Date.now() + timeoutMs;
    let snapshot = initialSnapshot ?? await observe();
    while (Date.now() < deadline) {
      if (snapshot.actionable === true && snapshot.activeExecution == null) return snapshot;
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      snapshot = await observe();
    }
    return snapshot;
  }

  async function waitForTerminalReceipt(executionId, { initialReceipt = null, timeoutMs = 40_000 } = {}) {
    if (typeof executionId !== "string" || executionId.length === 0) {
      throw new FormalActionGateError("formal_action_gate_invalid_execution_id");
    }
    validateTimeout(timeoutMs, "formal_action_gate_invalid_terminal_timeout");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      requireOpen();
      const receipt = findReceipt(executionId, initialReceipt);
      if (receipt !== null && isTerminalExecutionState(receipt.state)) return receipt;
      // observe keeps an authenticated pipe alive and ensures the final result
      // is never inferred only from a stale event cache.
      await observe();
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    const finalReceipt = findReceipt(executionId, initialReceipt);
    if (finalReceipt !== null && isTerminalExecutionState(finalReceipt.state)) return finalReceipt;
    throw new FormalActionGateError("execution_terminal_timeout", { executionId });
  }

  async function executeAndAwaitTerminal(request, { terminalTimeoutMs = 40_000, settleTimeoutMs = 5_000 } = {}) {
    requireOpen();
    let initialReceipt;
    try {
      initialReceipt = await client.execute(request);
    } catch (error) {
      if (disconnectedReason !== null || client.state.connected !== true) {
        throw new FormalActionGateError("bridge_disconnected", { reasonCode: disconnectedReason ?? client.state.latestReasonCode ?? "unknown" });
      }
      throw new FormalActionGateError("execution_submit_failed", { message: boundedErrorMessage(error) });
    }
    if (initialReceipt === null || typeof initialReceipt !== "object" || typeof initialReceipt.executionId !== "string") {
      throw new FormalActionGateError("execution_response_invalid");
    }
    const terminalReceipt = await waitForTerminalReceipt(initialReceipt.executionId, { initialReceipt, timeoutMs: terminalTimeoutMs });
    // A terminal receipt is necessary but not sufficient: every gate must make
    // a fresh authoritative reread after it. If the world is still briefly
    // settling, wait boundedly for the active execution to clear.
    const after = await waitForActionable({ timeoutMs: settleTimeoutMs });
    return Object.freeze({ acceptedReceipt: initialReceipt, terminalReceipt, afterSnapshot: after });
  }

  function close() {
    if (closed) return;
    closed = true;
    unsubscribeFact();
    unsubscribeConnection();
  }

  return Object.freeze({ observe, waitForActionable, waitForTerminalReceipt, executeAndAwaitTerminal, close });
}

function validateTimeout(timeoutMs, reasonCode) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new FormalActionGateError(reasonCode);
  }
}

function boundedErrorMessage(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 256);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
