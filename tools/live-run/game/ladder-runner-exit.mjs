/**
 * The orchestrator's exit status, which is the runner's own.
 *
 * `tools/_ladder-live-orchestrator.mjs` reads the runner's exit code, prints it, and used to drop it: the process then
 * ended 0 whatever the runner had said, so a run that died still read as a pass to whoever invoked the ladder. The
 * second half is the same defect from the other side — a runner that exits 0 having printed no verdict has answered
 * nothing, and 0 is exactly the answer that hides it.
 *
 * The decision lives here because the orchestrator launches a real game and cannot be run by a test; this can, with a
 * real child process on the other end of it.
 */

/** A child killed by a signal reports no code at all, and silence is not success. */
export const RUNNER_EXIT_UNREPORTED = 1;

/** The reading for a run that printed no verdict line: named, so it cannot be mistaken for a generic failure. */
export const RUNNER_NO_VERDICT = "RUNNER_NO_VERDICT";

/** The last line the runner printed that is a JSON object: the verdict the launcher reads. */
export function readRunnerVerdict(stdout) {
  return String(stdout)
    .trim()
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .at(-1);
}

/**
 * `exitCode` is what the child's `close` event reported: a number, or `null` when it was killed. A non-zero code is
 * passed through unchanged; 0 with no verdict is refused rather than passed on.
 */
export function judgeRunnerExit({ exitCode, stdout }) {
  const verdictLine = readRunnerVerdict(stdout);
  if (typeof exitCode !== "number")
    return { exitCode: RUNNER_EXIT_UNREPORTED, verdictLine, reading: RUNNER_NO_VERDICT };
  if (exitCode !== 0) return { exitCode, verdictLine, reading: null };
  if (verdictLine === undefined) return { exitCode: RUNNER_EXIT_UNREPORTED, verdictLine, reading: RUNNER_NO_VERDICT };
  return { exitCode: 0, verdictLine, reading: null };
}
