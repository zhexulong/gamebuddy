import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionCorrelationLedger, TERMINAL_EXECUTION_STATES } from "./execution-correlation-ledger.js";
import { EXECUTION_STATES, type ExecutionReceipt, type ExecutionState } from "./protocol.js";

const receipt = (state: ExecutionState = "accepted") => ({
  requestId: "request_1",
  executionId: "execution_1",
  state,
  reasonCode: state,
  revision: 1,
  evidence: null,
});

test("epoch cancellation remains unsettled until a late receipt receives exact settled cancellation", async () => {
  const sent: string[][] = [];
  let settleCancel!: () => void;
  const cancelSettled = new Promise<void>((resolve) => {
    settleCancel = resolve;
  });
  const ledger = new ExecutionCorrelationLedger(async (...args) => {
    sent.push(args);
    await cancelSettled;
    return receipt("cancelled");
  });
  ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
  const pending = ledger.requestCancelEpoch(4, "stop_all");
  assert.equal(pending.length, 1);
  let completed = false;
  void Promise.all(pending).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  ledger.bindReceipt(receipt());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [["request_1", "execution_1", "stop_all"]]);
  assert.equal(completed, false);
  settleCancel();
  await Promise.all(pending);
  assert.equal(completed, true);
});

test("cancellation rejection settles the STOP barrier as a rejection", async () => {
  const ledger = new ExecutionCorrelationLedger(async () => {
    throw new Error("adapter_cancel_rejected");
  });
  ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
  const pending = ledger.requestCancelEpoch(4, "stop_all");
  ledger.bindReceipt(receipt("running"));
  await assert.rejects(() => Promise.all(pending), /adapter_cancel_rejected/);
});

test("terminal receipt after dispatch cancellation retires before it can send a cancel", async () => {
  for (const state of TERMINAL_EXECUTION_STATES) {
    const sent: string[][] = [];
    const ledger = new ExecutionCorrelationLedger(async (...args) => {
      sent.push(args);
      return receipt("cancelled");
    });
    ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
    assert.equal(ledger.requestCancelEpoch(4, "stop_all").length, 1);

    ledger.bindReceipt(receipt(state));
    ledger.bindReceipt(receipt(state));

    assert.deepEqual(sent, [], `${state} receipt must not send a cancel`);
  }
});

test("every terminal receipt settles the pre-receipt STOP barrier without sending a cancel", async () => {
  for (const state of TERMINAL_EXECUTION_STATES) {
    const sent: string[][] = [];
    const ledger = new ExecutionCorrelationLedger(async (...args) => {
      sent.push(args);
      return receipt("cancelled");
    });
    ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
    const pending = ledger.requestCancelEpoch(4, "stop_all");
    let settled = false;
    void Promise.all(pending).then(() => {
      settled = true;
    });
    // The receipt arrives (e.g. after a disconnect) before any execution id
    // was ever bound, so no cancel can be sent; the terminal receipt alone
    // must conclude the registration or the STOP barrier would hang.
    ledger.bindReceipt(receipt(state));
    await assertSettled(Promise.all(pending), "stop_barrier_never_settled");
    assert.equal(settled, true, `${state} must settle the STOP barrier`);
    assert.deepEqual(sent, [], `${state} receipt must not send a cancel`);
  }
});

test("terminal receipt settles the STOP barrier even while an exact cancel is still in flight", async () => {
  const sent: string[][] = [];
  const cancelInFlight = new Promise<ExecutionReceipt>(() => undefined);
  const ledger = new ExecutionCorrelationLedger(async (...args) => {
    sent.push(args);
    await cancelInFlight;
    return receipt("cancelled");
  });
  ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
  const pending = ledger.requestCancelEpoch(4, "stop_all");
  ledger.bindReceipt(receipt("running"));
  assert.deepEqual(sent, [["request_1", "execution_1", "stop_all"]]);
  let settled = false;
  void Promise.all(pending).then(() => {
    settled = true;
  });
  // A late terminal receipt after a disconnect must conclude STOP even when
  // the already-sent cancel can never settle or will reject.
  ledger.bindReceipt(receipt("cancelled"));
  await assertSettled(Promise.all(pending), "stop_barrier_never_settled");
  assert.equal(settled, true, "terminal receipt must settle the STOP barrier");
});

test("terminal classification is exactly the protocol receipt states minus progress states", () => {
  const progress = new Set<ExecutionState>(["accepted", "running", "meaningful_progress"]);
  const expected = [...EXECUTION_STATES].filter((state) => !progress.has(state)).sort();
  assert.deepEqual([...TERMINAL_EXECUTION_STATES].sort(), expected);
});

test("nonterminal receipt after dispatch cancellation sends one exact cancel", async () => {
  for (const state of ["accepted", "running", "meaningful_progress"] as const) {
    const sent: string[][] = [];
    const ledger = new ExecutionCorrelationLedger(async (...args) => {
      sent.push(args);
      return receipt("cancelled");
    });
    ledger.beforeWrite({ ownerId: "owner_1", epoch: 4, requestId: "request_1" });
    assert.equal(ledger.requestCancelEpoch(4, "stop_all").length, 1);

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
  assert.throws(
    () => ledger.requestCancelExact({ ownerId: "other", epoch: 4 }, "request_1", "execution_1", "stop"),
    /unknown_execution_correlation/,
  );
  assert.throws(
    () => ledger.requestCancelExact({ ownerId: "owner_1", epoch: 5 }, "request_1", "execution_1", "stop"),
    /unknown_execution_correlation/,
  );
  assert.throws(
    () => ledger.requestCancelExact({ ownerId: "owner_1", epoch: 4 }, "request_1", "other", "stop"),
    /unknown_execution_correlation/,
  );
});

test("terminal bindings retain bounded tombstones and reject request id reuse", () => {
  const ledger = new ExecutionCorrelationLedger(async () => receipt("cancelled"), { maxTombstones: 2 });
  for (const requestId of ["a", "b", "c"]) {
    ledger.beforeWrite({ ownerId: "owner", epoch: 1, requestId });
    ledger.bindReceipt({ ...receipt("succeeded"), requestId });
  }
  assert.doesNotThrow(() => ledger.beforeWrite({ ownerId: "owner", epoch: 1, requestId: "a" }));
  assert.throws(
    () => ledger.beforeWrite({ ownerId: "owner", epoch: 1, requestId: "c" }),
    /duplicate_execution_correlation/,
  );
});

async function assertSettled(promise: Promise<unknown>, message: string): Promise<void> {
  await Promise.race([
    promise.then(() => undefined),
    new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error(message)), 1_000)),
  ]);
}
