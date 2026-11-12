/**
 * The host test project cannot surface a new error while it already carries 167.
 *
 * `host/tsconfig.test.json` compiles every `src/**\/*.ts` plus the committed `*.test.ts`
 * files under the strictest options in the tree, and it has been red since before this gate:
 * 167 errors, all of them in committed test files (unused locals, `exactOptionalPropertyTypes`
 * violations, `noUncheckedIndexedAccess` holes). A red project reports a number nobody reads,
 * so the 181st error - the one a lane actually introduced - is invisible. That is not
 * hypothetical: a real `TS2304` in `host/src/stardew-game-integration-adapter.ts` sat unnoticed
 * through five commits, each of which reported its own scoped `tsc` as clean, until a *build*
 * failed on it.
 *
 * This gate turns that project into a ratchet: the baseline records how many errors of each
 * `TSxxxx` code the committed tree carries, and a code may never grow past its recorded count.
 * Errors that disappear are always fine (a ratchet only turns one way), which is why the
 * comparison is per code and not an exact error list: line numbers, messages and whole files
 * legitimately churn, and a rule that goes red on that churn is a rule that gets deleted.
 *
 * What it does not claim: the multiset is compared per code, so an error added and another
 * removed *within the same code* in one change is not caught. Site-level identity was tried and
 * rejected - it turns every rename, message reflow and line shift into a false finding.
 *
 * EVERY RUN PRINTS THE POPULATION IT JUDGED, BECAUSE `total=0` IS THREE DIFFERENT READINGS: the
 * project is genuinely clean, the run judged no file at all, or a filter removed everything it
 * looked at. All three used to print `test_typecheck_ratchet_ok total=0`, and only the first is a
 * measurement. So each run states `examined <n> of <m> .test.ts files in tsconfig.test.json` - a file
 * is examined when an error in it would count, which is why an uncommitted exclusion shows up in that
 * number - derived from tsc's own `--listFiles` output rather than from a directory listing that could
 * disagree with the compiler, and a run that examined no file - or whose errors all sit in files it
 * refuses to judge - is `test_typecheck_not_measured:<reason>` and exits 1. There is no flag to
 * accept that reading: a test project whose zero was produced by looking at nothing is not a
 * ratchet anyone can act on, and the two readings that were merged are exactly why this gate went
 * `ok` over a tree nobody had typechecked.
 *
 * THE PROJECT IS NAMED BECAUSE `tsconfig.json` EXCLUDES TESTS: `pnpm typecheck` runs
 * `tsc --project tsconfig.json` first, and that project excludes `src/**\/*.test.ts`, so its green
 * line covers no test file at all. This ratchet types against `tsconfig.test.json`, which
 * re-includes them - its own `include`/`exclude` replace the base's, which is why the population
 * below is non-empty - and it prints that project name in every line, so a `typecheck` pass cannot
 * be read as covering tests. A `.test.ts` file that exists on disk but is absent from the compiled
 * file list is `test_typecheck_not_measured:tsconfig_excludes_test_files` naming the files: the
 * derivation, not the comparison, is then the defect.
 *
 * THE UNCOMMITTED EXCLUSION IS PUBLISHED, NOT SILENT. Errors in files git reports as changed or
 * untracked are still not ratcheted: this repository is worked by several lanes in one worktree, a
 * lane's in-flight edit is not a landed error, and a gate that counts it fires on work that has not
 * shipped - the exact "cries wolf" failure that gets gates deleted. What changed is that the run
 * names what it left out (a bounded file list) and, when those files carry errors, says
 * `test_typecheck_not_measured:uncommitted_files_carry_errors` instead of `ok`: the verdict does
 * not cover them, and a green line would claim it did. `--include-dirty` judges them against the
 * committed baseline; on a clean checkout (CI) there is nothing to exclude and that is the raw
 * predicate.
 *
 * A syntactic error suppresses *all* semantic diagnostics (verified against tsc 5.9: a single
 * TS1109 in one file leaves every TS2xxx unreported), so the run says so when it sees one
 * rather than reporting a comforting drop to zero.
 *
 * Usage:
 *   node scripts/check-test-typecheck-ratchet.mjs                  # ratchet, excluding uncommitted files
 *   node scripts/check-test-typecheck-ratchet.mjs --include-dirty  # raw predicate (what CI runs)
 *   node scripts/check-test-typecheck-ratchet.mjs --update         # re-record, deliberately, in its own commit
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");
const baselinePath = join(hostRoot, "scripts", "test-typecheck-baseline.json");
const testProject = "tsconfig.test.json";
/** The one root the test project compiles, `host/`-relative. */
const testSourceRoot = "src";
/** How many paths a population line names before it summarises the rest. */
const NAMED_LIMIT = 5;
const errorPattern = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\): error (?<code>TS\d+): (?<message>.*)$/u;

