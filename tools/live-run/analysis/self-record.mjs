/**
 * THE RUN'S TWO SELF-RECORDS, each read against the artifact that witnesses it.
 *
 * <p>
 * `result.json` publishes both readings, and both were quoted by a reviewer without the file that could refute them: a
 * `thinkMs.sum` read as model time though it is a dispatch gap with the run's programs inside it, and a turn record's
 * `spokenLines` trusted though the run's own progress record counted nineteen more bubbles for the same turn. The
 * refutation belongs beside the verdict but not inside it - the verdict is already past the repository's size ceiling.
 * </p>
 */

import { seconds, shareToATenth } from "../../lib/action-cadence.mjs";
import { readRunProgressFile } from "../core/run-progress.mjs";
import { readThinkGap } from "../game/action-cadence-reading.mjs";

/**
 * WHAT SHE SAID, counted by the two records that describe it.
 *
 * <p>
 * `result.json` `sessionTurns[].spokenLines` and `run-progress.jsonl`'s `presented` lines are readings of ONE population:
 * the pieces the presentation port committed. `run-progress` writes a line per commit as it lands, so it is the witness;
 * the turn record is derived from that population over a window. Measured 2026-11-21 (`round87b`): the turn record held
 * 4 lines while the progress record and `presentation.pieceCount` both counted 58 bubbles, and day 3's turn held none of
 * the 19 that were presented in its own window. The window used to close when the runner's `await` returned rather than
 * at the next turn's start (`game/turn-speech.mjs`), which is why the last turn of a day lost its speech.
 * </p>
 * <p>
 * TWO ARTIFACTS THAT DISAGREE ABOUT THE SAME TURNS ARE NOT TWO VIEWS. The derivation is named as the wrong one, and the
 * record that was written as the bubbles landed is the witness.
 * </p>
 */
export function speechRecordReading({ runDir, result }) {
  const turns = Array.isArray(result.sessionTurns) ? result.sessionTurns : null;
  // A REFUSED BUBBLE IS STILL A BUBBLE THE PLAYER WAS SHOWN (`game/turn-speech.mjs` `refusedBubbles`), so the two are
  // added back together: counting only `spokenLines` here made one refused bubble read as a turn that spoke one line less
  // than the run presented, which is the disagreement shape this reading exists to report and not one it should invent.
  const recorded =
    turns === null
      ? null
      : turns.map(
          (turn) =>
            (Array.isArray(turn?.spokenLines) ? turn.spokenLines.length : 0) +
            (Array.isArray(turn?.refusedBubbles) ? turn.refusedBubbles.length : 0),
        );
  const refused = turns === null ? [] : turns.flatMap((turn) => (Array.isArray(turn?.refusedBubbles) ? turn.refusedBubbles : []));
  const progress = readRunProgressFile({ dir: runDir });
  const presented = progress === null ? null : progress.presented;
  const pieceCount = Number.isInteger(result.presentation?.pieceCount) ? result.presentation.pieceCount : null;
  const population = presented ?? pieceCount;
  const recordedTotal = recorded === null ? null : recorded.reduce((total, count) => total + count, 0);
  return Object.freeze({
    recorded,
    refused,
    recordedTotal,
    presented,
    pieceCount,
    population,
    perTurn: progress === null ? Object.freeze([]) : progress.presentedByTurn,
    presentedBeforeFirstTurn: progress === null ? null : progress.presentedBeforeFirstTurn,
    turns: turns === null ? 0 : turns.length,
    // The witness's own agreement: the progress record counted what the bundle's presentation account counted.
    witnessAgrees: presented === null || pieceCount === null ? null : presented === pieceCount,
    gate:
      recordedTotal === null || population === null
        ? "not_measured"
        : recordedTotal === population
          ? "agree"
          : "disagree",
  });
}

