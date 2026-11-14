/**
 * The run's process ledger: a scoped record of the processes THIS run created or touched, and the two
 * readings that make it worth keeping - what it left behind, and whether it ended anything it did not own.
 *
 * A process dump is not a ledger. 385 processes live on this machine and almost none of them are ours,
 * so a record of all of them says nothing about the run and buries the four rows a reader can act on.
 * Every row here earned its place through one of the run's OWNERSHIP MARKERS - a fact that is specific
 * to this run and could not name another run's process:
 *
 *   stage          the run's stage root. It appears in the browser's `--user-data-dir=<stage>/browser-profile`,
 *                  in every phase process (`node …/phases/capture.mjs <stage>/state/run.json`) and in the
 *                  command line of anything they spawn.
 *   game-smapi     the SMAPI executable inside the installation this run was configured with. Scoped to
 *   game-client    processes that did not exist when the run opened, because the game folder is shared with
 *                  the player's own game and a marker alone would claim their session.
 *   host           the pid of the Host child this run launched (`<stage>/state/launch.json` -> `childPid`).
 *   guardian-tree  everything BELOW the parent of that Host pid - the native Desktop supervisor's own tree.
 *                  Only the supervisor it launched the Host through is the server of this run's guardian
 *                  session, and the game this run asked for is one of its children, not one of ours.
 *
 * The two readings the caller asserts:
 *
 *   leftovers        entries still alive after teardown, minus the ones the caller says it kept on purpose.
 *                    A stepwise run keeps its processes (the next phase needs them) and says so here, per pid.
 *   collateral       the whole pid set before and after, as counts. The assertion is not "no unowned pid
 *                    vanished" - a machine's process table churns on its own and claiming zero would be a lie.
 *                    It is `every pid this run ended is a run-owned pid`, read against the same entry set.
 *
 * `null` and `0` stay different: a table this machine could not answer is `unverifiable`, never "none left".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { processesWithCommandLine, processTable } from "./process-table.mjs";

/** The prefix of every line this ledger prints, so the run's terminal has one handle for it. */
export const LEDGER_PREFIX = "PROCESS-LEDGER";

/**
 * The markers this run's processes answer to, with the reason each one is specific to this run.
 *
 * `createdOnly` says the marker alone is not enough: the same path can belong to the player's own game, so
 * only a process that appeared after the run opened is attributed to it. That basis is recorded on the
 * reading rather than implied, so a row that appeared mid-run and was never ours can be spotted.
 */
export function ownershipMarkers({ stageRoot, gameDir, hostPid = null, guardianPid = null }) {
  const markers = [
    {
      id: "stage",
      kind: "commandline",
      text: stageRoot,
      createdOnly: false,
      reason: "the run's own stage root: the browser profile, the phase processes and their children",
    },
  ];
  if (typeof gameDir === "string" && gameDir.length > 0) {
    markers.push({
      id: "game-smapi",
      kind: "commandline",
      text: `${gameDir}\\StardewModdingAPI.exe`,
      createdOnly: true,
      reason: "the Mod loader this run's launch started, in the installation it was configured with",
    });
    markers.push({
      id: "game-client",
      kind: "commandline",
      text: `${gameDir}\\Stardew Valley.exe`,
      createdOnly: true,
      reason: "the game process under that loader, created after this run opened",
    });
  }
  if (Number.isSafeInteger(hostPid) && hostPid > 0)
    markers.push({
      id: "host",
      kind: "pid",
      pid: hostPid,
      createdOnly: false,
      reason: "the Host child this run launched (launch.json -> childPid)",
    });
  if (Number.isSafeInteger(guardianPid) && guardianPid > 0)
    markers.push({
      id: "guardian-tree",
      kind: "descendants",
      pid: guardianPid,
      createdOnly: true,
      reason: "the native supervisor this run's Host connected through, and everything it started for us",
    });
  return markers;
}

/** The pid set and the parent relation, from one table read; `null` when this machine could not answer. */
const snapshotOf = (table) =>
  table === null ? null : { examined: table.examined, pids: new Set(table.rows.map((row) => row.pid)) };

/**
 * Open the ledger: the "before" snapshot, and the markers that will decide what counts as ours.
 *
 * `hostPid` arrives with the launch, so a caller that opens before the mount simply has no host or guardian
 * marker yet and the next collect can be told the pid it learned.
 */
