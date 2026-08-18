import assert from "node:assert/strict";
import test from "node:test";
import {
  createFormalActionGate,
  FormalActionGateError,
  isTerminalExecutionState,
} from "./lib/stardew-formal-action-gate.mjs";

const scopeSnapshot = (overrides = {}) => ({ revision: 1, actionable: true, activeExecution: null, ...overrides });
const accepted = {
  executionId: "execution_1",
  requestId: "request_1",
  state: "accepted",
  reasonCode: "accepted",
  revision: 1,
  evidence: null,
};
const succeeded = { ...accepted, state: "succeeded", reasonCode: "item_used", revision: 2 };

for (const state of [
  "blocked",
  "invalidated",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "expired",
  "rejected",
  "uncertain",
]) {
  test(`terminal state ${state} is recognized`, () => assert.equal(isTerminalExecutionState(state), true));
}
test("nonterminal states are not terminal", () => {
  for (const state of ["accepted", "running", "meaningful_progress", "unknown"])
    assert.equal(isTerminalExecutionState(state), false);
});

test("waits for same-execution terminal event and then fresh rereads", async () => {
  const client = fakeClient({
    execute: async () => {
      queueMicrotask(() => client.emitReceipt(succeeded));
      return accepted;
    },
    snapshots: [
      scopeSnapshot({ revision: 1, activeExecution: { executionId: "execution_1" } }),
      scopeSnapshot({ revision: 2 }),
    ],
  });
  const gate = createFormalActionGate(client, { pollMs: 25 });
  try {
    const result = await gate.executeAndAwaitTerminal(
      { action: "use_item" },
      { terminalTimeoutMs: 1_000, settleTimeoutMs: 1_000 },
    );
    assert.equal(result.acceptedReceipt.state, "accepted");
    assert.equal(result.terminalReceipt.state, "succeeded");
    assert.equal(result.afterSnapshot.revision, 2);
    assert.ok(client.observeCount >= 2);
  } finally {
    gate.close();
  }
});

test("does not mistake accepted initial response for a terminal receipt", async () => {
  const client = fakeClient({ execute: async () => accepted, snapshots: [scopeSnapshot()] });
  const gate = createFormalActionGate(client, { pollMs: 25 });
  try {
    await assert.rejects(
      () => gate.executeAndAwaitTerminal({ action: "use_item" }, { terminalTimeoutMs: 80, settleTimeoutMs: 100 }),
      (error) => error instanceof FormalActionGateError && error.reasonCode === "execution_terminal_timeout",
    );
  } finally {
    gate.close();
  }
});

test("fails closed when bridge disconnects while waiting", async () => {
  const client = fakeClient({
    execute: async () => {
      queueMicrotask(() => client.emitDisconnect("pipe_closed"));
      return accepted;
    },
    snapshots: [scopeSnapshot()],
  });
  const gate = createFormalActionGate(client, { pollMs: 25 });
  try {
    await assert.rejects(
      () => gate.executeAndAwaitTerminal({ action: "use_item" }, { terminalTimeoutMs: 1_000, settleTimeoutMs: 100 }),
      (error) =>
        error instanceof FormalActionGateError &&
        error.reasonCode === "bridge_disconnected" &&
        error.details.reasonCode === "pipe_closed",
    );
  } finally {
    gate.close();
  }
});

function fakeClient({ execute, snapshots }) {
  const facts = new Set();
  const connections = new Set();
  let index = 0;
  const client = {
    state: { connected: true, latestReceipt: null, latestReasonCode: null },
    observeCount: 0,
    onFact(listener) {
      facts.add(listener);
      return () => facts.delete(listener);
    },
    onConnectionFact(listener) {
      connections.add(listener);
      return () => connections.delete(listener);
    },
    async observe() {
      client.observeCount++;
      return snapshots[Math.min(index++, snapshots.length - 1)];
    },
    execute,
    emitReceipt(receipt) {
      client.state.latestReceipt = receipt;
      for (const listener of facts) listener({ type: "execution_receipt", payload: receipt });
    },
    emitDisconnect(reasonCode) {
      client.state.connected = false;
      client.state.latestReasonCode = reasonCode;
      for (const listener of connections) listener({ state: "disconnected", reasonCode });
    },
  };
  return client;
}
