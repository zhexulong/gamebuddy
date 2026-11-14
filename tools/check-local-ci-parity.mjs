#!/usr/bin/env node
/**
 * LOCAL/CI PARITY: the ladder a developer runs, and the checks CI runs, subtracted from each other.
 *
 * WHY (measured 2026-11-14)
 *
 * `quality:check` is the sixteen-step `&&` ladder `CONTRIBUTING.md` and `guides/development.md` tell a developer to
 * run before pushing. No job runs that script. `ci.yml` says so in its own words about one of its members ("it ran
 * nowhere until the CI coverage gate named it: only `quality:check`, which no job runs, held it"), and
 * `tools/check-ci-coverage.mjs` answers the neighbouring question - does a gate script run in a workflow or in the
 * `gates` job's derived set? Neither reads the LADDER, so the two sets were never subtracted from one another:
 * a member the ladder runs and CI does not is green locally and unenforced on the merge, and a check CI enforces
 * and the ladder omits is a failure a developer meets after pushing.
 *
 * THE POPULATION IS READ FROM BOTH SIDES, never from a list here:
 *   ladder  `package.json`'s `quality:check` command, split on `&&`, each step resolved to the script it runs.
 *   ci      the workflow `run:` lines, through the same readings `check-ci-coverage.mjs` uses (a step covers a
 *           script when it names the script or a file its command runs), plus the derived set the `gates` job runs
 *           via `check-ci-coverage.mjs --run`, plus a step whose command is the script's own command over the same
 *           arguments - `dotnet test <project>` has no file argument, so only the command identifies it.
 *
 * THE THREE BUCKETS, and only the first is a defect:
 *   ladder_only_uncovered             in the ladder, in no workflow, not declared. This is the dangerous direction:
 *                                     the developer's run reports a verdict the merge never asks for.
 *   ladder_only undeclared reasons    the same, with a row below naming why it cannot run in CI today. A row is not a
 *                                     verdict: it expires the moment a workflow step covers the script
 *                                     (`parity_exemption_redundant`) or the script leaves the ladder
 *                                     (`parity_exemption_stale`), so an entry cannot outlive its reason.
 *   ci_only                           CI runs it, the ladder omits it. Reported, never failed: CI still enforces it,
 *                                     so the cost is a push that fails, not a merge that passes. `--list` prints them.
 *
 * YAML comments are stripped before anything is read, so a step discussed in prose is not a step; `--no-restore` and
 * its neighbours are dropped before commands are compared, because a flag changes how a command runs, not what it
 * runs.
 *
 * ZERO IS BLOCKED, never green: a ladder that reads no steps, or a workflow read that covers no script, is a
 * measurement that did not happen (`exit 2`), not a clean diff.
 *
 * USAGE:
 *   node tools/check-local-ci-parity.mjs           # the reading; exit 1 on an uncovered or stale member
 *   node tools/check-local-ci-parity.mjs --list     # every member of both directions by name
 *   node tools/check-local-ci-parity.mjs --json     # the report, machine-readable
 *
 * red-proof: history  the ladder member `pnpm lint:ast-grep` ran in no workflow until `54c4227b`. Replayed at that
 *                    commit's parent the gate fires - `ladder_step_uncovered:4:lint:ast-grep`, findings=1,
 *                    population=13, exit 1 - and at `54c4227b` it does not (findings=0, population=13); the two
 *                    verdicts are the command recorded in `tools/check-local-ci-parity.test.mjs`.
 *                    (`tools/replay-gate-on-history.mjs --gate tools/check-local-ci-parity.mjs --at 54c4227b^
 *                    --at 54c4227b --expect fired@54c4227b^ --expect did-not-fire@54c4227b`: 2 expectations held)
 *
 * No game, no network, no model. It reads `package.json` and the workflow files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveCiCoverage, stripYamlComments, workflowCoveredScripts } from "./check-ci-coverage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";

/** The ladder a developer runs before pushing. Its members are read from `package.json`, never listed here. */
export const LADDER = "quality:check";

/** Why a ladder member runs in no workflow. `local-only` is the healthy shape; the other two are recorded debt. */
const REASONS = new Map([
  ["local-only", "nothing a push can use: a watch mode, a dev server, a live game or a manual probe"],
  ["debt", "the check is red at HEAD, so a CI step would be a standing red; the fix, not the wiring, is the work"],
  [
    "environment",
    "needs an input a hosted checkout has not got: the licensed game, a decompiled tree, an installed workspace",
  ],
]);

