/**
 * The no-game lane's partition: every `.cs` of `GameBuddy.Stardew.Integration.Tests` either runs in
 * `GameBuddy.Stardew.NoGame.Tests` (which compiles the suite's file, from its one location, against
 * `GameBuddy.Stardew.Core` alone) or has a row in `excluded-files.tsv` saying what it needs instead. Two lists, one
 * fact per file.
 *
 * WHY THIS MODULE EXISTS. The two readers held a copy of that fact each: `run-nogame-tests.mjs` parsed the project's
 * `<Compile Include>` lines with one regex, the tsv with a second, and threw a stack trace when the two lists did not
 * cover the suite; `tools/audit-stardew-nogame-subset.mjs` - the gate `.github/workflows/ci.yml` runs on every push -
 * parsed the same lines with a third regex and never opened the tsv at all. So the gate CI reads could not see a file
 * in neither list while the runner could, and a file in BOTH lists was resolved silently by whichever reader looked
 * first. Measured 2026-11-16: `ExecutionEvidenceWireTests.cs`, `SweepTargetRefusalNamingTests.cs` and
 * `WaterTargetApproachTests.cs` shipped with no row in either list; the runner went red with an exception and the gate
 * printed that the project's file list matched the measurements exactly.
 *
 * THE POPULATION IS THE SUITE DIRECTORY, not either list. A population read off the lists agrees with them by
 * construction, and the file in neither column is exactly the one such a population cannot contain - so the directory
 * is what is COUNTED and the two lists are what is JUDGED. The counted set holds a member in neither column before the
 * reading has a verdict.
 *
 * THE FOUR DRIFTS, each with its own code and its own member, because each is repaired differently:
 *
 *   neither   a file no list claims. It runs in no lane and no green count would ever show it - the drift that made
 *             this module: the runner's own accounting caught it, and the gate over the same subject did not.
 *   both      a file two lists claim. One of the two statements is false and which one is not decidable here, which
 *             is why it fails rather than being resolved by reading order.
 *   stale     a `<Compile Include>` line, or a tsv row, for a file the suite no longer holds. The counts then add up
 *             to more than the population, and a reason written beside a deleted file keeps excusing nothing.
 *   vocabulary a tsv row whose reason is outside the table's own words. The per-reason counts are derived from those
 *             words, so an unlisted one would vanish from them.
 *
 * `run-nogame-tests.mjs` (which builds and runs the lane) and `tools/audit-stardew-nogame-subset.mjs` (which CI runs
 * over the same subject) both read the partition from here, so the two cannot disagree about it again.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The suite this subset is drawn from: the project compiles its files, never a copy. */
export const SUITE_DIR = join(ROOT, "integrations", "stardew", "tests", "GameBuddy.Stardew.Integration.Tests");
export const PROJECT_DIR = join(ROOT, "integrations", "stardew", "tests", "GameBuddy.Stardew.NoGame.Tests");
export const PROJECT = join(PROJECT_DIR, "GameBuddy.Stardew.NoGame.Tests.csproj");
export const EXCLUSIONS = join(PROJECT_DIR, "excluded-files.tsv");

/** The include prefix every `<Compile Include>` line must carry: the suite's one location. */
const SUITE_LINK = "../GameBuddy.Stardew.Integration.Tests/";

/** The reasons the tsv may name. The printed per-reason counts are derived from these words. */
export const EXCLUSION_REASONS = Object.freeze(["mod-assembly", "game", "reference-tree"]);

/** The suite's top-level `.cs` files - the population the subset is drawn from. */
export function suiteFiles() {
  return readdirSync(SUITE_DIR)
    .filter((name) => name.endsWith(".cs") && statSync(join(SUITE_DIR, name)).isFile())
    .sort();
}

/**
 * Every `<Compile>` element the project carries, as `{ include, link }` with `null` for an attribute it does not
 * spell. Nothing is skipped: a line the strict shape cannot read comes back with what it did carry, so the reading
 * names it instead of quietly leaving its file out of both halves - which is the drift this module is about.
 */
