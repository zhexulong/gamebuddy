#!/usr/bin/env node
/**
 * The class family has a size, and the size is CODE - the lines that are neither blank nor a comment.
 *
 * WHY THE UNIT IS CODE (measured 2026-11-15). The first version of this gate counted every physical line, and its
 * ceiling was that total: 31,257. A comment pass then took the family from 31,257 to 27,388 lines - minus 3,869, prose
 * the code already said - and the gate printed `delta 0` afterwards as though the family had shrunk. It had not: 18,457
 * code lines before the pass and 18,457 after (`ff1e4408` -> `a3096aca`). A ceiling that deleting comments satisfies is
 * measuring the comments: it can always be met by deleting the sentences that explain the code, and never by making the
 * code smaller. So the ceiling is code lines, and the unit is the whole point of this file. The total is still printed
 * - a reader wants it, and the comment and blank counts beside it are how a lane that only added prose is visible as
 * such - but it is not the ceiling.
 *
 * WHY A CEILING AT ALL. Measured 2026-11-15 across `integrations/stardew/farmhandexecutioncontroller*.cs`: 50 files.
 * The head of the family (`farmhandexecutioncontroller.cs`) went 6,162 -> 4,176 lines over the same stretch in which
 * the family grew, because every one of those units was correct on its own - a partial class split, a handler moved to
 * the file that owns it - and every existing gate was green after each, since each gate measures a PROPERTY (the
 * dispatcher does not scan the world, the receipt is minted once, the seam is in the engine's own line) and none of
 * them measures the TOTAL. A file-size ratchet would not have caught it either: `check-file-complexity-gate.mjs` reads
 * one file at a time, and fifty files under their individual limits is exactly what a family that grew looks like. The
 * unit of this gate is the DIRECTORY - the family is what the directory declares it to be - so splitting a file to stay
 * under a per-file limit moves code without hiding it.
 *
 * WHAT A CODE LINE IS. `classifyLines` reads each physical line once and calls it BLANK when it holds only whitespace,
 * COMMENT when its first non-whitespace characters are `//` (which includes the `///` documentation form), and CODE
 * otherwise. A line carrying code and a trailing comment is code: it is the code that costs the next reader.
 *
 * THE BOUNDARY, stated rather than discovered later: this classifier knows whitespace and `//` and nothing else. It does
 * not skip string literals and it does not track C-style block comments - measured across the 50 family files, `//`
 * lines 7,063, block-comment openers 0, string literals containing `//` 0. A block comment appearing tomorrow is
 * therefore counted as code: the reading goes red and names the file, rather than quietly swallowing the code that
 * follows it. That is the fail-closed direction, and the boundary is written here so the next reader does not have to
 * guess which one it is.
 *
 * THE POPULATION is derived, never listed: every file in `integrations/stardew` whose name matches `FAMILY_FILE`. A new
 * partial joins the population by existing and a deleted one leaves it. Zero population is blocked (exit 2,
 * `family_population_empty`) rather than passed, because a directory scan that finds nothing agrees with every ceiling
 * ever written.
 *
 * THE CEILING is `tools/stardew-family-size-baseline.json`, a measured reading and not an accepted gap. It is checked in
 * both directions, for the reason `check-format-ratchet.mjs` and `gates/meta/check-gate-populations.mjs` check theirs in
 * both directions:
 *
 *   `family_code_exceeded:<code>`   a lane added code and nobody said why. The finding names the files that grew, so the
 *                                   next reader opens one file instead of fifty.
 *   `family_ceiling_stale:<code>`   code fell and the ceiling was left behind. A ratchet that keeps its old number is not
 *                                   a ceiling, it is slack: the next few hundred lines of growth would pass silently.
 *                                   The fix is the same command, and it only ever lowers.
 *
 * A RAISE IS A DECISION, NOT AN EDIT, and it names which of the three moved: `--update` refuses to raise the ceiling
 * without `--because`, and it prints and records the code, comment and blank deltas beside the reason. A lane that added
 * code says so; a lane that only added comments is visible as such, and cannot raise a ceiling it does not touch. The
 * reason lives in the baseline rather than only in a commit message because a commit message is not readable from the
 * tree the gate runs in.
 *
 *   node tools/check-stardew-family-size.mjs                          # the verdict; exit 1 above the ceiling or below it
 *   node tools/check-stardew-family-size.mjs --root DIR               # the same reading of a copy of the tree
 *   node tools/check-stardew-family-size.mjs --baseline FILE          # a different ceiling (the falsifier suite does)
 *   node tools/check-stardew-family-size.mjs --update --because "..."  # record this reading; a raise needs the reason
 *   node tools/check-stardew-family-size.mjs --update --at <revision>  # name the tree the reading was taken from
 *
 * The last line of a default run is the self-verification report `tools/lib/harness-conformance.mjs` reads:
 * `{"gate":...,"status":...,"population":<files>,"checks":[...]}`, one outcome per rule. A reading over zero files
 * reports `not_measured` with `population: 0`, which that suite counts apart from a pass - the empty-population path
 * cannot reach a green report by any route.
 *
 * red-proof: history  the comment pass `a3096aca` took the family from 31,257 to 27,388 total lines with 18,457 code
 *   lines at both revisions, so the old total-line ceiling read a prose deletion as a shrink; the same tree reads as
 *   `code 18469 · comment 7063 · blank 1880 · total 27412` under the ceiling in code, and `family_ceiling_stale` is
 *   what a total-line unit reports for a deleted comment
 *   (tools/check-stardew-family-size.test.mjs, "deleting a COMMENT line does not move the ceiling")
 * red-proof: inject  one code line appended to a family file in a copy of the tree -> `family_code_exceeded:18470`, exit
 *   1, the member named (`farmhandexecutioncontroller.verdicts.cs +1`); one COMMENT line deleted from the same copy ->
 *   `delta 0`, exit 0, `comment 7062`, which is the unit: deleting prose does not move the ceiling
 *   (tools/check-stardew-family-size.test.mjs)
 * red-proof: inject  one code line deleted from a family file -> `family_ceiling_stale:18468`, exit 1, because a ceiling
 *   that outlives a deletion is slack for the next raise (the same suite)
 */

