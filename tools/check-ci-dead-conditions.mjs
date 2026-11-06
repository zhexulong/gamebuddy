#!/usr/bin/env node
/**
 * CI dead-condition gate: an `if:` that reads an `env.NAME` nothing sets is a branch that can never run.
 *
 * WHY (the accident, measured 2026-09-29 -> 2026-11-02)
 *
 * `.github/workflows/ci.yml` read `env.GAMEBUDDY_STARDEW_GAME_PATH` in two step conditions, and no step,
 * job or workflow in that file ever set it. Both suites behind those conditions skipped on every run, the
 * job's verdict was `success` either way, and the artefact checks they guard went unexecuted for five
 * weeks - the dates are that file's own, written when the workaround step was added. A skipped step and a
 * passing step are the same colour in a job summary, so the only thing that would have named this is a
 * check that compares what a condition READS against what the file WRITES. That is this gate.
 *
 * WHAT IS READ: THE POPULATION IS THE DIRECTORY, THE JUDGEMENT IS DERIVED
 *
 * Every `.yml` / `.yaml` file under `.github/workflows` (a directory scan, so a new workflow joins on its
 * own and a renamed one cannot be forgotten). For each job:
 *
 *   reads   every `env.NAME` / `env['NAME']` / `env["NAME"]` in an `if:` - job level or step level, inside
 *           `${{ }}` or bare.
 *   writes  the keys of a workflow-level, job-level or step-level `env:` block (flow mapping included),
 *           and every `NAME=value` / `NAME<<EOF` appended to the run's env file, in all three spellings a
 *           step can use: `>> $GITHUB_ENV`, `>> "$GITHUB_ENV"` and PowerShell's `$env:GITHUB_ENV`.
 *
 * A read with no write anywhere in its job is `dead_ci_condition:<workflow>:<job>:<NAME>`, and the message
 * carries the diff rather than a count: `+ newly added:` is what that job's conditions read, `- missing:`
 * is which of those no write source provides. One number would say a dead branch exists and leave the
 * operator to find it in a 570-line file.
 *
 * WHY A LINE-BASED STATE MACHINE, NOT A YAML LIBRARY
 *
 * `package.json` declares no YAML dependency (neither `yaml` nor `js-yaml` is a direct dependency), and
 * this gate may not add one. The subset a workflow's conditions and env blocks use is small: block
 * mappings, list items and `|` / `>` scalars. Read line by line, that subset is decidable, and the
 * limitations are stated here rather than discovered later:
 *
 *   - a `run:` heredoc whose `KEY<<EOF` line is separate from the `>> $GITHUB_ENV` closing brace is not
 *     read (its write source is missed, so a condition behind it is reported, not silently passed);
 *   - a `#` outside quotes starts a comment, as it does in YAML and in both shells, so quoted text is safe;
 *   - `secrets.*`, `vars.*` and `inputs.*` are a different namespace and are not this gate's business - it
 *     asks only whether the thing an `if:` reads from `env` can ever exist.
 *
 * Output: one report line on stdout and the JSON verdict
 * `{"gate":"ci-dead-conditions","examined":N,"violations":[...],"status":...}`. `examined` counts the
 * workflow files actually read; zero of them is `status:"blocked"` and exit 1, because a gate that
 * measured no file has not passed.
 *
 * Usage:
 *   node tools/check-ci-dead-conditions.mjs                 # the repository's own workflows
 *   node tools/check-ci-dead-conditions.mjs --root <dir>    # a fixture tree's `.github/workflows`
 *
 * red-proof: inject  a workflow whose `if: env.NEVER_SET != ''` no step ever sets ->
 *            `dead_ci_condition:ci.yml:quality:NEVER_SET` with the `+ newly added:` / `- missing:` diff
 *            (tools/check-ci-dead-conditions.test.mjs; declared in `env:` or `$GITHUB_ENV`, it reports nothing).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";
const WORKFLOW_FILE = /\.ya?ml$/u;

/** `env.NAME`, as an expression reads it. A lookbehind keeps `steps.x.env.NAME` from reading as `env.NAME`. */
const ENV_DOT_READ = /(?<![A-Za-z0-9_.])env\.([A-Za-z_][A-Za-z0-9_]*)/gu;
/** `env['NAME']` and `env["NAME"]`, which index the same mapping. */
const ENV_INDEX_READ = /(?<![A-Za-z0-9_.])env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/gu;
/** The three spellings of the per-run env file: bash `$GITHUB_ENV` / `${GITHUB_ENV}`, PowerShell, cmd. */
const GITHUB_ENV_TARGET = /\$\{GITHUB_ENV\}|\$GITHUB_ENV\b|\$env:GITHUB_ENV\b|%GITHUB_ENV%/u;
/** `NAME=value`, and the `NAME<<EOF` heredoc key, as written to that file. */
const ENV_ASSIGNMENT = /(?:^|[\s"'`])([A-Za-z_][A-Za-z0-9_]*)(?:=|<<)/gu;
/** A value that opens a block scalar instead of holding one: `|`, `|-`, `>`, `>-`. */
const SCALAR_HEADER = /^[>|][+-]?$/u;
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/u;
const LIST_ITEM = /^-(?:\s|$)/u;

const indentOf = (line) => /^ */u.exec(line)[0].length;

/**
 * A line with its YAML comment removed. `#` starts a comment at line start or after whitespace and only
 * outside a quoted scalar, so `echo "a # b" >> $GITHUB_ENV` stays one command and a `#` in prose still goes.
 */
function stripLineComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = null;
      continue;
    }
    if (quote === null && character === "#" && (index === 0 || /\s/u.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

const keyLine = (text) => {
  const match = KEY_LINE.exec(text);
  return match === null ? null : { key: match[1], value: match[2].trim() };
};

/** Env names an `if:` expression reads, in both the dotted and the indexed form. */
export function ifReads(expression) {
  const names = new Set();
  for (const pattern of [ENV_DOT_READ, ENV_INDEX_READ]) {
    for (const match of expression.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

/** Env names a single shell line writes to the run's env file, or none when it never names it. */
function shellWritesOn(line) {
  const target = GITHUB_ENV_TARGET.exec(line);
  if (target === null) return [];
  return [...line.slice(0, target.index).matchAll(ENV_ASSIGNMENT)].map((match) => match[1]);
}

/** A shell line rejoined with the lines it continues onto, with `\` (bash) and `` ` `` (PowerShell). */
function joinContinuations(lines) {
  const logical = [];
  let pending = null;
  for (const line of lines) {
    const current = pending === null ? line : `${pending} ${line.trim()}`;
    if (/(?:\\|`)\s*$/u.test(current)) {
      pending = current.replace(/(?:\\|`)\s*$/u, "");
      continue;
    }
    pending = null;
    logical.push(current);
  }
  if (pending !== null) logical.push(pending);
  return logical;
}

/** Env names written by a `run:` script, line by line. */
export function shellWrites(text) {
  const names = new Set();
  for (const line of joinContinuations(text.split(/\r?\n/u))) {
    for (const name of shellWritesOn(line)) names.add(name);
  }
  return names;
}

/** Env names declared by a one-line flow mapping: `env: { NAME: value }`. */
const flowEnvNames = (value) => [...value.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/gu)].map((match) => match[1]);

/**
 * The scanner's whole state: the workflow's own env, one read/write pair per job, and where in the file it
 * currently is. `scalar` is the `|` / `>` block being collected; `envBlock` is the `env:` mapping being read.
 */
const newScan = () => ({
  workflowEnv: new Set(),
  jobs: new Map(),
  job: null,
  inJobs: false,
  jobIndent: -1,
  envBlock: null,
  scalar: null,
});

/** One job's pair, created on first mention so a job with no `env:` still has somewhere to accumulate. */
function jobEntry(state, name) {
  if (!state.jobs.has(name)) state.jobs.set(name, { reads: new Set(), writes: new Set() });
  return state.jobs.get(name);
}

/** A finished block scalar, folded into what it was collecting. */
function closeScalar(state) {
  if (state.scalar === null) return;
  const closed = state.scalar;
  state.scalar = null;
  if (closed.job === null) return;
  const names = closed.kind === "shell" ? shellWrites(closed.lines.join("\n")) : ifReads(closed.lines.join(" "));
  const target = closed.kind === "shell" ? jobEntry(state, closed.job).writes : jobEntry(state, closed.job).reads;
  for (const name of names) target.add(name);
}

function declareEnv(state, indent, value, target) {
  if (value === "") {
    state.envBlock = { indent, target };
    return;
  }
  for (const name of flowEnvNames(value)) target.add(name);
}

function declareCondition(state, indent, value) {
  if (SCALAR_HEADER.test(value)) {
    state.scalar = { indent, kind: "if", job: state.job, lines: [] };
    return;
  }
  for (const name of ifReads(value)) jobEntry(state, state.job).reads.add(name);
}

function declareRun(state, indent, value) {
  if (SCALAR_HEADER.test(value)) {
    state.scalar = { indent, kind: "shell", job: state.job, lines: [] };
    return;
  }
  for (const name of shellWrites(value)) jobEntry(state, state.job).writes.add(name);
}

/** A block scalar swallows every more-indented line; the first dedent ends it and is read normally. */
function consumeScalarLine(state, line) {
  if (state.scalar === null) return false;
  if (line.trim() !== "" && indentOf(line) > state.scalar.indent) {
    state.scalar.lines.push(line);
    return true;
  }
  closeScalar(state);
  return false;
}

/** An `env:` mapping swallows its more-indented keys; the first dedent ends it and is read normally. */
function consumeEnvLine(state, line) {
  if (state.envBlock === null) return false;
  if (line.trim() === "") return true;
  const entry = keyLine(line.trim());
  if (entry === null || indentOf(line) <= state.envBlock.indent) {
    state.envBlock = null;
    return false;
  }
  state.envBlock.target.add(entry.key);
  return true;
}

/** A top-level key: `jobs:` opens the job block, `env:` declares for every job at once. */
function readTopLevelKey(state, { key, value }, indent) {
  state.job = null;
  state.jobIndent = -1;
  state.inJobs = key === "jobs" && value === "";
  if (key === "env") declareEnv(state, indent, value, state.workflowEnv);
}

/** A key inside the job block: a job's name, or one of the three keys this gate reads. */
function readJobKey(state, { key, value }, indent, isItem) {
  if (!state.inJobs) return;
  if (state.jobIndent === -1 && !isItem) state.jobIndent = indent;
  if (!isItem && indent === state.jobIndent) {
    state.job = key;
    jobEntry(state, key);
    return;
  }
  if (state.job === null) return;
  if (key === "env") return declareEnv(state, indent, value, jobEntry(state, state.job).writes);
  if (key === "if") return declareCondition(state, indent, value);
  if (key === "run") declareRun(state, indent, value);
}

/** Every line of one workflow, reduced to what each job's conditions read and what can write it. */
export function scanWorkflow(text) {
  const state = newScan();
  for (const line of text.split(/\r?\n/u).map(stripLineComment)) {
    if (consumeScalarLine(state, line) || consumeEnvLine(state, line)) continue;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const indent = indentOf(line);
    const isItem = LIST_ITEM.test(trimmed);
    const entry = keyLine(isItem ? trimmed.replace(/^-\s*/u, "") : trimmed);
    if (entry === null) continue;
    if (indent === 0 && !isItem) readTopLevelKey(state, entry, indent);
    else readJobKey(state, entry, indent, isItem);
  }
  closeScalar(state);
  return { workflowEnv: state.workflowEnv, jobs: state.jobs };
}

/**
 * Every condition no write source can satisfy, one violation per variable, each carrying the job's whole
 * read set (`newlyAdded`, the `+` side) and the dead subset (`missing`, the `-` side).
 */
export function deriveDeadConditions(workflows) {
  const violations = [];
  for (const { file, text } of workflows) {
    const { workflowEnv, jobs } = scanWorkflow(text);
    for (const [name, job] of [...jobs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const newlyAdded = [...job.reads].sort();
      if (newlyAdded.length === 0) continue;
      const writes = new Set([...workflowEnv, ...job.writes]);
      const missing = newlyAdded.filter((read) => !writes.has(read));
      for (const variable of missing) {
        violations.push({
          code: `dead_ci_condition:${file}:${name}:${variable}`,
          workflow: file,
          job: name,
          variable,
          newlyAdded,
          missing,
        });
      }
    }
  }
  return violations;
}

/** The workflow files under a root's `.github/workflows`, sorted, and how many were read. */
export function scanWorkflows({ root = REPOSITORY_ROOT } = {}) {
  const directory = join(root, WORKFLOW_DIR);
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return { examined: 0, workflows: [] };
  }
  const workflows = entries
    .filter((name) => WORKFLOW_FILE.test(name))
    .sort()
    .map((name) => ({ file: name, text: readFileSync(join(directory, name), "utf8") }));
  return { examined: workflows.length, workflows };
}

const verdictOf = (examined, violations) => {
  if (examined === 0) return "blocked";
  return violations.length === 0 ? "passed" : "failed";
};

/** The whole reading: how many workflow files were examined, what is dead, and the verdict. */
export function auditDeadConditions({ root = REPOSITORY_ROOT } = {}) {
  const { examined, workflows } = scanWorkflows({ root });
  const violations = deriveDeadConditions(workflows);
  return { examined, violations, status: verdictOf(examined, violations) };
}

/**
 * The report: one line saying what was examined (the reading the verdict rests on), the violations with
 * both sides of their diff, and the JSON verdict last.
 */
export function report({ examined, violations, status }, { out = process.stdout, err = process.stderr } = {}) {
  if (examined === 0) {
    err.write(
      `ci_dead_conditions_no_workflow_files: ${WORKFLOW_DIR} holds no workflow file to read, so nothing was examined\n`,
    );
  }
  out.write(`ci_dead_conditions examined ${examined} workflow file(s), ${violations.length} dead condition(s)\n`);
  for (const violation of violations) {
    err.write(`${violation.code}\n`);
    err.write(`  + newly added: [${violation.newlyAdded.join(", ")}]\n`);
    err.write(`  - missing: [${violation.missing.join(", ")}]\n`);
  }
  out.write(`${JSON.stringify({ gate: "ci-dead-conditions", examined, violations, status })}\n`);
  return status === "passed" ? 0 : 1;
}

const argumentAfter = (argv, flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

function main(argv) {
  const root = argumentAfter(argv, "--root") ?? REPOSITORY_ROOT;
  return report(auditDeadConditions({ root }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
