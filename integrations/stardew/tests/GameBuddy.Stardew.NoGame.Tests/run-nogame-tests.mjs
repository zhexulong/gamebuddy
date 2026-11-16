#!/usr/bin/env node
/**
 * Run the game-free part of the Stardew suite, and say out loud how much of the suite that is.
 *
 * `GameBuddy.Stardew.Integration.Tests` references the Mod project, whose build package needs a licensed game
 * folder, so a hosted runner cannot build it and its CI steps are gated on GAMEBUDDY_STARDEW_GAME_PATH. The subset
 * that needs neither the game nor the Mod assembly - only `GameBuddy.Stardew.Core` - runs anywhere, and this project
 * is that subset: the suite's own files, included from their one location, never copied.
 *
 * The counts are the point. A green run here says something narrow, and a reader of a CI summary must not read it as
 * "the integration suite passed". So every run prints how many of the suite's files it compiled here, how many it did
 * not and why, and `tools/audit-stardew-nogame-subset.mjs` asks the compiler whether the first list is right.
 *
 * THE PARTITION IS JUDGED BEFORE `dotnet test` STARTS, by `tools/lib/nogame-partition.mjs`: every `.cs` of the suite
 * is compiled here or has a row in `excluded-files.tsv`, never neither and never both. That module is the one
 * authority for the fact, shared with the gate above, because the two readers used to hold a copy each and the
 * copies disagreed about a file in neither list while both reported on it.
 *
 * A red partition is PRINTED, one `nogame_*` finding per line, and the run ends without building: an uncaught
 * `Error` turns the report into a stack trace, and the counts above it then read as a footnote to a crash.
 *
 * Usage:
 *   node integrations/stardew/tests/GameBuddy.Stardew.NoGame.Tests/run-nogame-tests.mjs
 *   ... --no-build   # reuse the last build
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  excludedRows,
  partitionFindings,
  populationLine,
  projectRowFindings,
  reasonCounts,
  reasonFindings,
  treePartition,
  unreadableCompileRows,
} from "../../../../tools/lib/nogame-partition.mjs";

const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(PROJECT_DIR, "..", "..", "..", "..");
const PROJECT = join(PROJECT_DIR, "GameBuddy.Stardew.NoGame.Tests.csproj");

/** `Passed: 165, Total: 165` from the run's summary line. */
function testCount(output) {
  const english = /Passed:\s*(\d+)[\s\S]{0,80}?Total:\s*(\d+)/u.exec(output);
  if (english !== null) return Number(english[2]);
  const chinese = /通过:\s*(\d+)[\s\S]{0,80}?总计:\s*(\d+)/u.exec(output);
  return chinese === null ? null : Number(chinese[2]);
}

function main(argv) {
  const reading = treePartition();
  const rows = excludedRows();

  // The counts first, the verdict second: a red run has to say what it examined, or "neither 1" reads as an opinion
  // about one file rather than a statement about the whole suite.
  process.stdout.write(`stardew_nogame_tests: ${populationLine(reading)}\n`);
  const findings = [
    ...partitionFindings(reading),
    ...projectRowFindings(unreadableCompileRows()),
    ...reasonFindings(rows),
  ];
  if (findings.length > 0) {
    for (const finding of findings)
      process.stdout.write(`stardew_nogame_tests: ${finding.text}\n`);
    process.stdout.write(
      "stardew_nogame_tests: FAILED - the partition does not hold, so nothing was built and no test ran\n",
    );
    process.exitCode = 1;
    return;
  }
  const byReason = reasonCounts(rows);

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
      `stardew_nogame_tests: ${total === null ? "?" : total} tests across ${reading.partitioned} files`,
      `stardew_nogame_tests: ${reading.excluded} of the suite's ${reading.examined} files NOT run here ` +
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

// Guarded, so the falsifier can import the partition without starting a `dotnet test`.
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
