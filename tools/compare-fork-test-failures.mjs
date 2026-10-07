#!/usr/bin/env node
/**
 * Compare two recorded `bun test` outputs and decide whether a change introduced regressions.
 *
 * Why this exists: the vendor fork (magic-context) tracks an upstream that has deterministic
 * Windows-dependent failures of its own - CLI spawn/PATHEXT resolution, SQLITE_BUSY last-good
 * -configuration timing, tmpdir EBUSY, cache-bust path joins. A fork change is therefore judged
 * on the *difference* between its failure set and the same suite in a pristine upstream tree,
 * not on a raw pass count. Doing that comparison by eye is how a real regression hides inside a
 * familiar number, so it is a script.
 *
 * The comparison is deliberately strict about its inputs: if the number of failures it parsed
 * does not match the run's own summary, it fails loudly rather than reporting "no regressions"
 * from an empty set. A gate that passes because it understood nothing is worse than no gate.
 *
 * Usage:
 *   node tools/compare-fork-test-failures.mjs --merged <file> --control <file> [--report <file>]
 *
 * Each input is the captured stdout of `bun test --timeout 30000` in that tree.
 * Exit: 0 = no regressions, 2 = regressions or unusable input.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const usage =
  "usage: node tools/compare-fork-test-failures.mjs --merged <bun-test-output> --control <bun-test-output> [--report <file>]";

const options = { merged: undefined, control: undefined, report: undefined };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  const value = argv[index + 1];
  if (flag === "--merged") options.merged = value;
  else if (flag === "--control") options.control = value;
  else if (flag === "--report") options.report = value;
  else throw new Error(`${usage} (unexpected argument ${flag})`);
  index += 1;
}
if (options.merged === undefined || options.control === undefined) throw new Error(usage);

/** Failing test names from one captured run, plus the count its own summary claims. */
function readFailures(path) {
  const text = readFileSync(resolve(path), "utf8");
  const names = new Set();
  for (const line of text.split(/\r?\n/u)) {
    const bunStyle = line.match(/^\(fail\)\s+(.+?)(?:\s+\[\d+(?:\.\d+)?ms\])?\s*$/u);
    const bareStyle = line.match(/^\s*[✗×]\s+(.+?)\s*$/u);
    const name = bunStyle?.[1] ?? bareStyle?.[1];
    if (name !== undefined && name.length > 0) names.add(name.trim());
  }
  // The run's own arithmetic: " 48 fail" / "48 fail". Used as an independent cross-check so a
  // parse that understood nothing cannot be mistaken for a clean run.
  const summary = [...text.matchAll(/(\d+)\s+fail\b/gu)].map((match) => Number.parseInt(match[1], 10));
  const claimed = summary.length > 0 ? Math.max(...summary) : 0;
  return { path, names, claimed, bytes: text.length };
}

const merged = readFailures(options.merged);
const control = readFailures(options.control);

const problems = [];
for (const side of [merged, control]) {
  if (side.bytes === 0) problems.push(`${side.path} is empty`);
  // A parse that found fewer failures than the run reported has missed some: the comparison
  // would then be incomplete, and an incomplete comparison is exactly how a regression hides.
  // (More names than the summary is tolerated: the same failure can be listed per file.)
  if (side.claimed > 0 && side.names.size < side.claimed) {
    problems.push(`${side.path} reports ${side.claimed} failure(s) but only ${side.names.size} could be parsed from its output`);
  }
  if (side.claimed === 0 && side.names.size === 0) {
    problems.push(`${side.path} reports no failures at all; a comparison needs a run that reached the suite`);
  }
}

const mergedOnly = [...merged.names].filter((name) => !control.names.has(name)).sort();
const controlOnly = [...control.names].filter((name) => !merged.names.has(name)).sort();

const report = Object.freeze({
  schema: "fork_test_failure_comparison/v1",
  merged: { path: merged.path, parsed: merged.names.size, claimed: merged.claimed },
  control: { path: control.path, parsed: control.names.size, claimed: control.claimed },
  mergedOnly: Object.freeze(mergedOnly),
  controlOnly: Object.freeze(controlOnly),
  verdict: problems.length > 0 ? "unusable" : mergedOnly.length === 0 ? "no-regressions" : "regressions",
  problems: Object.freeze(problems),
});

if (options.report !== undefined) writeFileSync(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stderr.write(
  `[fork-failures] merged=${merged.names.size}/${merged.claimed} control=${control.names.size}/${control.claimed} ` +
    `merged-only=${mergedOnly.length} control-only=${controlOnly.length} verdict=${report.verdict}\n`,
);
for (const problem of problems) process.stderr.write(`  ! ${problem}\n`);
for (const name of mergedOnly) process.stderr.write(`  + regression: ${name}\n`);
for (const name of controlOnly) process.stderr.write(`  - fixed-or-absent upstream: ${name}\n`);

process.exit(report.verdict === "no-regressions" ? 0 : 2);
