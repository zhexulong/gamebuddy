// red-proof: inject  `if (import.meta.main)` disabled in
//                    the body-owner-hold runner -> `✖ every registered gate runner declares a CLI entry point`, actual
//                    `[ 'run-stardew-native-local-player-body-owner-hold-smoke.mjs' ]` against `[]`, exit 1
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";

/**
 * Every runner the gate tables name must be RUNNABLE BY THE HARNESS.
 *
 * Why this exists: a new runner passed while running NOTHING. It had no `import.meta.main` entry point, so the
 * harness imported the module and exited 0, and the batch read that as PASS. The offline suite could not see it,
 * because those tests import the exported function directly and never take the CLI path - the same "the test
 * bypasses the path that fails" shape that has produced most of the defects in this lane.
 *
 * This is the static half of the guard: the tables must name files that declare an entry point AND print a
 * result. The dynamic half lives in the fixture harness, which refuses an exit-0 run that produced no result
 * JSON.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runnerNames() {
  const names = new Set(STARDEW_PUBLISHED_ACTION_GATES.map((gate) => gate.runner));
  for (const runner of Object.values(STARDEW_EXPERIMENTAL_ACTION_RUNNERS)) names.add(runner);
  return [...names].sort();
}

test("every registered gate runner declares a CLI entry point", () => {
  const missing = [];
  for (const name of runnerNames()) {
    const source = readFileSync(path.join(ROOT, "tools", name), "utf8");
    if (!source.includes("if (import.meta.main)")) missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    "a runner without an entry point exits 0 while doing nothing, which the harness reads as PASS",
  );
});

test("every registered gate runner prints a result the harness can require", () => {
  const silent = [];
  for (const name of runnerNames()) {
    const source = readFileSync(path.join(ROOT, "tools", name), "utf8");
    // Deliberately NOT "prints a JSON object with a state field": two long-standing passing gates print a result
    // without that key, and tightening the harness past what they emit would break working gates to catch a
    // defect they do not have. What a runner with no entry point lacks is ANY output, so that is the requirement.
    //
    // The print may live in the shared template (`tools/lib/native-local-runner-scaffold.mjs`), which is where the
    // migrated runners put it: a runner that hands its lifecycle to `runSmokeScenarioMain` prints from there, and one
    // that neither prints nor hands off is the "exited 0" case this guard exists for. Both halves are read here, so
    // the guard is as wide as it was and reads one more shape rather than one fewer.
    if (!reportsItself(source)) silent.push(name);
  }
  assert.deepEqual(silent, [], "the harness must be able to tell 'ran and reported' from 'exited 0'");
});

/**
 * `reportsItself`: does this runner's source end in a printed result, its own or the template's?
 *
 * Declared beside its falsifier for the reason that guard needs it: the half this file gained with the migration must be
 * able to say NO, or it is a widening dressed as a fix.
 */
function reportsItself(source) {
  if (/console\.log\(/u.test(source)) return true;
  return (
    /from\s+["'][^"']*lib\/native-local-runner-scaffold\.mjs["']/u.test(source) &&
    /\brunSmokeScenarioMain\s*\(/u.test(source)
  );
}

test("the print guard still reds for a runner that neither prints nor hands its lifecycle to the template", () => {
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
    "a runner that prints itself still passes",
  );
  assert.equal(
    reportsItself(
      'import { runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";\nrunSmokeScenarioMain(scenario);\n',
    ),
    true,
    "a runner that hands the lifecycle to the template prints from there",
  );
});

test("the gate tables are not empty, so the checks above cannot pass vacuously", () => {
  const names = runnerNames();
  assert.ok(names.length >= 40, `expected the registered runner set, got ${names.length}`);
  // And the one this guard was written for is in there.
  assert.ok(
    Object.values(STARDEW_EXPERIMENTAL_ACTION_RUNNERS).includes(
      "run-stardew-native-local-player-body-owner-hold-smoke.mjs",
    ),
  );
});
