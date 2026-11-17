/**
 * What one iteration of the live run may exit with.
 *
 * <p>
 * WHY (measured 2026-11-17): `round65`, `round66` and `round67` each left a run directory holding `launch.json` and
 * nothing else. The launcher had exited; no bundle was written; the iterate script printed "no result ... the launcher
 * did not finish" and then exited 0 - so the loop that watched three consecutive rounds went green on the failure that
 * happened all three times. An exit status is a claim, and 0 claims the round produced an answer.
 * </p>
 * <p>
 * The decision lives here rather than at the call site for the same reason `result-freshness.mjs` does: a test can put a
 * real empty run directory on the other end of it, and the script that launches a game cannot.
 * </p>
 */

/**
 * The exit status of a round that delivered nothing. Distinct from 1 (a command failed) and from 2 (a bundle exists but
 * is not this attempt's), so a reader can tell "the harness could not produce a result" from the two failures it already
 * named. 3 is otherwise unused in this script.
 */
export const NO_RESULT_EXIT_CODE = 3;

/**
 * `launched` is whether this invocation actually started the launcher at all (`--dry-run` does not), `launcherExitCode`
 * is the child's own status as the runtime reported it (`null` when a signal ended it), and `resultExists` is the only
 * question the caller cannot answer from the other two.
 */
export function judgeRunOutcome({ launched, launcherExitCode, resultExists, resultPath }) {
  if (typeof resultPath !== "string" || resultPath.length === 0)
    throw new Error("judgeRunOutcome needs the result path");
  if (resultExists === true) return { exitCode: 0, cause: "result_present", reading: null };
  const where = resultPath.split("\\").join("/");
  if (launched !== true)
    return {
      exitCode: NO_RESULT_EXIT_CODE,
      cause: "nothing_launched",
      reading: `no result at ${where} - nothing was launched (a dry run), so this round has nothing to read`,
    };
  // What the launcher said is the OTHER half of the same sentence: "it exited 0 and wrote no bundle" and "it was killed"
  // are different failures, and only the exit status tells them apart.
  const ending =
    launcherExitCode === null || launcherExitCode === undefined ? "was killed" : `exited ${String(launcherExitCode)}`;
  return {
    exitCode: NO_RESULT_EXIT_CODE,
    cause: "launcher_exited_without_a_result",
    reading: `no result at ${where} - the launcher ${ending} and wrote no bundle, so this round produced nothing`,
  };
}
