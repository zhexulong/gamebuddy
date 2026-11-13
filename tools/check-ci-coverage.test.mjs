/*
 * red-proof: history  the real report `check:draft-declaration-coverage` printed on 2026-11-05 -
 *                     `{"gate":"draft-declaration-coverage","status":"passed","fields":0,...}` with exit 0 -
 *                     replayed as an aggregate gate -> `gate_measured_nothing:draft-declaration-coverage:fields`,
 *                     `measured_nothing=1`, exit 1 (this file)
 * red-proof: inject   the new population rule commented out -> the same replay is `passed` and the run exits 0,
 *                     which is the green reading with an empty population the rule exists to refuse (this file)
 * red-proof: inject   a skip marker beside a zero population -> `not_measured`, never `measured_nothing` and
 *                     never `passed`: the ordering is what decides, not the population (this file)
 * red-proof: inject   `{"gate":"x","files":0}` -> `passed`, because `files` is not a declared population
 *                     field and a ratchet over no files is a real reading (this file)
 *
 * The population of every runtime test is a real gate process, written to a temp file and spawned through
 * the aggregate the same way `--run` spawns the 44: the aggregate reads another process's stdout, so a test
 * that calls `gateOutcome` directly would not exercise the thing that broke.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertNonVacuous } from "./lib/assert-non-vacuous.mjs";
import { deriveCiCoverage, runGates } from "./check-ci-coverage.mjs";

const RUNNER_COMMAND = "node tools/check-ci-coverage.mjs --run";

/** The report `check:draft-declaration-coverage` printed on 2026-11-05 (`e22e2d3f`), verbatim. */
const DRAFT_ZERO_REPORT =
  '{"gate":"draft-declaration-coverage","status":"passed","mode":"mounted","fields":0,"declared":0,"exempt":0}';

