#!/usr/bin/env node
/**
 * LOCAL/CI PARITY: the ladder a developer runs, and the checks CI runs, subtracted from each other.
 *
 * WHY (measured 2026-11-14)
 *
 * The developer's entry point is `pnpm prelive` (`node tools/prelive.mjs --no-game`), the layered
 * ladder that stops at the first red rung. No job runs that ladder, and `tools/check-ci-coverage.mjs`
 * answers the neighbouring question - does a gate SCRIPT run in a workflow, or in the `gates` job's
 * derived set? - so neither reading ever subtracted the two sides: a member the ladder runs and CI
 * does not is green locally and unenforced on the merge, and a check CI enforces and the ladder omits
 * is a failure a developer meets after pushing.
 *
 * THE POPULATION IS THE LADDER, read from `tools/prelive.mjs`'s own declarations and never listed
 * here: `PRELUDE_RUNGS` (the gates each rung runs, by path, in ladder order) plus `LADDER_RUNGS` (the
 * rungs that run no gate - the Mod export build, the linkage closure, the deploy isolation, the
 * compile + population agreement, the runner shape). A member with NO `package.json` name is still a
 * member, and that is the point rather than an oversight: `tools/check-stardew-observation-consumers.mjs`
 * is a gate the ladder runs that nothing else names, so it is invisible to a name-derived reading and
 * it is the MOST unenforced thing in the tree, not the least. `l4` is out: it needs
 * `--action <id> --game`, so it is not a rung of the `--no-game` ladder.
 *
 * THE CI SIDE is read the way the workflows are written, in four shapes (the first match wins):
 *   step-names-file   a `run:` command names the member's path
 *   gates-job         `tools/check-ci-coverage.mjs` derives the member's script into the `gates`
 *                     job's `--run` set, and a workflow step runs that set
 *   workflow-script   a `run:` command names a root script whose own command names the member's path
 *   subpackage-step   a `run:` command is `pnpm --dir <dir> <script>` and THAT package's script names
 *                     the member's path: `pnpm --dir integrations/stardew/action-development action:ci`
 *                     is how the three action-artefact checks run on every push, so a root script
 *                     repeating one would be a second spelling of the same run.
 *   suite-step        a `run:` command is `pnpm --dir <dir> <script>` and that script runs the
 *                     package's own suite, which ENUMERATES its test files instead of naming them:
 *                     `action:ci` is `node src/portfolio.mjs --ci`, whose `package-tests` entry is
 *                     `src/run-tests.mjs`, which runs every `tests/*.test.mjs`. The step is covered,
 *                     not the individual files, so the two action-projection drift suites are covered
 *                     by the step that runs them and not by a path a workflow happens to spell.
 *
 * YAML comments are stripped before anything is read, so a step discussed in prose is not a step;
 * `--no-restore` and its neighbours are dropped before commands are compared, because a flag changes
 * how a command runs, not what it runs.
 *
 * THE BUCKETS, and only the first is a defect:
 *   ladder_only_uncovered   in the ladder, in no workflow, not declared. The dangerous direction: the
 *                           developer's run reports a verdict the merge never asks for.
 *   ladder_only declared    the same, with a row below naming why it cannot run in CI today. A row is
 *                           not a verdict: it expires the moment a step covers the member
 *                           (`parity_exemption_redundant`) or the member leaves the ladder
 *                           (`parity_exemption_stale`), so an entry cannot outlive its reason.
 *   local_only              declared `local-only`: nothing a push can use.
 *   ci_only                 CI covers it, the ladder omits it. Reported, never failed: CI still
 *                           enforces it, so the cost is a push that fails, not a merge that passes.
 *                           `--list` prints them.
 *
 * ZERO IS BLOCKED, never green: a ladder that reads no member, or a workflow read that covers no
 * file, is a measurement that did not happen (`exit 2`), not a clean diff.
 *
 * USAGE:
 *   node tools/check-local-ci-parity.mjs           # the reading; exit 1 on an uncovered or stale member
 *   node tools/check-local-ci-parity.mjs --list     # every member of both directions by name
 *   node tools/check-local-ci-parity.mjs --json     # the report, machine-readable
 *
 * red-proof: history  the ladder step `pnpm lint:ast-grep` ran in no workflow until `54c4227b`. Replayed
 *                    at that commit's parent the previous reading of this gate fired with
 *                    `ladder_step_uncovered:4:lint:ast-grep`, findings=1, exit 1, and at `54c4227b` it did
 *                    not; the two verdicts are the command recorded in `tools/check-local-ci-parity.test.mjs`.
 * red-proof: inject   a member the ladder runs that no step covers -> `ladder_member_uncovered: <position>
 *                    <id>` naming the file, exit 1 (this file's suite)
 * red-proof: inject   a declared row whose member gains a workflow step -> `parity_exemption_redundant`
 *                    naming the script and the step that now covers it (this file's suite)
 * red-proof: inject   a gate file with no `package.json` name -> it is still a population member and is
 *                    reported by name rather than dropped (this file's suite)
 *
 * No game, no network, no model. It reads `package.json`, the workflow files, and the `package.json`
 * of each sub-package a workflow step names with `pnpm --dir`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveCiCoverage, stripYamlComments, workflowCoveredScripts } from "./check-ci-coverage.mjs";
import { LADDER_RUNGS, PRELUDE_RUNGS } from "./prelive.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";

/** The ladder a developer runs before pushing: `package.json`'s `prelive` -> `tools/prelive.mjs`. */
export const LADDER = "prelive";

