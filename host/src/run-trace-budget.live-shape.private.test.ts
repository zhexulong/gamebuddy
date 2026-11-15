import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { attributeWaitBudget, RUN_BUDGET_FAMILIES, waitBudgetRows } from "./run-trace-budget.js";

/**
 * THE LIVE SHAPE: round62's own run, replayed through the budget the between-call spans feed.
 *
 * <p>
 * WHY THIS FILE EXISTS. The audit of round62 found the run's wall clock split four ways - provider 82.7 %, environment
 * 4.0 %, our code 0.2 %, and **13.1 % attributable to nothing** - and the longest stretch with no observable event was
 * 175.6 s while no single model call exceeded 21.5 s. The budget that was supposed to name that time existed, was
 * tested, and its live-shape test asserted the absence was correct. So the remainder was published as a number with no
 * owner.
 * </p>
 *
 * <p>
 * WHAT IS ASSERTED. The budget, given round62's real intervals plus the `wait.idle` spans the product's own activity
 * stream would have produced, must (a) close the wall clock exactly, (b) leave a remainder small enough to be the
 * run's two ENDS rather than its silent middle, and (c) name every family it did not measure. Nothing here is
 * synthesised except the `wait.idle` intervals themselves, which are re-derived from
 * `presentation.activity.points` - the same producer whose transitions the emitter publishes.
 * </p>
 *
 * <p>
 * THE FALSIFIER: strip the idle spans and re-attribute. The remainder jumps from 104.4 s to 270.4 s (13.1 %), which is
 * exactly the hole this unit was handed, and every bound below goes red.
 * </p>
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, "host", "src", "test-fixtures", "round62-time-partition.json"), "utf8"),
) as {
  provenance: Record<string, unknown>;
  wallMs: number;
  spans: readonly { name: string; startMs: number; endMs: number }[];
  expected: {
    accountedMs: number;
    unexplainedMs: number;
    providerMs: number;
    environmentMs: number;
    idleMs: number;
    idleIntervals: number;
    providerTurns: number;
    traceSpans: number;
  };
};

const budget = attributeWaitBudget(FIXTURE.spans, { wallMs: FIXTURE.wallMs });

/** The largest share of the run's wall clock the emitters may leave unowned: the run's two ends. */
const UNEXPLAINED_CEILING = 0.06;
/** Two measurements of the same interval, on two clocks, agree to better than this share. */
const TOLERANCE = 0.01;

const within = (actual: number, expected: number, tolerance = TOLERANCE): boolean =>
  Math.abs(actual - expected) <= Math.max(1, expected) * tolerance;

test("the fixture is round62's own run, not a shape written for this test", () => {
  assert.ok(FIXTURE.wallMs > 2_000_000 && FIXTURE.wallMs < 2_100_000, `wallMs ${String(FIXTURE.wallMs)}`);
  assert.equal(FIXTURE.expected.providerTurns, 203, "the run's own assistant-record count");
  assert.equal(FIXTURE.expected.traceSpans, 654, "the run's own trace, every span it emitted");
  assert.equal(FIXTURE.expected.idleIntervals, 4, "the four intervals the product's activity stream published");
  assert.ok(FIXTURE.spans.length > 850);
});

test("attributed time plus the named remainder IS the wall clock", () => {
  assert.equal(
    budget.accountedMs + budget.unexplainedMs,
    FIXTURE.wallMs,
    "the partition is exact: no span is dropped and none is counted twice",
  );
  assert.ok(within(budget.accountedMs, FIXTURE.expected.accountedMs), `accounted ${String(budget.accountedMs)}`);
});

test("the remainder is the run's two ends, not its silent middle", () => {
  // Red before this unit: 270.4 s (13.1 %). Green now: 104.4 s = the 24.3 s launch before the Host's first span, the
  // 56.0 s a batch sat in Pi's queue after the previous answer, and 4.1 s across six sub-second in-turn gaps.
  assert.ok(
    budget.unexplainedMs <= FIXTURE.wallMs * UNEXPLAINED_CEILING,
    `unexplained ${String(budget.unexplainedMs)} ms is ${((budget.unexplainedMs / FIXTURE.wallMs) * 100).toFixed(1)} % of the run; the ceiling is ${String(UNEXPLAINED_CEILING * 100)} %`,
  );
  assert.ok(
    within(budget.unexplainedMs, FIXTURE.expected.unexplainedMs),
    `unexplained ${String(budget.unexplainedMs)}`,
  );
  assert.ok(budget.covered > 0.94 && budget.covered < 1, `covered ${String(budget.covered)}`);
});

