import assert from "node:assert/strict";
import { test } from "node:test";

import {
  A_MORNING_SHORTER_THAN_A_TURN,
  A_MORNING_THAT_ENDED_BEFORE_IT_STARTED,
  assessMorningLiveness,
  MORNING_CLOCK_GRACE_MS,
  morningDaysLine,
} from "./morning-liveness.mjs";

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
  assert.deepEqual(
    verdict.violations,
    [`${A_MORNING_THAT_ENDED_BEFORE_IT_STARTED}:7`, `${A_MORNING_THAT_ENDED_BEFORE_IT_STARTED}:9`],
    "the two mornings whose witness stood farther outside them than they lasted are FINDINGS: a 12.7 s morning witnessed" +
      " by a `0600` published 96 s before its day was announced, and a 6.5 s one by a `0600` 47 s before - the clock had" +
      " already rung before either morning began",
  );
  assert.deepEqual(verdict.morningDays, { examined: 5, ordered: 3, tooShort: null });
  assert.equal(
    verdict.morningDays.examined - verdict.morningDays.ordered,
    2,
    "`D-O>0` is the two violations and not a third count",
  );
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

test("the round82 shape: a second `sleep` 4.5 s into a day is named, not passed", () => {
  // `.live-runs/game-ladder/2026-11-21T…` (`round82`), the run's own timestamps and the Mod's own minted identities. Four
  // `day_started` facts for a run asked to cross two nights: the second `sleep` was accepted on a day that had just
  // begun, so day 6 was opened at `…957027` and closed by day 7 at `…961527`. This gate answered `measured` with an empty
  // violation list, because every one of the four days had a witness and a witness was the only question it asked.
  //
  // Day 6's witness is its OWN `0600` (`time_milestone_day_6_0600`), emitted 9,085 ms before the day was announced - and
  // the morning then lived 4,500 ms, so the clock that fact reports had finished ringing before this morning existed.
  // Day 5, beside it, is the control: its `0600` also precedes its `day_started` (4,489 ms), and that is the ordinary
  // announcement lag, not a finding, because its morning then lasted 536 s.
  const starts = [
    [1_795_166_420_380, 5],
    [1_795_166_957_027, 6],
    [1_795_166_961_527, 7],
    [1_795_167_415_366, 8],
  ];
  const facts = [
    ...starts.map(([atMs, day]) => dayStarted(atMs, day)),
    milestone(1_795_166_415_891, "0600", 5),
    milestone(1_795_166_707_962, "1200", 5),
    milestone(1_795_166_947_942, "0600", 6),
    milestone(1_795_167_239_111, "1200", 7),
    milestone(1_795_167_415_367, "0600", 8),
  ];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 1_795_167_425_116 });

  assert.deepEqual(verdict.violations, [`${A_MORNING_THAT_ENDED_BEFORE_IT_STARTED}:6`]);
  assert.equal(verdict.days[1].spanMs, 4_500, "day 6 lived 4.5 s: day 7 was opened straight after it");
  assert.equal(verdict.days[1].witnessPrecedesByMs, 9_085, "its witness stood further outside it than it was long");
  assert.equal(verdict.days[1].milestone, "0600", "the attribution is still published, it just cannot answer");
  assert.equal(
    verdict.days[0].witnessedAtMs < verdict.days[0].startedAtMs,
    false,
    "day 5's own witness is its `1200`, 287 s INSIDE the morning - which is why it is the control",
  );
  assert.equal(verdict.days[0].spanMs, 536_647, "a morning that lived 8.9 minutes is a morning");
  assert.deepEqual(
    verdict.violations.filter((entry) => entry.startsWith(A_MORNING_THAT_ENDED_BEFORE_IT_STARTED)),
    [`${A_MORNING_THAT_ENDED_BEFORE_IT_STARTED}:6`],
    "one finding, on the day nobody could have been asked anything in",
  );
  // `D-O` is exactly the number of days the rule refused, and `S` says the turn cadence was never supplied.
  assert.deepEqual(verdict.morningDays, { examined: 3, ordered: 2, tooShort: null });
  assert.equal(verdict.morningDaysLine, morningDaysLine(verdict.morningDays));
  assert.equal(morningDaysLine(verdict.morningDays), "days 3 · ordered 2 · too-short not_measured");
  assert.equal(verdict.state, "measured", "the gate had something to say, and it is not a pass");
});

test("a morning shorter than one turn is its own finding, and both counts are the violations", () => {
  // The reference is the run's own median turn, never a constant: a 4,500 ms morning against 60 s turns and a 200 s
  // morning beside it, so the control proves the rule reads the cadence and not the position in the array.
  const facts = [dayStarted(1_000, 5), dayStarted(6_000, 6), dayStarted(206_000, 7)];
  const verdict = assessMorningLiveness({ facts, endedAtMs: 206_000, turnDurationsMs: [60_000] });

  const tooShort = verdict.violations.filter((entry) => entry.startsWith(A_MORNING_SHORTER_THAN_A_TURN));
  assert.deepEqual(tooShort, [`${A_MORNING_SHORTER_THAN_A_TURN}:5:5000`]);
  assert.deepEqual(verdict.morningDays, { examined: 2, ordered: 2, tooShort: 1 });
  assert.equal(verdict.morningDaysLine, "days 2 · ordered 2 · too-short 1");
  assert.equal(
    verdict.violations.length,
    verdict.morningDays.examined - verdict.morningDays.ordered + verdict.morningDays.tooShort,
    "`D-O>0` and `S>0` are the two failures, and neither is a count nobody can act on",
  );
});

test("a witness that precedes its own start is not a witness", () => {
  // The whole rule in one case: the same four numbers with the day living long enough to be a morning. Day 6 opens at
  // 100_000, its `0600` was published 9,000 ms before that, and the day then lasts 400 ms - so the clock it answers with
  // had finished before the day began. Widening this morning to 20 s makes the same witness acceptable, which is what
  // keeps the rule from being a threshold somebody can lengthen.
  const short = assessMorningLiveness({
    facts: [dayStarted(100_000, 6), dayStarted(100_400, 7), milestone(91_000, "0600", 6)],
    endedAtMs: 500_000,
  });
  assert.deepEqual(short.violations, [`${A_MORNING_THAT_ENDED_BEFORE_IT_STARTED}:6`]);

  const long = assessMorningLiveness({
    facts: [dayStarted(100_000, 6), dayStarted(120_000, 7), milestone(91_000, "0600", 6)],
    endedAtMs: 500_000,
  });
  assert.deepEqual(long.violations, [], "the same witness answers for a morning that lived 20 s");
  assert.deepEqual(long.morningDays, { examined: 1, ordered: 1, tooShort: null });
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
