// IS THIS MACHINE QUIET ENOUGH TO LAUNCH A GAME ON, asked by name and refused by name.
//
// WHY THIS EXISTS. `ROUND33` launched a game on a machine that already had two: another lane's
// `run-stardew-multiplayer-live-loop.mjs` came up 22 s earlier, and the launch-chain driver then read
// three `StardewModdingAPI` processes into its "a game process exists" rung, read ANOTHER GAME'S
// `SMAPI-latest.txt` as its own game's log (quoting that lane's save name), and finally failed
// `cabin_handoff_no_cabin:state_unavailable` - a red that looked exactly like a product defect
// (`.tmp/lane-round33c.md` §6, §8.6). Nothing in the kit said "the machine was not yours".
//
// WHY IT IS A REFUSAL AND NOT A WARNING. A warning-shaped fact is what produced that red: the rung
// printed the three pids, and a reader took them for the run's own. A launch whose inputs are another
// game's is not a measurement, so the phase stops before it spends anything - before the CDP port is
// claimed, before the Host is spawned, before a driver presses the product's own launch control.
//
// WHAT IT MATCHES ON, exactly: the OS's process table, filtered by IMAGE NAME (`^Stardew`, the filter
// `lib/run-game.mjs` already uses for this machine's game images), reporting each process's pid, image
// name and OS creation time. A pid alone is not an identity (Windows hands a dead process's number to
// the next one), so the start time travels with every refusal. Ownership is not guessed from the name:
// a row is "this run's own" only when its command line names this run's stage root - the `--mods-path`
// the Host passes to SMAPI - which is the same marker `lib/run-game.mjs` claims a run's game by. The
// game CLIENT under that loader carries no arguments at all, so it is own when its parent is.
//
// WHAT IT CANNOT SEE. A game whose image is not named `Stardew*` and a game started by another user
// account are outside the population; the refusal line prints how many processes it examined, so a
// zero is "asked and found none", never "did not look".
import { processesWithImageName } from "./process-table.mjs";
import { GAME_IMAGE_PATTERN, identifyRunGame, runOwnership } from "./run-game.mjs";

/** The refusal code a phase fails with, spelled once so the phase, the driver and the README agree. */
export const MACHINE_NOT_QUIET = "machine_not_quiet";

/** The refusal for a table that did not answer: an unasked machine is not a quiet one. */
export const MACHINE_NOT_QUIET_UNREADABLE = "machine_not_quiet_unreadable";

/** The code a poller's own reading carries: not a refusal, a reading of who else is on this machine. */
export const MACHINE_POLL = "machine_poll";
export const MACHINE_POLL_UNREADABLE = "machine_poll_unreadable";

/** The OS's creation time as the probe renders it, or the fact that it has none. */
const startedAt = (row) =>
  typeof row.startTime === "string" && row.startTime.length > 0 ? row.startTime : "an unreported time";

/** The gate's own image filter over the rows it returned, derived from the probe's pattern rather than re-spelled. */
const GAME_IMAGE = new RegExp(GAME_IMAGE_PATTERN, "iu");

/**
 * Every game process on this machine, split into this run's own and everybody else's.
 *
 * `readGame` is injected so the rule can be held against a fixture table without a live game (the
 * process table is a boundary this kit does not own); it has the shape of
 * `lib/process-table.mjs::processesWithImageName`, which is what the callers get by default.
 */
export function machineQuietReading({ stageRoot, readGame = () => processesWithImageName(GAME_IMAGE_PATTERN) } = {}) {
  if (typeof stageRoot !== "string" || stageRoot.length === 0)
    return {
      state: "unreadable",
      examined: null,
      own: [],
      foreign: [],
      lines: [
        `${MACHINE_NOT_QUIET_UNREADABLE}: no stage root was given, so no Stardew process can be told from this run's own - and a machine whose game processes cannot be attributed is not a quiet one`,
      ],
    };
  const identified = identifyRunGame({ stageRoot, readGame });
  if (identified === null)
    return {
      state: "unreadable",
      examined: null,
      own: [],
      foreign: [],
      lines: [
        `${MACHINE_NOT_QUIET_UNREADABLE}: the process table did not answer (a probe that examined nothing is not a quiet machine), so nothing shows that no other game is running on this machine before a launch`,
      ],
    };

  const { examined, rows: own, unclaimed: foreign } = identified;
  if (own.length === 0 && foreign.length === 0)
    return {
      state: "quiet",
      examined,
      own,
      foreign,
      lines: [
        `machine_quiet: examined ${String(examined)} processes by image name ${GAME_IMAGE_PATTERN}; no Stardew Valley and no StardewModdingAPI process is running`,
      ],
    };

  const lines = [
    ...foreign.map(
      (row) => `${MACHINE_NOT_QUIET}: ${String(row.pid)} ${row.name} started ${startedAt(row)} (not this run)`,
    ),
    ...own.map(
      (row) =>
        `${MACHINE_NOT_QUIET}: ${String(row.pid)} ${row.name} started ${startedAt(row)} (this run's own: its command line names ${stageRoot})`,
    ),
    `${MACHINE_NOT_QUIET}: ${String(own.length + foreign.length)} Stardew process(es) on this machine before any launch - ${String(own.length)} this run's own, ${String(foreign.length)} not this run's (examined ${String(examined)} processes by image name ${GAME_IMAGE_PATTERN})`,
  ];
  return { state: "contaminated", examined, own, foreign, lines };
}

