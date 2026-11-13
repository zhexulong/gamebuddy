import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  auditRegistry,
  checkRegistry,
  derivePopulation,
  EXEMPTIONS,
  POPULATION_SCAN,
  preludeGatePaths,
  REASON_CLASSES,
  readHeadScripts,
  readScripts,
  renderRegistry,
  scriptTreeDisagreements,
  verifyRunsIn,
} from "./check-prelive-gate-registry.mjs";
import { PRELUDE_RUNGS } from "./prelive.mjs";

/**
 * Falsifiers for the register. Each case is one way the claim "every gate either runs in prelive or says where else
 * it runs" can be false, and the assertion is on the FILE the finding names - a register that reports a count without
 * naming the gate is the silence it exists to remove.
 *
 * red-proof: inject  with the `elsewhere`-claims-must-run-in-CI check disabled in the gate, this suite failed on
 *   "an elsewhere claim that the CI coverage gate says runs nowhere is red, quoting that gate's reason"
 * red-proof: inject  deleting the `runsIn` shape guard -> the register threw `TypeError: Cannot read properties of
 *   undefined (reading 'startsWith')` on an exemption with a reason and no `runsIn`, so the case failed on a crash
 *   rather than on the named finding
 * red-proof: inject  deleting the `reason` shape guard -> `TypeError: Cannot read properties of undefined (reading
 *   'split')` on an entry with no reason
 * red-proof: inject  `verifyRunsIn` ignoring the `HEAD` script table -> two cases failed with
 *   `exempt_runs_in_unknown_script` where `[]` was expected
 * red-proof: inject  `scriptTreeDisagreements` comparing the worktree with itself -> `[]` where `["check:b"]` was
 *   expected, so the disagreement that decides an exemption was never printed
 * red-proof: inject  `readHeadScripts` parsing the file on disk instead of the commit -> `{}` where the commit's
 *   script table was expected
 * red-proof: inject  deleting the first half of a `falsifier:` claim (that the named script runs the gate's suite) ->
 *   one case read `undefined` where `exempt_runs_in_script_does_not_name_the_falsifier` was expected, so a script naming
 *   any suite counted as reachability
 * red-proof: inject  deleting the second half (that the suite runs the gate) -> one case read `undefined` where
 *   `exempt_falsifier_does_not_run_the_gate` was expected, so a suite that never mentions its gate counted as a home
 */

const CLEAN = () => ({
  population: ["tools/check-a.mjs", "tools/check-b.mjs"],
  wired: new Map([["tools/check-a.mjs", "l0"]]),
  exemptions: [
    {
      path: "tools/check-b.mjs",
      reason: "elsewhere: static scan, runs on every push in the CI gates job",
      runsIn: "pnpm check:b",
    },
  ],
  scripts: { "check:b": "node tools/check-b.mjs" },
  workflow: () => "",
  ciCoverage: { runs: new Set(["check:b"]), registered: new Map() },
});

const codesFor = (result) => result.findings.map((finding) => `${finding.code}:${finding.path}`).sort();

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A git command in a fixture repository, insulated from this machine's own git configuration. */
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-gitconfig") },
  });
}

/** Write files into a root, so a case can change what the worktree holds without changing what `HEAD` holds. */
function writeTree(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
}

