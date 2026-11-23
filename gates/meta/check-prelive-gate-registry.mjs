#!/usr/bin/env node
/**
 * The prelive gate register: every gate in this tree either runs in the ladder, or names where else it runs.
 *
 * WHY. `tools/prelive.mjs` L0 ran a hand-picked subset of the tree's gates. A gate outside that subset was not
 * exempted, it was invisible: the projection producers and a seam's stale method verdict both sat behind gates that
 * nothing ran before a live run, and both were found by a live run. A hand-picked list can only name what its author
 * remembered, and it fails open the moment a gate is added - so this gate derives the population and makes the
 * omission a failure instead of a silence.
 *
 * POPULATION (derived from the filesystem on every run; `population=NN` is printed):
 *   1. `tools/check-*.mjs` and `tools/audit-*.mjs`, excluding `*.test.mjs`. A gate is a standalone command; a
 *      `check-x.test.mjs` is that gate's falsifier suite, and its population is owned by
 *      `tools/run-tool-test-corpus.mjs`, which derives the `test:*` scripts out of package.json and that CI runs. Two
 *      registers for one population would be two authorities for it.
 *   2. `integrations/stardew/action-development/tests/*-drift.test.mjs` and `*-reconciliation.test.mjs`. The naming
 *      convention is the derivation: `-drift` and `-reconciliation` are the tests that recompute a checked-in authority
 *      and compare, so they guard the tree rather than a unit. A tree-guarding test named otherwise stays out of scope,
 *      and this line is where that limit is stated rather than hidden.
 *
 * WIRED is not parsed out of `tools/prelive.mjs` as text and not restated here: it is IMPORTED from the ladder's own
 * `PRELUDE_RUNGS` (declared in `tools/prelive-rungs.mjs`, re-exported by the ladder module). The ladder's own declaration
 * is the authority for what the ladder runs, so a gate is wired the moment it is in a rung, and `wired N of M` cannot
 * disagree with what actually ran.
 *
 * EXEMPTIONS, and the `UNSCANNED_GATES` rows with them, are DATA in `prelive-register-tables.mjs` beside this file - a row
 * per gate the tree publishes, which is a table and not code (see that module's header for why the split exists). Every
 * other population member must appear there with `{ path, reason, runsIn }`:
 *   `reason` starts with a class from `REASON_CLASSES` and then says the concrete thing - which input prelive has not
 *            got, which argument the gate needs, which measurement is red at HEAD. A reason too short to name anything
 *            is a finding, not an exemption.
 *   `runsIn` is one of `pnpm <script>` (the script must exist and name this gate's path), `suite:<script>` (the script
 *            runs a `node --test` suite, and one of the test files it runs names this gate - the form a gate whose rule
 *            lives in its own falsifier needs), `hook:<file>` (a git hook runs the named file, and that file spawns this
 *            gate), `ci:<workflow>` (that workflow must name the path), or `on-demand` (no scheduled home at all -
 *            printed under `no_scheduled_home`, so the gates nothing runs are a line of output rather than an
 *            assumption).
 *            An `on-demand` row ALSO states `expires`: the condition under which the row dies. A row that names where
 *            it runs expires mechanically - the script, the suite, the hook or the workflow has to keep naming the gate
 *            or the row reds - so it needs no second date. A row with nothing to re-check would otherwise be a silence
 *            kept forever, so it has to say what would end it, which is the rule `tools/check-armed-destructive-actions.mjs`
 *            applies to its own exemption table.
 *            An `elsewhere` exemption additionally asserts that the script runs on every push, and that assertion is
 *            checked against `gates/meta/check-ci-coverage.mjs`, which owns the fact. An `unrun` exemption asserts the
 *            opposite - that nothing names the gate or its falsifier anywhere - and is checked against both
 *            `package.json` tables and every workflow, so the row expires the day someone wires the gate.
 *
 * GATES NO SCAN REACHES. `UNSCANNED_GATES` (in `prelive-register-tables.mjs`) declares the gate files whose directory is
 * not a published gate directory:
 * `tools/scripts/check-lockfile-freeze.mjs` (runs from the `pre-commit` hook) and
 * `tools/live-run/chat/check-post-history-instructions-live.mjs` (typed by hand). They are members of the population
 * the register judges - `outside_the_scan=` prints them apart from the scanned members - because a gate that no
 * derivation reaches is invisible to every census at once, which is the defect this register exists to prevent. Each
 * row is an exemption like any other, and `unscanned_but_scanned` retires it the moment a scan reaches the path.
 *
 * The table is validated in both directions, so it cannot rot into a list nobody looked at:
 *   - a population member neither wired nor exempt is `gate_forgotten`, and the message names the FILE;
 *   - an exemption for a gate that prelive now runs is `exempt_but_wired` - the reason has been overtaken;
 *   - an exemption for a path that is no longer a gate is `exempt_not_a_gate`;
 *   - a class outside `REASON_CLASSES`, or a reason too short to name anything, is `exempt_unreasoned`;
 *   - a `runsIn` that does not resolve to a script/workflow naming the gate is `exempt_runs_in_dangling`;
 *   - an `elsewhere` exemption whose script `gates/meta/check-ci-coverage.mjs` registers as running in no workflow is
 *     `exempt_elsewhere_not_in_ci`;
 *   - an entry carrying no `runsIn` at all is `exempt_runs_in_missing`. It used to reach the `elsewhere` assertion and
 *     crash there (`Cannot read properties of undefined (reading 'startsWith')`), and a gate that dies on a stack
 *     trace has named nothing - the same defect as a register that passes on an empty population. A missing `reason`
 *     is `exempt_unreasoned` for the same reason rather than a second crash;
 *   - an `on-demand` row with no `expires`, or one too short to name a condition, is `exempt_expiry_unreasoned`: a row
 *     that says nothing runs this gate and never says what would end that is the silence this register exists to
 *     remove, moved into the table;
 *   - an `unrun` entry that a script or a workflow does name is `exempt_unrun_but_named`: the row says nothing runs the
 *     gate, and something started to;
 *   - a declared unscanned gate that a population scan now reaches is `unscanned_but_scanned`, and one that is not on
 *     disk is `unscanned_gate_missing`.
 *
 * WHICH `package.json`. `runsIn` is resolved against the scripts `HEAD` has AND the scripts on disk: a script
 * committed through a private index is in `HEAD` and absent from the worktree copy, and reading only the worktree
 * called a gate that runs `exempt_runs_in_unknown_script` - a passing gate reported unreachable because of a stale
 * local file (measured 2026-11-09: `tools/check-preset-macros.mjs` on `check:preset-macros`). So the two trees are
 * read, a script either of them has is a script that runs, and the disagreement between them is printed
 * (`scripts_read=` / `package_json_trees_disagree=`) rather than left to decide a verdict silently.
 *
 * `wired N of M; exempt K` is the verdict line; `node gates/meta/check-prelive-gate-registry.mjs` exits 1 on any finding.
 *
 * red-proof: inject  with the `elsewhere`-claims-must-run-in-CI check disabled, the falsifier failed on
 *   "an elsewhere claim that the CI coverage gate says runs nowhere is red, quoting that gate's reason"
 * red-proof: inject  an exemption carrying a `reason` and no `runsIn` -> the register threw `TypeError: Cannot read
 *   properties of undefined (reading 'startsWith')` at its `elsewhere` assertion, naming no gate at all, instead of
 *   `exempt_runs_in_missing`
 * red-proof: inject  resolving `runsIn` against the worktree's script table alone -> `exempt_runs_in_unknown_script`
 *   for a script `HEAD` declares, i.e. a passing gate called unreachable because of a stale local file
 * red-proof: inject  reading `HEAD`'s script table from the file on disk -> `{}` where the commit's table was
 *   expected, and the disagreement between the two trees went unprinted
 * red-proof: inject  accepting a `suite:` row on the gate's own path alone, the rule the class was unusable under ->
 *   "a suite: row is wired by the suite's own case, and a suite that never names the gate is red" failed, and so did
 *   both real-tree cases: seven rows whose suite names `<gate>.test.mjs` clear nothing
 * red-proof: inject  never re-checking the `unrun` claim -> "an unrun row states that nothing runs the gate, and
 *   reddens the moment anything names it" failed on the script that names it
 * red-proof: inject  not recognising `hook:` at all -> "a hook: row is checked against the hook file that spawns the
 *   gate" failed with `exempt_runs_in_unrecognised`, and the real tree with the lockfile row unverifiable
 * red-proof: inject  never retiring an unscanned row -> "a declared unscanned gate is a population member, and the row
 *   retires once a scan reaches it" failed on the path a scan does reach
 * red-proof: inject  deleting the `expires` requirement -> "a row with no scheduled home states what would end it, and
 *   a row with a home needs none" failed on the real tree's on-demand rows, which carry no `expires` at all
 * red-proof: inject  requiring `expires` on EVERY row, not just the ones with no scheduled home -> the same case's
 *   homed row went red with `exempt_expiry_unreasoned` though its `pnpm` script re-checks it on every run
 * red-proof: inject  a reason class no row uses -> "every declared reason class has a meaning, every exemption uses one,
 *   and no class sits unused" named the class, which is the defect `suite` itself was
 */

