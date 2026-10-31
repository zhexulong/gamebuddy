/**
 * The frontend's coverage report, and the floor it must clear.
 *
 * Why this is not one percentage over `src`: the total would be dominated by
 * modules whose coverage means nothing about the product. `management-pipeline-api.ts`
 * is 4.3 k lines of protocol types and validators, `i18n.ts` is 1.9 k lines of string
 * tables; a high number over either says "the module was imported", not "the player can
 * read the screen". The groups and the rule that decides them live in
 * `frontend-coverage-groups.mjs`, derived from each file's own syntax tree, so a new
 * mirror or a new panel joins its group without this file being edited.
 *
 * The floors live in `frontend-coverage-floors.json` and every one of them is the
 * MEASURED value at the commit that introduced the gate, rounded down. A floor above
 * today's number is red on arrival and gets the gate deleted; a floor far below is
 * decoration. When a group genuinely regresses, the failure names the group, the
 * measured number, the floor, and the files that carry the group - so the next reader
 * knows whether to write a test or to move the floor deliberately, in a diff.
 *
 * The denominator is the source tree, not the measurement: every module under `src` is
 * in the population, and a module no journey reached scores 0 (its report entry is
 * generated from an empty V8 block, which is the same "lines that could execute"
 * denominator the real entries use). That is what makes the gate rise when a journey is
 * deleted and fall when a module is added - the two directions a percentage over
 * measured-files-only cannot see.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import v8toIstanbul from "v8-to-istanbul";
import { GROUP_ORDER, classify } from "./frontend-coverage-groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, "..");
export const RAW_DIRECTORY = join(PACKAGE_ROOT, "coverage", "raw");
export const SUMMARY_FILE = join(PACKAGE_ROOT, "coverage", "summary.json");
export const FLOORS_FILE = join(HERE, "frontend-coverage-floors.json");

/** Every raw entry one worker wrote, or no workers at all. */
function readWorkers() {
  if (!existsSync(RAW_DIRECTORY)) return [];
  return readdirSync(RAW_DIRECTORY)
    .filter((name) => name.startsWith("worker-") && name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(RAW_DIRECTORY, name), "utf8")));
}

/**
 * What this run measured, relative to what the floors were derived from.
 *
 * The floors are a reading of the WHOLE journey corpus, so a filtered run (`--grep`, a
 * single spec path) is not a smaller reading of the same question - it is a different
 * question, and comparing it to the floors would report a regression that is really an
 * absent measurement. Two shapes are named instead of blamed on the product:
 *
 *   - `collected: false` - no journey was measured at all
 *     (`GAMEBUDDY_FRONTEND_COVERAGE=off`, or a run that never started a worker);
 *   - `missing: [...]` - some journeys did not execute.
 *
 * A partial run prints its reading and skips the verdict; under `CI` it is a failure,
 * because the CI step runs the whole zone and a partial result there means the corpus
 * itself changed shape. Neither shape can hide: both are printed by name.
 */
function runShape(workers) {
  const journeys = new Set(workers.flatMap((worker) => worker.journeys ?? []));
  const expected = readdirSync(join(PACKAGE_ROOT, "tests")).filter((name) => name.endsWith(".spec.ts"));
  const missing = expected.filter((name) => !journeys.has(`tests/${name}`));
  return { journeys, collected: journeys.size > 0, missing, expected: expected.length };
}

/** The distinct source lines that carry a statement, and how many of them ran. */
function linesOf(istanbulFile) {
  const ran = new Set();
  const all = new Set();
  for (const [id, statement] of Object.entries(istanbulFile.statementMap)) {
    all.add(statement.start.line);
    if (istanbulFile.s[id] > 0) ran.add(statement.start.line);
  }
  return { all: [...all], ran: [...ran] };
}

/**
 * One module's line coverage, over every worker that loaded it.
 *
 * A line is covered when ANY worker ran it, so the workers are unioned rather than
 * merged range-by-range: Playwright splits journeys across processes, and the same
 * module is loaded independently in each, so a range tree from one worker says nothing
 * about the others' execution counts. `functionSets` is one list per worker; when it is
 * empty the module reached no journey at all, and the denominator still comes from V8's
 * own empty-report block, so the module scores 0 against its real executable lines
 * instead of disappearing from the report.
 */
async function measure(absolutePath, source, functionSets) {
  const covered = new Set();
  const all = new Set();
  const blocks = functionSets.length === 0
    ? [[{ functionName: "(empty-report)", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }]]
    : functionSets;
  for (const functions of blocks) {
    const converter = v8toIstanbul(absolutePath, 0, { source });
    await converter.load();
    converter.applyCoverage(functions);
    const istanbul = converter.toIstanbul();
    const key = Object.keys(istanbul);
    // The conversion must land on the file it started from: a key under any other path
    // means the sourcemap moved the numbers somewhere the groups cannot attribute.
    if (key.length !== 1 || resolve(key[0]) !== resolve(absolutePath)) {
      throw new Error(
        `frontend_coverage_attribution_failed:${relative(PACKAGE_ROOT, absolutePath).split(sep).join("/")}\n` +
          `  the source map resolved this module to ${key.join(", ") || "nothing"}, which is not the module the\n` +
          "  browser loaded. Coverage cannot be attributed to a source file until that is fixed.",
      );
    }
    const lines = linesOf(istanbul[key[0]]);
    for (const line of lines.all) all.add(line);
    for (const line of lines.ran) covered.add(line);
  }
  return { total: all.size, covered: covered.size, uncoveredLines: [...all].filter((line) => !covered.has(line)) };
}

