/**
 * The repo-wide lint step cannot be read while 87 errors are red.
 *
 * `pnpm lint` (`biome lint tools host/src dialogue-web/src vendor/pi-koe/src`) is red with 88 errors
 * over 70 files, so the number says nothing about the file a lane just touched. The lint step and
 * the formatter step were added to the same CI job in the same commit (`b9650bd9`, 2026-08-21
 * 23:24), and the formatter step ahead of it was a repo-wide red (682 files) until its own ratchet
 * landed (`e90da3b2`, 2026-10-14 04:30) - so the host job died before the lint line and the lint
 * step had never once executed. Its first real execution (CI run 38582152926) found 87 errors over
 * 69 files at `05706f32`; a commit landing while this gate was written (`1ea90abe`) added one more,
 * which the baseline records as debt rather than hiding. The step was born behind a red step and has
 * never been green.
 *
 * What is readable is a ratchet over the files the linter reports errors in: the baseline records
 * today's set (per file, how many errors), a file that is not in it and has errors fails the gate,
 * a recorded file whose error count grows fails the gate, and every run prints the live error and
 * warning totals so the debt stays visible instead of becoming invisible when the step is skipped.
 * The baseline only tightens - a file that starts passing is reported, and `--update` re-records
 * deliberately in its own commit - so re-record it whenever a change removes errors from the set.
 *
 * Warnings are published, never gated: `biome lint` exits non-zero on errors only, so gating
 * warnings would be a second policy this step never enforced.
 *
 * What it does not claim: a file already in the baseline can swap one error for a different one at
 * the same count without a new finding, because "did this change add an error here" needs the
 * committed bytes at a base, and CI checks out depth 1. The honest reading of this gate is "no file
 * newly joins the red set and no recorded file's error count grows", not "every new error fails".
 *
 * Usage:
 *   node tools/scripts/check-lint-ratchet.mjs                  # ratchet, publishing the totals
 *   node tools/scripts/check-lint-ratchet.mjs --update         # re-record, in its own commit
 *   node tools/scripts/check-lint-ratchet.mjs --root <dir>     # the gate's own fixture
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The roots `package.json`'s `lint` script names, unchanged. */
export const SCOPE = ["tools", "host/src", "dialogue-web/src", "vendor/pi-koe/src"];
const biomeBinary = join(repositoryRoot, "node_modules", "@biomejs", "biome", "bin", "biome");

const baselineFor = (root) => join(root, "tools", "scripts", "lint-baseline.json");

/**
 * Biome's machine-readable lint report: the run's own error/warning totals, the file count, and
 * per-file error counts. The report carries every diagnostic (no display cap), which is why this
 * gate asks for it instead of parsing the `--max-diagnostics`-truncated pretty output.
 */
export function parseReport(stdout) {
  const report = JSON.parse(stdout);
  const summary = report.summary;
  if (summary === undefined || !Array.isArray(report.diagnostics))
    throw new Error(`biome lint reported no JSON summary; the scan did not run:\n${stdout.slice(0, 2000)}`);
  const counts = new Map();
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.severity !== "error") continue;
    const file = diagnostic.location.path.file.replace(/\\/gu, "/");
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  const countsByFile = Object.fromEntries([...counts.keys()].sort().map((file) => [file, counts.get(file)]));
  return {
    errors: Number(summary.errors),
    warnings: Number(summary.warnings),
    checked: Number(summary.unchanged) + Number(summary.changed),
    counts: countsByFile,
  };
}

/** Runs the linter over the scope in `root`; the exit code is a violation, not a run failure. */
export function scan({ root = repositoryRoot } = {}) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [biomeBinary, "lint", "--reporter=json", ...SCOPE], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    // Errors are the normal case while the baseline is red; only a missing exit code is a failure.
    if (typeof error.status !== "number") throw new Error(`could not run biome lint in ${root}: ${error.message}`);
    stdout = error.stdout ?? "";
  }
  return parseReport(stdout);
}