test("the falsifier: without the idle span the remainder is the hole this unit was handed", () => {
  const withoutIdle = attributeWaitBudget(
    FIXTURE.spans.filter((span) => span.name !== "wait.idle"),
    { wallMs: FIXTURE.wallMs },
  );

  assert.ok(
    withoutIdle.unexplainedMs > FIXTURE.wallMs * UNEXPLAINED_CEILING,
    `a trace without wait.idle must fail the ceiling, and ${String(withoutIdle.unexplainedMs)} ms does`,
  );
  // 10 ms of the idle family was already covered by another span, so the difference is the family MINUS that overlap.
  // Asserted as a tolerance rather than an equality because the equality was the assumption, not the measurement.
  assert.ok(
    within(withoutIdle.unexplainedMs - budget.unexplainedMs, FIXTURE.expected.idleMs, 0.001),
    `the difference is the idle family: ${String(withoutIdle.unexplainedMs - budget.unexplainedMs)} vs ${String(FIXTURE.expected.idleMs)}`,
  );
});

test("the idle family IS the silence the audit could not name", () => {
  assert.ok(within(budget.idleMs, FIXTURE.expected.idleMs), `idle ${String(budget.idleMs)}`);
  assert.ok(budget.idleMs / FIXTURE.wallMs > 0.08, `idle share ${String(budget.idleMs / FIXTURE.wallMs)}`);
});

test("the provider family is the run's own record, at the share the audit published", () => {
  // Not a Host span in this run: `message.durationMs` is Pi's. The budget reproduces the audit's 82.7 % from the same
  // windows, which is what makes the other buckets comparable to it.
  assert.ok(within(budget.modelMs, FIXTURE.expected.providerMs, 0.005), `model ${String(budget.modelMs)}`);
  assert.ok(budget.modelMs / FIXTURE.wallMs > 0.8 && budget.modelMs / FIXTURE.wallMs < 0.85);
});

test("the action family is the game's work plus the Host's own spans inside it", () => {
  assert.ok(
    budget.actionMs >= FIXTURE.expected.environmentMs,
    "every environment span the audit counted is in this family",
  );
  assert.ok(
    budget.actionMs - FIXTURE.expected.environmentMs < 10_000,
    "and it adds only the Host's own spans the audit called our code (5.2 s), not a whole bucket",
  );
});

test("every family this run did not measure is named, and no span of it is present", () => {
  const present = new Set(FIXTURE.spans.map((span) => span.name));
  for (const family of budget.unmeasured) {
    const declared = RUN_BUDGET_FAMILIES.find((entry) => entry.family === family);
    assert.ok(declared !== undefined, `${family} must be declared`);
    for (const name of declared.names) assert.equal(present.has(name), false, `${family} claims ${name} is absent`);
  }

  const measuredThese = ["model", "idle", "action"];
  for (const family of measuredThese) assert.equal(budget.unmeasured.includes(family), false, `${family} was measured`);
});

test("the rows are the report: every family, its share, and whether it was measured at all", () => {
  const rows = waitBudgetRows(budget);
  const byName = new Map(rows.map((row) => [row.name, row]));

  assert.equal(byName.get("unexplained")?.ms, budget.unexplainedMs);
  assert.equal(byName.get("prompt")?.notMeasured, true, "round62 ran before the prompt spans existed");
  assert.equal(byName.get("snapshot")?.notMeasured, true, "the Host never declared a reading stale in this run");
  assert.equal(byName.get("delivery")?.notMeasured, true);
  assert.equal(rows.reduce((sum, row) => sum + row.share, 0) > 0.99, true, "the shares describe the whole run");
});