/** The whole report: per-group totals, per-module rows, and the journeys that reached each module. */
export async function buildReport() {
  const srcDirectory = join(PACKAGE_ROOT, "src");
  const groups = classify(srcDirectory);
  const workers = readWorkers();
  const shape = runShape(workers);
  const measured = new Map();
  const journeys = new Map();
  for (const worker of workers) {
    for (const entry of worker.entries) {
      const functionSets = measured.get(entry.url) ?? [];
      functionSets.push(entry.functions);
      measured.set(entry.url, functionSets);
    }
    for (const module of worker.modules ?? []) {
      const tests = journeys.get(module.url) ?? new Set();
      for (const file of module.tests) tests.add(file);
      journeys.set(module.url, tests);
    }
  }

  const modules = [];
  for (const [module, group] of groups) {
    const absolutePath = join(srcDirectory, module.split("/").join(sep));
    const source = readFileSync(absolutePath, "utf8");
    const functionSets = measured.get(`/src/${module}`) ?? [];
    const lines = await measure(absolutePath, source, functionSets);
    modules.push({
      module,
      group,
      measured: functionSets.length > 0,
      lines: lines.total,
      covered: lines.covered,
      uncoveredLines: lines.uncoveredLines,
      journeys: [...(journeys.get(`/src/${module}`) ?? [])].sort(),
    });
  }

  const report = { groups: {}, modules: modules.sort((a, b) => a.module.localeCompare(b.module)) };
  for (const group of GROUP_ORDER) {
    const members = report.modules.filter((row) => row.group === group);
    const lines = members.reduce((sum, row) => sum + row.lines, 0);
    const covered = members.reduce((sum, row) => sum + row.covered, 0);
    report.groups[group] = {
      modules: members.length,
      lines,
      covered,
      pct: lines === 0 ? null : Number(((covered / lines) * 100).toFixed(2)),
      unreached: members.filter((row) => row.covered === 0).map((row) => row.module),
    };
  }
  report.measuredModules = report.modules.filter((row) => row.measured).length;
  report.run = { journeys: shape.journeys.size, expected: shape.expected, missing: shape.missing };
  return report;
}

/** The floors, or a refusal: a gate with no recorded floor is not a gate. */
export function readFloors() {
  if (!existsSync(FLOORS_FILE)) {
    throw new Error(
      `frontend_coverage_floors_missing:${relative(PACKAGE_ROOT, FLOORS_FILE)}\n` +
        "  every group needs a measured floor; a gate with no floor enforces nothing.",
    );
  }
  const floors = JSON.parse(readFileSync(FLOORS_FILE, "utf8")).groups;
  const missing = GROUP_ORDER.filter((group) => floors[group] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `frontend_coverage_floor_group_missing:${missing.join(",")}\n` +
        "  a group the classifier can produce has no floor, so its drift would go unnoticed.",
    );
  }
  return floors;
}

/**
 * The floor breaches, each already carrying the group, the number and the floor.
 *
 * Three shapes are failures, and the third is the one that matters most:
 *
 *   1. a group's percentage fell below its floor;
 *   2. the classifier produced no module for a group that has a floor;
 *   3. the group's POPULATION shrank - fewer modules, or fewer executable lines, than the
 *      run that set the floor. Measured 2026-10-31: removing `components/management-panels.tsx`
 *      (87.1% covered, 1721 lines) from the population RAISED `rendered` from 88.17% to
 *      88.31%, so a percentage-only floor stayed green while the largest panel vanished.
 *      That is exactly the check that passes because the thing it watched disappeared, so
 *      the population is a floor of its own.
 */
export function breachesOf(report, floors) {
  const breaches = [];
  for (const group of GROUP_ORDER) {
    const totals = report.groups[group];
    const floor = floors[group];
    if (totals.modules === 0) {
      breaches.push({
        group,
        measured: "no modules",
        floor: `${floor.lines}%`,
        detail: `the classifier found no "${group}" module under src, so this floor now measures nothing`,
      });
      continue;
    }
    if (totals.modules < floor.modules || totals.lines < floor.populationLines) {
      breaches.push({
        group,
        measured: `${totals.modules} modules / ${totals.lines} lines`,
        floor: `${floor.modules} modules / ${floor.populationLines} lines`,
        detail:
          "the group's population shrank, so its percentage is a smaller question than the one the floor was" +
          " measured on - a module left `src` or changed group, and the number above may look better for it",
      });
    }
    if (totals.pct === null || totals.pct < floor.lines) {
      const worst = report.modules
        .filter((row) => row.group === group && row.lines > 0)
        .sort((a, b) => a.covered / a.lines - b.covered / b.lines)
        .slice(0, 5)
        .map((row) => `${row.module} ${Math.round((row.covered / row.lines) * 100)}%`)
        .join(", ");
      breaches.push({
        group,
        measured: `${totals.pct}% (${totals.covered}/${totals.lines} lines over ${totals.modules} modules)`,
        floor: `${floor.lines}%`,
        detail: `lowest modules: ${worst}`,
      });
    }
  }
  return breaches;
}

