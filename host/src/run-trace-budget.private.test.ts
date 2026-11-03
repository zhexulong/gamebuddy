import assert from "node:assert/strict";
import test from "node:test";

import { RUN_SPAN_NAMES } from "./run-trace.js";
import { attributeWaitBudget, RUN_WAIT_NAMES, waitBudgetRows } from "./run-trace-budget.js";

/**
 * A run's wall clock has to be a partition, not a sample.
 *
 * The old cadence split a run into "exec" and "think" and the second one carried both the agent deciding
 * and the body being unavailable. One median over that mixture described neither.
 */

const span = (name: string, startMs: number, endMs: number | null) => ({ name, startMs, endMs });

test("the four parts plus the remainder add up to the wall clock", () => {
  const budget = attributeWaitBudget(
    [
      span(RUN_SPAN_NAMES.action, 0, 1_000),
      span(RUN_WAIT_NAMES.model, 1_000, 4_000),
      span(RUN_WAIT_NAMES.body, 4_000, 6_000),
      span(RUN_WAIT_NAMES.harness, 6_000, 6_500),
    ],
    { wallMs: 10_000 },
  );

  assert.equal(budget.actionMs, 1_000);
  assert.equal(budget.modelMs, 3_000);
  assert.equal(budget.bodyMs, 2_000);
  assert.equal(budget.harnessMs, 500);
  assert.equal(budget.unexplainedMs, 3_500, "the part no span covers is reported, not absorbed");
  assert.equal(budget.covered, 0.65);
  assert.equal(
    budget.actionMs + budget.modelMs + budget.bodyMs + budget.harnessMs + budget.unexplainedMs,
    budget.wallMs,
    "the partition is exact",
  );
});

test("nested spans are counted once, not once per level", () => {
  // `mod.execute` legitimately nests inside `action`; summing both would invent time.
  const budget = attributeWaitBudget([span(RUN_SPAN_NAMES.action, 0, 500), span(RUN_SPAN_NAMES.modExecute, 100, 300)], {
    wallMs: 500,
  });

  assert.equal(budget.actionMs, 500, "the union of the two spans is 500ms, not 700ms");
  assert.equal(budget.covered, 1);
});

test("a model wait and a body wait on the same run are told apart", () => {
  const budget = attributeWaitBudget(
    [span(RUN_WAIT_NAMES.model, 0, 30_000), span(RUN_WAIT_NAMES.body, 30_000, 90_000)],
    { wallMs: 90_000 },
  );

  const rows = waitBudgetRows(budget);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["wait.body", "wait.model", "action", "wait.harness", "unexplained"],
    "the larger share sorts first",
  );
  assert.equal(rows[0]!.ms, 60_000);
  assert.equal(rows[1]!.ms, 30_000);
  assert.ok(Math.abs(rows[0]!.share - 2 / 3) < 1e-9);
});

test("the remainder is never negative, even when spans overrun the window", () => {
  // A span that ends after the declared wall clock is a wiring fault, not permission to report negative time.
  const budget = attributeWaitBudget([span(RUN_WAIT_NAMES.model, 0, 20_000)], { wallMs: 10_000 });
  assert.equal(budget.unexplainedMs, 0);
  assert.equal(budget.covered, 1);
});

test("open spans are excluded rather than counted to the end of the run", () => {
  // A span with no end is a run that stopped mid-action, which is what a freeze looks like. Counting it
  // would turn "unknown" into "the model waited the whole run".
  const budget = attributeWaitBudget([span(RUN_WAIT_NAMES.model, 0, 1_000), span(RUN_SPAN_NAMES.action, 1_000, null)], {
    wallMs: 10_000,
  });

  assert.equal(budget.modelMs, 1_000);
  assert.equal(budget.actionMs, 0);
  assert.equal(budget.unexplainedMs, 9_000);
});

test("a wall clock of zero is refused, because it would divide the shares by nothing", () => {
  assert.throws(() => attributeWaitBudget([], { wallMs: 0 }), /invalid_wait_budget_wall_ms/u);
});