/** Why a ladder member runs in no workflow. `local-only` is the healthy shape; the rest are recorded. */
const REASONS = new Map([
  ["local-only", "nothing a push can use: a watch mode, a dev server, a live game or a manual probe"],
  ["debt", "the check is red at HEAD, so a CI step would be a standing red; the fix, not the wiring, is the work"],
  [
    "environment",
    "needs an input a hosted checkout has not got: the decompiled tree, a game install, a built generation",
  ],
  [
    "rung",
    "the ladder's own in-process rung: it compares populations the ladder reads in one pass, or prepares a build for a later rung, so no workflow step exists to run it",
  ],
]);

/**
 * A CI step that runs a package's WHOLE suite: `pnpm --dir <directory> <script>`, where the script
 * enumerates `<tests>/*.test.mjs` rather than naming the files. Declared as the fact it is, with the
 * chain quoted, so the files are covered by the step that runs them and never by a list kept here.
 */
export const SUITE_STEPS = Object.freeze([
  {
    directory: "integrations/stardew/action-development",
    scripts: Object.freeze(["action:ci", "test"]),
    tests: "integrations/stardew/action-development/tests",
  },
]);

/**
 * The rows. Each one is a ladder member no workflow step covers today, with the reason it cannot; the
 * measurement lives in the register that already records it, so this file does not carry a second copy
 * of a number. A row expires by itself: a step that covers the member makes it `redundant`, and a
 * member that leaves the ladder makes it `stale`.
 */
export const EXEMPTIONS = Object.freeze([
  {
    id: "tools/check-source-shape-readers.mjs",
    reason: "debt",
    detail:
      "measured red at HEAD on 2026-11-14: `every_match_reads_the_normalised_shape: failed (2 match(es) read the raw bytes)` over 136 matches and 543 reads · expires when it exits 0 and its `check:source-shape-readers` registration in tools/check-ci-coverage.mjs is deleted with it",
  },
  {
    id: "tools/check-stardew-actor-admissibility.mjs",
    reason: "environment",
    detail:
      "its population is the game's own source under ref/external/StardewValleyDecompiled - gitignored, so a hosted checkout reads nothing and the gate reports a skip rather than a comparison · expires when a checkout step supplies the tree (a mount, or a vendored slice) and the gate exits 0 there",
  },
  {
    id: "tools/check-stardew-invented-gates.mjs",
    reason: "environment",
    detail:
      "compares every numeric admission bound against the engine's own line in ref/external/StardewValleyDecompiled, which a hosted checkout has not got; it also has no `package.json` script, so `tools/check-ci-coverage.mjs`'s name-derived population cannot see it at all · expires when a checkout step supplies the tree and a gate script names it",
  },
  ...[
    [
      "prep",
      "the Mod export build L0's artefact gate needs as a producer; CI compiles the C# projects (`check:csharp-compile`) but does not run this build",
    ],
    [
      "l1",
      "the linkage closure: action ids x runner map x tools-side scenario x Mod-side scenario, derived in one pass over the tree",
    ],
    ["l1b", "the deploy isolation: the launcher's resolved mods root must not be inside the game installation"],
    ["l2", "the Host test artifact build plus the agreement of every action population the ladder read"],
    ["l3", "the runner shape: a one-shot `observeFresh({actionable:true})` may not be the basis of an assertion"],
  ].map(([id, detail]) => ({ id, reason: "rung", detail: `${detail} · expires when a workflow step runs it` })),
]);

