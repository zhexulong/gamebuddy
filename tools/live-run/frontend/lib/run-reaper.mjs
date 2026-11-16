// A harness that is HARD-KILLED runs no exit handler, so nothing in `lib/run-owner.mjs` ever happens: no
// teardown, no ledger, no assertion - and the game it opened stays on screen. That is not a leak of the
// ordinary kind. The product keeps a player's world alive when the guardian's control channel dies
// (`host/native/windows-bootstrap-guardian/Program.cs` creates the player Job with `killOnJobClose: false`,
// product rule #3023), which is right for a player and is exactly why a force-killed HARNESS is left
// holding a game: the guardian's EOF drains AI authority and deliberately not the world.
//
// The next run of that stage is the only thing that can take it back, and it must take back nothing else.
// The material is already on disk: `<stage>/state/run-processes.jsonl` records `{pid, role, startTime}` for
// every process the run registered, and the OS is the authority for what those pids are NOW.
//
// Three facts, all of them required, before one pid is terminated:
//
//   alive            the pid is in the process table. Absent is `reaper_already_gone`, which is an answer.
//   same start time  the OS creation time equals the one recorded. Windows recycles pids, so a pid alone
//                    names nothing: without this check the reaper is a game-killer that shoots whatever
//                    inherited the number, including the player's own Stardew. A record that carries no
//                    start time (the drivers registered before this kit recorded times) cannot pass this
//                    check, so it must pass the third one on its own.
//   this stage root  its command line names this stage's root, or its parent chain reaches a pid this stage
//                    recorded as its Mod loader. The second half is not a convenience: `Stardew Valley.exe`
//                    is launched with no arguments at all (that is what `lib/run-game.mjs` exists for), so
//                    the only path it carries to the run is the parent it was born under - and Windows
//                    preserves the parent pid after that parent exits, which is exactly the orphaned shape.
//
// WHEN it acts matters as much as what it acts on. A stepwise run deliberately leaves its session running
// for the next phase (`lib/config.mjs`'s header, `deliberatelyKept({stepwise:true})`), so a reaper that ran
// unconditionally at every start would pull the mounted product out from under `node run.mjs capture`. The
// discriminator is not a guess about the process table: it is `state/inflight.json`, written when an
// invocation starts and removed by `close()` on every way out it controls. A marker whose owner is gone is
// the one fact that says "that invocation was hard-killed" - and a marker whose owner is alive is the one
// fact that says "do not touch this stage; someone is using it".
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { killProcessTree, processRow, processTable, processesWithCommandLine } from "./process-table.mjs";
import { GAME_LOADER_ROLE } from "./run-game.mjs";
import { registeredRunProcesses } from "./run-owner.mjs";

/** The prefix of every summary line the reaper prints, so a run's terminal has one handle for it. */
export const REAPER_PREFIX = "REAPER";

/** How far up a parent chain is followed before the chain is called unreadable. A game sits two hops deep. */
const CHAIN_HOPS = 8;

/**
 * The invocation that is still inside `<stage>/state/` - the marker `openRunInvocation` writes and `close()`
 * removes. `null` when there is none, and also when the file is unreadable: an unreadable marker is not
 * evidence of a hard kill, and the reaper only acts on evidence.
 */
export function readRunInvocation(paths) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(paths.inflightFile, "utf8"));
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(marker?.pid) || marker.pid <= 0) return null;
  return Object.freeze({
    pid: marker.pid,
    startTime: typeof marker.startTime === "string" ? marker.startTime : null,
    phase: typeof marker.phase === "string" ? marker.phase : null,
    at: typeof marker.at === "string" ? marker.at : null,
  });
}

/**
 * Claim this stage for this invocation, and hand back whatever the PREVIOUS invocation left behind: its
 * marker, or `null` if it left none (it closed, or there was none).
 *
 * The read happens before the write, so the marker this invocation returns to the reaper is its
 * predecessor's. `startTime` is the OS's own creation time for this pid, read once: it is what lets the
 * NEXT run tell this invocation apart from a process that inherited the number.
 */
export function openRunInvocation({ paths, phase = null, readRow = processRow } = {}) {
  const previous = readRunInvocation(paths);
  const row = readRow(process.pid);
  const marker = {
    pid: process.pid,
    startTime: row?.startTime ?? null,
    phase: phase === null ? "full" : String(phase),
    at: new Date().toISOString(),
  };
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.inflightFile, `${JSON.stringify(marker, null, 1)}\n`, "utf8");
  return previous;
}

/** Release the stage: every way out that reaches `close()` says so here, and leaves the next run nothing to reap. */
export function closeRunInvocation(paths) {
  rmSync(paths.inflightFile, { force: true });
}

/** Whether a marker's own process is still the process it names, decided by the same two facts as any record. */
function invocationAlive(marker, byPid) {
  const row = byPid.get(marker.pid);
  if (row === undefined) return false;
  return marker.startTime === null || row.startTime === marker.startTime;
}