export const gateDeclaration = {
  id: "check-stardew-family-size",
  domain: "stardew",
  tier: "l0",
  kind: "totality",
};

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FAMILY_DIRECTORY = "integrations/stardew";
/** The family's name, and the whole derivation: a partial that matches it is in the population. */
export const FAMILY_FILE = /^farmhandexecutioncontroller.*\.cs$/u;
export const BASELINE = "tools/stardew-family-size-baseline.json";
const SCHEMA = "gamebuddy-stardew-family-size-baseline/v2";
const NOTE =
  "The class family's size ceiling is CODE lines - non-comment, non-blank - measured, not an accepted gap. It is " +
  "checked in both directions: code above it is `family_code_exceeded` and a stale ceiling below it is " +
  "`family_ceiling_stale`. It may only fall except by `--update --because`, which records the code, comment and blank " +
  "deltas it raised by and the reason it was given. `comment` and `blank` sit beside it and are never the ceiling: a " +
  "pass that deletes prose does not make the family smaller.";

/**
 * Physical lines: records separated by `\n`, minus a trailing CR, with no phantom record for a final newline.
 *
 * This is the ONE definition of "a line" in this unit - the classification, the ceiling and the per-file map all call
 * it - because the obvious `split("\n").length` counts one extra line per file that ends with a newline, and a
 * measurement that depends on whether a file ends with a newline is a measurement that reports the formatter.
 */
export function splitLines(text) {
  const records = text.split("\n").map((record) => (record.endsWith("\r") ? record.slice(0, -1) : record));
  if (records.length > 0 && records[records.length - 1] === "") records.pop();
  return records;
}

/**
 * One file's text split into the three kinds of line the ceiling distinguishes: `code` is the ceiling, `comment` and
 * `blank` are printed beside it, and the three add up to `total` because every record is judged exactly once.
 */
export function classifyLines(text) {
  const counts = { code: 0, comment: 0, blank: 0, total: 0 };
  for (const line of splitLines(text)) {
    counts.total += 1;
    const trimmed = line.trimStart();
    if (trimmed === "") counts.blank += 1;
    else if (trimmed.startsWith("//")) counts.comment += 1;
    else counts.code += 1;
  }
  return counts;
}

/** The family's three counts, summed from the per-file readings. The ceiling is `code`. */
export function familyTotals(measured) {
  const totals = { code: 0, comment: 0, blank: 0, total: 0 };
  for (const counts of measured.values()) {
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }
  return totals;
}