/**
 * Every ladder member in ladder order: one per gate a rung declares, then one per rung that declares
 * no gate. Read from `tools/prelive.mjs`, so a gate added to a rung is a member here by construction.
 */
export function ladderMembers({ rungs = PRELUDE_RUNGS, ladderRungs = LADDER_RUNGS } = {}) {
  const members = [];
  const gates = new Map();
  for (const rung of rungs) for (const gate of rung.gates) gates.set(gate, rung.id);
  const gateOnlyRungs = new Set([...gates.values()]);
  for (const id of ladderRungs) {
    if (gateOnlyRungs.has(id)) continue;
    members.push({ position: members.length + 1, id, kind: "rung", rung: null });
  }
  for (const [gate, rung] of gates) members.push({ position: members.length + 1, id: gate, kind: "gate", rung });
  return members;
}

/** Every `run:` command in a workflow: an inline scalar, or the block under `run: |` / `run: >`. */
export function workflowRunCommands(text) {
  const lines = stripYamlComments(text).split("\n");
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^(\s*)(?:-\s*)?run:\s*(.*)$/u.exec(lines[index]);
    if (header === null) continue;
    const [, indent, value] = header;
    const inline = value.trim();
    if (inline !== "" && !/^[|>][+-]?$/u.test(inline)) {
      commands.push(inline);
      continue;
    }
    const block = [];
    for (let line = index + 1; line < lines.length; line += 1) {
      const body = lines[line];
      if (body.trim() === "") {
        block.push("");
        continue;
      }
      if (body.length - body.trimStart().length <= indent.length) break;
      block.push(body.trim());
    }
    commands.push(block.join("\n"));
  }
  return commands;
}

/** A command's words with its flags dropped: `--no-restore` changes how a command runs, not what it runs. */
function commandWords(command) {
  return command.split(/\s+/u).filter((word) => word !== "" && !word.startsWith("-"));
}

/** The file a command runs, when it names one: `node tools/x.mjs`, `dotnet test x/y`, `--artifact x.json`. */
export function entryFiles(command) {
  return command.match(/[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|cjs|js|ts|tsx|ps1|cs|csproj)/gu) ?? [];
}

/**
 * `pnpm --dir <dir> <script>` pairs in a run command. Read from the RAW tokens: `commandWords` drops
 * every flag, and `--dir` is the flag that carries the fact.
 */
function dirScripts(command) {
  const raw = command.split(/\s+/u).filter((word) => word !== "");
  const found = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "--dir") continue;
    const dir = raw[index + 1];
    const scriptName = raw.slice(index + 2).find((word) => !word.startsWith("-"));
    if (dir !== undefined && scriptName !== undefined) found.push({ dir, scriptName });
  }
  return found;
}

/**
 * What the workflows cover, by the file each covered command runs. `rootScripts` is the same reading in
 * the other direction (which root script names CI covers), which is what `ci_only` is subtracted from.
 */
