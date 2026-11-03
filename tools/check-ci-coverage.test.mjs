import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCiCoverage, runGates } from "./check-ci-coverage.mjs";

const RUNNER_COMMAND = "node tools/check-ci-coverage.mjs --run";

/** A real gate process whose output and exit status the test chooses: `<line>` then `<status>`. */
function stubGate({ line, status }) {
  const print = line === undefined ? "" : `console.log('${line.replaceAll("'", "\\'")}');`;
  return `node -e "${print}process.exit(${status})"`;
}

/** Run the aggregate over one stub gate, and keep everything it printed. */
async function runOneGate(scripts) {
  const written = [];
  const out = { write: (chunk) => written.push(chunk) };
  const code = await runGates(Object.keys(scripts), scripts, out);
  return { code, text: written.join(""), lines: written.join("").split("\n") };
}

const summaryOf = (lines) => lines.find((line) => line.startsWith("ci_gates_run"));

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

test("test:* suites are the corpus runner's business, not this gate's", () => {
  const result = coverage({ scripts: { "test:stardew-loop-closure": "node --test tools/x.test.mjs" } });
  assert.deepEqual(result.gateScripts, []);
  assert.deepEqual(result.derived, []);
});

test("a gate that reports a skip and exits 0 is counted not measured, and does not fail the run", async () => {
  const skip = "perf_budget_skipped: baseline recorded on linux/x64/4 cpus/a, measured on linux/x64/4 cpus/b";
  const run = await runOneGate({ "check:perf-budget": stubGate({ line: skip, status: 0 }) });
  assert.equal(run.code, 0);
  assert.match(run.text, /^ci_gate:check:perf-budget:not_measured:\d+s$/mu);
  // The gate's own line reaches the aggregate's output, which is why the marker can be read at all.
  assert.ok(run.lines.includes(skip), run.text);
  assert.equal(
    summaryOf(run.lines).replace(/ \d+s/u, ""),
    "ci_gates_run total=1 passed=0 failed=0 not_measured=1 not_measured_gates=check:perf-budget",
  );
});

test("a gate that reports a skip and then fails is a failure, not a skip", async () => {
  const skip = "perf_budget_skipped: baseline recorded on linux/x64/4 cpus/a, measured on linux/x64/4 cpus/b";
  const run = await runOneGate({ "check:perf-budget": stubGate({ line: skip, status: 1 }) });
  assert.equal(run.code, 1);
  assert.match(run.text, /^ci_gate:check:perf-budget:failed:1:\d+s$/mu);
  assert.ok(!summaryOf(run.lines).includes("not_measured_gates"), summaryOf(run.lines));
  assert.match(summaryOf(run.lines), /total=1 passed=0 failed=1 not_measured=0 /u);
});

test("without the marker the same gate is a pass, and nothing is counted as not measured", async () => {
  const run = await runOneGate({
    "check:perf-budget": stubGate({ line: "perf_budget_ok slowest=journal/replay 3.4 µs/op", status: 0 }),
  });
  assert.equal(run.code, 0);
  assert.match(run.text, /^ci_gate:check:perf-budget:passed:\d+s$/mu);
  assert.ok(!summaryOf(run.lines).includes("not_measured_gates"), summaryOf(run.lines));
  assert.match(summaryOf(run.lines), /total=1 passed=1 failed=0 not_measured=0 /u);
});

test("a skip marker is a whole line, so a gate that only mentions one measured", async () => {
  const run = await runOneGate({
    "check:perf-budget": stubGate({ line: "note: perf_budget_skipped is what another box prints", status: 0 }),
  });
  assert.equal(run.code, 0);
  assert.match(summaryOf(run.lines), /total=1 passed=1 failed=0 not_measured=0 /u);
});
