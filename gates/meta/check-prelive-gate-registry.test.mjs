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
  inAPopulationScan,
  POPULATION_SCAN,
  preludeGatePaths,
  REASON_CLASSES,
  readHeadScripts,
  readScripts,
  renderRegistry,
  scriptTreeDisagreements,
  STARDEW_TESTS,
  UNSCANNED_GATES,
  verifyRunsIn,
} from "./check-prelive-gate-registry.mjs";
import { GATE_DIRECTORIES } from "../registry.mjs";
import { PRELUDE_RUNGS } from "../../tools/prelive.mjs";

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

test("every declared reason class has a meaning, every exemption uses one, and no class sits unused", () => {
  for (const entry of [...EXEMPTIONS, ...UNSCANNED_GATES]) {
    const className = entry.reason.split(":")[0].trim();
    assert.ok(Object.hasOwn(REASON_CLASSES, className), `${entry.path} uses undeclared class ${className}`);
    assert.ok(REASON_CLASSES[className].length > 40, `${className} must say why, not just name a bucket`);
  }
  // A class no row can use is a mechanism that exists and cannot be used - measured 2026-11-15: `suite` was declared and
  // unusable, because `verifyRunsIn` looked for the gate's path in a command that names the gate's falsifier, so a lane
  // that reached for the register's own vocabulary got a second red finding. A declared class is a claim that some row
  // can state it, and this is the line where that claim is held.
  const used = new Set([...EXEMPTIONS, ...UNSCANNED_GATES].map((entry) => entry.reason.split(":")[0].trim()));
  assert.deepEqual(
    Object.keys(REASON_CLASSES).filter((className) => !used.has(className)),
    [],
    "a reason class no row uses is a class nobody can use",
  );
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

test("a row with no scheduled home states what would end it, and a row with a home needs none", () => {
  const base = {
    population: ["tools/check-orphan.mjs"],
    wired: new Map(),
    scripts: {},
    workflow: () => "",
    workflowText: "",
    ciCoverage: { runs: new Set(), registered: new Map() },
  };
  const row = {
    path: "tools/check-orphan.mjs",
    reason: "arguments: takes a run directory, so there is nothing to examine before a run has happened",
  };
  const missing = checkRegistry({ ...base, exemptions: [{ ...row, runsIn: "on-demand" }] });
  assert.deepEqual(codesFor(missing), ["exempt_expiry_unreasoned:tools/check-orphan.mjs"]);
  assert.match(missing.findings[0].detail, /carries no `expires`/u);
  // FALSIFIER: a word where a condition belongs is not an expiry, the same way a short reason is not a reason.
  const short = checkRegistry({ ...base, exemptions: [{ ...row, runsIn: "on-demand", expires: "someday" }] });
  assert.deepEqual(codesFor(short), ["exempt_expiry_unreasoned:tools/check-orphan.mjs"]);
  assert.match(short.findings[0].detail, /too short/u);
  const stated = checkRegistry({
    ...base,
    exemptions: [
      {
        ...row,
        runsIn: "on-demand",
        expires: "expires when the ladder writes the run directory itself, so a rung has one to read",
      },
    ],
  });
  assert.equal(stated.status, "passed");
  // FALSIFIER: a row that names where it runs expires mechanically - the script has to keep naming the gate - so it is
  // not asked for a second date. Requiring one on every row would make nine of ten rows state a condition nothing reads.
  const homed = checkRegistry({
    ...base,
    scripts: { "check:orphan": "node tools/check-orphan.mjs" },
    ciCoverage: { runs: new Set(["check:orphan"]), registered: new Map() },
    exemptions: [
      {
        path: "tools/check-orphan.mjs",
        reason: "elsewhere: static scan of the tree, runs on every push in the CI gates job",
        runsIn: "pnpm check:orphan",
      },
    ],
  });
  assert.deepEqual(codesFor(homed), []);
});

test("a suite: row is wired by the suite's own case, and a suite that never names the gate is red", () => {
  const base = {
    population: ["tools/check-suite.mjs"],
    wired: new Map(),
    scripts: { "test:suite": "node --test tools/check-suite.test.mjs" },
    workflow: () => "",
    ciCoverage: { runs: new Set(), registered: new Map() },
  };
  const entry = {
    path: "tools/check-suite.mjs",
    reason:
      "suite: its rule is exercised by its own falsifier inside the tool-test corpus, and no script runs the gate",
    runsIn: "suite:test:suite",
  };
  // The falsifier's command names `<gate>.test.mjs`, which does not contain `<gate>.mjs`: the test file the suite runs is
  // read instead, and its import is the case this row claims.
  const naming = checkRegistry({ ...base, exemptions: [entry], read: () => '} from "./check-suite.mjs";' });
  assert.equal(naming.status, "passed");
  // FALSIFIER: a suite whose test file names another gate is not this gate's case, so accepting any test file - the
  // loosening this rule could rot into - is red.
  const other = checkRegistry({ ...base, exemptions: [entry], read: () => '} from "./check-other.mjs";' });
  assert.deepEqual(codesFor(other), ["exempt_runs_in_script_does_not_name_the_gate:tools/check-suite.mjs"]);
  // FALSIFIER: a test file nobody can read is not a case either, so an unreadable tree cannot pass on faith.
  const unreadable = checkRegistry({ ...base, exemptions: [entry], read: () => null });
  assert.deepEqual(codesFor(unreadable), ["exempt_runs_in_script_does_not_name_the_gate:tools/check-suite.mjs"]);
});

test("an unrun row states that nothing runs the gate, and reddens the moment anything names it", () => {
  const entry = {
    path: "tools/check-orphan.mjs",
    reason: "unrun: no script names it or its falsifier, so its verdict on the real tree has never been produced",
    runsIn: "on-demand",
    expires:
      "expires when anything names the file - a script, a suite, a hook or a workflow step - and the row reds there",
  };
  const base = {
    population: ["tools/check-orphan.mjs"],
    wired: new Map(),
    scripts: {},
    workflow: () => "",
    workflowText: "run: pnpm test",
    ciCoverage: { runs: new Set(), registered: new Map() },
  };
  assert.equal(checkRegistry({ ...base, exemptions: [entry] }).status, "passed");
  const byScript = checkRegistry({
    ...base,
    exemptions: [entry],
    scripts: { "check:orphan": "node tools/check-orphan.mjs" },
  });
  assert.deepEqual(codesFor(byScript), ["exempt_unrun_but_named:tools/check-orphan.mjs"]);
  assert.match(byScript.findings[0].detail, /worktree check:orphan/u);
  // The falsifier counts as a run of the rule: a `test:` script that runs it means the rule is measured somewhere.
  const byFalsifier = checkRegistry({
    ...base,
    exemptions: [entry],
    scripts: { "test:orphan": "node --test tools/check-orphan.test.mjs" },
  });
  assert.deepEqual(codesFor(byFalsifier), ["exempt_unrun_but_named:tools/check-orphan.mjs"]);
  const byWorkflow = checkRegistry({
    ...base,
    exemptions: [entry],
    workflowText: "      - run: node tools/check-orphan.mjs",
  });
  assert.deepEqual(codesFor(byWorkflow), ["exempt_unrun_but_named:tools/check-orphan.mjs"]);
  assert.match(byWorkflow.findings[0].detail, /a workflow step names it/u);
  // With no workflow text the claim is unchecked, which is printed as unverified rather than passed quietly.
  const unread = checkRegistry({ ...base, exemptions: [entry], workflowText: null });
  assert.deepEqual(codesFor(unread), []);
  assert.equal(unread.unverified.length, 1);
});

test("a hook: row is checked against the hook file that spawns the gate", () => {
  const entry = {
    path: "tools/scripts/check-hooked.mjs",
    reason: "fixup: reads git state and runs only from the pre-commit hook, so no pnpm script names it at all",
    runsIn: "hook:tools/scripts/pre-commit.mjs",
  };
  const base = {
    population: [],
    unscanned: ["tools/scripts/check-hooked.mjs"],
    wired: new Map(),
    scripts: {},
    workflow: () => "",
    ciCoverage: { runs: new Set(), registered: new Map() },
  };
  const naming = checkRegistry({
    ...base,
    exemptions: [entry],
    read: () => 'execFileSync("node", ["tools/scripts/check-hooked.mjs"]);',
  });
  assert.equal(naming.status, "passed");
  const other = checkRegistry({ ...base, exemptions: [entry], read: () => "process.exitCode = 0;" });
  assert.deepEqual(codesFor(other), ["exempt_runs_in_hook_does_not_name_the_gate:tools/scripts/check-hooked.mjs"]);
  // A hook file that is gone, and a declared gate that is gone, are both named: neither is a pass.
  const missing = checkRegistry({ ...base, exemptions: [entry], read: () => null });
  assert.deepEqual(codesFor(missing), [
    "exempt_runs_in_unknown_hook:tools/scripts/check-hooked.mjs",
    "unscanned_gate_missing:tools/scripts/check-hooked.mjs",
  ]);
});

test("a declared unscanned gate is a population member, and the row retires once a scan reaches it", () => {
  const entry = {
    path: "tools/scripts/check-hook-gate.mjs",
    reason: "fixup: runs from a git hook, in a directory no population scan reaches, so nothing derives it at all",
    runsIn: "on-demand",
    expires: "expires when the hook's directory becomes a published gate directory, or the hook stops running it",
  };
  const base = {
    population: [],
    wired: new Map(),
    scripts: {},
    workflow: () => "",
    ciCoverage: { runs: new Set(), registered: new Map() },
  };
  const declared = checkRegistry({
    ...base,
    unscanned: [entry.path],
    exemptions: [entry],
    read: () => "#!/usr/bin/env node",
  });
  assert.equal(declared.status, "passed");
  assert.equal(declared.total, 1, "a declared gate is a member of the population, not a footnote beside it");
  assert.equal(declared.exempt, 1);
  assert.deepEqual(
    declared.unscanned,
    [entry.path],
    "and it is printed as outside the scan, not counted among the found",
  );
  // FALSIFIER: the row is a claim that no scan reaches the path, so a path a scan does reach makes it stale.
  const scanned = checkRegistry({
    ...base,
    population: ["tools/check-a.mjs"],
    unscanned: ["tools/check-a.mjs"],
    exemptions: [{ path: "tools/check-a.mjs", reason: entry.reason, runsIn: "on-demand", expires: entry.expires }],
    read: () => "export {};",
  });
  assert.deepEqual(codesFor(scanned), ["unscanned_but_scanned:tools/check-a.mjs"]);
  assert.match(scanned.findings[0].detail, /delete the row from UNSCANNED_GATES/u);
});

test("the derivation excludes both kinds of falsifier and includes the tree-guarding stardew tests", () => {
  const population = derivePopulation({
    list: (dir) =>
      dir === STARDEW_TESTS
        ? ["action-source-projection-drift.test.mjs", "static-verifier-contract.test.mjs", "portfolio.test.mjs"]
        : dir === "tools"
          ? ["check-a.mjs", "check-a.test.mjs", "audit-b.mjs", "audit-b.test.mjs", "check-c.mutation.mjs", "read-x.mjs"]
          : ["check-filed.mjs", "check-filed.test.mjs"],
  });
  // A `.mutation.mjs` is a falsifier like a `.test.mjs`: the tree carried one (`check-stardew-loop-closure.mutation.mjs`)
  // with an exemption whose own reason read "a mutation driver, not a gate", and `tools/check-gate-population-agreement.mjs`
  // is what now holds this scan to the census's `isGateFile` rule.
  assert.deepEqual(
    population.filter((member) => /^tools\/[^/]+\.mjs$/u.test(member)),
    ["tools/audit-b.mjs", "tools/check-a.mjs"],
  );
  assert.deepEqual(
    population.filter((member) => member.startsWith(STARDEW_TESTS)),
    ["integrations/stardew/action-development/tests/action-source-projection-drift.test.mjs"],
  );
  // The domain directories contribute too, because they are scans - and a falsifier beside a sorted gate is still a
  // falsifier, so only `check-filed.mjs` comes through from each of them.
  assert.deepEqual(
    population.filter((member) => member.startsWith("gates/")),
    [
      "gates/product/check-filed.mjs",
      "gates/data/check-filed.mjs",
      "gates/arch/check-filed.mjs",
      "gates/stardew/check-filed.mjs",
      "gates/meta/check-filed.mjs",
    ],
  );
});

test("the gate scans are the registry's directories, so a domain move needs no edit here", () => {
  // Not a hand-written list: every directory a gate may live in is scanned by the registry's name rule. Written out,
  // this was `{ dir: "tools" }` and filing 14 gates under `gates/meta/` took the register from 152 members to 138
  // while the gate still passed.
  const gateScans = POPULATION_SCAN.filter((scan) => scan.dir !== STARDEW_TESTS).map((scan) => scan.dir);
  assert.deepEqual(gateScans, [...GATE_DIRECTORIES]);
  assert.deepEqual(POPULATION_SCAN.at(-1).dir, STARDEW_TESTS);
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
  // The declaration is a claim that no scan reaches these paths, and the derived and declared halves must agree on it.
  assert.ok(result.unscanned.length > 0, "the gate files no scan reaches are declared here, not silently absent");
  assert.deepEqual(
    result.unscanned.filter((path) => inAPopulationScan(path)),
    [],
    "a path declared outside the scan is one a population scan does not reach",
  );
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
      [...EXEMPTIONS, ...UNSCANNED_GATES].find((entry) => entry.path === path)?.reason.length > 40,
      `${path} has no scheduled home and must still say why`,
    );
  // A row with no scheduled home is not re-checked by anything, so it also states the condition under which it dies.
  // The rows that DO name a home expire mechanically instead: the script, suite, hook or workflow must keep naming the
  // gate or the row reds, which is why they are not asked for a second, unverifiable date.
  for (const path of result.onDemand)
    assert.ok(
      [...EXEMPTIONS, ...UNSCANNED_GATES].find((entry) => entry.path === path)?.expires.length > 40,
      `${path} has no scheduled home and must also say what would end it`,
    );
});
