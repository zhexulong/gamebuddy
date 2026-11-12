/**
 * The one spelling of "a failed assertion fails the run".
 *
 * The two reconciling drivers printed `RECONCILIATION: N assertion(s), M failed` and neither acted on M,
 * so a driver could print `6 failed` and still exit 0. `phases/capture.mjs` reads only the child's exit
 * code, recorded a pass for it, and the run stayed green over the very assertions it had just printed as
 * failed - the instrument everything else in the run is judged by, agreeing with itself.
 *
 * The count was the right reading; only its consequence was missing. The consequence lives here, once,
 * because a second hand-written copy of it is a driver that forgets to fail.
 *
 * `unobserved` is passed only by a driver whose tally has that third outcome; a driver without it passes
 * nothing, because "this driver does not count that" and "it counted zero" must not print one sentence.
 */
export function reconciliationVerdict({ assertions, failures, unobserved }) {
  if (failures > 0) process.exitCode = 1;
  const unobservedClause = unobserved === undefined ? "" : `, ${unobserved} unobserved`;
  return `RECONCILIATION: ${assertions} assertion(s), ${failures} failed${unobservedClause}`;
}
