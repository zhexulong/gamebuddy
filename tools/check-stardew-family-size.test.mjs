// The falsifiers for `tools/check-stardew-family-size.mjs`.
//
// red-proof: inject  one code line appended to a family file in a copy of the tree -> `family_code_exceeded` at the
//   ceiling plus one, exit 1, the member named; one COMMENT line deleted from the same copy -> `delta 0`, exit 0,
//   which is the unit (tools/check-stardew-family-size.test.mjs)
// red-proof: inject  one code line deleted from a family file -> `family_ceiling_stale` at the ceiling minus one, exit
//   1, because a ceiling that outlives a deletion is slack for the next raise
//   (tools/check-stardew-family-size.test.mjs)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyLines,
  familyTotals,
  judgeSize,
  nextBaseline,
  readFamily,
  splitLines,
} from "./check-stardew-family-size.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = resolve(ROOT, "tools/check-stardew-family-size.mjs");

/**
 * One partial's body, with the four kinds of line the ceiling has to tell apart: code, a comment, a `///` doc comment,
 * and a blank. A line carrying code and a trailing comment is code, so `Handler(); // why` counts once as code.
 */
const BODY = [
  "namespace GameBuddy;",
  "",
  "// a comment the code already says",
  "/// <summary>documentation, which is prose too</summary>",
  "internal sealed class Partial {",
  "    private void Handler() { } // the code, not the sentence after it",
  "}",
].join("\n");
const BODY_COUNTS = Object.freeze({ code: 4, comment: 2, blank: 1, total: 7 });

/**
 * A synthetic family: two files with known composition, and a ceiling written by the gate's own `nextBaseline` so the
 * fixture cannot disagree with the file shape the gate produces. Every falsifier is a copy of this tree with ONE thing
 * changed, so a red reading has exactly one cause.
 */