export const gateDeclaration = {
  id: "check-prelive-gate-registry",
  domain: "meta",
  tier: "l2",
  kind: "ratchet",
};

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveCiCoverage } from "./check-ci-coverage.mjs";
import { isGateFile, GATE_DIRECTORIES } from "../registry.mjs";
import { PRELUDE_RUNGS } from "../../tools/prelive.mjs";
import { EXEMPTIONS, REASON_CLASSES, STARDEW_TESTS, UNSCANNED_GATES } from "./prelive-register-tables.mjs";

/**
 * The register's TABLES are DATA in `prelive-register-tables.mjs` beside this file: the tree-guarding-test directory,
 * the reason classes, the row per population member that does not run in prelive, and the gate files no scan reaches.
 * What the register JUDGES is the code below; what it judges AGAINST is a table, and a table that grows one row per
 * published gate cannot live in a file the complexity ratchet holds to a ceiling - measured 2026-11-23, this file was
 * 1702 lines against the 1700 `.mjs` ceiling, so a new gate's exemption row was refused by the ratchet rather than by
 * any reading of whether the gate was forgotten. Re-exported here so this module stays the register's one import path.
 */
export { EXEMPTIONS, REASON_CLASSES, STARDEW_TESTS, UNSCANNED_GATES };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_DIR = ".github/workflows";

