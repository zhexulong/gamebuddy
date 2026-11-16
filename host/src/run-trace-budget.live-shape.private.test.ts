import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { attributeWaitBudget, RUN_BUDGET_FAMILIES, waitBudgetReading, waitBudgetRows } from "./run-trace-budget.js";

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
 * THE OMISSION IS THE POINT OF THIS REVISION. The bundle's activity field is bounded at 512 points, and in this run that
 * limit dropped the tail: the bundle carries 166,069 ms of idle where the raw log published 222,064 ms. `droppedByPointLimit`
 * is that 55,995 ms, declared from the producer's own reading and passed to the budget as `omittedMs`. Without the
 * declaration the same 55,995 ms lands in `unexplainedMs`, and the six-percent ceiling below clears either way
 * (104,370 ms is 5.05 % of this run) - which is exactly why the ceiling is no longer the only assertion here. The
 * falsifier at the bottom re-attributes the same spans with the omission NOT declared and shows the gate going red.
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
  droppedByPointLimit: readonly { name: string; startMs: number; endMs: number }[];
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

/** The run time the activity point limit dropped, declared from the producer's own reading. */
const OMITTED_MS = FIXTURE.droppedByPointLimit.reduce((sum, span) => sum + (span.endMs - span.startMs), 0);

const budget = attributeWaitBudget(FIXTURE.spans, { wallMs: FIXTURE.wallMs, omittedMs: OMITTED_MS });

/** The largest share of the run's wall clock the emitters may leave unowned: the run's two ends. */
const UNEXPLAINED_CEILING = 0.06;
/** Two measurements of the same interval, on two clocks, agree to better than this share. */
const TOLERANCE = 0.01;

const within = (actual: number, expected: number, tolerance = TOLERANCE): boolean =>
  Math.abs(actual - expected) <= Math.max(1, expected) * tolerance;

/**
 * How much idle the producer published that this budget neither measured nor was told about.
 *
 * The single reading the ceiling cannot produce. `unexplainedMs` is a share of the run, and the 55,995 ms this unit is
 * about slides under a six-percent ceiling in either direction (104,370 ms is 5.05 % of this run) - a percentage cannot
 * see WHICH time is missing. The activity stream's own total can: idle the run published, minus the idle a span covers,
 * minus the idle the caller declared it could not carry, is either zero or a hole somebody has to name.
 */
function unmeasuredIdleMs(candidate: typeof budget): number {
  return Math.max(0, FIXTURE.expected.idleMs - (candidate.idleMs + candidate.omittedMs));
}

test("the fixture is round62's own run, not a shape written for this test", () => {
  assert.ok(FIXTURE.wallMs > 2_000_000 && FIXTURE.wallMs < 2_100_000, `wallMs ${String(FIXTURE.wallMs)}`);
  assert.equal(FIXTURE.expected.providerTurns, 203, "the run's own assistant-record count");
  assert.equal(FIXTURE.expected.traceSpans, 654, "the run's own trace, every span it emitted");
  assert.equal(FIXTURE.expected.idleIntervals, 4, "the four intervals the product's activity stream published");
  assert.ok(FIXTURE.spans.length > 850);
  assert.ok(OMITTED_MS > 0, "the point limit dropped run time in this run, and the fixture carries it");
  assert.equal(
    FIXTURE.expected.idleMs -
      FIXTURE.spans.filter((span) => span.name === "wait.idle").reduce((sum, s) => sum + (s.endMs - s.startMs), 0),
    OMITTED_MS,
    "the dropped interval IS the difference between the raw log's idle and the bundle's: the fixture cannot carry a duration that explains nothing",
  );
});

test("attributed time plus the declared omission plus the named remainder IS the wall clock", () => {
  assert.equal(
    budget.accountedMs + budget.omittedMs + budget.unexplainedMs,
    FIXTURE.wallMs,
    "the partition is exact: no span is dropped, none is counted twice, and the declared omission has an owner",
  );
  // The independent union, computed over the fixture's own intervals, is what says the declared omission really is
  // 55,995 ms of this run: two numbers from two derivations, not one number written twice.
  assert.ok(
    within(budget.accountedMs + budget.omittedMs, FIXTURE.expected.accountedMs),
    `accounted ${String(budget.accountedMs)} + omitted ${String(budget.omittedMs)} vs union ${String(FIXTURE.expected.accountedMs)}`,
  );
});

