import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PLAN_SELF_WAIT_BUDGET_MS, PLAN_SELF_WAIT_HOLD_MS } from "./body-program-script.js";
import {
  PLAN_SELF_WAIT_REASON,
  planSelfWaitDecision,
} from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import { MAX_PROGRAM_STATUS_WAIT_MS, waitForTerminalProgramStatus } from "./program-status-wait.js";
import { readSourceShape } from "./test-support/source-shape.test-support.js";
import { ROOT } from "./wire-declaration.test-support.js";

/**
 * `a_plan_that_fits_in_a_turn_is_not_split_by_the_turn:<plan>`.
 *
 * <p>
 * THE DEFECT THIS MEASURES. A `plan_work` call used to return the moment the Mod accepted, so a two-node plan that
 * finished in two seconds still ended the turn: the outcome came back as a NEW turn, behind a fresh `auto_observe` and a
 * fresh snapshot, to learn what the call could have answered. Measured 2026-11-20 (`round84`): 33 of 59 programmes were
 * 1-3 nodes and a plan executes in 1-4 s, while one model turn cost a median 6.18 s to decide and 10.1 s to deliver -
 * so `1,265.2 s` of that run's `1,702.7 s` between programmes was the turn boundary itself.
 * </p>
 *
 * <p>
 * THE SECOND DEFECT, AND WHY THIS FILE NO LONGER DERIVES A THRESHOLD. The first rule held a plan whose NODE COUNT times
 * the recorded per-node pace (629 ms) fitted a 6,000 ms budget - nine nodes - and answered a tenth on acceptance. A node
 * count is a statement about how fast nodes settle on average, not about whether THIS plan is moving: measured
 * `round94`/`round95`, nine of 49 holds spent the whole 6,000 ms and came back `in_flight_not_done`, every one of them on
 * a plan whose single dispatched node was still `running` and settled later (6.9 s `refill_watering_can`, 174 s and 328 s
 * `sleep`, 55 s `navigate_to_destination`). So the rule no longer asks how big the plan is: every plan is held, the
 * window is renewed by a step that FINISHES (`PLAN_SELF_WAIT_BUDGET_MS`), and the total a renewal cannot cross is a
 * number of its own (`PLAN_SELF_WAIT_HOLD_MS`).
 * </p>
 *
 * <p>
 * THE PACE SURVIVES AS A READING, NOT AS A KNOB. `round84`'s median per-node time is re-derived below from the fixture's
 * own rows, because it is what makes the six-second window the right order of magnitude (a node is ~0.6 s) - and it is
 * deliberately not divided into anything: one window per node written is the node allowance this file exists to keep out,
 * wearing a ceiling's clothes.
 * </p>
 *
 * <p>
 * WHAT IT DOES NOT MEASURE, said rather than implied: `spanMs` is the work's own duration, not the wall time a wait would
 * have held, and the fixture carries no per-node timestamps, so "this programme would have been held to its end" is read
 * off its total span against the CEILING and not off its renewals. The live confirmation is a later run in this tree.
 * </p>
 */

type Programme = Readonly<{
  programId: string;
  nodes: number;
  spanMs: number;
  continuedInTheSameTurn: boolean;
}>;

type Fixture = Readonly<{
  source: string;
  run: string;
  recorded: Readonly<{
    programmes: number;
    shorterThanWait: number;
    continuedInTheSameTurn: number;
    nodePaceMs: number;
  }>;
  programmes: readonly Programme[];
}>;

const ROUND84: Fixture = JSON.parse(
  readFileSync(join(ROOT, "host/src/test-fixtures/plan-self-wait-round84.json"), "utf8"),
) as Fixture;

/** The median of a list, so a fixture's own recorded reading can be re-derived rather than trusted. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** One programme's pair of facts, as the rule reads them. */
type Verdict = Readonly<{
  /** Programmes the rule holds. */
  held: number;
  /** Of those, the ones whose whole span fits inside the hold's TOTAL: nothing about them could reach the ceiling. */
  withinTheCeiling: number;
  /** Of those, the ones whose span outlasts the total: the population a ceiling cut would be made of. */
  outlastTheCeiling: number;
  /** Programmes whose outcome is in hand without a new turn afterwards. */
  continuedInTheSameTurn: number;
  report: string;
}>;

/**
 * The counts, over the population the rule itself selects.
 *
 * `decide` is the product's decision, not a copy of it: it defaults to `planSelfWaitDecision`, so a rule that stopped
 * holding plans moves every number here - and the falsifier below hands it a rule that holds nothing at all, which is the
 * behaviour this file exists to replace.
 */
