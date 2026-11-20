import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { MAX_PLAN_SELF_WAIT_NODES, PLAN_NODE_PACE_MS, PLAN_SELF_WAIT_BUDGET_MS } from "./body-program-script.js";
import { planSelfWaitDecision } from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
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
 * THE POPULATION IS THE RUN. `round84`'s own `result.json` and `run-trace.json` give, per programme, its node count, its
 * span (the journal's first `atMs` to its last `settledAtMs`) and whether the model made another tool call before the
 * next delivery - the nine programmes where the turn already carried on. The rule under test is the product's own
 * (`planSelfWaitDecision`), driven here rather than re-implemented, so this gate moves with it and cannot disagree with
 * the tool.
 * </p>
 *
 * <p>
 * THE THRESHOLD IS DERIVED, AND THAT IS THE FIRST ASSERTION. `MAX_PLAN_SELF_WAIT_NODES` is
 * `floor(PLAN_SELF_WAIT_BUDGET_MS / PLAN_NODE_PACE_MS)` and the pace is this run's own median per-node time, so the
 * number of nodes a call will hold for is a reading of what the work cost rather than a count somebody picked. A
 * threshold written by hand would pass a gate that only asked "does some plan wait"; this one asks where the number
 * came from.
 * </p>
 *
 * <p>
 * WHAT IT DOES NOT MEASURE, said rather than implied: `spanMs` is the work's own duration, not the wall time a wait
 * would have held - a wait also carries the submit-to-first-dispatch gap, so `expired` below is a LOWER bound on the
 * waits that would have run out. The live confirmation is a later run in this tree; a projection over recorded spans is
 * what a gate can honestly assert today, and `W > E` is the line that keeps it honest as the pace drifts.
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

/** One programme's pair of facts, as the rule reads them. */
type Verdict = Readonly<{
  /** Programmes the rule holds, with the waiver it obeys. */
  waited: number;
  /** Of those, the ones whose recorded span proves the wait would have ended on a settlement. */
  waitedAndSettled: number;
  /** Of those, the ones whose recorded span outlasted the bound: the cost the prediction gets wrong. */
  expired: number;
  /** Programmes whose outcome is in hand without a new turn afterwards. */
  continuedInTheSameTurn: number;
  /** Programmes whose recorded span fits the budget: what a wait could have settled, independent of the rule. */
  shorterThanWait: number;
  report: string;
}>;

/**
 * The four counts, over the population the rule itself selects.
 *
 * `decide` is the product's decision, not a copy of it: it defaults to `planSelfWaitDecision`, so a rule that stopped
 * holding plans moves every number here - and the falsifier below hands it a rule that holds nothing at all, which is the
 * behaviour this file exists to replace.
 */
function verdictOver(
  programmes: readonly Programme[],
  decide: typeof planSelfWaitDecision = planSelfWaitDecision,
): Verdict {
  let waited = 0;
  let waitedAndSettled = 0;
  let expired = 0;
  let continuedInTheSameTurn = 0;
  let shorterThanWait = 0;
  for (const programme of programmes) {
    const decision = decide(programme.nodes, undefined);
    const fits = programme.spanMs <= PLAN_SELF_WAIT_BUDGET_MS;
    if (fits) shorterThanWait += 1;
    if (decision.wait) {
      waited += 1;
      if (fits) waitedAndSettled += 1;
      else expired += 1;
    }
    // A wait that settles puts the outcome in this turn; the run's own continuations are the programmes where a turn
    // already carried on, and neither may be counted twice for one programme.
    if (programme.continuedInTheSameTurn || (decision.wait && fits)) continuedInTheSameTurn += 1;
  }
  return Object.freeze({
    waited,
    waitedAndSettled,
    expired,
    continuedInTheSameTurn,
    shorterThanWait,
    report:
      `a_plan_that_fits_in_a_turn_is_not_split_by_the_turn: source ${ROUND84.run} · ` +
      `programs ${String(programmes.length)} · shorter-than-a-wait ${String(shorterThanWait)} · ` +
      `continued-in-the-same-turn ${String(continuedInTheSameTurn)} · waited-and-settled ${String(waitedAndSettled)} · ` +
      `waited ${String(waited)} · expired ${String(expired)} · threshold ${String(MAX_PLAN_SELF_WAIT_NODES)} nodes · ` +
      `pace ${String(PLAN_NODE_PACE_MS)} ms · budget ${String(PLAN_SELF_WAIT_BUDGET_MS)} ms`,
  });
}

test("the wait's threshold is the budget over this run's own per-node pace", () => {
  // A DERIVATION, NOT A NUMBER: the threshold is the budget divided by a measured pace, and the pace is this fixture's
  // own median so a re-measurement moves the product rather than leaving a constant behind.
  assert.equal(
    PLAN_NODE_PACE_MS,
    ROUND84.recorded.nodePaceMs,
    `the pace the threshold divides by is not the one ${ROUND84.run} measured: the fixture records ` +
      `${String(ROUND84.recorded.nodePaceMs)} ms per node`,
  );
  assert.equal(
    MAX_PLAN_SELF_WAIT_NODES,
    Math.floor(PLAN_SELF_WAIT_BUDGET_MS / PLAN_NODE_PACE_MS),
    "the threshold is derived from the budget and the pace; a hand-picked node count would be a second number that no " +
      "reading can contradict",
  );
  assert.ok(
    MAX_PLAN_SELF_WAIT_NODES > 0,
    "blocked: a zero threshold would hold no plan and this file would read green",
  );
});

test("a plan that outlasts the budget is declined, and says why", () => {
  // THE BOUNDARY, both sides of it, from the rule the tool runs.
  const inside = planSelfWaitDecision(MAX_PLAN_SELF_WAIT_NODES, undefined);
  assert.equal(inside.wait, true, "the largest plan that fits is held");
  assert.equal(inside.boundMs, PLAN_SELF_WAIT_BUDGET_MS, "for the budget, not for the status tool's 30 s cap");
  const past = planSelfWaitDecision(MAX_PLAN_SELF_WAIT_NODES + 1, undefined);
  assert.equal(past.wait, false, "one node past it is answered on acceptance");
  assert.equal(
    past.reasonCode,
    "plan_outlasts_the_wait_bound",
    "and the answer names the reason rather than leaving `waited: false` unexplained",
  );
  // The caller overrules the rule in both directions: `0` is the stop-the-plan escape, a bound is obeyed whatever fits.
  const neverAsked = planSelfWaitDecision(1, 0);
  assert.ok(!neverAsked.wait, "`waitMs: 0` never holds the turn");
  assert.equal(neverAsked.reasonCode, "caller_asked_never");
  assert.equal(planSelfWaitDecision(MAX_PLAN_SELF_WAIT_NODES + 1, 2_000).wait, true);
});

test("a_plan_that_fits_in_a_turn_is_not_split_by_the_turn", () => {
  const verdict = verdictOver(ROUND84.programmes);
  // The population is the run's own programmes, and the fixture's recorded totals are re-derived here rather than
  // trusted: a fixture edited to flatter the rule fails at the first assertion instead of passing quietly.
  assert.equal(
    verdict.shorterThanWait,
    ROUND84.recorded.shorterThanWait,
    `the population the budget covers is no longer what ${ROUND84.run} recorded: ${verdict.report}`,
  );
  assert.equal(
    ROUND84.programmes.length,
    ROUND84.recorded.programmes,
    `the fixture's own programme count disagrees with its rows: ${verdict.report}`,
  );
  assert.ok(verdict.waited > 0, `blocked: no programme was held, so this gate examined nothing: ${verdict.report}`);
  // C MUST RISE, and the baseline it rises from is the run's own: nine programmes carried on in the same turn because
  // something else kept her there, none because the call she had made answered.
  assert.ok(
    verdict.continuedInTheSameTurn > ROUND84.recorded.continuedInTheSameTurn,
    `holding a short plan did not put any outcome in the turn it was called from: ${verdict.report}`,
  );
  // S MUST BE WHAT IT WAS: the rule may not narrow the population it covers (it is written per programme, so a
  // threshold that drifted down would silently stop waiting for the plans the run actually produced).
  assert.equal(verdict.shorterThanWait, ROUND84.recorded.shorterThanWait, verdict.report);
  // The expiries are the cost of the prediction, and they stay the minority: if the pace drifts the wait starts
  // spending its bound more often than it settles, and THIS is the line that says so.
  assert.ok(
    verdict.waitedAndSettled > verdict.expired,
    `more waits would have expired than settled, so the threshold is predicting the wrong side: ${verdict.report}`,
  );
  // Printed on every run: the four numbers the change is supposed to move, with the derivation beside them.
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
  const preChange: typeof planSelfWaitDecision = (nodeCount) =>
    Object.freeze({
      wait: false,
      boundMs: 0,
      predictedMs: nodeCount * PLAN_NODE_PACE_MS,
      reasonCode: "plan_outlasts_the_wait_bound",
    });
  const before = verdictOver(ROUND84.programmes, preChange);
  assert.equal(before.waitedAndSettled, 0, "nothing was held, so nothing was settled by a hold");
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
