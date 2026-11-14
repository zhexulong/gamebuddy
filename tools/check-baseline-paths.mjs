#!/usr/bin/env node
/**
 * DOES EVERY FILE A BASELINE NAMES STILL EXIST?
 *
 * WHY. Measured 2026-11-14, at `b6128a58` ("six runners retire into their contracts"). One commit deleted six smoke
 * runners and left three baselines naming four of them by filename:
 *
 *   tools/baselines/native-local-runner-scaffold.json  its own gate reported `stale_baseline` in the same commit
 *   tools/duplicate-code-baseline.json                 its own gate reported `stale_clone_baseline`, fixed later
 *   tools/prelive-l3-baseline.json                     nothing notices: `baseline_stale` for `shake-tree` and
 *                                                      `take-pedestal-item`, still red at HEAD, nobody able to say why
 *
 * Two of those three baselines have a self-check that fires when an entry's subject is gone. The third is a list of
 * runner names read through a directory scan, so an entry for a deleted runner produces no violation - it produces
 * silence, and a ratchet that cannot shrink is a ratchet that reads as green. THE CLASS: a baseline is a list of real
 * file paths, and nothing asserts that the paths still exist. Fixing the third instance buys one instance; the question
 * every baseline answers silently is "is this still a file", so this gate asks it of all of them.
 *
 * WHAT A PATH REFERENCE IS, and the rule is deliberately narrow so that a balance of not-checked things is stated
 * rather than assumed. A string is a path reference when BOTH hold:
 *
 *   1. its key is `file`, `files`, `path` or `paths` - the vocabulary a baseline uses to name a MEMBER of its
 *      population, whatever nesting it sits under (`entries[].file`, `baselines.x.files[]`, ...); and
 *   2. its value is one path token: `[A-Za-z0-9_.@/-]+`, no space, no `..`, not absolute, ending in a source or config
 *      extension (`mjs cjs js ts tsx jsx json md ps1 cs yml yaml toml csproj sln txt png`).
 *
 * EXAMPLE, checked: `tools/stardew-lifecycle-pin-baseline.json` records 48 C# tests as
 * `GameBuddy.Stardew.Core.Tests/CandidateActionRegistrationTests.cs`, a path that does not exist from the repository
 * root because the owning gate reads its tests from `integrations/stardew/tests/`. So a reference RESOLVES when the
 * index carries that exact path, or carries a path that ENDS with `/<reference>` at a segment boundary - the tail is the
 * identity, because this gate cannot know which directory a baseline's owning gate reads from.
 *
 * NON-EXAMPLE, not checked: `tools/action-breadth-baseline.json`'s `baselines.multiday_routine.bundle` is
 * `tools/_multiday_routine-round38.result.json`. That key names the RUN ARTIFACT the analysis gate re-reads, not a member
 * the baseline judges, and `/tools/_*` is a gitignored artifact namespace (`.gitignore`), so recording it is provenance
 * and not a claim the repository carries the file. A `bundle` reference is out of this rule by its key, and so is every
 * prose string with a space in it, every label without an extension, and every `reason` that happens to quote a path.
 *
 * WHAT THIS DOES NOT SEE, said out loud: a reference whose TAIL survives somewhere else, because a baseline naming
 * `tools/foo.mjs` still resolves if the file now lives at `scratch/tools/foo.mjs`; a baseline that names its members
 * under a key this rule does not know (`runner`, `site`, `entry`), which is why the census prints the reference count -
 * a baseline that stops contributing references is visible there; the CONTENT of a named file; and whether an entry is
 * stale for its own reason (prelive's `count` dropped, the scaffold's runner now conforms) - that reading belongs to the
 * owning gate, and this one only ever says "that path is not in the index".
 *
 * THE POPULATION comes from the index, never from a list here: every tracked `*.json` under `tools/` whose file name
 * contains `baseline`, plus every tracked file under `tools/baselines/`. Measured on this tree: 24 baselines, 381 path
 * references. One `git ls-files -z` answers both halves of the question, so the population and the resolution rule cannot
 * disagree about what exists.
 *
 * RESOLUTION IS THE INDEX, NOT THE WORKTREE, and both sides of that choice were reasoned rather than defaulted. A path
 * that exists only as untracked scratch counts as MISSING: a baseline is committed content, so a reference it cannot
 * resolve for everyone is a reference that is wrong for everyone but its author. An ignored path counts as missing for
 * the same reason, which is why an artifact reference is excluded by its key above instead of being silently resolved.
 * The baseline CONTENT is read from the worktree, because the population is the set of paths a commit would carry and the
 * content is the newest version of exactly those paths - `git ls-files` for what exists, the file for what it says.
 *
 * ZERO POPULATION IS BLOCKED, NEVER GREEN: a root with no baseline under `tools/`, a git index git refuses to answer, and
 * a tracked baseline that does not parse each print a `not_measured:` line (or `baseline_gate_no_population:`) and exit
 * 2. "Every path a baseline names exists" is a claim about a population, and a population of nothing agrees with it.
 *
 * REPORT, DO NOT FIX. The finding names the baseline and the path and stops there. Deleting the entry is the owning
 * gate's job - `tools/check-native-local-runner-scaffold.mjs --record-shrinks` for its baseline, `--write-baseline` for
 * `tools/check-red-proof-markers.mjs` - and a baseline this gate edited would be a baseline whose own ratchet never
 * learned the entry was gone.
 *
 * VERDICT. `baselines examined N · path references M · dangling K`, then one line per finding. Exit 0 no dangling
 * reference, 1 a finding, 2 blocked.
 *
 * red-proof: history  the index and the baselines at `b6128a58`, the commit that retired six runners ->
 *   `baseline_names_a_file_that_does_not_exist:tools/prelive-l3-baseline.json:<the two retired runner names>`
 *   (tools/check-baseline-paths.test.mjs)
 * red-proof: inject  a fabricated path added to a baseline in a fixture repository ->
 *   `baseline_names_a_file_that_does_not_exist:<baseline>:<the fabricated path>`, exactly one finding
 *   (tools/check-baseline-paths.test.mjs)
 * red-proof: inject  a file present in the working tree and absent from the index, named by a baseline -> still a
 *   finding; `git add` of the same file makes it green, so the reading is the index and not the disk
 *   (tools/check-baseline-paths.test.mjs)
 * red-proof: inject  a root with no baseline under `tools/`, and an unparseable tracked baseline ->
 *   `baseline_gate_no_population`, `not_measured:baseline_gate_unreadable_baseline`, exit 2
 *   (tools/check-baseline-paths.test.mjs)
 *
 * USAGE
 *   node tools/check-baseline-paths.mjs
 *   node tools/check-baseline-paths.mjs --json
 *   node tools/check-baseline-paths.mjs --root <dir>
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

/** The key whose value names a baseline's member. A key outside this set names an input, a label or prose. */
export const REFERENCE_KEY = /^(?:file|files|path|paths)$/u;

