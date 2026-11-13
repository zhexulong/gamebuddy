// red-proof: inject  in game-clock.mjs making the `spanMinutes === 0` arm report `advanced` -> the paused-world test
//   fails with `world_clock_never_advanced:600:600:0` expected and `advanced` published; making `read()` count every
//   `observe` call as a reading (dropping the admitted-snapshot identity) -> the one-snapshot test reports two readings
//   and the run stops saying `not_measured:game_clock_read_once`; deriving `minutesSinceFirst` from the WALL clock instead
//   of the game's own values -> the three-read test publishes 0/0/0 where the world moved 5 and 10 game minutes;
//   printing `GAME_CLOCK_READ` only for the first read (or deduping by clock VALUE instead of snapshot identity) -> the
//   line count and the same-clock reading fail; firing the heartbeat on every call rather than past the bound -> the
//   inside-the-bound assertion fails with a line it must not print; returning no line when nothing was ever read -> the
//   never-read test loses `lastReading: null` and the note naming the snapshot
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GAME_CLOCK_HEARTBEAT_MS, assessPauseOnUnfocus, createGameClock, readSnapshotClock } from "./game-clock.mjs";

/** One admitted snapshot, as the bridge freezes it: a NEW object per read, which is what makes it one reading. */
const snapshotAt = (timeOfDay, { day = 1, season = 0, year = 1, revision = 1 } = {}) =>
  Object.freeze({ timeOfDay, dayOfMonth: day, seasonIndex: season, year, revision });

const clockWith = (...snapshots) => {
  const clock = createGameClock({ now: () => 1_000, print: () => {} });
  for (const snapshot of snapshots) clock.observe(snapshot);
  return clock;
};

/**
 * A periodic line split into its code and its payload.
 *
 * The lines are read the way a person reads the tail of a run log: scroll to the code, then read the JSON beside it.
 * `indexOf(" ")` rather than `split(" ")` because the payload itself may hold spaces.
 */
const splitLine = (line) => {
  const space = line.indexOf(" ");
  assert.ok(space > 0, `a periodic clock line starts with a code and a payload, not this: ${line}`);
  return { code: line.slice(0, space), payload: JSON.parse(line.slice(space + 1)) };
};
const payloadsOf = (printed, code) =>
  printed.filter((line) => line.startsWith(`${code} `)).map((line) => splitLine(line).payload);

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
  const clock = createGameClock({ now: () => 1_000, print: () => {} });
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
  const clock = createGameClock({ now: () => 1_000, print: () => {} });
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

test("every read prints itself, with the GAME minutes since the first read - not the wall ones", () => {
  // An end-of-run-only instrument cannot describe a run whose END is the thing under investigation (`round50b`: two
  // turns, then ten minutes of nothing, and the reading never printed). So each read prints as it happens.
  const printed = [];
  let nowMs = 5_000;
  const clock = createGameClock({ now: () => nowMs, print: (line) => printed.push(line) });
  // Three admitted snapshots five GAME minutes apart, one millisecond of wall clock apart: the number a reader needs is
  // the world's. A wall-derived one publishes 0 three times on a world that moved ten minutes.
  const reads = [snapshotAt(600, { revision: 1 }), snapshotAt(605, { revision: 2 }), snapshotAt(610, { revision: 3 })];
  for (const snapshot of reads) {
    clock.observe(snapshot);
    nowMs += 1;
  }
  const lines = payloadsOf(printed, "GAME_CLOCK_READ");
  assert.equal(lines.length, 3, `one line per read of the world, got ${JSON.stringify(printed)}`);
  assert.deepEqual(
    lines.map((payload) => payload.minutesSinceFirst),
    [0, 5, 10],
  );
  assert.deepEqual(
    lines.map((payload) => payload.timeOfDay),
    [600, 605, 610],
  );
  // The four fields `protocol.ts` publishes on every snapshot, so the log alone says which day of which season the
  // world was on when it went quiet.
  assert.deepEqual(
    lines.map(({ day, season, year }) => [day, season, year]),
    [
      [1, 0, 1],
      [1, 0, 1],
      [1, 0, 1],
    ],
  );
  // The wall moment of the read itself, not the moment the line is read back.
  assert.deepEqual(
    lines.map((payload) => payload.atMs),
    [5_000, 5_001, 5_002],
  );

  // BOUNDED: looking again at a reading the run already holds is not a read, and printing it would make the log one
  // line per poll instead of one line per observe.
  const before = printed.length;
  clock.observe(reads.at(-1));
  assert.equal(printed.length, before, "resampling the admitted snapshot is not a read and must print nothing");

  // A NEW admitted snapshot carrying the SAME clock is still a read: "the Mod answered again at 10:10" is exactly the
  // fact that separates a paused world from a silent Mod, so a dedupe on the clock's VALUE would swallow it. The line
  // count and the read's own `atMs` are what say a line was PRINTED, not merely that the value ended up in the log.
  const beforeSameClock = payloadsOf(printed, "GAME_CLOCK_READ").length;
  clock.observe(snapshotAt(610, { revision: 4 }));
  const afterSameClock = payloadsOf(printed, "GAME_CLOCK_READ");
  assert.equal(
    afterSameClock.length,
    beforeSameClock + 1,
    "a new snapshot on an unchanged clock is a read and must print its own line",
  );
  const sameClock = afterSameClock.at(-1);
  assert.equal(sameClock.atMs, 5_003, "the line is printed at the new read's own moment");
  assert.equal(sameClock.timeOfDay, 610);
  assert.equal(sameClock.minutesSinceFirst, 10, "a second read of one clock value is still a second read of the world");
});

