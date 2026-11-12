#!/usr/bin/env node
/**
 * CI gate for the SILENT FAILURE class (see lib/silent-failure.mjs).
 *
 * Default output is the first undeclared finding in
 * `silent_failure:<kind>:<path>:<symbol>` form and exit 1; `--json` prints every
 * finding and every declaration problem as a JSON object (still exit 1 when any
 * exist). A clean repo prints `silent_failure: none (sites examined N …)` and exits 0,
 * and a scan that matched no silent site at all exits 1 rather than reading as clean.
 *
 * A declaration that no longer describes the code it waives is reported on the
 * same verdict: the gate must not be quiet about a rule that quietly stopped
 * applying.
 *
 * red-proof: inject  an empty `catch {}` with no declaration -> `silent_failure:<kind>:<path>:<symbol>`
 *                    (tools/lib/silent-failure.test.mjs, "an empty catch with no declaration is a finding")
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSilentFailures, formatFinding } from "./lib/silent-failure.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { findings, undeclared, problems } = checkSilentFailures(repoRoot);
// The population is the silent sites the scan FOUND: a declaration can only be compared against one of them. Zero is
// a finding rather than a pass, because a tree this size always carries silent sites and a scan that reports none is
// the scan that stopped matching.
const populationEmpty = findings.length === 0;
const failed = undeclared.length > 0 || problems.length > 0 || populationEmpty;

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ examined: findings.length, findings, undeclared, problems }, null, 2)}\n`);
} else if (populationEmpty) {
  console.log(
    "silent_failure:silent_site_population_empty: sites examined 0 - the scan matched no empty catch, swallowed " +
      "rejection or ignored error anywhere under the repository, so the declaration table was compared against nothing",
  );
} else if (!failed) {
  console.log(`silent_failure: none (sites examined ${findings.length} · every one declared)`);
} else if (problems.length > 0) {
  for (const problem of problems) {
    console.log(
      `${problem.code}:${problem.path}:${problem.symbol}${problem.detail === undefined ? "" : ` (${problem.detail})`}`,
    );
  }
  if (undeclared.length > 0) console.log(formatFinding(undeclared[0]));
} else {
  console.log(formatFinding(undeclared[0]));
  console.log(`silent_failure: ${undeclared.length} undeclared · sites examined ${findings.length}`);
}

process.exitCode = failed ? 1 : 0;
