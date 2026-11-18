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
 *
 * <h2>Why the reading is also printed as it happens</h2>
 * <p>
 * MEASURED 2026-11-19 (`round51`, and `round50b` before it): two turns, then ten minutes in which nothing was read -
 * and the run was stopped while it was stalled. The reading above is published by `buildRunResult`, i.e. only when the
 * run ENDS, so the two runs whose end was the thing under investigation published neither number. An instrument that
 * reports only at the end cannot describe a run that stalls, so this module prints as it samples:
 * </p>
 * <ul>
 *   <li>{@link GAME_CLOCK_READ}, at every read, with `atMs`, `source`, the game's four clock fields, and the GAME minutes
 *       since the first read - the log itself then shows whether the world was moving, and how far it had got at the last
 *       read before the silence;</li>
 *   <li>`GAME_CLOCK_STALLED`, from {@link createGameClock}.heartbeat, once per `heartbeatMs` in which NO reading arrived
 *       on any channel, so a quiet log says what the beat read when it asked and why the silence outlasted the ask. The
 *       beat's own ask is a reading like any other: an ask that is answered ENDS the silence and prints no line, because
 *       the `GAME_CLOCK_READ` that answer already printed is its record.</li>
 * </ul>
 * <p>
 * Both are bounded into the traffic that already exists: one line per admitted snapshot (never per poll - a second look
 * at a held snapshot is not a read) and one line per bound of unsettled silence. The END-OF-RUN VERDICT IS UNCHANGED by
 * them.
 * </p>
 *
 * <h2>The age is the age of the last READING, on whichever channel it arrived</h2>
 * <p>
 * MEASURED 2026-11-21 (`round66` and `round67`): both runs reported `GAME_CLOCK_STALLED {sinceLastSnapshotMs: 199805,
 * lastSnapshotReading: {source: "snapshot", timeOfDay: 640}, note: "no_snapshot_since_that_read"}` - 199.8 s of a
 * 279 s run with "no snapshot" - and both reports were read as a world nobody could see. The world was read every
 * thirty seconds: 9 `GAME_CLOCK_READ` lines walking 06:10 -> 08:10 while the stall number grew monotonically. The number
 * was measuring the silence of ONE CALLER'S TAG. `source` is stamped by whoever read the admitted snapshot FIRST, the
 * run's own sampling (`rememberObservation`, no timer, called only from turn paths) stops when the run stops opening
 * turns, and the beat's answers are stamped `solicit` - so every reading after the first turn landed in the bucket the
 * stall number does not measure. The bridge has ONE client and ONE admitted snapshot per observe
 * (`local-stardew-bridge.ts`; the runner wraps the same client for the Host), so a reading is a reading whoever asked.
 * </p>
 * <p>
 * So the age is `sinceLastReadingMs`, measured from the newest reading of ANY channel, and the channels are counted
 * separately (`readingsByChannel`) so that "the beat is the only one reading" is a number a reader can see instead of a
 * silence they have to infer. A tag whose caller goes quiet can no longer make a reading invisible. And the falsifier of
 * record, because it is the shape that produced the wrong number: INVERTING ONLY THE READ ORDER over the same world (the
 * sampler reads the admitted object before the beat does) used to yield zero stall lines where the other order yielded
 * nine - the number described bookkeeping, not the world.
 * </p>
 *
 * <h2>The beat asks for its own reading</h2>
 * <p>
 * MEASURED 2026-11-21 (`round52`): `GAME_CLOCK_READ` twice, 06:10 then 06:30, then nine `GAME_CLOCK_STALLED` lines whose
 * `sinceLastReadMs` grew 216 s -> 247 s -> 277 s, while the Mod's own console printed `capability_publication tick
 * 2310 -> 19630`. Two readings twenty game-minutes apart, then 4.6 real minutes in which nothing was read - and the tick
 * counter cannot settle it, because it advances while the game is PAUSED. A `GAME_CLOCK_STALLED` line that only waits to
 * be handed a snapshot therefore cannot distinguish a stopped world from a silent Mod, which is the question it exists
 * for. Waiting is the defect: the bridge has no unsolicited push, so a run that is not acting is handed nothing at all.
 * </p>
 * <p>
 * So the beat SOLICITS one reading of its own, through the same `observe` the run already makes (a read, which changes
 * nothing). Three bounds keep that honest in a live run:
 * </p>
 * <ul>
 *   <li>ONE ask per `heartbeatMs`, not per tick. The beat runs on a timer, and the bound is re-checked here so a caller
 *       that beats from a waiting loop cannot turn the instrument into a poll;</li>
 *   <li>an answer is a reading: `source: "solicit"` says WHO asked, never whether a snapshot arrived - the run's own
 *       sampling and the beat read the same admitted frame, and the age is measured from whichever landed last;</li>
 *   <li>an ask that FAILED says so on the line (`solicit_failed:<reason>`), and an ask the run could not make at all -
 *       the bridge is not attached yet, or it has closed - says `not_attempted:<reason>` rather than pretending the bridge
 *       answered. {@link createGameClock} returns `close`, which stops the asking once the bridge is gone.</li>
 * </ul>
 * <p>
 * THE END-OF-RUN VERDICT IS UNCHANGED. A solicited read is one more reading of the same world: it can make a span
 * measurable that was not measured before, and {@link createGameClock} still refuses a still world and a single reading
 * exactly as it did.
 * </p>
 */

/** How long a silence the run tolerates before it prints a heartbeat saying so. */
export const GAME_CLOCK_HEARTBEAT_MS = 30_000;

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
 * The run's sampler: feed it every snapshot the run reads, ask it once at the end, and beat it while you wait.
 *
 * `observe` is called wherever the runner already samples the world, so it costs no bridge traffic; the ONLY read this
 * module adds is the beat's own (`solicit`, one per {@link heartbeatMs}). Two samples of the SAME admitted snapshot are
 * ONE reading taken twice - the bridge admits a snapshot only in answer to a solicited observe, so the object's identity
 * is what distinguishes "the world was read again" from "the same read was looked at again", and counting the second as
 * a reading would let a run claim it had seen the world twice.
 *
 * `print` is where the live lines go (the run's stderr); `heartbeatMs` is the silence that earns one; and
 * `pauseOnUnfocus` is the run's own probe for who cleared the engine's pause-when-out-of-focus, read lazily so a
 * heartbeat carries it (`assessPauseOnUnfocus`) instead of the reader having to assume it.
 *
 * `solicit` is how the beat asks the world for a reading of its own, and it answers one of three shapes, because "the
 * bridge refused" and "there is no bridge to ask" are different facts that an operator acts on differently:
 *
 *   - `{ reading }` - the world was read (the reading itself is already `observe`d by the caller, so it prints there);
 *   - `{ reason }` - the bridge was asked and refused, naming its own code;
 *   - `{ notAttempted: reason }` - nothing was asked (no bridge yet, or one that has closed).
 */
export function createGameClock({
  now = () => Date.now(),
  print = (line) => console.error(line),
  heartbeatMs = GAME_CLOCK_HEARTBEAT_MS,
  pauseOnUnfocus = null,
  solicit = null,
} = {}) {
  const startedAtMs = now();
  const readings = [];
  const misses = [];
  let samples = 0;
  let lastSnapshot = null;
  let lastSolicitAtMs = null;
  let bridgeClosed = false;

  /**
   * HOW MANY READINGS EACH CALLER CONTRIBUTED, derived from the readings themselves.
   *
   * Grouped rather than counted per tag, so a new caller appears here by name without anyone editing a list - and so no
   * channel can be the one the AGE depends on. This is the number that says "the beat is the only one reading", which
   * `round66`/`round67` had to infer from a silence that was not there.
   */
  const readingsByChannel = () => {
    const counts = Object.create(null);
    for (const reading of readings) counts[reading.source] = (counts[reading.source] ?? 0) + 1;
    return Object.freeze(counts);
  };

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
    print(describeRead({ reading, first: readings[0] }));
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
    const factState = classifyFacts({ counted, verdict });
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
      // WHO read the world, per channel: `snapshotsSeen` alone cannot say whether the run's own sampling is doing any
      // reading at all, and a run where one caller is the only reader is a fact about the run.
      readingsByChannel: readingsByChannel(),
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
        readingsByChannel: readingsByChannel(),
      }),
    });
  };

  /**
   * One reading the beat asks for itself, bounded and named. The bound is checked HERE rather than at the call site: a
   * beat that fires from a waiting loop must not become a poll of the bridge.
   */
  const solicitOnce = async (atMs) => {
    if (solicit === null) return { state: "not_attempted", reason: "no_solicitation_bound", reading: null };
    if (bridgeClosed) return { state: "not_attempted", reason: "bridge_closed", reading: null };
    if (lastSolicitAtMs !== null && atMs - lastSolicitAtMs < heartbeatMs)
      return { state: "not_attempted", reason: "inside_heartbeat_bound", reading: null };
    lastSolicitAtMs = atMs;
    let answer;
    try {
      answer = await solicit();
    } catch (error) {
      // A solicit that threw is a failed ask, never a beat that kills the run it is describing.
      return { state: "solicit_failed", reason: String(error?.message ?? error).slice(0, 120), reading: null };
    }
    if (answer?.reading !== null && answer?.reading !== undefined)
      return { state: "read", reason: null, reading: answer.reading };
    if (answer?.notAttempted !== null && answer?.notAttempted !== undefined)
      return { state: "not_attempted", reason: String(answer.notAttempted), reading: null };
    return { state: "solicit_failed", reason: String(answer?.reason ?? "no_reading_returned"), reading: null };
  };

  /**
   * A beat of the live instrument: ASK the world for a reading, then report a silence that survived the ask - or
   * `line: null` when the world is not silent (the read lines are already that interval's record, and a beat per tick
   * would bury them).
   *
   * THE SILENCE IS MEASURED FROM THE NEWEST READING OF ANY CHANNEL, and the ask comes first, because the ask is a reading
   * too. `round66`/`round67` measured this from the last reading tagged `snapshot`, which is stamped by whoever read the
   * admitted frame first: the run's own sampling goes quiet when the run stops opening turns, the beat's answers are
   * tagged `solicit`, and the number grew to 199.8 s while the world was read every thirty seconds. A beat whose ask is
   * ANSWERED therefore ends the silence and prints nothing - if it printed, every bound would spend a line on a world that
   * answered every one of them, and the log would claim a stall it had just disproved.
   */
  const heartbeat = async ({ atMs = now() } = {}) => {
    const lastReading = readings.at(-1) ?? null;
    const sinceLastReadingMs = atMs - (lastReading?.atMs ?? startedAtMs);
    if (sinceLastReadingMs < heartbeatMs)
      return Object.freeze({ stalled: false, sinceLastReadingMs, solicit: null, line: null });
    const readingsBefore = readings.length;
    const solicitToken = describeSolicit(await solicitOnce(atMs));
    // The ask answered: the world was never silent, this caller was. The `GAME_CLOCK_READ` the answer printed is this
    // beat's record, and printing a stall line beside it would report a silence the run had just ended.
    if (readings.length > readingsBefore)
      return Object.freeze({ stalled: false, sinceLastReadingMs: 0, solicit: solicitToken, line: null });
    const line = describeStall({
      atMs,
      sinceLastReadingMs,
      lastReading,
      first: readings[0] ?? null,
      solicit: solicitToken,
      heartbeatMs,
      readingsSeen: readings.length,
      readingsByChannel: readingsByChannel(),
      pauseOnUnfocus,
    });
    print(line);
    return Object.freeze({ stalled: true, sinceLastReadingMs, solicit: solicitToken, line });
  };

  /** The bridge this clock reads through is gone: from here the beat says `not_attempted`, it does not go asking. */
  const close = () => {
    bridgeClosed = true;
  };

  return Object.freeze({ observe, observeUnreadable, heartbeat, read, close });
}

/** A solicitation as one token a log tail can carry, in the same shape `pausedOnUnfocus` already uses (`state:detail`). */
function describeSolicit({ state, reason, reading }) {
  if (state === "read") return `read:${reading.timeOfDay}`;
  return `${state}:${reason}`;
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

/** `facts N · game minutes M · per game hour X`, formatted once and used by the object and the printed line. */
function describeFacts({ counted, gameMinutes, spanMinutes, perGameHour }) {
  const facts = counted === null ? "not counted" : String(counted);
  const minutes =
    gameMinutes === null ? (spanMinutes === null ? "unmeasured" : String(spanMinutes)) : String(gameMinutes);
  const rate = perGameHour === null ? "not measured" : String(perGameHour);
  return `facts ${facts} · game minutes ${minutes} · per game hour ${rate}`;
}

/**
 * WHICH CHANNEL READ THE WORLD, as one token a log tail can carry: `snapshot:7, solicit:9`. Empty when nothing was read,
 * because that is the run that has no channel at all.
 */
function describeChannels(readingsByChannel) {
  const entries = Object.entries(readingsByChannel);
  return entries.length === 0 ? "none" : entries.map(([channel, count]) => `${channel}:${String(count)}`).join(", ");
}

/** What the facts the run recorded say, given whether the clock gave them a denominator at all. */
function classifyFacts({ counted, verdict }) {
  if (counted === null) return "facts_not_counted";
  if (counted > 0) return "facts_observed";
  // Zero facts means something different in each of these shapes, and they must never publish the same word: over a
  // moving world it is a real finding about the Mod or the bridge, over a still one it is the clock's own answer, and
  // everywhere else the DENOMINATOR is missing - a run that looked once was never able to see a rate at all.
  if (verdict === "advanced") return "no_facts_while_the_world_moved";
  if (verdict === "never_advanced") return "still_world";
  return "span_not_measured";
}

/** The one line the run prints, built from the same values the object publishes. */
function describeClock({
  readings,
  first,
  last,
  spanMinutes,
  verdict,
  reasonCode,
  looks,
  unreadable,
  factsReading,
  readingsByChannel,
}) {
  const clock = first === null ? "unread" : `${first.timeOfDay}->${last.timeOfDay}`;
  const span = spanMinutes === null ? "" : ` (${spanMinutes > 0 ? "+" : ""}${spanMinutes} min)`;
  const looksText = `${readings.length} reading(s) of ${looks} snapshot read(s) by ${describeChannels(readingsByChannel)}`;
  const missed = unreadable === 0 ? "" : ` · ${unreadable} unreadable`;
  const answer = verdict === "advanced" ? "the world moved" : (reasonCode ?? verdict);
  return `game_clock ${clock}${span} · ${looksText}${missed} · ${answer} · ${factsReading}`;
}

/**
 * The fields one reading contributes to a printed line, spelled once for both lines that carry readings.
 *
 * `minutesSinceFirst` is a GAME span on the same axis `spanOf` lays readings on, so a log tail shows the clock moving in
 * the game's own unit (and a night it crossed correctly) rather than in wall minutes the world does not experience.
 */
function readingFields({ reading, first }) {
  if (reading === null) return null;
  return {
    atMs: reading.atMs,
    source: reading.source,
    timeOfDay: reading.timeOfDay,
    day: reading.day,
    season: reading.season,
    year: reading.year,
    minutesSinceFirst: spanOf([first, reading]),
  };
}

/**
 * `GAME_CLOCK_READ {atMs, source, timeOfDay, day, season, year, minutesSinceFirst}` - one read of the world, printed as
 * it happens. `source` is WHO read it, never whether fresh data arrived: `solicit` is the beat's own ask and `snapshot`
 * the run's sampling, and both read the same admitted frame through the same bridge client.
 */
function describeRead({ reading, first }) {
  return `GAME_CLOCK_READ ${JSON.stringify(readingFields({ reading, first }))}`;
}

/**
 * `GAME_CLOCK_STALLED {...}` - a silence of the world, on EVERY channel, with the clock the beat just read.
 *
 * `sinceLastReadingMs` is the age of the newest reading of any channel and keeps growing only while nothing at all is
 * read; `solicit` says whether this beat asked and what came back; `lastReading` is that newest reading (`null` says no
 * reading was ever taken, not that the sampler forgot); and `readingsByChannel` says WHO has been reading, so "the beat is
 * the only one" is a number rather than an inference from the size of the silence - the shape `round66`/`round67` read
 * as a frozen world with nine fresh readings in the same log.
 */
function describeStall({
  atMs,
  sinceLastReadingMs,
  lastReading,
  first,
  solicit,
  heartbeatMs,
  readingsSeen,
  readingsByChannel,
  pauseOnUnfocus,
}) {
  return `GAME_CLOCK_STALLED ${JSON.stringify({
    atMs,
    sinceLastReadingMs,
    heartbeatMs,
    readingsSeen,
    readingsByChannel,
    solicit,
    lastReading: readingFields({ reading: lastReading, first }),
    pausedOnUnfocus: describePauseOnUnfocus(pauseOnUnfocus),
    note: lastReading === null ? "no_reading_since_run_start" : "no_reading_since_that_read",
  })}`;
}

/**
 * The pause-on-unfocus reading as one token a log tail can carry: the probe's own `state`, with the window mode it
 * settled or the reason it could not. `not_probed` and `not_established` are different statements - the first says nobody
 * asked, the second says the run asked and its own Mod log did not answer.
 */
function describePauseOnUnfocus(pauseOnUnfocus) {
  if (pauseOnUnfocus === null) return "not_probed";
  const assessment = pauseOnUnfocus();
  const detail = assessment.reason ?? assessment.windowMode ?? null;
  return detail === null ? assessment.state : `${assessment.state}:${detail}`;
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
