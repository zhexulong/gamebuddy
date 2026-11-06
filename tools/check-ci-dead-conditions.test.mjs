/**
 * The falsifiers for `tools/check-ci-dead-conditions.mjs`.
 *
 * Plain `node --test` has no way to install a step into a hosted runner, so every falsifier below is a
 * synthetic tree carrying a fake `.github/workflows` - the shapes are copied from the real workflows of
 * this repository, comments and layout included where they matter, because a parser tuned to one
 * invented shape proves nothing about the file that hid the accident.
 *
 * red-proof: inject  a workflow whose `if: env.NEVER_SET != ''` no step ever sets ->
 *            `dead_ci_condition:ci.yml:quality:NEVER_SET` with both `+ newly added:` and `- missing:` on
 *            stderr (tools/check-ci-dead-conditions.test.mjs), while `env:` and `$GITHUB_ENV` writes are green.
 * red-proof: history ci.yml under `.github/workflows` read `env.GAMEBUDDY_STARDEW_GAME_PATH` in two `if:`s
 *            and set it in none - the silence measured 2026-09-29 to 2026-11-02 - so that condition is
 *            named (tools/check-ci-dead-conditions.test.mjs reads this repository's own tree).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditDeadConditions } from "./check-ci-dead-conditions.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-ci-dead-conditions.mjs");
const WORKFLOW_FILE = /\.ya?ml$/u;
const roots = [];

/** One fixture checkout: a `.github/workflows` directory and the workflows asked for. */
function makeTree(workflows) {
  const root = mkdtempSync(join(tmpdir(), "ci-dead-conditions-"));
  roots.push(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, content] of Object.entries(workflows)) {
    writeFileSync(join(root, ".github", "workflows", name), Array.isArray(content) ? content.join("\n") : content);
  }
  return root;
}

/** The gate as an operator runs it, with the report it printed last on stdout. */
function runGate(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(result.stdout.trim().split("\n").at(-1)),
  };
}

/** The dead condition's workflow with extra steps inserted ahead of it, so a write can precede the read. */
function deadConditionAfter(steps) {
  return [
    "name: ci",
    "on:",
    "  push:",
    "jobs:",
    "  quality:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...steps,
    "      - name: Portfolio suite",
    "        if: ${{ !cancelled() && env.NEVER_SET != '' }}",
    "        run: pnpm test:portfolio",
    "",
  ].join("\n");
}

/**
 * The condition ci.yml carried on `GAMEBUDDY_STARDEW_GAME_PATH`, in the shape that step had: a `!cancelled()`
 * conjunction around an `env` comparison, and a job whose steps never set the variable.
 */
const DEAD_CONDITION = [
  "name: ci",
  "on:",
  "  push:",
  "jobs:",
  "  quality:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: pnpm test",
  "      - name: Portfolio suite",
  "        if: ${{ !cancelled() && env.NEVER_SET != '' }}",
  "        run: pnpm test:portfolio",
  "",
].join("\n");

test("a condition no step writes is named, with both sides of its diff", () => {
  const tree = makeTree({ "ci.yml": DEAD_CONDITION });
  const { status, stdout, stderr, report } = runGate(tree);

  assert.equal(status, 1);
  assert.equal(report.gate, "ci-dead-conditions");
  assert.equal(report.status, "failed");
  assert.equal(report.examined, 1);
  assert.deepEqual(
    report.violations.map((violation) => violation.code),
    ["dead_ci_condition:ci.yml:quality:NEVER_SET"],
  );
  assert.match(stdout, /examined 1/u);
  assert.match(stderr, /dead_ci_condition:ci\.yml:quality:NEVER_SET/u);
  assert.match(stderr, /\+ newly added: \[NEVER_SET\]/u);
  assert.match(stderr, /- missing: \[NEVER_SET\]/u);
});

test("the diff reads the job, not the variable: a written condition and a dead one differ on each side", () => {
  const tree = makeTree({
    "ci.yml": [
      "name: ci",
      "on:",
      "  push:",
      "jobs:",
      "  quality:",
      "    env:",
      "      WRITTEN: '1'",
      "    steps:",
      "      - name: Two conditions, one of them satisfiable",
      "        if: ${{ env.WRITTEN != '' && env.NEVER_SET != '' }}",
      "        run: pnpm test",
      "",
    ].join("\n"),
  });
  const { report } = runGate(tree);

  assert.deepEqual(
    report.violations.map((violation) => violation.code),
    ["dead_ci_condition:ci.yml:quality:NEVER_SET"],
  );
  assert.deepEqual(report.violations[0].newlyAdded, ["NEVER_SET", "WRITTEN"]);
  assert.deepEqual(report.violations[0].missing, ["NEVER_SET"]);
});