/** The speech reading as printed lines: the two counts, which one is wrong, and the per-turn windows. */
export function speechRecordLines(reading) {
  const lines = [];
  if (reading.gate === "not_measured")
    return [
      "speech              not_measured",
      "  field             result.json sessionTurns[].spokenLines, run-progress.jsonl presented and result.json presentation.pieceCount - this run directory does not hold both sides",
    ];
  lines.push(
    `speech              ${String(reading.recordedTotal)} of ${String(reading.population)} lines  ${reading.gate === "agree" ? "AGREE" : "DISAGREE"}  <- result.json sessionTurns[].spokenLines (${String(
      reading.turns,
    )} turn(s)) vs ${reading.presented === null ? "result.json presentation.pieceCount" : "run-progress.jsonl presented"} ${String(
      reading.population,
    )}`,
  );
  if (reading.witnessAgrees === false)
    lines.push(
      `  witness           run-progress.jsonl presented ${String(reading.presented)} · result.json presentation.pieceCount ${String(
        reading.pieceCount,
      )} -> DISAGREE, so this run has no population to compare against until one of the two is fixed`,
    );
  else if (reading.gate === "disagree")
    lines.push(
      `  witness           run-progress.jsonl presented ${String(reading.presented)} · result.json presentation.pieceCount ${String(
        reading.pieceCount,
      )} -> the two agree, so the population is ${String(reading.population)} and sessionTurns[].spokenLines is the reading that is short`,
    );
  if (reading.perTurn.length > 0)
    lines.push(
      `  per_turn          ${reading.perTurn
        .map(
          (window, index) =>
            `turn ${String(window.turn ?? index)} ${String(reading.recorded[index] ?? 0)} of ${String(window.presented)}`,
        )
        .join(
          " · ",
        )}${reading.presentedBeforeFirstTurn > 0 ? ` · before the first turn ${String(reading.presentedBeforeFirstTurn)} (launch)` : ""} - a turn's window runs to the NEXT turn's start, so a line spoken after a turn's await returned is still that turn's`,
    );
  // A REFUSAL THAT ONLY THE ASSEMBLER KNOWS IS ONE NOBODY READS. The bubble is counted above (the player was shown it),
  // and it is named here with the code that refused it, so the defect - a stray character in front of her words - is in
  // the verdict beside the population it belongs to instead of being a line the run quietly counts.
  if (reading.refused.length > 0)
    lines.push(
      `  refused           ${reading.refused.map((bubble) => bubble.code).join(" · ")}  <- result.json sessionTurns[].refusedBubbles, a delivered bubble the assembler would not read as her speech`,
    );
  return lines;
}

/**
 * WHAT `actionCadence.thinkMs` ANSWERS, beside the model time the session record measured.
 *
 * <p>
 * `thinkMs` is the span from one FLAT action's receipt to the next FLAT action's dispatch. On a run whose work goes
 * through Body Programs, that span holds the programs, the model's turns and the harness's waits: `round87b` published
 * `thinkMs.sum 1345.4 s` and `max 645.1 s` beside `execMs.sum 468.5 s`, and it was read as "22.4 minutes of thinking
 * against 7.8 of acting". The gap is twelve spans between thirteen `express_emote` dispatches out of 293 actions, and the
 * 645.1 s one contains a whole day boundary - `run-progress.jsonl` opened `turn_started turn 1` 343 s into it.
 * </p>
 * <p>
 * So the field is read through `readThinkGap` - the same rule the runner publishes with - and the measured answer to the
 * question uses the session's own assistant-message time, which the verdict's efficiency block already prices.
 * </p>
 */
export function thinkingRecordLines(result, efficiency) {
  const lines = [];
  if (Number.isFinite(efficiency?.messageAxis?.total) && Number.isFinite(efficiency?.wallMs))
    lines.push(
      `thinking            ${seconds(efficiency.messageAxis.total)} of ${seconds(efficiency.wallMs)} wall = ${shareToATenth(
        efficiency.messageAxis.total,
        efficiency.wallMs,
      )} inside assistant messages · ${String(efficiency.messageAxis.count)} message(s) over ${String(
        efficiency.turns,
      )} prompt turn(s), median ${seconds(efficiency.providerMs)}  <- session record, the field the turn axis above sums`,
    );
  else
    lines.push(
      "thinking            not_measured (no readable session record, so no assistant-message time to price against the wall)",
    );
  const cadence = result.actionCadence ?? null;
  const gap = readThinkGap(cadence);
  const flatSpans = cadence?.dispatchGapMs === undefined ? (gap.span ?? null) : (cadence.dispatchGapMs ?? gap.span);
  const gaps = Number.isInteger(cadence?.flat) ? Math.max(0, cadence.flat - 1) : null;
  if (cadence === null)
    lines.push(
      "  cadence           not_measured (this bundle publishes no actionCadence, so no dispatch gap exists to read)",
    );
  else if (gap.answers)
    lines.push(
      `  cadence           ${seconds(gap.span?.sum)} of dispatch gap over ${String(gaps)} gap(s) (median ${seconds(
        gap.span?.median,
      )}, longest ${seconds(gap.span?.max)})  <- result.json actionCadence.thinkMs - every action in this run was dispatched on the flat clock, so a gap holds only the next dispatch's wait`,
    );
  else
    lines.push(
      `  cadence           not_measured (${String(cadence.thinkMsNotMeasured ?? gap.reason)}) · the flat channel measured ${seconds(
        flatSpans?.sum,
      )} over ${String(gaps)} dispatch gap(s), longest ${seconds(flatSpans?.max)}  <- result.json actionCadence.dispatchGapMs / thinkMsNotMeasured`,
    );
  if (!gap.answers && cadence !== null)
    lines.push(
      "  why               a thinkMs gap runs from one FLAT action's receipt to the next FLAT action's dispatch, so a program-path run holds its programs, its turns and the harness's waits inside it - the number is the flat channel's, not the model's",
    );
  return lines;
}

/** The two self-record readings, in one block, with the gate the disagreement trips. */
export function selfRecordLines(options) {
  const speech = speechRecordReading(options);
  return Object.freeze({
    gate: speech.gate,
    lines: Object.freeze([...speechRecordLines(speech), ...thinkingRecordLines(options.result, options.efficiency)]),
  });
}
