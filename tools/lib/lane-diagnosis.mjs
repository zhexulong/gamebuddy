/**
 * Reading a failed lane's output, and deciding what its failure MEANS.
 *
 * Two lanes running at once is the question the isolation gate exists to answer, so when a lane fails the gate has
 * to say which capability was missing rather than "it failed". PowerShell makes that awkward to read: a thrown
 * message is displayed as a decorated block, the cause and the source line are different lines, and its formatted
 * exception goes to STDOUT while the stream most tooling captures is stderr. Capturing both is the harness's job;
 * picking the line that names a cause, and classifying it, is this module's - and being pure, it is testable
 * without launching a game.
 */

/** How much of a lane's output is kept. Enough for the message, bounded so one lane cannot flood the record. */
export const LANE_OUTPUT_LIMIT = 4000;

/**
 * The reasons two lanes cannot yet run together, as the lanes themselves report them.
 *
 * `second_instance_never_reached_bridge_readiness` is the one this project MEASURED (2026-10-17): with every file,
 * pipe, save slot and lock its own, the second concurrent instance's named pipe never became ready inside its
 * launch budget, while a single lane on the same machine reaches readiness normally.
 */
export const LANE_FAILURE_CAUSES = Object.freeze([
  "exactly_one_smapi_process",
  "second_instance_never_reached_bridge_readiness",
  "second_instance_exited_before_bridge",
  "lane_failed_without_a_named_cause",
]);

export function classifyLaneFailure(reported) {
  const text = String(reported);
  if (/exactly one SMAPI process/u.test(text)) return "exactly_one_smapi_process";
  if (/pipe was not ready/u.test(text)) return "second_instance_never_reached_bridge_readiness";
  if (/SMAPI process exited before bridge smoke/u.test(text)) return "second_instance_exited_before_bridge";
  return "lane_failed_without_a_named_cause";
}

/**
 * The most useful thing a failed lane said, in one bounded line.
 *
 * An `Exception: <path>.ps1:<line>` decoration names WHERE, never WHY, so it is passed over: the cause is the first
 * line that names something, and a source line number alone is not a diagnosis.
 */
export function laneDiagnosis(output) {
  const lines = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[~^\s]+$/u.test(line));
  const named = lines.find(
    (line) =>
      !/\.ps1:\d+$/u.test(line) &&
      /Native-local|native_local_|scenario_fixture_mismatch|bridge_enablement|Throw|Exception|Error:/u.test(line),
  );
  return (named ?? lines.find((line) => !/\.ps1:\d+$/u.test(line)) ?? "no_output").slice(0, 240);
}

/** Append one stream chunk, keeping only the tail: the message a lane fails on is at its end. */
export function appendLaneOutput(previous, chunk) {
  return (previous + String(chunk)).slice(-LANE_OUTPUT_LIMIT);
}

/**
 * What the live mode measured, in one verdict word.
 *
 * `blocked` is the honest answer while two lanes cannot both run: the capability is missing, and the reason names
 * which one. Only a lane interfering with ANOTHER lane's artifacts would be a failure of the isolation itself.
 */
export function liveLaneVerdict({ lanesRan, outcomes }) {
  if (lanesRan) return "ran";
  const causes = [...new Set(outcomes.map(classifyLaneFailure))].sort();
  return `isolated_lanes_cannot_run_concurrently:${causes.join("+")}`;
}