export function ciCoverage({ scripts, workflowText, packages = {}, suiteFiles = {} }) {
  const files = new Map();
  const add = (path, how) => {
    if (!files.has(path)) files.set(path, how);
  };
  const bodies = workflowRunCommands(workflowText).map(commandWords);

  for (const words of bodies) for (const word of words) if (word.includes("/")) add(word, "step-names-file");

  const coverage = deriveCiCoverage({ scripts, workflowText });
  const derived = new Set(coverage.runnerWired ? coverage.derived : []);
  const rootScripts = new Set([...workflowCoveredScripts({ scripts, workflowText }), ...derived]);
  for (const name of rootScripts)
    for (const path of entryFiles(scripts[name] ?? "")) add(path, derived.has(name) ? "gates-job" : "workflow-script");

  // `pnpm --dir <dir> <script>`: the sub-package's own command is what runs, so its files are covered,
  // and a script that runs the package's whole suite covers every test file that suite enumerates.
  for (const command of workflowRunCommands(workflowText)) {
    for (const { dir, scriptName } of dirScripts(command)) {
      const script = packages?.[dir]?.[scriptName];
      if (typeof script !== "string") continue;
      for (const path of entryFiles(script)) add(posix.join(dir, path), `subpackage-step:${dir}#${scriptName}`);
      const suite = SUITE_STEPS.find((entry) => entry.directory === dir && entry.scripts.includes(scriptName));
      if (suite !== undefined)
        for (const path of suiteFiles[suite.tests] ?? []) add(path, `suite-step:${dir}#${scriptName}`);
    }
  }
  return { files, rootScripts };
}

/**
 * The reading, from the ladder's own declaration and the workflows' own text. `exemptions` is the
 * register of members no step covers, and the run reports every row that no longer earns its place.
 */
export function deriveParity({
  members,
  scripts,
  workflowText,
  exemptions = EXEMPTIONS,
  packages = {},
  suiteFiles = {},
  ladder = LADDER,
}) {
  const { files, rootScripts } = ciCoverage({ scripts, workflowText, packages, suiteFiles });
  const findings = [];
  const covered = new Map();
  const ladderOnly = [];
  const localOnly = [];
  const registered = new Map(exemptions.map((entry) => [entry.id, entry]));
  const byId = new Map(members.map((member) => [member.id, member]));
  const coveredBy = (member) => (member.kind === "gate" ? (files.get(member.id) ?? null) : null);

  for (const member of members) {
    const by = coveredBy(member);
    if (by !== null) {
      covered.set(member.id, by);
      continue;
    }
    const row = registered.get(member.id);
    if (row === undefined) {
      findings.push({
        code: "ladder_member_uncovered",
        id: `${member.position}:${member.id}`,
        detail:
          member.kind === "rung"
            ? "a ladder rung no workflow step runs, so what it proves is proved only locally"
            : "no workflow step runs it, so a green local run says nothing about the merge",
      });
      continue;
    }
    (row.reason === "local-only" ? localOnly : ladderOnly).push({ ...row, position: member.position });
  }

  const listed = new Set();
  for (const row of exemptions) {
    if (listed.has(row.id)) findings.push({ code: "parity_exemption_duplicated", id: row.id, detail: "listed twice" });
    listed.add(row.id);
    const member = byId.get(row.id);
    if (member === undefined) {
      findings.push({
        code: "parity_exemption_stale",
        id: row.id,
        detail: "not a ladder member any more; delete the row",
      });
      continue;
    }
    const by = coveredBy(member);
    if (by !== null) {
      findings.push({
        code: "parity_exemption_redundant",
        id: row.id,
        detail: `covered now (${by}); delete the row`,
      });
      continue;
    }
    if (!REASONS.has(row.reason)) {
      findings.push({
        code: "parity_exemption_unreasoned",
        id: `${row.id}:${row.reason}`,
        detail: `must name one of ${[...REASONS.keys()].join("|")}`,
      });
      continue;
    }
    if (typeof row.detail !== "string" || row.detail.trim() === "") {
      findings.push({ code: "parity_exemption_undetailed", id: row.id, detail: "must say why" });
    }
  }

  const memberPaths = new Set(members.filter((member) => member.kind === "gate").map((member) => member.id));
  const ciOnly = [...rootScripts]
    .filter((name) => !entryFiles(scripts[name] ?? "").some((path) => memberPaths.has(path)))
    .sort();

  const blocked =
    members.length === 0
      ? "local_ci_parity_ladder_empty:no ladder member resolved"
      : files.size === 0
        ? "local_ci_parity_workflow_unread:no workflow step covers any file"
        : null;

  return { ladder, members, covered, ladderOnly, localOnly, ciOnly, exemptions: exemptions.length, findings, blocked };
}