export function compileRows() {
  const project = readFileSync(PROJECT, "utf8");
  return [...project.matchAll(/<Compile\b([^>]*?)\/?>/gu)].map((match) => {
    const attribute = (name) => {
      const found = new RegExp(`${name}="([^"]*)"`, "u").exec(match[1]);
      return found === null ? null : found[1];
    };
    return { include: attribute("Include"), link: attribute("Link") };
  });
}

/**
 * The compiled half: the file names the project's `<Compile Include>` lines name, read off the project rather than
 * off a directory, because the project is the authority on what the lane builds.
 */
export function compiledFiles() {
  return compileRows()
    .filter((row) => row.include !== null && row.link !== null)
    .map((row) => ({ ...row, path: row.include.replace(/\\/gu, "/") }))
    .filter((row) => row.path.startsWith(SUITE_LINK))
    .map((row) => row.path.slice(SUITE_LINK.length))
    .sort();
}

/**
 * The project rows that are not "one suite file, compiled from its one location": no `Include`, no `Link`, or an
 * `Include` outside the suite. The "one copy" invariant belongs to this reading because the partition and the
 * compiler are the same list - a row pointing at a forked copy would compile a file the suite does not hold.
 */
export function unreadableCompileRows() {
  return compileRows()
    .filter((row) => {
      if (row.include === null || row.link === null) return true;
      return !row.include.replace(/\\/gu, "/").startsWith(SUITE_LINK);
    })
    .map((row) => `<Compile Include="${row.include ?? ""}"${row.link === null ? "" : ` Link="${row.link}"`}/>`);
}

