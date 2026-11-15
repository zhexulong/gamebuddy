#!/usr/bin/env node
/**
 * The class family has a size, and until this file it had no ceiling.
 *
 * WHY. Measured 2026-11-15 across `integrations/stardew/farmhandexecutioncontroller*.cs`: 50 files, 31,281 lines.
 * The head of the family (`farmhandexecutioncontroller.cs`) went 6,162 -> 4,176 lines (-33%) over the same stretch in
 * which the family went 29,161 -> 31,305 (+2,144). Every one of those units was correct on its own - a partial class
 * split, a handler moved to the file that owns it - and every existing gate was green after each, because each gate
 * measures a PROPERTY (the dispatcher does not scan the world, the receipt is minted once, the seam is in the engine's
 * own line) and none of them measures the TOTAL. So work that made the head smaller made the family larger, and the
 * number that mattered was the one nobody printed.
 *
 * A file-size ratchet alone would not have caught it either: `tools/scripts/check-file-complexity-gate.mjs` reads one
 * file at a time, and 50 files under their individual limits is exactly what a family that grew by 2,144 lines looks
 * like. The unit of this gate is the DIRECTORY - the family is what the directory declares it to be - so splitting a
 * file to stay under a per-file limit moves lines without hiding them.
 *
 * THE POPULATION is derived, never listed: every file in `integrations/stardew` whose name matches
 * `FAMILY_FILE`. A new partial joins the population by existing, and a partial that is deleted leaves it. Zero
 * population is blocked (exit 2, `family_population_empty`) rather than passed, because a directory scan that finds
 * nothing agrees with every ceiling ever written.
 *
 * THE CEILING is `tools/stardew-family-size-baseline.json`, a measured reading and not an accepted gap. It is checked
 * in both directions, for the reason `tools/scripts/check-format-ratchet.mjs` and
 * `tools/gates/meta/check-gate-populations.mjs` check theirs in both directions:
 *
 *   `family_lines_exceeded:<total>`  the family grew and nobody said why. The finding names the files that grew, so
 *                                    the next reader opens one file instead of fifty.
 *   `family_ceiling_stale:<total>`   the family shrank and the ceiling was left behind. A ratchet that keeps its old
 *                                    number is not a ceiling, it is slack: the next 400 lines of growth would pass
 *                                    silently. The fix is the same command, and it only ever lowers.
 *
 * A RAISE IS A DECISION, NOT AN EDIT: `--update` refuses to raise the ceiling without `--because`, and records the
 * number it raised from beside the reason. The brief's requirement - that the commit message say why, and say what the
 * number was - is this file's, because a commit message is not readable from inside the tree a gate runs in.
 *
 * WHAT THIS GATE IS NOT. It does not care what the lines are. A comment pass, a partial split and a handler move all
 * read the same way, which is the point: it answers "did the family get bigger" and nothing else. Nothing else was
 * answering it.
 *
 *   node tools/check-stardew-family-size.mjs                      # the verdict; exit 1 above the ceiling or below it
 *   node tools/check-stardew-family-size.mjs --root DIR            # the same reading of a copy of the tree
 *   node tools/check-stardew-family-size.mjs --baseline FILE       # a different ceiling (the falsifier suites do)
 *   node tools/check-stardew-family-size.mjs --update --because "..."  # record this reading; a raise needs the reason
 *
 * red-proof: inject  one filler line appended to a family file in a copy of the tree -> `family_lines_exceeded:31282`
 *   plus the member named (`farmhandexecutioncontroller.verdicts.cs +1`), exit 1; the unmodified copy prints
 *   `files 50 · lines 31281 · ceiling 31281 · delta 0` and exits 0 (tools/check-stardew-family-size.test.mjs)
 * red-proof: inject  one line deleted from a family file -> `family_ceiling_stale:31280`, exit 1, because a ceiling
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
const SCHEMA = "gamebuddy-stardew-family-size-baseline/v1";

/**
 * Physical lines: records separated by `\n`, minus a trailing CR, with no phantom record for a final newline.
 *
 * This is the ONE definition of "a line" in this unit - the ceiling, the per-file map and the comment pass all call
 * it - because the obvious `split("\n").length` counts one extra line per file that ends with a newline, and a
 * measurement that depends on whether a file ends with a newline is a measurement that reports the formatter.
 */
export function splitLines(text) {
  const records = text.split("\n").map((record) => (record.endsWith("\r") ? record.slice(0, -1) : record));
  if (records.length > 0 && records[records.length - 1] === "") records.pop();
  return records;
}

/** Every family file under `directory`, with its physical line count. Directories are not walked: the family is flat. */
export function readFamily({ root = TOOL_ROOT, directory = FAMILY_DIRECTORY } = {}) {
  const absolute = resolve(root, directory);
  const files = readdirSync(absolute)
    .filter((name) => FAMILY_FILE.test(name))
    .sort();
  const measured = new Map();
  for (const name of files) measured.set(name, splitLines(readFileSync(resolve(absolute, name), "utf8")).length);
  return measured;
}

