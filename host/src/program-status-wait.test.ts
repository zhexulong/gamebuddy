import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PROGRAM_STATUS_WAIT_MS,
  createProgramProgressObserver,
  isTerminalProgramStatus,
  planBatchAnswer,
  planNodeReasonDetail,
  waitForTerminalProgramStatus,
} from "./program-status-wait.js";
import { BODY_PROGRAM_NODE_STATES } from "./protocol.js";

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
    // Every node's own clock, in journal order: the same reading `current` publishes, for each node, so the per-node
    // answer `plan_work` gives and the `current` this tool gives cannot disagree about one plan's node.
    nodes: [
      { nodeId: "n1", state: "succeeded", observedInStateMs: 0 },
      { nodeId: "n2", state: "running", observedInStateMs: 0 },
      { nodeId: "n3", state: "pending", observedInStateMs: 0 },
      { nodeId: "n4", state: "awaiting_host_admission", observedInStateMs: 0 },
    ],
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

/**
 * A PLAN'S PER-NODE ANSWER, read against the identity the frame carries.
 *
 * The join is the node id, and the Mod's journal accepts the candidate's own ids verbatim, so the journal order is
 * irrelevant: `plan_work` compiles `n01`, `n02`, ... and an `auto_walk_NN` for a door's walk, and those are the strings
 * the snapshot comes back with. Every case below hands the journal rows in an order that is NOT the script order, so a
 * reader that numbers them by array position answers the wrong node.
 */
const answerNode = (nodeId: string, actionId = "move_to_tile", x?: number, y?: number) => ({
  nodeId,
  actionId,
  arguments:
    x === undefined || y === undefined
      ? {}
      : {
          x: { type: "integer", canonicalValue: String(x) },
          y: { type: "integer", canonicalValue: String(y) },
        },
});

test("a plan answers every node it carries at its own index, never at the journal's array position", () => {
  const answer = planBatchAnswer([answerNode("n01", "move_to_tile", 5, 8), answerNode("n02")], {
    programId: "p1",
    state: "failed",
    nodes: [
      { nodeId: "n02", state: "succeeded", nodeAttempt: 1, admissionAttempt: 1 },
      { nodeId: "n01", state: "rejected", rejectionCode: "actor_held_by_modal" },
    ],
  });
  assert.deepEqual(answer.nodes, [
    {
      index: 0,
      actionId: "move_to_tile",
      state: "rejected",
      reasonCode: "actor_held_by_modal",
      reasonDetail: "unknown_reason:rejected",
      tile: { x: 5, y: 8 },
    },
    { index: 1, actionId: "move_to_tile", state: "succeeded" },
  ]);
});

test("a batch is settled only when every node has stopped, and says how many have not", () => {
  const compiled = [answerNode("n01"), answerNode("n02"), answerNode("n03")];
  const running = planBatchAnswer(compiled, {
    nodes: [
      { nodeId: "n03", state: "pending" },
      { nodeId: "n02", state: "host_admitted" },
      { nodeId: "n01", state: "succeeded" },
    ],
  });
  assert.equal(running.settled, false, "one node is dispatched and one is queued");
  assert.equal(running.remaining, 2);
  const stopped = planBatchAnswer(compiled, {
    nodes: [
      { nodeId: "n01", state: "succeeded" },
      { nodeId: "n02", state: "cancelled" },
      // The wire's own word for a node whose fate is unknown (`BodyProgramNodeState` maps `SkippedDependency` and
      // `Abandoned` onto `recovery_required`), so a cancelled and an unknowable node both stop the batch.
      { nodeId: "n03", state: "recovery_required" },
    ],
  });
  assert.equal(stopped.settled, true, "a cancelled node and an unknowable one have both stopped");
  assert.equal(stopped.remaining, 0, "nothing is left to wait for");
});

test("a node the journal does not describe is unknown, and never counts as settled", () => {
  // A journal that does not list a node has not shown it to be waiting, so `pending` would be the Host inventing
  // progress; counting it as settled would be worse - it would report a batch finished around work it never read.
  const answer = planBatchAnswer([answerNode("n01"), answerNode("n02")], {
    nodes: [{ nodeId: "n01", state: "succeeded" }],
  });
  assert.deepEqual(answer.nodes[1], {
    index: 1,
    actionId: "move_to_tile",
    state: "unknown",
    reasonDetail: "unknown_reason:unknown",
  });
  assert.equal(answer.settled, false);
  assert.equal(answer.remaining, 1);
  // No snapshot at all - `not_found`, or a submission the Mod refused - reads the same way, rather than as an empty plan.
  const unread = planBatchAnswer([answerNode("n01")], null);
  assert.equal(unread.remaining, 1);
  assert.equal(unread.settled, false);
});

