import assert from "node:assert/strict";
import { test } from "node:test";

import { assessMorningLiveness, MORNING_CLOCK_GRACE_MS } from "./morning-liveness.mjs";

/**
 * These cases are shaped from real runs, and the frozen one is the fifth occurrence of a deadlock that four commits
 * already tried to fix by asserting which owner or phase may commit the settlement sheet.
 *
 * 2026-10-31: the clock read 600 (a day had been opened), `menu=ShippingMenu`, and it never moved again. `time_milestone`
 * was zero for the whole run.
 *
 * The fixtures carry the identity the Mod actually MINTS - `day_started_day_<TotalDays>` and
 * `time_milestone_day_<TotalDays>_<HHmm>` - rather than a payload field, because measured 2026-11-09 (`round41`) this
 * gate read a `worldFactPayload.day` the Mod has never published and reported `day: null` on all six of a run's
 * mornings while every violation message therefore named nothing.
 */

const dayStarted = (atMs, day) => ({
  type: "world_fact",
  atMs,
  eventId: `day_started_day_${day}`,
  sourceEventId: `day_started_day_${day}`,
  worldFactKind: "day_started",
  worldFactPayload: {
    eventId: `day_started_day_${day}`,
    kind: "day_started",
    payloadJson: JSON.stringify({ day }),
  },
});

const milestone = (atMs, hhmm, day) => ({
  type: "world_fact",
  atMs,
  eventId: `time_milestone_day_${day}_${hhmm}`,
  worldFactKind: "time_milestone",
  worldFactPayload: {
    eventId: `time_milestone_day_${day}_${hhmm}`,
    kind: "time_milestone",
    payloadJson: JSON.stringify({ milestone: hhmm }),
  },
});

const activity = (atMs) => ({ type: "execution_receipt", atMs, reasonCode: "tile_advanced" });

test("a day whose clock never moves is a violation, named without guessing at the cause", () => {
  // The 2026-10-31 shape: the day opens, the run keeps going for half an hour, no milestone ever arrives because
  // `shouldTimePass()` returns false while the settlement menu stands.
  const facts = [dayStarted(1_000, 6), activity(2_000), activity(60_000)];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 1_000 + 30 * 60_000, turnDurationsMs: [3_400] });

  assert.deepEqual(verdict.violations, ["morning_clock_frozen:day=6"], "the day is NAMED, not `day=null`");
  assert.equal(verdict.days.length, 1);
  assert.equal(verdict.days[0].day, 6);
  assert.equal(verdict.days[0].witnessedAtMs, null);
  assert.equal(verdict.days[0].turnCouldRun, true, "half an hour is a window a turn could have run inside");
  assert.equal(verdict.state, "measured");
  assert.deepEqual(verdict.notMeasured, []);
});

test("a day whose clock moves is not a violation", () => {
  // The healthy shape: the morning milestone arrives 90 s after the day starts.
  const facts = [dayStarted(1_000, 5), milestone(91_000, "0600", 5), milestone(400_000, "1200", 5)];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 500_000 });

  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.days[0].milestone, "0600");
});

test("a marathon day does not need a milestone inside its first two minutes", () => {
  // The exemption is about observation, and this is the control that keeps it from becoming an excuse: a day that runs
  // for minutes before its first milestone is fine, because a milestone only fires at 06:00/12:00/18:00/22:00 - the
  // clock can be moving for hours without crossing one.
  const facts = [dayStarted(1_000, 5), milestone(1_000 + 40 * 60_000, "1200", 5)];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 3_000_000 });

  assert.deepEqual(verdict.violations, [], "a late milestone still witnesses the day");
});

test("the next day's milestone cannot witness this one, and a day that ended is not frozen", () => {
  // Two claims, kept together because they are easy to confuse.
  //
  // 1. The next day's 06:00 must never be counted for the previous day: the span is bounded by the next `day_started`,
  //    and a run that froze its first morning and then took a second night would otherwise look healthy.
  // 2. A day that ENDED has proved the clock moved, so it can no longer be called frozen. Measured 2026-11-03
  //    (`round26`): on spring 6 the companion finished by noon and went to bed, the day closed without reaching 12:00,
  //    and the gate reported 263 seconds of a finished day as a frozen clock.
  const facts = [dayStarted(1_000, 5), dayStarted(5_000_000, 6), milestone(5_100_000, "0600", 6)];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 2_000_000, turnDurationsMs: [3_400] });

  assert.equal(verdict.days[0].day, 5);
  assert.equal(verdict.days[0].witnessedAtMs, null, "day 6's milestone must not witness day 5");
  assert.deepEqual(verdict.violations, [], "a day the next morning already closed cannot be a frozen clock");
  assert.equal(verdict.days[1].milestone, "0600");
});

test("a day still open, with no milestone, is the frozen clock the gate exists for", () => {
  // The exemption above must not weaken this: an open morning that never produces a milestone IS the defect.
  const facts = [dayStarted(1_000, 5)];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 1_000 + 10 * 60_000, turnDurationsMs: [3_400] });

  assert.deepEqual(verdict.violations, ["morning_clock_frozen:day=5"]);
});

