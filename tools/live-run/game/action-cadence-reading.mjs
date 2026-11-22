/**
 * WHAT `actionCadence.thinkMs` ACTUALLY MEASURES, and when it can answer "how much was the model thinking".
 *
 * <p>
 * `summarizeActionCadence` (`tools/lib/action-cadence.mjs`) defines `thinkMs` as the span from one FLAT action's terminal
 * to the next FLAT action's dispatch. On a run whose work goes through Body Programs the flat channel holds a handful of
 * dispatches and everything the run does - the program executions, the model's turns, the harness's waits - happens
 * INSIDE those spans. Measured 2026-11-21 (`round87b`): `thinkMs.sum 1345.4 s` and `thinkMs.max 645.1 s` against
 * `execMs.sum 468.5 s`, read as "22.4 minutes of thinking against 7.8 of acting". The 1345.4 s is twelve gaps between
 * thirteen `express_emote` dispatches out of that run's 293 actions, and the 645.1 s one contains a whole day boundary:
 * `run-progress.jsonl` opened `turn_started turn 1` 343 s into it. Nothing in the field says which of the two things a
 * reader is looking at, so the reader guessed - and the guess was the flattering one.
 * </p>
 * <p>
 * SO THE PUBLISHED FIELD IS SPLIT rather than the arithmetic re-done: when the gap can hold anything but the decision,
 * `thinkMs` is `null` with the reason in `thinkMsNotMeasured`, and the number the flat channel did measure is published
 * as `dispatchGapMs` - the same spans, under a name that says what they are. The measured answer to the thinking question
 * is elsewhere and already in the artifacts: the session record's assistant-message durations (`round87b`: 990.2 s
 * inside messages = 49.9 % of the wall), which `round-verdict` prints.
 * </p>
 * <p>
 * WHY A SEPARATE READER, used by both the runner and the verdict: a run whose bundle predates this split still carries
 * `flat`/`program`/`thinkMs`, and the same rule answers for it. One authority, two readers.
 * </p>
 */

/**
 * Whether the published `thinkMs` span answers "the model deciding", and why not when it does not.
 *
 * `flat` is how many actions were dispatched on the runner's own clock (the channel `thinkMs` is computed from);
 * `program` is how many executions arrive from the Mod's clock. A `thinkMs` span only exists between two flat dispatches,
 * so fewer than two of them is an empty set, and any program execution means the gap is not the model's alone.
 */
export function readThinkGap(cadence) {
  const flat = Number.isInteger(cadence?.flat) ? cadence.flat : 0;
  const program = Number.isInteger(cadence?.program) ? cadence.program : 0;
  const span = cadence?.thinkMs ?? null;
  if (flat < 2)
    return Object.freeze({
      answers: false,
      span,
      reason: `no_flat_dispatch_pair:${String(flat)}_flat_of_${String(flat + program)}_actions`,
    });
  if (program > 0)
    return Object.freeze({
      answers: false,
      span,
      reason: `program_work_inside_the_gap:${String(flat)}_flat_of_${String(flat + program)}_actions`,
    });
  return Object.freeze({ answers: true, span, reason: null });
}

/**
 * The cadence as the artifact publishes it: `thinkMs` present only when it answers, the reason beside it when it does
 * not, and the flat channel's own spans kept under the name of what they measure.
 */
export function publishCadence(cadence) {
  const gap = readThinkGap(cadence);
  if (gap.answers) return Object.freeze({ ...cadence, thinkMsNotMeasured: null, dispatchGapMs: null });
  return Object.freeze({
    ...cadence,
    thinkMs: null,
    thinkMsNotMeasured: gap.reason,
    dispatchGapMs: gap.span,
  });
}