/** Every family file under `directory`, classified. Directories are not walked: the family is flat. */
export function readFamily({ root = TOOL_ROOT, directory = FAMILY_DIRECTORY } = {}) {
  const absolute = resolve(root, directory);
  let names;
  try {
    names = readdirSync(absolute);
  } catch {
    return null;
  }
  const measured = new Map();
  for (const name of names.filter((entry) => FAMILY_FILE.test(entry)).sort()) {
    measured.set(name, classifyLines(readFileSync(resolve(absolute, name), "utf8")));
  }
  return measured;
}

/**
 * Judge a reading against a ceiling. `findings` carry a code that names the number, and a `members` list naming the
 * files that moved in code lines - a total with no attribution sends the reader to fifty files. `moved` is what the
 * three counts did since the baseline was taken, so a lane that deleted 400 comments and added one code line reads as
 * `code +1 · comment -400` rather than as a family that shrank.
 */
export function judgeSize({ measured, baseline }) {
  const findings = [];
  const totals = familyTotals(measured);
  const ceiling = Number.isFinite(baseline?.ceiling) ? baseline.ceiling : null;
  const recorded = baseline?.files && typeof baseline.files === "object" ? baseline.files : {};

  if (measured.size === 0) {
    return {
      ok: false,
      blocked: "family_population_empty",
      files: 0,
      composition: totals,
      ceiling,
      delta: 0,
      moved: null,
      measuredAt: null,
      findings,
      members: [],
    };
  }
  if (ceiling === null) {
    findings.push({ code: "family_ceiling_unreadable", detail: `no numeric ceiling in ${BASELINE}` });
    return {
      ok: false,
      files: measured.size,
      composition: totals,
      ceiling,
      delta: 0,
      moved: null,
      measuredAt: null,
      findings,
      members: [],
    };
  }

  const members = [];
  for (const [name, counts] of measured) {
    const before = recorded[name];
    if (before === undefined) members.push({ name, delta: counts.code, from: 0, to: counts.code });
    else if (before !== counts.code) members.push({ name, delta: counts.code - before, from: before, to: counts.code });
  }
  for (const name of Object.keys(recorded)) {
    if (!measured.has(name)) findings.push({ code: `family_baseline_member_missing:${name}`, name });
  }

  const delta = totals.code - ceiling;
  if (delta > 0) findings.push({ code: `family_code_exceeded:${totals.code}`, ceiling, delta });
  else if (delta < 0) findings.push({ code: `family_ceiling_stale:${totals.code}`, ceiling, delta });

  const composed =
    Number.isFinite(baseline?.comment) && Number.isFinite(baseline?.blank)
      ? { comment: baseline.comment, blank: baseline.blank }
      : null;
  const moved = composed
    ? { code: delta, comment: totals.comment - composed.comment, blank: totals.blank - composed.blank }
    : null;

  members.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    ok: findings.length === 0,
    files: measured.size,
    composition: totals,
    ceiling,
    delta,
    moved,
    measuredAt: baseline?.measuredAt ?? null,
    findings,
    members,
  };
}

/** `+12`, `-3`, `0`: one spelling of a signed count, used by the reading, the raise record and the refusal. */
const signed = (value) => `${value > 0 ? "+" : ""}${value}`;

/** Which of the three counts moved, in the one form the reading, the raise record and the refusal all print. */
export const movedText = (moved) =>
  moved
    ? `code ${signed(moved.code)} · comment ${signed(moved.comment)} · blank ${signed(moved.blank)}`
    : "code ? · comment ? · blank ?";

/**
 * The baseline a reading is written from. A raise carries the code, comment and blank deltas it raised by, the reason
 * it was given and the tree it was taken from; `raise` stays as it was until the ceiling is raised again.
 */
export function nextBaseline({ previous, measured, because, revision }) {
  const totals = familyTotals(measured);
  const from = Number.isFinite(previous?.ceiling) ? previous.ceiling : null;
  const inCode = totals.code - (from ?? totals.code);
  const composed =
    Number.isFinite(previous?.comment) && Number.isFinite(previous?.blank)
      ? { comment: previous.comment, blank: previous.blank }
      : null;
  const raised = from !== null && inCode > 0;
  return {
    schema: SCHEMA,
    note: NOTE,
    ceiling: totals.code,
    comment: totals.comment,
    blank: totals.blank,
    raise: raised
      ? {
          from,
          code: inCode,
          comment: composed === null ? null : totals.comment - composed.comment,
          blank: composed === null ? null : totals.blank - composed.blank,
          because,
          at: revision,
        }
      : (previous?.raise ?? null),
    measuredAt: revision,
    files: Object.fromEntries(
      [...measured].sort(([a], [b]) => a.localeCompare(b)).map(([name, counts]) => [name, counts.code]),
    ),
  };
}