function verdictOver(
  programmes: readonly Programme[],
  decide: typeof planSelfWaitDecision = planSelfWaitDecision,
): Verdict {
  let held = 0;
  let withinTheCeiling = 0;
  let outlastTheCeiling = 0;
  let continuedInTheSameTurn = 0;
  for (const programme of programmes) {
    const decision = decide(undefined);
    // A NAMED BOUND IS THE CALLER'S, NOT THIS READING'S: the population is what the rule does when nobody overrules it.
    const bound = decision.wait ? decision.bound : null;
    let heldHere = false;
    let withinTheCeilingHere = false;
    if (bound !== null) {
      held += 1;
      heldHere = true;
      // The total, from the bound the tool really passes: a duration the caller named is its own ceiling, and the
      // silence bound carries the product's.
      const ceilingMs = typeof bound === "number" ? bound : bound.holdMs;
      withinTheCeilingHere = programme.spanMs <= ceilingMs;
      if (withinTheCeilingHere) withinTheCeiling += 1;
      else outlastTheCeiling += 1;
    }
    // A wait that settles puts the outcome in this turn; the run's own continuations are the programmes where a turn
    // already carried on, and neither may be counted twice for one programme.
    if (programme.continuedInTheSameTurn || (heldHere && withinTheCeilingHere)) continuedInTheSameTurn += 1;
  }
  return Object.freeze({
    held,
    withinTheCeiling,
    outlastTheCeiling,
    continuedInTheSameTurn,
    report:
      `a_plan_that_fits_in_a_turn_is_not_split_by_the_turn: source ${ROUND84.run} · ` +
      `programs ${String(programmes.length)} · held ${String(held)} · ` +
      `within-the-ceiling ${String(withinTheCeiling)} · outlast-the-ceiling ${String(outlastTheCeiling)} · ` +
      `continued-in-the-same-turn ${String(continuedInTheSameTurn)} · ` +
      `window ${String(PLAN_SELF_WAIT_BUDGET_MS)} ms · total ${String(PLAN_SELF_WAIT_HOLD_MS)} ms`,
  });
}

/**
 * THE TWO NUMBERS ARE TWO FACTS, and this is where they are held apart.
 *
 * The silence window is what RENEWS the hold, so it must be short enough that a plan which stopped getting through its
 * work hands the turn back quickly - `round94`'s median hold was 1,686 ms. The total is what BOUNDS it, so it must sit
 * well above any well-behaved plan or the cure is worse than the disease: measured 2026-11-24 (`round99`), a 26-node
 * programme ran 21.4 s end to end, and the longest single action on record (`navigate_to_destination`) took 55 s. A total
 * above a minute is the assertion, and it is the reason a hold is not cut per node.
 */
test("a hold is renewed by a finished step and bounded by a total of its own, which no node count can shrink", () => {
  assert.equal(
    PLAN_SELF_WAIT_HOLD_MS,
    3 * MAX_PROGRAM_STATUS_WAIT_MS,
    "the total is three of the longest wait a caller may name, so it is stated as a multiple of one product number " +
      "rather than picked",
  );
  assert.ok(
    PLAN_SELF_WAIT_HOLD_MS > 60_000,
    `the total is ${String(PLAN_SELF_WAIT_HOLD_MS)} ms: a total under a minute cuts plans that are working ` +
      "(`round99`: a 26-node programme ran 21.4 s)",
  );
  assert.ok(
    PLAN_SELF_WAIT_HOLD_MS > 4 * 21_400,
    "the total must sit well above the longest multi-node programme on record, not just above a minute",
  );
  assert.ok(
    PLAN_SELF_WAIT_HOLD_MS >= 2 * PLAN_SELF_WAIT_BUDGET_MS,
    "and a renewal must be able to buy more than one window, or the total is the window under another name",
  );
  // THE RULE CANNOT SEE THE PLAN. A one-parameter decision has no node count to divide by, so the per-node allowance
  // cannot come back without changing the signature this line reads. Read through the shape reader: these are claims
  // about the decision's SOURCE, and a reformat is not a change to it.
  const { shape: source } = readSourceShape(
    join(
      ROOT,
      "host/src/continuity-semantic-game-runtime-materializer",
      "continuity-semantic-game-runtime-materializer.ts",
    ),
  );
  assert.match(
    source,
    /export function planSelfWaitDecision\(requestedWaitMs: number \| undefined\)/u,
    "the rule takes the caller's bound and nothing else",
  );
  assert.doesNotMatch(
    source,
    /prediction is the node count|predicted [0-9]+ ms|plan_outlasts_the_wait_bound/u,
    "the node-count prediction and its refusal are gone, not left beside the new rule",
  );
});

