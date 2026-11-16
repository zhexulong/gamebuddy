// The accounting half of `run-nogame-tests.mjs`: the suite is a partition, and a file in neither half is the drift
// that shipped `HoldWaitGateTests.cs` - committed by `7bd2100b`, compiled by neither project, so the runner went red
// at HEAD while every test in the lane passed. The lane's own green says nothing about a file it never compiled,
// which is why the partition is judged before `dotnet test` is started at all. The same accounting is read by
// `tools/audit-stardew-nogame-subset.mjs`, which CI runs over the same subject.
//
// WHY THE FALSIFIERS ARE HERE AND NOT IN A RED-PROOF COMMENT. `partitionReading` takes its three name lists as
// arguments, so each rule can be driven red on a population nobody has to create: the file in neither place, the row
// for a deleted file, the file in both halves, the unknown reason, and the empty population. Without them the
// accounting would get its first test the day it is needed - which is the day it is too late.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compileRows,
  compiledFiles,
  excludedRows,
  ownSourceFindings,
  partitionFindings,
  partitionReading,
  populationLine,
  reasonFindings,
  suiteFiles,
  treePartition,
  unreadableCompileRows,
} from "../../../../tools/lib/nogame-partition.mjs";

/** The codes of a reading's findings, in the order they are reported. */
function codes(reading) {
  return partitionFindings(reading).map((finding) => finding.code);
}

test("every suite file is compiled here or excluded with a reason", (t) => {
  const reading = treePartition();
  t.diagnostic(populationLine(reading));

  assert.equal(
    reading.partitioned + reading.excluded,
    reading.examined,
    `partitioned ${reading.partitioned} + excluded ${reading.excluded} must equal the population ` +
      `${reading.examined} - in neither: ${reading.neither.join(", ") || "none"}`,
  );
  assert.deepEqual(
    partitionFindings(reading),
    [],
    `the partition is red: ${partitionFindings(reading)
      .map((f) => f.text)
      .join("\n")}`,
  );
  assert.ok(
    reading.examined > 0,
    "an empty suite directory is not a partition that holds",
  );
  assert.ok(
    reading.partitioned > 0,
    "a lane that compiles nothing is not the Core-only subset",
  );
});

test("a file in neither set fails by name, with the counts printed beside it", (t) => {
  const reading = partitionReading({
    suite: ["A.cs", "B.cs", "C.cs"],
    compiled: ["A.cs"],
    excluded: ["C.cs"],
  });
  t.diagnostic(populationLine(reading));

  assert.deepEqual(reading.neither, ["B.cs"]);
  const findings = partitionFindings(reading);
  assert.equal(
    findings.length,
    1,
    `one drifting member, one finding: ${findings.map((f) => f.text).join("\n")}`,
  );
  assert.equal(findings[0].code, "nogame_test_file_has_no_partition_row");
  assert.equal(findings[0].member, "B.cs");
  assert.ok(
    findings[0].text.startsWith("nogame_test_file_has_no_partition_row:B.cs"),
    `the finding must name the member and its code, got: ${findings[0].text}`,
  );
  // The counts are printed beside the verdict, so a red run reads as "1 of 3", not as a bare complaint.
  assert.equal(
    populationLine(reading),
    "files examined 3 · partitioned 1 · excluded 1 · neither 1 · both 0",
  );
});

test("an empty population is a blocked reading, never a pass", (t) => {
  const reading = partitionReading({ suite: [], compiled: [], excluded: [] });
  t.diagnostic(populationLine(reading));

  assert.equal(
    populationLine(reading),
    "files examined 0 · partitioned 0 · excluded 0 · neither 0 · both 0",
  );
  const findings = partitionFindings(reading);
  assert.equal(
    findings.length,
    1,
    `zero files is one finding, not zero: ${findings.map((f) => f.text).join("\n")}`,
  );
  assert.equal(findings[0].code, "nogame_test_files_no_population");
});

test("a file claimed by both lists is its own finding, not a reading-order tie", () => {
  // The "two authorities, one fact" shape: the file is compiled into the lane AND excused from it, and which of the
  // two statements is false cannot be decided by whichever list the reader happens to open first.
  const reading = partitionReading({
    suite: ["A.cs"],
    compiled: ["A.cs"],
    excluded: ["A.cs"],
  });
  assert.deepEqual(codes(reading), ["nogame_test_file_has_two_partition_rows"]);
  assert.deepEqual(reading.both, ["A.cs"]);
});

