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
 * These names are the fix: a wait is either the model's, the body's, the harness's, or one of the two
 * silences the Host can name itself - nothing was owed (`idle`), and the world's picture had gone stale
 * (`snapshot`). A run's budget is the union of what those spans cover plus whatever nothing measured,
 * which must be small and is reported rather than absorbed.
 */
export const RUN_WAIT_NAMES = Object.freeze({
  /** The agent thinking: from a tool result settling to the next dispatch being issued. */
  model: "wait.model",
  /** The body refusing to move: a menu, a pass-out, a sleep lifecycle, a day advance. */
  body: "wait.body",
  /** Our own bookkeeping between a response and the next dispatch, when neither of the above explains it. */
  harness: "wait.harness",
  /**
   * NOTHING WAS OWED: the pump was empty and the Host was waiting for the world to say something.
   *
   * <p>
   * This is the silence a live run's largest unattributed block turned out to be - 165.8 s of one 34-minute run,
   * transcribed from the product's own activity stream: "idle", no snapshot arriving, the clock still answering. It
   * has a name now so that it is a measurement ("the Host had nothing to deliver") and not a remainder.
   * </p>
   */
  idle: "wait.idle",
  /**
   * A reading went stale and no fresh snapshot has arrived since.
   *
   * <p>
   * Distinct from `idle`: something WAS owed (a `world_state_stale` fact is a pending delivery), and what the Host
   * waited on was the Mod's picture of the world. Nested inside a provider turn without double-counting, because
   * the budget unions its families rather than summing them.
   * </p>
   */
  snapshot: "wait.snapshot",
});

/**
 * The one declaration of which span name belongs to which bucket of a run's wall clock.
 *
 * <p>
 * A budget can only be trusted if its buckets come from a declaration the emitters already own, so the population
 * here is checked against `RUN_SPAN_NAMES` and `RUN_WAIT_NAMES` by `run-trace-budget.private.test.ts`: a span name
 * added to the taxonomy without a family fails that test by name. `action` is also the default for any span the
 * trace carries that this declaration does not know (a mounted tool is a tool the Host waited on), and those names
 * are listed in `defaultedToAction` so a new emitter cannot hide inside the default.
 * </p>
 */
export const RUN_BUDGET_FAMILIES = Object.freeze([
  Object.freeze({ family: "model", names: Object.freeze([RUN_WAIT_NAMES.model]) }),
  Object.freeze({ family: "body", names: Object.freeze([RUN_WAIT_NAMES.body]) }),
  Object.freeze({ family: "harness", names: Object.freeze([RUN_WAIT_NAMES.harness]) }),
  Object.freeze({ family: "idle", names: Object.freeze([RUN_WAIT_NAMES.idle]) }),
  Object.freeze({ family: "snapshot", names: Object.freeze([RUN_WAIT_NAMES.snapshot]) }),
  Object.freeze({
    family: "prompt",
    names: Object.freeze([
      RUN_SPAN_NAMES.promptContext,
      RUN_SPAN_NAMES.promptSystem,
      RUN_SPAN_NAMES.promptTools,
      RUN_SPAN_NAMES.promptBlocks,
      RUN_SPAN_NAMES.memoryMount,
    ]),
  }),
  Object.freeze({
    family: "delivery",
    names: Object.freeze([RUN_SPAN_NAMES.delivery, RUN_SPAN_NAMES.turnTail]),
  }),
  Object.freeze({
    family: "journal",
    names: Object.freeze([RUN_SPAN_NAMES.journalWrite, RUN_SPAN_NAMES.journalRead]),
  }),
  Object.freeze({ family: "observation", names: Object.freeze([RUN_SPAN_NAMES.snapshotObserve]) }),
  Object.freeze({
    family: "action",
    names: Object.freeze([
      RUN_SPAN_NAMES.action,
      RUN_SPAN_NAMES.modExecute,
      RUN_SPAN_NAMES.admission,
      RUN_SPAN_NAMES.present,
      RUN_SPAN_NAMES.bridgeCall,
    ]),
  }),
] as const);

/** Every budget family's name, in declaration order. */
export const RUN_BUDGET_FAMILY_NAMES: readonly string[] = Object.freeze(
  RUN_BUDGET_FAMILIES.map((entry) => entry.family),
);

/**
 * The between-call emitter set: the steps that used to leave a run's wall clock unattributed.
 *
 * <p>
 * This is a declaration, not a list of files: every name here must be emitted by at least one non-test source, and
 * `run-trace-between-call.private.test.ts` fails by name when one is declared and nothing emits it. That is the
 * shape the 2026-11 audit found inverted - a wait family pinned at `0` as the correct reading of a run that spent
 * 83 % of its wall clock in it.
 * </p>
 */
