#!/usr/bin/env node
// red-proof: inject  planting check-red-proof-probe.mjs: a gate file in neither registry -> exit 1,
//   `gate_falsifiers: BLOCKED`, `gate_without_falsifier: check-red-proof-probe.mjs`, and
//   `gate_undeclared: ... no `red-proof:` marker in ...`, then `harness conformance blocked`
// red-proof: inject  staging a gate for one run that reads `dialogue-web/src/*.ts` through `readFileSync` and declares
//   nothing (`check-source-reading-probe.mjs`) -> `source_reading_declarations: FAILED` naming that gate with
//   `source_reading_invariant_missing:`, `source_reading_expiry_missing:` and `source_reading_undeclared:`, exit 1
//   (measured 2026-11-22 on this checkout)

export const gateDeclaration = {
  id: "check-harness-conformance",
  domain: "meta",
  tier: "l2",
  kind: "totality",
};

// source-invariant: no compiler can require a source-reading gate to name the invariant it checks; this file reads
//   the two declaration lines instead of a type.
// source-expiry: when the gate declaration in `gates/registry.mjs` can carry a typed, compiler-checked invariant,
//   retire these markers and read that field

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
/**
 * Harness conformance CLI: the static wiring facts that ended live runs, checked in seconds.
 *
 *   node gates/meta/check-harness-conformance.mjs                         # one line per check; exit 1 on a finding
 *   node gates/meta/check-harness-conformance.mjs --json                  # machine output
 *   node gates/meta/check-harness-conformance.mjs --update-source-reading # rewrite the source-reading debt
 *
 * Three verdicts, not two. `blocked` is a check whose population is not fully declared: the gates it could not judge, or
 * the gates whose reports cannot show what they measured. It exits 1 like a failure, because a run that hides an
 * undeclared gate is not green - it is a run that has to say so out loud and name the members.
 *
 * SIXTH CHECK, decided here rather than in the library because the reading is this file's own: every gate that reads
 * this repository's own source must declare, in its own file, the invariant no compiler can express and when that
 *  reading expires. The population is derived (`readsOwnSource` in `tools/lib/source-reading-declarations.mjs` reads
 * each gate's entry text for the file system's read calls and the AST seam), printed on its own line, and blocked when it
 * is empty:
 *
 *   gates that read our own source N · declared M · recorded as debt K · no declaration and no row D
 *
 * The gates that owe the declaration and have not written it yet are recorded in `tools/source-reading-baseline.json`, a
 * record of debt that `--update-source-reading` writes from a real reading - and the ratchet turns both ways, so a row
 * whose gate now declares fails until the row is deleted.
 *
 * No game, no live run, no network. See `tools/lib/harness-conformance.mjs` for the first five checks.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gateFileNames } from "../../tools/lib/gate-population.mjs";
import { runHarnessConformance } from "../../tools/lib/harness-conformance.mjs";
import { indexedGatePopulation } from "../../tools/lib/indexed-sources.mjs";
import {
  describeSourceReadingCensus,
  judgeSourceReadingDeclarations,
  readSourceReadingBaseline,
  SOURCE_READING_BASELINE_PATH,
  sourceReadingBaselineDocument,
} from "../../tools/lib/source-reading-declarations.mjs";

// `root` is the repository root: a gate may live in `tools/` or in a domain directory under `gates/`, so the anchor of
// the population is the tree, not one of the directories a gate happens to live in.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const toolsDir = resolve(root, "tools");

/**
 * The gate files the declaration reading is over, from the ONE population derivation - and the members the index carries
 * whose file is not on disk, named rather than crashed on: a lane mid-rename is not a reason for the suite to throw.
 */
function readGateMembers() {
  const members = [];
  const unreadable = [];
  for (const path of gateFileNames(indexedGatePopulation({ root }))) {
    try {
      members.push({ path, source: readFileSync(join(root, path), "utf8") });
    } catch {
      unreadable.push(path);
    }
  }
  return { members, unreadable };
}

const sourceMembers = readGateMembers();
const declarationReading = judgeSourceReadingDeclarations({
  members: sourceMembers.members,
  baseline: readSourceReadingBaseline({ root }),
});

if (process.argv.includes("--update-source-reading")) {
  writeFileSync(
    join(root, SOURCE_READING_BASELINE_PATH),
    `${JSON.stringify(sourceReadingBaselineDocument(declarationReading.owed), null, 2)}\n`,
  );
  process.stdout.write(
    `source_reading_baseline_written: ${declarationReading.owed.length} row(s) over ` +
      `${declarationReading.census.reading} gate(s) that read our own source\n`,
  );
  process.exit(0);
}

const results = runHarnessConformance({ toolsDir, repoRoot: root });
results.push({
  id: "source_reading_declarations",
  notes: describeSourceReadingCensus(declarationReading.census),
  blocked: declarationReading.census.reading === 0,
  findings: [
    ...declarationReading.findings,
    ...sourceMembers.unreadable.map((path) => ({
      code: `source_reading_member_unreadable:${path}`,
      detail: "the index carries this gate file and the worktree does not, so its declaration was not read",
    })),
  ],
});
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
        examined: declarationReading.census.examined,
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
