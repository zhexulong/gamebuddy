#!/usr/bin/env node
/**
 * What differs between the input two runs were given.
 *
 * <p>
 * A run writes `input-manifest.json` beside its result (`tools/live-run/core/input-manifest.mjs`). This reads two of
 * them and prints, per section, what is unchanged, what was added, what was removed and what changed - with the line
 * itself. It exists because the alternative was already tried: `round53` -> `round54` changed behaviour completely and
 * the cause was reconstructed by hand from a session record, wrongly, three times in one day. A behavioural difference
 * is attributable to an input difference only when the input has been read for it.
 * </p>
 *
 * <p>
 * A MISSING MANIFEST IS NOT "NO DIFFERENCES". Absent, unreadable or empty input on either side exits 2 and names the run
 * (`input_manifest_not_measured:<run>`), because a comparison nobody could make and a comparison that found nothing are
 * different answers and only one of them is evidence.
 * </p>
 *
 * Usage:
 *   node tools/compare-run-inputs.mjs round53 round54
 *   node tools/compare-run-inputs.mjs tools/_multiday_routine-round53.result.json tools/_multiday_routine-round54.result.json
 *   node tools/compare-run-inputs.mjs <dir> <dir>
 *
 * Exit codes: 0 compared (whatever it found), 2 nothing could be compared.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_FILE = "input-manifest.json";
const RESULT_SUFFIX = ".result.json";
const MANIFEST_SUFFIX = ".input-manifest.json";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where one argument's manifest is.
 *
 * A directory holds `input-manifest.json`; a result path names its manifest by the same stem; a bare label (`round54`)
 * is resolved against `tools/` - exactly one match, never the newest, because a comparison against a neighbour's
 * manifest is the defect `findRunSessionJsonl` already had to close.
 */
export function resolveManifestPath(argument, { repositoryRoot = REPOSITORY_ROOT } = {}) {
  if (existsSync(argument)) {
    if (statSync(argument).isDirectory()) return { path: join(argument, MANIFEST_FILE), reason: null };
    // An existing file IS the manifest, whatever it is called: a copy kept under a scratch name is still the input a
    // run was given, and refusing it would push a reader back to a label that resolves to a different run.
    if (statSync(argument).isFile()) return { path: argument, reason: null };
  }
  if (argument.endsWith(MANIFEST_SUFFIX)) return { path: argument, reason: null };
  if (argument.endsWith(RESULT_SUFFIX)) {
    return { path: `${argument.slice(0, -RESULT_SUFFIX.length)}${MANIFEST_SUFFIX}`, reason: null };
  }
  const toolsDir = join(repositoryRoot, "tools");
  const suffix = `-${argument}${MANIFEST_SUFFIX}`;
  const matches = existsSync(toolsDir)
    ? readdirSync(toolsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
        .map((entry) => join(toolsDir, entry.name))
    : [];
  if (matches.length === 1) return { path: matches[0], reason: null };
  return {
    path: null,
    reason:
      matches.length === 0
        ? `no_manifest_for_label:${argument}`
        : `ambiguous_label:${argument}:${String(matches.length)}`,
  };
}

/** The lines of one text, as a diff needs them: a text with no newline is still one line. */
const linesOf = (text) => (typeof text === "string" ? text.split("\n") : []);

/** Longest-common-subsequence operations over two line lists. */
function lineOps(before, after) {
  const rows = before.length;
  const columns = after.length;
  const table = Array.from({ length: rows + 1 }, () => new Int32Array(columns + 1));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row][column] =
        before[row] === after[column]
          ? table[row + 1][column + 1] + 1
          : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }
  const ops = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      ops.push({ kind: "unchanged", line: before[row] });
      row += 1;
      column += 1;
    } else if (table[row + 1][column] >= table[row][column + 1]) {
      ops.push({ kind: "removed", was: before[row] });
      row += 1;
    } else {
      ops.push({ kind: "added", now: after[column] });
      column += 1;
    }
  }
  for (; row < rows; row += 1) ops.push({ kind: "removed", was: before[row] });
  for (; column < columns; column += 1) ops.push({ kind: "added", now: after[column] });
  return ops;
}

/**
 * A rewritten line is a CHANGE, not a removal beside an addition: a reader diffing one conduct rule wants the sentence
 * that moved, and pairing the removed run with the added run keeps `changed` meaning that.
 */
function pairRewrites(ops) {
  const paired = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op.kind === "unchanged") {
      paired.push(op);
      index += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (index < ops.length && ops[index].kind !== "unchanged") {
      if (ops[index].kind === "removed") removed.push(ops[index].was);
      else added.push(ops[index].now);
      index += 1;
    }
    const rewrites = Math.min(removed.length, added.length);
    for (let offset = 0; offset < rewrites; offset += 1)
      paired.push({ kind: "changed", was: removed[offset], now: added[offset] });
    for (let offset = rewrites; offset < removed.length; offset += 1)
      paired.push({ kind: "removed", was: removed[offset] });
    for (let offset = rewrites; offset < added.length; offset += 1) paired.push({ kind: "added", now: added[offset] });
  }
  return paired;
}