export function openProcessLedger({
  stageRoot,
  gameDir = null,
  hostPid = null,
  guardianPid = null,
  readTable = processTable,
}) {
  const before = snapshotOf(readTable());
  return Object.freeze({
    stageRoot,
    gameDir,
    hostPid,
    guardianPid,
    markers: ownershipMarkers({ stageRoot, gameDir, hostPid, guardianPid }),
    before,
    openedAt: new Date().toISOString(),
  });
}

/** Descendants of `rootPid`, from the parent relation in one table read. */
function descendantsOf(table, rootPid) {
  const children = new Map();
  for (const row of table.rows) {
    if (!Number.isSafeInteger(row.parentPid)) continue;
    const list = children.get(row.parentPid);
    if (list === undefined) children.set(row.parentPid, [row.pid]);
    else list.push(row.pid);
  }
  const found = [];
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

/**
 * Collect the run-owned processes, immediately BEFORE anything is torn down - the only moment a process
 * the run is about to stop can still be recorded.
 *
 * The registry (pids the run was told about, with their roles) and the markers answer different halves: a
 * capture driver's pid is registered but names no stage path, while the browser names the stage path but was
 * never registered. The union is what this run created or touched.
 */
export function collectProcessLedger(
  ledger,
  {
    registry = [],
    hostPid = null,
    guardianPid = null,
    query = processesWithCommandLine,
    readTable = processTable,
  } = {},
) {
  const table = readTable();
  const roles = new Map(registry.map((record) => [record.pid, record.role]));
  const host = Number.isSafeInteger(hostPid) ? hostPid : ledger.hostPid;
  if (table === null) {
    return {
      entries: [],
      markers: ownershipMarkers({ stageRoot: ledger.stageRoot, gameDir: ledger.gameDir, hostPid: host, guardianPid }),
      table: null,
      evidence: "process_table_unavailable",
    };
  }
  const byPid = new Map(table.rows.map((row) => [row.pid, row]));
  const before = ledger.before?.pids ?? null;

  // The stage root is claimed first because it decides whether the Host's parent is a supervisor or ours.
  const stageMarker = ownershipMarkers({ stageRoot: ledger.stageRoot }).find((marker) => marker.id === "stage");
  const stageClaimed = new Set((query(stageMarker.text)?.rows ?? []).map((row) => row.pid));

  /*
   * The supervisor is the process that launched our Host and is NOT ours - the native Desktop supervisor,
   * which also starts the game for us. A run-owned parent must never be read as one: the gate launcher
   * (`tools/desktop-composition-launch.mjs`) spawns the Host itself, so its tree holds this run's own browser
   * and Host, and calling that tree "not this run's to end" would hide a real leftover behind a reason.
   */
  const hostRow = Number.isSafeInteger(host) ? byPid.get(host) : undefined;
  const parentRow = hostRow?.parentPid != null ? byPid.get(hostRow.parentPid) : undefined;
  const parentIsOurs = parentRow === undefined || stageClaimed.has(parentRow.pid) || roles.has(parentRow.pid);
  const guardian =
    guardianPid ?? ledger.guardianPid ?? (parentRow !== undefined && !parentIsOurs ? parentRow.pid : null);

  const markers = ownershipMarkers({
    stageRoot: ledger.stageRoot,
    gameDir: ledger.gameDir,
    hostPid: host,
    guardianPid: guardian,
  });

  /** One pid's attribution, with the marker that claimed it. First marker wins; the order above is the claim order. */
  const claimed = new Map();
  const claim = (pid, marker) => {
    if (claimed.has(pid)) return;
    if (marker.createdOnly === true && before !== null && before.has(pid)) return;
    claimed.set(pid, marker);
  };

  for (const marker of markers) {
    if (marker.kind === "commandline") {
      // The stage query already ran above; re-running it would also let two reads of the same table disagree.
      const measured = marker.id === "stage" ? { rows: [...stageClaimed].map((pid) => ({ pid })) } : query(marker.text);
      for (const row of measured?.rows ?? []) claim(row.pid, marker);
    } else if (marker.kind === "pid") {
      claim(marker.pid, marker);
    } else if (marker.kind === "descendants") {
      for (const pid of descendantsOf(table, marker.pid)) claim(pid, marker);
    }
  }

  const entries = [];
  for (const [pid, marker] of claimed) {
    const row = byPid.get(pid) ?? null;
    entries.push({
      name: row?.name ?? null,
      pid,
      startTime: row?.startTime ?? null,
      commandLineMarker: marker.id,
      // Why this row is this run's, in one phrase, so a reader can judge the claim instead of trusting it.
      markerReason: marker.reason,
      role: roles.get(pid) ?? null,
    });
  }
  // A registered pid that has already exited is still a process this run created: it is recorded with the
  // name and start time the table can no longer give it, which is the honest shape of that row.
  for (const [pid, role] of roles) {
    if (claimed.has(pid)) continue;
    const row = byPid.get(pid) ?? null;
    entries.push({
      name: row?.name ?? null,
      pid,
      startTime: row?.startTime ?? null,
      commandLineMarker: "registry",
      markerReason: "this run registered the pid when it spawned it",
      role,
    });
  }
  return Object.freeze({
    entries: entries.sort((left, right) => left.pid - right.pid),
    registered: roles.size,
    markers: Object.freeze(
      markers.map((marker) => ({ id: marker.id, kind: marker.kind, createdOnly: marker.createdOnly === true })),
    ),
    table,
    evidence: "collected",
  });
}

/**
 * Close the ledger after teardown: fill `stillAliveAfter`, split the leftovers from what the caller kept on
 * purpose, and read the collateral half from the same two snapshots.
 *
 * `endedByRun` is the caller's own list of pids it killed (the teardown's `killed`). Every one of them must be
 * an entry here; one that is not is a process this run ended without owning, which is the collateral damage
 * this reading exists to catch.
 */
export function closeProcessLedger(
  ledger,
  collected,
  { readTable = processTable, endedByRun = [], keptAlive = [] } = {},
) {
  const after = snapshotOf(readTable());
  const kept = new Map(keptAlive.map((entry) => [entry.pid, entry.reason]));
  const entryPids = new Set(collected.entries.map((entry) => entry.pid));
  const entries = collected.entries.map((entry) => {
    const stillAliveAfter = after === null ? null : after.pids.has(entry.pid);
    const reason = kept.get(entry.pid) ?? null;
    return { ...entry, stillAliveAfter, leftDeliberately: reason };
  });
  const leftovers = entries.filter((entry) => entry.stillAliveAfter === true && entry.leftDeliberately === null);
  // Only a process that is STILL THERE can be "deliberately left": a kept pid that exited on its own is gone,
  // and printing it as left behind would be a sentence about a process that does not exist.
  const deliberatelyLeft = entries.filter((entry) => entry.stillAliveAfter === true && entry.leftDeliberately !== null);
  const beforePids = ledger.before?.pids ?? null;
  const collateral =
    beforePids === null || after === null
      ? null
      : {
          before: beforePids.size,
          after: after.pids.size,
          // Both sides are counted from the SAME two reads, which is what makes the difference a fact about
          // this run's window rather than about two moments taken by different probes.
          vanished: [...beforePids].filter((pid) => !after.pids.has(pid)).length,
          vanishedOwned: [...beforePids].filter((pid) => !after.pids.has(pid) && entryPids.has(pid)).length,
          vanishedUnowned: [...beforePids].filter((pid) => !(after.pids.has(pid) || entryPids.has(pid))).length,
          endedByRun: endedByRun.length,
          // The one assertion: everything this run ended was its own.
          endedByRunUnowned: endedByRun.filter((pid) => !entryPids.has(pid)).length,
        };
  return Object.freeze({
    openedAt: ledger.openedAt,
    closedAt: new Date().toISOString(),
    markerPopulation: collected.markers,
    evidence: collected.evidence,
    /*
     * Three answers, not two, for the same reason every other reading in this kit has three. `measured` is a
     * record with something in it. `nothing_created` is an invocation that spawned nothing which outlived its
     * own work - the `check` phase is exactly that - so zero is the truth and not a gap. `unmeasured` is an
     * invocation that DID register pids the table then could not answer for: its record is empty and it says
     * nothing about leftovers, which is a reading that must not pass as one.
     */
    population: entries.length > 0 ? "measured" : (collected.registered ?? 0) > 0 ? "unmeasured" : "nothing_created",
    registered: collected.registered ?? 0,
    entries,
    examined: entries.length,
    leftovers,
    deliberatelyLeft,
    collateral,
  });
}

/** Beside the run, so the record outlives the terminal it was printed in. */
export function writeProcessLedger(paths, reading) {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.processLedgerFile, `${JSON.stringify(reading, null, 1)}\n`, "utf8");
}

