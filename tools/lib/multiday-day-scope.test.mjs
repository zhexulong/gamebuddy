import assert from "node:assert/strict";
import test from "node:test";

import { createDayScope, dayScopeFrom, nightCrossedInScope } from "./multiday-day-scope.mjs";

/**
 * The predicate this module replaces, kept verbatim as the FALSIFIER.
 *
 * It is not dead code: each test below that describes the bug asserts this function answers wrongly,
 * so the new rule is proven to differ from the old one on the exact shape that broke the live run. If
 * the two ever agree on that shape, the fix has been reverted and these tests say so.
 */
function oldNightCrossed({ trace, clock }) {
  if (trace.some((entry) => entry.action === "advance_day" && entry.settledAtMs !== null)) return true;
  return clock.unknown !== true && Number.isInteger(clock.timeOfDay) && clock.timeOfDay <= 620;
}

const settled = { action: "advance_day", settledAtMs: 1_000 };
const running = { action: "advance_day", settledAtMs: null };
const clockAt = (timeOfDay) => ({ timeOfDay, unknown: false });
const UNREADABLE = { timeOfDay: null, unknown: true };

test("day 2 is not already over because day 1 slept", () => {
  // The live shape: day 1 dispatched advance_day, so the run's trace already holds it.
  const trace = [{ action: "till_soil", settledAtMs: 1 }, settled, { action: "cut_weeds", settledAtMs: 2 }];
  const dayTwoStart = trace.length;
  const scope = createDayScope({ dayOfMonth: 2, timeOfDay: 600, traceIndex: dayTwoStart });

  // The old predicate answers "crossed" before day 2 has run anything, which is why day 2 produced
  // no farm work and the baseline gate named `next_day_produced_no_farm_work`.
  assert.equal(oldNightCrossed({ trace, clock: clockAt(600) }), true);
  assert.equal(nightCrossedInScope({ scope, trace, clock: clockAt(600), dayOfMonth: 2 }), false);

  // One dispatch inside day 2's own slice does cross the night.
  const withDayTwoDispatch = [...trace, settled];
  assert.equal(nightCrossedInScope({ scope, trace: withDayTwoDispatch, clock: clockAt(2400), dayOfMonth: 2 }), true);
});

test("a fresh 06:00 morning is not a crossed night", () => {
  // Every multi-day morning resets the clock to 600 (`ModEntry.Fixtures.MultiDay.cs:184`), and the old
  // absolute threshold (`<= 620`) read that as "the night already happened".
  assert.equal(oldNightCrossed({ trace: [], clock: clockAt(600) }), true);
  const scope = createDayScope({ dayOfMonth: 3, timeOfDay: 600, traceIndex: 0 });
  assert.equal(nightCrossedInScope({ scope, trace: [], clock: clockAt(600), dayOfMonth: 3 }), false);
});

test("a rollover is the clock going backwards, and only that", () => {
  const scope = createDayScope({ dayOfMonth: 3, timeOfDay: 2500, traceIndex: 0 });

  // 2500 -> 600: the rollover the day loop must recognise even with no dispatch in the slice.
  assert.equal(nightCrossedInScope({ scope, trace: [], clock: clockAt(600), dayOfMonth: 3 }), true);

  // Forward movement inside the same day is not a rollover, however late it gets.
  assert.equal(nightCrossedInScope({ scope, trace: [], clock: clockAt(2600), dayOfMonth: 3 }), false);
  const morning = createDayScope({ dayOfMonth: 3, timeOfDay: 600, traceIndex: 0 });
  assert.equal(nightCrossedInScope({ scope: morning, trace: [], clock: clockAt(1200), dayOfMonth: 3 }), false);
  // The engine's clock only runs forward inside a day, so 2500 -> 1200 IS a rollover, not noon.
  assert.equal(nightCrossedInScope({ scope, trace: [], clock: clockAt(1200), dayOfMonth: 3 }), true);
});

test("a night dispatch that has not settled is not a crossed night", () => {
  const scope = createDayScope({ dayOfMonth: 1, timeOfDay: 1800, traceIndex: 0 });
  assert.equal(nightCrossedInScope({ scope, trace: [running], clock: clockAt(1810), dayOfMonth: 1 }), false);
  assert.equal(nightCrossedInScope({ scope, trace: [settled], clock: clockAt(1810), dayOfMonth: 1 }), true);
});

test("the calendar moving on its own crosses the night", () => {
  const scope = createDayScope({ dayOfMonth: 4, timeOfDay: null, traceIndex: 0 });
  assert.equal(nightCrossedInScope({ scope, trace: [], clock: UNREADABLE, dayOfMonth: 5 }), true);
  assert.equal(nightCrossedInScope({ scope, trace: [], clock: UNREADABLE, dayOfMonth: 4 }), false);
});

test("facts that cannot be read are absent, never defaulted", () => {
  // An unreadable clock must not become "the night is over" nor "the day has not started".
  const scope = dayScopeFrom({ clock: UNREADABLE, dayOfMonth: null, traceIndex: 7 });
  assert.equal(scope.timeOfDay, null);
  assert.equal(scope.dayOfMonth, null);
  assert.equal(scope.traceIndex, 7);
  assert.equal(nightCrossedInScope({ scope, trace: [settled], clock: UNREADABLE, dayOfMonth: null }), false);
  // …and an unknown clock is not a backwards clock.
  const evening = createDayScope({ dayOfMonth: 1, timeOfDay: 2500, traceIndex: 0 });
  assert.equal(nightCrossedInScope({ scope: evening, trace: [], clock: UNREADABLE, dayOfMonth: 1 }), false);
});

test("a scope's slice is what bounds the dispatch clause", () => {
  const beforeDay = [{ action: "advance_day", settledAtMs: 1 }];
  const scope = createDayScope({ dayOfMonth: 9, timeOfDay: 900, traceIndex: beforeDay.length });
  // No dispatch after the index: not crossed, even though the run holds one from earlier.
  assert.equal(nightCrossedInScope({ scope, trace: beforeDay, clock: clockAt(900), dayOfMonth: 9 }), false);
});
