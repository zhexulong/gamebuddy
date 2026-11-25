/*
 * Which lines of the machine's one SMAPI log belong to this run.
 *
 * What these assertions protect: `SMAPI-latest.txt` holds every game's lines on this machine, and on
 * 2026-11-26 the launch-chain driver read the LAST `Context: loaded save '…'` in it and reported another
 * lane's world (`GameBuddyFixturePaired_453048112`) as this run's, while this run's own world was
 * `GameBuddyFarm_455241764` (`.tmp/lane-round33c.md` §6). A reader that cannot say which lines are its own
 * turns somebody else's game into this run's evidence.
 *
 * The three counts are asserted through ONE line, `smapi_lines: this_run=<n> other_run=<n> unattributable=<n>`,
 * because that is the line a reader compares across runs; the per-file decision behind it is asserted
 * separately, so "0 other_run" on a file whose header was overwritten is never read as a clean file.
 *
 * red-proof: inject  `attributeLogFile` treating a foreign `Context: loaded save '<name>'` as ordinary
 *                   (no `foreignSaves`, no contest): `✖ another game's save line makes the file contested and
 *                   is counted as another run's` fails on `lines.otherRun`, exit 1 (measured 2026-11-26).
 * red-proof: inject  the one-session decision kept when a foreign save line is present: the same assertion
 *                   fails on `decision` (`one_session_of_this_run` instead of `contested`), exit 1.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

// The kit is CommonJS beside the drivers it shares; `require` from an ESM test file is how every
// `capture/*.test.mjs` reaches its subject when the subject is a `.cjs` module.
const require = createRequire(import.meta.url);
const {
  attributeSmapiLog,
  createSmapiLogReading,
  describeSmapiAttribution,
  lastOwnLine,
  smapiLogFiles,
} = require("./smapi-log-attribution.cjs");

/** This run's own stage root, and the data root the Host passes to SMAPI as `--mods-path`. */
const STAGE = "D:\\gb-runs\\round33c-out2.stage";
const DATA_ROOT = `${STAGE}\\root\\GameBuddy\\data`;
const OWN_MODS = `${DATA_ROOT}\\stardew-private-bootstrap\\131eb164-0000\\player-host\\Mods`;
const OWN_WORLD = "GameBuddyFarm_455241764";

/** Another lane's mods path, as that lane's `--mods-path` wrote it into the same file. */
const OTHER_MODS = "E:\\projects\\ai-game-companion\\.tmp\\multiplayer-loop-0c58ace1\\probe\\host";
const OTHER_WORLD = "GameBuddyFixturePaired_453048112";

/** A file as `readLogFile` shapes it; the fs path is exercised separately below. */
const file = (lines, name = "SMAPI-latest.txt", extra = {}) => ({
  name,
  file: `C:\\logs\\${name}`,
  bytes: 1024,
  writtenAtMs: 1_800_000_000_000,
  truncated: false,
  lines,
  ...extra,
});

/** SMAPI's own header, as the machine writes it for a game started with `--mods-path`. */
const header = (modsPath, at = "2026-11-25T19:29:42 UTC") => [
  "[03:29:42 INFO  SMAPI] SMAPI 4.5.2 with Stardew Valley 1.6.15 build 24356 on Windows 11 (10.0.26300.0)",
  `[03:29:42 INFO  SMAPI] Mods go here: ${modsPath}`,
  "[03:29:42 TRACE SMAPI] (Using custom --mods-path argument. Game folder: D:\\Steam\\steamapps\\common\\Stardew Valley.)",
  `[03:29:42 TRACE SMAPI] Log started at ${at}`,
];

const own = { ownMarkers: [STAGE, DATA_ROOT], ownWorldNames: [OWN_WORLD] };

test("one session, this run's, and nothing contradicting it: every line is this run's", () => {
  const reading = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "read",
      logDir: "C:\\logs",
      reason: null,
      files: [
        file([
          ...header(OWN_MODS),
          `[03:29:51 TRACE game] Context: loaded save '${OWN_WORLD}', starting season 0 of year 1`,
          "[03:29:52 TRACE GameBuddy] gave the companion world a native Cabin on the free pad; cabins_now=1",
        ]),
      ],
    },
  });
  assert.equal(reading.files[0].decision, "one_session_of_this_run");
  assert.deepEqual(reading.lines, { thisRun: 6, otherRun: 0, unattributable: 0 });
  assert.equal(describeSmapiAttribution(reading)[0], "smapi_lines: this_run=6 other_run=0 unattributable=0");
  // The last own line is the one a progress line quotes; its source travels with it.
  assert.deepEqual(lastOwnLine(reading), {
    line: "[03:29:52 TRACE GameBuddy] gave the companion world a native Cabin on the free pad; cabins_now=1",
    writtenAtMs: 1_800_000_000_000,
    source: "SMAPI-latest.txt",
  });
});

