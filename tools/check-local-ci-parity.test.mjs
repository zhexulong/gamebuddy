/*
 * red-proof: history  `pnpm lint:ast-grep` ran in no workflow until `54c4227b`. Replayed at that
 *                     commit's parent the ladder reading fires with `ladder_step_uncovered:4:lint:ast-grep`,
 *                     findings=1, exit 1, and at `54c4227b` it does not - the ablation
 *                     `tools/replay-gate-on-history.mjs --gate tools/check-local-ci-parity.mjs --at
 *                     54c4227b^ --at 54c4227b` holds both expectations. That reading was taken over the
 *                     `quality:check` ladder this gate used to subtract; the population is the prelive
 *                     ladder now, and the same three failures are injected below.
 * red-proof: inject   a member the ladder runs that no step covers -> `ladder_member_uncovered:<position>:<id>`,
 *                     exit 1 (this file)
 * red-proof: inject   a gate file with no `package.json` name -> it stays a population member and is named
 *                     rather than dropped (this file)
 * red-proof: inject   a declared row whose member gains a workflow step -> `parity_exemption_redundant`
 *                     naming the member and the reading that covers it (this file)
 * red-proof: inject   a declared row for a member the ladder no longer runs -> `parity_exemption_stale`
 *                     (this file)
 * red-proof: inject   a ladder that reads no member, or a workflow read that covers no file -> blocked,
 *                     exit 2 (this file)
 *
 * Every case drives the exported reading over a fixture tree or a fixture pair of documents: the gate's
 * population is the ladder's own declaration plus two kinds of document (`package.json`, the workflows),
 * so a test that handed it a prepared answer would not exercise the parsing that broke.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildReport, deriveParity, EXEMPTIONS, ladderMembers, main } from "./check-local-ci-parity.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One fixture checkout: a `package.json` script table, `.github/workflows`, and any sub-packages. */
function fixtureTree({ scripts, workflows, packages = {} }) {
  const root = mkdtempSync(join(tmpdir(), "local-ci-parity-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
  for (const [name, lines] of Object.entries(workflows))
    writeFileSync(join(root, ".github", "workflows", name), Array.isArray(lines) ? lines.join("\n") : lines, "utf8");
  for (const [dir, table] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ scripts: table }), "utf8");
  }
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
    members: options.members,
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** A two-gate rung plus one rung of the ladder that runs no gate. */
const RUNGS = Object.freeze([{ id: "l0", gates: ["tools/check-covered.mjs", "tools/check-named.mjs"] }]);
const LADDER_RUNG_IDS = Object.freeze(["l0", "l1"]);

function members() {
  return ladderMembers({ rungs: RUNGS, ladderRungs: LADDER_RUNG_IDS });
}

/** The gate half of the population: what a case about coverage is actually about. */
function gates() {
  return members().filter((member) => member.kind === "gate");
}

/** The reading over a fixture's documents, with no rows unless the case is about rows. */
function parity({
  scripts = {},
  workflowText = "",
  packages = {},
  exemptions = [],
  members: population = gates(),
  suiteFiles = {},
}) {
  return deriveParity({ members: population, scripts, workflowText, packages, suiteFiles, exemptions });
}

function buckets(reading) {
  return {
    inCi: reading.covered.size,
    ladderOnly: reading.ladderOnly.length,
    localOnly: reading.localOnly.length,
    uncovered: reading.findings.filter((finding) => finding.code === "ladder_member_uncovered").length,
  };
}

test("the population is the ladder's own declaration: one member per gate, then one per gate-less rung", () => {
  assert.deepEqual(
    members().map((member) => [member.position, member.id, member.kind, member.rung]),
    [
      [1, "l1", "rung", null],
      [2, "tools/check-covered.mjs", "gate", "l0"],
      [3, "tools/check-named.mjs", "gate", "l0"],
    ],
  );
});

test("a step naming the member's file covers it, and a YAML comment naming it does not", () => {
  const covered = parity({
    scripts: { prelive: "node tools/prelive.mjs --no-game" },
    workflowText: "      - run: node tools/check-covered.mjs\n      - run: node tools/check-named.mjs",
    members: members().filter((member) => member.kind === "gate"),
  });
  assert.deepEqual(buckets(covered), { inCi: 2, ladderOnly: 0, localOnly: 0, uncovered: 0 });
  assert.equal(covered.covered.get("tools/check-covered.mjs"), "step-names-file");

  const commented = parity({
    workflowText: "      # - run: node tools/check-covered.mjs\n      - run: node tools/check-named.mjs",
  });
  assert.equal(commented.covered.get("tools/check-covered.mjs"), undefined);
  assert.deepEqual(
    commented.findings.map((finding) => [finding.code, finding.id]),
    [["ladder_member_uncovered", "2:tools/check-covered.mjs"]],
  );
});

