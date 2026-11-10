#!/usr/bin/env node
/**
 * CI gate for the UNREPORTED FAILURE class (see lib/unreported-catch.mjs).
 *
 * Default output is one line per unreported catch in `unreported_catch:<path>:<line>:<symbol>` form,
 * each followed by what it does instead of telling the player, plus a one-line total; exit 1 when
 * any exist. `--json` prints the whole reading. A clean tree prints
 * `unreported_catch: none (<n> catch sites, <k> declared silent)` and exits 0.
 *
 * A declaration that no longer describes the code it waives is reported on the same verdict, so
 * the gate cannot go quiet about a rule that quietly stopped applying.
 *
 * red-proof: inject  a handler whose catch only re-reads -> `unreported_catch:<path>:<line>:<symbol>` with
 *                    `only calls rereadChat` beside it (tools/check-unreported-catch.test.mjs, "a catch that
 *                    only re-reads is a finding"), and the shape that shipped, where the report runs only
 *                    when the re-read also fails
 * red-proof: history the tree at ffcbb876^, where six message handlers and the Stop control ended in a
 *                    re-read and nothing else -> the gate names all seven
 *                    (tools/check-unreported-catch.test.mjs, "the pre-fix handlers are reported")
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkUnreportedCatches, formatFinding } from "./lib/unreported-catch.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const rootIndex = process.argv.indexOf("--root");
const repoRoot =
  rootIndex >= 0 && typeof process.argv[rootIndex + 1] === "string"
    ? resolve(process.argv[rootIndex + 1])
    : resolve(toolsDir, "..");

const readout = checkUnreportedCatches({ repoRoot });
const failed = readout.unreported.length > 0 || readout.problems.length > 0;

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        gate: "unreported_catch/v1",
        status: failed ? "failed" : "passed",
        root: repoRoot,
        counts: readout.counts,
        population: readout.counts.sites,
        unreported: readout.unreported,
        problems: readout.problems,
      },
      null,
      2,
    )}\n`,
  );
} else if (failed) {
  for (const finding of readout.unreported) {
    process.stdout.write(`${formatFinding(finding)}\n`);
    process.stdout.write(`  the catch ${finding.does} instead of telling the player\n`);
  }
  for (const problem of readout.problems)
    process.stdout.write(
      `${problem.code}:${problem.path}${problem.detail === undefined ? "" : ` (${problem.detail})`}\n`,
    );
  process.stdout.write(
    `unreported_catch: ${readout.unreported.length} undeclared of ${readout.counts.silent} silent catch site(s)\n`,
  );
} else {
  process.stdout.write(
    `unreported_catch: none (${readout.counts.sites} catch sites, ${readout.counts.silent} silent, ` +
      `${readout.counts.declared} declared)\n`,
  );
}

process.exitCode = failed ? 1 : 0;
