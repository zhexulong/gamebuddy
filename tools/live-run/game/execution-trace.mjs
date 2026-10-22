/**
 * A run's execution trace, written to two files and read back as ONE record.
 *
 * WHY TWO FILES. `actionTrace.jsonl` is the replayable REQUEST FRAME: every row is a dispatch this runner sent over the
 * bridge itself, and the bundle contract requires each row to carry its `requestId`, `action`, full `args` and the game
 * clock at dispatch, because that is everything a replay needs in order to send the same action again. An execution a
 * body program dispatched is a different kind of execution: the Mod runs the node natively and the wire reports only the
 * journal's own identity (`programId`, `nodeId`, `nodeAttempt`, `cursor`). There is no request frame behind it, no args
 * and no clock to record, so a row in `actionTrace.jsonl` would have to invent four fields the run never observed - and
 * the bundle contract refuses the whole manifest when they are missing, which would cost the run its evidence instead
 * of extending it. Program executions therefore go to `programTrace.jsonl` in the same run directory, and this module is
 * where the two are merged back into the one record a measurement reads.
 *
 * THE INVARIANT, stated here because this is where the trace is written: the number of execution rows a run has is its
 * flat dispatches plus the sum of the `dispatched` counts of the programs whose journal was OBSERVED. A flat dispatch
 * and a program node are different executions, so both are counted and neither twice; a program whose journal could not
 * be read (`observed: false`) contributes no rows and no count, and must not make the sum fail.
 *
 * The gap this closes, measured 2026-10-22: a run made 22 submissions, 16 accepted, every accepted program reporting
 * 1-4 `native_dispatch` executions and one program finishing `succeeded`, while `actionTrace.jsonl` held zero rows. The
 * run's own artifact said nothing ran. Every action-level measure taken from that file - settle-to-dispatch median,
 * share of dispatches under 500 ms, the gap after a move - silently excluded program work, so a run doing real work read
 * as if nothing had happened.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EVIDENCE_BUNDLE_FILES } from "../../lib/evidence-bundle.mjs";

/** The parallel trace file, in the same run directory as the flat one. */
export const PROGRAM_TRACE_FILE = "programTrace.jsonl";

/** How the execution reached the game: a request frame the runner sent, or a node the Mod dispatched natively. */
export const FLAT_EXECUTION_VIA = "flat";
export const PROGRAM_EXECUTION_VIA = "program";

/**
 * One row per program execution the Mod's journal reported.
 *
 * `nodeAttempt` and `cursor` are the journal's own identity for the execution: a retried node is a NEW attempt (and its
 * own execution), and the cursor is the page position the event was read at, so an identical event read twice collapses
 * to one row instead of counting as a second execution.
 */
export function programExecutionRows(programOutcomes) {
  const rows = [];
  const seen = new Set();
  for (const outcome of programOutcomes ?? []) {
    // An unobserved program `dispatched: null` and no rows: a journal read that failed is not a program that ran nothing.
    if (outcome?.observed !== true) continue;
    for (const execution of outcome.executions ?? []) {
      const nodeId = execution?.nodeId ?? null;
      const nodeAttempt = execution?.nodeAttempt ?? null;
      const cursor = execution?.cursor ?? null;
      const identity = `${String(outcome.programId)}\u001f${String(cursor)}\u001f${String(nodeId)}\u001f${String(nodeAttempt)}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      rows.push(
        Object.freeze({ via: PROGRAM_EXECUTION_VIA, programId: outcome.programId, nodeId, nodeAttempt, cursor }),
      );
    }
  }
  return Object.freeze(rows);
}

/**
 * The row-count invariant, and what it was measured from.
 *
 * `ok` compares the rows this run is about to publish against the counts the programs themselves reported, so a
 * program whose executions were lost on the way into the trace cannot pass as a smaller run. `rows` is what a
 * measurement sees and `expectedRows` is what the flat dispatches plus the observed program executions say.
 */
export function executionTraceInvariant({ actionTrace, programOutcomes, programRows }) {
  const flat = Array.isArray(actionTrace) ? actionTrace.length : 0;
  const observed = (programOutcomes ?? []).filter((outcome) => outcome?.observed === true);
  const programDispatches = observed.reduce(
    (total, outcome) => total + (Number.isInteger(outcome.dispatched) ? outcome.dispatched : 0),
    0,
  );
  const program = Array.isArray(programRows) ? programRows.length : 0;
  return Object.freeze({
    ok: program === programDispatches,
    flat,
    program,
    programDispatches,
    rows: flat + program,
    expectedRows: flat + programDispatches,
    unobservedPrograms: (programOutcomes ?? []).filter((outcome) => outcome?.observed !== true).length,
  });
}

/** One JSONL file of execution rows; a file that is not there is `present: false` with no rows, never an error. */
async function readTraceFile(path) {
  const text = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return Object.freeze({ path, present: false, rows: Object.freeze([]) });
  const rows = text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  return Object.freeze({ path, present: true, rows: Object.freeze(rows) });
}

/** Writes the program half of the trace. An empty list writes an empty file: a measured zero is a fact. */
export async function writeProgramExecutionTrace(runDir, programRows) {
  const path = join(runDir, PROGRAM_TRACE_FILE);
  const lines = `${(programRows ?? []).map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(path, lines, "utf8");
  return Object.freeze({ path, records: (programRows ?? []).length });
}

/**
 * Reads one run directory's executions as one list, in the order they were dispatched: the flat request frames, then
 * the program executions. This is the read-time merge; a reader that opens `actionTrace.jsonl` alone is reading the
 * request frames only, which is how program work becomes invisible.
 *
 * The count identity is CHECKED HERE, against what the run's own manifest declared when it wrote the trace: rows ==
 * declared `flat` + declared `program`, and each half against its own file. A run whose program executions were written
 * but lost, or whose flat file was replaced, is then a named violation at read time instead of a smaller measurement
 * nobody questions. A run captured before the manifest declared the counts has nothing to check against and is not
 * reported: history is not a defect.
 */
export async function readExecutionTrace(runDir) {
  const flat = await readTraceFile(join(runDir, EVIDENCE_BUNDLE_FILES.actionTrace));
  const program = await readTraceFile(join(runDir, PROGRAM_TRACE_FILE));
  // A flat row written before `via` existed is still a flat dispatch; it is tagged here rather than read as a program
  // execution by a filter that only looks for the field.
  const rows = [
    ...flat.rows.map((row) =>
      typeof row?.via === "string" ? row : Object.freeze({ via: FLAT_EXECUTION_VIA, ...row }),
    ),
    ...program.rows,
  ];
  const manifest = await readFile(join(runDir, EVIDENCE_BUNDLE_FILES.manifest), "utf8").then(
    (text) => JSON.parse(text),
    () => null,
  );
  const declared = manifest?.executionTrace;
  const violations = [];
  const compare = (code, declaredCount, actual) => {
    if (Number.isInteger(declaredCount) && declaredCount !== actual)
      violations.push(Object.freeze({ code, declaredCount, actual }));
  };
  if (declared !== undefined && declared !== null) {
    compare("execution_trace_rows_mismatch", declared.rows, rows.length);
    compare("execution_trace_flat_rows_mismatch", declared.flat, flat.rows.length);
    compare("execution_trace_program_rows_mismatch", declared.program, program.rows.length);
  }
  return Object.freeze({ rows: Object.freeze(rows), flat, program, violations: Object.freeze(violations) });
}
