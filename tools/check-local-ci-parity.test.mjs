/*
 * red-proof: history  the ladder member `pnpm lint:ast-grep` ran in no workflow until `54c4227b`: replayed at the
 *                     parent this gate reports `ladder_step_uncovered:4:lint:ast-grep` with findings=1, population=13,
 *                     exit 1, and at `54c4227b` findings=0, population=13, exit 0 - the ablation
 *                     `tools/replay-gate-on-history.mjs --gate tools/check-local-ci-parity.mjs --at 54c4227b^
 *                     --at 54c4227b` holds both expectations (this file holds the synthetic half below).
 * red-proof: inject   a declared row whose script gains a workflow step -> `parity_exemption_redundant` names the
 *                     script and the reading that now covers it, so an exemption cannot outlive its reason (this file)
 * red-proof: inject   a ladder member with no workflow step and no row -> `ladder_step_uncovered:<position>:<script>`,
 *                     exit 1 (this file)
 * red-proof: inject   a ladder step the reader cannot resolve (a `node` invocation where `pnpm <script>` belongs)
 *                     -> the membership is named rather than dropped, and a ladder that resolves no member at all is
 *                     blocked, exit 2 (this file)
 *
 * Every case drives the exported reading over a fixture tree or a fixture `scripts` table: the gate's population is
 * two documents (`package.json`, the workflow files), so a test that handed it a prepared answer would not exercise
 * the parsing that broke.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildReport, deriveParity, EXEMPTIONS, ladderSteps, main } from "./check-local-ci-parity.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One fixture checkout: a `package.json` script table and a `.github/workflows` directory. */
