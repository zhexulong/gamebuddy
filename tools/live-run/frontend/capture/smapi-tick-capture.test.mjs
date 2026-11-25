/*
 * The run keeps its own copy of the game's own last words, one per plateau poll.
 *
 * What these assertions protect: `SMAPI-latest.txt` is truncated by every game that starts on this machine, so a
 * run that only READS it loses the Player Host's last words the moment a sibling game appears. Measured
 * 2026-11-26 (`.tmp/lane-whycrah.md` §1): the game ended at 21:02:02, a sibling truncated the file at 05:02:11,
 * and the only surviving copy of what the game said was the single line the driver had printed - every later
 * reader had to re-derive the exit from frame counters and a trace that lied (§4).
 *
 * The overwrite below IS that incident, replayed: this run's file, then a foreign header written over it. The tick
 * this run already kept still holds the line, and the shared file no longer does.
 *
 * red-proof: drop the `writeFileSync` in `capture()` - `a sibling game truncating SMAPI-latest.txt cannot reach a
 *            tick this run already kept` fails with `ENOENT: … 0001.txt`, the shape of the defect itself: no copy was
 *            ever taken (measured, `tests 6 / pass 5 / fail 1`).
 * red-proof: let `evict()` ignore `pinned` - `the tick window is bounded and the newest save/exit tick survives it`
 *            fails on `['0005.txt','0006.txt','0007.txt']` instead of `['0001.txt','0006.txt','0007.txt']`: a run
 *            whose evidence was trimmed away before the drain could quote it (measured, `tests 6 / pass 5 / fail 1`).
 * red-proof: drop the `tickCapture.capture(reading)` in `smapi-log-attribution.cjs` - `the reading keeps a copy of
 *            each state it read` fails with `ENOENT: … scandir …\smapi` (measured, `tests 9 / pass 8 / fail 1`).
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSmapiLogReading } = require("./smapi-log-attribution.cjs");
const { createSmapiTickCapture, saveOrExitLine, KEPT_TICKS, SAVE_OR_EXIT_NAMES } = require("./smapi-tick-capture.cjs");

/** This run's own stage root, and the mods path the Host started SMAPI with. */
const STAGE = "D:\\gb-runs\\harnessinstr-out.stage";
const OWN_MODS = `${STAGE}\\root\\GameBuddy\\data\\stardew-private-bootstrap\\77aa1f00-0000\\player-host\\Mods`;
const OWN_WORLD = "GameBuddyFarm_455317305";

/** Another lane's mods path, and the world its save line names. */
const OTHER_MODS = "E:\\projects\\ai-game-companion\\.tmp\\multiplayer-loop-0c58ace1\\probe\\host";
const OTHER_WORLD = "GameBuddyFixturePaired_453048112";

/** SMAPI's header for a session started with `--mods-path`, plus the lines a run's own game writes. */
const header = (modsPath) => [
  "[05:01:45 INFO  SMAPI] SMAPI 4.5.2 with Stardew Valley 1.6.15 build 24356 on Windows 11 (10.0.26300.0)",
  `[05:01:45 INFO  SMAPI] Mods go here: ${modsPath}`,
  "[05:01:45 TRACE SMAPI] (Using custom --mods-path argument. Game folder: D:\\Steam\\steamapps\\common\\Stardew Valley.)",
  "[05:01:45 TRACE SMAPI] Log started at 2026-11-26T21:01:45 UTC",
];
const OWN_SAVE = `[05:01:53 TRACE game] Context: loaded save '${OWN_WORLD}', starting spring 1 Y1, locale set to zh-CN.`;
const OWN_SAVE_LINE = "[05:01:53 TRACE game] SaveGame.Save() completed without exceptions.";

/** A machine's one SMAPI log directory, and this run's state directory beside it. */
function machine() {
  const logDir = mkdtempSync(join(tmpdir(), "gb-smapi-ticks-"));
  const stateDir = mkdtempSync(join(tmpdir(), "gb-smapi-state-"));
  writeFileSync(join(logDir, "SMAPI-latest.txt"), [...header(OWN_MODS), OWN_SAVE, OWN_SAVE_LINE].join("\r\n"), "utf8");
  return { logDir, captureDir: join(stateDir, "smapi"), log: join(logDir, "SMAPI-latest.txt") };
}