test("the remainder is the run's two ends, not its silent middle", () => {
  // Red before this unit: 270.4 s (13.1 %), then 104.4 s while the point limit's 56 s hid inside it. Green now:
  // 48.4 s = the 24.3 s launch before the Host's first span, 4.1 s across six sub-second in-turn gaps, and the rest the
  // provider's own record does not reach.
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

test("the ceiling is computed over the measured spans plus the declared omission", () => {
  // The bound the run has to clear, with the dropped 56 s declared: 48,375 ms of unexplained time against the
  // 2,017,203 ms the spans and the declaration account for.
  assert.ok(
    budget.unexplainedMs <= UNEXPLAINED_CEILING * (budget.accountedMs + budget.omittedMs),
    `unexplained ${String(budget.unexplainedMs)} ms exceeds ${String(UNEXPLAINED_CEILING * (budget.accountedMs + budget.omittedMs))} ms of measured plus declared time`,
  );
  assert.equal(
    unmeasuredIdleMs(budget),
    0,
    "with the omission declared, every millisecond of idle the activity stream published has an owner",
  );
  assert.match(
    waitBudgetReading(budget),
    new RegExp(`omitted by the point limit: ${String(OMITTED_MS)} ms`, "u"),
    "the attribution summary carries what the point limit dropped, so a reader can compare it with the raw log",
  );
});

test("the falsifier: the same points, dropped and NOT declared, leave 56 s of published idle with no owner", () => {
  // The defect this revision exists for: 55,995 ms of published idle the bundle could not carry, and no declaration
  // saying so. It is worth being exact about what does NOT catch it: `unexplainedMs` simply absorbs the drop (104,370 ms
  // = 5.05 % of the run) and the six-percent ceiling clears the undeclared reading exactly as it clears the declared one.
  // A share of the run cannot tell which time was lost; the producer's own idle total can, and that is the gate.
  const undeclared = attributeWaitBudget(FIXTURE.spans, { wallMs: FIXTURE.wallMs });

  assert.equal(undeclared.omittedMs, 0, "nothing declared the drop");
  assert.ok(
    undeclared.unexplainedMs <= FIXTURE.wallMs * UNEXPLAINED_CEILING,
    "the bare ceiling still passes on the undeclared reading, which is why it is not the only assertion here",
  );
  assert.equal(
    unmeasuredIdleMs(undeclared),
    OMITTED_MS,
    "a run that dropped this idle without declaring it is exactly the dropped interval short of the activity stream's own total - and that shortfall is the failure",
  );
  assert.equal(
    unmeasuredIdleMs(undeclared) - unmeasuredIdleMs(budget),
    OMITTED_MS,
    "the difference between the two readings IS the dropped idle: one number, two spellings of the same 55,995 ms",
  );
  assert.ok(
    undeclared.unexplainedMs > budget.unexplainedMs,
    "and the drop lands in the remainder: the undeclared reading hides 56 s there, which is why the remainder alone cannot be read as the run's two ends",
  );
});

test("the falsifier: without the idle span the remainder is the hole this unit was handed", () => {
  const withoutIdle = attributeWaitBudget(
    FIXTURE.spans.filter((span) => span.name !== "wait.idle"),
    { wallMs: FIXTURE.wallMs, omittedMs: OMITTED_MS },
  );

  assert.ok(
    withoutIdle.unexplainedMs > FIXTURE.wallMs * UNEXPLAINED_CEILING,
    `a trace without wait.idle must fail the ceiling, and ${String(withoutIdle.unexplainedMs)} ms does`,
  );
  // 10 ms of the idle family was already covered by another span, so the difference is the family MINUS that overlap.
  // Asserted as a tolerance rather than an equality because the equality was the assumption, not the measurement.
  assert.ok(
    within(withoutIdle.unexplainedMs - budget.unexplainedMs, FIXTURE.expected.idleMs - OMITTED_MS, 0.001),
    `the difference is the bundle's own idle family: ${String(withoutIdle.unexplainedMs - budget.unexplainedMs)} vs ${String(FIXTURE.expected.idleMs - OMITTED_MS)}`,
  );
});

test("the idle family IS the silence the audit could not name", () => {
  assert.ok(within(budget.idleMs + budget.omittedMs, FIXTURE.expected.idleMs), `idle ${String(budget.idleMs)}`);
  assert.ok(
    (budget.idleMs + budget.omittedMs) / FIXTURE.wallMs > 0.08,
    `idle share ${String(budget.idleMs / FIXTURE.wallMs)}`,
  );
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

test("an omission larger than the run is refused rather than subtracted into a negative remainder", () => {
  assert.throws(
    () => attributeWaitBudget(FIXTURE.spans, { wallMs: FIXTURE.wallMs, omittedMs: FIXTURE.wallMs + 1 }),
    /invalid_wait_budget_omitted_ms/u,
  );
  assert.throws(
    () => attributeWaitBudget(FIXTURE.spans, { wallMs: FIXTURE.wallMs, omittedMs: -1 }),
    /invalid_wait_budget_omitted_ms/u,
  );
  assert.equal(
    attributeWaitBudget(FIXTURE.spans, { wallMs: FIXTURE.wallMs }).omittedMs,
    0,
    "a caller that declares nothing omits nothing, so the old reading is unchanged rather than silently assuming",
  );
});
