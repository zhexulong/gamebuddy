import assert from "node:assert/strict";
import test from "node:test";

import { RUN_SPAN_NAMES } from "./run-trace.js";
import {
  attributeWaitBudget,
  budgetFamilyOf,
  RUN_BUDGET_FAMILIES,
  RUN_BUDGET_FAMILY_NAMES,
  RUN_WAIT_NAMES,
  waitBudgetRows,
} from "./run-trace-budget.js";

/**
 * A run's wall clock has to be a partition, not a sample.
 *
 * The old cadence split a run into "exec" and "think" and the second one carried both the agent deciding
 * and the body being unavailable. One median over that mixture described neither.
 */

const span = (name: string, startMs: number, endMs: number | null) => ({ name, startMs, endMs });

test("the parts plus the remainder add up to the wall clock", () => {
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
  assert.equal(budget.accountedMs, 6_500);
  assert.equal(budget.unexplainedMs, 3_500, "the part no span covers is reported, not absorbed");
  assert.equal(budget.covered, 0.65);
  assert.equal(budget.accountedMs + budget.unexplainedMs, budget.wallMs, "the partition is exact");
});

test("nested spans are counted once, not once per level", () => {
  // `mod.execute` legitimately nests inside `action`; summing both would invent time.
  const budget = attributeWaitBudget([span(RUN_SPAN_NAMES.action, 0, 500), span(RUN_SPAN_NAMES.modExecute, 100, 300)], {
    wallMs: 500,
  });

  assert.equal(budget.actionMs, 500, "the union of the two spans is 500ms, not 700ms");
  assert.equal(budget.covered, 1);
});

test("families are unioned, not summed", () => {
  // A turn's world-book selection happens INSIDE its delivery. Both are named steps with their own duration, and a
  // budget that added them would report 3.1s of time inside a 2.1s interval.
  const budget = attributeWaitBudget(
    [span(RUN_SPAN_NAMES.delivery, 900, 3_000), span(RUN_SPAN_NAMES.promptBlocks, 1_000, 2_000)],
    { wallMs: 3_000 },
  );

  assert.equal(budget.deliveryMs, 2_100);
  assert.equal(budget.promptMs, 1_000);
  assert.equal(budget.accountedMs, 2_100, "the union, not delivery + prompt");
  assert.equal(budget.unexplainedMs, 900);
});

test("a span name the declaration does not know is charged to action and named", () => {
  // A mounted tool the trace records by its own name (`stardew_plan_work`) is a tool the Host waited on. Keeping it
  // visible is what stops a new emitter from hiding inside the default.
  const budget = attributeWaitBudget([span("stardew_plan_work", 0, 2_500)], { wallMs: 10_000 });

  assert.equal(budget.actionMs, 2_500);
  assert.deepEqual(budget.defaultedToAction, ["stardew_plan_work"]);
});

test("a span outside the run's own window is not time the run had", () => {
  const budget = attributeWaitBudget([span(RUN_WAIT_NAMES.idle, 500, 1_500)], { wallMs: 5_000, wallStartMs: 1_000 });

  assert.equal(budget.idleMs, 500, "the window starts at 1000ms, so only the last 500ms belong to this run");
  assert.equal(budget.unexplainedMs, 4_500);
});

test("the rows name every family, largest share first, and the remainder last among equals", () => {
  const budget = attributeWaitBudget(
    [span(RUN_WAIT_NAMES.model, 0, 30_000), span(RUN_WAIT_NAMES.body, 30_000, 90_000)],
    { wallMs: 90_000 },
  );

  const rows = waitBudgetRows(budget);
  assert.deepEqual(
    rows.slice(0, 2).map((r) => r.name),
    ["body", "model"],
    "the larger share sorts first",
  );
  assert.equal(rows[0]!.ms, 60_000);
  assert.equal(rows[1]!.ms, 30_000);
  assert.ok(Math.abs(rows[0]!.share - 2 / 3) < 1e-9);
  assert.deepEqual(
    rows.map((r) => r.name).sort(),
    [...RUN_BUDGET_FAMILY_NAMES, "unexplained"].sort(),
    "every family appears, so an absent one is visible rather than omitted",
  );
});

test("an absent family is named as unmeasured, never rendered as a measured zero", () => {
  // THE ANTI-GATE THIS REPLACES: `run-trace-budget.live-shape.private.test.ts` used to assert that a `wait.model` row of
  // 0 ms was the correct reading of a run in which the model was 83% of the wall clock. A zero and an absence are
  // different facts, and a budget that prints them the same way cannot go red.
  const budget = attributeWaitBudget([span(RUN_SPAN_NAMES.action, 0, 1_000)], { wallMs: 60_000 });
  const rows = waitBudgetRows(budget);

  assert.deepEqual([...budget.unmeasured].sort(), [...RUN_BUDGET_FAMILY_NAMES].filter((f) => f !== "action").sort());
  for (const family of budget.unmeasured) {
    const row = rows.find((r) => r.name === family);
    assert.ok(row !== undefined, `the unmeasured family ${family} must still have a row`);
    assert.equal(row.notMeasured, true, `${family} was not measured by this trace and must say so`);
    assert.equal(row.ms, 0);
  }
  assert.equal(rows.find((r) => r.name === "action")?.notMeasured, false);
});

test("every declared span name belongs to exactly one budget family", () => {
  // Population from the declaration, not from this file's memory: a span name added to the taxonomy without a family
  // fails here by name, which is what stops a new emitter from becoming unattributed time.
  const declared = [...Object.values(RUN_SPAN_NAMES), ...Object.values(RUN_WAIT_NAMES)];
  const unknown = declared.filter((name) => budgetFamilyOf(name) === undefined);
  assert.deepEqual(unknown, [], `span names with no budget family: ${unknown.join(", ")}`);

  const counts = new Map<string, number>();
  for (const entry of RUN_BUDGET_FAMILIES) {
    for (const name of entry.names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const doubleClaimed = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  assert.deepEqual(doubleClaimed, [], `span names claimed by two families: ${doubleClaimed.join(", ")}`);
  assert.deepEqual(
    [...counts.keys()].sort(),
    [...declared].sort(),
    "the families and the taxonomy are the same population",
  );
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