test("a run that stops reading says so as it stops, and the verdict it still writes is `read_once`", () => {
  const printed = [];
  let nowMs = 10_000;
  const clock = createGameClock({
    now: () => nowMs,
    print: (line) => printed.push(line),
    // The run's own answer to "who cleared pause-when-out-of-focus", bound here as the runner binds it.
    pauseOnUnfocus: () =>
      assessPauseOnUnfocus({ modLog: "GameBuddy applying hidden window mode (silent, 60Hz background loop)." }),
  });
  clock.observe(snapshotAt(600, { revision: 1 }));
  // Inside the bound the read line is already that interval's record, so the beat prints nothing: one line per read
  // plus one line per bound of silence, never one per tick.
  nowMs += GAME_CLOCK_HEARTBEAT_MS - 1_000;
  assert.equal(clock.heartbeat().line, null, "a beat inside the bound must not print");
  // Past it: one line, and the silence it measures is the distance from the last READ.
  nowMs += 2_000;
  const first = clock.heartbeat();
  assert.ok(first.stalled, "past the bound the sampler is stalled");
  const firstLine = splitLine(first.line);
  assert.equal(firstLine.code, "GAME_CLOCK_STALLED");
  assert.equal(firstLine.payload.sinceLastReadMs, nowMs - 10_000, "the gap is now minus the reading's own atMs");
  assert.deepEqual(firstLine.payload.lastReading, {
    atMs: 10_000,
    timeOfDay: 600,
    day: 1,
    season: 0,
    year: 1,
  });
  assert.equal(
    firstLine.payload.pausedOnUnfocus,
    "disabled_by_the_mod:hidden",
    "the beat carries the run's own pause reading, so a frozen clock arrives with its first suspect named",
  );
  // The number grows with the silence - the reading a stalled run's tail has to show.
  nowMs += 60_000;
  const secondBeat = clock.heartbeat();
  assert.ok(secondBeat.line, "the second beat of a silent sampler must print too");
  const second = splitLine(secondBeat.line).payload;
  assert.ok(
    second.sinceLastReadMs > firstLine.payload.sinceLastReadMs,
    `the gap did not grow: ${String(second.sinceLastReadMs)} then ${String(firstLine.payload.sinceLastReadMs)}`,
  );
  assert.equal(second.sinceLastReadMs, nowMs - 10_000);
  assert.equal(second.lastReading.timeOfDay, 600, "the last reading before the silence is still visible in it");

  // AND THE VERDICT IS UNCHANGED: one reading is a run that looked once, never a run that saw a still world.
  const reading = clock.read({ facts: 0 });
  assert.equal(reading.state, "not_measured");
  assert.equal(reading.verdict, "read_once");
  assert.equal(reading.reasonCode, "not_measured:game_clock_read_once");
  assert.equal(reading.snapshotsSeen, 1, "the beats are not readings of the world");
});