test("round84's own pace survives as the reading behind the window, and is no longer divided into a threshold", () => {
  const perNode = ROUND84.programmes.map((programme) => programme.spanMs / programme.nodes);
  assert.equal(
    median(perNode),
    ROUND84.recorded.nodePaceMs,
    `the pace is this run's own median per-node time, re-derived from its rows: the fixture records ` +
      `${String(ROUND84.recorded.nodePaceMs)} ms per node`,
  );
  // WHY IT IS STILL HERE: ten nodes' worth of work is one window, so a six-second window is the right order of magnitude
  // for a plan that is moving. It is a CROSS-CHECK on the window and not an input to anything.
  assert.ok(
    PLAN_SELF_WAIT_BUDGET_MS >= 5 * ROUND84.recorded.nodePaceMs,
    `the window is ${String(PLAN_SELF_WAIT_BUDGET_MS)} ms against a ${String(ROUND84.recorded.nodePaceMs)} ms node, ` +
      "so a plan that is moving settles several steps inside one window",
  );
});

test("every plan this run submitted is held, and the total is what could cut one", () => {
  const verdict = verdictOver(ROUND84.programmes);
  assert.equal(
    ROUND84.programmes.length,
    ROUND84.recorded.programmes,
    `the fixture's own programme count disagrees with its rows: ${verdict.report}`,
  );
  // THE POPULATION IS EVERY PROGRAMME, which is the whole difference from the rule this replaced: no plan is answered on
  // acceptance because of how many nodes it wrote.
  assert.equal(verdict.held, ROUND84.programmes.length, `the rule holds ${String(verdict.held)}: ${verdict.report}`);
  assert.ok(verdict.held > 0, `blocked: no programme was held, so this gate examined nothing: ${verdict.report}`);
  // AND NOTHING IN THIS RUN REACHES THE TOTAL: every span is inside it, so the ceiling is not what would have ended any
  // of these holds - the silence window or the settlement is.
  assert.equal(
    verdict.outlastTheCeiling,
    0,
    `a programme outlasted the hold's total, so the ceiling is cutting work this run actually did: ${verdict.report}`,
  );
  assert.equal(verdict.withinTheCeiling, ROUND84.programmes.length, verdict.report);
  // C MUST RISE, and the baseline it rises from is the run's own: nine programmes carried on in the same turn because
  // something else kept her there, none because the call she had made answered.
  assert.ok(
    verdict.continuedInTheSameTurn > ROUND84.recorded.continuedInTheSameTurn,
    `holding every plan did not put any outcome in the turn it was called from: ${verdict.report}`,
  );
  // Printed on every run: the numbers the change is supposed to move, with the two bounds beside them.
  process.stdout.write(`\n${verdict.report}\n`);
});

/**
 * THE RED CASE, DRIVEN THROUGH THE GATE'S OWN COUNTING: the rule this file replaces.
 *
 * Before this change nothing was held unless the caller named a bound, so the same-turn count was exactly the run's own
 * nine - and every one of those nine was a further tool call rather than an outcome. The rule is injected here as a
 * decision function, so the numbers come from the same code that produces the verdict above; if this file's gate ever
 * stopped reading what it claims to read, this arm would go green with it and say so.
 */
test("the pre-change rule - nothing held unless asked - is RED on this run's own programmes", () => {
  const preChange: typeof planSelfWaitDecision = () =>
    Object.freeze({ wait: false, reasonCode: PLAN_SELF_WAIT_REASON.callerAskedNever });
  const before = verdictOver(ROUND84.programmes, preChange);
  assert.equal(before.held, 0, "nothing was held, so nothing was settled by a hold");
  assert.equal(
    before.continuedInTheSameTurn,
    ROUND84.recorded.continuedInTheSameTurn,
    `the same-turn count is the run's own, so the gate's "must rise" line fails on exactly this rule: ${before.report}`,
  );
  assert.equal(
    before.continuedInTheSameTurn > ROUND84.recorded.continuedInTheSameTurn,
    false,
    "this is the assertion the gate makes, and the pre-change rule is what makes it red",
  );
});

/**
 * THE RULE AS THE TOOL RUNS IT: what the caller passes, and what the rule does with it.
 *
 * Both directions are the caller's, and neither is the plan's: `0` is how a caller about to stop or redirect keeps the
 * turn free, and a named duration is a deadline the caller wrote - a NUMBER, so nothing renews it and there is no ceiling
 * to report. The default is the silence bound, with both of its numbers.
 */
