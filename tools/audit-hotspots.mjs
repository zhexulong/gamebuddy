#!/usr/bin/env node
/**
 * The change-frequency × size report: which files in this repository are both BUSY and LARGE at the same time.
 *
 * This is a REPORT, and the header says so before anything else because the temptation it was built from was a GATE.
 * A hotspot gate would rank files by churn × complexity and fail on the ranking. It does not, and `--why-not-a-gate`
 * prints the retrospection that decided that: the ranking was measured against the defects this repository actually
 * shipped and fixed in the same window, and it does not separate them from the files nobody filed anything against.
 *
 * THE TWO NUMBERS, each with its owner:
 *
 *   frequency  REVISIONS in the window that touched the path, from `git log --name-only --since=<window>`. One
 *              revision per commit that named the path, so a file edited inside one commit counts once.
 *   size       PHYSICAL LINES at HEAD, from `measure()` in `tools/scripts/check-file-complexity-gate.mjs` - the
 *              same population (`git ls-files --cached --others --exclude-standard`) and the same line count that
 *              the size ratchet already judges, kept here as an import rather than a second measurement.
 *
 * WHY THE FREQUENCY AXIS IS REVISIONS AND NOT LINES ADDED+REMOVED (measured 2026-11-17, this tree):
 *
 *   git log --numstat   --since=1.days     20.031 s   (74 commits = 270 ms each)
 *   git log --name-only --since=1.days      0.086 s   (74 commits = 1.2 ms each)
 *
 * Two hundred times the cost, for an axis that answers the same question: at 270 ms/commit the 2,904 commits of the
 * 30-day window would cost ~13 minutes, and at 14 ms/commit (the window's own measured 41.0 s for `--name-only`) it
 * costs 41 s. A report a lane will not run is a report nobody reads, so `--numstat` is not used anywhere in this file.
 *
 * THE WINDOW ENDS AT THIS TREE'S OWN HEAD, NOT AT THE WALL CLOCK. Measured 2026-11-17: `--since=30.days` read
 * 2,903 commits and then 2,904 an hour later, because other lanes kept committing - and on a work tree whose HEAD was
 * four days old it silently measured a 26-day window, since the walk starts at that HEAD while the boundary came from
 * today. Anchored at HEAD's committer date (`git log -1 --format=%cI`) the table is a function of (commit, window):
 * the same command on the same revision prints the same rows, which is the only proof a reading can offer in place
 * of a red one - and it is what makes `--root <worktree-at-an-old-rev>` mean "this reading, taken then". The anchor
 * is printed on the first line of every run.
 *
 * THE WINDOW IS 30 DAYS because the record this was tested against is a 30-day record: every shipped defect commit
 * named in `design/tasks/active/21_OPEN_FINDINGS_2026_11_15_NIGHT.md` and `.tmp/night-red-proofs.md` lands between
 * 2026-11-13 and 2026-11-15, and 2,904 of this repository's 5,129 commits are 30 days old or newer - so the window
 * covers the whole recent shape of the tree, not a stale sample of it. `--window <days>` moves it.
 *
 * WHERE THIS READING WOULD HAVE HELPED, AND WHERE IT IS BLIND (measured, the 15 fix commits of 2026-11-13..15,
 * 26 product files). Run on the tree as it stood at 43299f2a - the commit before the first of those fixes - with the
 * same 30-day window and today's code (`--root <worktree>`), 14 of the 26 files the fixes would touch were ALREADY in
 * that tree's top decile (309 of 3,098 files, so a 10% cut held 54% of the coming breakage): `tavern/browser-contract/
 * index.ts` at rank 5, `i18n.ts` at 6, `management-pipeline-api.ts` at 7, `ComposedReferenceGameApp.tsx` at 18.
 * The 12 misses are the honest limit of the metric, and they are three shapes: files that carried one revision or none
 * when that window closed (`preset-macros.ts`, `preset-segments.ts`, `preset-request-segments.ts` at 1 each and
 * `composed-reference-game-view.ts` at 0) - a churn ranking cannot see a file with no history, which is why a defect
 * in a two-day-old file is invisible here - files whose churn had not yet accumulated (`MarkdownMessage.tsx` at 568 of
 * 3,098, `ProblemView.tsx` at 1,263), and files outside the population's extension set, of which the largest is
 * `dialogue-web/src/style.css` (185 commits and 15,348 changed lines over the 90-day window, and no line ceiling, so
 * it is not in this report at all; the fix for that is a ceiling in the size ratchet, not a second file list here).
 *
 * WHAT A ROW DOES NOT SAY:
 *
 *   `tests`   the number of tracked test files that IMPORT this file by a relative specifier (`.js`/`.ts`/`.tsx`,
 *             bare and extensionless, and directory `index`). A gate that exercises a file through a harness, a
 *             directory scan or a subprocess import is NOT counted here - the reading is literally "a test names it".
 *   `tools`   the number of sources under `tools/` that contain this file's path as a literal string. Most gates
 *             derive their population from a scan, so 0 here means "no gate names this path by hand", which is not
 *             the same as "no gate watches it". Printed because a reader ranking files by risk asks it, and a column
 *             that says how weak it is, is better than a column that pretends.
 *
 * POPULATION, AND THE ZERO. Files are the size ratchet's population: every path `git ls-files` names whose extension
 * carries a line ceiling there (`.ts .mjs .cs .tsx .ps1 .cjs .py .mts`), which is 2,8xx files today; the extensions
 * that carry no ceiling are printed by that gate and are outside this report for the same reason. A run that
 * measured no file exits 2 (`hotspots_blocked:population_empty`), and a run whose window holds no revision at all
 * exits 2 (`hotspots_blocked:window_empty`) - "nothing was busy" and "nothing was measured" are different facts.
 *
 * USAGE:
 *   node tools/audit-hotspots.mjs                        # top 30 by revisions × lines, plus the population line
 *   node tools/audit-hotspots.mjs --window 7             # the same reading over another window
 *   node tools/audit-hotspots.mjs --locate host/src/x.ts # where one file ranks (repeatable)
 *   node tools/audit-hotspots.mjs --json                 # the rows as JSON
 *   node tools/audit-hotspots.mjs --root <dir>           # read another tree (must be a git work tree)
 *   node tools/audit-hotspots.mjs --why-not-a-gate       # the retrospection that kept this a report
 *
 * red-proof: inject  `score: commits * lines` -> `score: commits + lines` in rank() -> `rank.1`, `rank.2`, `locate.1`
 *   and `report.4` fail - the table and the located rank both stop being the product of the two numbers - while 10 of
 *   the 14 cases stay green, and the unmodified suite is 14 of 14 (tools/audit-hotspots.test.mjs)
 *
 * WHERE IT RUNS. `pnpm hotspots` (`package.json`), and `tools/check-prelive-gate-registry.mjs` exempts it from the
 * prelive ladder as `report:` with the numbers in the reason: it exits 0 whatever the ranking says, so a rung would
 * call it green while it printed a reading nobody gates on, and it costs 67 s (measured 2026-11-17: `measure` 25.8 s,
 * churn 41.0 s, test importers 0.14 s, tool mentions 0.16 s) of which the largest single item is the size ratchet's
 * own reading rather than a new one.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { runWhenEntry } from "./scripts/cli-entry.mjs";
import { measure } from "./scripts/check-file-complexity-gate.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The window in days, for the reason in the header. */
export const WINDOW_DAYS = 30;