/** The reading this run makes of the machine's log right now, over the population it may read. */
const pollOf = (logDir) =>
  createSmapiLogReading({
    ownMarkers: [STAGE],
    ownWorldNames: [OWN_WORLD],
    logDir,
  }).refresh();

const tickNames = (directory) => readdirSync(directory).sort();

test("a sibling game truncating SMAPI-latest.txt cannot reach a tick this run already kept", () => {
  const { logDir, captureDir, log } = machine();
  const capture = createSmapiTickCapture({ directory: captureDir });

  const first = capture.capture(pollOf(logDir), 1_800_000_000_000);
  assert.equal(first.lines, 6, "the whole session is this run's, so every line of it is copied");
  assert.match(readFileSync(first.file, "utf8"), /SaveGame\.Save\(\) completed without exceptions\./u);
  assert.equal(first.lifecycle, OWN_SAVE_LINE, "the tick knows which of its lines says a save happened");

  // THE INCIDENT: a sibling game starts, truncates the machine's one log and writes its own header at offset 0.
  writeFileSync(
    join(logDir, "SMAPI-latest.txt"),
    [...header(OTHER_MODS), `[05:02:11 TRACE game] Context: loaded save '${OTHER_WORLD}'`].join("\r\n"),
    "utf8",
  );
  assert.equal(
    readFileSync(log, "utf8").includes("SaveGame.Save()"),
    false,
    "the shared file really lost the line: this is the overwrite, not a hypothetical one",
  );

  const second = capture.capture(pollOf(logDir), 1_800_000_005_000);
  assert.equal(second.lines, 0, "nothing in the file names this run any more, so the poll copies nothing");

  // What survived is this run's own copy, and the drain can point at the tick that holds it.
  assert.equal(readFileSync(first.file, "utf8").includes(OWN_SAVE_LINE), true, "the earlier tick still carries it");
  const drained = capture.drain(pollOf(logDir), 1_800_000_010_000);
  assert.match(
    drained[0],
    /^smapi_tick_capture: 2 distinct observation\(s\) of the game's own log kept the lines attributed to this run/u,
  );
  assert.match(drained[0], new RegExp(`in ${captureDir.replace(/\\/gu, "\\\\")}`, "u"));
  assert.equal(
    drained.at(-1),
    `smapi_tick_capture_last_save_or_exit: tick 1 at ${first.file}: ${JSON.stringify(OWN_SAVE_LINE)}`,
  );
});

test("a log that has not changed does not spend a tick of the window", () => {
  const { logDir, captureDir } = machine();
  const capture = createSmapiTickCapture({ directory: captureDir });
  // The sampler reads the same file two or three times per progress line, and once more per cabin step. Counting every
  // READ as a tick would fill the whole window with copies of one unchanged file.
  const first = capture.capture(pollOf(logDir), 1_800_000_000_000);
  const same = capture.capture(pollOf(logDir), 1_800_000_005_000);
  assert.deepEqual(same, first, "the unchanged read answers the tick that already holds those lines");
  assert.deepEqual(tickNames(captureDir), ["0001.txt"], "one file, because there was one state to keep");
  // The log grows: a new state, and a new tick.
  writeFileSync(
    join(logDir, "SMAPI-latest.txt"),
    [...header(OWN_MODS), OWN_SAVE, OWN_SAVE_LINE, "[05:02:00 TRACE GameBuddy] fixture step 0"].join("\r\n"),
    "utf8",
  );
  assert.equal(capture.capture(pollOf(logDir), 1_800_000_010_000).tick, 2, "a changed log is a new tick");
});

