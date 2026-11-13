#!/usr/bin/env node
/**
 * Guard: the marker every gate in this tree prints is `✖` (U+2716), and `×` (U+00D7) in a marker position is a
 * corrupted marker that no author typed.
 *
 * WHY. The pre-commit hook formatted staged blobs through biome's stdin mode, and that mode rewrites `✖` to `×`
 * (`tools/scripts/pre-commit.mjs` measured all five substitutions over the 2010 non-ASCII codepoints this tree
 * contains). It landed twice: `0100ae9a` committed `tools/check-gameplay-capability-catalog.test.mjs` with two
 * red-proof markers turned into `×`, and `a1389e75` - the commit that restored them - came out EMPTY because the hook
 * formatted the restored blob back into the bytes its parent already held.
 *
 * AND THE WAVE THAT WAS ALREADY THERE. This gate's first complete reading found 110 corrupted marker lines in 6 files -
 * the twelve `package.json` gate descriptions, the whole falsifier ledger, and four test headers - every one of them a
 * quoted transcript of a gate whose own output line starts with that glyph. They are repaired, and the baseline is
 * empty because they were deleted as they were repaired rather than re-recorded: the gate's reading is
 * `corrupted 0 · baselined 0`. A file that says "× <what is wrong>" where every gate prints `✖ <what is wrong>` is a
 * transcript of a gate this tree does not have. This file names both glyphs in prose and never in a marker position -
 * the rule below is what makes that possible, and the first draft of this header got it wrong and the gate reported
 * itself.
 *
 * POPULATION, derived on every run (`examined NN` is printed): every tracked file whose text contains `✖` or `×`. The
 * pairing is the point - a file containing neither cannot hold a marker, and a file containing either is where a marker
 * was written or damaged. The listing is the index (`git ls-files`), so a lane's half-written file is not repository
 * content; `--revision <rev>` reads a commit's tree instead, which is how the damage is shown on the commit that
 * caused it.
 *
 * THE RULE. `×` is a corrupted marker when it sits in a MARKER POSITION: immediately followed by a space and a
 * non-space, and immediately preceded by a backtick, by the start of the line, or by `-> `. Those three are how this
 * tree quotes a gate's own failure line - `` -> `✖ a commit carries the staged bytes` ``, `` | `✖ ...` | ``, and the
 * first line of a `red-proof:` marker. Everything else is left alone on purpose, and the boundary is real rather than
 * convenient: `2×2`, `×6`, `3 × 9`, `[✗×]` (dotnet's own glyphs) and biome's own "× Formatter would have printed" are
 * all uses of U+00D7 that are not this marker.
 *
 * BASELINE. `tools/baselines/red-proof-markers.json` records a wave of corrupted marker lines that belongs to files the
 * fixing lane does not own; it holds no entries today. An entry is identified by its FILE and its LINE TEXT, never by
 * its line number: the number is printed from the live scan. An entry whose line is no longer corrupted is reported as
 * `red_proof_marker_baseline_stale` and must be deleted, so the list cannot outlive the damage it excuses - that is how
 * the 110 entries above went, one stale finding per repaired line, and a re-record over them would have been the
 * exception list this gate exists to refuse. `--write-baseline` records a new wave.
 *
 * The baseline itself is the one file outside the population, and the census prints it as `not examined 1`: a list of
 * corruptions necessarily quotes them, so examining it would report the ledger as a defect and the ledger would have to
 * list itself.
 *
 * VERDICT. `examined N file(s) · corrupted M marker line(s) in K file(s) · baselined B · violations V · stale S`, exit
 * 1 on any violation or stale entry, exit 2 when the population is empty or git cannot answer - zero files examined is
 * a blocked reading, never a clean tree.
 *
 * red-proof: history  `node tools/check-red-proof-markers.mjs --revision a1389e75` -> `✖
 *                     red_proof_marker_corrupted:tools/check-gameplay-capability-catalog.test.mjs:2` and `:5`, exit 1;
 *                     the same file after the marker fix is clean
 * red-proof: inject  a U+00D7 marker in a `-> `-quoted transcript line -> `red_proof_marker_corrupted:<path>:<line>`;
 *                     with that entry in the baseline the run is clean, and fixing the line without deleting the entry
 *                     -> `red_proof_marker_baseline_stale` (tools/check-red-proof-markers.test.mjs). On the real tree the
 *                     same reading arrived one line at a time: the 110 repaired lines were corrected first and the run
 *                     said `corrupted 0 · baselined 0 · stale 110`, exit 1, naming every expired entry, before the
 *                     ledger was emptied
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The glyph every gate in this tree prints, and the one a `red-proof:` marker quotes. */
export const MARKER = "\u2716";

