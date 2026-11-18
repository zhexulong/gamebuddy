import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

import { openRunProgress, readRunProgressFile, RUN_PROGRESS_FILE } from "./run-progress.mjs";

/**
 * THE RECORD OF HOW A RUN ENDED, written by the process that outlives it.
 *
 * <p>
 * WHY (measured 2026-11-17, `round65`/`round66`/`round67`): of the ten most recent ladder runs, eight left a run directory
 * with no `result.json` - and nothing else that said the run had ended. Round67's run directory held `launch.json` and
 * nothing else at all: the Host went away at 278.98 s of a four-hour budget, the game kept ticking for ten more minutes,
 * and the launcher (`pid` in the launch receipt's run, the process that spawned the orchestrator) survived 641.4 s longer
 * and wrote nothing about what it had just watched. A run that died and a run that finished looked identical to every gate
 * downstream, because every gate's input is `result.json` and a dead run never writes one.
 * </p>
 * <p>
 * So the process that SURVIVES owns the ending. The launcher allocates the run directory before it spawns anything, writes
 * the launch receipt itself (the pid it holds is its own, and it is the one that will still be here), keeps the progress
 * record open across the child, and writes ONE closure record on the way out - for a clean exit, a non-zero exit, an exit
 * with no `result.json`, an interrupted launcher and a fixture takeover. A reader can then tell the two apart by asking
 * one question: does this launch receipt have a closure?
 * </p>
 * <p>
 * WHAT IT CANNOT DO, stated rather than papered over: a launcher killed by `TerminateProcess`/`SIGKILL` runs no handler, so
 * it leaves a launch receipt with no closure - and that is precisely the reading the auditor must report as BLOCKED. The
 * record does not try to cover the case it cannot reach; it makes the absence countable.
 * </p>
 */

export const RUN_LAUNCH_FILE = "launch.json";
export const RUN_CLOSURE_FILE = "closure.json";
export const RUN_CLOSURE_SCHEMA = "gamebuddy-live-run-closure/v1";
export const RUN_LAUNCH_SCHEMA = "gamebuddy-live-run-launch/v1";

/** Which endings a reader may branch on. `closed` is the only one that says the run finished its own unwind. */
export const RUN_ENDING_STATES = Object.freeze(["closed", "died", "killed", "taken_over"]);

const posix = (value) => value.split(sep).join("/");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The launch receipt, written by the process that will still be running when the child is gone.
 *
 * <p>
 * FIRST WRITER WINS, and the first writer is always the outermost process: `capture.mjs` writes this receipt for surfaces
 * that have no launcher (Chat, the frontend captures), and calls it only when the directory does not already carry one. A
 * receipt rewritten by the child would name a pid that is already dead by the time anybody asks how the run ended, which is
 * the one fact this file exists to carry.
 * </p>
 */
export function writeLaunchReceipt({ dir, kind, label = null, startedAtMs = Date.now(), pid = process.pid } = {}) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("launch_receipt_needs_a_run_directory");
  const path = join(dir, RUN_LAUNCH_FILE);
  if (existsSync(path)) return Object.freeze({ path, receipt: readJson(path), written: false });
  mkdirSync(dir, { recursive: true });
  const receipt = Object.freeze({
    schema: RUN_LAUNCH_SCHEMA,
    kind,
    label: label ?? null,
    startedAtMs,
    pid,
  });
  writeFileSync(path, `${JSON.stringify(receipt)}\n`, "utf8");
  return Object.freeze({ path, receipt, written: true });
}

/** The launch receipt this run directory carries, or null when nothing armed it. */
export function readRunLaunch({ dir } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return null;
  const receipt = readJson(join(dir, RUN_LAUNCH_FILE));
  return receipt === null || typeof receipt !== "object" ? null : receipt;
}

/** The closure record this run directory carries, or null when the run left none. */
export function readRunClosure({ dir } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return null;
  const record = readJson(join(dir, RUN_CLOSURE_FILE));
  return record === null || typeof record !== "object" ? null : record;
}

/**
 * Why the run ended, in one spelling, from the facts the surviving process actually watched.
 *
 * DERIVED, never passed in: a caller that could write `state: "closed"` beside `exitCode: 1` would be able to publish an
 * ending the run did not have.
 */
export function endingOf({ exitCode = null, signal = null, takenOver = false, childPid = null } = {}) {
  if (takenOver) return Object.freeze({ state: "taken_over", reasonCode: "fixture_taken_over" });
  if (typeof signal === "string" && signal.length > 0)
    return Object.freeze({ state: "killed", reasonCode: `launcher_killed_by_signal:${signal}` });
  if (childPid === null)
    return Object.freeze({ state: "died", reasonCode: "launcher_ended_before_the_child_was_spawned" });
  if (exitCode === 0) return Object.freeze({ state: "closed", reasonCode: "runner_exited:0" });
  if (Number.isInteger(exitCode)) return Object.freeze({ state: "died", reasonCode: `runner_exited:${exitCode}` });
  return Object.freeze({ state: "died", reasonCode: "runner_exit_unreported" });
}

