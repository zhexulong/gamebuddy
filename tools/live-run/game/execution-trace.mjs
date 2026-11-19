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

/**
 * ONE SUBMISSION PER PROGRAM, keeping the half the Mod took.
 *
 * A `programId` names a PROGRAM, not an attempt at submitting one. A submit whose answer never arrived is retried with
 * the same candidate and the Mod answers `idempotent` - measured 2026-11-19 (`round77`): `plan_122_0442da48ca242b09`
 * (1 node) and `plan_753_4e7cba07f9ad18a9` (3 nodes) were each submitted twice, `accepted` then `idempotent`. Iterating
 * the submission list therefore asked the Mod's journal about the same program twice and wrote two `observed: true`
 * outcomes for it, which the row identity below dedupes but the `dispatched` sum does not: that run published
 * `programDispatches: 477` against 473 rows and `sumsAgree: false` for 110 programs that all ran exactly once.
 *
 * The ACCEPTED half is the one kept, and it is kept in the position the first submission took, so the read order is the
 * order this run submitted. A submission with no `programId` cannot be grouped and is kept as its own record: two null
 * ids are not one program.
 *
 * `retried` names the ids that were submitted more than once, so the number of submissions and the number of programs
 * can differ without either of them being wrong.
 */
export function oneSubmissionPerProgram(submissions) {
  const kept = [];
  const retried = [];
  const indexByProgram = new Map();
  for (const submission of Array.isArray(submissions) ? submissions : []) {
    const programId = typeof submission?.programId === "string" ? submission.programId : null;
    if (programId === null) {
      kept.push(submission);
      continue;
    }
    const at = indexByProgram.get(programId);
    if (at === undefined) {
      indexByProgram.set(programId, kept.length);
      kept.push(submission);
      continue;
    }
    if (submission?.accepted === true && kept[at]?.accepted !== true) kept[at] = submission;
    if (!retried.includes(programId)) retried.push(programId);
  }
  return Object.freeze({ submissions: Object.freeze(kept), retried: Object.freeze(retried) });
}

/** How the execution reached the game: a request frame the runner sent, or a node the Mod dispatched natively. */
export const FLAT_EXECUTION_VIA = "flat";
export const PROGRAM_EXECUTION_VIA = "program";

/**
 * One row per program execution the Mod's journal reported.
 *
 * `nodeAttempt` and `cursor` are the journal's own identity for the execution: a retried node is a NEW attempt (and its
 * own execution), and the cursor is the page position the event was read at, so an identical event read twice collapses
 * to one row instead of counting as a second execution.
 *
 * `atMs` / `settledAtMs` are the Mod's own monotonic stamps for the dispatch and for the action's terminal, carried so
 * that the row IS the execution's duration. They are not this file's clock: a trace that stamped here would measure the
 * evaluator, and `settledAtMs` is null (never zero) for an execution that has not settled.
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
        Object.freeze({
          via: PROGRAM_EXECUTION_VIA,
          programId: outcome.programId,
          nodeId,
          nodeAttempt,
          cursor,
          atMs: Number.isFinite(execution?.atMs) ? execution.atMs : null,
          settledAtMs: Number.isFinite(execution?.settledAtMs) ? execution.settledAtMs : null,
        }),
      );
    }
  }
  return Object.freeze(rows);
}

/**
 * Node states in which the Mod has not yet attempted anything: the node waits for its turn, for admission, was
 * skipped/abandoned by a dependency, or the journal said nothing about it at all (`unknown`). They are named as a
 * NEGATIVE list on purpose - a state added later counts as an attempt rather than disappearing from the summary, which
 * is the direction that cannot hide work.
 *
 * `unknown` is here because a bundle's `nodeOutcomes` now carries a row for EVERY node the Host submitted, not only the
 * nodes the journal listed (`program-node-outcomes.mjs`): a node with no dispatch and no journal row is unanswered
 * evidence, while a node that WAS dispatched stays an attempt through `dispatchedNodes` below.
 */
export const NODE_STATES_WITHOUT_ATTEMPT = Object.freeze(
  new Set(["pending", "awaiting_host_admission", "host_admitted", "skipped_dependency", "abandoned", "unknown"]),
);