/**
 * The records ordered so a recorded child is acted on BEFORE the recorded parent whose termination would take
 * it down too. Without this, the Mod loader's tree kill ends the game client first and the client's own record
 * is then reported as an unrelated second death (`already_gone`), which is a false sentence about causation.
 */
function leavesFirst(records, byPid) {
  const recorded = new Set(records.map((record) => record.pid));
  const depth = (pid, seen = new Set()) => {
    if (seen.has(pid)) return 0;
    seen.add(pid);
    const parentPid = byPid.get(pid)?.parentPid;
    if (!(Number.isSafeInteger(parentPid) && recorded.has(parentPid))) return 0;
    return 1 + depth(parentPid, seen);
  };
  return [...records].sort((left, right) => depth(right.pid) - depth(left.pid));
}

/**
 * Why this row is this stage's, or `null` when it cannot be shown.
 *
 * `stagePids` is one query for the processes whose command line contains this stage's root; `anchorPids` are the
 * pids this stage recorded as its Mod loader. Both are whole-table facts, gathered once, so attributing ten
 * records costs two probes rather than twenty.
 */
function stageEvidence(row, { stagePids, anchorPids, byPid }) {
  if (stagePids.has(row.pid)) return "stage_root_in_command_line";
  let pid = row.parentPid;
  for (let hop = 0; hop < CHAIN_HOPS && Number.isSafeInteger(pid); hop += 1) {
    // The anchor is checked before its own row is looked up: the loader has usually EXITED by the time its
    // client is an orphan, and Windows keeps the parent pid it was born with precisely for this question.
    if (anchorPids.has(pid)) return `child_of_recorded_game_loader:${pid}`;
    const parent = byPid.get(pid);
    if (parent === undefined) return null;
    pid = parent.parentPid;
  }
  return null;
}

const frozen = (reading) =>
  Object.freeze({
    ...reading,
    terminated: Object.freeze(reading.terminated ?? []),
    alreadyGone: Object.freeze(reading.alreadyGone ?? []),
    couldNotTerminate: Object.freeze(reading.couldNotTerminate ?? []),
    identityMismatch: Object.freeze(reading.identityMismatch ?? []),
    skipped: Object.freeze(reading.skipped ?? []),
  });

/**
 * Take back what a hard-killed invocation of THIS stage left, and nothing else.
 *
 * `attempts` re-reads of the table are the assertion that a terminated pid is really gone; each re-read costs one
 * probe, which is the wait, so no timer is needed and the loop only runs while something is still there.
 */
export function reapRunOrphans({
  paths,
  stageRoot = paths?.stageRoot,
  previous = paths === undefined ? null : readRunInvocation(paths),
  records = paths === undefined ? [] : registeredRunProcesses(paths),
  readTable = processTable,
  readStage = processesWithCommandLine,
  kill = killProcessTree,
  attempts = 8,
} = {}) {
  const examined = records.length;
  if (previous === null) return frozen({ evidence: "no_orphaned_invocation", stageRoot, previous, examined });
  const table = readTable();
  if (table === null) return frozen({ evidence: "process_table_unavailable", stageRoot, previous, examined });
  const byPid = new Map(table.rows.map((row) => [row.pid, row]));
  if (invocationAlive(previous, byPid))
    return frozen({
      evidence: "previous_invocation_alive",
      stageRoot,
      previous,
      examined,
      tableExamined: table.examined,
      skipped: [
        {
          pid: previous.pid,
          role: "invocation",
          reason: `an earlier invocation of this stage is still running (phase ${String(previous.phase)}, started ${String(previous.at)}) - this run does not take a running invocation's processes`,
        },
      ],
    });

  const stagePids = new Set((readStage(resolve(stageRoot))?.rows ?? []).map((row) => row.pid));
  const anchorPids = new Set(records.filter((record) => record.role === GAME_LOADER_ROLE).map((record) => record.pid));

  const terminated = [];
  const alreadyGone = [];
  const couldNotTerminate = [];
  const identityMismatch = [];
  const skipped = [];
  for (const record of leavesFirst(records, byPid)) {
    const role = record.role ?? "unrecorded";
    if (record.pid === process.pid) {
      skipped.push({ pid: record.pid, role, reason: "this invocation's own process" });
      continue;
    }
    const row = byPid.get(record.pid);
    if (row === undefined) {
      alreadyGone.push({ pid: record.pid, role });
      continue;
    }
    if (record.startTime !== null && row.startTime !== record.startTime) {
      identityMismatch.push({ pid: record.pid, role, recorded: record.startTime, observed: row.startTime });
      continue;
    }
    const identity = stageEvidence(row, { stagePids, anchorPids, byPid });
    if (identity === null) {
      skipped.push({
        pid: record.pid,
        role,
        reason:
          record.startTime === null
            ? "recorded without a start time, and neither its command line nor its parent chain names this stage root"
            : "its start time matches but neither its command line nor its parent chain names this stage root",
      });
      continue;
    }
    const outcome = kill(record.pid);
    if (outcome === "already_exited") alreadyGone.push({ pid: record.pid, role });
    else if (outcome === "unavailable") couldNotTerminate.push({ pid: record.pid, role, reason: "kill_unavailable" });
    else terminated.push({ pid: record.pid, role, identity });
  }

  // "Terminated" is a claim about the machine, so it is read back rather than assumed: a force kill is
  // asynchronous, and a pid still there after the bound is a different finding from one that went away.
  let surviving = new Set(terminated.map((entry) => entry.pid));
  for (let attempt = 1; attempt <= Math.max(1, attempts) && surviving.size > 0; attempt += 1) {
    const after = readTable();
    if (after === null) break;
    const alive = new Set(after.rows.map((row) => row.pid));
    surviving = new Set([...surviving].filter((pid) => alive.has(pid)));
  }
  const stillThere = terminated.filter((entry) => surviving.has(entry.pid));
  for (const entry of stillThere) couldNotTerminate.push({ ...entry, reason: "still_alive_after_kill" });

  return frozen({
    evidence: "reaped",
    stageRoot,
    previous,
    examined,
    tableExamined: table.examined,
    terminated: terminated.filter((entry) => !surviving.has(entry.pid)),
    alreadyGone,
    couldNotTerminate,
    identityMismatch,
    skipped,
  });
}

