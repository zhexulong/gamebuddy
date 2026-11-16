// A run owns every process it starts, on both exits - the successful one and the failed one. That is the
// one place this lives: `run.mjs` opens the owner once and closes it once, and every phase that spawns
// something records the pid here, instead of each phase carrying its own try/finally.
//
// The registry exists because a phase that fails leaves its children alive, and the measured shape was
// expensive: run 1 died in capture and left `node …/phases/launch.mjs` (pid 32740) and its Edge (44088)
// holding CDP 9341, so run 2 spent a whole build and then died as `phase launch failed (exit 2)`, run 4
// died the same way on run 2's orphan, and only a human killing exact PIDs recovered the machine.
//
// Two populations, because they answer different halves. The REGISTRY is the handles this run was told
// about: the launch driver and the capture drivers, whose command lines do not necessarily name the
// stage. The SWEEP is every live process whose command line does name this run's stage root, which is
// the browser (`--user-data-dir=<stage>/browser-profile`) and anything the driver spawned. A teardown
// kills the union, by exact pid only - never by image name (#3715) - and prints what it examined.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { releaseCdpPortLockHeldBy } from "./cdp-port-lock.mjs";
import { killProcessTree, portListener, processesWithCommandLine } from "./process-table.mjs";

/** Records one pid this run started. Append-only: the launch and capture phases are separate processes. */
export function registerRunProcess(paths, { pid, role, startTime = null }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  mkdirSync(paths.stateDir, { recursive: true });
  appendFileSync(
    paths.runProcessesFile,
    `${JSON.stringify({ pid, role: String(role ?? "unrecorded"), startTime: typeof startTime === "string" ? startTime : null, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

/** Every pid this run recorded, deduplicated, `[]` when nothing was recorded or the file is unreadable. */
export function registeredRunProcesses(paths) {
  let text;
  try {
    text = readFileSync(paths.runProcessesFile, "utf8");
  } catch {
    return [];
  }
  const records = new Map();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const record = JSON.parse(line);
      if (Number.isSafeInteger(record.pid) && !records.has(record.pid)) {
        records.set(record.pid, {
          role: String(record.role ?? "unrecorded"),
          // The OS's own creation time, when the recorder could see the process: pid AND start time is the
          // identity, since a pid the machine recycles is a different process wearing the same number.
          startTime: typeof record.startTime === "string" ? record.startTime : null,
        });
      }
    } catch {
      // A torn last line is a write that did not finish, not a process: the pids above it are intact.
    }
  }
  return [...records].map(([pid, record]) => ({ pid, role: record.role, startTime: record.startTime }));
}

const isBrowser = (commandLine) => String(commandLine).includes("--user-data-dir=");

/**
 * Terminates everything this run started and releases the CDP lock it held. Runs on the successful path
 * and on the failed one; the only difference between them is the exit code the caller passes.
 *
 * `"unavailable"` from a kill, and a sweep the machine could not answer, are reported rather than
 * folded into "nothing to do" - a teardown that cannot tell those apart turns into the fault it exists
 * to prevent.
 */
export function teardownRun({ paths, run, reason }) {
  const targets = new Map();
  for (const record of registeredRunProcesses(paths)) targets.set(record.pid, record.role);
  const swept = processesWithCommandLine(paths.stageRoot);
  for (const row of swept?.rows ?? []) {
    if (!targets.has(row.pid)) targets.set(row.pid, isBrowser(row.commandLine) ? "browser" : row.name);
  }

  const killed = [];
  const alreadyGone = [];
  const failed = [];
  for (const [pid, role] of targets) {
    const outcome = killProcessTree(pid);
    if (outcome === "killed") killed.push({ pid, role });
    else if (outcome === "already_exited") alreadyGone.push({ pid, role });
    else failed.push({ pid, role });
  }

  return Object.freeze({
    reason,
    recorded: registeredRunProcesses(paths).length,
    swept: swept === null ? null : swept.examined,
    killed,
    alreadyGone,
    failed,
    lock: releaseCdpPortLockHeldBy(run.cdpPort, new Set(targets.keys())),
  });
}

/**
 * What is still alive and belongs to this run: the processes naming its stage root, who holds its CDP port,
 * and the game this run started (recorded by identity, never by image name alone). `status` is `none`,
 * `ours_remain`, `game_alive`, `port_held_by_another` or `unverifiable` - five different answers, because
 * "this run leaked", "this run left its game running" and "a sibling is using the port" are not the same
 * finding, and a game the sweep cannot see is exactly the leftover this reading kept missing.
 */
export function inspectRunLeftovers({ paths, run, game = null }) {
  const survivors = processesWithCommandLine(paths.stageRoot);
  if (survivors === null)
    return Object.freeze({
      status: "unverifiable",
      reason: "process_table_unavailable",
      survivors: [],
      cdpPort: null,
      game: game ?? null,
    });
  const listener = portListener(run.cdpPort);
  const cdpPort =
    listener.status === "listening"
      ? {
          state: "listening",
          pid: listener.pid,
          ours: survivors.rows.some((row) => row.pid === listener.pid),
        }
      : { state: listener.status };
  const gameSurvived = game !== null && game.surviving.kind === "alive";
  const status = gameSurvived
    ? "game_alive"
    : survivors.rows.length > 0
      ? "ours_remain"
      : cdpPort.state === "listening"
        ? "port_held_by_another"
        : "none";
  return Object.freeze({
    status,
    examined: survivors.examined,
    survivors: survivors.rows,
    cdpPort,
    game: game ?? null,
  });
}

const listing = (entries) => entries.map((entry) => `${entry.pid}(${entry.role})`).join(" ");

/** The teardown's own line: what was killed, what was already gone, what could not be killed, and the sweep. */
export function describeTeardown(teardown) {
  const swept = teardown.swept === null ? "unavailable" : `${teardown.swept} examined`;
  const parts = [
    `RUN-CLEANUP(${teardown.reason})`,
    `recorded=${teardown.recorded}`,
    `sweep=${swept}`,
    `killed=${teardown.killed.length}${teardown.killed.length === 0 ? "" : ` [${listing(teardown.killed)}]`}`,
    `already-gone=${teardown.alreadyGone.length}`,
    `could-not-kill=${teardown.failed.length}${teardown.failed.length === 0 ? "" : ` [${listing(teardown.failed)}]`}`,
    `cdp-lock=${teardown.lock}`,
  ];
  return parts.join(" ");
}

/** The post-run assertion's line. It prints its population, and it never reads an unread table as "none". */
export function describeLeftovers(leftovers, run) {
  if (leftovers.status === "unverifiable")
    return `LEFTOVERS: unverifiable:${leftovers.reason} - this machine cannot be asked which processes remain, so the post-run assertion did not run`;
  const measured = `examined ${leftovers.examined} processes; cdp port ${run.cdpPort} ${leftovers.cdpPort.state}`;
  if (leftovers.status === "none") return `LEFTOVERS: none (${measured})`;
  if (leftovers.status === "game_alive") {
    const game = leftovers.game.surviving.surviving.map((entry) => `${entry.pid}(${entry.role})`).join(" ");
    return `LEFTOVERS: this run's game is still alive after cleanup: ${game} (${measured}) - this run started a game and did not take it back`;
  }
  if (leftovers.status === "port_held_by_another")
    return `LEFTOVERS: none of this run's; cdp port ${run.cdpPort} is held by pid ${leftovers.cdpPort.pid} (another run, which the next run refuses by name)`;
  const survivors = leftovers.survivors
    .map((row) => `${row.pid}(${isBrowser(row.commandLine) ? "browser" : row.name})`)
    .join(" ");
  return `LEFTOVERS: ${leftovers.survivors.length} of this run's processes are still alive after cleanup: ${survivors} (${measured}) - this run did not clean up after itself`;
}

/** Writes the assertion's reading beside the run, so the fact outlives the terminal. */
export function writeLeftoversReading(paths, leftovers) {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.leftoversFile, `${JSON.stringify(leftovers, null, 1)}\n`, "utf8");
}