/**
 * The distinct actions the run TRIED and the distinct ones it SUCCEEDED at, read from both channels of an execution.
 *
 * A flat dispatch is a request frame the runner sent; a program execution is a node the Mod ran natively. They are two
 * facts, so each is read from its own source - `via: "flat"` rows in the trace, and the journal's execution/state rows
 * in `programOutcomes`. What they share is the ACTION: a program execution carries the journal's own identity
 * (`programId`, `nodeId`, `nodeAttempt`, `cursor`) and never an action id. A bundle's node outcome now carries the
 * action id beside its state (`program-node-outcomes.mjs`), projected from the candidate for the same reason it is
 * joined from it here: the candidate the Host submitted is the ONE authority for which action a node names, so both
 * readings derive from it and neither can invent an attribution. The join key is `(programId, nodeId)` against
 * `programSubmissions[].nodes`.
 *
 * The result is a set of action ids, so the same action dispatched through both channels - or retried twice - is one
 * entry: the two channels are counted from their own sources, and the action is counted once.
 */
export function executedActionIds({ actionTrace, programOutcomes, programSubmissions } = {}) {
  const attempted = new Set();
  const succeeded = new Set();
  const record = (actionId, didSucceed) => {
    if (typeof actionId !== "string" || actionId.length === 0) return;
    attempted.add(actionId);
    if (didSucceed) succeeded.add(actionId);
  };
  // The flat channel: a REFUSED dispatch is a row too, so an action the bridge stopped stays an attempt.
  for (const row of actionTrace ?? []) record(row?.action, row?.state === "succeeded");
  // The action id per node, as submitted: the only source that names it, so nothing here is ever guessed.
  const actionIdOfNode = new Map();
  for (const submission of programSubmissions ?? []) {
    if (typeof submission?.programId !== "string") continue;
    for (const node of submission?.nodes ?? []) {
      if (typeof node?.nodeId !== "string" || typeof node?.actionId !== "string") continue;
      actionIdOfNode.set(nodeKey(submission.programId, node.nodeId), node.actionId);
    }
  }
  for (const outcome of programOutcomes ?? []) {
    // An unobserved program is absent evidence, not a measured zero: it contributes no attempt at all.
    if (outcome?.observed !== true || typeof outcome.programId !== "string") continue;
    const dispatchedNodes = new Set();
    for (const execution of outcome.executions ?? [])
      if (typeof execution?.nodeId === "string") dispatchedNodes.add(execution.nodeId);
    const stateOfNode = new Map();
    for (const node of outcome.nodeOutcomes ?? [])
      if (typeof node?.nodeId === "string")
        stateOfNode.set(node.nodeId, typeof node.state === "string" ? node.state : null);
    for (const nodeId of new Set([...dispatchedNodes, ...stateOfNode.keys()])) {
      const state = stateOfNode.get(nodeId) ?? null;
      // A dispatch IS an attempt; a state past admission is the Mod recording what the attempt became. An unreadable
      // state with no dispatch is neither.
      const wasAttempted = dispatchedNodes.has(nodeId) || (state !== null && !NODE_STATES_WITHOUT_ATTEMPT.has(state));
      if (!wasAttempted) continue;
      record(actionIdOfNode.get(nodeKey(outcome.programId, nodeId)), state === "succeeded");
    }
  }
  return Object.freeze({ attempted: Object.freeze([...attempted]), succeeded: Object.freeze([...succeeded]) });
}

/** The join key between a journal node (`(programId, nodeId)`) and the candidate the Host submitted. */
function nodeKey(programId, nodeId) {
  return `${programId}\u001f${nodeId}`;
}

/**
 * ONE PROGRAM HAS ONE OUTCOME ROW, and this is the reading that says so.
 *
 * The population is the run's own record: the outcome rows it read, and the submissions it sent. `duplicated` is every
 * `programId` carrying more than one of those rows - which is not a bigger run but a doubled reading of one program, and
 * summing it produces a `programDispatches` no trace can agree with (`round77`: 477 against 473 rows, two ids of four
 * executions between them). `submissions` and `programs` are printed beside it because their DIFFERENCE is the only
 * proof a retry happened at all: equal numbers are a run with no retries, and a difference with `duplicated 0` is a
 * retry that was folded into the program it names.
 *
 * `submissions` is `null` when the caller did not hand over its submission list - not measured, never zero.
 */
