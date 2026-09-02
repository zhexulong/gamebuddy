import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionReceipt } from "./protocol.js";
import { ReceiptReplayLedger } from "./receipt-replay.js";

function receipt(
  state: ExecutionReceipt["state"],
  revision: number,
  evidence: ExecutionReceipt["evidence"] = { detail: state },
): ExecutionReceipt {
  return { executionId: "execution_01", requestId: "request_01", actionId: "move_to_tile", state, reasonCode: state, revision, evidence };
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

test("unknown execution receipt query returns null", () => {
  assert.equal(new ReceiptReplayLedger().receipt("unknown_execution"), null);
});

test("identical receipt re-delivery is a no-op", () => {
  const ledger = new ReceiptReplayLedger();
  const first = receipt("running", 1, { nested: { target: "tile_12_34" } });
  assert.equal(ledger.apply(first), null);
  const stored = ledger.receipt(first.executionId);

  assert.equal(ledger.apply(structuredClone(first)), null);
  assert.strictEqual(ledger.receipt(first.executionId), stored);
  assert.deepEqual(ledger.receipt(first.executionId), first);
});

test("rejected receipts preserve the last accepted state", () => {
  const cases: readonly Readonly<{
    initial: ExecutionReceipt;
    rejected: ExecutionReceipt;
    fault: string;
  }>[] = [
    {
      initial: receipt("accepted", 1),
      rejected: receipt("succeeded", 2, null),
      fault: "success_without_evidence",
    },
    {
      initial: receipt("failed", 2),
      rejected: receipt("running", 3),
      fault: "terminal_state_rewritten",
    },
    {
      initial: receipt("accepted", 1),
      rejected: { ...receipt("running", 2), requestId: "other_request" },
      fault: "execution_request_mismatch",
    },
    {
      initial: receipt("accepted", 2),
      rejected: receipt("running", 2),
      fault: "non_monotonic_revision",
    },
    {
      initial: receipt("accepted", 1),
      rejected: { ...receipt("running", 2), state: "invalid_previous_state" } as unknown as ExecutionReceipt,
      fault: "invalid_previous_state",
    },
  ];
  for (const { initial, rejected, fault } of cases) {
    const ledger = new ReceiptReplayLedger();
    assert.equal(ledger.apply(initial), null);
    const before = ledger.receipt(initial.executionId);

    assert.equal(ledger.apply(rejected), fault);
    assert.strictEqual(ledger.receipt(initial.executionId), before);
  }
});

test("receipt replay stores and returns an immutable deep snapshot", () => {
  const ledger = new ReceiptReplayLedger();
  const input = receipt("succeeded", 1, { nested: { target: "tile_12_34" }, trail: ["start", "finish"] });
  assert.equal(ledger.apply(input), null);

  const inputEvidence = input.evidence as { nested: { target: string }; trail: string[] };
  inputEvidence.nested.target = "mutated_input";
  inputEvidence.trail.push("after_apply");
  const stored = ledger.receipt(input.executionId)!;
  const evidence = stored.evidence as { nested: { target: string }; trail: string[] };

  assert.deepEqual(evidence, { nested: { target: "tile_12_34" }, trail: ["start", "finish"] });
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.evidence), true);
  assert.equal(Object.isFrozen(evidence.nested), true);
  assert.equal(Object.isFrozen(evidence.trail), true);
  assert.throws(() => { evidence.nested.target = "mutated_return"; }, TypeError);
  assert.throws(() => { evidence.trail.push("mutated_return"); }, TypeError);
});
