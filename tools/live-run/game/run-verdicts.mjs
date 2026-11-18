/**
 * What a run's own records add up to: what it dispatched, what it accomplished, and whether the rung passed.
 *
 * The population every reading here is taken over comes from `execution-trace.mjs` (both dispatch channels), and
 * `NON_ACCOMPLISHMENT_ACTIONS` is the one spelling of "moving, looking and re-equipping is not playing" - the day's
 * work reading and the session verdict both read it, so a store that reads it one way cannot pass a run that another
 * reads the other way. `deriveRungVerdict` is the residual: a run is passed when no clause objects, and every clause
 * carries a code, so a blocked run can never publish an empty or borrowed reason.
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
 * The task's own verdict, from the purposes the day loop judged (`task-purpose.mjs`). One spelling, because the session
 * verdict and the rung clause both report it.
 *
 * THREE ANSWERS, and `null` is the only pass:
 *   - `task_not_achieved` when a purpose's receipts are COMPLETE evidence that it did not hold;
 *   - `task_unproven:<taskId>:<reasonCode>,...` when a purpose could not be decided at all - the criterion needs a fact
 *     nothing publishes, or the receipts that would decide it carried no postcondition of their own. It names the
 *     criterion AND the reason, so "we could not prove it" is a finding a reader can act on rather than silence;
 *   - `null` when every purpose was achieved.
 *
 * UNPROVEN IS NOT A PASS. Measured 2026-11-07 (`round39`): three days of `clear_and_plant_long_patch` came out
 * `unproven` - no admitted receipt carried a tile, so the 3x20 strip could be neither confirmed nor denied - and the
 * verdict named none of it, because the arm read only `not_achieved`. An unprovable criterion is a fact about our own
 * reporting, and a run that cannot say whether the task happened has not been verified as one that did.
 */
export function taskPurposeVerdict(taskPurposes) {
  const purposes = Array.isArray(taskPurposes) ? taskPurposes : [];
  if (purposes.some((purpose) => purpose.state === "not_achieved")) return "task_not_achieved";
  const unproven = purposes.filter((purpose) => purpose.state === "unproven");
  if (unproven.length === 0) return null;
  return `task_unproven:${unproven
    .map((purpose) => `${String(purpose.taskId ?? purpose.task)}:${String(purpose.reasonCode)}`)
    .join(",")}`;
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
