#!/usr/bin/env node
/**
 * Harness conformance CLI: the static wiring facts that ended live runs, checked in seconds.
 *
 *   node tools/check-harness-conformance.mjs           # one line per check; exit 1 on the first failure
 *   node tools/check-harness-conformance.mjs --json    # machine output
 *
 * No game, no live run, no network. See `tools/lib/harness-conformance.mjs` for the checks.
 */
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runHarnessConformance } from "./lib/harness-conformance.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolsDir, "..");

const results = runHarnessConformance({ toolsDir, repoRoot });
const failed = results.filter((entry) => entry.findings.length > 0);

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        gate: "harness_conformance/v1",
        status: failed.length === 0 ? "passed" : "failed",
        ...(failed.length === 0 ? {} : { firstFailure: failed[0].findings[0].code }),
        checks: results.map((entry) => ({
          id: entry.id,
          status: entry.findings.length === 0 ? "passed" : "failed",
          findings: entry.findings,
        })),
      },
      null,
      2,
    )}\n`,
  );
} else {
  for (const entry of results) {
    if (entry.findings.length === 0) {
      process.stdout.write(`${entry.id}: passed\n`);
      continue;
    }
    process.stdout.write(`${entry.id}: FAILED\n`);
    for (const item of entry.findings) process.stdout.write(`  ${item.code}: ${item.detail}\n`);
  }
}

if (failed.length > 0) {
  if (!process.argv.includes("--json"))
    process.stdout.write(`harness conformance failed: ${failed[0].findings[0].code}\n`);
  process.exitCode = 1;
}
