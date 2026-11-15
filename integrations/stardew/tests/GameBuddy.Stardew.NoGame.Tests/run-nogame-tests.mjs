#!/usr/bin/env node
/**
 * Run the game-free part of the Stardew suite, and say out loud how much of the suite that is.
 *
 * `GameBuddy.Stardew.Integration.Tests` references the Mod project, whose build package needs a
 * licensed game folder, so a hosted runner cannot build it and its CI steps are gated on
 * GAMEBUDDY_STARDEW_GAME_PATH. The subset that needs neither the game nor the Mod assembly - only
 * `GameBuddy.Stardew.Core` - runs anywhere, and this project is that subset: the suite's own files,
 * included from their one location, never copied.
 *
 * The counts are the point. A green run here says something narrow, and a reader of a CI summary
 * must not read it as "the integration suite passed". So every run prints how many of the suite's
 * files it compiled and how many it did not.
 *
 * Inclusion is a measured fact with two authorities, and the gap between them is a failure:
 *
 *   - the included set is what this project's `<Compile Include>` lines name;
 *   - the excluded set is `excluded-files.tsv` beside this file, one line per file that needs the
 *     game, the Mod assembly, or the gitignored decompiled reference tree under `/ref/`;
 *   - the population is what the suite directory contains.
 *
 * A file in the suite that is in neither set fails the run by name. That is the one drift that
 * matters: a test could silently leave the lane by gaining a game dependency, and a green count
 * would never show it.
 *
 * The accounting prints its population (`files examined N · compiled C · excluded E · in neither J`)
 * before it prints any verdict, and it is a pure function of the three name lists: `run-nogame-tests.test.mjs`
 * beside this file drives every one of its rules red on a population nobody has to create.
 *
 * Usage:
 *   node integrations/stardew/tests/GameBuddy.Stardew.NoGame.Tests/run-nogame-tests.mjs
 *   ... --no-build   # reuse the last build
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(PROJECT_DIR, "..", "..", "..", "..");
const SUITE_DIR = join(ROOT, "integrations", "stardew", "tests", "GameBuddy.Stardew.Integration.Tests");
const PROJECT = join(PROJECT_DIR, "GameBuddy.Stardew.NoGame.Tests.csproj");
const EXCLUSIONS = join(PROJECT_DIR, "excluded-files.tsv");
const SUITE_LINK = "../GameBuddy.Stardew.Integration.Tests/";

/** The `.cs` files the suite holds at its top level - the population the subset is drawn from. */
export function suiteFiles() {
  return readdirSync(SUITE_DIR)
    .filter((name) => name.endsWith(".cs") && statSync(join(SUITE_DIR, name)).isFile())
    .sort();
}

/**
 * The included set, read off the project. Every `Compile Include` must name a file OUTSIDE this
 * project directory, i.e. one of the suite's own files: that is the "one copy" invariant, asserted
 * rather than trusted, because a forked snapshot stays green while the originals drift and no count
 * this script prints would ever show it.
 */
export function includedFiles() {
  const project = readFileSync(PROJECT, "utf8");
  const included = [];
  for (const match of project.matchAll(/<Compile\s+Include="([^"]+)"/gu)) {
    const path = match[1].replace(/\\/gu, "/");
    if (!path.startsWith(SUITE_LINK)) {
      throw new Error(
        `stardew_nogame_tests_copied_source: ${path} is not a file of the integration suite — ` +
          "this project includes the suite's files, it never holds its own copy",
      );
    }
    included.push(path.slice(SUITE_LINK.length));
  }
  const own = readdirSync(PROJECT_DIR).filter((name) => name.endsWith(".cs"));
  if (own.length > 0) {
    throw new Error(`stardew_nogame_tests_copied_source: ${PROJECT_DIR} holds ${own.join(", ")}`);
  }
  return included.sort();
}

/** The excluded set: `<file>\t<mod-assembly|game|reference-tree>\t<evidence>`, comments and blank
 *  lines skipped. The reason must be one this runner prints a count for, so a typo cannot drop a
 *  file from the totals it reports. */