test("another game's save line makes the file contested and is counted as another run's", () => {
  /*
   * THE MEASURED FILE. Our header is at offset 0 (our game truncated the file when it started), and the
   * earlier lane's game kept appending at its own offset - so the surviving save line is THAT lane's world.
   * One session header does not make the file ours, and the reader must not use what it cannot bind.
   */
  const reading = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "read",
      logDir: "C:\\logs",
      reason: null,
      files: [
        file([
          ...header(OWN_MODS),
          "[03:29:47 TRACE SMAPI]    GameBuddy (from Mods\\GameBuddy\\GameBuddy.Stardew.dll, ID: zhexulong.GameBuddy)...",
          `[03:29:49 TRACE game] Context: loaded save '${OTHER_WORLD}', starting season 0 of year 1`,
          "[03:29:52 INFO  GameBuddy] salient event TimeMilestone skipped: bridge session unavailable.",
          "[03:29:53 WARN  SMAPI] another game's line with no path at all",
        ]),
      ],
    },
  });
  const [only] = reading.files;
  assert.equal(only.decision, "contested");
  assert.deepEqual(only.foreignSaves, [OTHER_WORLD]);
  // Our header's `Mods go here:` line is ours; the other game's save line is not.
  assert.equal(only.lines.thisRun, 1);
  assert.equal(only.lines.otherRun, 1);
  // Everything else - the version line, the `--mods-path` note, `Log started at`, the Mod's own lines, the
  // `bridge session unavailable` line - carries no marker: nobody can say which game wrote it, so it is used
  // for nothing.
  assert.equal(only.lines.unattributable, 6);
  assert.deepEqual(reading.lines, { thisRun: 1, otherRun: 1, unattributable: 6 });
  assert.match(
    describeSmapiAttribution(reading)[1],
    /-> contested: 1 line\(s\) name this run; save\(s\) 'GameBuddyFixturePaired_453048112'; 6 line\(s\) cannot be attributed to either and are not used$/u,
  );
  // The only line this reader will quote is the header it can prove.
  assert.equal(lastOwnLine(reading).line, `[03:29:42 INFO  SMAPI] Mods go here: ${OWN_MODS}`);
});

test("a file whose only session is another run's attributes nothing to this run", () => {
  const reading = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "read",
      logDir: "C:\\logs",
      reason: null,
      files: [
        file([
          ...header(OTHER_MODS, "2026-11-25T19:29:09 UTC"),
          `[03:29:15 TRACE game] Context: loaded save '${OTHER_WORLD}', starting season 0 of year 1`,
        ]),
      ],
    },
  });
  assert.equal(reading.files[0].decision, "foreign_session");
  assert.equal(reading.lines.thisRun, 0);
  assert.equal(lastOwnLine(reading), null);
  // Two lines name the other game by name (its `Mods go here:` and its save); the rest of its header binds to
  // nothing, and neither game's lines are guessed.
  assert.match(describeSmapiAttribution(reading)[0], /^smapi_lines: this_run=0 other_run=2 unattributable=3$/u);
});

test("an empty file and an absent log directory are different answers, and neither is a zero game", () => {
  const empty = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "read",
      logDir: "C:\\logs",
      reason: null,
      files: [file([], "SMAPI-latest.player-2.txt", { bytes: 0 })],
    },
  });
  assert.equal(empty.files[0].decision, "absent");
  assert.match(
    describeSmapiAttribution(empty)[1],
    /^smapi_attribution: SMAPI-latest\.player-2\.txt \(0 bytes, 0 line\(s\)\): empty - nothing to attribute$/u,
  );

  const absent = attributeSmapiLog({
    ...own,
    logFiles: {
      state: "absent",
      logDir: null,
      files: [],
      reason: "no APPDATA, so this machine's SMAPI log directory is unknown",
    },
  });
  assert.equal(absent.state, "absent");
  assert.equal(
    describeSmapiAttribution(absent)[0],
    "smapi_lines: this_run=0 other_run=0 unattributable=0 (no APPDATA, so this machine's SMAPI log directory is unknown)",
  );
});

