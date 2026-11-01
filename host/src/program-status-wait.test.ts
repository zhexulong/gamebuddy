import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PROGRAM_STATUS_WAIT_MS,
  createProgramProgressObserver,
  isTerminalProgramStatus,
  waitForTerminalProgramStatus,
} from "./program-status-wait.js";

/**
 * The predicate that decides whether a wait is over, pinned against every state the Mod can publish
 * (`BodyProgramState`, `BodyProgramModels.cs:144`).
 *
 * Getting this wrong in the "still running" direction is what made a model poll 48 times: a finished plan must be
 * reported finished on the first read, or the wait is a slower version of the same spin.
 */
test("only an active plan is still news; every settled state ends the wait", () => {
  const found = (state: string) => ({ code: "found", snapshot: { programId: "p1", state } });

  for (const settled of ["succeeded", "failed", "cancelled", "recovery_required", "quarantined"]) {
    assert.equal(isTerminalProgramStatus(found(settled)), true, `${settled} must end the wait`);
  }
  assert.equal(isTerminalProgramStatus(found("active")), false, "active must keep waiting");
});

test("a plan that does not exist ends the wait; a malformed request does not spin", () => {
  assert.equal(isTerminalProgramStatus({ code: "not_found", snapshot: null }), true);
  // `invalid_input` is a caller error, not a plan state: asking again produces the same answer, so treating it as
  // finished would be a lie and treating it as running would spin until the deadline.
  assert.equal(isTerminalProgramStatus({ code: "invalid_input", snapshot: null }), false);
  assert.equal(isTerminalProgramStatus({ code: "found", snapshot: null }), false);
  assert.equal(isTerminalProgramStatus(undefined), false);
  assert.equal(isTerminalProgramStatus("found"), false);
});

