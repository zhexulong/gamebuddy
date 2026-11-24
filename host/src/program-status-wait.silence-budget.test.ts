import assert from "node:assert/strict";
import test from "node:test";

import { PLAN_SELF_WAIT_BUDGET_MS, PLAN_SELF_WAIT_HOLD_MS } from "./body-program-script.js";
import { waitForTerminalProgramStatus } from "./program-status-wait.js";

/**
 * THE BOUND THAT DECIDED WITHOUT KNOWING WHETHER THE PLAN WAS WORKING.
 *
 * <p>
 * Measured across 49 holds in `round94`/`round95`: nine spent the whole `PLAN_SELF_WAIT_BUDGET_MS` and came back
 * `in_flight_not_done` - about 55 s of waiting that bought nothing - while the median hold was 1,686 ms. Their own
 * program traces say what they were: `move_to_tile` at 7,925 and 9,285 ms, `ship_item` at 22,195, `navigate` at 54,623,
 * 19,400 and 10,992, `refill_watering_can` at 6,865, and `sleep` at 174,400 and 328,317. All nine crossed the bound, all
 * nine had `snapshotChanged: true` for the whole hold, and all nine published a terminal state afterwards - so none was
 * a stuck node and every one of them was working while the wait gave up.
 * </p>
 *
 * <p>
 * THE ARITHMETIC THAT MADE IT POSSIBLE: the bound was derived from the plan's NODE COUNT (`planSelfWaitDecision`, one
 * node = 629 ms predicted) against the 6,000 ms budget, so between nine and ten nodes was the whole question and the
 * action itself never entered it - `plan_471`'s `move_to_tile` was predicted at 1,258 ms and `plan_70`'s `sleep` ran
 * for 174 s. A duration cannot be right for both, and no duration is needed: what the wait can see is whether the plan
 * is publishing WORK or publishing noise.
 * </p>
 *
 * <p>
 * SO THE WAIT HAS TWO BOUNDS AND THIS FILE IS THE SECOND ONE. A number is a duration the caller named. A
 * `ProgramStatusSilenceBound` ends when the plan has SETTLED NO NODE for the window, and every node that reaches a
 * settled state starts a fresh one - so a plan that is getting through its work keeps its turn, and one that has stopped
 * getting through it hands the turn back within the window. The three tests below are the two halves of that rule and the
 * thing that would otherwise make it unbounded, and the first one carries the RED reading: the same reads, driven by the
 * duration the tool uses today, expire six seconds in.
 * </p>
 */

/** A fake clock, so the wait's own timing is asserted rather than slept through. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

/** One node a second, forty of them: the shape the measured `move_to_tile`/`ship_item` holds were made of. */
const NODES = 40;
const NODE_PER_SECOND_MS = 1_000;

/**
 * The plan at simulated time `atMs`: node `n` settles at `n` seconds, the one after it is `running`, the rest are
 * `pending`, and the plan itself is `active` until the last one lands.
 */
function fortyNodePlan(atMs: number) {
  const settledBy = Math.floor(atMs / NODE_PER_SECOND_MS);
  return Object.freeze({
    code: "found",
    snapshot: Object.freeze({
      programId: "plan_forty",
      state: settledBy >= NODES ? "succeeded" : "active",
      nodes: Array.from({ length: NODES }, (_, index) =>
        Object.freeze({
          nodeId: `n${String(index + 1)}`,
          actionId: "move_to_tile",
          state: index < settledBy ? "succeeded" : index === settledBy ? "running" : "pending",
        }),
      ),
    }),
  });
}

