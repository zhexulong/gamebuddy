#!/usr/bin/env node
/**
 * Tests for the child-output parsing gate (`check-child-output-parsing.mjs`).
 *
 * The gate exists to catch one bug class: a harness splitting a child process's captured output by hand, which reads the
 * bytes the child wrote rather than the lines a terminal shows. Measured 2026-11-05, that defect made
 * `tools/check-draft-declaration-coverage.mjs` report `fields: 0` on a page with fields and pass. This file proves, for
 * each evidence class:
 *
 *   1. the REAL pre-fix gate (the bytes of 3005803c^) is named at its two hand splits, and the same source routed through
 *      `cleanOutputLines` is clean - so the gate reacts to the parse, not to the file;
 *   2. one parameter hop is enough: `run(...)` -> `output` -> `inventory(stdout)` -> `readingLines(stdout)` ->
 *      `String(stdout).split("\n")` is named, because the parse lives in a helper that received captured output;
 *   3. an `.includes(...)` probe on captured output is the same defect and is named, while a probe on a `JSON.parse`d
 *      record is not (a value boundary, not byte text);
 *   4. the INCIDENT ITSELF: the real 2026-11-05 capture (11082 bytes, 61 LF, 0 CR, 62 ESC bytes) reads 0 `MEASURE ` lines
 *      through `split("\n")` and 6 through `cleanOutputLines`;
 *   5. an empty population is BLOCKED, not passed - a check that examined nothing cannot pass;
 *   6. the gate prints `examined N files` with N > 0 on the repository's own harnesses, so a green reading always carries
 *      the number of files it read.
 *
 * red-proof: history  `tools/fixtures/child-output/draft-coverage-before-3005803c.txt` is the byte-exact pre-fix source
 *   (`git show 3005803c^:tools/check-draft-declaration-coverage.mjs`, 7506 bytes, 163 LF, 0 CR) and this suite fails
 *   without the taint reading: the gate has to name `:58` and `:83`.
 * red-proof: inject  a synthetic harness holding `String(stdout).split("\n")` behind one parameter hop, and an
 *   `.includes("MEASURE ")` probe on captured output, are both named; routing the same value through `cleanOutputLines`
 *   empties the violation list.
 * red-proof: fixture  the real capture is read two ways: 0 `MEASURE ` lines by hand, 6 through the shared reader.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditSource } from "./check-child-output-parsing.mjs";
import { cleanOutputLines } from "./lib/subprocess-output.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "check-child-output-parsing.mjs");
const FIXTURES = path.join(HERE, "fixtures", "child-output");
const PRE_FIX_GATE = path.join(FIXTURES, "draft-coverage-before-3005803c.txt");
const REAL_CAPTURE = path.join(FIXTURES, "draft-coverage-line-report.txt");

/** The pre-fix source under the name it shipped with, so the reader parses it as the harness it was. */
const PRE_FIX_NAME = "tools/check-draft-declaration-coverage.mjs";

