/*
 * The machine this kit is allowed to launch a game on, and the refusal when it is not that machine.
 *
 * What these assertions protect: `ROUND33` launched a game on a machine that already had two
 * (`run-stardew-multiplayer-live-loop.mjs`, 22 s and 11 s older), the launch chain's "a game process exists"
 * rung counted three pids, its "save loaded" rung quoted THAT lane's world, and the run ended red with
 * `cabin_handoff_no_cabin:state_unavailable` - a product-shaped red that was really a contaminated measurement
 * (`.tmp/lane-round33c.md` §6, §8.6). Nothing in the kit said the machine was not this run's.
 *
 * What the refusal must say, and why each half is load-bearing: the CODE (`machine_not_quiet`) makes it a
 * refusal a phase fails with rather than a note; the PID is the process a human can look at; the IMAGE NAME
 * says which half of the game it is; the START TIME is what makes the pid an identity (Windows hands a dead
 * process's number to the next one); and `(not this run)` is the claim that this run did not cause it.
 *
 * The process table is a boundary this kit does not own, so it is injected here - the rule under test is
 * "what counts as contamination and how is it named", never "can PowerShell list processes".
 *
 * red-proof: inject  `machineQuietReading` returning `quiet` whenever `foreign.length === 0` (i.e. treating
 *                   this run's own live game as a quiet machine): `✖ a game this run started is named as this
 *                   run's own and still refuses` fails on `state`, exit 1 (measured 2026-11-26).
 * red-proof: inject  the start time dropped from the refusal line (`started ${row.name}`): `✖ another lane's
 *                   game refuses by name, pid, image and OS start time` fails on the exact line, exit 1.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MACHINE_NOT_QUIET,
  MACHINE_NOT_QUIET_UNREADABLE,
  describeQuietRefusal,
  machineQuietReading,
} from "./machine-quiet.mjs";

const STAGE = "D:\\gb-runs\\round33c-out2.stage";

/** One process row as `lib/process-table.mjs::processesWithImageName` shapes it. */
const row = (pid, parentPid, name, commandLine = "", startTime = "2026-11-26T03:29:09.1234567+08:00") => ({
  pid,
  parentPid,
  name,
  startTime,
  commandLine,
});

/** A process table that answers with exactly these rows and this population. */
const table =
  (rows, examined = 400) =>
  () => ({ examined, rows });

test("a machine with no game on it passes, and prints the population it examined", () => {
  const reading = machineQuietReading({ stageRoot: STAGE, readGame: table([]) });
  assert.equal(reading.state, "quiet");
  assert.equal(reading.examined, 400);
  assert.deepEqual(reading.own, []);
  assert.deepEqual(reading.foreign, []);
  assert.match(
    reading.lines[0],
    /^machine_quiet: examined 400 processes by image name \^Stardew; no (Stardew Valley and no StardewModdingAPI) process is running$/u,
  );
  assert.equal(describeQuietRefusal(reading), reading.lines.join(" | "));
});

test("another lane's game refuses by name, pid, image and OS start time", () => {
  // The two pids ROUND33 counted into its own rung, exactly as the OS listed them.
  const reading = machineQuietReading({
    stageRoot: STAGE,
    readGame: table([
      row(
        10612,
        39524,
        "StardewModdingAPI.exe",
        `"D:\\Steam\\steamapps\\common\\Stardew Valley\\StardewModdingAPI.exe" --mods-path "E:\\projects\\ai-game-companion\\.tmp\\multiplayer-loop-0c58ace1\\probe\\host"`,
      ),
      row(
        33696,
        39524,
        "StardewModdingAPI.exe",
        `"D:\\Steam\\steamapps\\common\\Stardew Valley\\StardewModdingAPI.exe" --mods-path "E:\\projects\\ai-game-companion\\.tmp\\multiplayer-loop-0c58ace1\\probe\\ai"`,
        "2026-11-26T03:29:20.1234567+08:00",
      ),
    ]),
  });
  assert.equal(reading.state, "contaminated");
  assert.equal(reading.foreign.length, 2);
  assert.equal(reading.own.length, 0);
  assert.equal(
    reading.lines[0],
    `${MACHINE_NOT_QUIET}: 10612 StardewModdingAPI.exe started 2026-11-26T03:29:09.1234567+08:00 (not this run)`,
  );
  assert.equal(
    reading.lines[1],
    `${MACHINE_NOT_QUIET}: 33696 StardewModdingAPI.exe started 2026-11-26T03:29:20.1234567+08:00 (not this run)`,
  );
  // The summary is not decoration: it is where a reader learns the population the refusal was drawn from.
  assert.match(
    reading.lines[2],
    /^machine_not_quiet: 2 Stardew process\(es\) on this machine before any launch - 0 this run's own, 2 not this run's \(examined 400 processes by image name \^Stardew\)$/u,
  );
  assert.match(describeQuietRefusal(reading), /\(not this run\) \| machine_not_quiet: 2 Stardew process/u);
});

test("a game this run started is named as this run's own and still refuses", () => {
  /*
   * A launch phase that finds a game already running from ITS OWN stage is not a quiet machine either - the
   * machine cannot host a second world (`%APPDATA%\StardewValley` holds one save folder, SMAPI one log) - so
   * the verdict is the same refusal with a different, and true, parenthetical.
   */
  const reading = machineQuietReading({
    stageRoot: STAGE,
    readGame: table([
      row(
        46040,
        1,
        "StardewModdingAPI.exe",
        `"D:\\Steam\\steamapps\\common\\Stardew Valley\\StardewModdingAPI.exe" --mods-path "${STAGE}\\root\\GameBuddy\\data\\stardew-private-bootstrap\\131eb164-0000\\player-host\\Mods"`,
      ),
      // The client under that loader carries no arguments of its own; it is own through its parent.
      row(46100, 46040, "Stardew Valley.exe", "", "2026-11-26T03:29:45.1234567+08:00"),
    ]),
  });
  assert.equal(reading.state, "contaminated");
  assert.equal(reading.own.length, 2);
  assert.equal(reading.foreign.length, 0);
  assert.equal(
    reading.lines[0],
    `${MACHINE_NOT_QUIET}: 46040 StardewModdingAPI.exe started 2026-11-26T03:29:09.1234567+08:00 (this run's own: its command line names ${STAGE})`,
  );
  assert.equal(
    reading.lines[1],
    `${MACHINE_NOT_QUIET}: 46100 Stardew Valley.exe started 2026-11-26T03:29:45.1234567+08:00 (this run's own: its command line names ${STAGE})`,
  );
});

test("an unasked machine is not a quiet machine", () => {
  const reading = machineQuietReading({ stageRoot: STAGE, readGame: () => null });
  assert.equal(reading.state, "unreadable");
  assert.equal(reading.examined, null);
  assert.match(reading.lines[0], new RegExp(`^${MACHINE_NOT_QUIET_UNREADABLE}: the process table did not answer`, "u"));
  assert.match(reading.lines[0], /a probe that examined nothing is not a quiet machine/u);
});

test("a stage root nobody can name is a refusal, not an assumption", () => {
  const reading = machineQuietReading({ stageRoot: null, readGame: table([]) });
  assert.equal(reading.state, "unreadable");
  assert.match(reading.lines[0], new RegExp(`^${MACHINE_NOT_QUIET_UNREADABLE}: no stage root was given`, "u"));
});