test("a gate the `gates` job derives is covered, through the same reading that runs it", () => {
  const reading = parity({
    scripts: { "check:new": "node tools/check-covered.mjs" },
    workflowText: "      - run: node tools/check-ci-coverage.mjs --run",
  });
  assert.equal(reading.covered.get("tools/check-covered.mjs"), "gates-job");
});

test("a root script a step names covers the file its command runs", () => {
  const reading = parity({
    scripts: { "check:new": "node tools/check-covered.mjs" },
    workflowText: "      - run: pnpm check:new",
  });
  assert.equal(reading.covered.get("tools/check-covered.mjs"), "workflow-script");
});

test("a sub-package step covers the file THAT package's script runs, resolved against the package", () => {
  const reading = parity({
    workflowText: "      - run: pnpm --dir integrations/stardew/action-development action:ci",
    packages: { "integrations/stardew/action-development": { "action:ci": "node src/portfolio.mjs --ci" } },
    members: ladderMembers({
      rungs: [{ id: "l0", gates: ["integrations/stardew/action-development/src/portfolio.mjs"] }],
      ladderRungs: ["l0"],
    }),
  });
  assert.equal(
    reading.covered.get("integrations/stardew/action-development/src/portfolio.mjs"),
    "subpackage-step:integrations/stardew/action-development#action:ci",
  );
});

test("a package's suite step covers every test file the suite enumerates, not only the file it names", () => {
  const tests = "integrations/stardew/action-development/tests";
  const member = `${tests}/action-source-projection-drift.test.mjs`;
  const reading = parity({
    workflowText: "      - run: pnpm --dir integrations/stardew/action-development action:ci",
    packages: { "integrations/stardew/action-development": { "action:ci": "node src/portfolio.mjs --ci" } },
    suiteFiles: { [tests]: [member] },
    members: ladderMembers({ rungs: [{ id: "l0", gates: [member] }], ladderRungs: ["l0"] }),
  });
  assert.equal(reading.covered.get(member), "suite-step:integrations/stardew/action-development#action:ci");
  assert.deepEqual(reading.findings, []);
});