test("a row duplicated inside one list is named, not just counted", () => {
  // Measured while injecting a violation: a second tsv row for an already-excluded file made the reading print
  // `excluded 240` over a 300-file suite with 61 compiled - 301 members claimed for 300 files - and named nobody.
  const reading = partitionReading({
    suite: ["A.cs", "B.cs"],
    compiled: ["A.cs"],
    excluded: ["B.cs", "B.cs"],
  });
  assert.deepEqual(codes(reading), ["nogame_excluded_row_duplicated"]);
  assert.deepEqual(reading.excludedDuplicated, ["B.cs"]);
  assert.equal(
    reading.partitioned + reading.excluded,
    reading.examined + 1,
    "the duplicate is exactly the count that disagrees with the population",
  );

  const compiledTwice = partitionReading({
    suite: ["A.cs"],
    compiled: ["A.cs", "A.cs"],
    excluded: [],
  });
  assert.deepEqual(codes(compiledTwice), [
    "nogame_project_compile_row_duplicated",
  ]);
});

test("the other two ways the partition drifts are each named", () => {
  // A `<Compile Include>` line for a file that was renamed away: the lane would silently stop compiling a test it
  // still claims to run.
  assert.deepEqual(
    codes(
      partitionReading({
        suite: ["A.cs"],
        compiled: ["A.cs", "Gone.cs"],
        excluded: [],
      }),
    ),
    ["nogame_project_compile_row_stale"],
  );

  // A row for a deleted file: the printed counts would add up to more than the population.
  assert.deepEqual(
    codes(
      partitionReading({
        suite: ["A.cs"],
        compiled: ["A.cs"],
        excluded: ["Gone.cs"],
      }),
    ),
    ["nogame_excluded_row_stale"],
  );
});

test("a reason outside the table's own vocabulary is a finding, not a new category", () => {
  assert.deepEqual(
    reasonFindings([{ name: "A.cs", why: "game", evidence: "Xna" }]),
    [],
  );
  const unknown = reasonFindings([
    { name: "A.cs", why: "xna", evidence: "Xna" },
  ]);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].code, "nogame_excluded_reason_unknown");
  assert.ok(
    unknown[0].text.includes("xna"),
    `the word must be named: ${unknown[0].text}`,
  );
});

test("the tsv is read with one reason per row, and every row names a file", () => {
  const rows = excludedRows();
  assert.ok(
    rows.length > 0,
    "an empty excluded list is not a partition of a 300-file suite",
  );
  for (const row of rows) {
    assert.match(
      row.name,
      /\.cs$/u,
      `a row that names no file: ${JSON.stringify(row)}`,
    );
    assert.notEqual(
      row.why,
      "",
      `${row.name} has no reason - the column is what the printed counts are derived from`,
    );
    assert.notEqual(
      row.evidence,
      "",
      `${row.name} has no evidence - the reason is a measurement, not an opinion`,
    );
  }
});

test("the compiled half comes from the project file, and every `<Compile>` row resolves", () => {
  // The population is the project's own rows, so nothing is dropped by a parser that does not understand a row: a
  // `<Compile>` line whose Include/Link a reader skipped would leave its file in neither half, which is the drift
  // this module names rather than hides.
  const rows = compileRows();
  assert.ok(
    rows.length > 0,
    "the `.csproj` names no file, so this reading is about nothing",
  );
  assert.deepEqual(
    unreadableCompileRows(),
    [],
    "a `<Compile>` row that is not one suite file from its one location",
  );
  assert.equal(
    compiledFiles().length,
    rows.length,
    "every `<Compile>` row must resolve to a compiled file name; the difference is a row the reader skipped",
  );
  assert.deepEqual(
    ownSourceFindings(),
    [],
    "the project must hold no `.cs` source of its own",
  );
  assert.deepEqual(
    compiledFiles().filter((name) => !suiteFiles().includes(name)),
    [],
    "the project must compile files the suite holds",
  );
});