/** How many rows the human reading prints. The JSON carries every row. */
export const PRINTED_ROWS = 30;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TOOL_SOURCE = /^tools\/(?:.+\/)?[^/]+\.(?:mjs|cjs|js|ts)$/u;
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/gu;
const MODULE_SUFFIX = /\.(?:[cm]?[jt]sx?)$/u;
const RESOLUTION_SUFFIXES = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];

const normalize = (path) => path.split(sep).join("/");

/**
 * Revisions per path inside the window, from the repository's own log.
 *
 * THE WINDOW ENDS AT THE TREE'S OWN HEAD, not at the wall clock. Measured 2026-11-17: with `--since=30.days` a
 * reading taken twice an hour apart disagreed (2,903 and then 2,904 commits) because other lanes kept committing,
 * and a reading taken on a work tree whose HEAD is four days old silently measured a 26-day window - `git log`
 * walks back from that HEAD, so the boundary has to be that HEAD's date. Anchored this way the table is a function
 * of (commit, window) and the same command on the same revision prints the same rows, which is the only proof a
 * reading can offer in place of a red one.
 *
 * `--name-only` rather than `--numstat` (see the header for the two measurements), and no `--find-renames`: a renamed
 * file is counted under the name it carried at that commit, so a rename shows up as revisions on both names instead
 * of being silently credited to one.
 */