test("a caller's own bound is a duration and the default is the silence bound", () => {
  assert.deepEqual(
    planSelfWaitDecision(undefined),
    { wait: true, bound: { silenceMs: PLAN_SELF_WAIT_BUDGET_MS, holdMs: PLAN_SELF_WAIT_HOLD_MS } },
    "with no bound from the caller, the rule holds the turn on the plan's own silence, renewing inside a total",
  );
  assert.deepEqual(
    planSelfWaitDecision(0),
    { wait: false, reasonCode: PLAN_SELF_WAIT_REASON.callerAskedNever },
    "`waitMs: 0` never holds the turn, and the answer says the caller asked for that",
  );
  assert.deepEqual(planSelfWaitDecision(250), { wait: true, bound: 250 }, "a named bound is that many milliseconds");
  const ceiled = planSelfWaitDecision(90_000);
  assert.equal(
    ceiled.wait ? ceiled.bound : null,
    MAX_PROGRAM_STATUS_WAIT_MS,
    "a caller cannot ask for more than the wire's own maximum",
  );
});

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

/** The plan at simulated time `atMs`: node `n` settles at `n` seconds, the one after it is `running`. */
function planOfSize(nodes: number, atMs: number) {
  const settledBy = Math.floor(atMs / 1_000);
  const stateOf = (index: number): string => {
    if (index < settledBy) return "succeeded";
    return index === settledBy ? "running" : "pending";
  };
  return Object.freeze({
    code: "found",
    snapshot: Object.freeze({
      programId: `plan_${String(nodes)}`,
      state: settledBy >= nodes ? "succeeded" : "active",
      nodes: Array.from({ length: nodes }, (_, index) =>
        Object.freeze({ nodeId: `n${String(index + 1)}`, actionId: "move_to_tile", state: stateOf(index) }),
      ),
    }),
  });
}

/** The bound the tool passes when the caller names nothing. */
const PRODUCT_BOUND = Object.freeze({ silenceMs: PLAN_SELF_WAIT_BUDGET_MS, holdMs: PLAN_SELF_WAIT_HOLD_MS });

/**
 * ④ THE HOLD, AS THE TOOL NOW PASSES IT: a forty-node plan settling one node a second is held to its end.
 *
 * <p>
 * RED UNDER THE RULE THIS REPLACES, and that is the assertion, not a note: the same reads driven by the number a
 * ten-node plan used to be answered with come back six seconds in, with thirty-four nodes still to run. A node count
 * cannot be right for both a `move_to_tile` and a `sleep`, and this is the plan that says so.
 * </p>
 */
