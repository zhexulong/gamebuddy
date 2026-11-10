/**
 * What the companion is doing, as a state the player could be shown without her saying a word.
 *
 * <p>
 * WHY THIS EXISTS: MEASURED 2026-11-06 (`round39`): the first visible text arrived 902 s after the run started and one
 * stretch inside it put nothing in front of the player for 709 s. A player watching an empty screen cannot tell "she is
 * thinking" from "something crashed", and afterwards no artifact could say which it was - a silent stretch is not a fact
 * any layer recorded. So the pump's own knowledge of a turn, a request, a tool call and an execution is published as a
 * closed state machine, one point per transition, and the run bundle reads those points back
 * (`tools/lib/companion-activity.mjs`).
 * </p>
 * <p>
 * PRESENTATION, NOT DIALOGUE. A state here is system state: it enters neither the assembled prompt nor the presented
 * message text, and no sentence is written for it. This module deliberately carries no copy at all - the only words a
 * game thread accepts under a key are the registered lines in `system-notices.ts`, and inventing a spoken line for
 * "working" would put the machinery in her voice. The point is the whole deliverable: a surface that can draw state,
 * and a bundle that can be asked what the state was.
 * </p>
 * <p>
 * DERIVED, NEVER AUTHORED. Nothing here decides anything: every transition is published by `companion-loop.ts` from a
 * fact it already has (a batch became a turn, Pi consumed it, her text arrived, a tool started, the pump holds a
 * receipt, the pump has nothing pending). There is no second flag to disagree with those facts, and she cannot say a
 * state - the model never sees this channel.
 * </p>
 */

/**
 * The closed set, in the order a turn usually visits it. One declaration: the point type, the publisher and the
 * bundle's reader are all derived from this list, so a state cannot be spelled two ways.
 *
 * - `thinking`: a turn exists and the model has not answered yet - either a wake created it, or the request is out.
 * - `speaking`: her own text is arriving.
 * - `working`: a tool call of hers is executing.
 * - `busy`: an execution she started is still in flight in the world.
 * - `idle`: the turn ended with nothing pending, so nothing will wake her until the world or the player does.
 */
export const COMPANION_ACTIVITY_STATES = Object.freeze(["thinking", "speaking", "working", "busy", "idle"] as const);

export type CompanionActivityState = (typeof COMPANION_ACTIVITY_STATES)[number];

/** One transition: the state from this moment on, and the wall-clock millisecond it was entered. */
export type CompanionActivityPoint = Readonly<{ state: CompanionActivityState; atMs: number }>;

/**
 * The artifact line name, read back by `tools/lib/companion-activity.mjs`.
 *
 * Same channel and shape as the per-turn delivery account (`NATIVE_COMPANION_TURN_DELIVERY`, `companion-loop.ts`): one
 * line on the Host's own log, printed where the fact happened, so a run's log and its bundle describe the same points.
 * The name is asserted against the reader's constant by that reader's test, so two spellings of it cannot drift apart.
 */
export const COMPANION_ACTIVITY_LINE = "COMPANION_ACTIVITY";

export type CompanionActivityIndicator = Readonly<{
  /**
   * Publishes one transition.
   *
   * Every transition is published, including one to the state already current: `thinking` is entered by a wake AND by
   * the request going out, and a reader asking "when did the provider actually receive this turn" needs the second
   * point. Suppressing repeats would be the "only the interesting transitions" filter this channel exists to avoid.
   */
  transition(state: CompanionActivityState): void;
  /** The state this indicator last published, or `null` before the first transition. */
  readonly current: CompanionActivityState | null;
}>;

/** Where a point lands by default: one line on the Host's log, beside every other Host artifact line. */
function publishToHostLog(point: CompanionActivityPoint): void {
  try {
    process.stderr.write(`${COMPANION_ACTIVITY_LINE} ${JSON.stringify(point)}\n`);
  } catch {
    // Observational. A log write must never decide a turn, for the reason `#emitLiveEvidence` in
    // `companion-loop.ts` takes the same position - and a channel that lost its points is visible in the bundle as
    // `not_measured` rather than read as a companion who was never idle.
  }
}

/**
 * The one recorder. `now` and `publish` are injectable for the same reason every other clock in this codebase is: a
 * test has to be able to see the exact sequence, and a live run has to write the points it would have shown.
 */
export function createCompanionActivityIndicator(
  options: Readonly<{ now?: () => number; publish?: (point: CompanionActivityPoint) => void }> = {},
): CompanionActivityIndicator {
  const now = options.now ?? (() => Date.now());
  const publish = options.publish ?? publishToHostLog;
  let current: CompanionActivityState | null = null;
  return Object.freeze({
    transition(state: CompanionActivityState): void {
      // Built and published in one step: a point exists only as something a reader can see, so there is no record
      // kept here that could hold a transition the bundle never received.
      const point = Object.freeze({ state, atMs: now() });
      current = state;
      publish(point);
    },
    get current(): CompanionActivityState | null {
      return current;
    },
  });
}
