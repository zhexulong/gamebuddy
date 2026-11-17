import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  HELD_RECEIPT_PROGRESS_STATES,
  HELD_SEMANTIC_PROGRESS_KINDS,
  type PendingBatch,
  TRACE_KINDS,
  TRACES,
  tracedFacts,
  turnAccountLine,
  type WorldFact,
} from "./event-pump.js";

/**
 * `traces_counted_without_their_kinds:<run>` - the account's trace reading names the KIND that produced each trace.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR, MEASURED. `round65` (`tools/_multiday_routine-round65-live-runner.log`) printed
 * `tile_advanced 0` and `traces 69` in the same ten minutes. The first number said the per-tile flood was gone; the
 * second said sixty-nine traces had arrived anyway and could not say one more thing about them - not the kind, not
 * whether they were one kind or six. The answer was in the log only because every admitted fact is logged as
 * `BRIDGE_FACT`: replaying those 190 lines, the 69 traces were `execution_receipt accepted 41` and
 * `execution_receipt running 36`, with ZERO semantic kinds. A counter whose whole population is `N` and whose members
 * are unreadable is a number that costs a reader the Mod's source to interpret, which is the failure this gate closes.
 * </p>
 * <p>
 * THE POPULATION IS THE PUMP'S OWN `TRACE_KINDS`, derived from `HELD_RECEIPT_PROGRESS_STATES` and
 * `HELD_SEMANTIC_PROGRESS_KINDS`. A state or semantic kind added to either table is therefore counted, printed, and
 * examined here without a second list to extend.
 * </p>
 *
 * {@link tracesCountedWithoutTheirKindsGate} is a function of recorded readings rather than of the pump, so the
 * falsifier can hand it the reading the run actually printed - the direction that matters, because a gate that can only
 * be turned red by breaking the code it just wrote proves nothing about the defect it was written for.
 */

/** One run's trace reading: what the account counted, and the total a reader was shown beside it. */
export type TraceReading = Readonly<{ run: string; kinds: Readonly<Record<string, number>>; total: number }>;

export type TracesAccountGate = Readonly<{
  readingsExamined: number;
  /** Kinds the readings named: every one of them came from `TRACE_KINDS`. */
  kindsNamed: number;
  tracesCounted: number;
  violations: readonly string[];
  blocked: string | null;
}>;

/**
 * The verdict over the recorded readings, with zero population BLOCKED rather than green.
 *
 * Three defects, three tokens, because they are fixed by different layers: a total with no kind behind it
 * (`traces_counted_without_their_kinds`), a kind the pump does not declare (`traces_kind_not_declared`), and a total
 * that is not the sum of the kinds printed beside it (`traces_total_disagrees_with_its_kinds`).
 */
export function tracesCountedWithoutTheirKindsGate(readings: readonly TraceReading[]): TracesAccountGate {
  if (readings.length === 0)
    return Object.freeze({
      readingsExamined: 0,
      kindsNamed: 0,
      tracesCounted: 0,
      violations: Object.freeze([]),
      blocked: "zero_population:no_run_reading_was_examined",
    });
  const violations: string[] = [];
  const named = new Set<string>();
  let tracesCounted = 0;
  for (const reading of readings) {
    const entries = Object.entries(reading.kinds).filter(([, count]) => count > 0);
    for (const [kind] of entries) named.add(kind);
    tracesCounted += reading.total;
    for (const [kind, count] of entries)
      if (!TRACE_KINDS.includes(kind))
        violations.push(`traces_kind_not_declared:${reading.run}:${kind}:${String(count)}`);
    const sum = tracedFacts(reading.kinds);
    // The total is checked against the kinds PRINTED BESIDE IT - but only when there are some: a total over an empty map
    // is the defect named below, and naming it twice would read as two things going wrong.
    if (entries.length > 0 && sum !== reading.total)
      violations.push(`traces_total_disagrees_with_its_kinds:${reading.run}:${String(reading.total)}:${String(sum)}`);
    // THE ONE THE RUN PRODUCED: a non-zero total over a map that names nothing.
    if (reading.total > 0 && entries.length === 0)
      violations.push(`traces_counted_without_their_kinds:${reading.run}:${String(reading.total)}`);
  }
  return Object.freeze({
    readingsExamined: readings.length,
    kindsNamed: named.size,
    tracesCounted,
    violations: Object.freeze(violations),
    blocked: null,
  });
}

