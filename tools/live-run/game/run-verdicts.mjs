/**
 * What a run's own records add up to: what it dispatched, what it accomplished, and whether the rung passed.
 *
 * The population every reading here is taken over comes from `execution-trace.mjs` (both dispatch channels), and
 * `NON_ACCOMPLISHMENT_ACTIONS` is the one spelling of "moving, looking and re-equipping is not playing" - the day's
 * work reading and the session verdict both read it, so a store that reads it one way cannot pass a run that another
 * reads the other way. `deriveRungVerdict` is the residual: a run is passed when no clause objects, and every clause
 * carries a code, so a blocked run can never publish an empty or borrowed reason.
 *
 * `deriveRungVerdict` can only name the clauses it is HANDED, so the list it is handed is where a finding gets lost:
 * `assessmentRungClauses` turns an assessment's own clause list into rung clauses, one for one, so a clause a gate
 * produces is a clause the verdict reads without anyone restating it in the runner.
 */
import { executedActionIds } from "./execution-trace.mjs";

// Actions that MOVE the actor, LOOK at the world, or change only the actor's own gear.
// A play session that did nothing but these has not played: run H attempted 14 actions,
// got 14 refusals and one successful walk, harvested nothing, and still reported `passed`
// because the verdict only required "a real attempt". "Did the companion actually do
// something" is a different question from "did it try", and a rung whose whole job is to
// report what the companion could do must not call an empty session a success.
export const NON_ACCOMPLISHMENT_ACTIONS = Object.freeze(
  new Set([
    "move_to_tile",
    "travel",
    "enter_exit",
    "navigate_to_destination",
    "observe_scene",
    "inspect_world_map",
    "express_emote",
    "face_direction",
    "equip_tool",
  ]),
);

/**
 * What the run tried (`attempted`), succeeded at (`succeeded`), and changed (`accomplished`).
 *
 * Both CHANNELS of an execution are read, each from its own source (`execution-trace.mjs`): the flat request frames the
 * runner sent, and the nodes the Mod ran natively in a Body Program. An action id is counted once however many times it
 * was dispatched, so a run that batched everything through programs is no longer summarised as having done nothing -
 * measured 2026-10-22, when every action went through a program, `actionTrace` held zero rows and a session that tilled,
 * planted and harvested was reported `nothing_accomplished`.
 *
 * The verdict reads attempted and accomplished (moving, looking and re-equipping is not playing); the result publishes
 * the same three lists under its own names. One derivation, so the verdict and the artifact cannot disagree about what
 * the run did.
 */
export function summarizeDispatchedActions(actionTrace, programOutcomes, programSubmissions) {
  const { attempted, succeeded } = executedActionIds({ actionTrace, programOutcomes, programSubmissions });
  return Object.freeze({
    attempted,
    succeeded,
    accomplished: succeeded.filter((actionId) => !NON_ACCOMPLISHMENT_ACTIONS.has(actionId)),
  });
}

/**
 * Whether the turn that has just settled SUBMITTED a `sleep`, from both channels of a dispatch.
 *
 * The two channels keep their own record of a submission: a flat request frame lands in `actionTrace`, a Body Program's
 * node in `programSubmissions`. `sleep` travels both - it is a world-resetting plan action - so a reading that looked at
 * one channel would say "she never went to bed" for a night she ended through the other.
 *
 * `markers` (`dispatchMarkers()`) are the lengths both records had BEFORE the turn, so a dispatch can only ever be
 * attributed to the turn it happened in. The records are a parameter rather than a closure so this predicate can be
 * driven in isolation, against real trace rows and real submitted nodes, by `run-stardew-native-local-agent-ab-live.test.mjs`.
 *
 * `sleep` is spelled here as the action id the Mod's protocol declares (`BridgeProtocol.cs:2386`: it takes no
 * arguments), the same literal the night watcher already reads; only the SUBMISSION is asked about, because the question
 * this answers is "did she act", never "did it succeed".
 */
export function sleepSubmittedSince(markers, records) {
  if (records.trace.slice(markers.traceFrom).some((entry) => entry?.action === "sleep")) return true;
  return records.submissions
    .slice(markers.submissionsFrom)
    .some((submission) => (submission?.nodes ?? []).some((node) => node?.actionId === "sleep"));
}

/** Where a turn starts in both dispatch records, for `sleepSubmittedSince`. */
export function dispatchMarkers(trace, submissions) {
  return { traceFrom: trace.length, submissionsFrom: submissions.length };
}

