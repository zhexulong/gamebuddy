// red-proof: inject  removing `...assessmentRungClauses("interaction_value", interactionValue),` from the runner's
//   clause list -> `a_clause_that_can_fail_reaches_the_reason_code:interaction_value:no_step_reports=bare_step_reports`
//   at tools/live-run/game/run-verdicts.test.mjs (this file's gate), and the same removal is `round82`'s published
//   `failedClauses` holding `action_breadth` alone.
//
// THE PLUMBING BETWEEN A VERDICT AND THE REASON CODE.
//
// `round82` (2026-11-20, `_multiday_routine-round82.result.json`) published `interactionValue.verdict: "failed"` -
// `no_step_reports` failed on one bare progress report - inside `state: "blocked"` whose `failedClauses` and
// `reasonCode` named `action_breadth` alone. The gate had judged and `deriveRungVerdict` lists every clause it is
// handed; the clause was never handed over, because the runner's clause list was written by hand.
//
// So the population here is not a list of clause names: it is the clause list the assessment itself produces, read from
// the REAL `assessInteractionValue` over a real run directory, plus the runner's own clause-list text. What the gate
// holds is one property - a clause that can fail reaches the reason code - and it reports four numbers so a reader can
// see the population it held it over: `clauses C · blocking B · non-blocking-declared N · dropped D`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assessInteractionValue } from "../interaction-value-gate.mjs";
import { assessmentRungClauses, deriveRungVerdict, lastDispatchedReceipt } from "./run-verdicts.mjs";

const RUN_START = Date.parse("2026-11-04T10:00:00.000Z");
const at = (minutes) => RUN_START + Math.round(minutes * 60_000);
const iso = (minutes) => new Date(at(minutes)).toISOString();
const RUN_NAME = "2026-11-04T10-00-00-000Z-interaction-value";

/** The runner that assembles the verdict: its clause list is the half of this pipeline the gate has to read. */
const RUNNER_SOURCE = readFileSync(new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url), "utf8");

/**
 * The runner's rung-clause list, and the assertion that the boundaries of the slice still exist.
 *
 * A slice taken between two markers that have moved is the empty string, and a gate that reads an empty string finds
 * nothing and reports nothing: the wiring check below would pass because the code it reads had been renamed away.
 */
function rungClauseList(source) {
  const start = source.indexOf("const rungClauses = Object.freeze([");
  const end = source.indexOf("const result = await buildRunResult({\n    rungClauses,");
  assert.ok(start >= 0 && end > start, "the runner must declare its rung clauses in one list, and pass them");
  return source.slice(start, end);
}

const assistant = (text, minute) => ({
  type: "message",
  timestamp: iso(minute),
  message: { role: "assistant", content: [{ type: "text", text }] },
});

/** A player's line in the delivery shape the pump sends: a fact batch carrying the input it has to take up. */
const playerLine = (text, minute) => ({
  type: "message",
  timestamp: iso(minute),
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          kind: "gamebuddy_fact_batch",
          batchId: `batch-${minute}`,
          disposition: "steer",
          triggerEventIds: [],
          playerInputs: [{ source: "player_text", inputId: `input-${minute}`, text }],
          worldFacts: [],
          events: [],
        }),
      },
    ],
  },
});

const sessionHeader = (minute) => ({
  type: "session",
  version: 3,
  id: "session",
  timestamp: iso(minute),
  cwd: "/run",
});

const milestone = (minute, gameTime) => ({
  type: "world_fact",
  atMs: at(minute),
  worldFactKind: "time_milestone",
  worldFactPayload: { kind: "time_milestone", gameTime },
});

/**
 * A run directory in the product's captured shape, holding one session record the run can bind: the file is stamped with
 * the moment the runtime opened it, and that stamp is what the gate's population filter reads.
 */