/**
 * Open the run directory and the record of its ending, before anything is spawned.
 *
 * <p>
 * The handle owns three things and each has one home: the launch receipt (first writer wins), the progress record (opened
 * HERE, in the process that outlives the child, so the file survives even a child that dies before it opens its own), and
 * the closure (`close`). `close` is write-once: the FIRST ending is the ending, and a second call returns what the first
 * wrote rather than overwriting the only account of it.
 * </p>
 */
export function openRunClosure({ dir, kind, label = null, startedAtMs = Date.now() } = {}) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("run_closure_needs_a_run_directory");
  mkdirSync(dir, { recursive: true });
  const launch = writeLaunchReceipt({ dir, kind, label, startedAtMs });
  // The progress instrument is opened by the SURVIVOR. `openRunProgress` writes its own `run_opened` line carrying this
  // pid, so a reader can see the file was armed before the child existed; the child then attaches to the same file with
  // its own `run_opened` when it starts (see `openLiveRunCapture`'s run directory in the runner).
  const progress = openRunProgress({ dir, startedAtMs });
  const closurePath = join(dir, RUN_CLOSURE_FILE);

  return Object.freeze({
    dir,
    launch,
    progress,
    closurePath,
    progressPath: join(dir, RUN_PROGRESS_FILE),
    /** What the progress record holds right now - the count the closure publishes. */
    progressFacts: () => readRunProgressFile({ dir }),
    /**
     * Write the ending. `facts` carries only what the surviving process alone watched: the child's exit, the signal that
     * interrupted it, the takeover, and what became of `result.json`. Everything else is read back off the run directory.
     */
    close: (facts = {}) => closeRunClosure({ dir, startedAtMs, facts }),
  });
}

/**
 * Write the closure record for one run directory. Write-once, and it never throws: the process calling this is on its way
 * out, and a diagnostic write must not be the thing that changes how it leaves.
 */
