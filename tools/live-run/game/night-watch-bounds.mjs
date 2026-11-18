/**
 * The bounds the harness gives ONE night, and the hours it judges the night by.
 *
 * Harness bounds, not product verdicts: they have to OUTLIVE the day turn they accompany, and the sleep hour is the
 * engine's own pass-out (26:00) rather than a scenario's preference. Spelled once, here, so the watcher, the day loop and
 * the late-day prompt cannot each carry their own hour.
 */

/**
 * How long ONE night's rollover may take before the harness stops watching. A harness bound, not a product
 * verdict - and it has to OUTLIVE the day it is waiting for.
 *
 * It was ten minutes, which is shorter than the day turn it runs alongside (`turnWaitSeconds` is 1800 for the
 * self-directed scenarios). Measured on g39home: 78 actions of real farm work over about ten and a half minutes,
 * the watcher's own bound expired while the day turn was STILL RUNNING, and the run was recorded as
 * `companion_did_not_sleep:day_turn_still_running` - a verdict about a day that had not finished making up its
 * mind, let alone refused to sleep. The watcher already distinguishes the two honest cases: when the day turn
 * SETTLES with no `sleep`, it reports `companion_did_not_sleep` at once. This bound only has to sit past
 * the turn budget, so the run budget stays the hard stop.
 */
// The engine's own pass-out hour: at 26:00 the actor collapses and the day rolls over by itself
// (`Game1.cs:6452-6460`, `timeOfDay >= 2600 || player.stamina <= -15f`). This is the LAST moment a night can
// still be the companion's own; anything earlier is a judged value rather than a native fact.
//
// `readWorldClock().spent` used to compare against 22:00 and the night watcher answered `companion_did_not_sleep`
// the moment a settled turn found the clock past it. Measured 2026-10-26: the companion reached 22:00, said
// "Time to sleep ... let me observe first then sleep", and the watcher had already called it a refusal - a
// verdict about the harness's hour, reported as a verdict about her behaviour, arriving before the dispatch it had
// announced. The sleep hour is therefore the engine's, not the scenario's.
export const PASS_OUT_MINUTES = 26 * 60;

// When the harness stops offering the generic "carry on" and names the clock instead. Not a sleep order: the
// engine's own evening has visibly arrived (`Game1` switches to the night sky at 19:00), so a companion still
// working needs to be told what time it is, not told what to do.
export const LATE_DAY_MINUTES = 19 * 60;

// A day contains turns; this bounds how many, for the harness only. It is not a limit on the day.
export const MAX_TURNS_PER_DAY = Number(process.env.GAMEBUDDY_MULTIDAY_MAX_TURNS_PER_DAY ?? 40);

/**
 * How often a day loop that may NOT wake her re-asks the world whether it now may.
 *
 * A poll rather than a timer per condition: the facts that decide a wake arrive on four different channels (a
 * programme's terminal receipt, the in-game clock, the Host's stall fact, the day's own purpose), and one cadence over
 * all of them cannot miss one. One second is below the resolution of anything it reads and far above the cost of asking.
 */
export const WAKE_POLL_MS = 1_000;
export const MULTIDAY_NIGHT_TIMEOUT_MS = (() => {
  const requested = Number.parseInt(process.env.GAMEBUDDY_MULTIDAY_NIGHT_TIMEOUT_MS ?? "", 10);
  if (Number.isInteger(requested) && requested > 0) return requested;
  // One minute past the 1800s turn budget, so the watcher cannot expire before the turn it accompanies.
  return 31 * 60 * 1000;
})();
/**
 * How long one harness dispatch may take to be admitted, and to reach its terminal.
 *
 * 45 s, not the 120 s this first used: the Mod bounds a request's deadline by the ACTION'S OWN published watchdog
 * (`BridgeSession.IsFreshExecutionRequest`), whose default is 60 s (`BodyProgramModels.cs:153`) - only the
 * cross-day lifecycle publishes 600 s, and the harness never dispatches that (the companion does, through the
 * Host's tool layer, which sizes its deadline from the same descriptor). A 120 s deadline was refused by name
 * with `invalid_deadline` (measured 2026-10-17, run g14), and 45 s leaves slack for the two processes' clock reads
 * differing by the request's transit time.
 */
export const MULTIDAY_DISPATCH_TIMEOUT_MS = 45_000;

/** How long one `dismiss_modal` may take to reach its terminal before the wait is named. */
export const MULTIDAY_DISMISS_TIMEOUT_MS = 60_000;
/**
 * How often the runner re-checks ITS OWN record - 250 ms, and it costs no bridge request.
 *
 * Two waits use it: `waitForNightToBegin` reads the fact log and the cached snapshot until the companion's `sleep` shows
 * up, and the pass-out re-entry asks the watcher again. Neither asks the world anything. The night WATCH is not on this
 * cadence and must not be: it is the one that observes, and `round56` measured what a 250 ms interval costs there - 742
 * observations inside one 208.6 s night, each a whole snapshot rebuilt on the game thread. The watch waits on the Mod's own
 * statements instead (see `worldFacts` below).
 */
export const MULTIDAY_POLL_INTERVAL_MS = 250;