const listed = (entries) => entries.map((entry) => `${entry.pid}(${entry.role})`).join(" ");

/**
 * The reaper's lines: one per case, then the summary with its counts and the size of the population it read.
 *
 * `no_orphaned_invocation` is a real answer and not a silent one: it says the previous invocation reached its
 * own close, so whatever it left running was left on purpose (a stepwise session is the next phase's input).
 */
export function describeReaper(reading) {
  if (reading.evidence === "process_table_unavailable")
    return [
      `${REAPER_PREFIX}: unverifiable:process_table_unavailable - this machine could not be asked which processes are alive, so nothing left by an earlier invocation was terminated (examined ${String(reading.examined)} recorded identities of ${String(reading.stageRoot)})`,
    ];
  const invocation = reading.previous;
  if (reading.evidence === "no_orphaned_invocation")
    return [
      `${REAPER_PREFIX}: nothing to reap - no earlier invocation of ${String(reading.stageRoot)} died without closing (examined ${String(reading.examined)} recorded identities; a stepwise session it left behind is the next phase's input, not an orphan)`,
    ];
  const lines = [];
  for (const entry of reading.terminated) lines.push(`reaper_terminated: ${entry.pid}(${entry.role})`);
  for (const entry of reading.alreadyGone) lines.push(`reaper_already_gone: ${entry.pid}`);
  for (const entry of reading.couldNotTerminate) lines.push(`reaper_could_not_terminate: ${entry.pid}`);
  for (const entry of reading.identityMismatch) lines.push(`reaper_identity_mismatch: ${entry.pid}`);
  for (const entry of reading.skipped) lines.push(`reaper_skipped: ${entry.pid}: ${entry.reason}`);
  const counts = [
    `examined ${String(reading.examined)} recorded for ${String(reading.stageRoot)}`,
    reading.tableExamined === undefined ? null : `${String(reading.tableExamined)} processes in the table`,
    `terminated ${String(reading.terminated.length)}`,
    `already-gone ${String(reading.alreadyGone.length)}`,
    `could-not-terminate ${String(reading.couldNotTerminate.length)}`,
    `identity-mismatch ${String(reading.identityMismatch.length)}`,
    `skipped ${String(reading.skipped.length)}`,
  ].filter((part) => part !== null);
  if (reading.couldNotTerminate.length > 0)
    lines.push(
      `${REAPER_PREFIX}: COULD NOT TERMINATE ${listed(reading.couldNotTerminate)} - a process an earlier invocation left is still on this machine`,
    );
  if (reading.identityMismatch.length > 0)
    lines.push(
      `${REAPER_PREFIX}: ${listed(reading.identityMismatch)} recorded a pid whose start time no longer matches - the OS handed that number to another process, and it was left alone`,
    );
  lines.push(
    reading.evidence === "previous_invocation_alive"
      ? `${REAPER_PREFIX}: nothing was touched (${counts.join(", ")})`
      : `${REAPER_PREFIX}: ${counts.join(", ")} (the previous invocation, pid ${String(invocation.pid)}, never closed)`,
  );
  return lines;
}

/** Beside the run, so a reader can see what the next run took back after a hard kill. */
export function writeReaperReading(paths, reading) {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.reaperFile, `${JSON.stringify(reading, null, 1)}\n`, "utf8");
}
