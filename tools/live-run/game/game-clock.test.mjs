// red-proof: inject  in game-clock.mjs making the `spanMinutes === 0` arm report `advanced` -> the paused-world test
//   fails with `world_clock_never_advanced:600:600:0` expected and `advanced` published; making `read()` count every
//   `observe` call as a reading (dropping the admitted-snapshot identity) -> the one-snapshot test reports two readings
//   and the run stops saying `not_measured:game_clock_read_once`
import assert from "node:assert/strict";
import test from "node:test";
import { assessPauseOnUnfocus, createGameClock, readSnapshotClock } from "./game-clock.mjs";

/** One admitted snapshot, as the bridge freezes it: a NEW object per read, which is what makes it one reading. */
const snapshotAt = (timeOfDay, { day = 1, season = 0, year = 1, revision = 1 } = {}) =>
  Object.freeze({ timeOfDay, dayOfMonth: day, seasonIndex: season, year, revision });

const clockWith = (...snapshots) => {
  const clock = createGameClock({ now: () => 1_000 });
  for (const snapshot of snapshots) clock.observe(snapshot);
  return clock;
};

test("a snapshot's clock is read from the Mod's own fields, and the world-not-ready zero is not a reading", () => {
  // `protocol.ts` publishes `timeOfDay`/`dayOfMonth`/`seasonIndex`/`year` on every Mod snapshot and says the value is
  // "Zero when the world is not ready". Zero is therefore the absence of a clock, not 00:00 - this game has no 00:00.
  assert.equal(readSnapshotClock({ timeOfDay: 0, dayOfMonth: 1, seasonIndex: 0, year: 1 }), null);
  assert.equal(readSnapshotClock(null), null);
  assert.equal(readSnapshotClock({ timeOfDay: "600" }), null);
  // The pass-out hour is the encoder's maximum and it must still be readable: 26:00 = 1560 minutes.
  const lateNight = readSnapshotClock({ timeOfDay: 2600, dayOfMonth: 1, seasonIndex: 0, year: 1 });
  assert.equal(lateNight.minutes, 1560);
  assert.equal(lateNight.timeOfDay, 2600);
  assert.equal(readSnapshotClock({ timeOfDay: 2601, dayOfMonth: 1, seasonIndex: 0, year: 1 }), null);
  // A calendar the Mod omitted leaves the axis unknown rather than inventing day 0.
  const noCalendar = readSnapshotClock({ timeOfDay: 600 });
  assert.equal(noCalendar.timeOfDay, 600);
  assert.equal(noCalendar.day, null);
  assert.equal(noCalendar.absoluteMinutes, null);
});

test("two readings with the clock between them publish the span and a rate per GAME hour", () => {
  const clock = clockWith(snapshotAt(600, { revision: 1 }), snapshotAt(660, { revision: 2 }));
  const reading = clock.read({ facts: 27 });
  assert.equal(reading.verdict, "advanced");
  assert.equal(reading.reasonCode, null);
  assert.equal(reading.first, 600);
  assert.equal(reading.last, 660);
  assert.equal(reading.advancedMinutes, 60);
  assert.equal(reading.snapshotsSeen, 2);
  // 27 facts over 60 game minutes is 27 per game hour, and the second method agrees: facts / (minutes / 60).
  assert.equal(reading.facts.perGameHour, 27);
  assert.equal(reading.facts.perGameHour, 27 / (60 / 60));
  assert.equal(reading.facts.gameMinutes, 60);
  assert.match(reading.facts.reading, /^facts 27 · game minutes 60 · per game hour 27$/u);
  assert.match(reading.line, /^game_clock 600->660 \(\+60 min\)/u);
});

test("a world that did not move is refused, not judged: two readings, one clock", () => {
  // THE RED DIRECTION. This is `round50b`'s world: ten minutes of wall clock, a live process, and no in-game time. The
  // run must not be able to turn that into a statement about the companion.
  const reading = clockWith(snapshotAt(600, { revision: 1 }), snapshotAt(600, { revision: 2 })).read({ facts: 0 });
  assert.equal(reading.verdict, "never_advanced");
  assert.equal(reading.state, "not_measured");
  assert.equal(reading.reasonCode, "world_clock_never_advanced:600:600:0");
  assert.equal(reading.advancedMinutes, 0);
  assert.equal(reading.facts.perGameHour, null, "a rate over a zero span is not a number");
  assert.equal(reading.facts.state, "still_world");
});

test("one reading is `not_measured:game_clock_read_once`, never a pass", () => {
  // The other half of `round50b`: zero facts and a span nobody measured. One reading cannot say the world was still -
  // it says the run looked once.
  const reading = clockWith(snapshotAt(600)).read({ facts: 0 });
  assert.equal(reading.verdict, "read_once");
  assert.equal(reading.state, "not_measured");
  assert.equal(reading.reasonCode, "not_measured:game_clock_read_once");
  assert.equal(reading.first, 600);
  assert.equal(reading.last, 600);
  assert.equal(reading.advancedMinutes, null, "no second reading means no span, not a zero span");
  // And it must not borrow the still world's word for it: "the world stood still" and "nobody looked twice" are the two
  // readings this module exists to keep apart.
  assert.equal(reading.facts.state, "span_not_measured");
});