const total = (measured) => [...measured.values()].reduce((sum, lines) => sum + lines, 0);

/**
 * Judge a reading against a ceiling. `findings` carry a code that names the number, and a `members` list naming the
 * files that moved - a total with no attribution sends the reader to fifty files.
 */
export function judgeSize({ measured, baseline }) {
  const findings = [];
  const files = total(measured);
  const ceiling = Number.isFinite(baseline?.ceiling) ? baseline.ceiling : null;
  const recorded = baseline?.files && typeof baseline.files === "object" ? baseline.files : {};

  if (measured.size === 0) {
    return {
      ok: false,
      blocked: "family_population_empty",
      files: 0,
      lines: 0,
      ceiling,
      delta: 0,
      findings,
      members: [],
    };
  }
  if (ceiling === null) {
    findings.push({ code: "family_ceiling_unreadable", detail: `no numeric ceiling in ${BASELINE}` });
    return { ok: false, files: measured.size, lines: files, ceiling, delta: 0, findings, members: [] };
  }

  const members = [];
  for (const [name, lines] of measured) {
    const before = recorded[name];
    if (before === undefined) members.push({ name, delta: lines, from: 0, to: lines });
    else if (before !== lines) members.push({ name, delta: lines - before, from: before, to: lines });
  }
  for (const name of Object.keys(recorded)) {
    if (!measured.has(name)) findings.push({ code: `family_baseline_member_missing:${name}`, name });
  }

  const delta = files - ceiling;
  if (delta > 0) findings.push({ code: `family_lines_exceeded:${files}`, files, ceiling, delta });
  else if (delta < 0) findings.push({ code: `family_ceiling_stale:${files}`, files, ceiling, delta });

  members.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { ok: findings.length === 0, files: measured.size, lines: files, ceiling, delta, findings, members };
}

/** The baseline a reading is written from. A raise carries the number it raised from and the reason it was given. */
export function nextBaseline({ previous, measured, because, revision }) {
  const lines = total(measured);
  const from = Number.isFinite(previous?.ceiling) ? previous.ceiling : null;
  return {
    schema: SCHEMA,
    note:
      "The class family's size ceiling, measured - not an accepted gap. It is checked in both directions: growth " +
      "above it is `family_lines_exceeded` and a stale ceiling below it is `family_ceiling_stale`. It may only fall " +
      "except by `--update --because`, which records the number it raised from.",
    ceiling: lines,
    raisedFrom: lines > (from ?? lines) ? from : (previous?.raisedFrom ?? null),
    because: lines > (from ?? lines) ? because : (previous?.because ?? null),
    measuredAt: revision,
    files: Object.fromEntries([...measured].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function report(result, { write = (text) => process.stdout.write(`${text}\n`) } = {}) {
  if (result.blocked) {
    write(`family_population_empty: ${FAMILY_DIRECTORY} holds no file matching ${FAMILY_FILE}`);
    return 2;
  }
  const sign = result.delta > 0 ? "+" : "";
  write(`files ${result.files} · lines ${result.lines} · ceiling ${result.ceiling} · delta ${sign}${result.delta}`);
  for (const member of result.members.slice(0, 8)) {
    const mark = member.delta > 0 ? "+" : "";
    write(`  ${member.name} ${mark}${member.delta} (${member.from} -> ${member.to})`);
  }
  if (result.members.length > 8) write(`  … ${result.members.length - 8} more moved member(s)`);
  for (const finding of result.findings) write(`  ${finding.code}`);
  if (result.ok) {
    write("family_size: green");
    return 0;
  }
  if (result.findings.some((finding) => finding.code.startsWith("family_lines_exceeded"))) {
    write(
      'family_size: red · a raise is a decision: node tools/check-stardew-family-size.mjs --update --because "<why this growth is necessary>"',
    );
  } else if (result.findings.some((finding) => finding.code.startsWith("family_ceiling_stale"))) {
    write("family_size: red · the ceiling outlived a deletion: node tools/check-stardew-family-size.mjs --update");
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
  const result = judgeSize({ measured, baseline });

  if (!argv.includes("--update")) process.exitCode = report(result);
  else {
    const because = value("--because");
    if (result.files === 0) process.exitCode = report(result);
    else if (result.delta > 0 && (!because || because.trim().length < 8)) {
      process.stdout.write(
        `family_raise_reason_required:${result.ceiling}->${result.lines}: --update raises the ceiling by ${result.delta} ` +
          'line(s) and must say why (`--because "<why this growth is necessary>"`)\n',
      );
      process.exitCode = 2;
    } else {
      const next = nextBaseline({ previous: baseline, measured, because: because ?? null, revision: "working tree" });
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
      process.stdout.write(
        `family_size_baseline_written: ceiling ${next.ceiling}` +
          `${next.raisedFrom === null ? "" : ` raised from ${next.raisedFrom}`}\n`,
      );
      process.exitCode = report(judgeSize({ measured, baseline: next }));
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