/**
 * The derivation, as data: one entry per scan, each with what it includes and what it deliberately leaves out.
 *
 * The gate scans are `GATE_DIRECTORIES` - the registry's own list, IMPORTED rather than restated - so a domain that
 * files its gates in `gates/<domain>/` is scanned without this file learning a new directory, and a domain
 * directory that does not exist yet is skipped by `derivePopulation` rather than throwing. Before this, the list was
 * the single entry `{ dir: "tools" }`: measured on the `meta` pilot, filing 14 gates under `gates/meta/` took
 * this register from 152 members to 138 while the gate still passed.
 *
 * Each `include` is the registry's own name rule, not a regex restated here. A `.test.mjs` and a `.mutation.mjs` are the
 * gate's falsifiers, not gates - counting them asks the red-proof census for a proof of the proof.
 */
export const POPULATION_SCAN = Object.freeze([
  ...GATE_DIRECTORIES.map((dir) => ({ dir, include: (name) => isGateFile(`${dir}/${name}`) })),
  { dir: STARDEW_TESTS, include: (name) => /(?:-drift|-reconciliation)\.test\.mjs$/u.test(name) },
]);

/** The directory a repo-relative path is filed in, and its file name: the two halves a scan is asked about. */
const directoryOf = (path) =>
  String(path)
    .replace(/\\/gu, "/")
    .replace(/\/[^/]*$/u, "");