const git = (args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim();

/** The codes tsc reports from its syntactic pass, so a run carrying one carries no semantic diagnostics. */
export const SYNTACTIC_ERROR = /^TS1\d{3}$/u;

/**
 * One child process's output, from whichever path produced it.
 *
 * A clean run returns its stdout; a red run throws with its stdout attached, and the exit code is what
 * separates a compile that reported errors from a compile that never ran. Both carry output the
 * caller needs - the success path carries the whole `--listFiles` list - so reading only the failure
 * path would report a clean project as having compiled nothing, which is the zero this gate exists to
 * stop mistaking for a measurement. `spawn` is a parameter so the two paths can be tested without one.
 */
export function captureRun({ spawn = execFileSync, command, args, options, label }) {
  try {
    return spawn(command, args, options);
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (typeof error.status !== "number") throw new Error(`could not run ${label}: ${output || error.message}`);
    return output;
  }
}

/** One tsc run over the test project; `listFiles` also makes it print every file it compiled. */
function runTsc({ host = hostRoot, listFiles = false }) {
  const tsc = join(host, "node_modules", "typescript", "lib", "tsc.js");
  if (!existsSync(tsc)) throw new Error(`no typescript to run: ${tsc}`);
  return captureRun({
    command: process.execPath,
    args: [tsc, "--project", testProject, "--noEmit", ...(listFiles ? ["--listFiles"] : [])],
    options: {
      cwd: host,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // The file list is proportional to the project, and a run whose output overflowed the default
      // buffer would be reported as a tsc that could not run.
      maxBuffer: 64 * 1024 * 1024,
    },
    label: `tsc for ${testProject}`,
  });
}

/**
 * Every error the test project reports, as `{ file, line, column, code, message }` with `file`
 * relative to `host/`. A syntactic error suppresses the semantic pass, so the caller is told
 * when that happened rather than being handed a shorter list.
 */
export function compileTestProject({ host = hostRoot } = {}) {
  return parseErrors(runTsc({ host }));
}

/**
 * The same compile, plus the files it actually compiled. The population the ratchet describes comes
 * from the compiler's `--listFiles` rather than from a scan of the directory, so "the project
 * compiles this test file" is the compiler's own answer and not a second copy of its rules.
 */
export function compileTestProjectFiles({ host = hostRoot } = {}) {
  const output = runTsc({ host, listFiles: true });
  return { errors: parseErrors(output), files: listedFiles({ output, host }) };
}

/** The parseable error lines of a tsc run, with paths normalised to forward slashes. */
export function parseErrors(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => errorPattern.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({
      file: match.groups.file.replace(/\\/gu, "/"),
      line: Number(match.groups.line),
      column: Number(match.groups.column),
      code: match.groups.code,
      message: match.groups.message,
    }));
}

/**
 * The paths a `--listFiles` run printed, `host/`-relative with forward slashes.
 *
 * tsc prints one path per line ahead of its diagnostics, absolute when the project names absolute
 * roots. A diagnostic is not a path and is dropped, and the set is deduplicated because the
 * population is a set of files rather than a count of mentions.
 */
export function listedFiles({ output, host = hostRoot }) {
  const files = new Set();
  for (const raw of output.split(/\r?\n/u)) {
    const path = raw.trim();
    if (!/\.(?:d\.)?[cm]?ts$/u.test(path) || errorPattern.test(path)) continue;
    files.add((isAbsolute(path) ? relative(host, path) : path).replace(/\\/gu, "/"));
  }
  return [...files];
}

/** The `src/**\/*.test.ts` files among `files`, `host/`-relative - the population this ratchet judges. */
export function testFiles(files) {
  return files.filter((file) => file.startsWith(`${testSourceRoot}/`) && file.endsWith(".test.ts"));
}