/**
 * The ledger's own lines. Every one of them prints its population: `examined N run-owned, leftovers 0` is a
 * reading, `0 processes` is a sentence that agrees with itself.
 */
export function describeProcessLedger(reading) {
  const lines = [];
  const markers = reading.markerPopulation.map((marker) => `${marker.id}${marker.createdOnly ? "(created)" : ""}`);
  const population =
    reading.population === "measured"
      ? ""
      : reading.population === "nothing_created"
        ? " - this invocation created no process that outlived its work, so there is nothing to have left behind"
        : ` - UNMEASURED: ${String(reading.registered)} registered pid(s) and the table answered for none of them, so this record says nothing about leftovers`;
  lines.push(
    `${LEDGER_PREFIX}: markers=[${markers.join(",")}] examined ${String(reading.examined)} run-owned, leftovers ${String(reading.leftovers.length)}${population}`,
  );
  if (reading.leftovers.length > 0)
    lines.push(
      `${LEDGER_PREFIX}: LEFT BEHIND ${reading.leftovers.map((entry) => `${entry.pid}(${entry.name ?? "unknown"}/${entry.commandLineMarker})`).join(" ")} - this run did not clean up after itself`,
    );
  if (reading.deliberatelyLeft.length > 0)
    lines.push(
      `${LEDGER_PREFIX}: deliberately left ${reading.deliberatelyLeft.map((entry) => `${entry.pid}(${entry.leftDeliberately})`).join(" ")}`,
    );
  /*
   * A process the run created and stopped BEFORE the ledger collected it is recorded from the registry alone: its
   * pid and its role, with no name and no start time for the table to give. That is a true row, and it is also a
   * partial one, so the reading says how many of them there are instead of letting a blank column imply the machine
   * had nothing to say.
   */
  const unanswerable = reading.entries.filter((entry) => entry.startTime === null).length;
  if (unanswerable > 0)
    lines.push(
      `${LEDGER_PREFIX}: ${String(unanswerable)} of ${String(reading.examined)} entries had already exited when the ledger collected them (pid and role only - the table could not date them)`,
    );
  const collateral = reading.collateral;
  if (collateral === null) {
    lines.push(
      `${LEDGER_PREFIX}: collateral unverifiable:${reading.evidence} - this machine could not be asked for its process table, so the before/after comparison did not run`,
    );
    return lines;
  }
  lines.push(
    `${LEDGER_PREFIX}: full process table before=${String(collateral.before)} after=${String(collateral.after)}; vanished=${String(collateral.vanished)} (run-owned ${String(collateral.vanishedOwned)}, not this run's ${String(collateral.vanishedUnowned)})`,
  );
  if (collateral.endedByRunUnowned > 0)
    lines.push(
      `${LEDGER_PREFIX}: COLLATERAL - this run ended ${String(collateral.endedByRun)} pid(s) and ${String(collateral.endedByRunUnowned)} of them are not run-owned`,
    );
  else
    lines.push(
      `${LEDGER_PREFIX}: this run ended ${String(collateral.endedByRun)} pid(s), all of them run-owned; unowned-ended=${String(collateral.endedByRunUnowned)}`,
    );
  return lines;
}

