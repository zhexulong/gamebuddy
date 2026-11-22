/**
 * THE CHILDREN ONE LIVE RUN STARTS, EACH WITH ITS OWN EXIT, AND WHICH OF THEM LEFT FIRST.
 *
 * <p>
 * WHY (measured 2026-11-22, `round90`: 8 minutes, `blocked / bridge_disconnected`). `process-reclamation.json` held ONE
 * row - `pid 39172`, the game, `closeOutcome: "killed"`, `exit: {code: null, signal: null}` - because the game was the
 * only process the record could name at all. The Mod's own log ended at
 * `ai_player_control_pipe_reader_ended:EndOfStreamException` -> `invalidated the local execution because the bridge
 * disconnected`, i.e. the pipe's CLIENT had gone first and the game's kill was this run's consequence. The Host's exit -
 * its code, its signal, the instant it happened - was recorded nowhere, so no reader could tell "the Host crashed" from
 * "the game was killed and the Host noticed".
 * </p>
 * <p>
 * So the record lists EVERY process the run started, in spawn order, each with the exit its own handle reported. Two
 * rules make it readable:
 * </p>
 * <ul>
 *   <li>an exit nobody observed reads `unknown` and is never written as `0`: the absence of a code is not a clean ending
 *       (see `childReading`);</li>
 *   <li>the ORDER is derived from the exit instants (`firstToLeave`), because "who left first" is the diagnosis and a
 *       field the caller could simply assert would only repeat what the caller already believed.</li>
 * </ul>
 * <p>
 * The file this writes is the one `launcherReclamationSteps` reads (`process-reclamation.json`), and it has two writers
 * because each one holds a different child's handle: the orchestrator writes the rows it spawned, the launcher merges in
 * its own (see `writeChildRecord` and `mergeChildren`).
 * </p>
 */
import { readFileSync, writeFileSync } from "node:fs";

/**
 * The processes a run can start, and what each one is.
 *
 * <p>
 * `orchestrator` is the launcher's own child; `game` is the SMAPI process; `host` is the process that carries the Host
 * runtime, the bridge the Mod talks to and the AI player loop (the ladder runner). `ai-player` is a SEPARATE AI client
 * process, which the product separates from the Host and this harness currently runs inside it - so a ladder run has no
 * row with that role, and the vocabulary holds the name rather than inventing a pid for it.
 * </p>
 */
export const CHILD_ROLES = Object.freeze(["game", "host", "ai-player", "orchestrator"]);

/** The exit of a child nobody watched leave. One frozen value, so a null code is never confused with a zero. */
const UNOBSERVED_EXIT = Object.freeze({ code: null, signal: null, atMs: null });

/**
 * Whether a pid is still in the process table, which is what `survivedTeardown` means.
 *
 * Signal 0 asks the question without signalling anything. `EPERM` answers "it exists, and it is not yours" - still
 * alive.
 */
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Collect the children ONE process starts.
 *
 * `started` takes the pid and the instant the spawn was issued; `ended` takes the pair the child's own handle reported
 * (`close`'s code and signal) and the instant it reported it. The first ending is the ending: a second report for one
 * pid cannot rewrite how it left.
 */
export function openChildRoster({ roles = CHILD_ROLES, now = () => Date.now() } = {}) {
  const rows = [];
  const rowOf = (pid) => rows.find((row) => row.pid === pid) ?? null;
  return Object.freeze({
    started({ role, pid, startedAtMs = now() } = {}) {
      if (!roles.includes(role)) throw new Error(`child_role_unknown:${String(role)}`);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`child_pid_invalid:${String(pid)}`);
      if (!Number.isFinite(startedAtMs)) throw new Error(`child_start_instant_invalid:${pid}`);
      if (rowOf(pid) !== null) throw new Error(`child_already_started:${pid}`);
      rows.push({ role, pid, startedAtMs });
      return rows[rows.length - 1];
    },
    ended({ pid, code = null, signal = null, atMs = now() } = {}) {
      const row = rowOf(pid);
      // An exit this roster has no spawn for cannot be given a role, and a row invented here would name a process this
      // run did not start.
      if (row === null) throw new Error(`child_exit_without_a_start:${String(pid)}`);
      if (row.exit !== undefined) return row;
      row.exit = observeExit({ code, signal, atMs });
      return row;
    },
    rows: () => Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
    record: ({ isAlive = processAlive } = {}) => childrenRecord(rows, { isAlive }),
  });
}

/** One exit, in the closed shape a reader branches on: a code, a signal, or neither - never a substituted zero. */
function observeExit({ code = null, signal = null, atMs = null } = {}) {
  return Object.freeze({
    code: Number.isInteger(code) ? code : null,
    signal: typeof signal === "string" && signal.length > 0 ? signal : null,
    atMs: Number.isFinite(atMs) ? atMs : null,
  });
}