function recorder(): { batches: PendingBatch[]; sink: { deliver(batch: PendingBatch): Promise<void> } } {
  const batches: PendingBatch[] = [];
  return {
    batches,
    sink: {
      async deliver(batch) {
        batches.push(batch);
      },
    },
  };
}

/** A receipt of one state, carrying the provenance the wire requires: a step of a programme she dispatched. */
function receiptOf(state: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: `exec_${state}`,
    executionId: `exec_${state}`,
    requestId: `request_${state}`,
    revision: 1,
    payload: {
      actionId: "harvest_crop",
      state,
      reasonCode: `reason_${state}`,
      revision: 1,
      origin: { kind: "programme", programId: "plan_harvest_cauli", nodeId: "n002" },
    },
  };
}

/** A semantic body trace of one kind: the same shape, stated as an event. */
function semanticTraceOf(kind: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: `transport_${kind}`,
    executionId: "exec_one",
    revision: 1,
    payload: {
      kind,
      revision: 1,
      reasonCode: "body_trace",
      activeExecution: null,
      bodyTrace: { category: kind, executionId: "exec_one", requestId: "request_one", tick: 12, revision: 1 },
    },
  };
}

/** Every fact shape the pump declares as a trace, one fact each, derived from the pump's own two tables. */
function tracePopulation(): readonly Readonly<{ kind: string; fact: WorldFact }>[] {
  return Object.freeze([
    ...Object.keys(HELD_RECEIPT_PROGRESS_STATES).map((state) =>
      Object.freeze({ kind: `receipt:${state}`, fact: receiptOf(state) }),
    ),
    ...Object.keys(HELD_SEMANTIC_PROGRESS_KINDS).map((kind) =>
      Object.freeze({ kind: `semantic:${kind}`, fact: semanticTraceOf(kind) }),
    ),
  ]);
}

test("traces_counted_without_their_kinds: every trace kind the pump declares is counted, named, and printed", async () => {
  const population = tracePopulation();
  assert.ok(population.length > 0, "an empty population agrees with itself");
  const readings: TraceReading[] = [];

  for (const entry of population) {
    const pump = new CompanionEventPump();
    pump.enqueueFact(entry.fact, FACT_PRODUCER.adapterIngress);
    // A trace never owes a turn: the flush is what a real admission is followed by, and it must compose nothing.
    const outcome = await pump.flush(recorder().sink);
    assert.equal(outcome.kind, "not_owed", `traces_counted_without_their_kinds:${entry.kind}: a trace is not an event`);
    const account = pump.turnAccount;
    assert.equal(
      account.traces[entry.kind],
      1,
      `traces_counted_without_their_kinds:${entry.kind}: the trace is counted under the kind that produced it`,
    );
    assert.equal(
      tracedFacts(account.traces),
      1,
      `traces_counted_without_their_kinds:${entry.kind}: and counted exactly once`,
    );
    const line = turnAccountLine(account);
    assert.match(
      line,
      new RegExp(`${TRACES} 1 \\{[^}]*${entry.kind.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}: 1[^}]*\\}`, "u"),
      `traces_counted_without_their_kinds:${entry.kind}: the kind reaches the line a reader greps, or it is invisible: ${line}`,
    );
    readings.push(Object.freeze({ run: entry.kind, kinds: account.traces, total: tracedFacts(account.traces) }));
  }

  const gate = tracesCountedWithoutTheirKindsGate(readings);
  assert.equal(gate.blocked, null, `the gate measured nothing: ${String(gate.blocked)}`);
  assert.equal(gate.readingsExamined, population.length, "every declared trace shape was driven exactly once");
  assert.equal(gate.tracesCounted, population.length, "and each of them counted one trace");
  assert.deepEqual(gate.violations, [], "each reading names the kind it counted");
  console.log(
    `traces_counted_without_their_kinds: readings examined ${String(gate.readingsExamined)} · kinds named ${String(gate.kindsNamed)} · traces counted ${String(gate.tracesCounted)}`,
  );
});