test("a gate file with no `package.json` name is still a member, and is reported by name", () => {
  const root = fixtureTree({
    scripts: { prelive: "node tools/prelive.mjs --no-game" },
    workflows: { "ci.yml": ["      - run: node tools/check-named.mjs"] },
  });
  try {
    const reading = run(root, [], { exemptions: [], members: members() });
    assert.equal(reading.code, 1);
    assert.match(reading.err, /ladder_member_uncovered:2:tools\/check-covered\.mjs /u);
    assert.match(reading.err, /ladder_member_uncovered:1:l1 /u);
    assert.match(
      reading.out,
      /local_ci_parity: ladder=3 in_ci=1 ladder_only=0 local_only=0 ci_only=0 exemptions=0 examined=3/u,
    );
    assert.match(reading.out, /"status":"failed"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared row keeps the run green, and expires the moment a step covers the member", () => {
  const exemptions = [
    { id: "tools/check-covered.mjs", reason: "debt", detail: "recorded debt elsewhere" },
    { id: "tools/check-named.mjs", reason: "local-only", detail: "a dev server; a push has nothing to watch" },
  ];
  const declared = parity({ workflowText: "      - run: pnpm typecheck", exemptions });
  assert.deepEqual(
    declared.ladderOnly.map((row) => [row.id, row.reason, row.position]),
    [["tools/check-covered.mjs", "debt", 2]],
  );
  assert.deepEqual(
    declared.localOnly.map((row) => [row.id, row.reason]),
    [["tools/check-named.mjs", "local-only"]],
  );
  assert.deepEqual(declared.findings, []);

  const caughtUp = parity({
    workflowText: "      - run: node tools/check-covered.mjs\n      - run: node tools/check-named.mjs",
    exemptions,
  });
  assert.deepEqual(
    caughtUp.findings.map((finding) => [finding.code, finding.id]),
    [
      ["parity_exemption_redundant", "tools/check-covered.mjs"],
      ["parity_exemption_redundant", "tools/check-named.mjs"],
    ],
  );
});

test("a rung the ladder runs and no step can cover is declared with its own reason", () => {
  const reading = parity({
    workflowText: "      - run: pnpm typecheck",
    exemptions: [{ id: "l1", reason: "rung", detail: "the ladder's own rung" }],
    members: members(),
  });
  assert.deepEqual(
    reading.ladderOnly.map((row) => [row.id, row.reason, row.position]),
    [["l1", "rung", 1]],
  );
  assert.equal(
    reading.findings.filter((finding) => finding.code === "ladder_member_uncovered").length,
    2,
    "the two gates are still named",
  );
});

test("a row for a member the ladder no longer runs is stale, and a row outside the vocabulary is unreasoned", () => {
  const stale = parity({
    workflowText: "      - run: node tools/check-covered.mjs\n      - run: node tools/check-named.mjs",
    exemptions: [{ id: "tools/check-gone.mjs", reason: "debt", detail: "measured elsewhere" }],
  });
  assert.deepEqual(
    stale.findings.map((finding) => [finding.code, finding.id]),
    [["parity_exemption_stale", "tools/check-gone.mjs"]],
  );

  const unreasoned = parity({
    workflowText: "      - run: node tools/check-named.mjs",
    exemptions: [{ id: "tools/check-covered.mjs", reason: "somebody-was-busy", detail: "measured elsewhere" }],
  });
  assert.deepEqual(
    unreasoned.findings.map((finding) => [finding.code, finding.id]),
    [["parity_exemption_unreasoned", "tools/check-covered.mjs:somebody-was-busy"]],
  );

  const undetailed = parity({
    workflowText: "      - run: node tools/check-named.mjs",
    exemptions: [{ id: "tools/check-covered.mjs", reason: "debt", detail: "  " }],
  });
  assert.deepEqual(
    undetailed.findings.map((finding) => [finding.code, finding.id]),
    [["parity_exemption_undetailed", "tools/check-covered.mjs"]],
  );
});

test("a `local-only` row lands in its own bucket, not among the declared debt", () => {
  const reading = parity({
    workflowText: "      - run: node tools/check-named.mjs",
    exemptions: [
      { id: "tools/check-covered.mjs", reason: "local-only", detail: "a dev server; a push has nothing to watch" },
    ],
  });
  assert.deepEqual(
    reading.localOnly.map((row) => [row.id, row.position]),
    [["tools/check-covered.mjs", 2]],
  );
  assert.deepEqual(reading.ladderOnly, []);
  assert.deepEqual(reading.findings, []);
});

test("the buckets partition the population: nothing is counted twice and nothing is lost", () => {
  const reading = parity({
    scripts: { "check:covered": "node tools/check-covered.mjs" },
    workflowText: "      - run: node tools/check-ci-coverage.mjs --run",
    exemptions: [{ id: "tools/check-named.mjs", reason: "debt", detail: "measured elsewhere" }],
    members: members().filter((member) => member.kind === "gate"),
  });
  const counted = buckets(reading);
  assert.equal(counted.inCi + counted.ladderOnly + counted.localOnly + counted.uncovered, reading.members.length);
  assert.deepEqual(counted, { inCi: 1, ladderOnly: 1, localOnly: 0, uncovered: 0 });
});

test("a ladder that resolves no member is blocked, not clean", () => {
  const root = fixtureTree({ scripts: {}, workflows: { "ci.yml": ["      - run: pnpm typecheck"] } });
  try {
    const reading = run(root, [], { exemptions: [], members: [] });
    assert.equal(reading.code, 2);
    assert.match(reading.err, /local_ci_parity_ladder_empty:no ladder member resolved/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workflow read that covers no file is blocked, not a clean diff", () => {
  const root = fixtureTree({
    scripts: { prelive: "node tools/prelive.mjs --no-game" },
    workflows: { "ci.yml": ["      # nothing runs here yet"] },
  });
  try {
    const reading = run(root, [], { exemptions: [] });
    assert.equal(reading.code, 2);
    assert.match(reading.err, /local_ci_parity_workflow_unread:no workflow step covers any file/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this repository's own ladder: every member is in CI or declared, and each row names why", () => {
  const reading = run(REPOSITORY_ROOT, ["--json"]);
  const report = JSON.parse(reading.out.slice(reading.out.lastIndexOf("\n{") + 1));
  assert.equal(reading.code, 0);
  assert.equal(report.status, "passed");
  assert.ok(report.examined >= 40, `examined=${report.examined}`);
  assert.equal(new Set(report.ladder).size, report.ladder.length);
  for (const row of [...report.ladderOnly, ...report.localOnly]) assert.match(row, /^[\w./-]+:[a-z-]+$/u);
  // The second direction is a reading, never a failure: CI covers root scripts the ladder does not name,
  // and the ladder's own verdict must not depend on their count.
  assert.ok(report.ciOnly.length > 0);
  assert.equal(report.ciOnly.includes("prelive"), false);
  // The 15 gates the ladder runs that nothing named are the reason this population is file-shaped.
  assert.ok(report.inCi.some((entry) => entry.startsWith("tools/check-stardew-observation-consumers.mjs:")));
});

test("the report a caller reads carries the ladder as its population, so the reading says what it examined", () => {
  const reading = parity({
    workflowText: "      - run: node tools/check-covered.mjs\n      - run: node tools/check-named.mjs",
    members: members().filter((member) => member.kind === "gate"),
  });
  const report = buildReport(reading);
  assert.equal(report.population, 2);
  assert.equal(report.examined, 2);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.ladder, ["tools/check-covered.mjs", "tools/check-named.mjs"]);
});
