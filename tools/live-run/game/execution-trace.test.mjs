/**
 * The execution trace's one identity: a run's rows are its flat request frames plus the executions its programs
 * dispatched, both counted once.
 *
 * The gap these tests pin, measured 2026-10-22: 22 submissions, 16 accepted, every accepted program reporting 1-4
 * `native_dispatch` executions, and `actionTrace.jsonl` holding ZERO rows - so a run doing real work read as if nothing
 * had happened, and every measure taken from that file silently excluded program work.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  executionTraceInvariant,
  programExecutionRows,
  readExecutionTrace,
  writeProgramExecutionTrace,
} from "./execution-trace.mjs";

/** A scratch root inside the repository's own `.tmp/`, never the shared OS temp tree. */
async function withRunDir(run) {
  const parent = join(fileURLToPath(new URL("../../../.tmp/", import.meta.url)), "gb-execution-trace-");
  await mkdir(join(fileURLToPath(new URL("../../../.tmp/", import.meta.url))), { recursive: true });
  const dir = await mkdtemp(parent);
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One flat request frame, in the shape the runner's `client.execute` hook writes. */
function flatRow(requestId, action) {
  return {
    via: "flat",
    action,
    requestId,
    args: { targetX: 12, targetY: 8 },
    state: "succeeded",
    reasonCode: "soil_tilled",
    inGameTime: "620",
    day: 5,
    season: "spring",
    year: 1,
    dispatchedAtMs: 1_700_000_000_000,
    settledAtMs: 1_700_000_000_500,
  };
}

/** One observed program record, in the shape `readProgramOutcomes` publishes. */
function observedProgram(programId, dispatches) {
  return {
    programId,
    accepted: true,
    observed: true,
    dispatched: dispatches.length,
    executions: dispatches,
    nodeOutcomes: [],
  };
}

test("two flat dispatches and one three-node program are five rows, each saying how it was dispatched", async () => {
  const programOutcomes = [
    observedProgram("p1", [
      { nodeId: "a", nodeAttempt: 1, cursor: 2 },
      { nodeId: "b", nodeAttempt: 1, cursor: 3 },
      { nodeId: "c", nodeAttempt: 1, cursor: 4 },
    ]),
  ];
  const programRows = programExecutionRows(programOutcomes);
  const actionTrace = [flatRow("r-1", "till_soil"), flatRow("r-2", "water_crop")];
  const invariant = executionTraceInvariant({ actionTrace, programOutcomes, programRows });
  assert.equal(invariant.ok, true, "the identity holds: 2 flat + 3 program executions = 5 rows");
  assert.deepEqual(invariant, {
    ok: true,
    sumsAgree: true,
    flat: 2,
    program: 3,
    programDispatches: 3,
    rows: 5,
    expectedRows: 5,
    unobservedPrograms: 0,
  });
  // The program rows name the program and the node, so a measurement can attribute the execution and never guess.
  assert.deepEqual(programRows, [
    { via: "program", programId: "p1", nodeId: "a", nodeAttempt: 1, cursor: 2 },
    { via: "program", programId: "p1", nodeId: "b", nodeAttempt: 1, cursor: 3 },
    { via: "program", programId: "p1", nodeId: "c", nodeAttempt: 1, cursor: 4 },
  ]);
  // Read back from disk, the same two files are one list of five with the two `via` values kept apart.
  await withRunDir(async (dir) => {
    await writeFile(
      join(dir, "actionTrace.jsonl"),
      `${actionTrace.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    await writeProgramExecutionTrace(dir, programRows);
    const merged = await readExecutionTrace(dir);
    assert.equal(merged.rows.length, 5);
    assert.deepEqual(
      merged.rows.map((row) => row.via),
      ["flat", "flat", "program", "program", "program"],
    );
    assert.equal(merged.flat.present, true);
    assert.equal(merged.program.present, true);
  });
});

test("a program whose journal could not be read contributes no rows and does not break the identity", async () => {
  // The unobserved program is the one fact the sum must exclude WITHOUT failing: a read failure is not a measured zero,
  // and it must not leave the run's rows unexplained either.
  const programOutcomes = [
    { programId: "p_unreadable", accepted: true, observed: false, dispatched: null, executions: [], nodeOutcomes: [] },
    observedProgram("p2", [{ nodeId: "a", nodeAttempt: 1, cursor: 1 }]),
  ];
  const programRows = programExecutionRows(programOutcomes);
  assert.equal(programRows.length, 1, "the unobserved program adds no row");
  const invariant = executionTraceInvariant({
    actionTrace: [flatRow("r-1", "till_soil")],
    programOutcomes,
    programRows,
  });
  // An unreadable program is absent evidence, not a measured zero: the observed sums still agree, and `ok` now says
  // whether the trace is COMPLETE - which it is not, because something was never looked at.
  assert.equal(invariant.sumsAgree, true, "an unobserved program must not fail the arithmetic");
  assert.equal(invariant.ok, false, "but a trace that never saw a program is not a complete trace");
  assert.equal(invariant.rows, 2);
  assert.equal(invariant.expectedRows, 2);
  assert.equal(invariant.programDispatches, 1, "only the observed program's count is in the sum");
  assert.equal(invariant.unobservedPrograms, 1, "and it is still reported, rather than silently dropped");
});

test("no execution is counted twice: an event read twice is one row, a retried node is two", () => {
  // The journal's identity for an execution is program + cursor (the page position it was read at) + node + attempt, so
  // a page boundary that repeats an event cannot inflate the count, while attempt 2 of the same node is a NEW execution.
  const programOutcomes = [
    observedProgram("p1", [
      { nodeId: "a", nodeAttempt: 1, cursor: 7 },
      { nodeId: "a", nodeAttempt: 1, cursor: 7 },
      { nodeId: "a", nodeAttempt: 2, cursor: 9 },
    ]),
  ];
  const programRows = programExecutionRows(programOutcomes);
  assert.equal(programRows.length, 2, "the repeated event is one execution; the retry is its own");
  assert.deepEqual(
    programRows.map((row) => row.nodeAttempt),
    [1, 2],
  );
  // Distinct programs never collide even at the same cursor: the program id is part of the identity.
  const twoPrograms = programExecutionRows([
    observedProgram("p1", [{ nodeId: "a", nodeAttempt: 1, cursor: 1 }]),
    observedProgram("p2", [{ nodeId: "a", nodeAttempt: 1, cursor: 1 }]),
  ]);
  assert.equal(twoPrograms.length, 2);
});

test("a program whose executions were lost on the way into the trace fails the identity loudly", () => {
  // The drift guard, and the reason this is an assertion rather than arithmetic: the Mod reported four executions and
  // only two rows exist, which is exactly the shape that made a working run's trace read as empty.
  const programOutcomes = [
    observedProgram("p1", [
      { nodeId: "a", nodeAttempt: 1, cursor: 1 },
      { nodeId: "b", nodeAttempt: 1, cursor: 2 },
      { nodeId: "c", nodeAttempt: 1, cursor: 3 },
      { nodeId: "d", nodeAttempt: 1, cursor: 4 },
    ]),
  ];
  const programRows = programExecutionRows(programOutcomes).slice(0, 2);
  const invariant = executionTraceInvariant({
    actionTrace: [flatRow("r-1", "till_soil")],
    programOutcomes,
    programRows,
  });
  assert.equal(invariant.ok, false);
  assert.equal(invariant.rows, 3);
  assert.equal(invariant.expectedRows, 5, "the expected count names the two rows that never made it");
});

test("the merged read tags a flat row written before the field existed, so it cannot read as program work", async () => {
  await withRunDir(async (dir) => {
    // A trace captured by an older runner: rows with no `via` and no program file at all.
    const legacy = { ...flatRow("r-1", "till_soil") };
    delete legacy.via;
    await writeFile(join(dir, "actionTrace.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");
    const merged = await readExecutionTrace(dir);
    assert.equal(merged.rows.length, 1);
    assert.equal(merged.rows[0].via, "flat");
    assert.equal(merged.program.present, false, "a run with no program file says so, instead of inventing rows");
    assert.deepEqual(merged.violations, [], "a run that declared no counts has nothing to disagree with");
  });
});

test("a trace that lost the executions its own manifest counted is a named violation at read time", async () => {
  // The reader-side half of the identity: the manifest says the run had five rows (2 flat, 3 program), the directory holds
  // four because the program file was truncated. Reading it as "four executions" would be a smaller run than the one
  // that happened, which is the defect this whole record exists to stop.
  await withRunDir(async (dir) => {
    const actionTrace = [flatRow("r-1", "till_soil"), flatRow("r-2", "water_crop")];
    const programRows = programExecutionRows([
      observedProgram("p1", [
        { nodeId: "a", nodeAttempt: 1, cursor: 1 },
        { nodeId: "b", nodeAttempt: 1, cursor: 2 },
        { nodeId: "c", nodeAttempt: 1, cursor: 3 },
      ]),
    ]);
    await writeFile(
      join(dir, "actionTrace.jsonl"),
      `${actionTrace.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    await writeProgramExecutionTrace(dir, programRows.slice(0, 2));
    await writeFile(
      join(dir, "manifest.json"),
      `${JSON.stringify({ executionTrace: { ok: true, flat: 2, program: 3, rows: 5 } })}\n`,
      "utf8",
    );
    const merged = await readExecutionTrace(dir);
    assert.equal(merged.rows.length, 4);
    assert.deepEqual(
      merged.violations.map((violation) => violation.code),
      ["execution_trace_rows_mismatch", "execution_trace_program_rows_mismatch"],
    );
    assert.equal(merged.violations[0].declaredCount, 5);
    assert.equal(merged.violations[0].actual, 4);
  });
});