function family({
  bodies = { "farmhandexecutioncontroller.cs": BODY, "farmhandexecutioncontroller.b.cs": BODY },
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-family-size-"));
  mkdirSync(join(root, "integrations/stardew"), { recursive: true });
  for (const [name, body] of Object.entries(bodies))
    writeFileSync(join(root, "integrations/stardew", name), `${body}\n`);
  const measured = readFamily({ root });
  writeFileSync(
    join(root, "baseline.json"),
    JSON.stringify(nextBaseline({ previous: null, measured, because: null, revision: "fixture" })),
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
const write = (root, name, text) => writeFileSync(join(root, "integrations/stardew", name), text);
const baselineOf = (root) => JSON.parse(readFileSync(join(root, "baseline.json"), "utf8"));

/** The self-verification report the run printed last, parsed. */
function lastReport(stdout) {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  return JSON.parse(line);
}

const outcomeOf = (report, id) => report.checks.find((entry) => entry.id === id)?.status;

test("the population is the directory, not a list: a new partial joins it and a foreign file does not", () => {
  const { root, measured } = family();
  try {
    assert.deepEqual([...measured.keys()], ["farmhandexecutioncontroller.b.cs", "farmhandexecutioncontroller.cs"]);
    write(root, "farmhandexecutioncontroller.c.cs", "//\n");
    write(root, "StardewBodyController.cs", "//\n//\n");
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

test("a code line is what is neither blank nor a comment, and the three are a partition of the total", () => {
  const counts = classifyLines(`${BODY}\n`);
  assert.deepEqual(counts, BODY_COUNTS);
  assert.equal(counts.code + counts.comment + counts.blank, counts.total, "every record is judged exactly once");
  assert.equal(classifyLines(BODY).code, BODY_COUNTS.code, "a missing final newline is not a line");
  assert.equal(classifyLines(`${" ".repeat(6)}// indented prose\n`).comment, 1, "indentation does not make prose code");
  assert.equal(classifyLines("    return value; // trailing\n").code, 1, "code with a trailing comment is code");
});

test("the reading prints all four counts and its ceiling in code, so the unit is visible on the line", () => {
  const { root } = family();
  try {
    const { code, stdout } = run(root);
    const totals = familyTotals(readFamily({ root }));
    assert.equal(code, 0, stdout);
    assert.match(
      stdout,
      new RegExp(
        `^files 2 · code ${totals.code} · comment ${totals.comment} · blank ${totals.blank} · total ${totals.total} · ` +
          `ceiling \\(code\\) ${totals.code} · delta 0$`,
        "mu",
      ),
    );
    assert.match(stdout, /^family_size: green$/mu);
    assert.ok(
      totals.comment > 0 && totals.blank > 0,
      `the fixture must carry prose to delete: ${JSON.stringify(totals)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting a COMMENT line does not move the ceiling - the point of measuring code", () => {
  const { root } = family();
  try {
    const before = baselineOf(root);
    const text = read(root, "farmhandexecutioncontroller.b.cs").split("\n");
    const comment = text.findIndex((line) => line.trimStart().startsWith("//"));
    write(root, "farmhandexecutioncontroller.b.cs", text.filter((_, index) => index !== comment).join("\n"));
    const { code, stdout } = run(root);
    assert.equal(code, 0, stdout);
    assert.match(
      stdout,
      new RegExp(`^files 2 · code ${before.ceiling} · comment ${before.comment - 1} ·.*delta 0$`, "mu"),
    );
    assert.doesNotMatch(stdout, /^ {2}family_ceiling_stale/mu, "prose deletion is not the family shrinking");
    assert.doesNotMatch(stdout, /^ {2}family_code_exceeded/mu);
    assert.equal(lastReport(stdout).status, "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting a BLANK line does not move the ceiling either, and neither does adding a comment", () => {
  const { root } = family();
  try {
    const before = baselineOf(root);
    const text = read(root, "farmhandexecutioncontroller.b.cs").split("\n");
    write(root, "farmhandexecutioncontroller.b.cs", text.filter((line) => line.trim() !== "").join("\n"));
    const withoutBlank = run(root);
    assert.equal(withoutBlank.code, 0, withoutBlank.stdout);
    assert.match(
      withoutBlank.stdout,
      new RegExp(`code ${before.ceiling} · comment ${before.comment} · blank 1 ·`, "mu"),
    );
    write(
      root,
      "farmhandexecutioncontroller.cs",
      `${read(root, "farmhandexecutioncontroller.cs")}// one more sentence\n`,
    );
    const withComment = run(root);
    assert.equal(withComment.code, 0, withComment.stdout);
    assert.match(withComment.stdout, new RegExp(`code ${before.ceiling} · comment ${before.comment + 1} ·`, "mu"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one code line raises the family, and the finding names the code count and the member that grew", () => {
  const { root } = family();
  try {
    const before = baselineOf(root);
    write(
      root,
      "farmhandexecutioncontroller.b.cs",
      `${read(root, "farmhandexecutioncontroller.b.cs")}private void Falsifier() { }\n`,
    );
    const { code, stdout } = run(root);
    assert.equal(code, 1, stdout);
    assert.match(stdout, new RegExp(`^  family_code_exceeded:${before.ceiling + 1}$`, "mu"));
    assert.match(stdout, /^ {2}since fixture: code \+1 · comment 0 · blank 0$/mu);
    assert.match(stdout, /^ {2}farmhandexecutioncontroller\.b\.cs \+1 \(4 -> 5\)$/mu);
    assert.doesNotMatch(stdout, /farmhandexecutioncontroller\.cs \+/u, "the unchanged member is not named");
    const report = lastReport(stdout);
    assert.equal(report.status, "failed");
    assert.equal(report.population, 2);
    assert.equal(outcomeOf(report, "family_code_exceeded"), "failed");
    assert.equal(
      outcomeOf(report, "family_ceiling_stale"),
      "passed",
      "the rule that held is not reported as failed beside the one that did not",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ceiling that outlived a code deletion is slack and is red too", () => {
  const { root } = family();
  try {
    const before = baselineOf(root);
    const text = read(root, "farmhandexecutioncontroller.b.cs").split("\n");
    const lastCode = text.findLastIndex((line) => line.trim() !== "" && !line.trimStart().startsWith("//"));
    write(root, "farmhandexecutioncontroller.b.cs", text.filter((_, index) => index !== lastCode).join("\n"));
    const { code, stdout } = run(root);
    assert.equal(code, 1, stdout);
    assert.match(stdout, new RegExp(`^  family_ceiling_stale:${before.ceiling - 1}$`, "mu"));
    assert.match(stdout, /^ {2}farmhandexecutioncontroller\.b\.cs -1 \(4 -> 3\)$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ceiling recorded in total lines is stale, so the unit cannot be switched back without a red reading", () => {
  const { root, measured } = family();
  try {
    const totals = familyTotals(measured);
    const proseInclusive = { ...baselineOf(root), ceiling: totals.total };
    writeFileSync(join(root, "baseline.json"), JSON.stringify(proseInclusive));
    const { code, stdout } = run(root);
    assert.equal(code, 1, stdout);
    assert.match(stdout, new RegExp(`^  family_ceiling_stale:${totals.code}$`, "mu"));
    assert.match(
      stdout,
      new RegExp(`ceiling \\(code\\) ${totals.total} · delta -${totals.comment + totals.blank}$`, "mu"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a baseline naming a file the family no longer has is a finding, so a rename cannot hide a code line", () => {
  const measured = new Map([["farmhandexecutioncontroller.cs", { code: 3, comment: 0, blank: 0, total: 3 }]]);
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
    assert.equal(lastReport(stdout).status, "not_measured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory that is not there is blocked by name, not by a stack trace", () => {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-family-size-absent-"));
  try {
    const { code, stdout } = run(root);
    assert.equal(code, 2, stdout);
    assert.match(stdout, /^family_directory_missing:.*integrations[\\/]stardew$/mu);
    assert.doesNotMatch(stdout, /at .*node:fs/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a raise is refused without a reason, and the refusal names which of the three counts moved", () => {
  const { root } = family();
  try {
    const before = readFileSync(join(root, "baseline.json"), "utf8");
    write(
      root,
      "farmhandexecutioncontroller.b.cs",
      `${read(root, "farmhandexecutioncontroller.b.cs")}// a sentence\nprivate void Falsifier() { }\n`,
    );
    const { code, stdout } = run(root, "--update");
    assert.equal(code, 2, stdout);
    assert.match(stdout, /^family_code_raise_reason_required:8->9: --update raises the ceiling by 1 code line\(s\)/mu);
    assert.match(stdout, /\(code \+1 · comment \+1 · blank 0\)/u);
    assert.equal(readFileSync(join(root, "baseline.json"), "utf8"), before, "the baseline is left alone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reasoned raise records the three deltas, the reason and the tree it was taken from", () => {
  const { root } = family();
  try {
    const before = baselineOf(root);
    write(
      root,
      "farmhandexecutioncontroller.b.cs",
      `${read(root, "farmhandexecutioncontroller.b.cs")}// a sentence\nprivate void Falsifier() { }\n`,
    );
    const because = "a new native seam has no smaller home";
    const raise = run(root, "--update", "--because", because, "--at", "abc1234");
    assert.equal(raise.code, 0, raise.stdout);
    assert.match(raise.stdout, /^family_size_baseline_written: ceiling 9 · code \+1 · comment \+1 · blank 0$/mu);
    const written = baselineOf(root);
    assert.equal(written.ceiling, before.ceiling + 1);
    assert.equal(written.comment, before.comment + 1);
    assert.equal(written.blank, before.blank);
    assert.deepEqual(written.raise, { from: 8, code: 1, comment: 1, blank: 0, because, at: "abc1234" });
    assert.equal(run(root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this repository's own family is at its recorded ceiling, in code", () => {
  const measured = readFamily({ root: ROOT });
  const baseline = JSON.parse(readFileSync(resolve(ROOT, "tools/stardew-family-size-baseline.json"), "utf8"));
  const totals = familyTotals(measured);
  const result = judgeSize({ measured, baseline });
  assert.ok(
    result.files > 40,
    `examined ${result.files} file(s): a scan that found nothing would agree with any ceiling`,
  );
  assert.ok(totals.comment > 0, `the family holds no comment line: ${JSON.stringify(totals)}`);
  assert.equal(
    baseline.ceiling + baseline.comment + baseline.blank,
    totals.total,
    `the recorded composition is the measured one: ${JSON.stringify(baseline)} vs ${JSON.stringify(totals)}`,
  );
  assert.deepEqual(
    result.findings.map((finding) => finding.code),
    [],
    `${result.files} files, code ${totals.code}, ceiling ${result.ceiling}: ${JSON.stringify(result.members.slice(0, 5))}`,
  );
});
