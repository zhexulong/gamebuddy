// The OS's process table, as a query surface for the kit's two "who is this?" questions: the holder of
// a contended CDP port, and the survivors of a phase that failed. Both must be answered by the OS -
// the kit's own bookkeeping only ever knows the processes it managed to record - and both must be
// answered by PID and command line, never by image name (`taskkill /IM node.exe` kills every Node on
// the machine, including other lanes' runs).
//
// `null` and `[]` are different answers and stay different: `null` means this machine could not be
// asked (no probe, no `Get-CimInstance`), `[]` means it was asked and nothing matched. A caller that
// folds them together reports "no leftovers" for a machine that never answered.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { KIT_ROOT } from "./config.mjs";

const PROBE_TIMEOUT_MS = 60_000;
const PROBE_SCRIPT = join(KIT_ROOT, "probes", "process-table.ps1");

function runProbe(args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PROBE_SCRIPT, ...args],
    { encoding: "utf8", windowsHide: true, timeout: PROBE_TIMEOUT_MS },
  );
  if (result.error !== undefined || result.status !== 0) return null;
  const rows = [];
  let examined = null;
  for (const line of String(result.stdout ?? "").split("\n")) {
    const text = line.trim();
    if (text.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (parsed?.examined !== undefined) examined = parsed.examined;
    else rows.push(parsed);
  }
  return { rows, examined };
}

const answered = (args) => (process.platform === "win32" ? runProbe(args) : null);

/** One row's fields, without the probe's own envelope: `startTime` and `parentPid` travel on every row. */
const shape = (row) => ({
  pid: row.pid,
  parentPid: Number.isSafeInteger(row.parentPid) ? row.parentPid : null,
  name: String(row.name ?? ""),
  startTime: typeof row.startTime === "string" ? row.startTime : null,
  commandLine: String(row.commandLine ?? ""),
});

/**
 * The whole process table, without any command line: `{ examined, rows: [{ pid, parentPid, name, startTime }] }`,
 * or `null` when this machine could not be asked.
 *
 * Two questions need exactly this and neither needs a command line: whether a pid that existed before a run
 * still exists after it (the ledger's collateral reading), and which processes descend from one role (the
 * guardian's own tree, resolved from `parentPid` rather than from a list of image names).
 */
export function processTable() {
  const measured = answered(["-Table"]);
  if (measured === null) return null;
  if (!Number.isSafeInteger(measured.examined) || measured.examined <= 0) return null;
  return {
    examined: measured.examined,
    rows: measured.rows.map((row) => ({
      pid: row.pid,
      parentPid: Number.isSafeInteger(row.parentPid) ? row.parentPid : null,
      name: String(row.name ?? ""),
      startTime: typeof row.startTime === "string" ? row.startTime : null,
    })),
  };
}

/** One process row `{ pid, parentPid, name, startTime, commandLine }`, or `null` when it is gone / the machine cannot answer. */
export function processRow(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const measured = answered(["-ProcessId", String(pid)]);
  const row = measured?.rows.find((entry) => entry.pid === pid);
  return row === undefined ? null : shape(row);
}

/**
 * Every process whose command line CONTAINS `text`, as `{ rows, examined }` - `examined` being how many
 * processes the query looked at, so a reading prints its population instead of an unqualified zero.
 *
 * `null` means the machine could not be asked, and a whole-table query that examined nothing is `null`
 * too: an empty answer is a probe that broke, not a machine running no processes.
 *
 * The command line is the only fact that ties a process to a run directory: the launch driver is
 * `node …/phases/launch.mjs <stage>/state/run.json` and the browser is `msedge … --user-data-dir=<stage>/browser-profile`,
 * so one substring finds both without a list of image names.
 */
export function processesWithCommandLine(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const measured = answered(["-CommandLineLike", text]);
  if (measured === null) return null;
  if (!Number.isSafeInteger(measured.examined) || measured.examined <= 0) return null;
  return {
    examined: measured.examined,
    rows: measured.rows
      .map(shape)
      // The query names the text in ITS OWN command line, so the probe matches itself; the caller is
      // looking for the processes that REFER to the text, and a self-match would be reported as a
      // leftover on every run.
      .filter((row) => row.pid !== process.pid && !row.commandLine.includes(PROBE_SCRIPT)),
  };
}

/** Who holds a TCP port: `{ status: "listening", pid }`, `{ status: "free" }`, or `{ status: "unavailable" }`. */
export function portListener(port) {
  if (!Number.isSafeInteger(port) || port <= 0) return { status: "unavailable" };
  const measured = answered(["-ListenerPort", String(port)]);
  if (measured === null) return { status: "unavailable" };
  const pid = measured.rows[0]?.pid;
  return Number.isSafeInteger(pid) ? { status: "listening", pid } : { status: "free" };
}

/** Terminates one process and its own children, by exact pid. Returns `"killed" | "already_exited" | "unavailable"`. */
export function killProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return "unavailable";
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
      return "killed";
    } catch (error) {
      return error?.code === "ESRCH" ? "already_exited" : "unavailable";
    }
  }
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  if (result.error !== undefined) return "unavailable";
  // A non-English Windows spells "no such process" in its own words, so the classification is the exit
  // status: 128 is `taskkill`'s answer for a pid that is already gone, which is not a failure.
  if (result.status === 0) return "killed";
  return result.status === 128 ? "already_exited" : "unavailable";
}