test("a job `env:` declaration satisfies the condition, so nothing is reported", () => {
  const tree = makeTree({
    "ci.yml": DEAD_CONDITION.replace(
      "    runs-on: ubuntu-latest",
      "    runs-on: ubuntu-latest\n    env:\n      NEVER_SET: configured",
    ),
  });
  const { status, stdout, report } = runGate(tree);

  assert.equal(status, 0);
  assert.equal(report.status, "passed");
  assert.equal(report.examined, 1);
  assert.deepEqual(report.violations, []);
  assert.match(stdout, /examined 1 workflow file\(s\), 0 dead condition\(s\)/u);
});

test("a step-level `env:` and a workflow-level `env:` are write sources too", () => {
  const tree = makeTree({
    "ci.yml": [
      "name: ci",
      "env:",
      "  WORKFLOW_WIDE: configured",
      "on:",
      "  push:",
      "jobs:",
      "  quality:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Step scoped",
      "        if: ${{ env.WORKFLOW_WIDE != '' && env.STEP_SCOPED != '' }}",
      "        env:",
      "          STEP_SCOPED: configured",
      "        run: pnpm test",
      "",
    ].join("\n"),
  });
  const { status, report } = runGate(tree);

  assert.equal(status, 0);
  assert.deepEqual(report.violations, []);
});

test("an append to the bash env file satisfies the condition", () => {
  const tree = makeTree({
    "ci.yml": deadConditionAfter([
      "      - name: Publish the release identity",
      "        run: |",
      '          echo "NEVER_SET=${GITHUB_SHA}" >> $GITHUB_ENV',
    ]),
  });
  const { status, report } = runGate(tree);

  assert.equal(status, 0);
  assert.deepEqual(report.violations, []);
});

test("an append through PowerShell's `$env:GITHUB_ENV` satisfies it, in the shape shots-capture.yml uses", () => {
  const tree = makeTree({
    "ci.yml": deadConditionAfter([
      "      - name: Download the pinned runtime",
      "        shell: pwsh",
      "        run: |",
      '          $runtime = Join-Path $dest "node"',
      '          "NEVER_SET=$runtime" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8',
    ]),
  });
  const { status, report } = runGate(tree);

  assert.equal(status, 0);
  assert.deepEqual(report.violations, []);
});

test("a comment is not a condition and not a write, and uncommenting one makes it both", () => {
  const commented = [
    "name: ci",
    "on:",
    "  push:",
    "jobs:",
    "  quality:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      # The suite below sat behind a gate a hosted runner could not satisfy - the 2026-09-29 silence:",
    "      #   if: ${{ env.NEVER_SET != '' }}",
    "      - name: Publish the release identity",
    "        if: ${{ always() }} # env.NEVER_SET != ''",
    "        run: |",
    '          # echo "COMMENTED_OUT=1" >> $GITHUB_ENV',
    '          echo "OTHER=1" >> $GITHUB_ENV',
    "",
  ].join("\n");
  const live = commented.replace("if: ${{ always() }} # env.NEVER_SET != ''", "if: ${{ env.NEVER_SET != '' }}");

  const quiet = runGate(makeTree({ "ci.yml": commented }));
  assert.equal(quiet.status, 0);
  assert.deepEqual(quiet.report.violations, []);

  const reported = runGate(makeTree({ "ci.yml": live }));
  assert.equal(reported.status, 1);
  assert.deepEqual(
    reported.report.violations.map((violation) => violation.code),
    ["dead_ci_condition:ci.yml:quality:NEVER_SET"],
  );
});

test("a tree with no workflow file is blocked, not passed", () => {
  const tree = makeTree({});
  const { status, stderr, report } = runGate(tree);

  assert.equal(status, 1);
  assert.equal(report.examined, 0);
  assert.equal(report.status, "blocked");
  assert.match(stderr, /ci_dead_conditions_no_workflow_files/u);
});

test("this repository's own workflows: the population is the directory and every reading names a real condition", () => {
  const directory = join(REPOSITORY_ROOT, ".github", "workflows");
  const expected = readdirSync(directory).filter((name) => WORKFLOW_FILE.test(name)).length;
  const reading = auditDeadConditions({ root: REPOSITORY_ROOT });

  assert.ok(expected > 0, `${directory} holds no workflow file`);
  assert.equal(reading.examined, expected);
  assert.equal(reading.status, reading.violations.length === 0 ? "passed" : "failed");

  for (const violation of reading.violations) {
    const conditions = readFileSync(join(directory, violation.workflow), "utf8")
      .split(/\r?\n/u)
      .filter((line) => /^\s*(?:-\s+)?if:/u.test(line));
    assert.ok(
      conditions.some((line) => line.includes(violation.variable)),
      `${violation.code} names ${violation.variable}, which no \`if:\` in ${violation.workflow} reads`,
    );
    assert.ok(violation.missing.includes(violation.variable), violation.code);
    assert.ok(violation.newlyAdded.includes(violation.variable), violation.code);
  }

  const measured = reading.violations.map((violation) => violation.code);
  process.stdout.write(
    `ci_dead_conditions in this repository: examined ${reading.examined}, ` +
      `dead ${measured.length}${measured.length === 0 ? "" : ` (${measured.join(", ")})`}\n`,
  );
});

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