const basenameOf = (path) => String(path).replace(/\\/gu, "/").replace(/^.*\//u, "");

/** Does a scan reach this path? Asked of the scans themselves, so a published directory needs no edit in two places. */
export function inAPopulationScan(path) {
  const directory = directoryOf(path);
  const name = basenameOf(path);
  return POPULATION_SCAN.some((scan) => scan.dir === directory && scan.include(name));
}

/** `<dir>/<file>` for every population member, derived from `POPULATION_SCAN`. A declared directory the tree has not
 * got yet is an empty scan, not a crash: only `gates/meta/` exists while the other domains are still unfiled. */
export function derivePopulation({
  list = (dir) => (existsSync(resolve(ROOT, dir)) ? readdirSync(resolve(ROOT, dir)) : []),
} = {}) {
  const members = [];
  for (const scan of POPULATION_SCAN) {
    for (const name of list(scan.dir).sort()) if (scan.include(name)) members.push(`${scan.dir}/${name}`);
  }
  return members;
}

/** The gates each rung runs, from the ladder's own declaration: `Map<path, rungId>`. */
export function preludeGatePaths({ rungs = PRELUDE_RUNGS } = {}) {
  const paths = new Map();
  for (const rung of rungs) for (const gate of rung.gates) paths.set(gate, rung.id);
  return paths;
}

/**
 * Does `runsIn` actually lead to this gate? Every claim form is checked against the file it names, so an exemption
 * cannot outlive the script that stopped running it.
 *
 * A script is read from both `package.json` trees - `HEAD`'s and the worktree's - because a script either of them has
 * is a script that runs somewhere, and a worktree copy that has not caught up is not evidence about the commit.
 *
 * `suite:` and `hook:` are the two forms whose file does not name the gate by path:
 *   `suite:<script>`  the script runs `node --test` over test files, and the claim is that this gate's own case is in
 *                     one of them. A falsifier names `<gate>.test.mjs`, so the path is not a substring of the command;
 *                     the test files the command runs are read instead, and one of them has to name the gate. That is
 *                     the claim being checked - not "some suite exists", which any script with a test file would pass.
 *   `hook:<file>`     a git hook runs the named file, and the named file runs the gate. `core.hooksPath` in this
 *                     repository is `tools/git-hooks`, whose pre-commit hook runs `tools/scripts/pre-commit.mjs`; the
 *                     row names the file that spawns the gate, and that file's text has to name it.
 */
export function verifyRunsIn(entry, { scripts, headScripts = {}, workflow, read = readText }) {
  if (entry.runsIn === "on-demand") return null;
  const fromPnpm = /^pnpm (\S+)$/u.exec(entry.runsIn);
  const fromSuite = /^suite:(\S+)$/u.exec(entry.runsIn);
  if (fromPnpm !== null || fromSuite !== null) {
    const name = fromPnpm?.[1] ?? fromSuite?.[1];
    const head = headScripts ?? {};
    const commands = [scripts[name], head[name]].filter((command) => typeof command === "string");
    const readings = [
      typeof scripts[name] === "string" ? `worktree ${name} runs: ${scripts[name]}` : null,
      typeof head[name] === "string" ? `HEAD ${name} runs: ${head[name]}` : null,
    ].filter((reading) => reading !== null);
    if (readings.length === 0)
      return {
        code: "exempt_runs_in_unknown_script",
        detail: `${name} is in neither the worktree nor HEAD's package.json`,
      };
    if (readings.some((reading) => reading.includes(entry.path))) return null;
    if (fromSuite !== null)
      for (const file of commands.flatMap(testFilesOf))
        if ((read(file) ?? "").includes(basenameOf(entry.path))) return null;
    return { code: "exempt_runs_in_script_does_not_name_the_gate", detail: readings.join("; ") };
  }
  const fromHook = /^hook:(\S+)$/u.exec(entry.runsIn);
  if (fromHook !== null) {
    const text = read(fromHook[1]);
    if (text === null) return { code: "exempt_runs_in_unknown_hook", detail: fromHook[1] };
    if (!text.includes(entry.path)) return { code: "exempt_runs_in_hook_does_not_name_the_gate", detail: fromHook[1] };
    return null;
  }
  const fromWorkflow = /^ci:(\S+)$/u.exec(entry.runsIn);
  if (fromWorkflow !== null) {
    const text = workflow(fromWorkflow[1]);
    if (text === null) return { code: "exempt_runs_in_unknown_workflow", detail: fromWorkflow[1] };
    if (!text.includes(entry.path))
      return { code: "exempt_runs_in_workflow_does_not_name_the_gate", detail: fromWorkflow[1] };
    return null;
  }
  return { code: "exempt_runs_in_unrecognised", detail: entry.runsIn };
}

/** The test files a script command runs: the only tokens `node --test` can be given that name a case. */
function testFilesOf(command) {
  return command
    .split(/\s+/u)
    .map((token) => token.replace(/^["']|["']$/gu, ""))
    .filter((token) => /\.test\.(?:mjs|ts)$/u.test(token));
}

/** Reason classes that assert the gate runs on every push; that claim is checked against the CI coverage gate. */
const RUNS_ON_EVERY_PUSH = "elsewhere";

/** The class that says nothing runs the gate; the claim is checked the same way, in the opposite direction. */
const NOTHING_RUNS_IT = "unrun";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Does this text name the gate, or the falsifier that lives beside it?
 *
 * The stem is what a caller writes: `tools/check-x.mjs`, `tools/check-x.test.mjs` and `tools/check-x.mutation.mjs` are
 * one gate and its two falsifier shapes, so three spellings of "names this gate" would be three places to forget one.
 */
export function namesGate(text, path) {
  const stem = String(path).replace(/\.mjs$/u, "");
  return new RegExp(`${escapeRegExp(stem)}(?:\\.(?:test|mutation))?\\.mjs`, "u").test(text);
}

/** The scripts in these `package.json` tables whose command names the gate, as `worktree <name>` / `HEAD <name>`. */
function entriesNaming(path, tables) {
  return tables.flatMap((table, index) =>
    Object.entries(table ?? {})
      .filter(([, command]) => typeof command === "string" && namesGate(command, path))
      .map(([name]) => `${index === 0 ? "worktree" : "HEAD"} ${name}`),
  );
}

/**
 * The classes whose reason states a MEASUREMENT of this tree, and therefore goes stale in both directions.
 *
 * `debt` says "measured red, N findings", `report` says "it prints while exiting 0", `installed` says "the build output
 * does not match" - each is a reading taken on a day, and a reading nobody re-takes is how five of eight `debt` rows
 * ended up wrong both ways at once (three were green, and three understated their own debt by an order of magnitude).
 *
 * `environment` is deliberately NOT here: it states which input a checkout has not got, which is a property of the
 * checkout rather than a reading that drifts. `elsewhere` states where a gate runs (which `runsIn` and the CI coverage
 * gate verify mechanically), `arguments` what a caller must supply, `fixup`/`suite` where the work happens - none of
 * those is re-measurable, so stamping them would be ceremony rather than evidence.
 */
export const MEASURED_REASON_CLASSES = Object.freeze(["debt", "report", "installed"]);

/** ` · measured <reading> at <sha>`: the reading a reason was taken from, and the revision it was true at. */
const MEASUREMENT_STAMP = / · measured (.+?) at ([0-9a-f]{7,40})$/u;

/**
 * How many release tags may be cut after a reading before the register stops calling it current.
 *
 * Releases are this repository's `v0.1.0-rc.*` tags, counted with `git tag --contains <sha>`: a reading taken five
 * releases ago describes a tree that has moved five times, and re-taking it is cheaper than trusting it.
 */
export const RELEASES_BEFORE_UNVERIFIED = 5;

/** The stamp a reason carries, or null when it carries none. */
export function stampOf(entry) {
  const match = MEASUREMENT_STAMP.exec(typeof entry.reason === "string" ? entry.reason : "");
  return match === null ? null : { reading: match[1], revision: match[2] };
}

/**
 * Release tags containing `revision`, or null when git cannot resolve it.
 *
 * Null is the interesting answer: a stamp naming a revision nobody can find is not an old reading, it is a claim with no
 * subject, so the caller reports it as a finding rather than as staleness.
 */
export function releasesSince(revision, { root = ROOT } = {}) {
  if (!/^[0-9a-f]{7,40}$/u.test(revision)) return null;
  const result = spawnSync("git", ["tag", "--contains", revision], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/** The class an exemption declares, or `null` when it carries no reason to declare one. */
function declaredClass(entry) {
  return typeof entry.reason === "string" ? entry.reason.split(":")[0].trim() : null;
}

/**
 * How short a statement is too short to name anything. A `reason` and an `expires` are held to the same floor: each is
 * prose a later reader has to act on, and "later" or "someday" acts on nothing.
 */
const MIN_STATEMENT_CHARS = 40;

/**
 * The register, checked in both directions. Every finding names the file it is about, because the file is the thing
 * the reader has to open. `headScripts` is `HEAD`'s script table, or `null` when git could not read it; passing it
 * is what keeps a stale worktree copy from deciding whether an exemption's `runsIn` resolves.
 *
 * `population` stays what `derivePopulation()` derives - the scans' answer - and `unscanned` is the declared set of gate
 * files no scan reaches (`UNSCANNED_GATES`). They are two arguments rather than one merged list because the derivation
 * is what `check-gate-population-agreement.mjs` reads, and widening it would have taught that gate a second rule.
 *
 * `read` is how a `suite:` or `hook:` claim is verified; `workflowText` is every workflow concatenated, so `unrun`
 * ("nothing names this file") can be checked rather than asserted. Null means nobody passed it and the claim is
 * printed as unverified instead of passing quietly.
 */
export function checkRegistry({
  population,
  unscanned = [],
  wired,
  exemptions = EXEMPTIONS,
  scripts,
  headScripts = {},
  workflow,
  workflowText = null,
  ciCoverage,
  releases = releasesSince,
  read = readText,
}) {
  const wiredPaths = new Set(wired.keys());
  const members = [...population, ...unscanned];
  const populationMembers = new Set(members);
  const exempt = new Map();
  const findings = [];
  const unverified = [];
  for (const path of wiredPaths)
    if (!populationMembers.has(path))
      findings.push({ code: "wired_not_a_gate", path, detail: `prelive ${wired.get(path)} names it` });
  for (const entry of exemptions) {
    if (exempt.has(entry.path)) findings.push({ code: "exempt_duplicated", path: entry.path });
    exempt.set(entry.path, entry);
  }
  const forgotten = members.filter((path) => !wiredPaths.has(path) && !exempt.has(path));
  for (const path of forgotten) findings.push({ code: "gate_forgotten", path });
  for (const path of unscanned) {
    if (inAPopulationScan(path))
      findings.push({
        code: "unscanned_but_scanned",
        path,
        detail: "a population scan reaches it now; delete the row from UNSCANNED_GATES",
      });
    if (read(path) === null)
      findings.push({ code: "unscanned_gate_missing", path, detail: "the declared file is not on disk" });
  }
  const exemptOnly = exemptions.filter((entry) => !wiredPaths.has(entry.path));
  for (const entry of exemptions) {
    if (wiredPaths.has(entry.path)) {
      findings.push({ code: "exempt_but_wired", path: entry.path, detail: `prelive ${wired.get(entry.path)} runs it` });
      continue;
    }
    if (!populationMembers.has(entry.path)) {
      findings.push({ code: "exempt_not_a_gate", path: entry.path });
      continue;
    }
    const className = declaredClass(entry);
    if (className === null) {
      findings.push({ code: "exempt_unreasoned", path: entry.path, detail: "the entry carries no reason" });
      continue;
    }
    if (!Object.hasOwn(REASON_CLASSES, className)) {
      findings.push({ code: "exempt_unreasoned", path: entry.path, detail: `unknown class "${className}"` });
      continue;
    }
    if (entry.reason.length < MIN_STATEMENT_CHARS) {
      findings.push({
        code: "exempt_unreasoned",
        path: entry.path,
        detail: "the reason is too short to name anything",
      });
      continue;
    }
    if (typeof entry.runsIn !== "string" || entry.runsIn.length === 0) {
      findings.push({
        code: "exempt_runs_in_missing",
        path: entry.path,
        detail: "no runsIn; write pnpm <script>, suite:<script>, ci:<workflow> or on-demand",
      });
      continue;
    }
    // A row with a home is re-checked on every run by the script/suite/hook/workflow it names, so it expires by going
    // red. A row with none has nothing to re-check, and a silence kept forever is what this register exists to name.
    if (
      entry.runsIn === "on-demand" &&
      !(typeof entry.expires === "string" && entry.expires.length >= MIN_STATEMENT_CHARS)
    )
      findings.push({
        code: "exempt_expiry_unreasoned",
        path: entry.path,
        detail:
          typeof entry.expires === "string" && entry.expires.length > 0
            ? "`expires` is too short to name the condition that ends the row"
            : "the row says nothing runs this gate, and carries no `expires` saying what would end that",
      });
    const dangling = verifyRunsIn(entry, { scripts, headScripts, workflow, read });
    if (dangling !== null) findings.push({ ...dangling, path: entry.path });
    // A reason in a measured class states a reading; this is where it says when it was taken, and where a reading too
    // old to trust is named. Printed rather than found: a register that reddens on ninety unstamped rows teaches nobody
    // which row to re-measure, and one that says nothing leaves the prose unmeasured - so it names each row.
    if (MEASURED_REASON_CLASSES.includes(className)) {
      const stamp = stampOf(entry);
      if (stamp === null)
        unverified.push({ path: entry.path, why: "the reason carries no ` · measured <reading> at <sha>`" });
      else {
        const since = releases(stamp.revision);
        if (since === null)
          findings.push({
            code: "exempt_measured_revision_unknown",
            path: entry.path,
            detail: `the stamp names ${stamp.revision}, which git cannot resolve`,
          });
        else if (since >= RELEASES_BEFORE_UNVERIFIED)
          unverified.push({ path: entry.path, why: `${since} release(s) since ${stamp.revision}` });
      }
    }
    if (className === NOTHING_RUNS_IT) {
      const naming = entriesNaming(entry.path, [scripts, headScripts]);
      if (naming.length > 0)
        findings.push({ code: "exempt_unrun_but_named", path: entry.path, detail: `${naming.join(", ")} names it` });
      else if (workflowText === null)
        unverified.push({ path: entry.path, why: "no workflow text was read, so `nothing runs it` is unchecked" });
      else if (namesGate(workflowText, entry.path))
        findings.push({ code: "exempt_unrun_but_named", path: entry.path, detail: "a workflow step names it" });
    }
    if (className === RUNS_ON_EVERY_PUSH && entry.runsIn.startsWith("pnpm ")) {
      const script = entry.runsIn.slice("pnpm ".length);
      if (!ciCoverage.runs.has(script)) {
        const registered = ciCoverage.registered.get(script);
        findings.push({
          code: "exempt_elsewhere_not_in_ci",
          path: entry.path,
          detail:
            registered === undefined
              ? `${script} is in no workflow and in no gates job`
              : `gates/meta/check-ci-coverage.mjs registers ${script} as ${registered.reason}: ${registered.detail}`,
        });
      }
    }
  }
  const counts = new Map();
  for (const entry of exemptOnly) {
    const className = declaredClass(entry);
    if (className === null) continue;
    counts.set(className, (counts.get(className) ?? 0) + 1);
  }
  const onDemand = exemptions.filter((entry) => entry.runsIn === "on-demand").map((entry) => entry.path);
  return {
    status: findings.length === 0 ? "passed" : "failed",
    wired: members.filter((path) => wiredPaths.has(path)).length,
    total: members.length,
    exempt: exemptOnly.length,
    byClass: Object.fromEntries([...counts.entries()].sort()),
    onDemand,
    unscanned,
    unverified,
    scriptTrees: {
      head: headScripts === null ? null : Object.keys(headScripts).length,
      disagreeing: headScripts === null ? [] : scriptTreeDisagreements(scripts, headScripts),
    },
    findings,
  };
}

/** A repo-relative file's text, or null when it is not there: the one reader the register asks for any file. */
function readText(file) {
  try {
    return readFileSync(resolve(ROOT, file), "utf8");
  } catch {
    return null;
  }
}

/** The scripts the worktree's `package.json` declares: what this checkout has on disk, not what it has committed. */
export function readScripts({ root = ROOT } = {}) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts ?? {};
}

/**
 * The scripts `HEAD`'s `package.json` declares, or `null` when git cannot answer (no repository, no commit).
 *
 * The register used to read the worktree copy alone, and a script committed through a private index - in `HEAD`,
 * absent from this file on disk - was reported as `exempt_runs_in_unknown_script`: a gate that runs called
 * unreachable because of a stale local file. Every gate in this tree that asks "does anything run this?" reads
 * `HEAD` for exactly this reason.
 */
export function readHeadScripts({ root = ROOT } = {}) {
  const result = spawnSync("git", ["show", "HEAD:package.json"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout).scripts ?? {};
  } catch {
    return null;
  }
}

/**
 * Script names whose command differs between the worktree and `HEAD`, sorted. A name only one tree has is a
 * disagreement: it is the reading that decides whether an exemption's `runsIn` resolves, so it is printed rather
 * than left to decide a verdict silently.
 */
export function scriptTreeDisagreements(worktreeScripts, headScripts) {
  const worktree = worktreeScripts ?? {};
  const head = headScripts ?? {};
  const names = new Set([...Object.keys(worktree), ...Object.keys(head)]);
  return [...names].filter((name) => worktree[name] !== head[name]).sort();
}

/** `gates/meta/check-ci-coverage.mjs` owns the fact "does a script run on every push"; this reads it, never restates it. */

/**
 * The register, read off the real tree: the derived population, the ladder's own wired set, both `package.json`
 * trees, the workflows and the CI coverage gate. One function, so the CLI and its tests cannot read the tree two
 * different ways.
 */
export function auditRegistry() {
  const scripts = readScripts();
  const headScripts = readHeadScripts();
  const files = readdirSync(resolve(ROOT, WORKFLOW_DIR))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `${WORKFLOW_DIR}/${name}`);
  const texts = new Map(files.map((file) => [file, readText(file) ?? ""]));
  const coverage = deriveCiCoverage({ scripts, workflowText: [...texts.values()].join("\n") });
  return checkRegistry({
    population: derivePopulation(),
    unscanned: UNSCANNED_GATES.map((entry) => entry.path),
    wired: preludeGatePaths(),
    exemptions: [...EXEMPTIONS, ...UNSCANNED_GATES],
    scripts,
    headScripts,
    workflow: (file) => texts.get(file) ?? null,
    workflowText: [...texts.values()].join("\n"),
    ciCoverage: {
      runs: new Set([...coverage.workflow, ...coverage.derived]),
      registered: new Map(coverage.register.map((entry) => [entry.script, entry])),
    },
  });
}

/**
 * The register's output as data - the lines a reader sees, and the exit code - so a falsifier can assert the named
 * finding and the status without spawning a subprocess, and `report` cannot print a verdict it did not return.
 */
export function renderRegistry(result) {
  const lines = [];
  const byClass = Object.entries(result.byClass)
    .map(([name, count]) => `${name}:${count}`)
    .join(",");
  lines.push(
    `prelive_gate_registry: wired ${result.wired} of ${result.total}; exempt ${result.exempt}` +
      `${byClass === "" ? "" : ` (${byClass})`}`,
  );
  lines.push(
    result.scriptTrees.head === null
      ? "prelive_gate_registry: scripts_read=worktree-only; git cannot read HEAD:package.json"
      : "prelive_gate_registry: scripts_read=worktree+HEAD",
  );
  if (result.scriptTrees.disagreeing.length > 0)
    lines.push(
      `prelive_gate_registry: package_json_trees_disagree=${result.scriptTrees.disagreeing.length} ` +
        `${result.scriptTrees.disagreeing.join(",")}`,
    );
  if (result.onDemand.length > 0)
    lines.push(`prelive_gate_registry: no_scheduled_home=${result.onDemand.length} ${result.onDemand.join(",")}`);
  // Printed apart from the population on purpose: these are gate files the derivation does not scan, and a reader has to
  // see that they are declared rather than counted among the members a scan found.
  if (result.unscanned.length > 0)
    lines.push(`prelive_gate_registry: outside_the_scan=${result.unscanned.length} ${result.unscanned.join(",")}`);
  if (result.unverified.length > 0)
    lines.push(
      `prelive_gate_registry: reason_unverified=${result.unverified.length} ${result.unverified
        .map((entry) => entry.path)
        .join(",")}`,
    );
  for (const finding of result.findings) {
    switch (finding.code) {
      case "gate_forgotten":
        lines.push(
          `prelive_gate_registry_forgotten: ${finding.path} runs in no prelive rung and no exemption names where it runs`,
        );
        break;
      case "exempt_but_wired":
        lines.push(`prelive_gate_registry_exempt_but_wired: ${finding.path} (${finding.detail}); delete the exemption`);
        break;
      case "wired_not_a_gate":
        lines.push(
          `prelive_gate_registry_wired_not_a_gate: ${finding.path} is named by ${finding.detail} but is not in the derived population`,
        );
        break;
      case "exempt_not_a_gate":
        lines.push(
          `prelive_gate_registry_exempt_not_a_gate: ${finding.path} is not in the derived population; delete the entry`,
        );
        break;
      case "exempt_duplicated":
        lines.push(`prelive_gate_registry_exempt_duplicated: ${finding.path} is listed twice`);
        break;
      case "exempt_unreasoned":
        lines.push(
          `prelive_gate_registry_exempt_unreasoned: ${finding.path} - ${finding.detail}; classes are ` +
            `${Object.keys(REASON_CLASSES).join("|")}`,
        );
        break;
      case "exempt_expiry_unreasoned":
        lines.push(
          `prelive_gate_registry_exempt_expiry_unreasoned: ${finding.path} - ${finding.detail}; a row with no ` +
            "scheduled home must say what would end it, the way an expiring exemption does elsewhere in this tree",
        );
        break;
      case "exempt_runs_in_missing":
        lines.push(
          `prelive_gate_registry_exempt_runs_in_missing: ${finding.path} - ${finding.detail}; with no runsIn the entry ` +
            "claims nothing and this register cannot tell a gate with a home from one without",
        );
        break;
      case "exempt_elsewhere_not_in_ci":
        lines.push(`prelive_gate_registry_exempt_elsewhere_not_in_ci: ${finding.path} - ${finding.detail}`);
        break;
      case "exempt_measured_revision_unknown":
        lines.push(
          `prelive_gate_registry_exempt_measured_revision_unknown: ${finding.path} - ${finding.detail}; a stamp naming a ` +
            "revision nobody can resolve is a reading with no subject, not an old one",
        );
        break;
      default:
        lines.push(`prelive_gate_registry_${finding.code}: ${finding.path} - ${finding.detail}`);
    }
  }
  lines.push(
    `prelive_gate_registry: ${result.status}` +
      `${result.findings.length === 0 ? "" : ` (${result.findings.length} finding(s))`}`,
  );
  return { lines, exitCode: result.findings.length === 0 ? 0 : 1 };
}

function report(result) {
  const rendered = renderRegistry(result);
  for (const line of rendered.lines) process.stdout.write(`${line}\n`);
  return rendered.exitCode;
}

function main() {
  process.exitCode = report(auditRegistry());
}

if (import.meta.main) main();