/** A throwaway repository: the two `package.json` trees only differ for real when there is a commit to differ from. */
function makeRepository(files) {
  const root = mkdtempSync(join(tmpdir(), "prelive-gate-registry-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  writeTree(root, files);
  return root;
}

function commit(root, paths) {
  git(root, ["add", "--", ...paths]);
  git(root, [
    "-c",
    "user.name=prelive-gate-registry-gate",
    "-c",
    "user.email=prelive-gate-registry@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    "planted",
  ]);
}

test("a gate neither wired nor exempt is reported as forgotten, and the file is named", () => {
  const result = checkRegistry({
    ...CLEAN(),
    population: ["tools/check-a.mjs", "tools/check-b.mjs", "tools/check-c.mjs"],
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(codesFor(result), ["gate_forgotten:tools/check-c.mjs"]);
});

test("an exemption for a gate prelive now runs is stale, and the rung that runs it is named", () => {
  const base = CLEAN();
  const result = checkRegistry({
    ...base,
    wired: new Map([...base.wired, ["tools/check-b.mjs", "l0b"]]),
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(codesFor(result), ["exempt_but_wired:tools/check-b.mjs"]);
  assert.equal(result.findings[0].detail, "prelive l0b runs it");
});

test("an exemption for a path that is not a gate is stale, so the table cannot keep dead rows", () => {
  const base = CLEAN();
  const result = checkRegistry({
    ...base,
    exemptions: [
      ...base.exemptions,
      { path: "tools/check-gone.mjs", reason: base.exemptions[0].reason, runsIn: "pnpm check:b" },
    ],
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(codesFor(result), ["exempt_not_a_gate:tools/check-gone.mjs"]);
});

test("a reason with no declared class, or too short to name anything, is not an exemption", () => {
  const base = CLEAN();
  const unknownClass = checkRegistry({
    ...base,
    exemptions: [{ path: "tools/check-b.mjs", reason: "because it is slow", runsIn: "pnpm check:b" }],
  });
  assert.deepEqual(codesFor(unknownClass), ["exempt_unreasoned:tools/check-b.mjs"]);
  assert.match(unknownClass.findings[0].detail, /unknown class "because it is slow"/u);
  const tooShort = checkRegistry({
    ...base,
    exemptions: [{ path: "tools/check-b.mjs", reason: "elsewhere: slow", runsIn: "pnpm check:b" }],
  });
  assert.deepEqual(codesFor(tooShort), ["exempt_unreasoned:tools/check-b.mjs"]);
  assert.match(tooShort.findings[0].detail, /too short/u);
});

test("every declared reason class has a meaning, and every exemption uses one", () => {
  for (const entry of EXEMPTIONS) {
    const className = entry.reason.split(":")[0].trim();
    assert.ok(Object.hasOwn(REASON_CLASSES, className), `${entry.path} uses undeclared class ${className}`);
    assert.ok(REASON_CLASSES[className].length > 40, `${className} must say why, not just name a bucket`);
  }
});

test("a runsIn that names no script, or a script that does not name the gate, is dangling", () => {
  const base = CLEAN();
  const unknownScript = checkRegistry({
    ...base,
    exemptions: [{ path: "tools/check-b.mjs", reason: base.exemptions[0].reason, runsIn: "pnpm check:missing" }],
    ciCoverage: { runs: new Set(["check:missing"]), registered: new Map() },
  });
  assert.deepEqual(codesFor(unknownScript), ["exempt_runs_in_unknown_script:tools/check-b.mjs"]);
  const otherGate = checkRegistry({
    ...base,
    scripts: { "check:b": "node tools/check-somewhere-else.mjs" },
  });
  assert.deepEqual(codesFor(otherGate), ["exempt_runs_in_script_does_not_name_the_gate:tools/check-b.mjs"]);
  assert.match(otherGate.findings[0].detail, /node tools\/check-somewhere-else\.mjs/u);
});

test("a script only HEAD has is not reported as an unknown script", () => {
  const base = CLEAN();
  const headOnly = checkRegistry({ ...base, scripts: {}, headScripts: base.scripts });
  assert.deepEqual(codesFor(headOnly), []);
  assert.equal(headOnly.status, "passed");
  // Nor is a script only the worktree has: the register asks whether anything runs the gate, and a script one of the
  // two trees holds is a script somebody wrote to run it.
  const worktreeOnly = checkRegistry({ ...base, scripts: base.scripts, headScripts: {} });
  assert.deepEqual(codesFor(worktreeOnly), []);
});

test("a package.json tree that disagrees with HEAD is read, printed, and neither reading decides alone", () => {
  const base = CLEAN();
  const root = makeRepository({ "package.json": JSON.stringify({ scripts: base.scripts }) });
  commit(root, ["package.json"]);
  // The shape a private index produced: `HEAD` has the script, this file on disk does not.
  writeTree(root, { "package.json": JSON.stringify({ scripts: {} }) });
  const worktree = readScripts({ root });
  const head = readHeadScripts({ root });
  assert.deepEqual(worktree, {});
  assert.deepEqual(head, base.scripts);
  assert.deepEqual(scriptTreeDisagreements(worktree, head), ["check:b"]);
  const result = checkRegistry({ ...base, scripts: worktree, headScripts: head });
  assert.deepEqual(codesFor(result), []);
  assert.equal(result.scriptTrees.head, 1);
  assert.deepEqual(result.scriptTrees.disagreeing, ["check:b"]);
  assert.ok(
    renderRegistry(result).lines.includes("prelive_gate_registry: package_json_trees_disagree=1 check:b"),
    "a disagreement between the two trees is printed, not left to decide a verdict silently",
  );
});

test("a HEAD git cannot read is named in the output instead of silently reading the worktree", () => {
  const base = CLEAN();
  const root = makeRepository({ "package.json": JSON.stringify({ scripts: {} }) });
  assert.equal(readHeadScripts({ root }), null, "a repository with no commit has no HEAD:package.json");
  const result = checkRegistry({ ...base, scripts: base.scripts, headScripts: null });
  assert.deepEqual(codesFor(result), []);
  const rendered = renderRegistry(result);
  assert.ok(
    rendered.lines.includes("prelive_gate_registry: scripts_read=worktree-only; git cannot read HEAD:package.json"),
    "which tree was read is printed",
  );
});

test("a script neither tree has, or one that names another file in both, is still red", () => {
  const base = CLEAN();
  const neither = checkRegistry({ ...base, scripts: {}, headScripts: {} });
  assert.deepEqual(codesFor(neither), ["exempt_runs_in_unknown_script:tools/check-b.mjs"]);
  assert.match(neither.findings[0].detail, /neither the worktree nor HEAD/u);
  const elsewhere = checkRegistry({
    ...base,
    scripts: { "check:b": "node tools/check-other.mjs" },
    headScripts: { "check:b": "node tools/check-other.mjs" },
  });
  assert.deepEqual(codesFor(elsewhere), ["exempt_runs_in_script_does_not_name_the_gate:tools/check-b.mjs"]);
});

test("a ci: claim is checked against the workflow file it names", () => {
  const base = CLEAN();
  const entry = { path: "tools/check-b.mjs", reason: base.exemptions[0].reason, runsIn: "ci:.github/workflows/ci.yml" };
  const missingFile = checkRegistry({ ...base, exemptions: [entry], workflow: () => null });
  assert.deepEqual(codesFor(missingFile), ["exempt_runs_in_unknown_workflow:tools/check-b.mjs"]);
  const notNamed = checkRegistry({ ...base, exemptions: [entry], workflow: () => "run: pnpm test" });
  assert.deepEqual(codesFor(notNamed), ["exempt_runs_in_workflow_does_not_name_the_gate:tools/check-b.mjs"]);
  const named = checkRegistry({ ...base, exemptions: [entry], workflow: () => "run: node tools/check-b.mjs" });
  assert.equal(named.status, "passed");
});

test("an elsewhere claim that the CI coverage gate says runs nowhere is red, quoting that gate's reason", () => {
  const base = CLEAN();
  const result = checkRegistry({
    ...base,
    ciCoverage: {
      runs: new Set(),
      registered: new Map([["check:b", { reason: "debt", detail: "measured red at HEAD" }]]),
    },
  });
  assert.deepEqual(codesFor(result), ["exempt_elsewhere_not_in_ci:tools/check-b.mjs"]);
  assert.match(result.findings[0].detail, /registers check:b as debt: measured red at HEAD/u);
});

test("an exemption with no runsIn is a named finding, not a crash", () => {
  const base = CLEAN();
  const reasonOnly = { path: "tools/check-b.mjs", reason: base.exemptions[0].reason };
  const result = checkRegistry({ ...base, exemptions: [reasonOnly] });
  assert.equal(result.status, "failed");
  assert.deepEqual(codesFor(result), ["exempt_runs_in_missing:tools/check-b.mjs"]);
  assert.match(result.findings[0].detail, /runsIn/u);
  // The crash this case was written against reached `entry.runsIn.startsWith` inside the elsewhere assertion, so the
  // reading that matters is the one an operator sees: a named finding and a non-zero status, not a stack trace.
  const rendered = renderRegistry(result);
  assert.equal(rendered.exitCode, 1);
  assert.match(rendered.lines.join("\n"), /prelive_gate_registry_exempt_runs_in_missing: tools\/check-b\.mjs/u);
  assert.equal(rendered.lines.at(-1), "prelive_gate_registry: failed (1 finding(s))");
});

test("an exemption with no reason is a named finding, not a crash", () => {
  const base = CLEAN();
  const result = checkRegistry({ ...base, exemptions: [{ path: "tools/check-b.mjs", runsIn: "pnpm check:b" }] });
  assert.deepEqual(codesFor(result), ["exempt_unreasoned:tools/check-b.mjs"]);
  assert.match(result.findings[0].detail, /no reason/u);
  assert.equal(renderRegistry(result).exitCode, 1);
});

test("a gate the ladder names but the population does not contain is red, not silently wired", () => {
  const base = CLEAN();
  const result = checkRegistry({ ...base, wired: new Map([...base.wired, ["tools/check-nope.mjs", "l0"]]) });
  assert.deepEqual(codesFor(result), ["wired_not_a_gate:tools/check-nope.mjs"]);
});

test("verifyRunsIn reads on-demand as a claim with no scheduled home, not as a pass", () => {
  assert.equal(verifyRunsIn({ path: "tools/x.mjs", runsIn: "on-demand" }, { scripts: {}, workflow: () => "" }), null);
  assert.deepEqual(verifyRunsIn({ path: "tools/x.mjs", runsIn: "whenever" }, { scripts: {}, workflow: () => "" }), {
    code: "exempt_runs_in_unrecognised",
    detail: "whenever",
  });
});

test("the derivation excludes both kinds of falsifier and includes the tree-guarding stardew tests", () => {
  const population = derivePopulation({
    list: (dir) =>
      dir === "tools"
        ? ["check-a.mjs", "check-a.test.mjs", "audit-b.mjs", "audit-b.test.mjs", "check-c.mutation.mjs", "read-x.mjs"]
        : ["action-source-projection-drift.test.mjs", "static-verifier-contract.test.mjs", "portfolio.test.mjs"],
  });
  // A `.mutation.mjs` is a falsifier like a `.test.mjs`: the tree carried one (`check-stardew-loop-closure.mutation.mjs`)
  // with an exemption whose own reason read "a mutation driver, not a gate", and `tools/check-gate-population-agreement.mjs`
  // is what now holds this scan to the census's `isGateFile` rule.
  assert.deepEqual(population, [
    "tools/audit-b.mjs",
    "tools/check-a.mjs",
    "integrations/stardew/action-development/tests/action-source-projection-drift.test.mjs",
  ]);
});

test("the scans are two directories and the stardew one is the drift/reconciliation convention", () => {
  assert.deepEqual(
    POPULATION_SCAN.map((scan) => scan.dir),
    ["tools", "integrations/stardew/action-development/tests"],
  );
});

test("the real tree: the wired set is exactly what the ladder declares, and no gate is forgotten", () => {
  const population = derivePopulation();
  const wired = preludeGatePaths();
  const result = auditRegistry();
  assert.deepEqual(result.findings, [], "every gate in the tree must be wired or say where it runs");
  assert.deepEqual(
    [...wired.keys()].filter((path) => !population.includes(path)),
    [],
    "a rung may only name a gate that is in the population",
  );
  assert.ok(result.total > 90, `the population is the tree's gates, not a sample: ${result.total}`);
  assert.equal(result.wired, wired.size);
  assert.equal(result.wired + result.exempt, result.total);
  assert.equal([...PRELUDE_RUNGS].length, 2);
});

test("the real tree: every withdrawn gate names the input or the measurement that keeps it out of prelive", () => {
  const result = auditRegistry();
  assert.equal(result.status, "passed");
  assert.ok(result.exempt > 60, `most of the tree's gates run elsewhere; measured ${result.exempt}`);
  assert.ok(
    result.onDemand.length < result.exempt,
    "on-demand is the exception; a table where most gates have no scheduled home means the register is not a register",
  );
  for (const path of result.onDemand)
    assert.ok(
      EXEMPTIONS.find((entry) => entry.path === path)?.reason.length > 40,
      `${path} has no scheduled home and must still say why`,
    );
});

// `falsifier:<script>` is the claim "an automated entry point reaches this gate through its falsifier suite", and it has
// two halves because either one alone can be true of a gate nothing runs: a `test:` script that names the suite, and a
// suite that actually runs the gate. Measured 2026-11-13: eight on-demand rows already had both halves and were being
// reported as having no scheduled home at all.
test("a falsifier claim holds only when the script names the suite and the suite runs the gate", () => {
  const gateSource = (file) => (file.endsWith("check-b.test.mjs") ? 'spawnSync(node, ["tools/check-b.mjs"])' : null);
  const reading = { workflow: () => "", gateSource };
  assert.equal(
    verifyRunsIn(
      { path: "tools/check-b.mjs", runsIn: "falsifier:test:b" },
      { ...reading, scripts: { "test:b": "node --test tools/check-b.test.mjs" } },
    ),
    null,
  );
  // The script names a suite that never runs the gate: the file exists and says nothing about it.
  assert.equal(
    verifyRunsIn(
      { path: "tools/check-b.mjs", runsIn: "falsifier:test:b" },
      { ...reading, scripts: { "test:b": "node --test tools/check-other.test.mjs" } },
    ).code,
    "exempt_runs_in_script_does_not_name_the_falsifier",
  );
  assert.equal(
    verifyRunsIn(
      { path: "tools/check-a.mjs", runsIn: "falsifier:test:b" },
      {
        ...reading,
        scripts: { "test:b": "node --test tools/check-a.test.mjs" },
        gateSource: (file) => (file.endsWith("check-a.test.mjs") ? "// no gate here" : null),
      },
    ).code,
    "exempt_falsifier_does_not_run_the_gate",
  );
  assert.equal(
    verifyRunsIn({ path: "tools/check-b.mjs", runsIn: "falsifier:test:missing" }, { ...reading, scripts: {} }).code,
    "exempt_runs_in_unknown_script",
  );
});