/**
 * The subset of `files` git does not ignore. A path `.gitignore` excludes is not repository content:
 * it cannot be committed without force, and this worktree carries several lanes' scratch scripts
 * (`tools/_patch-*`, `tools/.tmp-*`) that biome would otherwise report as new violations. `git
 * check-ignore` without `--no-index` never reports a tracked file, so the rule still covers
 * everything the repository actually ships.
 */
export function nonIgnored({ files, root = repositoryRoot }) {
  if (files.length === 0) return [];
  let output = "";
  try {
    output = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: root,
      input: files.join("\0"),
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (error) {
    if (typeof error.status !== "number") throw new Error(`could not ask git what ${root} ignores: ${error.message}`);
    // Exit 1 is "nothing ignored"; anything else is a run failure, not a clean scan.
    if (error.status !== 1)
      throw new Error(`git check-ignore failed (exit ${error.status}) in ${root}: ${error.stderr ?? ""}`);
    output = error.stdout ?? "";
  }
  const ignored = new Set(
    output
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replace(/\\/gu, "/")),
  );
  return files.filter((file) => !ignored.has(file));
}

/** The files that joined or grew in the red set, and the recorded files that shrank or left it. */
export function ratchet({ baselineCounts, counts }) {
  const grown = [];
  for (const [file, count] of Object.entries(counts)) {
    const recorded = baselineCounts[file] ?? 0;
    if (count > recorded) grown.push({ file, count, recorded });
  }
  const fixed = [];
  for (const [file, recorded] of Object.entries(baselineCounts)) {
    const count = counts[file] ?? 0;
    if (count < recorded) fixed.push({ file, recorded, count });
  }
  return { grown, fixed };
}

const valueOf = (argv, name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

function main(argv) {
  const root = resolve(valueOf(argv, "--root") ?? repositoryRoot);
  const update = argv.includes("--update");
  const baselinePath = baselineFor(root);
  const report = scan({ root });
  const { errors, warnings, checked } = report;
  const kept = new Set(nonIgnored({ files: Object.keys(report.counts), root }));
  const counts = Object.fromEntries(Object.entries(report.counts).filter(([file]) => kept.has(file)));
  const files = Object.keys(counts);

  if (update) {
    const baseline = {
      note: "Repo-relative paths biome's linter reports errors in, and how many errors each carries, recorded from the committed tree. Recorded so the lint gate can ratchet: it fails on a file that newly joins this set or whose error count grows, and never on the set itself. Update deliberately, in its own commit, when a change removes errors from it.",
      revision: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      errors,
      warnings,
      files: counts,
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(
      `lint_ratchet_recorded errors=${errors} warnings=${warnings} files=${files.length} checked=${checked} revision=${baseline.revision}\n`,
    );
    return 0;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const recorded = Object.keys(baseline.files).length;
  const result = ratchet({ baselineCounts: baseline.files, counts });
  const debt = `errors=${errors} warnings=${warnings} files=${files.length} recorded=${recorded} checked=${checked}`;
  if (result.grown.length === 0) {
    process.stdout.write(`lint_ratchet_ok debt: ${debt}\n`);
    if (result.fixed.length > 0)
      process.stdout.write(
        `  ${result.fixed.length} recorded file(s) carry fewer errors now; re-record tighter with: node tools/scripts/check-lint-ratchet.mjs --update\n`,
      );
    return 0;
  }
  process.stdout.write(`lint_ratchet_failed new=${result.grown.length} debt: ${debt}\n`);
  for (const { file, count, recorded: was } of result.grown) {
    process.stdout.write(`  ${file} errors=${count} recorded=${was}\n`);
  }
  process.stdout.write(
    "a file that was not in the recorded red set (or whose error count grew) has lint errors; fix it, or if it is deliberate debt, re-record with: node tools/scripts/check-lint-ratchet.mjs --update\n",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
