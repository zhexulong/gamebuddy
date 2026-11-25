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
  machinePollReading,
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

/*
 * ---- the poller's rule: the same ownership test the gate uses, over the population a poller needs ----
 *
 * ROUNDW's poller carried its own copy of "is this process this run's?" (`CommandLine -match
 * 'roundw-out|roundw-chain|roundw-quiet'`) and, in the middle of the run it was measuring, listed this run's own
 * capture driver as foreign - `drivers[own:38192 own:23736 own:40124 12408(node.exe)]`, while the run's own
 * ledger named 12408 `capture:w-game-launch` (`.tmp/lane-roundw.md` §5.3). The rows below are that run's shapes:
 * the stage root is `D:\gb-runs\roundw-out.stage`, the driver's own command line names only the kit, and the
 * phase that spawned it names the stage.
 */
const POLL_STAGE = "D:\\gb-runs\\roundw-out.stage";
const poll = (rows, examined = 364) => machinePollReading({ stageRoot: POLL_STAGE, readRows: table(rows, examined) });

/** This run's capture phase: spawned as `node <kit>/phases/capture.mjs <stage>/state/run.json`. */
const capturePhaseRow = (pid = 40124) =>
  row(
    pid,
    23736,
    "node.exe",
    `"C:\\Program Files\\nodejs\\node.exe" "D:\\gb-runs\\roundw\\tools\\live-run\\frontend\\phases\\capture.mjs" "${POLL_STAGE}\\state\\run.json" --driver=w-game-launch --force`,
  );

/** This run's capture driver: a relative script path, so its command line carries the kit and no stage root. */
const captureDriverRow = (pid, parentPid = 40124) =>
  row(
    pid,
    parentPid,
    "node.exe",
    `"C:\\Program Files\\nodejs\\node.exe" "D:\\gb-runs\\roundw\\tools\\live-run\\frontend\\capture\\w-game-launch.cjs" 4173 9341`,
    "2026-11-26T05:01:41.1234567+08:00",
  );

test("this run's own capture driver is own through its parent, which is what a command-line-only test misses", () => {
  const reading = poll([capturePhaseRow(), captureDriverRow(12408), captureDriverRow(42876)]);
  assert.equal(reading.state, "quiet", "nothing on this machine is anybody else's");
  assert.deepEqual(reading.own, [40124, 12408, 42876]);
  assert.deepEqual(reading.foreignDrivers, []);
  // The driver's own line names the kit, and the reason says which row actually claimed it.
  assert.match(
    reading.lines[1],
    /^machine_poll: 12408 node\.exe is this run's own - its parent \(pid 40124\) names D:\\gb-runs\\roundw-out\.stage$/u,
  );
  assert.match(reading.lines[0], /is this run's own - its command line names D:\\gb-runs\\roundw-out\.stage$/u);
  assert.match(
    reading.lines.at(-1),
    /^machine_poll: examined 364 process\(es\) by image name \^\(Stardew\|node\|pwsh\|powershell\); state=quiet - 3 this run's own, 0 game\(s\) not this run's, 0 run\(s\) not this run's, 0 neither$/u,
  );
});

test("a sibling lane's game and a sibling lane's driver are two different other people", () => {
  // A sibling's capture phase: its own `--out`, which is not this run's stage root and is not inside it.
  const sibling = row(
    23736,
    1,
    "node.exe",
    `"C:\\Program Files\\nodejs\\node.exe" "E:\\projects\\ai-game-companion\\tools\\live-run\\frontend\\phases\\capture.mjs" "E:\\projects\\ai-game-companion\\.live-runs\\other.stage\\state\\run.json"`,
  );
  // A sibling's game: SMAPI with ITS mods path, and the client under it carrying no arguments at all.
  const loader = row(
    43032,
    40940,
    "StardewModdingAPI.exe",
    `"D:\\Steam\\steamapps\\common\\Stardew Valley\\StardewModdingAPI.exe" --mods-path "E:\\projects\\ai-game-companion\\.live-runs\\other.stage\\root\\GameBuddy\\data\\primary\\player-host\\Mods"`,
  );
  const client = row(43100, 43032, "Stardew Valley.exe", "");

  const reading = poll([capturePhaseRow(), captureDriverRow(12408), sibling, loader, client]);
  assert.equal(reading.state, "busy");
  assert.deepEqual(reading.foreignGames, [43032, 43100]);
  assert.deepEqual(reading.foreignDrivers, [23736]);
  assert.match(
    reading.lines.at(-1),
    /state=busy - 2 this run's own, 2 game\(s\) not this run's, 1 run\(s\) not this run's, 0 neither$/u,
  );
  assert.match(
    reading.lines[3],
    /^machine_poll: 43032 StardewModdingAPI\.exe is a game that is not this run's \(started 2026-11-26T03:29:09\.1234567\+08:00\)$/u,
  );
});

test("a node that is neither a game nor a live run is counted and not blamed on anybody", () => {
  // This machine's controllers: a language server and an agent runner are `node.exe` too, and a poller that
  // calls every one of them a competing run reports a busy machine forever.
  const editor = row(
    24016,
    1,
    "node.exe",
    `"C:\\Program Files\\nodejs\\node.exe" "C:\\Tools\\tsserver\\index.js" --stdio`,
  );
  const runner = row(
    34076,
    1,
    "node.exe",
    `"C:\\Program Files\\nodejs\\node.exe" --experimental-vm-modules runner.mjs`,
  );
  const reading = poll([capturePhaseRow(), captureDriverRow(12408), editor, runner]);
  assert.equal(reading.state, "quiet");
  assert.deepEqual(reading.foreignDrivers, []);
  assert.equal(reading.other, 2);
  assert.equal(reading.lines.length, 3, "two own lines and the tally: a process of neither kind is not named");
  assert.match(
    reading.lines.at(-1),
    /2 this run's own, 0 game\(s\) not this run's, 0 run\(s\) not this run's, 2 neither$/u,
  );
});

test("a machine nobody could ask is not a quiet one, and a stage root nobody named is a refusal", () => {
  const noTable = machinePollReading({ stageRoot: POLL_STAGE, readRows: () => null });
  assert.equal(noTable.state, "unreadable");
  assert.equal(noTable.examined, null);
  assert.match(noTable.lines[0], /^machine_poll_unreadable: the process table did not answer/u);

  const noStage = machinePollReading({ stageRoot: null, readRows: table([]) });
  assert.equal(noStage.state, "unreadable");
  assert.match(noStage.lines[0], /^machine_poll_unreadable: no stage root was given/u);
});