/** The reading as the one sentence a state file or a phase-failure line carries. */
export function describeQuietRefusal(reading) {
  return reading.lines.join(" | ");
}

/**
 * The images a POLLER must look at: the game's, and the three shells a sibling lane's kit runs under.
 *
 * The quiet gate above examines `^Stardew` only, and that is right for a gate: it refuses a launch when ANOTHER
 * GAME is running, and a kit process is not a game. A poller - the instrument that watches for a window to run in
 * - has a wider question, and the underspecified answer is what went wrong on 2026-11-26: ROUNDW's poller matched
 * `node|pwsh|powershell` against driver names, decided ownership by its own substring test, and reported this
 * run's OWN capture driver as a foreign process in the middle of the run it was measuring
 * (`.tmp/lane-roundw.md` §5.3 and §6).
 */
export const POLL_IMAGE_PATTERN = "^(Stardew|node|pwsh|powershell)";

/**
 * What a competing RUN looks like in a command line: an entry point this repository ships for a live run.
 *
 * A `node.exe` that names none of these is not a second run - an editor's language server, a package install, an
 * agent runner complete for none of the things a live run needs (the CDP port, the Host port, `SMAPI-latest.txt`,
 * the save folder). Naming the population is the poller's job; the rule that a row in it is somebody's else's run
 * is the ownership rule, not this pattern.
 */
export const POLL_DRIVER_COMMAND =
  /run-stardew|live-run[/\\]|launch-ladder|multiplayer-live-loop|shared-world-action/iu;

/**
 * Who else is on this machine, over the population a poller needs - and by the SAME ownership rule the gate uses.
 *
 * `runOwnership` (`lib/run-game.mjs`) is the rule: a process is this run's own when its command line names this
 * run's stage root, or its parent's does. That second half is what the poller could not do for itself: the kit
 * spawns a capture driver as `node <kit>/capture/w-game-launch.cjs`, so the driver's own command line carries the
 * KIT and not the run's stage, while the phase that spawned it carries `<stage>/state/run.json`. A driver claimed
 * through its parent is this run's driver, and a poller that cannot say so sees its own run as a second lane.
 *
 * Two foreign populations, because they answer different questions: another lane's GAME is what the gate refuses
 * a launch beside (one `SMAPI-latest.txt`, one save folder, one install), and another lane's DRIVER is a run that
 * is about to start one and will be competing for the same machine-wide resources. A process that is neither is
 * counted and not named: it is not part of this question.
 *
 * `readRows` is injected for the same reason the gate's `readGame` is: the process table is a boundary this kit
 * does not own, and the rule under test is "whose is this row", never "can PowerShell list processes".
 */
export function machinePollReading({ stageRoot, readRows = () => processesWithImageName(POLL_IMAGE_PATTERN) } = {}) {
  const unreadable = (reason) => ({
    state: "unreadable",
    examined: null,
    own: [],
    foreignGames: [],
    foreignDrivers: [],
    lines: [`${MACHINE_POLL_UNREADABLE}: ${reason}`],
  });
  if (typeof stageRoot !== "string" || stageRoot.length === 0)
    return unreadable(
      "no stage root was given, so no process on this machine can be told from this run's own - and a machine whose drivers cannot be attributed is not a quiet one",
    );
  const measured = readRows();
  if (measured === null)
    return unreadable("the process table did not answer, and a probe that examined nothing is not a quiet machine");

  const ownership = runOwnership({ stageRoot, rows: measured.rows });
  const own = [];
  const foreignGames = [];
  const foreignDrivers = [];
  const lines = [];
  let other = 0;
  for (const row of measured.rows) {
    const reason = ownership.reasonFor(row);
    if (reason !== null) {
      own.push(row.pid);
      lines.push(`${MACHINE_POLL}: ${String(row.pid)} ${row.name} is this run's own - ${reason}`);
      continue;
    }
    const when = startedAt(row) === "an unreported time" ? "" : ` (started ${startedAt(row)})`;
    if (GAME_IMAGE.test(row.name)) {
      foreignGames.push(row.pid);
      lines.push(`${MACHINE_POLL}: ${String(row.pid)} ${row.name} is a game that is not this run's${when}`);
      continue;
    }
    if (POLL_DRIVER_COMMAND.test(row.commandLine)) {
      foreignDrivers.push(row.pid);
      lines.push(`${MACHINE_POLL}: ${String(row.pid)} ${row.name} is a run that is not this run's${when}`);
      continue;
    }
    // Neither a game nor a live run: an editor's language server is not a competing measurement.
    other += 1;
  }
  const state = foreignGames.length + foreignDrivers.length === 0 ? "quiet" : "busy";
  lines.push(
    `${MACHINE_POLL}: examined ${String(measured.examined)} process(es) by image name ${POLL_IMAGE_PATTERN}; state=${state} - ${String(own.length)} this run's own, ${String(foreignGames.length)} game(s) not this run's, ${String(foreignDrivers.length)} run(s) not this run's, ${String(other)} neither`,
  );
  return { state, examined: measured.examined, own, foreignGames, foreignDrivers, other, lines };
}