/** The report a caller reads: a `gate` id, the ladder as its population, and one entry per direction. */
export function buildReport(reading) {
  return {
    gate: "local-ci-parity/v1",
    status: reading.blocked !== null ? "blocked" : reading.findings.length === 0 ? "passed" : "failed",
    population: reading.members.length,
    examined: reading.members.length,
    findings: reading.findings.length,
    ladder: reading.members.map((member) => member.id),
    inCi: [...reading.covered].map(([id, by]) => `${id}:${by}`),
    ladderOnly: reading.ladderOnly.map((row) => `${row.id}:${row.reason}`),
    localOnly: reading.localOnly.map((row) => `${row.id}:${row.reason}`),
    ciOnly: reading.ciOnly,
    exemptions: reading.exemptions,
    details: reading.findings.map((finding) => `${finding.code}:${finding.id}`),
  };
}

/** The `package.json` tables a workflow step reaches with `pnpm --dir`, so a sub-package run is read. */
function readPackages(root, workflowText) {
  const packages = {};
  for (const command of workflowRunCommands(workflowText)) {
    for (const { dir } of dirScripts(command)) {
      const file = join(root, dir, "package.json");
      if (!existsSync(file)) continue;
      packages[dir] = JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
    }
  }
  return packages;
}

function readTree(root) {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  const directory = join(root, WORKFLOW_DIR);
  const entries = readdirSync(directory)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
  const workflowText = entries.map((name) => readFileSync(join(directory, name), "utf8")).join("\n");
  const suiteFiles = {};
  for (const suite of SUITE_STEPS) {
    const tests = join(root, suite.tests);
    if (!existsSync(tests)) continue;
    suiteFiles[suite.tests] = readdirSync(tests)
      .filter((name) => /\.test\.mjs$/u.test(name))
      .map((name) => `${suite.tests}/${name}`);
  }
  return { scripts, workflowText, workflows: entries.length, packages: readPackages(root, workflowText), suiteFiles };
}

function report(reading, { list, scripts, out, err }) {
  out.write(
    `local_ci_parity: ladder=${reading.members.length} in_ci=${reading.covered.size} ` +
      `ladder_only=${reading.ladderOnly.length} local_only=${reading.localOnly.length} ` +
      `ci_only=${reading.ciOnly.length} exemptions=${reading.exemptions} examined=${reading.members.length}\n`,
  );
  for (const member of reading.members) {
    const by = reading.covered.get(member.id);
    const row = [...reading.ladderOnly, ...reading.localOnly].find((entry) => entry.id === member.id);
    const state =
      by !== undefined ? `in-ci(${by})` : row !== undefined ? `uncovered-declared(${row.reason})` : "UNCOVERED";
    if (list || by === undefined) out.write(`local_ci_parity_ladder: ${member.position} ${member.id} ${state}\n`);
  }
  for (const row of reading.ladderOnly)
    out.write(`local_ci_parity_ladder_only: ${row.position} ${row.id} ${row.reason} - ${row.detail}\n`);
  for (const row of reading.localOnly)
    out.write(`local_ci_parity_local_only: ${row.position} ${row.id} ${row.reason} - ${row.detail}\n`);
  if (list) for (const name of reading.ciOnly) out.write(`local_ci_parity_ci_only: ${name} ${scripts[name] ?? ""}\n`);
  for (const finding of reading.findings) err.write(`${finding.code}:${finding.id} ${finding.detail}\n`);
  if (reading.blocked !== null) err.write(`${reading.blocked}\n`);
}

export function main(
  argv,
  { root = ROOT, out = process.stdout, err = process.stderr, exemptions = EXEMPTIONS, members = ladderMembers() } = {},
) {
  const tree = readTree(root);
  const reading = deriveParity({
    members,
    scripts: tree.scripts,
    workflowText: tree.workflowText,
    exemptions,
    packages: tree.packages,
    suiteFiles: tree.suiteFiles,
  });
  report(reading, { list: argv.includes("--list") || argv.includes("--json"), scripts: tree.scripts, out, err });
  const built = buildReport(reading);
  out.write(
    argv.includes("--json")
      ? `${JSON.stringify(built, null, 2)}\n`
      : `${JSON.stringify({ gate: built.gate, status: built.status, population: built.population, examined: built.examined, findings: built.findings, workflows: tree.workflows })}\n`,
  );
  if (reading.blocked !== null) return 2;
  return reading.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
