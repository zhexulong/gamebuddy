// The verdict for a night that did NOT cross, and the one line that states a run's crossings.
//
// In a shared save the companion's own `sleep` does NOT end the day. She declares local ready through the native
// barrier, `ReadyCheckDialog("sleep")` shows 1/2, and the host player keeps playing; the day crosses when the host
// also goes to bed or when the engine passes the actors out at 26:00 (`Game1.cs:6452-6460`). The lifecycle never
// calls `NewDay` on its own and reports the wait as `requires_other_player`
// (`SleepAndAdvanceDayLifecycle.cs:1056-1101`, `design/.../loop-m2-cross-day-seam-decision.md` §12.3/§14).
//
// ONE reason code for every uncrossed night could not tell her failure from the host player's absence, and the
// difference is the whole question: `companion_did_not_sleep` reads as a judgement about her, while a night she
// went to bed on and the host did not is the host's absence. Measured 2026-11-05
// (`2026-11-05T11-37-35-764Z-multiday_routine`): `crossings 0 of 2` under that one code, with nothing in the reason
// saying which of the three nights it had been. The three cases are:
//
//   (a) she never entered the day-advance path - no `sleep` in the night's window: her failure;
//   (b) she entered it and the native barrier never completed - the other players own it, and the receipt says
//       so (`requires_other_player`): NOT her failure;
//   (c) her `sleep` came back REFUSED with a code - a defect with a name, which must be quoted rather than
//       collapsed into either of the above.
//
// This module is the one place that splits them, so the watcher's reason, the day record published in the artifact
// and the summary line cannot describe the same night differently.
import { parseReceiptEvidence } from "../../lib/multiday-baseline.mjs";

/** No `sleep` dispatch reached the game in this night's window: she never entered the day-advance path. */
export const COMPANION_DID_NOT_SLEEP = "companion_did_not_sleep";

/** Her `sleep` declared local ready and the native barrier never completed - the other players own it. */
export const COMPANION_SLEPT_HOST_PLAYER_DID_NOT = "companion_slept_host_player_did_not";

/** Her `sleep` came back named: the action was declined and the night never started. The code follows this name. */
export const COMPANION_SLEEP_REFUSED = "companion_sleep_refused";

/** Her `sleep` reached a terminal that is neither a crossing, a wait, nor a refusal. The state follows this name. */
export const COMPANION_SLEEP_UNRESOLVED = "companion_sleep_unresolved";

/**
 * The Mod's own name for the barrier nobody on this machine can complete
 * (`SleepAndAdvanceDayLifecycle.cs:1091-1099`).
 */
const OTHER_PLAYER_OWNS_THE_BARRIER = "requires_other_player";

/**
 * The receipt states that mean the action was DECLINED (`farmhandexecutioncontroller.lifecycleactions.cs:135-154`,
 * `ExecutionState`). `uncertain` is deliberately absent: doubt about an effect is not a refusal of one, and calling
 * it a refusal is exactly the false certainty this file exists to remove.
 */
const REFUSAL_STATES = Object.freeze(new Set(["blocked", "rejected", "failed", "expired", "cancelled", "invalidated"]));

const isCrossing = (terminal) => terminal.state === "succeeded" && terminal.reasonCode === "day_advanced";

/**
 * What the dispatch was reaching for, from the receipts' own `key=value` evidence.
 *
 * The ACCEPTED receipt is read before the terminal because that is where the Mod publishes it: a `sleep`
 * dispatch is admitted with `target=own_bed;never_direct_new_day=true`
 * (`farmhandexecutioncontroller.lifecycleactions.cs:108-117`) and its terminal publishes what came of it, not where
 * it was going. Quoting a refusal code without its target names a failure with no subject.
 */
function targetOf(witness) {
  const target =
    parseReceiptEvidence(witness.accepted?.evidence).target ?? parseReceiptEvidence(witness.terminal?.evidence).target;
  return typeof target === "string" && target.length > 0 ? target : null;
}

/** The receipt that carries a witness's own reason, in the shape the run artifact publishes. */
function receiptOf(witness) {
  return Object.freeze({
    requestId: witness.requestId,
    target: targetOf(witness),
    state: witness.terminal === null ? null : witness.terminal.state,
    reasonCode: witness.terminal === null ? null : witness.terminal.reasonCode,
    evidence: witness.terminal === null ? null : (witness.terminal.evidence ?? null),
  });
}

/**
 * Why this night never crossed, from what her own dispatches recorded.
 *
 * `witnesses` are her `sleep` dispatches inside the night's window - one entry per request, carrying the receipt it
 * was admitted with and the receipt that ended it (`null` while none has). The companion's `sleep` is the only
 * thing that starts a `SleepAndAdvanceDayLifecycle`, so the absence of a witness IS "she never entered the
 * path", and nothing the harness observed can stand in for one.
 *
 * A wait outranks a refusal outranks an unattributable terminal: a night with any dispatch that declared local
 * ready was a night she went to bed, whatever an earlier attempt of the same night came back as.
 */