/** The glyph the formatter's stdin mode makes of it, and the one this gate refuses. */
export const CORRUPT = "\u00d7";

export const BASELINE_PATH = "tools/baselines/red-proof-markers.json";

/** A `×` occupying the position a marker's glyph occupies: after a backtick, a line start, or `-> `. */
export const MARKER_POSITION = /(?:^|`|-> )\u00d7 (?=\S)/u;

/** The corrupted marker lines of one file's text, as `{ line, text }` with `\r` stripped. */ export function corruptedLines(
  text,
) {
  const sites = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (MARKER_POSITION.test(line)) sites.push({ line: index + 1, text: line });
  }
  return sites;
}

/** Whether a file is in the population at all: it holds one of the two glyphs. */
export const holdsEitherGlyph = (text) => text.includes(MARKER) || text.includes(CORRUPT);

/**
 * The whole reading over an injected file list: population, corrupted marker lines, and the baseline comparison.
 *
 * `files` is the tracked (or revision) path list and `read` returns one file's text, or null when it is not text. The
 * counts are kept apart because they answer different questions: `examined` is what was looked at, `corrupted` is what
 * is wrong, `baselined` is what is known and excused.
 */
export function scanMarkerCorruption({ files, read, baseline = { entries: [] } }) {
  const sites = [];
  let examined = 0;
  for (const path of files) {
    const text = read(path);
    if (text === null) continue;
    if (!holdsEitherGlyph(text)) continue;
    examined += 1;
    for (const site of corruptedLines(text)) sites.push({ path, ...site });
  }

  // Content identity, counted: one baselined entry excuses one line of that file holding that exact text, so two
  // identical corrupted lines need two entries and a NEW one can never hide behind its twin.
  const budget = new Map();
  for (const entry of baseline.entries) {
    const key = `${entry.path}\u0000${entry.text}`;
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }

  const violations = [];
  let baselined = 0;
  for (const site of sites) {
    const key = `${site.path}\u0000${site.text}`;
    const left = budget.get(key) ?? 0;
    if (left === 0) {
      violations.push(site);
      continue;
    }
    budget.set(key, left - 1);
    baselined += 1;
  }

  const stale = [];
  for (const [key, left] of budget) {
    if (left === 0) continue;
    const separator = key.indexOf("\u0000");
    stale.push({ path: key.slice(0, separator), text: key.slice(separator + 1), unused: left });
  }

  return {
    examined,
    corrupted: sites.length,
    corruptedFiles: new Set(sites.map((site) => site.path)).size,
    sites,
    baselined,
    violations,
    stale,
  };
}

/** The baseline payload for a reading: every corrupted line, sorted so a re-record is a no-op on a clean reread. */
export function baselinePayload(sites, why) {
  const entries = sites
    .map((site) => ({ path: site.path, text: site.text }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.text.localeCompare(right.text));
  return { why, entries };
}

/** A baseline file's payload, or an empty baseline when there is none; a malformed entry is refused, not skipped. */
export function loadBaseline(payload) {
  if (payload === null || payload === undefined) return { entries: [] };
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const malformed = entries.filter(
    (entry) => typeof entry?.path !== "string" || typeof entry?.text !== "string" || entry.text === "",
  );
  if (malformed.length > 0)
    throw new Error(`the baseline carries an entry that is not { path, text }: ${JSON.stringify(malformed[0])}`);
  return { entries };
}

const WHY =
  "Red-proof markers corrupted in files the fixing lane does not own, recorded so the gate can be wired before those " +
  "waves are repaired. Each entry is one file and one line's exact text; fixing the line makes the entry stale and a " +
  "stale entry fails the gate until it is deleted, which is what keeps this list from outliving the damage. Delete " +
  "entries as the waves are repaired; do not re-record over them.";

/** One file's text, or null when it is not text: a NUL byte means a formatter and this gate would disagree. */
function readText(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  if (bytes.includes(0x00)) return null;
  return bytes.toString("utf8");
}

/** The one path outside the population: the ledger quotes every corruption it excuses. */
export const NOT_A_TRANSCRIPT = new Set([BASELINE_PATH]);

/** The index's file list and a reader over the worktree. */
function worktreeSources() {
  const paths = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    windowsHide: true,
  })
    .split("\0")
    .filter(Boolean)
    .sort();
  return { paths, read: (path) => readText(resolve(ROOT, path)) };
}
/**
 * One commit's tree, read through `git cat-file --batch`.
 *
 * ASCII arguments only: on Windows a non-ASCII argument reaches git through the ANSI code page and `✖` does not survive
 * the trip - the exact class of damage this gate exists for, so the gate may not be built on it. Contents are matched
 * as UTF-8 bytes.
 */
function revisionSources(revision) {
  const paths = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", revision], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    windowsHide: true,
  })
    .split("\0")
    .filter(Boolean)
    .sort();
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
    input: paths.map((path) => `${revision}:${path}\n`).join(""),
    maxBuffer: 1 << 28,
    windowsHide: true,
  });
  const texts = new Map();
  let cursor = 0;
  for (const path of paths) {
    const headerEnd = output.indexOf(0x0a, cursor);
    if (headerEnd === -1) break;
    const header = output.subarray(cursor, headerEnd).toString("utf8");
    cursor = headerEnd + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    const body = output.subarray(cursor, cursor + size);
    cursor += size + 1;
    if (body.includes(0x00)) continue;
    texts.set(path, body.toString("utf8"));
  }
  return { paths, read: (path) => texts.get(path) ?? null };
}

function main(argv) {
  const writeBaseline = argv.includes("--write-baseline");
  const revisionIndex = argv.indexOf("--revision");
  const revision = revisionIndex === -1 ? null : (argv[revisionIndex + 1] ?? null);
  if (writeBaseline && revision !== null) {
    process.stderr.write("red_proof_marker_baseline_against_revision: --write-baseline records the worktree\n");
    process.exitCode = 1;
    return;
  }

  const sources = revision === null ? worktreeSources() : revisionSources(revision);

  let baseline = { entries: [] };
  if (!writeBaseline) {
    let payload = null;
    try {
      payload = JSON.parse(readFileSync(resolve(ROOT, BASELINE_PATH), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        process.stderr.write(`red_proof_marker_baseline_unreadable: ${error.message}\n`);
        process.exitCode = 1;
        return;
      }
    }
    baseline = loadBaseline(payload);
  }

  const reading = scanMarkerCorruption({
    files: sources.paths.filter((path) => !NOT_A_TRANSCRIPT.has(path)),
    read: sources.read,
    baseline,
  });
  if (writeBaseline) {
    writeFileSync(resolve(ROOT, BASELINE_PATH), `${JSON.stringify(baselinePayload(reading.sites, WHY), null, 2)}\n`);
    process.stdout.write(
      `red_proof_markers: recorded ${reading.sites.length} corrupted marker line(s) in ${BASELINE_PATH}\n`,
    );
    return;
  }

  const notExamined = sources.paths.filter((path) => NOT_A_TRANSCRIPT.has(path)).length;
  const census =
    `examined ${reading.examined} file(s) · corrupted ${reading.corrupted} marker line(s) in ` +
    `${reading.corruptedFiles} file(s) · baselined ${reading.baselined} · violations ${reading.violations.length} · ` +
    `stale ${reading.stale.length} · not examined ${notExamined} (the baseline quotes what it excuses)`;

  if (reading.examined === 0) {
    process.stderr.write(
      `red_proof_marker_no_population: ${census} - no file contains U+2716 or U+00D7, so nothing was looked at\n`,
    );
    process.exitCode = 2;
    return;
  }

  for (const site of reading.violations)
    process.stderr.write(`✖ red_proof_marker_corrupted:${site.path}:${site.line}  ${site.text.trim().slice(0, 120)}\n`);
  for (const entry of reading.stale)
    process.stderr.write(
      `✖ red_proof_marker_baseline_stale:${entry.path}  ${JSON.stringify(entry.text.trim().slice(0, 120))} - the line ` +
        `is no longer corrupted, so its entry has expired; delete it from ${BASELINE_PATH}\n`,
    );

  process.stdout.write(`red_proof_markers: ${census}\n`);
  if (reading.violations.length > 0 || reading.stale.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
