/**
 * The clock a presented piece is reported on.
 *
 * <p>
 * MEASURED 2026-11-17 (`round67`): `AGENT_PRESENTATION_PIECE {"index":9,"elapsedMs":256503}` was published at the same
 * instant the run's own bridge diagnostic said `elapsedMs: 278984` - 22.5 s early, and all ten pieces of that run were
 * 22.5 s early, because `elapsedMs` was measured from `turnStartedAtMs` while every other elapsed time in the log and the
 * result is measured from the run's base. An artifact whose fields share a name but not an epoch cannot be joined to
 * anything: the delivery account, the silence analysis and the action trace all sit on the run clock.
 * </p>
 * <p>
 * So the piece carries three times, each named for what it measures: `atMs` (absolute, the same value the run's silence
 * analysis reads), `elapsedMs` (from the run's base, the same base as `BRIDGE_DIAGNOSTIC`), and `sinceTurnStartMs` (how
 * long this turn took to produce its first - or next - piece, which is the reading `firstPieceTtfbMs` wants and the only
 * thing the old field ever measured).
 * </p>
 */

/** The run's own base clock. A piece that cannot be placed on it is not placed at all, so this refuses rather than guesses. */
function requireBase(runStartedAtMs) {
  if (typeof runStartedAtMs !== "number" || !Number.isFinite(runStartedAtMs))
    throw new Error(`a presented piece needs the run's base clock, not ${String(runStartedAtMs)}`);
  return runStartedAtMs;
}

/**
 * Both readings of one committed piece: the log line and the bundle's record. Derived together so the two can never
 * disagree about when the player saw it.
 */
export function describePresentationPiece({ index, chars, committedAtMs, runStartedAtMs, turnStartedAtMs = null }) {
  if (typeof committedAtMs !== "number" || !Number.isFinite(committedAtMs))
    throw new Error("a presented piece needs the moment it was committed");
  const base = requireBase(runStartedAtMs);
  const sinceTurnStartMs =
    typeof turnStartedAtMs === "number" && Number.isFinite(turnStartedAtMs) ? committedAtMs - turnStartedAtMs : null;
  return Object.freeze({
    // THE LOG LINE. `elapsedMs` is the run's, so it can be joined to every other elapsed time this run published.
    line: Object.freeze({ index, atMs: committedAtMs, elapsedMs: committedAtMs - base, sinceTurnStartMs, chars }),
    // THE BUNDLE RECORD, which had no absolute clock at all: `check-live-run-silence` reported
    // `presented_text_placed_on_run_clock: unmeasured` for every run because of it.
    piece: Object.freeze({ index, atMs: committedAtMs, sinceTurnStartMs }),
  });
}
