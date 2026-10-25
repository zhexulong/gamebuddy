import { RUN_SPAN_NAMES } from "./run-trace.js";
import { RUN_WAIT_NAMES } from "./run-trace-budget.js";

/**
 * Derives the agent's deciding time from a trace that already exists.
 *
 * Between one `action` span ending and the next one beginning, one of two things happened: the agent
 * decided what to do next, or the harness did bookkeeping. Both are visible as a gap in the same trace,
 * and the gap is exactly what `actionCadence.thinkMs` measured - except that number was described as
 * thinking, which it is not: a gap can also be the body being unavailable, and the trace cannot tell
 * those apart on its own.
 *
 * So this reports the gap as `wait.model` ONLY when nothing else claims the interval, and says
 * `unattributed` otherwise. That asymmetry is the point: the honest answer for "we do not know" must not
 * look like the confident answer for "the model took 40 seconds".
 */
export type DerivedWait = Readonly<{
  name: string;
  startMs: number;
  endMs: number;
  /** True when another span (a body wait, a harness wait) overlaps the gap and owns it instead. */
  contested: boolean;
}>;

/**
 * The gaps between consecutive `action` spans, in order.
 *
 * A gap is `contested` when any span of another wait family overlaps it, because then the interval has a
 * better owner than "the model". Overlap rather than containment: a body wait that starts inside the gap
 * and runs past its end still means the gap was not pure thinking.
 */
export function deriveModelWaits(
  spans: readonly Readonly<{ name: string; startMs: number; endMs: number | null }>[],
): readonly DerivedWait[] {
  const actions = spans
    .filter((s) => s.name === RUN_SPAN_NAMES.action && s.endMs !== null)
    .map((s) => ({ startMs: s.startMs, endMs: s.endMs as number }))
    .sort((a, b) => a.startMs - b.startMs);

  const others = spans.filter(
    (s) => s.endMs !== null && (s.name === RUN_WAIT_NAMES.body || s.name === RUN_WAIT_NAMES.harness),
  ) as readonly Readonly<{ name: string; startMs: number; endMs: number }>[];

  const waits: DerivedWait[] = [];
  for (let i = 0; i + 1 < actions.length; i += 1) {
    const from = actions[i]!.endMs;
    const to = actions[i + 1]!.startMs;
    if (to <= from) continue; // nested or out of order: not a gap

    const contested = others.some((o) => o.startMs < to && o.endMs > from);
    waits.push({ name: RUN_WAIT_NAMES.model, startMs: from, endMs: to, contested });
  }

  return Object.freeze(waits);
}

/**
 * The waits that may legitimately be counted as model time: uncontested gaps only.
 *
 * Kept separate from `deriveModelWaits` because the two answers are used for different things - a report
 * shows both (how much of the run was decided, and how much could not be told apart from a body wait),
 * while a budget must not silently absorb the second into the first.
 */
export function uncontestedModelWaits(waits: readonly DerivedWait[]): readonly DerivedWait[] {
  return Object.freeze(waits.filter((w) => !w.contested));
}

/** Total milliseconds of uncontested gaps, which is the model time a trace can actually support. */
export function modelWaitMs(waits: readonly DerivedWait[]): number {
  return uncontestedModelWaits(waits).reduce((sum, w) => sum + (w.endMs - w.startMs), 0);
}
