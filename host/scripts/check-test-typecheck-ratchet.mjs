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
 * Uncommitted files are not ratcheted. This repository is worked by several lanes in one
 * worktree; a lane's in-flight edit is not a landed error, and a gate that counts it fires on
 * work that has not shipped - the exact "cries wolf" failure that gets gates deleted. On a
 * clean checkout (CI) there is nothing to exclude and the predicate is the raw one, which
 * `--include-dirty` runs locally.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");
const baselinePath = join(hostRoot, "scripts", "test-typecheck-baseline.json");
const testProject = "tsconfig.test.json";
const errorPattern = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\): error (?<code>TS\d+): (?<message>.*)$/u;

const git = (args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim();

/** The codes tsc reports from its syntactic pass, so a run carrying one carries no semantic diagnostics. */
export const SYNTACTIC_ERROR = /^TS1\d{3}$/u;

/**
 * Every error the test project reports, as `{ file, line, column, code, message }` with `file`
 * relative to `host/`. A syntactic error suppresses the semantic pass, so the caller is told
 * when that happened rather than being handed a shorter list.
 */
export function compileTestProject({ host = hostRoot } = {}) {
  const tsc = join(host, "node_modules", "typescript", "lib", "tsc.js");
  if (!existsSync(tsc)) throw new Error(`no typescript to run: ${tsc}`);
  let output = "";
  try {
    execFileSync(process.execPath, [tsc, "--project", testProject, "--noEmit"], {
      cwd: host,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (typeof error.status !== "number") throw new Error(`could not run tsc for ${testProject}: ${output || error.message}`);
  }
  return parseErrors(output);
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
  const allErrors = compileTestProject();
  const dirty = uncommittedFiles();
  const errors = includeDirty ? allErrors : allErrors.filter((error) => !dirty.has(error.file));
  const syntactic = allErrors.filter((error) => SYNTACTIC_ERROR.test(error.code));
  const excluded = allErrors.length - errors.length;

  if (update) {
    const baseline = {
      note: "Per-code error counts of host/tsconfig.test.json, recorded from the committed tree. Update deliberately, in its own commit.",
      revision: git(["rev-parse", "--short", "HEAD"]),
      total: allErrors.length,
      codes: countsByCode(allErrors),
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`test_typecheck_ratchet_recorded total=${baseline.total} revision=${baseline.revision}\n`);
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
  if (excluded > 0)
    process.stdout.write(`test_typecheck_ratchet_excluded=${excluded} error(s) in ${dirty.size} uncommitted file(s)\n`);
  if (result.grew.length === 0) {
    process.stdout.write(
      `test_typecheck_ratchet_ok total=${errors.length} baseline=${baseline.total} codes=${Object.keys(result.current).length}\n`,
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
