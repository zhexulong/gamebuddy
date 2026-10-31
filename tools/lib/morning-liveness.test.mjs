import assert from "node:assert/strict";
import { test } from "node:test";

import { assessMorningLiveness, MORNING_CLOCK_GRACE_MS } from "./morning-liveness.mjs";

/**
 * These cases are shaped from real runs, and the frozen one is the fifth occurrence of a deadlock that four commits
 * already tried to fix by asserting which owner or phase may commit the settlement sheet.
 *
 * 2026-10-31: the clock read 600 (a day had been opened), `menu=ShippingMenu`, and it never moved again. `time_milestone`
 * was zero for the whole run.
 * 2026-10-30 (`round8`, healthy): `day_5_0600` then `day_5_1200`.
 */

const fact = (kind, atMs, extra = {}) => ({
  type: "world_fact",
  worldFactKind: kind,
  worldFactPayload: { kind, ...extra },
  atMs,
});

test("a day whose clock never moves is a violation, named without guessing at the cause", () => {
  // The 2026-10-31 shape: the day opens, the run keeps going for half an hour, no milestone ever arrives because
  // `shouldTimePass()` returns false while the settlement menu stands.
  const facts = [
    fact("day_started", 1_000, { day: 6 }),
    fact("execution_receipt", 2_000, { actionId: "move_to_tile" }),
    fact("execution_receipt", 60_000, { actionId: "move_to_tile" }),
  ];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 1_000 + 30 * 60_000 });

  assert.deepEqual(verdict.violations, ["morning_clock_frozen:day=6"]);
  assert.equal(verdict.days.length, 1);
  assert.equal(verdict.days[0].witnessedAtMs, null);
});

test("a day whose clock moves is not a violation", () => {
  // The healthy shape: the morning milestone arrives 90 s after the day starts.
  const facts = [
    fact("day_started", 1_000, { day: 5 }),
    fact("time_milestone", 91_000, { formattedTime: "0600" }),
    fact("time_milestone", 400_000, { formattedTime: "1200" }),
  ];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 500_000 });

  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.days[0].milestone, "0600");
});

test("a marathon day does not need a milestone inside its first two minutes", () => {
  // The exemption is about observation, and this is the control that keeps it from becoming an excuse: a day that runs
  // for minutes before its first milestone is fine, because a milestone only fires at 06:00/12:00/18:00/22:00 - the
  // clock can be moving for hours without crossing one.
  const facts = [
    fact("day_started", 1_000, { day: 5 }),
    fact("time_milestone", 1_000 + 40 * 60_000, { formattedTime: "1200" }),
  ];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 3_000_000 });

  assert.deepEqual(verdict.violations, [], "a late milestone still witnesses the day");
});

test("the next day's milestone cannot witness this one", () => {
  // Without this, a run that froze its first morning and then took a second night would look healthy: the second day's
  // 06:00 milestone would be counted for the first. The span is bounded by the next `day_started`.
  const facts = [
    fact("day_started", 1_000, { day: 5 }),
    fact("day_started", 5_000_000, { day: 6 }),
    fact("time_milestone", 5_100_000, { formattedTime: "0600" }),
  ];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 2_000_000 });

  assert.deepEqual(
    verdict.violations,
    ["morning_clock_frozen:day=5"],
    "day 5 had five minutes of silence before day 6 opened, and day 6's milestone proves nothing about day 5",
  );
  assert.equal(verdict.days[1].milestone, "0600");
});

test("a run that ends moments into a morning has not tested it, and says so", () => {
  // The one exemption, and it must be visible in the record rather than silent: a run killed 20 s in cannot witness a
  // milestone, and calling that a pass would be the same "nothing observed reads as nothing wrong" defect the gate exists
  // to catch.
  const facts = [fact("day_started", 1_000, { day: 7 })];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 1_000 + 20_000 });

  assert.deepEqual(verdict.violations, []);
  assert.ok(verdict.days[0].observedForMs < MORNING_CLOCK_GRACE_MS);
  assert.equal(verdict.days[0].witnessedAtMs, null, "the silence is recorded, not hidden");
});

test("a fact log without timestamps cannot be judged, and does not pretend to be clean", () => {
  // `atMs` was added to `timeline.jsonl` in this same session. Older artifacts have none, and a gate that silently
  // reported zero violations for them would be the vacuous-gate failure this repository has already paid for twice.
  const verdict = assessMorningLiveness({
    facts: [{ worldFactKind: "day_started", worldFactPayload: { kind: "day_started" } }],
    endedAtMs: 10_000_000,
  });

  assert.deepEqual(verdict.violations, []);
  assert.deepEqual(verdict.days, []);
  assert.equal(verdict.observed, false, "unjudgeable input says so");
});