test("a forty-node plan settling one node a second is held to completion, which the old bound could not do", async () => {
  const clock = fakeClock();
  const held = await waitForTerminalProgramStatus(
    async () => planOfSize(40, clock.now()),
    planOfSize(40, 0),
    PRODUCT_BOUND,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(held.waited.terminality, "terminal", `returned at ${String(clock.now())} ms without the settlement`);
  assert.ok(clock.now() >= 40_000, `the plan settles at 40,000 ms and the wait returned at ${String(clock.now())}`);
  assert.equal(held.waited.settledWhileHeld, 40, "every finished step bought the hold another window");
  assert.equal(held.waited.cutByHoldCeiling, false, "and the total was never reached, so nothing was cut");

  // THE SAME READS UNDER THE NUMBER THE OLD RULE PASSED: it has no way to notice that the plan is working.
  const oldClock = fakeClock();
  const old = await waitForTerminalProgramStatus(
    async () => planOfSize(40, oldClock.now()),
    planOfSize(40, 0),
    PLAN_SELF_WAIT_BUDGET_MS,
    oldClock.now,
    async (milliseconds) => oldClock.advance(milliseconds),
  );
  assert.equal(old.waited.terminality, "active", "the duration is not the rule under test if it settled here");
  assert.equal(
    oldClock.now(),
    PLAN_SELF_WAIT_BUDGET_MS,
    `the fixed duration ends at ${String(PLAN_SELF_WAIT_BUDGET_MS)} ms whatever the plan is doing`,
  );
  process.stdout.write(
    `\na_plan_that_is_working_keeps_its_turn: 40 nodes at one a second · held ${String(clock.now())} ms on ` +
      `${String(held.waited.settledWhileHeld)} settled steps · the old ${String(PLAN_SELF_WAIT_BUDGET_MS)} ms ` +
      `duration returned at ${String(oldClock.now())} ms with ${String(40 - Math.floor(oldClock.now() / 1_000))} ` +
      "nodes unrun\n",
  );
});

/**
 * ④ THE CEILING, AND IT IS NOT A FAILURE: a plan that keeps finishing steps forever is handed back at the total with the
 * progress it made - the step it is on, the count that bought the time, and a named reason.
 *
 * This is the case that produced the work: `round94`'s nine holds were cut at 6 s with nothing to show for it. A cut hold
 * here carries `unsettled` (the node and the publication that ends it), `settledWhileHeld` and the reason, so "wait
 * again" is a choice made against a fact.
 */
test("a plan that never stops settling is handed back at the total, with the step it is on and why", async () => {
  const clock = fakeClock();
  const outcome = await waitForTerminalProgramStatus(
    async () => planOfSize(1_000, clock.now()),
    planOfSize(1_000, 0),
    PRODUCT_BOUND,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.terminality, "active", "the plan is still moving, which is the point of the ceiling");
  assert.equal(outcome.waited.cutByHoldCeiling, true, "and the answer says the hold's total is what ended it");
  assert.ok(
    clock.now() >= PLAN_SELF_WAIT_HOLD_MS && clock.now() <= PLAN_SELF_WAIT_HOLD_MS + PLAN_SELF_WAIT_BUDGET_MS,
    `held ${String(clock.now())} ms against a total of ${String(PLAN_SELF_WAIT_HOLD_MS)} ms`,
  );
  assert.ok(
    outcome.waited.settledWhileHeld > 1,
    `a cut hold carries the progress that bought it its time, not a bare word: ${String(outcome.waited.settledWhileHeld)}`,
  );
  assert.equal(outcome.waited.unsettled?.programId, "plan_1000", "and it names the plan the caller submitted");
  assert.equal(
    outcome.waited.unsettled?.node?.nodeId,
    `n${String(Math.floor(clock.now() / 1_000) + 1)}`,
    "the node it stopped on is the one the journal has in flight, by the journal's own id",
  );
  assert.equal(outcome.waited.unsettled?.settlesWith, "node_receipt", "with the publication that would have ended it");
  process.stdout.write(
    `\na_plan_that_keeps_settling_is_cut_at_the_total: held ${String(clock.now())} ms · settled ` +
      `${String(outcome.waited.settledWhileHeld)} · on ${outcome.waited.unsettled?.node?.nodeId ?? "?"} · ` +
      `${String(PLAN_SELF_WAIT_HOLD_MS)} ms total\n`,
  );
});

/**
 * ④ THE OTHER BOUND: a plan that settles NOTHING for a window is handed back inside that window, naming the node.
 *
 * A single dispatched `sleep` settles nothing while it runs, so no settlement can renew the window - and the answer is the
 * block `round94`'s nine were missing rather than the word `in_flight_not_done`.
 */
test("a plan silent past the window ends inside it and names the step it is on", async () => {
  const clock = fakeClock();
  const silent = () =>
    Object.freeze({
      code: "found",
      snapshot: Object.freeze({
        programId: "plan_silent",
        state: "active",
        stopEpoch: 0,
        nodes: Object.freeze([
          Object.freeze({ nodeId: "n1", actionId: "sleep", state: "running", x: 64, y: 15 }),
          Object.freeze({ nodeId: "n2", actionId: "enter_exit", state: "pending", x: 65, y: 15 }),
        ]),
      }),
    });
  const outcome = await waitForTerminalProgramStatus(
    async () => silent(),
    silent(),
    PRODUCT_BOUND,
    clock.now,
    async (milliseconds) => clock.advance(milliseconds),
  );
  assert.equal(outcome.waited.terminality, "active");
  assert.equal(
    clock.now(),
    PLAN_SELF_WAIT_BUDGET_MS,
    `one silent window and the turn comes back: returned at ${String(clock.now())} ms`,
  );
  assert.equal(
    outcome.waited.cutByHoldCeiling,
    false,
    "the window ended this hold, not the total - the two are different facts and the answer keeps them apart",
  );
  assert.equal(outcome.waited.settledWhileHeld, 0, "nothing settled, so nothing renewed the window");
  assert.deepEqual(
    outcome.waited.unsettled,
    {
      programId: "plan_silent",
      node: { nodeId: "n1", actionId: "sleep", state: "running" },
      settlesWith: "node_receipt",
    },
    "the answer names the plan, the step it is on and the receipt that would have ended it",
  );
});
