/**
 * The ratchet's predicate, planted against.
 *
 * `check-test-typecheck-ratchet.mjs` is only worth wiring if the comparison it makes really
 * names the error that grew: a gate whose failure output is "the count changed" is a gate
 * nobody repairs. These tests run the exact functions the CLI runs, over synthetic tsc output,
 * so the planted cases are deterministic and do not depend on how red the real test project
 * happens to be today.
 *
 * The second half is the population: `total=0` meant three different things (a clean project, a
 * run that judged no file, a run whose files were filtered out) and printed the same green line.
 * These tests plant each of the three and assert what the run says about it, because a zero that
 * cannot name its population is the defect this half exists for.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  captureRun,
  countsByCode,
  describeFiles,
  listedFiles,
  notMeasuredLines,
  notMeasuredReason,
  parseErrors,
  populationLines,
  ratchet,
  testFiles,
  testFilePopulation,
} from "./check-test-typecheck-ratchet.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(HERE, "test-typecheck-baseline.json"), "utf8"));

const line = (file, lineNumber, code, message) => `${file}(${lineNumber},1): error ${code}: ${message}`;

test("baseline.1: the recorded baseline is internally consistent and names the revision it came from", () => {
  const sum = Object.values(BASELINE.codes).reduce((total, count) => total + count, 0);
  assert.equal(sum, BASELINE.total, "the per-code counts must add up to the recorded total");
  assert.match(BASELINE.revision, /^[0-9a-f]{7,}$/u, "the baseline names the revision it was recorded from");
});

test("ratchet.1: a new error of a code the baseline never had is the finding, with file:line", (t) => {
  // The defect this gate exists for: a real TS2304 in a production file, invisible because the
  // test project was already red. The baseline below is the shape of the real one - errors of
  // other codes, no TS2304 at all.
  const baseline = { codes: { TS2322: 35, TS2532: 25 }, total: 60 };
  const errors = parseErrors(
    [
      line("src/game-tools.test.ts", 100, "TS2322", "Type 'a' is not assignable to type 'b'."),
      line("src/stardew-game-integration-adapter.ts", 412, "TS2304", "Cannot find name 'sessionId'."),
    ].join("\n"),
  );
  const result = ratchet({ baseline, errors });
  assert.deepEqual(result.grew, ["TS2304"], "the code that grew is the new code");
  assert.deepEqual(
    result.reported.map((error) => `${error.file}:${error.line} ${error.code}: ${error.message}`),
    ["src/stardew-game-integration-adapter.ts:412 TS2304: Cannot find name 'sessionId'."],
    "the failure names the new error's file and line, so the 181st error is not left to be diffed by hand",
  );
  t.diagnostic(`ratchet.1: planted TS2304 -> ${result.reported[0].file}:${result.reported[0].line}`);
});

test("ratchet.2: one more error of a code the baseline already carries grows that code", (t) => {
  const baseline = { codes: { TS2322: 35 }, total: 35 };
  const grown = ratchet({
    baseline,
    errors: Array.from({ length: 36 }, () => ({ file: "src/x.test.ts", line: 1, column: 1, code: "TS2322", message: "m" })),
  });
  assert.deepEqual(grown.grew, ["TS2322"], "the code grew past its recorded count");
  assert.equal(grown.reported.length, 36, "every current error of the grown code is reported");
  t.diagnostic("ratchet.2: 35 -> 36 is a finding");
});

test("ratchet.3: errors that disappear are never a finding", () => {
  const baseline = { codes: { TS2322: 35, TS2307: 2 }, total: 37 };
  const result = ratchet({ baseline, errors: [{ file: "src/x.test.ts", line: 1, column: 1, code: "TS2322", message: "m" }] });
  assert.deepEqual(result.grew, [], "a ratchet only turns one way");
  assert.deepEqual(ratchet({ baseline, errors: [] }).grew, [], "a project that got greener is green");
});

test("ratchet.4: an empty baseline is not a disarmed gate", () => {
  // The disarmament this catches: deleting the baseline file's contents so nothing can grow.
  // With an empty baseline the very next run fails on every code the project carries.
  const result = ratchet({
    baseline: { codes: {}, total: 0 },
    errors: [{ file: "src/x.test.ts", line: 3, column: 4, code: "TS2322", message: "m" }],
  });
  assert.deepEqual(result.grew, ["TS2322"]);
  assert.equal(result.reported[0].line, 3, "the unnamed baseline reports the site it found");
});

test("ratchet.5: a tsc line that is not an error diagnostic is not an error", () => {
  const errors = parseErrors(
    [
      "src/action-registry.ts(765,1): error TS1109: Expression expected.",
      "src/x.ts(1,1): warning TS9999: a warning is not an error",
      "Found 2 errors in the same file, starting at: src/x.ts:1",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    errors.map((error) => `${error.file}:${error.line}:${error.column} ${error.code}`),
    ["src/action-registry.ts:765:1 TS1109"],
  );
  assert.deepEqual(countsByCode(errors), { TS1109: 1 }, "the counts are read off the parsed errors");
});

test("population.0: a clean compile's stdout is the output, not only a red compile's", () => {
  // The defect this pins: reading the output from the failure path alone makes a clean project look
  // like one that compiled nothing, and `total=0` then means the opposite of what it says.
  const clean = captureRun({
    command: "tsc",
    args: [],
    options: {},
    label: "tsc for tsconfig.test.json",
    spawn: () => "/repo/host/src/game-tools.test.ts\n",
  });
  assert.equal(clean, "/repo/host/src/game-tools.test.ts\n", "exit 0 returns its stdout");

  const red = captureRun({
    command: "tsc",
    args: [],
    options: {},
    label: "tsc for tsconfig.test.json",
    spawn: () => {
      const failure = new Error("tsc exited 1");
      failure.status = 1;
      failure.stdout = "src/game-tools.test.ts(1,1): error TS2353: m\n";
      throw failure;
    },
  });
  assert.match(red, /TS2353/u, "a compile that reported errors returns the output it reported them in");

  assert.throws(
    () =>
      captureRun({
        command: "tsc",
        args: [],
        options: {},
        label: "tsc for tsconfig.test.json",
        spawn: () => {
          const failure = new Error("spawn tsc ENOENT");
          failure.status = null;
          throw failure;
        },
      }),
    /could not run tsc for tsconfig\.test\.json: spawn tsc ENOENT/u,
    "a compile that never ran is a run failure, not an empty project",
  );
});

test("population.1: the population is the files tsc compiled, not a guess at the directory", () => {
  // `--listFiles` output, absolute paths, with a diagnostic after it - the shape one run prints.
  const output = [
    "/repo/host/node_modules/typescript/lib/lib.es5.d.ts",
    "/repo/host/src/main.ts",
    "/repo/host/src/game-tools.test.ts",
    "/repo/host/src/tavern/preset-binding.test.ts",
    "/repo/host/src/game-tools.test.ts",
    "/repo/host/src/game-tools.ts(100,3): error TS2353: Object literal may only specify known properties.",
  ].join("\n");
  const files = listedFiles({ output, host: "/repo/host" });
  assert.deepEqual(
    files.filter((file) => file.endsWith(".test.ts")),
    ["src/game-tools.test.ts", "src/tavern/preset-binding.test.ts"],
    "the compiled test files come from the compiler's own list, deduplicated, with the diagnostic dropped",
  );
  assert.ok(!files.includes("src/main.ts(100,3)") && files.includes("src/main.ts"), "a diagnostic line is not a path");
});

test("population.2: a test file the project does not compile is a derivation defect, named", () => {
  const population = testFilePopulation({
    compiled: ["src/a.test.ts", "src/tavern/b.test.ts", "src/c.ts"],
    onDisk: ["src/a.test.ts", "src/c.test.ts", "src/tavern/b.test.ts"],
    dirty: new Set(["src/tavern/b.test.ts"]),
  });
  assert.equal(population.total, 2, "the population is the compiled test files");
  assert.deepEqual(population.uncommitted, ["src/tavern/b.test.ts"], "the uncommitted member is named");
  assert.deepEqual(population.excludedByProject, ["src/c.test.ts"], "a test file on disk the project skips is named");
  assert.equal(testFiles(["src/main.ts", "src/a.test.ts"]).length, 1, "only test files are the population");
});

test("population.3: each of the three zeroes has its own named reason, and a measurement has none", () => {
  const measured = { total: 12, uncommitted: [], excludedByProject: [] };
  assert.equal(
    notMeasuredReason({ population: measured, examined: 12, excludedErrors: 0 }),
    undefined,
    "examined files with no excluded errors is a measurement",
  );
  assert.equal(
    notMeasuredReason({ population: measured, examined: 0, excludedErrors: 0 }),
    "every_test_file_is_uncommitted",
    "a run that judged no test file is not a clean project",
  );
  assert.equal(
    notMeasuredReason({ population: measured, examined: 12, excludedErrors: 1 }),
    "uncommitted_files_carry_errors",
    "a verdict that does not cover an error it found is blocked, not green",
  );
  assert.equal(
    notMeasuredReason({ population: { total: 0, uncommitted: [], excludedByProject: [] }, examined: 0, excludedErrors: 0 }),
    "no_test_files_compiled",
    "a project with no test file has no population to ratchet",
  );
  assert.equal(
    notMeasuredReason({
      population: { total: 1, uncommitted: [], excludedByProject: ["src/c.test.ts"] },
      examined: 1,
      excludedErrors: 0,
    }),
    "tsconfig_excludes_test_files",
    "the derivation dropping a test file is the defect, not the comparison",
  );
  assert.equal(
    notMeasuredReason({
      population: { total: 0, uncommitted: [], excludedByProject: ["src/c.test.ts"] },
      examined: 0,
      excludedErrors: 0,
    }),
    "tsconfig_excludes_test_files",
    "a project that compiles none of the test files on disk is a broken derivation, not a repository without tests",
  );
});

test("population.4: the printed lines carry the population beside its verdict, and name the excluded file", () => {
  const population = { total: 386, uncommitted: ["src/body-program-packing.test.ts"], excludedByProject: [] };
  const [examined] = populationLines({ population, examined: 385, excludedErrors: 2, includeDirty: false });
  assert.match(examined, /examined 385 of 386 \.test\.ts files in tsconfig\.test\.json/u, "the population is stated");
  assert.match(examined, /excluded 1 \(uncommitted 1, tsconfig-excluded 0\)/u, "which kind of exclusion it was is stated");
  assert.match(examined, /errors_excluded=2$/u, "the excluded errors are counted");

  const blocked = notMeasuredLines({
    reason: "uncommitted_files_carry_errors",
    population,
    examined: 385,
    discarded: [{ file: "src/body-program-packing.test.ts" }, { file: "src/body-program-packing.test.ts" }],
  });
  assert.match(blocked[0], /^test_typecheck_not_measured:uncommitted_files_carry_errors examined=385 of=386/u);
  assert.match(blocked[1], /src\/body-program-packing\.test\.ts/u, "the blocked reading names the file it refused to judge");
  assert.match(blocked[2], /--include-dirty/u, "and names the command that does judge it");
  assert.equal(describeFiles(["a", "b", "c", "d", "e", "f"]), "6: a, b, c, d, e, … and 1 more", "the list is bounded");
});