function writeRun(t, { timeline, session }) {
  const root = mkdtempSync(join(tmpdir(), "gb-run-verdicts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runDir = join(root, RUN_NAME);
  const sessions = join(runDir, "runtime-root", "contexts", "hash", "surface-sessions", "game-1", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(runDir, "timeline.jsonl"), timeline.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const stamp = new Date(Date.parse(String(session[0].timestamp)))
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  writeFileSync(
    join(sessions, `${stamp}_01a1a61a-f518-76e4-8b96-37d7f118b88c.jsonl`),
    session.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  return runDir;
}

/**
 * `round82`'s OWN REPORT, verbatim from `_multiday_routine-round82.result.json`.
 *
 * The run's clock advanced, so the interaction gate is the part of its verdict that was decided; one line was judged a
 * bare progress report. Whether that line IS one is the assessment's call and this file does not re-judge it - what it
 * holds is that the assessment's answer reaches the run's reason code.
 */
const ROUND82_INTERACTION_VALUE = Object.freeze({
  verdict: "failed",
  clauses: Object.freeze([
    Object.freeze({ id: "player_or_day_rate", state: "pass", reason: null }),
    Object.freeze({ id: "player_agency", state: "pass", reason: null }),
    Object.freeze({ id: "obstacle_with_plan", state: "pass", reason: null }),
    Object.freeze({ id: "no_step_reports", state: "fail", reason: "bare_step_reports" }),
  ]),
});

/**
 * THE GATE: `a_clause_that_can_fail_reaches_the_reason_code:<clause>`.
 *
 * The population is the clauses the assessment produced. Each one is derived into a rung clause, and the run's verdict is
 * taken over what the RUNNER'S OWN clause list would hand it: a clause whose derivation the list does not spread was never
 * part of the verdict, however loudly the assessment failed it.
 *
 * `blocking` is every clause that objects, `non-blocking-declared` every clause published as satisfied with the
 * assessment's own reason (`pass`, or `not_exercised` carrying the fact that stopped it), and `dropped` the objecting
 * clauses the verdict does not name. `dropped N>0` is the defect, and the caller's assertion names each one.
 */
function clauseCoverage(id, assessment, { rungClauseList: list }) {
  const derived = assessmentRungClauses(id, assessment);
  // The wiring is a text fact about the runner: `...assessmentRungClauses("<id>", <report>)` inside the clause list.
  const wired = new RegExp(`\\.\\.\\.assessmentRungClauses\\("${id}", interactionValue\\),`, "u").test(list);
  const verdict = deriveRungVerdict(wired ? derived : []);
  const blocking = derived.filter((clause) => clause.passed !== true);
  const declared = derived.filter((clause) => clause.passed === true);
  const dropped = blocking.filter((clause) => !verdict.failedClauses.some((failed) => failed.id === clause.id));
  const line =
    `clauses ${assessment.clauses.length} · blocking ${blocking.length} · ` +
    `non-blocking-declared ${declared.length} · dropped ${dropped.length} · wired ${wired ? "yes" : "no"}`;
  console.log(`[${id}] ${line}`);
  return { derived, verdict, blocking, declared, dropped, wired, line };
}

/** The assertion, in the gate's own name: it names the clause, its state and the accounting it was decided over. */
function assertNothingDropped(coverage) {
  assert.deepEqual(
    coverage.dropped.map((clause) => `${clause.id}=${clause.reasonCode ?? "no_reason_code"}`),
    [],
    `a_clause_that_can_fail_reaches_the_reason_code:${coverage.dropped.length === 0 ? "none" : coverage.dropped[0].id} ` +
      `· ${coverage.line}`,
  );
}

test("a clause that can fail reaches the reason code, over every clause the real assessment produces", (t) => {
  // ONE FIXTURE, FOUR OBJECTING CLAUSES, from the real gate rather than a paraphrase of its answer: a bare step report
  // (clause 4), no remark about the player or the day in thirty minutes (clause 1), an obstacle with no next plan
  // (clause 3), and a player line nothing took up (clause 2).
  const runDir = writeRun(t, {
    timeline: [
      { type: "lifecycle", atMs: at(0), reasonCode: "session_ready" },
      milestone(0, "0600"),
      milestone(30, "0730"),
    ],
    session: [
      sessionHeader(0),
      assistant("草浇完了，石头也敲完了。", 5),
      assistant("石头太多，搬不动。", 10),
      playerLine("今天先把北边那片清出来吧", 15),
    ],
  });
  const assessment = assessInteractionValue({ runDir });

  assert.equal(assessment.verdict, "failed", "the fixture must be one the gate itself reds");
  assert.deepEqual(
    assessment.clauses.map((clause) => `${clause.id}:${clause.state}`),
    ["player_or_day_rate:fail", "player_agency:fail", "obstacle_with_plan:fail", "no_step_reports:fail"],
    "the population is every clause the assessment produces, and this run put all four in front of it",
  );

  const coverage = clauseCoverage("interaction_value", assessment, { rungClauseList: rungClauseList(RUNNER_SOURCE) });
  assert.equal(coverage.derived.length, assessment.clauses.length, "one rung clause per assessed clause");
  assert.equal(coverage.blocking.length, 4);
  assert.equal(coverage.declared.length, 0);
  assert.equal(coverage.wired, true, "the runner's clause list must spread the derivation, not restate it");
  assertNothingDropped(coverage);
  // Each failing clause is named by its own id, in the order the assessment reports them, carrying ITS reason code.
  assert.deepEqual(
    coverage.verdict.failedClauses,
    [
      {
        id: "interaction_value:player_or_day_rate",
        reasonCode: "fewer_player_or_day_remarks_than_one_per_five_minutes",
      },
      { id: "interaction_value:player_agency", reasonCode: "every_player_input_went_unanswered" },
      { id: "interaction_value:obstacle_with_plan", reasonCode: "obstacle_narrated_without_a_next_plan" },
      { id: "interaction_value:no_step_reports", reasonCode: "bare_step_reports" },
    ],
    "every objecting clause reaches `failedClauses`, with the code its own gate wrote",
  );
  assert.equal(coverage.verdict.state, "blocked");
  assert.equal(coverage.verdict.reasonCode, "fewer_player_or_day_remarks_than_one_per_five_minutes");
  assert.equal(coverage.verdict.failedClause, "interaction_value:player_or_day_rate");
});

test("round82's own verdict: the bare step report it failed on reaches the reason code", () => {
  // The measured defect, in the shape it was published: `state: "blocked"` by `action_breadth`, `failedClauses` holding
  // that one clause, and this report sitting in the evidence with `no_step_reports` failed. The gate's answer here is
  // the production answer, taken over the runner's real clause list.
  const coverage = clauseCoverage("interaction_value", ROUND82_INTERACTION_VALUE, {
    rungClauseList: rungClauseList(RUNNER_SOURCE),
  });
  assert.equal(coverage.derived.length, 4);
  assert.equal(coverage.blocking.length, 1, "one clause failed, so one clause objects");
  assert.equal(
    coverage.declared.length,
    3,
    "the three satisfied clauses are published as non-blocking, each carrying its own code",
  );
  assert.deepEqual(
    coverage.declared.map((clause) => clause.reasonCode),
    [
      "interaction_value:player_or_day_rate:pass",
      "interaction_value:player_agency:pass",
      "interaction_value:obstacle_with_plan:pass",
    ],
  );
  assertNothingDropped(coverage);

  // BESIDE `action_breadth`, not instead of it: the breadth finding was real too, and `deriveRungVerdict` publishes both
  // in the order the runner declares them - the interaction clauses before the breadth clause, so the companion's own
  // conduct is the run's first reason (`buildRunResult` appends `actionBreadthClause` after `rungClauses`).
  const verdict = deriveRungVerdict([
    ...coverage.derived,
    {
      id: "action_breadth",
      passed: false,
      reasonCode: "narrow:below_baseline:round38:families=buildings_farm_management,shops_economy",
    },
  ]);
  assert.deepEqual(
    verdict.failedClauses.map((clause) => clause.id),
    ["interaction_value:no_step_reports", "action_breadth"],
  );
  assert.equal(
    verdict.reasonCode,
    "bare_step_reports",
    "the run's first reason is the finding the verdict names first",
  );
  assert.equal(verdict.failedClause, "interaction_value:no_step_reports");
});

test("a clause the run never exercised is published as non-blocking, with the fact that stopped it", () => {
  // `not_exercised` is the gate saying the run never put the clause in front of itself, and a run whose session record
  // cannot be bound is every clause unexercised at once. It is declared non-blocking WITH its reason, so a reader can
  // tell an untriggered clause from a satisfied one - and so this pipeline does not inherit a second decision about it.
  const unbound = assessInteractionValue({ timelineFacts: [], sessionUnboundReason: "no_session_record_found" });
  assert.equal(unbound.verdict, "not_established");

  const coverage = clauseCoverage("interaction_value", unbound, { rungClauseList: rungClauseList(RUNNER_SOURCE) });
  assert.equal(coverage.blocking.length, 0);
  assert.equal(coverage.declared.length, 4);
  assert.deepEqual(
    coverage.declared.map((clause) => clause.reasonCode),
    [
      "session_not_bound:no_session_record_found",
      "session_not_bound:no_session_record_found",
      "session_not_bound:no_session_record_found",
      "session_not_bound:no_session_record_found",
    ],
  );
  assertNothingDropped(coverage);
  assert.equal(coverage.verdict.state, "passed", "a clause nobody could exercise is not a clause that failed");
});

test("a report with no clauses blocks instead of passing over an empty population", () => {
  // The other way this pipeline can lose a finding: an assessment whose clause list went missing answers
  // `verdict: "passed"` (`every` is vacuously true), and a rung reading that answer would publish a pass built on
  // nothing. `blocking` is 1 here because the derivation refuses the zero, and the code says which zero it was.
  const coverage = clauseCoverage(
    "interaction_value",
    { verdict: "passed", clauses: [] },
    {
      rungClauseList: rungClauseList(RUNNER_SOURCE),
    },
  );
  assert.equal(coverage.derived.length, 1);
  assert.equal(coverage.derived[0].passed, false);
  assert.equal(coverage.derived[0].reasonCode, "assessment_carried_no_clauses");
  assert.equal(coverage.verdict.state, "blocked");
  assertNothingDropped(coverage);
});

test("the runner's clause list names no interaction finding by hand", () => {
  // THE POPULATION IS DERIVED, and this is what keeps it so: a clause id written into the list by hand is a second
  // spelling of the assessment's vocabulary, and the next clause the gate grows would be missing from it. The list may
  // only carry the spread.
  const list = rungClauseList(RUNNER_SOURCE);
  assert.doesNotMatch(
    list,
    /id: "interaction_value/u,
    "the interaction clauses come from the assessment, not from here",
  );
  assert.match(list, /\.\.\.assessmentRungClauses\("interaction_value", interactionValue\),/u);
});

// THE LAST THING SHE ACTUALLY DID, across the two dispatch channels - the fact a bedtime promise is read against when no
// receipt contradicts it. `round98` routed every action of that day through programs, so a reading of `actionTrace` alone
// answered with a flat receipt from hours earlier.
test("the last thing she did is the newest dispatch record, from whichever channel it went out on", () => {
  const flat = (action, settledAtMs) => ({ via: "flat", action, state: "succeeded", reasonCode: "ok", settledAtMs });
  const program = (actionId, submittedAtMs) => ({
    programId: `plan_${actionId}`,
    accepted: true,
    submittedAtMs,
    nodes: [{ nodeId: "n01", actionId, arguments: {} }],
  });
  // NEITHER CHANNEL RECORDED ANYTHING: there is no receipt, which is not a receipt of doing nothing.
  assert.equal(lastDispatchedReceipt([], []), null);
  assert.equal(lastDispatchedReceipt(undefined, undefined), null);
  // Only one channel has a row: that row is the answer, whatever it is.
  assert.equal(lastDispatchedReceipt([flat("cut_weeds", 1000)], []).actionId, "cut_weeds");
  assert.deepEqual(lastDispatchedReceipt([], [program("sleep", 2000)]), {
    via: "program",
    actionId: "sleep",
    programId: "plan_sleep",
    atMs: 2000,
  });
  // BOTH HAVE ROWS AND THE CLOCKS DECIDE, in both directions on the same pair of records.
  assert.equal(lastDispatchedReceipt([flat("enter_exit", 3000)], [program("chest_store", 2000)]).actionId, "enter_exit");
  assert.equal(lastDispatchedReceipt([flat("enter_exit", 1000)], [program("chest_store", 2000)]).actionId, "chest_store");
  // AN UNCLOCKED FLAT ROW CANNOT OUTRANK A CLOCKED PROGRAM: an absent clock is not an old one, and reading it as `-Infinity`
  // silently would make the program win on a comparison nobody made.
  assert.equal(lastDispatchedReceipt([{ via: "flat", action: "harvest_crop" }], [program("cut_weeds", 2000)]).via, "program");
  // A program the Mod never accepted is still what she dispatched: the record names what she did, not what worked.
  const rejected = { programId: "plan_rejected", accepted: false, submittedAtMs: 4000, nodes: [{ nodeId: "n01", actionId: "sleep" }] };
  assert.equal(lastDispatchedReceipt([flat("enter_exit", 3000)], [rejected]).actionId, "sleep");
});