test("the tick window is bounded, and the newest save/exit tick survives it", () => {
  const { logDir, captureDir, log } = machine();
  const capture = createSmapiTickCapture({ directory: captureDir, keep: 3 });
  // A save at the first poll, then six polls of a growing log WITHOUT it: the save is what the collection exists for,
  // and it is the OLDEST tick by the time the window has moved past it.
  const saved = capture.capture(pollOf(logDir), 1_800_000_000_000);
  for (let poll = 0; poll < 6; poll += 1) {
    const steps = Array.from(
      { length: poll + 1 },
      (_, step) => `[05:01:5${String(step)} TRACE GameBuddy] fixture step ${String(step)}`,
    );
    writeFileSync(log, [...header(OWN_MODS), OWN_SAVE, ...steps].join("\r\n"), "utf8");
    capture.capture(pollOf(logDir), 1_800_000_001_000 + poll * 5_000);
  }

  assert.deepEqual(
    tickNames(captureDir),
    ["0001.txt", "0006.txt", "0007.txt"],
    "keep=3, and the pinned tick is one of them",
  );
  assert.equal(existsSync(saved.file), true, "eviction never removes the tick that carried the save");
  const drained = capture.drain(pollOf(logDir), 1_800_000_040_000);
  assert.match(
    drained[0],
    /^smapi_tick_capture: 7 distinct observation\(s\) of the game's own log kept the lines attributed to this run/u,
    "the drain's own copy is the seventh state, not an eighth tick",
  );
  assert.match(
    drained[0],
    /3 tick file\(s\) survive \(keep=3 ticks, plus the newest tick that carried a save or an exit, which eviction never removes; 4 evicted\)/u,
  );
  assert.deepEqual(
    tickNames(captureDir),
    ["0001.txt", "0006.txt", "0007.txt"],
    "an unchanged drain read evicts nothing",
  );
  assert.equal(
    drained.at(-1),
    `smapi_tick_capture_last_save_or_exit: tick 1 at ${saved.file}: ${JSON.stringify(OWN_SAVE_LINE)}`,
    "the drain names the surviving tick, not the one eviction removed",
  );
});

test("the default bound is named, and a run that never saw a save says which population it searched", () => {
  const { logDir, captureDir, log } = machine();
  const capture = createSmapiTickCapture({ directory: captureDir });
  writeFileSync(join(logDir, "SMAPI-latest.txt"), [...header(OWN_MODS), OWN_SAVE].join("\r\n"), "utf8");
  capture.capture(pollOf(logDir), 1_800_000_000_000);
  appendFileSync(log, "\r\n[05:01:54 TRACE GameBuddy] fixture step 0");
  const lines = capture.drain(pollOf(logDir), 1_800_000_005_000);
  assert.equal(KEPT_TICKS, 24, "the bound the run reports is the bound it uses");
  assert.match(
    lines[0],
    /keep=24 ticks, plus the newest tick that carried a save or an exit, which eviction never removes/u,
  );
  assert.equal(
    lines.at(-1),
    `smapi_tick_capture_last_save_or_exit: none - none of the 2 readable tick file(s) carries a line mentioning one of [${SAVE_OR_EXIT_NAMES.join(", ")}] (the game logged no save and no exit this run kept)`,
    "'none' names the set it searched, and the count it searched it over",
  );
});

test("a driver handed no state directory says so instead of pretending it kept nothing", () => {
  const capture = createSmapiTickCapture({ directory: null });
  assert.equal(
    capture.capture({ ownLines: [OWN_SAVE_LINE] }),
    null,
    "no directory, no copy - and no tick number invented",
  );
  const lines = capture.drain({ ownLines: [OWN_SAVE_LINE] });
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^smapi_tick_capture: no copy of the game's own log was kept \(this run was handed no launch state/u,
  );
  assert.match(lines[0], /a sibling game that overwrites SMAPI-latest\.txt would destroy this run's only evidence$/u);
});

test("the save/exit sentences are the ones this repository can name, and the last one wins", () => {
  assert.equal(saveOrExitLine([OWN_SAVE, "nothing to see"]), null, "a load is not a save: the line says 'loaded save'");
  assert.equal(saveOrExitLine([OWN_SAVE, OWN_SAVE_LINE]), OWN_SAVE_LINE);
  assert.equal(
    saveOrExitLine(["[05:02:01 INFO  GameBuddy] saving=true;day=1", OWN_SAVE_LINE]),
    OWN_SAVE_LINE,
    "the LAST matching line is the one quoted",
  );
  assert.equal(saveOrExitLine(["[05:02:02 INFO  SMAPI] Disposing..."]), "[05:02:02 INFO  SMAPI] Disposing...");
  assert.equal(saveOrExitLine(["[05:02:02 INFO  game] ReturnedToTitle"]), "[05:02:02 INFO  game] ReturnedToTitle");
});
