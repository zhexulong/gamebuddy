/**
 * What a run spent its MODEL ROUND TRIPS on, as two ratios, printed beside the delivery account.
 *
 * <p>
 * The cost this run pays is the model turn, not the tool call. Measured `round43` (20.0 min wall clock, 1,201 s): 96
 * assistant turns and 97 tool calls, of which **29 turns were `stardew_action_program_status`** - 30% of the run's model
 * time asking whether a plan was done, at ~9.4 s a turn. Model time was 1,075 s of the 1,201 s; tool execution was 125 s.
 * A run can look busy and healthy from its execution counts while a third of its thinking is spent asking a question
 * whose answer was already on the way.
 * </p>
 * <p>
 * TWO RATIOS, EACH WITH ITS POPULATION BESIDE IT. `plan_polls_per_programme` is status reads over programmes the Mod
 * accepted; `turns_per_completed_action` is model turns over actions that reached a terminal state. A ratio without its
 * two counts cannot be checked, and both numbers come from files the run already publishes
 * (`toolTiming.planCalls`/`toolTiming.modelTurns` from the bound session record, `programSubmissions` and the execution
 * trace from the bridge), so nothing here is measured twice.
 * </p>
 * <p>
 * THE THREE ZEROES STAY APART. A measured zero is `0` and is printed. A quantity that could not be read is the string
 * `not_measured` with the field it was missing named beside it (`not_measured` reasons below), because a ratio of two
 * unknown populations and a run that genuinely never polled are different answers and only one of them is good news.
 * </p>
 */

/** `not_measured` is the value every unreadable metric carries; the reason is beside it in its own field. */
export const NOT_MEASURED = "not_measured";

/** Round to the hundredth: a reader quotes the ratio, so it must be the number that was computed. */
function ratio(numerator, denominator) {
  return Math.round((numerator / denominator) * 100) / 100;
}

/**
 * The two ratios, or `not_measured` with the missing population named.
 *
 * `null` means "the population could not be read", and it is the caller's job to pass `null` rather than a `0` for it: an
 * unbound session record and a session that made no calls are different facts, and the runner knows which one it has.
 */
export function summarizeRunCost({ planPolls, programmes, modelTurns, completedActions }) {
  const programmeCount = Number.isInteger(programmes) ? programmes : null;
  const pollCount = Number.isInteger(planPolls) ? planPolls : null;
  const turnCount = Number.isInteger(modelTurns) ? modelTurns : null;
  const completedCount = Number.isInteger(completedActions) ? completedActions : null;

  // A run that never asked is a measured zero whatever it submitted: there is nothing to divide to learn that.
  const pollMissing =
    pollCount === null
      ? "session_record_unbound"
      : pollCount > 0 && programmeCount === 0
        ? "no_programmes_submitted"
        : programmeCount === null
          ? "programme_count_unavailable"
          : null;
  const turnsMissing =
    turnCount === null
      ? "session_record_unbound"
      : completedCount === null
        ? "execution_trace_unavailable"
        : completedCount === 0
          ? "no_completed_actions"
          : null;

  return Object.freeze({
    plan_polls_per_programme: pollMissing === null ? ratio(pollCount, programmeCount) : NOT_MEASURED,
    plan_polls: pollCount,
    programmes: programmeCount,
    plan_polls_not_measured: pollMissing,
    turns_per_completed_action: turnsMissing === null ? ratio(turnCount, completedCount) : NOT_MEASURED,
    model_turns: turnCount,
    completed_actions: completedCount,
    turns_not_measured: turnsMissing,
  });
}

/** One line for a reader who is not parsing: both ratios, both populations, and what was not measurable. */
export function describeRunCost(account) {
  const polls =
    account.plan_polls_per_programme === NOT_MEASURED
      ? `${NOT_MEASURED}:${account.plan_polls_not_measured}`
      : `${account.plan_polls_per_programme} (${account.plan_polls} polls of ${account.programmes} programmes)`;
  const turns =
    account.turns_per_completed_action === NOT_MEASURED
      ? `${NOT_MEASURED}:${account.turns_not_measured}`
      : `${account.turns_per_completed_action} (${account.model_turns} turns per ${account.completed_actions} completed actions)`;
  return `plan polls per programme ${polls} · turns per completed action ${turns}`;
}