test("traces_counted_without_their_kinds: the account names a declared kind that never fired", () => {
  // A DECLARED ZERO IS A READING, and it is the half that answers "is the Mod still emitting body traces": `round65`
  // produced no semantic trace at all, and a line that omitted the zeros would leave that indistinguishable from a pump
  // that had stopped looking.
  const pump = new CompanionEventPump();
  const line = turnAccountLine(pump.turnAccount);
  assert.match(line, new RegExp(`${TRACES} 0 \\{`, "u"), `a run with no trace prints every kind at zero: ${line}`);
  for (const kind of TRACE_KINDS)
    assert.equal(
      line.includes(`${kind}: 0`),
      true,
      `traces_counted_without_their_kinds:${kind}: a declared kind is printed at zero rather than left out`,
    );
});

test("traces_counted_without_their_kinds: round65's measured traces are named, not counted", () => {
  // THE RUN, REPLAYED. These are the counts read out of `_multiday_routine-round65-live-runner.log`: of its 190
  // `BRIDGE_FACT` lines, 185 were execution receipts - 41 `accepted`, 36 `running` (the traces) and the rest terminal -
  // and 2 were semantic events, both `snapshot_changed`, which is not a trace kind. The gate is handed the account this
  // change produces, and then the line that run actually printed.
  const kinds = { "receipt:accepted": 41, "receipt:running": 36 };
  const gate = tracesCountedWithoutTheirKindsGate([
    Object.freeze({ run: "round65", kinds: Object.freeze(kinds), total: tracedFacts(kinds) }),
  ]);

  assert.equal(gate.blocked, null);
  assert.equal(
    gate.tracesCounted,
    77,
    "the run's own trace total, and it is the sum of two kinds rather than one number",
  );
  assert.equal(gate.kindsNamed, 2, "two kinds produced all of it: no semantic trace arrived in ten minutes");
  assert.deepEqual(gate.violations, [], "a reading that names its kinds passes, whatever the counts are");
});

test("traces_counted_without_their_kinds: the reading the run printed is refused by name", () => {
  // THE FALSIFIER, in the direction that matters: `round65`'s own `traces 69` - a total of 69 over an EMPTY map, which
  // is exactly what the pump published before this change. The token names the run and the number.
  const refused = tracesCountedWithoutTheirKindsGate([
    Object.freeze({ run: "round65_as_printed", kinds: Object.freeze({}), total: 69 }),
  ]);
  assert.deepEqual(
    refused.violations,
    ["traces_counted_without_their_kinds:round65_as_printed:69"],
    "a total nobody can attribute must be red, and say which run and which number",
  );

  // The other two ways a trace reading can lie, each with its own token: a kind the pump does not declare (a second
  // spelling of the population), and a total that is not the sum of the kinds beside it (two numbers, one fact).
  const both = tracesCountedWithoutTheirKindsGate([
    Object.freeze({
      run: "round65_with_a_second_spelling",
      kinds: Object.freeze({ "receipt:accepted": 41, tile_advanced: 28 }),
      total: 77,
    }),
  ]);
  assert.deepEqual(
    both.violations,
    [
      "traces_kind_not_declared:round65_with_a_second_spelling:tile_advanced:28",
      "traces_total_disagrees_with_its_kinds:round65_with_a_second_spelling:77:69",
    ],
    "an undeclared kind and a total that does not add up are named separately, because different layers fix them",
  );
});

test("traces_counted_without_their_kinds: zero population is blocked, never green", () => {
  const empty = tracesCountedWithoutTheirKindsGate([]);
  assert.equal(empty.blocked, "zero_population:no_run_reading_was_examined");
  assert.deepEqual(empty.violations, []);
  assert.equal(empty.readingsExamined, 0);
  assert.equal(empty.tracesCounted, 0);
});
