// The game this run started is a process this run CAUSED, and a run takes back what it caused.
//
// Measured 2026-11-16: a frontend live run launched a real Stardew Valley, the run ended, and the game was
// still on screen while the run's own reading said `LEFTOVERS: none`. The sweep asks one question - "whose
// command line names this run's stage root?" - and the game client cannot answer it: `Stardew Valley.exe`
// is launched with no arguments at all. The product deliberately keeps a player's world alive when the
// Host or its guardian dies (`host/native/windows-bootstrap-guardian/Program.cs` creates the player Job with
// `killOnJobClose: false`, product rule #3023). That is right for a player and wrong for a harness, which
// must not leave a machine holding a game it opened.
//
// So the identity is named, recorded, and asserted:
//
//   game-smapi   the Mod loader, matched by THIS RUN's own mods root in its command line. The Host launches
//                it as `StardewModdingAPI.exe --mods-path <stage>/root/.../player-host/Mods`, so the path is
//                a fact only this run can produce and a player's own game never carries it.
//   game-client  the game under that loader, matched by the parent relation: it is the loader's child and
//                carries no path of its own. A recorded loader pid keeps working after the loader itself has
//                exited, because Windows preserves the parent pid it was born with.
//
// Neither half is matched by image name alone, and nothing here is ever killed: this module only names what
// the run caused, and `teardownRun` ends it by exact pid (#3715).
import { resolve } from "node:path";
import { processesWithImageName, processTable } from "./process-table.mjs";
import { registeredRunProcesses, registerRunProcess } from "./run-owner.mjs";

/** The image-name filter the probe is asked for: SMAPI and the game, and nothing else on this machine. */
export const GAME_IMAGE_PATTERN = "^Stardew";

/** The two roles a run records for its own game, so the registry says which half each pid is. */
export const GAME_LOADER_ROLE = "game-smapi";
export const GAME_CLIENT_ROLE = "game-client";

const LOADER_IMAGE = /^StardewModdingAPI\.exe$/iu;
const CLIENT_IMAGE = /^Stardew ?Valley\.exe$/iu;

const isGameRole = (role) => role === GAME_LOADER_ROLE || role === GAME_CLIENT_ROLE;

/**
 * The game processes THIS run caused, from one query for the game's own images.
 *
 * `null` means this machine could not be asked; `{ examined, rows: [] }` means it was asked and this run's
 * game is not running - two answers that must never be folded into one ("nothing was left" for a table that
 * never answered is the fault this whole reading exists to catch).
 *
 * `stageRoot` is resolved before it is compared because the run records the stage as the operator spelled
 * it (`--out .live-runs/x` gives a relative stage), while a command line always carries the absolute one.
 */
export function identifyRunGame({
  stageRoot,
  recorded = [],
  readGame = () => processesWithImageName(GAME_IMAGE_PATTERN),
} = {}) {
  if (typeof stageRoot !== "string" || stageRoot.length === 0) return null;
  const measured = readGame();
  if (measured === null) return null;
  const root = resolve(stageRoot).toLowerCase();
  const loaders = new Set(recorded.filter((record) => record.role === GAME_LOADER_ROLE).map((record) => record.pid));
  for (const row of measured.rows)
    if (LOADER_IMAGE.test(row.name) && row.commandLine.toLowerCase().includes(root)) loaders.add(row.pid);

  const rows = measured.rows
    .filter((row) => loaders.has(row.pid) || (CLIENT_IMAGE.test(row.name) && loaders.has(row.parentPid)))
    .map((row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      name: row.name,
      startTime: row.startTime,
      role: loaders.has(row.pid) ? GAME_LOADER_ROLE : GAME_CLIENT_ROLE,
    }));
  return Object.freeze({ examined: measured.examined, rows });
}

/**
 * Names this run's game in its own registry (`<stage>/state/run-processes.jsonl`), so the identity outlives
 * the process that first saw it and the teardown reads it from the run rather than from a guess.
 *
 * Called at every capture boundary and once more before the teardown: the game appears somewhere inside a
 * driver, and one query per driver costs one process-table read - no polling loop over the session.
 */
export function recordRunGame({ paths, stageRoot, readGame } = {}) {
  const recorded = registeredRunProcesses(paths);
  const reading = identifyRunGame({ stageRoot, recorded, readGame });
  if (reading === null) return Object.freeze({ kind: "unverifiable", examined: null, rows: [], added: [] });
  const known = new Set(recorded.map((record) => record.pid));
  const added = reading.rows.filter((row) => !known.has(row.pid));
  for (const row of added) registerRunProcess(paths, { pid: row.pid, role: row.role, startTime: row.startTime });
  return Object.freeze({ kind: "measured", examined: reading.examined, rows: reading.rows, added });
}

/** The game identities this run recorded, `[]` when it recorded none. */
export function recordedGameProcesses(paths) {
  return registeredRunProcesses(paths)
    .filter((record) => isGameRole(record.role))
    .map((record) => ({ pid: record.pid, role: record.role, startTime: record.startTime }));
}

/**
 * Whether each recorded identity is still alive, reading the table until they are gone or the bound is spent.
 *
 * Identity is pid AND start time: a pid the OS handed to an unrelated process after the run is not the game
 * the run started, and reporting it as a survivor would be a sentence about the wrong process. `unverifiable`
 * is its own answer for the same reason `null` is not `[]` in the probe.
 */
export function survivingGameIdentities(identities, { readTable = processTable, attempts = 8 } = {}) {
  if (identities.length === 0) return Object.freeze({ kind: "nothing_recorded", surviving: [] });
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const table = readTable();
    if (table === null) return Object.freeze({ kind: "unverifiable", surviving: [] });
    const surviving = identities.filter((identity) =>
      table.rows.some(
        (row) => row.pid === identity.pid && (identity.startTime === null || row.startTime === identity.startTime),
      ),
    );
    if (surviving.length === 0) return Object.freeze({ kind: "gone", surviving: [] });
    if (attempt === attempts) return Object.freeze({ kind: "alive", surviving });
  }
  /* istanbul ignore next - the loop returns on its last attempt; this keeps the type total. */
  return Object.freeze({ kind: "unverifiable", surviving: [] });
}

const listed = (entries) => entries.map((entry) => `${entry.pid}(${entry.role ?? entry.name})`).join(" ");

/**
 * The game's own cleanup line. Three answers, because "this run started no game", "this run's game is still
 * on screen" and "this machine cannot say" are three different facts about a run.
 */
export function describeGameCleanup({ recorded, surviving, examined = null }) {
  if (surviving.kind === "unverifiable")
    return [
      "RUN-GAME-CLEANUP: unverifiable - the process table did not answer, so this run cannot say whether the game it started is gone",
    ];
  if (surviving.kind === "alive")
    return [
      `RUN-GAME-CLEANUP: game_still_alive: ${listed(surviving.surviving)} (could not terminate) - this run started a game and did not take it back`,
    ];
  if (recorded.length === 0)
    return [
      `RUN-GAME-CLEANUP: no game this run started${
        examined === null
          ? " (the process table was not read for one)"
          : ` (examined ${String(examined)} processes by image name)`
      }`,
    ];
  return [`RUN-GAME-CLEANUP: game_terminated_by_run: ${listed(recorded)}`];
}
