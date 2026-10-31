#!/usr/bin/env node
/**
 * The run's coverage verdict, executed once after every worker has exited.
 *
 * This is a teardown rather than a reporter so the numbers are produced whether the
 * journeys passed or failed: a red run still leaves a report, and a floor breach is
 * still named even when a journey already failed for its own reason.
 *
 * A breached floor FAILS the run by throwing, which is the only signal Playwright
 * promises to turn into a non-zero exit; setting `process.exitCode` here would be a
 * hint the runner is free to overwrite. The throw carries the group, the measured
 * number and the floor, so the failure report says which group and by how much.
 */
import { evaluate, reportOutcome } from "./frontend-coverage-report.mjs";

export default async function applyCoverageFloors() {
  const outcome = await evaluate();
  if (reportOutcome(outcome) !== 0) {
    throw new Error(
      "frontend_coverage: this run's reading is in the log above; the group floors did not hold or the\n" +
        "  run did not measure the whole journey corpus.",
    );
  }
}