/**
 * The processes this run must NOT count as leftovers, each with the reason it stays.
 *
 * Two reasons exist and they are different facts:
 *
 *   stepwise   the run was invoked as one phase of a resumable run (`launch`, `capture`, ...). The mounted
 *              session is the next phase's input, so nothing the run started is stopped - and the ledger must
 *              say so per pid rather than reporting the whole session as a leak.
 *   policy     the process is the native supervisor's, claimed through the guardian's own tree: what the
 *              supervisor started for the player (the game this run asked for) is the player's world. An
 *              ordinary close stops AI authority and never the game world (product policy), so a game still
 *              running at the end of a run is the product behaving, not the run leaking.
 *
 * A surviving `host` entry is NOT in this list on purpose: the Host is the AI authority, and stopping it on the
 * way out is what this run's teardown is for. A Host that survives it is a leftover, whatever spawned it.
 *
 * Everything else that survives teardown is a leftover and is reported as one.
 */
export function deliberatelyKept(entries, { stepwise = false } = {}) {
  if (stepwise)
    return entries.map((entry) => ({ pid: entry.pid, reason: "stepwise run leaves this process for the next phase" }));
  return entries
    .filter((entry) => entry.commandLineMarker === "guardian-tree")
    .map((entry) => ({
      pid: entry.pid,
      reason: "not this run's to end: an ordinary close stops AI authority, never the player's game",
    }));
}
