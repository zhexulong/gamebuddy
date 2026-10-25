import assert from "node:assert/strict";
import test from "node:test";

import { attributeWaitBudget, RUN_WAIT_NAMES, waitBudgetRows } from "./run-trace-budget.js";

/**
 * The measurement this file exists for: a real run's budget, read from what a run already records.
 *
 * Until the wait spans are emitted by the product, a run's trace has only `action` and `mod.execute`.
 * Feeding that to the budget must produce an honest, LARGE `unexplained` share rather than a flattering
 * one - which is the property that makes the number worth publishing. If a run without wait spans came
 * back "fully covered", the budget would be measuring its own assumptions.
 */
test("a trace with no wait spans reports the wait as unexplained, not as covered", () => {
  const budget = attributeWaitBudget(
    [
      { name: "action", startMs: 0, endMs: 400 },
      { name: "mod.execute", startMs: 50, endMs: 300 },
    ],
    { wallMs: 60_000 },
  );

  assert.equal(budget.actionMs, 400);
  assert.equal(budget.modelMs, 0);
  assert.equal(budget.bodyMs, 0);
  assert.equal(budget.unexplainedMs, 59_600);
  assert.ok(budget.covered < 0.01, `a run whose waits are unmeasured must not look covered: ${budget.covered}`);
});

test("the rows name what is missing, so the next step is not a guess", () => {
  const budget = attributeWaitBudget([{ name: "action", startMs: 0, endMs: 1_000 }], { wallMs: 100_000 });
  const rows = waitBudgetRows(budget);

  assert.equal(rows[0]!.name, "unexplained");
  assert.equal(rows[0]!.ms, 99_000);
  assert.ok(
    rows.some((r) => r.name === RUN_WAIT_NAMES.model && r.ms === 0),
    "an absent wait is listed at zero rather than omitted",
  );
});