/**
 * The rows. Each one is a ladder member that no workflow step covers today, with the reason it cannot; the
 * measurement lives in the register that already records it, so this file does not carry a second copy of a number.
 */
export const EXEMPTIONS = Object.freeze([
  {
    script: "lint:eslint",
    reason: "debt",
    detail:
      "tools/check-ci-coverage.mjs registers the same script as debt with its measurement; this row expires when a CI step runs it",
  },
  {
    script: "check:text-hygiene",
    reason: "debt",
    detail:
      "tools/check-ci-coverage.mjs registers the same script as debt with its measurement; this row expires when a CI step runs it",
  },
]);

/**
 * One ladder step per `&&` member, in ladder order. A step that is not `pnpm <script>` carries `script: null` and is
 * reported rather than skipped: a ladder whose member this reader cannot resolve is a member nobody diffs.
 */
export function ladderSteps(command) {
  return command.split("&&").map((part, index) => {
    const text = part.trim();
    const resolved = /^pnpm\s+(?:run\s+)?([A-Za-z][\w:-]*)$/u.exec(text);
    return { position: index + 1, text, script: resolved === null ? null : resolved[1] };
  });
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

function containsSequence(words, sequence) {
  if (sequence.length === 0) return false;
  for (let start = 0; start + sequence.length <= words.length; start += 1)
    if (sequence.every((word, offset) => words[start + offset] === word)) return true;
  return false;
}

/**
 * The reading, from `package.json`'s script table and the workflows' own text. `exemptions` is the register of
 * ladder members that no step covers, and the run reports every row that no longer earns its place.
 */
export function deriveParity({ scripts, workflowText, exemptions = EXEMPTIONS, ladder = LADDER }) {
  const command = scripts[ladder];
  if (typeof command !== "string")
    return {
      ladder,
      steps: [],
      covered: new Map(),
      inCi: [],
      ladderOnly: [],
      localOnly: [],
      ciOnly: [],
      exemptions: exemptions.length,
      findings: [],
      blocked: `local_ci_parity_ladder_missing:${ladder}`,
    };

  const steps = ladderSteps(command);
  const named = workflowCoveredScripts({ scripts, workflowText });
  const dynamic = deriveCiCoverage({ scripts, workflowText });
  // The derived set is coverage only where a workflow step actually runs it: the set is derived by this reading
  // whether or not a step asks for it, and a gate that trusted an unrun derivation would call every uncovered
  // `check:*` member covered.
  const derived = new Set(dynamic.runnerWired ? dynamic.derived : []);
  const bodies = workflowRunCommands(workflowText).map(commandWords);

  const runsCommand = (name) =>
    (scripts[name] ?? "")
      .split("&&")
      .map((part) => commandWords(part))
      .every((words) => words.length > 0 && bodies.some((body) => containsSequence(body, words)));
  const coveredBy = (name) =>
    named.has(name)
      ? "step-names-script"
      : derived.has(name)
        ? "gates-job"
        : runsCommand(name)
          ? "step-runs-command"
          : null;

  const findings = [];
  const covered = new Map();
  const ladderOnly = [];
  const localOnly = [];
  const registered = new Map(exemptions.map((entry) => [entry.script, entry]));
  const ladderScripts = new Set(steps.map((step) => step.script).filter((name) => name !== null));

  for (const step of steps) {
    if (step.script === null) {
      findings.push({
        code: "ladder_step_unreadable",
        id: `${step.position}:${step.text}`,
        detail: "not `pnpm <script>`",
      });
      continue;
    }
    if (scripts[step.script] === undefined) {
      findings.push({
        code: "ladder_step_unregistered",
        id: `${step.position}:${step.script}`,
        detail: "package.json has no such script, so the ladder runs nothing here",
      });
      continue;
    }
    const by = coveredBy(step.script);
    if (by !== null) {
      covered.set(step.script, by);
      continue;
    }
    const row = registered.get(step.script);
    if (row === undefined) {
      findings.push({
        code: "ladder_step_uncovered",
        id: `${step.position}:${step.script}`,
        detail: "no workflow step runs it, so a green local run says nothing about the merge",
      });
      continue;
    }
    (row.reason === "local-only" ? localOnly : ladderOnly).push({ ...row, position: step.position });
  }

  const listed = new Set();
  for (const row of exemptions) {
    if (listed.has(row.script))
      findings.push({ code: "parity_exemption_duplicated", id: row.script, detail: "listed twice" });
    listed.add(row.script);
    if (!ladderScripts.has(row.script)) {
      findings.push({
        code: "parity_exemption_stale",
        id: row.script,
        detail: "not a member of the ladder any more; delete the row",
      });
      continue;
    }
    const by = coveredBy(row.script);
    if (by !== null) {
      findings.push({
        code: "parity_exemption_redundant",
        id: row.script,
        detail: `covered now (${by}); delete the row`,
      });
      continue;
    }
    if (!REASONS.has(row.reason)) {
      findings.push({
        code: "parity_exemption_unreasoned",
        id: `${row.script}:${row.reason}`,
        detail: `must name one of ${[...REASONS.keys()].join("|")}`,
      });
      continue;
    }
    if (typeof row.detail !== "string" || row.detail.trim() === "") {
      findings.push({ code: "parity_exemption_undetailed", id: row.script, detail: "must say why" });
    }
  }

  const inCi = steps
    .filter((step) => step.script !== null && covered.has(step.script))
    .map((step) => ({ position: step.position, script: step.script, by: covered.get(step.script) }));
  const ciOnly = [...new Set([...named, ...derived])].filter((name) => !ladderScripts.has(name)).sort();

  const blocked =
    ladderScripts.size === 0
      ? "local_ci_parity_ladder_empty:no ladder step resolved to a script"
      : named.size + derived.size === 0
        ? "local_ci_parity_workflow_unread:no workflow step covers any script"
        : null;

  return {
    ladder,
    steps,
    covered,
    inCi,
    ladderOnly,
    localOnly,
    ciOnly,
    exemptions: exemptions.length,
    findings,
    blocked,
  };
}

/** The report a caller reads: a `gate` id, the ladder as its population, and one entry per direction. */
export function buildReport(reading) {
  return {
    gate: "local-ci-parity/v1",
    status: reading.blocked !== null ? "blocked" : reading.findings.length === 0 ? "passed" : "failed",
    population: reading.steps.length,
    examined: reading.steps.length,
    findings: reading.findings.length,
    ladder: reading.steps.map((step) => step.script ?? step.text),
    inCi: reading.inCi.map((entry) => `${entry.script}:${entry.by}`),
    ladderOnly: reading.ladderOnly.map((row) => `${row.script}:${row.reason}`),
    localOnly: reading.localOnly.map((row) => `${row.script}:${row.reason}`),
    ciOnly: reading.ciOnly,
    exemptions: reading.exemptions,
    details: reading.findings.map((finding) => `${finding.code}:${finding.id}`),
  };
}

function readTree(root) {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  const directory = join(root, WORKFLOW_DIR);
  const entries = readdirSync(directory);
  const workflowText = entries
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
  return { scripts, workflowText, workflows: entries.filter((name) => /\.ya?ml$/u.test(name)).length };
}

function report(reading, { list, scripts, out, err }) {
  out.write(
    `local_ci_parity: ladder=${reading.steps.length} in_ci=${reading.inCi.length} ` +
      `ladder_only=${reading.ladderOnly.length} local_only=${reading.localOnly.length} ci_only=${reading.ciOnly.length} ` +
      `exemptions=${reading.exemptions} examined=${reading.steps.length}\n`,
  );
  for (const step of reading.steps) {
    const by = reading.covered.get(step.script);
    const row = [...reading.ladderOnly, ...reading.localOnly].find((entry) => entry.script === step.script);
    const state =
      by !== undefined ? `in-ci(${by})` : row !== undefined ? `uncovered-declared(${row.reason})` : "UNCOVERED";
    if (list || by === undefined) out.write(`local_ci_parity_ladder: ${step.position} ${step.script} ${state}\n`);
  }
  for (const row of reading.ladderOnly)
    out.write(`local_ci_parity_ladder_only: ${row.position} ${row.script} ${row.reason} - ${row.detail}\n`);
  for (const row of reading.localOnly)
    out.write(`local_ci_parity_local_only: ${row.position} ${row.script} ${row.reason} - ${row.detail}\n`);
  if (list) for (const name of reading.ciOnly) out.write(`local_ci_parity_ci_only: ${name} ${scripts[name] ?? ""}\n`);
  for (const finding of reading.findings) err.write(`${finding.code}:${finding.id} ${finding.detail}\n`);
  if (reading.blocked !== null) err.write(`${reading.blocked}\n`);
}

export function main(argv, { root = ROOT, out = process.stdout, err = process.stderr, exemptions = EXEMPTIONS } = {}) {
  const tree = readTree(root);
  const reading = deriveParity({ scripts: tree.scripts, workflowText: tree.workflowText, exemptions });
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