/** The `src/**\/*.test.ts` files on disk, `host/`-relative and sorted - what the project should compile. */
export function testFilesOnDisk({ host = hostRoot } = {}) {
  const source = join(host, testSourceRoot);
  if (!existsSync(source)) return [];
  return readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => `${testSourceRoot}/${relative(source, join(entry.parentPath, entry.name)).replace(/\\/gu, "/")}`)
    .sort();
}

/**
 * Which of the compiled test files this run cannot judge, and which test files the project does not
 * compile at all. The second list is the derivation defect the project name exists to expose.
 */
export function testFilePopulation({ compiled, onDisk, dirty }) {
  const files = testFiles(compiled);
  return {
    total: files.length,
    uncommitted: files.filter((file) => dirty.has(file)),
    excludedByProject: onDisk.filter((file) => !files.includes(file)),
  };
}

/**
 * Why this run examined nothing it can stand behind, or `undefined` when it examined its population.
 *
 * The four reasons are the ways a zero gets produced without a measurement: test files the project
 * does not compile, no test file anywhere, every test file uncommitted, and errors that were dropped
 * because their file is uncommitted. Each is a blocked reading that names itself, and the derivation
 * is asked before the population, so a project that compiles none of the test files on disk is named
 * as the derivation defect it is rather than as a repository that has no tests.
 */
export function notMeasuredReason({ population, examined, excludedErrors }) {
  if (population.excludedByProject.length > 0) return "tsconfig_excludes_test_files";
  if (population.total === 0) return "no_test_files_compiled";
  if (examined === 0) return "every_test_file_is_uncommitted";
  if (excludedErrors > 0) return "uncommitted_files_carry_errors";
  return undefined;
}

/** `N: path, path, … and K more` - a count alone would hide which file the run cannot see. */
export function describeFiles(files) {
  const sorted = [...files].sort();
  const rest = sorted.length - NAMED_LIMIT;
  return `${sorted.length}: ${sorted.slice(0, NAMED_LIMIT).join(", ")}${rest > 0 ? `, … and ${rest} more` : ""}`;
}

/** The line every run prints first: what it judged, and what it left out and why. */
export function populationLines({ population, examined, excludedErrors, includeDirty }) {
  const lines = [
    `test_typecheck_examined: examined ${examined} of ${population.total} .test.ts files in ${testProject} · ` +
      `excluded ${population.total - examined} (uncommitted ${population.uncommitted.length}, ` +
      `tsconfig-excluded ${population.excludedByProject.length}) · errors_excluded=${excludedErrors}`,
  ];
  if (population.uncommitted.length > 0)
    lines.push(
      `  ${includeDirty ? "included by --include-dirty" : "excluded as uncommitted"}: ${describeFiles(population.uncommitted)}`,
    );
  if (population.excludedByProject.length > 0)
    lines.push(`  not compiled by ${testProject}: ${describeFiles(population.excludedByProject)}`);
  return lines;
}

/**
 * The blocked reading, with the files that made it blocked. The line a reader greps carries the
 * population too, so the marker cannot be separated from the number it explains.
 */
export function notMeasuredLines({ reason, population, examined, discarded }) {
  const detail = {
    no_test_files_compiled: `this repository has no .test.ts file for ${testProject} to compile, so this ratchet has no population`,
    tsconfig_excludes_test_files: `${testProject} does not compile ${describeFiles(population.excludedByProject)}, so those test files are not typechecked by the project this ratchet trusts`,
    every_test_file_is_uncommitted: `all ${population.total} .test.ts file(s) are uncommitted: ${describeFiles(population.uncommitted)}`,
    uncommitted_files_carry_errors: `${discarded.length} error(s) in uncommitted file(s) ${describeFiles([...new Set(discarded.map((error) => error.file))])} are not judged`,
  }[reason];
  return [
    `test_typecheck_not_measured:${reason} examined=${examined} of=${population.total} errors_excluded=${discarded.length}`,
    `  ${detail}`,
    "  this run did not judge that population, so it is not a pass: fix what is named above, or judge every file with " +
      "node scripts/check-test-typecheck-ratchet.mjs --include-dirty",
  ];
}