/** One section of both manifests: its counts and the lines that moved. */
function compareSection(id, before, after) {
  const was = linesOf(before?.text);
  const now = linesOf(after?.text);
  const row = { id, onlyIn: null, unchanged: 0, added: 0, removed: 0, changed: 0, detail: [] };
  if (before === undefined || after === undefined) {
    row.onlyIn = before === undefined ? "b" : "a";
    row.changed = Math.max(was.length, now.length);
    if (row.onlyIn === "b") {
      row.added = now.length;
      row.detail = now.map((line) => ({ kind: "added", id, now: line }));
    } else {
      row.removed = was.length;
      row.detail = was.map((line) => ({ kind: "removed", id, was: line }));
    }
    return row;
  }
  for (const op of pairRewrites(lineOps(was, now))) {
    if (op.kind === "unchanged") row.unchanged += 1;
    else {
      row[op.kind] += 1;
      row.detail.push({ ...op, id });
    }
  }
  return row;
}

/**
 * The whole comparison: one row per section id, in the order the first run delivered them, then ids the second run
 * delivered alone. `changed` counts sections, so `changed 0` with `compared > 0` is the claim "these two inputs are the
 * same input".
 */
export function compareInputManifests(before, after) {
  const beforeSections = new Map((before?.sections ?? []).map((section) => [section.id, section]));
  const afterSections = new Map((after?.sections ?? []).map((section) => [section.id, section]));
  const ids = [...beforeSections.keys(), ...[...afterSections.keys()].filter((id) => !beforeSections.has(id))];
  const rows = ids.map((id) => compareSection(id, beforeSections.get(id), afterSections.get(id)));
  return {
    compared: rows.length,
    changed: rows.filter((row) => row.unchanged === 0 || row.changed > 0).length,
    rows,
  };
}

/** The report as the terminal reads it: one line per section, then the detail of every line that moved. */
export function renderComparison(report, { width = 38 } = {}) {
  const lines = [];
  for (const row of report.rows) {
    const counts =
      row.onlyIn === null
        ? `unchanged ${String(row.unchanged)} · added ${String(row.added)} · removed ${String(row.removed)} · changed ${String(row.changed)}`
        : `only in ${row.onlyIn} · ${String(row.changed)} line(s)`;
    lines.push(`${row.id.padEnd(width)} ${counts}`);
    for (const entry of row.detail) {
      if (entry.kind === "changed")
        lines.push(`  changed: ${JSON.stringify(entry.was)} -> ${JSON.stringify(entry.now)}`);
      else if (entry.kind === "added") lines.push(`  added: ${JSON.stringify(entry.now)}`);
      else lines.push(`  removed: ${JSON.stringify(entry.was)}`);
    }
  }
  lines.push(`sections compared ${String(report.compared)} · changed ${String(report.changed)}`);
  return lines;
}

/** One manifest, or the answer that says why nothing can be compared with it. */
function loadManifest(runSpec) {
  const resolved = resolveManifestPath(runSpec);
  if (resolved.path === null || !existsSync(resolved.path))
    return { manifest: null, path: resolved.path, reason: `input_manifest_not_measured:${runSpec}` };
  try {
    const manifest = JSON.parse(readFileSync(resolved.path, "utf8"));
    if (!Array.isArray(manifest?.sections))
      return { manifest: null, path: resolved.path, reason: `input_manifest_not_measured:${runSpec}:no_sections` };
    if (manifest.sections.length === 0)
      return { manifest: null, path: resolved.path, reason: `input_manifest_not_measured:${runSpec}:empty` };
    return { manifest, path: resolved.path, reason: null };
  } catch {
    return { manifest: null, path: resolved.path, reason: `input_manifest_not_measured:${runSpec}:unreadable` };
  }
}

function main(argv) {
  const [runA, runB] = argv;
  if (runA === undefined || runB === undefined) {
    process.stderr.write("compare-run-inputs: <runA> <runB>\n");
    process.exitCode = 2;
    return;
  }
  const left = loadManifest(runA);
  const right = loadManifest(runB);
  const missing = [left, right].filter((side) => side.manifest === null);
  if (missing.length > 0) {
    for (const side of missing) process.stderr.write(`${side.reason}\n`);
    process.exitCode = 2;
    return;
  }
  const report = compareInputManifests(left.manifest, right.manifest);
  if (report.compared === 0) {
    process.stderr.write(`input_manifest_not_measured:${runA}:nothing_to_compare\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`a ${left.path}\nb ${right.path}\n`);
  for (const line of renderComparison(report)) process.stdout.write(`${line}\n`);
  process.exitCode = 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
