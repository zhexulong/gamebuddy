/**
 * Day-level replay's game-clock gate.
 *
 * A live run's dispatch moments are game times, not wall-clock offsets: the world clock advances
 * while the Agent thinks, so replaying a trace "as fast as receipts settle" reaches game 6:20 where
 * the original run reached 10:00 and fails on a shop that has not opened yet. The gate therefore
 * WAITS for the recorded moment instead of writing `timeOfDay` or skipping the step.
 *
 * Grounded in the engine: `Game1.gameTimeInterval` accumulates elapsed milliseconds and only fires
 * `performTenMinuteClockUpdate()` past `realMilliSecondsPerGameTenMinutes`, which is
 * `realMilliSecondsPerGameMinute * 10` with the default 700 (Game1.cs:2139-2140, :6050-6089).
 */

/** 7 s of wall clock per 10 game minutes, from the engine's own default. */
export const REAL_MILLISECONDS_PER_GAME_MINUTE = 700;

/** The day starts at 6:00 and the player passes out at 2:00 AM. */
export const FIRST_GAME_TIME = 600;
export const PASS_OUT_GAME_TIME = 2600;

const HHMM = /^([0-9]{3,4})$/u;

/**
 * Parses the bridge's `inGameTime` HHMM string (`"620"`, `"900"`, `"2600"`). The wire form is a
 * string, so a number is a contract violation rather than a value to coerce, and anything the engine
 * cannot be at is invalid rather than rounded.
 */
export function parseInGameTime(value) {
  if (typeof value !== "string" || !HHMM.test(value)) return null;
  const timeOfDay = Number.parseInt(value, 10);
  if (timeOfDay < FIRST_GAME_TIME || timeOfDay > PASS_OUT_GAME_TIME) return null;
  const minutes = timeOfDay % 100;
  if (minutes % 10 !== 0) return null;
  return timeOfDay;
}

/**
 * The one decision the replay engine asks before dispatching step k.
 *
 * `wait` is an answer, not a failure: the actor stays idle and asks again. `fail` means the recorded
 * moment can no longer be reproduced faithfully, and the caller must abort with that reason code
 * rather than dispatch early or rewind the clock.
 */
export function decideReplayDispatch(recordedTimeOfDay, currentTimeOfDay, { waitedMs = 0, maxWaitMs = null } = {}) {
  const recorded = parseInGameTime(recordedTimeOfDay);
  const current = parseInGameTime(currentTimeOfDay);
  if (recorded === null || current === null) {
    return Object.freeze({ decision: "fail", reasonCode: "replay_clock_input_invalid", gapGameMinutes: null });
  }
  if (recorded >= PASS_OUT_GAME_TIME) {
    return Object.freeze({ decision: "fail", reasonCode: "replay_clock_target_passed_out", gapGameMinutes: null });
  }
  if (current >= PASS_OUT_GAME_TIME) {
    return Object.freeze({
      decision: "fail",
      reasonCode: `replay_clock_behind:${recorded}:${current}`,
      gapGameMinutes: null,
    });
  }
  if (current >= recorded) {
    return Object.freeze({ decision: "dispatch", reasonCode: null, gapGameMinutes: 0 });
  }
  const gapGameMinutes = minutesOf(recorded) - minutesOf(current);
  if (maxWaitMs !== null && waitedMs >= maxWaitMs) {
    return Object.freeze({
      decision: "fail",
      reasonCode: `replay_clock_wait_exhausted:${recorded}:${current}`,
      gapGameMinutes,
    });
  }
  return Object.freeze({ decision: "wait", reasonCode: null, gapGameMinutes });
}

function minutesOf(timeOfDay) {
  return Math.floor(timeOfDay / 100) * 60 + (timeOfDay % 100);
}

/**
 * What one replay of `actionTrace` is expected to spend waiting, so `repro.json` can budget it
 * instead of letting the replay hit an unrelated harness timeout.
 */
export function expectedReplayWallClockMs(actionTrace, { msPerGameMinute = REAL_MILLISECONDS_PER_GAME_MINUTE } = {}) {
  if (!Array.isArray(actionTrace)) return null;
  const steps = [];
  let totalMs = 0;
  let previous = null;
  for (const [index, entry] of actionTrace.entries()) {
    const timeOfDay = parseInGameTime(entry?.inGameTime);
    if (timeOfDay === null) return null;
    const previousMinutes = previous === null ? minutesOf(timeOfDay) : minutesOf(previous);
    const gapMinutes = Math.max(0, minutesOf(timeOfDay) - previousMinutes);
    const waitMs = index === 0 ? 0 : gapMinutes * msPerGameMinute;
    steps.push(Object.freeze({ index, inGameTime: timeOfDay, gapMinutes, waitMs }));
    totalMs += waitMs;
    previous = timeOfDay;
  }
  return Object.freeze({ totalMs, steps: Object.freeze(steps) });
}