/**
 * THE LAST THING SHE ACTUALLY DID, from whichever channel dispatched it - the fact a promise to go to bed is measured
 * against when no receipt contradicts it.
 *
 * <p>
 * The two channels keep their own record and their own clock: a flat request lands in `actionTrace` with
 * `settledAtMs`, and a Body Program lands in `programSubmissions` with `submittedAtMs` and no execution rows at all. The
 * newest of the two is the answer, and it is one RECORD rather than a count because the reading it feeds
 * (`sleepPromisesNotTaken`) has to be able to say what happened between the promise and the night instead of only that
 * nothing did. `null` when neither record holds a row - a turn that dispatched nothing is not a receipt.
 * </p>
 *
 * <p>
 * `round98` is why the program channel is here at all: every action of that day went through programs, so a reading of
 * `actionTrace` alone answered "the last thing she did" with a flat receipt from hours earlier.
 * </p>
 */
export function lastDispatchedReceipt(trace, submissions) {
  const flat = Array.isArray(trace) && trace.length > 0 ? trace[trace.length - 1] : null;
  const program = Array.isArray(submissions) && submissions.length > 0 ? submissions[submissions.length - 1] : null;
  const node = Array.isArray(program?.nodes) && program.nodes.length > 0 ? program.nodes[program.nodes.length - 1] : null;
  if (node === null && flat === null) return null;
  const flatAt = Number.isFinite(flat?.settledAtMs) ? flat.settledAtMs : null;
  const programAt = Number.isFinite(program?.submittedAtMs) ? program.submittedAtMs : null;
  // An unclocked row cannot outrank a clocked one, and an unclocked FLAT row does not outrank a dated program either: an
  // absent clock is not an old one, and `null >= null` is true in JavaScript, so the comparison is stated rather than
  // left to the operators.
  const preferProgram =
    node !== null && (flat === null || flatAt === null || (programAt !== null && programAt >= flatAt));
  if (preferProgram) {
    return Object.freeze({
      via: "program",
      actionId: node.actionId ?? null,
      programId: program.programId ?? null,
      atMs: programAt,
    });
  }
  return Object.freeze({
    via: "flat",
    actionId: flat?.action ?? null,
    state: flat?.state ?? null,
    reasonCode: flat?.reasonCode ?? null,
    atMs: flatAt,
  });
}

/**
 * The run's OWN prompt-turn cadence, from the moments the harness began its prompt turns.
 *
 * `readObjectiveState` needs one span to answer "the objective's reading has not moved for a whole turn", and a turn
 * of this run is what that phrase means: a companion's turn takes as long as this run's turns take, so the number is
 * measured from the turn stream instead of chosen here (measured 2026-11-11, `round45`: 62 prompt turns in 2510 s, so
 * about 40 s a turn). Fewer than two turns is not a zero interval - it is no interval, and `null` makes
 * `readObjectiveState` answer `advancing` rather than licence a stall nobody measured.
 */