export function oneRowPerProgram({ programSubmissions = null, programOutcomes = [] } = {}) {
  const outcomes = Array.isArray(programOutcomes) ? programOutcomes : [];
  const rowsByProgram = new Map();
  let unidentified = 0;
  for (const outcome of outcomes) {
    const programId = typeof outcome?.programId === "string" ? outcome.programId : null;
    if (programId === null) {
      unidentified += 1;
      continue;
    }
    rowsByProgram.set(programId, (rowsByProgram.get(programId) ?? 0) + 1);
  }
  const duplicatedPrograms = Object.freeze(
    [...rowsByProgram].filter(([, rows]) => rows > 1).map(([programId]) => programId),
  );
  const submissions = Array.isArray(programSubmissions) ? programSubmissions.length : null;
  return Object.freeze({
    ok: duplicatedPrograms.length === 0,
    submissions,
    programs: rowsByProgram.size,
    rows: outcomes.length,
    unidentified,
    duplicated: duplicatedPrograms.length,
    duplicatedPrograms,
    // THE GATE'S LINE, built HERE so the reading and what it prints cannot be two spellings of one count.
    line:
      `submissions ${submissions === null ? "not_measured" : String(submissions)} · programs ${String(rowsByProgram.size)}` +
      ` · rows ${String(outcomes.length)} · duplicated ${String(duplicatedPrograms.length)}`,
  });
}

/**
 * The row-count invariant, and what it was measured from.
 *
 * `ok` compares the rows this run is about to publish against the counts the programs themselves reported, so a
 * program whose executions were lost on the way into the trace cannot pass as a smaller run. `rows` is what a
 * measurement sees and `expectedRows` is what the flat dispatches plus the observed program executions say.
 *
 * TWO KINDS OF "NOT OBSERVED", AND THEY ARE NOT ONE NUMBER. A program the Mod TOOK whose journal could not be read is
 * absent evidence: the run's record has a hole in it. A submission the Mod answered `accepted: false` is a REFUSAL - the
 * Mod looked at the candidate and named why it would not run it (`rejected_by_mod`, after the edge cap refused a plan),
 * and nothing was ever dispatched for it to have lost. Measured 2026-11-19 (`round77`): `plan_172_29d21b6cffac1213`
 * (42 edges) and `plan_680_e1f502d99d744bc9` (35 edges) were both refused at submission, both counted as
 * `unobservedPrograms`, and the run was blocked for an execution log nobody had lost.
 */
export function executionTraceInvariant({ actionTrace, programOutcomes, programRows, programSubmissions = null }) {
  const flat = Array.isArray(actionTrace) ? actionTrace.length : 0;
  const outcomes = Array.isArray(programOutcomes) ? programOutcomes : [];
  const observed = outcomes.filter((outcome) => outcome?.observed === true);
  const programDispatches = observed.reduce(
    (total, outcome) => total + (Number.isInteger(outcome.dispatched) ? outcome.dispatched : 0),
    0,
  );
  const program = Array.isArray(programRows) ? programRows.length : 0;
  const refusals = Object.freeze(
    outcomes
      .filter((outcome) => outcome?.observed !== true && outcome?.accepted === false)
      .map((outcome) =>
        Object.freeze({
          programId: typeof outcome.programId === "string" ? outcome.programId : null,
          observation: typeof outcome.observation === "string" ? outcome.observation : "rejected_by_mod",
        }),
      ),
  );
  const unobservedPrograms = outcomes.filter(
    (outcome) => outcome?.observed !== true && outcome?.accepted !== false,
  ).length;
  const oneRow = oneRowPerProgram({ programSubmissions, programOutcomes: outcomes });
  return Object.freeze({
    // Three facts, all required. The first: every OBSERVED program's executions are in the trace. The second: nothing
    // the Mod took was left unread. The third: no program is counted twice. Complete means all three; the first alone
    // is completeness OF WHAT WE COULD READ, which is how fourteen programs vanished behind `ok: true` on 2026-10-25
    // while `unobservedPrograms` said 14.
    ok: program === programDispatches && unobservedPrograms === 0 && oneRow.ok,
    // Kept separate so a reader can tell "the numbers agree" from "we saw everything". A program whose journal could
    // not be read still contributes no rows and does not make the observed sums disagree; it is simply absent evidence,
    // and this field is where that lives.
    sumsAgree: program === programDispatches,
    flat,
    program,
    programDispatches,
    rows: flat + program,
    expectedRows: flat + programDispatches,
    // Programs the Mod took and whose journal nobody could read: a hole in the record.
    unobservedPrograms,
    // Submissions the Mod refused, BY NAME: not evidence that went missing, an answer that was given.
    refusals,
    // One program, one row - and the numbers it is computed from, including how many submissions produced them.
    oneRow,
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