function runGate(argumentsList) {
  const result = spawnSync(process.execPath, [CHECKER, ...argumentsList], {
    cwd: path.resolve(HERE, ".."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function inTemporaryDirectory(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), "gb-child-output-"));
  try {
    for (const [name, contents] of Object.entries(files)) writeFileSync(path.join(root, name), contents, "utf8");
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The line an `auditSource` violation names. */
const lineOfFinding = (finding) => Number(finding.id.slice(finding.id.lastIndexOf(":") + 1));

/** The line a reported violation id names: `child_output_parsed_by_hand:<file>:<line>`. */
const lineOfId = (id) => Number(id.slice(id.lastIndexOf(":") + 1));

// --- 1. the real pre-fix gate, and the same source once it routes through the shared reader ----------

test("the pre-fix draft gate is named at the two hand splits whose capture read zero MEASURE lines", async () => {
  const reading = await auditSource(readFileSync(PRE_FIX_GATE, "utf8"), PRE_FIX_NAME);
  assert.deepEqual(
    reading.violations.map((violation) => violation.id),
    [`child_output_parsed_by_hand:${PRE_FIX_NAME}:83`, `child_output_parsed_by_hand:${PRE_FIX_NAME}:58`],
    "both hand splits, each named by file and line",
  );
  for (const violation of reading.violations) {
    assert.match(violation.message, /cleanOutputLines/u, "the reading says what to use instead");
    assert.match(violation.message, /String\(stdout/u, "the reading quotes the receiver it read");
  }
});

test("the same pre-fix file routed through cleanOutputLines is clean, so the gate reacts to the parse", async () => {
  const routed = readFileSync(PRE_FIX_GATE, "utf8").replaceAll(
    'String(stdout ?? "")\n    .split("\\n")',
    "cleanOutputLines(stdout)",
  );
  assert.ok(!routed.includes('.split("\\n")'), "the fixture was actually rewritten");
  const reading = await auditSource(routed, PRE_FIX_NAME);
  assert.deepEqual(reading.violations, [], "the shared reader is the sanctioned shape");
});

test("the CLI names the pre-fix file and exits 1, and exits 0 on the same tree once it is routed", () => {
  const preFix = readFileSync(PRE_FIX_GATE, "utf8");
  inTemporaryDirectory({ "check-draft-declaration-coverage.mjs": preFix }, (root) => {
    const failed = runGate(["--json", root]);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.status, "failed");
    assert.equal(report.population, 1, "the one pre-fix file is the population");
    assert.deepEqual(report.violations.map(lineOfId).sort(), [58, 83]);

    writeFileSync(
      path.join(root, "check-draft-declaration-coverage.mjs"),
      preFix.replaceAll('String(stdout ?? "")\n    .split("\\n")', "cleanOutputLines(stdout)"),
      "utf8",
    );
    const clean = runGate(["--json", root]);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.deepEqual(JSON.parse(clean.stdout).violations, []);
  });
});

// --- 2. one parameter hop ----------------------------------------------------------------------------

const ONE_HOP = `import { spawnSync } from "node:child_process";

function run(command) {
  return spawnSync(command, [], { encoding: "utf8" });
}

function readingLines(stdout) {
  return String(stdout ?? "")
    .split("\\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("MEASURE "));
}

function inventory(stdout) {
  return readingLines(stdout);
}

const executed = run("playwright");
const output = \`\${executed.stdout}\${executed.stderr}\`;
const rows = inventory(output);
`;

test("a hand split behind one parameter hop is named, at the line that splits", async () => {
  const reading = await auditSource(ONE_HOP, "harness.mjs");
  assert.equal(reading.inPopulation, true);
  assert.deepEqual(reading.violations.map(lineOfFinding), [8], "the split, not the capture call and not the call site");
  assert.match(reading.violations[0].id, /^child_output_parsed_by_hand:harness\.mjs:8$/u);
});

test("routing the same value through cleanOutputLines empties the violations", async () => {
  const routed = ONE_HOP.replace('String(stdout ?? "")\n    .split("\\n")', "cleanOutputLines(stdout)");
  const reading = await auditSource(routed, "harness.mjs");
  assert.deepEqual(reading.violations, []);
});

// --- 3. an includes probe is the same defect --------------------------------------------------------

test("an includes probe on captured output is named, while one on a parsed record is not", async () => {
  const probing = `import { execFileSync } from "node:child_process";

const captured = execFileSync("playwright", ["--reporter=line"], { encoding: "utf8" });
if (!captured.includes("MEASURE chat")) process.exit(1);

const report = JSON.parse(captured);
if (report.neverSucceeded.includes("enter_mine")) process.exit(1);
`;
  const reading = await auditSource(probing, "harness.mjs");
  assert.deepEqual(
    reading.violations.map(lineOfFinding),
    [4],
    "the byte-text probe is named; the parsed record's is not",
  );
});

// --- 4. the incident itself -------------------------------------------------------------------------

test("the real capture reads 0 MEASURE lines by hand and 6 through cleanOutputLines", () => {
  const bytes = readFileSync(REAL_CAPTURE);
  const text = bytes.toString("utf8");
  assert.equal(bytes.length, 11082, "the capture's size, so a truncated fixture does not read as the incident");
  assert.equal((text.match(/\n/gu) ?? []).length, 61, "61 LF");
  assert.equal((text.match(/\r/gu) ?? []).length, 0, "0 CR: the cause is the escapes, not a carriage return");
  assert.equal((text.match(/\u001B/gu) ?? []).length, 62, "62 ESC bytes");

  const byHand = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("MEASURE "));
  const shared = cleanOutputLines(text).filter((line) => line.startsWith("MEASURE "));
  assert.deepEqual(byHand, [], "trim() strips whitespace, not ESC[1A ESC[2K, so every line fails the prefix test");
  assert.equal(shared.length, 6, "the six surfaces the run measured");
  assert.deepEqual(
    shared.map((line) => line.split(" ")[1]),
    ["chat:", "chats:", "characters:", "settings:", "memory:", "inventory"],
    "named, so a reader sees which surfaces the incident lost",
  );
});

// --- 5. an empty population is blocked, not passed ---------------------------------------------------

test("a tree with no capture call is blocked and exits 1, because examining nothing cannot pass", () => {
  inTemporaryDirectory({ "helper.mjs": "export const answer = 42;\n" }, (root) => {
    const result = runGate(["--json", root]);
    assert.equal(result.status, 1, "an empty population must not exit 0");
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "blocked");
    assert.equal(report.population, 0);
    assert.match(report.detail, /examined nothing/u);
  });
});

// --- 6. a pass always carries the number of files it read -------------------------------------------

test("the repository's own harnesses are examined, and the reading prints examined N files", () => {
  const result = runGate(["--json"]);
  const report = JSON.parse(result.stdout);
  assert.ok(
    report.population > 50,
    `expected the repository's harnesses, read ${report.population} files: ${result.stderr}`,
  );

  const human = runGate([]);
  assert.match(human.stdout, new RegExp(`examined ${report.population} files, violations \\d+`, "u"));
});