test("the files are found by SMAPI's own naming, and a rotated crash log is not one of them", () => {
  const logDir = mkdtempSync(join(tmpdir(), "gb-smapi-attribution-"));
  writeFileSync(
    join(logDir, "SMAPI-latest.txt"),
    [...header(OWN_MODS), `[03:29:51 TRACE game] Context: loaded save '${OWN_WORLD}'`].join("\r\n"),
    "utf8",
  );
  writeFileSync(join(logDir, "SMAPI-latest.player-2.txt"), "", "utf8");
  writeFileSync(join(logDir, "SMAPI-crash.txt"), "[00:00:00 FATAL SMAPI] not a session\n", "utf8");
  writeFileSync(join(logDir, "gamebuddy-trace-20261126-032942.json"), "{}", "utf8");

  const listed = smapiLogFiles({ logDir });
  assert.equal(listed.state, "read");
  assert.deepEqual(
    listed.files.map((entry) => entry.name),
    ["SMAPI-latest.player-2.txt", "SMAPI-latest.txt"],
  );

  const reading = attributeSmapiLog({ ...own, logDir });
  assert.deepEqual(
    reading.files.map((entry) => entry.decision),
    ["absent", "one_session_of_this_run"],
  );
  assert.equal(describeSmapiAttribution(reading)[0], "smapi_lines: this_run=5 other_run=0 unattributable=0");
  assert.equal(reading.source, "SMAPI-latest.player-2.txt + SMAPI-latest.txt");
});

/*
 * ---- the save join: the SLOT a save line carries, never the farm name the run staged ----
 *
 * The ROUNDW run's own file (`D:\gb-runs\roundw-out\w-game-launch.txt`, quoted in `.tmp/lane-roundw.md` §5.4):
 * this run's `Mods go here:` - its stage root, which no other run can produce - ONE session start, and one save
 * line, `GameBuddyFarm_455317305`, the world this run's own game created (the save folder's own `SaveGameInfo`
 * names farm name `GameBuddy Farm`). The driver pushed THAT FARM NAME into `ownWorldNames`, and the two strings
 * can never be equal, so the reader called this run's own save line another run's and flipped the file to
 * `contested` - which is what made the chain's rung 4 `save loaded - not reached` on a run that loaded it.
 */
const ROUNDW_STAGE = "D:\\gb-runs\\roundw-out.stage";
const ROUNDW_MODS = `${ROUNDW_STAGE}\\root\\GameBuddy\\data\\stardew-private-bootstrap\\90d0728b-b979-423f-9c5c-21da22f156e5\\player-host\\Mods`;
const ROUNDW_SLOT = "GameBuddyFarm_455317305";
const ROUNDW_FARM_NAME = "GameBuddy Farm";

/** The file as that run's game wrote it, down to the four header lines and the one save line. */
const roundwFile = () =>
  file([
    "[05:01:45 INFO  SMAPI] SMAPI 4.5.2 with Stardew Valley 1.6.15 build 24356 on Windows 11 (10.0.26300.0)",
    `[05:01:45 INFO  SMAPI] Mods go here: ${ROUNDW_MODS}`,
    "[05:01:45 TRACE SMAPI] (Using custom --mods-path argument. Game folder: D:\\Steam\\steamapps\\common\\Stardew Valley.)",
    "[05:01:45 TRACE SMAPI] Log started at 2026-11-25T21:01:45 UTC",
    `[05:01:53 TRACE game] Context: loaded save '${ROUNDW_SLOT}', starting spring 1 Y1, locale set to zh-CN.`,
  ]);

const roundwLog = () => ({ state: "read", logDir: "C:\\logs", reason: null, files: [roundwFile()] });