/** A stable, human-readable rendering of the report, the floors and what this run measured. */
export function renderReport(report, floors, breaches) {
  const lines = [];
  for (const group of GROUP_ORDER) {
    const totals = report.groups[group];
    const floor = floors[group].lines;
    const reading = totals.pct === null ? "no executable lines" : `${totals.pct}% (${totals.covered}/${totals.lines})`;
    lines.push(
      `frontend_coverage group=${group} modules=${totals.modules} lines=${totals.lines} ` +
        `covered=${totals.covered} pct=${totals.pct ?? "n/a"} floor=${floor}%`,
    );
    lines.push(`  ${reading} over ${totals.modules} module(s), floor ${floor}%`);
    if (totals.unreached.length > 0) lines.push(`  unreached: ${totals.unreached.join(", ")}`);
  }
  // The breach lines are the VERDICT, so they are printed only when the verdict is being
  // applied. A partial run's numbers are a different question and printing "below floor"
  // against them is the false red this whole shape exists to avoid.
  for (const breach of breaches) {
    lines.push(
      `frontend_coverage_floor_below:group=${breach.group} measured=${breach.measured} floor=${breach.floor}`,
    );
    lines.push(`  ${breach.detail}`);
  }
  return lines.join("\n");
}

/** The report, the floors and the verdict, in one call: writes the summary file too. */
export async function evaluate() {
  const report = await buildReport();
  const floors = readFloors();
  const breaches = breachesOf(report, floors);
  mkdirSync(dirname(SUMMARY_FILE), { recursive: true });
  writeFileSync(SUMMARY_FILE, `${JSON.stringify({ report, floors }, null, 2)}\n`);
  return { report, floors, breaches };
}

/**
 * The verdict for one run: `clear`, `below`, `unmeasured` or `partial`.
 *
 * A run that did not measure the whole corpus cannot be compared against floors that
 * were derived from it, so its verdict is `unmeasured`/`partial` rather than `below`.
 * Those two still FAIL under `CI`, where the step runs the whole zone and a partial
 * result means the corpus changed shape under a floor that was never re-derived - but
 * locally they print the reading and pass, because subtracting a regression from an
 * absent measurement is exactly the false red that gets a gate deleted.
 */
export function verdictOf({ report, breaches }) {
  if (report.run.journeys === 0) return "unmeasured";
  if (report.run.missing.length > 0) return "partial";
  return breaches.length > 0 ? "below" : "clear";
}

/** The gate's whole output on stdout/stderr, with the verdict as its return value. */
export function reportOutcome({ report, floors, breaches }) {
  const verdict = verdictOf({ report, breaches });
  // A partial run's reading is printed so the reader can see where they are, but its
  // breaches are not: the floors were derived from the whole corpus.
  const applied = verdict === "below" || verdict === "clear";
  process.stdout.write(`${renderReport(report, floors, applied ? breaches : [])}\n`);
  process.stdout.write(
    `frontend_coverage measured=${report.measuredModules}/${report.modules.length} modules ` +
      `journeys=${report.run.journeys}/${report.run.expected} verdict=${verdict} ` +
      `summary=${relative(PACKAGE_ROOT, SUMMARY_FILE).split(sep).join("/")}\n`,
  );
  // A partial or absent measurement is never a clean run under CI; locally it is a
  // filtered iteration and the reading above is the whole answer.
  const fatal = verdict === "below" || (process.env.CI !== undefined && verdict !== "clear");
  if (verdict === "below") {
    process.stderr.write(
      `frontend_coverage_failed:${breaches.map((breach) => breach.group).join(",")}\n` +
        "  A group fell below its recorded floor. Write a journey that covers the behaviour, or move the\n" +
        "  floor in tests/frontend-coverage-floors.json in a diff that says why the lower number is the\n" +
        "  honest one.\n",
    );
  } else if (fatal) {
    process.stderr.write(
      `frontend_coverage_${verdict}:${report.run.journeys}/${report.run.expected}_journeys_measured\n` +
        "  The floors are a reading of the whole journey corpus. Run `pnpm test:mounted` without a\n" +
        "  filter to apply them.\n" +
        (report.run.missing.length > 0
          ? `  Not run: ${report.run.missing.slice(0, 8).join(", ")}${report.run.missing.length > 8 ? ", …" : ""}\n`
          : ""),
    );
  } else if (verdict === "clear") {
    process.stdout.write("frontend_coverage floors clear\n");
  } else {
    process.stdout.write(`frontend_coverage ${verdict} run: floors not applied\n`);
  }
  return fatal ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = reportOutcome(await evaluate());
}