export const RUN_BETWEEN_CALL_SPANS: readonly string[] = Object.freeze([
  RUN_SPAN_NAMES.promptContext,
  RUN_SPAN_NAMES.promptSystem,
  RUN_SPAN_NAMES.promptTools,
  RUN_SPAN_NAMES.promptBlocks,
  RUN_SPAN_NAMES.memoryMount,
  RUN_SPAN_NAMES.journalRead,
  RUN_SPAN_NAMES.delivery,
  RUN_SPAN_NAMES.turnTail,
  RUN_SPAN_NAMES.snapshotObserve,
  RUN_WAIT_NAMES.idle,
  RUN_WAIT_NAMES.snapshot,
]);

const FAMILY_OF_SPAN: ReadonlyMap<string, string> = new Map(
  RUN_BUDGET_FAMILIES.flatMap((entry) => entry.names.map((name) => [name, entry.family] as const)),
);

/** The bucket one span name belongs to, or `undefined` when the declaration does not know it (defaults to `action`). */
export function budgetFamilyOf(spanName: string): string | undefined {
  return FAMILY_OF_SPAN.get(spanName);
}

/**
 * A run's wall clock, attributed.
 *
 * `unexplainedMs` is not a rounding error: it is the part the spans do not cover, and a run whose
 * unexplained share is large cannot be reasoned about by choosing a suspect. It exists so that
 * "the model is 83% of the run" and "the model is 83% of the part we happened to measure" are
 * different claims.
 *
 * `unmeasured` is the other half of that honesty: a family with NO span in the trace is not a measured
 * zero, and is named here rather than printed as `0` - the report `waitBudgetRows` then renders it as
 * `not_measured:<family>`.
 *
 * `omittedMs` is the third: run time the trace does not carry because a bounded producer dropped it (the
 * activity stream's point limit is the one that produced this field). It is DECLARED by the caller from the
 * producer's own reading, subtracted from `unexplainedMs` because the time is named rather than unknown, and
 * added to `covered` because a span nobody wrote is still time the run had. A run whose dropped time is not
 * declared does not disappear: it stays in `unexplainedMs`, which is what the ceiling in
 * `run-trace-budget.live-shape.private.test.ts` reads.
 */