function fixtureTree({ scripts, workflows }) {
  const root = mkdtempSync(join(tmpdir(), "local-ci-parity-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
  for (const [name, lines] of Object.entries(workflows))
    writeFileSync(join(root, ".github", "workflows", name), Array.isArray(lines) ? lines.join("\n") : lines, "utf8");
  return root;
}

function run(root, argv = [], options = {}) {
  const out = [];
  const err = [];
  const code = main(argv, {
    root,
    out: { write: (chunk) => out.push(chunk) },
    err: { write: (chunk) => err.push(chunk) },
    exemptions: options.exemptions ?? EXEMPTIONS,
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** The four buckets a ladder step can land in - the partition every case below is read against. */
function buckets(reading) {
  return {
    inCi: reading.inCi.length,
    ladderOnly: reading.ladderOnly.length,
    localOnly: reading.localOnly.length,
    unresolved: reading.findings.filter((finding) => /^ladder_step_/u.test(finding.code)).length,
  };
}

/** The reading over a fixture's two documents, with no rows unless the case is about rows. */
function parity({ scripts, workflowText = "", exemptions = [] }) {
  return deriveParity({ scripts, workflowText, exemptions });
}

test("a ladder step is read in ladder order, and a step that is not `pnpm <script>` is named rather than skipped", () => {
  const steps = ladderSteps("pnpm format:check && pnpm run lint && node tools/x.mjs");
  assert.deepEqual(
    steps.map((step) => [step.position, step.script]),
    [
      [1, "format:check"],
      [2, "lint"],
      [3, null],
    ],
  );
});

test("a step naming the script covers the ladder member, and a YAML comment naming it does not", () => {
  const covered = parity({
    scripts: { "quality:check": "pnpm lint", lint: "node tools/lint.mjs" },
    workflowText: "      - run: pnpm lint",
  });
  assert.deepEqual(buckets(covered), { inCi: 1, ladderOnly: 0, localOnly: 0, unresolved: 0 });
  assert.equal(covered.covered.get("lint"), "step-names-script");

  const commented = parity({
    scripts: { "quality:check": "pnpm lint", lint: "node tools/lint.mjs" },
    workflowText: "      # - run: pnpm lint\n      - run: pnpm typecheck",
  });
  assert.deepEqual(buckets(commented), { inCi: 0, ladderOnly: 0, localOnly: 0, unresolved: 1 });
  assert.equal(commented.findings[0].code, "ladder_step_uncovered");
  assert.equal(commented.findings[0].id, "1:lint");
});

test("a step naming the file a script wraps covers it", () => {
  const reading = parity({
    scripts: { "quality:check": "pnpm check:publint", "check:publint": "node tools/check-publint.mjs" },
    workflowText: "      - run: node tools/check-publint.mjs",
  });
  assert.equal(reading.covered.get("check:publint"), "step-names-script");
  assert.deepEqual(reading.findings, []);
});

test("a script the `gates` job derives is covered, through the same reading that runs it", () => {
  const reading = parity({
    scripts: { "quality:check": "pnpm check:new", "check:new": "node tools/check-new.mjs" },
    workflowText: "      - run: node tools/check-ci-coverage.mjs --run",
  });
  assert.equal(reading.covered.get("check:new"), "gates-job");
  assert.deepEqual(reading.findings, []);
});

test("a step running the script's own command over the same project covers it - flags change how, not what", () => {
  const reading = parity({
    scripts: {
      "quality:check": "pnpm test:stardew:core",
      "test:stardew:core": "dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests",
    },
    workflowText: [
      "      - run: dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --no-restore",
    ].join("\n"),
  });
  assert.equal(reading.covered.get("test:stardew:core"), "step-runs-command");

  const otherProject = parity({
    scripts: {
      "quality:check": "pnpm test:stardew:core",
      "test:stardew:core": "dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests",
    },
    workflowText:
      "      - run: dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --no-restore",
  });
  assert.equal(otherProject.covered.get("test:stardew:core"), undefined);
  assert.equal(otherProject.findings[0].code, "ladder_step_uncovered");
});

test("a multi-line `run: |` block is read as a step, and a comment inside it is not a command", () => {
  const reading = parity({
    scripts: { "quality:check": "pnpm lint:eslint", "lint:eslint": "eslint dialogue-web/src" },
    workflowText: ["      - run: |", "          # eslint dialogue-web/src", "          pnpm typecheck"].join("\n"),
  });
  assert.equal(reading.covered.get("lint:eslint"), undefined);
  assert.equal(reading.findings[0].id, "1:lint:eslint");
});

test("the uncovered ladder member is named with its position, and the run exits 1", () => {
  const root = fixtureTree({
    scripts: {
      "quality:check": "pnpm lint && pnpm check:text-hygiene",
      lint: "node tools/lint.mjs",
      "check:text-hygiene": "node tools/check-text-hygiene.mjs",
    },
    workflows: { "ci.yml": ["      - run: pnpm lint"] },
  });
  try {
    const reading = run(root, [], { exemptions: [] });
    assert.equal(reading.code, 1);
    assert.match(reading.err, /ladder_step_uncovered:2:check:text-hygiene /u);
    assert.match(
      reading.out,
      /local_ci_parity: ladder=2 in_ci=1 ladder_only=0 local_only=0 ci_only=0 exemptions=0 examined=2/u,
    );
    assert.match(reading.out, /"status":"failed"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared row keeps the run green, and expires the moment a workflow step covers the script", () => {
  const scripts = {
    "quality:check": "pnpm lint && pnpm lint:eslint",
    lint: "node tools/lint.mjs",
    "lint:eslint": "eslint dialogue-web/src",
  };
  const exemptions = [{ script: "lint:eslint", reason: "debt", detail: "recorded debt elsewhere" }];
  const declared = parity({
    scripts,
    workflowText: "      - run: pnpm lint",
    exemptions,
  });
  assert.deepEqual(
    declared.ladderOnly.map((row) => [row.script, row.reason, row.position]),
    [["lint:eslint", "debt", 2]],
  );
  assert.deepEqual(declared.findings, []);

  const caughtUp = parity({
    scripts,
    workflowText: "      - run: pnpm lint\n      - run: pnpm lint:eslint",
    exemptions,
  });
  assert.deepEqual(
    caughtUp.findings.map((finding) => [finding.code, finding.id]),
    [["parity_exemption_redundant", "lint:eslint"]],
  );
});

test("a row for a script that left the ladder is stale, and a row outside the reason vocabulary is unreasoned", () => {
  const scripts = { "quality:check": "pnpm lint", lint: "node tools/lint.mjs" };
  const stale = parity({
    scripts,
    workflowText: "      - run: pnpm lint",
    exemptions: [{ script: "check:gone", reason: "debt", detail: "measured elsewhere" }],
  });
  assert.deepEqual(
    stale.findings.map((finding) => [finding.code, finding.id]),
    [["parity_exemption_stale", "check:gone"]],
  );

  const unreasoned = parity({
    scripts: { ...scripts, "quality:check": "pnpm lint && pnpm check:x", "check:x": "node tools/check-x.mjs" },
    workflowText: "      - run: pnpm lint",
    exemptions: [{ script: "check:x", reason: "somebody-was-busy", detail: "measured elsewhere" }],
  });
  assert.deepEqual(
    unreasoned.findings.map((finding) => [finding.code, finding.id]),
    [["parity_exemption_unreasoned", "check:x:somebody-was-busy"]],
  );

  const undetailed = parity({
    scripts: { ...scripts, "quality:check": "pnpm lint && pnpm check:x", "check:x": "node tools/check-x.mjs" },
    workflowText: "      - run: pnpm lint",
    exemptions: [{ script: "check:x", reason: "debt", detail: "  " }],
  });
  assert.deepEqual(
    undetailed.findings.map((finding) => [finding.code, finding.id]),
    [["parity_exemption_undetailed", "check:x"]],
  );
});

test("a `local-only` row lands in its own bucket, not among the declared debt", () => {
  const reading = parity({
    scripts: { "quality:check": "pnpm watch", watch: "node tools/watch.mjs" },
    workflowText: "      - run: pnpm lint",
    exemptions: [{ script: "watch", reason: "local-only", detail: "a dev server; a push has nothing to watch" }],
  });
  assert.deepEqual(
    reading.localOnly.map((row) => [row.script, row.position]),
    [["watch", 1]],
  );
  assert.deepEqual(reading.ladderOnly, []);
  assert.deepEqual(reading.findings, []);
});

test("the buckets partition the ladder: nothing is counted twice and nothing is lost", () => {
  const reading = parity({
    scripts: {
      "quality:check": "pnpm a && pnpm b && pnpm c && pnpm d",
      a: "node tools/a.mjs",
      b: "node tools/b.mjs",
      c: "node tools/c.mjs",
      d: "node tools/d.mjs",
    },
    workflowText: "      - run: pnpm a\n      - run: node tools/check-ci-coverage.mjs --run",
    exemptions: [
      { script: "b", reason: "debt", detail: "measured elsewhere" },
      { script: "c", reason: "local-only", detail: "a watch mode" },
    ],
  });
  const counted = buckets(reading);
  assert.equal(counted.inCi + counted.ladderOnly + counted.localOnly + counted.unresolved, reading.steps.length);
  assert.deepEqual(counted, { inCi: 1, ladderOnly: 1, localOnly: 1, unresolved: 1 });
});

test("a ladder that resolves no member is blocked, not clean", () => {
  const root = fixtureTree({
    scripts: { "quality:check": "node tools/lint.mjs" },
    workflows: { "ci.yml": ["      - run: pnpm lint"] },
  });
  try {
    const reading = run(root, [], { exemptions: [] });
    assert.equal(reading.code, 2);
    assert.match(reading.err, /local_ci_parity_ladder_empty:no ladder step resolved to a script/u);
    assert.match(reading.err, /ladder_step_unreadable:1:node tools\/lint\.mjs/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ladder script that does not exist in package.json is blocked", () => {
  const root = fixtureTree({
    scripts: { lint: "node tools/lint.mjs" },
    workflows: { "ci.yml": ["      - run: pnpm lint"] },
  });
  try {
    const reading = run(root, [], { exemptions: [] });
    assert.equal(reading.code, 2);
    assert.match(reading.err, /local_ci_parity_ladder_missing:quality:check/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workflow read that covers nothing is blocked, not a clean diff", () => {
  const root = fixtureTree({
    scripts: { "quality:check": "pnpm lint", lint: "node tools/lint.mjs" },
    workflows: { "ci.yml": ["      # nothing runs here yet"] },
  });
  try {
    const reading = run(root, [], { exemptions: [] });
    assert.equal(reading.code, 2);
    assert.match(reading.err, /local_ci_parity_workflow_unread:no workflow step covers any script/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this repository's own ladder: every member is either in CI or declared, and the direction is reported", () => {
  const reading = run(REPOSITORY_ROOT, ["--json"]);
  const report = JSON.parse(reading.out.slice(reading.out.indexOf("{")));
  assert.equal(reading.code, 0);
  assert.equal(report.status, "passed");
  assert.ok(report.examined >= 1, `examined=${report.examined}`);
  assert.equal(new Set(report.ladder).size, report.ladder.length);
  for (const row of [...report.ladderOnly, ...report.localOnly]) assert.match(row, /^[\w:-]+:[a-z-]+$/u);
  // The second direction is a reading, never a failure: CI runs root scripts the ladder does not name, and the
  // ladder's own verdict must not depend on their count.
  assert.ok(report.ciOnly.length > 0);
  assert.equal(report.ciOnly.includes("quality:check"), false);
});

test("the report a caller reads carries the ladder as its population, so the reading says how many members it examined", () => {
  const reading = parity({
    scripts: { "quality:check": "pnpm lint", lint: "node tools/lint.mjs" },
    workflowText: "      - run: pnpm lint",
  });
  const report = buildReport(reading);
  assert.deepEqual(report.ladder, ["lint"]);
  assert.equal(report.population, 1);
  assert.equal(report.examined, 1);
  assert.equal(report.status, "passed");
});