/** A fake clock so the wait's timing is asserted, not slept through. */
function fakeTime() {
  let current = 0;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

/** One `program_status` payload with the fields the wait compares. */
function active(nodeStates: readonly string[], eventHighWater = 0) {
  return {
    code: "found",
    snapshot: {
      programId: "p1",
      state: "active",
      eventHighWater,
      nodes: nodeStates.map((state, index) => ({ nodeId: `n${index + 1}`, state })),
    },
  };
}

test("a plan that publishes nothing ends the wait early instead of spending the caller's whole bound", async () => {
  // The measured cost this closes: 2026-10-30, 82 calls with `waitMs` set, 2,084 s of requested waiting, and only 21
  // of them ever reached a terminal state. A wait that has read the same snapshot eight times already knows the answer
  // the caller would get at the deadline.
  //
  // Nothing is in flight here: no action was dispatched, so no receipt can arrive until the Mod's own pump dispatches
  // the first node - and measured over 1,205 admissions, that round trip is p90 200 ms. Two seconds of it is a stall.
  const clock = fakeTime();
  let index = 0;
  const outcome = await waitForTerminalProgramStatus(
    async () => {
      index++;
      return active(["awaiting_host_admission"]);
    },
    active(["awaiting_host_admission"]),
    30_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.reachedTerminal, false);
  assert.equal(outcome.waited.snapshotChanged, false, "nothing moved, and that is what it reports");
  // Eight unchanged polls at the 250 ms interval, not the thirty seconds that were asked for.
  assert.ok(clock.now() < 5_000, `returned after ${clock.now()} ms of a 30,000 ms bound`);
  assert.ok(index >= 8 && index <= 12, `read ${index} times`);
});

/**
 * THE defect: an action that is still running is not a plan with nothing to report.
 *
 * Measured over 83 runs and 2,674 dispatches, dispatch -> receipt is p90 3,612 ms for `move_to_tile` and 4,133 ms for
 * `harvest_crop`, and 22% of all executions outlive the 2,000 ms the early return waits. A node's state in the snapshot
 * the wait compares moves exactly once per transition and the only transition out of `running` is its terminal receipt,
 * so for the whole of that interval the snapshot is not quiet - it is provably frozen. Counting those polls as "nothing
 * changed" hands the caller a still-running plan and tells it asking again will say the same thing.
 */
test("an action still running in the game is not a plan with nothing to report", async () => {
  const clock = fakeTime();
  const settlesAtMs = 8_000;
  const outcome = await waitForTerminalProgramStatus(
    async () =>
      clock.now() < settlesAtMs
        ? active(["running"])
        : {
            code: "found",
            snapshot: { programId: "p1", state: "succeeded", nodes: [{ nodeId: "n1", state: "succeeded" }] },
          },
    active(["running"]),
    30_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  // The whole point: it waited for the action and reported what the action became.
  assert.equal(outcome.waited.reachedTerminal, true, `returned after ${clock.now()} ms without reaching the settle`);
  assert.ok(
    clock.now() >= settlesAtMs,
    `returned at ${clock.now()} ms, before the action settled at ${settlesAtMs} ms`,
  );
});

test("a running action that never settles spends the caller's bound instead of calling it silence", async () => {
  // The other half of the same rule. A running node's next publication is guaranteed to be its settle, so the wait has
  // nothing to report only when the bound runs out - and then `snapshotChanged: false` is the truth, not a guess.
  const clock = fakeTime();
  const outcome = await waitForTerminalProgramStatus(
    async () => active(["running"]),
    active(["running"]),
    30_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.reachedTerminal, false);
  assert.equal(outcome.waited.snapshotChanged, false);
  assert.ok(clock.now() >= 30_000, `returned after ${clock.now()} ms of a 30,000 ms bound, with an action in flight`);
});

test("the early return still fires once the last action settles and nothing is in flight again", async () => {
  // The early return is kept for exactly the case it was right about: silence with nothing executing. After the node
  // settles the snapshot moves once, the counter restarts, and the next eight quiet polls end the wait.
  const clock = fakeTime();
  const settlesAtMs = 1_000;
  const outcome = await waitForTerminalProgramStatus(
    async () => active(clock.now() < settlesAtMs ? ["running", "pending"] : ["succeeded", "pending"]),
    active(["running", "pending"]),
    30_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.reachedTerminal, false);
  assert.equal(outcome.waited.snapshotChanged, true, "the settle was reported as movement");
  assert.ok(clock.now() < 30_000, `returned after ${clock.now()} ms`);
});

test("a plan that IS moving is still waited for to the deadline", async () => {
  // The bound must survive for a plan that publishes progress: the early return is for silence, not for slowness.
  const clock = fakeTime();
  let index = 0;
  const outcome = await waitForTerminalProgramStatus(
    async () => {
      index++;
      // A different node state on every read, so every poll counts as movement.
      return active([`running-${index}`]);
    },
    active(["running-0"]),
    1_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.reachedTerminal, false);
  assert.equal(outcome.waited.snapshotChanged, true);
  assert.ok(clock.now() >= 1_000, `spent the whole bound: ${clock.now()} ms`);
});

test("a plan that settles while waiting returns the settled read and says it waited", async () => {
  const clock = fakeTime();
  const reads = [active(["running"]), active(["running"]), { code: "found", snapshot: { state: "succeeded" } }];
  let index = 0;
  const outcome = await waitForTerminalProgramStatus(
    async () => reads[Math.min(index++, reads.length - 1)]!,
    reads[0]!,
    5_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.deepEqual(outcome.result, { code: "found", snapshot: { state: "succeeded" } });
  assert.equal(outcome.waited.reachedTerminal, true);
  // The second read had moved a node, so the plan changed even before it settled.
  assert.equal(outcome.waited.snapshotChanged, true);
  assert.equal(index, 3);
});

test("expiry returns the honest still-running read, never a finished one", async () => {
  const clock = fakeTime();
  let reads = 0;
  const outcome = await waitForTerminalProgramStatus(
    async () => {
      reads += 1;
      return active(["running"]);
    },
    active(["running"]),
    1_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.deepEqual(outcome.result, active(["running"]));
  assert.equal(outcome.waited.reachedTerminal, false);
  // It polled more than once but did not spin: ~4 intervals inside a 1s budget.
  assert.ok(reads >= 2 && reads <= 6, `unexpected read count ${String(reads)}`);
});

/**
 * The measurement this field exists for (`round4`): four consecutive 30 s waits on one plan, every one of them
 * returning the same `running` node. A caller told only "still running" waited again and paid the bound again.
 */
test("an expired wait whose plan never moved says so, instead of the bare still-running it used to say", async () => {
  const clock = fakeTime();
  const outcome = await waitForTerminalProgramStatus(
    async () => active(["succeeded", "running"]),
    active(["succeeded", "running"]),
    1_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.reachedTerminal, false);
  assert.equal(outcome.waited.snapshotChanged, false);
});

test("a plan that advanced a node during an expired wait is reported as having advanced", async () => {
  const clock = fakeTime();
  const reads = [active(["running", "pending"]), active(["succeeded", "pending"]), active(["succeeded", "running"])];
  let index = 0;
  const outcome = await waitForTerminalProgramStatus(
    async () => reads[Math.min(index++, reads.length - 1)]!,
    reads[0]!,
    5_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.reachedTerminal, false);
  assert.equal(outcome.waited.snapshotChanged, true);
});

/**
 * `eventHighWater` is the journal-wide cursor, so another plan's progress moves it while this one stands still.
 * Measured 2026-10-28: two programs ran in alternation, which is what made a single controller-wide slot useless for
 * the same de-duplication on the Mod side (`6e69b478`). Reporting this plan as "changed" because a DIFFERENT plan
 * moved would be the same mistake in the other direction.
 */
test("another program's journal entry does not count as this plan changing", async () => {
  const clock = fakeTime();
  let reads = 0;
  const outcome = await waitForTerminalProgramStatus(
    async () => {
      reads += 1;
      return active(["running"], 288 + reads);
    },
    active(["running"], 288),
    1_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.reachedTerminal, false);
  assert.equal(outcome.waited.snapshotChanged, false);
});

test("the wait is capped, so a caller cannot hold a turn open indefinitely", async () => {
  const clock = fakeTime();
  let reads = 0;
  await waitForTerminalProgramStatus(
    async () => {
      reads += 1;
      return active(["running"]);
    },
    active(["running"]),
    MAX_PROGRAM_STATUS_WAIT_MS * 10,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  // Never past the cap: with a 250ms interval that is at most 120 sleeps.
  assert.ok(reads <= Math.ceil(MAX_PROGRAM_STATUS_WAIT_MS / 250) + 2, `wait escaped the cap: ${String(reads)} reads`);
});

test("an already-finished plan costs exactly one read", async () => {
  const clock = fakeTime();
  let reads = 0;
  const outcome = await waitForTerminalProgramStatus(
    async () => {
      reads += 1;
      return { code: "found", snapshot: { state: "succeeded" } };
    },
    { code: "found", snapshot: { state: "succeeded" } },
    5_000,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.reachedTerminal, true);
  assert.equal(reads, 1);
});

/**
 * THE defect this file grew a second half for (`round18`).
 *
 * 65 `program_status` calls spent 281 s of a 24-minute run, the longest of them asking for the whole 30,000 ms bound, and
 * the plans were finishing (66 programs of 290 nodes at 93% success). The wait was not slow: the answer a caller got was
 * a node list with states, which says nothing about how much work is left or whether the node in front of it is moving.
 * With no basis to pick a bound, the maximum is the only safe choice - so the result has to carry the basis.
 */
test("a plan with work left says how much is left, and which node it is on", () => {
  const observer = createProgramProgressObserver();
  const progress = observer.observe(
    plan([
      ["n1", "succeeded"],
      ["n2", "running"],
      ["n3", "pending"],
      ["n4", "awaiting_host_admission"],
    ]),
    0,
  );
  assert.deepEqual(progress, {
    total: 4,
    settled: 1,
    remaining: 3,
    running: 1,
    queued: 2,
    current: { nodeId: "n2", state: "running", observedInStateMs: 0 },
  });
});

test("the current node's clock is the plan's, not this call's", () => {
  // The measured cost: four consecutive 30 s waits on one plan all returned the same `running` node. Across those calls
  // the node had been running for two minutes, and no call could say so - each one only knew its own bound.
  const observer = createProgramProgressObserver();
  const payload = plan([
    ["n1", "succeeded"],
    ["n2", "running"],
    ["n3", "pending"],
  ]);
  observer.observe(payload, 1_000);
  const later = observer.observe(payload, 5_000);
  assert.equal(later?.current?.observedInStateMs, 4_000);
  assert.equal(later?.remaining, 2, "two nodes still to get through");
});

test("a node that changed state is timed from the change, not from when the node first appeared", () => {
  const observer = createProgramProgressObserver();
  observer.observe(
    plan([
      ["n1", "running"],
      ["n2", "pending"],
    ]),
    0,
  );
  const moved = observer.observe(
    plan([
      ["n1", "succeeded"],
      ["n2", "awaiting_host_admission"],
    ]),
    7_000,
  );
  // `n2` is the plan's work now, and it has been waiting on admission for no time at all: reporting `n1`'s seven
  // seconds as its predecessor's would tell a caller to stop waiting on a node that just started.
  assert.deepEqual(moved?.current, { nodeId: "n2", state: "awaiting_host_admission", observedInStateMs: 0 });
  assert.equal(moved?.settled, 1);
  assert.equal(moved?.running, 0);
  assert.equal(moved?.queued, 1);
});

test("a rejected node and the dependents it skipped are settled work, not work still to wait for", () => {
  // A plan with a rejected node stays `active`, so these would otherwise count as outstanding and keep a caller
  // waiting on work the Mod will never dispatch.
  const observer = createProgramProgressObserver();
  const progress = observer.observe(
    plan([
      ["n1", "succeeded"],
      ["n2", "rejected"],
      ["n3", "skipped_dependency"],
      ["n4", "abandoned"],
      ["n5", "cancelled"],
    ]),
    0,
  );
  assert.equal(progress?.settled, 5);
  assert.equal(progress?.remaining, 0);
  assert.equal(progress?.current, null, "nothing left names no current node");
});

test("a plan waiting on its next admission names the node it is waiting for", () => {
  const observer = createProgramProgressObserver();
  const progress = observer.observe(
    plan([
      ["n1", "succeeded"],
      ["n2", "awaiting_host_admission"],
    ]),
    2_000,
  );
  assert.deepEqual(progress?.current, { nodeId: "n2", state: "awaiting_host_admission", observedInStateMs: 0 });
  assert.equal(progress?.running, 0, "nothing is dispatched, so nothing owes a receipt");
});

test("a read that found no plan reports no progress instead of an empty one", () => {
  // Zeroes would read as "a plan with nothing left", which is the one thing this must never say about a plan it did not
  // read; the caller's next move on `not_found` is to stop asking, not to wait.
  const observer = createProgramProgressObserver();
  assert.equal(observer.observe({ code: "not_found", snapshot: null }), null);
  assert.equal(observer.observe({ code: "invalid_input", snapshot: null }), null);
  assert.equal(observer.observe({ code: "found", snapshot: null }), null);
});

test("a stopped plan keeps no clock, so a reused program id cannot inherit one", () => {
  const observer = createProgramProgressObserver();
  observer.observe(plan([["n1", "running"]]), 0);
  observer.observe(plan([["n1", "succeeded"]], "succeeded"), 4_000);
  // The same id, active again, is different work: its node starts its own clock rather than inheriting n1's seconds.
  const again = observer.observe(plan([["n1", "running"]]), 9_000);
  assert.equal(again?.current?.observedInStateMs, 0);
});

test("a STOP epoch starts its own clock, because it ends the work the old one was timing", () => {
  // STOP cancels the plan's nodes and the same ids are re-dispatched in a new epoch; a clock carried across it would
  // time work that no longer exists and tell a caller a node it has never waited on had been running for a minute.
  const observer = createProgramProgressObserver();
  observer.observe(plan([["n1", "running"]], "active", 0), 0);
  const afterStop = observer.observe(plan([["n1", "running"]], "active", 1), 30_000);
  assert.equal(afterStop?.current?.observedInStateMs, 0);
});

/** One `program_status` payload for the progress reads: a plan whose nodes are named by state. */
function plan(nodes: readonly (readonly [string, string])[], state = "active", stopEpoch = 0) {
  return {
    code: "found",
    snapshot: {
      programId: "p1",
      state,
      stopEpoch,
      nodes: nodes.map(([nodeId, nodeState]) => ({ nodeId, state: nodeState })),
    },
  };
}