test("a sampler that never read the clock heartbeats the reason instead of printing nothing", () => {
  // `round50b`'s other shape: the sampler may be unable to read at all - the clock is only readable from an admitted
  // snapshot and the bridge may never hand one over. Silence there is a fact, and the line has to name it rather than
  // leave a gap a reader cannot interpret.
  const printed = [];
  let nowMs = 0;
  const clock = createGameClock({ now: () => nowMs, print: (line) => printed.push(line) });
  assert.deepEqual(payloadsOf(printed, "GAME_CLOCK_READ"), [], "nothing has been read yet");
  nowMs = GAME_CLOCK_HEARTBEAT_MS + 5_000;
  const beat = clock.heartbeat();
  assert.ok(beat.line, "a sampler that never read must say so, not print nothing");
  const payload = splitLine(beat.line).payload;
  assert.equal(payload.lastReading, null);
  assert.equal(
    payload.sinceLastReadMs,
    GAME_CLOCK_HEARTBEAT_MS + 5_000,
    "with no reading the gap is measured from the sampler's creation",
  );
  assert.match(payload.note, /snapshot/u, "the line must say the clock is only readable from an admitted snapshot");
  assert.equal(payload.pausedOnUnfocus, "not_probed", "an unbound probe says so rather than inventing a verdict");

  // A bound probe that found nothing in the Mod log is a DIFFERENT reading, and the falsifier for the default above.
  const quiet = createGameClock({
    now: () => nowMs,
    print: () => {},
    pauseOnUnfocus: () => assessPauseOnUnfocus({ modLog: "GameBuddy bridge ready." }),
  });
  nowMs += GAME_CLOCK_HEARTBEAT_MS;
  const quietBeat = quiet.heartbeat();
  assert.ok(quietBeat.line, "the second sampler must beat too");
  assert.equal(splitLine(quietBeat.line).payload.pausedOnUnfocus, "not_established:mod_window_mode_line_absent");
});

test("the run is actually wired to print both: every read, and a beat per bound of silence", () => {
  // A module nobody calls prints nothing, which is indistinguishable from the instrument that only spoke at the end.
  // So the call sites are read out of the runner itself, at the three points that make the lines exist at all.
  const runner = readFileSync(new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url), "utf8");
  const beat = runner.indexOf("setInterval(() => gameClock.heartbeat(), GAME_CLOCK_HEARTBEAT_MS)");
  assert.ok(beat > 0, "the runner must beat the clock on a timer: no waiting loop can be trusted to report a stall");
  assert.match(
    runner,
    /gameClockHeartbeat\.unref\?\.\(\);/u,
    "the beat must not hold the process open after the run's own work is done",
  );
  // One spelling of the bound: the runner reads the interval from the module, so the two cannot drift.
  assert.match(
    runner,
    /import \{[^}]*GAME_CLOCK_HEARTBEAT_MS[^}]*\} from "\.\/game-clock\.mjs";/u,
    "the interval has to come from the module that documents it, not be respelled at the call site",
  );
  assert.doesNotMatch(runner, /game-clock\.mjs[\s\S]{0,80}30_000/u, "a second copy of the bound is a second answer");
  // The beat carries this run's own pause-on-unfocus probe, and the timer is created only after the log readers it calls:
  // a beat that fires while those are still in their temporal dead zone is a diagnostic that kills the run.
  assert.match(
    runner,
    /const gameClock = createGameClock\(\{[\s\S]{0,400}?pauseOnUnfocus: \(\) => assessPauseOnUnfocus\(\{ modLog: readModLogText\(\) \}\)/u,
    "the beat has to publish the run's own pause-on-unfocus reading",
  );
  assert.ok(
    beat > runner.indexOf("const readModLogText") && beat > runner.indexOf("const MOD_LOG_PATHS"),
    "the beat is created before the log readers it calls, so a beat during module evaluation would throw",
  );
  // And the per-read line comes from the sampler every world read already goes through.
  assert.match(
    runner,
    /function rememberObservation\(\)[\s\S]{0,600}?gameClock\.observe\(snapshot, \{ source: "snapshot" \}\)/u,
    "every world read must reach the sampler that prints it",
  );
});