test("a farm name is never a save slot: claiming it flips this run's own save line to contested", () => {
  // THE DEFECT, exactly as the run recorded it: `this_run=1 other_run=1 unattributable=95`.
  const reading = attributeSmapiLog({
    ownMarkers: [ROUNDW_STAGE],
    ownWorldNames: [ROUNDW_FARM_NAME],
    logFiles: roundwLog(),
  });
  const [only] = reading.files;
  assert.equal(only.decision, "contested");
  assert.deepEqual(only.foreignSaves, [ROUNDW_SLOT], "this run's own world, read as somebody else's");
  assert.deepEqual(reading.lines, { thisRun: 1, otherRun: 1, unattributable: 3 });
  // And the rung the chain needed is then unreachable, with the reader naming the run's own save as foreign.
  const claimed = createSmapiLogReading({
    ownMarkers: [ROUNDW_STAGE],
    ownWorldNames: [ROUNDW_FARM_NAME],
    logFiles: roundwLog(),
  }).claim(0);
  assert.deepEqual(claimed.facts, {}, "no rung the game's log could prove");
  assert.match(claimed.reason, /names another game's save \("GameBuddyFarm_455317305"\)/u);
});

test("the same file, joined on the slot the save line carries, is one session of this run and claims rung 4", () => {
  const reading = attributeSmapiLog({
    ownMarkers: [ROUNDW_STAGE],
    ownWorldNames: [ROUNDW_SLOT],
    logFiles: roundwLog(),
  });
  const [only] = reading.files;
  assert.equal(only.decision, "one_session_of_this_run");
  assert.deepEqual(only.foreignSaves, []);
  assert.deepEqual(reading.lines, { thisRun: 5, otherRun: 0, unattributable: 0 });
  const claimed = createSmapiLogReading({
    ownMarkers: [ROUNDW_STAGE],
    ownWorldNames: [ROUNDW_SLOT],
    logFiles: roundwLog(),
  }).claim(0);
  assert.equal(claimed.facts["save loaded"].captured, ROUNDW_SLOT);
  assert.equal(claimed.reason, null);
  // The decision is printed with its field name and its own count, so "rung 4 unclaimable" is a reading.
  const lines = describeSmapiAttribution(reading);
  assert.match(
    lines.at(-1),
    /^rung4_join: field=save slot this_run=1 own_slots=\[GameBuddyFarm_455317305\] - `Context: loaded save '<slot>'` carries the save folder, and the farm name this run staged is display text that is never compared with it$/u,
  );
  // A run that has claimed no slot yet says so rather than silently joining on nothing.
  assert.match(
    describeSmapiAttribution(attributeSmapiLog({ ownMarkers: [ROUNDW_STAGE], logFiles: roundwLog() })).at(-1),
    /this_run=0 own_slots=\[\]/u,
  );
});

/*
 * ---- the copies: a reading KEEPS what it could attribute ----
 *
 * The machine's one log is truncated by every game that starts here, so a run that only reads it loses the Player
 * Host's last words the moment a sibling appears (`.tmp/lane-whycrah.md` §1: the game ended at 21:02:02, a sibling
 * truncated the file at 05:02:11, and only the one line the driver had printed survived). The wiring under test is the
 * one the launch chain's own sampler uses: `refresh()` on every plateau poll, `describe()` at the drain - and no
 * driver call site has to name the directory the copies go to.
 */
const OWN_SAVE_LINE = "[05:01:53 TRACE game] SaveGame.Save() completed without exceptions.";

test("the reading keeps a copy of each state it read, and its drain names the tick that held the last save line", () => {
  const logDir = mkdtempSync(join(tmpdir(), "gb-smapi-keep-"));
  const stateDir = mkdtempSync(join(tmpdir(), "gb-smapi-keep-state-"));
  const logPath = join(logDir, "SMAPI-latest.txt");
  writeFileSync(
    logPath,
    [...header(ROUNDW_MODS), `[05:01:53 TRACE game] Context: loaded save '${ROUNDW_SLOT}'`, OWN_SAVE_LINE].join("\r\n"),
    "utf8",
  );
  const reading = createSmapiLogReading({
    ownMarkers: [ROUNDW_STAGE],
    ownWorldNames: [ROUNDW_SLOT],
    logDir,
    stateDirectory: stateDir,
  });
  reading.refresh();
  assert.deepEqual(
    readdirSync(join(stateDir, "smapi")).sort(),
    ["0001.txt"],
    "the poll's copy is one tick file, named by the tick that made it",
  );
  assert.match(readFileSync(join(stateDir, "smapi", "0001.txt"), "utf8"), /SaveGame\.Save\(\) completed/u);

  // A sibling game starts and truncates the file: nothing in it names this run any more.
  writeFileSync(
    logPath,
    [...header(OTHER_MODS), `[05:02:11 TRACE game] Context: loaded save '${OTHER_WORLD}'`].join("\r\n"),
    "utf8",
  );
  const drained = reading.describe();
  assert.equal(
    drained.filter((line) => line.startsWith("smapi_lines:"))[0],
    "smapi_lines: this_run=0 other_run=2 unattributable=3",
    "the drain reads once more, so it reports the file as the machine has it now",
  );
  assert.equal(
    drained.at(-1),
    `smapi_tick_capture_last_save_or_exit: tick 1 at ${join(stateDir, "smapi", "0001.txt")}: ${JSON.stringify(OWN_SAVE_LINE)}`,
    "and the words the run chased are still quotable, out of the tick it kept",
  );
});

test("a reading nobody handed a state directory says it kept nothing instead of implying an empty log", () => {
  assert.match(
    createSmapiLogReading({ ...own, logFiles: roundwLog() })
      .describe()
      .at(-1),
    /^smapi_tick_capture: no copy of the game's own log was kept \(/u,
  );
});
