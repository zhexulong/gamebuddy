/**
 * Game-surface historian rubric: the narrative a game run's Historian wrote must be narrative.
 *
 * Reflection's only input is the compartments the Historian wrote, so "what the game wrote is a story, not a
 * technical changelog" is a PRECONDITION of any memory-metric claim rather than a later polish. The mechanical
 * obligations already exist (`tools/lib/historian-rubric.mjs`, five of them) and until now ran only on the memory
 * loop: the game ladder and the co-op loop had no historian wiring at all, so a game run could not say anything
 * about what it wrote.
 *
 * Two modes:
 *
 *   default          the rubric's own falsifiers, offline: each obligation must be able to fail on its own.
 *   --run-dir DIR    a REAL run's captured runtime root is read and judged. `--all` judges every run under the
 *                    directory, which is what a retro-audit of a day's runs needs.
 *
 * Usage:
 *   node tools/check-game-historian-rubric.mjs
 *   node tools/check-game-historian-rubric.mjs --run-dir .live-runs/game-ladder/<run>
 *   node tools/check-game-historian-rubric.mjs --run-dir .live-runs/game-ladder --all
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { checkHistorianRubric, identifyHistorianPrompt, readCompartments } from "./lib/historian-rubric.mjs";

const checks = [];
const check = (id, ok, detail) =>
  checks.push({ id, status: ok ? "passed" : "failed", ...(detail === undefined ? {} : { detail }) });

const compartment = (overrides = {}) => ({
  sequence: overrides.sequence ?? 1,
  title: overrides.title ?? "A morning on the farm",
  tiers: overrides.tiers ?? ["The companion woke early and worked the east field.", "", "", ""],
});

const codes = (result) => result.violations.map((entry) => entry.obligation);

function fixtureChecks() {
  // A story the rubric accepts: narrative text, a title, and a first tier.
  const healthy = checkHistorianRubric([compartment()]);
  check(
    "a_narrative_compartment_passes",
    healthy.passed && healthy.violations.length === 0,
    codes(healthy).join(",") || undefined,
  );
  check(
    "every_obligation_is_named_in_the_result",
    healthy.checkedObligations.length === 5,
    healthy.checkedObligations.join(","),
  );

  // Each obligation is independently load-bearing: an obligation that cannot fail is not being enforced.
  const obligations = [
    // The samples are written against the rubric's OWN regular expressions: a falsifier whose text does not
    // actually match the pattern proves nothing (the first draft of these two did exactly that).
    ["no-role-labels", compartment({ title: "The player asked for help with the field" })],
    ["no-transcript-references", compartment({ tiers: ["See message 12 for what was agreed.", "", "", ""] })],
    ["no-internal-markers", compartment({ tiers: ["The tool_call returned success.", "", "", ""] })],
    ["title-present", compartment({ title: "   " })],
    ["p1-present", compartment({ tiers: ["", "", "", ""] })],
  ];
  for (const [obligation, broken] of obligations) {
    const produced = codes(checkHistorianRubric([broken]));
    check(
      `obligation_${obligation}_can_fail`,
      produced.includes(obligation),
      produced.join(",") || "no violation reported",
    );
  }

  // The report says WHICH compartment broke which obligation, not only that something did.
  const located = checkHistorianRubric([compartment(), compartment({ sequence: 7, title: "tool result" })]);
  check(
    "violations_are_located",
    located.violations.some((entry) => entry.where === "sequence 7"),
    JSON.stringify(located.violations),
  );

  // An empty corpus is not a pass: a run that wrote nothing has no narrative to judge, and calling that green is
  // exactly the "gate passes while the behaviour is absent" shape. Asserted on the VERDICT, not on the count: a
  // count of zero is true of every implementation, including one that returns `passed: true` for an empty input,
  // so an assertion about it could never fail and would prove nothing. The empty result here must have inspected
  // nothing AND not be a pass - the two facts together are what the name claims.
  const nothingToJudge = checkHistorianRubric([]);
  check(
    "no_compartments_is_not_a_pass",
    nothingToJudge.compartmentsChecked === 0 &&
      nothingToJudge.violations.length === 0 &&
      nothingToJudge.passed === false,
    `passed=${String(nothingToJudge.passed)} compartmentsChecked=${String(nothingToJudge.compartmentsChecked)}`,
  );
}

/** Every run directory under `root` that carries a captured runtime root. */
function runDirsWithRuntimeRoot(root) {
  const candidates = [];
  const visit = (directory, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name === "runtime-root") {
        candidates.push(path);
        continue;
      }
      visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return candidates;
}

function judgeRuntimeRoot(runtimeRoot, label) {
  const compartments = readCompartments(runtimeRoot);
  if (compartments.length === 0) {
    check(`${label}_wrote_compartments`, false, "no compartments in this run's captured runtime root");
    return;
  }
  const result = checkHistorianRubric(compartments);
  check(
    `${label}_compartments`,
    result.passed,
    result.violations.map((entry) => `historian_rubric_violation:${entry.obligation}@${entry.where}`).join(",") ||
      undefined,
  );
  // The prompt variant travels with the verdict: a rubric pass on a bundle nobody can identify is a weaker fact.
  const generationRoot = join(runtimeRoot, "..", "..");
  const promptVariant = existsSync(generationRoot) ? identifyHistorianPrompt(generationRoot) : null;
  checks.push({
    id: `${label}_historian_prompt`,
    status: promptVariant === null ? "unmeasured" : "passed",
    detail: String(promptVariant ?? "not_identified"),
  });
}

function parseOption(name) {
  const index = process.argv.indexOf(name);
  return index < 0 || index + 1 >= process.argv.length ? null : process.argv[index + 1];
}

const runDir = parseOption("--run-dir");
const all = process.argv.includes("--all");
let judged = 0;
if (runDir === null) {
  fixtureChecks();
} else if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
  check("run_dir_exists", false, runDir);
} else if (all) {
  const roots = runDirsWithRuntimeRoot(runDir);
  check("runs_found", roots.length > 0, `${String(roots.length)} runtime roots under ${runDir}`);
  for (const root of roots) {
    judgeRuntimeRoot(root, root.slice(runDir.length + 1).replace(/[\\/]/gu, "-") || "run");
    judged += 1;
  }
} else {
  const direct = join(runDir, "runtime-root");
  const root = existsSync(direct) ? direct : runDir;
  check("run_has_a_captured_runtime_root", existsSync(root), root);
  judgeRuntimeRoot(root, "run");
  judged = 1;
}

const failed = checks.filter((entry) => entry.status === "failed");
const unmeasured = checks.filter((entry) => entry.status === "unmeasured");
process.stdout.write(
  `${JSON.stringify({
    gate: "game_historian_rubric/v1",
    mode: runDir === null ? "obligations" : "run-dir",
    runDir,
    judgeVerb: all ? "all" : "one",
    runsJudged: judged,
    // A pass means the narrative obligations held; `unmeasured` names anything the gate could not decide, so it
    // never reads as a silent success.
    status: failed.length === 0 ? "passed" : "failed",
    checks,
    ...(unmeasured.length > 0 ? { unmeasured: unmeasured.map((entry) => entry.id) } : {}),
  })}\n`,
);
if (failed.length > 0) process.exitCode = 1;
