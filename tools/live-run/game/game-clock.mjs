/**
 * Did the world's own clock move while this run was watching?
 *
 * <p>
 * MEASURED 2026-11-19 (`round50b`): ten real minutes, the game process alive with its update counter advancing
 * (`stage=capability_publication;tick=37851`), `BRIDGE_FACT 0`, `time_milestone 0`, `day_started 0`,
 * `snapshot_changed 0`. In `round49` the same scenario produced `time_milestone` six times in nineteen minutes. TWO
 * worlds produce that identical reading:
 * </p>
 * <ul>
 *   <li>the world's clock is STOPPED - a paused game, a standing modal, no `Game1.gameTimeInterval` - so no in-game
 *       time passes and no time-driven fact can exist;</li>
 *   <li>the world is moving and the Mod stopped publishing.</li>
 * </ul>
 * <p>
 * Nothing in that run could tell them apart, and the verdict it has to support ("she stopped") is a statement about the
 * companion that a still world cannot witness. The process tick counter cannot settle it: it advances whether or not the
 * clock does.
 * </p>
 *
 * <h2>The reading</h2>
 * <p>
 * The Mod already publishes the clock in every snapshot (`timeOfDay` / `dayOfMonth` / `seasonIndex` / `year`,
 * `protocol.ts`), and the bridge admits a snapshot only in answer to a solicited observe - so a snapshot in hand IS a
 * reading of the world at that moment. This module keeps the first and the last such reading of a run and answers:
 * </p>
 * <ul>
 *   <li>fewer than two readings - `not_measured:game_clock_read_once`. A run cannot say the world was still; it only
 *       looked once.</li>
 *   <li>two or more, same clock - `world_clock_never_advanced:<first>:<last>:<minutes>`. A paused world measures
 *       nothing about the companion, so the verdict is refused rather than written.</li>
 *   <li>two or more, moved - `advanced`, and the facts the run recorded are turned into a rate PER GAME HOUR. Zero
 *       facts over a non-zero span is then a real finding (the Mod or the bridge stopped), and it is distinguishable
 *       from zero facts over a zero span (the clock is stopped).</li>
 * </ul>
 *
 * <p>
 * A reading whose clock went BACKWARDS is neither: two different worlds were read (a reload, a second save), so the
 * span is not a measurement of one world and the answer says so rather than reporting the negative as an advance.
 * </p>
 */

/**
 * One in-game day on this module's own minute axis.
 *
 * `Snapshot.timeOfDay` is `HHmm` and the 02:00 pass-out is encoded as `2600` (`protocol.ts` refuses anything above it),
 * which is 02:00 of the FOLLOWING calendar day - so a day on this axis is a real 1440 minutes and an encoded `2600`
 * lands on the next day at 02:00, where the game itself puts it. The axis is only ever used to subtract two readings.
 */
const GAME_CLOCK_MINUTES_PER_DAY = 1440;

/** A season is 28 days and a year is four seasons (`Game1`'s own calendar), used only to lay readings on one axis. */
const DAYS_PER_SEASON = 28;
const SEASONS_PER_YEAR = 4;

/**
 * The clock a snapshot carries, or `null` when it carries none.
 *
 * `timeOfDay === 0` is the world-not-ready snapshot's own value (`protocol.ts`: "Zero when the world is not ready"), and
 * it is NOT a reading: 00:00 does not exist in this game, so accepting it would report a paused world for a world that
 * had not loaded yet - the same defect this module exists to remove, one layer down.
 */
export function readSnapshotClock(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return null;
  const timeOfDay = snapshot.timeOfDay;
  if (!Number.isInteger(timeOfDay) || timeOfDay <= 0 || timeOfDay > 2600) return null;
  const minutes = Math.floor(timeOfDay / 100) * 60 + (timeOfDay % 100);
  const day = Number.isInteger(snapshot.dayOfMonth) && snapshot.dayOfMonth > 0 ? snapshot.dayOfMonth : null;
  const season = Number.isInteger(snapshot.seasonIndex) && snapshot.seasonIndex >= 0 ? snapshot.seasonIndex : null;
  const year = Number.isInteger(snapshot.year) && snapshot.year > 0 ? snapshot.year : null;
  return Object.freeze({
    timeOfDay,
    minutes,
    day,
    season,
    year,
    // A calendar the Mod omitted stays null instead of becoming day 0: the axis is then unknown, and the span across a
    // midnight would be unmeasurable rather than a number nobody can check.
    absoluteMinutes:
      day === null || season === null || year === null
        ? null
        : (((year - 1) * SEASONS_PER_YEAR + season) * DAYS_PER_SEASON + (day - 1)) * GAME_CLOCK_MINUTES_PER_DAY +
          minutes,
  });
}

/**
 * The run's sampler: feed it every snapshot the run reads, ask it once at the end.
 *
 * `observe` is called wherever the runner already samples the world, so it costs no bridge traffic. Two samples of the
 * SAME admitted snapshot are ONE reading taken twice - the bridge admits a snapshot only in answer to a solicited
 * observe, so the object's identity is what distinguishes "the world was read again" from "the same read was looked at
 * again", and counting the second as a reading would let a run claim it had seen the world twice.
 */