export function excludedFiles() {
  const rows = [];
  for (const line of readFileSync(EXCLUSIONS, "utf8").split(/\r?\n/u)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const [name, why] = line.split("\t");
    rows.push({ name, why });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The partition of the suite into the two sets this project claims exhaust it: the files it compiles and
 * the files `excluded-files.tsv` excuses.
 *
 * It is a pure function of three name lists, so the falsifier beside this file can drive it with a
 * population nobody has to create: a runner whose accounting can only be exercised by a real drift is a
 * rule that gets its first test the day it is needed.
 */
export function partitionSuite({ suite, compiled, excluded }) {
  return {
    // The population, printed on every run: "0 violations" over zero files agrees with itself.
    examined: suite.length,
    compiled: compiled.length,
    excluded: excluded.length,
    inNeither: suite.filter((name) => !compiled.includes(name) && !excluded.includes(name)),
    // The other three directions the same partition can drift in, each named by its own member below.
    staleCompiled: compiled.filter((name) => !suite.includes(name)),
    staleExcluded: excluded.filter((name) => !suite.includes(name)),
    bothSets: compiled.filter((name) => excluded.includes(name)),
  };
}

/** The population line, printed BEFORE the verdict, so a red run says what it examined. */
export function populationLine(reading) {
  return (
    `files examined ${reading.examined} · compiled ${reading.compiled} · ` +
    `excluded ${reading.excluded} · in neither ${reading.inNeither.length}`
  );
}

/**
 * The verdict: one finding per drifting member, each starting with its stable code. An empty population is
 * a finding too - zero `.cs` files is a suite directory someone moved, not a suite that is fully accounted
 * for.
 */
export function partitionFindings(reading) {
  const findings = [];
  if (reading.examined === 0)
    findings.push(
      "nogame_test_files_no_population: the suite directory holds no .cs file, so compiling 0 of 0 is a" +
        " measurement that did not happen rather than a partition that holds",
    );
  for (const name of reading.inNeither)
    findings.push(
      `nogame_test_file_in_neither_place:${name} is in the suite but neither compiled here nor listed in ` +
        "excluded-files.tsv with a reason — it either belongs in the project or it needs a line saying why it cannot be",
    );
  for (const name of reading.staleCompiled)
    findings.push(`stardew_nogame_tests_include_missing: ${name} is not in the suite any more`);
  // The excluded half drifts the same way: a row for a file that was renamed or deleted keeps claiming a
  // reason for something no longer in the suite, and the printed counts then add up to more than the
  // population. The row is stale either way, so it fails by name exactly like a stale include does.
  for (const name of reading.staleExcluded)
    findings.push(
      `stardew_nogame_tests_excluded_missing: ${name} is recorded here but is not in the suite any more - ` +
        "delete the row, or rename it to the file that replaced it",
    );
  for (const name of reading.bothSets)
    findings.push(
      `stardew_nogame_tests_file_both_sets: ${name} is compiled AND recorded as excluded — the two sets ` +
        "are a partition of the suite, and a file in both says one of them is not true",
    );
  return findings;
}

const REASONS = ["mod-assembly", "game", "reference-tree"];

/** `Passed: 165, Total: 165` from the run's summary line. */
function testCount(output) {
  const english = /Passed:\s*(\d+)[\s\S]{0,80}?Total:\s*(\d+)/u.exec(output);
  if (english !== null) return Number(english[2]);
  const chinese = /通过:\s*(\d+)[\s\S]{0,80}?总计:\s*(\d+)/u.exec(output);
  return chinese === null ? null : Number(chinese[2]);
}

function main(argv) {
  const suite = suiteFiles();
  const included = includedFiles();
  const excluded = excludedFiles();

  // The counts first, the verdict second: a red run has to say what it examined, or "in neither 1" reads
  // as an opinion about one file rather than a statement about the whole suite.
  const reading = partitionSuite({ suite, compiled: included, excluded: excluded.map((row) => row.name) });
  process.stdout.write(`stardew_nogame_tests: ${populationLine(reading)}\n`);
  const findings = partitionFindings(reading);
  if (findings.length > 0) throw new Error(findings.join("\n"));

  const unknownReasons = [...new Set(excluded.map((row) => row.why))].filter((why) => !REASONS.includes(why));
  if (unknownReasons.length > 0) {
    throw new Error(
      `stardew_nogame_tests_reason_unknown: ${unknownReasons.join(", ")} is not one of ${REASONS.join(", ")} - ` +
        "the counts below are derived from these names, so an unlisted one would vanish from them",
    );
  }
  const byReason = Object.fromEntries(REASONS.map((why) => [why, 0]));
  for (const row of excluded) byReason[row.why] += 1;

  const args = ["test", PROJECT, "--nologo", "-v", "q"];
  if (argv.includes("--no-build")) args.push("--no-build");

  let output = "";
  let failed = false;
  try {
    output = execFileSync("dotnet", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // The summary is parsed, so the language it is parsed in is fixed rather than inherited.
      env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: "en" },
    });
  } catch (error) {
    output = `${String(error?.stdout ?? "")}\n${String(error?.stderr ?? "")}`;
    failed = true;
  }
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);

  const total = testCount(output);
  process.stdout.write(
    `${[
      `stardew_nogame_tests: ${total === null ? "?" : total} tests across ${included.length} files`,
      `stardew_nogame_tests: ${excluded.length} of the suite's ${suite.length} files NOT run here ` +
        `(${byReason["mod-assembly"]} need the Mod assembly, ${byReason.game} need the game, ` +
        `${byReason["reference-tree"]} read the gitignored decompiled reference tree under /ref/)`,
      "stardew_nogame_tests: this is the Core-only subset, not the integration suite; the files above run",
      "stardew_nogame_tests: only where GAMEBUDDY_STARDEW_GAME_PATH is configured for the gated steps",
    ].join("\n")}\n`,
  );

  if (failed || total === null) {
    process.stdout.write("stardew_nogame_tests: FAILED\n");
    process.exitCode = 1;
  }
}

// Guarded, so the falsifier beside this file can import the partition without starting a `dotnet test`:
// the accounting is the part under test, and it is a pure function of three name lists.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
