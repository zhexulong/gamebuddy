import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionReceipt } from "./protocol.js";
import { ReceiptReplayLedger } from "./receipt-replay.js";

function receipt(
  state: ExecutionReceipt["state"],
  revision: number,
  evidence: ExecutionReceipt["evidence"] = { detail: state },
): ExecutionReceipt {
  return { executionId: "execution_01", requestId: "request_01", state, reasonCode: state, revision, evidence };
}

test("receipt replay accepts authoritative terminal paths with monotonic revisions", () => {
  const cases: readonly (readonly ExecutionReceipt[])[] = [
    [receipt("accepted", 1), receipt("blocked", 2)],
    [receipt("accepted", 1), receipt("running", 2), receipt("failed", 3)],
    [
      receipt("accepted", 1),
      receipt("meaningful_progress", 2),
      receipt("succeeded", 3, { postcondition: "target_reached" }),
    ],
  ];
  for (const sequence of cases) {
    const ledger = new ReceiptReplayLedger();
    for (const item of sequence) assert.equal(ledger.apply(item), null);
    assert.deepEqual(ledger.receipt("execution_01"), sequence.at(-1));
  }
});

test("receipt replay fails closed for terminal rewrites, mismatch, regressions, and evidence-free success", () => {
  const ledger = new ReceiptReplayLedger();
  assert.equal(ledger.apply(receipt("accepted", 1)), null);
  assert.equal(ledger.apply(receipt("succeeded", 2, null)), "success_without_evidence");
  assert.equal(ledger.apply(receipt("failed", 2)), null);
  assert.equal(ledger.apply(receipt("running", 3)), "terminal_state_rewritten");
  assert.equal(ledger.apply({ ...receipt("failed", 4), requestId: "other_request" }), "execution_request_mismatch");
  assert.equal(ledger.apply(receipt("failed", 2)), "non_monotonic_revision");
});