/** How many errors of each code a run carries. */
export function countsByCode(errors) {
  const counts = {};
  for (const error of errors) counts[error.code] = (counts[error.code] ?? 0) + 1;
  return counts;
}

/** `host/`-relative paths of every file git reports as changed or untracked. */
export function uncommittedFiles({ repo = repositoryRoot } = {}) {
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  });
  const files = new Set();
  for (const line of status.split(/\r?\n/u)) {
    if (line.length < 4) continue;
    let path = line.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.replace(/^"|"$/gu, "").replace(/\\/gu, "/");
    const prefix = "host/";
    if (path.startsWith(prefix)) files.add(path.slice(prefix.length));
  }
  return files;
}

/**
 * The codes whose count grew past the baseline, with the errors that carry them - the new
 * ones are named, so the reader is not left to diff two lists by hand.
 */
export function ratchet({ baseline, errors }) {
  const current = countsByCode(errors);
  const grown = Object.keys(current)
    .filter((code) => current[code] > (baseline.codes[code] ?? 0))
    .sort();
  return {
    grew: grown,
    current,
    baseline: baseline.codes,
    reported: errors.filter((error) => grown.includes(error.code)),
  };
}

/** The presentable run: `--update` records, otherwise the ratchet decides. */
function main(argv) {
  const update = argv.includes("--update");
  const includeDirty = update || argv.includes("--include-dirty");
  const { errors: allErrors, files: compiled } = compileTestProjectFiles();
  const dirty = uncommittedFiles();
  const population = testFilePopulation({ compiled, onDisk: testFilesOnDisk(), dirty });
  const discarded = includeDirty ? [] : allErrors.filter((error) => dirty.has(error.file));
  const errors = includeDirty ? allErrors : allErrors.filter((error) => !dirty.has(error.file));
  const examined = includeDirty ? population.total : population.total - population.uncommitted.length;
  const syntactic = allErrors.filter((error) => SYNTACTIC_ERROR.test(error.code));

  for (const line of populationLines({ population, examined, excludedErrors: discarded.length, includeDirty }))
    process.stdout.write(`${line}\n`);

  if (update) {
    const baseline = {
      note: "Per-code error counts of host/tsconfig.test.json, recorded from the committed tree. Update deliberately, in its own commit.",
      revision: git(["rev-parse", "--short", "HEAD"]),
      total: allErrors.length,
      codes: countsByCode(allErrors),
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(
      `test_typecheck_ratchet_recorded total=${baseline.total} revision=${baseline.revision} test_files=${population.total}\n`,
    );
    if (dirty.size > 0)
      process.stdout.write(`  warning: recorded with ${dirty.size} uncommitted host file(s) present\n`);
    return 0;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const result = ratchet({ baseline, errors });
  if (syntactic.length > 0)
    process.stdout.write(
      `test_typecheck_semantic_pass_skipped: ${syntactic.length} syntactic error(s) present, so tsc reported no semantic diagnostics at all\n`,
    );
  const reason = notMeasuredReason({ population, examined, excludedErrors: discarded.length });
  if (reason !== undefined)
    for (const line of notMeasuredLines({ reason, population, examined, discarded })) process.stdout.write(`${line}\n`);
  if (result.grew.length === 0) {
    if (reason !== undefined) return 1;
    process.stdout.write(
      `test_typecheck_ratchet_ok project=${testProject} total=${errors.length} baseline=${baseline.total} ` +
        `codes=${Object.keys(result.current).length} examined=${examined}/${population.total}\n`,
    );
    return 0;
  }
  const delta = result.reported.length - result.grew.reduce((sum, code) => sum + (baseline.codes[code] ?? 0), 0);
  process.stdout.write(`test_typecheck_ratchet_failed new=${delta}\n`);
  for (const code of result.grew)
    process.stdout.write(`  ${code}: ${baseline.codes[code] ?? 0} -> ${result.current[code]}\n`);
  for (const error of result.reported)
    process.stdout.write(`    ${error.file}:${error.line}:${error.column} ${error.code}: ${error.message}\n`);
  process.stdout.write(
    `the test project grew past its recorded counts; fix the new error or re-record deliberately with: node scripts/check-test-typecheck-ratchet.mjs --update\n`,
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
