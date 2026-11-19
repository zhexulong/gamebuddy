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
  executedActionIds,
  executionTraceInvariant,
  oneRowPerProgram,
  oneSubmissionPerProgram,
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
      // The Mod's own monotonic stamps: dispatched at 1000/2000/3000, settled at 1200/2400 and never for "c".
      { nodeId: "a", nodeAttempt: 1, cursor: 2, atMs: 1000, settledAtMs: 1200 },
      { nodeId: "b", nodeAttempt: 1, cursor: 3, atMs: 2000, settledAtMs: 2400 },
      { nodeId: "c", nodeAttempt: 1, cursor: 4, atMs: 3000 },
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
    // No submission list was handed over, so the retry reading says `not_measured` rather than inventing a zero.
    refusals: [],
    oneRow: {
      ok: true,
      submissions: null,
      programs: 1,
      rows: 1,
      unidentified: 0,
      duplicated: 0,
      duplicatedPrograms: [],
      line: "submissions not_measured · programs 1 · rows 1 · duplicated 0",
    },
  });
  // The program rows name the program and the node, so a measurement can attribute the execution and never guess.
  assert.deepEqual(programRows, [
    { via: "program", programId: "p1", nodeId: "a", nodeAttempt: 1, cursor: 2, atMs: 1000, settledAtMs: 1200 },
    { via: "program", programId: "p1", nodeId: "b", nodeAttempt: 1, cursor: 3, atMs: 2000, settledAtMs: 2400 },
    { via: "program", programId: "p1", nodeId: "c", nodeAttempt: 1, cursor: 4, atMs: 3000, settledAtMs: null },
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

test("a program that dispatched its nodes is counted, though the flat trace the evaluator used to read is empty", () => {
  // Run-shaped, measured 2026-10-22 and again on every run since: every action goes through a Body Program, so
  // `actionTrace` holds no row while the companion tills, plants and harvests. The evaluator read that file alone, so
  // the session that did the work was reported `nothing_accomplished`. The action id is not in the flat trace, not in
  // the execution rows (`native_dispatch` carries only the journal's program/node/attempt/cursor identity) and not in
  // `nodeOutcomes` (node id and state only): it exists in ONE place, the candidate the Host submitted, whose nodes carry
  // `actionId`. The join key is therefore (programId, nodeId).
  const actionTrace = [];
  const programSubmissions = [
    {
      programId: "plan_16_a93f3dbf3576006d",
      code: "accepted",
      accepted: true,
      nodes: [
        { nodeId: "n01", actionId: "till_soil" },
        { nodeId: "n02", actionId: "plant_seed" },
      ],
    },
  ];
  const programOutcomes = [
    {
      programId: "plan_16_a93f3dbf3576006d",
      accepted: true,
      observed: true,
      dispatched: 2,
      executions: [
        { nodeId: "n01", nodeAttempt: 1, cursor: 2 },
        { nodeId: "n02", nodeAttempt: 1, cursor: 4 },
      ],
      nodeOutcomes: [
        { nodeId: "n01", state: "succeeded" },
        { nodeId: "n02", state: "failed" },
      ],
    },
  ];
  assert.deepEqual(actionTrace, [], "the file the evaluator read holds no row at all");
  const summary = executedActionIds({ actionTrace, programOutcomes, programSubmissions });
  assert.deepEqual(summary.attempted, ["till_soil", "plant_seed"], "both nodes are attempts on their own action ids");
  assert.deepEqual(summary.succeeded, ["till_soil"], "and only the node the journal settled as succeeded is one");
});

test("the two channels are counted from their own sources, and neither counts the other's work twice", () => {
  // A flat dispatch and a program execution ARE different facts - a request frame the runner sent versus a node the Mod
  // ran natively - so both are read, from their own source, and the identity that keeps them apart is the channel, not a
  // guess about the action id.
  const actionTrace = [
    { via: "flat", action: "harvest_crop", state: "succeeded" },
    // Rows written before `via` existed are still flat dispatches.
    { action: "water_crop", state: "rejected" },
  ];
  const programSubmissions = [
    {
      programId: "p1",
      accepted: true,
      nodes: [
        { nodeId: "n01", actionId: "harvest_crop" },
        { nodeId: "n02", actionId: "plant_seed" },
        { nodeId: "n03", actionId: "till_soil" },
      ],
    },
  ];
  const programOutcomes = [
    {
      programId: "p1",
      accepted: true,
      observed: true,
      dispatched: 3,
      executions: [
        { nodeId: "n01", nodeAttempt: 1, cursor: 1 },
        { nodeId: "n02", nodeAttempt: 1, cursor: 3 },
        { nodeId: "n01", nodeAttempt: 2, cursor: 5 },
      ],
      // n03 never dispatched and never left `pending`: a node waiting its turn is not an attempt.
      nodeOutcomes: [
        { nodeId: "n01", state: "succeeded" },
        { nodeId: "n02", state: "failed" },
        { nodeId: "n03", state: "pending" },
      ],
    },
  ];
  const summary = executedActionIds({ actionTrace, programOutcomes, programSubmissions });
  // `harvest_crop` was dispatched through BOTH channels and retried, and is one attempted action; `plant_seed` was
  // attempted and failed.
  assert.deepEqual(summary.attempted, ["harvest_crop", "water_crop", "plant_seed"]);
  assert.deepEqual(
    summary.succeeded,
    ["harvest_crop"],
    "a rejected flat frame and a failed node are attempts, not successes",
  );

  // An unobserved program is absent evidence, not a measured zero: it adds nothing rather than a `dispatched: 0` shape,
  // and it never invents an action id for a node whose candidate was not recorded.
  const unobserved = executedActionIds({
    actionTrace: [],
    programOutcomes: [
      {
        programId: "p_unreadable",
        accepted: true,
        observed: false,
        dispatched: null,
        executions: [],
        nodeOutcomes: [],
      },
      programOutcomes[0],
    ],
    programSubmissions: [{ programId: "p_unreadable", accepted: true, nodes: [] }],
  });
  assert.deepEqual(unobserved.attempted, [], "an unobserved program contributes no attempt");
  const noCandidate = executedActionIds({
    actionTrace: [],
    programOutcomes,
    programSubmissions: [],
  });
  assert.deepEqual(noCandidate.attempted, [], "a node with no recorded action id is not guessed into one");
});

test("a node the journal never reached is not an attempt, while a dispatched one still is", () => {
  // A bundle's `nodeOutcomes` now carries a row for every node the Host SUBMITTED, so the set of states this function
  // sees is wider than the Mod's own vocabulary. `unknown` means "the journal said nothing about this node": with no
  // dispatch beside it that is unanswered evidence, and counting it as an attempt would let a plan whose nodes never ran
  // publish work it did not do. `pending` is the same kind of fact and was already excluded.
  const programSubmissions = [
    {
      programId: "p1",
      accepted: true,
      nodes: [
        { nodeId: "n01", actionId: "till_soil" },
        { nodeId: "n02", actionId: "plant_seed" },
        { nodeId: "n03", actionId: "water_crop" },
      ],
    },
  ];
  const programOutcomes = [
    {
      programId: "p1",
      accepted: true,
      observed: true,
      dispatched: 1,
      executions: [{ nodeId: "n02", nodeAttempt: 1, cursor: 2 }],
      nodeOutcomes: [
        { nodeId: "n01", actionId: "till_soil", state: "pending" },
        // Dispatched, but the Mod's row said nothing: the dispatch itself is the attempt.
        { nodeId: "n02", actionId: "plant_seed", state: "unknown" },
        // Never dispatched and never recorded: nothing to attribute.
        { nodeId: "n03", actionId: "water_crop", state: "unknown" },
      ],
    },
  ];
  const summary = executedActionIds({ actionTrace: [], programOutcomes, programSubmissions });
  assert.deepEqual(summary.attempted, ["plant_seed"]);
  assert.deepEqual(summary.succeeded, []);
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
  assert.deepEqual(
    twoPrograms.map((row) => [row.programId, row.cursor]),
    [
      ["p1", 1],
      ["p2", 1],
    ],
    "both programs are in the trace, each identified by the program id that separates them",
  );
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

// A REFUSAL IS AN ANSWER, AND A RETRY IS THE SAME PROGRAM.
//
// Measured 2026-11-19 (`round77`): `result.executionTrace` came back
// `{ ok: false, sumsAgree: false, flat: 3, program: 473, programDispatches: 477, rows: 476, expectedRows: 480,
//   unobservedPrograms: 2 }` on a run that had lost nothing. Two of the "unobserved" programs were plans the Mod REFUSED
// at submission (42 and 35 edges against a cap of 32: `accepted: false`, `rejected_by_mod`), and 4 of the 477 counted
// dispatches were two programs submitted twice (`accepted` then `idempotent`) whose journal was therefore read twice.
const ROUND77_REFUSED = Object.freeze([
  Object.freeze({ programId: "plan_172_29d21b6cffac1213", accepted: false, observed: false, observation: "rejected_by_mod", dispatched: null, executions: [] }),
  Object.freeze({ programId: "plan_680_e1f502d99d744bc9", accepted: false, observed: false, observation: "rejected_by_mod", dispatched: null, executions: [] }),
]);

test("a submission the Mod refused is a refusal, not a lost execution log", () => {
  const programRows = programExecutionRows([...ROUND77_REFUSED]);
  const invariant = executionTraceInvariant({
    actionTrace: [],
    programOutcomes: ROUND77_REFUSED,
    programRows,
    programSubmissions: ROUND77_REFUSED,
  });
  assert.equal(invariant.unobservedPrograms, 0, "the Mod answered, so nothing went unread");
  assert.equal(invariant.ok, true, `a refusal must not block the run; got ${JSON.stringify(invariant)}`);
  assert.equal(invariant.sumsAgree, true, "and it contributes no rows, so the sums still agree");
  assert.deepEqual(
    invariant.refusals.map((entry) => entry.programId),
    ["plan_172_29d21b6cffac1213", "plan_680_e1f502d99d744bc9"],
    "the trace says WHICH submissions were refused, instead of counting them as evidence it never got",
  );
  assert.equal(invariant.refusals[0].observation, "rejected_by_mod", "and the Mod's own reason travels with each");

  // The other side of the same rule, so the relaxation cannot swallow a real hole: a program the Mod TOOK whose journal
  // nobody could read is still absent evidence and still fails the trace.
  const unread = executionTraceInvariant({
    actionTrace: [],
    programOutcomes: [
      { programId: "plan_taken_but_unreadable", accepted: true, observed: false, observation: "read_failed:bridge_disconnected" },
    ],
    programRows: [],
    programSubmissions: [{ programId: "plan_taken_but_unreadable", code: "accepted", accepted: true }],
  });
  assert.equal(unread.unobservedPrograms, 1);
  assert.equal(unread.ok, false);
  assert.deepEqual(unread.refusals, []);
});

test("a program submitted twice is one program: one outcome row, and the dispatches counted once", () => {
  // round77's own two retried ids, with the executions the Mod's journal reported for them.
  const duplicated = [
    observedProgram("plan_122_0442da48ca242b09", [{ nodeId: "n01", nodeAttempt: 1, cursor: 1 }]),
    observedProgram("plan_753_4e7cba07f9ad18a9", [
      { nodeId: "n01", nodeAttempt: 1, cursor: 1 },
      { nodeId: "n02", nodeAttempt: 1, cursor: 2 },
      { nodeId: "n03", nodeAttempt: 1, cursor: 3 },
    ]),
    observedProgram("plan_122_0442da48ca242b09", [{ nodeId: "n01", nodeAttempt: 1, cursor: 1 }]),
    observedProgram("plan_753_4e7cba07f9ad18a9", [
      { nodeId: "n01", nodeAttempt: 1, cursor: 1 },
      { nodeId: "n02", nodeAttempt: 1, cursor: 2 },
      { nodeId: "n03", nodeAttempt: 1, cursor: 3 },
    ]),
  ];
  const submissions = [
    { programId: "plan_122_0442da48ca242b09", code: "accepted", accepted: true },
    { programId: "plan_753_4e7cba07f9ad18a9", code: "accepted", accepted: true },
    { programId: "plan_122_0442da48ca242b09", code: "idempotent", accepted: false },
    { programId: "plan_753_4e7cba07f9ad18a9", code: "idempotent", accepted: false },
  ];

  // THE GATE, RED ON THE SHAPE THAT SHIPPED: four submissions, two programs, four rows.
  const before = oneRowPerProgram({ programSubmissions: submissions, programOutcomes: duplicated });
  assert.equal(before.ok, false, "two rows for one program is a doubled reading, never a bigger run");
  assert.deepEqual(
    before.duplicatedPrograms,
    ["plan_122_0442da48ca242b09", "plan_753_4e7cba07f9ad18a9"],
    "the gate names the ids it found",
  );
  assert.equal(
    before.line,
    "submissions 4 · programs 2 · rows 4 · duplicated 2",
    "and prints the population it decided that on",
  );

  // THE FIX, AND THE SAME GATE GREEN: the reader folds the retry into the accepted submission before it queries.
  const once = oneSubmissionPerProgram(submissions);
  assert.deepEqual(once.retried, ["plan_122_0442da48ca242b09", "plan_753_4e7cba07f9ad18a9"]);
  assert.deepEqual(
    once.submissions.map((submission) => submission.code),
    ["accepted", "accepted"],
    "the ACCEPTED half of each retry is the one kept, because it is the one the Mod took",
  );
  const outcomes = once.submissions.map((submission) =>
    observedProgram(
      submission.programId,
      submission.programId === "plan_122_0442da48ca242b09"
        ? [{ nodeId: "n01", nodeAttempt: 1, cursor: 1 }]
        : [
            { nodeId: "n01", nodeAttempt: 1, cursor: 1 },
            { nodeId: "n02", nodeAttempt: 1, cursor: 2 },
            { nodeId: "n03", nodeAttempt: 1, cursor: 3 },
          ],
    ),
  );
  const programRows = programExecutionRows(outcomes);
  const after = executionTraceInvariant({ actionTrace: [], programOutcomes: outcomes, programRows, programSubmissions: submissions });
  assert.equal(after.program, 4, "the rows are the four executions that happened");
  assert.equal(after.programDispatches, 4, "and the programs' own counts are the same four - each program one read");
  assert.equal(after.sumsAgree, true, "which is what makes the arithmetic agree");
  assert.equal(after.ok, true);
  assert.equal(after.oneRow.line, "submissions 4 · programs 2 · rows 2 · duplicated 0");
});
