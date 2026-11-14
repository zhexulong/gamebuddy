#!/usr/bin/env node
/**
 * Waiver gate: a spec comment that explains the test's shape with a capability the product denies is
 * a waiver, and a waiver must say what would retire it.
 *
 * WHY (measured 2026-11-14)
 *
 * Four spec assertions that night had encoded a known defect as their expectation, each with a comment
 * explaining the workaround, and all four were green. `model-profile-freshness.spec.ts` and
 * `sending-and-composer.spec.ts` closed a drawer with its Close button because "the Save that just ran
 * disabled itself and dropped focus to `<body>`"; `drawer-focus-trap.spec.ts` put focus back by
 * clicking the drawer's heading "because the upload's own busy state drops it to `<body>` ... it is
 * reported rather than changed here"; `composed-profile-bootstrap.spec.ts` expected the shut
 * disclosure's dump to be absent (`pre === null`) under "Closed, the dump's own DOM is not mounted at
 * all". Nothing in the tree read any of it: the prose that names a capability as missing is the one
 * place where a spec cannot be wrong out loud.
 *
 * The classification is `tools/lib/spec-waiver-comments.mjs`: the population is every non-JSDoc
 * comment inside a journey, and a waiver is one carrying both a deviation ("rather than Escape",
 * "instead of", "by pointing at") and a denial ("<body>", "drops focus", "not mounted", "no ... to
 * reach"). Consecutive `//` lines are read as one comment, because the cases' two halves sit on
 * different lines of the same paragraph.
 *
 * THE RULE. A waiver is resolved by being declared, and the declaration's expiry is read out of the
 * product's own source rather than out of a second hand-written claim:
 *
 *     // spec-waiver: closes with its Close button rather than Escape, because a Save that
 *     // disabled itself parks focus on `<body>`, so Escape has nothing to reach.
 *     // expires when: dialogue-web/src/components/ContextDrawer.tsx no longer contains `disabled={busy}`
 *
 * So the exemption expires by itself: whoever removes the code that causes the limitation turns this
 * gate red, and the journey then asserts the property the limitation denied. Findings are
 * `waiver_undocumented` (no declaration), `waiver_without_expiry` (no clause), `waiver_expired` (the
 * literal is gone - the workaround is unnecessary now) and `waiver_expiry_unmeasurable` (the named
 * file is gone, so a rename would otherwise read as a fix).
 *
 * THE GATE THAT CANNOT SEE ITS OWN SUBJECT. A tree with no waiver in it is a tree with nothing to
 * report, and that is indistinguishable from a vocabulary that no longer recognises a waiver. The four
 * real comments from that night are replayed verbatim in `tools/check-spec-waiver-comments.test.mjs`,
 * so a detector that stops seeing them fails there rather than passing here - and this run prints
 * `examined N`, and is blocked when a spec tree has no step comment at all.
 *
 * Usage:
 *   node tools/check-spec-waiver-comments.mjs              # the gate; exit 1 on any finding
 *   node tools/check-spec-waiver-comments.mjs --list       # every waiver and the expiry holding it
 *   node tools/check-spec-waiver-comments.mjs --json
 *   node tools/check-spec-waiver-comments.mjs --root <dir> # the gate's own fixture
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditSpecWaivers } from "./lib/spec-waiver-comments.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function report({ reading, findings, list }) {
  process.stdout.write(
    `spec_waiver files=${reading.files} examined=${reading.examined} waiver=${reading.waivers.length} ` +
      `held=${reading.waivers.length} findings=${findings.length}\n`,
  );
  for (const line of reading.unassessed) process.stdout.write(`  ${line}\n`);
  if (list)
    for (const waiver of reading.waivers)
      process.stdout.write(`  held:${waiver.file}:${waiver.line} expires with ${waiver.path} \`${waiver.literal}\`\n`);
  for (const finding of findings)
    process.stderr.write(
      `spec_waiver_${finding.code}:${finding.file}:${finding.line}: ${finding.claim}\n  ${finding.detail}\n`,
    );
  if (findings.length > 0)
    process.stderr.write(
      "  fix: make the journey do what a player does, or declare the waiver with the product code that\n" +
        "       causes it and the literal whose removal retires it.\n",
    );
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const reading = auditSpecWaivers({ root });
  const findings = [...reading.findings];
  const blocked = reading.unassessed.length > 0 || (reading.examined === 0 && reading.files > 0);
  if (reading.examined === 0 && reading.files > 0)
    findings.push({
      code: "blocked",
      file: "dialogue-web/tests",
      line: 0,
      claim: "no step comment recognised in the commit's journeys",
      detail:
        `${reading.files} spec file(s) examined and not one non-JSDoc comment inside a journey: either the ` +
        "journeys hold no prose about their steps, or the reader no longer recognises one - say which",
    });
  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          gate: "spec-waiver-comments",
          examined: reading.examined,
          files: reading.files,
          waivers: reading.waivers,
          unassessed: reading.unassessed,
          findings,
        },
        null,
        2,
      )}\n`,
    );
    return blocked || findings.length > 0 ? 1 : 0;
  }
  report({ reading, findings, list: argv.includes("--list") });
  return blocked || findings.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