export function measureChurn(root, windowDays = WINDOW_DAYS) {
  const anchor = execFileSync("git", ["log", "-1", "--format=%cI"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const since = new Date(Date.parse(anchor) - windowDays * 86_400_000).toISOString();
  const raw = execFileSync("git", ["log", `--since=${since}`, "--name-only", "--format=\u0001%H"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const revisions = new Map();
  let commits = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("\u0001")) {
      commits += 1;
      continue;
    }
    const path = line.trim();
    if (path === "") continue;
    revisions.set(path, (revisions.get(path) ?? 0) + 1);
  }
  return { anchor, commits, revisions };
}

/** The import a relative specifier resolves to inside `population`, or `null` - the four readings in the header. */
function resolveSpecifier(from, specifier, population) {
  if (!specifier.startsWith(".")) return null;
  const base = normalize(join(dirname(from), specifier));
  const candidates = [base];
  if (MODULE_SUFFIX.test(base)) {
    if (/\.jsx?$/u.test(base)) candidates.push(base.replace(/\.jsx?$/u, ".ts"), base.replace(/\.jsx?$/u, ".tsx"));
  } else {
    for (const suffix of RESOLUTION_SUFFIXES) candidates.push(`${base}${suffix}`, `${base}/index${suffix}`);
  }
  return candidates.find((candidate) => population.has(candidate)) ?? null;
}

/**
 * Which test files import which source file, by the test file's own import statements.
 *
 * The test population is not a list: it is every path in the size population whose name says it is a test, so a new
 * test joins without an edit here, and a file no test names reads 0 rather than absent.
 */
export function measureTestImporters({ root, population }) {
  const importers = new Map();
  const tests = [...population.keys()].filter((file) => TEST_FILE.test(file));
  for (const test of tests) {
    const source = readFileSync(join(root, test), "utf8");
    for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
      const target = resolveSpecifier(test, match[1], population);
      if (target === null || target === test) continue;
      if (!importers.has(target)) importers.set(target, []);
      if (!importers.get(target).includes(test)) importers.get(target).push(test);
    }
  }
  return { importers, tests: tests.length };
}

/** How many sources under `tools/` contain each path as a literal string. */
export function measureToolMentions({ root, population, paths }) {
  const sources = [...population.keys()].filter((file) => TOOL_SOURCE.test(file));
  const mentions = new Map(paths.map((path) => [path, []]));
  for (const file of sources) {
    const source = readFileSync(join(root, file), "utf8");
    for (const path of paths) if (source.includes(path)) mentions.get(path).push(file);
  }
  return mentions;
}

/** Every file that has a size in the population, ranked by revisions × lines: the two numbers, multiplied. */
export function rank({ sizes, revisions }) {
  const rows = [];
  for (const [file, lines] of sizes) {
    const commits = revisions.get(file) ?? 0;
    rows.push({ file, lines, revisions: commits, score: commits * lines });
  }
  rows.sort(
    (left, right) =>
      right.score - left.score || right.revisions - left.revisions || left.file.localeCompare(right.file),
  );
  return rows;
}

/**
 * The top decile by rank: how many rows it holds and the score of its last member.
 *
 * A decile of the RANK, not a score threshold, because the score has no unit a reader can compare across windows
 * (revisions × lines moves with both the calendar and every reformat).
 */
export function topDecile(rows) {
  const count = Math.floor(rows.length / 10);
  if (count === 0) return { count: 0, threshold: null };
  return { count, threshold: rows[count - 1].score };
}

/** One path's place in the ranking, 1-based, with the two numbers that put it there. */
export function locate(rows, path) {
  const index = rows.findIndex((row) => row.file === normalize(path));
  if (index < 0) return { file: normalize(path), rank: null, of: rows.length };
  return { ...rows[index], rank: index + 1, of: rows.length };
}

function main(argv) {
  if (argv.includes("--why-not-a-gate")) {
    process.stdout.write(WHY_NOT_A_GATE);
    return 0;
  }
  const root = resolve(valueOf(argv, "--root") ?? REPOSITORY_ROOT);
  const windowDays = Number(valueOf(argv, "--window") ?? WINDOW_DAYS);
  const json = argv.includes("--json");
  const located = [...argv.flatMap((argument, index) => (argument === "--locate" ? [argv[index + 1]] : []))].filter(
    (path) => typeof path === "string" && path !== "",
  );

  if (!Number.isInteger(windowDays) || windowDays < 1) {
    console.error(`hotspots_blocked:window_invalid:${String(valueOf(argv, "--window"))}`);
    return 2;
  }
  let measured;
  try {
    measured = measure(root);
  } catch (error) {
    console.error(`hotspots_blocked:population_unreadable:${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const { sizes, extensions } = measured;
  if (sizes.size === 0) {
    console.error(`hotspots_blocked:population_empty:${root}`);
    return 2;
  }
  let churn;
  try {
    churn = measureChurn(root, windowDays);
  } catch (error) {
    console.error(
      `hotspots_blocked:window_unreadable:${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
    return 2;
  }
  const { anchor, commits, revisions } = churn;
  if (commits === 0) {
    console.error(`hotspots_blocked:window_empty:${windowDays}d:${anchor}:${root}`);
    return 2;
  }

  const rows = rank({ sizes, revisions });
  const decile = topDecile(rows);
  const printed = rows.slice(0, PRINTED_ROWS);
  const shown = measureTestImporters({ root, population: sizes });
  const mentions = measureToolMentions({
    root,
    population: sizes,
    paths: [...new Set([...printed.map((row) => row.file), ...located.map(normalize)])],
  });
  const describe = (row) => ({
    ...row,
    tests: (shown.importers.get(row.file) ?? []).length,
    tools: (mentions.get(row.file) ?? []).length,
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          windowDays,
          anchor,
          commits,
          examined: sizes.size,
          busy: [...revisions.keys()].filter((file) => sizes.has(file)).length,
          decile,
          rows: printed.map(describe),
          located: located.map((path) => describe(locate(rows, path))),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const busy = [...revisions.keys()].filter((file) => sizes.has(file)).length;
  console.log(
    `hotspot report: window ${windowDays} days ending ${anchor} · ${commits} commits · frequency = revisions touching the file · size = lines at HEAD`,
  );
  console.log(
    `files examined ${sizes.size} · extensions ${[...extensions].map(([extension, count]) => `${extension} ${count}`).join(" ")}`,
  );
  console.log(
    `with a revision in the window ${busy} · top decile ${decile.count} (down to ${decile.threshold ?? "n/a"})`,
  );
  console.log("");
  console.log("   #  revisions  lines      score  tests  tools  file");
  for (const [index, raw] of printed.entries()) {
    const row = describe(raw);
    console.log(
      `${String(index + 1).padStart(4)}  ${String(row.revisions).padStart(9)}  ${String(row.lines).padStart(5)}  ${String(
        row.score,
      ).padStart(9)}  ${String(row.tests).padStart(5)}  ${String(row.tools).padStart(5)}  ${row.file}`,
    );
  }
  for (const path of located) {
    const row = describe(locate(rows, path));
    console.log(
      `\nlocate ${row.file} · rank ${row.rank ?? "absent"} of ${row.of} · revisions ${row.revisions} · lines ${row.lines} · score ${row.score} · imported by ${row.tests} test(s) · named by ${row.tools} tool source(s)`,
    );
  }
  console.log(
    "\nThis is a reading, not a verdict: nothing here fails, and `--why-not-a-gate` prints the retrospection that decided it.",
  );
  return 0;
}

/**
 * The retrospection, as the numbers that decided the shape of this file: 22 of the 48 files a shipped defect named in
 * the window are in the top decile against 26 below it (6.8% against 0.9%), so the ranking has signal - and the rule
 * that would make it a gate does not.
 *
 *   in the top decile AND no test names it   208 files fire at HEAD, 11 of them a defect named (precision 5.3%);
 *                                            the decile alone measures 6.8%, so the conjunction is worse than nothing
 *   "unwatched" as the discriminator         18 of the 26 product defect files ARE named by a test (i18n.ts by 39,
 *                                            browser-contract/index.ts by 50), and the decile splits 11 watched / 11 not
 *   files entering the top decile per week   75 in, 75 out, 48 of the entrants with no test naming them
 *
 * A threshold therefore has nowhere to stand (green would need a 208-row hotspot baseline, which this repository does
 * not keep) and an entry rule fires 75 times a week without a baseline of last week's membership to compare against.
 */
const WHY_NOT_A_GATE = [
  "hotspots: why this is a report and not a gate",
  "",
  "  decile membership x a shipped-defect file named in the window (15 fix commits, 49 files, 26 product)",
  "    in the top decile   22 defect  302 clean   base rate 6.8%",
  "    below               26 defect 2892 clean   base rate 0.9%   lift 7.6x",
  "",
  '  the rule shape "top decile AND no test names it"',
  "    fires on 208 of the 324 decile members at HEAD; 11 of those had a defect (precision 5.3%)",
  "    the decile alone measures 6.8%, so requiring an unwatched file makes the rule WORSE",
  "    18 of the 26 product defect files are named by a test, and the decile splits 11 watched / 11 unwatched",
  "",
  "  an entry rule needs last week's membership: 75 files enter and 75 leave the top decile per week",
  "  (48 of the entrants with no test naming them) - that is a gate that fires 48-75 times a week",
  "",
  "  so: no threshold can be green without a hotspot baseline, and the retrospection says the conjunction does not",
  "  separate defects from clean files. The reading stands on its own; a verdict would not.",
  "",
].join("\n");

const valueOf = (argv, name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

await runWhenEntry(import.meta.url, main);
