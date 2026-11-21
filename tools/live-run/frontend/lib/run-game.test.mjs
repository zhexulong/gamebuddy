// The game a run started is named by IDENTITY, and the two facts that make the name run-specific are the
// ones this test pins: the Mod loader carries this run's own mods root in its command line, and the game
// under it carries nothing at all - it is found by the parent relation, not by a path it does not have.
//
// Measured 2026-11-16 (the defect this file exists for): `w-game-launch` launched `StardewModdingAPI.exe`
// pid 38372 with a real game under it, the run ended, the game was still on screen, and the run's own
// reading said `LEFTOVERS: none (examined 385 processes)` - the sweep asks for a command line containing
// the stage root, and the game client's command line is only its own image path.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runPaths } from "./config.mjs";
import {
  describeGameCleanup,
  GAME_CLIENT_ROLE,
  GAME_LOADER_ROLE,
  identifyRunGame,
  recordedGameProcesses,
  recordRunGame,
  survivingGameIdentities,
} from "./run-game.mjs";
import { registerRunProcess } from "./run-owner.mjs";

const STAGE = "E:\\projects\\ai-game-companion\\.live-runs\\gc1.stage";
const GAME_DIR = "D:\\Steam\\steamapps\\common\\Stardew Valley";
const START = "2026-11-16T09:14:58.5472220+08:00";

const row = (pid, parentPid, name, commandLine, startTime = START) => ({
  pid,
  parentPid,
  name,
  startTime,
  commandLine,
});

/** The mods root the Host hands SMAPI: `<stage>\root\GameBuddy\data\stardew-private-bootstrap\<uuid>\player-host\Mods`. */
const runModsRoot = (stage) =>
  `${stage}\\root\\GameBuddy\\data\\stardew-private-bootstrap\\56d27312-f52b-401f-bd6a-eb10a60e85ad\\player-host\\Mods`;

const smapi = (stage, pid = 38372, parentPid = 30468) =>
  row(
    pid,
    parentPid,
    "StardewModdingAPI.exe",
    `"${GAME_DIR}\\StardewModdingAPI.exe" --mods-path "${runModsRoot(stage)}"`,
  );

const client = (pid = 40100, parentPid = 38372) =>
  row(pid, parentPid, "Stardew Valley.exe", `"${GAME_DIR}\\Stardew Valley.exe"`);

/** The player's own game: SMAPI with no `--mods-path` of this run's, and a game under it. */
const playerGame = () => [
  row(900, 5, "StardewModdingAPI.exe", `"${GAME_DIR}\\StardewModdingAPI.exe"`),
  row(901, 900, "Stardew Valley.exe", `"${GAME_DIR}\\Stardew Valley.exe"`),
];

const tableOf = (rows) => () => ({ examined: rows.length + 600, rows });

test("the game this run started is the loader carrying this run's mods root, and the client under it", () => {
  const reading = identifyRunGame({
    stageRoot: STAGE,
    readGame: tableOf([
      row(100, 1, "node.exe", `node run.mjs --out ${STAGE}`),
      smapi(STAGE),
      client(),
      ...playerGame(),
    ]),
  });
  assert.equal(reading.examined, 605, "the reading prints the population it examined");
  assert.deepEqual(
    reading.rows.map((entry) => [entry.pid, entry.role]),
    [
      [38372, GAME_LOADER_ROLE],
      [40100, GAME_CLIENT_ROLE],
    ],
    "the run's own loader and its client, and neither half of the player's game",
  );
  assert.equal(
    reading.rows[0].startTime,
    START,
    "the identity carries the OS creation time, so a recycled pid is not it",
  );
});

test("a player's own game is not this run's, however many Stardew processes are on the machine", () => {
  const reading = identifyRunGame({ stageRoot: STAGE, readGame: tableOf(playerGame()) });
  assert.deepEqual(
    reading.rows,
    [],
    "no mods root of this run's, no parent chain from a recorded loader: nobody's game but theirs",
  );
});

test("a stage recorded relative still matches the absolute path in a command line", () => {
  const stage = resolve("run.stage");
  const reading = identifyRunGame({ stageRoot: "run.stage", readGame: tableOf([smapi(stage), client()]) });
  assert.deepEqual(
    reading.rows.map((entry) => entry.role),
    [GAME_LOADER_ROLE, GAME_CLIENT_ROLE],
    "the run records the stage as the operator spelled it; the OS reports the absolute one",
  );
});

test("a loader that already exited is still the anchor for the client it left behind", () => {
  // The client keeps the parent pid it was born with, so the recorded loader pid still names the run's game
  // after SMAPI itself is gone - which is exactly the state a live run left the machine in.
  const reading = identifyRunGame({
    stageRoot: STAGE,
    recorded: [{ pid: 38372, role: GAME_LOADER_ROLE, startTime: START }],
    readGame: tableOf([client(40100, 38372), ...playerGame()]),
  });
  assert.deepEqual(
    reading.rows.map((entry) => [entry.pid, entry.role]),
    [[40100, GAME_CLIENT_ROLE]],
    "the orphaned client is this run's, and the player's game is not",
  );
});

test("a machine that cannot be asked is not a machine with no game", () => {
  assert.equal(identifyRunGame({ stageRoot: STAGE, readGame: () => null }), null);
  assert.equal(
    identifyRunGame({ stageRoot: "", readGame: tableOf([smapi(STAGE)]) }),
    null,
    "no stage, nothing to match",
  );
});