/** A reading that could not be taken: a named reason, an empty-population report, exit 2 - never 0. */
export function blockedReport(reason, write = (text) => process.stdout.write(`${text}\n`)) {
  write(reason);
  write(JSON.stringify({ gate: "stardew-family-size/v1", status: "not_measured", mode: "repository", population: 0 }));
  return 2;
}

export function report(result, { write = (text) => process.stdout.write(`${text}\n`) } = {}) {
  if (result.blocked)
    return blockedReport(`family_population_empty: ${FAMILY_DIRECTORY} holds no file matching ${FAMILY_FILE}`, write);
  const counts = result.composition;
  write(
    `files ${result.files} · code ${counts.code} · comment ${counts.comment} · blank ${counts.blank} · ` +
      `total ${counts.total} · ceiling (code) ${result.ceiling ?? "?"} · delta ${signed(result.delta)}`,
  );
  if (result.moved && (result.moved.code !== 0 || result.moved.comment !== 0 || result.moved.blank !== 0)) {
    write(`  since ${result.measuredAt ?? "the recorded reading"}: ${movedText(result.moved)}`);
  }
  for (const member of result.members.slice(0, 8)) {
    write(`  ${member.name} ${signed(member.delta)} (${member.from} -> ${member.to})`);
  }
  if (result.members.length > 8) write(`  … ${result.members.length - 8} more moved member(s)`);
  for (const finding of result.findings) write(`  ${finding.code}`);

  // The self-verification report `tools/lib/harness-conformance.mjs` reads: the gate names itself, says how many files
  // it examined, and states every rule's own outcome, so a zero population cannot pass as a measurement and a rule
  // that held is not reported as failed beside one that did not.
  const failed = new Set(result.findings.map((finding) => finding.code.split(":")[0]));
  const rule = (id) => ({ id, status: failed.has(id) ? "failed" : "passed" });
  write(
    JSON.stringify({
      gate: "stardew-family-size/v1",
      status: result.ok ? "passed" : "failed",
      mode: "repository",
      population: result.files,
      composition: counts,
      checks: [
        { id: "family_population", status: result.files > 0 ? "passed" : "failed" },
        rule("family_code_exceeded"),
        rule("family_ceiling_stale"),
        rule("family_baseline_member_missing"),
      ],
    }),
  );

  if (result.ok) {
    write("family_size: green");
    return 0;
  }
  if (result.findings.some((finding) => finding.code.startsWith("family_code_exceeded"))) {
    write(
      'family_size: red · a code raise is a decision: node tools/check-stardew-family-size.mjs --update --because "<why this code is necessary>"',
    );
  } else if (result.findings.some((finding) => finding.code.startsWith("family_ceiling_stale"))) {
    write("family_size: red · the ceiling outlived a code deletion: node tools/check-stardew-family-size.mjs --update");
  } else {
    write("family_size: red");
  }
  return 1;
}

function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  const root = resolve(TOOL_ROOT, value("--root") ?? ".");
  const baselinePath = resolve(root, value("--baseline") ?? BASELINE);
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    baseline = null;
  }
  const measured = readFamily({ root });
  if (measured === null) {
    process.exitCode = blockedReport(`family_directory_missing:${resolve(root, FAMILY_DIRECTORY)}`);
    return;
  }
  const result = judgeSize({ measured, baseline });

  if (!argv.includes("--update")) {
    process.exitCode = report(result);
    return;
  }
  const because = value("--because");
  if (result.files === 0) {
    process.exitCode = report(result);
    return;
  }
  if (result.delta > 0 && (!because || because.trim().length < 8)) {
    process.stdout.write(
      `family_code_raise_reason_required:${result.ceiling}->${result.composition.code}: --update raises the ceiling ` +
        `by ${result.delta} code line(s) (${movedText(result.moved)}) and must say why ` +
        '(`--because "<why this code is necessary>"`)\n',
    );
    process.exitCode = 2;
    return;
  }
  const next = nextBaseline({
    previous: baseline,
    measured,
    because: because ?? null,
    revision: value("--at") ?? "working tree",
  });
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`family_size_baseline_written: ceiling ${next.ceiling} · ${movedText(result.moved)}\n`);
  process.exitCode = report(judgeSize({ measured, baseline: next }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
