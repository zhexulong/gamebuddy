/**
 * The uncovered surface, ranked, from the run's own summary.
 *
 * A percentage per group says how much ran; it does not say what is untested, and it
 * cannot: the modules with the most risk (the panels) are also the largest, so a group
 * total hides which of them no journey reached at all. This renders the three readings
 * a next lane needs to pick a target:
 *
 *   1. modules no journey reached (0 covered lines) - a whole behaviour with no test;
 *   2. the lowest-covered modules that ARE reached, biggest uncovered surface first,
 *      because a large panel at 20% hides more untested behaviour than a small one;
 *   3. per module, the line ranges that never ran, so the reader can see whether they
 *      are one damaged branch or the whole file.
 *
 * The ranked list is by uncovered LINE COUNT, not by percentage: a 30-line module at 0%
 * is noise, and a 1 100-line panel at 7% is where a lost draft would live.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const summary = JSON.parse(readFileSync(join(HERE, "..", "coverage", "summary.json"), "utf8"));

/** `[3,4,5,9,10]` -> `[3-5, 9-10]`, so a range list stays readable. */
function ranges(lines) {
  const sorted = [...lines].sort((a, b) => a - b);
  const spans = [];
  for (const line of sorted) {
    const last = spans[spans.length - 1];
    if (last !== undefined && line === last[1] + 1) last[1] = line;
    else spans.push([line, line]);
  }
  return spans.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(",");
}

const modules = summary.report.modules.map((row) => ({
  ...row,
  pct: row.lines === 0 ? null : (row.covered / row.lines) * 100,
  uncovered: row.lines - row.covered,
}));

const unreached = modules.filter((row) => row.measured === false || row.covered === 0);
const reached = modules.filter((row) => row.covered > 0);

process.stdout.write(
  `uncovered_surface modules=${modules.length} unreached=${unreached.length} reached=${reached.length}\n`,
);

process.stdout.write("\n== no journey reached these at all (0 covered lines) ==\n");
for (const row of unreached.sort((a, b) => b.lines - a.lines)) {
  process.stdout.write(`  ${row.group.padEnd(9)} ${String(row.lines).padStart(5)} lines  ${row.module}\n`);
}

process.stdout.write("\n== reached, ranked by untested lines ==\n");
for (const row of reached.sort((a, b) => b.uncovered - a.uncovered)) {
  process.stdout.write(
    `  ${row.group.padEnd(9)} ${(row.pct ?? 0).toFixed(1).padStart(5)}%  ` +
      `${String(row.uncovered).padStart(5)} untested of ${String(row.lines).padStart(5)}  ${row.module}\n`,
  );
  process.stdout.write(`      never ran: ${ranges(row.uncoveredLines)}\n`);
  process.stdout.write(`      journeys: ${row.journeys.length === 0 ? "(none)" : row.journeys.join(", ")}\n`);
}
