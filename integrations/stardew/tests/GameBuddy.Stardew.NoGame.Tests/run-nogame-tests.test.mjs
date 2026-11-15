// The accounting half of `run-nogame-tests.mjs`: the suite is a partition, and a file in neither half is
// the drift that shipped `HoldWaitGateTests.cs` - committed by `7bd2100b`, compiled by neither project, so
// the runner went red at HEAD while every test in the lane passed. The lane's own green says nothing about
// a file it never compiled, which is why the partition is judged before `dotnet test` is started at all.
//
// WHY THE FALSIFIERS ARE HERE AND NOT IN A RED-PROOF COMMENT. `partitionSuite` takes its three name lists
// as arguments, so each rule can be driven red on a population nobody has to create: the file in neither
// place, the row for a deleted file, the file in both halves, and the empty population. Without them the
// runner's accounting would get its first test the day it is needed - which is the day it is too late.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  excludedFiles,
  includedFiles,
  partitionFindings,
  partitionSuite,
  populationLine,
  suiteFiles,
} from "./run-nogame-tests.mjs";

/** The real tree, read the way the runner reads it. */
function realReading() {
  return partitionSuite({
    suite: suiteFiles(),
    compiled: includedFiles(),
    excluded: excludedFiles().map((row) => row.name),
  });
}

test("every suite file is compiled here or excluded with a reason", (t) => {
  const reading = realReading();
  t.diagnostic(populationLine(reading));

  // The property, not today's numbers: the two halves add up to the population, and each half is derived
  // from its own authority (the `.csproj`'s `<Compile Include>` lines, the tsv's first column).
  assert.equal(
    reading.compiled + reading.excluded,
    reading.examined,
    `compiled ${reading.compiled} + excluded ${reading.excluded} must equal the population ${reading.examined} - ` +
      `in neither: ${reading.inNeither.join(", ") || "none"}`,
  );
  assert.deepEqual(
    partitionFindings(reading),
    [],
    `the partition is red: ${partitionFindings(reading).join("\n")}`,
  );
  assert.ok(reading.examined > 0, "an empty suite directory is not a partition that holds");
  assert.ok(reading.compiled > 0, "a lane that compiles nothing is not the Core-only subset");
});

test("the compiled half comes from the project file, and every member is a file of the suite", () => {
  const compiled = includedFiles();
  const suite = suiteFiles();
  assert.ok(compiled.length > 0, "the `.csproj` names no file, so this reading is about nothing");
  assert.deepEqual(
    compiled.filter((name) => !suite.includes(name)),
    [],
    "a `<Compile Include>` line names a file the suite does not hold",
  );
});

test("a file in neither set fails by name", (t) => {
  const reading = partitionSuite({ suite: ["A.cs", "B.cs", "C.cs"], compiled: ["A.cs"], excluded: ["C.cs"] });
  t.diagnostic(populationLine(reading));

  assert.deepEqual(reading.inNeither, ["B.cs"]);
  const findings = partitionFindings(reading);
  assert.equal(findings.length, 1, `one drifting member, one finding: ${findings.join("\n")}`);
  assert.ok(
    findings[0].startsWith("nogame_test_file_in_neither_place:B.cs"),
    `the finding must name the member and its code, got: ${findings[0]}`,
  );
  // The counts are printed beside the verdict, so a red run reads as "1 of 3", not as a bare complaint.
  assert.equal(populationLine(reading), "files examined 3 · compiled 1 · excluded 1 · in neither 1");
});

test("an empty population is a blocked reading, never a pass", (t) => {
  const reading = partitionSuite({ suite: [], compiled: [], excluded: [] });
  t.diagnostic(populationLine(reading));

  assert.equal(populationLine(reading), "files examined 0 · compiled 0 · excluded 0 · in neither 0");
  const findings = partitionFindings(reading);
  assert.equal(findings.length, 1, `zero files is one finding, not zero: ${findings.join("\n")}`);
  assert.ok(
    findings[0].startsWith("nogame_test_files_no_population:"),
    `zero population must be its own code, got: ${findings[0]}`,
  );
});

test("the other three ways the partition drifts are each named", () => {
  const codes = (reading) => partitionFindings(reading).map((finding) => finding.split(":")[0]);

  // A `<Compile Include>` line for a file that was renamed away: the lane would silently stop compiling a
  // test it still claims to run.
  assert.deepEqual(codes(partitionSuite({ suite: ["A.cs"], compiled: ["A.cs", "Gone.cs"], excluded: [] })), [
    "stardew_nogame_tests_include_missing",
  ]);

  // A row for a deleted file: the printed counts would add up to more than the population.
  assert.deepEqual(codes(partitionSuite({ suite: ["A.cs"], compiled: ["A.cs"], excluded: ["Gone.cs"] })), [
    "stardew_nogame_tests_excluded_missing",
  ]);

  // Both halves at once: one of the two statements about that file is false, and the set that is wrong
  // cannot be told from here.
  assert.deepEqual(codes(partitionSuite({ suite: ["A.cs"], compiled: ["A.cs"], excluded: ["A.cs"] })), [
    "stardew_nogame_tests_file_both_sets",
  ]);
});
