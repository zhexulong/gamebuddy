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
import { GAME_IMAGE_PATTERN, identifyRunGame } from "./run-game.mjs";

/** The refusal code a phase fails with, spelled once so the phase, the driver and the README agree. */
export const MACHINE_NOT_QUIET = "machine_not_quiet";

/** The refusal for a table that did not answer: an unasked machine is not a quiet one. */
export const MACHINE_NOT_QUIET_UNREADABLE = "machine_not_quiet_unreadable";

/** The OS's creation time as the probe renders it, or the fact that it has none. */
const startedAt = (row) =>
  typeof row.startTime === "string" && row.startTime.length > 0 ? row.startTime : "an unreported time";

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