test("a window shorter than one turn is not_measured, not a clean pass", () => {
  // A run that stops 20 s into a morning while its own turns take a minute could not have seen the clock move, and
  // calling that a pass is the "nothing observed reads as nothing wrong" defect this gate exists to catch. The reason
  // carries the numbers so a reader can check the claim instead of trusting it.
  const facts = [dayStarted(1_000, 7)];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 1_000 + 20_000, turnDurationsMs: [60_000] });

  assert.deepEqual(verdict.violations, []);
  assert.deepEqual(verdict.notMeasured, ["day_window_too_short_to_observe;day=7;window_ms=20000;median_turn_ms=60000"]);
  assert.equal(verdict.state, "not_measured");
  assert.equal(verdict.days[0].turnCouldRun, false);
  assert.equal(verdict.days[0].witnessedAtMs, null, "the silence is recorded, not hidden");
});

test("without the run's turn durations the gate says so instead of passing", () => {
  // What the runner supplies today (it passes `facts` and `endedAtMs` only). The observability question cannot be
  // answered, so it is NAMED rather than answered in the run's favour.
  const facts = [dayStarted(1_000, 7), dayStarted(30_000, 8)];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 60_000 });

  assert.deepEqual(verdict.violations, []);
  assert.deepEqual(verdict.notMeasured, [
    "turn_cadence_unknown;day=7;window_ms=29000",
    "turn_cadence_unknown;day=8;window_ms=30000",
  ]);
  assert.equal(verdict.state, "not_measured");
});

test("the round41 shape: six mornings 8.9 s / 12.7 s / 6.5 s apart are labelled, and the unwatched one is not_measured", () => {
  // `.live-runs/game-ladder/2026-11-09T18-26-53-581Z-multiday_routine`, the run's own timestamps. Three nights crossed
  // two days each (`day_started` in pairs), and this gate answered `violations: []` with `day: null` on every entry -
  // a clean list that a reader could not tell apart from "we never looked". The windows are that run's.
  const starts = [
    [1_794_249_740_998, 5],
    [1_794_249_749_889, 6],
    [1_794_250_401_169, 7],
    [1_794_250_413_936, 8],
    [1_794_251_204_491, 9],
    [1_794_251_211_041, 10],
  ];
  const facts = [
    ...starts.map(([atMs, day]) => dayStarted(atMs, day)),
    // The clock facts the run published, at the times it published them.
    milestone(1_794_250_038_585, "0600", 6),
    milestone(1_794_250_305_392, "0600", 7),
    milestone(1_794_250_680_186, "1200", 8),
    milestone(1_794_251_157_032, "0600", 9),
  ];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 1_794_251_285_748 });

  assert.equal(verdict.examined, 6, "the population is printed: six mornings were opened");
  assert.deepEqual(
    verdict.days.map((entry) => entry.day),
    [5, 6, 7, 8, 9, 10],
    "every morning is named, which is what `day: null` on all six of round41 hid",
  );
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.state, "not_measured", "the 8.9 s morning nobody could look into is not a pass");
  assert.deepEqual(verdict.notMeasured, ["turn_cadence_unknown;day=5;window_ms=8891"]);
});

test("a fact log without readable day identities cannot be judged, and does not pretend to be clean", () => {
  // `atMs` was added to `timeline.jsonl` in an earlier session, and a `day_started` whose minted id is missing names no
  // day at all. A gate that silently reported zero violations for such a log would be the vacuous-gate failure this
  // repository has already paid for twice - and dropping an unparseable fact would shrink the population instead.
  const verdict = assessMorningLiveness({
    facts: [
      { worldFactKind: "day_started", worldFactPayload: { kind: "day_started" } },
      {
        type: "world_fact",
        worldFactKind: "day_started",
        eventId: "day_started_day_9",
        worldFactPayload: { kind: "day_started" },
      },
    ],
    endedAtMs: 10_000_000,
  });

  assert.deepEqual(verdict.violations, []);
  assert.deepEqual(verdict.days, []);
  assert.equal(verdict.examined, 0);
  assert.equal(verdict.state, "not_measured", "unjudgeable input says so");
  assert.deepEqual(verdict.notMeasured, [
    "day_started_fact_without_a_day",
    "day_started_fact_without_a_timestamp;day=9",
    "no_day_started_facts",
  ]);
});

test("the attribution window is not the observability rule", () => {
  // The milestone may arrive before the morning it belongs to (the Mod emits the clock while the settlement menu is
  // still closing), and that window is a statement about WHICH morning a fact answers for. It must not become the
  // "the day was barely entered, so it cannot be judged" exemption the round41 gate used.
  const facts = [dayStarted(1_000 + MORNING_CLOCK_GRACE_MS, 5), milestone(1_000, "0600", 4)];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 2_000_000, turnDurationsMs: [3_400] });

  assert.equal(verdict.days[0].milestone, "0600");
  assert.deepEqual(verdict.violations, []);
});
