import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import type { ExecutionState } from "./protocol.js";

const receipt = (state: ExecutionState = "accepted") => ({
  requestId: "request_1",
  executionId: "execution_1",
  state,
  reasonCode: state,
  revision: 1,
  evidence: null,
});

test("late accepted receipt after epoch cancellation sends one exact cancel", async () => {
  const sent: string[][] = [];
  const ledger = new ExecutionCorrelationLedger(async (...args) => {
    sent.push(args);
    return receipt("cancelled");
  });
  ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
  assert.deepEqual(ledger.requestCancelEpoch(4, "stop_all"), []);
  ledger.markUncertain({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
  ledger.bindReceipt(receipt());
  ledger.bindReceipt(receipt());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [["request_1", "execution_1", "stop_all"]]);
});

test("terminal receipt after dispatch cancellation retires before it can send a cancel", () => {
  for (const state of ["succeeded", "failed", "cancelled", "invalidated"] as const) {
    const sent: string[][] = [];
    const ledger = new ExecutionCorrelationLedger(async (...args) => {
      sent.push(args);
      return receipt("cancelled");
    });
    ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
    assert.deepEqual(ledger.requestCancelEpoch(4, "stop_all"), []);

    ledger.bindReceipt(receipt(state));
    ledger.bindReceipt(receipt(state));

    assert.deepEqual(sent, [], `${state} receipt must not send a cancel`);
  }
});

test("nonterminal receipt after dispatch cancellation sends one exact cancel", () => {
  for (const state of ["accepted", "running"] as const) {
    const sent: string[][] = [];
    const ledger = new ExecutionCorrelationLedger(async (...args) => {
      sent.push(args);
      return receipt("cancelled");
    });
    ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
    assert.deepEqual(ledger.requestCancelEpoch(4, "stop_all"), []);

    ledger.bindReceipt(receipt(state));
    ledger.bindReceipt(receipt("succeeded"));

    assert.deepEqual(sent, [["request_1", "execution_1", "stop_all"]], `${state} receipt must send one cancel`);
  }
});

test("owner-scoped pending cancellation cannot cancel another owner in the same epoch", async () => {
  const sent: string[][] = [];
  const ledger = new ExecutionCorrelationLedger(async (...args) => {
    sent.push(args);
    return { ...receipt("cancelled"), requestId: args[0], executionId: args[1] };
  });
  const ownerOne = { ownerId: "owner_1", epoch: 4 };
  const ownerTwo = { ownerId: "owner_2", epoch: 4 };
  ledger.beforeWrite({ ...ownerOne, requestId: "request_1" });
  ledger.beforeWrite({ ...ownerTwo, requestId: "request_2" });
  assert.deepEqual(ledger.requestCancelOwner(ownerOne, "owner_one_stopped"), []);
  ledger.bindReceipt(receipt());
  ledger.bindReceipt({ ...receipt(), requestId: "request_2", executionId: "execution_2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [["request_1", "execution_1", "owner_one_stopped"]]);
});

test("exact cancel rejects unknown or mismatched owner/epoch tuple", () => {
  const ledger = new ExecutionCorrelationLedger(async () => receipt("cancelled"));
  ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
  ledger.bindReceipt(receipt());
  assert.throws(() => ledger.requestCancelExact({ ownerId: "other", epoch: 4 }, "request_1", "execution_1", "stop"), /unknown_execution_correlation/);
  assert.throws(() => ledger.requestCancelExact({ ownerId: "owner_1", epoch: 5 }, "request_1", "execution_1", "stop"), /unknown_execution_correlation/);
  assert.throws(() => ledger.requestCancelExact({ ownerId: "owner_1", epoch: 4 }, "request_1", "other", "stop"), /unknown_execution_correlation/);
});

test("terminal bindings retain bounded tombstones and reject request id reuse", () => {
  const ledger = new ExecutionCorrelationLedger(async () => receipt("cancelled"), { maxTombstones: 2 });
  for (const requestId of ["a", "b", "c"]) {
    ledger.beforeWrite({ ownerId: "owner", epoch: 1, requestId });
    ledger.bindReceipt({ ...receipt("succeeded"), requestId });
  }
  assert.doesNotThrow(() => ledger.beforeWrite({ ownerId: "owner", epoch: 1, requestId: "a" }));
  assert.throws(() => ledger.beforeWrite({ ownerId: "owner", epoch: 1, requestId: "c" }), /duplicate_execution_correlation/);
});