/**
 * The record's rows, and the ordering derived from them.
 *
 * `survivedTeardown` is MEASURED here, at the instant this is called, and never inferred from the exit record: round90's
 * game was reaped while no exit was ever reported to the runtime, so "no exit observed" is not "the process is gone". A
 * row that already carries the boolean keeps it - the process that measured it is the only authority for that reading.
 */
export function childrenRecord(rows, { isAlive = processAlive } = {}) {
  const children = (Array.isArray(rows) ? rows : []).map((row) => {
    const exit = row?.exit ?? UNOBSERVED_EXIT;
    return Object.freeze({
      role: row.role,
      pid: row.pid,
      startedAtMs: Number.isFinite(row.startedAtMs) ? row.startedAtMs : null,
      exit: observeExit(exit),
      survivedTeardown: typeof row.survivedTeardown === "boolean" ? row.survivedTeardown : isAlive(row.pid) === true,
    });
  });
  return Object.freeze({ children: Object.freeze(children), firstToLeave: firstToLeave(children) });
}

/** How one child left, in one spelling: `host:code=1`, `host:signal=SIGTERM`, or `host:unknown`. */
export function childReading(child) {
  const exit = child?.exit ?? UNOBSERVED_EXIT;
  if (Number.isInteger(exit.code)) return `${child.role}:code=${exit.code}`;
  if (typeof exit.signal === "string") return `${child.role}:signal=${exit.signal}`;
  return `${child.role}:unknown`;
}

/**
 * Which child left FIRST, as its reading, or null when no exit instant was observed.
 *
 * A row with no observed instant cannot be ordered at all, so it is left out of the comparison rather than treated as
 * the earliest. Two children leaving on the same instant are ordered by when they STARTED, so the reading does not
 * depend on the order the rows happen to be written in.
 */
export function firstToLeave(children) {
  const startedBefore = (child, other) =>
    Number.isFinite(child?.startedAtMs) &&
    (!Number.isFinite(other?.startedAtMs) || child.startedAtMs < other.startedAtMs);
  let first = null;
  for (const child of Array.isArray(children) ? children : []) {
    const atMs = child?.exit?.atMs;
    if (!Number.isFinite(atMs)) continue;
    if (first === null || atMs < first.exit.atMs || (atMs === first.exit.atMs && startedBefore(child, first))) {
      first = child;
    }
  }
  return first === null ? null : childReading(first);
}

/** The one line a console, a log or a reader quotes: `first_to_leave=host:code=1`, or `first_to_leave=unobserved`. */
export function firstToLeaveLine(reading) {
  return `first_to_leave=${typeof reading === "string" && reading.length > 0 ? reading : "unobserved"}`;
}

/** One child by its role, or null when this run started none with that role. */
export function childRow(record, role) {
  const children = Array.isArray(record?.children) ? record.children : [];
  return children.find((child) => child?.role === role) ?? null;
}

/**
 * Merge rows a second process measured into the rows already in the record, keyed by pid.
 *
 * The process that SPAWNED a child is the only authority for its row - its role, its start, and the survival the spawner
 * measured - so a second writer may only fill in an exit the first one never observed. Two writers that could overwrite
 * each other would let the last one to leave rewrite history.
 */
export function mergeChildren(existing, incoming) {
  const merged = [];
  for (const child of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (child === null || typeof child !== "object" || !Number.isSafeInteger(child.pid)) continue;
    const at = merged.findIndex((row) => row.pid === child.pid);
    if (at < 0) {
      merged.push(child);
      continue;
    }
    const kept = merged[at];
    const keptHasExit = Number.isFinite(kept?.exit?.atMs);
    if (!keptHasExit && Number.isFinite(child?.exit?.atMs)) {
      merged[at] = Object.freeze({ ...kept, exit: observeExit(child.exit) });
    }
  }
  return Object.freeze(merged);
}

/** The record a previous writer left at `path`, or null when nothing wrote one. */
export function readChildRecord({ path } = {}) {
  try {
    const document = JSON.parse(readFileSync(path, "utf8"));
    return document !== null && typeof document === "object" ? document : null;
  } catch {
    return null;
  }
}

/**
 * Write the record: this writer's own fields, the child rows, and the ordering DERIVED from them.
 *
 * `fields` is what this writer alone knows (the reaper's outcome, the images still alive); rows a previous writer
 * measured are passed in already merged, so the file never loses a process the run started. `childrenState` tells the
 * three zeroes apart: `none_started` (this run launched nothing), `measured`, or a `partial:` reading the caller names
 * when a child it started cannot be named at all (or when the process that spawned the other children published no
 * record). An empty roster with a `partial:` reading is NOT reported as `none_started`.
 */
export function writeChildRecord({ path, children = [], fields = {}, state = "measured" } = {}) {
  const rows = childrenRecord(children).children;
  const record = Object.freeze({
    ...fields,
    children: rows,
    firstToLeave: firstToLeave(rows),
    childrenState: rows.length === 0 && state === "measured" ? "none_started" : state,
  });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}