export function createGameClock({ now = () => Date.now() } = {}) {
  const readings = [];
  const misses = [];
  let samples = 0;
  let lastSnapshot = null;

  const observe = (snapshot, { source = "snapshot" } = {}) => {
    const clock = readSnapshotClock(snapshot);
    if (clock === null) {
      misses.push(Object.freeze({ source, atMs: now(), reason: "snapshot_carries_no_game_clock" }));
      return null;
    }
    if (snapshot === lastSnapshot) return readings.at(-1) ?? null;
    lastSnapshot = snapshot;
    samples += 1;
    const reading = Object.freeze({ ...clock, source, atMs: now() });
    readings.push(reading);
    return reading;
  };

  /** A read that produced no clock at all - a bridge that refused the observe, an unparseable answer. */
  const observeUnreadable = ({ source = "read", reason = "no_reading_attempted" } = {}) => {
    misses.push(Object.freeze({ source, atMs: now(), reason: String(reason) }));
    return null;
  };

  /**
   * The run's answer. `facts` is the run's own fact population (the bridge facts it recorded), turned into a rate over
   * the span the clock measured - per GAME hour, never per wall minute: the wall clock keeps running in a paused world,
   * which is exactly the reading this replaces.
   */
  const read = ({ facts = null } = {}) => {
    const first = readings[0] ?? null;
    const last = readings.at(-1) ?? null;
    const firstAtMs = first?.atMs ?? null;
    const lastAtMs = last?.atMs ?? null;
    const wallMs = firstAtMs === null || lastAtMs === null ? null : lastAtMs - firstAtMs;
    const spanMinutes = spanOf(readings);
    const { verdict, reasonCode } = judgeSpan({ readings, spanMinutes, first, last });
    const gameMinutes = verdict === "advanced" ? spanMinutes : null;
    const counted = Number.isInteger(facts) && facts >= 0 ? facts : null;
    // A rate needs a denominator: zero facts over a still world is `null` here (`state: "still_world"`), never 0 per
    // game hour, because the second number would read as a measured rate of a world that did not move.
    const perGameHour = counted === null || gameMinutes === null ? null : round(counted / (gameMinutes / 60), 2);
    const factState = classifyFacts({ counted, gameMinutes });
    // ONE spelling of the triple, used by the object and by the printed line: two formatters for one reading is how a
    // published number and a printed number come to disagree.
    const factsReading = describeFacts({ counted, gameMinutes, spanMinutes, perGameHour });
    return Object.freeze({
      state: verdict === "advanced" ? "measured" : "not_measured",
      verdict,
      reasonCode,
      first: first?.timeOfDay ?? null,
      last: last?.timeOfDay ?? null,
      firstDay: first?.day ?? null,
      lastDay: last?.day ?? null,
      firstAtMs,
      lastAtMs,
      wallMs,
      advancedMinutes: spanMinutes,
      // How many times the WORLD was read, and how many times the run looked at a reading it already had: a run whose
      // `looks` is large and whose `snapshotsSeen` is 1 was sampling one admitted snapshot for the whole session, which
      // is a fact about the harness rather than about the world.
      snapshotsSeen: readings.length,
      looks: samples,
      unreadable: misses.length,
      unreadableReasons: Object.freeze(misses.map((miss) => `${miss.source}:${miss.reason}`)),
      facts: Object.freeze({
        state: factState,
        counted,
        gameMinutes,
        perGameHour,
        // The reading itself, in the unit the question is asked in. `facts N · game minutes M · per game hour X`.
        reading: factsReading,
      }),
      // One line, printed by the run: the span in the game's own values, then what was produced over it.
      line: describeClock({
        readings,
        first,
        last,
        spanMinutes,
        verdict,
        reasonCode,
        looks: samples,
        unreadable: misses.length,
        factsReading,
      }),
    });
  };

  return Object.freeze({ observe, observeUnreadable, read });
}

/** The span between the first and the last reading, on the sampler's own axis.
 *
 * One reading has NO span: reporting it as a zero-length one is how a run that looked once comes to say the world stood
 * still.
 */
function spanOf(readings) {
  if (readings.length < 2) return null;
  const first = readings[0];
  const last = readings[readings.length - 1];
  if (first.absoluteMinutes !== null && last.absoluteMinutes !== null)
    return last.absoluteMinutes - first.absoluteMinutes;
  // A calendar the Mod omitted leaves only the clock values, and then a span across a midnight is unmeasurable rather
  // than a negative number a reader would have to interpret.
  return last.minutes - first.minutes;
}

/**
 * What the span means, in the closed vocabulary the result publishes, with the code that names it when the world did
 * not move.
 */
