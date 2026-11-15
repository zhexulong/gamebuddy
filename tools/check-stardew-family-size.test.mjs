import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { judgeSize, readFamily, splitLines } from "./check-stardew-family-size.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = resolve(ROOT, "tools/check-stardew-family-size.mjs");

/**
 * A synthetic family: two files, known line counts, and a ceiling that is the sum. Every falsifier is a copy of this
 * tree with ONE thing changed, so a red reading has exactly one cause.
 */
function family({
  files = { "farmhandexecutioncontroller.cs": 40, "farmhandexecutioncontroller.b.cs": 10 },
  ceiling,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-family-size-"));
  mkdirSync(join(root, "integrations/stardew"), { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(
      join(root, "integrations/stardew", name),
      `${Array.from({ length: lines }, (_, i) => `// line ${i}`).join("\n")}\n`,
    );
  }
  const measured = readFamily({ root });
  const written = ceiling ?? [...measured.values()].reduce((sum, lines) => sum + lines, 0);
  writeFileSync(
    join(root, "baseline.json"),
    JSON.stringify({
      schema: "gamebuddy-stardew-family-size-baseline/v1",
      ceiling: written,
      files: Object.fromEntries(measured),
    }),
  );
  return { root, measured };
}

function run(root, ...args) {
  const outcome = spawnSync(process.execPath, [GATE, "--root", root, "--baseline", "baseline.json", ...args], {
    encoding: "utf8",
  });
  return { code: outcome.status, stdout: `${outcome.stdout}${outcome.stderr}` };
}

const read = (root, name) => readFileSync(join(root, "integrations/stardew", name), "utf8");

test("the population is the directory, not a list: a new partial joins it and a foreign file does not", () => {
  const { root, measured } = family();
  try {
    assert.deepEqual([...measured.keys()], ["farmhandexecutioncontroller.b.cs", "farmhandexecutioncontroller.cs"]);
    writeFileSync(join(root, "integrations/stardew", "farmhandexecutioncontroller.c.cs"), "//\n");
    writeFileSync(join(root, "integrations/stardew", "StardewBodyController.cs"), "//\n//\n");
    assert.deepEqual(
      [...readFamily({ root }).keys()],
      ["farmhandexecutioncontroller.b.cs", "farmhandexecutioncontroller.c.cs", "farmhandexecutioncontroller.cs"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a line is a record, not a trailing byte: CRLF, LF and a missing final newline read the same", () => {
  assert.equal(splitLines("a\nb\n").length, 2);
  assert.equal(splitLines("a\nb").length, 2);
  assert.equal(splitLines("a\r\nb\r\n").length, 2);
  assert.equal(splitLines("").length, 0);
});

test("the reading at the ceiling is green and prints the numbers it examined", () => {
  const { root } = family();
  try {
    const { code, stdout } = run(root);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^files 2 · lines 50 · ceiling 50 · delta 0$/mu);
    assert.match(stdout, /^family_size: green$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one filler line raises the family and the finding names the member that grew", () => {
  const { root } = family();
  try {
    writeFileSync(
      join(root, "integrations/stardew/farmhandexecutioncontroller.b.cs"),
      `${read(root, "farmhandexecutioncontroller.b.cs")}// filler\n`,
    );
    const { code, stdout } = run(root);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^files 2 · lines 51 · ceiling 50 · delta \+1$/mu);
    assert.match(stdout, /^  family_lines_exceeded:51$/mu);
    assert.match(stdout, /^  farmhandexecutioncontroller\.b\.cs \+1 \(10 -> 11\)$/mu);
    assert.doesNotMatch(stdout, /farmhandexecutioncontroller\.cs \+/u, "the unchanged member is not named");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ceiling that outlived a deletion is slack and is red too", () => {
  const { root } = family();
  try {
    const text = read(root, "farmhandexecutioncontroller.cs").split("\n");
    writeFileSync(join(root, "integrations/stardew/farmhandexecutioncontroller.cs"), text.slice(1).join("\n"));
    const { code, stdout } = run(root);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^  family_ceiling_stale:49$/mu);
    assert.match(stdout, /^  farmhandexecutioncontroller\.cs -1 \(40 -> 39\)$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a baseline naming a file the family no longer has is a finding, so a rename cannot hide a line", () => {
  const measured = new Map([["farmhandexecutioncontroller.cs", 3]]);
  const result = judgeSize({ measured, baseline: { ceiling: 5, files: { "farmhandexecutioncontroller.gone.cs": 2 } } });
  assert.ok(
    result.findings.some(
      (finding) => finding.code === "family_baseline_member_missing:farmhandexecutioncontroller.gone.cs",
    ),
  );
});

test("an empty directory is blocked, never green", () => {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-family-size-empty-"));
  try {
    mkdirSync(join(root, "integrations/stardew"), { recursive: true });
    writeFileSync(join(root, "baseline.json"), JSON.stringify({ schema: "x", ceiling: 0, files: {} }));
    const { code, stdout } = run(root);
    assert.equal(code, 2, stdout);
    assert.match(stdout, /^family_population_empty:/mu);
    assert.doesNotMatch(stdout, /green/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a raise is refused without a reason, and the baseline is left alone", () => {
  const { root } = family();
  try {
    writeFileSync(
      join(root, "integrations/stardew/farmhandexecutioncontroller.b.cs"),
      `${read(root, "farmhandexecutioncontroller.b.cs")}// filler\n`,
    );
    const before = readFileSync(join(root, "baseline.json"), "utf8");
    const { code, stdout } = run(root, "--update");
    assert.equal(code, 2, stdout);
    assert.match(stdout, /^family_raise_reason_required:50->51:/mu);
    assert.equal(readFileSync(join(root, "baseline.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reasoned raise records the number it raised from, and the reading is green afterwards", () => {
  const { root } = family();
  try {
    writeFileSync(
      join(root, "integrations/stardew/farmhandexecutioncontroller.b.cs"),
      `${read(root, "farmhandexecutioncontroller.b.cs")}// filler\n`,
    );
    const raise = run(root, "--update", "--because", "a new native seam has no smaller home");
    assert.equal(raise.code, 0, raise.stdout);
    assert.match(raise.stdout, /^family_size_baseline_written: ceiling 51 raised from 50$/mu);
    const written = JSON.parse(readFileSync(join(root, "baseline.json"), "utf8"));
    assert.equal(written.ceiling, 51);
    assert.equal(written.raisedFrom, 50);
    assert.equal(written.because, "a new native seam has no smaller home");
    assert.equal(run(root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this repository's own family is at its recorded ceiling", () => {
  const measured = readFamily({ root: ROOT });
  const baseline = JSON.parse(readFileSync(resolve(ROOT, "tools/stardew-family-size-baseline.json"), "utf8"));
  const result = judgeSize({ measured, baseline });
  assert.ok(
    result.files > 40,
    `examined ${result.files} file(s): a scan that found nothing would agree with any ceiling`,
  );
  assert.deepEqual(
    result.findings.map((finding) => finding.code),
    [],
    `${result.files} files, ${result.lines} lines, ceiling ${result.ceiling}: ${JSON.stringify(result.members.slice(0, 5))}`,
  );
});
