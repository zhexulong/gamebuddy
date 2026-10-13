/**
 * The repo-wide formatter step cannot be read while 682 errors are red.
 *
 * `biome format tools host/src dialogue-web/src vendor/pi-koe/src` is red at HEAD with 682 errors
 * over 1116 files, so the number says nothing about the file a lane just touched - and the CI host
 * job dies at an earlier step, so the line itself has not run in a long time.
 *
 * A VCS-scoped run is the obvious fix and does not work in this repository. Biome 2.2.4 accepts
 * `--staged`, `--changed` and `--since=REF`, but `--changed` without `--since` fails closed
 * ("couldn't determine the base to compare against") because `biome.json` sets no
 * `vcs.defaultBranch`, and both `--changed` and `--staged` compare committed/staged bytes only -
 * they ignore the working tree, so locally they check nothing of what a lane is editing. Giving
 * them a base needs a base commit, and CI checks out depth 1: `HEAD~1` does not exist. Pointed at
 * the local merge base instead, the delta is itself red - 23 of the 41 files changed since
 * `origin/main` fail to format - so a git-base gate would be red on arrival for exactly the reason
 * this one is.
 *
 * What is readable is a ratchet over the set of files that fail: the baseline records today's set,
 * a file that is not in it and fails to format fails the gate, and every run prints the live total
 * so the debt stays visible instead of becoming invisible when the step is skipped. The baseline
 * only tightens - a file that starts passing is reported, and `--update` re-records deliberately in
 * its own commit - so re-record it whenever a change removes files from the set.
 *
 * What it does not claim: a file already in the baseline can be reformatted badly without a new
 * finding, because "did this change reformat it" needs the committed bytes at a base, and the
 * measured bases are either absent (depth-1 checkout) or already red (merge base). The honest
 * reading of this gate is "no file newly joins the red set", not "every touched file is formatted".
 *
 * Usage:
 *   node tools/scripts/check-format-ratchet.mjs                  # ratchet, publishing the total
 *   node tools/scripts/check-format-ratchet.mjs --update         # re-record, in its own commit
 *   node tools/scripts/check-format-ratchet.mjs --root <dir>     # the gate's own fixture
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The roots `package.json`'s `format:check` named before this gate, unchanged. */
export const SCOPE = ["tools", "host/src", "dialogue-web/src", "vendor/pi-koe/src"];
const biomeBinary = join(repositoryRoot, "node_modules", "@biomejs", "biome", "bin", "biome");

const baselineFor = (root) => join(root, "tools", "scripts", "format-baseline.json");

/** Biome prints one `<path> format ━━━ …` header per file it would reformat. */
const violationHeader = /^(?<file>.+?) format ━+/u;
const checkedSummary = /^Checked (?<checked>\d+) files?/mu;

/** Repo-relative, forward-slashed paths of every file a biome format run would reformat. */
export function parseViolations(output) {
  const files = new Set();
  for (const line of output.split(/\r?\n/u)) {
    const match = violationHeader.exec(line);
    if (match !== null) files.add(match.groups.file.replace(/\\/gu, "/"));
  }
  return [...files].sort();
}

/** The run's own file count, so the caller can tell a clean scan from a scan that never ran. */
export function parseSummary(output) {
  const checked = checkedSummary.exec(output);
  return { checked: checked === null ? undefined : Number(checked.groups.checked) };
}

/** Runs the formatter over the scope in `root`; the exit code is a violation, not a run failure. */
export function scan({ root = repositoryRoot } = {}) {
  let output;
  try {
    output = execFileSync(process.execPath, [biomeBinary, "format", "--max-diagnostics=none", ...SCOPE], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (typeof error.status !== "number") throw new Error(`could not run biome format in ${root}: ${error.message}`);
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const { checked } = parseSummary(output);
  if (checked === undefined)
    throw new Error(`biome format reported no file count in ${root}; the scan did not run:\n${output.slice(0, 2000)}`);
  return { files: parseViolations(output), checked };
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

/** The files that joined the red set, and the recorded files that left it. */
export function ratchet({ baselineFiles, files }) {
  const recorded = new Set(baselineFiles);
  const current = new Set(files);
  return {
    grown: files.filter((file) => !recorded.has(file)),
    fixed: baselineFiles.filter((file) => !current.has(file)),
  };
}

const valueOf = (argv, name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

function main(argv) {
  const root = valueOf(argv, "--root") ?? repositoryRoot;
  const update = argv.includes("--update");
  const baselinePath = baselineFor(resolve(root));
  const scanned = scan({ root: resolve(root) });
  const { checked } = scanned;
  const files = nonIgnored({ files: scanned.files, root: resolve(root) });

  if (update) {
    const baseline = {
      note: "Repo-relative paths biome's formatter reports as unformatted, recorded from the committed tree. Recorded so the format gate can ratchet: it fails on a file that newly joins this set and never on the set itself. Update deliberately, in its own commit, when a change removes files from it.",
      revision: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: resolve(root),
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      files,
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(
      `format_ratchet_recorded files=${files.length} checked=${checked} revision=${baseline.revision}\n`,
    );
    return 0;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const result = ratchet({ baselineFiles: baseline.files, files });
  const debt = `files=${files.length} checked=${checked} recorded=${baseline.files.length}`;
  if (result.grown.length === 0) {
    process.stdout.write(`format_ratchet_ok debt: ${debt}\n`);
    if (result.fixed.length > 0)
      process.stdout.write(
        `  ${result.fixed.length} recorded file(s) now format; re-record tighter with: node tools/scripts/check-format-ratchet.mjs --update\n`,
      );
    return 0;
  }
  process.stdout.write(`format_ratchet_failed new=${result.grown.length} debt: ${debt}\n`);
  for (const file of result.grown) process.stdout.write(`  ${file}\n`);
  process.stdout.write(
    "a file that was not in the recorded red set does not format; fix it, or if it is deliberate debt, re-record with: node tools/scripts/check-format-ratchet.mjs --update\n",
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
