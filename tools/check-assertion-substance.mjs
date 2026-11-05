#!/usr/bin/env node
/**
 * Substance gate: a journey whose every assertion is a count, a presence or a visibility check has
 * proved that a control exists, and nothing about what the player sees.
 *
 * WHY (measured 2026-11-04)
 *
 * `toHaveCount(1)` on a button is the shape a test takes when it is written from the component rather
 * than from the screen: the control is there, and the sentence beside it, its disabled state, its
 * geometry and the request it sends are all unasserted. Tonight's `ProblemView` gate had to assert
 * `controls: [{ name, disabled, inViewport }]` for exactly that reason - the shape of the claim is what
 * makes it worth anything - and eight journeys in this tree still assert only that something is
 * present. The rule "a control that exists is not a control the player can use" is mechanical, so it is
 * a gate: the population is every test in every mounted journey, and the finding is every test whose
 * whole assertion set is existence.
 *
 * THE CLASSIFICATION, from the matcher itself (tools/lib/journey-source.mjs reads the assertions):
 *
 *   existence   `toBeVisible`, `toBeHidden`, `toBeAttached`, `toHaveCount`, `toBeDefined`,
 *               `toBeUndefined`, `toBeEmpty` - a claim that a thing is there, or is not.
 *   substantive everything else, because it is a claim about something else: content (`toHaveText`,
 *               `toContainText`, `toEqual`), a value (`toBe(2)`, `toBeNull`, `toBeTruthy`), a state
 *               attribute (`toBeDisabled`, `toBeFocused`, `toHaveAttribute`, `toHaveClass`), geometry
 *               (`toBeGreaterThan`, `toBeCloseTo`), a request or a URL (`toMatchObject`, `toHaveURL`).
 *
 * A test with NO assertions is the same defect one step further and is named separately, because a
 * journey that asserts nothing at all is worse than one that asserts too little.
 *
 * THE BASELINE. This is red at HEAD by 7 journeys. Strengthening one means deciding what the player
 * should SEE, and only the journey's owner can make that claim truthfully: an assertion written to
 * satisfy a gate pins whatever the implementation does today, which is the illusion this gate exists to
 * remove. So the reading is published in `tools/assertion-substance-baseline.json` and the ratchet over
 * it is the gate - a new existence-only journey fails the build, and a recorded one that is substantive
 * now (or whose title changed) fails until its entry is deleted, so the baseline only tightens.
 *
 * Usage:
 *   node tools/check-assertion-substance.mjs            # the ratchet; exit 1 on a new or stale entry
 *   node tools/check-assertion-substance.mjs --gaps     # every journey that asserts only existence
 *   node tools/check-assertion-substance.mjs --json     # the whole reading, baseline included
 *   node tools/check-assertion-substance.mjs --update   # re-record the baseline, in its own commit
 *   node tools/check-assertion-substance.mjs --root <dir>   # the gate's own fixture
 *
 * red-proof: inject  a journey added to a synthetic tree whose only assertion is `toBeVisible()` on a
 *            control -> `journey_asserts_only_existence` names it, while the same journey with one
 *            `toHaveText` beside it is green (tools/check-assertion-substance.test.mjs). Also injected:
 *            a journey with no assertion at all (`journey_asserts_nothing`), a `toHaveCount(1)` title
 *            (the count shape the defect is named after), and a journey that only exists in the
 *            baseline (`baseline_entry_stale` once it asserts something).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertionsOf, journeySpecs, parseTests } from "./lib/journey-source.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "tools/assertion-substance-baseline.json";

/** The matchers that say "it is there" and nothing else. */
export const EXISTENCE_MATCHERS = Object.freeze([
  "toBeVisible",
  "toBeHidden",
  "toBeAttached",
  "toHaveCount",
  "toBeDefined",
  "toBeUndefined",
  "toBeEmpty",
]);

const EXISTENCE = new Set(EXISTENCE_MATCHERS);

/** A journey's identity in the baseline: its file and the title that names what it claims. */
const keyOf = (entry) => `${entry.file}\u0000${entry.title}`;

/**
 * The whole reading: every test in the commit's journeys, classified by what its assertions say.
 *
 * `existence_only` and `asserts_nothing` are the finding sets; `tests` is the population size, so a
 * reading that measures nothing is visible as `tests=0` rather than as a clean run.
 */