test("recording writes pid, role and start time into the run's own registry, once per pid", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-game-"));
  try {
    const paths = runPaths({ outRoot: join(root, "run"), stageRoot: join(root, "run.stage") });
    mkdirSync(paths.stateDir, { recursive: true });
    const readGame = tableOf([smapi(paths.stageRoot), client()]);
    const first = recordRunGame({ paths, stageRoot: paths.stageRoot, readGame });
    assert.deepEqual(
      first.added.map((entry) => entry.role),
      [GAME_LOADER_ROLE, GAME_CLIENT_ROLE],
      "both halves are recorded the first time they are seen",
    );
    assert.deepEqual(
      recordedGameProcesses(paths).map((entry) => [entry.pid, entry.role, entry.startTime]),
      [
        [38372, GAME_LOADER_ROLE, START],
        [40100, GAME_CLIENT_ROLE, START],
      ],
      "the run's registry is where the identity outlives the process that first saw it",
    );
    const second = recordRunGame({ paths, stageRoot: paths.stageRoot, readGame });
    assert.deepEqual(second.added, [], "a second boundary does not register the same pids twice");
    assert.equal(readFileSync(paths.runProcessesFile, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the assertion answers gone, alive, recycled and unverifiable as four different facts", () => {
  const identity = { pid: 40100, role: GAME_CLIENT_ROLE, startTime: START };
  assert.equal(survivingGameIdentities([]).kind, "nothing_recorded");
  assert.equal(survivingGameIdentities([identity], { readTable: tableOf([]) }).kind, "gone");
  const alive = survivingGameIdentities([identity], { readTable: tableOf([client()]) });
  assert.equal(alive.kind, "alive");
  assert.deepEqual(alive.surviving, [identity], "an alive identity is reported by name, not by count");
  assert.equal(
    survivingGameIdentities([identity], {
      readTable: tableOf([row(40100, 1, "notepad.exe", "notepad.exe", "2026-11-16T10:00:00.0000000+08:00")]),
    }).kind,
    "gone",
    "a pid the machine recycled is a different process, so the identity this run recorded is gone",
  );
  assert.equal(survivingGameIdentities([identity], { readTable: () => null }).kind, "unverifiable");
});

test("the cleanup line says which of the three things happened", () => {
  const identity = { pid: 40100, role: GAME_CLIENT_ROLE, startTime: START };
  assert.deepEqual(
    describeGameCleanup({
      recorded: [identity, { pid: 38372, role: GAME_LOADER_ROLE }],
      surviving: { kind: "gone", surviving: [] },
    }),
    ["RUN-GAME-CLEANUP: game_terminated_by_run: 40100(game-client) 38372(game-smapi)"],
  );
  assert.deepEqual(describeGameCleanup({ recorded: [identity], surviving: { kind: "alive", surviving: [identity] } }), [
    "RUN-GAME-CLEANUP: game_still_alive: 40100(game-client) (could not terminate) - this run started a game and did not take it back",
  ]);
  assert.deepEqual(describeGameCleanup({ recorded: [], surviving: { kind: "gone", surviving: [] }, examined: 386 }), [
    "RUN-GAME-CLEANUP: no game this run started (examined 386 processes by image name)",
  ]);
  assert.match(
    describeGameCleanup({ recorded: [identity], surviving: { kind: "unverifiable", surviving: [] } })[0],
    /^RUN-GAME-CLEANUP: unverifiable - /u,
  );
});

test("a registered pid with no role of the game's is not part of the game population", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-run-game-roles-"));
  try {
    const paths = runPaths({ outRoot: join(root, "run"), stageRoot: join(root, "run.stage") });
    mkdirSync(paths.stateDir, { recursive: true });
    registerRunProcess(paths, { pid: 44444, role: "launch-driver" });
    registerRunProcess(paths, { pid: 44445, role: "capture:w-game-launch" });
    assert.deepEqual(recordedGameProcesses(paths), [], "the launch and capture drivers are not a game");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * The capture phase records the game on BOTH sides of a driver.
 *
 * A game is caused INSIDE a driver (driver w asks the Host to launch one), so a phase that only records
 * before the driver records nothing in a run whose single driver is the one that opened the game - and then
 * the run's own cleanup says "no game this run started" about a run that just opened one. Measured twice on
 * 2026-11-21 (`frontend--r26pads`, `cabinseat-r26`), both on the failing path, which is the path where the
 * sentence matters most.
 *
 * The population is the capture phase's own source, so this holds for any driver added later.
 */
test("the capture phase records the game after a driver as well as before it", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "phases", "capture.mjs"), "utf8");
  const before = source.indexOf("const game = recordRunGame(");
  const driver = source.indexOf("code = await runDriver(driver");
  const after = source.indexOf("const after = recordRunGame(");
  assert.ok(before >= 0, "the capture phase still records the game at a driver boundary");
  assert.ok(driver >= 0, "the capture phase still runs the driver through runDriver");
  assert.ok(
    after > driver,
    "capture.mjs records the game only before the driver: a run whose only driver launched a game cannot say it started one",
  );
  assert.match(
    source.slice(driver, after + "const after = recordRunGame(".length),
    /finally[\s\S]*recordRunGame/u,
    "the after-driver record must sit in a finally, so a driver that throws is still recorded",
  );
});
