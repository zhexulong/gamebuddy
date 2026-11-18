import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionReceipt } from "./protocol.js";
import { ReceiptReplayLedger } from "./receipt-replay.js";

function receipt(
  state: ExecutionReceipt["state"],
  revision: number,
  evidence: ExecutionReceipt["evidence"] = { detail: state },
): ExecutionReceipt {
  return {
    executionId: "execution_01",
    requestId: "request_01",
    actionId: "move_to_tile",
    state,
    reasonCode: state,
    revision,
    evidence,
  };
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
  assert.throws(() => {
    evidence.nested.target = "mutated_return";
  }, TypeError);
  assert.throws(() => {
    evidence.trail.push("mutated_return");
  }, TypeError);
});

/**
 * ROUND73'S PAIR, REPLAYED. On 2026-11-20 `round73` published `rejected/waiting_for_body:body_owned_by_movement` for one
 * executionId and 1.4 s later `succeeded/weeds_cut` for the SAME one; this audit ended the session with
 * `terminal_state_rewritten`, and it was right to - one execution has one outcome. `round66` had already died the same
 * way, which is what makes this a class rather than an incident.
 *
 * The Mod's answer is that a WAIT IS NOT A RECEIPT: a request that was never dispatched has no execution state to
 * state, so a parked wait contributes nothing here and the settlement that arrives afterwards is that execution's FIRST
 * outcome. Both halves are pinned below, because only the pair says which side is at fault: a wait-shaped receipt is
 * still refused by name, and the settlement a real dispatch mints is accepted.
 */
test("a wait is not a receipt, so the success that follows it is that execution's first outcome", () => {
  const requestId = "6a9da5e044b141429de30b8f67fe1c32-req-r1c3";
  const executionId = "6a9da5e044b141429de30b8f67fe1c32-exec-r1c3";
  const wait: ExecutionReceipt = {
    executionId,
    requestId,
    actionId: "cut_weeds",
    state: "rejected",
    reasonCode: "waiting_for_body:body_owned_by_movement",
    revision: 840,
    evidence: { detail: "owner_action=move_to_tile" },
  };
  const settled: ExecutionReceipt = {
    executionId,
    requestId,
    actionId: "cut_weeds",
    state: "succeeded",
    reasonCode: "weeds_cut",
    revision: 841,
    evidence: { detail: "target=weed_45d650194571158e;removed=true" },
  };

  // STILL REFUSED, BY NAME: two terminals for one execution is exactly the shape that killed round66 and round73.
  const replaying = new ReceiptReplayLedger();
  assert.equal(replaying.apply(wait), null);
  assert.equal(replaying.apply(settled), "terminal_state_rewritten");
  assert.equal(replaying.receipt(executionId)?.state, "rejected", "the first terminal stands");

  // AND THE SHAPE THE MOD NOW PUBLISHES: nothing for the wait, so the settlement is the first thing this audit sees.
  const fixed = new ReceiptReplayLedger();
  assert.equal(fixed.apply(settled), null);
  assert.deepEqual(fixed.receipt(executionId), settled);
});