test("sampling one admitted snapshot twice is one reading of the world", () => {
  // The bridge has no unsolicited snapshot push (`local-stardew-bridge.ts`): a snapshot exists only in answer to a
  // solicited observe, and the run samples the admitted projection repeatedly while it waits. Counting those samples as
  // readings would let a run that never re-read the world claim it had seen it move - or fail to.
  const only = snapshotAt(600);
  const clock = createGameClock({ now: () => 1_000 });
  clock.observe(only);
  clock.observe(only);
  clock.observe(only);
  const reading = clock.read({ facts: 3 });
  assert.equal(reading.snapshotsSeen, 1, "three looks at one admitted snapshot are one reading");
  assert.equal(reading.verdict, "read_once");
  // A second, ADMITTED snapshot is a second reading even when the clock reads the same.
  clock.observe(snapshotAt(600));
  const after = clock.read({ facts: 3 });
  assert.equal(after.snapshotsSeen, 2);
  assert.equal(after.verdict, "never_advanced");
});

test("a reading whose calendar moved forward spans the day; one that moved backwards is not measured", () => {
  // Boundary/ordering: the clock resets at 02:00, so a naive subtraction across a rollover is NEGATIVE. Two readings of
  // one world that crossed a night must not read as "went backwards", and two readings of different worlds must not read
  // as an advance.
  const crossing = clockWith(snapshotAt(2400, { day: 1, revision: 1 }), snapshotAt(600, { day: 2, revision: 2 })).read({
    facts: 4,
  });
  assert.equal(crossing.verdict, "advanced", "a night that passed is the world moving forward");
  assert.ok(
    crossing.advancedMinutes > 0,
    `the span across a rollover was ${crossing.advancedMinutes}: a same-day subtraction reports -1080 here`,
  );
  assert.equal(crossing.firstDay, 1);
  assert.equal(crossing.lastDay, 2);
  // The span across the rollover is SIX HOURS of clock: 24:00 -> 06:00 the next morning, computed here from the clock
  // values the game itself prints rather than from the module's axis constant, so the assertion can disagree with it.
  assert.equal(crossing.advancedMinutes, 6 * 60, "24:00 to 06:00 the next day is six hours, not a negative span");

  const backwards = clockWith(
    snapshotAt(1200, { day: 5, revision: 1 }),
    snapshotAt(1200, { day: 2, revision: 2 }),
  ).read({ facts: 9 });
  assert.equal(backwards.verdict, "went_backwards");
  assert.match(backwards.reasonCode, /^not_measured:world_clock_went_backwards:1200:1200:-/u);
  assert.equal(backwards.facts.perGameHour, null);
});

test("zero facts over a span the clock measured is its own finding, not a still world", () => {
  const reading = clockWith(snapshotAt(600), snapshotAt(840, { revision: 2 })).read({ facts: 0 });
  assert.equal(reading.verdict, "advanced");
  assert.equal(reading.facts.state, "no_facts_while_the_world_moved");
  assert.equal(reading.facts.counted, 0);
  assert.equal(reading.facts.perGameHour, 0, "zero facts in 240 game minutes is a measured zero, printed as such");
  // And the run that did produce facts beside the same span is a different reading, not the same one qualified.
  assert.equal(
    clockWith(snapshotAt(600), snapshotAt(840, { revision: 2 })).read({ facts: 8 }).facts.state,
    "facts_observed",
  );
});

test("an unreadable read is counted, and it never becomes a reading", () => {
  const clock = createGameClock({ now: () => 1_000 });
  clock.observe(snapshotAt(600));
  clock.observe(null);
  clock.observeUnreadable({ source: "final_read", reason: "bridge_not_authenticated" });
  const reading = clock.read({ facts: 1 });
  assert.equal(reading.snapshotsSeen, 1, "a refused observe does not become a second reading of the world");
  assert.equal(reading.unreadable, 2);
  assert.deepEqual(reading.unreadableReasons, [
    "snapshot:snapshot_carries_no_game_clock",
    "final_read:bridge_not_authenticated",
  ]);
  assert.equal(reading.reasonCode, "not_measured:game_clock_read_once");
});

test("pause-on-unfocus: where it is decided, and whether this run's own log says it ran", () => {
  // The hypothesis everyone reaches for, answered from the Mod's own line rather than from an assumption: the engine
  // option is cleared when the window mode is applied and re-asserted every tick (WindowModeManagement). A run whose log
  // carries the line has the mechanism; one whose log carries nothing has `not_established`, never "probably fine".
  const established = assessPauseOnUnfocus({
    modLog: "GameBuddy applying hidden window mode (silent, 60Hz background loop).",
  });
  assert.equal(established.state, "disabled_by_the_mod");
  assert.equal(established.windowMode, "hidden");
  assert.equal(established.reasserted, false);
  assert.deepEqual(established.decidedIn, [
    "WindowModeManagement.ApplyWindowModeInitial",
    "WindowModeManagement.EnforceEngineOptionsEveryTick",
  ]);

  const reasserted = assessPauseOnUnfocus({
    modLog: [
      "GameBuddy applying visible window mode (silent, 60Hz background loop).",
      "GameBuddy re-disabled pause-when-out-of-focus after the engine applied its own window options.",
    ].join("\n"),
  });
  assert.equal(reasserted.state, "disabled_by_the_mod");
  assert.equal(reasserted.windowMode, "visible");
  assert.equal(reasserted.reasserted, true);

  // The falsifier: a log full of this Mod's other lines, and no window-mode line, must not establish the hypothesis.
  const silent = assessPauseOnUnfocus({
    modLog: "GameBuddy bridge ready.\nGameBuddy receipt state=Succeeded;reason=soil_tilled",
  });
  assert.equal(silent.state, "not_established");
  assert.equal(silent.reason, "mod_window_mode_line_absent");
  assert.equal(silent.windowMode, null);
  assert.deepEqual(assessPauseOnUnfocus({}).state, "not_established");
});