test("a node's reason is the receipt's own word, and its reachability hint travels beside it", () => {
  const answer = planBatchAnswer([answerNode("n01", "move_to_tile", 49, 14)], {
    nodes: [
      {
        nodeId: "n01",
        state: "failed",
        failureCode: "no_native_path",
        hint: "closest=49,14;closest_distance=1",
        rejectionCode: null,
      },
    ],
  });
  // `failureCode` is why a dispatched node settled without succeeding; `rejectionCode` is why one never ran. They are
  // disjoint on the Mod's side, and reading either as the other would turn a refusal into a failure.
  assert.equal(answer.nodes[0]?.reasonCode, "no_native_path");
  assert.equal(answer.nodes[0]?.hint, "closest=49,14;closest_distance=1");
});

test("a skipped node names the producers it waited on that did not come good", () => {
  // The graph is the compiled one: a door depends on the walk written for it (`n001_approach`), nothing else has an
  // edge, and `n004` waits on the door. Read against the Mod's own states, that is a 1:1 skip for one failure and one
  // transitive skip two steps down - and an independent neighbour (`n003`) that ran.
  const answer = planBatchAnswer(
    [
      { nodeId: "n001_approach", actionId: "move_to_tile", arguments: {}, dependsOn: [] },
      { nodeId: "n002", actionId: "enter_exit", arguments: {}, dependsOn: ["n001_approach"] },
      { nodeId: "n003", actionId: "harvest_crop", arguments: {}, dependsOn: [] },
      { nodeId: "n004", actionId: "plant_seed", arguments: {}, dependsOn: ["n002"] },
      // No producer at all: the shape the Mod's abandon path writes for a node that never attempted.
      { nodeId: "n005", actionId: "water_crop", arguments: {} },
    ],
    {
      nodes: [
        { nodeId: "n001_approach", state: "failed", failureCode: "no_native_path" },
        { nodeId: "n002", state: "skipped_dependency" },
        { nodeId: "n003", state: "succeeded" },
        { nodeId: "n004", state: "skipped_dependency" },
        { nodeId: "n005", state: "skipped_dependency" },
      ],
    },
  );
  // "skipped" alone is a state with no subject. The walk is named, with the walk's own word for why it stopped.
  assert.deepEqual(answer.nodes[1]?.skippedBecause, [{ nodeId: "n001_approach", reasonCode: "no_native_path" }]);
  // A skip two steps down names the node it ACTUALLY waited on, which carries its own answer about the walk.
  assert.deepEqual(answer.nodes[3]?.skippedBecause, [{ nodeId: "n002", reasonCode: "skipped_dependency" }]);
  assert.equal("skippedBecause" in (answer.nodes[2] as object), false, "the neighbour that ran waits on nothing");
  assert.equal(
    "skippedBecause" in (answer.nodes[4] as object),
    false,
    "a skip this graph cannot explain stays unexplained instead of borrowing someone else's reason",
  );
  assert.deepEqual(
    answer.nodes.map((node) => node.state),
    ["failed", "skipped_dependency", "succeeded", "skipped_dependency", "skipped_dependency"],
  );
});

test("a tile rides only on a node whose own arguments name one", () => {
  const answer = planBatchAnswer(
    [
      answerNode("n01", "move_to_tile", 61, 18),
      { nodeId: "n02", actionId: "sleep", arguments: {} },
      // A destination selector carries no `canonicalValue`: it is a typed object, not a scalar, and a tile read out of one
      // would be a coordinate the caller never wrote.
      { nodeId: "n03", actionId: "enter_exit", arguments: { x: { type: "integer", canonicalValue: "3" } } },
    ],
    { nodes: [] },
  );
  assert.deepEqual(answer.nodes[0]?.tile, { x: 61, y: 18 });
  assert.equal("tile" in (answer.nodes[1] as object), false);
  assert.equal("tile" in (answer.nodes[2] as object), false, "an unpaired coordinate is not a tile");
});

test("a clock rides only on a node that has not stopped", () => {
  const clocks = [
    { nodeId: "n01", state: "succeeded", observedInStateMs: 4_000 },
    { nodeId: "n02", state: "running", observedInStateMs: 12_500 },
    { nodeId: "n03", state: "pending", observedInStateMs: 300 },
  ];
  const answer = planBatchAnswer(
    [answerNode("n01"), answerNode("n02"), answerNode("n03")],
    {
      nodes: [
        { nodeId: "n01", state: "succeeded" },
        { nodeId: "n02", state: "running" },
        { nodeId: "n03", state: "pending" },
      ],
    },
    clocks,
  );
  // A stopped node is not still being watched, so it carries no clock - and the two that are carry their own, which is
  // what makes "running for twelve seconds" sayable instead of a bare "still running".
  assert.equal("elapsedMs" in (answer.nodes[0] as object), false);
  assert.equal(answer.nodes[1]?.elapsedMs, 12_500);
  assert.equal(answer.nodes[2]?.elapsedMs, 300, "a queued node's wait is timed too");
});

/**
 * T2 - SINGLE READER.
 *
 * The Mod's refusal detail is a string the refusing layer wrote (`owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1`)
 * and the plan answer carries it BYTE-IDENTICAL. Not re-rendered, not summarised, not re-cased: a Host that reformatted it
 * would be a second author of a fact it did not observe, and the caller that reads it would be reading the Host's prose
 * about the game rather than the game's own answer.
 *
 * The `deepEqual` on the whole row is the assertion, not `row.reasonDetail === input`: it also pins that the detail arrives
 * beside the code it explains and not in place of it.
 */
