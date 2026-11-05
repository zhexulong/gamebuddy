/**
 * Did the companion's turn settle?
 *
 * The runner's `runAgentTurn` returns `{ turn, status }`, and the fact lives on `turn.settled`. Reading the
 * envelope's own field is `undefined !== true`, i.e. always "not settled" — which is how the day loop came to
 * break after the first turn of every day: day 2 was judged idle (`next_day_produced_no_farm_work`) and the
 * scheduled player lines stayed unreachable (`no_reply_recorded` on all four).
 *
 * One accessor, in its own module, because the runner cannot be imported by a test (it reads the scenario from
 * the environment at module scope) and a second spelling of this question is exactly how the defect survives.
 */
export function turnSettled(walked) {
  return walked?.turn?.settled === true;
}