function judgeSpan({ readings, spanMinutes, first, last }) {
  if (readings.length < 2) return { verdict: "read_once", reasonCode: "not_measured:game_clock_read_once" };
  if (spanMinutes === null) return { verdict: "axis_unknown", reasonCode: "not_measured:game_clock_axis_unknown" };
  if (spanMinutes > 0) return { verdict: "advanced", reasonCode: null };
  if (spanMinutes === 0)
    return {
      verdict: "never_advanced",
      reasonCode: `world_clock_never_advanced:${first.timeOfDay}:${last.timeOfDay}:0`,
    };
  // Two readings of two different worlds (a reload, a second save): not a measurement of either, and never a negative
  // advance reported as if the clock ran backwards inside one world.
  return {
    verdict: "went_backwards",
    reasonCode: `not_measured:world_clock_went_backwards:${first.timeOfDay}:${last.timeOfDay}:${spanMinutes}`,
  };
}

/** What the facts the run recorded say, given whether the clock gave them a denominator at all. */
function classifyFacts({ counted, gameMinutes }) {
  if (counted === null) return "facts_not_counted";
  if (counted > 0) return "facts_observed";
  // Zero facts over a still world is the clock's own answer (`still_world`); over a span it is a real finding about the
  // Mod or the bridge, and the two must never publish the same word.
  return gameMinutes === null ? "still_world" : "no_facts_while_the_world_moved";
}

/** `facts N · game minutes M · per game hour X`, formatted once and used by the object and the printed line. */
function describeFacts({ counted, gameMinutes, spanMinutes, perGameHour }) {
  const facts = counted === null ? "not counted" : String(counted);
  const minutes =
    gameMinutes === null ? (spanMinutes === null ? "unmeasured" : String(spanMinutes)) : String(gameMinutes);
  const rate = perGameHour === null ? "not measured" : String(perGameHour);
  return `facts ${facts} · game minutes ${minutes} · per game hour ${rate}`;
}

/** The one line the run prints, built from the same values the object publishes. */
function describeClock({ readings, first, last, spanMinutes, verdict, reasonCode, looks, unreadable, factsReading }) {
  const clock = first === null ? "unread" : `${first.timeOfDay}->${last.timeOfDay}`;
  const span = spanMinutes === null ? "" : ` (${spanMinutes > 0 ? "+" : ""}${spanMinutes} min)`;
  const looksText = `${readings.length} reading(s) of ${looks} snapshot read(s)`;
  const missed = unreadable === 0 ? "" : ` · ${unreadable} unreadable`;
  const answer = verdict === "advanced" ? "the world moved" : (reasonCode ?? verdict);
  return `game_clock ${clock}${span} · ${looksText}${missed} · ${answer} · ${factsReading}`;
}

/** Two decimal places, because a rate printed to seventeen digits reads as precision nobody measured. */
function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * WHO DECIDED THAT THIS RUN'S WORLD IS NOT PAUSED WHEN ITS WINDOW LOSES FOCUS, and did it happen here?
 *
 * <p>
 * "The game pauses when the window loses focus" is the first hypothesis anyone reaches for when a clock stops, because
 * it is true of a plain Stardew install (`Options.pauseWhenOutOfFocus`). It is not true of a run with this Mod: the
 * engine option is cleared when the window mode is applied
 * (`WindowModeManagement.ApplyWindowModeInitial` → `Game1.options.pauseWhenOutOfFocus = false`,
 * `GameRunner.instance.InactiveSleepTime = 0`) and re-asserted EVERY TICK
 * (`WindowModeManagement.EnforceEngineOptionsEveryTick`), because the engine applies its own `clientOptions` after the
 * title screen and had put the pause back. So the mechanism is decided in the Mod, and the only evidence that it ran in
 * THIS run is the Mod's own log line.
 * </p>
 * <p>
 * A run whose log carries neither line answers `not_established` with the reason, rather than assuming the option was
 * cleared: an assumption is what this whole reading exists to replace. What would settle it otherwise is a snapshot-level
 * reading of `Game1.shouldTimePass()` (`ModalTransitionObserver` already projects it as `blocksTimePass` on a modal) or a
 * native clock-rate line, neither of which this run reads.
 * </p>
 */
export function assessPauseOnUnfocus({ modLog = "" } = {}) {
  const text = typeof modLog === "string" ? modLog : "";
  const applied = /GameBuddy applying (\w+) window mode/u.exec(text);
  const reasserted = /GameBuddy re-disabled pause-when-out-of-focus/u.test(text);
  const decidedIn = Object.freeze([
    "WindowModeManagement.ApplyWindowModeInitial",
    "WindowModeManagement.EnforceEngineOptionsEveryTick",
  ]);
  if (applied === null && reasserted === false)
    return Object.freeze({
      state: "not_established",
      hypothesis: "pause_on_unfocus",
      windowMode: null,
      reasserted: false,
      decidedIn,
      reason: "mod_window_mode_line_absent",
      detail:
        "this run's Mod log carries neither the window-mode line nor the re-assertion line, so nothing observed says the " +
        "engine's `pauseWhenOutOfFocus` was cleared for it",
    });
  return Object.freeze({
    state: "disabled_by_the_mod",
    hypothesis: "pause_on_unfocus",
    windowMode: applied?.[1] ?? null,
    reasserted,
    decidedIn,
    reason: null,
    detail: reasserted
      ? "the engine re-enabled pause-when-out-of-focus after startup and the Mod disabled it again"
      : "the Mod applied its window mode, which clears pause-when-out-of-focus and the unfocused sleep interval",
  });
}