/** One path token with a source or config extension. A sentence, a label or a bare id is not a reference. */
const PATH_TOKEN = /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.[A-Za-z0-9]+$/u;
const SOURCE_EXTENSION = /\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|ps1|cs|yml|yaml|toml|csproj|sln|txt|png)$/u;

/** The population's two clauses: a baseline-named `*.json` under `tools/`, and everything under `tools/baselines/`. */
const TOOLS = "tools/";
const BASELINES_DIRECTORY = "tools/baselines/";
const BASELINE_NAME = /baseline/u;

/** A path whose segments reach above the repository root is not a path this gate can resolve, so it is not one it reads. */
const ESCAPES_ROOT = /(?:^|\/)\.\.(?:\/|$)/u;

export const SCHEMA = "gamebuddy-baseline-paths/v1";

/**
 * The index, as the set of tracked paths. A `throw` rather than an empty set when git cannot answer: an empty index
 * resolves nothing, so it would report every reference in the tree as dangling - the loudest possible lie.
 */
export function readIndex({ root = ROOT } = {}) {
  let output;
  try {
    output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`could not read the index under ${root}: ${String(error?.message ?? error)}`);
  }
  return new Set(
    output
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replace(/\\/gu, "/")),
  );
}

/** The baselines this gate reads: derived from the index, so a baseline written tomorrow is judged the moment it is tracked. */
export function baselinePopulation({ index }) {
  return [...index]
    .filter((file) => file.startsWith(TOOLS) && file.endsWith(".json"))
    .filter((file) => file.startsWith(BASELINES_DIRECTORY) || BASELINE_NAME.test(file.slice(file.lastIndexOf("/") + 1)))
    .sort();
}

/** Is this string a path token this gate reads? Both halves of the rule, in the order the docblock states them. */
export function isPathReference(value) {
  return (
    typeof value === "string" && PATH_TOKEN.test(value) && SOURCE_EXTENSION.test(value) && !ESCAPES_ROOT.test(value)
  );
}