export function closeRunClosure({ dir, startedAtMs = null, facts = {} } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return null;
  const existing = readRunClosure({ dir });
  if (existing !== null) return existing;
  const launch = readRunLaunch({ dir });
  const progress = readRunProgressFile({ dir });
  const childPid = Number.isInteger(facts.childPid) ? facts.childPid : null;
  const ending = endingOf({
    exitCode: Number.isInteger(facts.exitCode) ? facts.exitCode : null,
    signal: typeof facts.signal === "string" ? facts.signal : null,
    takenOver: facts.takenOver === true,
    childPid,
  });
  const openedAtMs = Number.isFinite(startedAtMs)
    ? startedAtMs
    : Number.isFinite(launch?.startedAtMs)
      ? launch.startedAtMs
      : null;
  const endedAtMs = Date.now();
  const record = {
    schema: RUN_CLOSURE_SCHEMA,
    run: basename(dir),
    dir: posix(dir),
    ...ending,
    endedAtMs,
    durationMs: openedAtMs === null ? null : endedAtMs - openedAtMs,
    launcher: {
      pid: Number.isInteger(launch?.pid) ? launch.pid : process.pid,
      startedAtMs: Number.isFinite(launch?.startedAtMs) ? launch.startedAtMs : null,
      // Whether THIS process wrote the receipt, or attached to one an outer process had already written. Both are usable;
      // the second one says the launcher is not the outermost owner of this run directory, which a reader should know.
      wroteReceipt: facts.wroteReceipt !== false,
    },
    child: {
      pid: childPid,
      launchedAtMs: Number.isFinite(facts.launchedAtMs) ? facts.launchedAtMs : null,
      exitCode: Number.isInteger(facts.exitCode) ? facts.exitCode : null,
      signal: typeof facts.signal === "string" ? facts.signal : null,
    },
    // `absent` is the whole point: a run whose `result.json` was never written ended without publishing what it measured.
    result: typeof facts.result === "string" ? facts.result : "unjudged",
    fixture: {
      restoreOk: facts.fixtureRestoreOk ?? null,
      restoreError: typeof facts.fixtureRestoreError === "string" ? facts.fixtureRestoreError.slice(0, 300) : null,
    },
    progress:
      progress === null
        ? { present: false, path: posix(join(dir, RUN_PROGRESS_FILE)), lines: null, lastEvent: null, lastTurn: null }
        : {
            present: true,
            path: progress.path,
            lines: progress.lines,
            unparsable: progress.unparsable,
            openedBy: progress.openedBy,
            lastEvent: typeof progress.last?.event === "string" ? progress.last.event : null,
            lastAtMs: Number.isFinite(progress.last?.atMs) ? progress.last.atMs : null,
            lastTurn: progress.lastTurn,
          },
  };
  try {
    writeFileSync(join(dir, RUN_CLOSURE_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch {
    return null;
  }
  return record;
}

/**
 * THE AUDIT: every run directory under a root, and which of the three answers it gives.
 *
 * <p>
 * The three zeroes are told apart, because a single count hides exactly the case this gate exists for:
 * </p>
 * <ul>
 *   <li>`not_measured` - no launch receipt: nothing armed this directory, so nothing can be asked of it. NAMED.</li>
 *   <li>`silent` (blocked) - a launch receipt with NO closure: a process went away without saying how. NAMED, per run.</li>
 *   <li>`closed`/`died` - a closure: the run ended, and the record says whether it finished its own unwind (`closed`) or
 *       ended badly (`died`, `killed`, `taken_over`; the last three are the "recorded died" count).</li>
 * </ul>
 * <p>
 * A RUN DIRECTORY is one that directly holds a launch receipt, a closure or a result - the three files that can only exist
 * because a run was there. A directory holding none of them is not a run and is not counted as one, so a root full of
 * leftovers cannot answer "no silent runs" for a run nobody looked at.
 * </p>
 */
export function auditRunClosures({ root, maxDepth = 6 } = {}) {
  const verdicts = [];
  const runs = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const isRun = names.has(RUN_LAUNCH_FILE) || names.has(RUN_CLOSURE_FILE) || names.has("result.json");
    if (isRun) {
      const launch = readRunLaunch({ dir });
      const closure = readRunClosure({ dir });
      const hasResult = names.has("result.json");
      // FOUR readings, because three would force two different situations into one answer. `recorded` means a closure exists
      // - the run is accounted for, and `state` says how. `not_measured` means nothing armed the directory: there was no
      // supervising process, so "did it close its record" cannot be asked of it. `ended_bundle_only` means the process armed
      // it and the run published its own bundle but no closure followed - the ending IS on disk (the bundle carries the state
      // and the reclamation account), so it is drift, printed and not red. `silent` is the shape this gate exists for: a
      // launch receipt, no closure, no bundle - the process went away and nothing says how.
      const reading =
        closure !== null ? "recorded" : launch === null ? "not_measured" : hasResult ? "ended_bundle_only" : "silent";
      runs.push({
        run: basename(dir),
        dir: posix(dir),
        reading,
        // `recorded_died` is the middle answer: the run's death IS recorded, so it is not silent and not zero either.
        state: typeof closure?.state === "string" ? closure.state : null,
        reasonCode: typeof closure?.reasonCode === "string" ? closure.reasonCode : null,
        result: typeof closure?.result === "string" ? closure.result : null,
        progressLines: closure?.progress?.lines ?? null,
        lastTurn: closure?.progress?.lastTurn ?? null,
        endedAtMs: Number.isFinite(closure?.endedAtMs) ? closure.endedAtMs : null,
      });
      verdicts.push(reading);
      return;
    }
    if (depth <= 0) return;
    for (const entry of entries)
      if (entry.isDirectory() && entry.name !== "node_modules") walk(join(dir, entry.name), depth - 1);
  };
  if (typeof root === "string" && root.length > 0 && existsSync(root)) walk(root, maxDepth);
  const of = (reading) => runs.filter((run) => run.reading === reading);
  const recorded = of("recorded");
  const silent = of("silent");
  const notMeasured = of("not_measured");
  const bundleOnly = of("ended_bundle_only");
  // A closure that records a death is NOT `closed` and NOT silent: the record exists and names the ending.
  const cleanClosed = recorded.filter((run) => run.state === "closed");
  const recordedDied = recorded.filter((run) => run.state !== "closed");
  return Object.freeze({
    root: typeof root === "string" ? posix(root) : null,
    examined: runs.length,
    recorded: recorded.length,
    closed: cleanClosed.length,
    recordedDied: recordedDied.length,
    bundleOnly: bundleOnly.length,
    silent: silent.length,
    notMeasured: notMeasured.length,
    // The populations a reader must be able to name, never only count.
    blockedRuns: Object.freeze(silent.map((run) => run.run)),
    bundleOnlyRuns: Object.freeze(bundleOnly.map((run) => run.run)),
    notMeasuredRuns: Object.freeze(notMeasured.map((run) => run.run)),
    runs: Object.freeze(runs),
    reading: Object.freeze({
      // THE BLOCKED READING, in the gate's own words, per run. An empty population is `not_measured`, never green.
      blocked:
        silent.length === 0
          ? Object.freeze([])
          : Object.freeze(
              silent.map(
                (run) =>
                  `a_run_that_died_leaves_a_record:${run.run} - a launch receipt with no closure and no result: the process that spawned this run is gone and nothing recorded how it ended (${run.dir})`,
              ),
            ),
    }),
  });
}

/** The one line the audit prints: every count, so a zero cannot be read as a total. */
export function renderClosureAudit(audit) {
  return (
    `runs examined ${audit.examined} · closed ${audit.closed} · recorded-died ${audit.recordedDied} · ` +
    `bundle-only ${audit.bundleOnly} · silent ${audit.silent} · not measured ${audit.notMeasured}`
  );
}
