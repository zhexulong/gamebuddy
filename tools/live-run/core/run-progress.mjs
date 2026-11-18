import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { join, sep } from "node:path";

/**
 * The record a run writes WHILE it runs.
 *
 * <p>
 * WHY (measured 2026-11-17, `round66`/`round67`): three consecutive multi-day rounds left their run directory holding
 * `launch.json` and nothing else - no `result.json`, no `timeline.jsonl`, no trace - because every record this harness
 * has was written at its END. Round67's Host died between 278.98 s and 288.08 s of a four-hour budget while the game
 * kept writing its own console for another ten minutes, and no artifact said where the run had got to: the terminal log
 * simply stopped mid-delivery, and the run directory could not answer whether that delivery was the last thing that
 * happened or the first thing after a fault nobody published.
 * </p>
 * <p>
 * So one line per delivered event, appended to a file the run owns, flushed to disk before the call returns. A process
 * that dies mid-await leaves the last line it reached, and the gap between that moment and whatever else kept running is
 * then a reading instead of an absence.
 * </p>
 * <p>
 * BOUNDED BY CONSTRUCTION, not by a cap: the file carries one line per turn and one per presented piece, and both
 * populations are already bounded by the run's own turn budget (`MAX_TURNS_PER_DAY` x days) and by what the model
 * actually said. It is not a sample stream and it does not need a drain.
 * </p>
 */

export const RUN_PROGRESS_FILE = "run-progress.jsonl";

/**
 * Open the record for one run directory. Failure-tolerant like `capture`: a diagnostic write that cannot happen must not
 * end the run it is describing, so `record` answers `false` instead of throwing - and a caller that wants to know says so
 * where it can report it.
 */
export function openRunProgress({ dir, startedAtMs = Date.now() } = {}) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("run_progress_needs_a_run_directory");
  const path = join(dir, RUN_PROGRESS_FILE);
  let fd = null;
  try {
    mkdirSync(dir, { recursive: true });
    // Append mode, one descriptor for the run: an entry is written and flushed by the call that describes it, not at
    // close. A run killed between two entries keeps everything up to the second one.
    fd = openSync(path, "a");
  } catch {
    fd = null;
  }
  // WHICH RUN THIS FILE BELONGS TO, written by the open itself. The first line is what makes a surviving file
  // attributable: `launch.json` is written by the capture layer and carries the pid and start, so with the record only
  // the run that wrote it could place its own tail.
  const record = (entry) => {
    if (fd === null) return false;
    const line = `${JSON.stringify({ atMs: Date.now(), ...entry })}\n`;
    try {
      writeSync(fd, line);
      // fsync per entry: a closed handle is not the hazard here (every entry is written immediately); a process tree
      // killed by the OS, or a machine that goes down, is - and that is exactly the death this run has met twice.
      fsyncSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  record({ event: "run_opened", startedAtMs, pid: process.pid });
  return Object.freeze({
    path,
    record,
    close: () => {
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        // A close that failed has nothing left to report: the entries are already on disk.
      }
      fd = null;
    },
  });
}

/**
 * ONE run directory's progress record, read whole.
 *
 * <p>
 * This is the reading the CLOSURE takes (see `run-closure.mjs`): the launcher outlives the child, so it can count what the
 * child reached and write that count into the record of how the run ended. `null` when the file is absent - "the instrument
 * wrote nothing", which is not the same reading as "zero events". A half-written last line (what a killed process leaves)
 * is counted as unparsable rather than dropped silently or repaired.
 * </p>
 */
export function readRunProgressFile({ dir, file = RUN_PROGRESS_FILE } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return null;
  const path = join(dir, file);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const entries = [];
  let unparsable = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      unparsable += 1;
    }
  }
  const withTurn = entries.filter((entry) => Number.isInteger(entry?.turn));
  const openers = entries.filter((entry) => entry?.event === "run_opened").map((entry) => entry?.pid ?? null);
  return {
    path: path.split(sep).join("/"),
    lines: entries.length + unparsable,
    parsed: entries.length,
    unparsable,
    // WHO OPENED IT, in order: the first pid is the process that armed the file, and every later one attached to it. A
    // record whose only opener is the process it describes is the defect `an_instrument_outlives_its_subject` names.
    openedBy: openers,
    last: entries.length === 0 ? null : entries[entries.length - 1],
    lastTurn: withTurn.length === 0 ? null : withTurn[withTurn.length - 1].turn,
  };
}

/**
 * The newest run's progress record under a live-run root, and its last line.
 *
 * <p>
 * This is what turns "the round produced no result" from a sentence into evidence: the runner's last progress entry
 * names the moment the run stopped, so a reader can compare it with whatever else kept running. Newest by mtime, not by
 * name: the directory names are timestamps, but a clock that moved backwards (or a copied tree) would make a name sort
 * answer for a different run, and this reading has to be about the run that just happened.
 * </p>
 * <p>
 * `null` when nothing under the root carries one - "no run left a record" - and never a fabricated empty record.
 * </p>
 */
export function readNewestRunProgress({ root, file = RUN_PROGRESS_FILE } = {}) {
  if (typeof root !== "string" || root.length === 0) return null;
  if (!existsSync(root)) return null;
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
        continue;
      }
      if (entry.name !== file) continue;
      try {
        found.push({ path: full, mtimeMs: statSync(full).mtimeMs });
      } catch {}
    }
  };
  walk(root, 2);
  if (found.length === 0) return null;
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const newest = found[0];
  let text;
  try {
    text = readFileSync(newest.path, "utf8");
  } catch {
    return { path: newest.path, mtimeMs: newest.mtimeMs, last: null, lines: 0 };
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let last = null;
  try {
    last = lines.length === 0 ? null : JSON.parse(lines[lines.length - 1]);
  } catch {
    last = null;
  }
  return { path: newest.path.split(sep).join("/"), mtimeMs: newest.mtimeMs, last, lines: lines.length };
}