/** A real gate process that prints `lines` and exits `status`, plus the cleanup of the file it lives in. */
async function stubGate({ lines = [], status = 0 }) {
  const dir = await mkdtemp(join(tmpdir(), "ci-coverage-gate-"));
  const file = join(dir, "gate.mjs");
  await writeFile(
    file,
    `for (const line of ${JSON.stringify(lines)}) console.log(line);\nprocess.exit(${status});\n`,
    "utf8",
  );
  return { command: `"${process.execPath}" "${file}"`, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** One stub per gate name, as the `scripts` map the aggregate would read from package.json. */
async function stubGates(specs) {
  const commands = {};
  const stubs = [];
  for (const [name, spec] of Object.entries(specs)) {
    const stub = await stubGate(spec);
    commands[name] = stub.command;
    stubs.push(stub);
  }
  return { commands, cleanup: () => Promise.all(stubs.map((stub) => stub.cleanup())) };
}

/** Run the aggregate over stubs, and keep everything it printed. */
async function runStubs(specs) {
  const { commands, cleanup } = await stubGates(specs);
  try {
    const written = [];
    const code = await runGates(Object.keys(commands), commands, { write: (chunk) => written.push(chunk) });
    return { code, text: written.join(""), lines: written.join("").split("\n") };
  } finally {
    await cleanup();
  }
}

const summaryOf = (lines) => lines.find((line) => line.startsWith("ci_gates_run"));
const countsOf = (lines) =>
  summaryOf(lines)
    .split(" ")
    .slice(1)
    .filter((token) => !/^\d+s$/u.test(token));

function coverage({ scripts, workflow = "", register = [] }) {
  return deriveCiCoverage({
    scripts: { ...scripts, "run:ci-gates": RUNNER_COMMAND },
    workflowText: `${workflow}\n      - run: ${RUNNER_COMMAND}`,
    register,
  });
}

test("a gate named by a workflow step is already run and stays out of the derived set", () => {
  const result = coverage({
    scripts: { "check:knip": "pnpm knip", "check:diff": "node tools/check-diff.mjs" },
    workflow: "      - run: pnpm check:knip",
  });
  assert.deepEqual(result.workflow, ["check:knip"]);
  assert.deepEqual(result.derived, ["check:diff"]);
  assert.deepEqual(result.problems, []);
});

test("a step that runs the file a script wraps covers the script", () => {
  const result = coverage({
    scripts: { "check:publint": "node tools/check-publint.mjs" },
    workflow: "      - run: node tools/check-publint.mjs",
  });
  assert.deepEqual(result.workflow, ["check:publint"]);
  assert.deepEqual(result.derived, []);
});

test("naming gates inside another script is not coverage - no job runs quality:check", () => {
  const result = coverage({
    scripts: {
      "lint:eslint": "eslint dialogue-web/src",
      "quality:check": "pnpm lint:eslint && pnpm lint",
    },
    // The comment names the gate; a comment is not a step.
    workflow: "      # quality:check runs lint:eslint\n      - run: pnpm check:knip",
  });
  assert.deepEqual(result.derived, ["lint:eslint"]);
});

test("an unregistered gate is derived for the job instead of going uncovered", () => {
  const result = coverage({ scripts: { "check:new-gate": "node tools/new-gate.mjs" } });
  assert.deepEqual(result.derived, ["check:new-gate"]);
  assert.deepEqual(result.problems, []);
});

test("the derived half fails the verdict when no workflow runs it", () => {
  const result = deriveCiCoverage({
    scripts: { "check:diff": "node tools/check-diff.mjs" },
    workflowText: "      - run: pnpm check:diff",
    register: [],
  });
  assert.equal(result.runnerWired, false);
  assert.deepEqual(result.problems, [{ code: "runner_unwired", script: "tools/check-ci-coverage.mjs --run" }]);
});

test("a registered gate carries its reason and leaves the derived set", () => {
  const result = coverage({
    scripts: { "check:live-run-preflight": "node tools/preflight-live-run.mjs" },
    register: [{ script: "check:live-run-preflight", reason: "arguments", detail: "requires --mods-path" }],
  });
  assert.deepEqual(result.derived, []);
  assert.deepEqual(result.problems, []);
});

test("a register entry that a workflow now runs is redundant", () => {
  const result = coverage({
    scripts: { "check:text-hygiene": "node tools/check-text-hygiene.mjs" },
    workflow: "      - run: pnpm check:text-hygiene",
    register: [{ script: "check:text-hygiene", reason: "debt", detail: "missing final newline" }],
  });
  assert.deepEqual(result.problems, [{ code: "register_redundant", script: "check:text-hygiene" }]);
});

test("a register entry that is no longer a gate script is stale", () => {
  const result = coverage({
    scripts: { "check:diff": "node tools/check-diff.mjs" },
    register: [{ script: "check:deleted-gate", reason: "debt", detail: "gone" }],
  });
  assert.deepEqual(result.problems, [{ code: "register_stale", script: "check:deleted-gate" }]);
});

test("a register entry needs a reason from the vocabulary and its measurement", () => {
  const result = coverage({
    scripts: { "check:diff": "node tools/check-diff.mjs", "check:knip": "pnpm knip" },
    register: [
      { script: "check:diff", reason: "because", detail: "x" },
      { script: "check:knip", reason: "debt", detail: "  " },
    ],
  });
  assert.deepEqual(result.problems, [
    { code: "register_unreasoned", script: "check:diff", detail: "because" },
    { code: "register_undetailed", script: "check:knip" },
  ]);
});

test("a script listed twice in the register is named, because registered= would count a gate that is not there", () => {
  const result = coverage({
    scripts: { "check:live-run-isolation": "node tools/check-live-run-isolation.mjs" },
    register: [
      { script: "check:live-run-isolation", reason: "environment", detail: "the Steam install at D:/Steam" },
      { script: "check:live-run-isolation", reason: "environment", detail: "a Mod Release build" },
    ],
  });
  assert.deepEqual(result.problems, [{ code: "register_duplicated", script: "check:live-run-isolation" }]);
  assert.equal(result.derived.length, 0);
});

test("test:* suites are the corpus runner's business, not this gate's", () => {
  const result = coverage({ scripts: { "test:stardew-loop-closure": "node --test tools/x.test.mjs" } });
  assert.deepEqual(result.gateScripts, []);
  assert.deepEqual(result.derived, []);
});

test("a gate that reports a skip and exits 0 is counted not measured, and does not fail the run", async () => {
  const skip = "perf_budget_skipped: baseline recorded on linux/x64/4 cpus/a, measured on linux/x64/4 cpus/b";
  const run = await runStubs({ "check:perf-budget": { lines: [skip], status: 0 } });
  assert.equal(run.code, 0);
  assert.match(run.text, /^ci_gate:check:perf-budget:not_measured:\d+s$/mu);
  // The gate's own line reaches the aggregate's output, which is why the marker can be read at all.
  assert.ok(run.lines.includes(skip), run.text);
  assert.deepEqual(countsOf(run.lines), [
    "total=1",
    "passed=0",
    "failed=0",
    "not_measured=1",
    "measured_nothing=0",
    "not_measured_gates=check:perf-budget",
  ]);
});

test("a gate that reports a skip and then fails is a failure, not a skip", async () => {
  const skip = "perf_budget_skipped: baseline recorded on linux/x64/4 cpus/a, measured on linux/x64/4 cpus/b";
  const run = await runStubs({ "check:perf-budget": { lines: [skip], status: 1 } });
  assert.equal(run.code, 1);
  assert.match(run.text, /^ci_gate:check:perf-budget:failed:1:\d+s$/mu);
  assert.deepEqual(countsOf(run.lines), [
    "total=1",
    "passed=0",
    "failed=1",
    "not_measured=0",
    "measured_nothing=0",
    "failing=check:perf-budget",
  ]);
});

test("without the marker the same gate is a pass, and nothing is counted as not measured", async () => {
  const run = await runStubs({
    "check:perf-budget": { lines: ["perf_budget_ok slowest=journal/replay 3.4 µs/op"], status: 0 },
  });
  assert.equal(run.code, 0);
  assert.match(run.text, /^ci_gate:check:perf-budget:passed:\d+s$/mu);
  assert.deepEqual(countsOf(run.lines), ["total=1", "passed=1", "failed=0", "not_measured=0", "measured_nothing=0"]);
});

test("a skip marker is a whole line, so a gate that only mentions one measured", async () => {
  const run = await runStubs({
    "check:perf-budget": { lines: ["note: perf_budget_skipped is what another box prints"], status: 0 },
  });
  assert.equal(run.code, 0);
  assert.deepEqual(countsOf(run.lines), ["total=1", "passed=1", "failed=0", "not_measured=0", "measured_nothing=0"]);
});

test("the real zero-population report is measured_nothing, named, and fails the run", async () => {
  // 2026-11-05: the gate exited 0 and printed `fields: 0` above a product whose surfaces always render text
  // fields. An exit status cannot tell that from a pass, which is what this reading is for.
  const run = await runStubs({ "check:draft-declaration-coverage": { lines: [DRAFT_ZERO_REPORT], status: 0 } });
  assert.equal(run.code, 1);
  assert.match(
    run.text,
    /^ci_gate:check:draft-declaration-coverage:gate_measured_nothing:draft-declaration-coverage:fields:\d+s$/mu,
  );
  assert.deepEqual(countsOf(run.lines), [
    "total=1",
    "passed=0",
    "failed=0",
    "not_measured=0",
    "measured_nothing=1",
    "measured_nothing_gates=check:draft-declaration-coverage",
  ]);
});

test("a skip marker beside a zero population stays not measured", async () => {
  const run = await runStubs({
    "check:x": { lines: ["x_skipped: no fixture on this machine", '{"gate":"x","population":0}'], status: 0 },
  });
  assert.equal(run.code, 0);
  assert.match(run.text, /^ci_gate:check:x:not_measured:\d+s$/mu);
  assert.deepEqual(countsOf(run.lines), [
    "total=1",
    "passed=0",
    "failed=0",
    "not_measured=1",
    "measured_nothing=0",
    "not_measured_gates=check:x",
  ]);
});

test("a report that examined objects passes and says how many", async () => {
  const run = await runStubs({ "check:x": { lines: ['{"gate":"x","fields":3}'], status: 0 } });
  assert.equal(run.code, 0);
  assert.match(run.text, /^ci_gate:check:x:passed examined 3 fields:\d+s$/mu);
  assert.deepEqual(countsOf(run.lines), ["total=1", "passed=1", "failed=0", "not_measured=0", "measured_nothing=0"]);
});

test("a zero under a key that is not a population field is left to the gate's exit status", async () => {
  // `files` is what a ratchet over no files reports, and that is a real reading - the rule's population is
  // the three declared fields, so a generic count cannot turn a correct gate red.
  const run = await runStubs({ "check:x": { lines: ['{"gate":"x","files":0,"checked":0,"count":0}'], status: 0 } });
  assert.equal(run.code, 0);
  assert.match(run.text, /^ci_gate:check:x:passed:\d+s$/mu);
  assert.match(summaryOf(run.lines), /measured_nothing=0/u);
});

test("a zero population with a stated reason is not measured, never passed", async () => {
  const report = '{"gate":"x","cases":0,"allowEmpty":"this gate judges a diff, and the diff is empty"}';
  const run = await runStubs({ "check:x": { lines: [report], status: 0 } });
  assert.equal(run.code, 0);
  assert.match(run.text, /^ci_gate:check:x:gate_zero_population_allowed:x:cases /mu);
  assert.deepEqual(countsOf(run.lines), [
    "total=1",
    "passed=0",
    "failed=0",
    "not_measured=1",
    "measured_nothing=0",
    "not_measured_gates=check:x",
  ]);
});

test("a zero population behind a failing exit status is still that failure, not measured_nothing", async () => {
  const run = await runStubs({ "check:x": { lines: ['{"gate":"x","fields":0}'], status: 4 } });
  assert.equal(run.code, 1);
  assert.match(run.text, /^ci_gate:check:x:failed:4:\d+s$/mu);
  assert.deepEqual(countsOf(run.lines), [
    "total=1",
    "passed=0",
    "failed=1",
    "not_measured=0",
    "measured_nothing=0",
    "failing=check:x",
  ]);
});

test("the primitive leaves a line that is not a population claim alone", () => {
  assert.equal(assertNonVacuous(null), null);
  assert.equal(assertNonVacuous({ status: "passed", fields: 0 }), null);
  assert.equal(assertNonVacuous({ gate: "x", status: "passed" }), null);
  assert.deepEqual(assertNonVacuous({ gate: "x", population: 2 }), {
    status: "passed",
    detail: "examined 2 population",
  });
  assert.deepEqual(assertNonVacuous({ gate: "x", cases: 0 }), {
    status: "blocked",
    detail: "gate_measured_nothing:x:cases",
  });
  assert.equal(assertNonVacuous({ gate: "x", cases: 0 }, { minPopulation: 0 }).status, "passed");
  assert.equal(
    assertNonVacuous({ gate: "x", cases: 0 }, { allowEmpty: "an empty diff is the healthy reading" }).status,
    "not_measured",
  );
});