export function judgeUncrossedNight({ witnesses = [] } = {}) {
  if (witnesses.length === 0)
    return Object.freeze({ reasonCode: COMPANION_DID_NOT_SLEEP, sleepReceipt: null, refusal: null });

  const waiting = witnesses.find((witness) => witness.terminal?.reasonCode === OTHER_PLAYER_OWNS_THE_BARRIER);
  if (waiting !== undefined) {
    return Object.freeze({
      reasonCode: COMPANION_SLEPT_HOST_PLAYER_DID_NOT,
      sleepReceipt: receiptOf(waiting),
      refusal: null,
    });
  }

  const declined = witnesses.find(
    (witness) =>
      witness.terminal !== null && REFUSAL_STATES.has(witness.terminal.state) && !isCrossing(witness.terminal),
  );
  if (declined !== undefined) {
    const code = declined.terminal.reasonCode;
    return Object.freeze({
      reasonCode: `${COMPANION_SLEEP_REFUSED}:${code}`,
      sleepReceipt: receiptOf(declined),
      refusal: Object.freeze({ code, target: targetOf(declined) }),
    });
  }

  const other = witnesses.find((witness) => witness.terminal === null || !isCrossing(witness.terminal));
  const state = other.terminal === null ? "in_flight" : `${other.terminal.state}/${other.terminal.reasonCode}`;
  return Object.freeze({
    reasonCode: `${COMPANION_SLEEP_UNRESOLVED}:${state}`,
    sleepReceipt: receiptOf(other),
    refusal: null,
  });
}

/** The case a verdict's reason code belongs to, or null when it is not a sleep verdict at all. */
export function sleepVerdictCase(reasonCode) {
  if (typeof reasonCode !== "string") return null;
  const base = reasonCode.split(":")[0];
  return [
    COMPANION_DID_NOT_SLEEP,
    COMPANION_SLEPT_HOST_PLAYER_DID_NOT,
    COMPANION_SLEEP_REFUSED,
    COMPANION_SLEEP_UNRESOLVED,
  ].includes(base)
    ? base
    : null;
}

const clockText = (bedTime) => (Number.isInteger(bedTime) ? String(bedTime) : "an unobserved clock");

/**
 * The run's crossings, in ONE line, next to the case that explains them.
 *
 * `crossings 0` is the same number whether a night went wrong on her side or on the host player's, and a reader who
 * takes the count alone will read (b) as (a) - the defect this file answers. So the count never travels without the
 * night that explains it, and (b) says in words that it is not her failure. The count is stated as what the RUN
 * recorded, not as what the world did: the watcher stops when the clock is spent, which can be the same second the
 * engine's own 26:00 pass-out crosses the day (`2026-11-05T11-37-35-764Z-multiday_routine` recorded `crossings 0` for
 * a night `night_ended_pass_out_day_4` crossed).
 */
export function summarizeCrossings({ crossings, requestedCrossings, nights = [] } = {}) {
  const head = `crossings ${String(crossings)} of ${String(requestedCrossings)}`;
  const failed = nights.find((night) => sleepVerdictCase(night?.nightVerdict?.reasonCode) !== null);
  if (failed === undefined) {
    return crossings === requestedCrossings
      ? `${head}: every night the run was asked for crossed`
      : `${head}: the run stopped before the night it was on had ended`;
  }
  const verdict = failed.nightVerdict;
  const label = `night ${String(failed.day)}`;
  switch (sleepVerdictCase(verdict.reasonCode)) {
    case COMPANION_SLEPT_HOST_PLAYER_DID_NOT:
      return (
        `${head}: ${label} - she slept at ${clockText(verdict.bedTime)} and declared local ready; the native barrier ` +
        "never completed, so that wait was the other players' - the run recorded no crossing for it, and that is " +
        "NOT a companion failure"
      );
    case COMPANION_SLEEP_REFUSED:
      return (
        `${head}: ${label} - her sleep was refused ` +
        `(${verdict.refusal.code}, target ${verdict.refusal.target ?? "not_published"}), so the run recorded no crossing for it`
      );
    case COMPANION_SLEEP_UNRESOLVED:
      return (
        `${head}: ${label} - her sleep ended without crossing ` +
        `(${verdict.reasonCode.slice(COMPANION_SLEEP_UNRESOLVED.length + 1)}), so the run recorded no crossing for it`
      );
    default:
      return `${head}: ${label} - she never entered the day-advance path (no sleep receipt), so the run recorded no crossing for it and this one is her failure`;
  }
}
