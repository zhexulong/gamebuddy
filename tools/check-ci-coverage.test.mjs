import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCiCoverage } from "./check-ci-coverage.mjs";

const RUNNER_COMMAND = "node tools/check-ci-coverage.mjs --run";

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
