#!/usr/bin/env node
// red-proof: inject  planting check-red-proof-probe.mjs: a gate file in neither registry -> exit 1,
//   `gate_falsifiers: BLOCKED`, `gate_without_falsifier: check-red-proof-probe.mjs`, and
//   `gate_undeclared: ... no `red-proof:` marker in ...`, then `harness conformance blocked`
import { dirname, resolve } from "node:path";
/**
 * Harness conformance CLI: the static wiring facts that ended live runs, checked in seconds.
 *
 *   node tools/check-harness-conformance.mjs           # one line per check; exit 1 on the first failure
 *   node tools/check-harness-conformance.mjs --json    # machine output
 *
 * Three verdicts, not two. `blocked` is a check whose population is not fully declared: the gates it could not judge, or
 * the gates whose reports cannot show what they measured. It exits 1 like a failure, because a run that hides an
 * undeclared gate is not green - it is a run that has to say so out loud and name the members.
 *
 * No game, no live run, no network. See `tools/lib/harness-conformance.mjs` for the checks.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runHarnessConformance } from "./lib/harness-conformance.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolsDir, "..");

const results = runHarnessConformance({ toolsDir, repoRoot });
const statusOf = (entry) => (entry.blocked === true ? "blocked" : entry.findings.length > 0 ? "failed" : "passed");
const worst = results.some((entry) => statusOf(entry) === "failed")
  ? "failed"
  : results.some((entry) => statusOf(entry) === "blocked")
    ? "blocked"
    : "passed";
const failed = results.filter((entry) => entry.findings.length > 0);

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        gate: "harness_conformance/v1",
        status: worst,
        ...(failed.length === 0 ? {} : { firstFailure: failed[0].findings[0].code }),
        checks: results.map((entry) => ({
          id: entry.id,
          status: statusOf(entry),
          ...(entry.notes === undefined ? {} : { notes: entry.notes }),
          findings: entry.findings,
        })),
      },
      null,
      2,
    )}\n`,
  );
} else {
  for (const entry of results) {
    if (entry.notes !== undefined) {
      for (const line of entry.notes) process.stdout.write(`${entry.id} population: ${line}\n`);
    }
    if (entry.findings.length === 0) {
      process.stdout.write(`${entry.id}: ${statusOf(entry)}\n`);
      continue;
    }
    process.stdout.write(`${entry.id}: ${statusOf(entry).toUpperCase()}\n`);
    for (const item of entry.findings) process.stdout.write(`  ${item.code}: ${item.detail}\n`);
  }
}

if (failed.length > 0) {
  if (!process.argv.includes("--json"))
    process.stdout.write(`harness conformance ${worst}: ${failed[0].findings[0].code}\n`);
  process.exitCode = 1;
}