test("a plan that settles a node a second keeps its turn for forty seconds; the same reads under a duration expire at six", async () => {
  const clock = fakeClock();
  const held = await waitForTerminalProgramStatus(
    async () => fortyNodePlan(clock.now()),
    fortyNodePlan(0),
    { silenceMs: PLAN_SELF_WAIT_BUDGET_MS, holdMs: PLAN_SELF_WAIT_HOLD_MS },
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(held.waited.terminality, "terminal", `returned at ${String(clock.now())} ms without the settlement`);
  assert.ok(
    clock.now() >= NODES * NODE_PER_SECOND_MS,
    `the plan settles at ${String(NODES * NODE_PER_SECOND_MS)} ms and the wait returned at ${String(clock.now())}`,
  );
  assert.equal(
    held.waited.settledWhileHeld,
    NODES,
    "every node that settled while the call held the turn is counted, and each one bought a window",
  );
  // WHAT MAKES THE HOLD FINITE IS THE TOTAL, not the count of settlements: a hold lasts at most `holdMs` however many
  // steps finish. One window per settlement would be a node allowance - `nodeCount x a constant` under another name - and
  // the total is deliberately not that.
  assert.ok(
    clock.now() <= PLAN_SELF_WAIT_HOLD_MS,
    `held ${String(clock.now())} ms on ${String(held.waited.settledWhileHeld)} settlements, past the ` +
      `${String(PLAN_SELF_WAIT_HOLD_MS)} ms total`,
  );
  assert.equal(held.waited.cutByHoldCeiling, false, "the plan settled inside the total, so nothing was cut");

  // THE RED READING, on the same reads and the same clock: a DURATION has no way to notice that the plan is working, so
  // it comes back six seconds in with a plan that had thirty-four nodes still to run.
  const expiredClock = fakeClock();
  const expired = await waitForTerminalProgramStatus(
    async () => fortyNodePlan(expiredClock.now()),
    fortyNodePlan(0),
    PLAN_SELF_WAIT_BUDGET_MS,
    expiredClock.now,
    async (milliseconds) => expiredClock.advance(milliseconds),
  );
  assert.equal(
    expired.waited.terminality,
    "active",
    "the duration-less rule is not the one under test if it settled here",
  );
  assert.ok(
    expiredClock.now() <= PLAN_SELF_WAIT_BUDGET_MS + 1_000,
    `the fixed bound should stop at ${String(PLAN_SELF_WAIT_BUDGET_MS)} ms, not ${String(expiredClock.now())}`,
  );
  process.stdout.write(
    `\na_plan_that_is_working_keeps_its_turn: ${String(NODES)} nodes at one a second · held ` +
      `${String(clock.now())} ms on ${String(held.waited.settledWhileHeld)} settlements · the same reads under a ` +
      `${String(PLAN_SELF_WAIT_BUDGET_MS)} ms duration returned at ${String(expiredClock.now())} ms with ` +
      `${String(NODES - Math.floor(expiredClock.now() / NODE_PER_SECOND_MS))} nodes unrun\n`,
  );
});

/**
 * The other half: a plan that settles NOTHING for the window is handed back - but handed back saying what it is on.
 *
 * `n1` is already settled in `first`, which is why it buys no window: the renewal is a node that reaches a settled state
 * WHILE the call holds the turn, so a plan cannot open with its own history. What the answer carries is the block
 * `round94`'s nine were missing (`unsettled`), and the count that says the hold was spent rather than earned.
 */
test("a plan that settles nothing for the window is handed back with the node it is on and what would end it", async () => {
  const clock = fakeClock();
  const quiet = () =>
    Object.freeze({
      code: "found",
      snapshot: Object.freeze({
        programId: "plan_quiet",
        state: "active",
        stopEpoch: 3,
        nodes: Object.freeze([
          Object.freeze({ nodeId: "n1", actionId: "till_soil", state: "succeeded", x: 5, y: 8 }),
          Object.freeze({ nodeId: "n2", actionId: "move_to_tile", state: "running", x: 9, y: 8 }),
          Object.freeze({ nodeId: "n3", actionId: "water_crop", state: "pending", x: 9, y: 9 }),
        ]),
      }),
    });
  const outcome = await waitForTerminalProgramStatus(
    async () => quiet(),
    quiet(),
    { silenceMs: PLAN_SELF_WAIT_BUDGET_MS, holdMs: PLAN_SELF_WAIT_HOLD_MS },
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.terminality, "active");
  assert.equal(clock.now(), PLAN_SELF_WAIT_BUDGET_MS, "one silent window, and then the turn comes back");
  assert.equal(
    outcome.waited.settledWhileHeld,
    0,
    "n1 was settled before the call began, so it bought no window and the hold was spent rather than earned",
  );
  assert.deepEqual(
    outcome.waited.unsettled,
    {
      programId: "plan_quiet",
      node: { nodeId: "n2", actionId: "move_to_tile", state: "running" },
      settlesWith: "node_receipt",
    },
    "the answer names the plan, the node it is waiting on and the publication that ends it",
  );
  process.stdout.write(
    `\na_quiet_plan_hands_the_turn_back: silent ${String(clock.now())} ms · unsettled ` +
      `${JSON.stringify(outcome.waited.unsettled)}\n`,
  );
});

/**
 * THE FLOOR ON THE RENEWAL, and the reason it is a settlement rather than a publication.
 *
 * A plan that republishes something every 900 ms - a node re-queued, a row re-stamped, a dispatch that has not produced
 * a receipt - is not making progress and must not keep her turn. The renewal is keyed on a node reaching a settled state,
 * which is monotone and cannot exceed the plan's node count; keying it on "the frame differed" would let one long node
 * hold indefinitely, which is the defect this whole file is about with the sign flipped.
 */
test("a plan that republishes without settling a node buys itself no further window", async () => {
  const clock = fakeClock();
  const churning = (atMs: number) =>
    Object.freeze({
      code: "found",
      snapshot: Object.freeze({
        programId: "plan_churn",
        state: "active",
        nodes: Object.freeze([
          Object.freeze({
            nodeId: "n1",
            actionId: "enter_exit",
            state: Math.floor(atMs / 900) % 2 === 0 ? "pending" : "awaiting_host_admission",
          }),
        ]),
      }),
    });
  const outcome = await waitForTerminalProgramStatus(
    async () => churning(clock.now()),
    churning(0),
    { silenceMs: PLAN_SELF_WAIT_BUDGET_MS, holdMs: PLAN_SELF_WAIT_HOLD_MS },
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.snapshotChanged, true, "the journal did publish, so this is not the quiet case");
  assert.equal(outcome.waited.settledWhileHeld, 0, "and none of it settled a node");
  assert.equal(
    clock.now(),
    PLAN_SELF_WAIT_BUDGET_MS,
    `a plan publishing every 900 ms held the turn ${String(clock.now())} ms, which is not a silence window`,
  );
  process.stdout.write(
    `\na_publishing_plan_that_settles_nothing_is_not_progress: published every 900 ms for ${String(clock.now())} ms · ` +
      `settlements ${String(outcome.waited.settledWhileHeld)}\n`,
  );
});