export type WaitBudget = Readonly<{
  wallMs: number;
  modelMs: number;
  bodyMs: number;
  harnessMs: number;
  idleMs: number;
  snapshotMs: number;
  promptMs: number;
  deliveryMs: number;
  journalMs: number;
  observationMs: number;
  actionMs: number;
  /** Union of every span the trace covers, clipped to the window: the one number that must close with the remainder. */
  accountedMs: number;
  /** Run time a bounded producer declared it dropped: named, not measured, and not part of the remainder. */
  omittedMs: number;
  unexplainedMs: number;
  /** Share of the wall clock the spans plus the declared omission account for, in [0, 1]. */
  covered: number;
  /** Families with no closed span inside the window: absent, not measured as zero. */
  unmeasured: readonly string[];
  /** Span names the trace carried that no family declares; they were charged to `action`. */
  defaultedToAction: readonly string[];
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

/** Clip one interval to the run's own window; a span outside it is not time this run had. */
function clip(interval: Interval, windowStartMs: number, windowEndMs: number): Interval | null {
  const start = Math.max(interval.start, windowStartMs);
  const end = Math.min(interval.end, windowEndMs);
  return end > start ? { start, end } : null;
}

/**
 * Attribute a run's wall clock from what the trace recorded.
 *
 * Every span the trace carries is counted exactly once, as a union: `mod.execute` legitimately nests
 * inside `bridge.call` inside `action`, and a turn's block selection legitimately sits inside its
 * delivery - summing the families would invent time. `wallMs - accounted` is therefore the honest
 * remainder, and the family sums are what each family's own spans say, reported beside it.
 *
 * A span name the declaration does not know is charged to `action` AND named in `defaultedToAction`:
 * a tool span is a tool the Host waited on, but a new emitter that forgot its family must be visible.
 */
export function attributeWaitBudget(
  spans: readonly Readonly<{ name: string; startMs: number; endMs: number | null }>[],
  options: Readonly<{ wallMs: number; wallStartMs?: number; omittedMs?: number }>,
): WaitBudget {
  if (!Number.isFinite(options.wallMs) || options.wallMs <= 0) throw new Error("invalid_wait_budget_wall_ms");
  const windowStartMs = options.wallStartMs ?? 0;
  if (!Number.isFinite(windowStartMs)) throw new Error("invalid_wait_budget_wall_start_ms");
  const omittedMs = options.omittedMs ?? 0;
  if (!Number.isFinite(omittedMs) || omittedMs < 0 || omittedMs > options.wallMs)
    throw new Error("invalid_wait_budget_omitted_ms");
  const windowEndMs = windowStartMs + options.wallMs;

  const closed = spans.filter((s): s is Readonly<{ name: string; startMs: number; endMs: number }> => s.endMs !== null);
  const clipped = closed
    .map((s) => ({ name: s.name, interval: clip({ start: s.startMs, end: s.endMs }, windowStartMs, windowEndMs) }))
    .filter((entry): entry is { name: string; interval: Interval } => entry.interval !== null);

  const familyToUse = (name: string): string => budgetFamilyOf(name) ?? "action";
  const defaultedToAction = Object.freeze(
    [...new Set(closed.map((s) => s.name).filter((name) => budgetFamilyOf(name) === undefined))].sort(),
  );

  const perFamily = new Map<string, Interval[]>();
  for (const entry of clipped) {
    const family = familyToUse(entry.name);
    const list = perFamily.get(family);
    if (list === undefined) perFamily.set(family, [entry.interval]);
    else list.push(entry.interval);
  }
  const familyMs = (family: string): number => totalMs(perFamily.get(family) ?? []);

  const accountedMs = totalMs(clipped.map((entry) => entry.interval));
  const unexplainedMs = Math.max(0, options.wallMs - accountedMs - omittedMs);
  const unmeasured = Object.freeze(
    RUN_BUDGET_FAMILIES.filter((entry) => !perFamily.has(entry.family)).map((entry) => entry.family),
  );

  return Object.freeze({
    wallMs: options.wallMs,
    modelMs: familyMs("model"),
    bodyMs: familyMs("body"),
    harnessMs: familyMs("harness"),
    idleMs: familyMs("idle"),
    snapshotMs: familyMs("snapshot"),
    promptMs: familyMs("prompt"),
    deliveryMs: familyMs("delivery"),
    journalMs: familyMs("journal"),
    observationMs: familyMs("observation"),
    actionMs: familyMs("action"),
    accountedMs,
    omittedMs,
    unexplainedMs,
    covered: Math.min(1, (accountedMs + omittedMs) / options.wallMs),
    unmeasured,
    defaultedToAction,
  });
}

/** One row per declared family plus the remainder, so a reader sees the whole partition without arithmetic. */
export function waitBudgetRows(
  budget: WaitBudget,
): readonly Readonly<{ name: string; ms: number; share: number; notMeasured: boolean }>[] {
  const msOf = (family: string): number => {
    switch (family) {
      case "model":
        return budget.modelMs;
      case "body":
        return budget.bodyMs;
      case "harness":
        return budget.harnessMs;
      case "idle":
        return budget.idleMs;
      case "snapshot":
        return budget.snapshotMs;
      case "prompt":
        return budget.promptMs;
      case "delivery":
        return budget.deliveryMs;
      case "journal":
        return budget.journalMs;
      case "observation":
        return budget.observationMs;
      case "action":
        return budget.actionMs;
      default:
        throw new Error(`invalid_wait_budget_family: ${family}`);
    }
  };
  const rows = [
    ...RUN_BUDGET_FAMILY_NAMES.map((family) => ({
      name: family,
      ms: msOf(family),
      notMeasured: budget.unmeasured.includes(family),
    })),
    { name: "unexplained", ms: budget.unexplainedMs, notMeasured: false },
  ];
  return Object.freeze(
    rows
      .map((row, index) => Object.freeze({ ...row, share: budget.wallMs > 0 ? row.ms / budget.wallMs : 0, index }))
      .sort((a, b) => b.ms - a.ms || a.index - b.index)
      .map(({ name, ms, share, notMeasured }) => Object.freeze({ name, ms, share, notMeasured })),
  );
}

/**
 * The attribution summary: the one line a run log can carry beside the rows the report renders.
 *
 * `omitted by the point limit: M ms` is in this line rather than left implicit because an omission is otherwise
 * indistinguishable from a run that was busy throughout. MEASURED (`round62`): the bundle's 512-point activity limit
 * dropped 55,995 ms of the run's final idle stretch, the budget charged that time to `unexplainedMs` - a remainder that
 * still clears a six-percent ceiling - and a reader comparing the bundle's "idle 166.1 s" with the raw log's 222.0 s had
 * nothing to compare against. The declaration is what gives the dropped time an owner: `accountedMs + omittedMs +
 * unexplainedMs` is the wall clock, and a caller that drops points without declaring them cannot close that sum.
 */
export function waitBudgetReading(budget: WaitBudget): string {
  const parts = [
    `run wall ${String(budget.wallMs)} ms`,
    `accounted ${String(budget.accountedMs)} ms`,
    `omitted by the point limit: ${String(budget.omittedMs)} ms`,
    `unexplained ${String(budget.unexplainedMs)} ms`,
    `covered ${budget.covered.toFixed(4)}`,
  ];
  if (budget.unmeasured.length > 0) parts.push(`not measured: ${budget.unmeasured.join(", ")}`);
  return parts.join(" · ");
}
