import { RUN_SPAN_NAMES } from "./run-trace.js";

/**
 * The wait taxonomy: every millisecond of a run belongs to exactly one of these.
 *
 * `actionCadence` already split a run into `execMs` (dispatch to its own receipt) and `thinkMs`
 * (receipt to the next dispatch) - and `thinkMs` is where two completely different waits used to be
 * stored together: the agent deciding (a provider round trip) and the body not being free (a menu, a
 * pass-out, a sleep lifecycle). Reading one median over that mixture told me the run was "waiting 3.4s
 * for the model" while 87 long gaps were sitting in the same bucket unexamined.
 *
 * These names are the fix: a wait is either the model's, the body's, or the harness's, and a run's
 * budget is the sum of the four plus whatever cannot be accounted for - which must be small, and is
 * reported rather than absorbed.
 */
export const RUN_WAIT_NAMES = Object.freeze({
  /** The agent thinking: from a tool result settling to the next dispatch being issued. */
  model: "wait.model",
  /** The body refusing to move: a menu, a pass-out, a sleep lifecycle, a day advance. */
  body: "wait.body",
  /** Our own bookkeeping between a response and the next dispatch, when neither of the above explains it. */
  harness: "wait.harness",
});

/**
 * A run's wall clock, attributed.
 *
 * `unexplainedMs` is not a rounding error: it is the part the spans do not cover, and a run whose
 * unexplained share is large cannot be reasoned about by choosing a suspect. It exists so that
 * "the model is 83% of the run" and "the model is 83% of the part we happened to measure" are
 * different claims.
 */
export type WaitBudget = Readonly<{
  wallMs: number;
  modelMs: number;
  bodyMs: number;
  harnessMs: number;
  actionMs: number;
  unexplainedMs: number;
  /** Share of the wall clock the spans account for, in [0, 1]. */
  covered: number;
}>;

type Interval = Readonly<{ start: number; end: number }>;

/** Merge overlapping intervals so nested spans are not counted twice. */
function mergeIntervals(intervals: readonly Interval[]): readonly Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].filter((i) => i.end >= i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  let current = { ...sorted[0]! };
  for (const next of sorted.slice(1)) {
    if (next.start <= current.end) {
      current = { start: current.start, end: Math.max(current.end, next.end) };
      continue;
    }
    merged.push(current);
    current = { ...next };
  }
  merged.push(current);
  return merged;
}

function totalMs(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
}

/**
 * Attribute a run's wall clock from what the trace recorded.
 *
 * Every span that appears under `action` counts as action time (the game working, and our bookkeeping
 * inside it); the two `wait.*` families count as model and body. The result is a partition, not a
 * sample: `wallMs - (action + model + body + harness)` is the honest remainder.
 *
 * Spans are merged before summing, because `mod.execute` legitimately nests inside `bridge.call`
 * inside `action` and counting each would invent time.
 */
export function attributeWaitBudget(
  spans: readonly Readonly<{ name: string; startMs: number; endMs: number | null }>[],
  options: Readonly<{ wallMs: number }>,
): WaitBudget {
  if (!Number.isFinite(options.wallMs) || options.wallMs <= 0) throw new Error("invalid_wait_budget_wall_ms");

  const closed = spans.filter((s) => s.endMs !== null) as readonly Readonly<{
    name: string;
    startMs: number;
    endMs: number;
  }>[];

  const of = (names: readonly string[]): readonly Interval[] =>
    closed.filter((s) => names.includes(s.name)).map((s) => ({ start: s.startMs, end: s.endMs }));

  const actionMs = totalMs(of([RUN_SPAN_NAMES.action, RUN_SPAN_NAMES.modExecute]));
  const modelMs = totalMs(of([RUN_WAIT_NAMES.model]));
  const bodyMs = totalMs(of([RUN_WAIT_NAMES.body]));
  const harnessMs = totalMs(of([RUN_WAIT_NAMES.harness]));

  const accounted = actionMs + modelMs + bodyMs + harnessMs;
  const unexplainedMs = Math.max(0, options.wallMs - accounted);

  return Object.freeze({
    wallMs: options.wallMs,
    modelMs,
    bodyMs,
    harnessMs,
    actionMs,
    unexplainedMs,
    covered: Math.min(1, accounted / options.wallMs),
  });
}

/** The budget as a sorted table, largest first, so a reader sees where a run went without arithmetic. */
export function waitBudgetRows(budget: WaitBudget): readonly Readonly<{ name: string; ms: number; share: number }>[] {
  const rows = [
    { name: "wait.model", ms: budget.modelMs },
    { name: "wait.body", ms: budget.bodyMs },
    { name: "action", ms: budget.actionMs },
    { name: "wait.harness", ms: budget.harnessMs },
    { name: "unexplained", ms: budget.unexplainedMs },
  ];
  return Object.freeze(
    rows
      .map((row) => Object.freeze({ ...row, share: budget.wallMs > 0 ? row.ms / budget.wallMs : 0 }))
      .sort((a, b) => b.ms - a.ms),
  );
}
