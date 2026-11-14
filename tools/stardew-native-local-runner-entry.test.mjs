// red-proof: inject  `if (import.meta.main)` disabled in
//                    the body-owner-hold runner -> `✖ every gate route's script declares a CLI entry point`, actual
//                    `[ 'tools/run-stardew-native-local-player-body-owner-hold-smoke.mjs' ]` against `[]`, exit 1
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { describeGateRouteProblems, resolveStardewActionGateRoutes } from "./lib/stardew-action-gate-route.mjs";
import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";

/**
 * Every SCRIPT a gate route makes the harness run must be RUNNABLE BY THE HARNESS.
 *
 * Why this exists: a new runner passed while running NOTHING. It had no `import.meta.main` entry point, so the
 * harness imported the module and exited 0, and the batch read that as PASS. The offline suite could not see it,
 * because those tests import the exported function directly and never take the CLI path - the same "the test
 * bypasses the path that fails" shape that has produced most of the defects in this lane.
 *
 * The population is the ROUTE's executable, not its runner: a published row resolves to `tools/<runner>` or, when it
 * declares the contract route, to the one slice driver that runs `contracts/smoke/<actionId>.json`. Reading
 * `gate.runner` here is what made a runner impossible to retire - the guard would go red for a file nobody runs.
 *
 * This is the static half of the guard: the routes must name scripts that declare an entry point AND print a
 * result. The dynamic half lives in the fixture harness, which refuses an exit-0 run that produced no result
 * JSON.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The script each gate route executes, plus any action whose route does not resolve (named, never dropped). */
function routeScripts() {
  const scripts = new Set();
  const broken = [];
  const published = resolveStardewActionGateRoutes(STARDEW_PUBLISHED_ACTION_GATES.map((gate) => gate.actionId));
  for (const problem of describeGateRouteProblems(published)) broken.push(problem);
  for (const route of published) if (route.executes !== null) scripts.add(route.executes);
  for (const runner of Object.values(STARDEW_EXPERIMENTAL_ACTION_RUNNERS)) scripts.add(`tools/${runner}`);
  return { scripts: [...scripts].sort(), broken };
}

test("every gate route's script declares a CLI entry point", () => {
  const { scripts, broken } = routeScripts();
  assert.deepEqual(broken, [], `a route that does not resolve cannot be checked here:\n${broken.join("\n")}`);
  const missing = [];
  for (const script of scripts) {
    const source = readFileSync(path.join(ROOT, script), "utf8");
    if (!declaresEntryPoint(source)) missing.push(script);
  }
  assert.deepEqual(
    missing,
    [],
    "a script without an entry point exits 0 while doing nothing, which the harness reads as PASS",
  );
});

test("every gate route's script prints a result the harness can require", () => {
  const { scripts } = routeScripts();
  const silent = [];
  for (const script of scripts) {
    const source = readFileSync(path.join(ROOT, script), "utf8");
    // Deliberately NOT "prints a JSON object with a state field": two long-standing passing gates print a result
    // without that key, and tightening the harness past what they emit would break working gates to catch a
    // defect they do not have. What a script with no entry point lacks is ANY output, so that is the requirement.
    if (!reportsItself(source)) silent.push(script);
  }
  assert.deepEqual(silent, [], "the harness must be able to tell 'ran and reported' from 'exited 0'");
});

/**
 * `declaresEntryPoint`: does this script decide, at run time, that it IS the program?
 *
 * Node has two idiomatic spellings and both are real entry points: `import.meta.main`, and the main-module comparison
 * the slice driver uses (`tools/run-native-action-slice.mjs:721`). Reading only the first would have made the slice
 * driver look unrunnable and forced the contract route out of the population - a guard narrowing exactly when a new
 * route arrived. Neither spelling is a narration: both are the condition that makes the CLI branch run.
 */
function declaresEntryPoint(source) {
  // Whole-line comments are stripped first: a comment that MENTIONS an entry point is the shape a reader mistakes for
  // one, which is the defect this guard exists for. Both spellings below are then CONDITIONS - the branch that runs
  // the program - rather than a mention of one.
  const code = source.replace(/^[ \t]*\/\/.*$/gmu, "");
  if (/if\s*\(\s*import\.meta\.main\s*\)/u.test(code)) return true;
  return /if\s*\([^)\n]*resolve\(process\.argv\[1\]\)\s*===\s*fileURLToPath\(import\.meta\.url\)/u.test(code);
}

/**
 * `reportsItself`: does this script's source end in a printed result, its own or the template's?
 *
 * Declared beside its falsifier for the reason that guard needs it: the half this file gained with the migration must be
 * able to say NO, or it is a widening dressed as a fix.
 */
function reportsItself(source) {
  if (/console\.log\(/u.test(source) || /process\.stdout\.write\(/u.test(source)) return true;
  return (
    /from\s+["'][^"']*lib\/native-local-runner-scaffold\.mjs["']/u.test(source) &&
    /\brunSmokeScenarioMain\s*\(/u.test(source)
  );
}

test("the print guard still reds for a script that neither prints nor hands its lifecycle to the template", () => {
  // The shape the guard exists for, and the shape the migration introduced. Both must be refusals.
  assert.equal(reportsItself("if (import.meta.main) {}\n"), false, "an entry point that does nothing is not a report");
  assert.equal(
    reportsItself('import { defineSmokeScenario } from "./lib/native-local-runner-scaffold.mjs";\n'),
    false,
    "importing the template without handing the run to it prints nothing",
  );
  assert.equal(
    reportsItself("console.log(JSON.stringify(result));\n"),
    true,
    "a script that prints itself still passes",
  );
  assert.equal(
    reportsItself(
      'import { runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";\nrunSmokeScenarioMain(scenario);\n',
    ),
    true,
    "a script that hands the lifecycle to the template prints from there",
  );
  // The spelling the slice driver writes with: a bare `process.stdout.write` is still a report, and a comment that
  // merely mentions printing is still not one.
  assert.equal(
    reportsItself("process.stdout.write(`${JSON.stringify(value)}\\n`);\n"),
    true,
    "a script that writes its result to stdout reports",
  );
});

test("the entry guard still reds for a script that never decides it is the program", () => {
  // Both accepted spellings must be the CONDITION, not a mention of it: the falsifiers are the shapes that read like
  // an entry point and are not one.
  assert.equal(declaresEntryPoint("if (import.meta.main) { await run(); }\n"), true, "import.meta.main");
  assert.equal(
    declaresEntryPoint(
      "if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))\n  await main(process.argv.slice(2));\n",
    ),
    true,
    "the main-module comparison the slice driver uses",
  );
  assert.equal(declaresEntryPoint("export async function run() {}\n"), false, "a library module is not a program");
  assert.equal(
    declaresEntryPoint(
      "// the launcher reaches this file through resolve(process.argv[1]) === fileURLToPath(import.meta.url)\n",
    ),
    false,
    "a comment about the comparison is not the comparison",
  );
  assert.equal(
    declaresEntryPoint("const argv = process.argv[1];\nconst here = import.meta.url;\n"),
    false,
    "reading the two values without comparing them is not an entry point",
  );
});

test("the routes are not empty, so the checks above cannot pass vacuously", () => {
  const { scripts, broken } = routeScripts();
  assert.deepEqual(broken, []);
  assert.ok(scripts.length >= 40, `expected the registered script set, got ${scripts.length}`);
  // And the one this guard was written for is in there.
  assert.ok(
    scripts.includes("tools/run-stardew-native-local-player-body-owner-hold-smoke.mjs"),
    "the body-owner-hold runner this guard was written for is missing from the population",
  );
});
