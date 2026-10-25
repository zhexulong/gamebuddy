import { RUN_SPAN_NAMES, type RunTraceSpan } from "./run-trace.js";

/**
 * Per-action cadence, derived from a run trace instead of a hand-built action array.
 *
 * The arithmetic is the one `tools/lib/action-cadence.mjs` established, because those numbers are what run reviews
 * read: exec = dispatch -> settle, think = settle -> next dispatch, idle = dispatch -> next dispatch. An action span
 * opened at dispatch and closed when the dispatch settled carries exactly the two timestamps the old trace entries
 * held, so the same questions stay answerable without a second instrument.
 */

type DurationSummary = Readonly<{ median: number | null; max: number | null; sum: number }>;

export type ActionCadenceSummary = Readonly<{
  actions: number;
  measured: number;
  unmeasured: number;
  execMs: DurationSummary;
  thinkMs: DurationSummary;
  idleMs: DurationSummary;
}>;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function summarizeActionCadenceFromSpans(spans: readonly RunTraceSpan[]): ActionCadenceSummary {
  const ordered = spans
    .filter((span) => span.name === RUN_SPAN_NAMES.action)
    .sort((left, right) => left.startMs - right.startMs);
  const exec: number[] = [];
  const think: number[] = [];
  const idle: number[] = [];
  let unmeasured = 0;
  for (const [index, span] of ordered.entries()) {
    const settled = span.endMs !== null && span.endMs >= span.startMs ? span.endMs : null;
    if (settled === null) unmeasured += 1;
    else exec.push(settled - span.startMs);
    const next = ordered[index + 1];
    if (next === undefined) continue;
    idle.push(next.startMs - span.startMs);
    // Only measurable when THIS action's settle is known: otherwise "thinking" would swallow the previous action's
    // execution and the number would mean nothing.
    if (settled !== null && next.startMs >= settled) think.push(next.startMs - settled);
  }
  const summary = (values: readonly number[]): DurationSummary =>
    Object.freeze({
      median: median(values),
      max: values.length === 0 ? null : Math.max(...values),
      sum: values.reduce((total, value) => total + value, 0),
    });
  return Object.freeze({
    actions: ordered.length,
    measured: exec.length,
    unmeasured,
    execMs: summary(exec),
    thinkMs: summary(think),
    idleMs: summary(idle),
  });
}