export function auditAssertionSubstance({ root = REPOSITORY_ROOT } = {}) {
  const specs = journeySpecs({ root });
  const tests = [];
  for (const spec of specs) {
    for (const entry of parseTests(spec.source)) {
      const assertions = assertionsOf(entry.body);
      const matchers = [...new Set(assertions.map((assertion) => assertion.matcher))].sort();
      const substantive = matchers.filter((matcher) => !EXISTENCE.has(matcher));
      tests.push({
        file: spec.file,
        line: entry.line,
        title: entry.title,
        assertions: assertions.length,
        matchers,
        verdict:
          assertions.length === 0 ? "asserts_nothing" : substantive.length === 0 ? "existence_only" : "substantive",
      });
    }
  }
  const unassessed =
    specs.length === 0
      ? ["unassessed: dialogue-web/tests - no mounted journey found, so nothing can be judged"]
      : [];
  return {
    tests,
    journeys: specs.length,
    findings: tests.filter((entry) => entry.verdict !== "substantive"),
    unassessed,
  };
}

/** The recorded readings: one journey identity per line in the baseline file. */
export function readBaseline(root) {
  const text = (() => {
    try {
      return readFileSync(join(root, BASELINE_PATH), "utf8");
    } catch {
      return null;
    }
  })();
  if (text === null) return { entries: [], note: null };
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.entries)) throw new Error("assertion_substance_baseline_malformed:entries");
  return { entries: parsed.entries, note: parsed.note };
}

/** What one run says: a new existence-only journey, a recorded one that is substantive now, or none. */
export function evaluate({ reading, baseline }) {
  const recorded = new Set(baseline.entries.map(keyOf));
  const present = new Set(reading.findings.map(keyOf));
  const findings = [];
  for (const entry of reading.findings) {
    if (recorded.has(keyOf(entry))) continue;
    findings.push({
      code: entry.verdict === "asserts_nothing" ? "journey_asserts_nothing" : "journey_asserts_only_existence",
      file: entry.file,
      line: entry.line,
      title: entry.title,
      detail:
        entry.verdict === "asserts_nothing"
          ? "the test makes no assertion at all"
          : `every assertion is about existence (${entry.matchers.join(", ")}); nothing is claimed about content, value, state, geometry or a request`,
    });
  }
  for (const entry of baseline.entries) {
    if (present.has(keyOf(entry))) continue;
    findings.push({
      code: "baseline_entry_stale",
      file: entry.file,
      line: null,
      title: entry.title,
      detail: "this journey asserts something now (or its title changed); delete its entry so the baseline only tightens",
    });
  }
  return { findings, held: reading.findings.filter((entry) => recorded.has(keyOf(entry))).length };
}

function report({ reading, held, findings, gaps }) {
  const count = (verdict) => reading.tests.filter((entry) => entry.verdict === verdict).length;
  process.stdout.write(
    `assertion_substance journeys=${reading.journeys} tests=${reading.tests.length} ` +
      `substantive=${count("substantive")} existence_only=${count("existence_only")} ` +
      `asserts_nothing=${count("asserts_nothing")} held=${held}\n`,
  );
  for (const line of reading.unassessed) process.stdout.write(`  ${line}\n`);
  const shown = gaps ? reading.findings : reading.findings.filter((entry) => entry.verdict === "asserts_nothing");
  for (const entry of shown)
    process.stdout.write(`  gap:${entry.file}:${entry.line} [${entry.matchers.join(",") || "none"}] ${entry.title}\n`);
  process.stdout.write(
    `  ${reading.findings.length} journey(s) assert only existence or nothing; ${held} of them are recorded in ${BASELINE_PATH}\n`,
  );
  for (const finding of findings)
    process.stderr.write(
      `assertion_substance_${finding.code}:${finding.file}${finding.line === null ? "" : `:${finding.line}`}: ${finding.title} - ${finding.detail}\n`,
    );
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const reading = auditAssertionSubstance({ root });
  if (argv.includes("--update")) {
    const entries = reading.findings
      .map((entry) => ({ file: entry.file, title: entry.title }))
      .sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
    writeFileSync(
      join(root, BASELINE_PATH),
      `${JSON.stringify(
        {
          schema: "gamebuddy-assertion-substance-baseline/v1",
          note: "Journeys whose every assertion is a count, presence or visibility check, measured at this commit. A record of debt, not an acceptance of it: delete an entry by asserting what the player sees, never by recording more.",
          entries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.stdout.write(`assertion_substance_baseline_recorded journeys=${entries.length} into ${BASELINE_PATH}\n`);
    return 0;
  }
  const { findings, held } = evaluate({ reading, baseline: readBaseline(root) });
  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ ...reading, held, findings, baseline: readBaseline(root).entries.length }, null, 2)}\n`,
    );
    return findings.length === 0 ? 0 : 1;
  }
  report({ reading, held, findings, gaps: argv.includes("--gaps") });
  if (findings.length > 0)
    process.stderr.write(
      "  fix: assert what the player reads, what the control's state is, where it sits, or what the\n" +
        "       request carried. A control that exists is not a control that works.\n",
    );
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