export function medianPromptTurnIntervalMs(starts) {
  if (starts.length < 2) return null;
  const intervals = starts.slice(1).map((start, index) => start - starts[index]);
  const sorted = [...intervals].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * WHAT EACH OF A RUN'S DAY PURPOSES WAS DECIDED AS, as counts and as the days themselves.
 *
 * <p>
 * The states are read APART rather than collapsed: `judged` is a day the evidence decided (`achieved` or
 * `not_achieved`), `unproven` is a day whose receipts proved nothing either way, and `unjudged` is a day whose criterion
 * asks for a fact nothing publishes - so no receipt set could ever have decided it (`task-purpose.mjs`). Merging the last
 * two would make a run that measured nothing look like a run that found nothing.
 * </p>
 * <p>
 * `unjudgedDays` carries each such day WITH ITS MISSING FACT, because the count is not the diagnosis: `unjudged 2 of 3`
 * does not tell a reader which capability the run could not be scored on, and the fact does.
 * </p>
 */
export function taskPurposeReading(taskPurposes) {
  const purposes = (Array.isArray(taskPurposes) ? taskPurposes : []).filter(
    (purpose) => purpose !== null && typeof purpose === "object",
  );
  const days = purposes.map((purpose) =>
    Object.freeze({
      day: Number.isInteger(purpose.day) ? purpose.day : null,
      // `taskId` and `task` are the two spellings a day's purpose arrives with; this is where they become one.
      task: purpose.taskId ?? purpose.task ?? null,
      state: typeof purpose.state === "string" ? purpose.state : null,
      reasonCode: typeof purpose.reasonCode === "string" ? purpose.reasonCode : null,
      missingFact: typeof purpose.missingFact === "string" ? purpose.missingFact : null,
    }),
  );
  const ofState = (state) => days.filter((day) => day.state === state);
  const notAchieved = ofState("not_achieved");
  return Object.freeze({
    days: days.length,
    judged: days.filter((day) => day.state === "achieved").length + notAchieved.length,
    notAchieved: notAchieved.length,
    unproven: ofState("unproven").length,
    unjudged: ofState("unjudged").length,
    unprovenDays: Object.freeze(ofState("unproven")),
    unjudgedDays: Object.freeze(ofState("unjudged")),
  });
}

/** The reading as ONE line: `days 3 · judged 2 · unproven 0 · unjudged 1`. */
export function describeTaskPurposeReading(reading) {
  const count = (field) => (reading === null || reading === undefined ? "not_measured" : String(reading[field]));
  return `days ${count("days")} · judged ${count("judged")} · unproven ${count("unproven")} · unjudged ${count("unjudged")}`;
}

/** One unjudged day and the fact nobody publishes: `day 3 sweep_yard_and_work: unjudged · <code> · <fact>`. */
export function describeUnjudgedDay(day) {
  if (day === null || day === undefined) return "unjudged: not_measured";
  return (
    `day ${day.day === null ? "?" : String(day.day)} ${String(day.task)}: unjudged · ${String(day.reasonCode)} · ` +
    `${day.missingFact ?? "no fact named"}`
  );
}

/**
 * The task's own verdict, from the purposes the day loop judged (`task-purpose.mjs`). One spelling, because the session
 * verdict and the rung clause both report it.
 *
 * FOUR ANSWERS, and `null` is the only pass:
 *   - `task_not_achieved` when a purpose's receipts are COMPLETE evidence that it did not hold. It is the only state the
 *     companion can be blamed for, so it outranks every day that could not be decided;
 *   - `task_unproven:<taskId>:<reasonCode>,...` when a NON-gap purpose could not be decided - the receipts that would
 *     decide it carried no postcondition of their own. It names the criterion AND the reason, so "we could not prove it"
 *     is a finding a reader can act on rather than silence. Measured 2026-11-07 (`round39`): three days of
 *     `clear_and_plant_long_patch` came out `unproven` because no admitted receipt carried a tile, and the verdict named
 *     none of it - the arm read only `not_achieved`. A run that cannot say whether the task happened has not been
 *     verified as one that did;
 *   - `task_purposes_nothing_judged:<unjudged>of<days>` when EVERY day was a gap day. A state that excuses an unprovable
 *     criterion must not be able to excuse the whole run: judged by nothing is not a pass, and `unjudged 3 of 3` says
 *     which way it failed;
 *   - `null` when every purpose was achieved or unjudged, with at least one day the evidence actually decided.
 *
 * See `taskPurposeReading` for how the three day states are kept apart.
 */
export function taskPurposeVerdict(taskPurposes) {
  const reading = taskPurposeReading(taskPurposes);
  if (reading.notAchieved > 0) return "task_not_achieved";
  // A GAP DAY IS NOT A FAILED DAY. Measured 2026-11-20 (`round81`): day 3 was `sweep_yard_and_work`, whose purpose
  // nothing publishes, and the run was blocked for a task no run could have passed. `unjudged` days are therefore absent
  // from this answer - named beside it by `taskPurposeReading` instead, so the gap stays visible without being a verdict.
  if (reading.unprovenDays.length > 0)
    return `task_unproven:${reading.unprovenDays
      .map((day) => `${String(day.task)}:${String(day.reasonCode)}`)
      .join(",")}`;
  if (reading.days > 0 && reading.judged === 0)
    return `task_purposes_nothing_judged:${String(reading.unjudged)}of${String(reading.days)}`;
  return null;
}

/**
 * The states an assessment's clause can be in and NOT object to the run, and the one that objects.
 *
 * `not_exercised` is the assessment saying the run never put that clause in front of itself - no player line to answer, no
 * setback to narrate - and it always carries the fact that stopped it (`no_player_input_found`), so the clause travels
 * with its reason instead of vanishing into a silent pass. Anything outside this set, INCLUDING a state this adapter has
 * never seen, objects: a vocabulary that changed shape is a finding, not a pass.
 */
export const NON_OBJECTING_ASSESSMENT_STATES = Object.freeze(new Set(["pass", "not_exercised"]));

/**
 * The clauses an ASSESSMENT produces, as rung clauses - one rung clause per assessed clause, so none can be dropped.
 *
 * WHY THE POPULATION IS DERIVED (measured 2026-11-20, `round82`). The interaction-value gate published `verdict:
 * "failed"` - `no_step_reports` failed on one bare progress report - and the run's `failedClauses` named
 * `action_breadth` alone. Neither half was wrong: the gate had judged, and `deriveRungVerdict` lists EVERY clause it is
 * handed. What was missing was the clause itself, because the runner's clause list was written by hand and named the
 * interaction assessment nowhere - so the strongest finding about the companion that run produced was published beside
 * the verdict and never entered it. A clause that can fail and cannot appear in the reason code is a clause nobody will
 * fix, and the next clause the assessment grows would have been dropped the same way. The population is therefore the
 * assessment's OWN report: each clause becomes `<id>:<clauseId>`, carrying the assessment's own reason code, and a
 * clause it starts producing arrives here without anyone remembering to add it.
 *
 * A report with NO clauses at all blocks instead of passing: `every` is vacuously true over an empty list, so such a
 * report answers `verdict: "passed"`, and a rung that read that answer would publish a pass built on nothing.
 */
export function assessmentRungClauses(id, assessment) {
  const clauses = Array.isArray(assessment?.clauses) ? assessment.clauses : [];
  if (clauses.length === 0)
    return Object.freeze([Object.freeze({ id, passed: false, reasonCode: "assessment_carried_no_clauses" })]);
  return Object.freeze(
    clauses.map((clause) => {
      const clauseId = String(clause?.id ?? "unnamed_clause");
      const state = String(clause?.state ?? "unstated");
      return Object.freeze({
        id: `${id}:${clauseId}`,
        passed: NON_OBJECTING_ASSESSMENT_STATES.has(state),
        // The gate's OWN code, never a paraphrase: `bare_step_reports` and `setback_happened_and_was_never_narrated` are
        // different findings about the companion, and the code a reader acts on is the one the assessment wrote.
        reasonCode:
          typeof clause?.reason === "string" && clause.reason.length > 0 ? clause.reason : `${id}:${clauseId}:${state}`,
      });
    }),
  );
}

/**
 * The rung's verdict, and the ONE code that says why it is not a pass.
 *
 * A blocked run used to publish the SCENARIO it ran in as its reason (`${SCENARIO}_blocked` was the fallback in
 * `buildRunResult`), which is not a diagnosis: it names the rung, and the rung is not what failed. Measured
 * 2026-11-06 on `round38` - `state: "blocked"`, `failure.reasonCode: "multiday_routine_blocked"`, while the
 * multi-day assessment said `passed`, the session verdict said `completed` and the historian rubric said `passed`.
 * The only thing the run had actually failed was its companion-interaction gate (`summary_too_long`, 124 characters),
 * and nothing in the artifact said so; the launcher's own summary printed `reason (none)`.
 *
 * So the clauses are named, in the order a reader should be told about them, and the FIRST one that fails is the
 * reason. `passed` is the residual - a run is passed when no clause objects - and every clause carries a code, so a
 * blocked run can never publish an empty or borrowed reason.
 */
export function deriveRungVerdict(clauses) {
  const all = Array.isArray(clauses) ? clauses : [];
  // EVERY clause that failed, not only the first: the reason a run is not passed is the first failing clause, but a
  // reader must not have to infer that a second, independent clause also failed. Measured 2026-11-07 (`round39`): the
  // rung's reason was `multiday_routine_blocked`, and the run's own task purposes were ALL `unproven` - a second finding
  // that existed in the evidence and in no verdict field, so the bundle read as if the task had never been asked.
  const failed = all.filter((clause) => clause?.passed !== true);
  const failedClauses = Object.freeze(
    failed.map((clause) => Object.freeze({ id: clause?.id ?? null, reasonCode: clause?.reasonCode ?? null })),
  );
  for (const clause of all) {
    if (clause?.passed !== true)
      return Object.freeze({
        state: "blocked",
        reasonCode: clause?.reasonCode ?? null,
        failedClause: clause?.id ?? null,
        failedClauses,
      });
  }
  return Object.freeze({ state: "passed", reasonCode: null, failedClause: null, failedClauses });
}