/**
 * Every path reference inside one parsed baseline, with the JSON pointer it sits at.
 *
 * The key is carried down an array so `files: [...]` reads its elements as references, while an element of `knownSites`
 * is read by its own `file` key and nothing above it.
 */
export function pathReferences(value, { pointer = "$", key = null, out = [] } = {}) {
  if (typeof value === "string") {
    if (key !== null && REFERENCE_KEY.test(key) && isPathReference(value)) out.push({ pointer, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, position) => pathReferences(entry, { pointer: `${pointer}[${position}]`, key, out }));
    return out;
  }
  if (value !== null && typeof value === "object")
    for (const [child, entry] of Object.entries(value))
      pathReferences(entry, { pointer: `${pointer}.${child}`, key: child, out });
  return out;
}

/** Exact path first, then the segment tail: a baseline may name its members relative to its owning gate's own root. */
export function resolves(value, { index }) {
  if (index.has(value)) return true;
  const tail = `/${value}`;
  for (const path of index) if (path.endsWith(tail)) return true;
  return false;
}

/** A reading that could not be made. Blocked, exit 2, with the reason - never an empty population that agrees with itself. */
export function blocked(code, detail) {
  return Object.freeze({
    schema: SCHEMA,
    blocked: code,
    detail,
    examined: 0,
    references: 0,
    dangling: 0,
    baselines: Object.freeze([]),
    findings: Object.freeze([]),
    ok: false,
  });
}

/**
 * The verdict over `baselines`, which is `[{ file, parsed }]`, against `index`, a Set of tracked paths.
 *
 * Both are handed in so a falsifier drives the real rule over a fixture repository instead of editing this one.
 */
export function checkBaselinePaths({ baselines, index }) {
  if (baselines.length === 0)
    return blocked(
      "baseline_gate_no_population",
      "no tracked *.json under tools/ whose name contains `baseline`, and nothing under tools/baselines/ - a gate that read no baseline agrees with itself",
    );
  const findings = [];
  const rows = [];
  let references = 0;
  for (const baseline of baselines) {
    const found = pathReferences(baseline.parsed);
    references += found.length;
    for (const reference of found) {
      const present = resolves(reference.value, { index });
      rows.push({ baseline: baseline.file, pointer: reference.pointer, value: reference.value, present });
      if (!present) findings.push(`baseline_names_a_file_that_does_not_exist:${baseline.file}:${reference.value}`);
    }
  }
  return Object.freeze({
    schema: SCHEMA,
    blocked: null,
    detail: null,
    examined: baselines.length,
    references,
    dangling: findings.length,
    baselines: Object.freeze(baselines.map((baseline) => baseline.file)),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    findings: Object.freeze(findings),
    ok: findings.length === 0,
  });
}

export function renderBaselinePathsReport(report) {
  if (report.blocked !== null) return [`${report.blocked}: ${report.detail}`];
  const lines = [
    `baselines examined ${report.examined} · path references ${report.references} · dangling ${report.dangling}`,
  ];
  for (const finding of report.findings) lines.push(finding);
  lines.push(
    report.ok
      ? `  green: every path the ${report.examined} baselines name is in the index`
      : `  ${report.findings.length} baseline(s) name a file the index does not carry - the owning gate deletes the entry`,
  );
  return lines;
}

/** The whole run over a root: the index decides what exists and which baselines there are; the file says what it claims. */
export function runBaselinePathsGate({ root = ROOT } = {}) {
  let index;
  try {
    index = readIndex({ root });
  } catch (error) {
    return blocked("not_measured:baseline_gate_index_unreadable", String(error?.message ?? error));
  }
  const files = baselinePopulation({ index });
  const baselines = [];
  for (const file of files) {
    try {
      baselines.push({ file, parsed: JSON.parse(readFileSync(resolve(root, file), "utf8")) });
    } catch (error) {
      return blocked("not_measured:baseline_gate_unreadable_baseline", `${file}: ${String(error?.message ?? error)}`);
    }
  }
  return checkBaselinePaths({ baselines, index });
}

async function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag < 0 ? ROOT : resolve(argv[rootFlag + 1] ?? ".");
  const report = runBaselinePathsGate({ root });
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else for (const line of renderBaselinePathsReport(report)) process.stdout.write(`${line}\n`);
  process.exitCode = report.blocked !== null ? 2 : Number(!report.ok);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
