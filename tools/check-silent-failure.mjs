#!/usr/bin/env node
/**
 * CI gate for the SILENT FAILURE class (see lib/silent-failure.mjs).
 *
 * Default output is the first undeclared finding in
 * `silent_failure:<kind>:<path>:<symbol>` form and exit 1; `--json` prints every
 * finding and every declaration problem as a JSON object (still exit 1 when any
 * exist). A clean repo prints `silent_failure: none` and exits 0.
 *
 * A declaration that no longer describes the code it waives is reported on the
 * same verdict: the gate must not be quiet about a rule that quietly stopped
 * applying.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSilentFailures, formatFinding } from "./lib/silent-failure.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { findings, undeclared, problems } = checkSilentFailures(repoRoot);
const failed = undeclared.length > 0 || problems.length > 0;

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ findings, undeclared, problems }, null, 2)}\n`);
} else if (!failed) {
  console.log(`silent_failure: none (${findings.length} declared silent sites)`);
} else if (problems.length > 0) {
  for (const problem of problems) {
    console.log(
      `${problem.code}:${problem.path}:${problem.symbol}${problem.detail === undefined ? "" : ` (${problem.detail})`}`,
    );
  }
  if (undeclared.length > 0) console.log(formatFinding(undeclared[0]));
} else {
  console.log(formatFinding(undeclared[0]));
  console.log(`silent_failure: ${undeclared.length} undeclared of ${findings.length} silent sites`);
}

process.exitCode = failed ? 1 : 0;