test("the Mod's own refusal detail reaches the plan answer byte for byte", () => {
  const detail = "owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1";
  const answer = planBatchAnswer([{ nodeId: "n01", actionId: "shop_purchase", arguments: {} }], {
    nodes: [
      {
        nodeId: "n01",
        state: "failed",
        failureCode: "shop_counter_out_of_reach",
        refusalDetail: detail,
      },
    ],
  });
  assert.deepEqual(answer.nodes[0], {
    index: 0,
    actionId: "shop_purchase",
    state: "failed",
    reasonCode: "shop_counter_out_of_reach",
    reasonDetail: detail,
  });
  // A `shop_purchase` row's arguments name no tile, so the row invents none: the coordinate in a refusal is the one the
  // MOD bound, and reading one out of arguments that carry none is how "node 3 failed at 61,18" became sayable about a
  // node that acts on a shop counter.
  assert.equal("tile" in (answer.nodes[0] as object), false, "the arguments carry no tile, so the row invents none");
});

/**
 * T3 - THE GATE.
 *
 * Population: `BODY_PROGRAM_NODE_STATES`, the declaration the wire validator itself accepts (`isBodyProgramNodeState`),
 * not a list written here. For every member: a non-succeeded node with no reason answers `unknown_reason:<state>`, a node
 * with a real detail answers that detail, and the two never coexist.
 *
 * Why a gate and not a test: the defect is "a settlement reaches the caller with no reason", and its members are states
 * nobody has written yet. A list of the states someone remembered cannot cover the state added next; the enum can. The
 * count is printed and refused at zero, because a gate that examined nothing agrees with itself.
 */
test("every node state the wire names either carries its reason or says it has none", () => {
  assert.ok(BODY_PROGRAM_NODE_STATES.length >= 11, `examined ${BODY_PROGRAM_NODE_STATES.length} node states`);
  const examined: string[] = [];
  const rowFor = (state: string, extra: Readonly<Record<string, unknown>> = {}) =>
    planBatchAnswer([{ nodeId: "n01", actionId: "shop_purchase", arguments: {} }], {
      nodes: [{ nodeId: "n01", state, ...extra }],
    }).nodes[0];
  for (const state of BODY_PROGRAM_NODE_STATES) {
    const row = rowFor(state);
    assert.ok(row !== undefined, `the state '${state}' must produce a row`);
    assert.equal(row.state, state, `the state '${state}' must arrive verbatim`);
    if (state === "succeeded") {
      assert.equal(
        Object.hasOwn(row as object, "reasonDetail"),
        false,
        "a success proves its effect and owes no reason",
      );
    } else {
      assert.equal(
        row.reasonDetail,
        `unknown_reason:${state}`,
        `the state '${state}' settles without succeeding, so the row must say the reason is missing rather than omit it`,
      );
    }
    // ...and with a real detail the placeholder is gone. One `??` chain, so the two arms cannot coexist.
    if (state === "failed" || state === "cancelled" || state === "rejected") {
      const explained = rowFor(state, { refusalDetail: "owner=Pierre;radius=1" });
      assert.equal(
        explained?.reasonDetail,
        "owner=Pierre;radius=1",
        `the state '${state}' must carry the Mod's detail`,
      );
      assert.notEqual(explained?.reasonDetail, `unknown_reason:${state}`, "real detail and placeholder never coexist");
    }
    // `recovery_required` is the one state whose journal reason is a diagnostic rather than a detail: the Mod writes
    // `execution_uncertain` there, and answering `unknown_reason:recovery_required` would deny something it had said.
    if (state === "recovery_required") {
      const diagnosed = rowFor(state, { recoveryDiagnostic: "execution_uncertain" });
      assert.equal(diagnosed?.reasonDetail, "execution_uncertain", "the journal's own diagnostic is the reason");
    }
    examined.push(state);
  }
  assert.deepEqual(examined, [...BODY_PROGRAM_NODE_STATES], `examined ${examined.length} node states`);
  assert.equal(examined.length, BODY_PROGRAM_NODE_STATES.length);
});

/**
 * The single decision point, asked directly: `succeeded` is the only state with no reason, and the placeholder can never
 * stand where a real detail exists.
 */
test("a reason detail answers for every settled state and is absent only for a success", () => {
  assert.equal(planNodeReasonDetail("succeeded", null, null), null);
  assert.equal(planNodeReasonDetail("succeeded", "a detail a broken Mod sent", null), null, "a success has no reason");
  assert.equal(planNodeReasonDetail("cancelled", "why", null), "why");
  assert.equal(planNodeReasonDetail("failed", null, null), "unknown_reason:failed");
  assert.equal(planNodeReasonDetail("recovery_required", null, "execution_uncertain"), "execution_uncertain");
});