/** The excluded half: `<file>\t<reason>\t<evidence>`, comments and blank lines skipped. */
export function excludedRows() {
  const rows = [];
  for (const line of readFileSync(EXCLUSIONS, "utf8").split(/\r?\n/u)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const [name, why, evidence] = line.split("\t");
    rows.push({ name, why: why ?? "", evidence: evidence ?? "" });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The partition, as a pure function of three name lists, so the falsifier can drive every rule red on a population
 * nobody has to create: a reading that can only be exercised by a real drift gets its first test the day it is
 * needed.
 */
export function partitionReading({ suite, compiled, excluded }) {
  const duplicated = (names) => [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort();
  return {
    examined: suite.length,
    partitioned: compiled.length,
    excluded: excluded.length,
    neither: suite.filter((name) => !compiled.includes(name) && !excluded.includes(name)),
    both: compiled.filter((name) => excluded.includes(name)),
    compiledDuplicated: duplicated(compiled),
    excludedDuplicated: duplicated(excluded),
    compiledStale: [...new Set(compiled)].filter((name) => !suite.includes(name)),
    excludedStale: [...new Set(excluded)].filter((name) => !suite.includes(name)),
  };
}

/** The partition of the tree on disk, the way both readers read it. */
export function treePartition() {
  return partitionReading({
    suite: suiteFiles(),
    compiled: compiledFiles(),
    excluded: excludedRows().map((row) => row.name),
  });
}

/** The population line, printed BEFORE the verdict, so a red reading says what it examined. */
export function populationLine(reading) {
  return (
    `files examined ${reading.examined} · partitioned ${reading.partitioned} · excluded ${reading.excluded} · ` +
    `neither ${reading.neither.length} · both ${reading.both.length}`
  );
}

/**
 * One finding per drifting member: `{ code, member, text }`, where `text` is the one rendering both readers print
 * (`<code>:<member> <what is wrong and what would fix it>`). An empty population is a finding too - zero `.cs` files
 * is a suite directory someone moved, not a partition that holds.
 */
export function partitionFindings(reading) {
  const finding = (code, member, detail) => ({
    code,
    member,
    text: member === null ? `${code}: ${detail}` : `${code}:${member} ${detail}`,
  });
  const findings = [];
  if (reading.examined === 0)
    findings.push(
      finding(
        "nogame_test_files_no_population",
        null,
        "the suite directory holds no .cs file, so a partition over 0 files is a measurement that did not happen " +
          "rather than one that holds",
      ),
    );
  for (const name of reading.neither)
    findings.push(
      finding(
        "nogame_test_file_has_no_partition_row",
        name,
        "is a file of the suite and neither list claims it - it is compiled into the no-game lane by nothing and " +
          "excused by no row, so its tests run nowhere and no green count would show it. Add it to the project's " +
          "<Compile Include> list, or write the row that says what it needs",
      ),
    );
  for (const name of reading.both)
    findings.push(
      finding(
        "nogame_test_file_has_two_partition_rows",
        name,
        "is compiled into the no-game lane AND recorded in excluded-files.tsv - the two lists partition the suite, " +
          "so one of them is false about this file and which one cannot be decided by reading order",
      ),
    );
  // A row duplicated INSIDE one list is the same defect one level down: the printed counts then exceed the population
  // (61 + 240 over 300 files) and no member is named by the reading, which is why the counts alone cannot show it.
  for (const name of reading.compiledDuplicated)
    findings.push(
      finding(
        "nogame_project_compile_row_duplicated",
        name,
        "is named by more than one <Compile Include> line, so the printed count of compiled files is larger than the " +
          "set it describes",
      ),
    );
  for (const name of reading.excludedDuplicated)
    findings.push(
      finding(
        "nogame_excluded_row_duplicated",
        name,
        "has more than one row in excluded-files.tsv, so the printed count of excluded files is larger than the set " +
          "it describes and one of the two reasons beside it is unreachable",
      ),
    );
  for (const name of reading.compiledStale)
    findings.push(
      finding(
        "nogame_project_compile_row_stale",
        name,
        "is named by a <Compile Include> line and is not in the suite any more - the lane would stop compiling a " +
          "test it still claims to run",
      ),
    );
  for (const name of reading.excludedStale)
    findings.push(
      finding(
        "nogame_excluded_row_stale",
        name,
        "is recorded in excluded-files.tsv and is not in the suite any more - delete the row, or rename it to the " +
          "file that replaced it",
      ),
    );
  return findings;
}

/** The tsv's own vocabulary: an unlisted reason is a finding, not a new category. */
export function reasonFindings(rows) {
  return [...new Set(rows.map((row) => row.why))]
    .filter((why) => !EXCLUSION_REASONS.includes(why))
    .map((why) => ({
      code: "nogame_excluded_reason_unknown",
      member: why || null,
      text:
        `nogame_excluded_reason_unknown:${why || "<empty>"} is not one of ${EXCLUSION_REASONS.join(", ")} - the ` +
        "counts printed beside the verdict are derived from these words, so an unlisted one would vanish from them",
    }));
}

/** The project rows that cannot be read as one suite file compiled from its one location. */
export function projectRowFindings(unreadable) {
  return unreadable.map((row) => ({
    code: "nogame_project_row_unreadable",
    member: null,
    text:
      `nogame_project_row_unreadable:${row} is not "one file of the suite, compiled from its one location" - this ` +
      "project includes the suite's files, it never holds or renames a copy",
  }));
}

/** The count of excluded files per reason, derived from the same vocabulary. */ export function reasonCounts(rows) {
  const counts = Object.fromEntries(EXCLUSION_REASONS.map((why) => [why, 0]));
  for (const row of rows) if (row.why in counts) counts[row.why] += 1;
  return counts;
}

/**
 * The project holds the suite's files from their one location and no `.cs` source of its own: a forked copy stays
 * green while the originals drift, and no count either reader prints would show it.
 */
export function ownSourceFindings() {
  const own = readdirSync(PROJECT_DIR).filter((name) => name.endsWith(".cs"));
  if (own.length === 0) return [];
  return [
    {
      code: "nogame_project_holds_its_own_source",
      member: null,
      text:
        `nogame_project_holds_its_own_source:${own.join(", ")} is a .cs file inside ` +
        `${PROJECT_DIR} - this project compiles the suite's files from their one location and holds no copy`,
    },
  ];
}
