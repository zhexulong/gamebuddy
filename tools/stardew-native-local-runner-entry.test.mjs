import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STARDEW_EXPERIMENTAL_ACTION_RUNNERS, STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

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
    if (!/console\.log\(/.test(source)) silent.push(name);
  }
  assert.deepEqual(silent, [], "the harness must be able to tell 'ran and reported' from 'exited 0'");
});

test("the gate tables are not empty, so the checks above cannot pass vacuously", () => {
  const names = runnerNames();
  assert.ok(names.length >= 40, `expected the registered runner set, got ${names.length}`);
  // And the one this guard was written for is in there.
  assert.ok(Object.values(STARDEW_EXPERIMENTAL_ACTION_RUNNERS).includes("run-stardew-native-local-player-body-owner-hold-smoke.mjs"));
});
